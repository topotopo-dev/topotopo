// Behavioural tests for heightfields: the volume model, the heightfield_* nodes, erosion, heightmap export, the
// PNG decoder, rendering/inspection hooks and fingerprints.
//   node test/heightfield.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { Heightfield, blurGrid, distanceTransform, heightfieldsOf } from '../src/core/heightfield.ts';
import { DEFAULT_EROSION, erodeStep, makeErosionField } from '../src/core/erosion.ts';
import { fractal, makeNoise } from '../src/core/noise.ts';
import { rng } from '../src/core/random.ts';
import { decodePNG, inflateZlib, pngChannel } from '../src/io/png-decode.ts';
import { encodeGreyPNG, heightmapExport, heightmapPaths, quantize16, zlibStored } from '../src/io/heightmap.ts';
import { exportGeometry } from '../src/io/export.ts';
import { encodePNG } from '../src/render/png.ts';
import { renderGeometry } from '../src/render/raster.ts';
import { summarize } from '../src/inspect.ts';
import { topologyReport } from '../src/core/topology.ts';
import { Workspace } from '../src/workspace.ts';
import { makeTools } from '../src/mcp/tools.ts';
import { fingerprint } from './fingerprint.ts';
import type { NodeSpec } from '../src/graph/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polyforge-hf-'));
const engine = new Engine(createNodeHost({ baseDir: tmp }));
await engine.init();

let fail = 0, pass = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (ok) pass++; else fail++;
};
const section = (s: string) => console.log(`\n== ${s}`);

async function geo(nodes: Record<string, NodeSpec>, output?: string): Promise<Geometry> {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return r.geo;
}
async function field(nodes: Record<string, NodeSpec>, output?: string): Promise<Heightfield> {
  const g = await geo(nodes, output);
  const hfs = heightfieldsOf(g);
  if (hfs.length !== 1) throw new Error(`expected one heightfield, got ${hfs.length}`);
  return hfs[0];
}
async function cookErr(nodes: Record<string, NodeSpec>, output?: string): Promise<string> {
  const r = await engine.cook({ nodes, output });
  return r.ok ? '' : r.errors.map((e) => e.message).join('; ');
}
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const sum = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
const variance = (a: ArrayLike<number>) => { const m = sum(a) / a.length; let v = 0; for (let i = 0; i < a.length; i++) v += (a[i] - m) ** 2; return v / a.length; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => maxDiff(a, b) === 0;

const HF: NodeSpec = { type: 'heightfield', params: { size: [4, 4], resolution: 0.1 } };
const NOISE = (seed = 1, extra: any = {}): NodeSpec => ({ type: 'heightfield_noise', in: ['hf'], params: { amplitude: 0.8, element_size: 1.5, seed, ...extra } });
const TAN20 = Math.tan((20 * Math.PI) / 180);
const TILT: Record<string, NodeSpec> = { hf: HF, t: { type: 'heightfield_layer', in: ['hf'], params: { expression: `x * ${TAN20}` } } };

// ---------------------------------------------------------------- model
section('create and the volume model');
{
  const hf = await field({ hf: { type: 'heightfield', params: { size: [4, 2], resolution: 0.5, center: [1, 0.5, -1], height: 0.25 } } });
  check(hf.width === 9 && hf.height === 5 && hf.cellSize === 0.5, `size 4 × 2 at 0.5 m → 9 × 5 samples (got ${hf.width} × ${hf.height})`);
  check(hf.layer('height')!.length === 45 && hf.layer('mask')!.length === 45, 'height and mask layers have width × height entries');
  check(hf.origin[0] === -1 && hf.origin[1] === -2 && hf.center[0] === 1 && hf.center[1] === -1, 'origin and centre from center param');
  check(hf.layer('height')!.every((v) => v === 0.75) && hf.layer('mask')!.every((v) => v === 0), 'height = height + center.y, mask = 0');
  const b = hf.bounds;
  check(b.min[0] === -1 && b.max[0] === 3 && b.min[2] === -2 && b.max[2] === 0 && b.min[1] === 0.75, 'bounds: XZ extent and the height range');
  const s = await field({ hf: { type: 'heightfield', params: { size: [10, 5], samples: [11, 0] } } });
  check(s.width === 11 && s.height === 6 && s.cellSize === 1, `samples [11, 0] over 10 × 5 m → cell 1, 11 × 6 (got ${s.width} × ${s.height}, ${s.cellSize})`);
  const err = await cookErr({ hf: { type: 'heightfield', params: { size: [1000, 1000], resolution: 0.01 } } });
  check(/too large/.test(err), 'oversized grids fail with a hint');
  const g = new Geometry();
  const h = new Heightfield(3, 3, 1, [0, 0]);
  h.layers.set('height', Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]));
  g.volumes = [h];
  check(Math.abs(h.sample(0.5, 0.5) - 2) < 1e-9 && h.sample(-5, -5) === 0 && h.sample(9, 9) === 8, 'bilinear sample, clamped at the border');
  const c = g.clone();
  const hc = heightfieldsOf(c)[0];
  hc.layers.set('mask', new Float32Array(9));
  check(!h.layers.has('mask') && hc.layer('height') === h.layer('height'), 'clone() copies the layer map, shares the arrays');
  const m = Geometry.merge([g, g]);
  check(m.volumes.length === 2 && m.bbox(true).max[1] === 8 && m.bbox(true).max[0] === 2, 'merge keeps heightfields; bbox(true) includes them');
}

