import {profileDirectives} from '../channelProfile.js';
import {STORY_VISUAL_PROMPT_RULE} from '../../utils/visualPlan.js';
import {aiProgress} from './aiEvents.js';
import { env } from '../../config/env.js';

function parseJson(text, label) {
  if (!text) throw new Error(`${label} returned an empty response.`);
  // Reasoning models (Nemotron, DeepSeek R1, Qwen) may put <think>…</think> before the JSON.
  const cleaned = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}

  // Recover the first complete JSON object/array when a model adds a short prefix/suffix.
  const starts = [cleaned.indexOf('{'), cleaned.indexOf('[')].filter(i => i >= 0);
  if (starts.length) {
    const start = Math.min(...starts);
    const open = cleaned[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(cleaned.slice(start, i + 1)); } catch {}
          break;
        }
      }
    }
  }
  throw new Error(`${label} returned invalid JSON.`);
}

function tokenBudget(label = '') {
  const l = String(label).toLowerCase();
  if (l.includes('yt-package')) return 6000;
  if (l.includes('yt-script')) return 5000;
  if (l.includes('yt-shorts')) return 5000;
  if (l.includes('yt-seo')) return 3500;
  return 3000;
}

function retryAfterMsFromError(error, fallbackMs = 6000) {
  const msg = String(error?.message || '');
  const m = msg.match(/try again in\s+([0-9.]+)s/i);
  if (m) return Math.min(30000, Math.max(1000, Math.ceil(Number(m[1]) * 1000) + 500));
  const h = msg.match(/retry-after[^0-9]*([0-9.]+)/i);
  if (h) return Math.min(30000, Math.max(1000, Math.ceil(Number(h[1]) * 1000) + 500));
  return fallbackMs;
}

function isRateLimitError(error) {
  return /\b429\b|rate_limit_exceeded|rate limit reached|tokens per minute|TPM/i.test(String(error?.message || ''));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function callGroq({ baseUrl, apiKey, model, prompt, label, jsonMode = true, temperature = 0.2, maxOutputTokens = null }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are a reliable JSON API. Return exactly one valid JSON object. No markdown, no commentary.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: maxOutputTokens || tokenBudget(label),
    temperature
  };

  // GPT-OSS on Groq supports JSON mode. Hidden reasoning keeps reasoning tokens
  // out of the visible JSON response and reduces malformed/empty JSON failures.
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
    // Groq-only options; other providers (Mistral, GitHub, Cohere…) reject unknown fields.
    if (/groq\.com/i.test(baseUrl)) { body.reasoning_format = 'hidden'; body.reasoning_effort = 'low'; }
  }

  aiProgress(`Waiting for ${label} (${model}).`, { label });
  const r = await fetch(`${baseUrl}/chat/completions`, {
    signal: AbortSignal.timeout(Number(process.env.TEXT_REQUEST_TIMEOUT_MS || 180000)),
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) {
    // A retired or unknown model: say so plainly (no point retrying the same model).
    if ((r.status === 404 || r.status === 410 || r.status === 400) && /model/i.test(text) && /(not (?:be )?found|no longer|end of life|does not exist|deprecated|not available|invalid model|unknown model|decommission)/i.test(text)) {
      const detail = (() => { try { const j = JSON.parse(text); return j.detail || j.error?.message || j.message || text; } catch { return text; } })();
      const e = new Error(`The model "${model}" cannot be used any more (${String(detail).slice(0, 220)}). Go to Settings → AI providers → API keys for script providers, click "Load models", pick another model and Save.`);
      e.modelUnavailable = true; e.status = r.status;
      throw e;
    }
    throw new Error(`${label} request failed (${r.status}): ${text.slice(0, 1200)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${label} returned an invalid API response.`); }
  const content = data?.choices?.[0]?.message?.content || '';
  return { data, content };
}

