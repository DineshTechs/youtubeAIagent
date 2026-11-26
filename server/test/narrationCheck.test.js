import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {textSimilarity, judgeNarration, checkNarration, sttProviderFrom, languageCode, maxSpeechSeconds} from '../src/services/media/narrationCheck.js';
import {writeNarrationNote} from '../src/services/media/narrationReuse.js';
import {normalizeAutopilot, autopilotProblems} from '../src/services/autopilot/autopilotRules.js';

const hi = 'एक गाँव में रामू नाम का एक गरीब लकड़हारा रहता था। एक दिन उसकी कुल्हाड़ी नदी में गिर गई।';
const ok = d => ({sceneNumber: 1, text: hi, durationSec: d, exists: true, voice: 'aiawaaz / platform:5316'});

test('what was heard is compared with what was written (Hindi and English)', () => {
  assert.ok(textSimilarity(hi, 'एक गांव में रामू नाम का एक गरीब लकड़हारा रहता था, एक दिन उसकी कुल्हाड़ी नदी में गिर गई') > 0.8);
  assert.ok(textSimilarity(hi, 'आज हम शेयर बाज़ार के बारे में बात करेंगे') < 0.5);
  assert.ok(textSimilarity('Small habits change your life.', 'small habits change your life') > 0.95);
});

test('cut, too long, wrong words and mixed voices fail; a good scene passes', () => {
  const good = judgeNarration([{...ok(6.5), transcript: hi}], {transcribed: true, sttProvider: 'Groq Whisper'});
  assert.equal(good.pass, true);
  assert.match(good.summary, /words checked with Groq Whisper/);
  const r = judgeNarration([
    ok(1.2),                                                         // cut
    {...ok(maxSpeechSeconds(hi) + 5), sceneNumber: 2},              // far too long
    {...ok(6.5), sceneNumber: 3, transcript: 'आज हम शेयर बाज़ार के बारे में बात करेंगे'}, // says something else
    {...ok(6.5), sceneNumber: 4, voice: 'gemini / Kore'},            // other voice
    {sceneNumber: 5, text: hi, exists: false}
  ]);
  assert.equal(r.pass, false);
  assert.match(r.issues.join('\n'), /Scene 1 narration stops early/);
  assert.match(r.issues.join('\n'), /Scene 2 narration is much longer than its text/);
  assert.match(r.issues.join('\n'), /Scene 3 narration does not say its text \(match \d+%\)\. Heard: “आज हम/);
  assert.match(r.issues.join('\n'), /Narration uses 2 different voices/);
  assert.match(r.issues.join('\n'), /Scene 5 narration audio file is missing/);
  assert.match(r.summary, /words not checked: add a Groq/);
});

test('Autopilot holds a video whose narration check failed (and can be told not to)', () => {
  const video = {status: 'AWAITING_APPROVAL', renderPath: '/x.mp4', qa: {pass: true, score: 95, checks: []}, narrationCheck: {pass: false, issues: ['Scene 2 narration stops early (1.0s …).']}};
  assert.deepEqual(autopilotProblems(video, normalizeAutopilot({})), ['Scene 2 narration stops early (1.0s …).']);
  assert.deepEqual(autopilotProblems(video, normalizeAutopilot({checkNarration: false})), []);
  assert.deepEqual(autopilotProblems({...video, narrationCheck: {pass: true, issues: []}}, normalizeAutopilot({})), []);
});

test('speech-to-text: Groq first, then OpenAI; language codes', () => {
  assert.equal(sttProviderFrom({groqKey: 'g', openaiKey: 'o'}).name, 'Groq Whisper');
  assert.equal(sttProviderFrom({openaiKey: 'o'}).name, 'OpenAI Whisper');
  assert.equal(sttProviderFrom({}), null);
  assert.equal(languageCode('Hindi'), 'hi');
  assert.equal(languageCode('English (India)'), 'en');
});

