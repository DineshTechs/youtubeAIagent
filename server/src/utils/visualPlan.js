// Visual Director plan v2 — images must illustrate the narration.
//
// Problems found in real jobs (2026-11-16):
// - Hindi channels got Hindi visual prompts and a Hindi shot plan. The image
//   model (FLUX) only understands English, so images were generic/unrelated.
// - Visual prompts described video edits ("camera zooms in, then cuts to a bold
//   text overlay", "quick zooms on speaker's face"), which a still image cannot
//   show; "zooms on face" produced generic face close-ups and "text overlay"
//   invited lettering.
// Plan v2: every field is English, every visualPrompt is ONE still frame that
// literally shows what the narration says, plus a one-line English
// narrationMeaning. Plans from older versions are re-planned.
export const VISUAL_PLAN_VERSION = 2;

export const STORY_VISUAL_PROMPT_RULE = 'Write every visualPrompt in ENGLISH even when the narration is in another language. Each visualPrompt is ONE single still frame (no camera movement, zooms, cuts, transitions, split screens or "then" sequences) describing the concrete subject, action, setting and objects that literally illustrate what that scene\'s narration says. Never ask for on-screen text, captions, typography, titles or written words inside the image; text is added later in editing.';

const NON_LATIN_LETTER = /[ऀ-ॿঀ-෿؀-ۿЀ-ӿ฀-๿぀-ヿ㐀-鿿가-힯]/gu;

// True when a text is usable by an English-only image model (mostly Latin letters).
export function isEnglishVisualText(text) {
  const t = String(text || '');
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const other = (t.match(NON_LATIN_LETTER) || []).length;
  return latin >= 8 && other <= latin * 0.05;
}

// Remove video-editing / motion / typography directions; a still image cannot
// show them and they derail image models.
export function stripEditingDirections(text) {
  let t = String(text || '');
  const patterns = [
    /\b(?:then\s+)?(?:quick\s+|hard\s+|jump\s+)?cuts?\s+to\b[^.;]*/gi,
    /\bquick\s+cut\b[^,.;]*/gi,
    /\b(?:the\s+)?camera\s+(?:slowly\s+|then\s+|quickly\s+)?(?:zooms?|pans?|pulls?\s+back|pushes?\s+in|follows?|tilts?|tracks?|dollies|cuts?|moves?|orbits?|whips?)\b[^.;]*/gi,
    /\b(?:quick|fast|rapid|slow|smooth)\s+(?:zooms?|transitions?|cuts?|pans?)(?:\s+(?:in|out|on|to)\b[^,.;]*)?/gi,
    /\bzooms?\s+(?:in|out)\b[^,.;]*/gi,
    /\b(?:bold\s+|large\s+|big\s+|animated\s+)?(?:text|typography|title|caption|headline|word|hook)\s+overlays?\b[^,.;]*/gi,
    /\b(?:bold\s+)?typography\b[^,.;]*/gi,
    /\b(?:lower[-\s]third|on[-\s]?screen\s+(?:text|titles?|captions?))\b[^,.;]*/gi,
    /\bsplit[-\s]?screen\b[^.;]*/gi,
    /\btransitions?\b/gi,
    /\b\d+:\d+\s+aspect(?:\s+ratio)?\b/gi
  ];
  for (const p of patterns) t = t.replace(p, ' ');
  return t.replace(/\s+([,.;])/g, '$1').replace(/([,;])\s*(?=[,;.])/g, '').replace(/^[\s,;.]+|[\s,;]+$/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Keep only the English (Latin) part of a style; drop editing directions.
export function englishStillStyle(style, fallback = 'cinematic, high-quality visuals') {
  const raw = String(style || '');
  if (!isEnglishVisualText(raw)) return fallback;
  return stripEditingDirections(raw) || fallback;
}

export function buildVisualDirectorInstruction(profile = {}, seriesDoc = {}, { strict = false } = {}) {
  const aspect = profile?.visual?.aspectRatio || '9:16';
  const style = profile?.visual?.style || seriesDoc?.visualStyle || 'cinematic visuals';
  return [
    'Act as the visual director for a YouTube video for this channel profile.',
    'The narration is the source of truth. For EVERY scene, read its narration (it may be in Hindi or another language), understand exactly what is being said, and design ONE still image that literally illustrates that meaning for this channel\'s niche, audience and tone.',
    'Name the concrete subject, what they are doing, where, and the important objects. Do not replace specific ideas with generic portraits, a person staring at the camera, decorative scenery, abstract symbols or unrelated stock imagery. For abstract ideas, show a concrete everyday situation that a viewer would instantly connect to the narration.',
    'Each image is a single still frame: no camera movement, zooms, pans, cuts, transitions, split screens or "then" sequences. Vary wide, medium and close-up framing across scenes. Keep recurring people, products and places consistent.',
    'Never put text, captions, typography, titles, logos, signs with writing or readable screens in the image; subtitles and titles are added later in editing. Ignore any editing directions in the visual style (text overlays, zooms, transitions).',
    `ALL OUTPUT FIELDS MUST BE IN ENGLISH, even when the narration is not. Aspect ratio ${aspect}. Channel visual style (translate to English and keep only still-image qualities): ${style}.`,
    'Return only JSON, no markdown, with shape {"visualStyle":"<short English still-image style>","scenes":[{"sceneNumber","narrationMeaning","subject","action","setting","importantObjects","emotion","camera","composition","visualPrompt"}]}. narrationMeaning: one short English sentence saying what the narration says. visualPrompt: 25-70 English words describing the single still image.',
    'Do not impose children\'s-content styling unless the channel profile safetyMode is kids-and-family.',
    strict ? 'IMPORTANT: your previous answer contained non-English text. Every field must be written in English only.' : ''
  ].filter(Boolean).join(' ');
}

const limit = (value, max) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max); const b = cut.lastIndexOf(' ');
  return (b > max * 0.72 ? cut.slice(0, b) : cut).trim();
};

