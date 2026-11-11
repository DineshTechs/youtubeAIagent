import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { env } from '../../config/env.js';
import { getMediaSettings } from '../ai/index.js';

// Use the same deterministic FFmpeg resolution as the video renderer.
// Do not rely on a system PATH entry on Windows.
const ffmpegPath = env.ffmpegPath || ffmpegStatic || 'ffmpeg';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', code => code === 0
      ? resolve()
      : reject(new Error(`FFmpeg exited with code ${code}`)));
  });
}

async function openaiCall(pathname, body) {
  if (!env.openaiKey) throw new Error('OPENAI_API_KEY is not configured for image generation.');
  const r = await fetch(`https://api.openai.com/v1/${pathname}`, { method: 'POST', headers: { Authorization: `Bearer ${env.openaiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`OpenAI ${pathname} failed (${r.status}): ${text.slice(0, 800)}`);
  return JSON.parse(text);
}

function cloudflareModel(model) {
  const raw = String(model || env.cloudflareImageModel || '@cf/black-forest-labs/flux-1-schnell').trim();
  if (raw.startsWith('https://api.cloudflare.com/client/v4/accounts/')) return raw;
  let m = raw.replace(/^@cf\//, '').replace(/^cf\//, '');
  if (m === 'flux-1-schnell') m = 'black-forest-labs/flux-1-schnell';
  if (!m.includes('/')) m = `black-forest-labs/${m}`;
  return `@cf/${m}`;
}


async function geminiImage(prompt, outFile, options = {}) {
  if (!env.geminiKey) throw new Error('Gemini Image is selected but GEMINI_API_KEY is not configured.');
  const settings = await getMediaSettings();
  const model = settings.imageModel || env.geminiImageModel || 'gemini-nano-banana-2.1';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.geminiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: options.aspectRatio || settings.imageAspectRatio || '9:16',
        imageSize: options.imageSize || settings.imageSizes?.gemini || settings.imageSize || env.geminiImageSize || '1K'
      }
    }
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Gemini image generation failed (${r.status}) [model=${model}]: ${text.slice(0, 1200)}`);
  let result; try { result = JSON.parse(text); } catch { throw new Error(`Gemini image generation returned invalid JSON [model=${model}].`); }
  const parts = result?.candidates?.flatMap(c => c?.content?.parts || []) || [];
  const imagePart = parts.find(p => p?.inlineData?.data || p?.inline_data?.data);
  const b64 = imagePart?.inlineData?.data || imagePart?.inline_data?.data;
  if (!b64) throw new Error(`Gemini image generation returned no image data [model=${model}].`);
  await fs.writeFile(outFile, Buffer.from(b64, 'base64'));
  return outFile;
}


async function pollinationsImage(prompt, outFile, options = {}) {
  const settings = await getMediaSettings();
  const model = settings.imageModel || env.pollinationsImageModel || 'flux';
  const width = Number(options.width || 1080);
  const height = Number(options.height || 1920);
  const encodedPrompt = encodeURIComponent(String(prompt || '').trim());
  const configuredSafe = settings.pollinationsSafe ? 'true' : 'false';

  const buildParams = (safeValue) => new URLSearchParams({
    model,
    width: String(width),
    height: String(height),
    nologo: 'true',
    private: 'true',
    safe: safeValue
  });

  async function request(url, headers = {}) {
    const r = await fetch(url, { headers });
    // Pollinations returns the generated image as binary bytes. Do not call
    // response.text() for successful image responses: converting those bytes
    // through a base64 decoder corrupts the PNG/JPEG/WebP and later makes
    // FFmpeg report an invalid image signature.
    if (r.ok) {
      const contentType = String(r.headers.get('content-type') || '').toLowerCase();
      const bytes = Buffer.from(await r.arrayBuffer());
      return { r, contentType, bytes, text: '' };
    }
    const text = await r.text();
    return { r, contentType: String(r.headers.get('content-type') || '').toLowerCase(), bytes: null, text };
  }

  // Pollinations' privacy safety check scans prompt text and can block perfectly
  // valid story prompts containing character names, URLs, usernames, etc. For this
  // server-side image pipeline we do not send user PII intentionally, so safety is
  // configurable and defaults to OFF. If an explicitly enabled privacy check blocks
  // a request, retry once with checks disabled; do not switch image providers.
  async function generateWith(safeValue) {
    const params = buildParams(safeValue);
    if (env.pollinationsKey) {
      const url = `https://gen.pollinations.ai/image/${encodedPrompt}?${params.toString()}`;
      return request(url, { Authorization: `Bearer ${env.pollinationsKey}` });
    }
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?${params.toString()}`;
    return request(url);
  }

  let { r, text, bytes, contentType } = await generateWith(configuredSafe);
  if (!r.ok && r.status === 400 && /content_blocked|privacy/i.test(text) && configuredSafe !== 'false') {
    ({ r, text, bytes, contentType } = await generateWith('false'));
  }
  if (!r.ok) {
    throw new Error(`Pollinations image generation failed (${r.status}): ${text.slice(0, 1000)}`);
  }
  if (!bytes || !bytes.length) {
    throw new Error(`Pollinations image generation returned an empty image response${contentType ? ` [content-type=${contentType}]` : ''}.`);
  }
  await fs.writeFile(outFile, bytes);
  return outFile;
}

async function cloudflareImage(prompt, outFile) {
  if (!env.cloudflareAccountId || !env.cloudflareApiToken) {
    throw new Error('Cloudflare Workers AI is selected but CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN is not configured.');
  }
  const settings = await getMediaSettings();
  const model = cloudflareModel(settings.imageModel || env.cloudflareImageModel);
  const url = model.startsWith('https://') ? model : `https://api.cloudflare.com/client/v4/accounts/${env.cloudflareAccountId}/ai/run/${model}`;
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${env.cloudflareApiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, steps: 8 }) });
  const contentType = r.headers.get('content-type') || '';
  if (!r.ok) throw new Error(`Cloudflare Workers AI image generation failed (${r.status}) [model=${model}]: ${(await r.text()).slice(0, 1000)}`);
  if (contentType.includes('application/json')) {
    const result = await r.json();
    const b64 = result?.result?.image || result?.result?.b64_json;
    if (!b64) throw new Error(`Cloudflare returned JSON without image data [model=${model}].`);
    await fs.writeFile(outFile, Buffer.from(b64, 'base64'));
  } else {
    await fs.writeFile(outFile, Buffer.from(await r.arrayBuffer()));
  }
  return outFile;
}

