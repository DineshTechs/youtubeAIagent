import test from 'node:test';
import assert from 'node:assert/strict';
import {redactText, redactDeep, safeFileStem, isSecretKey} from './redact.js';

test('masks secrets embedded inside log text', () => {
  const log = 'Gemini failed: https://generativelanguage.googleapis.com/v1beta/x?key=AIzaSyA1234567890abcdefghijklmnopqrstu&alt=json '
    + 'db=mongodb+srv://admin:hunter2@cluster0.abc.mongodb.net/yt Authorization: Bearer sk-proj-ABCDEFGHIJKLMNOPQRSTUV '
    + 'OPENAI_API_KEY=sk-live1234567890abcdef groq gsk_ABCDEFGHIJKLMNOPQRSTUVWX cookie: sid=abc123; theme=dark';
  const out = redactText(log);
  for (const secret of ['AIzaSyA1234567890', 'hunter2', 'admin:', 'sk-proj-ABCDEF', 'sk-live123', 'gsk_ABCDEF', 'sid=abc123']) {
    assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
  }
  assert.ok(out.includes('&alt=json'), 'keeps non-secret query params');
  assert.ok(out.includes('Gemini failed'), 'keeps the useful error text');
});

test('redacts secret fields and secret text in nested objects', () => {
  const out = redactDeep({apiKey: 'x', nested: {password: 'p', message: 'url https://u:pw@host/x'}, logs: [{message: 'Bearer abcdefghijklmnop'}]});
  assert.equal(out.apiKey, '[REDACTED]');
  assert.equal(out.nested.password, '[REDACTED]');
  assert.ok(!JSON.stringify(out).includes('pw@'));
  assert.ok(!JSON.stringify(out).includes('abcdefghijklmnop'));
});

test('does not redact harmless fields such as token counts or QA numbers', () => {
  assert.equal(isSecretKey('maxOutputTokens'), false);
  assert.equal(isSecretKey('tokenCount'), false);
  assert.equal(isSecretKey('silenceDurationSec'), false);
  assert.equal(isSecretKey('accessToken'), true);
  const out = redactDeep({maxOutputTokens: 2600, qa: {score: 81, message: 'Detected approximately 3.4 seconds of silence'}});
  assert.equal(out.maxOutputTokens, 2600);
  assert.equal(out.qa.message, 'Detected approximately 3.4 seconds of silence');
});

test('keeps Hindi text intact', () => {
  assert.equal(redactText('एक बार की बात है'), 'एक बार की बात है');
});

test('export filenames keep Hindi titles and strip Windows-unsafe characters', () => {
  assert.equal(safeFileStem('जादुई जंगल की कहानी'), 'जादुई_जंगल_की_कहानी');
  assert.equal(safeFileStem('My: video/<test>?'), 'My_video_test');
  assert.equal(safeFileStem('???', 'abc123'), 'abc123');
  assert.ok(Array.from(safeFileStem('क'.repeat(100))).length <= 60);
});
