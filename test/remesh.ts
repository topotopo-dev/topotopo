// Remeshing, decimation, repair and LOD tests: remesh_isotropic, decimate, mesh_repair, lod.
//   node test/remesh.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { halfEdges } from '../src/core/halfedge.ts';
import { primNewell, signedVolume, topologyReport, triangulate } from '../src/core/topology.ts';
import { ClosestBVH } from '../src/core/remesh.ts';
import { repairMesh } from '../src/core/repair.ts';
import type { NodeSpec } from '../src/graph/types.ts';

const engine = new Engine(createNodeHost());
await engine.init();

let fail = 0, pass = 0;
const check = (ok: any, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};

async function cookR(nodes: Record<string, NodeSpec>, output: string) {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return r;
}
const cook = async (nodes: Record<string, NodeSpec>, output: string) => (await cookR(nodes, output)).geo!;
const pos = (g: Geometry, i: number) => [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]];
const triCount = (g: Geometry) => { let n = 0; for (let p = 0; p < g.numPrims; p++) if (g.primClosed[p]) n += Math.max(0, g.primSize(p) - 2); return n; };
/** Closed, manifold, consistently wound, no degenerate faces. */
function watertight(g: Geometry): boolean {
  const r = topologyReport(g);
  return r.closed && !r.degenerate && halfEdges(g).isManifold;
}
function edgeLengths(g: Geometry) {
  const he = halfEdges(g), out: { l: number; a: number; b: number; e: number }[] = [];
  for (let e = 0; e < he.numEdges; e++) out.push({ l: he.edgeLength(e), a: he.edgeA[e], b: he.edgeB[e], e });
  return out;
}

// ---------------------------------------------------------------- remesh_isotropic: uniform sphere
{
  const L = 0.1;
  const nodes: Record<string, NodeSpec> = {
    s: { type: 'sphere', params: { type: 'ico', level: 3 } },
    c: { type: 'wrangle', in: ['s'], params: { code: '@Cd = set(@P.x * 0.5 + 0.5, @P.y * 0.5 + 0.5, @P.z * 0.5 + 0.5);' } },
    r: { type: 'remesh_isotropic', in: ['c'], params: { target_length: L, iterations: 10 } },
  };
  const g = await cook(nodes, 'r');
  const E = edgeLengths(g);
  const within = E.filter((x) => Math.abs(x.l - L) <= 0.25 * L).length / E.length;
  check(within > 0.9, `sphere: ${(within * 100).toFixed(1)}% of ${E.length} edges within ±25% of the target ${L} (> 90%)`);
  check(watertight(g), 'sphere: output is watertight (closed, manifold, no degenerate faces)');
  let onSphere = 0;
  for (let i = 0; i < g.numPoints; i++) onSphere = Math.max(onSphere, Math.abs(Math.hypot(...pos(g, i)) - 1));
  check(onSphere < 0.01, `sphere: points stay on the input surface (max radial deviation ${onSphere.toExponential(2)})`);
  const Cd = g.points.get('Cd')!.data as Float64Array;
  let cdErr = 0, cdJump = 0;
  for (let i = 0; i < g.numPoints; i++) for (let c = 0; c < 3; c++) cdErr = Math.max(cdErr, Math.abs(Cd[i * 3 + c] - (g.P[i * 3 + c] * 0.5 + 0.5)));
  for (const e of E) for (let c = 0; c < 3; c++) cdJump = Math.max(cdJump, Math.abs(Cd[e.a * 3 + c] - Cd[e.b * 3 + c]));
  check(cdErr < 0.01, `sphere: point Cd is interpolated at each point's location (max error ${cdErr.toExponential(2)})`);
  check(cdJump < 0.5 * 2 * L, `sphere: Cd stays continuous (max difference along an edge ${cdJump.toFixed(4)})`);
  const N = g.points.get('N');
  check(N && N.size === 3, 'sphere: point N carried over (renormalised)');
}

