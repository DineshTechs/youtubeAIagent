import { env } from '../../config/env.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import AISettings from '../../models/AISettings.js';
import { GeminiProvider } from './geminiProvider.js';
import { OpenAIProvider } from './openaiProvider.js';
import { MockAIProvider } from './mockProvider.js';
import { GroqProvider, CerebrasProvider, compatibleProvider, listCompatibleModels } from './openAICompatibleProvider.js';
import { resolvePriority, chainFor, createFallbackProvider } from './textChain.js';
import { TEXT_CATALOG, COMPATIBLE_PROVIDERS, textCredentialsFrom, textKeyStatus, textConfigured, applyTextKeysToEnv, textKeyUpdate } from './textKeys.js';
import { ttsCredentialsFrom, ttsKeyStatus, saveTtsKeys } from './ttsKeys.js';
import { keyList, keyKind, pollinationsKeyUpdate } from './keyCatalog.js';
import { checkCloudflare, checkGemini, checkOpenAI } from './keyChecks.js';
import { FREE_TTS_DEFAULTS } from '../media/freeTts.js';

export const PROVIDERS = ['gemini', 'groq', 'cerebras', ...COMPATIBLE_PROVIDERS, 'openai', 'mock'];
export const IMAGE_PROVIDERS = ['gemini', 'openai', 'cloudflare', 'pollinations', 'mock'];
export const TTS_PROVIDERS = ['groq', 'openai', 'gemini', 'azure', 'google', 'elevenlabs', 'aiawaaz', 'mock'];
// Languages each narration provider can speak well (shown in Settings; used for Hindi warnings).
export const TTS_HINDI = { groq: false, openai: true, gemini: true, azure: true, google: true, elevenlabs: true, aiawaaz: true, mock: false };

function defaults() {
  return {
    text: {
      models: { gemini: env.geminiTextModel, groq: env.groqTextModel, cerebras: env.cerebrasTextModel, openai: env.textModel, ...Object.fromEntries(COMPATIBLE_PROVIDERS.map(p => [p, TEXT_CATALOG[p].model])) },
      temperature: 0.7,
      maxOutputTokens: 2600
    },
    media: {
      imageModels: { gemini: env.geminiImageModel, openai: env.imageModel, cloudflare: env.cloudflareImageModel, pollinations: env.pollinationsImageModel },
      imageSizes: { gemini: env.geminiImageSize || '1K', openai: env.openaiImageSize || '1024x1536', cloudflare: '1024x1536', pollinations: '1080x1920' },
      imageSize: env.geminiImageSize || '1K',
      imageAspectRatio: '9:16',
      imageQuality: 'high',
      ttsModels: { groq: env.groqTtsModel, openai: env.openaiTtsModel, gemini: env.geminiTtsModel, azure: FREE_TTS_DEFAULTS.azure.model, google: FREE_TTS_DEFAULTS.google.model, elevenlabs: FREE_TTS_DEFAULTS.elevenlabs.model, aiawaaz: 'mcp' },
      ttsVoices: { groq: env.groqTtsVoice, openai: env.openaiTtsVoice, gemini: env.geminiTtsVoice, azure: FREE_TTS_DEFAULTS.azure.voice, google: FREE_TTS_DEFAULTS.google.voice, elevenlabs: FREE_TTS_DEFAULTS.elevenlabs.voice, aiawaaz: '' },
      generationEnabled: env.mediaGenerationEnabled,
      mockMode: env.mediaMock,
      pollinationsSafe: String(env.pollinationsSafe).toLowerCase() === 'true'
    },
    video: { width: 1080, height: 1920, fps: 30, imageFit: 'contain-blur', subtitlesEnabled: true, subtitleFontSize: 38, subtitleMarginV: 85, subtitleFontName: 'Nirmala UI', subtitlePosition: 'bottom', subtitleOffsetPct: 7 },
    quality: { ocrMaxRetries: 2 },
    retention: { autoDeleteEnabled: true, days: 30 },
    visualDirector: { enabled: true, realism: true, continuity: true, eyeCatching: true, avoidTextInImages: true }
  };
}

export function providerMeta(settings = null) {
  const models = { ...defaults().text.models, ...(settings?.text?.models || {}) };
  const keys = textKeyStatus(settings);
  const out = {};
  for (const id of PROVIDERS.filter(p => p !== 'mock')) out[id] = { ...keys[id], name: TEXT_CATALOG[id].name, model: models[id], configured: keys[id].configured, freeTier: TEXT_CATALOG[id].free };
  out.mock = { name: 'Mock / Development', model: 'local', configured: true, freeTier: true };
  return out;
}

