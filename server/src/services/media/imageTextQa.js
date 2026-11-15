import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workers = new Map();
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');

const INTERNAL_INSTRUCTION_PATTERNS = [
  /\bmust\s+show\b/i, /\bshow\s+this\s+exact\b/i,
  /\bnarration\s+continuity\b/i, /\bvisual\s+director\b/i,
  /\bshot\s+plan\b/i, /\bscene\s*#?\s*\d+\b/i,
  /\bproduction\s+instruction/i, /\bimage\s+prompt\b/i,
  /\bcharacter\s+continuity\b/i
];

// The channel's generated artwork is a clean visual layer. Any OCR-readable
// lettering is treated as leakage; captions/titles belong in the editor layer.
export function classifyImageText(text, { strict = true, minWords = 1 } = {}) {
  const normalized = String(text || '').replace(/[|_~`]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return { hasText: false, suspicious: false, reason: 'no_text', text: '' };
  const internal = INTERNAL_INSTRUCTION_PATTERNS.some(pattern => pattern.test(normalized));
  const words = normalized.match(/[A-Za-z]{2,}/g) || [];
  const digits = normalized.match(/\d{1,}/g) || [];
  const hindiChars = (normalized.match(/[\u0900-\u097f]/g) || []).length;
  const otherScriptChars = (normalized.match(/[\u0e00-\u0e7f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  const tokenCount = words.length + digits.length;
  const suspicious = internal || (strict && (tokenCount >= minWords || hindiChars >= 2 || otherScriptChars >= 2));
  return {
    hasText: true, suspicious,
    reason: internal ? 'internal_instruction_text' : (suspicious ? 'unwanted_text' : 'possible_legitimate_text'),
    text: normalized.slice(0, 1000), wordCount: words.length,
    digitCount: digits.length, hindiCharacterCount: hindiChars, otherScriptCharacterCount: otherScriptChars
  };
}

async function getWorker(language = 'eng+hin') {
  const lang = String(language || 'eng+hin');
  if (!workers.has(lang)) {
    const promise = (async () => {
      const { createWorker } = await import('tesseract.js');
      return createWorker(lang, undefined, { langPath: SERVER_ROOT, gzip: false });
    })().catch(error => { workers.delete(lang); throw error; });
    workers.set(lang, promise);
  }
  return workers.get(lang);
}

// ---------------------------------------------------------------------------
// Word-level decision (V1.7.0 handover fix).
//
// The previous rule rejected an image when the whole-page OCR text contained any
// 2-letter token or digit and the PAGE mean confidence was >= 20%. Calibrated on
// real FLUX scene images (eng+hin traineddata, Tesseract 5), that rule rejected
// 5 of 6 clean images: textures and blurred-band edges produce fragments such
// as "ww", "Pe", "= 2" with page confidence 35–60%, the same range as real text.
//
// Real lettering is read as WORDS at high word-level confidence ("CLEAN" 96%,
// "OPEN" 95%, "सफलता" 94%), noise is not. An image is rejected when OCR reads
// at least one "strong" token: >=3 Latin letters, >=2 Devanagari letters, or
// >=2 digits, with word confidence >= STRONG_WORD_CONFIDENCE. Production
// instruction leakage is always rejected. Low-confidence word-like fragments
// do not reject but are reported for human visual review.
// Calibration: 0/6 clean images rejected (old rule: 5/6); every bold or
// high-contrast text sample caught. Faint/thin text can still be missed —
// OCR is not a guarantee; human visual review remains required.
// ---------------------------------------------------------------------------
export const STRONG_WORD_CONFIDENCE = 70;
export const REVIEW_WORD_CONFIDENCE = 45;

function tokenStats(raw) {
  const core = String(raw || '').replace(/[^\p{L}\p{M}\p{N}@#]/gu, '');
  const latin = (core.match(/[A-Za-z]/g) || []).length;
  const devanagari = (core.match(/[अ-हक़-ॡॲ-ॿ]/g) || []).length; // letters, not marks/digits
  const otherScript = (core.match(/[฀-๿぀-ヿ㐀-鿿가-힯]/g) || []).length;
  const digits = (core.match(/[0-9०-९]/g) || []).length;
  return { core, latin, devanagari, otherScript, digits };
}

export function isWordLike(raw) {
  const t = tokenStats(raw);
  return t.latin >= 3 || t.devanagari >= 2 || t.otherScript >= 2 || t.digits >= 2 || (t.latin + t.digits) >= 3;
}

export function classifyOcrWords(words = [], { strongConfidence = STRONG_WORD_CONFIDENCE, reviewConfidence = REVIEW_WORD_CONFIDENCE } = {}) {
  const list = (Array.isArray(words) ? words : [])
    .map(w => ({ text: String(w?.text || '').trim(), confidence: Number(w?.confidence) }))
    .filter(w => w.text && Number.isFinite(w.confidence) && w.confidence >= 0);
  const text = list.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
  const internal = INTERNAL_INSTRUCTION_PATTERNS.some(pattern => pattern.test(text));
  const strongWords = list.filter(w => w.confidence >= strongConfidence && isWordLike(w.text));
  const reviewWords = list.filter(w => w.confidence >= reviewConfidence && w.confidence < strongConfidence && isWordLike(w.text));
  const suspicious = internal || strongWords.length > 0;
  const top = arr => [...new Map(arr.map(w => [w.text, w])).values()].sort((a, b) => b.confidence - a.confidence).slice(0, 8)
    .map(w => ({ text: w.text.slice(0, 40), confidence: Math.round(w.confidence) }));
  return {
    hasText: list.length > 0,
    suspicious,
    reason: internal ? 'internal_instruction_text' : strongWords.length ? 'readable_text' : reviewWords.length ? 'faint_marks_review' : (list.length ? 'noise_only' : 'no_text'),
    text,
    strongWords: top(strongWords),
    reviewWords: top(reviewWords),
    needsVisualReview: !suspicious && reviewWords.length > 0,
    confidence: strongWords.length ? Math.round(Math.max(...strongWords.map(w => w.confidence))) : 0,
    thresholds: { strongConfidence, reviewConfidence }
  };
}

// Tesseract TSV: level page block par line word left top width height conf text
export function parseTsvWords(tsv) {
  const words = [];
  for (const line of String(tsv || '').split(/\r?\n/)) {
    const cols = line.split('\t');
    if (cols.length < 12 || cols[0] !== '5') continue;
    const text = cols.slice(11).join('\t').trim();
    const confidence = Number(cols[10]);
    if (text && Number.isFinite(confidence) && confidence >= 0) words.push({ text, confidence });
  }
  return words;
}

// Width/height from the PNG header (all scene images are normalized to PNG).
export async function readPngSize(imagePath) {
  const fh = await fs.open(imagePath, 'r');
  try {
    const buf = Buffer.alloc(24);
    const { bytesRead } = await fh.read(buf, 0, 24, 0);
    if (bytesRead < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally { await fh.close(); }
}

// Full image plus overlapping horizontal strips: whole-page OCR on a busy
// 1080x1920 frame misses text that a strip of the same area reads clearly.
export function ocrRegions(size, strips = 4) {
  if (!size?.width || !size?.height) return [null];
  const h = Math.floor(size.height / strips), step = Math.max(1, Math.floor(h / 2)), regions = [null];
  for (let top = 0; top < size.height - Math.floor(h / 2); top += step) {
    regions.push({ left: 0, top, width: size.width, height: Math.min(h, size.height - top) });
  }
  return regions;
}

export async function inspectImageText(imagePath, options = {}) {
  const stat = await fs.stat(imagePath);
  if (!stat.isFile() || stat.size < 100) throw new Error('OCR received a missing or invalid image file.');
  // Always inspect both English and Hindi so text leakage is not missed merely
  // because the channel narration is in another language.
  const language = 'eng+hin';
  const worker = await getWorker(language);
  // Sparse-text mode finds scattered lettering inside pictures (Tesseract PSM 11).
  await worker.setParameters({ tessedit_pageseg_mode: '11' });
  const regions = ocrRegions(await readPngSize(imagePath).catch(() => null));
  const words = [];
  for (const rectangle of regions) {
    const result = await worker.recognize(imagePath, rectangle ? { rectangle } : {}, { text: false, tsv: true });
    words.push(...parseTsvWords(result?.data?.tsv));
  }
  const decision = classifyOcrWords(words, options);
  return { ...decision, language, regionsInspected: regions.length, wordsRead: words.length, engine: 'tesseract.js word-level v1' };
}

export async function terminateImageTextQa() {
  const entries = [...workers.values()];
  workers.clear();
  await Promise.all(entries.map(async promise => {
    try { const worker = await promise; await worker.terminate(); } catch {}
  }));
}