// ---------------------------------------------------------------- noise, from mesh, to mesh
section('noise, from_mesh, to_mesh');
{
  const a = await field({ hf: HF, n: NOISE(1) });
  engine.cache.clear();
  const b = await field({ hf: HF, n: NOISE(1) });
  const c = await field({ hf: HF, n: NOISE(2) });
  check(a.layer('height') !== b.layer('height') && same(a.layer('height')!, b.layer('height')!), 'noise is deterministic per seed (fresh cook, identical values)');
  check(maxDiff(a.layer('height')!, c.layer('height')!) > 0.05, 'another seed gives another field');
  const pos = await field({ hf: HF, n: NOISE(1, { range: 'positive' }) });
  check(pos.layer('height')!.every((v) => v >= 0 && v <= 0.8 + 1e-6), 'range positive: values in [0, amplitude]');
  const mul = await field({ hf: HF, base: { type: 'heightfield_layer', in: ['hf'], params: { operation: 'fill', value: 2 } }, n: { type: 'heightfield_noise', in: ['base'], params: { mode: 'multiply', amplitude: 1, range: 'positive', seed: 3 } } }, 'n');
  check(mul.layer('height')!.every((v) => v >= 0 && v <= 2 + 1e-6), 'mode multiply scales the layer');

  // from_mesh of a tilted plane: height = tan(20°) x
  const plane: Record<string, NodeSpec> = {
    g: { type: 'grid', params: { size: [4, 4], divisions: [8, 8] } },
    t: { type: 'transform', in: ['g'], params: { rotate: [0, 0, 20] } },
    hf: { type: 'heightfield_from_mesh', in: ['t'], params: { resolution: 0.1 } },
  };
  const tp = await field(plane, 'hf');
  let err = 0, hits = 0;
  const H = tp.layer('height')!, M = tp.layer('mask')!;
  for (let j = 0; j < tp.height; j++) for (let i = 0; i < tp.width; i++) { const k = j * tp.width + i; if (M[k]) { hits++; err = Math.max(err, Math.abs(H[k] - TAN20 * tp.x(i))); } }
  // the field rounds the mesh extent up to whole cells, so the outermost samples may lie just outside the plane
  check(hits > tp.count * 0.9 && err < 1e-3, `from_mesh of a tilted plane matches its heights (max error ${err.toExponential(1)}, ${hits}/${tp.count} hit)`);
  const sph = await field({ s: { type: 'sphere', params: { radius: 1 } }, hf: { type: 'heightfield_from_mesh', in: ['s'], params: { resolution: 0.1, direction: 'up', miss: 'background', background: 7 } } }, 'hf');
  const mid = sph.layer('height')![Math.floor(sph.height / 2) * sph.width + Math.floor(sph.width / 2)];
  check(Math.abs(mid + 1) < 0.02 && sph.layer('height')![0] === 7, 'direction up takes the lowest surface; misses get the background');

  // to_mesh → from_mesh round trip
  const nodes: Record<string, NodeSpec> = { hf: HF, n: NOISE(4), m: { type: 'heightfield_to_mesh', in: ['n'] }, back: { type: 'heightfield_from_mesh', in: ['m'], params: { resolution: 0.1 } } };
  const orig = await field(nodes, 'n');
  const mesh = await geo(nodes, 'm');
  const back = await field(nodes, 'back');
  check(mesh.numPoints === orig.count && mesh.numPrims === (orig.width - 1) * (orig.height - 1) && mesh.points.has('height') && mesh.points.has('mask') && mesh.points.has('N') && mesh.points.has('uv'), 'to_mesh: a point per sample, a quad per cell, layers/N/uv as point attributes');
  check(mesh.volumes.length === 0, 'to_mesh drops the heightfield by default');
  const N = mesh.points.get('N')!.data as Float64Array;
  let up = true;
  for (let i = 1; i < N.length; i += 3) if (N[i] <= 0) up = false;
  check(up, 'to_mesh normals point up');
  check(back.width === orig.width && back.height === orig.height && maxDiff(back.layer('height')!, orig.layer('height')!) < 1e-5, `from_mesh(to_mesh(hf)) ≈ hf (max diff ${maxDiff(back.layer('height')!, orig.layer('height')!).toExponential(1)})`);
  const dec = await geo({ ...nodes, m2: { type: 'heightfield_to_mesh', in: ['n'], params: { step: 4, color: 'terrain' } } }, 'm2');
  check(dec.numPoints === 11 * 11 && dec.points.has('Cd'), 'to_mesh step 4 decimates (41 → 11 per side) and colours');
}

