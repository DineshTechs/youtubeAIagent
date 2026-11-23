// Runs before `npm start`: builds the dashboard (client/dist) when it is missing or
// older than its source, e.g. after a fresh `git pull` on the server (dist is not in git).
// If the build fails the server still starts (the home page works), with a clear message.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const client = path.join(root, 'client');
const built = path.join(client, 'dist', 'index.html');

function newest(p) {
  let t = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.mtimeMs;
    for (const name of fs.readdirSync(p)) t = Math.max(t, newest(path.join(p, name)));
  } catch {}
  return t;
}

const sources = Math.max(newest(path.join(client, 'src')), newest(path.join(client, 'index.html')), newest(path.join(client, 'vite.config.js')));
const builtAt = newest(built);
if (builtAt && builtAt >= sources) {
  console.log('[start] Dashboard build is up to date.');
  process.exit(0);
}
if (!fs.existsSync(path.join(client, 'package.json'))) {
  console.warn('[start] client/ folder not found - the dashboard (/app/) cannot be built here.');
  process.exit(0);
}
console.log(builtAt ? '[start] Dashboard source changed - rebuilding client/dist ...' : '[start] Dashboard not built yet - building client/dist ...');
const r = spawnSync('npm', ['run', 'build', '--workspace', 'client'], {cwd: root, stdio: 'inherit', shell: process.platform === 'win32'});
if (r.status !== 0) console.error('[start] Dashboard build FAILED. Run "npm install" in the project folder, then restart. The home page still works; /app/ will show a notice.');
process.exit(0);
