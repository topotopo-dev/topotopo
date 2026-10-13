// Real Node/WASM grid timings, including JS/WASM copies and returned mesh buffers.
// node bench/sdfgrid.ts                 64^3 warmup, then 256^3 narrow-band and filled runs
// node bench/sdfgrid.ts --resolution=64 smaller diagnostic run
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { kernelsWasmURL, loadKernels } from '../src/wasm/kernels.ts';

const option = process.argv.find((arg) => arg.startsWith('--resolution='));
const resolution = option ? Number(option.split('=')[1]) : 256;
if (!Number.isInteger(resolution) || resolution < 16 || resolution > 384) throw new Error('resolution must be an integer in 16..384');
const wasm = readFileSync(kernelsWasmURL);
const kernels = await loadKernels(wasm);

// Closed outward-wound box spanning [-1, 1]^3, twelve triangles.
const positions = new Float64Array([
  -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
  -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
]);
const triangles = new Uint32Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
  0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
]);

function run(samples: number, fill: boolean) {
  // The tiny outward rounding avoids ceil(255.00000000000003) adding a spurious row at 256^3.
  const padding = 4, voxel = (2 / (samples - 1 - 2 * padding)) * (1 + 1e-12);
  const start = performance.now();
  const grid = kernels.sdf_from_mesh(positions, triangles, voxel, 3, padding, fill);
  const sampled = performance.now();
  if (Array.from(grid.dims).some((n) => n !== samples)) throw new Error(`expected ${samples}^3 grid, got ${Array.from(grid.dims).join('x')}`);
  const mesh = kernels.dual_contour(grid, 0, 1e-6, true, true);
  const contoured = performance.now();
  return {
    resolution: samples, dims: Array.from(grid.dims), samples: grid.values.length, voxel, band_voxels: 3,
    padding_voxels: padding, fill, grid_ms: +(sampled - start).toFixed(3),
    dual_contour_ms: +(contoured - sampled).toFixed(3), total_ms: +(contoured - start).toFixed(3),
    output_vertices: mesh.positions.length / 3, output_prims: mesh.prim_start.length - 1,
    below_1500ms: contoured - start < 1500,
  };
}

console.log(JSON.stringify({ benchmark: 'sampled mesh SDF + sharp dual contour', node: process.version,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
  logical_cpus: os.availableParallelism(), wasm_bytes: statSync(kernelsWasmURL).size,
  includes: 'BVH build, mesh sampling, optional sweeping, dual contouring, allocation and JS/WASM copies; excludes WASM initialization',
  fixture: '12-triangle outward-wound box [-1,1]^3; other concurrently running agents may affect timings' }));
console.log(JSON.stringify({ warmup: run(Math.min(64, resolution), false) }));
for (const fill of [false, true]) console.log(JSON.stringify(run(resolution, fill)));
