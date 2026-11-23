// Home page details come from the dashboard (Settings → Home page) via /api/site.
// These are only used if the server cannot be reached.
const SITE_FALLBACK = {brand: 'AI Video Manager'};

(function () {
  const $$ = s => Array.from(document.querySelectorAll(s));
  let SITE = {...SITE_FALLBACK};
  let plan = '';
  const digits = v => String(v || '').replace(/\D/g, '');
  const user = v => String(v || '').replace(/^@/, '');

  function setText(key, text, {show = false} = {}) {
    $$(`[data-site="${key}"]`).forEach(el => {
      if (text) { el.textContent = text; if (show) el.hidden = false; }
      else if (show) el.hidden = true;
    });
  }
  function links() {
    return {
      email: SITE.email && {href: `mailto:${SITE.email}?subject=${encodeURIComponent(plan ? `Buy: ${plan}` : `${SITE.brand} question`)}`, label: SITE.email},
      whatsapp: SITE.whatsapp && {href: `https://wa.me/${digits(SITE.whatsapp)}?text=${encodeURIComponent(plan ? `Hi, I want to buy the ${plan} plan of ${SITE.brand}.` : `Hi, I have a question about ${SITE.brand}.`)}`, label: `+${digits(SITE.whatsapp)}`, external: true},
      telegram: SITE.telegram && {href: `https://t.me/${user(SITE.telegram)}`, label: `@${user(SITE.telegram)}`, external: true},
      instagram: SITE.instagram && {href: `https://instagram.com/${user(SITE.instagram)}`, label: `@${user(SITE.instagram)}`, external: true},
      phone: SITE.phone && {href: `tel:${String(SITE.phone).replace(/[^\d+]/g, '')}`, label: SITE.phone}
    };
  }
  function render() {
    setText('brand', SITE.brand);
    setText('business', SITE.business || SITE.brand);
    setText('refund', SITE.refund || 'Refund policy: ask us before buying.');
    setText('supportHours', SITE.supportHours ? `Support hours: ${SITE.supportHours}` : '', {show: true});
    if (SITE.brand && SITE.brand !== 'AI Video Manager') document.title = `${SITE.brand} — AI YouTube Shorts maker with Hindi voice & auto upload`;
    $$('[data-year]').forEach(el => { el.textContent = String(new Date().getFullYear()); });
    const l = links();
    for (const [key, info] of Object.entries(l)) {
      const a = document.querySelector(`[data-site-link="${key}"]`);
      if (!a) continue;
      const li = a.closest('li');
      if (info) {
        a.href = info.href; a.textContent = info.label;
        if (info.external) { a.target = '_blank'; a.rel = 'noopener'; }
        li.classList.remove('missing'); li.hidden = false;
      } else if (li.classList.contains('optional')) li.hidden = true;
      else { a.textContent = 'to be added'; a.removeAttribute('href'); li.classList.add('missing'); }
    }
    // Terms / privacy appear only when written in the dashboard.
    let anyLegal = false;
    for (const key of ['terms', 'privacy']) {
      const has = Boolean(SITE[key]);
      anyLegal = anyLegal || has;
      setText(key, SITE[key]);
      document.getElementById(key).hidden = !has;
      $$(`[data-legal="${key}"]`).forEach(a => { a.hidden = !has; });
    }
    document.getElementById('legal').hidden = !anyLegal;
  }
  render();
  fetch('/api/site', {headers: {Accept: 'application/json'}})
    .then(r => (r.ok ? r.json() : null))
    .then(j => { if (j) { SITE = {...SITE_FALLBACK, ...Object.fromEntries(Object.entries(j).filter(([, v]) => v))}; render(); } })
    .catch(() => {});
  // Footer links open the matching legal text.
  $$('[data-legal]').forEach(a => a.addEventListener('click', () => { const d = document.getElementById(a.getAttribute('data-legal')); if (d) d.open = true; }));
  // Buy buttons remember the plan and fill it into the messages.
  $$('[data-buy]').forEach(btn => btn.addEventListener('click', () => {
    plan = btn.getAttribute('data-buy');
    const chosen = document.querySelector('.chosen');
    chosen.hidden = false;
    chosen.querySelector('[data-chosen]').textContent = plan;
    render();
  }));
})();
