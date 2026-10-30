// Behavioural tests for the texture nodes that measure in metres and work on shapes and regions: SDF shapes,
// operations, booleans and rendering, bevel, distance, flood fill, slope and directional blur, the warp, edge, cells
// and tile sampler modes, curvature, AO, the histogram tools, make it tile, the normal map tools and grunge. Every node
// is checked for what it promises: values in their range, the same result at any resolution (cooked at two sizes,
// compared in metres or after averaging the larger down), seamless borders when tileable, and errors that say what to
// do.
//   node test/texnodes.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { Image, findImage, resizeLayer } from '../src/core/image.ts';
import { edt, signedDistance } from '../src/core/texsdf.ts';
import { genShape, heightFromNormal, normalFromHeight, poisson, valueRange } from '../src/core/texture.ts';
import { allNodeDefs, getNodeDef } from '../src/graph/registry.ts';
import type { NodeSpec } from '../src/graph/types.ts';

const engine = new Engine(createNodeHost({}));
await engine.init();

let fail = 0, pass = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (ok) pass++; else fail++;
};
const section = (s: string) => console.log(`\n== ${s}`);
const f3 = (x: number) => x.toFixed(3);

type Nodes = Record<string, NodeSpec>;
async function cook(nodes: Nodes, output: string): Promise<{ geo: Geometry; stats: Record<string, number>; warnings: string[] }> {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')}`);
  return { geo: r.geo, stats: (r.results.get(r.target) as any).stats ?? {}, warnings: r.warnings.map((w) => w.message) };
}
async function image(nodes: Nodes, output: string, name = output): Promise<Image> {
  const img = findImage((await cook(nodes, output)).geo, name);
  if (!img) throw new Error(`no image "${name}" in the output of ${output}`);
  return img;
}
const C = (img: Image, layer = 'C') => img.layer(layer)!;
async function cookErr(nodes: Nodes, output: string): Promise<string> {
  const r = await engine.cook({ nodes, output });
  return r.ok ? '' : r.errors.map((e) => e.message + (e.hint ? ` (${e.hint})` : '')).join('; ');
}
const range = (a: ArrayLike<number>) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < a.length; i++) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); } return [lo, hi]; };
const mean = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
const within01 = (a: ArrayLike<number>) => { const [lo, hi] = range(a); return lo >= -1e-6 && hi <= 1 + 1e-6; };
/** The pixel centre (uv) of the pixel that at() reads for (u, v). */
const centre = (img: Image, u: number, v: number): [number, number] => {
  const i = Math.min(img.width - 1, Math.floor(u * img.width)), j = Math.min(img.height - 1, Math.floor((1 - v) * img.height));
  return [(i + 0.5) / img.width, 1 - (j + 0.5) / img.height];
};
/** Distance in uv from the pixel centre at() reads for (u, v) to the point (x, y). */
const dist = (img: Image, u: number, v: number, x = 0.5, y = 0.5) => { const [a, b] = centre(img, u, v); return Math.hypot(a - x, b - y); };
const at = (img: Image, u: number, v: number, layer = 'C', c = 0) => {
  const ch = img.channels(layer), i = Math.min(img.width - 1, Math.floor(u * img.width)), j = Math.min(img.height - 1, Math.floor((1 - v) * img.height));
  return C(img, layer)[(j * img.width + i) * ch + c];
};
/** Mean jump across the left/right seam over the mean jump between neighbouring columns (≈ 1 when seamless). */
function seamU(a: Float32Array, w: number, h: number, ch = 1): number {
  let seam = 0, inner = 0;
  for (let j = 0; j < h; j++)
    for (let c = 0; c < ch; c++) {
      seam += Math.abs(a[(j * w) * ch + c] - a[(j * w + w - 1) * ch + c]);
      for (let i = 0; i + 1 < w; i++) inner += Math.abs(a[(j * w + i) * ch + c] - a[(j * w + i + 1) * ch + c]);
    }
  return seam / h / (inner / (h * (w - 1)) || 1e-9);
}
/** The same across the top/bottom seam. */
function seamV(a: Float32Array, w: number, h: number, ch = 1): number {
  let seam = 0, inner = 0;
  for (let i = 0; i < w; i++)
    for (let c = 0; c < ch; c++) {
      seam += Math.abs(a[i * ch + c] - a[((h - 1) * w + i) * ch + c]);
      for (let j = 0; j + 1 < h; j++) inner += Math.abs(a[(j * w + i) * ch + c] - a[((j + 1) * w + i) * ch + c]);
    }
  return seam / w / (inner / (w * (h - 1)) || 1e-9);
}
/** The worse of the two seam ratios: about 1 for a seamless image (up to 2 for hard-edged ones), far more at a seam. */
const seamless = (img: Image, layer = 'C') => {
  const ch = img.channels(layer);
  return Math.max(seamU(C(img, layer), img.width, img.height, ch), seamV(C(img, layer), img.width, img.height, ch));
};
/**
 * A filter respects tileable when it treats the border like any other place: shifting its inputs by half the image
 * (tex_transform, exact on even sizes) shifts its output by the same amount. Returns the largest difference between
 * the filtered shifted inputs and the shifted filtered output (0 when the filter wraps exactly).
 */
async function shiftDiff(nodes: Nodes, inputs: string[], out: string, layer = 'C'): Promise<number> {
  const a = await image(nodes, out);
  const shifted: Nodes = {};
  for (const [k, spec] of Object.entries(nodes)) {
    const ins = Array.isArray(spec.in) ? spec.in.map((x) => (x && inputs.includes(x) ? `${x}__shift` : x)) : spec.in;
    shifted[k] = { ...spec, ...(ins ? { in: ins } : {}) };
  }
  for (const k of inputs) shifted[`${k}__shift`] = { type: 'tex_transform', in: [k], params: { offset: [0.5, 0.5], name: k } };
  const b = await image(shifted, out);
  const w = a.width, h = a.height, ch = a.channels(layer), A = C(a, layer), B = C(b, layer);
  let m = 0;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++)
      for (let c = 0; c < ch; c++) {
        const sj = (j + h / 2) % h, si = (i + w / 2) % w;
        m = Math.max(m, Math.abs(B[(sj * w + si) * ch + c] - A[(j * w + i) * ch + c]));
      }
  return m;
}

/**
 * Cook a graph built for resolution r at r1 and r2 = 2 r1 and compare the result: the larger is averaged down to r1
 * (2 × 2 pixels → 1), then the mean and the largest absolute difference per value.
 */
async function resolutionDiff(build: (r: number) => Nodes, out: string, layer = 'C', r1 = 128): Promise<{ meanDiff: number; maxDiff: number }> {
  const a = await image(build(r1), out), b = await image(build(r1 * 2), out);
  const ch = a.channels(layer);
  const bd = resizeLayer(C(b, layer), ch, b.width, b.height, a.width, a.height, true), ad = C(a, layer);
  let s = 0, m = 0;
  for (let i = 0; i < ad.length; i++) { const d = Math.abs(ad[i] - bd[i]); s += d; m = Math.max(m, d); }
  return { meanDiff: s / ad.length, maxDiff: m };
}

// ---------------------------------------------------------------- registry

section('registry');
const NEW = ['tex_sdf_shape', 'tex_grunge', 'tex_directional_blur', 'tex_slope_blur', 'tex_histogram_range', 'tex_histogram_select', 'tex_auto_levels',
  'tex_clamp', 'tex_quantize', 'tex_normal_normalize', 'tex_normal_invert', 'tex_height_from_normal', 'tex_curvature', 'tex_ao', 'tex_sdf_from_mask',
  'tex_sdf_op', 'tex_sdf_boolean', 'tex_sdf_to_mask', 'tex_bevel', 'tex_distance', 'tex_flood_fill', 'tex_make_tile'];
{
  const missing = NEW.filter((t) => getNodeDef(t)?.category !== 'texture');
  check(!missing.length, `${NEW.length} nodes registered in category texture${missing.length ? ': missing ' + missing.join(', ') : ''}`);
  const names: [string, string][] = [['slope_blur', 'tex_slope_blur'], ['flood_fill', 'tex_flood_fill'], ['make_it_tile', 'tex_make_tile'], ['posterize', 'tex_quantize'],
    ['auto_levels', 'tex_auto_levels'], ['normal_to_height', 'tex_height_from_normal'], ['motion_blur', 'tex_directional_blur'], ['gtao', 'tex_ao'],
    ['sdf_from_mono', 'tex_sdf_from_mask'], ['histogram_select', 'tex_histogram_select'], ['non_uniform_directional_warp', 'tex_warp']];
  const bad = names.filter(([a, t]) => getNodeDef(a)?.type !== t).map(([a]) => a);
  check(!bad.length, `Substance / COP names resolve to the new nodes${bad.length ? ': ' + bad.join(', ') : ''}`);
  // every node whose distances are physical says so with the same size param as tex_normal_from_height
  const sized = allNodeDefs().filter((d) => NEW.includes(d.type) && d.params.size).map((d) => d.type);
  const off = sized.filter((t) => getNodeDef(t)!.params.size.default !== 1 || getNodeDef(t)!.params.size.type !== 'float');
  check(sized.length >= 12 && !off.length, `${sized.length} new nodes take size (metres the image width covers, default 1)`);
  // filters name their result after the node
  const img = await image({ n: { type: 'tex_noise', params: { resolution: 32 } }, rust_mask: { type: 'tex_histogram_select', in: ['n'] } }, 'rust_mask');
  check(img.name === 'rust_mask', 'a filter\'s result is named after the node');
}

