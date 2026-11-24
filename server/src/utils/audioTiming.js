/**
 * Parse FFmpeg's input summary and return the audible timeline duration.
 * MP3 files commonly report a positive `start` timestamp (encoder delay).
 * The concat demuxer removes that leading timestamp at each file boundary,
 * so including it in subtitle/scene timing shifts later captions out of sync.
 */
export function parseAudibleDurationFromFfmpegOutput(output) {
  const text = String(output || '');
  const durationMatch = text.match(/Duration:\s*(\d{2}):(\d{2}):(\d+(?:\.\d+)?)/i);
  if (!durationMatch) return null;

  const rawDuration = Number(durationMatch[1]) * 3600
    + Number(durationMatch[2]) * 60
    + Number(durationMatch[3]);
  if (!Number.isFinite(rawDuration) || rawDuration <= 0) return null;

  const startMatch = text.match(/,\s*start:\s*(-?\d+(?:\.\d+)?)/i);
  const positiveStart = startMatch ? Math.max(0, Number(startMatch[1]) || 0) : 0;
  const audibleDuration = rawDuration - positiveStart;
  return Number.isFinite(audibleDuration) && audibleDuration > 0
    ? Number(audibleDuration.toFixed(3))
    : null;
}

// A TTS service sometimes returns audio that stops part-way through the text.
// The fastest believable narration is about 25 characters a second (Hindi or
// English), so audio much shorter than that cannot contain all the words.
export const FASTEST_CHARS_PER_SEC = 25;
export function minSpeechSeconds(text) {
  const n = String(text || '').replace(/\s+/g, ' ').trim().length;
  return n < 40 ? 0 : Number((n / FASTEST_CHARS_PER_SEC).toFixed(2));
}
export function narrationLooksCut(text, durationSec) {
  const min = minSpeechSeconds(text);
  return min > 0 && Number(durationSec) > 0 && Number(durationSec) < min;
}
