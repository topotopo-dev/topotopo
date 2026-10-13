// Includes JS/WASM copying and all returned layers. Run after kernels:build, without SIMD.
// node bench/erosion.ts --runs=3 [--droplet-only | --pipe-only]
// Build with Cargo feature `profile` for pass timings (see kernels/BENCH.md).
import fs from 'node:fs';
import os from 'node:os';
import { kernelsWasmURL, loadKernels } from '../src/wasm/kernels.ts';
import { DEFAULT_EROSION, makeErosionField, erodeStep } from '../src/core/erosion.ts';
import { fractal, makeNoise } from '../src/core/noise.ts';
import { rng } from '../src/core/random.ts';
import type { ErosionField } from '../src/core/erosion.ts';
import type { ErosionResult } from '../src/wasm/kernels.ts';

const runs = Number(process.argv.find(v => v.startsWith('--runs='))?.split('=')[1] ?? 3);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw new Error('runs must be 1..10');
const kernels = await loadKernels(fs.readFileSync(kernelsWasmURL));
console.log(JSON.stringify({ cpu: os.cpus()[0]?.model, os: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version, wasmBytes: fs.statSync(kernelsWasmURL).size, runs }));
function measure(name: string, run: () => Float32Array | Float64Array): number {
  const times: number[] = [], processCpuMilliseconds: number[] = []; let checksum = 0;
  for (let i = 0; i < runs; i++) {
    const cpuStart = process.cpuUsage();
    const start = performance.now(), output = run();
    times.push(performance.now() - start);
    const cpu = process.cpuUsage(cpuStart);
    // Diagnostic only: includes all Node process threads, including WASM tiering.
    processCpuMilliseconds.push((cpu.user + cpu.system) / 1000);
    checksum = 0;
    for (const value of output) checksum += value;
    if (!Number.isFinite(checksum)) throw new Error(`${name}: nonfinite output`);
  }
  const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
  console.log(JSON.stringify({ name, milliseconds: times, processCpuMilliseconds, median, checksum }));
  return median;
}
// Exact binary-fraction input, identical to the native pipe bench.
const size = 1024;
const pipeHeight = Float32Array.from({ length: size * size }, (_, i) => 32 + (size - 1 - Math.floor(i / size)) / 64 + Math.abs(i % size - size / 2) / 128);
const pipeOptions = { iterations: 200, rainAmount: 0.01, thermalRate: 0.1 };
const dropletOnly = process.argv.includes('--droplet-only');
if (!dropletOnly) kernels.erode_pipe(new Float32Array(32 * 32).fill(4), null, 32, 32, 1, { iterations: 10 });
const pipeMs = dropletOnly ? null : measure('pipe WASM 1024^2 x 200, cell=1, closed, rain=.01, thermal=.1', () => kernels.erode_pipe(pipeHeight, null, size, size, 1, pipeOptions, 1).height);
if (process.argv.includes('--pipe-only')) process.exit(0);
const w = 512, h = 512, cell = 0.1, iterations = 100;
const noise = fractal(makeNoise('simplex', 1), { octaves: 6 });
// The noise terrain from test/heightfield.ts, rounded once to the public f32 ABI.
const heights = Float32Array.from({ length: w * h }, (_, i) => (noise((i % w) * cell * 0.1, 0, Math.floor(i / w) * cell * 0.1) * 0.5 + 0.5) * 5);
const dropletOptions = { ...DEFAULT_EROSION, talusAngle: DEFAULT_EROSION.talusAngle * Math.PI / 180, iterations };
const warm = makeErosionField(32, 32, cell, heights.subarray(0, 1024)), warmRandom = rng(1);
for (let i = 0; i < 10; i++) erodeStep(warm, DEFAULT_EROSION, warmRandom);
kernels.erode_droplet(heights.subarray(0, 1024), null, 32, 32, cell, { ...dropletOptions, iterations: 10 }, 1);
let lastJS: ErosionField | undefined, lastWASM: ErosionResult | undefined;
const jsMs = measure('droplet JS 512^2 x 100, defaults, cell=.1', () => {
  const field = makeErosionField(w, h, cell, heights), random = rng(1);
  for (let i = 0; i < iterations; i++) erodeStep(field, DEFAULT_EROSION, random);
  lastJS = field;
  return field.h;
});
const wasmMs = measure('droplet WASM 512^2 x 100, defaults, cell=.1', () => {
  lastWASM = kernels.erode_droplet(heights, null, w, h, cell, dropletOptions, 1);
  return lastWASM.height;
});
console.log(JSON.stringify({ pipeUnder4Seconds: pipeMs === null ? null : pipeMs < 4000, dropletSpeedup: jsMs / wasmMs, dropletAtLeast3x: jsMs / wasmMs >= 3 }));
function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return ab / Math.sqrt(aa * bb);
}
const flowCorrelation = correlation(lastJS!.flow, lastWASM!.flow), sedimentCorrelation = correlation(lastJS!.sediment, lastWASM!.sediment);
const sum = (a: ArrayLike<number>) => { let total = 0; for (let i = 0; i < a.length; i++) total += a[i]; return total; };
const relativeMaterialError = Math.abs(sum(lastWASM!.height) - sum(heights)) / Math.abs(sum(heights));
console.log(JSON.stringify({ terrain: 'test/heightfield.ts 512^2, f32 input, 100 iterations', flowCorrelation, sedimentCorrelation, relativeMaterialError }));
if (!(flowCorrelation > 0.99 && sedimentCorrelation > 0.99)) throw new Error('full-size droplet correlation acceptance failed');
if (!(relativeMaterialError <= 1e-6)) throw new Error('full-size droplet material conservation acceptance failed');
const pw = 33, ph = 25;
const parityHeight = Float32Array.from({ length: pw * ph }, (_, i) => 4 + (ph - 1 - Math.floor(i / pw)) / 16 + Math.abs(i % pw - Math.floor(pw / 2)) / 32);
const parity = kernels.erode_pipe(parityHeight, null, pw, ph, 1, { iterations: 25, rainAmount: 0.01 }, 1);
for (const name of ['height', 'sediment', 'debris', 'flow', 'water', 'wear'] as const) {
  let hash = 2166136261;
  const bytes = new DataView(new ArrayBuffer(4));
  for (const value of parity[name]) {
    bytes.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++) hash = Math.imul(hash ^ bytes.getUint8(i), 16777619) >>> 0;
  }
  console.log(`parity ${name}: ${hash.toString(16).padStart(8, '0')}`);
}