// ---------------------------------------------------------------- distance transform and SDF from a mask

section('signed distance');
{
  // exact transform against brute force, with and without wrap
  const w = 23, h = 17, sites = new Uint8Array(w * h);
  for (const k of [3, 50, 200, 377, 390]) sites[k] = 1;
  let bad = 0;
  for (const wrap of [false, true]) {
    const { d2, nearest } = edt(sites, w, h, wrap);
    for (let k = 0; k < w * h; k++) {
      let best = Infinity;
      for (let s = 0; s < w * h; s++) {
        if (!sites[s]) continue;
        let dx = Math.abs((k % w) - (s % w)), dy = Math.abs(Math.floor(k / w) - Math.floor(s / w));
        if (wrap) { dx = Math.min(dx, w - dx); dy = Math.min(dy, h - dy); }
        best = Math.min(best, dx * dx + dy * dy);
      }
      if (d2[k] !== best || !sites[nearest[k]]) bad++;
    }
  }
  check(!bad, 'the distance transform is exact (brute force, clamped and wrapped)');
  // an antialiased disc: distances to a tenth of a pixel, the same in uv at any resolution
  for (const W of [48, 256]) {
    const m = genShape({ shape: 'disc', size: 0.6, sides: 6, inner: 0.5, rotation: 0, falloff: 0, tile: [1, 1] }, W, W);
    const d = signedDistance(m, W, W, 0.5, false);
    let sum = 0, mx = 0;
    for (let j = 0; j < W; j++)
      for (let i = 0; i < W; i++) {
        const exact = (Math.hypot((i + 0.5) / W - 0.5, (j + 0.5) / W - 0.5) - 0.3) * W;
        const e = Math.abs(d[j * W + i] - exact);
        sum += e; mx = Math.max(mx, e);
      }
    check(sum / (W * W) < 0.06 && mx < 0.3, `disc at ${W}²: mean error ${f3(sum / (W * W))} px, max ${f3(mx)} px`);
  }
  // the node: metres, negative inside, tiles across the border
  const sdf = await image({ m: { type: 'tex_shape', params: { resolution: 128, shape: 'disc', size: 0.5 } }, s: { type: 'tex_sdf_from_mask', in: ['m'], params: { size: 2 } } }, 's');
  // disc radius 0.25 of the image = 0.5 m at size 2; centre is 0.5 m inside, a corner √2 m − 0.5 m away
  check(Math.abs(at(sdf, 0.5, 0.5) + 0.5) < 0.02 && Math.abs(C(sdf)[0] - (Math.SQRT2 - 0.5)) < 0.02, `tex_sdf_from_mask in metres: centre ${f3(at(sdf, 0.5, 0.5))} (−0.5), corner ${f3(C(sdf)[0])} (${f3(Math.SQRT2 - 0.5)})`);
  const rd = await resolutionDiff((r) => ({ m: { type: 'tex_shape', params: { resolution: r, shape: 'star', size: 0.7 } }, s: { type: 'tex_sdf_from_mask', in: ['m'] } }), 's');
  check(rd.meanDiff < 0.002, `tex_sdf_from_mask: 128² vs 256² differ by ${rd.meanDiff.toExponential(2)} m on average`);
  const sm = await shiftDiff({ m: { type: 'tex_shape', params: { resolution: 128, shape: 'star', size: 0.9, tile: [2, 2] } }, s: { type: 'tex_sdf_from_mask', in: ['m'] }, r: { type: 'tex_sdf_op', in: ['s'], params: { mode: 'round', amount: 0.03 } } }, ['m'], 'r');
  check(sm < 1e-5, `distances (and a round, which measures again) wrap exactly (${sm.toExponential(1)})`);
}

// ---------------------------------------------------------------- SDF shapes, operations and booleans

