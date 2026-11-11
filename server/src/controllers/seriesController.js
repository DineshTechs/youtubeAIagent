import Series from "../models/Series.js";
import Character from "../models/Character.js";
import Story from "../models/Story.js";
import { studyChannel } from "../services/youtubeChannelResearch.js";

export async function listSeries(req, res, next) {
  try { res.json(await Series.find().sort({ active: -1, createdAt: -1 })); } catch (e) { next(e); }
}

export async function createSeries(req, res, next) {
  try { res.status(201).json(await Series.create(req.body)); } catch (e) { next(e); }
}

export async function updateSeries(req, res, next) {
  try {
    const allowed={name:req.body.name,premise:req.body.premise,niche:req.body.niche,targetAge:req.body.targetAge,language:req.body.language,visualStyle:req.body.visualStyle,rules:req.body.rules,active:req.body.active,topicIdeas:req.body.topicIdeas,channelResearch:req.body.channelResearch,contentStrategy:req.body.contentStrategy};
    Object.keys(allowed).forEach(k=>allowed[k]===undefined&&delete allowed[k]);
    const series=await Series.findByIdAndUpdate(req.params.id,{$set:allowed},{new:true,runValidators:true});
    if(!series)return res.status(404).json({error:'Series not found'});
    res.json(series);
  } catch(e){next(e);}
}

export async function activateSeries(req,res,next){
  try{
    const target=await Series.findById(req.params.id);
    if(!target)return res.status(404).json({error:'Series not found'});
    await Series.updateMany({_id:{$ne:target._id}},{$set:{active:false}});
    target.active=true; await target.save(); res.json(target);
  }catch(e){next(e);}
}

export async function getSeriesContext(req,res,next){
  try{
    const series=await Series.findById(req.params.id).lean();
    if(!series)return res.status(404).json({error:'Series not found'});
    const recent=await Story.find({seriesId:series._id}).sort({createdAt:-1}).limit(12).select('title topic createdAt').lean();
    res.json({series,recentStories:recent});
  }catch(e){next(e);}
}


export async function researchChannel(req,res,next){
  try{
    const url=String(req.body?.url||'').trim();
    const language=String(req.body?.language||'English');
    if(!url)return res.status(400).json({error:'YouTube channel URL is required'});
    const result=await studyChannel(url,language);
    const strategy=result.strategy||{};
    res.json({research:result,autofill:{
      name:strategy.seriesName||strategy.channelName||result.raw?.channelTitle||'New YouTube Series',
      premise:strategy.premise||strategy.strategySummary||'',
      niche:strategy.niche||'',
      targetAge:strategy.targetAge||'4-8',
      language:language,
      visualStyle:strategy.visualStyle||''
    }});
  }catch(e){next(e);}
}

export async function researchSeriesChannel(req,res,next){
  try{
    const series=await Series.findById(req.params.id);
    if(!series)return res.status(404).json({error:'Series not found'});
    const url=String(req.body?.url||'').trim();
    const result=await studyChannel(url, series.language || 'English');
    const strategy=result.strategy||{};
    series.channelResearch=result;
    series.contentStrategy=strategy;
    series.niche=strategy.niche||series.niche||'';
    series.visualStyle=strategy.visualStyle||series.visualStyle;
    series.topicIdeas=Array.isArray(strategy.topicIdeas)?strategy.topicIdeas.map(String).slice(0,50):series.topicIdeas;
    await series.save();
    res.json({series,research:result});
  }catch(e){next(e);}
}

export async function seedUniverse(req, res, next) {
  try {
    let series = await Series.findOne({ name: "Little Bunny Adventures" });
    if (!series) {
      series = await Series.create({ name: "Little Bunny Adventures", premise: "A kind little bunny learns simple life lessons through wholesome adventures.", niche:"Kids educational stories", targetAge: "4-8", language: "English", visualStyle: "bright, soft, colorful 3D children's animation", rules: ["No violence", "No frightening imagery", "Positive and age-appropriate", "Original characters"] });
    }
    const existing = await Character.findOne({ seriesId: series._id, name: "Little Bunny" });
    if (!existing) await Character.create({ seriesId: series._id, name: "Little Bunny", personality: "curious, kind, playful and helpful", appearance: "small cream-colored bunny with long ears, blue overalls and a yellow scarf", voiceProfile: "warm, cheerful child-friendly narrator" });
    res.json({ series, seeded: true });
  } catch (e) { next(e); }
}