// ---------------------------------------------------------------- remesh_isotropic: box keeps its sharp edges
{
  const L = 0.1;
  const g = await cook({ b: { type: 'box' }, r: { type: 'remesh_isotropic', in: ['b'], params: { target_length: L, iterations: 8 } } }, 'r');
  check(watertight(g), `box: watertight (${g.numPrims} triangles)`);
  let off = 0;
  for (let i = 0; i < g.numPoints; i++) {
    const [x, y, z] = pos(g, i);
    off = Math.max(off, Math.abs(Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) - 0.5));
  }
  check(off < 1e-3, `box: every point on the box surface (max deviation ${off.toExponential(2)})`);
  const he = halfEdges(g);
  let sharpLen = 0, sharpOnEdge = true, creased = 0;
  for (let e = 0; e < he.numEdges; e++) {
    const d = he.dihedralAngle(e);
    if (d > 80) {
      sharpLen += he.edgeLength(e);
      if (Math.abs(d - 90) > 1) sharpOnEdge = false;
      // both ends on a box edge: two coordinates at ±0.5
      for (const p of [he.edgeA[e], he.edgeB[e]]) if (pos(g, p).filter((v) => Math.abs(Math.abs(v) - 0.5) < 1e-6).length < 2) sharpOnEdge = false;
    } else if (d > 1) creased++;
  }
  check(Math.abs(sharpLen - 12) < 1e-6, `box: the 12 box edges survive as 90° edges (total sharp length ${sharpLen.toFixed(6)})`);
  check(sharpOnEdge && creased === 0, `box: sharp edges are exactly 90° and lie on the box edges; faces stay flat (${creased} creased edges)`);
  const uv = g.vertices.get('uv');
  check(uv && uv.size === 3, 'box: vertex uv carried over');
  // uv on each face follows the input's planar mapping: in each output face, uv varies linearly with P
  let uvOk = true;
  const ref = await cook({ b: { type: 'box' } }, 'b');
  const refUv = ref.vertices.get('uv')!.data as Float64Array, outUv = uv!.data as Float64Array;
  const ru = new Set<string>();
  for (let v = 0; v < ref.numVertices; v++) ru.add(`${refUv[v * 3].toFixed(4)},${refUv[v * 3 + 1].toFixed(4)}`);
  for (let v = 0; v < g.numVertices; v++) if (!(outUv[v * 3] >= -1e-9 && outUv[v * 3] <= 1 + 1e-9 && outUv[v * 3 + 1] >= -1e-9 && outUv[v * 3 + 1] <= 1 + 1e-9)) uvOk = false;
  check(uvOk, 'box: uv stays inside the input uv range');
  // every output corner's uv equals the input's uv mapping at that point, on the face's side of the box edge
  const { tris } = triangulate(ref);
  const T = new Float64Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) for (let c = 0; c < 3; c++) T[i * 3 + c] = ref.P[ref.vertexPoint[tris[i]] * 3 + c];
  const bvh = new ClosestBVH(T, 3);
  let uvErr = 0;
  for (let p = 0; p < g.numPrims; p++) {
    const vs = [g.primStart[p], g.primStart[p] + 1, g.primStart[p] + 2];
    const c = [0, 1, 2].map((k) => vs.reduce((s, v) => s + g.P[g.vertexPoint[v] * 3 + k], 0) / 3);
    for (const v of vs) {
      // a point just inside the face from this corner picks the input triangle on the face's side
      const q = [0, 1, 2].map((k) => g.P[g.vertexPoint[v] * 3 + k] * 0.999 + c[k] * 0.001);
      const t = bvh.closest(q[0], q[1], q[2]);
      bvh.onItem(t, g.P[g.vertexPoint[v] * 3], g.P[g.vertexPoint[v] * 3 + 1], g.P[g.vertexPoint[v] * 3 + 2]);
      const w = [bvh.b0, bvh.b1, bvh.b2];
      for (let k = 0; k < 2; k++) {
        const want = w.reduce((s, x, j) => s + x * refUv[tris[t * 3 + j] * 3 + k], 0);
        uvErr = Math.max(uvErr, Math.abs(want - outUv[v * 3 + k]));
      }
    }
  }
  check(uvErr < 1e-6, `box: corner uv follows the input mapping on each side of the seams (max error ${uvErr.toExponential(2)})`);
}