section('SDF shapes, operations, booleans, rendering');
{
  const disc = await image({ s: { type: 'tex_sdf_shape', params: { resolution: 129, shape: 'disc', radius: 0.2, size: 2, tileable: false } } }, 's');
  // radius 0.2 m on a 2 m image: the centre pixel −0.2, the corner pixel its distance to the centre − 0.2
  const cornerD = dist(disc, 0, 1) * 2 - 0.2;
  check(Math.abs(at(disc, 0.5, 0.5) + 0.2) < 1e-6 && Math.abs(at(disc, 0, 1) - cornerD) < 1e-5, `disc SDF in metres: centre ${f3(at(disc, 0.5, 0.5))} (−0.2), corner ${f3(at(disc, 0, 1))} (${f3(cornerD)})`);
  const grid = await image({ s: { type: 'tex_sdf_shape', params: { resolution: 128, shape: 'box', extent: [0.3, 0.2], corner: 0.04, tile: [3, 2], rotation: 20 } } }, 's');
  check(seamless(grid) < 2, `a tiled SDF shape tiles (seam ratio ${f3(seamless(grid))})`);
  const rd = await resolutionDiff((r) => ({ s: { type: 'tex_sdf_shape', params: { resolution: r, shape: 'star', radius: 0.35, sides: 5, tile: [2, 2] } } }), 's');
  check(rd.maxDiff < 0.004, `tex_sdf_shape: 128² vs 256² differ by at most ${rd.maxDiff.toExponential(2)} m (a texel is ${1 / 128} m)`);
  // rounded box: a corner rounded by c sits c·(√2 − 1) further from the corner point than the sharp one
  const sharp = await image({ s: { type: 'tex_sdf_shape', params: { resolution: 101, shape: 'box', extent: [0.5, 0.5], tileable: false } } }, 's');
  const round = await image({ s: { type: 'tex_sdf_shape', params: { resolution: 101, shape: 'box', extent: [0.5, 0.5], corner: 0.1, tileable: false } } }, 's');
  check(Math.abs(at(sharp, 0.5, 0.5) + 0.25) < 1e-6 && Math.abs(at(round, 0.5, 0.5) + 0.25) < 1e-6, 'box: the middle is half the extent inside, rounded or not');

  const base = (op: Record<string, any>): Nodes => ({ d: { type: 'tex_sdf_shape', params: { resolution: 129, shape: 'disc', radius: 0.2, tileable: false } }, o: { type: 'tex_sdf_op', in: ['d'], params: { tileable: false, ...op } } });
  const grown = await image(base({ mode: 'offset', amount: 0.05 }), 'o');
  check(Math.abs(at(grown, 0.5, 0.5) + 0.25) < 1e-4, `offset grows the disc by 0.05 m (centre ${f3(at(grown, 0.5, 0.5))})`);
  const ring = await image(base({ mode: 'stroke', amount: 0.04 }), 'o');
  const onRing = Math.abs(dist(ring, 0.5, 0.7) - 0.2) - 0.02;
  check(Math.abs(at(ring, 0.5, 0.7) - onRing) < 1e-5 && Math.abs(at(ring, 0.5, 0.5) - 0.18) < 1e-5, `stroke: a band 0.04 m wide on the outline (on it ${f3(at(ring, 0.5, 0.7))}, centre ${f3(at(ring, 0.5, 0.5))})`);
  const inv = await image(base({ mode: 'invert' }), 'o');
  check(Math.abs(at(inv, 0.5, 0.5) - 0.2) < 1e-4, 'invert swaps inside and outside');
  // round: a square's corner moves inward, its sides stay; redistance of an exact field changes it by under a texel
  const sq = (op: Record<string, any>): Nodes => ({ d: { type: 'tex_sdf_shape', params: { resolution: 128, shape: 'box', extent: [0.5, 0.5], tileable: false } }, o: { type: 'tex_sdf_op', in: ['d'], params: { tileable: false, ...op } } });
  const rounded = await image(sq({ mode: 'round', amount: 0.1 }), 'o'), red = await image(sq({ mode: 'redistance' }), 'o');
  const cornerUV = 0.5 + 0.25 - 0.01; // just inside the corner along the diagonal
  check(at(rounded, cornerUV, cornerUV) > 0 && Math.abs(at(rounded, 0.5, 0.74) - at(sharp, 0.5, 0.74)) < 0.01, `round cuts the corner (corner ${f3(at(rounded, cornerUV, cornerUV))} > 0) and keeps the sides`);
  const exact = await image(sq({ mode: 'offset', amount: 0 }), 'o');
  let mx = 0;
  for (let k = 0; k < C(red).length; k++) mx = Math.max(mx, Math.abs(C(red)[k] - C(exact)[k]));
  check(mx < 0.5 / 128, `redistance of an exact field moves it by at most ${mx.toExponential(2)} m`);

  const two = (mode: string, extra: Record<string, any> = {}): Nodes => ({
    a: { type: 'tex_sdf_shape', params: { resolution: 128, shape: 'disc', radius: 0.2, center: [0.4, 0.5], tileable: false } },
    b: { type: 'tex_sdf_shape', params: { resolution: 128, shape: 'disc', radius: 0.2, center: [0.6, 0.5], tileable: false } },
    o: { type: 'tex_sdf_boolean', in: ['a', 'b'], params: { mode, ...extra } },
  });
  const A = await image(two('union'), 'a'), B = await image(two('union'), 'b');
  const U = await image(two('union'), 'o'), S = await image(two('subtract'), 'o'), I = await image(two('intersect'), 'o'), X = await image(two('xor'), 'o');
  let ok = true;
  for (let k = 0; k < C(U).length; k++) {
    const a = C(A)[k], b = C(B)[k];
    if (Math.abs(C(U)[k] - Math.min(a, b)) > 1e-6 || Math.abs(C(S)[k] - Math.max(a, -b)) > 1e-6 || Math.abs(C(I)[k] - Math.max(a, b)) > 1e-6) ok = false;
    if ((C(X)[k] < 0) !== ((a < 0) !== (b < 0)) && Math.abs(a) > 1e-3 && Math.abs(b) > 1e-3) ok = false;
  }
  check(ok, 'union, subtract, intersect are min / max of the fields; xor is inside one but not both');
  const SU = await image(two('union', { smoothness: 0.1 }), 'o');
  check(at(SU, 0.5, 0.71) < at(U, 0.5, 0.71) - 0.005, `smooth union fills the waist between the discs (${f3(at(SU, 0.5, 0.71))} < ${f3(at(U, 0.5, 0.71))})`);
  const M = await image(two('morph', { amount: 0.5 }), 'o');
  check(Math.abs(at(M, 0.5, 0.5) - (at(A, 0.5, 0.5) + at(B, 0.5, 0.5)) / 2) < 1e-6, 'morph mixes the fields');

  // rendering: fill covers the disc's area, outline is width wide, bevel 0 → 1, distance 0.5 on the outline
  const rend = (mode: string, extra: Record<string, any> = {}): Nodes => ({ d: { type: 'tex_sdf_shape', params: { resolution: 128, shape: 'disc', radius: 0.3, tileable: false } }, o: { type: 'tex_sdf_to_mask', in: ['d'], params: { mode, ...extra } } });
  const fill = await image(rend('fill'), 'o'), bevAt = (img: Image, u: number, v: number) => Math.min(1, Math.max(0, (0.3 - dist(img, u, v)) / 0.1));
  check(Math.abs(mean(C(fill)) - Math.PI * 0.09) < 0.002, `fill covers π r² (${f3(mean(C(fill)))} vs ${f3(Math.PI * 0.09)})`);
  const outline = await image(rend('outline', { width: 0.05 }), 'o');
  check(Math.abs(mean(C(outline)) - 2 * Math.PI * 0.3 * 0.05) < 0.003, `outline covers its band (${f3(mean(C(outline)))} vs ${f3(2 * Math.PI * 0.3 * 0.05)})`);
  const bev = await image(rend('bevel', { width: 0.1, profile: 'linear' }), 'o');
  check(Math.abs(at(bev, 0.5, 0.5) - 1) < 1e-6 && Math.abs(at(bev, 0.5, 0.75) - bevAt(bev, 0.5, 0.75)) < 1e-4 && at(bev, 0.02, 0.02) === 0, `bevel: 1 on the plateau, ${f3(at(bev, 0.5, 0.75))} a quarter of the way in (${f3(bevAt(bev, 0.5, 0.75))}), 0 outside`);
  const enc = await image(rend('distance', { width: 0.1 }), 'o');
  check(Math.abs(at(enc, 0.5, 0.8) - (0.5 - (dist(enc, 0.5, 0.8) - 0.3) / 0.2)) < 1e-4 && at(enc, 0.5, 0.5) === 1 && C(enc)[0] === 0, 'distance encoding: 0.5 on the outline, 1 inside, 0 far outside');
  const rr = await resolutionDiff((r) => ({ d: { type: 'tex_sdf_shape', params: { resolution: r, shape: 'polygon', radius: 0.35, sides: 6 } }, o: { type: 'tex_sdf_to_mask', in: ['d'], params: { mode: 'bevel', width: 0.05 } } }), 'o');
  check(rr.meanDiff < 0.004, `tex_sdf_to_mask bevel: 128² vs 256² differ by ${f3(rr.meanDiff)} on average`);
}

// ---------------------------------------------------------------- bevel and distance

