// The outliner (docs/design/viewer.md section 2): one tree of the output (the node being shown), the graph's nodes
// (click one to show its result; the square is its display flag), the inputs (reference layers) and the guides.
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

export function createOutliner(ctx, host) {
  const sizes = [32, 56, 88], sizeButton = document.getElementById('thumb-size');
  let size = ctx.store.get('outliner.thumbnailSize', 56);
  if (!sizes.includes(size)) size = 56;
  const applySize = () => { document.getElementById('outliner').style.setProperty('--thumb-size', size + 'px'); sizeButton.textContent = size + ' px'; };
  sizeButton.onclick = () => { size = sizes[(sizes.indexOf(size) + 1) % sizes.length]; ctx.store.set('outliner.thumbnailSize', size); applySize(); };
  applySize();
  const closed = new Set(ctx.store.get('outliner.closed', []));
  const sections = new Map();
  const section = (key, title) => {
    let s = sections.get(key);
    if (s) return s;
    const box = el('div', 'sec' + (closed.has(key) ? ' closed' : '')), head = el('div', 'sh'), rows = el('div', 'rows'), count = el('span', 'count');
    head.append(el('span', '', title), count);
    head.onclick = () => { box.classList.toggle('closed'); if (box.classList.contains('closed')) closed.add(key); else closed.delete(key); ctx.store.set('outliner.closed', [...closed]); };
    box.append(head, rows);
    host.append(box);
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
        const row = el('div', 'row'), flag = el('span', 'flag'), nm = el('span', 'nm'), mt = el('span', 'mt');
        row.append(flag, nm, mt);
        let name = first.name;
        row.addEventListener('pointerdown', (e) => { if (e.button === 0) ctx.graph.show(name); });
        return {
          el: row,
          update({ n }) {
            name = n.name;
            const shown = ctx.graph.shownNode() === n.name;
            flag.classList.toggle('on', shown);
            nm.textContent = n.name + (n.name === g.output ? '  ◂ output' : '');
            mt.textContent = n.type + (n.ms != null ? ` · ${n.ms.toFixed(0)} ms` : '');
            row.classList.toggle('err', !!n.error);
            row.title = n.error ?? `${n.type}${n.in?.length ? ' ← ' + n.in.filter(Boolean).join(', ') : ''} — click to show its result`;
          },
        };
      });
    }
    // inputs: reference layers
    {
      const s = section('inputs', 'Inputs');
      const L = ctx.layers;
      s.count.textContent = L.list.length || '';
      sync(s, L.list.map((f) => ({ key: f.path, f })), ({ f: first }) => {
        const path = first.path, id = layerId(path);
        const wrap = el('div', ''), row = el('div', 'row input-card'), ey = eye(() => L.show(path, !L.shown.has(path))), nm = el('span', 'nm', path), mt = el('span', 'mt'), er = el('div', 'rowerr');
        const ds = displaySelect(LAYER_MODES, (m) => L.setDisplay(path, m));
        const thumb = el('img', 'input-thumb'), body = el('div', 'input-body'), controls = el('div', 'input-controls'), icon = el('span', 'file-icon', first.ext?.toUpperCase() || 'FILE');
        thumb.alt = ''; thumb.loading = 'lazy'; thumb.onerror = () => { thumb.hidden = true; icon.hidden = false; };
        controls.append(ey, ds, mt); body.append(nm, controls); row.append(thumb, icon, body);
        wrap.append(row, er);
        selectRow(row, id);
        row.onclick = (e) => { if (!e.target.closest('button,select,input') && isInputImage(path)) ctx.outputs.openInput(path); };
        row.addEventListener('pointerenter', () => setTimeout(() => L.fetchInfo(path), 150));
        return {
          el: wrap,
          update({ f }) {
            const canPreview = isInputImage(path) || ['mesh', 'geometry', 'points'].includes(f.kind) || /\.(obj|stl|ply|glb|gltf|blend|geo|bgeo|json|csv)$/i.test(path);
            const src = canPreview ? (isInputImage(path) ? inputImageURL(f) : '/api/input_thumb?' + new URLSearchParams({ path, rev: `${f.mtime}:${f.size}` })) : '';
            if (thumb.dataset.source !== src) { thumb.dataset.source = src; thumb.hidden = !src; icon.hidden = !!src; if (src) thumb.src = src; }
            const on = L.shown.has(path), e = ctx.objects.get(id);
            ey.classList.toggle('off', !on);
            ey.title = on ? 'hide (unloads the layer)' : 'show as a reference layer';
            if (document.activeElement !== ds) ds.value = L.display.get(path) ?? 'view';
            mt.textContent = e?.loading ? 'loading…' : fmtBytes(f.size);
            row.title = `inputs/${path} · ${L.fileText(f)}`;
            const err = L.errors.get(path);
            er.textContent = err?.msg ?? '';
            er.hidden = !err;
            mark(row, id);
          },
        };
      });
      if (!L.list.length) note(s, 'Drop meshes, data, PNG, JPEG or WebP files anywhere on this page.');
      if (L.where) { const n = note(s, `files go to inputs/ ${L.where}; a file node reads them as inputs/<name>`); n.title = L.dir; }
    }
    {
      const s = section('outputs', 'Outputs'), outputs = document.getElementById('outputs');
      if (outputs.parentElement !== s.rows) s.rows.append(outputs);
      outputs.hidden = false; s.count.textContent = ctx.outputs?.count || '';
    }
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
  return { render };
}
