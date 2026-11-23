import Series from '../models/Series.js';
import AutopilotRun from '../models/AutopilotRun.js';
import {normalizeAutopilot,nextSlots} from '../services/autopilot/autopilotRules.js';
import {createRun} from '../services/autopilot/autopilotRunner.js';
import {readiness} from '../services/youtube/youtubeAccount.js';

async function load(id){const s=/^[a-f0-9]{24}$/i.test(String(id))?await Series.findById(id).lean():null;return s&&!s.archived?s:null;}
export async function status(req,res,next){try{
  const s=await load(req.params.seriesId);if(!s)return res.status(404).json({error:'Channel profile not found.'});
  const settings=normalizeAutopilot(s.autopilot,{timezone:s.uploadSettings?.timezone});
  const yt=readiness(s.youtubeAccount);
  const runs=await AutopilotRun.find({seriesId:s._id}).sort({slotAt:-1}).limit(20).lean();
  res.json({settings,nextSlots:nextSlots(settings),youtube:{ready:yt.configured&&yt.connected&&yt.publishEnabled,problems:yt.problems},telegram:{on:Boolean(s.telegram?.enabled&&s.telegram?.chats?.length)},runs:runs.map(r=>({...r,log:(r.log||[]).slice(-8)}))});
}catch(e){next(e);}}
// Make one automatic video now (uploads as soon as it is ready and passes the checks).
export async function runNow(req,res,next){try{
  const s=await load(req.params.seriesId);if(!s)return res.status(404).json({error:'Channel profile not found.'});
  const yt=readiness(s.youtubeAccount);
  if(!(yt.configured&&yt.connected&&yt.publishEnabled))return res.status(409).json({error:`YouTube is not ready for this profile: ${yt.problems.join(' ')}`});
  const run=await createRun(s,new Date(),{manual:true});
  if(!run)return res.status(409).json({error:'A run was just created; try again in a minute.'});
  res.status(202).json({ok:true,runId:run._id});
}catch(e){next(e);}}
