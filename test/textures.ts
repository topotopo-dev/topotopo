// Behavioural tests for procedural textures and bakes (P3-T): image volumes, generators (deterministic, tileable),
// filters (blend modes, blur, normals), bakes (AO, curvature, padding, islands, normals from a high mesh), material
// linkage, exports (glTF embeds PNGs and validates, USD writes files, the textures format), the texture view and
// texture sampling in the renderer, JSON round trips, fingerprints, and pool on/off equality.
//   node test/textures.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { Image, findImage, imageToBytes, imagesOf, resizeLayer } from '../src/core/image.ts';
import { texNoise } from '../src/core/texnoise.ts';
import { blendLayers, blurLayer, genPattern } from '../src/core/texture.ts';
import { readMaterials } from '../src/core/materials.ts';
import { allNodeDefs, getNodeDef } from '../src/graph/registry.ts';
import { geoFromJSON, geoToJSON } from '../src/io/json.ts';
import { exportGeometryAsync } from '../src/io/export.ts';
import { exportFilesAsync } from '../src/io/files.ts';
import { decodePNG } from '../src/io/png-decode.ts';
import { renderGeometry } from '../src/render/raster.ts';
import { renderArgs } from '../src/render/options.ts';
import { summarize } from '../src/inspect.ts';
import { explainGeometry } from '../src/explain.ts';
import { fingerprint } from './fingerprint.ts';
import type { NodeSpec } from '../src/graph/types.ts';

const require = createRequire(import.meta.url);
const validator = require('gltf-validator');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polyforge-tex-'));
const engine = new Engine(createNodeHost({ baseDir: tmp }));
await engine.init();

let fail = 0, pass = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (ok) pass++; else fail++;
};
const section = (s: string) => console.log(`\n== ${s}`);
const f3 = (x: number) => x.toFixed(3);

async function cookOn(e: Engine, nodes: Record<string, NodeSpec>, output?: string): Promise<{ geo: Geometry; stats: Record<string, number>; warnings: string[] }> {
  const r = await e.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')}`);
  const res = r.results.get(r.target)!;
  return { geo: r.geo, stats: (res as any).stats ?? {}, warnings: r.warnings.map((w) => w.message) };
}
const geo = async (nodes: Record<string, NodeSpec>, output?: string) => (await cookOn(engine, nodes, output)).geo;
async function image(nodes: Record<string, NodeSpec>, output?: string, name = ''): Promise<Image> {
  const g = await geo(nodes, output);
  const img = findImage(g, name);
  if (!img) throw new Error(`no image${name ? ` "${name}"` : ''} in the output`);
  return img;
}
async function cookErr(nodes: Record<string, NodeSpec>, output?: string): Promise<string> {
  const r = await engine.cook({ nodes, output });
  return r.ok ? '' : r.errors.map((e) => e.message + (e.hint ? ` (${e.hint})` : '')).join('; ');
}
const mean = (a: ArrayLike<number>, ch = 1, c = 0, sel?: (i: number) => boolean) => {
  let s = 0, n = 0;
  for (let i = 0; i < a.length / ch; i++) { if (sel && !sel(i)) continue; s += a[i * ch + c]; n++; }
  return n ? s / n : NaN;
};
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
/** Mean jump across the left/right seam vs the mean jump between neighbouring columns (≈ 1 for a seamless image). */
function seamRatio(a: Float32Array, w: number, h: number): number {
  let seam = 0, inner = 0;
  for (let j = 0; j < h; j++) {
    seam += Math.abs(a[j * w] - a[j * w + w - 1]);
    for (let i = 0; i + 1 < w; i++) inner += Math.abs(a[j * w + i] - a[j * w + i + 1]);
  }
  return seam / h / (inner / (h * (w - 1)) || 1e-9);
}

// ---------------------------------------------------------------- registry

section('registry: texture nodes');
const TEX_TYPES = allNodeDefs().filter((d) => d.category === 'texture').map((d) => d.type);
check(TEX_TYPES.length >= 35, `${TEX_TYPES.length} nodes in category texture`);
for (const t of ['tex_noise', 'tex_pattern', 'tex_gradient', 'tex_shape', 'tex_cells', 'tex_splatter', 'tex_scratches', 'tex_text', 'tex_blend', 'tex_levels', 'tex_curves', 'tex_blur', 'tex_warp', 'tex_transform', 'tex_edge_detect', 'tex_invert', 'tex_threshold', 'tex_histogram_scan', 'tex_normal_from_height', 'tex_height_to_ao', 'tex_channel', 'tex_colorize', 'tex_tile_sampler', 'tex_output', 'texture_to_material', 'tex_to_heightfield', 'heightfield_to_tex', 'bake_ao', 'bake_curvature', 'bake_thickness', 'bake_position', 'bake_normal', 'bake_world_normal', 'bake_island_id', 'bake_mask', 'bake_vertex_color', 'bake_height'])
  if (!TEX_TYPES.includes(t)) check(false, `missing node ${t}`);
