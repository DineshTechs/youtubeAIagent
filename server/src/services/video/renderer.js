import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import {env} from '../../config/env.js';
import {parseAudibleDurationFromFfmpegOutput} from '../../utils/audioTiming.js';
import {fileURLToPath} from 'node:url';
import {motionFilter,LEAD_IN_SECONDS} from '../../utils/engagement.js';

const ffmpegPath = env.ffmpegPath || ffmpegStatic || 'ffmpeg';

// Caption font shipped with the app (server/assets/fonts). Linux servers usually
// have no Hindi font, so Devanagari captions showed as empty boxes; Windows-only
// fonts such as Nirmala UI are swapped for this one there.
export const BUNDLED_FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts');
export const BUNDLED_CAPTION_FONT = 'Poppins Medium';
const WINDOWS_ONLY_FONTS = /^(nirmala ui|nirmala text|mangal|aparajita|kokila|utsaah|arial|segoe ui|calibri|tahoma|verdana|times new roman)$/i;
export function captionFont(name, platform = process.platform) {
  const n = String(name || '').trim();
  if (platform !== 'win32' && (!n || WINDOWS_ONLY_FONTS.test(n))) return BUNDLED_CAPTION_FONT;
  return n || 'Nirmala UI';
}
const filterPath = p => path.resolve(p).replace(/\\/g,'/').replace(/^([A-Za-z]):/,'$1\\:').replace(/'/g,"\\'");

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

async function renderSceneClip(sceneFile,clipFile,duration,{width=1080,height=1920,fps=30,imageFit='cover',shouldCancel=null,motion=null}={}){
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
    ...(motion!=null?['-framerate',String(fps)]:[]),
    '-loop','1',
    '-i',inputFile,
    '-t',String(duration),
    // Fit the frame, then (optionally) a slow zoom/pan so still images feel alive.
    '-vf', `${imageFit === 'contain' ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black` : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`}${motion!=null?`,${motionFilter(motion,{width,height,fps,duration})}`:''},format=yuv420p`,
    '-r',String(fps),
    '-an',
    '-c:v','libx264',
    '-preset','veryfast',
    ...(motion!=null?[]:['-tune','stillimage']),
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

// Subtitle style from Settings. libass renders SRT on a 288-unit-high canvas,
// so pixel values (relative to the output frame) are converted to that scale.
// Defaults reproduce the previous hard-coded look: ~38-40 px text, 7% above the
// bottom edge, centred. Nirmala UI (Windows) includes Devanagari glyphs;
// Arial does not, so Hindi captions no longer depend on font fallback.
export function buildSubtitleStyle({width=1080,height=1920,fontSizePx=38,fontName='Nirmala UI',position='bottom',offsetPct=7}={}){
  const H=Math.max(1,Number(height)||1920), W=Math.max(1,Number(width)||1080);
  const px=Math.max(16,Math.min(96,Number(fontSizePx)||38));
  const fontSize=Number((px*288/H).toFixed(2));
  const pct=Math.max(2,Math.min(40,Number(offsetPct)||7));
  const marginV=Math.round(pct/100*288);
  const marginH=H>=W?24:18; // unchanged side margins (same line wrapping as before)
  // FFmpeg's force_style on SRT input uses LEGACY SSA alignment codes:
  // 2 = bottom-centre, 6 = top-centre, 10 = middle-centre (not ASS numpad 8/5).
  const alignment=position==='top'?6:position==='center'?10:2;
  const safeFont=String(fontName||'Nirmala UI').replace(/[,:'"\\]/g,'').trim().slice(0,80)||'Nirmala UI';
  return {
    forceStyle:`FontName=${safeFont},FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=0.8,Shadow=0,Alignment=${alignment},MarginL=${marginH},MarginR=${marginH},MarginV=${marginV},WrapStyle=2,Bold=0`,
    summary:{fontName:safeFont,fontSizePx:px,position:position==='top'||position==='center'?position:'bottom',offsetPct:pct,assFontSize:fontSize,assMarginV:marginV,alignment}
  };
}

export async function renderVideo({videoId,sceneFiles,sceneAudioFiles,sceneDurations,audioFile,subtitlesFile,outDir,onProgress,width=1080,height=1920,fps=30,imageFit='cover',shouldCancel=null,subtitlesEnabled=true,subtitleFontSize=38,subtitleFontName='Nirmala UI',subtitlePosition='bottom',subtitleOffsetPct=7,engagement={},overlaysFile=null}){
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
    await renderSceneClip(sceneFile,clipFile,Math.max(0.5,durations[i]),{width,height,fps,imageFit,shouldCancel,motion:engagement.motion?i:null});
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
  const canBurnSubtitles=Boolean(subtitlesEnabled!==false&&subtitlesFile&&isUsableFile(subtitlesFile));
  const subtitleStyle=buildSubtitleStyle({width,height,fontSizePx:subtitleFontSize,fontName:captionFont(subtitleFontName),position:subtitlePosition,offsetPct:subtitleOffsetPct});
  // Final pass: captions, the hook / call-to-action text and the progress bar on top of the video.
  const fontsDir=existsSync(BUNDLED_FONTS_DIR)?`:fontsdir='${filterPath(BUNDLED_FONTS_DIR)}'`:'';
  const layers=[];
  if(canBurnSubtitles)layers.push(`subtitles='${filterPath(subtitlesFile)}'${fontsDir}:force_style='${subtitleStyle.forceStyle}'`);
  if(overlaysFile&&isUsableFile(overlaysFile))layers.push(`subtitles='${filterPath(overlaysFile)}'${fontsDir}`);
  const bar=engagement.progressBar&&totalDuration>=3;
  if(layers.length||bar){
    const barH=Math.max(6,Math.round(height*0.0052));
    const graph=bar
      ?`[0:v]${layers.length?layers.join(','):'null'}[base];color=c=0xFF0033:s=${width}x${barH}:r=${fps}[bar];[base][bar]overlay=x='-w+w*t/${totalDuration.toFixed(3)}':y=0:shortest=1:eval=frame[v]`
      :`[0:v]${layers.join(',')}[v]`;
    await run(ffmpegPath,['-y','-hide_banner','-loglevel','error','-i',silentVideo,'-i',combinedAudio,'-filter_complex',graph,'-map','[v]','-map','1:a:0','-c:v','libx264','-preset','veryfast','-crf','21','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-shortest','-movflags','+faststart',videoPath],{shouldCancel});
  }else{
    await run(ffmpegPath,['-y','-hide_banner','-loglevel','error','-i',silentVideo,'-i',combinedAudio,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','128k','-shortest',videoPath],{shouldCancel});
  }
  onProgress?.(95);
  return {videoPath,audioFile:combinedAudio,subtitlesFile:canBurnSubtitles?subtitlesFile:null,subtitlesBurned:canBurnSubtitles,subtitleStyle:canBurnSubtitles?{...subtitleStyle.summary,maxLines:2,profile:height>=width?'shorts-9:16':'landscape'}:null,subtitlesDisabledInSettings:subtitlesEnabled===false,durationSec:Number(totalDuration.toFixed(3)),sceneDurations:durations,sceneCount:sceneFiles.length,narrationSynchronized:true};
}

// A short silence before the first scene's narration, so players never clip the first word.
export async function addLeadIn(input,output,seconds=LEAD_IN_SECONDS){
  const ms=Math.round(seconds*1000);
  await run(ffmpegPath,['-y','-hide_banner','-loglevel','error','-i',input,'-af',`adelay=${ms}:all=1`,'-c:a','libmp3lame','-q:a','2',output]);
  return output;
}
