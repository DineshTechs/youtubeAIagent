import Video from '../models/Video.js';
import path from 'node:path';
import GenerationJob from '../models/GenerationJob.js';
import {runVideoQualityAssurance} from '../services/video/qualityAssurance.js';
import { permanentlyDeleteVideo } from '../services/video/videoCleanup.js';

export async function listVideos(req,res,next){
  try{
    const limit=Math.min(Math.max(Number(req.query.limit)||50,1),100);
    const status=req.query.status;
    const filter=status&&status!=='ALL'?{status}:{};
    const videos=await Video.find(filter).sort({createdAt:-1}).limit(limit).lean();
    const ids=videos.map(v=>v._id);
    const jobs=ids.length?await GenerationJob.find({videoId:{$in:ids}}).sort({createdAt:-1}).lean():[];
    const latestJob=new Map();
    for(const job of jobs){const key=String(job.videoId);if(!latestJob.has(key))latestJob.set(key,job);}
    res.json(videos.map(v=>({...v,latestJob:latestJob.get(String(v._id))||null})));
  }catch(e){next(e);}
}

export async function getVideo(req,res,next){try{
  const v=await Video.findById(req.params.id).populate('storyId');
  if(!v)return res.status(404).json({error:'Video not found'});
  const jobs=await GenerationJob.find({videoId:v._id}).sort({createdAt:-1}).limit(10).lean();
  const data=v.toObject();
  const sceneAssets=(data.mediaAssetDetails||[]).map(asset=>({...asset,fileName:asset.path?path.basename(asset.path):null}));
  res.json({...data,sceneAssets,latestJob:jobs[0]||null,jobs});
}catch(e){next(e);}}

export async function approveVideo(req,res,next){try{
  const current=await Video.findById(req.params.id).lean();
  if(!current)return res.status(404).json({error:'Video not found'});
  if(['1.2','1.3','1.4','1.5.0'].includes(String(current.qa?.version))) {
    const review=current.visualReview||{};
    if(!current.qa.pass)return res.status(409).json({error:'Technical QA has failed. Run QA again or fix the reported issues before approval.'});
    if(!(review.imagesMatch&&review.subtitlesReadable&&review.ageAppropriate))return res.status(409).json({error:'Complete all three visual review checks before approving this video.'});
  }
  const v=await Video.findOneAndUpdate(
    {_id:req.params.id,status:'AWAITING_APPROVAL'},
    {$set:{status:'APPROVED'},$unset:{error:1},$push:{statusHistory:{status:'APPROVED',message:'Approved by user.',attempt:0,source:'VIDEO'}}},
    {returnDocument:'after'}
  );
  if(!v)return res.status(409).json({error:'Video is not awaiting approval or does not exist.'});
  res.json(v);
}catch(e){next(e);}}

export async function retryVideo(req,res,next){try{
  const video=await Video.findById(req.params.id).lean();
  if(!video)return res.status(404).json({error:'Video not found'});
  const existing=await GenerationJob.findOne({videoId:video._id,status:{$in:['QUEUED','RUNNING']}}).lean();
  if(existing)return res.status(409).json({error:'This video already has an active generation job.',jobId:existing._id});
  const previous=await GenerationJob.findOne({videoId:video._id}).sort({createdAt:-1}).lean();
  const retryCount=(previous?.retryCount??-1)+1;
  const queued=await Video.findOneAndUpdate(
    {_id:video._id,status:{$in:['FAILED','CANCELLED']}},
    {$set:{status:'QUEUED'},$unset:{error:1},$push:{statusHistory:{status:'QUEUED',message:`Resume attempt #${retryCount+1} queued.`,attempt:retryCount,source:'VIDEO'}}},
    {returnDocument:'after'}
  );
  if(!queued)return res.status(409).json({error:'Video state changed. Refresh and try Continue again.'});
  try{
    const job=await GenerationJob.create({
      type:'DAILY_SHORT_RESUME',status:'QUEUED',progress:0,step:'RESUME_QUEUED',videoId:video._id,
      retryCount,payload:{resumeVideoId:String(video._id),resume:true},
      logs:[{at:new Date(),message:`Resume attempt #${retryCount+1} queued from ${video.status}.`,level:'info'}]
    });
    res.status(202).json({jobId:job._id,status:job.status,videoId:video._id,retryCount:job.retryCount});
  }catch(e){
    await Video.findByIdAndUpdate(video._id,{$set:{status:video.status},$push:{statusHistory:{status:video.status,message:'Resume job creation failed; restored previous status.',attempt:retryCount,source:'VIDEO'}}});
    throw e;
  }
}catch(e){next(e);}}