check(getNodeDef('tilesampler')?.type === 'tex_tile_sampler' && getNodeDef('histogram_scan')?.type === 'tex_histogram_scan' && getNodeDef('gradient_map')?.type === 'tex_colorize', 'Substance / COP names resolve as aliases');
{
  // aliases must not shadow another node, and a param alias must not shadow another param of the same node
  const bad: string[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
  for (const t of TEX_TYPES) {
    const d = getNodeDef(t)!;
    for (const a of d.aliases ?? []) if (getNodeDef(a)?.type !== t) bad.push(`${t} alias ${a} → ${getNodeDef(a)?.type}`);
    const names = new Map<string, string>();
    for (const [n, pd] of Object.entries(d.params)) {
      for (const k of [n, ...(pd.aliases ?? [])]) {
        const o = names.get(norm(k));
        if (o && o !== n) bad.push(`${t}.${n}: "${k}" also names ${o}`);
        names.set(norm(k), n);
      }
      if (pd.default === undefined || !pd.desc) bad.push(`${t}.${n}: needs a default and a desc`);
    }
  }
  check(!bad.length, `aliases and params are unambiguous${bad.length ? ': ' + bad.slice(0, 6).join('; ') : ''}`);
}
{
  // every node's example cooks
  const failed: string[] = [];
  for (const t of TEX_TYPES) {
    const ex: any = getNodeDef(t)!.example;
    if (!ex) continue;
    const graph = ex.nodes ? ex : { nodes: { x: ex }, output: 'x' };
    const r = await engine.cook(structuredClone(graph));
    if (!r.ok) failed.push(`${t}: ${r.errors.map((e) => e.message).join('; ')}`);
  }
  check(!failed.length, `node examples cook${failed.length ? ': ' + failed.join(' | ') : ''}`);
}

// ---------------------------------------------------------------- generators

section('generators: deterministic, seeded, tileable');
{
  const a = await image({ n: { type: 'tex_noise', params: { resolution: 64, seed: 3 } } });
  const b = await image({ n: { type: 'tex_noise', params: { resolution: 64, seed: 3 } } });
  const c = await image({ n: { type: 'tex_noise', params: { resolution: 64, seed: 4 } } });
  check(maxDiff(a.layer('C')!, b.layer('C')!) === 0, 'tex_noise: the same seed gives the same pixels');
  check(maxDiff(a.layer('C')!, c.layer('C')!) > 0.05, 'tex_noise: another seed gives other pixels');
  check(a.width === 64 && a.height === 64 && a.layer('C')!.length === 64 * 64, 'tex_noise: grey layer C of resolution²');
  // periodic in u and v: the noise function itself repeats at u + 1 (every basis, every fractal mode)
  for (const noise of ['perlin', 'simplex', 'value', 'worley'] as const)
    for (const fractal of ['fbm', 'ridged'] as const) {
      const o = { noise, fractal, scale: 3.4, octaves: 4, roughness: 0.5, lacunarity: 2.1, seed: 5, tileable: true, offset: [0.3, 0.7] as [number, number], aspect: 0.5, jitter: 1 };
      const f = texNoise(o), g = texNoise({ ...o, tileable: false });
      let d = 0, dn = 0;
      for (let k = 0; k < 50; k++) {
        const u = (k * 0.137) % 1, v = (k * 0.291) % 1;
        d = Math.max(d, Math.abs(f(u, v) - f(u + 1, v)), Math.abs(f(u, v) - f(u, v + 1)));
        dn = Math.max(dn, Math.abs(g(u, v) - g(u + 1, v)));
      }
      check(d < 1e-6 && dn > 1e-3, `${noise} ${fractal}: tileable repeats at u+1 and v+1 (max diff ${d.toExponential(1)}), not tileable does not (${f3(dn)})`);
    }
  const tile = await image({ n: { type: 'tex_noise', params: { resolution: [96, 48], scale: 5 } } });
  const free = await image({ n: { type: 'tex_noise', params: { resolution: [96, 48], scale: 5, tileable: false } } });
  const rT = seamRatio(tile.layer('C')!, 96, 48), rF = seamRatio(free.layer('C')!, 96, 48);
  check(rT < 2 && rF > 3 * rT, `tex_noise image: seam jump / neighbour jump ${f3(rT)} tileable vs ${f3(rF)} not`);
  const cells = await image({ n: { type: 'tex_cells', params: { resolution: 96, scale: 6, output: 'distance' } } });
  check(seamRatio(cells.layer('C')!, 96, 96) < 2, `tex_cells tileable (seam ratio ${f3(seamRatio(cells.layer('C')!, 96, 96))}); id layer per cell`);
  const pat = genPattern({ pattern: 'bricks', count: [4, 8], offset: 0.5, gap: 0.08, bevel: 0.1, variation: 0, seed: 0 }, 128, 128);
  check(seamRatio(pat.C, 128, 128) < 2, `tex_pattern bricks (even rows) tile across the border (seam ratio ${f3(seamRatio(pat.C, 128, 128))})`);
  const checker = genPattern({ pattern: 'checker', count: [4, 4], offset: 0.5, gap: 0, bevel: 0, variation: 0, seed: 0 }, 64, 64);
  check(checker.C[0] === 0 && checker.C[16] === 1 && checker.C[16 * 64] === 1 && checker.C[16 * 64 + 16] === 0, 'tex_pattern checker alternates (offset does not stagger it)');
  const bricks = await image({ n: { type: 'tex_pattern', params: { resolution: 128, gap: 0.3, bevel: 0 } } });
  const C = bricks.layer('C')!, id = bricks.layer('id')!;
  check(C[0] < 0.01 && C[(8 + 0) * 128 + 16] > 0.99, 'bricks: 0 in the mortar, 1 on a brick');
  check(new Set(Array.from(id, (x) => x.toFixed(6))).size >= 20, 'bricks: id layer has a value per brick');
  const shp = await image({ n: { type: 'tex_shape', params: { resolution: 64, shape: 'disc', size: 0.5 } } });
  check(shp.layer('C')![32 * 64 + 32] === 1 && shp.layer('C')![0] === 0, 'tex_shape: 1 inside the disc, 0 in the corner');
  const sp1 = await image({ n: { type: 'tex_splatter', params: { resolution: 64, seed: 2 } } }), sp2 = await image({ n: { type: 'tex_splatter', params: { resolution: 64, seed: 2 } } });
  check(maxDiff(sp1.layer('C')!, sp2.layer('C')!) === 0 && mean(sp1.layer('C')!) > 0.01, 'tex_splatter deterministic and non-empty');
  const txt = await image({ n: { type: 'tex_text', params: { resolution: [128, 32], text: 'AB', size: 0.8 } } });
  check(mean(txt.layer('C')!) > 0.03 && mean(txt.layer('C')!) < 0.6, `tex_text fills glyphs (coverage ${f3(mean(txt.layer('C')!))})`);
  const grad = await image({ n: { type: 'tex_gradient', params: { resolution: [64, 8] } } });
  check(grad.layer('C')![0] < 0.05 && grad.layer('C')![63] > 0.95, 'tex_gradient linear runs 0 → 1 left to right');
  check((await cookErr({ n: { type: 'tex_noise', params: { resolution: [8192, 8192] } } })).includes('too large'), 'oversized images fail with a readable error');
}

// ---------------------------------------------------------------- filters

section('filters: blend modes, levels, blur, normals');
{
  const A = new Float32Array([0.5, 0.25, 0.8, 0.0]), B = new Float32Array([0.4, 0.5, 0.5, 1.0]);
  const bl = (mode: string, op = 1, clamp = true) => Array.from(blendLayers(A, 1, B, 1, null, mode, op, clamp).data, (x) => +x.toFixed(4));
  const eq = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-4);
  check(eq(bl('multiply'), [0.2, 0.125, 0.4, 0]), 'multiply: a × b');
  check(eq(bl('screen'), [0.7, 0.625, 0.9, 1]), 'screen: 1 − (1 − a)(1 − b)');
  check(eq(bl('add'), [0.9, 0.75, 1, 1]) && eq(bl('add', 1, false), [0.9, 0.75, 1.3, 1]), 'add (clamped, and unclamped)');
  check(eq(bl('overlay'), [0.4, 0.25, 0.8, 0]), 'overlay: 2ab below 0.5, screen-like above');
  check(eq(bl('min'), [0.4, 0.25, 0.5, 0]) && eq(bl('max'), [0.5, 0.5, 0.8, 1]) && eq(bl('difference'), [0.1, 0.25, 0.3, 1]), 'min, max, difference');
  check(eq(bl('normal', 0.5), [0.45, 0.375, 0.65, 0.5]), 'normal at opacity 0.5 mixes halfway');
  const M = new Float32Array([1, 0, 0.5, 1]);
  check(eq(Array.from(blendLayers(A, 1, B, 1, M, 'normal', 1, true).data, (x) => +x.toFixed(4)), [0.4, 0.25, 0.65, 1]), 'a mask limits where the foreground applies');
  const rgba = blendLayers(A, 1, new Float32Array([1, 0, 0, 0.5, 1, 0, 0, 0.5, 1, 0, 0, 0.5, 1, 0, 0, 0.5]), 4, null, 'normal', 1, true);
  check(rgba.ch === 4 && Math.abs(rgba.data[0] - 0.75) < 1e-6 && rgba.data[3] === 1, 'grey + RGBA → RGBA, the foreground alpha weights the mix, alpha stays the background\'s');
  // node level: blend with a mask input, the result resized to the background
  const nb = await image({ a: { type: 'tex_gradient', params: { resolution: 32 } }, b: { type: 'tex_pattern', params: { resolution: 64, pattern: 'checker', count: [2, 2] } }, out: { type: 'tex_blend', in: ['a', 'b'], params: { mode: 'multiply' } } }, 'out');
  check(nb.width === 32 && nb.name === 'gradient', 'tex_blend: the result keeps the background size and name');

  const noise = { n: { type: 'tex_noise', params: { resolution: 128, seed: 9 } } };
  const src = (await image(noise)).layer('C')!;
  const lv = await image({ ...noise, l: { type: 'tex_levels', in: ['n'], params: { in_low: 0.4, in_high: 0.6 } } }, 'l');
  check(lv.layer('C')!.every((x, i) => (src[i] <= 0.4 ? x === 0 : src[i] >= 0.6 ? x === 1 : x > 0 && x < 1)), 'tex_levels clips to the input range');
  const inv = await image({ ...noise, i: { type: 'tex_invert', in: ['n'] } }, 'i');
  check(maxDiff(inv.layer('C')!, src.map((x) => 1 - x)) < 1e-6, 'tex_invert: 1 - x');
  const hs = await image({ ...noise, h: { type: 'tex_histogram_scan', in: ['n'], params: { position: 0.5, contrast: 0 } } }, 'h');
  check(maxDiff(hs.layer('C')!, src) < 1e-6, 'tex_histogram_scan at position 0.5, contrast 0 is the identity');
  for (const mode of ['gaussian', 'box']) {
    const b = await image({ ...noise, b: { type: 'tex_blur', in: ['n'], params: { radius: 9, mode } } }, 'b');
    const m0 = mean(src), m1 = mean(b.layer('C')!);
    let v0 = 0, v1 = 0;
    for (let i = 0; i < src.length; i++) { v0 += (src[i] - m0) ** 2; v1 += (b.layer('C')![i] - m1) ** 2; }
    check(Math.abs(m0 - m1) < 1e-5 && v1 < v0 * 0.7, `tex_blur ${mode} (tileable) conserves the mean (${m0.toFixed(6)} → ${m1.toFixed(6)}) and smooths (variance × ${f3(v1 / v0)})`);
  }
  const rgbBlur = blurLayer(new Float32Array(64 * 64 * 4).fill(0.5), 4, 64, 64, 5, 'gaussian', false);
  check(rgbBlur.every((x) => Math.abs(x - 0.5) < 1e-6), 'blurring a constant RGBA image (clamped borders) changes nothing');

  const flat = await image({ ...noise, f: { type: 'tex_levels', in: ['n'], params: { out_low: 0.3, out_high: 0.3 } }, nm: { type: 'tex_normal_from_height', in: ['f'] } }, 'nm');
  const N = flat.layer('C')!;
  check(N.length === 128 * 128 * 4 && maxDiff(N, new Float32Array(N.length).map((_, i) => [0.5, 0.5, 1, 1][i & 3])) < 1e-6, 'normal map of a flat image is (0.5, 0.5, 1)');
  const rampU = await image({ g: { type: 'tex_gradient', params: { resolution: 64 } }, nm: { type: 'tex_normal_from_height', in: ['g'], params: { tileable: false } } }, 'nm');
  const rampV = await image({ g: { type: 'tex_gradient', params: { resolution: 64, angle: 90 } }, nm: { type: 'tex_normal_from_height', in: ['g'], params: { tileable: false } } }, 'nm');
  const rampVdx = await image({ g: { type: 'tex_gradient', params: { resolution: 64, angle: 90 } }, nm: { type: 'tex_normal_from_height', in: ['g'], params: { tileable: false, format: 'directx' } } }, 'nm');
  const px = (img: Image, c: number) => img.layer('C')![(32 * 64 + 32) * 4 + c];
  check(px(rampU, 0) < 0.499 && Math.abs(px(rampU, 1) - 0.5) < 1e-6, 'height rising along +u tilts the normal to −u (red < 0.5)');
  check(px(rampV, 1) < 0.499 && px(rampVdx, 1) > 0.501 && Math.abs(px(rampV, 0) - 0.5) < 1e-6, 'height rising along +v: green < 0.5 in OpenGL, > 0.5 in DirectX');
  // strength 1 is 45° for a rise of 1 over 1/64 of the width, at any resolution
  for (const res of [64, 256]) {
    const steep = await image({ g: { type: 'tex_gradient', params: { resolution: res } }, s: { type: 'tex_levels', in: ['g'], params: { out_high: 64, clamp: false } }, nm: { type: 'tex_normal_from_height', in: ['s'], params: { tileable: false } } }, 'nm');
    const r = steep.layer('C')![((res / 2) * res + res / 2) * 4];
    check(Math.abs(r - (0.5 - 0.5 * Math.SQRT1_2)) < 0.01, `strength 1: slope 1 per 1/64 width → 45° at ${res}² (red ${f3(r)})`);
  }
  const ed = await image({ p: { type: 'tex_pattern', params: { resolution: 64, pattern: 'checker', count: [2, 2] } }, e: { type: 'tex_edge_detect', in: ['p'] } }, 'e');
  check(Math.abs(ed.layer('C')![10 * 64 + 31] - 1) < 0.05 && ed.layer('C')![10 * 64 + 10] === 0, 'tex_edge_detect: about 1 on a 0 → 1 step, 0 on flat areas');
  const ao = await image({ p: { type: 'tex_pattern', params: { resolution: 128, gap: 0.15, bevel: 0 } }, a: { type: 'tex_height_to_ao', in: ['p'], params: { radius: 0.05, depth: 0.05 } } }, 'a');
  check(ao.layer('C')![0] < 0.8 && ao.layer('C')![(8 + 0) * 128 + 16] > 0.95, 'tex_height_to_ao: mortar dark, brick tops open');
  const col = await image({ g: { type: 'tex_gradient', params: { resolution: 16 } }, c: { type: 'tex_colorize', in: ['g'], params: { ramp: [[0, '#ff0000'], [1, '#0000ff']] } } }, 'c');
  check(col.layer('C')!.length === 16 * 16 * 4 && col.layer('C')![0] > 0.9 && col.layer('C')![15 * 4 + 2] > 0.9, 'tex_colorize: ramp colours as they are (#ff0000 → red 1)');
  const orm = await image({ a: { type: 'tex_gradient', params: { resolution: 8 } }, b: { type: 'tex_shape', params: { resolution: 16 } }, o: { type: 'tex_channel', in: ['a', 'b'], params: { name: 'orm' } } }, 'o');
  check(orm.name === 'orm' && orm.width === 8 && orm.layer('C')![2] === 0 && orm.layer('C')![3] === 1, 'tex_channel pack: R, G from inputs (resized to the first), B and A from fill');
  const ex = await image({ a: { type: 'tex_colorize', in: ['g'], params: { ramp: [[0, '#336699'], [1, '#336699']] } }, g: { type: 'tex_gradient', params: { resolution: 4 } }, x: { type: 'tex_channel', in: ['a'], params: { mode: 'extract', channel: 'b' } } }, 'x');
  check(Math.abs(ex.layer('C')![0] - 0x99 / 255) < 1e-6 && ex.layer('C')!.length === 16, 'tex_channel extract: one channel as grey');
  const tr = await image({ p: { type: 'tex_pattern', params: { resolution: 64, pattern: 'checker', count: [2, 2] } }, t: { type: 'tex_transform', in: ['p'], params: { offset: [0.5, 0] } } }, 't');
  const p0 = genPattern({ pattern: 'checker', count: [2, 2], offset: 0.5, gap: 0, bevel: 0, variation: 0, seed: 0 }, 64, 64).C;
  check(maxDiff(tr.layer('C')!, p0.map((x) => 1 - x)) < 1e-6, 'tex_transform: half an image offset of a 2 × 2 checker inverts it');
  const ts = await image({ s: { type: 'tex_shape', params: { resolution: 32, falloff: 0.5 } }, t: { type: 'tex_tile_sampler', in: ['s'], params: { resolution: 64, count: [4, 4] } } }, 't');
  check(mean(ts.layer('C')!) > 0.05, 'tex_tile_sampler stamps the source');
  const out = await geo({ p: { type: 'tex_pattern', params: { resolution: 16 } }, o: { type: 'tex_output', in: ['p'], params: { name: 'brick_ids', layer: 'id' } } }, 'o');
  check(imagesOf(out).map((i) => i.name).join(',') === 'pattern,brick_ids', 'tex_output with a layer adds it as a new image');
  check((await cookErr({ b: { type: 'box' }, l: { type: 'tex_levels', in: ['b'] } }, 'l')).includes('has no image'), 'a filter on a mesh fails with a hint');
  const hf = await geo({ n: { type: 'tex_noise', params: { resolution: 33 } }, h: { type: 'tex_to_heightfield', in: ['n'], params: { size: 4, height_scale: 2 } }, t: { type: 'heightfield_to_tex', in: ['h'], params: { normalize: false } } }, 't');
  const back = findImage(hf)!, srcN = (await image({ n: { type: 'tex_noise', params: { resolution: 33 } } })).layer('C')!;
  check(back.width === 33 && maxDiff(back.layer('C')!, srcN.map((x) => x * 2)) < 1e-5, 'tex_to_heightfield → heightfield_to_tex round trip (height = value × scale)');
}

