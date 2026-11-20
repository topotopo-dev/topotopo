// bake_triplanar (category "texture"): tiling images (a photograph of rust, dripping concrete, a scanned surface)
// projected onto a mesh in world metres from the three axes and blended by the normal, then stored in the mesh's uv
// space: colour, roughness and a normal map in the bake's own tangent frame. The value of every texel is a function of
// its 3D position and normal, so it does not follow uv seams. tex_layers reads the result through a layer's `image`.
//
//   projection   X: (−z · sign(nx), y), Y: (x, −z · sign(ny)), Z: (x · sign(nz), y), each divided by size and shifted by
//                offset: the image is never mirrored seen from outside, and turns with the face only at the blend
//   blend        weights |n|^sharpness per axis, normalised: one projection on flat faces, a short blend at the turn
//   normal       each projection's tangent-space normal turned into world space by the whiteout triplanar blend, the
//                blend of the three normalised, then written in the MikkTSpace frame of the bake's uv (as bake_normal)
import { findImage, imagesOf, referenceableImages, sampleUV } from '../core/image.ts';
import type { Image } from '../core/image.ts';
import type { Geometry } from '../core/geometry.ts';
import { interpolateCorners } from '../core/bake.ts';
import { hashNumber, rand } from '../core/random.ts';
import { resolveVertexNormals } from '../core/topology.ts';
import { MIKK_RESET_BYTES, cornerTangents, loadMikkTSpace, mikkTSpaceHeapBytes, mikkTSpaceReady, shadingFrame } from '../core/tangents.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext } from '../graph/types.ts';
import { BAKE_PARAMS, finishImage, setup, wrapImage } from './bake.ts';
import { NAMED_BY_NODE } from './texture.ts';

const T = 'bake_triplanar';

