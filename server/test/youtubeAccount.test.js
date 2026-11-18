import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {encryptSecret,decryptSecret,loadKey,_setKeyForTests} from '../src/services/secretBox.js';
import {publicAccount,applyCredentialUpdate,readiness,credentialsOf,tokensOf,withTokens,disconnected,publicSeries,defaultRedirectUri} from '../src/services/youtube/youtubeAccount.js';
import {buildAuthUrl,exchangeCode,refreshTokens,needsRefresh,uploadVideoFile,getMyChannel} from '../src/services/youtube/youtubeApi.js';

_setKeyForTests(crypto.randomBytes(32));

test('secrets are encrypted at rest and fail closed with the wrong key', () => {
  const box = encryptSecret('GOCSPX-super-secret');
  assert.ok(!JSON.stringify(box).includes('super-secret'));
  assert.equal(decryptSecret(box), 'GOCSPX-super-secret');
  assert.deepEqual(decryptSecret(encryptSecret({refresh_token: 'r1'})), {refresh_token: 'r1'});
  assert.equal(decryptSecret(box, crypto.randomBytes(32)), null);
  assert.equal(decryptSecret(null), null);
  assert.equal(encryptSecret(''), null);
});

test('key file is generated once and reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-'));
  const keyFile = path.join(dir, '.keys', 'app-secret.key');
  const a = loadKey({envKey: '', keyFile});
  const b = loadKey({envKey: '', keyFile});
  assert.ok(a.equals(b));
  assert.equal(a.length, 32);
  assert.equal(loadKey({envKey: 'my passphrase', keyFile}).length, 32);
});

test('credential updates: secret kept when blank, connection dropped on client change', () => {
  let acc = applyCredentialUpdate({}, {clientId: ' id-1.apps.googleusercontent.com ', clientSecret: 'sec-1', publishEnabled: true});
  assert.equal(credentialsOf(acc).clientId, 'id-1.apps.googleusercontent.com');
  assert.equal(credentialsOf(acc).clientSecret, 'sec-1');
  assert.equal(credentialsOf(acc).redirectUri, defaultRedirectUri());
  acc = withTokens(acc, {access_token: 'a', refresh_token: 'r'}, {channelId: 'UC1', channelTitle: 'Kalyug'});
  assert.equal(readiness(acc).connected, true);
  assert.deepEqual(readiness(acc).problems, []);
  // Blank secret + same id keeps everything.
  acc = applyCredentialUpdate(acc, {clientId: 'id-1.apps.googleusercontent.com', clientSecret: '', publishEnabled: true});
  assert.equal(credentialsOf(acc).clientSecret, 'sec-1');
  assert.equal(tokensOf(acc).refresh_token, 'r');
  // New client id drops the connection.
  const changed = applyCredentialUpdate(acc, {clientId: 'id-2'});
  assert.equal(tokensOf(changed), null);
  assert.equal(changed.channelTitle, null);
  assert.throws(() => applyCredentialUpdate(acc, {redirectUri: 'javascript:alert(1)'}));
  assert.equal(tokensOf(disconnected(acc)), null);
});

test('public view never contains secrets or tokens', () => {
  const acc = withTokens(applyCredentialUpdate({}, {clientId: 'cid', clientSecret: 'TOPSECRET', publishEnabled: true}), {access_token: 'ACCESS', refresh_token: 'REFRESH'}, {channelId: 'UC1', channelTitle: 'Kalyug'});
  const view = publicAccount(acc);
  const text = JSON.stringify(publicSeries({name: 'K', youtubeAccount: acc}));
  for (const s of ['TOPSECRET', 'ACCESS', 'REFRESH', '"iv"', '"tag"']) assert.ok(!text.includes(s), s);
  assert.equal(view.hasClientSecret, true);
  assert.equal(view.connected, true);
  assert.equal(view.channelTitle, 'Kalyug');
  const off = readiness(applyCredentialUpdate({}, {clientId: 'cid'}));
  assert.equal(off.configured, false);
  assert.equal(off.problems.length, 2);
});

test('OAuth and upload requests are well formed', async () => {
  const url = new URL(buildAuthUrl({clientId: 'cid', redirectUri: 'http://127.0.0.1:4000/api/youtube/callback', state: 's1'}));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('state'), 's1');
  assert.match(url.searchParams.get('scope'), /youtube\.upload/);

  const calls = [];
  const fake = async (u, init = {}) => {
    calls.push({u: String(u), init});
    if (String(u).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({access_token: 'new', expires_in: 3600}), {status: 200});
    if (String(u).includes('uploadType=resumable')) return new Response('', {status: 200, headers: {location: 'https://upload.example/session1'}});
    if (String(u) === 'https://upload.example/session1') return new Response(JSON.stringify({id: 'vid123'}), {status: 200});
    if (String(u).includes('/channels')) return new Response(JSON.stringify({items: [{id: 'UC1', snippet: {title: 'Kalyug'}}]}), {status: 200});
    return new Response(JSON.stringify({error: {message: 'nope', errors: [{reason: 'x'}]}}), {status: 400});
  };
  const t = await exchangeCode({clientId: 'cid', clientSecret: 'sec', redirectUri: 'r', code: 'c'}, fake);
  assert.ok(t.expiry_date > Date.now());
  const r = await refreshTokens({clientId: 'cid', clientSecret: 'sec', tokens: {refresh_token: 'keep', access_token: 'old'}}, fake);
  assert.equal(r.access_token, 'new');
  assert.equal(r.refresh_token, 'keep');
  assert.equal(needsRefresh({access_token: 'a', expiry_date: Date.now() + 10_000}), true);
  assert.equal(needsRefresh({access_token: 'a', expiry_date: Date.now() + 3_600_000}), false);
  assert.deepEqual(await getMyChannel('tok', fake), {channelId: 'UC1', channelTitle: 'Kalyug', subscriberCount: null});

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vid-')), 'final.mp4');
  fs.writeFileSync(file, Buffer.alloc(1234));
  const up = await uploadVideoFile({accessToken: 'tok', filePath: file, snippet: {title: 'T'}, status: {privacyStatus: 'private'}, notifySubscribers: false}, fake);
  assert.equal(up.id, 'vid123');
  const init = calls.find(c => c.u.includes('uploadType=resumable'));
  assert.match(init.u, /notifySubscribers=false/);
  assert.equal(init.init.headers['X-Upload-Content-Length'], '1234');
  assert.equal(JSON.parse(init.init.body).status.privacyStatus, 'private');
  await assert.rejects(refreshTokens({clientId: 'c', clientSecret: 's', tokens: {}}, fake), /refresh token/);
  await assert.rejects(getMyChannel('tok', async () => new Response(JSON.stringify({error: {message: 'Forbidden'}}), {status: 403})), /403.*Forbidden/);
});
