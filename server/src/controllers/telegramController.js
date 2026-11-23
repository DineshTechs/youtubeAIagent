import {getSettings,updateSettings,detectChats,sendTest,copyFrom} from '../services/telegram/notifier.js';
const fail=(res,next,e)=>e.status?res.status(e.status).json({error:e.message}):next(e);
export async function get(req,res,next){try{res.json(await getSettings(req.params.seriesId));}catch(e){fail(res,next,e);}}
export async function put(req,res,next){try{res.json(await updateSettings(req.params.seriesId,req.body||{}));}catch(e){fail(res,next,e);}}
export async function detect(req,res,next){try{res.json({chats:await detectChats(req.params.seriesId)});}catch(e){fail(res,next,e);}}
export async function test(req,res,next){try{res.json({results:await sendTest(req.params.seriesId)});}catch(e){fail(res,next,e);}}
export async function copy(req,res,next){try{res.json(await copyFrom(req.params.seriesId,req.params.sourceId));}catch(e){fail(res,next,e);}}
