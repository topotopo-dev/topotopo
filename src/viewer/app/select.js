// Picking and selecting in the viewport, for the selection model of pointer.js (main.js decides what a press does):
// what is under the cursor (a guide or one of its CVs within a few pixels, else an input layer the ray meets, else the
// nearest piece of the cooked result), the box a Shift or Ctrl drag pulls, and the hover, a dimmer highlight with the
// name of a result beside the cursor. All positions are viewport pixels.
import * as THREE from 'three';
import { parseId, pieceId } from './selection.js';
import { AXIS_VIEWS } from './camera.js';
import { pickWinner, boxTakes, targetKind } from './pointer.js';

export function createSelect(ctx) {
  const S = { press: null, boxEl: document.getElementById('boxsel'), hoverAt: null, hoverQueued: false };
  const meshEntries = () => [...ctx.objects.values()].filter((e) => e.mesh && (ctx.isolated ? e.id === 'out' && !ctx.previewEmpty : e.visible) && e.mesh.root.visible);

  /**
   * What is under a viewport point in a slot: {id, kind, handle?, point?} or null; `kind` is pointer.js's target
   * kind, `handle` what a drag would move (guides.js handleAt). Things you edit win (pointer.js pickWinner): a guide or
   * a CV within its few pixels, drawn on top of everything, then an input layer the ray meets even behind a result.
   */
  S.pick = (slot, x, y) => {
    const h = ctx.isolated ? null : ctx.guides.handleAt(slot, x, y);
    const guide = h ? { id: ctx.guides.idOf(h), handle: h } : null;
    const near = { layer: null, result: null };
    if (!guide) {
      const rc = ctx.views.ray(slot, x, y), linePx = ctx.views.worldPerPixel(slot) * 5;
      for (const e of meshEntries()) {
        if (e.pickable === false) continue;
        const hit = e.mesh.pick(rc, linePx), k = e.kind === 'layer' ? 'layer' : 'result';
        if (hit && hit.dist < (near[k]?.dist ?? Infinity)) near[k] = { ...hit, entry: e };
      }
    }
    const asHit = (b) => {
      if (!b) return null;
      const n = b.entry.mesh.pieceCount();
      return { id: b.piece === null || n <= 1 ? b.entry.id : pieceId(b.entry.id, b.piece), point: b.point };
    };
    const win = pickWinner(guide, asHit(near.layer), asHit(near.result));
    return win ? { ...win, kind: targetKind(win.id) } : null;
  };

  /** The construction plane of a slot's camera: y = 0 for persp, top and bottom; the view's own axis plane else. */
  const planeOf = (slot) => {
    const c = ctx.views.cam(slot), f = c.name === 'persp' ? [0, -1, 0] : AXIS_VIEWS[c.name].f;
    return new THREE.Plane(new THREE.Vector3(Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2])), 0);
  };
  /**
   * Where a guide lands under a viewport point: the surface of the output or of a reference layer (not pictures,
   * not the markers file), else the slot's construction plane. {point, surface} or null. `layersOnly`: the reference
   * layers alone (a dragged guide must not land on what the graph builds from it).
   */
  S.surfacePoint = (slot, x, y, { layersOnly = false } = {}) => {
    const rc = ctx.views.ray(slot, x, y);
    let best = null;
    for (const e of meshEntries()) {
      if (e.surface === false || e.mesh.bboxMode || (layersOnly && e.kind !== 'layer')) continue;
      const h = e.mesh.pick(rc, 0);
      if (h && h.dist < (best?.dist ?? Infinity)) best = h;
    }
    if (best) return { point: best.point, surface: true };
    const p = rc.ray.intersectPlane(planeOf(slot), new THREE.Vector3());
    return p ? { point: p, surface: false } : null;
  };
  /** Navigation hits actual visible surfaces, never the infinite construction plane or selection bounds. */
  S.navigationPoint = (slot, x, y) => {
    const rc = ctx.views.ray(slot, x, y);
    let best = null;
    for (const e of meshEntries()) {
      if (e.surface === false || e.mesh.picture || e.mesh.bboxMode) continue;
      const h = e.mesh.pick(rc, 0);
      if (h && h.dist < (best?.dist ?? Infinity)) best = h;
    }
    return best?.point?.clone() ?? null;
  };
  /** A viewport point on the horizontal plane at height `level`, through slot's camera. */
  S.planePoint = (slot, x, y, level) => ctx.views.ray(slot, x, y).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -level), new THREE.Vector3());

  // ------------------------------------------------------------------ the box of a Shift or Ctrl drag
  /** A box from (x, y) in a slot, adding ('add') or taking out ('remove') what lies wholly inside it on release. */
  S.boxStart = (slot, x, y, op) => { S.press = { slot, x, y, op }; };
  S.move = (x, y) => {
    const p = S.press;
    if (!p) return;
    const r = ctx.views.slots[p.slot].rect;
    const cx = Math.max(r.x, Math.min(r.x + r.w, x)), cy = Math.max(r.y, Math.min(r.y + r.h, y));
    Object.assign(S.boxEl.style, { left: `${Math.min(p.x, cx)}px`, top: `${Math.min(p.y, cy)}px`, width: `${Math.abs(cx - p.x)}px`, height: `${Math.abs(cy - p.y)}px` });
    S.boxEl.hidden = false;
    p.end = { x: cx, y: cy };
  };
  S.up = (x, y) => {
    const p = S.press;
    S.press = null;
    S.boxEl.hidden = true;
    if (!p) return;
    const e = p.end ?? { x, y };
    S.boxSelect(p.slot, { x0: Math.min(p.x, e.x), y0: Math.min(p.y, e.y), x1: Math.max(p.x, e.x), y1: Math.max(p.y, e.y) }, p.op);
  };
  S.cancel = () => { S.press = null; S.boxEl.hidden = true; };
  /**
   * What lies wholly inside a viewport rect of a slot, added to or taken out of the selection (op 'add' | 'remove'):
   * guides, their CVs and input layers; results only to be taken out (pointer.js boxTakes).
   */
  S.boxSelect = (slot, rect, op = 'add') => {
    const cam = ctx.views.camera(slot);
    const inside = (pts) => pts.every((w) => {
      const q = ctx.views.project(slot, w, cam);
      return q && q.x >= rect.x0 && q.x <= rect.x1 && q.y >= rect.y0 && q.y <= rect.y1;
    });
    const ids = ctx.isolated ? [] : [...ctx.guides.boxSelect(inside)];
    for (const e of meshEntries()) {
      if (e.pickable === false || !boxTakes(op, targetKind(e.id))) continue;
      const ks = e.mesh.boxPieces(inside);
      const n = e.mesh.bboxMode ? 1 : e.mesh.pieceCount();
      if (ks.length && (ks.includes(null) || n <= 1 || ks.length === n)) ids.push(e.id);
      else for (const k of ks) ids.push(pieceId(e.id, k));
    }
    if (ids.length) ctx.selection.apply(ids, op);
  };

  // ------------------------------------------------------------------ hover
  /** Ask for the hover under (x, y) in a slot (picked at most every 16 ms), or clear it (slot -1). */
  S.hover = (slot, x, y) => {
    S.hoverAt = slot < 0 ? null : { slot, x, y };
    if (S.hoverQueued) return;
    S.hoverQueued = true;
    setTimeout(() => {
      S.hoverQueued = false;
      const h = S.hoverAt && !S.press && !ctx.guides.mode ? S.pick(S.hoverAt.slot, S.hoverAt.x, S.hoverAt.y) : null;
      // where the cursor is while it is over a result, for the result's name beside it (main.js drawOverlays)
      const spot = h?.kind === 'result' ? { ...S.hoverAt } : null;
      const moved = JSON.stringify(spot) !== JSON.stringify(S.hoverSpot);
      S.hoverSpot = spot;
      if (!ctx.setHover(h?.id ?? null) && moved) ctx.requestOverlays?.();
    }, 16);
  };

  // ------------------------------------------------------------------ highlights, bounds, pivot
  /** Push the selection and the hover to the objects that draw them. */
  S.highlight = () => {
    for (const e of meshEntries()) {
      const sel = { whole: ctx.selection.has(e.id), pieces: new Set() }, hov = { whole: ctx.hover === e.id, piece: null };
      for (const id of ctx.selection.items) { const { obj, piece } = parseId(id); if (obj === e.id && piece !== null) sel.pieces.add(piece); }
      if (ctx.hover && ctx.hover !== e.id) { const { obj, piece } = parseId(ctx.hover); if (obj === e.id) hov.piece = piece; }
      e.mesh.highlight(sel, hov);
    }
    ctx.guides.draw();
  };
  /** Bounds of one id (an object or a piece), or null when it has no geometry on screen. */
  S.boundsOf = (id) => {
    const { obj, piece } = parseId(id), e = ctx.objects.get(obj);
    if (!e) return null;
    if (e.kind === 'guide') return piece === null ? ctx.guides.bounds(e.marker) : ctx.guides.cvBounds(e.marker, piece);
    if (!e.mesh) return null;
    const b = e.mesh.bounds(piece);
    return b.isEmpty() ? null : b;
  };
  S.selectionBounds = () => {
    const b = new THREE.Box3();
    for (const id of ctx.selection.items) { const x = S.boundsOf(id); if (x) b.union(x); }
    return b;
  };
  return S;
}
