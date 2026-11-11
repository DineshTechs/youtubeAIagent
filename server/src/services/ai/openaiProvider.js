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
 async generateStory({series,characters,episodeNumber,topic,recentStories=[],language=series?.language||'English',format='Short',durationSec=55,hookStyle='Curiosity',audience=series?.targetAge||'4-8'}){
  const characterText=characters.map(c=>`${c.name}: ${c.personality}. Appearance: ${c.appearance}. Voice: ${c.voiceProfile||'warm child-friendly narrator'}`).join('\n');
  const prompt=`Create one original YouTube Short for children age ${series.targetAge}. Series: ${series.name}. Premise: ${series.premise}. Visual style: ${series.visualStyle}. Rules: ${series.rules.join('; ')}.\nCharacters:\n${characterText}\nEpisode ${episodeNumber}. Niche: ${series.niche||'general kids content'}. Channel strategy: ${JSON.stringify(series.contentStrategy||{})}. Channel research: ${JSON.stringify(series.channelResearch?.strategy||{})}. Recent generated videos (do not repeat): ${JSON.stringify(recentStories)}. Topic suggestion: ${topic||'choose a fresh topic that fits the niche and strategy'}.
Return ONLY valid JSON with: title, topic, hook, script, scenes. scenes must be 4-6 items. Each scene: sceneNumber, durationSec, visualPrompt, narration, onScreenText. Total duration 35-55 seconds. Narration and on-screen text must be written in ${language}; if Hindi, use natural Devanagari. Keep language simple and child-friendly for ages 4-8. No copyrighted characters, songs, brands, dangerous instructions, violence, frightening imagery, politics, or mature themes. Every visualPrompt must directly depict the exact action, subjects, setting, objects and emotion described by that scene's narration, never a generic or unrelated image; make the narration the primary visual source of truth; show the exact physical action and interaction described by the narration; use realistic cinematic photography/film language, natural proportions, realistic textures and lighting; do not use cartoon, chibi, anime, flat illustration or generic kids-cartoon styling; include useful camera composition, and keep the same character appearance in every visualPrompt.`;
  const result=await openai('responses',{model:this.model,temperature:this.temperature,max_output_tokens:this.maxOutputTokens,input:[{role:'user',content:prompt}]});
  return parseJson(result.output_text||'');
 }
 async qualityCheck({story,series}){
  const result=await openai('responses',{model:this.model,input:[{role:'user',content:`Review this children's YouTube Short for safety, originality, age appropriateness and production quality. Series rules: ${series.rules.join('; ')}. Story JSON: ${JSON.stringify(story)}. Return ONLY JSON: {"pass":boolean,"score":number,"notes":string[]}. Reject scary, violent, sexual, political, dangerous, copyrighted-character or otherwise inappropriate content.`}]});
  return parseJson(result.output_text||'');
 }
}
