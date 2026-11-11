import { getActiveProvider } from '../ai/index.js';
import { scoreHook, lintTitle, editDecisions, chapters, retention, viral } from './localTools.js';

const skillNames = ['yt-script','yt-package','yt-edit','yt-comment','yt-plan','yt-viral','yt-retention','yt-shorts','yt-seo','yt-chapters','yt-audit'];
const localSkills = new Set(['yt-edit','yt-viral','yt-retention','yt-chapters']);

const JSON_PROMPTS = {
  'yt-script': ({idea='',context=''}) => ({
    instruction:`You are the yt-script skill. Write a YouTube script from one idea. Generate exactly 5 distinct opening hooks using different hook formulas, then select the strongest two. The first 15 seconds must confirm the click, open a question and prove a payoff. ALWAYS return a non-empty first15s string (not an object), even if it duplicates the strongest opening lines. Then provide the spoken script beat-by-beat with [ON SCREEN: ...] on every beat. Return JSON with exactly these useful fields when possible: hooks (array of 5 strings or objects with text), selected_hooks (array), first15s (string), beats (array), script (string), estimatedRuntimeSeconds. Do not invent statistics, sources, results or claims. Estimate runtime at 150 words/minute. Return JSON only.`, input:{idea,context}
  }),
  'yt-package': ({topic='',script='',titleHint='',thumbnailHint=''}) => ({
    instruction:`You are the yt-package skill. Treat title and thumbnail as one click package. Generate 10 title/thumbnail pairs, then rank them. Enforce: title <=100 chars, flag desktop/mobile truncation, avoid vague adjectives, avoid repeating title words on thumbnail, thumbnail <=3 words where possible. Return top 3 plus a winner brief. Do not invent numbers or claims.`, input:{topic,script:titleOrSlice(script),titleHint,thumbnailHint}
  }),
  'yt-seo': ({title='',script='',topic=''}) => ({
    instruction:`You are the yt-seo skill. Create a YouTube description grounded only in the supplied video, natural keywords, useful tags only, and three search queries the video should target. Never keyword-stuff and never invent facts. Return JSON only.`, input:{title,script:titleOrSlice(script),topic}
  }),
  'yt-shorts': ({transcript='',script='',count=3}) => ({
    instruction:`You are the yt-shorts skill. Find up to ${Math.min(10,Number(count)||3)} standalone Shorts hidden inside the supplied long-form transcript/script. Each must have a clear payoff and a newly written opening line. Include approximate source start/end when timestamps exist. Return JSON only.`, input:{transcript:titleOrSlice(transcript,12000),script:titleOrSlice(script,12000)}
  }),
  'yt-comment': ({comments='',voice=''}) => ({
    instruction:`You are the yt-comment skill. Triage comments into four piles: reply, heart, ignore, escalate. Draft concise replies in the supplied voice and identify one comment to pin. Never fabricate facts or promise actions. Return JSON only.`, input:{comments:titleOrSlice(comments,12000),voice}
  }),
  'yt-plan': ({niche='',cadence='1 long video + 3 Shorts',capacity='unknown',goals=''}) => ({
    instruction:`You are the yt-plan skill. Build a practical one-week YouTube plan matched to the creator's actual capacity. Prefer one anchor, one cheap supporting video, and three Shorts when that fits. Include rationale, dependencies and what to skip if time runs out. Return JSON only.`, input:{niche,cadence,capacity,goals}
  }),
  'yt-audit': ({channelData='',goals=''}) => ({
    instruction:`You are the yt-audit skill. Audit the supplied channel data and finish with ONE highest-leverage fix rather than twenty generic recommendations. Separate observed evidence from hypotheses. Never invent missing metrics. Return JSON only.`, input:{channelData:titleOrSlice(channelData,20000),goals}
  })
};
function titleOrSlice(v,n=8000){return String(v||'').slice(0,n);}
export function listSkills(){return skillNames.map(name=>({name,implemented:true,type:localSkills.has(name)?'local':'ai'}));}

