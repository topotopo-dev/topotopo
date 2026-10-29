// Behavioural tests for procedural textures and bakes: image volumes, generators (deterministic, tileable),
// filters (blend modes, blur, normals), bakes (AO, curvature, padding, islands, normals from a high mesh), material
// linkage, exports (glTF embeds PNGs and validates, USD writes files, the textures format), PNG files read as images
// (image_file, the file node, the live viewer's quads), the texture view and texture sampling in the renderer, JSON
// round trips, fingerprints, and pool on/off equality.
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
import { Image, findImage, imageToBytes, imagesOf, resizeLayer, toGrey } from '../src/core/image.ts';
import { texNoise } from '../src/core/texnoise.ts';
import { blendLayers, blurLayer, genPattern } from '../src/core/texture.ts';
import { readMaterials } from '../src/core/materials.ts';
import { allNodeDefs, getNodeDef } from '../src/graph/registry.ts';
import { geoFromJSON, geoToJSON } from '../src/io/json.ts';
import { exportGeometryAsync } from '../src/io/export.ts';
import { importGeometry, importGeometryAsync } from '../src/io/import.ts';
import { exportFilesAsync } from '../src/io/files.ts';
import { decodePNG } from '../src/io/png-decode.ts';
import { imagePNG } from '../src/io/textures.ts';
import { renderGeometry } from '../src/render/raster.ts';
import { withImagePreview } from '../src/render/texview.ts';
import { renderArgs } from '../src/render/options.ts';
import { summarize } from '../src/inspect.ts';
import { explainGeometry } from '../src/explain.ts';
import { fingerprint } from './fingerprint.ts';
import { useKits } from './fixtures.ts';
import type { NodeSpec } from '../src/graph/types.ts';

