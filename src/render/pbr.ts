// Deterministic PBR preview (render option shading "pbr"): the metallic-roughness model glTF export writes, shaded in
// software under one fixed studio light rig, so roughness, metallic, occlusion and normal maps can be checked
// headlessly and the same graph always gives the same PNG bytes.
//
// Material evaluation follows the exporter (io/gltf.ts) slot by slot:
//   base colour   a base colour map replaces the factor; vertex colour Cd (unless it is all white over the material's
//                 prims) multiplies it as glTF's COLOR_0 does, else the material's baseColor. Display values: maps and
//                 factors are decoded from sRGB to linear before lighting (maps before filtering).
//   normal        tangent-space map (OpenGL, green up) in the MikkTSpace frame of core/tangents.ts, the frame glTF
//                 export writes as TANGENT and bake_normal bakes in.
//   orm           occlusion R (indirect light only), roughness G, metallic B; a map replaces the roughness and metallic
//                 factors (exported roughnessFactor = metallicFactor = 1).
//   roughness     a standalone map (grey, or green of RGBA) replaces the factor, as exported; ignored under an orm map.
//   emissive      added after lighting (values above 1 are KHR_materials_emissive_strength).
//   unlit         base colour, no lighting and no tone curve (KHR_materials_unlit).
// Linear maps (normal, orm, roughness) are filtered as stored. Sampling: repeat wrap, mip chains with trilinear
// filtering at a per-pixel level of detail from the perspective-correct uv derivatives.
//
// Lighting: GGX / Smith (height-correlated) / Schlick specular and Lambert diffuse under three camera-relative
// directional lights (key, fill, rim), plus a world-up sky/ground environment for indirect diffuse and specular
// (Karis' analytic environment BRDF). Linear radiance × 2^exposure, the ACES curve (Narkowicz fit) on the brightest
// channel with the hue kept, sRGB encoding.
//
// Not evaluated, and reported in the render notes instead of being shown as if verified: transparency (alpha < 1 in a
// material, an Alpha attribute or a base colour map's alpha: shaded opaque), textures that are missing, unreadable or
// not PNG (shaded without them).
import type { Geometry } from '../core/geometry.ts';
import { Image, channelsOf, imageRef, referenceableImages, resizeLayer } from '../core/image.ts';
import { DEFAULT_MATERIAL, mergeMaterialTables, primMaterials, readMaterials } from '../core/materials.ts';
import type { Material } from '../core/materials.ts';
import { cornerTangents, loadMikkTSpace, mikkTSpaceReady, shadingFrame, vertexUV } from '../core/tangents.ts';
import { imageRowOfV } from '../core/texcoord.ts';
import { resolveVertexNormals } from '../core/topology.ts';
import { decodePNG } from '../io/png-decode.ts';
import { imageFromPNG } from '../io/textures.ts';

/** External texture files read for a PBR render: path → image, or the reason it is not available. */
export type PBRTextures = Map<string, Image | string>;

/** The normals the exporter writes by default (60° cusp): the frame the normal map and TANGENT belong to. */
export const PBR_CUSP = 60;

/**
 * Asynchronous preparation for shading "pbr": loads MikkTSpace and reads every texture file the material tables name
 * (image volumes need no reading) through readFile, usually Host.readFile.
 */
export async function preparePBR(g: Geometry, readFile?: (path: string) => Promise<Uint8Array>): Promise<PBRTextures> {
  await loadMikkTSpace();
  const files: PBRTextures = new Map();
  const table = mergeMaterialTables([g, ...g.packedSources]);
  for (const m of Object.values(table)) for (const path of Object.values(m.textures ?? {})) {
    if (!path || imageRef(path) !== null || files.has(path)) continue;
    if (!readFile) { files.set(path, 'no file access in this render'); continue; }
    let bytes: Uint8Array;
    try { bytes = await readFile(path); } catch (e: any) { files.set(path, `cannot be read (${e?.message ?? e})`); continue; }
    if (!(bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50)) { files.set(path, 'is not a PNG (only PNG textures are decoded for the preview)'); continue; }
    try { files.set(path, imageFromPNG(decodePNG(bytes), path)); } catch (e: any) { files.set(path, `is not a readable PNG (${e?.message ?? e})`); }
  }
  return files;
}