// ---------------------------------------------------------------- remesh_isotropic: adaptive target
{
  const nodes: Record<string, NodeSpec> = {
    s: { type: 'sphere', params: { type: 'ico', level: 3 } },
    t: { type: 'wrangle', in: ['s'], params: { code: 'f@tl = fit(@P.x, -1, 1, 0.04, 0.2);' } },
    r: { type: 'remesh_isotropic', in: ['t'], params: { target_attrib: 'tl', iterations: 8 } },
  };
  const g = await cook(nodes, 'r');
  const E = edgeLengths(g);
  const mean = (f: (x: number) => boolean) => { const s = E.filter((e) => f((g.P[e.a * 3] + g.P[e.b * 3]) / 2)); return s.reduce((a, e) => a + e.l, 0) / Math.max(1, s.length); };
  const small = mean((x) => x < -0.6), big = mean((x) => x > 0.6);
  check(small < 0.07 && big > 0.12 && big / small > 2.5, `adaptive: short edges where target_attrib is small (${small.toFixed(3)} near x=-1, ${big.toFixed(3)} near x=+1)`);
  check(watertight(g), 'adaptive: watertight');
}

// ---------------------------------------------------------------- remesh_isotropic: group, boundary, uv seams
{
  const grid: NodeSpec = { type: 'grid', params: { size: [2, 2], divisions: [8, 8] } };
  const src = await cook({ g: grid }, 'g');
  const g = await cook({ g: grid, r: { type: 'remesh_isotropic', in: ['g'], params: { target_length: 0.08, group: '@P.x>0', iterations: 5 } } }, 'r');
  // prims outside the group keep their quads; group border points unchanged
  let quads = 0;
  for (let p = 0; p < g.numPrims; p++) if (g.primSize(p) === 4) quads++;
  check(quads === 32, `group: the 32 quads outside the group pass through (${quads})`);
  const has = (x: number, y: number, z: number) => { for (let i = 0; i < g.numPoints; i++) if (Math.hypot(g.P[i * 3] - x, g.P[i * 3 + 1] - y, g.P[i * 3 + 2] - z) < 1e-9) return true; return false; };
  let borderKept = true;
  for (let i = 0; i < src.numPoints; i++) if (Math.abs(src.P[i * 3]) < 1e-9 && !has(src.P[i * 3], src.P[i * 3 + 1], src.P[i * 3 + 2])) borderKept = false;
  check(borderKept, 'group: points on the group border are unchanged');
  check(halfEdges(g).isManifold && topologyReport(g).boundaryEdges > 0, 'group: remeshed part stays stitched to the rest (manifold)');
  const pb = await cook({ g: grid, r: { type: 'remesh_isotropic', in: ['g'], params: { target_length: 0.08, preserve_boundary: true, iterations: 5 } } }, 'r');
  const loopsIn = topologyReport(src).boundaryEdges, loopsOut = topologyReport(pb).boundaryEdges;
  check(loopsIn === loopsOut, `preserve_boundary: boundary edges unchanged (${loopsIn} → ${loopsOut})`);
  const rb = await cook({ g: grid, r: { type: 'remesh_isotropic', in: ['g'], params: { target_length: 0.08, iterations: 5 } } }, 'r');
  let onSquare = true;
  const he = halfEdges(rb);
  for (let e = 0; e < he.numEdges; e++) if (he.isBoundaryEdge(e)) for (const p of [he.edgeA[e], he.edgeB[e]]) { const [x, , z] = pos(rb, p); if (Math.abs(Math.max(Math.abs(x), Math.abs(z)) - 1) > 1e-6) onSquare = false; }
  check(onSquare && topologyReport(rb).boundaryEdges > loopsIn * 1.5, `boundary resampled along itself (${topologyReport(rb).boundaryEdges} boundary edges, all on the square)`);
  // uv sphere: the uv seam stays a seam (no face spans u 0 → 1)
  const us = await cook({ s: { type: 'sphere' }, r: { type: 'remesh_isotropic', in: ['s'], params: { target_length: 0.12, iterations: 6 } } }, 'r');
  const uv = us.vertices.get('uv')!.data as Float64Array;
  let span = 0, seamPts = 0;
  for (let p = 0; p < us.numPrims; p++) {
    let lo = Infinity, hi = -Infinity;
    for (let v = us.primStart[p]; v < us.primStart[p + 1]; v++) { lo = Math.min(lo, uv[v * 3]); hi = Math.max(hi, uv[v * 3]); }
    span = Math.max(span, hi - lo);
  }
  const perPt = new Map<number, Set<string>>();
  for (let v = 0; v < us.numVertices; v++) { const p = us.vertexPoint[v]; if (!perPt.has(p)) perPt.set(p, new Set()); perPt.get(p)!.add(uv[v * 3].toFixed(5)); }
  for (const s of perPt.values()) if (s.size > 1) seamPts++;
  check(span < 0.3 && seamPts > 5, `uv sphere: seam kept (max u span in a face ${span.toFixed(3)}, ${seamPts} points with two u values)`);
  check(watertight(us), 'uv sphere: watertight');
}

