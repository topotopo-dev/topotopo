// Mapping faces onto trim bands and hotspot rectangles: face frames (which way u and v run on a face), strips of
// connected faces with u and v unfolded across their shared edges, and cutting strips into courses one band high.
import { GeoBuilder } from './geometry.ts';
import type { Geometry, Src } from './geometry.ts';
import { primNewell } from './topology.ts';
import type { TrimRegion } from './trim.ts';

export type Along = 'auto' | 'x' | 'y' | 'z' | 'longest';

/** A face is a wall when its normal is within 45° of horizontal; floors and ceilings are the rest. */
export const WALL_LIMIT = Math.SQRT1_2;

type V3 = [number, number, number];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const along = (a: V3, n: V3): V3 => { const d = dot(a, n); return [a[0] - d * n[0], a[1] - d * n[1], a[2] - d * n[2]]; };

/** Unit face normals (Newell), [0,0,0] for degenerate faces. */
export function faceNormals(g: Geometry): Float64Array {
  const out = new Float64Array(g.numPrims * 3);
  for (let p = 0; p < g.numPrims; p++) {
    const n = unit(primNewell(g, p) as V3);
    out[p * 3] = n[0]; out[p * 3 + 1] = n[1]; out[p * 3 + 2] = n[2];
  }
  return out;
}

/**
 * u and v directions on a face with normal n, u × v = n (never mirrored seen from the front). auto: walls keep v up
 * and u level; floors and ceilings run u along `longest` (the strip's longest edge). An axis runs u along it, laid
 * into the face; longest runs u along the longest edge on every face.
 */
export function faceFrame(n: V3, mode: Along, longest: V3): { u: V3; v: V3 } {
  const viaU = (a: V3) => { const u = unit(along(a, n)); return u[0] || u[1] || u[2] ? { u, v: cross(n, u) } : null; };
  if (mode === 'x' || mode === 'y' || mode === 'z') {
    const f = viaU(mode === 'x' ? [1, 0, 0] : mode === 'y' ? [0, 1, 0] : [0, 0, 1]);
    if (f) return f;
  }
  if (mode !== 'longest' && Math.abs(n[1]) <= WALL_LIMIT) {
    const v = unit(along([0, 1, 0], n));
    return { u: cross(v, n), v };
  }
  return viaU(longest) ?? viaU([1, 0, 0]) ?? viaU([0, 0, 1])!;
}

/** Point ids welded by position (unwelded copies of a point share one id). */
export function weldIds(g: Geometry, tol = 1e-6): Int32Array {
  const ids = new Int32Array(g.numPoints), seen = new Map<string, number>();
  const q = (x: number) => Math.round(x / tol);
  for (let i = 0; i < g.numPoints; i++) {
    const k = `${q(g.P[i * 3])},${q(g.P[i * 3 + 1])},${q(g.P[i * 3 + 2])}`;
    let id = seen.get(k);
    if (id === undefined) { id = i; seen.set(k, i); }
    ids[i] = id;
  }
  return ids;
}

export interface Strips {
  /** strip index of each prim (-1 = not selected) */
  of: Int32Array;
  count: number;
  /** per prim: u and v directions and offsets, so u_m = P·u + uo and v_m = P·v + vo in metres */
  u: Float64Array;
  v: Float64Array;
  uo: Float64Array;
  vo: Float64Array;
  /** per strip: [umin, umax, vmin, vmax] in metres */
  range: Float64Array;
  /** per point: v_m from the first face that reached it (-Infinity when no selected face uses it) */
  pointV: Float64Array;
}

/**
 * Connected selected faces (sharing an edge, welded by position) form a strip. Each face gets a frame; u and v are
 * unfolded from the strip's first face across shared edges, so they run on around corners and over folds.
 * `connect` false makes every face its own strip; `canJoin` may refuse a join (hotspot keeps islands flat).
 */
