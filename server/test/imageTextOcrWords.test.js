import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {classifyOcrWords, parseTsvWords, ocrRegions, readPngSize, isWordLike, classifyImageText, STRONG_WORD_CONFIDENCE} from '../src/services/media/imageTextQa.js';

// Real Tesseract 5 word output (eng+hin, sparse-text mode, full image + strips)
// for the project's own FLUX scene images and labelled text samples.
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/ocrWords.calibration.json', import.meta.url), 'utf8'));

test('clean scene images are accepted (regression: brain/face scene 3 was rejected for "ww", "Pe", "= 2" noise)', () => {
  for (const name of Object.keys(fixtures).filter(n => n.startsWith('clean_'))) {
    const result = classifyOcrWords(fixtures[name]);
    assert.equal(result.suspicious, false, `${name} wrongly rejected: ${JSON.stringify(result.strongWords)}`);
  }
});

test('real FLUX lettering "CLEAN WOUR" is still rejected', () => {
  const result = classifyOcrWords(fixtures.real_flux_text_CLEAN_WOUR);
  assert.equal(result.suspicious, true);
  assert.equal(result.reason, 'readable_text');
  assert.ok(result.strongWords.some(w => /CLEAN/.test(w.text)));
});

test('sign text, Hindi words, small words and watermarks are rejected', () => {
  for (const name of ['sign_OPEN_24_HOURS', 'hindi_word_safalta', 'small_word_Motivation', 'watermark_handle', 'hindi_caption']) {
    assert.equal(classifyOcrWords(fixtures[name]).suspicious, true, `${name} not caught`);
  }
});

test('strict policy kept: one confidently read word or number rejects the image', () => {
  assert.equal(classifyOcrWords([{text: 'WELCOME', confidence: 91}]).suspicious, true);
  assert.equal(classifyOcrWords([{text: '2026', confidence: 88}]).suspicious, true);
  assert.equal(classifyOcrWords([{text: 'सफलता', confidence: 90}]).suspicious, true);
});

test('production-instruction leakage is rejected even at low confidence', () => {
  const result = classifyOcrWords([{text: 'MUST', confidence: 30}, {text: 'SHOW', confidence: 31}, {text: 'THIS', confidence: 22}, {text: 'EXACT', confidence: 25}]);
  assert.equal(result.suspicious, true);
  assert.equal(result.reason, 'internal_instruction_text');
});

test('low-confidence word-like marks do not reject but are flagged for visual review', () => {
  const result = classifyOcrWords([{text: 'Atl', confidence: 54}, {text: 'te', confidence: 60}, {text: '=', confidence: 80}]);
  assert.equal(result.suspicious, false);
  assert.equal(result.needsVisualReview, true);
  assert.equal(result.reason, 'faint_marks_review');
});

test('pure symbol noise is accepted without review', () => {
  const result = classifyOcrWords([{text: '=', confidence: 86}, {text: '|', confidence: 90}, {text: 'C', confidence: 84}, {text: 'ww', confidence: 40}]);
  assert.equal(result.suspicious, false);
  assert.equal(result.needsVisualReview, false);
});

test('word-likeness: 3+ Latin letters, 2+ Devanagari letters or 2+ digits; marks and symbols do not count', () => {
  assert.ok(isWordLike('CLEAN'));
  assert.ok(isWordLike('मत'));
  assert.ok(isWordLike('24'));
  assert.ok(!isWordLike('ww'));
  assert.ok(!isWordLike('=]'));
  assert.ok(!isWordLike('ं'));
  assert.ok(!isWordLike('C'));
});

test('parses Tesseract TSV word rows only', () => {
  const tsv = ['1\t1\t0\t0\t0\t0\t0\t0\t1080\t1920\t-1\t', '5\t1\t1\t1\t1\t1\t100\t200\t300\t80\t96.1\tCLEAN', '5\t1\t1\t1\t1\t2\t420\t200\t200\t80\t-1\t', '5\t1\t2\t1\t1\t1\t10\t10\t20\t20\t12.5\tww'].join('\n');
  assert.deepEqual(parseTsvWords(tsv), [{text: 'CLEAN', confidence: 96.1}, {text: 'ww', confidence: 12.5}]);
});

test('OCR regions are the full image plus overlapping strips that cover the frame', () => {
  const regions = ocrRegions({width: 1080, height: 1920});
  assert.equal(regions[0], null);
  assert.equal(regions.length, 8);
  assert.equal(regions[1].top, 0);
  const last = regions.at(-1);
  assert.ok(last.top + last.height >= 1920 - 1);
  assert.deepEqual(ocrRegions(null), [null]);
});

test('reads PNG dimensions from the header', async () => {
  const file = path.join(os.tmpdir(), `ocr-size-${process.pid}.png`);
  const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(1080, 16); png.writeUInt32BE(1920, 20);
  fs.writeFileSync(file, png);
  assert.deepEqual(await readPngSize(file), {width: 1080, height: 1920});
  fs.unlinkSync(file);
});

test('thresholds and the legacy text classifier are unchanged for other callers', () => {
  assert.equal(STRONG_WORD_CONFIDENCE, 70);
  assert.equal(classifyImageText('WELCOME').suspicious, true);
});
