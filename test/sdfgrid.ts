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
import { topologyReport, primArea, triangulate } from '../src/core/topology.ts';
import { selfIntersections } from '../src/core/analysis.ts';
import { kernelsWasmURL, loadKernels } from '../src/wasm/kernels.ts';
import { fingerprint } from './fingerprint.ts';

const off = new Engine(createNodeHost({ workers: 0 })), on = new Engine(createNodeHost({ workers: 2, pool: { minElements: 1 } }));
await off.init(); await on.init();
const k = await loadKernels(fs.readFileSync(kernelsWasmURL));
let checks = 0;
function check(condition: unknown, label: string): void { assert.ok(condition, label); checks++; }
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
for (const method of ['dual_contouring', 'marching_cubes']) {
  const nodes = { ...base, out: { type: 'grid_to_mesh', in: ['grid'], params: { method } } };
  const mesh = await cook(nodes, 'out'), pooled = await cook(nodes, 'out', on);
  assert.deepEqual(mesh.P, pooled.P); assert.deepEqual(mesh.vertexPoint, pooled.vertexPoint); checks++;
  const topo = topologyReport(mesh);
  check(topo.closed && topo.nonManifoldEdges === 0 && topo.degenerate === 0, `${method} sphere closed/manifold/nondegenerate`);
  let area = 0; for (let p = 0; p < mesh.numPrims; p++) area += primArea(mesh, p);
  check(Math.abs(area / (4 * Math.PI * 0.7 ** 2) - 1) < 0.02, `${method} sphere area within 2%`);
  const intersections = selfIntersections(mesh);
  check(!intersections.capped && intersections.pairs === 0, `${method} sphere has no proper triangle crossings`);
  check(!mesh.points.has('Cd') && !mesh.prims.has('material'), 'grid_to_mesh has no source attributes');
}
const torus = await cook({ shape: { type: 'sdf_shape', params: { shape: 'torus', radius: 0.8, radius2: 0.25 } },
  grid: { type: 'sdf_grid', in: ['shape'], params: { voxel_size: 0.08 } }, out: { type: 'grid_to_mesh', in: ['grid'] } }, 'out');
check(topologyReport(torus).closed && topologyReport(torus).euler === 0, 'torus genus one');
check(selfIntersections(torus).pairs === 0, 'torus has no proper crossings');
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
const rejected = await off.cook({ nodes: { ...base, out: { type: 'grid_to_mesh', in: ['grid'], params: { adaptive: true } } }, output: 'out' });
check(!rejected.ok && rejected.errors.some(e => /adaptive/.test(e.message)), 'adaptive mode explicitly unsupported');
// A deterministic union corpus also checks actual WASM output for geometric crossings.
for (let seed = 1; seed <= 8; seed++) {
  const geo = await cook({ ...base,
    b: { type: 'sdf_shape', params: { shape: seed % 2 ? 'box' : 'sphere', radius: 0.5, size: [0.8, 0.6, 0.7], center: [0.1 + seed * 0.045, 0.08, -0.1] } },
    u: { type: 'sdf_combine', in: ['shape', 'b'], params: { operation: 'union' } },
    g: { type: 'sdf_grid', in: ['u'], params: { voxel_size: 0.09 } }, out: { type: 'grid_to_mesh', in: ['g'] },
  }, 'out');
  const t = topologyReport(geo), x = selfIntersections(geo);
  check(t.closed && t.nonManifoldEdges === 0 && !x.capped && x.pairs === 0, `union ${seed}: closed manifold without proper crossings`);
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
for (const method of ['dual_contouring', 'marching_cubes']) {
  const mesh = await cook({ ...decorated, out: { type: 'grid_to_mesh', in: ['tag'], params: { method } } }, 'out');
  check(!mesh.points.has('Cd') && !mesh.prims.has('material') && !mesh.detail.has('source_tag') && !mesh.detail.has('materials'), `${method} deliberately drops all source attribute tables`);
}
// Exercise the raw generated exports as well as the TS convenience wrapper.
const raw = await import('../kernels/pkg/topotopo_kernels.js');
const rawGrid = { dims: new Uint32Array([2, 2, 2]), origin: new Float64Array(3), voxel: 1, values: new Float32Array(8) };
for (const invalid of [
  { ...rawGrid, dims: [2, 2, 2] }, { ...rawGrid, origin: [0, 0, 0] }, { ...rawGrid, values: new Float64Array(8) },
  { ...rawGrid, dims: new Uint32Array([1, 2, 2]) }, { ...rawGrid, dims: new Uint32Array([0xffffffff, 2, 2]) },
  { ...rawGrid, origin: new Float64Array([0, 0]) }, { ...rawGrid, origin: new Float64Array([NaN, 0, 0]) },
  { ...rawGrid, voxel: NaN }, { ...rawGrid, voxel: Infinity }, { ...rawGrid, voxel: 0 }, { ...rawGrid, voxel: 1e40 },
  { ...rawGrid, values: new Float32Array(7) }, { ...rawGrid, values: new Float32Array(8).fill(NaN) },
]) { assert.throws(() => raw.grid_offset(invalid, 0)); checks++; }
for (const radius of [-1, 0.5, NaN, Infinity, 1025]) { assert.throws(() => raw.grid_blur(rawGrid, radius)); checks++; }
check((raw.grid_offset(rawGrid, 0) as { values: Float32Array }).values.length === 8, 'raw module remains usable after malformed inputs');
await off.host.pool?.close(); await on.host.pool?.close();
console.log(`sdfgrid: ${checks} integration checks passed`);