section('bevel and distance');
{
  const tiles = (r: number, extra: Record<string, any> = {}): Nodes => ({
    t: { type: 'tex_pattern', params: { resolution: r, pattern: 'tiles', count: [4, 4], gap: 0.1, bevel: 0 } },
    b: { type: 'tex_bevel', in: ['t'], params: { distance: 0.03, ...extra } },
  });
  const b = await image(tiles(128), 'b');
  check(within01(C(b)) && range(C(b))[1] === 1, 'bevel stays in 0..1 and reaches the plateau');
  const sb = await shiftDiff(tiles(128), ['t'], 'b');
  check(sb < 1e-5, `bevel wraps at the borders like anywhere else (shifted by half: ${sb.toExponential(1)})`);
  // a point sample against a 2 × 2 average of a curved profile differs by about f''·texel² / 24: ~0.015 here
  const rd = await resolutionDiff((r) => tiles(r), 'b');
  check(rd.meanDiff < 0.015, `bevel smooth: 128² vs 256² differ by ${f3(rd.meanDiff)} on average`);
  // round rises vertically at the outline, so edge pixels differ more between resolutions
  const rdr = await resolutionDiff((r) => tiles(r, { profile: 'round' }), 'b');
  check(rdr.meanDiff < 0.03, `bevel round: 128² vs 256² differ by ${f3(rdr.meanDiff)} on average`);
  // the bevel is 0.03 m wide (linear): the tile edge is at u = 0.0125 (gap 0.1 × 0.25 / 2)
  const lin = await image(tiles(256, { profile: 'linear' }), 'b');
  const want = (centre(lin, 0.0275, 0.125)[0] - 0.0125) / 0.03;
  check(Math.abs(at(lin, 0.0275, 0.125) - want) < 0.03, `linear bevel: ${f3(at(lin, 0.0275, 0.125))} at ${f3(want * 0.03)} m in (${f3(want)})`);
  const out = await image(tiles(128, { distance: -0.02 }), 'b');
  check(at(out, 0.125, 0.125) === 1 && at(out, 0.0, 0.125) > 0 && at(out, 0.0, 0.125) < 1, 'a negative distance bevels outward: 1 inside, a falloff in the gaps');

  const disc = (r: number, extra: Record<string, any> = {}): Nodes => ({
    s: { type: 'tex_sdf_shape', params: { resolution: r, shape: 'disc', radius: 0.1, tileable: false } },
    m: { type: 'tex_sdf_to_mask', in: ['s'] },
    d: { type: 'tex_distance', in: ['m'], params: { distance: 0.1, tileable: false, ...extra } },
  });
  const g = await image(disc(128), 'd');
  const half = 1 - (dist(g, 0.65, 0.5) - 0.1) / 0.1;
  check(at(g, 0.5, 0.5) === 1 && Math.abs(at(g, 0.65, 0.5) - half) < 0.01 && C(g)[0] === 0, `gradient: 1 inside, ${f3(at(g, 0.65, 0.5))} about halfway out (${f3(half)}), 0 beyond`);
  const grown = await image(disc(128, { mode: 'grow' }), 'd');
  check(Math.abs(mean(C(grown)) - Math.PI * 0.04) < 0.003, `grow by 0.1 m: a disc of 0.2 m (${f3(mean(C(grown)))} vs ${f3(Math.PI * 0.04)})`);
  const rg = await resolutionDiff((r) => disc(r), 'd');
  check(rg.meanDiff < 0.003, `distance gradient: 128² vs 256² differ by ${f3(rg.meanDiff)} on average`);
  const sdd = await shiftDiff({ t: { type: 'tex_pattern', params: { resolution: 128, pattern: 'dots', count: [3, 3] } }, d: { type: 'tex_distance', in: ['t'], params: { distance: 0.1 } } }, ['t'], 'd');
  check(sdd < 1e-5, `distance wraps exactly (${sdd.toExponential(1)})`);
  // a source's values are carried out of the mask, and nowhere beyond the distance
  const src = await cook({
    b: { type: 'tex_pattern', params: { resolution: 128, count: [4, 8], gap: 0.2, bevel: 0 } },
    f: { type: 'tex_flood_fill', in: ['b'], params: { output: 'color', name: 'f' } },
    d: { type: 'tex_distance', in: ['b', 'f'], params: { distance: 0.02 } },
  }, 'd');
  const di = findImage(src.geo, 'd')!;
  check(di.channels('C') === 4 && di.channels('mask') === 1, 'with a source: C takes its channels, layer mask holds the grown mask');
  const fi = await image({ b: { type: 'tex_pattern', params: { resolution: 128, count: [4, 8], gap: 0.2, bevel: 0 } }, f: { type: 'tex_flood_fill', in: ['b'], params: { output: 'color' } } }, 'f');
  let filled = 0, gaps = 0, bad = 0;
  for (let k = 0; k < fi.count; k++) {
    if (C(fi)[k * 4 + 3] > 0) continue; // a gap pixel of the flood fill
    gaps++;
    if (C(di)[k * 4 + 3] > 0) filled++;
    if (C(di)[k * 4 + 3] > 0 && C(di, 'mask')[k] === 0) bad++;
  }
  check(filled > gaps * 0.5 && !bad, `per-tile colours bleed into ${filled} of ${gaps} gap pixels, only within the distance`);
}

// ---------------------------------------------------------------- flood fill

section('flood fill');
{
  const bricks = (r: number, extra: Record<string, any> = {}, pat: Record<string, any> = {}): Nodes => ({
    b: { type: 'tex_pattern', params: { resolution: r, pattern: 'bricks', count: [4, 8], gap: 0.15, bevel: 0, ...pat } },
    f: { type: 'tex_flood_fill', in: ['b'], params: extra },
  });
  const wrapped = await cook(bricks(128), 'f'), open = await cook(bricks(128, { tileable: false }), 'f');
  // 4 × 8 bricks; rows with an offset have a brick cut by the border: one tile when it wraps, two when it does not
  check(wrapped.stats.tiles === 32 && open.stats.tiles === 36, `tiles: ${wrapped.stats.tiles} wrapped (32), ${open.stats.tiles} not (36)`);
  const img = findImage(wrapped.geo, 'f')!;
  // row 1 is offset: its first brick is centred on the border
  const v1 = 1 - 1.5 / 8;
  check(at(img, 0.01, v1) === at(img, 0.99, v1) && at(img, 0.01, v1, 'id') > 0, 'a brick across the border is one tile with one random value');
  const sg = await shiftDiff(bricks(128, { output: 'gradient', angle: 30 }), ['b'], 'f');
  check(sg < 1e-5, `gradients wrap at the borders like anywhere else (${sg.toExponential(1)})`);
  check(img.channels('id') === 1 && within01(C(img)), 'random: 0..1 per tile, with layer id');
  // the random value of a tile does not depend on the resolution
  const lo = findImage((await cook(bricks(96), 'f')).geo, 'f')!, hi = findImage((await cook(bricks(320), 'f')).geo, 'f')!;
  let same = 0, total = 0;
  for (let cy = 0; cy < 8; cy++)
    for (let cx = 0; cx < 4; cx++) {
      const u = (cx + (cy & 1 ? 0.95 : 0.45)) / 4, v = 1 - (cy + 0.5) / 8; // a point well inside each brick
      total++;
      if (Math.abs(at(lo, u % 1, v) - at(hi, u % 1, v)) < 1e-6) same++;
    }
  check(same === total, `every brick keeps its random value at 96² and 320² (${same} of ${total})`);
  // gradient spans each tile 0 → 1 along the angle
  const grad = await image(bricks(128, { output: 'gradient', angle: 0 }), 'f');
  check(at(grad, 0.27, 0.5 - 1 / 16) < 0.2 && at(grad, 0.48, 0.5 - 1 / 16) > 0.8, `gradient rises across a brick along +u (${f3(at(grad, 0.27, 0.5 - 1 / 16))} → ${f3(at(grad, 0.48, 0.5 - 1 / 16))})`);
  const vert = await image(bricks(128, { output: 'gradient', angle: 90 }), 'f');
  check(at(vert, 0.375, 1 - 0.02) > 0.6 && at(vert, 0.375, 1 - 0.105) < 0.4, 'gradient at 90° rises along +v');
  // bbox size in metres: a brick is 0.25 × 0.125 of the image less the mortar (0.15 × 0.125 / 2 a side): 0.4625 m at size 2
  const bb = await image(bricks(128, { output: 'bbox_size', size: 2 }), 'f');
  check(Math.abs(at(bb, 0.125, 1 - 0.0625) - 0.4625) < 0.02, `bbox_size in metres (${f3(at(bb, 0.125, 1 - 0.0625))} for a 0.4625 m brick)`);
  const pos = await image(bricks(128, { output: 'position' }), 'f');
  check(Math.abs(at(pos, 0.1, 1 - 0.0625, 'C', 0) - 0.125) < 0.01 && Math.abs(at(pos, 0.1, 1 - 0.0625, 'C', 1) - (1 - 0.0625)) < 0.01, 'position: the tile\'s centre in uv');
  const col = await image(bricks(128, { output: 'color' }), 'f');
  check(col.channels('C') === 4 && at(col, 0.001, 1 - 0.0625, 'C', 3) === 0 && at(col, 0.125, 1 - 0.0625, 'C', 3) === 1, 'color: RGBA, alpha 1 on the tiles, 0 in the mortar');
  const none = await cook({ c: { type: 'tex_constant', params: { resolution: 16, value: 0.2 } }, f: { type: 'tex_flood_fill', in: ['c'] } }, 'f');
  check(none.stats.tiles === 0 && none.warnings.some((w) => /no tiles/.test(w)), 'a mask below threshold warns: no tiles');
}

// ---------------------------------------------------------------- blurs and warps

