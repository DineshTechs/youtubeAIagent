// SEO for every YouTube upload:
//  1. AI-written metadata (title, description, tags, hashtags, focus keyword) in the
//     channel's language, grounded in the actual narration. Cached on the story.
//  2. Deterministic rules applied to whatever is uploaded (AI or hand-edited):
//     keyword placement, length limits, hashtag/tag hygiene, #shorts for Shorts.
//  3. A checklist/score shown before upload.
export const SEO_VERSION=1;
const MAX_TITLE=100, IDEAL_TITLE=70, MAX_DESC=5000, MAX_TAG_CHARS=480, MAX_HASHTAGS=15;

const str=v=>typeof v==='string'?v:(v&&typeof v==='object'?String(v.text||v.title||v.value||v.description||''):String(v??''));
const clean=v=>str(v).replace(/[<>]/g,'').replace(/[ \t]+/g,' ').trim();
const listOf=v=>Array.isArray(v)?v.map(clean).filter(Boolean):typeof v==='string'?v.split(/[,\n]/).map(clean).filter(Boolean):[];
const norm=s=>String(s||'').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{M}\p{N}]+/gu,' ').trim();
export function hashtagOf(v){const h=String(v||'').replace(/^#+/,'').replace(/[^\p{L}\p{M}\p{N}_]+/gu,'');return h?`#${h}`:'';}
const uniqBy=(arr,key)=>{const seen=new Set();return arr.filter(x=>{const k=key(x);if(!k||seen.has(k))return false;seen.add(k);return true;});};

// Accepts the many shapes AI models return (yt-seo skill or upload-seo) and normalizes them.
export function extractSeo(raw){
  if(!raw||typeof raw!=='object')return null;
  const r=raw.seo&&typeof raw.seo==='object'?{...raw,...raw.seo}:raw;
  const title=clean(r.title||r.seoTitle||r.optimizedTitle||r.videoTitle||'');
  const description=str(r.description||r.videoDescription||r.seoDescription||r.desc||'').replace(/[<>]/g,'').trim();
  const tags=listOf(r.tags||r.keywords||r.tagList);
  const hashtags=listOf(r.hashtags||r.hashTags).map(hashtagOf).filter(Boolean);
  const queries=listOf(r.searchQueries||r.search_queries||r.queries||r.targetQueries);
  const focusKeyword=clean(r.focusKeyword||r.primaryKeyword||r.focus_keyword||r.mainKeyword||queries[0]||tags[0]||'');
  if(!title&&!description&&!tags.length)return null;
  return {title,description,tags,hashtags,searchQueries:queries,focusKeyword};
}

export function isShortForm({durationSec,aspectRatio}={}){
  const vertical=!aspectRatio||/^9:16|3:4$/.test(String(aspectRatio));
  return vertical&&(!durationSec||Number(durationSec)<=180);
}

export function seoInstruction({language='English',isShort=true}){
  return `You are a YouTube SEO specialist. Write upload metadata for the video in INPUT, grounded ONLY in its narration — never invent facts, numbers, names or claims, never use misleading clickbait.
Write title and description in ${language}.${/hindi/i.test(language)?' Use Devanagari for Hindi text; tags may mix Hindi and common romanized (Hinglish) search terms people actually type.':''}
Rules:
- focusKeyword: the 2-4 word phrase a viewer would search to find this exact video.
- title: put the focus keyword (or its natural form) in the first 40 characters; ${isShort?'40-65':'50-70'} characters; specific and curiosity-driven; no ALL CAPS words, no emoji spam, no hashtags in the title.
- description: line 1 (max 150 characters) restates the hook and contains the focus keyword; then 2-4 short lines summarising what the viewer learns/feels, using 2-3 related keywords naturally; then one line inviting viewers to subscribe for more from this channel. No links, no hashtags in the body, no keyword lists.
- tags: 10-15 tags, most specific first, mixing the focus keyword, close variants, the topic, the channel niche and 1-2 broad tags. No hashtags, no '#', no duplicates.
- hashtags: 3-5 relevant hashtags without spaces${isShort?', including #shorts':''}.
- searchQueries: 3 search queries this video should rank for.
Return JSON only: {"focusKeyword":"","title":"","description":"","tags":[],"hashtags":[],"searchQueries":[]}`;
}
export function seoInput({story={},series={},profile={},settings={}}){
  const narration=(story.scenes||[]).map(s=>s.narration).filter(Boolean).join(' ').slice(0,4000);
  return {channel:series?.name||'',niche:profile?.niche||series?.niche||'',audience:profile?.audience?.description||'',language:profile?.language||series?.language||'English',
    channelKeywords:settings?.seoKeywords||[],currentTitle:story.title||'',topic:story.topic||'',hook:story.hook||'',narration};
}

// Final pass over whatever will be uploaded. Never rewrites the user's wording;
// only enforces limits, cleans tags/hashtags, adds the focus keyword as a tag and
// appends missing hashtags at the end of the description.
export function applySeoRules(meta,{focusKeyword='',isShort=false,hashtags=[]}={}){
  const out={...meta};
  out.title=clean(out.title).replace(/\s*#\S+/g,'').trim().slice(0,MAX_TITLE)||clean(meta.title).slice(0,MAX_TITLE);
  let desc=String(out.description||'').replace(/[<>]/g,'').replace(/\r\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  const present=new Set((desc.match(/#[\p{L}\p{M}\p{N}_]+/gu)||[]).map(h=>h.toLowerCase()));
  const wanted=uniqBy([...(isShort?['#shorts']:[]),...hashtags.map(hashtagOf)].filter(Boolean),h=>h.toLowerCase());
  const missing=wanted.filter(h=>!present.has(h.toLowerCase())).slice(0,Math.max(0,MAX_HASHTAGS-present.size));
  if(missing.length)desc=`${desc}\n\n${missing.join(' ')}`.trim();
  out.description=desc.slice(0,MAX_DESC);
  const kw=clean(focusKeyword);
  const tags=uniqBy([...(kw?[kw]:[]),...(out.tags||[]).map(t=>clean(t).replace(/^#+/,''))].filter(t=>t&&t.length<=100),t=>norm(t));
  const capped=[];let used=0;
  for(const t of tags){const cost=t.length+(/\s/.test(t)?2:0)+(capped.length?1:0);if(used+cost>MAX_TAG_CHARS)break;capped.push(t);used+=cost;}
  out.tags=capped;
  return out;
}

export function seoReport(meta,{focusKeyword='',isShort=false}={}){
  const title=meta.title||'',desc=meta.description||'',kw=norm(focusKeyword);
  const firstLine=desc.split('\n').find(l=>l.trim()&&!l.trim().startsWith('#'))||'';
  const hashtags=desc.match(/#[\p{L}\p{M}\p{N}_]+/gu)||[];
  const words=title.split(/\s+/).filter(w=>/[A-Z]{4,}/.test(w)&&w===w.toUpperCase());
  const checks=[
    {id:'keyword',label:'Focus keyword chosen',ok:Boolean(kw),tip:'Pick the phrase viewers would search.'},
    {id:'titleKeyword',label:'Focus keyword in title',ok:Boolean(kw)&&norm(title).includes(kw),tip:'Put the focus keyword near the start of the title.'},
    {id:'titleLength',label:`Title length ${title.length} (ideal ≤ ${IDEAL_TITLE})`,ok:title.length>=20&&title.length<=IDEAL_TITLE,tip:'Long titles are cut off on mobile.'},
    {id:'caps',label:'No shouting (ALL CAPS) in title',ok:words.length===0,tip:'Avoid all-caps words.'},
    {id:'descKeyword',label:'Focus keyword in first description line',ok:Boolean(kw)&&norm(firstLine.slice(0,160)).includes(kw),tip:'The first ~150 characters show in search results.'},
    {id:'descLength',label:`Description length ${desc.length}`,ok:desc.length>=120,tip:'Write at least 2-3 lines describing the video.'},
    {id:'tags',label:`${(meta.tags||[]).length} tags`,ok:(meta.tags||[]).length>=5,tip:'Add 5-15 specific tags.'},
    {id:'hashtags',label:`${hashtags.length} hashtags`,ok:hashtags.length>=1&&hashtags.length<=MAX_HASHTAGS,tip:'Use 3-5 hashtags; more than 15 are ignored.'},
    ...(isShort?[{id:'shorts',label:'#shorts hashtag',ok:hashtags.some(h=>h.toLowerCase()==='#shorts'),tip:'Helps YouTube treat it as a Short.'}]:[]),
    {id:'language',label:'Video language set',ok:Boolean(meta.defaultLanguage),tip:'Set the channel language in the profile.'}
  ];
  const score=Math.round(100*checks.filter(c=>c.ok).length/checks.length);
  return {score,checks};
}

// Generates and normalizes AI SEO. `provider` exposes generateJson(instruction,input,label).
export async function generateUploadSeo({provider,story,series,profile,settings,isShort}){
  const input=seoInput({story,series,profile,settings});
  const raw=await provider.generateJson(seoInstruction({language:input.language,isShort}),input,'upload-seo');
  const seo=extractSeo(raw);
  if(!seo)throw new Error('The AI returned no usable SEO metadata.');
  return {version:SEO_VERSION,generatedAt:new Date().toISOString(),language:input.language,source:'upload-seo',...seo};
}
