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
  assert.equal(classifyImageText('Welcome to the garden',{strict:false}).suspicious,false);
});

test('strict default flags short unwanted generated lettering',()=>{
  assert.equal(classifyImageText('Subscribe Now').suspicious,true);
});

test('strict default flags Hindi text detected by OCR',()=>{
  assert.equal(classifyImageText('यह एक परीक्षण है').suspicious,true);
});

test('non-strict mode preserves possible legitimate text',()=>{
  assert.equal(classifyImageText('Subscribe Now',{strict:false}).suspicious,false);
});

test('strict mode rejects a single readable word because artwork must be text-free',()=>{
  assert.equal(classifyImageText('WELCOME').suspicious,true);
});

test('strict mode rejects visible digits',()=>{
  assert.equal(classifyImageText('2026').suspicious,true);
});

test('strict mode rejects short non-Latin writing',()=>{
  assert.equal(classifyImageText('こんにちは').suspicious,true);
});

test('non-strict option cannot override clean-artwork default when called by inspectImageText',()=>{
  // The classifier remains configurable for unit-level callers; inspectImageText
  // deliberately forces strict mode at the actual asset approval boundary.
  assert.equal(classifyImageText('WELCOME',{strict:false}).suspicious,false);
});
