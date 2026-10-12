// Polygon modelling / topology nodes.
import { AttribTable, Attribute, GeoBuilder, Geometry, cloneVolumes } from '../core/geometry.ts';
import type { Src } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import {
  boundaryLoops, buildEdges, connectivity, orientOutward, refreshNormals, primArea, primCentroid, primNewell, primNormals, reversePrims, topologyReport, triangulate,
} from '../core/topology.ts';
import { M, fromManifold, propLayout } from '../core/manifold.ts';
import { EdgeSet, edgeFromKey, edgeKey, forEachPrimEdge } from '../core/edges.ts';
import { P, edgeMask, mask } from './util.ts';
import { fusePoints, removeDegenerate } from './transform.ts';
import { makeBox } from './generate.ts';
import type { Vec3 } from '../core/math.ts';

defineNode({
  type: 'fuse',
  category: 'topology',
  summary: 'Weld points closer than a distance; collapsed prims are removed.',
  aliases: ['weld', 'merge_points'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    distance: { type: 'float', default: 1e-4, min: 0, desc: 'snap distance', aliases: ['dist', 'tolerance'] },
    average: { type: 'bool', default: false, desc: 'move fused points to their average position (default keeps the first)' },
    group: P.group('point'),
  },
  cook: ({ input, p }) => {
    const g = input(0);
    const sel = mask(g, 'point', p.group);
    return fusePoints(g, p.distance, sel ? (i) => !!sel[i] : undefined, p.average);
  },
});

defineNode({
  type: 'clean',
  category: 'topology',
  summary: 'Tidy geometry: weld duplicates, drop degenerate/zero-area prims and unused points, optionally fix winding.',
  description: 'For holes, non-manifold edges, inconsistent winding and self-intersections use mesh_repair.',
  aliases: ['cleanup'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    fuse_distance: { type: 'float', default: 0, min: 0, desc: 'weld points within this distance first (0 = off)' },
    remove_degenerate: { type: 'bool', default: true, desc: 'remove prims with repeated/too few points' },
    min_area: { type: 'float', default: 1e-12, min: 0, desc: 'remove polygons with smaller area (0 = keep)' },
    remove_unused_points: { type: 'bool', default: true, desc: 'remove points not used by prims (only when the geometry has prims)' },
    fix_winding: { type: 'bool', default: false, desc: 'make closed meshes face outward' },
  },
  cook: ({ input, p }) => {
    let g = input(0);
    if (p.fuse_distance > 0) g = fusePoints(g, p.fuse_distance);
    if (p.remove_degenerate) g = removeDegenerate(g);
    if (p.min_area > 0) {
      const keep = Uint8Array.from({ length: g.numPrims }, (_, pr) => (!g.primClosed[pr] || primArea(g, pr) >= p.min_area ? 1 : 0));
      g = g.subsetPrims(keep, false);
    }
    if (p.remove_unused_points && g.numPrims > 0) g = g.removeUnusedPoints();
    if (p.fix_winding) g = orientOutward(g);
    return g === input(0) ? g.clone() : g;
  },
});

defineNode({
  type: 'reverse',
  category: 'topology',
  summary: 'Flip polygon winding (normals).',
  aliases: ['flip', 'flip_normals'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: { group: P.group('prim') },
  cook: ({ input, p }) => {
    const g = input(0);
    return reversePrims(g, mask(g, 'prim', p.group));
  },
});

defineNode({
  type: 'facet',
  category: 'topology',
  summary: 'Unique points per prim (hard, faceted look; pieces fall apart) or consolidate shared points.',
  aliases: ['unique_points', 'split_points'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    mode: { type: 'enum', options: ['unique', 'consolidate'], default: 'unique', desc: 'unique = every prim gets its own points; consolidate = fuse identical positions' },
  },
  cook: ({ input, p }) => {
    const g = input(0);
    if (p.mode === 'consolidate') return fusePoints(g, 1e-9);
    const b = new GeoBuilder(g);
    for (let pr = 0; pr < g.numPrims; pr++) {
      const ids: number[] = [], vs: number[] = [];
      for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) { ids.push(b.copyPoint(g.vertexPoint[v])); vs.push(v); }
      b.addPrim(ids, !!g.primClosed[pr], pr, vs);
    }
    return b.build();
  },
});

defineNode({
  type: 'triangulate',
  category: 'topology',
  summary: 'Split polygons into triangles (ear clipping for concave n-gons).',
  aliases: ['divide', 'triangles'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: { group: P.group('prim') },
  cook: ({ input, p }) => {
    const g = input(0);
    const sel = mask(g, 'prim', p.group);
    const { tris, triPrim } = triangulate(g, sel);
    const b = new GeoBuilder(g);
    for (let i = 0; i < g.numPoints; i++) b.copyPoint(i);
    let t = 0;
    for (let pr = 0; pr < g.numPrims; pr++) {
      if (g.primClosed[pr] && (!sel || sel[pr]) && g.primSize(pr) > 3) {
        while (t < triPrim.length && triPrim[t] < pr) t++;
        while (t < triPrim.length && triPrim[t] === pr) {
          const vs = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
          b.addPrim(vs.map((v) => g.vertexPoint[v]), true, pr, vs);
          t++;
        }
      } else {
        const vs: number[] = [];
        for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) vs.push(v);
        b.addPrim(vs.map((v) => g.vertexPoint[v]), !!g.primClosed[pr], pr, vs);
      }
    }
    return b.build();
  },
});

/** One level of Catmull–Clark (or linear) subdivision with full attribute interpolation. */
export function subdivideOnce(g: Geometry, smooth: boolean, boundaryMode: 'smooth' | 'sharp'): Geometry {
  return subdivideLevel(g, smooth, boundaryMode, null).geo;
}

/**
 * One subdivision level with semi-sharp creases (DeRose, Kass, Truong 1998).
 * `sharp` maps edgeKey(a, b) of g to a crease sharpness s > 0 (only edges shared by exactly two
 * polygons count; boundaries already follow the `boundaryMode` rule):
 *  - edge point: s >= 1 → midpoint (sharp rule); 0 < s < 1 → blend s·sharp + (1 - s)·smooth.
 *  - vertex point, by the number k of incident crease edges and their mean sharpness σ (clamped to 1):
 *    k < 2 → smooth rule (a single crease is a dart); k = 2 → crease rule 3/4·v + 1/8·(a + b) along the
 *    crease; k >= 3 → corner (v stays). The sharp rule is blended with the smooth one by σ.
 *  - boundary points with interior creases become corners (boundary edges act as infinitely sharp
 *    creases), blended by σ with the regular boundary rule.
 * Child edges of a crease edge carry s - 1 (dropped at 0); the returned map uses the output's point
 * numbers. Edge groups of g propagate to the child edges (and to polyline segments).
 */
export function subdivideLevel(g: Geometry, smooth: boolean, boundaryMode: 'smooth' | 'sharp', sharp: Map<number, number> | null): { geo: Geometry; sharp: Map<number, number> } {
  return subdivideLevelFast(g, smooth, boundaryMode, sharp) ?? subdivideLevelBuilder(g, smooth, boundaryMode, sharp);
}