// ---------------------------------------------------------------- volumes

section('image volumes: merge, clone, JSON, fingerprints');
{
  const a = await geo({ n: { type: 'tex_noise', params: { resolution: 16, name: 'a' } } });
  const b = await geo({ n: { type: 'tex_pattern', params: { resolution: [8, 4], name: 'b' } } });
  const m = Geometry.merge([a, b]);
  check(imagesOf(m).map((i) => `${i.name}:${i.width}x${i.height}`).join(' ') === 'a:16x16 b:8x4', 'merge keeps both images');
  const c = m.clone();
  check(c.volumes[0] !== m.volumes[0] && (c.volumes[0] as Image).layer('C') === (m.volumes[0] as Image).layer('C'), 'clone: own image objects, shared layer arrays');
  const rt = geoFromJSON(JSON.parse(JSON.stringify(geoToJSON(m))));
  const same = imagesOf(rt).every((im, k) => { const o = imagesOf(m)[k]; return im.name === o.name && [...o.layers].every(([n, arr]) => maxDiff(arr, im.layer(n)!) === 0); });
  check(same && imagesOf(rt).length === 2, 'JSON round trip is exact (base64 float32 layers)');
  const fa = fingerprint(a), fb = fingerprint(await geo({ n: { type: 'tex_noise', params: { resolution: 16, name: 'a', seed: 1 } } }));
  check(JSON.stringify(fa.volumes) !== JSON.stringify(fb.volumes) && fa.volumes![0].kind === 'image', 'fingerprints change with image content');
  check(/image "a": 16×16, layers: C grey/.test(summarize(a)) && summarize(a).includes('1 image(s)'), 'inspect lists images with size and layer ranges');
  check(explainGeometry(a).includes('only 1 image'), 'explain describes an image-only geometry');
  const moved = await geo({ n: { type: 'tex_noise', params: { resolution: 16, name: 'a' } }, t: { type: 'transform', in: ['n'], params: { translate: [1, 2, 3], scale: -1 } } }, 't');
  check(imagesOf(moved).length === 1 && maxDiff(findImage(moved)!.layer('C')!, findImage(a)!.layer('C')!) === 0, 'transform leaves images alone');
  const big = resizeLayer(new Float32Array([0, 1, 1, 0]), 1, 2, 2, 8, 8, true), small = resizeLayer(big, 1, 8, 8, 2, 2, true);
  check(Math.abs(mean(big) - 0.5) < 1e-6 && Math.abs(mean(small) - 0.5) < 1e-6, 'resizing (bilinear up, area average down, wrapping) keeps the mean');
}