// ---------------------------------------------------------------- filters
section('remap, blur, terrace, clip, cutout, layer');
{
  const nodes: Record<string, NodeSpec> = { hf: HF, n: NOISE(5) };
  const n = await field(nodes, 'n');
  const H = n.layer('height')!;
  const r = await field({ ...nodes, r: { type: 'heightfield_remap', in: ['n'], params: { output_min: 2, output_max: 4 } } }, 'r');
  const rs = r.layer('height')!;
  check(Math.abs(Math.min(...rs) - 2) < 1e-5 && Math.abs(Math.max(...rs) - 4) < 1e-5, 'remap fits the layer to the output range');
  const b = await field({ ...nodes, b: { type: 'heightfield_blur', in: ['n'], params: { radius: 0.4 } } }, 'b');
  check(variance(b.layer('height')!) < variance(H) * 0.95, `blur reduces variance (${variance(H).toFixed(4)} → ${variance(b.layer('height')!).toFixed(4)})`);
  check(Math.abs(sum(b.layer('height')!) / H.length - sum(H) / H.length) < 0.02, 'blur keeps the mean');
  const bb = await field({ ...nodes, b: { type: 'heightfield_blur', in: ['n'], params: { radius: 0.4, mode: 'box', iterations: 3 } } }, 'b');
  check(variance(bb.layer('height')!) < variance(b.layer('height')!), 'box blur × 3 iterations blurs more');
  const t = await field({ ...nodes, t: { type: 'heightfield_terrace', in: ['n'], params: { step_height: 0.25, rounding: 0 } } }, 't');
  let quant = true;
  for (const v of t.layer('height')!) if (Math.abs(v / 0.25 - Math.round(v / 0.25)) > 1e-4) quant = false;
  check(quant, 'terrace rounding 0 quantises heights to multiples of the step');
  const levels = new Set(Array.from(t.layer('height')!, (v) => Math.round(v * 1000)));
  check(levels.size >= 3 && levels.size <= 12, `terrace makes a few levels (${levels.size})`);
  const c = await field({ ...nodes, c: { type: 'heightfield_clip', in: ['n'], params: { min: -0.1, max: 0.2 } } }, 'c');
  check(c.layer('height')!.every((v) => v >= -0.1 - 1e-6 && v <= 0.2 + 1e-6), 'clip clamps to [min, max]');
  const cut = await field({ ...nodes, circ: { type: 'circle', params: { radius: 1, segments: 48 } }, cut: { type: 'heightfield_cutout', in: ['n', 'circ'], params: { value: -5 } } }, 'cut');
  const ch = cut.layer('height')!;
  check(ch[0] === -5 && Math.abs(ch[20 * 41 + 20] - H[20 * 41 + 20]) < 1e-6, 'cutout: outside the shape set to value, inside kept');
  const lay = await field({ ...nodes, m: { type: 'heightfield_mask_noise', in: ['n'], params: { seed: 2 } }, l: { type: 'heightfield_layer', in: ['m'], params: { expression: 'height * mask + 2' } } }, 'l');
  const lh = lay.layer('height')!, lm = lay.layer('mask')!;
  let le = 0;
  for (let k = 0; k < lh.length; k++) le = Math.max(le, Math.abs(lh[k] - (H[k] * lm[k] + 2)));
  check(le < 1e-5, 'layer expression "height * mask + 2"');
  const cp = await field({ ...nodes, cp: { type: 'heightfield_layer', in: ['n'], params: { operation: 'copy', source: 'height', layer: 'h0' } }, rn: { type: 'heightfield_layer', in: ['cp'], params: { operation: 'rename', source: 'h0', layer: 'base' } }, del: { type: 'heightfield_layer', in: ['rn'], params: { operation: 'delete', layer: 'mask' } } }, 'del');
  check(!cp.layers.has('h0') && !cp.layers.has('mask') && same(cp.layer('base')!, H), 'layer copy, rename, delete');
  const two = await field({ ...nodes, other: { type: 'heightfield', params: { size: [4, 4], resolution: 0.2, height: 3 } }, l2: { type: 'heightfield_layer', in: ['n', 'other'], params: { expression: 'height + b_height' } } }, 'l2');
  check(maxDiff(two.layer('height')!, Array.from(H, (v) => v + 3)) < 1e-5, 'layer expression reads input 1 layers as b_<name>');
  check(/expected a number/.test(await cookErr({ ...nodes, l: { type: 'heightfield_layer', in: ['n'], params: { expression: '[1, 2]' } } }, 'l')), 'layer expression returning an array fails clearly');
  check(/no layer "nope"/.test(await cookErr({ ...nodes, b: { type: 'heightfield_blur', in: ['n'], params: { layer: 'nope' } } }, 'b')), 'missing layer: clear error listing the layers');
  check(/no heightfield/.test(await cookErr({ s: { type: 'sphere' }, b: { type: 'heightfield_blur', in: ['s'] } }, 'b')), 'a non-heightfield input fails with a hint');
  // immutability: the noise result is untouched by everything downstream
  check(same(n.layer('height')!, (await field(nodes, 'n')).layer('height')!) && n.layer('height') === H, 'inputs are never written');
}