/** subdivideLevel through GeoBuilder: the reference implementation, used for inputs the typed-array path does not take. */
function subdivideLevelBuilder(g: Geometry, smooth: boolean, boundaryMode: 'smooth' | 'sharp', sharp: Map<number, number> | null): { geo: Geometry; sharp: Map<number, number> } {
  const E = buildEdges(g);
  const ne = E.a.length;
  // faces adjacent to each edge (only closed polygons)
  const edgeFaces: number[][] = Array.from({ length: ne }, () => []);
  for (let pr = 0; pr < g.numPrims; pr++) {
    if (!g.primClosed[pr]) continue;
    const s = g.primStart[pr], e = g.primStart[pr + 1];
    for (let v = s; v < e; v++) {
      const a = g.vertexPoint[v], b = g.vertexPoint[v + 1 < e ? v + 1 : s];
      const ei = E.map.get(E.key(a, b));
      if (ei !== undefined) edgeFaces[ei].push(pr);
    }
  }
  const b = new GeoBuilder(g);
  // face point weights
  const facePt = new Int32Array(g.numPrims).fill(-1);
  const faceW: { i: number[]; w: number[] }[] = [];
  for (let pr = 0; pr < g.numPrims; pr++) {
    if (!g.primClosed[pr]) continue;
    const pts = g.primPoints(pr);
    const w = { i: pts, w: pts.map(() => 1 / pts.length) };
    faceW[pr] = w;
    facePt[pr] = b.blendPoint(w.i, w.w);
  }
  const addW = (acc: Map<number, number>, i: number, w: number) => acc.set(i, (acc.get(i) ?? 0) + w);
  const isBoundaryEdge = (e: number) => edgeFaces[e].length !== 2;
  // crease sharpness per edge (interior edges only)
  const es = new Float64Array(ne);
  if (sharp && sharp.size)
    for (let e = 0; e < ne; e++) if (!isBoundaryEdge(e)) es[e] = Math.max(0, sharp.get(edgeKey(E.a[e], E.b[e])) ?? 0);
  // edge points
  const edgePt = new Int32Array(ne).fill(-1);
  for (let e = 0; e < ne; e++) {
    if (!edgeFaces[e].length) continue; // polyline-only edge
    const acc = new Map<number, number>();
    if (!smooth || isBoundaryEdge(e) || es[e] >= 1) { addW(acc, E.a[e], 0.5); addW(acc, E.b[e], 0.5); }
    else if (es[e] > 0) {
      // semi-sharp: blend the smooth and the sharp (midpoint) rules
      const s = es[e], t = 1 - s;
      addW(acc, E.a[e], 0.25 * t + 0.5 * s); addW(acc, E.b[e], 0.25 * t + 0.5 * s);
      for (const f of edgeFaces[e]) faceW[f].i.forEach((q, k) => addW(acc, q, 0.25 * faceW[f].w[k] * t));
    } else {
      addW(acc, E.a[e], 0.25); addW(acc, E.b[e], 0.25);
      for (const f of edgeFaces[e]) faceW[f].i.forEach((q, k) => addW(acc, q, 0.25 * faceW[f].w[k]));
    }
    edgePt[e] = b.blendPoint([...acc.keys()], [...acc.values()]);
  }
  // vertex points
  const vtxPt = new Int32Array(g.numPoints).fill(-1);
  const ptFaces: number[][] = Array.from({ length: g.numPoints }, () => []);
  const ptEdges: number[][] = Array.from({ length: g.numPoints }, () => []);
  for (let pr = 0; pr < g.numPrims; pr++) if (g.primClosed[pr]) for (const q of new Set(g.primPoints(pr))) ptFaces[q].push(pr);
  for (let e = 0; e < ne; e++) if (edgeFaces[e].length) { ptEdges[E.a[e]].push(e); ptEdges[E.b[e]].push(e); }
  const other = (e: number, i: number) => (E.a[e] === i ? E.b[e] : E.a[e]);
  /** Weights of the regular (non-crease) vertex rule; null = the point stays where it is. */
  const smoothRule = (i: number, faces: number[], bEdges: number[]): Map<number, number> | null => {
    const acc = new Map<number, number>();
    if (bEdges.length) {
      if (boundaryMode === 'sharp' || bEdges.length !== 2) return null;
      addW(acc, i, 0.75);
      for (const e of bEdges) addW(acc, other(e, i), 0.125);
      return acc;
    }
    const n = faces.length;
    for (const f of faces) faceW[f].i.forEach((q, k) => addW(acc, q, faceW[f].w[k] / (n * n)));
    for (const e of ptEdges[i]) { addW(acc, E.a[e], 1 / (n * n)); addW(acc, E.b[e], 1 / (n * n)); }
    addW(acc, i, (n - 3) / n);
    return acc;
  };
  /** Vertex point on creases: crease rule (2 creases) or corner (3+, or creases meeting a boundary), blended by sharpness. */
  const creaseVertex = (i: number, faces: number[], bEdges: number[], cEdges: number[]): number => {
    let sum = 0;
    for (const e of cEdges) sum += es[e];
    const sigma = Math.min(1, sum / cEdges.length);
    const corner = bEdges.length > 0 || cEdges.length >= 3;
    if (corner && sigma >= 1) return b.copyPoint(i);
    const sharpW = new Map<number, number>();
    if (corner) sharpW.set(i, 1);
    else { addW(sharpW, i, 0.75); for (const e of cEdges) addW(sharpW, other(e, i), 0.125); }
    let acc = sharpW;
    if (sigma < 1) {
      const sm = smoothRule(i, faces, bEdges) ?? new Map([[i, 1]]);
      acc = new Map();
      for (const [q, w] of sm) addW(acc, q, w * (1 - sigma));
      for (const [q, w] of sharpW) addW(acc, q, w * sigma);
    }
    return b.blendPoint([...acc.keys()], [...acc.values()]);
  };
  for (let i = 0; i < g.numPoints; i++) {
    const faces = ptFaces[i];
    if (!faces.length) continue;
    if (!smooth) { vtxPt[i] = b.copyPoint(i); continue; }
    const bEdges = ptEdges[i].filter(isBoundaryEdge);
    const cEdges = ptEdges[i].filter((e) => es[e] > 0);
    if (cEdges.length && (bEdges.length || cEdges.length >= 2)) {
      vtxPt[i] = creaseVertex(i, faces, bEdges, cEdges);
      continue;
    }
    const acc = new Map<number, number>();
    if (bEdges.length) {
      if (boundaryMode === 'sharp' || bEdges.length !== 2) { vtxPt[i] = b.copyPoint(i); continue; }
      addW(acc, i, 0.75);
      for (const e of bEdges) addW(acc, E.a[e] === i ? E.b[e] : E.a[e], 0.125);
    } else {
      const n = faces.length;
      for (const f of faces) faceW[f].i.forEach((q, k) => addW(acc, q, faceW[f].w[k] / (n * n)));
      for (const e of ptEdges[i]) { addW(acc, E.a[e], 1 / (n * n)); addW(acc, E.b[e], 1 / (n * n)); }
      addW(acc, i, (n - 3) / n);
    }
    vtxPt[i] = b.blendPoint([...acc.keys()], [...acc.values()]);
  }
  // new faces
  for (let pr = 0; pr < g.numPrims; pr++) {
    const s = g.primStart[pr], e = g.primStart[pr + 1], n = e - s;
    if (!g.primClosed[pr]) {
      const ids: number[] = [];
      for (let v = s; v < e; v++) { const q = g.vertexPoint[v]; ids.push(vtxPt[q] >= 0 ? vtxPt[q] : (vtxPt[q] = b.copyPoint(q))); }
      b.addPrim(ids, false, pr);
      continue;
    }
    const vs = Array.from({ length: n }, (_, k) => s + k);
    const all: Src = { i: vs, w: vs.map(() => 1 / n) };
    for (let k = 0; k < n; k++) {
      const v = vs[k], vn = vs[(k + 1) % n], vp = vs[(k - 1 + n) % n];
      const a = g.vertexPoint[v];
      const eNext = E.map.get(E.key(a, g.vertexPoint[vn]))!, ePrev = E.map.get(E.key(g.vertexPoint[vp], a))!;
      b.addPrim([vtxPt[a], edgePt[eNext], facePt[pr], edgePt[ePrev]], true, pr, [
        v, { i: [v, vn], w: [0.5, 0.5] }, all, { i: [vp, v], w: [0.5, 0.5] },
      ]);
    }
  }
  // edge groups → child edges; crease sharpness → child edges with s - 1 (builder point numbers)
  const childSharp = new Map<number, number>();
  const groups = b.keepSrcGroups ? [...g.edgeGroups].map(([k, set]) => [set, b.edgeGroup(k)] as const) : [];
  for (let e = 0; e < ne; e++) {
    const pa = vtxPt[E.a[e]], pb = vtxPt[E.b[e]], m = edgePt[e];
    if (pa < 0 || pb < 0) continue;
    for (const [src, dst] of groups) {
      if (!src.has(E.a[e], E.b[e])) continue;
      if (m >= 0) { dst.add(pa, m); dst.add(m, pb); } else dst.add(pa, pb);
    }
    if (m >= 0 && es[e] > 1) { childSharp.set(edgeKey(pa, m), es[e] - 1); childSharp.set(edgeKey(m, pb), es[e] - 1); }
  }
  const built = b.build();
  const out = built.removeUnusedPoints();
  if (!childSharp.size || out.numPoints === built.numPoints) return { geo: out, sharp: childSharp };
  // removeUnusedPoints renumbered points: renumber the crease keys the same way
  const used = new Uint8Array(built.numPoints);
  for (let v = 0; v < built.numVertices; v++) used[built.vertexPoint[v]] = 1;
  const remap = new Int32Array(built.numPoints).fill(-1);
  for (let i = 0, k = 0; i < built.numPoints; i++) if (used[i]) remap[i] = k++;
  const moved = new Map<number, number>();
  for (const [k, s] of childSharp) {
    const [x, y] = edgeFromKey(k);
    if (remap[x] >= 0 && remap[y] >= 0) moved.set(edgeKey(remap[x], remap[y]), s);
  }
  return { geo: out, sharp: moved };
}

