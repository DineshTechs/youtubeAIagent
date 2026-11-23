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
// v3: plans that express ideas through written words/numbers/screens are rejected.
// v4: no collages/sequences, a one-line keyIdea per scene, people and places that fit the audience.
// v5: the planner sees only the narration (it copied old descriptions); writing on boards, banners and calendar lists count as text.
export const VISUAL_PLAN_VERSION = 5;

export const STORY_VISUAL_PROMPT_RULE = 'Write every visualPrompt in ENGLISH even when the narration is in another language. Each visualPrompt is ONE single still frame (no camera movement, zooms, cuts, transitions, split screens, collages, panels, before/after pairs or "then" sequences) describing the concrete subject, action, setting and objects that literally illustrate what that scene\'s narration says. Never ask for on-screen text, captions, typography, titles or written words inside the image; text is added later in editing.';

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

// Phrases that ask for several moments in one image (collages, panels, "then"
// sequences). Image models answer with a white collage of tiny unrelated photos.
const SEQUENCE_PATTERNS = [
  /\b(?:alternat(?:es|ing|e)\s+between|switch(?:es|ing)\s+between|cycles?\s+through)\b[^.;]*/i,
  /\b(?:(?:shown|depicted|displayed|arranged)\s+)?(?:in\s+)?(?:separate|multiple|several|three|two|four|consecutive|side[-\s]by[-\s]side)\s+(?:frames?|panels?|images?|shots?|vignettes?|scenes?)\b[^.;]*/i,
  /\beach\s+(?:action|step|moment|scene|stage)\s+(?:is\s+)?(?:shown|depicted)\b[^.;]*/i,
  /\b(?:collage|montage|split[-\s]?screen|triptych|diptych|grid of|comic strip|storyboard|sequence of (?:images|shots|frames)|series of (?:images|shots|frames|panels))\b[^.;]*/i,
  /\bbefore[-\s]and[-\s]after\b[^.;]*/i,
  /,?\s*(?:\band\s+)?\bthen\s+(?:later\s+)?(?:he|she|they|it|writes?|turns?|walks?|runs?|opens?|picks?|starts?|moves?|becomes?|shows?|holds?|smiles?|looks?|stands?|\w+s)\b[^.;]*/i
];
export function findSequenceRequests(prompt = '') {
  const text = String(prompt || '');
  return SEQUENCE_PATTERNS.map(re => (text.match(re) || [])[0]).filter(Boolean).map(x => x.trim());
}
// Keeps the first moment and drops the parts that ask for more moments/panels.
export function removeSequenceRequests(prompt = '') {
  // "alternates between working at a desk, jogging and studying" -> "is working at a desk".
  let out = String(prompt || '').replace(/\b(?:alternat\w*|switch\w*|cycl\w*)\s+(?:between|through)\s+([^,;.]+?)(?:,|\s+and\s)[^.;]*?(?=,\s*each\b|[.;]|$)/gi, 'is $1');
  for (const re of SEQUENCE_PATTERNS) out = out.replace(new RegExp(re.source, 'gi'), ' ');
  out = out.replace(/\s+([,.;])/g, '$1').replace(/([,;])\s*(?=[,;.]|$)/g, '').replace(/\b(?:with|and|while|as)\s*([.;]|$)/gi, '$1').replace(/\s{2,}/g, ' ').replace(/^[\s,;.]+|[\s,;]+$/g, '').trim();
  return out.length >= 8 ? out : String(prompt || '').trim();
}

