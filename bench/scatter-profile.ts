// Stage timings from a --features profile package, plus measured wasm-bindgen input/output copies.
// node scripts/kernels-build.ts --features profile
// node --expose-gc bench/scatter-profile.ts --runs 3 --output out/bench/profile.json
// The generated glue is instrumented in memory only; shipped files are never changed.
import fs from 'node:fs';
import path from 'node:path';
import { kernelsWasmURL, kernelsWasmVariant } from '../src/wasm/kernels.ts';
import { rng } from '../src/core/random.ts';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { TriSurface } from '../src/core/pcg.ts';
import { triangulate } from '../src/core/topology.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const runs = Number(flag('--runs') ?? 3);
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
let source = fs.readFileSync(new URL('./topotopo_kernels.js', kernelsWasmURL), 'utf8');
// Time allocation + copying at the generated ABI boundary (all inputs, including empty arrays).
for (const name of ['passArrayF64ToWasm0', 'passArray32ToWasm0']) {
  const signature = `function ${name}(arg, malloc) {`;
  if (!source.includes(signature)) throw new Error(`glue changed: missing ${name}`);
  source = source.replace(signature, `function ${name}Raw(arg, malloc) {`);
  source += `\nfunction ${name}(arg, malloc) { const t = performance.now(); try { return ${name}Raw(arg, malloc); } finally { abi.input += performance.now() - t; } }\n`;
}
let copies = 0;
source = source.replace(/getArrayI32FromWasm0\((r\d), (r\d)\)\.slice\(\)/g, (_all, p, n) => {
  copies++; return `copyOut(() => getArrayI32FromWasm0(${p}, ${n}).slice())`;
});
source = source.replace(/new (Float64Array|Int32Array)\(getArray(F64|I32)FromWasm0\(arg0, arg1\)\)/g, (_all, ctor, kind) => {
  copies++; return `copyOut(() => new ${ctor}(getArray${kind}FromWasm0(arg0, arg1)))`;
});
if (copies < 3) throw new Error('glue changed: copy-out sites missing');
source += '\nconst abi = { input: 0, output: 0 }; export function abiReset() { abi.input = abi.output = 0; } export function abiRead() { return {...abi}; } function copyOut(fn) { const t = performance.now(); try { return fn(); } finally { abi.output += performance.now() - t; } }\n';
const wasm = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
await wasm.default({ module_or_path: fs.readFileSync(kernelsWasmURL) });
const random = rng(1), positions = new Float64Array(3_000_000);
for (let i = 0; i < positions.length / 3; i++) { positions[i * 3] = random() * 100; positions[i * 3 + 2] = random() * 100; }
const half = positions.subarray(0, 1_500_000), scales = Float64Array.from({ length: 500_000 }, (_, i) => 0.5 + positions[i * 3] / 100);
const order = Int32Array.from({ length: 500_000 }, (_, i) => i), empty = new Float64Array();
const rp = positions.subarray(0, 150_000), spacing = new Float64Array(50_000).fill(0.45);
// One large planar triangle; every relaxation point is inside, with an exact one-leaf BVH.
const corners = new Float64Array([-100, 0, -100, 500, 0, -100, -100, 0, 500]);
const bary = new Float64Array(rp.length);
for (let i = 0; i < spacing.length; i++) { const b = (rp[i * 3] + 100) / 600, c = (rp[i * 3 + 2] + 100) / 600; bary[i * 3] = 1 - b - c; bary[i * 3 + 1] = b; bary[i * 3 + 2] = c; }
const cases: [string, () => unknown][] = [
  ['eliminate_1m', () => wasm.scatter_eliminate_f64(positions, empty, 100_000, Math.sqrt(10000 / (2 * Math.sqrt(3) * 100_000)))],
  ['eliminate_500k', () => wasm.scatter_eliminate_f64(half, empty, 100_000, Math.sqrt(10000 / (2 * Math.sqrt(3) * 100_000)))],
  ['adaptive_500k', () => wasm.scatter_eliminate_f64(half, scales, 100_000, Math.sqrt(10000 / (2 * Math.sqrt(3) * 100_000)))],
  ['min_distance_500k', () => wasm.scatter_min_distance_f64(half, order, 0.25, 100_000, new Int32Array(), 0)],
  ['relax_50k_5', () => wasm.scatter_relax(rp, spacing, new Int32Array(50_000), bary, corners,
    new Float64Array([-100, 0, -100, 500, 0, 500]), new Int32Array([-1, 1]), new Int32Array([0]), new Uint32Array([0]), corners, empty,
    5, { radius: 0.45, weighted: false, d_bar: 0.45, w_mean: 1 })],
];
// Also use the acceptance benchmark's 20k-triangle noisy surface and already-selected 50k points.
// Surface generation, selection, and closest-point metadata preparation are outside all stage timers.
const engine = new Engine(createNodeHost({ workers: 0 }));
await engine.init();
const prepared = await engine.cook({ nodes: {
  g: { type: 'grid', params: { size: [100, 100], divisions: [100, 100] } },
  n: { type: 'noise_displace', in: ['g'], params: { amplitude: 2, frequency: 0.05 } },
  s: { type: 'scatter', in: ['n'], params: { count: 50_000, seed: 1, backend: 'js' } },
}, output: 's' });
if (!prepared.ok || !prepared.geo) throw new Error(JSON.stringify(prepared.errors));
const sourceGeo = prepared.results.get('n')!.geo!;
const surface = new TriSurface(sourceGeo, triangulate(sourceGeo).tris), sa = surface.arrays();
const actualP = prepared.geo.P, actualT = new Int32Array(50_000), actualW = new Float64Array(150_000);
const hit = { x: 0, y: 0, z: 0, b0: 0, b1: 0, b2: 0 };
for (let i = 0; i < actualT.length; i++) {
  const tri = surface.closest(actualP[i * 3], actualP[i * 3 + 1], actualP[i * 3 + 2], hit);
  if (tri < 0) throw new Error('profile surface projection failed');
  actualT[i] = tri; actualW.set([hit.b0, hit.b1, hit.b2], i * 3);
}
let area = 0;
for (let i = 0; i < sa.C.length; i += 9) {
  const ax = sa.C[i + 3] - sa.C[i], ay = sa.C[i + 4] - sa.C[i + 1], az = sa.C[i + 5] - sa.C[i + 2];
  const bx = sa.C[i + 6] - sa.C[i], by = sa.C[i + 7] - sa.C[i + 1], bz = sa.C[i + 8] - sa.C[i + 2];
  area += 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
}
const dBar = Math.sqrt(2 * area / (Math.sqrt(3) * 50_000)), actualS = new Float64Array(50_000).fill(dBar);
cases.push(['relax_noisy_50k_5', () => wasm.scatter_relax(actualP, actualS, actualT, actualW,
  sa.T, sa.nodes, sa.child, sa.order, sa.triPrim, sa.C, empty, 5, { radius: 0, weighted: false, d_bar: dBar, w_mean: 1 })]);
engine.cache.clear();
const report: any = { generated: new Date().toISOString(), wasm: kernelsWasmVariant, runs, cases: [] };
const originalLog = console.log;
for (const [name, run] of cases) {
  const samples: { total_ms: number; abi: { input: number; output: number }; stages: unknown[] }[] = [];
  for (let i = 0; i <= runs; i++) {
    globalThis.gc?.();
    const stages: unknown[] = [];
    console.log = (...values: unknown[]) => { if (typeof values[0] === 'string' && values[0].startsWith('{"profile":')) stages.push(JSON.parse(values[0])); else originalLog(...values); };
    wasm.abiReset();
    const start = performance.now();
    try { run(); } finally { console.log = originalLog; }
    const sample = { total_ms: performance.now() - start, abi: wasm.abiRead(), stages };
    if (!stages.length) throw new Error('build with node scripts/kernels-build.ts --features profile first');
    if (i > 0) samples.push(sample);
  }
  report.cases.push({ name, samples });
  originalLog(`${name}: ${samples.map(s => s.total_ms.toFixed(1)).join(', ')} ms`);
}
const output = path.resolve(flag('--output') ?? 'out/bench/profile.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
originalLog(`wrote ${output}`);