export async function generateImage(prompt, outFile, requestedProvider = null, options = {}) {
  const settings = await getMediaSettings();
  const imageProvider = requestedProvider || settings.imageProvider;
  if (imageProvider === 'mock') {
    const { generateMockImage } = await import('./mockMedia.js');
    return generateMockImage(prompt, outFile);
  }
  if (imageProvider === 'gemini') return geminiImage(prompt, outFile, options);
  if (imageProvider === 'cloudflare') return cloudflareImage(prompt, outFile);
  if (imageProvider === 'pollinations') return pollinationsImage(prompt, outFile, options);
  if (imageProvider !== 'openai') throw new Error(`Unsupported image provider: ${imageProvider}`);
  const result = await openaiCall('images/generations', { model: settings.imageModel || env.imageModel, prompt, size: options.openaiSize || settings.imageSizes?.openai || settings.imageSize || env.imageSize || '1024x1536', n: 1, output_format: 'png' });
  const item = result.data?.[0];
  if (item?.b64_json) await fs.writeFile(outFile, Buffer.from(item.b64_json, 'base64'));
  else if (item?.url) { const r = await fetch(item.url); if (!r.ok) throw new Error('Image download failed'); await fs.writeFile(outFile, Buffer.from(await r.arrayBuffer())); }
  else throw new Error('Image API returned no image data.');
  return outFile;
}

async function groqSpeechChunk(text, outFile) {
  if (!env.groqKey) throw new Error('GROQ_API_KEY is not configured for TTS.');
  const settings = await getMediaSettings();
  const model = settings.ttsModel || env.groqTtsModel || 'canopylabs/orpheus-v1-english';
  const voices = ['autumn','diana','hannah','austin','daniel','troy'];
  const voice = voices.includes(settings.ttsVoice) ? settings.ttsVoice : 'hannah';
  const r = await fetch('https://api.groq.com/openai/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${env.groqKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, voice, input: text.slice(0, 200), response_format: 'wav' }) });
  if (!r.ok) throw new Error(`Groq audio/speech failed (${r.status}): ${(await r.text()).slice(0, 800)}`);
  await fs.writeFile(outFile, Buffer.from(await r.arrayBuffer()));
}

function splitForOrpheus(text, max = 190) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const chunks = []; let current = '';
  for (const word of words) { const candidate = current ? `${current} ${word}` : word; if (candidate.length > max && current) { chunks.push(current); current = word; } else current = candidate; }
  if (current) chunks.push(current);
  return chunks;
}

