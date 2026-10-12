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
  if (!nt) throw new DecimateError('decimate needs polygons (no triangles with three distinct points in the input or group)');
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
  const scale = MeshoptSimplifier.getScale(pos, 3) || 1;
  const steer = steerColumns(g, o.attributes, 32);
  let out: Uint32Array = idx, err = 0;
  if (target < nt * 3 || o.prune) {
    if (o.sloppy) {
      const relMax = o.errorAbsolute ? o.maxError / scale : o.maxError;
      [out, err] = MeshoptSimplifier.simplifySloppy(idx, pos, 3, lock, target, relMax);
      if (o.errorAbsolute) err *= scale;
    } else {
      const flags: SimplifierFlags[] = [];
      if (o.lockBorder) flags.push('LockBorder');
      if (o.prune) flags.push('Prune');
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
  // rebuild: points in input order, passthrough prims, then the decimated triangles
  const used = new Uint8Array(np);
  for (let i = 0; i < out.length; i++) used[rvPt[out[i]]] = 1;
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
  for (let i = 0; i < out.length; i += 3) {
    const r0 = out[i], r1 = out[i + 1], r2 = out[i + 2];
    const v0 = repV[r0], v1 = repV[r1], v2 = repV[r2];
    // the prim most corners came from (they share one prim region, so its prim attributes apply to the face)
    const p0 = vprim[v0], p1 = vprim[v1], p2 = vprim[v2];
    const prim = p1 === p2 ? p1 : p0;
    b.addPrim([map[rvPt[r0]], map[rvPt[r1]], map[rvPt[r2]]], true, prim, [v0, v1, v2]);
  }
  return { geo: b.build(), error, errorAbs, trisIn: nt, trisOut: out.length / 3, used: steer.used, skipped: steer.skipped };
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
