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

  // actions
  for (const b of $$('[data-post]')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const res = await fetch(b.dataset.post, { method: 'POST' });
        const j = await res.json().catch(() => ({}));
        if (/\/bake$/.test(b.dataset.post) && !j.ok) {
          const el = document.getElementById('bakenow');
          el.textContent = `Could not bake: ${j.error ?? res.status}`;
        }
      } finally { setTimeout(() => { b.disabled = false; }, 800); }
    });
  }
}

for (const b of $$('[data-copy]')) {
  b.addEventListener('click', async () => {
    const target = b.previousElementSibling;
    if (target.matches('input')) target.select();
    else {
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    try { await navigator.clipboard.writeText(target.value ?? target.textContent); } catch { document.execCommand('copy'); }
    b.textContent = 'Copied';
    b.classList.add('done');
    setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1500);
  });
}

if (page === 'storage') {
  const rows = new Map($$('[data-storage]').map((row) => [row.dataset.storage, row]));
  const clears = $$('[data-storage-clear]');
  const size = (bytes) => bytes < 1024 ? `${bytes} B`
    : bytes < 2 ** 20 ? `${(bytes / 1024).toFixed(0)} KB`
    : bytes < 2 ** 30 ? `${Number((bytes / 2 ** 20).toFixed(1))} MB`
    : `${Number((bytes / 2 ** 30).toFixed(2))} GB`;
  const count = (n, unit) => `${n.toLocaleString('en')} ${unit}${n === 1 ? '' : 's'}`;
  const enableClears = () => {
    for (const b of clears) b.disabled = !Number(b.closest('[data-storage]').dataset.bytes);
  };
  const measure = async () => {
    try {
      const res = await fetch('/api/storage');
      if (!res.ok) throw new Error();
      const { ok, items } = await res.json();
      if (!ok) throw new Error();
      for (const item of items) {
        const row = rows.get(item.id);
        row.dataset.bytes = item.bytes;
        row.querySelector('[data-storage-size]').textContent = item.clear
          ? `${size(item.bytes)} of ${size(item.limit)} · ${count(item.files, 'file')}`
          : `${size(item.bytes)} in ${count(item.packages, 'package')}`;
      }
    } catch {
      for (const row of rows.values()) {
        delete row.dataset.bytes;
        row.querySelector('[data-storage-size]').textContent = 'could not be measured';
      }
    }
    enableClears();
  };
  const post = async (action, what) => {
    const res = await fetch(`/api/storage/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-topotopo-open': '1' },
      body: JSON.stringify({ what }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error ?? `the web app answered ${res.status}`);
    return result;
  };
  let armed = null;
  const cancelClear = () => {
    if (!armed) return;
    armed.textContent = 'Clear';
    armed.nextElementSibling.hidden = true;
    armed = null;
  };
  document.addEventListener('click', (e) => { if (armed && !armed.contains(e.target)) cancelClear(); });
  for (const clear of clears) {
    const row = clear.closest('[data-storage]'), what = row.dataset.storage;
    const message = row.querySelector('[data-storage-message]');
    const cancel = row.querySelector('[data-storage-cancel]');
    cancel.addEventListener('click', () => { cancelClear(); clear.focus(); });
    clear.addEventListener('click', async () => {
      if (armed !== clear) {
        cancelClear();
        armed = clear;
        clear.textContent = `Clear ${size(Number(row.dataset.bytes))}?`;
        cancel.hidden = false;
        return;
      }
      cancelClear();
      for (const b of clears) b.disabled = true;
      message.textContent = '';
      try {
        const { freed } = await post('clear', what);
        await measure();
        message.textContent = `Cleared ${size(freed)}.`;
      } catch (e) {
        message.textContent = `Could not clear: ${e.message}`;
        enableClears();
      }
    });
    row.querySelector('[data-storage-reveal]').addEventListener('click', async () => {
      try { await post('reveal', what); } catch (e) { message.textContent = `Could not show the folder: ${e.message}`; }
    });
  }
  void measure();

  const check = document.getElementById('check-version');
  const note = document.getElementById('version-note');
  const command = document.getElementById('version-command');
  check.addEventListener('click', async () => {
    check.disabled = true;
    check.textContent = 'Checking…';
    command.hidden = true;
    try {
      const res = await fetch('/api/version/latest');
      if (!res.ok) throw new Error(`the web app answered ${res.status}`);
      const { ok, current, latest, newer, error } = await res.json();
      note.textContent = !ok ? error : newer
        ? `${latest} is out. To update, run this in a terminal and open TopoTopo again:`
        : `${current} is the newest version.`;
      command.hidden = !ok || !newer;
    } catch (e) {
      note.textContent = `npmjs.com could not be reached: ${e.message}`;
    } finally {
      check.textContent = 'Check for a newer version';
      check.disabled = false;
    }
  });
}

for (const b of $$('[data-reveal]')) b.addEventListener('click', () => fetch(data.reveal, { method: 'POST' }).catch(() => {}));

if (page === 'editor' && data.starting) {
  const started = Date.now();
  const seconds = document.getElementById('editor-seconds');
  const waitForEditor = async () => {
    seconds.textContent = Math.floor((Date.now() - started) / 1000);
    try {
      const res = await fetch('?wait=1', { signal: AbortSignal.timeout(5000) });
      const r = await res.json();
      if (r.url) return location.replace(r.url);
      if (!r.ok) {
        document.getElementById('editor-heading').textContent = 'The editor could not start.';
        document.getElementById('editor-wait').hidden = true;
        const reason = document.getElementById('editor-error');
        reason.textContent = r.error;
        reason.hidden = false;
        document.getElementById('editor-actions').hidden = false;
        return;
      }
    } catch { /* the status bar reports lost contact */ }
    setTimeout(waitForEditor, 500);
  };
  setTimeout(waitForEditor, 500);
}

const previews = page === 'previews' ? document.querySelector('.previews') : null;
const previewRows = document.getElementById('preview-rows');
const previewSummary = document.getElementById('preview-summary');
const previewPause = document.getElementById('preview-pause');
let previewRequest = false;
const previewClock = () => {
  const el = previewRows.querySelector('[data-started]');
  if (!el) return;
  const seconds = Math.max(0, Math.floor((Date.now() - Number(el.dataset.started)) / 1000));
  const text = data.words.making.replace('{seconds}', seconds);
  if (el.textContent !== text) el.textContent = text;
};
if (previews) {
  setInterval(previewClock, 250);
  previews.addEventListener('click', async (e) => {
    const button = e.target.closest('button[data-action]');
    if (!button || previewRequest) return;
    const error = document.getElementById('preview-error');
    error.hidden = true;
    button.disabled = previewRequest = true;
    try {
      const res = await fetch('/api/bakes', {
        method: 'POST', headers: { 'x-topotopo-open': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ action: button.dataset.action, package: button.dataset.package }),
      });
      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        throw new Error(result.error ?? data.words.actionFailed);
      }
    } catch (e) {
      error.textContent = e instanceof TypeError ? data.words.actionFailed : e.message || data.words.actionFailed;
      error.hidden = false;
    } finally { button.disabled = previewRequest = false; }
  });
}

function updateCard(card) {
  if (page === 'front') {
    const el = document.querySelector(`.card[data-key="${CSS.escape(card.package)}"]`);
    if (!el) return;
    const mark = el.querySelector('.status');
    mark.className = `status s-${card.status}`;
    mark.textContent = data.statusWords[card.status];
    const img = el.querySelector('img');
    const src = img.getAttribute('src');
    const versioned = src.replace(/(\?v=[^&]*)?$/, `?v=${card.version}`);
    if (versioned !== src) img.src = versioned;
  } else if (page === 'folder' && card.package === data.package && !['unread', 'empty'].includes(card.status)) {
    document.getElementById('bakenow').textContent = card.active;
    const line = document.getElementById('bake');
    line.textContent = card.line;
    line.classList.toggle('err', card.status === 'failed');
    const placeholder = document.querySelector('.pkgblock .view.none p');
    if (placeholder) placeholder.textContent = card.placeholder;
  }
}

// live updates: the front page reloads when packages come or go; a folder page reloads when its package's bake
// finishes, and offers to when its folder changed on disk (not while something plays). A page or card made from no audit
// of its tree, or from one before a change (data.wait, data-wait: that audit's number), reloads when the tree's audit as
// it is is made: the event stream first says which trees have theirs (ev.audits), then each one made (ev.audited, ev.n)
const playing = () => $$('audio, video').some((m) => !m.paused);
// a reload that waits for what plays to stop
let reloading = false;
const reloadWhenStill = () => {
  if (reloading) return;
  reloading = true;
  if (!playing()) return location.reload();
  const still = () => { if (!playing()) location.reload(); };
  document.addEventListener('pause', still, true);
  document.addEventListener('ended', still, true);
};
const audited = (root, n) => {
  if (page === 'front') { if ($$('.rcard[data-wait]').some((c) => c.dataset.root === root && n > Number(c.dataset.wait))) reloadWhenStill(); }
  else if (page === 'folder' && data.wait !== undefined && root === data.root && n > data.wait) reloadWhenStill();
};
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
let bakeRevision = 0;
es.onmessage = (m) => {
  let ev;
  try { ev = JSON.parse(m.data); } catch { return; }
  if (ev.audits) { for (const [root, n] of Object.entries(ev.audits)) audited(root, n); return; }
  if (ev.audited) { audited(ev.audited, ev.n); return; }
  if (ev.bakes) {
    bakeRevision++;
    showPreviewBar(ev.previewBar);
    for (const card of ev.cards) updateCard(card);
    if (previews) {
      previewSummary.textContent = ev.previews.summary;
      previewPause.dataset.action = ev.bakes.paused ? 'resume' : 'pause';
      previewPause.textContent = data.words[previewPause.dataset.action];
      const active = document.activeElement?.dataset.package;
      previewRows.innerHTML = ev.previews.rows;
      if (active) previewRows.querySelector(`button[data-package="${CSS.escape(active)}"]`)?.focus();
      previewClock();
    }
    return;
  }
  if (page === 'front') {
    if (ev.list) location.reload();
  } else if (page === 'folder') {
    if (data.package && ev.package === data.package) {
      if (playing()) offerReload(); else location.reload();
      return;
    }
    const here = data.rel ? `${data.root}/${data.rel}` : data.root;
    if (ev.folders?.some((f) => f === here || f.startsWith(`${here}/`) && !f.slice(here.length + 1).includes('/'))) offerReload();
  }
};

function runningBarWords(words, status) {
  if (status === 'stopped' || status === 'lost') return [words[status], '', ''];
  const mb = status.memory / 2 ** 20;
  const memory = mb < 1024 ? `${mb.toFixed(0)} MB` : `${(mb / 1024).toFixed(1)} GB`;
  const editors = status.editors.length;
  return [words.running,
    editors === 0 ? '' : editors === 1 ? words.editor : words.editors.replace('{count}', editors),
    words.memory.replace('{memory}', memory)];
}

const running = document.getElementById('running');
const words = JSON.parse(running.dataset.words);
const runningParts = ['running-state', 'running-editors', 'running-memory'].map((id) => document.getElementById(id));
const runningPreviews = document.getElementById('running-previews');
function showPreviewBar(text) {
  if (runningPreviews.textContent !== text) runningPreviews.textContent = text;
  runningPreviews.hidden = !text;
}
const stopButton = running.querySelector('button');
const showStatus = (status) => {
  const parts = runningBarWords(words, status);
  runningParts.forEach((el, i) => { if (el.textContent !== parts[i]) el.textContent = parts[i]; });
  running.classList.toggle('warning', status === 'lost');
  stopButton.hidden = !status.stoppable;
  if (typeof status === 'string') showPreviewBar('');
};

let statusPending = false, statusFailures = 0, stopping = false, stopped = false;
const refreshStatus = async () => {
  if (statusPending || stopping || stopped) return;
  statusPending = true;
  const revision = bakeRevision;
  try {
    const res = await fetch(previews ? '/api/status?previews=1' : '/api/status', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error();
    const status = await res.json();
    if (!status.ok) throw new Error();
    if (stopping || stopped) return;
    if (statusFailures >= 2) return location.reload();
    statusFailures = 0;
    showStatus(status);
    if (revision === bakeRevision) {
      showPreviewBar(status.previewBar);
      if (previews && previewSummary.textContent !== status.previewLine) previewSummary.textContent = status.previewLine;
    }
  } catch {
    if (!stopping && !stopped && ++statusFailures >= 2) showStatus('lost');
  } finally { statusPending = false; }
};
const statusTimer = setInterval(() => { if (document.visibilityState === 'visible') void refreshStatus(); }, 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshStatus(); });
void refreshStatus();

for (const b of $$('[data-stop-topotopo]')) b.addEventListener('click', stopTopoTopo);
async function stopTopoTopo(e) {
  if (stopping || stopped) return;
  stopping = true;
  const b = e.currentTarget;
  const banner = b.closest('.changed');
  b.disabled = true;
  try {
    const r = await fetch('/api/stop', { method: 'POST', headers: { 'x-topotopo-open': '1' } });
    if (!r.ok) throw new Error(`the web app answered ${r.status}`);
    stopped = true;
    clearInterval(statusTimer);
    es.close();
    showStatus('stopped');
    if (banner) banner.textContent = words.stopped;
  } catch (e) {
    const text = `TopoTopo could not be stopped from here (${e.message}).`;
    if (banner) banner.textContent = text;
    else runningParts[0].textContent = text;
    b.disabled = false;
  } finally { stopping = false; }
}
