// The properties column: what the selection is (a guide's name, kind,
// translate / rotate / scale, radius or height and the attributes the LLM reads; a layer's file, counts, bbox and
// display mode; the output's summary; a piece's size), and below it the Controls: the graph's exposed vars as
// sliders, fields, checkboxes, menus and colour pickers. Drags post at most every 100 ms; each control resets to its
// default; undeclared vars are listed under "other vars". Transform fields are read-only until phase 2.
import { api } from './api.js';
import * as M from './markers.js';
import { parseId } from './selection.js';
import { DISPLAY_MODES, LAYER_MODES } from './scene.js';
import { fmtLen, fmtNum, fmtSize, fmtCount } from './units.js';
import { isNum, same, HEX3, fmt, short, kindOf, blank, menuOf, rangeOf, autoStep, snapTo, controlList, baseValue, rowShape, sessionText, serverValueWins } from './vars.js';
import { fmtDuration } from './cooking.js';
import { kindLine, layerChoices, shownLayer } from './output-info.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const $ = (id) => document.getElementById(id);

export function createProps(ctx) {
  const body = $('props-body');
  let shownKey = null, dirty = false;

  // ------------------------------------------------------------------ building blocks
  const group = (title, ...extra) => { const g = el('div', 'pgroup'), h = el('h3'); h.append(el('span', '', title), el('span', 'grow'), ...extra); g.append(h); return g; };
  const row = (label, value, title) => {
    const r = el('div', 'prow'), l = el('span', 'pl', label), v = el('span', 'pv');
    if (value instanceof Node) v.append(value); else v.textContent = value ?? '';
    if (title) r.title = title;
    r.append(l, v);
    return r;
  };
  const xyz = (vals, step = 1) => {
    const box = el('div', 'xyz');
    for (const x of vals) { const f = el('input'); f.readOnly = true; f.value = fmtNum(x, step < 1 ? 3 : 2); f.title = 'read-only until phase 2 (transform)'; box.append(f); }
    return box;
  };
  const numberField = (value, onSet, title) => {
    const f = el('input');
    f.type = 'number'; f.min = '0.001'; f.step = 'any'; f.value = fmt(value); f.title = title ?? '';
    f.oninput = () => { const v = Number(f.value); if (f.value.trim() !== '' && Number.isFinite(v) && v > 0) onSet(v); };
    f.onkeydown = (e) => { if (e.key === 'Enter' || e.key === 'Escape') f.blur(); };
    return f;
  };
  const bboxRows = (g, b) => {
    if (!b || b.isEmpty()) return;
    const size = b.getSize(new ctx.THREE.Vector3()), c = b.getCenter(new ctx.THREE.Vector3());
    g.append(row('size', fmtSize(size.toArray())), row('centre', xyz(c.toArray())), row('min', xyz(b.min.toArray())), row('max', xyz(b.max.toArray())));
  };
  const summaryBlock = (text) => { const p = el('pre', 'summary'); p.textContent = text; return p; };
  const displayRow = (modes, value, onChange) => {
    const s = el('select');
    for (const [v, t] of modes) s.append(new Option(t, v));
    s.value = value;
    s.onchange = () => onChange(s.value);
    return row('display', s);
  };

  // ------------------------------------------------------------------ one object
  function guide(m) {
    const out = [];
    const id = m.id, kind = M.EDITOR_NAMES[m.kind];
    const del = el('button', 'danger', 'Delete');
    del.title = 'delete this guide (Delete)';
    del.onclick = () => ctx.guides.remove([id]);
    const g = group(kind, del);
    const name = el('input');
    name.type = 'text'; name.value = m.name; name.spellcheck = false; name.maxLength = 100;
    name.onkeydown = (e) => { if (e.key === 'Enter') name.blur(); else if (e.key === 'Escape') { name.value = ctx.guides.byId(id)?.name ?? ''; name.classList.remove('bad'); name.blur(); } };
    name.onchange = () => {
      const r = ctx.guides.rename(id, name.value);
      if (r.error) { ctx.message(r.error, 'err'); name.classList.add('bad'); name.value = ctx.guides.byId(id)?.name ?? ''; setTimeout(() => name.classList.remove('bad'), 1500); }
      else name.value = r.name;
    };
    g.append(row('name', name), row('kind', `${kind} · role "${m.kind}"`));
    const piv = M.pivotOf(m);
    g.append(row('translate', xyz(piv)), row('rotate', xyz([0, 0, 0])), row('scale', xyz([1, 1, 1])));
    out.push(g);
    const k = group('shape');
    if (m.kind === 'site') k.append(row('radius (m)', numberField(m.radius, (v) => ctx.guides.setSize(id, 'radius', v), 'pscale in inputs/markers.json')));
    if (m.kind === 'volume') {
      const { lo, hi } = M.boxOf(m);
      k.append(row('height (m)', numberField(m.height, (v) => ctx.guides.setSize(id, 'height', v), 'how far the box rises above its lower corner')), row('size', fmtSize([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]])));
    }
    if (m.kind === 'path') k.append(row('length', `${fmtLen(M.pathLength(m.points))} m`));
    if (m.kind === 'zone') k.append(row('area', `${fmtNum(M.topArea(m.points), 1)} m² from above`));
    if (m.kind !== 'site') {
      const list = el('div', 'mono');
      list.textContent = m.points.map((p, i) => `${m.kind === 'volume' ? 'corner' : 'cv'} ${i}  ${p.map((x) => fmtNum(x, 2)).join(', ')}`).join('\n');
      list.style.whiteSpace = 'pre';
      k.append(row(m.kind === 'volume' ? 'corners' : 'CVs', list));
    } else k.append(row('point', xyz(m.points[0])));
    out.push(k);
    // what the agent reads
    const a = group('attributes the LLM reads');
    const t = el('table', 'attrs');
    for (const r of M.markerAttributes(m)) {
      const tr = el('tr');
      tr.append(el('td', '', `${r.cls} ${r.name}`), el('td', '', typeof r.value === 'string' ? JSON.stringify(r.value) : Array.isArray(r.value) ? `[${r.value.join(', ')}]` : fmt(r.value)));
      t.append(tr);
    }
    const elems = M.markerElements(m);
    a.append(t, el('div', 'hint', `inputs/markers.json${ctx.guides.saving() ? ' (saving…)' : ''}: ${elems.text}. Read it with {"type":"file","params":{"path":"inputs/markers.json"}}; this one: group "${M.groupOf(m)}", every ${m.kind}: "@role=${m.kind}"`));
    out.push(a);
    return out;
  }
  function layer(e) {
    const L = ctx.layers, f = e.file, out = [];
    const g = group('reference layer');
    g.append(row('file', `inputs/${e.path}`), ...(f ? [row('kind', L.fileText(f))] : []));
    g.append(displayRow(LAYER_MODES, L.display.get(e.path) ?? 'view', (m) => L.setDisplay(e.path, m)));
    if (!L.shown.has(e.path)) g.append(el('div', 'hint', 'hidden — the eye in the outliner shows it'));
    if (e.mesh) {
      const s = e.mesh.src;
      g.append(row('offset', xyz(s.position.toArray())), row('scale', xyz(s.scale.toArray())));
    }
    out.push(g);
    const info = L.info.get(e.path);
    const sg = group('contents');
    if (!info) { L.fetchInfo(e.path); sg.append(el('div', 'hint', '…')); }
    else if (info.pending) sg.append(el('div', 'hint', '…'));
    else if (info.error) sg.append(el('div', 'hint', info.error));
    else sg.append(summaryBlock(info.summary));
    out.push(sg);
    return out;
  }
  function output() {
    const o = ctx.output, out = [];
    const g = group('output');
    const graph = ctx.graph.current();
    g.append(row('graph', graph?.name ?? ''), row('node', ctx.graph.shownNode() ?? ''), displayRow(DISPLAY_MODES, o.display, (m) => o.setDisplay(m)));
    // what it is (the server's decision from the cooked geometry), and a heightfield's layer drawn in red
    if (o.about) g.append(row('is', kindLine({ kind: o.about.published ?? 'empty', about: o.about.text, size: o.about.size })));
    if (o.about?.heightfield && !ctx.isolated) {
      const s = el('select');
      for (const c of layerChoices(o.about.heightfield)) s.append(new Option(c.label, c.value));
      s.value = shownLayer(o.about.heightfield, ctx.sceneLayer.get());
      s.onchange = () => { ctx.sceneLayer.set(s.value); s.blur(); };
      g.append(row('layer in red', s, 'the heightfield layer drawn in red over the terrain: 0..1 layers as they are, others from their minimum to their maximum'));
    }
    if (o.report?.cooked) g.append(row('cook', `${fmtNum(o.report.ms, 0)} ms${o.report.ok ? '' : ' · failed'}`));
    const ec = o.mesh?.edgeCounts();
    if (ec) g.append(row('edges', `${fmtCount(ec.open)} open · ${fmtCount(ec.nonManifold)} non-manifold · ${fmtCount(ec.flipped)} flipped`, 'drawn as the render tool draws them: pink open, yellow non-manifold, violet winding flips'));
    out.push(g);
    const sg = group('summary');
    sg.append(o.summary ? summaryBlock(o.summary) : el('div', 'hint', o.error ?? '…'));
    out.push(sg);
    return out;
  }
  function piece(e, k) {
    const out = [], g = group(`piece ${k} of ${e.kind === 'output' ? 'the output' : `inputs/${e.path}`}`);
    const at = e.mesh?.partOf(k);
    if (at?.part.a?.start) g.append(row('triangles', fmtCount(at.part.a.start[at.local + 1] - at.part.a.start[at.local])));
    else if (at?.part.type === 'inst') g.append(row('instance', `${at.local} of ${at.part.count}`));
    bboxRows(g, e.mesh?.bounds(k));
    g.append(el('div', 'hint', 'a connected piece of the geometry; the outliner row selects the whole object'));
    out.push(g);
    return out;
  }
  function many(ids) {
    const kinds = {};
    for (const id of ids) {
      const { obj, piece: p } = parseId(id), e = ctx.objects.get(obj);
      const k = p !== null ? 'piece' : e?.kind === 'guide' ? M.EDITOR_NAMES[e.marker.kind] : e?.kind === 'layer' ? 'layer' : 'output';
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    const g = group(`${ids.length} selected`);
    g.append(row('kinds', Object.entries(kinds).map(([k, n]) => `${n} ${k}${n === 1 ? '' : k.endsWith('x') ? 'es' : 's'}`).join(', ')));
    bboxRows(g, ctx.select.selectionBounds());
    return [g];
  }

  /** Rebuild the panel for the selection (not while a field in it is being edited). */
  function render(force = false) {
    const ids = ctx.selection.items;
    const lead = ctx.selection.lead;
    const key = JSON.stringify([ids, ctx.version()]);
    if (!force && key === shownKey) return;
    if (body.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) { dirty = true; return; }
    shownKey = key; dirty = false;
    let parts;
    if (!lead) {
      const g = group('nothing selected');
      g.append(el('div', 'hint', 'click in the view or in the outliner; Shift adds, Ctrl removes, drag a box. F frames the selection, A everything.'));
      parts = [g];
    } else if (ids.length > 1) parts = many(ids);
    else {
      const { obj, piece: p } = parseId(lead), e = ctx.objects.get(obj);
      if (!e) parts = [group('gone')];
      else if (p !== null) parts = piece(e, p);
      else if (e.kind === 'guide') parts = guide(e.marker);
      else if (e.kind === 'layer') parts = layer(e);
      else parts = output();
    }
    body.replaceChildren(...parts);
  }
  body.addEventListener('focusout', () => setTimeout(() => { if (dirty && !body.contains(document.activeElement)) render(true); }));

  return { render, controls: createControls(ctx) };
}