// ---------------------------------------------------------------- remesh_isotropic: edge groups as features
{
  // a flat grid with an edge group along x = 0: the new edges along that line keep the group
  const nodes: Record<string, NodeSpec> = {
    g: { type: 'grid', params: { size: [2, 2], divisions: [6, 6] } },
    e: { type: 'group', in: ['g'], params: { name: 'crease', class: 'edge', expr: 'Math.abs(@P.x) < 1e-6' } },
    r: { type: 'remesh_isotropic', in: ['e'], params: { target_length: 0.1, iterations: 5, edge_groups: 'crease' } },
  };
  const g = await cook(nodes, 'r');
  const set = g.edgeGroups.get('crease');
  let len = 0, onLine = true;
  if (set) for (const [a, b] of set) { len += Math.hypot(...pos(g, a).map((v, k) => v - pos(g, b)[k])); if (Math.abs(g.P[a * 3]) > 1e-9 || Math.abs(g.P[b * 3]) > 1e-9) onLine = false; }
  check(set && set.size >= 15 && onLine && Math.abs(len - 2) < 1e-6, `edge_groups: the crease line is kept and stays in group "crease" (${set?.size ?? 0} edges, length ${len.toFixed(4)})`);
}

// ---------------------------------------------------------------- remesh_isotropic: non-manifold input
{
  // two cubes fused along one edge: the non-manifold edge stays as it is, the rest is remeshed without sliver fans
  const two: Record<string, NodeSpec> = {
    a: { type: 'box' }, b: { type: 'box', params: { center: [1, 1, 0] } }, m: { type: 'merge', in: ['a', 'b'] }, f: { type: 'fuse', in: ['m'] },
    r: { type: 'remesh_isotropic', in: ['f'], params: { target_length: 0.1, iterations: 5 } },
  };
  const g = await cook(two, 'r');
  const est = 12 / (0.433 * 0.01);
  check(topologyReport(g).nonManifoldEdges === 1 && g.numPrims > est * 0.6 && g.numPrims < est * 1.6, `non-manifold input: the shared edge is kept, ${g.numPrims} triangles (estimate ${est.toFixed(0)})`);
}

// ---------------------------------------------------------------- remesh_isotropic: timing (100k triangles, 10 iterations)
for (const [label, src] of [
  // a uv sphere: 100k triangles with poles, a uv seam and uneven triangles (lots of splits, collapses and flips)
  ['uv sphere', { s: { type: 'sphere', params: { rows: 224, cols: 224 } } }],
  // an even, noisy ico sphere at its own edge length (mostly relaxation + projection)
  ['noisy ico sphere', { s: { type: 'sphere', params: { type: 'ico', level: 6 } }, n: { type: 'noise_displace', in: ['s'], params: { amplitude: 0.05, frequency: 3 } } }],
] as [string, Record<string, NodeSpec>][]) {
  const last = Object.keys(src).pop()!;
  const input = await cook(src, last);
  const t0 = performance.now();
  const r = await cookR({ ...src, r: { type: 'remesh_isotropic', in: [last], params: { iterations: 10 } } }, 'r');
  const ms = performance.now() - t0;
  console.log(`     timing: remesh_isotropic ${label} ${triCount(input)} → ${triCount(r.geo!)} triangles, 10 iterations: ${ms.toFixed(0)} ms`);
  check(ms < 8000, `timing: ${label}, ${triCount(input)} triangles, 10 iterations in ${ms.toFixed(0)} ms (target < 2000 ms on a desktop; test limit 8000)`);
}

