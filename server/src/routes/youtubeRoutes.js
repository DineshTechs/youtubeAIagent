import {Router} from 'express';
import {status,saveAccount,disconnect,auth,callback,publish,preview,seo} from '../controllers/youtubeController.js';
const r=Router();
// Per channel profile: OAuth client, connection and status.
r.get('/account/:seriesId',status);
r.put('/account/:seriesId',saveAccount);
r.post('/account/:seriesId/disconnect',disconnect);
r.get('/auth/:seriesId',auth);
r.get('/callback',callback);
// Per video.
r.get('/preview/:id',preview);
r.post('/seo/:id',seo);
r.post('/publish/:id',publish);
export default r;