// ---------------------------------------------------------------- masks
section('masks');
{
  const slope = async (min: number, max = 90, falloff = 2) => (await field({ ...TILT, m: { type: 'heightfield_mask_by_feature', in: ['t'], params: { feature: 'slope', min_angle: min, max_angle: max, angle_falloff: falloff } } }, 'm')).layer('mask')!;
  check((await slope(15)).every((v) => v === 1), 'slope mask of a 20° plane: all 1 for min 15°');
  check((await slope(25)).every((v) => v === 0), 'slope mask of a 20° plane: all 0 for min 25°');
  check((await slope(0, 10)).every((v) => v === 0), 'slope mask of a 20° plane: all 0 for max 10°');
  const ht = (await field({ ...TILT, m: { type: 'heightfield_mask_by_feature', in: ['t'], params: { feature: 'height', min_height: 0, max_height: 10, height_falloff: 0 } } }, 'm'));
  let okH = true;
  for (let i = 0; i < ht.width; i++) if ((ht.layer('mask')![i] === 1) !== (ht.x(i) * TAN20 >= 0)) okH = false;
  check(okH, 'height mask: 1 exactly where height >= min_height');
  const dir = await field({ ...TILT, m: { type: 'heightfield_mask_by_feature', in: ['t'], params: { feature: 'direction', direction: 180, direction_spread: 30 } } }, 'm');
  const dir0 = await field({ ...TILT, m: { type: 'heightfield_mask_by_feature', in: ['t'], params: { feature: 'direction', direction: 0, direction_spread: 30 } } }, 'm');
  check(dir.layer('mask')!.every((v) => v > 0.99) && dir0.layer('mask')!.every((v) => v === 0), 'direction mask: a plane rising along +X faces −X (180°)');
  const valley: Record<string, NodeSpec> = { hf: HF, v: { type: 'heightfield_layer', in: ['hf'], params: { expression: 'abs(x) * 0.5' } } };
  const cc = await field({ ...valley, m: { type: 'heightfield_mask_by_feature', in: ['v'], params: { feature: 'curvature', curvature_radius: 0.3, curvature_threshold: 0.02 } } }, 'm');
  const cv = await field({ ...valley, m: { type: 'heightfield_mask_by_feature', in: ['v'], params: { feature: 'curvature', curvature_type: 'convex', curvature_radius: 0.3, curvature_threshold: 0.02 } } }, 'm');
  check(cc.layer('mask')![20 * 41 + 20] > 0.9 && cc.layer('mask')![20 * 41 + 5] < 0.01 && cv.layer('mask')![20 * 41 + 20] === 0, 'curvature mask: concave finds the valley floor, convex does not');
  const occ = await field({ ...valley, m: { type: 'heightfield_mask_by_feature', in: ['v'], params: { feature: 'occlusion', occlusion_radius: 1 } } }, 'm');
  check(occ.layer('mask')![20 * 41 + 20] > occ.layer('mask')![20 * 41 + 2] + 0.1, 'occlusion: the valley floor is more occluded than the slope');
  const comb = await field({ ...TILT, a: { type: 'heightfield_mask_by_feature', in: ['t'], params: { feature: 'slope', min_angle: 15 } }, b: { type: 'heightfield_mask_by_feature', in: ['a'], params: { feature: 'height', min_height: 0, height_falloff: 0, mode: 'multiply' } } }, 'b');
  check(sum(comb.layer('mask')!) === sum((await field({ ...TILT, b: { type: 'heightfield_mask_by_feature', in: ['t'], params: { feature: 'height', min_height: 0, height_falloff: 0 } } }, 'b')).layer('mask')!), 'mode multiply combines features');

  const obj = await field({ hf: HF, c: { type: 'curve', params: { points: [[-2, 0, 0], [2, 0, 0]] } }, m: { type: 'heightfield_mask_by_object', in: ['hf', 'c'], params: { distance: 0.5, falloff: 0 } } }, 'm');
  let okO = true;
  for (let j = 0; j < obj.height; j++) for (let i = 0; i < obj.width; i++) if ((obj.layer('mask')![j * obj.width + i] === 1) !== (Math.abs(obj.z(j)) <= 0.5 + 1e-9)) okO = false;
  check(okO, 'mask_by_object distance: 1 within 0.5 m of a line');
  const fp = await field({ hf: HF, b: { type: 'box', params: { size: [1, 1, 1] } }, m: { type: 'heightfield_mask_by_object', in: ['hf', 'b'], params: { distance: 0, falloff: 0 } } }, 'm');
  check(sum(fp.layer('mask')!) === 121, `mask_by_object footprint of a 1 m box: 11 × 11 samples (${sum(fp.layer('mask')!)})`);
  const exp = await field({ hf: HF, one: { type: 'heightfield_layer', in: ['hf'], params: { layer: 'mask', expression: 'i == 20 && j == 20 ? 1 : 0' } }, e: { type: 'heightfield_mask_expand', in: ['one'], params: { distance: 0.5, falloff: 0 } } }, 'e');
  const disc = sum(exp.layer('mask')!);
  check(disc >= 69 && disc <= 89, `mask_expand grows a point into a 0.5 m disc (${disc} samples, π·5² ≈ 79)`);
  const shr = await field({ hf: HF, sq: { type: 'heightfield_layer', in: ['hf'], params: { layer: 'mask', expression: 'abs(x) <= 1.0001 && abs(z) <= 1.0001 ? 1 : 0' } }, e: { type: 'heightfield_mask_expand', in: ['sq'], params: { distance: -0.35, falloff: 0 } } }, 'e');
  check(sum(shr.layer('mask')!) === 15 * 15, `mask_expand −0.35 m shrinks a 21 × 21 square by 3 samples per side (${sum(shr.layer('mask')!)})`);
  const mn = await field({ hf: HF, m: { type: 'heightfield_mask_noise', in: ['hf'], params: { contrast: 3 } } }, 'm');
  check(mn.layer('mask')!.every((v) => v >= 0 && v <= 1) && variance(mn.layer('mask')!) > 0.01, 'mask_noise stays in 0..1');
  const mb = await field({ hf: HF, m: { type: 'heightfield_mask_noise', in: ['hf'], params: { contrast: 3, element_size: 0.5 } }, b: { type: 'heightfield_mask_blur', in: ['m'], params: { radius: 0.3 } } }, 'b');
  check(variance(mb.layer('mask')!) < variance((await field({ hf: HF, m: { type: 'heightfield_mask_noise', in: ['hf'], params: { contrast: 3, element_size: 0.5 } } }, 'm')).layer('mask')!), 'mask_blur smooths the mask');
}

