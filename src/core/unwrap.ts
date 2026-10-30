// uv_unwrap's pipeline (nodes/uv.ts). xatlas cuts and flattens the charts; everything around it is here.
//  - Pieces: the mesh is split into connected pieces (polygons sharing points) and each piece is charted on its own,
//    scaled to xatlas's working size, so a small part of a merged model is charted as finely as it would be alone.
//  - Degenerate triangles (no area: collinear or coincident corners, relative to the piece) are not given to xatlas.
//    A polygon with no charted triangle takes the uv of a neighbouring polygon's chart, collapsed onto it (no area,
//    no overlap). A corner only degenerate triangles reach is mapped onto its polygon's chart the same way.
//  - A polygon whose triangles xatlas puts in different charts is split into its triangles (straddling "split"), each
//    keeping its chart's uv exactly; "unfold" keeps the polygon and maps its other corners onto its main chart.
//  - Charts whose uv winding is opposite to the polygons' are mirrored back. Charts stretched one way (xatlas widens
//    very thin charts, such as bevel strips, in its atlas) are flattened again by a least squares conformal map.
//  - Folded charts (overlaps inside a chart) are charted again: by xatlas from their triangles with a quarter of the max
//    cost, then by a least squares conformal map; one still folded (a crack or cone no flat map avoids) is cut where it overlaps itself.
//  - Thin charts join a neighbour where their seam lines up; charts longer than the tile, rings and arcs are cut into
//    parts when the parts pack denser (core/uvislands.ts).
//  - The charts are packed with the raster packer (core/uvpack.ts) and the result is checked exactly (uvoverlap.ts).
import type { Geometry } from './geometry.ts';
import { GeoBuilder } from './geometry.ts';
import { triangulate } from './topology.ts';
import { lscm, readUV } from './uv.ts';
import { xatlasCharts } from './xatlas.ts';
import type { XatlasChartOptions } from './xatlas.ts';
import { packCharts } from './uvpack.ts';
import { cutLongCharts, islandWeights, mergeThinCharts, packsDenser, worldAngles } from './uvislands.ts';
import { OVERLAP_REL, triIntersectionArea, uvOverlapCheck, uvOverlapPairs, uvTriangleAreas } from './uvoverlap.ts';

export interface UnwrapOptions {
  chart: XatlasChartOptions;
  /** xatlas input vertex per geometry vertex (seam-split keys), or null: the points */
  vertexKey: Int32Array | null;
  /** per prim: prims with different values never share a chart, or null */
  faceGroup: Int32Array | null;
  straddling: 'split' | 'unfold';
  /** texture size and padding in its texels */
  resolution: number;
  padding: number;
  /** texels per world unit: 0 = the largest density that fits one tile */
  texelsPerUnit: number;
  /** charts that do not fit one tile at texelsPerUnit: atlas = a lower density so they fit the tile, udim = more tiles to the right, stack = more atlases in 0..1 */
  fit: 'atlas' | 'udim' | 'stack';
  /** chart orientation: min_rect = turned to the minimum bounding rectangle (and 90° turns when packing), world = world up (+Y) to +v, keep = as charted */
  orient: 'min_rect' | 'world' | 'keep';
  /** cut charts longer than the tile, and rings and arcs, into parts; join thin charts onto a neighbour (core/uvislands.ts) */
  cutLong: boolean;
  mergeThin: boolean;
  /** prim attribute with a texel weight per polygon ("" = none) */
  texelWeight: string;
  /** island orders the packer tries */
  iterations: number;
}

export interface UnwrapResult {
  geo: Geometry;
  /** per output prim: chart (-1: not a polygon), atlas (overflow stack with several atlases, else null) */
  chart: Int32Array;
  atlas: Int32Array | null;
  pieces: number;
  charts: number;
  tiles: number;
  /** polygons with no charted triangle, collapsed onto a neighbour's chart; isolated: no neighbour had a chart */
  degenerate: number;
  firstDegenerate: number;
  isolated: number;
  /** polygons xatlas put in several charts (split into triangles, or unfolded) */
  straddled: number;
  firstStraddled: number;
  /** charts stretched one way (thin strips) flattened again by a conformal map */
  unstretched: number;
  /** charts mirrored back to the polygon winding */
  mirrored: number;
  /** folded charts charted again, by stage: xatlas at a quarter of the cost, a conformal map (LSCM), cut where it overlaps itself; and the charts the cuts made */
  refolded: [number, number, number];
  splitInto: number;
  /** overlapping triangle pairs left inside one chart (folds) and between charts (never expected), output triangle ids */
  folds: number;
  foldPair: [number, number] | null;
  across: number;
  acrossPair: [number, number] | null;
  /** output triangles with 3D area but no uv area */
  collapsed: number;
  /** output triangulation (vertex triples, prim per triangle) and per-vertex uv */
  tris: Uint32Array;
  triPrim: Uint32Array;
  uv: Float64Array;
  /** summed uv area per tile used, and the packer's cap (index of the chart that spans the tile, or -1) */
  coverage: number;
  cappedBy: number;
  /** charts cut into parts (cutLong), the charts they became, and a prim of the first one cut (-1) */
  cut: number;
  cutParts: number;
  firstCut: number;
  /** the texel weight attribute was found */
  weighted: boolean;
  /** thin charts joined onto a neighbour (mergeThin) */
  merged: number;
}

