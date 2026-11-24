// AI Awaaz relay — a Cloudflare Worker for servers that cannot reach app.aiawaaz.io
// directly (for example when the hosting firewall times out). The app talks to this
// Worker, and the Worker passes every request on to AI Awaaz unchanged.
//
// Setup (Cloudflare dashboard → Workers & Pages → Create → "Hello World" Worker):
//   1. Replace the Worker's code with this file and click Deploy.
//   2. Settings → Variables and Secrets → add a Secret named RELAY_SECRET with a long
//      random value (letters and digits, e.g. 32 characters).
//   3. In the app: Settings → AI providers → API keys → AI Awaaz → Edit / replace →
//      MCP server URL = https://<your-worker>.workers.dev/<RELAY_SECRET>/api/mcp
//
// Only aiawaaz.io addresses are relayed, and only with the secret in the path, so the
// Worker cannot be used as an open proxy. Your AI Awaaz key is passed through, never stored.

const DEFAULT_HOST = 'app.aiawaaz.io';
const ALLOWED_HOST = /(^|\.)aiawaaz\.io$/i;
// Headers that must not be copied between the two connections.
const HOP = ['host', 'connection', 'content-length', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (!env.RELAY_SECRET || parts.shift() !== env.RELAY_SECRET) return new Response('Not found', {status: 404});

    // /<secret>/_host/<host>/<path> → https://<host>/<path> (audio links); otherwise → app.aiawaaz.io
    let host = DEFAULT_HOST;
    if (parts[0] === '_host') { parts.shift(); host = parts.shift() || ''; }
    if (!ALLOWED_HOST.test(host)) return new Response('Host not allowed', {status: 403});
    const target = `https://${host}/${parts.join('/')}${url.search}`;

    const headers = new Headers(request.headers);
    for (const h of HOP) headers.delete(h);
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'follow'
    });
    // Streams the answer back as-is (JSON or text/event-stream), including Mcp-Session-Id.
    const out = new Headers(upstream.headers);
    out.delete('content-encoding');
    out.delete('content-length');
    return new Response(upstream.body, {status: upstream.status, headers: out});
  }
};
