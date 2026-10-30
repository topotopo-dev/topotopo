// The Outputs tab: each graph's published outputs as cards (click one to see it alone, its textures below it). A card
// says what the output is (a mesh, a heightfield, packed instances … and its size: the server decides it from the
// cooked geometry) and has two buttons: Download gets the export as a browser download (the file itself, or a zip of
// its files) and Export writes it to its target in exports/, the files graph export targets and agents use. Both offer
// the formats that write the output (export-popover.js); a first Export stores its target in the graph, later clicks
// write it again. Export all writes every target. Files saved in exports/ are cards too, downloaded as they are.
import { createImageView } from './image-view.js';
import { fmtBytes } from './units.js';
import { exportPopover, defaultPath, downloadSpec, filenameOf, inFolder } from './export-popover.js';
import { kindLine, detailLine, kindBadge, kindTagsLine, liveText, layerChoices, shownLayer } from './output-info.js';
import { inputImageURL } from './layers.js';

const url = (route, item, more = {}) => `/api/output/${route}?` + new URLSearchParams({ id: item.id, rev: item.revision, ...more });
const text = (tag, value, cls) => { const e = document.createElement(tag); e.textContent = value; if (cls) e.className = cls; return e; };
const post = async (route, body) => {
  const r = await fetch('/api/output/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `${route} failed (${r.status})` }));
  if (!r.ok || !j.ok) throw new Error(j.error ?? `${route} failed (${r.status})`);
  return j;
};
/** The browser saves `href` (a route, or a blob's URL) as `name`. */
const save = (href, name) => { const a = document.createElement('a'); a.href = href; a.download = name; document.body.append(a); a.click(); a.remove(); };
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
  // a result shown alone that is no card of this tab (a place of an update's before/after, packages.js)
  let other = null;
  const P = { active: null };
  const bar = document.createElement('div'), all = text('button', 'Export all'), barNote = text('span', '', 'dim');
  bar.className = 'outputs-bar'; bar.append(all, barNote, ctx.thumbSizeButton());
  const live = document.createElement('div'), saved = document.createElement('details'), savedRows = document.createElement('div');
  saved.className = 'saved-outputs'; saved.open = ctx.store.get('outputs.savedOpen', false);
  saved.append(text('summary', 'Saved files'), savedRows); saved.ontoggle = () => ctx.store.set('outputs.savedOpen', saved.open);
  const empty = text('div', 'No outputs yet: the results of the project\'s graphs show here once your agent has built one.', 'empty');
  const cards = new Map(), groups = new Map(); let input = null;
  host.append(bar, empty, live, saved);
  Object.defineProperty(P, 'count', { get: () => list.filter((v) => v.exportable).length });
  // the heightfield layer each output shows in red, remembered in this browser
  const chosenLayers = ctx.store.get('outputs.layers', {});
  P.layerOf = (item) => shownLayer(item.heightfield, chosenLayers[item.id]);

  /** Where an export target's files go, in full: the person finds them there. */
  const targetFile = (item) => inFolder(directory, item.target.path);
  function showDetails(item) {
    details.replaceChildren(); details.hidden = !item;
    if (!item) return;
    details.append(text('strong', item.label));
    if (item.details) { item.details(details); return; }
    const what = kindLine(item);
    if (what) details.append(text('p', what, 'output-kind'));
    if (item.warning) details.append(text('p', item.warning, 'warn'));
    if (item.heightfield && item.view === 'model' && !item.inputPath) {
      // the terrain coloured by one of its layers, in red over the height ramp
      const choice = document.createElement('select'); choice.setAttribute('aria-label', 'Layer drawn in red');
      for (const o of layerChoices(item.heightfield)) choice.append(new Option(o.label, o.value));
      choice.value = P.layerOf(item);
      choice.onchange = () => { chosenLayers[item.id] = choice.value; ctx.store.set('outputs.layers', chosenLayers); choice.blur(); P.select(item.id, true); };
      const row = document.createElement('label'); row.className = 'layer-pick'; row.title = 'the heightfield layer drawn in red over the terrain: 0..1 layers as they are, others from their minimum to their maximum';
      row.append(text('span', 'Layer in red', 'dim'), choice);
      details.append(row);
    }
    if (item.error) details.append(text('p', item.error, 'err'));
    else if (item.summary) { const f = document.createElement('details'); f.className = 'fold'; f.append(text('summary', 'Geometry details'), text('pre', item.summary, 'summary')); details.append(f); }
    if (item.exportable) details.append(text('p', item.target ? `Export writes ${targetFile(item)} (${item.target.format})` : 'Export asks for a format and a file in exports/ the first time; Download gives you a copy without that', 'dim'));
    if (item.live?.length) details.append(text('p', liveText(item), 'live'));
    if (item.files) {
      if (item.origin === 'saved' && !item.parent) details.append(text('p', `in ${directory}`, 'dim'));
      for (const f of item.files) {
        const a = text('a', `${f.name} · ${f.about ? f.about + ' · ' : ''}${fmtBytes(f.size)}`); a.href = url('file', item, { file: f.id, download: '1' }); a.download = f.name; details.append(a);
      }
    }
    if (item.files?.length > 1) { const a = text('a', `Download all as ${item.download?.zip ? item.download.name : item.label + '.zip'}`); a.href = url('zip', item); a.download = item.download?.name ?? item.label + '.zip'; details.append(a); }
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
      ctx.message(`exported ${item.label} → ${j.file ?? 'exports/' + j.path}${j.files > 1 ? ` (${j.files} files)` : ''}${j.warnings?.length ? ' · ' + j.warnings.join('; ') : ''}`, j.warnings?.length ? 'err' : 'ok', 7000);
    } catch (e) { ctx.message(e.message, 'err', 10000); }
    finally { busy = false; await P.refresh(); render(); }
  }
  /** A card's Download: a published output in a format of choice, a texture as a PNG, a saved file as it is. */
  async function downloadItem(item, button) {
    if (!item.exportable) {
      if (item.generated && item.view === 'image') save(url('image', item, { mode: 'RGBA', download: '1' }), item.label + '.png');
      else if (item.download) save(item.download.zip ? url('zip', item) : url('file', item, { download: '1' }), item.download.name);
      return;
    }
    const choice = await exportPopover({ anchor: button, item, formats, directory, mode: 'download' });
    if (!choice) return;
    ctx.message(`preparing the download of ${item.label}…`, 'busy');
    try {
      const r = await fetch('/api/output/download', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id, export: downloadSpec(item, choice.format) }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `download failed (${r.status})`);
      const blob = await r.blob(), name = filenameOf(r.headers.get('content-disposition')) ?? `${item.label}.zip`, n = Number(r.headers.get('x-file-count') ?? 1);
      const href = URL.createObjectURL(blob);
      save(href, name); setTimeout(() => URL.revokeObjectURL(href), 60000);
      ctx.message(`downloaded ${name} · ${fmtBytes(blob.size)}${n > 1 ? ` · ${n} files` : ''}`, 'ok', 7000);
    } catch (e) { ctx.message(e.message, 'err', 10000); }
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
      ctx.message(`exported ${j.written.length} output${j.written.length === 1 ? '' : 's'} into ${directory}${j.skipped.length ? ` · ${j.skipped.length} without a target (their Export button sets one)` : ''}${warnings.length ? ' · ' + warnings.join('; ') : ''}`, warnings.length ? 'err' : 'ok', 8000);
    } catch (e) { ctx.message(e.message, 'err', 10000); }
    finally { busy = false; await P.refresh(); render(); }
  };

  function render() {
    const used = new Set(), usedGroups = new Set(), grouped = new Map();
    // the project's default graph first
    const first = ctx.project?.project?.graph;
    if (first && list.some((v) => v.origin === 'published' && v.graph === first)) grouped.set(first, []);
    for (const item of list) {
      const name = item.origin === 'published' ? item.graph ?? 'Outputs' : '__saved';
      if (!grouped.has(name)) grouped.set(name, []); grouped.get(name).push(item);
    }
    const published = list.filter((v) => v.exportable), withTarget = published.filter((v) => v.target);
    all.disabled = busy || !withTarget.length;
    all.textContent = busy ? 'Exporting…' : 'Export all';
    all.title = withTarget.length ? `write every output that has an export target (${withTarget.length}) into ${directory}` : 'export an output with its button first: that sets its target';
    barNote.textContent = published.length ? `${withTarget.length} of ${published.length} with an export target` : '';
    // the bar holds the thumbnail size while there are cards; Export all while some are published
    all.hidden = barNote.hidden = !published.length; bar.hidden = !list.length; empty.hidden = !!list.length;
    for (const [name, entries] of grouped) {
      let group = groups.get(name);
      if (!group) {
        const box = document.createElement('div'), rows = document.createElement('div'), head = text('div', name, 'output-group');
        if (name !== '__saved') box.append(head);
        box.append(rows); group = { box, rows, head }; groups.set(name, group);
      }
      // a graph whose one result is named after it needs no heading of its own
      group.head.hidden = entries.filter((v) => !v.parent).length === 1 && entries[0].label === name;
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
          // the picture keeps what it showed while the result cooks again; a mark over it says it is cooking
          const pic = text('span', '', 'output-pic'), thumb = document.createElement('img'); thumb.loading = 'lazy'; thumb.alt = '';
          const icon = text('span', 'FILE', 'file-icon'), cooking = text('span', 'cooking…', 'output-cooking');
          pic.append(thumb, icon, cooking);
          const body = text('span', '', 'output-body'), head = text('span', '', 'output-head'), label = text('span', '', 'output-label');
          const badges = text('span', '', 'output-badges'), info = text('small', '', 'dim'), tags = text('span', '', 'output-tags');
          const target = text('button', '', 'output-target'), actions = text('span', '', 'output-actions');
          const down = text('button', 'Download', 'primary output-download'), go = text('button', 'Export', 'output-export');
          target.title = 'change where this output exports'; go.type = target.type = down.type = 'button';
          head.append(label, badges);
          actions.append(down, go); body.append(head, info, tags, target, actions); row.append(pic, body);
          card = { row, thumb, icon, label, badges, info, tags, target, down, go, item }; cards.set(item.id, card);
          down.onclick = () => downloadItem(card.item, down);
          go.onclick = () => exportItem(card.item, go);
          target.onclick = () => exportItem(card.item, go, true);
          row.onclick = (e) => { if (!e.target.closest('input,button')) P.select(card.item.id); };
          row.onkeydown = (e) => { if (e.target === row && ['Enter', ' '].includes(e.key)) { e.preventDefault(); P.select(card.item.id); } if (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') { e.preventDefault(); contextMenu(card.item, row.getBoundingClientRect().left, row.getBoundingClientRect().bottom); } };
          row.oncontextmenu = (e) => { e.preventDefault(); contextMenu(card.item, e.clientX, e.clientY); };
          thumb.onerror = () => { thumb.hidden = true; icon.hidden = false; };
        }
        card.item = item;
        const { row, thumb, icon, label, badges, info, tags, target, down, go } = card;
        const what = kindLine(item), detail = detailLine(item);
        row.classList.toggle('selected', item.id === selected); row.classList.toggle('child', !!item.parent);
        row.classList.toggle('cooking', item.status === 'loading'); row.classList.toggle('stale', !!item.stale && item.status !== 'loading');
        row.setAttribute('aria-label', `${item.label} — ${what || item.view}`); row.setAttribute('aria-pressed', String(item.id === selected));
        go.hidden = target.hidden = !item.exportable; go.disabled = busy || item.status === 'loading';
        go.title = item.target ? `write ${targetFile(item)} again (overwrites it)` : `choose a format and a file in ${directory || 'exports/'}, then export`;
        go.setAttribute('aria-label', `Export ${item.label}`);
        // Download: every card that has something to give (a published output, a texture, saved files)
        down.hidden = !(item.exportable || (item.generated && item.view === 'image') || item.download);
        down.disabled = item.exportable && (item.status !== 'ready' || !item.formats?.length);
        down.title = item.exportable ? (item.formats?.length ? 'choose a format and download the export (its files as one zip when there are several)' : item.status === 'ready' ? 'no format writes this output' : 'cooking…')
          : item.download ? `download ${item.download.name}` : `download ${item.label}.png`;
        down.setAttribute('aria-label', `Download ${item.label}`);
        target.textContent = item.exportable ? targetLine(item) : ''; target.classList.toggle('unset', !item.target);
        // while it cooks the card keeps its picture and its lines (the mark over the picture says it is cooking)
        const src = ['model', 'image'].includes(item.view) ? item.view === 'image' && !item.generated ? url('file', item) : url('thumb', item) : '';
        if (item.status !== 'loading' && thumb.dataset.source !== src) { thumb.dataset.source = src; thumb.hidden = !src; icon.hidden = !!src; if (src) thumb.src = src; }
        if (item.status === 'loading' && !thumb.dataset.source) { thumb.hidden = true; icon.hidden = false; }
        icon.textContent = item.view === 'model' ? '3D' : item.view === 'image' ? 'IMG' : (item.kind === 'metadata' ? 'JSON' : (item.files?.[0]?.name.split('.').pop() ?? 'file').toUpperCase().slice(0, 5));
        label.textContent = item.label;
        // the default output, and the kind in the words everything uses
        const marks = [];
        // the default among a graph's several results
        if (item.default && entries.filter((v) => !v.parent && v.exportable).length > 1) { const b = text('span', 'default', 'badge default'); b.title = 'the graph\'s default output: what the graph shows and exports when no output is named'; marks.push(b); }
        const kind = kindBadge(item);
        if (kind) { const b = text('span', kind, 'badge kind'); b.title = 'what it is'; marks.push(b); }
        // it uses a package shown live: unpublished edits on show (its exports use the published version)
        if (item.live?.length) { const b = text('span', 'unpublished edits', 'badge live'); b.title = liveText(item); marks.push(b); }
        badges.replaceChildren(...marks);
        tags.replaceChildren(...(item.tags ?? []).map((t) => text('span', t, 'tag')));
        tags.title = item.tags?.length ? kindTagsLine(item) : '';
        tags.hidden = !item.tags?.length;
        // an output that is not the kind its graph pins says so (publishing the project's package would block on it); one
        // whose cook was stopped shows the last finished result
        const warned = !item.error && item.warning;
        info.textContent = item.error ?? (item.stale ? `out of date: its cook was stopped · ${detail}` : warned ? `not a "${item.pinned}" · ${detail}` : detail || (item.status === 'loading' ? 'cooking…' : ''));
        info.className = item.error ? 'err' : warned || item.stale ? 'warn' : 'dim'; info.title = item.error ?? (warned ? `${what}\n${item.warning}` : item.stale ? 'its cook was stopped: the card shows the last finished result; change a value to cook it again' : what);
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
    const card = cards.get(item.id);
    add(item.origin === 'saved' ? 'Open' : 'Preview', () => P.select(item.id));
    if (item.view === 'model') add('Frame', async () => { await P.select(item.id); ctx.frameOutput(); });
    if (item.exportable) {
      if (item.formats?.length) add('Download…', () => downloadItem(item, card?.down));
      add(item.target ? `Export to ${item.target.path}` : 'Export…', () => exportItem(item, card?.go));
      add('Change export target…', () => exportItem(item, card?.go, true));
      if (item.target) add('Remove export target', () => clearTarget(item));
    } else if (item.generated && item.view === 'image') add('Download PNG', () => downloadItem(item));
    else if (item.download) add(item.download.zip ? `Download ${item.download.name}` : 'Download', () => downloadItem(item));
    document.body.append(menu); menu.style.left = Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4)) + 'px'; menu.style.top = Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4)) + 'px';
    menu.onkeydown = (e) => { const buttons = [...menu.children], i = buttons.indexOf(document.activeElement); if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); } else if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); } };
    menu.firstChild.focus(); addEventListener('pointerdown', outside, true); addEventListener('blur', close);
  }
  P.select = async (id, update = false) => {
    const item = input?.id === id ? input : other?.id === id ? other : list.find((v) => v.id === id); if (!item) return;
    const changedSelection = selected !== id;
    if (!update) ctx.rememberOutputView?.(selected);
    const seq = ++sequence;
    if (changedSelection) { image.hide(); ctx.hideModelPreview(); }
    selected = id; P.active = item; ctx.isolated = true; ctx.guides.setMode(null);
    render(); showDetails(item);
    // it shows once it has cooked (the card says it is cooking)
    if (item.status === 'loading') { ctx.emit('output'); return; }
    if (item.status === 'error') { ctx.message(item.error, 'err'); return; }
    await ctx.outputGraph?.(item);
    if (seq !== sequence) return;
    if (item.view === 'image') { ctx.hideModelPreview(); image.show(item); ctx.emit('output'); return; }
    image.hide();
    if (item.view !== 'model') { ctx.hideModelPreview(); ctx.message(`${item.label}: ${kindLine(item) || 'a file'} · Download gets it`); return; }
    try {
      let bytes;
      if (item.load) bytes = await item.load();
      else {
        const r = await fetch(url('geo', item, item.heightfield ? { heightfield_layer: P.layerOf(item) } : {}));
        if (!r.ok) throw new Error((await r.json()).error);
        bytes = await r.arrayBuffer();
      }
      if (seq !== sequence) return;
      await ctx.previewOutput(item, bytes, update);
    } catch (e) { if (seq === sequence) ctx.message(e.message, 'err'); }
  };
  /**
   * Show a result that is no card here alone in the view, as a card is (packages.js: a place of a before/after):
   * {id, label, view: 'model', status, revision, load() → GLB bytes, details(el) → what the details say, message?}.
   * `update`: the same result again (another side of it), which keeps its camera.
   */
  P.isolate = (item, update = false) => { other = item; return P.select(item.id, update); };
  P.scene = () => {
    sequence++; initial = false; ctx.rememberOutputView?.(selected); selected = null; P.active = null;
    image.hide(); ctx.isolated = false; showDetails(null); render(); ctx.restoreScene(); ctx.emit('output');
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
        const after = input?.id === selected ? input : other?.id === selected ? other : list.find((v) => v.id === selected); render(); ctx.emit('outputs');
        if (after && (after.revision !== before?.revision || after.status !== before?.status)) await P.select(after.id, true);
        else if (after) { P.active = after; showDetails(after); }
        else if (selected && !after) P.scene();
        else if (initial && list.length) {
          // first the graph the page shows (the project's default graph), its default output
          initial = false;
          const top = list.filter((v) => v.generated && !v.parent), main = top.find((v) => v.graph === ctx.graph.name && v.output === null) ?? top.find((v) => v.graph === ctx.graph.name) ?? top[0];
          if (main) await P.select(main.id);
        }
      } catch (e) { ctx.message(e.message, 'err'); }
      finally { refreshing = null; if (refreshAgain) { refreshAgain = false; void P.refresh(); } }
    })();
    return refreshing;
  };
  // Scene: back to the whole scene, the graph's output (not a node shown on its own) with the layers and guides
  document.getElementById('scene-view').onclick = (e) => {
    e.currentTarget.blur();
    if (P.active) P.scene();
    if (ctx.graph.node) ctx.graph.show(ctx.graph.current()?.output ?? null);
  };
  P.openInput = async (path, update = false) => {
    const f = ctx.layers.list.find((v) => v.path === path); if (!f) return;
    input = { id: 'input:' + path, inputPath: path, label: path, view: 'image', kind: 'image', status: 'ready', revision: `${f.mtime}:${f.size}`, sourceURL: inputImageURL(f), summary: ctx.layers.info.get(path)?.summary ?? ctx.layers.fileText(f) };
    await P.select(input.id, update);
  };
  ctx.on('layers', () => {
    if (!P.active?.inputPath) return;
    const f = ctx.layers.list.find((v) => v.path === P.active.inputPath);
    if (!f) P.scene(); else if (`${f.mtime}:${f.size}` !== P.active.revision) P.openInput(f.path, true);
  });
  return P;
}
