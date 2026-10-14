// Includes JS/WASM copying and all returned layers. Run after kernels:build.
// SIMD is selected automatically; TOPOTOPO_WASM=scalar tests the fallback.
// node bench/erosion.ts --runs=3 [--droplet-only | --pipe-only] [--thermal-interval=4]
// --assert prints informational PASS/MISS targets; --native=path/to/erosion runs a prebuilt native bench.
// Build with Cargo feature `profile` for pass timings (see kernels/BENCH.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { kernelsWasmURL, kernelsWasmVariant, loadKernels } from '../src/wasm/kernels.ts';
import { DEFAULT_EROSION, makeErosionField, erodeStep } from '../src/core/erosion.ts';
import { fractal, makeNoise } from '../src/core/noise.ts';
import { rng } from '../src/core/random.ts';
import type { ErosionField } from '../src/core/erosion.ts';
import type { ErosionResult } from '../src/wasm/kernels.ts';

const runs = Number(process.argv.find(v => v.startsWith('--runs='))?.split('=')[1] ?? 3);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw new Error('runs must be 1..10');
const thermalInterval = Number(process.argv.find(v => v.startsWith('--thermal-interval='))?.split('=')[1] ?? 1);
if (!Number.isSafeInteger(thermalInterval) || thermalInterval < 1 || thermalInterval > 10000)
  throw new Error('thermal-interval must be 1..10000');
const dropletOnly = process.argv.includes('--droplet-only');
const pipeOnly = process.argv.includes('--pipe-only');
if (dropletOnly && pipeOnly) throw new Error('choose either --droplet-only or --pipe-only');
const assertTargets = process.argv.includes('--assert');
const nativeExecutable = process.argv.find(v => v.startsWith('--native='))?.slice('--native='.length);
const wasmBytes = fs.readFileSync(kernelsWasmURL);
// Profile builds import performance.now as __wbg_now_1f3c5e88a3f82e3e.
// Inspect the binary import rather than the package directory; allow binding hash changes.
// Keep the host-agnostic project typecheck free of DOM library declarations.
const wasm = (globalThis as unknown as { WebAssembly: { Module: {
  new(bytes: Uint8Array): object;
  imports(module: object): { kind: string; name: string }[];
} } }).WebAssembly;
const wasmProfile = wasm.Module.imports(new wasm.Module(wasmBytes))
  .some(({ kind, name }) => kind === 'function' && name.startsWith('__wbg_now_'));
if (assertTargets && wasmProfile)
  throw new Error('--assert requires WASM built without the profile feature (performance.now import found)');
let nativePipeMs: number | null = null;
// Native execution is serial and outside all WASM timers. Compile the ordinary release
// executable beforehand: a profiled binary is useful diagnostically, not for acceptance.
if (!dropletOnly && nativeExecutable !== undefined) {
  if (!nativeExecutable) throw new Error('--native requires a benchmark executable path');
  const result = spawnSync(path.resolve(nativeExecutable), [`--runs=${runs}`, '--pipe-only', `--thermal-interval=${thermalInterval}`], { encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`native erosion benchmark exited ${result.status ?? result.signal}`);
  const summary = result.stdout.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  }).find(record => record.name === 'pipe native');
  if (!summary || typeof summary.median !== 'number' || !Number.isFinite(summary.median) || summary.median < 0
    || summary.thermalInterval !== thermalInterval)
    throw new Error('native erosion benchmark did not emit a matching pipe summary; rebuild kernels/benches/erosion.rs');
  nativePipeMs = summary.median;
  if (assertTargets && summary.profile === true)
    throw new Error('--assert requires a native release benchmark built without the profile feature');
}
const kernels = await loadKernels(wasmBytes);
console.log(JSON.stringify({ cpu: os.cpus()[0]?.model, os: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version, variant: kernelsWasmVariant, wasmBytes: wasmBytes.byteLength, wasmProfile, runs, thermalInterval }));
function reportTargets(pipeMs: number | null, dropletSpeedup: number | null): void {
  const pipeComparable = thermalInterval === 1;
  console.log(JSON.stringify({ nativePipeMs, pipeMs, pipeUnder4Seconds: pipeMs === null || !pipeComparable || wasmProfile || kernelsWasmVariant !== 'simd' ? null : pipeMs <= 4000, dropletSpeedup, dropletAtLeast3x: dropletSpeedup === null || wasmProfile ? null : dropletSpeedup >= 3, thermalInterval, pipeComparable }));
  if (!assertTargets) return;
  const target = (name: string, pass: boolean, observed: string) => console.log(`${pass ? 'PASS' : 'MISS'} ${name}: ${observed}`);
  const cadence = pipeComparable ? '' : ` [diagnostic thermal interval=${thermalInterval}; not comparable to interval=1 target]`;
  target(`pipe native <= 2000 ms${cadence}`, pipeComparable && nativePipeMs !== null && nativePipeMs <= 2000,
    nativePipeMs === null ? 'not measured; run without --droplet-only and provide --native=path/to/erosion' : `${nativePipeMs.toFixed(3)} ms`);
  target(`pipe WASM SIMD <= 4000 ms${cadence}`, pipeComparable && kernelsWasmVariant === 'simd' && pipeMs !== null && pipeMs <= 4000,
    pipeMs === null ? 'not measured (--droplet-only)' : `${pipeMs.toFixed(3)} ms (${kernelsWasmVariant})`);
  target('droplet >= 3x TypeScript', dropletSpeedup !== null && dropletSpeedup >= 3,
    dropletSpeedup === null ? 'not measured (--pipe-only)' : `${dropletSpeedup.toFixed(3)}x`);
  // Speed misses deliberately do not set process.exitCode: they are benchmark observations.
}
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
// Omit the default option so this harness can also profile preserved pre-session builds.
const pipeOptions = { iterations: 200, rainAmount: 0.01, thermalRate: 0.1, ...(thermalInterval === 1 ? {} : { thermalInterval }) };
if (!dropletOnly) kernels.erode_pipe(new Float32Array(32 * 32).fill(4), null, 32, 32, 1, { iterations: 10 });
const pipeMs = dropletOnly ? null : measure(`pipe WASM 1024^2 x 200, cell=1, closed, rain=.01, thermal=.1, thermal interval=${thermalInterval}`, () => kernels.erode_pipe(pipeHeight, null, size, size, 1, pipeOptions, 1).height);
if (pipeOnly) { reportTargets(pipeMs, null); process.exit(0); }
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
reportTargets(pipeMs, jsMs / wasmMs);
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
