// The gallery pages' script (src/gallery/pages.ts): search and tag filters on the grid (the search finds a package's
// outputs and TopoTopo's kits' too, by name, kind and tag, and shows those it found on the card; each library says how
// many cards it shows, and Clear ends the filter, which a new visit starts without), copy buttons and actions on a
// package page, and live updates from the server's event stream (a bake finished, packages added or removed).
const page = document.body.dataset.page;
const data = document.body.dataset.json ? JSON.parse(document.body.dataset.json) : {};
const $$ = (s) => [...document.querySelectorAll(s)];

if (page === 'gallery') {
  const search = document.getElementById('search'), clear = document.getElementById('clear');
  const chips = $$('.chip');
  const filter = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const tags = chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.tag);
    let shown = 0;
    for (const card of $$('.card')) {
      const own = card.dataset.tags.split('\n'), hay = card.dataset.hay;
      // an output is found when every word is in it or in its package, and at least one in the output itself
      const outs = [...card.querySelectorAll('.out')];
      const found = words.length ? outs.filter((o) => words.every((w) => o.dataset.hay.includes(w) || hay.includes(w)) && words.some((w) => o.dataset.hay.includes(w))) : [];
      const ok = (words.every((w) => hay.includes(w)) || found.length > 0) && tags.every((t) => own.includes(t));
      for (const o of outs) o.hidden = !ok || !found.includes(o);
      card.hidden = !ok;
      if (ok) shown++;
    }
    for (const sec of $$('.collection')) sec.hidden = !sec.querySelector('.card:not([hidden])');
    // while a filter is on, each library says how many of its cards it shows, and one with none hides
    const on = words.length > 0 || tags.length > 0;
    for (const lib of $$('.library')) {
      const count = lib.querySelector('h2 .count'), n = lib.querySelectorAll('.card:not([hidden])').length, total = Number(count?.dataset.total ?? 0);
      if (count) count.textContent = on ? `${n} of ${total}` : String(total);
      lib.hidden = on && !n;
    }
    clear.hidden = !on;
    document.getElementById('nomatch').hidden = shown > 0 || !$$('.card').length;
  };
  const reset = () => { search.value = ''; for (const c of chips) c.setAttribute('aria-pressed', 'false'); filter(); search.focus(); };
  search.addEventListener('input', filter);
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') reset(); });
  clear.addEventListener('click', reset);
  for (const b of $$('[data-clear]')) b.addEventListener('click', reset);
  for (const c of chips) c.addEventListener('click', () => { c.setAttribute('aria-pressed', String(c.getAttribute('aria-pressed') !== 'true')); filter(); });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement !== search) { e.preventDefault(); search.focus(); } });
  filter();
}

if (page === 'package') {
  for (const b of $$('[data-copy]')) {
    b.addEventListener('click', async () => {
      const input = b.previousElementSibling;
      input.select();
      try { await navigator.clipboard.writeText(input.value); } catch { document.execCommand('copy'); }
      b.textContent = 'Copied';
      b.classList.add('done');
      setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1500);
    });
  }
  for (const b of $$('[data-post]')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const res = await fetch(`${location.pathname.replace(/\/$/, '')}/${b.dataset.post}`, { method: 'POST' });
        const j = await res.json().catch(() => ({}));
        if (b.dataset.post === 'bake') document.getElementById('bake').textContent = j.ok ? 'Baking…' : `Could not bake: ${j.error ?? res.status}`;
      } finally { setTimeout(() => { b.disabled = false; }, 800); }
    });
  }
}

// live updates: a finished bake reloads that package's thumbnail (grid) or the page (package); a changed list reloads
// the grid
const es = new EventSource('/api/events');
es.onmessage = (m) => {
  let ev;
  try { ev = JSON.parse(m.data); } catch { return; }
  const key = `${data.lib}/${data.id}`;
  if (page === 'gallery') {
    if (ev.list) { location.reload(); return; }
    if (ev.package) {
      const card = document.querySelector(`.card[data-key="${CSS.escape(ev.package)}"]`);
      if (!card) return;
      const st = card.querySelector('.status');
      if (ev.baking) { st.className = 'status s-baking'; st.textContent = 'baking…'; return; }
      st.className = `status s-${ev.ok ? 'ok' : 'failed'}`;
      st.textContent = ev.ok ? '' : 'bake failed';
      const img = card.querySelector('img');
      img.src = img.src.replace(/(\?v=[^&]*)?$/, `?v=${ev.version}`);
    }
  } else if (page === 'package') {
    if (ev.package === key && ev.baking) document.getElementById('bake').textContent = 'Baking…';
    else if ((ev.package === key && !ev.baking) || ev.changed?.includes(key)) location.reload();
  }
};
