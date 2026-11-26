// Narration check, run after the video is rendered and before anyone (or Autopilot)
// approves it. Per scene it checks that the audio exists, is not cut short, is not far
// longer than its words, that ONE voice speaks the whole video and — when a
// speech-to-text key is available (Groq or OpenAI) — that the audio really says the
// scene's text. Autopilot does not publish a video whose narration check failed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {narrationLooksCut, minSpeechSeconds} from '../../utils/audioTiming.js';
import {readNarrationNote} from './narrationReuse.js';
import {contentWords} from '../../utils/openingRetention.js';
import {mcpTranscribe, mcpSttInfo} from './mcpTts.js';

// Slowest believable narration: ~5 characters a second, plus 3 s of pauses.
export const SLOWEST_CHARS_PER_SEC = 5;
export function maxSpeechSeconds(text) {
  const n = String(text || '').replace(/\s+/g, ' ').trim().length;
  return n < 40 ? 0 : Number((n / SLOWEST_CHARS_PER_SEC + 3).toFixed(2));
}
export const MATCH_FAIL = 0.5;   // below this, the audio is not saying the scene's text
export const MATCH_WARN = 0.7;

// Letters only (any script), lower case, for comparing what was written with what was heard.
const letters = t => String(t || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
function bigrams(t) { const s = letters(t), out = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); } return out; }
// Dice similarity of letter pairs: works for Hindi and English, tolerant of spelling and
// punctuation differences in the transcript.
export function textSimilarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  let total = 0, shared = 0;
  for (const v of A.values()) total += v;
  for (const v of B.values()) total += v;
  for (const [g, v] of A) shared += Math.min(v, B.get(g) || 0);
  return total ? (2 * shared) / total : 0;
}

const short = (t, n = 90) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// scenes: [{sceneNumber, text, durationSec, exists, voice, transcript?, transcribeError?}]
export function judgeNarration(scenes, {transcribed = false, sttProvider = '', level = 'normal'} = {}) {
  const L = MATCH_LEVELS[level] || MATCH_LEVELS.normal;
  const issues = [], warnings = [], out = [];
  for (const sc of scenes) {
    const r = {sceneNumber: sc.sceneNumber, durationSec: sc.durationSec, status: 'PASS', notes: []};
    const fail = m => { r.status = 'FAIL'; r.notes.push(m); issues.push(`Scene ${sc.sceneNumber} narration ${m}`); };
    const warn = m => { if (r.status === 'PASS') r.status = 'WARN'; r.notes.push(m); warnings.push(`Scene ${sc.sceneNumber} narration ${m}`); };
    if (!sc.exists) fail('audio file is missing.');
    else {
      if (narrationLooksCut(sc.text, sc.durationSec)) fail(`stops early (${Number(sc.durationSec).toFixed(1)}s of audio for ${String(sc.text).length} characters; at least ${minSpeechSeconds(sc.text).toFixed(1)}s expected).`);
      const max = maxSpeechSeconds(sc.text);
      if (max && sc.durationSec > max) fail(`is much longer than its text (${Number(sc.durationSec).toFixed(1)}s; at most ~${max.toFixed(0)}s expected), so it may contain extra or repeated speech.`);
      if (typeof sc.transcript === 'string') {
        r.match = Number(textSimilarity(sc.text, sc.transcript).toFixed(2));
        r.heard = short(sc.transcript, 160);
        if (!letters(sc.transcript)) fail('has no words that speech-to-text could hear.');
        else if (r.match < L.fail) fail(`does not say its text (match ${Math.round(r.match * 100)}%). Heard: “${short(sc.transcript)}”`);
        else if (r.match < L.warn) warn(`only partly matches its text (match ${Math.round(r.match * 100)}%).`);
      } else if (sc.transcribeError) warn(`words were not checked (${short(sc.transcribeError, 80)}).`);
    }
    out.push(r);
  }
  const voices = [...new Set(scenes.filter(s => s.exists && s.voice).map(s => s.voice))];
  if (voices.length > 1) issues.push(`Narration uses ${voices.length} different voices (${voices.join(', ')}); one voice should speak the whole video.`);
  const words = transcribed ? `words checked with ${sttProvider} speech-to-text` : 'words not checked: add a speech-to-text key (Groq, Cloudflare or Gemini are free) to check what the audio says';
  return {checkedAt: new Date(), pass: issues.length === 0, transcribed, sttProvider: transcribed ? sttProvider : '', summary: issues.length ? `${issues.length} narration problem(s); ${words}.` : `Narration OK for ${scenes.length} scene(s); ${words}.`, issues, warnings, scenes: out};
}

