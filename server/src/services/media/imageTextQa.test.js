import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyImageText} from './imageTextQa.js';

test('detects production instruction leakage',()=>{
  const result=classifyImageText('MUST SHOW THIS EXACT SCENE 5 NARRATION CONTINUITY');
  assert.equal(result.suspicious,true);
  assert.equal(result.reason,'internal_instruction_text');
});

test('does not reject empty OCR output',()=>{
  assert.equal(classifyImageText('').suspicious,false);
});

test('strict mode flags substantial readable text',()=>{
  assert.equal(classifyImageText('Subscribe and like this channel please',{strict:true}).suspicious,true);
});

test('non-strict mode leaves possible legitimate text as a warning only',()=>{
  assert.equal(classifyImageText('Welcome to the garden').suspicious,false);
});