/** Signed uv area of triangle t in U (6 numbers per triangle), doubled. */
const cross2 = (U: Float64Array, t: number) => (U[t * 6 + 2] - U[t * 6]) * (U[t * 6 + 5] - U[t * 6 + 1]) - (U[t * 6 + 3] - U[t * 6 + 1]) * (U[t * 6 + 4] - U[t * 6]);

export function unwrapMesh(X: any, g: Geometry, o: UnwrapOptions): UnwrapResult {
  const { tris, triPrim } = triangulate(g);
  const nt = triPrim.length, np = g.numPrims, P = g.P, vp = g.vertexPoint, ps = g.primStart;
  const tFirst = new Int32Array(np).fill(-1), tCount = new Int32Array(np);
  for (let t = 0; t < nt; t++) { const p = triPrim[t]; if (tFirst[p] < 0) tFirst[p] = t; tCount[p]++; }
  // ---- pieces: points joined by polygons
  const parent = Int32Array.from({ length: g.numPoints }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let p = 0; p < np; p++) {
    if (!tCount[p]) continue;
    const r0 = find(vp[ps[p]]);
    for (let v = ps[p] + 1; v < ps[p + 1]; v++) { const r = find(vp[v]); if (r !== r0) parent[r] = r0; }
  }
  const pieceOf = new Int32Array(np).fill(-1), pieceId = new Map<number, number>();
  for (let p = 0; p < np; p++) {
    if (!tCount[p]) continue;
    const r = find(vp[ps[p]]);
    let k = pieceId.get(r);
    if (k === undefined) pieceId.set(r, (k = pieceId.size));
    pieceOf[p] = k;
  }
  const nPieces = pieceId.size;
  const lo = new Float64Array(nPieces * 3).fill(Infinity), hi = new Float64Array(nPieces * 3).fill(-Infinity);
  for (let p = 0; p < np; p++) {
    const k = pieceOf[p];
    if (k < 0) continue;
    for (let v = ps[p]; v < ps[p + 1]; v++) for (let d = 0; d < 3; d++) { const x = P[vp[v] * 3 + d]; if (x < lo[k * 3 + d]) lo[k * 3 + d] = x; if (x > hi[k * 3 + d]) hi[k * 3 + d] = x; }
  }
  // ---- 3D area and degeneracy per triangle (relative to its piece: xatlas drops faces below about 1e-11 of the diagonal²)
  const area3 = new Float64Array(nt), deg = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = vp[tris[t * 3]] * 3, b = vp[tris[t * 3 + 1]] * 3, c = vp[tris[t * 3 + 2]] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const cr = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    const e2 = ux * ux + uy * uy + uz * uz + wx * wx + wy * wy + wz * wz + (wx - ux) ** 2 + (wy - uy) ** 2 + (wz - uz) ** 2;
    const k = pieceOf[triPrim[t]];
    const d2 = (hi[k * 3] - lo[k * 3]) ** 2 + (hi[k * 3 + 1] - lo[k * 3 + 1]) ** 2 + (hi[k * 3 + 2] - lo[k * 3 + 2]) ** 2;
    area3[t] = cr / 2;
    if (!(cr > 1e-9 * e2) || cr < 4e-11 * d2) deg[t] = 1;
  }
  // ---- xatlas charts per piece
  const keyOf = o.vertexKey ? (v: number) => o.vertexKey![v] : (v: number) => vp[v];
  const triChart = new Int32Array(nt).fill(-1), cu = new Float64Array(nt * 6);
  let nCharts = 0;
  const chartTriangles = (list: number[], chart: XatlasChartOptions) => {
    const sub = new Uint32Array(list.length * 3);
    for (let i = 0; i < list.length; i++) for (let c = 0; c < 3; c++) sub[i * 3 + c] = tris[list[i] * 3 + c];
    const r = xatlasCharts(X, g, sub, { keyOf, group: o.faceGroup ? (i: number) => o.faceGroup![triPrim[list[i]]] : null, chart });
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (r.triChart[i] < 0) { triChart[t] = -1; deg[t] = 1; continue; }
      triChart[t] = nCharts + r.triChart[i];
      for (let k = 0; k < 6; k++) cu[t * 6 + k] = r.cornerUV[i * 6 + k];
    }
    nCharts += r.chartCount;
  };
  const byPiece: number[][] = Array.from({ length: nPieces }, () => []);
  for (let t = 0; t < nt; t++) if (!deg[t]) byPiece[pieceOf[triPrim[t]]].push(t);
  for (const list of byPiece) if (list.length) chartTriangles(list, o.chart);
  // ---- winding: mirror charts back to the polygon winding
  let mirrored = 0;
  const unmirror = (from: number) => {
    const sum = new Map<number, number>();
    for (let t = 0; t < nt; t++) if (triChart[t] >= from) sum.set(triChart[t], (sum.get(triChart[t]) ?? 0) + cross2(cu, t));
    for (let t = 0; t < nt; t++) if (triChart[t] >= from && sum.get(triChart[t])! < 0) for (let k = 0; k < 6; k += 2) cu[t * 6 + k] = -cu[t * 6 + k];
    for (const [, s] of sum) if (s < 0) mirrored++;
  };
  unmirror(0);
  // ---- stretch: charts stretched one way (thin strips xatlas widened) are flattened again by a conformal map
  let unstretched = 0;
  for (const list of stretchedCharts(g, tris, cu, triChart, nCharts)) { lscmChart(g, tris, list, keyOf, cu); unstretched++; }
  // ---- folds: chart again until no chart overlaps itself
  const refolded: [number, number, number] = [0, 0, 0];
  let splitInto = 0;
  for (let stage = 0; stage < 3; stage++) {
    const folded = foldedCharts(cu, triChart, nCharts);
    if (!folded.length) break;
    const first = nCharts;
    for (const list of folded) {
      refolded[stage]++;
      if (stage === 0) {
        // xatlas again on the chart alone, with a quarter of the cost: smaller, flatter charts
        const chart = { ...o.chart, maxCost: (o.chart.maxCost ?? 2) * 0.25, maxChartArea: o.chart.maxChartArea ? o.chart.maxChartArea * 0.25 : 0 };
        chartTriangles(list, chart);
      } else if (stage === 1) {
        // a least squares conformal map of the chart (xatlas may have projected it, folding a ridge over)
        lscmChart(g, tris, list, keyOf, cu);
        for (const t of list) triChart[t] = nCharts;
        nCharts++;
      } else {
        // still folded (a crack or cone no flat map avoids): cut it where it overlaps itself, keeping its uv
        for (const part of splitFolded(tris, list, keyOf, cu)) { for (const t of part) triChart[t] = nCharts; nCharts++; splitInto++; }
      }
    }
    if (stage < 2) unmirror(first);
  }
  // ---- polygons: one chart each, or split (straddling), or collapsed onto a neighbour (degenerate)
  const primChart = new Int32Array(np).fill(-1), split = new Uint8Array(np);
  let straddled = 0, firstStraddled = -1;
  const deadPrims: number[] = [];
  for (let p = 0; p < np; p++) {
    if (!tCount[p]) continue;
    const acc = new Map<number, number>();
    for (let t = tFirst[p]; t < tFirst[p] + tCount[p]; t++) if (triChart[t] >= 0) acc.set(triChart[t], (acc.get(triChart[t]) ?? 0) + area3[t] + 1e-300);
    if (!acc.size) { deadPrims.push(p); continue; }
    if (acc.size > 1) {
      straddled++; if (firstStraddled < 0) firstStraddled = p;
      if (o.straddling === 'split') { split[p] = 1; continue; }
    }
    let best = -1, bw = -1;
    for (const [c, a] of acc) if (a > bw || (a === bw && c < best)) { bw = a; best = c; }
    primChart[p] = best;
  }
  // per-vertex uv for whole polygons (prims that are not unwrapped, such as polylines, keep their input uv)
  const nv = g.numVertices, vset = new Uint8Array(nv), vuv = readUV(g) ?? new Float64Array(nv * 2);
  /** uv of point pt in chart c, from the nearest triangle (in 3D) of `cand` in chart c, by barycentric coordinates */
  const mapOnto = (pt: number, c: number, cand: ArrayLike<number>): [number, number] | null => {
    let bt = -1, bd = Infinity;
    const x = P[pt * 3], y = P[pt * 3 + 1], z = P[pt * 3 + 2];
    for (let i = 0; i < cand.length; i++) {
      const t = cand[i];
      if (triChart[t] !== c) continue;
      let d = 0;
      for (let k = 0; k < 3; k++) { const q = vp[tris[t * 3 + k]] * 3; d += Math.hypot(P[q] - x, P[q + 1] - y, P[q + 2] - z); }
      if (d < bd) { bd = d; bt = t; }
    }
    if (bt < 0) return null;
    const a = vp[tris[bt * 3]] * 3, b = vp[tris[bt * 3 + 1]] * 3, q = vp[tris[bt * 3 + 2]] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[q] - P[a], P[q + 1] - P[a + 1], P[q + 2] - P[a + 2]], r = [x - P[a], y - P[a + 1], z - P[a + 2]];
    const d11 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2], d12 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2], d22 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
    const r1 = r[0] * e1[0] + r[1] * e1[1] + r[2] * e1[2], r2 = r[0] * e2[0] + r[1] * e2[1] + r[2] * e2[2];
    const det = d11 * d22 - d12 * d12;
    const l1 = det > 0 ? (r1 * d22 - r2 * d12) / det : 0, l2 = det > 0 ? (r2 * d11 - r1 * d12) / det : 0;
    const o6 = bt * 6;
    return [cu[o6] + l1 * (cu[o6 + 2] - cu[o6]) + l2 * (cu[o6 + 4] - cu[o6]), cu[o6 + 1] + l1 * (cu[o6 + 3] - cu[o6 + 1]) + l2 * (cu[o6 + 5] - cu[o6 + 1])];
  };
  const primTris = (p: number) => Array.from({ length: tCount[p] }, (_, i) => tFirst[p] + i);
  for (let p = 0; p < np; p++) {
    const c = primChart[p];
    if (c < 0) continue;
    for (let t = tFirst[p]; t < tFirst[p] + tCount[p]; t++) {
      if (triChart[t] !== c) continue;
      for (let k = 0; k < 3; k++) { const v = tris[t * 3 + k]; if (!vset[v]) { vuv[v * 2] = cu[t * 6 + k * 2]; vuv[v * 2 + 1] = cu[t * 6 + k * 2 + 1]; vset[v] = 1; } }
    }
    for (let v = ps[p]; v < ps[p + 1]; v++) {
      if (vset[v]) continue;
      const m = mapOnto(vp[v], c, primTris(p));
      if (m) { vuv[v * 2] = m[0]; vuv[v * 2 + 1] = m[1]; vset[v] = 1; }
    }
  }
  // split polygons: a triangle with no chart (degenerate) takes a charted neighbour triangle's chart in its polygon
  for (let p = 0; p < np; p++) {
    if (!split[p]) continue;
    const own = primTris(p);
    for (const t of own) {
      if (triChart[t] >= 0) continue;
      let c = -1;
      for (const s of own) if (triChart[s] >= 0 && [0, 1, 2].some((k) => [0, 1, 2].some((j) => tris[s * 3 + j] === tris[t * 3 + k]))) { c = triChart[s]; break; }
      if (c < 0) for (const s of own) if (triChart[s] >= 0) { c = triChart[s]; break; }
      for (let k = 0; k < 3; k++) { const m = mapOnto(vp[tris[t * 3 + k]], c, own); if (m) { cu[t * 6 + k * 2] = m[0]; cu[t * 6 + k * 2 + 1] = m[1]; } }
      triChart[t] = c;
    }
  }
  // degenerate polygons: the chart most of their neighbours (sharing points) use, collapsed onto it
  let degenerate = 0, isolated = 0;
  const firstDegenerate = deadPrims.length ? deadPrims[0] : -1;
  if (deadPrims.length) {
    const want = new Uint8Array(g.numPoints);
    for (const p of deadPrims) for (let v = ps[p]; v < ps[p + 1]; v++) want[vp[v]] = 1;
    const ptPrims = new Map<number, number[]>();
    for (let p = 0; p < np; p++) for (let v = ps[p]; v < ps[p + 1]; v++) if (want[vp[v]]) { let l = ptPrims.get(vp[v]); if (!l) ptPrims.set(vp[v], (l = [])); l.push(p); }
    let todo = deadPrims.slice();
    for (let pass = 0; pass < 8 && todo.length; pass++) {
      const next: number[] = [];
      for (const p of todo) {
        const votes = new Map<number, number>(), cand: number[] = [];
        for (let v = ps[p]; v < ps[p + 1]; v++) for (const q of ptPrims.get(vp[v]) ?? []) {
          if (q === p) continue;
          if (primChart[q] >= 0) { votes.set(primChart[q], (votes.get(primChart[q]) ?? 0) + 1); for (const t of primTris(q)) cand.push(t); }
          else if (split[q]) for (const t of primTris(q)) if (triChart[t] >= 0) { votes.set(triChart[t], (votes.get(triChart[t]) ?? 0) + 1); cand.push(t); }
        }
        let c = -1, bn = 0;
        for (const [k, n] of votes) if (n > bn || (n === bn && k < c)) { bn = n; c = k; }
        if (c < 0) { next.push(p); continue; }
        primChart[p] = c; degenerate++;
        for (let v = ps[p]; v < ps[p + 1]; v++) {
          // the uv this point already has in chart c (a neighbour's corner), else mapped onto c
          let found = false;
          for (const q of ptPrims.get(vp[v]) ?? []) {
            if (q === p || primChart[q] !== c) continue;
            for (let w = ps[q]; w < ps[q + 1]; w++) if (vp[w] === vp[v] && vset[w]) { vuv[v * 2] = vuv[w * 2]; vuv[v * 2 + 1] = vuv[w * 2 + 1]; found = true; break; }
            if (found) break;
          }
          if (!found) { const m = mapOnto(vp[v], c, cand); if (m) { vuv[v * 2] = m[0]; vuv[v * 2 + 1] = m[1]; found = true; } }
          vset[v] = 1;
        }
        for (const t of primTris(p)) triChart[t] = c;
      }
      if (next.length === todo.length) break;
      todo = next;
    }
    // no charted neighbour at all: one collapsed chart per piece (uv 0; the packer gives it a place of its own)
    const loose = new Map<number, number>();
    for (const p of todo) {
      let c = loose.get(pieceOf[p]);
      if (c === undefined) loose.set(pieceOf[p], (c = nCharts++));
      primChart[p] = c; isolated++;
      for (let v = ps[p]; v < ps[p + 1]; v++) { vuv[v * 2] = 0; vuv[v * 2 + 1] = 0; vset[v] = 1; }
      for (const t of primTris(p)) triChart[t] = c;
    }
  }
  /**
   * Split polygon p as output triangles (vertices, corner uv, chart). Vertices the triangulation dropped (collinear on
   * a polygon edge) are put back by fanning the triangle on that edge, uv interpolated along it, so no T-junction opens.
   */
  const splitTris = (p: number) => {
    const res: { v: number[]; uv: number[]; c: number }[] = [];
    for (const t of primTris(p)) res.push({ v: [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]], uv: Array.from(cu.subarray(t * 6, t * 6 + 6)), c: triChart[t] });
    const used = new Set<number>();
    for (const tr of res) for (const v of tr.v) used.add(v);
    const s = ps[p], n = ps[p + 1] - s;
    if (used.size >= n) return res;
    let start = -1;
    for (let i = 0; i < n; i++) if (used.has(s + i)) { start = i; break; }
    if (start < 0) return res;
    let i = start;
    do {
      const a = s + i, run: number[] = [];
      let j = (i + 1) % n;
      while (!used.has(s + j)) { run.push(s + j); j = (j + 1) % n; }
      const b = s + j;
      const k = run.length ? res.findIndex((tr) => [0, 1, 2].some((q) => tr.v[q] === a && tr.v[(q + 1) % 3] === b)) : -1;
      if (k >= 0) {
        const tr = res[k], q = tr.v.indexOf(a), qb = (q + 1) % 3, qc = (q + 2) % 3, c = tr.v[qc];
        const chain = [a, ...run, b], len = [0];
        for (let m = 1; m < chain.length; m++) {
          const x = vp[chain[m - 1]] * 3, y = vp[chain[m]] * 3;
          len.push(len[m - 1] + Math.hypot(P[y] - P[x], P[y + 1] - P[x + 1], P[y + 2] - P[x + 2]));
        }
        const L = len[len.length - 1] || 1;
        const at = (m: number) => [tr.uv[q * 2] + (tr.uv[qb * 2] - tr.uv[q * 2]) * (len[m] / L), tr.uv[q * 2 + 1] + (tr.uv[qb * 2 + 1] - tr.uv[q * 2 + 1]) * (len[m] / L)];
        const fan: { v: number[]; uv: number[]; c: number }[] = [];
        for (let m = 0; m + 1 < chain.length; m++) fan.push({ v: [chain[m], chain[m + 1], c], uv: [...at(m), ...at(m + 1), tr.uv[qc * 2], tr.uv[qc * 2 + 1]], c: tr.c });
        res.splice(k, 1, ...fan);
      }
      i = j;
    } while (i !== start);
    return res;
  };
  // ---- output geometry: split polygons become their triangles
  const anySplit = split.some((x) => x === 1);
  let out = g, outChart: Int32Array, outUV: Float64Array;
  const oTris: number[] = [], oTriPrim: number[] = [];
  if (anySplit) {
    const b = new GeoBuilder(g), map = new Int32Array(g.numPoints);
    for (let i = 0; i < g.numPoints; i++) map[i] = b.copyPoint(i);
    const ch: number[] = [], uvs: number[] = [];
    let vo = 0, po = 0;
    for (let p = 0; p < np; p++) {
      if (split[p]) {
        for (const tr of splitTris(p)) {
          b.addPrim(tr.v.map((v) => map[vp[v]]), true, p, tr.v);
          uvs.push(...tr.uv);
          oTris.push(vo, vo + 1, vo + 2); oTriPrim.push(po);
          ch.push(tr.c); vo += 3; po++;
        }
        continue;
      }
      const vs: number[] = [], pts: number[] = [];
      for (let v = ps[p]; v < ps[p + 1]; v++) { vs.push(v); pts.push(map[vp[v]]); uvs.push(vuv[v * 2], vuv[v * 2 + 1]); }
      b.addPrim(pts, !!g.primClosed[p], p, vs);
      for (const t of primTris(p)) for (let k = 0; k < 3; k++) oTris.push(vo + (tris[t * 3 + k] - ps[p]));
      for (let i = 0; i < tCount[p]; i++) oTriPrim.push(po);
      ch.push(primChart[p]); vo += vs.length; po++;
    }
    out = b.build();
    outChart = Int32Array.from(ch);
    outUV = Float64Array.from(uvs);
  } else {
    outChart = primChart;
    outUV = vuv;
    for (let t = 0; t < nt; t++) { oTris.push(tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]); oTriPrim.push(triPrim[t]); }
  }
  return finishUnwrap(out, o, outChart, outUV, Uint32Array.from(oTris), Uint32Array.from(oTriPrim), {
    pieces: nPieces, degenerate, firstDegenerate, isolated, straddled, firstStraddled, mirrored, unstretched, refolded, splitInto,
  });
}