function cook(ctx: CookContext): Geometry | Promise<Geometry> {
  const { p } = ctx;
  const pool = new Map<string, Image>();
  for (const im of ctx.hasInput(1) ? imagesOf(ctx.input(1)) : []) if (!pool.has(im.name)) pool.set(im.name, im);
  for (const [k, im] of referenceableImages(ctx.input(0))) if (!pool.has(k)) pool.set(k, im);
  const names = () => [...pool.keys()].join(', ') || '(none: connect images to input 1)';
  const pick = (param: string, required: boolean): Image | null => {
    const want = String(p[param] ?? '').trim();
    if (!want) {
      if (!required) return null;
      const first = ctx.hasInput(1) ? findImage(ctx.input(1)) : null;
      if (!first) throw new NodeError(`${T}: no image to project: name one with color, or connect images to input 1`, `images: ${names()}`);
      return first;
    }
    const im = pool.get(want);
    if (!im) throw new NodeError(`${T}: ${param} "${want}" is not an image of input 1 or input 0`, `images: ${names()}`);
    return im;
  };
  const color = pick('color', true)!, normal = pick('normal', false), rough = pick('roughness', false);
  let size = Number(p.size) || 0;
  if (!(size > 0)) {
    if (!color.sizeStated) throw new NodeError(`${T}: image "${color.name}" does not say how many metres it covers`, 'set size (metres one repeat covers on the model), or state it where the image is made (image_file or a generator: texture_size)');
    size = color.size;
  }
  const b = setup(ctx), n = b.s.n;
  const k = Math.max(1, Math.min(32, Number(p.sharpness) || 4));
  const seed = Math.round(Number(p.seed) || 0);
  const off = (p.offset as number[]).map(Number);
  // a seed shifts the pattern by a random part of a repeat on every axis
  const sh = [0, 1, 2].map((a) => off[a] + (seed ? rand(a + 1, hashNumber(seed)) * size : 0));
  const C = new Float32Array(n * 4), R = rough ? new Float32Array(n) : null, NW = normal ? new Float64Array(n * 3) : null;
  const tmp = new Float32Array(4), acc = new Float64Array(4);
  const dx = p.normal_format === 'directx' ? -1 : 1;
  const sample = (im: Image, u: number, v: number) => {
    const a = im.layer(im.mainLayer)!, ch = im.channels(im.mainLayer);
    sampleUV(a, ch, im.width, im.height, u, v, tmp, true);
    return ch;
  };
  for (let i = 0; i < n; i++) {
    const px = b.P[i * 3] + sh[0], py = b.P[i * 3 + 1] + sh[1], pz = b.P[i * 3 + 2] + sh[2];
    const nx = b.N[i * 3], ny = b.N[i * 3 + 1], nz = b.N[i * 3 + 2];
    let wx = Math.abs(nx) ** k, wy = Math.abs(ny) ** k, wz = Math.abs(nz) ** k;
    const ws = wx + wy + wz || 1;
    wx /= ws; wy /= ws; wz /= ws;
    const sx = nx < 0 ? -1 : 1, sy = ny < 0 ? -1 : 1, sz = nz < 0 ? -1 : 1;
    const uv = [(-pz * sx) / size, py / size, px / size, (-pz * sy) / size, (px * sz) / size, py / size];
    const w3 = [wx, wy, wz];
    acc.fill(0);
    let r = 0;
    let ox = 0, oy = 0, oz = 0;
    for (let a = 0; a < 3; a++) {
      const w = w3[a];
      if (!(w > 1e-6)) continue;
      const u = uv[a * 2], v = uv[a * 2 + 1];
      const ch = sample(color, u, v);
      if (ch === 4) { acc[0] += tmp[0] * w; acc[1] += tmp[1] * w; acc[2] += tmp[2] * w; acc[3] += tmp[3] * w; } else { acc[0] += tmp[0] * w; acc[1] += tmp[0] * w; acc[2] += tmp[0] * w; acc[3] += w; }
      if (rough) { const c2 = sample(rough, u, v); r += (c2 === 4 ? tmp[1] : tmp[0]) * w; }
      if (normal) {
        const c3 = sample(normal, u, v);
        let tx = (c3 === 4 ? tmp[0] : 0.5) * 2 - 1, ty = ((c3 === 4 ? tmp[1] : 0.5) * 2 - 1) * dx;
        const tz = Math.abs((c3 === 4 ? tmp[2] : 1) * 2 - 1);
        // whiteout triplanar: the projection's tangent axes in world space, then the surface normal added
        if (a === 0) { tx *= -sx; ox += tz * nx * w; oy += (ty + ny) * w; oz += (tx + nz) * w; }
        else if (a === 1) { ty *= -sy; ox += (tx + nx) * w; oy += tz * ny * w; oz += (ty + nz) * w; }
        else { tx *= sz; ox += (tx + nx) * w; oy += (ty + ny) * w; oz += tz * nz * w; }
      }
    }
    C[i * 4] = acc[0]; C[i * 4 + 1] = acc[1]; C[i * 4 + 2] = acc[2]; C[i * 4 + 3] = acc[3];
    if (R) R[i] = r;
    if (NW) { const l = Math.hypot(ox, oy, oz) || 1; NW[i * 3] = ox / l; NW[i * 3 + 1] = oy / l; NW[i * 3 + 2] = oz / l; }
  }
  const extra: Record<string, { vals: Float32Array; ch: number; background: number[] }> = {};
  if (R) extra.roughness = { vals: R, ch: 1, background: [0.5] };
  const done = () => {
    ctx.stat('size', size);
    return wrapImage(b, finishImage(b, C, 4, [0, 0, 0, 1], extra).img);
  };
  if (!NW) return done();
  const withFrames = () => {
    // world normal → the tangent frame of the bake's uv (MikkTSpace, the frame exporters write)
    const { tangents } = cornerTangents(b.g, b.tris, resolveVertexNormals(b.g, 60), b.uv);
    const Tg = interpolateCorners(b.s, tangents, 4), f = new Float64Array(9), out = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      out[i * 4] = 0.5; out[i * 4 + 1] = 0.5; out[i * 4 + 2] = 1; out[i * 4 + 3] = 1;
      if (!shadingFrame(b.N[i * 3], b.N[i * 3 + 1], b.N[i * 3 + 2], Tg[i * 4], Tg[i * 4 + 1], Tg[i * 4 + 2], Tg[i * 4 + 3], f)) continue;
      const hx = NW[i * 3], hy = NW[i * 3 + 1], hz = NW[i * 3 + 2];
      const u = hx * f[0] + hy * f[1] + hz * f[2], v = hx * f[3] + hy * f[4] + hz * f[5], w = hx * f[6] + hy * f[7] + hz * f[8];
      const l = Math.hypot(u, v, w) || 1;
      out[i * 4] = 0.5 + (0.5 * u) / l; out[i * 4 + 1] = 0.5 + (0.5 * v) / l; out[i * 4 + 2] = 0.5 + (0.5 * w) / l;
    }
    extra.normal = { vals: out, ch: 4, background: [0.5, 0.5, 1, 1] };
    return done();
  };
  return mikkTSpaceReady() && mikkTSpaceHeapBytes() <= MIKK_RESET_BYTES ? withFrames() : loadMikkTSpace().then(withFrames);
}