async function queueResume(video, payload, message){
  const active=await GenerationJob.findOne({videoId:video._id,status:{$in:['QUEUED','RUNNING']}}).lean();
  if(active) throw Object.assign(new Error('This video already has an active generation job.'),{statusCode:409,jobId:active._id});
  const previous=await GenerationJob.findOne({videoId:video._id}).sort({createdAt:-1}).lean();
  const retryCount=(previous?.retryCount??-1)+1;
  const queued=await Video.findOneAndUpdate(
    {_id:video._id,status:{$in:['AWAITING_APPROVAL','APPROVED','FAILED','CANCELLED']}},
    {$set:{status:'QUEUED'},$unset:{error:1},$push:{statusHistory:{status:'QUEUED',message,attempt:retryCount,source:'VIDEO'}}},
    {returnDocument:'after'}
  );
  if(!queued) throw Object.assign(new Error('Video cannot be modified in its current state.'),{statusCode:409});
  try{
    const job=await GenerationJob.create({type:'DAILY_SHORT_RESUME',status:'QUEUED',progress:0,step:'RESUME_QUEUED',videoId:video._id,retryCount,payload:{resumeVideoId:String(video._id),resume:true,...payload},logs:[{at:new Date(),message,level:'info'}]});
    return job;
  }catch(error){
    await Video.findByIdAndUpdate(video._id,{$set:{status:video.status},$push:{statusHistory:{status:video.status,message:'Could not queue selective regeneration; restored previous status.',attempt:retryCount,source:'VIDEO'}}});
    throw error;
  }
}

export async function regenerateScene(req,res,next){try{
  const video=await Video.findById(req.params.id).populate('storyId');
  if(!video)return res.status(404).json({error:'Video not found'});
  const sceneNumber=Number(req.params.sceneNumber);
  const scenes=video.storyId?.scenes||[];
  if(!Number.isInteger(sceneNumber)||sceneNumber<1||sceneNumber>scenes.length)return res.status(400).json({error:`Scene number must be between 1 and ${scenes.length}.`});
  const job=await queueResume(video,{forceRegenerateSceneNumber:sceneNumber},`Selective regeneration queued for scene ${sceneNumber}. Other scene images and narration will be reused.`);
  res.status(202).json({ok:true,jobId:job._id,status:job.status,sceneNumber,message:'Only the selected scene image will be regenerated; the Short will then be re-rendered.'});
}catch(e){if(e.statusCode)return res.status(e.statusCode).json({error:e.message,jobId:e.jobId});next(e);}}

export async function rerenderVideo(req,res,next){try{
  const video=await Video.findById(req.params.id);
  if(!video)return res.status(404).json({error:'Video not found'});
  const job=await queueResume(video,{renderOnly:true},'Video re-render queued. Existing scene images and narration will be reused.');
  res.status(202).json({ok:true,jobId:job._id,status:job.status,message:'Existing images and narration will be reused; the video will be rendered again.'});
}catch(e){if(e.statusCode)return res.status(e.statusCode).json({error:e.message,jobId:e.jobId});next(e);}}

export async function markVisualReview(req,res,next){try{
  const {imagesMatch,subtitlesReadable,ageAppropriate}=req.body||{};
  const complete=imagesMatch===true&&subtitlesReadable===true&&ageAppropriate===true;
  if(!complete)return res.status(400).json({error:'Confirm image relevance, subtitle readability and age suitability.'});
  const video=await Video.findOneAndUpdate({_id:req.params.id,status:'AWAITING_APPROVAL'},{$set:{visualReview:{imagesMatch:true,subtitlesReadable:true,ageAppropriate:true,reviewedAt:new Date()}}},{returnDocument:'after'});
  if(!video)return res.status(409).json({error:'Video must be awaiting approval before visual review can be saved.'});
  res.json({ok:true,visualReview:video.visualReview});
}catch(e){next(e);}}

