import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
  // FLUX drew short idea sentences as lettering ("Set clear goals"), so they stay out.
  assert.doesNotMatch(prompt, /illustrates|defining your goal/);
  assert.match(prompt, /clean bright realistic photography/);
  assert.doesNotMatch(prompt, /[ऀ-ॿ]/u);
});

test('Visual Director instruction demands English, one still frame and narration grounding', () => {
  const ins = buildVisualDirectorInstruction(hindiProfile, {});
  assert.match(ins, /ALL OUTPUT FIELDS MUST BE IN ENGLISH/);
  assert.match(ins, /ONE moment in ONE place/);
  assert.match(ins, /keyIdea/);
  assert.match(ins, /Indian people/, 'Hindi channel: Indian people and places');
  assert.match(ins, /narrationMeaning/);
  assert.match(buildVisualDirectorInstruction(hindiProfile, {}, {strict: true}), /non-English/);
});

test('v3 plans reject images that need written words, numbers or screens', async () => {
  const {findTextRequests, removeTextRequests, normalizeVisualPlan, VISUAL_PLAN_VERSION} = await import('../src/utils/visualPlan.js');
  assert.ok(VISUAL_PLAN_VERSION >= 3);
  // The exact prompts that produced off-topic images in the "सफलता के 5 कदम" video.
  for (const bad of [
    'A confident man ascends a staircase of five metal steps, each stamped with numbers 1 to 5.',
    'Medium shot of a professional beside a whiteboard, writing a detailed task list with a marker, check marks beside each item',
    'Close-up of a hand holding a smartphone, setting a 25-minute timer on the screen, desk items blurred',
    'Close-up of the professional before a large conference screen showing the word SUCCESS, holding a pen',
    'A shop sign reading "OPEN" above the door',
    // 2026-11-23 rebuild: drawn as "Set clear goals" / calendar lists / banners.
    'A young adult in a home office writes a bold, clear goal on a whiteboard with a marker',
    'A young adult by a window with a faint reflection of a calendar page showing a goal list on the glass',
    'A diverse group of people stand together holding a banner, with a sunrise in the background'
  ]) assert.ok(findTextRequests(bad).length, bad);
  for (const good of [
    'A person climbing a sunlit stone staircase toward a summit',
    'Hands sorting a big pile of colourful blocks into small neat stacks',
    'Medium shot of a young professional seated at a desk, writing in a notebook with a pen',
    'A DSLR camera on a tripod in a NASA control room',
    'An old woodcutter kneels by a river at sunset holding a golden axe'
  ]) assert.deepEqual(findTextRequests(good), [], good);
  assert.equal(removeTextRequests('A confident man ascends a staircase of five metal steps, each stamped with numbers 1 to 5. He is mid-stride.'), 'A confident man ascends a staircase of five metal steps, He is mid-stride.');
  const scenes = [{sceneNumber: 1, narration: 'जश्न मनाओ'}];
  const plan = {scenes: [{sceneNumber: 1, narrationMeaning: 'Celebrate small wins', visualPrompt: 'Close-up of a proud young professional in an office before a large screen showing the word SUCCESS, smiling warmly'}]};
  assert.throws(() => normalizeVisualPlan(plan, scenes), /visible text in scene 1/);
  const cleaned = normalizeVisualPlan(plan, scenes, {sanitizeText: true});
  assert.doesNotMatch(cleaned.scenes[0].visualPrompt, /SUCCESS|word/);
  assert.match(cleaned.scenes[0].visualPrompt, /proud young professional/);
});

// ---- v4: one moment per image, key idea, audience look (video "सफलता के 5 आसान कदम", 2026-11-22) ----
test('v4: collages, panels and "then" sequences are found and reduced to one moment', async () => {
  const {findSequenceRequests, removeSequenceRequests, normalizeVisualPlan, VISUAL_PLAN_VERSION} = await import('../src/utils/visualPlan.js');
  assert.ok(VISUAL_PLAN_VERSION >= 4);
  const collage = 'A young adult alternates between working at a desk, jogging in a park, and studying in a room, each action shown in a separate frame';
  const then = 'A hand holds a broken notebook, then writes a new page with a corrected diagram, symbolizing learning from mistakes';
  assert.ok(findSequenceRequests(collage).length);
  assert.ok(findSequenceRequests(then).length);
  assert.ok(!/frame|alternates/i.test(removeSequenceRequests(collage)), removeSequenceRequests(collage));
  assert.equal(removeSequenceRequests(then), 'A hand holds a broken notebook');
  // Ordinary prompts are untouched.
  for (const ok of ['A woman waters a tiny sapling on a balcony at dawn', 'A cosy room with two windows and morning light', 'A man strengthens his grip on a rope']) {
    assert.deepEqual(findSequenceRequests(ok), [], ok);
  }
  const scenes = [{sceneNumber: 1, narration: 'x'}];
  assert.throws(() => normalizeVisualPlan({scenes: [{sceneNumber: 1, visualPrompt: collage}]}, scenes), /several moments/);
  const fixed = normalizeVisualPlan({scenes: [{sceneNumber: 1, keyIdea: 'small daily effort adds up', visualPrompt: collage}]}, scenes, {sanitizeText: true});
  assert.equal(fixed.scenes[0].keyIdea, 'small daily effort adds up');
  assert.ok(!/frame/.test(fixed.scenes[0].visualPrompt));
});

test('v4: Hindi channels get Indian people and places unless the scene says otherwise', async () => {
  const {audienceLook, needsAudienceLook} = await import('../src/utils/visualPlan.js');
  const {buildSceneImagePrompt} = await import('../src/utils/imagePrompt.js');
  assert.match(audienceLook({language: 'Hindi'}), /Indian people/);
  assert.equal(audienceLook({language: 'English', audience: {description: 'US teens'}}), '');
  assert.equal(audienceLook({language: 'Hindi', visual: {peopleAndPlaces: 'Nepali villagers in the Himalayan foothills'}}), 'Nepali villagers in the Himalayan foothills');
  assert.equal(needsAudienceLook('A Japanese chef in Tokyo'), false);
  const plan = {scenes: [{sceneNumber: 3, keyIdea: 'small daily effort adds up', narrationMeaning: 'The second step is continuous effort, even small progress.', visualPrompt: 'A young woman waters a tiny sapling in a clay pot on a balcony at dawn'}]};
  const p = buildSceneImagePrompt({scene: {sceneNumber: 3, visualPrompt: 'A young adult alternates between working at a desk, jogging in a park, and studying in a room, each action shown in a separate frame with a small timer overlay'}, index: 2, visualPlan: plan, channelProfile: {language: 'Hindi', visual: {aspectRatio: '9:16'}}, promptStyle: 'flux'});
  assert.match(p, /Indian people/);
  assert.doesNotMatch(p, /small daily effort adds up/, 'key idea is not written into FLUX prompts');
  assert.doesNotMatch(p, /separate frame|alternates|timer/i);
  assert.match(p, /one moment in one place/);
  const english = buildSceneImagePrompt({scene: {sceneNumber: 1, visualPrompt: 'A chef plates pasta in a busy kitchen'}, channelProfile: {language: 'English'}, promptStyle: 'flux'});
  assert.doesNotMatch(english, /Indian/);
});

test('v4: the planner gets only the narration, not the old image description', () => {
  const src = readFileSync(new URL('../src/workers/worker.js', import.meta.url), 'utf8');
  assert.match(src, /scenes:storyDoc\.scenes\.map\(s=>\(\{sceneNumber:s\.sceneNumber,narration:s\.narration,durationSec:s\.durationSec\}\)\)/);
});
