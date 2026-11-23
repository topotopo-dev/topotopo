// The properties column: what the selection is (a guide's name, kind,
// translate, rotation, radius or size and the guide's attributes; a layer's file, counts, bbox and
// display mode; a result's output, node, counts and material; a piece's size; a CV's point), and below it the
// Controls: the graph's exposed vars as sliders, fields, checkboxes, menus and colour pickers, under a collapsible
// heading per param "group". Drags post at most every 100 ms; each control resets to its default; undeclared vars are
// listed under "other vars" (closed when the graph declares params).
import { api } from './api.js';
import * as M from './markers.js';
import { typedValue } from './transform.js';
import { parseId } from './selection.js';
import { DISPLAY_MODES, LAYER_MODES } from './scene.js';
import { fmtLen, fmtNum, fmtSize, fmtCount } from './units.js';
import { isNum, same, HEX3, fmt, short, kindOf, blank, menuOf, rangeOf, widenRange, pastDeclared, snapTo, controlList, controlSections, sectionClosed, baseValue, rowShape, sessionText, serverValueWins } from './vars.js';
import { packageSaveText, finishPackageSave, rememberOpening, revertTitle, revertAsk, revertDiff, revertPackage, pastRangeText } from './vars.js';
import { fmtDuration } from './cooking.js';
import { kindLine, layerChoices, shownLayer, detailChoices, PREVIEW_RES, countsLine } from './output-info.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const $ = (id) => document.getElementById(id);

