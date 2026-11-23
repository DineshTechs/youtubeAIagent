import {Router} from 'express';
import {getSite, saveSite} from '../controllers/siteController.js';
const r = Router();
r.get('/', getSite);
r.put('/', saveSite);
export default r;
