import {Router} from 'express';
import {get,put,detect,test,copy} from '../controllers/telegramController.js';
// Telegram notifications are configured per channel profile.
const r=Router();
r.get('/:seriesId',get);
r.put('/:seriesId',put);
r.post('/:seriesId/detect-chats',detect);
r.post('/:seriesId/test',test);
r.post('/:seriesId/copy-from/:sourceId',copy);
export default r;
