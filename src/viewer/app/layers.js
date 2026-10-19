// Reference layers (docs/design/viewer.md section 7): the person's files in inputs/, one outliner row each, shown
// when their eye is on (remembered in this browser), drawn in a display mode of their own (as the view by default;
// ghost is one of the modes). PNGs stand as unlit image planes at their pixel aspect, one metre tall, beside the
// scene. Files dropped on the page are uploaded to inputs/ (POST /api/inputs).
import { api } from './api.js';
import { MeshObject, parseGLB, isPicture, LAYER_MODES } from './scene.js';
import { fmtBytes } from './units.js';
import * as THREE from 'three';

export const MAX_UPLOAD = 512 * 1024 * 1024; // POST /api/inputs limit (src/viewer/server.ts)
const stampOf = (f) => `${f.mtime}:${f.size}`;
const errText = (e) => String(e?.message ?? e).replace(/^\[f\] /gm, '');
export const layerId = (path) => `layer:${path}`;

export function createLayers(ctx) {
  const memo = ctx.store;
  const L = {
    list: [], where: '', dir: '',
    shown: new Set(memo.get('layers.shown', [])),
    display: new Map(Object.entries(memo.get('layers.display', {}))),
    loaded: new Map(), // path → {stamp, mesh: MeshObject|null}
    info: new Map(), // path → {stamp, summary?, error?, pending?}
    errors: new Map(), // path → {stamp, msg}
    placedX: null, // where the next picture stands
    restored: false,
  };
  const remember = () => { memo.set('layers.shown', [...L.shown]); memo.set('layers.display', Object.fromEntries(L.display)); };
  const changed = () => ctx.emit('layers');

  /** The outliner / properties entry of an input file. */
  const entry = (path) => {
    const f = L.list.find((x) => x.path === path);
    const id = layerId(path);
    const prev = ctx.objects.get(id);
    const e = prev ?? { id, kind: 'layer', path };
    e.file = f;
    e.label = path;
    e.mesh = L.loaded.get(path)?.mesh ?? null;
    e.loading = !!L.loaded.get(path) && !e.mesh;
    e.visible = L.shown.has(path);
    e.display = L.display.get(path) ?? 'view';
    e.pickable = !!e.mesh && path !== 'markers.json';
    e.surface = !!e.mesh && path !== 'markers.json' && !e.mesh.picture;
    ctx.objects.set(id, e);
    return e;
  };

  function drop(path) {
    const l = L.loaded.get(path);
    if (!l) return;
    L.loaded.delete(path);
    if (l.mesh) l.mesh.dispose();
    entry(path);
    ctx.requestRender();
  }
  async function load(path) {
    const f = L.list.find((x) => x.path === path);
    if (!f) return;
    drop(path);
    const slot = { stamp: stampOf(f), mesh: null };
    L.loaded.set(path, slot);
    L.errors.delete(path);
    entry(path); changed();
    const r = await api.input(path);
    let src = null;
    try {
      if (!r.ok) throw new Error(r.error);
      src = await parseGLB(r.buf);
    } catch (e) {
      if (L.loaded.get(path) === slot) {
        L.loaded.delete(path); L.shown.delete(path); remember();
        L.errors.set(path, { stamp: slot.stamp, msg: errText(e) });
      }
      entry(path); changed();
      return;
    }
    if (L.loaded.get(path) !== slot) { new MeshObject('', src).dispose(); return; } // hidden or replaced meanwhile
    const picture = isPicture(src);
    if (picture) placePicture(src);
    src.name = `inputs/${path}`;
    const mesh = new MeshObject(layerId(path), src, { picture });
    mesh.onReady = () => ctx.requestRender();
    slot.mesh = mesh;
    ctx.layersRoot.add(mesh.root);
    entry(path);
    fetchInfo(path);
    changed();
    ctx.requestRender();
  }
  /** One metre tall at its pixel aspect, standing in a row right of the scene, its foot on the scene's floor. */
  function placePicture(src) {
    src.updateMatrixWorld(true);
    const b0 = new THREE.Box3().setFromObject(src);
    const h = Math.max(1e-6, b0.max.y - b0.min.y), s = 1 / h;
    const scene = ctx.sceneBounds({ pictures: false });
    const gap = 0.25;
    if (L.placedX === null) L.placedX = scene.isEmpty() ? 0 : scene.max.x + gap;
    src.scale.setScalar(s);
    src.position.set(L.placedX - b0.min.x * s, (scene.isEmpty() ? 0 : scene.min.y) - b0.min.y * s, scene.isEmpty() ? 0 : (scene.min.z + scene.max.z) / 2);
    src.updateMatrixWorld(true);
    L.placedX += (b0.max.x - b0.min.x) * s + gap;
  }
  async function fetchInfo(path) {
    const f = L.list.find((x) => x.path === path);
    if (!f) return;
    const stamp = stampOf(f), have = L.info.get(path);
    if (have && have.stamp === stamp) return;
    L.info.set(path, { stamp, pending: true });
    const r = await api.inputInfo(path);
    if (r.ok) L.info.set(path, { stamp, summary: r.summary });
    else { L.info.set(path, { stamp, error: errText(r.error) }); L.errors.set(path, { stamp, msg: errText(r.error) }); }
    changed();
  }

  L.fetchInfo = fetchInfo;
  /** Eye on / off: on loads the layer, off frees it. */
  L.show = (path, on) => {
    if (on) { L.shown.add(path); if (!L.loaded.has(path)) load(path); }
    else { L.shown.delete(path); drop(path); }
    remember(); entry(path); changed();
  };
  L.setDisplay = (path, mode) => {
    if (!LAYER_MODES.some(([m]) => m === mode)) return;
    if (mode === 'view') L.display.delete(path); else L.display.set(path, mode);
    remember(); entry(path); changed(); ctx.requestRender();
  };
  L.refresh = ctx.coalesce(async () => {
    const list = await api.inputs();
    if (!list) return;
    L.list = list;
    const byPath = new Map(list.map((f) => [f.path, f]));
    if (!L.restored) { L.restored = true; for (const p of [...L.shown]) if (!byPath.has(p)) L.shown.delete(p); }
    // a replaced file reloads; a removed one goes away
    for (const p of [...L.shown]) {
      const f = byPath.get(p);
      if (!f) { L.shown.delete(p); drop(p); continue; }
      const l = L.loaded.get(p);
      if (!l || l.stamp !== stampOf(f)) load(p);
    }
    for (const [p] of L.loaded) if (!byPath.has(p)) drop(p);
    for (const m of [L.info, L.errors]) for (const [p, v] of m) if (!byPath.has(p) || v.stamp !== stampOf(byPath.get(p))) m.delete(p);
    for (const id of [...ctx.objects.keys()]) if (id.startsWith('layer:') && !byPath.has(id.slice(6))) ctx.objects.delete(id);
    for (const f of list) entry(f.path);
    remember(); changed();
  });
  L.loadWhere = async () => {
    const j = await api.inputsDir();
    if (!j?.where) return;
    L.where = String(j.where); L.dir = String(j.dir ?? '');
    const dw = document.getElementById('drop-where');
    if (dw) dw.textContent = `inputs/ ${L.where}`;
    changed();
  };
  /** Bounds of the shown layers (pictures too unless `pictures` is false). */
  L.bounds = ({ pictures = true } = {}) => {
    const b = new THREE.Box3();
    for (const [, l] of L.loaded) if (l.mesh && l.mesh.root.visible && (pictures || !l.mesh.picture)) b.union(l.mesh.bounds());
    return b;
  };
  L.fileText = (f) => `${f.kind}${f.ext ? ` (.${f.ext})` : ''} · ${fmtBytes(f.size)} · ${new Date(f.mtime).toLocaleString()}`;

  // ------------------------------------------------------------------ drop zone: files go to inputs/
  async function uploadOne(f, tag) {
    if (f.size > MAX_UPLOAD) return { error: `${f.name}: ${fmtBytes(f.size)} is over the ${MAX_UPLOAD / 1024 ** 2} MB limit` };
    const put = async (overwrite) => {
      const t0 = performance.now();
      const tick = () => ctx.message(`uploading ${f.name}${tag} · ${fmtBytes(f.size)} · ${((performance.now() - t0) / 1000).toFixed(0)} s`, 'busy');
      tick();
      const timer = setInterval(tick, 500);
      try { return await api.upload(f, overwrite); } finally { clearInterval(timer); }
    };
    let r = await put(false);
    if (r.status === 409) {
      ctx.message(`${f.name}${tag}: inputs/ already has this file`);
      if (!await ctx.ask(`inputs/${r.j.path ?? f.name} exists — replace it?`, 'Replace', 'Keep')) return { kept: r.j.path ?? f.name };
      r = await put(true);
    }
    if (r.status !== 200 || !r.j.ok) return { error: `${f.name}: ${r.j.error ?? `upload failed (${r.status})`}` };
    return { path: r.j.path };
  }
  let uploads = Promise.resolve();
  L.upload = (files, folders) => {
    uploads = uploads.then(async () => {
      const added = [], kept = [], errors = [];
      if (folders.length) errors.push(`folders are not supported, drop the files inside instead (skipped ${folders.map((f) => f + '/').join(', ')})`);
      for (const [i, f] of files.entries()) {
        const r = await uploadOne(f, files.length > 1 ? ` (${i + 1}/${files.length})` : '');
        if (r.path) {
          added.push(r.path);
          if (/\.(png|jpe?g|webp)$/i.test(r.path)) { await L.refresh(); await ctx.outputs?.openInput(r.path); continue; }
          // show it at once, and select it
          L.shown.add(r.path);
          for (const m of [L.info, L.errors]) m.delete(r.path);
          remember();
          await L.refresh();
          ctx.selection.apply([layerId(r.path)]);
        } else if (r.kept) kept.push(r.kept);
        else if (r.error) errors.push(r.error);
      }
      const msg = [added.length ? `added ${added.map((p) => 'inputs/' + p).join(', ')}${L.where ? ' ' + L.where : ''}` : '', kept.length ? `kept the existing ${kept.map((p) => 'inputs/' + p).join(', ')}` : '', ...errors].filter(Boolean).join(' · ');
      if (msg) ctx.message(msg, errors.length ? 'err' : added.length ? 'ok' : '');
    });
  };
  let depth = 0;
  const fileDrag = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  addEventListener('dragenter', (e) => { if (!fileDrag(e)) return; e.preventDefault(); if (++depth === 1) document.body.classList.add('dropping'); });
  addEventListener('dragover', (e) => { if (!fileDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  addEventListener('dragleave', (e) => { if (!fileDrag(e)) return; if (--depth <= 0) { depth = 0; document.body.classList.remove('dropping'); } });
  addEventListener('drop', (e) => {
    if (!fileDrag(e)) return;
    e.preventDefault();
    depth = 0; document.body.classList.remove('dropping');
    // read the items now: the browser empties the DataTransfer after this event
    const files = [], folders = [];
    for (const it of Array.from(e.dataTransfer.items ?? [])) {
      if (it.kind !== 'file') continue;
      const en = it.webkitGetAsEntry?.();
      if (en?.isDirectory) { folders.push(en.name); continue; }
      const f = it.getAsFile();
      if (f) files.push(f);
    }
    if (!e.dataTransfer.items) files.push(...e.dataTransfer.files);
    L.upload(files, folders);
  });
  return L;
}
