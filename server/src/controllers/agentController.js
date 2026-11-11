import {enqueueGeneration} from '../workers/queue.js';
import GenerationJob from '../models/GenerationJob.js';
import { getAISettings } from '../services/ai/index.js';
import Series from '../models/Series.js';
import {buildChannelProfile} from '../services/channelProfile.js';
export async function generateDaily(req,res,next){try{
  const series=req.body?.seriesId?await Series.findById(req.body.seriesId):await Series.findOne({active:true});
  if(!series)return res.status(400).json({error:'Select or create a channel profile before generating a video.'});
  const channelProfile=buildChannelProfile(series,{language:req.body?.language,audience:req.body?.audience});
  const settings=await getAISettings(); const job=await enqueueGeneration({
  topic:req.body?.topic||null,
  seriesId:series._id,
  aiProvider:settings.activeProvider,
  channelProfile,
  language:req.body?.language,
  format:req.body?.format,
  durationSec:Number(req.body?.durationSec)||undefined,
  hookStyle:req.body?.hookStyle,
  audience:req.body?.audience
});res.status(202).json({jobId:job._id,status:job.status});}catch(e){next(e);}}
export async function getStatus(req,res,next){try{const job=await GenerationJob.findById(req.params.id).populate('videoId');if(!job)return res.status(404).json({error:'Job not found'});res.json(job);}catch(e){next(e);}}
