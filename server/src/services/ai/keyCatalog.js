// One list of every API key the app uses, for Settings → AI providers → API keys.
// Pure (no database): the caller passes the AISettings document. Keys are never
// returned, only whether one is set, where it comes from and its last 4 characters.
import {TEXT_CATALOG, textCredentialsFrom, textConfigured, pollinationsKeyFrom, mediaKeyFrom, cleanKey, isCloudflareGlobalKey} from './textKeys.js';
import {decryptSecret, encryptSecret} from '../secretBox.js';

const envValue = name => String(process.env[name] || '').trim();
export const hint = key => (key && key.length >= 12 ? `…${key.slice(-4)}` : key ? 'set' : '');

const USED_FOR = {gemini: ['Scripts', 'Images', 'Narration', 'Narration check'], openai: ['Scripts', 'Images', 'Narration', 'Narration check'], groq: ['Scripts', 'Narration', 'Narration check'], cloudflare: ['Scripts', 'Images', 'Narration check']};
export const TTS_KEYS = {
  azure: {name: 'Microsoft Azure Speech', secret: 'azureSpeechKey', env: 'AZURE_SPEECH_KEY', keyUrl: 'https://portal.azure.com', extra: {name: 'region', label: 'Region', secretField: 'azureSpeechRegion', env: 'AZURE_SPEECH_REGION', placeholder: 'centralindia'}},
  google: {name: 'Google Cloud TTS', secret: 'googleTtsKey', env: 'GOOGLE_TTS_API_KEY', keyUrl: 'https://console.cloud.google.com/apis/credentials'},
  elevenlabs: {name: 'ElevenLabs', secret: 'elevenlabsKey', env: 'ELEVENLABS_API_KEY', keyUrl: 'https://elevenlabs.io/app/settings/api-keys'},
  aiawaaz: {name: 'AI Awaaz (MCP)', secret: 'aiawaazKey', env: 'AIAWAAZ_API_KEY', keyUrl: 'https://app.aiawaaz.io', extra: {name: 'url', label: 'MCP server URL', secretField: 'aiawaazUrl', env: 'AIAWAAZ_MCP_URL', placeholder: 'https://app.aiawaaz.io/api/mcp'}}
};
export const KEY_IDS = [...Object.keys(TEXT_CATALOG), 'pollinations', 'deepgram', ...Object.keys(TTS_KEYS)];
export const keyKind = id => (TEXT_CATALOG[id] ? 'text' : TTS_KEYS[id] ? 'tts' : ['pollinations', 'deepgram'].includes(id) ? 'media' : null);

const sourceOf = ({saved, fromEnv}) => (saved ? 'dashboard' : fromEnv ? 'server' : 'none');

export function keyList(settings) {
  const creds = textCredentialsFrom(settings);
  const list = [];
  for (const [id, c] of Object.entries(TEXT_CATALOG)) {
    const cr = creds[id];
    const fields = [];
    if (!c.keyOptional) fields.push({name: 'key', label: id === 'cloudflare' ? 'API token (not the Global API Key)' : id === 'github' ? 'Access token' : 'API key', secret: true});
    if (c.needsAccountId) fields.push({name: 'accountId', label: 'Account ID', hint: 'Cloudflare dashboard → Workers AI → "Use REST API"', value: cr.accountId, fromEnv: cr.accountFromEnv, placeholder: '32 letters/digits'});
    if (c.customBaseUrl) fields.push({name: 'baseUrl', label: 'Address', value: cr.addressSet ? cr.baseUrl : '', placeholder: c.baseUrl});
    const warning = id === 'cloudflare' && isCloudflareGlobalKey(cr.key) ? `The ${cr.saved ? 'saved' : '.env'} value is the Global API Key, which Workers AI rejects. Replace it with an API token (Create Token → "Workers AI" template).` : '';
    list.push({id, kind: 'text', name: c.name, warning, usedFor: USED_FOR[id] || ['Scripts'], keyUrl: c.keyUrl || '', free: c.free, fields,
      hasKey: Boolean(cr.key), source: sourceOf(cr), hint: hint(cr.key), unreadable: cr.unreadable && !cr.key, unreadableOverridden: cr.unreadable && Boolean(cr.key), configured: textConfigured(id, cr), keyOptional: Boolean(c.keyOptional)});
  }
  const pk = pollinationsKeyFrom(settings);
  list.push({id: 'pollinations', kind: 'media', name: 'Pollinations', usedFor: ['Images'], keyUrl: 'https://enter.pollinations.ai', free: true, keyOptional: true,
    fields: [{name: 'key', label: 'API key', secret: true}], hasKey: Boolean(pk.key), source: sourceOf(pk), hint: hint(pk.key), unreadable: pk.stored && !pk.saved && !pk.key, unreadableOverridden: pk.stored && !pk.saved && Boolean(pk.key), configured: true,
    note: 'Optional. Without a key the public (rate-limited) service is used; with a key, images use your Pollinations balance.'});
  const dk = mediaKeyFrom(settings, 'deepgram');
  list.push({id: 'deepgram', kind: 'media', name: 'Deepgram', usedFor: ['Narration check'], keyUrl: 'https://console.deepgram.com', free: false,
    fields: [{name: 'key', label: 'API key', secret: true}], hasKey: Boolean(dk.key), source: sourceOf(dk), hint: hint(dk.key), unreadable: dk.stored && !dk.saved && !dk.key, unreadableOverridden: dk.stored && !dk.saved && Boolean(dk.key), configured: Boolean(dk.key),
    note: 'Speech-to-text for the narration check (new accounts get free credit).'});
  const s = settings?.secrets || {};
  for (const [id, t] of Object.entries(TTS_KEYS)) {
    const savedKey = decryptSecret(s[t.secret]) || '';
    const envKey = envValue(t.env);
    const key = savedKey || envKey;
    const fields = [{name: 'key', label: 'API key', secret: true}];
    if (t.extra) fields.push({name: t.extra.name, label: t.extra.label, value: String(s[t.extra.secretField] || envValue(t.extra.env) || ''), fromEnv: !s[t.extra.secretField] && Boolean(envValue(t.extra.env)), placeholder: t.extra.placeholder});
    list.push({id, kind: 'tts', name: t.name, usedFor: ['elevenlabs', 'aiawaaz'].includes(id) ? ['Narration', 'Narration check'] : ['Narration'], keyUrl: t.keyUrl, free: id !== 'aiawaaz', fields,
      hasKey: Boolean(key), source: sourceOf({saved: Boolean(savedKey), fromEnv: !savedKey && Boolean(envKey)}), hint: hint(key),
      unreadable: Boolean(s[t.secret]) && !savedKey && !key, unreadableOverridden: Boolean(s[t.secret]) && !savedKey && Boolean(key), configured: Boolean(key) && (id !== 'azure' || Boolean(fields[1].value))});
  }
  return list;
}

// $set/$unset for the Pollinations key (the others reuse textKeyUpdate / saveTtsKeys).
export function mediaKeyUpdate(id, {key, clear} = {}) {
  if (clear) return {set: {}, unset: {[`secrets.mediaKeys.${id}`]: 1}};
  if (typeof key === 'string' && key.trim()) return {set: {[`secrets.mediaKeys.${id}`]: encryptSecret(cleanKey(key))}, unset: {}};
  return {set: {}, unset: {}};
}
export const pollinationsKeyUpdate = input => mediaKeyUpdate('pollinations', input);
