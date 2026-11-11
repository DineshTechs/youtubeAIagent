import {google} from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import Video from '../../models/Video.js';
import Story from '../../models/Story.js';
import {env} from '../../config/env.js';

const scopes=['https://www.googleapis.com/auth/youtube.upload','https://www.googleapis.com/auth/youtube.readonly'];
let tokens=null;
const states=new Map();

function configured(){return Boolean(env.youtubeClientId&&env.youtubeClientSecret&&env.youtubeRedirectUri);}
function oauth(){
  if(!configured()) throw new Error('YouTube publishing is not configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REDIRECT_URI.');
  return new google.auth.OAuth2(env.youtubeClientId,env.youtubeClientSecret,env.youtubeRedirectUri);
}
export function youtubeStatus(){return {configured:configured(),connected:Boolean(tokens),publishEnabled:env.youtubePublishEnabled,redirectUri:env.youtubeRedirectUri||null};}
export function getAuthUrl(){const client=oauth();const state=randomBytes(24).toString('hex');states.set(state,Date.now()+10*60*1000);return client.generateAuthUrl({access_type:'offline',prompt:'consent',scope:scopes,state});}
export async function handleCallback(code,state){
  const expires=states.get(state); states.delete(state);
  if(!expires||expires<Date.now()) throw new Error('YouTube OAuth state expired or is invalid.');
  const client=oauth(); const {tokens:newTokens}=await client.getToken(code); tokens=newTokens; client.setCredentials(tokens);
  const yt=google.youtube({version:'v3',auth:client});
  const r=await yt.channels.list({part:'snippet,statistics',mine:true});
  const ch=r.data.items?.[0];
  return {channelId:ch?.id||null,channelTitle:ch?.snippet?.title||null,subscriberCount:ch?.statistics?.subscriberCount||null};
}
async function client(){if(!tokens) throw new Error('Connect a YouTube channel first.');const c=oauth();c.setCredentials(tokens);c.on('tokens',t=>{tokens={...tokens,...t};});return c;}
function metadata(story,video,opts={}){
  const seo=story?.youtubeOptimization?.seo||{};
  const desc=seo.description||seo.videoDescription||`${story?.topic||story?.title||'New video'}\n\nCreated with Kids Agent.`;
  const tags=Array.isArray(seo.tags)?seo.tags.map(String).slice(0,30):[];
  return {title:String(opts.title||story?.title||video.title||'Untitled YouTube Video').slice(0,100),description:String(opts.description||desc).slice(0,5000),tags,categoryId:String(opts.categoryId||'27'),selfDeclaredMadeForKids:opts.madeForKids!==false};
}
export async function uploadVideo(videoId,opts={}){
  if(!env.youtubePublishEnabled) throw new Error('YouTube publishing is disabled. Set YOUTUBE_PUBLISH_ENABLED=true.');
  const video=await Video.findById(videoId).populate('storyId'); if(!video) throw new Error('Video not found.');
  if(!['APPROVED','UPLOADING'].includes(video.status)) throw new Error(`Video must be APPROVED before upload. Current status: ${video.status}`);
  if(!video.renderPath) throw new Error('Rendered video file is missing.');
  const story=video.storyId; const meta=metadata(story,video,opts); const c=await client(); const yt=google.youtube({version:'v3',auth:c});
  await Video.findByIdAndUpdate(videoId,{$set:{status:'UPLOADING',youtubeMetadata:meta},$push:{statusHistory:{status:'UPLOADING',message:'Uploading to YouTube.',at:new Date(),attempt:0,source:'YOUTUBE'}}});
  const privacy=opts.publishAt?'private':(opts.privacyStatus||'private');
  const body={snippet:{title:meta.title,description:meta.description,tags:meta.tags,categoryId:meta.categoryId},status:{privacyStatus:privacy,selfDeclaredMadeForKids:meta.selfDeclaredMadeForKids}};
  if(opts.publishAt){const d=new Date(opts.publishAt);if(Number.isNaN(d.getTime())) throw new Error('Invalid publishAt date.');body.status.publishAt=d.toISOString();}
  const result=await yt.videos.insert({part:['snippet','status'],requestBody:body,media:{body:fs.createReadStream(path.resolve(video.renderPath))}});
  const id=result.data.id; const finalStatus=opts.publishAt?'SCHEDULED':(privacy==='public'?'PUBLISHED':'UPLOADING');
  await Video.findByIdAndUpdate(videoId,{$set:{youtubeVideoId:id,status:finalStatus,scheduledAt:opts.publishAt?new Date(opts.publishAt):null},$push:{statusHistory:{status:finalStatus,message:`YouTube upload complete: ${id}`,at:new Date(),attempt:0,source:'YOUTUBE'}}});
  return {youtubeVideoId:id,status:finalStatus,url:`https://www.youtube.com/watch?v=${id}`,metadata:meta};
}