async function requestJson({ baseUrl, apiKey, model, prompt, label, temperature = 0.2, maxOutputTokens = null }) {
  if (!apiKey) throw new Error(`${label} API key is not configured.`);

  let firstError = null;
  try {
    const first = await callGroq({ baseUrl, apiKey, model, prompt, label, jsonMode: true, temperature, maxOutputTokens });
    return parseJson(first.content, label);
  } catch (error) {
    firstError = error;
  }

  // Never immediately fire the text fallback after a 429: that fallback is a
  // second token request and can make Groq TPM exhaustion worse. Respect the
  // provider's suggested delay and retry the same compact request once.
  if (isRateLimitError(firstError)) {
    const waitMs = retryAfterMsFromError(firstError, 6500);
    aiProgress(`${label}: AI provider is busy (rate limit); trying again in ${Math.round(waitMs/1000)}s.`,{label,level:'warning'});
    await sleep(waitMs);
    try {
      const retry = await callGroq({ baseUrl, apiKey, model, prompt, label: `${label} rate-limit retry`, jsonMode: true, temperature, maxOutputTokens });
      return parseJson(retry.content, label);
    } catch (retryError) {
      throw new Error(`${label} rate-limited; retried after ${Math.ceil(waitMs / 1000)}s but Groq still rejected the request. ${retryError?.message || retryError}`);
    }
  }

  // Groq can return HTTP 400 when its JSON validator cannot validate a model
  // generation. Retry once without JSON mode; the prompt still requires JSON,
  // and our parser validates/recoveries the returned object locally.
  if (firstError?.modelUnavailable) throw firstError;
  try {
    const fallback = await callGroq({ baseUrl, apiKey, model, prompt, label: `${label} text fallback`, jsonMode: false, temperature, maxOutputTokens });
    return parseJson(fallback.content, label);
  } catch (secondError) {
    // If the fallback itself is rate-limited, do not make another token-heavy
    // request. Surface the actual provider error instead.
    if (isRateLimitError(secondError)) {
      const waitMs = retryAfterMsFromError(secondError, 6500);
      throw new Error(`${label} rate-limited during fallback. Retry after about ${Math.ceil(waitMs / 1000)}s. ${secondError?.message || secondError}`);
    }
    const firstMsg = firstError?.message || 'unknown JSON-mode error';
    const secondMsg = secondError?.message || 'unknown fallback error';
    throw new Error(`${label} failed after JSON-mode + text fallback. First: ${firstMsg} | Fallback: ${secondMsg}`);
  }
}

export class OpenAICompatibleProvider {
  constructor({ name, apiKey, baseUrl, model, textSettings = {} }) {
    this.name = name; this.apiKey = apiKey; this.baseUrl = baseUrl; this.model = model; this.temperature=Number.isFinite(Number(textSettings.temperature))?Number(textSettings.temperature):0.2; this.maxOutputTokens=Number(textSettings.maxOutputTokens)||null;
  }

  async generateStory({ series, channelProfile={}, characters=[], episodeNumber, topic, recentStories=[], language=channelProfile.language||series?.language||'English', format=channelProfile.content?.primaryFormat||'Short', durationSec=55, hookStyle=channelProfile.content?.hookStyle||'Curiosity', audience=channelProfile.audience?.description||series?.targetAge||'General audience' }) {
    const profile=channelProfile||{};
    const characterText=characters.map(c=>`${c.name}: ${c.personality||''}. Appearance: ${c.appearance||''}. Voice: ${c.voiceProfile||'natural, engaging narration'}`).join('\n');
    const visual=profile.visual||{},content=profile.content||{},narration=profile.narration||{},editorial=profile.editorial||{};
    const prompt=`Create one original YouTube ${format} for this channel.\nChannel: ${series.name}\nChannel premise: ${series.premise}\nNiche: ${profile.niche||series.niche||'General'}\nSub-niche: ${profile.subNiche||'Not specified'}\nTarget audience: ${audience}\nAudience knowledge level: ${profile.audience?.knowledgeLevel||'general'}\nLanguage: ${language}\nChannel content style: ${content.primaryFormat||'Explainer'}\nContent tone: ${content.tone||'Engaging and audience-appropriate'}\nStorytelling approach: ${content.storytellingApproach||'Clear and niche-appropriate'}\nPacing: ${content.pacing||'Dynamic but easy to follow'}\nVisual style: ${visual.style||series.visualStyle||'Cinematic, high-quality visuals'}\nAspect ratio: ${visual.aspectRatio||'9:16'}\nNarration style: ${narration.voiceStyle||'Natural, clear and engaging'}\nChannel strategy: ${JSON.stringify(series.contentStrategy||{})}\nChannel research summary: ${JSON.stringify(series.channelResearch?.strategy||{})}\nChannel profile: ${JSON.stringify(profile)}\nCreator rules: ${(series.rules||[]).join('; ')}\nCharacters or recurring hosts (use only when relevant to this channel):\n${characterText||'No recurring fictional characters required; use real-world subjects, presenters, objects, locations or demonstrations as appropriate.'}\nEpisode: ${episodeNumber}\nRecent generated videos (DO NOT repeat these topics/titles): ${JSON.stringify(recentStories)}\nTopic: ${topic||'choose a fresh topic that fits the channel niche and strategy'}\n\nRequirements: target ${Math.max(10,durationSec-10)}-${durationSec+5} seconds; exactly 4-6 scenes for this short-form generation mode; write title, hook, topic, narration and on-screen text in ${language}; use natural language for the target audience (${audience}); a single concise ${hookStyle} hook of 3-10 spoken words deliverable in about 2-3 seconds; put that exact hook as the FIRST words of scene 1 narration; scene 1 should focus on the hook only, then move into context in scene 2; plan a meaningful visual/action beat by 5-7 seconds; match the channel's tone, format and visual identity; every visualPrompt must depict the exact subjects, action, setting and objects described by its narration; ${STORY_VISUAL_PROMPT_RULE} never make a generic or unrelated image; use concrete camera composition; do not force cartoon or child-friendly styling unless the channel profile explicitly requests it. Follow editorial safety mode: ${editorial.safetyMode||'standard'}. Keep factual claims appropriately qualified and do not invent sources, statistics or quotations. Follow these originality rules: ${(editorial.originalityRules||[]).join('; ')}. ${profileDirectives(profile)} Return ONLY JSON with title, topic, hook, script, scenes. Each scene must contain sceneNumber, durationSec, visualPrompt, narration, onScreenText.`;
    return requestJson({baseUrl:this.baseUrl,apiKey:this.apiKey,model:this.model,prompt,label:`${this.name} story generation`,temperature:this.temperature,maxOutputTokens:this.maxOutputTokens});
  }