defineNode({
  type: T,
  category: 'texture',
  usesNodeName: NAMED_BY_NODE,
  summary: 'Project tiling images (a photograph, a scanned surface) onto a mesh in world metres from three axes and bake them into its uv: colour, roughness and a normal map, with no uv seam showing.',
  description:
    'Every texel reads the images at its 3D position: from the X axis at (−z, y), from Y at (x, −z), from Z at (x, y), each turned so the ' +
    'image is never mirrored seen from outside, divided by size (the metres one repeat covers; 0 = the colour image\'s own size, which ' +
    'image_file or a generator states) and shifted by offset (and by a random part of a repeat per seed). The three are blended by ' +
    'the normal, |n|^sharpness per axis: flat faces take one projection, and the turn between them blends over a short band. ' +
    'So the result follows the model in 3D: the same on both sides of a uv seam, the same scale on every island. The normal ' +
    'image is turned into world space per projection (the whiteout triplanar blend) and written in the tangent frame of the ' +
    'bake\'s uv (MikkTSpace, as bake_normal), so it stays right on any uv layout. C = colour (RGBA), layers roughness (when a ' +
    'roughness image is named: its grey, or the green of a colour image) and normal (when a normal image is named), texel, ' +
    'island and mask. tex_layers takes all three through a layer\'s image field.',
  aliases: ['triplanar', 'bake_projection', 'project_texture', 'box_projection'],
  inputs: [
    { name: 'geo', desc: 'mesh to bake (needs uv without overlaps)' },
    { name: 'images', desc: 'geometry carrying the tiling images (image_file, texture nodes)', optional: true },
  ],
  params: {
    ...BAKE_PARAMS(),
    color: { type: 'string', default: '', desc: 'the colour image ("" = the first image of input 1)', aliases: ['base_color', 'image'] },
    normal: { type: 'string', default: '', desc: 'a tangent-space normal image tiling with it ("" = none)', aliases: ['normal_map'] },
    roughness: { type: 'string', default: '', desc: 'a roughness image tiling with it ("" = none)', aliases: ['roughness_map'] },
    normal_format: { type: 'enum', options: ['opengl', 'directx'], default: 'opengl', desc: 'green-channel convention of the normal image (the result is OpenGL)' },
    size: { type: 'float', default: 0, min: 0, desc: 'metres one repeat of the images covers on the model (0 = the colour image\'s stated size)', aliases: ['tile', 'scale', 'world_size'] },
    sharpness: { type: 'float', default: 4, min: 1, max: 32, desc: 'how sharply the projections hand over at a turn (higher = a shorter blend)', aliases: ['blend', 'falloff'] },
    offset: { type: 'vec3', default: [0, 0, 0], desc: 'shift of the pattern in metres' },
    seed: { type: 'int', default: 0, min: 0, max: 2147483647, desc: 'shifts the pattern by a random part of a repeat (0 = no shift)' },
  },
  outputs: 'image <name> (default: the node name): C colour, roughness, normal, texel, island, mask',
  example: {
    nodes: {
      box: { type: 'box' },
      uv: { type: 'uv_unwrap', in: ['box'] },
      rust: { type: 'tex_noise', params: { resolution: 128, texture_size: 0.5 } },
      proj: { type: 'bake_triplanar', in: ['uv', 'rust'], params: { resolution: 256 } },
    },
    output: 'proj',
  },
  cook,
});
