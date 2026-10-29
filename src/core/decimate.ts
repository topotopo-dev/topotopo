// Attribute-preserving decimation through meshoptimizer (MIT): simplifyWithAttributes for triangle meshes,
// simplifySloppy for the aggressive mode, simplifyPoints for point clouds.
//
// meshoptimizer simplifies an indexed triangle list over "render vertices": a render vertex is a point together
// with one set of corner (vertex attribute) values, so a point on a uv seam is two render vertices at the same
// position. The simplifier detects such discontinuities by position and keeps them, which is what makes uv seams,
// hard normals and material borders survive. Here a render vertex is a point plus the values of every vertex
// attribute of a corner (floats compared with a small tolerance) plus the prim region (string prim attributes and
// prim group membership), and the output corners copy the attributes of the corner that represents their render
// vertex, so nothing is interpolated: point attributes stay exact, vertex attributes keep their seams.
import { MeshoptSimplifier } from 'meshoptimizer';
import type { SimplifierFlags } from 'meshoptimizer';
import { GeoBuilder } from './geometry.ts';
import type { Geometry } from './geometry.ts';
import { triangulate } from './topology.ts';
import { primRegions, vertexAttribsDiffer } from './remesh.ts';
import { readUV } from './uv.ts';
import { trianglesUV, uvOverlapPairs, uvPairText, uvTriangleAreas } from './uvoverlap.ts';
import { chartRoots } from './uvreport.ts';
import { partsOf, primWhere } from './report.ts';
import { TriBVH, closestScratch } from './spatial.ts';

export interface SteerAttrib { name: string; weight: number }

export interface DecimateOptions {
  /** fraction of triangles to keep (0..1) */
  ratio: number;
  /** target triangle count; > 0 overrides ratio */
  targetCount: number;
  /** stop when the error reaches this (relative to the mesh extent, or absolute with errorAbsolute) */
  maxError: number;
  errorAbsolute: boolean;
  lockBorder: boolean;
  prune: boolean;
  sparse: boolean;
  regularize: boolean;
  /** simplifySloppy: ignores topology and seams, reaches any target */
  sloppy: boolean;
  /** float point or vertex attributes that steer the simplification (weight 1 ≈ a change of 1 counts like the mesh extent) */
  attributes: SteerAttrib[];
  /** prims to decimate (null = all); points shared with other prims stay fixed */
  group: Uint8Array | null;
  /** points that must not move or disappear */
  lockPoints: Uint8Array | null;
}

export interface DecimateResult {
  geo: Geometry;
  /** achieved error in the units of maxError (relative unless errorAbsolute) */
  error: number;
  /** achieved error in scene units */
  errorAbs: number;
  trisIn: number;
  trisOut: number;
  /** attributes that were used to steer, and requested ones that could not be */
  used: string[];
  skipped: string[];
  /** input point of each output point */
  srcPoint: Int32Array;
}

export class DecimateError extends Error {}

/**
 * Parse "uv N:0.5 Cd=2" (names with optional weights, separated by spaces or commas) into steering attributes.
 * A name without a weight gets weight 1.
 */
export function parseSteerAttribs(spec: string): SteerAttrib[] {
  const out: SteerAttrib[] = [];
  for (const tok of String(spec ?? '').split(/[\s,]+/)) {
    if (!tok) continue;
    const m = /^([A-Za-z_][\w]*)(?:[:=]([-+]?[\d.eE+-]+))?$/.exec(tok);
    if (!m) throw new DecimateError(`attributes: cannot read "${tok}" (use names with optional weights, e.g. "uv N:0.5 Cd:2")`);
    const w = m[2] !== undefined ? Number(m[2]) : 1;
    if (!(w >= 0)) throw new DecimateError(`attributes: weight of "${m[1]}" must be >= 0`);
    out.push({ name: m[1], weight: w });
  }
  return out;
}

interface SteerCols { cls: 'point' | 'vertex'; data: Float64Array; size: number; weight: number; name: string }