function makeTextProvider(name, settings) {
  const model = settings.text?.models?.[name] || defaults().text.models[name];
  if (name === 'gemini') return new GeminiProvider(model, settings.text);
  if (name === 'groq') return new GroqProvider(model, settings.text);
  if (name === 'cerebras') return new CerebrasProvider(model, settings.text);
  if (name === 'openai') return new OpenAIProvider(model, settings.text);
  if (COMPATIBLE_PROVIDERS.includes(name)) {
    const cred = textCredentialsFrom(settings)[name];
    if (!textConfigured(name, cred)) throw new Error(`${TEXT_CATALOG[name].name} has no API key yet. Add it in Settings → AI providers.`);
    return compatibleProvider({ name: TEXT_CATALOG[name].name, apiKey: cred.key, baseUrl: cred.baseUrl, model, textSettings: settings.text });
  }
  if (name === 'mock') return new MockAIProvider();
  throw new Error(`Unsupported AI provider: ${name}`);
}

// Saves (or removes) a script provider's key from the dashboard.
export async function saveTextKey(provider, input = {}) {
  if (!PROVIDERS.includes(provider) || provider === 'mock') throw Object.assign(new Error(`Unknown script provider: ${provider}`), { status: 400 });
  const { set, unset } = textKeyUpdate(provider, input);
  const update = { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) };
  if (Object.keys(update).length) await AISettings.updateOne({ key: 'global' }, update, { upsert: true });
  let settings = await getGlobalSettings();
  // A provider that just got its key joins the end of the priority list.
  if (!input.clear && Array.isArray(settings.text?.priority) && settings.text.priority.length && !settings.text.priority.includes(provider) && providerMeta(settings)[provider]?.configured) {
    await AISettings.updateOne({ key: 'global' }, { $push: { 'text.priority': provider } });
    settings = await getGlobalSettings();
  }
  // Removing the key of the provider in use switches back to one that still works.
  if (input.clear && settings.activeProvider === provider && !providerMeta(settings)[provider].configured) {
    const fallback = PROVIDERS.find(p => p !== 'mock' && providerMeta(settings)[p].configured) || 'mock';
    await AISettings.updateOne({ key: 'global' }, { $set: { activeProvider: fallback } });
  }
  return getAISettings();
}

