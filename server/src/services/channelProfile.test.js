import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChannelProfile,channelProfileSummary} from './channelProfile.js';

test('general channel defaults do not inherit the old kids audience',()=>{
  const p=buildChannelProfile({name:'Tech Explainers',niche:'Technology',targetAge:'4-8',language:'English',visualStyle:'Cinematic'});
  assert.equal(p.audience.description,'General audience');
  assert.equal(p.editorial.safetyMode,'standard');
  assert.equal(p.visual.style,'Cinematic');
});

test('kids niche retains child audience and kids safety mode',()=>{
  const p=buildChannelProfile({name:'Tiny Science',niche:'Kids science experiments',targetAge:'4-8'});
  assert.equal(p.audience.description,'4-8');
  assert.equal(p.editorial.safetyMode,'kids-and-family');
});

test('an explicitly child audience enables the kids-and-family policy even in a broad niche',()=>{
  const p=buildChannelProfile({niche:'Education',channelProfile:{audience:{description:'Children ages 8-12'}}});
  assert.equal(p.editorial.safetyMode,'kids-and-family');
});

test('saved profile values override legacy series fields',()=>{
  const p=buildChannelProfile({name:'Old name',niche:'General',language:'English',channelProfile:{
    channelName:'My Channel',audience:{description:'Adults interested in finance'},
    content:{primaryFormat:'Documentary',tone:'Analytical'},
    visual:{style:'Photorealistic cinematic',aspectRatio:'16:9'},
    narration:{voiceStyle:'Calm expert'}
  }});
  assert.equal(p.channelName,'My Channel');
  assert.equal(p.audience.description,'Adults interested in finance');
  assert.equal(p.content.primaryFormat,'Documentary');
  assert.equal(p.visual.aspectRatio,'16:9');
  assert.equal(p.narration.voiceStyle,'Calm expert');
});

test('request overrides apply without mutating the saved profile',()=>{
  const series={niche:'Travel',channelProfile:{audience:{description:'Travel enthusiasts'},visual:{aspectRatio:'16:9'}}};
  const p=buildChannelProfile(series,{language:'Hindi',tone:'Adventurous',format:'Short'});
  assert.equal(p.language,'Hindi');
  assert.equal(p.content.tone,'Adventurous');
  assert.equal(p.visual.aspectRatio,'16:9');
  assert.equal(series.channelProfile.visual.aspectRatio,'16:9');
});

test('profile summary exposes generation-critical settings',()=>{
  const summary=channelProfileSummary(buildChannelProfile({niche:'Business'}));
  assert.equal(summary.niche,'Business');
  assert.equal(summary.audience,'General audience');
  assert.equal(summary.aspectRatio,'9:16');
});
