import {profileDirectives} from '../channelProfile.js';
import {STORY_VISUAL_PROMPT_RULE} from '../../utils/visualPlan.js';
import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';

function requireKey() { if (!env.geminiKey) throw new Error('GEMINI_API_KEY is not configured.'); }
const storySchema={type:'object',properties:{title:{type:'string'},topic:{type:'string'},hook:{type:'string'},script:{type:'string'},scenes:{type:'array',items:{type:'object',properties:{sceneNumber:{type:'integer'},durationSec:{type:'integer'},visualPrompt:{type:'string'},narration:{type:'string'},onScreenText:{type:'string'}},required:['sceneNumber','durationSec','visualPrompt','narration','onScreenText']}}},required:['title','topic','hook','script','scenes']};
const qaSchema={type:'object',properties:{pass:{type:'boolean'},score:{type:'integer'},notes:{type:'array',items:{type:'string'}}},required:['pass','score','notes']};
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function statusCode(e){return Number(e?.status||e?.code||e?.response?.status||e?.error?.code||0);}
function isDailyQuotaExceeded(e){
 const text=String(e?.message||e||'').toLowerCase();
 const quotaId=String(e?.error?.details?.find?.(d=>d?.['@type']?.includes?.('QuotaFailure'))?.violations?.[0]?.quotaId||'').toLowerCase();
 return text.includes('requests per day limit exceeded') || text.includes('generaterequestsperdayperproject-freetier') || quotaId.includes('generaterequestsperdayperproject-freetier');
}
function isTimeoutError(e){return e?.name==='GeminiTimeoutError'||Number(e?.code)===408||/timed out|timeout/i.test(String(e?.message||''));}
function retryable(e){const s=statusCode(e);return !isDailyQuotaExceeded(e)&&(isTimeoutError(e)||s===408||s===409||s===429||s>=500);}
function quotaErrorMessage(e,label){
 const text=String(e?.message||e||'');
 const retry= text.match(/retry in ([^.]+?)(?:\.|$)/i)?.[1];
 return `Gemini ${label} cannot run because the Gemini Free Tier daily request quota for ${this.model} is exhausted${retry?` (retry suggested in ${retry})`:''}. Switch to another configured AI provider in Settings, or use Mock / Development for local testing.`;
}
function delay(attempt){return Math.min(20000,2000*(2**attempt))+Math.floor(Math.random()*800);}
function parseJson(text,label){if(!text)throw new Error(`Gemini ${label} returned an empty response.`);try{return JSON.parse(text)}catch{} const m=text.match(/```json\s*([\s\S]*?)```/i)||text.match(/\{[\s\S]*\}/);if(m){try{return JSON.parse(m[1]||m[0])}catch{}}throw new Error(`Gemini ${label} returned invalid JSON.`);}
function createRequestDeadline(ms,label){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new Error(`Gemini ${label} timed out after ${Math.round(ms/1000)} seconds.`)),ms);return {signal:controller.signal,clear:()=>clearTimeout(timer),timedOut:()=>controller.signal.aborted};}
function timeoutError(label,ms,cause){const error=new Error(`Gemini ${label} timed out after ${Math.round(ms/1000)} seconds.`,{cause});error.name='GeminiTimeoutError';error.code=408;return error;}
export class GeminiProvider {
 constructor(model = env.geminiTextModel, textSettings = {}){requireKey();this.ai=new GoogleGenAI({apiKey:env.geminiKey});this.model=model || env.geminiTextModel;this.timeoutMs=env.geminiRequestTimeoutMs;this.temperature=Number.isFinite(Number(textSettings.temperature))?Number(textSettings.temperature):0.7;this.maxOutputTokens=Number(textSettings.maxOutputTokens)||2600;}
 async generateJson(prompt, schemaOrInput = {}, label = 'YouTube skill', maxOutputTokens = null){
  // Two contracts are supported:
  // 1) internal story/QA calls: (prompt, responseSchema, label, maxTokens)
  // 2) YouTube Skills: (instruction, input, label)
  const skillCall = arguments.length < 4;
  let requestPrompt = prompt;
  let responseSchema;
  let outputTokens = this.maxOutputTokens;
  if (skillCall) {
    requestPrompt = `${prompt}\n\nINPUT JSON:\n${JSON.stringify(schemaOrInput)}\n\nReturn ONLY a valid JSON object. Do not wrap it in markdown.`;
    // Do not send an empty/generic responseSchema to Gemini. JSON mode alone is
    // more reliable for the heterogeneous 11-skill outputs.
    responseSchema = undefined;
    outputTokens = 2600;
  } else {
    responseSchema = schemaOrInput;
  }
  const started=Date.now();
  const attempts=skillCall ? Math.min(2, Number(env.geminiMaxRetries||1)+1) : Number(env.geminiMaxRetries||4)+1;
  const requestTimeoutMs=skillCall?Math.min(90000,this.timeoutMs):this.timeoutMs;
  let timeoutAttemptCount=0;
  for(let attempt=1;attempt<=attempts;attempt++){
   const deadline=createRequestDeadline(requestTimeoutMs,label);
   try{
    console.log(`[Gemini] ${label} attempt ${attempt}/${attempts} (timeout ${Math.round(requestTimeoutMs/1000)}s).`);
    const config={responseMimeType:'application/json',maxOutputTokens:outputTokens,temperature:this.temperature,thinkingConfig:{thinkingLevel:'low'},abortSignal:deadline.signal,httpOptions:{timeout:requestTimeoutMs+5000}};
    // Gemini 3.x does not support candidateCount; only add a schema when one is real.
    if(responseSchema) config.responseSchema=responseSchema;
    const response=await this.ai.models.generateContent({model:this.model,contents:requestPrompt,config});
    const result=parseJson(response?.text||'',label);
    console.log(`[Gemini] ${label} completed in ${Math.round((Date.now()-started)/1000)}s.`);
    return result;
   }catch(e){
    const timedOut=deadline.timedOut()||isTimeoutError(e);
    if(isDailyQuotaExceeded(e)) throw new Error(quotaErrorMessage(e,label));
    if(timedOut) timeoutAttemptCount++;
    // A timeout gets one fresh attempt only. This prevents long, overlapping retry storms.
    const canRetryTimeout=timedOut&&timeoutAttemptCount<2;
    if((timedOut&&!canRetryTimeout)||(!timedOut&&(!retryable(e)||attempt>=attempts))) {
      const detail=timedOut?timeoutError(label,requestTimeoutMs,e):e;
      throw new Error(`Gemini ${label} request failed: ${detail?.message||e?.message||e}`);
    }
    const ms=timedOut?Math.min(5000,2000+Math.floor(Math.random()*1000)):delay(attempt-1);
    console.warn(`[Gemini] ${label} attempt ${attempt} failed with ${timedOut?'timeout':(statusCode(e)||'transient error')}. Retrying in ${Math.round(ms/100)/10}s.`);
    await sleep(ms);
   }finally{
    deadline.clear();
   }
  }
 }
 async generateStory({series,channelProfile={},characters=[],episodeNumber,topic,recentStories=[],language=channelProfile.language||series?.language||'English',format=channelProfile.content?.primaryFormat||'Short',durationSec=55,hookStyle=channelProfile.content?.hookStyle||'Curiosity',audience=channelProfile.audience?.description||series?.targetAge||'General audience'}){
  const p=channelProfile||{},content=p.content||{},visual=p.visual||{},narration=p.narration||{},editorial=p.editorial||{};
  const chars=characters.map(c=>`${c.name}: ${c.personality||''}. Appearance: ${c.appearance||''}. Voice: ${c.voiceProfile||'natural, engaging narration'}`).join('\n');
  const prompt=`Create one original YouTube ${format} for this channel.\nChannel: ${series.name}\nPremise: ${series.premise}\nNiche: ${p.niche||series.niche||'General'}\nTarget audience: ${audience}\nLanguage: ${language}\nChannel content style: ${content.primaryFormat||'Explainer'}\nTone: ${content.tone||'Engaging and audience-appropriate'}\nStorytelling: ${content.storytellingApproach||'Clear and niche-appropriate'}\nPacing: ${content.pacing||'Dynamic but easy to follow'}\nVisual style: ${visual.style||series.visualStyle||'Cinematic, high-quality visuals'}\nAspect ratio: ${visual.aspectRatio||'9:16'}\nNarration style: ${narration.voiceStyle||'Natural and engaging'}\nCreator rules: ${(series.rules||[]).join('; ')}\nChannel strategy: ${JSON.stringify(series.contentStrategy||{})}\nChannel profile: ${JSON.stringify(p)}\nCharacters or recurring hosts (only if relevant):\n${chars||'No recurring fictional characters required; use real-world subjects, presenters, objects, places or demonstrations as appropriate.'}\nEpisode: ${episodeNumber}\nRecent videos (do not repeat): ${JSON.stringify(recentStories)}\nTopic: ${topic||'Choose a fresh topic relevant to the channel niche.'}\nRequirements: ${durationSec-10}-${durationSec+5} seconds; 4-6 scenes for this short-form mode; write narration, title, hook and on-screen text in ${language}; suit the audience ${audience}; a single concise ${hookStyle} hook of 3-10 spoken words that can be delivered in about 2-3 seconds; put that exact hook as the FIRST words of scene 1 narration; scene 1 should focus on delivering the hook only, then move into context in scene 2; plan a meaningful visual/action beat by 5-7 seconds; match the channel tone and visual identity. Every scene visualPrompt must directly depict its narration with concrete subjects, action, setting, objects and camera composition. ${STORY_VISUAL_PROMPT_RULE} Do not force child-friendly, cartoon or family-oriented styling unless the profile explicitly calls for it. Apply editorial safety mode ${editorial.safetyMode||'standard'}. Avoid unsupported factual claims, invented statistics or quotations, and copied source material. ${profileDirectives(p)} Return only JSON matching the schema.`;
  return this.generateJson(prompt,storySchema,'story generation',1800);
 }
 async qualityCheck({story,series,channelProfile={}}){
  const prompt=`Review this YouTube video script against its channel profile. Evaluate niche relevance, audience suitability, factual reliability where applicable, originality, clarity, structure, narration and production readiness. Do not assume children's content unless safetyMode is kids-and-family. Profile: ${JSON.stringify(channelProfile)}. Creator rules: ${(series?.rules||[]).join('; ')}. Story: ${JSON.stringify(story)}. Flag unsupported claims, unsafe instructions, misleading claims, copied material or audience mismatch. Return only JSON matching the schema.`;
  return this.generateJson(prompt,qaSchema,'quality check',700);
 }
 async testConnection(){const r=await this.ai.models.generateContent({model:this.model,contents:'Return only JSON: {"ok":true}.',config:{responseMimeType:'application/json',thinkingConfig:{thinkingLevel:'low'},maxOutputTokens:50}});return parseJson(r?.text||'','connection test');}
}
