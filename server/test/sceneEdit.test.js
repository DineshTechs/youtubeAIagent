import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEdit,rewriteSceneVisual,applySceneEdit,sceneVisualInstruction} from '../src/services/sceneEdit.js';
import {createBot} from '../src/services/telegram/botCommands.js';

test('validateEdit decides what to rebuild', () => {
  assert.deepEqual(validateEdit({imageInstruction: ' river at sunset '}), {instruction: 'river at sunset', narration: '', regenerateImage: true});
  assert.equal(validateEdit({narration: 'नई कहानी'}).regenerateImage, false);
  assert.equal(validateEdit({narration: 'x', regenerateImage: true}).regenerateImage, true);
  assert.equal(validateEdit({}).regenerateImage, true, 'empty request = plain new image');
  assert.throws(() => validateEdit({imageInstruction: 'x'.repeat(1001)}), /too long/);
});

test('instructions in any language become an English image prompt', async () => {
  let seen;
  const provider = {generateJson: async (instr, input, label) => { seen = {instr, input, label}; return {visualPrompt: 'An old woodcutter kneels by a river at sunset holding a golden axe, cut to close-up'}; }};
  const p = await rewriteSceneVisual({provider, instruction: 'नदी किनारे सुनहरी कुल्हाड़ी', narration: 'वह ईमानदार था', currentVisual: 'forest', style: 'cinematic', language: 'Hindi'});
  assert.equal(seen.label, 'scene-edit');
  assert.match(seen.instr, /ENGLISH only/);
  assert.match(p, /^An old woodcutter/);
  assert.doesNotMatch(p, /cut to/i);
  // AI down: English instruction used directly; non-English instruction is refused.
  const down = {generateJson: async () => { throw new Error('quota'); }};
  assert.equal(await rewriteSceneVisual({provider: down, instruction: 'A golden axe on a riverbank'}), 'A golden axe on a riverbank');
  await assert.rejects(rewriteSceneVisual({provider: down, instruction: 'सुनहरी कुल्हाड़ी'}), /quota/);
  assert.ok(sceneVisualInstruction().includes('no text'));
});

test('applySceneEdit changes only the chosen scene and resets its plan details', () => {
  const story = {scenes: [{sceneNumber: 1, narration: 'a', visualPrompt: 'v1'}, {sceneNumber: 2, narration: 'b', visualPrompt: 'v2'}],
    pipelineData: {visualDirectorPlan: {version: 2, scenes: [{sceneNumber: 1, visualPrompt: 'p1', subject: 's1'}, {sceneNumber: 2, visualPrompt: 'p2', subject: 'old subject', narrationMeaning: 'm'}]}}};
  const r = applySceneEdit(story, 2, {visualPrompt: 'NEW', narration: 'नया', instruction: 'make it night'});
  assert.deepEqual(r.scenes[1], {sceneNumber: 2, narration: 'नया', visualPrompt: 'NEW'});
  assert.deepEqual(r.scenes[0], story.scenes[0]);
  const p2 = r.visualDirectorPlan.scenes[1];
  assert.equal(p2.visualPrompt, 'NEW');
  assert.equal(p2.subject, '');
  assert.equal(p2.narrationMeaning, 'm');
  assert.equal(p2.userInstruction, 'make it night');
  assert.equal(r.visualDirectorPlan.scenes[0].subject, 's1');
  assert.equal(story.scenes[1].narration, 'b', 'input not mutated');
  assert.throws(() => applySceneEdit(story, 9, {}), /not found/);
});

