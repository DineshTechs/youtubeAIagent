// Edit one scene of an existing video: new image direction and/or new narration.
// The AI turns the user's instruction (any language) into an English still-image
// description, because image models only follow English reliably.
import {isEnglishVisualText,stripEditingDirections} from '../utils/visualPlan.js';

export const MAX_INSTRUCTION=1000, MAX_NARRATION=1200;

export function sceneVisualInstruction(){
  return `You are a visual director for a YouTube Short. Rewrite ONE scene's still-image description following the creator's instruction.
Rules: write in ENGLISH only, even if the instruction or narration is in another language; describe one concrete moment — subject, action, setting, important objects, emotion, camera framing; it must still illustrate the scene narration; follow the channel visual style; no text, captions, logos or written words in the image; no editing directions (no "cut to", "zoom", "transition"); max 90 words.
Return JSON only: {"visualPrompt":""}`;
}

export function validateEdit({imageInstruction='',narration='',regenerateImage}={}){
  const instruction=String(imageInstruction||'').trim();
  const text=String(narration||'').trim();
  if(instruction.length>MAX_INSTRUCTION)throw new Error(`Image description is too long (max ${MAX_INSTRUCTION} characters).`);
  if(text.length>MAX_NARRATION)throw new Error(`Narration is too long (max ${MAX_NARRATION} characters).`);
  // Default: regenerate the image unless only the narration changed.
  const image=Boolean(instruction)||regenerateImage===true||(!text&&regenerateImage!==false);
  if(!instruction&&!text&&!image)throw new Error('Nothing to change.');
  return {instruction,narration:text,regenerateImage:image};
}

// Returns an English visual prompt for the scene.
export async function rewriteSceneVisual({provider,instruction,narration,currentVisual,style,language}){
  let prompt='';
  try{
    const r=await provider.generateJson(sceneVisualInstruction(),{instruction,sceneNarration:narration,narrationLanguage:language,currentVisual,channelVisualStyle:style},'scene-edit');
    prompt=stripEditingDirections(String(r?.visualPrompt||r?.prompt||'').trim()).slice(0,1200);
  }catch(e){if(!isEnglishVisualText(instruction))throw new Error(`Could not turn the description into an image prompt: ${e.message}`);}
  if(prompt&&isEnglishVisualText(prompt))return prompt;
  // AI unavailable or not English: an English instruction can be used directly.
  if(isEnglishVisualText(instruction))return stripEditingDirections(instruction).slice(0,1200);
  throw new Error('Could not create an English image description. Try describing the image in English.');
}

// Applies the edit to a plain story object; returns {scenes, visualDirectorPlan}.
export function applySceneEdit(story,sceneNumber,{visualPrompt,narration,instruction}){
  const scenes=(story.scenes||[]).map(s=>({...s}));
  const i=scenes.findIndex((s,idx)=>Number(s.sceneNumber||idx+1)===Number(sceneNumber));
  if(i<0)throw new Error(`Scene ${sceneNumber} not found.`);
  if(narration)scenes[i].narration=narration;
  if(visualPrompt)scenes[i].visualPrompt=visualPrompt;
  let plan=story.pipelineData?.visualDirectorPlan||null;
  if(plan&&visualPrompt&&Array.isArray(plan.scenes)){
    // Replace the plan's details for this scene so old subject/action do not fight the new image.
    plan={...plan,scenes:plan.scenes.map(p=>Number(p.sceneNumber)===Number(sceneNumber)?{...p,visualPrompt,subject:'',action:'',setting:'',importantObjects:'',emotion:'',camera:'',composition:'',userInstruction:instruction||'',editedAt:new Date()}:p)};
  }
  return {scenes,visualDirectorPlan:plan};
}
