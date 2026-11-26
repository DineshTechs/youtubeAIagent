import fs from 'node:fs/promises';
import path from 'node:path';
import Series from '../models/Series.js';
import {createHash} from 'node:crypto';
import {notify} from '../services/telegram/notifier.js';
import {chooseTopic} from '../services/trends/trendService.js';
import Character from '../models/Character.js';
import Story from '../models/Story.js';
import Video from '../models/Video.js';
import GenerationJob from '../models/GenerationJob.js';
import {getActiveProvider, getAISettings, getMediaSettings, mediaChain, mediaOverride} from '../services/ai/index.js';
import {aiEvents} from '../services/ai/aiEvents.js';
import {env} from '../config/env.js';
import {generateImage,generateSpeech,currentSpeechVoice,lastImageProvider} from '../services/media/openaiMedia.js';
import {speechSignature,readNarrationNote,writeNarrationNote,canReuseNarration,reuseProblem} from '../services/media/narrationReuse.js';
import {generateMockImage,generateMockSpeech} from '../services/media/mockMedia.js';
import {renderVideo,getAudioDuration} from '../services/video/renderer.js';
import {narrationLooksCut,minSpeechSeconds} from '../utils/audioTiming.js';
import {checkNarration} from '../services/media/narrationCheck.js';
import {runVideoQualityAssurance} from '../services/video/qualityAssurance.js';
import {makeSrt} from '../utils/srt.js';
import {applyOpeningHook,chooseHook} from '../utils/openingRetention.js';
import {spawn} from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import {optimizeForGeneration} from '../services/youtubeSkills/index.js';
import {inspectImageText} from '../services/media/imageTextQa.js';
import {buildChannelProfile,channelProfileSummary} from '../services/channelProfile.js';
import {traceSafe} from '../utils/traceSafe.js';
import {buildVisualDirectorInstruction,normalizeVisualPlan,isCurrentVisualPlan} from '../utils/visualPlan.js';
import {recoverInterruptedJobs,HEARTBEAT_INTERVAL_MS} from './recovery.js';
import {buildCleanImageRetryPrompt,promptLimitFor,promptStyleFor,buildSceneImagePrompt as buildSceneImagePromptPure} from '../utils/imagePrompt.js';

let busy=false;
// Short human-readable summary of what OCR actually read (confident words first).
function ocrSummary(qa){
  const words=(qa?.strongWords?.length?qa.strongWords:qa?.reviewWords)||[];
  return words.length?words.map(w=>`"${w.text}" ${w.confidence}%`).join(', '):`"${String(qa?.text||'').slice(0,80)}"`;
}
let currentJobId=null;
export function currentWorkerJob(){return currentJobId?String(currentJobId):null;}

