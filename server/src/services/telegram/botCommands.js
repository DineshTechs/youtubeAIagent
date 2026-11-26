// Telegram command bot: create / list / approve / delete / upload videos.
// Pure logic with injected dependencies (see botRunner.js for the real ones):
//   tg:    {send(chatId,text,markup), edit(chatId,messageId,text,markup), answer(callbackId,text), sendVideo(chatId,path,caption,markup), sendPhoto(chatId,path,caption,markup)}
//   api:   (method,path,body) => JSON from this app's own REST API (same rules as the dashboard)
//   scope: (chatId) => [{id,name,scheduleTime}] profiles on this bot that allow commands from this chat
import {randomBytes} from 'node:crypto';
import {parseWhen,formatWhen} from '../autopilot/publishSlots.js';
import {esc} from './telegramFormat.js';

const STATUS={QUEUED:'Queued',PLANNED:'Planned',SCRIPT_GENERATED:'Script ready',SCRIPT_QA:'Script QA',ASSETS_GENERATING:'Making images',VIDEO_RENDERING:'Rendering',VIDEO_QA:'Video QA',SCENE_REVIEW:'🎞 Scene review',AWAITING_APPROVAL:'⏳ Awaiting approval',APPROVED:'✅ Approved',UPLOADING:'Uploading',SCHEDULED:'🗓 Scheduled',PUBLISHED:'📺 Published',FAILED:'❌ Failed',CANCELLED:'⏹ Cancelled'};
// The video file is not on the computer that answered (e.g. made on the Windows PC,
// but the server's copy of the bot got the button press because both share one database).
export function missingFileMessage(file,platform=process.platform){
  const windowsPath=/^[A-Za-z]:[\\/]/.test(String(file||''));
  const otherComputer=windowsPath!==(platform==='win32');
  return otherComputer
    ? `This video was made on your ${windowsPath?'Windows PC':'server'}, so its file is not on the ${platform==='win32'?'PC':'server'} that answered. Open it on the computer that made it, or re-render the video in this computer’s dashboard.\n\nTip: when the PC app and the server share one database and one Telegram bot, either of them may answer. Run only one of them at a time, or give them separate databases.`
    : 'The video file is missing on this computer (it may have been cleaned up). Re-render the video in the dashboard to make it again.';
}
const ACTIVE=new Set(['QUEUED','RUNNING']);
const SKIPPABLE=new Set(['SCENE_REVIEW','AWAITING_APPROVAL','APPROVED']);
const CONFIRM={skip:true,approve:true,delete:true,upload:true,schedule:true,regen:true,rebuild:true};
const EDITABLE=new Set(['AWAITING_APPROVAL','APPROVED','FAILED','CANCELLED','SCENE_REVIEW']);
const INPUT_TTL=15*60*1000;
const NONCE_TTL=10*60*1000;
export const HELP=`<b>YouTube AI Agent bot</b>
/new <i>topic</i> — create a video (topic optional)
/trending — topic ideas from today's trends
/recent — latest videos
/pending — videos awaiting approval
/status — videos being made right now
/profiles — profiles this chat controls
/cancel — stop typing a scene change
Tap a video to send it, approve, upload, schedule, continue, cancel or delete it — or open 🎞 Scenes to change one scene's image or narration and re-render.`;
export const COMMANDS=[{command:'new',description:'Create a video (optional topic)'},{command:'trending',description:'Topic ideas from current trends'},{command:'recent',description:'Latest videos'},{command:'pending',description:'Videos awaiting approval'},{command:'status',description:'Videos being made now'},{command:'profiles',description:'Profiles this chat controls'},{command:'cancel',description:'Stop a scene change'},{command:'help',description:'How to use this bot'}];

const short=(s,n)=>{s=String(s||'Untitled video');return s.length>n?`${s.slice(0,n-1)}…`:s;};
const ago=(d,now)=>{const s=Math.max(0,(now-new Date(d).getTime())/1000);return s<3600?`${Math.max(1,Math.round(s/60))} min ago`:s<86400?`${Math.round(s/3600)} h ago`:`${Math.round(s/86400)} d ago`;};
export function parseCommand(text=''){
  const m=/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(String(text).trim());
  return m?{cmd:m[1].toLowerCase(),args:(m[2]||'').trim()}:null;
}

