// Polygon-editing tests: knife, polysplit (loop + path), edge_divide, polybridge, polyfill, dissolve,
// edge_collapse, loop:/ring: edge patterns, delete edge_mode dissolve.
//   node test/polyedit.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { edgeList, forEachPrimEdge } from '../src/core/edges.ts';
import { halfEdges } from '../src/core/halfedge.ts';
import { evalEdgeGroup } from '../src/core/groups.ts';
import { primArea, primNewell, topologyReport } from '../src/core/topology.ts';
import { orderChain, planeChords, quadQuality } from '../src/core/polyedit.ts';
import type { NodeSpec } from '../src/graph/types.ts';

const engine = new Engine(createNodeHost());
await engine.init();

let fail = 0, pass = 0;
const check = (ok: any, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};

async function cook(nodes: Record<string, NodeSpec>, output?: string): Promise<Geometry> {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return r.geo;
}
async function cookErr(nodes: Record<string, NodeSpec>, output?: string): Promise<string> {
  const r = await engine.cook({ nodes, output });
  return r.ok ? '' : r.errors.map((e) => e.message).join('; ');
}
const sum = (m: Uint8Array | null | undefined) => (m ? m.reduce((s, x) => s + x, 0) : -1);

/** Closed (no boundary, no non-manifold edge), consistently wound, every polygon has >= 3 distinct points. */
function watertight(g: Geometry): boolean {
  const r = topologyReport(g);
  if (!r.closed || r.degenerate) return false;
  const he = halfEdges(g);
  return he.isManifold;
}
/** No edge used by more than two polygon sides and no inconsistent winding (open meshes allowed). */
function manifold(g: Geometry): boolean {
  return halfEdges(g).isManifold;
}
const pos = (g: Geometry, i: number) => [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]];
const sortedPositions = (g: Geometry) => Array.from({ length: g.numPoints }, (_, i) => pos(g, i).map((v) => v.toFixed(6)).join(',')).sort().join(';');
const sizes = (g: Geometry) => { const s: Record<number, number> = {}; for (let p = 0; p < g.numPrims; p++) s[g.primSize(p)] = (s[g.primSize(p)] ?? 0) + 1; return s; };
const groupPrims = (g: Geometry, name: string) => { const m = g.primGroups.get(name); const out: number[] = []; if (m) m.forEach((x, i) => { if (x) out.push(i); }); return out; };
function planar(g: Geometry, prims: number[], tol = 1e-9): boolean {
  for (const p of prims) {
    const n = primNewell(g, p), l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-20) return false;
    const pts = g.primPoints(p), o = pos(g, pts[0]);
    for (const q of pts) { const x = pos(g, q); if (Math.abs(((x[0] - o[0]) * n[0] + (x[1] - o[1]) * n[1] + (x[2] - o[2]) * n[2]) / l) > tol) return false; }
  }
  return true;
}

// ---------------------------------------------------------------- planeChords unit cases
{
  // convex quad crossed once: corners + 0 - 0 (inserted points at 1 and 3)
  const P = [[0, 1, 0], [1, 0, 0], [0, -1, 0], [-1, 0, 0]];
  const ch = planeChords([1, 0, -1, 0], (k) => P[k], [1, 0, 0]);
  check(ch.length === 1 && new Set(ch[0]).size === 2 && ch[0].includes(1) && ch[0].includes(3), 'planeChords: convex polygon → one chord between the two crossings');
  // U shape crossing the plane four times: chords pair crossings along the line
  //   corners: 0(-) 1(0) 2(+) 3(+) 4(0) 5(-) 6(-) 7(0) 8(+) 9(+) 10(0) 11(-)  on x = 0, 1, 2, 3 crossings
  const U = [[0, -1, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0], [1, -0.5, 0], [2, -0.5, 0], [2, 0, 0], [2, 1, 0], [3, 1, 0], [3, 0, 0], [3, -1, 0]];
  const s = [-1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1];
  const ch2 = planeChords(s, (k) => U[k], [1, 0, 0]).map((c) => c.slice().sort((a, b) => a - b).join('-')).sort();
  check(ch2.join(' ') === '1-4 7-10', `planeChords: concave polygon crossing four times → two chords (${ch2.join(' ')})`);
}

