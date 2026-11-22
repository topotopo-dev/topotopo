// The viewer page: boot, layout, the render loop over the views, the keymap and the mouse,
// the status bar and the server's event stream. The camera moves only when the person moves it or frames: loading,
// cooking, saving and placing never frame (the one exception is the very first view, when nothing is remembered).
import * as THREE from 'three';
import { api, coalesce } from './api.js';
import { createViews, CAMERA_NAMES, SHADINGS, viewName } from './camera.js';
import { createGrid, createOverlays, cursorText } from './grid.js';
import { MeshObject, parseGLB, createLights, LINE_MATERIALS, recede } from './scene.js';
import { createLayers } from './layers.js';
import { createGuides, PLACE_KINDS } from './guides.js';
import { createSelect } from './select.js';
import { createOutliner } from './outliner.js';
import { createProps } from './props.js';
import { createOutputPanel } from './outputs.js';
import { createPackagesPanel } from './packages.js';
import { createSelection, parseId } from './selection.js';
import { createUndo } from './undo.js';
import { EDITOR_NAMES } from './markers.js';
import * as KM from './keymap.js';
import { fmtStep, fmtSize, fmtNum } from './units.js';
import { DISCONNECTED_LINE, RECONNECTED_LINE, messageLife } from './status.js';
import { compareLine, cookLine, isRunning } from './cooking.js';
import { pageTitle, defaultGraph, renderWelcome, unreadMessage } from './welcome.js';
import { kindLine, resultName } from './output-info.js';
import * as PT from './pointer.js';

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
  coalesce,
};

// ------------------------------------------------------------------------------------------- messages
// What something the person did came to, over the view's lower left; it clears itself (status.js messageLife). The
// status bar keeps the cook line and what is shown.
const notesEl = $('notes'), msgEl = $('msg');
let heldUntil = 0, noteTimer = 0;
/** A message; `hold` ms keeps it over routine ones (an undo over the save that follows it); '' clears it. */
ctx.message = (text, kind = '', hold = 0) => {
  const now = performance.now();
  if (text && !hold && kind !== 'err' && now < heldUntil) return;
  heldUntil = hold ? now + hold : 0;
  clearTimeout(noteTimer);
  msgEl.textContent = text; msgEl.title = text; notesEl.className = kind;
  notesEl.hidden = !text && $('ask').hidden;
  const life = messageLife(text, kind, hold);
  if (text && Number.isFinite(life)) noteTimer = setTimeout(() => { if (!notesEl.matches(':hover')) ctx.message(''); else noteTimer = setTimeout(() => ctx.message(''), 3000); }, life);
};
$('msg-close').onclick = () => { $('msg-close').blur(); ctx.message(''); };
// ------------------------------------------------------------------------------------------- cook state
// What is cooking for each graph (the server's {cook} events, and /api/graphs), shown in the status bar and above the
// Controls: the node, the time (counted on here between events), how the last cook ended. Stop stops it. While the
// before/after of a package update runs (packages.js), the lines show its progress and Stop stops it.
const cooks = new Map(), cookLines = [$('status-cook'), $('controls-cook')];
let cookTick = 0;
ctx.cookState = (graph) => cooks.get(graph)?.state ?? null;
function setCook(graph, state) { cooks.set(graph, { state, at: performance.now() }); renderCook(); }
function renderCook() {
  const c = cooks.get(ctx.graph?.name), compare = ctx.packages?.running;
  const pe = ctx.output?.previewError, preview = pe && pe.at === `${ctx.graph?.name}/${ctx.graph?.node ?? ''}` ? pe.message : null;
  const line = compare ? compareLine(compare, performance.now() - compare.at) : cookLine(c?.state, c ? performance.now() - c.at : 0, preview);
  for (const el of cookLines) {
    el.className = `cookline ${line.kind}`;
    const t = el.querySelector('.ctext');
    if (t.textContent !== line.text) t.textContent = line.text;
    el.title = line.title;
  }
  $('props').classList.toggle('cooking', line.kind === 'running' || line.kind === 'stopping');
  ctx.packages?.renderLine();
  const running = isRunning(c?.state) || !!compare;
  if (running && !cookTick) cookTick = setInterval(renderCook, 200);
  else if (!running && cookTick) { clearInterval(cookTick); cookTick = 0; }
}
ctx.renderCook = renderCook;
// one Stop, in the status bar
$('status-cook').querySelector('.cstop').onclick = async (e) => {
  e.currentTarget.blur();
  // the cooks of an update's comparison are not the graph's: they stop on their own
  if (ctx.packages?.running) { ctx.packages.stop(); return; }
  const graph = ctx.graph.name;
  if (!graph) return;
  // at once: the server hears the stop only when the node it is on lets it (see the line's title)
  const c = cooks.get(graph);
  if (c?.state?.running) { c.state = { ...c.state, running: { ...c.state.running, stopping: true } }; renderCook(); }
  const j = await api.stop(graph);
  if (!j.ok) ctx.message(j.error, 'err');
  else ctx.message(j.stopping ? 'stopping: the cook ends when the node it is on has finished' : 'nothing is cooking');
};