function steerColumns(g: Geometry, attrs: SteerAttrib[], maxFloats: number) {
  const cols: SteerCols[] = [], used: string[] = [], skipped: string[] = [];
  let total = 0;
  for (const s of attrs) {
    const f = g.findAttrib(s.name, ['vertex', 'point']);
    if (!f || f.attr.type !== 'float' || f.attr.isArray || s.weight <= 0) { if (f || s.weight <= 0) skipped.push(s.name); continue; }
    if (total + f.attr.size > maxFloats) { skipped.push(s.name); continue; }
    cols.push({ cls: f.cls as 'point' | 'vertex', data: f.attr.data as Float64Array, size: f.attr.size, weight: s.weight, name: s.name });
    used.push(s.name);
    total += f.attr.size;
  }
  return { cols, total, used, skipped };
}

/**
 * Connected components of a triangle index list over `n` render vertices, or, with `toPoint`, over the points they map
 * to (`np` points).
 */
function islandCount(idx: Uint32Array, n: number, toPoint?: number[], np = 0): number {
  const m = toPoint ? np : n, parent = new Int32Array(m);
  for (let i = 0; i < m; i++) parent[i] = i;
  const find = (x: number) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const id = (r: number) => (toPoint ? toPoint[r] : r);
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(id(idx[t])), b = find(id(idx[t + 1])), c = find(id(idx[t + 2]));
    if (a !== b) parent[a] = b;
    const b2 = find(b);
    if (find(c) !== b2) parent[find(c)] = b2;
  }
  const used = new Uint8Array(m);
  for (let t = 0; t < idx.length; t++) used[id(idx[t])] = 1;
  let count = 0;
  for (let i = 0; i < m; i++) if (used[i] && find(i) === i) count++;
  return count;
}

