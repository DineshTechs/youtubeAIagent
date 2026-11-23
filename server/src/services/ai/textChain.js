// Script provider priority: providers are tried in the user's order; when one fails
// (no answer, rate limit, retired model, bad output…) the next one is tried.
import {aiProgress} from './aiEvents.js';

// Saved order of ENABLED providers, or (first time) the active one then every other
// provider that has a key, in catalog order.
// autoInclude limits which providers join automatically (e.g. only free ones, so a
// paid key is never used as a backup unless the user adds it).
export function resolvePriority({priority, activeProvider, ids, configured, autoInclude = () => true}) {
  const known = new Set(ids);
  const saved = Array.isArray(priority) ? priority.filter((p, i, a) => known.has(p) && a.indexOf(p) === i) : null;
  if (saved && saved.length) return saved;
  const first = known.has(activeProvider) ? [activeProvider] : [];
  return [...first, ...ids.filter(p => p !== activeProvider && p !== 'mock' && configured(p) && autoInclude(p))];
}
// Which providers a job will actually try, in order.
export function chainFor({order, fallbackEnabled = true, configured}) {
  const usable = order.filter(configured);
  return fallbackEnabled ? usable : usable.slice(0, 1);
}
const short = e => String(e?.message || e || 'unknown error').replace(/\s+/g, ' ').slice(0, 160);

// A provider object that forwards every method call through the chain.
export function createFallbackProvider(entries, {progress = aiProgress} = {}) {
  if (!entries.length) throw new Error('No script AI provider has an API key. Add one in Settings → AI providers.');
  const cache = new Map();
  const instance = e => { if (!cache.has(e.id)) cache.set(e.id, e.make()); return cache.get(e.id); };
  const call = async (method, args) => {
    const failures = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      let provider;
      try { provider = instance(e); } catch (err) { failures.push(`${e.name}: ${short(err)}`); continue; }
      if (typeof provider?.[method] !== 'function') continue;
      try {
        const out = await provider[method](...args);
        if (i > 0) progress(`${e.name} answered (backup provider #${i + 1}).`, {provider: e.id});
        return out;
      } catch (err) {
        failures.push(`${e.name}: ${short(err)}`);
        const next = entries.slice(i + 1).find(x => x);
        if (next) progress(`${e.name} failed (${short(err)}). Trying ${next.name} next.`, {provider: e.id, level: 'warning'});
      }
    }
    throw new Error(failures.length > 1 ? `All script providers failed — ${failures.join(' | ')}` : (failures[0] || `No script provider can do "${method}".`));
  };
  const first = entries[0];
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;   // not a promise
      if (prop === 'chain') return entries.map(e => e.id);
      if (prop === 'name') return first.name;
      return (...args) => call(prop, args);
    },
    has: () => true
  });
}
