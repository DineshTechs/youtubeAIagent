// Minimal YouTube Data API v3 + Google OAuth client built on fetch (no googleapis
// dependency). Every function takes the profile's credentials explicitly.
import fs from 'node:fs/promises';

export const SCOPES=[
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  // Needed to add uploads to the profile's playlist.
  'https://www.googleapis.com/auth/youtube.force-ssl'
];
const AUTH_URL='https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL='https://oauth2.googleapis.com/token';
const REVOKE_URL='https://oauth2.googleapis.com/revoke';
const API='https://www.googleapis.com/youtube/v3';
const UPLOAD='https://www.googleapis.com/upload/youtube/v3/videos';

export class YouTubeApiError extends Error{constructor(message,status,reason){super(message);this.status=status;this.reason=reason;}}
async function readError(r,label){
  let j=null;const text=await r.text().catch(()=>'');try{j=JSON.parse(text);}catch{}
  const reason=j?.error?.errors?.[0]?.reason||j?.error||'';
  const msg=j?.error?.message||j?.error_description||(typeof j?.error==='string'?j.error:'')||text.slice(0,300)||`HTTP ${r.status}`;
  return new YouTubeApiError(`${label} failed (${r.status}): ${msg}`,r.status,reason);
}

export function buildAuthUrl({clientId,redirectUri,state}){
  const q=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:SCOPES.join(' '),access_type:'offline',prompt:'consent',include_granted_scopes:'true',state});
  return `${AUTH_URL}?${q}`;
}
function withExpiry(t,now=Date.now()){return {...t,expiry_date:t.expires_in?now+Number(t.expires_in)*1000:t.expiry_date||null};}
export async function exchangeCode({clientId,clientSecret,redirectUri,code},fetchImpl=fetch){
  const r=await fetchImpl(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,grant_type:'authorization_code'})});
  if(!r.ok)throw await readError(r,'Google sign-in');
  return withExpiry(await r.json());
}
export async function refreshTokens({clientId,clientSecret,tokens},fetchImpl=fetch){
  if(!tokens?.refresh_token)throw new YouTubeApiError('The YouTube connection has no refresh token. Connect the channel again.',401,'no_refresh_token');
  const r=await fetchImpl(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:tokens.refresh_token,grant_type:'refresh_token'})});
  if(!r.ok)throw await readError(r,'YouTube token refresh');
  const fresh=withExpiry(await r.json());
  return {...tokens,...fresh,refresh_token:fresh.refresh_token||tokens.refresh_token};
}
export function needsRefresh(tokens,now=Date.now()){return !tokens?.access_token||(tokens.expiry_date&&tokens.expiry_date<now+120000);}
export async function revokeToken(token,fetchImpl=fetch){if(!token)return;try{await fetchImpl(`${REVOKE_URL}?token=${encodeURIComponent(token)}`,{method:'POST'});}catch{}}

export async function getMyChannel(accessToken,fetchImpl=fetch){
  const r=await fetchImpl(`${API}/channels?part=snippet,statistics&mine=true`,{headers:{Authorization:`Bearer ${accessToken}`}});
  if(!r.ok)throw await readError(r,'Reading your YouTube channel');
  const ch=(await r.json()).items?.[0];
  if(!ch)throw new YouTubeApiError('This Google account has no YouTube channel.',404,'no_channel');
  return {channelId:ch.id,channelTitle:ch.snippet?.title||null,subscriberCount:ch.statistics?.subscriberCount||null};
}

// Resumable upload (two requests). Shorts are small, so the file is sent in one PUT.
export async function uploadVideoFile({accessToken,filePath,snippet,status,notifySubscribers=true},fetchImpl=fetch){
  const bytes=await fs.readFile(filePath);
  const q=new URLSearchParams({uploadType:'resumable',part:'snippet,status',notifySubscribers:String(Boolean(notifySubscribers))});
  const init=await fetchImpl(`${UPLOAD}?${q}`,{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Length':String(bytes.length),'X-Upload-Content-Type':'video/mp4'},body:JSON.stringify({snippet,status})});
  if(!init.ok)throw await readError(init,'Starting the YouTube upload');
  const location=init.headers.get('location');
  if(!location)throw new YouTubeApiError('YouTube did not return an upload URL.',502,'no_location');
  const put=await fetchImpl(location,{method:'PUT',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'video/mp4','Content-Length':String(bytes.length)},body:bytes});
  if(!put.ok)throw await readError(put,'Uploading the video file');
  const j=await put.json();
  if(!j?.id)throw new YouTubeApiError('YouTube accepted the upload but returned no video id.',502,'no_id');
  return j;
}
export async function addToPlaylist({accessToken,playlistId,videoId},fetchImpl=fetch){
  const r=await fetchImpl(`${API}/playlistItems?part=snippet`,{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({snippet:{playlistId,resourceId:{kind:'youtube#video',videoId}}})});
  if(!r.ok)throw await readError(r,'Adding to playlist');
  return r.json();
}