// ---------------------------------------------------------------------------------------------- the Controls
// One control per declared param (graph.params), then the undeclared vars. Values are POSTed to /api/vars (sliders at
// most every 100 ms, plus once on release); the server cooks the latest one and stops the cook of the one before.
// Rows are kept and updated in place: a row is built again only when its shape changes (vars.js rowShape), and never
// while it is dragged, so the panel keeps its layout and scroll position through reloads and cooks. A finished change
// (release, Enter, a pick) is one undo step.
// Over a graph file (`topotopo view`, mode "file") the values are session values over the file: a mark shows each one
// that differs from the file, ↺ goes back to the file's value, Reset all does so for all of them, and Save values
// writes them into the file's vars. In a workspace the values edit the stored graph and ↺ goes to the declared default.
function createControls(ctx) {
  const box = $('controls'), count = $('controls-count');
  const bar = $('controls-session'), barText = bar.querySelector('.stext'), saveBtn = $('vars-save'), resetBtn = $('vars-reset');
  const ctl = {
    graph: null, mode: 'workspace', file: null, graphVars: {}, rows: new Map(), active: null, deferred: null, saving: false,
    pending: {}, timer: 0, lastSend: -1e9, seq: 0,
    // var → id of its newest POST not answered yet / time its newest POST was answered: older server state is ignored
    unacked: new Map(), ackAt: new Map(),
    // var → its value when the change being made began (the undo step's "before")
    begin: new Map(), values: new Map(),
    sub: el('div', 'sub'), none: el('div', 'none'),
  };
  addEventListener('pointerup', () => endDrag(), true);
  addEventListener('pointercancel', () => endDrag(), true);
  function endDrag() {
    ctl.active = null;
    // after the slider's own change event (its final value) has been sent
    if (ctl.deferred) setTimeout(() => { if (!ctl.deferred || ctl.active) return; const [g, t] = ctl.deferred; ctl.deferred = null; render(g, t); });
  }

  const WIDGETS = {
    number(name, vd, value, cw) {
      // declared int: integer values; an undeclared whole number gets integer slider steps but takes any typed value
      const int = vd.type === 'int', intSteps = int || (vd.type === undefined && Number.isInteger(value));
      let cur = value;
      const r = rangeOf(vd, cur, intSteps);
      const slider = el('input'), num = el('input');
      slider.type = 'range'; num.type = 'number'; num.step = int ? String(r.step) : 'any';
      const fit = () => { slider.min = r.lo; slider.max = r.hi; slider.step = r.step; if (r.fixLo) num.min = r.lo; if (r.fixHi) num.max = r.hi; };
      const widen = (v) => {
        const lo = !r.fixLo && v < r.lo, hi = !r.fixHi && v > r.hi;
        if (lo) r.lo = v;
        if (hi) r.hi = v;
        if ((lo || hi) && !r.fixStep) r.step = autoStep(r);
        if (lo || hi) fit();
      };
      const show = () => { slider.value = cur; num.value = fmt(cur); };
      slider.addEventListener('pointerdown', () => { ctl.active = name; });
      slider.addEventListener('input', () => { cur = snapTo(r, Number(slider.value)); num.value = fmt(cur); queueVar(name, cur); });
      // a finished change gives the keys back to the viewport
      slider.addEventListener('change', () => { queueVar(name, cur, true); slider.blur(); });
      num.addEventListener('change', () => {
        let v = Number(num.value);
        if (num.value.trim() === '' || !Number.isFinite(v)) return show();
        if (int) v = Math.round(v);
        if (r.fixLo) v = Math.max(v, r.lo);
        if (r.fixHi) v = Math.min(v, r.hi);
        widen(v); cur = v; show(); queueVar(name, v, true);
      });
      cw.append(slider, num);
      fit(); widen(cur); show();
      return { set(v) { if (!isNum(v)) return; cur = v; widen(v); show(); }, get: () => cur, typing: () => document.activeElement === num };
    },
    bool(name, vd, value, cw) {
      const asNum = isNum(value), b = el('input');
      b.type = 'checkbox';
      const get = () => (asNum ? (b.checked ? 1 : 0) : b.checked);
      b.onchange = () => { queueVar(name, get(), true); b.blur(); };
      cw.append(b);
      const set = (v) => { b.checked = !!v; };
      set(value);
      return { set, get };
    },
    select(name, vd, value, cw) {
      // an entry stands for its option (numeric options give numbers); a number var with text options holds the index
      const menu = menuOf(vd, value), opts = menu.texts;
      const s = el('select');
      for (const o of opts) s.append(new Option(o, o));
      // a value outside the options (set by an agent or by hand) is shown as an extra entry while it holds
      let outside;
      const get = () => { const v = menu.valueOf(s.value); return v === undefined ? outside : v; };
      const set = (v) => {
        const k = menu.textOf(v);
        if (k === undefined) return;
        for (const o of [...s.options]) if (!opts.includes(o.value) && o.value !== k) o.remove();
        if (![...s.options].some((o) => o.value === k)) s.append(new Option(k, k));
        outside = opts.includes(k) ? undefined : v;
        s.value = k;
      };
      s.onchange = () => { queueVar(name, get(), true); s.blur(); };
      cw.append(s); set(value);
      return { set, get };
    },
    text(name, vd, value, cw) {
      const t = el('input');
      t.type = 'text'; t.spellcheck = false;
      t.onchange = () => queueVar(name, t.value, true);
      cw.append(t);
      const set = (v) => { t.value = v == null ? '' : String(v); };
      set(value);
      return { set, get: () => t.value, typing: () => document.activeElement === t };
    },
    vector(name, vd, value, cw) {
      const int = /^ivec/.test(vd.type ?? '');
      let cur = value.slice();
      const fields = cur.map((_, i) => {
        const f = el('input', 'vec');
        f.type = 'number'; f.step = int ? '1' : 'any'; f.title = `${name}.${'xyzw'[i]}`;
        f.onchange = () => {
          let v = Number(f.value);
          if (f.value.trim() === '' || !Number.isFinite(v)) { f.value = fmt(cur[i]); return; }
          if (int) v = Math.round(v);
          cur = cur.slice(); cur[i] = v; f.value = fmt(v);
          queueVar(name, cur, true);
        };
        return f;
      });
      cw.append(...fields);
      const set = (v) => { if (!Array.isArray(v)) return; cur = v.slice(); fields.forEach((f, i) => { f.value = fmt(cur[i] ?? 0); }); };
      set(cur);
      return { set, get: () => cur, typing: () => fields.includes(document.activeElement) };
    },
    color(name, vd, value, cw) {
      // "#rrggbb" strings, or [r, g, b(, a)] in 0..1
      const arr = Array.isArray(value), c = el('input');
      c.type = 'color';
      let cur = value;
      const hex = (v) => (arr ? '#' + v.slice(0, 3).map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('')
        : HEX3.test(v) ? '#' + [...v.slice(1)].map((ch) => ch + ch).join('') : v);
      const parse = (h) => (arr ? [1, 3, 5].map((i) => +(parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4)).concat(cur.slice(3)) : h);
      c.addEventListener('input', () => { cur = parse(c.value); queueVar(name, cur); });
      c.addEventListener('change', () => { cur = parse(c.value); queueVar(name, cur, true); c.blur(); });
      cw.append(c);
      const set = (v) => { if (arr ? !Array.isArray(v) : typeof v !== 'string') return; cur = v; c.value = hex(v); };
      set(value);
      return { set, get: () => cur };
    },
    json(name, vd, value, cw) {
      const t = el('input');
      t.type = 'text'; t.spellcheck = false; t.title = 'JSON value';
      let cur = value;
      t.onchange = () => {
        try { cur = JSON.parse(t.value); } catch { t.classList.add('bad'); return; }
        t.classList.remove('bad');
        queueVar(name, cur, true);
      };
      cw.append(t);
      const set = (v) => { cur = v; t.value = JSON.stringify(v) ?? ''; t.classList.remove('bad'); };
      set(value);
      return { set, get: () => cur, typing: () => document.activeElement === t };
    },
  };

  /** One control row: its widget, the mark that it differs from the graph file, and ↺. */
  function controlRow(name, vd, value, shape) {
    const declared = !!vd;
    vd = vd ?? {};
    if (value === undefined) value = declared && vd.default !== undefined ? vd.default : blank(vd);
    const label = (typeof vd.label === 'string' && vd.label) || name;
    const wrap = el('div', 'ctl'), cw = el('div', 'cw'), mark = el('span', 'cmark');
    wrap.title = [label !== name ? name : '', declared ? vd.desc : 'not declared in the graph\'s "params"'].filter(Boolean).join(' — ');
    const w = WIDGETS[kindOf(declared ? vd : null, value)](name, vd, value, cw);
    const reset = el('button', 'ib', '↺');
    reset.onclick = () => { reset.blur(); resetVars([name]); };
    wrap.append(mark, el('span', 'cl', label), cw, reset);
    const r = {
      el: wrap, name, shape,
      /** what ↺ goes back to (vars.js baseValue), undefined: nothing */
      base: undefined,
      set(v) { w.set(v); r.sync(); },
      get: () => w.get(),
      typing: () => w.typing?.() ?? false,
      /** differs from the graph file (marked) */
      changed: () => ctl.mode === 'file' && r.base !== undefined && !same(ctl.values.get(name), r.base),
      sync() {
        const changed = r.changed();
        wrap.classList.toggle('changed', changed);
        mark.title = changed ? `differs from ${ctl.file ?? 'the graph'}, where it is ${short(r.base)}` : '';
        reset.classList.toggle('gone', r.base === undefined);
        reset.disabled = r.base === undefined || same(w.get(), r.base);
        reset.title = r.base === undefined ? '' : ctl.mode === 'file' ? `back to ${short(r.base)}, the value in ${ctl.file ?? 'the graph'}` : `reset ${name} to ${short(r.base)}`;
      },
    };
    ctl.values.set(name, value);
    return r;
  }

  /**
   * Show a graph's controls. Rows are kept in place: a row whose shape changed is built again (after the drag when it
   * is the one being dragged), rows of vars that went away are removed, new ones are added in order.
   */
  function render(g, issued = performance.now()) {
    const name = g?.name ?? null;
    if (ctl.graph !== name) {
      if (ctl.graph) flushVars();
      ctl.pending = {}; ctl.unacked.clear(); ctl.ackAt.clear(); ctl.begin.clear(); ctl.values.clear();
      for (const r of ctl.rows.values()) r.el.remove();
      ctl.rows.clear(); ctl.deferred = null;
      ctl.graph = name;
    }
    ctl.mode = g?.mode ?? 'workspace'; ctl.file = g?.file ?? null;
    const params = g?.params ?? {}, vars = g?.vars ?? {};
    ctl.graphVars = g?.graphVars ?? vars;
    const { declared, other } = controlList(params, vars);
    count.textContent = declared.length + other.length || '';
    let deferred = false;
    const wanted = new Set(), els = [];
    const place = (k, vd) => {
      wanted.add(k);
      // a row the person is changing keeps the value it shows; the shape is the server's otherwise
      const local = ctl.rows.has(k) && holding(k, issued);
      let v = local ? ctl.values.get(k) : vars[k];
      if (v === undefined) v = vd?.default !== undefined ? vd.default : blank(vd ?? {});
      const shape = rowShape(vd, v);
      let r = ctl.rows.get(k);
      if (r && r.shape !== shape) {
        if (ctl.active === k) deferred = true;
        else { const n = controlRow(k, vd, v, shape); r.el.replaceWith(n.el); ctl.rows.set(k, n); r = n; }
      }
      if (!r) { r = controlRow(k, vd, v, shape); ctl.rows.set(k, r); }
      r.base = baseValue(ctl.mode, vd, ctl.graphVars, k);
      els.push(r.el);
    };
    for (const k of declared) place(k, params[k] ?? {});
    if (other.length) { ctl.sub.textContent = declared.length ? 'other vars' : 'vars (none declared in "params")'; els.push(ctl.sub); }
    for (const k of other) place(k, null);
    if (!els.length) { ctl.none.textContent = g ? 'none — this graph exposes no vars' : 'none'; els.push(ctl.none); }
    // in order, moving only what is out of place (the scroll position and an open menu stay)
    let prev = null;
    for (const e of els) { const at = prev ? prev.nextSibling : box.firstChild; if (e !== at) box.insertBefore(e, at); prev = e; }
    for (const [k, r] of ctl.rows) {
      if (wanted.has(k)) continue;
      if (ctl.active === k) { deferred = true; continue; }
      r.el.remove(); ctl.rows.delete(k); ctl.values.delete(k);
    }
    for (const e of [ctl.sub, ctl.none]) if (!els.includes(e)) e.remove();
    ctl.deferred = deferred ? [g, issued] : null;
    applyValues(vars, issued);
    for (const r of ctl.rows.values()) r.sync();
    renderBar();
  }

  /** The person has a change of var k on the way, is dragging it or typing in it: the server's value waits. */
  const typing = (k) => !!ctl.rows.get(k)?.typing();
  const holding = (k, issued) => !serverValueWins({ pending: ctl.pending, unacked: ctl.unacked, ackAt: ctl.ackAt, active: ctl.active, typing }, k, issued);

  /** Server state into the controls, except where the person has edits on the way or is dragging/typing. */
  function applyValues(vars, issued) {
    for (const [k, r] of ctl.rows) {
      if (holding(k, issued)) continue;
      const v = k in vars ? vars[k] : r.base;
      if (v === undefined) continue;
      r.set(v);
      ctl.values.set(k, v);
      r.sync();
    }
    renderBar();
  }

  /** The line above the Controls over a graph file: how many values differ from it, Save values, Reset all. */
  function renderBar() {
    const file = ctl.mode === 'file';
    bar.hidden = !file;
    if (!file) return;
    const changed = [...ctl.rows.values()].filter((r) => r.changed()).length;
    barText.textContent = sessionText(changed, ctl.file);
    // a viewer that cannot write the file (it does not name one) offers no Save
    saveBtn.hidden = !ctl.file;
    saveBtn.disabled = !changed || ctl.saving;
    saveBtn.title = ctl.file ? `write the ${changed || ''} changed value${changed === 1 ? '' : 's'} into "vars" of ${ctl.file}`.replace('  ', ' ') : '';
    resetBtn.disabled = !changed;
    resetBtn.title = `every value back to ${ctl.file ?? 'the graph'}'s`;
  }

  /** ↺ and Reset all: the vars back to their base value (over a graph file: the file's, one undo step for all). */
  function resetVars(names) {
    const rows = names.map((k) => ctl.rows.get(k)).filter((r) => r && r.base !== undefined && !same(ctl.values.get(r.name), r.base));
    if (!rows.length) return;
    const graph = ctl.graph, before = new Map(rows.map((r) => [r.name, ctl.values.get(r.name)])), after = new Map(rows.map((r) => [r.name, r.base]));
    // over a graph file null drops the session value; in a workspace the default is stored
    for (const r of rows) { r.set(r.base); queueVar(r.name, ctl.mode === 'file' ? null : r.base, false, true, r.base); }
    const apply = (m) => {
      if (ctl.graph !== graph) { api.vars(graph, Object.fromEntries(m)); return; }
      for (const [k, v] of m) if (ctl.rows.has(k)) { ctl.rows.get(k).set(v); queueVar(k, v, false, true); }
      flushVars();
    };
    ctx.undo.push({ label: rows.length === 1 ? `${rows[0].name} = ${short(rows[0].base)}` : `reset ${rows.length} values`, undo: () => apply(before), redo: () => apply(after) });
    flushVars();
  }
  resetBtn.onclick = () => { resetBtn.blur(); resetVars([...ctl.rows.values()].filter((r) => r.changed()).map((r) => r.name)); };
  saveBtn.onclick = async () => {
    saveBtn.blur();
    const graph = ctl.graph, values = Object.fromEntries([...ctl.rows.values()].filter((r) => r.changed()).map((r) => [r.name, ctl.values.get(r.name)]));
    if (!graph || !Object.keys(values).length) return;
    ctl.saving = true; renderBar();
    // values still on their way go first; the save carries what the controls show
    flushVars();
    const j = await api.saveVars(graph, values);
    ctl.saving = false;
    if (graph !== ctl.graph) return;
    if (!j.ok) { ctx.message(j.error, 'err', 8000); renderBar(); return; }
    ctl.graphVars = j.graphVars ?? ctl.graphVars;
    for (const [k, r] of ctl.rows) { if (Object.hasOwn(ctl.graphVars, k)) r.base = ctl.graphVars[k]; r.sync(); }
    renderBar();
    ctx.message(`saved ${j.saved.length} value${j.saved.length === 1 ? '' : 's'} to ${j.file}: ${j.saved.join(', ')}`, 'ok', 5000);
  };

  /**
   * A change from a control; `final` ends the change (one undo step from its start). `undoing` skips the record.
   * `shown` is what the control shows when `value` is not it (null: back to the graph file's value).
   */
  function queueVar(name, value, final = false, undoing = false, shown = value) {
    if (!undoing && !ctl.begin.has(name)) ctl.begin.set(name, ctl.values.get(name));
    ctl.pending[name] = value;
    ctl.values.set(name, shown);
    ctl.rows.get(name)?.sync();
    renderBar();
    if (final) {
      const before = ctl.begin.get(name), graph = ctl.graph;
      ctl.begin.delete(name);
      if (!undoing && !same(before, shown)) {
        const apply = (v) => {
          if (ctl.graph === graph && ctl.rows.has(name)) { ctl.rows.get(name).set(v); queueVar(name, v, true, true); }
          else api.vars(graph, { [name]: v });
        };
        ctx.undo.push({ label: `${name} = ${short(shown)}`, undo: () => apply(before), redo: () => apply(shown) });
      }
      return flushVars();
    }
    const wait = 100 - (performance.now() - ctl.lastSend);
    if (wait <= 0) flushVars();
    else if (!ctl.timer) ctl.timer = setTimeout(flushVars, wait);
  }

  /** Send the changes on the way; the answer comes once a cook has applied them (or a stop ended it). */
  async function flushVars() {
    clearTimeout(ctl.timer); ctl.timer = 0;
    const vars = ctl.pending, graph = ctl.graph;
    if (!graph || !Object.keys(vars).length) return;
    ctl.pending = {};
    const id = ++ctl.seq;
    ctl.lastSend = performance.now();
    for (const k in vars) ctl.unacked.set(k, id);
    const j = await api.vars(graph, vars);
    const now = performance.now();
    for (const k in vars) if (ctl.unacked.get(k) === id) { ctl.unacked.delete(k); ctl.ackAt.set(k, now); }
    if (graph !== ctl.graph) return;
    const what = Object.entries(vars).map(([k, v]) => `${k} = ${v === null ? short(ctl.values.get(k)) : short(v)}`).join(', ');
    // the cook's own state (time, failing node, where it stopped) is in the status bar; this says what was sent
    if (j.stopped) ctx.message(`${what} set · its cook was stopped at ${j.stopped}`);
    else if (j.ok) ctx.message(`${what} · cooked in ${fmtDuration(j.ms)}`, 'ok');
    else ctx.message(`${j.vars ? `${what} applied, cook failed` : `${what} not applied`} — ${(j.errors ?? []).join('; ') || 'unknown error'}`, 'err');
    if (j.graphVars) ctl.graphVars = j.graphVars;
    if (j.vars) applyValues(j.vars, now);
  }
  return { render, flush: flushVars };
}
