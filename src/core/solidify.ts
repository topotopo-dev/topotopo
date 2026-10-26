// Solidify (shell): a constant-thickness solid from a consistently wound polygon surface (a sheet, a folded panel, a
// closed hull).
//
// Offsets follow the face winding: the face normal n points to the "outside". offset +1 grows the wall outward (the
// input becomes the inner surface), -1 inward (the input stays the outer surface), 0 centres it. The two surfaces sit
// at signed distances d_out = (1 + offset)/2 · thickness and d_in = -(1 - offset)/2 · thickness.
//
// Each point moves by d · δ, where δ solves n_f · δ = 1 for every face f around the point: the offset planes of the
// incident faces meet there, so every face of a surface copy is exactly d away from its source face. δ is the
// minimum-length least-squares solution (pseudo-inverse of the stacked normals, from a deterministic Jacobi eigen
// decomposition): at a boundary point with one face it is that face's normal; along a fold it is the mitre of the two
// planes; at a corner of three or more planes their intersection. Where the planes do not meet (a saddle, a twisted
// corner) the least-squares residual is what thickness the faces lose; above RESIDUAL_LIMIT of the offset the node
// stops instead of silently thinning the wall, as it does when |δ| exceeds miter_limit (a fold so sharp the mitre runs
// away).
//
// Topology: an outer copy (input winding), an inner copy (reversed) and, with fill_rim, one quad per boundary edge
// joining them, oriented outward: a closed manifold for an open sheet, two nested closed surfaces for a closed one.
// Groups inner / outer / rim. Attributes come through GeoBuilder provenance (N and tangent are dropped: they would
// point the wrong way on the inner copy; recompute them downstream). Surface uvs are copied; rim uvs are metric: u =
// distance along the boundary loop, v = 0 on the inner surface to thickness on the outer.
//
// Rejected with a diagnostic, never repaired: open polylines, non-manifold edges or points, inconsistent winding,
// collapsed faces, and results that fold over (a face of a surface copy flips) or intersect themselves (strict check:
// crossings, coplanar overlaps and contacts beyond the shared vertices and edges). If the intersection check runs out
// of its budget the node fails rather than passing unchecked geometry.
import { GeoBuilder } from './geometry.ts';
import type { Geometry } from './geometry.ts';
import { buildEdges, primNewell } from './topology.ts';
import { halfEdges } from './halfedge.ts';
import { selfIntersections } from './analysis.ts';

export interface SolidifyOptions {
  thickness: number;
  /** -1 inside … 0 centred … +1 outside, relative to the face winding */
  offset: number;
  fillRim: boolean;
  /** largest allowed |δ| (offset distance / face distance) */
  miterLimit: number;
  /** strict self-intersection pair tests (default 4,000,000) */
  maxTests?: number;
}

export interface SolidifyResult {
  geo: Geometry;
  stats: { outer: number; inner: number; rim: number; maxMiter: number; maxResidual: number; tested: number };
}

/** A rejected input or result: message says what and where, hint what to do. */
export class SolidifyError extends Error {
  hint: string;
  constructor(message: string, hint: string) { super(message); this.hint = hint; }
}

/** Largest allowed least-squares residual, as a fraction of the offset distance. */
export const RESIDUAL_LIMIT = 0.02;

const list = (a: (number | string)[], n = 8) => a.slice(0, n).join(', ') + (a.length > n ? `, … (${a.length})` : '');

