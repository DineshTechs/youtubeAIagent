import {enqueueGeneration} from '../workers/queue.js';
import GenerationJob from '../models/GenerationJob.js';
import { getAISettings } from '../services/ai/index.js';
import Series from '../models/Series.js';
import {notify} from '../services/telegram/notifier.js';
import {buildChannelProfile} from '../services/channelProfile.js';

// Generation follows the SAVED channel profile exactly. The request only picks
// which profile (seriesId; default = the active profile) and an optional topic.
// Language, format, duration, hook style, tone, audience, visuals and voice all
// come from the saved profile, so what you see on the profile is what you get.
export async function generateDaily(req,res,next){try{
  const series=req.body?.seriesId?await Series.findOne({_id:req.body.seriesId,archived:{$ne:true}}):await Series.findOne({active:true,archived:{$ne:true}}).sort({updatedAt:-1});
  if(!series)return res.status(400).json({error:'Select or create a channel profile before generating a video.'});
  const channelProfile=buildChannelProfile(series);
  const settings=await getAISettings();
  const job=await enqueueGeneration({
    topic:String(req.body?.topic||'').trim().slice(0,600)||null,
    seriesId:series._id,
    aiProvider:settings.activeProvider,
    channelProfile,
    // Snapshot of the profile values used, for traceability and resume.
    language:channelProfile.language,
    format:channelProfile.content.primaryFormat,
    durationSec:channelProfile.content.durationSec,
    hookStyle:channelProfile.content.hookStyle,
    audience:channelProfile.audience.description,
    profileSource:'saved-profile'
  });
  const queuedTopic=String(req.body?.topic||'').trim();
  notify('queued',{title:'New video',topic:queuedTopic||'Chosen by AI from the topic queue / niche',profileId:String(series._id),profileName:series.name,durationSec:channelProfile.content.durationSec});
  res.status(202).json({jobId:job._id,status:job.status,profile:{seriesId:series._id,name:series.name,language:channelProfile.language,format:channelProfile.content.primaryFormat,durationSec:channelProfile.content.durationSec,hookStyle:channelProfile.content.hookStyle}});
}catch(e){next(e);}}
export async function getStatus(req,res,next){try{const job=await GenerationJob.findById(req.params.id).populate('videoId');if(!job)return res.status(404).json({error:'Job not found'});res.json(job);}catch(e){next(e);}}

// Jobs that are queued or running right now (from the dashboard, Telegram or Autopilot),
// so the app can show their progress after a page reload.
export async function activeJobs(req,res,next){try{
  const jobs=await GenerationJob.find({status:{$in:['QUEUED','RUNNING']}}).sort({createdAt:1}).limit(10).populate('videoId','title status seriesId').lean();
  const seriesIds=[...new Set(jobs.map(j=>String(j.payload?.seriesId||j.videoId?.seriesId||'')).filter(Boolean))];
  const names=new Map((await Series.find({_id:{$in:seriesIds}}).select('name').lean()).map(s=>[String(s._id),s.name]));
  res.json(jobs.map(j=>({_id:j._id,status:j.status,step:j.step,progress:j.progress,createdAt:j.createdAt,startedAt:j.startedAt,lastHeartbeatAt:j.lastHeartbeatAt,topic:j.payload?.topic||null,profileName:names.get(String(j.payload?.seriesId||j.videoId?.seriesId||''))||null,video:j.videoId?{_id:j.videoId._id,title:j.videoId.title,status:j.videoId.status}:null,logs:(j.logs||[]).slice(-12)})));
}catch(e){next(e);}}
