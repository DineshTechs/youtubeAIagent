import {enqueueGeneration} from '../workers/queue.js';
import GenerationJob from '../models/GenerationJob.js';
import { getAISettings } from '../services/ai/index.js';
export async function generateDaily(req,res,next){try{const settings=await getAISettings(); const job=await enqueueGeneration({topic:req.body?.topic||null,seriesId:req.body?.seriesId||null,aiProvider:settings.activeProvider});res.status(202).json({jobId:job._id,status:job.status});}catch(e){next(e);}}
export async function getStatus(req,res,next){try{const job=await GenerationJob.findById(req.params.id).populate('videoId');if(!job)return res.status(404).json({error:'Job not found'});res.json(job);}catch(e){next(e);}}
