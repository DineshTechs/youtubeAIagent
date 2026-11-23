import { stripEditingDirections, isEnglishVisualText, englishStillStyle, removeSequenceRequests, audienceLook, needsAudienceLook } from './visualPlan.js';
// Prompt length limits per image provider. Cloudflare Workers AI (FLUX)
// rejects prompts longer than 2048 characters with error 5006. A small margin
// is kept. Providers not listed have no practical limit for our prompts.
const PROVIDER_PROMPT_LIMITS = { cloudflare: 2000 };

// FLUX models (Cloudflare Workers AI, Pollinations "flux") have no negative
// prompt and draw words from the prompt as lettering: capitalised rules such as
// "ABSOLUTELY NO VISIBLE TEXT" or "CLEAN-IMAGE CORRECTION" were rendered into the
// image ("CLEAN WOUR"). They get short, purely descriptive prompts instead.
export function promptStyleFor(provider, model = '') {
  const p = String(provider || '').toLowerCase();
  if (p === 'cloudflare') return 'flux';
  if (p === 'pollinations' && /flux|turbo|schnell/i.test(String(model || 'flux'))) return 'flux';
  return 'standard';
}

// Words that invite lettering in FLUX images. Removed from FLUX prompts only.
const FLUX_TEXT_INVITING = /\b(?:text|texts|letters?|lettering|words?|typography|typographic|fonts?|captions?|subtitles?|titles?|headlines?|labels?|labell?ed|logos?|watermarks?|signatures?|handwriting|quotes?|slogans?|banners?|placards?|correction|strict|absolutely)\b/gi;

// Objects FLUX almost always fills with lettering; described as blank artwork.
const FLUX_PRINTED_OBJECTS = /\b(?:motivational\s+|inspirational\s+)?(?:posters?|billboards?|signboards?|placards?)\b/gi;

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

export const FLUX_RETRY_SUFFIX = 'Simple uncluttered background, plain unmarked surfaces, soft natural light.';