/** Decimate the (selected) polygons of g to triangles with meshoptimizer; other prims pass through. */
export function decimateMesh(g: Geometry, o: DecimateOptions): DecimateResult {
  const sel = o.group;
  const { tris: tv, triPrim } = triangulate(g, sel);
  const vp = g.vertexPoint, np = g.numPoints;
  const keep: number[] = [];
  for (let t = 0; t < triPrim.length; t++) {
    const a = vp[tv[t * 3]], b = vp[tv[t * 3 + 1]], c = vp[tv[t * 3 + 2]];
    if (a !== b && b !== c && a !== c) keep.push(t);
  }
  const nt = keep.length;
  if (!nt) throw new DecimateError('no polygons to decimate (no triangles with three distinct points in the input or group)');
  // render vertices: (point, corner attribute values, prim region)
  const vAttrs = [...g.vertices.map.values()].filter((a) => !a.isArray);
  const regions = primRegions(g);
  const vprim = g.vertexPrims();
  const head = new Int32Array(np).fill(-1);
  const repV: number[] = [], rvPt: number[] = [], nextRV: number[] = [];
  const idx = new Uint32Array(nt * 3);
  for (let i = 0; i < nt; i++) {
    const t = keep[i];
    for (let k = 0; k < 3; k++) {
      const v = tv[t * 3 + k], p = vp[v], reg = regions ? regions[triPrim[t]] : 0;
      let r = head[p];
      while (r >= 0) {
        const u = repV[r];
        if ((!regions || regions[vprim[u]] === reg) && !vertexAttribsDiffer(vAttrs, u, v)) break;
        r = nextRV[r];
      }
      if (r < 0) {
        r = repV.length;
        repV.push(v); rvPt.push(p); nextRV.push(head[p]); head[p] = r;
      }
      idx[i * 3 + k] = r;
    }
  }
  const R = repV.length, P = g.P;
  const pos = new Float32Array(R * 3);
  for (let r = 0; r < R; r++) { const p = rvPt[r] * 3; pos[r * 3] = P[p]; pos[r * 3 + 1] = P[p + 1]; pos[r * 3 + 2] = P[p + 2]; }
  // locks: requested points, points shared with prims outside the group
  let lock: Uint8Array | null = null;
  const lockPt = new Uint8Array(np);
  let anyLock = false;
  if (o.lockPoints) for (let p = 0; p < np; p++) if (o.lockPoints[p]) { lockPt[p] = 1; anyLock = true; }
  if (sel) {
    for (let pr = 0; pr < g.numPrims; pr++) {
      if (sel[pr] && g.primClosed[pr]) continue;
      for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) { lockPt[vp[v]] = 1; anyLock = true; }
    }
  }
  if (anyLock) { lock = new Uint8Array(R); for (let r = 0; r < R; r++) lock[r] = lockPt[rvPt[r]]; }
  const target = Math.min(nt, o.targetCount > 0 ? Math.floor(o.targetCount) : Math.floor(nt * Math.max(0, Math.min(1, o.ratio)))) * 3;
  // meshoptimizer prunes components of the render-vertex mesh: where seams or hard normals split a connected piece
  // into islands, it would remove parts of surfaces (a sphere with hard normals vanished whole), so prune only when the
  // render vertices keep every piece in one island
  const prune = o.prune && islandCount(idx, R) === islandCount(idx, R, rvPt, np);
  const scale = MeshoptSimplifier.getScale(pos, 3) || 1;
  const steer = steerColumns(g, o.attributes, 32);
  let out: Uint32Array = idx, err = 0;
  if (target < nt * 3 || prune) {
    if (o.sloppy) {
      const relMax = o.errorAbsolute ? o.maxError / scale : o.maxError;
      [out, err] = MeshoptSimplifier.simplifySloppy(idx, pos, 3, lock, target, relMax);
      if (o.errorAbsolute) err *= scale;
    } else {
      const flags: SimplifierFlags[] = [];
      if (o.lockBorder) flags.push('LockBorder');
      if (prune) flags.push('Prune');
      if (o.sparse) flags.push('Sparse');
      if (o.errorAbsolute) flags.push('ErrorAbsolute');
      if (o.regularize) flags.push('Regularize');
      if (steer.total || lock) {
        const stride = Math.max(1, steer.total);
        const attr = new Float32Array(R * stride), weights: number[] = new Array(stride).fill(0);
        let off = 0;
        for (const c of steer.cols) {
          for (let k = 0; k < c.size; k++) weights[off + k] = c.weight;
          for (let r = 0; r < R; r++) {
            const e = (c.cls === 'vertex' ? repV[r] : rvPt[r]) * c.size;
            for (let k = 0; k < c.size; k++) attr[r * stride + off + k] = c.data[e + k];
          }
          off += c.size;
        }
        [out, err] = MeshoptSimplifier.simplifyWithAttributes(idx, pos, 3, attr, stride, weights, lock, target, o.maxError, flags);
      } else [out, err] = MeshoptSimplifier.simplify(idx, pos, 3, target, o.maxError, flags);
    }
  }
  const error = err, errorAbs = o.errorAbsolute ? err : err * scale;
  // meshoptimizer can leave a "flap" (two triangles on the same three points with opposite winding, seen where a
  // piece has coincident unwelded points): both go, which keeps a closed piece closed. Exact duplicates keep one.
  const nOut = out.length / 3, keepTri = new Uint8Array(nOut).fill(1), seenTri = new Map<string, number>();
  for (let i = 0; i < nOut; i++) {
    const a = rvPt[out[i * 3]], b = rvPt[out[i * 3 + 1]], c = rvPt[out[i * 3 + 2]];
    if (a === b || b === c || a === c) { keepTri[i] = 0; continue; }
    const key = a < b ? (b < c ? `${a},${b},${c}` : a < c ? `${a},${c},${b}` : `${c},${a},${b}`) : a < c ? `${b},${a},${c}` : b < c ? `${b},${c},${a}` : `${c},${b},${a}`;
    const j = seenTri.get(key);
    if (j === undefined) { seenTri.set(key, i); continue; }
    const d = rvPt[out[j * 3]], e = rvPt[out[j * 3 + 1]], f = rvPt[out[j * 3 + 2]];
    const sameWinding = (a === d && b === e) || (a === e && b === f) || (a === f && b === d);
    keepTri[i] = 0;
    if (!sameWinding) { keepTri[j] = 0; seenTri.delete(key); }
  }
  // prune by points where seams kept meshoptimizer from it: a piece (connected through its points) no larger than the
  // error the reduction reached goes, as meshoptimizer's prune does
  if (o.prune && !prune && !o.sloppy && target < nt * 3 && errorAbs > 0) {
    const parent = new Int32Array(np);
    for (let p = 0; p < np; p++) parent[p] = p;
    const find = (x: number) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let i = 0; i < nOut; i++) {
      if (!keepTri[i]) continue;
      const a = find(rvPt[out[i * 3]]), b = find(rvPt[out[i * 3 + 1]]), c = find(rvPt[out[i * 3 + 2]]);
      if (a !== b) parent[a] = b;
      const r = find(b);
      if (find(c) !== r) parent[find(c)] = r;
    }
    const box = new Map<number, number[]>();
    for (let i = 0; i < nOut * 3; i++) {
      if (!keepTri[(i / 3) | 0]) continue;
      const p = rvPt[out[i]], r = find(p), q = p * 3;
      const bb = box.get(r);
      if (!bb) box.set(r, [P[q], P[q + 1], P[q + 2], P[q], P[q + 1], P[q + 2]]);
      else for (let c = 0; c < 3; c++) { if (P[q + c] < bb[c]) bb[c] = P[q + c]; if (P[q + c] > bb[c + 3]) bb[c + 3] = P[q + c]; }
    }
    const small = new Set<number>();
    for (const [r, bb] of box) if (Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]) <= errorAbs) small.add(r);
    if (small.size && small.size < box.size) for (let i = 0; i < nOut; i++) if (keepTri[i] && small.has(find(rvPt[out[i * 3]]))) keepTri[i] = 0;
  }
  // rebuild: points in input order, passthrough prims, then the decimated triangles
  const used = new Uint8Array(np);
  for (let i = 0; i < out.length; i++) if (keepTri[(i / 3) | 0]) used[rvPt[out[i]]] = 1;
  const pass = (pr: number) => !(g.primClosed[pr] && g.primSize(pr) >= 3 && (!sel || sel[pr]));
  for (let pr = 0; pr < g.numPrims; pr++) if (pass(pr)) for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) used[vp[v]] = 1;
  const b = new GeoBuilder(g), map = new Int32Array(np).fill(-1);
  for (let p = 0; p < np; p++) if (used[p]) map[p] = b.copyPoint(p);
  for (let pr = 0; pr < g.numPrims; pr++) {
    if (!pass(pr)) continue;
    const pts: number[] = [], vs: number[] = [];
    for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) { pts.push(map[vp[v]]); vs.push(v); }
    b.addPrim(pts, !!g.primClosed[pr], pr, vs);
  }
  let trisOut = 0;
  for (let i = 0; i < out.length; i += 3) {
    if (!keepTri[i / 3]) continue;
    trisOut++;
    const r0 = out[i], r1 = out[i + 1], r2 = out[i + 2];
    const v0 = repV[r0], v1 = repV[r1], v2 = repV[r2];
    // the prim most corners came from (they share one prim region, so its prim attributes apply to the face)
    const p0 = vprim[v0], p1 = vprim[v1], p2 = vprim[v2];
    const prim = p1 === p2 ? p1 : p0;
    b.addPrim([map[rvPt[r0]], map[rvPt[r1]], map[rvPt[r2]]], true, prim, [v0, v1, v2]);
  }
  const geo = b.build(), srcPoint = new Int32Array(geo.numPoints);
  for (let p = 0; p < np; p++) if (map[p] >= 0) srcPoint[map[p]] = p;
  return { geo, error, errorAbs, trisIn: nt, trisOut, used: steer.used, skipped: steer.skipped, srcPoint };
}

