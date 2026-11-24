// Telegram notifications for video events, configured PER CHANNEL PROFILE
// (Series.telegram: own bot token, chats and event switches). notify() is
// fire-and-forget: it never throws and never delays the pipeline; failures are
// recorded on the profile as telegram.lastError.
import path from 'node:path';
import fs from 'node:fs/promises';
import Video from '../../models/Video.js';
import Story from '../../models/Story.js';
import Series from '../../models/Series.js';
import {encryptSecret,decryptSecret} from '../secretBox.js';
import {resolveVideoProfiles} from '../videoProfiles.js';
import {EVENTS,eventSettings,esc,formatMessage,shouldSend,publicSettings} from './telegramFormat.js';
import {sendMessage,sendVideo,sendImage,sendAudio,sendMediaGroup,getMe,getUpdates,chatsFromUpdates,validToken,MAX_VIDEO_BYTES} from './telegramApi.js';
import {seenChats,isPolling,refreshBots} from './botRunner.js';

export {EVENTS,eventSettings,esc,formatMessage,shouldSend,publicSettings};
const EVENT_IDS=new Set(EVENTS.map(e=>e.id));
const httpError=(message,status=400)=>Object.assign(new Error(message),{status});

const cache=new Map(); // seriesId -> {at, series}
async function loadSeries(seriesId,{fresh=false}={}){
  const key=String(seriesId);const hit=cache.get(key);
  if(!fresh&&hit&&Date.now()-hit.at<10000)return hit.series;
  const series=await Series.findById(seriesId).select('name archived telegram').lean();
  cache.set(key,{at:Date.now(),series});
  return series;
}
async function requireSeries(seriesId){
  const s=/^[a-f0-9]{24}$/i.test(String(seriesId))?await loadSeries(seriesId,{fresh:true}):null;
  if(!s||s.archived)throw httpError('Channel profile not found.',404);
  return s;
}
async function patch(seriesId,set){
  await Series.updateOne({_id:seriesId},{$set:Object.fromEntries(Object.entries(set).map(([k,v])=>[`telegram.${k}`,v]))});
  cache.delete(String(seriesId));
}
const tokenOf=t=>decryptSecret(t?.botToken)||'';

export async function getSettings(seriesId){const s=await requireSeries(seriesId);return {seriesId:String(s._id),profileName:s.name,...publicSettings(s.telegram)};}
export async function updateSettings(seriesId,input={}){
  const s=await requireSeries(seriesId);
  const set={};
  if(typeof input.botToken==='string'&&input.botToken.trim()){
    const t=input.botToken.trim();
    if(!validToken(t))throw httpError('That does not look like a bot token (format 123456789:ABC…). Get one from @BotFather.');
    const me=await getMe(t).catch(e=>{throw httpError(e.message);});
    set.botToken=encryptSecret(t);set.botUsername=me.username||'';
  }
  if(input.clearToken===true){set.botToken=null;set.botUsername='';set.enabled=false;}
  if(typeof input.enabled==='boolean')set.enabled=input.enabled;
  if(typeof input.sendVideoOnReady==='boolean')set.sendVideoOnReady=input.sendVideoOnReady;
  if(typeof input.commandsEnabled==='boolean')set.commandsEnabled=input.commandsEnabled;
  if(input.events&&typeof input.events==='object')set.events=Object.fromEntries(Object.entries(input.events).filter(([k,v])=>EVENT_IDS.has(k)&&typeof v==='boolean'));
  if(Array.isArray(input.chats))set.chats=input.chats.map(c=>({chatId:String(c?.chatId??'').trim(),title:String(c?.title||'').slice(0,120),type:String(c?.type||'')})).filter(c=>/^-?\d{3,20}$/.test(c.chatId)).slice(0,20);
  set.lastError='';
  await patch(s._id,set);
  refreshBots().catch(()=>{});
  return getSettings(s._id);
}
// Re-use another profile's bot (token stays server-side) and its chats.
export async function copyFrom(seriesId,sourceId){
  const target=await requireSeries(seriesId);const source=await requireSeries(sourceId);
  if(!tokenOf(source.telegram))throw httpError(`"${source.name}" has no saved Telegram bot.`);
  await patch(target._id,{botToken:source.telegram.botToken,botUsername:source.telegram.botUsername||'',chats:source.telegram.chats||[],lastError:''});
  refreshBots().catch(()=>{});
  return getSettings(target._id);
}
// While the command bot is polling, Telegram refuses a second getUpdates, so use the chats it has seen.
export async function detectChats(seriesId){const s=await requireSeries(seriesId);const t=tokenOf(s.telegram);if(!t)throw httpError('Save the bot token first.');return isPolling(t)?seenChats(t):chatsFromUpdates(await getUpdates(t));}
export async function sendTest(seriesId){
  const s=await requireSeries(seriesId);const t=tokenOf(s.telegram);
  if(!t)throw httpError('Save the bot token first.');
  if(!s.telegram?.chats?.length)throw httpError('Add at least one chat first.');
  const results=[];
  for(const c of s.telegram.chats){try{await sendMessage(t,c.chatId,`🔔 <b>YouTube AI Agent</b>\nTest message for profile <b>${esc(s.name)}</b> — notifications are working.`);results.push({chatId:c.chatId,ok:true});}catch(e){results.push({chatId:c.chatId,ok:false,error:e.message});}}
  await patch(s._id,{lastError:results.filter(r=>!r.ok).map(r=>`${r.chatId}: ${r.error}`).join('; '),lastSentAt:new Date()});
  return results;
}

