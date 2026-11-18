// Per-profile YouTube upload settings. Stored on Series.uploadSettings and used
// as the defaults for every upload of a video made with that profile.
import {extractSeo} from './youtube/uploadSeo.js';
export const YT_CATEGORIES=[
  ['1','Film & Animation'],['2','Autos & Vehicles'],['10','Music'],['15','Pets & Animals'],['17','Sports'],
  ['19','Travel & Events'],['20','Gaming'],['22','People & Blogs'],['23','Comedy'],['24','Entertainment'],
  ['25','News & Politics'],['26','Howto & Style'],['27','Education'],['28','Science & Technology'],['29','Nonprofits & Activism']
];
export const PRIVACY_OPTIONS=['private','unlisted','public'];
export const LANGUAGE_CODES={english:'en',hindi:'hi',spanish:'es',french:'fr',german:'de',portuguese:'pt',arabic:'ar',bengali:'bn',tamil:'ta',telugu:'te',marathi:'mr',urdu:'ur',japanese:'ja',korean:'ko'};
const TAGS_CHAR_LIMIT=480; // YouTube rejects tag lists over 500 characters.

const text=(v,max=5000)=>String(v??'').replace(/[<>]/g,'').trim().slice(0,max);
const bool=(v,fallback)=>typeof v==='boolean'?v:(v==='true'?true:v==='false'?false:fallback);
function list(v){
  const items=Array.isArray(v)?v:String(v??'').split(/[\n,]/);
  return [...new Set(items.map(x=>String(x||'').replace(/[<>]/g,'').trim()).filter(Boolean))];
}
export function languageCode(language){
  const raw=String(language||'').trim();
  if(/^[a-z]{2}(-[A-Za-z]{2})?$/.test(raw))return raw;
  return LANGUAGE_CODES[raw.toLowerCase()]||'';
}
function validTime(v){const m=/^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v||'').trim());return m?`${m[1].padStart(2,'0')}:${m[2]}`:'';}
function validZone(v){const z=String(v||'').trim();if(!z)return '';try{new Intl.DateTimeFormat('en-US',{timeZone:z});return z;}catch{return '';}}

