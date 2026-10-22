import { createImageView } from './image-view.js';
import { fmtBytes } from './units.js';
import { createExportUI } from './export-ui.js';
import { inputImageURL } from './layers.js';

const url = (route, item, more = {}) => `/api/output/${route}?` + new URLSearchParams({ id: item.id, rev: item.revision, ...more });
const text = (tag, value, cls) => { const e = document.createElement(tag); e.textContent = value; if (cls) e.className = cls; return e; };
export function createOutputPanel(ctx) {
  const host = document.getElementById('outputs'), details = document.getElementById('output-details');
  const image = createImageView(document.getElementById('viewport'), ctx.message);
  let list = [], selected = null, directory = '', sequence = 0, lastList = '', initial = true, refreshing = null, refreshAgain = false;
  const P = { active: null };
  const live = document.createElement('div'), saved = document.createElement('details'), savedRows = document.createElement('div');
  saved.className = 'saved-outputs'; saved.open = ctx.store.get('outputs.savedOpen', false);
  saved.append(text('summary', 'Saved files'), savedRows); saved.ontoggle = () => ctx.store.set('outputs.savedOpen', saved.open);
  const cards = new Map(), groups = new Map(); let input = null;
  const exports = createExportUI(ctx, { items: () => list, directory: () => directory, refresh: () => P.refresh(), changed: () => render() });
  host.append(live, exports.bar, saved);
  Object.defineProperty(P, 'count', { get: () => list.filter((v) => v.origin === 'published').length });
  function showDetails(item) {
    details.replaceChildren(); details.hidden = !item;
    if (!item) return;
    details.append(text('strong', item.label), text('p', item.error ?? item.summary ?? `${item.kind}${item.width ? ` · ${item.width} × ${item.height}` : ''}`, item.error ? 'err' : 'dim'));
    if (item.files) for (const f of item.files) {
      const a = text('a', `${f.name} · ${fmtBytes(f.size)}`); a.href = url('file', item, { file: f.id, download: '1' }); a.download = f.name; details.append(a);
    }
    if (item.files?.length > 1) { const a = text('a', 'Download ZIP'); a.href = url('zip', item); a.download = item.label + '.zip'; details.append(a); }
  }
  function render() {
    exports.sync();
    const used = new Set(), usedGroups = new Set();
    const grouped = new Map();
    for (const item of list) {
      const name = item.origin === 'published' ? item.graph ?? 'Outputs' : '__saved';
      if (!grouped.has(name)) grouped.set(name, []); grouped.get(name).push(item);
    }
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
          const check = document.createElement('input'); check.type = 'checkbox';
          const thumb = document.createElement('img'); thumb.loading = 'lazy'; thumb.alt = '';
          const icon = text('span', 'FILE', 'file-icon'), body = text('span', '', 'output-body'), label = text('span', '', 'output-label'), info = text('small', '', 'dim'), edit = text('button', 'E', 'output-edit');
          body.append(label, info); row.append(check, thumb, icon, body, edit);
          card = { row, check, thumb, icon, label, info, edit, item }; cards.set(item.id, card);
          check.onchange = () => exports.check(card.item, check.checked);
          edit.onclick = () => exports.dialog('override', card.item);
          row.onclick = (e) => { if (!e.target.closest('input,button')) P.select(card.item.id); };
          row.onkeydown = (e) => { if (e.target === row && ['Enter', ' '].includes(e.key)) { e.preventDefault(); P.select(card.item.id); } if (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') { e.preventDefault(); contextMenu(card.item, row.getBoundingClientRect().left, row.getBoundingClientRect().bottom); } };
          row.oncontextmenu = (e) => { e.preventDefault(); contextMenu(card.item, e.clientX, e.clientY); };
          thumb.onerror = () => { thumb.hidden = true; icon.hidden = false; };
        }
        card.item = item;
        const { row, check, thumb, icon, label, info, edit } = card;
        row.classList.toggle('selected', item.id === selected); row.classList.toggle('child', !!item.parent);
        row.setAttribute('aria-label', `${item.label} — ${item.kind}`); row.setAttribute('aria-pressed', String(item.id === selected));
        check.hidden = edit.hidden = !item.exportable; check.disabled = edit.disabled = !exports.ready;
        check.checked = exports.isChecked(item); check.setAttribute('aria-label', `Include ${item.label} in export`);
        edit.title = exports.hasOverride(item) ? 'Export settings — override active' : 'Export settings — project defaults'; edit.setAttribute('aria-label', `Export settings for ${item.label}`); edit.classList.toggle('on', exports.hasOverride(item));
        const src = ['geometry', 'image'].includes(item.kind) && item.status !== 'loading' ? item.kind === 'image' && !item.generated ? url('file', item) : url('thumb', item) : '';
        if (thumb.dataset.source !== src) { thumb.dataset.source = src; thumb.hidden = !src; icon.hidden = !!src; if (src) thumb.src = src; }
        icon.textContent = item.kind === 'geometry' ? '3D' : item.kind === 'image' ? 'IMG' : item.kind.toUpperCase();
        label.textContent = item.label; info.textContent = item.error ?? (item.status === 'loading' ? 'Cooking…' : `${item.kind}${item.width ? ` · ${item.width}×${item.height}` : ''}`); info.className = item.error ? 'err' : 'dim';
        const next = previous ? previous.nextSibling : group.rows.firstChild; if (row !== next) group.rows.insertBefore(row, next); previous = row;
      }
    }
    for (const [id, card] of cards) if (!used.has(id)) { card.row.remove(); cards.delete(id); }
    for (const [name, group] of groups) if (!usedGroups.has(name)) { group.box.remove(); groups.delete(name); }
    saved.querySelector('summary').textContent = `Saved files (${list.filter((v) => v.origin === 'saved' && !v.parent).length})`;
  }
  let menu = null, dismissMenu = () => {};
  function contextMenu(item, x, y) {
    dismissMenu(); const previous = document.activeElement;
    menu = document.createElement('div'); menu.className = 'output-menu'; menu.setAttribute('role', 'menu');
    const close = () => { menu?.remove(); menu = null; removeEventListener('pointerdown', outside, true); removeEventListener('blur', close); previous?.focus(); };
    const outside = (e) => { if (!menu?.contains(e.target)) close(); }; dismissMenu = close;
    const add = (label, action) => { const button = text('button', label); button.setAttribute('role', 'menuitem'); button.onclick = () => { close(); action(); }; menu.append(button); };
    add(item.origin === 'saved' ? 'Open' : 'Preview', () => P.select(item.id));
    if (item.kind === 'geometry') add('Frame', async () => { await P.select(item.id); ctx.frameOutput(); });
    if (item.exportable) {
      add(exports.isChecked(item) ? 'Exclude from export' : 'Include in export', () => exports.check(item, !exports.isChecked(item)));
      add('Export…', () => exports.dialog('once', item)); add('Export settings…', () => exports.dialog('override', item));
      if (exports.hasOverride(item)) add('Reset export overrides', () => exports.reset(item));
    } else if (item.files?.length) add(item.files.length > 1 ? 'Download ZIP' : 'Download', () => { const a = document.createElement('a'); a.href = item.files.length > 1 ? url('zip', item) : url('file', item, { download: '1' }); a.download = item.label; a.click(); });
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
        directory = j.directory; await exports.reload(); const signature = JSON.stringify(j.items);
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
  const picker = document.getElementById('image-file');
  document.getElementById('open-image').onclick = () => picker.click();
  picker.onchange = () => { ctx.layers.upload([...picker.files], []); picker.value = ''; };
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
