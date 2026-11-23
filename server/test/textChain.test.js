import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePriority, chainFor, createFallbackProvider} from '../src/services/ai/textChain.js';

const ids = ['gemini', 'groq', 'cerebras', 'openrouter', 'mistral', 'nvidia', 'openai', 'mock'];
const keyed = new Set(['gemini', 'groq', 'mistral', 'nvidia']);
const configured = p => keyed.has(p);

test('first time: the active provider, then every other provider with a key', () => {
  assert.deepEqual(resolvePriority({activeProvider: 'nvidia', ids, configured}), ['nvidia', 'gemini', 'groq', 'mistral']);
  assert.deepEqual(resolvePriority({priority: ['mistral', 'bogus', 'gemini', 'mistral'], activeProvider: 'nvidia', ids, configured}), ['mistral', 'gemini']);
});

test('the chain skips providers without a key; fallback off means only the first', () => {
  const order = ['openrouter', 'mistral', 'gemini'];
  assert.deepEqual(chainFor({order, configured}), ['mistral', 'gemini']);
  assert.deepEqual(chainFor({order, fallbackEnabled: false, configured}), ['mistral']);
});

test('when a provider fails the next one is tried, and the switch is reported', async () => {
  const progress = []; const made = [];
  const entry = (id, impl) => ({id, name: id.toUpperCase(), make: () => { made.push(id); return impl; }});
  const ai = createFallbackProvider([
    entry('nvidia', {generateStory: async () => { throw new Error('The model "meta/llama-3.3-70b-instruct" cannot be used any more'); }}),
    entry('gemini', {generateStory: async () => { throw new Error('503 high demand'); }}),
    entry('mistral', {generateStory: async x => ({title: `ok ${x.topic}`})}),
    entry('groq', {generateStory: async () => { throw new Error('should not be reached'); }})
  ], {progress: (m, e) => progress.push([m, e?.level || 'info'])});
  assert.deepEqual(await ai.generateStory({topic: 'सफलता'}), {title: 'ok सफलता'});
  assert.deepEqual(made, ['nvidia', 'gemini', 'mistral'], 'later providers are not even created');
  assert.match(progress[0][0], /NVIDIA failed .*Trying GEMINI next/);
  assert.equal(progress[0][1], 'warning');
  assert.match(progress[2][0], /MISTRAL answered \(backup provider #3\)/);
  assert.deepEqual(ai.chain, ['nvidia', 'gemini', 'mistral', 'groq']);
  assert.equal(typeof ai.generateJson, 'function');
  assert.equal(await Promise.resolve(ai) === ai, true, 'awaiting it does not treat it as a promise');
});

test('all failing: one error listing every provider', async () => {
  const ai = createFallbackProvider([
    {id: 'a', name: 'A', make: () => ({generateJson: async () => { throw new Error('rate limit'); }})},
    {id: 'b', name: 'B', make: () => { throw new Error('no key'); }}
  ], {progress: () => {}});
  await assert.rejects(ai.generateJson('x', {}, 'plan'), /All script providers failed — A: rate limit \| B: no key/);
  assert.throws(() => createFallbackProvider([]), /No script AI provider has an API key/);
});

test('automatic backups only include allowed (e.g. free) providers; saved lists are kept as is', () => {
  const free = new Set(['gemini', 'groq', 'mistral']);
  assert.deepEqual(resolvePriority({activeProvider: 'nvidia', ids: [...ids, 'openai'], configured: p => keyed.has(p) || p === 'openai', autoInclude: p => free.has(p)}), ['nvidia', 'gemini', 'groq', 'mistral']);
  assert.deepEqual(resolvePriority({priority: ['openai', 'gemini'], ids, configured, autoInclude: () => false}), ['openai', 'gemini']);
});
