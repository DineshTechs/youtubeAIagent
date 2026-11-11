import { env } from '../../config/env.js';
import AISettings from '../../models/AISettings.js';
import { GeminiProvider } from './geminiProvider.js';
import { OpenAIProvider } from './openaiProvider.js';
import { MockAIProvider } from './mockProvider.js';
import { GroqProvider, CerebrasProvider } from './openAICompatibleProvider.js';

export const PROVIDERS = ['gemini', 'groq', 'cerebras', 'openai', 'mock'];
export const IMAGE_PROVIDERS = ['gemini', 'openai', 'cloudflare', 'pollinations', 'mock'];
export const TTS_PROVIDERS = ['groq', 'openai', 'gemini', 'mock'];

function defaults() {
  return {
    text: {
      models: { gemini: env.geminiTextModel, groq: env.groqTextModel, cerebras: env.cerebrasTextModel, openai: env.textModel },
      temperature: 0.7,
      maxOutputTokens: 2600
    },
    media: {
      imageModels: { gemini: env.geminiImageModel, openai: env.imageModel, cloudflare: env.cloudflareImageModel, pollinations: env.pollinationsImageModel },
      imageSizes: { gemini: env.geminiImageSize || '1K', openai: env.openaiImageSize || '1024x1536', cloudflare: '1024x1536', pollinations: '1080x1920' },
      imageSize: env.geminiImageSize || '1K',
      imageAspectRatio: '9:16',
      imageQuality: 'high',
      ttsModels: { groq: env.groqTtsModel, openai: env.openaiTtsModel, gemini: env.geminiTtsModel },
      ttsVoices: { groq: env.groqTtsVoice, openai: env.openaiTtsVoice, gemini: env.geminiTtsVoice },
      generationEnabled: env.mediaGenerationEnabled,
      mockMode: env.mediaMock,
      pollinationsSafe: String(env.pollinationsSafe).toLowerCase() === 'true'
    },
    video: { width: 1080, height: 1920, fps: 30, imageFit: 'contain-blur', subtitlesEnabled: true, subtitleFontSize: 38, subtitleMarginV: 85, subtitleFontName: 'Nirmala UI' },
    retention: { autoDeleteEnabled: true, days: 30 },
    visualDirector: { enabled: true, realism: true, continuity: true, eyeCatching: true, avoidTextInImages: true }
  };
}

export function providerMeta(settings = null) {
  const models = settings?.text?.models || defaults().text.models;
  return {
    gemini: { name: 'Gemini', model: models.gemini, configured: Boolean(env.geminiKey), freeTier: true },
    groq: { name: 'Groq', model: models.groq, configured: Boolean(env.groqKey), freeTier: true },
    cerebras: { name: 'Cerebras', model: models.cerebras, configured: Boolean(env.cerebrasKey), freeTier: false },
    openai: { name: 'OpenAI', model: models.openai, configured: Boolean(env.openaiKey), freeTier: false },
    mock: { name: 'Mock / Development', model: 'local', configured: true, freeTier: true }
  };
}

function mediaMeta(settings = null) {
  const d = defaults();
  const imageModels = settings?.media?.imageModels || d.media.imageModels;
  const ttsModels = settings?.media?.ttsModels || d.media.ttsModels;
  const ttsVoices = settings?.media?.ttsVoices || d.media.ttsVoices;
  const imageProvider = settings?.media?.imageProvider || env.imageProvider || 'openai';
  const ttsProvider = settings?.media?.ttsProvider || env.ttsProvider || 'groq';
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
    imageSize: settings?.media?.imageSize || d.media.imageSize,
    imageAspectRatio: settings?.media?.imageAspectRatio || d.media.imageAspectRatio,
    imageQuality: settings?.media?.imageQuality || d.media.imageQuality,
    imageSizes: settings?.media?.imageSizes || d.media.imageSizes,
    imageModels,
    ttsModels,
    ttsVoices,
    generationEnabled: settings?.media?.generationEnabled ?? d.media.generationEnabled,
    mockMode: settings?.media?.mockMode ?? d.media.mockMode,
    pollinationsSafe: settings?.media?.pollinationsSafe ?? d.media.pollinationsSafe
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
  return settings;
}

export async function getActiveProvider() {
  const settings = await getGlobalSettings();
  const model = settings.text?.models?.[settings.activeProvider];
  switch (settings.activeProvider) {
    case 'gemini': return new GeminiProvider(model, settings.text);
    case 'groq': return new GroqProvider(model, settings.text);
    case 'cerebras': return new CerebrasProvider(model, settings.text);
    case 'openai': return new OpenAIProvider(model, settings.text);
    case 'mock': return new MockAIProvider();
    default: throw new Error(`Unsupported AI provider: ${settings.activeProvider}`);
  }
}

export async function getMediaSettings() {
  const settings = await getGlobalSettings();
  const media = settings.media || {};
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
    ttsVoice: media.ttsVoices?.[media.ttsProvider] || defaults().media.ttsVoices[media.ttsProvider] || defaults().media.ttsVoices.groq,
    ttsVoices: media.ttsVoices || defaults().media.ttsVoices,
    generationEnabled: media.generationEnabled ?? env.mediaGenerationEnabled,
    mockMode: media.mockMode ?? env.mediaMock,
    pollinationsSafe: media.pollinationsSafe ?? (String(env.pollinationsSafe).toLowerCase()==='true')
  };
}

