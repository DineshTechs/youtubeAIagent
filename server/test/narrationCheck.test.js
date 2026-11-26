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
  assert.match(r.summary, /words not checked: add a speech-to-text key/);
});

test('Autopilot holds a video whose narration check failed (and can be told not to)', () => {
  const video = {status: 'AWAITING_APPROVAL', renderPath: '/x.mp4', qa: {pass: true, score: 95, checks: []}, narrationCheck: {pass: false, issues: ['Scene 2 narration stops early (1.0s …).']}};
  assert.deepEqual(autopilotProblems(video, normalizeAutopilot({})), ['Scene 2 narration stops early (1.0s …).']);
  assert.deepEqual(autopilotProblems(video, normalizeAutopilot({checkNarration: false})), []);
  assert.deepEqual(autopilotProblems({...video, narrationCheck: {pass: true, issues: []}}, normalizeAutopilot({})), []);
});

test('speech-to-text: Groq first, then OpenAI; language codes', () => {
  assert.equal(sttProviderFrom({groqKey: 'g', openaiKey: 'o'}).name, 'Groq Whisper');
  assert.equal(sttProviderFrom({openaiKey: 'o'}).name, 'OpenAI');
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

import {testStt, STT_PROVIDERS} from '../src/services/media/narrationCheck.js';
test('speech-to-text choice, model and strictness', async () => {
  assert.equal(sttProviderFrom({groqKey: 'g', openaiKey: 'o'}, {choice: 'openai'}).name, 'OpenAI');
  assert.equal(sttProviderFrom({groqKey: 'g'}, {choice: 'openai'}), null, 'chosen provider without a key: none');
  assert.equal(sttProviderFrom({groqKey: 'g'}, {models: {groq: 'whisper-large-v3-turbo'}}).model, 'whisper-large-v3-turbo');
  assert.equal(sttProviderFrom({groqKey: 'g'}, {models: {groq: 'made-up'}}).model, 'whisper-large-v3', 'unknown model falls back');
  const scene = {...ok(6.5), transcript: 'एक गाँव में रामू नाम का लकड़हारा था'};
  const m = textSimilarity(hi, scene.transcript);
  assert.ok(m > 0.4 && m < 0.8, `partial match ${m}`);
  assert.equal(judgeNarration([scene], {level: 'relaxed'}).scenes[0].status !== 'FAIL', true);
  assert.equal(judgeNarration([scene], {level: 'strict'}).scenes[0].status !== 'PASS', true);
  const okFetch = async () => new Response(JSON.stringify({data: [{id: 'whisper-large-v3'}, {id: 'whisper-large-v3-turbo'}]}), {status: 200});
  assert.match((await testStt({groqKey: 'g'}, {choice: 'groq'}, okFetch)).message, /Groq Whisper works with whisper-large-v3/);
  await assert.rejects(testStt({openaiKey: 'o'}, {choice: 'openai', models: {openai: 'gpt-4o-transcribe'}}, okFetch), /not available/);
  await assert.rejects(testStt({groqKey: 'g'}, {}, async () => new Response('{"error":{"message":"Invalid API Key"}}', {status: 401})), /rejected the key \(401\): Invalid API Key/);
  await assert.rejects(testStt({}, {choice: 'groq'}), /No Groq key/);
  assert.ok(STT_PROVIDERS.groq.free);
});

import {findSttTool, buildSttArgs, textFromSttResult, mcpTranscribe, resetMcpSessions} from '../src/services/media/mcpTts.js';
const sttTool = {name: 'transcribe_audio', description: 'Speech to text: transcribe an audio file', inputSchema: {type: 'object', properties: {audio_base64: {type: 'string'}, file_name: {type: 'string'}, language: {type: 'string'}}}};
const ttsTool = {name: 'generate_speech', description: 'text to speech', inputSchema: {type: 'object', properties: {text: {type: 'string'}, voice: {type: 'string'}}}};
test('AI Awaaz speech-to-text tool is found and filled in', () => {
  assert.equal(findSttTool([ttsTool, {name: 'list_voices', inputSchema: {}}, sttTool]).name, 'transcribe_audio');
  assert.equal(findSttTool([ttsTool]), null);
  assert.deepEqual(buildSttArgs(sttTool, {audioBase64: 'QUJD', fileName: 'scene-001.mp3', language: 'hi'}), {audio_base64: 'QUJD', file_name: 'scene-001.mp3', language: 'hi'});
  assert.throws(() => buildSttArgs({name: 'transcribe', inputSchema: {properties: {audio_url: {type: 'string'}}}}, {audioBase64: 'x'}), /only accepts a link \(audio_url\)/);
  assert.equal(textFromSttResult({structuredContent: {transcript: 'नमस्ते दोस्तों'}}), 'नमस्ते दोस्तों');
  assert.equal(textFromSttResult({content: [{type: 'text', text: '{"text":"hello there"}'}]}), 'hello there');
  assert.equal(textFromSttResult({content: [{type: 'text', text: 'plain words'}]}), 'plain words');
  assert.throws(() => textFromSttResult({isError: true, content: [{type: 'text', text: 'Insufficient credits'}]}), /Insufficient credits/);
});
test('auto order is Groq, then AI Awaaz, then OpenAI; AI Awaaz can be chosen', () => {
  const a = {url: 'https://app.aiawaaz.io/api/mcp', apiKey: 'ak'};
  assert.equal(sttProviderFrom({openaiKey: 'o'}, {aiawaaz: a}).id, 'aiawaaz');
  assert.equal(sttProviderFrom({groqKey: 'g', openaiKey: 'o'}, {aiawaaz: a}).id, 'groq');
  assert.equal(sttProviderFrom({groqKey: 'g'}, {choice: 'aiawaaz', aiawaaz: a}).id, 'aiawaaz');
  assert.equal(sttProviderFrom({groqKey: 'g'}, {choice: 'aiawaaz'}), null);
});
test('narration words checked through AI Awaaz MCP', async () => {
  resetMcpSessions();
  const calls = [];
  const reply = (id, result) => new Response(JSON.stringify({jsonrpc: '2.0', id, result}), {status: 200, headers: {'content-type': 'application/json'}});
  const fake = async (_u, init) => {
    const b = JSON.parse(init.body);
    if (b.method === 'initialize') return reply(b.id, {protocolVersion: '2025-06-18', capabilities: {}});
    if (!b.id) return new Response('', {status: 202});
    if (b.method === 'tools/list') return reply(b.id, {tools: [ttsTool, sttTool]});
    calls.push(b.params);
    return reply(b.id, {structuredContent: {text: hi}});
  };
  const text = await mcpTranscribe({url: 'https://stt-test.aiawaaz.io/api/mcp', apiKey: 'ak', audio: Buffer.from('ID3fakeaudio'), fileName: 'scene-001.mp3', language: 'hi', sleep: async () => {}, gapMs: 0}, fake);
  assert.equal(text, hi);
  assert.equal(calls[0].name, 'transcribe_audio');
  assert.equal(calls[0].arguments.audio_base64, Buffer.from('ID3fakeaudio').toString('base64'));
  assert.equal(calls[0].arguments.language, 'hi');
});

import {AUTO_ORDER, transcribe, sttKeyStatus} from '../src/services/media/narrationCheck.js';
test('more speech-to-text services: each sends the scene audio its own way', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stt-'));
  const f = path.join(dir, 'scene-001.mp3'); await fs.writeFile(f, Buffer.from('ID3-fake-mp3'));
  const env = {groqKey: 'g', cloudflareApiToken: 'cft', cloudflareAccountId: 'a'.repeat(32), geminiKey: 'gk', deepgramKey: 'dk', openaiKey: 'o'};
  const seen = [];
  const fake = async (url, init = {}) => {
    seen.push({url, init});
    if (url.includes('cloudflare.com')) return new Response(JSON.stringify({success: true, result: {text: 'cf text'}}), {status: 200});
    if (url.includes('generativelanguage')) return new Response(JSON.stringify({candidates: [{content: {parts: [{text: 'gemini text'}]}}]}), {status: 200});
    if (url.includes('deepgram')) return new Response(JSON.stringify({results: {channels: [{alternatives: [{transcript: 'dg text'}]}]}}), {status: 200});
    if (url.includes('elevenlabs')) return new Response(JSON.stringify({text: 'el text'}), {status: 200});
    return new Response(JSON.stringify({text: 'whisper text'}), {status: 200});
  };
  const run = async id => transcribe(f, {provider: sttProviderFrom(env, {choice: id, elevenlabsKey: 'ek'}), language: 'Hindi'}, fake);
  assert.equal(await run('cloudflare'), 'cf text');
  assert.match(seen.at(-1).url, /accounts\/a{32}\/ai\/run\/@cf\/openai\/whisper-large-v3-turbo$/);
  assert.equal(JSON.parse(seen.at(-1).init.body).audio, Buffer.from('ID3-fake-mp3').toString('base64'));
  assert.equal(JSON.parse(seen.at(-1).init.body).language, 'hi');
  assert.equal(await run('gemini'), 'gemini text');
  assert.match(seen.at(-1).url, /models\/gemini-2\.5-flash:generateContent\?key=gk$/);
  assert.match(JSON.parse(seen.at(-1).init.body).contents[0].parts[1].text, /Hindi \(Devanagari script\)/);
  assert.equal(await run('deepgram'), 'dg text');
  assert.match(seen.at(-1).url, /model=nova-2&smart_format=true&language=hi$/);
  assert.equal(seen.at(-1).init.headers.Authorization, 'Token dk');
  assert.equal(await run('elevenlabs'), 'el text');
  assert.equal(seen.at(-1).init.body.get('model_id'), 'scribe_v1');
  assert.equal(await run('groq'), 'whisper text');
  assert.equal(seen.at(-1).url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.deepEqual(AUTO_ORDER.slice(0, 3), ['groq', 'cloudflare', 'gemini'], 'free services first');
  assert.equal(sttProviderFrom({geminiKey: 'gk', openaiKey: 'o'}).id, 'gemini');
  assert.deepEqual(sttKeyStatus({geminiKey: 'x'}, {elevenlabsKey: 'e'}), {groq: false, cloudflare: false, gemini: true, deepgram: false, aiawaaz: false, elevenlabs: true, openai: false});
  await fs.rm(dir, {recursive: true, force: true});
});
test('key tests for the new services', async () => {
  const ok = async () => new Response(JSON.stringify({models: [{name: 'models/gemini-2.5-flash'}], result: [{name: '@cf/openai/whisper-large-v3-turbo'}], success: true, projects: []}), {status: 200});
  assert.match((await testStt({geminiKey: 'g'}, {choice: 'gemini'}, ok)).message, /Gemini works with gemini-2\.5-flash/);
  await assert.rejects(testStt({geminiKey: 'g'}, {choice: 'gemini', models: {gemini: 'gemini-2.0-flash'}}, ok), /not available/);
  assert.match((await testStt({cloudflareApiToken: 't', cloudflareAccountId: 'a'.repeat(32)}, {choice: 'cloudflare'}, ok)).message, /Cloudflare Workers AI Whisper works/);
  assert.match((await testStt({deepgramKey: 'd'}, {choice: 'deepgram'}, ok)).message, /Deepgram works with nova-2/);
  await assert.rejects(testStt({deepgramKey: 'd'}, {choice: 'deepgram'}, async () => new Response('{"err_msg":"Invalid credentials."}', {status: 401})), /Deepgram rejected the key \(401\): Invalid credentials/);
  await assert.rejects(testStt({}, {choice: 'cloudflare'}), /No Cloudflare key/);
});
