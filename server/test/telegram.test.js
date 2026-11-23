import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {_setKeyForTests,encryptSecret} from '../src/services/secretBox.js';
import {EVENTS,eventSettings,formatMessage,shouldSend,publicSettings,esc} from '../src/services/telegram/telegramFormat.js';
import {sendMessage,sendVideo,getMe,chatsFromUpdates,validToken} from '../src/services/telegram/telegramApi.js';
import {publicSeries} from '../src/services/youtube/youtubeAccount.js';

_setKeyForTests(crypto.randomBytes(32));
const TOKEN = '123456789:AAH-abcdefghijklmnopqrstuvwxyz012345';

test('per-profile event switches and defaults', () => {
  const ev = eventSettings({cancelled: true, ready: false, bogus: true});
  assert.equal(ev.cancelled, true);
  assert.equal(ev.ready, false);
  assert.equal(ev.approved, true);
  assert.equal(ev.retried, false);
  assert.ok(!('bogus' in ev));
  const tg = {enabled: true, chats: [{chatId: '1'}], events: {ready: false}};
  assert.equal(shouldSend(tg, 'approved'), true);
  assert.equal(shouldSend(tg, 'ready'), false);
  assert.equal(shouldSend(tg, 'nope'), false);
  assert.equal(shouldSend({...tg, enabled: false}, 'approved'), false);
  assert.equal(shouldSend({...tg, chats: []}, 'approved'), false);
  assert.equal(shouldSend(undefined, 'approved'), false);
  assert.equal(EVENTS.length, 10);
});

test('messages are HTML-escaped and carry useful context', () => {
  const ready = formatMessage('ready', {title: 'Kids <3 & stories', profileName: 'Kalyug', durationSec: 54.6, qaScore: 92});
  assert.match(ready, /^✅ <b>Ready for review<\/b>/);
  assert.match(ready, /Kids &lt;3 &amp; stories/);
  assert.match(ready, /Profile: Kalyug · 55 s · QA 92\/100/);
  const sched = formatMessage('uploaded', {title: 'T', channelTitle: 'Kalyug', scheduledAt: '2026-11-19T12:30:00Z', url: 'https://youtu.be/x', seoScore: 90});
  assert.match(sched, /Scheduled on YouTube/);
  assert.match(sched, /19 Nov 2026, 6:00 pm/i);
  assert.match(sched, /https:\/\/youtu\.be\/x/);
  const failed = formatMessage('failed', {title: 'T', message: 'Scene 3 <bad>'});
  assert.match(failed, /<i>Scene 3 &lt;bad&gt;<\/i>/);
  assert.doesNotMatch(formatMessage('approved', {title: 'T', message: 'secret detail'}), /secret detail/);
  assert.equal(esc('<a>'), '&lt;a&gt;');
});

test('bot token never appears in the public view of a profile', () => {
  const tg = {enabled: true, botToken: encryptSecret(TOKEN), botUsername: 'kalyug_bot', chats: [{chatId: '-1001', title: 'Team'}], events: {}};
  const view = publicSettings(tg);
  assert.equal(view.hasToken, true);
  assert.equal(view.botUsername, 'kalyug_bot');
  assert.equal(view.events.ready, true);
  const text = JSON.stringify(publicSeries({name: 'K', telegram: tg}));
  assert.ok(!text.includes(TOKEN) && !text.includes('AAH-abc'));
  assert.equal(publicSettings({}).hasToken, false);
});

test('Telegram API calls are well formed and errors do not leak the token', async () => {
  assert.equal(validToken(TOKEN), true);
  assert.equal(validToken('abc'), false);
  const calls = [];
  const ok = async (url, init) => { calls.push({url, init}); return new Response(JSON.stringify({ok: true, result: {username: 'kalyug_bot', message_id: 1}}), {status: 200}); };
  assert.equal((await getMe(TOKEN, ok)).username, 'kalyug_bot');
  await sendMessage(TOKEN, '-1001', '<b>Hi</b>', ok);
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.chat_id, '-1001');
  assert.equal(body.parse_mode, 'HTML');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-')), 'final.mp4');
  fs.writeFileSync(file, Buffer.alloc(2048));
  await sendVideo(TOKEN, '42', file, 'caption', ok);
  const form = calls[2].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('chat_id'), '42');
  assert.equal(form.get('video').size, 2048);
  const bad = async () => new Response(JSON.stringify({ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user'}), {status: 403});
  await assert.rejects(sendMessage(TOKEN, '1', 'x', bad), e => /blocked by the user/.test(e.message) && !e.message.includes(TOKEN));
  await assert.rejects(getMe('nope', ok), /invalid/);
  const chats = chatsFromUpdates([{message: {chat: {id: 5, type: 'private', first_name: 'Ravi'}}}, {my_chat_member: {chat: {id: -100, type: 'supergroup', title: 'Team'}}}, {message: {chat: {id: 5, type: 'private', first_name: 'Ravi'}}}]);
  assert.deepEqual(chats, [{chatId: '5', title: 'Ravi', type: 'private'}, {chatId: '-100', title: 'Team', type: 'supergroup'}]);
});

test('scene image falls back to a file when the photo is rejected', async () => {
  const {sendImage} = await import('../src/services/telegram/telegramApi.js');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'img-')), 'scene-001.png');
  fs.writeFileSync(file, Buffer.alloc(1000));
  const methods = [];
  const f = async url => { const m = String(url).split('/').pop(); methods.push(m); return m === 'sendPhoto' ? new Response(JSON.stringify({ok: false, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS'}), {status: 400}) : new Response(JSON.stringify({ok: true, result: {}}), {status: 200}); };
  await sendImage(TOKEN, '1', file, 'Scene 1', f, {reply_markup: {inline_keyboard: [[{text: 'Render', callback_data: 'r:x'}]]}});
  assert.deepEqual(methods, ['sendPhoto', 'sendDocument']);
  await assert.rejects(sendImage(TOKEN, '1', file + '.missing', 'x', f), /ENOENT/);
});