function bot(status = 'APPROVED', extra = {}) {
  const sent = [], calls = [];
  const video = {_id: 'v1', title: 'Woodcutter', status, profile: {id: 'p1', name: 'K'}, renderPath: 'x.mp4',
    storyId: {scenes: [{sceneNumber: 1, narration: 'एक लकड़हारा था', durationSec: 6, visualPrompt: 'forest'}, {sceneNumber: 2, narration: 'वह नदी पर गया', durationSec: 7}]},
    sceneAssets: [{sceneNumber: 1, path: 'C:/s/scene-001.png'}], sceneAudioFiles: ['C:/s/scene-narration/scene-001.mp3'], pendingSceneEdit: status === 'SCENE_REVIEW' ? {sceneNumber: 1, narrationChanged: true} : undefined, ...extra};
  const api = async (method, path, body) => { calls.push({method, path, body}); if (path === '/videos/v1') return video; return {ok: true, regenerateImage: Boolean(body?.imageInstruction || body?.regenerateImage), narrationChanged: Boolean(body?.narration), visualPrompt: body?.imageInstruction ? 'English prompt' : null}; };
  const rec = type => async (chatId, a, b, c) => { sent.push({type, a, b, c}); return {message_id: 9}; };
  const tg = {send: async (chatId, text, markup) => { sent.push({type: 'send', text, markup}); }, edit: async (chatId, id, text, markup) => { sent.push({type: 'edit', text, markup}); }, answer: async () => {}, sendVideo: rec('video'), sendPhoto: async (chatId, file, caption, markup) => { sent.push({type: 'photo', file, text: caption, markup}); }, sendAudio: async (chatId, file, caption) => { sent.push({type: 'audio', file, text: caption}); }};
  const b = createBot({tg, api, scope: c => (c === '1' ? [{id: 'p1', name: 'K'}] : [])});
  const press = data => b.handleUpdate({callback_query: {id: 'x', data, message: {chat: {id: 1}, message_id: 5}}});
  const say = text => b.handleUpdate({message: {chat: {id: 1}, text, date: Math.floor(Date.now() / 1000)}});
  const btn = label => sent.filter(s => s.markup).at(-1).markup.inline_keyboard.flat().find(x => x.text.includes(label));
  return {sent, calls, press, say, btn};
}

test('bot: open scenes, see a scene image, regenerate with confirmation', async () => {
  const h = bot();
  await h.press('o:v1');
  await h.press(h.btn('Scenes').callback_data);
  assert.match(h.sent.at(-1).text, /1\.<\/b> 6s · एक लकड़हारा था/);
  await h.press(h.btn('Scene 1').callback_data);
  assert.equal(h.sent.at(-1).type, 'photo');
  assert.equal(h.sent.at(-1).file, 'C:/s/scene-001.png');
  await h.press(h.btn('New image').callback_data);
  assert.match(h.sent.at(-1).text, /need approval again/);
  assert.ok(!h.calls.some(c => c.path.endsWith('/regenerate')));
  await h.press(h.btn('Yes, new image').callback_data);
  const regen = h.calls.find(c => c.method === 'POST' && c.path === '/videos/v1/scenes/1/regenerate');
  assert.deepEqual(regen.body, {confirmBeforeRender: true, requestedByChat: '1'});
  assert.match(h.sent.at(-1).text, /check before the video is rendered/);
});

