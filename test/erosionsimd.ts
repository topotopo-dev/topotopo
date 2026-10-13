// Optional feature verification; build the separate SIMD package using kernels/BUILD.md first.
// node test/erosionsimd.ts [path/to/simd/package]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as scalar from '../kernels/pkg/topotopo_kernels.js';
const simdPath = path.resolve(process.argv[2] ?? 'out/session4/pkg-simd');
const simd = await import(pathToFileURL(path.join(simdPath, 'topotopo_kernels.js')).href);
await scalar.default({ module_or_path: fs.readFileSync(new URL('../kernels/pkg/topotopo_kernels_bg.wasm', import.meta.url)) });
await simd.default({ module_or_path: fs.readFileSync(path.join(simdPath, 'topotopo_kernels_bg.wasm')) });
const empty = new Float32Array(0), w = 33, h = 25;
let checks = 0;
for (let seed = 0; seed < 6; seed++) {
  const height = Float32Array.from({ length: w * h }, (_, i) => 4 + (h - 1 - Math.floor(i / w)) / 16 + Math.abs(i % w - 16) / 32 + ((i * 977 + seed * 23) % 47) / 64);
  const freeze = seed % 2 ? Float32Array.from(height, (_, i) => i % 7 === 0 ? 1 : 0) : empty;
  for (const boundary of ['closed', 'open']) {
    const args = [height, empty, freeze, empty, w, h, 1, { iterations: 25, rain_amount: 0.01, boundary, stream_power_k: seed % 2 ? 0.03 : 0 }, BigInt(seed)] as const;
    assert.deepEqual(simd.erode_pipe(...args), scalar.erode_pipe(...args)); checks++;
  }
  const args = [height, empty, freeze, w, h, 0.1, { iterations: 10 }, BigInt(seed)] as const;
  assert.deepEqual(simd.erode_droplet(...args), scalar.erode_droplet(...args)); checks++;
  for (const method of ['d8', 'dinf']) {
    assert.deepEqual(simd.flow_accumulation(height, w, h, 1, method), scalar.flow_accumulation(height, w, h, 1, method)); checks++;
  }
}
console.log(`erosionsimd: ${checks} scalar/SIMD exact result comparisons passed`);