// Languages whose audience mostly lives in India: people and places in the
// images should look Indian unless the narration is about somewhere else.
const INDIAN_LANGUAGES = /\b(hindi|hinglish|marathi|bengali|bangla|tamil|telugu|kannada|malayalam|gujarati|punjabi|odia|oriya|assamese|bhojpuri|rajasthani|haryanvi|urdu|indian)\b|हिन्दी|हिंदी/i;
export function audienceLook(profile = {}, seriesDoc = {}) {
  const custom = String(profile?.visual?.peopleAndPlaces || '').trim();
  if (custom && isEnglishVisualText(custom)) return custom;
  const lang = [profile?.language, profile?.narration?.language, seriesDoc?.language, profile?.audience?.description, profile?.audience?.region].filter(Boolean).join(' ');
  return INDIAN_LANGUAGES.test(lang) ? 'Indian people in a recognisably Indian everyday setting' : '';
}
const NAMES_A_LOOK = /\b(indian|desi|south asian|african|european|american|asian|japanese|chinese|korean|arab|latino|hispanic|caucasian|british|french|german|russian|mexican|brazilian|nigerian|kenyan|pakistani|bangladeshi|nepali|sri lankan)\b/i;
export function needsAudienceLook(prompt = '') { return !NAMES_A_LOOK.test(String(prompt || '')); }

