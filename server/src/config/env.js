import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load environment variables reliably regardless of whether Node is started
// from the project root, the server directory, or another working directory.
// Existing process.env values are preserved.
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '../..');
const projectRoot = path.resolve(serverRoot, '..');

const envCandidates = [
  path.resolve(serverRoot, '.env'),
  path.resolve(projectRoot, '.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'server', '.env')
];

for (const envPath of [...new Set(envCandidates)]) {
  dotenv.config({ path: envPath, override: false });
}

// Values pasted into a hosting panel often keep quotes, spaces or a line break
// (e.g. GEMINI_API_KEY="AIza…"), and every provider then answers 401 "API key not
// valid". Clean the app's own variables once at start-up and say which were fixed.
const APP_VARS = /^(GEMINI|OPENAI|GROQ|CEREBRAS|CLOUDFLARE|POLLINATIONS|YOUTUBE|TELEGRAM|AZURE|GOOGLE|ELEVENLABS|AIAWAAZ|OPENROUTER|MISTRAL|GITHUB|SAMBANOVA|NVIDIA|COHERE|OLLAMA|MONGODB|APP_SECRET|ADMIN|PUBLIC_URL|ALLOWED_ORIGINS|NODE_ENV|PORT|SESSION|TEXT_|IMAGE_|TTS_|MEDIA_)/;
export function cleanEnvValue(value) {
  let v = String(value ?? '').replace(/^\uFEFF/, '').trim();
  while (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'") || (v[0] === '`' && v.at(-1) === '`'))) v = v.slice(1, -1).trim();
  return v;
}
const cleanedVars = [];
for (const name of Object.keys(process.env)) {
  if (!APP_VARS.test(name)) continue;
  const cleaned = cleanEnvValue(process.env[name]);
  if (cleaned !== process.env[name]) { process.env[name] = cleaned; cleanedVars.push(name); }
}
if (cleanedVars.length) console.warn(`[config] Removed quotes/spaces around: ${cleanedVars.join(', ')}. Enter values without quotes in the hosting panel.`);

// Cloudflare naming compatibility:
// - CLOUDFLARE_API_TOKEN is the preferred name.
// - CLOUDFLARE_WORKERS_AI_API_TOKEN is supported for older configs.
// - cloudflareToken is retained as a compatibility alias for older code.
const cloudflareAccountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
const cloudflareApiToken = String(
  process.env.CLOUDFLARE_API_TOKEN ||
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN ||
  process.env.CLOUDFLARE_TOKEN ||
  ''
).trim();

export const env = {
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/kids_youtube_agent',

  aiProvider: process.env.AI_PROVIDER || 'gemini',
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiTextModel: process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash',
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1',
  geminiImageSize: process.env.GEMINI_IMAGE_SIZE || '1K',

  openaiKey: process.env.OPENAI_API_KEY || '',
  groqKey: process.env.GROQ_API_KEY || '',
  groqTextModel: process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-20b',
  cerebrasKey: process.env.CEREBRAS_API_KEY || '',
  cerebrasTextModel: process.env.CEREBRAS_TEXT_MODEL || 'gpt-oss-120b',
  textModel: process.env.OPENAI_TEXT_MODEL || 'gpt-5.1',

  // Independent image provider settings.
  imageProvider: process.env.MEDIA_IMAGE_PROVIDER || process.env.IMAGE_PROVIDER || 'openai',
  imageModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
  imageSize: process.env.OPENAI_IMAGE_SIZE || '1024x1536',

  // Cloudflare Workers AI.
  cloudflareAccountId,
  cloudflareApiToken,
  cloudflareToken: cloudflareApiToken,
  cloudflareImageModel: process.env.CLOUDFLARE_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell',

  // TTS provider settings.
  ttsProvider: process.env.TTS_PROVIDER || 'groq',
  groqTtsModel: process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english',
  groqTtsVoice: process.env.GROQ_TTS_VOICE || 'hannah',
  openaiTtsModel: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
  openaiTtsVoice: process.env.OPENAI_TTS_VOICE || 'coral',
  geminiTtsModel: process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts',
  geminiTtsVoice: process.env.GEMINI_TTS_VOICE || 'Kore',

  // Pollinations supports the current authenticated API and a legacy public image endpoint.
  // Leave the key empty to use the public endpoint; it may be rate-limited.
  pollinationsKey: process.env.POLLINATIONS_API_KEY || '',
  pollinationsImageModel: process.env.POLLINATIONS_IMAGE_MODEL || 'flux',
  pollinationsSafe: process.env.POLLINATIONS_SAFE || 'false',
  stabilityKey: process.env.STABILITY_API_KEY || '',
  stabilityImageModel: process.env.STABILITY_IMAGE_MODEL || 'stable-image-core',

  ffmpegPath: process.env.FFMPEG_PATH || '',
  mediaGenerationEnabled: process.env.MEDIA_GENERATION_ENABLED !== 'false',
  mediaMock: process.env.MEDIA_MOCK === 'true',
  youtubePublishEnabled: process.env.YOUTUBE_PUBLISH_ENABLED === 'true',
  youtubeDataApiKey: process.env.YOUTUBE_DATA_API_KEY || process.env.YOUTUBE_API_KEY || '',
  geminiRequestTimeoutMs: Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || 240000),
  geminiMaxRetries: Number(process.env.GEMINI_MAX_RETRIES || 4)
};
