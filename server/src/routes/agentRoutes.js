import {Router} from 'express'; import {generateDaily,getStatus} from '../controllers/agentController.js';
const r=Router(); r.post('/generate',generateDaily); r.get('/status/:id',getStatus); export default r;
