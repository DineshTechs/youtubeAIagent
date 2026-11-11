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
