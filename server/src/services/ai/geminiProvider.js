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
 async generateStory({series,characters,episodeNumber,topic,recentStories=[],language=series?.language||'English',format='Short',durationSec=55,hookStyle='Curiosity',audience=series?.targetAge||'4-8'}){const chars=characters.map(c=>`${c.name}: ${c.personality}. Appearance: ${c.appearance}. Voice: ${c.voiceProfile||'warm child-friendly narrator'}`).join('\n');const prompt=`Create one original YouTube Short for children age ${series.targetAge}.\nSeries: ${series.name}\nPremise: ${series.premise}\nVisual style: ${series.visualStyle}\nRules: ${series.rules.join('; ')}\nCharacters:\n${chars}\nEpisode: ${episodeNumber}\nNiche: ${series.niche||'general kids content'}\nChannel strategy: ${JSON.stringify(series.contentStrategy||{})}\nChannel research summary: ${JSON.stringify(series.channelResearch?.strategy||{})}\nRecent generated videos (DO NOT repeat these topics/titles): ${JSON.stringify(recentStories)}\nTopic: ${topic||'choose a fresh topic that fits the niche and strategy'}\nRequirements: ${durationSec-10}-${durationSec+5} seconds, 4-6 scenes, write all spoken narration, hook, title, topic and on-screen text in ${language} (Hindi must use natural Devanagari), appropriate for audience ${audience}, strong 2-3 second ${hookStyle} hook, consistent character appearance. For every scene, visualPrompt MUST directly and concretely depict the corresponding narration: name the key subject(s), exact action, setting, important object(s), emotion and useful camera composition. Never use a generic or unrelated visual. The narration is the primary source of truth; the visualPrompt must name the exact subjects, physical action, objects, location and emotion from that narration. Use realistic cinematic visual language, not cartoon/anime/flat illustration/kids-cartoon styling. Keep the same recurring character appearance across scenes. Positive and wholesome. No copyrighted characters, songs, brands, violence, frightening imagery, politics, mature themes, dangerous instructions, weapons or sexual content. Return only JSON matching the schema.`;return this.generateJson(prompt,storySchema,'story generation',1800);}
 async qualityCheck({story,series}){const prompt=`Review this children's YouTube Short for safety, originality, age appropriateness and production quality. Target age: ${series.targetAge}. Rules: ${series.rules.join('; ')}. Story JSON: ${JSON.stringify(story)}. Reject scary, violent, sexual, political, dangerous, copyrighted-character or otherwise inappropriate content. Return only JSON matching the schema.`;return this.generateJson(prompt,qaSchema,'quality check',700);}
 async testConnection(){const r=await this.ai.models.generateContent({model:this.model,contents:'Return only JSON: {"ok":true}.',config:{responseMimeType:'application/json',thinkingConfig:{thinkingLevel:'low'},maxOutputTokens:50}});return parseJson(r?.text||'','connection test');}
}
