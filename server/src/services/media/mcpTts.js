// Narration through a remote MCP server (Model Context Protocol, Streamable HTTP),
// e.g. AI Awaaz: https://app.aiawaaz.io/api/mcp  (auth: "Authorization: Bearer <key>";
// tools: generate_speech → MP3 link (≤5,000 characters per call), list_voices, enhance_for_v3, get_account)
// The server's tools are discovered with tools/list; the text-to-speech tool and its
// argument names (text / voice / language …) are detected from the tool schemas.
import {describeNetworkError,isRetryableNetworkError} from '../../utils/networkError.js';
export const DEFAULT_MCP_TTS_URL='https://app.aiawaaz.io/api/mcp';
export const MAX_CHARS_PER_CALL=4800; // AI Awaaz: up to 5,000 characters per generate_speech call

// Splits text at sentence ends (incl. Hindi danda) into pieces of at most `max` characters.
export function splitByChars(text,max=MAX_CHARS_PER_CALL){
  const t=String(text||'').replace(/\s+/g,' ').trim();if(t.length<=max)return t?[t]:[];
  const out=[];let cur='';
  for(const s of t.split(/(?<=[.!?।॥])\s+/)){
    if(s.length>max){if(cur){out.push(cur);cur='';}for(let i=0;i<s.length;i+=max)out.push(s.slice(i,i+max));continue;}
    const next=cur?`${cur} ${s}`:s;if(next.length>max){out.push(cur);cur=s;}else cur=next;
  }
  if(cur)out.push(cur);return out;
}
const PROTOCOL_VERSION='2025-06-18';
export class McpError extends Error{constructor(message,status){super(`AI Awaaz (MCP): ${message}`);this.status=status;}}

// Parses a JSON-RPC reply sent as JSON or as an SSE stream ("data: {...}").
export function parseRpcBody(text,contentType=''){
  const t=String(text||'').trim();
  if(!t)return null;
  if(/event-stream/i.test(contentType)||/^(event|data):/m.test(t)){
    const msgs=t.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).filter(Boolean).map(d=>{try{return JSON.parse(d);}catch{return null;}}).filter(Boolean);
    return msgs.find(m=>m.result!==undefined||m.error)||msgs.at(-1)||null;
  }
  try{return JSON.parse(t);}catch{throw new McpError(`unexpected reply: ${t.slice(0,200)}`);}
}

// How long to wait after HTTP 429/503: the server's Retry-After (seconds or a date), else 2s, 4s, 8s…
export function retryDelayMs(retryAfter,attempt,{maxMs=60000}={}){
  const v=String(retryAfter??'').trim();
  let ms=null;
  if(/^\d+(\.\d+)?$/.test(v))ms=Number(v)*1000;
  else if(v){const t=Date.parse(v);if(!Number.isNaN(t))ms=Math.max(0,t-Date.now());}
  if(ms===null)ms=2000*2**attempt;
  return Math.min(Math.max(ms,500),maxMs);
}
const defaultSleep=ms=>new Promise(r=>setTimeout(r,ms));

