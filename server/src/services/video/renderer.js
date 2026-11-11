import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import {env} from '../../config/env.js';
import {parseAudibleDurationFromFfmpegOutput} from '../../utils/audioTiming.js';

const ffmpegPath = env.ffmpegPath || ffmpegStatic || 'ffmpeg';

function run(cmd,args,{shouldCancel=null}={}){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{stdio:['ignore','pipe','pipe']});
    let out='',err='',settled=false,cancelTimer=null;
    const finish=(fn,value)=>{if(settled)return;settled=true;if(cancelTimer)clearInterval(cancelTimer);fn(value);};
    const stop=()=>{if(settled)return;try{p.kill();}catch{}};
    p.stdout.on('data',d=>out+=d);
    p.stderr.on('data',d=>err+=d);
    p.on('error',e=>finish(reject,new Error(`Unable to start FFmpeg (${cmd}): ${e.message}`)));
    p.on('close',code=>{
      if(shouldCancel && cancelled) {
        const error=new Error('JOB_CANCELLED');error.code='JOB_CANCELLED';return finish(reject,error);
      }
      return code===0?finish(resolve,out):finish(reject,new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-4000)}`));
    });
    let cancelled=false;
    if(typeof shouldCancel==='function'){
      cancelTimer=setInterval(async()=>{
        if(settled||cancelled)return;
        try{if(await shouldCancel()){cancelled=true;stop();}}catch{}
      },500);
    }
  });
}

function escapeConcatPath(file){
  return file.replace(/\\/g,'/').replace(/'/g,"'\\''");
}

function isUsableFile(file){
  return Boolean(file) && existsSync(file);
}

async function validateAudio(audioFile){
  if(!isUsableFile(audioFile)) return false;
  const stat=await fs.stat(audioFile);
  // Mock TTS intentionally creates an empty file. Treat that as "no audio".
  if(stat.size < 100) return false;

  try{
    await run(ffmpegPath,['-hide_banner','-loglevel','error','-i',audioFile,'-f','null','-']);
    return true;
  }catch(error){
    throw new Error(`Narration audio is invalid or incomplete: ${error.message}`);
  }
}

async function renderSceneClip(sceneFile,clipFile,duration,{width=1080,height=1920,fps=30,imageFit='cover',shouldCancel=null}={}){
  let inputFile=sceneFile;
  let temporaryPng=null;

  // Real providers and the built-in mock now produce raster images. SVG is
  // intentionally rejected here because ffmpeg-static has no SVG decoder and
  // we do not want a native image dependency just to boot the API.
  if(path.extname(sceneFile).toLowerCase()==='.svg') {
    throw new Error(`SVG scene asset is not supported by the bundled FFmpeg: ${sceneFile}. Regenerate the scene as a raster image.`);
  }

  try {
    await run(ffmpegPath,[
    '-y',
    '-hide_banner',
    '-loglevel','error',
    '-loop','1',
    '-i',inputFile,
    '-t',String(duration),
    '-vf', imageFit === 'contain' ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p` : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`,
    '-r',String(fps),
    '-an',
    '-c:v','libx264',
    '-preset','veryfast',
    '-tune','stillimage',
    '-pix_fmt','yuv420p',
    '-movflags','+faststart',
    clipFile
  ],{shouldCancel});
  } finally {
    if(temporaryPng) await fs.rm(temporaryPng,{force:true}).catch(()=>{});
  }
}

export async function getAudioDuration(audioFile){
  if(!isUsableFile(audioFile)) throw new Error(`Audio file is missing: ${audioFile}`);
  const stat=await fs.stat(audioFile);
  if(stat.size<100) throw new Error(`Audio file is empty or too small: ${audioFile}`);
  return new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,['-hide_banner','-i',audioFile,'-f','null','-'],{stdio:['ignore','pipe','pipe']});
    let err='';
    p.stderr.on('data',d=>err+=d);
    p.on('error',e=>reject(new Error(`Unable to inspect audio (${ffmpegPath}): ${e.message}`)));
    p.on('close',code=>{
      const duration=parseAudibleDurationFromFfmpegOutput(err);
      if(!duration) return reject(new Error(`Could not determine audible narration duration for ${audioFile}. FFmpeg output: ${err.slice(-1200)}`));
      resolve(duration);
    });
  });
}

export async function renderVideo({videoId,sceneFiles,sceneAudioFiles,sceneDurations,audioFile,subtitlesFile,outDir,onProgress,width=1080,height=1920,fps=30,imageFit='cover',shouldCancel=null}){
  if(!Array.isArray(sceneFiles)||sceneFiles.length===0) throw new Error('No scene assets are available for video rendering.');
  if(!Array.isArray(sceneAudioFiles)||sceneAudioFiles.length!==sceneFiles.length) throw new Error(`Scene narration audio set is incomplete (${sceneAudioFiles?.length||0}/${sceneFiles.length}).`);
  if(!existsSync(ffmpegPath)&&ffmpegPath!=='ffmpeg') throw new Error(`FFmpeg executable was not found at: ${ffmpegPath}`);
  await fs.mkdir(outDir,{recursive:true}); const sceneDir=path.join(outDir,'scene-clips'); await fs.mkdir(sceneDir,{recursive:true});
  let durations=(Array.isArray(sceneDurations)?sceneDurations:[]).map(Number);
  if(durations.length!==sceneFiles.length||durations.some(d=>!Number.isFinite(d)||d<=0)){
    durations=[];
    for(const audioScene of sceneAudioFiles) durations.push(await getAudioDuration(audioScene));
  }
  const totalDuration=durations.reduce((a,b)=>a+b,0); const clipFiles=[]; onProgress?.(5);
  for(let i=0;i<sceneFiles.length;i++){
    const sceneFile=sceneFiles[i], audioScene=sceneAudioFiles[i];
    if(!isUsableFile(sceneFile)) throw new Error(`Scene asset is missing: ${sceneFile}`);
    if(!isUsableFile(audioScene)) throw new Error(`Scene narration audio is missing: ${audioScene}`);
    if(!(await validateAudio(audioScene))) throw new Error(`Scene ${i+1} narration audio is invalid: ${audioScene}`);
    const clipFile=path.join(sceneDir,`scene-${String(i+1).padStart(3,'0')}.mp4`);
    // Always remove the prior intermediate clip before rendering. This prevents
    // stale scene clips from surviving a selective image regeneration on Windows
    // or after an interrupted render.
    await fs.rm(clipFile,{force:true}).catch(()=>{});
    await renderSceneClip(sceneFile,clipFile,Math.max(0.5,durations[i]),{width,height,fps,imageFit,shouldCancel});
    const clipStat=await fs.stat(clipFile);
    if(!clipStat.isFile()||clipStat.size<100) throw new Error(`Rendered scene clip ${i+1} is missing or empty.`);
    clipFiles.push(clipFile);
    onProgress?.(5+Math.round(((i+1)/sceneFiles.length)*45));
  }
  const videoConcat=path.join(outDir,'video-concat.txt');
  await fs.writeFile(videoConcat,['ffconcat version 1.0',...clipFiles.map(f=>`file '${escapeConcatPath(f)}'`)].join('\n'));
  const audioConcat=path.join(outDir,'audio-concat.txt');
  await fs.writeFile(audioConcat,['ffconcat version 1.0',...sceneAudioFiles.map(f=>`file '${escapeConcatPath(f)}'`)].join('\n'));
  const silentVideo=path.join(outDir,'video-silent.mp4');
  await fs.rm(silentVideo,{force:true}).catch(()=>{});
  await run(ffmpegPath,['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',videoConcat,'-c','copy',silentVideo],{shouldCancel}); onProgress?.(65);
  const combinedAudio=path.join(outDir,'narration.mp3');
  await run(ffmpegPath,['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',audioConcat,'-c:a','libmp3lame','-q:a','4',combinedAudio],{shouldCancel});
  if(!(await validateAudio(combinedAudio))) throw new Error('Combined narration audio is invalid or incomplete.');
  // Give every render an immutable filename. Reusing final.mp4 can cause the
  // browser, reverse proxy, or CDN to serve a previously cached render after
  // selective scene regeneration. The Video document is updated with this path.
  const renderVersion=`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const videoPath=path.join(outDir,`final-${renderVersion}.mp4`);
  const canBurnSubtitles=Boolean(subtitlesFile&&isUsableFile(subtitlesFile));
  if(canBurnSubtitles){
    // Portrait Shorts profile: compact captions, horizontally centred and
    // placed in the lower safe area (not the vertical middle).
    const portrait = height >= width;
    const subtitleFontSize = portrait ? 6 : 5;
    const marginV = portrait ? 20 : 14;
    const marginH = portrait ? 24 : 18;
    const subtitlePath=path.resolve(subtitlesFile).replace(/\\/g,'/').replace(/^([A-Za-z]):/,'$1\\:').replace(/'/g,"\\'");
    const style=`FontName=Arial,FontSize=${subtitleFontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=0.8,Shadow=0,Alignment=2,MarginL=${marginH},MarginR=${marginH},MarginV=${marginV},WrapStyle=2,Bold=0`;
    const filter=`subtitles='${subtitlePath}':force_style='${style}'`;
    await run(ffmpegPath,['-y','-hide_banner','-loglevel','error','-i',silentVideo,'-i',combinedAudio,'-map','0:v:0','-map','1:a:0','-vf',filter,'-c:v','libx264','-preset','veryfast','-crf','21','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-shortest','-movflags','+faststart',videoPath],{shouldCancel});
  }else{
    await run(ffmpegPath,['-y','-hide_banner','-loglevel','error','-i',silentVideo,'-i',combinedAudio,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','128k','-shortest',videoPath],{shouldCancel});
  }
  onProgress?.(95);
  return {videoPath,audioFile:combinedAudio,subtitlesFile:canBurnSubtitles?subtitlesFile:null,subtitlesBurned:canBurnSubtitles,subtitleStyle:canBurnSubtitles?{fontSize:height>=width?6:5,alignment:'bottom-center',horizontalAlignment:'center',verticalPosition:'lower-safe-area',maxLines:2,profile:height>=width?'shorts-9:16':'landscape'}:null,durationSec:Number(totalDuration.toFixed(3)),sceneDurations:durations,sceneCount:sceneFiles.length,narrationSynchronized:true};
}