async function traceStage(jobId, stage, input, work, meta={}){
  const stageId=`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const startedAt=new Date();
  await GenerationJob.findByIdAndUpdate(jobId,{$push:{pipelineTrace:{stageId,stage,status:'RUNNING',startedAt,input:traceSafe(input),meta:traceSafe(meta)}}});
  try{
    const output=await work();
    const completedAt=new Date();
    await GenerationJob.findByIdAndUpdate(jobId,{$set:{[`pipelineTrace.$[t].status`]:'COMPLETED',[`pipelineTrace.$[t].completedAt`]:completedAt,[`pipelineTrace.$[t].durationMs`]:completedAt-startedAt,[`pipelineTrace.$[t].output`]:traceSafe(output)},$setOnInsert:{},$push:{logs:{at:new Date(),message:`Pipeline stage ${stage} completed in ${completedAt-startedAt}ms.`,level:'info'}}},{arrayFilters:[{'t.stageId':stageId}]});
    return output;
  }catch(e){
    const completedAt=new Date();
    const cancelled=e?.code==='JOB_CANCELLED'||e?.message==='JOB_CANCELLED';
    await GenerationJob.findByIdAndUpdate(jobId,{$set:{[`pipelineTrace.$[t].status`]:cancelled?'CANCELLED':'FAILED',[`pipelineTrace.$[t].completedAt`]:completedAt,[`pipelineTrace.$[t].durationMs`]:completedAt-startedAt,[`pipelineTrace.$[t].error`]:e.message},$push:{logs:{at:new Date(),message:cancelled?`Pipeline stage ${stage} stopped after cancellation in ${completedAt-startedAt}ms.`:`Pipeline stage ${stage} failed in ${completedAt-startedAt}ms: ${e.message}`,level:cancelled?'warning':'error'}}},{arrayFilters:[{'t.stageId':stageId}]});
    throw e;
  }
}

async function recordYouTubeSkillTraces(jobId, skillRuns=[]){
  if(!Array.isArray(skillRuns)||!skillRuns.length) return;
  const traces=skillRuns.map((run,index)=>({
    stageId:`yt-skill-${Date.now()}-${index}-${Math.random().toString(36).slice(2,7)}`,
    stage:`YT_SKILL_${String(run.skill||'UNKNOWN').toUpperCase().replace(/-/g,'_')}`,
    status:run.status==='FAILED'?'FAILED':run.status==='SKIPPED'?'SKIPPED':'COMPLETED',
    startedAt:new Date(Date.now()-Number(run.durationMs||0)),
    completedAt:new Date(),
    durationMs:Number(run.durationMs||0),
    input:traceSafe(run.input),
    output:traceSafe(run.output),
    error:run.error||undefined,
    meta:traceSafe({...run.meta,type:run.type,skill:run.skill})
  }));
  await GenerationJob.findByIdAndUpdate(jobId,{$push:{pipelineTrace:{$each:traces}}});
}

async function updateJob(jobId,progress,step,message,status='RUNNING',extra={}){
  const set={progress,step,status,lastHeartbeatAt:new Date(),...extra};
  const push={logs:{at:new Date(),message,level:'info'}};
  return GenerationJob.findByIdAndUpdate(jobId,{$set:set,$push:push},{returnDocument:'after'});
}

async function setVideoStatus(videoId,status,message,errorMode='keep',attempt=0){
  const update={$set:{status},$push:{statusHistory:{status,message,at:new Date(),attempt,source:'VIDEO'}}};
  if(errorMode==='clear') update.$unset={error:1};
  if(errorMode==='set') update.$set.error=message;
  const changed=await Video.findOneAndUpdate({_id:videoId,status:{$ne:status}},update,{returnDocument:'after'});
  const event={AWAITING_APPROVAL:'ready',FAILED:'failed',CANCELLED:'cancelled',SCENE_REVIEW:'sceneReady'}[status];
  if(changed&&event)notify(event,{videoId:String(videoId),message});
  return changed;
}

async function assertNotCancelled(jobId,videoId,attempt=0){
  const current=await GenerationJob.findById(jobId).select('status cancelRequested').lean();
  if(current?.status==='CANCELLED'||current?.cancelRequested) {
    if(current.status!=='CANCELLED') await GenerationJob.findByIdAndUpdate(jobId,{$set:{status:'CANCELLED',cancelledAt:new Date(),completedAt:new Date(),step:'CANCELLED'},$push:{logs:{at:new Date(),message:'Job cancelled by user.',level:'warning'}}});
    if(videoId) await setVideoStatus(videoId,'CANCELLED','Generation cancelled by user.','keep',attempt);
    const err=new Error('JOB_CANCELLED'); err.code='JOB_CANCELLED'; throw err;
  }
}

async function processJob(job){
  busy=true;
  const jobId=job._id;
  currentJobId=jobId;
  // AI provider waits/retries go into this job's log, so the app shows what is happening.
  const onAiProgress=e=>{GenerationJob.findByIdAndUpdate(jobId,{$set:{lastHeartbeatAt:new Date()},$push:{logs:{at:e.at||new Date(),level:e.level||'info',message:e.message}}}).catch(()=>{});};
  aiEvents.on('progress',onAiProgress);
  const attempt=Number(job.retryCount||0);
  let video=null;
  try{
    const resumeId=job.payload?.resumeVideoId;
    let story=null;
    let series=null;
    let characters=[];
    let channelProfile=null;

    await assertNotCancelled(jobId,job.videoId,attempt);
    if(resumeId){
      video=await Video.findById(resumeId).populate('storyId');
      if(!video) throw new Error('Failed video no longer exists.');
      story=video.storyId;
      if(!story) throw new Error('The failed video has no associated story.');
      series=await Series.findById(story.seriesId);
      if(!series) throw new Error('The failed video story belongs to a missing series.');
      if(!video.seriesId) await Video.updateOne({_id:video._id},{$set:{seriesId:series._id}});
      channelProfile=buildChannelProfile(series,{...(job.payload||{}),channelProfile:job.payload?.channelProfile||series.channelProfile});
      characters=await Character.find({seriesId:series._id,active:true});
      await updateJob(jobId,5,'RESUMING','Continuing failed video from saved state.');
      await setVideoStatus(video._id,'ASSETS_GENERATING','Resuming from saved assets.','clear',attempt);
    }else{
      await updateJob(jobId,2,'PLANNING','Loading active universe.');
      series=job.payload?.seriesId ? await Series.findById(job.payload.seriesId) : await Series.findOne({active:true,archived:{$ne:true}}).sort({updatedAt:-1});
      if(!series) throw new Error('No active channel profile. Create or select a channel in Channel / Niche settings.');
      channelProfile=buildChannelProfile(series,{...(job.payload||{}),channelProfile:job.payload?.channelProfile||series.channelProfile});
      characters=await Character.find({seriesId:series._id,active:true});
      const episodeNumber=(await Story.countDocuments({seriesId:series._id}))+1;
      await updateJob(jobId,8,'SCRIPT_GENERATING','Generating original story.');
      const aiProvider=await getActiveProvider();
      await updateJob(jobId,7,'AI_PROVIDER',aiProvider.chain?.length>1?`Script AI in priority order: ${aiProvider.chain.join(' → ')} (the next is tried if one fails).`:`Using ${aiProvider.chain?.[0]||job.payload?.aiProvider||'active'} AI provider.`);
      const recentStories=await Story.find({seriesId:series._id}).sort({createdAt:-1}).limit(12).select('title topic').lean();
      // Topic: typed by the user, else the profile's topic source (topic queue and/or current trends).
      let chosen={topic:job.payload?.topic||null,source:'user'};
      if(!chosen.topic){
        chosen=await traceStage(jobId,'TOPIC_SELECTION',{topicSource:channelProfile?.content?.topicSource||'queue-then-trending',trendRegion:channelProfile?.content?.trendRegion||'IN'},()=>chooseTopic(series,{provider:aiProvider}));
        await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:chosen.topic?`Topic (${chosen.source}${chosen.idea?.trend?`, trend "${chosen.idea.trend}"`:''}): ${chosen.topic}`:`Topic chosen by the AI. ${chosen.note||''}`,level:'info'}}});
      }
      const generationTopic=chosen.topic||null;
      const storyData=await traceStage(jobId,'STORY_GENERATION',{topic:generationTopic,topicAngle:chosen.idea?.angle||null,language:series.language||'English',topicSource:chosen.source,episodeNumber,seriesId:series._id,niche:series.niche,channelProfile:channelProfileSummary(channelProfile),contentStrategy:series.contentStrategy||null,channelResearch:series.channelResearch?.strategy||null,recentStories,characterCount:characters.length,provider:job.payload?.aiProvider||'active'},()=>aiProvider.generateStory({series,channelProfile,characters,episodeNumber,topic:chosen.idea?.angle?`${generationTopic}. Angle: ${chosen.idea.angle}`:generationTopic,recentStories,language:channelProfile.language,format:job.payload?.format||channelProfile.content.primaryFormat||'Short',durationSec:job.payload?.durationSec||55,hookStyle:job.payload?.hookStyle||channelProfile.content.hookStyle,audience:job.payload?.audience||channelProfile.audience.description}),{provider:job.payload?.aiProvider||'active',topicSource:chosen.source||(chosen.topic?'topic-queue':'ai-selected')});
      // Move to the next queued topic only once the script exists, so a failed attempt keeps its topic.
      if(chosen.advanceQueue){const n=(series.topicIdeas||[]).filter(Boolean).length;await Series.findByIdAndUpdate(series._id,{$set:{topicCursor:(Number(series.topicCursor||0)+1)%Math.max(1,n)}});}
      await assertNotCancelled(jobId,null);
      await updateJob(jobId,14,'YOUTUBE_OPTIMIZING','Running all 11 YouTube Skills and recording each step.');
      const youtubeOptimization=await traceStage(jobId,'YOUTUBE_OPTIMIZATION',{topic:job.payload?.topic,title:storyData?.title,sceneCount:Array.isArray(storyData?.scenes)?storyData.scenes.length:0},()=>optimizeForGeneration({
        story:storyData,
        series,
        channelProfile,
        topic:job.payload?.topic,
        jobPayload:job.payload||{},
        onSkillStart:(name)=>updateJob(jobId,14,'YOUTUBE_OPTIMIZING',`Running ${name}...`).catch(()=>{}),
        onSkillDone:(name,ok,ms,error)=>updateJob(jobId,14,'YOUTUBE_OPTIMIZING',`${name} ${ok?'completed':'skipped'} in ${ms}ms${error?`: ${error}`:''}`).catch(()=>{})
      }),{skills:['yt-script','yt-package','yt-edit','yt-comment','yt-plan','yt-viral','yt-retention','yt-shorts','yt-seo','yt-chapters','yt-audit'],totalSkills:11});
      await recordYouTubeSkillTraces(jobId,youtubeOptimization.skillRuns);
      await assertNotCancelled(jobId,null);
      // Apply only safe, directly compatible recommendations to the actual story.
      // Keep the original-language hook if an optimization skill returns a hook
      // in a different script/language (especially important for Hindi narration).
      if(youtubeOptimization.applied?.title) storyData.title=youtubeOptimization.applied.title;
      const originalHook=String(storyData.hook||'').trim();
      const optimizedHook=String(youtubeOptimization.applied?.hook||'').trim();
      const requestedLanguage=job.payload?.language||series.language||'English';
      // The skill's hook is written from the topic only: use it only if it is in the right
      // language, long enough and about what the narration actually says.
      const hookChoice=chooseHook({original:originalHook,optimized:optimizedHook,story:storyData,language:requestedLanguage});
      storyData.hook=hookChoice.hook;
      await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),level:'info',message:`Opening hook: using the ${hookChoice.source==='optimized'?'YouTube-skill':"story's own"} hook (${hookChoice.reason}).`}}});
      const openingHookResult=applyOpeningHook(storyData,requestedLanguage);
      await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:openingHookResult.applied?(openingHookResult.inserted?`Opening hook inserted into spoken scene 1 narration (${requestedLanguage}).`:'Opening hook already present in scene 1 narration.'):`Opening hook not inserted: ${openingHookResult.reason}`,level:openingHookResult.applied?'info':'warning'}}});
      const qa=await traceStage(jobId,'SCRIPT_QA',{title:storyData?.title,sceneCount:Array.isArray(storyData?.scenes)?storyData.scenes.length:0,openingHook:openingHookResult},()=>aiProvider.qualityCheck({story:storyData,series,channelProfile}),{provider:job.payload?.aiProvider||'active'});
      await updateJob(jobId,22,'SCRIPT_QA',`Script QA ${qa.pass?'passed':'failed'} (${qa.score ?? 'n/a'}). YouTube Skills: ${youtubeOptimization.successCount}/${youtubeOptimization.totalSkills} completed, ${youtubeOptimization.skippedCount} skipped, ${youtubeOptimization.failedCount} failed.`);
      if(!qa.pass) throw new Error(`Script QA failed: ${(qa.notes||[]).join('; ')}`);
      story=await Story.create({...storyData,seriesId:series._id,episodeNumber,qa,youtubeOptimization,channelProfile});
      video=await Video.create({storyId:story._id,seriesId:series._id,title:story.title,status:'ASSETS_GENERATING',qa,statusHistory:[{status:'ASSETS_GENERATING',message:'Video created; media generation started.',attempt:0,source:'VIDEO'}]});
      await GenerationJob.findByIdAndUpdate(jobId,{$set:{videoId:video._id}});
    }

    const aiMedia=await getAISettings();
    const mediaSettings=await getMediaSettings();
    if(!mediaSettings.mockMode && !mediaSettings.generationEnabled) throw new Error('Real media generation is disabled in Settings. Enable Media Generation.');
    // Images use the Settings priority list: the first provider leads, the next ones are backups.
    const imageChain=mediaSettings.mockMode?[]:await mediaChain('image');
    const selectedImageProvider=String(imageChain[0]?.id || aiMedia.media?.imageProvider || env.imageProvider || 'openai').toLowerCase();
    const selectedImageMeta=aiMedia.media?.imageProviders?.[selectedImageProvider] || (selectedImageProvider === 'cloudflare' ? {name:'Cloudflare Workers AI', configured:Boolean(env.cloudflareAccountId && env.cloudflareApiToken), model:env.cloudflareImageModel} : selectedImageProvider === 'openai' ? {name:'OpenAI', configured:Boolean(env.openaiKey), model:env.imageModel} : {name:'Mock / Development', configured:true, model:'local'});
    const useMockImages = selectedImageProvider === 'mock' || mediaSettings.mockMode;
    const effectiveMediaMode = useMockImages ? 'mock' : 'real';
    if(!useMockImages && !selectedImageMeta?.configured) throw new Error(`Selected image provider ${selectedImageProvider} is not configured. Configure its credentials in Settings/.env.`);
    await assertNotCancelled(jobId,video._id,attempt);
    const base=path.resolve('storage','videos',String(video._id)); await fs.mkdir(base,{recursive:true});
    const scenesDir=path.join(base,'scenes'); await fs.mkdir(scenesDir,{recursive:true});
    await updateJob(jobId,24,'ASSETS_GENERATING',effectiveMediaMode === 'mock' ? `Media mode: MOCK (${selectedImageMeta?.name || 'Mock / Development'}). [provider=${selectedImageProvider}]` : `Media mode: REAL (${selectedImageMeta?.name || selectedImageProvider}${imageChain.length>1?`; backups: ${imageChain.slice(1).map(x=>x.name).join(' → ')}`:''}). [provider=${selectedImageProvider}]`);
    if(!Array.isArray(story.scenes)||story.scenes.length===0) throw new Error('No scene data is available for image generation.');
    const sceneFiles=[];
    const assetDetails=[];
    let visualDirectorPlan=null;
    if(aiMedia.visualDirector?.enabled !== false && !useMockImages){
      const visualDirectorProvider=await getActiveProvider();
      try {
        visualDirectorPlan=await traceStage(jobId,'VISUAL_DIRECTOR',{sceneCount:story.scenes.length,language:series.language||'English',inputScenes:story.scenes.map(s=>({sceneNumber:s.sceneNumber,narration:s.narration,visualPrompt:s.visualPrompt}))},()=>runVisualDirectorPlan(story,series,channelProfile,visualDirectorProvider,aiMedia),{enabled:true,provider:aiMedia.activeProvider||'active'});
      } catch(e) {
        // Visual Director improves prompts but must never prevent video generation.
        // The original scene prompts remain available as a safe fallback.
        visualDirectorPlan=story.pipelineData?.visualDirectorPlan || null;
        await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:`Visual Director skipped: ${e.message}. Continuing with original scene prompts.`,level:'warning'}}});
      }
    } else {
      visualDirectorPlan=story.pipelineData?.visualDirectorPlan || null;
    }
    const expectedMode=job.payload?.renderOnly && video.mediaAssetDetails?.[0]?.mode ? video.mediaAssetDetails[0].mode : effectiveMediaMode;
    const requestedAspect=String(channelProfile?.visual?.aspectRatio||'9:16');
    const aspectDimensions=requestedAspect==='16:9'?[1920,1080]:requestedAspect==='1:1'?[1080,1080]:requestedAspect==='3:4'?[1080,1440]:[1080,1920];
    const VIDEO_WIDTH=aspectDimensions[0];
    const VIDEO_HEIGHT=aspectDimensions[1];
    const VIDEO_FPS=Number(aiMedia.video?.fps||30);
    const IMAGE_FIT=String(aiMedia.video?.imageFit||'contain-blur');

    // Keep every scene asset in the exact final Shorts canvas. FFmpeg is used
    // here instead of a native image library so the server does not require
    // sharp just to start. The full image is preserved and any missing canvas
    // area is filled with a blurred version of the same image.
    const imageFfmpegPath=env.ffmpegPath || ffmpegStatic || 'ffmpeg';
    async function normalizeSceneImage(file){
      const temp=`${file}.normalized.png`;
      await new Promise((resolve,reject)=>{
        const args=['-y','-hide_banner','-loglevel','error','-i',file,
          '-filter_complex', IMAGE_FIT === 'cover'
            ? `[0:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},format=rgb24`
            : IMAGE_FIT === 'contain'
              ? `[0:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgb24`
              : `[0:v]split=2[bg][fg];[bg]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},boxblur=20:1[bg];[fg]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,format=rgb24`,
          '-frames:v','1',temp];
        const child=spawn(imageFfmpegPath,args,{stdio:['ignore','pipe','pipe']});
        let err=''; child.stderr.on('data',d=>err+=d);
        child.on('error',e=>reject(new Error(`Unable to normalize scene image with FFmpeg: ${e.message}`)));
        child.on('close',code=>code===0?resolve():reject(new Error(`FFmpeg image normalization failed (${code}): ${err.slice(-1800)}`)));
      });
      const stat=await fs.stat(temp);
      await fs.rename(temp,file);
      return {width:VIDEO_WIDTH,height:VIDEO_HEIGHT,normalized:true,sizeBytes:stat.size,fit:IMAGE_FIT};
    }

    async function runVisualDirectorPlan(storyDoc, seriesDoc, profile, activeProvider, settings){
      const enabled=settings?.visualDirector?.enabled !== false;
      if(!enabled) return null;
      const existing=storyDoc?.pipelineData?.visualDirectorPlan;
      // Reuse only a current (v2, English) plan; older/Hindi plans are re-planned.
      if(isCurrentVisualPlan(existing,storyDoc.scenes.length)) return existing;
      if(!activeProvider || typeof activeProvider.generateJson!=='function') return null;
      const charactersForPlan=characters.map(c=>({name:c.name,appearance:c.appearance||'',personality:c.personality||''}));
      const input={
        series:{name:seriesDoc.name,premise:seriesDoc.premise,niche:seriesDoc.niche,visualStyle:seriesDoc.visualStyle,language:seriesDoc.language},
        video:{title:storyDoc.title,topic:storyDoc.topic,hook:storyDoc.hook},
        channelProfile:profile,
        characters:charactersForPlan,
        scenes:storyDoc.scenes.map(s=>({sceneNumber:s.sceneNumber,narration:s.narration,durationSec:s.durationSec}))
      };
      let plan;
      try{
        plan=normalizeVisualPlan(await activeProvider.generateJson(buildVisualDirectorInstruction(profile,seriesDoc),input,'visual director'),storyDoc.scenes);
      }catch(firstError){
        // One stricter retry (most often: the model answered in the narration language).
        plan=normalizeVisualPlan(await activeProvider.generateJson(buildVisualDirectorInstruction(profile,seriesDoc,{strict:true}),input,'visual director (retry)'),storyDoc.scenes,{sanitizeText:true});
      }
      // Scenes the user described themselves (dashboard/Telegram scene edit) keep their image description.
      const edited=new Map((existing?.scenes||[]).filter(x=>x?.editedAt||x?.userInstruction).map(x=>[Number(x.sceneNumber),x]));
      if(edited.size)plan={...plan,scenes:plan.scenes.map(p=>edited.has(p.sceneNumber)?{...p,...edited.get(p.sceneNumber),keyIdea:''}:p)};
      for(const p of plan.scenes){const scene=storyDoc.scenes.find((x,i)=>Number(x.sceneNumber||i+1)===p.sceneNumber);if(scene)scene.visualPrompt=p.visualPrompt;}
      storyDoc.pipelineData={...(storyDoc.pipelineData||{}),visualDirectorPlan:plan};
      await storyDoc.save();
      return storyDoc.pipelineData.visualDirectorPlan;
    }

    function limitPromptText(value,max){
      const text=String(value||'').replace(/\s+/g,' ').trim();
      if(text.length<=max) return text;
      const cut=text.slice(0,max);
      const boundary=cut.lastIndexOf(' ');
      return (boundary>Math.floor(max*0.72)?cut.slice(0,boundary):cut).trim();
    }
    // FLUX (Cloudflare / Pollinations-flux) gets short descriptive prompts; see utils/imagePrompt.js.
    const imagePromptStyle=promptStyleFor(selectedImageProvider,selectedImageMeta?.model||mediaSettings.imageModel);
    function buildSceneImagePrompt(scene,index,visualPlan=null){
      return buildSceneImagePromptPure({scene,index,visualPlan,characters,channelProfile,series,visualDirector:aiMedia.visualDirector,promptStyle:imagePromptStyle});
    }
    const validateImageAsset=async(file,mode,sceneNumber)=>{
      let st; try{st=await fs.stat(file);}catch{throw new Error(`Scene ${sceneNumber} image asset is missing: ${file}`);}
      if(!st.isFile()||st.size<100) throw new Error(`Scene ${sceneNumber} image asset is invalid or empty (${st.size||0} bytes).`);
      const head=await fs.open(file,'r').then(async fh=>{const b=Buffer.alloc(16); const {bytesRead}=await fh.read(b,0,16,0); await fh.close(); return b.subarray(0,bytesRead);});
      if(mode==='real') {
        const isPng=head.length>=8&&head[0]===0x89&&head[1]===0x50&&head[2]===0x4e&&head[3]===0x47&&head[4]===0x0d&&head[5]===0x0a&&head[6]===0x1a&&head[7]===0x0a;
        const isJpeg=head.length>=3&&head[0]===0xff&&head[1]===0xd8&&head[2]===0xff;
        if(!isPng&&!isJpeg) throw new Error(`Real image generation returned an invalid image for scene ${sceneNumber}.`);
      }
      return {sizeBytes:st.size,valid:true};
    };
    for(let i=0;i<story.scenes.length;i++){
      await assertNotCancelled(jobId,video._id,attempt);
      const scene=story.scenes[i];
      const sceneNumber=scene.sceneNumber||i+1;
      const sceneImagePrompt=buildSceneImagePrompt(scene,i,visualDirectorPlan);
      const savedAsset=video.mediaAssetDetails?.find(x=>Number(x.sceneNumber)===Number(sceneNumber));
      // Fingerprint of the exact prompt; an image is only reused for the prompt it was made from.
      const promptKey=createHash('sha1').update(sceneImagePrompt).digest('hex').slice(0,16);
      const staleImage=!job.payload?.renderOnly&&Boolean(savedAsset?.promptKey)&&savedAsset.promptKey!==promptKey;
      if(staleImage)await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:`Scene ${sceneNumber}: its description changed since the image was made; generating a new image instead of reusing the old one.`,level:'info'}}});
      const forceThisScene=Boolean(job.payload?.forceRegenerateAllScenes)||staleImage||Number(job.payload?.forceRegenerateSceneNumber||0)===Number(sceneNumber);
      const ext=useMockImages?'ppm':'png';
      const canonicalPath=path.join(scenesDir,`scene-${String(i+1).padStart(2,'0')}.${ext}`);
      // Selective regeneration must write a NEW immutable asset path. Reusing the
      // old filename can make browser/proxy caches show the previous preview and
      // makes it harder to prove which exact image was passed to FFmpeg.
      const regeneratedPath=path.join(scenesDir,`scene-${String(i+1).padStart(2,'0')}-regen-${String(jobId).slice(-8)}-${Date.now()}.${ext}`);
      const p=forceThisScene
        ? regeneratedPath
        : ((job.payload?.renderOnly || resumeId) && savedAsset?.path ? savedAsset.path : canonicalPath);
      let reusable=false;
      let reuseTextQa=null;
      if(!forceThisScene&&savedAsset?.path)await GenerationJob.findByIdAndUpdate(jobId,{$set:{lastHeartbeatAt:new Date()},$push:{logs:{at:new Date(),message:`Scene ${sceneNumber}: checking the saved image (file and text check) before reusing it.`,level:'info'}}});
      try{const asset=await validateImageAsset(p,expectedMode,sceneNumber); reusable=asset.valid&&!forceThisScene;}catch{}
      // Previously generated assets must pass the same OCR gate before reuse.
      if(reusable && expectedMode==='real'){
        try{
          const strictTextQa=String(process.env.IMAGE_TEXT_QA_STRICT||'true').toLowerCase()!=='false';
          const priorTextQa=reuseTextQa=await inspectImageText(p,{strict:strictTextQa,minWords:2,language:channelProfile?.language||series.language});
          if(priorTextQa.suspicious){
            reusable=false;
            await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:`Scene ${sceneNumber}: saved image failed the text-integrity check (${priorTextQa.reason}; OCR read ${ocrSummary(priorTextQa)}). Regenerating instead of reusing it.`,level:'warning'}}});
          }
        }catch(ocrError){
          // Fail closed for real images: an asset that cannot be inspected must
          // not silently bypass the clean-artwork gate. Regenerate and inspect it.
          reusable=false;
          await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:`Scene ${sceneNumber}: saved image could not pass OCR validation (${ocrError.message}); it will not be reused.`,level:'warning'}}});
        }
      }
      if(!reusable){
        const generated=await traceStage(jobId,`SCENE_${i+1}_IMAGE`,{
          sceneNumber,
          visualPrompt:sceneImagePrompt,
          sourceVisualPrompt:scene.visualPrompt,
          visualDirectorPlan:visualDirectorPlan?.scenes?.find(x=>Number(x.sceneNumber)===Number(sceneNumber))||null,
          narration:scene.narration,
          onScreenText:scene.onScreenText,
          requestedOutput:p,
          action:'GENERATE_OR_REGENERATE_MISSING_ASSET'
        },async()=>{
          // A resumed job may have a saved Story but no physical scene file. Always
          // regenerate that missing asset instead of treating the stale path as a
          // completed stage.
          await fs.rm(p,{force:true}).catch(()=>{});
          let generatedPath;
          let usedPrompt=sceneImagePrompt;
          let safetyRewriteUsed=false;
          if(useMockImages) generatedPath=await generateMockImage(scene.visualPrompt,p);
          else {
            try {
              generatedPath=await generateImage(usedPrompt,p,useMockImages?selectedImageProvider:null,{width:VIDEO_WIDTH,height:VIDEO_HEIGHT,aspectRatio:channelProfile?.visual?.aspectRatio||mediaSettings.imageAspectRatio||'9:16',imageSize:mediaSettings.imageSize});
            } catch (imageError) {
              const isCloudflareSafetyBlock=selectedImageProvider==='cloudflare' && /Cloudflare Workers AI image generation failed \(400\)/i.test(String(imageError?.message||'')) && /(NSFW|8007|prompt contains)/i.test(String(imageError?.message||''));
              if(!isCloudflareSafetyBlock) throw imageError;

              // A single content-preserving rewrite is allowed for ambiguous wording.
              // This does not disable, evade, or override Cloudflare's safety filter.
              // If the scene itself is unsuitable, the second request will be rejected.
              const rewriteProvider=await getActiveProvider();
              if(!rewriteProvider || typeof rewriteProvider.generateJson!=='function') {
                throw new Error(`Cloudflare rejected scene ${sceneNumber} as NSFW (code 8007), and no AI provider is available to create a policy-compliant channel-aware prompt. Original error: ${imageError.message}`);
              }
              const rewriteInstruction='You are a safety-conscious visual prompt editor. Rewrite the supplied scene into ONE policy-compliant image prompt suitable for the channel profile and its audience. Preserve the legitimate story meaning, subjects, setting and benign action. Remove ambiguous wording and unnecessary sensitive details. Do not disguise, euphemize, or transform prohibited content to evade a safety filter. If the underlying scene cannot be represented safely, return {"safe":false,"visualPrompt":""}. Otherwise return {"safe":true,"visualPrompt":"..."}. Output only JSON.';
              const rewriteInput={sceneNumber,narration:limitPromptText(scene.narration,500),sourceVisualPrompt:limitPromptText(scene.visualPrompt,850),characterDescriptions:characters.map(c=>({name:c.name,appearance:limitPromptText(c.appearance||'',180)})),rejectedImagePrompt:limitPromptText(sceneImagePrompt,1600)};
              const rewritten=await rewriteProvider.generateJson(rewriteInstruction,rewriteInput,'Cloudflare safe image prompt rewrite');
              if(rewritten?.safe!==true || !String(rewritten?.visualPrompt||'').trim()) {
                throw new Error(`Cloudflare rejected scene ${sceneNumber} as NSFW (code 8007). The scene could not be safely rewritten, so image generation was stopped. Original error: ${imageError.message}`);
              }
              usedPrompt=limitPromptText(rewritten.visualPrompt,1200);
              safetyRewriteUsed=true;
              await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:`Scene ${sceneNumber}: Cloudflare safety filter rejected the original image prompt. Retrying once with a policy-compliant channel-aware rewrite; safety filters remain enabled.`,level:'warning'}}});
              generatedPath=await generateImage(usedPrompt,p,useMockImages?selectedImageProvider:null,{width:VIDEO_WIDTH,height:VIDEO_HEIGHT,aspectRatio:channelProfile?.visual?.aspectRatio||mediaSettings.imageAspectRatio||'9:16',imageSize:mediaSettings.imageSize});
            }
          }

          // Providers normally write directly to p. If a provider returns a different
          // path, normalize it into the pipeline's canonical scene filename.
          if(generatedPath && path.resolve(String(generatedPath))!==path.resolve(p)) {
            try { await fs.copyFile(String(generatedPath),p); } catch(e) {
              throw new Error(`Scene ${sceneNumber} image provider returned ${generatedPath}, but the expected asset ${p} could not be created: ${e.message}`);
            }
          }

          // Never mark the stage complete until the physical file exists and passes
          // the image signature/size validation.
          let normalized=await normalizeSceneImage(p);
          // V1.4.2: OCR quality gate. Always reject recognizable internal workflow
          // instructions; optionally reject any substantial readable text in strict mode.
          let imageTextQa={checked:false,suspicious:false,reason:'not_checked'};
          try {
            const strictTextQa=String(process.env.IMAGE_TEXT_QA_STRICT||'true').toLowerCase()!=='false';
            const cleanRetryBasePrompt=usedPrompt;
            const maxOcrRetries=Math.max(0,Math.min(3,Number(aiMedia.quality?.ocrMaxRetries??2)));
            for(let qaAttempt=0;qaAttempt<=maxOcrRetries;qaAttempt++){
              imageTextQa=await inspectImageText(p,{strict:strictTextQa,minWords:2,language:channelProfile?.language||series.language});
              if(!imageTextQa.suspicious) break;
              if(qaAttempt===maxOcrRetries){
                throw new Error(`Scene ${sceneNumber} still contains unwanted text after ${maxOcrRetries} regeneration attempt(s) (${imageTextQa.reason}; OCR read ${ocrSummary(imageTextQa)}).`);
              }
              await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:`Scene ${sceneNumber}: OCR read text in the image (${imageTextQa.reason}; ${ocrSummary(imageTextQa)}). Regenerating image, attempt ${qaAttempt+1}/${maxOcrRetries}.`,level:'warning'}}});
              // Rebuild from the original scene prompt (no stacking) and keep within the
              // provider's prompt limit; the clean-image correction is placed first.
              const retryPrompt=buildCleanImageRetryPrompt(cleanRetryBasePrompt,{maxChars:promptLimitFor(selectedImageProvider),promptStyle:imagePromptStyle});
              let retryPath;
              try{ retryPath=await generateImage(retryPrompt,p,useMockImages?selectedImageProvider:null,{width:VIDEO_WIDTH,height:VIDEO_HEIGHT,aspectRatio:channelProfile?.visual?.aspectRatio||mediaSettings.imageAspectRatio||'9:16',imageSize:mediaSettings.imageSize}); }
              catch(providerError){ const e=new Error(`Scene ${sceneNumber} clean-image regeneration ${qaAttempt+1}/${maxOcrRetries} failed at the image provider (OCR itself worked): ${providerError.message}`); e.code='IMAGE_PROVIDER_FAILED'; throw e; }
              if(retryPath && path.resolve(String(retryPath))!==path.resolve(p)) await fs.copyFile(String(retryPath),p);
              usedPrompt=retryPrompt;
              normalized=await normalizeSceneImage(p);
            }
            imageTextQa.checked=true;
            if(imageTextQa.needsVisualReview){
              await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:`Scene ${sceneNumber}: image accepted, but OCR saw faint word-like marks (${ocrSummary(imageTextQa)}). Check this scene during visual review.`,level:'warning'}}});
            }
          } catch(ocrError) {
            // Never accept a newly generated real image when OCR is unavailable:
            // that would turn an inspection outage into an unnoticed text leak.
            if(String(ocrError?.message||'').includes('still contains unwanted text')||ocrError?.code==='IMAGE_PROVIDER_FAILED') throw ocrError;
            throw new Error(`Scene ${sceneNumber} image integrity check could not complete. The image was not approved. OCR error: ${ocrError.message}`);
          }
          const asset=await validateImageAsset(p,expectedMode,sceneNumber);
          return {
            path:p,
            mode:expectedMode,
            resolution:`${normalized.width}x${normalized.height}`,
            normalized:normalized.normalized,
            provider:mediaSettings.mockMode?'mock':(lastImageProvider()||selectedImageProvider),
            model:selectedImageMeta?.model || env.imageModel,
            sizeBytes:asset.sizeBytes,
            valid:true,
            reused:false,
            regenerated:true,
            safetyRewriteUsed,
            imagePromptUsed:usedPrompt,
            textQa:imageTextQa?{checked:Boolean(imageTextQa.checked),suspicious:imageTextQa.suspicious,reason:imageTextQa.reason,strongWords:imageTextQa.strongWords||[],reviewWords:imageTextQa.reviewWords||[],needsVisualReview:Boolean(imageTextQa.needsVisualReview),language:imageTextQa.language,regionsInspected:imageTextQa.regionsInspected,engine:imageTextQa.engine}:null
          };
        },{
          mediaMode:expectedMode,
          provider:mediaSettings.mockMode?'mock':(lastImageProvider()||selectedImageProvider),
          model:selectedImageMeta?.model || env.imageModel,
          reused:false,
          regenerated:true,
          requestedOutput:p
        });
        assetDetails.push({sceneNumber,path:p,mode:expectedMode,sizeBytes:generated.sizeBytes,valid:true,generatedAt:new Date(),reused:false,prompt:sceneImagePrompt,promptKey,imagePromptUsed:String(generated.imagePromptUsed||sceneImagePrompt).slice(0,2000),currentPrompt:sceneImagePrompt,stale:false,sourceVisualPrompt:scene.visualPrompt,visualDirectorPlan:visualDirectorPlan?.scenes?.find(x=>Number(x.sceneNumber)===Number(sceneNumber))||null,resolution:`${VIDEO_WIDTH}x${VIDEO_HEIGHT}`});
        if(forceThisScene){
          await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:`Scene ${sceneNumber} regenerated to a versioned asset: ${path.basename(p)}. The renderer will use this exact new file.`,level:'info'}}});
        }
        await updateJob(jobId,25+Math.round(((i+1)/story.scenes.length)*30),'ASSETS_GENERATING',`Generated scene ${i+1}/${story.scenes.length} (${expectedMode.toUpperCase()}).`);
      }else{
        const normalized=await normalizeSceneImage(p);
        const asset=await validateImageAsset(p,expectedMode,sceneNumber);
        await traceStage(jobId,`SCENE_${i+1}_IMAGE`,{sceneNumber,visualPrompt:sceneImagePrompt,sourceVisualPrompt:scene.visualPrompt,narration:scene.narration,onScreenText:scene.onScreenText},async()=>({path:p,mode:expectedMode,sizeBytes:asset.sizeBytes,valid:true,reused:true,resolution:`${normalized.width}x${normalized.height}`,normalized:normalized.normalized,textQa:reuseTextQa?{checked:true,suspicious:reuseTextQa.suspicious,reason:reuseTextQa.reason,strongWords:reuseTextQa.strongWords||[],reviewWords:reuseTextQa.reviewWords||[],needsVisualReview:Boolean(reuseTextQa.needsVisualReview),engine:reuseTextQa.engine}:{checked:false,reason:expectedMode==='real'?'not_checked':'mock_image'}}),{mediaMode:expectedMode,provider:selectedImageProvider,model:selectedImageMeta?.model || env.imageModel,reused:true});
        // Keep the record of what this image was actually made from (older assets
        // have no promptKey: their origin is unknown, so they are marked as possibly stale).
        const madeFor=savedAsset?.promptKey?savedAsset:null;
        assetDetails.push({sceneNumber,path:p,mode:expectedMode,sizeBytes:asset.sizeBytes,valid:true,generatedAt:madeFor?.generatedAt||savedAsset?.generatedAt||null,reused:true,prompt:madeFor?.prompt||null,promptKey:madeFor?.promptKey||null,imagePromptUsed:madeFor?.imagePromptUsed||null,currentPrompt:sceneImagePrompt,stale:!madeFor||madeFor.promptKey!==promptKey,sourceVisualPrompt:scene.visualPrompt,resolution:`${VIDEO_WIDTH}x${VIDEO_HEIGHT}`,normalized:normalized.normalized});
        await updateJob(jobId,25+Math.round(((i+1)/story.scenes.length)*30),'ASSETS_GENERATING',`Reused valid scene ${i+1}/${story.scenes.length}.`);
      }
      sceneFiles.push(p);
    }
    if(sceneFiles.length!==story.scenes.length||assetDetails.length!==story.scenes.length) throw new Error(`Scene asset validation failed: ${assetDetails.length}/${story.scenes.length} assets are valid.`);
    for(let i=0;i<sceneFiles.length;i++) await validateImageAsset(sceneFiles[i],expectedMode,i+1);
    await Video.findByIdAndUpdate(video._id,{$set:{mediaAssetDetails:assetDetails}});
    await updateJob(jobId,58,'ASSETS_GENERATING',`All ${sceneFiles.length} scene assets validated and ready for rendering.`);

    await assertNotCancelled(jobId,video._id,attempt);
    const audio=path.join(base,'narration.mp3');
    const sceneAudioDir=path.join(base,'scene-narration');
    await fs.mkdir(sceneAudioDir,{recursive:true});
    const sceneAudioFiles=[];
    const sceneDurations=[];
    await updateJob(jobId,61,'VOICE','Generating narration.');
    await traceStage(jobId,'VOICE_GENERATION',{sceneCount:story.scenes.length,narrationChars:story.scenes.map(s=>s.narration).join(' ').length,language:series.language||'English',outputPath:audio,sceneOutputDir:sceneAudioDir},async()=>{
      const speechLanguage=channelProfile?.narration?.language||series.language||'English';
      // Narration priority: the whole video is spoken by ONE provider. If the main one
      // fails, the next provider re-records every scene (never a mix of voices).
      const ttsChain=mediaSettings.mockMode?[{id:'mock',name:'Mock'}]:await mediaChain('tts');
      if(!ttsChain.length)throw new Error('No narration provider is set up. Add one in Settings → Narration.');
      let speechVoice,remade=[],voiceFailures=[];
      for(let vi=0;vi<ttsChain.length;vi++){
       const voiceProvider=ttsChain[vi];
       sceneAudioFiles.length=0;sceneDurations.length=0;remade=[];
       try{
        await mediaOverride.run({...(mediaOverride.getStore()||{}),ttsProvider:voiceProvider.id},async()=>{
      speechVoice=mediaSettings.mockMode?{provider:'mock',model:'',voice:''}:await currentSpeechVoice(channelProfile?.narration||{});
      const signature=speechSignature({mock:mediaSettings.mockMode,...speechVoice,language:speechLanguage});
      for(let i=0;i<story.scenes.length;i++){
        await assertNotCancelled(jobId,video._id,attempt);
        const sceneAudio=path.join(sceneAudioDir,`scene-${String(i+1).padStart(3,'0')}.mp3`);
        const text=story.scenes[i].narration;
        let ready=false;
        try{const st=await fs.stat(sceneAudio);ready=st.size>100;}catch{}
        // Reuse saved narration only when the same voice made it from the same words,
        // so every scene of a video has one voice.
        if(ready){const note=await readNarrationNote(sceneAudio);if(!canReuseNarration(note,{signature,text})){remade.push(`${i+1} (${reuseProblem(note,{signature,text})})`);ready=false;}}
        // Saved audio that stops part-way (from an older run) is remade too.
        if(ready&&!mediaSettings.mockMode&&narrationLooksCut(text,await getAudioDuration(sceneAudio).catch(()=>0))){remade.push(`${i+1} (saved audio was cut short)`);ready=false;}
        if(!ready){
          // A provider sometimes returns audio that stops mid-sentence. Check the length
          // against the words, try again, and if it keeps happening use the next provider.
          for(let tries=1;;tries++){
            await fs.rm(sceneAudio,{force:true}).catch(()=>{});
            if(mediaSettings.mockMode){await generateMockSpeech(text,sceneAudio);break;}
            await generateSpeech(text,sceneAudio,speechLanguage,channelProfile?.narration||{});
            const got=await getAudioDuration(sceneAudio);
            if(!narrationLooksCut(text,got))break;
            const short=`Scene ${i+1} narration from ${voiceProvider.name} stopped early (${got.toFixed(1)}s of audio for ${text.length} characters; at least ${minSpeechSeconds(text).toFixed(1)}s expected)`;
            if(tries>=3){await fs.rm(sceneAudio,{force:true}).catch(()=>{});throw new Error(`${short} three times.`);}
            await GenerationJob.findByIdAndUpdate(jobId,{$set:{lastHeartbeatAt:new Date()},$push:{logs:{at:new Date(),level:'warning',message:`${short}. Recording it again (try ${tries+1} of 3).`}}});
          }
          await writeNarrationNote(sceneAudio,{signature,text,provider:speechVoice.provider,voice:speechVoice.voice}).catch(()=>{});
        }
        const duration=await getAudioDuration(sceneAudio);
        sceneAudioFiles.push(sceneAudio);
        sceneDurations.push(duration);
        // Persist measured TTS timing as the canonical scene timing. Estimated
        // LLM durations must not drive captions after real narration is rendered.
        if(story.scenes[i]) story.scenes[i].durationSec=duration;
      }
        });
        if(vi>0)await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),level:'info',message:`Narration recorded by ${voiceProvider.name} (backup provider #${vi+1}) for all scenes.`}}});
        break;
       }catch(e){
        if(e?.code==='JOB_CANCELLED')throw e;
        voiceFailures.push(`${voiceProvider.name}: ${String(e?.message||e).slice(0,200)}`);
        if(vi===ttsChain.length-1)throw ttsChain.length>1?new Error(`All narration providers failed — ${voiceFailures.join(' | ')}`):e;
        await GenerationJob.findByIdAndUpdate(jobId,{$set:{lastHeartbeatAt:new Date()},$push:{logs:{at:new Date(),level:'warning',message:`Narration provider ${voiceProvider.name} failed (${String(e?.message||e).replace(/\s+/g,' ').slice(0,160)}). Switching the whole video to ${ttsChain[vi+1].name}.`}}});
       }
      }
      if(remade.length)await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),level:'info',message:`Narration remade for scene ${remade.join(', ')} so the whole video uses one voice (${speechVoice.provider}${speechVoice.voice?` / ${speechVoice.voice}`:''}).`}}});
      if(typeof story.save==='function') await story.save();
      return {path:audio,sceneAudioFiles,sceneDurations,sceneCount:sceneAudioFiles.length,mode:mediaSettings.mockMode?'mock':'real'};
    },{mediaMode:mediaSettings.mockMode?'mock':'real',perScene:true,ttsModel:mediaSettings.ttsModel,ttsVoice:mediaSettings.ttsVoice});
    await updateJob(jobId,64,'VOICE','All scene narration audio files generated and validated.');

    await assertNotCancelled(jobId,video._id,attempt);
    const srt=path.join(base,'subtitles.srt');
    await fs.writeFile(srt,makeSrt(story.scenes,sceneDurations),'utf8');
    if(sceneFiles.length===0||sceneFiles.length!==story.scenes.length) throw new Error(`No complete scene asset set is available for video rendering (${sceneFiles.length}/${story.scenes.length}).`);
    for(let i=0;i<sceneFiles.length;i++) await validateImageAsset(sceneFiles[i],expectedMode,i+1);
    await Video.findByIdAndUpdate(video._id,{$set:{media:{scenes:sceneFiles,audio,subtitles:srt}}});
    // Scene changed from Telegram: stop here and ask before rendering.
    if(job.payload?.confirmBeforeRender){
      const n=job.payload.forceRegenerateAllScenes?0:Number(job.payload.sceneNumber||job.payload.forceRegenerateSceneNumber||0);
      await Video.findByIdAndUpdate(video._id,{$set:{pendingSceneEdit:{sceneNumber:n,allScenes:Boolean(job.payload.forceRegenerateAllScenes),narrationChanged:Boolean(job.payload.narrationChanged),imageChanged:Boolean(job.payload.forceRegenerateSceneNumber),chatId:job.payload.requestedByChat||null,jobId:String(jobId),at:new Date()}}});
      await updateJob(jobId,100,'SCENE_REVIEW',`${n?`Scene ${n}`:'All scene images'} rebuilt. Waiting for confirmation before rendering.`,'COMPLETED',{completedAt:new Date(),lastHeartbeatAt:new Date()});
      await setVideoStatus(video._id,'SCENE_REVIEW',`${n?`Scene ${n}`:'All scene images'} rebuilt. Confirm to render the video.`,'clear',attempt);
      return;
    }
    await setVideoStatus(video._id,'VIDEO_RENDERING','Rendering video.','clear',attempt);
    await updateJob(jobId,65,'VIDEO_RENDERING','Rendering vertical MP4 with FFmpeg.');
    // Profile caption settings override the global defaults in Settings → Output.
    const profileVisual=(series?buildChannelProfile(series):channelProfile)?.visual||{};
    const profileSubtitles={enabled:profileVisual.subtitles==='on'?true:profileVisual.subtitles==='off'?false:(aiMedia.video?.subtitlesEnabled??true),position:['bottom','center','top'].includes(profileVisual.subtitlePosition)?profileVisual.subtitlePosition:(aiMedia.video?.subtitlePosition||'bottom')};
    let lastProgress=-1;
    const rendered=await traceStage(jobId,'FFMPEG_RENDER',{videoId:video._id,sceneCount:sceneFiles.length,audioFile:audio,sceneAudioFiles,sceneDurations,subtitlesFile:srt,outDir:base},()=>renderVideo({videoId:video._id,sceneFiles,sceneAudioFiles,sceneDurations,audioFile:audio,subtitlesFile:srt,outDir:base,width:VIDEO_WIDTH,height:VIDEO_HEIGHT,fps:VIDEO_FPS,imageFit:IMAGE_FIT,subtitlesEnabled:profileSubtitles.enabled,subtitleFontSize:aiMedia.video?.subtitleFontSize||38,subtitleMarginV:aiMedia.video?.subtitleMarginV||85,subtitleFontName:aiMedia.video?.subtitleFontName||'Nirmala UI',subtitlePosition:profileSubtitles.position,subtitleOffsetPct:aiMedia.video?.subtitleOffsetPct??7,shouldCancel:async()=>{const state=await GenerationJob.findById(jobId).select('status cancelRequested').lean();return !state||state.status==='CANCELLED'||Boolean(state.cancelRequested);},onProgress:p=>{
      const progress=65+Math.round(p*.25);
      if(progress===lastProgress)return;
      lastProgress=progress;
      GenerationJob.findByIdAndUpdate(jobId,{$set:{progress,step:'VIDEO_RENDERING',lastHeartbeatAt:new Date()}}).catch(()=>{});
    }}),{renderer:'ffmpeg'});

    await assertNotCancelled(jobId,video._id,attempt);
    await Video.findByIdAndUpdate(video._id,{$set:{renderPath:rendered.videoPath,durationSec:rendered.durationSec}});
    await setVideoStatus(video._id,'VIDEO_QA','Checking rendered video.','keep',attempt);
    await updateJob(jobId,94,'VIDEO_QA','Running final file checks.');
    const qaReport=await traceStage(jobId,'FINAL_QA',{videoPath:rendered.videoPath,durationSec:rendered.durationSec,sceneCount:sceneFiles.length},async()=>{
      const report=await runVideoQualityAssurance({videoPath:rendered.videoPath,scenePaths:sceneFiles,audioPath:audio,subtitlePath:srt,expectedDurationSec:rendered.durationSec,expectedSceneCount:story.scenes.length,sceneDurations:rendered.sceneDurations,expectedOpeningHook:story.hook||'',expectedAspectRatio:channelProfile?.visual?.aspectRatio||'9:16'});
      await Video.findByIdAndUpdate(video._id,{$set:{qa:report,visualReview:{}}});
      if(!report.pass) throw new Error(`Video technical QA failed: ${report.checks.filter(x=>x.status==='FAIL').map(x=>`${x.name}: ${x.message}`).join('; ')}`);
      return report;
    },{qaVersion:'1.7.0',checks:['file','full-decode','profile-aspect-ratio','resolution','duration','black-frames','audio-silence','audio-intelligence','opening-frame-samples','opening-black-frame-scan','opening-audio-start','opening-hook-caption','3-second-hook-delivery','opening-visual-pacing','scene-assets','subtitle-file','manual-visual-review']});
    // Narration check: complete, one voice, and (with a speech-to-text key) says its text.
    await updateJob(jobId,97,'VIDEO_QA','Checking the narration of every scene.');
    let narrationCheck=null;
    if(!mediaSettings.mockMode&&mediaSettings.narrationCheck!==false){
      try{
        narrationCheck=await checkNarration({title:story.title||'',topic:story.topic||job.payload?.topic||'',checkWords:mediaSettings.narrationCheckWords!==false,sttChoice:mediaSettings.sttProvider||'auto',sttPriority:mediaSettings.sttPriority||null,sttModels:mediaSettings.sttModels||{},...(mediaSettings.sttExtra||{}),level:mediaSettings.narrationMatchLevel||'normal',scenes:story.scenes,files:sceneAudioFiles,durations:sceneDurations,language:channelProfile?.narration?.language||series.language||'English',env,getDuration:getAudioDuration,onProgress:m=>GenerationJob.findByIdAndUpdate(jobId,{$set:{lastHeartbeatAt:new Date()}}).catch(()=>{})});
        await Video.findByIdAndUpdate(video._id,{$set:{narrationCheck}});
        await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),level:narrationCheck.pass?'info':'warning',message:`Narration check: ${narrationCheck.summary}${narrationCheck.issues.length?` ${narrationCheck.issues.slice(0,4).join(' ')}`:''}`}}});
      }catch(e){await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),level:'warning',message:`Narration check could not run: ${e.message}`}}});}
    }else if(!mediaSettings.mockMode){await Video.findByIdAndUpdate(video._id,{$set:{narrationCheck:null}});await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),level:'info',message:'Narration check is turned off in Settings → AI providers → Narration.'}}});}
    await setVideoStatus(video._id,'AWAITING_APPROVAL',`Technical QA passed (${qaReport.score}/100).${narrationCheck&&!narrationCheck.pass?` Narration check found ${narrationCheck.issues.length} problem(s).`:''} Complete visual review before approval.`,'clear',attempt);
    await updateJob(jobId,100,'AWAITING_APPROVAL',`Technical QA passed (${qaReport.score}/100). Video ready for visual review.`,'COMPLETED',{completedAt:new Date(),lastHeartbeatAt:new Date()});
  }catch(e){
    if(e.code==='JOB_CANCELLED'||e.message==='JOB_CANCELLED'){
      await GenerationJob.findByIdAndUpdate(jobId,{$set:{status:'CANCELLED',step:'CANCELLED',cancelRequested:true,cancelledAt:new Date(),completedAt:new Date(),lastHeartbeatAt:new Date()},$push:{logs:{at:new Date(),message:'Job stopped because cancellation was requested; FFmpeg child process has exited.',level:'warning'}}});
      if(video?._id) await setVideoStatus(video._id,'CANCELLED','Generation cancelled. Saved scenes and narration are available to continue.','keep',attempt);
    }else{
      await GenerationJob.findByIdAndUpdate(jobId,{$set:{status:'FAILED',error:e.message,failedAt:new Date(),lastHeartbeatAt:new Date()},$push:{logs:{at:new Date(),message:e.message,level:'error'}}});
      if(video?._id) await setVideoStatus(video._id,'FAILED',e.message,'set',attempt);
    }
  }finally{aiEvents.off('progress',onAiProgress);busy=false;currentJobId=null;}
}