/**
 * What keeps the polygons of g from reducing freely (decimateMesh keeps every discontinuity of a render vertex): per
 * cause, how many points hold one. Causes: a vertex attribute whose corners differ at a point ('uv seams', 'hard
 * normals (vertex N)', 'vertex <name>'), a string prim attribute or prim group that changes across it ('prim "<name>"
 * borders', 'group "<name>" borders') and 'open borders' (edges used by one polygon). Largest first.
 */
export function reductionLocks(g: Geometry): { cause: string; points: number }[] {
  const vp = g.vertexPoint, np = g.numPoints;
  const vAttrs = [...g.vertices.map].filter(([, a]) => !a.isArray);
  const strs = [...g.prims.map].filter(([, a]) => a.type === 'string' && !a.isArray);
  const grps = [...g.primGroups];
  const vprim = g.vertexPrims();
  // corners of every point (closed polygons only)
  const start = new Int32Array(np + 1);
  for (let pr = 0; pr < g.numPrims; pr++) if (g.primClosed[pr] && g.primSize(pr) >= 3) for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) start[vp[v] + 1]++;
  for (let p = 0; p < np; p++) start[p + 1] += start[p];
  const corners = new Int32Array(start[np]), fill = start.slice(0, np);
  for (let pr = 0; pr < g.numPrims; pr++) if (g.primClosed[pr] && g.primSize(pr) >= 3) for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) corners[fill[vp[v]]++] = v;
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (let p = 0; p < np; p++) {
    const s = start[p], e = start[p + 1];
    if (e - s < 2) continue;
    const v0 = corners[s], p0 = vprim[v0];
    for (const [n, a] of vAttrs) {
      for (let k = s + 1; k < e; k++) if (vertexAttribsDiffer([a], v0, corners[k])) { bump(n === 'uv' ? 'uv seams' : n === 'N' ? 'hard normals (vertex N)' : `vertex ${n}`); break; }
    }
    for (const [n, a] of strs) {
      const d = a.data as string[];
      for (let k = s + 1; k < e; k++) if (d[vprim[corners[k]]] !== d[p0]) { bump(`prim "${n}" borders`); break; }
    }
    for (const [n, m] of grps) {
      for (let k = s + 1; k < e; k++) if (m[vprim[corners[k]]] !== m[p0]) { bump(`group "${n}" borders`); break; }
    }
  }
  // open borders: edges used by one polygon
  const edges = new Map<string, number>();
  for (let pr = 0; pr < g.numPrims; pr++) {
    if (!g.primClosed[pr] || g.primSize(pr) < 3) continue;
    const s = g.primStart[pr], e = g.primStart[pr + 1];
    for (let v = s; v < e; v++) {
      const a = vp[v], b = vp[v + 1 < e ? v + 1 : s];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const borderPts = new Set<number>();
  for (const [k, n] of edges) if (n === 1) { const [a, b] = k.split(',').map(Number); borderPts.add(a); borderPts.add(b); }
  if (borderPts.size) counts.set('open borders', borderPts.size);
  return [...counts].map(([cause, points]) => ({ cause, points })).sort((a, b) => b.points - a.points || (a.cause < b.cause ? -1 : 1));
}

export interface PointDecimateOptions {
  ratio: number;
  targetCount: number;
  /** attributes whose first three float components (scaled by weight) count as the "colour" meshoptimizer keeps */
  attributes: SteerAttrib[];
}

/** Thin a point cloud with meshoptimizer's simplifyPoints; kept points keep all attributes. */
export function decimatePoints(g: Geometry, o: PointDecimateOptions): { geo: Geometry; kept: number; used: string[] } {
  const n = g.numPoints;
  if (!n) return { geo: g.clone(), kept: 0, used: [] };
  const target = Math.max(1, Math.min(n, o.targetCount > 0 ? Math.floor(o.targetCount) : Math.round(n * Math.max(0, Math.min(1, o.ratio)))));
  const pos = Float32Array.from(g.P);
  let colors: Float32Array | undefined;
  const used: string[] = [];
  const cols: { d: Float64Array; size: number; w: number }[] = [];
  let total = 0;
  for (const s of o.attributes) {
    const a = g.points.get(s.name);
    if (!a || a.type !== 'float' || a.isArray || total >= 3 || s.weight <= 0) continue;
    cols.push({ d: a.data as Float64Array, size: a.size, w: s.weight });
    used.push(s.name);
    total += a.size;
  }
  if (cols.length) {
    colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      let k = 0;
      for (const c of cols) for (let j = 0; j < c.size && k < 3; j++, k++) colors[i * 3 + k] = c.d[i * c.size + j] * c.w;
    }
  }
  const keepIdx = target >= n ? Uint32Array.from({ length: n }, (_, i) => i) : MeshoptSimplifier.simplifyPoints(pos, 3, target, colors, 3, colors ? 1 : 0);
  const keep = new Uint8Array(n);
  for (const i of keepIdx) keep[i] = 1;
  return { geo: g.subsetPoints(keep), kept: keepIdx.length, used };
}