type UnwrapStats = Pick<UnwrapResult, 'pieces' | 'degenerate' | 'firstDegenerate' | 'isolated' | 'straddled' | 'firstStraddled' | 'mirrored' | 'unstretched' | 'refolded' | 'splitInto'>;

/** Pack the charts (islands) into the tile(s), lay stacked atlases back into 0..1, and check the result. */
function finishUnwrap(g: Geometry, o: UnwrapOptions, chart: Int32Array, uv: Float64Array, T: Uint32Array, TP: Uint32Array, st: UnwrapStats): UnwrapResult {
  const nt = TP.length, P = g.P, vp = g.vertexPoint;
  // islands: the charts in use, renumbered from 0 (in triangle order)
  const ids = new Map<number, number>();
  for (let t = 0; t < nt; t++) { const c = chart[TP[t]]; if (c >= 0 && !ids.has(c)) ids.set(c, ids.size); }
  let newChart: Int32Array = new Int32Array(g.numPrims).fill(-1), count = ids.size;
  for (let p = 0; p < g.numPrims; p++) { const k = chart[p] >= 0 ? ids.get(chart[p]) : undefined; if (k !== undefined) newChart[p] = k; }
  let merged = 0;
  if (o.mergeThin) {
    const mt = mergeThinCharts(g, uv, newChart, count, { resolution: o.resolution, padding: o.padding });
    if (mt.merged) { newChart = mt.labels; count = mt.count; merged = mt.merged; }
  }
  const spill = o.texelsPerUnit > 0 && o.fit !== 'atlas';
  const solid = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = vp[T[t * 3]] * 3, b = vp[T[t * 3 + 1]] * 3, d = vp[T[t * 3 + 2]] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[d] - P[a], wy = P[d + 1] - P[a + 1], wz = P[d + 2] - P[a + 2];
    const cr = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    const e2 = ux * ux + uy * uy + uz * uz + wx * wx + wy * wy + wz * wz + (wx - ux) ** 2 + (wy - uy) ** 2 + (wz - uz) ** 2;
    if (cr > 1e-9 * e2) solid[t] = 1;
  }
  /** islands of a labelling (triangles, corners, 3D and uv area), packed */
  const pack = (lab: Int32Array, n: number) => {
    const isl: { verts: number[]; tris: number[]; area3: number; areaUV: number }[] = Array.from({ length: n }, () => ({ verts: [], tris: [], area3: 0, areaUV: 0 }));
    for (let t = 0; t < nt; t++) {
      const k = lab[TP[t]];
      if (k < 0) continue;
      const I = isl[k], a = vp[T[t * 3]] * 3, b = vp[T[t * 3 + 1]] * 3, d = vp[T[t * 3 + 2]] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[d] - P[a], wy = P[d + 1] - P[a + 1], wz = P[d + 2] - P[a + 2];
      I.tris.push(T[t * 3], T[t * 3 + 1], T[t * 3 + 2]);
      I.area3 += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
      const p0 = T[t * 3] * 2, p1 = T[t * 3 + 1] * 2, p2 = T[t * 3 + 2] * 2;
      I.areaUV += Math.abs((uv[p1] - uv[p0]) * (uv[p2 + 1] - uv[p0 + 1]) - (uv[p2] - uv[p0]) * (uv[p1 + 1] - uv[p0 + 1])) / 2;
    }
    for (let p = 0; p < g.numPrims; p++) {
      const k = lab[p];
      if (k >= 0) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) isl[k].verts.push(v);
    }
    const weights = o.texelWeight ? islandWeights(g, lab, n, o.texelWeight) : null;
    const angles = o.orient === 'world' ? worldAngles(g, uv, lab, n) : null;
    const run = (padding: number) => packCharts(uv, isl, {
      resolution: o.resolution, padding, turns: o.orient === 'min_rect', orient: o.orient === 'min_rect' ? 'min_rect' : 'keep', scaleMode: 'uniform',
      tiles: spill ? 100 : 1, iterations: o.iterations, seed: 0, weights, angles,
      texelsPerUnit: spill ? o.texelsPerUnit : 0, maxTexelsPerUnit: o.fit === 'atlas' ? o.texelsPerUnit : 0,
    });
    let r = run(o.padding);
    if (!r.packed && o.padding > 0) r = run(0);
    return { lab, n, isl, r, weights };
  };
  let best = pack(newChart, count), cut = { cut: 0, parts: count, firstCut: -1 };
  if (o.cutLong) {
    const fixed = o.texelsPerUnit > 0 ? o.texelsPerUnit / o.resolution : 0;
    const c = cutLongCharts(g, uv, newChart, count, { scaleMode: 'uniform', weights: best.weights, tiles: 1, tileScale: spill ? fixed : 0, maxTileScale: spill ? 0 : fixed });
    if (c.cut) {
      // the parts only when they pack denser: a ring's hole often takes the small charts well enough
      const alt = pack(c.labels, c.count);
      if (packsDenser(alt.r, best.r)) { best = alt; cut = c; }
    }
  }
  newChart = best.lab; count = best.n;
  const isl = best.isl, r = best.r, weighted = !!best.weights;
  const out = r.packed ? r.uv : uv;
  // fit stack: every atlas in 0..1, told apart by prim atlas
  let atlas: Int32Array | null = null;
  if (o.fit === 'stack' && r.tilesUsed > 1) {
    atlas = new Int32Array(g.numPrims).fill(-1);
    for (let k = 0; k < isl.length; k++) {
      const v0 = isl[k].verts[0];
      if (v0 === undefined) continue;
      const tu = Math.floor(out[v0 * 2]), tv = Math.floor(out[v0 * 2 + 1]);
      for (const v of isl[k].verts) { out[v * 2] -= tu; out[v * 2 + 1] -= tv; }
      const tile = tv * 10 + tu;
      for (let p = 0; p < g.numPrims; p++) if (newChart[p] === k) atlas[p] = tile;
    }
  }
  // the check: overlaps between charts (never expected; atlases in a stack overlap on purpose) and inside charts (folds)
  const chk = uvOverlapCheck(out, T, TP, newChart, atlas ? { skip: (a, b) => atlas![TP[a]] !== atlas![TP[b]] } : {});
  const U = new Float64Array(nt * 6);
  for (let c = 0; c < nt * 3; c++) { U[c * 2] = out[T[c] * 2]; U[c * 2 + 1] = out[T[c] * 2 + 1]; }
  const { ok } = uvTriangleAreas(U, nt);
  let collapsed = 0;
  for (let t = 0; t < nt; t++) if (solid[t] && !ok[t]) collapsed++;
  return {
    geo: g, chart: newChart, atlas, ...st, charts: isl.length, tiles: Math.max(1, r.tilesUsed),
    folds: chk.within, foldPair: chk.firstWithin ? chk.firstWithin.t : null, across: chk.across, acrossPair: chk.firstAcross ? chk.firstAcross.t : null,
    collapsed, tris: T, triPrim: TP, uv: out, coverage: r.packed ? r.uvArea / Math.max(1, r.tilesUsed) : 0, cappedBy: r.cappedBy >= 0 ? r.cappedBy : -1,
    cut: cut.cut, cutParts: cut.parts, firstCut: cut.firstCut, weighted, merged,
  };
}

