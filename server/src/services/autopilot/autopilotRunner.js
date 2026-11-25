// Autopilot loop (runs every minute in the API process, next to the worker):
//   due slot -> generate -> automatic checks -> approve -> upload (scheduled for the slot).
// All actions go through this app's own REST API, so the same rules apply as in the dashboard.
import Series from '../../models/Series.js';
import Video from '../../models/Video.js';
import GenerationJob from '../../models/GenerationJob.js';
import AutopilotRun from '../../models/AutopilotRun.js';
import {normalizeAutopilot,dueSlots,autopilotProblems,uploadRequest,pickBlocker,waitingDecision,waitingMessage,heldMessage,UNPUBLISHED_STATUSES,SKIPPABLE_STATUSES} from './autopilotRules.js';
import {internalApi} from '../telegram/botRunner.js';
import {notify} from '../telegram/notifier.js';
import {readiness} from '../youtube/youtubeAccount.js';

const MAX_GENERATION_ATTEMPTS=2, MAX_UPLOAD_ATTEMPTS=3, GENERATION_TIMEOUT_MS=4*3600*1000;
let timer=null,busy=false;
const settingsFor=s=>normalizeAutopilot(s.autopilot,{timezone:s.uploadSettings?.timezone});
const slotLabel=(d,tz)=>new Date(d).toLocaleString('en-IN',{timeZone:tz||'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'});

async function note(run,set,message){
  await AutopilotRun.updateOne({_id:run._id},{$set:set,...(message?{$push:{log:{$each:[{at:new Date(),message}],$slice:-50}}}:{})});
}
async function problem(run,series,status,message,{held=false}={}){
  await note(run,{status,error:message,nextActionAt:null},message);
  const videoId=run.videoId?String(run.videoId):undefined;
  // Held for review: buttons to approve or open it straight from the message.
  const buttons=held&&videoId?[[{text:'✅ Approve',callback_data:`p:${videoId}`},{text:'🎞 Open video',callback_data:`o:${videoId}`}],[{text:'⏭ Skip this video',callback_data:`s:${videoId}`},{text:'🗑 Delete',callback_data:`d:${videoId}`}]]:videoId?[[{text:'🎞 Open video',callback_data:`o:${videoId}`}]]:undefined;
  notify('autopilot',{profileId:String(series._id),profileName:series.name,videoId,title:held?`Autopilot: video held for review (${slotLabel(run.slotAt,series.uploadSettings?.timezone)})`:`Autopilot: slot ${slotLabel(run.slotAt,series.uploadSettings?.timezone)}`,message,buttons});
}

async function startGeneration(run,series){
  const j=await internalApi('POST','/agent/generate',{seriesId:String(series._id)});
  await note(run,{jobId:j.jobId,status:'GENERATING',nextActionAt:null},`Video generation started (job ${j.jobId}).`);
}

async function skipSlot(series,slotAt,message){
  try{await AutopilotRun.create({seriesId:series._id,slotAt,status:'SKIPPED',error:message,log:[{message}]});}
  catch(e){if(e?.code===11000)return;throw e;}
  notify('autopilot',{profileId:String(series._id),profileName:series.name,title:`Autopilot: slot ${slotLabel(slotAt,series.uploadSettings?.timezone)}`,message});
}