/**
 * subdivideLevel on typed arrays, without GeoBuilder: the same output bit for bit as subdivideLevelBuilder (point,
 * vertex and prim order, every blend weight, the order in which weights are accumulated and summed, attribute and
 * group inheritance, edge groups and crease propagation), several times faster and with little garbage. Each new
 * point's stencil (source points and weights, in the builder's insertion order) lives in a small scratch buffer and is
 * applied to P and every float point attribute as soon as it is complete.
 *
 * Returns null (the caller falls back to the builder path) for packed prims and for closed polygons that are empty or
 * repeat a point on consecutive corners; those degenerate inputs take builder-specific paths.
 */
function subdivideLevelFast(g: Geometry, smooth: boolean, boundaryMode: 'smooth' | 'sharp', sharp: Map<number, number> | null): { geo: Geometry; sharp: Map<number, number> } | null {
  if (g.primKind) return null;
  const np = g.numPoints, nprim = g.numPrims, nv = g.numVertices;
  const vp = g.vertexPoint, ps = g.primStart, closed = g.primClosed, P = g.P;
  for (let pr = 0; pr < nprim; pr++) {
    if (!closed[pr]) continue;
    const s = ps[pr], e = ps[pr + 1];
    if (e === s) return null;
    for (let v = s; v < e; v++) if (vp[v] === vp[v + 1 < e ? v + 1 : s]) return null;
  }
  // ---- unique edges in order of first occurrence (as buildEdges), found through per-point lists keyed by the lower point
  const EA = new Int32Array(nv), EB = new Int32Array(nv), nextE = new Int32Array(nv), headE = new Int32Array(np).fill(-1);
  /** edge of the side that starts at corner v of a closed polygon */
  const sideEdge = new Int32Array(nv).fill(-1);
  let ne = 0;
  for (let pr = 0; pr < nprim; pr++) {
    const s = ps[pr], e = ps[pr + 1];
    const last = closed[pr] ? e : e - 1;
    for (let v = s; v < last; v++) {
      const a = vp[v], b = vp[v + 1 < e ? v + 1 : s];
      if (a === b) continue;
      const lo = a < b ? a : b, hi = a < b ? b : a;
      let id = headE[lo];
      while (id >= 0 && EB[id] !== hi) id = nextE[id];
      if (id < 0) { id = ne++; EA[id] = lo; EB[id] = hi; nextE[id] = headE[lo]; headE[lo] = id; }
      sideEdge[v] = id;
    }
  }
  // ---- faces per edge (closed polygons, once per side, prim order) and per point (each polygon once, prim order)
  const efStart = new Int32Array(ne + 1);
  for (let pr = 0; pr < nprim; pr++) if (closed[pr]) for (let v = ps[pr]; v < ps[pr + 1]; v++) efStart[sideEdge[v] + 1]++;
  for (let e = 0; e < ne; e++) efStart[e + 1] += efStart[e];
  const efList = new Int32Array(efStart[ne]), efFill = efStart.slice(0, ne);
  for (let pr = 0; pr < nprim; pr++) if (closed[pr]) for (let v = ps[pr]; v < ps[pr + 1]; v++) efList[efFill[sideEdge[v]]++] = pr;
  const efCount = (e: number) => efStart[e + 1] - efStart[e];
  const lastPrim = new Int32Array(np).fill(-1);
  const pfStart = new Int32Array(np + 1);
  for (let pr = 0; pr < nprim; pr++) {
    if (!closed[pr]) continue;
    for (let v = ps[pr]; v < ps[pr + 1]; v++) { const q = vp[v]; if (lastPrim[q] !== pr) { lastPrim[q] = pr; pfStart[q + 1]++; } }
  }
  for (let i = 0; i < np; i++) pfStart[i + 1] += pfStart[i];
  const pfList = new Int32Array(pfStart[np]), pfFill = pfStart.slice(0, np);
  lastPrim.fill(-1);
  for (let pr = 0; pr < nprim; pr++) {
    if (!closed[pr]) continue;
    for (let v = ps[pr]; v < ps[pr + 1]; v++) { const q = vp[v]; if (lastPrim[q] !== pr) { lastPrim[q] = pr; pfList[pfFill[q]++] = pr; } }
  }
  // edges with faces per point (edge order; each edge listed at both ends)
  const peStart = new Int32Array(np + 1);
  for (let e = 0; e < ne; e++) if (efCount(e)) { peStart[EA[e] + 1]++; peStart[EB[e] + 1]++; }
  for (let i = 0; i < np; i++) peStart[i + 1] += peStart[i];
  const peList = new Int32Array(peStart[np]), peFill = peStart.slice(0, np);
  for (let e = 0; e < ne; e++) if (efCount(e)) { peList[peFill[EA[e]]++] = e; peList[peFill[EB[e]]++] = e; }
  const isBoundaryEdge = (e: number) => efCount(e) !== 2;
  const es = new Float64Array(ne);
  if (sharp && sharp.size)
    for (let e = 0; e < ne; e++) if (!isBoundaryEdge(e)) es[e] = Math.max(0, sharp.get(edgeKey(EA[e], EB[e])) ?? 0);

  // ---- output points: face points, edge points, vertex points, then polyline points as the prims reach them
  let nFace = 0, nEdge = 0, nVtx = 0, nCopy = 0;
  for (let pr = 0; pr < nprim; pr++) if (closed[pr]) nFace++;
  for (let e = 0; e < ne; e++) if (efCount(e)) nEdge++;
  for (let i = 0; i < np; i++) if (pfStart[i + 1] > pfStart[i]) nVtx++;
  const seen = new Uint8Array(np);
  for (let pr = 0; pr < nprim; pr++) {
    if (closed[pr]) continue;
    for (let v = ps[pr]; v < ps[pr + 1]; v++) { const q = vp[v]; if (!seen[q] && pfStart[q + 1] === pfStart[q]) { seen[q] = 1; nCopy++; } }
  }
  const NP = nFace + nEdge + nVtx + nCopy;
  const pos = new Float64Array(NP * 3);
  /** source point a new point copies (-1 for blends) and the dominant source of every new point (int/string/array/groups) */
  const dom = new Int32Array(NP);
  const fl: { s: number; sd: ArrayLike<number>; dd: Float64Array }[] = [];
  const ptAttrs: [string, Attribute, Attribute | null][] = [];
  for (const [name, a] of g.points.map) {
    if (name === 'P') continue;
    if (a.isArray) { ptAttrs.push([name, a, null]); continue; }
    const d = Attribute.create(a.type, a.size, NP, a.def);
    ptAttrs.push([name, a, d]);
    if (a.type === 'float') fl.push({ s: a.size, sd: a.data as Float64Array, dd: d.data as Float64Array });
  }
  // stencil scratch: source points and accumulated weights in first-insertion order (a JS Map's order in the builder path)
  let SI = new Int32Array(64), SW = new Float64Array(64), sLen = 0, stamp = 0;
  const mark = new Int32Array(np).fill(-1), slot = new Int32Array(np);
  let NPi = 0;
  const grow = () => {
    const si = new Int32Array(SI.length * 2), sw = new Float64Array(SW.length * 2);
    si.set(SI); sw.set(SW); SI = si; SW = sw;
  };
  /** GeoBuilder.copyPoint */
  const copyPoint = (q: number): number => {
    const i = NPi++;
    pos[i * 3] = P[q * 3]; pos[i * 3 + 1] = P[q * 3 + 1]; pos[i * 3 + 2] = P[q * 3 + 2];
    dom[i] = q;
    for (const { s, sd, dd } of fl) for (let c = 0; c < s; c++) dd[i * s + c] = sd[q * s + c];
    return i;
  };
  /** addW of the builder path: accumulate w onto q (a new entry starts at 0 + w) */
  const addW = (q: number, w: number) => {
    if (mark[q] === stamp) { SW[slot[q]] += w; return; }
    if (sLen === SI.length) grow();
    mark[q] = stamp; slot[q] = sLen; SI[sLen] = q; SW[sLen] = 0 + w; sLen++;
  };
  /** append an entry without merging (blendPoint called with explicit lists) */
  const push = (q: number, w: number) => {
    if (sLen === SI.length) grow();
    SI[sLen] = q; SW[sLen] = w; sLen++;
  };
  /** GeoBuilder.blendPoint with the current stencil, then start a new one */
  const blend = (): number => {
    const i = NPi++;
    let x = 0, y = 0, z = 0, best = -1, bw = -Infinity;
    for (let k = 0; k < sLen; k++) {
      const q = SI[k] * 3, w = SW[k];
      x += P[q] * w; y += P[q + 1] * w; z += P[q + 2] * w;
      if (w > bw) { bw = w; best = SI[k]; }
    }
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    dom[i] = best;
    for (const { s, sd, dd } of fl)
      for (let c = 0; c < s; c++) {
        let acc = 0;
        for (let k = 0; k < sLen; k++) acc += sd[SI[k] * s + c] * SW[k];
        dd[i * s + c] = acc;
      }
    sLen = 0;
    stamp++;
    return i;
  };
  /** emit a weight map built by the builder-path code (crease rules) */
  const blendMap = (acc: Map<number, number>): number => {
    for (const [q, w] of acc) push(q, w);
    return blend();
  };
  // face points
  const facePt = new Int32Array(nprim).fill(-1);
  for (let pr = 0; pr < nprim; pr++) {
    if (!closed[pr]) continue;
    const s = ps[pr], m = ps[pr + 1] - s, w = 1 / m;
    for (let k = 0; k < m; k++) push(vp[s + k], w);
    facePt[pr] = blend();
  }
  // edge points
  const edgePt = new Int32Array(ne).fill(-1);
  for (let e = 0; e < ne; e++) {
    if (!efCount(e)) continue; // polyline-only edge
    if (!smooth || isBoundaryEdge(e) || es[e] >= 1) { addW(EA[e], 0.5); addW(EB[e], 0.5); }
    else if (es[e] > 0) {
      const s = es[e], t = 1 - s;
      addW(EA[e], 0.25 * t + 0.5 * s); addW(EB[e], 0.25 * t + 0.5 * s);
      for (let k = efStart[e]; k < efStart[e + 1]; k++) {
        const f = efList[k], fs = ps[f], m = ps[f + 1] - fs, fw = 1 / m;
        for (let j = 0; j < m; j++) addW(vp[fs + j], 0.25 * fw * t);
      }
    } else {
      addW(EA[e], 0.25); addW(EB[e], 0.25);
      for (let k = efStart[e]; k < efStart[e + 1]; k++) {
        const f = efList[k], fs = ps[f], m = ps[f + 1] - fs, fw = 1 / m;
        for (let j = 0; j < m; j++) addW(vp[fs + j], 0.25 * fw);
      }
    }
    edgePt[e] = blend();
  }
  // vertex points
  const vtxPt = new Int32Array(np).fill(-1);
  const other = (e: number, i: number) => (EA[e] === i ? EB[e] : EA[e]);
  const mapW = (acc: Map<number, number>, i: number, w: number) => acc.set(i, (acc.get(i) ?? 0) + w);
  /** smoothRule of the builder path (crease vertices only) */
  const smoothRule = (i: number, n: number, bEdges: number[]): Map<number, number> | null => {
    const acc = new Map<number, number>();
    if (bEdges.length) {
      if (boundaryMode === 'sharp' || bEdges.length !== 2) return null;
      mapW(acc, i, 0.75);
      for (const e of bEdges) mapW(acc, other(e, i), 0.125);
      return acc;
    }
    for (let k = pfStart[i]; k < pfStart[i + 1]; k++) {
      const f = pfList[k], fs = ps[f], m = ps[f + 1] - fs, fw = 1 / m;
      for (let j = 0; j < m; j++) mapW(acc, vp[fs + j], fw / (n * n));
    }
    for (let k = peStart[i]; k < peStart[i + 1]; k++) { const e = peList[k]; mapW(acc, EA[e], 1 / (n * n)); mapW(acc, EB[e], 1 / (n * n)); }
    mapW(acc, i, (n - 3) / n);
    return acc;
  };
  /** creaseVertex of the builder path */
  const creaseVertex = (i: number, n: number, bEdges: number[], cEdges: number[]): number => {
    let sum = 0;
    for (const e of cEdges) sum += es[e];
    const sigma = Math.min(1, sum / cEdges.length);
    const corner = bEdges.length > 0 || cEdges.length >= 3;
    if (corner && sigma >= 1) return copyPoint(i);
    const sharpW = new Map<number, number>();
    if (corner) sharpW.set(i, 1);
    else { mapW(sharpW, i, 0.75); for (const e of cEdges) mapW(sharpW, other(e, i), 0.125); }
    let acc = sharpW;
    if (sigma < 1) {
      const sm = smoothRule(i, n, bEdges) ?? new Map([[i, 1]]);
      acc = new Map();
      for (const [q, w] of sm) mapW(acc, q, w * (1 - sigma));
      for (const [q, w] of sharpW) mapW(acc, q, w * sigma);
    }
    return blendMap(acc);
  };
  const bEdges: number[] = [], cEdges: number[] = [];
  for (let i = 0; i < np; i++) {
    const n = pfStart[i + 1] - pfStart[i];
    if (!n) continue;
    if (!smooth) { vtxPt[i] = copyPoint(i); continue; }
    bEdges.length = 0; cEdges.length = 0;
    for (let k = peStart[i]; k < peStart[i + 1]; k++) { const e = peList[k]; if (isBoundaryEdge(e)) bEdges.push(e); if (es[e] > 0) cEdges.push(e); }
    if (cEdges.length && (bEdges.length || cEdges.length >= 2)) { vtxPt[i] = creaseVertex(i, n, bEdges, cEdges); continue; }
    if (bEdges.length) {
      if (boundaryMode === 'sharp' || bEdges.length !== 2) { vtxPt[i] = copyPoint(i); continue; }
      addW(i, 0.75);
      for (const e of bEdges) addW(other(e, i), 0.125);
    } else {
      for (let k = pfStart[i]; k < pfStart[i + 1]; k++) {
        const f = pfList[k], fs = ps[f], m = ps[f + 1] - fs, fw = 1 / m;
        for (let j = 0; j < m; j++) addW(vp[fs + j], fw / (n * n));
      }
      for (let k = peStart[i]; k < peStart[i + 1]; k++) { const e = peList[k]; addW(EA[e], 1 / (n * n)); addW(EB[e], 1 / (n * n)); }
      addW(i, (n - 3) / n);
    }
    vtxPt[i] = blend();
  }
  // ---- new prims: a quad per corner of each closed polygon, polylines keep their points (copied when needed)
  let NV = 0, NPR = 0;
  for (let pr = 0; pr < nprim; pr++) {
    const n = ps[pr + 1] - ps[pr];
    if (closed[pr]) { NV += 4 * n; NPR += n; } else { NV += n; NPR++; }
  }
  const primStart = new Int32Array(NPR + 1), vertexPoint = new Int32Array(NV), primClosed = new Uint8Array(NPR), primSrc = new Int32Array(NPR);
  let ov = 0, op = 0;
  for (let pr = 0; pr < nprim; pr++) {
    const s = ps[pr], e = ps[pr + 1], n = e - s;
    if (!closed[pr]) {
      primStart[op] = ov; primSrc[op] = pr; op++;
      for (let v = s; v < e; v++) { const q = vp[v]; vertexPoint[ov++] = vtxPt[q] >= 0 ? vtxPt[q] : (vtxPt[q] = copyPoint(q)); }
      continue;
    }
    for (let k = 0; k < n; k++) {
      const v = s + k, vpv = s + ((k - 1 + n) % n);
      primStart[op] = ov; primClosed[op] = 1; primSrc[op] = pr; op++;
      vertexPoint[ov++] = vtxPt[vp[v]];
      vertexPoint[ov++] = edgePt[sideEdge[v]];
      vertexPoint[ov++] = facePt[pr];
      vertexPoint[ov++] = edgePt[sideEdge[vpv]];
    }
  }
  primStart[NPR] = NV;
  if (NPi !== NP) throw new Error(`subdivide: made ${NPi} points, expected ${NP}`);

  // ---- assemble (the builder's build() followed by removeUnusedPoints(), which keeps every point here)
  const out = Object.create(Geometry.prototype) as Geometry;
  out.points = new AttribTable(NP);
  for (const [name, a, d] of ptAttrs) {
    if (!d) { out.points.map.set(name, a.gather(dom)); continue; }
    if (a.type !== 'float') copyDominant(a, d, dom);
    out.points.map.set(name, d);
  }
  (out.points.add('P', 'float', 3).data as Float64Array).set(pos);
  // vertices: corner = copy, edge midpoints = halves of the two corners, centre = mean of the polygon's corners
  const vdom = new Int32Array(NV).fill(-1);
  {
    let o = 0;
    for (let pr = 0; pr < nprim; pr++) {
      const s = ps[pr], e = ps[pr + 1], n = e - s;
      if (!closed[pr]) { o += n; continue; }
      for (let k = 0; k < n; k++) { vdom[o] = s + k; vdom[o + 1] = s + k; vdom[o + 2] = s; vdom[o + 3] = s + ((k - 1 + n) % n); o += 4; }
    }
  }
  out.vertices = new AttribTable(NV);
  for (const [name, a] of g.vertices.map) {
    if (a.isArray) { out.vertices.map.set(name, a.gather(vdom)); continue; }
    const d = Attribute.create(a.type, a.size, NV, a.def);
    if (a.type === 'float') {
      const sd = a.data as Float64Array, dd = d.data as Float64Array, sz = a.size;
      let o = 0;
      for (let pr = 0; pr < nprim; pr++) {
        const s = ps[pr], e = ps[pr + 1], n = e - s;
        if (!closed[pr]) { o += n; continue; }
        const wn = 1 / n;
        for (let k = 0; k < n; k++) {
          const v = s + k, vn = s + ((k + 1) % n), vq = s + ((k - 1 + n) % n);
          for (let c = 0; c < sz; c++) {
            dd[o * sz + c] = sd[v * sz + c];
            let m1 = 0;
            m1 += sd[v * sz + c] * 0.5; m1 += sd[vn * sz + c] * 0.5;
            dd[(o + 1) * sz + c] = m1;
            let ctr = 0;
            for (let j = 0; j < n; j++) ctr += sd[(s + j) * sz + c] * wn;
            dd[(o + 2) * sz + c] = ctr;
            let m2 = 0;
            m2 += sd[vq * sz + c] * 0.5; m2 += sd[v * sz + c] * 0.5;
            dd[(o + 3) * sz + c] = m2;
          }
          o += 4;
        }
      }
    } else copyDominant(a, d, vdom);
    out.vertices.map.set(name, d);
  }
  out.prims = new AttribTable(NPR);
  for (const [name, a] of g.prims.map) {
    if (a.isArray) { out.prims.map.set(name, a.gather(primSrc)); continue; }
    const d = Attribute.create(a.type, a.size, NPR, a.def);
    if (a.type === 'float') {
      const sd = a.data as Float64Array, dd = d.data as Float64Array, sz = a.size;
      for (let i = 0; i < NPR; i++) for (let c = 0; c < sz; c++) dd[i * sz + c] = sd[primSrc[i] * sz + c];
    } else copyDominant(a, d, primSrc);
    out.prims.map.set(name, d);
  }
  out.detail = g.detail.clone();
  out.primStart = primStart;
  out.vertexPoint = vertexPoint;
  out.primClosed = primClosed;
  const pick = (m: Uint8Array, idx: Int32Array) => {
    const o = new Uint8Array(idx.length);
    for (let i = 0; i < idx.length; i++) { const j = idx[i]; if (j >= 0) o[i] = m[j]; }
    return o;
  };
  out.pointGroups = new Map([...g.pointGroups].map(([k, m]) => [k, pick(m, dom)]));
  out.primGroups = new Map([...g.primGroups].map(([k, m]) => [k, pick(m, primSrc)]));
  // vertex groups: only corners copy a single source vertex
  out.vertexGroups = new Map([...g.vertexGroups].map(([k, m]) => {
    const o = new Uint8Array(NV);
    let w = 0;
    for (let pr = 0; pr < nprim; pr++) {
      const s = ps[pr], e = ps[pr + 1], n = e - s;
      if (!closed[pr]) { w += n; continue; }
      for (let k = 0; k < n; k++) { if (s + k < m.length) o[w] = m[s + k]; w += 4; }
    }
    return [k, o];
  }));
  out.volumes = cloneVolumes(g.volumes);
  // edge groups → child edges; crease sharpness → child edges with s - 1
  const childSharp = new Map<number, number>();
  const edgeGroups = new Map<string, EdgeSet>();
  const groups = [...g.edgeGroups].map(([k, set]) => { const dst = new EdgeSet(); edgeGroups.set(k, dst); return [set, dst] as const; });
  if (groups.length || (sharp && sharp.size))
    for (let e = 0; e < ne; e++) {
      const pa = vtxPt[EA[e]], pb = vtxPt[EB[e]], m = edgePt[e];
      if (pa < 0 || pb < 0) continue;
      for (const [src, dst] of groups) {
        if (!src.has(EA[e], EB[e])) continue;
        if (m >= 0) { dst.add(pa, m); dst.add(m, pb); } else dst.add(pa, pb);
      }
      if (m >= 0 && es[e] > 1) { childSharp.set(edgeKey(pa, m), es[e] - 1); childSharp.set(edgeKey(m, pb), es[e] - 1); }
    }
  out.edgeGroups = edgeGroups;
  return { geo: out, sharp: childSharp };
}