/** A small question with the messages; resolves to the answer. */
ctx.ask = (text, yes = 'Yes', no = 'No') => new Promise((resolve) => {
  ctx.message('');
  $('ask-text').textContent = text; $('ask-yes').textContent = yes; $('ask-no').textContent = no;
  $('ask').hidden = false; notesEl.hidden = false;
  const done = (v) => { $('ask').hidden = true; notesEl.hidden = !msgEl.textContent; $('ask-yes').onclick = $('ask-no').onclick = null; resolve(v); };
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
  if (!ctx.isolated) b.union(ctx.layers.bounds({ pictures }));
  if (guides && !ctx.isolated) for (const m of ctx.guides.list) if (!ctx.guides.hidden.has(m.id)) b.union(ctx.guides.bounds(m));
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
// pieces: a mesh's connected parts, a curve's or an area's CVs (guides.js)
ctx.selection = createSelection((obj) => (obj.startsWith('guide:') ? ctx.guides.pieceCount(obj.slice(6)) : ctx.objects.get(obj)?.mesh?.pieceCount() ?? 0));
ctx.undo = createUndo();
/** The hover (an id, or null); true when it changed. */
ctx.setHover = (id) => { if (ctx.hover === id) return false; ctx.hover = id; ctx.emit('hover'); return true; };

// the output: the node being shown, its display mode and visibility remembered
ctx.output = {
  mesh: null, summary: '', error: null, report: null, loading: false,
  /** {at: "graph/node", message: "preview failed: …"} when that node's result cooked but could not be shown */
  previewError: null,
  visible: local.get('output.visible', true), display: local.get('output.display', 'view'),
  setVisible(v) { this.visible = v; local.set('output.visible', v); outEntry(); ctx.emit('output'); ctx.requestRender(); },
  setDisplay(m) { this.display = m; local.set('output.display', m); outEntry(); ctx.emit('output'); ctx.requestRender(); },
};
const outEntry = () => {
  const o = ctx.output;
  ctx.objects.set('out', { id: 'out', kind: 'output', label: 'output', mesh: o.mesh, visible: o.visible, display: o.display, pickable: true, surface: true });
};
outEntry();
/**
 * What a result is ("out", or a piece "out#k"), for its hover name and its properties: the published output it is
 * (an output alone in the view, or the one whose node the scene shows), its graph and node, and of a piece its own
 * name and materials. {output, graph, node, piece, part, materials}.
 */
ctx.resultInfo = (id) => {
  const { piece } = parseId(id), mesh = ctx.output.mesh, alone = ctx.outputs?.active;
  let graph = ctx.graph.name, node = ctx.graph.shownNode(), output = null;
  if (alone) { graph = alone.graph ?? null; node = alone.node ?? null; output = alone.label ?? null; }
  else output = ctx.outputs?.list().find((v) => v.origin === 'published' && v.graph === graph && v.node === node)?.label ?? null;
  return { output, graph, node, piece, part: piece === null ? null : mesh?.pieceName(piece) ?? null, materials: mesh?.materials(piece) ?? [] };
};

ctx.layers = createLayers(ctx);
ctx.guides = createGuides(ctx);
ctx.select = createSelect(ctx);
ctx.surfacePoint = ctx.select.surfacePoint;
ctx.planePoint = ctx.select.planePoint;
const outliner = createOutliner(ctx, { scene: $('tree'), inputs: $('inputs-list') });
ctx.setTabShown = outliner.setTabShown;
ctx.showTab = (name) => outliner.showTab(name);
const props = createProps(ctx);

// ------------------------------------------------------------------------------------------- graphs and the output
ctx.graph = {
  /** the graphs as last read (/api/graphs), and when that read was asked for: values the page sent later stand */
  list: [], fetched: -1e9, name: null, node: null,
  current() { return this.list.find((g) => g.name === this.name) ?? null; },
  /** the Controls for the graph shown, from the list as last read (never as if it had just been read) */
  renderControls() { props.controls.render(this.current(), this.fetched); },
  /** the node whose result is shown: the chosen one, else the graph's output */
  shownNode() { const g = this.current(); return this.node ?? g?.output ?? null; },
  show(node) {
    if (ctx.outputs?.active) ctx.outputs.scene();
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
  G.list = list; G.fetched = issued;
  const names = list.map((g) => g.name);
  const sel = $('graph');
  // the options are rebuilt only when the graphs change, so an open list stays open
  if (names.join('\n') !== [...sel.options].map((o) => o.value).join('\n')) sel.replaceChildren(...names.map((n) => new Option(n, n)));
  if (!names.includes(G.name)) { G.name = local.get('graph', null); if (!names.includes(G.name)) G.name = defaultGraph(ctx.package, names); G.node = null; }
  sel.value = G.name ?? '';
  const g = G.current();
  if (G.node && !g?.nodes.some((n) => n.name === G.node)) G.node = null;
  // the cook states the list carries, unless an event brought a newer one while it was fetched
  for (const x of list) if (x.cook && !((cooks.get(x.name)?.at ?? -1) > issued)) cooks.set(x.name, { state: x.cook, at: performance.now() });
  renderCook();
  props.controls.render(g, issued);
  renderPackageNotice();
  ctx.emit('graphs');
});
// the package shown: the tab's title, the graph shown first, the welcome while there is no graph
ctx.package = null;
function renderPackageNotice() {
  const hasGraphs = ctx.graph.list.length > 0;
  renderWelcome($('welcome'), ctx.package, !hasGraphs);
  const note = $('unread-note'), text = hasGraphs ? unreadMessage(ctx.package?.unread, ctx.graph.list.map((g) => g.name)) : '';
  if (note.textContent !== text) note.textContent = note.title = text;
  note.hidden = !text;
}
const refreshPackage = ctx.coalesce(async () => {
  const info = await api.package();
  if (!info) return;
  ctx.package = info;
  document.title = pageTitle(info);
  renderPackageNotice();
});
$('graph').onchange = (e) => {
  if (ctx.outputs?.active) ctx.outputs.scene();
  ctx.graph.name = e.target.value; ctx.graph.node = null;
  local.set('graph', ctx.graph.name);
  ctx.graph.renderControls();
  renderCook();
  ctx.emit('graphs');
  loadGeo();
};

// the heightfield layer the scene's output shows in red (the picker in Properties), per graph and node
const sceneLayers = local.get('scene.layers', {});
const sceneKey = () => `${ctx.graph.name}/${ctx.graph.shownNode() ?? ''}`;
ctx.sceneLayer = {
  get: () => sceneLayers[sceneKey()] ?? null,
  set(v) { sceneLayers[sceneKey()] = v; local.set('scene.layers', sceneLayers); loadGeo(); },
};
// how finely heightfields are drawn (the "terrain detail" picker in Properties): "preview", "1024", "2048" or "full";
// one setting, remembered in this browser
ctx.terrainDetail = {
  get: () => browser.get('terrain.detail', 'preview'),
  set(v, reload = true) { browser.set('terrain.detail', v); if (reload) loadGeo(); },
};

let firstFrame = !views.placed;
const loadGeo = ctx.coalesce(async () => {
  if (ctx.outputs?.active) { await ctx.outputs.refresh(); return; }
  const G = ctx.graph, o = ctx.output;
  if (!G.name) return;
  const graph = G.name, node = G.node ?? '';
  o.loading = true; ctx.emit('output');
  const r = await api.geo(graph, node, ctx.sceneLayer.get(), ctx.terrainDetail.get());
  o.loading = false;
  if (graph !== G.name || node !== (G.node ?? '') || ctx.outputs?.active) { ctx.emit('output'); return; }
  // the result cooked but cannot be shown (its GLB was not written, or does not load here): the cook line says so and
  // the view keeps the last result it showed
  const previewFailed = (e) => {
    const msg = String(e?.message ?? e);
    o.previewError = { at: `${graph}/${node}`, message: msg.startsWith('preview failed') ? msg : `preview failed: ${msg}` };
    if (e?.stack) console.error(e);
    ctx.emit('output'); updateCook(); renderCook();
  };
  if (!r.ok) {
    // the last good geometry stays; a stopped cook is no error (the cook line says where it stopped)
    if (r.preview) return previewFailed(r.error);
    if (!r.stopped) o.error = r.error;
    ctx.emit('output'); updateCook();
    return;
  }
  let src, mesh;
  try { src = await parseGLB(r.buf); } catch (e) { return previewFailed(e); }
  if (graph !== G.name || node !== (G.node ?? '') || ctx.outputs?.active) { new MeshObject('', src).dispose(); return; }
  try { mesh = new MeshObject('out', src); } catch (e) { return previewFailed(e); }
  const prev = o.mesh;
  o.mesh = mesh;
  o.mesh.onReady = () => { ctx.requestRender(); ctx.emit('output'); };
  o.error = null;
  if (o.previewError) { o.previewError = null; renderCook(); }
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
  o.about = info?.about ?? null;
  o.report = report;
  ctx.emit('output'); updateCook();
});

/** The status bar's right side: what the view shows, its kind and size (a terrain says its samples, not "0 points"). */
function updateCook() {
  const el = $('cook'), o = ctx.output, g = ctx.graph.current(), shown = ctx.outputs?.active;
  if (shown) {
    // an output alone in the view (or a place of an update): its name and what it is
    const what = shown.view === 'image' && shown.width ? `${shown.width} × ${shown.height} px · ${shown.layers?.length ?? 1} layer${(shown.layers?.length ?? 1) === 1 ? '' : 's'}` : kindLine(shown);
    el.textContent = [shown.graph && shown.graph !== shown.label ? `${shown.graph} › ${shown.label}` : shown.label, what].filter(Boolean).join(' · ');
    el.title = el.textContent;
    return;
  }
  if (!g) { el.textContent = ''; return; }
  const parts = [`${g.name}/${ctx.graph.shownNode() ?? ''}`];
  if (o.about) parts.push(kindLine({ kind: o.about.published ?? 'empty', about: o.about.text }));
  // a failed cook of the graph is told by the cook line beside this (its node and message); this tells the rest
  const told = cookLine(ctx.cookState(g.name)).kind === 'failed';
  const err = o.error ?? (told ? null : (o.report?.errors?.length ? o.report.errors[0] : null) ?? g.nodes.find((n) => n.error)?.error);
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
ctx.requestOverlays = requestOverlays;
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
    for (const e of entries) { e.mesh.root.visible = e.id === 'out' && ctx.isolated ? !ctx.previewEmpty : !!e.visible; e.mesh.setMode(modeOf(e.display ?? 'view', s.shading)); }
    ctx.layersRoot.visible = ctx.guidesRoot.visible = !ctx.isolated;
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
  // the name of the result under the cursor, beside it (only in the view the cursor is in)
  const spot = ctx.select.hoverSpot, hoverName = spot && PT.targetKind(ctx.hover) === 'result' ? resultName(ctx.resultInfo(ctx.hover)) : '';
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
    if (hoverName && spot.slot === i) {
      let e = ov.labels.querySelector('[data-k="hover"]');
      if (!e) { e = document.createElement('div'); e.dataset.k = 'hover'; e.className = 'lbl hover'; ov.labels.append(e); }
      seen.add('hover');
      if (e.textContent !== hoverName) e.textContent = hoverName;
      e.style.left = `${spot.x - s.rect.x + 6}px`; e.style.top = `${spot.y - s.rect.y + 14}px`;
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
$('view-cam').replaceChildren(...CAMERA_NAMES.map((n) => new Option(viewName(n), n)));
$('view-cam').onchange = (e) => { views.setCam(views.active, e.target.value); saveViews(); e.target.blur(); syncTop(); ctx.requestRender(); };
$('view-shading').replaceChildren(...SHADINGS.map(([v, t]) => new Option(t, v)));
$('view-shading').onchange = (e) => { views.slots[views.active].shading = e.target.value; saveViews(); e.target.blur(); ctx.requestRender(); };
$('quad').onclick = () => { toggleQuad(); $('quad').blur(); };
// the edge check: an overlay, off until the person turns it on (remembered in this browser)
MeshObject.edgeCheck = browser.get('edgeCheck', false);
const syncEdgeCheck = () => { $('edge-check').classList.toggle('on', MeshObject.edgeCheck); $('edge-check').setAttribute('aria-pressed', String(MeshObject.edgeCheck)); };
$('edge-check').onclick = () => {
  $('edge-check').blur();
  MeshObject.edgeCheck = !MeshObject.edgeCheck; browser.set('edgeCheck', MeshObject.edgeCheck); syncEdgeCheck();
  for (const e of ctx.objects.values()) if (e.mesh) e.mesh.mode = null;
  ctx.emit('output'); ctx.requestRender();
};
syncEdgeCheck();
$('help').onclick = () => { KM.toggleOverlay(document.body, preset); $('help').blur(); };
function syncTop() {
  const s = views.slots[views.active];
  $('view-cam').value = s.cam;
  $('view-shading').value = s.shading;
  $('quad').classList.toggle('on', views.quad);
  $('quad').textContent = views.quad ? 'single' : 'quad';
  const mode = ctx.guides.mode;
  $('mode').textContent = mode ? `placing ${EDITOR_NAMES[mode]}` : '';
  for (const b of $('guide-tools').querySelectorAll('button')) b.classList.toggle('on', (PLACE_KINDS[b.dataset.tool] ?? null) === mode);
}
for (const b of $('guide-tools').querySelectorAll('button')) b.addEventListener('click', () => {
  // the tools work on the guides, which the scene shows (a result shown alone hides them)
  if (b.dataset.tool === 'selectMode' && ctx.outputs?.active) ctx.outputs.scene();
  run(b.dataset.tool); b.blur();
});
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
      else layout.split = Math.round(Math.max(10, Math.min(85, ((ev.clientY - props0.top - 60) / Math.max(1, props0.height - 52)) * 100)));
      applyLayout(); ctx.requestRender();
    };
    const up = () => { g.classList.remove('drag'); g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); browser.set('layout', layout); };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
  });
}