// ---------------------------------------------------------------- knife
const BOX: NodeSpec = { type: 'box' };
{
  const g = await cook({ b: BOX, k: { type: 'knife', in: ['b'], params: { origin: [0, 0.1, 0], direction: [0, 1, 0] } } }, 'k');
  check(g.numPrims === 10 && watertight(g), `knife both on a box: 6 → 10 prims (4 crossed faces doubled), watertight (${g.numPrims})`);
  const cut = g.edgeGroups.get('cut')!;
  let loop = null;
  try { loop = orderChain(cut); } catch { /* not a chain */ }
  check(cut.size === 4 && loop?.closed && loop.points.length === 4, `knife: cut edge group is a closed loop of 4 edges (${cut.size})`);
  check(sum(g.pointGroups.get('cut')) === 4 && [...cut].every(([a, b]) => Math.abs(g.P[a * 3 + 1] - 0.1) < 1e-12 && Math.abs(g.P[b * 3 + 1] - 0.1) < 1e-12), 'knife: cut points lie on the plane');
  check(groupPrims(g, 'above').length === 5 && groupPrims(g, 'below').length === 5, 'knife: prim groups above/below');
  const above = await cook({ b: BOX, k: { type: 'knife', in: ['b'], params: { origin: [0, 0.1, 0], keep: 'above' } } }, 'k');
  check(above.numPrims === 5 && above.bbox().min[1] > 0.1 - 1e-12 && topologyReport(above).boundaryEdges === 4 && above.edgeGroups.get('cut')?.size === 4, 'knife keep above: 5 prims above the plane, cut edges = the open border');
  const tilted = await cook({ b: { type: 'box', params: { divisions: [3, 3, 3] } }, k: { type: 'knife', in: ['b'], params: { origin: [0.05, 0.02, 0], direction: [0.4, 1, 0.3] } } }, 'k');
  let cl = null;
  try { cl = orderChain(tilted.edgeGroups.get('cut')!); } catch { /* */ }
  check(watertight(tilted) && cl?.closed, `knife tilted plane on a divided box: watertight, cut is one closed loop (${tilted.edgeGroups.get('cut')?.size} edges)`);
  const two = await cook({ b: BOX, k: { type: 'knife', in: ['b'], params: { planes: [[[0, 0, 0], [1, 0, 0]], [[0, 0, 0], [0, 0, 1]]] } } }, 'k');
  check(two.numPrims === 16 && watertight(two) && two.edgeGroups.get('cut')?.size === 12 && sum(two.pointGroups.get('cut')) === 10, `knife with two planes: 16 prims, watertight, 12 cut edges, 10 cut points (${two.numPrims}, ${two.edgeGroups.get('cut')?.size}, ${sum(two.pointGroups.get('cut'))})`);
  // a plane through existing points: no new points, the existing edges are the cut
  const thru = await cook({ b: { type: 'box', params: { divisions: [2, 2, 2] } }, k: { type: 'knife', in: ['b'], params: { origin: [0, 0, 0] } } }, 'k');
  check(thru.numPoints === 26 && thru.numPrims === 24 && thru.edgeGroups.get('cut')?.size === 8, 'knife through existing points: nothing added, the 8 edges in the plane are grouped');
  // concave star: every piece lies on one side, total area kept
  const star = await cook({ s: { type: 'shape2d', params: { shape: 'star', radius: 1, inner_radius: 0.4, sides: 5 } }, k: { type: 'knife', in: ['s'], params: { origin: [0, 0, 0.55], direction: [0, 0, 1] } } }, 'k');
  const src = await cook({ s: { type: 'shape2d', params: { shape: 'star', radius: 1, inner_radius: 0.4, sides: 5 } } }, 's');
  let oneSide = true, area = 0;
  for (let p = 0; p < star.numPrims; p++) {
    area += primArea(star, p);
    const zs = star.primPoints(p).map((q) => star.P[q * 3 + 2] - 0.55);
    if (Math.min(...zs) < -1e-9 && Math.max(...zs) > 1e-9) oneSide = false;
  }
  check(star.numPrims >= 3 && oneSide && Math.abs(area - primArea(src, 0)) < 1e-9 && manifold(star), `knife on a concave star: ${star.numPrims} pieces, each on one side, area kept`);
  const line = await cook({ c: { type: 'curve', params: { points: [[0, -1, 0], [0.2, 0.5, 0], [0, 1, 0]] } }, k: { type: 'knife', in: ['c'] } }, 'k');
  check(line.numPrims === 2 && line.numPoints === 4 && !line.primClosed[0] && !line.primClosed[1], 'knife splits a polyline into two at the plane');
  const grp = await cook({ b: BOX, t: { type: 'group', in: ['b'], params: { name: 'side', pattern: '@P.x>0.4' } }, k: { type: 'knife', in: ['t'], params: { origin: [0, 0.1, 0], group: 'side' } } }, 'k');
  check(grp.numPrims === 7 && watertight(grp), 'knife group: only the grouped face is split, neighbours gain the cut points (watertight)');
  const uvOk = (() => {
    const uv = grp.vertices.get('uv');
    return !!uv && uv.count === grp.numVertices;
  })();
  check(uvOk, 'knife keeps vertex uv on the new corners');
}

