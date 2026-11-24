import {Router} from 'express';
import {status,runNow,getRun,makeAnyway} from '../controllers/autopilotController.js';
const r=Router();
r.get('/runs/:runId',getRun);
r.post('/runs/:runId/generate',makeAnyway);
r.get('/:seriesId',status);
r.post('/:seriesId/run-now',runNow);
export default r;
