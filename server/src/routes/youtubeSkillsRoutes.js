import {Router} from 'express';
import {getSkills,executeSkill,testAll,testAllStatus} from '../controllers/youtubeSkillsController.js';
const r=Router();
r.get('/',getSkills);
r.post('/test-all',testAll);
r.get('/test-all/:jobId',testAllStatus);
r.post('/:skill',executeSkill);
export default r;
