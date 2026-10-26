// solidify (core/solidify.ts): constant thickness on flat, folded, curved, closed, holed and concave surfaces, every
// offset, rim control, attributes, and the rejections (bad input, runaway mitres, saddles, inversion, self-
// intersection, exhausted validation budget). Also the strict triangle contact test it relies on.
//   node test/solidify.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry, GeoBuilder } from '../src/core/geometry.ts';
import type { NodeSpec } from '../src/graph/types.ts';
import { primNewell, signedVolume, topologyReport } from '../src/core/topology.ts';
import { SolidifyError, offsetDirection, solidify } from '../src/core/solidify.ts';
import { selfIntersections } from '../src/core/analysis.ts';
import { trianglesContact } from '../src/core/tritri.ts';

const engine = new Engine(createNodeHost());
await engine.init();

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
async function cook(nodes: Record<string, NodeSpec>, output: string): Promise<Geometry> {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return r.geo;
}
const rejects = (g: Geometry, opts: Partial<Parameters<typeof solidify>[1]>, re: RegExp) => {
  try { solidify(g, { thickness: 0.01, offset: 0, fillRim: true, miterLimit: 4, ...opts }); return 'no error'; } catch (e: any) { return e instanceof SolidifyError && re.test(e.message) ? '' : `wrong error: ${e.message}`; }
};
const grp = (g: Geometry, name: string) => { const m = g.primGroups.get(name); return m ? m.reduce((s, x) => s + x, 0) : 0; };
/** Largest deviation of (inner corner distance to its outer face plane) from the thickness, over all source faces. */
function thicknessError(src: Geometry, out: Geometry, t: number) {
  const n = src.numPrims, nrm = [0, 0, 0];
  let worst = 0;
  for (let p = 0; p < n; p++) {
    primNewell(out, p, nrm);
    const l = Math.hypot(nrm[0], nrm[1], nrm[2]), o = out.vertexPoint[out.primStart[p]] * 3;
    for (let v = out.primStart[n + p]; v < out.primStart[n + p + 1]; v++) {
      const q = out.vertexPoint[v] * 3;
      const d = ((out.P[o] - out.P[q]) * nrm[0] + (out.P[o + 1] - out.P[q + 1]) * nrm[1] + (out.P[o + 2] - out.P[q + 2]) * nrm[2]) / l;
      worst = Math.max(worst, Math.abs(d - t));
    }
  }
  return worst;
}
const closedOK = (g: Geometry) => { const r = topologyReport(g); return r.closed && r.nonManifoldEdges === 0 && r.degenerate === 0; };
const SHEET: NodeSpec = { type: 'grid', params: { size: [1, 1], rows: 4, cols: 4 } };

// ---------------------------------------------------------------- flat sheet, every offset
{
  const src = await cook({ s: SHEET }, 's');
  for (const [off, top, bottom] of [[-1, 0, -0.01], [0, 0.005, -0.005], [1, 0.01, 0]] as const) {
    const { geo, stats } = solidify(src, { thickness: 0.01, offset: off, fillRim: true, miterLimit: 4 });
    const b = geo.bbox();
    check(closedOK(geo) && Math.abs(b.max[1] - top) < 1e-12 && Math.abs(b.min[1] - bottom) < 1e-12, `flat sheet, offset ${off}: closed, surfaces at y = ${top} / ${bottom}`);
    check(Math.abs(signedVolume(geo) - 0.01) < 1e-12 && thicknessError(src, geo, 0.01) < 1e-12, `flat sheet, offset ${off}: volume = area × thickness, faces exactly 0.01 apart`);
    check(grp(geo, 'outer') === 16 && grp(geo, 'inner') === 16 && grp(geo, 'rim') === 16 && stats.rim === 16, 'groups: 16 outer, 16 inner, 16 rim quads (one per boundary edge)');
  }
  const open = solidify(src, { thickness: 0.01, offset: 0, fillRim: false, miterLimit: 4 }).geo;
  const tr = topologyReport(open);
  check(!tr.closed && tr.pieces === 2 && grp(open, 'rim') === 0 && open.numPrims === 32, 'fill_rim off: two separate surfaces, no rim');
}

