// Guides: nulls, curves, areas and volumes, the markers agents read as
// inputs/markers.json (roles site, path, zone, volume). Drawn as the standard objects they are, in one desaturated
// cyan, on top of the scene: a null is an axis cross (its radius circle only while hovered or selected), a curve a
// polyline with CV squares and a direction tick, an area a closed curve with a light diagonal hatch, a volume a wire
// box (its size printed on an edge while selected). Placement modes add them; every change saves the whole list
// (POST /api/markers) and is one undo step. Saving never moves the camera or reloads the output. The CVs of a curve
// or an area are selectable on their own: "guide:<id>#<k>" (selection.js piece ids), drawn as orange squares.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { api } from './api.js';
import * as M from './markers.js';
import { COLORS, fatSegments, lineMaterial, disposeTree } from './scene.js';
import { fmtLen } from './units.js';
import { AXIS_VIEWS } from './camera.js';
import { parseId, pieceId } from './selection.js';
import { isDoubleClick, isDrag } from './pointer.js';
import { transformTargets, transformLabel, moveDelta, moveText, ringFromFace, ringTurn, unwrapTurn, tangentTurn, rotateText, scaleFactor, scaleText } from './transform.js';

export const guideId = (id) => `guide:${id}`;
/** Whether a guide's CVs are selected one by one (curves and areas); a null and a volume select whole. */
export const hasCVs = (m) => m.kind === 'path' || m.kind === 'zone';
export const PLACE_KINDS = { placeNull: 'site', placeCurve: 'path', placeArea: 'zone', placeVolume: 'volume' };
const V3 = (p) => new THREE.Vector3(p[0], p[1], p[2]);
const CROSS_PX = 11, CV_PX = 6, TICK_PX = 12, PICK_PX = 7;
const STYLE = {
  normal: { color: COLORS.guide, width: 1.5, opacity: 1 },
  hover: { color: COLORS.sel, width: 1.5, opacity: 0.6 },
  sel: { color: COLORS.sel, width: 2.2, opacity: 1 },
  draft: { color: COLORS.sel, width: 1.5, opacity: 0.9 },
};

// ------------------------------------------------------------------------------------------------- drawing
function fatLine(points, st, closed = false) {
  const g = new LineGeometry();
  const P = closed ? [...points, points[0]] : points;
  g.setPositions(P.flatMap((p) => [p.x, p.y, p.z]));
  const l = new Line2(g, lineMaterial({ color: st.color, linewidth: st.width, opacity: st.opacity, depthTest: false, depthWrite: false }));
  l.renderOrder = 20;
  l.frustumCulled = false;
  return l;
}
function pairs(list, st) {
  const pos = new Float32Array(list.length * 6);
  list.forEach(([a, b], i) => pos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6));
  const l = fatSegments(pos, { color: st.color, width: st.width, opacity: st.opacity, depthTest: false });
  l.renderOrder = 20;
  return l;
}
/** CVs: squares a fixed number of pixels wide, outlined dark. */
function squares(points, color, px = CV_PX) {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const mk = (c, s, o) => { const p = new THREE.Points(g, new THREE.PointsMaterial({ color: c, size: s, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true })); p.renderOrder = o; p.frustumCulled = false; return p; };
  const grp = new THREE.Group();
  grp.add(mk('#16181b', px + 2, 21), mk(color, px, 22));
  return grp;
}
/** An object kept `px` pixels per world unit in every view (main.js gives the metres per pixel of the view drawn). */
function screenSized(obj, at, px, wpp) {
  obj.position.copy(at);
  obj.onBeforeRender = (r, s, camera) => { obj.scale.setScalar(wpp(camera, obj.position) * px); obj.updateMatrixWorld(); };
  return obj;
}
function boxEdges(m) {
  const corners = M.boxPoints(m).map(V3), out = [];
  for (let ax = 0; ax < 3; ax++) for (let s = 0; s < 4; s++) {
    const a = [0, 0, 0], u = (ax + 1) % 3, v = (ax + 2) % 3;
    a[u] = s & 1; a[v] = s >> 1;
    const b = a.slice(); b[ax] = 1;
    out.push([a, b].map(([i, j, k]) => corners[4 * i + 2 * j + k]));
  }
  return out;
}
const circle = (c, r, n = 72) => Array.from({ length: n }, (_, k) => { const a = (k / n) * Math.PI * 2; return new THREE.Vector3(c.x + Math.cos(a) * r, c.y, c.z + Math.sin(a) * r); });
/** A round hatch spacing for an area: about 14 lines across its larger side. */
function hatchSpacing(pts) {
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[2]);
  const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), 1e-3);
  const raw = ext / 14, e = 10 ** Math.floor(Math.log10(raw)), m = raw / e;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e;
}

