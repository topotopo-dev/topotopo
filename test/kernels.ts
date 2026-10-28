// Native-WASM contract, geometric invariants, host loading, and straight_skeleton node integration.
// Run with node test/kernels.ts. The shipped WASM is tested, not a native or JS substitute.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import earcut from 'earcut';
import '../src/nodes/index.ts';
import { Geometry } from '../src/core/geometry.ts';
import { primNewell, signedVolume, topologyReport } from '../src/core/topology.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import type { Host } from '../src/host/types.ts';
import { loadHostKernels, loadKernels, kernelsWasmURL } from '../src/wasm/kernels.ts';
import type { KernelProvenance, OffsetResult, RoofResult, SkeletonResult } from '../src/wasm/kernels.ts';
import { checkGeo } from './fixtures.ts';

let passed = 0, failed = 0;
async function test(name: string, body: () => unknown | Promise<unknown>) {
  try { await body(); passed++; console.log(`PASS kernels: ${name}`); }
  catch (error) { failed++; console.error(`FAIL kernels: ${name}\n${error instanceof Error ? error.stack : error}`); }
}
const near = (actual: number, expected: number, label: string, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected} (tolerance ${tolerance})`);
type PolygonCase = { name: string; outer: number[]; holes: number[][] };
const rectangle: PolygonCase = { name: 'rectangle', outer: [0, 0, 6, 0, 6, 4, 0, 4], holes: [] };
const ell: PolygonCase = { name: 'L-shape', outer: [0, 0, 6, 0, 6, 2, 2, 2, 2, 6, 0, 6], holes: [] };
const uShape: PolygonCase = { name: 'U-shape', outer: [0, 0, 6, 0, 6, 6, 4, 6, 4, 2, 2, 2, 2, 6, 0, 6], holes: [] };
const courtyard: PolygonCase = { name: 'courtyard', outer: [0, 0, 8, 0, 8, 8, 0, 8], holes: [[2, 2, 2, 6, 6, 6, 6, 2]] };
const noisy: PolygonCase = {
  name: 'noisy 200-vertex polygon', holes: [],
  outer: Array.from({ length: 200 }, (_, i) => {
    const angle = i * Math.PI * 2 / 200, radius = 10 + 0.24 * Math.sin(i * 17) + 0.12 * Math.cos(i * 31);
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  }).flat(),
};
const collinear: PolygonCase = { name: 'collinear points', outer: [0, 0, 3, 0, 6, 0, 6, 4, 0, 4], holes: [] };
// Independent coordinate reconstructions from primary paper diagrams, not implementation test data.
// Huber (2011), thesis p.27 Fig.13: the Felkel-Obdrzalek split candidate can name the wrong edge.
// https://www.sthu.org/research/publications/files/phdthesis.pdf
const felkelFailure: PolygonCase = { name: 'Huber Fig13 Felkel-Obdrzalek split regression', holes: [], outer: [0, 0, 9.5, 0, 9.5, 7.75, 6.5, 7.625, 9.5, 9, 6, 9, 5, 8, 4, 9, 0, 9, 0, 5, 0.5, 4, 0, 3] };
// Aichholzer et al. (1995), p.760 Fig.5: the local-plane lower envelope is not the skeleton roof.
// https://www.jucs.org/jucs_1_12/a_novel_type_of/Aichholzer_O.pdf
const aichholzerFailure: PolygonCase = { name: 'Aichholzer Fig5 roof regression', holes: [], outer: [0, 0.7, 19.2, 0, 18.45, 8.85, 6.6, 8.1, 4.4, 11.8, 4.05, 8.1, 3.65, 13.25, 0.85, 4.4, 1.6, 4.25, 0.8, 4.1] };
const nearParallel: PolygonCase = { name: 'near-parallel edges', outer: [0, 0, 3, 1e-7, 6, 0, 6, 4, 0, 4], holes: [] };
const cases = [rectangle, ell, uShape, courtyard, noisy, collinear, nearParallel, felkelFailure, aichholzerFailure];
function area(ring: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    total += ring[i] * ring[j + 1] - ring[j] * ring[i + 1];
  }
  return total / 2;
}
const inputArea = (p: PolygonCase) => Math.abs(area(p.outer)) - p.holes.reduce((sum, ring) => sum + Math.abs(area(ring)), 0);
function loops(vertices: ArrayLike<number>, start: ArrayLike<number>, indices: ArrayLike<number>, stride = 2) {
  return Array.from({ length: start.length - 1 }, (_, p) => {
    const ring: number[] = [];
    for (let i = start[p]; i < start[p + 1]; i++) ring.push(vertices[indices[i] * stride], vertices[indices[i] * stride + 1]);
    return ring;
  });
}
function properCross(a: number[], b: number[], c: number[], d: number[]): boolean {
  // The kernel normalises coordinates internally, so a contour endpoint may round by a few ulps
  // on return. A shared endpoint is not a proper crossing; keep interior intersections strict.
  const scale = Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(d[0] - c[0], d[1] - c[1]));
  if ([a, b].some((p) => [c, d].some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= scale * 1e-12))) return false;
  const orient = (p: number[], q: number[], r: number[]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = orient(a, b, c), abD = orient(a, b, d), cdA = orient(c, d, a), cdB = orient(c, d, b);
  return abC * abD < -1e-18 && cdA * cdB < -1e-18;
}
function assertSimple(ring: number[], label: string) {
  const n = ring.length / 2;
  assert.ok(n >= 3, `${label}: at least three vertices`);
  const points = Array.from({ length: n }, (_, i) => ring.slice(i * 2, i * 2 + 2));
  for (let i = 0; i < n; i++) {
    assert.ok(Math.hypot(points[i][0] - points[(i + 1) % n][0], points[i][1] - points[(i + 1) % n][1]) > 1e-12, `${label}: nonzero edge`);
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      assert.ok(!properCross(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n]), `${label}: nonadjacent edges ${i}/${j} cross`);
      for (const p of [points[i], points[(i + 1) % n]]) {
        const a = points[j], b = points[(j + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
        if (t >= 0 && t <= 1) assert.ok(Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) > 1e-12, `${label}: nonadjacent edge touch or overlap`);
      }
    }
  }
}
function assertCSR(vertices: ArrayLike<number>, start: ArrayLike<number>, indices: ArrayLike<number>, stride: number) {
  assert.equal(vertices.length % stride, 0);
  assert.ok(Array.from(vertices).every(Number.isFinite), 'vertices are finite');
  assert.equal(start[0], 0);
  assert.equal(start[start.length - 1], indices.length);
  for (let i = 1; i < start.length; i++) assert.ok(start[i] >= start[i - 1], 'CSR is monotone');
  for (const i of Array.from(indices)) assert.ok(Number.isInteger(i) && i >= 0 && i < vertices.length / stride, 'vertex index in range');
}
function assertProvenance(p: PolygonCase, result: KernelProvenance, points: number, primitives: number, corners: number) {
  const sources = [p.outer, ...p.holes].reduce((sum, ring) => sum + ring.length / 2, 0);
  assert.ok(result.src_point instanceof Int32Array && result.src_prim instanceof Int32Array && result.src_vertex instanceof Int32Array);
  assert.ok(result.blend_offset instanceof Uint32Array && result.blend_index instanceof Uint32Array && result.blend_weight instanceof Float32Array);
  assert.equal(result.src_point.length, points);
  assert.equal(result.src_prim.length, primitives);
  assert.equal(result.src_vertex.length, corners);
  assert.equal(result.blend_offset.length, points + 1);
  assert.equal(result.blend_offset[0], 0);
  assert.equal(result.blend_offset[points], result.blend_index.length);
  assert.equal(result.blend_weight.length, result.blend_index.length);
  for (let i = 0; i < points; i++) {
    const start = result.blend_offset[i], end = result.blend_offset[i + 1], source = result.src_point[i];
    assert.ok(start <= end && end <= result.blend_index.length, 'point blend CSR bounds are monotone');
    assert.ok(source >= -1 && source < sources, 'point source is in range');
    if (source >= 0) assert.equal(start, end, 'exact copies do not need a blend');
    else {
      assert.ok(end > start, 'generated points carry interpolation provenance');
      near(Array.from(result.blend_weight.slice(start, end)).reduce((sum, w) => sum + w, 0), 1, 'blend weights sum to one', 1e-6);
    }
  }
  assert.ok(Array.from(result.blend_index).every((i) => i < sources), 'blend source indices are in range');
  assert.ok(Array.from(result.blend_weight).every((w) => Number.isFinite(w) && w >= 0 && w <= 1), 'blend weights are finite and nonnegative');
  assert.ok(Array.from(result.src_prim).every((i) => i >= -1 && i <= p.holes.length), 'primitive sources name input rings');
  assert.ok(Array.from(result.src_vertex).every((i) => i >= -1 && i < sources), 'corner sources are in range');
}
function assertSkeleton(p: PolygonCase, result: SkeletonResult, weights?: number[]) {
  assertCSR(result.vertices, result.face_start, result.face_vertex_index, 2);
  assertProvenance(p, result, result.vertices.length / 2, result.face_start.length - 1, result.face_vertex_index.length);
  assert.equal(result.face_edge.length, result.face_start.length - 1);
  assert.equal(result.node_time.length, result.vertices.length / 2);
  assert.ok(Array.from(result.node_time).every((time) => Number.isFinite(time) && time >= -1e-12), 'finite nonnegative times');
  const faces = loops(result.vertices, result.face_start, result.face_vertex_index);
  for (const [i, face] of faces.entries()) assertSimple(face, `${p.name} face ${i}`);
  near(faces.reduce((sum, face) => sum + Math.abs(area(face)), 0), inputArea(p), `${p.name}: faces tile input area`);
  const edgeCount = [p.outer, ...p.holes].reduce((sum, ring) => sum + ring.length / 2, 0);
  assert.ok(Array.from(result.face_edge).every((edge) => edge < edgeCount), 'face sources are contour edges');
  const inputEdges = [p.outer, ...p.holes].flatMap((ring) => Array.from({ length: ring.length / 2 }, (_, i) => [ring[i * 2], ring[i * 2 + 1], ring[(i * 2 + 2) % ring.length], ring[(i * 2 + 3) % ring.length]]));
  for (let f = 0; f < result.face_edge.length; f++) {
    const [ax, ay, bx, by] = inputEdges[result.face_edge[f]], length = Math.hypot(bx - ax, by - ay);
    for (let v = result.face_start[f]; v < result.face_start[f + 1]; v++) {
      const i = result.face_vertex_index[v], x = result.vertices[i * 2], y = result.vertices[i * 2 + 1];
      near(result.node_time[i], ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / length / (weights?.[result.face_edge[f]] ?? 1), `${p.name}: time equals source wavefront distance divided by speed`);
    }
  }
  assert.equal(result.arcs.length % 4, 0);
  assert.equal(result.arc_kind.length, result.arcs.length / 4);
  assert.ok(Array.from(result.arc_kind).every((kind) => kind === 0 || kind === 1));
  assert.ok(Array.from(result.arcs).every(Number.isFinite));
  for (let a = 0; a < result.arc_kind.length; a++) {
    if (result.arc_kind[a] !== 0) continue;
    const from = Array.from(result.arcs.slice(a * 4, a * 4 + 2)), to = Array.from(result.arcs.slice(a * 4 + 2, a * 4 + 4));
    for (const contour of [p.outer, ...p.holes]) for (let e = 0; e < contour.length; e += 2) {
      const j = (e + 2) % contour.length;
      assert.ok(!properCross(from, to, contour.slice(e, e + 2), contour.slice(j, j + 2)), `${p.name}: skeleton arc crosses contour ${JSON.stringify({ from, to, edge: contour.slice(e, e + 2), next: contour.slice(j, j + 2) })}`);
    }
  }
}
function offsetArea(result: OffsetResult) {
  assertCSR(result.vertices, result.polygon_start, result.polygon_vertex_index, 2);
  const rings = loops(result.vertices, result.polygon_start, result.polygon_vertex_index);
  assert.equal(result.polygon_hole.length, rings.length);
  return rings.reduce((sum, ring, p) => {
    assertSimple(ring, `offset ring ${p}`);
    const a = area(ring);
    assert.ok(result.polygon_hole[p] ? a < 0 : a > 0, 'offset winding matches hole flag');
    return sum + a;
  }, 0);
}
function assertRoof(p: PolygonCase, result: RoofResult, pitches: number | number[], cap?: number) {
  assertCSR(result.vertices, result.face_start, result.face_vertex_index, 3);
  assertProvenance(p, result, result.vertices.length / 3, result.face_start.length - 1, result.face_vertex_index.length);
  const faces = loops(result.vertices, result.face_start, result.face_vertex_index, 3);
  assert.equal(result.face_edge.length, faces.length);
  near(faces.reduce((sum, face) => sum + Math.abs(area(face)), 0), inputArea(p), `${p.name}: roof projection tiles footprint`);
  const edges: number[][] = [];
  for (const ring of [p.outer, ...p.holes]) for (let i = 0; i < ring.length; i += 2) edges.push([...ring.slice(i, i + 2), ring[(i + 2) % ring.length], ring[(i + 3) % ring.length]]);
  for (let f = 0; f < faces.length; f++) {
    assertSimple(faces[f], `roof face ${f}`);
    const source = result.face_edge[f];
    if (source === 0xffffffff) { assert.ok(cap !== undefined, 'plateau needs an explicit cap'); continue; }
    assert.ok(source < edges.length, 'roof source edge in range');
    const [ax, ay, bx, by] = edges[source], length = Math.hypot(bx - ax, by - ay), pitch = typeof pitches === 'number' ? pitches : pitches[source];
    for (let v = result.face_start[f]; v < result.face_start[f + 1]; v++) {
      const i = result.face_vertex_index[v] * 3, x = result.vertices[i], y = result.vertices[i + 1], height = result.vertices[i + 2];
      assert.ok(height >= -1e-12, 'nonnegative roof height');
      if (cap !== undefined) assert.ok(height <= cap + 1e-9, 'roof respects cap');
      const distance = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / length;
      if (pitch < 90) near(height, distance * Math.tan(pitch * Math.PI / 180), `roof face ${f} lies on source pitch plane`);
    }
  }
}

const bytes = new Uint8Array(await readFile(kernelsWasmURL));
await test('failed WASM initialisation clears the cache and permits a valid retry', async () => {
  await assert.rejects(loadKernels(Uint8Array.of(0)));
  const recovered = await loadKernels(bytes);
  assert.equal(recovered.straight_skeleton(rectangle.outer, []).face_edge.length, 4);
});
const kernels = await loadKernels(bytes);
await test('shipped WASM is below 1 MB; concurrent initialisation returns one API', async () => {
  assert.ok((await stat(kernelsWasmURL)).size < 1_000_000, 'WASM size budget');
  const values = await Promise.all([loadKernels(bytes), loadKernels(bytes), loadKernels(bytes)]);
  assert.ok(values.every((value) => value === kernels));
});
for (const p of cases) {
  await test(`${p.name}: skeleton area, simple faces, contour crossings and bit determinism`, () => {
    const a = kernels.straight_skeleton(p.outer, p.holes);
    assertSkeleton(p, a);
    assert.deepStrictEqual(kernels.straight_skeleton(p.outer, p.holes), a);
  });
  await test(`${p.name}: inward/outward offset and bit determinism`, () => {
    for (const distance of [0.05, -0.05]) {
      const a = kernels.offset_polygon(p.outer, p.holes, distance), actualArea = offsetArea(a);
      assertProvenance(p, a, a.vertices.length / 2, a.polygon_start.length - 1, a.polygon_vertex_index.length);
      assert.ok(distance > 0 ? actualArea < inputArea(p) : actualArea > inputArea(p), 'offset changes area in the requested direction');
      assert.deepStrictEqual(kernels.offset_polygon(p.outer, p.holes, distance), a);
    }
  });
  await test(`${p.name}: roof source planes, area and bit determinism`, () => {
    const a = kernels.roof(p.outer, p.holes, 35);
    assertRoof(p, a, 35);
    assert.deepStrictEqual(kernels.roof(p.outer, p.holes, 35), a);
  });
}
await test('rectangle analytic skeleton has four faces and the exact ridge at time 2', () => {
  const r = kernels.straight_skeleton(rectangle.outer, []);
  assert.equal(r.face_edge.length, 4);
  for (const x of [2, 4]) {
    const i = Array.from({ length: r.node_time.length }, (_, j) => j).find((j) => Math.abs(r.vertices[j * 2] - x) < 1e-12 && Math.abs(r.vertices[j * 2 + 1] - 2) < 1e-12);
    assert.notEqual(i, undefined, `ridge endpoint (${x},2)`);
    near(r.node_time[i!], 2, 'ridge time', 1e-12);
  }
});
await test('axis-aligned offsets match exact areas and disappear after collapse', () => {
  for (const [p, inward, outward] of [[rectangle, 15, 35], [ell, 9, 33], [uShape, 13, 45], [courtyard, 24, 72]] as const) {
    near(offsetArea(kernels.offset_polygon(p.outer, p.holes, 0.5)), inward, `${p.name} inward area`);
    near(offsetArea(kernels.offset_polygon(p.outer, p.holes, -0.5)), outward, `${p.name} outward area`);
    const vanished = kernels.offset_polygon(p.outer, p.holes, 10);
    assert.equal(vanished.polygon_start.length, 1, `${p.name} completely eroded`);
  }
});
await test('per-edge roof pitches move ridge geometrically; cap creates a closed plateau', () => {
  const pitches = [30, 60, 30, 60], roof = kernels.roof(rectangle.outer, [], pitches);
  assertRoof(rectangle, roof, pitches);
  const high = Math.max(...Array.from(roof.vertices).filter((_, i) => i % 3 === 2));
  near(high, 2 / Math.sqrt(3), 'weighted ridge height');
  for (const x of [2 / 3, 16 / 3]) assert.ok(Array.from({ length: roof.vertices.length / 3 }, (_, i) => i).some((i) => Math.abs(roof.vertices[i * 3] - x) < 1e-9 && Math.abs(roof.vertices[i * 3 + 1] - 2) < 1e-9 && Math.abs(roof.vertices[i * 3 + 2] - high) < 1e-9), `weighted ridge endpoint x=${x}`);
  const capped = kernels.roof(rectangle.outer, [], pitches, 0.5);
  assertRoof(rectangle, capped, pitches, 0.5);
  assert.ok(capped.face_edge.includes(0xffffffff), 'height cap has a plateau face');
  for (let f = 0; f < capped.face_edge.length; f++) if (capped.face_edge[f] === 0xffffffff)
    for (let v = capped.face_start[f]; v < capped.face_start[f + 1]; v++) near(capped.vertices[capped.face_vertex_index[v] * 3 + 2], 0.5, 'plateau height');
});
await test('nonuniform weights handle concave split events and hole merges deterministically', () => {
  for (const p of [ell, uShape, courtyard, felkelFailure, aichholzerFailure]) {
    const count = [p.outer, ...p.holes].reduce((sum, ring) => sum + ring.length / 2, 0);
    const pitches = Array.from({ length: count }, (_, i) => [23, 41, 57, 32, 64, 48, 38][i % 7]);
    const weights = pitches.map((pitch) => 1 / Math.tan(pitch * Math.PI / 180));
    const skeleton = kernels.straight_skeleton(p.outer, p.holes, weights);
    assertSkeleton(p, skeleton, weights);
    assert.deepStrictEqual(kernels.straight_skeleton(p.outer, p.holes, weights), skeleton);
    const roof = kernels.roof(p.outer, p.holes, pitches);
    assertRoof(p, roof, pitches);
    assert.deepStrictEqual(kernels.roof(p.outer, p.holes, pitches), roof);
  }
});
await test('invalid polygons fail clearly without trapping or poisoning the module', () => {
  const invalid = [
    { outer: [0, 0, 6, 0, 6, 0, 6, 4, 0, 4], holes: [] },
    { outer: [0, 0, 1, 0, 2, 0], holes: [] },
    { outer: [0, 0, 4, 4, 0, 4, 4, 0], holes: [] },
    { outer: [0, 0, 1, 0, 1, Number.NaN], holes: [] },
    { outer: rectangle.outer, holes: [[20, 20, 20, 21, 21, 21, 21, 20]] },
  ];
  for (const p of invalid) for (const call of [() => kernels.straight_skeleton(p.outer, p.holes), () => kernels.offset_polygon(p.outer, p.holes, 0.2), () => kernels.roof(p.outer, p.holes, 35)]) {
    assert.throws(call, (error: unknown) => error instanceof Error && !/unreachable|out of bounds|panic/i.test(error.message) && error.message.length > 8);
  }
  assertSkeleton(rectangle, kernels.straight_skeleton(rectangle.outer, []));
});
await test('deterministic simple random polygon property corpus tiles and preserves contours', () => {
  let seed = 0x51ce1;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let c = 0; c < 24; c++) {
    const n = 5 + c % 12, outer: number[] = [];
    for (let i = 0; i < n; i++) { const angle = (i + 0.1 * random()) * Math.PI * 2 / n, radius = 2 + 3 * random(); outer.push(Math.cos(angle) * radius, Math.sin(angle) * radius); }
    const p = { name: `property seed 0x51ce1 case ${c}`, outer, holes: [] };
    const a = kernels.straight_skeleton(p.outer, []);
    assertSkeleton(p, a);
    assert.deepStrictEqual(kernels.straight_skeleton(p.outer, []), a);
  }
});

function countingHost() {
  const original = createNodeHost({ workers: 0 });
  let reads = 0;
  const host: Host = { ...original, async readFile(path) { if (/topotopo_kernels.*\.wasm/.test(path)) reads++; return original.readFile(path); } };
  return { host, reads: () => reads };
}
const firstHost = countingHost(), engine = new Engine(firstHost.host);
await engine.init();
await test('host loads lazily, reads once across concurrent callers, and caches separately per host', async () => {
  assert.equal(firstHost.reads(), 0, 'engine import/init does not read kernels');
  await engine.cook({ nodes: { source: { type: 'box' } }, output: 'source' });
  assert.equal(firstHost.reads(), 0, 'unrelated nodes do not load kernels');
  const [one, two] = await Promise.all([loadHostKernels(firstHost.host), loadHostKernels(firstHost.host)]);
  assert.equal(one, two);
  assert.equal(firstHost.reads(), 1);
  const secondHost = countingHost();
  await Promise.all([loadHostKernels(secondHost.host), loadHostKernels(secondHost.host)]);
  assert.equal(secondHost.reads(), 1, 'second host reads its own file');
});
await test('a failed host read clears its cache and retries once on the same host', async () => {
  const original = createNodeHost({ workers: 0 });
  let attempts = 0;
  const host: Host = { ...original, async readFile() { if (++attempts === 1) throw new Error('temporary kernel read failure'); return bytes; } };
  await assert.rejects(loadHostKernels(host), /temporary kernel read failure/);
  const [one, two] = await Promise.all([loadHostKernels(host), loadHostKernels(host)]);
  assert.equal(one, two);
  assert.equal(attempts, 2);
  await loadHostKernels(host);
  assert.equal(attempts, 2, 'successful retry stays cached');
});
function footprint(p: PolygonCase): Geometry {
  const positions: number[] = [], prims: number[][] = [];
  for (const ring of [p.outer, ...p.holes]) {
    const ids: number[] = [];
    for (let i = 0; i < ring.length; i += 2) { ids.push(positions.length / 3); positions.push(ring[i], 0, ring[i + 1]); }
    prims.push(ids);
  }
  const geo = new Geometry({ positions, prims });
  const marker = geo.points.add('marker', 'float', 1), uv = geo.vertices.add('uv', 'float', 3), source = geo.prims.add('source', 'int', 1);
  for (let i = 0; i < geo.numPoints; i++) marker.set(i, 7);
  for (let i = 0; i < geo.numVertices; i++) uv.set(i, [0.25, 0.75, 0]);
  for (let p = 0; p < geo.numPrims; p++) source.set(p, 100 + p);
  geo.detail.add('label', 'string', 1).set(0, 'kernel footprint');
  return geo;
}
let cookId = 0;
async function cook(geo: Geometry, params: Record<string, unknown>) {
  const result = await engine.cook({ nodes: { source: { type: 'input' }, kernel: { type: 'straight_skeleton', in: ['source'], params } }, output: 'kernel' }, { inputs: [{ geo, sig: `kernel-test-${cookId++}` }] });
  assert.ok(result.ok && result.geo, result.errors.map((error) => error.message).join('; '));
  assert.deepStrictEqual(checkGeo(result.geo!), []);
  return result.geo!;
}
function addFootprintCap(roof: Geometry, p: PolygonCase): Geometry {
  const positions = Array.from(roof.P), prims = Array.from({ length: roof.numPrims }, (_, i) => Array.from(roof.primPoints(i)));
  const rings = [p.outer, ...p.holes], flat = rings.flat(), holes: number[] = [];
  let count = rings[0].length / 2;
  for (const ring of rings.slice(1)) { holes.push(count); count += ring.length / 2; }
  const pointMap: number[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const point = Array.from({ length: roof.numPoints }, (_, j) => j).find((j) => Math.abs(roof.P[j * 3] - flat[i]) < 1e-9 && Math.abs(roof.P[j * 3 + 1]) < 1e-9 && Math.abs(roof.P[j * 3 + 2] - flat[i + 1]) < 1e-9);
    assert.notEqual(point, undefined, 'roof retains all footprint boundary vertices');
    pointMap.push(point!);
  }
  const triangles = earcut(flat, holes, 2);
  for (let i = 0; i < triangles.length; i += 3) {
    const ids = triangles.slice(i, i + 3), ring = ids.flatMap((j) => [flat[j * 2], flat[j * 2 + 1]]);
    if (area(ring) < 0) ids.reverse(); // CCW in XZ points downward in Y-up.
    prims.push(ids.map((j) => pointMap[j]));
  }
  return new Geometry({ positions, prims });
}
function assertWatertight(roof: Geometry, p: PolygonCase) {
  const capped = addFootprintCap(roof, p), report = topologyReport(capped);
  assert.equal(report.closed, true, JSON.stringify(report));
  assert.equal(report.boundaryEdges, 0);
  assert.equal(report.nonManifoldEdges, 0);
  assert.equal(report.degenerate, 0);
  const directed = new Map<string, number>();
  for (let f = 0; f < capped.numPrims; f++) {
    const points = capped.primPoints(f);
    for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length], key = `${Math.min(a, b)}:${Math.max(a, b)}`; directed.set(key, (directed.get(key) ?? 0) + (a < b ? 1 : -1)); }
  }
  assert.ok([...directed.values()].every((balance) => balance === 0), 'adjacent faces have consistent winding');
  assert.ok(signedVolume(capped) > 0, 'capped roof normals face outward');
}
for (const p of [rectangle, ell, courtyard]) for (const mode of ['skeleton', 'offset', 'roof']) {
  await test(`node ${p.name} ${mode}: host path, attributes, geometry and topology`, async () => {
    const src = footprint(p), before = Array.from(src.P), geo = await cook(src, { mode, distance: 0.5, pitch: 35 });
    assert.deepStrictEqual(Array.from(src.P), before, 'source remains immutable');
    assert.ok(geo.numPrims > 0);
    assert.ok(geo.points.get('marker'), 'point attribute is retained');
    for (let i = 0; i < geo.numPoints; i++) near(Number(geo.points.get('marker')!.get(i)), 7, 'point attributes carry through provenance', 1e-12);
    assert.equal(geo.detail.get('label')?.get(0), 'kernel footprint');
    if (mode === 'skeleton') {
      assert.ok(Array.from(geo.primClosed).every((value) => value === 0));
      const kind = geo.prims.get('kind');
      assert.ok(kind && Array.from(kind.data as Int32Array).every((value) => value === 0 || value === 1));
    } else assert.ok(Array.from(geo.primClosed).every((value) => value === 1));
    if (mode === 'roof') {
      const edge = geo.prims.get('edge');
      assert.ok(edge, 'roof has source contour edge attribute');
      for (let f = 0; f < geo.numPrims; f++) {
        assert.ok(primNewell(geo, f)[1] > 0, 'uncapped roof points upward');
        const sourceEdge = Number(edge!.get(f)), sourcePrim = sourceEdge < p.outer.length / 2 ? 0 : 1;
        assert.equal(geo.prims.get('source')?.get(f), 100 + sourcePrim, 'face inherits its contour primitive attributes');
      }
      assertWatertight(geo, p);
      assert.ok(geo.vertices.get('uv'), 'per-corner UV attribute is retained');
      for (let v = 0; v < geo.numVertices; v++) assert.deepStrictEqual(geo.vertices.get('uv')!.get(v), [0.25, 0.75, 0], 'vertex provenance carries UV values');
    }
    assert.equal(firstHost.reads(), 1, 'every node shares the host load');
  });
}
await test('node reads per-point pitch attribute and makes capped weighted roof watertight', async () => {
  const src = footprint(rectangle), pitch = src.points.add('roof_pitch', 'float', 1);
  [30, 60, 30, 60].forEach((value, i) => pitch.set(i, value));
  const weighted = await cook(src, { mode: 'roof', pitch: 15, pitch_attrib: 'roof_pitch' });
  near(Math.max(...Array.from(weighted.P).filter((_, i) => i % 3 === 1)), 2 / Math.sqrt(3), 'point pitch attribute changes ridge');
  const geo = await cook(src, { mode: 'roof', pitch: 15, pitch_attrib: 'roof_pitch', height_cap: 0.5 });
  near(Math.max(...Array.from(geo.P).filter((_, i) => i % 3 === 1)), 0.5, 'node height cap');
  assert.ok((geo.prims.get('edge')!.data as Int32Array).includes(-1), 'flat cap uses edge=-1');
  assertWatertight(geo, rectangle);
});
await test('node reads primitive pitch and is deterministic with a fresh input signature', async () => {
  const src = footprint(rectangle); src.prims.add('roof_pitch', 'float', 1).set(0, 45);
  const a = await cook(src, { mode: 'roof', pitch_attrib: 'roof_pitch' }), b = await cook(src, { mode: 'roof', pitch_attrib: 'roof_pitch' });
  near(Math.max(...Array.from(a.P).filter((_, i) => i % 3 === 1)), 2, 'primitive pitch gives 45 degree roof');
  assert.deepStrictEqual(a.P, b.P); assert.deepStrictEqual(a.primStart, b.primStart); assert.deepStrictEqual(a.vertexPoint, b.vertexPoint);
});
await test('gable roof keeps stationary end walls and is watertight with a footprint cap', async () => {
  const src = footprint(rectangle), pitch = src.points.add('roof_pitch', 'float', 1);
  [35, 90, 35, 90].forEach((value, i) => pitch.set(i, value));
  const geo = await cook(src, { mode: 'roof', pitch_attrib: 'roof_pitch' });
  near(Math.max(...Array.from(geo.P).filter((_, i) => i % 3 === 1)), 2 * Math.tan(35 * Math.PI / 180), 'gable ridge height');
  assert.equal(Array.from({ length: geo.numPrims }, (_, p) => p).filter((p) => Math.abs(primNewell(geo, p)[1]) < 1e-10).length, 2, 'two vertical gable faces');
  assertWatertight(geo, rectangle);
});
await test('one bridged primitive encodes the same courtyard as separate opposite-winding primitives', async () => {
  const p: PolygonCase = { name: 'bridged courtyard', holes: [], outer: [0, 0, 8, 0, 8, 8, 0, 8, 0, 0, 2, 2, 2, 6, 6, 6, 6, 2, 2, 2, 0, 0] };
  const geo = await cook(footprint(p), { mode: 'roof', pitch: 35 });
  assertWatertight(geo, courtyard);
  near(Array.from({ length: geo.numPrims }, (_, f) => Math.abs(primNewell(geo, f)[1]) / 2).reduce((a, b) => a + b, 0), 48, 'bridged courtyard roof excludes the hole');
});
await test('group preserves unselected primitives and their attributes unchanged', async () => {
  const p: PolygonCase = { name: 'two footprints', outer: rectangle.outer, holes: [[10, 0, 12, 0, 12, 2, 10, 2]] };
  const src = footprint(p), geo = await cook(src, { mode: 'roof', pitch: 35, group: '0' });
  const untouched = Array.from({ length: geo.numPrims }, (_, p) => p).filter((p) => geo.prims.get('source')?.get(p) === 101);
  assert.equal(untouched.length, 1);
  const points = Array.from(geo.primPoints(untouched[0])).flatMap((i) => Array.from(geo.P.slice(i * 3, i * 3 + 3)));
  assert.deepStrictEqual(points, [10, 0, 0, 12, 0, 0, 12, 0, 2, 10, 0, 2]);
});
await test('node rejects intersecting/touching loops and nonplanarity even at a large world origin', async () => {
  const invalid: Geometry[] = [
    footprint({ name: 'overlap', outer: rectangle.outer, holes: [[5, 1, 7, 1, 7, 3, 5, 3]] }),
    footprint({ name: 'touch', outer: rectangle.outer, holes: [[6, 1, 8, 1, 8, 3, 6, 3]] }),
  ];
  const warp = footprint(rectangle);
  for (let i = 0; i < warp.numPoints; i++) { warp.P[i * 3] += 1e9; warp.P[i * 3 + 1] = 1e9; warp.P[i * 3 + 2] += 1e9; }
  warp.P[1] += 0.1; invalid.push(warp);
  for (const src of invalid) {
    const result = await engine.cook({ nodes: { source: { type: 'input' }, kernel: { type: 'straight_skeleton', in: ['source'], params: { mode: 'roof' } } }, output: 'kernel' }, { inputs: [{ geo: src, sig: `invalid-${cookId++}` }] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /intersect|touch|plan|horizontal/i.test(error.message)), result.errors.map((error) => error.message).join('; '));
  }
});
await test('node preserves courtyard holes, provenance and finite unit roof normals at tiny and huge scales', async () => {
  for (const scale of [1e-200, 1e200]) {
    const scaled: PolygonCase = { name: `courtyard at scale ${scale}`, outer: courtyard.outer.map((v) => v * scale), holes: courtyard.holes.map((ring) => ring.map((v) => v * scale)) };
    for (const mode of ['skeleton', 'offset', 'roof']) {
      const geo = await cook(footprint(scaled), { mode, distance: 0.5 * scale, pitch: 35 });
      for (const cls of ['point', 'vertex', 'prim'] as const) for (const [name, attr] of geo.table(cls).map)
        if (attr.type === 'float') assert.ok(Array.from(attr.data as Float64Array).every(Number.isFinite), `${scale} ${mode} ${cls}.${name} is finite`);
      assert.ok(Array.from(geo.points.get('marker')!.data as Float64Array).every((v) => Math.abs(v - 7) < 1e-12), 'scaled contour provenance retains values');
      const normalized = geo.clone();
      for (let i = 0; i < normalized.P.length; i++) normalized.P[i] /= scale;
      if (mode === 'offset') {
        assert.equal(geo.numPrims, 2, 'offset retains the outer ring and courtyard hole');
        const total = Array.from({ length: normalized.numPrims }, (_, p) => area(normalized.primPoints(p).flatMap((i) => [normalized.P[i * 3], normalized.P[i * 3 + 2]]))).reduce((a, b) => a + b, 0);
        near(Math.abs(total), 24, 'scaled offset excludes expanded courtyard');
      }
      if (mode === 'roof') {
        assertWatertight(normalized, courtyard);
        for (const cls of ['prim', 'vertex'] as const) {
          const normals = geo.table(cls).get('N')!.data as Float64Array;
          for (let i = 0; i < normals.length; i += 3) {
            near(Math.hypot(normals[i], normals[i + 1], normals[i + 2]), 1, 'scaled roof normal has unit length');
            assert.ok(normals[i + 1] > 0, 'scaled hip roof faces upward');
          }
        }
      }
    }
  }
});
await test('node rejects roof elevation overflow instead of emitting non-finite geometry', async () => {
  const src = footprint({ name: 'huge elevated roof', outer: [0, 0, 1e308, 0, 1e308, 1e308, 0, 1e308], holes: [] });
  for (let i = 1; i < src.P.length; i += 3) src.P[i] = 1e308;
  const result = await engine.cook({ nodes: { source: { type: 'input' }, kernel: { type: 'straight_skeleton', in: ['source'], params: { mode: 'roof', pitch: 70 } } }, output: 'kernel' }, { inputs: [{ geo: src, sig: `overflow-${cookId++}` }] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /finite numeric range|rescale/i.test(error.message)), result.errors.map((error) => error.message).join('; '));
});
await test('timing 200-vertex skeleton and roof (three warmed runs, median milliseconds)', () => {
  for (const operation of ['skeleton', 'roof'] as const) {
    const fn = operation === 'skeleton' ? () => kernels.straight_skeleton(noisy.outer, []) : () => kernels.roof(noisy.outer, [], 35);
    fn();
    const times = Array.from({ length: 3 }, () => { const start = performance.now(); fn(); return performance.now() - start; }).sort((a, b) => a - b);
    console.log(`BENCH kernels: 200-vertex ${operation} median ${times[1].toFixed(3)} ms (runs ${times.map((t) => t.toFixed(3)).join(', ')} ms)`);
  }
});
console.log(`kernels: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
