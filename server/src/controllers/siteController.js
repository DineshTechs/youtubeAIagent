import SiteSettings from '../models/SiteSettings.js';
import {normalizeSite, publicSite, SITE_DEFAULTS} from '../services/siteSettings.js';

async function current() { const d = await SiteSettings.findOne({key: 'global'}).lean(); return {...SITE_DEFAULTS, ...(d?.site || {})}; }
// Public: the home page reads this.
export async function getSite(_req, res, next) { try { res.setHeader('Cache-Control', 'no-cache'); res.json(publicSite(await current())); } catch (e) { next(e); } }
// Admin only (protected by the login).
export async function saveSite(req, res, next) {
  try {
    const site = normalizeSite(req.body || {}, await current());
    await SiteSettings.updateOne({key: 'global'}, {$set: {site}}, {upsert: true});
    res.json(publicSite(site));
  } catch (e) { if (e.status === 400) return res.status(400).json({error: e.message, field: e.field}); next(e); }
}
