// Home page details (product name, contact, refund policy) edited in the dashboard
// (Settings → Home page) and shown on the public home page.
export const SITE_FIELDS = {
  brand:      {max: 60,  label: 'Product name'},
  business:   {max: 100, label: 'Business / owner name'},
  email:      {max: 120, label: 'Email'},
  whatsapp:   {max: 20,  label: 'WhatsApp number'},
  telegram:   {max: 40,  label: 'Telegram username'},
  instagram:  {max: 40,  label: 'Instagram username'},
  phone:      {max: 24,  label: 'Phone'},
  supportHours: {max: 120, label: 'Support hours'},
  refund:     {max: 600, label: 'Refund policy'},
  terms:      {max: 4000, label: 'Terms of use'},
  privacy:    {max: 4000, label: 'Privacy policy'}
};
export const SITE_DEFAULTS = {brand: 'AI Video Manager', business: '', email: '', whatsapp: '', telegram: '', instagram: '', phone: '', supportHours: '', refund: '', terms: '', privacy: ''};

const bad = (field, msg) => Object.assign(new Error(`${SITE_FIELDS[field].label}: ${msg}`), {status: 400, field});
// Plain text only (the page sets text, never HTML); strips control characters.
const clean = v => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

export function normalizeSite(input = {}, current = SITE_DEFAULTS) {
  const out = {...SITE_DEFAULTS, ...current};
  for (const [field, rule] of Object.entries(SITE_FIELDS)) {
    if (!(field in input)) continue;
    let v = clean(input[field]);
    if (v.length > rule.max) throw bad(field, `keep it under ${rule.max} characters.`);
    if (v && field === 'email' && !/^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i.test(v)) throw bad(field, 'that is not a valid email address.');
    if (v && field === 'whatsapp') { v = v.replace(/[\s()+-]/g, ''); if (!/^\d{8,15}$/.test(v)) throw bad(field, 'use the full number with country code, digits only (e.g. 919876543210).'); }
    if (v && field === 'phone' && !/^\+?[\d\s()-]{6,24}$/.test(v)) throw bad(field, 'use digits, spaces, + or -.');
    if (v && (field === 'telegram' || field === 'instagram')) {
      v = v.replace(/^https?:\/\/(t\.me|telegram\.me|(www\.)?instagram\.com)\//i, '').replace(/^@/, '').replace(/\/+$/, '');
      if (!/^[A-Za-z0-9_.]{3,40}$/.test(v)) throw bad(field, 'use the username only, e.g. mybrand_support.');
    }
    out[field] = v;
  }
  if (!out.brand) out.brand = SITE_DEFAULTS.brand;
  return out;
}
// Only the fields the public page needs.
export const publicSite = s => Object.fromEntries(Object.keys(SITE_FIELDS).map(k => [k, String(s?.[k] ?? SITE_DEFAULTS[k] ?? '')]));
