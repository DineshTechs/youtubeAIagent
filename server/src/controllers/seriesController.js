import Series from "../models/Series.js";
import Character from "../models/Character.js";
import Story from "../models/Story.js";
import { studyChannel } from "../services/youtubeChannelResearch.js";
import GenerationJob from "../models/GenerationJob.js";
import { removeSeries, ProfileRemovalError } from "../services/seriesRemoval.js";
import { publicSeries } from "../services/youtube/youtubeAccount.js";
import { normalizeAutopilot } from "../services/autopilot/autopilotRules.js";

export async function listSeries(req, res, next) {
  try { res.json(await Series.find({ archived: { $ne: true } }).sort({ active: -1, updatedAt: -1 })); } catch (e) { next(e); }
}

export async function createSeries(req, res, next) {
  // YouTube credentials are only set through PUT /api/youtube/account/:seriesId.
  try { const { youtubeAccount, telegram, ...body } = req.body || {}; res.status(201).json(await Series.create(body)); } catch (e) { next(e); }
}

export async function updateSeries(req, res, next) {
  try {
    const allowed={name:req.body.name,premise:req.body.premise,niche:req.body.niche,targetAge:req.body.targetAge,language:req.body.language,visualStyle:req.body.visualStyle,channelProfile:req.body.channelProfile,uploadSettings:req.body.uploadSettings,autopilot:req.body.autopilot===undefined?undefined:normalizeAutopilot(req.body.autopilot,{timezone:req.body.uploadSettings?.timezone}),rules:req.body.rules,active:req.body.active,topicIdeas:req.body.topicIdeas,channelResearch:req.body.channelResearch,contentStrategy:req.body.contentStrategy};
    Object.keys(allowed).forEach(k=>allowed[k]===undefined&&delete allowed[k]);
    const series=await Series.findByIdAndUpdate(req.params.id,{$set:allowed},{new:true,runValidators:true});
    if(!series)return res.status(404).json({error:'Series not found'});
    res.json(series);
  } catch(e){next(e);}
}

export async function activateSeries(req,res,next){
  try{
    const target=await Series.findById(req.params.id);
    if(!target||target.archived)return res.status(404).json({error:'Series not found'});
    await Series.updateMany({_id:{$ne:target._id}},{$set:{active:false}});
    target.active=true; await target.save(); res.json(target);
  }catch(e){next(e);}
}

export async function getSeriesContext(req,res,next){
  try{
    const series=await Series.findById(req.params.id).lean();
    if(!series)return res.status(404).json({error:'Series not found'});
    const recent=await Story.find({seriesId:series._id}).sort({createdAt:-1}).limit(12).select('title topic createdAt').lean();
    res.json({series:publicSeries(series),recentStories:recent});
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
      targetAge:strategy.targetAge||strategy.audience||'General audience',
      language:language,
      visualStyle:strategy.visualStyle||'',
      tone:strategy.tone||'Engaging and informative',
      contentFormat:strategy.primaryFormat||strategy.formatPatterns?.[0]||'Explainer',
      aspectRatio:'9:16',
      voiceStyle:strategy.voiceStyle||'Natural, clear and engaging',
      channelProfile:strategy.channelProfile||{niche:strategy.niche||'',targetAudience:strategy.audience||'General audience',tone:strategy.tone||'Engaging and informative',content:{primaryFormat:strategy.primaryFormat||'Explainer',tone:strategy.tone||'Engaging and informative'},visual:{style:strategy.visualStyle||'Cinematic, high-quality visuals'},narration:{voiceStyle:strategy.voiceStyle||'Natural and engaging'},source:'channel-research'}
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
    series.targetAge=strategy.audience||series.targetAge||'General audience';
    series.channelProfile={
      ...(series.channelProfile||{}),
      version:1,
      niche:series.niche,
      targetAudience:strategy.audience||'General audience',
      audience:{...(series.channelProfile?.audience||{}),description:strategy.audience||'General audience'},
      content:{...(series.channelProfile?.content||{}),primaryFormat:strategy.primaryFormat||strategy.formatPatterns?.[0]||'Explainer',tone:strategy.tone||'Engaging and informative'},
      visual:{...(series.channelProfile?.visual||{}),style:strategy.visualStyle||series.visualStyle,aspectRatio:series.channelProfile?.visual?.aspectRatio||'9:16'},
      narration:{...(series.channelProfile?.narration||{}),voiceStyle:strategy.voiceStyle||'Natural, clear and engaging'},
      source:'channel-research'
    };
    series.visualStyle=strategy.visualStyle||series.visualStyle;
    series.topicIdeas=Array.isArray(strategy.topicIdeas)?strategy.topicIdeas.map(String).slice(0,50):series.topicIdeas;
    await series.save();
    res.json({series,research:result});
  }catch(e){next(e);}
}

export async function seedUniverse(req, res, next) {
  try {
    let series = await Series.findOne({ name: "My YouTube Channel" });
    if (!series) {
      series = await Series.create({
        name: "My YouTube Channel",
        premise: "Create original videos that serve the channel's niche and audience.",
        niche: "General",
        targetAge: "General audience",
        language: "English",
        visualStyle: "Cinematic, high-quality visuals",
        channelProfile: {
          version: 1,
          audience: { description: "General audience", knowledgeLevel: "general" },
          content: { primaryFormat: "Explainer", tone: "Engaging and informative", storytellingApproach: "Clear and niche-appropriate" },
          visual: { style: "Cinematic, high-quality visuals", aspectRatio: "9:16" },
          narration: { voiceStyle: "Natural, clear and engaging" },
          editorial: { safetyMode: "standard", factChecking: true },
          source: "default-general-channel"
        }
      });
    }
    res.json({ series, seeded: true });
  } catch (e) { next(e); }
}

export async function deleteSeries(req,res,next){
  try{ res.json({deleted:true,...await removeSeries({Series,Story,Character,GenerationJob},req.params.id)}); }
  catch(e){ if(e instanceof ProfileRemovalError) return res.status(e.status).json({error:e.message}); next(e); }
}