// ---------------------------------------------------------------- bakes

section('bakes');
const UVBOX = { b: { type: 'box', params: { divisions: [2, 2, 2] } }, uv: { type: 'uv_unwrap', in: ['b'], params: { resolution: 128, padding: 4 } } };
{
  const plane = { g: { type: 'grid', params: { size: [2, 2], divisions: [4, 4] } } };
  const ao = await image({ ...plane, ao: { type: 'bake_ao', in: ['g'], params: { resolution: 64, samples: 16 } } }, 'ao');
  const cov = ao.layer('mask')!;
  check(ao.layer('C')!.every((x) => x === 1) && cov.every((x) => x > 0), 'AO of a flat plane (point uv 0..1) is white everywhere');
  const inside = await cookOn(engine, { b: { type: 'box' }, r: { type: 'reverse', in: ['b'] }, uv: { type: 'uv_unwrap', in: ['r'], params: { resolution: 64 } }, ao: { type: 'bake_ao', in: ['uv'], params: { resolution: 64, samples: 16 } } }, 'ao');
  const ain = findImage(inside.geo)!, m = ain.layer('mask')!;
  const meanIn = mean(ain.layer('C')!, 1, 0, (i) => m[i] > 0);
  check(meanIn < 0.05, `AO of a box interior (reversed faces) is dark (mean ${f3(meanIn)})`);
  check(inside.stats.rays > 0 && inside.stats.texels > 0, `bake stats: ${inside.stats.texels} texels, ${inside.stats.rays} rays`);
  const crateAO = await image({ c: { type: 'crate' }, uv: { type: 'uv_unwrap', in: ['c'], params: { resolution: 128 } }, ao: { type: 'bake_ao', in: ['uv'], params: { resolution: 128, samples: 16, max_distance: 0.2 } } }, 'ao');
  const cm = crateAO.layer('mask')!, cv = crateAO.layer('C')!;
  let lo = 0, hi = 0;
  for (let i = 0; i < cv.length; i++) if (cm[i] > 0) { if (cv[i] < 0.5) lo++; if (cv[i] > 0.95) hi++; }
  check(lo > 100 && hi > 100, `crate AO has open and occluded texels (${hi} open, ${lo} dark)`);

  // curvature: bright on bevels, 0.5 on flat faces
  const bev = { b: { type: 'box' }, bv: { type: 'poly_bevel', in: ['b'], params: { offset: 0.08, divisions: 2 } }, uv: { type: 'uv_unwrap', in: ['bv'], params: { resolution: 256, padding: 4 } } };
  const cur = await image({ ...bev, c: { type: 'bake_curvature', in: ['uv'], params: { resolution: 256, radius: 0.04, padding: 0 } } }, 'c');
  const msk = await image({ ...bev, k: { type: 'bake_mask', in: ['uv'], params: { resolution: 256, mask_group: 'bevel', padding: 0 } } }, 'k');
  const cc = cur.layer('C')!, kk = msk.layer('C')!, cover = msk.layer('mask')!;
  const onBevel = mean(cc, 1, 0, (i) => cover[i] === 1 && kk[i] === 1), onFace = mean(cc, 1, 0, (i) => cover[i] === 1 && kk[i] === 0);
  check(onBevel > 0.6 && onFace < onBevel - 0.1, `curvature bake bright on bevels (${f3(onBevel)}) above faces (${f3(onFace)})`);
  check(cur.layers.has('convex') && cur.layers.has('concave') && Math.max(...cur.layer('concave')!) === 0, 'curvature layers convex/concave (a box has no concave edge)');
  const notch = await image({ b: { type: 'box', params: { size: [1, 1, 1] } }, e: { type: 'poly_extrude', in: ['b'], params: { group: '@P.y>0.4', distance: -0.3, inset: 0.2 } }, uv: { type: 'uv_unwrap', in: ['e'], params: { resolution: 128 } }, c: { type: 'bake_curvature', in: ['uv'], params: { resolution: 128, radius: 0.05 } } }, 'c');
  check(Math.max(...notch.layer('concave')!) > 0.5, 'a recessed top has concave edges (layer concave)');

  // padding dilates the islands; texels beyond it get the background
  const p0 = await image({ ...UVBOX, p: { type: 'bake_position', in: ['uv'], params: { resolution: 128, padding: 0 } } }, 'p');
  const p8 = await image({ ...UVBOX, p: { type: 'bake_position', in: ['uv'], params: { resolution: 128, padding: 8 } } }, 'p');
  const filled = (img: Image) => { const c = img.layer('C')!; let n = 0; for (let i = 0; i < c.length; i += 4) if (c[i] || c[i + 1] || c[i + 2]) n++; return n; };
  const cov0 = Array.from(p0.layer('mask')!).filter((x) => x > 0).length;
  check(filled(p8) > filled(p0) && filled(p0) <= cov0 + 0 && maxDiff(p0.layer('mask')!, p8.layer('mask')!) === 0, `padding fills ${filled(p8) - filled(p0)} more texels (mask unchanged: ${cov0} covered)`);

  // island ids: one id per xatlas chart
  const isl = await cookOn(engine, { ...UVBOX, i: { type: 'bake_island_id', in: ['uv'], params: { resolution: 128 } } }, 'i');
  const uvg = await geo(UVBOX, 'uv');
  const charts = new Set(Array.from(uvg.prims.get('chart')!.data as Int32Array)).size;
  const ids = findImage(isl.geo)!.layer('id')!, im = findImage(isl.geo)!.layer('mask')!;
  const seen = new Set<number>();
  for (let i = 0; i < ids.length; i++) if (im[i] > 0) seen.add(ids[i]);
  check(isl.stats.islands === charts && seen.size === charts, `island ids count islands (${isl.stats.islands} islands, ${seen.size} ids in the image, ${charts} xatlas charts)`);

  // normals and height from a high-res mesh
  const HI = { ...UVBOX, hi: { type: 'subdivide', in: ['b'], params: { levels: 3 } } };
  const nrm = await cookOn(engine, { ...HI, n: { type: 'bake_normal', in: ['uv', 'hi'], params: { resolution: 128, cage: 0.4 } } }, 'n');
  const nimg = findImage(nrm.geo)!, nc = nimg.layer('C')!, nm2 = nimg.layer('mask')!;
  let tilted = 0, unit = true;
  for (let i = 0; i < nm2.length; i++) {
    if (nm2[i] < 1) continue;
    const x = nc[i * 4] * 2 - 1, y = nc[i * 4 + 1] * 2 - 1, z = nc[i * 4 + 2] * 2 - 1;
    if (Math.abs(Math.hypot(x, y, z) - 1) > 0.02 || z < 0) unit = false;
    if (z < 0.97) tilted++;
  }
  check(unit && tilted > 200 && !nrm.warnings.length, `bake_normal: unit tangent-space normals facing out, ${tilted} texels tilted by the rounded high mesh, no misses`);
  const flatN = await cookOn(engine, { ...UVBOX, n: { type: 'bake_normal', in: ['uv'], params: { resolution: 32 } } }, 'n');
  check(flatN.warnings.some((w) => w.includes('flat')), 'bake_normal without a high mesh warns and writes the flat normal');
  const ht = await cookOn(engine, { ...HI, h: { type: 'bake_height', in: ['uv', 'hi'], params: { resolution: 64, cage: 0.4 } } }, 'h');
  const hd = findImage(ht.geo)!.layer('distance')!;
  check(ht.stats.height_min < -0.05 && ht.stats.height_max <= 1e-6 && Math.min(...hd) < -0.05, `bake_height: the subdivided box lies inside the box (distances ${f3(ht.stats.height_min)} .. ${f3(ht.stats.height_max)} m)`);
  const wn = await image({ ...UVBOX, w: { type: 'bake_world_normal', in: ['uv'], params: { resolution: 32 } } }, 'w');
  const wc = wn.layer('C')!, wm = wn.layer('mask')!;
  let axisAligned = true;
  for (let i = 0; i < wm.length; i++) if (wm[i] === 1) { const v = [wc[i * 4], wc[i * 4 + 1], wc[i * 4 + 2]].map((x) => Math.abs(x * 2 - 1)); if (Math.abs(Math.max(...v) - 1) > 1e-3) axisAligned = false; }
  check(axisAligned, 'bake_world_normal of a box: every covered texel is an axis direction');
  const vc = await image({ ...UVBOX, c: { type: 'color', in: ['uv'], params: { color: [0.2, 0.4, 0.6] } }, v: { type: 'bake_vertex_color', in: ['c'], params: { resolution: 16 } } }, 'v');
  check(Math.abs(vc.layer('C')![0] - 0.2) < 1e-6 && Math.abs(vc.layer('C')![2] - 0.6) < 1e-6, 'bake_vertex_color writes Cd as it is (padding fills the gaps)');
  const th = await image({ ...UVBOX, t: { type: 'bake_thickness', in: ['uv'], params: { resolution: 32, samples: 8, max_distance: 2 } } }, 't');
  const tm = mean(th.layer('C')!, 1, 0, (i) => th.layer('mask')![i] === 1);
  check(tm > 0.45 && tm < 0.6, `bake_thickness of a unit box ≈ 1 m / 2 m (${f3(tm)})`);
  check((await cookErr({ b: { type: 'box' }, d: { type: 'attrib_delete', in: ['b'], params: { names: 'uv' } }, a: { type: 'bake_ao', in: ['d'] } }, 'a')).includes('uv_unwrap'), 'a bake without uv fails with a hint');
  check((await cookErr({ ...UVBOX, a: { type: 'bake_height', in: ['uv'] } }, 'a')).includes('input 1'), 'bake_height needs a high mesh');
  const kept = await geo({ ...UVBOX, a: { type: 'bake_mask', in: ['uv'], params: { resolution: 16, keep_mesh: true } } }, 'a');
  check(kept.numPrims === 24 && imagesOf(kept).length === 1, 'keep_mesh passes the mesh through with the image');
}

