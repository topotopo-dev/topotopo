// Priority-flood acceptance, including validation, JS/WASM copies and returned layers.
// Run alone after kernels:build: TOPOTOPO_WASM=simd node --expose-gc bench/drainage.ts
// --size=1024|4096 --runs=5 --terrain=massif|bowl|rough --epsilon=0 --output=out/report.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kernelsWasmURL, kernelsWasmVariant, loadKernels } from '../src/wasm/kernels.ts';

const arg = (name: string, fallback: string) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const sizes = arg('size', '1024,4096').split(',').map(Number);
const terrains = arg('terrain', 'massif,bowl,rough').split(',');
const runs = Number(arg('runs', '5')), epsilon = Number(arg('epsilon', '0'));
const output = arg('output', 'out/session14/drainage.json');
if (sizes.some(n => ![1024, 4096].includes(n)) || !Number.isInteger(runs) || runs < 1 || runs > 20 ||
    terrains.some(t => !['massif', 'bowl', 'rough'].includes(t)) || !Number.isFinite(epsilon) || epsilon < 0)
  throw new Error('invalid benchmark options');
const kernels = await loadKernels(fs.readFileSync(kernelsWasmURL));
const hash = (x: number, z: number) => {
  let v = Math.imul(x ^ 0x61c88647, 0x45d9f3b) ^ Math.imul(z ^ 0x12345678, 0x27d4eb2d);
  v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
};
function terrain(size: number, kind: string): Float32Array {
  const result = new Float32Array(size * size);
  // Multi-scale bilinear value noise, from integer hashes; generated outside timed calls.
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const nx = (2 * x - size + 1) / (size - 1), nz = (2 * z - size + 1) / (size - 1);
    let height = kind === 'bowl' ? 16 * Math.max(nx * nx, nz * nz) : 32 * Math.max(0, 1 - nx * nx - nz * nz);
    if (kind === 'rough') height += 8 * hash(x, z);
    if (kind === 'massif') {
      for (const [spacing, amplitude] of [[128, 8], [32, 2], [8, 0.5], [2, 0.125]]) {
        const ix = Math.floor(x / spacing), iz = Math.floor(z / spacing);
        const u = (x % spacing) / spacing, v = (z % spacing) / spacing;
        const a = hash(ix, iz) * (1 - u) + hash(ix + 1, iz) * u;
        const b = hash(ix, iz + 1) * (1 - u) + hash(ix + 1, iz + 1) * u;
        height += amplitude * (a * (1 - v) + b * v);
      }
    }
    result[z * size + x] = height;
  }
  return result;
}
const report = {
  cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length,
  os: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
  variant: kernelsWasmVariant, wasmBytes: fs.statSync(kernelsWasmURL).size,
  runs, warmups: 2, epsilon, writeDirection: false,
  scope: 'fill_sinks API, validation and all JS/WASM copies included; input generation and checks excluded',
  cases: [] as { terrain: string; size: number; milliseconds: number[]; median: number; target: number; passed: boolean; filledCells: number; fillSum: number; peakRssMiB: number }[],
};
for (const size of sizes) for (const kind of terrains) {
  const input = terrain(size, kind);
  const call = () => kernels.fill_sinks(input, size, size, { epsilon });
  for (let i = 0; i < report.warmups; i++) { call(); globalThis.gc?.(); }
  const milliseconds: number[] = [];
  let filledCells = 0, fillSum = 0;
  for (let i = 0; i < runs; i++) {
    globalThis.gc?.();
    const start = performance.now(), result = call();
    milliseconds.push(performance.now() - start);
    filledCells = 0; fillSum = 0;
    for (let j = 0; j < input.length; j++) {
      if (result.height[j] < input[j] || !Number.isFinite(result.height[j]) || result.fill[j] < 0)
        throw new Error(`${kind}/${size}: invalid fill at ${j}`);
      filledCells += Number(result.fill[j] > 0); fillSum += result.fill[j];
    }
  }
  const sorted = [...milliseconds].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
  const target = size === 1024 ? 150 : 2000;
  const entry = { terrain: kind, size, milliseconds, median, target, passed: median < target,
    filledCells, fillSum, peakRssMiB: process.resourceUsage().maxRSS / 1024 };
  report.cases.push(entry);
  console.log(JSON.stringify(entry));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(`drainage: ${report.cases.filter(c => c.passed).length}/${report.cases.length} timing targets met; ${output}`);
