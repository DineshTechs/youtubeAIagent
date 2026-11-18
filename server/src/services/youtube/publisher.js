// YouTube publishing. Every channel profile (Series) has its own OAuth client,
// connected channel and upload defaults — nothing comes from .env.
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import Video from '../../models/Video.js';
import Series from '../../models/Series.js';
import {buildChannelProfile} from '../channelProfile.js';
import {normalizeUploadSettings,buildUploadMetadata,nextScheduledSlot} from '../uploadSettings.js';
import {credentialsOf,tokensOf,readiness,publicAccount,applyCredentialUpdate,withTokens,disconnected} from './youtubeAccount.js';
import Story from '../../models/Story.js';
import {getActiveProvider} from '../ai/index.js';
import {SEO_VERSION,extractSeo,generateUploadSeo,applySeoRules,seoReport,isShortForm} from './uploadSeo.js';
import {buildAuthUrl,exchangeCode,refreshTokens,needsRefresh,revokeToken,getMyChannel,uploadVideoFile,addToPlaylist} from './youtubeApi.js';

const states=new Map(); // OAuth state -> {seriesId, expires}
export class PublishError extends Error{constructor(message,status=400){super(message);this.status=status;}}

async function loadSeries(seriesId){
  const series=seriesId?await Series.findById(seriesId).lean():null;
  if(!series||series.archived)throw new PublishError('Channel profile not found.',404);
  return series;
}
async function saveAccount(seriesId,account){await Series.updateOne({_id:seriesId},{$set:{youtubeAccount:account}});}

export async function accountStatus(seriesId){const s=await loadSeries(seriesId);return {seriesId:String(s._id),profileName:s.name,...publicAccount(s.youtubeAccount),problems:readiness(s.youtubeAccount).problems};}
export async function updateAccount(seriesId,input){
  const s=await loadSeries(seriesId);
  let next;try{next=applyCredentialUpdate(s.youtubeAccount,input||{});}catch(e){throw new PublishError(e.message);}
  const oldTokens=tokensOf(s.youtubeAccount);
  if(oldTokens&&!next.tokens)await revokeToken(oldTokens.refresh_token||oldTokens.access_token);
  await saveAccount(s._id,next);
  return accountStatus(seriesId);
}
export async function disconnectAccount(seriesId){
  const s=await loadSeries(seriesId);const t=tokensOf(s.youtubeAccount);
  await revokeToken(t?.refresh_token||t?.access_token);
  await saveAccount(s._id,disconnected(s.youtubeAccount));
  return accountStatus(seriesId);
}

export async function getAuthUrl(seriesId){
  const s=await loadSeries(seriesId);const c=credentialsOf(s.youtubeAccount);
  if(!c.clientId||!c.clientSecret)throw new PublishError(`Add the OAuth Client ID and secret to the "${s.name}" profile first.`);
  for(const [k,v] of states)if(v.expires<Date.now())states.delete(k);
  const state=randomBytes(24).toString('hex');states.set(state,{seriesId:String(s._id),expires:Date.now()+10*60*1000});
  return buildAuthUrl({clientId:c.clientId,redirectUri:c.redirectUri,state});
}
export async function handleCallback(code,state){
  const entry=states.get(state);states.delete(state);
  if(!entry||entry.expires<Date.now())throw new PublishError('YouTube sign-in expired or is invalid. Start again from the dashboard.');
  const s=await loadSeries(entry.seriesId);const c=credentialsOf(s.youtubeAccount);
  const tokens=await exchangeCode({clientId:c.clientId,clientSecret:c.clientSecret,redirectUri:c.redirectUri,code});
  const channel=await getMyChannel(tokens.access_token);
  // Keep a refresh token from an earlier consent if Google did not send a new one.
  const prev=tokensOf(s.youtubeAccount);
  await saveAccount(s._id,withTokens(s.youtubeAccount,{...tokens,refresh_token:tokens.refresh_token||prev?.refresh_token},channel));
  return {...channel,profileName:s.name};
}
// Valid access token for this profile, refreshing and re-saving when needed.
async function accessTokenFor(series){
  const c=credentialsOf(series.youtubeAccount);let tokens=tokensOf(series.youtubeAccount);
  if(!tokens)throw new PublishError(`Connect the "${series.name}" profile to its YouTube channel first.`);
  if(needsRefresh(tokens)){
    try{tokens=await refreshTokens({clientId:c.clientId,clientSecret:c.clientSecret,tokens});}
    catch(e){await saveAccount(series._id,{...series.youtubeAccount,lastError:e.message});throw new PublishError(`${e.message} Reconnect the channel from the profile.`);}
    await saveAccount(series._id,withTokens(series.youtubeAccount,tokens));
  }
  return tokens.access_token;
}