async function videoContext(videoId){
  const v=await Video.findById(videoId).lean();if(!v)return null;
  const [withProfile]=await resolveVideoProfiles([v],{Story,Series});
  return {videoId:String(v._id),title:v.title,profileId:withProfile.profile?.id||null,profileName:withProfile.profile?.name||null,durationSec:v.durationSec,qaScore:v.qa?.score??null,renderPath:v.renderPath};
}

// A scene changed from Telegram has been rebuilt: show it to the chat that asked,
// with a button to render. Sent whenever commands are on (not an optional event).
async function deliverSceneReady(videoId){
  const v=await Video.findById(videoId).lean();if(!v?.pendingSceneEdit)return;
  const [withProfile]=await resolveVideoProfiles([v],{Story,Series});
  const profileId=withProfile.profile?.id;if(!profileId)return;
  const series=await loadSeries(profileId,{fresh:true});const tg=series?.telegram;const t=tokenOf(tg);
  if(!t||!tg?.commandsEnabled)return;
  const n=Number(v.pendingSceneEdit.sceneNumber);
  const chats=(tg.chats||[]).map(c=>String(c.chatId));
  const target=v.pendingSceneEdit.chatId&&chats.includes(String(v.pendingSceneEdit.chatId))?[String(v.pendingSceneEdit.chatId)]:chats;
  const story=v.storyId?await Story.findById(v.storyId).select('scenes').lean():null;
  const scene=(story?.scenes||[]).find((s,i)=>Number(s.sceneNumber||i+1)===n);
  const asset=(v.mediaAssetDetails||[]).find(a=>Number(a.sceneNumber)===n);
  const pending=v.pendingSceneEdit;
  if(pending.allScenes)return deliverAllScenesReady(v,profileId,t,tg);
  const changed=[pending.imageChanged&&'new image',pending.narrationChanged&&'new narration'].filter(Boolean).join(' + ')||'rebuilt';
  const audio=path.resolve('storage','videos',String(v._id),'scene-narration',`scene-${String(n).padStart(3,'0')}.mp3`);
  const caption=[`🎞 <b>Scene ${n} — ${changed}</b> · ${esc(v.title||'')}`,scene?.narration?`🗣 ${esc(String(scene.narration).slice(0,500))}`:'','Render the video with this scene?'].filter(Boolean).join('\n');
  const markup={inline_keyboard:[[{text:'✅ Render video',callback_data:`r:${v._id}`}],[{text:'🎞 Change this scene again',callback_data:`e:${v._id}:${n}`}],[{text:'🔊 Hear narration',callback_data:`h:${v._id}:${n}`}]]};
  const errors=[];
  for(const chatId of target){
    try{
      // New narration: send the spoken scene first so it can be heard before rendering.
      if(pending.narrationChanged){try{await sendAudio(t,chatId,audio,`🔊 New narration — scene ${n}`,undefined,{title:`Scene ${n}`});}catch(e){errors.push(`audio: ${e.message}`);}}
      if(asset?.path){try{await sendImage(t,chatId,path.resolve(asset.path),caption,undefined,{reply_markup:markup});continue;}catch(e){errors.push(`image: ${e.message}`);}}
      await sendMessage(t,chatId,`${caption}\n⚠ The new image could not be attached (${esc(errors.at(-1)||'not found')}). Check it in the dashboard before rendering.`,undefined,{reply_markup:markup});
    }catch(e){errors.push(`${chatId}: ${e.message}`);}
  }
  await patch(profileId,{lastError:errors.join('; ').slice(0,500),lastSentAt:new Date()});
}

