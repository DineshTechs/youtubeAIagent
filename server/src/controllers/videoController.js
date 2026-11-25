import mongoose from 'mongoose';
import Video from '../models/Video.js';
import Story from '../models/Story.js';
import Series from '../models/Series.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import {getActiveProvider} from '../services/ai/index.js';
import {buildChannelProfile} from '../services/channelProfile.js';
import {validateEdit,rewriteSceneVisual,applySceneEdit} from '../services/sceneEdit.js';
import GenerationJob from '../models/GenerationJob.js';
import {runVideoQualityAssurance} from '../services/video/qualityAssurance.js';
import { permanentlyDeleteVideo } from '../services/video/videoCleanup.js';
import {approvalBlockReason} from '../utils/approvalGate.js';
import {notify} from '../services/telegram/notifier.js';
import {resolveVideoProfiles,profileVideoFilter,countByProfile} from '../services/videoProfiles.js';

const profileFilter=seriesId=>profileVideoFilter(seriesId,{Story,isValidId:id=>mongoose.isValidObjectId(id)});
const attachProfiles=videos=>resolveVideoProfiles(videos,{Story,Series});

export async function listVideos(req,res,next){
  try{
    const limit=Math.min(Math.max(Number(req.query.limit)||50,1),200);
    const status=req.query.status;
    const filter={...(status&&status!=='ALL'?{status}:{}),...(await profileFilter(req.query.seriesId))};
    const videos=await Video.find(filter).sort({createdAt:-1}).limit(limit).lean();
    const ids=videos.map(v=>v._id);
    const jobs=ids.length?await GenerationJob.find({videoId:{$in:ids}}).sort({createdAt:-1}).lean():[];
    const latestJob=new Map();
    for(const job of jobs){const key=String(job.videoId);if(!latestJob.has(key))latestJob.set(key,job);}
    res.json(await attachProfiles(videos.map(v=>({...v,latestJob:latestJob.get(String(v._id))||null}))));
  }catch(e){next(e);}
}

export async function getVideo(req,res,next){try{
  const v=await Video.findById(req.params.id).populate('storyId');
  if(!v)return res.status(404).json({error:'Video not found'});
  const jobs=await GenerationJob.find({videoId:v._id}).sort({createdAt:-1}).limit(10).lean();
  const data=v.toObject();
  const sceneAssets=(data.mediaAssetDetails||[]).map(asset=>({...asset,fileName:asset.path?path.basename(asset.path):null}));
  const [withProfile]=await attachProfiles([data]);
  // Per-scene narration audio (used by the Telegram bot's "Hear narration").
  const audioDir=path.resolve('storage','videos',String(v._id),'scene-narration');
  const sceneAudioFiles=(await fs.readdir(audioDir).catch(()=>[])).filter(f=>/^scene-\d+\.mp3$/.test(f)).sort().map(f=>path.join(audioDir,f));
  res.json({...data,profile:withProfile.profile,sceneAssets,sceneAudioFiles,latestJob:jobs[0]||null,jobs});
}catch(e){next(e);}}