export interface UVFolds {
  /** overlapping uv triangle pairs, and triangles wound against the rest of their chart (flipped) */
  pairs: number;
  flipped: number;
  /** per triangle of tris: in an overlapping pair or flipped */
  bad: Uint8Array;
  /** the largest overlapping pair (triangle ids), or null */
  largest: [number, number] | null;
  tris: Uint32Array;
  triPrim: Uint32Array;
  uv: Float64Array;
}

/**
 * Where the uv of g overlaps itself or flips: overlapping triangle pairs (exact, core/uvoverlap.ts) and triangles
 * whose uv winding is opposite to the majority of their chart (charts: triangles joined by uv-continuous edges, so a
 * mirrored island as a whole is not flipped). null without uv.
 */
export function uvFolds(g: Geometry): UVFolds | null {
  const uv = readUV(g);
  if (!uv) return null;
  const { tris, triPrim } = triangulate(g), nt = triPrim.length;
  const U = trianglesUV(uv, tris), { ok, signed } = uvTriangleAreas(U, nt);
  const root = chartRoots(g.vertexPoint, tris, U, nt), sum = new Map<number, number>();
  for (let t = 0; t < nt; t++) if (ok[t]) sum.set(root(t), (sum.get(root(t)) ?? 0) + Math.sign(signed[t]));
  const bad = new Uint8Array(nt), valid: number[] = [];
  let flipped = 0, pairs = 0, big = 0, largest: [number, number] | null = null;
  for (let t = 0; t < nt; t++) {
    if (!ok[t]) continue;
    valid.push(t);
    if (Math.sign(signed[t]) * (sum.get(root(t)) ?? 0) < 0) { bad[t] = 1; flipped++; }
  }
  uvOverlapPairs(U, valid, signed, (a, b, area) => { pairs++; bad[a] = 1; bad[b] = 1; if (area > big) { big = area; largest = [a, b]; } });
  return { pairs, flipped, bad, largest, tris, triPrim, uv };
}

