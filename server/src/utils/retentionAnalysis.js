function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function toSeconds(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

/** Match the hook against captions even when punctuation/cue segmentation differs. */
export function findHookCompletionTime(srtText, hook) {
  const expected = normalizeText(hook).split(' ').filter(Boolean);
  if (!expected.length) return { found: false, endSec: null, matchRatio: 0, reason: 'Hook is empty.' };
  const blocks = String(srtText || '').trim().split(/\r?\n\s*\r?\n/);
  let accumulated = [];
  let best = { found: false, endSec: null, matchRatio: 0, endWithin3Sec: false };
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const timingIndex = lines.findIndex(line => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [startRaw, endRaw] = lines[timingIndex].split('-->').map(x => x.trim());
    const startSec = toSeconds(startRaw), endSec = toSeconds(endRaw);
    if (startSec == null || endSec == null) continue;
    const cueTokens = normalizeText(lines.slice(timingIndex + 1).join(' ')).split(' ').filter(Boolean);
    accumulated.push(...cueTokens);
    // Caption tracks can omit punctuation or slightly normalize spoken wording.
    // Compare in order and require a high token coverage to avoid false positives.
    let cursor = 0, matched = 0;
    for (const token of expected) {
      const foundAt = accumulated.indexOf(token, cursor);
      if (foundAt >= 0) { matched++; cursor = foundAt + 1; }
    }
    const ratio = matched / expected.length;
    if (ratio > best.matchRatio) best = { found: ratio >= 0.85, endSec, startSec, matchRatio: Number(ratio.toFixed(3)), endWithin3Sec: endSec <= 3 };
    if (ratio >= 0.85) return best;
  }
  return { ...best, reason: 'The hook did not sufficiently match the sequential subtitle cues.' };
}

/** Hook length is a useful pre-render signal; it does not replace audio timing. */
export function analyzeHookText(hook) {
  const words = normalizeText(hook).split(' ').filter(Boolean);
  return { wordCount: words.length, concise: words.length >= 3 && words.length <= 10, text: String(hook || '').trim() };
}

/** Conservative opening-scene pacing metrics; advisory, never a hard failure. */
export function analyzeOpeningPacing(sceneDurations = [], windowSec = 15) {
  const durations = Array.isArray(sceneDurations) ? sceneDurations.map(Number).filter(x => Number.isFinite(x) && x > 0) : [];
  let elapsed = 0;
  const opening = [];
  for (const duration of durations) {
    if (elapsed >= windowSec) break;
    opening.push(duration);
    elapsed += duration;
  }
  return {
    sceneCount: opening.length,
    coverageSec: Number(Math.min(elapsed, windowSec).toFixed(2)),
    longestSceneSec: opening.length ? Number(Math.max(...opening).toFixed(2)) : 0,
    shortSceneCount: opening.filter(x => x < 1.25).length,
    complete: elapsed >= windowSec - 0.35
  };
}
