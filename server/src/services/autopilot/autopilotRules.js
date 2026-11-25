// Autopilot: create, check, approve and upload videos automatically at set times.
// Pure rules (no database) — see autopilotRunner.js for the loop.
import {zoned,zonedToUtc} from '../uploadSettings.js';

// Lunchtime and evening are typical peak Shorts viewing times in India; editable per profile.
export const DEFAULT_TIMES=['12:30','19:30'];
export const MAX_SLOTS_PER_DAY=4;
const validTime=v=>{const m=/^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v||'').trim());return m?`${m[1].padStart(2,'0')}:${m[2]}`:'';};
const validZone=z=>{try{new Intl.DateTimeFormat('en-US',{timeZone:z});return z;}catch{return '';}};
const clamp=(v,min,max,d)=>{const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.round(n))):d;};

export function normalizeAutopilot(raw={},{timezone='Asia/Kolkata'}={}){
  const a=raw&&typeof raw==='object'?raw:{};
  const times=[...new Set((Array.isArray(a.times)?a.times:DEFAULT_TIMES).map(validTime).filter(Boolean))].sort().slice(0,MAX_SLOTS_PER_DAY);
  const days=Array.isArray(a.days)?[...new Set(a.days.map(Number).filter(d=>Number.isInteger(d)&&d>=0&&d<=6))].sort():[0,1,2,3,4,5,6];
  return {
    enabled:a.enabled===true,
    times:times.length?times:[...DEFAULT_TIMES],
    days:days.length?days:[0,1,2,3,4,5,6],
    timezone:validZone(a.timezone)||validZone(timezone)||'Asia/Kolkata',
    leadMinutes:clamp(a.leadMinutes,30,360,90),      // start generating this long before the slot
    graceMinutes:clamp(a.graceMinutes,0,360,120),    // still make a slot this long after its time (e.g. app was off)
    minQaScore:clamp(a.minQaScore,0,100,70),
    visibility:['public','unlisted','private'].includes(a.visibility)?a.visibility:'public',
    blockStaleImages:a.blockStaleImages!==false,
    // Don't make a new video while the previous one is still not published.
    waitForPublish:a.waitForPublish!==false
  };
}

// Slot times (UTC Date) around `now`: yesterday, today and tomorrow in the profile's time zone.
export function slotsAround(settings,now=new Date()){
  const z=zoned(now,settings.timezone);const out=[];
  for(const add of [-1,0,1]){
    const base=new Date(Date.UTC(z.y,z.m-1,z.d+add));
    const weekday=base.getUTCDay();
    if(!settings.days.includes(weekday))continue;
    for(const t of settings.times){const [h,mi]=t.split(':').map(Number);out.push(zonedToUtc(base.getUTCFullYear(),base.getUTCMonth()+1,base.getUTCDate(),h,mi,settings.timezone));}
  }
  return out.sort((a,b)=>a-b);
}
// Slots whose generation window is open now.
export function dueSlots(settings,now=new Date()){
  return slotsAround(settings,now).filter(s=>s.getTime()-settings.leadMinutes*60000<=now.getTime()&&now.getTime()<=s.getTime()+settings.graceMinutes*60000);
}
export function nextSlots(settings,now=new Date(),count=4){
  const later=new Date(now.getTime()+2*86400000);
  const all=[...slotsAround(settings,now),...slotsAround(settings,later)].filter(s=>s>now).sort((a,b)=>a-b);
  return [...new Map(all.map(s=>[s.getTime(),s])).values()].slice(0,count);
}

// Automatic approval gate (on top of the app's own technical QA gate).
export function autopilotProblems(video,settings){
  const problems=[];
  if(!video)return ['Video not found.'];
  if(video.status!=='AWAITING_APPROVAL')problems.push(`The video is "${String(video.status).toLowerCase().replace(/_/g,' ')}", not ready for approval.`);
  const checks=Array.isArray(video.qa?.checks)?video.qa.checks:[];
  const named=list=>list.slice(0,4).map(c=>`${c.name}: ${c.message||c.status}`).join('; ');
  if(!video.qa)problems.push('No quality check (QA) report yet.');
  else if(video.qa.pass!==true){const fails=checks.filter(c=>c.status==='FAIL');problems.push(`Quality check failed${fails.length?` — ${named(fails)}`:''}.`);}
  const score=Number(video.qa?.score);
  if(Number.isFinite(score)&&score<settings.minQaScore){const warns=checks.filter(c=>c.status==='WARN');problems.push(`Quality score ${score} is below your Autopilot minimum of ${settings.minQaScore}${warns.length?` (warnings: ${named(warns)})`:''}.`);}
  if(settings.blockStaleImages){const stale=(video.mediaAssetDetails||[]).filter(a=>a.stale).map(a=>a.sceneNumber);if(stale.length)problems.push(`Scene ${stale.join(', ')} image may not match the narration.`);}
  if(!video.renderPath)problems.push('There is no finished video file.');
  return problems;
}

