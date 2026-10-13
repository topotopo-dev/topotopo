// Measure whether the serial WASM elimination belongs on the cooking thread or a warmed worker.
// node bench/scatter-placement.ts [--quick] [--runs 3] [--output out/session12/placement.json]
// Input generation and worker/WASM initialization are outside timing. Every measured call includes its WASM copies;
// worker calls include the full message round trip. Originals stay available for attribute interpolation, so the
// ordinary worker case structured-clones its input. The shared case includes preparing a shared copy; cases are
// interleaved in rotating order after warm-up to reduce order and background-load bias.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { rng } from '../src/core/random.ts';
import { kernelsWasmURL, kernelsWasmVariant, loadKernels } from '../src/wasm/kernels.ts';

const kernels = await loadKernels(fs.readFileSync(kernelsWasmURL));
if (!isMainThread) {
  parentPort!.on('message', ({ positions, target, radius }: { positions: Float64Array; target: number; radius: number }) => {
    try {
      const kept = kernels.scatter_eliminate(positions, target, radius);
      parentPort!.postMessage({ kept }, [kept.buffer as ArrayBuffer]);
    } catch (error) { parentPort!.postMessage({ error: String(error) }); }
  });
  parentPort!.postMessage({ ready: true });
} else {
  const args = process.argv.slice(2), flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const quick = args.includes('--quick'), runs = Math.max(1, Number(flag('--runs') ?? 3));
  const count = quick ? 100_000 : 1_000_000, target = count / 10, radius = Math.sqrt(10000 / (2 * Math.sqrt(3) * target));
  const positions = new Float64Array(count * 3), random = rng(1);
  for (let i = 0; i < count; i++) { positions[i * 3] = random() * 100; positions[i * 3 + 2] = random() * 100; }
  const worker = new Worker(new URL(import.meta.url));
  await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); });
  const callWorker = (input: Float64Array) => new Promise<Int32Array>((resolve, reject) => {
    worker.once('message', result => result.error ? reject(new Error(result.error)) : resolve(result.kept));
    worker.postMessage({ positions: input, target, radius });
  });
  const cases: [string, () => Int32Array | Promise<Int32Array>][] = [
    ['main', () => kernels.scatter_eliminate(positions, target, radius)],
    ['worker_clone', () => callWorker(positions)],
    ['worker_shared_copy', () => {
      const shared = new Float64Array(new SharedArrayBuffer(positions.byteLength)); shared.set(positions);
      return callWorker(shared);
    }],
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
      const result = { placement, runs_ms: times.map(x => +x.toFixed(1)), best_ms: +ordered[0].toFixed(1),
        median_ms: +ordered[Math.floor(ordered.length / 2)].toFixed(1) };
      results.push(result); console.log(`${placement}: best ${result.best_ms} ms, median ${result.median_ms} ms`);
    }
  } finally { await worker.terminate(); }
  const report = { generated: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model,
    wasm: kernelsWasmVariant, count, target, radius, quick, runs, results };
  const output = flag('--output') ?? 'out/session12/placement.json';
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`wrote ${output}`);
}
