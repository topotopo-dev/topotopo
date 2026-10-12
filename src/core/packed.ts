// Packed primitives (instances): helpers around the Geometry fields primKind / packedSource / packedXform /
// packedSources (see the comment at the top of geometry.ts).
//
// A packed prim is one vertex on an anchor point plus a reference to a shared, immutable source geometry and a 3×3
// rotation·scale matrix: world = translate(P[anchor]) · packedXform · source. Instances cost one point, one prim and
// 9 numbers each, so a million trees stay cheap; nodes that need real polygons get them expanded (expandPacked):
//  - the engine expands inputs for nodes whose NodeDef.packed is 'unpack' (the default), with a warning;
//  - the unpack node, the renderer (with a triangle budget) and the exporters without native instancing expand too.
//
// Expansion rules (unpack node, auto-unpack, render, exports):
//  - instances follow the input prim order; prims and points that are not packed come first, unchanged;
//  - source attributes and groups are copied, then P, N (point/vertex/prim, renormalised), v/up/force/tangentu and
//    point orient are transformed like the transform node does (winding is not reversed for mirrored instances);
//  - anchor point / packed prim attributes listed in `transfer` are copied onto the instance's points / prims where
//    the source does not define them itself (Cd and Alpha: in any class) — a source's own colours win, the anchor's
//    colour tints sources without colour, as in Houdini's viewport;
//  - prim and point groups of the packed prim / anchor point extend over the unpacked prims / points;
//  - nested packed sources are expanded recursively; SDF volumes of sources are dropped (warned).
import { Attribute, AttribTable, Geometry, unifyDisplayAttribs } from './geometry.ts';
import { mergeMaterialTables, writeMaterials } from './materials.ts';
import { m4normalMatrix, qFromMat, qMul } from './math.ts';
import { resolveVertexNormals } from './topology.ts';
import type { Mat4, Quat } from './math.ts';

/**
 * Default triangle budget of the renderer: above it, an evenly spread subset of the instances is drawn. The software
 * rasteriser spends about 2 s on per-mesh analysis and 0.5 s per view for 1.5M triangles; 600k keeps a quad view of
 * any instance count under 3 s.
 */
export const RENDER_TRIANGLE_BUDGET = 600_000;

/** Anchor attributes the unpack node (and the engine's automatic unpack) copy onto instances by default. */
export const DEFAULT_TRANSFER = 'name Cd material piece';

/** Upper-left 3×3 of a 4×4 (both column-major) into out[o..o+9). */
export function xform3(m: Mat4, out: Float64Array = new Float64Array(9), o = 0): Float64Array {
  out[o] = m[0]; out[o + 1] = m[1]; out[o + 2] = m[2];
  out[o + 3] = m[4]; out[o + 4] = m[5]; out[o + 5] = m[6];
  out[o + 6] = m[8]; out[o + 7] = m[9]; out[o + 8] = m[10];
  return out;
}

/** X := A · X for one 9-number block (column-major 3×3), A given as 9 numbers. */
function mul3InPlace(A: ArrayLike<number>, X: Float64Array, o: number) {
  const x0 = X[o], x1 = X[o + 1], x2 = X[o + 2], x3 = X[o + 3], x4 = X[o + 4], x5 = X[o + 5], x6 = X[o + 6], x7 = X[o + 7], x8 = X[o + 8];
  for (let r = 0; r < 3; r++) {
    const a0 = A[r], a1 = A[3 + r], a2 = A[6 + r];
    X[o + r] = a0 * x0 + a1 * x1 + a2 * x2;
    X[o + 3 + r] = a0 * x3 + a1 * x4 + a2 * x5;
    X[o + 6 + r] = a0 * x6 + a1 * x7 + a2 * x8;
  }
}

/**
 * Compose the 3×3 part of m into the transform of packed prims (in place, on a geometry the caller owns): X := m₃ · X.
 * With ptMask, only prims whose anchor point is selected; prims in [from, to). Anchor positions are the caller's
 * business (they are ordinary points).
 */
export function composePackedXforms(g: Geometry, m: Mat4, ptMask: ArrayLike<number> | null = null, from = 0, to = g.numPrims) {
  const kind = g.primKind;
  if (!kind) return;
  const A = xform3(m), X = g.packedXform!;
  for (let p = from; p < to; p++) {
    if (!kind[p]) continue;
    if (ptMask && !ptMask[g.vertexPoint[g.primStart[p]]]) continue;
    mul3InPlace(A, X, p * 9);
  }
}

