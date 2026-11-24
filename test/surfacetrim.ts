import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GeoBuilder, Geometry } from '../src/core/geometry.ts';
import { geoContentHash } from '../src/core/geohash.ts';
import { cross, dot, sub } from '../src/core/math.ts';
import type { Vec3 } from '../src/core/math.ts';
import * as surface from '../src/core/nurbssurface.ts';
import { evalPoint, splineFromPrim, splinesToPolylines } from '../src/core/splines.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { exportGLB } from '../src/io/gltf.ts';
import { geoFromJSON, geoToJSON } from '../src/io/json.ts';
import { renderGeometry } from '../src/render/raster.ts';
import { createFixtureEngine } from './fixtures.ts';

let pass = 0, fail = 0;
async function check(name: string, test: () => void | Promise<void>) {
  try { await test(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}: ${e}`); }
}

const { engine } = await createFixtureEngine();
const bodyGraph: GraphSpec = {
  nodes: {
    ring: { type: 'circle', params: { plane: 'xy', segments: 16 } },
    body: { type: 'loft', in: ['ring'], params: { output: 'surface', parameterization: 'uniform', sections: [
      { scale: 1 }, { offset: [0, 0, 1], scale: 1.1 }, { offset: [0, 0, 2], scale: 1.05 },
      { offset: [0, 0, 3], scale: 0.95 }, { offset: [0, 0, 4], scale: 0.9 },
    ] } },
  },
  output: 'body',
};
const bodyResult = await engine.cook(bodyGraph);
assert.ok(bodyResult.ok && bodyResult.geo, JSON.stringify(bodyResult.errors));
const body = bodyResult.geo, exact = surface.surfaceFromPrim(body, 0)!;
function mesh(g: Geometry, tolerance?: number) {
  const b = new GeoBuilder(g);
  for (let p = 0; p < g.numPrims; p++) if (g.isSurface(p)) {
    surface.appendSurfaceMesh(b, g, p, surface.surfaceFromPrim(g, p)!, { tolerance });
  }
  return b.build();
}
const untrimmed = mesh(body);
const hash = createHash('sha256').update(JSON.stringify(geoToJSON(untrimmed))).digest('hex');

const tolerance = 0.0005;
function outline(points: Vec3[], closed = true, name = '') {
  const g = new Geometry({ positions: points.flat(), prims: [points.map((_, i) => i)], closed });
  if (name) g.prims.add('name', 'string', 1).set(0, name);
  return g;
}
function rect(y0: number, y1: number, z0: number, z1: number, x = 0, name = '') {
  return outline([[x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1]], true, name);
}
const window = rect(0.2, 0.6, 0.65, 1.45, 0, 'window');
function run(type: string, sources: Geometry[], params = {}) {
  const nodes: GraphSpec['nodes'] = Object.fromEntries(sources.map((_, index) => [`in${index}`, { type: 'input', params: { index } }]));
  nodes.result = { type, in: sources.map((_, index) => `in${index}`), params };
  return engine.cook({ nodes, output: 'result' }, { inputs: sources.map((geo) => ({ geo, sig: geoContentHash(geo) })) });
}
async function trim(profile = window, params = {}, g = body) {
  const r = await run('trim_surface', [g, profile], { edges: false, ...params });
  assert.ok(r.ok && r.geo, r.errors.map((e) => e.message).join('\n'));
  return r.geo;
}
function area(g: Geometry) {
  let sum = 0;
  for (let p = 0; p < g.numPrims; p++) {
    const pts = g.primPoints(p).map((i) => point(g, i));
    for (let k = 2; k < pts.length; k++) sum += Math.hypot(...cross(sub(pts[k - 1], pts[0]), sub(pts[k], pts[0]))) / 2;
  }
  return sum;
}
function point(g: Geometry, i: number): Vec3 { return [g.P[3 * i], g.P[3 * i + 1], g.P[3 * i + 2]]; }
function distance(p: Vec3, a: Vec3, b: Vec3) {
  const dir = sub(b, a), rel = sub(p, a);
  const t = Math.max(0, Math.min(1, dot(rel, dir) / dot(dir, dir)));
  return Math.hypot(...rel.map((x, i) => x - t * dir[i]));
}
function boundaries(g: Geometry) {
  const use = new Map<string, { a: number; b: number; count: number }>();
  const neigh = new Map<number, number[]>();
  for (let p = 0; p < g.numPrims; p++) {
    const pts = g.primPoints(p);
    assert.equal(new Set(pts).size, pts.length);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], key = a < b ? `${a},${b}` : `${b},${a}`;
      const edge = use.get(key);
      if (edge) edge.count++; else use.set(key, { a, b, count: 1 });
    }
  }
  const edges: [number, number][] = [];
  for (const { a, b, count } of use.values()) {
    assert.ok(count === 1 || count === 2, `edge ${a},${b} used ${count} times`);
    if (count === 2) continue;
    edges.push([a, b]);
    for (const [x, y] of [[a, b], [b, a]]) {
      const list = neigh.get(x) ?? [];
      list.push(y); neigh.set(x, list);
    }
  }
  for (const [id, list] of neigh) assert.equal(list.length, 2, `boundary degree at ${point(g, id)}`);
  const visited = new Set<number>();
  let loops = 0;
  for (const id of neigh.keys()) {
    if (visited.has(id)) continue;
    loops++;
    for (let i = id; !visited.has(i);) {
      visited.add(i);
      i = neigh.get(i)!.find((j) => !visited.has(j)) ?? id;
    }
  }
  return { loops, edges };
}
const inPolygon = (p: number[], poly: number[][]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x, y] = poly[i], [a, b] = poly[j];
    if ((y > p[1]) !== (b > p[1]) && p[0] < x + (a - x) * (p[1] - y) / (b - y)) inside = !inside;
  }
  return inside;
};
let cut: Geometry;
let cutMesh: Geometry;

await check('untrimmed mesh matches the original', () => {
  assert.equal(hash, 'aa5dd1d2766eeee6c4accea13619b9df3f7cfa6fe7750cfa80e6c8a42bf21262');
  console.log(`  sha256 ${hash}`);
});
await check('window on both flanks', async () => {
  cut = await trim(); cutMesh = mesh(cut);
  const boundary = boundaries(cutMesh);
  assert.equal(boundary.loops, 4);
  const holes = surface.surfaceTrims(cut, 0)!.filter((loop) => loop.every(([u, v]) => u > 0 && u < 1 && v > 0 && v < 1));
  assert.equal(holes.length, 2);
  const n = 480;
  let reference = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const { P: [, y, z], Su, Sv } = surface.evalSurface(exact, (i + 0.5) / n, (j + 0.5) / n);
    if (y < 0.2 || y > 0.6 || z < 0.65 || z > 1.45) reference += Math.hypot(...cross(Su, Sv)) / (n * n);
  }
  const measured = area(cutMesh);
  assert.ok(Math.abs(measured / reference - 1) < 0.005, `${measured} vs ${reference}`);
  const uv = cutMesh.vertices.get('uv')!;
  const pointUV = new Map<number, number[]>();
  for (let i = 0; i < cutMesh.numVertices; i++) pointUV.set(cutMesh.vertexPoint[i], uv.get(i) as number[]);
  for (const [a, b] of boundary.edges) for (const i of [a, b]) {
    const p = pointUV.get(i)!;
    assert.ok(p[1] === 0 || p[1] === 1 || holes.some((loop) => loop.some(([x, y], k) => {
      const [u, v] = loop[(k + 1) % loop.length];
      return distance([p[0], p[1], 0], [x, y, 0], [u, v, 0]) <= 1e-9;
    })), `interior boundary edge at ${p}`);
  }
  const faces = Array.from({ length: cutMesh.numPrims }, (_, p) =>
    Array.from({ length: cutMesh.primSize(p) }, (_, k) => uv.get(cutMesh.primStart[p] + k) as number[]));
  let seed = 19;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (const hole of holes) {
    const us = hole.map(([u]) => u), vs = hole.map(([, v]) => v);
    for (let k = 0; k < 500;) {
      const q = [Math.min(...us) + random() * (Math.max(...us) - Math.min(...us)), Math.min(...vs) + random() * (Math.max(...vs) - Math.min(...vs))];
      if (!inPolygon(q, hole)) continue;
      assert.ok(!faces.some((face) => inPolygon(q, face)), `face in hole at ${q}`);
      k++;
    }
  }
  console.log(`  area ${measured.toFixed(6)} m², reference ${reference.toFixed(6)} m², ${boundary.loops} boundary loops, 1000 empty UV samples`);
});
await check('front hit cuts one flank', async () => {
  const g = mesh(await trim(window, { hits: 'front' }));
  const b = boundaries(g);
  assert.equal(b.loops, 3);
  assert.ok(b.edges.every(([i]) => { const [x, , z] = point(g, i); return z < 1e-7 || z > 4 - 1e-7 || x > 0; }));
});
await check('inside and both keep complementary patches', async () => {
  const g = await trim(window, { keep: 'inside' });
  assert.equal(boundaries(mesh(g)).loops, 2);
  const both = await trim(window, { keep: 'both' });
  assert.equal(both.numSurfaces, 2);
  assert.equal(new Set([...both.primPoints(0), ...both.primPoints(1)]).size, 2 * body.numPoints);
  assert.deepEqual(surface.surfaceFromPrim(both, 0)!.P, surface.surfaceFromPrim(both, 1)!.P);
  for (const name of ['trim_outside', 'trim_inside']) assert.equal(both.primGroups.get(name)?.reduce((a, b) => a + b), 1);
  const combined = area(mesh(both)), full = area(untrimmed);
  assert.ok(Math.abs(combined / full - 1) < 0.005);
  console.log(`  inside ${area(mesh(g)).toFixed(6)} m², combined ${combined.toFixed(6)} m², full ${full.toFixed(6)} m²`);
});
await check('seam-crossing cut welds into one hole', async () => {
  const o = rect(-0.23, 0.22, 0.65, 1.45);
  const g = await trim(o, { hits: 'front', edges: true });
  assert.equal(g.numSplines, 1);
  const m = mesh(g), b = boundaries(m);
  assert.equal(b.loops, 3);
  assert.ok(b.edges.every(([a, z]) => ![a, z].every((i) => Math.abs(point(m, i)[1]) < 1e-9 && point(m, i)[2] > 0.1 && point(m, i)[2] < 3.9)));
  const points = exact.points.map((_, i) => exact.points[i % exact.rows * exact.cols + Math.floor(i / exact.rows)]);
  const transposed = new Geometry({ positions: Array.from(body.P), prims: [points] });
  surface.setSurfacePrim(transposed, 0, exact.rows, { orderU: exact.v.order, orderV: exact.u.order,
    knotsU: exact.v.knots, knotsV: exact.u.knots, closedV: true, weights: points.map((i) => exact.W[exact.points.indexOf(i)]) });
  const v = await trim(o, { hits: 'front', edges: true }, transposed);
  assert.equal(v.numSplines, 1);
  assert.equal(boundaries(mesh(v)).loops, 3);
});
await check('cuts accumulate and overlapping cuts merge', async () => {
  const a = await trim(window, { hits: 'front' });
  const b = await trim(rect(0.2, 0.6, 1.8, 2.45), { hits: 'front' }, a);
  assert.equal(boundaries(mesh(b)).loops, 4);
  const c = await trim(rect(0.33, 0.72, 2.11, 2.81), { hits: 'front' }, b);
  assert.equal(boundaries(mesh(c)).loops, 4);
  assert.ok(area(mesh(c)) < area(mesh(b)));
});
await check('closest projection of a lifted outline', async () => {
  const a = await trim(window, { hits: 'front' });
  const hole = surface.surfaceTrims(a, 0)!.find((loop) => loop.every(([u, v]) => u > 0 && u < 1 && v > 0 && v < 1))!;
  const lifted = hole.map(([u, v], i): Vec3[] => {
    const [x, y] = hole[(i + 1) % hole.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(x - u, y - v) * 120));
    return Array.from({ length: steps }, (_, j) => {
      const { P, N } = surface.evalSurface(exact, u + (x - u) * j / steps, v + (y - v) * j / steps);
      return P.map((q, k) => q + N[k] * 0.001) as Vec3;
    });
  }).flat();
  const b = await trim(outline(lifted), { project: 'closest' });
  const ma = mesh(a, tolerance / 2), mb = mesh(b, tolerance / 2);
  const holeEdges = (m: Geometry) => boundaries(m).edges.map(([i, j]) => [point(m, i), point(m, j)] as const)
    .filter(([q]) => q[2] > 0.1 && q[2] < 3.9);
  const ea = holeEdges(ma), eb = holeEdges(mb);
  const error = (a: typeof ea, b: typeof eb) => Math.max(...a.map(([p]) => Math.min(...b.map(([x, y]) => distance(p, x, y)))));
  const worst = Math.max(error(ea, eb), error(eb, ea));
  assert.ok(worst <= tolerance, `${worst} m`);
  console.log(`  boundary difference ${worst.toExponential(4)} m`);
});
await check('named edge curves follow the surface and hole boundaries', async () => {
  const g = await trim(window, { edges: true });
  const m = mesh(g), b = boundaries(m);
  const edgePrims = Array.from(g.primGroups.get('edges')!).flatMap((inGroup, p) => inGroup ? [p] : []);
  assert.equal(edgePrims.length, 2);
  let onSurface = 0, onMesh = 0;
  for (const p of edgePrims) {
    assert.equal(g.primKind![p], 3);
    assert.equal(g.primClosed[p], 1);
    assert.equal(g.prims.get('name')!.get(p), 'window');
    assert.equal(g.prims.get('edge_surface')!.get(p), 0);
    const s = splineFromPrim(g, p);
    for (let i = 0; i < 96; i++) {
      const q = evalPoint(s, i / 96) as Vec3;
      onSurface = Math.max(onSurface, Math.sqrt(surface.closestSurfacePoint(exact, q).d2));
      onMesh = Math.max(onMesh, Math.min(...b.edges.map(([a, b]) => distance(q, point(m, a), point(m, b)))));
    }
  }
  assert.ok(onSurface <= tolerance && onMesh <= tolerance, `${onSurface} m to surface, ${onMesh} m to mesh`);
  console.log(`  max distance ${onSurface.toExponential(4)} m to surface, ${onMesh.toExponential(4)} m to mesh boundary`);
});
await check('convert, JSON, GLB, render and watertight assert honour the cut', async () => {
  const converted = await run('convert_curve', [cut]);
  assert.ok(converted.ok && converted.geo, JSON.stringify(converted.errors));
  assert.equal(boundaries(converted.geo).loops, 4);
  const json = geoToJSON(cut), restored = geoFromJSON(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(surface.surfaceTrims(restored, 0), surface.surfaceTrims(cut, 0));
  const bytes = await exportGLB(restored), len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
  const triangles = Array.from({ length: cutMesh.numPrims }, (_, i) => cutMesh.primSize(i) - 2).reduce((a, b) => a + b, 0);
  const glbTriangles = gltf.meshes.flatMap((m: { primitives: { indices: number }[] }) => m.primitives)
    .reduce((n: number, p: { indices: number }) => n + gltf.accessors[p.indices].count / 3, 0);
  assert.equal(glbTriangles, triangles);
  assert.ok(renderGeometry(restored, { size: 192 }).rgba.length);
  const r = await run('assert', [restored], { watertight: true });
  assert.ok(!r.ok);
  assert.match(r.errors.map((e) => e.message).join('\n'), /\d+ boundary edges in 4 hole\(s\)/);
  console.log(`  GLB ${glbTriangles} triangles, assert reports ${boundaries(cutMesh).edges.length} boundary edges`);
});
await check('errors identify the outline and how to fix it', async () => {
  const cases: [Geometry, object, RegExp][] = [
    [outline([[0, 0.2, 1], [0, 0.6, 1], [0, 0.6, 2]], false), {}, /outline prim 0.*close it/i],
    [rect(2, 3, 1, 2), {}, /outline prim 0.*misses.*surface prim 0/i],
    [rect(0.5, 1.2, 1, 2), {}, /outline prim 0.*\[[^\]]+\].*move.*project: closest/i],
    [outline([[0, 0.2, 1], [0.1, 0.6, 1], [0, 0.6, 2], [0, 0.2, 2]]), {}, /outline prim 0.*non-planar.*set direction/i],
    [rect(0.72, 0.8, 2, 2.5), { keep: 'inside' }, /surface prim 0.*outline prim 0.*no area/i],
  ];
  const first = await trim(window, { keep: 'inside' });
  for (let i = 0; i < cases.length; i++) {
    const [o, p, message] = cases[i];
    const r = await run('trim_surface', [i === 4 ? first : body, o], p);
    assert.ok(!r.ok);
    assert.match(r.errors.map((e) => e.message).join('\n'), message);
  }
});
await check('six cuts tessellate in under one second', async () => {
  const profiles = Geometry.merge(Array.from({ length: 3 }, (_, i) => rect(0.2, 0.6, 0.4 + i * 1.1, 0.95 + i * 1.1)));
  const g = await trim(profiles);
  const start = performance.now();
  const m = splinesToPolylines(g).geo;
  const ms = performance.now() - start;
  let triangles = 0, quads = 0;
  for (let p = 0; p < m.numPrims; p++) {
    triangles += Number(m.primSize(p) === 3);
    quads += Number(m.primSize(p) === 4);
  }
  assert.equal(boundaries(m).loops, 8);
  console.log(`  ${ms.toFixed(1)} ms, ${triangles} triangles in cut cells, ${quads} quads`);
  assert.ok(ms < 1000, `${ms.toFixed(1)} ms`);
});

console.log(`\nsurfacetrim: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
