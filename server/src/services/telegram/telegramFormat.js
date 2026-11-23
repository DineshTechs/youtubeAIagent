// Pure helpers for Telegram notifications (no database access).
import {decryptSecret} from '../secretBox.js';

export const EVENTS=[
  {id:'queued',label:'Video creation started',icon:'🎬',default:true},
  {id:'ready',label:'Ready for review / approval',icon:'✅',default:true},
  {id:'failed',label:'Generation failed or interrupted',icon:'❌',default:true},
  {id:'cancelled',label:'Generation cancelled',icon:'⏹',default:false},
  {id:'retried',label:'Generation continued / re-rendered',icon:'🔁',default:false},
  {id:'approved',label:'Video approved',icon:'👍',default:true},
  {id:'deleted',label:'Video deleted',icon:'🗑',default:true},
  {id:'uploaded',label:'Uploaded / scheduled on YouTube',icon:'📺',default:true},
  {id:'uploadFailed',label:'YouTube upload failed',icon:'⚠️',default:true},
  {id:'autopilot',label:'Autopilot problems (failed or needs attention)',icon:'🤖',default:true}
];
const EVENT_IDS=new Set(EVENTS.map(e=>e.id));
export function eventSettings(saved={}){return Object.fromEntries(EVENTS.map(e=>[e.id,typeof saved?.[e.id]==='boolean'?saved[e.id]:e.default]));}

export const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const TITLES={queued:'Video creation started',ready:'Ready for review',failed:'Generation failed',cancelled:'Generation cancelled',retried:'Generation continued',approved:'Video approved',deleted:'Video deleted',uploaded:'Uploaded to YouTube',uploadFailed:'YouTube upload failed',autopilot:'Autopilot needs attention'};

export function formatMessage(event,c={}){
  const ev=EVENTS.find(e=>e.id===event);
  let head=`${ev?.icon||'ℹ️'} <b>${esc(TITLES[event]||event)}</b>`;
  if(event==='uploaded'&&c.scheduledAt)head=`🗓 <b>Scheduled on YouTube</b>`;
  const lines=[head];
  if(c.title)lines.push(`<b>${esc(c.title)}</b>`);
  const meta=[c.profileName&&`Profile: ${esc(c.profileName)}`,c.topic&&`Topic: ${esc(String(c.topic).slice(0,120))}`,c.durationSec&&`${Math.round(c.durationSec)} s`,c.qaScore!=null&&`QA ${c.qaScore}/100`,c.seoScore!=null&&`SEO ${c.seoScore}/100`].filter(Boolean);
  if(meta.length)lines.push(meta.join(' · '));
  if(event==='ready')lines.push('Open the dashboard to complete the visual review and approve.');
  if(event==='uploaded'){
    if(c.channelTitle)lines.push(`Channel: ${esc(c.channelTitle)}${c.privacyStatus&&!c.scheduledAt?` · ${esc(c.privacyStatus)}`:''}`);
    if(c.scheduledAt)lines.push(`Goes public: ${esc(new Date(c.scheduledAt).toLocaleString('en-IN',{timeZone:c.timezone||'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'}))}`);
    if(c.url)lines.push(esc(c.url));
  }
  if(c.message&&['failed','cancelled','uploadFailed','retried','autopilot'].includes(event))lines.push(`<i>${esc(String(c.message).slice(0,600))}</i>`);
  return lines.join('\n');
}

// Should this event be sent, given the profile's Telegram settings?
export function shouldSend(settings,event){
  return Boolean(settings?.enabled&&EVENT_IDS.has(event)&&eventSettings(settings.events)[event]&&(settings.chats||[]).length);
}

export function publicSettings(doc={}){
  const d=doc||{};
  return {enabled:Boolean(d.enabled),hasToken:Boolean(d.botToken),tokenUnreadable:Boolean(d.botToken)&&!decryptSecret(d.botToken),botUsername:d.botUsername||'',
    chats:(d.chats||[]).map(c=>({chatId:String(c.chatId),title:c.title||'',type:c.type||''})),events:eventSettings(d.events),eventCatalog:EVENTS.map(({id,label,icon})=>({id,label,icon})),
    sendVideoOnReady:d.sendVideoOnReady!==false,commandsEnabled:d.commandsEnabled===true,lastError:d.lastError||'',lastSentAt:d.lastSentAt||null};
}

