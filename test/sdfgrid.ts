// Sampled SDF node integration and actual WASM ABI. Core/JSON checks run in the imported suite.
import './sdfgrid-core.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import { Geometry } from '../src/core/geometry.ts';
import { SdfGrid, gridsOf, gridFromImplicit } from '../src/core/sdfgrid.ts';
import { geoToJSON, geoFromJSON } from '../src/io/json.ts';
import { topologyReport, primArea, triangulate, signedVolume } from '../src/core/topology.ts';
import { selfIntersections } from '../src/core/analysis.ts';
import { TriBVH } from '../src/core/spatial.ts';
import { rng } from '../src/core/random.ts';
import { kernelsWasmURL, kernelsWasmVariant, loadKernels } from '../src/wasm/kernels.ts';
import type { DualContourResult } from '../src/wasm/kernels.ts';
import { fingerprint } from './fingerprint.ts';

const off = new Engine(createNodeHost({ workers: 0 })), on = new Engine(createNodeHost({ workers: 2, pool: { minElements: 1 } }));
await off.init(); await on.init();
const k = await loadKernels(fs.readFileSync(kernelsWasmURL));
let checks = 0;
function check(condition: unknown, label: string): void { assert.ok(condition, label); checks++; }
function contourGeometry(mesh: DualContourResult): Geometry {
  const g = new Geometry({ positions: mesh.positions });
  g.primStart = Int32Array.from(mesh.prim_start);
  g.vertexPoint = Int32Array.from(mesh.vertex_point);
  g.primClosed = new Uint8Array(mesh.prim_start.length - 1).fill(1);
  return g;
}
function maximumResidual(mesh: Geometry, sample: (x: number, y: number, z: number) => number, voxel: number) {
  let error = 0, index = 0;
  for (let i = 0; i < mesh.numPoints; i++) {
    const distance = Math.abs(sample(mesh.P[i * 3], mesh.P[i * 3 + 1], mesh.P[i * 3 + 2])) / voxel;
    if (distance > error) { error = distance; index = i; }
  }
  return { error, index, position: Array.from(mesh.P.slice(index * 3, index * 3 + 3)) };
}
// Edge incidence alone misses two closed sheets pinched at one vertex. Every
// vertex link must also be a single cycle, with opposite winding across edges.
function checkManifold(mesh: Geometry, label: string): void {
  const topo = topologyReport(mesh), edges = new Map<string, [number, number]>();
  const links = Array.from({ length: mesh.numPoints }, () => new Map<number, number[]>());
  for (let p = 0; p < mesh.numPrims; p++) {
    const first = mesh.primStart[p], count = mesh.primSize(p);
    for (let j = 0; j < count; j++) {
      const a = mesh.vertexPoint[first + j], b = mesh.vertexPoint[first + (j + 1) % count];
      const prev = mesh.vertexPoint[first + (j + count - 1) % count];
      const key = `${Math.min(a, b)},${Math.max(a, b)}`, edge = edges.get(key) ?? [0, 0];
      edge[0]++; edge[1] += a < b ? 1 : -1; edges.set(key, edge);
      const link = links[a];
      link.set(prev, [...(link.get(prev) ?? []), b]); link.set(b, [...(link.get(b) ?? []), prev]);
    }
  }
  check(topo.closed && topo.boundaryEdges === 0 && topo.nonManifoldEdges === 0 && topo.degenerate === 0,
    `${label}: watertight, nondegenerate manifold edges`);
  check([...edges.values()].every(([count, direction]) => count === 2 && direction === 0), `${label}: consistent edge winding`);
  for (const link of links) {
    if (!link.size) continue;
    assert.ok([...link.values()].every(neighbors => neighbors.length === 2), `${label}: vertex link has degree two`);
    const pending = [link.keys().next().value!], visited = new Set<number>();
    while (pending.length) {
      const v = pending.pop()!;
      if (visited.has(v)) continue;
      visited.add(v); pending.push(...link.get(v)!);
    }
    assert.equal(visited.size, link.size, `${label}: vertex link is one cycle`);
  }
  checks++;
  check(signedVolume(mesh) > 0, `${label}: outward-facing closed surface`);
}
async function cook(nodes: Record<string, NodeSpec>, output: string, engine = off): Promise<Geometry> {
  const r = await engine.cook({ nodes, output } as GraphSpec);
  assert.ok(r.ok && r.geo, r.errors.map(e => `${e.node}: ${e.message}`).join('; '));
  return r.geo!;
}
const base: Record<string, NodeSpec> = {
  shape: { type: 'sdf_shape', params: { radius: 0.7 } },
  grid: { type: 'sdf_grid', in: ['shape'], params: { voxel_size: 0.08, padding: 5 } },
};
const gridGeo = await cook(base, 'grid'), grid = gridsOf(gridGeo)[0];
check(grid.sample(0, 0, 0) < -0.6 && grid.sample(0.9, 0, 0) > 0, 'implicit sphere samples signed distances');
const roundtrip = geoFromJSON(JSON.parse(JSON.stringify(geoToJSON(gridGeo))));
assert.deepEqual(fingerprint(roundtrip), fingerprint(gridGeo)); checks++;
const original = grid.values.slice();
for (const [type, params] of [
  ['grid_offset', { distance: 0.1 }], ['grid_dilate', { distance: 0.1 }], ['grid_erode', { distance: 0.1 }],
  ['grid_blur', { radius: 1 }], ['grid_resample', { voxel_size: 0.12 }], ['grid_to_sdf', {}],
] as [string, Record<string, any>][]) {
  const nodes = { ...base, out: { type, in: ['grid'], params } };
  const a = await cook(nodes, 'out'), b = await cook(nodes, 'out', on);
  assert.deepEqual(fingerprint(a), fingerprint(b), `${type} pool settings preserve fingerprint`); checks++;
  if (type === 'grid_to_sdf') {
    const v = a.volumes[0]; check(v.kind === 'sdf' && v.sample(0, 0, 0) === grid.sample(0, 0, 0), 'grid_to_sdf uses trilinear sampling');
  } else {
    const result = gridsOf(a)[0];
    assert.deepEqual(result.values, gridsOf(b)[0].values); checks++;
    if (type === 'grid_dilate' || type === 'grid_offset') check(result.sample(0, 0, 0) < grid.sample(0, 0, 0) - 0.09, `${type} grows`);
    if (type === 'grid_erode') check(result.sample(0, 0, 0) > grid.sample(0, 0, 0) + 0.09, 'erode shrinks');
    if (type === 'grid_resample') check(result.voxel === 0.12 && result.count < grid.count, 'resample changes layout');
  }
}
assert.deepEqual(grid.values, original); checks++;
for (const op of ['union', 'intersect', 'subtract', 'smooth_union', 'smooth_intersect', 'smooth_subtract']) {
  const g = await cook({ ...base,
    b: { type: 'sdf_shape', params: { radius: 0.45, center: [0.45, 0, 0] } },
    bg: { type: 'sdf_grid', in: ['b'], params: { voxel_size: 0.11 } },
    out: { type: 'grid_combine', in: ['grid', 'bg'], params: { operation: op, smooth: 0.12 } },
  }, 'out');
  const v = gridsOf(g)[0];
  assert.deepEqual(v.dims, grid.dims); checks++;
  check(v.values.every(n => !Number.isNaN(n)), `${op} differing-layout CSG has no NaNs`);
}
for (const method of ['dual_contouring', 'dual_contouring_conservative', 'marching_cubes']) {
  const nodes = { ...base, out: { type: 'grid_to_mesh', in: ['grid'], params: { method } } };
  const mesh = await cook(nodes, 'out'), pooled = await cook(nodes, 'out', on);
  assert.deepEqual(mesh.P, pooled.P); assert.deepEqual(mesh.vertexPoint, pooled.vertexPoint); checks++;
  const topo = topologyReport(mesh);
  check(topo.closed && topo.nonManifoldEdges === 0 && topo.degenerate === 0, `${method} sphere closed/manifold/nondegenerate`);
  checkManifold(mesh, `${method} sphere`);
  let area = 0; for (let p = 0; p < mesh.numPrims; p++) area += primArea(mesh, p);
  const areaError = Math.abs(area / (4 * Math.PI * 0.7 ** 2) - 1);
  if (method === 'dual_contouring') console.log(`sdfgrid quality: sphere area error ${(areaError * 100).toFixed(6)}%`);
  check(areaError < (method === 'dual_contouring' ? 0.01 : 0.02), `${method} sphere area within ${method === 'dual_contouring' ? 1 : 2}%`);
  const intersections = selfIntersections(mesh);
  check(!intersections.capped && intersections.pairs === 0, `${method} sphere has no proper triangle crossings`);
  check(!mesh.points.has('Cd') && !mesh.prims.has('material'), 'grid_to_mesh has no source attributes');
}
const torus = await cook({ shape: { type: 'sdf_shape', params: { shape: 'torus', radius: 0.8, radius2: 0.25 } },
  grid: { type: 'sdf_grid', in: ['shape'], params: { voxel_size: 0.08 } }, out: { type: 'grid_to_mesh', in: ['grid'] } }, 'out');