export interface UVKept {
  /** the input uv had no overlaps, so the output was checked */
  checked: boolean;
  /** reduction steps taken, and steps dropped because they folded the uv even with the points around the folds locked */
  steps: number;
  dropped: number;
  /** decimations run, and points locked around folds */
  runs: number;
  locked: number;
  /** a plain (one-step) reduction of the input: its triangle count and its folds (null when it kept the uv clean) */
  plainTris: number;
  plainFolds: UVFolds | null;
  plainGeo: Geometry | null;
}

/** Steps a reduction that folds the uv is split into, and the lock rings tried (in turn) on a step that folds. */
const KEEP_UV_STEPS = 8;
const KEEP_UV_RINGS = [1, 1, 2, 2, 3, 4];

/** Points of g's prims around each point: CSR start / prim lists. */
function pointPrims(g: Geometry): { start: Int32Array; prims: Int32Array } {
  const np = g.numPoints, vp = g.vertexPoint, start = new Int32Array(np + 1);
  for (let v = 0; v < g.numVertices; v++) start[vp[v] + 1]++;
  for (let p = 0; p < np; p++) start[p + 1] += start[p];
  const fill = start.slice(0, np), prims = new Int32Array(g.numVertices), vprim = g.vertexPrims();
  for (let v = 0; v < g.numVertices; v++) prims[fill[vp[v]]++] = vprim[v];
  return { start, prims };
}

/**
 * Lock the points of `cur` that res removed within `rings` rings (through shared prims) of the input points of res's
 * folded triangles. Returns how many points were newly locked.
 */
function lockAroundFolds(cur: Geometry, res: DecimateResult, f: UVFolds, rings: number, lock: Uint8Array): number {
  const adj = pointPrims(cur), vp = cur.vertexPoint, seen = new Uint8Array(cur.numPoints);
  let front: number[] = [], added = 0;
  // only points the step removed are locked: a kept point did not make the fold, and locking it would only hold
  // the next run back
  const alive = new Uint8Array(cur.numPoints);
  for (let i = 0; i < res.srcPoint.length; i++) alive[res.srcPoint[i]] = 1;
  const take = (p: number) => { if (!lock[p] && !alive[p]) { lock[p] = 1; added++; } };
  for (let t = 0; t < f.bad.length; t++) {
    if (!f.bad[t]) continue;
    for (let k = 0; k < 3; k++) {
      const p = res.srcPoint[res.geo.vertexPoint[f.tris[t * 3 + k]]];
      if (!seen[p]) { seen[p] = 1; front.push(p); take(p); }
    }
  }
  for (let d = 1; d <= rings; d++) {
    const next: number[] = [];
    for (const p of front)
      for (let i = adj.start[p]; i < adj.start[p + 1]; i++) {
        const pr = adj.prims[i];
        for (let v = cur.primStart[pr]; v < cur.primStart[pr + 1]; v++) {
          const q = vp[v];
          if (seen[q]) continue;
          seen[q] = 1; next.push(q); take(q);
        }
      }
    front = next;
  }
  return added;
}