// ---------------------------------------------------------------- textures

interface Mip { w: number; h: number; ch: number; data: Float32Array }

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** Mip chain of a layer (1 or 4 channels), optionally sRGB-decoded first (colour), area-averaged down to 1 × 1. */
function mips(img: Image, srgb: boolean): Mip[] {
  const src = img.layer(img.mainLayer)!, ch = channelsOf(src, img.count) || 1;
  const base = srgb ? Float32Array.from(src, (x, i) => (ch === 4 && i % 4 === 3 ? x : srgbToLinear(Math.max(0, x)))) : src;
  const out: Mip[] = [{ w: img.width, h: img.height, ch, data: base }];
  let m = out[0];
  while (m.w > 1 || m.h > 1) {
    const w = Math.max(1, m.w >> 1), h = Math.max(1, m.h >> 1);
    m = { w, h, ch, data: resizeLayer(m.data, ch, m.w, m.h, w, h, true) };
    out.push(m);
  }
  return out;
}

const wrap = (i: number, n: number) => ((i % n) + n) % n;

/** Bilinear sample of one mip level (repeat wrap) into out[0..3] (grey layers fill rgb, alpha 1). */
function bilinear(m: Mip, u: number, v: number, out: number[], k: number) {
  const x = u * m.w - 0.5, y = imageRowOfV(v, m.h) - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const i0 = wrap(x0, m.w), i1 = wrap(x0 + 1, m.w), j0 = wrap(y0, m.h), j1 = wrap(y0 + 1, m.h);
  const d = m.data, ch = m.ch;
  for (let c = 0; c < 4; c++) {
    const cc = ch === 4 ? c : c === 3 ? -1 : 0;
    let s = 1;
    if (cc >= 0) {
      const a = d[(j0 * m.w + i0) * ch + cc], b = d[(j0 * m.w + i1) * ch + cc], e = d[(j1 * m.w + i0) * ch + cc], f = d[(j1 * m.w + i1) * ch + cc];
      const t = a + (b - a) * tx, q = e + (f - e) * tx;
      s = t + (q - t) * ty;
    }
    out[c] += s * k;
  }
}

/** Trilinear sample: lod in level-0 texels per pixel (log2), blended between the two nearest levels. */
function sampleTri(chain: Mip[], u: number, v: number, lod: number, out: number[]) {
  out[0] = out[1] = out[2] = out[3] = 0;
  const l = Math.max(0, Math.min(chain.length - 1, lod)), l0 = Math.floor(l), f = l - l0;
  bilinear(chain[l0], u, v, out, 1 - f);
  if (f > 0 && l0 + 1 < chain.length) bilinear(chain[l0 + 1], u, v, out, f);
}

// ---------------------------------------------------------------- materials

interface PBRMat {
  name: string;
  base: number[]; // linear factor (used without a map and without vertex colour)
  metallic: number;
  roughness: number;
  emissive: number[]; // linear, strength included
  unlit: boolean;
  baseMap: Mip[] | null;
  normalMap: Mip[] | null;
  ormMap: Mip[] | null;
  roughMap: Mip[] | null;
  /** largest map (texels per uv unit, along one axis) for the level of detail */
  size: number[];
}

// ---------------------------------------------------------------- the scene

/** Per-triangle data and the per-pixel shader for one render. */
export interface PBRScene {
  /** materials evaluated, maps used, problems: footer and notes */
  summary: string;
  /** shade a pixel; writes display RGB (0..1) into out */
  shade(t: number, w0: number, w1: number, w2: number, dudx: number, dvdx: number, dudy: number, dvdy: number, view: number[], back: boolean, out: number[]): void;
  /** uv of triangle t at (perspective-correct) weights, for the derivatives */
  uvAt(t: number, w0: number, w1: number, w2: number, out: number[]): void;
  hasUV: boolean;
  /** place the camera-relative light rig for a view (camera right, up, forward in world space) */
  camera(r: number[], u: number[], f: number[]): void;
}

