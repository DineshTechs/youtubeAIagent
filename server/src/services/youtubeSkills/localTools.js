import fs from 'node:fs/promises';

const FILLER = new Set(['basically','actually','literally','just','really','very','so','kind','sort','like','guys','hey','welcome','today','video','subscribe','channel']);
const VAGUE = new Set(['amazing','incredible','insane','crazy','huge','massive','game','changer','secret','powerful','ultimate','best','revolutionary','mind','blowing','unbelievable']);
const STOP = new Set(['the','a','an','of','for','to','in','on','and','or','is','are','with','your','you','my','i','this','that','it','how','what','why']);
const STAKE = /\b(lose|lost|wasting|waste|quit|fail|broke|cost|risk|before|stop|never|die|dying|dead)\b/gi;
const CURIOSITY = /\b(why|how|what|which|until|before|but|nobody|almost|except|reason|actually)\b/gi;
const YOU = /\b(you|your|you're|youre|yourself)\b/gi;
const CONCRETE = /\b(\d[\d,.]*\s?(%|k|m|x|s|m|h)?|\$\d|\d+\s?(second|minute|hour|day|week|month|year)s?)\b/gi;
const formulas = [
 ['The Statistic',[/\b\d+(\.\d+)?\s?%/i,/\b\d+ (out of|in) \d+\b/i,/\b\d{2,}(,\d{3})+\b/i]],
 ["Someone Else's Result",[/\bthis (channel|guy|creator|account)\b/i,/\bwent from .* to\b/i,/\bin (a|one|two|three|\d+) (week|month|year)s?\b/i]],
 ['The Mistake',[/\byou('re| are) (probably |still )?(doing|making)\b/i,/\bthe (mistake|reason) (everyone|most people|nobody)\b/i,/\bstop (doing )?\b/i]],
 ['Contrarian Flip',[/\beveryone (says|thinks|tells you)\b/i,/\bis (actually )?wrong\b/i,/\bnobody (tells|talks about)\b/i]],
 ['The Reveal',[/\bI('m| am) going to show you\b/i,/\bhere('s| is) (the|exactly)\b/i,/\bon screen\b/i]],
 ['The Superlative',[/\bthe (best|worst|fastest|easiest|only)\b/i,/\bnumber one\b/i]],
 ['The Clock',[/\bin (the next )?\d+ (seconds|minutes|hours)\b/i,/\bby the end of this video\b/i,/\bunder \d+\b/i]],
 ['I Tried It',[/\bI (tried|spent|tested|let|gave)\b/i,/\bfor \d+ (days|weeks|months)\b/i,/\bso you don'?t have to\b/i]],
 ['The Question',[/^(why|how|what|when|should|can|do|does|is)\b/i,/\?\s*$/i]],
 ['Before and After',[/\bbefore\b.*\bafter\b/i,/\bthis was\b.*\bthis is\b/i,/\bused to\b/i]],
 ['The Teardown',[/\b(broke|break|breaking) (it )?down\b/i,/\bteardown\b/i,/\banalys(ed|is|e)\b/i,/\bI pulled\b/i]],
 ['The Stack',[/\b\w+ (plus|\+) \w+\b/i,/\bcombine\b/i,/\btogether\b/i]],
 ['The Warning',[/\bdo not\b/i,/\bdon'?t (upload|post|publish|start)\b/i,/\bbefore you\b/i,/\bstop\b/i]],
 ['The List',[/^\d+ \w+/i,/\b(here are|these are) \d+\b/i]],
 ['The Receipt',[/\bthis is (the|my)\b/i,/\bscreenshot\b/i,/\bproof\b/i,/\breceipts?\b/i]],
 ['The Insider',[/\b(nobody|almost nobody|most people) (knows?|opens?|uses?)\b/i,/\bhidden\b/i,/\bburied\b/i]],
 ['The Impossible Claim',[/\bwithout\b/i,/\bnever\b/i,/\bin one\b/i,/\bzero\b/i]],
 ['The Comparison',[/\bvs\.?\b/i,/\bversus\b/i,/\bwhich (one )?(is|wins)\b/i,/\bsame .* (three|two) ways\b/i]],
 ['The Origin',[/\bevery (video|post) .* starts\b/i,/\bit all (starts|started)\b/i,/\bthe (real )?reason\b/i]],
 ['The Deadline',[/\b(this|next) (week|month|year)\b/i,/\bis changing\b/i,/\bno longer\b/i,/\bas of\b/i]],
 ['The Direct Address',[/^if you\b/i,/\bfor (anyone|everyone|people) who\b/i,/\byou specifically\b/i]]
];
function words(t){return String(t||'').toLowerCase().match(/[a-z0-9'%$.]+/g)||[];}
function count(re,t){return (String(t||'').match(re)||[]).length;}
export function classifyHook(t){
 let best='Unclassified',hits=0;
 for(const [name,rs] of formulas){const n=rs.reduce((a,r)=>a+(r.test(t)?1:0),0); if(n>hits){best=name;hits=n;}}
 return {name:best,hits};
}
export function scoreHook(t){
 const w=words(t); if(!w.length) return {parts:{SPECIFICITY:0,ADDRESS:0,STAKES:0,CURIOSITY:0,BREVITY:0},verdict:0,...classifyHook(t)};
 const nums=count(CONCRETE,t), vague=w.filter(x=>VAGUE.has(x)).length, filler=w.filter(x=>FILLER.has(x)).length;
 let specificity=Math.max(0,Math.min(100,34+nums*22-vague*16-filler*5));
 specificity=Math.max(0,Math.min(100,specificity+Math.min(18,6*String(t).split(/\s+/).slice(1).filter(x=>/^[A-Z]/.test(x)).length)));
 const address=Math.max(0,Math.min(100,26+count(YOU,t)*20+(/\b(you|your|you're|youre|yourself)\b/i.test(String(t).split(/\s+/).slice(0,6).join(' '))?30:0)));
 const stakes=Math.max(0,Math.min(100,22+count(STAKE,t)*26+(CONCRETE.test(t)?14:0))); CONCRETE.lastIndex=0;
 const curiosity=Math.max(0,Math.min(100,24+count(CURIOSITY,t)*17+(/\?\s*$/.test(String(t).trim())?18:0)-(/\b(because|so that|which means)\b/i.test(t)?18:0)));
 const n=w.length; const brevity=n>=9&&n<=24?100:n<9?Math.max(30,100-(9-n)*11):Math.max(10,100-(n-24)*7);
 const parts={SPECIFICITY:specificity,ADDRESS:address,STAKES:stakes,CURIOSITY:curiosity,BREVITY:brevity};
 const vals=Object.values(parts); const verdict=Math.round(.6*(vals.reduce((a,b)=>a+b,0)/vals.length)+.4*Math.min(...vals));
 return {parts,verdict,...classifyHook(t)};
}
export function lintTitle(title,thumb=''){
 const t=String(title||'').trim(), issues=[],good=[],n=t.length;
 if(n>100)issues.push(['length',`${n} characters - hard limit is 100`]); else if(n>60)issues.push(['length',`${n} characters - desktop search cuts near 60`]); else good.push(`${n} characters, inside desktop cut`);
 if(n>40){const head=t.slice(0,40).replace(/\s+\S*$/,'');issues.push(['mobile',`mobile feed shows about "${head}..."`]);}
 const caps=t.split(/\s+/).filter(w=>w.length>2&&w===w.toUpperCase()); if(caps.length>2)issues.push(['shouting',`${caps.length} all-caps words`]);
 const vague=words(t).filter(w=>VAGUE.has(w)); if(vague.length)issues.push(['vague',vague.join(', ')]);
 const nums=t.match(/\d[\d,.]*%?/g); if(nums)good.push(`concrete figure (${nums.slice(0,3).join(', ')})`); else issues.push(['no-number','no number, date or name']);
 const front=words(t).slice(0,3).filter(w=>!STOP.has(w)); if(!front.length)issues.push(['front-load','subject should appear earlier']);
 if(thumb){const tw=new Set(words(t).filter(w=>!STOP.has(w))),hw=new Set(words(thumb).filter(w=>!STOP.has(w)));const shared=[...tw].filter(x=>hw.has(x));if(shared.length)issues.push(['duplicate',`thumbnail repeats title: ${shared.join(', ')}`]);else good.push('thumbnail and title use different words');if(words(thumb).length>4)issues.push(['thumb-length','thumbnail has more than four words']);}
 return {title:t,chars:n,score:Math.max(0,Math.min(100,100-14*issues.length+4*good.length)),issues,good};
}
function parseTs(s){const p=String(s).trim().replace(',','.').split(':');return p.length===3?Number(p[0])*3600+Number(p[1])*60+Number(p[2]):Number(p[0])*60+Number(p[1]);}
export function parseTranscript(raw){
 const cues=[]; let cur=null;
 for(const line of String(raw||'').split(/\r?\n/)){const m=line.match(/^\s*(\d[\d:.,]+)\s*-->\s*(\d[\d:.,]+)/);if(m){cur=[parseTs(m[1]),parseTs(m[2]),[]];cues.push(cur);}else if(cur&&line.trim()&&!/^\d+$/.test(line.trim()))cur[2].push(line.trim());}
 return cues.map(([a,b,t])=>({start:a,end:b,text:t.join(' ')})).filter(x=>x.text);
}
export function editDecisions(raw,floor=.45){
 const cues=parseTranscript(raw),cuts=[];
 const filler=/^[\s,.-]*((um+|uh+|er+|ah+|so|okay|ok|right|yeah|like|anyway|basically|actually|you know|i mean|let me see|hold on)[\s,.-]*)+$/i;
 const norm=t=>String(t).toLowerCase().replace(/[^a-z ]/g,'').split(/\s+/).filter(Boolean);
 for(let i=0;i<cues.length;i++){const c=cues[i];if(filler.test(c.text))cuts.push({kind:'FILLER',start:c.start,end:c.end,why:c.text.slice(0,48)});if(i){const gap=c.start-cues[i-1].end;if(gap>floor)cuts.push({kind:'DEAD',start:+(cues[i-1].end+floor/2).toFixed(3),end:+(c.start-floor/2).toFixed(3),why:`${gap.toFixed(2)}s gap`});let j=i-1;while(j>=0&&filler.test(cues[j].text))j--;if(j>=0){const a=norm(cues[j].text).slice(0,5),b=norm(c.text).slice(0,5);if(a.length>=3&&a.join(' ')==b.join(' '))cuts.push({kind:'REPEAT',start:cues[j].start,end:cues[j].end,why:`restart of "${a.join(' ')}"`});}}}
 const removed=cuts.reduce((s,c)=>s+(c.end-c.start),0),duration=cues.at(-1)?.end||0;
 return {cuts,totalRemovedSec:+removed.toFixed(2),estimatedRuntimeSec:+Math.max(0,duration-removed).toFixed(2)};
}
export function chapters(raw,target=7){
 const cues=parseTranscript(raw); if(cues.length<6)return {valid:false,chapters:[],error:'too few cues to chapter'};
 const dur=cues.at(-1).end,cand=[];
 const stop=new Set('the a an of for to in on and or is are was were be been with this that it as at by from you your i my we our they them he she but so if then than there here what which who how when where why not no yes do does did just really very like about into over out up down can could will would should have has had get got make made go going went one two'.split(/\s+/));
 const keywords=t=>new Set((String(t).toLowerCase().match(/[a-z']{4,}/g)||[]).filter(w=>!stop.has(w)));
 for(let i=1;i<cues.length;i++){const gap=cues[i].start-cues[i-1].end,before=cues.slice(Math.max(0,i-12),i).map(x=>x.text).join(' '),after=cues.slice(i,i+12).map(x=>x.text).join(' '),kb=keywords(before),ka=keywords(after),union=new Set([...kb,...ka]),inter=[...kb].filter(x=>ka.has(x)).length,shift=union.size?1-inter/union.size:0;cand.push([gap*1.6+shift*3.2,cues[i].start]);}
 cand.sort((a,b)=>b[0]-a[0]); const picked=[0]; for(const [,t] of cand){if(picked.length>=target)break;if(picked.every(p=>Math.abs(t-p)>=10)&&dur-t>=10)picked.push(t);} picked.sort((a,b)=>a-b);
 const chapters=picked.map((t,i)=>{const end=picked[i+1]??dur,text=cues.filter(c=>c.start>=t&&c.end<=end).map(c=>c.text).join(' '),kw=[...keywords(text)].sort((a,b)=>text.toLowerCase().split(b).length-text.toLowerCase().split(a).length).slice(0,3);return {start:+t.toFixed(2),label:`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`,draftTitle:kw.map(w=>w[0].toUpperCase()+w.slice(1)).join(' ')||'Section',seconds:+(end-t).toFixed(2)};});
 return {valid:chapters.length>=3&&chapters[0].start===0&&chapters.every(c=>c.seconds>=10),chapters};
}
export function retention(rows,duration=null){
 const data=rows.map(r=>[Number(r.position??r.x??r[0]),Number(r.retention??r.y??r[1])]).filter(r=>Number.isFinite(r[0])&&Number.isFinite(r[1]));if(data.length<8)return {error:'Need at least 8 retention points.'};
 const pctAxis=Math.max(...data.map(x=>x[0]))<=100.5,start=data[0][1],cutoff=pctAxis?(duration?30/duration*100:10):30,hookEnd=(data.filter(x=>x[0]<=cutoff).at(-1)||data[0])[1],cliffs=[];
 for(let i=1;i<data.length;i++){const d=data[i-1][1]-data[i][1],span=data[i][0]-data[i-1][0]||1;if(d>.8)cliffs.push({from:data[i-1][0],to:data[i][0],lost:+d.toFixed(2),atSeconds:!pctAxis||duration?+(pctAxis?data[i-1][0]/100*duration:data[i-1][0]).toFixed(1):null,rate:d/span});}
 cliffs.sort((a,b)=>b.rate-a.rate);
 return {hookLeak:+(start-hookEnd).toFixed(2),cliffs:cliffs.slice(0,5),points:data.length};
}
export function viral(rows,min=1.5){
 const by=new Map();for(const r of rows){const a=by.get(r.channel||'?')||[];a.push(r);by.set(r.channel||'?',a);}
 const out=[],skipped=[];for(const [channel,vids] of by){if(vids.length<4){skipped.push({channel,count:vids.length});continue;}const v=vids.map(x=>Number(x.views)||0).sort((a,b)=>a-b),med=v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;for(const x of vids){const multiple=med?Number(x.views||0)/med:0;if(multiple>=min)out.push({channel,title:x.title||'',views:Number(x.views)||0,median:Math.round(med),multiple:+multiple.toFixed(2),formula:classifyHook(x.title||'').name,url:x.url||''});}}
 out.sort((a,b)=>b.multiple-a.multiple);return {outliers:out,skippedThinChannels:skipped};
}