/**
 * How far a reduction of g strays from it: `to(m, srcOf)` is the largest distance (scene units) from a point of g's
 * polygons to the surface of m (srcOf: the g point of each m point), over the pieces of g (connected through shared
 * points) that kept a point in m; a piece pruned away whole is left out, as meshoptimizer's prune allows. `scale` is
 * meshoptimizer's mesh extent, the unit of relative errors.
 */
function deviationFrom(g: Geometry): { scale: number; to: (m: Geometry, srcOf: Int32Array) => number } {
  const np = g.numPoints, vp = g.vertexPoint, P = g.P, parent = new Int32Array(np), inPoly = new Uint8Array(np);
  for (let p = 0; p < np; p++) parent[p] = p;
  const find = (x: number) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let pr = 0; pr < g.numPrims; pr++) {
    if (!g.primClosed[pr] || g.primSize(pr) < 3) continue;
    for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) {
      inPoly[vp[v]] = 1;
      const a = find(vp[v]), b = find(vp[g.primStart[pr]]);
      if (a !== b) parent[a] = b;
    }
  }
  const pts: number[] = [];
  for (let p = 0; p < np; p++) if (inPoly[p]) pts.push(p);
  const pos = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { pos[i * 3] = P[p * 3]; pos[i * 3 + 1] = P[p * 3 + 1]; pos[i * 3 + 2] = P[p * 3 + 2]; });
  const scale = (pts.length ? MeshoptSimplifier.getScale(pos, 3) : 0) || 1;
  return {
    scale,
    to: (m, srcOf) => {
      const alive = new Uint8Array(np);
      for (let i = 0; i < srcOf.length; i++) alive[find(srcOf[i])] = 1;
      const bvh = new TriBVH(m), s = closestScratch();
      let worst = 0;
      for (const p of pts) if (alive[find(p)] && bvh.closestInto(P[p * 3], P[p * 3 + 1], P[p * 3 + 2], Infinity, s) >= 0 && s.d2 > worst) worst = s.d2;
      return Math.sqrt(worst);
    },
  };
}

/**
 * decimateMesh that keeps a clean uv atlas clean. meshoptimizer rejects flips in 3D only, and a kept corner keeps its
 * uv, so a collapse can fold the uv around it (most of all where the uv map bends: bevels, curved chart borders).
 * When the input uv has no overlaps and the plain decimation folds it (uvFolds), the reduction runs again in up to
 * KEEP_UV_STEPS steps, the triangle count falling by the same factor each step. A step that folds the uv runs again
 * with the points it removed around its folds locked, the rings growing (KEEP_UV_RINGS); a step that still folds is
 * dropped (its locks stay for the next try on the same mesh; a step taken starts the next one with only the caller's
 * locks, since the danger moves with the mesh). Every step taken is checked, so the result has no folds the input did
 * not have; the price is a triangle count above the target where the uv held the reduction (kept.plainTris says what
 * a plain reduction reached). keep false: the plain reduction, unchecked.
 */