function mediaMeta(settings = null) {
  const d = defaults();
  const imageModels = settings?.media?.imageModels || d.media.imageModels;
  const ttsModels = settings?.media?.ttsModels || d.media.ttsModels;
  const ttsVoices = settings?.media?.ttsVoices || d.media.ttsVoices;
  const imageProvider = settings?.media?.imageProvider || env.imageProvider || 'openai';
  const ttsProvider = settings?.media?.ttsProvider || env.ttsProvider || 'groq';
  const creds = ttsCredentialsFrom(settings);
  const imageProviders = {
    gemini: { name: 'Gemini Image', model: imageModels.gemini, configured: Boolean(env.geminiKey), freeTier: false },
    openai: { name: 'OpenAI', model: imageModels.openai, configured: Boolean(env.openaiKey), freeTier: false },
    cloudflare: { name: 'Cloudflare Workers AI', model: imageModels.cloudflare, configured: Boolean(env.cloudflareAccountId && env.cloudflareApiToken), freeTier: true },
    pollinations: { name: 'Pollinations', model: imageModels.pollinations, configured: true, freeTier: true },
    mock: { name: 'Mock / Development', model: 'local', configured: true, freeTier: true }
  };
  const ttsProviders = {
    groq: { name: 'Groq Orpheus', model: ttsModels.groq, voice: ttsVoices.groq, configured: Boolean(env.groqKey), freeTier: true },
    openai: { name: 'OpenAI TTS', model: ttsModels.openai, voice: ttsVoices.openai, configured: Boolean(env.openaiKey), freeTier: false },
    gemini: { name: 'Gemini TTS', model: ttsModels.gemini, voice: ttsVoices.gemini, configured: Boolean(env.geminiKey), freeTier: true },
    azure: { name: 'Microsoft Azure Speech', model: 'Neural', voice: ttsVoices.azure, configured: Boolean(creds.azure.key && creds.azure.region), freeTier: true, freeNote: '0.5M characters free / month (F0)' },
    google: { name: 'Google Cloud TTS', model: 'WaveNet / Standard', voice: ttsVoices.google, configured: Boolean(creds.google.key), freeTier: true, freeNote: '4M WaveNet/Standard characters free / month (billing must be enabled)' },
    elevenlabs: { name: 'ElevenLabs', model: ttsModels.elevenlabs, voice: ttsVoices.elevenlabs, configured: Boolean(creds.elevenlabs.key), freeTier: true, freeNote: 'Free plan: ~10 min / month, non-commercial, attribution required' },
    aiawaaz: { name: 'AI Awaaz (MCP)', model: creds.aiawaaz.tool || 'auto-detected tool', voice: ttsVoices.aiawaaz || '', configured: Boolean(creds.aiawaaz.key), freeTier: false, freeNote: 'Indian-language voices via MCP; usage depends on your AI Awaaz plan' },
    mock: { name: 'Mock / Development', model: 'local', voice: 'local', configured: true, freeTier: true }
  };
  return {
    imageProvider,
    imageModel: imageProviders[imageProvider]?.model || imageModels.openai,
    imageConfigured: Boolean(imageProviders[imageProvider]?.configured),
    imageProviders,
    ttsProvider,
    ttsModel: ttsProviders[ttsProvider]?.model || ttsModels[ttsProvider] || ttsModels.groq,
    ttsVoice: ttsProviders[ttsProvider]?.voice || 'local',
    ttsConfigured: Boolean(ttsProviders[ttsProvider]?.configured),
    ttsProviders,
    ttsHindi: TTS_HINDI,
    ttsKeys: ttsKeyStatus(settings),
    imageSize: settings?.media?.imageSize || d.media.imageSize,
    imageAspectRatio: settings?.media?.imageAspectRatio || d.media.imageAspectRatio,
    imageQuality: settings?.media?.imageQuality || d.media.imageQuality,
    imageSizes: settings?.media?.imageSizes || d.media.imageSizes,
    imageModels,
    ttsModels,
    ttsVoices,
    generationEnabled: settings?.media?.generationEnabled ?? d.media.generationEnabled,
    mockMode: settings?.media?.mockMode ?? d.media.mockMode,
    pollinationsSafe: settings?.media?.pollinationsSafe ?? d.media.pollinationsSafe,
    narrationCheck: settings?.media?.narrationCheck !== false,
    narrationCheckWords: settings?.media?.narrationCheckWords !== false
  };
}

async function getGlobalSettings() {
  const d = defaults();
  let settings = await AISettings.findOne({ key: 'global' });
  if (!settings) {
    settings = await AISettings.create({ key: 'global', activeProvider: env.aiProvider || 'gemini', text: d.text, media: { ...d.media, imageProvider: env.imageProvider || 'openai', ttsProvider: env.ttsProvider || 'groq' }, video: d.video, retention: d.retention, visualDirector: d.visualDirector });
  } else {
    let changed = false;
    const patch = {};
    if (!settings.text?.models?.gemini) { patch['text.models.gemini'] = d.text.models.gemini; changed = true; }
    if (!settings.text?.models?.groq) { patch['text.models.groq'] = d.text.models.groq; changed = true; }
    if (!settings.text?.models?.cerebras) { patch['text.models.cerebras'] = d.text.models.cerebras; changed = true; }
    if (!settings.text?.models?.openai) { patch['text.models.openai'] = d.text.models.openai; changed = true; }
    for (const p of COMPATIBLE_PROVIDERS) if (!settings.text?.models?.[p]) { patch[`text.models.${p}`] = d.text.models[p]; changed = true; }
    for (const [k,v] of Object.entries(d.media.imageModels)) if (!settings.media?.imageModels?.[k]) { patch[`media.imageModels.${k}`]=v; changed=true; }
    for (const [k,v] of Object.entries(d.media.ttsModels)) if (!settings.media?.ttsModels?.[k]) { patch[`media.ttsModels.${k}`]=v; changed=true; }
    for (const [k,v] of Object.entries(d.media.ttsVoices)) if (!settings.media?.ttsVoices?.[k]) { patch[`media.ttsVoices.${k}`]=v; changed=true; }
    if (settings.media?.imageSize == null) { patch['media.imageSize']=d.media.imageSize; changed=true; }
    for (const [k,v] of Object.entries(d.media.imageSizes)) if (!settings.media?.imageSizes?.[k]) { patch[`media.imageSizes.${k}`]=v; changed=true; }
    if (settings.media?.imageAspectRatio == null) { patch['media.imageAspectRatio']=d.media.imageAspectRatio; changed=true; }
    if (settings.media?.imageQuality == null) { patch['media.imageQuality']=d.media.imageQuality; changed=true; }
    if (settings.media?.generationEnabled == null) { patch['media.generationEnabled']=d.media.generationEnabled; changed=true; }
    if (settings.media?.mockMode == null) { patch['media.mockMode']=d.media.mockMode; changed=true; }
    if (settings.media?.pollinationsSafe == null) { patch['media.pollinationsSafe']=d.media.pollinationsSafe; changed=true; }
    if (!settings.video?.width) { patch['video.width']=1080; patch['video.height']=1920; patch['video.fps']=30; patch['video.imageFit']='contain-blur'; changed=true; }
    if (settings.retention?.autoDeleteEnabled == null) { patch['retention.autoDeleteEnabled']=true; changed=true; }
    if (!settings.retention?.days) { patch['retention.days']=30; changed=true; }
    if (changed) settings = await AISettings.findOneAndUpdate({key:'global'},{$set:patch},{new:true});
  }
  applyTextKeysToEnv(settings);
  return settings;
}