export async function getAISettings() {
  const settings = await getGlobalSettings();
  const media = mediaMeta(settings);
  return {
    activeProvider: settings.activeProvider,
    providers: providerMeta(settings),
    media,
    text: settings.text,
    video: settings.video,
    retention: settings.retention || {autoDeleteEnabled:true,days:30},
    visualDirector: settings.visualDirector
  };
}

export async function setActiveProvider(name) {
  if (!PROVIDERS.includes(name)) throw new Error(`Unsupported AI provider: ${name}`);
  const settings = await getGlobalSettings();
  const meta = providerMeta(settings)[name];
  if (!meta?.configured) throw new Error(`${meta?.name || name} is not configured. Add its API key on the server first.`);
  await AISettings.updateOne({key:'global'},{$set:{activeProvider:name}},{upsert:true});
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
  if (patch.media?.ttsModels) for (const p of ['groq','openai','gemini']) if (typeof patch.media.ttsModels[p]==='string' && patch.media.ttsModels[p].trim()) allowed[`media.ttsModels.${p}`]=patch.media.ttsModels[p].trim();
  if (patch.media?.ttsVoices) for (const p of ['groq','openai','gemini']) if (typeof patch.media.ttsVoices[p]==='string' && patch.media.ttsVoices[p].trim()) allowed[`media.ttsVoices.${p}`]=patch.media.ttsVoices[p].trim();
  for (const k of ['generationEnabled','mockMode','pollinationsSafe']) if (patch.media?.[k] != null) allowed[`media.${k}`]=Boolean(patch.media[k]);
  if (patch.video) {
    for (const k of ['width','height','fps','imageFit']) if (patch.video[k] != null) allowed[`video.${k}`]=patch.video[k];
    if (patch.video.subtitlesEnabled != null) allowed['video.subtitlesEnabled']=Boolean(patch.video.subtitlesEnabled);
    if (patch.video.subtitleFontSize != null) allowed['video.subtitleFontSize']=Math.max(28,Math.min(48,Number(patch.video.subtitleFontSize)));
    if (patch.video.subtitleMarginV != null) allowed['video.subtitleMarginV']=Math.max(35,Math.min(250,Number(patch.video.subtitleMarginV)));
    if (typeof patch.video.subtitleFontName === 'string' && patch.video.subtitleFontName.trim()) allowed['video.subtitleFontName']=patch.video.subtitleFontName.trim().slice(0,80);
  }
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
    : provider === 'mock' || (provider === 'groq' && Boolean(env.groqKey)) || (provider === 'openai' && Boolean(env.openaiKey)) || (provider === 'gemini' && Boolean(env.geminiKey));
  if (!configured) throw new Error(`${provider} is not configured. Add its API key in the server environment first.`);
  const field = type === 'image' ? 'media.imageProvider' : 'media.ttsProvider';
  await AISettings.updateOne({key:'global'},{$set:{[field]:provider}},{upsert:true});
  return getAISettings();
}

export async function testMediaProvider(type, provider) {
  if (type === 'image') {
    if (!IMAGE_PROVIDERS.includes(provider)) throw new Error(`Unsupported image provider: ${provider}`);
    if (provider === 'mock') return {ok:true,message:'Mock image provider is ready.'};
    if (provider === 'gemini'&&!env.geminiKey) throw new Error('GEMINI_API_KEY is not configured.');
    if (provider === 'openai'&&!env.openaiKey) throw new Error('OPENAI_API_KEY is not configured.');
    if (provider === 'cloudflare'&&!(env.cloudflareAccountId&&env.cloudflareApiToken)) throw new Error('Cloudflare credentials are not configured.');
    if (provider === 'pollinations') return {ok:true,message:env.pollinationsKey?'Pollinations API key is configured.':'Pollinations public endpoint will be used (may be rate-limited).'};
    return {ok:true,message:`${provider} credentials are configured.`};
  }
  if (!TTS_PROVIDERS.includes(provider)) throw new Error(`Unsupported TTS provider: ${provider}`);
  if (provider==='mock') return {ok:true,message:'Mock narration provider is ready.'};
  if (provider==='groq'&&!env.groqKey) throw new Error('GROQ_API_KEY is not configured.');
  if (provider==='openai'&&!env.openaiKey) throw new Error('OPENAI_API_KEY is not configured.');
  if (provider==='gemini'&&!env.geminiKey) throw new Error('GEMINI_API_KEY is not configured for Gemini TTS.');
  return {ok:true,message:`${provider} narration credentials are configured.`};
}

export async function testProvider(name) {
  if (!PROVIDERS.includes(name)) throw new Error(`Unsupported AI provider: ${name}`);
  const provider = await (async()=>{const settings=await getGlobalSettings(); const model=settings.text?.models?.[name]; if(name==='gemini')return new GeminiProvider(model, settings.text); if(name==='groq')return new GroqProvider(model, settings.text); if(name==='cerebras')return new CerebrasProvider(model, settings.text); if(name==='openai')return new OpenAIProvider(model, settings.text); return new MockAIProvider();})();
  if (typeof provider.testConnection==='function') return provider.testConnection();
  return {ok:true,message:'Mock provider is ready.'};
}
