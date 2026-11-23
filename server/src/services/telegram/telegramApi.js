// Minimal Telegram Bot API client (fetch only). Docs: https://core.telegram.org/bots/api
import fs from 'node:fs/promises';
import path from 'node:path';
const BASE='https://api.telegram.org';
export const MAX_VIDEO_BYTES=49*1024*1024; // bots may send files up to 50 MB
export class TelegramError extends Error{constructor(message,code){super(message);this.code=code;}}
export const validToken=t=>/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(String(t||'').trim());

async function call(token,method,body,fetchImpl=fetch,signal){
  if(!validToken(token))throw new TelegramError('The Telegram bot token is missing or invalid.',401);
  const init=body instanceof FormData?{method:'POST',body,signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{}),signal};
  let r;try{r=await fetchImpl(`${BASE}/bot${token}/${method}`,init);}catch(e){throw new TelegramError(`Cannot reach Telegram: ${e.message}`,0);}
  let j={};try{j=await r.json();}catch{}
  // Never include the token (part of the URL) in errors.
  if(!r.ok||!j.ok)throw new TelegramError(`Telegram ${method} failed: ${j.description||`HTTP ${r.status}`}`,j.error_code||r.status);
  return j.result;
}
export const getMe=(token,f)=>call(token,'getMe',{},f);
export const getUpdates=(token,f)=>call(token,'getUpdates',{limit:100,timeout:0,allowed_updates:['message','channel_post','my_chat_member']},f);
export const sendMessage=(token,chatId,text,f,extra={})=>call(token,'sendMessage',{chat_id:chatId,text:String(text).slice(0,4096),parse_mode:'HTML',link_preview_options:{is_disabled:true},...extra},f);
// Long poll for the command bot.
export const pollUpdates=(token,offset,timeoutSec=25,f,signal)=>call(token,'getUpdates',{offset,timeout:timeoutSec,allowed_updates:['message','callback_query','my_chat_member']},f,signal);
export const answerCallback=(token,id,text,f)=>call(token,'answerCallbackQuery',{callback_query_id:id,text:String(text||'').slice(0,200)},f);
export const editMessage=(token,chatId,messageId,text,f,extra={})=>call(token,'editMessageText',{chat_id:chatId,message_id:messageId,text:String(text).slice(0,4096),parse_mode:'HTML',link_preview_options:{is_disabled:true},...extra},f);
export const setCommands=(token,commands,f)=>call(token,'setMyCommands',{commands},f);
export async function sendVideo(token,chatId,filePath,caption,f,extra={}){
  const bytes=await fs.readFile(filePath);
  if(bytes.length>MAX_VIDEO_BYTES)throw new TelegramError('Video is larger than Telegram\'s 50 MB bot limit.',413);
  const form=new FormData();
  form.append('chat_id',String(chatId));
  form.append('caption',String(caption||'').slice(0,1024));
  form.append('parse_mode','HTML');
  form.append('supports_streaming','true');
  form.append('video',new Blob([bytes],{type:'video/mp4'}),path.basename(filePath));
  if(extra.reply_markup)form.append('reply_markup',JSON.stringify(extra.reply_markup));
  return call(token,'sendVideo',form,f);
}
export async function sendPhoto(token,chatId,filePath,caption,f,extra={}){
  const bytes=await fs.readFile(filePath);
  if(bytes.length>10*1024*1024)throw new TelegramError('Image is larger than Telegram\'s 10 MB photo limit.',413);
  const form=new FormData();
  form.append('chat_id',String(chatId));
  form.append('caption',String(caption||'').slice(0,1024));
  form.append('parse_mode','HTML');
  form.append('photo',new Blob([bytes],{type:/\.jpe?g$/i.test(filePath)?'image/jpeg':'image/png'}),path.basename(filePath));
  if(extra.reply_markup)form.append('reply_markup',JSON.stringify(extra.reply_markup));
  return call(token,'sendPhoto',form,f);
}
export async function sendAudio(token,chatId,filePath,caption,f,extra={}){
  const bytes=await fs.readFile(filePath);
  if(bytes.length>MAX_VIDEO_BYTES)throw new TelegramError('Audio is larger than Telegram\'s 50 MB bot limit.',413);
  const form=new FormData();
  form.append('chat_id',String(chatId));
  form.append('caption',String(caption||'').slice(0,1024));
  form.append('parse_mode','HTML');
  form.append('audio',new Blob([bytes],{type:'audio/mpeg'}),path.basename(filePath));
  if(extra.title)form.append('title',String(extra.title).slice(0,64));
  if(extra.reply_markup)form.append('reply_markup',JSON.stringify(extra.reply_markup));
  return call(token,'sendAudio',form,f);
}
// Any file up to 50 MB, shown with a preview. Used when an image is too large for sendPhoto.
export async function sendDocument(token,chatId,filePath,caption,f,extra={}){
  const bytes=await fs.readFile(filePath);
  if(bytes.length>MAX_VIDEO_BYTES)throw new TelegramError('File is larger than Telegram\'s 50 MB bot limit.',413);
  const form=new FormData();
  form.append('chat_id',String(chatId));
  form.append('caption',String(caption||'').slice(0,1024));
  form.append('parse_mode','HTML');
  form.append('document',new Blob([bytes],{type:/\.jpe?g$/i.test(filePath)?'image/jpeg':'image/png'}),path.basename(filePath));
  if(extra.reply_markup)form.append('reply_markup',JSON.stringify(extra.reply_markup));
  return call(token,'sendDocument',form,f);
}
// Sends a scene image so it is always visible: as a photo, else as a file.
export async function sendImage(token,chatId,filePath,caption,f,extra={}){
  try{return await sendPhoto(token,chatId,filePath,caption,f,extra);}
  catch(e){if(/ENOENT/.test(e.message))throw e;return sendDocument(token,chatId,filePath,caption,f,extra);}
}
// Album of up to 10 images (each ≤10 MB), e.g. all rebuilt scenes for review.
export async function sendMediaGroup(token,chatId,items,f){
  const form=new FormData();
  form.append('chat_id',String(chatId));
  const media=[];
  for(const [i,item] of items.slice(0,10).entries()){
    const bytes=await fs.readFile(item.path);
    if(bytes.length>10*1024*1024)throw new TelegramError(`Image ${i+1} is larger than 10 MB.`,413);
    form.append(`p${i}`,new Blob([bytes],{type:'image/png'}),path.basename(item.path));
    media.push({type:'photo',media:`attach://p${i}`,caption:String(item.caption||'').slice(0,1024),parse_mode:'HTML'});
  }
  form.append('media',JSON.stringify(media));
  return call(token,'sendMediaGroup',form,f);
}
// Chats that have messaged the bot (or added it), for the "Find my chat" button.
export function chatsFromUpdates(updates=[]){
  const seen=new Map();
  for(const u of updates){
    const chat=u.message?.chat||u.channel_post?.chat||u.my_chat_member?.chat;
    if(!chat?.id)continue;
    const title=chat.title||[chat.first_name,chat.last_name].filter(Boolean).join(' ')||(chat.username?`@${chat.username}`:String(chat.id));
    seen.set(String(chat.id),{chatId:String(chat.id),title,type:chat.type||'private'});
  }
  return [...seen.values()];
}