function priorityOf(settings) {
  const meta = providerMeta(settings);
  const order = resolvePriority({ priority: settings.text?.priority, activeProvider: settings.activeProvider, ids: PROVIDERS, configured: p => meta[p]?.configured, autoInclude: p => meta[p]?.freeTier });
  return { order, fallbackEnabled: settings.text?.fallbackEnabled !== false, meta };
}
// The script AI: providers in the user's priority order, each tried when the one
// before it fails.
export async function getActiveProvider() {
  const settings = await getGlobalSettings();
  const { order, fallbackEnabled, meta } = priorityOf(settings);
  const chain = chainFor({ order, fallbackEnabled, configured: p => meta[p]?.configured });
  if (!chain.length) return makeTextProvider(settings.activeProvider, settings);   // gives the "add a key" error
  return createFallbackProvider(chain.map(id => ({ id, name: meta[id].name, make: () => makeTextProvider(id, settings) })));
}

// Saves the priority order (enabled providers, first = main) and whether to fall back.
export async function setTextPriority({ order, fallbackEnabled } = {}) {
  const set = {};
  if (Array.isArray(order)) {
    const clean = order.map(String).filter((p, i, a) => PROVIDERS.includes(p) && a.indexOf(p) === i);
    if (!clean.length) throw Object.assign(new Error('Keep at least one script provider switched on.'), { status: 400 });
    set['text.priority'] = clean;
    const meta = providerMeta(await getGlobalSettings());
    set.activeProvider = clean.find(p => meta[p]?.configured) || clean[0];
  }
  if (typeof fallbackEnabled === 'boolean') set['text.fallbackEnabled'] = fallbackEnabled;
  if (Object.keys(set).length) await AISettings.updateOne({ key: 'global' }, { $set: set }, { upsert: true });
  return getAISettings();
}

// Lets one call use a backup image / narration provider: getMediaSettings() inside
// mediaOverride.run({imageProvider:'pollinations'}, fn) answers for that provider.
export const mediaOverride = new AsyncLocalStorage();
export async function getMediaSettings() {
  const settings = await getGlobalSettings();
  const media = { ...((typeof settings.toObject === 'function' ? settings.toObject().media : settings.media) || {}), ...(mediaOverride.getStore() || {}) };
  return {
    imageProvider: media.imageProvider || env.imageProvider || 'openai',
    imageModel: media.imageModels?.[media.imageProvider] || defaults().media.imageModels.openai,
    imageModels: media.imageModels || defaults().media.imageModels,
    imageSize: media.imageSizes?.[media.imageProvider] || media.imageSize || defaults().media.imageSizes[media.imageProvider] || '1K',
    imageSizes: media.imageSizes || defaults().media.imageSizes,
    imageAspectRatio: media.imageAspectRatio || '9:16',
    imageQuality: media.imageQuality || 'high',
    ttsProvider: media.ttsProvider || env.ttsProvider || 'groq',
    ttsModel: media.ttsModels?.[media.ttsProvider] || defaults().media.ttsModels[media.ttsProvider] || defaults().media.ttsModels.groq,
    ttsModels: media.ttsModels || defaults().media.ttsModels,
    // An empty voice is allowed (AI Awaaz then uses its own default); never borrow another provider's voice.
    ttsVoice: (p => media.ttsVoices?.[p] || (p in defaults().media.ttsVoices ? defaults().media.ttsVoices[p] : defaults().media.ttsVoices.groq) || '')(media.ttsProvider || env.ttsProvider || 'groq'),
    ttsVoices: media.ttsVoices || defaults().media.ttsVoices,
    generationEnabled: media.generationEnabled ?? env.mediaGenerationEnabled,
    mockMode: media.mockMode ?? env.mediaMock,
    pollinationsSafe: media.pollinationsSafe ?? (String(env.pollinationsSafe).toLowerCase()==='true'),
    narrationCheck: media.narrationCheck !== false,
    narrationCheckWords: media.narrationCheckWords !== false
  };
}