  async qualityCheck({ story, series, channelProfile={} }) {
    const compactStory={title:story?.title,topic:story?.topic,hook:story?.hook,scenes:Array.isArray(story?.scenes)?story.scenes.map(s=>({sceneNumber:s.sceneNumber,narration:s.narration,onScreenText:s.onScreenText,visualPrompt:s.visualPrompt})):[]};
    const prompt=`Review this YouTube video script for the channel profile below. Evaluate niche relevance, audience suitability, factual reliability where applicable, originality, clarity, structure, narration quality and production readiness. Do not apply children's-content assumptions unless the profile safetyMode explicitly says kids-and-family. Channel profile: ${JSON.stringify(channelProfile)}. Creator rules: ${(series?.rules||[]).join('; ')}. Check only supplied content and flag unsupported factual claims, unsafe instructions, plagiarism-like copying, misleading claims or audience mismatch. Return ONLY JSON: {"pass":true,"score":100,"notes":[]}. Keep notes short (max 5). STORY: ${JSON.stringify(compactStory)}`;
    return requestJson({baseUrl:this.baseUrl,apiKey:this.apiKey,model:this.model,prompt,label:`${this.name} quality check`,temperature:Math.min(this.temperature,0.3),maxOutputTokens:Math.min(this.maxOutputTokens||600,600)});
  }

  async generateJson(instruction, input = {}, label = 'JSON generation') {
    const prompt = `${instruction}\n\nINPUT JSON:\n${JSON.stringify(input, null, 2)}\n\nReturn ONLY one valid JSON object. Do not wrap it in markdown. Do not add commentary. Make the response complete and concise enough to fit the output limit.`;
    return requestJson({ baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model, prompt, label: `${this.name} ${label}`, temperature: this.temperature, maxOutputTokens: this.maxOutputTokens });
  }

  async testConnection() {
    return requestJson({
      baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model,
      prompt: 'Return only JSON: {"ok":true,"message":"connection successful"}.',
      label: `${this.name} connection test`
    });
  }
}

// Any OpenAI-compatible script provider from the catalog (OpenRouter, Mistral,
// GitHub Models, SambaNova, NVIDIA, Cloudflare, Cohere, Ollama).
export function compatibleProvider({ name, apiKey, baseUrl, model, textSettings }) {
  return new OpenAICompatibleProvider({ name, apiKey: apiKey || 'not-needed', baseUrl: String(baseUrl || '').replace(/\/+$/, ''), model, textSettings });
}

export class GroqProvider extends OpenAICompatibleProvider {
  constructor(model = env.groqTextModel, textSettings = {}) { super({ name: 'Groq', apiKey: env.groqKey, baseUrl: 'https://api.groq.com/openai/v1', model: model || env.groqTextModel, textSettings }); }
}

export class CerebrasProvider extends OpenAICompatibleProvider {
  constructor(model = env.cerebrasTextModel, textSettings = {}) { super({ name: 'Cerebras', apiKey: env.cerebrasKey, baseUrl: 'https://api.cerebras.ai/v1', model: model || env.cerebrasTextModel, textSettings }); }
}

// Model ids the provider offers to this key (OpenAI-compatible GET /models).
const NOT_CHAT = /(embed|rerank|guard|safety|whisper|tts|speech|transcri|audio|image|vision-only|clip|ocr|retriever|nemoretriever|parse|reward|moderation|dall-e|sdxl|flux|stable-diffusion|-vl\b)/i;
export async function listCompatibleModels({ baseUrl, apiKey, fetchImpl = fetch }) {
  const r = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${apiKey || 'not-needed'}` }, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Could not load the model list (${r.status}): ${text.slice(0, 300)}`);
  let data; try { data = JSON.parse(text); } catch { throw new Error('The provider returned an unreadable model list.'); }
  const items = Array.isArray(data) ? data : (data.data || data.models || data.result || []);
  const ids = [...new Set(items.map(m => typeof m === 'string' ? m : (m.id || m.name)).filter(Boolean).map(String))];
  return ids.filter(id => !NOT_CHAT.test(id)).sort((a, b) => (Number(b.endsWith(':free')) - Number(a.endsWith(':free'))) || a.localeCompare(b));
}
