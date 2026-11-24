// Real (cheap) sign-in checks for image keys, so "Test" tells you about a bad key
// before a video fails. No image is generated. fetchImpl is injectable for tests.
const short = t => String(t || '').replace(/\s+/g, ' ').slice(0, 200);

export async function checkCloudflare({token, accountId}, fetchImpl = fetch) {
  if (!token || !accountId) throw new Error('Cloudflare needs both the API token and the account ID.');
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('The Cloudflare account ID should be 32 letters/digits (Cloudflare dashboard → Workers AI → "Use REST API").');
  const h = {Authorization: `Bearer ${token}`};
  const get = async url => { const r = await fetchImpl(url, {headers: h, signal: AbortSignal.timeout(15000)}); return {r, j: await r.json().catch(() => ({}))}; };
  // Can it use Workers AI on this account?
  const {r, j} = await get(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?per_page=1`);
  if (r.ok && j.success !== false) return {ok: true, message: 'Cloudflare token and account ID work for Workers AI.'};
  if (r.status !== 401 && r.status !== 403) throw new Error(`Cloudflare check failed (${r.status}): ${short(JSON.stringify(j.errors || j))}`);
  // Find out why: is the token valid at all (user token, then account token)?
  const user = await get('https://api.cloudflare.com/client/v4/user/tokens/verify');
  const acct = user.r.ok ? user : await get(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/tokens/verify`);
  if (acct.r.ok && acct.j.success !== false && acct.j.result?.status !== 'disabled')
    throw new Error(`The token is valid but cannot use Workers AI on account ${accountId.slice(0, 6)}… (${r.status}). Either the account ID is from a different Cloudflare account, or the token lacks the "Workers AI" permission. Check both, then save again.`);
  throw new Error(`Cloudflare rejected the API token (${r.status} "Authentication error"): it is wrong, expired, or was copied with extra characters. Make a new one at dash.cloudflare.com → My Profile → API Tokens → Create Token → "Workers AI" template, then paste it in Settings → AI providers → API keys.`);
}

export async function checkGemini(key, fetchImpl = fetch) {
  if (!key) throw new Error('No Gemini key is set.');
  const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`, {signal: AbortSignal.timeout(15000)});
  if (r.ok) return {ok: true, message: 'Gemini key works.'};
  const j = await r.json().catch(() => ({}));
  throw new Error(`Gemini rejected the key (${r.status}): ${short(j.error?.message || '')}`);
}

export async function checkOpenAI(key, fetchImpl = fetch) {
  if (!key) throw new Error('No OpenAI key is set.');
  const r = await fetchImpl('https://api.openai.com/v1/models', {headers: {Authorization: `Bearer ${key}`}, signal: AbortSignal.timeout(15000)});
  if (r.ok) return {ok: true, message: 'OpenAI key works.'};
  const j = await r.json().catch(() => ({}));
  throw new Error(`OpenAI rejected the key (${r.status}): ${short(j.error?.message || '')}`);
}