// Skip / un-skip: a skipped video stays as it is (you can still open, fix or approve it),
// but Autopilot no longer waits for it before making the next video.
const SKIPPABLE=['SCENE_REVIEW','AWAITING_APPROVAL','APPROVED'];
export async function skipVideo(req,res,next){try{
  const v=await Video.findById(req.params.id).select('status skippedAt').lean();
  if(!v)return res.status(404).json({error:'Video not found'});
  if(!SKIPPABLE.includes(v.status))return res.status(409).json({error:`A ${String(v.status).toLowerCase().replace(/_/g,' ')} video cannot be skipped.`});
  const out=await Video.findByIdAndUpdate(req.params.id,{$set:{skippedAt:new Date()},$push:{statusHistory:{status:v.status,message:'Skipped by user: Autopilot will not wait for this video.',attempt:0,source:'VIDEO'}}},{returnDocument:'after'});
  res.json(out);
}catch(e){next(e);}}
export async function unskipVideo(req,res,next){try{
  const out=await Video.findByIdAndUpdate(req.params.id,{$set:{skippedAt:null}},{returnDocument:'after'});
  if(!out)return res.status(404).json({error:'Video not found'});
  res.json(out);
}catch(e){next(e);}}
export async function approveVideo(req,res,next){try{
  const current=await Video.findById(req.params.id).lean();
  if(!current)return res.status(404).json({error:'Video not found'});
  const blockReason=approvalBlockReason(current);
  if(blockReason)return res.status(409).json({error:blockReason});
  const v=await Video.findOneAndUpdate(
    {_id:req.params.id,status:'AWAITING_APPROVAL'},
    {$set:{status:'APPROVED',skippedAt:null},$unset:{error:1},$push:{statusHistory:{status:'APPROVED',message:'Approved by user.',attempt:0,source:'VIDEO'}}},
    {returnDocument:'after'}
  );
  if(!v)return res.status(409).json({error:'Video is not awaiting approval or does not exist.'});
  notify('approved',{videoId:String(v._id)});
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
    notify('retried',{videoId:String(video._id),message:`Continuing from ${video.status} (attempt #${retryCount+1}).`});
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
    {_id:video._id,status:{$in:['AWAITING_APPROVAL','APPROVED','FAILED','CANCELLED','SCENE_REVIEW']}},
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
  const job=await queueResume(video,{forceRegenerateSceneNumber:sceneNumber,...reviewPayload(req.body,sceneNumber)},`Selective regeneration queued for scene ${sceneNumber}. Other scene images and narration will be reused.`);
  notify('retried',{videoId:String(req.params.id),message:`Regenerating scene ${sceneNumber} image, then re-rendering.`});
  res.status(202).json({ok:true,jobId:job._id,status:job.status,sceneNumber,message:'Only the selected scene image will be regenerated; the Short will then be re-rendered.'});
}catch(e){if(e.statusCode)return res.status(e.statusCode).json({error:e.message,jobId:e.jobId});next(e);}}

// Optional pause before rendering (used by the Telegram bot): the rebuilt scene is
// shown to the requesting chat and rendering starts only after confirmation.
function reviewPayload(body,sceneNumber,narrationChanged=false){
  if(body?.confirmBeforeRender!==true)return {};
  const chat=String(body.requestedByChat||'').trim();
  return {confirmBeforeRender:true,sceneNumber,narrationChanged:Boolean(narrationChanged),...(/^-?\d{3,20}$/.test(chat)?{requestedByChat:chat}:{})};
}
export async function confirmRender(req,res,next){try{
  const video=await Video.findById(req.params.id);
  if(!video)return res.status(404).json({error:'Video not found'});
  if(video.status!=='SCENE_REVIEW')return res.status(409).json({error:`Video is not waiting for render confirmation (status: ${video.status}).`});
  const n=video.pendingSceneEdit?.sceneNumber;
  const job=await queueResume(video,{renderOnly:true},`Render confirmed${n?` after scene ${n} change`:''}.`);
  await Video.updateOne({_id:video._id},{$unset:{pendingSceneEdit:1}});
  notify('retried',{videoId:String(video._id),message:`Render confirmed${n?` for the new scene ${n}`:''}. Rendering now.`});
  res.status(202).json({ok:true,jobId:job._id,status:job.status});
}catch(e){if(e.statusCode)return res.status(e.statusCode).json({error:e.message,jobId:e.jobId});next(e);}}