/** The objects of one guide in one state ('normal' | 'hover' | 'sel'); `cvs` are the CVs selected on their own. */
function guideObject(m, state, wpp, cvs = []) {
  const st = STYLE[state], g = new THREE.Group(), P = m.points.map(V3);
  g.name = `guide ${m.name}`;
  if (m.kind === 'site') {
    const c = P[0];
    const cross = pairs([[new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)], [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0)], [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 2)]], st);
    cross.quaternion.set(...M.quatOfRotate(M.rotateOf(m)));
    g.add(screenSized(cross, c, CROSS_PX, wpp));
    if (state !== 'normal') g.add(fatLine(circle(c, m.radius ?? M.DEFAULT_RADIUS), { ...st, width: 1 }, true));
  } else if (m.kind === 'volume') {
    g.add(pairs(boxEdges(m), st));
  } else {
    const zone = m.kind === 'zone';
    g.add(fatLine(P, st, zone));
    if (zone) {
      const segs = M.hatchSegments(m.points, hatchSpacing(m.points));
      if (segs.length) {
        const pos = new Float32Array(segs.length * 6);
        segs.forEach(([a, b], i) => pos.set([...a, ...b], i * 6));
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const h = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: st.color, transparent: true, opacity: 0.45 * st.opacity, depthTest: false, depthWrite: false }));
        h.renderOrder = 19;
        h.frustumCulled = false;
        g.add(h);
      }
    } else if (P.length >= 2) {
      // the direction tick: a chevron halfway along the last segment, pointing to the end
      const a = P[P.length - 2], b = P[P.length - 1], d = b.clone().sub(a);
      if (d.lengthSq() > 0) {
        d.normalize();
        const axis = Math.abs(d.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const back = d.clone().negate();
        const arms = [0.55, -0.55].map((t) => back.clone().applyAxisAngle(axis, t));
        const tick = pairs(arms.map((v) => [new THREE.Vector3(), v]), st);
        g.add(screenSized(tick, a.clone().lerp(b, 0.5), TICK_PX, wpp));
      }
    }
    g.add(squares(P, st.color, zone ? CV_PX - 1 : CV_PX));
    const picked = cvs.filter((k) => k < P.length).map((k) => P[k]);
    if (picked.length) g.add(squares(picked, COLORS.sel, CV_PX + 2));
  }
  return g;
}