export function buildStrips(g: Geometry, sel: Uint8Array | null, mode: Along, connect = true, canJoin?: (a: number, b: number) => boolean): Strips {
  const np = g.numPrims, w = weldIds(g), N = faceNormals(g);
  const on = (p: number) => (!sel || sel[p]) && !!g.primClosed[p] && g.primStart[p + 1] - g.primStart[p] >= 3;
  const edgeKey = (a: number, b: number) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  const edgeFaces = new Map<number, number[]>();
  for (let p = 0; p < np; p++) {
    if (!on(p)) continue;
    const s = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s; v < e; v++) {
      const a = w[g.vertexPoint[v]], b = w[g.vertexPoint[v + 1 < e ? v + 1 : s]];
      if (a === b) continue;
      const k = edgeKey(a, b), l = edgeFaces.get(k);
      if (l) l.push(p); else edgeFaces.set(k, [p]);
    }
  }
  const of = new Int32Array(np).fill(-1);
  const U = new Float64Array(np * 3), V = new Float64Array(np * 3), uo = new Float64Array(np), vo = new Float64Array(np);
  const pointV = new Float64Array(g.numPoints).fill(-Infinity);
  const ranges: number[] = [];
  const P = g.P;
  const pos = (i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  let count = 0;
  for (let seed = 0; seed < np; seed++) {
    if (!on(seed) || of[seed] >= 0) continue;
    // the strip's faces, then its longest edge (floors run u along it)
    const faces: number[] = [seed];
    of[seed] = count;
    for (let qi = 0; qi < faces.length && connect; qi++) {
      const f = faces[qi], s = g.primStart[f], e = g.primStart[f + 1];
      for (let v = s; v < e; v++) {
        const a = w[g.vertexPoint[v]], b = w[g.vertexPoint[v + 1 < e ? v + 1 : s]];
        for (const h of edgeFaces.get(edgeKey(a, b)) ?? []) if (of[h] < 0 && (!canJoin || canJoin(f, h))) { of[h] = count; faces.push(h); }
      }
    }
    let longest: V3 = [1, 0, 0], best = -1;
    for (const f of faces) {
      const s = g.primStart[f], e = g.primStart[f + 1];
      for (let v = s; v < e; v++) {
        const a = pos(g.vertexPoint[v]), b = pos(g.vertexPoint[v + 1 < e ? v + 1 : s]);
        const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(d[0], d[1], d[2]);
        if (l > best + 1e-9) { best = l; longest = d; }
      }
    }
    for (const f of faces) {
      const fr = faceFrame([N[f * 3], N[f * 3 + 1], N[f * 3 + 2]], mode, longest);
      U.set(fr.u, f * 3); V.set(fr.v, f * 3);
    }
    // unfold: a face reached across an edge takes the offsets that make u and v agree at that edge's midpoint
    const done = new Uint8Array(faces.length), index = new Map(faces.map((f, i) => [f, i]));
    done[0] = 1;
    const queue = [seed];
    for (let qi = 0; qi < queue.length; qi++) {
      const f = queue[qi], s = g.primStart[f], e = g.primStart[f + 1];
      for (let v = s; v < e; v++) {
        const pa = g.vertexPoint[v], pb = g.vertexPoint[v + 1 < e ? v + 1 : s];
        const m = pos(pa).map((x, c) => (x + pos(pb)[c]) / 2);
        for (const h of edgeFaces.get(edgeKey(w[pa], w[pb])) ?? []) {
          const i = index.get(h);
          if (i === undefined || done[i]) continue;
          done[i] = 1;
          uo[h] = dot(m, U.subarray(f * 3)) + uo[f] - dot(m, U.subarray(h * 3));
          vo[h] = dot(m, V.subarray(f * 3)) + vo[f] - dot(m, V.subarray(h * 3));
          queue.push(h);
        }
      }
    }
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const f of queue) {
      for (let v = g.primStart[f]; v < g.primStart[f + 1]; v++) {
        const pt = g.vertexPoint[v], q = pos(pt);
        const um = dot(q, U.subarray(f * 3)) + uo[f], vm = dot(q, V.subarray(f * 3)) + vo[f];
        u0 = Math.min(u0, um); u1 = Math.max(u1, um); v0 = Math.min(v0, vm); v1 = Math.max(v1, vm);
        if (pointV[pt] === -Infinity) pointV[pt] = vm;
      }
    }
    ranges.push(u0, u1, v0, v1);
    count++;
  }
  // unwelded copies of a point take the value of the copy reached first
  for (let i = 0; i < g.numPoints; i++) if (pointV[i] === -Infinity && pointV[w[i]] !== -Infinity) pointV[i] = pointV[w[i]];
  return { of, count, u: U, v: V, uo, vo, range: Float64Array.from(ranges), pointV };
}

/** u_m and v_m (metres) of a point on prim p of a strip. */
export function stripUV(g: Geometry, s: Strips, p: number, pt: number): [number, number] {
  const q = [g.P[pt * 3], g.P[pt * 3 + 1], g.P[pt * 3 + 2]];
  return [dot(q, s.u.subarray(p * 3)) + s.uo[p], dot(q, s.v.subarray(p * 3)) + s.vo[p]];
}

/**
 * Cut the strips' faces into courses: rows `height` metres high from each strip's lowest v. Split points sit on the
 * edges, shared by the faces on both sides, and faces outside the selection that share a cut edge get the point too,
 * so no T-junctions appear. Returns the new geometry and, per new prim, its source prim and course (-1 = unselected).
 */