/** Charts (triangle lists) whose triangles overlap each other in uv. */
function foldedCharts(cu: Float64Array, triChart: Int32Array, nCharts: number): number[][] {
  const lists: number[][] = Array.from({ length: nCharts }, () => []);
  for (let t = 0; t < triChart.length; t++) if (triChart[t] >= 0) lists[triChart[t]].push(t);
  const out: number[][] = [];
  for (const list of lists) {
    if (list.length < 2) continue;
    const U = new Float64Array(list.length * 6);
    for (let i = 0; i < list.length; i++) for (let k = 0; k < 6; k++) U[i * 6 + k] = cu[list[i] * 6 + k];
    const { ok, signed } = uvTriangleAreas(U, list.length);
    const valid: number[] = [];
    for (let i = 0; i < list.length; i++) if (ok[i]) valid.push(i);
    let fold = false;
    uvOverlapPairs(U, valid, signed, () => { fold = true; }, { skip: () => fold });
    if (fold) out.push(list);
  }
  return out;
}

/** A chart is stretched when the mean ratio (by 3D area) of the larger to the smaller stretch of its triangles' 3D → uv maps passes this. */
const STRETCH_MAX = 1.25;

/**
 * Charts (triangle lists) whose uv is stretched more one way than the other (STRETCH_MAX): xatlas gives very thin charts
 * (bevel strips) a minimum width in its atlas, so they come out stretched across. A conformal map flattens them again.
 */