// ---------------------------------------------------------------- materials and exports

section('materials and exports');
const textured = {
  ...UVBOX,
  col: { type: 'tex_colorize', in: ['pat'], params: { ramp: [[0, '#202020'], [1, '#a5462e']], name: 'brick_color' } },
  pat: { type: 'tex_pattern', params: { resolution: 64, name: 'brick_height' } },
  nrm: { type: 'tex_normal_from_height', in: ['pat'], params: { name: 'brick_normal' } },
  ao: { type: 'bake_ao', in: ['uv'], params: { resolution: 64, samples: 8, name: 'box_ao' } },
  maps: { type: 'merge', in: ['col', 'nrm', 'ao'] },
  mat: { type: 'texture_to_material', in: ['uv', 'maps'], params: { material: 'brick', base_color: 'brick_color', normal: 'brick_normal', occlusion: 'box_ao', roughness_value: 0.7 } },
};
let tg: Geometry;
{
  tg = await geo(textured, 'mat');
  const t = readMaterials(tg).brick;
  check(t?.textures?.baseColor === 'image:brick_color' && t.textures.normal === 'image:brick_normal' && t.textures.orm === 'image:brick_orm', `texture_to_material: slots reference images (${JSON.stringify(t?.textures)})`);
  check(imagesOf(tg).map((i) => i.name).sort().join(',') === 'brick_color,brick_normal,brick_orm', 'the referenced images (and the packed ORM) travel with the mesh');
  const ormImg = findImage(tg, 'brick_orm')!.layer('C')!;
  check(Math.abs(ormImg[1] - 0.7) < 1e-6 && ormImg[2] === 0, 'occlusion packs into ORM with the material roughness (G) and metallic (B)');
  check((tg.prims.get('material')!.data as string[]).every((m) => m === 'brick'), 'a new material is assigned to every prim');
  check((await cookErr({ ...textured, mat: { type: 'texture_to_material', in: ['uv', 'maps'], params: { base_color: 'nope' } } }, 'mat')).includes('brick_color'), 'a missing image name fails and lists the images');

  // glTF: PNGs embedded from memory, validator clean, base colour / normal / ORM (occlusion + metallicRoughness)
  const warns: string[] = [];
  const glb = await exportGeometryAsync(tg, 'glb', { deflate: (d) => zlib.deflateSync(d), warn: (m) => warns.push(m) });
  const report = await validator.validateBytes(glb, { maxIssues: 50, writeTimestamp: false });
  const errs = report.issues.messages.filter((m: any) => m.severity === 0);
  check(errs.length === 0, `glTF validator: ${report.issues.numErrors} errors, ${report.issues.numWarnings} warnings (${[...new Set(report.issues.messages.filter((m: any) => m.severity === 1).map((m: any) => m.code))].join(', ')})${errs.length ? ' — ' + errs.slice(0, 3).map((m: any) => `${m.code} ${m.message}`).join(' | ') : ''}`);
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + dv.getUint32(12, true))));
  const m0 = json.materials.find((m: any) => m.name === 'brick');
  check(json.images.length === 3 && json.images.every((i: any) => i.mimeType === 'image/png') && json.textures.length === 3, `glTF embeds 3 PNG images (${json.images.map((i: any) => i.name).join(', ')})`);
  check(m0.pbrMetallicRoughness.baseColorTexture && m0.normalTexture && m0.occlusionTexture && m0.pbrMetallicRoughness.metallicRoughnessTexture.index === m0.occlusionTexture.index && (m0.pbrMetallicRoughness.metallicFactor ?? 1) === 1, 'ORM is both the occlusion and the metallicRoughness texture');
  check(!warns.length, `no export warnings${warns.length ? ': ' + warns.join('; ') : ''}`);
  // the embedded base colour PNG holds the image's bytes
  const bufView = json.bufferViews[json.images.find((i: any) => i.name === 'brick_color').bufferView];
  const binStart = 20 + dv.getUint32(12, true) + 8;
  const png = decodePNG(glb.subarray(binStart + (bufView.byteOffset ?? 0), binStart + (bufView.byteOffset ?? 0) + bufView.byteLength));
  const want = imageToBytes(findImage(tg, 'brick_color')!).bytes;
  check(png.width === 64 && png.channels === 4 && Array.from(png.data).every((x, i) => x === want[i]), 'embedded PNG = the image values × 255 (no transfer curve)');
  const gltfText = new TextDecoder().decode(await exportGeometryAsync(tg, 'gltf', {}));
  check((JSON.parse(gltfText).images ?? []).length === 3 && gltfText.includes('data:image/png;base64,'), '.gltf embeds the images as data URIs (stored PNG blocks without deflate)');

  // USD: PNGs next to the .usda, referenced relative to it, ORM through r/g/b
  const usdPath = path.join(tmp, 'out', 'brick.usda');
  const u = await exportFilesAsync(tg, 'usda', usdPath, { deflate: (d) => zlib.deflateSync(d) });
  const usda = new TextDecoder().decode(u.files[0].bytes);
  const pngs = u.files.slice(1).map((f) => path.relative(path.dirname(usdPath), f.path).split(path.sep).join('/'));
  check(pngs.length === 3 && pngs.every((p) => p.startsWith('brick_textures/') && p.endsWith('.png')), `usda writes ${pngs.join(', ')}`);
  check(pngs.every((p) => usda.includes(`@${p}@`)) && usda.includes('orm_map.outputs:g') && usda.includes('inputs:occlusion.connect') && !usda.includes('@image:'), 'usda references the PNGs; ORM drives roughness/metallic/occlusion');
  check(u.files.slice(1).every((f) => decodePNG(f.bytes).width === 64), 'the USD texture files decode');

  // the textures format: every image as PNG, extra layers on request
  const tx = await exportFilesAsync(Geometry.merge([tg, await geo({ p: { type: 'tex_pattern', params: { resolution: 16, name: 'bricks' } } })]), 'textures', path.join(tmp, 'maps'), { layers: ['id'] });
  const names = tx.files.map((f) => path.basename(f.path)).sort();
  check(names.join(',') === 'brick_color.png,brick_color_id.png,brick_normal.png,brick_normal_id.png,brick_orm.png,bricks.png,bricks_id.png', `textures export: ${names.join(', ')}`);
  const grey = decodePNG(tx.files.find((f) => f.path.endsWith('bricks.png'))!.bytes);
  check(grey.channels === 1 && grey.width === 16, 'grey images are written as 8-bit grey PNGs');
  const geoWarn: string[] = [];
  await exportFilesAsync(tg, 'geo', path.join(tmp, 'x.geo'), { warn: (m) => geoWarn.push(m) });
  check(geoWarn.some((w) => w.includes('3 image(s) not written')), '.geo skips images with a note');
  check(await exportFilesAsync(await geo({ b: { type: 'box' } }), 'textures', path.join(tmp, 'none')).then(() => false, (e) => String(e.message).includes('no image')), 'textures export of a geometry without images fails readably');
}

