// Field-aligned quad remeshing: real WASM, provenance, wedge UVs, restrictions and deterministic cooks.
// node test/remeshquad.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { openPackages } from '../src/packages/registry.ts';
import type { Geometry } from '../src/core/geometry.ts';
import type { NodeSpec, GraphSpec } from '../src/graph/types.ts';
import { halfEdges } from '../src/core/halfedge.ts';
import { primArea, topologyReport, triangulate } from '../src/core/topology.ts';
import { selfIntersections } from '../src/core/analysis.ts';
import { kernelsWasmURL, kernelsWasmVariant, loadKernels } from '../src/wasm/kernels.ts';
import type { QuadRemeshResult } from '../src/wasm/kernels.ts';
import { fingerprint } from './fingerprint.ts';

const off = new Engine(createNodeHost({ workers: 0 }));
const on = new Engine(createNodeHost({ workers: 2, pool: { minElements: 1 } }));
await off.init(); await on.init();
const kernels = await loadKernels(fs.readFileSync(kernelsWasmURL));
let checks = 0;
const failures: string[] = [];
function check(condition: unknown, label: string): void {
  checks++;
  if (!condition) { failures.push(label); console.error(`FAIL ${label}`); }
}
async function cook(nodes: Record<string, NodeSpec>, output: string, engine = off): Promise<Geometry> {
  const r = await engine.cook({ nodes, output });
  assert.ok(r.ok && r.geo, r.errors.map(e => `${e.node}: ${e.message}`).join('; '));
  return r.geo!;
}
function watertight(g: Geometry): boolean {
  const t = topologyReport(g);
  const faces = new Set<string>();
  for (let p = 0; p < g.numPrims; p++) {
    const key = g.primPoints(p).sort((a, b) => a - b).join(',');
    if (faces.has(key)) return false;
    faces.add(key);
  }
  return t.closed && t.degenerate === 0 && halfEdges(g).isManifold;
}
function center(g: Geometry, p: number): number[] {
  const c = [0, 0, 0], points = g.primPoints(p);
  for (const i of points) for (let k = 0; k < 3; k++) c[k] += g.P[i * 3 + k] / points.length;
  return c;
}
function equalMesh(a: Geometry, b: Geometry, label: string): void {
  assert.deepEqual(a.P, b.P, `${label}: exact positions`);
  assert.deepEqual(a.primStart, b.primStart, `${label}: exact offsets`);
  assert.deepEqual(a.vertexPoint, b.vertexPoint, `${label}: exact indices`);
  assert.deepEqual(a.primClosed, b.primClosed, `${label}: exact closed flags`);
  for (const cls of ['points', 'vertices', 'prims', 'detail'] as const) {
    assert.deepEqual([...a[cls].names()].sort(), [...b[cls].names()].sort(), `${label}: ${cls} attribute names`);
    for (const name of a[cls].names()) assert.deepEqual(a[cls].get(name)!.data, b[cls].get(name)!.data, `${label}: ${cls}.${name}`);
  }
  for (const cls of ['point', 'vertex', 'prim'] as const) assert.deepEqual([...a.groups(cls)], [...b.groups(cls)], `${label}: ${cls} groups`);
  assert.deepEqual([...a.edgeGroups].map(([name, edges]) => [name, [...edges]]), [...b.edgeGroups].map(([name, edges]) => [name, [...edges]]), `${label}: edge groups`);
  checks++;
}

function meshValence(positions: ArrayLike<number>, starts: ArrayLike<number>, corners: ArrayLike<number>): Uint32Array {
  const valence = new Uint32Array(positions.length / 3), seen = new Set<number>();
  for (let p = 0; p + 1 < starts.length; p++) for (let v = starts[p]; v < starts[p + 1]; v++) {
    const a = corners[v], b = corners[v + 1 < starts[p + 1] ? v + 1 : starts[p]];
    const key = Math.min(a, b) * valence.length + Math.max(a, b);
    if (!seen.has(key)) { seen.add(key); valence[a]++; valence[b]++; }
  }
  return valence;
}

