import { env } from '../../config/env.js';

function parseJson(text, label) {
  if (!text) throw new Error(`${label} returned an empty response.`);
  const cleaned = String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
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
    body.reasoning_format = 'hidden';
    body.reasoning_effort = 'low';
  }

  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${label} request failed (${r.status}): ${text.slice(0, 1200)}`);
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

  async generateStory({ series, characters, episodeNumber, topic, recentStories=[], language=series?.language||'English', format='Short', durationSec=55, hookStyle='Curiosity', audience=series?.targetAge||'4-8' }) {
    const characterText = characters.map(c => `${c.name}: ${c.personality}. Appearance: ${c.appearance}. Voice: ${c.voiceProfile || 'warm child-friendly narrator'}`).join('\n');
    const prompt = `Create one original YouTube ${format} for children age ${series.targetAge}.\nSeries: ${series.name}\nPremise: ${series.premise}\nVisual style: ${series.visualStyle}\nRules: ${series.rules.join('; ')}\nCharacters:\n${characterText}\nEpisode: ${episodeNumber}\nNiche: ${series.niche || 'general kids content'}\nChannel strategy: ${JSON.stringify(series.contentStrategy || {})}\nChannel research summary: ${JSON.stringify(series.channelResearch?.strategy || {})}\nRecent generated videos (DO NOT repeat these topics/titles): ${JSON.stringify(recentStories)}\nTopic: ${topic || 'choose a fresh topic that fits the niche and strategy'}\n\nRequirements: ${durationSec-10}-${durationSec+5} seconds; exactly 4-6 scenes; write the title, hook, topic, narration and on-screen text in ${language} (Hindi must use natural Devanagari); simple spoken language for audience ${audience}; strong first 2-3 second ${hookStyle} hook; consistent character appearance; every visualPrompt must directly depict the exact action, subjects, setting, objects and emotion described by that scene's narration; never make a generic or unrelated image; the narration is the primary source of truth; explicitly name the exact subjects, physical action, objects, location and emotion from the narration; use realistic cinematic visual language, not cartoon/anime/flat illustration/kids-cartoon styling; include useful camera composition and keep recurring characters visually consistent; positive and wholesome; no copyrighted characters, songs, brands, violence, frightening imagery, politics, mature themes, dangerous instructions, weapons or sexual content. Return ONLY JSON with title, topic, hook, script, scenes. Each scene must contain sceneNumber, durationSec, visualPrompt, narration, onScreenText.`;
    return requestJson({ baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model, prompt, label: `${this.name} story generation`, temperature: this.temperature, maxOutputTokens: this.maxOutputTokens });
  }

  async qualityCheck({ story, series }) {
    // QA does not need the full story object or the global 2600-token budget.
    // Keeping this request compact is important on Groq's TPM-limited tiers.
    const compactStory = {
      title: story?.title,
      topic: story?.topic,
      hook: story?.hook,
      scenes: Array.isArray(story?.scenes) ? story.scenes.map(s => ({
        sceneNumber: s.sceneNumber,
        narration: s.narration,
        onScreenText: s.onScreenText,
        visualPrompt: s.visualPrompt
      })) : []
    };
    const rules = Array.isArray(series?.rules) ? series.rules.slice(0, 12).join('; ') : '';
    const prompt = `Review this children's YouTube Short for safety, age appropriateness and production quality. Target age: ${series?.targetAge || 'children'}. Rules: ${rules}. Check only the supplied content; do not invent missing facts. Reject scary, violent, sexual, political, dangerous, copyrighted-character or otherwise inappropriate content. Return ONLY JSON: {"pass":true,"score":100,"notes":[]}. Keep notes short (max 3). STORY: ${JSON.stringify(compactStory)}`;
    return requestJson({ baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model, prompt, label: `${this.name} quality check`, temperature: Math.min(this.temperature, 0.3), maxOutputTokens: Math.min(this.maxOutputTokens || 500, 500) });
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

export class GroqProvider extends OpenAICompatibleProvider {
  constructor(model = env.groqTextModel, textSettings = {}) { super({ name: 'Groq', apiKey: env.groqKey, baseUrl: 'https://api.groq.com/openai/v1', model: model || env.groqTextModel, textSettings }); }
}

export class CerebrasProvider extends OpenAICompatibleProvider {
  constructor(model = env.cerebrasTextModel, textSettings = {}) { super({ name: 'Cerebras', apiKey: env.cerebrasKey, baseUrl: 'https://api.cerebras.ai/v1', model: model || env.cerebrasTextModel, textSettings }); }
}
