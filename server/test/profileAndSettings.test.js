import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChannelProfile, normalizeDuration, normalizeHookStyle} from '../src/services/channelProfile.js';
import {buildSubtitleStyle} from '../src/services/video/renderer.js';

const series = {name: 'Motivation Hindi', premise: 'Daily motivation', niche: 'Motivation', language: 'English',
  channelProfile: {language: 'Hindi', content: {primaryFormat: 'Story Short', tone: 'Inspiring', hookStyle: 'Question', durationSec: 45}, visual: {style: 'cinematic realism', aspectRatio: '9:16'}, narration: {voiceStyle: 'Warm'}, audience: {description: 'Young adults'}}};

test('saved profile carries per-video defaults: duration, hook, format, language', () => {
  const p = buildChannelProfile(series);
  assert.equal(p.content.durationSec, 45);
  assert.equal(p.content.hookStyle, 'Question');
  assert.equal(p.content.primaryFormat, 'Story Short');
  assert.equal(p.language, 'Hindi');
  assert.equal(p.narration.voiceStyle, 'Warm');
});

test('profiles saved before durationSec existed default to 55 s and Curiosity', () => {
  const p = buildChannelProfile({name: 'Old', premise: 'x', channelProfile: {content: {primaryFormat: 'Explainer'}}});
  assert.equal(p.content.durationSec, 55);
  assert.equal(p.content.hookStyle, 'Curiosity');
});

test('duration and hook style are normalised', () => {
  assert.equal(normalizeDuration(5), 20);
  assert.equal(normalizeDuration(999), 180);
  assert.equal(normalizeDuration('abc'), 55);
  assert.equal(normalizeHookStyle('surprise'), 'Surprise');
  assert.equal(normalizeHookStyle('weird'), 'Curiosity');
});

test('default subtitle style reproduces the previous placement (bottom-centre, ~7% margin, ~6 units)', () => {
  const {summary, forceStyle} = buildSubtitleStyle({width: 1080, height: 1920});
  assert.equal(summary.alignment, 2);
  assert.equal(summary.assMarginV, 20);
  assert.ok(Math.abs(summary.assFontSize - 6) < 0.5);
  assert.match(forceStyle, /FontName=Nirmala UI/);
});

test('subtitle settings change size, font and position', () => {
  const top = buildSubtitleStyle({fontSizePx: 48, fontName: 'Mangal', position: 'top', offsetPct: 12});
  assert.equal(top.summary.alignment, 6);
  assert.equal(top.summary.assMarginV, 35);
  assert.ok(top.summary.assFontSize > 7);
  assert.match(top.forceStyle, /FontName=Mangal/);
  assert.equal(buildSubtitleStyle({position: 'center'}).summary.alignment, 10);
});

test('font name cannot break the FFmpeg filter string', () => {
  const s = buildSubtitleStyle({fontName: "Evil',Font:x\\y"});
  assert.doesNotMatch(s.forceStyle, /FontName=[^,]*[':\\]/);
});
