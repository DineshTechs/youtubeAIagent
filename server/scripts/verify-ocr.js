import fs from 'node:fs/promises';
import { createWorker } from 'tesseract.js';

let worker;
try {
  console.log('[OCR] Importing tesseract.js…');
  worker = await createWorker('eng');
  console.log('[OCR] PASS — tesseract.js imported and English worker initialized.');
  const imagePath = process.argv[2];
  if (imagePath) {
    await fs.access(imagePath);
    const result = await worker.recognize(imagePath);
    console.log('[OCR] Recognition result:');
    console.log(String(result?.data?.text || '').trim() || '(No readable text detected)');
    console.log(`[OCR] Confidence: ${Number(result?.data?.confidence || 0).toFixed(1)}%`);
  } else {
    console.log('[OCR] To test real image recognition, pass an image path: npm run verify:ocr -- "D:\\path\\to\\test-image.png"');
  }
} catch (error) {
  console.error('[OCR] FAIL:', error?.stack || error);
  process.exitCode = 1;
} finally {
  if (worker) await worker.terminate().catch(() => {});
}
