import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSilenceIntervals,summarizeAudioDiagnostics} from './audioIntelligence.js';

test('parses paired silence intervals',()=>{
 const gaps=parseSilenceIntervals('[silencedetect] silence_start: 2.1\n[silencedetect] silence_end: 3.8 | silence_duration: 1.7',10);
 assert.equal(gaps.length,1); assert.equal(gaps[0].durationSec,1.7);
});
test('closes trailing silence at media duration',()=>{
 const gaps=parseSilenceIntervals('silence_start: 8.5',10);
 assert.equal(gaps[0].durationSec,1.5); assert.equal(gaps[0].continuesToEnd,true);
});
test('summarizes gaps and severity without deciding pauses are errors',()=>{
 const result=summarizeAudioDiagnostics([{startSec:1,endSec:3,durationSec:2}],20);
 assert.equal(result.totalSilenceSec,2); assert.equal(result.gaps[0].severity,'high'); assert.equal(result.gaps[0].reviewRequired,true);
});
test('empty audio timeline returns safe defaults',()=>{
 const result=summarizeAudioDiagnostics([],0); assert.equal(result.totalSilenceSec,0); assert.equal(result.silenceRatio,null);
});

// ---- V1.7.0 handover fixes ----
import {parseAstats,describeGap,summarizeFfmpegError,silenceInWindow,SILENCE_THRESHOLD_DB} from './audioIntelligence.js';

const stereoAstats=`[Parsed_astats_1 @ 0x1] Channel: 1
[Parsed_astats_1 @ 0x1] Peak level dB: -37.586189
[Parsed_astats_1 @ 0x1] RMS level dB: -41.091625
[Parsed_astats_1 @ 0x1] Channel: 2
[Parsed_astats_1 @ 0x1] Peak level dB: -0.050000
[Parsed_astats_1 @ 0x1] RMS level dB: -22.101373
[Parsed_astats_1 @ 0x1] Overall
[Parsed_astats_1 @ 0x1] Peak level dB: -0.050000
[Parsed_astats_1 @ 0x1] RMS level dB: -25.057218`;

test('reads Overall levels, not channel 1, so clipping on channel 2 is caught',()=>{
 const r=parseAstats(stereoAstats);
 assert.equal(r.peakDbfs,-0.05); assert.equal(r.rmsDbfs,-25.057218);
 assert.equal(r.channels.length,2); assert.equal(r.channels[0].peakDbfs,-37.586189);
});
test('falls back to loudest channel when Overall block is missing',()=>{
 const r=parseAstats(stereoAstats.split('Overall')[0]);
 assert.equal(r.peakDbfs,-0.05); assert.equal(r.rmsDbfs,null);
});
test('handles fully silent (-inf) audio without NaN',()=>{
 const r=parseAstats('Channel: 1\nPeak level dB: -inf\nRMS level dB: -inf\nOverall\nPeak level dB: -inf\nRMS level dB: -inf');
 assert.equal(r.peakDbfs,null); assert.equal(r.digitalSilence,true);
});
test('every gap gets a position and a human-readable review reason',()=>{
 const opening=describeGap({startSec:0,endSec:1.5,durationSec:1.5},{durationSec:30});
 const middle=describeGap({startSec:9.8,endSec:12,durationSec:2.2},{durationSec:30,boundaries:[{afterScene:2,atSec:10}]});
 const short=describeGap({startSec:15,endSec:15.8,durationSec:0.8},{durationSec:30});
 const ending=describeGap({startSec:28,endSec:30,durationSec:2,continuesToEnd:true},{durationSec:30});
 for(const g of [opening,middle,short,ending]) assert.ok(g.reason.length>20);
 assert.equal(opening.position,'opening'); assert.equal(opening.reviewRequired,true);
 assert.match(middle.reason,/scene 2 and scene 3/); assert.equal(middle.severity,'high');
 assert.equal(short.reviewRequired,false); assert.match(short.reason,/No action needed/);
 assert.equal(ending.position,'ending'); assert.equal(ending.reviewRequired,false);
});
test('missing-audio FFmpeg errors are summarized without dumping paths or metadata',()=>{
 const msg=summarizeFfmpegError("Input #0, mov,mp4 from 'D:\\\\Videos\\\\final.mp4':\n  Duration: 00:00:04.00\nStream map '0:a:0' matches no streams.\nTo ignore this, add a trailing '?' to the map.");
 assert.match(msg,/matches no streams/); assert.doesNotMatch(msg,/Duration|D:\\/);
});
test('opening and whole-file totals are derived from the same intervals',()=>{
 const gaps=[{startSec:0,endSec:0.9,durationSec:0.9},{startSec:4,endSec:6,durationSec:2},{startSec:14,endSec:17,durationSec:3}];
 assert.deepEqual(silenceInWindow(gaps,{fromSec:0,toSec:15,minDurationSec:0.75}),{silenceSec:3.9,segments:3});
 assert.deepEqual(silenceInWindow(gaps,{minDurationSec:1}),{silenceSec:5,segments:2});
 assert.equal(SILENCE_THRESHOLD_DB,-45);
});
