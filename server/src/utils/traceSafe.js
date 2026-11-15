// Make pipeline-trace values safe to store in MongoDB without losing them.
// Earlier builds cut the JSON text at `max` characters and parsed it again;
// that almost always failed and stored the useless string "[object Object]".
export function traceSafe(value, max = 12000) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) + '…' : value;
  let json;
  try {
    const seen = new WeakSet();
    json = JSON.stringify(value, (_k, v) => {
      if (typeof v === 'object' && v !== null) { if (seen.has(v)) return '[Circular]'; seen.add(v); }
      if (typeof v === 'bigint') return String(v);
      if (typeof v === 'string' && v.length > 4000) return v.slice(0, 4000) + '…';
      return v;
    });
  } catch (error) {
    return { traceSerializationError: String(error?.message || error), preview: String(value).slice(0, Math.min(max, 2000)) };
  }
  if (json === undefined) return undefined;
  if (json.length <= max) return JSON.parse(json);
  // Keep the beginning of the data as readable JSON text plus clear metadata.
  return { truncated: true, originalChars: json.length, keptChars: max, preview: json.slice(0, max) + '…' };
}