section('directional and slope blur, warps');
{
  const noise = (r: number): NodeSpec => ({ type: 'tex_noise', params: { resolution: r, scale: 16, octaves: 3, seed: 2 } });
  const db = (r: number, extra: Record<string, any> = {}): Nodes => ({ n: noise(r), b: { type: 'tex_directional_blur', in: ['n'], params: { length: 0.1, ...extra } } });
  const n = await image({ n: noise(128) }, 'n'), b = await image(db(128), 'b');
  check(Math.abs(mean(C(b)) - mean(C(n))) < 1e-4, 'directional blur keeps the mean (it wraps)');
  // horizontal blur: rows smoother than columns
  const rowVar = (img: Image, horizontal: boolean) => { let s = 0; const w = img.width; for (let j = 0; j < w; j++) for (let i = 0; i + 1 < w; i++) s += Math.abs(horizontal ? C(img)[j * w + i] - C(img)[j * w + i + 1] : C(img)[i * w + j] - C(img)[(i + 1) * w + j]); return s; };
  check(rowVar(b, true) < rowVar(b, false) * 0.5, `angle 0 smears along u only (${f3(rowVar(b, true) / rowVar(b, false))} of the change across rows)`);
  const sd = await shiftDiff(db(128, { angle: 30 }), ['n'], 'b');
  check(sd < 1e-5, `directional blur wraps exactly (${sd.toExponential(1)})`);
  const rd = await resolutionDiff((r) => db(r, { angle: 30 }), 'b');
  check(rd.meanDiff < 0.01, `directional blur in metres: 128² vs 256² differ by ${f3(rd.meanDiff)}`);
  const one = await image({ s: { type: 'tex_sdf_shape', params: { resolution: 128, shape: 'disc', radius: 0.03 } }, m: { type: 'tex_sdf_to_mask', in: ['s'] }, b: { type: 'tex_directional_blur', in: ['m'], params: { length: 0.2, symmetric: false } } }, 'b');
  check(at(one, 0.6, 0.5) > 0.05 && at(one, 0.4, 0.5) === 0, 'one-sided: a dot trails along the angle only');

  const sb = (r: number, slope: NodeSpec, extra: Record<string, any> = {}): Nodes => ({
    d: { type: 'tex_sdf_shape', params: { resolution: r, shape: 'disc', radius: 0.25 } }, m: { type: 'tex_sdf_to_mask', in: ['d'] },
    s: slope, b: { type: 'tex_slope_blur', in: ['m', 's'], params: { distance: 0.05, ...extra } },
  });
  const flat = await image(sb(64, { type: 'tex_constant', params: { resolution: 64, value: 0.4 } }), 'b'), mask = await image(sb(64, { type: 'tex_constant', params: { resolution: 64 } }), 'm');
  let same = true;
  for (let k = 0; k < C(flat).length; k++) if (Math.abs(C(flat)[k] - C(mask)[k]) > 1e-6) same = false;
  check(same, 'a flat slope map leaves the image as it is');
  const mn = await image(sb(128, { type: 'tex_noise', params: { resolution: 128, scale: 8, seed: 3 } }, { mode: 'min' }), 'b');
  const mx = await image(sb(128, { type: 'tex_noise', params: { resolution: 128, scale: 8, seed: 3 } }, { mode: 'max' }), 'b');
  const m0 = mean(C(await image(sb(128, { type: 'tex_constant', params: { resolution: 128 } }), 'm')));
  check(mean(C(mn)) < m0 - 0.005 && mean(C(mx)) > m0 + 0.005, `min erodes (${f3(mean(C(mn)))}), max grows (${f3(mean(C(mx)))}) the disc (${f3(m0)})`);
  const rs = await resolutionDiff((r) => sb(r, { type: 'tex_noise', params: { resolution: r, scale: 6, seed: 3 } }), 'b');
  check(rs.meanDiff < 0.01, `slope blur in metres: 128² vs 256² differ by ${f3(rs.meanDiff)}`);
  const ss = await shiftDiff(sb(128, { type: 'tex_noise', params: { resolution: 128, scale: 6, seed: 3 } }), ['d', 's'], 'b');
  check(ss < 1e-5, `slope blur wraps exactly (${ss.toExponential(1)})`);

  const warp = (mode: string, extra: Record<string, any> = {}, angleMap?: NodeSpec): Nodes => ({
    c: { type: 'tex_pattern', params: { resolution: 128, pattern: 'checker', count: [8, 8] } },
    n: { type: 'tex_noise', params: { resolution: 128, scale: 3 } },
    ...(angleMap ? { a: angleMap } : {}),
    w: { type: 'tex_warp', in: angleMap ? ['c', 'n', 'a'] : ['c', 'n'], params: { mode, intensity: 0.04, angle: 30, ...extra } },
  });
  const dir = await image(warp('directional'), 'w'), nu0 = await image(warp('nonuniform', {}, { type: 'tex_constant', params: { resolution: 128, value: 0 } }), 'w');
  let eq = 0;
  for (let k = 0; k < C(dir).length; k++) eq = Math.max(eq, Math.abs(C(dir)[k] - C(nu0)[k]));
  check(eq < 1e-6, 'nonuniform with an angle map of 0 is the directional warp');
  const nu = await image(warp('nonuniform', {}, { type: 'tex_noise', params: { resolution: 128, scale: 2, seed: 9 } }), 'w');
  const snu = await shiftDiff(warp('nonuniform', {}, { type: 'tex_noise', params: { resolution: 128, scale: 2, seed: 9 } }), ['c', 'n', 'a'], 'w');
  check(snu < 1e-5 && within01(C(nu)), `nonuniform warp wraps exactly (${snu.toExponential(1)})`);
  const multi = await image(warp('multi', { directions: 6 }), 'w');
  const smu = await shiftDiff(warp('multi', { directions: 6 }), ['c', 'n'], 'w');
  check(within01(C(multi)) && smu < 1e-5, `multi averages its directions and wraps exactly (${smu.toExponential(1)})`);
  const err = await cookErr(warp('nonuniform'), 'w');
  check(/angle map on input 2/.test(err) && /directional/.test(err), `nonuniform without an angle map says what to connect: ${err}`);
}

// ---------------------------------------------------------------- edges, cells and the tile sampler