check(topologyReport(torus).closed && topologyReport(torus).euler === 0, 'torus genus one');
checkManifold(torus, 'torus');
check(selfIntersections(torus).pairs === 0, 'torus has no proper crossings');
const torusResidual = maximumResidual(torus, (x, y, z) => Math.hypot(Math.hypot(x, z) - 0.8, y) - 0.25, 0.08);
console.log(`sdfgrid quality: torus maximum analytic SDF residual ${torusResidual.error.toFixed(9)} voxels; 0.1-voxel target ${torusResidual.error <= 0.1 ? 'PASS' : 'MISS'}; sample ${JSON.stringify(torusResidual)}`);
// Deliberately shift every box plane away from grid samples. Each of the twelve
// edge-cell strips must fit a straight line, and all eight corners must survive.
const boxCenter = [0.023, -0.037, 0.019], boxHalf = [0.63, 0.55, 0.47], boxVoxel = 0.08;
const boxDistance = (x: number, y: number, z: number): number => {
  const q = [x, y, z].map((v, axis) => Math.abs(v - boxCenter[axis]) - boxHalf[axis]);
  return Math.hypot(...q.map(v => Math.max(v, 0))) + Math.min(Math.max(...q), 0);
};
const featureGrid = gridFromImplicit(boxDistance, {
  min: boxCenter.map((v, axis) => v - boxHalf[axis]) as [number, number, number],
  max: boxCenter.map((v, axis) => v + boxHalf[axis]) as [number, number, number],
}, boxVoxel, 4.37 * boxVoxel);
const featureResult = k.dual_contour(featureGrid), featureMesh = contourGeometry(featureResult);
checkManifold(featureMesh, 'shifted box');
check(topologyReport(featureMesh).quads > 0, 'default dual contouring retains planar quads');
check(new Set(featureResult.cell_index).size === featureMesh.numPoints, 'ordinary box has one dual vertex per active cell');
check(featureResult.fallback_cells === 0, 'ordinary box needs no conservative fallback');
let edgeError = 0, straightness = 0, cornerError = 0;
for (let axis = 0; axis < 3; axis++) for (const signA of [-1, 1]) for (const signB of [-1, 1]) {
  const a = (axis + 1) % 3, b = (axis + 2) % 3;
  const planeA = boxCenter[a] + signA * boxHalf[a], planeB = boxCenter[b] + signB * boxHalf[b];
  const points: [number, number][] = [];
  for (let i = 0; i < featureMesh.numPoints; i++) {
    const cell = featureResult.cell_index[i], dims = featureGrid.dims;
    const coord = [cell % dims[0], Math.floor(cell / dims[0]) % dims[1], Math.floor(cell / (dims[0] * dims[1]))];
    const lo = coord.map((v, j) => featureGrid.origin[j] + v * boxVoxel);
    const along = featureMesh.P[i * 3 + axis] - boxCenter[axis];
    if (planeA < lo[a] || planeA > lo[a] + boxVoxel || planeB < lo[b] || planeB > lo[b] + boxVoxel || Math.abs(along) > boxHalf[axis] - boxVoxel) continue;
    const pa = featureMesh.P[i * 3 + a], pb = featureMesh.P[i * 3 + b];
    points.push([pa, pb]); edgeError = Math.max(edgeError, Math.hypot(pa - planeA, pb - planeB) / boxVoxel);
  }
  check(points.length >= 5, `box edge ${axis}/${signA}/${signB}: covered by at least five dual vertices`);
  const meanA = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const meanB = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  for (const p of points) straightness = Math.max(straightness, Math.hypot(p[0] - meanA, p[1] - meanB) / boxVoxel);
}
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
  const corner = [x, y, z].map((sign, axis) => boxCenter[axis] + sign * boxHalf[axis]);
  let nearest = Infinity;
  for (let i = 0; i < featureMesh.numPoints; i++) nearest = Math.min(nearest,
    Math.hypot(...corner.map((v, axis) => featureMesh.P[i * 3 + axis] - v)) / boxVoxel);
  cornerError = Math.max(cornerError, nearest);
}
console.log(`sdfgrid quality: box edge error ${edgeError.toFixed(9)}, straightness ${straightness.toFixed(9)}, corner error ${cornerError.toFixed(9)} voxels`);
check(edgeError <= 0.1, `box edges preserve their position within 0.1 voxel (actual ${edgeError})`);
check(straightness <= 0.05, `box edges straight within 0.05 voxel (actual ${straightness})`);
check(cornerError <= 0.1, `box corners preserved within 0.1 voxel (actual ${cornerError})`);
// An unsafe adaptive merge must retain uniform topology. Bidirectional samples
// include vertices and face centres, so shrinking curved faces cannot pass solely
// because their surviving vertices still lie on the original surface.
for (const source of [featureGrid, grid]) for (const tolerance of [0.05, 0.25]) {
  const uniform = contourGeometry(k.dual_contour(source));
  const result = k.dual_contour(source, 0, 1e-6, true, true, false, tolerance);
  const adaptive = contourGeometry(result);
  checkManifold(adaptive, `adaptive ${source === grid ? 'sphere' : 'box'} ${tolerance}`);
  check(adaptive.numPrims <= uniform.numPrims, 'adaptive extraction does not add faces');
  check(Number.isInteger(result.adaptive_collapses) && result.adaptive_collapses >= 0, 'adaptive simplification count is reported');
  let deviation = 0;
  for (const [from, to] of [[uniform, adaptive], [adaptive, uniform]]) {
    const bvh = new TriBVH(to);
    for (let i = 0; i < from.numPoints; i++) deviation = Math.max(deviation, bvh.closest(from.P[i * 3], from.P[i * 3 + 1], from.P[i * 3 + 2])!.dist);
    for (let p = 0; p < from.numPrims; p++) {
      const center = [0, 0, 0];
      for (let v = from.primStart[p]; v < from.primStart[p + 1]; v++) for (let axis = 0; axis < 3; axis++) center[axis] += from.P[from.vertexPoint[v] * 3 + axis] / from.primSize(p);
      deviation = Math.max(deviation, bvh.closest(center[0], center[1], center[2])!.dist);
    }
  }
  check(deviation <= tolerance * source.voxel + 1e-8, `adaptive surface deviation ${deviation} respects ${tolerance} voxel tolerance`);
}
const remeshNodes: Record<string, NodeSpec> = {
  box: { type: 'box' }, color: { type: 'color', in: ['box'], params: { color: [0.2, 0.6, 0.8] } },
  mat: { type: 'material', in: ['color'], params: { name: 'test_grid_material' } },
  out: { type: 'voxel_remesh', in: ['mat'], params: { voxel_size: 0.1, offset: 0.025, smooth_iterations: 0, transfer_attributes: true } },
};
const remesh = await cook(remeshNodes, 'out');
check(topologyReport(remesh).closed, 'mesh voxel_remesh closed');
const color = remesh.points.get('Cd')!;
check(!!color && Math.abs((color.get(0) as number[])[1] - 0.6) < 1e-12, 'nearest-triangle Cd transfer');
check(remesh.prims.get('material')?.get(0) === 'test_grid_material' && !!remesh.detail.get('materials'), 'material assignment and table transfer');
const remeshOff = await cook({ ...remeshNodes, out: { ...remeshNodes.out, params: { voxel_size: 0.1 } } }, 'out');
check(!remeshOff.points.has('Cd') && !remeshOff.prims.has('material'), 'attribute transfer disabled drops source attributes');
for (const method of ['dual_contouring', 'dual_contouring_conservative', 'marching_cubes']) {
  const mesh = await cook({ ...remeshNodes, out: { ...remeshNodes.out,
    params: { voxel_size: 0.1, method, adaptive: 0.1, sharp_threshold: 0.4, transfer_attributes: true } } }, 'out');
  checkManifold(mesh, `voxel_remesh ${method}`);
  check(mesh.prims.get('material')?.get(0) === 'test_grid_material' && mesh.points.has('Cd'), `${method} remesh keeps requested attribute transfer`);
  if (method !== 'marching_cubes') check(Number.isInteger(mesh.detail.get('fallback_cells')?.get(0)), `${method} reports conservative fallback count`);
}
const twoMaterials = await cook({
  a: { type: 'box', params: { center: [-1, 0, 0] } }, b: { type: 'box', params: { center: [1, 0, 0] } },
  ca: { type: 'color', in: ['a'], params: { color: [1, 0, 0] } }, cb: { type: 'color', in: ['b'], params: { color: [0, 0, 1] } },
  ma: { type: 'material', in: ['ca'], params: { name: 'left_red' } }, mb: { type: 'material', in: ['cb'], params: { name: 'right_blue' } },
  merged: { type: 'merge', in: ['ma', 'mb'] },
  out: { type: 'voxel_remesh', in: ['merged'], params: { voxel_size: 0.15, transfer_attributes: true } },
}, 'out');
const twoCd = twoMaterials.points.get('Cd')!.data as Float64Array;
for (let i = 0; i < twoMaterials.numPoints; i++) assert.ok(Math.abs(twoCd[i * 3 + (twoMaterials.P[i * 3] < 0 ? 0 : 2)] - 1) < 1e-12);
for (let p = 0; p < twoMaterials.numPrims; p++) {
  const x = twoMaterials.P[twoMaterials.vertexPoint[twoMaterials.primStart[p]] * 3];
  assert.equal(twoMaterials.prims.get('material')!.get(p), x < 0 ? 'left_red' : 'right_blue');
}
check(topologyReport(twoMaterials).pieces === 2, 'nearest-triangle transfer distinguishes separate source colors/materials');
const box = await cook({ box: { type: 'box' } }, 'box'), triangles = Uint32Array.from(triangulate(box).tris, v => box.vertexPoint[v]);
const band = k.sdf_from_mesh(box.P, triangles, 0.1, 2, 5, false);
check(band.values.some(v => v === Infinity) && band.values.some(v => v === -Infinity), 'narrow band preserves signed infinities');
const bg = new SdfGrid(Array.from(band.dims) as [number, number, number], Array.from(band.origin) as [number, number, number], band.voxel, band.values);
const ng = new Geometry(); ng.volumes = [bg];
assert.deepEqual(gridsOf(geoFromJSON(JSON.parse(JSON.stringify(geoToJSON(ng)))))[0].values, band.values); checks++;
check(k.dual_contour(band).positions.length > 0, 'narrow-band dual contouring');
const plane = gridFromImplicit((x, y, z) => x + 2 * y + 3 * z, { min: [0, 0, 0], max: [1, 1, 1] }, 0.25);
const fine = k.grid_resample(plane, 0.125);
check(Math.abs(fine.values[1] - plane.sample(0.125, 0, 0)) < 1e-7, 'Rust/TS trilinear resampling agrees');
assert.throws(() => k.grid_blur(grid, -1), /radius/);
assert.throws(() => k.grid_offset(grid, NaN), /finite/);
assert.throws(() => k.sdf_from_mesh(new Float64Array([NaN, 0, 0]), new Uint32Array([0, 0, 0]), 1, 2, 3, false)); checks += 3;
const adaptiveNode = await cook({ ...base, out: { type: 'grid_to_mesh', in: ['grid'], params: { adaptive: 0.1, sharp_threshold: 0.4 } } }, 'out');
checkManifold(adaptiveNode, 'adaptive node surface');
check(Number.isInteger(adaptiveNode.detail.get('fallback_cells')?.get(0)) && Number.isInteger(adaptiveNode.detail.get('adaptive_collapses')?.get(0)), 'node exposes contour fallback and simplification counts');
// A deterministic union corpus also checks actual WASM output for geometric crossings.
let unionResidual = 0;
let worstUnion: object | undefined;
let fallbackCase: { nodes: Record<string, NodeSpec>; mesh: Geometry; count: number } | undefined;
for (let seed = 1; seed <= 16; seed++) {
  const random = rng(seed);
  const nodes: Record<string, NodeSpec> = { ...base,
    b: { type: 'sdf_shape', params: { shape: seed % 2 ? 'box' : 'sphere', radius: seed <= 8 ? 0.5 : 0.35 + random() * 0.25, size: [0.8, 0.6, 0.7],
      center: seed <= 8 ? [0.1 + seed * 0.045, 0.08, -0.1] : [0.2 + random() * 0.35, random() * 0.25 - 0.125, random() * 0.25 - 0.125] } },
    u: { type: 'sdf_combine', in: ['shape', 'b'], params: { operation: 'union' } },
    g: { type: 'sdf_grid', in: ['u'], params: { voxel_size: 0.09 } }, out: { type: 'grid_to_mesh', in: ['g'] },
  };
  const geo = await cook(nodes, 'out');
  const t = topologyReport(geo), x = selfIntersections(geo);
  check(t.closed && t.nonManifoldEdges === 0 && !x.capped && x.pairs === 0, `union ${seed}: closed manifold without proper crossings`);
  checkManifold(geo, `seeded union ${seed}`);
  const implicit = (await cook(nodes, 'u')).volumes[0];
  assert.equal(implicit.kind, 'sdf');
  if (implicit.kind === 'sdf') {
    const residual = maximumResidual(geo, implicit.sample, 0.09);
    if (residual.error > unionResidual) {
      unionResidual = residual.error;
      const source = gridsOf(await cook(nodes, 'g'))[0], cellIndices = geo.points.get('grid_cell')!.data as Int32Array;
      const cell = cellIndices[residual.index], coord = [cell % source.dims[0], Math.floor(cell / source.dims[0]) % source.dims[1], Math.floor(cell / (source.dims[0] * source.dims[1]))];
      const cellMin = coord.map((v, axis) => source.origin[axis] + v * source.voxel);
      const samples = Array.from({ length: 8 }, (_, i) => source.values[cell + (i & 1) + ((i >> 1) & 1) * source.dims[0] + ((i >> 2) & 1) * source.dims[0] * source.dims[1]]);
      worstUnion = { seed, ...residual, cell, cellMin, samples, firstVertexForCell: cellIndices.indexOf(cell) === residual.index, shapeB: nodes.b.params };
    }
  }
  const count = Number(geo.detail.get('fallback_cells')?.get(0));
  check(Number.isInteger(count) && count >= 0, `union ${seed}: automatic fallback count reported`);
  if (count > 0 && !fallbackCase) fallbackCase = { nodes, mesh: geo, count };
}
console.log(`sdfgrid quality: union corpus maximum analytic SDF residual ${unionResidual.toFixed(9)} voxels; 0.1-voxel target ${unionResidual <= 0.1 ? 'PASS' : 'MISS'}`);
console.log(`sdfgrid quality: worst union sample ${JSON.stringify(worstUnion)}`);
check(!!fallbackCase, 'union corpus exercises automatic conservative fallback');
if (fallbackCase) {
  const merged = await cook({ ...fallbackCase.nodes,
    pair: { type: 'merge', in: ['g', 'g'] }, out: { type: 'grid_to_mesh', in: ['pair'] },
  }, 'out');
  check(merged.numPrims === fallbackCase.mesh.numPrims * 2, 'multiple grids are both extracted');
  check(merged.detail.get('fallback_cells')?.get(0) === fallbackCase.count * 2, 'multiple-grid fallback counts sum instead of keeping the first grid');
  check(merged.detail.get('adaptive_collapses')?.get(0) === Number(fallbackCase.mesh.detail.get('adaptive_collapses')?.get(0)) * 2, 'multiple-grid adaptive counts sum');
}
const showcase = JSON.parse(fs.readFileSync(new URL('../examples/voxel_remesh.json', import.meta.url), 'utf8')) as GraphSpec;
for (const output of ['dc', 'mc', 'variant']) {
  const geo = await cook(showcase.nodes, output), t = topologyReport(geo), x = selfIntersections(geo);
  check(t.closed && t.nonManifoldEdges === 0 && !x.capped && x.pairs === 0, `showcase ${output}: closed manifold without proper crossings`);
}
// Attribute-dropping is tested with actual upstream attribute tables, not only a bare volume.
const decorated: Record<string, NodeSpec> = {
  ...base,
  color: { type: 'color', in: ['grid'], params: { color: [0.2, 0.3, 0.4] } },
  material: { type: 'material', in: ['color'], params: { name: 'must_not_transfer' } },
  tag: { type: 'attrib_create', in: ['material'], params: { name: 'source_tag', class: 'detail', value: 'source-only' } },
};
const tagged = await cook(decorated, 'tag');
check(tagged.points.has('Cd') && tagged.prims.has('material') && tagged.detail.has('source_tag'), 'decorated grid carries source attribute tables');
for (const method of ['dual_contouring', 'dual_contouring_conservative', 'marching_cubes']) {
  const mesh = await cook({ ...decorated, out: { type: 'grid_to_mesh', in: ['tag'], params: { method } } }, 'out');
  check(!mesh.points.has('Cd') && !mesh.prims.has('material') && !mesh.detail.has('source_tag') && !mesh.detail.has('materials'), `${method} deliberately drops all source attribute tables`);
}
// Exercise the raw generated exports as well as the TS convenience wrapper.
const raw = kernelsWasmVariant === 'simd'
  ? await import('../kernels/pkg-simd/topotopo_kernels.js')
  : await import('../kernels/pkg/topotopo_kernels.js');
