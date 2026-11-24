function normalizeForCompare(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function hookMatchesLanguage(hook, language) {
  const lang = String(language || '').toLowerCase();
  if (lang.startsWith('hindi')) return /[\u0900-\u097f]/u.test(hook);
  if (lang.startsWith('english')) return /[a-z]/i.test(hook) && !/[\u0900-\u097f]/u.test(hook);
  return true;
}

// The spoken hook must be whole sentences. It used to be cut at 240 characters,
// which could stop the opening line mid-word. Now labels/quotes are removed and a
// long hook keeps only the complete sentences that fit (never half a sentence).
export const HOOK_MAX_CHARS = 280;
export function cleanHook(value, max = HOOK_MAX_CHARS) {
  let h = String(value || '').replace(/\s+/g, ' ').trim()
    .replace(/^(?:\*\*)?(?:hook|opening hook|option)\s*(?:#?\d+)?\s*(?:\([^)]{0,40}\))?\s*[:\-–—]\s*/i, '')
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').replace(/\*\*/g, '').trim();
  if (h.length <= max) return h;
  const sentences = h.match(/[^.!?।]+[.!?।]+["”’']?|[^.!?।]+$/gu) || [h];
  let out = '';
  for (const s of sentences.map(x => x.trim())) {
    if (!out) { out = s; continue; }           // always keep the whole first sentence
    if ((out + ' ' + s).length > max) break;
    out += ' ' + s;
  }
  return out;
}

export const OPENING_VISUAL_CUE = 'Opening shot: make the first frame immediately striking and curiosity-provoking, showing the first scene\'s narrated action clearly.';

/**
 * Make the story's hook part of the actual spoken opening, not just metadata.
 * This is called before visual planning, image generation, TTS and script QA.
 */
export function applyOpeningHook(story, language = 'English') {
  if (!story || !Array.isArray(story.scenes) || story.scenes.length === 0) {
    return { applied: false, reason: 'No story scenes are available.' };
  }

  const hook = cleanHook(story.hook);
  if (hook && hook !== String(story.hook || '').trim()) story.hook = hook;
  if (!hook) return { applied: false, reason: 'Story hook is empty.' };
  if (!hookMatchesLanguage(hook, language)) {
    return { applied: false, reason: `Hook language does not match ${language}.` };
  }

  const firstScene = story.scenes[0];
  const narration = String(firstScene?.narration || '').replace(/\s+/g, ' ').trim();
  const normalizedHook = normalizeForCompare(hook);
  const normalizedNarration = normalizeForCompare(narration);
  const alreadyIncluded = Boolean(normalizedNarration) && (normalizedNarration.includes(normalizedHook)
    || normalizedHook.includes(normalizedNarration));

  if (!alreadyIncluded) {
    firstScene.narration = narration
      ? `${hook}${/[.!?।]$/u.test(hook) ? ' ' : '. '}${narration}`
      : hook;
  }
  if (typeof story.script === 'string') {
    const normalizedScript = normalizeForCompare(story.script);
    if (!normalizedScript.includes(normalizedHook)) {
      story.script = `${hook}${/[.!?।]$/u.test(hook) ? ' ' : '. '}${story.script.trim()}`.trim();
    }
  }

  // Ask for a striking opening shot WITHOUT putting the hook's words into the
  // image description: image models draw quoted/spoken sentences as lettering
  // (V1.7.0 bug: FLUX rendered "Hook text ..." and the Hindi hook on scene 1).
  // The hook itself is delivered by narration and subtitles.
  const visualPrompt = String(firstScene.visualPrompt || '').trim();
  if (!visualPrompt.includes(OPENING_VISUAL_CUE)) {
    firstScene.visualPrompt = [visualPrompt, OPENING_VISUAL_CUE].filter(Boolean).join('\n').slice(0, 1800);
  }

  const pipelineData = story.pipelineData && typeof story.pipelineData === 'object'
    ? story.pipelineData
    : {};
  story.pipelineData = {
    ...pipelineData,
    openingRetention: {
      version: 1,
      hookAppliedToNarration: !alreadyIncluded,
      hookText: hook,
      sceneNumber: Number(firstScene.sceneNumber) || 1,
      language,
      preparedAt: new Date().toISOString()
    }
  };

  return {
    applied: true,
    inserted: !alreadyIncluded,
    hook,
    sceneNumber: Number(firstScene.sceneNumber) || 1
  };
}