/** Compare every returned byte, including provenance, signed zeros and the quality report. */
function equalKernel(a: QuadRemeshResult, b: QuadRemeshResult, label: string): void {
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${label}: result fields`);
  for (const name of ['positions', 'prim_start', 'vertex_point', 'source_triangle', 'barycentric',
    'src_point', 'blend_offset', 'blend_index', 'blend_weight', 'src_prim', 'src_vertex'] as const) {
    const actual = a[name], expected = b[name];
    assert.equal(actual.constructor, expected.constructor, `${label}.${name}: typed array type`);
    assert.deepEqual(new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength),
      new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength), `${label}.${name}: identical bytes`);
  }
  assert.deepEqual(a.quality, b.quality, `${label}: exact quality values`);
  checks++;
}

try {
  const sphereNodes: Record<string, NodeSpec> = {
    sphere: { type: 'sphere', params: { type: 'ico', level: 3 } },
    color: { type: 'wrangle', in: ['sphere'], params: { code: '@Cd = set(@P.x * 0.5 + 0.5, @P.y * 0.5 + 0.5, @P.z * 0.5 + 0.5);' } },
    out: { type: 'remesh_quad', in: ['color'], params: { target_length: 0.14, smooth_iterations: 8 } },
  };
  const sphereInput = await cook(sphereNodes, 'color'), immutableInput = sphereInput.clone();
  const sphere = await cook(sphereNodes, 'out');
  equalMesh(sphereInput, immutableInput, 'upstream cooked geometry remains immutable');
  check(sphere.numPrims > 0 && watertight(sphere), 'sphere: closed, manifold, nondegenerate output');
  let quads = 0, within = 0;
  for (let p = 0; p < sphere.numPrims; p++) { if (sphere.primSize(p) === 4) quads++; check([3, 4].includes(sphere.primSize(p)), 'sphere: quad-dominant output only contains triangles and quads'); }
  const he = halfEdges(sphere), valence = new Uint32Array(sphere.numPoints);
  let edgeMin = Infinity, edgeMax = 0, edgeSum = 0;
  for (let e = 0; e < he.numEdges; e++) {
    const length = he.edgeLength(e);
    if (Math.abs(length - 0.14) <= 0.35 * 0.14) within++;
    valence[he.edgeA[e]]++; valence[he.edgeB[e]]++;
    edgeMin = Math.min(edgeMin, length); edgeMax = Math.max(edgeMax, length); edgeSum += length;
  }
  const fraction = quads / sphere.numPrims;
  check(Math.abs(Number(sphere.detail.get('quad_fraction')?.get(0)) - fraction) < 1e-12, 'quad_fraction detail matches actual faces');
  check(Number.isInteger(Number(sphere.detail.get('singularities')?.get(0))), 'singularities detail is an integer');
  check(Number(sphere.detail.get('singularities')?.get(0)) === valence.filter(n => n !== 4).length, 'singularities detail counts actual irregular vertices');
  check(Number(sphere.detail.get('irregular_fraction')?.get(0)) === valence.filter(n => n !== 4).length / sphere.numPoints, 'irregular_fraction detail matches actual interior irregular vertices / output points');
  check(!valence.includes(2), 'cleanup: closed sphere has no valence-2 vertices');
  for (const [name, actual] of [['edge_length_min', edgeMin], ['edge_length_mean', edgeSum / he.numEdges], ['edge_length_max', edgeMax]] as const) {
    check(Math.abs(Number(sphere.detail.get(name)?.get(0)) - actual) < 1e-10, `${name} detail agrees with actual geometry`);
  }
  console.log(`sphere quality: ${sphere.numPoints} points, ${sphere.numPrims} faces, ${(fraction * 100).toFixed(2)}% quads, ${sphere.detail.get('singularities')?.get(0)} singularities, ${(within / he.numEdges * 100).toFixed(2)}% edges within target +/-35%`);
  check(fraction > 0.9, 'sphere: quad fraction > 90%');
  check(Number(sphere.detail.get('singularities')?.get(0)) / sphere.numPoints < 0.02, 'sphere: singularities < 2% of output points');
  check(within / he.numEdges > 0.9, 'sphere: >90% of edges within target +/-35%');
  const cd = sphere.points.get('Cd')!.data as Float64Array;
  let cdError = 0;
  for (let i = 0; i < sphere.P.length; i++) cdError = Math.max(cdError, Math.abs(cd[i] - (sphere.P[i] * 0.5 + 0.5)));
  check(cdError < 1e-6, `point Cd follows barycentric final projection (max error ${cdError})`);
  const normals = sphere.points.get('N');
  check(normals?.size === 3, 'point normals refreshed');
  for (let i = 0; i < sphere.numPoints; i++) {
    const n = normals!.get(i) as number[];
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-8 && n.every(Number.isFinite), 'unit finite point normal');
  }
  checks++;
  // Clear the content-addressed cache so determinism checks run the actual kernel again.
  off.cache.clear();
  const repeat = await cook({ ...sphereNodes, again: { ...sphereNodes.out } }, 'again');
  equalMesh(sphere, repeat, 'repeat cook');
  equalMesh(sphere, await cook({ ...sphereNodes, cleanup: { ...sphereNodes.out, params: { ...sphereNodes.out.params, cleanup: true } } }, 'cleanup'), 'cleanup defaults to true');
  const uncleanedNodes = { ...sphereNodes, out: { ...sphereNodes.out, params: { ...sphereNodes.out.params, cleanup: false } } };
  const uncleaned = await cook(uncleanedNodes, 'out');
  check(watertight(uncleaned), 'cleanup=false retains a valid closed mesh');
  off.cache.clear();
  equalMesh(uncleaned, await cook(uncleanedNodes, 'out'), 'cleanup=false deterministic');
  await on.host.pool?.warm();
  equalMesh(sphere, await cook(sphereNodes, 'out', on), 'pool off/on');
  check(on.poolStats.parallel > 0, 'pool equality includes an upstream wrangle that actually ran on worker threads');
  for (const alias of ['quadremesh', 'quad_remesh', 'instant_meshes']) {
    const aliasGeo = await cook({ ...sphereNodes, alias: { ...sphereNodes.out, type: alias } }, 'alias');
    equalMesh(sphere, aliasGeo, `alias ${alias}`);
  }

  const boxNodes: Record<string, NodeSpec> = {
    box: { type: 'box' },
    ids: { type: 'wrangle', in: ['box'], params: { run_over: 'prims', code: 'i@source_face = @primnum;' } },
    mat: { type: 'material', in: ['ids'], params: { name: 'quad_test_material' } },
    out: { type: 'remesh_quad', in: ['mat'], params: { target_length: 0.2, feature_angle: 45, preserve_sharp: true } },
  };
  const box = await cook(boxNodes, 'out'), ref = await cook(boxNodes, 'mat');
  check(watertight(box), 'box: closed and manifold');
  const boxHe = halfEdges(box);
  let sharpLength = 0, alignment = 1;
  for (let e = 0; e < boxHe.numEdges; e++) if (boxHe.dihedralAngle(e) > 80) {
    const a = boxHe.edgeA[e], b = boxHe.edgeB[e];
    const d = [0, 1, 2].map(k => box.P[a * 3 + k] - box.P[b * 3 + k]), length = Math.hypot(...d);
    sharpLength += length; alignment = Math.min(alignment, Math.max(...d.map(Math.abs)) / length);
  }
  check(Math.abs(sharpLength - 12) < 1e-6 && alignment >= Math.cos(5 * Math.PI / 180), 'box: full twelve sharp edges preserved and aligned within 5 degrees');
  const uv = box.vertices.get('uv')!.data as Float64Array;
  const sourceFace = box.prims.get('source_face')!;
  let uvError = 0;
  for (let p = 0; p < box.numPrims; p++) {
    const c = center(box, p), original = Number(sourceFace.get(p)), expected = center(ref, original);
    const axis = expected.findIndex(n => Math.abs(n) === 0.5);
    assert.ok(axis >= 0 && Math.abs(c[axis] - expected[axis]) < 1e-8, 'prim attributes copied from the geometrically matching source face');
    assert.equal(box.prims.get('material')?.get(p), 'quad_test_material');
    for (let v = box.primStart[p]; v < box.primStart[p + 1]; v++) {
      const i = box.vertexPoint[v], point = [0, 1, 2].map(k => box.P[i * 3 + k]);
      // Independent affine box-face oracle: unlike a nudged closest-triangle query, this cannot
      // accidentally select the other half of a face and clamp a point onto its internal diagonal.
      const want = [point[(axis + 1) % 3] + 0.5, point[(axis + 2) % 3] + 0.5, 0];
      for (let k = 0; k < 3; k++) uvError = Math.max(uvError, Math.abs(uv[v * 3 + k] - want[k]));
    }
  }
  check(!!box.detail.get('materials'), 'material detail table copied');
  check(uvError < 1e-6, `vertex UV follows each source face including both sides of seams (max error ${uvError})`);
  checks++;
  const densityCounts: number[] = [];
  for (const target of [96, 384]) {
    const density = await cook({ box: { type: 'box' }, out: { type: 'remesh_quad', in: ['box'], params: { target_length: 0.00001, target_faces: target } } }, 'out');
    check(watertight(density) && density.numPrims > target * 0.5 && density.numPrims < target * 2, `target_faces ${target} overrides target_length and controls approximate density (${density.numPrims} faces)`);
    densityCounts.push(density.numPrims);
  }
  check(densityCounts[1] > densityCounts[0] * 2, 'larger target_faces increases actual output density');

  const uvSphere = await cook({ sphere: { type: 'sphere', params: { rows: 24, cols: 48 } }, out: { type: 'remesh_quad', in: ['sphere'], params: { target_length: 0.16 } } }, 'out');
  const seamUV = uvSphere.vertices.get('uv')!.data as Float64Array, perPoint = new Map<number, Set<number>>();
  let maxSpan = 0;
  for (let p = 0; p < uvSphere.numPrims; p++) {
    let lo = Infinity, hi = -Infinity;
    for (let v = uvSphere.primStart[p]; v < uvSphere.primStart[p + 1]; v++) {
      const u = seamUV[v * 3], point = uvSphere.vertexPoint[v];
      // At the poles the input itself has a separate wedge U for every incident face.
      if (Math.abs(uvSphere.P[point * 3 + 1]) < 0.98) { lo = Math.min(lo, u); hi = Math.max(hi, u); }
      if (Math.abs(uvSphere.P[point * 3 + 1]) < 0.98) {
        if (!perPoint.has(point)) perPoint.set(point, new Set());
        perPoint.get(point)!.add(Math.round(u * 1e6));
      }
    }
    if (Number.isFinite(lo)) maxSpan = Math.max(maxSpan, hi - lo);
  }
  const seamPoints = [...perPoint.values()].filter(values => Math.max(...values) - Math.min(...values) > 900000).length;
  check(maxSpan < 0.35 && seamPoints > 2 && watertight(uvSphere), `UV sphere seam survives (${seamPoints} seam points, max face U span ${maxSpan})`);

  const gridNodes: Record<string, NodeSpec> = {
    grid: { type: 'grid', params: { size: [2, 2], divisions: [8, 8] } },
    uv: { type: 'attrib_promote', in: ['grid'], params: { name: 'uv', from: 'point', to: 'vertex' } },
    ids: { type: 'wrangle', in: ['uv'], params: { run_over: 'prims', code: 'i@source_face = @primnum;' } },
    out: { type: 'remesh_quad', in: ['ids'], params: { target_length: 0.14, group: '@P.x>0' } },
  };
  const restricted = await cook(gridNodes, 'out'), grid = await cook(gridNodes, 'ids');
  const passed = new Set<number>();
  for (let p = 0; p < restricted.numPrims; p++) if (center(restricted, p)[0] < 0) {
    const original = Number(restricted.prims.get('source_face')!.get(p)); passed.add(original);
    assert.deepEqual(restricted.primPoints(p).map(i => Array.from(restricted.P.slice(i * 3, i * 3 + 3))), grid.primPoints(original).map(i => Array.from(grid.P.slice(i * 3, i * 3 + 3))), 'unselected polygon is unchanged');
  }
  check(passed.size === 32, 'group: all 32 unselected polygons pass through unchanged');
  const gridUV = restricted.vertices.get('uv')!;
  let gridUVError = 0;
  for (let v = 0; v < restricted.numVertices; v++) {
    const point = restricted.vertexPoint[v], actual = gridUV.get(v) as number[];
    // Grid's xz frame has +X and -Z axes.
    gridUVError = Math.max(gridUVError, Math.abs(actual[0] - (restricted.P[point * 3] + 1) / 2), Math.abs(actual[1] - (1 - restricted.P[point * 3 + 2]) / 2));
  }
  check(gridUVError < 1e-6, 'group: continuous planar vertex UV interpolation');
  const gridHe = halfEdges(restricted);
  let interiorCracks = 0;
  for (let e = 0; e < gridHe.numEdges; e++) if (gridHe.isBoundaryEdge(e)) {
    const a = gridHe.edgeA[e], b = gridHe.edgeB[e];
    const exterior = [0, 2].some(k => Math.abs(Math.abs(restricted.P[a * 3 + k]) - 1) < 1e-8 && Math.abs(restricted.P[a * 3 + k] - restricted.P[b * 3 + k]) < 1e-8);
    if (!exterior) interiorCracks++;
  }
  check(gridHe.isManifold && interiorCracks === 0, 'group: selected and unselected regions stay stitched without T-junction cracks');
  const emptyGroup = await cook({ ...gridNodes, out: { ...gridNodes.out, params: { group: '@P.x>10' } } }, 'out');
  assert.deepEqual(fingerprint(emptyGroup), fingerprint(grid)); checks++;

  const crease = await cook({ grid: gridNodes.grid, crease: { type: 'group', in: ['grid'], params: { name: 'crease', class: 'edge', expr: 'Math.abs(@P.x) < 1e-6' } }, out: { type: 'remesh_quad', in: ['crease'], params: { target_length: 0.14, crease_group: 'crease' } } }, 'out');
  const creaseEdges = crease.edgeGroups.get('crease');
  let creaseLength = 0;
  if (creaseEdges) for (const [a, b] of creaseEdges) {
    assert.ok(Math.abs(crease.P[a * 3]) < 1e-8 && Math.abs(crease.P[b * 3]) < 1e-8, 'hard crease remains on its source line');
    creaseLength += Math.hypot(...[0, 1, 2].map(k => crease.P[a * 3 + k] - crease.P[b * 3 + k]));
  }
  check(Math.abs(creaseLength - 2) < 1e-6, 'crease group retains the complete hard alignment line');

  // An untouched distant component must not inflate geometric tolerances in the selected part.
  const distant = await cook({
    near: { type: 'grid', params: { size: [2, 2], divisions: [4, 4] } },
    crease: { type: 'group', in: ['near'], params: { name: 'crease', class: 'edge', expr: 'Math.abs(@P.x) < 1e-6' } },
    far: { type: 'grid', params: { size: [2, 2], divisions: [4, 4], center: [1e9, 0, 0] } },
    merged: { type: 'merge', in: ['crease', 'far'] },
    out: { type: 'remesh_quad', in: ['merged'], params: { group: '@P.x<2', target_length: 0.25, crease_group: 'crease' } },
  }, 'out');
  let distantCreaseLength = 0;
  for (const [a, b] of distant.edgeGroups.get('crease') ?? []) {
    assert.ok(Math.abs(distant.P[a * 3]) < 1e-8 && Math.abs(distant.P[b * 3]) < 1e-8, 'distant complement must not broaden the selected crease group');
    distantCreaseLength += Math.hypot(...[0, 1, 2].map(k => distant.P[a * 3 + k] - distant.P[b * 3 + k]));
  }
  check(Math.abs(distantCreaseLength - 2) < 1e-6, 'group tolerance depends on selected geometry despite a component at x=1e9');

  const onlyQuads = await cook({ tube: { type: 'tube', params: { cols: 15, rows: 3, caps: true } }, out: { type: 'remesh_quad', in: ['tube'], params: { target_length: 0.2, mode: 'quads_only' } } }, 'out');
  check(watertight(onlyQuads) && Array.from({ length: onlyQuads.numPrims }, (_, p) => onlyQuads.primSize(p)).every(n => n === 4), 'quads_only: odd capped tube is watertight with four-sided faces');
  check(!meshValence(onlyQuads.P, onlyQuads.primStart, onlyQuads.vertexPoint).includes(2), 'cleanup: odd capped tube has no valence-2 vertices');
  for (let p = 0; p < onlyQuads.numPrims; p++) assert.ok(primArea(onlyQuads, p) > 1e-12);
  checks++;
  for (let seed = 1; seed <= 6; seed++) {
    const noisy = await cook({ grid: { type: 'grid', params: { divisions: [12, 11] } }, noise: { type: 'noise_displace', in: ['grid'], params: { amplitude: 0.04, frequency: 4, seed } }, out: { type: 'remesh_quad', in: ['noise'], params: { target_faces: 90, smooth_iterations: 5 } } }, 'out');
    const t = topologyReport(noisy);
    let minArea = Infinity;
    for (let p = 0; p < noisy.numPrims; p++) minArea = Math.min(minArea, primArea(noisy, p));
    check(noisy.numPrims > 0 && noisy.P.every(Number.isFinite) && minArea > 1e-12 && t.degenerate === 0 && halfEdges(noisy).isManifold, `seeded noisy grid ${seed}: finite manifold output without degenerate faces`);
  }
  const capped = await off.cook({ nodes: { box: { type: 'box' }, out: { type: 'remesh_quad', in: ['box'], params: { target_faces: 10000, max_faces: 10 } } }, output: 'out' });
  check(!capped.ok && capped.errors.some(e => /max_faces|limit|guard|budget/i.test(e.message)), 'max_faces rejects excessive requested output with a clear error');
  const complementGuard = await off.cook({ nodes: { ...gridNodes, out: { ...gridNodes.out, params: { group: '@P.x>0', max_faces: 10 } } }, output: 'out' });
  check(!complementGuard.ok && complementGuard.errors.some(e => /max_faces|limit|guard|budget/i.test(e.message)), 'max_faces includes unchanged polygons outside the selected group');
  const nonManifold = await off.cook({ nodes: { a: { type: 'box' }, b: { type: 'box', params: { center: [1, 1, 0] } }, merge: { type: 'merge', in: ['a', 'b'] }, fuse: { type: 'fuse', in: ['merge'] }, out: { type: 'remesh_quad', in: ['fuse'] } }, output: 'out' });
  check(!nonManifold.ok && nonManifold.errors.some(e => /manifold/i.test(e.message)), 'non-manifold input rejected clearly');
  const inputPositions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), inputTris = new Uint32Array([0, 1, 2]);
  for (const [positions, tris, options] of [
    [new Float64Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]), inputTris, {}],
    [inputPositions, new Uint32Array([0, 1, 9]), {}],
    [inputPositions, new Uint32Array([0, 1]), {}],
    [inputPositions, inputTris, { target_length: NaN }],
    [inputPositions, inputTris, { target_length: -1 }],
  ] as [Float64Array, Uint32Array, { target_length?: number }][]) { assert.throws(() => kernels.remesh_quad(positions, tris, options)); checks++; }
  const recovered = kernels.remesh_quad(inputPositions, inputTris, { target_length: 0.2 });
  check(recovered.positions.length > 0, 'WASM remains usable after malformed inputs');
  const savedPositions = inputPositions.slice(), savedTris = inputTris.slice();
  const attributed = kernels.remesh_quad(inputPositions, inputTris, { target_length: 0.25 });
  assert.deepEqual(inputPositions, savedPositions); assert.deepEqual(inputTris, savedTris); checks++;
  for (let i = 0; i < attributed.positions.length / 3; i++) {
    const t = attributed.source_triangle[i], w = attributed.barycentric.subarray(i * 3, i * 3 + 3);
    assert.ok(t < inputTris.length / 3 && Math.abs(w[0] + w[1] + w[2] - 1) < 1e-9 && w.every(n => n >= -1e-9 && n <= 1 + 1e-9));
    for (let k = 0; k < 3; k++) {
      const reconstructed = w.reduce((sum, weight, j) => sum + weight * inputPositions[inputTris[t * 3 + j] * 3 + k], 0);
      assert.ok(Math.abs(reconstructed - attributed.positions[i * 3 + k]) < 1e-9, 'kernel source triangle + barycentrics reconstruct each output point');
    }
  }
  checks++;
  // The raw wasm-bindgen object parser must reject malformed JS, not silently coerce counts or flags.
  const raw = kernelsWasmVariant === 'simd'
    ? await import('../kernels/pkg-simd/topotopo_kernels.js')
    : await import('../kernels/pkg/topotopo_kernels.js');
  for (const options of [
    { target_faces: 1.5 }, { target_faces: NaN }, { target_faces: -1 }, { max_faces: 3.5 },
    { smooth_iterations: 1.5 }, { feature_angle: Infinity }, { quad_only: 'yes' }, { align_boundaries: 1 },
    { preserve_sharp: null }, { cleanup: 1 }, { crease_edges: [0, 1] }, { locked_edges: new Float64Array([0, 1]) },
    { direction_edges: [0, 1] }, { direction_edges: new Uint32Array([0]) }, { direction_edges: new Uint32Array([0, 9]) },
    { crease_edges: new Uint32Array([0]) }, { locked_edges: new Uint32Array([0, 9]) },
  ]) { assert.throws(() => raw.remesh_quad(inputPositions, inputTris, options)); checks++; }
  // Native test constructs exactly the same binary-fraction input. Its printed digest can be compared
  // directly with this WASM digest, including unquantized position/provenance bits and polygon ordering.
  const parityP: number[] = [], parityT: number[] = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) parityP.push((col - 2) / 2, ((col * 17 + row * 13) % 7 - 3) / 128, (2 - row) / 2);
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const a = row * 5 + col;
    if ((row + col) % 2 === 0) parityT.push(a, a + 1, a + 6, a, a + 6, a + 5);
    else parityT.push(a, a + 1, a + 5, a + 1, a + 6, a + 5);
  }
  const parity = kernels.remesh_quad(Float64Array.from(parityP), Uint32Array.from(parityT), { target_length: 0.5 });
  let digest = 0xcbf29ce484222325n;
  const word = new DataView(new ArrayBuffer(8));
  const hash = (values: ArrayLike<number>, bytes: 4 | 8) => {
    for (let i = 0; i < values.length; i++) {
      if (bytes === 8) word.setFloat64(0, values[i], true); else word.setUint32(0, values[i], true);
      for (let k = 0; k < bytes; k++) digest = BigInt.asUintN(64, (digest ^ BigInt(word.getUint8(k))) * 0x100000001b3n);
    }
  };
  hash(parity.positions, 8); hash(parity.prim_start, 4); hash(parity.vertex_point, 4);
  hash(parity.source_triangle, 4); hash(parity.barycentric, 8); hash(parity.src_prim, 4);
  console.log(`quad_parity_digest=${digest.toString(16).padStart(16, '0')}; ${parity.positions.length / 3} points, ${parity.prim_start.length - 1} faces`);
  const example = JSON.parse(fs.readFileSync(new URL('../examples/quad_remesh.json', import.meta.url), 'utf8')) as GraphSpec;
  // the example's rock is topotopo/nature/rock: it cooks as a graph of the examples' project, from its copy
  openPackages(off, fileURLToPath(new URL('../examples/', import.meta.url)));
  for (const output of ['sphere_quad', 'box_quad', 'rock_quad', 'tube_quad']) {
    const geo = await cook(example.nodes, output);
    check(watertight(geo), `showcase ${output}: closed manifold nondegenerate mesh`);
    const intersections = selfIntersections(geo);
    check(!intersections.capped && intersections.pairs === 0, `showcase ${output}: no proper triangle crossings`);
    check(!meshValence(geo.P, geo.primStart, geo.vertexPoint).includes(2), `showcase ${output}: cleanup leaves no valence-2 vertices`);
    if (output === 'tube_quad') {
      check(Array.from({ length: geo.numPrims }, (_, p) => geo.primSize(p)).every(n => n === 4), 'showcase tube: all output faces are quads');
      check(Math.abs(geo.numPrims - 350) <= 350 * 0.15, `showcase tube: quads_only count within target 350 +/-15% (${geo.numPrims})`);
      // The cap's UVs are affine in x/z, independent of triangulation and the new cap grid.
      // This catches losing cap/side wedges when resampling their shared crease ring.
      const uv = geo.vertices.get('uv')!.data as Float64Array;
      let capFaces = 0, maxCapUVError = 0;
      for (let p = 0; p < geo.numPrims; p++) {
        const points = geo.primPoints(p);
        const top = points.every(i => Math.abs(geo.P[i * 3 + 1] - 0.8) < 1e-8);
        const bottom = points.every(i => Math.abs(geo.P[i * 3 + 1] + 0.8) < 1e-8);
        if (!top && !bottom) continue;
        capFaces++;
        for (let v = geo.primStart[p]; v < geo.primStart[p + 1]; v++) {
          const i = geo.vertexPoint[v];
          maxCapUVError = Math.max(maxCapUVError, Math.abs(uv[v * 3] - (0.5 + geo.P[i * 3] / 1.3)),
            Math.abs(uv[v * 3 + 1] - (0.5 + (top ? -1 : 1) * geo.P[i * 3 + 2] / 1.3)));
        }
      }
      check(capFaces > 0 && maxCapUVError < 1e-6, `showcase tube: affine cap UVs survive cap/side seams (max error ${maxCapUVError})`);
      console.log(`quads_only tube: ${geo.numPrims} quads for target 350 (${((geo.numPrims / 350 - 1) * 100).toFixed(2)}%)`);
    }
  }

  // These are the session-3 acceptance inputs, rather than the much smaller ico sphere above.
  // 2 * 250 * (201 - 1) = exactly 100,000 input triangles with a real UV seam.
  const largeNodes: Record<string, NodeSpec> = {
    sphere: { type: 'sphere', params: { rows: 201, cols: 250 } },
    noise: { type: 'wrangle', in: ['sphere'], params: { code: 'const r = 1 + 0.025 * sin(@P.x * 7) * sin(@P.y * 5) * cos(@P.z * 6); @P = mul(@P, r);' } },
    out: { type: 'remesh_quad', in: ['noise'], params: { target_faces: 25000, smooth_iterations: 8 } },
  };
  const largeInput = await cook(largeNodes, 'noise');
  const largeTris = Uint32Array.from(triangulate(largeInput).tris, v => largeInput.vertexPoint[v]);
  assert.equal(largeTris.length / 3, 100000, 'large regression fixture has exactly 100k triangles'); checks++;
  const largeOptions = { target_faces: 25000, smooth_iterations: 8 };
  const largeRaw = kernels.remesh_quad(largeInput.P, largeTris, largeOptions);
  const rawValence = meshValence(largeRaw.positions, largeRaw.prim_start, largeRaw.vertex_point);
  const rawIrregular = rawValence.filter(n => n !== 4).length / rawValence.length;
  check(rawIrregular < 0.02, `large raw sphere: irregular fraction <2% (${(rawIrregular * 100).toFixed(4)}%)`);
  check(largeRaw.quality.irregular_fraction === rawIrregular, 'large raw sphere: reported irregular fraction matches topology');
  check(!rawValence.includes(2), 'large raw sphere: cleanup leaves no valence-2 vertices');
  equalKernel(largeRaw, kernels.remesh_quad(largeInput.P, largeTris, largeOptions), 'large raw sphere deterministic');

  const largeUV = await cook(largeNodes, 'out');
  const uvValence = meshValence(largeUV.P, largeUV.primStart, largeUV.vertexPoint);
  const uvIrregular = uvValence.filter(n => n !== 4).length / uvValence.length;
  check(watertight(largeUV), 'large UV-constrained sphere remains watertight and manifold');
  check(uvIrregular < 0.04, `large UV-constrained sphere: irregular fraction <4% (${(uvIrregular * 100).toFixed(4)}%)`);
  check(Number(largeUV.detail.get('irregular_fraction')?.get(0)) === uvIrregular, 'large UV-constrained sphere: reported irregular fraction matches topology');
  check(!uvValence.includes(2), 'large UV-constrained sphere: cleanup leaves no valence-2 vertices');
  console.log(`large sphere regularity: raw ${(rawIrregular * 100).toFixed(4)}%, UV-constrained ${(uvIrregular * 100).toFixed(4)}%`);

  const scalar = await import('../kernels/pkg/topotopo_kernels.js');
  const simd = await import('../kernels/pkg-simd/topotopo_kernels.js');
  const scalarBytes = fs.readFileSync(new URL('../kernels/pkg/topotopo_kernels_bg.wasm', import.meta.url));
  const simdBytes = fs.readFileSync(new URL('../kernels/pkg-simd/topotopo_kernels_bg.wasm', import.meta.url));
  assert.notDeepEqual(scalarBytes, simdBytes, 'quad parity exercises distinct shipped builds'); checks++;
  await scalar.default({ module_or_path: scalarBytes });
  await simd.default({ module_or_path: simdBytes });
  const other = kernelsWasmVariant === 'simd' ? scalar : simd;
  equalKernel(largeRaw, other.remesh_quad(largeInput.P, largeTris, largeOptions) as QuadRemeshResult, 'large sphere scalar/SIMD byte-exact parity');
  for (const cleanup of [false, true]) for (const quad_only of [false, true]) {
    const options = { target_length: 0.5, cleanup, quad_only, direction_edges: Uint32Array.of(0, 5, 5, 10) };
    equalKernel(scalar.remesh_quad(Float64Array.from(parityP), Uint32Array.from(parityT), options) as QuadRemeshResult,
      simd.remesh_quad(Float64Array.from(parityP), Uint32Array.from(parityT), options) as QuadRemeshResult,
      `direction constraints scalar/SIMD byte-exact parity, cleanup=${cleanup}, quad_only=${quad_only}`);
  }
} finally {
  await off.host.pool?.close(); await on.host.pool?.close();
}
assert.equal(failures.length, 0, failures.join('\n'));
console.log(`remeshquad: ${checks} integration checks passed`);