/** The builder's int/string rule: element i takes the value of source element idx[i] (none when idx[i] < 0). */
function copyDominant(a: Attribute, d: Attribute, idx: ArrayLike<number>) {
  const n = idx.length, sz = a.size;
  if (a.type === 'string') {
    const sd = a.data as string[], dd = d.data as string[];
    for (let i = 0; i < n; i++) { const j = idx[i]; if (j >= 0) dd[i] = String(sd[j]); }
    return;
  }
  const sd = a.data as Int32Array, dd = d.data as Int32Array;
  for (let i = 0; i < n; i++) {
    const j = idx[i];
    if (j >= 0) for (let c = 0; c < sz; c++) dd[i * sz + c] = sd[j * sz + c];
  }
}

/**
 * Initial crease sharpness of g for the subdivide node: edges matched by `creases` get `weight`,
 * plus the crease attribute (vertex: an edge is creased when both of its corners in a polygon carry
 * a weight, using the smaller one; point: both endpoints, smaller weight; prim: every side of the prim).
 * The largest value wins. Returns null when nothing is creased.
 */
function creaseSharpness(g: Geometry, creases: string, weight: number, attrib: string) {
  const sharp = new Map<number, number>();
  const put = (k: number, s: number) => { if (s > 0 && s > (sharp.get(k) ?? 0)) sharp.set(k, s); };
  if (creases && weight > 0) for (const k of edgeMask(g, creases).keyIterator()) put(k, weight);
  const f = attrib ? g.findAttrib(attrib, ['vertex', 'point', 'prim']) : null;
  const cls = f && f.attr.type !== 'string' ? f.cls : null;
  if (cls) {
    const d = f!.attr.data as Float64Array, sz = f!.attr.size;
    forEachPrimEdge(g, (pr, v0, v1, a, bb) => {
      if (!g.primClosed[pr]) return;
      const s = cls === 'vertex' ? Math.min(d[v0 * sz], d[v1 * sz]) : cls === 'point' ? Math.min(d[a * sz], d[bb * sz]) : d[pr * sz];
      put(edgeKey(a, bb), s);
    });
  }
  return sharp.size || cls ? { sharp, attrCls: cls as 'vertex' | 'point' | 'prim' | null } : null;
}

