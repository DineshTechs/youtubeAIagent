import fs from 'node:fs/promises';

let workerPromise=null;

const INTERNAL_INSTRUCTION_PATTERNS=[
  /\bmust\s+show\b/i,
  /\bshow\s+this\s+exact\b/i,
  /\bnarration\s+continuity\b/i,
  /\bvisual\s+director\b/i,
  /\bshot\s+plan\b/i,
  /\bscene\s*#?\s*\d+\b/i,
  /\bproduction\s+instruction/i,
  /\bimage\s+prompt\b/i,
  /\bcharacter\s+continuity\b/i
];

export function classifyImageText(text,{strict=false,minWords=4}={}){
  const normalized=String(text||'').replace(/\s+/g,' ').trim();
  if(!normalized) return {hasText:false,suspicious:false,reason:'no_text',text:''};
  const internal=INTERNAL_INSTRUCTION_PATTERNS.some(pattern=>pattern.test(normalized));
  const words=(normalized.match(/[A-Za-z]{2,}/g)||[]);
  const suspicious=internal || (strict && words.length>=minWords);
  return {
    hasText:true,
    suspicious,
    reason:internal?'internal_instruction_text':(suspicious?'unwanted_text':'possible_legitimate_text'),
    text:normalized.slice(0,1000),
    wordCount:words.length
  };
}

async function getWorker(){
  if(!workerPromise){
    workerPromise=(async()=>{
      const {createWorker}=await import('tesseract.js');
      const worker=await createWorker('eng');
      return worker;
    })().catch(error=>{workerPromise=null;throw error;});
  }
  return workerPromise;
}

export async function inspectImageText(imagePath,options={}){
  const stat=await fs.stat(imagePath);
  if(!stat.isFile()||stat.size<100) throw new Error('OCR received a missing or invalid image file.');
  const worker=await getWorker();
  const result=await worker.recognize(imagePath);
  const text=result?.data?.text||'';
  const confidence=Number(result?.data?.confidence||0);
  const classification=classifyImageText(text,options);
  // Low-confidence OCR is diagnostic only; do not trigger destructive retries.
  const suspicious=classification.suspicious && (confidence>=45 || /must\s+show|narration\s+continuity|visual\s+director/i.test(text));
  return {...classification,suspicious,confidence};
}

export async function terminateImageTextQa(){
  if(!workerPromise) return;
  try{const worker=await workerPromise;await worker.terminate();}catch{}
  workerPromise=null;
}
