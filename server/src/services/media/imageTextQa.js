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

export async function inspectImageText(imagePath, options = {}) {
  const stat = await fs.stat(imagePath);
  if (!stat.isFile() || stat.size < 100) throw new Error('OCR received a missing or invalid image file.');
  // Always inspect both English and Hindi so text leakage is not missed merely
  // because the channel narration is in another language.
  const language = 'eng+hin';
  const worker = await getWorker(language);
  const result = await worker.recognize(imagePath);
  const text = result?.data?.text || '';
  const confidence = Number(result?.data?.confidence || 0);
  const classification = classifyImageText(text, { ...options, strict: true, minWords: 1 });
  const unmistakable = INTERNAL_INSTRUCTION_PATTERNS.some(pattern => pattern.test(text));
  // Lower threshold catches short lettering. Ignore only very-low-confidence OCR
  // noise; production instructions remain rejected regardless of confidence.
  const suspicious = classification.suspicious && (confidence >= 20 || unmistakable);
  return { ...classification, suspicious, confidence, language };
}

export async function terminateImageTextQa() {
  const entries = [...workers.values()];
  workers.clear();
  await Promise.all(entries.map(async promise => {
    try { const worker = await promise; await worker.terminate(); } catch {}
  }));
}
