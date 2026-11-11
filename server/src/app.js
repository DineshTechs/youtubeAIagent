import express from 'express'; import cors from 'cors'; import pinoHttp from 'pino-http'; import path from 'node:path';
import {env} from './config/env.js'; import {cleanupExpiredVideos} from './services/video/videoCleanup.js'; import {connectDb} from './config/db.js'; import agentRoutes from './routes/agentRoutes.js'; import videoRoutes from './routes/videoRoutes.js'; import seriesRoutes from './routes/seriesRoutes.js'; import aiRoutes from './routes/aiRoutes.js'; import youtubeSkillsRoutes from './routes/youtubeSkillsRoutes.js'; import {startWorker} from './workers/worker.js';
const app=express(); app.disable('x-powered-by'); app.use(cors()); app.use(express.json({limit:'2mb'})); app.use(pinoHttp());
app.get('/api/health',(_req,res)=>res.json({ok:true,service:'youtube-ai-agent',version:'1.5.0',mediaMock:env.mediaMock,openaiConfigured:Boolean(env.openaiKey)}));
app.use('/storage',express.static(path.resolve('storage'))); app.use('/api/agent',agentRoutes); app.use('/api/videos',videoRoutes); app.use('/api/series',seriesRoutes); app.use('/api/ai',aiRoutes); app.use('/api/youtube-skills',youtubeSkillsRoutes);
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:err.message||'Internal server error'});});
connectDb().then(async()=>{
  try { const cleanup=await cleanupExpiredVideos(); console.log(`Video retention cleanup: ${cleanup.deleted||0} deleted, ${cleanup.candidates||0} candidates.`); } catch (e) { console.error('Initial video retention cleanup failed:', e.message); }
  setInterval(async()=>{ try { const cleanup=await cleanupExpiredVideos(); if(cleanup.deleted) console.log(`Video retention cleanup: ${cleanup.deleted} deleted.`); } catch(e) { console.error('Scheduled video retention cleanup failed:',e.message); } }, 24*60*60*1000).unref();
  startWorker();app.listen(env.port,()=>console.log(`YouTube AI Agent API listening on ${env.port}`));
}).catch(e=>{console.error(e);process.exit(1);});
