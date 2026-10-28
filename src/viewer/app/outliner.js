// The left panel's tabs. Scene is the outliner tree: the output (the node being shown), the graph's nodes (click one to
// show its result; the square is its display flag; a node of a package with an update carries the mark packages.js
// gives it) and the guides. Outputs is the published results (outputs.js). Inputs is the files in inputs/ (reference
// layers) with Add input. Packages (packages.js) shows while the project uses packages.
// Rows carry a visibility eye, a display mode and the name; selecting a row selects in the viewport and back.
// Rows are kept and updated in place, so an open menu survives a refresh.
import { opOf } from './selection.js';
import { DISPLAY_MODES, LAYER_MODES } from './scene.js';
import { EDITOR_NAMES } from './markers.js';
import { fmtBytes } from './units.js';
import { layerId, isInputImage, inputImageURL } from './layers.js';
import { guideId } from './guides.js';

const EYE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle class="pupil" cx="8" cy="8" r="2"/><path class="slash" d="M3 13L13 3"/></svg>';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

export function createOutliner(ctx, panes) {
  // the tabs: one pane shown, remembered per browser; arrow keys move between tabs. A hidden tab (Packages, while the
  // project uses none) stays the one wanted: it shows again when its tab does.
  const tabs = [...document.querySelectorAll('#outliner [data-tab]')], paneEls = [...document.querySelectorAll('#outliner [data-pane]')];
  let tab = ctx.store.get('outliner.tab', 'outputs'), wanted = tab;
  const visibleTabs = () => tabs.filter((t) => !t.hidden);
  const showTab = (name, focus = false, chosen = true) => {
    if (!visibleTabs().some((t) => t.dataset.tab === name)) name = 'outputs';
    tab = name;
    if (chosen) { wanted = name; ctx.store.set('outliner.tab', name); }
    for (const t of tabs) { const on = t.dataset.tab === name; t.classList.toggle('on', on); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); }
    for (const p of paneEls) p.hidden = p.dataset.pane !== name;
  };
  for (const t of tabs) {
    t.onclick = () => showTab(t.dataset.tab);
    t.onkeydown = (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const on = visibleTabs(), i = on.indexOf(t), next = on[(i + (e.key === 'ArrowRight' ? 1 : on.length - 1)) % on.length];
      showTab(next.dataset.tab, true);
    };
  }
  showTab(tab, false, false);
  /** Show or hide a tab (Packages); hiding the one in view shows Outputs. */
  const setTabShown = (name, on) => {
    const t = tabs.find((x) => x.dataset.tab === name);
    if (!t || t.hidden === !on) return;
    t.hidden = !on;
    if (!on && tab === name) showTab('outputs', false, false);
    else if (on && wanted === name) showTab(name, false, false);
  };
  const tabCount = (name, n) => { const c = document.querySelector(`#tab-${name} .count`); if (c) c.textContent = n ? String(n) : ''; };
  const picker = document.getElementById('input-file');
  document.getElementById('add-input').onclick = () => picker.click();
  picker.onchange = () => { ctx.layers.upload([...picker.files], []); picker.value = ''; };
  // the cards' thumbnail size: one for the Outputs and Inputs cards, cycled by a button in each tab's bar
  const sizes = [32, 56, 88];
  let size = ctx.store.get('outliner.thumbnailSize', 56);
  if (!sizes.includes(size)) size = 56;
  const applySize = () => {
    document.getElementById('outliner').style.setProperty('--thumb-size', size + 'px');
    for (const b of document.querySelectorAll('.thumb-size')) b.textContent = size + ' px';
  };
  ctx.thumbSizeButton = () => {
    const b = el('button', 'thumb-size', size + ' px');
    b.type = 'button'; b.title = 'Cycle thumbnail size'; b.setAttribute('aria-label', 'Cycle thumbnail size');
    b.onclick = () => { b.blur(); size = sizes[(sizes.indexOf(size) + 1) % sizes.length]; ctx.store.set('outliner.thumbnailSize', size); applySize(); };
    return b;
  };
  document.querySelector('.inputs-bar').append(ctx.thumbSizeButton());
  applySize();
  const closed = new Set(ctx.store.get('outliner.closed', []));
  const sections = new Map();
  /** A collapsible section in a pane (the scene tree by default); a headless one is just rows (the Inputs tab). */
  const section = (key, title, pane = panes.scene, headless = false) => {
    let s = sections.get(key);
    if (s) return s;
    const box = el('div', 'sec' + (closed.has(key) && !headless ? ' closed' : '')), head = el('div', 'sh'), rows = el('div', 'rows'), count = el('span', 'count');
    head.append(el('span', '', title), count);
    head.onclick = () => { box.classList.toggle('closed'); if (box.classList.contains('closed')) closed.add(key); else closed.delete(key); ctx.store.set('outliner.closed', [...closed]); };
    head.hidden = headless;
    box.append(head, rows);
    pane.append(box);
    s = { box, rows, count, keyed: new Map(), tail: [] };
    sections.set(key, s);
    return s;
  };
  /** Keep one row per key in order; `make()` builds a row {el, update(data)}. */
  const sync = (s, items, make) => {
    const seen = new Set();
    let prev = null;
    for (const it of items) {
      seen.add(it.key);
      let r = s.keyed.get(it.key);
      if (!r) { r = make(it); s.keyed.set(it.key, r); }
      r.update(it);
      const want = prev ? prev.nextSibling : s.rows.firstChild;
      if (r.el !== want) s.rows.insertBefore(r.el, want);
      prev = r.el;
    }
    for (const [k, r] of s.keyed) if (!seen.has(k)) { r.el.remove(); s.keyed.delete(k); }
    for (const t of s.tail) t.remove();
    s.tail = [];
  };
  const note = (s, text, cls = 'note') => { const n = el('div', cls, text); s.rows.append(n); s.tail.push(n); return n; };
  const selectRow = (row, id) => {
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, select, input')) return;
      ctx.selection.apply([id], opOf(e));
    });
    row.addEventListener('pointerenter', () => ctx.setHover(id));
    row.addEventListener('pointerleave', () => { if (ctx.hover === id) ctx.setHover(null); });
  };
  const eye = (onToggle) => {
    const b = el('button', 'eye');
    b.innerHTML = EYE;
    b.onclick = (e) => { e.stopPropagation(); onToggle(); b.blur(); };
    return b;
  };
  const displaySelect = (modes, onChange) => {
    const s = el('select', 'disp');
    for (const [v, t] of modes) s.append(new Option(t, v));
    s.onchange = () => { onChange(s.value); s.blur(); };
    s.title = 'display mode';
    return s;
  };
  const mark = (row, id) => {
    row.classList.toggle('sel', ctx.selection.has(id));
    row.classList.toggle('part', !ctx.selection.has(id) && ctx.selection.touches(id));
  };

  function render() {
    // output: the node being shown
    {
      const s = section('output', 'Scene');
      const g = ctx.graph.current();
      s.count.textContent = '';
      sync(s, g ? [{ key: 'out' }] : [], () => {
        const row = el('div', 'row'), ey = eye(() => ctx.output.setVisible(!ctx.output.visible)), nm = el('span', 'nm'), mt = el('span', 'mt');
        const ds = displaySelect(DISPLAY_MODES, (m) => ctx.output.setDisplay(m));
        row.append(ey, ds, nm, mt);
        selectRow(row, 'out');
        return {
          el: row,
          update() {
            ey.classList.toggle('off', !ctx.output.visible);
            ey.title = ctx.output.visible ? 'hide (H)' : 'show';
            if (document.activeElement !== ds) ds.value = ctx.output.display;
            const node = ctx.graph.shownNode();
            nm.textContent = node ?? '(none)';
            row.title = ctx.graph.node ? `showing node ${node} (click "${ctx.graph.current()?.output ?? 'output'}" in Nodes to follow the output again)` : `the graph's output, node ${node}`;
            mt.textContent = ctx.output.loading ? 'cooking…' : ctx.graph.node ? 'node' : 'output';
            mark(row, 'out');
          },
        };
      });
    }
    // the graph's nodes: the square is the display flag
    {
      const s = section('nodes', 'Nodes');
      const g = ctx.graph.current();
      const nodes = g?.nodes ?? [];
      s.count.textContent = nodes.length || '';
      sync(s, nodes.map((n) => ({ key: n.name, n })), ({ n: first }) => {
        const row = el('div', 'row'), flag = el('span', 'flag'), nm = el('span', 'nm'), mt = el('span', 'mt'), pm = el('span', 'pmark');
        row.append(flag, nm, mt, pm);
        let name = first.name, marked = null;
        row.addEventListener('pointerdown', (e) => { if (e.button === 0) ctx.graph.show(name); });
        // the mark opens the package's card (and leaves the node shown as it is)
        pm.addEventListener('pointerdown', (e) => e.stopPropagation());
        pm.onclick = () => { if (marked) ctx.packages?.reveal(marked); };
        return {
          el: row,
          update({ n }) {
            name = n.name;
            const shown = ctx.graph.shownNode() === n.name;
            flag.classList.toggle('on', shown);
            nm.textContent = n.name + (n.name === g.output ? '  ◂ output' : '');
            mt.textContent = n.type + (n.ms != null ? ` · ${n.ms.toFixed(0)} ms` : '');
            row.classList.toggle('err', !!n.error);
            // a package with an update (or followed this session): the mark after its type
            const mark = n.packages ? ctx.packages?.nodeMark(n) ?? null : null;
            marked = mark?.package ?? null;
            pm.hidden = !mark;
            pm.className = `pmark ${mark?.kind ?? ''}`;
            pm.textContent = mark?.text ?? '';
            pm.title = mark?.title ?? '';
            row.title = (n.error ?? `${n.type}${n.in?.length ? ' ← ' + n.in.filter(Boolean).join(', ') : ''} — click to show its result`) + (mark ? `\n${mark.title}` : '');
          },
        };
      });
    }
    // inputs: reference layers, in the Inputs tab. An export's sidecar (kind "metadata": a heightmap's .json,
    // <file>.source.json …) is listed on the card of the file it describes, not as a layer of its own.
    {
      const s = section('inputs', 'Inputs', panes.inputs, true);
      const L = ctx.layers;
      const paths = new Set(L.list.map((f) => f.path));
      const attached = (f) => f.kind === 'metadata' && !!f.sidecar?.of && paths.has(f.sidecar.of);
      const cardsOf = L.list.filter((f) => !attached(f));
      tabCount('inputs', cardsOf.length);
      const where = document.getElementById('inputs-where');
      where.textContent = L.where ? `inputs/ ${L.where}` : 'inputs/'; where.title = L.dir ?? '';
      // keyed by kind too: a file that turns into a sidecar (or back) gets the card that fits it
      sync(s, cardsOf.map((f) => ({ key: `${f.path}\n${f.kind === 'metadata'}`, f, meta: L.list.filter((m) => attached(m) && m.sidecar.of === f.path) })), ({ f: first }) => {
        const path = first.path, id = layerId(path), metadata = first.kind === 'metadata';
        const wrap = el('div', ''), row = el('div', 'row input-card'), ey = eye(() => L.show(path, !L.shown.has(path))), nm = el('span', 'nm', path), mt = el('span', 'mt'), er = el('div', 'rowerr');
        const ds = displaySelect(LAYER_MODES, (m) => L.setDisplay(path, m));
        const thumb = el('img', 'input-thumb'), body = el('div', 'input-body'), controls = el('div', 'input-controls'), icon = el('span', 'file-icon', first.ext?.toUpperCase() || 'FILE');
        const meta = el('div', 'input-meta');
        thumb.alt = ''; thumb.loading = 'lazy'; thumb.onerror = () => { thumb.hidden = true; icon.hidden = false; };
        // a sidecar without the file it describes is metadata, never a layer: no eye, no display mode
        if (metadata) controls.append(mt); else controls.append(ey, ds, mt);
        body.append(nm, controls, meta); row.append(thumb, icon, body);
        wrap.append(row, er);
        if (!metadata) selectRow(row, id);
        row.onclick = (e) => { if (!e.target.closest('button,select,input') && isInputImage(path)) ctx.outputs.openInput(path); };
        row.addEventListener('pointerenter', () => setTimeout(() => L.fetchInfo(path), 150));
        return {
          el: wrap,
          update({ f, meta: sidecars }) {
            const canPreview = f.kind !== 'metadata' && (isInputImage(path) || ['mesh', 'geometry', 'points'].includes(f.kind) || /\.(obj|stl|ply|glb|gltf|blend|geo|bgeo|json|csv)$/i.test(path));
            const src = canPreview ? (isInputImage(path) ? inputImageURL(f) : '/api/input_thumb?' + new URLSearchParams({ path, rev: `${f.mtime}:${f.size}` })) : '';
            if (thumb.dataset.source !== src) { thumb.dataset.source = src; thumb.hidden = !src; icon.hidden = !!src; if (src) thumb.src = src; }
            const on = L.shown.has(path), e = ctx.objects.get(id);
            ey.classList.toggle('off', !on);
            ey.title = on ? 'hide (unloads the layer)' : 'show as a reference layer';
            if (document.activeElement !== ds) ds.value = L.display.get(path) ?? 'view';
            mt.textContent = e?.loading ? 'loading…' : fmtBytes(f.size);
            row.title = `inputs/${path} · ${L.fileText(f)}`;
            // what describes it (its sidecars), or what it is (a sidecar alone)
            const lines = f.kind === 'metadata' ? [`${f.about ?? 'metadata'}${f.sidecar?.of ? ` of ${f.sidecar.of}/` : ''}`]
              : sidecars.map((m) => `+ ${m.path.replace(/^.*\//, '')} · ${m.about ?? 'metadata'} · ${fmtBytes(m.size)}`);
            meta.textContent = lines.join('\n'); meta.hidden = !lines.length;
            const err = L.errors.get(path);
            er.textContent = err?.msg ?? '';
            er.hidden = !err;
            mark(row, id);
          },
        };
      });
      if (!L.list.length) note(s, 'No inputs yet: Add input, or drop meshes, curves, points, PNG, JPEG or WebP files anywhere on this page. The agent hears about new files and reads them as inputs/<name>.');
      else note(s, 'a file node reads these as inputs/<name>; the agent hears about new ones');
    }
    tabCount('outputs', ctx.outputs?.count);
    // guides
    {
      const s = section('guides', 'Guides');
      const G = ctx.guides;
      s.count.textContent = G.list.length || '';
      sync(s, G.list.map((m) => ({ key: m.id, m })), ({ m: first }) => {
        const gid = first.id, id = guideId(gid);
        const row = el('div', 'row'), ey = eye(() => G.setHidden([gid], !G.hidden.has(gid))), kind = el('span', 'kind'), nm = el('span', 'nm');
        row.append(ey, kind, nm);
        selectRow(row, id);
        return {
          el: row,
          update({ m }) {
            const hidden = G.hidden.has(gid);
            ey.classList.toggle('off', hidden);
            ey.title = hidden ? 'show' : 'hide (H)';
            kind.textContent = EDITOR_NAMES[m.kind];
            nm.textContent = m.name;
            row.title = `${EDITOR_NAMES[m.kind]} "${m.name}" — role "${m.kind}" in inputs/markers.json`;
            mark(row, id);
          },
        };
      });
      if (!G.list.length) note(s, 'none yet — Shift+1 null, Shift+2 curve, Shift+3 area, Shift+4 volume; agents read them as inputs/markers.json');
    }
  }
  return { render, showTab, setTabShown };
}
