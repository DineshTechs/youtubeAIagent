// Verify the production image-text check on this machine.
//
//   npm run verify:ocr --workspace server
//   npm run verify:ocr --workspace server -- "D:\path\to\image.png" ["D:\other.png" ...]
//
// Uses exactly the same code as video generation (inspectImageText): English +
// Hindi traineddata from the server folder, full image + overlapping strips,
// word-level confidence decision.
import fs from 'node:fs/promises';
import { inspectImageText, terminateImageTextQa, STRONG_WORD_CONFIDENCE } from '../src/services/media/imageTextQa.js';

const images = process.argv.slice(2);
try {
  console.log(`[OCR] Production check: eng+hin, word confidence >= ${STRONG_WORD_CONFIDENCE}% rejects.`);
  if (!images.length) {
    console.log('[OCR] No image given. Pass one or more paths, e.g.:');
    console.log('      npm run verify:ocr --workspace server -- "D:\\WebApps\\youtubeAIagent\\server\\storage\\videos\\<id>\\scenes\\scene-01.png"');
  }
  for (const imagePath of images) {
    await fs.access(imagePath);
    const started = Date.now();
    const r = await inspectImageText(imagePath);
    const verdict = r.suspicious ? 'REJECT (readable text)' : r.needsVisualReview ? 'ACCEPT (faint marks: check in visual review)' : 'ACCEPT (clean)';
    console.log(`\n[OCR] ${imagePath}`);
    console.log(`      Verdict: ${verdict}  reason=${r.reason}  regions=${r.regionsInspected}  words read=${r.wordsRead}  ${Date.now() - started}ms`);
    if (r.strongWords.length) console.log(`      Confident words: ${r.strongWords.map(w => `"${w.text}" ${w.confidence}%`).join(', ')}`);
    if (r.reviewWords.length) console.log(`      Faint words:     ${r.reviewWords.map(w => `"${w.text}" ${w.confidence}%`).join(', ')}`);
  }
  console.log('\n[OCR] PASS — tesseract.js loaded English + Hindi data and completed the check.');
} catch (error) {
  console.error('[OCR] FAIL:', error?.stack || error);
  process.exitCode = 1;
} finally {
  await terminateImageTextQa();
}