// All scene images were rebuilt: send them as an album, then the Render button.
async function deliverAllScenesReady(v,profileId,t,tg){
  const chats=(tg.chats||[]).map(c=>String(c.chatId));
  const target=v.pendingSceneEdit.chatId&&chats.includes(String(v.pendingSceneEdit.chatId))?[String(v.pendingSceneEdit.chatId)]:chats;
  const story=v.storyId?await Story.findById(v.storyId).select('scenes').lean():null;
  const items=(v.mediaAssetDetails||[]).slice().sort((a,b)=>a.sceneNumber-b.sceneNumber).map(a=>{const sc=(story?.scenes||[]).find((s,i)=>Number(s.sceneNumber||i+1)===Number(a.sceneNumber));return {path:path.resolve(a.path),caption:`<b>Scene ${a.sceneNumber}</b> — ${esc(String(sc?.narration||'').slice(0,300))}`};});
  const markup={inline_keyboard:[[{text:'✅ Render video',callback_data:`r:${v._id}`}],[{text:'🎞 Change a scene',callback_data:`o:${v._id}`}]]};
  const errors=[];
  for(const chatId of target){
    for(let i=0;i<items.length;i+=10){
      try{await sendMediaGroup(t,chatId,items.slice(i,i+10));}
      catch(e){errors.push(`album: ${e.message}`);for(const it of items.slice(i,i+10)){try{await sendImage(t,chatId,it.path,it.caption);}catch(e2){errors.push(e2.message);}}}
    }
    try{await sendMessage(t,chatId,`🖼 <b>All ${items.length} images rebuilt</b> to match the narration — ${esc(v.title||'')}.\nCheck them above. Render the video with these images?`,undefined,{reply_markup:markup});}catch(e){errors.push(`${chatId}: ${e.message}`);}
  }
  await patch(profileId,{lastError:errors.join('; ').slice(0,500),lastSentAt:new Date()});
}

let chain=Promise.resolve();
async function deliver(event,payload){
  if(event==='sceneReady')return deliverSceneReady(payload.videoId);
  let c={...payload};
  if(payload.videoId&&(!payload.title||!payload.profileId)){const ctx=await videoContext(payload.videoId);if(ctx)c={...ctx,...Object.fromEntries(Object.entries(payload).filter(([,v])=>v!=null))};}
  if(!c.profileId)return; // videos without a profile have no Telegram settings
  const series=await loadSeries(c.profileId);
  const tg=series?.telegram;
  if(!shouldSend(tg,event))return;
  const t=tokenOf(tg);if(!t)return;
  c.profileName=c.profileName||series.name;
  const text=formatMessage(event,c);
  const errors=[];
  let attach=null;
  if(event==='ready'&&tg.sendVideoOnReady!==false&&c.renderPath){try{const st=await fs.stat(path.resolve(c.renderPath));if(st.size<=MAX_VIDEO_BYTES)attach=path.resolve(c.renderPath);}catch{}}
  // With bot commands on, "ready" comes with buttons to approve or open the video.
  const buttons=event==='ready'&&tg.commandsEnabled&&c.videoId?{reply_markup:{inline_keyboard:[[{text:'✅ Approve',callback_data:`p:${c.videoId}`},{text:'🎞 Scenes / options',callback_data:`o:${c.videoId}`}]]}}
    :tg.commandsEnabled&&Array.isArray(payload.buttons)&&payload.buttons.length?{reply_markup:{inline_keyboard:payload.buttons}}:{};
  for(const chat of tg.chats){
    try{
      if(attach){try{await sendVideo(t,chat.chatId,attach,text,undefined,buttons);continue;}catch(e){errors.push(`video to ${chat.chatId}: ${e.message}`);}}
      await sendMessage(t,chat.chatId,text,undefined,buttons);
    }catch(e){errors.push(`${chat.chatId}: ${e.message}`);}
  }
  await patch(c.profileId,{lastError:errors.join('; ').slice(0,500),lastSentAt:new Date()});
}
// Public entry point. Never throws; sends in order, one at a time.
export function notify(event,payload={}){
  chain=chain.then(()=>deliver(event,payload)).catch(e=>console.error('Telegram notification failed:',e.message));
  return chain;
}
