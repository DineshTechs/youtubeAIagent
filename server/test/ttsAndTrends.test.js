import test from 'node:test';
import assert from 'node:assert/strict';
import {azureSpeech,googleTts,elevenLabsTts,listVoices,chunkText,localeOfVoice} from '../src/services/media/freeTts.js';
import {createMcpClient,parseRpcBody,findTtsTool,buildTtsArgs,audioFromResult,mcpSynthesize,mcpDescribe,retryDelayMs,resetMcpSessions} from '../src/services/media/mcpTts.js';
import {parseTrendsRss,collectTrends,_clearTrendCache} from '../src/services/trends/trendSources.js';
import {normalizeTopicIdeas,trendInstruction,suggestTrendingTopics} from '../src/services/trends/trendTopics.js';

const MP3 = Buffer.alloc(3000, 7);
const audioResponse = () => new Response(MP3, {status: 200, headers: {'content-type': 'audio/mpeg'}});

test('Hindi text is split at danda / sentence ends within byte limits', () => {
  const s = 'यह पहला वाक्य है। '.repeat(200);
  const parts = chunkText(s, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(Buffer.byteLength(p) <= 1000);
  assert.ok(parts.every(p => p.endsWith('।')));
  assert.equal(chunkText('short').length, 1);
  assert.equal(localeOfVoice('hi-IN-SwaraNeural'), 'hi-IN');
});

test('Azure: SSML with Hindi voice, region endpoint and key header', async () => {
  let req;
  const audio = await azureSpeech({key: 'k', region: 'centralindia', voice: 'hi-IN-MadhurNeural', text: 'राम & श्याम <दोस्त>'}, async (url, init) => { req = {url, init}; return audioResponse(); });
  assert.equal(audio.length, MP3.length);
  assert.equal(req.url, 'https://centralindia.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(req.init.headers['Ocp-Apim-Subscription-Key'], 'k');
  assert.match(req.init.body, /xml:lang="hi-IN"/);
  assert.match(req.init.body, /<voice name="hi-IN-MadhurNeural">राम &amp; श्याम &lt;दोस्त&gt;<\/voice>/);
  await assert.rejects(azureSpeech({key: '', region: 'x', text: 'a'}), /key and region/);
  await assert.rejects(azureSpeech({key: 'k', region: 'r', text: 'a'}, async () => new Response('Unauthorized', {status: 401})), /Azure TTS: HTTP 401/);
});

test('Google: language from voice name, base64 audio decoded', async () => {
  let body;
  const audio = await googleTts({key: 'g', voice: 'hi-IN-Wavenet-B', text: 'नमस्ते'}, async (url, init) => { body = JSON.parse(init.body); assert.match(url, /key=g$/); return new Response(JSON.stringify({audioContent: MP3.toString('base64')})); });
  assert.deepEqual(body.voice, {languageCode: 'hi-IN', name: 'hi-IN-Wavenet-B'});
  assert.equal(body.audioConfig.audioEncoding, 'MP3');
  assert.equal(audio.length, MP3.length);
});

test('ElevenLabs: voice id in path, multilingual model', async () => {
  let req;
  await elevenLabsTts({key: 'e', voice: 'abc', text: 'नमस्ते'}, async (url, init) => { req = {url, body: JSON.parse(init.body), key: init.headers['xi-api-key']}; return audioResponse(); });
  assert.match(req.url, /\/v1\/text-to-speech\/abc\?output_format=mp3_44100_128$/);
  assert.equal(req.body.model_id, 'eleven_multilingual_v2');
  assert.equal(req.key, 'e');
});

test('voice lists are filtered to Hindi', async () => {
  const azure = await listVoices('azure', {key: 'k', region: 'eastus'}, {language: 'hi'}, async () => new Response(JSON.stringify([{ShortName: 'hi-IN-SwaraNeural', LocalName: 'स्वरा', Gender: 'Female', Locale: 'hi-IN'}, {ShortName: 'en-US-JennyNeural', LocalName: 'Jenny', Gender: 'Female', Locale: 'en-US'}])));
  assert.deepEqual(azure.map(v => v.id), ['hi-IN-SwaraNeural']);
  let url;
  await listVoices('google', {key: 'g'}, {language: 'hi'}, async u => { url = u; return new Response(JSON.stringify({voices: [{name: 'hi-IN-Wavenet-A', ssmlGender: 'FEMALE', languageCodes: ['hi-IN']}]})); });
  assert.match(url, /languageCode=hi-IN/);
});

// ---- AI Awaaz / MCP ----
function fakeMcp({tools, call, sse = false, requireAuth = 'secret'}) {
  const seen = [];
  const f = async (url, init) => {
    if (init?.method !== 'POST') return audioResponse();
    const body = JSON.parse(init.body);
    seen.push({method: body.method, headers: init.headers, params: body.params});
    if (init.headers.Authorization !== `Bearer ${requireAuth}`) return new Response('no', {status: 401});
    if (!body.id) return new Response(null, {status: 202});
    let result;
    if (body.method === 'initialize') result = {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'aiawaaz'}};
    if (body.method === 'tools/list') result = {tools};
    if (body.method === 'tools/call') result = call(body.params);
    const msg = JSON.stringify({jsonrpc: '2.0', id: body.id, result});
    const headers = {'content-type': sse ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'sess-1'};
    return new Response(sse ? `event: message\ndata: ${msg}\n\n` : msg, {status: 200, headers});
  };
  return {f, seen};
}
const tools = [
  {name: 'list_voices', description: 'List available voices', inputSchema: {properties: {language: {type: 'string'}}}},
  {name: 'speech_to_text', description: 'Transcribe audio', inputSchema: {properties: {audio_url: {}}}},
  {name: 'generate_voiceover', description: 'Text to speech: convert a script into a voiceover', inputSchema: {properties: {script: {type: 'string'}, voice_id: {type: 'string'}, language: {type: 'string'}, format: {enum: ['wav', 'mp3']}}}}
];

test('MCP: finds the speech tool and maps its arguments', () => {
  const t = findTtsTool(tools);
  assert.equal(t.name, 'generate_voiceover');
  assert.deepEqual(buildTtsArgs(t, {text: 'नमस्ते', voice: 'v1', language: 'hi'}), {script: 'नमस्ते', voice_id: 'v1', language: 'hi', format: 'mp3'});
  assert.equal(findTtsTool([{name: 'list_voices'}]), null);
  assert.equal(findTtsTool(tools, 'list_voices').name, 'list_voices', 'explicit tool wins');
});

test('MCP: initialize, session id, SSE replies, inline audio', async () => {
  const {f, seen} = fakeMcp({tools, sse: true, call: () => ({content: [{type: 'audio', data: MP3.toString('base64'), mimeType: 'audio/mpeg'}]})});
  const audio = await mcpSynthesize({url: 'https://app.aiawaaz.io/api/mcp', apiKey: 'secret', voice: 'platform:v1', language: 'hi', text: 'नमस्ते'}, f);
  assert.equal(audio.length, MP3.length);
  assert.deepEqual(seen.map(s => s.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(seen[2].headers['Mcp-Session-Id'], 'sess-1');
  assert.equal(seen[3].params.name, 'generate_voiceover');
  assert.equal(seen[3].params.arguments.voice_id, 'platform:v1');
});

test('MCP: audio returned as a download link or JSON base64', async () => {
  const link = await audioFromResult({content: [{type: 'text', text: 'Done! Download: https://cdn.aiawaaz.io/out/abc.mp3'}]}, async u => { assert.equal(u, 'https://cdn.aiawaaz.io/out/abc.mp3'); return audioResponse(); });
  assert.equal(link.length, MP3.length);
  const json = await audioFromResult({content: [{type: 'text', text: JSON.stringify({audio_url: 'https://x.io/a.wav'})}]}, async () => audioResponse());
  assert.equal(json.length, MP3.length);
  const b64 = await audioFromResult({structuredContent: {audio: MP3.toString('base64')}});
  assert.equal(b64.length, MP3.length);
  await assert.rejects(audioFromResult({content: [{type: 'text', text: 'Quota exceeded'}]}), /no audio \(Quota exceeded\)/);
});

test('MCP: wrong key and missing speech tool give clear errors', async () => {
  const {f} = fakeMcp({tools, call: () => ({})});
  await assert.rejects(mcpSynthesize({url: 'https://a/mcp', apiKey: 'wrong', text: 'x'}, f), /API key was rejected/);
  await assert.rejects(mcpSynthesize({url: 'https://a/mcp', apiKey: '', text: 'x'}, f), /add your AI Awaaz API key/);
  const {f: f2} = fakeMcp({tools: [tools[0]], call: () => ({})});
  await assert.rejects(mcpSynthesize({url: 'https://a/mcp', apiKey: 'secret', text: 'x'}, f2), /no text-to-speech tool found. The server offers: list_voices/);
  const {f: f3} = fakeMcp({tools, call: () => ({isError: true, content: [{type: 'text', text: 'Insufficient credits'}]})});
  await assert.rejects(mcpSynthesize({url: 'https://a/mcp', apiKey: 'secret', text: 'x'}, f3), /Insufficient credits/);
});

test('MCP: describe lists tools and voices', async () => {
  const {f} = fakeMcp({tools, call: p => p.name === 'list_voices' ? {content: [{type: 'text', text: JSON.stringify({voices: [{voice_id: 'hi_madhur', name: 'Madhur', language: 'Hindi'}]})}]} : {}});
  const d = await mcpDescribe({url: 'https://a/mcp', apiKey: 'secret'}, f);
  assert.equal(d.ttsTool, 'generate_voiceover');
  assert.equal(d.voicesTool, 'list_voices');
  assert.deepEqual(d.voices, [{id: 'hi_madhur', name: 'Madhur · Hindi'}]);
  assert.equal(parseRpcBody('data: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}', 'text/event-stream').result.ok, 1);
});

// ---- Trends ----
const RSS = `<?xml version="1.0"?><rss><channel><item><title>India vs Australia</title><ht:approx_traffic>500K+</ht:approx_traffic><pubDate>Sun, 22 Nov 2026 10:00:00 +0530</pubDate><ht:news_item><ht:news_item_title><![CDATA[India win thriller & series]]></ht:news_item_title></ht:news_item></item><item><title>दिवाली</title><ht:approx_traffic>200K+</ht:approx_traffic></item></channel></rss>`;

test('Google Trends RSS is parsed (CDATA, Hindi, traffic, news)', () => {
  const items = parseTrendsRss(RSS);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {title: 'India vs Australia', traffic: '500K+', published: 'Sun, 22 Nov 2026 10:00:00 +0530', news: ['India win thriller & series'], source: 'google-trends'});
  assert.equal(items[1].title, 'दिवाली');
});

test('trend sources: Google feed fallback URL and YouTube optional', async () => {
  _clearTrendCache();
  const urls = [];
  const f = async url => { urls.push(String(url)); if (String(url).includes('/trending/rss')) return new Response('down', {status: 404}); return new Response(RSS); };
  const t = await collectTrends({region: 'IN'}, f);
  assert.equal(t.google.length, 2);
  assert.deepEqual(t.youtube, []);
  assert.deepEqual(t.errors, [], 'no YouTube key -> not reported as an error');
  assert.ok(urls[0].includes('trending/rss?geo=IN') && urls[1].includes('trendingsearches/daily/rss?geo=IN'));
});

test('topic ideas: fit-sorted, no repeats of recent topics or avoided words', () => {
  const ideas = normalizeTopicIdeas({topics: [
    {topic: 'दिवाली पर ईमानदार दीयेवाले की कहानी', trend: 'दिवाली', fit: 80},
    {topic: 'Honest woodcutter and the golden axe', trend: 'evergreen', fit: 95},
    {topic: 'Election results explained', trend: 'election', fit: 70},
    {topic: 'x', fit: 99}
  ]}, {recentTopics: ['The honest woodcutter and his golden axe'], avoid: ['election'], count: 5});
  assert.deepEqual(ideas.map(i => i.topic), ['दिवाली पर ईमानदार दीयेवाले की कहानी']);
  const ins = trendInstruction({profile: {language: 'Hindi', editorial: {safetyMode: 'kids-and-family'}}, count: 5});
  assert.match(ins, /Write "topic" in Hindi/);
  assert.match(ins, /kids and families/);
  assert.match(ins, /Never exploit tragedies/);
});

test('suggestTrendingTopics gives the AI the profile, trends and recent topics', async () => {
  let seen;
  const provider = {generateJson: async (instr, input, label) => { seen = {input, label}; return {topics: [{topic: 'क्रिकेट से सीखें धैर्य', trend: 'India vs Australia', angle: 'Moral story about patience', fit: 88}]}; }};
  const ideas = await suggestTrendingTopics({provider, profile: {language: 'Hindi', niche: 'Moral stories'}, series: {name: 'Kalyug'}, trends: {google: parseTrendsRss(RSS), youtube: []}, recentTopics: ['old topic']});
  assert.equal(seen.label, 'trending-topics');
  assert.equal(seen.input.currentTrends.googleTrends[0].title, 'India vs Australia');
  assert.deepEqual(seen.input.recentTopics, ['old topic']);
  assert.equal(ideas[0].topic, 'क्रिकेट से सीखें धैर्य');
});

// AI Awaaz's documented tools: generate_speech (MP3 link, ≤5,000 chars), list_voices, enhance_for_v3, get_account.
const awaazTools = [
  {name: 'list_voices', description: 'Finds voices: V3, the library and your own clones.', inputSchema: {properties: {language: {type: 'string'}}}},
  {name: 'generate_speech', description: 'Makes an MP3 and gives the link. Up to 5,000 characters on V3.', inputSchema: {properties: {text: {type: 'string'}, voice_id: {type: 'string'}}}},
  {name: 'enhance_for_v3', description: 'Adds emotions like laughs and pauses for V3 voices.', inputSchema: {properties: {text: {type: 'string'}}}},
  {name: 'get_account', description: 'Shows your plan and characters left.', inputSchema: {properties: {}}}
];

test('AI Awaaz: Bearer auth only, generate_speech link, long text split under 5,000 characters', async () => {
  const calls = [];
  const {f, seen} = fakeMcp({tools: awaazTools, call: p => { calls.push(p); return {content: [{type: 'text', text: `Your MP3 is ready: https://app.aiawaaz.io/files/${calls.length}.mp3`}]}; }});
  const long = 'यह एक लंबा वाक्य है जो कहानी सुनाता है। '.repeat(200); // ~8,000 characters
  const audio = await mcpSynthesize({url: 'https://app.aiawaaz.io/api/mcp', apiKey: 'Bearer secret', voice: 'v3_hindi_1', text: long}, f);
  const speech = calls.filter(c => c.name === 'generate_speech');
  assert.equal(speech.length, 2);
  for (const c of speech) { assert.ok(c.arguments.text.length <= 5000); assert.equal(c.arguments.voice_id, 'v3_hindi_1'); }
  assert.equal(audio.length, MP3.length * 2);
  assert.equal(seen[0].headers.Authorization, 'Bearer secret', 'a pasted "Bearer " prefix is not doubled');
  assert.equal(seen[0].headers['X-API-Key'], undefined);
  assert.ok(!calls.some(c => c.name === 'enhance_for_v3'), 'no emotions unless switched on');
});

test('AI Awaaz: optional enhance_for_v3 before speaking; account shown in Settings', async () => {
  const calls = [];
  const {f} = fakeMcp({tools: awaazTools, call: p => {
    calls.push(p);
    if (p.name === 'enhance_for_v3') return {content: [{type: 'text', text: JSON.stringify({text: `[pause] ${p.arguments.text} [laughs]`})}]};
    if (p.name === 'get_account') return {structuredContent: {plan: 'Creator', characters_left: 41250}};
    if (p.name === 'list_voices') return {content: [{type: 'text', text: JSON.stringify([{id: 'v3_hindi_1', name: 'Aarav', language: 'Hindi'}])}]};
    return {content: [{type: 'text', text: 'https://app.aiawaaz.io/files/x.mp3'}]};
  }});
  await mcpSynthesize({url: 'https://a/mcp', apiKey: 'secret', text: 'नमस्ते दोस्तों', enhance: true}, f);
  assert.deepEqual(calls.map(c => c.name), ['enhance_for_v3', 'generate_speech']);
  assert.equal(calls[1].arguments.text, '[pause] नमस्ते दोस्तों [laughs]');
  const d = await mcpDescribe({url: 'https://a/mcp', apiKey: 'secret'}, f);
  assert.equal(d.ttsTool, 'generate_speech');
  assert.equal(d.enhanceTool, 'enhance_for_v3');
  assert.deepEqual(d.account, {plan: 'Creator', characters_left: 41250});
  assert.deepEqual(d.voices, [{id: 'v3_hindi_1', name: 'Aarav · Hindi'}]);
});

// ---- AI Awaaz rate limits ----
const audioCall = () => ({content: [{type: 'audio', data: MP3.toString('base64'), mimeType: 'audio/mpeg'}]});
test('MCP: one session for many scenes (connect + list tools once)', async () => {
  resetMcpSessions();
  const {f, seen} = fakeMcp({tools, call: audioCall});
  for (let i = 0; i < 6; i++) await mcpSynthesize({url: 'https://a/mcp', apiKey: 'secret', text: `दृश्य ${i}`, gapMs: 0}, f);
  const methods = seen.map(s => s.method);
  assert.equal(methods.filter(m => m === 'initialize').length, 1);
  assert.equal(methods.filter(m => m === 'tools/list').length, 1);
  assert.equal(methods.filter(m => m === 'tools/call').length, 6, '6 scenes = 6 speech calls + 3 setup requests, not 24');
});
test('MCP: Retry-After delay parsing', () => {
  assert.equal(retryDelayMs('5', 0), 5000);
  assert.equal(retryDelayMs('', 0), 2000);
  assert.equal(retryDelayMs(null, 2), 8000);
  assert.equal(retryDelayMs('999', 0), 60000, 'capped');
  assert.ok(retryDelayMs(new Date(Date.now() + 3000).toUTCString(), 0) > 1000);
});
test('MCP: waits and retries on 429, then succeeds', async () => {
  resetMcpSessions();
  const {f: inner, seen} = fakeMcp({tools, call: audioCall});
  let limited = 2; const waits = [];
  const f = async (url, init) => { const b = init?.body && JSON.parse(init.body); if (b?.method === 'tools/call' && limited-- > 0) return new Response('Too Many Requests', {status: 429, headers: {'retry-after': '3'}}); return inner(url, init); };
  const audio = await mcpSynthesize({url: 'https://a/mcp', apiKey: 'secret', text: 'x', gapMs: 0, sleep: async ms => { waits.push(ms); }}, f);
  assert.equal(audio.length, MP3.length);
  assert.deepEqual(waits, [3000, 3000]);
  assert.ok(seen.length >= 3);
});
test('MCP: gives a clear message when the limit does not clear', async () => {
  resetMcpSessions();
  const f = async () => new Response('Too Many Requests', {status: 429, headers: {'retry-after': '20'}});
  let n = 0;
  await assert.rejects(mcpSynthesize({url: 'https://a/mcp', apiKey: 'secret', text: 'x', gapMs: 0, sleep: async () => { n++; }}, f), e => e.status === 429 && /rate limit reached/.test(e.message) && /20 seconds/.test(e.message));
  assert.equal(n, 3, 'three waits before giving up');
});
test('MCP: Connect & load voices clicked twice within a minute sends nothing the second time', async () => {
  resetMcpSessions();
  const {f, seen} = fakeMcp({tools, call: () => ({content: [{type: 'text', text: '[]'}]})});
  await mcpDescribe({url: 'https://a/mcp', apiKey: 'secret', gapMs: 0}, f);
  const first = seen.length;
  await mcpDescribe({url: 'https://a/mcp', apiKey: 'secret', gapMs: 0}, f);
  assert.equal(seen.length, first);
});
test('MCP: reconnects once when the server drops the session', async () => {
  resetMcpSessions();
  const {f: inner, seen} = fakeMcp({tools, call: audioCall});
  let calls = 0;
  const f = async (url, init) => { const b = init?.body && JSON.parse(init.body); if (b?.method === 'tools/call' && ++calls === 2) return new Response('session not found', {status: 404}); return inner(url, init); };
  await mcpSynthesize({url: 'https://a/mcp', apiKey: 'secret', text: 'a', gapMs: 0}, f);
  await mcpSynthesize({url: 'https://a/mcp', apiKey: 'secret', text: 'b', gapMs: 0}, f);
  assert.equal(seen.filter(s => s.method === 'initialize').length, 2);
});
