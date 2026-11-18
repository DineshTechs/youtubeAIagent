import {useEffect,useMemo,useRef,useState} from 'react';
import {redactDeep,redactText,safeFileStem} from './redact.js';
const API='http://127.0.0.1:4000/api';
const STORAGE='http://127.0.0.1:4000';
const VIDEO_STATUSES=['ALL','PLANNED','SCRIPT_GENERATED','SCRIPT_QA','ASSETS_GENERATING','VIDEO_RENDERING','VIDEO_QA','AWAITING_APPROVAL','APPROVED','UPLOADING','SCHEDULED','PUBLISHED','FAILED','CANCELLED'];
function pct(job){return Math.max(0,Math.min(100,job?.progress||0));}
function label(value){return String(value||'').replaceAll('_',' ');}
function isActive(job){return !!job&&['QUEUED','RUNNING'].includes(job.status);}
const PIPELINE_STEPS=[
  ['PLANNED','Plan'],
  ['SCRIPT_GENERATED','Script'],
  ['SCRIPT_QA','Script QA'],
  ['ASSETS_GENERATING','Assets'],
  ['VIDEO_RENDERING','Render'],
  ['VIDEO_QA','Video QA'],
  ['AWAITING_APPROVAL','Approval'],
  ['APPROVED','Approved'],
  ['UPLOADING','Upload'],
  ['SCHEDULED','Scheduled'],
  ['PUBLISHED','Published']
];
function completedSteps(video){
  const history=(video?.statusHistory||[]).map(x=>x.status);
  const reachedIndexes=PIPELINE_STEPS.map(([status])=>history.lastIndexOf(status));
  const maxReached=Math.max(-1,...reachedIndexes);
  const current=video?.status;
  return PIPELINE_STEPS.map(([status,name],index)=>{
    const reached=history.includes(status)||status===current;
    const isCurrent=status===current;
    const terminalCompleted=isCurrent&&['APPROVED','PUBLISHED'].includes(current);
    const done=terminalCompleted || index<maxReached || (reached && !isCurrent && index<maxReached);
    const active=isCurrent && !terminalCompleted && !['FAILED','CANCELLED'].includes(current);
    return {status,name,reached,done,active};
  });
}

const JOB_STEPS=[
  ['PLANNING','Plan'],
  ['SCRIPT_GENERATING','Script'],
  ['SCRIPT_QA','Script QA'],
  ['ASSETS_GENERATING','Assets'],
  ['VOICE','Voice'],
  ['VIDEO_RENDERING','Render'],
  ['VIDEO_QA','Video QA'],
  ['AWAITING_APPROVAL','Approval']
];
function jobStepProgress(job){
  const current=String(job?.step||'');
  const progress=pct(job);
  const currentIndex=JOB_STEPS.findIndex(([key])=>key===current);
  const completedByProgress=[7,21,24,60,64,93,99,100];
  return JOB_STEPS.map(([key,name],index)=>({
    key,name,
    done:progress>=completedByProgress[index] || (currentIndex>index),
    active:index===currentIndex && !['COMPLETED','FAILED','CANCELLED'].includes(job?.status),
    reached:progress>=([0,8,22,25,61,65,94,100][index]) || index===currentIndex
  }));
}

function JobStepProgress({job}){
  const steps=jobStepProgress(job);
  const completed=steps.filter(x=>x.done).length;
  const current=steps.find(x=>x.active);
  return <div className="jobStepProgress">
    <div className="stepProgressHead"><span>Task steps completed</span><b>{completed}/{steps.length}</b>{current&&<em>Current: {current.name}</em>}</div>
    <div className="stepTrack">{steps.map((x,i)=><div key={x.key} className={`stepItem ${x.done?'done':''} ${x.active?'active':''} ${x.reached?'reached':''}`} title={`${x.name}: ${x.done?'completed':x.active?'in progress':'not reached'}`}><span>{x.done?'✓':x.active?'•':i+1}</span><small>{x.name}</small></div>)}</div>
  </div>;
}

function JsonBlock({value}){
  let text='';
  try{text=JSON.stringify(value,null,2);}catch{text=String(value??'');}
  return <div className="traceJson"><pre>{text}</pre></div>;
}

function ToolRuns({runs=[]}){
  if(!Array.isArray(runs)||!runs.length)return null;
  return <div className="toolRuns"><div className="traceLabel">YOUTUBE TOOLS / SKILLS — INPUT & OUTPUT</div>{runs.map((run,i)=><details className={`toolRun tool-${String(run.status||'').toLowerCase()}`} key={`${run.skill||'tool'}-${i}`} open={run.status!=='COMPLETED' || i===0}>
    <summary><span className="traceStatus">{run.status==='COMPLETED'?'✓':run.status==='FAILED'?'✕':run.status==='SKIPPED'?'–':'•'}</span><b>{run.skill||'Tool'}</b><em>{run.durationMs!=null?`${run.durationMs}ms`:''}</em></summary>
    <div className="toolRunBody">
      <div className="toolRunMeta"><span>Type <b>{run.type||'—'}</b></span><span>Status <b>{run.status||'—'}</b></span>{run.meta&&<span>Provider <b>{run.meta.provider||run.meta.model||'local'}</b></span>}</div>
      {run.input!==undefined&&<div><small className="traceLabel">INPUT</small><JsonBlock value={run.input}/></div>}
      {run.output!==undefined&&<div><small className="traceLabel">OUTPUT</small><JsonBlock value={run.output}/></div>}
      {run.error&&<div><small className="traceLabel">ERROR</small><div className="traceError">{run.error}</div></div>}
    </div>
  </details>)}</div>;
}

function PipelineTrace({job}){
  const trace=Array.isArray(job?.pipelineTrace)?job.pipelineTrace:[];
  const [openAll,setOpenAll]=useState(true);
  if(!trace.length)return <div className="traceEmpty">No pipeline trace recorded yet. Start a new generation to capture every stage.</div>;
  return <div className="pipelineTraceWrap">
    <div className="traceToolbar"><span>{trace.length} stages captured · every stage has its saved execution data</span><div><button className="ghost" onClick={()=>setOpenAll(true)}>Expand all</button><button className="ghost" onClick={()=>setOpenAll(false)}>Collapse all</button></div></div>
    <div className="pipelineTrace">{trace.map((x,i)=><details className={`traceStage trace-${String(x.status||'').toLowerCase()}`} key={x.stageId||i} open={openAll || i===trace.length-1}>
      <summary><span className="traceStatus">{x.status==='COMPLETED'?'✓':x.status==='FAILED'?'✕':x.status==='SKIPPED'?'–':'•'}</span><b>{label(x.stage)}</b><em>{x.durationMs!=null?`${x.durationMs}ms`:'running'}</em></summary>
      <div className="traceBody">
        <div className="traceMeta"><span>Stage <b>#{i+1}</b></span><span>Status <b>{x.status}</b></span>{x.startedAt&&<span>Started {new Date(x.startedAt).toLocaleString()}</span>}{x.completedAt&&<span>Finished {new Date(x.completedAt).toLocaleString()}</span>}{x.durationMs!=null&&<span>Duration <b>{x.durationMs} ms</b></span>}</div>
        {x.input!==undefined&&<div><small className="traceLabel">INPUT — what this step received</small><JsonBlock value={x.input}/></div>}
        {x.output!==undefined&&<div><small className="traceLabel">OUTPUT — what this step produced</small><JsonBlock value={x.output}/></div>}
        {x.meta!==undefined&&<div><small className="traceLabel">META — provider/model/configuration</small><JsonBlock value={x.meta}/></div>}
        {x.stage==='YOUTUBE_OPTIMIZATION'&&x.output?.skillRuns&&<ToolRuns runs={x.output.skillRuns}/>}
        {x.error&&<div><small className="traceLabel">ERROR</small><div className="traceError">{x.error}</div></div>}
      </div>
    </details>)}</div>
  </div>;
}


function StepProgress({video,compact=false}){
  const steps=completedSteps(video);
  const completed=steps.filter(x=>x.done).length;
  const current=steps.find(x=>x.active);
  return <div className={`stepProgress ${compact?'compact':''}`}>
    <div className="stepProgressHead"><span>Steps completed</span><b>{completed}/{steps.length}</b>{current&&<em>Current: {current.name}</em>}</div>
    <div className="stepTrack">{steps.map((x,i)=><div key={x.status} className={`stepItem ${x.done?'done':''} ${x.active?'active':''} ${x.reached?'reached':''}`} title={`${x.name}: ${x.done?'completed':x.active?'in progress':'not reached'}`}><span>{x.done?'✓':x.active?'•':i+1}</span><small>{x.name}</small></div>)}</div>
  </div>;
}

function audioReportLines(ai){
  if(!ai)return [];
  const levels=ai.peakDbfs==null?'levels unavailable':`peak ${Number(ai.peakDbfs).toFixed(1)} dBFS, RMS ${ai.rmsDbfs==null?'n/a':Number(ai.rmsDbfs).toFixed(1)+' dBFS'}`;
  return [`    Audio levels: ${levels}; total quiet ${Number(ai.totalSilenceSec||0).toFixed(2)}s in ${ai.gapCount||0} gap(s)`,...(ai.gaps||[]).map(g=>`    Gap ${g.index}: ${Number(g.startSec).toFixed(2)}–${Number(g.endSec).toFixed(2)}s (${Number(g.durationSec).toFixed(2)}s, ${g.severity||'n/a'}${g.reviewRequired?', review':''}) ${g.reason||''}`)];
}

// Read-only audio details shown inside the existing QA report. The same
// object is stored in the QA JSON, so dashboard and exports always match.
function AudioDetails({data}){
  if(!data)return null;
  const gaps=Array.isArray(data.gaps)?data.gaps:[];
  const fmt=v=>v==null||!Number.isFinite(Number(v))?'n/a':`${Number(v).toFixed(1)} dBFS`;
  return <div className="audioDetails">
    <div className="audioLevels"><span>Peak <b>{fmt(data.peakDbfs)}</b></span><span>RMS <b>{fmt(data.rmsDbfs)}</b></span><span>Quiet total <b>{Number(data.totalSilenceSec||0).toFixed(2)}s</b></span><span>Gaps <b>{gaps.length}</b>{data.reviewGapCount?` · ${data.reviewGapCount} worth a listen`:''}</span></div>
    {gaps.length>0&&<ul className="audioGaps">{gaps.map(g=><li key={g.index||g.startSec} className={g.reviewRequired?'review':''}><b>{Number(g.startSec).toFixed(2)}–{Number(g.endSec).toFixed(2)}s</b><span className={`gapSeverity ${g.severity||''}`}>{g.severity||'n/a'} · {Number(g.durationSec).toFixed(2)}s</span><span>{g.reason||''}</span></li>)}</ul>}
    {data.analysis?.note&&<small className="muted">{data.analysis.note}</small>}
  </div>;
}

