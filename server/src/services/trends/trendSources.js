// Free trend sources:
//  - Google Trends "Trending now" RSS (no key)
//  - YouTube most-popular chart for a region (needs YOUTUBE_DATA_API_KEY, optional)
const GOOGLE_TRENDS_FEEDS=geo=>[`https://trends.google.com/trending/rss?geo=${geo}`,`https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}`];
const cache=new Map();const TTL=30*60*1000;
const decode=s=>String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").trim();
const tag=(xml,name)=>{const m=new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`,'i').exec(xml);return m?decode(m[1]):'';};
const tags=(xml,name)=>[...xml.matchAll(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`,'gi'))].map(m=>decode(m[1])).filter(Boolean);

export function parseTrendsRss(xml=''){
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m=>{
    const item=m[1];
    return {title:tag(item,'title'),traffic:tag(item,'ht:approx_traffic'),published:tag(item,'pubDate'),news:tags(item,'ht:news_item_title').slice(0,3),source:'google-trends'};
  }).filter(t=>t.title);
}
async function cached(key,fn){const hit=cache.get(key);if(hit&&Date.now()-hit.at<TTL)return hit.value;const value=await fn();cache.set(key,{at:Date.now(),value});return value;}

export async function fetchGoogleTrends(geo='IN',fetchImpl=fetch){
  return cached(`gt:${geo}`,async()=>{
    let lastError;
    for(const url of GOOGLE_TRENDS_FEEDS(encodeURIComponent(geo))){
      try{const r=await fetchImpl(url,{headers:{'User-Agent':'Mozilla/5.0 (YouTube AI Agent)'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);const items=parseTrendsRss(await r.text());if(items.length)return items;lastError=new Error('feed was empty');}
      catch(e){lastError=e;}
    }
    throw new Error(`Google Trends unavailable: ${lastError?.message||'unknown error'}`);
  });
}
export async function fetchYouTubeTrending({key,region='IN',categoryId=''},fetchImpl=fetch){
  if(!key)throw new Error('YouTube trending needs YOUTUBE_DATA_API_KEY in server/.env.');
  return cached(`yt:${region}:${categoryId}`,async()=>{
    const q=new URLSearchParams({part:'snippet,statistics',chart:'mostPopular',regionCode:region,maxResults:'25',key});
    if(categoryId)q.set('videoCategoryId',categoryId);
    const r=await fetchImpl(`https://www.googleapis.com/youtube/v3/videos?${q}`);
    if(!r.ok){let msg=`HTTP ${r.status}`;try{msg=(await r.json()).error?.message||msg;}catch{}throw new Error(`YouTube trending unavailable: ${msg}`);}
    return ((await r.json()).items||[]).map(v=>({title:v.snippet?.title||'',channel:v.snippet?.channelTitle||'',views:Number(v.statistics?.viewCount||0),tags:(v.snippet?.tags||[]).slice(0,6),source:'youtube-trending'})).filter(v=>v.title);
  });
}
// Both sources; each failure is reported but does not stop the other.
export async function collectTrends({region='IN',youtubeKey='',youtubeCategoryId=''}={},fetchImpl=fetch){
  const [g,y]=await Promise.allSettled([fetchGoogleTrends(region,fetchImpl),fetchYouTubeTrending({key:youtubeKey,region,categoryId:youtubeCategoryId},fetchImpl)]);
  return {
    google:g.status==='fulfilled'?g.value.slice(0,20):[],
    youtube:y.status==='fulfilled'?y.value.slice(0,20):[],
    errors:[g.status==='rejected'?g.reason.message:null,y.status==='rejected'&&youtubeKey?y.reason.message:null].filter(Boolean)
  };
}
export function _clearTrendCache(){cache.clear();}