section('edge lines, crystal cells, tile sampler');
{
  const edge = (r: number, mode: string, extra: Record<string, any> = {}): Nodes => ({
    t: { type: 'tex_pattern', params: { resolution: r, pattern: 'tiles', count: [4, 4], gap: 0.2, bevel: 0 } },
    e: { type: 'tex_edge_detect', in: ['t'], params: { mode, line_width: 0.01, ...extra } },
  });
  // tiles 4 × 4: 16 squares 0.2 m wide (0.25 − 0.05 gap), outline length 16 × 0.8 m; a 0.01 m line covers 0.128
  const o = await image(edge(256, 'outline'), 'e');
  check(Math.abs(mean(C(o)) - 0.128) < 0.006, `outline: line_width in metres (${f3(mean(C(o)))} covered, 0.128 expected)`);
  const rd = await resolutionDiff((r) => edge(r, 'outline'), 'e');
  const so = await shiftDiff(edge(128, 'outline'), ['t'], 'e');
  check(rd.meanDiff < 0.02 && so < 1e-5, `outline: the same at 128² and 256² (${f3(rd.meanDiff)}), wraps exactly (${so.toExponential(1)})`);
  const inner = await image(edge(256, 'inner'), 'e'), outer = await image(edge(256, 'outer'), 'e');
  const tile = await image(edge(256, 'inner'), 't');
  let inIn = 0, inOut = 0, outIn = 0, outOut = 0;
  for (let k = 0; k < tile.count; k++) {
    if (C(inner)[k] > 0.9) { if (C(tile)[k] > 0.5) inIn++; else inOut++; }
    if (C(outer)[k] > 0.9) { if (C(tile)[k] > 0.5) outIn++; else outOut++; }
  }
  check(inIn > 0 && !inOut && outOut > 0 && !outIn, 'inner lies inside the mask, outer outside it');
  const ridge = await image(edge(256, 'outline', { roundness: 1, line_width: 0.04 }), 'e');
  check(range(C(ridge))[1] > 0.99 && mean(C(ridge)) < mean(C(await image(edge(256, 'outline', { line_width: 0.04 }), 'e'))), 'roundness 1 rounds the line into a ridge');
  const sobel = await image(edge(128, 'sobel'), 'e');
  check(range(C(sobel))[1] > 0.5, 'sobel stays the default mode');

  const cr = await image({ c: { type: 'tex_cells', params: { resolution: 128, output: 'crystal', scale: 6 } } }, 'c');
  check(within01(C(cr)) && seamless(cr) < 2, 'crystal facets: 0..1, tileable');
  // inside a cell the facet is a plane: second differences vanish away from the cell borders
  const id = C(cr, 'id');
  let planar = 0, n2 = 0;
  for (let j = 1; j < 127; j++)
    for (let i = 1; i < 127; i++) {
      const k = j * 128 + i;
      if (id[k - 1] !== id[k] || id[k + 1] !== id[k]) continue;
      const v = C(cr)[k - 1], c0 = C(cr)[k], c1 = C(cr)[k + 1];
      if (v <= 0 || v >= 1 || c0 <= 0 || c0 >= 1 || c1 <= 0 || c1 >= 1) continue;
      n2++;
      if (Math.abs(v - 2 * c0 + c1) < 1e-4) planar++;
    }
  check(planar > n2 * 0.99, `crystal: each cell is one plane (${planar} of ${n2} interior samples)`);

  const stamps: Nodes = {
    a: { type: 'tex_shape', params: { resolution: 32, shape: 'square', size: 0.6, name: 'a' } },
    b: { type: 'tex_shape', params: { resolution: 32, shape: 'disc', size: 0.6, name: 'b' } },
    ab: { type: 'merge', in: ['a', 'b'] },
  };
  const ts = (extra: Record<string, any>, ins: (string | null)[] = ['a']): Nodes => ({ ...stamps, s: { type: 'tex_tile_sampler', in: ins, params: { resolution: 128, count: [4, 4], rotation: 0, jitter: 0, scale: [1, 1], intensity: [1, 1], ...extra } } });
  const grey = await image(ts({}), 's');
  check(grey.layers.size === 1, 'grey output: one layer, as before');
  const ids = await image(ts({ output: 'id' }), 's');
  const vals = new Set<number>();
  for (let k = 0; k < ids.count; k++) if (C(ids, 'mask')[k] > 0.5) vals.add(C(ids)[k]);
  check(ids.layers.has('mask') && vals.size === 16, `id: a flat random value per instance (${vals.size} values for 16), stamps in layer mask`);
  const col = await image(ts({ output: 'color' }), 's');
  check(col.channels('C') === 4 && Math.abs(at(col, 0.125, 0.125, 'C', 3) - 1) < 1e-6 && C(col)[3] === 0, 'color: RGBA, alpha = the stamps');
  const rnd = await cook({ ...stamps, s: { type: 'tex_tile_sampler', in: ['ab'], params: { resolution: 128, count: [8, 8], rotation: 0, jitter: 0, scale: [1, 1], intensity: [1, 1], stamps: 'random' } } }, 's');
  const rimg = findImage(rnd.geo, 's')!;
  let squares = 0, discs = 0;
  for (let cy = 0; cy < 8; cy++)
    for (let cx = 0; cx < 8; cx++) {
      const corner = at(rimg, (cx + 0.5 + 0.26) / 8, 1 - (cy + 0.5 + 0.26) / 8); // inside a square's corner, outside the disc
      if (corner > 0.5) squares++; else discs++;
    }
  check(squares > 10 && discs > 10, `stamps random mixes the images (${squares} squares, ${discs} discs)`);
  const err = await cookErr({ ...stamps, s: { type: 'tex_tile_sampler', in: ['ab'] } }, 's');
  check(/holds 2 images/.test(err), 'stamps one with several images still asks which one');
  const scaled = await image({ ...stamps, g: { type: 'tex_gradient', params: { resolution: 128 } }, s: { type: 'tex_tile_sampler', in: ['a', null, 'g'], params: { resolution: 128, count: [4, 4], rotation: 0, jitter: 0, scale: [1, 1], intensity: [1, 1] } } }, 's');
  let left = 0, right = 0;
  for (let k = 0; k < scaled.count; k++) { if ((k % 128) < 64) left += C(scaled)[k]; else right += C(scaled)[k]; }
  check(right > left * 2, 'the scale map grows instances where it is bright');
  const half = await image({ ...stamps, s: { type: 'tex_tile_sampler', in: ['a', null, null, null, 'h'], params: { resolution: 128, count: [4, 4], rotation: 0, jitter: 0, scale: [1, 1], intensity: [1, 1] } }, h: { type: 'tex_constant', params: { resolution: 64, value: 0.5 } } }, 's');
  check(Math.abs(range(C(half))[1] - 0.5) < 0.01, 'the intensity map scales each instance');
  const rot = await image({ ...stamps, s: { type: 'tex_tile_sampler', in: ['a', null, null, 'q'], params: { resolution: 128, count: [4, 4], rotation: 0, jitter: 0, scale: [1, 1], intensity: [1, 1] } }, q: { type: 'tex_constant', params: { resolution: 64, value: 0.125 } } }, 's');
  // a square 0.6 of a cell wide: 0.36 of a cell above its centre is outside it, but inside it turned by 45° (half diagonal 0.42)
  check(at(rot, 0.125, 0.125 + 0.09) > 0.5 && at(grey, 0.125, 0.125 + 0.09) < 0.5, 'the rotation map turns each instance (0.125 = 45°)');
  const edgeGrey = await image(ts({ jitter: 0.6, scale: [1.4, 1.4] }), 's'), edgeOpen = await image(ts({ jitter: 0.6, scale: [1.4, 1.4], tileable: false }), 's');
  check(seamless(edgeGrey) < 2 && seamless(edgeOpen) > seamless(edgeGrey) * 1.5, `tileable instances wrap (seam ${f3(seamless(edgeGrey))}); off, they are cut (seam ${f3(seamless(edgeOpen))})`);
}

// ---------------------------------------------------------------- curvature and AO

section('curvature and AO');
{
  // a sphere cap of radius 0.5 m on an image 1 m wide: mean curvature 2 1/m; radius 0.25 → C 0.75
  const sphere = (r: number): Image => {
    const img = new Image(r, r, 'cap'), g = new Float32Array(r * r);
    for (let k = 0; k < g.length; k++) { const x = ((k % r) + 0.5) / r - 0.5, y = (Math.floor(k / r) + 0.5) / r - 0.5; g[k] = Math.sqrt(Math.max(0, 0.25 - x * x - y * y)); }
    return img.set('C', normalFromHeight(g, r, r, 1, 1, false, false));
  };
  const src = new Map<string, Image>();
  const { defineNode } = await import('../src/graph/registry.ts');
  defineNode({ type: '__texnodes_source', category: 'test', inputs: [], summary: 'test', params: { key: { type: 'string', default: '', desc: 'image key' } }, cook: ({ p }) => { const g = new Geometry(); g.volumes = [src.get(p.key)!.clone()]; return g; } });
  for (const r of [64, 256]) {
    src.set(`cap${r}`, sphere(r));
    const c = await image({ s: { type: '__texnodes_source', params: { key: `cap${r}` } }, c: { type: 'tex_curvature', in: ['s'], params: { radius: 0.25, tileable: false } } }, 'c');
    check(Math.abs(at(c, 0.5, 0.5) - 0.75) < 0.01 && Math.abs(at(c, 0.5, 0.5, 'convex') - 0.5) < 0.02 && at(c, 0.5, 0.5, 'concave') === 0, `sphere cap at ${r}²: C ${f3(at(c, 0.5, 0.5))} (0.75), convex ${f3(at(c, 0.5, 0.5, 'convex'))}`);
  }
  const plates = (r: number, extra: Record<string, any> = {}): Nodes => ({
    t: { type: 'tex_pattern', params: { resolution: r, pattern: 'tiles', count: [4, 4], bevel: 0.2 } },
    n: { type: 'tex_normal_from_height', in: ['t'], params: { depth: 0.01 } },
    c: { type: 'tex_curvature', in: ['n'], params: { radius: 0.02, ...extra } },
  });
  const pc = await image(plates(128), 'c');
  const spc = await shiftDiff(plates(128), ['t'], 'c');
  check(within01(C(pc)) && Math.abs(at(pc, 0.125, 0.125) - 0.5) < 1e-6 && spc < 1e-5, `flat plate tops read 0.5; wraps exactly (${spc.toExponential(1)})`);
  const rdc = await resolutionDiff((r) => plates(r, { blur: 0.01 }), 'c');
  check(rdc.meanDiff < 0.01, `curvature in metres: 128² vs 256² differ by ${f3(rdc.meanDiff)}`);
  const dx = await image({ ...plates(64), i: { type: 'tex_normal_invert', in: ['n'] }, c: { type: 'tex_curvature', in: ['i'], params: { radius: 0.02, format: 'directx' } } }, 'c');
  const gl = await image(plates(64), 'c');
  let dmax = 0;
  for (let k = 0; k < gl.count; k++) dmax = Math.max(dmax, Math.abs(C(gl)[k] - C(dx)[k]));
  check(dmax < 1e-5, 'a DirectX normal map read as directx gives the same curvature');
  const grey = await cookErr({ t: { type: 'tex_noise', params: { resolution: 16 } }, c: { type: 'tex_curvature', in: ['t'] } }, 'c');
  check(/grey image, not a normal map/.test(grey) && /tex_normal_from_height/.test(grey), `a grey input says how to make a normal map: ${grey}`);

  const flat = await image({ g: { type: 'tex_gradient', params: { resolution: 64, angle: 30 } }, a: { type: 'tex_ao', in: ['g'], params: { depth: 0.3, tileable: false } } }, 'a');
  let interior = 1;
  for (let j = 16; j < 48; j++) for (let i = 16; i < 48; i++) interior = Math.min(interior, C(flat)[j * 64 + i]);
  check(interior > 0.999, `a tilted plane stays white (min ${f3(interior)})`);
  const ao = (r: number, extra: Record<string, any> = {}): Nodes => ({
    t: { type: 'tex_pattern', params: { resolution: r, pattern: 'tiles', count: [4, 4], gap: 0.1, bevel: 0.1 } },
    a: { type: 'tex_ao', in: ['t'], params: { radius: 0.05, depth: 0.05, ...extra } },
  });
  const a = await image(ao(128), 'a');
  check(within01(C(a)) && at(a, 0.125, 0.125) > 0.99 && at(a, 0.0, 0.125) < 0.85, `open tops white, gaps dark (${f3(at(a, 0.0, 0.125))})`);
  const sa = await shiftDiff(ao(128), ['t'], 'a');
  check(sa < 1e-5, `AO wraps exactly (${sa.toExponential(1)})`);
  const rda = await resolutionDiff((r) => ao(r), 'a');
  check(rda.meanDiff < 0.01, `AO in metres: 128² vs 256² differ by ${f3(rda.meanDiff)}`);
  const strong = await image(ao(64, { strength: 2 }), 'a'), weak = await image(ao(64, { strength: 0 }), 'a');
  check(mean(C(strong)) < mean(C(await image(ao(64), 'a'))) && range(C(weak))[0] === 1, 'strength scales the darkening (0 = none)');
}