export async function rerunVideoQa(req,res,next){try{
  const video=await Video.findById(req.params.id).populate('storyId');
  if(!video)return res.status(404).json({error:'Video not found'});
  if(!video.renderPath)return res.status(409).json({error:'No rendered MP4 is available to inspect.'});
  const scenePaths=video.media?.scenes||video.mediaAssetDetails?.map(x=>x.path)||[];
  const report=await runVideoQualityAssurance({videoPath:video.renderPath,scenePaths,audioPath:video.media?.audio,subtitlePath:video.media?.subtitles,expectedDurationSec:video.durationSec,expectedSceneCount:video.storyId?.scenes?.length,sceneDurations:video.storyId?.scenes?.map(scene=>scene.durationSec),expectedOpeningHook:video.storyId?.hook||''});
  video.qa=report; video.visualReview={};
  if(report.pass && video.status==='FAILED') {
    video.status='AWAITING_APPROVAL';
    video.error=undefined;
    video.statusHistory.push({status:'AWAITING_APPROVAL',message:`Manual QA rerun passed technical checks (${report.score}/100). Visual review is required.`,attempt:0,source:'VIDEO'});
  }
  await video.save();
  res.json(report);
}catch(e){next(e);}}

export async function cancelVideo(req,res,next){try{
  const video=await Video.findById(req.params.id);
  if(!video)return res.status(404).json({error:'Video not found'});
  const job=await GenerationJob.findOne({videoId:video._id,status:{$in:['QUEUED','RUNNING']}}).sort({createdAt:-1});
  if(!job)return res.status(409).json({error:'No active generation job for this video.'});
  if(job.status==='QUEUED'){
    await GenerationJob.findByIdAndUpdate(job._id,{$set:{status:'CANCELLED',cancelRequested:true,cancelledAt:new Date(),completedAt:new Date(),step:'CANCELLED'},$push:{logs:{at:new Date(),message:'Cancelled before worker start.',level:'warning'}}});
    await Video.findByIdAndUpdate(video._id,{$set:{status:'CANCELLED'},$push:{statusHistory:{status:'CANCELLED',message:'Cancelled before worker start.',attempt:job?.retryCount||0,source:'VIDEO'}}});
    return res.json({ok:true,jobId:job._id,status:'CANCELLED'});
  }
  await GenerationJob.findByIdAndUpdate(job._id,{$set:{cancelRequested:true},$push:{logs:{at:new Date(),message:'Cancellation requested by user. Waiting for FFmpeg to stop safely.',level:'warning'}}});
  // Do not mark the video terminal while its worker/FFmpeg child is still running.
  // The worker changes Video and GenerationJob to CANCELLED after FFmpeg exits.
  res.json({ok:true,jobId:job._id,status:'CANCELLATION_REQUESTED',message:'Stopping current stage. Continue will become available once the worker has stopped.'});
}catch(e){next(e);}}


export async function deleteVideo(req,res,next){
  try{
    const result=await permanentlyDeleteVideo(req.params.id);
    if(!result.deleted)return res.status(404).json({error:'Video not found'});
    res.json({ok:true,...result});
  }catch(e){next(e);}
}

export async function getVideoStats(_req,res,next){try{
  const grouped=await Video.aggregate([{$group:{_id:'$status',count:{$sum:1}}}]);
  const stats={total:0};
  for(const x of grouped){stats[x._id]=x.count;stats.total+=x.count;}
  const activeJobs=await GenerationJob.countDocuments({status:{$in:['QUEUED','RUNNING']}});
  const failedJobs=await GenerationJob.countDocuments({status:'FAILED'});
  const cancelledJobs=await GenerationJob.countDocuments({status:'CANCELLED'});
  res.json({stats,activeJobs,failedJobs,cancelledJobs});
}catch(e){next(e);}}