// ---------------------------------------------------------------- polysplit
{
  const g = await cook({ b: BOX, s: { type: 'polysplit', in: ['b'], params: { edge: 'p0-1' } } }, 's');
  check(g.numPrims === 10 && watertight(g), `polysplit loop on a box ring: 6 → 10 prims, watertight (${g.numPrims})`);
  let l = null;
  try { l = orderChain(g.edgeGroups.get('split')!); } catch { /* */ }
  check(l?.closed && l.points.length === 4 && sum(g.pointGroups.get('split')) === 4, 'polysplit: edge group split is a closed loop of 4 edges, 4 new points');
  const b0 = await cook({ b: BOX }, 'b');
  const q = await cook({ b: BOX, s: { type: 'polysplit', in: ['b'], params: { edge: 'p0-1', fraction: 0.25 } } }, 's');
  const want = [0, 1, 2].map((c) => b0.P[c] * 0.75 + b0.P[3 + c] * 0.25);
  let found = false;
  for (let i = 8; i < q.numPoints; i++) if (pos(q, i).every((v, c) => Math.abs(v - want[c]) < 1e-12)) found = true;
  check(found, 'polysplit fraction is measured from the lower point number of the seed edge');
  const fl = await cook({ b: BOX, s: { type: 'polysplit', in: ['b'], params: { edge: 'p0-1', fraction: 0.25, flip: true } } }, 's');
  const want2 = [0, 1, 2].map((c) => b0.P[c] * 0.25 + b0.P[3 + c] * 0.75);
  let found2 = false;
  for (let i = 8; i < fl.numPoints; i++) if (pos(fl, i).every((v, c) => Math.abs(v - want2[c]) < 1e-12)) found2 = true;
  check(found2, 'polysplit flip measures from the other end');
  const c3 = await cook({ b: BOX, s: { type: 'polysplit', in: ['b'], params: { edge: 'p0-1', count: 3 } } }, 's');
  check(c3.numPrims === 18 && watertight(c3) && c3.edgeGroups.get('split')?.size === 12, `polysplit count 3: 18 prims, 12 split edges, watertight (${c3.numPrims})`);
  // open ring on a grid: crosses every quad of a row
  const gr = await cook({ g: { type: 'grid', params: { divisions: [4, 4] } }, s: { type: 'polysplit', in: ['g'], params: { edge: 'p0-5' } } }, 's');
  check(gr.numPrims === 20 && manifold(gr) && topologyReport(gr).boundaryEdges === 16 + 2, `polysplit open ring on a grid: 16 → 20 prims, boundary gets 2 new points (${gr.numPrims})`);
  // ring stopping at a non-quad: the n-gon gains the point and stays connected (tube with caps)
  const tube = await cook({ t: { type: 'tube', params: { cols: 8, rows: 1 } }, s: { type: 'polysplit', in: ['t'], params: { edge: 'p0-8' } } }, 's');
  check(tube.numPrims === 18 && watertight(tube) && Math.max(...Object.keys(sizes(tube)).map(Number)) === 8, `polysplit around a capped tube: 8 side quads split, caps unchanged, watertight (${tube.numPrims})`);
  // path mode
  const path = await cook({ g: { type: 'grid', params: { divisions: [4, 4] } }, s: { type: 'polysplit', in: ['g'], params: { mode: 'path', points: ['p0', 'p6', 'p12'] } } }, 's');
  check(path.numPrims === 18 && sizes(path)[3] === 4 && path.edgeGroups.get('split')?.size === 2 && manifold(path), `polysplit path on a grid: two quads split along their diagonals (${path.numPrims} prims)`);
  const path2 = await cook({ g: { type: 'grid', params: { divisions: [4, 4] } }, s: { type: 'polysplit', in: ['g'], params: { mode: 'path', points: 'p1-2:0.5 p6-7:0.5 p11-12:0.5' } } }, 's');
  check(path2.numPrims === 18 && manifold(path2) && path2.numPoints === 28 && topologyReport(path2).boundaryEdges === 16 + 1, `polysplit path through edge points: 2 quads split, neighbours gain the points (${path2.numPrims} prims, ${path2.numPoints} pts)`);
  const closedPath = await cook({ b: BOX, s: { type: 'polysplit', in: ['b'], params: { mode: 'path', points: ['p0-1:0.5', 'p1-2:0.5', 'p2-3:0.5', 'p3-0:0.5', 'p0-1:0.5'] } } }, 's');
  check(closedPath.numPrims === 10 && watertight(closedPath), `polysplit closed path inside one face: diamond + 4 corner triangles (${closedPath.numPrims})`);
  const bad = await cookErr({ g: { type: 'grid', params: { divisions: [4, 4] } }, s: { type: 'polysplit', in: ['g'], params: { mode: 'path', points: ['p0', 'p24'] } } }, 's');
  check(bad.includes('do not lie on a common polygon'), 'polysplit path: points without a common polygon → clear error');
}