const rawGrid = { dims: new Uint32Array([2, 2, 2]), origin: new Float64Array(3), voxel: 1, values: new Float32Array(8) };
for (const invalid of [
  { ...rawGrid, dims: [2, 2, 2] }, { ...rawGrid, origin: [0, 0, 0] }, { ...rawGrid, values: new Float64Array(8) },
  { ...rawGrid, dims: new Uint32Array([1, 2, 2]) }, { ...rawGrid, dims: new Uint32Array([0xffffffff, 2, 2]) },
  { ...rawGrid, origin: new Float64Array([0, 0]) }, { ...rawGrid, origin: new Float64Array([NaN, 0, 0]) },
  { ...rawGrid, voxel: NaN }, { ...rawGrid, voxel: Infinity }, { ...rawGrid, voxel: 0 }, { ...rawGrid, voxel: 1e40 },
  { ...rawGrid, values: new Float32Array(7) }, { ...rawGrid, values: new Float32Array(8).fill(NaN) },
]) { assert.throws(() => raw.grid_offset(invalid, 0)); checks++; }
for (const radius of [-1, 0.5, NaN, Infinity, 1025]) { assert.throws(() => raw.grid_blur(rawGrid, radius)); checks++; }
for (const conservative of [false, true]) {
  for (const adaptive of [-1, NaN, Infinity]) {
    assert.throws(() => raw.dual_contour(rawGrid, 0, 1e-6, true, true, conservative, adaptive, 0.5), /adaptive/); checks++;
  }
  for (const sharpThreshold of [-1, 1.01, NaN, Infinity]) {
    assert.throws(() => raw.dual_contour(rawGrid, 0, 1e-6, true, true, conservative, 0, sharpThreshold), /sharp/); checks++;
  }
}
check((raw.grid_offset(rawGrid, 0) as { values: Float32Array }).values.length === 8, 'raw module remains usable after malformed inputs');
await off.host.pool?.close(); await on.host.pool?.close();
console.log(`sdfgrid: ${checks} integration checks passed`);
