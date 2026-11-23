import {Router} from 'express'; import {generateDaily,getStatus,activeJobs} from '../controllers/agentController.js';
const r=Router(); r.post('/generate',generateDaily); r.get('/active',activeJobs); r.get('/status/:id',getStatus); export default r;
