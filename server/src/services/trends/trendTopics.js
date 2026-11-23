// Turns current trends into video topics that fit a channel profile.
export const TOPIC_SOURCES=['queue-then-trending','trending','queue'];
const norm=s=>String(s||'').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{M}\p{N}]+/gu,' ').trim();
function similar(a,b){const A=new Set(norm(a).split(' ').filter(w=>w.length>2)),B=new Set(norm(b).split(' ').filter(w=>w.length>2));if(!A.size||!B.size)return false;let inter=0;for(const w of A)if(B.has(w))inter++;return inter/Math.min(A.size,B.size)>=0.6;}

export function trendInstruction({profile={},count=5}={}){
  const language=profile.language||'English';
  const kids=profile.editorial?.safetyMode==='kids-and-family';
  return `You are a YouTube content strategist for ONE channel. From the CURRENT TRENDS in INPUT, propose ${count} video topics for this channel.
Rules:
- Each topic must genuinely fit the channel's niche, audience, format and tone (see channelProfile). Connect a trend to the niche with a clear angle (for example a moral-story channel can turn a trending event into a story with a lesson). Do not just copy a trend headline.
- Prefer trends with high traffic that the audience cares about. If no trend fits the niche, propose evergreen topics for the niche instead and set "trend" to "evergreen".
- Never exploit tragedies, deaths, disasters, crimes or victims; avoid partisan politics, medical or financial claims, rumours and real private individuals.${kids?' The channel is for kids and families: only wholesome, age-appropriate topics.':''}
- Avoid topics too similar to recentTopics and anything in avoidTopics.
- Write "topic" in ${language} (short, specific, under 90 characters) — it is passed to the script writer as the video subject.
Return JSON only: {"topics":[{"topic":"","angle":"","trend":"","reason":"","fit":0}]} where fit is 0-100 for how well it fits the channel.`;
}

export function normalizeTopicIdeas(raw,{recentTopics=[],avoid=[],count=5}={}){
  const list=Array.isArray(raw?.topics)?raw.topics:Array.isArray(raw)?raw:[];
  const out=[];
  for(const t of list){
    const topic=String(t?.topic||'').replace(/\s+/g,' ').trim().slice(0,160);
    if(topic.length<4)continue;
    if([...recentTopics,...out.map(o=>o.topic)].some(r=>similar(r,topic)))continue;
    if(avoid.some(a=>a&&norm(topic).includes(norm(a))))continue;
    out.push({topic,angle:String(t?.angle||'').slice(0,300),trend:String(t?.trend||'').slice(0,160)||'evergreen',reason:String(t?.reason||'').slice(0,300),fit:Math.max(0,Math.min(100,Number(t?.fit)||0))});
  }
  return out.sort((a,b)=>b.fit-a.fit).slice(0,count);
}

export async function suggestTrendingTopics({provider,profile,series={},trends,recentTopics=[],count=5}){
  const input={
    channelProfile:{name:series.name,niche:profile?.niche||series.niche,premise:series.premise,language:profile?.language,audience:profile?.audience,content:profile?.content,editorial:profile?.editorial},
    currentTrends:{googleTrends:(trends.google||[]).map(t=>({title:t.title,traffic:t.traffic,news:t.news})),youtubeTrending:(trends.youtube||[]).map(v=>({title:v.title,channel:v.channel,views:v.views}))},
    recentTopics:recentTopics.slice(0,30),
    avoidTopics:profile?.editorial?.avoidTopics||[]
  };
  const raw=await provider.generateJson(trendInstruction({profile,count:count+2}),input,'trending-topics');
  return normalizeTopicIdeas(raw,{recentTopics,avoid:profile?.editorial?.avoidTopics||[],count});
}
