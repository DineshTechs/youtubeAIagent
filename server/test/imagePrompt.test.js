import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCleanImageRetryPrompt, fitPromptToProvider, promptLimitFor, CLEAN_IMAGE_CORRECTION} from '../src/utils/imagePrompt.js';

const longScenePrompt = ('A cinematic forest clearing at dawn, soft golden light through tall trees, a small fox looking at a glowing stone. ').repeat(17).slice(0, 1850);

test('OCR retry prompt fits Cloudflare limit (regression: 400 Length of /prompt must be <= 2048)', () => {
  const retry = buildCleanImageRetryPrompt(longScenePrompt, {maxChars: promptLimitFor('cloudflare')});
  assert.ok(retry.length <= 2048, `length ${retry.length}`);
  assert.ok(retry.startsWith(CLEAN_IMAGE_CORRECTION), 'correction must come first and never be cut');
  assert.ok(retry.includes('cinematic forest clearing'), 'keeps the scene description');
});

test('retry prompts do not grow across attempts because they rebuild from the original prompt', () => {
  const first = buildCleanImageRetryPrompt(longScenePrompt, {maxChars: 2000});
  const second = buildCleanImageRetryPrompt(longScenePrompt, {maxChars: 2000});
  assert.equal(first, second);
});

test('providers without a limit keep the full prompt', () => {
  const retry = buildCleanImageRetryPrompt(longScenePrompt, {maxChars: promptLimitFor('openai')});
  assert.ok(retry.endsWith(longScenePrompt.trim()));
  assert.equal(fitPromptToProvider('x'.repeat(5000), 'openai').length, 5000);
});

test('final guard trims any over-long Cloudflare prompt', () => {
  assert.ok(fitPromptToProvider('word '.repeat(1000), 'cloudflare').length <= 2048);
  assert.equal(fitPromptToProvider('short prompt', 'cloudflare'), 'short prompt');
});