/** Write the remaining crease sharpness back as a crease attribute (prim class becomes vertex class). */
function writeCreaseAttrib(g: Geometry, name: string, cls: 'vertex' | 'point' | 'prim', sharp: Map<number, number>) {
  const at = (a: number, b: number) => (a === b ? 0 : sharp.get(edgeKey(a, b)) ?? 0);
  if (cls === 'point') {
    const d = g.points.add(name, 'float', 1).data as Float64Array;
    d.fill(0);
    for (const [k, s] of sharp) { const [a, b] = edgeFromKey(k); if (a < g.numPoints && b < g.numPoints) { d[a] = Math.max(d[a], s); d[b] = Math.max(d[b], s); } }
    return;
  }
  g.prims.delete(name);
  const d = g.vertices.add(name, 'float', 1).data as Float64Array;
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1], n = e - s;
    for (let k = 0; k < n; k++) {
      const v = s + k, pt = g.vertexPoint[v];
      const nx = g.vertexPoint[s + ((k + 1) % n)], pv = g.vertexPoint[s + ((k - 1 + n) % n)];
      d[v] = Math.max(at(pt, nx), at(pv, pt));
    }
  }
}

defineNode({
  type: 'subdivide',
  category: 'topology',
  summary: 'Catmull-Clark (smooth) or linear subdivision with semi-sharp creases; all attributes and groups interpolated.',
  description:
    'Creases (DeRose/Kass/Truong): edges in the "creases" edge group/pattern get crease_weight, and a crease attribute ' +
    '(default "creaseweight", Houdini convention: vertex class = both corners of the edge carry the weight; point class = both ' +
    'endpoints; prim class = every side of the prim) adds its values; the larger wins. Sharpness s >= 1 uses the sharp rules ' +
    '(edge midpoint, crease vertex 3/4·v + 1/8·neighbours, corner where 3+ creases meet stays fixed), 0 < s < 1 blends with ' +
    'the smooth rules, and s drops by 1 per level, so weight 1 is sharp for one level then smooths out; weight >= levels stays ' +
    'fully sharp. Boundary points touched by an interior crease become corners. The output keeps edge groups on the child ' +
    'edges and writes the remaining sharpness back to the crease attribute (prim class becomes vertex class).',
  aliases: ['subd', 'catmull_clark', 'subdivision'],
  inputs: [{ name: 'geo', desc: 'polygon mesh' }],
  params: {
    levels: { type: 'int', default: 1, min: 0, max: 6, desc: 'subdivision depth (each level ~4x faces; 0 = pass the input through)', aliases: ['depth', 'iterations'] },
    method: { type: 'enum', options: ['catmull_clark', 'linear'], default: 'catmull_clark', desc: 'smooth or flat subdivision' },
    boundary: { type: 'enum', options: ['smooth', 'sharp'], default: 'smooth', desc: 'open boundary rule' },
    creases: { type: 'group', default: '', desc: 'edge group or edge pattern to crease ("" = none), e.g. "sharp", "angle>40", "p0-1-2-3-0"', aliases: ['crease_group', 'creasegroup'] },
    crease_weight: { type: 'float', default: 10, min: 0, desc: 'sharpness for the creases edges (>= levels = fully sharp; 1 = sharp for one level; 0.5 = half way)', aliases: ['creaseweight', 'sharpness'] },
    crease_attrib: { type: 'string', default: 'creaseweight', desc: 'vertex/point/prim attribute with crease weights ("" = ignore)' },
  },
  example: { type: 'subdivide', params: { levels: 3, creases: 'p2-1-6-5-2', crease_weight: 10 } },
  cook: ({ input, p }) => {
    let g = input(0);
    // depth 0 passes the input through untouched (refreshNormals below writes in place, and only ever sees new geometry)
    if (p.levels <= 0) return g;
    if (g.numPrims && g.numVertices * Math.pow(4, p.levels) > 2e7) throw new NodeError(`subdivide: ${p.levels} levels would create ~${(g.numVertices * 4 ** p.levels / 1e6).toFixed(0)}M vertices; lower levels`);
    const smooth = p.method === 'catmull_clark';
    const cr = creaseSharpness(g, p.creases, p.crease_weight, p.crease_attrib);
    if (!cr) {
      for (let l = 0; l < p.levels; l++) g = subdivideOnce(g, smooth, p.boundary);
      return refreshNormals(g);
    }
    let sharp = cr.sharp;
    for (let l = 0; l < p.levels; l++) {
      const r = subdivideLevel(g, smooth, p.boundary, sharp);
      g = r.geo;
      sharp = r.sharp;
    }
    if (cr.attrCls) writeCreaseAttrib(g, p.crease_attrib, cr.attrCls, sharp);
    return refreshNormals(g);
  },
});