const norm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// studio rig in camera space (x right, y up, z towards the viewer): key upper left, fill right, rim behind
const RIG = [
  { d: norm([-0.45, 0.65, 0.6]), c: [1.9, 1.85, 1.76] },
  { d: norm([0.75, 0.1, 0.45]), c: [0.42, 0.45, 0.5] },
  { d: norm([0.3, 0.55, -0.78]), c: [1.1, 1.1, 1.1] },
];
// world-up environment for indirect light
const SKY = [0.34, 0.37, 0.42], HORIZON = [0.27, 0.27, 0.27], GROUND = [0.08, 0.075, 0.07];

/** Environment radiance along world direction d, widened by roughness (a cheap stand-in for a prefiltered map). */
function env(dy: number, rough: number, out: number[]) {
  const w = 0.25 + rough * 0.9;
  const t = Math.max(-1, Math.min(1, dy / w));
  for (let c = 0; c < 3; c++) out[c] = t >= 0 ? HORIZON[c] + (SKY[c] - HORIZON[c]) * t : HORIZON[c] + (GROUND[c] - HORIZON[c]) * -t;
}

/** ACES filmic curve (Narkowicz fit). */
const acesCurve = (x: number) => Math.max(0, Math.min(1, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));

/**
 * Tone map linear radiance in place and encode to sRGB: the ACES curve on the brightest channel, the others scaled by
 * the same factor, so bright coloured highlights (a red metal) keep their hue instead of washing out to white.
 */
function tone(c: number[]) {
  const m = Math.max(c[0], c[1], c[2]);
  const k = m > 0 ? acesCurve(m) / m : 0;
  for (let i = 0; i < 3; i++) c[i] = linearToSrgb(Math.max(0, c[i] * k));
}

/**
 * Build the shading data for g's triangles (tris / triPrim from topology.triangulate). Synchronous: MikkTSpace must be
 * loaded (preparePBR or loadMikkTSpace) and external textures read into `files`; notes receive what is not evaluated.
 */