// Re-plan every scene from the narration (Visual Director) and make all-new images.
// Fixes videos whose images were reused from older, unrelated prompts.
export async function rebuildImages(req,res,next){try{
  const video=await Video.findById(req.params.id).populate('storyId');
  if(!video)return res.status(404).json({error:'Video not found'});
  const story=video.storyId;
  if(!story?.scenes?.length)return res.status(409).json({error:'This video has no scenes.'});
  if(!['AWAITING_APPROVAL','APPROVED','FAILED','CANCELLED','SCENE_REVIEW'].includes(video.status))return res.status(409).json({error:'Images can be rebuilt when the video is awaiting approval, approved, failed, cancelled or in scene review.'});
  if(await GenerationJob.exists({videoId:video._id,status:{$in:['QUEUED','RUNNING']}}))return res.status(409).json({error:'This video already has an active generation job.'});
  if(req.body?.replan!==false)await Story.updateOne({_id:story._id},{$unset:{'pipelineData.visualDirectorPlan':1}});
  const review=req.body?.confirmBeforeRender===true?{...reviewPayload(req.body,0)}:{};
  const job=await queueResume(video,{forceRegenerateAllScenes:true,...review},`Rebuilding all ${story.scenes.length} scene images from the narration${req.body?.replan!==false?' (scenes re-planned)':''}${review.confirmBeforeRender?'; render after confirmation':''}.`);
  notify('retried',{videoId:String(video._id),message:`Rebuilding all ${story.scenes.length} images to match the narration.${review.confirmBeforeRender?' You will be asked before the video is rendered.':''}`});
  res.status(202).json({ok:true,jobId:job._id,status:job.status,sceneCount:story.scenes.length});
}catch(e){if(e.statusCode)return res.status(e.statusCode).json({error:e.message,jobId:e.jobId});next(e);}}

// Change one scene (new image description and/or new narration), then rebuild
// that scene and re-render. Other scenes' images and narration are reused.
export async function editScene(req,res,next){try{
  const video=await Video.findById(req.params.id).populate('storyId');
  if(!video)return res.status(404).json({error:'Video not found'});
  const story=video.storyId;
  if(!story?.scenes?.length)return res.status(409).json({error:'This video has no scenes to edit.'});
  const n=Number(req.params.sceneNumber);
  if(!Number.isInteger(n)||n<1||n>story.scenes.length)return res.status(400).json({error:`Scene number must be between 1 and ${story.scenes.length}.`});
  if(!['AWAITING_APPROVAL','APPROVED','FAILED','CANCELLED','SCENE_REVIEW'].includes(video.status))return res.status(409).json({error:'Scenes can be changed when the video is awaiting approval, approved, failed, cancelled or in scene review.'});
  if(await GenerationJob.exists({videoId:video._id,status:{$in:['QUEUED','RUNNING']}}))return res.status(409).json({error:'This video already has an active generation job.'});
  let change;try{change=validateEdit(req.body||{});}catch(e){return res.status(400).json({error:e.message});}
  const plain=story.toObject();
  const scene=plain.scenes[n-1];
  let visualPrompt=null;
  if(change.instruction){
    const series=plain.seriesId?await Series.findById(plain.seriesId).lean():null;
    const cp=series?buildChannelProfile(series):null;
    try{visualPrompt=await rewriteSceneVisual({provider:await getActiveProvider(),instruction:change.instruction,narration:change.narration||scene.narration,currentVisual:scene.visualPrompt,style:cp?.visual?.style||series?.visualStyle||'',language:cp?.language||'English'});}
    catch(e){return res.status(400).json({error:e.message});}
  }
  const {scenes,visualDirectorPlan}=applySceneEdit(plain,n,{visualPrompt,narration:change.narration,instruction:change.instruction});
  await Story.updateOne({_id:story._id},{$set:{scenes,...(visualDirectorPlan?{'pipelineData.visualDirectorPlan':visualDirectorPlan}:{})}});
  // New narration: drop this scene's recorded audio so it is spoken again.
  if(change.narration)await fs.rm(path.resolve('storage','videos',String(video._id),'scene-narration',`scene-${String(n).padStart(3,'0')}.mp3`),{force:true});
  const what=[change.narration&&'narration',change.regenerateImage&&'image'].filter(Boolean).join(' and ');
  const job=await queueResume(video,{...(change.regenerateImage?{forceRegenerateSceneNumber:n}:{}),...reviewPayload(req.body,n,Boolean(change.narration))},`Scene ${n} ${what} changed; rebuilding that scene${req.body?.confirmBeforeRender?' (render after confirmation)':' and re-rendering'}.`);
  notify('retried',{videoId:String(video._id),message:`Scene ${n}: new ${what}${change.instruction?` (“${change.instruction.slice(0,120)}”)`:''}. ${req.body?.confirmBeforeRender?'You will be asked before the video is rendered.':'Re-rendering.'}`});
  res.status(202).json({ok:true,jobId:job._id,status:job.status,sceneNumber:n,visualPrompt,narrationChanged:Boolean(change.narration),regenerateImage:change.regenerateImage});
}catch(e){if(e.statusCode)return res.status(e.statusCode).json({error:e.message,jobId:e.jobId});next(e);}}