// ---------------------------------------------------------------- edge_divide
{
  const loop = await cook({ b: BOX, d: { type: 'edge_divide', in: ['b'], params: { group: 'ring:p0-1', divisions: 2, connect: true } } }, 'd');
  const ref = await cook({ b: BOX, s: { type: 'polysplit', in: ['b'], params: { edge: 'p0-1' } } }, 's');
  check(loop.numPrims === 10 && watertight(loop) && sortedPositions(loop) === sortedPositions(ref) && loop.edgeGroups.get('divided')?.size === 4, 'edge_divide + connect on a ring = loop insertion (same points as polysplit)');
  const d3 = await cook({ b: BOX, d: { type: 'edge_divide', in: ['b'], params: { group: 'p0-1', divisions: 3 } } }, 'd');
  check(d3.numPrims === 6 && d3.numPoints === 10 && watertight(d3) && sizes(d3)[6] === 2 && sum(d3.pointGroups.get('divided')) === 2, 'edge_divide: 2 new points, both faces of the edge gain them, watertight');
  const eg = await cook({ b: BOX, e: { type: 'group', in: ['b'], params: { class: 'edge', name: 'e', pattern: 'p0-1' } }, d: { type: 'edge_divide', in: ['e'], params: { group: 'e', divisions: 4 } } }, 'd');
  check(eg.edgeGroups.get('e')?.size === 4, 'edge_divide: the edge group follows the child edges (1 → 4)');
  const crv = await cook({ c: { type: 'line', params: { points: 2 } }, d: { type: 'edge_divide', in: ['c'], params: { divisions: 5 } } }, 'd');
  check(crv.numPrims === 1 && crv.numVertices === 6, 'edge_divide divides polyline segments');
}

