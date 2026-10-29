// poly_bevel tests: edge chamfers and round bevels, corner patches, mitres, clamping, point bevels, attributes,
// skipped edges and watertightness.
//   node test/bevel.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { primArea, primCentroid, primNormals, signedVolume, topologyReport } from '../src/core/topology.ts';
import { bevelEdges, profilePoint, shapeExponent } from '../src/core/bevel.ts';
import { EdgeSet } from '../src/core/edges.ts';
import { halfEdges } from '../src/core/halfedge.ts';
import type { NodeSpec } from '../src/graph/types.ts';
import { checkGeo } from './fixtures.ts';

const engine = new Engine(createNodeHost());
await engine.init();

let fail = 0, pass = 0;
const check = (ok: any, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};

async function cookR(nodes: Record<string, NodeSpec>, output?: string) {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return { geo: r.geo, warnings: r.warnings.map((w) => w.message) };
}
const bevel = async (src: Record<string, NodeSpec>, params: Record<string, any>) =>
  cookR({ ...src, bev: { type: 'poly_bevel', in: [Object.keys(src).pop()!], params } }, 'bev');
const count = (m: Uint8Array | undefined) => (m ? m.reduce((s, x) => s + x, 0) : -1);
const members = (g: Geometry, grp: string) => { const m = g.primGroups.get(grp); const out: number[] = []; if (m) m.forEach((x, i) => { if (x) out.push(i); }); return out; };
const watertight = (g: Geometry) => { const t = topologyReport(g); return t.closed && t.boundaryEdges === 0 && t.nonManifoldEdges === 0 && t.degenerate === 0; };
/** Every prim of a convex closed result faces away from the centre and has positive area. */
function outward(g: Geometry, prims: number[], center: number[]) {
  const N = primNormals(g);
  for (const p of prims) {
    const c = primCentroid(g, p);
    const d = (c[0] - center[0]) * N[p * 3] + (c[1] - center[1]) * N[p * 3 + 1] + (c[2] - center[2]) * N[p * 3 + 2];
    if (!(d > 0) || !(primArea(g, p) > 0)) return false;
  }
  return true;
}
const all = (g: Geometry) => Array.from({ length: g.numPrims }, (_, i) => i);
const BOX = { b: { type: 'box' } } as Record<string, NodeSpec>;

// ---------------------------------------------------------------- profile helper
{
  const p0: [number, number, number] = [1, 0, 0], p1: [number, number, number] = [0, 1, 0], c: [number, number, number] = [1, 1, 0];
  const r = shapeExponent(0);
  let onCircle = true;
  for (let s = 0; s <= 1; s += 0.125) { const p = profilePoint(p0, p1, c, s, r); if (Math.abs(Math.hypot(p[0], p[1]) - 1) > 1e-12) onCircle = false; }
  check(r === 2 && onCircle, 'profile: shape 0 is a circular arc tangent at both ends');
  const flat = profilePoint(p0, p1, c, 0.5, shapeExponent(-0.5)), bulge = profilePoint(p0, p1, c, 0.5, shapeExponent(1));
  check(Math.abs(flat[0] - 0.5) < 1e-12 && Math.abs(flat[1] - 0.5) < 1e-12, 'profile: shape -0.5 is the straight chord');
  check(bulge[0] > 0.9 && bulge[1] > 0.9, 'profile: shape 1 bulges out towards the corner');
}

