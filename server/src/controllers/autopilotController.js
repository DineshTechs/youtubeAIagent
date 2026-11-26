import Series from '../models/Series.js';
import AutopilotRun from '../models/AutopilotRun.js';
import {normalizeAutopilot,nextSlots} from '../services/autopilot/autopilotRules.js';
import {createRun,generateAnyway} from '../services/autopilot/autopilotRunner.js';
import {readiness} from '../services/youtube/youtubeAccount.js';
import Video from '../models/Video.js';
import {slotSettingsFor,nextFreeSlot,formatWhen,parseWhen} from '../services/autopilot/publishSlots.js';

async function load(id){const s=/^[a-f0-9]{24}$/i.test(String(id))?await Series.findById(id).lean():null;return s&&!s.archived?s:null;}
export async function status(req,res,next){try{
  const s=await load(req.params.seriesId);if(!s)return res.status(404).json({error:'Channel profile not found.'});
  const settings=normalizeAutopilot(s.autopilot,{timezone:s.uploadSettings?.timezone});
  const yt=readiness(s.youtubeAccount);
  const runs=await AutopilotRun.find({seriesId:s._id}).sort({slotAt:-1}).limit(20).lean();
  res.json({settings,nextSlots:nextSlots(settings),youtube:{ready:yt.configured&&yt.connected&&yt.publishEnabled,problems:yt.problems},telegram:{on:Boolean(s.telegram?.enabled&&s.telegram?.chats?.length)},runs:runs.map(r=>({...r,log:(r.log||[]).slice(-8)}))});
}catch(e){next(e);}}
// Make one automatic video now (uploads as soon as it is ready and passes the checks).
export async function runNow(req,res,next){try{
  const s=await load(req.params.seriesId);if(!s)return res.status(404).json({error:'Channel profile not found.'});
  const yt=readiness(s.youtubeAccount);
  if(!(yt.configured&&yt.connected&&yt.publishEnabled))return res.status(409).json({error:`YouTube is not ready for this profile: ${yt.problems.join(' ')}`});
  const run=await createRun(s,new Date(),{manual:true});
  if(!run)return res.status(409).json({error:'A run was just created; try again in a minute.'});
  res.status(202).json({ok:true,runId:run._id});
}catch(e){next(e);}}

// One run (used by the Telegram bot to check which profile it belongs to).
export async function getRun(req,res,next){try{
  const run=/^[a-f0-9]{24}$/i.test(String(req.params.runId))?await AutopilotRun.findById(req.params.runId).select('seriesId slotAt status waitingForVideoId videoId error').lean():null;
  if(!run)return res.status(404).json({error:'Autopilot slot not found.'});
  res.json(run);
}catch(e){next(e);}}
// "Make a new video anyway" for a slot that is waiting for the previous video.
export async function makeAnyway(req,res){try{
  if(!/^[a-f0-9]{24}$/i.test(String(req.params.runId)))return res.status(404).json({error:'Autopilot slot not found.'});
  res.status(202).json(await generateAnyway(req.params.runId));
}catch(e){res.status(e.status||500).json({error:e.message});}}

// ---- Booking a publish time for a finished video ----
async function takenTimes(seriesId,now){
  const [runs,videos]=await Promise.all([
    AutopilotRun.find({seriesId,slotAt:{$gte:now},status:{$nin:['FAILED','SKIPPED']}}).select('slotAt').lean(),
    Video.find({seriesId,status:'SCHEDULED',scheduledAt:{$gte:now}}).select('scheduledAt').lean()
  ]);
  return [...runs.map(r=>r.slotAt),...videos.map(v=>v.scheduledAt)];
}
// GET /autopilot/:seriesId/next-slot → the next publish time nothing else uses.
export async function nextSlot(req,res,next){try{
  const s=await load(req.params.seriesId);if(!s)return res.status(404).json({error:'Channel profile not found.'});
  const settings=slotSettingsFor(s);const now=new Date();
  const slot=nextFreeSlot(settings,await takenTimes(s._id,now),now);
  if(!slot)return res.status(409).json({error:'No free publish time in the next few days. Pick a time instead.',timezone:settings.timezone});
  res.json({slotAt:slot.toISOString(),label:formatWhen(slot,settings.timezone),timezone:settings.timezone,times:settings.times});
}catch(e){next(e);}}
// POST /autopilot/book/:videoId {when:'next'} or {at:'27 Nov 18:30' | ISO}
// Books an approved video for that time: it is uploaded now and goes public then.
export async function bookVideo(req,res){try{
  const v=/^[a-f0-9]{24}$/i.test(String(req.params.videoId))?await Video.findById(req.params.videoId).select('title status seriesId').lean():null;
  if(!v)return res.status(404).json({error:'Video not found.'});
  if(v.status!=='APPROVED')return res.status(409).json({error:v.status==='AWAITING_APPROVAL'?'Approve the video first, then pick when it goes public.':`This video is ${String(v.status).toLowerCase().replace(/_/g,' ')}; only approved videos can be scheduled.`});
  const s=await load(v.seriesId);if(!s)return res.status(404).json({error:'Channel profile not found.'});
  const yt=readiness(s.youtubeAccount);
  if(!(yt.configured&&yt.connected&&yt.publishEnabled))return res.status(409).json({error:`YouTube is not ready for this profile: ${yt.problems.join(' ')}`});
  const settings=slotSettingsFor(s);const now=new Date();
  const taken=await takenTimes(s._id,now);
  let at;
  if(req.body?.when==='next'){at=nextFreeSlot(settings,taken,now);if(!at)return res.status(409).json({error:'No free publish time in the next few days. Pick a time instead.'});}
  else if(req.body?.at){const iso=new Date(req.body.at);const r=!Number.isNaN(iso.getTime())&&/\d{4}-\d{2}-\d{2}T/.test(String(req.body.at))?{at:iso}:parseWhen(req.body.at,settings.timezone,now);if(r.error)return res.status(400).json({error:r.error});at=r.at;}
  else return res.status(400).json({error:'Say when: {when:"next"} or {at:"27 Nov 18:30"}.'});
  if(at.getTime()<now.getTime()+10*60000)return res.status(400).json({error:'Pick a time at least 15 minutes from now.'});
  if(taken.some(t=>Math.abs(new Date(t).getTime()-at.getTime())<60000))return res.status(409).json({error:`${formatWhen(at,settings.timezone)} is already used by another video. Pick another time.`});
  const label=formatWhen(at,settings.timezone);
  try{await AutopilotRun.create({seriesId:s._id,slotAt:at,status:'APPROVED',videoId:v._id,booked:true,log:[{message:`Booked "${v.title}" to go public at ${label}.`}]});}
  catch(e){if(e?.code===11000)return res.status(409).json({error:`${label} is already used by another video. Pick another time.`});throw e;}
  res.status(201).json({ok:true,slotAt:at.toISOString(),label,timezone:settings.timezone});
}catch(e){res.status(e.status||500).json({error:e.message});}}
