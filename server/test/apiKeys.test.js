import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {env} from '../src/config/env.js';
import {encryptSecret, _setKeyForTests} from '../src/services/secretBox.js';
import {textKeyUpdate, applyTextKeysToEnv, cleanKey, originalEnv} from '../src/services/ai/textKeys.js';
import {keyList, pollinationsKeyUpdate, keyKind, KEY_IDS} from '../src/services/ai/keyCatalog.js';
import {checkCloudflare} from '../src/services/ai/keyChecks.js';

_setKeyForTests(crypto.randomBytes(32));
const field = set => Object.fromEntries(Object.entries(set).map(([k, v]) => [k.split('.').pop(), v]));
const byId = (list, id) => list.find(k => k.id === id);

test('every key the app uses is listed once, with what it is used for', () => {
  const list = keyList({});
  assert.deepEqual(list.map(k => k.id).sort(), [...KEY_IDS].sort());
  assert.deepEqual(byId(list, 'cloudflare').usedFor, ['Scripts', 'Images']);
  assert.ok(byId(list, 'cloudflare').fields.some(f => f.name === 'accountId'));
  assert.ok(byId(list, 'azure').fields.some(f => f.name === 'region'));
  assert.equal(keyKind('pollinations'), 'media');
  assert.equal(keyKind('azure'), 'tts');
  assert.equal(keyKind('nope'), null);
});

test('saved keys show source and last 4 characters only', () => {
  const secret = 'gsk_abcdefghijklmnop1234WXYZ';
  const s = {secrets: {textKeys: {groq: field(textKeyUpdate('groq', {key: secret}).set)}, elevenlabsKey: encryptSecret('el_0123456789abcdQRST')}};
  const list = keyList(s);
  const g = byId(list, 'groq');
  assert.equal(g.source, 'dashboard');
  assert.equal(g.hint, '…WXYZ');
  assert.ok(!JSON.stringify(list).includes(secret));
  assert.equal(byId(list, 'elevenlabs').hint, '…QRST');
});

test('a key saved with a different secret key is reported as unreadable', () => {
  const other = encryptSecret('sk-or-v1-zzzzzzzzzzzzzzzz', crypto.randomBytes(32));
  const k = byId(keyList({secrets: {textKeys: {openrouter: {key: other}}}}), 'openrouter');
  assert.equal(k.hasKey, false);
  assert.equal(k.unreadable, true);
});

test('pasted keys lose quotes, Bearer and spaces', () => {
  assert.equal(cleanKey('  "Bearer abcdefgh12345"  '), 'abcdefgh12345');
  assert.equal(cleanKey("'abcdefgh12345'"), 'abcdefgh12345');
  assert.throws(() => cleanKey('abc def ghi jkl'));
});

test('dashboard Cloudflare and Pollinations keys feed image generation, and removing them restores .env', () => {
  const acct = 'a'.repeat(32);
  const s = {secrets: {textKeys: {cloudflare: field(textKeyUpdate('cloudflare', {key: 'cf-token-1234567890', accountId: acct}).set)}, mediaKeys: {pollinations: field(pollinationsKeyUpdate({key: 'pk_live_1234567890'}).set).pollinations}}};
  applyTextKeysToEnv(s);
  assert.equal(env.cloudflareApiToken, 'cf-token-1234567890');
  assert.equal(env.cloudflareToken, 'cf-token-1234567890');
  assert.equal(env.cloudflareAccountId, acct);
  assert.equal(env.pollinationsKey, 'pk_live_1234567890');
  assert.equal(byId(keyList(s), 'pollinations').source, 'dashboard');
  applyTextKeysToEnv({});
  assert.equal(env.cloudflareApiToken, originalEnv('cloudflareApiToken'));
  assert.equal(env.pollinationsKey, originalEnv('pollinationsKey'));
  assert.deepEqual(pollinationsKeyUpdate({clear: true}).unset, {'secrets.mediaKeys.pollinations': 1});
});

const reply = (status, body) => ({ok: status < 300, status, json: async () => body});
test('Cloudflare check tells a bad token from a wrong account / missing permission', async () => {
  const acct = 'b'.repeat(32);
  await assert.rejects(checkCloudflare({token: 'x'.repeat(20), accountId: acct}, async () => reply(401, {success: false, errors: [{code: 10000, message: 'Authentication error'}]})), /rejected the API token/);
  await assert.rejects(checkCloudflare({token: 'x'.repeat(20), accountId: acct}, async url => url.includes('tokens/verify') ? reply(200, {success: true, result: {status: 'active'}}) : reply(401, {success: false})), /valid but cannot use Workers AI/);
  assert.equal((await checkCloudflare({token: 'x'.repeat(20), accountId: acct}, async () => reply(200, {success: true, result: []}))).ok, true);
  await assert.rejects(checkCloudflare({token: 't'.repeat(20), accountId: 'short'}), /32 letters/);
});