// Upload timing: schedule for the slot (public at that time) when there is time,
// otherwise upload now with the autopilot visibility.
export function uploadRequest(slotAt,settings,now=new Date()){
  const slot=new Date(slotAt);
  if(settings.visibility==='public'&&slot.getTime()-now.getTime()>=10*60000)return {publishAt:slot.toISOString()};
  return {privacyStatus:settings.visibility};
}

// ---- Waiting for the previous video ----------------------------------------
// A new slot does not start a new video while an earlier one of the same profile
// is not on YouTube yet. Once that one is approved, it is published in the waiting slot.
export const MAKING_STATUSES=['QUEUED','PLANNED','SCRIPT_GENERATED','SCRIPT_QA','ASSETS_GENERATING','VIDEO_RENDERING','VIDEO_QA'];
export const UNPUBLISHED_STATUSES=[...MAKING_STATUSES,'SCENE_REVIEW','AWAITING_APPROVAL','APPROVED','UPLOADING'];
const REASON={SCENE_REVIEW:'is waiting for you to finish the scene changes',AWAITING_APPROVAL:'is waiting for your approval',APPROVED:'is approved but not on YouTube yet',UPLOADING:'is still uploading'};
export function blockerReason(status){return MAKING_STATUSES.includes(status)?'is still being made':REASON[status]||`is ${String(status||'').toLowerCase().replace(/_/g,' ')}`;}
// videos: this profile's videos; generatingRuns: runs still GENERATING (a job may not have a video yet).
// A video whose file path belongs to the other kind of computer (a Windows "D:\…" path on
// the Linux server, or the reverse) was made elsewhere: this copy can't publish it, so it
// neither holds up nor gets taken by this copy's Autopilot.
export function madeElsewhere(renderPath,platform=process.platform){
  if(!renderPath)return false;
  return /^[A-Za-z]:[\\/]/.test(String(renderPath))!==(platform==='win32');
}
export function pickBlocker({videos=[],generatingRuns=[],platform=process.platform}={}){
  const open=videos.filter(v=>UNPUBLISHED_STATUSES.includes(v.status)&&!v.skippedAt&&!madeElsewhere(v.renderPath,platform)).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  if(open.length){const v=open[0];return {videoId:String(v._id),title:v.title||'Untitled video',status:v.status,reason:blockerReason(v.status),createdAt:v.createdAt};}
  const run=generatingRuns.find(r=>!r.videoId);
  if(run)return {videoId:null,runId:String(run._id),title:'The previous automatic video',status:'QUEUED',reason:'is still being made'};
  return null;
}
// What a waiting run should do now.
export function waitingDecision({run,blocker,settings,now=new Date(),heldVideoIds=[]}){
  if(!settings.enabled)return {action:'skip',message:'Autopilot was turned off.'};
  if(now.getTime()>new Date(run.slotAt).getTime()+settings.graceMinutes*60000)
    return {action:'skip',message:`Time passed while waiting: ${blocker?`"${blocker.title}" ${blocker.reason}`:'the previous video was not published'}. No new video was made.`};
  if(!blocker)return {action:'generate',message:'The previous video is published; making the new one.'};
  if(blocker.status==='APPROVED'&&blocker.videoId&&!heldVideoIds.includes(blocker.videoId))
    return {action:'take',videoId:blocker.videoId,message:`"${blocker.title}" was approved; it is published in this slot instead of making a new video.`};
  return {action:'wait',videoId:blocker.videoId};
}
export function waitingMessage(blocker,slotLabel){
  return `No new video for ${slotLabel}: "${blocker.title}" ${blocker.reason}. A new video is made only after the previous one is published.${blocker.status==='AWAITING_APPROVAL'||blocker.status==='APPROVED'?' Approve it and it is published at this time.':''}`;
}

// The Telegram text for a video Autopilot did not publish: every reason, then what to do.
export function heldMessage(issues){
  const list=issues.map(i=>`• ${i}`).join('\n');
  return `Not published automatically, because:\n${list}\n\nWatch it, then approve it to publish it at the next time (or fix the scenes first).`;
}

// Videos the user can skip (not approved / not wanted): Autopilot stops waiting for them.
export const SKIPPABLE_STATUSES=['SCENE_REVIEW','AWAITING_APPROVAL','APPROVED'];
