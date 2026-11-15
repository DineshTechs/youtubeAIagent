// Prompt length limits per image provider. Cloudflare Workers AI (FLUX)
// rejects prompts longer than 2048 characters with error 5006. A small margin
// is kept. Providers not listed have no practical limit for our prompts.
const PROVIDER_PROMPT_LIMITS = { cloudflare: 2000 };

export function promptLimitFor(provider) {
  return PROVIDER_PROMPT_LIMITS[String(provider || '').toLowerCase()] || null;
}

function trimToWords(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, Math.max(0, max));
  const boundary = cut.lastIndexOf(' ');
  return (boundary > max * 0.7 ? cut.slice(0, boundary) : cut).trim();
}

// The correction goes FIRST so it is never the part cut off, and it is
// always built from the ORIGINAL scene prompt (not stacked on previous
// retries), so the prompt does not grow with each attempt.
export const CLEAN_IMAGE_CORRECTION = 'STRICT CLEAN-IMAGE CORRECTION: the previous image contained unwanted text or marks. Same scene and composition, but absolutely no visible text, letters, numbers, pseudo-writing, glyphs, scribbles, captions, signs, labels, logos, watermarks, signatures or interface elements. Keep screens, books, signs and packaging blank with natural texture; avoid close-ups of printed material. Captions are added separately in editing.';

export function buildCleanImageRetryPrompt(basePrompt, { maxChars = null } = {}) {
  const base = String(basePrompt || '').replace(/\s+/g, ' ').trim();
  const prefix = `${CLEAN_IMAGE_CORRECTION} Scene: `;
  if (!maxChars) return `${prefix}${base}`;
  const room = maxChars - prefix.length;
  if (room < 200) return trimToWords(`${prefix}${base}`, maxChars);
  return `${prefix}${trimToWords(base, room)}`;
}

// Last-resort guard for any prompt sent to a length-limited provider.
export function fitPromptToProvider(prompt, provider) {
  const limit = promptLimitFor(provider);
  return limit ? trimToWords(prompt, limit) : String(prompt || '');
}
