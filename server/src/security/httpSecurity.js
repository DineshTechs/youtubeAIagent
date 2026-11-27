// HTTP hardening for a hosted install: security headers, CORS/origin rules, the
// login API and the middleware that protects /api and /storage.
import crypto from 'node:crypto';
import {authConfig, verifyPassword, sessionKey, issueToken, verifyToken, readCookie, cookieHeader, createLimiter, isOpenPath, COOKIE} from './auth.js';

// One random token per process: lets the Telegram bot call this API from inside the app.
export const INTERNAL_TOKEN = crypto.randomBytes(32).toString('hex');

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
export function allowedOrigins(envVars = process.env) {
  return String(envVars.ALLOWED_ORIGINS || envVars.PUBLIC_URL || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
// Same-site requests, the configured site, and (on your own PC only) localhost.
export function originAllowed(origin, host, {production, allowed}) {
  if (!origin) return true;
  const o = String(origin).replace(/\/+$/, '');
  try { if (host && new URL(o).host === host) return true; } catch { return false; }
  if (allowed.includes(o)) return true;
  return !production && LOCAL_ORIGIN.test(o);
}

// The dashboard and API only load this server's own files. The public pages (home,
// privacy, terms) may also load Google Tag Manager / Google Analytics.
const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
const G = 'https://www.googletagmanager.com https://*.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com https://*.g.doubleclick.net https://www.google.com https://*.google.co.in';
const PUBLIC_CSP = `default-src 'self'; script-src 'self' https://www.googletagmanager.com https://*.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${G}; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' ${G}; frame-src https://www.googletagmanager.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`;
export const isPublicPage = p => p === '/' || /^\/(privacy|terms)(\.html)?$/.test(p) || p.startsWith('/landing/');
export function contentSecurityPolicy(p) { return isPublicPage(p) ? PUBLIC_CSP : STRICT_CSP; }

export function securityHeaders({production}) {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', isPublicPage(req.path) ? 'strict-origin-when-cross-origin' : 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (production && req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (production) res.setHeader('Content-Security-Policy', contentSecurityPolicy(req.path));
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

export function createSecurity({appKey, envVars = process.env, log = console}) {
  const config = authConfig(envVars);
  const allowed = allowedOrigins(envVars);
  const key = config.passwordHash ? sessionKey(appKey, config.passwordHash) : null;
  const limiter = createLimiter();
  for (const p of config.problems) log.error(`[security] ${p}`);
  if (config.required && !config.configured) log.error('[security] Login is required on a server but no valid ADMIN_PASSWORD / ADMIN_PASSWORD_HASH is set. The API stays locked until you set one.');

  const isLoggedIn = req => Boolean(key && verifyToken(key, readCookie(req.headers.cookie)));
  const isInternal = req => {
    const t = String(req.headers['x-internal-token'] || '');
    return t.length === INTERNAL_TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(INTERNAL_TOKEN));
  };
  const authenticated = req => !config.required || isInternal(req) || isLoggedIn(req);

  // CORS: only for the configured site, or localhost while developing on your PC.
  const cors = (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && originAllowed(origin, req.headers.host, {production: config.production, allowed})) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(origin && !originAllowed(origin, req.headers.host, {production: config.production, allowed}) ? 403 : 204);
    // Changes must come from this site (stops other websites posting with your cookie).
    if (!['GET', 'HEAD'].includes(req.method) && !originAllowed(origin, req.headers.host, {production: config.production, allowed})) return res.status(403).json({error: 'Request from another website was refused.'});
    next();
  };

  const protect = (req, res, next) => {
    const p = req.path;
    if (!(p.startsWith('/api/') || p.startsWith('/storage/'))) return next();
    if (isOpenPath(p, req.method)) return next();
    if (config.required && !config.configured) return res.status(503).json({error: 'Server is locked: set ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH) in the app\'s environment variables and restart.', locked: true});
    if (authenticated(req)) return next();
    return res.status(401).json({error: 'Please log in.', loginRequired: true});
  };

  // /api/auth/status, /api/auth/login, /api/auth/logout (no express.Router, so it is testable without express).
  const status = (req, res) => res.json({required: config.required, configured: config.configured, loggedIn: authenticated(req) && config.required ? isLoggedIn(req) : !config.required, username: config.required ? config.username : null});
  const login = (req, res) => {
    if (!config.required) return res.json({ok: true, loggedIn: true});
    if (!config.configured) return res.status(503).json({error: 'No admin password is set on the server.', locked: true});
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const wait = limiter.blocked(ip);
    if (wait) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({error: `Too many failed logins. Try again in ${Math.ceil(wait / 60)} min.`}); }
    const {username = '', password = ''} = req.body || {};
    const userOk = crypto.timingSafeEqual(crypto.createHash('sha256').update(String(username).trim().toLowerCase()).digest(), crypto.createHash('sha256').update(config.username.toLowerCase()).digest());
    const passOk = verifyPassword(String(password), config.passwordHash);
    if (!userOk || !passOk) { limiter.fail(ip); log.warn?.(`[security] failed login from ${ip}`); return res.status(401).json({error: 'Wrong username or password.'}); }
    limiter.reset(ip);
    res.setHeader('Set-Cookie', cookieHeader(issueToken(key), {secure: req.secure, maxAgeSec: Number(envVars.SESSION_DAYS || 7) * 86400}));
    res.json({ok: true, loggedIn: true, username: config.username});
  };
  const logout = (req, res) => { res.setHeader('Set-Cookie', cookieHeader('', {secure: req.secure, maxAgeSec: 0})); res.json({ok: true}); };
  const router = (req, res, next) => {
    if (req.method === 'GET' && req.path === '/status') return status(req, res);
    if (req.method === 'POST' && req.path === '/login') return login(req, res);
    if (req.method === 'POST' && req.path === '/logout') return logout(req, res);
    return next();
  };

  return {config, cors, protect, router, authenticated, headers: securityHeaders({production: config.production})};
}
export {COOKIE};
