import express from 'express'; import cors from 'cors'; import pinoHttp from 'pino-http'; import path from 'node:path';
import {env} from './config/env.js'; import {cleanupExpiredVideos} from './services/video/videoCleanup.js'; import {connectDb} from './config/db.js'; import agentRoutes from './routes/agentRoutes.js'; import videoRoutes from './routes/videoRoutes.js'; import seriesRoutes from './routes/seriesRoutes.js'; import aiRoutes from './routes/aiRoutes.js'; import youtubeSkillsRoutes from './routes/youtubeSkillsRoutes.js'; import youtubeRoutes from './routes/youtubeRoutes.js'; import {startWorker,currentWorkerJob} from './workers/worker.js'; import {installCrashLog} from './utils/crashLog.js';
const app=express(); app.disable('x-powered-by'); app.use(cors()); app.use(express.json({limit:'2mb'})); app.use(pinoHttp({serializers:{req:r=>({method:r.method,url:String(r.url||'').replace(/([?&](code|state)=)[^&]*/g,'$1[redacted]')})}}));
app.get('/api/health',(_req,res)=>res.json({ok:true,service:'youtube-ai-agent',version:'1.5.0',mediaMock:env.mediaMock,openaiConfigured:Boolean(env.openaiKey)}));
app.use('/storage',express.static(path.resolve('storage'))); app.use('/api/agent',agentRoutes); app.use('/api/videos',videoRoutes); app.use('/api/series',seriesRoutes); app.use('/api/ai',aiRoutes); app.use('/api/youtube-skills',youtubeSkillsRoutes); app.use('/api/youtube',youtubeRoutes);
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:err.message||'Internal server error'});});
installCrashLog(path.resolve(process.cwd(),'storage'),{getContext:()=>({activeJobId:currentWorkerJob()})});
connectDb().then(()=>{
  // Bind the port FIRST. A second backend instance (for example a second
  // `npm run dev`) then exits on EADDRINUSE before it can touch jobs or files,
  // instead of running the worker/recovery against another instance's live job.
  const server=app.listen(env.port);
  server.on('error',error=>{
    if(error.code==='EADDRINUSE') console.error(`Port ${env.port} is already in use. Another YouTube AI Agent backend is probably running; stop it first. This instance will exit without starting the worker.`);
    else console.error('API server failed to start:',error);
    process.exit(1);
  });
  server.on('listening',async()=>{
    console.log(`YouTube AI Agent API listening on ${env.port}`);
    try { const cleanup=await cleanupExpiredVideos(); console.log(`Video retention cleanup: ${cleanup.deleted||0} deleted, ${cleanup.candidates||0} candidates.`); } catch (e) { console.error('Initial video retention cleanup failed:', e.message); }
    setInterval(async()=>{ try { const cleanup=await cleanupExpiredVideos(); if(cleanup.deleted) console.log(`Video retention cleanup: ${cleanup.deleted} deleted.`); } catch(e) { console.error('Scheduled video retention cleanup failed:',e.message); } }, 24*60*60*1000).unref();
    startWorker();
  });
}).catch(e=>{console.error(e);process.exit(1);});
