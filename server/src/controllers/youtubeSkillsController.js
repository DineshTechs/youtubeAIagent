import { listSkills, runSkill } from '../services/youtubeSkills/index.js';
import { startTestAllSkills, getTestAllStatus } from '../services/youtubeSkills/testAll.js';

export function getSkills(_req,res){res.json({skills:listSkills(),source:'Jakeschincariol/youtube-agent-skill',mode:'integrated'});}

export async function executeSkill(req,res,next){
  try{
    const skill=String(req.params.skill||'').toLowerCase();
    const result=await runSkill(skill,req.body||{});
    res.json({skill,result});
  }catch(e){next(e);}
}

export function testAll(_req,res,next){try{res.status(202).json(startTestAllSkills());}catch(e){next(e);}}
export function testAllStatus(req,res){
  const job=getTestAllStatus(String(req.params.jobId||''));
  if(!job) return res.status(404).json({error:'Test job not found'});
  res.set('Cache-Control','no-store');
  res.json(job);
}
