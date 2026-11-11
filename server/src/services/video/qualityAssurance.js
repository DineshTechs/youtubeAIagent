import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import {env} from '../../config/env.js';
import {findHookCompletionTime, analyzeHookText} from '../../utils/retentionAnalysis.js';

const ffmpegPath = env.ffmpegPath || ffmpegStatic || 'ffmpeg';
function runFfmpeg(args){
  return new Promise((resolve,reject)=>{
    const child=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});
    let stderr='';
    child.stderr.on('data',chunk=>{stderr+=chunk.toString();if(stderr.length>2_000_000)stderr=stderr.slice(-1_000_000);});
    child.on('error',error=>reject(new Error(`Unable to start FFmpeg QA: ${error.message}`)));
    child.on('close',code=>code===0?resolve(stderr):reject(new Error(`FFmpeg QA decode failed (${code}): ${stderr.slice(-2500)}`)));
  });
}
function check(name,status,message,details={}){return {name,status,message,...details};}
function seconds(value){const p=String(value||'').trim().split(':').map(Number);return p.length===3&&p.every(Number.isFinite)?p[0]*3600+p[1]*60+p[2]:null;}
function matches(output,pattern){return [...output.matchAll(pattern)].map(m=>Number(m[1])).filter(Number.isFinite);}
function sumSegments(starts,ends){let total=0;for(let i=0;i<Math.min(starts.length,ends.length);i++)total+=Math.max(0,ends[i]-starts[i]);return total;}