export function createBot({tg,api,scope,now=()=>Date.now()}){
  const nonces=new Map();
  const awaiting=new Map(); // chatId -> {kind:'image'|'narration', videoId, sceneNumber, expires}
  function nonce(data){for(const [k,v] of nonces)if(v.expires<now())nonces.delete(k);const k=randomBytes(8).toString('hex');nonces.set(k,{...data,expires:now()+NONCE_TTL});return k;}
  function take(k){const v=nonces.get(k);nonces.delete(k);return v&&v.expires>=now()?v:null;}

  async function videosFor(profiles,{status,limit=8}={}){
    const lists=await Promise.all(profiles.map(p=>api('GET',`/videos?seriesId=${p.id}&limit=${limit}${status?`&status=${status}`:''}`)));
    return lists.flat().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,limit);
  }
  function listMarkup(videos){return {inline_keyboard:videos.map(v=>[{text:`${short(v.title,34)} · ${(STATUS[v.status]||v.status).replace(/^\S+ /,'')}`,callback_data:`o:${v._id}`}])};}
  function cardText(v){
    const lines=[`<b>${esc(v.title||'Untitled video')}</b>`,[v.profile?.name&&esc(v.profile.name),STATUS[v.status]||v.status,v.durationSec&&`${Math.round(v.durationSec)} s`,v.qa?.score!=null&&`QA ${v.qa.score}/100`,v.createdAt&&ago(v.createdAt,now())].filter(Boolean).join(' · ')];
    const j=v.latestJob;if(j&&ACTIVE.has(j.status))lines.push(`Progress: ${j.progress||0}% · ${esc(String(j.step||j.status).replace(/_/g,' ').toLowerCase())}`);
    if(v.youtubeVideoId)lines.push(`https://youtu.be/${v.youtubeVideoId}`);
    if(v.scheduledAt&&v.status==='SCHEDULED')lines.push(`Goes public: ${new Date(v.scheduledAt).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'})}`);
    if(v.error)lines.push(`<i>${esc(short(v.error,300))}</i>`);
    return lines.join('\n');
  }
  function cardMarkup(v,profile){
    const id=String(v._id),b=(text,action)=>({text,callback_data:`a:${nonce({action,videoId:id})}`});
    const rows=[];const active=v.latestJob&&ACTIVE.has(v.latestJob.status);
    if(v.renderPath)rows.push([b('▶ Send video','send')]);
    if(v.status==='SCENE_REVIEW'){const n=v.pendingSceneEdit?.sceneNumber;rows.push([{text:'✅ Render video',callback_data:`r:${id}`},...(n?[{text:`👁 See new scene ${n}`,callback_data:`e:${id}:${n}`}]:[])]);}
    if(v.status==='AWAITING_APPROVAL')rows.push([b('✅ Approve','approve')]);
    if(SKIPPABLE.has(v.status))rows.push([v.skippedAt?b('↩ Undo skip','unskip'):b('⏭ Skip (don’t wait for it)','skip')]);
    if(v.status==='APPROVED')rows.push([b('🗓 Next free slot','booknext'),b('🕒 Pick a time','picktime')],[b('📺 Upload now','upload')]);
    else if(v.status==='UPLOADING')rows.push([b('📺 Upload now','upload')]);
    if(['FAILED','CANCELLED'].includes(v.status)&&!active)rows.push([b('🔁 Continue','retry')]);
    if(EDITABLE.has(v.status)&&!active&&(v.storyId?.scenes?.length||v.sceneCount))rows.push([b('🎞 Scenes','scenes'),b('🖼 Rebuild all images','rebuild')]);
    if(active)rows.push([b('⏹ Cancel','cancel')]);
    rows.push([b('🔄 Refresh','open'),...(active?[]:[b('🗑 Delete','delete')])]);
    return {inline_keyboard:rows};
  }
  async function loadVideo(chatId,videoId){
    const profiles=scope(chatId);
    const v=await api('GET',`/videos/${videoId}`);
    const profile=profiles.find(p=>p.id===String(v.profile?.id||''));
    if(!profile)throw new Error('This video does not belong to a profile this chat controls.');
    return {v,profile};
  }
  async function showCard(chatId,videoId,messageId){
    const {v,profile}=await loadVideo(chatId,videoId);
    if(messageId)return tg.edit(chatId,messageId,cardText(v),cardMarkup(v,profile));
    return tg.send(chatId,cardText(v),cardMarkup(v,profile));
  }
  async function sendTrending(chatId,profile){
    await tg.send(chatId,`🔎 Checking today's trends for <b>${esc(profile.name)}</b>…`);
    const r=await api('GET',`/trends/${profile.id}?count=6`);
    if(!r.ideas?.length)return tg.send(chatId,'No trending topic fits this channel right now. Use /new to let the AI pick an evergreen topic.');
    const lines=r.ideas.map((t,i)=>`<b>${i+1}. ${esc(t.topic)}</b>\n${t.trend&&t.trend!=='evergreen'?`📈 ${esc(t.trend)} · `:'🌿 evergreen · '}${esc(short(t.angle||t.reason,160))}`);
    const buttons=r.ideas.map((t,i)=>[{text:`🎬 Create #${i+1}`,callback_data:`n:${nonce({profileId:profile.id,topic:t.topic})}`}]);
    return tg.send(chatId,`<b>Trending ideas for ${esc(profile.name)}</b> (${esc(r.region)})\n\n${lines.join('\n\n')}`,{inline_keyboard:buttons});
  }
  async function createVideo(chatId,profile,topic){
    const j=await api('POST','/agent/generate',{seriesId:profile.id,topic:topic||null});
    return tg.send(chatId,`🎬 Creating a video for <b>${esc(profile.name)}</b>${topic?` about “${esc(short(topic,200))}”`:' (topic chosen from the profile)'}.\n${j.profile?`${esc(j.profile.language)} · ${esc(j.profile.format)} · ${j.profile.durationSec}s`:''}\nUse /status to follow it.`);
  }
  async function confirmText(action,v,sceneNumber){
    if(action==='skip')return `Skip <b>${esc(v.title)}</b>?\nIt stays as it is (you can still open, fix or approve it later), but Autopilot no longer waits for it and makes the next video at the next time.`;
    if(action==='approve')return `Approve <b>${esc(v.title)}</b>?\nThis confirms you watched it: the images match the narration, subtitles are readable and it suits the audience.`;
    if(action==='rebuild')return `Rebuild <b>all ${(v.storyId?.scenes||[]).length} images</b> of <b>${esc(v.title)}</b> from the narration?\nEvery scene is re-planned and gets a new image. I'll send them all here to check before the video is rendered.${reapproveNote(v)}`;
    if(action==='regen')return `Make a new image for <b>scene ${sceneNumber}</b> of <b>${esc(v.title)}</b> and re-render the video?${reapproveNote(v)}`;
    if(action==='delete')return `Delete <b>${esc(v.title)}</b> permanently?\nIts video, images, narration and jobs are removed. This cannot be undone.`;
    let p=null;try{p=await api('GET',`/youtube/preview/${v._id}`);}catch{}
    const when=action==='schedule'?(p?.nextSlot?`at ${new Date(p.nextSlot).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:p.settings?.timezone||'Asia/Kolkata'})} (then public)`:'at the profile\'s next publish time'):`now as <b>${esc(p?.metadata?.privacyStatus||'private')}</b>`;
    const problems=(p?.blockReason?[p.blockReason]:p?.problems)||[];
    return [`Upload <b>${esc(p?.metadata?.title||v.title)}</b> to ${p?.youtube?.channelTitle?`<b>${esc(p.youtube.channelTitle)}</b>`:'YouTube'} ${when}?`,p?.seoReport?`SEO ${p.seoReport.score}/100${p.seo?.focusKeyword?` · keyword “${esc(p.seo.focusKeyword)}”`:''}`:'',problems.length?`⚠ ${esc(problems.join(' '))}`:''].filter(Boolean).join('\n');
  }
  const sceneOf=(v,n)=>(v.storyId?.scenes||[]).find((s,i)=>Number(s.sceneNumber||i+1)===Number(n));
  const assetOf=(v,n)=>(v.sceneAssets||v.mediaAssetDetails||[]).find(a=>Number(a.sceneNumber)===Number(n));
  async function showScenes(chatId,v,messageId){
    const scenes=v.storyId?.scenes||[];
    const stale=(v.sceneAssets||v.mediaAssetDetails||[]).filter(a=>a.stale).map(a=>a.sceneNumber);
    const text=[`🎞 <b>Scenes — ${esc(short(v.title,80))}</b>`,...scenes.map((s,i)=>`<b>${s.sceneNumber||i+1}.</b> ${stale.includes(s.sceneNumber||i+1)?'⚠ ':''}${s.durationSec?`${Math.round(s.durationSec)}s · `:''}${esc(short(s.narration,110))}`),'',stale.length?`⚠ Scene${stale.length>1?'s':''} ${stale.join(', ')}: the image may not match the narration (made from an older description). Use 🖼 Rebuild all images or change the scene.`:'','Tap a scene to see it and change its image or narration.'].filter(x=>x!=='').join('\n');
    const buttons=scenes.map((s,i)=>({text:`Scene ${s.sceneNumber||i+1}`,callback_data:`a:${nonce({action:'scene',videoId:String(v._id),sceneNumber:s.sceneNumber||i+1})}`}));
    const rows=[];for(let i=0;i<buttons.length;i+=3)rows.push(buttons.slice(i,i+3));
    rows.push([{text:'🖼 Rebuild all images',callback_data:`a:${nonce({action:'rebuild',videoId:String(v._id)})}`},{text:'⬅ Back to video',callback_data:`a:${nonce({action:'open',videoId:String(v._id)})}`}]);
    return tg.edit(chatId,messageId,text,{inline_keyboard:rows});
  }
  function sceneMarkup(videoId,n){
    const b=(text,action)=>({text,callback_data:`a:${nonce({action,videoId,sceneNumber:n})}`});
    return {inline_keyboard:[[b('🔄 New image','regen'),b('✏️ Describe new image','askImage')],[b('🗣 Change narration','askNarration'),{text:'🔊 Hear narration',callback_data:`h:${videoId}:${n}`}],[b('⬅ All scenes','scenes')]]};
  }
  async function showScene(chatId,v,n){
    const scene=sceneOf(v,n);if(!scene)throw new Error(`Scene ${n} not found.`);
    const caption=[`<b>Scene ${n}</b> of ${esc(short(v.title,60))}`,`🗣 ${esc(short(scene.narration,500))}`,scene.visualPrompt?`🖼 <i>${esc(short(scene.visualPrompt,300))}</i>`:''].filter(Boolean).join('\n');
    const asset=assetOf(v,n);
    const markup=v.status==='SCENE_REVIEW'&&Number(v.pendingSceneEdit?.sceneNumber)===Number(n)
      ?{inline_keyboard:[[{text:'✅ Render video',callback_data:`r:${v._id}`}],...sceneMarkup(String(v._id),n).inline_keyboard]}
      :sceneMarkup(String(v._id),n);
    let problem='no image file yet';
    if(asset?.path){try{return await tg.sendPhoto(chatId,asset.path,caption,markup);}catch(e){problem=e.message;}}
    return tg.send(chatId,`${caption}\n⚠ Image not attached (${esc(short(problem,150))}).`,markup);
  }
  const reapproveNote=v=>v.status==='APPROVED'?'\nThe video was approved — it will need approval again after re-rendering.':'';
  async function confirmRenderNow(chatId,videoId){
    const {v}=await loadVideo(chatId,videoId);
    if(v.status!=='SCENE_REVIEW')return tg.send(chatId,`This video is not waiting for render confirmation (now: ${STATUS[v.status]||v.status}).`);
    await api('POST',`/videos/${videoId}/render`);
    return tg.send(chatId,`🎬 Rendering <b>${esc(v.title)}</b> with the new scene. It comes back for approval when done. Use /status to follow it.`);
  }
  async function applyEdit(chatId,messageId,{videoId,sceneNumber,body}){
    await tg.edit(chatId,messageId,`⏳ Updating scene ${sceneNumber}…`,{inline_keyboard:[]});
    const r=await api('POST',`/videos/${videoId}/scenes/${sceneNumber}/edit`,{...body,confirmBeforeRender:true,requestedByChat:chatId});
    return tg.send(chatId,[`🎞 Scene ${sceneNumber} is being rebuilt${r.regenerateImage?' with a new image':''}${r.narrationChanged?' and new narration':''}.`,r.visualPrompt?`🖼 <i>${esc(short(r.visualPrompt,400))}</i>`:'','I\'ll send the new scene here for you to check before the video is rendered.'].filter(Boolean).join('\n'));
  }
  async function runAction(chatId,messageId,{action,videoId,sceneNumber,body}){
    const {v}=await loadVideo(chatId,videoId);
    switch(action){
      case 'open':return showCard(chatId,videoId,messageId);
      case 'send':{
        if(!v.renderPath)return tg.send(chatId,'This video has not been rendered yet.');
        try{return await tg.sendVideo(chatId,v.renderPath,cardText(v),cardMarkup(v,scope(chatId).find(p=>p.id===String(v.profile?.id))));}
        catch(e){return tg.send(chatId,e?.code==='ENOENT'?missingFileMessage(v.renderPath):`Could not send the file: ${esc(e.message)}`);}
      }
      case 'approve':await api('POST',`/videos/${videoId}/visual-review`,{imagesMatch:true,subtitlesReadable:true,ageAppropriate:true});await api('POST',`/videos/${videoId}/approve`);break;
      case 'delete':await api('DELETE',`/videos/${videoId}`);return tg.edit(chatId,messageId,`🗑 Deleted <b>${esc(v.title)}</b>.`,{inline_keyboard:[]});
      case 'upload':case 'schedule':{
        await tg.edit(chatId,messageId,`⏳ Uploading <b>${esc(v.title)}</b>…`,{inline_keyboard:[]});
        const r=await api('POST',`/youtube/publish/${videoId}`,action==='schedule'?{schedule:'profile'}:{});
        return tg.send(chatId,`${r.status==='SCHEDULED'?'🗓 Scheduled':'📺 Uploaded'}: <b>${esc(r.metadata?.title||v.title)}</b>\n${r.url}${r.seoReport?`\nSEO ${r.seoReport.score}/100`:''}${(r.warnings||[]).length?`\n⚠ ${esc(r.warnings.join(' '))}`:''}`);
      }
      case 'booknext':{
        let r;try{r=await api('GET',`/autopilot/${v.profile?.id}/next-slot`);}catch(e){return tg.send(chatId,`${esc(e.message)}`,{inline_keyboard:[[{text:'🕒 Pick a time',callback_data:`a:${nonce({action:'picktime',videoId})}`}]]});}
        return tg.send(chatId,`Publish <b>${esc(v.title)}</b> at the next free time, <b>${esc(r.label)}</b>?\nIt is uploaded now as private and goes public then.`,{inline_keyboard:[[{text:`🗓 Yes, ${r.label}`,callback_data:`a:${nonce({action:'book',videoId,body:{at:r.slotAt},confirmed:true})}`}],[{text:'🕒 Pick another time',callback_data:`a:${nonce({action:'picktime',videoId})}`}]]});
      }
      case 'picktime':{
        let tz='Asia/Kolkata';try{tz=(await api('GET',`/autopilot/${v.profile?.id}/next-slot`)).timezone||tz;}catch(e){tz=e?.body?.timezone||tz;}
        awaiting.set(chatId,{kind:'time',videoId,timezone:tz,expires:now()+INPUT_TTL});
        return tg.send(chatId,`When should <b>${esc(v.title)}</b> go public? Send a date and time (${esc(tz.replace(/_/g,' '))} time), for example:\n<code>27 Nov 18:30</code> · <code>tomorrow 9am</code> · <code>19:30</code> · <code>27/11 7pm</code>\n\nSend /cancel to stop.`);
      }
      case 'book':{
        await tg.edit(chatId,messageId,`⏳ Booking <b>${esc(v.title)}</b>…`,{inline_keyboard:[]});
        const r=await api('POST',`/autopilot/book/${videoId}`,body||{});
        return tg.send(chatId,`🗓 <b>${esc(v.title)}</b> is booked for <b>${esc(r.label)}</b>. It is being uploaded to YouTube now (private until then); you'll get a message when the upload is done.`);
      }
      case 'retry':await api('POST',`/videos/${videoId}/retry`);break;
      case 'scenes':return showScenes(chatId,v,messageId);
      case 'rebuild':{
        await tg.edit(chatId,messageId,`⏳ Rebuilding all images of <b>${esc(v.title)}</b>…`,{inline_keyboard:[]});
        const r=await api('POST',`/videos/${videoId}/rebuild-images`,{replan:true,confirmBeforeRender:true,requestedByChat:chatId});
        return tg.send(chatId,`🖼 Re-planning ${r.sceneCount} scenes from the narration and making new images. I'll send them here for you to check before rendering. Use /status to follow it.`);
      }
      case 'scene':return showScene(chatId,v,sceneNumber);
      case 'regen':{
        await tg.edit(chatId,messageId,`⏳ Making a new image for scene ${sceneNumber}…`,{inline_keyboard:[]});
        await api('POST',`/videos/${videoId}/scenes/${sceneNumber}/regenerate`,{confirmBeforeRender:true,requestedByChat:chatId});
        return tg.send(chatId,`🔄 Scene ${sceneNumber} is getting a new image. I'll send it here for you to check before the video is rendered.`);
      }
      case 'askImage':case 'askNarration':{
        if(!EDITABLE.has(v.status))return tg.send(chatId,'This video cannot be changed right now.');
        const kind=action==='askImage'?'image':'narration';
        awaiting.set(chatId,{kind,videoId,sceneNumber,expires:now()+INPUT_TTL});
        const scene=sceneOf(v,sceneNumber);
        if(kind==='image')return tg.send(chatId,`✏️ Send a description of the new image for <b>scene ${sceneNumber}</b> (any language).\nExample: <i>an old woodcutter kneeling by a river at sunset, holding a golden axe</i>\n/cancel to stop.`);
        const words=String(scene?.narration||'').split(/\s+/).filter(Boolean).length;
        return tg.send(chatId,`🗣 Send the new narration for <b>scene ${sceneNumber}</b>, in the video's language. Keep it about ${words} words so the timing stays similar.\nCurrent:\n<code>${esc(scene?.narration||'')}</code>\n/cancel to stop.`);
      }
      case 'applyEdit':return applyEdit(chatId,messageId,{videoId,sceneNumber,body});
      case 'cancel':await api('POST',`/videos/${videoId}/cancel`);break;
      case 'skip':await api('POST',`/videos/${videoId}/skip`);await tg.send(chatId,`⏭ Skipped <b>${esc(v.title)}</b>. Autopilot will make the next video at the next time.`);break;
      case 'unskip':await api('POST',`/videos/${videoId}/unskip`);await tg.send(chatId,`↩ <b>${esc(v.title)}</b> is no longer skipped; Autopilot waits for it again.`);break;
      default:return tg.send(chatId,'Unknown action.');
    }
    return showCard(chatId,videoId,messageId);
  }

  async function onMessage(msg){
    const chatId=String(msg.chat?.id);const parsed=parseCommand(msg.text);
    const profiles=scope(chatId);
    if(!profiles.length){
      if(parsed)return tg.send(chatId,`This chat is not allowed to control any profile.\nChat ID: <code>${esc(chatId)}</code>\nAdd it in the dashboard → Channel Profiles → Telegram, and turn on “Allow commands”.`);
      return;
    }
    const pending=awaiting.get(chatId);
    if(parsed?.cmd==='cancel'){awaiting.delete(chatId);return tg.send(chatId,pending?(pending.kind==='time'?'Scheduling cancelled.':'Scene change cancelled.'):'Nothing to cancel.');}
    if(!parsed&&pending?.kind==='time'){
      if(pending.expires<now()){awaiting.delete(chatId);return tg.send(chatId,'That expired. Open the video and press “🕒 Pick a time” again.');}
      const text=String(msg.text||'').trim();
      const r=parseWhen(text,pending.timezone,new Date(now()));
      if(r.error)return tg.send(chatId,`${esc(r.error)}\nTry again, or send /cancel.`);
      awaiting.delete(chatId);
      const {v}=await loadVideo(chatId,pending.videoId);
      const label=formatWhen(r.at,pending.timezone);
      return tg.send(chatId,`Publish <b>${esc(v.title)}</b> at <b>${esc(label)}</b>?\nIt is uploaded now as private and goes public then.`,{inline_keyboard:[[{text:`🗓 Yes, ${label}`,callback_data:`a:${nonce({action:'book',videoId:pending.videoId,body:{at:r.at.toISOString()},confirmed:true})}`}],[{text:'🕒 Another time',callback_data:`a:${nonce({action:'picktime',videoId:pending.videoId})}`}]]});
    }
    if(!parsed&&pending){
      awaiting.delete(chatId);
      if(pending.expires<now())return tg.send(chatId,'That scene change expired. Open the scene again.');
      const text=String(msg.text||'').trim();
      if(text.length<3)return tg.send(chatId,'That is too short. Open the scene again and try once more.');
      const {v}=await loadVideo(chatId,pending.videoId);
      const base={action:'applyEdit',videoId:pending.videoId,sceneNumber:pending.sceneNumber,confirmed:true};
      if(pending.kind==='image')
        return tg.send(chatId,`Use this for <b>scene ${pending.sceneNumber}</b>'s new image?\n<i>${esc(short(text,800))}</i>${reapproveNote(v)}`,{inline_keyboard:[[{text:'🖼 Yes, make it',callback_data:`a:${nonce({...base,body:{imageInstruction:text}})}`},{text:'Cancel',callback_data:`a:${nonce({action:'scene',videoId:pending.videoId,sceneNumber:pending.sceneNumber})}`}]]});
      return tg.send(chatId,`New narration for <b>scene ${pending.sceneNumber}</b>:\n<i>${esc(short(text,1000))}</i>\nThe scene is spoken again and captions follow.${reapproveNote(v)}`,{inline_keyboard:[[{text:'🗣 Yes, keep image',callback_data:`a:${nonce({...base,body:{narration:text,regenerateImage:false}})}`}],[{text:'🗣🖼 Yes + new image',callback_data:`a:${nonce({...base,body:{narration:text,regenerateImage:true}})}`}],[{text:'Cancel',callback_data:`a:${nonce({action:'scene',videoId:pending.videoId,sceneNumber:pending.sceneNumber})}`}]]});
    }
    if(!parsed)return; // ignore normal chat messages
    const {cmd,args}=parsed;
    if(cmd==='start'||cmd==='help')return tg.send(chatId,HELP);
    if(cmd==='profiles')return tg.send(chatId,`This chat controls:\n${profiles.map(p=>`• <b>${esc(p.name)}</b>`).join('\n')}`);
    if(cmd==='new'){
      if(profiles.length===1)return createVideo(chatId,profiles[0],args);
      return tg.send(chatId,`Which profile${args?` for “${esc(short(args,120))}”`:''}?`,{inline_keyboard:profiles.map(p=>[{text:p.name,callback_data:`n:${nonce({profileId:p.id,topic:args})}`}])});
    }
    if(cmd==='trending'){
      const profile=profiles.length===1?profiles[0]:null;
      if(!profile)return tg.send(chatId,'Which profile?',{inline_keyboard:profiles.map(p=>[{text:p.name,callback_data:`a:${nonce({action:'trending',profileId:p.id})}`}])});
      return sendTrending(chatId,profile);
    }
    if(cmd==='recent'||cmd==='pending'){
      const vids=await videosFor(profiles,{status:cmd==='pending'?'AWAITING_APPROVAL':undefined});
      if(!vids.length)return tg.send(chatId,cmd==='pending'?'Nothing is awaiting approval. 🎉':'No videos yet. Use /new to create one.');
      return tg.send(chatId,cmd==='pending'?`<b>${vids.length} awaiting approval</b> — tap one to review:`:'<b>Latest videos</b> — tap one:',listMarkup(vids));
    }
    if(cmd==='status'){
      const vids=(await videosFor(profiles,{limit:20})).filter(v=>v.latestJob&&ACTIVE.has(v.latestJob.status));
      if(!vids.length)return tg.send(chatId,'Nothing is being made right now. Use /new to start a video.');
      return tg.send(chatId,`<b>In progress</b>\n${vids.map(v=>`• ${esc(short(v.title,60))} — ${v.latestJob.progress||0}% ${esc(String(v.latestJob.step||'').replace(/_/g,' ').toLowerCase())}`).join('\n')}`,listMarkup(vids));
    }
    return tg.send(chatId,`Unknown command. ${HELP}`);
  }

  async function onCallback(cb){
    const chatId=String(cb.message?.chat?.id);const messageId=cb.message?.message_id;const data=String(cb.data||'');
    if(!scope(chatId).length)return tg.answer(cb.id,'This chat is not allowed to control the bot.');
    const [kind,key]=[data.slice(0,1),data.slice(2)];
    if(kind==='o'){await tg.answer(cb.id,'');return showCard(chatId,key);}
    // "✅ Approve" on the "ready for approval" notification (stateless; asks to confirm).
    if(kind==='p'){
      const {v}=await loadVideo(chatId,key);
      await tg.answer(cb.id,'');
      if(v.status!=='AWAITING_APPROVAL')return tg.send(chatId,`<b>${esc(v.title)}</b> is ${esc(String(v.status).toLowerCase().replace(/_/g,' '))} — nothing to approve.`,{inline_keyboard:[[{text:'Open video',callback_data:`o:${key}`}]]});
      return tg.send(chatId,await confirmText('approve',v),{inline_keyboard:[[{text:'✅ Yes, approve',callback_data:`a:${nonce({action:'approve',videoId:key,confirmed:true})}`},{text:'Open video',callback_data:`o:${key}`}]]});
    }
    // "🗑 Delete" on Autopilot messages (stateless): confirm first, never while it is being made.
    if(kind==='d'){
      await tg.answer(cb.id,'');
      let v;try{({v}=await loadVideo(chatId,key));}catch(e){return tg.send(chatId,esc(e.message));}
      if(v.latestJob&&ACTIVE.has(v.latestJob.status))return tg.send(chatId,`<b>${esc(v.title)}</b> is still being made. Cancel it first, then delete it.`,{inline_keyboard:[[{text:'Open video',callback_data:`o:${key}`}]]});
      return tg.send(chatId,await confirmText('delete',v),{inline_keyboard:[[{text:'🗑 Yes, delete',callback_data:`a:${nonce({action:'delete',videoId:key,confirmed:true})}`},{text:'Open video',callback_data:`o:${key}`}]]});
    }
    // "⏭ Skip this video" on Autopilot messages (stateless): confirm first.
    if(kind==='s'){
      await tg.answer(cb.id,'');
      let v;try{({v}=await loadVideo(chatId,key));}catch(e){return tg.send(chatId,esc(e.message));}
      if(!SKIPPABLE.has(v.status))return tg.send(chatId,`<b>${esc(v.title)}</b> is ${esc(String(v.status).toLowerCase().replace(/_/g,' '))} — nothing to skip.`);
      if(v.skippedAt)return tg.send(chatId,`<b>${esc(v.title)}</b> is already skipped.`);
      return tg.send(chatId,await confirmText('skip',v),{inline_keyboard:[[{text:'⏭ Yes, skip it',callback_data:`a:${nonce({action:'skip',videoId:key,confirmed:true})}`},{text:'Open video',callback_data:`o:${key}`}]]});
    }
    // "🆕 Make a new video anyway" on an Autopilot "waiting" message: confirm first.
    if(kind==='w'||kind==='W'){
      await tg.answer(cb.id,'');
      let run;try{run=await api('GET',`/autopilot/runs/${key}`);}catch(e){return tg.send(chatId,`Could not open that slot: ${esc(e.message)}`);}
      if(!scope(chatId).some(p=>p.id===String(run.seriesId)))return tg.send(chatId,'This chat does not control that profile.');
      if(run.status!=='WAITING')return tg.send(chatId,`That slot is already ${esc(String(run.status).toLowerCase().replace(/_/g,' '))}.`);
      if(kind==='w')return tg.send(chatId,'Make a new video for this slot now, even though the previous one is not published yet?',{inline_keyboard:[[{text:'🆕 Yes, make it',callback_data:`W:${key}`}]]});
      try{await api('POST',`/autopilot/runs/${key}/generate`);return tg.send(chatId,'🎬 Making the new video. You will get a message when it is ready.');}
      catch(e){return tg.send(chatId,`Could not start it: ${esc(e.message)}`);}
    }
    // Sent with the "scene rebuilt" message (stateless; ownership is checked).
    if(kind==='r'){await tg.answer(cb.id,'Rendering…');return confirmRenderNow(chatId,key);}
    if(kind==='e'){const [videoId,n]=key.split(':');await tg.answer(cb.id,'');const {v}=await loadVideo(chatId,videoId);return showScene(chatId,v,Number(n));}
    if(kind==='h'){
      const [videoId,n]=key.split(':');await tg.answer(cb.id,'');
      const {v}=await loadVideo(chatId,videoId);
      const file=(v.sceneAudioFiles||[]).find(f=>/scene-(\d+)\.mp3$/.test(f)&&Number(/scene-(\d+)\.mp3$/.exec(f)[1])===Number(n));
      if(!file)return tg.send(chatId,`No narration audio is available for scene ${n} yet.`);
      try{return await tg.sendAudio(chatId,file,`🔊 Scene ${n} — ${esc(short(sceneOf(v,n)?.narration,300))}`,`Scene ${n}`);}catch(e){return tg.send(chatId,`Could not send the audio: ${esc(e.message)}`);}
    }
    const entry=take(key);
    if(!entry)return tg.answer(cb.id,'This button has expired. Open the video again.');
    if(kind==='n'){
      const profile=scope(chatId).find(p=>p.id===entry.profileId);
      if(!profile)return tg.answer(cb.id,'Profile no longer available.');
      await tg.answer(cb.id,'Starting…');return createVideo(chatId,profile,entry.topic);
    }
    if(kind==='a'&&entry.action==='trending'){
      const profile=scope(chatId).find(p=>p.id===entry.profileId);
      await tg.answer(cb.id,'');
      return profile?sendTrending(chatId,profile):tg.send(chatId,'Profile no longer available.');
    }
    if(kind==='a'){
      if(CONFIRM[entry.action]&&!entry.confirmed){
        const {v}=await loadVideo(chatId,entry.videoId);
        await tg.answer(cb.id,'');
        const yes={skip:'⏭ Yes, skip it',delete:'🗑 Yes, delete',approve:'✅ Yes, approve',regen:'🔄 Yes, new image',rebuild:'🖼 Yes, rebuild all'}[entry.action]||'📺 Yes, upload';
        const confirmMsg=await confirmText(entry.action,v,entry.sceneNumber);
        if(entry.action==='regen')return tg.send(chatId,confirmMsg,{inline_keyboard:[[{text:yes,callback_data:`a:${nonce({...entry,confirmed:true})}`},{text:'Cancel',callback_data:`a:${nonce({action:'scene',videoId:entry.videoId,sceneNumber:entry.sceneNumber})}`}]]});
        return tg.edit(chatId,messageId,confirmMsg,{inline_keyboard:[[{text:yes,callback_data:`a:${nonce({...entry,confirmed:true})}`},{text:'Back',callback_data:`a:${nonce({action:'open',videoId:entry.videoId})}`}]]});
      }
      await tg.answer(cb.id,'Working…');
      return runAction(chatId,messageId,entry);
    }
    return tg.answer(cb.id,'Unknown button.');
  }

  // Errors are reported to the chat instead of crashing the poller.
  async function handleUpdate(update){
    const chatId=String(update.message?.chat?.id||update.callback_query?.message?.chat?.id||'');
    try{
      if(update.callback_query)return await onCallback(update.callback_query);
      if(update.message?.text)return await onMessage(update.message);
    }catch(e){if(chatId)await tg.send(chatId,`⚠ ${esc(e.message)}`).catch(()=>{});}
  }
  return {handleUpdate,_nonces:nonces};
}
