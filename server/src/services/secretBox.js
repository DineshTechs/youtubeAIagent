// Encrypts secrets (YouTube client secrets, OAuth tokens) before they are stored
// in MongoDB. Key: APP_SECRET_KEY from the environment if set, otherwise a random
// key generated once in server/storage/.keys/app-secret.key (git-ignored, and
// dot-folders are never served by /storage).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const serverRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const DEFAULT_KEY_FILE=path.join(serverRoot,'storage','.keys','app-secret.key');
let cachedKey=null;

export function loadKey({envKey=process.env.APP_SECRET_KEY,keyFile=DEFAULT_KEY_FILE}={}){
  if(envKey&&String(envKey).trim())return crypto.createHash('sha256').update(String(envKey).trim()).digest();
  try{const hex=fs.readFileSync(keyFile,'utf8').trim();if(/^[0-9a-f]{64}$/i.test(hex))return Buffer.from(hex,'hex');}catch{}
  const hex=crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(keyFile),{recursive:true});
  fs.writeFileSync(keyFile,hex,{encoding:'utf8',mode:0o600,flag:'wx'});
  return Buffer.from(hex,'hex');
}
function key(){return cachedKey||(cachedKey=loadKey());}
export function _setKeyForTests(k){cachedKey=k;}

export function encryptSecret(value,k=key()){
  if(value==null||value==='')return null;
  const iv=crypto.randomBytes(12);
  const c=crypto.createCipheriv('aes-256-gcm',k,iv);
  const data=Buffer.concat([c.update(typeof value==='string'?value:JSON.stringify(value),'utf8'),c.final()]);
  return {v:1,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64'),json:typeof value!=='string'};
}
// Returns null when the value is missing or cannot be decrypted (e.g. the key changed).
export function decryptSecret(box,k=key()){
  if(!box||typeof box!=='object'||!box.data)return null;
  try{
    const d=crypto.createDecipheriv('aes-256-gcm',k,Buffer.from(box.iv,'base64'));
    d.setAuthTag(Buffer.from(box.tag,'base64'));
    const text=Buffer.concat([d.update(Buffer.from(box.data,'base64')),d.final()]).toString('utf8');
    return box.json?JSON.parse(text):text;
  }catch{return null;}
}