// Validate and normalise a Visual Director answer. Throws if any scene is
// missing or not in English (the caller retries once with strict wording).
export function normalizeVisualPlan(result, scenes = [], { now = () => new Date() } = {}) {
  if (!result || !Array.isArray(result.scenes)) throw new Error('Visual Director returned an invalid scene plan.');
  const byNumber = new Map(result.scenes.map(x => [Number(x.sceneNumber), x]));
  const normalized = scenes.map((scene, i) => {
    const n = Number(scene.sceneNumber || i + 1);
    const plan = byNumber.get(n);
    if (!plan) throw new Error(`Visual Director did not return a plan for scene ${n}.`);
    const visualPrompt = limit(stripEditingDirections(plan.visualPrompt), 1200);
    if (!visualPrompt) throw new Error(`Visual Director returned an empty visual prompt for scene ${n}.`);
    if (!isEnglishVisualText(visualPrompt)) throw new Error(`Visual Director returned a non-English visual prompt for scene ${n}.`);
    return {
      sceneNumber: n,
      narrationMeaning: limit(isEnglishVisualText(plan.narrationMeaning) ? plan.narrationMeaning : '', 300),
      subject: limit(plan.subject, 400), action: limit(plan.action, 500), setting: limit(plan.setting, 400),
      importantObjects: limit(plan.importantObjects, 500), emotion: limit(plan.emotion, 250),
      camera: limit(stripEditingDirections(plan.camera), 200), composition: limit(stripEditingDirections(plan.composition), 400),
      visualPrompt
    };
  });
  return { version: VISUAL_PLAN_VERSION, language: 'en', createdAt: now(), visualStyle: englishStillStyle(result.visualStyle, ''), scenes: normalized };
}

export function isCurrentVisualPlan(plan, sceneCount) {
  return Boolean(plan && plan.version === VISUAL_PLAN_VERSION && Array.isArray(plan.scenes) && plan.scenes.length === sceneCount && plan.scenes.every(s => isEnglishVisualText(s.visualPrompt)));
}
