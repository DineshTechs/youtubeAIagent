import {Router} from 'express';
import {status,runNow} from '../controllers/autopilotController.js';
const r=Router();
r.get('/:seriesId',status);
r.post('/:seriesId/run-now',runNow);
export default r;
