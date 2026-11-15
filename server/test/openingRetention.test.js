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