export async function getAISettings() {
  const settings = await getGlobalSettings();
  const media = mediaMeta(settings);
  return {
    activeProvider: (({ order, fallbackEnabled, meta }) => chainFor({ order, fallbackEnabled, configured: p => meta[p]?.configured })[0])(priorityOf(settings)) || settings.activeProvider,
    providers: providerMeta(settings),
    textPriority: (({ order, fallbackEnabled }) => ({ order, fallbackEnabled }))(priorityOf(settings)),
    imagePriority: (({ order, fallbackEnabled }) => ({ order, fallbackEnabled }))(mediaPriorityOf(settings, 'image')),
    ttsPriority: (({ order, fallbackEnabled }) => ({ order, fallbackEnabled }))(mediaPriorityOf(settings, 'tts')),
    media,
    text: settings.text,
    video: settings.video,
    retention: settings.retention || {autoDeleteEnabled:true,days:30},
    quality: { ocrMaxRetries: Number.isFinite(Number(settings.quality?.ocrMaxRetries)) ? Number(settings.quality.ocrMaxRetries) : 2 },
    visualDirector: settings.visualDirector
  };
}

export async function setActiveProvider(name) {
  if (!PROVIDERS.includes(name)) throw new Error(`Unsupported AI provider: ${name}`);
  const settings = await getGlobalSettings();
  const meta = providerMeta(settings)[name];
  if (!meta?.configured) throw new Error(`${meta?.name || name} has no API key yet. Add it in Settings → AI providers.`);
  const { order } = priorityOf(settings);
  await AISettings.updateOne({key:'global'},{$set:{activeProvider:name,'text.priority':[name,...order.filter(p=>p!==name)]}},{upsert:true});
  return getAISettings();
}