// ---------------------------------------------------------------- box chamfer, every edge
const d = 0.1;
{
  const { geo: g, warnings } = await bevel(BOX, { offset: d });
  const strips = members(g, 'bevel').filter((p) => !members(g, 'bevel_corner').includes(p));
  const corners = members(g, 'bevel_corner');
  check(g.numPrims === 26 && strips.length === 12 && corners.length === 8, `box chamfer: 26 prims = 6 faces + 12 strips + 8 corners (got ${g.numPrims}, ${strips.length}, ${corners.length})`);
  check(corners.every((p) => g.primSize(p) === 3) && strips.every((p) => g.primSize(p) === 4), 'box chamfer: corners are triangles, strips are quads');
  check(watertight(g) && !checkGeo(g).length, 'box chamfer: watertight, valid');
  const V = signedVolume(g), exact = 1 - 6 * d * d + (16 / 3) * d ** 3, twice = 1 - 6 * (2 * d) ** 2 + (16 / 3) * (2 * d) ** 3;
  check(V < 1 && V > twice, `box chamfer: volume ${V.toFixed(6)} below the box and above the box chamfered by twice the offset (${twice.toFixed(6)})`);
  check(Math.abs(V - exact) < 1e-9, `box chamfer: volume equals 1 - 6d² + 16/3 d³ = ${exact.toFixed(6)}`);
  check(outward(g, all(g), [0, 0, 0]), 'box chamfer: every prim faces outward with positive area');
  check(g.edgeGroups.get('bevel_edges')?.size === 24, `box chamfer: bevel_edges = the 24 strip sides (got ${g.edgeGroups.get('bevel_edges')?.size})`);
  check(!warnings.length, 'box chamfer: no warnings');
  // offset measured across the faces: the top face shrinks by d on every side
  const top = all(g).find((p) => !members(g, 'bevel').includes(p) && primCentroid(g, p)[1] > 0.49)!;
  const xs = g.primPoints(top).map((q) => Math.abs(g.P[q * 3]));
  check(xs.every((x) => Math.abs(x - (0.5 - d)) < 1e-12), 'box chamfer: faces shrink by the offset');
  // a second bevel on bevel_edges refines the first and stays watertight
  const { geo: g2 } = await cookR({ b: { type: 'box' }, v1: { type: 'poly_bevel', in: ['b'], params: { offset: d } }, v2: { type: 'poly_bevel', in: ['v1'], params: { group: 'bevel_edges', offset: 0.02, divisions: 2 } } }, 'v2');
  check(watertight(g2) && g2.numPrims > g.numPrims, `second bevel on bevel_edges: watertight (${g2.numPrims} prims)`);
}

// ---------------------------------------------------------------- box round
{
  const { geo: g } = await bevel(BOX, { offset: d, divisions: 2 });
  const corners = members(g, 'bevel_corner');
  const strips = members(g, 'bevel').filter((p) => !corners.includes(p));
  check(strips.length === 36, `box round divisions 2: 12 x 3 strips (got ${strips.length})`);
  check(watertight(g) && !checkGeo(g).length, 'box round: watertight, valid');
  const chamferV = 1 - 6 * d * d + (16 / 3) * d ** 3, V = signedVolume(g);
  check(V > chamferV && V < 1, `box round: volume ${V.toFixed(5)} between chamfer and box`);
  check(outward(g, all(g), [0, 0, 0]), 'box round: every prim faces outward');
  // corner patches are sphere octants of radius d around the corner's inner centre (shape 0)
  for (const n of [2, 3, 5]) {
    const { geo: h } = await bevel(BOX, { offset: d, divisions: n });
    let worst = 0;
    for (const p of members(h, 'bevel_corner'))
      for (const q of h.primPoints(p)) {
        const x = h.P[q * 3], y = h.P[q * 3 + 1], z = h.P[q * 3 + 2];
        const c = [Math.sign(x) * (0.5 - d), Math.sign(y) * (0.5 - d), Math.sign(z) * (0.5 - d)];
        worst = Math.max(worst, Math.abs(Math.hypot(x - c[0], y - c[1], z - c[2]) - d));
      }
    check(worst < 1e-9 && watertight(h), `box round divisions ${n}: corner patches lie on spheres of radius d (max error ${worst.toExponential(1)}), watertight`);
  }
  const { geo: q } = await bevel(BOX, { offset: d, divisions: 3 });
  check(members(q, 'bevel_corner').every((p) => q.primSize(p) === 4), 'box round divisions 3: corner patches are all quads');
  for (const shape of [-1, -0.5, 0.6, 1]) {
    const { geo: s } = await bevel(BOX, { offset: 0.2, divisions: 4, shape });
    check(watertight(s), `box round shape ${shape}: watertight`);
  }
}