// ---------------------------------------------------------------- polybridge
{
  const g = await cook({
    b: BOX,
    br: { type: 'polybridge', in: ['b'], params: { source: '@P.y>0.4', target: '@P.y<-0.4', divisions: 2, delete_inner_faces: true } },
  }, 'br');
  check(groupPrims(g, 'bridge').length === 8 && g.numPrims === 12 && watertight(g) && topologyReport(g).euler === 0, `polybridge two square holes: 8 quads at divisions 2, closed tube (genus 1) (${groupPrims(g, 'bridge').length} bridge, ${g.numPrims} prims, euler ${topologyReport(g).euler})`);
  const tun = await cook({
    t: { type: 'tube', params: { cols: 16, rows: 3, height: 1.5 } },
    a: { type: 'group', in: ['t'], params: { name: 'ha', pattern: '16' } },
    c: { type: 'group', in: ['a'], params: { name: 'hb', pattern: '24' } },
    br: { type: 'polybridge', in: ['c'], params: { source: 'border:ha', target: 'border:hb', divisions: 4, delete_inner_faces: true, blend: 0.5 } },
  }, 'br');
  check(watertight(tun) && groupPrims(tun, 'bridge').length === 16 && tun.numPrims === 16 * 3 + 2 - 2 + 16, `polybridge tunnel through a capped tube: watertight, 16 bridge quads (${tun.numPrims} prims)`);
  // the tunnel runs inside the tube
  const br = groupPrims(tun, 'bridge');
  let inside = true;
  for (const p of br) for (const q of tun.primPoints(p)) if (Math.hypot(tun.P[q * 3], tun.P[q * 3 + 2]) > 0.5 + 1e-9) inside = false;
  check(inside, 'polybridge tunnel points stay inside the tube');
  // two open tubes side by side, U bend with blend 1
  const u = await cook({
    a: { type: 'tube', params: { cols: 8, caps: false, center: [-1, 0, 0], radius: 0.3 } },
    b: { type: 'tube', params: { cols: 8, caps: false, center: [1, 0, 0], radius: 0.3 } },
    m: { type: 'merge', in: ['a', 'b'] },
    br: { type: 'polybridge', in: ['m'], params: { source: 'p8-9-10-11-12-13-14-15-8', target: 'p24-25-26-27-28-29-30-31-24', divisions: 8, blend: 1 } },
  }, 'br');
  const ymax = u.bbox().max[1];
  check(manifold(u) && groupPrims(u, 'bridge').length === 64 && ymax > 0.5 + 0.3 && topologyReport(u).boundaryEdges === 16, `polybridge U bend (blend 1): manifold, 64 quads, arcs above the tubes (top y ${ymax.toFixed(3)})`);
  const straight = await cook({
    a: { type: 'tube', params: { cols: 8, caps: false, center: [-1, 0, 0], radius: 0.3 } },
    b: { type: 'tube', params: { cols: 8, caps: false, center: [1, 0, 0], radius: 0.3 } },
    m: { type: 'merge', in: ['a', 'b'] },
    br: { type: 'polybridge', in: ['m'], params: { source: 'p8-9-10-11-12-13-14-15-8', target: 'p24-25-26-27-28-29-30-31-24', divisions: 2, twist: 1 } },
  }, 'br');
  check(manifold(straight) && Math.abs(straight.bbox().max[1] - 0.5) < 1e-9, 'polybridge blend 0: straight rungs; twist keeps it manifold');
  // different counts: 8 → 12 points
  const mix = await cook({
    a: { type: 'tube', params: { cols: 8, caps: false, center: [0, 0, 0], radius: 0.4 } },
    b: { type: 'tube', params: { cols: 12, caps: false, center: [0, 2, 0], radius: 0.4 } },
    m: { type: 'merge', in: ['a', 'b'] },
    br: { type: 'polybridge', in: ['m'], params: { source: 'p8-9-10-11-12-13-14-15-8', target: 'p16-17-18-19-20-21-22-23-24-25-26-27-16', divisions: 3 } },
  }, 'br');
  const bs = groupPrims(mix, 'bridge');
  check(manifold(mix) && topologyReport(mix).boundaryEdges === 8 + 12 && bs.some((p) => mix.primSize(p) === 3) && bs.length >= 24, `polybridge 8 → 12 points: manifold strip by arc length with some triangles (${bs.length} faces)`);
  const err = await cookErr({ b: BOX, br: { type: 'polybridge', in: ['b'], params: { source: '@P.y>0.4 @P.x>0.4', target: '@P.y<-0.4' } } }, 'br');
  check(err.includes('branch') || err.includes('chain'), `polybridge: a source that is not one chain → clear error (${err.slice(0, 80)})`);
}