// ---------------------------------------------------------------- erosion
section('erosion');
{
  const rough: Record<string, NodeSpec> = { hf: { type: 'heightfield', params: { size: [8, 8], resolution: 0.1 } }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 1.5, element_size: 3, octaves: 7, roughness: 0.65, range: 'positive', seed: 9 } } };
  const base = await field(rough, 'n');
  const run = async (params: any) => field({ ...rough, e: { type: 'heightfield_erode', in: ['n'], params: { iterations: 25, ...params } } }, 'e');
  const e1 = await run({ seed: 1 });
  engine.cache.clear();
  const e2 = await run({ seed: 1 });
  const e3 = await run({ seed: 2 });
  check(e1.layer('height') !== e2.layer('height') && same(e1.layer('height')!, e2.layer('height')!) && same(e1.layer('flow')!, e2.layer('flow')!), 'erosion is deterministic (fresh cook, identical layers)');
  check(maxDiff(e1.layer('height')!, e3.layer('height')!) > 1e-3, 'another seed erodes differently');
  check(['flow', 'sediment', 'debris', 'water'].every((n) => e1.layers.has(n)), 'erosion writes flow, sediment, debris, water');
  check(e1.layer('flow')!.every((v) => v >= 0 && v <= 1) && e1.layer('water')!.every((v) => v >= 0 && v <= 1), 'flow and water are 0..1');
  check(e1.layer('sediment')!.every((v) => v >= 0) && Math.max(...e1.layer('sediment')!) > 0.01 && e1.layer('debris')!.every((v) => v >= 0), 'sediment and debris are non-negative thicknesses');
  const changed = maxDiff(e1.layer('height')!, base.layer('height')!);
  check(changed > 0.01, `erosion changes the terrain (max ${changed.toFixed(3)} m)`);
  const m0 = sum(base.layer('height')!), noEvap = await run({ evaporation: 0, boundary: 'closed' });
  const m1 = sum(noEvap.layer('height')!);
  check(Math.abs(m1 - m0) / m0 < 0.01, `mass is conserved with closed boundaries, no evaporation (${m0.toFixed(2)} → ${m1.toFixed(2)}, ${(((m1 - m0) / m0) * 100).toFixed(4)} %)`);
  const mDef = sum(e1.layer('height')!);
  check(Math.abs(mDef - m0) / m0 < 0.01, `mass is conserved with the default (closed) boundary (${(((mDef - m0) / m0) * 100).toFixed(4)} %)`);
  const open = await run({ boundary: 'open' });
  check(sum(open.layer('height')!) <= m0 + 1e-6, 'open boundaries lose material at the border');
  const roughness = (h: Float32Array, w: number) => { const b = blurGrid(h, w, h.length / w, 2, 'box'); let s = 0; for (let k = 0; k < h.length; k++) s += Math.abs(h[k] - b[k]); return s / h.length; };
  const r0 = roughness(base.layer('height')!, base.width), r1 = roughness(e1.layer('height')!, e1.width);
  check(r1 < r0, `erosion reduces roughness (mean |h − blur(h)| ${r0.toFixed(4)} → ${r1.toFixed(4)})`);
  const th = await run({ rain_density: 0, thermal_rate: 0.5, thermal_talus_angle: 30 });
  const slopeMax = (hf: Heightfield) => { let m = 0; const H = hf.layer('height')!; for (let j = 0; j < hf.height; j++) for (let i = 0; i + 1 < hf.width; i++) m = Math.max(m, Math.abs(H[j * hf.width + i + 1] - H[j * hf.width + i]) / hf.cellSize); return m; };
  check(slopeMax(th) < slopeMax(base) && sum(th.layer('debris')!) > 0 && th.layer('flow')!.every((v) => v === 0), `thermal erosion alone flattens the steepest slopes (${slopeMax(base).toFixed(2)} → ${slopeMax(th).toFixed(2)}) and writes debris`);
  const frozen = await field({ ...rough, f: { type: 'heightfield_layer', in: ['n'], params: { layer: 'rock', expression: 'x < 0 ? 1 : 0' } }, e: { type: 'heightfield_erode', in: ['f'], params: { iterations: 10, freeze_layer: 'rock' } } }, 'e');
  let frozenOk = true;
  const F = frozen.layer('rock')!, FH = frozen.layer('height')!, BH = base.layer('height')!;
  for (let k = 0; k < F.length; k++) if (F[k] === 1 && Math.abs(FH[k] - BH[k]) > 1e-6) {
    // a frozen sample may still receive the final load of a droplet that dies on it; erosion itself never touches it
    if (FH[k] < BH[k] - 1e-6) frozenOk = false;
  }
  check(frozenOk, 'freeze_layer: frozen samples are never eroded');
  const hard = await field({ ...rough, f: { type: 'heightfield_layer', in: ['n'], params: { layer: 'rock', operation: 'fill', value: 1 } }, e: { type: 'heightfield_erode', in: ['f'], params: { iterations: 10, hardness_layer: 'rock', thermal_rate: 0 } } }, 'e');
  check(sum(hard.layer('sediment')!) < sum((await run({ iterations: 10, thermal_rate: 0 })).layer('sediment')!) * 0.2, 'hardness 1 stops hydraulic erosion');

  // the kernel interface directly, and its speed target: 512² × 100 iterations
  const N = 512, cell = 0.1;
  const nz = fractal(makeNoise('simplex', 1), { octaves: 6 });
  const h = new Float64Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) h[j * N + i] = (nz(i * cell * 0.1, 0, j * cell * 0.1) * 0.5 + 0.5) * 5;
  const f = makeErosionField(N, N, cell, h);
  const t0 = performance.now();
  const r = rng(1);
  for (let it = 0; it < 100; it++) erodeStep(f, DEFAULT_EROSION, r);
  const ms = performance.now() - t0;
  console.log(`     erosion 512² × 100 iterations: ${ms.toFixed(0)} ms (${Math.round(DEFAULT_EROSION.rainDensity * N * N * 100).toLocaleString('en-US')} droplets)`);
  check(Math.abs(sum(f.h) - sum(h)) / sum(h) < 1e-9, 'erodeStep conserves mass exactly (closed boundary)');
  check(ms < 20000, `erosion 512² × 100 finishes (target < 3 s; ${ms.toFixed(0)} ms here)`);
}