/** Eigen decomposition of a symmetric 3×3 (row-major) by cyclic Jacobi: values w, vectors as columns of V. */
function jacobi3(A: number[]): { w: number[]; V: number[] } {
  const a = A.slice(), V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
    if (off < 1e-30 * (a[0] * a[0] + a[4] * a[4] + a[8] * a[8] + 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (apq === 0) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq; a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk; a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k * 3 + p], vkq = V[k * 3 + q];
        V[k * 3 + p] = c * vkp - s * vkq; V[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return { w: [a[0], a[4], a[8]], V };
}

/**
 * Minimum-length least-squares δ with n_f · δ = 1 for the unit normals N (3 per face): δ = (NᵀN)⁺ Nᵀ 1, dropping
 * eigen-directions below 1e-9 of the largest (the free directions of an underconstrained point).
 */
export function offsetDirection(N: number[]): { d: number[]; residual: number } {
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0], b = [0, 0, 0];
  const k = N.length / 3;
  for (let f = 0; f < k; f++) {
    const x = N[f * 3], y = N[f * 3 + 1], z = N[f * 3 + 2];
    M[0] += x * x; M[1] += x * y; M[2] += x * z; M[4] += y * y; M[5] += y * z; M[8] += z * z;
    b[0] += x; b[1] += y; b[2] += z;
  }
  M[3] = M[1]; M[6] = M[2]; M[7] = M[5];
  const { w, V } = jacobi3(M);
  const wmax = Math.max(w[0], w[1], w[2]);
  const d = [0, 0, 0];
  for (let e = 0; e < 3; e++) {
    if (!(w[e] > 1e-9 * wmax)) continue;
    const vx = V[e], vy = V[3 + e], vz = V[6 + e];
    const s = (vx * b[0] + vy * b[1] + vz * b[2]) / w[e];
    d[0] += vx * s; d[1] += vy * s; d[2] += vz * s;
  }
  let residual = 0;
  for (let f = 0; f < k; f++) residual = Math.max(residual, Math.abs(N[f * 3] * d[0] + N[f * 3 + 1] * d[1] + N[f * 3 + 2] * d[2] - 1));
  return { d, residual };
}

export function solidify(g: Geometry, o: SolidifyOptions): SolidifyResult {
  const t = o.thickness, off = o.offset;
  if (!(t > 0) || !Number.isFinite(t)) throw new SolidifyError(`solidify: thickness must be a positive number of metres (got ${t})`, 'e.g. 0.01 for 1 cm');
  if (!(off >= -1 && off <= 1)) throw new SolidifyError(`solidify: offset must be between -1 (inside) and +1 (outside) (got ${off})`, '0 centres the wall on the surface');
  if (!(o.miterLimit >= 1)) throw new SolidifyError(`solidify: miter_limit must be at least 1 (got ${o.miterLimit})`, 'the default 4 allows folds up to about 150°');
  const np = g.numPoints, npr = g.numPrims, P = g.P, vp = g.vertexPoint;
  // ---- input checks
  const open: number[] = [], polys: number[] = [];
  for (let p = 0; p < npr; p++) {
    if (g.primKind && g.primKind[p]) { open.push(p); continue; }
    if (!g.primClosed[p]) open.push(p); else polys.push(p);
  }
  if (open.length) throw new SolidifyError(`solidify: ${open.length} prim(s) are not polygons (prims ${list(open)})`, 'solidify works on a polygon surface; delete polylines/points/packed prims upstream (delete, or blast by group)');
  if (!polys.length) throw new SolidifyError('solidify: the input has no polygons', 'connect a polygon surface (grid, a selected part of a mesh)');
  const fn = new Float64Array(npr * 3), collapsed: number[] = [], nrm = [0, 0, 0];
  for (const p of polys) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    let e2 = 0;
    for (let v = s; v < e; v++) {
      const a = vp[v] * 3, b = vp[v + 1 < e ? v + 1 : s] * 3;
      e2 = Math.max(e2, (P[b] - P[a]) ** 2 + (P[b + 1] - P[a + 1]) ** 2 + (P[b + 2] - P[a + 2]) ** 2);
    }
    primNewell(g, p, nrm);
    const l = Math.hypot(nrm[0], nrm[1], nrm[2]);
    if (e - s < 3 || !(l > 1e-9 * e2)) { collapsed.push(p); continue; }
    fn[p * 3] = nrm[0] / l; fn[p * 3 + 1] = nrm[1] / l; fn[p * 3 + 2] = nrm[2] / l;
  }
  if (collapsed.length) throw new SolidifyError(`solidify: ${collapsed.length} collapsed polygon(s) without a usable normal (prims ${list(collapsed)})`, 'remove them first (clean / mesh_repair with degenerate removal, or fuse points)');
  const E = buildEdges(g);
  const nonManifold: string[] = [];
  for (let e = 0; e < E.a.length; e++) if (E.count[e] > 2) nonManifold.push(`${E.a[e]}-${E.b[e]}`);
  if (nonManifold.length) throw new SolidifyError(`solidify: ${nonManifold.length} non-manifold edge(s) shared by more than two polygons (points ${list(nonManifold)})`, 'select one sheet upstream (split or delete the extra faces)');
  const he = halfEdges(g);
  if (he.flippedEdges.size) {
    const bad = [...he.flippedEdges].slice(0, 8).map((e) => `${he.edgeA[e]}-${he.edgeB[e]}`);
    throw new SolidifyError(`solidify: inconsistent winding: ${he.flippedEdges.size} edge(s) where neighbouring polygons run the same way (points ${list(bad)})`, 'make the winding consistent first (reverse part of the mesh, or clean fix_winding); the winding decides which side is outside');
  }
  // incident faces per point; a point's faces must form one fan (else two sheets touch at a point)
  const inc: number[][] = Array.from({ length: np }, () => []);
  for (const p of polys) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) inc[vp[v]].push(p);
  const edgeKey = (a: number, b: number) => (a < b ? a * np + b : b * np + a);
  const edgePrims = new Map<number, number[]>();
  for (const p of polys) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s; v < e; v++) {
      const k = edgeKey(vp[v], vp[v + 1 < e ? v + 1 : s]);
      const l = edgePrims.get(k);
      if (l) l.push(p); else edgePrims.set(k, [p]);
    }
  }
  const bowtie: number[] = [];
  for (let i = 0; i < np; i++) {
    const F = [...new Set(inc[i])];
    if (F.length < 2) continue;
    const idx = new Map(F.map((f, k) => [f, k])), par = F.map((_, k) => k);
    const find = (x: number): number => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
    for (const f of F) {
      const s = g.primStart[f], e = g.primStart[f + 1];
      for (let v = s; v < e; v++) {
        const a = vp[v], b = vp[v + 1 < e ? v + 1 : s];
        if (a !== i && b !== i) continue;
        for (const h of edgePrims.get(edgeKey(a, b)) ?? []) if (h !== f) { const x = find(idx.get(f)!), y = find(idx.get(h)!); if (x !== y) par[x] = y; }
      }
    }
    if (new Set(F.map((_, k) => find(k))).size > 1) bowtie.push(i);
  }
  if (bowtie.length) throw new SolidifyError(`solidify: ${bowtie.length} non-manifold point(s) where separate fans of polygons touch (points ${list(bowtie)})`, 'split the sheets at those points (fuse off / polysplit) or remove one of the touching parts');

  // ---- offset directions
  const dOut = ((1 + off) / 2) * t, dIn = -((1 - off) / 2) * t;
  const delta = new Float64Array(np * 3), used = new Uint8Array(np);
  let maxMiter = 0, maxResidual = 0;
  const miterBad: string[] = [], residualBad: string[] = [];
  for (let i = 0; i < np; i++) {
    const F = [...new Set(inc[i])];
    if (!F.length) continue;
    used[i] = 1;
    const N: number[] = [];
    for (const f of F) N.push(fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]);
    const { d, residual } = offsetDirection(N);
    const len = Math.hypot(d[0], d[1], d[2]);
    maxMiter = Math.max(maxMiter, len); maxResidual = Math.max(maxResidual, residual);
    if (len > o.miterLimit) miterBad.push(`${i} (×${len.toFixed(2)})`);
    if (residual > RESIDUAL_LIMIT) residualBad.push(`${i} (${(residual * 100).toFixed(1)}%)`);
    delta[i * 3] = d[0]; delta[i * 3 + 1] = d[1]; delta[i * 3 + 2] = d[2];
  }
  if (miterBad.length) throw new SolidifyError(`solidify: ${miterBad.length} point(s) need an offset longer than miter_limit ${o.miterLimit} × the thickness (points ${list(miterBad)}): the fold is too sharp for a mitred wall`, 'bevel or round the fold first, lower the thickness, or raise miter_limit if the long mitre is intended');
  if (residualBad.length) throw new SolidifyError(`solidify: at ${residualBad.length} point(s) the offset planes of the surrounding faces do not meet (thickness lost: points ${list(residualBad)}; limit ${RESIDUAL_LIMIT * 100}%)`, 'the surface is twisted or saddle-shaped there: subdivide or flatten it, or use a thinner wall');

  // ---- build
  const b = new GeoBuilder(g);
  for (const k of ['N', 'tangent']) { b.skip.point.add(k); b.skip.vertex.add(k); b.skip.prim.add(k); }
  const uvF = g.findAttrib('uv', ['vertex', 'point']);
  const uvOn = !!uvF && uvF.attr.type === 'float' && !uvF.attr.isArray;
  const uvA = uvOn ? b.attrib('vertex', 'uv', 3) : null;
  if (uvOn) { b.skip.vertex.add('uv'); b.skip.point.add('uv'); }
  const uvOf = (v: number): number[] => {
    const a = uvF!.attr, i = uvF!.cls === 'vertex' ? v : vp[v], s = a.size, d = a.data as Float64Array;
    return [d[i * s], s > 1 ? d[i * s + 1] : 0, s > 2 ? d[i * s + 2] : 0];
  };
  for (let i = 0; i < np; i++) if (!used[i]) b.copyPoint(i); // loose points pass through
  const outerPt = new Int32Array(np).fill(-1), innerPt = new Int32Array(np).fill(-1);
  for (let i = 0; i < np; i++) {
    if (!used[i]) continue;
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], dx = delta[i * 3], dy = delta[i * 3 + 1], dz = delta[i * 3 + 2];
    outerPt[i] = b.addPoint(x + dx * dOut, y + dy * dOut, z + dz * dOut, i);
    innerPt[i] = b.addPoint(x + dx * dIn, y + dy * dIn, z + dz * dIn, i);
  }
  const gOuter = b.group('prim', 'outer'), gInner = b.group('prim', 'inner'), gRim = b.group('prim', 'rim');
  let vOut = 0;
  for (const p of polys) {
    const s = g.primStart[p], e = g.primStart[p + 1], vs: number[] = [];
    for (let v = s; v < e; v++) vs.push(v);
    gOuter.add(b.addPrim(vs.map((v) => outerPt[vp[v]]), true, p, vs));
    if (uvA) for (const v of vs) uvA.set(vOut++, uvOf(v));
  }
  for (const p of polys) {
    const s = g.primStart[p], e = g.primStart[p + 1], vs: number[] = [s];
    for (let v = e - 1; v > s; v--) vs.push(v);
    gInner.add(b.addPrim(vs.map((v) => innerPt[vp[v]]), true, p, vs));
    if (uvA) for (const v of vs) uvA.set(vOut++, uvOf(v));
  }
  let rims = 0;
  if (o.fillRim) {
    // boundary half-edges (a → b in face winding), chained into loops for the rim's u coordinate
    const bnd: { a: number; b: number; va: number; vb: number; p: number }[] = [];
    for (const p of polys) {
      const s = g.primStart[p], e = g.primStart[p + 1];
      for (let v = s; v < e; v++) {
        const w = v + 1 < e ? v + 1 : s;
        if ((edgePrims.get(edgeKey(vp[v], vp[w]))?.length ?? 0) === 1) bnd.push({ a: vp[v], b: vp[w], va: v, vb: w, p });
      }
    }
    const fromPt = new Map<number, number>();
    bnd.forEach((h, k) => fromPt.set(h.a, k));
    const seen = new Uint8Array(bnd.length), u0 = new Float64Array(bnd.length);
    for (let k0 = 0; k0 < bnd.length; k0++) {
      if (seen[k0]) continue;
      let s = 0;
      for (let k = k0; k !== undefined && !seen[k]; k = fromPt.get(bnd[k].b)!) {
        seen[k] = 1; u0[k] = s;
        const a = bnd[k].a * 3, c = bnd[k].b * 3;
        s += Math.hypot(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]);
      }
    }
    bnd.forEach((h, k) => {
      gRim.add(b.addPrim([outerPt[h.a], innerPt[h.a], innerPt[h.b], outerPt[h.b]], true, h.p, [h.va, h.va, h.vb, h.vb]));
      if (uvA) {
        const a = h.a * 3, c = h.b * 3, u1 = u0[k] + Math.hypot(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]);
        uvA.set(vOut++, [u0[k], t, 0]); uvA.set(vOut++, [u0[k], 0, 0]); uvA.set(vOut++, [u1, 0, 0]); uvA.set(vOut++, [u1, t, 0]);
      }
      rims++;
    });
  }
  const out = b.build();

  // ---- result checks: no face of a surface copy flips, no self-intersection
  const flipped: number[] = [];
  const n2 = [0, 0, 0];
  for (let q = 0; q < out.numPrims; q++) {
    const src = q < polys.length ? polys[q] : q < 2 * polys.length ? polys[q - polys.length] : -1;
    if (src < 0) break;
    primNewell(out, q, n2);
    const sgn = q < polys.length ? 1 : -1;
    if (!((n2[0] * fn[src * 3] + n2[1] * fn[src * 3 + 1] + n2[2] * fn[src * 3 + 2]) * sgn > 0)) flipped.push(src);
  }
  if (flipped.length) throw new SolidifyError(`solidify: the ${flipped.length} offset cop${flipped.length === 1 ? 'y' : 'ies'} of polygon(s) ${list([...new Set(flipped)])} turn inside out: the wall is thicker than the surface's local radius of curvature`, 'lower the thickness, move the offset towards the convex side, or subdivide less tightly curved');
  const si = selfIntersections(out, o.maxTests ?? 4_000_000, { strict: true });
  if (si.capped) throw new SolidifyError(`solidify: the self-intersection check ran out of its budget after ${si.tested.toLocaleString('en-US')} triangle pairs before finishing; the result was not verified`, 'reduce the polygon count (decimate / fewer divisions) or solidify parts separately and merge them');
  if (si.pairs) {
    const prims: number[] = [];
    for (let q = 0; q < out.numPrims && prims.length < 8; q++) if (si.prims[q]) prims.push(q);
    const where = prims.map((q) => `${q} (${q < polys.length ? 'outer' : q < 2 * polys.length ? 'inner' : 'rim'})`);
    throw new SolidifyError(`solidify: the shell intersects itself: ${si.pairs} triangle pair(s) cross, overlap or touch beyond their shared edges (result prims ${where.join(', ')}${si.pairs > 8 ? ', …' : ''})`, 'the wall is too thick for the clearance between parts of the surface: lower the thickness or change offset');
  }
  return { geo: out, stats: { outer: polys.length, inner: polys.length, rim: rims, maxMiter, maxResidual, tested: si.tested } };
}
