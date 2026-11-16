import fs from 'node:fs';
import path from 'node:path';

// Record fatal errors to server/storage/logs/backend-crash.log (git-ignored)
// so the cause of a backend crash survives the console. Uses the *monitor*
// event: Node's normal crash behaviour is unchanged.
export function installCrashLog(storageDir, { getContext = () => ({}) } = {}) {
  const file = path.join(storageDir, 'logs', 'backend-crash.log');
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let context = {};
      try { context = getContext() || {}; } catch {}
      const entry = { at: new Date().toISOString(), origin, message: String(error?.message || error).slice(0, 2000), stack: String(error?.stack || '').slice(0, 6000), node: process.version, ...context };
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {}
  });
  return file;
}