// ------------------------------------------------------------------------------------------- actions
/** Keys go to a field being typed in (text and number fields, menus), not to the keymap. */
const typing = (t) => t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || !!t?.isContentEditable || !!t?.closest?.('button, summary, [role="button"], [role="menu"]');
const selectedOf = (kind) => ctx.selection.items.filter((id) => ctx.objects.get(parseId(id).obj)?.kind === kind && parseId(id).piece === null);
const hiddenByH = { layers: new Set() };
const DISPLAY_CYCLE = ['shaded', 'wire', 'shadedWire'];
function run(action) {
  if (document.querySelector('dialog[open]') || document.getElementById('image-view')?.hidden === false) return;
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
    case 'placeNull': case 'placeCurve': case 'placeArea': case 'placeVolume':
      // guides are drawn in the scene, not over a result shown alone
      if (ctx.outputs?.active) ctx.outputs.scene();
      ctx.guides.setMode(PLACE_KINDS[action]); return syncTop();
    case 'finish': case 'removeLast': ctx.guides.key(action); return;
    case 'cancel': {
      if (document.querySelector('.keymap-overlay')) return KM.toggleOverlay(document.body, preset);
      // Esc during a drag ends it where it began; during a press that is still a click, it clears as ever
      const d = drag, release = () => { try { canvas.releasePointerCapture(d.id); } catch { /* gone */ } };
      if (d?.kind === 'box') { drag = null; ctx.select.cancel(); release(); return; }
      if (d?.kind === 'guide') { drag = null; ctx.guides.dragEnd(true); release(); return; }
      if (d?.kind === 'press') { drag = null; release(); }
      if (ctx.guides.key('cancel')) return;
      ctx.guides.setMode(null); ctx.selection.clear(); return syncTop();
    }
    case 'delete': {
      const ids = selectedOf('guide').map((id) => id.slice(6));
      // CVs selected on their own, by guide (not those of a guide deleted whole)
      const cvs = new Map();
      for (const id of ctx.selection.items) {
        const { obj, piece } = parseId(id), g = obj.slice(6);
        if (piece !== null && obj.startsWith('guide:') && !ids.includes(g)) cvs.set(g, [...(cvs.get(g) ?? []), piece]);
      }
      const n = ctx.guides.remove(ids), c = cvs.size ? ctx.guides.removeCVs(cvs) : { removed: 0, kept: 0 };
      const done = [n ? `deleted ${n} guide${n === 1 ? '' : 's'}` : '', c.removed ? `removed ${c.removed} CV${c.removed === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
      const kept = c.kept ? `${c.kept} CV${c.kept === 1 ? '' : 's'} kept: a curve needs 2, an area 3` : '';
      if (done) ctx.message(`${done}${kept ? ` · ${kept}` : ''} · ${undoKeys()} brings ${n + c.removed === 1 ? 'it' : 'them'} back`, '', 2000);
      else if (kept) ctx.message(kept, '', 2000);
      else if (ctx.selection.size) ctx.message('Delete removes guides and CVs; the output and reference layers are files and stay (hide them with H)');
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
  if (document.querySelector('dialog[open]')) return;
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
  if (document.querySelector('dialog[open]')) { space.down = false; return; }
  if (e.code === 'Space' || e.key === ' ') {
    const tap = space.down && space.tap && performance.now() - space.t < 400;
    space.down = false;
    if (tap && !typing(e.target)) { const a = KM.matchKey(preset, { key: ' ', code: 'Space' }); if (a) run(a); }
    return;
  }
  if (e.key === 'Alt') e.preventDefault();
});
addEventListener('blur', () => { space.down = false; });

// the mouse in the viewport: a preset's navigation chords first (keymap.js), then the left button by the selection
// model (pointer.js): what is under the press and the modifier held decide what a click and a drag do
let drag = null;
const at = (e) => { const r = viewport.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
/** A camera drag from (x, y) in a slot (tumble, track or dolly) with the preset's pivot rule (section 3). */
function navDrag(nav, slot, x, y, id) {
  const surface = KM.surfacePivot(preset);
  let pivot = null;
  if (surface) pivot = views.anchor(slot, ctx.select.navigationPoint(slot, x, y));
  else { const sel = ctx.select.selectionBounds(); if (!sel.isEmpty()) pivot = sel.getCenter(new THREE.Vector3()); }
  viewport.classList.add('nav');
  // no hover while the camera moves: it is picked again where the drag ends
  ctx.select.hover(-1);
  return { kind: 'nav', nav: surface && nav === 'tumble' && views.cam(slot).ortho ? 'track' : nav, slot, x, y, id, pivot, surface };
}
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
  if (nav) { drag = navDrag(nav, slot, x, y, e.pointerId); return; }
  if (e.button !== 0) return;
  if (ctx.guides.mode) { drag = { kind: 'place', slot, id: e.pointerId }; ctx.guides.pointerDown(slot, x, y); return; }
  // nothing happens until the release (a click) or a few pixels of travel (a drag): pointermove decides which
  const hit = ctx.select.pick(slot, x, y);
  const plan = PT.pressPlan({ target: hit?.kind ?? 'empty', shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, movable: !!hit?.handle });
  drag = { kind: 'press', slot, x, y, id: e.pointerId, hit, plan };
});
canvas.addEventListener('pointermove', (e) => {
  const { x, y } = at(e);
  if (drag && e.pointerId === drag.id) {
    if (drag.kind === 'press') {
      // a press that travels becomes its plan's drag, from where it began
      if (!PT.isDrag(x - drag.x, y - drag.y)) return;
      const { slot, x: x0, y: y0, id, hit, plan } = drag;
      if (plan.drag === 'move') {
        // what you drag is what you have selected (the gizmo builds on this)
        if (PT.dragSelects(ctx.selection.items, hit.id)) ctx.selection.apply([hit.id]);
        drag = { kind: 'guide', slot, id, h: hit.handle };
        ctx.guides.dragStart(slot, x0, y0, hit.handle);
      } else if (plan.drag === 'box') { drag = { kind: 'box', slot, id }; ctx.select.boxStart(slot, x0, y0, plan.box); }
      else drag = navDrag('tumble', slot, x0, y0, id);
    }
    if (drag.kind === 'nav') {
      const dx = x - drag.x, dy = y - drag.y;
      drag.x = x; drag.y = y;
      if (drag.nav === 'tumble') views.tumble(drag.slot, dx, dy, drag.pivot);
      else if (drag.nav === 'track') views.track(drag.slot, dx, dy, drag.surface ? views.cam(drag.slot).pivot : undefined);
      // right or up zooms in, left or down out
      else views.dolly(drag.slot, Math.exp(-(dx - dy) * 0.006));
      ctx.requestRender();
    } else if (drag.kind === 'place') ctx.guides.pointerMove(drag.slot, x, y);
    else if (drag.kind === 'guide') ctx.guides.dragMove(drag.slot, x, y);
    else if (drag.kind === 'box') ctx.select.move(x, y);
    return;
  }
  layoutViews();
  const slot = views.slotAt(x, y);
  cursor.slot = slot; cursor.x = x; cursor.y = y;
  if (slot >= 0 && views.cam(slot).ortho) requestOverlays();
  if (ctx.guides.mode) { if (slot >= 0) ctx.guides.pointerMove(slot, x, y); }
  else {
    ctx.select.hover(slot, x, y);
    // what a press would grab: a point (CV, null, corner) or a whole guide
    const h = slot >= 0 ? ctx.guides.handleAt(slot, x, y) : null;
    canvas.style.cursor = h ? (h.part === 'body' ? 'move' : 'crosshair') : '';
  }
});
const endDrag = (e, cancel = false) => {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  viewport.classList.remove('nav');
  const { x, y } = at(e);
  // what is under the cursor now that the camera has moved
  if (d.kind === 'nav') { saveViews(); if (!cancel) ctx.select.hover(views.slotAt(x, y), x, y); }
  else if (d.kind === 'place') { if (!cancel) ctx.guides.pointerUp(d.slot, x, y); }
  else if (d.kind === 'guide') ctx.guides.dragEnd(cancel);
  else if (d.kind === 'box') { if (cancel) ctx.select.cancel(); else ctx.select.up(x, y); }
  else if (d.kind === 'press' && !cancel) {
    // a press that did not travel is a click: the model says what it does with what was under it
    const c = PT.clickChange(d.plan.click, d.hit?.id);
    if (c) ctx.selection.apply(c.ids, c.op);
  }
};
canvas.addEventListener('dblclick', (e) => {
  if (ctx.guides.mode || drag) return;
  const { x, y } = at(e), slot = views.slotAt(x, y);
  if (slot >= 0) ctx.guides.doubleClick(slot, x, y);
});
canvas.addEventListener('pointerup', (e) => endDrag(e));
canvas.addEventListener('pointercancel', (e) => endDrag(e, true));
canvas.addEventListener('lostpointercapture', (e) => endDrag(e, true));
addEventListener('blur', () => { if (drag) endDrag({ pointerId: drag.id, clientX: 0, clientY: 0 }, true); });
canvas.addEventListener('pointerleave', () => { if (!drag) { cursor.slot = -1; ctx.select.hover(-1); ctx.guides.leave(); requestOverlays(); } });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  layoutViews();
  const { x, y } = at(e), slot = views.slotAt(x, y);
  if (slot < 0) return;
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const factor = Math.exp(Math.max(-1, Math.min(1, dy * 0.0015)));
  if (KM.surfacePivot(preset)) {
    const hit = ctx.select.navigationPoint(slot, x, y); if (hit) views.anchor(slot, hit);
    views.zoomAt(slot, factor, hit ?? views.targetPlanePoint(slot, x, y, views.cam(slot).pivot));
  } else views.dolly(slot, factor, views.targetPlanePoint(slot, x, y));
  clearTimeout(canvas.wheelTimer); canvas.wheelTimer = setTimeout(saveViews, 300);
  ctx.select.hover(slot, x, y);
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

// Each deliverable owns a camera; the scene view keeps its camera and layer visibility.
const outputViews = new Map();
let sceneView = null, previewSerial = 0;
let sceneGraph = null;
ctx.rememberOutputView = (id) => { if (id) outputViews.set(id, views.toJSON()); else if (!ctx.isolated) { sceneView = views.placed ? views.toJSON() : null; sceneGraph = { name: ctx.graph.name, node: ctx.graph.node }; } };
ctx.hideModelPreview = () => { previewSerial++; ctx.previewEmpty = true; ctx.selection.clear(); ctx.requestRender(); };
ctx.outputGraph = (item) => {
  if (item.graph && ctx.graph.list.some((g) => g.name === item.graph)) {
    ctx.graph.name = item.graph; ctx.graph.node = item.node; $('graph').value = item.graph;
    ctx.graph.renderControls();
  }
};
ctx.previewOutput = async (item, bytes, update) => {
  const serial = ++previewSerial, src = await parseGLB(bytes);
  if (serial !== previewSerial || ctx.outputs.active?.id !== item.id) { new MeshObject('', src).dispose(); return; }
  const mesh = new MeshObject('out', src); mesh.onReady = () => ctx.requestRender();
  // an update's overlay: the old version's polygons a sliver behind the new one's (no stripes where they meet)
  if (item.overlay) src.traverse((o) => { for (const m of [o.material ?? []].flat()) if (m.name === 'overlay_a') recede(m); });
  ctx.output.mesh?.dispose(); ctx.output.mesh = mesh; ctx.outputRoot.add(mesh.root); ctx.previewEmpty = false;
  ctx.output.summary = item.summary ?? ''; ctx.output.error = item.error ?? null; ctx.output.about = null;
  ctx.outputGraph(item);
  outEntry(); ctx.selection.clear();
  if (!update || !outputViews.has(item.id)) {
    const saved = outputViews.get(item.id);
    if (saved) views.load(saved);
    else { layoutViews(); views.frame(views.active, mesh.bounds()); }
    outputViews.set(item.id, views.toJSON());
  }
  firstFrame = false; ctx.emit('output'); ctx.requestRender(); syncTop();
};
ctx.restoreScene = () => { previewSerial++; ctx.previewEmpty = false; if (sceneView) views.load(sceneView); else firstFrame = true; if (sceneGraph) { ctx.graph.name = sceneGraph.name; ctx.graph.node = sceneGraph.node; $('graph').value = ctx.graph.name; ctx.graph.renderControls(); } loadGeo(); ctx.requestRender(); };
ctx.frameOutput = frameAll;
/** Show a node of a graph (the Packages tab's "used by"): that graph, the node's result, the Scene tab. */
ctx.showNode = (graph, node) => {
  if (!ctx.graph.list.some((g) => g.name === graph)) return;
  if (ctx.outputs?.active) ctx.outputs.scene();
  if (ctx.graph.name !== graph) { ctx.graph.name = graph; $('graph').value = graph; local.set('graph', graph); ctx.graph.renderControls(); renderCook(); }
  ctx.graph.show(node);
  ctx.showTab('scene');
};
ctx.outputs = createOutputPanel(ctx);
ctx.packages = createPackagesPanel(ctx, $('packages'));

const es = api.events({
  open() {
    // after a reconnect the server may have restarted: fetch everything again
    if (es.opened) {
      if (msgEl.textContent === DISCONNECTED_LINE) ctx.message(RECONNECTED_LINE, 'ok');
      refreshPackage().then(refreshGraphs).then(loadGeo); ctx.outputs.refresh(); ctx.packages.refresh(); ctx.layers.refresh(); ctx.layers.loadWhere(); ctx.guides.load();
    }
    es.opened = true;
  },
  error() { ctx.message(DISCONNECTED_LINE, 'err'); },
  async message(ev) {
    if (ev.cook !== undefined) { setCook(ev.cook.graph, ev.cook); if (ev.cook.graph === ctx.graph.name) updateCook(); return; }
    if (ev.outputs !== undefined) { ctx.outputs.refresh(); return; }
    // the scene's result too: a graph that reads inputs/ (the guides in markers.json) cooks again; one that does not
    // answers from its cache
    if (ev.inputs !== undefined) { ctx.guides.load(); ctx.layers.refresh(); ctx.outputs.refresh(); if (!ctx.isolated) loadGeo(); return; }
    if (ev.compare !== undefined) { await ctx.packages.onCompare(ev.compare); renderCook(); return; }
    if (ev.packages !== undefined) { ctx.packages.onEvent(ev); return; }
    await refreshPackage();
    await refreshGraphs();
    // after a stop the geometry in view stays: fetching it would cook what was just stopped
    if (ev.graph === ctx.graph.name && !ev.stopped) loadGeo();
    ctx.outputs.refresh();
  },
});

syncTop();
outliner.render();
props.render();
ctx.requestRender();
await refreshPackage();
await refreshGraphs();
await ctx.outputs.refresh();
ctx.packages.refresh();
loadGeo();
ctx.layers.refresh();
ctx.layers.loadWhere();
ctx.guides.load();
// for debugging in the browser console: the context, and a frame drawn now (where requestAnimationFrame is paused)
ctx.draw = draw;
window.topotopo = ctx;
