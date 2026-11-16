import {enqueueGeneration} from '../workers/queue.js';
import GenerationJob from '../models/GenerationJob.js';
import { getAISettings } from '../services/ai/index.js';
import Series from '../models/Series.js';
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
  res.status(202).json({jobId:job._id,status:job.status,profile:{seriesId:series._id,name:series.name,language:channelProfile.language,format:channelProfile.content.primaryFormat,durationSec:channelProfile.content.durationSec,hookStyle:channelProfile.content.hookStyle}});
}catch(e){next(e);}}
export async function getStatus(req,res,next){try{const job=await GenerationJob.findById(req.params.id).populate('videoId');if(!job)return res.status(404).json({error:'Job not found'});res.json(job);}catch(e){next(e);}}
