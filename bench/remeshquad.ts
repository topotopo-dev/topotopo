// Real Node/WASM quad remeshing timing, including returned mesh/provenance buffers and JS/WASM copies.
// node bench/remeshquad.ts [--faces=25000] [--runs=3]
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { triangulate } from '../src/core/topology.ts';
import { kernelsWasmURL, loadKernels } from '../src/wasm/kernels.ts';
import type { QuadRemeshResult } from '../src/wasm/kernels.ts';

function option(name: string, fallback: number): number {
  const value = process.argv.find(arg => arg.startsWith(`--${name}=`));
  const n = value ? Number(value.split('=')[1]) : fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
const faces = option('faces', 25000), runs = option('runs', 3);
const kernels = await loadKernels(readFileSync(kernelsWasmURL));
const engine = new Engine(createNodeHost({ workers: 0 }));
await engine.init();
// 2 * cols * (rows - 1) = exactly 100,000 triangles, including both poles.
const graph = {
  nodes: {
    sphere: { type: 'sphere', params: { rows: 201, cols: 250 } },
    noise: { type: 'wrangle', in: ['sphere'], params: { code: 'const r = 1 + 0.025 * sin(@P.x * 7) * sin(@P.y * 5) * cos(@P.z * 6); @P = mul(@P, r);' } },
  }, output: 'noise',
};
const cooked = await engine.cook(graph);
if (!cooked.ok || !cooked.geo) throw new Error(cooked.errors.map(e => e.message).join('; '));
const source = cooked.geo;
const tris = Uint32Array.from(triangulate(source).tris, v => source.vertexPoint[v]);
const gridPositions = new Float64Array(201 * 251 * 3), gridTris = new Uint32Array(200 * 250 * 6);
for (let r = 0; r <= 200; r++) for (let c = 0; c <= 250; c++) {
  const x = -1 + 2 * c / 250, z = 1 - 2 * r / 200, i = (r * 251 + c) * 3;
  gridPositions[i] = x; gridPositions[i + 1] = 0.035 * Math.sin(3 * x) * Math.cos(5 * z); gridPositions[i + 2] = z;
}
for (let r = 0; r < 200; r++) for (let c = 0; c < 250; c++) {
  const a = r * 251 + c, b = a + 1, d = a + 251, e = d + 1;
  gridTris.set([a, b, e, a, e, d], (r * 250 + c) * 6);
}
function quality(mesh: QuadRemeshResult) {
  const edges = new Set<string>();
  let quadCount = 0, within = 0, min = Infinity, max = 0, total = 0;
  const valence = new Uint32Array(mesh.positions.length / 3);
  for (let f = 0; f + 1 < mesh.prim_start.length; f++) {
    const begin = mesh.prim_start[f], end = mesh.prim_start[f + 1];
    if (end - begin === 4) quadCount++;
    for (let j = begin; j < end; j++) {
      const a = mesh.vertex_point[j], b = mesh.vertex_point[j + 1 < end ? j + 1 : begin];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (edges.has(key)) continue;
      edges.add(key); valence[a]++; valence[b]++;
      const l = Math.hypot(...[0, 1, 2].map(k => mesh.positions[a * 3 + k] - mesh.positions[b * 3 + k]));
      min = Math.min(min, l); max = Math.max(max, l); total += l;
      if (Math.abs(l - mesh.quality.target_edge_length) <= 0.35 * mesh.quality.target_edge_length) within++;
    }
  }
  const irregular = valence.filter(n => n !== 4).length;
  return { vertices: valence.length, faces: mesh.prim_start.length - 1, quads: quadCount,
    quad_fraction: quadCount / (mesh.prim_start.length - 1), irregular_vertices: irregular,
    irregular_fraction: irregular / valence.length, reported_singularities: mesh.quality.singularities,
    target_edge_length: mesh.quality.target_edge_length, edge_length_min: min, edge_length_mean: total / edges.size,
    edge_length_max: max, edges_within_35pct: within / edges.size,
    planarity_mean: mesh.quality.planarity_mean, planarity_max: mesh.quality.planarity_max };
}
console.log(JSON.stringify({ benchmark: 'field-aligned quad remesh', node: process.version,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
  logical_cpus: os.availableParallelism(), wasm_bytes: statSync(kernelsWasmURL).size,
  input_triangles: tris.length / 3, requested_faces: faces,
  fixtures: '100k-triangle UV sphere scaled radially by 1+.025*sin(7x)*sin(5y)*cos(6z); 250x200 noisy grid y=.035*sin(3x)*cos(5z), x,z in [-1,1]; raw kernel gets no UV seam constraints',
  includes: 'field construction, hierarchy, extraction, projection, provenance, quality, allocation and JS/WASM copies; excludes WASM initialization and input generation',
}));
// Warm the actual large-input path; the separate warmup result is deliberately excluded from the median.
for (const [fixture, positions, triangles] of [['sphere', source.P, tris], ['noisy_grid', gridPositions, gridTris]] as const) {
  for (let i = -1; i < runs; i++) {
    const start = performance.now();
    const result = kernels.remesh_quad(positions, triangles, { target_faces: faces, smooth_iterations: 8 });
    const elapsed = performance.now() - start;
    console.log(JSON.stringify({ fixture, run: i < 0 ? 'warmup' : i + 1, kernel_ms: +elapsed.toFixed(3), below_3000ms: elapsed < 3000, ...quality(result) }));
  }
}
// End-to-end node time includes triangulation, wedge transfer, attributes, normals and immutable Geometry rebuild.
const nodeStart = performance.now();
const nodeResult = await engine.cook({ ...graph, nodes: { ...graph.nodes, out: { type: 'remesh_quad', in: ['noise'], params: { target_faces: faces, smooth_iterations: 8 } } }, output: 'out' });
if (!nodeResult.ok || !nodeResult.geo) throw new Error(nodeResult.errors.map(e => e.message).join('; '));
console.log(JSON.stringify({ node_ms: +(performance.now() - nodeStart).toFixed(3), output_faces: nodeResult.geo.numPrims,
  output_points: nodeResult.geo.numPoints, quad_fraction: nodeResult.geo.detail.get('quad_fraction')?.get(0), singularities: nodeResult.geo.detail.get('singularities')?.get(0) }));
await engine.host.pool?.close();
