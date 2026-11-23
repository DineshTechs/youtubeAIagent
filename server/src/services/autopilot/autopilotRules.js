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
    blockStaleImages:a.blockStaleImages!==false
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
  if(video.status!=='AWAITING_APPROVAL')problems.push(`Video is ${video.status}, not awaiting approval.`);
  if(!video.qa||video.qa.pass!==true)problems.push('Technical QA did not pass.');
  const score=Number(video.qa?.score);
  if(Number.isFinite(score)&&score<settings.minQaScore)problems.push(`QA score ${score} is below the autopilot minimum ${settings.minQaScore}.`);
  if(settings.blockStaleImages){const stale=(video.mediaAssetDetails||[]).filter(a=>a.stale).map(a=>a.sceneNumber);if(stale.length)problems.push(`Scene ${stale.join(', ')} image may not match the narration.`);}
  if(!video.renderPath)problems.push('No rendered video file.');
  return problems;
}

// Upload timing: schedule for the slot (public at that time) when there is time,
// otherwise upload now with the autopilot visibility.
export function uploadRequest(slotAt,settings,now=new Date()){
  const slot=new Date(slotAt);
  if(settings.visibility==='public'&&slot.getTime()-now.getTime()>=10*60000)return {publishAt:slot.toISOString()};
  return {privacyStatus:settings.visibility};
}