// ---------------------------------------------------------------- decimate
{
  // uv seams survive: on the uv sphere no face spans u 0 → 1 and seam points keep both u values
  const src = await cook({ s: { type: 'sphere', params: { rows: 48, cols: 64 } } }, 's');
  const g = await cook({ s: { type: 'sphere', params: { rows: 48, cols: 64 } }, d: { type: 'decimate', in: ['s'], params: { ratio: 0.1, max_error: 1 } } }, 'd');
  const seam = (x: Geometry) => {
    const uv = x.vertices.get('uv')!.data as Float64Array, per = new Map<number, Set<string>>();
    let span = 0;
    for (let p = 0; p < x.numPrims; p++) {
      let lo = Infinity, hi = -Infinity;
      for (let v = x.primStart[p]; v < x.primStart[p + 1]; v++) { lo = Math.min(lo, uv[v * 3]); hi = Math.max(hi, uv[v * 3]); }
      span = Math.max(span, hi - lo);
    }
    for (let v = 0; v < x.numVertices; v++) {
      const p = x.vertexPoint[v], [px, py, pz] = pos(x, p);
      if (Math.abs(py) > 0.99) continue; // poles
      if (!per.has(p)) per.set(p, new Set());
      per.get(p)!.add(uv[v * 3].toFixed(4));
      void px; void pz;
    }
    let two = 0, distinct = new Set<string>();
    for (const s of per.values()) if (s.size > 1) { two++; for (const u of s) distinct.add(u); }
    return { span, two, distinct: [...distinct].sort().join(' ') };
  };
  const a = seam(src), b = seam(g);
  check(triCount(g) < triCount(src) * 0.2, `decimate: ${triCount(src)} → ${triCount(g)} triangles`);
  check(b.span < 0.5 && b.two > 3 && b.distinct === a.distinct, `decimate: uv seam kept (distinct seam u values before "${a.distinct}", after "${b.distinct}"; ${a.two} → ${b.two} seam points; max u span in a face ${b.span.toFixed(3)})`);
  const err = g.detail.get('error');
  check(err && (err.data as Float64Array)[0] > 0 && g.detail.get('error_abs'), `decimate: detail error = ${err ? (err.data as Float64Array)[0].toExponential(2) : 'missing'}`);
  // lock_border keeps the border points
  const grid: NodeSpec = { type: 'grid', params: { size: [2, 2], divisions: [20, 20] } };
  const gs = await cook({ g: grid, w: { type: 'wrangle', in: ['g'], params: { code: '@P.y = 0.1 * sin(@P.x * 3) * cos(@P.z * 2);' } } }, 'w');
  const gl = await cook({ g: grid, w: { type: 'wrangle', in: ['g'], params: { code: '@P.y = 0.1 * sin(@P.x * 3) * cos(@P.z * 2);' } }, d: { type: 'decimate', in: ['w'], params: { ratio: 0.1, lock_border: true, max_error: 1 } } }, 'd');
  const key = (x: Geometry, i: number) => pos(x, i).map((v) => v.toFixed(6)).join(',');
  const outPts = new Set(Array.from({ length: gl.numPoints }, (_, i) => key(gl, i)));
  let lost = 0, border = 0;
  for (let i = 0; i < gs.numPoints; i++) { const [x, , z] = pos(gs, i); if (Math.abs(Math.abs(x) - 1) < 1e-9 || Math.abs(Math.abs(z) - 1) < 1e-9) { border++; if (!outPts.has(key(gs, i))) lost++; } }
  check(border === 80 && lost === 0 && triCount(gl) < triCount(gs), `decimate lock_border: all ${border} border points kept (${triCount(gs)} → ${triCount(gl)} triangles)`);
  const gf = await cook({ g: grid, w: { type: 'wrangle', in: ['g'], params: { code: '@P.y = 0.1 * sin(@P.x * 3) * cos(@P.z * 2);' } }, d: { type: 'decimate', in: ['w'], params: { ratio: 0.1, lock_border: false, max_error: 1 } } }, 'd');
  check(triCount(gf) < triCount(gl), `decimate without lock_border reduces further (${triCount(gf)} < ${triCount(gl)})`);
  // fracture pieces (closed pieces with coincident unwelded points): every piece stays closed (meshoptimizer leaves
  // a two-sided "flap" there, which decimate removes)
  const fr: Record<string, NodeSpec> = { s: { type: 'sphere', params: { type: 'ico', level: 2 } }, f: { type: 'voronoi_fracture', in: ['s'], params: { count: 6 } } };
  const fd = await cook({ ...fr, d: { type: 'decimate', in: ['f'], params: { ratio: 0.3 } } }, 'd');
  check(watertight(fd) && topologyReport(fd).pieces === 6, `decimate fracture pieces: 6 closed pieces stay closed and manifold (${fd.numPrims} triangles)`);
  // points mode
  const pts = await cook({ g: grid, s: { type: 'scatter', in: ['g'], params: { count: 1000 } }, d: { type: 'decimate', in: ['s'], params: { ratio: 0.2 } } }, 'd');
  check(pts.numPoints <= 200 && pts.numPoints >= 180, `decimate points mode: 1000 → ${pts.numPoints} points (target 200)`);
  // attributes keep exact values (points are kept, not moved)
  const col = await cook({ s: { type: 'sphere', params: { type: 'ico', level: 4 } }, c: { type: 'color', in: ['s'], params: { mode: 'random' } }, d: { type: 'decimate', in: ['c'], params: { ratio: 0.3, max_error: 1 } } }, 'd');
  check(col.findAttrib('Cd') !== null && triCount(col) <= 0.3 * 5120 + 3, `decimate keeps Cd (${col.findAttrib('Cd')?.cls}) and reaches the ratio (${triCount(col)} triangles)`);
}

