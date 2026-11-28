import test from 'node:test';
import assert from 'node:assert/strict';
import {LEAD_IN_SECONDS, engagementSettings, motionFilter, onScreenHook, defaultCta, overlayAss} from '../src/utils/engagement.js';
import {judgeOpening} from '../src/services/media/narrationCheck.js';

test('a short pause comes before the first word', () => {
  assert.ok(LEAD_IN_SECONDS >= 0.3 && LEAD_IN_SECONDS <= 0.6);
});

test('engagement extras are on by default and can be turned off', () => {
  assert.deepEqual(engagementSettings(undefined), {motion: true, hookTitle: true, progressBar: true, endCta: true, ctaText: ''});
  const off = engagementSettings({motion: false, hookTitle: false, progressBar: false, endCta: false, ctaText: '  Hi   there '});
  assert.equal(off.motion || off.hookTitle || off.progressBar || off.endCta, false);
  assert.equal(off.ctaText, 'Hi there');
});

test('consecutive scenes move differently and output keeps the frame size', () => {
  const f = [0, 1, 2, 3].map(i => motionFilter(i, {width: 1080, height: 1920, fps: 30, duration: 5}));
  assert.equal(new Set(f).size, 4);
  for (const x of f) assert.match(x, /zoompan=.*s=1080x1920:fps=30/);
  assert.equal(motionFilter(4, {width: 1080, height: 1920, fps: 30, duration: 5}), f[0]);
});

test('on-screen hook uses the first hook sentence, else the title, and stays short', () => {
  assert.equal(onScreenHook({hook: 'क्या आप जानते हैं? यह कहानी बहुत पुरानी है।', title: 'T'}), 'क्या आप जानते हैं?');
  assert.equal(onScreenHook({hook: 'x'.repeat(120), title: 'Short title'}), 'Short title');
  assert.ok(onScreenHook({hook: 'word '.repeat(40), title: 'y'.repeat(100)}).length <= 71);
});

test('follow reminder default follows the language', () => {
  assert.match(defaultCta('Hindi'), /फ़ॉलो/);
  assert.match(defaultCta('English'), /Follow/);
});

test('overlay places hook at the start and reminder at the end, away from top captions', () => {
  const ass = overlayAss({hookText: 'क्या {आप} जानते हैं?', hookEnd: 3, ctaText: 'Follow', total: 40, captionsAt: 'bottom'});
  assert.match(ass, /Dialogue: 0,0:00:00\.10,0:00:03\.00,Hook/);
  assert.match(ass, /Dialogue: 0,0:00:37\.00,0:00:39\.95,Cta/);
  assert.ok(!ass.includes('{आप}'), 'braces from the text are removed');
  assert.match(ass, /Style: Hook,[^\n]*,8,/);
  assert.match(overlayAss({hookText: 'x', captionsAt: 'top'}), /Style: Hook,[^\n]*,5,/);
  assert.ok(!overlayAss({hookText: '', ctaText: 'Follow', total: 40}).includes('Hook,,'));
  assert.equal(overlayAss({hookText: '', ctaText: 'Follow', total: 5}), '');
});

test('opening check notices a clipped first word', () => {
  const scenes = [{narration: 'क्या आपने कभी सोचा है कि राजा ने ऐसा क्यों किया?'}, {narration: 'राजा की कहानी आगे बढ़ती है।'}];
  const ok = judgeOpening({scenes, transcript: 'क्या आपने कभी सोचा है कि राजा ने ऐसा क्यों किया'});
  assert.equal(ok.complete, true); assert.ok(!ok.warnings.some(w => w.includes('first word')));
  const clipped = judgeOpening({scenes, transcript: 'या आपने कभी सोचा है कि राजा ने ऐसा क्यों किया'});
  assert.ok(clipped.warnings.some(w => w.includes('क्या')), JSON.stringify(clipped));
  const wrong = judgeOpening({scenes, transcript: 'बिल्कुल अलग बात जो यहाँ नहीं है राजा ने ऐसा क्यों किया'});
  assert.ok(wrong.warnings.some(w => w.includes('first word')) || wrong.complete === false);
});

