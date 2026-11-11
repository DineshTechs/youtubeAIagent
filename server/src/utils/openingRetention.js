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

/**
 * Make the story's hook part of the actual spoken opening, not just metadata.
 * This is called before visual planning, image generation, TTS and script QA.
 */
export function applyOpeningHook(story, language = 'English') {
  if (!story || !Array.isArray(story.scenes) || story.scenes.length === 0) {
    return { applied: false, reason: 'No story scenes are available.' };
  }

  const hook = String(story.hook || '').replace(/\s+/g, ' ').trim().slice(0, 240);
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

  // Give the first image generator and Visual Director the same opening context
  // that the narrator will speak, so the opening shot does not contradict the hook.
  const visualPrompt = String(firstScene.visualPrompt || '').trim();
  const hookCue = `Opening hook: ${hook}. The opening frame should immediately communicate this curiosity hook while matching the first scene's narrated action.`;
  if (!normalizeForCompare(visualPrompt).includes(normalizedHook)) {
    firstScene.visualPrompt = [visualPrompt, hookCue].filter(Boolean).join('\n').slice(0, 1800);
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
