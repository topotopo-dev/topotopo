import assert from 'node:assert/strict';
import { GeoBuilder, Geometry } from '../src/core/geometry.ts';
import type { Vec3 } from '../src/core/math.ts';
import { closestSurfacePoint, evalSurface, setSurfacePrim, surfaceFromPrim } from '../src/core/nurbssurface.ts';
import { packedFromMatrices } from '../src/core/packed.ts';
import { evalPoint, hasSplinesDeep, makeSpline, splinesToPolylines, splinesToPolylinesDeep } from '../src/core/splines.ts';
import { exportGLB } from '../src/io/gltf.ts';
import { geoFromJSON, geoToJSON } from '../src/io/json.ts';
import { allNodeDefs } from '../src/graph/registry.ts';
import type { NodeSpec } from '../src/graph/types.ts';
import { SKIP, addFixture, checkGeo, createFixtureEngine, fixtureGraphFor } from './fixtures.ts';

let pass = 0, fail = 0;
async function check(name: string, test: () => void | Promise<void>) {
  try { await test(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}: ${e}`); }
}
function dist(a: ArrayLike<number>, b: ArrayLike<number>) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function near(a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-12) { assert.ok(dist(a, b) <= eps, `${Array.from(a)} vs ${Array.from(b)}`); }
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const diff = (a: Vec3, b: Vec3, scale = 1): Vec3 => [(a[0] - b[0]) * scale, (a[1] - b[1]) * scale, (a[2] - b[2]) * scale];
let seed = 1729;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;

function patch(cols: number, rows: number, cv: (i: number, j: number) => Vec3, opts: Parameters<typeof setSurfacePrim>[3] = {}) {
  const b = new GeoBuilder();
  const ids = Array.from({ length: cols * rows }, (_, k) => b.addPoint(...cv(k % cols, Math.floor(k / cols))));
  b.addPrim(ids, false);
  const g = b.build();
  setSurfacePrim(g, 0, cols, opts);
  return g;
}
const arc = patch(3, 2, (i, j) => [[1, 0, j], [1, 1, j], [0, 1, j]][i] as Vec3,
  { orderU: 3, orderV: 2, weights: [1, Math.SQRT1_2, 1, 1, Math.SQRT1_2, 1] });
const cylinder = (pole = false) => patch(8, 4, (i, j) => {
  const a = i * Math.PI / 4, r = pole ? [1, 1, 0.75, 0][j] : 1;
  return [r * Math.cos(a), r * Math.sin(a), j / 3];
}, { closedU: true });
const saddle = patch(4, 4, (i, j) => [i / 3, j / 3, (i / 3 - 0.5) * (j / 3 - 0.5) + Math.sin(i + j) * 0.13],
  { weights: Array.from({ length: 16 }, (_, i) => 1 + (i % 5) / 8) });

await check('bilinear interpolation', () => {
  const s = surfaceFromPrim(patch(2, 2, (i, j) => [i, j, i * j * 2], { orderU: 2, orderV: 2 }), 0)!;
  for (let k = 0; k < 40; k++) {
    const u = random(), v = random();
    near(evalSurface(s, u, v).P, [u, v, 2 * u * v]);
  }
});
await check('cubic surface matches its cubic curve', () => {
  const cvs: Vec3[] = [[0, 0, 0], [1, 2, 0], [3, -1, 0], [4, 2, 0]];
  const curve = makeSpline('nurbs', cvs.flat(), { knots: [2, 2, 2, 2, 5, 5, 5, 5] });
  const s = surfaceFromPrim(patch(4, 4, (i, j) => [cvs[i][0], cvs[i][1], 2 * j / 3], { knotsU: curve.knots }), 0)!;
  for (let k = 0; k < 40; k++) {
    const u = random(), v = random(), p = evalPoint(curve, u);
    near(evalSurface(s, u, v).P, [p[0], p[1], 2 * v]);
  }
});
await check('rational quarter-cylinder radius and radial normals', () => {
  const s = surfaceFromPrim(arc, 0)!;
  for (let k = 0; k < 40; k++) {
    const e = evalSurface(s, random(), random());
    assert.ok(Math.abs(Math.hypot(e.P[0], e.P[1]) - 1) < 1e-12);
    near(e.N, [e.P[0], e.P[1], 0]);
  }
});
await check('first and second partial derivatives and unit normal', () => {
  const s = surfaceFromPrim(saddle, 0)!;
  const h = 1e-5;
  for (let k = 0; k < 40; k++) {
    const u = 0.1 + 0.8 * random(), v = 0.1 + 0.8 * random();
    const e = evalSurface(s, u, v);
    const a = evalSurface(s, u - h, v), b = evalSurface(s, u + h, v);
    const c = evalSurface(s, u, v - h), d = evalSurface(s, u, v + h);
    for (const [actual, expected] of [[e.Su, diff(b.P, a.P, 0.5 / h)], [e.Sv, diff(d.P, c.P, 0.5 / h)],
      [e.Suu, diff(b.Su, a.Su, 0.5 / h)], [e.Suv, diff(d.Su, c.Su, 0.5 / h)], [e.Svv, diff(d.Sv, c.Sv, 0.5 / h)]])
      near(actual, expected, 1e-6 * Math.hypot(...expected));
    const n = cross(e.Su, e.Sv);
    near(e.N, n.map((x) => x / Math.hypot(...n)));
  }
});
await check('closest point matches dense sampling and independent Newton refinement', () => {
  const s = surfaceFromPrim(saddle, 0)!;
  const n = 48, grid = Array.from({ length: (n + 1) ** 2 }, (_, i) => evalSurface(s, (i % (n + 1)) / n, Math.floor(i / (n + 1)) / n).P);
  for (let k = 0; k < 20; k++) {
    const u0 = 0.1 + 0.8 * random(), v0 = 0.1 + 0.8 * random(), e = evalSurface(s, u0, v0);
    const q = e.P.map((x, i) => x + e.N[i] * 0.04) as Vec3;
    const best = grid.reduce((a, p, i) => dist(p, q) < dist(grid[a], q) ? i : a, 0);
    let u = (best % (n + 1)) / n, v = Math.floor(best / (n + 1)) / n;
    for (let i = 0; i < 12; i++) {
      const a = evalSurface(s, u, v), r = diff(a.P, q);
      const uu = dot(a.Su, a.Su) + dot(r, a.Suu), uv = dot(a.Su, a.Sv) + dot(r, a.Suv), vv = dot(a.Sv, a.Sv) + dot(r, a.Svv);
      const f = dot(r, a.Su), g = dot(r, a.Sv), det = uu * vv - uv * uv;
      u -= (f * vv - g * uv) / det;
      v -= (g * uu - f * uv) / det;
    }
    const found = closestSurfacePoint(s, q);
    near(found.P, evalSurface(s, u, v).P, 1e-9);
    near(found.P, e.P, 1e-9);
  }
});
await check('periodic cylinder shares seam points and interior edges', () => {
  const g = cylinder(), s = surfaceFromPrim(g, 0)!;
  for (const v of [0, 0.23, 0.6, 1]) near(evalSurface(s, 0, v).P, evalSurface(s, 1, v).P);
  const m = splinesToPolylines(g, { segments: [2, 2] }).geo;
  assert.equal(m.numPoints, 16 * 3);
  const edges = new Map<string, number>();
  for (let p = 0; p < m.numPrims; p++) {
    const ids = m.primPoints(p);
    ids.forEach((a, i) => {
      const b = ids[(i + 1) % ids.length], key = [Math.min(a, b), Math.max(a, b)].join(',');
      edges.set(key, (edges.get(key) ?? 0) + 1);
    });
  }
  for (const [key, count] of edges) {
    const [a, b] = key.split(',').map(Number);
    const z = m.P[3 * a + 2];
    assert.equal(count, (Math.abs(z) < 1e-12 || Math.abs(z - 1) < 1e-12) && Math.abs(z - m.P[3 * b + 2]) < 1e-12 ? 1 : 2);
  }
});
await check('quad conversion meets tolerance and carries normals, UVs, winding and attributes', () => {
  const g = saddle.clone(), s = surfaceFromPrim(g, 0)!;
  const cd = g.points.add('Cd', 'float', 3);
  for (let i = 0; i < g.numPoints; i++) cd.set(i, [g.P[3 * i], g.P[3 * i + 1], 0]);
  g.prims.add('tag', 'int', 1).set(0, 17);
  g.primGroups.set('panel', Uint8Array.of(1));
  const tol = 0.002, m = splinesToPolylines(g, { tolerance: tol }).geo;
  const uv = m.vertices.get('uv')!, n = m.points.get('N')!;
  assert.ok(m.numPrims > 0 && !m.hasSurfaces());
  for (let p = 0; p < m.numPrims; p++) {
    const ids = m.primPoints(p), ps = ids.map((i) => Array.from(m.P.subarray(3 * i, 3 * i + 3)) as Vec3);
    assert.equal(ids.length, 4);
    assert.equal(m.prims.get('tag')?.get(p), 17);
    assert.equal(m.primGroups.get('panel')?.[p], 1);
    assert.ok(dot(cross(diff(ps[1], ps[0]), diff(ps[3], ps[0])), n.get(ids[0]) as Vec3) > 0);
    for (let j = 0; j < 4; j++) {
      const [u, v] = uv.get(m.primStart[p] + j) as number[];
      assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1);
      const e = evalSurface(s, u, v);
      near(n.get(ids[j]) as Vec3, e.N, 1e-9);
      near(m.points.get('Cd')!.get(ids[j]) as Vec3, [e.P[0], e.P[1], 0]);
    }
    const sites = [ps, ...ps.map((a, i) => [a, ps[(i + 1) % ps.length]])];
    for (const points of sites) {
      const q = [0, 1, 2].map((j) => points.reduce((sum, a) => sum + a[j], 0) / points.length) as Vec3;
      assert.ok(dist(closestSurfacePoint(s, q).P, q) <= tol);
    }
  }
});
await check('collapsed dome row becomes one pole with finite normals and triangles', () => {
  const g = cylinder(true), s = surfaceFromPrim(g, 0)!;
  const { geo: m, poleTriangles } = splinesToPolylines(g, { segments: 3 });
  assert.equal(poleTriangles, 24);
  assert.equal(Array.from({ length: m.numPoints }, (_, i) => m.P[3 * i + 2]).filter((z) => Math.abs(z - 1) < 1e-12).length, 1);
  assert.equal(Array.from({ length: m.numPrims }, (_, p) => m.primSize(p)).filter((n) => n === 3).length, 24);
  assert.ok([...m.P, ...m.points.get('N')!.data, ...evalSurface(s, 0.25, 1).N].every(Number.isFinite));
});

const { engine } = await createFixtureEngine();
async function run(type: string, g: Geometry | null, params: Record<string, unknown> = {}) {
  const nodes: Record<string, NodeSpec> = { out: { type, params } };
  if (g) { nodes.src = { type: 'input' }; nodes.out.in = ['src']; }
  const r = await engine.cook({ nodes, output: 'out' }, g ? { inputs: [{ geo: g, sig: JSON.stringify(geoToJSON(g)) }] } : {});
  assert.ok(r.ok && r.geo, r.errors.map((e) => e.message).join(', '));
  return { geo: r.geo, warnings: r.warnings.map((w) => w.message) };
}
await check('grid stays flat until a middle CV raises it smoothly', async () => {
  const { geo: g } = await run('grid', null, { type: 'nurbs', divisions: [2, 2] });
  const s = surfaceFromPrim(g, 0)!;
  assert.equal(g.numSurfaces, 1);
  assert.equal(g.primSize(0), 25);
  const raised = g.clone();
  raised.P[3 * g.primPoints(0)[12] + 1] += 1;
  const r = surfaceFromPrim(raised, 0)!;
  const top = evalSurface(r, 0.5, 0.5).P[1];
  assert.ok(top > 0 && top < 1);
  for (let k = 0; k < 40; k++) {
    const u = random(), v = random(), p = evalSurface(s, u, v).P;
    assert.ok(Math.abs(p[0]) <= 2 && Math.abs(p[2]) <= 2 && p[1] === 0);
    assert.ok(evalSurface(r, u, v).P[1] <= top + 1e-12);
  }
});
await check('engine converts for polygons and preserves exact affine transforms', async () => {
  const { geo, warnings } = await run('subdivide', saddle);
  assert.ok(geo.numPrims > 0 && !geo.hasSurfaces());
  assert.ok(warnings.includes('converted 1 NURBS surface to polygons for out (subdivide works on polygons; add convert_curve to choose the resolution)'));
  const r = await run('transform', saddle, { translate: [2, 3, 4] });
  assert.equal(r.geo.numSurfaces, 1);
  const a = evalSurface(surfaceFromPrim(saddle, 0)!, 0.2, 0.8).P;
  near(evalSurface(surfaceFromPrim(r.geo, 0)!, 0.2, 0.8).P, [a[0] + 2, a[1] + 3, a[2] + 4]);
});
await check('curve nodes skip surfaces and still process their curves', async () => {
  const { geo: curve } = await run('nurbs', null);
  const both = Geometry.merge([saddle, curve]);
  const r = await run('resample', both), only = await run('resample', curve);
  assert.equal(r.geo.numSurfaces, 1);
  assert.equal(r.geo.numPrims, only.geo.numPrims + 1);
  assert.equal(r.geo.primSize(1), only.geo.primSize(0));
  const sweep = await run('sweep', both), sweepOnly = await run('sweep', curve);
  assert.equal(sweep.geo.numPrims, sweepOnly.geo.numPrims);
  assert.ok(sweep.geo.numPrims > 0 && !sweep.geo.hasSurfaces());
});
await check('JSON round-trips surface storage exactly', () => {
  const g = cylinder();
  setSurfacePrim(g, 0, 8, { orderU: 4, orderV: 3, closedU: true, closedV: true, knotsU: [0, 1, 3, 4, 5, 6, 7, 8, 9],
    knotsV: [2, 3, 4, 7, 9], weights: Array.from({ length: g.numPoints }, (_, i) => 1 + i / 32) });
  const j = geoToJSON(g), restored = geoFromJSON(JSON.parse(JSON.stringify(j)));
  assert.equal(restored.numSurfaces, 1);
  assert.equal(restored.primKind![0], 4);
  assert.deepEqual(geoToJSON(restored), j);
});
await check('GLB carries converted triangle count and normals', async () => {
  const m = splinesToPolylines(arc).geo;
  const bytes = await exportGLB(arc);
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
  const prim = gltf.meshes[0].primitives[0];
  assert.equal(gltf.accessors[prim.indices].count, m.numPrims * 6);
  assert.equal(gltf.accessors[prim.attributes.NORMAL].type, 'VEC3');
});

await check('selected surface conversion reports poles and keeps other exact prims', async () => {
  const g = Geometry.merge([cylinder(true), arc]);
  g.primGroups.set('dome', Uint8Array.of(1, 0));
  const r = await run('convert_curve', g, { group: 'dome', segments: 3 });
  assert.equal(r.geo.numSurfaces, 1);
  assert.equal(r.geo.numSplines, 0);
  assert.ok(r.warnings.includes('converted 1 NURBS surface to polygons (24 pole triangles)'));
  const p = r.geo.primKind!.indexOf(4);
  near(evalSurface(surfaceFromPrim(r.geo, p)!, 0.2, 0.7).P, evalSurface(surfaceFromPrim(arc, 0)!, 0.2, 0.7).P);
  for (const to of ['bezier', 'nurbs']) {
    const exact = await run('convert_curve', g, { to });
    assert.deepEqual(geoToJSON(exact.geo), geoToJSON(g));
  }
});

await check('packed sources share tessellations and keep their requested resolution', () => {
  const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const g = packedFromMatrices(arc, [identity, identity]);
  assert.ok(hasSplinesDeep(g));
  const a = splinesToPolylinesDeep(g, { segments: 2 }).geo, b = splinesToPolylinesDeep(g, { segments: 3 }).geo;
  assert.equal(a.numPacked, 2);
  assert.equal(a.packedSources.length, 1);
  assert.equal(a.packedSources[0].numPrims, 4);
  assert.equal(b.packedSources[0].numPrims, 9);
  assert.equal(g.packedSources[0].numSurfaces, 1);
});

await check('surface fixture cooks wherever the spline fixture is fed', async () => {
  const failures: string[] = [];
  let count = 0;
  for (const def of allNodeDefs()) {
    if (SKIP.has(def.type)) continue;
    const graph = fixtureGraphFor(def.type);
    const target = graph.nodes.target;
    if (!Array.isArray(target.in) || !target.in.includes('NURBS')) continue;
    addFixture(graph.nodes, 'SURFACE');
    target.in = target.in.map((input) => input === 'NURBS' ? 'SURFACE' : input);
    const r = await engine.cook(graph);
    if (!r.ok || !r.geo) failures.push(`${def.type}: ${r.errors.map((e) => e.message).join(', ')}`);
    else failures.push(...checkGeo(r.geo).map((e) => `${def.type}: ${e}`));
    count++;
  }
  assert.ok(count > 0);
  assert.deepEqual(failures, []);
});

await check('every wired node is exercised with a surface beside its usual fixture', async () => {
  const failures: string[] = [];
  let count = 0, rejected = 0;
  for (const def of allNodeDefs()) {
    if (SKIP.has(def.type)) continue;
    const graph = fixtureGraphFor(def.type);
    const target = graph.nodes.target;
    if (!Array.isArray(target.in) || !target.in.length) continue;
    addFixture(graph.nodes, 'SURFACE');
    graph.nodes.withSurface = { type: 'merge', in: [target.in[0], 'SURFACE'] };
    target.in = ['withSurface', ...target.in.slice(1)];
    const r = await engine.cook(graph);
    if (!r.ok || !r.geo) {
      const errors = r.errors.map((e) => e.message).join(', ');
      if (/TypeError|RangeError|Cannot read|is not a function|of undefined|of null/.test(errors)) failures.push(`${def.type}: ${errors}`);
      else { rejected++; console.log(`  ${def.type} rejected mixed input: ${errors}`); }
    } else failures.push(...checkGeo(r.geo).map((e) => `${def.type}: ${e}`));
    count++;
  }
  console.log(`  ${count} nodes exercised, ${rejected} rejected mixed input`);
  assert.ok(count > 0);
  assert.deepEqual(failures, []);
});
console.log(`\nnurbssurface: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