export function normalizeUploadSettings(raw={},{kids=false,language='English'}={}){
  const s=raw&&typeof raw==='object'?raw:{};
  const privacyStatus=PRIVACY_OPTIONS.includes(s.privacyStatus)?s.privacyStatus:'private';
  const categoryId=YT_CATEGORIES.some(([id])=>id===String(s.categoryId))?String(s.categoryId):(kids?'1':'24');
  return {
    privacyStatus,
    categoryId,
    // YouTube requires an explicit audience declaration. Default follows the
    // profile's audience instead of the old "always made for kids" default.
    madeForKids:bool(s.madeForKids,kids),
    // Videos are AI-generated; YouTube asks creators to disclose realistic altered/synthetic media.
    containsSyntheticMedia:bool(s.containsSyntheticMedia,true),
    notifySubscribers:bool(s.notifySubscribers,true),
    embeddable:bool(s.embeddable,true),
    publicStatsViewable:bool(s.publicStatsViewable,true),
    license:s.license==='creativeCommon'?'creativeCommon':'youtube',
    titleTemplate:text(s.titleTemplate,200)||'{title}',
    tags:list(s.tags).map(t=>t.slice(0,100)).slice(0,40),
    hashtags:list(s.hashtags).map(h=>h.replace(/^#+/,'').replace(/\s+/g,'')).filter(Boolean).slice(0,15),
    // Keywords this channel wants to rank for; given to the SEO AI and added as tags.
    seoKeywords:list(s.seoKeywords).map(k=>k.slice(0,100)).slice(0,20),
    descriptionFooter:text(s.descriptionFooter,2000),
    playlistId:/^[A-Za-z0-9_-]{10,64}$/.test(String(s.playlistId||'').trim())?String(s.playlistId).trim():'',
    defaultLanguage:languageCode(s.defaultLanguage)||languageCode(language),
    scheduleTime:validTime(s.scheduleTime),
    timezone:validZone(s.timezone)||'Asia/Kolkata'
  };
}

function capTags(tags){
  const out=[];let used=0;
  for(const t of tags){const cost=t.length+(/\s/.test(t)?2:0)+(out.length?1:0);if(used+cost>TAGS_CHAR_LIMIT)break;out.push(t);used+=cost;}
  return out;
}

// opts (from the Upload dialog) override the profile; the profile overrides the
// AI-generated SEO metadata stored on the story.
// `seo` = AI upload SEO for this video (story.uploadSeo); falls back to the
// generation-time yt-seo skill output.
export function buildUploadMetadata({story={},video={},settings,profileName='',opts={},seo=null}){
  const s=settings||normalizeUploadSettings({});
  const legacy=extractSeo(story?.youtubeOptimization?.seo)||{};
  const ai=seo||{};
  const baseTitle=text(opts.title||ai.title||story?.title||video?.title||'Untitled video',100);
  const templ=opts.title?'{title}':s.titleTemplate;
  const title=text(templ.replace(/\{title\}/g,baseTitle).replace(/\{channel\}/g,profileName||''),100)||baseTitle;
  let description=String(opts.description??'').trim();
  if(!description){
    const base=ai.description||legacy.description||`${story?.topic||story?.title||'New video'}`;
    const hashtags=s.hashtags.map(h=>`#${h}`).join(' ');
    description=[base,hashtags,s.descriptionFooter].map(x=>String(x||'').trim()).filter(Boolean).join('\n\n');
  }
  description=text(description,5000);
  const sourceTags=Array.isArray(opts.tags)?opts.tags.map(String):[...s.tags,...(ai.tags||[]),...(legacy.tags||[]),...s.seoKeywords];
  const tags=capTags([...new Set(sourceTags.map(t=>text(t,100).replace(/^#+/,'')).filter(Boolean))]);
  const privacyStatus=PRIVACY_OPTIONS.includes(opts.privacyStatus)?opts.privacyStatus:s.privacyStatus;
  const lang=s.defaultLanguage||'';
  return {
    title,description,tags,categoryId:String(opts.categoryId||s.categoryId),
    ...(lang?{defaultLanguage:lang,defaultAudioLanguage:lang}:{}),
    privacyStatus,
    selfDeclaredMadeForKids:bool(opts.madeForKids,s.madeForKids),
    containsSyntheticMedia:s.containsSyntheticMedia,
    embeddable:s.embeddable,
    publicStatsViewable:s.publicStatsViewable,
    license:s.license,
    notifySubscribers:s.notifySubscribers,
    playlistId:s.playlistId
  };
}

// Wall-clock parts of `date` in `timeZone`.
function zoned(date,timeZone){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(date).map(p=>[p.type,p.value]));
  return {y:+parts.year,m:+parts.month,d:+parts.day,h:+parts.hour,mi:+parts.minute,s:+parts.second};
}
function zonedToUtc(y,m,d,h,mi,timeZone){
  let guess=Date.UTC(y,m-1,d,h,mi);
  for(let i=0;i<2;i++){const z=zoned(new Date(guess),timeZone);const asUtc=Date.UTC(z.y,z.m-1,z.d,z.h,z.mi,z.s);guess+=Date.UTC(y,m-1,d,h,mi)-asUtc;}
  return new Date(guess);
}
// Next occurrence of the profile's daily publish time, at least `minLeadMin` from now.
export function nextScheduledSlot(time,timeZone='Asia/Kolkata',now=new Date(),minLeadMin=15){
  const t=validTime(time);if(!t)return null;
  const zone=validZone(timeZone)||'UTC';
  const [h,mi]=t.split(':').map(Number);
  const today=zoned(now,zone);
  for(let add=0;add<3;add++){
    const base=new Date(Date.UTC(today.y,today.m-1,today.d+add));
    const slot=zonedToUtc(base.getUTCFullYear(),base.getUTCMonth()+1,base.getUTCDate(),h,mi,zone);
    if(slot.getTime()>=now.getTime()+minLeadMin*60000)return slot;
  }
  return null;
}