export async function rerenderVideo(req,res,next){try{
  const video=await Video.findById(req.params.id);
  if(!video)return res.status(404).json({error:'Video not found'});
  const job=await queueResume(video,{renderOnly:true},'Video re-render queued. Existing scene images are reused; narration is reused only where the current voice made it.');
  notify('retried',{videoId:String(req.params.id),message:'Re-rendering with existing images and narration.'});
  res.status(202).json({ok:true,jobId:job._id,status:job.status,message:'Existing images are reused (and narration made with the current voice); the video will be rendered again with one voice.'});
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
    notify('cancelled',{videoId:String(video._id),message:'Cancelled before it started.'});
    return res.json({ok:true,jobId:job._id,status:'CANCELLED'});
  }
  await GenerationJob.findByIdAndUpdate(job._id,{$set:{cancelRequested:true},$push:{logs:{at:new Date(),message:'Cancellation requested by user. Waiting for FFmpeg to stop safely.',level:'warning'}}});
  // Do not mark the video terminal while its worker/FFmpeg child is still running.
  // The worker changes Video and GenerationJob to CANCELLED after FFmpeg exits.
  res.json({ok:true,jobId:job._id,status:'CANCELLATION_REQUESTED',message:'Stopping current stage. Continue will become available once the worker has stopped.'});
}catch(e){next(e);}}


export async function deleteVideo(req,res,next){
  try{
    // Capture title/profile for the notification before the video is gone.
    const before=await Video.findById(req.params.id).select('title status seriesId storyId').lean().catch(()=>null);
    const [ctx]=before?await attachProfiles([before]):[null];
    const result=await permanentlyDeleteVideo(req.params.id);
    if(!result.deleted)return res.status(404).json({error:'Video not found'});
    if(ctx)notify('deleted',{title:ctx.title||'Untitled video',profileId:ctx.profile?.id||null,profileName:ctx.profile?.name||null,message:`Status was ${ctx.status}.`});
    res.json({ok:true,...result});
  }catch(e){next(e);}
}

export async function getVideoStats(_req,res,next){try{
  const grouped=await Video.aggregate([{$group:{_id:'$status',count:{$sum:1}}}]);
  const stats={total:0};
  for(const x of grouped){stats[x._id]=x.count;stats.total+=x.count;}
  // Per-profile counts for the Videos page filter chips.
  const byProfile=countByProfile(await attachProfiles(await Video.find({}).select('status seriesId storyId').lean()));
  const activeJobs=await GenerationJob.countDocuments({status:{$in:['QUEUED','RUNNING']}});
  const failedJobs=await GenerationJob.countDocuments({status:'FAILED'});
  const cancelledJobs=await GenerationJob.countDocuments({status:'CANCELLED'});
  res.json({stats,byProfile,activeJobs,failedJobs,cancelledJobs});
}catch(e){next(e);}}