// ---------------------------------------------------------------- project, path, scatter
section('project, path, scatter, resample, transform, to_sdf');
{
  const nodes: Record<string, NodeSpec> = { hf: HF, n: NOISE(6) };
  const n = await field(nodes, 'n');
  const pr = await field({ ...nodes, b: { type: 'box', params: { size: [1, 1, 1], center: [0, 1.5, 0] } }, p: { type: 'heightfield_project', in: ['n', 'b'], params: { radius: 0.5, mask_layer: 'stamp' } } }, 'p');
  const k0 = 20 * 41 + 20;
  check(Math.abs(pr.layer('height')![k0] - 2) < 1e-6 && pr.layer('stamp')![k0] === 1, 'project replace: the footprint takes the box top (2 m)');
  check(Math.abs(pr.layer('height')![0] - n.layer('height')![0]) < 1e-9 && pr.layer('stamp')![0] === 0, 'project leaves samples beyond the radius alone');
  const lo = await field({ ...nodes, b: { type: 'box', params: { size: [1, 1, 1], center: [0, -3, 0] } }, p: { type: 'heightfield_project', in: ['n', 'b'], params: { mode: 'max', radius: 0 } } }, 'p');
  check(same(lo.layer('height')!, n.layer('height')!), 'project max never lowers');
  const ridge = await field({ ...nodes, c: { type: 'curve', params: { points: [[-1, 1, 0], [1, 1, 0]] } }, p: { type: 'heightfield_project', in: ['n', 'c'], params: { width: 0.4, radius: 0 } } }, 'p');
  check(Math.abs(ridge.layer('height')![k0] - 1) < 1e-6, 'project stamps curves at their own height');

  const road = await field({ ...nodes, c: { type: 'curve', params: { points: [[-1.5, 1, 0], [1.5, 1, 0]] } }, r: { type: 'heightfield_path', in: ['n', 'c'], params: { height_mode: 'curve', width: 0.6, shoulder: 0.3, smooth: 0 } } }, 'r');
  let flat = 0, inPath = 0;
  for (let j = 0; j < road.height; j++) for (let i = 0; i < road.width; i++) {
    const x = road.x(i), z = road.z(j), k = j * road.width + i;
    if (Math.abs(z) <= 0.29 && Math.abs(x) <= 1.5) { inPath++; flat = Math.max(flat, Math.abs(road.layer('height')![k] - 1)); }
  }
  check(inPath > 0 && flat < 1e-5, `path (curve height): flat at the curve's Y across the road (max error ${flat.toExponential(1)})`);
  check(road.layer('path')![k0] === 1 && road.layer('path')![0] === 0, 'path writes the road into the "path" mask');
  check(Math.abs(road.layer('height')![0] - n.layer('height')![0]) < 1e-9, 'path leaves the terrain beyond the shoulder');
  const along = await field({ ...nodes, c: { type: 'curve', params: { points: [[-1.8, 0, 0.3], [1.8, 0, 0.3]] } }, r: { type: 'heightfield_path', in: ['n', 'c'], params: { width: 0.4, shoulder: 0.3, smooth: 1.5 } } }, 'r');
  const prof = (hf: Heightfield) => Array.from({ length: hf.width }, (_, i) => hf.layer('height')![23 * hf.width + i]);
  const rough1 = (a: number[]) => a.slice(1).reduce((s, v, i) => s + Math.abs(v - a[i]), 0);
  check(rough1(prof(along)) < rough1(prof(n)) * 0.7, `path (terrain): the road profile is smoothed along the curve (${rough1(prof(n)).toFixed(3)} → ${rough1(prof(along)).toFixed(3)})`);
  const bank = await field({ ...nodes, c: { type: 'circle', params: { radius: 1.2, segments: 64, open: true } }, r: { type: 'heightfield_path', in: ['n', 'c'], params: { width: 0.6, shoulder: 0.2, height_mode: 'curve', bank: 10, smooth: 0 } } }, 'r');
  const inner = bank.sample(0, 1.0), outer = bank.sample(0, 1.4);
  check(Math.abs(outer - inner) > 0.03, `bank tilts the road across a bend (inner ${inner.toFixed(3)}, outer ${outer.toFixed(3)})`);

  const half: Record<string, NodeSpec> = { ...nodes, m: { type: 'heightfield_layer', in: ['n'], params: { layer: 'mask', expression: 'x < 0 ? 1 : 0' } }, s: { type: 'heightfield_scatter', in: ['m'], params: { density: 6, seed: 3 } } };
  const pts = await geo(half, 's');
  const hm = await field(half, 'm');
  let onSurface = 0, inMask = true, unit = true;
  const P = pts.P, NN = pts.points.get('N')!.data as Float64Array;
  for (let i = 0; i < pts.numPoints; i++) {
    onSurface = Math.max(onSurface, Math.abs(P[i * 3 + 1] - hm.sample(P[i * 3], P[i * 3 + 2])));
    if (P[i * 3] > hm.cellSize * 0.5 + 1e-9) inMask = false;
    if (Math.abs(Math.hypot(NN[i * 3], NN[i * 3 + 1], NN[i * 3 + 2]) - 1) > 1e-6 || NN[i * 3 + 1] <= 0) unit = false;
  }
  const expect = 6 * 2 * 4;
  check(pts.numPoints > expect * 0.85 && pts.numPoints < expect * 1.15, `scatter count ≈ density × masked area (${pts.numPoints}, expected ~${expect})`);
  check(onSurface < 1e-3, `scatter points lie on the surface (max |y − sample| ${onSurface.toExponential(1)})`);
  check(inMask, 'scatter respects the mask (no points where mask = 0)');
  check(unit && pts.points.has('slope') && pts.points.has('height') && pts.points.has('mask'), 'scatter writes unit up-facing N, height, slope, mask');
  const cnt = await geo({ ...half, s: { type: 'heightfield_scatter', in: ['m'], params: { count: 25, relax: false } } }, 's');
  check(cnt.numPoints === 25, 'scatter count overrides density');

  const rs = await field({ ...nodes, r: { type: 'heightfield_resample', in: ['n'], params: { factor: 2 } } }, 'r');
  let rsErr = 0;
  for (let j = 0; j < n.height; j++) for (let i = 0; i < n.width; i++) rsErr = Math.max(rsErr, Math.abs(rs.layer('height')![(2 * j) * rs.width + 2 * i] - n.layer('height')![j * n.width + i]));
  check(rs.width === 81 && rs.height === 81 && rs.cellSize === 0.05 && rsErr < 1e-6, 'resample ×2 keeps the extent and the original samples');
  const ue = await field({ hf: { type: 'heightfield', params: { size: [50, 50], resolution: 0.25 } }, r: { type: 'heightfield_resample', in: ['hf'], params: { samples: [253, 253] } } }, 'r');
  check(ue.width === 253 && ue.height === 253 && Math.abs(ue.sizeX - 50) < 1e-9, 'resample to an Unreal size (253 × 253) over the same 50 m');

  const tr = await field({ ...nodes, t: { type: 'heightfield_transform', in: ['n'], params: { translate: [5, 1, -2], height_scale: 2 } } }, 't');
  check(Math.abs(tr.center[0] - 5) < 1e-9 && Math.abs(tr.center[1] + 2) < 1e-9 && Math.abs(tr.sample(5.3, -1.6) - (2 * n.sample(0.3, 0.4) + 1)) < 1e-5, 'transform: translate moves the grid and raises; height_scale scales');
  const rot = await field({ ...nodes, t: { type: 'heightfield_transform', in: ['n'], params: { rotate: 90 } } }, 't');
  // R_y(90°): (x, z) → (z, −x); a point p of the result samples the source at R⁻¹ p = (−z, x)
  check(Math.abs(rot.sample(0.7, -0.4) - n.sample(0.4, 0.7)) < 1e-6, 'transform rotate 90° re-grids the layers');
  const gen = await field({ ...nodes, t: { type: 'transform', in: ['n'], params: { translate: [1, 2, 3], scale: [2, 1, 2] } } }, 't');
  check(Math.abs(gen.cellSize - 0.2) < 1e-12 && Math.abs(gen.center[0] - 1) < 1e-9 && Math.abs(gen.sample(1 + 0.6, 3 + 0.8) - (n.sample(0.3, 0.4) + 2)) < 1e-5, 'the generic transform node moves and scales heightfields');

  const sdf = await geo({ ...nodes, s: { type: 'heightfield_to_sdf', in: ['n'] } }, 's');
  const vol = sdf.volumes[0];
  const above = vol.kind === 'sdf' ? vol.sample(0.3, n.sample(0.3, 0.2) + 0.5, 0.2) : NaN, below = vol.kind === 'sdf' ? vol.sample(0.3, n.sample(0.3, 0.2) - 0.5, 0.2) : NaN;
  const onSurf = vol.kind === 'sdf' ? vol.sample(0.3, n.sample(0.3, 0.2), 0.2) : NaN;
  check(above > 0.05 && below < -0.05 && Math.abs(onSurf) < 1e-6, `to_sdf: positive above the surface, negative below, 0 on it (${above.toFixed(3)}, ${below.toFixed(3)})`);
  const solid = await geo({ ...nodes, s: { type: 'heightfield_to_sdf', in: ['n'] }, m: { type: 'sdf_to_mesh', in: ['s'], params: { divisions: 48 } } }, 'm');
  check(topologyReport(solid).closed && solid.bbox().max[1] > 0.2, 'to_sdf → sdf_to_mesh gives a watertight terrain block');
}

