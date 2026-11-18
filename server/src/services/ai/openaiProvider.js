import {STORY_VISUAL_PROMPT_RULE} from '../../utils/visualPlan.js';
import { env } from '../../config/env.js';

function requireKey(){ if(!env.openaiKey) throw new Error('OPENAI_API_KEY is not configured.'); }
async function openai(path, body){
  requireKey();
  const r=await fetch(`https://api.openai.com/v1/${path}`,{method:'POST',headers:{'Authorization':`Bearer ${env.openaiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const text=await r.text();
  if(!r.ok) throw new Error(`OpenAI ${path} failed (${r.status}): ${text.slice(0,800)}`);
  return JSON.parse(text);
}
function parseJson(text){
  try{return JSON.parse(text)}catch{}
  const match=text.match(/```json\s*([\s\S]*?)```/i)||text.match(/\{[\s\S]*\}/);
  if(match) return JSON.parse(match[1]||match[0]);
  throw new Error('AI returned invalid JSON.');
}

export class OpenAIProvider {
 constructor(model = env.textModel, textSettings = {}){ this.model = model || env.textModel; this.temperature=Number.isFinite(Number(textSettings.temperature))?Number(textSettings.temperature):0.7; this.maxOutputTokens=Number(textSettings.maxOutputTokens)||2600; }
 async generateJson(instruction, input = {}, label = 'YouTube skill'){
  const result=await openai('responses',{model:this.model,temperature:this.temperature,max_output_tokens:this.maxOutputTokens,input:[{role:'user',content:`${instruction}\nINPUT JSON:\n${JSON.stringify(input)}\nReturn ONLY valid JSON.`}]});
  return parseJson(result.output_text||'');
 }
 async generateStory({series,channelProfile={},characters=[],episodeNumber,topic,recentStories=[],language=channelProfile.language||series?.language||'English',format=channelProfile.content?.primaryFormat||'Short',durationSec=55,hookStyle=channelProfile.content?.hookStyle||'Curiosity',audience=channelProfile.audience?.description||series?.targetAge||'General audience'}){
  const p=channelProfile||{},content=p.content||{},visual=p.visual||{},narration=p.narration||{},editorial=p.editorial||{};
  const characterText=characters.map(c=>`${c.name}: ${c.personality||''}. Appearance: ${c.appearance||''}. Voice: ${c.voiceProfile||'natural, engaging narration'}`).join('\n');
  const prompt=`Create one original YouTube ${format} for this channel. Channel: ${series.name}. Premise: ${series.premise}. Niche: ${p.niche||series.niche||'General'}. Audience: ${audience}. Language: ${language}. Channel content style: ${content.primaryFormat||'Explainer'}\nTone: ${content.tone||'Engaging and audience-appropriate'}. Channel content style: ${content.primaryFormat||'Explainer'}. Storytelling: ${content.storytellingApproach||'Clear and niche-appropriate'}. Visual style: ${visual.style||series.visualStyle||'Cinematic, high-quality visuals'}. Aspect ratio: ${visual.aspectRatio||'9:16'}. Narration style: ${narration.voiceStyle||'Natural and engaging'}. Creator rules: ${(series.rules||[]).join('; ')}. Channel profile: ${JSON.stringify(p)}. Characters/hosts only when relevant: ${characterText||'No fictional characters required; use real-world subjects, presenters, objects, locations or demonstrations as appropriate.'}. Episode ${episodeNumber}. Recent generated videos (do not repeat): ${JSON.stringify(recentStories)}. Topic: ${topic||'Choose a fresh topic relevant to the channel niche.'}. Create 4-6 scenes for this short-form generation mode, target ${durationSec-10}-${durationSec+5} seconds, a concise ${hookStyle} hook of 3-10 spoken words deliverable in 2-3 seconds, with the exact hook as the first words of scene 1 narration; scene 1 should focus on the hook and context begins in scene 2; plan a meaningful visual/action beat by 5-7 seconds, and match the channel's niche, audience, tone and visual identity. Each scene's visualPrompt must depict the exact subjects and action in its narration. ${STORY_VISUAL_PROMPT_RULE} Do not impose child-friendly or cartoon styling unless explicitly requested by the profile. Apply editorial safety mode ${editorial.safetyMode||'standard'}; avoid unsupported factual claims, invented statistics or quotations, and copied source material. Return ONLY JSON with title, topic, hook, script and scenes (sceneNumber, durationSec, visualPrompt, narration, onScreenText).`;
  const result=await openai('responses',{model:this.model,temperature:this.temperature,max_output_tokens:this.maxOutputTokens,input:[{role:'user',content:prompt}]});
  return parseJson(result.output_text||'');
 }
 async qualityCheck({story,series,channelProfile={}}){
  const result=await openai('responses',{model:this.model,input:[{role:'user',content:`Review this YouTube video script against its channel profile. Evaluate niche relevance, audience suitability, factual reliability where applicable, originality, clarity, structure and production readiness. Do not assume children's content unless safetyMode is kids-and-family. Profile: ${JSON.stringify(channelProfile)}. Rules: ${(series?.rules||[]).join('; ')}. Story: ${JSON.stringify(story)}. Flag unsupported claims, unsafe instructions, misleading claims, copied material or audience mismatch. Return ONLY JSON: {"pass":boolean,"score":number,"notes":string[]}.`}]});
  return parseJson(result.output_text||'');
 }
}