// ---------------------------------------------------------------- polyfill
{
  const tube = (mode: string, extra: Record<string, any> = {}) => cook({ t: { type: 'tube', params: { cols: 12, caps: false } }, f: { type: 'polyfill', in: ['t'], params: { mode, ...extra } } }, 'f');
  const q = await tube('quads');
  const fq = groupPrims(q, 'fill');
  check(fq.length === 12 && fq.every((p) => q.primSize(p) === 4) && planar(q, fq) && watertight(q), `polyfill quads on 12-point loops: all quads (${fq.length}), planar, watertight`);
  const gq = await tube('grid');
  const fg = groupPrims(gq, 'fill');
  check(fg.length === 18 && fg.every((p) => gq.primSize(p) === 4) && planar(gq, fg) && watertight(gq), `polyfill grid on 12-point loops: 3×3 grids (${fg.length} quads), planar, watertight`);
  let goodQuads = true;
  for (const p of fg) {
    const pts = gq.primPoints(p).map((i) => [gq.P[i * 3], gq.P[i * 3 + 2]]);
    const area = primArea(gq, p);
    // the caps lie in XZ planes; caps facing up and down wind opposite ways in (x, z)
    if (Math.max(quadQuality(pts), quadQuality(pts.slice().reverse())) < 0.3 || area < 1e-4) goodQuads = false;
  }
  check(goodQuads, 'polyfill grid: convex, reasonably shaped quads');
  const t = await tube('triangles');
  check(groupPrims(t, 'fill').length === 20 && groupPrims(t, 'fill').every((p) => t.primSize(p) === 3) && watertight(t), 'polyfill triangles: 10 per 12-gon, watertight');
  const s = await tube('single');
  check(groupPrims(s, 'fill').length === 2 && watertight(s), 'polyfill single: one n-gon per loop');
  const lim = await tube('quads', { max_edges: 8 });
  check(groupPrims(lim, 'fill').length === 0, 'polyfill max_edges skips larger loops');
  const one = await cook({ t: { type: 'tube', params: { cols: 12, caps: false } }, g: { type: 'group', in: ['t'], params: { class: 'point', name: 'top', pattern: '@P.y>0' } }, f: { type: 'polyfill', in: ['g'], params: { group: 'top' } } }, 'f');
  check(groupPrims(one, 'fill').length === 6 && topologyReport(one).boundaryEdges === 12, 'polyfill group: only the loop touching the point group');
  const odd = await cook({ t: { type: 'tube', params: { cols: 9, caps: false } }, f: { type: 'polyfill', in: ['t'], params: { mode: 'grid' } } }, 'f');
  check(watertight(odd) && groupPrims(odd, 'fill').filter((p) => odd.primSize(p) === 3).length === 2, 'polyfill grid on an odd loop falls back to quads (one triangle per loop)');
  // star hole: extruded star with its top removed
  const star = await cook({
    s: { type: 'shape2d', params: { shape: 'star', radius: 1, inner_radius: 0.5, sides: 5 } },
    e: { type: 'extrude', in: ['s'], params: { height: 0.3 } },
    d: { type: 'delete', in: ['e'], params: { group: 'top' } },
    f: { type: 'polyfill', in: ['d'], params: { mode: 'quads' } },
  }, 'f');
  const fs = groupPrims(star, 'fill');
  check(fs.length === 5 && fs.every((p) => star.primSize(p) === 4) && planar(star, fs) && watertight(star), `polyfill quads in a star hole: 5 convex kite quads, watertight (${fs.length})`);
  // concave, not star-shaped around its centroid (U shape): paired triangles
  const ush = await cook({
    s: { type: 'shape2d', params: { shape: 'U' } },
    e: { type: 'extrude', in: ['s'], params: { height: 0.3 } },
    d: { type: 'delete', in: ['e'], params: { group: 'top' } },
    f: { type: 'polyfill', in: ['d'], params: { mode: 'quads' } },
  }, 'f');
  const fu = groupPrims(ush, 'fill');
  check(watertight(ush) && fu.filter((p) => ush.primSize(p) === 4).length >= fu.length / 2, `polyfill quads in a U-shaped hole: quad-dominant (${fu.filter((p) => ush.primSize(p) === 4).length}/${fu.length} quads), watertight`);
}

