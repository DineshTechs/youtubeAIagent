import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVisualPlan, isEnglishVisualText, stripEditingDirections, englishStillStyle, isCurrentVisualPlan, buildVisualDirectorInstruction, VISUAL_PLAN_VERSION} from '../src/utils/visualPlan.js';
import {buildSceneImagePrompt} from '../src/utils/imagePrompt.js';

// Real data from the user's Hindi video "सफलता के 5 कदम" (2026-11-16).
const hindiScenes = [
  {sceneNumber: 2, narration: 'सफलता का पहला कदम है लक्ष्य को स्पष्ट रूप से परिभाषित करना।', visualPrompt: 'मध्यम शॉट, व्यक्ति डेस्क पर नोटपैड के साथ, हाथ में पेन, नोट्स लिखते हुए'},
  {sceneNumber: 4, narration: 'तीसरा कदम है पोमोडोरो तकनीक अपनाना, 25 मिनट का फोकस।', visualPrompt: 'क्लोज‑अप शॉट, व्यक्ति अपने मोबाइल पर टाइमर सेट कर रहा है'}
];
const hindiProfile = {language: 'Hindi', visual: {style: 'साधारण पृष्ठभूमि, बोल्ड टेक्स्ट ओवरले, तेज़ ट्रांज़िशन', aspectRatio: '9:16'}};

test('Hindi text is not accepted as an image description; English is', () => {
  assert.equal(isEnglishVisualText(hindiScenes[0].visualPrompt), false);
  assert.equal(isEnglishVisualText('Medium shot of a young man at a desk writing his goal on a notepad'), true);
});

test('a Hindi Visual Director plan is rejected (so the worker retries in English)', () => {
  const hindiPlan = {scenes: hindiScenes.map(s => ({sceneNumber: s.sceneNumber, visualPrompt: s.visualPrompt}))};
  assert.throws(() => normalizeVisualPlan(hindiPlan, hindiScenes), /non-English/);
});

test('an English v2 plan is accepted, with narration meaning and editing directions removed', () => {
  const plan = normalizeVisualPlan({visualStyle: 'Bright minimal backgrounds, quick zooms on speaker face, bold text overlay', scenes: [
    {sceneNumber: 2, narrationMeaning: 'The first step to success is defining your goal clearly.', visualPrompt: 'Medium shot of a young man at a tidy desk writing one clear goal in a notepad, morning light; camera zooms in on the pen then cuts to a bold text overlay of the goal'},
    {sceneNumber: 4, narrationMeaning: 'Use the Pomodoro technique: 25 minutes of focus.', visualPrompt: 'Close-up of a hand starting a kitchen tomato timer on a desk beside an open laptop, focused mood'}]}, hindiScenes);
  assert.equal(plan.version, VISUAL_PLAN_VERSION);
  assert.equal(plan.scenes[0].narrationMeaning, 'The first step to success is defining your goal clearly.');
  assert.doesNotMatch(plan.scenes[0].visualPrompt, /zoom|cuts to|overlay/i);
  assert.match(plan.scenes[0].visualPrompt, /writing one clear goal in a notepad/);
  assert.doesNotMatch(plan.visualStyle, /zoom|overlay/i);
  assert.equal(isCurrentVisualPlan(plan, 2), true);
});

test('old v1 plans and Hindi plans are not reused', () => {
  assert.equal(isCurrentVisualPlan({version: 1, scenes: [{visualPrompt: 'A man at a desk writing in a notebook'}]}, 1), false);
  assert.equal(isCurrentVisualPlan({version: 2, scenes: [{visualPrompt: hindiScenes[0].visualPrompt}]}, 1), false);
});

test('editing directions from real prompts are removed', () => {
  const real = 'Close‑up of a young professional with a laptop, looking slightly distracted; camera zooms in on their face as they stare at the screen, then cuts to a bold text overlay of the hook';
  const out = stripEditingDirections(real);
  assert.match(out, /young professional with a laptop, looking slightly distracted/);
  assert.doesNotMatch(out, /zoom|cuts to|overlay/i);
  assert.equal(englishStillStyle('Bright colors, bold, minimalistic background, quick zooms on speaker’s face'), 'Bright colors, bold, minimalistic background');
  assert.equal(englishStillStyle(hindiProfile.visual.style), 'cinematic, high-quality visuals');
});

test('FLUX prompt for a Hindi scene uses the English plan and narration meaning, with no Hindi', () => {
  const plan = {version: 2, visualStyle: 'clean bright realistic photography', scenes: [{sceneNumber: 2, narrationMeaning: 'The first step to success is defining your goal clearly.', visualPrompt: 'Medium shot of a young man at a tidy desk writing one clear goal in a notepad, morning light'}]};
  const prompt = buildSceneImagePrompt({scene: hindiScenes[0], visualPlan: plan, channelProfile: hindiProfile, promptStyle: 'flux'});
  assert.match(prompt, /writing one clear goal in a notepad/);
  assert.match(prompt, /illustrates: The first step to success is defining your goal clearly/);
  assert.match(prompt, /clean bright realistic photography/);
  assert.doesNotMatch(prompt, /[ऀ-ॿ]/u);
});

test('Visual Director instruction demands English, one still frame and narration grounding', () => {
  const ins = buildVisualDirectorInstruction(hindiProfile, {});
  assert.match(ins, /ALL OUTPUT FIELDS MUST BE IN ENGLISH/);
  assert.match(ins, /single still frame/);
  assert.match(ins, /narrationMeaning/);
  assert.match(buildVisualDirectorInstruction(hindiProfile, {}, {strict: true}), /non-English/);
});