defineNode({
  type: 'poly_extrude',
  category: 'topology',
  summary: 'Extrude/inset faces along normals (individually or as connected regions). Groups: front, side.',
  aliases: ['polyextrude', 'extrude_faces', 'inset'],
  inputs: [{ name: 'geo', desc: 'polygon mesh' }],
  params: {
    group: P.group('prim', 'faces to extrude ("" = all)'),
    distance: { type: 'float', default: 0.2, desc: 'extrusion along the normal', aliases: ['dist', 'depth', 'height'] },
    inset: { type: 'float', default: 0, desc: 'move edges inward by this distance (0 = plain extrude; distance 0 + inset = inset faces)' },
    mode: { type: 'enum', options: ['individual', 'connected'], default: 'connected', desc: 'connected keeps shared edges of selected faces together' },
    divisions: { type: 'int', default: 1, min: 1, desc: 'segments along the sides' },
    keep_back: { type: 'bool', default: false, desc: 'keep the original faces (reversed) underneath' },
  },
  outputs: 'prim groups front, side',
  cook: ({ input, p }) => {
    const g = input(0);
    const sel = mask(g, 'prim', p.group);
    const isSel = (pr: number) => !!g.primClosed[pr] && (!sel || !!sel[pr]);
    const fn = primNormals(g);
    const area = Float64Array.from({ length: g.numPrims }, (_, pr) => primArea(g, pr));
    // regions
    const region = new Int32Array(g.numPrims).fill(-1);
    let nreg = 0;
    if (p.mode === 'individual') { for (let pr = 0; pr < g.numPrims; pr++) if (isSel(pr)) region[pr] = nreg++; }
    else {
      const E = buildEdges(g);
      const edgeSel: number[][] = Array.from({ length: E.a.length }, () => []);
      for (let pr = 0; pr < g.numPrims; pr++) {
        if (!isSel(pr)) continue;
        const s = g.primStart[pr], e = g.primStart[pr + 1];
        for (let v = s; v < e; v++) edgeSel[E.map.get(E.key(g.vertexPoint[v], g.vertexPoint[v + 1 < e ? v + 1 : s]))!].push(pr);
      }
      for (let pr = 0; pr < g.numPrims; pr++) {
        if (!isSel(pr) || region[pr] >= 0) continue;
        const stack = [pr];
        region[pr] = nreg;
        while (stack.length) {
          const f = stack.pop()!;
          const s = g.primStart[f], e = g.primStart[f + 1];
          for (let v = s; v < e; v++) {
            const ei = E.map.get(E.key(g.vertexPoint[v], g.vertexPoint[v + 1 < e ? v + 1 : s]))!;
            for (const o of edgeSel[ei]) if (region[o] < 0) { region[o] = nreg; stack.push(o); }
          }
        }
        nreg++;
      }
    }
    const b = new GeoBuilder(g);
    const front = b.group('prim', 'front'), side = b.group('prim', 'side');
    const base = new Int32Array(g.numPoints);
    for (let i = 0; i < g.numPoints; i++) base[i] = b.copyPoint(i);
    // unselected prims unchanged
    for (let pr = 0; pr < g.numPrims; pr++) {
      if (region[pr] >= 0) continue;
      const vs: number[] = [];
      for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) vs.push(v);
      b.addPrim(vs.map((v) => base[g.vertexPoint[v]]), !!g.primClosed[pr], pr, vs);
    }
    const Pd = g.P;
    const facesOf: number[][] = Array.from({ length: nreg }, () => []);
    for (let pr = 0; pr < g.numPrims; pr++) if (region[pr] >= 0) facesOf[region[pr]].push(pr);
    const vprimAll = g.vertexPrims();
    for (let r = 0; r < nreg; r++) {
      const faces = facesOf[r];
      // directed boundary edges of the region
      const dir = new Map<string, number>();
      for (const f of faces) {
        const s = g.primStart[f], e = g.primStart[f + 1];
        for (let v = s; v < e; v++) {
          const a = g.vertexPoint[v], bb = g.vertexPoint[v + 1 < e ? v + 1 : s];
          dir.set(a + ':' + bb, v);
        }
      }
      const next = new Map<number, number>(), prev = new Map<number, number>();
      const boundary: [number, number, number][] = []; // a, b, vertex index of a in its face
      for (const [k, v] of dir) {
        const [a, bb] = k.split(':').map(Number);
        if (!dir.has(bb + ':' + a)) { boundary.push([a, bb, v]); next.set(a, bb); prev.set(bb, a); }
      }
      // averaged normals per region point
      const nrm = new Map<number, Vec3>();
      for (const f of faces)
        for (const q of new Set(g.primPoints(f))) {
          const n = nrm.get(q) ?? [0, 0, 0];
          n[0] += fn[f * 3] * area[f]; n[1] += fn[f * 3 + 1] * area[f]; n[2] += fn[f * 3 + 2] * area[f];
          nrm.set(q, n);
        }
      const top = new Map<number, number>();
      const ringPts = new Map<number, number[]>();
      for (const [q, n0] of nrm) {
        const l = Math.hypot(n0[0], n0[1], n0[2]) || 1;
        const n: Vec3 = [n0[0] / l, n0[1] / l, n0[2] / l];
        let ix = 0, iy = 0, iz = 0;
        if (p.inset !== 0 && next.has(q) && prev.has(q)) {
          const a = prev.get(q)!, c = next.get(q)!;
          const e1 = norm3([Pd[q * 3] - Pd[a * 3], Pd[q * 3 + 1] - Pd[a * 3 + 1], Pd[q * 3 + 2] - Pd[a * 3 + 2]]);
          const e2 = norm3([Pd[c * 3] - Pd[q * 3], Pd[c * 3 + 1] - Pd[q * 3 + 1], Pd[c * 3 + 2] - Pd[q * 3 + 2]]);
          const n1 = norm3(cr(n, e1)), n2 = norm3(cr(n, e2));
          const m = norm3([n1[0] + n2[0], n1[1] + n2[1], n1[2] + n2[2]]);
          const d = m[0] * n1[0] + m[1] * n1[1] + m[2] * n1[2];
          const off = p.inset / Math.max(0.2, d);
          ix = m[0] * off; iy = m[1] * off; iz = m[2] * off;
        }
        const ring: number[] = [];
        for (let k = 1; k <= p.divisions; k++) {
          const t = k / p.divisions;
          ring.push(b.addPoint(
            Pd[q * 3] + (n[0] * p.distance + ix) * t,
            Pd[q * 3 + 1] + (n[1] * p.distance + iy) * t,
            Pd[q * 3 + 2] + (n[2] * p.distance + iz) * t, q));
        }
        ringPts.set(q, ring);
        top.set(q, ring[ring.length - 1]);
      }
      for (const f of faces) {
        const vs: number[] = [];
        for (let v = g.primStart[f]; v < g.primStart[f + 1]; v++) vs.push(v);
        front.add(b.addPrim(vs.map((v) => top.get(g.vertexPoint[v])!), true, f, vs));
        if (p.keep_back) b.addPrim(vs.map((v) => base[g.vertexPoint[v]]).reverse(), true, f, vs.slice().reverse());
      }
      for (const [a, bb, va] of boundary) {
        const f = vprimAll[va];
        const ra = [base[a], ...ringPts.get(a)!], rb = [base[bb], ...ringPts.get(bb)!];
        const vb = g.primStart[f] + ((va - g.primStart[f] + 1) % g.primSize(f));
        for (let k = 0; k < p.divisions; k++) side.add(b.addPrim([ra[k], rb[k], rb[k + 1], ra[k + 1]], true, f, [va, vb, vb, va]));
      }
    }
    return b.build().removeUnusedPoints();
  },
});