test('bot: describe a new image in Hindi, confirm, edit endpoint called', async () => {
  const h = bot();
  await h.press('o:v1');
  await h.press(h.btn('Scenes').callback_data);
  await h.press(h.btn('Scene 2').callback_data);
  assert.equal(h.sent.at(-1).type, 'send', 'no image for scene 2 -> text message');
  await h.press(h.btn('Describe new image').callback_data);
  await h.say('रात में नदी के किनारे लकड़हारा');
  assert.match(h.sent.at(-1).text, /scene 2<\/b>'s new image/);
  await h.press(h.btn('Yes, make it').callback_data);
  const call = h.calls.find(c => c.path === '/videos/v1/scenes/2/edit');
  assert.deepEqual(call.body, {imageInstruction: 'रात में नदी के किनारे लकड़हारा', confirmBeforeRender: true, requestedByChat: '1'});
  assert.match(h.sent.at(-1).text, /English prompt/);
});

test('bot: change narration (keep image), and /cancel stops waiting', async () => {
  const h = bot();
  await h.press('o:v1');
  await h.press(h.btn('Scenes').callback_data);
  await h.press(h.btn('Scene 1').callback_data);
  await h.press(h.btn('Change narration').callback_data);
  assert.match(h.sent.at(-1).text, /about 3 words/);
  await h.say('एक ईमानदार लकड़हारा था');
  await h.press(h.btn('Yes, keep image').callback_data);
  assert.deepEqual(h.calls.find(c => c.path === '/videos/v1/scenes/1/edit').body, {narration: 'एक ईमानदार लकड़हारा था', regenerateImage: false, confirmBeforeRender: true, requestedByChat: '1'});
  await h.press('o:v1');
  await h.press(h.btn('Scenes').callback_data);
  await h.press(h.btn('Scene 1').callback_data);
  await h.press(h.btn('Change narration').callback_data);
  await h.say('/cancel');
  assert.match(h.sent.at(-1).text, /cancelled/);
  const n = h.calls.length;
  await h.say('this should be ignored now');
  assert.equal(h.calls.length, n);
});

test('bot: rebuilt scene is rendered only after pressing Render', async () => {
  const h = bot('SCENE_REVIEW');
  await h.press('o:v1');
  assert.match(h.sent.at(-1).text, /Scene review/);
  assert.ok(!h.calls.some(c => c.path === '/videos/v1/render'));
  await h.press(h.btn('Render video').callback_data);
  assert.ok(h.calls.some(c => c.method === 'POST' && c.path === '/videos/v1/render'));
  assert.match(h.sent.at(-1).text, /Rendering <b>Woodcutter<\/b>/);
  // "Change this scene again" from the rebuilt-scene message opens the scene.
  await h.press('e:v1:1');
  assert.equal(h.sent.at(-1).type, 'photo');
});

test('bot: Render does nothing unless the video is waiting for it', async () => {
  const h = bot('AWAITING_APPROVAL');
  await h.press('r:v1');
  assert.ok(!h.calls.some(c => c.path === '/videos/v1/render'));
  assert.match(h.sent.at(-1).text, /not waiting for render confirmation/);
  const stranger = bot('SCENE_REVIEW');
  await stranger.press('r:v1');
  assert.ok(stranger.calls.some(c => c.path === '/videos/v1/render'), 'sanity: authorized chat works');
});

test('bot: new scene can be seen and heard before rendering', async () => {
  const h = bot('SCENE_REVIEW');
  await h.press('o:v1');
  assert.ok(h.btn('See new scene 1'));
  await h.press(h.btn('See new scene 1').callback_data);
  const photo = h.sent.at(-1);
  assert.equal(photo.type, 'photo');
  assert.ok(photo.markup.inline_keyboard[0].some(b => b.text.includes('Render video')), 'Render offered on the new scene');
  await h.press(h.btn('Hear narration').callback_data);
  assert.equal(h.sent.at(-1).type, 'audio');
  assert.equal(h.sent.at(-1).file, 'C:/s/scene-narration/scene-001.mp3');
  await h.press('h:v1:2');
  assert.match(h.sent.at(-1).text, /No narration audio/);
});

test('bot: rebuild all images is confirmed and asks for review before rendering', async () => {
  const h = bot('AWAITING_APPROVAL');
  await h.press('o:v1');
  await h.press(h.btn('Rebuild all images').callback_data);
  assert.match(h.sent.at(-1).text, /Rebuild <b>all 2 images<\/b>[\s\S]*before the video is rendered/);
  assert.ok(!h.calls.some(c => c.path.endsWith('/rebuild-images')));
  await h.press(h.btn('Yes, rebuild all').callback_data);
  assert.deepEqual(h.calls.find(c => c.path === '/videos/v1/rebuild-images').body, {replan: true, confirmBeforeRender: true, requestedByChat: '1'});
});

test('bot: scene list warns about images made from an older description', async () => {
  const h = bot('AWAITING_APPROVAL', {sceneAssets: [{sceneNumber: 1, path: 'C:/s/scene-001.png', stale: true}]});
  await h.press('o:v1');
  await h.press(h.btn('Scenes').callback_data);
  assert.match(h.sent.at(-1).text, /<b>1\.<\/b> ⚠ /);
  assert.match(h.sent.at(-1).text, /Scene 1: the image may not match the narration/);
  assert.ok(h.btn('Rebuild all images'));
});