async function concatWav(files, outFile) {
  if (files.length === 1) { await fs.copyFile(files[0], outFile); return; }
  const listFile = path.join(path.dirname(outFile), 'tts-concat.txt');
  await fs.writeFile(listFile, files.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  await new Promise((resolve, reject) => { const child = spawn(ffmpegPath, ['-y','-f','concat','-safe','0','-i',listFile,'-c','copy',outFile], {stdio:'ignore'}); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`FFmpeg audio concat failed with code ${code}`))); });
  await fs.unlink(listFile).catch(() => {});
}

async function generateGroqSpeech(text, outFile) {
  const chunks = splitForOrpheus(text);
  const tempDir = path.join(path.dirname(outFile), 'tts-chunks');
  await fs.mkdir(tempDir, { recursive: true });
  const files = [];
  for (let i = 0; i < chunks.length; i++) { const file = path.join(tempDir, `chunk-${String(i+1).padStart(3,'0')}.wav`); await groqSpeechChunk(chunks[i], file); files.push(file); }
  const wavOut = outFile.replace(/\.mp3$/i, '.wav');
  await concatWav(files, wavOut);
  await new Promise((resolve, reject) => { const child = spawn(ffmpegPath, ['-y','-i',wavOut,'-codec:a','libmp3lame','-q:a','4',outFile], {stdio:'ignore'}); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`FFmpeg MP3 conversion failed with code ${code}`))); });
  await fs.rm(tempDir, { recursive: true, force: true }); await fs.unlink(wavOut).catch(() => {});
  return outFile;
}

async function generateOpenAISpeech(text, outFile, language = 'English') {
  if (!env.openaiKey) throw new Error('OPENAI_API_KEY is not configured for TTS.');
  const settings = await getMediaSettings();
  const r = await fetch('https://api.openai.com/v1/audio/speech', { method:'POST', headers:{Authorization:`Bearer ${env.openaiKey}`,'Content-Type':'application/json'}, body:JSON.stringify({model:settings.ttsModel || env.openaiTtsModel, voice:settings.ttsVoice || env.openaiTtsVoice, input:text, response_format:'mp3', ...(String(language).toLowerCase().startsWith('hi') ? {instructions:'Speak naturally in Hindi using clear Devanagari pronunciation. Use a warm, friendly, child-appropriate storytelling voice. Do not translate the text into English; speak the provided Hindi text as written.'} : {})}) });
  if (!r.ok) throw new Error(`OpenAI audio/speech failed (${r.status}): ${(await r.text()).slice(0,800)}`);
  await fs.writeFile(outFile, Buffer.from(await r.arrayBuffer()));
  return outFile;
}


function extractGeminiAudioBase64(result) {
  const direct = [
    result?.output_audio?.data,
    result?.outputAudio?.data,
    result?.interaction?.output_audio?.data,
    result?.interaction?.outputAudio?.data
  ].find(value => typeof value === 'string' && value.length > 0);
  if (direct) return direct;

  const roots = [
    ...(Array.isArray(result?.steps) ? result.steps : []),
    ...(Array.isArray(result?.outputs) ? result.outputs : []),
    ...(Array.isArray(result?.interaction?.steps) ? result.interaction.steps : []),
    ...(Array.isArray(result?.interaction?.outputs) ? result.interaction.outputs : [])
  ];

  const candidates = [];
  const visit = (node, parentType = '') => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parentType);
      return;
    }

    const type = String(node.type || node.kind || parentType || '').toLowerCase();
    const mime = String(node.mime_type || node.mimeType || node.content_type || node.contentType || '').toLowerCase();

    // Interactions API model_output steps expose audio as typed content blocks.
    if ((type.includes('audio') || mime.startsWith('audio/')) && typeof node.data === 'string' && node.data) {
      candidates.push(node.data);
    }

    for (const key of ['audio', 'output_audio', 'outputAudio', 'inline_data', 'inlineData']) {
      const value = node[key];
      if (value && typeof value === 'object' && typeof value.data === 'string' && value.data) {
        const childMime = String(value.mime_type || value.mimeType || '').toLowerCase();
        if (key.toLowerCase().includes('audio') || childMime.startsWith('audio/')) candidates.push(value.data);
      }
    }

    // Some API versions place audio payload under content[] without an
    // explicit `type: audio` on the immediate parent, so continue walking.
    for (const [key, value] of Object.entries(node)) {
      if (key === 'data' || key === 'text' || key === 'annotations') continue;
      visit(value, key === 'content' ? '' : type);
    }
  };

  visit(roots);
  return candidates.find(value => typeof value === 'string' && value.length > 0) || null;
}

