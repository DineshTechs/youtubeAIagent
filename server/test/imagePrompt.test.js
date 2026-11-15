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

import {buildSceneImagePrompt, cleanVisualText} from '../src/utils/imagePrompt.js';

const profile = {niche: 'Motivation shorts in Hindi', visual: {style: 'cinematic realism', aspectRatio: '9:16'}};

test('scene image prompt never contains the channel niche or "YouTube" (regression: FLUX drew "Motivation ... in hindi")', () => {
  const prompt = buildSceneImagePrompt({scene: {sceneNumber: 1, visualPrompt: 'A runner at sunrise on an empty road, YouTube thumbnail style'}, channelProfile: profile, series: {niche: 'Motivation shorts in Hindi'}});
  assert.doesNotMatch(prompt, /motivation shorts|in hindi|youtube|thumbnail/i);
  assert.match(prompt, /A runner at sunrise on an empty road/);
  assert.match(prompt, /^Create one original 9:16 image\./);
  assert.match(prompt, /ABSOLUTELY NO VISIBLE TEXT/);
  assert.ok(prompt.length <= 1850);
});

test('quoted phrases (any script) are removed so they are not drawn as lettering', () => {
  assert.equal(cleanVisualText('A poster on the wall reading "Never Give Up", rain outside'), 'A poster on the wall , rain outside');
  assert.doesNotMatch(cleanVisualText('a sign that says “कभी हार मत मानो” near a door'), /कभी|says/);
  assert.equal(cleanVisualText("the hero's quiet room"), "the hero's quiet room", 'apostrophes are kept');
});

test('Hindi visual descriptions without quotes are kept intact', () => {
  assert.equal(cleanVisualText('एक लड़का पहाड़ पर दौड़ रहा है'), 'एक लड़का पहाड़ पर दौड़ रहा है');
});

test('legacy scene 1 prompt with embedded hook sentence produces a prompt without the hook words (regression)', () => {
  const legacy = 'A young man sitting alone on a rooftop at dusk\nOpening hook: क्या आप भी हार मानने वाले हैं? Hook text here. The opening frame should immediately communicate this curiosity hook while matching the first scene\'s narrated action.';
  const prompt = buildSceneImagePrompt({scene: {sceneNumber: 1, visualPrompt: legacy}, channelProfile: profile});
  assert.doesNotMatch(prompt, /Opening hook|hook text|curiosity hook|[ऀ-ॿ]/iu);
  assert.match(prompt, /A young man sitting alone on a rooftop at dusk/);
});

test('overlay / on-screen text wording is removed from visual descriptions', () => {
  const out = cleanVisualText('Close-up of a determined face with bold text overlay, on-screen text appears, rain falling');
  assert.doesNotMatch(out, /overlay|on-screen text/i);
  assert.match(out, /determined face/);
  assert.match(cleanVisualText('a fisherman holding a fishing hook'), /fishing hook/);
});

import {promptStyleFor, FLUX_RETRY_SUFFIX} from '../src/utils/imagePrompt.js';

const fluxScene = {sceneNumber: 1, visualPrompt: 'A determined young man running up stone stairs at sunrise, a motivational poster reading "Never Quit" on a wall, city skyline behind\nOpening hook: क्या आप तैयार हैं? The opening frame should immediately communicate this curiosity hook while matching the first scene\'s narrated action.'};
const INSTRUCTION_WORDS = /\b(text|letters?|words?|captions?|subtitles?|typography|logos?|watermarks?|clean|correction|strict|absolutely|hook)\b/i;

test('Cloudflare and Pollinations-flux use FLUX style; OpenAI and Gemini keep the standard prompt', () => {
  assert.equal(promptStyleFor('cloudflare'), 'flux');
  assert.equal(promptStyleFor('pollinations', 'flux'), 'flux');
  assert.equal(promptStyleFor('pollinations', 'google/gemini-nano-banana-2.1'), 'standard');
  assert.equal(promptStyleFor('openai'), 'standard');
  assert.equal(promptStyleFor('gemini'), 'standard');
});

test('FLUX prompt is descriptive only: no capitalised rules or text-inviting words (regression: "CLEAN WOUR" drawn)', () => {
  const prompt = buildSceneImagePrompt({scene: fluxScene, channelProfile: profile, promptStyle: 'flux'});
  assert.doesNotMatch(prompt, INSTRUCTION_WORDS);
  assert.doesNotMatch(prompt, /[A-Z]{4,}/, 'no ALL-CAPS instructions');
  assert.doesNotMatch(prompt, /[ऀ-ॿ]|Never Quit|motivation shorts|youtube/iu);
  assert.match(prompt, /determined young man running up stone stairs at sunrise/);
  assert.match(prompt, /Plain unmarked surfaces/);
  assert.match(prompt, /plain framed artwork on a wall/);
  assert.doesNotMatch(prompt, /poster/i);
  assert.ok(prompt.length <= 1850);
});

test('FLUX retry adds no correction words and stays under the Cloudflare limit', () => {
  const base = buildSceneImagePrompt({scene: fluxScene, channelProfile: profile, promptStyle: 'flux'});
  const retry = buildCleanImageRetryPrompt(base, {maxChars: promptLimitFor('cloudflare'), promptStyle: 'flux'});
  assert.doesNotMatch(retry, INSTRUCTION_WORDS);
  assert.ok(retry.endsWith(FLUX_RETRY_SUFFIX));
  assert.ok(retry.length <= 2048);
  const longRetry = buildCleanImageRetryPrompt('word '.repeat(600), {maxChars: 2000, promptStyle: 'flux'});
  assert.ok(longRetry.length <= 2000);
});

test('standard (OpenAI/Gemini) prompt keeps its explicit no-text rule', () => {
  const prompt = buildSceneImagePrompt({scene: fluxScene, channelProfile: profile});
  assert.match(prompt, /ABSOLUTELY NO VISIBLE TEXT/);
  assert.doesNotMatch(prompt, /[ऀ-ॿ]|Never Quit/u);
});