function stretchedCharts(g: Geometry, tris: ArrayLike<number>, cu: Float64Array, triChart: Int32Array, nCharts: number): number[][] {
  const P = g.P, vp = g.vertexPoint, sum = new Float64Array(nCharts), wsum = new Float64Array(nCharts);
  for (let t = 0; t < triChart.length; t++) {
    const c = triChart[t];
    if (c < 0) continue;
    const a = vp[tris[t * 3]] * 3, b = vp[tris[t * 3 + 1]] * 3, d = vp[tris[t * 3 + 2]] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2], e2x = P[d] - P[a], e2y = P[d + 1] - P[a + 1], e2z = P[d + 2] - P[a + 2];
    const l1 = Math.hypot(e1x, e1y, e1z), nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x, nl = Math.hypot(nx, ny, nz);
    if (!(l1 > 0) || !(nl > 0)) continue;
    // the triangle in its own plane: (0, 0), (l1, 0), (qx, qy)
    const qx = (e2x * e1x + e2y * e1y + e2z * e1z) / l1, qy = nl / l1;
    const o = t * 6, du1 = cu[o + 2] - cu[o], dv1 = cu[o + 3] - cu[o + 1], du2 = cu[o + 4] - cu[o], dv2 = cu[o + 5] - cu[o + 1];
    // Jacobian J with J (l1, 0) = (du1, dv1) and J (qx, qy) = (du2, dv2)
    const j00 = du1 / l1, j10 = dv1 / l1, j01 = (du2 - j00 * qx) / qy, j11 = (dv2 - j10 * qx) / qy;
    const f = j00 * j00 + j01 * j01 + j10 * j10 + j11 * j11, det = Math.abs(j00 * j11 - j01 * j10);
    if (!(det > 0) || !Number.isFinite(f)) continue;
    const s1 = Math.sqrt((f + Math.sqrt(Math.max(0, f * f - 4 * det * det))) / 2), w = nl / 2;
    sum[c] += (s1 / (det / s1)) * w; wsum[c] += w;
  }
  const lists: number[][] = Array.from({ length: nCharts }, () => []);
  for (let t = 0; t < triChart.length; t++) { const c = triChart[t]; if (c >= 0 && wsum[c] > 0 && sum[c] / wsum[c] > STRETCH_MAX) lists[c].push(t); }
  return lists.filter((l) => l.length > 0);
}

