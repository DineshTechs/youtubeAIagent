import { getAISettings, setActiveProvider, testProvider, setMediaProvider, testMediaProvider, updateAIConfig } from '../services/ai/index.js';

export async function getSettings(_req, res, next) { try { res.json(await getAISettings()); } catch (e) { next(e); } }
export async function updateSettings(req, res, next) { try { res.json(await setActiveProvider(req.body?.provider)); } catch (e) { res.status(400).json({ error: e.message }); } }
export async function updateMediaSettings(req, res) { try { res.json(await setMediaProvider(req.body?.type, req.body?.provider)); } catch (e) { res.status(400).json({ error: e.message }); } }
export async function updateConfig(req, res, next) { try { res.json(await updateAIConfig(req.body || {})); } catch (e) { next(e); } }
export async function test(req, res, next) { try { res.json({ ok: true, provider: req.params.provider, result: await testProvider(req.params.provider) }); } catch (e) { res.status(400).json({ ok: false, provider: req.params.provider, error: e.message }); } }
export async function testMedia(req, res) { try { res.json({ ok: true, type: req.params.type, provider: req.params.provider, result: await testMediaProvider(req.params.type, req.params.provider) }); } catch (e) { res.status(400).json({ ok: false, type: req.params.type, provider: req.params.provider, error: e.message }); } }
