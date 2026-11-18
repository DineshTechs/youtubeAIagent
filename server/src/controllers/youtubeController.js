import {getAuthUrl,handleCallback,uploadVideo,previewUpload,regenerateSeo,accountStatus,updateAccount,disconnectAccount,PublishError} from '../services/youtube/publisher.js';
const fail=(res,next,e)=>e instanceof PublishError?res.status(e.status).json({error:e.message}):next(e);
const page=(title,body,ok)=>`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:Segoe UI,Arial;padding:40px;background:#0b0d12;color:#e8ebf2"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p><p>You can close this window and return to YouTube AI Agent.</p><script>try{window.opener&&window.opener.postMessage({type:${ok?"'YOUTUBE_CONNECTED'":"'YOUTUBE_CONNECT_FAILED'"}},'*');}catch(e){}</script></body></html>`;

export async function status(req,res,next){try{res.json(await accountStatus(req.params.seriesId));}catch(e){fail(res,next,e);}}
export async function saveAccount(req,res,next){try{const b=req.body||{};res.json(await updateAccount(req.params.seriesId,{clientId:b.clientId,clientSecret:b.clientSecret,clearSecret:b.clearSecret===true,redirectUri:b.redirectUri,publishEnabled:b.publishEnabled}));}catch(e){fail(res,next,e);}}
export async function disconnect(req,res,next){try{res.json(await disconnectAccount(req.params.seriesId));}catch(e){fail(res,next,e);}}
export async function auth(req,res){try{res.redirect(await getAuthUrl(req.params.seriesId));}catch(e){res.status(e.status||500).send(page('Cannot connect YouTube',e.message,false));}}
export async function callback(req,res){
  if(req.query.error)return res.status(400).send(page('YouTube connection cancelled',String(req.query.error),false));
  try{const info=await handleCallback(String(req.query.code||''),String(req.query.state||''));res.send(page('YouTube connected',`"${info.channelTitle||'Channel'}" is now connected to the "${info.profileName}" profile.`,true));}
  catch(e){res.status(400).send(page('YouTube connection failed',e.message,false));}
}
export async function publish(req,res,next){try{res.json(await uploadVideo(req.params.id,req.body||{}));}catch(e){fail(res,next,e);}}
export async function preview(req,res,next){try{res.json(await previewUpload(req.params.id,req.query||{}));}catch(e){fail(res,next,e);}}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export async function seo(req,res,next){try{res.json(await regenerateSeo(req.params.id));}catch(e){fail(res,next,e);}}