test('the full check reads the files, notes and transcripts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-'));
  const files = [];
  for (let i = 0; i < 2; i++) {
    const f = path.join(dir, `scene-00${i + 1}.mp3`);
    await fs.writeFile(f, Buffer.alloc(4000, 1));
    await writeNarrationNote(f, {signature: 's', text: hi, provider: 'aiawaaz', voice: 'platform:5316'});
    files.push(f);
  }
  const sent = [];
  const fakeFetch = async (url, init) => { sent.push({url, lang: init.body.get('language'), model: init.body.get('model')}); return new Response(JSON.stringify({text: sent.length === 1 ? hi : 'कुछ और ही बात'}), {status: 200}); };
  const r = await checkNarration({scenes: [{sceneNumber: 1, narration: hi}, {sceneNumber: 2, narration: hi}], files, durations: [6.5, 6.5], language: 'Hindi', env: {groqKey: 'gk'}, getDuration: async () => 6.5, fetchImpl: fakeFetch});
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], {url: 'https://api.groq.com/openai/v1/audio/transcriptions', lang: 'hi', model: 'whisper-large-v3'});
  assert.equal(r.scenes[0].status, 'PASS');
  assert.equal(r.scenes[1].status, 'FAIL');
  assert.equal(r.pass, false);
  const noKey = await checkNarration({scenes: [{sceneNumber: 1, narration: hi}], files: [files[0]], durations: [6.5], language: 'Hindi', env: {}, getDuration: async () => 6.5});
  assert.equal(noKey.pass, true);
  assert.equal(noKey.transcribed, false);
  const broken = await checkNarration({scenes: [{sceneNumber: 1, narration: hi}, {sceneNumber: 2, narration: hi}], files, durations: [6.5, 6.5], language: 'Hindi', env: {groqKey: 'bad'}, getDuration: async () => 6.5, fetchImpl: async () => new Response('{"error":{"message":"Invalid API Key"}}', {status: 401})});
  assert.equal(broken.pass, true, 'a speech-to-text error alone does not fail the video');
  assert.match(broken.scenes[1].notes.join(' '), /words were not checked/);
  await fs.rm(dir, {recursive: true, force: true});
});

import {judgeOpening, addOpening} from '../src/services/media/narrationCheck.js';
const rest = [{narration: 'नदी से एक देवी प्रकट हुईं और उन्होंने रामू को सोने की कुल्हाड़ी दिखाई।'}, {narration: 'रामू ने सच बोला कि उसकी कुल्हाड़ी लोहे की थी।'}];
test('the opening must be a complete sentence', () => {
  assert.equal(judgeOpening({scenes: [{narration: hi}, ...rest]}).complete, true);
  assert.match(judgeOpening({scenes: [{narration: 'एक गाँव में रामू नाम का एक गरीब लकड़हारा रहता था और'}, ...rest]}).issues[0], /stops mid-sentence: “…लकड़हारा रहता था और”/);
  assert.match(judgeOpening({scenes: [{narration: 'One day the poor woodcutter dropped his axe and.'}, {narration: 'The axe fell in the river.'}]}).issues[0], /unfinished phrase/);
  assert.equal(judgeOpening({scenes: [{narration: 'यह कहानी है ईमानदारी की।'}, {narration: 'ईमानदारी सबसे बड़ा धन है।'}]}).complete, true, 'Hindi sentences may end on की');
});
test('the opening audio must reach its last words', () => {
  assert.equal(judgeOpening({scenes: [{narration: hi}, ...rest], transcript: hi}).complete, true);
  const cut = judgeOpening({scenes: [{narration: hi}, ...rest], transcript: 'एक गाँव में रामू नाम का एक गरीब लकड़हारा रहता था'});
  assert.match(cut.issues.join(' '), /does not reach its last words/);
});
test('the opening must fit the rest of the story', () => {
  assert.equal(judgeOpening({scenes: [{narration: hi}, ...rest], title: 'ईमानदार लकड़हारा'}).inContext, true);
  const off = judgeOpening({scenes: [{narration: 'क्या आप जानते हैं कि शेयर बाज़ार में निवेश करके जल्दी अमीर बना जा सकता है?'}, ...rest], title: 'ईमानदार लकड़हारा'});
  assert.equal(off.inContext, false);
  assert.match(off.issues[0], /seems out of context/);
  const r = addOpening(judgeNarration([ok(6.5)]), off);
  assert.equal(r.pass, false);
  assert.match(r.issues[0], /out of context/);
});
