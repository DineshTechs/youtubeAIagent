import {getAuthUrl,handleCallback,youtubeStatus,uploadVideo} from '../services/youtube/publisher.js';
export function status(_req,res){res.json(youtubeStatus());}
export function auth(_req,res,next){try{res.redirect(getAuthUrl());}catch(e){next(e);}}
export async function callback(req,res,next){try{const info=await handleCallback(String(req.query.code||''),String(req.query.state||''));res.send(`<html><body style="font-family:Arial;padding:40px"><h2>YouTube connected</h2><p>${escapeHtml(info.channelTitle||'Channel connected')}</p><p>You can close this window and return to YouTube AI Agent.</p><script>window.opener?.postMessage({type:'YOUTUBE_CONNECTED'},'*');</script></body></html>`);}catch(e){next(e);}}
export async function publish(req,res,next){try{const r=await uploadVideo(req.params.id,req.body||{});res.json(r);}catch(e){next(e);}}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