export function decimateKeepUV(g: Geometry, o: DecimateOptions, keep = true): DecimateResult & { uv: UVKept } {
  const plain = decimateMesh(g, o);
  const kept: UVKept = { checked: false, steps: 1, dropped: 0, runs: 1, locked: 0, plainTris: plain.trisOut, plainFolds: null, plainGeo: null };
  const before = !keep || o.sloppy || o.group || plain.trisOut >= plain.trisIn ? null : uvFolds(g);
  if (!before || before.pairs > 0) return { ...plain, uv: kept };
  kept.checked = true;
  const clean = (f: UVFolds) => f.pairs === 0 && f.flipped <= before.flipped;
  const plainFolds = uvFolds(plain.geo)!;
  if (clean(plainFolds)) return { ...plain, uv: kept };
  kept.plainFolds = plainFolds; kept.plainGeo = plain.geo; kept.steps = 0;
  const target = Math.max(1, o.targetCount > 0 ? Math.floor(o.targetCount) : Math.floor(plain.trisIn * Math.max(0, Math.min(1, o.ratio))));
  const userLock = (srcPts: Int32Array) => Uint8Array.from(srcPts, (p) => (o.lockPoints && o.lockPoints[p] ? 1 : 0));
  let srcOf = Int32Array.from({ length: g.numPoints }, (_, i) => i), cur = g, curLock = userLock(srcOf);
  let curTris = plain.trisIn, err = 0, errAbs = 0, last: DecimateResult | null = null;
  // max_error holds for the whole reduction: each step may use all of it, and a step taken must keep every input point
  // within it of the output surface (measured, since step errors do not simply add up)
  const dev = deviationFrom(g), limit = o.errorAbsolute ? o.maxError : o.maxError * dev.scale;
  for (let step = 1; step <= KEEP_UV_STEPS && curTris > target; step++) {
    const left = KEEP_UV_STEPS - step + 1;
    const stepTarget = step === KEEP_UV_STEPS ? target : Math.max(target, Math.round(curTris * Math.pow(target / curTris, 1 / left)));
    const so: DecimateOptions = { ...o, ratio: 1, targetCount: stepTarget, group: null };
    const lock = curLock.slice();
    let res: DecimateResult | null = null;
    for (let attempt = 0; ; attempt++) {
      const r = decimateMesh(cur, { ...so, lockPoints: lock });
      kept.runs++;
      const f = uvFolds(r.geo)!;
      if (clean(f)) { res = r; break; }
      if (attempt >= KEEP_UV_RINGS.length) break;
      kept.locked += lockAroundFolds(cur, r, f, KEEP_UV_RINGS[attempt], lock);
    }
    if (!res) { kept.dropped++; curLock = lock; continue; }
    const nextSrc = Int32Array.from(res.srcPoint, (p) => srcOf[p]), d = dev.to(res.geo, nextSrc);
    if (d > limit * (1 + 1e-9)) break;
    // the step's output is the next step's input, with its input points and the caller's locks
    srcOf = nextSrc;
    curLock = userLock(srcOf);
    errAbs = d; err = d / dev.scale;
    const progress = res.trisOut < curTris;
    cur = res.geo; curTris = res.trisOut; last = res;
    kept.steps++;
    if (!progress) break;
  }
  // no step taken (each one folded the uv): the input, triangulated
  if (!last) {
    const none = decimateMesh(g, { ...o, ratio: 1, targetCount: 0, prune: false });
    kept.runs++;
    return { ...none, uv: kept };
  }
  return { ...last, error: err, errorAbs: errAbs, trisIn: plain.trisIn, srcPoint: srcOf, uv: kept };
}

/**
 * Where and why decimateKeepUV held the reduction back, in words (the parts a plain reduction folds and its largest
 * fold), or '' when it did not: the plain reduction kept the uv clean, or the steps reached about the same count.
 */
export function uvKeptText(r: DecimateResult & { uv: UVKept }): string {
  const k = r.uv, f = k.plainFolds, pg = k.plainGeo;
  if (!f || !pg || r.trisOut <= k.plainTris * 1.02 + 2) return '';
  const badPrims: number[] = [];
  let firstBad = -1;
  for (let t = 0; t < f.bad.length; t++) if (f.bad[t]) { badPrims.push(f.triPrim[t]); if (firstBad < 0) firstBad = t; }
  const parts = partsOf(pg, badPrims);
  const where = f.largest ? uvPairText(pg, f.uv, f.tris, f.triPrim, f.largest[0], f.largest[1]) : firstBad >= 0 ? primWhere(pg, f.triPrim[firstBad]) : '';
  const n = (x: number) => x.toLocaleString('en-US');
  return `a plain reduction to ${n(k.plainTris)} triangles folds the uv (${n(f.pairs)} overlapping triangle pairs, ${n(f.flipped)} flipped triangles${parts ? `; parts ${parts}` : ''}; largest: ${where}), ` +
    `so it went in ${k.steps} steps that keep the uv clean${k.dropped ? ` (${k.dropped} more folded and were dropped)` : ''}, to ${n(r.trisOut)} triangles`;
}