function DiagnosticsExport({selected}){
  const [notice,setNotice]=useState('');
  const video=selected||{};
  const jobs=Array.isArray(video.jobs)?video.jobs:(video.latestJob?[video.latestJob]:[]);
  const latest=jobs[0]||{};
  const story=video.storyId&&typeof video.storyId==='object'?video.storyId:null;
  const redact=redactDeep;
  const logs=jobs.flatMap(job=>(job.logs||[]).map(x=>({jobId:String(job._id||''),at:x.at,level:x.level||'info',message:x.message||''})));
  const timeline=(story?.scenes||[]).map((scene,i)=>({scene:i+1,durationSec:scene.durationSec,narration:scene.narration||scene.text||'',image:scene.imagePrompt||scene.visualPrompt||''}));
  const bundle=()=>redact({
    exportedAt:new Date().toISOString(),
    video:{id:String(video._id||''),title:video.title,status:video.status,durationSec:video.durationSec,renderPath:video.renderPath,error:video.error},
    qa:video.qa||null,
    jobs:jobs.map(j=>({_id:j._id,type:j.type,status:j.status,step:j.step,progress:j.progress,retryCount:j.retryCount,error:j.error,startedAt:j.startedAt,completedAt:j.completedAt,logs:j.logs||[],pipelineTrace:j.pipelineTrace||[]})),
    story:story?{title:story.title,hook:story.hook,language:story.language,scenes:story.scenes}:null,
    sceneTimeline:timeline,
    visualReview:video.visualReview||{}
  });
  const qaText=()=>{const q=video.qa||{};return [`VIDEO QA REPORT`,`Video: ${video.title||video._id||'Unknown'}`,`Score: ${q.score??'N/A'}`,`Retention: ${q.retention?.score??'N/A'}`,`Summary: ${JSON.stringify(q.summary||{})}`,'',...(q.checks||[]).flatMap(c=>[`${c.status||''} | ${c.name||''} | ${c.message||''}`,...audioReportLines(c.audioIntelligence)])].join('\n');};
  const logText=()=>redactText(logs.map(x=>`[${x.at?new Date(x.at).toISOString():'unknown'}] [${x.level}] [${x.jobId}] ${x.message}`).join('\n')||'No generation logs were recorded.');
  const copy=async(text)=>{try{await navigator.clipboard.writeText(redactText(text));setNotice('Copied to clipboard');}catch{setNotice('Clipboard unavailable. Use the download buttons instead.');}};
  const download=(name,content,type='text/plain;charset=utf-8')=>{const blob=new Blob([redactText(content)],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);setNotice(`${name} downloaded`);};
  const safeName=safeFileStem(video.title,video._id||'video');
  return <section className="qaPanel diagnosticsPanel"><div className="sectionHead"><div><small className="eyebrow">DEBUG & EXPORT</small><h4>Copy & Export Center</h4></div><span className="muted">{jobs.length} generation attempt(s)</span></div>
    <div className="diagnosticActions">
      <button className="ghost" onClick={()=>copy(logText())}>Copy generation logs</button>
      <button className="ghost" onClick={()=>copy(qaText())} disabled={!video.qa}>Copy QA report</button>
      <button className="ghost" onClick={()=>copy(JSON.stringify(redact(video.qa||{}),null,2))} disabled={!video.qa}>Copy QA JSON</button>
      <button className="ghost" onClick={()=>copy(JSON.stringify(redact(timeline),null,2))} disabled={!timeline.length}>Copy scene timeline</button>
      <button className="ghost" onClick={()=>copy(story?.scenes?.map(s=>s.narration||s.text||'').join('\n\n')||'No narration available') } disabled={!story}>Copy narration</button>
      <button className="ghost" onClick={()=>download(`${safeName}-generation-logs.txt`,logText())}>Download logs .txt</button>
      <button className="ghost" onClick={()=>download(`${safeName}-qa-report.txt`,qaText())} disabled={!video.qa}>Download QA .txt</button>
      <button className="ghost" onClick={()=>download(`${safeName}-diagnostics.json`,JSON.stringify(bundle(),null,2),'application/json;charset=utf-8')}>Download diagnostics .json</button>
      <button className="ghost" onClick={()=>download(`${safeName}-diagnostics.txt`,[`GENERATION LOGS\n${logText()}`,`QA REPORT\n${qaText()}`,`SCENE TIMELINE\n${JSON.stringify(timeline,null,2)}`].join('\n\n'))}>Download all .txt</button>
    </div>{notice&&<small className="muted" role="status">{notice}</small>}
    <p className="muted">Exports include available job logs, QA checks, scene timeline and pipeline trace. Secret-like fields and secrets inside log text (API keys, tokens, database URLs, cookies) are redacted. A ZIP export is not included in this browser-only build.</p>
  </section>;
}


// ---------------------------------------------------------------------------
// V1.8 dashboard shell: Create · Videos · Channel Profiles · Analytics · Settings
// Everything below App() helpers above is unchanged from V1.7 (pipeline
// inspector, step tracker, audio details, Copy & Export Center).
// ---------------------------------------------------------------------------
const NAV=[
  ['create','Create','Generate a video from a saved profile'],
  ['videos','Videos','Review, approve and manage videos'],
  ['profiles','Channel Profiles','Who each channel is for and how it sounds'],
  ['analytics','Analytics','Production overview'],
  ['settings','Settings','Providers, output, quality and storage']
];
const NAV_ICONS={
  create:'M12 5v14M5 12h14',
  videos:'M4 6h11v12H4zM15 10l5-3v10l-5-3',
  profiles:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c1.5-4 4.5-6 8-6s6.5 2 8 6',
  analytics:'M5 19V11M12 19V5M19 19v-6',
  settings:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .3-1.4-1.4.3-2-3-1-1 2h-2l-1-2-3 1 .3 2L5.8 7.3 4 7l-1 3 2 1v2l-2 1 1 3 2-.3 1.4 1.4-.3 2 3 1 1-2h2l1 2 3-1-.3-2 1.4-1.4 2 .3 1-3-2-1z'
};
function Icon({name,size=18}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={NAV_ICONS[name]||''}/></svg>;}

const FORMAT_OPTIONS=['Explainer','Story Short','Storytelling','Documentary','Tutorial','Commentary','Review','News & Analysis','Interview','Listicle','Case Study','Fact Short','Educational Short'];
const HOOK_OPTIONS=['Curiosity','Question','Surprise','Emotional','Problem / Solution'];
const DURATION_OPTIONS=[30,35,45,55,60,90];
const DEFAULT_PROFILE_FORM={name:'',premise:'',niche:'',targetAge:'General audience',language:'English',visualStyle:'Cinematic, high-quality visuals',tone:'Engaging and informative',contentFormat:'Explainer',aspectRatio:'9:16',voiceStyle:'Natural, clear and engaging',durationSec:55,hookStyle:'Curiosity'};
const KIDS_RE=/kids?|children|preschool|toddler/i;