// ---------------------------------------------------------------- render

section('render: texture view and texture sampling');
{
  const noiseOnly = await geo({ n: { type: 'tex_noise', params: { resolution: 64 } } });
  const r = renderGeometry(noiseOnly, { size: 256 });
  check(r.width === 256 && !r.notes.some((n) => n.includes('SDF')), 'an image-only geometry renders as the texture view');
  const strip = renderGeometry(tg, { ...renderArgs({ texture: 'brick' }), size: 400 });
  check(strip.width === 400 && !strip.notes.some((n) => n.includes('texture view:')), 'texture: "<material>" draws the material\'s maps');
  const missing = renderGeometry(tg, { ...renderArgs({ texture: 'nope' }), size: 200 });
  check(missing.notes.some((n) => n.includes('no image "nope"')), 'an unknown texture name is reported in the notes');
  // persp with textures: the box shows the brick colours (reddish) instead of the default grey
  const plain = renderGeometry(tg, { views: ['persp'], size: 200, grid: false });
  const tex = renderGeometry(tg, { views: ['persp'], size: 200, grid: false, textures: true });
  const redness = (rr: { rgba: Uint8Array }) => { let s = 0, n = 0; for (let i = 0; i < rr.rgba.length; i += 4) { const d = rr.rgba[i] - rr.rgba[i + 2]; if (Math.abs(d) > 8) { s += d; n++; } } return n ? s / n : 0; };
  check(redness(tex) > redness(plain) + 20, `textures: true shows the base colour map (red − blue ${f3(redness(tex))} vs ${f3(redness(plain))})`);
  const noUV = renderGeometry(await geo({ b: { type: 'box' }, d: { type: 'attrib_delete', in: ['b'], params: { names: 'uv' } } }, 'd'), { views: ['persp'], size: 128, textures: true });
  check(noUV.notes.some((n) => n.includes('no uv')), 'textures without uv says so');
}

