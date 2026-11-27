// Privacy / terms pages: fill in the business name and contact details from Settings → Home page.
// If you wrote your own policy text there, it is shown instead of the standard text.
(function () {
  const $$ = s => Array.from(document.querySelectorAll(s));
  const digits = v => String(v || '').replace(/\D/g, '');
  $$('[data-year]').forEach(el => { el.textContent = String(new Date().getFullYear()); });
  fetch('/api/site', {cache: 'no-store'}).then(r => (r.ok ? r.json() : {})).catch(() => ({})).then(site => {
    const name = site.business || site.brand || 'AI Video Manager';
    $$('[data-site="business"]').forEach(el => { el.textContent = name; });
    if (site.brand) $$('[data-site="brand"]').forEach(el => { el.textContent = site.brand; });
    if (site.refund) $$('[data-site="refund"]').forEach(el => { el.textContent = site.refund; });
    const parts = [];
    if (site.email) parts.push(`<a href="mailto:${encodeURI(site.email)}">${site.email.replace(/</g, '&lt;')}</a>`);
    if (site.whatsapp) parts.push(`WhatsApp <a href="https://wa.me/${digits(site.whatsapp)}" rel="noopener" target="_blank">+${digits(site.whatsapp)}</a>`);
    if (site.phone) parts.push(`phone ${String(site.phone).replace(/</g, '&lt;')}`);
    if (parts.length) $$('[data-contact]').forEach(el => { el.innerHTML = parts.join(', '); });
    const custom = document.querySelector('[data-legal-custom]');
    const own = custom && String(site[custom.getAttribute('data-legal-custom')] || '').trim();
    if (own) {
      custom.textContent = own;           // plain text, kept as written (line breaks preserved by CSS)
      custom.hidden = false;
      const std = document.querySelector('[data-legal-standard]'); if (std) std.hidden = true;
    }
  });
})();
