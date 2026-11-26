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

// ---- Choosing the opening hook ---------------------------------------------
// The YouTube "yt-script" skill writes hooks from the topic alone, so its hook can be
// short or about something the narration never says. It replaces the story's own hook
// only when it is in the right language, long enough and clearly about this story.
const STOP=new Set(('the a an and or but of to in on at for with from by is are was were be been it this that these those you your we our they their he she his her i me my not no yes do does did have has had will would can could should what why how when where who which there here than then so just very more most also into about over out up down if as one all any some each ' +
  'और या है हैं था थी थे हो होता होती होते के का की को में से पर भी तो ही यह वह ये वो इस उस इन उन एक कि जो क्या क्यों कैसे कब कहाँ कौन नहीं ना हाँ मैं हम आप तुम उनका उसका अपना अपनी अपने लिए साथ तक बहुत अब फिर कुछ सब कर करना करते करती किया गया गई गए रहा रही रहे जब तब').split(/\s+/));
export function contentWords(text){
  return new Set(String(text||'').toLowerCase().normalize('NFC').split(/[^\p{L}\p{M}\p{N}]+/u).filter(w=>w&&!STOP.has(w)&&(/[\u0900-\u097f]/u.test(w)?w.length>=2:w.length>=3)));
}
export function hookFit(hook,narration){
  const h=contentWords(hook),n=contentWords(narration);
  const shared=[...h].filter(w=>n.has(w));
  return {words:String(hook||'').trim().split(/\s+/).filter(Boolean).length,shared:shared.length,ratio:h.size?shared.length/h.size:0};
}
export const MIN_HOOK_WORDS=6;
export function chooseHook({original,optimized,story,language='English'}){
  const o=cleanHook(original),x=cleanHook(optimized);
  const narration=(story?.scenes||[]).map(sc=>sc?.narration||'').join(' ');
  const lang=String(language).toLowerCase();
  const rightLanguage=t=>(!lang.startsWith('hindi')||/[\u0900-\u097f]/u.test(t))&&(!lang.startsWith('english')||(/[a-z]/i.test(t)&&!/[\u0900-\u097f]/u.test(t)));
  const good=t=>{const f=hookFit(t,narration);return rightLanguage(t)&&f.words>=MIN_HOOK_WORDS&&f.shared>=2&&f.ratio>=0.3;};
  if(!x)return {hook:o,source:'story',reason:'no optimized hook'};
  if(!rightLanguage(x))return {hook:o,source:'story',reason:'optimized hook is in a different language'};
  const fx=hookFit(x,narration);
  if(fx.words<MIN_HOOK_WORDS)return {hook:o||x,source:o?'story':'optimized',reason:`optimized hook is too short (${fx.words} words)`};
  if(o&&x.length<o.length*0.6&&good(o))return {hook:o,source:'story',reason:'optimized hook is much shorter than the story hook'};
  if(!good(x))return {hook:o||x,source:o?'story':'optimized',reason:`optimized hook does not match the narration (${fx.shared} shared words)`};
  return {hook:x,source:'optimized',reason:'optimized hook fits the narration'};
}
