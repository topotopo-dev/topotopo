// The viewer page (docs/design/viewer.md): boot, layout, the render loop over the views, the keymap and the mouse,
// the status bar and the server's event stream. The camera moves only when the person moves it or frames: loading,
// cooking, saving and placing never frame (the one exception is the very first view, when nothing is remembered).
import * as THREE from 'three';
import { api } from './api.js';
import { createViews, CAMERA_NAMES, SHADINGS } from './camera.js';
import { createGrid, createOverlays, cursorText } from './grid.js';
import { MeshObject, parseGLB, createLights, LINE_MATERIALS } from './scene.js';
import { createLayers } from './layers.js';
import { createGuides, PLACE_KINDS } from './guides.js';
import { createSelect } from './select.js';
import { createOutliner } from './outliner.js';
import { createProps } from './props.js';
import { createSelection, parseId } from './selection.js';
import { createUndo } from './undo.js';
import { EDITOR_NAMES } from './markers.js';
import * as KM from './keymap.js';
import { fmtStep, fmtSize, fmtNum } from './units.js';
import { connectedLine, graphsLine } from './status.js';

const $ = (id) => document.getElementById(id);
const BG = new THREE.Color('#2b2d31');

// ------------------------------------------------------------------------------------------- storage
// per-viewer conveniences: the keymap and panel sizes per browser, cameras and shown layers per viewer address
const store = (prefix) => ({
  get(k, def) { try { const v = localStorage.getItem(prefix + k); return v === null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(prefix + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
});
const local = store(`topotopo.viewer.${location.host}.`), browser = store('topotopo.viewer.');

// ------------------------------------------------------------------------------------------- context
const listeners = new Map();
let version = 0;
const ctx = {
  THREE, store: local, objects: new Map(), hover: null,
  on(type, f) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(f); },
  emit(type) { if (type !== 'hover') version++; for (const f of listeners.get(type) ?? []) f(); for (const f of listeners.get('*') ?? []) f(type); },
  version: () => version,
  /** At most one run of fn at a time; calls during a run ask for one more run after it, and wait for that. */
  coalesce(fn) {
    let busy = null, again = false;
    return () => {
      if (busy) { again = true; return busy; }
      busy = (async () => { try { do { again = false; await fn(); } while (again); } finally { busy = null; } })();
      return busy;
    };
  },
};

// ------------------------------------------------------------------------------------------- status bar
const msgEl = $('msg');
let heldUntil = 0;
/** A line in the status bar; `hold` ms keeps it over routine lines (an undo over the save that follows it). */
ctx.message = (text, kind = '', hold = 0) => {
  const now = performance.now();
  if (!hold && kind !== 'err' && now < heldUntil) return;
  heldUntil = hold ? now + hold : 0;
  msgEl.textContent = text; msgEl.className = kind; msgEl.title = text;
};
/** A small question in the status bar; resolves to the answer. */
ctx.ask = (text, yes = 'Yes', no = 'No') => new Promise((resolve) => {
  $('ask-text').textContent = text; $('ask-yes').textContent = yes; $('ask-no').textContent = no;
  $('ask').hidden = false;
  const done = (v) => { $('ask').hidden = true; $('ask-yes').onclick = $('ask-no').onclick = null; resolve(v); };
  $('ask-yes').onclick = () => done(true);
  $('ask-no').onclick = () => done(false);
  $('ask-yes').focus();
});

// ------------------------------------------------------------------------------------------- three.js
const viewport = $('viewport'), canvas = $('gl');
// logarithmic depth: a 1 km terrain and a door handle in one view without near-plane clipping or z-fighting
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.autoClear = false;
const scene = new THREE.Scene();
ctx.outputRoot = new THREE.Group(); ctx.outputRoot.name = 'output';
ctx.layersRoot = new THREE.Group(); ctx.layersRoot.name = 'layers';
ctx.guidesRoot = new THREE.Group(); ctx.guidesRoot.name = 'guides';
scene.add(ctx.outputRoot, ctx.layersRoot, ctx.guidesRoot);
const lights = createLights(scene);
const grid = createGrid(scene);

/** Bounds of everything drawn (the output, the shown layers, the guides). */
ctx.sceneBounds = ({ pictures = true, guides = true } = {}) => {
  const b = new THREE.Box3();
  if (ctx.output.mesh && ctx.output.visible) b.union(ctx.output.mesh.bounds());
  b.union(ctx.layers.bounds({ pictures }));
  if (guides) for (const m of ctx.guides.list) if (!ctx.guides.hidden.has(m.id)) b.union(ctx.guides.bounds(m));
  return b;
};
let sphere = { center: new THREE.Vector3(), radius: 10 }, sphereAt = -1;
const views = createViews(() => {
  if (sphereAt !== version) {
    sphereAt = version;
    const b = ctx.sceneBounds();
    sphere = b.isEmpty() ? { center: new THREE.Vector3(), radius: 10 } : { center: b.getCenter(new THREE.Vector3()), radius: Math.max(b.getSize(new THREE.Vector3()).length() / 2, 1e-3) };
  }
  return sphere;
});
ctx.views = views;
views.load(local.get('views', null));
const saveViews = () => local.set('views', views.toJSON());

// what is being drawn: per view, the slot and its rect (constant-size marks scale by it)
let drawing = { rect: { h: 1 } };
/** Metres per pixel at a world point for the view being drawn. */
ctx.pxWorld = (camera, at) => {
  const h = Math.max(1, drawing.rect.h);
  if (camera.isOrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / h;
  const d = Math.max(1e-9, -at.clone().applyMatrix4(camera.matrixWorldInverse).z);
  return (2 * d * Math.tan((camera.fov * Math.PI) / 360)) / h;
};

// ------------------------------------------------------------------------------------------- selection, undo, parts
ctx.selection = createSelection((obj) => ctx.objects.get(obj)?.mesh?.pieceCount() ?? 0);
ctx.undo = createUndo();
ctx.setHover = (id) => { if (ctx.hover === id) return; ctx.hover = id; ctx.emit('hover'); };

// the output: the node being shown, its display mode and visibility remembered
ctx.output = {
  mesh: null, summary: '', error: null, report: null, loading: false,
  visible: local.get('output.visible', true), display: local.get('output.display', 'view'),
  setVisible(v) { this.visible = v; local.set('output.visible', v); outEntry(); ctx.emit('output'); ctx.requestRender(); },
  setDisplay(m) { this.display = m; local.set('output.display', m); outEntry(); ctx.emit('output'); ctx.requestRender(); },
};
const outEntry = () => {
  const o = ctx.output;
  ctx.objects.set('out', { id: 'out', kind: 'output', label: 'output', mesh: o.mesh, visible: o.visible, display: o.display, pickable: true, surface: true });
};
outEntry();

ctx.layers = createLayers(ctx);
ctx.guides = createGuides(ctx);
ctx.select = createSelect(ctx);
ctx.surfacePoint = ctx.select.surfacePoint;
ctx.planePoint = ctx.select.planePoint;
const outliner = createOutliner(ctx, $('tree'));
const props = createProps(ctx);

// ------------------------------------------------------------------------------------------- graphs and the output
ctx.graph = {
  list: [], name: null, node: null,
  current() { return this.list.find((g) => g.name === this.name) ?? null; },
  /** the node whose result is shown: the chosen one, else the graph's output */
  shownNode() { const g = this.current(); return this.node ?? g?.output ?? null; },
  show(node) {
    const g = this.current();
    this.node = !g || node === g.output ? null : node;
    ctx.selection.apply(['out']);
    loadGeo(); ctx.emit('graphs');
  },
};
const refreshGraphs = ctx.coalesce(async () => {
  const issued = performance.now();
  const list = await api.graphs();
  if (!list) return;
  const G = ctx.graph;
  G.list = list;
  const names = list.map((g) => g.name);
  const sel = $('graph');
  // the options are rebuilt only when the graphs change, so an open list stays open
  if (names.join('\n') !== [...sel.options].map((o) => o.value).join('\n')) sel.replaceChildren(...names.map((n) => new Option(n, n)));
  if (!names.includes(G.name)) { G.name = local.get('graph', null); if (!names.includes(G.name)) G.name = names[0] ?? null; G.node = null; }
  sel.value = G.name ?? '';
  const g = G.current();
  if (G.node && !g?.nodes.some((n) => n.name === G.node)) G.node = null;
  props.controls.render(g, issued);
  const line = graphsLine(msgEl.textContent, list.length);
  if (line) ctx.message(line);
  ctx.emit('graphs');
});
$('graph').onchange = (e) => {
  ctx.graph.name = e.target.value; ctx.graph.node = null;
  local.set('graph', ctx.graph.name);
  props.controls.render(ctx.graph.current());
  ctx.emit('graphs');
  loadGeo();
};

let firstFrame = !views.placed;
const loadGeo = ctx.coalesce(async () => {
  const G = ctx.graph, o = ctx.output;
  if (!G.name) return;
  const graph = G.name, node = G.node ?? '';
  o.loading = true; ctx.emit('output');
  const r = await api.geo(graph, node);
  o.loading = false;
  if (graph !== G.name) return;
  if (!r.ok) {
    // the last good geometry stays
    o.error = r.error;
    ctx.emit('output'); updateCook();
    return;
  }
  let src;
  try { src = await parseGLB(r.buf); } catch (e) { o.error = String(e?.message ?? e); ctx.emit('output'); updateCook(); return; }
  const prev = o.mesh;
  o.mesh = new MeshObject('out', src);
  o.mesh.onReady = () => { ctx.requestRender(); ctx.emit('output'); };
  o.error = null;
  ctx.outputRoot.add(o.mesh.root);
  if (prev) prev.dispose();
  outEntry();
  // pieces that no longer exist leave the selection (counting pieces only when some are selected)
  if (ctx.selection.items.some((id) => id.startsWith('out#'))) ctx.selection.prune((id) => { const { obj, piece } = parseId(id); return obj !== 'out' || piece === null || piece < o.mesh.pieceCount(); });
  // the very first view frames what there is; later loads never move the camera
  if (firstFrame) { firstFrame = false; frameEverywhere(); }
  ctx.emit('output');
  ctx.requestRender();
  const [info, report] = await Promise.all([api.info(graph, node), api.report(graph)]);
  if (graph !== G.name) return;
  o.summary = info?.summary ?? '';
  o.report = report;
  ctx.emit('output'); updateCook();
});

function updateCook() {
  const el = $('cook'), o = ctx.output, g = ctx.graph.current();
  if (!g) { el.textContent = ''; return; }
  const m = /geometry: ([\d,]+) points, ([\d,]+) prims/.exec(o.summary ?? '');
  const parts = [`${g.name}/${ctx.graph.shownNode() ?? ''}`];
  if (m) parts.push(`${m[1]} points`, `${m[2]} prims`);
  if (o.report?.cooked) parts.push(`cook ${fmtNum(o.report.ms, 0)} ms`);
  const err = o.error ?? (o.report?.errors?.length ? o.report.errors[0] : null) ?? g.nodes.find((n) => n.error)?.error;
  el.replaceChildren(document.createTextNode(parts.join(' · ')));
  if (err) { const e = document.createElement('span'); e.className = 'err'; e.textContent = ` · ${String(err).split('\n')[0]}`; el.append(e); el.title = String(err); }
  else el.title = parts.join(' · ');
}

// ------------------------------------------------------------------------------------------- framing
/** The views' rects for the viewport as it is now (framing needs each view's aspect). */
const layoutViews = () => views.layout(viewport.clientWidth, viewport.clientHeight);
function frameEverywhere() {
  const b = ctx.sceneBounds();
  if (b.isEmpty()) return;
  // each slot as the quad shows it, then the single view as it is
  const quad = views.quad;
  views.quad = true; layoutViews();
  for (let i = 0; i < 4; i++) if (i !== views.active) views.frame(i, b);
  views.quad = quad; layoutViews();
  views.frame(views.active, b);
  saveViews();
}
function frameSelection() {
  const b = ctx.select.selectionBounds();
  if (b.isEmpty()) return frameAll();
  layoutViews(); views.frame(views.active, b); saveViews(); ctx.requestRender();
}
function frameAll() {
  let b = ctx.sceneBounds();
  if (b.isEmpty()) b = new THREE.Box3(new THREE.Vector3(-5, -1, -5), new THREE.Vector3(5, 1, 5));
  layoutViews(); views.frame(views.active, b); saveViews(); ctx.requestRender();
}

// ------------------------------------------------------------------------------------------- drawing
const overlays = createOverlays($('views'), (slot, axis) => { setActive(slot); views.lookAlong(slot, axis); saveViews(); syncTop(); ctx.requestRender(); });
const cursor = { slot: -1, x: 0, y: 0 };
let queued = false, overlayQueued = false, lastSize = '', inDraw = false;
ctx.requestRender = () => { if (!queued && !inDraw) { queued = true; requestAnimationFrame(draw); } };
const requestOverlays = () => { if (!overlayQueued && !queued) { overlayQueued = true; requestAnimationFrame(() => { overlayQueued = false; if (!queued) drawOverlays(); }); } };
const modeOf = (display, shading) => (display === 'view' ? shading : display);
const steps = [1, 1, 1, 1];

function draw() {
  queued = false;
  inDraw = true;
  try { drawViews(); } finally { inDraw = false; }
  drawOverlays();
}
function drawViews() {
  const W = viewport.clientWidth, H = viewport.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
  if (`${W}x${H}@${dpr}` !== lastSize) { lastSize = `${W}x${H}@${dpr}`; renderer.setPixelRatio(dpr); renderer.setSize(W, H, false); }
  views.layout(W, H);
  renderer.setScissorTest(true);
  renderer.setClearColor(BG, 1);
  const entries = [...ctx.objects.values()].filter((e) => e.mesh);
  for (const e of entries) e.mesh.bboxMode = e.display === 'bbox';
  // highlights and guide states first, so this frame shows them
  ctx.select.highlight();
  for (const s of views.visible()) {
    const i = views.slots.indexOf(s), r = s.rect, camera = views.camera(i), cam = views.cam(i);
    drawing = { slot: i, rect: r };
    const glY = H - r.y - r.h;
    renderer.setViewport(r.x, glY, r.w, r.h);
    renderer.setScissor(r.x, glY, r.w, r.h);
    renderer.clear();
    for (const m of LINE_MATERIALS) m.resolution.set(r.w, r.h);
    for (const e of entries) { e.mesh.root.visible = !!e.visible; e.mesh.setMode(modeOf(e.display ?? 'view', s.shading)); }
    steps[i] = grid.prepare(cam, views.worldPerPixel(i));
    lights.follow(camera, cam.target);
    renderer.render(scene, camera);
  }
}

/** Readouts, the gizmo, labels and the pivot cross of every view (DOM, no WebGL). */
function drawOverlays() {
  const selBox = ctx.selection.size ? ctx.select.selectionBounds() : null;
  const selSize = selBox && !selBox.isEmpty() ? fmtSize(selBox.getSize(new THREE.Vector3()).toArray()) : '';
  const pivot = selBox && !selBox.isEmpty() ? selBox.getCenter(new THREE.Vector3()) : null;
  const labels = ctx.guides.labels();
  for (let i = 0; i < 4; i++) {
    const s = views.slots[i], ov = overlays[i], visible = views.visible().includes(s);
    if (!visible) { ov.update({ visible: false }); continue; }
    const cam = views.cam(i), camera = views.camera(i);
    let cur = '';
    if (cursor.slot === i && cam.ortho) {
      const p = cam.name === 'persp' ? ctx.select.planePoint(i, cursor.x, cursor.y, 0) : ctx.surfacePlane(i, cursor.x, cursor.y);
      cur = cursorText(cam, p, steps[i]);
    }
    ov.update({ rect: s.rect, visible, quad: views.quad, active: i === views.active, cam, camera, step: steps[i], cursor: cur, selSize });
    // labels of hovered / selected guides
    const seen = new Set();
    for (const l of labels) {
      const q = views.project(i, l.at, camera);
      let e = ov.labels.querySelector(`[data-k="${CSS.escape(l.key)}"]`);
      if (!q) { e?.remove(); continue; }
      if (!e) { e = document.createElement('div'); e.dataset.k = l.key; ov.labels.append(e); }
      seen.add(l.key);
      if (e.textContent !== l.text) e.textContent = l.text;
      e.className = l.cls;
      e.style.left = `${q.x - s.rect.x}px`; e.style.top = `${q.y - s.rect.y}px`;
    }
    for (const e of [...ov.labels.children]) if (!seen.has(e.dataset.k)) e.remove();
    // the pivot of the selection: a small cross
    const q = pivot && views.project(i, pivot, camera);
    ov.marks.innerHTML = q ? `<g stroke="#f0a030" stroke-width="1.5"><line x1="${q.x - s.rect.x - 6}" y1="${q.y - s.rect.y}" x2="${q.x - s.rect.x + 6}" y2="${q.y - s.rect.y}"/><line x1="${q.x - s.rect.x}" y1="${q.y - s.rect.y - 6}" x2="${q.x - s.rect.x}" y2="${q.y - s.rect.y + 6}"/></g>` : '';
  }
  const st = $('step');
  const t = `grid ${fmtStep(steps[views.active])}`;
  if (st.textContent !== t) st.textContent = t;
}
/** The cursor on an axis view's construction plane. */
ctx.surfacePlane = (i, x, y) => {
  const c = views.cam(i), f = { top: 1, bottom: 1, front: 2, back: 2, right: 0, left: 0 }[c.name];
  const n = new THREE.Vector3(f === 0 ? 1 : 0, f === 1 ? 1 : 0, f === 2 ? 1 : 0);
  return views.ray(i, x, y).ray.intersectPlane(new THREE.Plane(n, 0), new THREE.Vector3());
};
new ResizeObserver(() => ctx.requestRender()).observe(viewport);

// ------------------------------------------------------------------------------------------- top bar
let preset = browser.get('keymap', KM.DEFAULT_PRESET);
if (!KM.PRESETS.some((p) => p.id === preset)) preset = KM.DEFAULT_PRESET;
$('preset').replaceChildren(...KM.PRESETS.map((p) => new Option(p.label, p.id)));
$('preset').value = preset;
$('preset').onchange = (e) => { preset = e.target.value; browser.set('keymap', preset); e.target.blur(); ctx.message(`keymap: ${KM.PRESETS.find((p) => p.id === preset).label} (? shows it)`); };
$('view-cam').replaceChildren(...CAMERA_NAMES.map((n) => new Option(n, n)));
$('view-cam').onchange = (e) => { views.setCam(views.active, e.target.value); saveViews(); e.target.blur(); syncTop(); ctx.requestRender(); };
$('view-shading').replaceChildren(...SHADINGS.map(([v, t]) => new Option(t, v)));
$('view-shading').onchange = (e) => { views.slots[views.active].shading = e.target.value; saveViews(); e.target.blur(); ctx.requestRender(); };
$('quad').onclick = () => { toggleQuad(); $('quad').blur(); };
$('help').onclick = () => { KM.toggleOverlay(document.body, preset); $('help').blur(); };
function syncTop() {
  const s = views.slots[views.active];
  $('view-cam').value = s.cam;
  $('view-shading').value = s.shading;
  $('quad').classList.toggle('on', views.quad);
  $('quad').textContent = views.quad ? 'single' : 'quad';
  const mode = ctx.guides.mode;
  $('mode').textContent = mode ? `placing ${EDITOR_NAMES[mode]}` : '';
}
function setActive(i) { if (i >= 0 && views.active !== i) { views.active = i; syncTop(); requestOverlays(); } }
function toggleQuad(at = cursor.slot) {
  if (views.quad && at >= 0) views.active = at;
  views.quad = !views.quad;
  // the new rects at once: the next click must not wait for a frame
  layoutViews();
  saveViews(); syncTop(); ctx.requestRender();
}

// ------------------------------------------------------------------------------------------- panels: drag to resize
const layout = browser.get('layout', {});
const root = document.documentElement.style;
const applyLayout = () => {
  if (layout.left) root.setProperty('--left', `${layout.left}px`);
  if (layout.right) root.setProperty('--right', `${layout.right}px`);
  if (layout.split) root.setProperty('--split', `${layout.split}%`);
};
applyLayout();
for (const g of document.querySelectorAll('.grip')) {
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    g.classList.add('drag');
    const kind = g.dataset.grip, props0 = $('props').getBoundingClientRect();
    const move = (ev) => {
      if (kind === 'left') layout.left = Math.round(Math.max(160, Math.min(innerWidth * 0.45, ev.clientX)));
      else if (kind === 'right') layout.right = Math.round(Math.max(220, Math.min(innerWidth * 0.5, innerWidth - ev.clientX)));
      else layout.split = Math.round(Math.max(10, Math.min(90, ((ev.clientY - props0.top - 26) / Math.max(1, props0.height - 52)) * 100)));
      applyLayout(); ctx.requestRender();
    };
    const up = () => { g.classList.remove('drag'); g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); browser.set('layout', layout); };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
  });
}

