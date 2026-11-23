import test from 'node:test';
import assert from 'node:assert/strict';
import {env} from '../src/config/env.js';
import {TEXT_CATALOG, COMPATIBLE_PROVIDERS, textCredentialsFrom, textKeyStatus, textKeyUpdate, applyTextKeysToEnv, textConfigured} from '../src/services/ai/textKeys.js';
import {compatibleProvider} from '../src/services/ai/openAICompatibleProvider.js';

const settingsWith = textKeys => ({secrets: {textKeys}});
const saved = (provider, input) => { const {set} = textKeyUpdate(provider, input); const out = {}; for (const [k, v] of Object.entries(set)) out[k.split('.').pop()] = v; return out; };

test('free script providers are listed with endpoints and default models', () => {
  for (const id of ['openrouter', 'mistral', 'github', 'sambanova', 'nvidia', 'cloudflare', 'cohere', 'ollama']) {
    assert.ok(COMPATIBLE_PROVIDERS.includes(id), id);
    assert.match(TEXT_CATALOG[id].baseUrl, /^https?:\/\//);
    assert.ok(TEXT_CATALOG[id].model, id);
  }
});

test('keys saved from the dashboard are encrypted, never shown, and used', () => {
  const secret = 'sk-or-v1-abcdef1234567890';
  const s = settingsWith({openrouter: saved('openrouter', {key: `Bearer ${secret}`})});
  assert.notEqual(s.secrets.textKeys.openrouter.key, secret, 'stored encrypted');
  assert.equal(textCredentialsFrom(s).openrouter.key, secret);
  const status = textKeyStatus(s);
  assert.equal(status.openrouter.hasKey, true);
  assert.equal(status.openrouter.configured, true);
  assert.ok(!JSON.stringify(status).includes(secret), 'the key never leaves the server');
  assert.equal(status.mistral.configured, Boolean(process.env.MISTRAL_API_KEY));
});

test('Cloudflare needs an account ID; Ollama needs no key; bad input is refused', () => {
  const s = settingsWith({cloudflare: saved('cloudflare', {key: 'cf-token-1234567890', accountId: '0123456789abcdef0123456789abcdef'})});
  const c = textCredentialsFrom(s).cloudflare;
  assert.equal(c.baseUrl, 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1');
  assert.equal(textConfigured('cloudflare', c), true);
  assert.equal(textConfigured('cloudflare', {...c, accountId: ''}), false);
  assert.throws(() => textKeyUpdate('cloudflare', {accountId: 'not-an-id'}), /32 letters/);
  assert.equal(textConfigured('ollama', textCredentialsFrom({}).ollama), Boolean(process.env.OLLAMA_BASE_URL), 'not shown as ready until its address is saved');
  assert.equal(textConfigured('ollama', textCredentialsFrom(settingsWith({ollama: saved('ollama', {baseUrl: 'http://127.0.0.1:11434/v1'})})).ollama), true);
  assert.equal(textCredentialsFrom(settingsWith({ollama: saved('ollama', {baseUrl: 'http://192.168.1.5:11434/v1/'})})).ollama.baseUrl, 'http://192.168.1.5:11434/v1');
  assert.throws(() => textKeyUpdate('openrouter', {key: 'abc'}), /does not look like/);
  assert.throws(() => textKeyUpdate('nope', {key: 'x'.repeat(20)}), /Unknown/);
  assert.deepEqual(textKeyUpdate('mistral', {clear: true}).unset, {'secrets.textKeys.mistral.key': 1});
});

test('a Gemini key saved in the dashboard is also used for Gemini images and narration', () => {
  const before = env.geminiKey;
  applyTextKeysToEnv(settingsWith({gemini: saved('gemini', {key: 'AIzaDashboardKey123456'})}));
  assert.equal(env.geminiKey, 'AIzaDashboardKey123456');
  applyTextKeysToEnv({});
  assert.equal(env.geminiKey, before, 'removing it falls back to .env');
});

test('OpenAI-compatible requests: Groq-only options are not sent to other providers', async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { bodies.push({url, body: JSON.parse(init.body), auth: init.headers.Authorization}); return new Response(JSON.stringify({choices: [{message: {content: '{"ok":true}'}}]}), {status: 200}); };
  try {
    await compatibleProvider({name: 'Mistral', apiKey: 'k-123456789', baseUrl: 'https://api.mistral.ai/v1/', model: 'mistral-small-latest'}).testConnection();
    await compatibleProvider({name: 'Groq', apiKey: 'k-123456789', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b'}).testConnection();
  } finally { globalThis.fetch = realFetch; }
  assert.equal(bodies[0].url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(bodies[0].body.reasoning_format, undefined);
  assert.equal(bodies[0].auth, 'Bearer k-123456789');
  assert.equal(bodies[1].body.reasoning_format, 'hidden');
});

// Regression 2026-11-23: NVIDIA retired meta/llama-3.3-70b-instruct (HTTP 410) and the job
// tried the same dead model twice and then showed a raw error.
test('a retired model gives one clear message and is not retried', async () => {
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({type: 'about:blank', title: 'Gone', status: 410, detail: "The model 'meta/llama-3.3-70b-instruct' has reached its end of life on 2026-08-26T09:00:00Z and is no longer available."}), {status: 410}); };
  try {
    await assert.rejects(compatibleProvider({name: 'NVIDIA', apiKey: 'nvapi-123456789', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.3-70b-instruct'}).testConnection(),
      e => e.modelUnavailable && /cannot be used any more/.test(e.message) && /Load models/.test(e.message) && /end of life/.test(e.message));
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls, 1);
});

test('Load models lists chat models (free first) and hides embeddings and other kinds', async () => {
  const {listCompatibleModels} = await import('../src/services/ai/openAICompatibleProvider.js');
  let seen;
  const fetchImpl = async (url, init) => { seen = {url, auth: init.headers.Authorization}; return new Response(JSON.stringify({data: [{id: 'nvidia/nv-embedqa-e5-v5'}, {id: 'meta/llama-guard-4-12b'}, {id: 'qwen/qwen3-235b'}, {id: 'google/gemma-4-31b-it:free'}, {id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5'}]}), {status: 200}); };
  const ids = await listCompatibleModels({baseUrl: 'https://integrate.api.nvidia.com/v1/', apiKey: 'nvapi-1', fetchImpl});
  assert.equal(seen.url, 'https://integrate.api.nvidia.com/v1/models');
  assert.equal(seen.auth, 'Bearer nvapi-1');
  assert.deepEqual(ids, ['google/gemma-4-31b-it:free', 'nvidia/llama-3.3-nemotron-super-49b-v1.5', 'qwen/qwen3-235b']);
});

test('reasoning models: <think> blocks before the JSON are ignored', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({choices: [{message: {content: '<think>Let me plan {this} out…</think>\n{"ok":true,"message":"hi"}'}}]}), {status: 200});
  try {
    const out = await compatibleProvider({name: 'NVIDIA', apiKey: 'nvapi-123456789', baseUrl: 'https://x/v1', model: 'm'}).testConnection();
    assert.deepEqual(out, {ok: true, message: 'hi'});
  } finally { globalThis.fetch = realFetch; }
});
