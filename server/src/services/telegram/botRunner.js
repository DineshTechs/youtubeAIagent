// Runs the Telegram command bots: one long-poll loop per distinct bot token among
// profiles with "Allow commands" on. Re-reads profiles every 30 s, so changes in
// the dashboard apply without a restart. Runs only in the instance that owns the
// API port (started from app.js after 'listening').
import Series from '../../models/Series.js';
import {env} from '../../config/env.js';
import {decryptSecret} from '../secretBox.js';
import {pollUpdates,sendMessage,editMessage,answerCallback,sendVideo,sendImage,sendAudio,setCommands} from './telegramApi.js';
import {createBot,COMMANDS} from './botCommands.js';
import {chatsFromUpdates} from './telegramApi.js';
import http from 'node:http';
import {INTERNAL_TOKEN} from '../../security/httpSecurity.js';

const bots=new Map(); // token -> {profiles, controller, stop, seen:Map}
const seenChatsByToken=new Map();
let refreshTimer=null;

// The bot calls this app's own API. On a host like Passenger the app may listen on a
// socket instead of a port, so the request goes to wherever the server really listens,
// with a per-process token instead of a login.
let internalServer=null;
export function setInternalServer(server){internalServer=server;}
export function internalApi(method,path,body){
  const addr=internalServer?.address?.();
  const payload=body?JSON.stringify(body):null;
  const target=typeof addr==='string'?{socketPath:addr}:{host:'127.0.0.1',port:addr?.port||env.port};
  return new Promise((resolve,reject)=>{
    const req=http.request({...target,method,path:`/api${path}`,headers:{'x-internal-token':INTERNAL_TOKEN,...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);
      res.on('end',()=>{let j={};try{j=text?JSON.parse(text):{};}catch{j={error:text};}
        if(res.statusCode>=400)reject(new Error(j.error||`Request failed (${res.statusCode})`));else resolve(j);});
    });
    req.on('error',reject);req.setTimeout(120000,()=>req.destroy(new Error('Internal request timed out')));
    if(payload)req.write(payload);req.end();
  });
}

// Chats seen by a running bot (used by "Find my chats", since getUpdates can't run twice).
export function seenChats(token){return [...(seenChatsByToken.get(token)?.values()||[])];}
export function isPolling(token){return bots.has(token);}

async function commandProfiles(){
  const list=await Series.find({archived:{$ne:true},'telegram.commandsEnabled':true}).select('name telegram uploadSettings').lean();
  const byToken=new Map();
  for(const s of list){
    const token=decryptSecret(s.telegram?.botToken);if(!token)continue;
    const entry=byToken.get(token)||[];
    entry.push({id:String(s._id),name:s.name,chats:(s.telegram.chats||[]).map(c=>String(c.chatId)),scheduleTime:s.uploadSettings?.scheduleTime||''});
    byToken.set(token,entry);
  }
  return byToken;
}

function startBot(token,profiles){
  const state={profiles,stopped:false,controller:null};
  const tg={
    send:(chatId,text,markup)=>sendMessage(token,chatId,text,undefined,markup?{reply_markup:markup}:{}),
    edit:(chatId,messageId,text,markup)=>messageId?editMessage(token,chatId,messageId,text,undefined,markup?{reply_markup:markup}:{}).catch(e=>/not modified/i.test(e.message)?null:sendMessage(token,chatId,text,undefined,markup?{reply_markup:markup}:{})):sendMessage(token,chatId,text,undefined,markup?{reply_markup:markup}:{}),
    answer:(id,text)=>answerCallback(token,id,text).catch(()=>null),
    sendVideo:(chatId,file,caption,markup)=>sendVideo(token,chatId,file,caption,undefined,markup?{reply_markup:markup}:{}),
    sendPhoto:(chatId,file,caption,markup)=>sendImage(token,chatId,file,caption,undefined,markup?{reply_markup:markup}:{}),
    sendAudio:(chatId,file,caption,title)=>sendAudio(token,chatId,file,caption,undefined,{title})
  };
  const scope=chatId=>state.profiles.filter(p=>p.chats.includes(String(chatId))).map(({id,name,scheduleTime})=>({id,name,scheduleTime}));
  const bot=createBot({tg,api:internalApi,scope});
  const startedAt=Date.now();
  if(!seenChatsByToken.has(token))seenChatsByToken.set(token,new Map());
  setCommands(token,COMMANDS).catch(()=>{});
  (async()=>{
    let offset=0,failures=0;
    while(!state.stopped){
      try{
        state.controller=new AbortController();
        const updates=await pollUpdates(token,offset,25,undefined,state.controller.signal);
        failures=0;
        for(const u of updates){
          offset=u.update_id+1;
          for(const c of chatsFromUpdates([u]))seenChatsByToken.get(token).set(c.chatId,c);
          // Ignore commands sent while the app was off (no replay of old actions).
          const date=(u.message?.date||u.callback_query?.message?.date||0)*1000;
          if(u.message&&date&&date<startedAt-60000)continue;
          await bot.handleUpdate(u);
        }
      }catch(e){
        if(state.stopped)break;
        failures++;
        if(failures===1||failures%20===0)console.error(`Telegram bot polling error: ${e.message}`);
        await new Promise(r=>setTimeout(r,Math.min(60000,2000*failures)));
      }
    }
  })();
  return {state,stop(){state.stopped=true;state.controller?.abort();}};
}

export async function refreshBots(){
  let byToken;
  try{byToken=await commandProfiles();}catch(e){console.error('Telegram bot refresh failed:',e.message);return;}
  for(const [token,bot] of bots){if(!byToken.has(token)){bot.stop();bots.delete(token);}}
  for(const [token,profiles] of byToken){
    const running=bots.get(token);
    if(running)running.state.profiles=profiles;
    else bots.set(token,startBot(token,profiles));
  }
}
export function startTelegramBots(){
  if(refreshTimer)return;
  refreshBots();
  refreshTimer=setInterval(refreshBots,30000);
  refreshTimer.unref?.();
}
