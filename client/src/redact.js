// Secret redaction for Copy & Export. Two layers:
// 1. Field names that hold secrets are replaced entirely.
// 2. Secret-looking text inside ANY string value (log messages, provider
//    errors, URLs) is masked. Earlier builds only did layer 1, so a key or
//    MongoDB password inside a log message was exported verbatim.

const SECRET_KEY = /(api.?key|secret|password|passwd|authorization|credential|cookie|private.?key|client.?secret|access.?token|refresh.?token|id.?token|auth.?token|bearer|session.?id|^token$|_token$|-token$|connection.?string|mongo.?uri|database.?url)/i;

const VALUE_PATTERNS = [
  // mongodb://user:pass@host or mongodb+srv://… (whole URI hides host + credentials)
  [/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, 'mongodb://[REDACTED]'],
  // user:password@ in any other URL
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@"'<>]+:[^\s@/"'<>]+@/gi, '$1[REDACTED]@'],
  // Authorization: Bearer xxx / Basic xxx
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [REDACTED]'],
  // query-string credentials: ?key=…, &api_key=…, &token=…, &sig=…
  [/([?&](?:key|api[_-]?key|apikey|token|access[_-]?token|auth|sig|signature|secret|password|x-goog-api-key)=)[^&\s"'<>]+/gi, '$1[REDACTED]'],
  // header / env / json style assignments: api_key: xxx, "password":"xxx", OPENAI_API_KEY=xxx
  [/((?:[A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD)|api[_-]?key|apikey|secret|password|x-goog-api-key|x-api-key)["']?\s*[:=]\s*["']?)[^\s"',;}&]{6,}/gi, '$1[REDACTED]'],
  // cookies
  [/\b((?:set-)?cookie\s*[:=]\s*)[^\n\r]+/gi, '$1[REDACTED]'],
  // well-known provider key formats
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza[REDACTED]'],
  [/\bgsk_[A-Za-z0-9]{20,}/g, 'gsk_[REDACTED]'],
  [/\bcsk-[A-Za-z0-9]{20,}/g, 'csk-[REDACTED]'],
  [/\bya29\.[A-Za-z0-9._-]{20,}/g, 'ya29.[REDACTED]'],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]']
];

export function redactText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of VALUE_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

export function isSecretKey(key) {
  return typeof key === 'string' && key !== '' && SECRET_KEY.test(key);
}

export function redactDeep(value) {
  return JSON.parse(JSON.stringify(value ?? null, (key, val) => {
    if (isSecretKey(key)) return '[REDACTED]';
    if (typeof val === 'string') return redactText(val);
    return val;
  }));
}

// File names keep Hindi and other Unicode letters (Windows-safe characters only).
export function safeFileStem(title, fallback = 'video') {
  const cleaned = String(title || '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  const stem = Array.from(cleaned).slice(0, 60).join('');
  return stem || String(fallback || 'video').replace(/[^A-Za-z0-9_-]+/g, '_') || 'video';
}
