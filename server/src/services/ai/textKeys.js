// Script (text) AI providers and their keys. Keys can be added in Settings → AI
// providers and are saved encrypted in AISettings.secrets.textKeys; the .env
// variables still work as a fallback. A key saved for Gemini / OpenAI / Groq is also
// used for their image and narration features.
import {env} from '../../config/env.js';
import {encryptSecret, decryptSecret} from '../secretBox.js';

// The OpenAI-compatible free providers. baseUrl may contain {accountId}.
export const TEXT_CATALOG = {
  gemini:     {name: 'Gemini', free: true, envKey: 'GEMINI_API_KEY', envField: 'geminiKey', keyUrl: 'https://aistudio.google.com/apikey', note: 'Free tier with daily limits. Good Hindi.'},
  groq:       {name: 'Groq', free: true, envKey: 'GROQ_API_KEY', envField: 'groqKey', keyUrl: 'https://console.groq.com/keys', note: 'Free, very fast; about 1,000 requests a day.'},
  cerebras:   {name: 'Cerebras', free: true, envKey: 'CEREBRAS_API_KEY', envField: 'cerebrasKey', keyUrl: 'https://cloud.cerebras.ai', note: 'Free tier, very fast; short context.'},
  openrouter: {name: 'OpenRouter', free: true, envKey: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemma-4-31b-it:free', note: 'Many free models (ids ending in ":free"); about 50 requests a day. The free list changes often.'},
  mistral:    {name: 'Mistral', free: true, envKey: 'MISTRAL_API_KEY', keyUrl: 'https://console.mistral.ai/api-keys', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', note: 'Free plan with account limits; no card.'},
  github:     {name: 'GitHub Models', free: true, envKey: 'GITHUB_MODELS_TOKEN', keyUrl: 'https://github.com/settings/personal-access-tokens', baseUrl: 'https://models.github.ai/inference', model: 'openai/gpt-4.1-mini', note: 'Free with any GitHub account: use a personal access token with "Models: read". Low daily limits.'},
  sambanova:  {name: 'SambaNova', free: true, envKey: 'SAMBANOVA_API_KEY', keyUrl: 'https://cloud.sambanova.ai/apis', baseUrl: 'https://api.sambanova.ai/v1', model: 'Meta-Llama-3.3-70B-Instruct', note: 'Free tier; about 20 requests a day per model.'},
  nvidia:     {name: 'NVIDIA', free: true, envKey: 'NVIDIA_API_KEY', keyUrl: 'https://build.nvidia.com', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', note: 'Free for prototyping (NVIDIA Developer Program). NVIDIA retires models often: use "Load models" to see what your key can use now.'},
  cloudflare: {name: 'Cloudflare Workers AI', free: true, envKey: 'CLOUDFLARE_API_TOKEN', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', needsAccountId: true, note: '10,000 free "neurons" a day. Uses the same account as Cloudflare images.'},
  cohere:     {name: 'Cohere', free: true, envKey: 'COHERE_API_KEY', keyUrl: 'https://dashboard.cohere.com/api-keys', baseUrl: 'https://api.cohere.ai/compatibility/v1', model: 'command-a-plus-05-2026', note: 'Trial key: 1,000 calls a month, not for commercial use.'},
  ollama:     {name: 'Ollama (on this PC)', free: true, keyOptional: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1:8b', customBaseUrl: true, note: 'Runs a model on your own computer: free and unlimited, but needs Ollama installed and a strong PC.'},
  openai:     {name: 'OpenAI', free: false, envKey: 'OPENAI_API_KEY', envField: 'openaiKey', keyUrl: 'https://platform.openai.com/api-keys', note: 'Paid.'}
};
export const COMPATIBLE_PROVIDERS = Object.keys(TEXT_CATALOG).filter(p => TEXT_CATALOG[p].baseUrl);

const envValue = name => String(process.env[name] || '').trim();
// Values from .env at start-up, so removing a dashboard key falls back to them.
const ORIGINAL = Object.fromEntries(Object.values(TEXT_CATALOG).filter(c => c.envField).map(c => [c.envField, env[c.envField] || '']));
// Image-only values that a dashboard key can replace (Cloudflare images, Pollinations).
const ORIGINAL_MEDIA = {cloudflareApiToken: env.cloudflareApiToken || '', cloudflareAccountId: env.cloudflareAccountId || '', pollinationsKey: env.pollinationsKey || '', deepgramKey: env.deepgramKey || ''};
export function originalEnv(field) { return field in ORIGINAL_MEDIA ? ORIGINAL_MEDIA[field] : (ORIGINAL[field] || ''); }
// Single-key services saved in Settings → API keys: Pollinations (images), Deepgram (narration check).
export const MEDIA_KEY_FIELDS = {pollinations: 'pollinationsKey', deepgram: 'deepgramKey'};
export function mediaKeyFrom(settings, id) {
  const saved = settings?.secrets?.mediaKeys?.[id];
  const key = decryptSecret(saved) || '';
  const original = ORIGINAL_MEDIA[MEDIA_KEY_FIELDS[id]] || '';
  return {key: key || original, saved: Boolean(key), stored: Boolean(saved), fromEnv: !key && Boolean(original)};
}
export const pollinationsKeyFrom = settings => mediaKeyFrom(settings, 'pollinations');

export function textCredentialsFrom(settings) {
  const saved = settings?.secrets?.textKeys || {};
  const out = {};
  for (const [id, c] of Object.entries(TEXT_CATALOG)) {
    const s = saved[id] || {};
    const savedKey = decryptSecret(s.key);
    const envKey = c.envField ? ORIGINAL[c.envField] : (id === 'cloudflare' ? ORIGINAL_MEDIA.cloudflareApiToken : id === 'github' ? (envValue('GITHUB_MODELS_TOKEN') || envValue('GITHUB_TOKEN')) : c.envKey ? envValue(c.envKey) : '');
    const accountId = c.needsAccountId ? String(s.accountId || ORIGINAL_MEDIA.cloudflareAccountId || '').trim() : '';
    const baseUrl = c.customBaseUrl ? String(s.baseUrl || envValue('OLLAMA_BASE_URL') || c.baseUrl) : c.baseUrl ? c.baseUrl.replace('{accountId}', encodeURIComponent(accountId)) : '';
    // Ollama counts as set up only once its address is saved (or OLLAMA_BASE_URL is set).
    const addressSet = c.customBaseUrl ? Boolean(s.baseUrl || envValue('OLLAMA_BASE_URL')) : false;
    // stored but unreadable = saved with a different APP_SECRET_KEY (e.g. on another computer).
    out[id] = {key: savedKey || envKey || '', fromEnv: !savedKey && Boolean(envKey), saved: Boolean(savedKey), unreadable: Boolean(s.key) && !savedKey, accountId, accountFromEnv: c.needsAccountId ? !s.accountId && Boolean(accountId) : false, baseUrl, addressSet};
  }
  return out;
}
export function textConfigured(id, cred) {
  const c = TEXT_CATALOG[id];
  if (!c || !cred) return false;
  if (c.keyOptional) return Boolean(cred.baseUrl && cred.addressSet);
  if (c.needsAccountId && !cred.accountId) return false;
  return Boolean(cred.key);
}
// Public view for the dashboard: never the key itself.
export function textKeyStatus(settings) {
  const creds = textCredentialsFrom(settings);
  return Object.fromEntries(Object.entries(TEXT_CATALOG).map(([id, c]) => [id, {
    name: c.name, free: c.free, note: c.note, keyUrl: c.keyUrl || '', hasKey: Boolean(creds[id].key), fromEnv: creds[id].fromEnv,
    keyOptional: Boolean(c.keyOptional), needsAccountId: Boolean(c.needsAccountId), accountId: creds[id].accountId,
    customBaseUrl: Boolean(c.customBaseUrl), baseUrl: c.customBaseUrl ? creds[id].baseUrl : '', defaultModel: c.model || '',
    configured: textConfigured(id, creds[id])
  }]));
}
// Dashboard keys for Gemini / OpenAI / Groq / Cerebras also feed their image and
// narration features, which read env.* directly.
export function applyTextKeysToEnv(settings) {
  const creds = textCredentialsFrom(settings);
  for (const [id, c] of Object.entries(TEXT_CATALOG)) if (c.envField) env[c.envField] = creds[id].key || ORIGINAL[c.envField] || '';
  // Cloudflare: one token + account ID serve both scripts and images.
  const cf = creds.cloudflare;
  env.cloudflareApiToken = env.cloudflareToken = cf.key || ORIGINAL_MEDIA.cloudflareApiToken;
  env.cloudflareAccountId = cf.accountId || ORIGINAL_MEDIA.cloudflareAccountId;
  for (const [id, field] of Object.entries(MEDIA_KEY_FIELDS)) env[field] = mediaKeyFrom(settings, id).key;
  return creds;
}
// Trims quotes, "Bearer " and spaces that come with copy-paste; rejects obvious non-keys.
export function cleanKey(key) {
  // Zero-width spaces, BOMs and other invisible characters sneak in when copying from web pages.
  const k = String(key || '').replace(/[\u0000-\u001f\u007f-\u00a0\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, ' ').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^Bearer\s+/i, '').trim();
  if (/\s/.test(k) || k.length < 8) throw Object.assign(new Error('That does not look like an API key (too short or has spaces).'), {status: 400});
  return k.slice(0, 500);
}
// Cloudflare's Global API Key (37 hex characters) does not work here: it needs an API token.
export const isCloudflareGlobalKey = k => /^[a-f0-9]{37}$/i.test(String(k || ''));
export const GLOBAL_KEY_ERROR = 'This is the Cloudflare Global API Key (37 characters), not an API token. In Cloudflare go to My Profile → API Tokens → Create Token → "Workers AI" template, and paste the token it shows (about 40 characters).';
// Builds the $set/$unset for saving. Blank key keeps the saved one; clear:true removes it.
export function textKeyUpdate(provider, {key, clear, accountId, baseUrl} = {}) {
  const c = TEXT_CATALOG[provider];
  if (!c) throw Object.assign(new Error(`Unknown script provider: ${provider}`), {status: 400});
  const set = {}, unset = {};
  const base = `secrets.textKeys.${provider}`;
  if (clear) unset[`${base}.key`] = 1;
  else if (typeof key === 'string' && key.trim()) {
    const k = cleanKey(key);
    if (provider === 'cloudflare' && isCloudflareGlobalKey(k)) throw Object.assign(new Error(GLOBAL_KEY_ERROR), {status: 400});
    set[`${base}.key`] = encryptSecret(k);
  }
  if (c.needsAccountId && typeof accountId === 'string') {
    const a = accountId.trim();
    if (a && !/^[a-f0-9]{32}$/i.test(a)) throw Object.assign(new Error('The Cloudflare account ID is 32 letters/digits (Dashboard → Workers AI → "Use REST API").'), {status: 400});
    set[`${base}.accountId`] = a;
  }
  if (c.customBaseUrl && typeof baseUrl === 'string') {
    const u = baseUrl.trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw Object.assign(new Error('The address must start with http:// or https://'), {status: 400});
    set[`${base}.baseUrl`] = u;
  }
  return {set, unset};
}
