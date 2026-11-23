// Saved scene narration is only reused when it was made with the SAME voice and the
// same words. Before this, a resumed video kept scenes 1-4 from an earlier attempt
// (Gemini "Kore") and made scenes 5-6 with the newly selected voice (ElevenLabs), so
// one video had several voices. Each scene-NNN.mp3 now has a scene-NNN.mp3.json
// note saying which voice made it.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export function speechSignature({ mock = false, provider = '', model = '', voice = '', language = '' } = {}) {
  if (mock) return 'mock';
  return [provider, model, voice, language].map(v => String(v || '').trim().toLowerCase()).join('|');
}
export const textHash = text => crypto.createHash('sha1').update(String(text || '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
export const noteFile = audioFile => `${audioFile}.json`;

export function canReuseNarration(note, { signature, text }) {
  return Boolean(note && note.signature === signature && note.textHash === textHash(text));
}
export async function readNarrationNote(audioFile) {
  try { return JSON.parse(await fs.readFile(noteFile(audioFile), 'utf8')); } catch { return null; }
}
export async function writeNarrationNote(audioFile, { signature, text, provider, voice }) {
  await fs.writeFile(noteFile(audioFile), JSON.stringify({ signature, textHash: textHash(text), provider: provider || '', voice: voice || '', createdAt: new Date().toISOString() }), 'utf8');
}
// Human-readable reason, for the job log.
export function reuseProblem(note, { signature, text }) {
  if (!note) return 'no record of which voice made it';
  if (note.signature !== signature) return `it was made with a different voice (${note.provider || 'unknown'}${note.voice ? ` / ${note.voice}` : ''})`;
  if (note.textHash !== textHash(text)) return 'the narration text changed';
  return '';
}