defineNode({
  type: 'grid_split',
  category: 'topology',
  summary: 'Split quads into a grid of cells by target size (facades → window cells) or fixed counts. Shared edges stay welded.',
  aliases: ['divide_quads', 'facade_split', 'quad_split', 'split_faces'],
  inputs: [{ name: 'geo', desc: 'polygon mesh (quads are split; other polygons pass through)' }],
  params: {
    group: P.group('prim', 'quads to split ("" = all)'),
    mode: { type: 'enum', options: ['size', 'count'], default: 'size', desc: 'size = divide each edge by length / target size; count = fixed divisions' },
    size: { type: 'vec2', default: [1, 1], desc: 'target cell size [horizontal, vertical]: edges mostly along Y use the 2nd value' },
    divisions: { type: 'ivec2', default: [2, 2], min: 1, desc: 'count mode: cells along the quad\'s first and second edge' },
  },
  outputs: 'prim int cell_u, cell_v (cell indices within the original quad)',
  cook: ({ input, p }) => {
    const g = input(0);
    const sel = mask(g, 'prim', p.group);
    const b = new GeoBuilder(g);
    const cu = b.attrib('prim', 'cell_u', 1, 'int'), cv = b.attrib('prim', 'cell_v', 1, 'int');
    const Pd = g.P;
    const corner = new Int32Array(g.numPoints).fill(-1);
    const cornerPt = (i: number) => (corner[i] >= 0 ? corner[i] : (corner[i] = b.copyPoint(i)));
    const edgePts = new Map<string, number[]>();
    const edgeCount = (a: number, c: number) => {
      const dx = Pd[c * 3] - Pd[a * 3], dy = Pd[c * 3 + 1] - Pd[a * 3 + 1], dz = Pd[c * 3 + 2] - Pd[a * 3 + 2];
      const len = Math.hypot(dx, dy, dz);
      const vertical = len > 0 && Math.abs(dy) / len > 0.7071;
      return Math.max(1, Math.round(len / Math.max(1e-9, vertical ? p.size[1] : p.size[0])));
    };
    // interior points of edge a→c with n segments, shared between neighbouring quads
    const edgeInterior = (a: number, c: number, n: number): number[] => {
      const lo = Math.min(a, c), hi = Math.max(a, c), key = `${lo}:${hi}:${n}`;
      let pts = edgePts.get(key);
      if (!pts) {
        pts = [];
        for (let k = 1; k < n; k++) { const t = k / n; pts.push(b.blendPoint([lo, hi], [1 - t, t])); }
        edgePts.set(key, pts);
      }
      return a === lo ? pts : pts.slice().reverse();
    };
    for (let pr = 0; pr < g.numPrims; pr++) {
      const s = g.primStart[pr], n = g.primSize(pr);
      const vs = Array.from({ length: n }, (_, k) => s + k);
      if (!g.primClosed[pr] || n !== 4 || (sel && !sel[pr])) {
        const id = b.addPrim(vs.map((v) => cornerPt(g.vertexPoint[v])), !!g.primClosed[pr], pr, vs);
        cu.set(id, 0); cv.set(id, 0);
        continue;
      }
      const c = vs.map((v) => g.vertexPoint[v]);
      let nu: number, nv: number;
      if (p.mode === 'count') { nu = p.divisions[0]; nv = p.divisions[1]; }
      else { nu = Math.max(edgeCount(c[0], c[1]), edgeCount(c[3], c[2])); nv = Math.max(edgeCount(c[1], c[2]), edgeCount(c[0], c[3])); }
      // point lattice (i along c0→c1, j along c0→c3)
      const L: number[][] = Array.from({ length: nu + 1 }, () => new Array(nv + 1));
      L[0][0] = cornerPt(c[0]); L[nu][0] = cornerPt(c[1]); L[nu][nv] = cornerPt(c[2]); L[0][nv] = cornerPt(c[3]);
      const e01 = edgeInterior(c[0], c[1], nu), e32 = edgeInterior(c[3], c[2], nu);
      const e03 = edgeInterior(c[0], c[3], nv), e12 = edgeInterior(c[1], c[2], nv);
      for (let i = 1; i < nu; i++) { L[i][0] = e01[i - 1]; L[i][nv] = e32[i - 1]; }
      for (let j = 1; j < nv; j++) { L[0][j] = e03[j - 1]; L[nu][j] = e12[j - 1]; }
      for (let i = 1; i < nu; i++)
        for (let j = 1; j < nv; j++) {
          const u = i / nu, v = j / nv;
          L[i][j] = b.blendPoint(c, [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v]);
        }
      const vw = (u: number, v: number) => ({ i: vs, w: [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v] });
      for (let i = 0; i < nu; i++)
        for (let j = 0; j < nv; j++) {
          const id = b.addPrim([L[i][j], L[i + 1][j], L[i + 1][j + 1], L[i][j + 1]], true, pr, [
            vw(i / nu, j / nv), vw((i + 1) / nu, j / nv), vw((i + 1) / nu, (j + 1) / nv), vw(i / nu, (j + 1) / nv),
          ]);
          cu.set(id, i); cv.set(id, j);
        }
    }
    return b.build().removeUnusedPoints();
  },
});

