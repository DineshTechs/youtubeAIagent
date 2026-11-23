// Trend-based topics for a channel profile (database + providers).
import Story from '../../models/Story.js';
import {env} from '../../config/env.js';
import {buildChannelProfile} from '../channelProfile.js';
import {getActiveProvider} from '../ai/index.js';
import {collectTrends} from './trendSources.js';
import {suggestTrendingTopics} from './trendTopics.js';

export async function recentTopicsFor(seriesId,limit=30){
  const stories=await Story.find({seriesId}).sort({createdAt:-1}).limit(limit).select('topic title').lean();
  return stories.flatMap(s=>[s.topic,s.title]).filter(Boolean);
}
export async function trendIdeasFor(series,{count=6,provider}={}){
  const profile=buildChannelProfile(series);
  const region=profile.content?.trendRegion||'IN';
  const trends=await collectTrends({region,youtubeKey:env.youtubeDataApiKey});
  if(!trends.google.length&&!trends.youtube.length)throw new Error(`No trend data available (${trends.errors.join('; ')||'unknown error'}).`);
  const ideas=await suggestTrendingTopics({provider:provider||await getActiveProvider(),profile,series,trends,recentTopics:await recentTopicsFor(series._id),count});
  return {region,ideas,trends:{google:trends.google.slice(0,12),youtube:trends.youtube.slice(0,8)},errors:trends.errors};
}
// Topic for a new video when none was typed. Returns {topic, source, idea?, note?}.
export async function chooseTopic(series,{provider}={}){
  const profile=buildChannelProfile(series);
  const source=profile.content?.topicSource||'queue-then-trending';
  const queue=Array.isArray(series.topicIdeas)?series.topicIdeas.filter(Boolean):[];
  if(source!=='trending'&&queue.length){const cursor=Number(series.topicCursor||0);return {topic:queue[cursor%queue.length],source:'topic-queue',advanceQueue:true};}
  if(source==='queue')return {topic:null,source:'ai-selected'};
  try{
    const {ideas,region}=await trendIdeasFor(series,{count:3,provider});
    if(ideas[0])return {topic:ideas[0].topic,source:'trending',idea:ideas[0],region};
    return {topic:null,source:'ai-selected',note:'No trending topic fitted this channel.'};
  }catch(e){return {topic:null,source:'ai-selected',note:`Trending topics unavailable (${e.message}); the AI picks the topic.`};}
}