// ---------------------------------------------------------------- histogram tools

section('histogram range and select, auto levels, clamp, quantize');
{
  const on = (type: string, params: Record<string, any>, r = 64): Nodes => ({ g: { type: 'tex_gradient', params: { resolution: r } }, o: { type, in: ['g'], params } });
  const hr = await image(on('tex_histogram_range', { range: 0.5, position: 0.6 }), 'o');
  const [lo, hi] = range(C(hr));
  check(Math.abs(lo - 0.35) < 0.01 && Math.abs(hi - 0.85) < 0.01, `histogram range 0.5 around 0.6: ${f3(lo)}..${f3(hi)}`);
  const hs = await image(on('tex_histogram_select', { position: 0.5, range: 0.2, contrast: 1 }), 'o');
  check(Math.abs(mean(C(hs)) - 0.2) < 0.03 && at(hs, 0.5, 0.5) === 1 && at(hs, 0.1, 0.5) === 0, `histogram select: the band 0.4..0.6 (${f3(mean(C(hs)))} of the gradient)`);
  const soft = await image(on('tex_histogram_select', { position: 0.5, range: 0.2, contrast: 0 }), 'o');
  check(at(soft, 0.5, 0.5) > 0.95 && at(soft, 0.6, 0.5) > 0.4 && at(soft, 0.6, 0.5) < 0.6 && at(soft, 0.72, 0.5) === 0, `contrast 0: a tent with its half-way points at position ± range / 2 (${f3(at(soft, 0.6, 0.5))} at 0.6)`);
  const dim: Nodes = { n: { type: 'tex_noise', params: { resolution: 128 } }, d: { type: 'tex_levels', in: ['n'], params: { out_low: 0.3, out_high: 0.5 } }, a: { type: 'tex_auto_levels', in: ['d'] } };
  const al = await cook(dim, 'a');
  const ai = findImage(al.geo, 'a')!;
  check(Math.abs(range(C(ai))[0]) < 1e-6 && Math.abs(range(C(ai))[1] - 1) < 1e-6 && al.stats.range_min >= 0.3 - 1e-6 && al.stats.range_max <= 0.5 + 1e-6, `auto levels: 0..1 from ${f3(al.stats.range_min)}..${f3(al.stats.range_max)}`);
  const clip = await image({ ...dim, a: { type: 'tex_auto_levels', in: ['d'], params: { clip: 0.05 } } }, 'a');
  let lowCount = 0;
  for (const v of C(clip)) if (v === 0) lowCount++;
  check(within01(C(clip)) && lowCount / clip.count > 0.03 && lowCount / clip.count < 0.07, `clip 0.05 clips about 5 % at the bottom (${f3(lowCount / clip.count)})`);
  check(valueRange(Float32Array.from([0, 0.5, 1, 7]), 1, 0)[1] === 7, 'value range sees every value');
  const rgb: Nodes = { c: { type: 'tex_constant', params: { resolution: 8, channels: 'rgba', color: [0.2, 0.4, 0.3], alpha: 0.5 } }, n: { type: 'tex_noise', params: { resolution: 8 } }, b: { type: 'tex_blend', in: ['c', 'n'], params: { mode: 'multiply' } }, a: { type: 'tex_auto_levels', in: ['b'], params: { per_channel: true } } };
  const pc = await image(rgb, 'a');
  let alphaKept = true;
  for (let k = 0; k < pc.count; k++) if (C(pc)[k * 4 + 3] !== 0.5) alphaKept = false;
  const ch0 = [0, 1, 2].map((c) => { let a = Infinity, b = -Infinity; for (let k = 0; k < pc.count; k++) { a = Math.min(a, C(pc)[k * 4 + c]); b = Math.max(b, C(pc)[k * 4 + c]); } return [a, b]; });
  check(alphaKept && ch0.every(([a, b]) => Math.abs(a) < 1e-5 && Math.abs(b - 1) < 1e-5), 'per channel: every RGB channel spans 0..1, alpha untouched');
  const flat = await cook({ c: { type: 'tex_constant', params: { resolution: 8, value: 0.3 } }, a: { type: 'tex_auto_levels', in: ['c'] } }, 'a');
  check(flat.warnings.some((w) => /flat/.test(w)) && Math.abs(C(findImage(flat.geo, 'a')!)[0] - 0.5) < 1e-6, 'a flat image warns and becomes 0.5');
  const cl = await image(on('tex_clamp', { min: 0.25, max: 0.5 }), 'o');
  check(Math.abs(range(C(cl))[0] - 0.25) < 1e-6 && Math.abs(range(C(cl))[1] - 0.5) < 1e-6, 'clamp to 0.25..0.5');
  const clErr = await cookErr(on('tex_clamp', { min: 0.8, max: 0.2 }), 'o');
  check(/above max/.test(clErr) && /swap/.test(clErr), `clamp with min above max: ${clErr}`);
  const q = await image(on('tex_quantize', { levels: 4 }), 'o');
  const levels = new Set(Array.from(C(q), (v) => Math.round(v * 1e6) / 1e6));
  check(levels.size === 4 && [0, 1 / 3, 2 / 3, 1].every((v) => levels.has(Math.round(v * 1e6) / 1e6)), `quantize 4: the values 0, 1/3, 2/3, 1 (${[...levels].map(f3).join(', ')})`);
  const qf = await image(on('tex_quantize', { levels: 4, mode: 'floor' }, 256), 'o');
  const counts = [0, 0, 0, 0];
  for (const v of C(qf)) counts[Math.round(v * 3)]++;
  check(Math.max(...counts) - Math.min(...counts) <= qf.width, `floor: equal bands of a gradient (${counts.join(', ')})`);
}

// ---------------------------------------------------------------- make it tile

section('make it tile');
{
  const mt = (r: number, extra: Record<string, any> = {}): Nodes => ({
    n: { type: 'tex_noise', params: { resolution: r, scale: 3.3, tileable: false, seed: 4 } },
    t: { type: 'tex_make_tile', in: ['n'], params: extra },
  });
  const raw = await image(mt(128), 'n'), tiled = await image(mt(128), 't');
  check(seamless(raw) > 3 && seamless(tiled) < 1.5, `a non-tileable noise (seam ratio ${f3(seamless(raw))}) tiles after (${f3(seamless(tiled))})`);
  check(Math.abs(at(tiled, 0.5, 0.5) - at(raw, 0.5, 0.5)) < 1e-6 && Math.abs(at(tiled, 0.37, 0.6) - at(raw, 0.37, 0.6)) < 1e-6, 'the middle is untouched');
  const smooth = await image(mt(128, { noise: 0 }), 't');
  check(seamless(smooth) < 1.5, 'a plain cross-fade tiles too');
  const rgba = await image({ c: { type: 'tex_cells', params: { resolution: 64, scale: 3.5, tileable: false, output: 'distance' } }, k: { type: 'tex_colorize', in: ['c'], params: { ramp: [[0, '#203040'], [1, '#c08040']] } }, t: { type: 'tex_make_tile', in: ['k'] } }, 't');
  check(rgba.channels('C') === 4 && seamless(rgba) < 1.5, 'RGBA images tile as well');
}

