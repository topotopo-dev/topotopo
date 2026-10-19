// Picking and selecting in the viewport (docs/design/viewer.md section 5): click selects what is under the cursor
// (a guide, else the nearest piece of the output or of a reference layer), Shift adds, Ctrl removes, a drag pulls a
// box that selects what lies wholly inside it, a click on nothing clears. Hover draws a dimmer highlight. All
// positions are viewport pixels.
import * as THREE from 'three';
import { opOf, parseId, pieceId } from './selection.js';
import { AXIS_VIEWS } from './camera.js';

const DRAG_PX = 4;

export function createSelect(ctx) {
  const S = { press: null, boxEl: document.getElementById('boxsel'), hoverAt: null, hoverQueued: false };
  const meshEntries = () => [...ctx.objects.values()].filter((e) => e.mesh && (ctx.isolated ? e.id === 'out' && !ctx.previewEmpty : e.visible) && e.mesh.root.visible);

  /** What is under a viewport point in a slot: {id, point?} or null. Guides first (they draw on top). */
  S.pick = (slot, x, y) => {
    const g = ctx.isolated ? null : ctx.guides.pick(slot, x, y);
    if (g) return { id: g.id };
    const rc = ctx.views.ray(slot, x, y);
    const linePx = ctx.views.worldPerPixel(slot) * 5;
    let best = null;
    for (const e of meshEntries()) {
      if (e.pickable === false) continue;
      const h = e.mesh.pick(rc, linePx);
      if (h && h.dist < (best?.dist ?? Infinity)) best = { ...h, entry: e };
    }
    if (!best) return null;
    const n = best.entry.mesh.pieceCount();
    return { id: best.piece === null || n <= 1 ? best.entry.id : pieceId(best.entry.id, best.piece), point: best.point };
  };

  /** The construction plane of a slot's camera: y = 0 for persp, top and bottom; the view's own axis plane else. */
  const planeOf = (slot) => {
    const c = ctx.views.cam(slot), f = c.name === 'persp' ? [0, -1, 0] : AXIS_VIEWS[c.name].f;
    return new THREE.Plane(new THREE.Vector3(Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2])), 0);
  };
  /**
   * Where a guide lands under a viewport point: the surface of the output or of a reference layer (not pictures,
   * not the markers file), else the slot's construction plane. {point, surface} or null.
   */
  S.surfacePoint = (slot, x, y) => {
    const rc = ctx.views.ray(slot, x, y);
    let best = null;
    for (const e of meshEntries()) {
      if (e.surface === false || e.mesh.bboxMode) continue;
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

  // ------------------------------------------------------------------ click, box
  S.down = (slot, x, y, e) => { S.press = { slot, x, y, op: opOf(e), box: false }; };
  S.move = (x, y) => {
    const p = S.press;
    if (!p) return;
    // as Maya's select tool: a left drag pulls a box wherever it starts (nothing moves by dragging in phase 1)
    if (!p.box && Math.hypot(x - p.x, y - p.y) > DRAG_PX) p.box = true;
    if (p.box) {
      const r = ctx.views.slots[p.slot].rect;
      const cx = Math.max(r.x, Math.min(r.x + r.w, x)), cy = Math.max(r.y, Math.min(r.y + r.h, y));
      Object.assign(S.boxEl.style, { left: `${Math.min(p.x, cx)}px`, top: `${Math.min(p.y, cy)}px`, width: `${Math.abs(cx - p.x)}px`, height: `${Math.abs(cy - p.y)}px` });
      S.boxEl.hidden = false;
      p.end = { x: cx, y: cy };
    }
  };
  S.up = (x, y) => {
    const p = S.press;
    S.press = null;
    S.boxEl.hidden = true;
    if (!p) return;
    if (p.box) {
      const e = p.end ?? { x, y };
      return S.boxSelect(p.slot, { x0: Math.min(p.x, e.x), y0: Math.min(p.y, e.y), x1: Math.max(p.x, e.x), y1: Math.max(p.y, e.y) }, p.op);
    }
    const hit = S.pick(p.slot, x, y);
    if (hit) ctx.selection.apply([hit.id], p.op);
    else if (p.op === 'replace') ctx.selection.clear();
  };
  S.cancel = () => { S.press = null; S.boxEl.hidden = true; };
  /** Everything wholly inside a viewport rect of a slot. */
  S.boxSelect = (slot, rect, op = 'replace') => {
    const cam = ctx.views.camera(slot);
    const inside = (pts) => pts.every((w) => {
      const q = ctx.views.project(slot, w, cam);
      return q && q.x >= rect.x0 && q.x <= rect.x1 && q.y >= rect.y0 && q.y <= rect.y1;
    });
    const ids = [...ctx.guides.boxSelect(inside)];
    for (const e of meshEntries()) {
      if (e.pickable === false) continue;
      const ks = e.mesh.boxPieces(inside);
      const n = e.mesh.bboxMode ? 1 : e.mesh.pieceCount();
      if (ks.length && (ks.includes(null) || n <= 1 || ks.length === n)) ids.push(e.id);
      else for (const k of ks) ids.push(pieceId(e.id, k));
    }
    if (ids.length || op === 'replace') ctx.selection.apply(ids, op);
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
      ctx.setHover(h?.id ?? null);
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
    if (e.kind === 'guide') return ctx.guides.bounds(e.marker);
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
