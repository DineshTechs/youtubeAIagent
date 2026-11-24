import test from 'node:test';
import assert from 'node:assert/strict';
import {viaRelay, audioFromResult} from '../src/services/media/mcpTts.js';
import worker from '../deploy/aiawaaz-relay-worker.js';

const RELAY = 'https://relay.example.workers.dev/s3cr3t/api/mcp';

test('AI Awaaz audio links go through the relay when one is set', () => {
  assert.equal(viaRelay('https://app.aiawaaz.io/files/a.mp3?t=1', RELAY), 'https://relay.example.workers.dev/s3cr3t/_host/app.aiawaaz.io/files/a.mp3?t=1');
  assert.equal(viaRelay('https://cdn.aiawaaz.io/x.mp3', RELAY), 'https://relay.example.workers.dev/s3cr3t/_host/cdn.aiawaaz.io/x.mp3');
  assert.equal(viaRelay('https://app.aiawaaz.io/a.mp3', 'https://app.aiawaaz.io/api/mcp'), 'https://app.aiawaaz.io/a.mp3'); // no relay
  assert.equal(viaRelay('https://storage.example.com/a.mp3', RELAY), 'https://storage.example.com/a.mp3');                 // other hosts direct
});

test('downloads use the relay address', async () => {
  let asked;
  const audio = Buffer.alloc(3000, 1);
  const out = await audioFromResult({content: [{type: 'text', text: 'Download: https://app.aiawaaz.io/out/a.mp3'}]}, async u => { asked = u; return new Response(audio); }, {mcpUrl: RELAY});
  assert.equal(asked, 'https://relay.example.workers.dev/s3cr3t/_host/app.aiawaaz.io/out/a.mp3');
  assert.equal(out.length, 3000);
});

test('the relay Worker forwards only with the secret and only to aiawaaz.io', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({url, auth: init.headers.get('authorization'), sid: init.headers.get('mcp-session-id')}); return new Response('{"ok":1}', {status: 200, headers: {'content-type': 'application/json', 'mcp-session-id': 'abc'}}); };
  try {
    const env = {RELAY_SECRET: 's3cr3t'};
    const post = (path, headers = {}) => worker.fetch(new Request(`https://relay.example.workers.dev${path}`, {method: 'POST', headers: {authorization: 'Bearer k', ...headers}, body: '{}'}), env);
    assert.equal((await post('/wrong/api/mcp')).status, 404);
    assert.equal((await post('/s3cr3t/_host/evil.com/x')).status, 403);
    const r = await post('/s3cr3t/api/mcp', {'mcp-session-id': 'abc'});
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('mcp-session-id'), 'abc');
    assert.deepEqual(seen[0], {url: 'https://app.aiawaaz.io/api/mcp', auth: 'Bearer k', sid: 'abc'});
    assert.equal((await worker.fetch(new Request('https://relay.example.workers.dev/s3cr3t/_host/cdn.aiawaaz.io/a.mp3'), env)).status, 200);
    assert.equal(seen[1].url, 'https://cdn.aiawaaz.io/a.mp3');
    assert.equal((await post('/s3cr3t/api/mcp', {}).catch(() => null)) !== null, true);
    assert.equal((await worker.fetch(new Request('https://r/x/api/mcp'), {})).status, 404); // no secret configured → closed
  } finally { globalThis.fetch = realFetch; }
});

import {mcpSynthesize, resetMcpSessions} from '../src/services/media/mcpTts.js';
test('a rejected AI Awaaz voice says which voice and how to fix it', async () => {
  resetMcpSessions?.();
  const reply = (id, result) => new Response(JSON.stringify({jsonrpc: '2.0', id, result}), {status: 200, headers: {'content-type': 'application/json'}});
  const fake = async (_u, init) => {
    const b = JSON.parse(init.body);
    if (b.method === 'initialize') return reply(b.id, {protocolVersion: '2025-06-18', capabilities: {}});
    if (!b.id) return new Response('', {status: 202});
    if (b.method === 'tools/list') return reply(b.id, {tools: [{name: 'generate_speech', description: 'text to speech', inputSchema: {type: 'object', properties: {text: {type: 'string'}, voice: {type: 'string', description: 'Voice reference such as hi_female_1 (see list_voices)'}}}}]});
    return reply(b.id, {isError: true, content: [{type: 'text', text: 'The voice reference format is invalid.'}]});
  };
  await assert.rejects(mcpSynthesize({url: 'https://voice-test.aiawaaz.io/api/mcp', apiKey: 'k', voice: 'Priya', language: 'hi', text: 'नमस्ते', sleep: async () => {}, gapMs: 0}, fake), /The saved voice is "Priya"\. AI Awaaz expects "voice": Voice reference such as hi_female_1 .*Connect & load voices/);
});

import {matchVoice} from '../src/services/media/mcpTts.js';
test('a saved voice name is turned into its AI Awaaz voice reference', async () => {
  const voices = [{id: 'platform:5316', name: 'Muskaan · hi'}, {id: 'mine:42', name: 'My clone'}];
  assert.equal(matchVoice(voices, 'Muskaan'), 'platform:5316');
  assert.equal(matchVoice(voices, 'muskaan'), 'platform:5316');
  assert.equal(matchVoice(voices, 'mine:42'), 'mine:42');
  assert.equal(matchVoice(voices, 'Nobody'), '');
  resetMcpSessions?.();
  const calls = [];
  const reply = (id, result) => new Response(JSON.stringify({jsonrpc: '2.0', id, result}), {status: 200, headers: {'content-type': 'application/json'}});
  const fake = async (_u, init) => {
    const b = JSON.parse(init.body);
    if (b.method === 'initialize') return reply(b.id, {protocolVersion: '2025-06-18', capabilities: {}});
    if (!b.id) return new Response('', {status: 202});
    if (b.method === 'tools/list') return reply(b.id, {tools: [
      {name: 'generate_speech', description: 'text to speech', inputSchema: {type: 'object', properties: {text: {type: 'string'}, voice: {type: 'string'}}}},
      {name: 'list_voices', description: 'voices', inputSchema: {type: 'object', properties: {language: {type: 'string'}}}}]});
    calls.push(b.params);
    if (b.params.name === 'list_voices') return reply(b.id, {structuredContent: {voices: [{voice: 'platform:5316', name: 'Muskaan', language: 'hi'}]}});
    return reply(b.id, {content: [{type: 'audio', data: Buffer.alloc(2000, 1).toString('base64'), mimeType: 'audio/mpeg'}]});
  };
  const audio = await mcpSynthesize({url: 'https://name-test.aiawaaz.io/api/mcp', apiKey: 'k', voice: 'Muskaan', language: 'hi', text: 'नमस्ते', sleep: async () => {}, gapMs: 0}, fake);
  assert.equal(audio.length, 2000);
  assert.equal(calls.at(-1).arguments.voice, 'platform:5316');
});