// ---------------------------------------------------------------- 90° fold, curved strip
{
  const fold = await cook({ s: SHEET, f: { type: 'wrangle', in: ['s'], params: { snippet: 'if (@P.x > 0) { @P.y = @P.x; @P.x = 0; }' } } }, 'f');
  for (const off of [-1, 0, 1]) {
    const { geo, stats } = solidify(fold, { thickness: 0.02, offset: off, fillRim: true, miterLimit: 4 });
    check(closedOK(geo) && thicknessError(fold, geo, 0.02) < 1e-12 && Math.abs(stats.maxMiter - Math.SQRT2) < 1e-12 && stats.maxResidual < 1e-12,
      `90° fold, offset ${off}: closed, every face exactly 0.02 thick, mitre √2 at the fold`);
  }
  const strip = await cook({ s: { type: 'grid', params: { size: [1, 0.3], rows: 1, cols: 24 } }, b: { type: 'wrangle', in: ['s'], params: { snippet: 'const a = @P.x * 2.5; @P = set(sin(a) * 0.4, 0.4 - cos(a) * 0.4, @P.z);' } } }, 'b');
  for (const off of [-1, 1]) {
    const { geo, stats } = solidify(strip, { thickness: 0.03, offset: off, fillRim: true, miterLimit: 4 });
    check(closedOK(geo) && thicknessError(strip, geo, 0.03) < 1e-12 && stats.maxResidual < 1e-12, `curved strip (radius 0.4), offset ${off}: closed, constant 0.03 wall (max residual ${stats.maxResidual.toExponential(1)})`);
  }
}

// ---------------------------------------------------------------- closed shell, holes, concave corners
{
  const box = await cook({ b: { type: 'box' } }, 'b');
  const { geo } = solidify(box, { thickness: 0.05, offset: -1, fillRim: true, miterLimit: 4 });
  const tr = topologyReport(geo);
  check(tr.closed && tr.pieces === 2 && grp(geo, 'rim') === 0 && Math.abs(signedVolume(geo) - (1 - 0.9 ** 3)) < 1e-12, `closed box, offset -1: two nested closed surfaces, wall volume 1 - 0.9³ (${signedVolume(geo).toFixed(6)})`);
  check(thicknessError(box, geo, 0.05) < 1e-12, 'closed box: every face 0.05 from its inner copy (corners meet three planes exactly)');
  const holed = await cook({ s: SHEET, d: { type: 'delete', in: ['s'], params: { group: '5 6 9 10' } } }, 'd');
  const h = solidify(holed, { thickness: 0.01, offset: 0, fillRim: true, miterLimit: 4 }).geo;
  check(closedOK(h) && grp(h, 'rim') === 16 + 8 && topologyReport(h).euler === 0, 'sheet with a hole: rims on the outer boundary (16) and the hole (8); a closed torus-like solid (euler 0)');
  const openBox = await cook({ b: { type: 'box' }, d: { type: 'delete', in: ['b'], params: { group: '@P.y>0.4' } } }, 'd');
  for (const off of [-1, 1]) {
    const r = solidify(openBox, { thickness: 0.04, offset: off, fillRim: true, miterLimit: 4 });
    check(closedOK(r.geo) && thicknessError(openBox, r.geo, 0.04) < 1e-12, `open box (concave inner corners), offset ${off}: closed, exactly 0.04 thick`);
  }
  const L = new GeoBuilder();
  for (const [x, z] of [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]) L.addPoint(x, 0, z);
  L.addPrim([0, 5, 4, 3, 2, 1]);
  const ls = solidify(L.build(), { thickness: 0.1, offset: 0, fillRim: true, miterLimit: 4 }).geo;
  check(closedOK(ls) && Math.abs(signedVolume(ls) - 0.3) < 1e-12, 'L-shaped n-gon (a concave boundary corner): closed, volume 3 m² × 0.1');
}

