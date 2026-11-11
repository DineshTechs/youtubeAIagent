import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'global' },
  activeProvider: { type: String, enum: ['gemini', 'groq', 'cerebras', 'openai', 'mock'], default: 'gemini' },
  text: {
    models: {
      gemini: { type: String, default: 'gemini-3.8-flash' },
      groq: { type: String, default: 'openai/gpt-oss-20b' },
      cerebras: { type: String, default: 'gpt-oss-120b' },
      openai: { type: String, default: 'gpt-5.1' }
    },
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
    ttsProvider: { type: String, enum: ['groq', 'openai', 'gemini', 'mock'], default: 'groq' },
    ttsModels: {
      groq: { type: String, default: 'canopylabs/orpheus-v1-english' },
      openai: { type: String, default: 'gpt-4o-mini-tts' },
      gemini: { type: String, default: 'gemini-3.8-flash-tts' }
    },
    ttsVoices: {
      groq: { type: String, default: 'hannah' },
      openai: { type: String, default: 'coral' },
      gemini: { type: String, default: 'Kore' }
    },
    generationEnabled: { type: Boolean, default: true },
    mockMode: { type: Boolean, default: false },
    pollinationsSafe: { type: Boolean, default: false }
  },
  video: {
    width: { type: Number, default: 1080, min: 360, max: 2160 },
    height: { type: Number, default: 1920, min: 640, max: 3840 },
    fps: { type: Number, default: 30, min: 15, max: 60 },
    imageFit: { type: String, enum: ['contain-blur', 'cover', 'contain'], default: 'contain-blur' },
    subtitlesEnabled: { type: Boolean, default: true },
    subtitleFontSize: { type: Number, default: 38, min: 28, max: 48 },
    subtitleMarginV: { type: Number, default: 85, min: 35, max: 250 },
    subtitleFontName: { type: String, default: 'Nirmala UI' }
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