const norm3 = (v: number[]): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cr = (a: number[], b: number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

defineNode({
  type: 'fill_holes',
  category: 'topology',
  summary: 'Cap open boundary loops with new polygons (makes meshes watertight).',
  aliases: ['polycap', 'cap_holes', 'close_holes'],
  inputs: [{ name: 'geo', desc: 'mesh with holes' }],
  params: {
    max_edges: { type: 'int', default: 0, min: 0, desc: 'only fill holes with at most this many edges (0 = all)' },
    triangulate: { type: 'bool', default: false, desc: 'fan-triangulate the caps' },
  },
  outputs: 'prim group filled',
  cook: ({ input, p }) => {
    const g = input(0);
    const loops = boundaryLoops(g).filter((l) => !p.max_edges || l.length <= p.max_edges);
    const b = new GeoBuilder(g);
    for (let i = 0; i < g.numPoints; i++) b.copyPoint(i);
    for (let pr = 0; pr < g.numPrims; pr++) {
      const vs: number[] = [];
      for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) vs.push(v);
      b.addPrim(vs.map((v) => g.vertexPoint[v]), !!g.primClosed[pr], pr, vs);
    }
    const filled = b.group('prim', 'filled');
    for (const l of loops) {
      if (p.triangulate && l.length > 3) {
        const ci = b.blendPoint(l, l.map(() => 1 / l.length));
        for (let k = 0; k < l.length; k++) filled.add(b.addPrim([l[k], l[(k + 1) % l.length], ci]));
      } else filled.add(b.addPrim(l));
    }
    return b.build();
  },
});

defineNode({
  type: 'bound',
  category: 'topology',
  packed: 'keep',
  summary: 'Bounding box of the input (whole or per connected piece) as a box mesh.',
  aliases: ['bbox', 'bounding_box'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    padding: { type: 'vec3', default: [0, 0, 0], desc: 'extra size added on each side' },
    per_piece: { type: 'bool', default: false, desc: 'one box per connected piece' },
    divisions: { type: 'ivec3', default: [1, 1, 1], min: 1, desc: 'box divisions' },
  },
  cook: ({ input, p }) => {
    const g = input(0);
    const boxes: Geometry[] = [];
    const make = (geo: Geometry) => {
      const bb = geo.bbox(true);
      const size = [0, 1, 2].map((a) => bb.max[a] - bb.min[a] + 2 * p.padding[a]) as Vec3;
      const c = [0, 1, 2].map((a) => (bb.min[a] + bb.max[a]) / 2) as Vec3;
      boxes.push(makeBox(size.map((s) => Math.max(s, 1e-6)) as Vec3, c, p.divisions));
    };
    if (p.per_piece) {
      const conn = connectivity(g);
      for (let k = 0; k < conn.count; k++) make(g.subsetPoints(Uint8Array.from(conn.ptClass, (c) => (c === k ? 1 : 0))));
    } else make(g);
    return Geometry.merge(boxes);
  },
});

defineNode({
  type: 'convex_hull',
  category: 'solid',
  summary: 'Convex hull of all points (watertight triangles).',
  aliases: ['hull', 'shrinkwrap'],
  inputs: [{ name: 'geo', desc: 'points or geometry' }],
  params: {},
  cook: ({ input }) => {
    const g = input(0);
    if (g.numPoints < 4) throw new NodeError('convex hull needs at least 4 non-coplanar points');
    const pts: [number, number, number][] = [];
    for (let i = 0; i < g.numPoints; i++) pts.push([g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]]);
    const m = M().Manifold.hull(pts);
    const out = fromManifold(m, propLayout([])).geo;
    m.delete();
    return out;
  },
});

export { primCentroid, primNewell, topologyReport };