// ---------------------------------------------------------------- clamp
{
  const { geo: g, warnings } = await bevel(BOX, { offset: 10 });
  const bev = members(g, 'bevel');
  check(watertight(g), 'clamp: huge offset stays watertight');
  check(outward(g, bev, [0, 0, 0]), 'clamp: strips and corners keep positive area and outward normals');
  check(warnings.some((w) => /clamped|reduced/.test(w)), 'clamp: warns that the offset was reduced');
  const bb = g.bbox();
  check(bb.min.every((x) => x >= -0.5 - 1e-12) && bb.max.every((x) => x <= 0.5 + 1e-12) && signedVolume(g) > 0.16, `clamp: stays inside the box, volume ${signedVolume(g).toFixed(4)} (octahedron limit 1/6)`);
  const { geo: r } = await bevel(BOX, { offset: 10, divisions: 3 });
  check(watertight(r) && outward(r, members(r, 'bevel'), [0, 0, 0]), 'clamp: huge round offset watertight and outward');
  const { geo: top } = await bevel({ b: { type: 'box', params: { size: [2, 0.3, 1] } } }, { offset: 5, group: 'angle>80 ^@P.y<0' });
  check(watertight(top) && outward(top, all(top), [0, 0, 0]), 'clamp: thin slab top edges, huge offset, watertight and outward');
  const { geo: u, warnings: uw } = await bevel(BOX, { offset: 0.8, clamp: false });
  check(u.numPrims === 26 && !uw.some((w) => w.includes('clamped')), 'clamp off: cooks unclamped (overlapping is the user\'s choice)');
}

// ---------------------------------------------------------------- top edges only (terminating at unbevelled points)
{
  const { geo: g } = await cookR({
    b: { type: 'box' },
    grp: { type: 'group', in: ['b'], params: { class: 'edge', name: 'rim', pattern: 'angle>80 ^@P.y<0.4' } },
    v: { type: 'poly_bevel', in: ['grp'], params: { group: 'rim', offset: d } },
  }, 'v');
  check(g.numPrims === 10 && count(g.primGroups.get('bevel')) === 4 && count(g.primGroups.get('bevel_corner')) === 0, 'box top edges: 4 strips, mitred corners need no patch');
  check(watertight(g) && outward(g, all(g), [0, 0, 0]), 'box top edges: watertight, outward');
  // depth t below the top keeps a square of side 1 - 2d + 2t: removed = ∫0..d 1 - (1 - 2d + 2t)² dt
  const removed = 0.5 * (2 / 3 - (1 - 2 * d) + (1 - 2 * d) ** 3 / 3);
  check(Math.abs(signedVolume(g) - (1 - removed)) < 1e-9, `box top edges: volume = box - mitred chamfer (${(1 - removed).toFixed(6)})`);
  const { geo: r } = await bevel(BOX, { offset: d, group: 'p0-1', divisions: 3 });
  check(watertight(r) && r.numPrims === 10, 'single round edge ending at unbevelled points: watertight, end faces take the profile');
  const ends = all(r).filter((p) => r.primSize(p) > 4);
  check(ends.length === 2 && ends.every((p) => r.primSize(p) === 4 + 1 + 3), 'single round edge: both end faces gain the 3 profile points');
}

