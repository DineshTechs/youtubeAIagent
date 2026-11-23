import {Router} from 'express';
import {ideas} from '../controllers/trendController.js';
const r=Router();
r.get('/:seriesId',ideas);
export default r;