const require = createRequire(import.meta.url);
const validator = require('gltf-validator');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-tex-'));
const engine = new Engine(createNodeHost({ baseDir: tmp }));
await engine.init();
// the crate is TopoTopo's own (topotopo/props/crate)
useKits(engine, path.join(tmp, 'kits'));

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
for (const t of ['tex_noise', 'tex_pattern', 'tex_gradient', 'tex_shape', 'tex_cells', 'tex_splatter', 'tex_scratches', 'tex_text', 'image_file', 'tex_blend', 'tex_levels', 'tex_curves', 'tex_blur', 'tex_warp', 'tex_transform', 'tex_edge_detect', 'tex_invert', 'tex_threshold', 'tex_histogram_scan', 'tex_normal_from_height', 'tex_height_to_ao', 'tex_channel', 'tex_colorize', 'tex_tile_sampler', 'tex_output', 'texture_to_material', 'tex_to_heightfield', 'heightfield_to_tex', 'bake_ao', 'bake_curvature', 'bake_thickness', 'bake_position', 'bake_normal', 'bake_world_normal', 'bake_island_id', 'bake_mask', 'bake_vertex_color', 'bake_height'])
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
  // every node's example cooks (an example that reads a PNG, image_file's, gets one at the path it names)
  const failed: string[] = [];
  const png = imagePNG(new Image(8, 4, 'fixture').set('C', new Float32Array(8 * 4 * 4).fill(0.5)));
  for (const t of TEX_TYPES) {
    const ex: any = getNodeDef(t)!.example;
    if (!ex) continue;
    const graph = ex.nodes ? ex : { nodes: { x: ex }, output: 'x' };
    for (const s of Object.values(graph.nodes) as NodeSpec[]) {
      if (getNodeDef(s.type)?.type !== 'image_file' || !s.params?.path) continue;
      fs.mkdirSync(path.dirname(path.join(tmp, s.params.path)), { recursive: true });
      fs.writeFileSync(path.join(tmp, s.params.path), png);
    }
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
  const k = await image({ k: { type: 'tex_constant', params: { resolution: [8, 4], value: 0.65 } } });
  check(k.name === 'k' && k.width === 8 && k.height === 4 && k.layer('C')!.length === 32 && k.layer('C')!.every((x) => Math.abs(x - 0.65) < 1e-6), 'tex_constant grey: one value everywhere');
  const kc = await image({ src: { type: 'tex_noise', params: { resolution: [24, 12] } }, k: { type: 'tex_constant', in: ['src'], params: { channels: 'rgba', color: '#a5462e', alpha: 0.5 } } }, 'k');
  const kd = kc.layer('C')!;
  check(kc.width === 24 && kc.height === 12 && kd.length === 24 * 12 * 4 && Math.abs(kd[0] - 0xa5 / 255) < 1e-6 && Math.abs(kd[2] - 0x2e / 255) < 1e-6 && kd[3] === 0.5 && imagesOf(await geo({ src: { type: 'tex_noise', params: { resolution: 8 } }, k: { type: 'tex_constant', in: ['src'] } }, 'k')).length === 1,
    'tex_constant rgba: the colour as typed, the size of the input image, only the new image out');
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
  check(nb.width === 32 && nb.name === 'out', 'tex_blend: the result keeps the background size and is named after the node');

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
  // physical units: a ramp of 0..1 across an image 0.1 m wide, at depth 0.1 m, rises 0.1 m over 0.1 m: 45° at any
  // resolution; depth 0.05 m gives atan(0.5)
  for (const res of [64, 256]) {
    const nm = (depth: number) => image({ g: { type: 'tex_gradient', params: { resolution: res } }, nm: { type: 'tex_normal_from_height', in: ['g'], params: { tileable: false, depth, size: 0.1 } } }, 'nm');
    const r = (await nm(0.1)).layer('C')![((res / 2) * res + res / 2) * 4], h = (await nm(0.05)).layer('C')![((res / 2) * res + res / 2) * 4];
    const tilt = (x: number) => 0.5 - 0.5 * Math.sin(Math.atan(x));
    check(Math.abs(r - tilt(1)) < 0.01 && Math.abs(h - tilt(0.5)) < 0.01, `depth / texel size: 0.1 m over 0.1 m → 45°, 0.05 m → 26.6° at ${res}² (red ${f3(r)}, ${f3(h)})`);
  }
  // tex_normal_blend: rnm keeps both reliefs; a flat detail (or strength 0, or a black mask) returns the base
  {
    const base = { g: { type: 'tex_gradient', params: { resolution: 32 } }, bn: { type: 'tex_normal_from_height', in: ['g'], params: { tileable: false, depth: 0.5, size: 1 } } };
    const detailV = { d: { type: 'tex_gradient', params: { resolution: 32, angle: 90 } }, dn: { type: 'tex_normal_from_height', in: ['d'], params: { tileable: false, depth: 0.5, size: 1 } } };
    const flatD = { f: { type: 'tex_levels', in: ['d'], params: { out_low: 0.5, out_high: 0.5 } }, fn: { type: 'tex_normal_from_height', in: ['f'] } };
    const B = (await image({ ...base }, 'bn')).layer('C')!;
    const blend = async (params: Record<string, any>, detail = 'dn', extra: Record<string, NodeSpec> = {}) => (await image({ ...base, ...detailV, ...flatD, ...extra, out: { type: 'tex_normal_blend', in: ['bn', detail, ...(extra.m ? ['m'] : [])], params } }, 'out'));
    const rnm = await blend({}), at = (img: Image, c: number) => img.layer('C')![(16 * 32 + 16) * 4 + c];
    check(rnm.name === 'out' && at(rnm, 0) < 0.45 && at(rnm, 1) < 0.45, `rnm: the base's tilt along u and the detail's along v both stay (${f3(at(rnm, 0))}, ${f3(at(rnm, 1))})`);
    check(maxDiff((await blend({}, 'fn')).layer('C')!, B) < 1e-5 && maxDiff((await blend({ strength: 0 })).layer('C')!, B) < 1e-5, 'rnm: a flat detail and strength 0 return the base');
    check(maxDiff((await blend({}, 'dn', { m: { type: 'tex_levels', in: ['g'], params: { out_low: 0, out_high: 0 } } })).layer('C')!, B) < 1e-5, 'a black mask keeps the base');
    const udn = await blend({ mode: 'udn' }), lin = await blend({ mode: 'linear' });
    check(at(udn, 2) > at(rnm, 2) - 0.2 && Math.abs(at(lin, 0) - at(rnm, 0)) > 0.01, 'udn and linear modes differ from rnm');
    const strong = await blend({ strength: 2 });
    check(at(strong, 1) < at(rnm, 1) - 0.01, 'strength 2 tilts the detail further');
    check((await cookErr({ ...base, out: { type: 'tex_normal_blend', in: ['g', 'bn'] } }, 'out')).includes('not a normal map'), 'a grey base is an error naming normal maps');
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
  check(imagesOf(out).map((i) => i.name).join(',') === 'p,brick_ids', 'tex_output with a layer adds it as a new image');
  check((await cookErr({ b: { type: 'box' }, l: { type: 'tex_levels', in: ['b'] } }, 'l')).includes('has no image'), 'a filter on a mesh fails with a hint');
  const hf = await geo({ n: { type: 'tex_noise', params: { resolution: 33 } }, h: { type: 'tex_to_heightfield', in: ['n'], params: { size: 4, height_scale: 2 } }, t: { type: 'heightfield_to_tex', in: ['h'], params: { normalize: false } } }, 't');
  const back = findImage(hf)!, srcN = (await image({ n: { type: 'tex_noise', params: { resolution: 33 } } })).layer('C')!;
  check(back.width === 33 && maxDiff(back.layer('C')!, srcN.map((x) => x * 2)) < 1e-5, 'tex_to_heightfield → heightfield_to_tex round trip (height = value × scale)');
}

// ---------------------------------------------------------------- names and coverage

section('names: images take their node\'s name; several images need a choice; histogram coverage');
{
  // two identical generators under different names: their own names, no shared cache entry, no collision
  const two = await geo({ rust: { type: 'tex_noise', params: { resolution: 16 } }, dirt: { type: 'tex_noise', params: { resolution: 16 } }, m: { type: 'merge', in: ['rust', 'dirt'] } }, 'm');
  check(imagesOf(two).map((i) => i.name).join() === 'rust,dirt', 'default image names are the node names (identical nodes keep their own)');
  const named = await geo({ a: { type: 'tex_noise', params: { resolution: 16, name: 'grain' } }, l: { type: 'tex_levels', in: ['a'], params: { name: 'grain_soft' } } }, 'l');
  check(imagesOf(named).map((i) => i.name).join() === 'grain_soft', 'the name param overrides it');
  const branches = { n: { type: 'tex_noise', params: { resolution: 16 } }, lv: { type: 'tex_levels', in: ['n'], params: { in_high: 0.5 } }, bl: { type: 'tex_blur', in: ['n'] }, m: { type: 'merge', in: ['lv', 'bl'] } };
  check(imagesOf(await geo(branches, 'm')).map((i) => i.name).join() === 'lv,bl', 'two filters of one image do not collide when merged (lv, bl)');
  const err = await cookErr({ ...branches, x: { type: 'tex_invert', in: ['m'] } }, 'x');
  check(err.includes('holds 2 images ("lv", "bl")') && err.includes('set image to one of them'), `a filter given several images asks which one (${err})`);
  check(!(await cookErr({ ...branches, x: { type: 'tex_invert', in: ['m'], params: { image: 'bl' } } }, 'x')), '… and takes the one named');
  const fg = await cookErr({ ...branches, x: { type: 'tex_blend', in: ['n', 'm'] } }, 'x');
  check(fg.includes('input 1 holds 2 images') && fg.includes('foreground_image'), 'a second input with several images names its own param (foreground_image)');
  // merge: an image several inputs carry is kept once; different images under one name stay, with a warning
  const lod = await cookOn(engine, { n: { type: 'tex_noise', params: { resolution: 16 } }, b: { type: 'box' }, s: { type: 'sphere' }, uvb: { type: 'uv_project', in: ['b'] }, uvs: { type: 'uv_project', in: ['s'] },
    t0: { type: 'texture_to_material', in: ['uvb', 'n'], params: { material: 'm', base_color: 'n' } }, t1: { type: 'texture_to_material', in: ['uvs', 'n'], params: { material: 'm', base_color: 'n' } }, both: { type: 'merge', in: ['t0', 't1'] } }, 'both');
  check(imagesOf(lod.geo).length === 1 && !lod.warnings.length, 'merging textured branches keeps one copy of their shared image');
  const clash = await cookOn(engine, { a: { type: 'tex_noise', params: { resolution: 16, name: 'x' } }, b: { type: 'tex_noise', params: { resolution: 16, name: 'x', seed: 2 } }, m: { type: 'merge', in: ['a', 'b'] } }, 'm');
  check(imagesOf(clash.geo).length === 2 && clash.warnings.some((w) => w.includes('different images share the name "x"')), 'different images under one name: both kept, merge warns');
  const tmClash = await cookErr({ a: { type: 'tex_noise', params: { resolution: 16, name: 'x' } }, b: { type: 'tex_noise', params: { resolution: 16, name: 'x', seed: 2 } }, m: { type: 'merge', in: ['a', 'b'] }, g: { type: 'box' }, t: { type: 'texture_to_material', in: ['g', 'm'], params: { base_color: 'x' } } }, 't');
  check(tmClash.includes('different images named "x"'), 'texture_to_material refuses an ambiguous image name');
  // coverage: the white fraction from the image's own histogram, whatever its range
  const narrow = { n: { type: 'tex_noise', params: { resolution: 64, seed: 3 } }, s: { type: 'tex_levels', in: ['n'], params: { out_high: 0.48 } } };
  for (const cov of [0.1, 0.3, 0.7]) {
    const r = await cookOn(engine, { ...narrow, h: { type: 'tex_histogram_scan', in: ['s'], params: { coverage: cov, contrast: 1 } } }, 'h');
    const c = findImage(r.geo)!.layer('C')!;
    const white = Array.from(c).filter((x) => x > 0.5).length / c.length;
    check(Math.abs(white - cov) < 0.01 && Math.abs(r.stats.coverage - white) < 1e-9, `coverage ${cov} on a 0..0.48 noise: ${f3(white)} white (stat ${f3(r.stats.coverage)})`);
  }
  const soft = findImage(await geo({ ...narrow, h: { type: 'tex_histogram_scan', in: ['s'], params: { coverage: 0.3, contrast: 0.6 } } }, 'h'))!.layer('C')!;
  check(Math.abs(Array.from(soft).filter((x) => x > 0.5).length / soft.length - 0.3) < 0.02, 'a soft contrast keeps the coverage around the same cut');
  const none = findImage(await geo({ ...narrow, h: { type: 'tex_histogram_scan', in: ['s'], params: { coverage: 0, contrast: 1 } } }, 'h'))!.layer('C')!;
  const all = findImage(await geo({ ...narrow, h: { type: 'tex_histogram_scan', in: ['s'], params: { coverage: 1, contrast: 1 } } }, 'h'))!.layer('C')!;
  check(none.every((x) => x === 0) && all.every((x) => x === 1), 'coverage 0 is all black, 1 all white');
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
  const crateAO = await image({ c: { type: 'topotopo/props/crate' }, uv: { type: 'uv_unwrap', in: ['c'], params: { resolution: 128 } }, ao: { type: 'bake_ao', in: ['uv'], params: { resolution: 128, samples: 16, max_distance: 0.2 } } }, 'ao');
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
  // kitbashed parts that cut into each other share no edge: the crease where they cross is concave all the same
  const kit = { b: { type: 'box' }, stud: { type: 'box', params: { size: [0.3, 0.3, 0.3], center: [0, 0.5, 0] } }, m: { type: 'merge', in: ['b', 'stud'] }, uv: { type: 'uv_unwrap', in: ['m'], params: { resolution: 128 } } };
  const crossed = await cookOn(engine, { ...kit, c: { type: 'bake_curvature', in: ['uv'], params: { resolution: 128, radius: 0.05 } } }, 'c');
  const uncrossed = await image({ ...kit, c: { type: 'bake_curvature', in: ['uv'], params: { resolution: 128, radius: 0.05, intersections: false } } }, 'c');
  check(Math.max(...findImage(crossed.geo)!.layer('concave')!) > 0.5 && crossed.stats.crossing_edges > 0 && Math.max(...uncrossed.layer('concave')!) === 0,
    `a stud sunk into a box: concave where they cross (${crossed.stats.crossing_edges} crossing edges), none with intersections off`);
  const hiKit = await image({ low: { type: 'box' }, uvl: { type: 'uv_unwrap', in: ['low'], params: { resolution: 128 } }, stud: { type: 'box', params: { size: [0.3, 0.3, 0.3], center: [0, 0.5, 0] } }, high: { type: 'merge', in: ['low', 'stud'] }, c: { type: 'bake_curvature', in: ['uvl', 'high'], params: { resolution: 128, radius: 0.05, cage: 0.2 } } }, 'c');
  check(Math.max(...hiKit.layer('concave')!) > 0.5, 'from a high mesh of crossing parts too');

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
  // import restores the images (8-bit), so a GLB round trip re-exports the same textures
  const back = await importGeometryAsync(glb, 'glb');
  const bi = imagesOf(back).map((i) => i.name).sort().join(',');
  const err8 = maxDiff(findImage(back, 'brick_color')!.layer('C')!, findImage(tg, 'brick_color')!.layer('C')!);
  check(bi === 'brick_color,brick_normal,brick_orm' && err8 <= 0.5 / 255 + 1e-6 && readMaterials(back).brick.textures?.orm === 'image:brick_orm', `glb import decodes image textures back into images (${bi}; max error ${err8.toFixed(5)})`);
  const again = await exportGeometryAsync(back, 'glb', { warn: (m) => warns.push(m) });
  check(again.byteLength > 10000 && !warns.length, 're-exporting the imported GLB embeds the textures again');
  const gltfText = new TextDecoder().decode(await exportGeometryAsync(tg, 'gltf', {}));
  check((JSON.parse(gltfText).images ?? []).length === 3 && gltfText.includes('data:image/png;base64,'), '.gltf embeds the images as data URIs (stored PNG blocks without deflate)');

  // packed instances of a textured mesh: the images live in the source, exports find them, unpacking carries them once
  const inst = await geo({ ...textured, pts: { type: 'point_grid', params: { counts: [3, 1, 1], size: [4, 0, 0] } }, cp: { type: 'copy_to_points', in: ['mat', 'pts'], params: { pack: true } } }, 'cp');
  const unpacked = await geo({ ...textured, pts: { type: 'point_grid', params: { counts: [3, 1, 1], size: [4, 0, 0] } }, cp: { type: 'copy_to_points', in: ['mat', 'pts'], params: { pack: true } }, u: { type: 'unpack', in: ['cp'] } }, 'u');
  const iw: string[] = [];
  const instGlb = await exportGeometryAsync(inst, 'glb', { warn: (m) => iw.push(m) });
  const ij = JSON.parse(new TextDecoder().decode(instGlb.subarray(20, 20 + new DataView(instGlb.buffer, instGlb.byteOffset).getUint32(12, true))));
  check(inst.numPacked === 3 && (ij.images ?? []).length === 3 && !iw.length, 'packed copies of a textured mesh export their textures (EXT_mesh_gpu_instancing)');
  check(imagesOf(unpacked).map((i) => i.name).sort().join(',') === 'brick_color,brick_normal,brick_orm' && unpacked.numPrims === 72, 'unpack carries the source images once');
  // levels of detail: textured LOD branches merged carry each map once, and the GLB holds one image per distinct map
  const lods = await geo({ ...textured, l0: { type: 'lod', in: ['mat'], params: { mode: 'switch', level: 0, levels: 2 } }, l1: { type: 'lod', in: ['mat'], params: { mode: 'switch', level: 1, levels: 2 } }, both: { type: 'merge', in: ['l0', 'l1'] } }, 'both');
  const lj = JSON.parse(new TextDecoder().decode((await exportGeometryAsync(lods, 'glb')).subarray(20, 20 + new DataView((await exportGeometryAsync(lods, 'glb')).buffer).getUint32(12, true))));
  check(imagesOf(lods).length === 3 && lj.images.length === 3 && lj.meshes.length === 2, `merged textured LODs: 3 images in the geometry and the GLB, 2 meshes (${lj.images.length} images)`);
  // two materials whose maps are the same pixels under other names: one image in the GLB
  const twin = await geo({ ...textured, copy: { type: 'tex_output', in: ['maps'], params: { image: 'brick_color', name: 'brick_color_copy', keep_only: true } }, m2: { type: 'texture_to_material', in: ['mat', 'copy'], params: { material: 'brick2', base_color: 'brick_color_copy', group: '@P.y>0' } } }, 'm2');
  const twj = JSON.parse(new TextDecoder().decode((await exportGeometryAsync(twin, 'glb')).subarray(20, 20 + new DataView((await exportGeometryAsync(twin, 'glb')).buffer).getUint32(12, true))));
  const baseTex = (n: string) => twj.materials.find((m: any) => m.name === n).pbrMetallicRoughness.baseColorTexture.index;
  check(twj.images.length === 3 && baseTex('brick') === baseTex('brick2'), 'identical pixels under two image names are written once (one texture for both materials)');
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

// ---------------------------------------------------------------- PNG files

section('image_file and the file node: PNG files as images');
{
  /** PNG bytes of interleaved samples: 1 grey, 2 grey + alpha, 3 RGB or 4 RGBA channels at 8 or 16 bits. */
  const pngOf = (w: number, h: number, ch: 1 | 2 | 3 | 4, depth: 8 | 16, s: ArrayLike<number>, idat?: Uint8Array): Uint8Array => {
    const rows = () => {
      const bps = depth / 8, stride = w * ch * bps, raw = new Uint8Array((stride + 1) * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w * ch; x++) {
          const v = s[y * w * ch + x], o = y * (stride + 1) + 1 + x * bps;
          if (depth === 16) { raw[o] = v >>> 8; raw[o + 1] = v & 255; } else raw[o] = v;
        }
      return zlib.deflateSync(raw);
    };
    const chunk = (type: string, data: Uint8Array) => {
      const c = Buffer.alloc(12 + data.length);
      c.writeUInt32BE(data.length, 0); c.write(type, 4, 'latin1'); c.set(data, 8);
      c.writeUInt32BE(zlib.crc32(c.subarray(4, 8 + data.length)), 8 + data.length);
      return c;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = [0, 0, 4, 2, 6][ch];
    return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat ?? rows()), chunk('IEND', new Uint8Array(0))]));
  };
  const put = (rel: string, bytes: Uint8Array | string) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); return rel; };
  const W = 6, H = 4, N = W * H, EPS = 1e-7;
  const seq = (ch: number, max: number, f: (i: number, c: number) => number) => Array.from({ length: N * ch }, (_, k) => Math.min(max, Math.max(0, Math.round(f(Math.floor(k / ch), k % ch)))));
  const g8 = seq(1, 255, (i) => i * 11), g16 = seq(1, 65535, (i) => i * 2711 + 7);
  const ga8 = seq(2, 255, (i, c) => (c ? 255 - i * 9 : i * 10)), rgb8 = seq(3, 255, (i, c) => [i * 10, 255 - i * 7, 40 + c * 50][c]);
  const rgba8 = seq(4, 255, (i, c) => [i * 10, 255 - i * 7, 90, 30 + i * 9][c]), rgba16 = seq(4, 65535, (i, c) => [i * 2711 + 1, 65535 - i * 1999, 12345, 30000 + i * 1000][c]);
  put('inputs/grey8.png', pngOf(W, H, 1, 8, g8)); put('inputs/grey16.png', pngOf(W, H, 1, 16, g16)); put('inputs/greyalpha.png', pngOf(W, H, 2, 8, ga8));
  put('inputs/rgb8.png', pngOf(W, H, 3, 8, rgb8)); put('inputs/rgba8.png', pngOf(W, H, 4, 8, rgba8)); put('inputs/rgba16.png', pngOf(W, H, 4, 16, rgba16));
  /** Largest |layer − want(pixel, channel)| over a W × H layer of ch channels (Infinity for another size or none). */
  const dev = (a: Float32Array | undefined, ch: number, want: (i: number, c: number) => number) => {
    if (!a || a.length !== N * ch) return Infinity;
    let m = 0;
    for (let i = 0; i < N; i++) for (let c = 0; c < ch; c++) m = Math.max(m, Math.abs(a[i * ch + c] - want(i, c)));
    return m;
  };
  const load = async (params: Record<string, any>, nodes: Record<string, NodeSpec> = {}, input?: string) => {
    const r = await cookOn(engine, { ...nodes, f: { type: 'image_file', ...(input ? { in: [input] } : {}), params } }, 'f');
    return { g: r.geo, img: imagesOf(r.geo).at(-1)!, warnings: r.warnings };
  };
  const layersOf = (img: Image) => [...img.layers.keys()].map((k) => `${k}:${img.channels(k)}`).join(' ');

  let { img } = await load({ path: 'inputs/grey8.png' });
  check(img.name === 'f' && layersOf(img) === 'C:1' && dev(img.layer('C'), 1, (i) => g8[i] / 255) < EPS, '8-bit grey: one grey layer C = samples / 255, named after its node');
  ({ img } = await load({ path: 'inputs/grey16.png' }));
  const q8 = Math.max(...Array.from(img.layer('C')!, (v) => Math.abs(v * 255 - Math.round(v * 255))));
  check(layersOf(img) === 'C:1' && dev(img.layer('C'), 1, (i) => g16[i] / 65535) < EPS && q8 > 0.2, `16-bit grey keeps its precision: samples / 65535 (up to ${q8.toFixed(2)} of an 8-bit step off the 8-bit levels)`);
  ({ img } = await load({ path: 'inputs/rgba8.png' }));
  check(layersOf(img) === 'C:4' && dev(img.layer('C'), 4, (i, c) => rgba8[i * 4 + c] / 255) < EPS, '8-bit RGBA: one RGBA layer C, alpha included');
  ({ img } = await load({ path: 'inputs/rgba16.png' }));
  check(layersOf(img) === 'C:4' && dev(img.layer('C'), 4, (i, c) => rgba16[i * 4 + c] / 65535) < EPS, '16-bit RGBA keeps its precision');
  ({ img } = await load({ path: 'inputs/rgb8.png' }));
  check(layersOf(img) === 'C:4' && dev(img.layer('C'), 4, (i, c) => (c === 3 ? 1 : rgb8[i * 3 + c] / 255)) < EPS, 'RGB: an RGBA layer C with alpha 1');
  ({ img } = await load({ path: 'inputs/greyalpha.png' }));
  check(layersOf(img) === 'C:1 A:1' && dev(img.layer('C'), 1, (i) => ga8[i * 2] / 255) < EPS && dev(img.layer('A'), 1, (i) => ga8[i * 2 + 1] / 255) < EPS, 'grey + alpha, layers auto: a grey C and the alpha in grey layer A');
  ({ img } = await load({ path: 'inputs/greyalpha.png', layers: 'rgba' }));
  check(layersOf(img) === 'C:4' && dev(img.layer('C'), 4, (i, c) => ga8[i * 2 + (c === 3 ? 1 : 0)] / 255) < EPS, 'grey + alpha, layers rgba: one RGBA layer (g, g, g, a)');
  ({ img } = await load({ path: 'inputs/grey8.png', layers: 'rgba' }));
  check(layersOf(img) === 'C:4' && dev(img.layer('C'), 4, (i, c) => (c === 3 ? 1 : g8[i] / 255)) < EPS, 'grey, layers rgba: (g, g, g, 1)');
  const rgbaImg = (await load({ path: 'inputs/rgba8.png' })).img;
  ({ img } = await load({ path: 'inputs/rgba8.png', layers: 'grey' }));
  check(layersOf(img) === 'C:1 A:1' && maxDiff(img.layer('C')!, toGrey(rgbaImg.layer('C')!, 4)) === 0 && dev(img.layer('A'), 1, (i) => rgba8[i * 4 + 3] / 255) < EPS,
    'RGBA, layers grey: C = the Rec. 709 luminance (the same bits as toGrey), A = the alpha');

  // naming: the node's name, or the name param
  put('inputs/Brick Color.v2.png', pngOf(W, H, 4, 8, rgba8));
  check((await load({ path: 'inputs/Brick Color.v2.png' })).img.name === 'f' && (await load({ path: 'inputs/rgba8.png', name: 'albedo' })).img.name === 'albedo',
    'the image is named after its node ("f"), not the file, unless name is set');

  // colour space: srgb (default) keeps the stored numbers; off encodes linear light to display values, never alpha
  const enc = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  ({ img } = await load({ path: 'inputs/greyalpha.png', srgb: false }));
  check(dev(img.layer('C'), 1, (i) => enc(ga8[i * 2] / 255)) < 1e-6 && dev(img.layer('C'), 1, (i) => ga8[i * 2] / 255) > 0.05 && dev(img.layer('A'), 1, (i) => ga8[i * 2 + 1] / 255) < EPS,
    'srgb off: grey is encoded from linear light to display values, alpha is not');
  ({ img } = await load({ path: 'inputs/rgba16.png', srgb: false }));
  check(dev(img.layer('C'), 4, (i, c) => (c === 3 ? rgba16[i * 4 + 3] / 65535 : enc(rgba16[i * 4 + c] / 65535))) < 1e-6, 'srgb off on 16-bit RGBA: RGB encoded, alpha unchanged');
  const made = findImage(await geo({ p: { type: 'tex_pattern', params: { resolution: 32 } }, n: { type: 'tex_colorize', in: ['p'], params: { ramp: [[0, '#202020'], [1, '#a5462e']], name: 'made' } } }, 'n'))!;
  put('inputs/made.png', imagePNG(made, '', (d) => zlib.deflateSync(d)));
  ({ img } = await load({ path: 'inputs/made.png' }));
  check(img.name === 'f' && Buffer.from(imagePNG(img)).equals(Buffer.from(imagePNG(made))) && maxDiff(img.layer('C')!, made.layer('C')!) <= 0.5 / 255 + 1e-6,
    'a PNG this engine wrote reads back unchanged (written again, the same bytes)');

  // chaining: input 0 carries a mesh or other images; a second image of the same name replaces the first
  const box = { b: { type: 'box' } };
  const onBox = await load({ path: 'inputs/rgba8.png' }, box, 'b');
  check(onBox.g.numPoints === 8 && onBox.g.numPrims === 6 && imagesOf(onBox.g).map((x) => x.name).join() === 'f', 'with input 0 the image is added to that geometry (the box stays)');
  let r = await load({ path: 'inputs/grey16.png' }, { a: { type: 'image_file', params: { path: 'inputs/rgba8.png' } } }, 'a');
  check(imagesOf(r.g).map((x) => `${x.name}:${x.channels('C')}`).join() === 'a:4,f:1' && !r.warnings.length, 'image_file nodes chain (a = rgba8, f = grey16)');
  r = await load({ path: 'inputs/grey8.png', name: 'a' }, { a: { type: 'image_file', params: { path: 'inputs/rgba8.png' } } }, 'a');
  check(imagesOf(r.g).length === 1 && r.img.channels('C') === 1 && r.warnings.some((w) => w.includes('replaced the input\'s image "a"')), 'an image of the same name is replaced, with a warning');

  // into the texture family and materials
  const lv = findImage(await geo({ f: { type: 'image_file', params: { path: 'inputs/rgba8.png' } }, l: { type: 'tex_levels', in: ['f'], params: { in_high: 0.5 } } }, 'l'))!;
  check(lv.name === 'l' && mean(lv.layer('C')!, 4, 0) > mean(rgbaImg.layer('C')!, 4, 0) + 0.1, 'filters process a loaded image (tex_levels), the result named after the filter');
  const tm = await geo({ ...box, uv: { type: 'uv_project', in: ['b'], params: { method: 'box' } }, albedo: { type: 'image_file', params: { path: 'inputs/rgba8.png' } }, m: { type: 'texture_to_material', in: ['uv', 'albedo'], params: { material: 'mine', base_color: 'albedo' } } }, 'm');
  check(readMaterials(tm).mine?.textures?.baseColor === 'image:albedo' && findImage(tm, 'albedo') !== null, 'texture_to_material takes it as a base colour map ("image:albedo")');
  const tv = renderGeometry((await load({ path: 'inputs/rgba8.png' })).g, { size: 128 });
  check(tv.width === 128 && !tv.notes.some((n) => n.includes('no image')), 'render draws it in the texture view');

  // the file node reads .png the same way (folders too), and importGeometry knows png
  const viaFile = findImage(await geo({ f: { type: 'file', params: { path: 'inputs/rgba8.png' } } }, 'f'))!;
  check(viaFile.name === 'rgba8' && maxDiff(viaFile.layer('C')!, rgbaImg.layer('C')!) === 0, 'file on a .png gives the pixels image_file gives with its defaults, named after the file');
  put('inputs/scan.dat', pngOf(W, H, 1, 8, g8));
  check(findImage(await geo({ f: { type: 'file', params: { path: 'inputs/scan.dat', format: 'png' } } }, 'f'))?.name === 'scan', 'format "png" reads a PNG with another extension');
  put('kit/a.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'); put('kit/b.png', pngOf(W, H, 1, 8, g8)); put('kit/c.png', 'not a png');
  const kit = await cookOn(engine, { f: { type: 'file', params: { path: 'kit' } } }, 'f');
  check(kit.geo.numPrims === 1 && kit.geo.prims.get('name')?.get(0) === 'a' && imagesOf(kit.geo).map((x) => x.name).join() === 'b' && kit.warnings.some((w) => w.includes('skipped c.png') && w.includes('bad signature')),
    `folder mode: models and PNG images; an unreadable PNG is skipped with a warning (${kit.warnings.join('; ')})`);
  const imported = importGeometry(new Uint8Array(fs.readFileSync(path.join(tmp, 'inputs/grey16.png'))), 'png', { path: 'maps/height.png' });
  check(findImage(imported)?.name === 'height' && dev(findImage(imported)!.layer('C'), 1, (i) => g16[i] / 65535) < EPS, 'importGeometry(bytes, "png") gives the image too');

  // a changed file is read again (the signature holds the file stamp)
  put('inputs/live.png', pngOf(W, H, 1, 8, g8));
  const s1 = (await load({ path: 'inputs/live.png' })).img;
  put('inputs/live.png', pngOf(3, 2, 1, 8, [0, 50, 100, 150, 200, 250]));
  const s2 = (await load({ path: 'inputs/live.png' })).img;
  check(s1.width === W && s2.width === 3 && s2.height === 2, 'editing the file re-cooks the node');

  // errors name the file and the problem
  put('inputs/fake.png', 'hello, not a PNG');
  put('inputs/cut.png', pngOf(W, H, 4, 8, rgba8).subarray(0, 60));
  put('inputs/huge.png', pngOf(5000, 5000, 1, 8, [], zlib.deflateSync(new Uint8Array(16))));
  const errOf = (p: Record<string, any>, type = 'image_file') => cookErr({ f: { type, params: p } }, 'f');
  const missing = await errOf({ path: 'inputs/missing.png' }), fake = await errOf({ path: 'inputs/fake.png' }), cut = await errOf({ path: 'inputs/cut.png' });
  const t0 = performance.now();
  const huge = await errOf({ path: 'inputs/huge.png' });
  const tHuge = performance.now() - t0;
  check(missing.includes('cannot read "inputs/missing.png"'), `a missing file: ${missing.slice(0, 100)}…`);
  check(fake.includes('"inputs/fake.png"') && fake.includes('bad signature'), `not a PNG: ${fake}`);
  check(cut.includes('"inputs/cut.png"') && cut.includes('truncated'), `a truncated PNG: ${cut}`);
  check(huge.includes('"inputs/huge.png"') && huge.includes('5000 × 5000') && tHuge < 1000, `an image over 4096 × 4096 pixels is refused before decoding (${tHuge.toFixed(0)} ms): ${huge}`);
  check((await errOf({ path: '' })).includes('path is empty'), 'an empty path says so');
  check((await errOf({ path: 'inputs/fake.png' }, 'file')).includes('"inputs/fake.png" cannot be read as a PNG image'), 'the file node reports a broken PNG with its path too');

  // the live viewer draws an image-only geometry as flat textured quads (render/texview.ts withImagePreview)
  const two = await geo({ a: { type: 'image_file', params: { path: 'inputs/rgba8.png' } }, b: { type: 'image_file', in: ['a'], params: { path: 'inputs/grey16.png' } } }, 'b');
  const quads = withImagePreview(two);
  const P = quads.P, mats = readMaterials(quads);
  const quadSize = (k: number) => [P[k * 12 + 3] - P[k * 12], P[k * 12 + 7] - P[k * 12 + 1], P[k * 12 + 2]];
  const [qw, qh, qz] = quadSize(0);
  check(quads.numPrims === 2 && quads.numPoints === 8 && Math.abs(qw - 1) < 1e-9 && Math.abs(qh - H / W) < 1e-9 && qz === 0 && quads.points.has('uv') && imagesOf(quads).length === 2,
    `two images → two quads 1 m wide and height / width tall in the XY plane (${qw.toFixed(3)} × ${qh.toFixed(3)})`);
  check(!!mats['image:a']?.unlit && mats['image:a'].textures?.baseColor === 'image:a' && quads.prims.get('material')?.get(1) === 'image:b', 'each quad has an unlit material "image:<name>" with the image as its base colour map');
  check(withImagePreview(onBox.g) === onBox.g && withImagePreview(tm) === tm, 'a geometry with points is left as it is');
  const qglb = await exportGeometryAsync(quads, 'glb', { splitByName: false });
  const qj = JSON.parse(new TextDecoder().decode(qglb.subarray(20, 20 + new DataView(qglb.buffer, qglb.byteOffset).getUint32(12, true))));
  const qreport = await validator.validateBytes(qglb);
  check(qj.images?.length === 2 && qj.materials.every((m: any) => m.extensions?.KHR_materials_unlit && m.pbrMetallicRoughness?.baseColorTexture) && qreport.issues.numErrors === 0,
    `its GLB embeds both images with unlit materials and validates (${qreport.issues.numErrors} errors)`);
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