// ---------------------------------------------------------------- PNG decoder, export, import
section('heightmap export and PNG decoding');
{
  const g = await geo({ hf: HF, n: NOISE(8, { range: 'positive' }), m: { type: 'heightfield_mask_by_feature', in: ['n'], params: { min_angle: 15 } } }, 'm');
  const hf = heightfieldsOf(g)[0];
  const H = hf.layer('height')!;
  const st = { min: Math.min(...H), max: Math.max(...H) };
  const res = heightmapExport(g, 'png16', { deflate: (d) => zlib.deflateSync(d) });
  const img = decodePNG(res.files[0].bytes);
  check(img.width === hf.width && img.height === hf.height && img.channels === 1 && img.bitDepth === 16, 'png16: a 16-bit grey PNG of the field size');
  const span = st.max - st.min;
  let rt = 0;
  for (let k = 0; k < H.length; k++) rt = Math.max(rt, Math.abs(st.min + (img.data[k] / 65535) * span - H[k]));
  check(rt <= span / 65535 + 1e-6, `png16 round trip within 1/65535 of the range (max error ${rt.toExponential(2)}, step ${(span / 65535).toExponential(2)})`);
  const side = JSON.parse(new TextDecoder().decode(res.files[1].bytes));
  check(res.files[1].kind === 'sidecar' && side.height_min === st.min && side.height_max === st.max, 'sidecar records height_min / height_max');
  check(Math.abs(side.unreal.scale[2] - (span * 12800) / 65535) < 1e-5 && side.unreal.scale[0] === 10, `sidecar Unreal Z scale = range × 12800 / 65535 (${side.unreal.scale[2]}), XY = cell × 100 cm`);
  const zcm = (v: number) => side.unreal.location_cm[2] + ((v - 32768) * side.unreal.scale[2]) / 128;
  check(Math.abs(zcm(0) - st.min * 100) < 0.01 && Math.abs(zcm(65535) - st.max * 100) < 0.01, 'Unreal location/scale map 0 → height_min and 65535 → height_max (cm)');
  const stored = heightmapExport(g, 'png16');
  check(same(decodePNG(stored.files[0].bytes).data, img.data), 'png16 without a compressor (stored zlib blocks) decodes the same');
  const fixed = heightmapExport(g, 'png16', { heightMin: -1, heightMax: 3 });
  check(JSON.parse(new TextDecoder().decode(fixed.files[1].bytes)).height_min === -1, 'a fixed height range is honoured');
  const r16 = heightmapExport(g, 'r16');
  check(r16.files[0].bytes.length === hf.width * hf.height * 2, `r16 size = w × h × 2 (${r16.files[0].bytes.length})`);
  const q = quantize16(H, st.min, st.max), rb = r16.files[0].bytes;
  let r16ok = true;
  for (let k = 0; k < q.length; k++) if ((rb[k * 2] | (rb[k * 2 + 1] << 8)) !== q[k]) r16ok = false;
  check(r16ok, 'r16 is little-endian uint16, row-major');
  const masks = heightmapExport(g, 'mask_png', { layers: ['mask', 'height'] });
  const mi = decodePNG(masks.files[0].bytes);
  check(masks.files.length === 2 && mi.bitDepth === 8 && mi.channels === 1 && mi.data[0] === Math.round(Math.max(0, Math.min(1, hf.layer('mask')![0])) * 255), 'mask_png: one 8-bit grey PNG per layer');
  check(heightmapPaths('out/t.png', masks.files).join() === 'out/t_mask.png,out/t_height.png' && heightmapPaths('out/t.png', res.files).join() === 'out/t.png,out/t.json', 'output paths: sidecar .json, one file per mask layer');
  check(exportGeometry(g, 'png16').length === stored.files[0].bytes.length, 'exportGeometry png16 wiring');
  let msg = '';
  try { exportGeometry(new Geometry({ positions: [0, 0, 0] }), 'png16'); } catch (e: any) { msg = e.message; }
  check(/no heightfield/.test(msg), `export of a geometry without a heightfield gives a clear error ("${msg.slice(0, 60)}…")`);

  // PNG decoder on other encodings
  const rgba = new Uint8Array(7 * 5 * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) & 255;
  for (const level of [0, 1, 9]) {
    const png = encodePNG(rgba, 7, 5, (d) => zlib.deflateSync(d, { level }));
    const d = decodePNG(png);
    check(d.channels === 4 && same(d.data, rgba), `decode RGBA8 PNG (zlib level ${level})`);
  }
  check(same(inflateZlib(zlib.deflateSync(Buffer.from('heightfield '.repeat(500)))), new TextEncoder().encode('heightfield '.repeat(500))), 'inflate: repeated text (back references)');
  check(same(inflateZlib(zlibStored(rgba)), rgba), 'inflate: stored blocks');
  const big = new Uint8Array(200000);
  for (let i = 0; i < big.length; i++) big[i] = (i * i) >> 7 & 255;
  check(same(inflateZlib(zlibStored(big)), big) && same(inflateZlib(zlib.deflateSync(big)), big), 'inflate: multi-block stored and dynamic Huffman data');
  const g8 = new Uint8Array(9 * 3);
  for (let i = 0; i < g8.length; i++) g8[i] = i * 9;
  check(same(pngChannel(decodePNG(encodeGreyPNG(g8, 9, 3, 8)), 'luminance'), Array.from(g8, (v) => Math.fround(v / 255))), 'decode 8-bit grey; pngChannel → 0..1');
  let bad = '';
  try { decodePNG(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])); } catch (e: any) { bad = e.message; }
  check(/not a PNG/.test(bad), 'decoder rejects non-PNG data');

  // from_image round trip through a file, using the sidecar numbers
  const file = path.join(tmp, 'hm.png');
  fs.writeFileSync(file, res.files[0].bytes);
  const back = await field({ im: { type: 'heightfield_from_image', params: { path: file, resolution: hf.cellSize, height_min: side.height_min, height_max: side.height_max } } }, 'im');
  check(back.width === hf.width && back.height === hf.height && maxDiff(back.layer('height')!, H) <= span / 65535 + 1e-5, 'heightfield_from_image(export png16) reproduces the field');
  const into = await field({ hf: HF, im: { type: 'heightfield_from_image', in: ['hf'], params: { path: file, layer: 'snow', height_min: 0, height_max: 1 } } }, 'im');
  check(into.layer('snow')!.length === into.count && into.layers.has('height') && Math.abs(into.layer('snow')![5] - (H[5] - st.min) / span) < 1e-4, 'from_image into an existing field writes the named layer');
  check(/cannot read/.test(await cookErr({ im: { type: 'heightfield_from_image', params: { path: path.join(tmp, 'missing.png') } } }, 'im')), 'from_image: a missing file is a clear error');
}

