// Dashboard login for a hosted (internet-facing) install.
//
// - On a server (NODE_ENV=production, or ADMIN_PASSWORD / ADMIN_PASSWORD_HASH set)
//   every /api and /storage request needs the admin session cookie.
// - Without a password in production the API refuses to work at all (fail closed).
// - On your own PC (no password, not production) nothing changes: no login.
//
// Session = signed, expiring token in an HttpOnly cookie. The signature key is
// derived from APP_SECRET_KEY / the secret key file AND the password hash, so
// changing the password logs every session out.
import crypto from 'node:crypto';

export const COOKIE = 'yta_session';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);

// ---- password hashing (scrypt; no extra packages) ----
export function hashPassword(password, {salt = crypto.randomBytes(16), N = 16384} = {}) {
  const hash = crypto.scryptSync(String(password), salt, 32, {N, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(password, stored) {
  const [kind, n, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password ?? ''), Buffer.from(salt, 'base64'), expected.length, {N: Number(n), r: 8, p: 1, maxmem: 64 * 1024 * 1024});
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---- configuration ----
export function authConfig(envVars = process.env) {
  const production = String(envVars.NODE_ENV || '').toLowerCase() === 'production';
  const plain = String(envVars.ADMIN_PASSWORD || '');
  const hashed = String(envVars.ADMIN_PASSWORD_HASH || '').trim();
  const configured = Boolean(hashed || plain);
  const disabled = String(envVars.AUTH_DISABLED || '').toLowerCase() === 'true' && !production;
  const problems = [];
  if (plain && plain.length < 10) problems.push('ADMIN_PASSWORD must be at least 10 characters.');
  if (hashed && !/^scrypt\$\d+\$[^$]+\$[^$]+$/.test(hashed)) problems.push('ADMIN_PASSWORD_HASH is not a valid hash (create one with: npm run hash-password).');
  return {
    required: !disabled && (production || configured),
    production,
    configured: configured && !problems.length,
    problems,
    passwordHash: problems.length ? '' : (hashed || (plain ? hashPassword(plain) : '')),
    username: String(envVars.ADMIN_USERNAME || 'admin').trim() || 'admin'
  };
}

// ---- signed session tokens ----
const b64 = b => Buffer.from(b).toString('base64url');
export function sessionKey(appKey, passwordHash) {
  return crypto.createHmac('sha256', appKey).update(`session|${passwordHash}`).digest();
}
export function issueToken(key, {now = Date.now(), days = SESSION_DAYS} = {}) {
  const body = b64(JSON.stringify({iat: now, exp: now + days * 86400000, n: crypto.randomBytes(8).toString('hex')}));
  return `${body}.${b64(crypto.createHmac('sha256', key).update(body).digest())}`;
}
export function verifyToken(key, token, {now = Date.now()} = {}) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return false;
  const expected = crypto.createHmac('sha256', key).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return false;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return Number(p.exp) > now; } catch { return false; }
}
export function readCookie(header, name = COOKIE) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
export function cookieHeader(value, {secure, maxAgeSec}) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${maxAgeSec}`;
}

// ---- login attempt limiter (per IP + overall) ----
export function createLimiter({max = 5, windowMs = 15 * 60000, globalMax = 50} = {}) {
  const hits = new Map(); let global = [];
  const prune = (list, now) => list.filter(t => now - t < windowMs);
  return {
    blocked(ip, now = Date.now()) {
      global = prune(global, now);
      const list = prune(hits.get(ip) || [], now); hits.set(ip, list);
      if (list.length >= max) return Math.ceil((windowMs - (now - list[0])) / 1000);
      if (global.length >= globalMax) return Math.ceil((windowMs - (now - global[0])) / 1000);
      return 0;
    },
    fail(ip, now = Date.now()) { hits.set(ip, [...prune(hits.get(ip) || [], now), now]); global.push(now); },
    reset(ip) { hits.delete(ip); }
  };
}

// Paths reachable without logging in (the home page reads /api/site, but only an admin may change it).
const OPEN = [/^\/api\/health$/, /^\/api\/auth\/(login|logout|status)$/, /^\/api\/youtube\/callback$/];
const OPEN_READ = [/^\/api\/site\/?$/];
export const isOpenPath = (p, method = 'GET') => OPEN.some(re => re.test(p)) || (['GET', 'HEAD'].includes(String(method).toUpperCase()) && OPEN_READ.some(re => re.test(p)));