// ---------------------------------------------------------------- mesh_repair
const center = (g: Geometry, p: number) => { const pts = g.primPoints(p); const c = [0, 0, 0]; for (const q of pts) for (let k = 0; k < 3; k++) c[k] += g.P[q * 3 + k] / pts.length; return c; };
function allOutward(g: Geometry, c: number[]): boolean {
  for (let p = 0; p < g.numPrims; p++) {
    const n = primNewell(g, p), m = center(g, p);
    if (n[0] * (m[0] - c[0]) + n[1] * (m[1] - c[1]) + n[2] * (m[2] - c[2]) <= 0) return false;
  }
  return true;
}
const report = (g: Geometry) => JSON.parse((g.detail.get('repair_report')!.data as string[])[0]);
{
  // flipped faces
  const box: NodeSpec = { type: 'box', params: { divisions: [2, 2, 2] } };
  const flipped = await cook({ b: box, f: { type: 'reverse', in: ['b'], params: { group: '0-5' } } }, 'f');
  check(!halfEdges(flipped).isManifold, 'repair: the input with 6 reversed faces is inconsistent');
  const r = await cookR({ b: box, f: { type: 'reverse', in: ['b'], params: { group: '0-5' } }, m: { type: 'mesh_repair', in: ['f'] } }, 'm');
  const g = r.geo!;
  check(watertight(g) && signedVolume(g) > 0 && allOutward(g, [0, 0, 0]), `repair: winding fixed, every face outward, signed volume ${signedVolume(g).toFixed(4)}`);
  const rep = report(g);
  check(rep.flipped_faces === 6 && rep.input.prims === 24 && rep.output.closed === true, `repair: report JSON parses (flipped_faces ${rep.flipped_faces}, output closed ${rep.output.closed})`);
  check(r.warnings.some((w) => /faces flipped/.test(w.message)), 'repair: warns with a summary');
  const quiet = await cookR({ b: box, f: { type: 'reverse', in: ['b'], params: { group: '0-5' } }, m: { type: 'mesh_repair', in: ['f'], params: { warn: false } } }, 'm');
  check(quiet.ok && !quiet.warnings.length && report(quiet.geo!).flipped_faces === 6 && signedVolume(quiet.geo!) > 0, 'repair: warn false fixes the same and keeps the counts in repair_report only');
  // whole mesh inside out → turned outward
  const inv = await cook({ b: box, f: { type: 'reverse', in: ['b'] }, m: { type: 'mesh_repair', in: ['f'] } }, 'm');
  check(signedVolume(inv) > 0 && report(inv).flipped_pieces === 1, 'repair: an inside-out closed piece is turned outward');
  // duplicates
  const dup = await cook({ b: { type: 'box' }, c: { type: 'box' }, m: { type: 'merge', in: ['b', 'c'] }, r: { type: 'mesh_repair', in: ['m'] } }, 'r');
  check(dup.numPrims === 6 && dup.numPoints === 8 && watertight(dup) && report(dup).duplicate_faces === 6, `repair: duplicate faces removed (${dup.numPrims} prims, ${dup.numPoints} points)`);
  // small hole
  const hole = await cook({ b: box, d: { type: 'delete', in: ['b'], params: { group: '0' } }, r: { type: 'mesh_repair', in: ['d'] } }, 'r');
  check(watertight(hole) && hole.primGroups.get('filled')?.some((x) => x) && report(hole).holes_filled === 1, `repair: small hole filled (closed: ${topologyReport(hole).closed})`);
  const big = await cook({ b: box, d: { type: 'delete', in: ['b'], params: { group: '0' } }, r: { type: 'mesh_repair', in: ['d'], params: { max_hole_edges: 3 } } }, 'r');
  check(!topologyReport(big).closed && report(big).holes_left === 1, 'repair: holes above max_hole_edges stay open');
  // non-manifold edge: two cubes sharing an edge
  const two: Record<string, NodeSpec> = {
    a: { type: 'box' }, b: { type: 'box', params: { center: [1, 1, 0] } },
    m: { type: 'merge', in: ['a', 'b'] }, f: { type: 'fuse', in: ['m'] },
  };
  const nm = await cook(two, 'f');
  check(topologyReport(nm).nonManifoldEdges === 1, 'repair: two cubes sharing an edge have one non-manifold edge');
  const split = await cook({ ...two, r: { type: 'mesh_repair', in: ['f'] } }, 'r');
  const tr = topologyReport(split);
  check(watertight(split) && tr.pieces === 2 && report(split).split_points === 2, `repair split: manifold again (${tr.nonManifoldEdges} non-manifold edges, ${tr.pieces} pieces, ${report(split).split_points} points split)`);
  // touching solids that do not share points stay as they are (fuse borders only)
  const fr: Record<string, NodeSpec> = { s: { type: 'sphere', params: { type: 'ico', level: 2 } }, f: { type: 'voronoi_fracture', in: ['s'], params: { count: 6 } } };
  const frIn = await cook(fr, 'f'), frOut = await cook({ ...fr, r: { type: 'mesh_repair', in: ['f'] } }, 'r');
  check(frOut.numPrims === frIn.numPrims && watertight(frOut) && report(frOut).fused_points === 0, `repair: touching fracture pieces are left alone (${frOut.numPrims} prims, ${topologyReport(frOut).pieces} closed pieces)`);
  const frAll = await cook({ ...fr, r: { type: 'mesh_repair', in: ['f'], params: { fuse: 'all' } } }, 'r');
  check(report(frAll).fused_points > 0 && report(frAll).duplicate_faces > 0, `repair fuse all: touching pieces are welded and their shared walls removed (${report(frAll).duplicate_faces} faces)`);
  const rem = await cook({ ...two, r: { type: 'mesh_repair', in: ['f'], params: { non_manifold: 'remove', fill_holes: false } } }, 'r');
  check(topologyReport(rem).nonManifoldEdges === 0 && report(rem).non_manifold_faces_removed === 2, 'repair remove: the extra faces at the non-manifold edge are deleted');
  // zero-area sliver in a closed mesh: a tetrahedron whose edge 0-1 is split by point 4 on one side and closed by
  // the collinear triangle (0, 1, 4); the sliver goes and 4 joins the bottom face, so the mesh stays closed
  const sg = new Geometry({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0, 0],
    prims: [[0, 2, 1], [0, 4, 3], [4, 1, 3], [1, 2, 3], [0, 3, 2], [0, 1, 4]],
  });
  const sr = repairMesh(sg, { fuse: 'borders', tolerance: 0, degenerate: true, duplicates: true, nonManifold: 'split', winding: true, outward: true, fillHoles: true, maxHoleEdges: 8, isolated: true, selfIntersections: 'off' });
  check(sr.report.slivers_merged === 1 && sr.report.degenerate_faces === 1 && watertight(sr.geo) && sr.geo.numPrims === 5 && sr.report.holes_filled === 0,
    `repair: zero-area sliver merged into its neighbour, mesh still closed (${sr.geo.numPrims} prims, sizes ${Array.from({ length: sr.geo.numPrims }, (_, p) => sr.geo.primSize(p)).join(',')})`);
  // self-intersections
  const cross: Record<string, NodeSpec> = { a: { type: 'box' }, b: { type: 'box', params: { center: [0.5, 0.3, 0.2] } }, m: { type: 'merge', in: ['a', 'b'] } };
  const rep2 = await cook({ ...cross, r: { type: 'mesh_repair', in: ['m'], params: { self_intersections: 'report' } } }, 'r');
  const si = rep2.primGroups.get('self_intersecting');
  const nsi = si ? si.reduce((s, x) => s + x, 0) : 0;
  check(nsi > 0 && report(rep2).self_intersecting_faces === nsi, `repair: self-intersecting faces reported (${nsi} in group self_intersecting)`);
  const clean = await cook({ b: { type: 'box' }, r: { type: 'mesh_repair', in: ['b'], params: { self_intersections: 'report' } } }, 'r');
  check(report(clean).self_intersecting_faces === 0, 'repair: a clean box has no self-intersections');
  const rm = await cook({ ...cross, r: { type: 'mesh_repair', in: ['m'], params: { self_intersections: 'remove_faces' } } }, 'r');
  check(report(rm).self_intersecting_removed === nsi && rm.numPrims !== rep2.numPrims, `repair remove_faces: ${nsi} faces removed, holes filled (${report(rm).holes_filled})`);
}