// ---- Waiting for the previous video to be published ----
async function blockerFor(seriesId,{excludeRunId}={}){
  const [videos,generatingRuns]=await Promise.all([
    Video.find({seriesId,status:{$in:UNPUBLISHED_STATUSES}}).select('title status createdAt renderPath skippedAt').lean(),
    AutopilotRun.find({seriesId,status:'GENERATING',...(excludeRunId?{_id:{$ne:excludeRunId}}:{})}).select('videoId').lean()
  ]);
  return pickBlocker({videos,generatingRuns});
}
// Videos another run is already publishing (so two slots never take the same video).
async function heldVideoIds(seriesId,exceptRunId){
  const runs=await AutopilotRun.find({seriesId,status:'APPROVED',videoId:{$ne:null},_id:{$ne:exceptRunId}}).select('videoId').lean();
  return runs.map(r=>String(r.videoId));
}
function waitingButtons(blocker,runId){
  const rows=[];
  if(blocker.videoId&&blocker.status==='AWAITING_APPROVAL')rows.push([{text:'✅ Approve',callback_data:`p:${blocker.videoId}`},{text:'🎞 Open video',callback_data:`o:${blocker.videoId}`}]);
  else if(blocker.videoId)rows.push([{text:'🎞 Open video',callback_data:`o:${blocker.videoId}`}]);
  if(blocker.videoId&&SKIPPABLE_STATUSES.includes(blocker.status))rows.push([{text:'⏭ Skip this video',callback_data:`s:${blocker.videoId}`},{text:'🗑 Delete',callback_data:`d:${blocker.videoId}`}]);
  rows.push([{text:'🆕 Make a new video anyway',callback_data:`w:${runId}`}]);
  return rows;
}
async function createWaitingRun(series,slotAt,blocker){
  const label=slotLabel(slotAt,series.uploadSettings?.timezone);
  // Already approved and nobody is publishing it: publish it in this slot (no new video).
  if(blocker.status==='APPROVED'&&blocker.videoId&&!(await heldVideoIds(series._id,null)).includes(blocker.videoId)){
    try{return await AutopilotRun.create({seriesId:series._id,slotAt,status:'APPROVED',videoId:blocker.videoId,log:[{message:`"${blocker.title}" is approved but not on YouTube yet, so it is published at ${label} instead of making a new video.`}]});}
    catch(e){if(e?.code===11000)return null;throw e;}
  }
  const message=waitingMessage(blocker,label);
  let run;
  try{run=await AutopilotRun.create({seriesId:series._id,slotAt,status:'WAITING',waitingForVideoId:blocker.videoId||null,error:null,log:[{message}]});}
  catch(e){if(e?.code===11000)return null;throw e;}
  notify('autopilot',{profileId:String(series._id),profileName:series.name,videoId:blocker.videoId||undefined,title:`Autopilot: waiting before ${label}`,message,buttons:waitingButtons(blocker,String(run._id))});
  return run;
}
async function advanceWaiting(run,series,settings,now){
  const blocker=await blockerFor(series._id,{excludeRunId:run._id});
  const d=waitingDecision({run,blocker,settings,now,heldVideoIds:await heldVideoIds(series._id,run._id)});
  if(d.action==='skip')return note(run,{status:'SKIPPED',error:d.message,waitingForVideoId:null,nextActionAt:null},d.message);
  if(d.action==='take')return note(run,{status:'APPROVED',videoId:d.videoId,waitingForVideoId:null,error:null,nextActionAt:null},d.message);
  if(d.action==='generate'){
    await note(run,{status:'GENERATING',waitingForVideoId:null,error:null},d.message);
    try{await startGeneration(run,series);}catch(e){await problem(run,series,'FAILED',`Could not start generation: ${e.message}`);}
    return;
  }
  if(String(d.videoId||'')!==String(run.waitingForVideoId||''))await note(run,{waitingForVideoId:d.videoId||null});
}
// "Make a new video anyway" (dashboard or Telegram) for a waiting slot.
export async function generateAnyway(runId){
  const run=await AutopilotRun.findById(runId).lean();
  if(!run)throw Object.assign(new Error('Autopilot slot not found.'),{status:404});
  if(run.status!=='WAITING')throw Object.assign(new Error(`This slot is ${String(run.status).toLowerCase().replace(/_/g,' ')}, not waiting.`),{status:409});
  const series=await Series.findById(run.seriesId).select('name autopilot uploadSettings').lean();
  if(!series)throw Object.assign(new Error('Profile not found.'),{status:404});
  await note(run,{status:'GENERATING',waitingForVideoId:null,error:null},'Making a new video anyway (asked by you), without waiting for the previous one.');
  await startGeneration(run,series);
  return {ok:true,runId:String(run._id)};
}

export async function createRun(series,slotAt,{manual=false}={}){
  let run;
  try{run=await AutopilotRun.create({seriesId:series._id,slotAt,manual,log:[{message:`${manual?'Manual run':'Slot'} for ${slotLabel(slotAt,series.uploadSettings?.timezone)} created.`}]});}
  catch(e){if(e?.code===11000)return null;throw e;}
  try{await startGeneration(run,series);}catch(e){await problem(run,series,'FAILED',`Could not start generation: ${e.message}`);}
  return run;
}

