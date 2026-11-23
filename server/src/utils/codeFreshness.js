// Tells the dashboard when the server's code files changed after the backend started
// (an update was installed but the app was not restarted yet), so it can say
// "restart the app" instead of features silently not working.
import fs from 'node:fs';
import path from 'node:path';

export const STARTED_AT = Date.now();
let cache = {at: 0, changed: false};
export function newestFileTime(dir) {
  let newest = 0;
  const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|mjs|json)$/.test(e.name)) newest = Math.max(newest, fs.statSync(p).mtimeMs); } };
  try { walk(dir); } catch {}
  return newest;
}
export function codeChangedSinceStart(srcDir, {now = Date.now(), startedAt = STARTED_AT} = {}) {
  if (now - cache.at < 10000) return cache.changed;   // at most one scan per 10 s
  cache = {at: now, changed: newestFileTime(srcDir) > startedAt + 2000};
  return cache.changed;
}
