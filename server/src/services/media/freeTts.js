// Narration providers with free tiers and good Hindi support. All return MP3 bytes.
//   azure       Microsoft Azure AI Speech (Free F0 tier: 0.5M neural characters / month)
//   google      Google Cloud Text-to-Speech (WaveNet/Standard: 4M characters free / month; billing must be enabled)
//   elevenlabs  ElevenLabs (free plan: 10k credits / month, non-commercial, attribution required)
export const FREE_TTS_PROVIDERS=['azure','google','elevenlabs'];
export const FREE_TTS_DEFAULTS={
  azure:{model:'neural',voice:'hi-IN-SwaraNeural'},
  google:{model:'wavenet',voice:'hi-IN-Wavenet-A'},
  elevenlabs:{model:'eleven_multilingual_v2',voice:'JBFqnCBsd6RMkjVDRZzb'}
};
export class TtsError extends Error{constructor(provider,message,status){super(`${provider} TTS: ${message}`);this.status=status;}}
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export const localeOfVoice=v=>{const m=/^([a-z]{2,3}-[A-Z]{2})-/.exec(String(v||''));return m?m[1]:'';};
async function failure(provider,r){
  let detail='';try{const t=await r.text();try{const j=JSON.parse(t);detail=j?.error?.message||j?.detail?.message||j?.detail||j?.message||t;}catch{detail=t;}}catch{}
  return new TtsError(provider,`HTTP ${r.status}${detail?` — ${String(typeof detail==='string'?detail:JSON.stringify(detail)).slice(0,300)}`:''}`,r.status);
}

// Split long text at sentence ends (Hindi danda "।" included) so each request stays under `maxBytes`.
export function chunkText(text,maxBytes=4500){
  const sentences=String(text||'').replace(/\s+/g,' ').trim().split(/(?<=[.!?।॥])\s+/);
  const out=[];let cur='';
  for(const s of sentences){
    const next=cur?`${cur} ${s}`:s;
    if(Buffer.byteLength(next,'utf8')<=maxBytes){cur=next;continue;}
    if(cur)out.push(cur);
    if(Buffer.byteLength(s,'utf8')<=maxBytes){cur=s;continue;}
    let part='';for(const w of s.split(' ')){const n=part?`${part} ${w}`:w;if(Buffer.byteLength(n,'utf8')>maxBytes){if(part)out.push(part);part=w;}else part=n;}
    cur=part;
  }
  if(cur)out.push(cur);
  return out;
}