// ---------------------------------------------------------------- dissolve
{
  const g = await cook({
    b: BOX,
    s: { type: 'polysplit', in: ['b'], params: { edge: 'p0-1' } },
    d: { type: 'dissolve', in: ['s'], params: { group: 'split' } },
  }, 'd');
  check(g.numPrims === 6 && g.numPoints === 8 && watertight(g) && Object.keys(sizes(g)).join() === '4', `dissolve the inserted loop on a box: back to 6 quads and 8 points (${g.numPrims}, ${g.numPoints})`);
  const keep = await cook({
    b: BOX,
    s: { type: 'polysplit', in: ['b'], params: { edge: 'p0-1' } },
    d: { type: 'dissolve', in: ['s'], params: { group: 'split', remove_inline_points: false } },
  }, 'd');
  check(keep.numPrims === 6 && keep.numPoints === 12 && watertight(keep), 'dissolve without remove_inline_points keeps the loop points (hexagons)');
  const grid = await cook({ g: { type: 'grid', params: { divisions: [4, 4] } }, d: { type: 'dissolve', in: ['g'] } }, 'd');
  check(grid.numPrims === 1 && grid.numPoints === 4, `dissolve every edge of a grid: one quad (${grid.numPrims} prims, ${grid.numPoints} pts)`);
  const pt = await cook({ g: { type: 'grid', params: { divisions: [4, 4] } }, d: { type: 'dissolve', in: ['g'], params: { class: 'point', group: '12' } } }, 'd');
  check(pt.numPrims === 13 && pt.numPoints === 24 && manifold(pt), `dissolve an interior point: its 4 quads merge, the point is gone (${pt.numPrims}, ${pt.numPoints})`);
  const bp = await cook({ g: { type: 'grid', params: { divisions: [4, 4] } }, d: { type: 'dissolve', in: ['g'], params: { class: 'point', group: '2' } } }, 'd');
  check(bp.numPrims === 15 && bp.numPoints === 24 && manifold(bp), 'dissolve a boundary point: its 2 quads merge, the point is removed');
  const reg = await cook({ g: { type: 'grid', params: { divisions: [4, 4] } }, d: { type: 'dissolve', in: ['g'], params: { group: '@P.x<0' } } }, 'd');
  check(groupPrims(reg, 'dissolved').length === 1 && manifold(reg), `dissolve a region: one merged polygon in group dissolved (${reg.numPrims} prims)`);
  const ring = await cook({ t: { type: 'torus', params: { rows: 8, cols: 12 } }, d: { type: 'dissolve', in: ['t'], params: { group: 'ring:p0-1' } } }, 'd');
  check(ring.numPrims === 96, 'dissolve a full ring (annulus outline): left unmerged with a warning');
  const del = await cook({ b: BOX, s: { type: 'polysplit', in: ['b'], params: { edge: 'p0-1' } }, d: { type: 'delete', in: ['s'], params: { class: 'edge', group: 'split', edge_mode: 'dissolve' } } }, 'd');
  check(del.numPrims === 6 && watertight(del), 'delete class edge with edge_mode dissolve merges faces instead of leaving holes');
}

// ---------------------------------------------------------------- edge_collapse
{
  const g = await cook({ b: BOX, c: { type: 'edge_collapse', in: ['b'], params: { group: 'border:0' } } }, 'c');
  check(g.numPrims === 5 && g.numPoints === 5 && watertight(g) && sizes(g)[3] === 4, `collapse all edges of one face: face removed, 4 sides become triangles, watertight (${g.numPrims} prims)`);
  const one = await cook({ b: BOX, c: { type: 'edge_collapse', in: ['b'], params: { group: 'p0-1' } } }, 'c');
  const b0 = await cook({ b: BOX }, 'b');
  const mid = [0, 1, 2].map((c) => (b0.P[c] + b0.P[3 + c]) / 2);
  const cp = one.pointGroups.get('collapsed')!;
  const ci = cp.indexOf(1);
  check(one.numPrims === 6 && one.numPoints === 7 && watertight(one) && sizes(one)[3] === 2 && pos(one, ci).every((v, c) => Math.abs(v - mid[c]) < 1e-12), 'collapse one edge: midpoint, its two quads become triangles, watertight');
  const first = await cook({ b: BOX, c: { type: 'edge_collapse', in: ['b'], params: { group: 'p0-1', mode: 'first' } } }, 'c');
  check(pos(first, first.pointGroups.get('collapsed')!.indexOf(1)).every((v, c) => Math.abs(v - b0.P[c]) < 1e-12), 'collapse mode first keeps the lower-numbered point');
  const chain = await cook({ g: { type: 'grid', params: { divisions: [4, 4] } }, c: { type: 'edge_collapse', in: ['g'], params: { group: 'p6-7-8' } } }, 'c');
  check(chain.numPoints === 23 && chain.numPrims === 16 && sizes(chain)[3] === 4 && manifold(chain), `collapse a chain of 2 edges: 3 points → 1, the 4 quads on the chain become triangles (${chain.numPrims} prims, ${chain.numPoints} pts)`);
  const tri = await cook({ s: { type: 'sphere', params: { type: 'ico', level: 1 } }, c: { type: 'edge_collapse', in: ['s'], params: { group: 'p0-12' } } }, 'c');
  check(watertight(tri) && tri.numPrims === 78, `collapse an edge of a triangle mesh: 2 triangles removed, watertight (${tri.numPrims})`);
  const eg = await cook({ b: BOX, e: { type: 'group', in: ['b'], params: { class: 'edge', name: 'rim', pattern: '@P.y>0.4' } }, c: { type: 'edge_collapse', in: ['e'], params: { group: 'p0-1' } } }, 'c');
  check((eg.edgeGroups.get('rim')?.size ?? 0) >= 3, `collapse: edge groups follow the merged points (${eg.edgeGroups.get('rim')?.size})`);
}

