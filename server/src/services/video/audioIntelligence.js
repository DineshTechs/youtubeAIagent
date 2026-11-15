import {spawn} from 'node:child_process';

// One FFmpeg pass measures silence intervals and audio levels. Every audio
// check in the QA report is derived from this single measurement, so the
// dashboard, QA JSON and exports always show the same numbers.
// The threshold matches the long-standing V1.4-V1.6 scans (-45 dBFS) so a
// quiet narrator is not newly flagged; 0.65 s keeps short pauses visible.
export const SILENCE_THRESHOLD_DB = -45;
export const MIN_SILENCE_SEC = 0.65;
export const REVIEW_GAP_SEC = 1.25;
export const OPENING_WINDOW_SEC = 3;

function run(command,args){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['ignore','ignore','pipe']});
    let stderr='';
    child.stderr.on('data',chunk=>{stderr+=chunk.toString();if(stderr.length>2_000_000)stderr=stderr.slice(-1_000_000);});
    child.on('error',error=>reject(new Error(`Unable to start FFmpeg audio analysis: ${error.message}`)));
    child.on('close',code=>code===0?resolve(stderr):reject(new Error(`FFmpeg audio analysis failed (${code}): ${summarizeFfmpegError(stderr)}`)));
  });
}

// Return one short, useful line from FFmpeg stderr instead of the whole log
// (which contains local file paths and stream metadata).
export function summarizeFfmpegError(stderr){
  const lines=String(stderr||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const useful=lines.find(l=>/matches no streams|does not contain any stream|Invalid data|No such file|Permission denied|Error /i.test(l))||lines.at(-1)||'unknown error';
  return useful.replace(/[A-Za-z]:[\\/][^'"\s]*|\/(?:[\w.-]+\/)+[\w.-]+/g,'<path>').slice(0,240);
}

export function parseSilenceIntervals(log,durationSec=0){
  const text=String(log||'');
  const starts=[...text.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map(m=>Number(m[1]));
  const ends=[...text.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map(m=>Number(m[1]));
  const intervals=[]; let pending=null;
  for(const start of starts){
    if(pending!==null) continue;
    pending=Math.max(0,start);
    const end=ends.find(x=>x>=pending-0.001 && !intervals.some(i=>i.endSec===x));
    if(end!==undefined){intervals.push({startSec:Number(pending.toFixed(3)),endSec:Number(Math.max(pending,end).toFixed(3)),durationSec:Number(Math.max(0,end-pending).toFixed(3))});pending=null;}
  }
  if(pending!==null && Number(durationSec)>pending){const end=Number(durationSec);intervals.push({startSec:Number(pending.toFixed(3)),endSec:Number(end.toFixed(3)),durationSec:Number((end-pending).toFixed(3)),continuesToEnd:true});}
  return intervals.filter(x=>x.durationSec>0);
}

// astats prints one block per channel, then an "Overall" block. Levels must
// come from "Overall"; reading the first match reports channel 1 only.
export function parseAstats(log){
  const text=String(log||'');
  const num=v=>{if(v==null)return null;if(/^-inf$/i.test(v))return -Infinity;const n=Number(v);return Number.isFinite(n)?n:null;};
  const channels=[];
  const blocks=text.split(/Channel:\s*(\d+)/);
  for(let i=1;i<blocks.length;i+=2){
    const body=blocks[i+1].split(/\bOverall\b/)[0];
    channels.push({channel:Number(blocks[i]),peakDbfs:num(body.match(/Peak level dB:\s*(-?inf|-?\d+(?:\.\d+)?)/i)?.[1]),rmsDbfs:num(body.match(/RMS level dB:\s*(-?inf|-?\d+(?:\.\d+)?)/i)?.[1])});
  }
  const overallIndex=text.search(/\bOverall\b/);
  const overall=overallIndex>=0?text.slice(overallIndex):'';
  let peakDbfs=num(overall.match(/Peak level dB:\s*(-?inf|-?\d+(?:\.\d+)?)/i)?.[1]);
  let rmsDbfs=num(overall.match(/RMS level dB:\s*(-?inf|-?\d+(?:\.\d+)?)/i)?.[1]);
  if(peakDbfs==null&&channels.length){const peaks=channels.map(c=>c.peakDbfs).filter(v=>v!=null);peakDbfs=peaks.length?Math.max(...peaks):null;}
  if(rmsDbfs==null&&channels.length===1)rmsDbfs=channels[0].rmsDbfs;
  const clean=v=>v===-Infinity?null:v;
  return {peakDbfs:clean(peakDbfs),rmsDbfs:clean(rmsDbfs),digitalSilence:peakDbfs===-Infinity,channels:channels.map(c=>({...c,peakDbfs:clean(c.peakDbfs),rmsDbfs:clean(c.rmsDbfs)}))};
}

function sceneBoundaries(sceneDurations=[]){
  const out=[];let t=0;
  const list=(Array.isArray(sceneDurations)?sceneDurations:[]).map(Number).filter(x=>Number.isFinite(x)&&x>0);
  for(let i=0;i<list.length-1;i++){t+=list[i];out.push({afterScene:i+1,atSec:Number(t.toFixed(3))});}
  return out;
}

// Explain each gap for a human reviewer. Pauses are not automatically defects.
export function describeGap(gap,{durationSec=0,boundaries=[]}={}){
  const boundary=boundaries.find(b=>b.atSec>=gap.startSec-0.3&&b.atSec<=gap.endSec+0.3)||null;
  const atEnd=gap.continuesToEnd||(Number(durationSec)>0&&gap.endSec>=Number(durationSec)-0.15);
  const position=gap.startSec<OPENING_WINDOW_SEC?'opening':atEnd?'ending':'middle';
  const severity=gap.durationSec>=2?'high':gap.durationSec>=1?'medium':'low';
  const reviewRequired=gap.durationSec>=REVIEW_GAP_SEC&&position!=='ending';
  const where=boundary?` at the join between scene ${boundary.afterScene} and scene ${boundary.afterScene+1}`:'';
  let reason;
  if(position==='opening') reason=`${gap.durationSec.toFixed(2)}s of quiet audio in the first ${OPENING_WINDOW_SEC} seconds${where}. This can delay the hook; check that narration starts promptly.`;
  else if(position==='ending') reason=`${gap.durationSec.toFixed(2)}s of quiet audio at the end of the video. Usually harmless; check the video does not end on a long dead pause.`;
  else if(gap.durationSec>=2) reason=`Long ${gap.durationSec.toFixed(2)}s pause mid-video${where}. Check whether it is an intended dramatic pause or a narration/scene-join gap.`;
  else if(gap.durationSec>=REVIEW_GAP_SEC) reason=`Noticeable ${gap.durationSec.toFixed(2)}s pause${where}. Often intentional between sentences or scenes; listen once to confirm.`;
  else reason=`Short ${gap.durationSec.toFixed(2)}s pause${where}; normal speech rhythm. No action needed.`;
  return {...gap,position,severity,reviewRequired,sceneBoundary:boundary,reason};
}

export function summarizeAudioDiagnostics(intervals=[],durationSec=0,{sceneDurations=[]}={}){
  const boundaries=sceneBoundaries(sceneDurations);
  const gaps=intervals.map((gap,index)=>({index:index+1,...describeGap(gap,{durationSec,boundaries})}));
  const totalSilenceSec=Number(gaps.reduce((sum,g)=>sum+g.durationSec,0).toFixed(3));
  const longestGapSec=Number(Math.max(0,...gaps.map(g=>g.durationSec)).toFixed(3));
  const coverage=Number(durationSec)>0?Math.max(0,Number((1-totalSilenceSec/Number(durationSec)).toFixed(4))):null;
  return {durationSec:Number(durationSec)||null,totalSilenceSec,longestGapSec,silenceRatio:coverage===null?null:Number((1-coverage).toFixed(4)),gapCount:gaps.length,reviewGapCount:gaps.filter(g=>g.reviewRequired).length,gaps};
}

// Sum of silence overlapping [fromSec, toSec), counting only intervals of at
// least minDurationSec (matches FFmpeg silencedetect "d=" semantics).
export function silenceInWindow(intervals=[],{fromSec=0,toSec=Infinity,minDurationSec=0}={}){
  let total=0,count=0;
  for(const g of intervals){
    if(g.durationSec<minDurationSec)continue;
    const overlap=Math.min(g.endSec,toSec)-Math.max(g.startSec,fromSec);
    if(overlap>0){total+=overlap;count++;}
  }
  return {silenceSec:Number(total.toFixed(3)),segments:count};
}

export async function analyzeAudioTrack({inputPath,ffmpegPath='ffmpeg',durationSec=0,stream='0:a:0',sceneDurations=[]}={}){
  if(!inputPath) throw new Error('Audio analysis requires an input media path.');
  const log=await run(ffmpegPath,['-hide_banner','-i',inputPath,'-map',stream,'-af',`silencedetect=noise=${SILENCE_THRESHOLD_DB}dB:d=${MIN_SILENCE_SEC},astats=metadata=0:reset=0`,'-vn','-f','null','-']);
  const intervals=parseSilenceIntervals(log,durationSec);
  const summary=summarizeAudioDiagnostics(intervals,durationSec,{sceneDurations});
  const stream_=log.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]+\))?: Audio:\s*([^\n]+)/i)?.[1]||'';
  const levels=parseAstats(log);
  return {
    ...summary,
    peakDbfs:levels.peakDbfs,
    rmsDbfs:levels.rmsDbfs,
    channelLevels:levels.channels,
    digitalSilence:levels.digitalSilence,
    clippingSuspected:levels.peakDbfs!==null&&levels.peakDbfs>=-0.1,
    audioStream:{codec:stream_.split(/[ ,(]/)[0]||null,sampleRateHz:Number(stream_.match(/(\d+)\s*Hz/)?.[1])||null,channels:levels.channels.length||null},
    analysis:{silenceThresholdDb:SILENCE_THRESHOLD_DB,minSilenceDurationSec:MIN_SILENCE_SEC,reviewGapSec:REVIEW_GAP_SEC,stream,
      note:'Silence means audio below the threshold for the minimum duration. Quiet speech, breaths or soft music beds can appear as gaps; review before treating any gap as a defect. Silence is never removed automatically.'}
  };
}