export function startWorker(){
  // Liveness heartbeat: long stages (image generation, OCR, TTS, FFmpeg) may
  // not log for minutes, so the worker refreshes lastHeartbeatAt on its own.
  setInterval(()=>{
    if(!busy||!currentJobId)return;
    GenerationJob.updateOne({_id:currentJobId,status:'RUNNING'},{$set:{lastHeartbeatAt:new Date()}})
      .catch(error=>console.error('Worker heartbeat failed:',error.message));
  },HEARTBEAT_INTERVAL_MS).unref();

  // Recover jobs whose worker stopped (crash/restart), at startup and every
  // minute. Only jobs with no heartbeat for 2 minutes are touched, so a job
  // owned by another live process is never interrupted.
  let recovering=false;
  const recover=async()=>{
    if(recovering)return; recovering=true;
    try{await recoverInterruptedJobs({GenerationJob,setVideoStatus,excludeJobId:currentJobId});}
    catch(error){console.error('Worker recovery failed:',error.message);}
    finally{recovering=false;}
  };
  recover();
  setInterval(recover,60_000).unref();

  setInterval(async()=>{
    if(busy)return;
    try{
      const job=await GenerationJob.findOneAndUpdate(
        {status:'QUEUED'},
        {$set:{status:'RUNNING',step:'STARTING',startedAt:new Date(),lastHeartbeatAt:new Date()}},
        {sort:{createdAt:1},returnDocument:'after'}
      );
      if(job)processJob(job).catch(error=>console.error('Worker job crashed outside its error handler:',error));
    }catch(error){
      // A temporary MongoDB error must not become an unhandled rejection
      // (which terminates Node). The next tick simply tries again.
      console.error('Worker poll failed; retrying on next tick:',error.message);
    }
  },1000);
  console.log('MongoDB job worker started (no Redis).');
}
