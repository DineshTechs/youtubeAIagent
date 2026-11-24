import test from 'node:test';
import assert from 'node:assert/strict';
import {createBot,parseCommand} from '../src/services/telegram/botCommands.js';

function harness({profiles = [{id: 'p1', name: 'Kalyug', scheduleTime: '18:00'}], chat = '100'} = {}) {
  const sent = [], calls = [];
  const videos = {
    v1: {_id: 'v1', title: 'Honest woodcutter', status: 'AWAITING_APPROVAL', profile: {id: 'p1', name: 'Kalyug'}, renderPath: 'C:/x/final.mp4', createdAt: new Date().toISOString(), qa: {score: 91}},
    v2: {_id: 'v2', title: 'Approved one', status: 'APPROVED', profile: {id: 'p1', name: 'Kalyug'}, renderPath: 'C:/x/f2.mp4', createdAt: new Date(Date.now() - 1000).toISOString()},
    vx: {_id: 'vx', title: 'Other channel', status: 'APPROVED', profile: {id: 'p9', name: 'Other'}}
  };
  const api = async (method, path, body) => {
    calls.push({method, path, body});
    if (method === 'GET' && path.startsWith('/videos?')) { const q = new URLSearchParams(path.split('?')[1]); return Object.values(videos).filter(v => v.profile.id === q.get('seriesId') && (!q.get('status') || v.status === q.get('status'))); }
    if (method === 'GET' && path.startsWith('/videos/')) { const v = videos[path.split('/')[2]]; if (!v) throw new Error('Video not found'); return v; }
    if (method === 'GET' && path.startsWith('/autopilot/runs/')) { const r = {r1: {_id: 'r1', seriesId: 'p1', status: 'WAITING'}, r2: {_id: 'r2', seriesId: 'p1', status: 'GENERATING'}, r9: {_id: 'r9', seriesId: 'p9', status: 'WAITING'}}[path.split('/')[3]]; if (!r) throw new Error('Autopilot slot not found.'); return r; }
    if (path === '/agent/generate') return {jobId: 'j1', profile: {language: 'Hindi', format: 'Story Short', durationSec: 55}};
    if (path.startsWith('/youtube/preview/')) return {metadata: {title: 'SEO title', privacyStatus: 'private'}, youtube: {channelTitle: 'Kalyug TV'}, seoReport: {score: 90}, seo: {focusKeyword: 'kahani'}, problems: []};
    if (path.startsWith('/youtube/publish/')) return {status: body.schedule ? 'SCHEDULED' : 'PUBLISHED', url: 'https://www.youtube.com/watch?v=abc', metadata: {title: 'SEO title'}, seoReport: {score: 90}};
    if (method === 'DELETE') { delete videos[path.split('/')[2]]; return {ok: true}; }
    return {ok: true};
  };
  const tg = {
    send: async (chatId, text, markup) => { sent.push({type: 'send', chatId, text, markup}); return {message_id: sent.length}; },
    edit: async (chatId, id, text, markup) => { sent.push({type: 'edit', chatId, id, text, markup}); },
    answer: async (id, text) => { sent.push({type: 'answer', text}); },
    sendVideo: async (chatId, file, caption, markup) => { sent.push({type: 'video', chatId, file, caption, markup}); }
  };
  const scope = c => (String(c) === chat ? profiles : []);
  const bot = createBot({tg, api, scope});
  const msg = text => bot.handleUpdate({update_id: 1, message: {chat: {id: Number(chat)}, text, date: Math.floor(Date.now() / 1000)}});
  const press = (data, fromChat = chat) => bot.handleUpdate({update_id: 2, callback_query: {id: 'cb', data, message: {chat: {id: Number(fromChat)}, message_id: 7}}});
  const buttons = () => (sent.filter(s => s.markup).at(-1)?.markup.inline_keyboard || []).flat();
  const button = label => buttons().find(b => b.text.includes(label));
  return {sent, calls, msg, press, button, buttons, videos};
}

test('parses commands, including @botname suffix', () => {
  assert.deepEqual(parseCommand('/new@kalyug_bot  Honest woodcutter'), {cmd: 'new', args: 'Honest woodcutter'});
  assert.deepEqual(parseCommand('/Pending'), {cmd: 'pending', args: ''});
  assert.equal(parseCommand('hello'), null);
});

test('unauthorized chats cannot do anything and are told their chat ID', async () => {
  const other = harness({profiles: []});
  await other.msg('/new test');
  assert.equal(other.calls.length, 0);
  assert.match(other.sent[0].text, /not allowed[\s\S]*Chat ID/);
  await other.press('o:v1');
  assert.equal(other.calls.length, 0);
  await other.msg('just chatting');
  assert.equal(other.sent.filter(s => s.type === 'send').length, 1, 'plain messages from strangers get no reply');
});

