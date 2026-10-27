// Guides: nulls, curves, areas and volumes, the markers agents read as
// inputs/markers.json (roles site, path, zone, volume). Drawn as the standard objects they are, in one desaturated
// cyan, on top of the scene: a null is an axis cross (its radius circle only while hovered or selected), a curve a
// polyline with CV squares and a direction tick, an area a closed curve with a light diagonal hatch, a volume a wire
// box (its size printed on an edge while selected). Placement modes add them; every change saves the whole list
// (POST /api/markers) and is one undo step. Saving never moves the camera or reloads the output.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { api } from './api.js';
import * as M from './markers.js';
import { COLORS, fatSegments, lineMaterial, disposeTree } from './scene.js';
import { fmtLen } from './units.js';

export const guideId = (id) => `guide:${id}`;
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
function boxEdges(lo, hi) {
  const out = [];
  for (let ax = 0; ax < 3; ax++) for (let s = 0; s < 4; s++) {
    const a = [0, 0, 0], u = (ax + 1) % 3, v = (ax + 2) % 3;
    a[u] = s & 1; a[v] = s >> 1;
    const b = a.slice(); b[ax] = 1;
    out.push([a, b].map(([i, j, k]) => new THREE.Vector3(i ? hi[0] : lo[0], j ? hi[1] : lo[1], k ? hi[2] : lo[2])));
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

/** The objects of one guide in one state ('normal' | 'hover' | 'sel'). */
function guideObject(m, state, wpp) {
  const st = STYLE[state], g = new THREE.Group(), P = m.points.map(V3);
  g.name = `guide ${m.name}`;
  if (m.kind === 'site') {
    const c = P[0];
    const cross = pairs([[new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)], [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0)], [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1)]], st);
    // oriented by orient: the markers file writes identity (src/viewer/server.ts markersGeometry)
    g.add(screenSized(cross, c, CROSS_PX, wpp));
    if (state !== 'normal') g.add(fatLine(circle(c, m.radius ?? M.DEFAULT_RADIUS), { ...st, width: 1 }, true));
  } else if (m.kind === 'volume') {
    const { lo, hi } = M.boxOf(m);
    g.add(pairs(boxEdges(lo, hi), st));
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
  const rememberHidden = () => ctx.store.set('guides.hidden', [...G.hidden]);
  const entries = () => {
    for (const id of [...ctx.objects.keys()]) if (id.startsWith('guide:') && !byId(id.slice(6))) ctx.objects.delete(id);
    for (const m of G.list) {
      const id = guideId(m.id), e = ctx.objects.get(id) ?? { id, kind: 'guide' };
      e.marker = m; e.label = m.name; e.visible = !G.hidden.has(m.id);
      ctx.objects.set(id, e);
    }
  };

  /** Redraw the guides whose marker or state changed (state from the selection and the hover). */
  G.draw = () => {
    const seen = new Set();
    for (const m of G.list) {
      const id = guideId(m.id), visible = !G.hidden.has(m.id);
      const state = ctx.selection.has(id) ? 'sel' : ctx.hover === id ? 'hover' : 'normal';
      const sig = JSON.stringify([m.kind, m.points, m.radius, m.height, state]);
      seen.add(m.id);
      let d = G.drawn.get(m.id);
      if (!d || d.sig !== sig) {
        if (d) { ctx.guidesRoot.remove(d.obj); disposeTree(d.obj); }
        d = { sig, obj: guideObject(m, state, ctx.pxWorld) };
        G.drawn.set(m.id, d);
        ctx.guidesRoot.add(d.obj);
      }
      d.obj.visible = visible;
    }
    for (const [id, d] of G.drawn) if (!seen.has(id)) { ctx.guidesRoot.remove(d.obj); disposeTree(d.obj); G.drawn.delete(id); }
    ctx.requestRender();
  };
  /** The draft being placed: curve or area CVs with the rubber band to the cursor, or the volume being dragged. */
  G.drawDraft = () => {
    for (const o of [...G.draftRoot.children]) { G.draftRoot.remove(o); disposeTree(o); }
    const d = G.draft;
    if (d?.kind === 'volume') {
      const m = { points: [[d.a.x, d.y, d.a.z], [d.b.x, d.y, d.b.z]], height: G.defaults.height };
      const { lo, hi } = M.boxOf(m);
      if (hi[0] > lo[0] && hi[2] > lo[2]) G.draftRoot.add(pairs(boxEdges(lo, hi), STYLE.draft));
    } else if (d?.points?.length) {
      const P = d.points.map(V3), live = G.cursor ? [...P, G.cursor] : P;
      if (live.length >= 2) G.draftRoot.add(fatLine(live, STYLE.draft));
      if (d.kind === 'zone' && live.length >= 3) G.draftRoot.add(fatLine([live[live.length - 1], live[0]], { ...STYLE.draft, opacity: 0.4, width: 1 }));
      G.draftRoot.add(squares(P, COLORS.sel));
    }
    ctx.requestRender();
  };

  // ------------------------------------------------------------------ saving: the whole list, the latest wins
  const save = ctx.coalesce(async () => {
    const body = M.markersBody(G.list);
    if (body === G.saved) return;
    const r = await api.saveMarkers(body);
    if (r.ok) {
      G.saved = body;
      const file = `inputs/markers.json${ctx.layers.where ? ' ' + ctx.layers.where : ''}`;
      if (M.markersBody(G.list) !== body) { /* a newer list is on its way */ }
      else if (G.mode) G.hint(` · saved to ${file}`);
      else ctx.message(r.count ? `${r.count} guide${r.count === 1 ? '' : 's'} saved to ${file} (${r.points} points, ${r.prims} prims)` : `no guides: ${file} removed`, 'ok');
    } else ctx.message(`guides not saved — ${r.error}`, 'err');
    ctx.emit('guides');
  });
  G.saving = () => M.markersBody(G.list) !== G.saved;
  const setList = (list) => {
    G.list = M.cloneMarkers(list);
    entries();
    ctx.selection.prune((id) => !id.startsWith('guide:') || !!byId(id.slice(6)));
    G.draw(); save(); ctx.emit('guides');
  };
  /** One undoable change of the list: `edit(list)` changes a copy in place. */
  G.change = (label, edit, key) => {
    const before = M.cloneMarkers(G.list), next = M.cloneMarkers(G.list);
    if (edit(next) === false) return false;
    setList(next);
    const after = M.cloneMarkers(G.list);
    ctx.undo.push({ label, key, undo: () => setList(before), redo: () => setList(after) });
    return true;
  };
  G.load = async () => {
    const j = await api.markers();
    if (!j.markers) { if (j.error) ctx.message(`guides: ${j.error}`, 'err'); return; }
    G.list = j.markers;
    G.saved = M.markersBody(G.list);
    for (const k of ['radius', 'height']) { const last = G.list.findLast((m) => m[k] > 0); if (last) G.defaults[k] = last[k]; }
    for (const id of [...G.hidden]) if (!byId(id)) G.hidden.delete(id);
    rememberHidden();
    if (j.error) ctx.message(j.error, 'err');
    entries();
    ctx.selection.prune((id) => !id.startsWith('guide:') || !!byId(id.slice(6)));
    G.draw(); ctx.emit('guides');
  };

  // ------------------------------------------------------------------ edits from the panels and the keymap
  G.add = (m) => {
    const marker = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind: m.kind, name: M.nextName(G.list, m.kind), points: m.points,
      ...(m.kind === 'site' ? { radius: G.defaults.radius } : {}), ...(m.kind === 'volume' ? { height: G.defaults.height } : {}) };
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
  G.setHidden = (ids, hide) => {
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
  /** Outline points of a guide as segments (world), for picking. */
  const outline = (m) => {
    if (m.kind === 'volume') { const { lo, hi } = M.boxOf(m); return boxEdges(lo, hi); }
    if (m.kind === 'site') return [];
    const P = m.points.map(V3);
    if (m.kind === 'zone') P.push(P[0]);
    return P.slice(1).map((p, k) => [P[k], p]);
  };
  /** The guide nearest a viewport pixel as slot `slot` shows it, within PICK_PX: {id, d} or null. */
  G.pick = (slot, x, y) => {
    const cam = ctx.views.camera(slot);
    let best = null;
    for (const m of G.list) {
      if (G.hidden.has(m.id)) continue;
      let d = Infinity;
      if (m.kind === 'site') { const c = ctx.views.project(slot, V3(m.points[0]), cam); if (c) d = Math.max(0, Math.hypot(c.x - x, c.y - y) - CROSS_PX * 0.5); }
      for (const [a, b] of outline(m)) { const A = ctx.views.project(slot, a, cam), B = ctx.views.project(slot, b, cam); if (A && B) d = Math.min(d, segDist(x, y, A, B)); }
      if (m.kind !== 'site' && m.kind !== 'volume') for (const p of m.points) { const c = ctx.views.project(slot, V3(p), cam); if (c) d = Math.min(d, Math.hypot(c.x - x, c.y - y)); }
      if (d <= PICK_PX && d < (best?.d ?? Infinity)) best = { id: guideId(m.id), d };
    }
    return best;
  };
  /** The points that must lie inside a box for a guide to be box-selected. */
  G.points = (m) => (m.kind === 'volume' ? boxEdges(M.boxOf(m).lo, M.boxOf(m).hi).flat() : m.points.map(V3));
  G.boxSelect = (inside) => G.list.filter((m) => !G.hidden.has(m.id) && inside(G.points(m))).map((m) => guideId(m.id));
  G.bounds = (m) => { const { lo, hi } = M.boundsOf(m); return new THREE.Box3(V3(lo), V3(hi)); };
  /** Labels of hovered and selected guides: [{key, at: Vector3, text, cls}] (main.js places them in every view). */
  G.labels = () => {
    const out = [];
    for (const m of G.list) {
      if (G.hidden.has(m.id)) continue;
      const id = guideId(m.id), sel = ctx.selection.has(id);
      if (!sel && ctx.hover !== id) continue;
      const at = m.kind === 'site' ? V3(m.points[0]) : m.kind === 'zone' ? V3(M.centroid(m.points)) : m.kind === 'path' ? V3(M.halfway(m.points)) : (() => { const { lo, hi } = M.boxOf(m); return new THREE.Vector3((lo[0] + hi[0]) / 2, hi[1], (lo[2] + hi[2]) / 2); })();
      out.push({ key: `n:${m.id}`, at, text: m.name, cls: sel ? 'lbl sel' : 'lbl' });
      if (sel && m.kind === 'volume') {
        const { lo, hi } = M.boxOf(m);
        out.push({ key: `s:${m.id}`, at: new THREE.Vector3((lo[0] + hi[0]) / 2, lo[1], hi[2]), text: `${fmtLen(hi[0] - lo[0])} × ${fmtLen(hi[1] - lo[1])} × ${fmtLen(hi[2] - lo[2])} m`, cls: 'lbl dimen' });
      }
    }
    return out;
  };

  // ------------------------------------------------------------------ placement modes
  const HINT = {
    site: () => 'Place null — click the ground or the geometry · Esc leaves',
    path: () => (G.draft ? `Draw curve — ${G.draft.points.length} CV${G.draft.points.length === 1 ? '' : 's'} · click adds one · Enter finishes · Backspace removes the last · Esc cancels` : 'Draw curve — click CVs along it · Enter finishes · Esc leaves'),
    zone: () => (G.draft ? `Draw area — ${G.draft.points.length} corner${G.draft.points.length === 1 ? '' : 's'} · click adds one · Enter or a click on the first corner closes it · Backspace removes the last · Esc cancels` : 'Draw area — click its corners · Enter closes it · Esc leaves'),
    volume: () => (G.draft ? `Drag volume — ${fmtLen(Math.abs(G.draft.b.x - G.draft.a.x))} × ${fmtLen(Math.abs(G.draft.b.z - G.draft.a.z))} m, ${fmtLen(G.defaults.height)} m high` : 'Drag volume — drag a rectangle on the ground or the geometry; it rises by its height · Esc leaves'),
  };
  G.hint = (extra = '') => { if (G.mode) ctx.message(HINT[G.mode]() + extra, 'busy'); };
  G.setMode = (kind) => {
    G.draft = null; G.cursor = null; G.down = null;
    G.mode = kind;
    G.drawDraft();
    ctx.emit('mode');
    if (kind) G.hint(); else ctx.message('');
  };
  const finish = () => {
    const d = G.draft;
    if (!d?.points) return false;
    const need = M.minPoints(d.kind);
    if (d.points.length < need) { G.hint(` · a${d.kind === 'zone' ? 'n area' : ' curve'} needs ${need} points`); return true; }
    G.draft = null; G.cursor = null; G.drawDraft();
    G.add({ kind: d.kind, points: d.points });
    G.hint(` · added ${G.list[G.list.length - 1].name}`);
    return true;
  };
  /** Enter, Backspace, Esc in a placement mode; true when handled. */
  G.key = (action) => {
    if (!G.mode) return false;
    if (action === 'finish') return finish() || true;
    if (action === 'removeLast') {
      if (!G.draft?.points) return true;
      G.draft.points.pop();
      if (!G.draft.points.length) { G.draft = null; G.cursor = null; }
      G.drawDraft(); G.hint();
      return true;
    }
    if (action === 'cancel') {
      if (G.draft) { G.draft = null; G.cursor = null; G.drawDraft(); G.hint(' · cancelled'); return true; }
      G.setMode(null);
      return false; // Esc goes on to clear the selection
    }
    return false;
  };
  const mm = (p) => [M.mm(p.x), M.mm(p.y), M.mm(p.z)];
  /** A left press in a placement mode (x, y in viewport pixels). */
  G.pointerDown = (slot, x, y) => {
    G.down = { slot, x, y };
    if (G.mode !== 'volume') return;
    const hit = ctx.surfacePoint(slot, x, y);
    if (hit) { G.draft = { kind: 'volume', y: hit.point.y, a: hit.point.clone(), b: hit.point.clone() }; G.drawDraft(); }
  };
  G.pointerMove = (slot, x, y) => {
    if (!G.mode) return;
    if (G.draft?.kind === 'volume') {
      if (!G.down) return;
      // on the level of the first corner, through the view the drag began in
      const p = ctx.planePoint(G.down.slot, x, y, G.draft.y);
      if (p) { G.draft.b = p; G.drawDraft(); G.hint(); }
    } else if (G.draft?.points?.length) {
      const hit = ctx.surfacePoint(slot, x, y);
      G.cursor = hit ? hit.point : null;
      G.drawDraft();
    }
  };
  /** The release of a left press: one click adds exactly one point (or one null); a drag finishes a volume. */
  G.pointerUp = (slot, x, y) => {
    const down = G.down;
    G.down = null;
    if (!G.mode || !down) return;
    const moved = Math.hypot(x - down.x, y - down.y);
    if (G.mode === 'volume') {
      const d = G.draft;
      G.draft = null; G.drawDraft();
      if (!d) return G.hint(' · nothing under the pointer');
      if (moved < 5 || Math.abs(d.b.x - d.a.x) < 0.01 || Math.abs(d.b.z - d.a.z) < 0.01) return G.hint(' · drag to draw the box');
      G.add({ kind: 'volume', points: [[M.mm(d.a.x), M.mm(d.y), M.mm(d.a.z)], [M.mm(d.b.x), M.mm(d.y), M.mm(d.b.z)]] });
      return G.hint(` · added ${G.list[G.list.length - 1].name}`);
    }
    if (moved > 5) return; // a drag is not a click
    if (G.mode === 'zone' && G.draft?.points.length >= 3) {
      const f = ctx.views.project(slot, V3(G.draft.points[0]));
      if (f && Math.hypot(f.x - x, f.y - y) < 10) { finish(); return; }
    }
    const hit = ctx.surfacePoint(slot, x, y);
    if (!hit) return G.hint(' · nothing under the pointer');
    const p = mm(hit.point);
    if (G.mode === 'site') { const m = G.add({ kind: 'site', points: [p] }); return G.hint(` · added ${m.name}`); }
    if (!G.draft) G.draft = { kind: G.mode, points: [] };
    G.draft.points.push(p);
    G.drawDraft(); G.hint();
  };
  G.leave = () => { if (G.cursor) { G.cursor = null; G.drawDraft(); } };
  return G;
}
