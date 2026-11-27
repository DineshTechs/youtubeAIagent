import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {hashPassword, verifyPassword, authConfig, sessionKey, issueToken, verifyToken, readCookie, createLimiter, isOpenPath} from '../src/security/auth.js';
import {createSecurity, originAllowed, INTERNAL_TOKEN} from '../src/security/httpSecurity.js';

const appKey = crypto.randomBytes(32);
const quiet = {error() {}, warn() {}};
function call(handler, {method = 'GET', path = '/', headers = {}, body, ip = '1.2.3.4', secure = true} = {}) {
  return new Promise(resolve => {
    const res = {statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; },
      json(b) { resolve({status: this.statusCode, body: b, headers: this.headers}); }, sendStatus(c) { resolve({status: c, headers: this.headers}); }};
    handler({method, path, headers, body, ip, secure, socket: {}}, res, () => resolve({status: 'next', headers: res.headers}));
  });
}
const server = (env = {}) => createSecurity({appKey, envVars: {NODE_ENV: 'production', ADMIN_PASSWORD: 'a-long-test-password', ...env}, log: quiet});

test('passwords are hashed with scrypt and checked in constant time', () => {
  const h = hashPassword('a-long-test-password');
  assert.match(h, /^scrypt\$16384\$/);
  assert.equal(verifyPassword('a-long-test-password', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});

test('login is required on a server, optional on your own PC; short passwords are refused', () => {
  assert.equal(authConfig({}).required, false, 'own PC, no password: unchanged');
  assert.equal(authConfig({ADMIN_PASSWORD: 'a-long-test-password'}).required, true);
  const prodNoPw = authConfig({NODE_ENV: 'production'});
  assert.equal(prodNoPw.required, true);
  assert.equal(prodNoPw.configured, false);
  assert.equal(authConfig({NODE_ENV: 'production', AUTH_DISABLED: 'true'}).required, true, 'cannot switch off on a server');
  assert.ok(authConfig({ADMIN_PASSWORD: 'short'}).problems.length);
});

test('session tokens are signed, expire, and die when the password changes', () => {
  const k = sessionKey(appKey, hashPassword('one-password-123'));
  const t = issueToken(k, {now: 1000, days: 1});
  assert.equal(verifyToken(k, t, {now: 2000}), true);
  assert.equal(verifyToken(k, t, {now: 1000 + 86400000 + 1}), false, 'expired');
  assert.equal(verifyToken(k, t.slice(0, -2) + 'xx', {now: 2000}), false, 'tampered');
  assert.equal(verifyToken(sessionKey(appKey, hashPassword('another-password')), t, {now: 2000}), false);
  assert.equal(readCookie('a=1; yta_session=abc%3D; b=2'), 'abc=');
});

test('API and videos need a login on a server; health, login and the YouTube callback do not', async () => {
  const s = server();
  for (const p of ['/api/videos', '/api/ai/settings', '/storage/videos/x/final.mp4']) assert.equal((await call(s.protect, {path: p})).status, 401, p);
  for (const p of ['/api/health', '/api/auth/login', '/api/youtube/callback', '/index.html', '/assets/app.js']) assert.equal((await call(s.protect, {path: p})).status, 'next', p);
  assert.equal(isOpenPath('/api/youtube/auth/123'), false, 'starting the YouTube connection needs a login');
  // The bot / autopilot calls with the per-process token.
  assert.equal((await call(s.protect, {path: '/api/videos', headers: {'x-internal-token': INTERNAL_TOKEN}})).status, 'next');
  assert.equal((await call(s.protect, {path: '/api/videos', headers: {'x-internal-token': 'x'.repeat(64)}})).status, 401);
  // No password on a server: everything locked.
  const locked = await call(createSecurity({appKey, envVars: {NODE_ENV: 'production'}, log: quiet}).protect, {path: '/api/videos'});
  assert.equal(locked.status, 503);
  // Own PC without a password: open as before.
  assert.equal((await call(createSecurity({appKey, envVars: {}, log: quiet}).protect, {path: '/api/videos'})).status, 'next');
});

test('logging in sets a secure HttpOnly cookie that then opens the API', async () => {
  const s = server();
  const bad = await call(s.router, {method: 'POST', path: '/login', body: {username: 'admin', password: 'nope'}});
  assert.equal(bad.status, 401);
  const ok = await call(s.router, {method: 'POST', path: '/login', body: {username: 'Admin', password: 'a-long-test-password'}});
  assert.equal(ok.status, 200);
  const cookie = ok.headers['set-cookie'];
  assert.match(cookie, /^yta_session=.+; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=604800$/);
  const value = cookie.split(';')[0];
  assert.equal((await call(s.protect, {path: '/api/videos', headers: {cookie: value}})).status, 'next');
  const st = await call(s.router, {path: '/status', headers: {cookie: value}});
  assert.equal(st.body.loggedIn, true);
  const out = await call(s.router, {method: 'POST', path: '/logout'});
  assert.match(out.headers['set-cookie'], /Max-Age=0/);
});

test('too many wrong passwords are blocked for a while', async () => {
  const s = server();
  for (let i = 0; i < 5; i++) await call(s.router, {method: 'POST', path: '/login', body: {username: 'admin', password: 'wrong' + i}, ip: '9.9.9.9'});
  const blocked = await call(s.router, {method: 'POST', path: '/login', body: {username: 'admin', password: 'a-long-test-password'}, ip: '9.9.9.9'});
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal((await call(s.router, {method: 'POST', path: '/login', body: {username: 'admin', password: 'a-long-test-password'}, ip: '8.8.8.8'})).status, 200, 'other IPs are not affected');
  const l = createLimiter({max: 2, windowMs: 1000});
  l.fail('a', 0); l.fail('a', 10);
  assert.ok(l.blocked('a', 20) > 0);
  assert.equal(l.blocked('a', 2000), 0, 'unblocked after the window');
});

test('other websites cannot make changes with your cookie', async () => {
  const s = server({PUBLIC_URL: 'https://agent.example.com'});
  const host = 'agent.example.com';
  assert.equal((await call(s.cors, {method: 'POST', path: '/api/videos/1/approve', headers: {host, origin: 'https://evil.example'}})).status, 403);
  assert.equal((await call(s.cors, {method: 'POST', path: '/api/videos/1/approve', headers: {host, origin: 'https://agent.example.com'}})).status, 'next');
  assert.equal((await call(s.cors, {method: 'POST', path: '/api/x', headers: {host}})).status, 'next', 'no Origin (server-to-server, curl) is fine');
  assert.equal(originAllowed('http://localhost:5173', 'x', {production: true, allowed: []}), false, 'localhost is not trusted on a server');
  assert.equal(originAllowed('http://localhost:5173', '127.0.0.1:4000', {production: false, allowed: []}), true, 'dashboard dev server on your PC');
  const h = await call(s.headers, {path: '/api/videos'});
  assert.match(h.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(h.headers['x-frame-options'], 'DENY');
  assert.match(h.headers['strict-transport-security'], /max-age=/);
  assert.equal(h.headers['cache-control'], 'no-store');
});

test('the home page can read its contact details; only the admin can change them', async () => {
  const s = server();
  assert.equal((await call(s.protect, {path: '/api/site'})).status, 'next');
  assert.equal((await call(s.protect, {method: 'PUT', path: '/api/site'})).status, 401);
});

import {contentSecurityPolicy, isPublicPage} from '../src/security/httpSecurity.js';
test('Google Tag Manager is allowed on the public pages only', () => {
  for (const p of ['/', '/privacy', '/terms', '/terms.html', '/landing/site.js']) {
    assert.equal(isPublicPage(p), true, p);
    assert.match(contentSecurityPolicy(p), /script-src 'self' https:\/\/www\.googletagmanager\.com/);
    assert.doesNotMatch(contentSecurityPolicy(p).match(/script-src[^;]*/)[0], /unsafe/, 'no inline scripts allowed');
  }
  for (const p of ['/app/', '/app/settings', '/api/site', '/storage/x.mp4']) {
    assert.equal(isPublicPage(p), false, p);
    assert.match(contentSecurityPolicy(p), /script-src 'self';/);
    assert.doesNotMatch(contentSecurityPolicy(p), /googletagmanager/);
  }
});
