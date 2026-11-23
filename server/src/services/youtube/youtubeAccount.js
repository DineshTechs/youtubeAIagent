// Per-profile YouTube connection, stored on Series.youtubeAccount:
//   {clientId, clientSecret:<encrypted>, redirectUri, publishEnabled,
//    tokens:<encrypted>, channelId, channelTitle, connectedAt, lastError}
// Secrets are encrypted at rest and never leave the server: publicAccount() is
// the only shape the API returns.
import {encryptSecret,decryptSecret} from '../secretBox.js';
import {publicSettings as publicTelegram} from '../telegram/telegramFormat.js';

// On a server set PUBLIC_URL (e.g. https://agent.example.com); on your PC it is the local address.
export function defaultRedirectUri(port=Number(process.env.PORT||4000)){const pub=String(process.env.PUBLIC_URL||"").trim().replace(/\/+$/,"");return pub?`${pub}/api/youtube/callback`:`http://127.0.0.1:${port}/api/youtube/callback`;}
const clean=v=>String(v??'').trim();

export function credentialsOf(acc={}){
  const a=acc&&typeof acc==='object'?acc:{};
  return {clientId:clean(a.clientId),clientSecret:decryptSecret(a.clientSecret)||'',redirectUri:clean(a.redirectUri)||defaultRedirectUri(),publishEnabled:a.publishEnabled===true};
}
export function tokensOf(acc={}){return decryptSecret(acc?.tokens)||null;}

export function readiness(acc={}){
  const c=credentialsOf(acc);
  const secretUnreadable=Boolean(acc?.clientSecret)&&!c.clientSecret;
  const configured=Boolean(c.clientId&&c.clientSecret);
  const connected=configured&&Boolean(tokensOf(acc)?.refresh_token||tokensOf(acc)?.access_token);
  const problems=[];
  if(!c.clientId)problems.push('Add the OAuth Client ID for this profile (Channel Profiles → YouTube channel).');
  if(!c.clientSecret)problems.push(secretUnreadable?'The saved client secret can no longer be read (the encryption key changed). Enter it again.':'Add the OAuth Client secret for this profile.');
  if(configured&&!connected)problems.push('Connect this profile to its YouTube channel.');
  if(!c.publishEnabled)problems.push('Uploading is switched off for this profile. Turn on "Allow uploads" in its YouTube channel settings.');
  return {configured,connected,publishEnabled:c.publishEnabled,secretUnreadable,problems};
}

export function publicAccount(acc={}){
  const a=acc&&typeof acc==='object'?acc:{};
  const c=credentialsOf(a);const r=readiness(a);
  return {clientId:c.clientId,hasClientSecret:Boolean(a.clientSecret),redirectUri:c.redirectUri,defaultRedirectUri:defaultRedirectUri(),
    publishEnabled:c.publishEnabled,configured:r.configured,connected:r.connected,secretUnreadable:r.secretUnreadable,
    channelId:a.channelId||null,channelTitle:a.channelTitle||null,connectedAt:a.connectedAt||null,lastError:a.lastError||null};
}

// Applies a credential edit from the dashboard. A blank secret keeps the saved one.
// Changing the Client ID or secret drops the existing connection (its tokens
// belong to the old OAuth client).
export function applyCredentialUpdate(acc={},input={}){
  const a=acc&&typeof acc==='object'?{...acc}:{};
  const before=credentialsOf(a);
  if(input.clientId!==undefined)a.clientId=clean(input.clientId).slice(0,300);
  if(input.redirectUri!==undefined){const u=clean(input.redirectUri);if(u&&!/^https?:\/\/[^\s]+$/i.test(u))throw new Error('Redirect URI must start with http:// or https://');a.redirectUri=u;}
  if(input.clearSecret===true)a.clientSecret=null;
  else if(clean(input.clientSecret))a.clientSecret=encryptSecret(clean(input.clientSecret).slice(0,500));
  if(input.publishEnabled!==undefined)a.publishEnabled=input.publishEnabled===true;
  const after=credentialsOf(a);
  if(before.clientId!==after.clientId||(clean(input.clientSecret)&&before.clientSecret!==after.clientSecret)||input.clearSecret===true){
    a.tokens=null;a.channelId=null;a.channelTitle=null;a.connectedAt=null;
  }
  a.lastError=null;
  return a;
}
export function withTokens(acc={},tokens,channel={}){
  return {...acc,tokens:encryptSecret(tokens),...(channel.channelId?{channelId:channel.channelId,channelTitle:channel.channelTitle||null,connectedAt:new Date()}:{}),lastError:null};
}
export function disconnected(acc={}){return {...acc,tokens:null,channelId:null,channelTitle:null,connectedAt:null,lastError:null};}
// Strips youtubeAccount secrets from a plain series object (for .lean() results).
export function publicSeries(series){if(!series||typeof series!=='object')return series;const {youtubeAccount,telegram,...rest}=series;return {...rest,youtubeAccount:publicAccount(youtubeAccount),telegram:publicTelegram(telegram)};}