/** uv for triangles `list` by a least squares conformal map over their shared corners (keyOf), pinned on the border. */
function lscmChart(g: Geometry, tris: ArrayLike<number>, list: number[], keyOf: (v: number) => number, cu: Float64Array): void {
  const P = g.P, vp = g.vertexPoint, local = new Map<number, number>(), pos: number[] = [], T = new Int32Array(list.length * 3);
  for (let i = 0; i < list.length; i++) for (let k = 0; k < 3; k++) {
    const v = tris[list[i] * 3 + k], key = keyOf(v);
    let l = local.get(key);
    if (l === undefined) { local.set(key, (l = local.size)); const p = vp[v] * 3; pos.push(P[p], P[p + 1], P[p + 2]); }
    T[i * 3 + k] = l;
  }
  // border vertices: on edges used by one triangle
  const edges = new Map<number, number>(), n = local.size;
  for (let i = 0; i < list.length; i++) for (let k = 0; k < 3; k++) { const a = T[i * 3 + k], b = T[i * 3 + ((k + 1) % 3)], e = Math.min(a, b) * n + Math.max(a, b); edges.set(e, (edges.get(e) ?? 0) + 1); }
  const border = new Set<number>();
  for (const [e, c] of edges) if (c === 1) { border.add(Math.floor(e / n)); border.add(e % n); }
  const r = lscm(Float64Array.from(pos), T, null, border.size ? [...border] : null);
  for (let i = 0; i < list.length; i++) for (let k = 0; k < 3; k++) {
    const l = T[i * 3 + k], u = r.uv[l * 2], w = r.uv[l * 2 + 1];
    cu[list[i] * 6 + k * 2] = Number.isFinite(u) ? u : 0;
    cu[list[i] * 6 + k * 2 + 1] = Number.isFinite(w) ? w : 0;
  }
}