export function createProps(ctx) {
  const body = $('props-body');
  let shownKey = null, shownSelection = null, dirty = false, applyingTransform = false;

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
    for (const x of vals) { const f = el('input'); f.readOnly = true; f.value = fmtNum(x, step < 1 ? 3 : 2); f.title = 'read-only'; box.append(f); }
    return box;
  };
  const numberField = (value, onSet, title) => {
    const f = el('input');
    f.type = 'number'; f.min = '0.001'; f.step = 'any'; f.value = fmt(value); f.title = title ?? '';
    f.oninput = () => { const v = Number(f.value); if (f.value.trim() !== '' && Number.isFinite(v) && v > 0) onSet(v); };
    f.onkeydown = (e) => { if (e.key === 'Enter' || e.key === 'Escape') f.blur(); };
    return f;
  };
  const transformFields = (m, label, unit, read, set, { onlyY = false, positive = false } = {}) => {
    const box = el('div', 'xyz');
    read(m).forEach((value, axis) => {
      const f = el('input');
      let shown = fmt(value), badTimer;
      f.type = 'text'; f.value = shown; f.spellcheck = false;
      const title = `${label} ${'XYZ'[axis]} (${unit})`;
      f.disabled = onlyY && axis !== 1;
      f.title = f.disabled ? 'a volume turns about Y only' : title;
      f.setAttribute('aria-label', title);
      box.append(f);
      if (f.disabled) return;
      const clearBad = () => { clearTimeout(badTimer); f.classList.remove('bad'); };
      f.oninput = clearBad;
      f.onkeydown = (e) => {
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') { f.value = shown; clearBad(); }
        f.blur();
      };
      f.onblur = () => {
        const entered = f.value, guide = ctx.guides.byId(m.id);
        if (!guide) return;
        const current = read(guide)[axis];
        const next = entered === shown ? current : typedValue(entered, current);
        if (next === null || (positive && next <= 0)) {
          clearBad();
          f.classList.add('bad');
          badTimer = setTimeout(() => {
            clearBad();
            if (f.isConnected && dirty && !body.contains(document.activeElement)) render(true);
          }, 1500);
        } else if (next !== current) {
          // Keep the fields in place while focus moves to the next one.
          applyingTransform = true;
          try { set(m.id, axis, next); }
          finally { applyingTransform = false; }
        }
        f.value = shown = fmt(read(ctx.guides.byId(m.id) ?? guide)[axis]);
      };
    });
    return box;
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
  function guide(m, canTranslate = false) {
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
    g.append(row('translate', canTranslate ? transformFields(m, 'Translate', 'm', M.pivotOf, ctx.guides.setTranslate) : xyz(M.pivotOf(m))));
    if (m.kind === 'site' || m.kind === 'volume')
      g.append(row('rotate', transformFields(m, 'Rotate', 'degrees', M.rotateOf, ctx.guides.setRotate, { onlyY: m.kind === 'volume' })));
    out.push(g);
    const k = group('shape');
    if (m.kind === 'site') k.append(row('radius (m)', numberField(m.radius, (v) => ctx.guides.setSize(id, 'radius', v), 'pscale in inputs/markers.json')));
    if (m.kind === 'volume')
      k.append(row('size (m)', transformFields(m, 'Size', 'm', M.volumeSize, ctx.guides.setVolumeSize, { positive: true })));
    if (m.kind === 'path') k.append(row('length', `${fmtLen(M.pathLength(m.points))} m`));
    if (m.kind === 'zone') k.append(row('area', `${fmtNum(M.topArea(m.points), 1)} m² from above`));
    if (m.kind !== 'site') {
      const list = el('div', 'mono');
      list.textContent = m.points.map((p, i) => `${m.kind === 'volume' ? 'corner' : 'cv'} ${i}  ${p.map((x) => fmtNum(x, 2)).join(', ')}`).join('\n');
      list.style.whiteSpace = 'pre';
      k.append(row(m.kind === 'volume' ? 'corners' : 'CVs', list));
    } else k.append(row('point', xyz(m.points[0])));
    out.push(k);
    // what a graph reads from the guide
    const a = group('what a graph reads');
    const t = el('table', 'attrs');
    for (const r of M.markerAttributes(m)) {
      const tr = el('tr');
      tr.append(el('td', '', `${r.cls} ${r.name}`), el('td', '', typeof r.value === 'string' ? JSON.stringify(r.value) : Array.isArray(r.value) ? `[${r.value.join(', ')}]` : fmt(r.value)));
      t.append(tr);
    }
    const elems = M.markerElements(m);
    a.append(t, el('div', 'hint', `inputs/markers.json${ctx.guides.saving() ? ' (saving…)' : ''}: ${elems.text}`));
    out.push(a);
    return out;
  }
  /** A CV of a curve or an area selected on its own, above its guide. */
  function cv(m, k) {
    const g = group(`CV ${k} of ${m.name}`);
    if (m.points[k]) g.append(row('point', xyz(m.points[k])));
    g.append(el('div', 'hint', 'drag it to move it · double-click it to remove it · Delete removes the selected CVs'));
    return [g, ...guide(m)];
  }
  /** The rows a result has whole or as a piece: its published output, graph and node, and its materials. */
  const resultRows = (g, id) => {
    const r = ctx.resultInfo(id);
    g.append(row('output', r.output ?? 'not a published output', r.output ? '' : 'graph.outputs names the results a graph delivers'));
    g.append(row('graph', r.graph ?? ''), row('node', r.node ?? ''));
    if (r.part) g.append(row('name', r.part, 'the name the preview file gives this part'));
    g.append(row('material', r.materials.length ? r.materials.join(', ') : 'none'));
  };
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
    const g = group('result');
    resultRows(g, 'out');
    g.append(displayRow(DISPLAY_MODES, o.display, (m) => o.setDisplay(m)));
    // what it is (the server's decision from the cooked geometry), its counts, and a heightfield's layer drawn in red
    if (o.about) g.append(row('is', kindLine({ kind: o.about.published ?? 'empty', about: o.about.text, size: o.about.size })));
    if (countsLine(o.summary)) g.append(row('counts', countsLine(o.summary)));
    if (o.about?.heightfield && !ctx.isolated) {
      const s = el('select');
      for (const c of layerChoices(o.about.heightfield)) s.append(new Option(c.label, c.value));
      s.value = shownLayer(o.about.heightfield, ctx.sceneLayer.get());
      s.onchange = () => { ctx.sceneLayer.set(s.value); s.blur(); };
      g.append(row('layer in red', s, 'the heightfield layer drawn in red over the terrain: 0..1 layers as they are, others from their minimum to their maximum'));
    }
    if (o.about?.heightfield) {
      // how finely the terrain is drawn (this browser's setting): instances scattered on the real surface sit on it when
      // every sample is drawn; finer draws take longer to load after each change
      const s = el('select'), choices = detailChoices(o.about.heightfield), cur = ctx.terrainDetail.get();
      for (const c of choices) { const op = new Option(c.label, c.value); op.disabled = c.disabled; s.append(op); }
      s.value = choices.some((c) => c.value === cur && !c.disabled) ? cur : 'preview';
      s.onchange = () => { ctx.terrainDetail.set(s.value); s.blur(); };
      g.append(row('terrain detail', s, `how finely the terrain is drawn here (it cooks at full resolution either way): the preview draws at most ${PREVIEW_RES} quads per side; instances placed on the surface sit exactly on it only with every sample. Finer draws take longer to load after each change. Remembered in this browser.`));
    }
    if (o.report?.cooked) g.append(row('cook', `${fmtNum(o.report.ms, 0)} ms${o.report.ok ? '' : ' · failed'}`));
    const ec = o.mesh?.edgeCounts();
    if (ec) g.append(row('edges', `${fmtCount(ec.open)} open · ${fmtCount(ec.nonManifold)} non-manifold · ${fmtCount(ec.flipped)} flipped`, 'the edge check in the viewport\'s shading menu draws them: pink open, yellow non-manifold, violet winding flips'));
    // the whole summary, folded: the line above says what it is
    if (o.summary) { const f = el('details', 'fold'); f.append(el('summary', '', 'Geometry details'), summaryBlock(o.summary)); g.append(f); }
    else g.append(el('div', 'hint', o.error ?? '…'));
    out.push(g);
    return out;
  }
  function piece(e, k) {
    const out = [], g = group(`piece ${k} of ${e.kind === 'output' ? 'the result' : `inputs/${e.path}`}`);
    if (e.kind === 'output') resultRows(g, `out#${k}`);
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
      const k = e?.kind === 'guide' ? (p !== null ? 'CV' : M.EDITOR_NAMES[e.marker.kind]) : p !== null ? 'piece' : e?.kind === 'layer' ? 'layer' : 'result';
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
    const selection = JSON.stringify(ids);
    if (!force && key === shownKey) return;
    if (applyingTransform || (body.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName))
      || (selection === shownSelection && body.querySelector('.xyz input.bad'))) { dirty = true; return; }
    shownKey = key; shownSelection = selection; dirty = false;
    // one selected: what it is; more: how many, then the lead (the last one added) in full
    const one = (id) => {
      const { obj, piece: p } = parseId(id), e = ctx.objects.get(obj);
      if (!e) return [group('gone')];
      if (e.kind === 'guide') return p !== null ? cv(e.marker, p) : guide(e.marker, ids.length === 1);
      if (p !== null) return piece(e, p);
      return e.kind === 'layer' ? layer(e) : output();
    };
    let parts;
    if (!lead) {
      const g = group('nothing selected');
      g.append(el('div', 'hint', 'click a guide, a CV or an input to select it, or its row in the outliner; Shift-click a result (cooked geometry) to read it here; Shift adds, Ctrl takes out, Shift-drag boxes guides and CVs. ? shows the keys.'));
      parts = [g];
    } else if (ids.length > 1) parts = [...many(ids), ...one(lead)];
    else parts = one(lead);
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
// writes them into the file's vars. In a package the values edit the stored graph and ↺ goes to the declared default.
function createControls(ctx) {
  const box = $('controls'), count = $('controls-count');
  const bar = $('controls-session'), barText = bar.querySelector('.stext'), saveBtn = $('vars-save'), resetBtn = $('vars-reset');
  const revertBtn = $('vars-revert');
  const ctl = {
    graph: null, mode: 'package', file: null, graphVars: {}, rows: new Map(), active: null, deferred: null, saving: false,
    pending: {}, rangeNotes: new Map(), timer: 0, lastSend: -1e9, seq: 0, edits: null,
    // var → id of its newest POST not answered yet / time its newest POST was answered: older server state is ignored
    unacked: new Map(), ackAt: new Map(),
    // var → its value when the change being made began (the undo step's "before")
    begin: new Map(), values: new Map(),
    sub: el('div', 'sub'), none: el('div', 'none'),
    // section key → its heading (sectionHead)
    heads: new Map(),
  };
  ctx.on('package-edits', renderBar);
  ctx.on('guides', renderBar);

  function openPackage(info) {
    if (info.file != null) return;
    const key = JSON.stringify([info.folder, info.package?.id]);
    const previous = ctx.packageEdits;
    if (previous?.key === key) return;
    ctx.packageEdits = { key, opening: {}, graphs: new Map(), answers: new Map(), varsPending: 0, guidesPending: false };
    if (previous) {
      ctx.undo.clear();
      ctx.guides.resetPackage();
      ctx.guides.load();
    }
    renderBar();
  }

  function readGraphs(list, issued) {
    const state = ctx.packageEdits;
    if (!state) return;
    const graphs = new Map();
    for (const g of list) if (g.mode === 'package') {
      if (state.answers.get(g.name)?.at > issued && state.graphs.has(g.name)) g.vars = g.graphVars = state.graphs.get(g.name);
      graphs.set(g.name, g.graphVars ?? g.vars ?? {});
    }
    rememberOpening(state.opening, 'graphs', graphs);
    state.graphs = graphs;
  }
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
      // min/max are the slider's range, not a limit: a value past them is kept and the slider widens to it; ↺ (and
      // Reset all) bring the declared range back (vars.js rangeOf)
      let cur = value, r = rangeOf(vd, cur, intSteps);
      const slider = el('input'), num = el('input');
      slider.type = 'range'; num.type = 'number'; num.step = int ? String(r.step) : 'any';
      const fit = () => { slider.min = r.lo; slider.max = r.hi; slider.step = r.step; };
      const widen = (v) => { const [lo, hi, st] = [r.lo, r.hi, r.step]; widenRange(r, v); if (r.lo !== lo || r.hi !== hi || r.step !== st) fit(); };
      const show = () => {
        slider.value = cur; num.value = fmt(cur);
        const past = pastDeclared(vd, cur);
        num.classList.toggle('past', past);
        num.title = past ? `past the declared range ${vd.min ?? '…'}..${vd.max ?? '…'}: kept (↺ brings back the declared value and range)` : '';
      };
      slider.addEventListener('pointerdown', () => { ctl.active = name; });
      slider.addEventListener('input', () => { cur = snapTo(r, Number(slider.value)); num.value = fmt(cur); queueVar(name, cur); });
      // a finished change gives the keys back to the viewport
      slider.addEventListener('change', () => { queueVar(name, cur, true); slider.blur(); });
      num.addEventListener('change', () => {
        let v = Number(num.value);
        if (num.value.trim() === '' || !Number.isFinite(v)) return show();
        if (int) v = Math.round(v);
        widen(v); cur = v; show(); queueVar(name, v, true, false, v, pastRangeText(name, vd, v));
      });
      cw.append(slider, num);
      fit(); widen(cur); show();
      return {
        set(v) { if (!isNum(v)) return; cur = v; widen(v); show(); },
        get: () => cur, typing: () => document.activeElement === num,
        /** ↺: the declared range again, widened only as far as the value it goes back to needs */
        reset(v) { if (!isNum(v)) return; r = rangeOf(vd, v, intSteps); cur = v; fit(); widen(v); show(); },
      };
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
      /** ↺: the value, and a slider's declared range */
      reset(v) { (w.reset ?? w.set)(v); r.sync(); },
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
    if (ctl.graph !== name || ctl.edits !== ctx.packageEdits) {
      if (ctl.graph && ctl.edits === ctx.packageEdits) flushVars();
      clearTimeout(ctl.timer); ctl.timer = 0; ctl.rangeNotes.clear();
      ctl.pending = {}; ctl.unacked.clear(); ctl.ackAt.clear(); ctl.begin.clear(); ctl.values.clear();
      for (const r of ctl.rows.values()) r.el.remove();
      ctl.rows.clear(); ctl.deferred = null;
      ctl.graph = name; ctl.edits = ctx.packageEdits;
    }
    ctl.mode = g?.mode ?? 'package'; ctl.file = g?.file ?? null;
    const params = g?.params ?? {}, vars = g?.vars ?? {};
    ctl.graphVars = g?.graphVars ?? vars;
    const { declared, other } = controlList(params, vars);
    count.textContent = declared.length + other.length || '';
    let deferred = false;
    const wanted = new Set(), els = [];
    const place = (k, vd, closed) => {
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
      r.el.hidden = closed;
      els.push(r.el);
    };
    // declared params without a group, then a collapsible heading per group (declaration order), then the undeclared
    // vars: behind a closed "other vars" heading when the graph declares params (vars.js controlSections)
    const saved = sectionState(name);
    for (const sec of controlSections(params, vars)) {
      const closed = sectionClosed(sec, saved);
      if (sec.group !== null) els.push(sectionHead(sec, closed).el);
      else if (sec.other) { ctl.sub.textContent = 'vars (none declared in "params")'; els.push(ctl.sub); }
      for (const k of sec.keys) place(k, sec.other ? null : params[k] ?? {}, closed);
    }
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
    for (const [key, h] of ctl.heads) if (!els.includes(h.el)) { h.el.remove(); ctl.heads.delete(key); }
    ctl.deferred = deferred ? [g, issued] : null;
    applyValues(vars, issued);
    for (const r of ctl.rows.values()) r.sync();
    renderBar();
  }

  /** The sections a person opened or closed, per graph: remembered in this browser ({section key: closed}). */
  const sectionState = (graph) => ctx.store?.get(`controls.closed.${graph}`, {}) ?? {};
  /** A section's heading (kept per section key): a caret, the group's name and how many controls it holds. */
  function sectionHead(sec, closed) {
    let h = ctl.heads.get(sec.key);
    if (!h) {
      const b = el('button', 'cgroup'), caret = el('span', 'caret'), name = el('span', 'gname'), n = el('span', 'gcount');
      b.type = 'button';
      b.append(caret, name, n);
      h = { el: b, keys: [], closed: false, caret, name, n };
      b.onclick = () => {
        b.blur();
        h.closed = !h.closed;
        const st = sectionState(ctl.graph);
        st[sec.key] = h.closed;
        ctx.store?.set(`controls.closed.${ctl.graph}`, st);
        h.show();
        for (const k of h.keys) { const r = ctl.rows.get(k); if (r) r.el.hidden = h.closed; }
      };
      h.show = () => {
        h.caret.textContent = h.closed ? '▸' : '▾';
        b.setAttribute('aria-expanded', String(!h.closed));
        b.title = sec.other ? `vars the graph does not declare in "params" (${h.closed ? 'show' : 'hide'} them)` : `${h.closed ? 'show' : 'hide'} the ${h.keys.length} control${h.keys.length === 1 ? '' : 's'} of ${sec.group}`;
      };
      ctl.heads.set(sec.key, h);
    }
    h.keys = sec.keys; h.closed = closed;
    h.name.textContent = sec.group; h.n.textContent = String(sec.keys.length);
    h.el.classList.toggle('other', sec.other);
    h.show();
    return h;
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

  const hasPending = (state) => state.varsPending || state.guidesPending || (ctl.edits === state && Object.keys(ctl.pending).length);
  function renderBar() {
    const file = ctl.mode === 'file', state = ctx.packageEdits;
    revertBtn.hidden = file || !state;
    barText.title = '';
    if (!revertBtn.hidden) {
      const pending = hasPending(state), text = packageSaveText({ ...state, pending });
      const { values, guideCount } = revertDiff(state.opening, state.graphs, ctx.guides.list);
      bar.hidden = false;
      saveBtn.hidden = resetBtn.hidden = true;
      if (barText.textContent !== text) barText.textContent = text;
      barText.title = text;
      revertBtn.title = state.opening.at === undefined ? '' : revertTitle(state.opening.at);
      revertBtn.disabled = !!(pending || state.asking || !(values || guideCount));
      return;
    }
    bar.hidden = !file || !ctl.rows.size;
    if (bar.hidden) return;
    const changed = [...ctl.rows.values()].filter((r) => r.changed()).length;
    barText.textContent = sessionText(changed, ctl.file);
    // a viewer that cannot write the file (it does not name one) offers no Save
    saveBtn.hidden = !ctl.file;
    saveBtn.disabled = !changed || ctl.saving;
    saveBtn.title = ctl.file ? `write the ${changed || ''} changed value${changed === 1 ? '' : 's'} into "vars" of ${ctl.file}`.replace('  ', ' ') : '';
    resetBtn.hidden = false;
    resetBtn.disabled = !changed;
    resetBtn.title = `every value back to ${ctl.file ?? 'the graph'}'s`;
  }

  revertBtn.onclick = async () => {
    revertBtn.blur();
    const state = ctx.packageEdits;
    if (!state || revertBtn.disabled) return;
    const diff = () => revertDiff(state.opening, state.graphs, ctx.guides.list);
    const changes = diff();
    state.asking = true; renderBar();
    const yes = await ctx.ask(revertAsk(state.opening.at, changes.values, changes.guideCount, changes.newGraphs), 'Revert', 'Keep');
    state.asking = false;
    if (yes && state === ctx.packageEdits && !hasPending(state)) {
      const current = diff();
      if (same(current.edits, changes.edits) && M.markersBody(current.beforeGuides) === M.markersBody(changes.beforeGuides)) {
        revertPackage(ctx, current, (graph, values) => sendVars(graph, values));
      }
    }
    renderBar();
  };

  /** ↺ and Reset all: the vars back to their base value (over a graph file: the file's, one undo step for all). */
  function resetVars(names) {
    const rows = names.map((k) => ctl.rows.get(k)).filter((r) => r && r.base !== undefined && !same(ctl.values.get(r.name), r.base));
    if (!rows.length) return;
    const graph = ctl.graph, before = new Map(rows.map((r) => [r.name, ctl.values.get(r.name)])), after = new Map(rows.map((r) => [r.name, r.base]));
    // over a graph file null drops the session value; in a package the default is stored
    for (const r of rows) { r.reset(r.base); queueVar(r.name, ctl.mode === 'file' ? null : r.base, false, true, r.base); }
    const apply = (m, reset) => {
      if (ctl.graph !== graph) { sendVars(graph, Object.fromEntries(m)); return; }
      for (const [k, v] of m) if (ctl.rows.has(k)) { ctl.rows.get(k)[reset ? 'reset' : 'set'](v); queueVar(k, v, false, true); }
      flushVars();
    };
    ctx.undo.push({ label: rows.length === 1 ? `${rows[0].name} = ${short(rows[0].base)}` : `reset ${rows.length} values`, undo: () => apply(before), redo: () => apply(after, true) });
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
  function queueVar(name, value, final = false, undoing = false, shown = value, rangeNote = '') {
    if (!undoing && !ctl.begin.has(name)) ctl.begin.set(name, ctl.values.get(name));
    ctl.pending[name] = value;
    if (rangeNote) ctl.rangeNotes.set(name, rangeNote); else ctl.rangeNotes.delete(name);
    ctl.values.set(name, shown);
    ctl.rows.get(name)?.sync();
    renderBar();
    if (final) {
      const before = ctl.begin.get(name), graph = ctl.graph;
      ctl.begin.delete(name);
      if (!undoing && !same(before, shown)) {
        const apply = (v) => {
          if (ctl.graph === graph && ctl.rows.has(name)) { ctl.rows.get(name).set(v); queueVar(name, v, true, true); }
          else sendVars(graph, { [name]: v });
        };
        ctx.undo.push({ label: `${name} = ${short(shown)}`, undo: () => apply(before), redo: () => apply(shown) });
      }
      return flushVars();
    }
    const wait = 100 - (performance.now() - ctl.lastSend);
    if (wait <= 0) flushVars();
    else if (!ctl.timer) ctl.timer = setTimeout(flushVars, wait);
  }

  function flushVars() {
    clearTimeout(ctl.timer); ctl.timer = 0;
    const vars = ctl.pending, graph = ctl.graph;
    if (ctl.edits !== ctx.packageEdits || !graph || !Object.keys(vars).length) return;
    ctl.pending = {};
    const rangeNotes = new Map(ctl.rangeNotes);
    ctl.rangeNotes.clear();
    ctl.lastSend = performance.now();
    return sendVars(graph, vars, rangeNotes);
  }

  /** The answer reports the write separately from the cook. */
  async function sendVars(graph, vars, rangeNotes = new Map()) {
    const state = ctx.packageEdits, file = (ctx.graph.list.find((g) => g.name === graph)?.mode ?? ctl.mode) === 'file';
    const id = ++ctl.seq;
    if (graph === ctl.graph) for (const k in vars) ctl.unacked.set(k, id);
    if (state) { state.varsPending++; renderBar(); }
    const j = await api.vars(graph, vars);
    const now = performance.now();
    if (state !== ctx.packageEdits) return;
    const reason = j.notSaved || (j.errors ?? []).join('; ') || j.error || 'unknown error';
    const newer = (state?.answers.get(graph)?.id ?? 0) > id;
    if (state) {
      state.varsPending--;
      finishPackageSave(state, j.savedAt, reason);
    }
    if (j.graphVars && !file && !newer) {
      state?.graphs.set(graph, j.graphVars);
      state?.answers.set(graph, { id, at: now });
      const g = ctx.graph.list.find((g) => g.name === graph);
      if (g) { g.vars = j.vars; g.graphVars = j.graphVars; }
    }
    if (state) renderBar();
    if (graph !== ctl.graph) return;
    for (const k in vars) if (ctl.unacked.get(k) === id) { ctl.unacked.delete(k); ctl.ackAt.set(k, now); }
    if (!file) {
      const entries = Object.entries(vars), graphVars = newer ? state.graphs.get(graph) : j.graphVars;
      const confirmed = entries.filter(([k, v]) => v === null ? !Object.hasOwn(graphVars ?? {}, k) : same(graphVars?.[k], v));
      const saved = confirmed.map(([k, v]) => v === null ? `removed ${k}` : `${k} = ${short(v)}`).join(', ');
      const notes = confirmed.map(([k]) => rangeNotes.get(k)).filter(Boolean).join('\n');
      if (!isNum(j.savedAt)) {
        const what = entries.map(([k, v]) => v === null ? `removing ${k}` : `${k} = ${short(v)}`).join(', ');
        ctx.message(`${what} was not saved: ${reason}`, 'err');
      } else if (saved && !newer) {
        const result = j.stopped ? `${saved} saved · its cook was stopped`
          : j.ok ? `${saved} · cooked in ${fmtDuration(j.ms)}` : `${saved} saved, cook failed — ${reason}`;
        const text = notes && j.ok ? notes : [result, notes].filter(Boolean).join('\n');
        ctx.message(text, notes || (!j.ok && !j.stopped) ? 'err' : j.stopped ? '' : 'ok');
      } else if (notes) ctx.message(notes, 'err');
      const g = ctx.graph.current();
      if (g) render(g, now);
      return;
    }
    const what = Object.entries(vars).map(([k, v]) => `${k} = ${v === null ? short(ctl.values.get(k)) : short(v)}`).join(', ');
    // the cook's own state (time, failing node, where it stopped) is in the status bar; this says what was sent
    if (j.stopped) ctx.message(`${what} set · its cook was stopped at ${j.stopped}`);
    else if (j.ok) ctx.message(`${what} · cooked in ${fmtDuration(j.ms)}`, 'ok');
    else ctx.message(`${j.vars ? `${what} applied, cook failed` : `${what} not applied`} — ${(j.errors ?? []).join('; ') || 'unknown error'}`, 'err');
    if (j.graphVars) ctl.graphVars = j.graphVars;
    if (j.vars) applyValues(j.vars, now);
  }
  return { render, flush: flushVars, openPackage, readGraphs };
}
