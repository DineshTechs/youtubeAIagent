import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'global' },
  // Encrypted provider keys entered in Settings (services/ai/ttsKeys.js). Never returned by the API.
  secrets: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // First provider of text.priority (kept for older code). Any script provider id.
  activeProvider: { type: String, default: 'gemini' },
  text: {
    // Model per script provider. Mixed so newly added providers (OpenRouter, Mistral,
    // NVIDIA…) are saved too; a fixed list silently dropped their model choices.
    models: { type: mongoose.Schema.Types.Mixed, default: () => ({ gemini: 'gemini-3.8-flash', groq: 'openai/gpt-oss-20b', cerebras: 'gpt-oss-120b', openai: 'gpt-5.1' }) },
    // Order in which script providers are tried; the next one is used when one fails.
    priority: { type: [String], default: undefined },
    fallbackEnabled: { type: Boolean, default: true },
    temperature: { type: Number, default: 0.7, min: 0, max: 2 },
    maxOutputTokens: { type: Number, default: 2600, min: 100, max: 20000 }
  },
  media: {
    imageProvider: { type: String, enum: ['openai', 'gemini', 'cloudflare', 'pollinations', 'mock'], default: 'openai' },
    imageModels: {
      gemini: { type: String, default: 'gemini-nano-banana-2.1' },
      openai: { type: String, default: 'gpt-image-2' },
      cloudflare: { type: String, default: '@cf/black-forest-labs/flux-1-schnell' },
      pollinations: { type: String, default: 'google/gemini-nano-banana-2.1' }
    },
    imageSizes: {
      gemini: { type: String, default: '1K' },
      openai: { type: String, default: '1024x1536' },
      cloudflare: { type: String, default: '1024x1536' },
      pollinations: { type: String, default: '1080x1920' }
    },
    imageSize: { type: String, default: '1K' },
    imageAspectRatio: { type: String, default: '9:16' },
    imageQuality: { type: String, enum: ['standard', 'high'], default: 'high' },
    ttsProvider: { type: String, enum: ['groq', 'openai', 'gemini', 'azure', 'google', 'elevenlabs', 'aiawaaz', 'mock'], default: 'groq' },
    ttsModels: {
      groq: { type: String, default: 'canopylabs/orpheus-v1-english' },
      openai: { type: String, default: 'gpt-4o-mini-tts' },
      gemini: { type: String, default: 'gemini-3.8-flash-tts' },
      azure: { type: String, default: 'neural' },
      google: { type: String, default: 'wavenet' },
      elevenlabs: { type: String, default: 'eleven_multilingual_v2' },
      aiawaaz: { type: String, default: 'mcp' }
    },
    ttsVoices: {
      groq: { type: String, default: 'hannah' },
      openai: { type: String, default: 'coral' },
      gemini: { type: String, default: 'Kore' },
      azure: { type: String, default: 'hi-IN-SwaraNeural' },
      google: { type: String, default: 'hi-IN-Wavenet-A' },
      elevenlabs: { type: String, default: 'JBFqnCBsd6RMkjVDRZzb' },
      aiawaaz: { type: String, default: '' }
    },
    generationEnabled: { type: Boolean, default: true },
    mockMode: { type: Boolean, default: false },
    pollinationsSafe: { type: Boolean, default: false },
    // Priority order (enabled providers) and whether to try the next one on failure.
    imagePriority: { type: [String], default: undefined },
    imageFallbackEnabled: { type: Boolean, default: true },
    ttsPriority: { type: [String], default: undefined },
    ttsFallbackEnabled: { type: Boolean, default: true },
    // Narration check after rendering, and its speech-to-text word check.
    narrationCheck: { type: Boolean, default: true },
    narrationCheckWords: { type: Boolean, default: true }
  },
  video: {
    width: { type: Number, default: 1080, min: 360, max: 2160 },
    height: { type: Number, default: 1920, min: 640, max: 3840 },
    fps: { type: Number, default: 30, min: 15, max: 60 },
    imageFit: { type: String, enum: ['contain-blur', 'cover', 'contain'], default: 'contain-blur' },
    subtitlesEnabled: { type: Boolean, default: true },
    subtitleFontSize: { type: Number, default: 38, min: 28, max: 48 },
    subtitleMarginV: { type: Number, default: 85, min: 35, max: 250 },
    subtitleFontName: { type: String, default: 'Nirmala UI' },
    // Where captions sit, and their distance from that edge in % of frame height.
    // 7% from the bottom matches the previous hard-coded placement.
    subtitlePosition: { type: String, enum: ['bottom', 'center', 'top'], default: 'bottom' },
    subtitleOffsetPct: { type: Number, default: 7, min: 2, max: 40 }
  },
  quality: {
    // Clean-image regenerations allowed after OCR reads text in a scene image.
    ocrMaxRetries: { type: Number, default: 2, min: 0, max: 3 }
  },
  retention: {
    autoDeleteEnabled: { type: Boolean, default: true },
    days: { type: Number, default: 30, min: 1, max: 3650 }
  },
  visualDirector: {
    enabled: { type: Boolean, default: true },
    realism: { type: Boolean, default: true },
    continuity: { type: Boolean, default: true },
    eyeCatching: { type: Boolean, default: true },
    avoidTextInImages: { type: Boolean, default: true }
  }
}, { timestamps: true, minimize: false });

export default mongoose.model('AISettings', schema);
