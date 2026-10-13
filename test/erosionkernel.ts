// Real WASM erosion/flow integration and comparison with the unchanged JS droplet model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { heightfieldsOf } from '../src/core/heightfield.ts';
import { DEFAULT_EROSION, erodeStep, makeErosionField } from '../src/core/erosion.ts';
import { fractal, makeNoise } from '../src/core/noise.ts';
import { rng } from '../src/core/random.ts';
import { kernelsWasmURL, kernelsWasmVariant, loadKernels, getLoadedKernels } from '../src/wasm/kernels.ts';
import type { ErosionResult } from '../src/wasm/kernels.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import { fingerprint } from './fingerprint.ts';

let checks = 0;
function check(condition: unknown, message: string): void { assert.ok(condition, message); checks++; }
const sum = (v: ArrayLike<number>) => Array.from(v).reduce((a, b) => a + b, 0);
function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const ma = sum(a) / a.length, mb = sum(b) / b.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return ab / Math.sqrt(aa * bb);
}
function finite(r: ErosionResult, n: number): void {
  for (const name of ['height', 'sediment', 'debris', 'flow', 'water', 'wear'] as const)
    check(r[name].length === n && r[name].every(Number.isFinite), `${name}: finite, complete layer`);
  check(r.wear.every(v => v >= 0), 'wear is nonnegative');
}
const off = new Engine(createNodeHost({ workers: 0 }));
const on = new Engine(createNodeHost({ workers: 2, pool: { minElements: 1 } }));
await off.init(); await on.init();
const sources: Record<string, NodeSpec> = {
  hf: { type: 'heightfield', params: { size: [6.3, 6.3], samples: [64, 64] } },
  noise: { type: 'heightfield_noise', in: ['hf'], params: { fractal: 'ridged', amplitude: 1.5, element_size: 4, seed: 11 } },
};
function graph(params: Record<string, unknown> = {}): GraphSpec {
  return { nodes: { ...sources, out: { type: 'heightfield_erode', in: ['noise'], params: { iterations: 10, ...params } } }, output: 'out' };
}
async function cook(g: GraphSpec, engine = off) {
  const r = await engine.cook(g);
  assert.ok(r.ok && r.geo, r.errors.map(e => e.message).join('; '));
  return r.geo!;
}
try {
  check(!getLoadedKernels(), 'import and engine init leave kernels unloaded');
  const original = await cook(graph());
  check(!heightfieldsOf(original)[0].layer('wear'), 'default JS preserves the historical layer schema');
  assert.deepEqual(fingerprint(await cook(graph({ backend: 'auto' }))), fingerprint(original)); checks++;
  const unavailable = await off.cook(graph({ method: 'pipe', backend: 'auto' }));
  check(!unavailable.ok && /kernel/i.test(unavailable.errors.map(e => e.message).join('; ')), 'auto pipe without loaded kernel errors clearly');
  const kernels = await loadKernels(fs.readFileSync(kernelsWasmURL));
  check(kernels === getLoadedKernels(), 'loader exposes the initialized module for auto');
  const loadedAuto = heightfieldsOf(await cook(graph({ backend: 'auto' })))[0];
  check(!!loadedAuto.layer('wear'), 'loading kernels invalidates a previously cached auto JS fallback');
  assert.deepEqual(loadedAuto.layers, heightfieldsOf(await cook(graph({ backend: 'kernel' })))[0].layers); checks++;
  const w = 65, h = 49, n = w * h, cell = 0.15, iterations = 30;
  const noise = fractal(makeNoise('simplex', 1), { octaves: 6 });
  const heights = Float32Array.from({ length: n }, (_, i) => 4 + 1.4 * noise((i % w) * 0.045, 0, Math.floor(i / w) * 0.045));
  const saved = heights.slice();
  const js = makeErosionField(w, h, cell, heights), random = rng(1);
  for (let it = 0; it < iterations; it++) erodeStep(js, DEFAULT_EROSION, random);
  const options = { ...DEFAULT_EROSION, talusAngle: DEFAULT_EROSION.talusAngle * Math.PI / 180, iterations };
  const droplet = kernels.erode_droplet(heights, null, w, h, cell, options, 1);
  finite(droplet, n);
  assert.deepEqual(heights, saved); checks++;
  const flowCorr = correlation(js.flow, droplet.flow), sedimentCorr = correlation(js.sediment, droplet.sediment);
  console.log(`droplet JS/WASM: flow correlation ${flowCorr.toFixed(9)}, sediment correlation ${sedimentCorr.toFixed(9)}, relative mass error ${Math.abs(sum(droplet.height) - sum(heights)) / sum(heights)}`);
  check(flowCorr > 0.99 && sedimentCorr > 0.99, 'droplet flow and signed sediment correlations > 0.99');
  check(Math.abs(sum(droplet.height) - sum(heights)) / sum(heights) < 1e-6, 'droplet closed conservation within 1e-6');
  assert.deepEqual(droplet, kernels.erode_droplet(heights, null, w, h, cell, options, 1)); checks++;
  const anotherSeed = kernels.erode_droplet(heights, null, w, h, cell, options, 2);
  check(droplet.height.some((v, i) => v !== anotherSeed.height[i]), 'a different seed changes droplet erosion');
  const fractionalSeed = kernels.erode_droplet(heights, null, w, h, cell, options, -0.25);
  assert.deepEqual(fractionalSeed, kernels.erode_droplet(heights, null, w, h, cell, options, -0.25)); checks++;
  check(fractionalSeed.height.some((v, i) => v !== droplet.height[i]), 'fractional negative node seeds remain distinct and deterministic');
  for (const seed of [-0.25, -17, 1.25]) {
    const reference = makeErosionField(w, h, cell, heights), random = rng(seed);
    for (let it = 0; it < iterations; it++) erodeStep(reference, DEFAULT_EROSION, random);
    const result = kernels.erode_droplet(heights, null, w, h, cell, options, seed);
    check(correlation(reference.flow, result.flow) > 0.9 && correlation(reference.sediment, result.sediment) > 0.9,
      `seed ${seed}: JS/WASM preserves numeric RNG semantics and flow/sediment correlation > 0.9`);
  }
  for (const method of ['droplet', 'pipe', 'stream_power']) {
    const g = graph({ method, backend: 'kernel', rain_amount: method === 'droplet' ? 1 : 0.03 });
    const result = await cook(g), hf = heightfieldsOf(result)[0];
    for (const name of ['height', 'sediment', 'debris', 'flow', 'water', 'wear']) {
      const values = hf.layer(name)!;
      check(values?.length === hf.count && values.every(Number.isFinite), `${method} node ${name} finite`);
      if (name !== 'height') check(values.every(v => v >= 0), `${method} node ${name} >= 0`);
      if (name === 'flow') check(values.every(v => v <= 1), `${method} flow <= 1`);
    }
    off.cache.clear();
    assert.deepEqual(fingerprint(await cook(g)), fingerprint(result)); checks++;
    await on.host.pool?.warm();
    assert.deepEqual(heightfieldsOf(await cook(g, on))[0].layers, hf.layers); checks++;
    assert.deepEqual(fingerprint(await cook(graph({ method, backend: 'auto', rain_amount: method === 'droplet' ? 1 : 0.03 }))), fingerprint(result)); checks++;
  }
  assert.deepEqual(fingerprint(await cook(graph())), fingerprint(original)); checks++;
  const wrong = await off.cook(graph({ method: 'pipe', backend: 'js' }));
  check(!wrong.ok && /kernel/i.test(wrong.errors.map(e => e.message).join('; ')), 'pipe backend js errors clearly');
  for (const method of ['droplet', 'pipe'] as const) {
    const run = (hard: Float32Array | null, freeze?: Float32Array, rain?: Float32Array) => method === 'droplet'
      ? kernels.erode_droplet(heights, hard, w, h, cell, options, 1, freeze)
      : kernels.erode_pipe(heights, hard, w, h, cell, { iterations: 20, rainAmount: 0.03 }, 1, freeze, rain);
    const hard = run(new Float32Array(n).fill(1));
    assert.deepEqual(hard.height, heights); checks++;
    const frozen = run(null, new Float32Array(n).fill(1));
    assert.deepEqual(frozen.height, heights); checks++;
    const partial = new Float32Array(n); for (let i = 0; i < n; i++) if (i % w < w / 2) partial[i] = 1;
    const frozenHalf = run(null, partial);
    check(frozenHalf.height.every((v, i) => partial[i] !== 1 || v === heights[i]), `${method}: frozen half never changes`);
    const hardHalf = run(partial);
    check(hardHalf.wear.every((v, i) => partial[i] !== 1 || v === 0), `${method}: hardness 1 never wears inside a partially hard field`);
    const partlyFrozen = run(null, new Float32Array(n).fill(0.5));
    finite(partlyFrozen, n);
    check(Math.abs(sum(partlyFrozen.height) - sum(heights)) / sum(heights) < 1e-3, `${method}: fractional freeze conserves material`);
    const r = run(null); finite(r, n);
    check(Math.abs(sum(r.height) - sum(heights)) / sum(heights) < 1e-3, `${method}: all suspended material settles on return`);
    if (method === 'pipe') {
      const dry = run(null, undefined, new Float32Array(n));
      check(dry.water.every(v => v === 0), 'zero rain map means no water');
    }
  }
  const thermal = kernels.thermal_erode(heights, null, w, h, cell, 0.15, 0.2, 20);
  finite(thermal, n);
  check(Math.abs(sum(thermal.height) - sum(heights)) / sum(heights) < 1e-3, 'standalone thermal conserves material');
  const flat = new Float32Array(81).fill(3);
  for (const r of [kernels.erode_droplet(flat, null, 9, 9, 1, { iterations: 10 }), kernels.erode_pipe(flat, null, 9, 9, 1, { iterations: 10 })]) {
    assert.deepEqual(r.height, flat); checks++;
  }
  for (const method of ['d8', 'dinf'] as const) {
    const coneGraph: GraphSpec = { nodes: {
      hf: { type: 'heightfield', params: { size: [16, 16], samples: [33, 33] } },
      cone: { type: 'heightfield_layer', in: ['hf'], params: { expression: '12 - sqrt(x*x + z*z)' } },
      out: { type: 'heightfield_flow', in: ['cone'], params: { method, normalise: false, log_scale: false } },
    }, output: 'out' };
    const hf = heightfieldsOf(await cook(coneGraph))[0], drainage = hf.layer('drainage')!, direction = hf.layer('direction')!;
    check(drainage.every(v => Number.isFinite(v) && v >= 0), `${method}: drainage is finite positive`);
    const dx = [1, 1, 0, -1, -1, -1, 0, 1], dz = [0, 1, 1, 1, 0, -1, -1, -1];
    for (let z = 1; z < 32; z++) for (let x = 1; x < 32; x++) {
      if (x === 16 && z === 16) continue;
      const d = direction[z * 33 + x];
      check(d >= 0 && d < 8 && (x - 16) * dx[d] + (z - 16) * dz[d] > 0, `${method}: cone cell drains radially outwards`);
    }
    const normalized = heightfieldsOf(await cook({ ...coneGraph, nodes: { ...coneGraph.nodes, out: { ...coneGraph.nodes.out, params: { method, normalise: true, log_scale: true } } } }))[0];
    check(normalized.layer('drainage')!.every(v => v >= 0 && v <= 1), `${method}: normalized log drainage in 0..1`);
  }
  for (const bad of [new Float32Array(5), new Float32Array(9).fill(NaN), new Float32Array(9).fill(Infinity)]) {
    assert.throws(() => kernels.erode_pipe(bad, null, 3, 3, 1)); checks++;
    assert.throws(() => kernels.erode_droplet(bad, null, 3, 3, 1)); checks++;
  }
  assert.throws(() => kernels.erode_pipe(flat, null, 9, 9, 0)); checks++;
  assert.throws(() => kernels.erode_droplet(flat, new Float32Array(5), 9, 9, 1)); checks++;
  assert.throws(() => kernels.flow_accumulation(flat, 9, 9, -1)); checks++;
  assert.throws(() => kernels.erode_droplet(flat, null, 9, 9, 1, {}, NaN)); checks++;
  assert.throws(() => kernels.erode_droplet(flat, null, 9, 9, 1, {}, -1n)); checks++;
  assert.throws(() => kernels.erode_pipe(flat, null, 9, 9, 1, {}, 1, null, new Float32Array(4))); checks++;
  assert.throws(() => kernels.flow_accumulation(flat, 9.1, 9, 1)); checks++;
  assert.throws(() => kernels.thermal_erode(flat, null, 9, 9, 1, 0.5, 0.2, 1.5)); checks++;
  // Check generated WASM directly too: malformed options must return a validation error, never a trap.
  const raw = kernelsWasmVariant === 'simd'
    ? await import('../kernels/pkg-simd/topotopo_kernels.js')
    : await import('../kernels/pkg/topotopo_kernels.js');
  const empty = new Float32Array(0);
  const badRawCalls: Array<() => unknown> = [
    () => raw.erode_droplet(flat, empty, empty, 9, 9, 1, null, 0n),
    () => raw.erode_droplet(flat, empty, empty, 9, 9, 1, { iterations: 1.5 }, 0n),
    () => raw.erode_droplet(flat, empty, empty, 9, 9, 1, { rng_state: -1 }, 0n),
    () => raw.erode_droplet(flat, empty, empty, 9, 9, 1, { rain_amount: NaN }, 0n),
    () => raw.erode_droplet(flat, empty, empty, 9, 9, 1, { boundary: 'sideways' }, 0n),
    () => raw.erode_pipe(flat, empty, empty, empty, 9, 9, 1, { rain_amount: 1e40 }, 0n),
    () => raw.erode_pipe(flat, empty, empty, empty, 9, 9, 1, { iterations: -1 }, 0n),
    () => raw.erode_pipe(flat, empty, empty, empty, -1, 9, 1, {}, 0n),
    () => raw.erode_pipe(flat, empty, empty, new Float32Array(81).fill(-1), 9, 9, 1, {}, 0n),
    () => raw.thermal_erode(flat, empty, 9, 9, 1, Infinity, 0.2, 1),
    () => raw.flow_accumulation(flat, 9, 9, 1, 'other'),
  ];
  for (const fn of badRawCalls) {
    assert.throws(fn, error => typeof error === 'string' || (error instanceof Error && error.name !== 'RuntimeError'),
      'bad WASM input returns a validation error without trapping');
    checks++;
  }
  // Exact binary-fraction fixture also emitted by the native erosion benchmark.
  const parityW = 33, parityH = 25;
  const parityInput = Float32Array.from({ length: parityW * parityH }, (_, i) => 4 + (parityH - 1 - Math.floor(i / parityW)) / 16 + Math.abs(i % parityW - 16) / 32);
  const parity = kernels.erode_pipe(parityInput, null, parityW, parityH, 1, { iterations: 25, rainAmount: 0.01 }, 1);
  // Session 6 native, scalar and SIMD WASM agree after conservative split gathering.
  const nativeDigests = { height: '13671b26', sediment: 'b2627087', debris: '355aea95', flow: 'b8715d6e', water: 'ac938cfe', wear: '4f1e6002' };
  for (const name of ['height', 'sediment', 'debris', 'flow', 'water', 'wear'] as const) {
    let hash = 2166136261;
    const bytes = new DataView(new ArrayBuffer(4));
    for (const value of parity[name]) {
      bytes.setFloat32(0, value, true);
      for (let byte = 0; byte < 4; byte++) hash = Math.imul(hash ^ bytes.getUint8(byte), 16777619) >>> 0;
    }
    check(hash.toString(16).padStart(8, '0') === nativeDigests[name], `${name}: native/WASM exact binary-fraction fixture digest`);
  }
  console.log(`erosionkernel: ${checks} integration checks passed`);
} finally {
  await off.host.pool?.close(); await on.host.pool?.close();
}