export async function runSkill(skill,payload={}){
  if(!skillNames.includes(skill)) throw new Error(`Unknown YouTube skill: ${skill}`);
  if(skill==='yt-edit') return editDecisions(payload.transcript||payload.srt||'',Number(payload.floor)||.45);
  if(skill==='yt-chapters') return chapters(payload.transcript||payload.srt||'',Number(payload.target)||7);
  if(skill==='yt-retention') return retention(payload.rows||payload.data||[],payload.duration?Number(payload.duration):null);
  if(skill==='yt-viral') return viral(payload.videos||payload.rows||[],Number(payload.min)||1.5);
  const factory=JSON_PROMPTS[skill];
  if(!factory) throw new Error(`${skill} is not implemented yet.`);
  const provider=await getActiveProvider();
  if(typeof provider.generateJson!=='function') throw new Error('The active AI provider does not expose generateJson.');
  const spec=factory(payload);
  const result=await provider.generateJson(spec.instruction,spec.input,skill);
  if(skill==='yt-script') { if(result && typeof result==='object') result.__sourceContext=spec.input.context||''; normalizeScriptResult(result); delete result.__sourceContext; }
  if(skill==='yt-script' && Array.isArray(result.hooks)){
    result.hooks=result.hooks.map(h=>{const text=typeof h==='string'?h:String(h?.text||h?.hook||'');const base=typeof h==='object'&&h!==null&&!Array.isArray(h)?h:{};return {...base,text,score:scoreHook(text)};});
    result.hooks.sort((a,b)=>(b.score?.verdict||0)-(a.score?.verdict||0));
  }
  if(skill==='yt-package' && Array.isArray(result.pairs)) result.pairs=result.pairs.map(p=>({...p,lint:lintTitle(p.title||'',p.thumbnailText||p.thumb||'')})).sort((a,b)=>(b.lint?.score||0)-(a.lint?.score||0));
  return result;
}

function normalizeScriptResult(result){
  if(!result||typeof result!=='object'||Array.isArray(result)) throw new Error('yt-script returned an invalid JSON object.');
  const hookCandidates=result.hooks??result.hookOptions??result.openingHooks??result.hook_options??result.hookOptionsList;
  if(!Array.isArray(result.hooks)&&Array.isArray(hookCandidates)) result.hooks=hookCandidates;
  const first15Candidates=[result.first15s,result.first15Seconds,result.first_15_seconds,result.first_15s,result.opening15s,result.opening15Seconds,result.opening_15_seconds,result.opening15SecondsSection,result.first15SecondSection,result.first15,result.opening,result.openingSection];
  let first15=first15Candidates.find(v=>typeof v==='string'&&v.trim());
  if(!first15){const structured=first15Candidates.find(v=>v&&typeof v==='object');if(structured) first15=structured.text||structured.script||structured.narration||structured.content||structured.description;}
  if(!Array.isArray(result.beats)){const beats=result.productionBeats??result.production_beats??result.scriptBeats??result.script_beats??result.beatByBeat;if(Array.isArray(beats)) result.beats=beats;}
  if(!first15&&Array.isArray(result.beats)&&result.beats.length){
    const lines=result.beats.slice(0,4).map(b=>typeof b==='string'?b:(b?.script||b?.narration||b?.text||'')).filter(Boolean);
    if(lines.length) first15=lines.join(' ');
  }
  if(!first15&&typeof result.script==='string'&&result.script.trim()) first15=result.script.trim().slice(0,650);
  if(!first15&&Array.isArray(result.script)){
    const lines=result.script.slice(0,4).map(b=>typeof b==='string'?b:(b?.narration||b?.text||b?.script||'')).filter(Boolean);
    if(lines.length) first15=lines.join(' ');
  }
  // Last-resort repair: use the supplied context's Existing hook/script rather than failing the whole skill.
  if(!first15){
    const raw=String(arguments.length?arguments[0]?.__sourceContext||'':'');
    const hookMatch=raw.match(/Existing hook:\s*([^\n]+)/i);
    const scriptMatch=raw.match(/Existing script:\s*([\s\S]*)$/i);
    const parts=[hookMatch?.[1],scriptMatch?.[1]].map(x=>String(x||'').trim()).filter(Boolean);
    if(parts.length) first15=parts.join(' ' ).slice(0,650);
  }
  if(first15) result.first15s=String(first15).trim();
  if(!Array.isArray(result.selected_hooks)&&Array.isArray(result.selectedHooks)) result.selected_hooks=result.selectedHooks;
  if(!Array.isArray(result.hooks)||result.hooks.length===0) throw new Error('yt-script returned no hooks.');
  if(!String(result.first15s||'').trim()) throw new Error('yt-script returned no first15s section and no usable opening could be derived.');
}

export function optimizeStory(story){return {hook:scoreHook(story?.hook||''),package:lintTitle(story?.title||'',story?.thumbnailText||''),skillVersion:'youtube-agent-skill-compatible-1.0'};}

