import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {speechSignature, canReuseNarration, readNarrationNote, writeNarrationNote, reuseProblem, textHash} from '../src/services/media/narrationReuse.js';

// Regression 2026-11-23 ("सफलता के 5 आसान कदम"): scenes 1-4 kept Gemini "Kore" audio from an
// earlier attempt and scenes 5-6 were made with ElevenLabs, so one video had two voices.
test('saved narration from another voice is not reused', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'narr-'));
  const file = path.join(dir, 'scene-001.mp3');
  const text = 'सफलता का पहला कदम है स्पष्ट लक्ष्य रखना।';
  const gemini = speechSignature({provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'Kore', language: 'Hindi'});
  const eleven = speechSignature({provider: 'elevenlabs', model: 'eleven_multilingual_v2', voice: 'JBFqnCBsd6RMkjVDRZzb', language: 'Hindi'});
  assert.notEqual(gemini, eleven);
  await fs.writeFile(file, Buffer.alloc(200));
  // Old files have no note: unknown voice, so they are remade.
  assert.equal(canReuseNarration(await readNarrationNote(file), {signature: eleven, text}), false);
  assert.match(reuseProblem(null, {signature: eleven, text}), /no record/);
  await writeNarrationNote(file, {signature: gemini, text, provider: 'gemini', voice: 'Kore'});
  const note = await readNarrationNote(file);
  assert.equal(canReuseNarration(note, {signature: gemini, text}), true);
  assert.equal(canReuseNarration(note, {signature: eleven, text}), false);
  assert.match(reuseProblem(note, {signature: eleven, text}), /different voice \(gemini \/ Kore\)/);
  // Same voice but edited words: remade too.
  assert.equal(canReuseNarration(note, {signature: gemini, text: text + ' नया'}), false);
  assert.equal(textHash(' a  b '), textHash('a b'));
});