export function createMcpClient({url=DEFAULT_MCP_TTS_URL,apiKey,maxRetries=3,sleep=defaultSleep,onRequest}={},fetchImpl=fetch){
  let sessionId=null,nextId=1,ready=null;
  async function post(body,{notify=false}={}){
    const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':PROTOCOL_VERSION};
    if(apiKey)headers.Authorization=`Bearer ${String(apiKey).replace(/^Bearer\s+/i,'')}`;
    for(let attempt=0;;attempt++){
      if(sessionId)headers['Mcp-Session-Id']=sessionId;
      onRequest?.(body.method);
      let r;try{r=await fetchImpl(url,{method:'POST',headers,body:JSON.stringify(body)});}catch(e){
        // Retry short network hiccups; otherwise say what actually went wrong (DNS, firewall, certificate…).
        if(isRetryableNetworkError(e)&&attempt<Math.min(maxRetries,2)){await sleep(retryDelayMs(null,attempt));continue;}
        throw new McpError(describeNetworkError(e,url));
      }
      const sid=r.headers?.get?.('mcp-session-id');if(sid)sessionId=sid;
      if(r.status===429||r.status===503){
        const retryAfter=r.headers?.get?.('retry-after');
        if(attempt<maxRetries){await sleep(retryDelayMs(retryAfter,attempt));continue;}
        const wait=Math.ceil(retryDelayMs(retryAfter,attempt)/1000);
        const e=new McpError(`rate limit reached (HTTP ${r.status} Too Many Requests) after ${maxRetries+1} tries. AI Awaaz is limiting how fast this key can send requests — wait about ${wait} seconds and try again, or check your plan's limits.`,429);
        e.retryAfterSeconds=wait;throw e;
      }
      if(notify)return null;
      const text=await r.text();
      if(r.status===401||r.status===403)throw new McpError(`the API key was rejected (HTTP ${r.status}). Check the AI Awaaz key in Settings → Narration.`,r.status);
      if(r.status===404&&sessionId){const e=new McpError('the session expired.',404);e.sessionExpired=true;throw e;}
      if(!r.ok)throw new McpError(`HTTP ${r.status}: ${text.slice(0,300)}`,r.status);
      const msg=parseRpcBody(text,r.headers?.get?.('content-type')||'');
      if(msg?.error){if(/session/i.test(msg.error.message||'')&&sessionId){const e=new McpError(msg.error.message,400);e.sessionExpired=true;throw e;}throw new McpError(msg.error.message||JSON.stringify(msg.error));}
      return msg?.result;
    }
  }
  async function init(){
    if(!ready)ready=(async()=>{
      const res=await post({jsonrpc:'2.0',id:nextId++,method:'initialize',params:{protocolVersion:PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'youtube-ai-agent',version:'1.0'}}});
      await post({jsonrpc:'2.0',method:'notifications/initialized'},{notify:true}).catch(()=>{});
      return res;
    })().catch(e=>{ready=null;throw e;});
    return ready;
  }
  return {
    async listTools(){await init();const out=[];let cursor;do{const r=await post({jsonrpc:'2.0',id:nextId++,method:'tools/list',params:cursor?{cursor}:{}});out.push(...(r?.tools||[]));cursor=r?.nextCursor;}while(cursor&&out.length<500);return out;},
    async callTool(name,args){await init();const r=await post({jsonrpc:'2.0',id:nextId++,method:'tools/call',params:{name,arguments:args}});if(r?.isError)throw new McpError(textOf(r)||`tool ${name} failed`);return r;},
    get sessionId(){return sessionId;}
  };
}

// One shared session per server + key: connecting and listing tools happens once,
// not before every scene. Calls go one at a time with a small gap between them.
const TOOLS_TTL_MS=10*60*1000;
export const MIN_GAP_MS=400;
const sessions=new Map();
let queue=Promise.resolve(),lastCallAt=0;
export function resetMcpSessions(){sessions.clear();describeCache.clear();queue=Promise.resolve();lastCallAt=0;}
function serialized(fn,{sleep=defaultSleep,gapMs=MIN_GAP_MS}={}){
  const run=queue.then(async()=>{const wait=lastCallAt+gapMs-Date.now();if(wait>0)await sleep(wait);try{return await fn();}finally{lastCallAt=Date.now();}});
  queue=run.catch(()=>{});
  return run;
}
async function session({url=DEFAULT_MCP_TTS_URL,apiKey,...opts},fetchImpl,{fresh=false}={}){
  const key=`${url}|${String(apiKey).replace(/^Bearer\s+/i,'')}`;
  let s=sessions.get(key);
  if(fresh||!s||s.fetchImpl!==fetchImpl){s={client:createMcpClient({url,apiKey,...opts},fetchImpl),fetchImpl,tools:null,toolsAt:0};sessions.set(key,s);}
  if(!s.tools||Date.now()-s.toolsAt>TOOLS_TTL_MS){s.tools=await s.client.listTools();s.toolsAt=Date.now();}
  return s;
}
// Runs work with the shared session; if the server dropped the session, reconnects once.
async function withSession(cfg,fetchImpl,work){
  return serialized(async()=>{
    try{return await work(await session(cfg,fetchImpl));}
    catch(e){if(!e.sessionExpired)throw e;return work(await session(cfg,fetchImpl,{fresh:true}));}
  },{sleep:cfg.sleep,gapMs:cfg.gapMs});
}

