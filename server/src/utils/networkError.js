// Node's fetch reports every network problem as just "fetch failed"; the real
// reason is in error.cause. This turns it into something a person can act on.
const codeOf = e => String(e?.cause?.code || e?.code || e?.cause?.errors?.[0]?.code || '');
export function isRetryableNetworkError(e) {
  return /^(ETIMEDOUT|ECONNRESET|EPIPE|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|ENETUNREACH|EHOSTUNREACH)$/.test(codeOf(e)) || e?.name === 'TimeoutError';
}
export function describeNetworkError(e, url) {
  const host = (() => { try { return new URL(url).host; } catch { return String(url || 'the server'); } })();
  const code = codeOf(e);
  const detail = [code, e?.cause?.message && e.cause.message !== e.message ? e.cause.message : ''].filter(Boolean).join(' — ');
  let why;
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME)$/.test(code)) why = `this computer could not look up ${host} (DNS). Check the server's internet/DNS settings.`;
  else if (code === 'ECONNREFUSED') why = `${host} refused the connection.`;
  else if (/^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ENETUNREACH|EHOSTUNREACH)$/.test(code) || e?.name === 'TimeoutError') why = `no answer from ${host}. On a hosting server this usually means outgoing connections to it are blocked: ask your host to allow outgoing HTTPS (port 443) to ${host}.`;
  else if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) why = `the secure (HTTPS) certificate check for ${host} failed on this computer.`;
  else if (/^(ECONNRESET|EPIPE|UND_ERR_SOCKET)$/.test(code)) why = `the connection to ${host} was cut off.`;
  else why = `the request to ${host} failed before any answer came back.`;
  return `cannot reach ${host}: ${why}${detail ? ` (${detail})` : ` (${e?.message || 'fetch failed'})`}`;
}