/**
 * A geometry of packed instances of one source: one anchor point + packed prim per matrix (4×4, column-major; the
 * translation becomes the anchor position, the 3×3 the instance transform). The source is shared, not copied.
 */
export function packedFromMatrices(src: Geometry, mats: ArrayLike<number>[]): Geometry {
  const n = mats.length;
  const g = new Geometry({ positions: new Float64Array(n * 3) });
  const P = g.P;
  g.primStart = Int32Array.from({ length: n + 1 }, (_, i) => i);
  g.vertexPoint = Int32Array.from({ length: n }, (_, i) => i);
  g.primClosed = new Uint8Array(n);
  g.vertices = new AttribTable(n);
  g.prims = new AttribTable(n);
  g.primKind = new Uint8Array(n).fill(1);
  g.packedSource = new Int32Array(n);
  g.packedXform = new Float64Array(n * 9);
  g.packedSources = n ? [src] : [];
  for (let i = 0; i < n; i++) {
    const m = mats[i];
    P[i * 3] = m[12]; P[i * 3 + 1] = m[13]; P[i * 3 + 2] = m[14];
    xform3(m as Mat4, g.packedXform, i * 9);
  }
  return n ? g : g.clearPacked();
}

/**
 * Remove prims (removed[p] = 1) and the points only they use; points that no prim used stay. Returns the subset
 * and the kept prim / point masks.
 */
function dropPrims(g: Geometry, removed: Uint8Array): { geo: Geometry; keepPrim: Uint8Array; keepPt: Uint8Array } {
  const np = g.numPoints, npr = g.numPrims;
  const usedKept = new Uint8Array(np), usedAny = new Uint8Array(np);
  for (let p = 0; p < npr; p++) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
    usedAny[g.vertexPoint[v]] = 1;
    if (!removed[p]) usedKept[g.vertexPoint[v]] = 1;
  }
  const keepPt = new Uint8Array(np);
  for (let i = 0; i < np; i++) keepPt[i] = usedKept[i] || !usedAny[i] ? 1 : 0;
  const keepPrim = removed.map((r) => (r ? 0 : 1));
  return { geo: g.subsetPrims(keepPrim, false).subsetPoints(keepPt), keepPrim, keepPt };
}

/** The part of g that is not instanced: packed prims and the anchor points only they use removed. */
export function stripPacked(g: Geometry): Geometry {
  if (!g.primKind) return g;
  return dropPrims(g, g.primKind.slice()).geo;
}

/** A packed source ready to be written or copied: nested instances expanded, SDF volumes dropped. */
export function flattenSource(src: Geometry): Geometry {
  return flatSource(src, new Set());
}

// ------------------------------------------------------------------ statistics

const triMemo = new WeakMap<Geometry, number>();

/** Triangles a geometry draws once every packed instance is expanded (closed polygons with n corners = n-2). */
export function expandedTriangles(g: Geometry): number {
  const m = triMemo.get(g);
  if (m !== undefined) return m;
  let t = 0;
  for (let p = 0; p < g.numPrims; p++) {
    if (g.primKind && g.primKind[p]) continue;
    if (g.primClosed[p]) { const n = g.primStart[p + 1] - g.primStart[p]; if (n >= 3) t += n - 2; }
  }
  if (g.primKind) {
    const per = g.packedSources.map(expandedTriangles);
    for (let p = 0; p < g.numPrims; p++) if (g.primKind[p]) t += per[g.packedSource![p]] ?? 0;
  }
  triMemo.set(g, t);
  return t;
}

/** Packed statistics for summaries: instance count, distinct sources, triangles once expanded (all of g). */
export function packedInfo(g: Geometry): { instances: number; sources: number; triangles: number } | null {
  if (!g.hasPacked()) return null;
  return { instances: g.numPacked, sources: g.packedSources.length, triangles: expandedTriangles(g) };
}