async function advanceGenerating(run,series,settings){
  const job=run.jobId?await GenerationJob.findById(run.jobId).lean():null;
  if(!job)return problem(run,series,'FAILED','Generation job is missing.');
  if(job.videoId&&String(job.videoId)!==String(run.videoId||''))await note(run,{videoId:job.videoId});
  const video=job.videoId?await Video.findById(job.videoId).lean():null;
  if(['QUEUED','RUNNING'].includes(job.status)){
    if(Date.now()-new Date(run.createdAt).getTime()>GENERATION_TIMEOUT_MS)return problem(run,series,'FAILED','Generation took longer than 4 hours.');
    return;
  }
  if(video?.status==='APPROVED')return note(run,{status:'APPROVED',nextActionAt:null},'Video was approved.');
  if(video?.status==='AWAITING_APPROVAL'){
    const issues=autopilotProblems(video,settings);
    if(issues.length)return problem(run,series,'NEEDS_ATTENTION',heldMessage(issues),{held:video.status==='AWAITING_APPROVAL'});
    await internalApi('POST',`/videos/${video._id}/visual-review`,{imagesMatch:true,subtitlesReadable:true,ageAppropriate:true});
    await internalApi('POST',`/videos/${video._id}/approve`);
    await Video.updateOne({_id:video._id},{$push:{statusHistory:{status:'APPROVED',message:`Approved automatically by Autopilot (QA ${video.qa?.score ?? 'n/a'}/100).`,at:new Date(),attempt:0,source:'AUTOPILOT'}}});
    return note(run,{status:'APPROVED',nextActionAt:null},`Passed automatic checks (QA ${video.qa?.score ?? 'n/a'}/100) and was approved.`);
  }
  // Failed or cancelled: one more attempt, then give up.
  if(job.status==='FAILED'||job.status==='CANCELLED'||['FAILED','CANCELLED'].includes(video?.status)){
    if(run.attempts>=MAX_GENERATION_ATTEMPTS)return problem(run,series,'FAILED',`Generation failed after ${run.attempts} attempts: ${job.error||video?.error||job.status}`);
    try{
      const r=video?await internalApi('POST',`/videos/${video._id}/retry`):await internalApi('POST','/agent/generate',{seriesId:String(series._id)});
      await note(run,{jobId:r.jobId,attempts:run.attempts+1},`Attempt ${run.attempts} failed (${String(job.error||video?.error||job.status).slice(0,200)}); retrying.`);
    }catch(e){return problem(run,series,'FAILED',`Retry failed: ${e.message}`);}
    return;
  }
  // Finished but in another state (e.g. waiting for scene review).
  if(job.status==='COMPLETED'&&video)return problem(run,series,'NEEDS_ATTENTION',heldMessage([`The video ended as "${String(video.status).toLowerCase().replace(/_/g,' ')}" instead of ready, so it needs your decision.`]));
}

async function advanceApproved(run,series,settings){
  const videoId=run.videoId;
  if(!videoId)return problem(run,series,'FAILED','No video to upload.');
  const body=run.manual?{privacyStatus:settings.visibility}:uploadRequest(run.slotAt,settings);
  try{
    const r=await internalApi('POST',`/youtube/publish/${videoId}`,body);
    await note(run,{status:r.status==='SCHEDULED'?'SCHEDULED':'PUBLISHED',youtubeVideoId:r.youtubeVideoId,error:null,nextActionAt:null},r.status==='SCHEDULED'?`Uploaded; goes public at ${slotLabel(run.slotAt,settings.timezone)} (${r.url}).`:`Uploaded as ${r.privacyStatus||body.privacyStatus} (${r.url}).`);
  }catch(e){
    const attempts=run.uploadAttempts+1;
    if(attempts>=MAX_UPLOAD_ATTEMPTS)return problem(run,series,'NEEDS_ATTENTION',`YouTube upload failed ${attempts} times: ${e.message}`);
    await note(run,{uploadAttempts:attempts,error:e.message,nextActionAt:new Date(Date.now()+10*60000)},`Upload attempt ${attempts} failed (${e.message}); retrying in 10 minutes.`);
  }
}

export async function tick(now=new Date()){
  if(busy)return;busy=true;
  try{
    const profiles=await Series.find({archived:{$ne:true},'autopilot.enabled':true}).select('name autopilot uploadSettings youtubeAccount').lean();
    for(const series of profiles){
      const settings=settingsFor(series);
      const yt=readiness(series.youtubeAccount);
      const ytReady=yt.configured&&yt.connected&&yt.publishEnabled;
      for(const slot of dueSlots(settings,now)){
        if(!ytReady){await skipSlot(series,slot,`Skipped: YouTube is not ready for this profile (${yt.problems.join(' ')})`).catch(()=>{});continue;}
        try{
          if(await AutopilotRun.exists({seriesId:series._id,slotAt:slot}))continue;
          if(settings.waitForPublish){
            const blocker=await blockerFor(series._id);
            if(blocker){await createWaitingRun(series,slot,blocker);continue;}
          }
          await createRun(series,slot);
        }catch(e){console.error('Autopilot create failed:',e.message);}
      }
    }
    const runs=await AutopilotRun.find({status:{$in:['WAITING','GENERATING','APPROVED']},$or:[{nextActionAt:null},{nextActionAt:{$lte:now}}]}).lean();
    for(const run of runs){
      try{
        const series=await Series.findById(run.seriesId).select('name autopilot uploadSettings archived').lean();
        if(!series||series.archived){await note(run,{status:'SKIPPED',error:'Profile was deleted.'},'Profile was deleted.');continue;}
        const settings=settingsFor(series);
        if(run.status==='WAITING')await advanceWaiting(run,series,settings,now);
        else if(run.status==='GENERATING')await advanceGenerating(run,series,settings);
        else if(run.status==='APPROVED')await advanceApproved(run,series,settings);
      }catch(e){console.error(`Autopilot run ${run._id} failed:`,e.message);await note(run,{error:e.message},`Error: ${e.message}`).catch(()=>{});}
    }
  }catch(e){console.error('Autopilot tick failed:',e.message);}
  finally{busy=false;}
}
export function startAutopilot(){if(timer)return;setTimeout(()=>tick(),15000);timer=setInterval(()=>tick(),60000);timer.unref?.();}