// ------------------------------------------------------------------------------------------- actions
/** Keys go to a field being typed in (text and number fields, menus), not to the keymap. */
const TEXT_INPUTS = new Set(['text', 'number', 'search', 'email', 'url', 'password', 'tel']);
const typing = (t) => (t instanceof HTMLInputElement && TEXT_INPUTS.has(t.type)) || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || !!t?.isContentEditable;
const selectedOf = (kind) => ctx.selection.items.filter((id) => ctx.objects.get(parseId(id).obj)?.kind === kind && parseId(id).piece === null);
const hiddenByH = { layers: new Set() };
const DISPLAY_CYCLE = ['shaded', 'wire', 'shadedWire'];
function run(action) {
  const slot = views.slots[views.active];
  switch (action) {
    case 'frameSelection': return frameSelection();
    case 'frameAll': return frameAll();
    case 'quad': return toggleQuad();
    case 'viewPersp': case 'viewTop': case 'viewFront': case 'viewRight':
      views.setCam(views.active, action.slice(4).toLowerCase()); saveViews(); syncTop(); return ctx.requestRender();
    case 'ortho': views.toggleOrtho(views.active); saveViews(); syncTop(); return ctx.requestRender();
    case 'selectMode': ctx.guides.setMode(null); return syncTop();
    case 'displayWire': case 'displayShaded': case 'displayShadedWire':
      slot.shading = { displayWire: 'wire', displayShaded: 'shaded', displayShadedWire: 'shadedWire' }[action]; break;
    case 'displayCycle': slot.shading = DISPLAY_CYCLE[(DISPLAY_CYCLE.indexOf(slot.shading) + 1) % 3]; break;
    case 'wireToggle': slot.lastShading = slot.shading === 'wire' ? slot.lastShading : slot.shading; slot.shading = slot.shading === 'wire' ? slot.lastShading ?? 'shaded' : 'wire'; break;
    case 'placeNull': case 'placeCurve': case 'placeArea': case 'placeVolume': ctx.guides.setMode(PLACE_KINDS[action]); return syncTop();
    case 'finish': case 'removeLast': ctx.guides.key(action); return;
    case 'cancel': {
      if (document.querySelector('.keymap-overlay')) return KM.toggleOverlay(document.body, preset);
      if (ctx.select.press) return ctx.select.cancel();
      if (ctx.guides.key('cancel')) return;
      ctx.guides.setMode(null); ctx.selection.clear(); return syncTop();
    }
    case 'delete': {
      const ids = selectedOf('guide').map((id) => id.slice(6));
      const n = ctx.guides.remove(ids);
      if (n) ctx.message(`deleted ${n} guide${n === 1 ? '' : 's'} · ${undoKeys()} brings ${n === 1 ? 'it' : 'them'} back`, '', 2000);
      else if (ctx.selection.size) ctx.message('Delete removes guides; the output and reference layers are files and stay (hide them with H)');
      return;
    }
    case 'undo': case 'redo': {
      const label = action === 'undo' ? ctx.undo.undo() : ctx.undo.redo();
      return ctx.message(label ? `${action === 'undo' ? 'undid' : 'redid'} ${label}` : `nothing to ${action}`, '', 2000);
    }
    case 'hide': {
      if (selectedOf('output').length || ctx.selection.items.some((id) => parseId(id).obj === 'out')) ctx.output.setVisible(false);
      for (const id of selectedOf('layer')) { const p = id.slice(6); hiddenByH.layers.add(p); ctx.layers.show(p, false); }
      ctx.guides.setHidden(selectedOf('guide').map((id) => id.slice(6)), true);
      return;
    }
    case 'showAll': {
      ctx.output.setVisible(true);
      for (const p of hiddenByH.layers) if (ctx.layers.list.some((f) => f.path === p)) ctx.layers.show(p, true);
      hiddenByH.layers.clear();
      ctx.guides.showAll();
      return;
    }
    case 'overlay': return KM.toggleOverlay(document.body, preset);
    default: return;
  }
  saveViews(); syncTop(); ctx.requestRender();
}
const undoKeys = () => KM.overlayRows(preset).find((r) => r.label.startsWith('undo'))?.text.split(' / ')[0] ?? 'undo';

