import {Router} from 'express';
import {status,auth,callback,publish} from '../controllers/youtubeController.js';
const r=Router();
r.get('/status',status);
r.get('/auth',auth);
r.get('/callback',callback);
r.post('/publish/:id',publish);
export default r;