// ---------------------------------------------------------------- loop: / ring: patterns
{
  const torus = await cook({ t: { type: 'torus', params: { rows: 16, cols: 48 } } }, 't');
  const loop = evalEdgeGroup(torus, 'loop:p0-1'), ring = evalEdgeGroup(torus, 'ring:p0-1');
  check(loop.size === 16 && ring.size === 48, `torus: loop:p0-1 selects the 16-edge minor loop, ring:p0-1 its 48 rungs (${loop.size}, ${ring.size})`);
  const loop2 = evalEdgeGroup(torus, 'loop:p0-16');
  check(loop2.size === 48, `torus: loop:p0-16 runs around the major circle (${loop2.size})`);
  const grid = await cook({ g: { type: 'grid', params: { divisions: [10, 10] } } }, 'g');
  check(evalEdgeGroup(grid, 'loop:p60-61').size === 10 && evalEdgeGroup(grid, 'ring:p60-61').size === 11, 'grid: loop 10 edges, ring 11 rungs');
  check(evalEdgeGroup(grid, 'loop:p60-61 loop:p60-71').size === 20 && evalEdgeGroup(grid, 'ring:p0-1').size === 11, 'loop/ring of several seeds, boundary seeds');
  const box = await cook({ b: BOX }, 'b');
  check(evalEdgeGroup(box, 'ring:p0-1').size === 4 && evalEdgeGroup(box, 'loop:p0-1').size === 1, 'box: ring of 4 edges, loop stops at the 3-valent corners');
  const named = await cook({ g: { type: 'grid', params: { divisions: [10, 10] } }, e: { type: 'group', in: ['g'], params: { class: 'edge', name: 'seed', pattern: 'p60-61' } }, x: { type: 'group', in: ['e'], params: { class: 'edge', name: 'lp', pattern: 'loop:seed' } } }, 'x');
  check(named.edgeGroups.get('lp')?.size === 10, 'loop: works on a named edge group');
}

// ---------------------------------------------------------------- attributes and normals
{
  const g = await cook({ s: { type: 'sphere', params: { type: 'uv', rows: 8, cols: 12 } }, k: { type: 'knife', in: ['s'], params: { origin: [0, 0.3, 0], direction: [0.3, 1, 0.2] } } }, 'k');
  const N = g.points.get('N')!.data as Float64Array;
  let unitN = true;
  for (let i = 0; i < g.numPoints; i++) if (Math.abs(Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) - 1) > 1e-9) unitN = false;
  check(watertight(g) && unitN, 'knife on a uv sphere: watertight, point normals refreshed (unit length)');
  let ok = true;
  forEachPrimEdge(g, () => {});
  const L = edgeList(g);
  for (let i = 0; i < L.count; i++) if (L.polyCount[i] !== 2) ok = false;
  check(ok, 'knife on a sphere: every edge shared by exactly two polygons');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
