import siteRoutes from './routes/siteRoutes.js';
import {createSecurity} from './security/httpSecurity.js'; import {loadKey} from './services/secretBox.js'; import {existsSync,statSync} from 'node:fs'; import {fileURLToPath} from 'node:url';
import {STARTED_AT,codeChangedSinceStart} from './utils/codeFreshness.js';
import express from 'express'; import pinoHttp from 'pino-http'; import path from 'node:path';
import {env} from './config/env.js'; import {cleanupExpiredVideos} from './services/video/videoCleanup.js'; import {connectDb} from './config/db.js'; import agentRoutes from './routes/agentRoutes.js'; import videoRoutes from './routes/videoRoutes.js'; import seriesRoutes from './routes/seriesRoutes.js'; import aiRoutes from './routes/aiRoutes.js'; import youtubeSkillsRoutes from './routes/youtubeSkillsRoutes.js'; import youtubeRoutes from './routes/youtubeRoutes.js'; import telegramRoutes from './routes/telegramRoutes.js'; import {startTelegramBots,setInternalServer} from './services/telegram/botRunner.js'; import autopilotRoutes from './routes/autopilotRoutes.js'; import trendRoutes from './routes/trendRoutes.js'; import {startAutopilot} from './services/autopilot/autopilotRunner.js'; import {startWorker,currentWorkerJob} from './workers/worker.js'; import {installCrashLog,installLifecycleLog} from './utils/crashLog.js';
// ---- security (login, headers, CORS); see src/security and DEPLOY.md ----
const security=createSecurity({appKey:loadKey()});
const app=express(); app.disable('x-powered-by');
if(security.config.production||process.env.TRUST_PROXY)app.set('trust proxy',Number(process.env.TRUST_PROXY||1)); // behind Apache/Passenger/Nginx: real client IP and https
app.use(security.headers); app.use(security.cors); app.use(express.json({limit:'2mb'})); app.use(pinoHttp({serializers:{req:r=>({method:r.method,url:String(r.url||'').replace(/([?&](code|state)=)[^&]*/g,'$1[redacted]')})}}));
app.use('/api/auth',security.router); app.use(security.protect);
// Without a login, /api/health only says the server is up (no details for strangers).
app.get('/api/health',(req,res)=>res.json(security.authenticated(req)?{ok:true,service:'youtube-ai-agent',version:'1.5.0',mediaMock:env.mediaMock,openaiConfigured:Boolean(env.openaiKey),startedAt:new Date(STARTED_AT).toISOString(),restartNeeded:codeChangedSinceStart(path.resolve(process.cwd(),'src')),authRequired:security.config.required}:{ok:true,authRequired:security.config.required}));
app.use('/api/site',siteRoutes); app.use('/storage',express.static(path.resolve('storage'),{dotfiles:'deny',index:false})); app.use('/api/agent',agentRoutes); app.use('/api/videos',videoRoutes); app.use('/api/series',seriesRoutes); app.use('/api/ai',aiRoutes); app.use('/api/youtube-skills',youtubeSkillsRoutes); app.use('/api/youtube',youtubeRoutes); app.use('/api/telegram',telegramRoutes); app.use('/api/autopilot',autopilotRoutes); app.use('/api/trends',trendRoutes);
// The built dashboard (client/dist, made by `npm run build`) is served from the same address as the API.
const clientDist=process.env.CLIENT_DIST?path.resolve(process.env.CLIENT_DIST):path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../client/dist');
// Public home page at /, dashboard at /app/ (needs `npm run build`; on your PC the dev dashboard is on :5173).
const landingDir=process.env.LANDING_DIR?path.resolve(process.env.LANDING_DIR):path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../client/landing');
const noCacheHtml={index:false,maxAge:'1d',setHeaders:(res,file)=>{if(file.endsWith('.html'))res.setHeader('Cache-Control','no-cache');}};
if(existsSync(path.join(landingDir,'index.html'))){
  app.use('/landing',express.static(landingDir,noCacheHtml));
  app.get('/',(_req,res)=>{res.setHeader('Cache-Control','no-cache');res.sendFile(path.join(landingDir,'index.html'));});
  // Icons and the sharing image at the site root, where browsers and social sites look for them.
  for(const [route,file] of [['/favicon.svg','favicon.svg'],['/favicon.png','favicon.png'],['/favicon.ico','favicon.png'],['/apple-touch-icon.png','apple-touch-icon.png'],['/og-image.png','og-image.png']])
    app.get(route,(_req,res)=>{res.setHeader('Cache-Control','public, max-age=604800');res.sendFile(path.join(landingDir,file));});
}
// Search engines: index the home page only; never the dashboard, API or videos.
const siteUrl=()=>String(process.env.PUBLIC_URL||'https://aividman.store').trim().replace(/\/+$/,'');
app.get('/robots.txt',(_req,res)=>res.type('text/plain').send(`User-agent: *\nDisallow: /app/\nDisallow: /api/\nDisallow: /storage/\n\nSitemap: ${siteUrl()}/sitemap.xml\n`));
app.get('/sitemap.xml',(_req,res)=>{let mod='';try{mod=statSync(path.join(landingDir,'index.html')).mtime.toISOString().slice(0,10);}catch{}res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl()}/</loc>${mod?`<lastmod>${mod}</lastmod>`:''}<changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n`);});
app.get(/^\/app$/,(req,res)=>res.redirect(302,'/app/'+(req.url.includes('?')?req.url.slice(req.url.indexOf('?')):''))); // exact /app only (a plain '/app' route also matches '/app/' and looped)
if(existsSync(path.join(clientDist,'index.html'))){
  app.use('/app',express.static(clientDist,{...noCacheHtml,maxAge:'7d'}));
  app.get(/^\/app\/.*/,(_req,res)=>{res.setHeader('Cache-Control','no-cache');res.setHeader('X-Robots-Tag','noindex');res.sendFile(path.join(clientDist,'index.html'));});
}else if(!security.config.production){
  app.get(/^\/app\/.*/,(req,res)=>res.redirect(`http://${req.hostname}:5173/`));
}else{
  console.error(`[start] Dashboard not built: ${clientDist} is missing. Run "npm run build" in the project folder (npm start does this automatically).`);
  app.get(/^\/app\/.*/,(_req,res)=>res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>Dashboard not built</title><body style="font-family:system-ui;padding:40px;max-width:640px"><h2>The dashboard is not built on this server yet</h2><p>In the project folder run <code>npm install</code> and then <code>npm run build</code> (or start the app with <code>npm start</code>, which builds it automatically), then restart the app.</p><p><a href="/">Back to the home page</a></p></body>'));
}
app.use('/api',(req,res)=>res.status(404).json({error:`Not found (404): ${req.method} /api${req.path}`}));
app.use((err,_req,res,_next)=>{console.error(err);const status=Number(err.status||err.statusCode)||500;res.status(status).json({error:err.message||'Internal server error'});});
installCrashLog(path.resolve(process.cwd(),'storage'),{getContext:()=>({activeJobId:currentWorkerJob()})});
installLifecycleLog(path.resolve(process.cwd(),'storage'),{getContext:()=>({activeJobId:currentWorkerJob()})});
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
    setInternalServer(server);
    console.log(`YouTube AI Agent API listening on ${env.port}`);
    try { const cleanup=await cleanupExpiredVideos(); console.log(`Video retention cleanup: ${cleanup.deleted||0} deleted, ${cleanup.candidates||0} candidates.`); } catch (e) { console.error('Initial video retention cleanup failed:', e.message); }
    setInterval(async()=>{ try { const cleanup=await cleanupExpiredVideos(); if(cleanup.deleted) console.log(`Video retention cleanup: ${cleanup.deleted} deleted.`); } catch(e) { console.error('Scheduled video retention cleanup failed:',e.message); } }, 24*60*60*1000).unref();
    startWorker();
    startTelegramBots();
    startAutopilot();
  });
}).catch(e=>{console.error(e);process.exit(1);});