/**
 * Cut a folded chart (triangles `list`, uv in cu) into parts that do not overlap themselves, keeping the uv: grow a part
 * from its largest remaining triangle across shared edges, adding a neighbour only when it overlaps nothing already in
 * the part; what is left starts the next part.
 */
function splitFolded(tris: ArrayLike<number>, list: number[], keyOf: (v: number) => number, cu: Float64Array): number[][] {
  const n = list.length;
  const edgeOwners = new Map<string, number[]>();
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const a = keyOf(tris[list[i] * 3 + k]), b = keyOf(tris[list[i] * 3 + ((k + 1) % 3)]);
    const e = a < b ? `${a},${b}` : `${b},${a}`;
    let l = edgeOwners.get(e);
    if (!l) edgeOwners.set(e, (l = []));
    l.push(i);
  }
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const l of edgeOwners.values()) for (const x of l) for (const y of l) if (x !== y) adj[x].push(y);
  // counter-clockwise uv copies, areas and bounding boxes
  const U = new Float64Array(n * 6), area = new Float64Array(n), bb = new Float64Array(n * 4);
  let span = 0;
  for (let i = 0; i < n; i++) {
    const o6 = list[i] * 6, cr = cross2(cu, list[i]);
    if (cr >= 0) for (let k = 0; k < 6; k++) U[i * 6 + k] = cu[o6 + k];
    else { U[i * 6] = cu[o6]; U[i * 6 + 1] = cu[o6 + 1]; U[i * 6 + 2] = cu[o6 + 4]; U[i * 6 + 3] = cu[o6 + 5]; U[i * 6 + 4] = cu[o6 + 2]; U[i * 6 + 5] = cu[o6 + 3]; }
    area[i] = Math.abs(cr) / 2;
    bb[i * 4] = Math.min(U[i * 6], U[i * 6 + 2], U[i * 6 + 4]); bb[i * 4 + 1] = Math.min(U[i * 6 + 1], U[i * 6 + 3], U[i * 6 + 5]);
    bb[i * 4 + 2] = Math.max(U[i * 6], U[i * 6 + 2], U[i * 6 + 4]); bb[i * 4 + 3] = Math.max(U[i * 6 + 1], U[i * 6 + 3], U[i * 6 + 5]);
    span = Math.max(span, bb[i * 4 + 2] - bb[i * 4], bb[i * 4 + 3] - bb[i * 4 + 1]);
  }
  const cs = Math.max(span, 1e-12);
  const cell = (x: number) => Math.floor(x / cs);
  const part = new Int32Array(n).fill(-1), parts: number[][] = [];
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => area[y] - area[x] || x - y);
  for (const seed of order) {
    if (part[seed] >= 0) continue;
    const id = parts.length, members: number[] = [], grid = new Map<string, number[]>();
    const overlaps = (i: number) => {
      for (let y = cell(bb[i * 4 + 1]); y <= cell(bb[i * 4 + 3]); y++) for (let x = cell(bb[i * 4]); x <= cell(bb[i * 4 + 2]); x++) {
        for (const j of grid.get(`${x},${y}`) ?? []) {
          if (Math.max(bb[i * 4], bb[j * 4]) >= Math.min(bb[i * 4 + 2], bb[j * 4 + 2]) || Math.max(bb[i * 4 + 1], bb[j * 4 + 1]) >= Math.min(bb[i * 4 + 3], bb[j * 4 + 3])) continue;
          if (triIntersectionArea(U.subarray(i * 6, i * 6 + 6), U.subarray(j * 6, j * 6 + 6)) > OVERLAP_REL * Math.min(area[i], area[j])) return true;
        }
      }
      return false;
    };
    const add = (i: number) => {
      part[i] = id; members.push(list[i]);
      for (let y = cell(bb[i * 4 + 1]); y <= cell(bb[i * 4 + 3]); y++) for (let x = cell(bb[i * 4]); x <= cell(bb[i * 4 + 2]); x++) {
        const k = `${x},${y}`; let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i);
      }
    };
    add(seed);
    const queue = [...adj[seed]];
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      if (part[i] >= 0 || overlaps(i)) continue;
      add(i);
      for (const j of adj[i]) if (part[j] < 0) queue.push(j);
    }
    parts.push(members);
  }
  return parts;
}