function storyScript(story){
  if(typeof story?.script==='string') return story.script;
  if(Array.isArray(story?.script)) return story.script.map(x=>x?.narration||x?.text||'').filter(Boolean).join('\n');
  if(Array.isArray(story?.scenes)) return story.scenes.map(x=>x?.narration||'').filter(Boolean).join('\n');
  return '';
}
function sceneTranscript(story){
  let t=0; const cues=[];
  for(const [i,s] of (story?.scenes||[]).entries()){
    const d=Math.max(2,Number(s?.durationSec)||Math.max(2,Math.ceil(String(s?.narration||'').split(/\s+/).filter(Boolean).length/2.5)));
    const start=t,end=t+d;
    cues.push(`${i+1}\n00:${String(Math.floor(start/60)).padStart(2,'0')}:${String(Math.floor(start%60)).padStart(2,'0')},000 --> 00:${String(Math.floor(end/60)).padStart(2,'0')}:${String(Math.floor(end%60)).padStart(2,'0')},000\n${s?.narration||''}`); t=end;
  }
  return cues.join('\n\n');
}
function skillInputSummary(skill,payload){
  const clone={...payload};
  for(const k of Object.keys(clone)) if(typeof clone[k]==='string'&&clone[k].length>5000) clone[k]=clone[k].slice(0,5000)+'…';
  return clone;
}

/** Run all 11 skills as a production audit suite. Data-dependent skills are explicitly
 * SKIPPED when the generation job has no legitimate source data; they are never fed
 * fabricated channel/comments/retention data. They can be executed by passing those
 * datasets in job.payload.
 */