// ---------------------------------------------------------------- uv
{
  const { geo: src } = await cookR(BOX, 'b');
  const { geo: g } = await bevel(BOX, { offset: d, group: 'angle>80 ^@P.y<0.4' });
  const uvOf = (geo: Geometry) => geo.vertices.get('uv')!.data as Float64Array;
  const bottomFace = (geo: Geometry) => all(geo).find((p) => primCentroid(geo, p)[1] < -0.49)!;
  const fs = bottomFace(src), fg = bottomFace(g);
  const key = (geo: Geometry, v: number) => { const q = geo.vertexPoint[v]; return [geo.P[q * 3], geo.P[q * 3 + 1], geo.P[q * 3 + 2]].map((x) => x.toFixed(9)).join(','); };
  const want = new Map<string, string>();
  for (let v = src.primStart[fs]; v < src.primStart[fs + 1]; v++) want.set(key(src, v), Array.from(uvOf(src).slice(v * 3, v * 3 + 3)).join(','));
  let same = g.primSize(fg) === 4;
  for (let v = g.primStart[fg]; v < g.primStart[fg + 1]; v++) if (want.get(key(g, v)) !== Array.from(uvOf(g).slice(v * 3, v * 3 + 3)).join(',')) same = false;
  check(same, 'uv: unaffected faces keep their vertex uv exactly');
  // inside a shrunk face uv follows the face's own (affine) mapping
  const topF = (geo: Geometry) => all(geo).find((p) => !geo.primGroups.get('bevel')?.[p] && primCentroid(geo, p)[1] > 0.49)!;
  const ts = topF(src), tg = topF(g);
  const sUV = (geo: Geometry, v: number) => Array.from(uvOf(geo).slice(v * 3, v * 3 + 2));
  // fit uv = A·(x, z) + b from the source top face
  const rows: number[][] = [];
  for (let v = src.primStart[ts]; v < src.primStart[ts + 1]; v++) { const q = src.vertexPoint[v]; rows.push([src.P[q * 3], src.P[q * 3 + 2], ...sUV(src, v)]); }
  const [p0, p1, p2] = rows;
  const det = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  const interp = (x: number, z: number) => {
    const a = ((x - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (z - p0[1])) / det, b = ((p1[0] - p0[0]) * (z - p0[1]) - (x - p0[0]) * (p1[1] - p0[1])) / det;
    return [0, 1].map((c) => p0[2 + c] + a * (p1[2 + c] - p0[2 + c]) + b * (p2[2 + c] - p0[2 + c]));
  };
  let err = 0;
  for (let v = g.primStart[tg]; v < g.primStart[tg + 1]; v++) {
    const q = g.vertexPoint[v], e = interp(g.P[q * 3], g.P[q * 3 + 2]), u = sUV(g, v);
    err = Math.max(err, Math.abs(e[0] - u[0]), Math.abs(e[1] - u[1]));
  }
  check(err < 1e-9, `uv: shrunk faces interpolate their own uv (max error ${err.toExponential(1)})`);
  const { geo: grid } = await bevel({ g: { type: 'grid', params: { size: [2, 2], divisions: [4, 4] } } }, { offset: 0.1, group: 'p6-7 p7-8' });
  const puv = grid.points.get('uv')!.data as Float64Array;
  let perr = 0;
  for (let q = 0; q < grid.numPoints; q++) perr = Math.max(perr, Math.abs(puv[q * 3] - (grid.P[q * 3] + 1) / 2), Math.abs(puv[q * 3 + 1] - (1 - grid.P[q * 3 + 2]) / 2));
  check(perr < 1e-9, `uv: point uv of new points is interpolated along edges / inside faces (max error ${perr.toExponential(1)})`);
}

// ---------------------------------------------------------------- cylinder: top ring only
{
  const cols = 24, r0 = 0.5;
  const tube = { t: { type: 'tube', params: { cols, radius: r0 } } } as Record<string, NodeSpec>;
  const { geo: src } = await cookR(tube, 't');
  for (const n of [0, 3]) {
    const { geo: g } = await bevel(tube, { offset: d, group: '@P.y>0.4', divisions: n });
    check(watertight(g) && count(g.primGroups.get('bevel')) === cols * (n + 1) && count(g.primGroups.get('bevel_corner')) === 0, `cylinder top ring, divisions ${n}: ${cols}x${n + 1} strips, mitred, watertight`);
    const cap = all(g).find((p) => g.primSize(p) === cols && primCentroid(g, p)[1] > 0.49)!;
    const want = r0 - d / Math.cos(Math.PI / cols);
    check(g.primPoints(cap).every((q) => Math.abs(Math.hypot(g.P[q * 3], g.P[q * 3 + 2]) - want) < 1e-9), 'cylinder: top cap shrinks by the offset (mitred meet points)');
    const bot = (geo: Geometry) => { const p = all(geo).find((x) => geo.primSize(x) === cols && primCentroid(geo, x)[1] < -0.49)!; return geo.primPoints(p).map((q) => [0, 1, 2].map((c) => geo.P[q * 3 + c].toFixed(9)).join(',')).join(';'); };
    check(bot(g) === bot(src), 'cylinder: bottom cap unaffected');
    check(outward(g, members(g, 'bevel'), [0, 0, 0]), 'cylinder: strips face outward');
  }
  const { geo: big } = await bevel(tube, { offset: 3, group: '@P.y>0.4' });
  check(watertight(big), 'cylinder: clamped huge rim bevel stays watertight');
}

// ---------------------------------------------------------------- n-gons, concave faces, triangles, open meshes
{
  const star = { s: { type: 'shape2d', params: { shape: 'star', radius: 1, inner_radius: 0.5, sides: 5 } }, e: { type: 'extrude', in: ['s'], params: { height: 0.4 } } } as Record<string, NodeSpec>;
  const { geo: rim } = await bevel(star, { group: 'border:top', offset: 0.05, divisions: 3 });
  check(watertight(rim) && count(rim.primGroups.get('bevel')) === 40, 'star rim (concave 10-gon): watertight, 10 x 4 strips');
  check(count(rim.primGroups.get('top')) === 1, 'star rim: new prims do not join the input prim groups');
  const { geo: sharp } = await bevel(star, { group: 'angle>30', offset: 0.05, divisions: 2 });
  check(watertight(sharp) && members(sharp, 'bevel').every((p) => primArea(sharp, p) > 0), 'star, every sharp edge (convex and concave): watertight, positive areas');
  const { geo: ch } = await bevel(star, { group: 'angle>30', offset: 0.05 });
  check(watertight(ch) && Math.abs(signedVolume(ch)) < Math.abs(signedVolume((await cookR(star, 'e')).geo)) + 1e-3, 'star chamfer: watertight');
  const { geo: ico } = await bevel({ s: { type: 'sphere', params: { type: 'ico', level: 1 } } }, { offset: 0.05, divisions: 2 });
  check(watertight(ico) && outward(ico, all(ico), [0, 0, 0]), 'ico sphere (triangles, valence 5/6), every edge: watertight, outward');
  const { geo: tri } = await bevel({ b: { type: 'box' }, t: { type: 'triangulate', in: ['b'] } }, { offset: 0.1, group: 'angle>45', divisions: 2 });
  check(watertight(tri), 'triangulated box, sharp edges only (mixed with flat diagonals): watertight');
  const { geo: sub } = await bevel({ b: { type: 'box', params: { divisions: [2, 2, 2] } } }, { offset: 0.1, divisions: 2 });
  check(watertight(sub), 'subdivided box, every edge (flat ones too): watertight');
  const { geo: tor } = await bevel({ t: { type: 'torus', params: { rows: 8, cols: 16 } } }, { offset: 0.03, divisions: 1 });
  check(watertight(tor), 'torus (saddle points), every edge: watertight');
  const open = { b: { type: 'box' }, d: { type: 'delete', in: ['b'], params: { group: '@P.y<-0.4' } } } as Record<string, NodeSpec>;
  const { geo: o } = await bevel(open, { offset: 0.1, divisions: 2 });
  const to = topologyReport(o);
  check(to.nonManifoldEdges === 0 && to.degenerate === 0 && to.pieces === 1 && to.boundaryEdges > 0, `open box (points on the boundary): manifold, ${to.boundaryEdges} boundary edges`);
  const { geo: ob, warnings: ow } = await bevel(open, { offset: 0.1, group: 'boundary' });
  check(ob.numPrims === 5 && ow.some((w) => w.includes('boundary edge')), 'boundary edges in the group: skipped with a warning');
  const { geo: fr } = await bevel({ b: { type: 'box', params: { size: [4, 0.2, 1] } } }, { offset: 0.3, offset_mode: 'fraction', divisions: 2 });
  check(watertight(fr) && outward(fr, all(fr), [0, 0, 0]), 'fraction mode on a thin slab: watertight, outward');
}

// ---------------------------------------------------------------- point mode
{
  const { geo: g } = await bevel(BOX, { mode: 'points', group: '0', offset: 0.2 });
  const c = members(g, 'bevel_corner');
  check(c.length === 1 && g.primSize(c[0]) === 3 && g.numPrims === 7, 'point mode: a box corner becomes a triangle');
  check(watertight(g) && outward(g, all(g), [0, 0, 0]), 'point mode: watertight, outward');
  check(Math.abs(signedVolume(g) - (1 - 0.2 ** 3 / 6)) < 1e-9, 'point mode: volume = box - corner tetrahedron');
  const { geo: r } = await bevel(BOX, { mode: 'points', offset: 0.2, divisions: 3 });
  check(watertight(r) && outward(r, all(r), [0, 0, 0]) && count(r.primGroups.get('bevel_corner')) === 8 * (3 * 3 + 3), 'point mode, every corner, 3 divisions: domes of 3 rings, watertight');
  check(signedVolume(r) > 1 - 8 * 0.2 ** 3 / 6 && signedVolume(r) < 1, 'point mode round: domes bulge out of the flat cut');
  const { geo: h } = await bevel(BOX, { mode: 'points', offset: 9 });
  check(watertight(h), 'point mode: clamped huge offset stays watertight');
}

// ---------------------------------------------------------------- no match, non-manifold, normals, determinism
{
  const { geo: src } = await cookR(BOX, 'b');
  const { geo: g, warnings } = await bevel(BOX, { group: 'angle>100' });
  check(g.numPrims === src.numPrims && g.numPoints === src.numPoints && warnings.some((w) => w.includes('unchanged')), 'no matching edges: input unchanged, with a warning');
  // a box with a fin sharing one of its edges: the non-manifold edge (and its points) are skipped, the rest bevels
  const { geo: nm, warnings: nw } = await cookR({
    b: { type: 'box' },
    f: { type: 'wrangle', in: ['b'], params: { run_over: 'detail', code: 'const p = addpoint(0, [0, 1.2, 0.5]); addprim(0, "poly", [3, 2, p]);' } },
    v: { type: 'poly_bevel', in: ['f'], params: { offset: 0.05 } },
  }, 'v');
  check(nw.some((w) => w.includes('non-manifold')) && count(nm.primGroups.get('bevel')) > 0, `non-manifold edge in the group: warns and still bevels the rest (${nw.join('; ')})`);
  const raw = new Geometry({ positions: [0, 0, 0, 1, 0, 0, 0.5, 1, 0, 0.5, -1, 0, 0.5, 0, 1], prims: [[0, 1, 2], [1, 0, 3], [0, 1, 4]] });
  const rr = bevelEdges(raw, null, { offset: 0.1 });
  check(rr.geo === raw && rr.warnings.some((w) => w.includes('non-manifold')), 'kernel: three triangles on one edge → warning, input returned');
  const { geo: sph } = await bevel({ s: { type: 'sphere', params: { rows: 8, cols: 12 } } }, { offset: 0.03, divisions: 1, group: 'angle>20' });
  const N = sph.points.get('N');
  let unitN = !!N;
  if (N) for (let q = 0; q < sph.numPoints; q++) if (Math.abs(Math.hypot(N.data[q * 3] as number, N.data[q * 3 + 1] as number, N.data[q * 3 + 2] as number) - 1) > 1e-9) unitN = false;
  check(unitN && watertight(sph), 'point N is recomputed (unit length) on the bevelled mesh');
  // vertex N: a chamfer stays crisp (strip corners use the strip's own normal), a round bevel shades smoothly
  const vN = async (divisions: number) => (await cookR({ b: { type: 'box' }, n: { type: 'normal', in: ['b'], params: { class: 'vertex' } }, v: { type: 'poly_bevel', in: ['n'], params: { offset: 0.1, divisions } } }, 'v')).geo;
  const flatShaded = (geo: Geometry, prims: number[]) => {
    const fn = primNormals(geo), vn = geo.vertices.get('N')!.data as Float64Array;
    return prims.every((p) => { for (let v = geo.primStart[p]; v < geo.primStart[p + 1]; v++) if (Math.abs(vn[v * 3] * fn[p * 3] + vn[v * 3 + 1] * fn[p * 3 + 1] + vn[v * 3 + 2] * fn[p * 3 + 2] - 1) > 1e-9) return false; return true; });
  };
  const ch = await vN(0), rd = await vN(4);
  check(flatShaded(ch, all(ch)), 'vertex N, chamfer: every prim keeps hard (flat) normals');
  check(!flatShaded(rd, members(rd, 'bevel')), 'vertex N, round bevel: strips are smooth shaded');
  const a = (await bevel(BOX, { offset: 0.13, divisions: 3 })).geo, b = (await cookR({ b: { type: 'box' }, x: { type: 'poly_bevel', in: ['b'], params: { offset: 0.13, divisions: 3, shape: 0 } } }, 'x')).geo;
  check(a.numPoints === b.numPoints && a.P.every((x, i) => x === b.P[i]), 'deterministic');
}

// ---------------------------------------------------------------- every local configuration
// Every subset of the edges around every point of meshes with flat, convex, concave, saddle, pole (valence 8) and
// boundary points, chamfered and round: stays closed (or as open as the input) and manifold, with no zero-area prims;
// on convex inputs no strip or face turns inward.
{
  const meshes: Record<string, Record<string, NodeSpec>> = {
    box3: { b: { type: 'box', params: { divisions: [3, 2, 2] } } },
    sphere: { b: { type: 'sphere', params: { rows: 6, cols: 8 } } },
    tribox: { a: { type: 'box', params: { divisions: [2, 2, 2] } }, b: { type: 'triangulate', in: ['a'] } },
    cone: { b: { type: 'tube', params: { cols: 6, radius_top: 0 } } },
    star: { s: { type: 'shape2d', params: { shape: 'star', sides: 5, inner_radius: 0.4 } }, b: { type: 'extrude', in: ['s'], params: { height: 0.3 } } },
    torus: { b: { type: 'torus', params: { rows: 5, cols: 7 } } },
    open: { a: { type: 'box', params: { divisions: [2, 2, 2] } }, b: { type: 'delete', in: ['a'], params: { group: '@P.y<-0.4' } } },
  };
  const convex = new Set(['box3', 'sphere', 'tribox', 'cone']);
  for (const [name, nodes] of Object.entries(meshes)) {
    const { geo: g } = await cookR(nodes, Object.keys(nodes).pop());
    const closed0 = topologyReport(g).closed, he = halfEdges(g);
    let runs = 0, bad = '';
    for (let v = 0; v < g.numPoints && !bad; v++) {
      const ring = he.pointOneRing(v);
      for (let mask = 1; mask < 1 << ring.length && !bad; mask++) {
        const sel = new EdgeSet();
        ring.forEach((w, i) => { if (mask & (1 << i)) sel.add(v, w); });
        for (const divisions of [0, 2]) {
          const r = bevelEdges(g, sel, { offset: 0.03, divisions });
          runs++;
          const t = topologyReport(r.geo), h = r.geo;
          if (t.nonManifoldEdges || t.degenerate || (closed0 && !t.closed)) { bad = `point ${v} edges ${mask.toString(2)} divisions ${divisions}`; break; }
          if (convex.has(name)) {
            const N = primNormals(h), cor = h.primGroups.get('bevel_corner');
            for (let p = 0; p < h.numPrims && !bad; p++) {
              if (cor?.[p]) continue; // end caps of strips stopping at unbevelled points can face sideways or down
              const c = primCentroid(h, p);
              if ((c[0] * N[p * 3] + c[1] * N[p * 3 + 1] + c[2] * N[p * 3 + 2]) / Math.hypot(c[0], c[1], c[2]) < -0.3) bad = `inward prim ${p} at point ${v} edges ${mask.toString(2)}`;
            }
          }
        }
      }
    }
    check(!bad, `every edge subset around every point of ${name} (${runs} bevels): ${closed0 ? 'watertight' : 'manifold'}, no degenerate prims${bad ? ' — ' + bad : ''}`);
  }
}

// ---- clamping is local: one short edge must not shrink every bevel of the mesh
{
  // a rounded_rect whose radius is half its width: neighbouring arcs meet, and the shared point must appear once
  const rr = await cookR({ s: { type: 'shape2d', params: { shape: 'rounded_rect', size: [0.08, 0.3], corner_radius: 0.1, corner_segments: 6 } } }, 's');
  const P = rr.geo.P, np = rr.geo.numPoints;
  let dup = 0;
  for (let i = 0; i < np; i++) { const j = (i + 1) % np; if (Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]) < 1e-9) dup++; }
  check(dup === 0, `shape2d rounded_rect with a radius of half the width has no repeated points (${np} points)`);
  const slab = await bevel({ s: { type: 'shape2d', params: { shape: 'rounded_rect', size: [0.08, 0.3], corner_radius: 0.1 } }, e: { type: 'extrude', in: ['s'], params: { height: 0.04, center: true } } }, { offset: 0.003, divisions: 1, group: 'angle>40' });
  check(watertight(slab.geo) && !slab.warnings.some((w) => /clamped|reduced|sharp/.test(w)), `that outline extruded and bevelled: watertight, the full offset everywhere (${slab.warnings.join('; ') || 'no warnings'})`);
  // a profile with one 1.4 mm edge: only the bevels around it shrink
  const notch = await bevel({
    c: { type: 'curve', params: { points: [[0, 0, 0], [0.3, 0, 0], [0.3, 0.2, 0], [0.151, 0.2, 0], [0.15, 0.201, 0], [0, 0.2, 0]], closed: true } },
    e: { type: 'extrude', in: ['c'], params: { height: 0.2 } },
  }, { offset: 0.01, divisions: 1, group: 'angle>40' });
  // edges the corner clamp reduced or left sharp, and both edges of each pair the facing clamp reduced
  const touched = notch.warnings.reduce((n, w) => n + Number(/(?:at |^)(\d+) edge/.exec(w)?.[1] ?? 0) + 2 * Number(/at (\d+) pair/.exec(w)?.[1] ?? 0), 0);
  check(!notch.warnings.some((w) => /clamped/.test(w)) && touched > 0 && touched <= 8 && topologyReport(notch.geo).degenerate === 0,
    `a short edge reduces or leaves sharp only the bevels next to it (${notch.warnings.join('; ') || 'no warnings'})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