async function videoContext(videoId){
  const video=await Video.findById(videoId).populate('storyId');if(!video)throw new PublishError('Video not found.',404);
  const story=video.storyId&&typeof video.storyId==='object'?video.storyId:null;
  const seriesId=video.seriesId||story?.seriesId;
  const series=seriesId?await Series.findById(seriesId).lean():null;
  const cp=series?buildChannelProfile(series):null;
  const kids=cp?.editorial?.safetyMode==='kids-and-family';
  const settings=normalizeUploadSettings(series?.uploadSettings,{kids,language:cp?.language||series?.language||'English'});
  const isShort=isShortForm({durationSec:video.durationSec,aspectRatio:cp?.visual?.aspectRatio});
  return {video,story,series,settings,profile:cp,isShort};
}

// Every upload is SEO-optimized: AI metadata is generated once per video (cached on
// the story) and reused; if the AI is unavailable the generation-time SEO is used.
async function ensureSeo(ctx,{force=false}={}){
  const {story,series,settings,profile,isShort}=ctx;
  const cached=story?.uploadSeo;
  if(!force&&cached?.version===SEO_VERSION&&cached.title)return {seo:cached,error:null};
  try{
    const provider=await getActiveProvider();
    const seo=await generateUploadSeo({provider,story,series,profile,settings,isShort});
    if(story?._id)await Story.updateOne({_id:story._id},{$set:{uploadSeo:seo}});
    return {seo,error:null};
  }catch(e){
    const fallback=cached||extractSeo(story?.youtubeOptimization?.seo);
    return {seo:fallback?{...fallback,source:fallback.source||'generation-skill'}:null,error:`AI SEO unavailable (${e.message}); using ${fallback?'earlier SEO data':'basic metadata'}.`};
  }
}
function finalMetadata(ctx,seo,opts){
  const {video,story,series,settings,isShort}=ctx;
  const base=buildUploadMetadata({story,video,settings,profileName:series?.name,opts,seo});
  const focusKeyword=seo?.focusKeyword||settings.seoKeywords[0]||'';
  const meta=applySeoRules(base,{focusKeyword,isShort,hashtags:[...settings.hashtags,...(seo?.hashtags||[])]});
  return {meta,report:seoReport(meta,{focusKeyword,isShort}),focusKeyword};
}
function seoSummary(seo,error,focusKeyword){return {focusKeyword,searchQueries:seo?.searchQueries||[],generatedAt:seo?.generatedAt||null,source:seo?.source||null,language:seo?.language||null,error};}
function resolvePublishAt(opts,settings){
  if(opts.publishAt){const d=new Date(opts.publishAt);if(Number.isNaN(d.getTime()))throw new PublishError('Invalid publish date.');if(d.getTime()<Date.now()+5*60000)throw new PublishError('Scheduled time must be at least 5 minutes in the future.');return d;}
  if(opts.schedule==='profile'){const d=nextScheduledSlot(settings.scheduleTime,settings.timezone);if(!d)throw new PublishError('This profile has no daily publish time set.');return d;}
  return null;
}
export function uploadBlockReason(video,series){
  if(!video)return 'Video not found.';
  if(!['APPROVED','UPLOADING'].includes(video.status))return `Video must be APPROVED before upload. Current status: ${video.status}`;
  if(!video.renderPath)return 'Rendered video file is missing.';
  if(!series)return 'This video is not linked to a channel profile, so there is no YouTube channel to upload to.';
  if(series.archived)return `The "${series.name}" profile was deleted/archived; its YouTube connection is not used.`;
  return null;
}
export async function previewUpload(videoId,opts={},{forceSeo=false}={}){
  const ctx=await videoContext(videoId);const {video,series,settings}=ctx;
  const {seo,error}=await ensureSeo(ctx,{force:forceSeo});
  const {meta,report,focusKeyword}=finalMetadata(ctx,seo,{});
  const account=series?publicAccount(series.youtubeAccount):null;
  return {metadata:meta,seo:seoSummary(seo,error,focusKeyword),seoReport:report,isShort:ctx.isShort,profile:series?{id:series._id,name:series.name}:null,settings,nextSlot:nextScheduledSlot(settings.scheduleTime,settings.timezone),
    blockReason:uploadBlockReason(video,series),youtube:account,problems:series?readiness(series.youtubeAccount).problems:[],youtubeVideoId:video.youtubeVideoId||null};
}
export async function regenerateSeo(videoId){return previewUpload(videoId,{},{forceSeo:true});}
export async function uploadVideo(videoId,opts={}){
  const ctx=await videoContext(videoId);const {video,series,settings}=ctx;
  const block=uploadBlockReason(video,series);if(block)throw new PublishError(block,409);
  const ready=readiness(series.youtubeAccount);
  if(!ready.configured||!ready.connected||!ready.publishEnabled)throw new PublishError(ready.problems.join(' '),409);
  const publishAt=resolvePublishAt(opts,settings);
  const {seo,error:seoError}=await ensureSeo(ctx);
  const {meta,report}=finalMetadata(ctx,seo,{title:opts.title,description:opts.description,tags:Array.isArray(opts.tags)?opts.tags:undefined,privacyStatus:opts.privacyStatus,madeForKids:opts.madeForKids});
  const accessToken=await accessTokenFor(series);
  const privacy=publishAt?'private':meta.privacyStatus;
  const channel=series.youtubeAccount?.channelTitle||'connected channel';
  await Video.findByIdAndUpdate(videoId,{$set:{status:'UPLOADING',youtubeMetadata:meta},$unset:{error:1},$push:{statusHistory:{status:'UPLOADING',message:`Uploading to YouTube channel "${channel}" (${publishAt?`scheduled ${publishAt.toISOString()}`:privacy}) using profile "${series.name}". SEO score ${report.score}/100${seo?.focusKeyword?`, focus keyword "${seo.focusKeyword}"`:''}.${seoError?` ${seoError}`:''}`,at:new Date(),attempt:0,source:'YOUTUBE'}}});
  const status={privacyStatus:privacy,selfDeclaredMadeForKids:meta.selfDeclaredMadeForKids,containsSyntheticMedia:meta.containsSyntheticMedia,embeddable:meta.embeddable,publicStatsViewable:meta.publicStatsViewable,license:meta.license};
  if(publishAt)status.publishAt=publishAt.toISOString();
  const snippet={title:meta.title,description:meta.description,tags:meta.tags,categoryId:meta.categoryId,...(meta.defaultLanguage?{defaultLanguage:meta.defaultLanguage,defaultAudioLanguage:meta.defaultAudioLanguage}:{})};
  let id;
  try{id=(await uploadVideoFile({accessToken,filePath:path.resolve(video.renderPath),snippet,status,notifySubscribers:meta.notifySubscribers})).id;}
  catch(e){
    // Do not leave the video stuck in UPLOADING; it can be uploaded again.
    const msg=`YouTube upload failed: ${e.message}`;
    await Video.findByIdAndUpdate(videoId,{$set:{status:'APPROVED',error:msg},$push:{statusHistory:{status:'APPROVED',message:msg,at:new Date(),attempt:0,source:'YOUTUBE'}}});
    throw new PublishError(msg,502);
  }
  const warnings=[];
  if(meta.playlistId){try{await addToPlaylist({accessToken,playlistId:meta.playlistId,videoId:id});}catch(e){warnings.push(`Uploaded, but adding to playlist ${meta.playlistId} failed: ${e.message}`);}}
  const finalStatus=publishAt?'SCHEDULED':'PUBLISHED';
  const message=publishAt?`Uploaded to "${channel}" (${id}); goes public ${publishAt.toISOString()}.`:`Uploaded to "${channel}" as ${privacy} (${id}).`;
  await Video.findByIdAndUpdate(videoId,{$set:{youtubeVideoId:id,status:finalStatus,scheduledAt:publishAt,youtubeMetadata:{...meta,privacyStatus:privacy,seoScore:report.score,seoChecks:report.checks,focusKeyword:seo?.focusKeyword||null,channelId:series.youtubeAccount?.channelId||null,uploadedAt:new Date(),warnings}},$push:{statusHistory:{status:finalStatus,message:[message,...warnings].join(' '),at:new Date(),attempt:0,source:'YOUTUBE'}}});
  return {youtubeVideoId:id,status:finalStatus,privacyStatus:privacy,publishAt,url:`https://www.youtube.com/watch?v=${id}`,metadata:meta,seoReport:report,warnings};
}