function describeGeminiResponse(result) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const outputs = Array.isArray(result?.outputs) ? result.outputs : [];
  const blockTypes = [];
  for (const step of steps) {
    for (const block of (Array.isArray(step?.content) ? step.content : [])) {
      blockTypes.push(`${step.type || 'step'}/${block.type || 'unknown'}${block.mime_type || block.mimeType ? `(${block.mime_type || block.mimeType})` : ''}`);
    }
  }
  for (const block of outputs) blockTypes.push(`outputs/${block?.type || 'unknown'}`);
  const status = result?.status || result?.interaction?.status || 'not-provided';
  const types = blockTypes.length ? blockTypes.join(', ') : 'no typed output blocks';
  return `Response status: ${status}; output blocks: ${types}.`;
}

async function generateGeminiSpeech(text, outFile, language = 'English') {
  if (!env.geminiKey) throw new Error('GEMINI_API_KEY is not configured for Gemini TTS.');
  const settings = await getMediaSettings();
  const model = settings.ttsModel || env.geminiTtsModel || 'gemini-3.8-flash-tts';
  const voice = settings.ttsVoice || env.geminiTtsVoice || 'Kore';
  const isHindi = String(language || '').toLowerCase().startsWith('hi') || String(language || '').toLowerCase().includes('hindi');
  const style = isHindi
    ? 'Speak in a natural native Indian Hindi accent. Use clear standard Hindi pronunciation and authentic Indian intonation. Deliver the narration warmly and expressively, suitable for a children’s YouTube story. Speak the supplied Devanagari transcript verbatim; do not translate, paraphrase, or add words.'
    : 'Speak clearly and naturally with warm, expressive storytelling delivery, suitable for a family-friendly YouTube narration. Read the supplied transcript verbatim; do not add or omit words.';

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'x-goog-api-key': env.geminiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: [{
        type: 'user_input',
        content: [{
          type: 'text',
          text: String(text || ''),
          annotations: [{ type: 'speech_metadata', style }]
        }]
      }],
      // Use Gemini's documented unary TTS response format. The API returns
      // WAV by default; do not send a delivery mode (the endpoint may reject it).
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] }
    }),
    signal: AbortSignal.timeout(env.geminiRequestTimeoutMs || 120000)
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Gemini TTS failed (${response.status}) [model=${model}, voice=${voice}]: ${responseText.slice(0, 1200)}`);

  let result;
  try { result = JSON.parse(responseText); }
  catch { throw new Error(`Gemini TTS returned invalid JSON [model=${model}]. Response begins: ${responseText.slice(0, 300)}`); }

  // The Interactions API REST response is a raw resource, not the SDK object.
  // The SDK convenience property `interaction.output_audio` is not guaranteed
  // to exist at the top level in REST JSON. New API revisions return media
  // blocks inside steps[].content[]; older revisions may use outputs[] or
  // output_audio. Accept all documented/observed shapes without treating a
  // text block as audio.
  const audioBase64 = extractGeminiAudioBase64(result);
  if (!audioBase64) {
    const diagnostic = describeGeminiResponse(result);
    throw new Error(`Gemini TTS returned no audio data [model=${model}, voice=${voice}]. ${diagnostic}`);
  }

  const audioBytes = Buffer.from(audioBase64, 'base64');
  if (!audioBytes.length) {
    throw new Error(`Gemini TTS returned an empty audio payload [model=${model}, voice=${voice}].`);
  }

  const parsed = path.parse(outFile);
  const wavFile = path.join(parsed.dir, `${parsed.name}.gemini.wav`);
  await fs.writeFile(wavFile, audioBytes);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ['-y', '-i', wavFile, '-codec:a', 'libmp3lame', '-q:a', '4', outFile], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`FFmpeg Gemini TTS MP3 conversion failed with code ${code}`)));
    });
  } finally {
    await fs.unlink(wavFile).catch(() => {});
  }
  return outFile;
}

export async function generateSpeech(text, outFile, language = 'English') {
  const { ttsProvider } = await getMediaSettings();
  const isHindi = String(language || '').toLowerCase().startsWith('hi') || String(language || '').toLowerCase().includes('hindi');
  if (ttsProvider === 'mock') { const { generateMockSpeech } = await import('./mockMedia.js'); return generateMockSpeech(text, outFile); }
  // The selected TTS provider is authoritative. Never silently switch providers
  // (for example, Groq -> OpenAI) because that makes the UI selection misleading.
  if (ttsProvider === 'groq') {
    return generateGroqSpeech(text, outFile);
  }
  if (ttsProvider === 'openai') return generateOpenAISpeech(text, outFile, language);
  if (ttsProvider === 'gemini') return generateGeminiSpeech(text, outFile, language);
  throw new Error(`Unsupported TTS provider: ${ttsProvider}`);
}