// keys; Space is a tap (Maya) or a held modifier (Houdini)
const space = { down: false, tap: false, t: 0 };
addEventListener('keydown', (e) => {
  if (typing(e.target)) return;
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    if (!e.repeat && !space.down) { space.down = true; space.tap = true; space.t = performance.now(); }
    return;
  }
  if (space.down) space.tap = false;
  if (e.key === 'Alt') { e.preventDefault(); return; }
  const action = KM.matchKey(preset, e, space.down && KM.spaceIsModifier(preset));
  if (!action) return;
  e.preventDefault();
  run(action);
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.key === ' ') {
    const tap = space.down && space.tap && performance.now() - space.t < 400;
    space.down = false;
    if (tap && !typing(e.target)) { const a = KM.matchKey(preset, { key: ' ', code: 'Space' }); if (a) run(a); }
    return;
  }
  if (e.key === 'Alt') e.preventDefault();
});
addEventListener('blur', () => { space.down = false; });

// the mouse in the viewport
let drag = null;
const at = (e) => { const r = viewport.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
canvas.addEventListener('pointerdown', (e) => {
  layoutViews();
  const { x, y } = at(e), slot = views.slotAt(x, y);
  if (slot < 0 || drag) return;
  setActive(slot);
  space.tap = false;
  // the keys go to the viewport again (preventDefault below keeps the browser from moving the focus itself)
  if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
  const nav = KM.matchDrag(preset, { button: e.button, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, space: space.down && KM.spaceIsModifier(preset) });
  try { canvas.setPointerCapture(e.pointerId); } catch { /* a pointer the browser does not track */ }
  e.preventDefault();
  if (nav) {
    const sel = ctx.select.selectionBounds();
    drag = { kind: 'nav', nav, slot, x, y, id: e.pointerId, pivot: sel.isEmpty() ? null : sel.getCenter(new THREE.Vector3()) };
    viewport.classList.add('nav');
    return;
  }
  if (e.button !== 0) return;
  if (ctx.guides.mode) { drag = { kind: 'place', slot, id: e.pointerId }; ctx.guides.pointerDown(slot, x, y); }
  else { drag = { kind: 'select', slot, id: e.pointerId }; ctx.select.down(slot, x, y, e); }
});
canvas.addEventListener('pointermove', (e) => {
  const { x, y } = at(e);
  if (drag && e.pointerId === drag.id) {
    if (drag.kind === 'nav') {
      const dx = x - drag.x, dy = y - drag.y;
      drag.x = x; drag.y = y;
      if (drag.nav === 'tumble') views.tumble(drag.slot, dx, dy, drag.pivot);
      else if (drag.nav === 'track') views.track(drag.slot, dx, dy);
      else views.dolly(drag.slot, Math.exp(-(dx - dy) * 0.006));
      ctx.requestRender();
    } else if (drag.kind === 'place') ctx.guides.pointerMove(drag.slot, x, y);
    else ctx.select.move(x, y);
    return;
  }
  layoutViews();
  const slot = views.slotAt(x, y);
  cursor.slot = slot; cursor.x = x; cursor.y = y;
  if (slot >= 0 && views.cam(slot).ortho) requestOverlays();
  if (ctx.guides.mode) { if (slot >= 0) ctx.guides.pointerMove(slot, x, y); }
  else ctx.select.hover(slot, x, y);
});
const endDrag = (e, cancel = false) => {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  viewport.classList.remove('nav');
  const { x, y } = at(e);
  if (d.kind === 'nav') saveViews();
  else if (d.kind === 'place') { if (!cancel) ctx.guides.pointerUp(d.slot, x, y); }
  else if (cancel) ctx.select.cancel(); else ctx.select.up(x, y);
};
canvas.addEventListener('pointerup', (e) => endDrag(e));
canvas.addEventListener('pointercancel', (e) => endDrag(e, true));
canvas.addEventListener('pointerleave', () => { if (!drag) { cursor.slot = -1; ctx.select.hover(-1); ctx.guides.leave(); requestOverlays(); } });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  layoutViews();
  const { x, y } = at(e), slot = views.slotAt(x, y);
  if (slot < 0) return;
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  views.dolly(slot, Math.exp(Math.max(-1, Math.min(1, dy * 0.0015))), views.targetPlanePoint(slot, x, y));
  clearTimeout(canvas.wheelTimer); canvas.wheelTimer = setTimeout(saveViews, 300);
  ctx.requestRender();
}, { passive: false });

