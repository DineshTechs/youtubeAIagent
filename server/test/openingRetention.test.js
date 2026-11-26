import test from 'node:test';
import assert from 'node:assert/strict';
import {makeSrt} from '../src/utils/srt.js';
import {applyOpeningHook} from '../src/utils/openingRetention.js';
import {parseAudibleDurationFromFfmpegOutput} from '../src/utils/audioTiming.js';

test('SRT uses measured TTS durations instead of estimated scene durations',()=>{
  const scenes=[
    {sceneNumber:1,durationSec:8,narration:'A curiosity hook starts this story.'},
    {sceneNumber:2,durationSec:9,narration:'The second scene continues the story.'}
  ];
  const srt=makeSrt(scenes,[11.566,12.766]);
  assert.match(srt,/00:00:00,000 --> 00:00:11,566/);
  assert.match(srt,/00:00:11,566 --> 00:00:24,332/);
});

test('opening hook is inserted into spoken scene one and visual brief',()=>{
  const story={hook:'What is hiding behind the little door?',scenes:[
    {sceneNumber:1,narration:'Bunny walks into the garden.',visualPrompt:'Bunny in a garden.'},
    {sceneNumber:2,narration:'A bird flies past.'}
  ]};
  const result=applyOpeningHook(story,'English');
  assert.equal(result.applied,true);
  assert.equal(result.inserted,true);
  assert.match(story.scenes[0].narration,/What is hiding behind the little door\?/);
  // The hook words must NOT go into the image description (they get drawn as text).
  assert.doesNotMatch(story.scenes[0].visualPrompt,/Opening hook:|little door\?/);
  assert.match(story.scenes[0].visualPrompt,/Opening shot:/);
  assert.match(story.scenes[0].narration,/What is hiding behind the little door\?/);
  assert.equal(story.pipelineData.openingRetention.hookAppliedToNarration,true);
});

test('opening hook is not duplicated when already present',()=>{
  const story={hook:'Look at the tiny red door!',scenes:[
    {sceneNumber:1,narration:'Look at the tiny red door! Bunny opens it slowly.'}
  ]};
  const result=applyOpeningHook(story,'English');
  assert.equal(result.applied,true);
  assert.equal(result.inserted,false);
  assert.equal(story.scenes[0].narration,'Look at the tiny red door! Bunny opens it slowly.');
});

test('Hindi story does not receive an English-only optimized hook',()=>{
  const story={hook:'एक नन्हा खरगोश क्या खोजेगा?',scenes:[
    {sceneNumber:1,narration:'खरगोश जंगल में चला।',visualPrompt:'खरगोश जंगल में'}
  ]};
  const result=applyOpeningHook(story,'Hindi');
  assert.equal(result.applied,true);
  assert.match(story.scenes[0].narration,/एक नन्हा खरगोश क्या खोजेगा/);
});


test('MP3 encoder start delay is excluded from the scene timeline',()=>{
  const duration=parseAudibleDurationFromFfmpegOutput('Duration: 00:00:11.54, start: 0.046042, bitrate: 128 kb/s');
  assert.equal(duration,11.494);
});

test('audio timing parser leaves zero-start audio unchanged',()=>{
  const duration=parseAudibleDurationFromFfmpegOutput('Duration: 00:00:03.250, start: 0.000000, bitrate: 128 kb/s');
  assert.equal(duration,3.25);
});


test('opening hook fills an empty first-scene narration',()=>{
  const story={hook:'A tiny surprise is waiting!',scenes:[{sceneNumber:1,narration:'',visualPrompt:'A tiny door.'}]};
  const result=applyOpeningHook(story,'English');
  assert.equal(result.inserted,true);
  assert.equal(story.scenes[0].narration,'A tiny surprise is waiting!');
});

test('opening visual cue is added once and never contains Hindi hook text',()=>{
  const story={hook:'क्या आप तैयार हैं?',scenes:[{sceneNumber:1,narration:'सुबह हुई।',visualPrompt:'A sunrise over a village'}]};
  applyOpeningHook(story,'Hindi');
  applyOpeningHook(story,'Hindi');
  assert.doesNotMatch(story.scenes[0].visualPrompt,/[\u0900-\u097f]/u);
  assert.equal(story.scenes[0].visualPrompt.match(/Opening shot:/g).length,1);
  assert.match(story.scenes[0].narration,/क्या आप तैयार हैं\?/);
});

import {cleanHook} from '../src/utils/openingRetention.js';
test('a long opening hook is never cut mid-sentence', () => {
  const long = 'क्या आप जानते हैं कि हर दिन की सिर्फ पाँच मिनट की एक छोटी सी आदत आपकी पूरी ज़िंदगी को धीरे-धीरे लेकिन हमेशा के लिए बदल सकती है, और ज़्यादातर लोग इसे कभी समझ ही नहीं पाते? आज मैं आपको वही आदत बताऊँगा। ' + 'यह आदत बहुत आसान है और इसे कोई भी शुरू कर सकता है, चाहे उम्र कुछ भी हो, काम कुछ भी हो, या दिन कितना भी व्यस्त क्यों न हो।';
  assert.ok(long.length > 280);
  const h = cleanHook(long);
  assert.match(h, /[?।]$/u);                       // ends on a full sentence
  assert.ok(long.startsWith(h));
  const story = {hook: long, scenes: [{sceneNumber: 1, narration: 'पहला दृश्य।'}]};
  applyOpeningHook(story, 'Hindi');
  assert.match(story.scenes[0].narration, /बताऊँगा। पहला दृश्य।$/u);
});
test('labels and quotes around a hook are removed', () => {
  assert.equal(cleanHook('Hook 2 (Curiosity): "What if one habit changed everything?"'), 'What if one habit changed everything?');
  assert.equal(cleanHook('**Opening hook:** Stop scrolling.'), 'Stop scrolling.');
});

import {chooseHook, hookFit} from '../src/utils/openingRetention.js';
const story = {scenes: [
  {narration: 'एक गाँव में रामू नाम का एक गरीब लकड़हारा रहता था। एक दिन उसकी कुल्हाड़ी नदी में गिर गई।'},
  {narration: 'नदी से एक देवी प्रकट हुईं और उन्होंने रामू को सोने की कुल्हाड़ी दिखाई।'}]};
const own = 'क्या आप जानते हैं कि एक गरीब लकड़हारे की ईमानदारी ने उसे नदी की देवी से सोने की कुल्हाड़ी दिला दी?';
test('the story hook is kept when the skill hook is short or off-topic', () => {
  assert.equal(chooseHook({original: own, optimized: 'सफलता का राज़!', story, language: 'Hindi'}).source, 'story');
  const offTopic = chooseHook({original: own, optimized: 'आज हम जानेंगे कि शेयर बाज़ार में पैसा कैसे दुगना करें और अमीर बनें।', story, language: 'Hindi'});
  assert.equal(offTopic.source, 'story');
  assert.match(offTopic.reason, /does not match the narration/);
  assert.equal(chooseHook({original: own, optimized: 'Did you know an honest woodcutter won a golden axe?', story, language: 'Hindi'}).source, 'story');
});
test('a skill hook about this story and long enough is used', () => {
  const better = 'नदी में गिरी एक कुल्हाड़ी ने गरीब लकड़हारे रामू की किस्मत कैसे बदल दी? देवी ने उसे सोने की कुल्हाड़ी दिखाई, फिर क्या हुआ?';
  const r = chooseHook({original: own, optimized: better, story, language: 'Hindi'});
  assert.equal(r.source, 'optimized');
  assert.ok(hookFit(better, story.scenes.map(s => s.narration).join(' ')).shared >= 4);
});