export function cutCourses(g: Geometry, s: Strips, height: number): { geo: Geometry; src: Int32Array; course: Int32Array } {
  const b = new GeoBuilder(g);
  for (let i = 0; i < g.numPoints; i++) b.copyPoint(i);
  const level = (p: number, pt: number) => (s.pointV[pt] - s.range[s.of[p] * 4 + 2]) / height;
  // split points per edge, keyed by its two points, in order from the lower point index
  const splits = new Map<string, { t: number; id: number; c: number }[]>();
  const hOf = new Map<number, number>();
  const edgeSplits = (p: number, a: number, b2: number) => {
    const lo = Math.min(a, b2), hi = Math.max(a, b2), key = `${lo},${hi}`;
    let l = splits.get(key);
    if (l) return l;
    l = [];
    const ha = level(p, lo), hb = level(p, hi), eps = 1e-7;
    const c0 = Math.ceil(Math.min(ha, hb) + eps), c1 = Math.floor(Math.max(ha, hb) - eps);
    for (let c = c0; c <= c1; c++) {
      const t = (c - ha) / (hb - ha);
      if (!(t > 1e-7 && t < 1 - 1e-7)) continue;
      const id = b.blendPoint([lo, hi], [1 - t, t]);
      hOf.set(id, c);
      l.push({ t, id, c });
    }
    splits.set(key, l);
    return l;
  };
  const src: number[] = [], course: number[] = [];
  // the selected faces first (they make the split points), then the others pick up the points on shared edges
  const ring = (p: number, make: boolean) => {
    const out: { pt: number; vsrc: Src; h: number }[] = [];
    const st = g.primStart[p], e = g.primStart[p + 1];
    for (let v = st; v < e; v++) {
      const v1 = v + 1 < e ? v + 1 : st, a = g.vertexPoint[v], c = g.vertexPoint[v1];
      out.push({ pt: a, vsrc: v, h: s.of[p] >= 0 ? level(p, a) : 0 });
      const key = `${Math.min(a, c)},${Math.max(a, c)}`;
      const l = make ? edgeSplits(p, a, c) : splits.get(key);
      if (!l || !l.length) continue;
      const fwd = a < c;
      for (const x of fwd ? l : l.slice().reverse()) {
        const t = fwd ? x.t : 1 - x.t;
        out.push({ pt: x.id, vsrc: { i: [v, v1], w: [1 - t, t] }, h: x.c });
      }
    }
    return out;
  };
  const rings = new Map<number, ReturnType<typeof ring>>();
  for (let p = 0; p < g.numPrims; p++) if (s.of[p] >= 0) rings.set(p, ring(p, true));
  for (let p = 0; p < g.numPrims; p++) {
    const r = rings.get(p);
    if (!r) {
      const o = ring(p, false);
      b.addPrim(o.map((x) => x.pt), !!g.primClosed[p], p, o.map((x) => x.vsrc));
      src.push(p); course.push(-1);
      continue;
    }
    let h0 = Infinity, h1 = -Infinity;
    for (const x of r) { h0 = Math.min(h0, x.h); h1 = Math.max(h1, x.h); }
    const c0 = Math.floor(h0 + 1e-7), c1 = Math.max(c0, Math.ceil(h1 - 1e-7) - 1);
    for (let c = c0; c <= c1; c++) {
      const part = r.filter((x) => x.h >= c - 1e-7 && x.h <= c + 1 + 1e-7);
      if (part.length < 3) continue;
      b.addPrim(part.map((x) => x.pt), true, p, part.map((x) => x.vsrc));
      src.push(p); course.push(c);
    }
  }
  return { geo: b.build(), src: Int32Array.from(src), course: Int32Array.from(course) };
}

export interface RegionFit { region: TrimRegion; /** turn the island 90° so its v runs along the region's u */ rot: boolean; cost: number }

/**
 * The region an island of size [u, v] metres fits best. A tiling band only has to match across (its height); a
 * rectangle or a band that does not tile matches both sides and may be turned 90° when it allows rotation. The cost
 * is the worse direction on a log scale. Nothing is returned past maxStretch (the worse size ratio).
 */
export function matchRegion(size: [number, number], regions: TrimRegion[], maxStretch: number): RegionFit | null {
  let best: RegionFit | null = null;
  const consider = (region: TrimRegion, rot: boolean, cost: number, ratio: number) => {
    if (!(ratio <= maxStretch) || !Number.isFinite(cost)) return;
    if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) <= 1e-9 && region.name < best.region.name)) best = { region, rot, cost };
  };
  for (const region of regions) {
    if (region.tile) {
      const ratio = worse(size[1], region.height);
      consider(region, false, Math.abs(Math.log(size[1] / region.height)), ratio);
      continue;
    }
    consider(region, false, worseLog(size[0], size[1], region.length, region.height), worse2(size[0], size[1], region.length, region.height));
    if (region.rotate) consider(region, true, worseLog(size[1], size[0], region.length, region.height), worse2(size[1], size[0], region.length, region.height));
  }
  return best;
}

const worse = (a: number, b: number) => (a > 0 && b > 0 ? Math.max(a / b, b / a) : Infinity);
const worse2 = (au: number, av: number, bu: number, bv: number) => Math.max(worse(au, bu), worse(av, bv));
const worseLog = (au: number, av: number, bu: number, bv: number) => Math.max(Math.abs(Math.log(au / bu)), Math.abs(Math.log(av / bv)));
