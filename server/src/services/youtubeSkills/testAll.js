import { randomUUID } from 'node:crypto';
import { runSkill, listSkills } from './index.js';

const cases = {
  'yt-script': { idea:'How AI is changing YouTube in 2026', context:'Beginner creators; educational long-form video.' },
  'yt-package': { topic:'How AI is changing YouTube in 2026', script:'AI can help creators research topics, write scripts, and improve production. The creator still needs original judgment.', titleHint:'AI YouTube 2026', thumbnailHint:'AI YOUTUBE' },
  'yt-edit': { transcript:'1\n00:00:00,000 --> 00:00:08,000\nToday we will learn three practical AI YouTube workflows.\n\n2\n00:00:08,000 --> 00:00:18,000\nFirst, research the topic.\n\n3\n00:00:18,000 --> 00:00:30,000\nSecond, write the script.\n\n4\n00:00:30,000 --> 00:00:45,000\nThird, create the scenes.\n\n5\n00:00:45,000 --> 00:00:55,000\nThat is the workflow.' },
  'yt-comment': { comments:'Love this video!\nCan you make a tutorial?\nThis is wrong.\nFirst!', voice:'Helpful, concise, professional.' },
  'yt-plan': { niche:'AI tools for YouTube creators', cadence:'1 long video + 3 Shorts', capacity:'6 hours per week', goals:'Grow a beginner creator audience.' },
  'yt-viral': { videos:[{channel:'Test',title:'A',views:1000},{channel:'Test',title:'B',views:1800},{channel:'Test',title:'C',views:2400},{channel:'Test',title:'D',views:5000}] },
  'yt-retention': { rows:[{time:0,percent:100},{time:10,percent:82},{time:30,percent:70},{time:60,percent:62},{time:90,percent:58},{time:120,percent:52},{time:150,percent:49},{time:180,percent:45}], duration:180 },
  'yt-shorts': { transcript:'[00:00] AI can research topics. [00:20] It can help draft a script. [00:40] It can also help create scenes and captions.', count:2 },
  'yt-seo': { title:'How AI Is Changing YouTube in 2026', topic:'AI tools for YouTube creators', script:'This video explains practical ways creators can use AI for research, scripting, editing, thumbnails, and production.' },
  'yt-chapters': { transcript:'1\n00:00:00,000 --> 00:00:30,000\nIntroduction\n\n2\n00:00:30,000 --> 00:01:10,000\nResearch\n\n3\n00:01:10,000 --> 00:02:00,000\nScripting\n\n4\n00:02:00,000 --> 00:02:40,000\nProduction\n\n5\n00:02:40,000 --> 00:03:20,000\nEditing\n\n6\n00:03:20,000 --> 00:04:00,000\nConclusion' },
  'yt-audit': { channelData:JSON.stringify({subscribers:1000, videos:20, recentVideos:[{views:500},{views:900},{views:700},{views:1200}]}), goals:'Increase average views and improve retention.' }
};

const localNames = new Set(['yt-edit','yt-viral','yt-retention','yt-chapters']);
const jobs = new Map();

function validate(name, result) {
  if (result == null) throw new Error('Empty result');
  if (name==='yt-script' && (!Array.isArray(result.hooks) || result.hooks.length < 1 || !String(result.first15s||'').trim())) throw new Error('Missing hooks or first15s');
  if (name==='yt-package' && !Array.isArray(result.pairs || result.topPairs || result.titles)) throw new Error('Missing package pairs/titles');
  if (name==='yt-edit' && typeof result !== 'object') throw new Error('Invalid edit result');
  if (name==='yt-comment' && typeof result !== 'object') throw new Error('Invalid comment result');
  if (name==='yt-plan' && typeof result !== 'object') throw new Error('Invalid plan result');
  if (name==='yt-viral' && typeof result !== 'object') throw new Error('Invalid viral result');
  if (name==='yt-retention' && typeof result !== 'object') throw new Error('Invalid retention result');
  if (name==='yt-shorts' && typeof result !== 'object') throw new Error('Invalid shorts result');
  if (name==='yt-seo' && typeof result !== 'object') throw new Error('Invalid SEO result');
  if (name==='yt-chapters' && typeof result !== 'object') throw new Error('Invalid chapters result');
  if (name==='yt-audit' && typeof result !== 'object') throw new Error('Invalid audit result');
}

export function startTestAllSkills() {
  const id = randomUUID();
  const names = listSkills().map(x => x.name);
  const job = { id, status:'RUNNING', current:null, currentIndex:-1, total:names.length, completed:0, passed:0, failed:0, startedAt:Date.now(), results:[], log:[] };
  jobs.set(id, job);
  void runTestJob(job, names);
  return publicJob(job);
}

export function getTestAllStatus(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

async function runTestJob(job, names) {
  try {
    for (let i=0;i<names.length;i++) {
      const name=names[i];
      const started=Date.now();
      job.current=name;
      job.currentIndex=i;
      pushLog(job, 'START', name, `Starting ${name} (${i+1}/${names.length})`);
      try {
        const result=await runSkill(name,cases[name]||{});
        validate(name,result);
        job.results.push({skill:name,type:localNames.has(name)?'local':'ai',status:'PASS',durationMs:Date.now()-started,summary:summarize(name,result)});
        job.passed++;
        pushLog(job, 'PASS', name, `${name} passed in ${Date.now()-started}ms`);
      } catch (error) {
        job.results.push({skill:name,type:localNames.has(name)?'local':'ai',status:'FAIL',durationMs:Date.now()-started,error:String(error?.message||error)});
        job.failed++;
        pushLog(job, 'FAIL', name, `${name} failed: ${String(error?.message||error)}`);
      }
      job.completed=i+1;
    }
    job.current=null;
    job.currentIndex=-1;
    job.status='COMPLETED';
    job.finishedAt=Date.now();
    pushLog(job, 'DONE', null, `All ${names.length} skills finished`);
  } catch (error) {
    job.status='FAILED';
    job.error=String(error?.message||error);
    job.finishedAt=Date.now();
    pushLog(job, 'ERROR', null, job.error);
  }
}

function pushLog(job,type,skill,message){
  job.log.push({at:Date.now(),type,skill,message});
  if(job.log.length>100) job.log.shift();
}

function publicJob(job){
  return {
    jobId:job.id,status:job.status,current:job.current,currentIndex:job.currentIndex,total:job.total,
    completed:job.completed,passed:job.passed,failed:job.failed,
    percent:job.total?Math.round((job.completed/job.total)*100):0,
    elapsedMs:(job.finishedAt||Date.now())-job.startedAt,
    startedAt:job.startedAt,finishedAt:job.finishedAt,error:job.error||null,
    results:job.results,log:job.log
  };
}

function summarize(name,r){
  if(name==='yt-script') return `${r.hooks?.length||0} hooks, ${r.beats?.length||0} beats`;
  if(name==='yt-package') return `${(r.pairs||r.topPairs||r.titles||[]).length} package options`;
  if(name==='yt-shorts') return `${(r.shorts||r.items||[]).length} shorts/items`;
  if(name==='yt-chapters') return `${(r.chapters||[]).length} chapters`;
  return 'Valid JSON/object returned';
}