/** "1.2M", "30k", "512". */
export function kfmt(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** One-line description: "packed: 30,000 instances of 3 sources (1,234,567 triangles expanded)". */
export function packedSummaryLine(g: Geometry): string | null {
  const i = packedInfo(g);
  if (!i) return null;
  const n = (x: number) => x.toLocaleString('en-US');
  return `packed: ${n(i.instances)} instance${i.instances === 1 ? '' : 's'} of ${n(i.sources)} source${i.sources === 1 ? '' : 's'} (${n(i.triangles)} triangles expanded)`;
}

// ------------------------------------------------------------------ expansion

export interface ExpandOptions {
  /** expand only packed prims with group[p] set (the others stay packed); null/undefined = all */
  group?: ArrayLike<number> | null;
  /** expand at most this many instances (in prim order); the rest of the selection is removed. 0 = all */
  limit?: number;
  /** triangle budget: over it, an evenly spread subset of the selected instances is expanded and the rest removed */
  maxTriangles?: number;
  /** anchor point / packed prim attribute names or glob patterns copied onto unpacked points / prims (see top) */
  transfer?: string[] | string;
  /** prim int attribute receiving the packed prim number of each unpacked prim (-1 on other prims); "" = none */
  pieceAttrib?: string;
  /** also return primOrigin / pointOrigin */
  origins?: boolean;
  /** replace each (flattened) source before it is copied, e.g. to add shading normals once per source */
  prepare?: (src: Geometry) => Geometry;
}

export interface ExpandResult {
  geo: Geometry;
  /** selected packed prims */
  instances: number;
  /** instances actually expanded (fewer with limit or maxTriangles) */
  expanded: number;
  notes: string[];
  /** with origins: input prim of every output prim (the packed prim for unpacked prims) */
  primOrigin?: Int32Array;
  /** with origins: input point of every output point (the anchor for unpacked points) */
  pointOrigin?: Int32Array;
}

const flatMemo = new WeakMap<Geometry, Geometry>();

/** A source ready to be copied: nested instances expanded, volumes dropped. Memoised (sources are immutable). */
function flatSource(src: Geometry, notes: Set<string>): Geometry {
  let f = flatMemo.get(src);
  if (f) {
    if (src.volumes.length) notes.add('SDF volumes inside packed sources are not expanded');
    return f;
  }
  f = src.hasPacked() ? expandPacked(src).geo : src;
  if (f.volumes.length) {
    notes.add('SDF volumes inside packed sources are not expanded');
    f = f === src ? src.clone() : f;
    f.volumes = [];
  }
  flatMemo.set(src, f);
  return f;
}

function globList(t: string[] | string | undefined): (n: string) => boolean {
  const parts = (Array.isArray(t) ? t : String(t ?? '').split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);
  const re = (p: string) => new RegExp('^' + p.replace(/[.+$()|[\]\\{}^]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  const pos = parts.filter((p) => !p.startsWith('^')).map(re), neg = parts.filter((p) => p.startsWith('^')).map((p) => re(p.slice(1)));
  return (n) => pos.some((r) => r.test(n)) && !neg.some((r) => r.test(n));
}

const DISPLAY = new Set(['Cd', 'Alpha']);
const VEC_ATTRIBS = ['v', 'up', 'force', 'tangentu'];

/**
 * Expand packed prims into real geometry (see the rules at the top of this file). Geometry without packed prims is
 * returned as it is.
 */
export function expandPacked(g: Geometry, o: ExpandOptions = {}): ExpandResult {
  const notes: string[] = [];
  if (!g.primKind) {
    const r: ExpandResult = { geo: g, instances: 0, expanded: 0, notes };
    if (o.origins) { r.primOrigin = Int32Array.from({ length: g.numPrims }, (_, i) => i); r.pointOrigin = Int32Array.from({ length: g.numPoints }, (_, i) => i); }
    return r;
  }
  const kind = g.primKind, S = g.packedSource!, X = g.packedXform!, P = g.P;
  const np0 = g.numPoints, npr0 = g.numPrims;
  // instances selected, then limit and budget
  const sel: number[] = [];
  for (let p = 0; p < npr0; p++) if (kind[p] && (!o.group || o.group[p]) && g.primStart[p + 1] - g.primStart[p] === 1) sel.push(p);
  let drawn = sel;
  if (o.limit && o.limit > 0 && drawn.length > o.limit) {
    drawn = drawn.slice(0, o.limit);
    notes.push(`unpacked the first ${kfmt(drawn.length)} of ${kfmt(sel.length)} instances (limit)`);
  }
  const sources = g.packedSources;
  if (o.maxTriangles && o.maxTriangles > 0 && drawn.length) {
    const per = sources.map(expandedTriangles);
    let total = 0;
    for (const p of drawn) total += per[S[p]] ?? 0;
    if (total > o.maxTriangles) {
      const n = drawn.length, k = Math.max(1, Math.floor((n * o.maxTriangles) / total));
      const pick: number[] = [];
      for (let j = 0; j < k; j++) pick.push(drawn[Math.floor((j * n) / k)]);
      notes.push(`rendering ${kfmt(k)} of ${kfmt(n)} instances (${kfmt(total)} triangles over the ${kfmt(o.maxTriangles)} budget; an evenly spread subset is drawn)`);
      drawn = pick;
    }
  }
  // base: everything except the selected packed prims and the points only they use
  const removed = new Uint8Array(npr0);
  for (const p of sel) removed[p] = 1;
  const dropped = dropPrims(g, removed);
  let base = dropped.geo;
  const { keepPrim, keepPt } = dropped;
  // sources: flattened, display attribute classes unified with the base
  const noteSet = new Set<string>();
  const usedSrc: number[] = [];
  const seen = new Int32Array(sources.length).fill(-1);
  for (const p of drawn) if (seen[S[p]] < 0) { seen[S[p]] = usedSrc.length; usedSrc.push(S[p]); }
  const uni = unifyDisplayAttribs([base, ...usedSrc.map((s) => { const f = flatSource(sources[s], noteSet); return o.prepare ? o.prepare(f) : f; })]);
  base = uni[0];
  const flat: Geometry[] = new Array(sources.length);
  usedSrc.forEach((s, k) => { flat[s] = uni[k + 1]; });
  notes.push(...noteSet);
  const list = [base];
  for (const p of drawn) list.push(flat[S[p]]);
  const out = list.length === 1 ? base : Geometry.merge(list); // base is a fresh geometry (subsets copy)
  if (out.primKind) out.compactPackedSources();

  // transform each instance block
  const nb = base.numPoints, nvb = base.numVertices, nprb = base.numPrims;
  const tables = { point: out.points, vertex: out.vertices, prim: out.prims };
  const nAttrs = (['point', 'vertex', 'prim'] as const).map((c) => ({ c, a: tables[c].get('N') })).filter((x) => x.a && x.a.type === 'float' && x.a.size === 3);
  const vecAttrs: { c: 'point' | 'vertex' | 'prim'; a: Attribute }[] = [];
  for (const c of ['point', 'vertex', 'prim'] as const) for (const n of VEC_ATTRIBS) {
    const a = tables[c].get(n);
    if (a && a.type === 'float' && a.size === 3) vecAttrs.push({ c, a });
  }
  const orientA = out.points.get('orient');
  const orient = orientA && orientA.type === 'float' && orientA.size === 4 ? (orientA.data as Float64Array) : null;
  const OP = out.P;
  const m = new Float64Array(16);
  m[15] = 1;
  const offs = new Int32Array(drawn.length * 3 + 3);
  {
    let po = nb, vo = nvb, pro = nprb;
    for (let j = 0; j < drawn.length; j++) {
      offs[j * 3] = po; offs[j * 3 + 1] = vo; offs[j * 3 + 2] = pro;
      const f = flat[S[drawn[j]]];
      po += f.numPoints; vo += f.numVertices; pro += f.numPrims;
    }
    offs[drawn.length * 3] = po; offs[drawn.length * 3 + 1] = vo; offs[drawn.length * 3 + 2] = pro;
  }
  const range = (c: 'point' | 'vertex' | 'prim', j: number): [number, number] => {
    const k = c === 'point' ? 0 : c === 'vertex' ? 1 : 2;
    return [offs[j * 3 + k], offs[j * 3 + 3 + k]];
  };
  for (let j = 0; j < drawn.length; j++) {
    const p = drawn[j], xo = p * 9, a = g.vertexPoint[g.primStart[p]];
    m[0] = X[xo]; m[1] = X[xo + 1]; m[2] = X[xo + 2];
    m[4] = X[xo + 3]; m[5] = X[xo + 4]; m[6] = X[xo + 5];
    m[8] = X[xo + 6]; m[9] = X[xo + 7]; m[10] = X[xo + 8];
    const tx = P[a * 3], ty = P[a * 3 + 1], tz = P[a * 3 + 2];
    const [p0, p1] = range('point', j);
    for (let i = p0; i < p1; i++) {
      const x = OP[i * 3], y = OP[i * 3 + 1], z = OP[i * 3 + 2];
      OP[i * 3] = m[0] * x + m[4] * y + m[8] * z + tx;
      OP[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + ty;
      OP[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + tz;
    }
    if (nAttrs.length) {
      const nm = m4normalMatrix(m);
      for (const { c, a: A } of nAttrs) {
        const d = A!.data as Float64Array, [e0, e1] = range(c, j);
        for (let i = e0; i < e1; i++) {
          const x = d[i * 3], y = d[i * 3 + 1], z = d[i * 3 + 2];
          const nx = nm[0] * x + nm[4] * y + nm[8] * z, ny = nm[1] * x + nm[5] * y + nm[9] * z, nz = nm[2] * x + nm[6] * y + nm[10] * z;
          const l = Math.hypot(nx, ny, nz) || 1;
          d[i * 3] = nx / l; d[i * 3 + 1] = ny / l; d[i * 3 + 2] = nz / l;
        }
      }
    }
    for (const { c, a: A } of vecAttrs) {
      const d = A.data as Float64Array, [e0, e1] = range(c, j);
      for (let i = e0; i < e1; i++) {
        const x = d[i * 3], y = d[i * 3 + 1], z = d[i * 3 + 2];
        d[i * 3] = m[0] * x + m[4] * y + m[8] * z;
        d[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z;
        d[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z;
      }
    }
    if (orient) {
      const rot = new Float64Array(m);
      for (let c = 0; c < 3; c++) {
        const l = Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]) || 1;
        for (let r = 0; r < 3; r++) rot[c * 4 + r] = m[c * 4 + r] / l;
      }
      const q = qFromMat(rot);
      for (let i = p0; i < p1; i++) orient.set(qMul(q, [orient[i * 4], orient[i * 4 + 1], orient[i * 4 + 2], orient[i * 4 + 3]] as Quat), i * 4);
    }
  }

  // anchor attributes onto instances whose source lacks them
  if (o.transfer && drawn.length) {
    const want = globList(o.transfer);
    const names = new Set<string>();
    for (const n of g.points.names()) if (n !== 'P' && want(n)) names.add(n);
    for (const n of g.prims.names()) if (want(n)) names.add(n);
    for (const n of names) {
      const fromCls: 'point' | 'prim' = g.points.has(n) ? 'point' : 'prim';
      const src = g.table(fromCls).get(n)!;
      if (src.isArray) continue;
      const lacks = new Uint8Array(sources.length);
      for (const s of usedSrc) {
        const f = flat[s];
        lacks[s] = DISPLAY.has(n) ? (f.findAttrib(n) ? 0 : 1) : f.table(fromCls).has(n) ? 0 : 1;
      }
      if (!usedSrc.some((s) => lacks[s])) continue;
      // display attributes go where the output holds them (merge may have promoted them to vertices)
      let toCls: 'point' | 'vertex' | 'prim' = fromCls;
      if (DISPLAY.has(n)) {
        const f = out.findAttrib(n, ['vertex', 'point', 'prim']);
        if (f && f.cls !== 'detail') toCls = f.cls;
      }
      const t = tables[toCls];
      const dst = t.get(n) ?? t.add(n, src.type, src.size);
      for (let j = 0; j < drawn.length; j++) {
        const p = drawn[j];
        if (!lacks[S[p]]) continue;
        const v = src.get(fromCls === 'point' ? g.vertexPoint[g.primStart[p]] : p);
        const [e0, e1] = range(toCls, j);
        if (dst.type === 'string' || dst.isArray || typeof v === 'string') for (let i = e0; i < e1; i++) dst.set(i, v);
        else {
          const d = dst.data as Float64Array, s = dst.size, vals = Array.isArray(v) ? v : new Array(s).fill(v);
          for (let i = e0; i < e1; i++) for (let c = 0; c < s; c++) d[i * s + c] = c < vals.length ? Number(vals[c]) : 0;
        }
      }
    }
  }

  // packed prim number
  if (o.pieceAttrib) {
    const d = out.prims.add(o.pieceAttrib, 'int', 1).data as Int32Array;
    d.fill(-1, 0, nprb);
    for (let j = 0; j < drawn.length; j++) d.fill(drawn[j], offs[j * 3 + 2], offs[j * 3 + 5]);
  }

  // groups of the packed prim / anchor point extend over the instance
  for (const [name, mk] of g.primGroups) {
    const dm = out.primGroups.get(name);
    if (!dm) continue;
    for (let j = 0; j < drawn.length; j++) if (mk[drawn[j]]) dm.fill(1, offs[j * 3 + 2], offs[j * 3 + 5]);
  }
  for (const [name, mk] of g.pointGroups) {
    const dm = out.pointGroups.get(name);
    if (!dm) continue;
    for (let j = 0; j < drawn.length; j++) if (mk[g.vertexPoint[g.primStart[drawn[j]]]]) dm.fill(1, offs[j * 3], offs[j * 3 + 3]);
  }

  // material tables of the sources
  if (usedSrc.length) {
    const table = mergeMaterialTables([g, ...usedSrc.map((s) => flat[s])]);
    if (Object.keys(table).length) writeMaterials(out, table);
  }

  const r: ExpandResult = { geo: out, instances: sel.length, expanded: drawn.length, notes };
  if (o.origins) {
    const po = new Int32Array(out.numPrims), pt = new Int32Array(out.numPoints);
    let k = 0;
    for (let p = 0; p < npr0; p++) if (keepPrim[p]) po[k++] = p;
    k = 0;
    for (let i = 0; i < np0; i++) if (keepPt[i]) pt[k++] = i;
    for (let j = 0; j < drawn.length; j++) {
      po.fill(drawn[j], offs[j * 3 + 2], offs[j * 3 + 5]);
      pt.fill(g.vertexPoint[g.primStart[drawn[j]]], offs[j * 3], offs[j * 3 + 3]);
    }
    r.primOrigin = po;
    r.pointOrigin = pt;
  }
  return r;
}

const shadedMemo = new WeakMap<Geometry, Geometry>();

/**
 * A source with vertex N set to the renderer's shading normals (cusp 50°), computed once per source: the expansion
 * then only rotates them per instance instead of the renderer recomputing normals for every copy.
 */
function withShadingNormals(src: Geometry): Geometry {
  const vn = src.vertices.get('N');
  if (vn && vn.type === 'float' && vn.size === 3) return src;
  let s = shadedMemo.get(src);
  if (s) return s;
  s = src.clone();
  s.vertices.set('N', new Attribute('float', 3, resolveVertexNormals(src, 50)));
  shadedMemo.set(src, s);
  return s;
}

/**
 * The renderer's packed hook: expand instances within a triangle budget, carry anchor colours/materials (and the
 * colour-by attribute) onto them, write a "piece" prim attribute, and remap a highlight mask onto the result.
 * Options are passed through structurally so this core module does not depend on the renderer.
 */
export function expandForRender<T extends { colorBy?: string | null; highlight?: { cls: 'point' | 'prim'; mask: Uint8Array; label?: string } | null; title?: string }>(
  g: Geometry, o: T, maxTriangles = RENDER_TRIANGLE_BUDGET,
): { geo: Geometry; opts: T; notes: string[] } {
  const transfer = ['Cd', 'Alpha', 'material'];
  if (o.colorBy) transfer.push(o.colorBy.split('.')[0]);
  const r = expandPacked(g, { maxTriangles, transfer, pieceAttrib: g.prims.has('piece') ? '' : 'piece', origins: !!o.highlight, prepare: withShadingNormals });
  let opts = o;
  const h = o.highlight;
  if (h && r.primOrigin && r.pointOrigin) {
    const origin = h.cls === 'prim' ? r.primOrigin : r.pointOrigin;
    const mask = new Uint8Array(origin.length);
    for (let i = 0; i < origin.length; i++) mask[i] = h.mask[origin[i]] ?? 0;
    opts = { ...o, highlight: { ...h, mask } };
  }
  // the image says when only part of the instances is drawn
  if (r.expanded < r.instances) opts = { ...opts, title: `${o.title ? o.title + '  ' : ''}${kfmt(r.expanded)} of ${kfmt(r.instances)} instances` };
  const info = packedInfo(g);
  const notes = [...r.notes];
  if (info) notes.unshift(`${kfmt(info.instances)} packed instances of ${info.sources} source${info.sources === 1 ? '' : 's'} expanded for display`);
  return { geo: r.geo, opts, notes };
}
