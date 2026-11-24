import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {captionFont, BUNDLED_FONTS_DIR, BUNDLED_CAPTION_FONT} from '../src/services/video/renderer.js';

test('Windows-only caption fonts are swapped for the bundled Hindi font on Linux', () => {
  assert.equal(captionFont('Nirmala UI', 'linux'), BUNDLED_CAPTION_FONT);
  assert.equal(captionFont('mangal', 'linux'), BUNDLED_CAPTION_FONT);
  assert.equal(captionFont('', 'linux'), BUNDLED_CAPTION_FONT);
  assert.equal(captionFont('Noto Sans Devanagari', 'linux'), 'Noto Sans Devanagari');
  assert.equal(captionFont('Nirmala UI', 'win32'), 'Nirmala UI');
});
test('the bundled caption font ships with the app', () => {
  assert.ok(existsSync(path.join(BUNDLED_FONTS_DIR, 'Poppins-Medium.ttf')));
  assert.ok(existsSync(path.join(BUNDLED_FONTS_DIR, 'OFL.txt')));
});
