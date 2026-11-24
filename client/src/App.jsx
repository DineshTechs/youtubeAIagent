import {useEffect,useMemo,useRef,useState} from 'react';
import {redactDeep,redactText,safeFileStem} from './redact.js';
// On your PC the dashboard runs on Vite (:5173) and talks to the API on :4000.
// On a server the built dashboard is served by the API itself, so it uses the same address.
const DEV_UI=typeof window!=='undefined'&&/^517\d$/.test(window.location.port||'');
const API=(import.meta.env?.VITE_API_URL)||(DEV_UI?'http://127.0.0.1:4000/api':'/api');
const STORAGE=API.replace(/\/api$/,'');
const VIDEO_STATUSES=['ALL','PLANNED','SCRIPT_GENERATED','SCRIPT_QA','ASSETS_GENERATING','VIDEO_RENDERING','VIDEO_QA','SCENE_REVIEW','AWAITING_APPROVAL','APPROVED','UPLOADING','SCHEDULED','PUBLISHED','FAILED','CANCELLED'];
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

// What the job is doing right now, with timers that tick every second, so a long
// wait (an AI provider thinking, an image being drawn) never looks frozen.
const STAGE_TEXT={TOPIC_SELECTION:'Choosing the topic',STORY_GENERATION:'Writing the script',SCRIPT_QA:'Checking the script',VISUAL_DIRECTOR:'Planning the images',VOICE_GENERATION:'Recording the narration',FFMPEG_RENDER:'Rendering the video',FINAL_QA:'Final checks',UPLOAD:'Uploading'};
function stageText(stage){const m=/^SCENE_(\d+)_IMAGE$/.exec(stage||'');if(m)return `Drawing scene ${m[1]} image`;return STAGE_TEXT[stage]||label(stage||'Working');}
function clock(ms){const t=Math.max(0,Math.round(ms/1000));const m=Math.floor(t/60),sec=t%60;return m?`${m}m ${String(sec).padStart(2,'0')}s`:`${sec}s`;}
function jobTitle(job){if(!['QUEUED','RUNNING'].includes(job?.status))return label(job?.status||job?.step);const running=[...(job.pipelineTrace||[])].reverse().find(x=>x.status==='RUNNING');return job.status==='QUEUED'?'Queued':stageText(running?.stage||job.step);}
function LiveActivity({job}){
  const [now,setNow]=useState(Date.now());
  const shownFor=useRef(null);
  useEffect(()=>{if(job?._id&&shownFor.current!==String(job._id)&&['QUEUED','RUNNING'].includes(job.status)){shownFor.current=String(job._id);setTimeout(()=>document.querySelector('.jobCard')?.scrollIntoView({behavior:'smooth',block:'nearest'}),150);}},[job?._id]);
  const active=['QUEUED','RUNNING'].includes(job?.status);
  useEffect(()=>{if(!active)return;const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[active]);
  if(!active)return null;
  const running=[...(job.pipelineTrace||[])].reverse().find(x=>x.status==='RUNNING');
  const logs=job.logs||[];const last=logs[logs.length-1];
  const since=running?.startedAt||job.startedAt||job.createdAt;
  const lastAt=last?.at?new Date(last.at).getTime():null;
  const beat=job.lastHeartbeatAt?now-new Date(job.lastHeartbeatAt).getTime():null;
  const waiting=/waiting for|trying again|busy|rate limit|no answer/i.test(last?.message||'');
  const health=job.status==='QUEUED'?{cls:'wait',text:'Waiting for the worker to pick it up'}:beat==null?{cls:'ok',text:'Worker running'}:beat<45000?{cls:'ok',text:`Worker alive · checked ${clock(beat)} ago`}:beat<120000?{cls:'warn',text:`No sign of life for ${clock(beat)}`}:{cls:'bad',text:`No sign of life for ${clock(beat)} — the backend may have stopped`};
  return <div className="liveActivity">
    <div className="liveNow"><span className="spinner" aria-hidden="true"/><b>{job.status==='QUEUED'?'Waiting in the queue':'Working on this step'}</b><span className="liveClock">{since?clock(now-new Date(since).getTime()):''}</span></div>
    {last&&<div className={`liveLast ${waiting?'waiting':''}`}>{last.message}{lastAt?<em> · {clock(now-lastAt)} ago</em>:null}</div>}
    <div className={`liveHealth ${health.cls}`}><i/>{health.text}{job.startedAt?<span> · total {clock(now-new Date(job.startedAt).getTime())}</span>:null}</div>
  </div>;
}
// A provider priority list (script / images / narration): numbered rows, ↑ ↓ to
// reorder, ✕ to remove, test results shown right under the row that was tested.
// Settings → AI providers → API keys: every key in one place; replace, test or remove any of them.
function ApiKeysPanel({apiJson,json,busy,results,onTest,onSaved}){
  const [list,setList]=useState(null);const [err,setErr]=useState('');const [edit,setEdit]=useState(null);const [form,setForm]=useState({});const [saving,setSaving]=useState(false);const [msg,setMsg]=useState({});
  async function load(){try{const j=await apiJson('/ai/keys');setList(j.keys||[]);setErr('');}catch(e){setErr(/404|Cannot GET/i.test(e.message)?'The backend is running the previous version — restart it to see this page.':e.message);}}
  useEffect(()=>{load();},[]);
  function open(k){setEdit(k.id);setForm(Object.fromEntries(k.fields.map(f=>[f.name,f.secret?'':(f.value||'')])));setMsg(m=>({...m,[k.id]:''}));}
  async function save(k,clear=false){
    if(clear&&!window.confirm(`Remove the ${k.name} key saved in the dashboard?${k.source==='dashboard'?' If the server .env has one, that will be used again.':''}`))return;
    setSaving(true);
    try{const body=clear?{clear:true}:Object.fromEntries(k.fields.filter(f=>!f.secret||String(form[f.name]||'').trim()).map(f=>[f.name,String(form[f.name]??'')]));
      if(!clear&&!Object.keys(body).length)throw new Error('Nothing to save: paste a new key first.');
      const j=await apiJson(`/ai/keys/${k.id}`,json('PUT',body),0);setList(j.keys||[]);if(j.settings)onSaved(j.settings);setEdit(null);
      setMsg(m=>({...m,[k.id]:clear?'Removed.':'Saved. Use the Test button to check it.'}));}
    catch(e){setMsg(m=>({...m,[k.id]:`Not saved: ${e.message}`}));}finally{setSaving(false);}
  }
  const tests=k=>[k.usedFor.includes('Scripts')&&['text',k.id,'Test script'],k.usedFor.includes('Images')&&['image',k.id,'Test images'],k.usedFor.includes('Narration')&&['tts',k.id,'Test voice']].filter(Boolean);
  const label={dashboard:'Saved in dashboard',server:'From server .env',none:'Not set'};
  if(err)return <div className="banner error inline">{err} <button className="ghost" onClick={load}>Retry</button></div>;
  if(!list)return <p className="muted">Loading keys…</p>;
  return <div className="keyList">{list.map(k=><div key={k.id} className={`keyRow ${edit===k.id?'editing':''}`}>
    <div className="keyHead">
      <div className="keyName"><b>{k.name}</b><span className="keyUses">{k.usedFor.map(u=><span key={u} className="chip">{u}</span>)}</span></div>
      <div className="keyState"><span className={`keySource ${k.unreadable?'bad':k.source}`}>{k.unreadable?'Saved, but can’t be read here':label[k.source]}{k.hint&&<code>{k.hint}</code>}</span>
        {k.fields.filter(f=>!f.secret&&f.value).map(f=><small key={f.name} className="muted">{f.label}: {f.value.length>24?`${f.value.slice(0,8)}…${f.value.slice(-4)}`:f.value}{f.fromEnv?' (.env)':''}</small>)}</div>
      <div className="row wrap keyActions">
        <button className={k.hasKey||k.configured?'ghost':''} disabled={saving} onClick={()=>edit===k.id?setEdit(null):open(k)}>{edit===k.id?'Cancel':k.hasKey||k.fields.some(f=>!f.secret&&f.value)?'Edit / replace':k.fields.some(f=>f.secret)?'Add key':'Set address'}</button>
        {tests(k).map(([type,id,t])=><button key={type} className="ghost" disabled={busy||!(k.configured||k.keyOptional)} onClick={()=>onTest(type,id)}>{t}</button>)}
        {k.source==='dashboard'&&<button className="ghost danger" disabled={saving} onClick={()=>save(k,true)}>Remove</button>}
      </div>
    </div>
    {k.warning&&<div className="prioResult bad">{k.warning}</div>}
    {k.unreadable&&<p className="muted small">This key was saved with a different APP_SECRET_KEY (for example on your PC), so this server can’t decrypt it. Paste it again here.</p>}
    {k.unreadableOverridden&&<p className="muted small">A dashboard key saved elsewhere can’t be read here, so the server .env key is used. Paste the key again to replace it.</p>}
    {edit===k.id&&<div className="keyForm">
      {k.note&&<p className="muted small">{k.note}</p>}
      <div className="formGrid">{k.fields.map(f=><Field key={f.name} label={f.label} hint={f.hint&&!f.secret?f.hint:f.secret?(k.hasKey?`Current: ${k.hint||'set'} (${label[k.source].toLowerCase()}). Leave blank to keep it.`:'Stored encrypted; never shown again.'):f.fromEnv?'Currently from server .env; saving here overrides it.':''}>
        <input type={f.secret?'password':'text'} autoComplete={f.secret?'new-password':'off'} value={form[f.name]||''} placeholder={f.secret?(k.hasKey?'Paste the new key':'Paste key'):(f.placeholder||'')} onChange={e=>setForm(x=>({...x,[f.name]:e.target.value}))}/></Field>)}</div>
      <div className="row wrap"><button disabled={saving} onClick={()=>save(k)}>{saving?'Saving…':'Save'}</button>{k.keyUrl&&<a className="small" href={k.keyUrl} target="_blank" rel="noreferrer">Get a key ↗</a>}</div>
      {k.source==='server'&&<p className="muted small">Saving here replaces the .env value for this app without editing the server file. Remove it later to go back to the .env value.</p>}
    </div>}
    {msg[k.id]&&<div className={`prioResult ${/^Not saved/.test(msg[k.id])?'bad':'ok'}`}>{msg[k.id]}</div>}
    {tests(k).map(([type,id])=>(r=>r&&<div key={type} className={`prioResult ${r.pending?'pending':r.ok?'ok':'bad'}`}>{r.pending?<><span className="spinner" aria-hidden="true"/>Testing…</>:<>{r.ok?'✓':'✕'} {r.message}<em> · {new Date(r.at).toLocaleTimeString()}</em></>}</div>)(results[`${type}:${id}`]))}
  </div>)}</div>;
}

function PriorityList({kind,items,order,fallbackEnabled,busy,results,onSave,onTest,onEdit,editLabel,describe,fallbackText}){
  const usable=order.filter(id=>items[id]?.configured);
  const others=Object.keys(items).filter(id=>!order.includes(id));
  const move=(id,dir)=>{const o=[...order];const i=o.indexOf(id),j=i+dir;if(i<0||j<0||j>=o.length)return;[o[i],o[j]]=[o[j],o[i]];onSave({order:o});};
  return <>
    <label className="toggle fallbackToggle"><input type="checkbox" checked={fallbackEnabled!==false} disabled={busy} onChange={e=>onSave({fallbackEnabled:e.target.checked})}/><span>{fallbackText}</span></label>
    <div className="priorityList">{order.map((id,i)=>{const p=items[id]||{name:id};const used=p.configured&&(fallbackEnabled!==false||id===usable[0]);const r=results[`${kind}:${id}`];return <div key={id} className="priorityItem">
      <div className={`priorityRow ${p.configured?'':'missing'} ${id===usable[0]?'main':''}`}>
        <span className="prioNum">{i+1}</span>
        <div className="prioInfo"><strong>{p.name}{id===usable[0]?<em className="tag">main</em>:used?<em className="tag soft">backup</em>:null}</strong><small>{describe(id,p)}{p.configured?'':' · ⚠ not set up — skipped'}{!used&&p.configured?' · not used while backups are off':''}</small></div>
        <span className={`statusDot ${p.configured?'online':''}`}/>
        <div className="prioBtns"><button className="ghost icon" title="Move up" disabled={busy||i===0} onClick={()=>move(id,-1)}>↑</button><button className="ghost icon" title="Move down" disabled={busy||i===order.length-1} onClick={()=>move(id,1)}>↓</button>{p.configured?<button className="ghost" disabled={busy} onClick={()=>onTest(id)}>{r?.pending?'Testing…':'Test'}</button>:null}{onEdit?<button className="ghost" onClick={()=>onEdit(id)}>{editLabel(id,p)}</button>:null}<button className="ghost" title="Stop using" disabled={busy||order.length<=1} onClick={()=>onSave({order:order.filter(x=>x!==id)})}>✕</button></div>
      </div>
      {r&&<div className={`prioResult ${r.pending?'pending':r.ok?'ok':'bad'}`}>{r.pending?<><span className="spinner" aria-hidden="true"/>Testing {p.name}…</>:<>{r.ok?'✓':'✕'} {r.message}<em> · {new Date(r.at).toLocaleTimeString()}</em></>}</div>}
    </div>})}</div>
    {others.length>0&&<div className="formSection"><h4>Not in the list</h4><div className="otherProviders">{others.map(id=>{const p=items[id];return <div key={id} className="otherProvider"><div><strong>{p.name}</strong><small>{id==='mock'?'for testing, no real output':p.freeTier?'🆓 free tier':'💳 paid'}{p.configured?'':' · not set up'}</small></div>{p.configured?<button className="ghost" disabled={busy} onClick={()=>onSave({order:[...order,id]})}>+ Add</button>:onEdit?<button className="ghost" onClick={()=>onEdit(id)}>Set up</button>:null}</div>})}</div></div>}
  </>;
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
const PROFILE_SECTIONS=[['channel','Channel'],['content','Content rules'],['voice','Voice & captions'],['youtube','YouTube'],['autopilot','Autopilot'],['telegram','Telegram'],['research','Research']];
const DAY_NAMES=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DEFAULT_AUTOPILOT={enabled:false,times:['12:30','19:30'],days:[0,1,2,3,4,5,6],leadMinutes:90,minQaScore:70,visibility:'public',blockStaleImages:true,waitForPublish:true};
function autopilotFormFrom(a={}){const x=a&&typeof a==='object'?a:{};return {enabled:x.enabled===true,times:Array.isArray(x.times)&&x.times.length?[...x.times]:[...DEFAULT_AUTOPILOT.times],days:Array.isArray(x.days)&&x.days.length?[...x.days]:[...DEFAULT_AUTOPILOT.days],leadMinutes:Number(x.leadMinutes)||90,minQaScore:Number.isFinite(Number(x.minQaScore))&&x.minQaScore!==undefined?Number(x.minQaScore):70,visibility:['public','unlisted','private'].includes(x.visibility)?x.visibility:'public',blockStaleImages:x.blockStaleImages!==false,waitForPublish:x.waitForPublish!==false};}
const RUN_LABEL={WAITING:'Waiting for previous video',GENERATING:'Making video',APPROVED:'Uploading',SCHEDULED:'Scheduled on YouTube',PUBLISHED:'Uploaded',NEEDS_ATTENTION:'Needs attention',FAILED:'Failed',SKIPPED:'Skipped'};
const EMPTY_TG={enabled:false,commandsEnabled:false,hasToken:false,botUsername:'',chats:[],events:{},eventCatalog:[],sendVideoOnReady:true,lastError:'',lastSentAt:null};
const EMPTY_YT_ACCOUNT={clientId:'',hasClientSecret:false,redirectUri:'',defaultRedirectUri:'http://127.0.0.1:4000/api/youtube/callback',publishEnabled:false,configured:false,connected:false};
const YT_CATEGORIES=[['1','Film & Animation'],['2','Autos & Vehicles'],['10','Music'],['15','Pets & Animals'],['17','Sports'],['19','Travel & Events'],['20','Gaming'],['22','People & Blogs'],['23','Comedy'],['24','Entertainment'],['25','News & Politics'],['26','Howto & Style'],['27','Education'],['28','Science & Technology'],['29','Nonprofits & Activism']];
const VOICE_PRESETS={azure:['hi-IN-SwaraNeural','hi-IN-MadhurNeural','hi-IN-AaravNeural','hi-IN-AnanyaNeural','hi-IN-KavyaNeural','hi-IN-KunalNeural','hi-IN-RehaanNeural','en-IN-NeerjaNeural','en-IN-PrabhatNeural'],google:['hi-IN-Wavenet-A','hi-IN-Wavenet-B','hi-IN-Wavenet-C','hi-IN-Wavenet-D','hi-IN-Standard-A','hi-IN-Standard-B','hi-IN-Standard-C','hi-IN-Standard-D','hi-IN-Neural2-A','hi-IN-Neural2-B','hi-IN-Chirp3-HD-Kore','hi-IN-Chirp3-HD-Puck'],groq:['autumn','diana','hannah','austin','daniel','troy'],openai:['alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse'],gemini:['Kore','Zephyr','Puck','Charon','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat']};
const TIMEZONES=['Asia/Kolkata','UTC','Europe/London','Europe/Berlin','America/New_York','America/Chicago','America/Los_Angeles','Asia/Dubai','Asia/Singapore','Asia/Tokyo','Australia/Sydney'];
const joinList=v=>Array.isArray(v)?v.filter(Boolean).join('\n'):String(v||'');
const splitList=v=>[...new Set(String(v||'').split(/[\n,]/).map(x=>x.trim()).filter(Boolean))];
const splitLines=v=>[...new Set(String(v||'').split(/\n/).map(x=>x.trim()).filter(Boolean))];
// Mirrors server/src/services/uploadSettings.js defaults so the form shows what will be used.
function uploadFormFrom(u={},{kids=false}={}){
  const b=(v,d)=>typeof v==='boolean'?v:d;
  return {privacyStatus:['private','unlisted','public'].includes(u.privacyStatus)?u.privacyStatus:'private',categoryId:YT_CATEGORIES.some(([id])=>id===String(u.categoryId))?String(u.categoryId):(kids?'1':'24'),
    madeForKids:b(u.madeForKids,kids),containsSyntheticMedia:b(u.containsSyntheticMedia,true),notifySubscribers:b(u.notifySubscribers,true),embeddable:b(u.embeddable,true),publicStatsViewable:b(u.publicStatsViewable,true),
    license:u.license==='creativeCommon'?'creativeCommon':'youtube',titleTemplate:u.titleTemplate||'{title}',tags:(Array.isArray(u.tags)?u.tags:[]).join(', '),hashtags:(Array.isArray(u.hashtags)?u.hashtags:[]).map(h=>`#${h}`).join(' '),
    descriptionFooter:u.descriptionFooter||'',seoKeywords:(Array.isArray(u.seoKeywords)?u.seoKeywords:[]).join(', '),playlistId:u.playlistId||'',scheduleTime:u.scheduleTime||'',timezone:u.timezone||'Asia/Kolkata'};
}
function uploadPayload(u){return {...u,tags:splitList(u.tags),seoKeywords:splitList(u.seoKeywords),hashtags:String(u.hashtags||'').split(/[\s,]+/).map(h=>h.replace(/^#+/,'')).filter(Boolean),titleTemplate:u.titleTemplate.trim()||'{title}',playlistId:u.playlistId.trim(),descriptionFooter:u.descriptionFooter.trim()};}
const DEFAULT_PROFILE_FORM={name:'',premise:'',niche:'',targetAge:'General audience',language:'English',visualStyle:'Cinematic, high-quality visuals',tone:'Engaging and informative',contentFormat:'Explainer',aspectRatio:'9:16',voiceStyle:'Natural, clear and engaging',durationSec:55,hookStyle:'Curiosity',topicSource:'queue-then-trending',trendRegion:'IN',callToAction:'',rules:'',avoidTopics:'',topicIdeas:'',subtitles:'default',subtitlePosition:'default',voices:{},upload:uploadFormFrom({}),autopilot:autopilotFormFrom({})};
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
    hookStyle:cp.content?.hookStyle||'Curiosity',
    topicSource:['queue-then-trending','trending','queue'].includes(cp.content?.topicSource)?cp.content.topicSource:'queue-then-trending',trendRegion:/^[A-Z]{2}$/.test(cp.content?.trendRegion||'')?cp.content.trendRegion:'IN',
    callToAction:cp.content?.callToAction&&cp.content.callToAction!=='Natural and relevant to the channel'?cp.content.callToAction:'',
    rules:joinList(x.rules),avoidTopics:joinList(cp.editorial?.avoidTopics),topicIdeas:joinList(x.topicIdeas),
    subtitles:['on','off'].includes(cp.visual?.subtitles)?cp.visual.subtitles:'default',
    subtitlePosition:['bottom','center','top'].includes(cp.visual?.subtitlePosition)?cp.visual.subtitlePosition:'default',
    voices:Object.fromEntries(Object.entries(cp.narration?.voices||{}).filter(([,v])=>v)),
    autopilot:autopilotFormFrom(x.autopilot),
    upload:uploadFormFrom(x.uploadSettings||{},{kids:cp.editorial?.safetyMode==='kids-and-family'||KIDS_RE.test(`${x.niche||''} ${cp.audience?.description||''}`)})
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

function VideoRow({v,onOpen,onApprove,onCancel,onRetry,onDelete,onRender,compact}){
  const j=v.latestJob;const active=isActive(j);const thumb=thumbUrl(v);
  return <article className={`videoRow ${compact?'compact':''}`}>
    <button className="thumb" onClick={()=>onOpen(v._id)} aria-label={`Open ${v.title}`}>{thumb?<img src={thumb} alt="" loading="lazy" onError={e=>{e.currentTarget.style.display='none'}}/>:<span>{(v.title||'?').slice(0,1)}</span>}</button>
    <div className="videoInfo">
      <div className="videoTitleLine"><h4 onClick={()=>onOpen(v._id)}>{v.title||'Untitled video'}</h4><StatusPill status={v.status}/></div>
      <small className="muted">{v.profile&&<span className={`profileTag ${v.profile.archived?'archived':''}`}>{v.profile.name}</span>}{v.durationSec?`${Math.round(v.durationSec)} s`:'— s'} · {timeAgo(v.updatedAt)}{j?.retryCount?` · attempt #${j.retryCount+1}`:''}{v.qa?.score!=null?` · QA ${v.qa.score}/100`:''}</small>
      {j&&active&&<div className="videoProgress"><div className="miniBar"><i style={{width:`${pct(j)}%`}}/></div><span>{label(j.step||j.status)} · {pct(j)}%</span></div>}
      {!compact&&j&&!active&&['FAILED','CANCELLED'].includes(v.status)&&<JobStepProgress job={j}/>}
      {v.error&&<div className="videoError">{v.error}</div>}
    </div>
    <div className="videoActions">
      <button className="ghost" onClick={()=>onOpen(v._id)}>Details</button>
      {!compact&&videoFileUrl(v)&&<a className="btnLink" href={videoFileUrl(v)} target="_blank" rel="noreferrer">Preview</a>}
      {v.status==='AWAITING_APPROVAL'&&<button onClick={()=>onApprove(v._id)}>Approve</button>}
      {v.status==='SCENE_REVIEW'&&<button onClick={()=>onRender(v._id)} title={v.pendingSceneEdit?.sceneNumber?`Scene ${v.pendingSceneEdit.sceneNumber} was changed; render the video with it`:''}>Render video</button>}
      {v.status==='APPROVED'&&!compact&&<button onClick={()=>onOpen(v._id,'youtube')}>Upload</button>}
      {active&&(j?.cancelRequested?<button className="danger" disabled>Stopping…</button>:<button className="danger" onClick={()=>onCancel(v._id)}>Cancel</button>)}
      {['FAILED','CANCELLED'].includes(v.status)&&!active&&<button onClick={()=>onRetry(v._id)}>Continue</button>}
      {!compact&&<button className="danger ghost" onClick={()=>onDelete(v._id)}>Delete</button>}
    </div>
  </article>;
}

async function ytFetch(path,options={}){
  const r=await fetch(`${API}${path}`,{cache:'no-store',...options});
  const text=await r.text();let j={};try{j=text?JSON.parse(text):{};}catch{j={error:text||`HTTP ${r.status}`};}
  if(!r.ok)throw new Error(j.error||`Request failed (${r.status})`);return j;
}
function toLocalInput(d){if(!d)return '';const x=new Date(d);if(Number.isNaN(x.getTime()))return '';const p=n=>String(n).padStart(2,'0');return `${x.getFullYear()}-${p(x.getMonth()+1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;}
// Upload one approved video using its profile's YouTube defaults (editable here).
function YouTubePanel({video,onDone,onEditProfile}){
  const [info,setInfo]=useState(null),[err,setErr]=useState(''),[busy,setBusy]=useState(false),[result,setResult]=useState(null);
  const [form,setForm]=useState({title:'',description:'',tags:'',privacyStatus:'private',when:'now',publishAt:''}),[seoBusy,setSeoBusy]=useState(false);
  function applyInfo(j){setInfo(j);setForm(f=>({...f,title:j.metadata.title,description:j.metadata.description,tags:(j.metadata.tags||[]).join(', '),privacyStatus:j.metadata.privacyStatus,publishAt:f.publishAt||toLocalInput(j.nextSlot||Date.now()+3600000)}));}
  async function load(){try{setErr('');applyInfo(await ytFetch(`/youtube/preview/${video._id}`));}catch(e){setErr(e.message);}}
  async function regenSeo(){if(!window.confirm('Write new SEO title, description and tags with AI? Your edits in this form will be replaced.'))return;setSeoBusy(true);setErr('');try{applyInfo(await ytFetch(`/youtube/seo/${video._id}`,{method:'POST'}));}catch(e){setErr(e.message);}finally{setSeoBusy(false);}}
  useEffect(()=>{load();},[video._id]);
  useEffect(()=>{const onMsg=e=>{if(e?.data?.type==='YOUTUBE_CONNECTED')load();};window.addEventListener('message',onMsg);return()=>window.removeEventListener('message',onMsg);},[video._id]);
  async function upload(){
    const when=form.when==='slot'?'at the profile\'s next publish slot':form.when==='custom'?`at ${new Date(form.publishAt).toLocaleString()}`:`now as ${form.privacyStatus}`;
    if(!window.confirm(`Upload "${form.title}" to YouTube ${when}?`))return;
    setBusy(true);setErr('');
    try{const body={title:form.title,description:form.description,tags:form.tags.split(',').map(t=>t.trim()).filter(Boolean),privacyStatus:form.privacyStatus,...(form.when==='slot'?{schedule:'profile'}:form.when==='custom'?{publishAt:new Date(form.publishAt).toISOString()}:{})};
      const j=await ytFetch(`/youtube/publish/${video._id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});setResult(j);onDone&&onDone();}
    catch(e){setErr(e.message);}finally{setBusy(false);}
  }
  if(!info&&!err)return <p className="muted">Preparing SEO-optimized upload details… (the first time, the AI writes the title, description and tags for this video)</p>;
  const rep=info?.seoReport,seo=info?.seo;
  const yt=info?.youtube||{};const m=info?.metadata||{};const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const uploaded=result?.youtubeVideoId||video.youtubeVideoId;
  const blockers=[info?.blockReason,...(info?.blockReason?[]:(info?.problems||[]))].filter(Boolean);
  return <section className="ytPanel">
    <div className="sectionHead"><div><small className="eyebrow">YOUTUBE UPLOAD</small><h4>{info?.profile?<>Profile "{info.profile.name}" → {yt.connected?<>channel <b>{yt.channelTitle||yt.channelId}</b></>:'no channel connected'}</>:'No profile linked'}</h4></div><div className="row">{info?.profile&&<button className="ghost" onClick={()=>onEditProfile(String(info.profile.id))}>Profile YouTube settings</button>}{info?.profile&&yt.configured&&<button className="ghost" onClick={()=>window.open(`${API}/youtube/auth/${info.profile.id}`,'youtube-auth','width=520,height=700')}>{yt.connected?'Reconnect channel':'Connect channel'}</button>}</div></div>
    {err&&<div className="videoError">{err}</div>}
    {uploaded&&<div className="banner info inline">On YouTube: <a href={`https://www.youtube.com/watch?v=${uploaded}`} target="_blank" rel="noreferrer">youtube.com/watch?v={uploaded}</a>{result?.publishAt?` · goes public ${new Date(result.publishAt).toLocaleString()}`:''}{(result?.warnings||[]).map((w,i)=><div key={i}>{w}</div>)}</div>}
    {blockers.length>0&&<ul className="blockers">{blockers.map((b,i)=><li key={i}>{b}</li>)}</ul>}
    {info&&rep&&<div className="seoBox">
      <div className={`seoScore ${rep.score>=80?'good':rep.score>=50?'mid':'low'}`}><strong>{rep.score}</strong><small>SEO</small></div>
      <div className="seoBody">
        <div className="seoHead"><div><small className="eyebrow">SEO</small><b>{seo?.focusKeyword?<>Focus keyword: “{seo.focusKeyword}”</>:'No focus keyword yet'}</b><small className="muted">{seo?.source==='upload-seo'?`AI-optimized${seo.language?` in ${seo.language}`:''}${seo.generatedAt?` · ${new Date(seo.generatedAt).toLocaleString()}`:''}`:seo?.source?'From the generation-time SEO skill':'Basic metadata'}{info.isShort?' · Short':''}</small></div><button className="ghost" onClick={regenSeo} disabled={seoBusy||busy}>{seoBusy?'Optimizing…':'Regenerate SEO'}</button></div>
        {seo?.error&&<div className="banner info inline">{seo.error}</div>}
        <ul className="seoChecks">{rep.checks.map(c=><li key={c.id} className={c.ok?'ok':'no'} title={c.ok?'':c.tip}><span>{c.ok?'✓':'!'}</span>{c.label}{!c.ok&&<small> — {c.tip}</small>}</li>)}</ul>
        {(seo?.searchQueries||[]).length>0&&<small className="muted">Targets searches: {seo.searchQueries.join(' · ')}</small>}
        <small className="muted">The score here is for the AI-prepared details. Your edits below are kept as written; on upload, missing hashtags and the focus-keyword tag are added and limits are enforced.</small>
      </div>
    </div>}
    {info&&<div className="formGrid">
      <Field label={`Title (${form.title.length}/100)`} wide><input maxLength={100} value={form.title} onChange={e=>set('title',e.target.value)}/></Field>
      <Field label="Description" wide><textarea rows="7" value={form.description} onChange={e=>set('description',e.target.value)}/></Field>
      <Field label={`Tags (${form.tags.split(',').filter(t=>t.trim()).length})`} hint="Comma separated. The focus keyword is always added and the list is trimmed to YouTube's 500-character limit." wide><input value={form.tags} onChange={e=>set('tags',e.target.value)}/></Field>
      <Field label="Visibility"><select value={form.privacyStatus} onChange={e=>set('privacyStatus',e.target.value)} disabled={form.when!=='now'}><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select></Field>
      <Field label="When" hint={form.when==='slot'?(info.nextSlot?`Next slot: ${new Date(info.nextSlot).toLocaleString()} (${info.settings.timezone})`:'Set a daily publish time on the profile first.'):form.when!=='now'?'Uploaded as private, then YouTube makes it public at this time.':''}><select value={form.when} onChange={e=>set('when',e.target.value)}><option value="now">Upload now</option><option value="slot" disabled={!info.nextSlot}>Profile's next publish slot</option><option value="custom">Pick date & time</option></select></Field>
      {form.when==='custom'&&<Field label="Publish at (your local time)"><input type="datetime-local" value={form.publishAt} onChange={e=>set('publishAt',e.target.value)}/></Field>}
    </div>}
    {info&&<div className="kvGrid">
      <div className="kv"><span>Category</span><b>{(YT_CATEGORIES.find(([id])=>id===m.categoryId)||[])[1]||m.categoryId}</b></div>
      <div className="kv"><span>Audience</span><b>{m.selfDeclaredMadeForKids?'Made for kids':'Not made for kids'}</b></div>
      <div className="kv"><span>AI disclosure</span><b>{m.containsSyntheticMedia?'Yes':'No'}</b></div>
      <div className="kv"><span>Language</span><b>{m.defaultLanguage||'—'}</b></div>
      <div className="kv"><span>Playlist</span><b>{m.playlistId||'—'}</b></div>
      <div className="kv"><span>Tags</span><b title={(m.tags||[]).join(', ')}>{(m.tags||[]).length}</b></div>
    </div>}
    <div className="row"><button onClick={upload} disabled={busy||blockers.length>0||!form.title.trim()||(form.when==='custom'&&!form.publishAt)}>{busy?'Uploading…':uploaded?'Upload again':'Upload to YouTube'}</button></div>
  </section>;
}

// Settings → Home page.
function SiteSettingsCard({site,setSite,load,save,busy,msg}){
  useEffect(()=>{if(!site)load();},[]);
  const f=(k,label,hint,props={})=><Field label={label} hint={hint}><input value={site?.[k]||''} onChange={e=>setSite(s=>({...s,[k]:e.target.value}))} {...props}/></Field>;
  const area=(k,label,hint,rows=4)=><Field wide label={label} hint={hint}><textarea rows={rows} value={site?.[k]||''} onChange={e=>setSite(s=>({...s,[k]:e.target.value}))}/></Field>;
  return <Card eyebrow="PUBLIC PAGE" title="Home page details" actions={<><a className="ghost small btnLink" href="/" target="_blank" rel="noreferrer">Open home page</a><button onClick={save} disabled={busy||!site}>{busy?'Saving…':'Save'}</button></>}>
    <p className="muted small">Shown on the public home page. Leave a contact empty to hide it (email, WhatsApp and Telegram then show “to be added”).</p>
    {!site?<p className="muted">Loading…</p>:<>
      <div className="formSection"><h4>Brand</h4><div className="formGrid">
        {f('brand','Product name','Shown in the header and page title.')}
        {f('business','Business / owner name','Shown in the footer. Empty = product name.')}
      </div></div>
      <div className="formSection"><h4>Contact</h4><div className="formGrid">
        {f('email','Email','Buyers get a pre-filled email with the plan they chose.',{type:'email',placeholder:'support@aividman.store'})}
        {f('whatsapp','WhatsApp number','With country code, e.g. 919876543210. Opens WhatsApp with the chosen plan.',{inputMode:'tel',placeholder:'919876543210'})}
        {f('telegram','Telegram username','Without @, e.g. aivm_support.',{placeholder:'aivm_support'})}
        {f('instagram','Instagram username','Optional.',{placeholder:'aivideomanager'})}
        {f('phone','Phone','Optional.',{inputMode:'tel'})}
        {f('supportHours','Support hours','Optional, e.g. Mon–Sat, 10 am – 7 pm IST.')}
      </div></div>
      <div className="formSection"><h4>Policies</h4><div className="formGrid">
        {area('refund','Refund policy','One or two sentences, shown in the FAQ.',2)}
        {area('terms','Terms of use','Optional. Shown at the bottom of the home page when filled in.',6)}
        {area('privacy','Privacy policy','Optional. Shown at the bottom of the home page when filled in.',6)}
      </div></div>
    </>}
    {msg&&<div className={`prioResult ${msg.ok?'ok':'bad'}`}>{msg.ok?'✓':'✕'} {msg.text}</div>}
  </Card>;
}

// Login for a hosted install (the server asks for it; on your own PC there is none).
function LoginScreen({locked,onLogin}){
  const [form,setForm]=useState({username:'admin',password:''}),[busy,setBusy]=useState(false),[msg,setMsg]=useState('');
  async function submit(e){e.preventDefault();setBusy(true);setMsg('');try{const r=await fetch(`${API}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(form)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`Login failed (${r.status})`);setForm(f=>({...f,password:''}));onLogin(j);}catch(err){setMsg(err.message)}finally{setBusy(false)}}
  return <div className="loginPage"><form className="loginCard" onSubmit={submit}>
    <div className="brand"><div className="logo">AI</div><div><b>AI Video Manager</b><small>Channel Studio</small></div></div>
    {locked?<div className="banner error"><span>This server has no admin password yet. Set <code>ADMIN_PASSWORD</code> (or <code>ADMIN_PASSWORD_HASH</code>) in the app's environment variables and restart it.</span></div>:<>
      <label>Username<input autoComplete="username" value={form.username} onChange={e=>setForm(f=>({...f,username:e.target.value}))}/></label>
      <label>Password<input type="password" autoComplete="current-password" autoFocus value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))}/></label>
      {msg&&<div className="prioResult bad">✕ {msg}</div>}
      <button type="submit" disabled={busy||!form.password}>{busy?'Signing in…':'Sign in'}</button>
    </>}
  </form></div>;
}

function App(){
 const [auth,setAuth]=useState({checked:false,required:false,loggedIn:true,locked:false,username:null});
 async function loadAuth(){try{const r=await fetch(`${API}/auth/status`,{credentials:'include',cache:'no-store'});if(r.status===404){setAuth({checked:true,required:false,loggedIn:true});return;}const j=await r.json();setAuth({checked:true,required:Boolean(j.required),loggedIn:Boolean(j.loggedIn),locked:Boolean(j.required&&!j.configured),username:j.username||null});}catch{setAuth(a=>({...a,checked:true}))}}
 useEffect(()=>{loadAuth();const onNeed=()=>setAuth(a=>a.required||a.checked?{...a,required:true,loggedIn:false}:a);window.addEventListener('yta-login-required',onNeed);return()=>window.removeEventListener('yta-login-required',onNeed);},[]);
 async function logout(){try{await fetch(`${API}/auth/logout`,{method:'POST',credentials:'include'});}catch{}setAuth(a=>({...a,loggedIn:false}));}

 const pollingRef=useRef(null),[activeJobs,setActiveJobs]=useState([]);
 const [videos,setVideos]=useState([]),[job,setJob]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [ai,setAi]=useState(null),[aiBusy,setAiBusy]=useState(false),[aiMsg,setAiMsg]=useState(''),[aiSavedAt,setAiSavedAt]=useState(null);
 const [seriesList,setSeriesList]=useState([]),[selectedSeriesId,setSelectedSeriesId]=useState(''),[seriesForm,setSeriesForm]=useState({...DEFAULT_PROFILE_FORM});
 const [genSeriesId,setGenSeriesId]=useState('');
 const [tgForm,setTgForm]=useState({botToken:'',enabled:false,commandsEnabled:false,chats:[],events:{},sendVideoOnReady:true}),[tgMsg,setTgMsg]=useState(''),[tgBusy,setTgBusy]=useState(false),[tgFound,setTgFound]=useState(null),[tgManual,setTgManual]=useState(''),[tgCopyFrom,setTgCopyFrom]=useState('');
 const [trendIdeas,setTrendIdeas]=useState(null),[trendBusy,setTrendBusy]=useState(false),[trendMsg,setTrendMsg]=useState('');
 const [textModelList,setTextModelList]=useState({provider:'',models:[],msg:''});
 const [restartNeeded,setRestartNeeded]=useState(false);
 const [providerTab,setProviderTab]=useState('script');
 // Settings → Home page: product name and contact details shown on the public home page (/).
 const [site,setSite]=useState(null),[siteMsg,setSiteMsg]=useState(null),[siteBusy,setSiteBusy]=useState(false);
 async function loadSite(){try{setSite(await apiJson('/site',{},0));}catch(e){setSiteMsg({ok:false,text:/Not found|404|Cannot GET/i.test(e.message)?'Restart the app to edit the home page (the backend is running the previous version).':e.message});}}
 async function saveSite(){setSiteBusy(true);setSiteMsg(null);try{const j=await apiJson('/site',json('PUT',site),0);setSite(j);setSiteMsg({ok:true,text:'Saved. The home page shows the new details now.'});}catch(e){setSiteMsg({ok:false,text:e.message});}finally{setSiteBusy(false)}}
 const [testResults,setTestResults]=useState({}),[imageEdit,setImageEdit]=useState(null),[ttsEdit,setTtsEdit]=useState(null);
 const [textKeyProvider,setTextKeyProvider]=useState('openrouter'),[textKeyForm,setTextKeyForm]=useState({key:'',accountId:'',baseUrl:'',model:''});
 const [ttsKeyForm,setTtsKeyForm]=useState({key:'',region:'',url:'',tool:'',enhance:false}),[ttsVoiceList,setTtsVoiceList]=useState(null),[keyProvider,setKeyProvider]=useState('aiawaaz'),[ttsVoiceMsg,setTtsVoiceMsg]=useState('');
 const [profileSection,setProfileSection]=useState('channel'),[ytForm,setYtForm]=useState({clientId:'',clientSecret:'',redirectUri:'',publishEnabled:false}),[ytMsg,setYtMsg]=useState(''),[ytBusy,setYtBusy]=useState(false);
 const [seriesLoaded,setSeriesLoaded]=useState(false),[aiError,setAiError]=useState('');
 const [channelUrl,setChannelUrl]=useState(''),[researchBusy,setResearchBusy]=useState(false),[researchMsg,setResearchMsg]=useState(''),[topicInput,setTopicInput]=useState(''),[pendingResearch,setPendingResearch]=useState(null);
 const [backendStatus,setBackendStatus]=useState('checking');
 const [tab,setTab]=useState('create'),[filter,setFilter]=useState('ALL'),[profileFilter,setProfileFilter]=useState('ALL'),[stats,setStats]=useState(null),[selected,setSelected]=useState(null),[settingsTab,setSettingsTab]=useState('providers'),[detailTab,setDetailTab]=useState('overview');
 const profileDirtyRef=useRef(false);
 const [qaBusy,setQaBusy]=useState(false),[visualChecks,setVisualChecks]=useState({imagesMatch:false,subtitlesReadable:false,ageAppropriate:false});

 async function apiJson(path,options={},attempts=2){
   let lastError;
   for(let attempt=0;attempt<=attempts;attempt++){
     try{
       const r=await fetch(`${API}${path}`,{cache:'no-store',...options});
       const text=await r.text();
       let j={}; try{j=text?JSON.parse(text):{};}catch{j={error:text||`HTTP ${r.status}`};}
       if(r.status===401&&j.loginRequired)window.dispatchEvent(new Event('yta-login-required'));
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
 async function checkBackend(){try{const h=await apiJson('/health',{},1);setRestartNeeded(Boolean(h?.restartNeeded));}catch{} }
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
     content:{...(existing.content||{}),primaryFormat:f.contentFormat||'Explainer',tone:f.tone||'Engaging and informative',hookStyle:f.hookStyle||'Curiosity',durationSec:Number(f.durationSec)||55,storytellingApproach:existing.content?.storytellingApproach||'Clear and niche-appropriate',callToAction:f.callToAction.trim(),topicSource:f.topicSource,trendRegion:f.trendRegion},
     visual:{...(existing.visual||{}),style:f.visualStyle||'Cinematic, high-quality visuals',aspectRatio:f.aspectRatio||'9:16',avoidTextInImages:true,subtitleSafeArea:true,subtitles:f.subtitles,subtitlePosition:f.subtitlePosition},
     narration:{...(existing.narration||{}),voiceStyle:f.voiceStyle||'Natural, clear and engaging',language:f.language||'English',voices:f.voices||{}},
     editorial:{...(existing.editorial||{}),avoidTopics:splitLines(f.avoidTopics),safetyMode:kids?'kids-and-family':(existing.editorial?.safetyMode&&existing.editorial.safetyMode!=='kids-and-family'?existing.editorial.safetyMode:'standard'),factChecking:existing.editorial?.factChecking!==false},
     source:existing.source==='channel-research'?'channel-research':'user-configured'};
   const payload={name:f.name.trim(),premise:f.premise.trim(),niche:f.niche,targetAge:f.targetAge,language:f.language,visualStyle:f.visualStyle,channelProfile,
     rules:splitLines(f.rules),topicIdeas:splitLines(f.topicIdeas),uploadSettings:uploadPayload(f.upload),autopilot:{...f.autopilot,timezone:f.upload.timezone},
     ...(pendingResearch?{channelResearch:pendingResearch.research,contentStrategy:pendingResearch.research?.strategy}:{})};
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
   try{const j=await apiJson('/series',json('POST',{name,premise:current.premise||name,niche:current.niche,targetAge:current.targetAge,language:current.language,visualStyle:current.visualStyle,channelProfile:current.channelProfile||{},rules:current.rules||[],topicIdeas:current.topicIdeas||[],contentStrategy:current.contentStrategy||null,uploadSettings:current.uploadSettings||{},active:false}),0);
     profileDirtyRef.current=false;await loadSeries();setSelectedSeriesId(String(j._id));setSeriesForm(formFromSeries(j));setPendingResearch(null);setResearchMsg(`Created "${name}". Edit it and save.`);
   }catch(e){setResearchMsg(`Duplicate failed: ${e.message}`)}
 }
 async function activateSeries(id=selectedSeriesId){if(!id)return;try{const j=await apiJson(`/series/${id}/activate`,{method:'POST'});setResearchMsg(`"${j.name}" is now the default profile.`);setGenSeriesId(String(j._id));await loadSeries();}catch(e){setResearchMsg(e.message)}}
 async function studyChannel(){if(!channelUrl.trim()){setResearchMsg('Enter a YouTube channel URL first.');return;}setResearchBusy(true);setResearchMsg('Studying channel: videos, audience signals, topics and content patterns…');try{const j=await apiJson('/series/research-channel',json('POST',{url:channelUrl.trim(),language:seriesForm.language||'English'}));setPendingResearch(j);setSeriesForm(f=>({...f,...Object.fromEntries(Object.entries(j.autofill||{}).filter(([k,v])=>k in DEFAULT_PROFILE_FORM&&typeof v!=='object')),...((j.research?.strategy?.topicIdeas||[]).length?{topicIdeas:joinList(j.research.strategy.topicIdeas)}:{})}));setResearchMsg('Channel studied. The profile fields were filled in — review them, then Save profile.');}catch(e){setResearchMsg(`Channel research failed: ${e.message}`)}finally{setResearchBusy(false)}}
 const filterRef=useRef('ALL'),profileFilterRef=useRef('ALL');
 function pickProfileFilter(id){setProfileFilter(id);profileFilterRef.current=id;refresh(filterRef.current,id);}
 async function refresh(nextFilter=filterRef.current,nextProfile=profileFilterRef.current){try{const q=new URLSearchParams();if(nextFilter&&nextFilter!=='ALL')q.set('status',nextFilter);if(nextProfile&&nextProfile!=='ALL')q.set('seriesId',nextProfile);const url=`/videos${q.toString()?`?${q}`:''}`;const j=await apiJson(url);setVideos(Array.isArray(j)?j:[]);clearLoadError();}catch(e){setError(`Failed to load videos: ${e.message}`)}}
 async function refreshStats(){try{const j=await apiJson('/videos/stats',{},1);setStats(j);}catch{} }
 // Jobs started anywhere (another tab, Telegram, Autopilot, before a page reload) show up in the LIVE card.
 async function refreshActive(){try{const list=await apiJson('/agent/active',{},0);setActiveJobs(Array.isArray(list)?list:[]);if(!pollingRef.current&&Array.isArray(list)&&list.length){const first=list.find(x=>x.status==='RUNNING')||list[0];setJob(first);setBusy(true);poll(first._id);}}catch{}}
 async function loadAI(){try{const j=await apiJson('/ai/settings');setAi(j);setAiError('');}catch(e){setAiError(e.message||'Backend unavailable');}}
 async function chooseAI(provider){setAiBusy(true);setAiMsg('');try{const j=await apiJson('/ai/settings',json('PUT',{provider}),0);setAi(j);setAiMsg(`Script AI changed to ${j.providers[provider].name}.`);}catch(e){setAiMsg(e.message)}finally{setAiBusy(false)}}
 async function chooseMedia(type,provider){setAiBusy(true);setAiMsg('');try{const j=await apiJson('/ai/media-settings',json('PUT',{type,provider}),0);setAi(j);setAiSavedAt(new Date());setAiMsg(`${type==='image'?'Image':'Narration'} provider changed to ${provider}.`);}catch(e){setAiMsg(e.message)}finally{setAiBusy(false)}}
 async function saveAIConfig(patch,what='Settings'){setAiBusy(true);setAiMsg('Saving…');try{const j=await apiJson('/ai/config',json('PUT',patch),0);setAi(j);setAiSavedAt(new Date());setAiMsg(`${what} saved.`);}catch(e){setAiMsg(e.message)}finally{setAiBusy(false)}}
 async function testMedia(type,provider){const k=`${type}:${provider}`;setTestResults(x=>({...x,[k]:{pending:true}}));setAiBusy(true);try{const r=await fetch(`${API}/ai/test-media/${type}/${provider}`,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error);setTestResults(x=>({...x,[k]:{ok:true,message:j.result?.message||'Works.',at:Date.now()}}));await loadAI();}catch(e){setTestResults(x=>({...x,[k]:{ok:false,message:/Cannot POST|404/i.test(e.message)?'The backend is running the previous version — restart the app.':e.message,at:Date.now()}}))}finally{setAiBusy(false)}}
 async function testAI(provider){const k=`text:${provider}`;setTestResults(x=>({...x,[k]:{pending:true}}));setAiBusy(true);try{const r=await fetch(`${API}/ai/test/${provider}`,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error);setTestResults(x=>({...x,[k]:{ok:true,message:`${ai.providers[provider].name} answered${j.result?.message?`: “${String(j.result.message).slice(0,120)}”`:'.'}`,at:Date.now()}}));await loadAI();}catch(e){setTestResults(x=>({...x,[k]:{ok:false,message:e.message,at:Date.now()}}))}finally{setAiBusy(false)}}
 // Generation uses the SAVED profile only; the request carries profile + optional topic.
 async function generate(){if(!genSeriesId){setError('Create or choose a channel profile first.');return;}setBusy(true);setError('');setNotice('');try{const j=await apiJson('/agent/generate',json('POST',{seriesId:genSeriesId,topic:topicInput.trim()||null}));setJob(j);setNotice(j.profile?`Generating with "${j.profile.name}" · ${j.profile.language} · ${j.profile.format} · ${j.profile.durationSec}s · ${j.profile.hookStyle} hook`:'');poll(j.jobId);}catch(e){setError(`Generation request failed: ${e.message}`);setBusy(false)}}
 async function poll(id,networkFailures=0){pollingRef.current=String(id);try{const j=await apiJson(`/agent/status/${id}`,{},1);setJob(j);if(['COMPLETED','FAILED','CANCELLED'].includes(j.status)){pollingRef.current=null;setBusy(false);setQaBusy(false);await refresh();await refreshStats();return;}setTimeout(()=>poll(id,0),1200);}catch(e){if(networkFailures<5){setBackendStatus('offline');setTimeout(()=>poll(id,networkFailures+1),1500);return;}pollingRef.current=null;setError(`Job status unavailable: ${e.message}`);setBusy(false);setQaBusy(false)}}
 async function approve(id){try{await apiJson(`/videos/${id}/approve`,{method:'POST'});setError('');await refresh();await refreshStats();if(selected?._id===id)await openVideo(id,detailTab);}catch(e){setError(`Approve failed: ${e.message}`)}}
 async function retryVideo(id){setError('');setBusy(true);try{const j=await apiJson(`/videos/${id}/retry`,{method:'POST'},2);setSelected(null);setJob(j);setTab('create');await refresh();await refreshStats();poll(j.jobId);}catch(e){setBusy(false);setError(`Continue failed: ${e.message}`)}}
 async function renderVideo(id){if(!window.confirm('Render the video with the changed scene now?'))return;try{const j=await apiJson(`/videos/${id}/render`,{method:'POST'},0);setError('');setSelected(null);setJob(j);setBusy(true);setTab('create');await refresh();await refreshStats();poll(j.jobId);}catch(e){setError(`Render failed: ${e.message}`)}}
 async function cancelVideo(id){try{await apiJson(`/videos/${id}/cancel`,{method:'POST'});setError('');await refresh();await refreshStats();}catch(e){setError(`Cancel failed: ${e.message}`)}}
 async function deleteVideo(id){if(!window.confirm('Permanently delete this generated video, its media files, generation jobs and unused story data? This cannot be undone.'))return;try{await apiJson(`/videos/${id}`,{method:'DELETE'},2);setSelected(null);setError('');await refresh();await refreshStats();}catch(e){setError(`Delete failed: ${e.message}`)}}
 async function openVideo(id,startTab='overview'){try{const j=await apiJson(`/videos/${id}`);setSelected(j);setDetailTab(startTab);setVisualChecks({imagesMatch:!!j.visualReview?.imagesMatch,subtitlesReadable:!!j.visualReview?.subtitlesReadable,ageAppropriate:!!j.visualReview?.ageAppropriate});setError('');}catch(e){setError(`Failed to load video: ${e.message}`)}}
 async function refreshSelected(){if(selected?._id)await openVideo(selected._id,detailTab);await refresh();await refreshStats();}
 async function rerunQA(){if(!selected?._id)return;setQaBusy(true);try{await apiJson(`/videos/${selected._id}/qa`,{method:'POST'});await refreshSelected();}catch(e){setError(`QA failed: ${e.message}`)}finally{setQaBusy(false)}}
 async function regenerateScene(sceneNumber){if(!selected?._id)return;if(!window.confirm(`Regenerate only scene ${sceneNumber}? Other images and narration will be reused, then the video will be re-rendered.`))return;setQaBusy(true);try{const j=await apiJson(`/videos/${selected._id}/scenes/${sceneNumber}/regenerate`,{method:'POST'});setError('');setSelected(null);setBusy(true);setJob(j);setTab('create');poll(j.jobId);}catch(e){setError(`Scene regeneration failed: ${e.message}`);setQaBusy(false)}}
 async function rebuildImages(){if(!selected?._id)return;if(!window.confirm(`Re-plan all ${(selected.storyId?.scenes||[]).length} scenes from the narration and make new images, then re-render?`))return;setQaBusy(true);try{const j=await apiJson(`/videos/${selected._id}/rebuild-images`,json('POST',{replan:true}),0);setError('');setSelected(null);setBusy(true);setJob(j);setTab('create');poll(j.jobId);}catch(e){setError(`Rebuild failed: ${e.message}`);setQaBusy(false)}}
 async function rerenderOnly(){if(!selected?._id)return;setQaBusy(true);try{const j=await apiJson(`/videos/${selected._id}/rerender`,{method:'POST'});setError('');setSelected(null);setBusy(true);setJob(j);setTab('create');poll(j.jobId);}catch(e){setError(`Re-render failed: ${e.message}`);setQaBusy(false)}}
 async function saveVisualReview(){if(!selected?._id)return;try{await apiJson(`/videos/${selected._id}/visual-review`,json('POST',visualChecks));await refreshSelected();}catch(e){setError(`Visual review not saved: ${e.message}`)}}

 useEffect(()=>{checkBackend();refresh();refreshStats();refreshActive();loadAI();loadSeries(true);},[]);
 // Poll videos/stats, and keep retrying settings/profiles until they have loaded
 // (they used to load only once, so a backend restart left Settings stuck on "Loading").
 const aiRef=useRef(null),seriesLoadedRef=useRef(false);aiRef.current=ai;seriesLoadedRef.current=seriesLoaded;
 filterRef.current=filter;profileFilterRef.current=profileFilter;
 useEffect(()=>{const timer=setInterval(()=>{checkBackend();refresh();refreshStats();refreshActive();if(!aiRef.current)loadAI();if(!seriesLoadedRef.current)loadSeries(true);},3000);return()=>clearInterval(timer)},[filter]);
 const prevBackend=useRef(backendStatus);
 useEffect(()=>{if(prevBackend.current!=='online'&&backendStatus==='online'&&prevBackend.current!=='checking'){loadAI();loadSeries();refresh();refreshStats();}prevBackend.current=backendStatus;},[backendStatus]);
 useEffect(()=>{if(!selected)return;const onKey=e=>{if(e.key==='Escape')setSelected(null)};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[selected]);

 const providers=ai?.providers||{};
 const counts=stats?.stats||{};
 // The model / voice fields edit the provider picked with “Model” / “Voice” (default: the main one).
 const imageProvider=imageEdit||ai?.media?.imageProvider||'openai';
 const ttsProvider=ttsEdit||ai?.media?.ttsProvider||'groq';
 const imageModel=ai?.media?.imageModels?.[imageProvider]||ai?.media?.imageModel||'';
 const ttsModel=ai?.media?.ttsModels?.[ttsProvider]||ai?.media?.ttsModel||'';
 const ttsVoice=ai?.media?.ttsVoices&&ttsProvider in ai.media.ttsVoices?(ai.media.ttsVoices[ttsProvider]??''):(ai?.media?.ttsVoice||'');
 const imageSize=ai?.media?.imageSizes?.[imageProvider]||ai?.media?.imageSize||'';
 const imageSizeOptions={gemini:['1K','2K','4K'],openai:['1024x1024','1024x1536','1536x1024'],cloudflare:['1024x1024','1024x1536','1536x1024','1080x1920'],pollinations:['768x1344','1024x1792','1080x1920','1536x2048'],mock:['1080x1920']}[imageProvider]||['1080x1920'];
 const imageModelPresets={gemini:['gemini-nano-banana-2.1'],openai:['gpt-image-2'],cloudflare:['@cf/black-forest-labs/flux-1-schnell'],pollinations:['black-forest-labs/flux.1-schnell','google/gemini-nano-banana-2.1'],mock:['local']}[imageProvider]||[];
 const ttsModelPresets={azure:['neural'],google:['wavenet','standard','chirp3-hd'],elevenlabs:['eleven_multilingual_v2','eleven_flash_v2_5','eleven_v3'],aiawaaz:['mcp'],groq:['canopylabs/orpheus-v1-english'],openai:['gpt-4o-mini-tts'],gemini:['gemini-3.8-flash-tts','gemini-3.8-flash-lite-tts'],mock:['local']}[ttsProvider]||[];
 const ttsVoicePresets={azure:['hi-IN-SwaraNeural','hi-IN-MadhurNeural','hi-IN-AaravNeural','hi-IN-AnanyaNeural','hi-IN-KavyaNeural','hi-IN-KunalNeural','hi-IN-RehaanNeural','en-IN-NeerjaNeural','en-IN-PrabhatNeural'],google:['hi-IN-Wavenet-A','hi-IN-Wavenet-B','hi-IN-Wavenet-C','hi-IN-Wavenet-D','hi-IN-Standard-A','hi-IN-Standard-B','hi-IN-Standard-C','hi-IN-Standard-D','hi-IN-Neural2-A','hi-IN-Neural2-B','hi-IN-Chirp3-HD-Kore','hi-IN-Chirp3-HD-Puck'],gemini:['Kore','Zephyr','Puck','Charon','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat']}[ttsProvider]||[];
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
 const setU=(k,v)=>setSeriesForm(f=>({...f,upload:{...f.upload,[k]:v}}));
 const setAP=(k,v)=>setSeriesForm(f=>({...f,autopilot:{...f.autopilot,[k]:v}}));
 const [apStatus,setApStatus]=useState(null),[apMsg,setApMsg]=useState('');
 async function loadAutopilot(id=selectedSeriesId){if(!id)return;try{setApStatus(await apiJson(`/autopilot/${id}`,{},0));}catch(e){setApMsg(e.message)}}
 useEffect(()=>{setApStatus(null);setApMsg('');if(profileSection!=='autopilot'||!selectedSeriesId)return;loadAutopilot();const t=setInterval(()=>loadAutopilot(),30000);return()=>clearInterval(t);},[profileSection,selectedSeriesId]);
 async function autopilotMakeAnyway(runId){if(!window.confirm('Make a new video for this time now, even though the previous one is not published yet?'))return;try{await apiJson(`/autopilot/runs/${runId}/generate`,{method:'POST'},0);setApMsg('Making the new video.');await loadAutopilot();await refresh();}catch(e){setApMsg(e.message)}}
 async function autopilotRunNow(){if(!window.confirm('Make one automatic video now? If it passes the checks it is uploaded to YouTube as soon as it is ready, without review.'))return;try{await apiJson(`/autopilot/${selectedSeriesId}/run-now`,{method:'POST'},0);setApMsg('Started. It appears below and on the Create page.');await loadAutopilot();await refresh();}catch(e){setApMsg(e.message)}}
 // Per-profile YouTube connection (saved separately from the profile: the secret is write-only).
 const ytAcc={...EMPTY_YT_ACCOUNT,...(editSeries?.youtubeAccount||{})};
 const ytAccKey=`${selectedSeriesId}|${JSON.stringify(editSeries?.youtubeAccount||{})}`;
 useEffect(()=>{setYtForm({clientId:ytAcc.clientId||'',clientSecret:'',redirectUri:ytAcc.redirectUri||ytAcc.defaultRedirectUri||'',publishEnabled:Boolean(ytAcc.publishEnabled)});},[ytAccKey]);
 useEffect(()=>{setYtMsg('');setTgMsg('');setTgFound(null);setTgManual('');},[selectedSeriesId]);
 // Per-profile Telegram notifications (token is write-only, saved separately).
 const tgAcc={...EMPTY_TG,...(editSeries?.telegram||{})};
 const tgKey=`${selectedSeriesId}|${JSON.stringify(editSeries?.telegram||{})}`;
 useEffect(()=>{setTgForm({botToken:'',enabled:Boolean(tgAcc.enabled),commandsEnabled:Boolean(tgAcc.commandsEnabled),chats:tgAcc.chats||[],events:{...tgAcc.events},sendVideoOnReady:tgAcc.sendVideoOnReady!==false});},[tgKey]);
 const tgDirty=Boolean(selectedSeriesId)&&(Boolean(tgForm.botToken.trim())||tgForm.enabled!==Boolean(tgAcc.enabled)||tgForm.commandsEnabled!==Boolean(tgAcc.commandsEnabled)||tgForm.sendVideoOnReady!==(tgAcc.sendVideoOnReady!==false)||JSON.stringify(tgForm.chats)!==JSON.stringify(tgAcc.chats||[])||JSON.stringify(tgForm.events)!==JSON.stringify(tgAcc.events||{}));
 const tgSources=seriesList.filter(x=>String(x._id)!==String(selectedSeriesId)&&x.telegram?.hasToken);
 async function tgCall(path,opts,okMsg){setTgBusy(true);setTgMsg('');try{const j=await apiJson(`/telegram/${selectedSeriesId}${path}`,opts,0);if(okMsg)setTgMsg(typeof okMsg==='function'?okMsg(j):okMsg);return j;}catch(e){setTgMsg(e.message);return null;}finally{setTgBusy(false)}}
 async function saveTelegram(){const j=await tgCall('',json('PUT',{...tgForm,botToken:tgForm.botToken.trim()||undefined}),j=>`Telegram settings saved${j.botUsername?` for @${j.botUsername}`:''}.`);if(j)await loadSeries();}
 async function clearTelegramToken(){if(!window.confirm('Remove the bot token from this profile? Notifications stop until you add one again.'))return;const j=await tgCall('',json('PUT',{clearToken:true}),'Bot token removed.');if(j)await loadSeries();}
 async function copyTelegram(){if(!tgCopyFrom)return;const j=await tgCall(`/copy-from/${tgCopyFrom}`,{method:'POST'},'Bot and chats copied. Choose events, turn it on and save.');if(j){setTgCopyFrom('');await loadSeries();}}
 async function findTelegramChats(){const j=await tgCall('/detect-chats',{method:'POST'});if(j){setTgFound(j.chats||[]);if(!j.chats?.length)setTgMsg('No chats found. Open your bot in Telegram and send it any message (or add it to your group), then try again.');}}
 async function testTelegram(){await tgCall('/test',{method:'POST'},j=>{const r=j.results||[];const bad=r.filter(x=>!x.ok);return bad.length?`Test failed for ${bad.map(x=>`${x.chatId} (${x.error})`).join(', ')}`:`Test message sent to ${r.length} chat${r.length===1?'':'s'}.`;});await loadSeries();}
 const addTgChat=c=>setTgForm(f=>f.chats.some(x=>x.chatId===c.chatId)?f:{...f,chats:[...f.chats,c]});
 const ytDirty=Boolean(selectedSeriesId)&&(ytForm.clientId.trim()!==(ytAcc.clientId||'')||Boolean(ytForm.clientSecret.trim())||ytForm.redirectUri.trim()!==(ytAcc.redirectUri||'')||ytForm.publishEnabled!==Boolean(ytAcc.publishEnabled));
 async function saveYtAccount(){if(!selectedSeriesId)return;setYtBusy(true);setYtMsg('');try{const j=await apiJson(`/youtube/account/${selectedSeriesId}`,json('PUT',{clientId:ytForm.clientId,clientSecret:ytForm.clientSecret,redirectUri:ytForm.redirectUri,publishEnabled:ytForm.publishEnabled}),0);await loadSeries();setYtMsg(j.connected?'YouTube settings saved.':j.configured?'Saved. Now click "Connect channel" and sign in with this channel\'s Google account.':'Saved.');}catch(e){setYtMsg(`Not saved: ${e.message}`)}finally{setYtBusy(false)}}
 function connectYt(){if(!selectedSeriesId)return;setYtMsg('Finish signing in in the pop-up window…');window.open(`${API}/youtube/auth/${selectedSeriesId}`,'youtube-auth','width=520,height=700');}
 async function disconnectYt(){if(!selectedSeriesId||!window.confirm(`Disconnect "${ytAcc.channelTitle||'this channel'}" from the profile? Uploads will stop until you connect again.`))return;setYtBusy(true);try{await apiJson(`/youtube/account/${selectedSeriesId}/disconnect`,{method:'POST'},0);await loadSeries();setYtMsg('Channel disconnected.');}catch(e){setYtMsg(`Disconnect failed: ${e.message}`)}finally{setYtBusy(false)}}
 useEffect(()=>{const onMsg=e=>{if(e?.data?.type==='YOUTUBE_CONNECTED'){loadSeries();setYtMsg('YouTube channel connected.');}else if(e?.data?.type==='YOUTUBE_CONNECT_FAILED'){loadSeries();setYtMsg('YouTube connection failed — see the pop-up for details.');}};window.addEventListener('message',onMsg);return()=>window.removeEventListener('message',onMsg);},[]);
 const hindiTtsWarning=genProfile.language==='Hindi'&&ai?.media?.ttsHindi?.[ttsProvider]===false;
 // Trending topic ideas for a profile (Google Trends + YouTube trending, chosen by the AI to fit the channel).
 async function loadTrendIdeas(seriesId){if(!seriesId)return;setTrendBusy(true);setTrendMsg('');setTrendIdeas(null);try{const j=await apiJson(`/trends/${seriesId}?count=6`,{},0);setTrendIdeas(j);if(!j.ideas?.length)setTrendMsg('No trending topic fits this channel right now.');}catch(e){setTrendMsg(e.message)}finally{setTrendBusy(false)}}
 const NEW_TTS=['aiawaaz','azure','google','elevenlabs'];
 // Script AI keys (Settings → AI providers → "API keys for script providers").
 const textInfo=ai?.providers?.[textKeyProvider]||{};
 useEffect(()=>{setTextKeyForm({key:'',accountId:textInfo.accountId||'',baseUrl:textInfo.baseUrl||'',model:textInfo.model||''});},[textKeyProvider,JSON.stringify(textInfo)]);
 async function loadTextModels(){const p=textKeyProvider;setTextModelList({provider:p,models:[],msg:'Loading models…'});try{const j=await apiJson(`/ai/text-models/${p}`,{},0);setTextModelList({provider:p,models:j.models||[],msg:(j.models||[]).length?`${j.models.length} models available to your key. Pick one, then Save.`:'No chat models found for this key.'});}catch(e){const old=/Cannot GET|404|not found/i.test(e.message);setTextModelList({provider:p,models:[],msg:old?'⚠ The backend is still running the previous version — restart the app (stop-app.bat, then start-app.bat) and try again.':`⚠ ${e.message}`});setAiMsg(old?'Restart the app to load models (the backend is running the previous version).':`Could not load models: ${e.message}`);}}
 const priorityOrder=ai?.textPriority?.order||[];
 const usableOrder=priorityOrder.filter(id=>providers?.[id]?.configured);
 const otherProviders=Object.keys(ai?.providers||{}).filter(id=>!priorityOrder.includes(id));
 async function saveMediaPriority(type,body){setAiBusy(true);setAiMsg('');try{const j=await apiJson('/ai/media-priority',json('PUT',{type,...body}),0);setAi(j);}catch(e){setAiMsg(/Cannot PUT|404/i.test(e.message)?'Restart the app to use the priority list (the backend is running the previous version).':e.message)}finally{setAiBusy(false)}}
 async function saveTextPriority(body){setAiBusy(true);setAiMsg('');try{const j=await apiJson('/ai/text-priority',json('PUT',body),0);setAi(j);setAiMsg(body.order?'Order saved.':(body.fallbackEnabled?'Backup providers switched on.':'Backup providers switched off — only the first provider is used.'));}catch(e){setAiMsg(/Cannot PUT|404/i.test(e.message)?'Restart the app to use the priority list (the backend is running the previous version).':e.message)}finally{setAiBusy(false)}}
 function moveProvider(id,dir){const o=[...priorityOrder];const i=o.indexOf(id),j=i+dir;if(i<0||j<0||j>=o.length)return;[o[i],o[j]]=[o[j],o[i]];saveTextPriority({order:o});}
 function openTextKey(id){setProviderTab('script');setTextKeyProvider(id);setTimeout(()=>document.getElementById('text-keys')?.scrollIntoView({behavior:'smooth',block:'start'}),50);}
 async function saveTextKey(clear=false){const p=textKeyProvider;setAiBusy(true);setAiMsg('');try{let j=await apiJson('/ai/text-keys',json('PUT',clear?{provider:p,clear:true}:{provider:p,key:textKeyForm.key,...(textInfo.needsAccountId?{accountId:textKeyForm.accountId}:{}),...(textInfo.customBaseUrl?{baseUrl:textKeyForm.baseUrl}:{})}),0);if(!clear&&textKeyForm.model.trim()&&textKeyForm.model.trim()!==textInfo.model)j=await apiJson('/ai/config',json('PUT',{text:{models:{[p]:textKeyForm.model.trim()}}}),0);setAi(j);setAiMsg(clear?`${textInfo.name} key removed.`:`${textInfo.name} saved. Click “Test” to check it.`);}catch(e){setAiMsg(`Not saved: ${e.message}`)}finally{setAiBusy(false)}}
 useEffect(()=>{setTtsKeyForm({key:'',region:ai?.media?.ttsKeys?.azure?.region||'',url:ai?.media?.ttsKeys?.aiawaaz?.url||'',tool:ai?.media?.ttsKeys?.aiawaaz?.tool||'',enhance:Boolean(ai?.media?.ttsKeys?.aiawaaz?.enhance)});setTtsVoiceList(null);setTtsVoiceMsg('');},[keyProvider,JSON.stringify(ai?.media?.ttsKeys||{})]);
 async function saveTtsKey(clear=false){const p=keyProvider;const body={[p]:clear?{clear:true}:{key:ttsKeyForm.key,...(p==='azure'?{region:ttsKeyForm.region}:{}),...(p==='aiawaaz'?{url:ttsKeyForm.url,tool:ttsKeyForm.tool,enhance:ttsKeyForm.enhance}:{})}};setAiBusy(true);setAiMsg('');try{const j=await apiJson('/ai/tts-keys',json('PUT',body),0);setAi(j);setAiMsg(clear?'Key removed.':'Saved. Use “Test” to check it.');}catch(e){setAiMsg(`Not saved: ${e.message}`)}finally{setAiBusy(false)}}
 async function loadTtsVoices(){setTtsVoiceMsg('Loading…');setTtsVoiceList(null);try{const j=await apiJson(`/ai/tts-voices/${keyProvider}?language=hi`,{},0);setTtsVoiceList(j);setTtsVoiceMsg(keyProvider==='aiawaaz'?`Connected. Speech tool: ${j.ttsTool||'not found'}${j.voices?.length?` · ${j.voices.length} voices`:''}.`:`${(j.voices||[]).length} Hindi voices found.`);}catch(e){setTtsVoiceMsg(e.message)}}
 const rowHandlers={onRender:renderVideo,onOpen:(id,t)=>openVideo(id,t),onApprove:approve,onCancel:cancelVideo,onRetry:retryVideo,onDelete:deleteVideo};
 const byProfile=stats?.byProfile||{};
 // Profile filter chips: every saved profile, plus archived/deleted profiles that still have videos.
 const profileChips=[{id:'ALL',name:'All profiles',total:counts.total||0},...seriesList.map(x=>({id:String(x._id),name:x.name,total:byProfile[String(x._id)]?.total||0})),...Object.entries(byProfile).filter(([id])=>id!=='none'&&!seriesList.some(x=>String(x._id)===id)).map(([id,r])=>({id,name:r.name,total:r.total,archived:true})),...(byProfile.none?[{id:'none',name:'No profile',total:byProfile.none.total}]:[])];
 const statCard=(title,key,tone='')=><button className={`stat ${tone}`} onClick={()=>{if(key!=='RUNNING'){setFilter(key);filterRef.current=key;refresh(key);}setTab('videos')}}><small>{title}</small><strong>{key==='ALL'?(counts.total||0):key==='RUNNING'?(stats?.activeJobs||0):(counts[key]||0)}</strong></button>;
 const page=NAV.find(n=>n[0]===tab)||NAV[0];
 const awaiting=counts.AWAITING_APPROVAL||0;

 if(!auth.checked)return <div className="loginPage"><div className="loginCard"><span className="spinner"/> Connecting…</div></div>;
 if(auth.required&&!auth.loggedIn)return <LoginScreen locked={auth.locked} onLogin={()=>{setAuth(a=>({...a,loggedIn:true}));checkBackend();refresh();refreshStats();refreshActive();loadAI();loadSeries(true);}}/>;
 return <div className="app">
  <aside className="sidebar">
   <div className="brand"><div className="logo">AI</div><div><b>AI Video Manager</b><small>Channel Studio</small></div></div>
   <nav>{NAV.map(([id,name])=><button key={id} className={`navItem ${tab===id?'active':''}`} onClick={()=>setTab(id)}><Icon name={id}/><span>{name}</span>{id==='videos'&&awaiting>0&&<em className="navBadge">{awaiting}</em>}</button>)}</nav>
   <div className="sideFooter">
     <div className={`backendPill ${backendStatus}`}><i/>{backendStatus==='online'?'Backend online':backendStatus==='checking'?'Connecting…':'Backend offline'}</div>
     {auth.required&&<button className="ghost small logoutBtn" onClick={logout}>Sign out{auth.username?` (${auth.username})`:''}</button>}
     <small className="muted">Default profile</small>
     <b className="sideProfile">{defaultSeries?.name||'None yet'}</b>
   </div>
  </aside>
  <main>
   <header className="topbar"><div><h1>{page[1]}</h1><p className="muted">{page[2]}</p></div>
     <div className="topActions">{tab!=='create'&&<button onClick={()=>setTab('create')} disabled={busy}>{busy?'Generating…':'+ New video'}</button>}</div>
   </header>
   {backendStatus==='offline'&&<div className="banner warn"><div><strong>Backend API is offline</strong><small>Expected at 127.0.0.1:4000 · retrying automatically.</small></div><button className="ghost" onClick={()=>{checkBackend();refresh();refreshStats()}}>Retry now</button></div>}
   {restartNeeded&&<div className="banner warn restartBanner"><span>🔄 <b>Updates are installed but not running yet.</b> Restart the app to use them: run <code>stop-app.bat</code>, then <code>start-app.bat</code>. (Wait until no video is being made.)</span></div>}
   {error&&<div className="banner error"><span>{error}</span><button className="ghost" onClick={()=>setError('')}>Dismiss</button></div>}

   {tab==='create'&&<div className="createGrid">
     <div className="createMain">
      <Card eyebrow="STEP 1" title="Channel profile" actions={<><button className="ghost" onClick={()=>genSeriesId?editProfile(genSeriesId):newProfile()}>{genSeriesId?'Edit profile':'Create profile'}</button></>}>
        {!seriesLoaded?<p className="muted">Loading profiles…</p>:seriesList.length===0?<div className="empty"><p>No channel profile yet. A profile defines language, format, length, hook, tone, visuals and voice for every video.</p><div className="row"><button onClick={newProfile}>Create a profile</button><button className="ghost" onClick={seed}>Use starter profile</button></div></div>:<>
          <div className="profilePicker">{seriesList.map(s=><button key={s._id} className={`profileOption ${String(s._id)===String(genSeriesId)?'selected':''}`} onClick={()=>setGenSeriesId(String(s._id))}><b>{s.name}</b><small>{s.niche||'—'} · {formFromSeries(s).language}</small>{String(s._id)===defaultId&&<em>Default</em>}</button>)}</div>
          <ProfileChips form={genProfile}/>
          <p className="muted small">This video uses the <b>saved</b> profile exactly. To change language, format, length or hook, edit the profile.</p>
          {hindiTtsWarning&&<div className="banner warn inline">This profile is Hindi but the narration provider ({ai?.media?.ttsProviders?.[ttsProvider]?.name||ttsProvider}) is English only. Choose a 🇮🇳 Hindi provider (Azure, Google Cloud, AI Awaaz, Gemini…) in Settings → Providers.</div>}
        </>}
      </Card>
      <Card eyebrow="STEP 2" title="Topic (optional)">
        <textarea className="topicBox" rows="3" value={topicInput} onChange={e=>setTopicInput(e.target.value)} placeholder={`Describe what this video should be about… Leave empty to use the profile's topic source (${({'queue-then-trending':'topic queue, then today\'s trends','trending':'today\'s trends','queue':'topic queue, then AI choice'})[genSeries?.channelProfile?.content?.topicSource||'queue-then-trending']}).`}/>
        <div className="row wrap"><button className="ghost" disabled={!genSeriesId||trendBusy} onClick={()=>loadTrendIdeas(genSeriesId)}>{trendBusy?'Checking trends…':'✨ Trending topic ideas'}</button></div>
        {trendMsg&&<div className="banner info inline">{trendMsg}</div>}
        {trendIdeas?.ideas?.length>0&&<div className="trendIdeas">{trendIdeas.ideas.map((t,i)=><button key={i} className="trendIdea" onClick={()=>setTopicInput(t.topic)}><b>{t.topic}</b><small>{t.trend&&t.trend!=='evergreen'?`📈 ${t.trend}`:'🌿 evergreen'}{t.angle?` · ${t.angle}`:''}</small></button>)}<small className="muted">Trends for {trendIdeas.region} from Google Trends{trendIdeas.trends?.youtube?.length?' and YouTube trending':''}. Click one to use it.{trendIdeas.errors?.length?` (${trendIdeas.errors.join('; ')})`:''}</small></div>}
        {(genSeries?.topicIdeas||[]).length>0&&<div className="topicIdeas"><small className="muted">Ideas from channel research</small><div>{genSeries.topicIdeas.slice(0,8).map((x,i)=><button key={i} className="ghost chipBtn" onClick={()=>setTopicInput(x)}>{x}</button>)}</div></div>}
        <div className="generateBar"><button className="primaryLg" onClick={generate} disabled={busy||!genSeriesId||backendStatus==='offline'}>{busy?'Generating…':'Generate video'}</button>{busy&&job&&['QUEUED','RUNNING'].includes(job.status)?<button className="ghost liveJump" onClick={()=>document.querySelector('.jobCard')?.scrollIntoView({behavior:'smooth',block:'start'})}><span className="spinner" aria-hidden="true"/>{jobTitle(job)} · {pct(job)}% — see progress ↓</button>:null}<span className="muted small">{genSeries?`${genSeries.name} · ${genProfile.durationSec}s ${genProfile.contentFormat} in ${genProfile.language}`:'Choose a profile first'}</span></div>
        {notice&&<div className="banner ok inline">{notice}</div>}
      </Card>
      {job&&<Card eyebrow="LIVE" title={jobTitle(job)} actions={<b className="bigPct">{pct(job)}%</b>} className="jobCard">
        <div className={`bar ${['QUEUED','RUNNING'].includes(job.status)?'moving':''}`}><i style={{width:`${Math.max(3,pct(job))}%`}}/></div>
        <LiveActivity job={job}/>
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
      <Card title="Recent videos" actions={<button className="ghost small" onClick={()=>{setFilter('ALL');filterRef.current='ALL';pickProfileFilter('ALL');setTab('videos')}}>All videos</button>}>
        <div className="videos">{videos.length===0?<p className="muted">No videos yet.</p>:videos.slice(0,5).map(v=><VideoRow key={v._id} v={v} compact {...rowHandlers}/>)}</div>
      </Card>
     </div>
   </div>}

   {tab==='videos'&&<div className="stack">
    {activeJobs.length>0&&<div className="banner info activeJobsBanner"><span>⏳ {activeJobs.length===1?'1 video is being made':`${activeJobs.length} videos are being made`}: {activeJobs.map(j=>`${j.video?.title||j.topic||j.profileName||'new video'} — ${jobTitle(j)} ${pct(j)}%`).join(' · ')}</span><button className="ghost" onClick={()=>setTab('create')}>Show progress</button></div>}
     <div className="statGrid wide">{statCard('Total','ALL')}{statCard('Active jobs','RUNNING')}{statCard('Awaiting approval','AWAITING_APPROVAL','accent')}{statCard('Published','PUBLISHED','good')}{statCard('Failed','FAILED','bad')}{statCard('Cancelled','CANCELLED')}</div>
     <Card actions={<button className="ghost" onClick={()=>{refresh();refreshStats()}}>Refresh</button>} title="All videos">
       <div className="profileFilter"><small className="eyebrow">PROFILE</small><div className="filterBar">{profileChips.map(p=><button key={p.id} className={profileFilter===p.id?'filterActive':'ghost'} onClick={()=>pickProfileFilter(p.id)} title={p.archived?'Archived or deleted profile':''}>{p.name}{p.archived?' (archived)':''} <span className="count">{p.total}</span></button>)}</div></div>
       <div className="filterBar">{VIDEO_STATUSES.map(s=><button key={s} className={filter===s?'filterActive':'ghost'} onClick={()=>{setFilter(s);filterRef.current=s;refresh(s)}}>{s==='ALL'?'All':label(s).toLowerCase()}{profileFilter!=='ALL'&&s!=='ALL'&&byProfile[profileFilter]?.[s]?<span className="count">{byProfile[profileFilter][s]}</span>:null}</button>)}</div>
       <div className="videos">{videos.length===0?<p className="muted">No videos match these filters.</p>:videos.map(v=><VideoRow key={v._id} v={v} {...rowHandlers}/>)}</div>
     </Card>
   </div>}

   {tab==='profiles'&&<div className="profilesGrid">
     <div className="profileList">
       <button className="newProfile" onClick={newProfile}>+ New profile</button>
       {seriesList.map(s=><button key={s._id} className={`profileItem ${String(s._id)===String(selectedSeriesId)?'selected':''}`} onClick={()=>editProfile(String(s._id))}><b>{s.name}</b><small>{s.niche||'—'} · {formFromSeries(s).language} · {formFromSeries(s).durationSec}s · {byProfile[String(s._id)]?.total||0} videos</small>{String(s._id)===defaultId&&<em>Default</em>}</button>)}
       {extraActive&&<p className="muted small">Several profiles were marked default by an older version. The most recently updated one is used. Click “Set as default” on the one you want to fix this.</p>}
       {seriesList.length===0&&<p className="muted small">{seriesLoaded?'No profiles yet.':'Loading profiles…'}</p>}
     </div>
     <div className="stack">
       <Card eyebrow={selectedSeriesId?'EDIT PROFILE':'NEW PROFILE'} title={seriesForm.name||'Untitled profile'} actions={<>{profileDirty&&<span className="dirty">Unsaved changes</span>}{selectedSeriesId&&(String(selectedSeriesId)!==defaultId||extraActive)&&<button className="ghost" onClick={()=>activateSeries()}>Set as default</button>}{selectedSeriesId&&<button className="ghost" onClick={duplicateProfile}>Duplicate</button>}{selectedSeriesId&&<button className="danger ghost" onClick={deleteProfile}>Delete</button>}<button onClick={saveSeries} disabled={!profileDirty&&Boolean(selectedSeriesId)}>Save profile</button></>}>
         <div className="profileTabs">{PROFILE_SECTIONS.map(([id,name])=><button key={id} className={profileSection===id?'active':''} onClick={()=>setProfileSection(id)}>{name}{id==='youtube'&&selectedSeriesId&&<span className={`miniDot ${ytAcc.connected?'ok':''}`}/>}{id==='autopilot'&&selectedSeriesId&&<span className={`miniDot ${editSeries?.autopilot?.enabled?'ok':''}`}/>}{id==='telegram'&&selectedSeriesId&&<span className={`miniDot ${tgAcc.enabled&&tgAcc.hasToken&&tgAcc.chats.length?'ok':''}`}/>}</button>)}</div>
         {profileSection==='channel'&&<>
         <div className="formSection"><h4>Identity</h4><div className="formGrid">
           <Field label="Channel name"><input value={seriesForm.name} onChange={e=>setF('name',e.target.value)} placeholder="e.g. Motivation Shorts Hindi"/></Field>
           <Field label="Niche"><input value={seriesForm.niche} onChange={e=>setF('niche',e.target.value)} placeholder="e.g. Motivation, technology, finance…"/></Field>
           <Field label="Premise" wide><textarea rows="2" value={seriesForm.premise} onChange={e=>setF('premise',e.target.value)} placeholder="What is this channel about, and what should every video deliver?"/></Field>
           <Field label="Target audience"><input value={seriesForm.targetAge} onChange={e=>setF('targetAge',e.target.value)} placeholder="e.g. Young adults 18–30"/></Field>
         </div></div>
         <div className="formSection"><h4>Every video</h4><p className="muted small">These are used for every generated video — no per-video overrides.</p><div className="formGrid four">
           <Field label="Language" hint={seriesForm.language==='Hindi'?(ai?.media?.ttsHindi?.[ttsProvider]===false?`⚠ Your narration provider (${ai?.media?.ttsProviders?.[ttsProvider]?.name||ttsProvider}) is English-only — choose a 🇮🇳 Hindi provider in Settings → Providers.`:`Narration: ${ai?.media?.ttsProviders?.[ttsProvider]?.name||ttsProvider} (speaks Hindi)`):''}><select value={seriesForm.language} onChange={e=>setF('language',e.target.value)}><option value="English">English</option><option value="Hindi">Hindi (हिन्दी)</option></select></Field>
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
         </>}
         {profileSection==='content'&&<>
         <div className="formSection"><h4>Content rules</h4><p className="muted small">Sent to the script AI with every video made with this profile.</p><div className="formGrid">
           <Field label="Call to action" hint="Spoken at the end of each video. Leave blank to let the AI decide." wide><input value={seriesForm.callToAction} onChange={e=>setF('callToAction',e.target.value)} placeholder="e.g. Follow for a new story every day"/></Field>
           <Field label="Creator rules" hint="One rule per line."><textarea rows="3" value={seriesForm.rules} onChange={e=>setF('rules',e.target.value)} placeholder={'Always end with a moral\nNo slang'}/></Field>
           <Field label="Never mention" hint="Topics or words to avoid, one per line."><textarea rows="3" value={seriesForm.avoidTopics} onChange={e=>setF('avoidTopics',e.target.value)} placeholder={'politics\ngraphic violence'}/></Field>
           <Field label="When no topic is typed" hint="Used by Create, Telegram /new and Autopilot."><select value={seriesForm.topicSource} onChange={e=>setF('topicSource',e.target.value)}><option value="queue-then-trending">Topic queue first, then today's trends</option><option value="trending">Always today's trends</option><option value="queue">Topic queue first, then AI choice (no trends)</option></select></Field>
           <Field label="Trends from" hint="Google Trends and YouTube trending region."><select value={seriesForm.trendRegion} onChange={e=>setF('trendRegion',e.target.value)}>{[['IN','India'],['US','United States'],['GB','United Kingdom'],['PK','Pakistan'],['BD','Bangladesh'],['NP','Nepal'],['AE','UAE'],['CA','Canada'],['AU','Australia']].map(([c,n])=><option key={c} value={c}>{n}</option>)}</select></Field>
           <Field label="Topic queue" hint={`Used in order when you generate without typing a topic. One per line.${splitLines(seriesForm.topicIdeas).length?` ${splitLines(seriesForm.topicIdeas).length} queued.`:''}`} wide><textarea rows="4" value={seriesForm.topicIdeas} onChange={e=>setF('topicIdeas',e.target.value)} placeholder={'The story of the honest woodcutter\nWhy Kalyug began'}/></Field>
         </div></div>
         </>}
         {profileSection==='voice'&&<>
         <div className="formSection"><h4>Captions & narration voice</h4><div className="formGrid four">
           <Field label="Captions"><select value={seriesForm.subtitles} onChange={e=>setF('subtitles',e.target.value)}><option value="default">Default ({ai?.video?.subtitlesEnabled===false?'off':'on'})</option><option value="on">Always on</option><option value="off">Off</option></select></Field>
           <Field label="Caption position"><select value={seriesForm.subtitlePosition} onChange={e=>setF('subtitlePosition',e.target.value)} disabled={seriesForm.subtitles==='off'}><option value="default">Default ({ai?.video?.subtitlePosition||'bottom'})</option><option value="bottom">Bottom</option><option value="center">Center</option><option value="top">Top</option></select></Field>
           <Field label={`Voice (${ai?.media?.ttsProviders?.[ttsProvider]?.name||ttsProvider})`} hint="Only for this profile. Each narration provider keeps its own choice." wide><select value={seriesForm.voices?.[ttsProvider]||''} onChange={e=>setF('voices',{...seriesForm.voices,[ttsProvider]:e.target.value})}><option value="">Settings default ({ttsVoice||'provider default'})</option>{[...new Set([seriesForm.voices?.[ttsProvider],...(VOICE_PRESETS[ttsProvider]||[])])].filter(Boolean).map(v=><option key={v} value={v}>{v}</option>)}</select></Field>
         </div></div>
         </>}
         {profileSection==='youtube'&&<>
         <div className="formSection"><h4>YouTube channel</h4>
           {!selectedSeriesId?<p className="muted small">Save this profile first, then connect its YouTube channel.</p>:<>
           <div className={`ytStatus ${ytAcc.connected?'ok':''}`}><span className="dot"/>{ytAcc.connected?<span>Connected to <b>{ytAcc.channelTitle||ytAcc.channelId}</b>{ytAcc.connectedAt?` · since ${new Date(ytAcc.connectedAt).toLocaleDateString()}`:''}{!ytAcc.publishEnabled&&' · uploads switched off'}</span>:ytAcc.configured?<span>OAuth client saved — not connected to a channel yet.</span>:<span>Not set up. Each profile uses its own Google OAuth client and channel.</span>}</div>
           <details className="howTo"><summary>How to get these values</summary><ol><li>Google Cloud Console → create or pick a project → <b>APIs & Services → Library</b> → enable <b>YouTube Data API v3</b>.</li><li><b>OAuth consent screen</b>: External; add the Google account that owns this channel as a test user.</li><li><b>Credentials → Create credentials → OAuth client ID → Web application</b>. Under <b>Authorized redirect URIs</b> add exactly: <code>{ytForm.redirectUri||ytAcc.defaultRedirectUri}</code></li><li>Paste the Client ID and Client secret here, save, then click <b>Connect channel</b> and sign in with the channel's account.</li></ol><p className="muted small">The client secret and the channel login are stored encrypted on this computer and are never shown again or included in exports.</p></details>
           <div className="formGrid">
             <Field label="OAuth Client ID"><input value={ytForm.clientId} onChange={e=>setYtForm(f=>({...f,clientId:e.target.value}))} placeholder="1234-abc.apps.googleusercontent.com" autoComplete="off" spellCheck={false}/></Field>
             <Field label="OAuth Client secret" hint={ytAcc.secretUnreadable?'⚠ The saved secret can no longer be read — enter it again.':ytAcc.hasClientSecret?'Saved. Leave blank to keep it.':''}><input type="password" value={ytForm.clientSecret} onChange={e=>setYtForm(f=>({...f,clientSecret:e.target.value}))} placeholder={ytAcc.hasClientSecret?'•••••••• saved':'GOCSPX-…'} autoComplete="new-password" spellCheck={false}/></Field>
             <Field label="Redirect URI" hint="Must match the one in Google Cloud exactly." wide><input value={ytForm.redirectUri} onChange={e=>setYtForm(f=>({...f,redirectUri:e.target.value}))} placeholder={ytAcc.defaultRedirectUri} spellCheck={false}/></Field>
           </div>
           <Toggle checked={ytForm.publishEnabled} onChange={v=>setYtForm(f=>({...f,publishEnabled:v}))} label="Allow uploads from this profile" hint="Off = the Upload button is blocked for this profile's videos."/>
           <div className="row wrap">
             <button onClick={saveYtAccount} disabled={ytBusy||!ytDirty}>Save YouTube settings</button>
             <button className="ghost" onClick={connectYt} disabled={ytBusy||ytDirty||!ytAcc.configured} title={ytDirty?'Save the YouTube settings first':!ytAcc.configured?'Add Client ID and secret first':''}>{ytAcc.connected?'Reconnect channel':'Connect channel'}</button>
             {ytAcc.connected&&<button className="danger ghost" onClick={disconnectYt} disabled={ytBusy}>Disconnect</button>}
           </div>
           {ytAcc.lastError&&<div className="videoError">{ytAcc.lastError}</div>}
           {ytMsg&&<div className="banner info inline">{ytMsg}</div>}
           </>}
         </div>
         <div className="formSection"><h4>YouTube upload</h4><p className="muted small">Defaults for uploading videos made with this profile. Nothing is uploaded automatically — you upload each approved video from its details, and can change these there.</p>
           <div className="formGrid four">
             <Field label="Visibility"><select value={seriesForm.upload.privacyStatus} onChange={e=>setU('privacyStatus',e.target.value)}><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select></Field>
             <Field label="Category"><select value={seriesForm.upload.categoryId} onChange={e=>setU('categoryId',e.target.value)}>{YT_CATEGORIES.map(([id,n])=><option key={id} value={id}>{n}</option>)}</select></Field>
             <Field label="Audience" hint="Required by YouTube (COPPA)."><select value={seriesForm.upload.madeForKids?'yes':'no'} onChange={e=>setU('madeForKids',e.target.value==='yes')}><option value="no">Not made for kids</option><option value="yes">Made for kids</option></select></Field>
             <Field label="License"><select value={seriesForm.upload.license} onChange={e=>setU('license',e.target.value)}><option value="youtube">Standard YouTube</option><option value="creativeCommon">Creative Commons</option></select></Field>
           </div>
           <div className="formGrid">
             <Field label="Title template" hint="{title} = generated title, {channel} = profile name. Max 100 characters."><input value={seriesForm.upload.titleTemplate} onChange={e=>setU('titleTemplate',e.target.value)} placeholder="{title} #shorts"/></Field>
             <Field label="Playlist ID" hint="Optional. From the playlist URL (list=…)."><input value={seriesForm.upload.playlistId} onChange={e=>setU('playlistId',e.target.value)} placeholder="PLxxxxxxxxxxxx"/></Field>
             <Field label="SEO keywords" hint="Comma separated. What this channel wants to rank for — the SEO AI uses them and they are added as tags." wide><input value={seriesForm.upload.seoKeywords} onChange={e=>setU('seoKeywords',e.target.value)} placeholder="hindi moral stories, kalyug kahani, motivational story"/></Field>
             <Field label="Default tags" hint="Comma separated. Added before the AI's SEO tags."><input value={seriesForm.upload.tags} onChange={e=>setU('tags',e.target.value)} placeholder="motivation, hindi story"/></Field>
             <Field label="Hashtags" hint="Added to the description."><input value={seriesForm.upload.hashtags} onChange={e=>setU('hashtags',e.target.value)} placeholder="#shorts #kalyug"/></Field>
             <Field label="Description footer" hint="Added under every description: links, credits, social handles." wide><textarea rows="3" value={seriesForm.upload.descriptionFooter} onChange={e=>setU('descriptionFooter',e.target.value)} placeholder="New story every day. Subscribe!"/></Field>
             <Field label="Daily publish time" hint="Optional. Lets you schedule an upload for the next slot."><input type="time" value={seriesForm.upload.scheduleTime} onChange={e=>setU('scheduleTime',e.target.value)}/></Field>
             <Field label="Time zone"><select value={seriesForm.upload.timezone} onChange={e=>setU('timezone',e.target.value)}>{[...new Set([seriesForm.upload.timezone,...TIMEZONES])].map(z=><option key={z}>{z}</option>)}</select></Field>
           </div>
           <div className="toggleGrid">
             <Toggle checked={seriesForm.upload.containsSyntheticMedia} onChange={v=>setU('containsSyntheticMedia',v)} label="Disclose AI-generated content" hint="YouTube's altered or synthetic content label."/>
             <Toggle checked={seriesForm.upload.notifySubscribers} onChange={v=>setU('notifySubscribers',v)} label="Notify subscribers" hint="When the video becomes public."/>
             <Toggle checked={seriesForm.upload.embeddable} onChange={v=>setU('embeddable',v)} label="Allow embedding"/>
             <Toggle checked={seriesForm.upload.publicStatsViewable} onChange={v=>setU('publicStatsViewable',v)} label="Show like count"/>
           </div>
         </div>
         </>}
         {profileSection==='autopilot'&&<>
         <div className="formSection"><h4>Autopilot — create & upload automatically</h4>
           <p className="muted small">At each time below, a video is made from this profile (topic queue first, otherwise the AI picks a topic), checked automatically, approved and uploaded to this profile's YouTube channel — scheduled to go public at that time. Fully automatic: videos that pass the checks are published without your review.</p>
           {selectedSeriesId&&apStatus&&<div className="apChecks">
             <div className={apStatus.youtube.ready?'ok':'bad'}>{apStatus.youtube.ready?'✓ YouTube connected and uploads allowed':`✗ YouTube not ready — ${apStatus.youtube.problems.join(' ')}`}</div>
             <div className={apStatus.telegram.on?'ok':'warn'}>{apStatus.telegram.on?'✓ Telegram alerts on':'! Recommended: turn on Telegram notifications to hear about problems'}</div>
           </div>}
           <Toggle checked={seriesForm.autopilot.enabled} onChange={v=>setAP('enabled',v)} label="Autopilot on" hint="Saved with Save profile. Runs while this app is running."/>
           <div className="formGrid">
             <Field label={`Publish times (${seriesForm.upload.timezone})`} hint="Lunchtime and evening are typical peak Shorts viewing times. Time zone is set in the YouTube tab." wide>
               <div className="timeList">{seriesForm.autopilot.times.map((t,i)=><span key={i} className="timeItem"><input type="time" value={t} onChange={e=>setAP('times',seriesForm.autopilot.times.map((x,j)=>j===i?e.target.value:x))}/>{seriesForm.autopilot.times.length>1&&<button className="ghost small" onClick={()=>setAP('times',seriesForm.autopilot.times.filter((_,j)=>j!==i))} aria-label="Remove time">✕</button>}</span>)}{seriesForm.autopilot.times.length<4&&<button className="ghost small" onClick={()=>setAP('times',[...seriesForm.autopilot.times,'21:00'])}>+ Add time</button>}</div>
             </Field>
             <Field label="Days" wide><div className="dayChips">{DAY_NAMES.map((d,i)=><button key={d} className={seriesForm.autopilot.days.includes(i)?'filterActive':'ghost'} onClick={()=>{const on=seriesForm.autopilot.days.includes(i);const next=on?seriesForm.autopilot.days.filter(x=>x!==i):[...seriesForm.autopilot.days,i].sort();if(next.length)setAP('days',next);}}>{d}</button>)}</div></Field>
             <Field label="Start making the video" hint="Before each time, so it is ready and scheduled in advance."><select value={seriesForm.autopilot.leadMinutes} onChange={e=>setAP('leadMinutes',Number(e.target.value))}>{[60,90,120,180,240].map(m=><option key={m} value={m}>{m>=120?`${m/60} hours`:`${m} minutes`} before</option>)}</select></Field>
             <Field label="Visibility" hint="Public videos are scheduled to go public exactly at the time."><select value={seriesForm.autopilot.visibility} onChange={e=>setAP('visibility',e.target.value)}><option value="public">Public (scheduled)</option><option value="unlisted">Unlisted</option><option value="private">Private</option></select></Field>
             <Field label="Minimum QA score to publish" hint="Below this the video waits for you instead."><input type="number" min="0" max="100" value={seriesForm.autopilot.minQaScore} onChange={e=>setAP('minQaScore',Number(e.target.value))}/></Field>
           </div>
           <Toggle checked={seriesForm.autopilot.blockStaleImages} onChange={v=>setAP('blockStaleImages',v)} label="Don't publish if an image may not match the narration" hint="The video waits for your review instead."/>
           <Toggle checked={seriesForm.autopilot.waitForPublish} onChange={v=>setAP('waitForPublish',v)} label="Wait until the previous video is published" hint="If a video is still waiting for approval (or not uploaded) at the next time, no new video is made; you get a Telegram message instead. Approve it and it is published at that time."/>
           {selectedSeriesId&&apStatus&&<>
             <h5 className="subHead">Next times</h5>
             <div className="tagList">{apStatus.settings.enabled?apStatus.nextSlots.map(d=><span key={d}>{new Date(d).toLocaleString(undefined,{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</span>):<span>Autopilot is off{seriesForm.autopilot.enabled?' (save the profile to turn it on)':''}</span>}</div>
             <h5 className="subHead">Recent automatic videos</h5>
             {apStatus.runs.length===0?<p className="muted small">None yet.</p>:<div className="apRuns">{apStatus.runs.map(r=><div key={r._id} className="apRun">
               <div><b>{new Date(r.slotAt).toLocaleString(undefined,{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</b>{r.manual&&<small className="muted"> · run now</small>}</div>
               <span className={`pill run-${r.status.toLowerCase()}`}>{RUN_LABEL[r.status]||r.status}</span>
               <small className="muted apLog">{r.error||r.log?.at(-1)?.message||''}</small>
               <div className="row">{r.status==='WAITING'&&r.waitingForVideoId&&<button className="ghost small" onClick={()=>openVideo(String(r.waitingForVideoId))}>Waiting for</button>}{r.status==='WAITING'&&<button className="ghost small" onClick={()=>autopilotMakeAnyway(String(r._id))}>Make new anyway</button>}{r.videoId&&<button className="ghost small" onClick={()=>openVideo(String(r.videoId))}>Video</button>}{r.youtubeVideoId&&<a className="btnLink" href={`https://youtu.be/${r.youtubeVideoId}`} target="_blank" rel="noreferrer">YouTube</a>}</div>
             </div>)}</div>}
             <div className="row wrap"><button className="ghost" onClick={autopilotRunNow} disabled={!apStatus.youtube.ready||profileDirty}>Run once now</button><button className="ghost" onClick={()=>loadAutopilot()}>Refresh</button></div>
           </>}
           {!selectedSeriesId&&<p className="muted small">Save this profile first.</p>}
           {apMsg&&<div className="banner info inline">{apMsg}</div>}
         </div>
         </>}
         {profileSection==='telegram'&&<>
         <div className="formSection"><h4>Telegram notifications</h4>
           {!selectedSeriesId?<p className="muted small">Save this profile first, then set up its Telegram notifications.</p>:<>
           <div className={`ytStatus ${tgAcc.enabled&&tgAcc.hasToken&&tgAcc.chats.length?'ok':''}`}><span className="dot"/>{tgAcc.hasToken?<span>Bot <b>@{tgAcc.botUsername||'saved'}</b> · {tgAcc.chats.length} chat{tgAcc.chats.length===1?'':'s'} · notifications {tgAcc.enabled?'on':'off'} · commands {tgAcc.commandsEnabled?'on':'off'}{tgAcc.lastSentAt?` · last sent ${timeAgo(tgAcc.lastSentAt)}`:''}</span>:<span>Not set up. Each profile can use its own bot and chats.</span>}</div>
           <details className="howTo"><summary>How to set up a bot</summary><ol><li>In Telegram, open <b>@BotFather</b>, send <code>/newbot</code> and follow the steps. Copy the token it gives you.</li><li>Paste the token below and click <b>Save Telegram settings</b>.</li><li>Open your new bot and send it any message — or add it to a group or channel where you want updates.</li><li>Click <b>Find my chats</b>, add the chat, turn notifications on and save. Use <b>Send test</b> to check.</li><li>To control videos from Telegram, also turn on <b>Allow commands</b> and send <code>/help</code> to the bot.</li></ol><p className="muted small">The token is stored encrypted on this computer and is never shown again or included in exports.</p></details>
           <div className="formGrid">
             <Field label="Bot token" hint={tgAcc.tokenUnreadable?'⚠ The saved token can no longer be read — enter it again.':tgAcc.hasToken?'Saved. Leave blank to keep it.':'From @BotFather.'}><input type="password" value={tgForm.botToken} onChange={e=>setTgForm(f=>({...f,botToken:e.target.value}))} placeholder={tgAcc.hasToken?'•••••••• saved':'123456789:AA…'} autoComplete="new-password" spellCheck={false}/></Field>
             {tgSources.length>0&&<Field label="…or use the bot of another profile"><div className="inlineForm"><select value={tgCopyFrom} onChange={e=>setTgCopyFrom(e.target.value)}><option value="">Choose profile</option>{tgSources.map(x=><option key={x._id} value={x._id}>{x.name}{x.telegram?.botUsername?` (@${x.telegram.botUsername})`:''}</option>)}</select><button className="ghost" onClick={copyTelegram} disabled={!tgCopyFrom||tgBusy}>Copy</button></div></Field>}
           </div>
           <div className="toggleGrid">
             <Toggle checked={tgForm.enabled} onChange={v=>setTgForm(f=>({...f,enabled:v}))} label="Send notifications for this profile" hint="Only videos made with this profile are reported here."/>
             <Toggle checked={tgForm.commandsEnabled} onChange={v=>setTgForm(f=>({...f,commandsEnabled:v}))} label="Allow commands from these chats" hint="/new, /recent, /pending, /status — then tap a video to approve, upload, schedule, continue, cancel or delete."/>
           </div>
           {tgForm.commandsEnabled&&<div className="banner info inline">Anyone in the chats below can control this profile's videos — in a group that means every member. Delete, approve and upload always ask for confirmation in the chat. The bot runs while this app is running.</div>}
           <h5 className="subHead">Chats</h5>
           {tgForm.chats.length===0?<p className="muted small">No chats yet.</p>:<div className="chatList">{tgForm.chats.map(c=><div key={c.chatId} className="chatRow"><span><b>{c.title||c.chatId}</b><small className="muted"> {c.type||'chat'} · {c.chatId}</small></span><button className="danger ghost small" onClick={()=>setTgForm(f=>({...f,chats:f.chats.filter(x=>x.chatId!==c.chatId)}))}>Remove</button></div>)}</div>}
           <div className="row wrap"><button className="ghost" onClick={findTelegramChats} disabled={tgBusy||!tgAcc.hasToken} title={tgAcc.hasToken?'':'Save the bot token first'}>Find my chats</button><input className="chatIdInput" value={tgManual} onChange={e=>setTgManual(e.target.value)} placeholder="or chat ID, e.g. -1001234567890"/><button className="ghost" disabled={!/^-?\d{3,20}$/.test(tgManual.trim())} onClick={()=>{addTgChat({chatId:tgManual.trim(),title:'',type:''});setTgManual('');}}>Add</button></div>
           {tgFound&&tgFound.length>0&&<div className="chatList found">{tgFound.map(c=><div key={c.chatId} className="chatRow"><span><b>{c.title}</b><small className="muted"> {c.type} · {c.chatId}</small></span>{tgForm.chats.some(x=>x.chatId===c.chatId)?<small className="muted">Added</small>:<button className="ghost small" onClick={()=>addTgChat(c)}>Add</button>}</div>)}</div>}
           <h5 className="subHead">Send updates for</h5>
           <div className="toggleGrid">{(tgAcc.eventCatalog||[]).map(ev=><Toggle key={ev.id} checked={Boolean(tgForm.events[ev.id])} onChange={v=>setTgForm(f=>({...f,events:{...f.events,[ev.id]:v}}))} label={`${ev.icon} ${ev.label}`}/>)}
             <Toggle checked={tgForm.sendVideoOnReady} onChange={v=>setTgForm(f=>({...f,sendVideoOnReady:v}))} label="Attach the video when it is ready" hint="Up to 50 MB (Telegram bot limit); otherwise a text message is sent."/></div>
           <div className="row wrap">
             <button onClick={saveTelegram} disabled={tgBusy||!tgDirty}>{tgBusy?'Working…':'Save Telegram settings'}</button>
             <button className="ghost" onClick={testTelegram} disabled={tgBusy||tgDirty||!tgAcc.hasToken||!tgAcc.chats.length} title={tgDirty?'Save first':''}>Send test</button>
             {tgAcc.hasToken&&<button className="danger ghost" onClick={clearTelegramToken} disabled={tgBusy}>Remove bot</button>}
           </div>
           {tgAcc.lastError&&<div className="videoError">Last error: {tgAcc.lastError}</div>}
           {tgMsg&&<div className="banner info inline">{tgMsg}</div>}
           </>}
         </div>
         </>}
         {researchMsg&&<div className="banner info inline">{researchMsg}</div>}
       </Card>
       {profileSection==='research'&&<Card eyebrow="CHANNEL RESEARCH" title="Learn from a YouTube channel">
         <p className="muted small">Paste a channel link. The agent studies its public signals and fills in this profile with an original strategy — it never copies videos, scripts or titles.</p>
         <div className="inlineForm"><input value={channelUrl} onChange={e=>setChannelUrl(e.target.value)} placeholder="https://www.youtube.com/@examplechannel"/><button onClick={studyChannel} disabled={researchBusy}>{researchBusy?'Studying…':'Study & fill profile'}</button></div>
         {(()=>{const r=pendingResearch?.research||editSeries?.channelResearch;const st=pendingResearch?.research?.strategy||editSeries?.contentStrategy;if(!r)return null;return <div className="researchResult">
           <div className="kvGrid"><div className="kv"><span>Channel</span><b>{r.raw?.channelTitle||'—'}</b></div><div className="kv"><span>Detected niche</span><b>{st?.niche||editSeries?.niche||'—'}</b></div><div className="kv"><span>Audience</span><b>{st?.audience||'—'}</b></div></div>
           {(st?.contentPillars||[]).length>0&&<div><small className="eyebrow">CONTENT PILLARS</small><div className="tagList">{st.contentPillars.map((x,i)=><span key={i}>{x}</span>)}</div></div>}
           {(editSeries?.topicIdeas||[]).length>0&&<div><small className="eyebrow">TOPIC IDEAS — click to use on Create</small><div className="topicIdeas"><div>{editSeries.topicIdeas.slice(0,12).map((x,i)=><button key={i} className="ghost chipBtn" onClick={()=>{setTopicInput(x);setGenSeriesId(String(editSeries._id));setTab('create')}}>{x}</button>)}</div></div></div>}
           <details><summary>Recent channel videos studied</summary><div className="researchVideos">{(r.raw?.videos||[]).slice(0,12).map((v,i)=><div key={i}><b>{v.title}</b>{v.views!=null&&<small>{Number(v.views).toLocaleString()} views</small>}</div>)}</div></details>
         </div>})()}
       </Card>}
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
     <nav className="subNav">{[['providers','Providers'],['output','Video output'],['quality','Image quality & OCR'],['storage','Storage'],['site','Home page'],['advanced','Advanced']].map(([id,name])=><button key={id} className={settingsTab===id?'active':''} onClick={()=>setSettingsTab(id)}>{name}</button>)}</nav>
     <div className="stack">
      {aiMsg&&<div className="banner info">{aiMsg}{aiSavedAt&&<small className="muted"> · {aiSavedAt.toLocaleTimeString()}</small>}</div>}
      {!ai&&(aiError?<div className="banner error"><span>Couldn't load settings: {aiError}. Retrying automatically…</span><button className="ghost" onClick={loadAI}>Retry now</button></div>:<p className="muted">Loading settings…</p>)}
      {ai&&settingsTab==='providers'&&<>
        <div className="providerTabs" role="tablist">{[['script','✍️','Script AI',providers[ai.activeProvider]?.name,(ai.textPriority?.order||[]).filter(id=>providers[id]?.configured).length],['images','🖼','Scene images',ai.media?.imageProviders?.[ai.media?.imageProvider]?.name,(ai.imagePriority?.order||[]).filter(id=>ai.media?.imageProviders?.[id]?.configured).length],['voice','🎙','Narration',ai.media?.ttsProviders?.[ai.media?.ttsProvider]?.name,(ai.ttsPriority?.order||[]).filter(id=>ai.media?.ttsProviders?.[id]?.configured).length],['keys','🔑','API keys','Edit, replace or remove',0]].map(([id,icon,label,main,n])=><button key={id} role="tab" aria-selected={providerTab===id} className={`providerTab ${providerTab===id?'active':''}`} onClick={()=>setProviderTab(id)}><span className="ptIcon">{icon}</span><span className="ptText"><b>{label}</b><small>{id==='keys'?main:main?`Main: ${main}`:'Not set up'}{n>1?` · ${n-1} backup${n>2?'s':''}`:''}</small></span></button>)}</div>
        {providerTab==='script'&&<>
        <Card eyebrow="SCRIPT AI" title="Order of providers" actions={<span className="muted small">Main: <b>{providers[ai.activeProvider]?.name||'—'}</b></span>}>
          <p className="muted small">Scripts, script checks, image planning, SEO and trending topics use these providers <b>from top to bottom</b>. Use ↑ ↓ to change the order.</p>
          <PriorityList kind="text" items={providers} order={priorityOrder} fallbackEnabled={ai.textPriority?.fallbackEnabled} busy={aiBusy} results={testResults} onSave={saveTextPriority} onTest={testAI} onEdit={id=>id==='mock'?null:openTextKey(id)} editLabel={(id,p)=>id==='mock'?'—':p.configured?'Key / model':'Set up key'} describe={(id,p)=>`${p.model||''} · ${p.freeTier?'🆓 free tier':'💳 paid'}`} fallbackText="If a provider fails (busy, out of quota, retired model, bad answer), automatically try the next one"/>
        </Card>
        <Card eyebrow="SCRIPT AI" title="API keys & models">
          <div className="formSection flush" id="text-keys">
            <div className="profileTabs">{Object.entries(providers).filter(([id])=>id!=='mock').map(([id,p])=><button key={id} className={textKeyProvider===id?'active':''} onClick={()=>setTextKeyProvider(id)}>{p.name}<span className={`miniDot ${p.configured?'ok':''}`}/></button>)}</div>
            <p className="muted small">{textInfo.note}{textInfo.keyUrl?<> <a href={textInfo.keyUrl} target="_blank" rel="noreferrer">Get a key ↗</a></>:null}</p>
            <div className="formGrid">
              {!textInfo.keyOptional&&<Field label={textKeyProvider==='cloudflare'?'API token (not the Global API Key)':'API key'} hint={textInfo.hasKey?(textInfo.fromEnv?'Using the key from server/.env. Enter one to save it here instead.':'Saved (encrypted). Leave blank to keep it.'):'Stored encrypted on this computer; it is never shown again.'}><input type="password" autoComplete="new-password" value={textKeyForm.key} onChange={e=>setTextKeyForm(f=>({...f,key:e.target.value}))} placeholder={textInfo.hasKey?'•••••••• saved':'Paste key'}/></Field>}
              {textInfo.needsAccountId&&<Field label="Cloudflare account ID" hint="Dashboard → Workers AI → “Use REST API”. The token needs “Workers AI” permission."><input value={textKeyForm.accountId} onChange={e=>setTextKeyForm(f=>({...f,accountId:e.target.value}))} placeholder="32 letters/digits"/></Field>}
              {textInfo.customBaseUrl&&<Field label="Ollama address" hint="Install Ollama, then run “ollama pull llama3.1:8b”."><input value={textKeyForm.baseUrl} onChange={e=>setTextKeyForm(f=>({...f,baseUrl:e.target.value}))} placeholder="http://127.0.0.1:11434/v1"/></Field>}
              <Field label="Model" hint={textModelList.provider===textKeyProvider&&textModelList.msg?textModelList.msg:(textInfo.defaultModel?`Default: ${textInfo.defaultModel}. Providers retire models — use “Load models” to see the current ones.`:'Use “Load models” to see what your key can use.')}><div className="row nowrap"><input list="text-model-list" value={textKeyForm.model} onChange={e=>setTextKeyForm(f=>({...f,model:e.target.value}))} placeholder={textInfo.defaultModel||'model id'}/><button type="button" className="ghost" disabled={aiBusy||!textInfo.configured} onClick={loadTextModels}>Load models</button></div><datalist id="text-model-list">{(textModelList.provider===textKeyProvider?textModelList.models:[]).map(m=><option key={m} value={m}/>)}</datalist>{textModelList.provider===textKeyProvider&&textModelList.models.length>0&&<select className="modelPick" value="" onChange={e=>e.target.value&&setTextKeyForm(f=>({...f,model:e.target.value}))}><option value="">Choose from {textModelList.models.length} models…</option>{textModelList.models.map(m=><option key={m} value={m}>{m}{m===textInfo.model?' (current)':''}</option>)}</select>}</Field>
            </div>
            <div className="row wrap"><button onClick={()=>saveTextKey(false)} disabled={aiBusy||(!textKeyForm.key.trim()&&!textInfo.hasKey&&!textInfo.keyOptional)}>Save</button><button className="ghost" disabled={aiBusy||!textInfo.configured} onClick={()=>testAI(textKeyProvider)}>Test</button><button className="ghost" disabled={aiBusy||!textInfo.configured||ai.activeProvider===textKeyProvider} onClick={()=>chooseAI(textKeyProvider)}>{ai.activeProvider===textKeyProvider?'✓ Used for scripts':'Use for scripts'}</button>{textInfo.hasKey&&!textInfo.fromEnv&&<button className="ghost danger" disabled={aiBusy} onClick={()=>saveTextKey(true)}>Remove key</button>}</div>
            {testResults[`text:${textKeyProvider}`]&&(r=>r&&<div className={`prioResult ${r.pending?'pending':r.ok?'ok':'bad'}`}>{r.pending?<><span className="spinner" aria-hidden="true"/>Testing…</>:<>{r.ok?'✓':'✕'} {r.message}<em> · {new Date(r.at).toLocaleTimeString()}</em></>}</div>)(testResults[`text:${textKeyProvider}`])}
          </div>
          <p className="muted small">Model names, temperature and token limits are under Advanced.</p>
        </Card>
        </>}
        {providerTab==='keys'&&<Card eyebrow="ALL PROVIDERS" title="API keys" actions={<span className="muted small">Keys are stored encrypted and never shown</span>}>
          <p className="muted small">Every key the app uses, in one place. <b>Edit / replace</b> saves a new key over the old one (also over a key from the server’s .env). Then use <b>Test</b> to check it.</p>
          <ApiKeysPanel apiJson={apiJson} json={json} busy={aiBusy} results={testResults} onTest={(type,id)=>type==='text'?testAI(id):testMedia(type,id)} onSaved={setAi}/>
        </Card>}
        {providerTab==='images'&&<>
        <Card eyebrow="SCENE IMAGES" title="Order of providers" actions={<span className="muted small">Main: <b>{ai.media?.imageProviders?.[ai.media?.imageProvider]?.name||'—'}</b></span>}>
          <p className="muted small">Each scene image is made by the first provider; if it fails, the next one makes it. Use ↑ ↓ to change the order.</p>
          <PriorityList kind="image" items={ai.media?.imageProviders||{}} order={ai.imagePriority?.order||[ai.media?.imageProvider].filter(Boolean)} fallbackEnabled={ai.imagePriority?.fallbackEnabled} busy={aiBusy} results={testResults} onSave={b=>saveMediaPriority('image',b)} onTest={id=>testMedia('image',id)} onEdit={id=>{setImageEdit(id);setTimeout(()=>document.getElementById('image-model-edit')?.scrollIntoView({behavior:'smooth',block:'center'}),50);}} editLabel={()=> 'Model'} describe={(id,p)=>`${p.model||'local'} · ${p.freeTier?'🆓 free':'💳 paid'}`} fallbackText="If an image provider fails (error, quota, safety block), make that image with the next provider"/>
        </Card>
        <Card eyebrow="SCENE IMAGES" title="Model & size">
          <div className="formGrid" id="image-model-edit">
            <Field label={`Image model · ${imageProvider}`}><input list="image-model-presets" value={imageModel} onChange={e=>setAi(x=>({...x,media:{...x.media,imageModels:{...(x.media.imageModels||{}),[imageProvider]:e.target.value}}}))} placeholder="Enter or select model" disabled={imageProvider==='mock'}/><datalist id="image-model-presets">{imageModelPresets.map(m=><option key={m} value={m}/>)}</datalist></Field>
            <Field label={`Image size · ${imageProvider}`}><select value={imageSize} onChange={e=>setAi(x=>({...x,media:{...x.media,imageSizes:{...(x.media.imageSizes||{}),[imageProvider]:e.target.value},imageSize:e.target.value}}))}>{imageSizeOptions.map(x=><option key={x} value={x}>{x}</option>)}</select></Field>
          </div>
          <div className="row"><button onClick={()=>saveAIConfig({media:ai.media},`${ai.media?.imageProviders?.[imageProvider]?.name||imageProvider} image settings`)} disabled={aiBusy}>Save {ai.media?.imageProviders?.[imageProvider]?.name||imageProvider} settings</button>{imageEdit&&<button className="ghost" onClick={()=>setImageEdit(null)}>Back to main provider</button>}</div>
          {imageProvider==='cloudflare'&&<p className="muted small">Cloudflare FLUX gets short, purely descriptive prompts (it cannot follow "no text" instructions); OCR then checks every image.</p>}
        </Card>
        </>}
        {providerTab==='voice'&&<>
        <Card eyebrow="NARRATION" title="Order of providers" actions={<span className="muted small">Main: <b>{ai.media?.ttsProviders?.[ai.media?.ttsProvider]?.name||'—'}</b></span>}>
          <p className="muted small">A video is always narrated by <b>one</b> provider. If the first one fails, the <b>whole video</b> is re-recorded with the next one, so voices are never mixed.</p>
          <PriorityList kind="tts" items={ai.media?.ttsProviders||{}} order={ai.ttsPriority?.order||[ai.media?.ttsProvider].filter(Boolean)} fallbackEnabled={ai.ttsPriority?.fallbackEnabled} busy={aiBusy} results={testResults} onSave={b=>saveMediaPriority('tts',b)} onTest={id=>testMedia('tts',id)} onEdit={id=>{if(NEW_TTS.includes(id)&&!ai.media?.ttsProviders?.[id]?.configured){setKeyProvider(id);setTimeout(()=>document.getElementById('tts-keys')?.scrollIntoView({behavior:'smooth',block:'start'}),50);return;}setTtsEdit(id);if(NEW_TTS.includes(id))setKeyProvider(id);setTimeout(()=>document.getElementById('tts-voice-edit')?.scrollIntoView({behavior:'smooth',block:'center'}),50);}} editLabel={(id,p)=>NEW_TTS.includes(id)&&!p.configured?'Set up key':'Voice'} describe={(id,p)=>`${p.voice?`${p.voice} · `:''}${id==='mock'?'no audio':ai.media?.ttsHindi?.[id]?'🇮🇳 Hindi + English':'English only'}${p.freeNote?` · ${p.freeNote}`:''}`} fallbackText="If the narration provider fails, re-record the whole video with the next one"/>
        </Card>
        <Card eyebrow="NARRATION" title="Voice & keys">
          <div className="formGrid" id="tts-voice-edit">
            <Field label={`Voice model · ${ttsProvider}`}><input list="tts-model-presets" value={ttsModel} onChange={e=>setAi(x=>({...x,media:{...x.media,ttsModels:{...(x.media.ttsModels||{}),[ttsProvider]:e.target.value}}}))} placeholder="Enter or select model" disabled={ttsProvider==='mock'}/><datalist id="tts-model-presets">{ttsModelPresets.map(m=><option key={m} value={m}/>)}</datalist></Field>
            <Field label={`Voice · ${ttsProvider}`}><input list={ttsVoicePresets.length?'tts-voice-presets':undefined} value={ttsVoice} onChange={e=>setAi(x=>({...x,media:{...x.media,ttsVoices:{...(x.media.ttsVoices||{}),[ttsProvider]:e.target.value}}}))} placeholder="Enter voice" disabled={ttsProvider==='mock'}/>{ttsVoicePresets.length>0&&<datalist id="tts-voice-presets">{ttsVoicePresets.map(v=><option key={v} value={v}/>)}</datalist>}</Field>
          </div>
          <div className="row"><button onClick={()=>saveAIConfig({media:ai.media},`${ai.media?.ttsProviders?.[ttsProvider]?.name||ttsProvider} voice`)} disabled={aiBusy}>Save {ai.media?.ttsProviders?.[ttsProvider]?.name||ttsProvider} voice</button>{ttsEdit&&<button className="ghost" onClick={()=>setTtsEdit(null)}>Back to main provider</button>}</div>
          <div className="formSection" id="tts-keys"><h4>Keys for Hindi voice providers</h4>
            <div className="profileTabs">{NEW_TTS.map(id=><button key={id} className={keyProvider===id?'active':''} onClick={()=>setKeyProvider(id)}>{ai.media?.ttsProviders?.[id]?.name||id}<span className={`miniDot ${ai.media?.ttsKeys?.[id]?.hasKey?'ok':''}`}/></button>)}</div>
            <p className="muted small">{({azure:'Azure portal → create a “Speech” resource (Free F0 pricing tier) → Keys and Endpoint. Use region “centralindia” or the region shown there.',google:'Google Cloud console → enable “Cloud Text-to-Speech API” → Credentials → Create API key (restrict it to that API). Billing must be enabled on the project; WaveNet/Standard voices are free up to 4M characters a month.',elevenlabs:'elevenlabs.io → Profile → API keys. The free plan is non-commercial and requires attribution — use a paid plan for a monetized channel.',aiawaaz:'AI Awaaz → “Advanced: connect with a key” → enter a key name (e.g. YouTube AI Agent) → Make a key, and paste it here (with or without “Bearer”). Narration uses the generate_speech tool; it uses your AI Awaaz characters.'})[keyProvider]}</p>
            <div className="formGrid">
              <Field label="API key" hint={ai.media?.ttsKeys?.[keyProvider]?.hasKey?(ai.media.ttsKeys[keyProvider].fromEnv?'Using the key from server/.env. Enter one to save it here instead.':'Saved (encrypted). Leave blank to keep it.'):'Stored encrypted on this computer.'}><input type="password" autoComplete="new-password" value={ttsKeyForm.key} onChange={e=>setTtsKeyForm(f=>({...f,key:e.target.value}))} placeholder={ai.media?.ttsKeys?.[keyProvider]?.hasKey?'•••••••• saved':'Paste key'}/></Field>
              {keyProvider==='azure'&&<Field label="Region"><input value={ttsKeyForm.region} onChange={e=>setTtsKeyForm(f=>({...f,region:e.target.value}))} placeholder="centralindia"/></Field>}
              {keyProvider==='aiawaaz'&&<Field label="MCP server URL"><input value={ttsKeyForm.url} onChange={e=>setTtsKeyForm(f=>({...f,url:e.target.value}))} placeholder="https://app.aiawaaz.io/api/mcp"/></Field>}
              {keyProvider==='aiawaaz'&&<Field label="Speech tool" hint="Leave blank to detect automatically."><input value={ttsKeyForm.tool} onChange={e=>setTtsKeyForm(f=>({...f,tool:e.target.value}))} placeholder="auto"/></Field>}
            </div>
            <div className="row wrap"><button onClick={()=>saveTtsKey(false)} disabled={aiBusy}>Save key</button>{ai.media?.ttsKeys?.[keyProvider]?.hasKey&&ttsProvider!==keyProvider&&<button className="ghost" onClick={()=>chooseMedia('tts',keyProvider)} disabled={aiBusy}>Use {ai.media?.ttsProviders?.[keyProvider]?.name} for narration</button>}<button className="ghost" onClick={()=>testMedia('tts',keyProvider)} disabled={aiBusy||!ai.media?.ttsProviders?.[keyProvider]?.configured}>Test</button><button className="ghost" onClick={loadTtsVoices} disabled={!ai.media?.ttsKeys?.[keyProvider]?.hasKey}>{keyProvider==='aiawaaz'?'Connect & load voices':'Load Hindi voices'}</button>{ai.media?.ttsKeys?.[keyProvider]?.hasKey&&!ai.media.ttsKeys[keyProvider].fromEnv&&<button className="danger ghost" onClick={()=>saveTtsKey(true)} disabled={aiBusy}>Remove key</button>}</div>
            {(r=>r&&<div className={`prioResult ${r.pending?'pending':r.ok?'ok':'bad'}`}>{r.pending?<><span className="spinner" aria-hidden="true"/>Testing…</>:<>{r.ok?'✓':'✕'} {r.message}<em> · {new Date(r.at).toLocaleTimeString()}</em></>}</div>)(testResults[`tts:${keyProvider}`])}
            {ttsVoiceMsg&&<div className="banner info inline">{ttsVoiceMsg}</div>}
            {ttsVoiceList?.voices?.length>0&&<Field label="Pick a voice" hint="Then click Save at the top of this card."><select value={ai.media?.ttsVoices?.[keyProvider]||''} onChange={e=>setAi(x=>({...x,media:{...x.media,ttsVoices:{...(x.media.ttsVoices||{}),[keyProvider]:e.target.value}}}))}><option value="">— choose —</option>{[...new Map([...(ai.media?.ttsVoices?.[keyProvider]?[[ai.media.ttsVoices[keyProvider],{id:ai.media.ttsVoices[keyProvider],name:ai.media.ttsVoices[keyProvider]}]]:[]),...ttsVoiceList.voices.map(v=>[v.id,v])]).values()].map(v=><option key={v.id} value={v.id}>{v.name||v.id}</option>)}</select></Field>}
            {keyProvider==='aiawaaz'&&<Toggle checked={ttsKeyForm.enhance} onChange={v=>setTtsKeyForm(f=>({...f,enhance:v}))} label="Add emotions (V3 voices)" hint="Runs each scene through enhance_for_v3 (laughs, pauses…) before speaking. Only for V3 voices. Click Save key to apply."/>}
            {keyProvider==='aiawaaz'&&ttsVoiceList?.account&&<div className="kvGrid">{typeof ttsVoiceList.account==='object'?Object.entries(ttsVoiceList.account).filter(([,v])=>['string','number','boolean'].includes(typeof v)).slice(0,6).map(([k,v])=><div className="kv" key={k}><span>{k.replace(/_/g,' ')}</span><b>{String(v)}</b></div>):<div className="kv"><span>Account</span><b>{String(ttsVoiceList.account).slice(0,200)}</b></div>}</div>}
            {keyProvider==='aiawaaz'&&ttsVoiceList?.tools&&<details className="howTo"><summary>Tools offered by the server ({ttsVoiceList.tools.length})</summary><ul>{ttsVoiceList.tools.map(t=><li key={t.name}><b>{t.name}</b>{t.name===ttsVoiceList.ttsTool?' ← used for narration':''}<br/><small className="muted">{t.description} {t.arguments?.length?`(${t.arguments.join(', ')})`:''}</small></li>)}</ul></details>}
          </div>
          <p className="muted small">The selected provider is always used — there is no silent fallback. For Hindi channels choose a provider marked 🇮🇳; each profile can also pick its own voice.</p>
        </Card>
        </>}
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
            <Field label="Font" hint="Poppins Medium (built in) works for Hindi everywhere. Nirmala UI / Mangal only exist on Windows: on a Linux server they are replaced by Poppins Medium."><input list="font-presets" value={ai.video?.subtitleFontName||'Nirmala UI'} onChange={e=>setV('subtitleFontName',e.target.value)}/><datalist id="font-presets">{['Poppins Medium','Nirmala UI','Mangal','Arial','Segoe UI','Noto Sans Devanagari'].map(f=><option key={f} value={f}/>)}</datalist></Field>
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
      {settingsTab==='site'&&<SiteSettingsCard site={site} setSite={setSite} load={loadSite} save={saveSite} busy={siteBusy} msg={siteMsg}/>}
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
    <div className="detailHead"><div><small className="eyebrow">VIDEO DETAILS</small><h2>{selected.title}</h2><div className="detailMeta"><StatusPill status={selected.status}/>{selected.profile&&<span className={`profileTag ${selected.profile.archived?'archived':''}`}>{selected.profile.name}</span>}<span>Created {new Date(selected.createdAt).toLocaleString()}</span><span>Updated {new Date(selected.updatedAt).toLocaleString()}</span>{selected.qa?.score!=null&&<span>QA <b>{selected.qa.score}/100</b></span>}</div></div>
      <div className="row">{selected.status==='AWAITING_APPROVAL'&&<button onClick={()=>approve(selected._id)} disabled={!selected.visualReview?.reviewedAt} title={selected.visualReview?.reviewedAt?'':'Complete the visual review first (QA & review tab)'}>Approve</button>}{['FAILED','CANCELLED'].includes(selected.status)&&<button onClick={()=>retryVideo(selected._id)}>Continue</button>}{selected.status==='SCENE_REVIEW'&&<button onClick={()=>renderVideo(selected._id)}>Render video</button>}<button className="danger ghost" onClick={()=>deleteVideo(selected._id)}>Delete</button><button className="ghost" onClick={()=>setSelected(null)} aria-label="Close">✕</button></div>
    </div>
    {selected.error&&<div className="videoError">{selected.error}</div>}
    <div className="detailTabs">{[['overview','Overview'],['qa','QA & review'],['scenes','Scenes'],['youtube','YouTube'],['export','Logs & export'],['pipeline','Pipeline inspector']].map(([id,name])=><button key={id} className={detailTab===id?'active':''} onClick={()=>setDetailTab(id)}>{name}</button>)}</div>
    {detailTab==='overview'&&<div className="overviewGrid">
      <div className="playerWrap">{videoFileUrl(selected)?<video src={videoFileUrl(selected)} controls preload="metadata"/>:<div className="noVideo">No rendered video yet</div>}{videoFileUrl(selected)&&<a className="btnLink" href={videoFileUrl(selected)} target="_blank" rel="noreferrer">Open in new tab</a>}</div>
      <div className="stack">
        {(()=>{const history=(selected.statusHistory||[]).slice().sort((a,b)=>new Date(a.at||0)-new Date(b.at||0));const groups=history.reduce((m,x)=>{const k=Number(x.attempt||0);(m[k] ||= []).push(x);return m},{});return <><h4>Lifecycle history</h4><div className="historyGroups">{Object.entries(groups).sort(([a],[b])=>Number(b)-Number(a)).map(([attempt,items])=><div className="historyGroup" key={attempt}><div className="historyGroupTitle">Attempt #{Number(attempt)+1}</div><div className="history">{items.slice().reverse().map((x,i)=><div key={i}><b>{label(x.status)}</b><span>{x.message||''}</span><small>{x.at?new Date(x.at).toLocaleString():''}</small></div>)}</div></div>)}</div><h4>Generation attempts</h4><div className="history">{(selected.jobs||[]).map((j,i)=><div key={i}><b>Attempt #{(j.retryCount||0)+1} · {j.status} · {j.progress||0}%</b><span>{label(j.step)}{j.error?` · ${j.error}`:''}</span><small>{j.startedAt?new Date(j.startedAt).toLocaleString():new Date(j.createdAt).toLocaleString()}</small></div>)}</div></>})()}
      </div>
    </div>}
    {detailTab==='qa'&&<section className="qaPanel"><div className="sectionHead"><div><small className="eyebrow">RETENTION & QUALITY ENGINE</small><h4>Video QA Report</h4></div><button className="ghost" disabled={qaBusy||!selected.renderPath} onClick={rerunQA}>{qaBusy?'Checking…':'Run QA again'}</button></div>{Boolean(selected.qa && Array.isArray(selected.qa.checks))?<><div className="qaSummary"><strong>{selected.qa.score}/100</strong><span>{selected.qa.pass?'Technical checks passed':'Technical checks failed'}</span><small>{selected.qa.summary?.passed||0} passed · {selected.qa.summary?.warnings||0} warnings · {selected.qa.summary?.failures||0} failures{Number.isFinite(Number(selected.qa.retention?.score))?` · Retention ${selected.qa.retention.score}/100`:''}</small></div><div className="qaChecks">{(selected.qa.checks||[]).map((c,i)=><div className="qaCheck" key={`${c.name}-${i}`}><b className={`qaBadge ${String(c.status||'').toLowerCase()}`}>{c.status}</b><div><strong>{c.name}</strong><span>{c.message}</span>{c.audioIntelligence&&<AudioDetails data={c.audioIntelligence}/>}</div></div>)}</div></>:<p className="muted">No QA report yet. Run QA to inspect the rendered MP4.</p>}<div className="manualReview"><h4>Human visual review</h4><p className="muted">Automated checks cannot reliably judge story-image relevance or audience suitability. Watch the video before approving it.</p><label><input type="checkbox" checked={visualChecks.imagesMatch} onChange={e=>setVisualChecks(v=>({...v,imagesMatch:e.target.checked}))}/> Every image matches its narration and characters remain consistent</label><label><input type="checkbox" checked={visualChecks.subtitlesReadable} onChange={e=>setVisualChecks(v=>({...v,subtitlesReadable:e.target.checked}))}/> Subtitles are readable and do not hide important action</label><label><input type="checkbox" checked={visualChecks.ageAppropriate} onChange={e=>setVisualChecks(v=>({...v,ageAppropriate:e.target.checked}))}/> Story and visuals are suitable for the channel's intended audience</label><div className="row"><button onClick={saveVisualReview} disabled={!Object.values(visualChecks).every(Boolean)||selected.status!=='AWAITING_APPROVAL'}>Save visual review</button>{selected.visualReview?.reviewedAt&&<small className="muted">Reviewed {new Date(selected.visualReview.reviewedAt).toLocaleString()}</small>}</div></div></section>}
    {detailTab==='scenes'&&<section className="sceneReview"><div className="sectionHead"><div><small className="eyebrow">SELECTIVE REGENERATION</small><h4>Scene assets</h4></div><div className="row"><button className="ghost" disabled={qaBusy||!['AWAITING_APPROVAL','APPROVED','FAILED','CANCELLED','SCENE_REVIEW'].includes(selected.status)} onClick={rebuildImages}>Rebuild images to match narration</button><button className="ghost" disabled={qaBusy||!selected.renderPath} onClick={rerenderOnly}>Re-render video only</button></div></div><p className="muted">Regenerate a single image without regenerating narration or the other scene images.</p>{(selected.sceneAssets||[]).some(a=>a.stale)&&<div className="banner info inline">⚠ Scene {(selected.sceneAssets||[]).filter(a=>a.stale).map(a=>a.sceneNumber).join(', ')}: the image was made from an older description and may not match the narration. Use “Rebuild images to match narration” or regenerate those scenes.</div>}<div className="sceneReviewGrid">{(selected.storyId?.scenes||[]).map((scene,i)=>{const n=Number(scene.sceneNumber||i+1);const asset=(selected.sceneAssets||[]).find(x=>Number(x.sceneNumber)===n);return <article className="sceneReviewCard" key={n}>{asset?.fileName?<img src={`${STORAGE}/storage/videos/${selected._id}/scenes/${encodeURIComponent(asset.fileName)}`} alt={`Scene ${n}`} loading="lazy"/>:<div className="noImage">No image</div>}<div><b>Scene {n}{scene.durationSec?` · ${Number(scene.durationSec).toFixed(1)} s`:''}</b><p>{scene.narration||scene.visualPrompt||'No scene description available.'}</p>{(()=>{const meaning=selected.storyId?.pipelineData?.visualDirectorPlan?.scenes?.find(x=>Number(x.sceneNumber)===n)?.narrationMeaning;return meaning?<p className="sceneMeaning">Image should show: {meaning}</p>:null})()}{asset?.stale&&<p className="staleNote">⚠ Image may not match — made from an older description.</p>}{(asset?.prompt||asset?.currentPrompt)&&<details className="scenePrompt"><summary>{asset.prompt?(asset.reused?'Prompt this image was made from (reused from an earlier run)':'Image prompt sent to the model'):'Current scene description (origin of this image unknown)'}</summary><p>{asset.prompt||asset.currentPrompt}</p>{asset.imagePromptUsed&&asset.imagePromptUsed!==asset.prompt&&<p className="muted small">Text-free retry prompt actually used: {asset.imagePromptUsed}</p>}</details>}<button className="ghost" disabled={qaBusy||!['AWAITING_APPROVAL','APPROVED','FAILED','CANCELLED','SCENE_REVIEW'].includes(selected.status)} onClick={()=>regenerateScene(n)}>Regenerate image</button></div></article>})}</div></section>}
    {detailTab==='youtube'&&<YouTubePanel key={selected._id} video={selected} onDone={refreshSelected} onEditProfile={id=>{setSelected(null);editProfile(id);setProfileSection('youtube');}}/>}
    {detailTab==='export'&&<DiagnosticsExport selected={selected}/>}
    {detailTab==='pipeline'&&<><p className="muted">Complete step-by-step execution trace. Every stage keeps its INPUT, OUTPUT, META, timing and error data.</p><PipelineTrace job={selected.jobs?.[0]}/></>}
  </div></div>}
 </div>;
}

export default App;