// ------------------------------------------------------------------------------------------- refresh on changes
ctx.on('*', (type) => {
  if (type === 'hover') { ctx.requestRender(); return; }
  outliner.render();
  props.render();
  if (type === 'mode') { viewport.classList.toggle('placing', !!ctx.guides.mode); ctx.setHover(null); syncTop(); }
  if (type === 'output' || type === 'graphs') updateCook();
  ctx.requestRender();
});
ctx.selection.onChange(() => ctx.emit('selection'));

const es = api.events({
  open() {
    ctx.message(connectedLine(ctx.graph.list.length));
    // after a reconnect the server may have restarted: fetch everything again
    if (es.opened) { refreshGraphs().then(loadGeo); ctx.layers.refresh(); ctx.layers.loadWhere(); ctx.guides.load(); }
    es.opened = true;
  },
  error() { ctx.message('disconnected (server stopped?)', 'err'); },
  async message(ev) {
    if (ev.inputs !== undefined) { ctx.layers.refresh(); return; }
    await refreshGraphs();
    if (ev.graph === ctx.graph.name) loadGeo();
  },
});

syncTop();
outliner.render();
props.render();
ctx.requestRender();
await refreshGraphs();
loadGeo();
ctx.layers.refresh();
ctx.layers.loadWhere();
ctx.guides.load();
// for debugging in the browser console: the context, and a frame drawn now (where requestAnimationFrame is paused)
ctx.draw = draw;
window.topotopo = ctx;
