import { env } from '../config/env.js';
import { getActiveProvider } from './ai/index.js';

function parseChannelUrl(raw='') {
  const value=String(raw).trim();
  if(!value) throw new Error('Enter a YouTube channel URL.');
  let u;
  try { u=new URL(value); } catch { throw new Error('Enter a valid YouTube channel URL.'); }
  if(!/^(www\.)?youtube\.com$/i.test(u.hostname) && u.hostname.toLowerCase()!=='youtube.com') throw new Error('The URL must be a YouTube channel URL.');
  const parts=u.pathname.split('/').filter(Boolean);
  if(parts[0]==='channel' && parts[1]) return {channelId:parts[1]};
  if(parts[0]?.startsWith('@')) return {handle:parts[0].slice(1)};
  if(parts[0]==='@' && parts[1]) return {handle:parts[1]};
  if(parts[0]==='c' && parts[1]) return {search:parts[1]};
  if(parts[0]==='user' && parts[1]) return {search:parts[1]};
  throw new Error('Use a channel URL such as youtube.com/@channel or youtube.com/channel/CHANNEL_ID.');
}

async function youtubeApi(path, params={}) {
  if(!env.youtubeDataApiKey) return null;
  const qs=new URLSearchParams({...params,key:env.youtubeDataApiKey});
  const r=await fetch(`https://www.googleapis.com/youtube/v3/${path}?${qs}`);
  const text=await r.text();
  if(!r.ok) throw new Error(`YouTube Data API failed (${r.status}): ${text.slice(0,700)}`);
  return JSON.parse(text);
}

async function researchWithApi(url) {
  const ref=parseChannelUrl(url);
  let channel;
  if(ref.channelId){
    const data=await youtubeApi('channels',{part:'snippet,statistics,contentDetails',id:ref.channelId});
    channel=data?.items?.[0];
  } else if(ref.handle){
    const data=await youtubeApi('channels',{part:'snippet,statistics,contentDetails',forHandle:ref.handle});
    channel=data?.items?.[0];
  } else {
    const data=await youtubeApi('search',{part:'snippet',q:ref.search,type:'channel',maxResults:'1'});
    const id=data?.items?.[0]?.snippet?.channelId;
    if(id) {
      const full=await youtubeApi('channels',{part:'snippet,statistics,contentDetails',id});
      channel=full?.items?.[0];
    }
  }
  if(!channel) throw new Error('YouTube channel could not be found. Check the channel URL.');
  const uploads=channel.contentDetails?.relatedPlaylists?.uploads;
  let videos=[];
  if(uploads){
    const items=await youtubeApi('playlistItems',{part:'snippet,contentDetails',playlistId:uploads,maxResults:'25'});
    const ids=(items?.items||[]).map(x=>x.contentDetails?.videoId).filter(Boolean).slice(0,25);
    if(ids.length){
      const details=await youtubeApi('videos',{part:'snippet,statistics,contentDetails',id:ids.join(',')});
      videos=(details?.items||[]).map(v=>({
        videoId:v.id,title:v.snippet?.title||'',description:(v.snippet?.description||'').slice(0,500),publishedAt:v.snippet?.publishedAt||null,
        views:Number(v.statistics?.viewCount||0),likes:Number(v.statistics?.likeCount||0),comments:Number(v.statistics?.commentCount||0),duration:v.contentDetails?.duration||''
      }));
    }
  }
  return {
    sourceUrl:url,source:'youtube-data-api',channelId:channel.id,channelTitle:channel.snippet?.title||'',
    description:(channel.snippet?.description||'').slice(0,3000),country:channel.snippet?.country||'',
    subscribers:Number(channel.statistics?.subscriberCount||0),videoCount:Number(channel.statistics?.videoCount||0),viewCount:Number(channel.statistics?.viewCount||0),videos
  };
}

async function researchPublicPage(url) {
  const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (compatible; KidsYouTubeAgent/1.0)'}});
  const html=await r.text();
  if(!r.ok) throw new Error(`Could not open channel page (${r.status}).`);
  const title=(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]||'').replace(/\s+/g,' ').trim().replace(/\s*-\s*YouTube\s*$/i,'');
  const description=(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]||'').slice(0,3000);
  const subscriberText=(html.match(/"subscriberCountText"\s*:\s*\{"simpleText"\s*:\s*"([^"]+)"/)||[])[1]||'';
  const videoTitles=[];
  const re=/"title"\s*:\s*\{"runs"\s*:\s*\[\{"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m; while((m=re.exec(html))&&videoTitles.length<30){const t=m[1].replace(/\\"/g,'"');if(t && !videoTitles.includes(t)) videoTitles.push(t);}
  return {sourceUrl:url,source:'public-page',channelId:null,channelTitle:title,description,subscribersText:subscriberText,videos:videoTitles.slice(0,25).map(title=>({title}))};
}

function researchPrompt(raw, language='English') {
  return `You are a YouTube channel strategist. Study the supplied channel research and produce an ORIGINAL content strategy for a new creator. Identify the likely niche, audience, recurring content patterns, topic clusters, title patterns, hook patterns, pacing/format patterns and visual style. Do NOT copy scripts, titles verbatim, characters, thumbnails, or distinctive creative assets. The output should describe patterns and generate fresh ideas inspired by the channel's audience demand. Write the strategy text and all topicIdeas in ${language}; if Hindi, use natural Devanagari. Keep proper nouns/channel names unchanged when appropriate. Return JSON with: niche, audience, contentPillars (array), topicIdeas (array of 15 fresh topics), titlePatterns (array), hookPatterns (array), formatPatterns (array), visualStyle, tone, avoidRepeating (array), strategySummary.\n\nCHANNEL RESEARCH:\n${JSON.stringify(raw,null,2)}`;
}

export async function studyChannel(url, language='English') {
  let raw;
  if(env.youtubeDataApiKey) raw=await researchWithApi(url);
  else raw=await researchPublicPage(url);
  const provider=await getActiveProvider();
  const strategy=await provider.generateJson(researchPrompt(raw, language), raw, 'channel research');
  return {raw,strategy,analyzedAt:new Date().toISOString()};
}
