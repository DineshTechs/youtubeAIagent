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
export function judgeNarration(scenes, {transcribed = false, sttProvider = ''} = {}) {
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
        else if (r.match < MATCH_FAIL) fail(`does not say its text (match ${Math.round(r.match * 100)}%). Heard: “${short(sc.transcript)}”`);
        else if (r.match < MATCH_WARN) warn(`only partly matches its text (match ${Math.round(r.match * 100)}%).`);
      } else if (sc.transcribeError) warn(`words were not checked (${short(sc.transcribeError, 80)}).`);
    }
    out.push(r);
  }
  const voices = [...new Set(scenes.filter(s => s.exists && s.voice).map(s => s.voice))];
  if (voices.length > 1) issues.push(`Narration uses ${voices.length} different voices (${voices.join(', ')}); one voice should speak the whole video.`);
  const words = transcribed ? `words checked with ${sttProvider} speech-to-text` : 'words not checked: add a Groq (free) or OpenAI key to check what the audio says';
  return {checkedAt: new Date(), pass: issues.length === 0, transcribed, sttProvider: transcribed ? sttProvider : '', summary: issues.length ? `${issues.length} narration problem(s); ${words}.` : `Narration OK for ${scenes.length} scene(s); ${words}.`, issues, warnings, scenes: out};
}

// ---- Speech-to-text (Whisper on Groq, else OpenAI) ----
export function sttProviderFrom(env) {
  if (env.groqKey) return {name: 'Groq Whisper', url: 'https://api.groq.com/openai/v1/audio/transcriptions', key: env.groqKey, model: 'whisper-large-v3'};
  if (env.openaiKey) return {name: 'OpenAI Whisper', url: 'https://api.openai.com/v1/audio/transcriptions', key: env.openaiKey, model: 'whisper-1'};
  return null;
}
const LANG = {hindi: 'hi', english: 'en', marathi: 'mr', bengali: 'bn', tamil: 'ta', telugu: 'te', gujarati: 'gu', punjabi: 'pa', urdu: 'ur', kannada: 'kn', malayalam: 'ml'};
export const languageCode = l => LANG[String(l || '').toLowerCase().split(/[\s(]/)[0]] || '';
export async function transcribe(file, {provider, language, prompt = ''}, fetchImpl = fetch) {
  const form = new FormData();
  form.append('file', new Blob([await fs.readFile(file)], {type: 'audio/mpeg'}), path.basename(file));
  form.append('model', provider.model);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const code = languageCode(language); if (code) form.append('language', code);
  if (prompt) form.append('prompt', String(prompt).slice(0, 200));
  const r = await fetchImpl(provider.url, {method: 'POST', headers: {Authorization: `Bearer ${provider.key}`}, body: form, signal: AbortSignal.timeout(60000)});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${provider.name} ${r.status}: ${j.error?.message || 'request failed'}`);
  return String(j.text || '');
}

// Runs the whole check. getDuration(file) → seconds. Speech-to-text problems never fail
// the video by themselves; they are reported as "words not checked".
export async function checkNarration({scenes, files, durations, language, env, getDuration, title = '', topic = '', checkWords = true, fetchImpl = fetch, onProgress = () => {}}) {
  const provider = checkWords ? sttProviderFrom(env || {}) : null;
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
      catch (e) { row.transcribeError = e.message; if (/\b(401|403|429)\b/.test(e.message)) sttBroken = e.message; }
    } else if (exists && sttBroken) row.transcribeError = sttBroken;
    rows.push(row);
  }
  const result = judgeNarration(rows, {transcribed: rows.some(r => typeof r.transcript === 'string'), sttProvider: provider?.name || ''});
  if (!checkWords) result.summary = result.summary.replace(/words not checked: add a Groq[^.;]*/, 'word check turned off in Settings');
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