test('/new creates a video with the profile; multiple profiles ask which', async () => {
  const one = harness();
  await one.msg('/new Honest woodcutter');
  assert.deepEqual(one.calls.find(c => c.path === '/agent/generate').body, {seriesId: 'p1', topic: 'Honest woodcutter'});
  assert.match(one.sent.at(-1).text, /Creating a video for <b>Kalyug<\/b>/);
  const two = harness({profiles: [{id: 'p1', name: 'Kalyug'}, {id: 'p2', name: 'Tech'}]});
  await two.msg('/new AI tools');
  assert.ok(!two.calls.some(c => c.path === '/agent/generate'));
  await two.press(two.button('Tech').callback_data);
  assert.deepEqual(two.calls.find(c => c.path === '/agent/generate').body, {seriesId: 'p2', topic: 'AI tools'});
  // The same button cannot be used twice.
  const before = two.calls.length;
  await two.press(two.buttons().find(b => b.text === 'Tech').callback_data);
  assert.equal(two.calls.filter(c => c.path === '/agent/generate').length, 1);
  assert.ok(two.calls.length >= before);
  assert.match(two.sent.at(-1).text, /expired/);
});

test('/pending lists only this profile\'s videos awaiting approval', async () => {
  const h = harness();
  await h.msg('/pending');
  const btns = h.buttons();
  assert.equal(btns.length, 1);
  assert.equal(btns[0].callback_data, 'o:v1');
  await h.msg('/recent');
  assert.deepEqual(h.buttons().map(b => b.callback_data), ['o:v1', 'o:v2']);
});

test('approve needs confirmation, then saves visual review and approves', async () => {
  const h = harness();
  await h.press('o:v1');
  assert.match(h.sent.at(-1).text, /Honest woodcutter[\s\S]*Awaiting approval/);
  await h.press(h.button('Approve').callback_data);
  assert.ok(!h.calls.some(c => c.path.endsWith('/approve')), 'not approved before confirming');
  assert.match(h.sent.at(-1).text, /This confirms you watched it/);
  await h.press(h.button('Yes, approve').callback_data);
  const paths = h.calls.filter(c => c.method === 'POST').map(c => c.path);
  assert.deepEqual(paths, ['/videos/v1/visual-review', '/videos/v1/approve']);
});

test('upload and schedule confirm with SEO title and channel', async () => {
  const h = harness();
  await h.press('o:v2');
  assert.ok(h.button('Schedule 18:00'));
  await h.press(h.button('Upload now').callback_data);
  assert.match(h.sent.at(-1).text, /Upload <b>SEO title<\/b> to <b>Kalyug TV<\/b> now as <b>private<\/b>[\s\S]*SEO 90\/100/);
  await h.press(h.button('Yes, upload').callback_data);
  assert.deepEqual(h.calls.find(c => c.path === '/youtube/publish/v2').body, {});
  assert.match(h.sent.at(-1).text, /Uploaded[\s\S]*youtube\.com/);
  await h.press('o:v2');
  await h.press(h.button('Schedule').callback_data);
  await h.press(h.button('Yes, upload').callback_data);
  assert.deepEqual(h.calls.filter(c => c.path === '/youtube/publish/v2').at(-1).body, {schedule: 'profile'});
});

test('delete is confirmed; videos of other profiles are refused', async () => {
  const h = harness();
  await h.press('o:v2');
  await h.press(h.button('Delete').callback_data);
  assert.match(h.sent.at(-1).text, /cannot be undone/);
  assert.ok(!h.calls.some(c => c.method === 'DELETE'));
  await h.press(h.button('Yes, delete').callback_data);
  assert.ok(h.calls.some(c => c.method === 'DELETE' && c.path === '/videos/v2'));
  await h.press('o:vx');
  assert.match(h.sent.at(-1).text, /does not belong to a profile this chat controls/);
  assert.ok(!h.calls.some(c => c.path.includes('vx') && c.method !== 'GET'));
});

test('send video attaches the rendered file', async () => {
  const h = harness();
  await h.press('o:v1');
  await h.press(h.button('Send video').callback_data);
  const v = h.sent.find(s => s.type === 'video');
  assert.equal(v.file, 'C:/x/final.mp4');
});

test('"✅ Approve" on the ready notification asks once, then approves (only this chat\'s videos)', async () => {
  const h = harness();
  await h.press('p:v1');
  assert.match(h.sent.filter(s => s.type === 'send').at(-1).text, /Approve <b>Honest woodcutter<\/b>\?/);
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0, 'nothing approved before confirming');
  await h.press(h.button('Yes, approve').callback_data);
  assert.ok(h.calls.find(c => c.method === 'POST' && c.path === '/videos/v1/approve'));
  assert.ok(h.calls.find(c => c.method === 'POST' && c.path === '/videos/v1/visual-review'));
  const done = harness();
  await done.press('p:v2');
  assert.match(done.sent.filter(s => s.type === 'send').at(-1).text, /approved — nothing to approve/);
  const stranger = harness();
  await stranger.press('p:vx');
  assert.equal(stranger.calls.filter(c => c.method === 'POST').length, 0, 'another profile\'s video is refused');
});

test('"Make a new video anyway" on an Autopilot waiting message asks first, then starts it', async () => {
  const h = harness();
  await h.press('w:r1');
  assert.match(h.sent.filter(s => s.type === 'send').at(-1).text, /even though the previous one is not published/);
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0, 'nothing started before confirming');
  await h.press(h.button('Yes, make it').callback_data);
  assert.ok(h.calls.find(c => c.method === 'POST' && c.path === '/autopilot/runs/r1/generate'));
  const busy = harness();
  await busy.press('W:r2');
  assert.match(busy.sent.filter(s => s.type === 'send').at(-1).text, /already generating/);
  const stranger = harness();
  await stranger.press('W:r9');
  assert.equal(stranger.calls.filter(c => c.method === 'POST').length, 0, 'another profile is refused');
});
