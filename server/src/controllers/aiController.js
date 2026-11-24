import { getAISettings, setActiveProvider, testProvider, setMediaProvider, testMediaProvider, updateAIConfig, saveTextKey, listTextModels, setTextPriority, setMediaPriority, listKeys, saveKey } from '../services/ai/index.js';
import { saveTtsKeys, getTtsCredentials } from '../services/ai/ttsKeys.js';
import { listVoices, FREE_TTS_PROVIDERS } from '../services/media/freeTts.js';
import { mcpDescribe } from '../services/media/mcpTts.js';
// Keys for Azure / Google / ElevenLabs narration (write-only; stored encrypted).
export async function updateTextKey(req, res) { try { const b = req.body || {}; res.json(await saveTextKey(String(b.provider || ''), { key: b.key, clear: b.clear === true, accountId: b.accountId, baseUrl: b.baseUrl })); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } }
export async function textModels(req, res) { try { res.json(await listTextModels(req.params.provider)); } catch (e) { res.status(e.status && e.status < 500 ? 400 : 502).json({ error: e.message }); } }
export async function updateTextPriority(req, res) { try { res.json(await setTextPriority({ order: req.body?.order, fallbackEnabled: req.body?.fallbackEnabled })); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } }
export async function updateMediaPriority(req, res) { try { res.json(await setMediaPriority(String(req.body?.type || ''), { order: req.body?.order, fallbackEnabled: req.body?.fallbackEnabled })); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } }
export async function updateTtsKeys(req, res) { try { await saveTtsKeys(req.body || {}); res.json(await getAISettings()); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } }
export async function ttsVoices(req, res) { try { const p = req.params.provider; if (p === 'aiawaaz') { const c = (await getTtsCredentials()).aiawaaz; return res.json(await mcpDescribe({ url: c.url, apiKey: c.key, language: String(req.query.language ?? 'hi') })); } if (!FREE_TTS_PROVIDERS.includes(p)) return res.status(400).json({ error: 'Voice lists are available for azure, google and elevenlabs.' }); res.json({ voices: await listVoices(p, (await getTtsCredentials())[p], { language: String(req.query.language ?? 'hi') }) }); } catch (e) { res.status(e.status && e.status < 500 ? 400 : 502).json({ error: e.message }); } }

export async function getKeys(_req, res, next) { try { res.json(await listKeys()); } catch (e) { next(e); } }
export async function updateKey(req, res) { try { res.json(await saveKey(String(req.params.id || ''), req.body || {})); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } }
export async function getSettings(_req, res, next) { try { res.json(await getAISettings()); } catch (e) { next(e); } }
export async function updateSettings(req, res, next) { try { res.json(await setActiveProvider(req.body?.provider)); } catch (e) { res.status(400).json({ error: e.message }); } }
export async function updateMediaSettings(req, res) { try { res.json(await setMediaProvider(req.body?.type, req.body?.provider)); } catch (e) { res.status(400).json({ error: e.message }); } }
export async function updateConfig(req, res, next) { try { res.json(await updateAIConfig(req.body || {})); } catch (e) { next(e); } }
export async function test(req, res, next) { try { res.json({ ok: true, provider: req.params.provider, result: await testProvider(req.params.provider) }); } catch (e) { res.status(400).json({ ok: false, provider: req.params.provider, error: e.message }); } }
export async function testMedia(req, res) { try { res.json({ ok: true, type: req.params.type, provider: req.params.provider, result: await testMediaProvider(req.params.type, req.params.provider) }); } catch (e) { res.status(400).json({ ok: false, type: req.params.type, provider: req.params.provider, error: e.message }); } }
