import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Regression (2026-11-16): one failed OCR job crashed the whole backend because
// tesseract.js re-throws worker errors when no errorHandler is set. Uses the real
// engine; skipped where tesseract.js is not installed.
let available = true;
try { await import('tesseract.js'); } catch { available = false; }

test('a failed OCR rejects cleanly, keeps the process alive and the next check still works', {skip: !available && 'tesseract.js not installed', timeout: 120000}, async () => {
  const {inspectImageText, terminateImageTextQa} = await import('../src/services/media/imageTextQa.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  const broken = path.join(dir, 'broken.png');
  fs.writeFileSync(broken, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 0xff)]));
  try {
    await assert.rejects(inspectImageText(broken), /OCR failed/);
    // A valid text-free image after the failure must still be processed.
    const result = await inspectImageText(fileURLToPath(new URL('./fixtures/clean-scene-320.png', import.meta.url)));
    assert.equal(result.suspicious, false);
  } finally {
    await terminateImageTextQa();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
