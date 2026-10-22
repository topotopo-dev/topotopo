// The Outputs tab: each graph's published outputs as cards (click one to see it alone, its textures below it), one
// Export button each, Export all for every output with a target, and the files saved in exports/. A first Export
// asks for a format and file (export-popover.js) and stores that target in the graph; later clicks just write it.
import { createImageView } from './image-view.js';
import { fmtBytes } from './units.js';
import { exportPopover, defaultPath } from './export-popover.js';
import { inputImageURL } from './layers.js';

const url = (route, item, more = {}) => `/api/output/${route}?` + new URLSearchParams({ id: item.id, rev: item.revision, ...more });
const text = (tag, value, cls) => { const e = document.createElement(tag); e.textContent = value; if (cls) e.className = cls; return e; };
const post = async (route, body) => {
  const r = await fetch('/api/output/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `${route} failed (${r.status})` }));
  if (!r.ok || !j.ok) throw new Error(j.error ?? `${route} failed (${r.status})`);
  return j;
};
/** "just now", "5 min ago", "3 h ago", else the date */
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}
/** A target as the graph stores it: the format alone when the path is the default, else {format, path}. */
export function targetSpec(item, choice, formats) {
  const stem = item.output ?? item.graph ?? 'output';
  const keep = item.target && item.target.format === choice.format ? item.target.options ?? {} : {};
  const custom = choice.path !== defaultPath(stem, choice.format, formats);
  return !custom && !Object.keys(keep).length ? choice.format : { format: choice.format, ...(custom ? { path: choice.path } : {}), ...keep };
}

