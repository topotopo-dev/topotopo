// The script of the web app's pages (src/web/pages.ts, folder-page.ts): the front page's search (packages by name,
// tag and the packages they use, their outputs by name, kind and tag; Escape or Clear ends it); on a folder page the
// long notes folded with a Show all (at the height the page's style gives each, --clip), a linked note or heading
// opened, each sound's length, the viewer (an image large with the folder's other images a key away, a model in 3D),
// copy buttons and actions; and live updates from the server's event stream (a bake finished, the folder changed).
const page = document.body.dataset.page;
const data = document.body.dataset.json ? JSON.parse(document.body.dataset.json) : {};
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

if (page === 'front') {
  const search = document.getElementById('search'), clear = document.getElementById('clear');
  const results = document.getElementById('results'), found = document.getElementById('found');
  const roots = $$('.roots');
  const filter = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const on = words.length > 0;
    let shown = 0;
    for (const card of $$('.card')) {
      const hay = card.dataset.hay;
      // an output is found when every word is in it or in its package, and at least one in the output itself
      const outs = $$('.out', card);
      const hits = on ? outs.filter((o) => words.every((w) => o.dataset.hay.includes(w) || hay.includes(w)) && words.some((w) => o.dataset.hay.includes(w))) : [];
      const ok = on && (words.every((w) => hay.includes(w)) || hits.length > 0);
      for (const o of outs) o.hidden = !ok || !hits.includes(o);
      card.hidden = !ok;
      if (ok) shown++;
    }
    results.hidden = !on;
    for (const r of roots) r.hidden = on;
    found.textContent = on ? `${shown} of ${found.dataset.total}` : found.dataset.total;
    clear.hidden = !on;
    document.getElementById('nomatch').hidden = !on || shown > 0;
  };
  const reset = () => { search.value = ''; filter(); search.focus(); };
  search.addEventListener('input', filter);
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') reset(); });
  clear.addEventListener('click', reset);
  for (const b of $$('[data-clear]')) b.addEventListener('click', reset);
  document.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement !== search) { e.preventDefault(); search.focus(); } });
  filter();
}

if (page === 'folder') {
  // long notes fold, with a Show all: a note folds when it is clearly longer than its --clip
  const folds = [];
  for (const note of $$('.note')) {
    const md = note.querySelector('.md'), more = note.querySelector('.more');
    if (!md || !more) continue;
    const fold = () => {
      const clip = parseFloat(getComputedStyle(note).getPropertyValue('--clip')) || 820;
      const long = md.scrollHeight > clip + Math.max(120, clip * 0.2);
      if (note.classList.contains('open')) { more.hidden = !long; return; }
      note.classList.toggle('clip', long);
      more.hidden = !long;
    };
    folds.push(fold);
    fold();
    for (const m of $$('img, video', md)) m.addEventListener(m.tagName === 'IMG' ? 'load' : 'loadedmetadata', fold, { once: true });
    more.addEventListener('click', () => {
      const open = note.classList.toggle('open');
      note.classList.toggle('clip', !open);
      more.textContent = open ? 'Show less' : 'Show all';
      if (!open) note.scrollIntoView({ block: 'nearest' });
    });
  }
  let resized;
  window.addEventListener('resize', () => { clearTimeout(resized); resized = setTimeout(() => folds.forEach((f) => f()), 150); });
  // a link to a note on this page, or to a heading in one, opens that note and shows the place
  const openNote = () => {
    const el = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    const note = el?.closest?.('.note');
    if (!note) return;
    if (note.classList.contains('clip')) note.querySelector('.more').click();
    requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  };
  window.addEventListener('hashchange', openNote);
  openNote();

  // each sound's length beside its size, to the tenth of a second (the player's own clock rounds a short sound to 0:00)
  const length = (s) => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
  for (const row of $$('.arow')) {
    const a = row.querySelector('audio'), d = row.querySelector('.adur');
    if (!a || !d) continue;
    const put = () => { if (Number.isFinite(a.duration) && a.duration > 0) d.textContent = length(a.duration); };
    a.addEventListener('loadedmetadata', put);
    a.addEventListener('durationchange', put);
    put();
  }

  // the viewer: images large (the arrows step through the page's images), models in 3D
  const dlg = document.getElementById('viewer');
  const body = dlg.querySelector('.vbody'), name = dlg.querySelector('.vname'), open = dlg.querySelector('.vopen');
  const prev = dlg.querySelector('.vprev'), next = dlg.querySelector('.vnext');
  let list = [], at = -1;
  const show = (el) => {
    const isModel = el.dataset.view === 'model';
    body.replaceChildren();
    if (isModel) {
      const f = document.createElement('iframe');
      f.src = el.dataset.src;
      f.title = el.dataset.name;
      f.allow = 'fullscreen';
      body.append(f);
      open.href = el.dataset.src;
    } else {
      const img = document.createElement('img');
      img.src = el.getAttribute('href');
      img.alt = el.dataset.name ?? '';
      body.append(img);
      open.href = el.getAttribute('href');
    }
    name.textContent = el.dataset.name ?? '';
    list = isModel ? [el] : $$('[data-view="image"]');
    at = list.indexOf(el);
    prev.hidden = next.hidden = list.length < 2;
    if (!dlg.open) dlg.showModal();
  };
  const step = (d) => { if (list.length > 1) show(list[(at + d + list.length) % list.length]); };
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-view]');
    if (!el || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    show(el);
  });
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  dlg.querySelector('.vclose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target === body) dlg.close(); });
  dlg.addEventListener('close', () => body.replaceChildren());
  dlg.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); });

  // copy boxes and actions
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
        const res = await fetch(b.dataset.post, { method: 'POST' });
        const j = await res.json().catch(() => ({}));
        if (/\/bake$/.test(b.dataset.post)) document.getElementById('bake').textContent = j.ok ? 'Baking…' : `Could not bake: ${j.error ?? res.status}`;
      } finally { setTimeout(() => { b.disabled = false; }, 800); }
    });
  }
  for (const b of $$('[data-reveal]')) b.addEventListener('click', () => fetch(data.reveal, { method: 'POST' }));
}

// live updates: the front page reloads when packages come or go; a folder page reloads when its package's bake
// finishes, and offers to when its folder changed on disk (not while something plays)
const playing = () => $$('audio, video').some((m) => !m.paused);
let banner = null;
const offerReload = () => {
  if (banner) return;
  banner = document.createElement('div');
  banner.className = 'changed';
  banner.innerHTML = '<span>This folder changed on disk.</span><button class="btn" type="button">Reload</button>';
  banner.querySelector('button').addEventListener('click', () => location.reload());
  document.body.append(banner);
};
const es = new EventSource('/api/events');
es.onmessage = (m) => {
  let ev;
  try { ev = JSON.parse(m.data); } catch { return; }
  if (page === 'front') {
    if (ev.list) location.reload();
    else if (ev.package && !ev.baking) {
      const card = document.querySelector(`.card[data-key="${CSS.escape(ev.package)}"]`);
      const img = card?.querySelector('img');
      if (img) img.src = img.src.replace(/(\?v=[^&]*)?$/, `?v=${ev.version}`);
    }
  } else if (page === 'folder') {
    if (data.package && ev.package === data.package) {
      if (ev.baking) { const b = document.getElementById('bake'); if (b) b.textContent = 'Baking…'; }
      else if (playing()) offerReload(); else location.reload();
      return;
    }
    const here = data.rel ? `${data.root}/${data.rel}` : data.root;
    if (ev.folders?.some((f) => f === here || f.startsWith(`${here}/`) && !f.slice(here.length + 1).includes('/'))) offerReload();
  }
};