// ---------------------------------------------------------------- normal maps

section('normal maps: normalize, invert, height from normal');
{
  const nm = (r: number, inv: Record<string, any> = {}, back: Record<string, any> = {}): Nodes => ({
    h: { type: 'tex_noise', params: { resolution: r, scale: 4, octaves: 3, seed: 6 } },
    n: { type: 'tex_normal_from_height', in: ['h'], params: { depth: 0.05, size: 1 } },
    b: { type: 'tex_blur', in: ['n'], params: { radius: 4 } },
    z: { type: 'tex_normal_normalize', in: ['b'] },
    i: { type: 'tex_normal_invert', in: ['n'], params: inv },
    k: { type: 'tex_height_from_normal', in: ['n'], params: { depth: 0.05, size: 1, ...back } },
  });
  const z = await image(nm(64), 'z');
  let worst = 0;
  for (let k = 0; k < z.count; k++) worst = Math.max(worst, Math.abs(Math.hypot(C(z)[k * 4] * 2 - 1, C(z)[k * 4 + 1] * 2 - 1, C(z)[k * 4 + 2] * 2 - 1) - 1));
  const bl = await image(nm(64), 'b');
  let shortest = 1;
  for (let k = 0; k < bl.count; k++) shortest = Math.min(shortest, Math.hypot(C(bl)[k * 4] * 2 - 1, C(bl)[k * 4 + 1] * 2 - 1, C(bl)[k * 4 + 2] * 2 - 1));
  check(shortest < 0.999 && worst < 1e-5, `normalize: blurred vectors (shortest ${f3(shortest)}) are unit again (error ${worst.toExponential(1)})`);
  const n = await image(nm(64), 'n'), inv = await image(nm(64), 'i'), both = await image(nm(64, { channel: 'both' }), 'i');
  let ok = true;
  for (let k = 0; k < n.count; k++) {
    if (Math.abs(C(inv)[k * 4 + 1] - (1 - C(n)[k * 4 + 1])) > 1e-6 || C(inv)[k * 4] !== C(n)[k * 4] || C(inv)[k * 4 + 2] !== C(n)[k * 4 + 2]) ok = false;
    if (Math.abs(C(both)[k * 4] - (1 - C(n)[k * 4])) > 1e-6) ok = false;
  }
  check(ok, 'invert green flips Y only; both flips X too');
  const gl = await image(nm(64), 'n'), dxN = await image({ ...nm(64), n: { type: 'tex_normal_from_height', in: ['h'], params: { depth: 0.05, format: 'directx' } } }, 'n');
  let conv = 0;
  for (let k = 0; k < gl.count; k++) conv = Math.max(conv, Math.abs(C(gl)[k * 4 + 1] - (1 - C(dxN)[k * 4 + 1])));
  check(conv < 1e-6, 'invert green turns a DirectX normal map into the OpenGL one');
  // round trip: height → normals → height, up to the offset and a little smoothing
  for (const r of [64, 256]) {
    const res = await cook(nm(r), 'k');
    const back = findImage(res.geo, 'k')!, orig = await image(nm(r), 'h');
    const a = C(orig), b = C(back), ma = mean(a), mb = mean(b);
    let sab = 0, saa = 0, sbb = 0, err = 0;
    for (let k = 0; k < a.length; k++) { sab += (a[k] - ma) * (b[k] - mb); saa += (a[k] - ma) ** 2; sbb += (b[k] - mb) ** 2; err = Math.max(err, Math.abs(a[k] - ma - (b[k] - mb))); }
    const corr = sab / Math.sqrt(saa * sbb), [lo, hi] = range(a);
    check(corr > 0.995 && err < 0.03 * (hi - lo) + 0.01 && Math.abs(res.stats.relief - (hi - lo) * 0.05) < 0.1 * (hi - lo) * 0.05, `round trip at ${r}²: correlation ${corr.toFixed(4)}, max error ${f3(err)}, relief ${f3(res.stats.relief)} m (${f3((hi - lo) * 0.05)})`);
  }
  const k = await image(nm(64), 'k');
  const sk = await shiftDiff(nm(64), ['h'], 'k');
  check(Math.abs(range(C(k))[0]) < 1e-6 && sk < 1e-5, `depth range: the lowest point is 0; a tileable map integrates periodically (${sk.toExponential(1)})`);
  const kn = await image(nm(64, {}, { range: 'normalize' }), 'k');
  check(Math.abs(range(C(kn))[1] - 1) < 1e-6, 'normalize: lowest..highest to 0..1');
  // the solver itself: Laplacian of the solution equals the input (periodic and mirrored, odd sizes)
  for (const wrap of [true, false]) {
    const w = 13, h = 7, f = Float64Array.from({ length: w * h }, (_, i) => Math.sin(i * 1.7) + Math.cos(i * 0.3));
    const m = f.reduce((s, x) => s + x) / f.length;
    for (let i = 0; i < f.length; i++) f[i] -= m;
    const u = poisson(f, w, h, wrap);
    const get = (i: number, j: number) => u[(wrap ? (j + h) % h : Math.max(0, Math.min(h - 1, j))) * w + (wrap ? (i + w) % w : Math.max(0, Math.min(w - 1, i)))];
    let e = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) e = Math.max(e, Math.abs(get(i + 1, j) + get(i - 1, j) + get(i, j + 1) + get(i, j - 1) - 4 * get(i, j) - f[j * w + i]));
    check(e < 1e-9, `Poisson solve (${wrap ? 'periodic, FFT' : 'mirrored, DCT'}, 13 × 7): residual ${e.toExponential(1)}`);
  }
  // a mirrored solve of a non-tileable height
  const ramp = new Float32Array(32 * 32).map((_, i) => (i % 32) / 32 * 0.5 + Math.floor(i / 32) / 32 * 0.25);
  const hb = heightFromNormal(normalFromHeight(ramp, 32, 32, 1, 1, false, false), 32, 32, 1 / 32, false, false);
  check(Math.abs(hb[31] - hb[0] - (ramp[31] - ramp[0])) < 0.02, `a ramp integrates back without wrapping (rise ${f3(hb[31] - hb[0])} for ${f3(ramp[31] - ramp[0])})`);
}

// ---------------------------------------------------------------- grunge

section('grunge');
{
  for (const style of ['dirt', 'leaks', 'spots']) {
    const g = (r: number, extra: Record<string, any> = {}): Nodes => ({ g: { type: 'tex_grunge', params: { resolution: r, style, coverage: 0.3, seed: 1, ...extra } } });
    const img = await image(g(128), 'g');
    let white = 0;
    for (const v of C(img)) if (v > 0.5) white++;
    const cov = white / img.count;
    check(within01(C(img)) && Math.abs(cov - 0.3) < 0.02 && seamless(img) < 2, `${style}: coverage ${f3(cov)} (0.3), tileable`);
    const rd = await resolutionDiff(g, 'g');
    check(rd.meanDiff < 0.06, `${style}: 128² vs 256² differ by ${f3(rd.meanDiff)} on average`);
    const other = await image(g(64, { seed: 2 }), 'g'), same = await image(g(64), 'g');
    let d = 0;
    for (let k = 0; k < other.count; k++) d += Math.abs(C(other)[k] - C(same)[k]);
    check(d / other.count > 0.05, `${style}: the seed changes it`);
  }
  const leaks = await image({ g: { type: 'tex_grunge', params: { resolution: 128, style: 'leaks', detail: 0 } } }, 'g');
  check(seamU(C(leaks), 128, 128) > 0 && (() => { let v = 0, hz = 0; for (let j = 0; j < 127; j++) for (let i = 0; i < 127; i++) { v += Math.abs(C(leaks)[j * 128 + i] - C(leaks)[(j + 1) * 128 + i]); hz += Math.abs(C(leaks)[j * 128 + i] - C(leaks)[j * 128 + i + 1]); } return v < hz * 0.5; })(), 'leaks run vertically');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