// ---------------------------------------------------------------- render, inspect, fingerprint, MCP
section('render, inspect, fingerprints, MCP export');
{
  const nodes: Record<string, NodeSpec> = { hf: HF, n: NOISE(2), m: { type: 'heightfield_mask_by_feature', in: ['n'], params: { min_angle: 20 } } };
  const g = await geo(nodes, 'm');
  const img = renderGeometry(g, { views: ['top'], size: 128 });
  let lo = 255, hi = 0;
  for (let y = 40; y < 90; y++) for (let x = 40; x < 90; x++) { const v = img.rgba[(y * img.width + x) * 4]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  check(!img.notes.some((n) => /SDF/.test(n)) && hi - lo > 40, 'render draws a heightfield as its shaded preview mesh (mask in red)');
  const lay = renderGeometry(g, { views: ['top'], size: 128, colorBy: 'mask' });
  check(lay.notes.some((n) => /color by mask/.test(n)), 'render color_by a layer');
  const s = summarize(g);
  check(/1 heightfield\(s\)/.test(s) && /heightfield "heightfield": 41×41 samples, cell 0.10 m/.test(s) && /mask \[/.test(s), 'inspect summary lists the heightfield and its layers');
  const fp1 = fingerprint(g), fp2 = fingerprint(g.clone());
  check(JSON.stringify(fp1) === JSON.stringify(fp2) && !!fp1.volumes?.[0].layers?.mask, 'fingerprint: grid + per-layer hashes, stable over clone');
  const c = g.clone();
  const hf = heightfieldsOf(c)[0];
  hf.writable('mask')[100] += 0.5;
  const fp3 = fingerprint(c);
  check(fp3.volumes![0].layers!.mask !== fp1.volumes![0].layers!.mask && fp3.volumes![0].layers!.height === fp1.volumes![0].layers!.height, 'fingerprint changes when (only) a layer changes');

  const wsDir = path.join(tmp, 'ws');
  const ws = new Workspace(wsDir, engine);
  ws.load();
  const tools = makeTools(ws);
  const call = async (name: string, a: any) => {
    const r = await tools.find((t) => t.name === name)!.run(a);
    return { txt: r.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n'), isError: !!r.isError };
  };
  const b = await call('build', { graph: { nodes, output: 'm' } });
  check(!b.isError && /heightfield "heightfield"/.test(b.txt), 'MCP build summary lists the heightfield');
  const ex = await call('export', { path: 'exports/terrain.png' });
  check(!ex.isError && fs.existsSync(path.join(wsDir, 'exports', 'terrain.png')) && fs.existsSync(path.join(wsDir, 'exports', 'terrain.json')) && /Unreal: scale/.test(ex.txt), 'MCP export .png → png16 + JSON sidecar with the Unreal numbers');
  const exr = await call('export', { path: 'exports/terrain.r16' });
  check(!exr.isError && fs.statSync(path.join(wsDir, 'exports', 'terrain.r16')).size === 41 * 41 * 2, 'MCP export .r16');
  const exm = await call('export', { path: 'exports/w.png', format: 'mask_png', layers: ['mask', 'height'] });
  check(!exm.isError && fs.existsSync(path.join(wsDir, 'exports', 'w_mask.png')) && fs.existsSync(path.join(wsDir, 'exports', 'w_height.png')), 'MCP export mask_png writes one PNG per layer');
  await call('build', { graph: { nodes: { s: { type: 'sphere' } } } });
  let threw = '';
  try { await call('export', { path: 'exports/nope.png' }); } catch (e: any) { threw = e.message; }
  check(/no heightfield/.test(threw), 'MCP export png16 of a mesh: clear error');
  const dt = distanceTransform(Uint8Array.from([0, 0, 1, 0, 0]), 5, 1);
  check(same(dt.d2, [4, 1, 0, 1, 4]) && same(dt.nearest, [2, 2, 2, 2, 2]), 'distance transform (exact, with nearest site)');
}

console.log(`\nheightfield: ${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
