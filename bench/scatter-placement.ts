// Measure whether the serial WASM elimination belongs on the cooking thread or a warmed worker.
// node bench/scatter-placement.ts [--quick] [--count 500000] [--target 100000] [--masked] [--runs 3] [--output report.json]
// Input generation and worker/WASM initialization are outside timing. Every measured call includes its WASM copies;
// worker calls include the full message round trip. Originals stay available for attribute interpolation, so the
// ordinary worker case structured-clones its input. worker_shared_copy includes preparing shared copies;
// worker_shared_ready reuses pre-existing SharedArrayBuffers. Cases are interleaved in rotating order after warm-up
// to reduce order and background-load bias. --masked uses the deterministic scale 0.5 + x/100 for every candidate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { rng } from '../src/core/random.ts';
import { kernelsWasmURL, kernelsWasmVariant, loadKernels } from '../src/wasm/kernels.ts';

const kernels = await loadKernels(fs.readFileSync(kernelsWasmURL));
if (!isMainThread) {
  parentPort!.on('message', ({ positions, target, radius, scale }: { positions: Float64Array; target: number; radius: number; scale?: Float64Array }) => {
    try {
      const kept = kernels.scatter_eliminate(positions, target, radius, scale);
      parentPort!.postMessage({ kept }, [kept.buffer as ArrayBuffer]);
    } catch (error) { parentPort!.postMessage({ error: String(error) }); }
  });
  parentPort!.postMessage({ ready: true });
} else {
  const args = process.argv.slice(2), flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const quick = args.includes('--quick'), masked = args.includes('--masked'), runs = Number(flag('--runs') ?? 3);
  const count = Number(flag('--count') ?? (quick ? 100_000 : 1_000_000));
  const target = Number(flag('--target') ?? Math.max(1, Math.floor(count / 10)));
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive integer');
  if (!Number.isInteger(target) || target < 1 || target > count) throw new Error('--target must be an integer from 1 to count');
  const radius = Math.sqrt(10000 / (2 * Math.sqrt(3) * target));
  const positions = new Float64Array(count * 3), random = rng(1);
  for (let i = 0; i < count; i++) { positions[i * 3] = random() * 100; positions[i * 3 + 2] = random() * 100; }
  const scale = masked ? Float64Array.from({ length: count }, (_, i) => 0.5 + positions[i * 3] / 100) : undefined;
  const sharedCopy = (input: Float64Array) => {
    const shared = new Float64Array(new SharedArrayBuffer(input.byteLength)); shared.set(input); return shared;
  };
  const sharedPositions = sharedCopy(positions), sharedScale = scale ? sharedCopy(scale) : undefined;
  const worker = new Worker(new URL(import.meta.url));
  await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); });
  const callWorker = (input: Float64Array, inputScale?: Float64Array) => new Promise<Int32Array>((resolve, reject) => {
    worker.once('message', result => result.error ? reject(new Error(result.error)) : resolve(result.kept));
    worker.postMessage({ positions: input, target, radius, scale: inputScale });
  });
  const cases: [string, () => Int32Array | Promise<Int32Array>][] = [
    ['main', () => kernels.scatter_eliminate(positions, target, radius, scale)],
    ['worker_clone', () => callWorker(positions, scale)],
    ['worker_shared_copy', () => callWorker(sharedCopy(positions), scale ? sharedCopy(scale) : undefined)],
    ['worker_shared_ready', () => callWorker(sharedPositions, sharedScale)],
  ];
  const results: { placement: string; runs_ms: number[]; best_ms: number; median_ms: number }[] = [];
  let reference: Int32Array | undefined;
  const samples = cases.map(() => [] as number[]);
  try {
    for (let i = 0; i <= runs; i++) {
      for (let c = 0; c < cases.length; c++) {
        const index = (c + i) % cases.length, [placement, run] = cases[index];
        const t = performance.now(), kept = await run(), ms = performance.now() - t;
        if (reference) assert.deepEqual(kept, reference, `${placement}: selection unchanged`); else reference = kept;
        if (i > 0) samples[index].push(ms);
      }
    }
    for (let c = 0; c < cases.length; c++) {
      const [placement] = cases[c], times = samples[c];
      const ordered = [...times].sort((a, b) => a - b);
      const middle = Math.floor(ordered.length / 2);
      const median = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
      const result = { placement, runs_ms: times.map(x => +x.toFixed(1)), best_ms: +ordered[0].toFixed(1),
        median_ms: +median.toFixed(1) };
      results.push(result); console.log(`${placement}: best ${result.best_ms} ms, median ${result.median_ms} ms`);
    }
  } finally { await worker.terminate(); }
  const report = { generated: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model,
    wasm: kernelsWasmVariant, count, target, radius, masked, quick, runs, results,
    peak_rss_bytes: process.resourceUsage().maxRSS * 1024 };
  const output = flag('--output') ?? 'out/bench/placement.json';
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`wrote ${output}`);
}