// ---------------------------------------------------------------- attributes and uv
{
  const src = await cook({
    s: SHEET, c: { type: 'color', in: ['s'], params: { mode: 'random', class: 'point' } },
    p: { type: 'attrib_create', in: ['c'], params: { name: 'part', class: 'prim', value: 7 } },
  }, 'p');
  const { geo } = solidify(src, { thickness: 0.02, offset: 0, fillRim: true, miterLimit: 4 });
  const cd = src.points.get('Cd')!, cd2 = geo.points.get('Cd')!;
  let cdOK = true;
  for (let v = 0; v < geo.primStart[32]; v++) {
    const sp = src.vertexPoint[(v % src.numVertices)];
    if (JSON.stringify(cd2.get(geo.vertexPoint[v])) !== JSON.stringify(cd.get(sp)) && v < src.numVertices) cdOK = false;
  }
  check(cdOK && (geo.prims.get('part')!.data as Int32Array).every((x) => x === 7), 'point Cd follows the source points, prim attributes the source prims (rim from its face)');
  const uvS = src.findAttrib('uv', ['vertex', 'point'])!, uvO = geo.vertices.get('uv')!;
  let uvOK = true;
  for (let v = 0; v < src.numVertices; v++) {
    const s = uvS.attr.get(uvS.cls === 'vertex' ? v : src.vertexPoint[v]) as number[];
    const o = uvO.get(v) as number[];
    if (Math.abs(s[0] - o[0]) > 1e-12 || Math.abs(s[1] - o[1]) > 1e-12) uvOK = false;
  }
  check(uvOK, 'surface uvs are copied onto the outer surface (vertex uv)');
  let vMin = Infinity, vMax = -Infinity, uMax = 0;
  for (let v = geo.primStart[32]; v < geo.numVertices; v++) { const u = uvO.get(v) as number[]; vMin = Math.min(vMin, u[1]); vMax = Math.max(vMax, u[1]); uMax = Math.max(uMax, u[0]); }
  check(vMin === 0 && Math.abs(vMax - 0.02) < 1e-15 && Math.abs(uMax - 4) < 1e-12, `rim uv is metric: v 0 … thickness (${vMax}), u along the boundary up to its length 4 m (${uMax})`);
  check(!geo.points.get('N') && !geo.vertices.get('N'), 'N is dropped (it would point the wrong way on the inner copy)');
}

// ---------------------------------------------------------------- rejections
{
  const sheet = await cook({ s: SHEET }, 's');
  check(rejects(sheet, { thickness: 0 }, /thickness must be a positive/) === '', 'thickness 0 is rejected');
  check(rejects(sheet, { offset: 1.5 }, /offset must be between -1/) === '', 'offset outside -1 … 1 is rejected');
  const tri = (pts: number[][], prims: number[][]) => { const b = new GeoBuilder(); for (const p of pts) b.addPoint(p[0], p[1], p[2]); for (const q of prims) b.addPrim(q); return b.build(); };
  const fin = tri([[0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], [0, -1, 0]], [[0, 2, 1], [0, 1, 3], [0, 1, 4]]);
  check(rejects(fin, {}, /non-manifold edge/) === '', 'three faces on one edge: non-manifold edge rejected');
  const flipped = tri([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [[0, 3, 2], [0, 1, 2]]);
  check(rejects(flipped, {}, /inconsistent winding/) === '', 'neighbours with opposite winding are rejected');
  const bow = tri([[0, 0, 0], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]], [[0, 2, 1], [0, 4, 3]]);
  check(rejects(bow, {}, /non-manifold point/) === '', 'two fans touching at one point (bowtie) are rejected');
  const flat = tri([[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 0, 1]], [[0, 1, 2], [0, 3, 1]]);
  check(rejects(flat, {}, /collapsed polygon/) === '', 'a collapsed polygon is rejected');
  const line = await cook({ c: { type: 'curve', params: { points: [[0, 0, 0], [1, 0, 0]] } } }, 'c');
  check(rejects(line, {}, /not polygons/) === '', 'polylines are rejected (select the surface upstream)');
  const sharp = await cook({ s: SHEET, f: { type: 'wrangle', in: ['s'], params: { snippet: 'if (@P.x > 0) { @P.y = @P.x * 0.2; @P.x = -@P.x; }' } } }, 'f');
  check(rejects(sharp, { thickness: 0.02 }, /miter_limit 4/) === '', 'a fold folded back almost flat (≈169°) exceeds miter_limit 4');
  check(rejects(sharp, { thickness: 0.02, miterLimit: 20 }, /./) === 'no error', '… raising miter_limit accepts the long mitre (a valid wedge, verified by the intersection check)');
  const saddle = await cook({ s: { type: 'grid', params: { size: [1, 1], rows: 2, cols: 2 } }, w: { type: 'wrangle', in: ['s'], params: { snippet: '@P.y = 1.5 * @P.x * @P.z * 4 + (@ptnum == 4 ? 0.3 : 0);' } } }, 'w');
  check(rejects(saddle, { thickness: 0.02 }, /offset planes of the surrounding faces do not meet/) === '', 'a twisted corner whose offset planes do not meet is rejected (no silent thinning)');
  const tight = await cook({ s: { type: 'grid', params: { size: [1, 0.3], rows: 1, cols: 24 } }, b: { type: 'wrangle', in: ['s'], params: { snippet: 'const a = @P.x * 2.5; @P = set(sin(a) * 0.05, 0.05 - cos(a) * 0.05, @P.z);' } } }, 'b');
  check(rejects(tight, { thickness: 0.2, offset: 1 }, /inside out|intersects itself/) === '', 'a wall thicker than the curvature radius is rejected');
  const u = await cook({ s: { type: 'grid', params: { size: [1, 0.3], rows: 1, cols: 3 } }, f: { type: 'wrangle', in: ['s'], params: { snippet: 'if (@P.x > 0.4) { @P.y = (@P.x - 0.1666) * 0.15; @P.x = 0.1666 - (@P.x - 0.1666); }' } } }, 'f');
  void u;
  // two parallel plates 2 cm apart (one sheet: a U), walls of 3 cm grown towards each other collide
  const U = tri([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [1, 0.02, 0], [1, 0.02, 1], [0, 0.02, 0], [0, 0.02, 1]], [[0, 3, 2, 1], [1, 2, 5, 4], [4, 5, 7, 6]]);
  check(rejects(U, { thickness: 0.03, offset: 1, miterLimit: 4 }, /intersects itself|inside out/) === '', 'a U whose walls (3 cm, grown into the 2 cm gap along the normals) collide: rejected');
  check(rejects(U, { thickness: 0.03, offset: -1 }, /./) === 'no error', '… grown away from the gap the same U is valid');
  const b2 = await cook({ b: { type: 'box', params: { divisions: [3, 3, 3] } } }, 'b');
  check(rejects(b2, { thickness: 0.01, maxTests: 5 }, /ran out of its budget after 5 triangle pairs/) === '', 'an exhausted validation budget fails with the diagnostic, never passes unchecked');
}