// ---------------------------------------------------------------- lod
{
  const src: Record<string, NodeSpec> = { s: { type: 'sphere', params: { type: 'ico', level: 4 } }, c: { type: 'color', in: ['s'], params: { mode: 'random' } } };
  const g = await cook({ ...src, l: { type: 'lod', in: ['c'], params: { levels: 4 } } }, 'l');
  const lod = g.prims.get('lod')!.data as Int32Array, name = g.prims.get('name')!.data as string[];
  const counts = [0, 0, 0, 0];
  let namesOk = true;
  for (let p = 0; p < g.numPrims; p++) { counts[lod[p]]++; if (name[p] !== `mesh_LOD${lod[p]}`) namesOk = false; }
  check(counts.every((c, k) => !k || c < counts[k - 1]) && counts[0] === 5120, `lod: 4 levels with decreasing triangle counts ${counts.join(' > ')}`);
  check(namesOk, 'lod: names suffixed mesh_LOD0 … mesh_LOD3');
  const info = JSON.parse((g.detail.get('lod')!.data as string[])[0]);
  const lt = g.detail.get('lod_tris')!.getArray(0);
  check(info.length === 4 && info.every((x: any, k: number) => x.triangles === counts[k]) && lt.join() === counts.join(), `lod: detail lod lists the levels (${info.map((x: any) => `${x.level}:${x.triangles}`).join(' ')})`);
  const sw = await cook({ ...src, l: { type: 'lod', in: ['c'], params: { levels: 4, mode: 'switch', level: 2 } } }, 'l');
  const swl = sw.prims.get('lod')!.data as Int32Array;
  check(sw.numPrims === counts[2] && swl.every((x) => x === 2), `lod switch: level 2 only (${sw.numPrims} triangles)`);
  const named = await cook({ ...src, n: { type: 'attrib_create', in: ['c'], params: { name: 'name', class: 'prim', type: 'string', value: 'rock' } }, l: { type: 'lod', in: ['n'], params: { levels: 2 } } }, 'l');
  const nn = new Set(named.prims.get('name')!.data as string[]);
  check(nn.has('rock_LOD0') && nn.has('rock_LOD1') && nn.size === 2, `lod: existing names get the suffix (${[...nn].join(', ')})`);
  const ss = await cook({ s: src.s, l: { type: 'lod', in: ['s'], params: { screen_sizes: [1, 0.3, 0.05] } } }, 'l');
  const sl = ss.prims.get('lod')!.data as Int32Array, sc = [0, 0, 0];
  for (const x of sl) sc[x]++;
  check(sc[0] >= sc[1] && sc[1] > sc[2] && sc[2] > 0, `lod screen_sizes: error-driven levels ${sc.join(' ≥ ')}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