export async function runVideoQualityAssurance({videoPath,expectedWidth=1080,expectedHeight=1920,scenePaths=[],audioPath,subtitlePath,expectedDurationSec,expectedSceneCount,sceneDurations=[],expectedOpeningHook='',expectedAspectRatio='9:16'}={}){
  const checks=[];
  if(!videoPath){checks.push(check('Rendered file','FAIL','No rendered MP4 path was supplied.'));return report(checks);}
  let stat;
  try{stat=await fs.stat(videoPath);}catch{checks.push(check('Rendered file','FAIL','Final MP4 is missing.',{videoPath}));return report(checks);}
  const fileOk=stat.isFile()&&stat.size>=1000;
  checks.push(check('Rendered file',fileOk?'PASS':'FAIL',fileOk?'MP4 exists and has a plausible file size.':'MP4 is not a regular file or is unexpectedly small.',{sizeBytes:stat.size,extension:path.extname(videoPath).toLowerCase()}));
  if(!fileOk)return report(checks,{sizeBytes:stat.size});

  let output='';
  try{output=await runFfmpeg(['-hide_banner','-i',videoPath,'-map','0:v:0','-map','0:a:0?','-vf','blackdetect=d=1:pix_th=0.10','-f','null','-']);
    if(/Stream #\d+:\d+(?:\([^)]+\))?.*?Audio:/i.test(output)){
      output+='\n'+await runFfmpeg(['-hide_banner','-i',videoPath,'-map','0:a:0','-af','silencedetect=noise=-45dB:d=1','-f','null','-']);
    }}
  catch(error){checks.push(check('Full decode','FAIL','FFmpeg could not decode the complete MP4 video/audio streams.',{details:error.message}));return report(checks,{sizeBytes:stat.size});}
  checks.push(check('Full decode','PASS','FFmpeg decoded the complete mapped video and available audio streams.'));

  const dm=output.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/i);
  const durationSec=dm?seconds(dm[1]):null;
  const vm=output.match(/Stream #\d+:\d+(?:\([^)]+\))?.*?Video:\s*([^\n]+)/i);
  const am=output.match(/Stream #\d+:\d+(?:\([^)]+\))?.*?Audio:\s*([^\n]+)/i);
  const dimensions=vm?.[1]?.match(/(?:,|\s)(\d{2,5})x(\d{2,5})(?:[,\s]|$)/);
  const width=dimensions?Number(dimensions[1]):null,height=dimensions?Number(dimensions[2]):null;
  checks.push(check('Video stream',vm?'PASS':'FAIL',vm?'Video stream detected.':'No video stream detected.'));
  checks.push(check('Audio stream',am?'PASS':'FAIL',am?'Narration/audio stream detected.':'No audio stream detected.'));
  if(width&&height){
    const ratios={'9:16':9/16,'16:9':16/9,'1:1':1,'3:4':3/4};
    const targetRatio=ratios[expectedAspectRatio]||ratios['9:16'];
    const aspect=Math.abs(width/height-targetRatio)<.025;
    const resolution=width>=720&&height>=720;
    checks.push(check('Aspect ratio',aspect?'PASS':'FAIL',aspect?`${expectedAspectRatio} aspect ratio confirmed.`:`Expected ${expectedAspectRatio}; found ${width}x${height}.`,{width,height,expectedAspectRatio,actualAspectRatio:Number((width/height).toFixed(4))}));
    checks.push(check('Resolution',resolution?'PASS':'WARN',resolution?`Resolution ${width}x${height} is suitable for the selected format.`:`Resolution ${width}x${height} is below the recommended minimum.`,{width,height,expectedWidth,expectedHeight}));
  }else checks.push(check('Video metadata','FAIL','FFmpeg could not determine the rendered video dimensions.'));
  if(durationSec!=null){
    const valid=durationSec>0&&durationSec<=180;
    checks.push(check('Short duration',valid?'PASS':'WARN',valid?`Duration ${durationSec.toFixed(1)} seconds is within the 3-minute Shorts limit.`:`Duration is ${durationSec.toFixed(1)} seconds; verify intended Shorts format.`,{durationSec}));
    if(Number(expectedDurationSec)>0){const delta=Math.abs(durationSec-Number(expectedDurationSec)),tol=Math.max(1,Number(expectedDurationSec)*.08);checks.push(check('Expected duration match',delta<=tol?'PASS':'WARN',delta<=tol?'Rendered duration is close to the expected duration.':`Rendered duration differs from expected by ${delta.toFixed(1)} seconds.`,{expectedDurationSec:Number(expectedDurationSec),actualDurationSec:durationSec,differenceSec:Number((durationSec-Number(expectedDurationSec)).toFixed(2)),toleranceSec:Number(tol.toFixed(2))}));}
  }else checks.push(check('Duration metadata','WARN','FFmpeg did not expose a readable MP4 duration.'));

  // V1.4: inspect the opening separately. A whole-file decode can pass even
  // when the hook/opening frames are absent, black, or silent.
  const openingWindowSec=Math.max(0,Math.min(15,Number(durationSec)||15));
  if(openingWindowSec>0){
    const sampleTimes=[0,1,5,10,14].filter(t=>t<openingWindowSec);
    const sampled=[];
    for(const at of sampleTimes){
      try{
        const sampleOutput=await runFfmpeg(['-hide_banner','-loglevel','info','-i',videoPath,'-ss',String(at),'-map','0:v:0','-frames:v','1','-vf','showinfo','-f','null','-']);
        const decoded=/showinfo.*\bn:\s*0\b/i.test(sampleOutput);
        sampled.push({atSec:at,decoded});
      }catch(error){sampled.push({atSec:at,decoded:false,error:error.message});}
    }
    const sampledOk=sampled.length>0&&sampled.every(x=>x.decoded);
    checks.push(check('Opening frame samples',sampledOk?'PASS':'FAIL',sampledOk?`Decoded opening frames at ${sampled.map(x=>`${x.atSec}s`).join(', ')}.`:'One or more required opening frames could not be decoded.',{windowSec:openingWindowSec,samples:sampled}));

    try{
      const openingVideoLog=await runFfmpeg(['-hide_banner','-i',videoPath,'-t',String(openingWindowSec),'-map','0:v:0','-vf','blackdetect=d=0.5:pix_th=0.10','-an','-f','null','-']);
      const starts=matches(openingVideoLog,/black_start:\s*([\d.]+)/g);
      const ends=matches(openingVideoLog,/black_end:\s*([\d.]+)/g);
      const blackSec=sumSegments(starts,ends);
      const blackOk=blackSec<=1.25;
      checks.push(check('Opening black-frame scan',blackOk?'PASS':'WARN',blackOk?'No prolonged black segment was detected in the opening.':`Opening contains approximately ${blackSec.toFixed(2)} seconds of black frames; review the hook visually.`,{windowSec:openingWindowSec,blackDurationSec:Number(blackSec.toFixed(2)),segments:starts.length}));
    }catch(error){
      checks.push(check('Opening black-frame scan','WARN',`Could not complete the opening black-frame scan: ${error.message}`));
    }

    if(am){
      try{
        const openingAudioLog=await runFfmpeg(['-hide_banner','-i',videoPath,'-t',String(openingWindowSec),'-map','0:a:0','-af','silencedetect=noise=-45dB:d=0.75','-vn','-f','null','-']);
        const starts=matches(openingAudioLog,/silence_start:\s*([\d.]+)/g);
        const ends=matches(openingAudioLog,/silence_end:\s*([\d.]+)/g);
        const silenceSec=sumSegments(starts,ends);
        const leadingSilence=starts.length&&starts[0]<=0.05&&ends.length?Math.max(0,ends[0]-starts[0]):0;
        const audioOk=leadingSilence<=0.75&&silenceSec<=2.5;
        checks.push(check('Opening audio start',audioOk?'PASS':'WARN',audioOk?'Opening narration starts promptly with no prolonged silence.':`Opening audio has ${leadingSilence.toFixed(2)}s leading silence and ${silenceSec.toFixed(2)}s total detected silence.`,{windowSec:openingWindowSec,leadingSilenceSec:Number(leadingSilence.toFixed(2)),silenceDurationSec:Number(silenceSec.toFixed(2)),segments:starts.length}));
      }catch(error){
        checks.push(check('Opening audio start','WARN',`Could not complete the opening audio scan: ${error.message}`));
      }
    }
  }

  // Check that the saved SRT begins at zero and actually contains the hook.
  if(subtitlePath){
    try{
      const srtText=await fs.readFile(subtitlePath,'utf8');
      const firstCue=srtText.match(/(?:^|\n)\s*\d+\s*\n\s*(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
      const firstStart=firstCue?seconds(firstCue[1].replace(',', '.')):null;
      const normalizedHook=String(expectedOpeningHook||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
      const startsAtZero=firstStart!=null&&firstStart<=0.15;
      const hookTiming=findHookCompletionTime(srtText,expectedOpeningHook);
      const hookFound=!normalizedHook||(hookTiming.found && hookTiming.matchRatio>=0.85);
      const openingCaptionOk=startsAtZero&&hookFound;
      checks.push(check('Opening hook caption',openingCaptionOk?'PASS':'WARN',openingCaptionOk?(normalizedHook?'Opening captions start at 00:00 and contain the story hook.':'Opening captions start at 00:00.'):`Opening captions ${!startsAtZero?'do not start at 00:00.':''}${!hookFound?' The expected hook text was not found in the subtitle file.':''}`,{firstCueStartSec:firstStart,startsAtZero,hookExpected:Boolean(normalizedHook),hookFound,hookMatchRatio:hookTiming.matchRatio??0}));
      if(normalizedHook){
        const hookTextAnalysis=analyzeHookText(expectedOpeningHook);
        checks.push(check('Opening hook length',hookTextAnalysis.concise?'PASS':'WARN',hookTextAnalysis.concise?`Opening hook contains ${hookTextAnalysis.wordCount} words.`:`Opening hook contains ${hookTextAnalysis.wordCount} words; aim for 3-10 concise spoken words.`,hookTextAnalysis));
        const hookWithin3=hookTiming.found&&hookTiming.endWithin3Sec;
        checks.push(check('3-second hook delivery',hookWithin3?'PASS':'WARN',hookWithin3?`The full opening hook is captioned by ${hookTiming.endSec.toFixed(2)} seconds.`:hookTiming.found?`The full hook completes at ${hookTiming.endSec.toFixed(2)} seconds; aim to deliver it within 3 seconds.`:'Could not locate the complete hook in sequential captions.',{hookFound:hookTiming.found,hookCompletionSec:hookTiming.endSec,within3Seconds:hookWithin3}));
      }
    }catch(error){checks.push(check('Opening hook caption','WARN',`Could not verify the opening subtitle/hook: ${error.message}`));}
  }

  const timelineDurations=Array.isArray(sceneDurations)?sceneDurations.map(Number).filter(x=>Number.isFinite(x)&&x>0):[];
  // V1.6: assess opening pacing from the measured scene timeline. This is a
  // warning-only heuristic: intentional slow scenes should not fail rendering.
  if(timelineDurations.length){
    let elapsed=0,openingSceneCount=0;
    for(const duration of timelineDurations){
      if(elapsed>=15) break;
      openingSceneCount++;
      elapsed+=duration;
    }
    const openingDurations=timelineDurations.slice(0,openingSceneCount);
    const longestOpeningScene=Math.max(...openingDurations);
    const shortOpeningScenes=openingDurations.filter(x=>x<1.25).length;
    let pacingStatus='PASS',pacingMessage=`${openingSceneCount} scene${openingSceneCount===1?'':'s'} cover the first ${Math.min(15,elapsed).toFixed(1)} seconds.`;
    if(longestOpeningScene>7){pacingStatus='WARN';pacingMessage=`An opening scene lasts ${longestOpeningScene.toFixed(1)} seconds. Add a relevant visual beat or action before 7 seconds; do not cut or speed up narration to force a shorter scene.`;}
    else if(openingSceneCount>=4&&shortOpeningScenes>=Math.ceil(openingSceneCount*.75)){pacingStatus='WARN';pacingMessage='Most opening scenes are shorter than 1.25 seconds; check that the cuts do not feel rushed.';}
    checks.push(check('Opening visual pacing',pacingStatus,pacingMessage,{openingSceneCount,longestOpeningSceneSec:Number(longestOpeningScene.toFixed(2)),shortOpeningSceneCount:shortOpeningScenes,openingSceneDurations:openingDurations}));
  }
  if(timelineDurations.length){
    const openingWindow=Math.min(15,Number(durationSec)||15);
    let openingSceneCoverage=0;
    for(const sceneDuration of timelineDurations){if(openingSceneCoverage>=openingWindow)break;openingSceneCoverage+=sceneDuration;}
    const openingCoverageOk=openingSceneCoverage>=openingWindow-0.35;
    checks.push(check('Opening scene timeline',openingCoverageOk?'PASS':'WARN',openingCoverageOk?'Scene narration timing covers the opening segment.':`Scene timing covers only ${openingSceneCoverage.toFixed(2)} seconds of the opening.`,{openingSceneCoverageSec:Number(openingSceneCoverage.toFixed(2)),openingWindowSec:openingWindowSec,sceneDurations:timelineDurations}));
  }

  const blackStarts=matches(output,/black_start:\s*([\d.]+)/g),blackEnds=matches(output,/black_end:\s*([\d.]+)/g),blackDuration=sumSegments(blackStarts,blackEnds);
  const blackWarn=blackDuration>Math.max(2,(durationSec||0)*.08);
  checks.push(check('Black-frame scan',blackWarn?'WARN':'PASS',blackWarn?`Detected approximately ${blackDuration.toFixed(1)} seconds of black frames; review the video.`:'No prolonged black-frame segments detected.',{blackDurationSec:Number(blackDuration.toFixed(2)),segments:blackStarts.length}));
  const silenceStarts=matches(output,/silence_start:\s*([\d.]+)/g),silenceEnds=matches(output,/silence_end:\s*([\d.]+)/g),silenceDuration=sumSegments(silenceStarts,silenceEnds);
  const silenceWarn=silenceDuration>Math.max(2,(durationSec||0)*.08);
  checks.push(check('Audio silence scan',silenceWarn?'WARN':'PASS',silenceWarn?`Detected approximately ${silenceDuration.toFixed(1)} seconds of silence; check narration gaps.`:'No prolonged audio-silence segments detected.',{silenceDurationSec:Number(silenceDuration.toFixed(2)),segments:silenceStarts.length}));

  const scenes=Array.isArray(scenePaths)?scenePaths:[];let validScenes=0;const sceneDetails=[];
  for(let i=0;i<scenes.length;i++){try{const s=await fs.stat(scenes[i]);const valid=s.isFile()&&s.size>100;if(valid)validScenes++;sceneDetails.push({scene:i+1,exists:true,sizeBytes:s.size,valid,fileName:path.basename(scenes[i])});}catch{sceneDetails.push({scene:i+1,exists:false,valid:false,fileName:scenes[i]?path.basename(scenes[i]):null});}}
  const countOk=Number(expectedSceneCount)>0?scenes.length===Number(expectedSceneCount):scenes.length>0,scenesOk=countOk&&validScenes===scenes.length;
  checks.push(check('Scene assets',scenesOk?'PASS':'FAIL',scenes.length?`${validScenes}/${scenes.length} scene image assets are present and non-empty${Number(expectedSceneCount)>0?`; expected ${expectedSceneCount}`:''}.`:'No scene image assets were supplied.',{validScenes,totalScenes:scenes.length,expectedSceneCount:Number(expectedSceneCount)||null,scenes:sceneDetails}));
  if(audioPath){try{const a=await fs.stat(audioPath);checks.push(check('Narration source',a.isFile()&&a.size>100?'PASS':'FAIL',a.size>100?'Narration source file is present.':'Narration source file is empty or too small.',{sizeBytes:a.size,fileName:path.basename(audioPath)}));}catch{checks.push(check('Narration source','WARN','Separate narration source file is missing.',{fileName:path.basename(audioPath)}));}}
  else checks.push(check('Narration source','WARN','No separate narration source path was supplied; rendered audio stream was checked instead.'));
  if(subtitlePath){try{const s=await fs.stat(subtitlePath);checks.push(check('Subtitle file',s.isFile()&&s.size>0?'PASS':'WARN',s.size>0?'Subtitle sidecar file exists.':'Subtitle sidecar file is empty.',{sizeBytes:s.size,fileName:path.basename(subtitlePath)}));}catch{checks.push(check('Subtitle file','WARN','Subtitle sidecar file is missing; burned-in captions require visual review.',{fileName:path.basename(subtitlePath)}));}}
  else checks.push(check('Subtitle file','REVIEW','No subtitle sidecar supplied; if captions are burned in, verify them in the visual review.'));
  checks.push(check('Visual relevance','REVIEW','Human review required: confirm every image matches its narration and characters remain consistent.'));
  checks.push(check('Subtitle appearance','REVIEW','Human review required: confirm captions are readable, correctly positioned and do not obscure important action.'));
  checks.push(check('Story suitability','REVIEW','Human review required: check age suitability, story clarity and originality.'));
  return report(checks,{durationSec,width,height,sizeBytes:stat.size,videoPath,ffmpegPath:path.basename(ffmpegPath)});
}
function report(checks,meta={}){const failures=checks.filter(x=>x.status==='FAIL').length,warnings=checks.filter(x=>x.status==='WARN').length,passed=checks.filter(x=>x.status==='PASS').length,score=Math.max(0,Math.round(passed/(passed+warnings+failures||1)*100));const retentionChecks=checks.filter(x=>/opening|hook|pacing/i.test(x.name));const retentionPass=retentionChecks.filter(x=>x.status==='PASS').length;const retentionWarnings=retentionChecks.filter(x=>x.status==='WARN').length;const retentionScore=Math.round(retentionPass/(retentionPass+retentionWarnings||1)*100);return {version:'1.6.1',pass:failures===0,score,retention:{score:retentionScore,checks:retentionChecks.length,passed:retentionPass,warnings:retentionWarnings},summary:{passed,warnings,failures,manualReviews:checks.filter(x=>x.status==='REVIEW').length},checks,meta,ranAt:new Date()};}
