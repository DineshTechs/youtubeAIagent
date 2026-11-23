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

// Process life-cycle log (server/storage/logs/backend-lifecycle.log): one line when
// the backend starts and when it exits or receives a stop signal, plus a small
// "last alive" file refreshed every 15 s (memory use and the active job). If the
// backend disappears without a JavaScript error, these show when it stopped,
// whether it was stopped from outside, and how much memory it was using.
export function installLifecycleLog(storageDir, { getContext = () => ({}), intervalMs = 15_000 } = {}) {
  const dir = path.join(storageDir, 'logs');
  const file = path.join(dir, 'backend-lifecycle.log');
  const aliveFile = path.join(dir, 'backend-alive.json');
  const mem = () => { const m = process.memoryUsage(); return { rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576), externalMb: Math.round(m.external / 1048576) }; };
  const ctx = () => { try { return getContext() || {}; } catch { return {}; } };
  const write = (event, extra = {}) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ppid: process.ppid, ...mem(), ...ctx(), ...extra })}\n`, 'utf8');
    } catch {}
  };
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(aliveFile, 'utf8')); } catch {}
  write('start', { node: process.version, execArgv: process.execArgv, previousLastAlive: previous });
  const timer = setInterval(() => {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(aliveFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, uptimeS: Math.round(process.uptime()), ...mem(), ...ctx() }), 'utf8'); } catch {}
  }, intervalMs);
  timer.unref();
  process.on('exit', code => write('exit', { code }));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try {
      process.on(signal, () => {
        write('signal', { signal });
        // Keep Node's normal behaviour: a stop signal still stops the backend.
        process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 }[signal] || 0));
      });
    } catch {}
  }
  return file;
}