export function buildCleanImageRetryPrompt(basePrompt, { maxChars = null, promptStyle = 'standard' } = {}) {
  const base = String(basePrompt || '').replace(/\s+/g, ' ').trim();
  if (promptStyle === 'flux') {
    // No correction/instruction words at all for FLUX; they get drawn.
    const limit = maxChars || 2000;
    const head = trimToWords(base, limit - FLUX_RETRY_SUFFIX.length - 2).replace(/[\s,;:]+$/, '');
    return `${head}${/[.!?]$/.test(head) ? '' : '.'} ${FLUX_RETRY_SUFFIX}`.trim();
  }
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

// ---------------------------------------------------------------------------
// Scene image prompt (moved from worker.js so it can be regression-tested).
// Changes vs V1.7.0: the prompt no longer contains the channel niche or the
// words "YouTube video" (FLUX rendered them as on-screen titles, e.g.
// "Motivation ... in Hindi"), and quoted phrases are removed from scene text
// because image models draw quoted strings as lettering.
// ---------------------------------------------------------------------------
const META_PATTERNS = [
  /\bmust\s+show\b/ig, /\bshow\s+this\s+exact\b/ig,
  /\bexact\s+scene\b/ig, /\bnarration\s+continuity\b/ig,
  /\bscene\s*#?\s*\d+\b/ig, /\bvisual\s+director\b/ig,
  /\bshot\s+plan\b/ig, /\bproduction\s+instruction[s]?\b/ig,
  /\bdo\s+not\s+forget\b/ig, /\bimage\s+prompt\b/ig,
  /\boutput\s+only\b/ig, /\bstrictly\s+avoid\b/ig,
  // Platform/format words invite thumbnail-style titles and logos.
  /\byou\s*tube\b/ig, /\bthumbnail[s]?\b/ig
];

export function cleanVisualText(value, max = 420) {
  let text = String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  // Quoted phrases ("Never give up", “कभी हार मत मानो”, «...») are drawn as text.
  text = text.replace(/(?:\b(?:reading|that\s+reads|saying|that\s+says|says|with\s+the\s+words?|labell?ed|titled|written|text)\s*:?\s*)?(?:"[^"]{1,160}"|“[^”]{1,160}”|„[^“”]{1,160}[“”]|«[^»]{1,160}»|「[^」]{1,160}」)/gi, ' ');
  // Stories saved by V1.4–V1.7.0 have the spoken hook embedded in scene 1's
  // visual prompt ("Opening hook: <sentence>. The opening frame should …").
  text = text.replace(/Opening hook:[\s\S]*?(?:curiosity hook while matching the first scene's narrated action\.?|$)/gi, ' ');
  // Overlay/caption wording asks the model to draw text.
  text = text.replace(/\b(?:bold\s+|large\s+|big\s+)?(?:hook|title|headline|caption|text|word)\s+(?:text\s+)?overlays?\b|\bon[-\s]?screen\s+(?:text|titles?|captions?)\b|\bhook\s+text\b|\bcuriosity\s+hook\b/gi, ' ');
  // A still image cannot show zooms, cuts, transitions or text overlays.
  text = stripEditingDirections(text);
  for (const pattern of META_PATTERNS) text = text.replace(pattern, ' ');
  text = text.replace(/\b(?:SUBJECT|ACTION|SETTING|IMPORTANT OBJECTS|EMOTION|CAMERA|COMPOSITION|NARRATION CONTEXT|CHARACTER CONTINUITY)\s*:/gi, ' ');
  text = text.replace(/\s+/g, ' ').replace(/^[\s:;,.!-]+|[\s:;,.!-]+$/g, '').trim();
  return text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, '').trim();
}

const NO_TEXT_RULE = 'ABSOLUTELY NO VISIBLE TEXT OR GRAPHIC BRANDING: no letters, words, numbers, pseudo-writing, gibberish, fake glyphs, text-like strokes, decorative marks resembling writing, captions, subtitles, typography, labels, signage, logos, icons resembling platform brands, watermarks, signatures, QR codes, UI controls, app interfaces or decorative symbols. Screens, books, signs, packaging and labels must be blank, plain and unmarked. Do not invent text-like marks. Render a clean photorealistic/illustrated scene only. All captions and titles are added separately by the video editor.';

function characterContextOf(characters) {
  return (characters || [])
    .map(c => cleanVisualText(`${c.name}, ${c.appearance || 'consistent appearance'}`, 160))
    .filter(Boolean).join('; ').slice(0, 260);
}

export function buildSceneImagePrompt({ scene = {}, index = 0, visualPlan = null, characters = [], channelProfile = null, series = {}, visualDirector = {}, promptStyle = 'standard' } = {}) {
  const plan = visualPlan?.scenes?.find(x => Number(x.sceneNumber) === Number(scene.sceneNumber || index + 1));
  // Image models (FLUX especially) only understand English. Prefer an English
  // description: the scene's own prompt if English, else the Visual Director's.
  const ownBrief = cleanVisualText(scene.visualPrompt, 650);
  const planBrief = cleanVisualText(plan?.visualPrompt, 650);
  // One moment only: collages/panels/"then" sequences become a white grid of tiny photos.
  const visualBrief = removeSequenceRequests(isEnglishVisualText(ownBrief) ? ownBrief : (isEnglishVisualText(planBrief) ? planBrief : ownBrief));
  const meaning = cleanVisualText(plan?.narrationMeaning, 220);
  const keyIdea = cleanVisualText(plan?.keyIdea, 80);
  const planVisuals = plan
    ? removeSequenceRequests([plan.subject, plan.action, plan.setting, plan.importantObjects, plan.emotion, plan.camera]
        .map(v => cleanVisualText(v, 180)).filter(Boolean).join('. '))
    : '';
  // People and places that fit the audience (e.g. Indian people for a Hindi channel),
  // unless the scene already says who/where.
  const look = audienceLook(channelProfile || {}, series || {});
  const lookLine = look && needsAudienceLook(`${visualBrief} ${characterContextOf(characters)}`) ? look : '';
  const characterContext = characterContextOf(characters);
  const profileStyle = channelProfile?.visual?.style || series?.visualStyle || 'cinematic, high-quality visuals';
  const rawStyle = cleanVisualText(isEnglishVisualText(visualPlan?.visualStyle) ? visualPlan.visualStyle : (promptStyle === 'flux' ? englishStillStyle(profileStyle) : profileStyle), 120) || 'cinematic, high-quality visuals';
  const style = /(cartoon|chibi|anime|comic|flat|illustrat|kawaii|storybook|clay|2d|3d animation|animated)/i.test(rawStyle)
    ? rawStyle : `${rawStyle}, polished cinematic lighting`;
  const continuity = visualDirector?.continuity === false
    ? 'Keep the subjects natural and appropriate to this single moment.'
    : 'Keep recurring people, hosts, products or fictional characters visually consistent across scenes.';
  const aspect = channelProfile?.visual?.aspectRatio || '9:16';
  if (promptStyle === 'flux') {
    const fluxClean = v => String(v || '').replace(FLUX_PRINTED_OBJECTS, 'plain framed artwork').replace(/\bnewspapers?\b/gi, 'folded paper').replace(FLUX_TEXT_INVITING, ' ').replace(/\s+([,.;])/g, '$1').replace(/([,.;])\1+/g, '$1').replace(/\s+/g, ' ').trim();
    // The scene description leads; the plan's field list is only used when there is
    // no description (as fragments it pulled images toward odd composites).
    const subject = fluxClean(visualBrief || planVisuals || 'A clear, expressive moment with a recognizable subject and setting');
    const fluxPrompt = [
      `${subject}.`,
      lookLine ? `${lookLine}.` : '',
      characterContext ? `${fluxClean(characterContext)}.` : '',
      `${fluxClean(style)}.`,
      'A single photograph of one moment in one place, full frame, clear main subject, natural anatomy, expressive body language, recognizable setting.',
      `${aspect} framing with faces and key objects in the upper and middle frame.`,
      'Plain unmarked surfaces, uncluttered background.'
    ].filter(Boolean).join(' ').replace(/\.\s*\./g, '.');
    // Drop any non-English words FLUX cannot read (they only add noise or lettering).
    const latinOnly = fluxPrompt.replace(/[^\x00-\x7F\u2018\u2019\u201C\u201D\u2013\u2014]+/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/\s{2,}/g, ' ');
    return cleanVisualText(latinOnly, 1850);
  }
  const prompt = [
    // Channel niche, language and platform are deliberately NOT included here.
    `Create one original ${aspect} image.`,
    `Depict this visual moment: ${visualBrief || planVisuals || 'A clear, expressive story moment with a recognizable subject and setting.'}.`,
    keyIdea ? `The main idea it must get across: ${keyIdea}.` : '',
    meaning ? `It must clearly illustrate what the narration says: ${meaning}.` : '',
    lookLine ? `People and setting: ${lookLine}.` : '',
    planVisuals && planVisuals !== visualBrief ? `Visual details: ${planVisuals}.` : '',
    characterContext ? `Character appearance: ${characterContext}.` : '',
    continuity,
    `Visual style: ${style}.`,
    'Show one moment in one place (no collage, panels or split screen), a clear main subject, natural anatomy, expressive body language and a recognizable setting. Show the described action rather than a generic portrait.',
    'Keep important faces, hands and story objects in the upper and middle portions of the frame.',
    NO_TEXT_RULE,
    'Generate only the image; do not reproduce any instructions or metadata.'
  ].filter(Boolean).join(' ');
  return cleanVisualText(prompt, 1850);
}