// ---------------------------------------------------------------- pool on / off

section('worker pool on/off: identical images');
{
  const poolEngine = new Engine(createNodeHost({ baseDir: tmp, workers: 4, pool: { minElements: 1 } }));
  await poolEngine.init();
  const serialEngine = new Engine(createNodeHost({ baseDir: tmp, workers: 0 }));
  await serialEngine.init();
  const graphs: Record<string, Record<string, NodeSpec>> = {
    noise: { n: { type: 'tex_noise', params: { resolution: 96, noise: 'simplex', fractal: 'ridged' } } },
    cells: { n: { type: 'tex_cells', params: { resolution: 96, output: 'crackle' } } },
    ao: { ...UVBOX, n: { type: 'bake_ao', in: ['uv'], params: { resolution: 64, samples: 8, supersample: 2 } } },
    curvature: { ...UVBOX, n: { type: 'bake_curvature', in: ['uv'], params: { resolution: 64, radius: 0.1 } } },
    normal: { ...UVBOX, hi: { type: 'subdivide', in: ['b'], params: { levels: 2 } }, n: { type: 'bake_normal', in: ['uv', 'hi'], params: { resolution: 64, cage: 0.4 } } },
  };
  for (const [k, nodes] of Object.entries(graphs)) {
    const a = findImage((await cookOn(poolEngine, structuredClone(nodes), 'n')).geo)!, b = findImage((await cookOn(serialEngine, structuredClone(nodes), 'n')).geo)!;
    const same = [...a.layers].every(([n, arr]) => maxDiff(arr, b.layer(n)!) === 0);
    check(same, `${k}: pool and serial runs give the same bits`);
  }
  const st = poolEngine.poolStats;
  check(st.parallel > 0, `the forced pool ran jobs on worker threads (${st.parallel} parallel, ${st.chunks} chunks)`);
  await poolEngine.host.pool?.close();
}

// ---------------------------------------------------------------- performance (informational, generous limits)

section('performance');
{
  const t0 = performance.now();
  const big = await cookOn(engine, { n: { type: 'tex_noise', params: { resolution: 2048, octaves: 5 } } });
  const tNoise = performance.now() - t0;
  console.log(`  tex_noise 2048² (5 octaves): ${tNoise.toFixed(0)} ms (pool: ${engine.host.pool ? engine.host.pool.size + ' threads' : 'off'})`);
  check(findImage(big.geo)!.width === 2048 && tNoise < 15000, 'tex_noise 2048² cooks');
}

console.log(`\n${pass} passed, ${fail} failed`);
await engine.host.pool?.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