// ---------------------------------------------------------------------------------------------- the guides
export function createGuides(ctx) {
  const G = {
    list: [], saved: null, mode: null, draft: null, cursor: null, down: null,
    hidden: new Set(ctx.store.get('guides.hidden', [])),
    defaults: { radius: M.DEFAULT_RADIUS, height: M.DEFAULT_HEIGHT },
    drawn: new Map(), draftRoot: new THREE.Group(),
  };
  ctx.guidesRoot.add(G.draftRoot);
  const byId = (id) => G.list.find((m) => m.id === id) ?? null;
  G.byId = byId;
  /** Whether a selection id still names something: not a guide, or a guide there is (and of it a CV it has). */
  const alive = (id) => {
    if (!id.startsWith('guide:')) return true;
    const { obj, piece } = parseId(id), m = byId(obj.slice(6));
    return !!m && (piece === null || (hasCVs(m) && piece < m.points.length));
  };
  /** CVs renumber when one is added or removed: those of the guide leave the selection, the guide stays. */
  const dropCVs = (id) => ctx.selection.prune((x) => { const { obj, piece } = parseId(x); return piece === null || obj !== guideId(id); });
  const rememberHidden = () => ctx.store.set('guides.hidden', [...G.hidden]);
  const entries = () => {
    for (const id of [...ctx.objects.keys()]) if (id.startsWith('guide:') && !byId(id.slice(6))) ctx.objects.delete(id);
    for (const m of G.list) {
      const id = guideId(m.id), e = ctx.objects.get(id) ?? { id, kind: 'guide' };
      e.marker = m; e.label = m.name; e.visible = !G.hidden.has(m.id);
      ctx.objects.set(id, e);
    }
  };

  /** The CVs of a guide selected on their own (piece ids of its selection id). */
  const selectedCVs = (id) => ctx.selection.items.map(parseId).filter((p) => p.obj === id && p.piece !== null).map((p) => p.piece);
  /** Redraw the guides whose marker or state changed (state from the selection and the hover). */
  G.draw = () => {
    const seen = new Set();
    const hovered = ctx.hover ? parseId(ctx.hover).obj : null;
    for (const m of G.list) {
      const id = guideId(m.id), visible = !G.hidden.has(m.id);
      const state = ctx.selection.has(id) ? 'sel' : hovered === id ? 'hover' : 'normal';
      const cvs = state === 'sel' ? [] : selectedCVs(id);
      const sig = JSON.stringify([m.kind, m.points, m.rotate, m.radius, m.height, state, cvs]);
      seen.add(m.id);
      let d = G.drawn.get(m.id);
      if (!d || d.sig !== sig) {
        if (d) { ctx.guidesRoot.remove(d.obj); disposeTree(d.obj); }
        d = { sig, obj: guideObject(m, state, ctx.pxWorld, cvs) };
        G.drawn.set(m.id, d);
        ctx.guidesRoot.add(d.obj);
      }
      d.obj.visible = visible;
    }
    for (const [id, d] of G.drawn) if (!seen.has(id)) { ctx.guidesRoot.remove(d.obj); disposeTree(d.obj); G.drawn.delete(id); }
    ctx.requestRender();
  };
  /** The draft being placed: curve or area CVs with the rubber band to the cursor, or the volume's live box. */
  G.drawDraft = () => {
    for (const o of [...G.draftRoot.children]) { G.draftRoot.remove(o); disposeTree(o); }
    const d = G.draft;
    if (d?.kind === 'volume') {
      const m = { points: [[d.a.x, d.y, d.a.z], [d.b.x, d.y, d.b.z]], height: G.defaults.height };
      const { lo, hi } = M.boxOf(m);
      if (hi[0] > lo[0] && hi[2] > lo[2]) G.draftRoot.add(pairs(boxEdges(m), STYLE.draft));
    } else if (d?.points?.length) {
      const P = d.points.map(V3), live = G.cursor ? [...P, G.cursor] : P;
      if (live.length >= 2) G.draftRoot.add(fatLine(live, STYLE.draft));
      if (d.kind === 'zone' && live.length >= 3) G.draftRoot.add(fatLine([live[live.length - 1], live[0]], { ...STYLE.draft, opacity: 0.4, width: 1 }));
      G.draftRoot.add(squares(P, COLORS.sel));
    }
    ctx.requestRender();
  };

  // ------------------------------------------------------------------ saving: the whole list, the latest wins
  let saving = false, added = null;
  const save = ctx.coalesce(async () => {
    const body = M.markersBody(G.gizmoDrag?.start ?? G.list);
    if (body === G.saved) return;
    const announce = !added;
    saving = true;
    const r = await api.saveMarkers(body).finally(() => { saving = false; });
    if (r.ok) {
      G.saved = body;
      if (announce && !G.mode && M.markersBody(G.list) === body) {
        const file = `inputs/markers.json${ctx.layers.where ? ' ' + ctx.layers.where : ''}`;
        ctx.message(r.count ? `${r.count} guide${r.count === 1 ? '' : 's'} saved to ${file} (${r.points} points, ${r.prims} prims)` : `no guides: ${file} removed`, 'ok');
      }
    } else ctx.message(`guides not saved — ${r.error}`, 'err');
    ctx.emit('guides');
  });
  G.saving = () => saving || (G.saved === null ? G.list.length > 0 : M.markersBody(G.list) !== G.saved);
  const canLoad = () => M.shouldReloadGuides(G.saving(), !!(G.draft || G.down || G.dragging || G.gizmoDrag));
  const setList = (list) => {
    G.gizmoEnd(true);
    // A placement already has its own confirmation, even if its save waits behind another edit.
    if (list.at(-1) !== added) added = null;
    G.list = M.cloneMarkers(list);
    entries();
    ctx.selection.prune(alive);
    G.draw(); save(); ctx.emit('guides');
  };
  /** One undoable change of the list: `edit(list)` changes a copy in place. */
  G.change = (label, edit, key) => {
    G.gizmoEnd(true);
    const before = M.cloneMarkers(G.list), next = M.cloneMarkers(G.list);
    if (edit(next) === false) return false;
    setList(next);
    const after = M.cloneMarkers(G.list);
    ctx.undo.push({ label, key, undo: () => setList(before), redo: () => setList(after) });
    return true;
  };
  G.load = ctx.coalesce(async () => {
    if (!canLoad()) return;
    const list = G.list;
    const j = await api.markers();
    if (G.list !== list || !canLoad()) return;
    if (!j.markers) { if (j.error) ctx.message(`guides: ${j.error}`, 'err'); return; }
    const body = M.markersBody(j.markers), changed = body !== M.markersBody(G.list);
    if (changed && G.saved !== null) {
      ctx.undo.clear();
      const note = 'the guides changed outside this page: showing the new ones';
      ctx.message(j.error ? `${note}\n${j.error}` : note, j.error ? 'err' : '', 2000);
    } else if (j.error) ctx.message(j.error, 'err');
    G.saved = body;
    if (!changed) return;
    G.list = j.markers;
    for (const k of ['radius', 'height']) { const last = G.list.findLast((m) => m[k] > 0); if (last) G.defaults[k] = last[k]; }
    for (const id of [...G.hidden]) if (!byId(id)) G.hidden.delete(id);
    rememberHidden();
    entries();
    ctx.selection.prune(alive);
    G.draw(); ctx.emit('guides');
  });

  // ------------------------------------------------------------------ edits from the panels and the keymap
  G.add = (m) => {
    const marker = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind: m.kind, name: M.nextName(G.list, m.kind), points: m.points,
      ...(m.kind === 'site' ? { radius: G.defaults.radius } : {}), ...(m.kind === 'volume' ? { height: G.defaults.height } : {}) };
    added = marker;
    G.change(`add ${marker.name}`, (list) => { list.push(marker); });
    ctx.selection.apply([guideId(marker.id)]);
    return marker;
  };
  G.remove = (ids) => {
    const drop = new Set(ids);
    const gone = G.list.filter((m) => drop.has(m.id));
    if (!gone.length) return 0;
    G.change(`delete ${gone.length === 1 ? gone[0].name : `${gone.length} guides`}`, (list) => { for (let i = list.length - 1; i >= 0; i--) if (drop.has(list[i].id)) list.splice(i, 1); });
    return gone.length;
  };
  /**
   * Remove CVs selected on their own: `cvs` maps a guide id to CV numbers. A curve keeps 2 and an area 3: the CVs
   * that would take it below are kept. One undo step; returns {removed, kept}.
   */
  G.removeCVs = (cvs) => {
    let removed = 0, kept = 0;
    const plan = [];
    for (const [id, ks] of cvs) {
      const m = byId(id);
      if (!m || !hasCVs(m)) continue;
      let next = m;
      for (const k of [...new Set(ks)].sort((a, b) => b - a)) { const n = M.removePoint(next, k); if (n) { next = n; removed++; } else kept++; }
      if (next !== m) plan.push(next);
    }
    if (plan.length) {
      const one = plan.length === 1 && removed === 1;
      G.change(one ? `remove a CV of ${plan[0].name}` : `remove ${removed} CVs`, (list) => { for (const n of plan) list[list.findIndex((o) => o.id === n.id)] = n; });
      for (const n of plan) dropCVs(n.id);
    }
    return { removed, kept };
  };
  G.rename = (id, raw) => {
    const m = byId(id);
    if (!m) return { error: 'no such guide' };
    const r = M.checkName(G.list, id, raw);
    if (r.error || r.name === m.name) return r;
    G.change(`rename ${m.name} to ${r.name}`, (list) => { list.find((o) => o.id === id).name = r.name; });
    return r;
  };
  /** A null's radius or a volume's height (merged while typing). */
  G.setSize = (id, key, v) => {
    if (!(v > 0) || !Number.isFinite(v)) return false;
    G.defaults[key] = v;
    const m = byId(id);
    if (!m || !(key in m) || m[key] === v) return false;
    return G.change(`${key} of ${m.name}`, (list) => { list.find((o) => o.id === id)[key] = v; }, `${key}:${id}`);
  };
  /** Move a whole guide so that its pivot's coordinate on `axis` becomes the typed value; its points stay whole millimetres. */
  G.setTranslate = (id, axis, value) => {
    G.gizmoEnd(true);
    const m = byId(id);
    if (!m || !Number.isFinite(value)) return false;
    const d = [0, 0, 0];
    d[axis] = M.mm(value - M.pivotOf(m)[axis]);
    if (!d[axis]) return false;
    return G.change(`move ${m.name}`, (list) => { const i = list.findIndex((o) => o.id === id); list[i] = M.translateMarker(list[i], d); });
  };
  G.setRotate = (id, axis, value) => {
    G.gizmoEnd(true);
    const m = byId(id), next = m && M.setRotate(m, axis, value);
    if (!next || M.rotateOf(m)[axis] === M.rotateOf(next)[axis]) return false;
    return G.change(`rotate ${m.name}`, (list) => { list[list.findIndex((o) => o.id === id)] = next; });
  };
  G.setVolumeSize = (id, axis, value) => {
    G.gizmoEnd(true);
    const m = byId(id), next = m && M.setVolumeSize(m, axis, value);
    if (!next) return false;
    if (axis === 1) G.defaults.height = next.height;
    const size = M.volumeSize(m)[axis];
    if (value === size || M.volumeSize(next)[axis] === size) return false;
    return G.change(`size of ${m.name}`, (list) => { list[list.findIndex((o) => o.id === id)] = next; });
  };
  G.setHidden = (ids, hide) => {
    G.gizmoEnd(true);
    for (const id of ids) if (hide) G.hidden.add(id); else G.hidden.delete(id);
    rememberHidden(); entries(); G.draw(); ctx.emit('guides');
  };
  G.showAll = () => { G.hidden.clear(); rememberHidden(); entries(); G.draw(); ctx.emit('guides'); };

  // ------------------------------------------------------------------ picking (screen space, in pixels)
  const segDist = (px, py, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
    return Math.hypot(a.x + t * dx - px, a.y + t * dy - py);
  };
  /** The points that must lie inside a box for a guide to be box-selected. */
  G.points = (m) => (m.kind === 'volume' ? M.boxPoints(m) : m.points).map(V3);
  /**
   * The ids a box takes: a guide wholly inside it whole; of a curve or an area partly inside, the CVs inside it.
   * `inside(points)` tests world points.
   */
  G.boxSelect = (inside) => {
    const out = [];
    for (const m of G.list) {
      if (G.hidden.has(m.id)) continue;
      if (inside(G.points(m))) { out.push(guideId(m.id)); continue; }
      if (hasCVs(m)) m.points.forEach((p, k) => { if (inside([V3(p)])) out.push(pieceId(guideId(m.id), k)); });
    }
    return out;
  };
  G.bounds = (m) => { const { lo, hi } = M.boundsOf(m); return new THREE.Box3(V3(lo), V3(hi)); };
  /** Bounds of one CV (a point), or null when the guide has no such CV. */
  G.cvBounds = (m, k) => (hasCVs(m) && m.points[k] ? new THREE.Box3(V3(m.points[k]), V3(m.points[k])) : null);
  /** How many pieces a guide's selection id has: its CVs for a curve or an area, else 1 (selection.js normalize). */
  G.pieceCount = (id) => { const m = byId(id); return m && hasCVs(m) ? m.points.length : 1; };
  /** The selection id a press on a handle selects: a CV of a curve or an area on its own, else the whole guide. */
  G.idOf = (h) => { const m = byId(h.id); return m && hasCVs(m) && h.part === 'point' ? pieceId(guideId(h.id), h.k) : guideId(h.id); };
  /** Labels of hovered and selected guides: [{key, at: Vector3, text, cls}] (main.js places them in every view). */
  G.labels = () => {
    const out = [];
    for (const m of G.list) {
      if (G.hidden.has(m.id)) continue;
      const id = guideId(m.id), sel = ctx.selection.has(id);
      if (!sel && !ctx.selection.touches(id) && (ctx.hover ? parseId(ctx.hover).obj : null) !== id) continue;
      const at = m.kind === 'site' ? V3(m.points[0]) : m.kind === 'zone' ? V3(M.centroid(m.points)) : m.kind === 'path' ? V3(M.halfway(m.points)) : (() => { const { lo, hi } = M.boxOf(m); return new THREE.Vector3((lo[0] + hi[0]) / 2, hi[1], (lo[2] + hi[2]) / 2); })();
      // a null's name stands up and to the right of its cross, clear of the arms
      out.push({ key: `n:${m.id}`, at, text: m.name, cls: `lbl${m.kind === 'site' ? ' null' : ''}${sel ? ' sel' : ''}` });
      if (sel && m.kind === 'volume') {
        const [, , a, b] = M.volumeCorners(m);
        const [x, y, z] = M.volumeSize(m);
        out.push({ key: `s:${m.id}`, at: V3(a).lerp(V3(b), 0.5), text: `${fmtLen(x)} × ${fmtLen(y)} × ${fmtLen(z)} m`, cls: 'lbl dimen' });
      }
    }
    return out;
  };

  // ------------------------------------------------------------------ placement modes
  let note = '', lastPointClick = null;
  const HINT = {
    site: () => 'Null: click the ground or the geometry',
    path: (n) => n ? `Curve: ${n} CV${n === 1 ? '' : 's'} · click to add one` : 'Curve: click to add a CV',
    zone: (n) => n ? `Area: ${n} corner${n === 1 ? '' : 's'} · click to add one, or click the first corner to close it` : 'Area: click to add a corner',
    volume: () => {
      const d = G.draft;
      return d ? `Volume: click the opposite corner · ${fmtLen(Math.abs(d.b.x - d.a.x))} × ${fmtLen(Math.abs(d.b.z - d.a.z))} m, ${fmtLen(G.defaults.height)} m high` : 'Volume: click one corner';
    },
  };
  G.hintState = () => {
    const d = G.gizmoDrag;
    if (d) return { text: d.text, finish: null, removeLast: null, cancel: null, note: '' };
    if (!G.mode) return null;
    const n = G.draft?.points?.length ?? 0, hasPoints = hasCVs({ kind: G.mode });
    return { text: HINT[G.mode](n), finish: hasPoints ? n >= M.minPoints(G.mode) : null, removeLast: hasPoints ? n > 0 : null, note };
  };
  const hint = (text = '') => { note = text; ctx.emit('hint'); };
  G.setMode = (kind) => {
    G.gizmoEnd(true);
    G.draft = null; G.cursor = null; G.down = null;
    lastPointClick = null; note = '';
    G.mode = kind;
    G.drawDraft();
    ctx.emit('mode');
  };
  const placed = (m) => {
    G.setMode(null);
    const marker = G.add(m);
    ctx.message(`added ${marker.name}`, 'ok', 1500, 1500);
  };
  const finish = () => {
    if (G.mode !== 'path' && G.mode !== 'zone') return;
    const points = G.draft?.points ?? [], need = M.minPoints(G.mode);
    if (points.length < need) return hint(G.mode === 'zone' ? 'an area needs 3 points' : 'a curve needs 2 points');
    placed({ kind: G.mode, points });
  };
  /** Enter, Backspace, Esc in a placement mode; true when handled. */
  G.key = (action) => {
    if (!G.mode) return false;
    if (action === 'finish') { finish(); return true; }
    if (action === 'removeLast') {
      if (!G.draft?.points) return true;
      G.draft.points.pop();
      if (!G.draft.points.length) { G.draft = null; G.cursor = null; }
      lastPointClick = null;
      G.drawDraft(); hint();
      return true;
    }
    if (action === 'cancel') {
      G.setMode(null);
      return true;
    }
    return false;
  };
  const mm = (p) => [M.mm(p.x), M.mm(p.y), M.mm(p.z)];
  const addPoint = (p) => {
    if (G.mode === 'site') return placed({ kind: 'site', points: [mm(p)] });
    if (G.mode === 'volume') G.draft = { kind: 'volume', y: p.y, a: p.clone(), b: p.clone() };
    else {
      G.draft ??= { kind: G.mode, points: [] };
      G.draft.points.push(mm(p));
    }
    G.cursor = null;
    G.drawDraft(); hint();
  };
  G.startAt = (kind, point) => {
    G.setMode(kind);
    if (point) addPoint(point);
  };
  /** The scene is still being drawn: the output's cook and GLB in flight, or a shown reference layer loading. */
  const sceneLoading = () => !!ctx.output?.loading || !!ctx.layers?.loading?.();
  /** A left press in a placement mode (x, y in viewport pixels). */
  G.pointerDown = (_slot, x, y) => { G.down = { x, y }; };
  G.pressCancel = () => { G.down = null; };
  G.pointerMove = (slot, x, y) => {
    if (!G.mode) return;
    if (G.draft?.kind === 'volume') {
      const p = ctx.planePoint(slot, x, y, G.draft.y);
      if (p) { G.draft.b = p; G.drawDraft(); ctx.emit('hint'); }
    } else if (G.draft?.points?.length) {
      const hit = ctx.surfacePoint(slot, x, y);
      G.cursor = hit ? hit.point : null;
      G.drawDraft();
    }
  };
  /** A placement click adds a point or finishes the guide. */
  G.pointerUp = (slot, x, y, t = performance.now()) => {
    const down = G.down;
    G.down = null;
    if (!G.mode || !down || isDrag(x - down.x, y - down.y)) return;
    const d = G.draft;
    if (d?.kind === 'volume') {
      const p = ctx.planePoint(slot, x, y, d.y);
      if (!p) return hint('nothing under the pointer');
      d.b = p;
      if (Math.abs(p.x - d.a.x) < 0.01 || Math.abs(p.z - d.a.z) < 0.01) {
        G.drawDraft();
        return hint('the volume needs a size');
      }
      return placed({ kind: 'volume', points: [mm(d.a), mm(p)] });
    }
    if (d?.kind === 'zone' && d.points.length >= 3) {
      const f = ctx.views.project(slot, V3(d.points[0]));
      if (f && Math.hypot(f.x - x, f.y - y) < 10) return finish();
    }
    const click = { x, y, t };
    if (isDoubleClick(lastPointClick, click)) return finish();
    const hit = ctx.surfacePoint(slot, x, y);
    if (!hit) return hint('nothing under the pointer');
    if (!hit.surface && sceneLoading()) return hint('the scene is still loading: place it once it is drawn');
    if (G.mode === 'path' || G.mode === 'zone') lastPointClick = click;
    addPoint(hit.point);
  };
  G.leave = () => { if (G.cursor) { G.cursor = null; G.drawDraft(); } };

  // ------------------------------------------------------------------ dragging (select mode)
  // A plain left drag on a guide (pointer.js) moves what is under it: a null's point, a CV of a curve or an area or a volume's
  // ground corner moves that point (onto a reference layer under the pointer, else in the plane through it facing the
  // view); a press on a line or a volume's edge moves the whole guide in that plane. The guide follows the pointer
  // and is saved once, on release, as one undo step. Double-click a CV to remove it, a line to add one there.
  /** The plane a drag moves in: horizontal in persp, top and bottom; the view's own axis plane in front, right… */
  const dragPlane = (slot, at) => {
    const c = ctx.views.cam(slot), f = c.name === 'persp' ? [0, -1, 0] : AXIS_VIEWS[c.name]?.f ?? [0, -1, 0];
    const n = new THREE.Vector3(Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2]));
    return new THREE.Plane().setFromNormalAndCoplanarPoint(n, at);
  };
  const onPlane = (slot, x, y, plane) => ctx.views.ray(slot, x, y).ray.intersectPlane(plane, new THREE.Vector3());
  /**
   * What a press at (x, y) would grab: {id, part: 'point' | 'corner' | 'body', k, seg?, t?, at: [x, y, z]} or null.
   * Points (CVs, a null, corners) win over lines within their few pixels; the nearest wins among guides.
   */
  G.handleAt = (slot, x, y) => {
    if (ctx.isolated) return null;
    const cam = ctx.views.camera(slot);
    const proj = (p) => ctx.views.project(slot, V3(p), cam);
    let best = null;
    const offer = (d, h, limit) => { if (d <= limit && d < (best?.d ?? Infinity)) best = { ...h, d }; };
    for (const m of G.list) {
      if (G.hidden.has(m.id)) continue;
      const id = m.id;
      if (m.kind === 'site') { const c = proj(m.points[0]); if (c) offer(Math.hypot(c.x - x, c.y - y), { id, part: 'point', k: 0, at: m.points[0] }, CROSS_PX); continue; }
      if (m.kind === 'volume') {
        M.volumeCorners(m).forEach((p, k) => { const c = proj(p); if (c) offer(Math.hypot(c.x - x, c.y - y) - 2, { id, part: 'corner', k, at: p }, CV_PX + 2); });
        const { lo, hi } = M.boxOf(m);
        for (const [a, b] of boxEdges(m)) {
          const A = ctx.views.project(slot, a, cam), B = ctx.views.project(slot, b, cam);
          if (A && B) offer(segDist(x, y, A, B) + 1, { id, part: 'body', at: [a.x, lo[1], a.z] }, PICK_PX);
        }
        continue;
      }
      m.points.forEach((p, k) => { const c = proj(p); if (c) offer(Math.hypot(c.x - x, c.y - y) - 2, { id, part: 'point', k, at: p }, CV_PX + 2); });
      M.segmentsOf(m).forEach(([i, j], s) => {
        const A = proj(m.points[i]), B = proj(m.points[j]);
        if (!A || !B) return;
        const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / l2)) : 0;
        // A screen-space fraction is not a world-space fraction in perspective. Project the viewing ray onto the
        // actual segment so inserting a CV lands where the line was clicked, even when its ends differ in depth.
        const a = V3(m.points[i]), b = V3(m.points[j]), at = new THREE.Vector3();
        ctx.views.ray(slot, x, y).ray.distanceSqToSegment(a, b, undefined, at);
        offer(segDist(x, y, A, B) + 1, { id, part: 'body', seg: s, t, at: [at.x, at.y, at.z] }, PICK_PX);
      });
    }
    return best;
  };
  /** A drag on a handle starts from the press at (x, y) (nothing moves until the pointer does). */
  G.dragStart = (slot, x, y, h) => {
    const m = byId(h.id);
    if (!m) return;
    G.dragging = { slot, x, y, h, start: M.cloneMarkers([m])[0], plane: dragPlane(slot, V3(h.at)), from: null, moved: false, live: null };
    G.dragging.from = onPlane(slot, x, y, G.dragging.plane);
  };
  /** The guide under the drag, moved for the pointer at (x, y). */
  G.dragMove = (slot, x, y) => {
    const d = G.dragging;
    if (!d) return;
    if (!d.moved && Math.hypot(x - d.x, y - d.y) <= 4) return;
    d.moved = true;
    let next = null;
    if (d.h.part === 'body') {
      const p = onPlane(d.slot, x, y, d.plane);
      if (!p || !d.from) return;
      next = M.translateMarker(d.start, [p.x - d.from.x, p.y - d.from.y, p.z - d.from.z]);
    } else {
      // onto a reference layer under the pointer (an imported terrain or blockout), else in the plane through the
      // point: never onto the output, which the graph builds from these guides (a CV would climb the house it makes)
      const hit = ctx.surfacePoint(d.slot, x, y, { layersOnly: true });
      const p = hit?.surface ? hit.point : onPlane(d.slot, x, y, d.plane);
      if (!p) return;
      next = d.h.part === 'corner' ? M.resizeVolume(d.start, d.h.k, [p.x, p.y, p.z]) : M.movePoint(d.start, d.h.k, [p.x, p.y, p.z]);
    }
    if (!next) return;
    d.live = next;
    const i = G.list.findIndex((o) => o.id === d.h.id);
    if (i >= 0) G.list[i] = next;
    entries(); G.draw(); ctx.emit('guides');
    const what = d.h.part === 'body' ? next.name : d.h.part === 'corner' ? `a corner of ${next.name}` : next.kind === 'site' ? next.name : `CV ${d.h.k} of ${next.name}`;
    ctx.message(`moving ${what}`, 'busy');
  };
  /** The release: one undo step and one save for the whole drag; false when nothing moved (the press was a click). */
  G.dragEnd = (cancel = false) => {
    const d = G.dragging;
    G.dragging = null;
    if (!d || !d.moved || !d.live) return false;
    const i = G.list.findIndex((o) => o.id === d.h.id);
    if (i < 0) return true;
    G.list[i] = d.start; // the list as it was, so the change records the drag as one step
    if (cancel) {
      // An earlier queued save may already have captured the live preview. Reconcile after it finishes; without
      // an in-flight save this sees the original saved body and writes nothing.
      entries(); G.draw(); save(); ctx.emit('guides'); ctx.message(''); return true;
    }
    const live = d.live;
    const label = d.h.part === 'body' || live.kind === 'site' ? `move ${live.name}` : d.h.part === 'corner' ? `resize ${live.name}` : `move CV ${d.h.k} of ${live.name}`;
    G.change(label, (list) => { const j = list.findIndex((o) => o.id === live.id); if (j < 0) return false; list[j] = live; });
    ctx.message(`${label} · ${M.EDITOR_NAMES[live.kind]} saved to inputs/markers.json`, 'ok', 1500);
    return true;
  };
  G.gizmoTarget = () => ['move', 'rotate', 'scale'].includes(ctx.tool) && !G.mode && !ctx.isolated && !G.dragging
    ? transformTargets(G.list, ctx.selection.items, G.hidden) : null;
  const rayCoords = (ray) => ({ origin: ray.origin.toArray(), direction: ray.direction.toArray() });
  G.gizmoStart = ({ id, shape, k }, ray, size) => {
    const target = G.gizmoTarget();
    if (!target || G.gizmoDrag) return;
    const tool = ctx.tool;
    const d = { id, tool, target, shape, size, ray: rayCoords(ray), start: G.list };
    if (tool === 'move') {
      d.delta = [0, 0, 0];
      d.text = moveText(id, d.delta);
    } else if (tool === 'rotate') {
      if (!ringFromFace(id, d.ray)) {
        const a = shape.points[k], b = shape.points[(k + 1) % shape.points.length];
        const x = b.x - a.x, y = b.y - a.y, length = Math.hypot(x, y);
        d.tangent = { x: x / length, y: y / length };
      }
      d.value = 0;
      d.text = rotateText(id, d.value);
    } else {
      d.value = 1;
      d.text = scaleText(id, d.value);
    }
    G.gizmoDrag = d;
    ctx.emit('hint'); ctx.requestRender();
  };
  G.gizmoMove = (ray, dx, dy) => {
    const d = G.gizmoDrag;
    if (!d) return;
    const { id, target } = d;
    if (d.tool === 'move') {
      const delta = moveDelta(id, d.ray, rayCoords(ray), target.pivot);
      if (!delta || delta.every((v, i) => v === d.delta[i])) return;
      d.delta = delta;
      d.text = moveText(id, delta);
      G.list = delta.some((v) => v !== 0) ? target.move(delta) : d.start;
    } else if (d.tool === 'rotate') {
      const angle = d.tangent ? tangentTurn(d.tangent, dx, dy, d.size) : ringTurn(id, target.pivot, d.ray, rayCoords(ray));
      if (angle === null) return;
      const turn = d.tangent ? angle : unwrapTurn(d.value, angle);
      if (turn === d.value) return;
      d.value = turn;
      d.text = rotateText(id, turn);
      G.list = turn ? target.rotate(id, turn) : d.start;
    } else {
      const factor = scaleFactor(d.shape, dx, dy, d.size);
      if (factor === d.value) return;
      d.value = factor;
      d.text = scaleText(id, factor);
      const factors = ['x', 'y', 'z'].map((axis) => id === 'all' || id === axis ? factor : 1);
      G.list = factor === 1 ? d.start : target.scale(factors);
    }
    entries(); G.draw(); ctx.emit('guides'); ctx.emit('hint');
  };
  G.gizmoEnd = (cancel = false) => {
    const d = G.gizmoDrag;
    if (!d) return false;
    const live = G.list;
    G.gizmoDrag = null;
    G.list = d.start;
    ctx.emit('hint'); ctx.requestRender();
    if (live === d.start) return false;
    if (cancel || M.markersBody(live) === M.markersBody(d.start)) {
      entries(); G.draw(); ctx.emit('guides');
      return false;
    }
    const label = transformLabel(d.tool, d.target);
    G.change(label, (list) => { list.splice(0, list.length, ...live); });
    ctx.message(`${label} · saved to inputs/markers.json`, 'ok', 1500, 1500);
    return true;
  };
  /** Double-click in select mode: on a CV removes it, on a line of a curve or an area adds a CV there. */
  G.doubleClick = (slot, x, y) => {
    const h = G.handleAt(slot, x, y), m = h && byId(h.id);
    if (!m || (m.kind !== 'path' && m.kind !== 'zone')) return false;
    if (h.part === 'point') {
      const next = M.removePoint(m, h.k);
      if (!next) { ctx.message(`${m.name} keeps its CV: a${m.kind === 'zone' ? 'n area needs 3' : ' curve needs 2'}`, '', 2000); return true; }
      dropCVs(m.id);
      G.change(`remove CV ${h.k} of ${m.name}`, (list) => { list[list.findIndex((o) => o.id === m.id)] = next; });
      ctx.message(`removed CV ${h.k} of ${m.name}`, 'ok', 1500);
      return true;
    }
    const next = M.insertPoint(m, h.seg, h.at);
    if (!next) return false;
    dropCVs(m.id);
    G.change(`add a CV to ${m.name}`, (list) => { list[list.findIndex((o) => o.id === m.id)] = next; });
    ctx.message(`added a CV to ${m.name} · drag it, double-click it to remove it`, 'ok', 2000);
    return true;
  };
  return G;
}