export async function azureSpeech({key,region,voice,text,rate},fetchImpl=fetch){
  if(!key||!region)throw new TtsError('Azure','add the Speech key and region in Settings → Narration.',401);
  const v=voice||FREE_TTS_DEFAULTS.azure.voice;const lang=localeOfVoice(v)||'hi-IN';
  const parts=[];
  for(const chunk of chunkText(text,3000)){
    const body=`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${xml(v)}">${rate?`<prosody rate="${xml(rate)}">`:''}${xml(chunk)}${rate?'</prosody>':''}</voice></speak>`;
    const r=await fetchImpl(`https://${encodeURIComponent(region)}.tts.speech.microsoft.com/cognitiveservices/v1`,{method:'POST',headers:{'Ocp-Apim-Subscription-Key':key,'Content-Type':'application/ssml+xml','X-Microsoft-OutputFormat':'audio-24khz-48kbitrate-mono-mp3','User-Agent':'youtube-ai-agent'},body});
    if(!r.ok)throw await failure('Azure',r);
    parts.push(Buffer.from(await r.arrayBuffer()));
  }
  return Buffer.concat(parts);
}
export async function googleTts({key,voice,text,speakingRate},fetchImpl=fetch){
  if(!key)throw new TtsError('Google','add the Cloud Text-to-Speech API key in Settings → Narration.',401);
  const v=voice||FREE_TTS_DEFAULTS.google.voice;const languageCode=localeOfVoice(v)||'hi-IN';
  const parts=[];
  for(const chunk of chunkText(text,4500)){
    const r=await fetchImpl(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:{text:chunk},voice:{languageCode,name:v},audioConfig:{audioEncoding:'MP3',...(speakingRate?{speakingRate}:{})}})});
    if(!r.ok)throw await failure('Google',r);
    const j=await r.json();if(!j.audioContent)throw new TtsError('Google','no audio returned.');
    parts.push(Buffer.from(j.audioContent,'base64'));
  }
  return Buffer.concat(parts);
}
export async function elevenLabsTts({key,voice,model,text},fetchImpl=fetch){
  if(!key)throw new TtsError('ElevenLabs','add the API key in Settings → Narration.',401);
  const parts=[];
  for(const chunk of chunkText(text,9000)){
    const r=await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice||FREE_TTS_DEFAULTS.elevenlabs.voice)}?output_format=mp3_44100_128`,{method:'POST',headers:{'xi-api-key':key,'Content-Type':'application/json',Accept:'audio/mpeg'},body:JSON.stringify({text:chunk,model_id:model||FREE_TTS_DEFAULTS.elevenlabs.model})});
    if(!r.ok)throw await failure('ElevenLabs',r);
    parts.push(Buffer.from(await r.arrayBuffer()));
  }
  return Buffer.concat(parts);
}

// Real voice lists from each provider (filtered by language prefix, e.g. "hi").
export async function listVoices(provider,creds,{language='hi'}={},fetchImpl=fetch){
  const lang=String(language||'').toLowerCase();
  if(provider==='azure'){
    if(!creds.key||!creds.region)throw new TtsError('Azure','add the Speech key and region first.',401);
    const r=await fetchImpl(`https://${encodeURIComponent(creds.region)}.tts.speech.microsoft.com/cognitiveservices/voices/list`,{headers:{'Ocp-Apim-Subscription-Key':creds.key}});
    if(!r.ok)throw await failure('Azure',r);
    return (await r.json()).filter(v=>!lang||String(v.Locale).toLowerCase().startsWith(lang)).map(v=>({id:v.ShortName,name:`${v.LocalName||v.DisplayName} (${v.Gender}, ${v.Locale})`,locale:v.Locale}));
  }
  if(provider==='google'){
    if(!creds.key)throw new TtsError('Google','add the API key first.',401);
    const r=await fetchImpl(`https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(creds.key)}${lang?`&languageCode=${encodeURIComponent(lang==='hi'?'hi-IN':lang)}`:''}`);
    if(!r.ok)throw await failure('Google',r);
    return ((await r.json()).voices||[]).map(v=>({id:v.name,name:`${v.name} (${String(v.ssmlGender||'').toLowerCase()})`,locale:(v.languageCodes||[])[0]||''})).sort((a,b)=>a.id.localeCompare(b.id));
  }
  if(provider==='elevenlabs'){
    if(!creds.key)throw new TtsError('ElevenLabs','add the API key first.',401);
    const r=await fetchImpl('https://api.elevenlabs.io/v1/voices',{headers:{'xi-api-key':creds.key}});
    if(!r.ok)throw await failure('ElevenLabs',r);
    return ((await r.json()).voices||[]).map(v=>({id:v.voice_id,name:`${v.name}${v.labels?.accent?` (${v.labels.accent})`:''}`,locale:'multilingual'}));
  }
  throw new TtsError(provider,'voice listing not supported.');
}

export async function synthesizeFree(provider,{creds,voice,model,text},fetchImpl=fetch){
  if(provider==='azure')return azureSpeech({key:creds.key,region:creds.region,voice,text},fetchImpl);
  if(provider==='google')return googleTts({key:creds.key,voice,text},fetchImpl);
  if(provider==='elevenlabs')return elevenLabsTts({key:creds.key,voice,model,text},fetchImpl);
  throw new TtsError(provider,'unsupported provider.');
}