// ---------------------------------------------------------------- the node, offset directions, strict contacts
{
  const r = await engine.cook({ nodes: { s: SHEET, w: { type: 'shell', in: ['s'], params: { thickness: 0.02, offset: 1 } } }, output: 'w' });
  check(r.ok && r.geo!.bbox().max[1] === 0.02, 'node "shell" (alias) cooks: wall grows outward with offset 1');
  const bad = await engine.cook({ nodes: { c: { type: 'curve', params: { points: [[0, 0, 0], [1, 0, 0]] } }, w: { type: 'solidify', in: ['c'] } }, output: 'w' });
  check(!bad.ok && /not polygons/.test(bad.errors[0]?.message ?? '') && !!bad.errors[0]?.hint, 'node errors carry the diagnostic and a hint');
  const one = offsetDirection([0, 1, 0]);
  check(one.d.join() === '0,1,0' && one.residual === 0, 'one face: the offset is its normal (minimum length)');
  const two = offsetDirection([1, 0, 0, 0, 1, 0]);
  check(Math.abs(two.d[0] - 1) < 1e-15 && Math.abs(two.d[1] - 1) < 1e-15 && Math.abs(two.d[2]) < 1e-15, 'two orthogonal faces: the mitre (1, 1, 0), no motion along the fold');
  const T = (pts: number[][]) => Float64Array.from(pts.flat());
  check(trianglesContact(T([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0.2, 0.2, 0], [1.2, 0.2, 0], [0.2, 1.2, 0]]), 0, 9, 0, 1e-9), 'strict: coplanar overlapping triangles touch');
  check(trianglesContact(T([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0], [2, 0, 0], [1, 1, 0]]), 0, 9, 0, 1e-9), 'strict: coplanar triangles touching at a corner (nothing shared) count');
  check(!trianglesContact(T([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]]), 0, 9, 2, 1e-9), 'strict: two halves of a quad (shared edge) are legitimate');
  check(trianglesContact(T([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0], [0, 1, 0], [0.2, 0.2, 0]]), 0, 9, 2, 1e-9), 'strict: a triangle folded back onto its neighbour (coplanar overlap) is caught');
  check(trianglesContact(T([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]]), 0, 9, 1, 1e-9), 'strict: a triangle with a shared corner that passes through the other is caught');
  check(!trianglesContact(T([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0], [-1, 0, 0.3], [0, -1, 0.3]]), 0, 9, 1, 1e-9), 'strict: triangles meeting only at their shared corner are fine');
  const twoBoxes = await cook({ a: { type: 'box' }, b: { type: 'box', params: { center: [0.3, 0.2, 0.1] } }, m: { type: 'merge', in: ['a', 'b'] } }, 'm');
  const loose = selfIntersections(twoBoxes).pairs, strict = selfIntersections(twoBoxes, 2_000_000, { strict: true }).pairs;
  check(loose > 0 && strict >= loose, `two overlapping boxes: crossing-only check ${loose} pairs, strict ${strict} (a superset)`);
  const box = await cook({ b: { type: 'box', params: { divisions: [3, 3, 3] } } }, 'b');
  check(selfIntersections(box, 2_000_000, { strict: true }).pairs === 0, 'strict: a clean closed mesh (shared edges and corners everywhere) has no contacts');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
