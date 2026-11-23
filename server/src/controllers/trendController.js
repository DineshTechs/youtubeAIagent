import Series from '../models/Series.js';
import {trendIdeasFor} from '../services/trends/trendService.js';
// Trending topic ideas for a profile (Google Trends + YouTube trending, filtered by the AI for this channel).
export async function ideas(req,res){
  try{
    const s=/^[a-f0-9]{24}$/i.test(String(req.params.seriesId))?await Series.findById(req.params.seriesId).lean():null;
    if(!s||s.archived)return res.status(404).json({error:'Channel profile not found.'});
    res.json(await trendIdeasFor(s,{count:Math.min(10,Math.max(1,Number(req.query.count)||6))}));
  }catch(e){res.status(502).json({error:e.message});}
}