export function createOutputPanel(ctx) {
  const host = document.getElementById('outputs'), details = document.getElementById('output-details');
  const image = createImageView(document.getElementById('viewport'), ctx.message);
  let list = [], formats = [], selected = null, directory = '', sequence = 0, lastList = '', initial = true, refreshing = null, refreshAgain = false, busy = false;
  const P = { active: null };
  const bar = document.createElement('div'), all = text('button', 'Export all', 'primary'), barNote = text('span', '', 'dim');
  bar.className = 'outputs-bar'; bar.append(all, barNote);
  const live = document.createElement('div'), saved = document.createElement('details'), savedRows = document.createElement('div');
  saved.className = 'saved-outputs'; saved.open = ctx.store.get('outputs.savedOpen', false);
  saved.append(text('summary', 'Saved files'), savedRows); saved.ontoggle = () => ctx.store.set('outputs.savedOpen', saved.open);
  const empty = text('div', 'Nothing published yet: a graph\'s output shows here once it cooks.', 'empty');
  const cards = new Map(), groups = new Map(); let input = null;
  host.append(bar, empty, live, saved);
  Object.defineProperty(P, 'count', { get: () => list.filter((v) => v.exportable).length });

  function showDetails(item) {
    details.replaceChildren(); details.hidden = !item;
    if (!item) return;
    details.append(text('strong', item.label), text('p', item.error ?? item.summary ?? `${item.kind}${item.width ? ` · ${item.width} × ${item.height}` : ''}`, item.error ? 'err' : 'dim'));
    if (item.exportable) details.append(text('p', item.target ? `exports to exports/${item.target.path} (${item.target.format})` : 'no export target yet: its Export button sets one', 'dim'));
    if (item.files) for (const f of item.files) {
      const a = text('a', `${f.name} · ${fmtBytes(f.size)}`); a.href = url('file', item, { file: f.id, download: '1' }); a.download = f.name; details.append(a);
    }
    if (item.files?.length > 1) { const a = text('a', 'Download ZIP'); a.href = url('zip', item); a.download = item.label + '.zip'; details.append(a); }
  }
  const targetLine = (item) => !item.target ? 'no export target'
    : `${item.target.path}${item.saved ? ` · saved ${ago(item.saved.at)} · ${fmtBytes(item.saved.size)}` : ' · not exported yet'}`;

  async function exportItem(item, button, change = false) {
    if (busy) return;
    let choice = null;
    if (change || !item.target) {
      choice = await exportPopover({ anchor: button, item, formats, directory });
      if (!choice) return;
    }
    busy = true; render();
    ctx.message(`exporting ${item.label}…`, 'busy');
    try {
      const j = await post('export', { id: item.id, ...(choice ? { export: targetSpec(item, choice, formats) } : {}) });
      ctx.message(`exported ${item.label} → exports/${j.path}${j.files > 1 ? ` (${j.files} files)` : ''}${j.warnings?.length ? ' · ' + j.warnings.join('; ') : ''}`, j.warnings?.length ? 'err' : 'ok', 7000);
    } catch (e) { ctx.message(e.message, 'err', 10000); }
    finally { busy = false; await P.refresh(); render(); }
  }
  async function clearTarget(item) {
    try { await post('export', { id: item.id, export: null }); ctx.message(`${item.label} has no export target now`); }
    catch (e) { ctx.message(e.message, 'err', 10000); }
    await P.refresh();
  }
  all.onclick = async () => {
    if (busy) return;
    busy = true; render(); ctx.message('exporting all outputs with a target…', 'busy');
    try {
      const j = await post('export-all', {});
      const warnings = j.written.flatMap((w) => w.warnings ?? []);
      ctx.message(`exported ${j.written.length} output${j.written.length === 1 ? '' : 's'}${j.skipped.length ? ` · ${j.skipped.length} without a target (their Export button sets one)` : ''}${warnings.length ? ' · ' + warnings.join('; ') : ''}`, warnings.length ? 'err' : 'ok', 8000);
    } catch (e) { ctx.message(e.message, 'err', 10000); }
    finally { busy = false; await P.refresh(); render(); }
  };

  function render() {
    const used = new Set(), usedGroups = new Set(), grouped = new Map();
    for (const item of list) {
      const name = item.origin === 'published' ? item.graph ?? 'Outputs' : '__saved';
      if (!grouped.has(name)) grouped.set(name, []); grouped.get(name).push(item);
    }
    const published = list.filter((v) => v.exportable), withTarget = published.filter((v) => v.target);
    all.disabled = busy || !withTarget.length;
    all.textContent = busy ? 'Exporting…' : 'Export all';
    all.title = withTarget.length ? `write every output that has an export target (${withTarget.length}) into exports/` : 'export an output with its button first: that sets its target';
    barNote.textContent = published.length ? `${withTarget.length} of ${published.length} with a target` : '';
    bar.hidden = !published.length; empty.hidden = !!list.length;
    for (const [name, entries] of grouped) {
      let group = groups.get(name);
      if (!group) {
        const box = document.createElement('div'), rows = document.createElement('div');
        if (name !== '__saved') box.append(text('div', name, 'output-group'));
        box.append(rows); group = { box, rows }; groups.set(name, group);
      }
      usedGroups.add(name);
      const parent = name === '__saved' ? savedRows : live;
      if (group.box.parentElement !== parent) parent.append(group.box);
      const ordered = [], seen = new Set(), ids = new Set(entries.map((item) => item.id));
      const visit = (item) => { if (seen.has(item.id)) return; seen.add(item.id); ordered.push(item); for (const child of entries) if (child.parent === item.id) visit(child); };
      for (const item of entries) if (!ids.has(item.parent)) visit(item);
      for (const item of entries) visit(item);
      let previous = null;
      for (const item of ordered) {
        used.add(item.id); let card = cards.get(item.id);
        if (!card) {
          const row = document.createElement('div'); row.className = 'output-card'; row.tabIndex = 0; row.setAttribute('role', 'button'); row.dataset.output = item.id;
          const thumb = document.createElement('img'); thumb.loading = 'lazy'; thumb.alt = '';
          const icon = text('span', 'FILE', 'file-icon'), body = text('span', '', 'output-body'), label = text('span', '', 'output-label'), info = text('small', '', 'dim');
          const target = text('button', '', 'output-target'), go = text('button', 'Export', 'output-export');
          target.title = 'change where this output exports'; go.type = target.type = 'button';
          body.append(label, info, target); row.append(thumb, icon, body, go);
          card = { row, thumb, icon, label, info, target, go, item }; cards.set(item.id, card);
          go.onclick = () => exportItem(card.item, go);
          target.onclick = () => exportItem(card.item, go, true);
          row.onclick = (e) => { if (!e.target.closest('input,button')) P.select(card.item.id); };
          row.onkeydown = (e) => { if (e.target === row && ['Enter', ' '].includes(e.key)) { e.preventDefault(); P.select(card.item.id); } if (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') { e.preventDefault(); contextMenu(card.item, row.getBoundingClientRect().left, row.getBoundingClientRect().bottom); } };
          row.oncontextmenu = (e) => { e.preventDefault(); contextMenu(card.item, e.clientX, e.clientY); };
          thumb.onerror = () => { thumb.hidden = true; icon.hidden = false; };
        }
        card.item = item;
        const { row, thumb, icon, label, info, target, go } = card;
        row.classList.toggle('selected', item.id === selected); row.classList.toggle('child', !!item.parent);
        row.setAttribute('aria-label', `${item.label} — ${item.kind}`); row.setAttribute('aria-pressed', String(item.id === selected));
        go.hidden = target.hidden = !item.exportable; go.disabled = busy || item.status === 'loading';
        go.title = item.target ? `write exports/${item.target.path} again (overwrites it)` : 'choose a format and file, then export';
        go.setAttribute('aria-label', `Export ${item.label}`);
        target.textContent = item.exportable ? targetLine(item) : ''; target.classList.toggle('unset', !item.target);
        const src = ['geometry', 'image'].includes(item.kind) && item.status !== 'loading' ? item.kind === 'image' && !item.generated ? url('file', item) : url('thumb', item) : '';
        if (thumb.dataset.source !== src) { thumb.dataset.source = src; thumb.hidden = !src; icon.hidden = !!src; if (src) thumb.src = src; }
        icon.textContent = item.kind === 'geometry' ? '3D' : item.kind === 'image' ? 'IMG' : item.kind.toUpperCase();
        label.textContent = item.label; info.textContent = item.error ?? (item.status === 'loading' ? 'Cooking…' : `${item.kind}${item.width ? ` · ${item.width}×${item.height}` : ''}`); info.className = item.error ? 'err' : 'dim';
        const next = previous ? previous.nextSibling : group.rows.firstChild; if (row !== next) group.rows.insertBefore(row, next); previous = row;
      }
    }
    for (const [id, card] of cards) if (!used.has(id)) { card.row.remove(); cards.delete(id); }
    for (const [name, group] of groups) if (!usedGroups.has(name)) { group.box.remove(); groups.delete(name); }
    const savedCount = list.filter((v) => v.origin === 'saved' && !v.parent).length;
    saved.hidden = !savedCount;
    saved.querySelector('summary').textContent = `Saved files (${savedCount})`;
  }
  // "saved 2 min ago" keeps up without a refresh
  setInterval(() => { for (const card of cards.values()) if (card.item.exportable) card.target.textContent = targetLine(card.item); }, 30000);

  let menu = null, dismissMenu = () => {};
  function contextMenu(item, x, y) {
    dismissMenu(); const previous = document.activeElement;
    menu = document.createElement('div'); menu.className = 'output-menu'; menu.setAttribute('role', 'menu');
    const close = () => { menu?.remove(); menu = null; removeEventListener('pointerdown', outside, true); removeEventListener('blur', close); previous?.focus(); };
    const outside = (e) => { if (!menu?.contains(e.target)) close(); }; dismissMenu = close;
    const add = (label, action) => { const button = text('button', label); button.setAttribute('role', 'menuitem'); button.onclick = () => { close(); action(); }; menu.append(button); };
    const download = (href, name) => { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); };
    add(item.origin === 'saved' ? 'Open' : 'Preview', () => P.select(item.id));
    if (item.kind === 'geometry') add('Frame', async () => { await P.select(item.id); ctx.frameOutput(); });
    if (item.exportable) {
      const go = cards.get(item.id)?.go;
      add(item.target ? `Export to ${item.target.path}` : 'Export…', () => exportItem(item, go));
      add('Change export target…', () => exportItem(item, go, true));
      if (item.target) add('Remove export target', () => clearTarget(item));
    } else if (item.generated && item.kind === 'image') add('Download PNG', () => download(url('image', item, { mode: 'RGBA', download: '1' }), item.label + '.png'));
    else if (item.files?.length) add(item.files.length > 1 ? 'Download ZIP' : 'Download', () => download(item.files.length > 1 ? url('zip', item) : url('file', item, { download: '1' }), item.label));
    document.body.append(menu); menu.style.left = Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4)) + 'px'; menu.style.top = Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4)) + 'px';
    menu.onkeydown = (e) => { const buttons = [...menu.children], i = buttons.indexOf(document.activeElement); if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); } else if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); } };
    menu.firstChild.focus(); addEventListener('pointerdown', outside, true); addEventListener('blur', close);
  }
  P.select = async (id, update = false) => {
    const item = input?.id === id ? input : list.find((v) => v.id === id); if (!item) return;
    const changedSelection = selected !== id;
    if (!update) ctx.rememberOutputView?.(selected);
    const seq = ++sequence;
    if (changedSelection) { image.hide(); ctx.hideModelPreview(); }
    selected = id; P.active = item; ctx.isolated = true; ctx.guides.setMode(null);
    render(); showDetails(item);
    if (item.status === 'loading') { ctx.message('Preparing ' + item.label, 'busy'); return; }
    if (item.status === 'error') { ctx.message(item.error, 'err'); return; }
    await ctx.outputGraph?.(item);
    if (seq !== sequence) return;
    if (item.kind === 'image') { ctx.hideModelPreview(); image.show(item); ctx.message(item.label); ctx.emit('output'); return; }
    image.hide();
    if (item.kind !== 'geometry') { ctx.hideModelPreview(); return; }
    try {
      const r = await fetch(url('geo', item));
      if (!r.ok) throw new Error((await r.json()).error);
      const bytes = await r.arrayBuffer(); if (seq !== sequence) return;
      await ctx.previewOutput(item, bytes, update);
      ctx.message(item.label);
    } catch (e) { if (seq === sequence) ctx.message(e.message, 'err'); }
  };
  P.scene = () => {
    sequence++; initial = false; ctx.rememberOutputView?.(selected); selected = null; P.active = null;
    image.hide(); ctx.isolated = false; showDetails(null); render(); ctx.restoreScene();
  };
  P.refresh = async () => {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      try {
        const response = await fetch('/api/outputs'), j = await response.json(); if (!response.ok) throw new Error(j.error);
        directory = j.directory; formats = j.formats ?? [];
        const signature = JSON.stringify(j.items);
        if (signature === lastList) return;
        lastList = signature; const before = P.active; list = j.items;
        const after = input?.id === selected ? input : list.find((v) => v.id === selected); render(); ctx.emit('outputs');
        if (after && (after.revision !== before?.revision || after.status !== before?.status)) await P.select(after.id, true);
        else if (after) { P.active = after; showDetails(after); }
        else if (selected && !after) P.scene();
        else if (initial && list.length) { initial = false; const main = list.find((v) => v.generated && !v.parent); if (main) await P.select(main.id); }
      } catch (e) { ctx.message(e.message, 'err'); }
      finally { refreshing = null; if (refreshAgain) { refreshAgain = false; void P.refresh(); } }
    })();
    return refreshing;
  };
  document.getElementById('scene-view').onclick = P.scene;
  P.openInput = async (path, update = false) => {
    const f = ctx.layers.list.find((v) => v.path === path); if (!f) return;
    input = { id: 'input:' + path, inputPath: path, label: path, kind: 'image', status: 'ready', revision: `${f.mtime}:${f.size}`, sourceURL: inputImageURL(f), summary: ctx.layers.info.get(path)?.summary ?? ctx.layers.fileText(f) };
    await P.select(input.id, update);
  };
  ctx.on('layers', () => {
    if (!P.active?.inputPath) return;
    const f = ctx.layers.list.find((v) => v.path === P.active.inputPath);
    if (!f) P.scene(); else if (`${f.mtime}:${f.size}` !== P.active.revision) P.openInput(f.path, true);
  });
  return P;
}