// Phrases that ask the image model to DRAW text (it cannot, and OCR then rejects
// or strips the image so it no longer matches the narration).
const TEXT_REQUEST_PATTERNS = [
  /\b(showing|displaying|reading|reads|says|spelling|spelled|labell?ed|stamped|printed|engraved|inscribed|titled|written)\b[^.,;]{0,40}\b(word|words|text|letters?|numbers?|numerals?|digits?|title|slogan|message|phrase|quote|sign)\b/i,
  /\b(the word|the words|the text|the number|numbers? \d|numbered)\b/i,
  /\b(word|text|caption|banner|sign|label|headline)\s+["“'][^"”']+["”']/i,
  /["“][A-Z][A-Z0-9 !?.-]{2,}["”]/,
  /\b(task list|to-?do list|checklist|bullet points?|list of (tasks|steps|goals)|written (list|plan|goal)|check ?marks?)\b/i,
  /\b(screen|display|monitor|timer|clock|whiteboard|blackboard|chalkboard|billboard|poster|sign|scoreboard)\b[^.,;]{0,30}\b(showing|displaying|reading|with)\b[^.,;]{0,20}(\d|\b(word|text|number|minutes?|hours?|percent)\b)/i,
  /\b\d+[\s-]*(minute|min|hour|second|%|percent)s?\b[^.,;]{0,25}\b(on|in)\b[^.,;]{0,15}\b(screen|display|phone|timer|clock)\b/i,
  // Writing or drawing something readable ("writes a bold, clear goal on a whiteboard").
  /\b(writ(?:es|e|ing|ten)|scribbl\w*|jott\w*|draws?|drawing|sketch(?:es|ing)?)\b[^.;]{0,50}\b(on|in|onto|across)\s+(?:a|an|the|his|her|their)?\s*(?:\w+\s+)?(whiteboard|blackboard|chalkboard|board|sticky|wall|calendar|mirror|glass|window)\b/i,
  /\b(goal list|calendar page|diary entry|vision board|mind map|diagram|flow ?chart|bar chart|pie chart|graph|infographic|spreadsheet)\b/i,
  /\b(holding|holds|carrying|carry|raising|raise|waving)\s+(?:up\s+)?(?:a|an|the)?\s*(?:\w+\s+)?(banner|sign|placard|poster|card|certificate)\b/i
];
export function findTextRequests(prompt = '') {
  const text = String(prompt || '');
  return TEXT_REQUEST_PATTERNS.map(re => (text.match(re) || [])[0]).filter(Boolean);
}
// Removes the clauses that ask for visible text, keeping the rest of the scene.
export function removeTextRequests(prompt = '') {
  // Requests that span a comma ("writes a bold, clear goal on a whiteboard with a marker")
  // are cut from the whole text first, with the writing tool that follows them.
  let whole = String(prompt || '');
  for (const hit of findTextRequests(whole)) {
    const at = whole.indexOf(hit);
    if (at < 0 || !hit.includes(',')) continue;
    const rest = whole.slice(at + hit.length).replace(/^\s*(?:with|using)\s+(?:a|an|the)?\s*(?:\w+\s+)?(?:marker|pen|chalk|pencil|brush|crayon)s?\b/i, '');
    whole = `${whole.slice(0, at).replace(/\s+$/, '')}${rest}`;
  }
  prompt = whole;
  const parts = String(prompt || '').split(/(?<=[.;])\s+|,\s+/);
  // Keep the part of a clause before the text request ("…before a large screen showing the word X" -> "…before a large screen").
  const kept = parts.map(part => {
    const hits = findTextRequests(part);
    if (!hits.length) return part;
    const cut = Math.min(...hits.map(h => part.indexOf(h)).filter(i => i >= 0));
    const head = part.slice(0, cut).replace(/(?:\b(?:with|showing|displaying|reading|each|and|of|the|a|an|on|in|that|which)\s*)+$/i, '').trim();
    return head.length >= 20 ? head : '';
  }).filter(Boolean);
  const out = kept.join(', ').replace(/,\s*([.;])/g, '$1').replace(/\s+/g, ' ').trim();
  return out.length >= 20 ? out : String(prompt || '').replace(/["“”][^"“”]*["“”]/g, '').trim();
}

export function buildVisualDirectorInstruction(profile = {}, seriesDoc = {}, { strict = false } = {}) {
  const aspect = profile?.visual?.aspectRatio || '9:16';
  const style = profile?.visual?.style || seriesDoc?.visualStyle || 'cinematic visuals';
  return [
    'Act as the visual director for a YouTube video for this channel profile.',
    'The narration is the source of truth. For EVERY scene, read its narration (it may be in Hindi or another language), understand exactly what is being said, and design ONE still image that literally illustrates that meaning for this channel\'s niche, audience and tone.',
    'Name the concrete subject, what they are doing, where, and the important objects. Do not replace specific ideas with generic portraits, a person staring at the camera, decorative scenery, abstract symbols or unrelated stock imagery. For abstract ideas, show a concrete everyday situation that a viewer would instantly connect to the narration.',
    'Each image is ONE moment in ONE place: no collages, panels, multiple frames, before/after pairs, split screens, "alternates between" or "then" sequences, and no camera movement, zooms, pans, cuts or transitions. If the narration lists several things, pick the single most telling one. Vary wide, medium and close-up framing across scenes. Keep recurring people, products and places consistent.',
    'Make the topic recognisable: a viewer who sees only the image should guess what the narration is about. First write keyIdea (2-6 English words naming the one idea the scene must get across, e.g. "small daily effort adds up"), then design the image around a concrete, instantly readable situation or visual metaphor for that idea, with the idea\'s key object or action large and in focus. Scene 1 (the hook) shows the central image of the whole video\'s topic, not a person staring or thinking. Do not just copy the given visualPrompt: improve it when it is generic, literal-minded or does not show the keyIdea.',
    'More examples of abstract ideas: "keep trying even when progress is small" -> a young woman watering a tiny sapling in a clay pot on a balcony at dawn; "learn from mistakes" -> a boy carefully re-building a fallen tower of wooden blocks, scattered blocks around him; "stay positive and confident" -> a young man standing tall on a rooftop with arms open to the morning sun; "share your dreams and inspire others" -> a woman teaching a small group of attentive children under a tree.',
    'Never put text, captions, typography, titles, logos, signs with writing or readable screens in the image; subtitles and titles are added later in editing. Ignore any editing directions in the visual style (text overlays, zooms, transitions).',
    'NEVER express an idea through written words, numbers, lists, labels, check marks, charts, timers or screens showing something (the image model cannot draw text, and such images are rejected). Show it through people, actions, objects and emotion instead. Examples: "five steps to success" -> a person climbing a sunlit stone staircase toward a summit; "break tasks into small parts" -> hands sorting a big pile of colourful blocks into small neat stacks; "25-minute focus" -> a person deeply concentrating at a desk with a classic kitchen timer beside them, face turned away from it; "celebrate small wins" -> a person smiling and raising a fist while colleagues clap.',
    audienceLook(profile, seriesDoc) ? `People and places must fit this channel's audience: show ${audienceLook(profile, seriesDoc)} (homes, streets, schools, offices, markets, fields) unless the narration is clearly about somewhere else.` : '',
    `ALL OUTPUT FIELDS MUST BE IN ENGLISH, even when the narration is not. Aspect ratio ${aspect}. Channel visual style (translate to English and keep only still-image qualities): ${style}.`,
    'Return only JSON, no markdown, with shape {"visualStyle":"<short English still-image style>","scenes":[{"sceneNumber","narrationMeaning","keyIdea","subject","action","setting","importantObjects","emotion","camera","composition","visualPrompt"}]}. narrationMeaning: one short English sentence saying what the narration says. visualPrompt: 25-70 English words describing the single still image.',
    'Do not impose children\'s-content styling unless the channel profile safetyMode is kids-and-family.',
    strict ? 'IMPORTANT: your previous answer was rejected (non-English text, or it asked for written words, numbers, lists or screens in the image). Every field must be in English, every image must show the idea without any visible text, and every image must be ONE moment (no collages, panels or sequences).' : ''
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
export function normalizeVisualPlan(result, scenes = [], { now = () => new Date(), sanitizeText = false } = {}) {
  if (!result || !Array.isArray(result.scenes)) throw new Error('Visual Director returned an invalid scene plan.');
  const byNumber = new Map(result.scenes.map(x => [Number(x.sceneNumber), x]));
  const normalized = scenes.map((scene, i) => {
    const n = Number(scene.sceneNumber || i + 1);
    const plan = byNumber.get(n);
    if (!plan) throw new Error(`Visual Director did not return a plan for scene ${n}.`);
    let visualPrompt = limit(stripEditingDirections(plan.visualPrompt), 1200);
    if (!visualPrompt) throw new Error(`Visual Director returned an empty visual prompt for scene ${n}.`);
    const textAsks = findTextRequests(visualPrompt);
    if (textAsks.length) {
      if (!sanitizeText) throw new Error(`Visual Director asked for visible text in scene ${n} ("${textAsks[0]}").`);
      visualPrompt = removeTextRequests(visualPrompt);
    }
    const sequence = findSequenceRequests(visualPrompt);
    if (sequence.length) {
      if (!sanitizeText) throw new Error(`Visual Director asked for several moments in one image in scene ${n} ("${sequence[0]}").`);
      visualPrompt = removeSequenceRequests(visualPrompt);
    }
    if (!isEnglishVisualText(visualPrompt)) throw new Error(`Visual Director returned a non-English visual prompt for scene ${n}.`);
    return {
      sceneNumber: n,
      narrationMeaning: limit(isEnglishVisualText(plan.narrationMeaning) ? plan.narrationMeaning : '', 300),
      keyIdea: limit(isEnglishVisualText(plan.keyIdea) ? removeTextRequests(plan.keyIdea) : '', 80),
      subject: limit(plan.subject, 400), action: limit(plan.action, 500), setting: limit(plan.setting, 400),
      importantObjects: limit(plan.importantObjects, 500), emotion: limit(plan.emotion, 250),
      camera: limit(stripEditingDirections(plan.camera), 200), composition: limit(removeSequenceRequests(removeTextRequests(stripEditingDirections(plan.composition))), 400),
      visualPrompt
    };
  });
  return { version: VISUAL_PLAN_VERSION, language: 'en', createdAt: now(), visualStyle: englishStillStyle(result.visualStyle, ''), scenes: normalized };
}

export function isCurrentVisualPlan(plan, sceneCount) {
  return Boolean(plan && plan.version === VISUAL_PLAN_VERSION && Array.isArray(plan.scenes) && plan.scenes.length === sceneCount && plan.scenes.every(s => isEnglishVisualText(s.visualPrompt)));
}