// ---- Speech-to-text services ------------------------------------------------
// Each service: where its key comes from (creds), the request that turns one scene's MP3
// into text, and a cheap key test for Settings. "creds" = env (API keys saved in the
// dashboard are applied there) plus {aiawaaz:{url,apiKey}, elevenlabsKey}.
const LANG = {hindi: 'hi', english: 'en', marathi: 'mr', bengali: 'bn', tamil: 'ta', telugu: 'te', gujarati: 'gu', punjabi: 'pa', urdu: 'ur', kannada: 'kn', malayalam: 'ml'};
export const languageCode = l => LANG[String(l || '').toLowerCase().split(/[\s(]/)[0]] || '';
const json = async r => r.json().catch(() => ({}));
const fail = (name, r, j, extra = '') => new Error(`${name} ${r.status}: ${j?.error?.message || j?.errors?.[0]?.message || j?.detail?.message || j?.detail || j?.err_msg || j?.message || extra || 'request failed'}`);
const T = ms => AbortSignal.timeout(ms);
async function whisperForm(base, name, key, model, audio, file, code, fetchImpl) {
  const form = new FormData();
  form.append('file', new Blob([audio], {type: 'audio/mpeg'}), file);
  form.append('model', model); form.append('response_format', 'json'); form.append('temperature', '0');
  if (code) form.append('language', code);
  const r = await fetchImpl(`${base}/audio/transcriptions`, {method: 'POST', headers: {Authorization: `Bearer ${key}`}, body: form, signal: T(60000)});
  const j = await json(r); if (!r.ok) throw fail(name, r, j); return String(j.text || '');
}
async function listedModel(name, r, model, ids) {
  const j = await json(r);
  if (!r.ok) throw new Error(`${name} rejected the key (${r.status}): ${j.error?.message || j.errors?.[0]?.message || j.detail?.message || j.err_msg || 'request failed'}`);
  const list = ids(j);
  if (list.length && model && !list.includes(model)) throw new Error(`${name} key works, but the model "${model}" is not available to it. Pick another model.`);
}
export const STT_PROVIDERS = {
  groq: {name: 'Groq Whisper', keyName: 'Groq', free: true, models: ['whisper-large-v3', 'whisper-large-v3-turbo'],
    key: c => c.groqKey,
    run: ({key, model, audio, file, code}, f) => whisperForm('https://api.groq.com/openai/v1', 'Groq Whisper', key, model, audio, file, code, f),
    test: async ({key, model}, f) => listedModel('Groq Whisper', await f('https://api.groq.com/openai/v1/models', {headers: {Authorization: `Bearer ${key}`}, signal: T(15000)}), model, j => (j.data || []).map(m => m.id))},
  cloudflare: {name: 'Cloudflare Workers AI Whisper', keyName: 'Cloudflare', free: true, models: ['@cf/openai/whisper-large-v3-turbo'],
    key: c => (c.cloudflareApiToken && c.cloudflareAccountId ? `${c.cloudflareAccountId}|${c.cloudflareApiToken}` : ''),
    run: async ({key, model, audio, code}, f) => {
      const [acct, token] = key.split('|');
      const r = await f(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`, {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({audio: Buffer.from(audio).toString('base64'), ...(code ? {language: code} : {})}), signal: T(90000)});
      const j = await json(r); if (!r.ok || j.success === false) throw fail('Cloudflare Whisper', r, j); return String(j.result?.text || '');
    },
    test: async ({key, model}, f) => { const [acct, token] = key.split('|'); const r = await f(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/models/search?search=${encodeURIComponent(model.split('/').pop())}`, {headers: {Authorization: `Bearer ${token}`}, signal: T(15000)}); await listedModel('Cloudflare', r, model, j => (j.result || []).map(m => `@cf/${String(m.name || '').replace(/^@cf\//, '')}`)); }},
  gemini: {name: 'Gemini', keyName: 'Gemini', free: true, models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
    key: c => c.geminiKey,
    run: async ({key, model, audio, code}, f) => {
      const ask = `Transcribe this narration exactly, word for word${code === 'hi' ? ', in Hindi (Devanagari script)' : ''}. Output only the spoken words, nothing else.`;
      const r = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({contents: [{parts: [{inline_data: {mime_type: 'audio/mp3', data: Buffer.from(audio).toString('base64')}}, {text: ask}]}], generationConfig: {temperature: 0}}), signal: T(90000)});
      const j = await json(r); if (!r.ok) throw fail('Gemini', r, j);
      return String((j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(' ')).trim();
    },
    test: async ({key, model}, f) => listedModel('Gemini', await f(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`, {signal: T(15000)}), model, j => (j.models || []).map(m => String(m.name).replace(/^models\//, '')))},
  deepgram: {name: 'Deepgram', keyName: 'Deepgram', free: false, models: ['nova-2', 'nova-3', 'whisper-large'],
    key: c => c.deepgramKey,
    run: async ({key, model, audio, code}, f) => {
      const r = await f(`https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&smart_format=true${code ? `&language=${code}` : ''}`, {method: 'POST', headers: {Authorization: `Token ${key}`, 'Content-Type': 'audio/mpeg'}, body: audio, signal: T(60000)});
      const j = await json(r); if (!r.ok) throw fail('Deepgram', r, j); return String(j.results?.channels?.[0]?.alternatives?.[0]?.transcript || '');
    },
    test: async ({key}, f) => listedModel('Deepgram', await f('https://api.deepgram.com/v1/projects', {headers: {Authorization: `Token ${key}`}, signal: T(15000)}), '', () => [])},
  aiawaaz: {name: 'AI Awaaz', keyName: 'AI Awaaz', free: false, models: [], mcp: true,
    key: c => (c.aiawaaz?.apiKey ? 'mcp' : ''),
    run: ({creds, audio, file, code, language}, f) => mcpTranscribe({...creds.aiawaaz, audio, fileName: file, language: code || language}, f),
    test: async ({creds}, f) => { const i = await mcpSttInfo(creds.aiawaaz, f); return `AI Awaaz speech-to-text is available (tool “${i.tool}”, audio sent as “${i.audioField}”).`; }},
  elevenlabs: {name: 'ElevenLabs Scribe', keyName: 'ElevenLabs', free: false, models: ['scribe_v1'],
    key: c => c.elevenlabsKey,
    run: async ({key, model, audio, file, code}, f) => {
      const form = new FormData(); form.append('file', new Blob([audio], {type: 'audio/mpeg'}), file); form.append('model_id', model); if (code) form.append('language_code', code);
      const r = await f('https://api.elevenlabs.io/v1/speech-to-text', {method: 'POST', headers: {'xi-api-key': key}, body: form, signal: T(90000)});
      const j = await json(r); if (!r.ok) throw fail('ElevenLabs', r, j); return String(j.text || '');
    },
    test: async ({key}, f) => listedModel('ElevenLabs', await f('https://api.elevenlabs.io/v1/models', {headers: {'xi-api-key': key}, signal: T(15000)}), '', () => [])},
  openai: {name: 'OpenAI', keyName: 'OpenAI', free: false, models: ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'],
    key: c => c.openaiKey,
    run: ({key, model, audio, file, code}, f) => whisperForm('https://api.openai.com/v1', 'OpenAI', key, model, audio, file, code, f),
    test: async ({key, model}, f) => listedModel('OpenAI', await f('https://api.openai.com/v1/models', {headers: {Authorization: `Bearer ${key}`}, signal: T(15000)}), model, j => (j.data || []).map(m => m.id))}
};
// Free ones first.
export const AUTO_ORDER = ['groq', 'cloudflare', 'gemini', 'deepgram', 'aiawaaz', 'elevenlabs', 'openai'];
export const MATCH_LEVELS = {strict: {fail: 0.6, warn: 0.8}, normal: {fail: MATCH_FAIL, warn: MATCH_WARN}, relaxed: {fail: 0.4, warn: 0.6}};
const credsOf = (env, extra = {}) => ({...(env || {}), ...Object.fromEntries(Object.entries(extra || {}).filter(([, v]) => v))});
// choice: 'auto' or a service id; models: {id: model}; extra: {aiawaaz, elevenlabsKey}
export function sttProviderFrom(env, {choice = 'auto', models = {}, aiawaaz = null, elevenlabsKey = ''} = {}) {
  const creds = credsOf(env, {aiawaaz, elevenlabsKey});
  for (const id of STT_PROVIDERS[choice] ? [choice] : AUTO_ORDER) {
    const p = STT_PROVIDERS[id], key = p.key(creds);
    if (!key) continue;
    const model = p.models.includes(models?.[id]) ? models[id] : (p.models[0] || '');
    return {id, name: p.name, key, model, creds, mcp: p.mcp ? creds.aiawaaz : undefined};
  }
  return null;
}
export function sttKeyStatus(env, extra = {}) {
  const creds = credsOf(env, extra);
  return Object.fromEntries(Object.entries(STT_PROVIDERS).map(([id, p]) => [id, Boolean(p.key(creds))]));
}
// Settings → Narration check → Test: checks the key (and that the model is offered).
export async function testStt(env, {choice, models, aiawaaz, elevenlabsKey} = {}, fetchImpl = fetch) {
  const p = sttProviderFrom(env, {choice, models, aiawaaz, elevenlabsKey});
  if (!p) throw new Error(STT_PROVIDERS[choice] ? `No ${STT_PROVIDERS[choice].keyName} key: add it in API keys.` : 'No speech-to-text key yet: add a Groq (free), Cloudflare, Gemini or other key in API keys.');
  const msg = await STT_PROVIDERS[p.id].test(p, fetchImpl);
  return {ok: true, message: msg || `${p.name} works${p.model ? ` with ${p.model}` : ''}.`, provider: p.id, model: p.model};
}
export async function transcribe(file, {provider, language}, fetchImpl = fetch) {
  const audio = await fs.readFile(file);
  return STT_PROVIDERS[provider.id].run({...provider, audio, file: path.basename(file), code: languageCode(language), language}, fetchImpl);
}

// Runs the whole check. getDuration(file) → seconds. Speech-to-text problems never fail
// the video by themselves; they are reported as "words not checked".
export async function checkNarration({scenes, files, durations, language, env, getDuration, title = '', topic = '', checkWords = true, sttChoice = 'auto', sttModels = {}, aiawaaz = null, elevenlabsKey = '', level = 'normal', fetchImpl = fetch, onProgress = () => {}}) {
  const provider = checkWords ? sttProviderFrom(env || {}, {choice: sttChoice, models: sttModels, aiawaaz, elevenlabsKey}) : null;
  const rows = [];
  let sttBroken = '';
  for (let i = 0; i < scenes.length; i++) {
    const text = scenes[i]?.narration || '';
    const file = files[i];
    const exists = Boolean(file) && await fs.stat(file).then(s => s.size > 100).catch(() => false);
    const durationSec = exists ? (Number(durations[i]) || await getDuration(file).catch(() => 0)) : 0;
    const note = exists ? await readNarrationNote(file) : null;
    const row = {sceneNumber: scenes[i]?.sceneNumber || i + 1, text, durationSec, exists, voice: note ? [note.provider, note.voice].filter(Boolean).join(' / ') : ''};
    if (exists && provider && !sttBroken) {
      onProgress(`Checking scene ${row.sceneNumber} narration words (${provider.name})…`);
      try { row.transcript = await transcribe(file, {provider, language}, fetchImpl); }
      catch (e) { row.transcribeError = e.message; if (/\b(401|403|429)\b|no speech-to-text tool|only accepts|API key/i.test(e.message)) sttBroken = e.message; }
    } else if (exists && sttBroken) row.transcribeError = sttBroken;
    rows.push(row);
  }
  const result = judgeNarration(rows, {transcribed: rows.some(r => typeof r.transcript === 'string'), sttProvider: provider ? (provider.model && !provider.mcp ? `${provider.name} (${provider.model})` : provider.name) : '', level});
  if (checkWords && !provider && sttChoice !== 'auto') result.summary = result.summary.replace(/words not checked: add a speech-to-text key[^.;]*/, `words not checked: no ${STT_PROVIDERS[sttChoice]?.keyName || ''} key`);
  if (!checkWords) result.summary = result.summary.replace(/words not checked: add a speech-to-text key[^.;]*/, 'word check turned off in Settings');
  return addOpening(result, judgeOpening({scenes, title, topic, transcript: rows[0]?.transcript}));
}
export function addOpening(result, opening) {
  result.opening = opening;
  for (const i of opening.issues) result.issues.unshift(i);
  for (const w of opening.warnings) result.warnings.unshift(w);
  result.pass = result.issues.length === 0;
  if (opening.issues.length) result.summary = `${result.issues.length} narration problem(s), including the opening; ${result.summary.split('; ').slice(1).join('; ')}`;
  return result;
}

// ---- The opening (scene 1) ------------------------------------------------
// Complete: ends on a full sentence (not "…और", "…because"), and the audio reaches its
// last words. In context: shares real words (names, things, events) with the rest of
// the story or its title, instead of talking about something else.
// Words a finished sentence does not end on (conjunctions, articles).
const DANGLING = /(?:^|\s)(और|कि|लेकिन|मगर|क्योंकि|अगर|या|and|or|but|because|so|that|the|a|an|of|to|with|if|which)$/iu;
export function judgeOpening({scenes = [], title = '', topic = '', transcript} = {}) {
  const first = String(scenes[0]?.narration || '').replace(/\s+/g, ' ').trim();
  const rest = scenes.slice(1).map(s => s?.narration || '').join(' ');
  const out = {complete: true, inContext: true, shared: 0, issues: [], warnings: []};
  if (!first) { out.complete = false; out.issues.push('The opening (scene 1) has no narration.'); return out; }
  const lastWords = first.split(' ').slice(-4).join(' ');
  const trimmed = first.replace(/[\s"”’')\]]+$/u, '');
  if (!/[.!?।॥…]$/u.test(trimmed)) { out.complete = false; out.issues.push(`The opening (scene 1) stops mid-sentence: “…${lastWords}”.`); }
  else if (DANGLING.test(trimmed.replace(/[.!?।॥…]+$/u, '').trim())) { out.complete = false; out.issues.push(`The opening (scene 1) ends on an unfinished phrase: “…${lastWords}”.`); }
  if (typeof transcript === 'string' && transcript.trim()) {
    // Does the audio reach the end of the opening? Compare the last ~30 letters.
    const tail = t => String(t).toLowerCase().normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]+/gu, '').slice(-30);
    const heardEnd = textSimilarity(tail(first), String(transcript).toLowerCase().normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]+/gu, '').slice(-45));
    out.endMatch = Number(heardEnd.toFixed(2));
    if (heardEnd < 0.35) { out.complete = false; out.issues.push(`The opening (scene 1) audio does not reach its last words (“…${lastWords}”); it may be cut off.`); }
  }
  if (rest.trim() || title || topic) {
    const a = contentWords(first), b = new Set([...contentWords(rest), ...contentWords(title), ...contentWords(topic)]);
    out.shared = [...a].filter(w => b.has(w)).length;
    if (scenes.length > 1 && out.shared === 0) { out.inContext = false; out.issues.push('The opening (scene 1) seems out of context: it shares no names, things or events with the rest of the story or its title.'); }
    else if (scenes.length > 1 && out.shared === 1 && a.size >= 6) out.warnings.push('The opening (scene 1) shares only one word with the rest of the story; check that it fits.');
  }
  return out;
}