// One place that turns a saved series into the editable profile form
// (previously copy-pasted three times).
function formFromSeries(x){
  if(!x)return {...DEFAULT_PROFILE_FORM};
  const cp=x.channelProfile||{};
  return {
    name:x.name||'',premise:x.premise||'',niche:x.niche||cp.niche||'',
    targetAge:cp.audience?.description||(x.targetAge==='4-8'&&!KIDS_RE.test(x.niche||'')?'General audience':x.targetAge)||'General audience',
    language:cp.language||x.language||'English',
    visualStyle:cp.visual?.style||x.visualStyle||'',
    tone:cp.content?.tone||'Engaging and informative',
    contentFormat:cp.content?.primaryFormat||'Explainer',
    aspectRatio:cp.visual?.aspectRatio||'9:16',
    voiceStyle:cp.narration?.voiceStyle||'Natural, clear and engaging',
    durationSec:Number(cp.content?.durationSec)||55,
    hookStyle:cp.content?.hookStyle||'Curiosity'
  };
}
function sameForm(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function videoFileUrl(v){return v?.renderPath?`${STORAGE}/storage/videos/${v._id}/${encodeURIComponent(String(v.renderPath).split(/[\\/]/).pop())}?v=${encodeURIComponent(v.updatedAt||v.renderPath)}`:null;}
function thumbUrl(v){const first=(v?.mediaAssetDetails||v?.sceneAssets||[]).find(a=>a?.path||a?.fileName);if(!first)return null;const name=first.fileName||String(first.path).split(/[\\/]/).pop();return `${STORAGE}/storage/videos/${v._id}/scenes/${encodeURIComponent(name)}?v=${encodeURIComponent(v.updatedAt||'')}`;}
function timeAgo(d){if(!d)return '—';const s=Math.max(0,(Date.now()-new Date(d).getTime())/1000);if(s<60)return 'just now';if(s<3600)return `${Math.floor(s/60)} min ago`;if(s<86400)return `${Math.floor(s/3600)} h ago`;return new Date(d).toLocaleDateString();}

function Toggle({checked,onChange,label:text,hint}){return <label className="toggle"><input type="checkbox" checked={!!checked} onChange={e=>onChange(e.target.checked)}/><span className="toggleTrack"><i/></span><span className="toggleText"><b>{text}</b>{hint&&<small>{hint}</small>}</span></label>;}
function Field({label:text,hint,children,wide}){return <label className={`field ${wide?'wide':''}`}><span>{text}</span>{children}{hint&&<small className="fieldHint">{hint}</small>}</label>;}
function StatusPill({status}){return <span className={`pill status-${String(status||'').toLowerCase()}`}>{label(status)}</span>;}
function Card({title,eyebrow,actions,children,className=''}){return <section className={`card ${className}`}>{(title||actions)&&<div className="cardHead"><div>{eyebrow&&<small className="eyebrow">{eyebrow}</small>}{title&&<h3>{title}</h3>}</div>{actions&&<div className="cardActions">{actions}</div>}</div>}{children}</section>;}

function ProfileChips({form}){
  const items=[['Language',form.language],['Format',form.contentFormat],['Length',`${form.durationSec}s`],['Hook',form.hookStyle],['Aspect',form.aspectRatio],['Tone',form.tone],['Visual style',form.visualStyle],['Voice',form.voiceStyle],['Audience',form.targetAge]];
  return <div className="profileChips">{items.map(([k,v])=><div key={k} className="chip"><small>{k}</small><b title={v}>{v||'—'}</b></div>)}</div>;
}

function VideoRow({v,onOpen,onApprove,onCancel,onRetry,onDelete,compact}){
  const j=v.latestJob;const active=isActive(j);const thumb=thumbUrl(v);
  return <article className={`videoRow ${compact?'compact':''}`}>
    <button className="thumb" onClick={()=>onOpen(v._id)} aria-label={`Open ${v.title}`}>{thumb?<img src={thumb} alt="" loading="lazy" onError={e=>{e.currentTarget.style.display='none'}}/>:<span>{(v.title||'?').slice(0,1)}</span>}</button>
    <div className="videoInfo">
      <div className="videoTitleLine"><h4 onClick={()=>onOpen(v._id)}>{v.title||'Untitled video'}</h4><StatusPill status={v.status}/></div>
      <small className="muted">{v.durationSec?`${Math.round(v.durationSec)} s`:'— s'} · {timeAgo(v.updatedAt)}{j?.retryCount?` · attempt #${j.retryCount+1}`:''}{v.qa?.score!=null?` · QA ${v.qa.score}/100`:''}</small>
      {j&&active&&<div className="videoProgress"><div className="miniBar"><i style={{width:`${pct(j)}%`}}/></div><span>{label(j.step||j.status)} · {pct(j)}%</span></div>}
      {!compact&&j&&!active&&['FAILED','CANCELLED'].includes(v.status)&&<JobStepProgress job={j}/>}
      {v.error&&<div className="videoError">{v.error}</div>}
    </div>
    <div className="videoActions">
      <button className="ghost" onClick={()=>onOpen(v._id)}>Details</button>
      {!compact&&videoFileUrl(v)&&<a className="btnLink" href={videoFileUrl(v)} target="_blank" rel="noreferrer">Preview</a>}
      {v.status==='AWAITING_APPROVAL'&&<button onClick={()=>onApprove(v._id)}>Approve</button>}
      {active&&(j?.cancelRequested?<button className="danger" disabled>Stopping…</button>:<button className="danger" onClick={()=>onCancel(v._id)}>Cancel</button>)}
      {['FAILED','CANCELLED'].includes(v.status)&&!active&&<button onClick={()=>onRetry(v._id)}>Continue</button>}
      {!compact&&<button className="danger ghost" onClick={()=>onDelete(v._id)}>Delete</button>}
    </div>
  </article>;
}

function App(){
 const [videos,setVideos]=useState([]),[job,setJob]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [ai,setAi]=useState(null),[aiBusy,setAiBusy]=useState(false),[aiMsg,setAiMsg]=useState(''),[aiSavedAt,setAiSavedAt]=useState(null);
 const [seriesList,setSeriesList]=useState([]),[selectedSeriesId,setSelectedSeriesId]=useState(''),[seriesForm,setSeriesForm]=useState({...DEFAULT_PROFILE_FORM});
 const [genSeriesId,setGenSeriesId]=useState('');
 const [seriesLoaded,setSeriesLoaded]=useState(false),[aiError,setAiError]=useState('');
 const [channelUrl,setChannelUrl]=useState(''),[researchBusy,setResearchBusy]=useState(false),[researchMsg,setResearchMsg]=useState(''),[topicInput,setTopicInput]=useState(''),[pendingResearch,setPendingResearch]=useState(null);
 const [backendStatus,setBackendStatus]=useState('checking');
 const [tab,setTab]=useState('create'),[filter,setFilter]=useState('ALL'),[stats,setStats]=useState(null),[selected,setSelected]=useState(null),[settingsTab,setSettingsTab]=useState('providers'),[detailTab,setDetailTab]=useState('overview');
 const profileDirtyRef=useRef(false);
 const [qaBusy,setQaBusy]=useState(false),[visualChecks,setVisualChecks]=useState({imagesMatch:false,subtitlesReadable:false,ageAppropriate:false});

 async function apiJson(path,options={},attempts=2){
   let lastError;
   for(let attempt=0;attempt<=attempts;attempt++){
     try{
       const r=await fetch(`${API}${path}`,{cache:'no-store',...options});
       const text=await r.text();
       let j={}; try{j=text?JSON.parse(text):{};}catch{j={error:text||`HTTP ${r.status}`};}
       if(!r.ok) throw new Error(j.error||`Request failed (${r.status})`);
       setBackendStatus('online');
       return j;
     }catch(e){
       lastError=e;
       const network=e instanceof TypeError || /fetch|network|ECONNREFUSED/i.test(e.message||'');
       if(!network || attempt===attempts) break;
       setBackendStatus('offline');
       await new Promise(resolve=>setTimeout(resolve,350*(attempt+1)));
     }
   }
   setBackendStatus('offline');
   throw lastError||new Error('Backend unavailable');
 }
 const json=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 // Load errors clear themselves once the automatic retry succeeds.
 const clearLoadError=()=>setError(e=>/^Failed to load/.test(e)?'':e);
 async function checkBackend(){try{await apiJson('/health',{},1);}catch{} }
 async function loadSeries(resetEditor=false){try{
   const j=await apiJson('/series');const list=Array.isArray(j)?j:[];setSeriesList(list);setSeriesLoaded(true);clearLoadError();
   const active=list.find(x=>x.active)||list[0];
   // Create page: keep the chosen profile if it still exists, else the default profile.
   setGenSeriesId(id=>list.some(x=>String(x._id)===String(id))?id:(active?String(active._id):''));
   // Profile editor: only reset on first load (never overwrite unsaved edits).
   if(resetEditor){setSelectedSeriesId(active?String(active._id):'');setSeriesForm(formFromSeries(active));}
 }catch(e){setError(`Failed to load channel profiles: ${e.message}`)}}
 async function seed(){try{await apiJson('/series/seed',{method:'POST'});setError('');await loadSeries();setAiMsg('Starter profile "My YouTube Channel" is ready.');}catch(e){setError(`Backend unavailable: ${e.message}`)}}
 function confirmDiscard(){return !profileDirtyRef.current||window.confirm('You have unsaved profile changes. Discard them?');}
 function editProfile(id){if(String(id)!==String(selectedSeriesId)&&!confirmDiscard())return;setSelectedSeriesId(id);setSeriesForm(formFromSeries(seriesList.find(s=>String(s._id)===String(id))));setPendingResearch(null);setResearchMsg('');setTab('profiles');}
 function newProfile(){if(!confirmDiscard())return;setSelectedSeriesId('');setSeriesForm({...DEFAULT_PROFILE_FORM});setPendingResearch(null);setResearchMsg('');setTab('profiles');}
 async function saveSeries(){
   setResearchMsg('');
   const f=seriesForm;
   if(!f.name.trim()||!f.premise.trim()){setResearchMsg('Channel name and premise are required.');return;}
   const current=seriesList.find(x=>String(x._id)===String(selectedSeriesId));
   const existing=current?.channelProfile||{};
   const kids=KIDS_RE.test(`${f.niche||''} ${f.targetAge||''}`);
   // Merge into the existing saved profile so research-derived fields are kept.
   const channelProfile={...existing,version:1,channelName:f.name||'YouTube Channel',niche:f.niche,language:f.language||'English',
     audience:{...(existing.audience||{}),description:f.targetAge||'General audience',knowledgeLevel:existing.audience?.knowledgeLevel||'general'},
     content:{...(existing.content||{}),primaryFormat:f.contentFormat||'Explainer',tone:f.tone||'Engaging and informative',hookStyle:f.hookStyle||'Curiosity',durationSec:Number(f.durationSec)||55,storytellingApproach:existing.content?.storytellingApproach||'Clear and niche-appropriate'},
     visual:{...(existing.visual||{}),style:f.visualStyle||'Cinematic, high-quality visuals',aspectRatio:f.aspectRatio||'9:16',avoidTextInImages:true,subtitleSafeArea:true},
     narration:{...(existing.narration||{}),voiceStyle:f.voiceStyle||'Natural, clear and engaging',language:f.language||'English'},
     editorial:{...(existing.editorial||{}),safetyMode:kids?'kids-and-family':(existing.editorial?.safetyMode&&existing.editorial.safetyMode!=='kids-and-family'?existing.editorial.safetyMode:'standard'),factChecking:existing.editorial?.factChecking!==false},
     source:existing.source==='channel-research'?'channel-research':'user-configured'};
   const payload={name:f.name.trim(),premise:f.premise.trim(),niche:f.niche,targetAge:f.targetAge,language:f.language,visualStyle:f.visualStyle,channelProfile,
     ...(pendingResearch?{channelResearch:pendingResearch.research,contentStrategy:pendingResearch.research?.strategy,topicIdeas:pendingResearch.research?.strategy?.topicIdeas||[]}:{})};
   try{
     const j=selectedSeriesId?await apiJson(`/series/${selectedSeriesId}`,json('PUT',payload)):await apiJson('/series',json('POST',{...payload,active:seriesList.length===0}));
     setPendingResearch(null);profileDirtyRef.current=false;
     if(j?._id){setSelectedSeriesId(String(j._id));setSeriesForm(formFromSeries(j));}
     await loadSeries();
     setResearchMsg('Profile saved. New videos generated with this profile will use these settings.');
   }catch(e){setResearchMsg(e.message)}
 }
 async function deleteProfile(){
   const current=seriesList.find(x=>String(x._id)===String(selectedSeriesId));if(!current)return;
   if(!window.confirm(`Delete the profile "${current.name}"?\n\nIf videos were already made with it, the profile is archived instead: it disappears from your lists and cannot be used for new videos, but those videos can still be continued and re-rendered.`))return;
   try{const r=await apiJson(`/series/${current._id}`,{method:'DELETE'},0);
     profileDirtyRef.current=false;
     const remaining=seriesList.filter(x=>String(x._id)!==String(current._id));
     const next=r.newDefault?remaining.find(x=>String(x._id)===String(r.newDefault._id))||remaining[0]:remaining[0];
     setSelectedSeriesId(next?String(next._id):'');setSeriesForm(formFromSeries(next));setPendingResearch(null);
     await loadSeries();
     setResearchMsg(`"${current.name}" ${r.mode==='archived'?`was archived (${r.storyCount} existing video${r.storyCount===1?'':'s'} keep working)`:'was deleted'}.${r.newDefault?` "${r.newDefault.name}" is now the default profile.`:''}`);
   }catch(e){setResearchMsg(`Delete failed: ${e.message}`)}
 }
 async function duplicateProfile(){
   const current=seriesList.find(x=>String(x._id)===String(selectedSeriesId));if(!current||!confirmDiscard())return;
   const names=new Set(seriesList.map(x=>x.name));let name=`${current.name} (copy)`;for(let i=2;names.has(name);i++)name=`${current.name} (copy ${i})`;
   try{const j=await apiJson('/series',json('POST',{name,premise:current.premise||name,niche:current.niche,targetAge:current.targetAge,language:current.language,visualStyle:current.visualStyle,channelProfile:current.channelProfile||{},rules:current.rules||[],topicIdeas:current.topicIdeas||[],contentStrategy:current.contentStrategy||null,active:false}),0);
     profileDirtyRef.current=false;await loadSeries();setSelectedSeriesId(String(j._id));setSeriesForm(formFromSeries(j));setPendingResearch(null);setResearchMsg(`Created "${name}". Edit it and save.`);
   }catch(e){setResearchMsg(`Duplicate failed: ${e.message}`)}
 }
 async function activateSeries(id=selectedSeriesId){if(!id)return;try{const j=await apiJson(`/series/${id}/activate`,{method:'POST'});setResearchMsg(`"${j.name}" is now the default profile.`);setGenSeriesId(String(j._id));await loadSeries();}catch(e){setResearchMsg(e.message)}}
 async function studyChannel(){if(!channelUrl.trim()){setResearchMsg('Enter a YouTube channel URL first.');return;}setResearchBusy(true);setResearchMsg('Studying channel: videos, audience signals, topics and content patterns…');try{const j=await apiJson('/series/research-channel',json('POST',{url:channelUrl.trim(),language:seriesForm.language||'English'}));setPendingResearch(j);setSeriesForm(f=>({...f,...Object.fromEntries(Object.entries(j.autofill||{}).filter(([k])=>k in DEFAULT_PROFILE_FORM))}));setResearchMsg('Channel studied. The profile fields were filled in — review them, then Save profile.');}catch(e){setResearchMsg(`Channel research failed: ${e.message}`)}finally{setResearchBusy(false)}}
 async function refresh(nextFilter=filter){try{const url=nextFilter&&nextFilter!=='ALL'?`/videos?status=${encodeURIComponent(nextFilter)}`:'/videos';const j=await apiJson(url);setVideos(Array.isArray(j)?j:[]);clearLoadError();}catch(e){setError(`Failed to load videos: ${e.message}`)}}
 async function refreshStats(){try{const j=await apiJson('/videos/stats',{},1);setStats(j);}catch{} }
 async function loadAI(){try{const j=await apiJson('/ai/settings');setAi(j);setAiError('');}catch(e){setAiError(e.message||'Backend unavailable');}}
 async function chooseAI(provider){setAiBusy(true);setAiMsg('');try{const j=await apiJson('/ai/settings',json('PUT',{provider}),0);setAi(j);setAiMsg(`Script AI changed to ${j.providers[provider].name}.`);}catch(e){setAiMsg(e.message)}finally{setAiBusy(false)}}
 async function chooseMedia(type,provider){setAiBusy(true);setAiMsg('');try{const j=await apiJson('/ai/media-settings',json('PUT',{type,provider}),0);setAi(j);setAiSavedAt(new Date());setAiMsg(`${type==='image'?'Image':'Narration'} provider changed to ${provider}.`);}catch(e){setAiMsg(e.message)}finally{setAiBusy(false)}}
 async function saveAIConfig(patch,what='Settings'){setAiBusy(true);setAiMsg('Saving…');try{const j=await apiJson('/ai/config',json('PUT',patch),0);setAi(j);setAiSavedAt(new Date());setAiMsg(`${what} saved.`);}catch(e){setAiMsg(e.message)}finally{setAiBusy(false)}}
 async function testMedia(type,provider){setAiBusy(true);setAiMsg(`Testing ${provider} ${type}…`);try{const r=await fetch(`${API}/ai/test-media/${type}/${provider}`,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error);setAiMsg(`${provider} ${type} credentials are ready.`);await loadAI();}catch(e){setAiMsg(e.message)}finally{setAiBusy(false)}}
 async function testAI(provider){setAiBusy(true);setAiMsg(`Testing ${ai.providers[provider].name}…`);try{const r=await fetch(`${API}/ai/test/${provider}`,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error);setAiMsg(`${ai.providers[provider].name} connection successful.`);await loadAI();}catch(e){setAiMsg(e.message)}finally{setAiBusy(false)}}
 // Generation uses the SAVED profile only; the request carries profile + optional topic.
 async function generate(){if(!genSeriesId){setError('Create or choose a channel profile first.');return;}setBusy(true);setError('');setNotice('');try{const j=await apiJson('/agent/generate',json('POST',{seriesId:genSeriesId,topic:topicInput.trim()||null}));setJob(j);setNotice(j.profile?`Generating with "${j.profile.name}" · ${j.profile.language} · ${j.profile.format} · ${j.profile.durationSec}s · ${j.profile.hookStyle} hook`:'');poll(j.jobId);}catch(e){setError(`Generation request failed: ${e.message}`);setBusy(false)}}
 async function poll(id,networkFailures=0){try{const j=await apiJson(`/agent/status/${id}`,{},1);setJob(j);if(['COMPLETED','FAILED','CANCELLED'].includes(j.status)){setBusy(false);setQaBusy(false);await refresh();await refreshStats();return;}setTimeout(()=>poll(id,0),1200);}catch(e){if(networkFailures<5){setBackendStatus('offline');setTimeout(()=>poll(id,networkFailures+1),1500);return;}setError(`Job status unavailable: ${e.message}`);setBusy(false);setQaBusy(false)}}
 async function approve(id){try{await apiJson(`/videos/${id}/approve`,{method:'POST'});setError('');await refresh();await refreshStats();if(selected?._id===id)await openVideo(id,detailTab);}catch(e){setError(`Approve failed: ${e.message}`)}}
 async function retryVideo(id){setError('');setBusy(true);try{const j=await apiJson(`/videos/${id}/retry`,{method:'POST'},2);setSelected(null);setJob(j);setTab('create');await refresh();await refreshStats();poll(j.jobId);}catch(e){setBusy(false);setError(`Continue failed: ${e.message}`)}}
 async function cancelVideo(id){try{await apiJson(`/videos/${id}/cancel`,{method:'POST'});setError('');await refresh();await refreshStats();}catch(e){setError(`Cancel failed: ${e.message}`)}}
 async function deleteVideo(id){if(!window.confirm('Permanently delete this generated video, its media files, generation jobs and unused story data? This cannot be undone.'))return;try{await apiJson(`/videos/${id}`,{method:'DELETE'},2);setSelected(null);setError('');await refresh();await refreshStats();}catch(e){setError(`Delete failed: ${e.message}`)}}
 async function openVideo(id,startTab='overview'){try{const j=await apiJson(`/videos/${id}`);setSelected(j);setDetailTab(startTab);setVisualChecks({imagesMatch:!!j.visualReview?.imagesMatch,subtitlesReadable:!!j.visualReview?.subtitlesReadable,ageAppropriate:!!j.visualReview?.ageAppropriate});setError('');}catch(e){setError(`Failed to load video: ${e.message}`)}}
 async function refreshSelected(){if(selected?._id)await openVideo(selected._id,detailTab);await refresh();await refreshStats();}
 async function rerunQA(){if(!selected?._id)return;setQaBusy(true);try{await apiJson(`/videos/${selected._id}/qa`,{method:'POST'});await refreshSelected();}catch(e){setError(`QA failed: ${e.message}`)}finally{setQaBusy(false)}}
 async function regenerateScene(sceneNumber){if(!selected?._id)return;if(!window.confirm(`Regenerate only scene ${sceneNumber}? Other images and narration will be reused, then the video will be re-rendered.`))return;setQaBusy(true);try{const j=await apiJson(`/videos/${selected._id}/scenes/${sceneNumber}/regenerate`,{method:'POST'});setError('');setSelected(null);setBusy(true);setJob(j);setTab('create');poll(j.jobId);}catch(e){setError(`Scene regeneration failed: ${e.message}`);setQaBusy(false)}}
 async function rerenderOnly(){if(!selected?._id)return;setQaBusy(true);try{const j=await apiJson(`/videos/${selected._id}/rerender`,{method:'POST'});setError('');setSelected(null);setBusy(true);setJob(j);setTab('create');poll(j.jobId);}catch(e){setError(`Re-render failed: ${e.message}`);setQaBusy(false)}}
 async function saveVisualReview(){if(!selected?._id)return;try{await apiJson(`/videos/${selected._id}/visual-review`,json('POST',visualChecks));await refreshSelected();}catch(e){setError(`Visual review not saved: ${e.message}`)}}

 useEffect(()=>{checkBackend();refresh();refreshStats();loadAI();loadSeries(true);},[]);
 // Poll videos/stats, and keep retrying settings/profiles until they have loaded
 // (they used to load only once, so a backend restart left Settings stuck on "Loading").
 const aiRef=useRef(null),seriesLoadedRef=useRef(false);aiRef.current=ai;seriesLoadedRef.current=seriesLoaded;
 useEffect(()=>{const timer=setInterval(()=>{checkBackend();refresh();refreshStats();if(!aiRef.current)loadAI();if(!seriesLoadedRef.current)loadSeries(true);},3000);return()=>clearInterval(timer)},[filter]);
 const prevBackend=useRef(backendStatus);
 useEffect(()=>{if(prevBackend.current!=='online'&&backendStatus==='online'&&prevBackend.current!=='checking'){loadAI();loadSeries();refresh();refreshStats();}prevBackend.current=backendStatus;},[backendStatus]);
 useEffect(()=>{if(!selected)return;const onKey=e=>{if(e.key==='Escape')setSelected(null)};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[selected]);

 const providers=ai?.providers||{};
 const counts=stats?.stats||{};
 const imageProvider=ai?.media?.imageProvider||'openai';
 const ttsProvider=ai?.media?.ttsProvider||'groq';
 const imageModel=ai?.media?.imageModels?.[imageProvider]||ai?.media?.imageModel||'';
 const ttsModel=ai?.media?.ttsModels?.[ttsProvider]||ai?.media?.ttsModel||'';
 const ttsVoice=ai?.media?.ttsVoices?.[ttsProvider]||ai?.media?.ttsVoice||'';
 const imageSize=ai?.media?.imageSizes?.[imageProvider]||ai?.media?.imageSize||'';
 const imageSizeOptions={gemini:['1K','2K','4K'],openai:['1024x1024','1024x1536','1536x1024'],cloudflare:['1024x1024','1024x1536','1536x1024','1080x1920'],pollinations:['768x1344','1024x1792','1080x1920','1536x2048'],mock:['1080x1920']}[imageProvider]||['1080x1920'];
 const imageModelPresets={gemini:['gemini-nano-banana-2.1'],openai:['gpt-image-2'],cloudflare:['@cf/black-forest-labs/flux-1-schnell'],pollinations:['black-forest-labs/flux.1-schnell','google/gemini-nano-banana-2.1'],mock:['local']}[imageProvider]||[];
 const ttsModelPresets={groq:['canopylabs/orpheus-v1-english'],openai:['gpt-4o-mini-tts'],gemini:['gemini-3.8-flash-tts','gemini-3.8-flash-lite-tts'],mock:['local']}[ttsProvider]||[];
 const ttsVoicePresets={gemini:['Kore','Zephyr','Puck','Charon','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat']}[ttsProvider]||[];
 // Older versions marked every new profile active. The default is the most recently
 // updated active profile (the server sorts /series that way and uses the same rule).
 const defaultSeries=seriesList.find(x=>x.active);const defaultId=defaultSeries?String(defaultSeries._id):'';
 const extraActive=seriesList.filter(x=>x.active).length>1;
 const genSeries=seriesList.find(x=>String(x._id)===String(genSeriesId));
 const genProfile=formFromSeries(genSeries);
 const editSeries=seriesList.find(x=>String(x._id)===String(selectedSeriesId));
 const profileDirty=!sameForm(seriesForm,editSeries?formFromSeries(editSeries):DEFAULT_PROFILE_FORM)||Boolean(pendingResearch);
 profileDirtyRef.current=profileDirty;
 const setV=(k,v)=>setAi(x=>({...x,video:{...x.video,[k]:v}}));
 const setM=(k,v)=>setAi(x=>({...x,media:{...x.media,[k]:v}}));
 const setVD=(k,v)=>setAi(x=>({...x,visualDirector:{...x.visualDirector,[k]:v}}));
 const setF=(k,v)=>setSeriesForm(f=>({...f,[k]:v}));
 const hindiTtsWarning=genProfile.language==='Hindi'&&ttsProvider==='groq';
 const rowHandlers={onOpen:id=>openVideo(id),onApprove:approve,onCancel:cancelVideo,onRetry:retryVideo,onDelete:deleteVideo};
 const statCard=(title,key,tone='')=><button className={`stat ${tone}`} onClick={()=>{if(key!=='RUNNING'){setFilter(key);refresh(key);}setTab('videos')}}><small>{title}</small><strong>{key==='ALL'?(counts.total||0):key==='RUNNING'?(stats?.activeJobs||0):(counts[key]||0)}</strong></button>;
 const page=NAV.find(n=>n[0]===tab)||NAV[0];
 const awaiting=counts.AWAITING_APPROVAL||0;

 return <div className="app">
  <aside className="sidebar">
   <div className="brand"><div className="logo">▶</div><div><b>YouTube AI Agent</b><small>Channel Studio</small></div></div>
   <nav>{NAV.map(([id,name])=><button key={id} className={`navItem ${tab===id?'active':''}`} onClick={()=>setTab(id)}><Icon name={id}/><span>{name}</span>{id==='videos'&&awaiting>0&&<em className="navBadge">{awaiting}</em>}</button>)}</nav>
   <div className="sideFooter">
     <div className={`backendPill ${backendStatus}`}><i/>{backendStatus==='online'?'Backend online':backendStatus==='checking'?'Connecting…':'Backend offline'}</div>
     <small className="muted">Default profile</small>
     <b className="sideProfile">{defaultSeries?.name||'None yet'}</b>
   </div>
  </aside>
  <main>
   <header className="topbar"><div><h1>{page[1]}</h1><p className="muted">{page[2]}</p></div>
     <div className="topActions">{tab!=='create'&&<button onClick={()=>setTab('create')} disabled={busy}>{busy?'Generating…':'+ New video'}</button>}</div>
   </header>
   {backendStatus==='offline'&&<div className="banner warn"><div><strong>Backend API is offline</strong><small>Expected at 127.0.0.1:4000 · retrying automatically.</small></div><button className="ghost" onClick={()=>{checkBackend();refresh();refreshStats()}}>Retry now</button></div>}
   {error&&<div className="banner error"><span>{error}</span><button className="ghost" onClick={()=>setError('')}>Dismiss</button></div>}

   {tab==='create'&&<div className="createGrid">
     <div className="createMain">
      <Card eyebrow="STEP 1" title="Channel profile" actions={<><button className="ghost" onClick={()=>genSeriesId?editProfile(genSeriesId):newProfile()}>{genSeriesId?'Edit profile':'Create profile'}</button></>}>
        {!seriesLoaded?<p className="muted">Loading profiles…</p>:seriesList.length===0?<div className="empty"><p>No channel profile yet. A profile defines language, format, length, hook, tone, visuals and voice for every video.</p><div className="row"><button onClick={newProfile}>Create a profile</button><button className="ghost" onClick={seed}>Use starter profile</button></div></div>:<>
          <div className="profilePicker">{seriesList.map(s=><button key={s._id} className={`profileOption ${String(s._id)===String(genSeriesId)?'selected':''}`} onClick={()=>setGenSeriesId(String(s._id))}><b>{s.name}</b><small>{s.niche||'—'} · {formFromSeries(s).language}</small>{String(s._id)===defaultId&&<em>Default</em>}</button>)}</div>
          <ProfileChips form={genProfile}/>
          <p className="muted small">This video uses the <b>saved</b> profile exactly. To change language, format, length or hook, edit the profile.</p>
          {hindiTtsWarning&&<div className="banner warn inline">This profile is Hindi but the narration provider is Groq Orpheus (English only). Choose Gemini or OpenAI TTS in Settings → Providers.</div>}
        </>}
      </Card>
      <Card eyebrow="STEP 2" title="Topic (optional)">
        <textarea className="topicBox" rows="3" value={topicInput} onChange={e=>setTopicInput(e.target.value)} placeholder="Describe what this video should be about… Leave empty to use the profile's researched topic rotation."/>
        {(genSeries?.topicIdeas||[]).length>0&&<div className="topicIdeas"><small className="muted">Ideas from channel research</small><div>{genSeries.topicIdeas.slice(0,8).map((x,i)=><button key={i} className="ghost chipBtn" onClick={()=>setTopicInput(x)}>{x}</button>)}</div></div>}
        <div className="generateBar"><button className="primaryLg" onClick={generate} disabled={busy||!genSeriesId||backendStatus==='offline'}>{busy?'Generating…':'Generate video'}</button><span className="muted small">{genSeries?`${genSeries.name} · ${genProfile.durationSec}s ${genProfile.contentFormat} in ${genProfile.language}`:'Choose a profile first'}</span></div>
        {notice&&<div className="banner ok inline">{notice}</div>}
      </Card>
      {job&&<Card eyebrow="LIVE" title={label(job.step||job.status)} actions={<b className="bigPct">{pct(job)}%</b>} className="jobCard">
        <div className="bar"><i style={{width:`${pct(job)}%`}}/></div>
        <JobStepProgress job={job}/>
        <div className="log">{(job.logs||[]).slice(-10).map((x,i)=><div key={i} className={`logLine ${x.level||''}`}><em>{x.at?new Date(x.at).toLocaleTimeString():''}</em><span>{x.message}</span></div>)}</div>
        {job.videoId&&<button className="ghost" onClick={()=>openVideo(job.videoId?._id||job.videoId)}>Open video details</button>}
      </Card>}
     </div>
     <div className="createSide">
      <div className="statGrid">{statCard('Awaiting approval','AWAITING_APPROVAL','accent')}{statCard('Active jobs','RUNNING')}{statCard('Failed','FAILED','bad')}{statCard('Published','PUBLISHED','good')}</div>
      <Card title="Pipeline" eyebrow="PROVIDERS" actions={<button className="ghost small" onClick={()=>{setTab('settings');setSettingsTab('providers')}}>Configure</button>}>
        <div className="kv"><span>Script</span><b>{providers[ai?.activeProvider]?.name||'—'}</b></div>
        <div className="kv"><span>Images</span><b>{ai?.media?.imageProviders?.[imageProvider]?.name||imageProvider}</b></div>
        <div className="kv"><span>Narration</span><b>{ai?.media?.ttsProviders?.[ttsProvider]?.name||ttsProvider}</b></div>
        <div className="kv"><span>Output</span><b>{ai?.video?.width||1080}×{ai?.video?.height||1920} · {ai?.video?.fps||30} fps</b></div>
      </Card>
      <Card title="Recent videos" actions={<button className="ghost small" onClick={()=>{setFilter('ALL');setTab('videos')}}>All videos</button>}>
        <div className="videos">{videos.length===0?<p className="muted">No videos yet.</p>:videos.slice(0,5).map(v=><VideoRow key={v._id} v={v} compact {...rowHandlers}/>)}</div>
      </Card>
     </div>
   </div>}

   {tab==='videos'&&<div className="stack">
     <div className="statGrid wide">{statCard('Total','ALL')}{statCard('Active jobs','RUNNING')}{statCard('Awaiting approval','AWAITING_APPROVAL','accent')}{statCard('Published','PUBLISHED','good')}{statCard('Failed','FAILED','bad')}{statCard('Cancelled','CANCELLED')}</div>
     <Card actions={<button className="ghost" onClick={()=>{refresh();refreshStats()}}>Refresh</button>} title="All videos">
       <div className="filterBar">{VIDEO_STATUSES.map(s=><button key={s} className={filter===s?'filterActive':'ghost'} onClick={()=>{setFilter(s);refresh(s)}}>{s==='ALL'?'All':label(s).toLowerCase()}</button>)}</div>
       <div className="videos">{videos.length===0?<p className="muted">No videos match this status.</p>:videos.map(v=><VideoRow key={v._id} v={v} {...rowHandlers}/>)}</div>
     </Card>
   </div>}

   {tab==='profiles'&&<div className="profilesGrid">
     <div className="profileList">
       <button className="newProfile" onClick={newProfile}>+ New profile</button>
       {seriesList.map(s=><button key={s._id} className={`profileItem ${String(s._id)===String(selectedSeriesId)?'selected':''}`} onClick={()=>editProfile(String(s._id))}><b>{s.name}</b><small>{s.niche||'—'} · {formFromSeries(s).language} · {formFromSeries(s).durationSec}s</small>{String(s._id)===defaultId&&<em>Default</em>}</button>)}
       {extraActive&&<p className="muted small">Several profiles were marked default by an older version. The most recently updated one is used. Click “Set as default” on the one you want to fix this.</p>}
       {seriesList.length===0&&<p className="muted small">{seriesLoaded?'No profiles yet.':'Loading profiles…'}</p>}
     </div>
     <div className="stack">
       <Card eyebrow={selectedSeriesId?'EDIT PROFILE':'NEW PROFILE'} title={seriesForm.name||'Untitled profile'} actions={<>{profileDirty&&<span className="dirty">Unsaved changes</span>}{selectedSeriesId&&(String(selectedSeriesId)!==defaultId||extraActive)&&<button className="ghost" onClick={()=>activateSeries()}>Set as default</button>}{selectedSeriesId&&<button className="ghost" onClick={duplicateProfile}>Duplicate</button>}{selectedSeriesId&&<button className="danger ghost" onClick={deleteProfile}>Delete</button>}<button onClick={saveSeries} disabled={!profileDirty&&Boolean(selectedSeriesId)}>Save profile</button></>}>
         <div className="formSection"><h4>Identity</h4><div className="formGrid">
           <Field label="Channel name"><input value={seriesForm.name} onChange={e=>setF('name',e.target.value)} placeholder="e.g. Motivation Shorts Hindi"/></Field>
           <Field label="Niche"><input value={seriesForm.niche} onChange={e=>setF('niche',e.target.value)} placeholder="e.g. Motivation, technology, finance…"/></Field>
           <Field label="Premise" wide><textarea rows="2" value={seriesForm.premise} onChange={e=>setF('premise',e.target.value)} placeholder="What is this channel about, and what should every video deliver?"/></Field>
           <Field label="Target audience"><input value={seriesForm.targetAge} onChange={e=>setF('targetAge',e.target.value)} placeholder="e.g. Young adults 18–30"/></Field>
         </div></div>
         <div className="formSection"><h4>Every video</h4><p className="muted small">These are used for every generated video — no per-video overrides.</p><div className="formGrid four">
           <Field label="Language" hint={seriesForm.language==='Hindi'?(ttsProvider==='groq'?'⚠ Your narration provider (Groq Orpheus) is English-only — switch to Gemini or OpenAI TTS in Settings.':'Narration: '+ttsProvider+' (supports Hindi).'):''}><select value={seriesForm.language} onChange={e=>setF('language',e.target.value)}><option value="English">English</option><option value="Hindi">Hindi (हिन्दी)</option></select></Field>
           <Field label="Format"><select value={seriesForm.contentFormat} onChange={e=>setF('contentFormat',e.target.value)}>{[...new Set([seriesForm.contentFormat,...FORMAT_OPTIONS])].filter(Boolean).map(x=><option key={x}>{x}</option>)}</select></Field>
           <Field label="Length"><select value={seriesForm.durationSec} onChange={e=>setF('durationSec',Number(e.target.value))}>{[...new Set([Number(seriesForm.durationSec),...DURATION_OPTIONS])].sort((a,b)=>a-b).map(x=><option key={x} value={x}>{x} seconds</option>)}</select></Field>
           <Field label="Hook style"><select value={seriesForm.hookStyle} onChange={e=>setF('hookStyle',e.target.value)}>{HOOK_OPTIONS.map(x=><option key={x}>{x}</option>)}</select></Field>
         </div></div>
         <div className="formSection"><h4>Look & voice</h4><div className="formGrid">
           <Field label="Tone"><input value={seriesForm.tone} onChange={e=>setF('tone',e.target.value)} placeholder="e.g. inspiring, analytical, humorous"/></Field>
           <Field label="Narration style"><input value={seriesForm.voiceStyle} onChange={e=>setF('voiceStyle',e.target.value)} placeholder="e.g. warm, energetic host"/></Field>
           <Field label="Visual style"><input value={seriesForm.visualStyle} onChange={e=>setF('visualStyle',e.target.value)} placeholder="e.g. cinematic realism"/></Field>
           <Field label="Aspect ratio"><select value={seriesForm.aspectRatio} onChange={e=>setF('aspectRatio',e.target.value)}><option value="9:16">9:16 · Shorts / vertical</option><option value="16:9">16:9 · Standard YouTube</option><option value="1:1">1:1 · Square</option><option value="3:4">3:4 · Portrait feed</option></select></Field>
         </div></div>
         {researchMsg&&<div className="banner info inline">{researchMsg}</div>}
       </Card>
       <Card eyebrow="CHANNEL RESEARCH" title="Learn from a YouTube channel">
         <p className="muted small">Paste a channel link. The agent studies its public signals and fills in this profile with an original strategy — it never copies videos, scripts or titles.</p>
         <div className="inlineForm"><input value={channelUrl} onChange={e=>setChannelUrl(e.target.value)} placeholder="https://www.youtube.com/@examplechannel"/><button onClick={studyChannel} disabled={researchBusy}>{researchBusy?'Studying…':'Study & fill profile'}</button></div>
         {(()=>{const r=pendingResearch?.research||editSeries?.channelResearch;const st=pendingResearch?.research?.strategy||editSeries?.contentStrategy;if(!r)return null;return <div className="researchResult">
           <div className="kvGrid"><div className="kv"><span>Channel</span><b>{r.raw?.channelTitle||'—'}</b></div><div className="kv"><span>Detected niche</span><b>{st?.niche||editSeries?.niche||'—'}</b></div><div className="kv"><span>Audience</span><b>{st?.audience||'—'}</b></div></div>
           {(st?.contentPillars||[]).length>0&&<div><small className="eyebrow">CONTENT PILLARS</small><div className="tagList">{st.contentPillars.map((x,i)=><span key={i}>{x}</span>)}</div></div>}
           {(editSeries?.topicIdeas||[]).length>0&&<div><small className="eyebrow">TOPIC IDEAS — click to use on Create</small><div className="topicIdeas"><div>{editSeries.topicIdeas.slice(0,12).map((x,i)=><button key={i} className="ghost chipBtn" onClick={()=>{setTopicInput(x);setGenSeriesId(String(editSeries._id));setTab('create')}}>{x}</button>)}</div></div></div>}
           <details><summary>Recent channel videos studied</summary><div className="researchVideos">{(r.raw?.videos||[]).slice(0,12).map((v,i)=><div key={i}><b>{v.title}</b>{v.views!=null&&<small>{Number(v.views).toLocaleString()} views</small>}</div>)}</div></details>
         </div>})()}
       </Card>
     </div>
   </div>}

   {tab==='analytics'&&<div className="stack">
     <div className="statGrid wide">{statCard('Total videos','ALL')}{statCard('Active jobs','RUNNING')}{statCard('Awaiting approval','AWAITING_APPROVAL','accent')}{statCard('Published','PUBLISHED','good')}{statCard('Failed','FAILED','bad')}{statCard('Cancelled','CANCELLED')}</div>
     <div className="twoCol">
       <Card title="Videos by stage" eyebrow="PIPELINE">{(()=>{const rows=VIDEO_STATUSES.filter(s=>s!=='ALL').map(s=>[s,counts[s]||0]);const max=Math.max(1,...rows.map(r=>r[1]));return <div className="barList">{rows.map(([s,n])=><button key={s} className="barRow" onClick={()=>{setFilter(s);refresh(s);setTab('videos')}}><span>{label(s).toLowerCase()}</span><div><i style={{width:`${n/max*100}%`}}/></div><b>{n}</b></button>)}</div>;})()}</Card>
       <Card title="Configuration" eyebrow="CURRENT PIPELINE">
         <div className="kv"><span>Script AI</span><b>{providers[ai?.activeProvider]?.name||'—'}</b></div>
         <div className="kv"><span>Images</span><b>{imageProvider} · {imageModel||'—'}</b></div>
         <div className="kv"><span>Narration</span><b>{ttsProvider} · {ttsVoice||'—'}</b></div>
         <div className="kv"><span>Video output</span><b>{ai?.video?.width||1080}×{ai?.video?.height||1920} · {ai?.video?.fps||30} fps · {ai?.video?.imageFit||'contain-blur'}</b></div>
         <div className="kv"><span>Profiles</span><b>{seriesList.length}</b></div>
         <div className="kv"><span>Auto-delete</span><b>{ai?.retention?.autoDeleteEnabled===false?'Off':`after ${ai?.retention?.days??30} days`}</b></div>
       </Card>
     </div>
   </div>}

   {tab==='settings'&&<div className="settingsLayout">
     <nav className="subNav">{[['providers','Providers'],['output','Video output'],['quality','Image quality & OCR'],['storage','Storage'],['advanced','Advanced']].map(([id,name])=><button key={id} className={settingsTab===id?'active':''} onClick={()=>setSettingsTab(id)}>{name}</button>)}</nav>
     <div className="stack">
      {aiMsg&&<div className="banner info">{aiMsg}{aiSavedAt&&<small className="muted"> · {aiSavedAt.toLocaleTimeString()}</small>}</div>}
      {!ai&&(aiError?<div className="banner error"><span>Couldn't load settings: {aiError}. Retrying automatically…</span><button className="ghost" onClick={loadAI}>Retry now</button></div>:<p className="muted">Loading settings…</p>)}
      {ai&&settingsTab==='providers'&&<>
        <Card eyebrow="STEP 1 · SCRIPT" title="Script AI" actions={<span className="muted small">Active: <b>{providers[ai.activeProvider]?.name||'—'}</b></span>}>
          <div className="providerGrid">{Object.entries(providers).map(([id,p])=><div key={id} className={`providerCard ${ai.activeProvider===id?'selected':''} ${!p.configured?'disabled':''}`}><div className="providerTop"><div><strong>{p.name}</strong><small>{p.model}</small></div><span className={`statusDot ${p.configured?'online':''}`}/></div><small className="muted">{p.configured?(p.freeTier?'Free tier available':'Configured'):'API key not set'}</small><div className="row"><button disabled={!p.configured||aiBusy||ai.activeProvider===id} onClick={()=>chooseAI(id)}>{ai.activeProvider===id?'✓ Active':'Use'}</button><button className="ghost" disabled={!p.configured||aiBusy} onClick={()=>testAI(id)}>Test</button></div></div>)}</div>
          <p className="muted small">Model names, temperature and token limits are under Advanced.</p>
        </Card>
        <Card eyebrow="STEP 2 · IMAGES" title="Scene images" actions={<button onClick={()=>saveAIConfig({media:ai.media},'Image settings')} disabled={aiBusy}>Save</button>}>
          <div className="providerGrid">{[['gemini','Gemini Image'],['openai','OpenAI'],['cloudflare','Cloudflare Workers AI'],['pollinations','Pollinations'],['mock','Mock / Development']].map(([id,name])=><div className={`providerCard ${imageProvider===id?'selected':''}`} key={id}><div className="providerTop"><div><strong>{name}</strong><small>{ai.media?.imageProviders?.[id]?.model||'—'}</small></div><span className={`statusDot ${ai.media?.imageProviders?.[id]?.configured?'online':''}`}/></div><small className="muted">{ai.media?.imageProviders?.[id]?.configured?'Configured':'Not configured'}</small><div className="row"><button disabled={aiBusy||imageProvider===id} onClick={()=>chooseMedia('image',id)}>{imageProvider===id?'✓ Active':'Use'}</button><button className="ghost" disabled={aiBusy} onClick={()=>testMedia('image',id)}>Test</button></div></div>)}</div>
          <div className="formGrid">
            <Field label={`Image model · ${imageProvider}`}><input list="image-model-presets" value={imageModel} onChange={e=>setAi(x=>({...x,media:{...x.media,imageModels:{...(x.media.imageModels||{}),[imageProvider]:e.target.value}}}))} placeholder="Enter or select model" disabled={imageProvider==='mock'}/><datalist id="image-model-presets">{imageModelPresets.map(m=><option key={m} value={m}/>)}</datalist></Field>
            <Field label={`Image size · ${imageProvider}`}><select value={imageSize} onChange={e=>setAi(x=>({...x,media:{...x.media,imageSizes:{...(x.media.imageSizes||{}),[imageProvider]:e.target.value},imageSize:e.target.value}}))}>{imageSizeOptions.map(x=><option key={x} value={x}>{x}</option>)}</select></Field>
          </div>
          {imageProvider==='cloudflare'&&<p className="muted small">Cloudflare FLUX gets short, purely descriptive prompts (it cannot follow "no text" instructions); OCR then checks every image.</p>}
        </Card>
        <Card eyebrow="STEP 3 · NARRATION" title="Voice" actions={<button onClick={()=>saveAIConfig({media:ai.media},'Narration settings')} disabled={aiBusy}>Save</button>}>
          <div className="providerGrid">{[['groq','Groq Orpheus'],['openai','OpenAI TTS'],['gemini','Gemini TTS'],['mock','Mock / Development']].map(([id,name])=><div className={`providerCard ${ttsProvider===id?'selected':''}`} key={id}><div className="providerTop"><div><strong>{name}</strong><small>{ai.media?.ttsProviders?.[id]?.model||'local'}</small></div><span className={`statusDot ${ai.media?.ttsProviders?.[id]?.configured?'online':''}`}/></div><small className="muted">{id==='groq'?'English only':id==='mock'?'No audio':'English + Hindi'}</small><div className="row"><button disabled={aiBusy||ttsProvider===id} onClick={()=>chooseMedia('tts',id)}>{ttsProvider===id?'✓ Active':'Use'}</button><button className="ghost" disabled={aiBusy} onClick={()=>testMedia('tts',id)}>Test</button></div></div>)}</div>
          <div className="formGrid">
            <Field label={`Voice model · ${ttsProvider}`}><input list="tts-model-presets" value={ttsModel} onChange={e=>setAi(x=>({...x,media:{...x.media,ttsModels:{...(x.media.ttsModels||{}),[ttsProvider]:e.target.value}}}))} placeholder="Enter or select model" disabled={ttsProvider==='mock'}/><datalist id="tts-model-presets">{ttsModelPresets.map(m=><option key={m} value={m}/>)}</datalist></Field>
            <Field label={`Voice · ${ttsProvider}`}><input list={ttsVoicePresets.length?'tts-voice-presets':undefined} value={ttsVoice} onChange={e=>setAi(x=>({...x,media:{...x.media,ttsVoices:{...(x.media.ttsVoices||{}),[ttsProvider]:e.target.value}}}))} placeholder="Enter voice" disabled={ttsProvider==='mock'}/>{ttsVoicePresets.length>0&&<datalist id="tts-voice-presets">{ttsVoicePresets.map(v=><option key={v} value={v}/>)}</datalist>}</Field>
          </div>
          <p className="muted small">The selected provider is always used — there is no silent fallback. Gemini TTS applies an Indian Hindi storytelling style for Hindi profiles.</p>
        </Card>
      </>}
      {ai&&settingsTab==='output'&&<Card eyebrow="RENDERING" title="Video output" actions={<button onClick={()=>saveAIConfig({video:ai.video},'Video output')} disabled={aiBusy}>Save</button>}>
        <div className="formSection"><h4>Frame</h4><div className="formGrid four">
          <Field label="Resolution"><select value={`${ai.video?.width||1080}x${ai.video?.height||1920}`} onChange={e=>{const [w,h]=e.target.value.split('x').map(Number);setAi(x=>({...x,video:{...x.video,width:w,height:h}}))}}>{[...new Set([`${ai.video?.width||1080}x${ai.video?.height||1920}`,'1080x1920','720x1280','1920x1080','1080x1080'])].map(r=><option key={r} value={r}>{r.replace('x',' × ')}</option>)}</select></Field>
          <Field label="Frame rate"><select value={ai.video?.fps||30} onChange={e=>setV('fps',Number(e.target.value))}><option value="24">24 fps</option><option value="30">30 fps</option><option value="60">60 fps</option></select></Field>
          <Field label="Image fit" wide hint="Cover fills the frame (crops edges). Contain + blur keeps the whole image with blurred bands — common with FLUX images that are not 9:16."><select value={ai.video?.imageFit||'contain-blur'} onChange={e=>setV('imageFit',e.target.value)}><option value="cover">Cover — fill the frame (recommended)</option><option value="contain-blur">Contain + blurred background</option><option value="contain">Contain — black bars</option></select></Field>
        </div></div>
        <div className="formSection"><h4>Subtitles</h4>
          <Toggle checked={ai.video?.subtitlesEnabled??true} onChange={v=>setV('subtitlesEnabled',v)} label="Burn subtitles into the video" hint="An SRT file is always generated as well."/>
          <div className="formGrid four">
            <Field label="Font" hint="Nirmala UI or Mangal support Hindi."><input list="font-presets" value={ai.video?.subtitleFontName||'Nirmala UI'} onChange={e=>setV('subtitleFontName',e.target.value)}/><datalist id="font-presets">{['Nirmala UI','Mangal','Arial','Segoe UI','Noto Sans Devanagari'].map(f=><option key={f} value={f}/>)}</datalist></Field>
            <Field label={`Size · ${Number(ai.video?.subtitleFontSize??38)} px`}><input type="range" min="28" max="48" value={Number(ai.video?.subtitleFontSize??38)} onChange={e=>setV('subtitleFontSize',Number(e.target.value))}/></Field>
            <Field label="Position"><select value={ai.video?.subtitlePosition||'bottom'} onChange={e=>setV('subtitlePosition',e.target.value)}><option value="bottom">Bottom</option><option value="center">Middle</option><option value="top">Top</option></select></Field>
            <Field label={`Distance from edge · ${Number(ai.video?.subtitleOffsetPct??7)}%`} hint="YouTube Shorts buttons cover roughly the bottom 12–15%."><input type="range" min="2" max="40" value={Number(ai.video?.subtitleOffsetPct??7)} onChange={e=>setV('subtitleOffsetPct',Number(e.target.value))} disabled={(ai.video?.subtitlePosition||'bottom')==='center'}/></Field>
          </div>
          <div className="subPreview"><div className={`phone pos-${ai.video?.subtitlePosition||'bottom'}`} style={{'--off':`${Number(ai.video?.subtitleOffsetPct??7)}%`,'--fs':`${Number(ai.video?.subtitleFontSize??38)/1920*320}px`}}><span style={{fontFamily:`'${ai.video?.subtitleFontName||'Nirmala UI'}', sans-serif`}}>{ai.video?.subtitlesEnabled===false?'(subtitles off)':'क्या आप तैयार हैं? Let’s begin.'}</span></div><small className="muted">Preview (approximate)</small></div>
        </div>
      </Card>}
      {ai&&settingsTab==='quality'&&<Card eyebrow="QUALITY" title="Image quality & OCR" actions={<button onClick={()=>saveAIConfig({visualDirector:ai.visualDirector,media:ai.media,quality:ai.quality},'Quality settings')} disabled={aiBusy}>Save</button>}>
        <div className="formSection"><h4>Visual Director</h4><div className="toggleGrid">
          <Toggle checked={ai.visualDirector?.enabled??true} onChange={v=>setVD('enabled',v)} label="Visual Director" hint="Plans a concrete shot for every scene."/>
          <Toggle checked={ai.visualDirector?.realism??true} onChange={v=>setVD('realism',v)} label="Realistic images"/>
          <Toggle checked={ai.visualDirector?.continuity??true} onChange={v=>setVD('continuity',v)} label="Character continuity"/>
          <Toggle checked={ai.visualDirector?.eyeCatching??true} onChange={v=>setVD('eyeCatching',v)} label="Eye-catching composition"/>
          <Toggle checked={ai.visualDirector?.avoidTextInImages??true} onChange={v=>setVD('avoidTextInImages',v)} label="Avoid text in images"/>
        </div></div>
        <div className="formSection"><h4>Images</h4><div className="formGrid four">
          <Field label="Image quality"><select value={ai.media?.imageQuality||'high'} onChange={e=>setM('imageQuality',e.target.value)}><option value="high">High</option><option value="standard">Standard</option></select></Field>
          <Field label="Image aspect ratio"><select value={ai.media?.imageAspectRatio||'9:16'} onChange={e=>setM('imageAspectRatio',e.target.value)}><option>9:16</option><option>1:1</option><option>16:9</option><option>4:3</option></select></Field>
          <Field label="Text check retries" hint="Regenerations allowed when OCR reads text in an image."><select value={ai.quality?.ocrMaxRetries??2} onChange={e=>setAi(x=>({...x,quality:{...(x.quality||{}),ocrMaxRetries:Number(e.target.value)}}))}>{[0,1,2,3].map(n=><option key={n} value={n}>{n===0?'No retries (fail fast)':`${n} ${n===1?'retry':'retries'}`}</option>)}</select></Field>
          <Field label="Pollinations safety check"><select value={String(ai.media?.pollinationsSafe??false)} onChange={e=>setM('pollinationsSafe',e.target.value==='true')}><option value="false">Off</option><option value="true">On</option></select></Field>
        </div></div>
        <p className="muted small">OCR (English + Hindi) rejects an image only when it reads a real word with high confidence. Faint marks are accepted and flagged for your visual review.</p>
      </Card>}
      {ai&&settingsTab==='storage'&&<Card eyebrow="STORAGE" title="Generated video retention" actions={<button onClick={()=>saveAIConfig({retention:ai.retention},'Retention settings')} disabled={aiBusy}>Save</button>}>
        <Toggle checked={ai.retention?.autoDeleteEnabled??true} onChange={v=>setAi(x=>({...x,retention:{...(x.retention||{}),autoDeleteEnabled:v}}))} label="Automatically delete old generated media" hint="Published, scheduled and uploading videos are never deleted automatically."/>
        <div className="formGrid"><Field label="Delete after (days)"><input type="number" min="1" max="3650" value={ai.retention?.days??30} onChange={e=>setAi(x=>({...x,retention:{...(x.retention||{}),days:Number(e.target.value)}}))} disabled={ai.retention?.autoDeleteEnabled===false}/></Field></div>
      </Card>}
      {ai&&settingsTab==='advanced'&&<>
        <Card eyebrow="ADVANCED" title="Script model tuning" actions={<button onClick={()=>saveAIConfig({text:ai.text},'Script model settings')} disabled={aiBusy}>Save</button>}>
          <div className="formGrid">{['gemini','groq','cerebras','openai'].map(p=><Field key={p} label={`${p[0].toUpperCase()+p.slice(1)} model`}><input value={ai.text?.models?.[p]||''} onChange={e=>setAi(x=>({...x,text:{...x.text,models:{...x.text.models,[p]:e.target.value}}}))}/></Field>)}
            <Field label="Temperature"><input type="number" min="0" max="2" step="0.1" value={ai.text?.temperature??0.7} onChange={e=>setAi(x=>({...x,text:{...x.text,temperature:Number(e.target.value)}}))}/></Field>
            <Field label="Max output tokens"><input type="number" min="100" max="20000" value={ai.text?.maxOutputTokens??2600} onChange={e=>setAi(x=>({...x,text:{...x.text,maxOutputTokens:Number(e.target.value)}}))}/></Field>
          </div>
        </Card>
        <Card eyebrow="ADVANCED" title="Media generation mode" actions={<button onClick={()=>saveAIConfig({media:ai.media},'Media mode')} disabled={aiBusy}>Save</button>}>
          <div className="toggleGrid">
            <Toggle checked={ai.media?.generationEnabled??true} onChange={v=>setM('generationEnabled',v)} label="Real media generation" hint="Turn off to stop calling image/voice providers."/>
            <Toggle checked={ai.media?.mockMode??false} onChange={v=>setM('mockMode',v)} label="Mock mode" hint="Development only: placeholder images and silent audio."/>
          </div>
        </Card>
        <Card eyebrow="LEGACY" title="Starter profile">
          <p className="muted small">Creates a general "My YouTube Channel" profile if it does not exist (formerly "Initialize Universe"). Existing profiles are not changed.</p>
          <button className="ghost" onClick={seed}>Create starter profile</button>
        </Card>
      </>}
     </div>
   </div>}
  </main>

  {selected&&<div className="detailOverlay" onClick={()=>setSelected(null)}><div className="detailPanel" role="dialog" aria-label="Video details" onClick={e=>e.stopPropagation()}>
    <div className="detailHead"><div><small className="eyebrow">VIDEO DETAILS</small><h2>{selected.title}</h2><div className="detailMeta"><StatusPill status={selected.status}/><span>Created {new Date(selected.createdAt).toLocaleString()}</span><span>Updated {new Date(selected.updatedAt).toLocaleString()}</span>{selected.qa?.score!=null&&<span>QA <b>{selected.qa.score}/100</b></span>}</div></div>
      <div className="row">{selected.status==='AWAITING_APPROVAL'&&<button onClick={()=>approve(selected._id)} disabled={!selected.visualReview?.reviewedAt} title={selected.visualReview?.reviewedAt?'':'Complete the visual review first (QA & review tab)'}>Approve</button>}{['FAILED','CANCELLED'].includes(selected.status)&&<button onClick={()=>retryVideo(selected._id)}>Continue</button>}<button className="danger ghost" onClick={()=>deleteVideo(selected._id)}>Delete</button><button className="ghost" onClick={()=>setSelected(null)} aria-label="Close">✕</button></div>
    </div>
    {selected.error&&<div className="videoError">{selected.error}</div>}
    <div className="detailTabs">{[['overview','Overview'],['qa','QA & review'],['scenes','Scenes'],['export','Logs & export'],['pipeline','Pipeline inspector']].map(([id,name])=><button key={id} className={detailTab===id?'active':''} onClick={()=>setDetailTab(id)}>{name}</button>)}</div>
    {detailTab==='overview'&&<div className="overviewGrid">
      <div className="playerWrap">{videoFileUrl(selected)?<video src={videoFileUrl(selected)} controls preload="metadata"/>:<div className="noVideo">No rendered video yet</div>}{videoFileUrl(selected)&&<a className="btnLink" href={videoFileUrl(selected)} target="_blank" rel="noreferrer">Open in new tab</a>}</div>
      <div className="stack">
        {(()=>{const history=(selected.statusHistory||[]).slice().sort((a,b)=>new Date(a.at||0)-new Date(b.at||0));const groups=history.reduce((m,x)=>{const k=Number(x.attempt||0);(m[k] ||= []).push(x);return m},{});return <><h4>Lifecycle history</h4><div className="historyGroups">{Object.entries(groups).sort(([a],[b])=>Number(b)-Number(a)).map(([attempt,items])=><div className="historyGroup" key={attempt}><div className="historyGroupTitle">Attempt #{Number(attempt)+1}</div><div className="history">{items.slice().reverse().map((x,i)=><div key={i}><b>{label(x.status)}</b><span>{x.message||''}</span><small>{x.at?new Date(x.at).toLocaleString():''}</small></div>)}</div></div>)}</div><h4>Generation attempts</h4><div className="history">{(selected.jobs||[]).map((j,i)=><div key={i}><b>Attempt #{(j.retryCount||0)+1} · {j.status} · {j.progress||0}%</b><span>{label(j.step)}{j.error?` · ${j.error}`:''}</span><small>{j.startedAt?new Date(j.startedAt).toLocaleString():new Date(j.createdAt).toLocaleString()}</small></div>)}</div></>})()}
      </div>
    </div>}
    {detailTab==='qa'&&<section className="qaPanel"><div className="sectionHead"><div><small className="eyebrow">RETENTION & QUALITY ENGINE</small><h4>Video QA Report</h4></div><button className="ghost" disabled={qaBusy||!selected.renderPath} onClick={rerunQA}>{qaBusy?'Checking…':'Run QA again'}</button></div>{Boolean(selected.qa && Array.isArray(selected.qa.checks))?<><div className="qaSummary"><strong>{selected.qa.score}/100</strong><span>{selected.qa.pass?'Technical checks passed':'Technical checks failed'}</span><small>{selected.qa.summary?.passed||0} passed · {selected.qa.summary?.warnings||0} warnings · {selected.qa.summary?.failures||0} failures{Number.isFinite(Number(selected.qa.retention?.score))?` · Retention ${selected.qa.retention.score}/100`:''}</small></div><div className="qaChecks">{(selected.qa.checks||[]).map((c,i)=><div className="qaCheck" key={`${c.name}-${i}`}><b className={`qaBadge ${String(c.status||'').toLowerCase()}`}>{c.status}</b><div><strong>{c.name}</strong><span>{c.message}</span>{c.audioIntelligence&&<AudioDetails data={c.audioIntelligence}/>}</div></div>)}</div></>:<p className="muted">No QA report yet. Run QA to inspect the rendered MP4.</p>}<div className="manualReview"><h4>Human visual review</h4><p className="muted">Automated checks cannot reliably judge story-image relevance or audience suitability. Watch the video before approving it.</p><label><input type="checkbox" checked={visualChecks.imagesMatch} onChange={e=>setVisualChecks(v=>({...v,imagesMatch:e.target.checked}))}/> Every image matches its narration and characters remain consistent</label><label><input type="checkbox" checked={visualChecks.subtitlesReadable} onChange={e=>setVisualChecks(v=>({...v,subtitlesReadable:e.target.checked}))}/> Subtitles are readable and do not hide important action</label><label><input type="checkbox" checked={visualChecks.ageAppropriate} onChange={e=>setVisualChecks(v=>({...v,ageAppropriate:e.target.checked}))}/> Story and visuals are suitable for the channel's intended audience</label><div className="row"><button onClick={saveVisualReview} disabled={!Object.values(visualChecks).every(Boolean)||selected.status!=='AWAITING_APPROVAL'}>Save visual review</button>{selected.visualReview?.reviewedAt&&<small className="muted">Reviewed {new Date(selected.visualReview.reviewedAt).toLocaleString()}</small>}</div></div></section>}
    {detailTab==='scenes'&&<section className="sceneReview"><div className="sectionHead"><div><small className="eyebrow">SELECTIVE REGENERATION</small><h4>Scene assets</h4></div><button className="ghost" disabled={qaBusy||!selected.renderPath} onClick={rerenderOnly}>Re-render video only</button></div><p className="muted">Regenerate a single image without regenerating narration or the other scene images.</p><div className="sceneReviewGrid">{(selected.storyId?.scenes||[]).map((scene,i)=>{const n=Number(scene.sceneNumber||i+1);const asset=(selected.sceneAssets||[]).find(x=>Number(x.sceneNumber)===n);return <article className="sceneReviewCard" key={n}>{asset?.fileName?<img src={`${STORAGE}/storage/videos/${selected._id}/scenes/${encodeURIComponent(asset.fileName)}`} alt={`Scene ${n}`} loading="lazy"/>:<div className="noImage">No image</div>}<div><b>Scene {n}{scene.durationSec?` · ${Number(scene.durationSec).toFixed(1)} s`:''}</b><p>{scene.narration||scene.visualPrompt||'No scene description available.'}</p>{(()=>{const meaning=selected.storyId?.pipelineData?.visualDirectorPlan?.scenes?.find(x=>Number(x.sceneNumber)===n)?.narrationMeaning;return meaning?<p className="sceneMeaning">Image should show: {meaning}</p>:null})()}{asset?.prompt&&<details className="scenePrompt"><summary>{asset.reused?'Image prompt (image reused from an earlier run)':'Image prompt sent to the model'}</summary><p>{asset.prompt}</p></details>}<button className="ghost" disabled={qaBusy||!['AWAITING_APPROVAL','APPROVED','FAILED','CANCELLED'].includes(selected.status)} onClick={()=>regenerateScene(n)}>Regenerate image</button></div></article>})}</div></section>}
    {detailTab==='export'&&<DiagnosticsExport selected={selected}/>}
    {detailTab==='pipeline'&&<><p className="muted">Complete step-by-step execution trace. Every stage keeps its INPUT, OUTPUT, META, timing and error data.</p><PipelineTrace job={selected.jobs?.[0]}/></>}
  </div></div>}
 </div>;
}

export default App;
