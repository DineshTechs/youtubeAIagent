import fs from 'node:fs/promises';
import path from 'node:path';
import Series from '../models/Series.js';
import Character from '../models/Character.js';
import Story from '../models/Story.js';
import Video from '../models/Video.js';
import GenerationJob from '../models/GenerationJob.js';
import {getActiveProvider, getAISettings, getMediaSettings} from '../services/ai/index.js';
import {env} from '../config/env.js';
import {generateImage,generateSpeech} from '../services/media/openaiMedia.js';
import {generateMockImage,generateMockSpeech} from '../services/media/mockMedia.js';
import {renderVideo,getAudioDuration} from '../services/video/renderer.js';
import {runVideoQualityAssurance} from '../services/video/qualityAssurance.js';
import {makeSrt} from '../utils/srt.js';
import {applyOpeningHook} from '../utils/openingRetention.js';
import {spawn} from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import {optimizeForGeneration} from '../services/youtubeSkills/index.js';
import {inspectImageText} from '../services/media/imageTextQa.js';
import {buildChannelProfile,channelProfileSummary} from '../services/channelProfile.js';

let busy=false;

function traceSafe(value, max=12000){
  if(value===undefined)return undefined;
  if(value===null)return null;
  if(typeof value==='string')return value.length>max?value.slice(0,max)+'…':value;
  try{
    const seen=new WeakSet();
    const json=JSON.stringify(value,(k,v)=>{
      if(typeof v==='object'&&v!==null){if(seen.has(v))return '[Circular]';seen.add(v);}
      if(typeof v==='string'&&v.length>4000)return v.slice(0,4000)+'…';
      return v;
    });
    return json.length>max?JSON.parse(json.slice(0,max).replace(/,?\s*[^,{}\[\]]*$/,'')||'null'):JSON.parse(json);
  }catch{return String(value).slice(0,max);}
}

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
  return Video.findOneAndUpdate({_id:videoId,status:{$ne:status}},update,{returnDocument:'after'});
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
      channelProfile=buildChannelProfile(series,{...(job.payload||{}),channelProfile:job.payload?.channelProfile||series.channelProfile});
      characters=await Character.find({seriesId:series._id,active:true});
      await updateJob(jobId,5,'RESUMING','Continuing failed video from saved state.');
      await setVideoStatus(video._id,'ASSETS_GENERATING','Resuming from saved assets.','clear',attempt);
    }else{
      await updateJob(jobId,2,'PLANNING','Loading active universe.');
      series=job.payload?.seriesId ? await Series.findById(job.payload.seriesId) : await Series.findOne({active:true});
      if(!series) throw new Error('No active channel profile. Create or select a channel in Channel / Niche settings.');
      channelProfile=buildChannelProfile(series,{...(job.payload||{}),channelProfile:job.payload?.channelProfile||series.channelProfile});
      characters=await Character.find({seriesId:series._id,active:true});
      const episodeNumber=(await Story.countDocuments({seriesId:series._id}))+1;
      await updateJob(jobId,8,'SCRIPT_GENERATING','Generating original story.');
      const aiProvider=await getActiveProvider();
      await updateJob(jobId,7,'AI_PROVIDER',`Using ${job.payload?.aiProvider || 'active'} AI provider.`);
      const recentStories=await Story.find({seriesId:series._id}).sort({createdAt:-1}).limit(12).select('title topic').lean();
      const topicIdeas=Array.isArray(series.topicIdeas)?series.topicIdeas.filter(Boolean):[];
      const cursor=Number(series.topicCursor||0);
      const rotatedTopic=topicIdeas.length ? topicIdeas[cursor % topicIdeas.length] : null;
      const generationTopic=job.payload?.topic || rotatedTopic || null;
      if(!job.payload?.topic && topicIdeas.length) await Series.findByIdAndUpdate(series._id,{$set:{topicCursor:(cursor+1)%topicIdeas.length}});
      const storyData=await traceStage(jobId,'STORY_GENERATION',{topic:generationTopic,language:series.language||'English',topicSource:job.payload?.topic?'user':rotatedTopic?'research-rotation':'ai-selected',episodeNumber,seriesId:series._id,niche:series.niche,channelProfile:channelProfileSummary(channelProfile),contentStrategy:series.contentStrategy||null,channelResearch:series.channelResearch?.strategy||null,recentStories,characterCount:characters.length,provider:job.payload?.aiProvider||'active'},()=>aiProvider.generateStory({series,channelProfile,characters,episodeNumber,topic:generationTopic,recentStories,language:channelProfile.language,format:job.payload?.format||channelProfile.content.primaryFormat||'Short',durationSec:job.payload?.durationSec||55,hookStyle:job.payload?.hookStyle||channelProfile.content.hookStyle,audience:job.payload?.audience||channelProfile.audience.description}),{provider:job.payload?.aiProvider||'active',topicSource:job.payload?.topic?'user':rotatedTopic?'research-rotation':'ai-selected'});
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
      const hindiRequested=String(requestedLanguage).toLowerCase().startsWith('hindi');
      const englishRequested=String(requestedLanguage).toLowerCase().startsWith('english');
      const optimizedHookMatchesLanguage=optimizedHook && (!hindiRequested||/[\u0900-\u097f]/u.test(optimizedHook)) && (!englishRequested||(/[a-z]/i.test(optimizedHook)&&!/[\u0900-\u097f]/u.test(optimizedHook)));
      storyData.hook=optimizedHookMatchesLanguage?optimizedHook:originalHook;
      const openingHookResult=applyOpeningHook(storyData,requestedLanguage);
      await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:openingHookResult.applied?(openingHookResult.inserted?`Opening hook inserted into spoken scene 1 narration (${requestedLanguage}).`:'Opening hook already present in scene 1 narration.'):`Opening hook not inserted: ${openingHookResult.reason}`,level:openingHookResult.applied?'info':'warning'}}});
      const qa=await traceStage(jobId,'SCRIPT_QA',{title:storyData?.title,sceneCount:Array.isArray(storyData?.scenes)?storyData.scenes.length:0,openingHook:openingHookResult},()=>aiProvider.qualityCheck({story:storyData,series,channelProfile}),{provider:job.payload?.aiProvider||'active'});
      await updateJob(jobId,22,'SCRIPT_QA',`Script QA ${qa.pass?'passed':'failed'} (${qa.score ?? 'n/a'}). YouTube Skills: ${youtubeOptimization.successCount}/${youtubeOptimization.totalSkills} completed, ${youtubeOptimization.skippedCount} skipped, ${youtubeOptimization.failedCount} failed.`);
      if(!qa.pass) throw new Error(`Script QA failed: ${(qa.notes||[]).join('; ')}`);
      story=await Story.create({...storyData,seriesId:series._id,episodeNumber,qa,youtubeOptimization,channelProfile});
      video=await Video.create({storyId:story._id,title:story.title,status:'ASSETS_GENERATING',qa,statusHistory:[{status:'ASSETS_GENERATING',message:'Video created; media generation started.',attempt:0,source:'VIDEO'}]});
      await GenerationJob.findByIdAndUpdate(jobId,{$set:{videoId:video._id}});
    }

    const aiMedia=await getAISettings();
    const mediaSettings=await getMediaSettings();
    if(!mediaSettings.mockMode && !mediaSettings.generationEnabled) throw new Error('Real media generation is disabled in Settings. Enable Media Generation.');
    const selectedImageProvider=String(aiMedia.media?.imageProvider || env.imageProvider || 'openai').toLowerCase();
    const selectedImageMeta=aiMedia.media?.imageProviders?.[selectedImageProvider] || (selectedImageProvider === 'cloudflare' ? {name:'Cloudflare Workers AI', configured:Boolean(env.cloudflareAccountId && env.cloudflareApiToken), model:env.cloudflareImageModel} : selectedImageProvider === 'openai' ? {name:'OpenAI', configured:Boolean(env.openaiKey), model:env.imageModel} : {name:'Mock / Development', configured:true, model:'local'});
    const useMockImages = selectedImageProvider === 'mock' || mediaSettings.mockMode;
    const effectiveMediaMode = useMockImages ? 'mock' : 'real';
    if(!useMockImages && !selectedImageMeta?.configured) throw new Error(`Selected image provider ${selectedImageProvider} is not configured. Configure its credentials in Settings/.env.`);
    await assertNotCancelled(jobId,video._id,attempt);
    const base=path.resolve('storage','videos',String(video._id)); await fs.mkdir(base,{recursive:true});
    const scenesDir=path.join(base,'scenes'); await fs.mkdir(scenesDir,{recursive:true});
    await updateJob(jobId,24,'ASSETS_GENERATING',effectiveMediaMode === 'mock' ? `Media mode: MOCK (${selectedImageMeta?.name || 'Mock / Development'}). [provider=${selectedImageProvider}]` : `Media mode: REAL (${selectedImageMeta?.name || selectedImageProvider}). [provider=${selectedImageProvider}]`);
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
      if(existing?.scenes?.length===storyDoc.scenes.length) return existing;
      if(!activeProvider || typeof activeProvider.generateJson!=='function') return null;
      const charactersForPlan=characters.map(c=>({name:c.name,appearance:c.appearance||'',personality:c.personality||''}));
      const input={
        series:{name:seriesDoc.name,premise:seriesDoc.premise,niche:seriesDoc.niche,visualStyle:seriesDoc.visualStyle,language:seriesDoc.language},
        channelProfile:profile,
        characters:charactersForPlan,
        scenes:storyDoc.scenes.map(s=>({sceneNumber:s.sceneNumber,narration:s.narration,visualPrompt:s.visualPrompt,onScreenText:s.onScreenText,durationSec:s.durationSec}))
      };
      const instruction=`Act as the visual director for a YouTube video for this channel profile. Translate every narration line into a literal, recognizable visual moment suitable for the channel's niche, audience, tone and selected visual style. The narration is the source of truth: identify the exact named subjects, what they are doing, where they are, and what changes in this moment. Do not replace specific events with generic portraits, decorative scenery, abstract symbols or unrelated stock-style imagery. Choose a camera shot that clearly shows the narrated action and important objects; vary wide, medium and close-up shots naturally. Keep recurring hosts, products, locations or fictional characters visually consistent where applicable. For every scene return sceneNumber, subject, action, setting, importantObjects, emotion, camera, composition and visualPrompt. Make each visualPrompt concrete and self-contained, matching aspect ratio ${profile?.visual?.aspectRatio||'9:16'} and visual style ${profile?.visual?.style||seriesDoc.visualStyle||'cinematic visuals'}. If subtitles are enabled, reserve a visually quiet lower safe area without obscuring the main action. Do not put unrequested text in the image. Do not impose children's-content styling or restrictions unless the channel profile safetyMode is kids-and-family. Return only JSON with shape {"scenes":[...]} and no markdown.`;
      const result=await activeProvider.generateJson(instruction,input,'visual director');
      if(!result || !Array.isArray(result.scenes)) throw new Error('Visual Director returned an invalid scene plan.');
      const byNumber=new Map(result.scenes.map(x=>[Number(x.sceneNumber),x]));
      const normalized=storyDoc.scenes.map((scene,i)=>{
        const n=Number(scene.sceneNumber||i+1);
        const plan=byNumber.get(n);
        if(!plan) throw new Error(`Visual Director did not return a plan for scene ${n}.`);
        const vp=limitPromptText(plan.visualPrompt,1200);
        if(!vp) throw new Error(`Visual Director returned an empty visual prompt for scene ${n}.`);
        scene.visualPrompt=vp;
        return {
          sceneNumber:n,
          subject:limitPromptText(plan.subject,400),
          action:limitPromptText(plan.action,500),
          setting:limitPromptText(plan.setting,400),
          importantObjects:limitPromptText(plan.importantObjects,500),
          emotion:limitPromptText(plan.emotion,250),
          camera:limitPromptText(plan.camera,350),
          composition:limitPromptText(plan.composition,500),
          visualPrompt:vp
        };
      });
      storyDoc.pipelineData={...(storyDoc.pipelineData||{}),visualDirectorPlan:{version:1,createdAt:new Date(),scenes:normalized}};
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
    function buildSceneImagePrompt(scene,index,visualPlan=null){
      // V1.4.1: send a visual-only brief to image models. Never expose production
      // directives, narration labels, scene numbers, QA text or workflow metadata.
      const cleanVisualText=(value,max=420)=>{
        let text=String(value||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
        const metaPatterns=[
          /\bmust\s+show\b/ig, /\bshow\s+this\s+exact\b/ig,
          /\bexact\s+scene\b/ig, /\bnarration\s+continuity\b/ig,
          /\bscene\s*\#?\s*\d+\b/ig, /\bvisual\s+director\b/ig,
          /\bshot\s+plan\b/ig, /\bproduction\s+instruction[s]?\b/ig,
          /\bdo\s+not\s+forget\b/ig, /\bimage\s+prompt\b/ig,
          /\boutput\s+only\b/ig, /\bstrictly\s+avoid\b/ig
        ];
        for(const pattern of metaPatterns) text=text.replace(pattern,' ');
        text=text.replace(/\b(?:SUBJECT|ACTION|SETTING|IMPORTANT OBJECTS|EMOTION|CAMERA|COMPOSITION|NARRATION CONTEXT|CHARACTER CONTINUITY)\s*:/gi,' ');
        text=text.replace(/\s+/g,' ').replace(/^[\s:;,.!-]+|[\s:;,.!-]+$/g,'').trim();
        return text.length<=max?text:text.slice(0,max).replace(/\s+\S*$/,'').trim();
      };

      const plan=visualPlan?.scenes?.find(x=>Number(x.sceneNumber)===Number(scene.sceneNumber||index+1));
      const visualBrief=cleanVisualText(scene.visualPrompt,650);
      const planVisuals=plan
        ? [plan.subject,plan.action,plan.setting,plan.importantObjects,plan.emotion,plan.camera,plan.composition]
            .map(v=>cleanVisualText(v,180)).filter(Boolean).join('. ')
        : '';
      const characterContext=characters
        .map(c=>cleanVisualText(`${c.name}, ${c.appearance || 'consistent appearance'}`,160))
        .filter(Boolean).join('; ').slice(0,260);
      const rawStyle=cleanVisualText(channelProfile?.visual?.style||series.visualStyle||'cinematic, high-quality visuals',120);
      const style=/(cartoon|chibi|anime|comic|flat|illustrat|kawaii|storybook|clay|2d|3d animation|animated)/i.test(rawStyle)
        ? rawStyle : `${rawStyle}, polished cinematic lighting`;
      const vd=aiMedia.visualDirector||{};
      const continuity=vd.continuity===false
        ? 'Keep the subjects natural and appropriate to this single moment.'
        : 'Keep recurring people, hosts, products or fictional characters visually consistent across scenes.';
      const noText=(vd.avoidTextInImages===false || channelProfile?.visual?.avoidTextInImages===false) ? '' :
        'The picture must contain no writing of any kind: no letters, words, numbers, captions, subtitles, signs, labels, logos, watermarks, interface elements or typography. Any screens or signs must be blank and unmarked.';
      const prompt=[
        `Create one original ${channelProfile?.visual?.aspectRatio||'9:16'} image for a YouTube video in the channel niche ${channelProfile?.niche||series.niche||'General'}.`,
        `Depict this visual moment: ${visualBrief || planVisuals || 'A clear, expressive story moment with a recognizable subject and setting.'}.`,
        planVisuals && planVisuals!==visualBrief ? `Visual details: ${planVisuals}.` : '',
        characterContext ? `Character appearance: ${characterContext}.` : '',
        continuity,
        `Visual style: ${style}.`,
        'Use one coherent scene, a clear main subject, natural anatomy, expressive body language and a recognizable setting. Show the described action rather than a generic portrait.',
        'Keep important faces, hands and story objects in the upper and middle portions of the frame.',
        noText,
        'Generate only the image; do not reproduce any instructions or metadata.'
      ].filter(Boolean).join(' ');
      return cleanVisualText(prompt,1850);
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
      const forceThisScene=Number(job.payload?.forceRegenerateSceneNumber||0)===Number(sceneNumber);
      const savedAsset=video.mediaAssetDetails?.find(x=>Number(x.sceneNumber)===Number(sceneNumber));
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
      try{const asset=await validateImageAsset(p,expectedMode,sceneNumber); reusable=asset.valid&&!forceThisScene;}catch{}
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
              generatedPath=await generateImage(usedPrompt,p,selectedImageProvider,{width:VIDEO_WIDTH,height:VIDEO_HEIGHT,aspectRatio:channelProfile?.visual?.aspectRatio||mediaSettings.imageAspectRatio||'9:16',imageSize:mediaSettings.imageSize});
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
              generatedPath=await generateImage(usedPrompt,p,selectedImageProvider,{width:VIDEO_WIDTH,height:VIDEO_HEIGHT,aspectRatio:channelProfile?.visual?.aspectRatio||mediaSettings.imageAspectRatio||'9:16',imageSize:mediaSettings.imageSize});
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
            const strictTextQa=String(process.env.IMAGE_TEXT_QA_STRICT||'').toLowerCase()==='true';
            for(let qaAttempt=0;qaAttempt<=2;qaAttempt++){
              imageTextQa=await inspectImageText(p,{strict:strictTextQa,minWords:4});
              if(!imageTextQa.suspicious) break;
              if(qaAttempt===2){
                throw new Error(`Scene ${sceneNumber} still contains unwanted text after 2 regeneration attempts: ${imageTextQa.reason}. OCR: ${imageTextQa.text.slice(0,220)}`);
              }
              await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:`Scene ${sceneNumber}: OCR detected unwanted image text (${imageTextQa.reason}, confidence ${Math.round(imageTextQa.confidence)}%). Regenerating image, attempt ${qaAttempt+1}/2.`,level:'warning'}}});
              const retryPrompt=`${usedPrompt} IMPORTANT: The previous image incorrectly contained written text. Create a clean image with absolutely no visible letters, words, numbers, captions, subtitles, signs, labels, logos, watermarks or typography. Keep all screens and signs blank.`;
              const retryPath=await generateImage(retryPrompt,p,selectedImageProvider,{width:VIDEO_WIDTH,height:VIDEO_HEIGHT,aspectRatio:channelProfile?.visual?.aspectRatio||mediaSettings.imageAspectRatio||'9:16',imageSize:mediaSettings.imageSize});
              if(retryPath && path.resolve(String(retryPath))!==path.resolve(p)) await fs.copyFile(String(retryPath),p);
              usedPrompt=retryPrompt;
              normalized=await normalizeSceneImage(p);
            }
            imageTextQa.checked=true;
            if(!imageTextQa.suspicious && imageTextQa.hasText){
              await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:`Scene ${sceneNumber}: OCR found possible readable text but no production-instruction leakage; accepted in non-strict mode.`,level:'info'}}});
            }
          } catch(ocrError) {
            if(String(ocrError?.message||'').includes('still contains unwanted text')) throw ocrError;
            await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:`Scene ${sceneNumber}: OCR inspection unavailable (${ocrError.message}). Continuing with image prompt safeguards; install dependencies and verify OCR runtime.`,level:'warning'}}});
          }
          const asset=await validateImageAsset(p,expectedMode,sceneNumber);
          return {
            path:p,
            mode:expectedMode,
            resolution:`${normalized.width}x${normalized.height}`,
            normalized:normalized.normalized,
            provider:mediaSettings.mockMode?'mock':selectedImageProvider,
            model:selectedImageMeta?.model || env.imageModel,
            sizeBytes:asset.sizeBytes,
            valid:true,
            reused:false,
            regenerated:true,
            safetyRewriteUsed,
            imagePromptUsed:usedPrompt
          };
        },{
          mediaMode:expectedMode,
          provider:mediaSettings.mockMode?'mock':selectedImageProvider,
          model:selectedImageMeta?.model || env.imageModel,
          reused:false,
          regenerated:true,
          requestedOutput:p
        });
        assetDetails.push({sceneNumber,path:p,mode:expectedMode,sizeBytes:generated.sizeBytes,valid:true,generatedAt:new Date(),reused:false,prompt:sceneImagePrompt,sourceVisualPrompt:scene.visualPrompt,visualDirectorPlan:visualDirectorPlan?.scenes?.find(x=>Number(x.sceneNumber)===Number(sceneNumber))||null,resolution:`${VIDEO_WIDTH}x${VIDEO_HEIGHT}`});
        if(forceThisScene){
          await GenerationJob.findByIdAndUpdate(jobId,{$push:{logs:{at:new Date(),message:`Scene ${sceneNumber} regenerated to a versioned asset: ${path.basename(p)}. The renderer will use this exact new file.`,level:'info'}}});
        }
        await updateJob(jobId,25+Math.round(((i+1)/story.scenes.length)*30),'ASSETS_GENERATING',`Generated scene ${i+1}/${story.scenes.length} (${expectedMode.toUpperCase()}).`);
      }else{
        const normalized=await normalizeSceneImage(p);
        const asset=await validateImageAsset(p,expectedMode,sceneNumber);
        await traceStage(jobId,`SCENE_${i+1}_IMAGE`,{sceneNumber,visualPrompt:sceneImagePrompt,sourceVisualPrompt:scene.visualPrompt,narration:scene.narration,onScreenText:scene.onScreenText},async()=>({path:p,mode:expectedMode,sizeBytes:asset.sizeBytes,valid:true,reused:true,resolution:`${normalized.width}x${normalized.height}`,normalized:normalized.normalized}),{mediaMode:expectedMode,provider:selectedImageProvider,model:selectedImageMeta?.model || env.imageModel,reused:true});
        assetDetails.push({sceneNumber,path:p,mode:expectedMode,sizeBytes:asset.sizeBytes,valid:true,generatedAt:new Date(),reused:true,prompt:sceneImagePrompt,sourceVisualPrompt:scene.visualPrompt,resolution:`${VIDEO_WIDTH}x${VIDEO_HEIGHT}`,normalized:normalized.normalized});
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
      for(let i=0;i<story.scenes.length;i++){
        await assertNotCancelled(jobId,video._id,attempt);
        const sceneAudio=path.join(sceneAudioDir,`scene-${String(i+1).padStart(3,'0')}.mp3`);
        let ready=false;
        try{const st=await fs.stat(sceneAudio);ready=st.size>100;}catch{}
        if(!ready){
          await fs.rm(sceneAudio,{force:true}).catch(()=>{});
          if(mediaSettings.mockMode) await generateMockSpeech(story.scenes[i].narration,sceneAudio);
          else await generateSpeech(story.scenes[i].narration,sceneAudio,channelProfile?.narration?.language||series.language||'English',channelProfile?.narration||{});
        }
        const duration=await getAudioDuration(sceneAudio);
        sceneAudioFiles.push(sceneAudio);
        sceneDurations.push(duration);
        // Persist measured TTS timing as the canonical scene timing. Estimated
        // LLM durations must not drive captions after real narration is rendered.
        if(story.scenes[i]) story.scenes[i].durationSec=duration;
      }
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
    await setVideoStatus(video._id,'VIDEO_RENDERING','Rendering video.','clear',attempt);
    await updateJob(jobId,65,'VIDEO_RENDERING','Rendering vertical MP4 with FFmpeg.');
    let lastProgress=-1;
    const rendered=await traceStage(jobId,'FFMPEG_RENDER',{videoId:video._id,sceneCount:sceneFiles.length,audioFile:audio,sceneAudioFiles,sceneDurations,subtitlesFile:srt,outDir:base},()=>renderVideo({videoId:video._id,sceneFiles,sceneAudioFiles,sceneDurations,audioFile:audio,subtitlesFile:srt,outDir:base,width:VIDEO_WIDTH,height:VIDEO_HEIGHT,fps:VIDEO_FPS,imageFit:IMAGE_FIT,subtitlesEnabled:aiMedia.video?.subtitlesEnabled??true,subtitleFontSize:aiMedia.video?.subtitleFontSize||38,subtitleMarginV:aiMedia.video?.subtitleMarginV||85,subtitleFontName:aiMedia.video?.subtitleFontName||'Nirmala UI',shouldCancel:async()=>{const state=await GenerationJob.findById(jobId).select('status cancelRequested').lean();return !state||state.status==='CANCELLED'||Boolean(state.cancelRequested);},onProgress:p=>{
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
    },{qaVersion:'1.5.0',checks:['file','full-decode','profile-aspect-ratio','resolution','duration','black-frames','audio-silence','opening-frame-samples','opening-black-frame-scan','opening-audio-start','opening-hook-caption','scene-assets','subtitle-file','manual-visual-review']});
    await setVideoStatus(video._id,'AWAITING_APPROVAL',`Technical QA passed (${qaReport.score}/100). Complete visual review before approval.`,'clear',attempt);
    await updateJob(jobId,100,'AWAITING_APPROVAL',`Technical QA passed (${qaReport.score}/100). Video ready for visual review.`,'COMPLETED',{completedAt:new Date(),lastHeartbeatAt:new Date()});
  }catch(e){
    if(e.code==='JOB_CANCELLED'||e.message==='JOB_CANCELLED'){
      await GenerationJob.findByIdAndUpdate(jobId,{$set:{status:'CANCELLED',step:'CANCELLED',cancelRequested:true,cancelledAt:new Date(),completedAt:new Date(),lastHeartbeatAt:new Date()},$push:{logs:{at:new Date(),message:'Job stopped because cancellation was requested; FFmpeg child process has exited.',level:'warning'}}});
      if(video?._id) await setVideoStatus(video._id,'CANCELLED','Generation cancelled. Saved scenes and narration are available to continue.','keep',attempt);
    }else{
      await GenerationJob.findByIdAndUpdate(jobId,{$set:{status:'FAILED',error:e.message,failedAt:new Date(),lastHeartbeatAt:new Date()},$push:{logs:{at:new Date(),message:e.message,level:'error'}}});
      if(video?._id) await setVideoStatus(video._id,'FAILED',e.message,'set',attempt);
    }
  }finally{busy=false;}
}

export function startWorker(){
  // Recover cancellation requests persisted by older builds that marked the
  // video CANCELLED but left its GenerationJob RUNNING during FFmpeg rendering.
  (async()=>{
    const interrupted=await GenerationJob.find({status:'RUNNING',cancelRequested:true}).select('_id videoId retryCount').lean();
    for(const item of interrupted){
      await GenerationJob.findByIdAndUpdate(item._id,{$set:{status:'CANCELLED',step:'CANCELLED',cancelledAt:new Date(),completedAt:new Date()},$push:{logs:{at:new Date(),message:'Recovered a pending cancellation request during backend startup.',level:'warning'}}});
      if(item.videoId) await setVideoStatus(item.videoId,'CANCELLED','Generation cancelled during backend restart. Saved assets can be resumed.','keep',Number(item.retryCount||0));
    }
  })().catch(error=>console.error('Worker cancellation recovery failed:',error));
  setInterval(async()=>{
    if(busy)return;
    const job=await GenerationJob.findOneAndUpdate(
      {status:'QUEUED'},
      {$set:{status:'RUNNING',step:'STARTING',startedAt:new Date(),lastHeartbeatAt:new Date()}},
      {sort:{createdAt:1},returnDocument:'after'}
    );
    if(job)processJob(job);
  },1000);
  console.log('MongoDB job worker started (no Redis).');
}