export function pbrScene(g: Geometry, tris: Uint32Array, triPrim: Uint32Array, files: PBRTextures | undefined, exposure: number, notes: string[]): PBRScene {
  if (!mikkTSpaceReady()) throw new Error('shading "pbr" needs the asynchronous render entry (renderGeometryAsync): MikkTSpace is not loaded');
  const nTri = tris.length / 3;
  const table = readMaterials(g), pm = primMaterials(g), imgs = referenceableImages(g);
  const uv = vertexUV(g, 'uv');
  const N = resolveVertexNormals(g, PBR_CUSP);
  const P = g.P, vp = g.vertexPoint;
  const problems: string[] = [];
  const mipCache = new Map<string, Mip[] | null>();
  const mapOf = (mat: string, slot: string, path: string | undefined, srgb: boolean): Mip[] | null => {
    if (!path) return null;
    const key = `${path}\u0000${srgb}`;
    if (mipCache.has(key)) return mipCache.get(key)!;
    let img: Image | null = null;
    const ref = imageRef(path);
    if (ref !== null) {
      img = imgs.get(ref) ?? null;
      if (!img) problems.push(`material "${mat}" ${slot} "image:${ref}" is not carried by the geometry`);
    } else {
      const f = files?.get(path);
      if (f instanceof Image) img = f;
      else problems.push(`material "${mat}" ${slot} "${path}" ${f ?? 'was not loaded (render through renderGeometryAsync with readFile)'}`);
    }
    const chain = img ? mips(img, srgb) : null;
    mipCache.set(key, chain);
    return chain;
  };
  // vertex colour as glTF COLOR_0: per material, only when Cd is not all white over its prims
  const cdF = g.findAttrib('Cd', ['vertex', 'point', 'prim', 'detail']);
  const cdA = cdF && cdF.attr.type === 'float' ? cdF.attr : null;
  const cdIndex = (v: number, p: number) => (cdF!.cls === 'vertex' ? v : cdF!.cls === 'point' ? vp[v] : cdF!.cls === 'prim' ? p : 0);
  const cdOf = (v: number, p: number, out: number[]) => {
    const d = cdA!.data as Float64Array, s = cdA!.size, i = cdIndex(v, p) * s;
    out[0] = d[i]; out[1] = s > 1 ? d[i + 1] : d[i]; out[2] = s > 2 ? d[i + 2] : d[i];
  };
  const mats = new Map<string, PBRMat>(), vcol = new Map<string, boolean>();
  const transparent: string[] = [];
  const matOf = (name: string): PBRMat => {
    let m = mats.get(name);
    if (m) return m;
    const src: Material = (name && table[name]) || (DEFAULT_MATERIAL as Material);
    const label = name || 'default';
    const t = src.textures ?? {};
    const emax = Math.max(1, ...src.emissive);
    m = {
      name: label, base: src.baseColor.map((c) => srgbToLinear(Math.max(0, Math.min(1, c)))),
      metallic: src.metallic, roughness: src.roughness,
      emissive: src.emissive.map((e) => srgbToLinear(Math.max(0, Math.min(1, e / emax))) * emax), unlit: src.unlit,
      baseMap: mapOf(label, 'base colour', t.baseColor, true), normalMap: mapOf(label, 'normal', t.normal, false),
      ormMap: mapOf(label, 'orm', t.orm, false), roughMap: t.orm ? null : mapOf(label, 'roughness', t.roughness, false), size: [1, 1],
    };
    for (const c of [m.baseMap, m.normalMap, m.ormMap, m.roughMap]) if (c) { m.size[0] = Math.max(m.size[0], c[0].w); m.size[1] = Math.max(m.size[1], c[0].h); }
    if (src.alpha < 1) transparent.push(`material "${label}" alpha ${src.alpha}`);
    else if (m.baseMap && m.baseMap[0].ch === 4 && m.baseMap[0].data.some((x, i) => i % 4 === 3 && x < 1)) transparent.push(`material "${label}" base colour map alpha`);
    mats.set(name, m);
    return m;
  };
  const triMat: PBRMat[] = new Array(nTri);
  const cdWhite = new Map<string, boolean>();
  if (cdA) {
    const c = [0, 0, 0];
    for (let t = 0; t < nTri; t++) {
      const p = triPrim[t], name = pm ? pm[p] : '';
      if (cdWhite.get(name) === false) continue;
      let white = cdWhite.get(name) ?? true;
      for (let k = 0; k < 3 && white; k++) { cdOf(tris[t * 3 + k], p, c); if (c[0] !== 1 || c[1] !== 1 || c[2] !== 1) white = false; }
      cdWhite.set(name, white);
    }
  }
  for (let t = 0; t < nTri; t++) {
    const name = pm ? pm[triPrim[t]] : '';
    triMat[t] = matOf(name);
    if (!vcol.has(name)) vcol.set(name, !!cdA && cdWhite.get(name) === false);
  }
  const al = g.findAttrib('Alpha', ['vertex', 'point', 'prim', 'detail']);
  if (al && al.attr.type === 'float' && (al.attr.data as Float64Array).some((x) => x < 1)) transparent.push('Alpha attribute below 1');
  // MikkTSpace frames for normal-mapped triangles (computed once over every triangle: the frames do not depend on the
  // material, and one call keeps the soup contiguous)
  const anyNormal = [...mats.values()].some((m) => m.normalMap);
  let tan: Float32Array | null = null;
  if (anyNormal && uv) {
    const r = cornerTangents(g, tris, N, uv);
    tan = r.tangents;
    if (r.diag.uvDegenerate || r.diag.uvNonFinite) problems.push(`${r.diag.uvDegenerate + r.diag.uvNonFinite} triangles have collapsed or non-finite uvs: their normal map has no orientation (fallback frame)`);
  }
  if (!uv && [...mats.values()].some((m) => m.baseMap || m.normalMap || m.ormMap || m.roughMap)) problems.push('the geometry has no uv attribute: texture maps are not shown');
  if (transparent.length) notes.push(`pbr: transparency is not evaluated, shaded opaque (${[...new Set(transparent)].join('; ')})`);
  for (const pr of new Set(problems)) notes.push(`pbr: ${pr}`);

  let camL = RIG.map((l) => ({ d: l.d, c: l.c }));
  const gain = 2 ** exposure;
  const n = [0, 0, 0], f = new Float64Array(9), tx = [0, 0, 0, 0], base = [0, 0, 0], e = [0, 0, 0], c3 = [0, 0, 0];
  const uvAt = (t: number, w0: number, w1: number, w2: number, out: number[]) => {
    const a = tris[t * 3] * 2, b = tris[t * 3 + 1] * 2, c = tris[t * 3 + 2] * 2;
    out[0] = uv![a] * w0 + uv![b] * w1 + uv![c] * w2; out[1] = uv![a + 1] * w0 + uv![b + 1] * w1 + uv![c + 1] * w2;
  };
  const uvp = [0, 0];
  const mapsUsed = new Set<string>();
  for (const m of mats.values()) {
    if (m.baseMap) mapsUsed.add('base colour'); if (m.normalMap) mapsUsed.add('normal');
    if (m.ormMap) mapsUsed.add('orm'); if (m.roughMap) mapsUsed.add('roughness');
  }
  const summary = `${mats.size} material${mats.size === 1 ? '' : 's'}${mapsUsed.size ? `, maps ${[...mapsUsed].join('/')}` : ''}`;
  return {
    summary, hasUV: !!uv, uvAt,
    camera(r, u, fw) { camL = RIG.map((l) => ({ d: [0, 1, 2].map((k) => r[k] * l.d[0] + u[k] * l.d[1] - fw[k] * l.d[2]), c: l.c })); },
    shade(t, w0, w1, w2, dudx, dvdx, dudy, dvdy, view, back, out) {
      const m = triMat[t], a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
      if (uv) uvAt(t, w0, w1, w2, uvp);
      const lod = (sz: Mip[]) => 0.5 * Math.log2(Math.max(1e-30, Math.max((dudx * sz[0].w) ** 2 + (dvdx * sz[0].h) ** 2, (dudy * sz[0].w) ** 2 + (dvdy * sz[0].h) ** 2)));
      // base colour
      if (vcol.get(pm ? pm[triPrim[t]] : '')) {
        cdOf(a, triPrim[t], c3); base[0] = c3[0] * w0; base[1] = c3[1] * w0; base[2] = c3[2] * w0;
        cdOf(b, triPrim[t], c3); base[0] += c3[0] * w1; base[1] += c3[1] * w1; base[2] += c3[2] * w1;
        cdOf(c, triPrim[t], c3); base[0] += c3[0] * w2; base[1] += c3[1] * w2; base[2] += c3[2] * w2;
        for (let k = 0; k < 3; k++) base[k] = srgbToLinear(Math.max(0, Math.min(1, base[k])));
      } else if (m.baseMap && uv) { base[0] = base[1] = base[2] = 1; } else { base[0] = m.base[0]; base[1] = m.base[1]; base[2] = m.base[2]; }
      if (m.baseMap && uv) { sampleTri(m.baseMap, uvp[0], uvp[1], lod(m.baseMap), tx); base[0] *= tx[0]; base[1] *= tx[1]; base[2] *= tx[2]; }
      if (m.unlit) {
        out[0] = linearToSrgb(Math.min(1, base[0])); out[1] = linearToSrgb(Math.min(1, base[1])); out[2] = linearToSrgb(Math.min(1, base[2]));
        return;
      }
      let rough = m.roughness, metal = m.metallic, ao = 1;
      if (m.ormMap && uv) { sampleTri(m.ormMap, uvp[0], uvp[1], lod(m.ormMap), tx); ao = tx[0]; rough = tx[1]; metal = tx[2]; }
      else if (m.roughMap && uv) { sampleTri(m.roughMap, uvp[0], uvp[1], lod(m.roughMap), tx); rough = m.roughMap[0].ch === 4 ? tx[1] : tx[0]; }
      rough = Math.max(0.045, Math.min(1, rough)); metal = Math.max(0, Math.min(1, metal)); ao = Math.max(0, Math.min(1, ao));
      // normal: interpolated vertex normal, then the tangent-space map in the MikkTSpace frame
      n[0] = N[a * 3] * w0 + N[b * 3] * w1 + N[c * 3] * w2;
      n[1] = N[a * 3 + 1] * w0 + N[b * 3 + 1] * w1 + N[c * 3 + 1] * w2;
      n[2] = N[a * 3 + 2] * w0 + N[b * 3 + 2] * w1 + N[c * 3 + 2] * w2;
      if (m.normalMap && tan) {
        const o = t * 12;
        const ttx = tan[o] * w0 + tan[o + 4] * w1 + tan[o + 8] * w2, tty = tan[o + 1] * w0 + tan[o + 5] * w1 + tan[o + 9] * w2;
        const ttz = tan[o + 2] * w0 + tan[o + 6] * w1 + tan[o + 10] * w2, tw = tan[o + 3] * w0 + tan[o + 7] * w1 + tan[o + 11] * w2;
        if (shadingFrame(n[0], n[1], n[2], ttx, tty, ttz, tw, f)) {
          sampleTri(m.normalMap, uvp[0], uvp[1], lod(m.normalMap), tx);
          const x = tx[0] * 2 - 1, y = tx[1] * 2 - 1, z = tx[2] * 2 - 1;
          for (let k = 0; k < 3; k++) n[k] = f[k] * x + f[3 + k] * y + f[6 + k] * z;
        }
      }
      let l = Math.hypot(n[0], n[1], n[2]) || 1;
      if (back) l = -l;
      n[0] /= l; n[1] /= l; n[2] /= l;
      const NoV = Math.max(1e-4, n[0] * view[0] + n[1] * view[1] + n[2] * view[2]);
      const alpha = rough * rough, a2 = alpha * alpha;
      const F0 = [0, 1, 2].map((k) => 0.04 + (base[k] - 0.04) * metal);
      const diff = [0, 1, 2].map((k) => (base[k] * (1 - metal)) / Math.PI);
      let r = 0, gg = 0, bb = 0;
      for (const L of camL) {
        const NoL = n[0] * L.d[0] + n[1] * L.d[1] + n[2] * L.d[2];
        if (NoL <= 0) continue;
        const hx = L.d[0] + view[0], hy = L.d[1] + view[1], hz = L.d[2] + view[2], hl = Math.hypot(hx, hy, hz) || 1;
        const NoH = Math.max(0, (n[0] * hx + n[1] * hy + n[2] * hz) / hl), VoH = Math.max(0, (view[0] * hx + view[1] * hy + view[2] * hz) / hl);
        const dd = NoH * NoH * (a2 - 1) + 1, D = a2 / (Math.PI * dd * dd);
        const Vis = 0.5 / (NoL * Math.sqrt(NoV * NoV * (1 - a2) + a2) + NoV * Math.sqrt(NoL * NoL * (1 - a2) + a2));
        const fw = (1 - VoH) ** 5;
        for (let k = 0; k < 3; k++) {
          const F = F0[k] + (1 - F0[k]) * fw;
          const v = ((1 - F) * diff[k] + D * Vis * F) * L.c[k] * NoL;
          if (k === 0) r += v; else if (k === 1) gg += v; else bb += v;
        }
      }
      // indirect: sky/ground irradiance (diffuse) and the environment along the reflection (specular), both occluded
      env(n[1], 1, e);
      const ir = [e[0], e[1], e[2]];
      const RdotN = 2 * NoV, ry = RdotN * n[1] - view[1];
      env(ry, rough, e);
      // Karis' analytic environment BRDF
      const c0 = [-1, -0.0275, -0.572, 0.022], c1 = [1, 0.0425, 1.04, -0.04];
      const q = [rough * c0[0] + c1[0], rough * c0[1] + c1[1], rough * c0[2] + c1[2], rough * c0[3] + c1[3]];
      const a004 = Math.min(q[0] * q[0], 2 ** (-9.28 * NoV)) * q[0] + q[1];
      const A = a004 * -1.04 + q[2], B = a004 * 1.04 + q[3];
      for (let k = 0; k < 3; k++) {
        const ind = (base[k] * (1 - metal) * ir[k] + e[k] * (F0[k] * A + B)) * ao;
        out[k] = ((k === 0 ? r : k === 1 ? gg : bb) + ind + m.emissive[k]) * gain;
      }
      tone(out);
    },
  };
}
