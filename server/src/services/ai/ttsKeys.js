// Keys for the free narration providers. Saved encrypted in AISettings.secrets from
// Settings → Narration; the matching .env variables still work as a fallback.
import AISettings from '../../models/AISettings.js';
import {encryptSecret,decryptSecret} from '../secretBox.js';
import {DEFAULT_MCP_TTS_URL} from '../media/mcpTts.js';

const ENV={azure:{key:'AZURE_SPEECH_KEY',region:'AZURE_SPEECH_REGION'},google:{key:'GOOGLE_TTS_API_KEY'},elevenlabs:{key:'ELEVENLABS_API_KEY'},aiawaaz:{key:'AIAWAAZ_API_KEY',url:'AIAWAAZ_MCP_URL'}};
const env=n=>String(process.env[n]||'').trim();

// Credentials from a settings document (sync; used by mediaMeta too).
export function ttsCredentialsFrom(settings){
  const s=settings?.secrets||{};
  return {
    azure:{key:decryptSecret(s.azureSpeechKey)||env(ENV.azure.key),region:String(s.azureSpeechRegion||env(ENV.azure.region)||'').trim()},
    google:{key:decryptSecret(s.googleTtsKey)||env(ENV.google.key)},
    elevenlabs:{key:decryptSecret(s.elevenlabsKey)||env(ENV.elevenlabs.key)},
    aiawaaz:{key:decryptSecret(s.aiawaazKey)||env(ENV.aiawaaz.key),url:String(s.aiawaazUrl||env(ENV.aiawaaz.url)||DEFAULT_MCP_TTS_URL),tool:String(s.aiawaazTool||''),enhance:s.aiawaazEnhance===true}
  };
}
export function ttsKeyStatus(settings){
  const c=ttsCredentialsFrom(settings);const s=settings?.secrets||{};
  return {
    azure:{hasKey:Boolean(c.azure.key),region:c.azure.region,fromEnv:!s.azureSpeechKey&&Boolean(env(ENV.azure.key))},
    google:{hasKey:Boolean(c.google.key),fromEnv:!s.googleTtsKey&&Boolean(env(ENV.google.key))},
    elevenlabs:{hasKey:Boolean(c.elevenlabs.key),fromEnv:!s.elevenlabsKey&&Boolean(env(ENV.elevenlabs.key))},
    aiawaaz:{hasKey:Boolean(c.aiawaaz.key),url:c.aiawaaz.url,tool:c.aiawaaz.tool,enhance:c.aiawaaz.enhance,fromEnv:!s.aiawaazKey&&Boolean(env(ENV.aiawaaz.key))}
  };
}
export async function getTtsCredentials(){return ttsCredentialsFrom(await AISettings.findOne({key:'global'}).lean());}
// Blank values keep what is saved; clear:true removes a key.
export async function saveTtsKeys(input={}){
  const set={},unset={};
  const put=(field,value,clear)=>{const v=typeof value==='string'?value.trim().replace(/^["'`]+|["'`]+$/g,'').trim():'';if(clear)unset[`secrets.${field}`]=1;else if(v)set[`secrets.${field}`]=encryptSecret(v.slice(0,500));};
  put('azureSpeechKey',input.azure?.key,input.azure?.clear);
  if(typeof input.azure?.region==='string'){const r=input.azure.region.trim().toLowerCase();if(r&&!/^[a-z0-9]{3,40}$/.test(r))throw Object.assign(new Error('Azure region looks wrong (e.g. centralindia, eastus).'),{status:400});set['secrets.azureSpeechRegion']=r;}
  put('googleTtsKey',input.google?.key,input.google?.clear);
  put('elevenlabsKey',input.elevenlabs?.key,input.elevenlabs?.clear);
  put('aiawaazKey',input.aiawaaz?.key,input.aiawaaz?.clear);
  if(typeof input.aiawaaz?.url==='string'){const u=input.aiawaaz.url.trim();if(u&&!/^https:\/\/[^\s]+$/i.test(u))throw Object.assign(new Error('The MCP URL must start with https://'),{status:400});set['secrets.aiawaazUrl']=u||DEFAULT_MCP_TTS_URL;}
  if(typeof input.aiawaaz?.tool==='string')set['secrets.aiawaazTool']=input.aiawaaz.tool.trim().slice(0,120);
  if(typeof input.aiawaaz?.enhance==='boolean')set['secrets.aiawaazEnhance']=input.aiawaaz.enhance;
  const update={...(Object.keys(set).length?{$set:set}:{}),...(Object.keys(unset).length?{$unset:unset}:{})};
  if(Object.keys(update).length)await AISettings.updateOne({key:'global'},update,{upsert:true});
}