export async function optimizeForGeneration({story,series,channelProfile={},topic,jobPayload={},onSkillStart,onSkillDone}={}){
  const base=story||{};
  const context=[series?.name?`Channel: ${series.name}`:'',channelProfile?.niche?`Niche: ${channelProfile.niche}`:'',channelProfile?.audience?.description?`Audience: ${channelProfile.audience.description}`:'',channelProfile?.language?`Language: ${channelProfile.language}`:'',channelProfile?.content?.tone?`Tone: ${channelProfile.content.tone}`:'',channelProfile?.content?.primaryFormat?`Content format: ${channelProfile.content.primaryFormat}`:'',series?.premise?`Premise: ${series.premise}`:'',Array.isArray(series?.rules)&&series.rules.length?`Rules: ${series.rules.join('; ')}`:'','Preserve the channel profile, supplied facts and original story intent. Do not assume a children\'s audience unless the profile says kids-and-family.'].filter(Boolean).join('\n');
  const scriptText=storyScript(base); const transcript=sceneTranscript(base);
  const output={enabled:true,generatedAt:new Date().toISOString(),applied:{title:null,hook:null},script:null,package:null,seo:null,shorts:null,local:optimizeStory(base),warnings:[],skillRuns:[]};
  async function run(name,payload,fn,meta={}){
    const started=Date.now(); onSkillStart?.(name); const input=skillInputSummary(name,payload);
    try{const result=await fn();const durationMs=Date.now()-started;output.skillRuns.push({skill:name,status:'COMPLETED',type:localSkills.has(name)?'local':'ai',durationMs,input,output:result,meta});onSkillDone?.(name,true,durationMs);return result;}
    catch(error){const durationMs=Date.now()-started;output.skillRuns.push({skill:name,status:'FAILED',type:localSkills.has(name)?'local':'ai',durationMs,input,output:null,error:String(error?.message||error),meta});output.warnings.push(`${name}: ${error?.message||error}`);onSkillDone?.(name,false,durationMs,String(error?.message||error));return null;}
  }
  function skip(name,payload,reason,meta={}){output.skillRuns.push({skill:name,status:'SKIPPED',type:localSkills.has(name)?'local':'ai',durationMs:0,input:skillInputSummary(name,payload),output:null,meta:{...meta,reason}});onSkillDone?.(name,false,0,reason);}

  const scriptResult=await run('yt-script',{idea:topic||base.topic||base.title||'Create this video',context:`${context}\nExisting hook: ${base.hook||''}\nExisting script: ${titleOrSlice(scriptText,12000)}`},()=>runSkill('yt-script',{idea:topic||base.topic||base.title||'Create this video',context:`${context}\nExisting hook: ${base.hook||''}\nExisting script: ${titleOrSlice(scriptText,12000)}`}));
  if(scriptResult){output.script=scriptResult;const firstHook=Array.isArray(scriptResult.selected_hooks)?scriptResult.selected_hooks[0]:null;const hookCandidate=typeof firstHook==='string'?firstHook:scriptResult.hooks?.[0]?.text;if(hookCandidate) output.applied.hook=hookCandidate;}
  const effectiveScript=titleOrSlice(scriptResult?.script||scriptText,12000);

  const packageResult=await run('yt-package',{topic:topic||base.topic||base.title||'',script:effectiveScript,titleHint:base.title||'',thumbnailHint:base.thumbnailText||''},()=>runSkill('yt-package',{topic:topic||base.topic||base.title||'',script:effectiveScript,titleHint:base.title||'',thumbnailHint:base.thumbnailText||''}));
  if(packageResult){output.package=packageResult;const pairs=packageResult.pairs||packageResult.topPairs||packageResult.titles||[];const winner=packageResult.winner||packageResult.winnerBrief?.title||packageResult.recommended||null;const first=Array.isArray(pairs)?pairs[0]:null;const titleCandidate=typeof winner==='string'?winner:winner?.title||first?.title;if(titleCandidate) output.applied.title=String(titleCandidate).trim();}

  const edit=transcript?await run('yt-edit',{transcript},()=>runSkill('yt-edit',{transcript})):null; if(!transcript) skip('yt-edit',{transcript},'No scene narration available.');
  const plan=await run('yt-plan',{niche:series?.name||topic||base.topic||'YouTube story channel',cadence:jobPayload.cadence||'1 long video + 3 Shorts',capacity:jobPayload.capacity||'unknown',goals:jobPayload.goals||'Publish consistently and improve viewer retention.'},()=>runSkill('yt-plan',{niche:series?.name||topic||base.topic||'YouTube story channel',cadence:jobPayload.cadence||'1 long video + 3 Shorts',capacity:jobPayload.capacity||'unknown',goals:jobPayload.goals||'Publish consistently and improve viewer retention.'}));
  const shorts=await run('yt-shorts',{script:effectiveScript,transcript:effectiveScript,count:3},()=>runSkill('yt-shorts',{script:effectiveScript,transcript:effectiveScript,count:3})); if(shorts) output.shorts=shorts;
  const seo=await run('yt-seo',{title:output.applied.title||base.title||'',topic:topic||base.topic||'',script:effectiveScript},()=>runSkill('yt-seo',{title:output.applied.title||base.title||'',topic:topic||base.topic||'',script:effectiveScript})); if(seo) output.seo=seo;
  const chapter=transcript?await run('yt-chapters',{transcript,target:7},()=>runSkill('yt-chapters',{transcript,target:7})):null; if(!transcript) skip('yt-chapters',{transcript},'No scene narration available.');

  if(jobPayload.comments) await run('yt-comment',{comments:jobPayload.comments,voice:jobPayload.commentVoice||'Helpful, concise, professional.'},()=>runSkill('yt-comment',{comments:jobPayload.comments,voice:jobPayload.commentVoice||'Helpful, concise, professional.'})); else skip('yt-comment',{comments:null,voice:jobPayload.commentVoice||'Helpful, concise, professional.'},'No real channel comments were supplied to this generation job.');
  if(Array.isArray(jobPayload.channelVideos)&&jobPayload.channelVideos.length) await run('yt-viral',{videos:jobPayload.channelVideos,min:Number(jobPayload.viralMin)||1.5},()=>runSkill('yt-viral',{videos:jobPayload.channelVideos,min:Number(jobPayload.viralMin)||1.5})); else skip('yt-viral',{videos:null,min:Number(jobPayload.viralMin)||1.5},'No real channel video-performance dataset was supplied.');
  if(Array.isArray(jobPayload.retentionRows)&&jobPayload.retentionRows.length) await run('yt-retention',{rows:jobPayload.retentionRows,duration:jobPayload.retentionDuration||null},()=>runSkill('yt-retention',{rows:jobPayload.retentionRows,duration:jobPayload.retentionDuration||null})); else skip('yt-retention',{rows:null,duration:null},'Retention analytics are only available after a published video has viewer-retention data.');
  if(jobPayload.channelData) await run('yt-audit',{channelData:jobPayload.channelData,goals:jobPayload.goals||'Improve channel performance.'},()=>runSkill('yt-audit',{channelData:jobPayload.channelData,goals:jobPayload.goals||'Improve channel performance.'})); else skip('yt-audit',{channelData:null,goals:jobPayload.goals||'Improve channel performance.'},'No real channel analytics dataset was supplied.');

  output.completedSkills=output.skillRuns.filter(x=>x.status==='COMPLETED').map(x=>x.skill);
  output.skippedSkills=output.skillRuns.filter(x=>x.status==='SKIPPED').map(x=>x.skill);
  output.failedSkills=output.skillRuns.filter(x=>x.status==='FAILED').map(x=>x.skill);
  output.successCount=output.completedSkills.length; output.skippedCount=output.skippedSkills.length; output.failedCount=output.failedSkills.length;
  output.totalSkills=skillNames.length; output.all11Tracked=output.skillRuns.length===11;
  return output;
}
