// Polygon modelling / topology nodes.
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import type { Src } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import {
  boundaryLoops, buildEdges, connectivity, orientOutward, refreshNormals, primArea, primCentroid, primNewell, primNormals, reversePrims, topologyReport, triangulate,
} from '../core/topology.ts';
import { M, fromManifold, propLayout } from '../core/manifold.ts';
import { P, mask } from './util.ts';
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
  aliases: ['cleanup', 'repair'],
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
  // edge points
  const edgePt = new Int32Array(ne).fill(-1);
  const isBoundaryEdge = (e: number) => edgeFaces[e].length !== 2;
  for (let e = 0; e < ne; e++) {
    if (!edgeFaces[e].length) continue; // polyline-only edge
    const acc = new Map<number, number>();
    if (!smooth || isBoundaryEdge(e)) { addW(acc, E.a[e], 0.5); addW(acc, E.b[e], 0.5); }
    else {
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
  for (let i = 0; i < g.numPoints; i++) {
    const faces = ptFaces[i];
    if (!faces.length) continue;
    if (!smooth) { vtxPt[i] = b.copyPoint(i); continue; }
    const bEdges = ptEdges[i].filter(isBoundaryEdge);
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
  return b.build().removeUnusedPoints();
}

defineNode({
  type: 'subdivide',
  category: 'topology',
  summary: 'Catmull-Clark (smooth) or linear subdivision; all attributes interpolated.',
  aliases: ['subd', 'catmull_clark', 'subdivision'],
  inputs: [{ name: 'geo', desc: 'polygon mesh' }],
  params: {
    levels: { type: 'int', default: 1, min: 0, max: 6, desc: 'subdivision depth (each level ~4x faces)', aliases: ['depth', 'iterations'] },
    method: { type: 'enum', options: ['catmull_clark', 'linear'], default: 'catmull_clark', desc: 'smooth or flat subdivision' },
    boundary: { type: 'enum', options: ['smooth', 'sharp'], default: 'smooth', desc: 'open boundary rule' },
  },
  cook: ({ input, p }) => {
    let g = input(0);
    if (g.numPrims && g.numVertices * Math.pow(4, p.levels) > 2e7) throw new NodeError(`subdivide: ${p.levels} levels would create ~${(g.numVertices * 4 ** p.levels / 1e6).toFixed(0)}M vertices; lower levels`);
    for (let l = 0; l < p.levels; l++) g = subdivideOnce(g, p.method === 'catmull_clark', p.boundary);
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