export async function updateAIConfig(patch = {}) {
  const settings = await getGlobalSettings();
  const allowed = {};
  if (patch.text?.models) for (const p of PROVIDERS.filter(x=>x!=='mock')) if (typeof patch.text.models[p] === 'string' && patch.text.models[p].trim()) allowed[`text.models.${p}`]=patch.text.models[p].trim();
  if (patch.text?.temperature != null) allowed['text.temperature']=Math.max(0,Math.min(2,Number(patch.text.temperature)));
  if (patch.text?.maxOutputTokens != null) allowed['text.maxOutputTokens']=Math.max(100,Math.min(20000,Number(patch.text.maxOutputTokens)));
  if (patch.media?.imageModels) for (const p of ['gemini','openai','cloudflare','pollinations']) if (typeof patch.media.imageModels[p]==='string' && patch.media.imageModels[p].trim()) allowed[`media.imageModels.${p}`]=patch.media.imageModels[p].trim();
  if (patch.media?.imageSize) allowed['media.imageSize']=String(patch.media.imageSize);
  if (patch.media?.imageSizes) for (const p of IMAGE_PROVIDERS.filter(x=>x!=='mock')) if (typeof patch.media.imageSizes[p] === 'string' && patch.media.imageSizes[p].trim()) allowed[`media.imageSizes.${p}`]=patch.media.imageSizes[p].trim();
  if (patch.media?.imageAspectRatio) allowed['media.imageAspectRatio']=String(patch.media.imageAspectRatio);
  if (patch.media?.imageQuality) allowed['media.imageQuality']=patch.media.imageQuality;
  if (patch.media?.ttsModels) for (const p of TTS_PROVIDERS.filter(x=>x!=='mock')) if (typeof patch.media.ttsModels[p]==='string' && patch.media.ttsModels[p].trim()) allowed[`media.ttsModels.${p}`]=patch.media.ttsModels[p].trim();
  if (patch.media?.ttsVoices) for (const p of TTS_PROVIDERS.filter(x=>x!=='mock')) if (typeof patch.media.ttsVoices[p]==='string') allowed[`media.ttsVoices.${p}`]=patch.media.ttsVoices[p].trim(); // '' = provider default
  for (const k of ['generationEnabled','mockMode','pollinationsSafe','narrationCheck','narrationCheckWords']) if (patch.media?.[k] != null) allowed[`media.${k}`]=Boolean(patch.media[k]);
  if (patch.video) {
    for (const k of ['width','height','fps','imageFit']) if (patch.video[k] != null) allowed[`video.${k}`]=patch.video[k];
    if (patch.video.subtitlesEnabled != null) allowed['video.subtitlesEnabled']=Boolean(patch.video.subtitlesEnabled);
    if (patch.video.subtitleFontSize != null) allowed['video.subtitleFontSize']=Math.max(28,Math.min(48,Number(patch.video.subtitleFontSize)));
    if (patch.video.subtitleMarginV != null) allowed['video.subtitleMarginV']=Math.max(35,Math.min(250,Number(patch.video.subtitleMarginV)));
    if (typeof patch.video.subtitleFontName === 'string' && patch.video.subtitleFontName.trim()) allowed['video.subtitleFontName']=patch.video.subtitleFontName.trim().replace(/[,:'"\\]/g,'').slice(0,80);
    if (['bottom','center','top'].includes(patch.video.subtitlePosition)) allowed['video.subtitlePosition']=patch.video.subtitlePosition;
    if (patch.video.subtitleOffsetPct != null && Number.isFinite(Number(patch.video.subtitleOffsetPct))) allowed['video.subtitleOffsetPct']=Math.max(2,Math.min(40,Number(patch.video.subtitleOffsetPct)));
  }
  if (patch.quality?.ocrMaxRetries != null && Number.isFinite(Number(patch.quality.ocrMaxRetries))) allowed['quality.ocrMaxRetries']=Math.max(0,Math.min(3,Math.round(Number(patch.quality.ocrMaxRetries))));
  if (patch.retention) {
    if (patch.retention.autoDeleteEnabled != null) allowed['retention.autoDeleteEnabled']=Boolean(patch.retention.autoDeleteEnabled);
    if (patch.retention.days != null) allowed['retention.days']=Math.max(1,Math.min(3650,Number(patch.retention.days)));
  }
  if (patch.visualDirector) for (const k of ['enabled','realism','continuity','eyeCatching','avoidTextInImages']) if (patch.visualDirector[k] != null) allowed[`visualDirector.${k}`]=Boolean(patch.visualDirector[k]);
  if (!Object.keys(allowed).length) return getAISettings();
  await AISettings.updateOne({key:'global'},{$set:allowed},{upsert:true});
  return getAISettings();
}

export async function setMediaProvider(type, provider) {
  const allowed = type === 'image' ? IMAGE_PROVIDERS : type === 'tts' ? TTS_PROVIDERS : [];
  if (!allowed.includes(provider)) throw new Error(`Unsupported ${type} provider: ${provider}`);
  const configured = type === 'image'
    ? provider === 'mock' || (provider === 'gemini' && Boolean(env.geminiKey)) || (provider === 'openai' && Boolean(env.openaiKey)) || (provider === 'cloudflare' && Boolean(env.cloudflareAccountId && env.cloudflareApiToken)) || provider === 'pollinations'
    : provider === 'mock' || (provider === 'groq' && Boolean(env.groqKey)) || (provider === 'openai' && Boolean(env.openaiKey)) || (provider === 'gemini' && Boolean(env.geminiKey)) || (['azure','google','elevenlabs','aiawaaz'].includes(provider) && mediaMeta(await getGlobalSettings()).ttsProviders[provider].configured);
  if (!configured) throw new Error(`${provider} is not configured. Add its API key ${['azure','google','elevenlabs','aiawaaz'].includes(provider)?'in Settings → Narration':'in the server environment'} first.`);
  const field = type === 'image' ? 'media.imageProvider' : 'media.ttsProvider';
  const { order } = mediaPriorityOf(await getGlobalSettings(), type);
  await AISettings.updateOne({key:'global'},{$set:{[field]:provider,[type === 'image' ? 'media.imagePriority' : 'media.ttsPriority']:[provider,...order.filter(p=>p!==provider)]}},{upsert:true});
  return getAISettings();
}

export async function testMediaProvider(type, provider) {
  if (type === 'image') {
    if (!IMAGE_PROVIDERS.includes(provider)) throw new Error(`Unsupported image provider: ${provider}`);
    if (provider === 'mock') return {ok:true,message:'Mock image provider is ready.'};
    await getGlobalSettings();
    // Real sign-in checks (no image is made), so a wrong key shows up here, not mid-video.
    if (provider === 'gemini') return checkGemini(env.geminiKey);
    if (provider === 'openai') return checkOpenAI(env.openaiKey);
    if (provider === 'cloudflare') return checkCloudflare({ token: env.cloudflareApiToken, accountId: env.cloudflareAccountId });
    if (provider === 'pollinations') return {ok:true,message:env.pollinationsKey?'Pollinations API key is configured.':'Pollinations public endpoint will be used (may be rate-limited).'};
    return {ok:true,message:`${provider} credentials are configured.`};
  }
  if (!TTS_PROVIDERS.includes(provider)) throw new Error(`Unsupported TTS provider: ${provider}`);
  if (provider==='mock') return {ok:true,message:'Mock narration provider is ready.'};
  if (provider==='groq'&&!env.groqKey) throw new Error('GROQ_API_KEY is not configured.');
  if (provider==='openai'&&!env.openaiKey) throw new Error('OPENAI_API_KEY is not configured.');
  if (provider==='gemini'&&!env.geminiKey) throw new Error('GEMINI_API_KEY is not configured for Gemini TTS.');
  if (provider === 'aiawaaz') {
    const { mcpSynthesize } = await import('../media/mcpTts.js');
    const settings = await getGlobalSettings();
    const c = ttsCredentialsFrom(settings).aiawaaz;
    const audio = await mcpSynthesize({ url: c.url, apiKey: c.key, tool: c.tool, enhance: c.enhance, voice: settings.media?.ttsVoices?.aiawaaz || '', language: 'hi', text: 'नमस्ते, यह एक परीक्षण है।' });
    if (audio.length < 1000) throw new Error('AI Awaaz returned too little audio.');
    return {ok:true,message:`AI Awaaz works: ${Math.round(audio.length/1024)} KB of Hindi audio.`};
  }
  if (['azure','google','elevenlabs'].includes(provider)) {
    // Real test: synthesize a short Hindi sentence with the configured voice.
    const { synthesizeFree } = await import('../media/freeTts.js');
    const settings = await getGlobalSettings();
    const creds = ttsCredentialsFrom(settings)[provider];
    const voice = settings.media?.ttsVoices?.[provider] || FREE_TTS_DEFAULTS[provider].voice;
    const audio = await synthesizeFree(provider, { creds, voice, model: settings.media?.ttsModels?.[provider], text: 'नमस्ते, यह एक परीक्षण है।' });
    if (audio.length < 1000) throw new Error(`${provider} returned too little audio.`);
    return {ok:true,message:`${provider} works: ${Math.round(audio.length/1024)} KB of Hindi audio with voice ${voice}.`};
  }
  return {ok:true,message:`${provider} narration credentials are configured.`};
}

// Every API key in one list (Settings → AI providers → API keys), and one way to replace any of them.
export async function listKeys() { return { keys: keyList(await getGlobalSettings()) }; }
export async function saveKey(id, input = {}) {
  const kind = keyKind(id);
  if (!kind) throw Object.assign(new Error(`Unknown key: ${id}`), { status: 400 });
  const clear = input.clear === true;
  if (kind === 'text') await saveTextKey(id, { key: input.key, clear, accountId: input.accountId, baseUrl: input.baseUrl });
  else if (kind === 'tts') await saveTtsKeys({ [id]: clear ? { clear: true } : { key: input.key, ...(typeof input.region === 'string' ? { region: input.region } : {}), ...(typeof input.url === 'string' ? { url: input.url } : {}) } });
  else {
    const { set, unset } = pollinationsKeyUpdate({ key: input.key, clear });
    const update = { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) };
    if (Object.keys(update).length) await AISettings.updateOne({ key: 'global' }, update, { upsert: true });
  }
  return { ...(await listKeys()), settings: await getAISettings() };
}

export async function testProvider(name) {
  if (!PROVIDERS.includes(name)) throw new Error(`Unsupported AI provider: ${name}`);
  const settings = await getGlobalSettings();
  const provider = makeTextProvider(name, settings);
  if (typeof provider.testConnection==='function') {
    try { return await provider.testConnection(); }
    catch (e) {
      // Cloudflare's "Authentication error" doesn't say whether the token or the account ID is wrong.
      if (name === 'cloudflare' && /\b(400|401|403)\b/.test(String(e.message))) { const c = textCredentialsFrom(settings).cloudflare; await checkCloudflare({ token: c.key, accountId: c.accountId }); }
      throw e;
    }
  }
  return {ok:true,message:'Mock provider is ready.'};
}

// Models a script provider offers to the saved key (Settings → "Load models").
const LIST_URLS = { gemini: 'https://generativelanguage.googleapis.com/v1beta/openai', groq: 'https://api.groq.com/openai/v1', cerebras: 'https://api.cerebras.ai/v1', openai: 'https://api.openai.com/v1' };
export async function listTextModels(name) {
  if (!PROVIDERS.includes(name) || name === 'mock') throw Object.assign(new Error(`Unknown script provider: ${name}`), { status: 400 });
  const settings = await getGlobalSettings();
  const cred = textCredentialsFrom(settings)[name];
  if (!textConfigured(name, cred) && !LIST_URLS[name]) throw Object.assign(new Error(`Save the ${TEXT_CATALOG[name].name} key first.`), { status: 400 });
  if (!cred.key && !TEXT_CATALOG[name].keyOptional) throw Object.assign(new Error(`Save the ${TEXT_CATALOG[name].name} key first.`), { status: 400 });
  if (name === 'cloudflare') {
    // Cloudflare lists its text models through its own search API.
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cred.accountId)}/ai/models/search?task=Text%20Generation&per_page=100`, { headers: { Authorization: `Bearer ${cred.key}` }, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Could not load Cloudflare models (${r.status}): ${JSON.stringify(j.errors || j).slice(0, 300)}`);
    return { models: (j.result || []).map(m => m.name).filter(Boolean).sort(), current: settings.text?.models?.[name] || defaults().text.models[name] };
  }
  const models = await listCompatibleModels({ baseUrl: LIST_URLS[name] || cred.baseUrl, apiKey: cred.key });
  return { models: name === 'gemini' ? models.map(m => m.replace(/^models\//, '')) : models, current: settings.text?.models?.[name] || defaults().text.models[name] };
}

// ---- Image / narration priority (Settings → Images / Narration) ----
function mediaPriorityOf(settings, type) {
  const meta = mediaMeta(settings);
  const providers = type === 'image' ? meta.imageProviders : meta.ttsProviders;
  const ids = type === 'image' ? IMAGE_PROVIDERS : TTS_PROVIDERS;
  const media = settings.media || {};
  // Automatic backups: free providers only, and for narration only voices that speak Hindi.
  const order = resolvePriority({ priority: type === 'image' ? media.imagePriority : media.ttsPriority, activeProvider: type === 'image' ? meta.imageProvider : meta.ttsProvider, ids, configured: p => providers[p]?.configured, autoInclude: p => providers[p]?.freeTier && (type === 'image' || TTS_HINDI[p]) });
  const fallbackEnabled = (type === 'image' ? media.imageFallbackEnabled : media.ttsFallbackEnabled) !== false;
  return { order, fallbackEnabled, chain: chainFor({ order, fallbackEnabled, configured: p => providers[p]?.configured }), providers };
}
// Providers a job tries, in order (first = main).
export async function mediaChain(type) {
  const p = mediaPriorityOf(await getGlobalSettings(), type);
  return p.chain.map(id => ({ id, name: p.providers[id].name }));
}
export async function setMediaPriority(type, { order, fallbackEnabled } = {}) {
  if (!['image', 'tts'].includes(type)) throw Object.assign(new Error('type must be image or tts'), { status: 400 });
  const ids = type === 'image' ? IMAGE_PROVIDERS : TTS_PROVIDERS;
  const key = type === 'image' ? 'image' : 'tts';
  const set = {};
  if (Array.isArray(order)) {
    const clean = order.map(String).filter((p, i, a) => ids.includes(p) && a.indexOf(p) === i);
    if (!clean.length) throw Object.assign(new Error('Keep at least one provider switched on.'), { status: 400 });
    set[`media.${key}Priority`] = clean;
    const meta = mediaMeta(await getGlobalSettings());
    const providers = type === 'image' ? meta.imageProviders : meta.ttsProviders;
    set[`media.${key}Provider`] = clean.find(p => providers[p]?.configured) || clean[0];
  }
  if (typeof fallbackEnabled === 'boolean') set[`media.${key}FallbackEnabled`] = fallbackEnabled;
  if (Object.keys(set).length) await AISettings.updateOne({ key: 'global' }, { $set: set }, { upsert: true });
  return getAISettings();
}