const textOf=r=>(r?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join(' ').trim();
const props=t=>Object.keys(t?.inputSchema?.properties||{});
const pick=(names,re)=>names.find(n=>re.test(n));

// The tool that turns text into speech, and how to fill its arguments.
export function findTtsTool(tools=[],preferred=''){
  if(preferred){const t=tools.find(x=>x.name===preferred);if(t)return t;}
  const score=t=>{const n=`${t.name} ${t.description||''}`.toLowerCase();const p=props(t);let s=0;
    if(/text[_\s-]?to[_\s-]?speech|\btts\b|synthes|voice[_\s-]?over|generate[_\s-]?(speech|audio|voice)|speak/.test(n))s+=5;
    if(pick(p,/^(text|input|script|content|prompt|message)$/i))s+=3;
    if(/list|search|get[_\s-]?voices|clone|transcri|speech[_\s-]?to[_\s-]?text|stt/.test(t.name.toLowerCase()))s-=6;
    return s;};
  return [...tools].sort((a,b)=>score(b)-score(a)).find(t=>score(t)>=5)||null;
}
export function findAccountTool(tools=[]){return tools.find(t=>/(get[_\s-]?)?(account|usage|credits?|balance|quota)/i.test(t.name))||null;}
export function findEnhanceTool(tools=[]){return tools.find(t=>/enhance|emotion/i.test(t.name))||null;}
export function findVoicesTool(tools=[]){return tools.find(t=>/(list|get|search)[_\s-]?voices?|voices?[_\s-]?(list|catalog)/i.test(t.name))||null;}
export function buildTtsArgs(tool,{text,voice,language,speed}){
  const p=props(tool);const args={};
  const textKey=pick(p,/^(text|input|script|content|prompt|message)$/i)||'text';args[textKey]=text;
  const voiceKey=pick(p,/^(voice|voice_?id|voiceId|voice_?name|speaker|speaker_?id)$/i);if(voiceKey&&voice)args[voiceKey]=voice;
  const langKey=pick(p,/^(language|lang|language_?code|languageCode|locale)$/i);if(langKey&&language)args[langKey]=language;
  const fmtKey=pick(p,/^(format|output_?format|audio_?format|response_?format)$/i);if(fmtKey){const en=tool.inputSchema.properties[fmtKey]?.enum;args[fmtKey]=!en||en.includes('mp3')?'mp3':en[0];}
  const speedKey=pick(p,/^(speed|rate|speaking_?rate)$/i);if(speedKey&&speed)args[speedKey]=speed;
  return args;
}
// Extracts audio from a tools/call result: inline audio, an embedded resource, base64 in JSON, or a download URL.
export async function audioFromResult(result,fetchImpl=fetch,{mcpUrl}={}){
  const content=result?.content||[];
  for(const c of content){
    if(c.type==='audio'&&c.data)return Buffer.from(c.data,'base64');
    if(c.type==='resource'&&c.resource?.blob)return Buffer.from(c.resource.blob,'base64');
  }
  const candidates=[result?.structuredContent,...content.filter(c=>c.type==='text').map(c=>{try{return JSON.parse(c.text);}catch{return c.text;}}),...content.filter(c=>c.type==='resource_link'||c.type==='resource').map(c=>c.uri||c.resource?.uri)];
  for(const c of candidates){
    if(!c)continue;
    if(typeof c==='object'){
      const b64=c.audio||c.audio_base64||c.audioContent||c.data;
      if(typeof b64==='string'&&b64.length>200&&/^[A-Za-z0-9+/=\s]+$/.test(b64.slice(0,200)))return Buffer.from(b64.replace(/^data:audio\/[a-z0-9.+-]+;base64,/i,''),'base64');
      const url=c.url||c.audio_url||c.audioUrl||c.download_url||c.downloadUrl||c.file_url||c.link;
      if(typeof url==='string'&&/^https?:\/\//.test(url))return download(url,fetchImpl,mcpUrl);
    }
    if(typeof c==='string'){
      const data=/data:audio\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/i.exec(c);if(data)return Buffer.from(data[1],'base64');
      const url=/(https?:\/\/[^\s"'<>)]+\.(?:mp3|wav|m4a|ogg|aac)(?:\?[^\s"'<>)]*)?)/i.exec(c)||/(https?:\/\/[^\s"'<>)]+)/.exec(c);
      if(url)return download(url[1],fetchImpl,mcpUrl);
    }
  }
  throw new McpError(`the speech tool returned no audio (${textOf(result).slice(0,200)||'empty result'}).`);
}
// When the MCP URL is a relay (e.g. a Cloudflare Worker, for servers that cannot
// reach app.aiawaaz.io directly), AI Awaaz audio links go through the same relay:
//   https://relay/<secret>/api/mcp  +  https://app.aiawaaz.io/x.mp3  →  https://relay/<secret>/_host/app.aiawaaz.io/x.mp3
export function viaRelay(link,mcpUrl){
  try{
    const m=new URL(mcpUrl),u=new URL(link);
    if(/(^|\.)aiawaaz\.io$/i.test(m.hostname)||!/(^|\.)aiawaaz\.io$/i.test(u.hostname))return link;
    const base=`${m.origin}${m.pathname.replace(/\/api\/mcp\/?$/i,'').replace(/\/+$/,'')}`;
    return `${base}/_host/${u.host}${u.pathname}${u.search}`;
  }catch{return link;}
}
async function download(url,fetchImpl,mcpUrl){
  const target=mcpUrl?viaRelay(url,mcpUrl):url;
  let r;try{r=await fetchImpl(target);}catch(e){throw new McpError(`could not download the audio: ${describeNetworkError(e,target)}`);}
  if(!r.ok)throw new McpError(`could not download the audio (HTTP ${r.status}).`);
  return Buffer.from(await r.arrayBuffer());
}

// Optional: let the server add emotion tags (laughs, pauses…) for V3 voices. Falls back to the original text.
async function enhanceText(client,tool,text){
  try{
    const key=pick(props(tool),/^(text|input|script|content|prompt|message)$/i)||'text';
    const r=await client.callTool(tool.name,{[key]:text});
    const sc=r?.structuredContent;
    const out=(typeof sc==='string'?sc:sc?.text||sc?.enhanced_text||sc?.enhancedText||sc?.result)||(()=>{const t=textOf(r);try{const j=JSON.parse(t);return j.text||j.enhanced_text||j.enhancedText||j.result;}catch{return t;}})();
    return typeof out==='string'&&out.trim().length>=text.length*0.5?out.trim():text;
  }catch{return text;}
}
export async function mcpSynthesize({url,apiKey,tool:preferredTool,voice,language,text,enhance=false,sleep,gapMs},fetchImpl=fetch){
  if(!apiKey)throw new McpError('add your AI Awaaz API key in Settings → Narration.',401);
  return withSession({url,apiKey,sleep,gapMs},fetchImpl,async({client,tools})=>{
    const tool=findTtsTool(tools,preferredTool);
    if(!tool)throw new McpError(`no text-to-speech tool found. The server offers: ${tools.map(t=>t.name).join(', ')||'no tools'}.`);
    voice=await resolveVoice(client,tools,voice,language);
    const enhancer=enhance?findEnhanceTool(tools):null;
    const parts=[];
    for(const piece of splitByChars(text)){
      const spoken=enhancer?await enhanceText(client,enhancer,piece):piece;
      let result;
      try{result=await client.callTool(tool.name,buildTtsArgs(tool,{text:spoken,voice,language}));}
      catch(e){
        // A voice copied from another computer or typed by hand is often not a valid AI Awaaz voice id.
        if(/voice/i.test(String(e?.message||''))){
          const vp=tool.inputSchema?.properties||{};const vk=Object.keys(vp).find(k=>/voice|speaker/i.test(k));
          const expects=vk?` AI Awaaz expects "${vk}"${vp[vk]?.description?`: ${String(vp[vk].description).slice(0,200)}`:''}${Array.isArray(vp[vk]?.enum)?` (one of: ${vp[vk].enum.slice(0,12).join(', ')})`:''}.`:'';
          throw new McpError(`${e.message} The saved voice is ${voice?`"${voice}"`:'empty'}.${expects} In Settings → AI providers → Narration → AI Awaaz, click "Connect & load voices", pick a voice from the list and save.`,e.status);
        }
        throw e;
      }
      parts.push(await audioFromResult(result,fetchImpl,{mcpUrl:url}));
    }
    if(!parts.length)throw new McpError('nothing to speak.');
    return Buffer.concat(parts);
  });
}
// AI Awaaz wants the "voice" value from list_voices (e.g. "platform:5316"). A saved display
// name such as "Muskaan" is looked up in that list and swapped for its reference.
const voiceRefCache=new Map();
export function matchVoice(voices,wanted){
  const w=String(wanted||'').trim().toLowerCase();if(!w)return '';
  const name=v=>String(v.name||'').split(' · ')[0].trim().toLowerCase();
  return (voices.find(v=>String(v.id).toLowerCase()===w)||voices.find(v=>name(v)===w)||voices.find(v=>name(v).startsWith(w)))?.id||'';
}
async function resolveVoice(client,tools,voice,language){
  const v=String(voice||'').trim();
  if(!v||/^[a-z_-]+:\S+$/i.test(v))return v;                  // empty or already a reference
  const voicesTool=findVoicesTool(tools);if(!voicesTool)return v;
  const key=`${language}|${v}`;if(voiceRefCache.has(key))return voiceRefCache.get(key);
  try{const found=matchVoice(await listVoicesWith(client,voicesTool,language),v);if(found){voiceRefCache.set(key,found);return found;}}catch{}
  return v;
}
async function listVoicesWith(client,voicesTool,language){
  const args={};const lk=pick(props(voicesTool),/^(language|lang|language_?code|locale)$/i);if(lk)args[lk]=language;
  const r=await client.callTool(voicesTool.name,args);
  const data=r?.structuredContent||(()=>{try{return JSON.parse(textOf(r));}catch{return null;}})();
  const list=Array.isArray(data)?data:(data?.voices||data?.items||data?.data||[]);
  return list.map(v=>typeof v==='string'?{id:v,name:v}:{id:String((typeof v.voice==='string'&&v.voice)||v.voice_reference||v.voiceReference||v.voice_ref||v.voiceRef||v.reference||v.ref||v.voice_id||v.voiceId||v.id||v.uuid||v.slug||v.key||v.code||v.name||''),name:[v.name||v.display_name||v.id,v.language||v.lang||v.gender].filter(Boolean).join(' · ')}).filter(v=>v.id);
}
// For Settings: tools, the detected speech tool and (if available) voices.
// Repeated clicks on "Connect & load voices" within a minute reuse the last answer.
const DESCRIBE_TTL_MS=60*1000;const describeCache=new Map();
export async function mcpDescribe({url,apiKey,language='hi',sleep,gapMs,refresh=false},fetchImpl=fetch){
  if(!apiKey)throw new McpError('add your AI Awaaz API key first.',401);
  const key=`${url}|${apiKey}|${language}`;const hit=describeCache.get(key);
  if(!refresh&&hit&&hit.fetchImpl===fetchImpl&&Date.now()-hit.at<DESCRIBE_TTL_MS)return hit.value;
  const value=await withSession({url,apiKey,sleep,gapMs},fetchImpl,({client,tools})=>describeWith(client,tools,language));
  describeCache.set(key,{at:Date.now(),value,fetchImpl});
  return value;
}
async function describeWith(client,tools,language){
  const tts=findTtsTool(tools);const voicesTool=findVoicesTool(tools);const accountTool=findAccountTool(tools);
  let voices=[],account=null;
  if(accountTool){
    try{const r=await client.callTool(accountTool.name,{});const sc=r?.structuredContent;account=sc&&typeof sc==='object'?sc:(()=>{const t=textOf(r);try{return JSON.parse(t);}catch{return t;}})();}catch(e){account=`Could not read account: ${e.message}`;}
  }
  if(voicesTool){
    try{
      const args={};const lk=pick(props(voicesTool),/^(language|lang|language_?code|locale)$/i);if(lk)args[lk]=language;
      const r=await client.callTool(voicesTool.name,args);
      const data=r?.structuredContent||(()=>{try{return JSON.parse(textOf(r));}catch{return null;}})();
      const list=Array.isArray(data)?data:(data?.voices||data?.items||data?.data||[]);
      voices=list.map(v=>typeof v==='string'?{id:v,name:v}:{id:String((typeof v.voice==='string'&&v.voice)||v.voice_reference||v.voiceReference||v.voice_ref||v.voiceRef||v.reference||v.ref||v.voice_id||v.voiceId||v.id||v.uuid||v.slug||v.key||v.code||v.name||''),name:[v.name||v.display_name||v.id,v.language||v.lang||v.gender].filter(Boolean).join(' · ')}).filter(v=>v.id);
    }catch{}
  }
  return {tools:tools.map(t=>({name:t.name,description:String(t.description||'').slice(0,200),arguments:props(t)})),ttsTool:tts?.name||null,voicesTool:voicesTool?.name||null,enhanceTool:findEnhanceTool(tools)?.name||null,account,voices};
}
