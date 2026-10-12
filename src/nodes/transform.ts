// Transforms and deformers.
import { Geometry } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import {
  m4applyDir, m4apply, m4determinant3, m4invert, m4mul, m4normalMatrix, m4trs, qFromMat, qMul, normalize, cross, dot,
} from '../core/math.ts';
import type { Mat4, Vec3 } from '../core/math.ts';
import { pointNeighbors, reversePrims, buildEdges, refreshNormals } from '../core/topology.ts';
import { fractal, makeCurl, makeNoise } from '../core/noise.ts';
import { rng, rand } from '../core/random.ts';
import { TriBVH } from '../core/spatial.ts';
import { primNormals } from '../core/topology.ts';
import { AXES, P, getPointNormals, mask } from './util.ts';
import { evalRamp } from '../graph/params.ts';

/** Apply a matrix to positions and vector-like attributes of selected points. */
export function applyMatrix(src: Geometry, m: Mat4, ptMask: Uint8Array | null = null): Geometry {
  const g = src.clone();
  const Pd = g.P, np = g.numPoints;
  const nm = m4normalMatrix(m);
  // rotation part: normalise the basis columns (exact for uniform scale)
  const rot = new Float64Array(m);
  for (let c = 0; c < 3; c++) {
    const l = Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]) || 1;
    for (let r = 0; r < 3; r++) rot[c * 4 + r] = m[c * 4 + r] / l;
  }
  const rotQ = qFromMat(rot);
  for (let i = 0; i < np; i++) if (!ptMask || ptMask[i]) m4apply(m, Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2], Pd, i * 3);
  const vecAttribs = ['v', 'up', 'force', 'tangentu'];
  for (const cls of ['point', 'vertex', 'prim'] as const) {
    const t = g.table(cls);
    const sel = (i: number) => {
      if (!ptMask) return true;
      if (cls === 'point') return !!ptMask[i];
      if (cls === 'vertex') return !!ptMask[g.vertexPoint[i]];
      return true;
    };
    for (const [name, a] of t.map) {
      if (a.type !== 'float') continue;
      const d = a.data as Float64Array;
      if (name === 'N' && a.size === 3) {
        for (let i = 0; i < t.count; i++) if (sel(i)) {
          m4applyDir(nm, d[i * 3], d[i * 3 + 1], d[i * 3 + 2], d, i * 3);
          const l = Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]) || 1;
          d[i * 3] /= l; d[i * 3 + 1] /= l; d[i * 3 + 2] /= l;
        }
      } else if (vecAttribs.includes(name) && a.size === 3) {
        for (let i = 0; i < t.count; i++) if (sel(i)) m4applyDir(m, d[i * 3], d[i * 3 + 1], d[i * 3 + 2], d, i * 3);
      } else if (name === 'orient' && a.size === 4 && cls === 'point') {
        for (let i = 0; i < t.count; i++) if (sel(i)) {
          const q = qMul(rotQ, [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]]);
          d.set(q, i * 4);
        }
      }
    }
  }
  if (m4determinant3(m) < 0 && !ptMask) return reversePrims(g);
  for (let k = 0; k < g.volumes.length; k++) {
    const v = g.volumes[k];
    if (ptMask) continue;
    const inv = invertAffine(m);
    const sc = Math.cbrt(Math.abs(m4determinant3(m))) || 1;
    const corners: Vec3[] = [];
    for (let c = 0; c < 8; c++) corners.push(m4apply(m, c & 1 ? v.bounds.max[0] : v.bounds.min[0], c & 2 ? v.bounds.max[1] : v.bounds.min[1], c & 4 ? v.bounds.max[2] : v.bounds.min[2]) as Vec3);
    const mn: Vec3 = [Infinity, Infinity, Infinity], mx: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const c of corners) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], c[a]); mx[a] = Math.max(mx[a], c[a]); }
    const tmp = [0, 0, 0];
    const f = v.sample;
    g.volumes[k] = { ...v, bounds: { min: mn, max: mx }, sample: (x, y, z) => { m4apply(inv, x, y, z, tmp); return f(tmp[0], tmp[1], tmp[2]) * sc; } };
  }
  return g;
}

const invertAffine = (m: Mat4): Mat4 => m4invert(m);

defineNode({
  type: 'transform',
  category: 'transform',
  summary: 'Translate / rotate (degrees) / scale about a pivot. Also transforms N, v, up, orient and SDF volumes.',
  aliases: ['xform', 'move', 'rotate', 'scale'],
  inputs: [{ name: 'geo', desc: 'geometry to transform' }],
  params: {
    translate: { type: 'vec3', default: [0, 0, 0], desc: 'translation', aliases: ['t', 'move', 'offset', 'position'] },
    rotate: { type: 'vec3', default: [0, 0, 0], desc: 'rotation in degrees about X, Y, Z', aliases: ['r', 'rot', 'rotation'] },
    scale: { type: 'vec3', default: [1, 1, 1], desc: 'scale (a single number = uniform)', aliases: ['s'] },
    uniform_scale: { type: 'float', default: 1, desc: 'extra uniform scale multiplier', aliases: ['uniformscale', 'scale_uniform'] },
    pivot: { type: 'vec3', default: [0, 0, 0], desc: 'pivot for rotation and scale', aliases: ['p'] },
    pivot_mode: { type: 'enum', options: ['param', 'centroid', 'bbox_min', 'bbox_center_bottom'], default: 'param', desc: 'where the pivot comes from' },
    order: { type: 'enum', options: ['srt', 'str', 'rst', 'rts', 'tsr', 'trs'], default: 'srt', desc: 'transform order (srt = scale, then rotate, then translate)', aliases: ['xord'] },
    rotate_order: { type: 'enum', options: ['xyz', 'xzy', 'yxz', 'yzx', 'zxy', 'zyx'], default: 'xyz', desc: 'rotation order', aliases: ['rord'] },
    group: P.group('point', 'point group to transform ("" = all)'),
  },
  cook: ({ input, p }) => {
    const g = input(0);
    let pivot = p.pivot as Vec3;
    if (p.pivot_mode !== 'param') {
      const b = g.bbox(true);
      const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      pivot = p.pivot_mode === 'centroid' ? c : p.pivot_mode === 'bbox_min' ? b.min : [c[0], b.min[1], c[2]];
    }
    const s = (p.scale as number[]).map((x) => x * p.uniform_scale) as Vec3;
    const m = m4trs(p.translate, p.rotate, s, pivot, p.order, p.rotate_order);
    return applyMatrix(g, m, mask(g, 'point', p.group));
  },
});

defineNode({
  type: 'match_size',
  category: 'transform',
  summary: 'Align / fit the bounding box: e.g. sit on the ground (justify y=min), center, or scale to a target size.',
  aliases: ['matchsize', 'fit', 'align', 'center'],
  inputs: [{ name: 'geo', desc: 'geometry to move' }, { name: 'reference', desc: 'optional geometry to match (its bbox becomes the target)', optional: true }],
  params: {
    justify: { type: 'json', default: ['center', 'min', 'center'], desc: 'per axis X,Y,Z: "min" | "center" | "max" | "none". Default sits the object centered on the ground.' },
    target: { type: 'vec3', default: [0, 0, 0], desc: 'target position for the justified bbox points' },
    scale_to_fit: { type: 'bool', default: false, desc: 'scale uniformly so the largest dimension equals target_size' },
    target_size: { type: 'float', default: 1, desc: 'size for scale_to_fit' },
  },
  cook: ({ input, hasInput, p }) => {
    const g = input(0);
    const b = g.bbox(true);
    let tgt = p.target as number[], size = p.target_size as number;
    const just = Array.isArray(p.justify) ? p.justify : [p.justify, p.justify, p.justify];
    if (hasInput(1)) {
      const r = input(1).bbox(true);
      tgt = [0, 1, 2].map((a) => (just[a] === 'min' ? r.min[a] : just[a] === 'max' ? r.max[a] : (r.min[a] + r.max[a]) / 2));
      size = Math.max(...[0, 1, 2].map((a) => r.max[a] - r.min[a]));
    }
    const dims = [0, 1, 2].map((a) => b.max[a] - b.min[a]);
    const sc = p.scale_to_fit && Math.max(...dims) > 0 ? size / Math.max(...dims) : 1;
    const t: number[] = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const j = String(just[a] ?? 'none').toLowerCase();
      if (j === 'none') continue;
      const ref = j === 'min' ? b.min[a] : j === 'max' ? b.max[a] : (b.min[a] + b.max[a]) / 2;
      t[a] = tgt[a] - ref * sc;
    }
    const m = m4mul(m4trs(t as Vec3, [0, 0, 0], [1, 1, 1]), m4trs([0, 0, 0], [0, 0, 0], [sc, sc, sc]));
    return applyMatrix(g, m);
  },
});

defineNode({
  type: 'mirror',
  category: 'transform',
  summary: 'Mirror across a plane; optionally keep the original and weld the seam.',
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    axis: { type: 'enum', options: ['x', 'y', 'z', 'custom'], default: 'x', desc: 'mirror plane normal axis' },
    normal: { type: 'vec3', default: [1, 0, 0], desc: 'custom plane normal' },
    origin: { type: 'vec3', default: [0, 0, 0], desc: 'point on the mirror plane' },
    keep_original: { type: 'bool', default: true, desc: 'output original + mirrored copy' },
    fuse: { type: 'float', default: 1e-5, min: 0, desc: 'weld points on the seam within this distance (0 = off)' },
  },
  cook: ({ input, p }) => {
    const g = input(0);
    const n = normalize(p.axis === 'custom' ? p.normal : AXES[p.axis]);
    const o = p.origin as Vec3;
    // Householder reflection about plane (n, o)
    const m = new Float64Array(16);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[c * 4 + r] = (r === c ? 1 : 0) - 2 * n[r] * n[c];
    const d = 2 * dot(n, o);
    m[12] = n[0] * d; m[13] = n[1] * d; m[14] = n[2] * d; m[15] = 1;
    const mirrored = applyMatrix(g, m);
    if (!p.keep_original) return mirrored;
    const merged = Geometry.merge([g, mirrored]);
    if (p.fuse <= 0) return merged;
    return fusePoints(merged, p.fuse, (i) => {
      const P0 = merged.P;
      return Math.abs((P0[i * 3] - o[0]) * n[0] + (P0[i * 3 + 1] - o[1]) * n[1] + (P0[i * 3 + 2] - o[2]) * n[2]) <= p.fuse;
    });
  },
});

/** Weld points closer than dist (optionally only candidates). Removes collapsed prims. */
export function fusePoints(g: Geometry, dist: number, candidate?: (i: number) => boolean, average = false): Geometry {
  const n = g.numPoints, Pd = g.P;
  const cell = Math.max(dist, 1e-12);
  const grid = new Map<string, number[]>();
  const target = new Int32Array(n);
  for (let i = 0; i < n; i++) target[i] = i;
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < n; i++) {
    if (candidate && !candidate(i)) continue;
    const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const lst = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!lst) continue;
          for (const j of lst) {
            if (Math.hypot(Pd[j * 3] - x, Pd[j * 3 + 1] - y, Pd[j * 3 + 2] - z) <= dist) { found = j; break; }
          }
        }
    if (found >= 0) target[i] = found;
    else {
      const k = key(x, y, z);
      const lst = grid.get(k);
      if (lst) lst.push(i); else grid.set(k, [i]);
    }
  }
  const out = g.clone();
  if (average) {
    const acc = new Float64Array(n * 3), cnt = new Int32Array(n);
    for (let i = 0; i < n; i++) { const t = target[i]; acc[t * 3] += Pd[i * 3]; acc[t * 3 + 1] += Pd[i * 3 + 1]; acc[t * 3 + 2] += Pd[i * 3 + 2]; cnt[t]++; }
    for (let i = 0; i < n; i++) if (cnt[i] > 1) for (let c = 0; c < 3; c++) out.P[i * 3 + c] = acc[i * 3 + c] / cnt[i];
  }
  for (let v = 0; v < out.numVertices; v++) out.vertexPoint[v] = target[out.vertexPoint[v]];
  return removeDegenerate(out).removeUnusedPoints();
}

/** Drop consecutive duplicate vertices and prims that collapse below 3 (polygons) or 2 (lines) points. */
export function removeDegenerate(g: Geometry): Geometry {
  const keepV: number[] = [], starts = [0], keepP: number[] = [];
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    const vs: number[] = [];
    for (let v = s; v < e; v++) {
      const pt = g.vertexPoint[v];
      if (vs.length && g.vertexPoint[vs[vs.length - 1]] === pt) continue;
      vs.push(v);
    }
    if (g.primClosed[p] && vs.length > 1 && g.vertexPoint[vs[0]] === g.vertexPoint[vs[vs.length - 1]]) vs.pop();
    if (vs.length < (g.primClosed[p] ? 3 : 2)) continue;
    keepP.push(p);
    keepV.push(...vs);
    starts.push(keepV.length);
  }
  if (keepP.length === g.numPrims && keepV.length === g.numVertices) return g;
  const out = g.clone();
  out.prims = g.prims.gather(keepP);
  out.vertices = g.vertices.gather(keepV);
  out.primStart = Int32Array.from(starts);
  out.vertexPoint = Int32Array.from(keepV, (v) => g.vertexPoint[v]);
  out.primClosed = Uint8Array.from(keepP, (p) => g.primClosed[p]);
  out.primGroups = new Map([...g.primGroups].map(([k, m]) => [k, Uint8Array.from(keepP, (p) => m[p])]));
  return out;
}

defineNode({
  type: 'copy_xform',
  category: 'copy',
  summary: 'Make N copies, each transformed cumulatively (Houdini Copy and Transform): stairs, radial arrays, stacks.',
  aliases: ['copy', 'copyxform', 'array', 'duplicate'],
  inputs: [{ name: 'geo', desc: 'geometry to copy' }],
  params: {
    count: { type: 'int', default: 4, min: 0, desc: 'total copies (including the original)', aliases: ['ncy', 'copies', 'n'] },
    translate: { type: 'vec3', default: [1, 0, 0], desc: 'offset applied per copy', aliases: ['t', 'offset'] },
    rotate: { type: 'vec3', default: [0, 0, 0], desc: 'rotation per copy (degrees)', aliases: ['r'] },
    scale: { type: 'vec3', default: [1, 1, 1], desc: 'scale per copy (compounding)', aliases: ['s'] },
    pivot: { type: 'vec3', default: [0, 0, 0], desc: 'pivot for rotate/scale' },
    copy_attrib: { type: 'string', default: 'copynum', desc: 'prim int attribute storing the copy index ("" = none)' },
  },
  outputs: 'prim copynum',
  cook: ({ input, p }) => {
    const g = input(0);
    const step = m4trs(p.translate, p.rotate, p.scale, p.pivot);
    let m = m4trs([0, 0, 0], [0, 0, 0], [1, 1, 1]);
    const parts: Geometry[] = [];
    for (let i = 0; i < p.count; i++) {
      const c = i === 0 ? g.clone() : applyMatrix(g, m);
      if (p.copy_attrib) (c.prims.add(p.copy_attrib, 'int', 1).data as Int32Array).fill(i);
      parts.push(c);
      m = m4mul(step, m);
    }
    return Geometry.merge(parts);
  },
});

defineNode({
  type: 'noise_displace',
  category: 'deform',
  summary: 'Displace points with fractal noise (Houdini Mountain): along normals, a fixed direction, or in 3D.',
  aliases: ['mountain', 'displace', 'noise'],
  inputs: [{ name: 'geo', desc: 'geometry to deform' }],
  params: {
    amplitude: { type: 'float', default: 0.2, desc: 'displacement strength', aliases: ['amp', 'height', 'strength'] },
    frequency: { type: 'vec3', default: [1, 1, 1], desc: 'noise frequency per axis (single number = uniform)', aliases: ['freq'] },
    offset: { type: 'vec3', default: [0, 0, 0], desc: 'noise space offset' },
    mode: { type: 'enum', options: ['normal', 'direction', '3d', 'curl'], default: 'normal', desc: 'normal = along N; direction = along "direction"; 3d = independent noise per axis; curl = divergence-free flow' },
    direction: { type: 'vec3', default: [0, 1, 0], desc: 'direction for mode=direction' },
    noise: { type: 'enum', options: ['perlin', 'simplex', 'value', 'worley'], default: 'perlin', desc: 'base noise' },
    fractal: { type: 'enum', options: ['fbm', 'ridged', 'turbulence', 'none'], default: 'fbm', desc: 'fractal layering' },
    octaves: { type: 'int', default: 3, min: 1, max: 12, desc: 'octaves' },
    roughness: { type: 'float', default: 0.5, desc: 'gain per octave' },
    lacunarity: { type: 'float', default: 2, desc: 'frequency gain per octave' },
    centered: { type: 'bool', default: true, desc: 'noise in [-1,1] (false shifts to [0,1]: only pushes outward)' },
    seed: P.seed(),
    mask_attrib: { type: 'string', default: '', desc: 'point float attribute that scales the amplitude per point' },
    store: { type: 'string', default: '', desc: 'also store the scalar noise value in this point attribute ("" = off)' },
    rest_attrib: { type: 'string', default: 'rest', desc: 'sample the noise at this point vec3 attribute instead of P when it exists, so the pattern sticks to deforming geometry (see the rest node; "" = always P)' },
    group: P.group('point'),
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const sel = mask(g, 'point', p.group);
    const base = makeNoise(p.noise, p.seed);
    const n = fractal(base, { octaves: p.octaves, roughness: p.roughness, lacunarity: p.lacunarity, fractal: p.fractal });
    const f = p.frequency, o = p.offset;
    const Pd = g.P, np = g.numPoints;
    const ra = p.rest_attrib ? g.points.get(p.rest_attrib) : undefined;
    const Q = ra && ra.type === 'float' && ra.size === 3 ? (ra.data as Float64Array).slice() : Pd;
    const N = p.mode === 'normal' ? getPointNormals(g).slice() : null;
    const dir = normalize(p.direction);
    const ma = p.mask_attrib ? g.points.get(p.mask_attrib) : null;
    if (p.mask_attrib && !ma) throw new NodeError(`mask_attrib "${p.mask_attrib}" not found on points`);
    const st = p.store ? (g.points.add(p.store, 'float', 1).data as Float64Array) : null;
    const curl = p.mode === 'curl' ? makeCurl(n) : null;
    const n2 = p.mode === '3d' ? fractal(makeNoise(p.noise, p.seed + 1), { octaves: p.octaves, roughness: p.roughness, lacunarity: p.lacunarity, fractal: p.fractal }) : null;
    const n3 = p.mode === '3d' ? fractal(makeNoise(p.noise, p.seed + 2), { octaves: p.octaves, roughness: p.roughness, lacunarity: p.lacunarity, fractal: p.fractal }) : null;
    const center = (v: number) => (p.noise === 'worley' ? v * 2 - 1 : v);
    for (let i = 0; i < np; i++) {
      if (sel && !sel[i]) continue;
      const x = Q[i * 3] * f[0] + o[0], y = Q[i * 3 + 1] * f[1] + o[1], z = Q[i * 3 + 2] * f[2] + o[2];
      const amp = p.amplitude * (ma ? (ma.get(i) as number) : 1);
      if (curl) {
        const c = curl(x, y, z);
        Pd[i * 3] += c[0] * amp; Pd[i * 3 + 1] += c[1] * amp; Pd[i * 3 + 2] += c[2] * amp;
        if (st) st[i] = Math.hypot(c[0], c[1], c[2]);
        continue;
      }
      let v = center(n(x, y, z));
      if (!p.centered) v = v * 0.5 + 0.5;
      if (st) st[i] = v;
      if (n2 && n3) {
        let v2 = center(n2(x, y, z)), v3 = center(n3(x, y, z));
        if (!p.centered) { v2 = v2 * 0.5 + 0.5; v3 = v3 * 0.5 + 0.5; }
        Pd[i * 3] += v * amp; Pd[i * 3 + 1] += v2 * amp; Pd[i * 3 + 2] += v3 * amp;
      } else {
        const d = N ? [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]] : dir;
        Pd[i * 3] += d[0] * v * amp; Pd[i * 3 + 1] += d[1] * v * amp; Pd[i * 3 + 2] += d[2] * v * amp;
      }
    }
    return refreshNormals(g);
  },
});

function axisRange(g: Geometry, ax: number) {
  const b = g.bbox();
  return { lo: b.min[ax], hi: b.max[ax], c: b.min.map((m, a) => (m + b.max[a]) / 2) };
}

defineNode({
  type: 'twist',
  category: 'deform',
  summary: 'Twist around an axis: rotation grows linearly along that axis across the bounding box.',
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    axis: { type: 'enum', options: ['y', 'x', 'z'], default: 'y', desc: 'twist axis' },
    angle: { type: 'float', default: 90, desc: 'total twist in degrees from bbox start to end' },
    center: { type: 'vec3', default: [0, 0, 0], desc: 'axis passes through this point (use_bbox_center overrides)' },
    use_bbox_center: { type: 'bool', default: true, desc: 'twist about the bbox center' },
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const ax = 'xyz'.indexOf(p.axis), u = (ax + 1) % 3, v = (ax + 2) % 3;
    const r = axisRange(g, ax), c = p.use_bbox_center ? r.c : p.center;
    const Pd = g.P;
    for (let i = 0; i < g.numPoints; i++) {
      const t = r.hi > r.lo ? (Pd[i * 3 + ax] - r.lo) / (r.hi - r.lo) : 0;
      const a = (p.angle * t * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
      const du = Pd[i * 3 + u] - c[u], dv = Pd[i * 3 + v] - c[v];
      Pd[i * 3 + u] = c[u] + du * cs - dv * sn;
      Pd[i * 3 + v] = c[v] + du * sn + dv * cs;
    }
    return refreshNormals(g);
  },
});

defineNode({
  type: 'bend',
  category: 'deform',
  summary: 'Bend along an axis into an arc of the given angle (like a simple-deform bend).',
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    axis: { type: 'enum', options: ['y', 'x', 'z'], default: 'y', desc: 'the length axis that gets bent' },
    toward: { type: 'enum', options: ['x', 'y', 'z', '-x', '-y', '-z'], default: 'x', desc: 'direction the end bends toward' },
    angle: { type: 'float', default: 90, desc: 'total bend angle in degrees' },
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const ax = 'xyz'.indexOf(p.axis);
    const tw = p.toward.replace('-', ''), sign = p.toward.startsWith('-') ? -1 : 1;
    const bx = 'xyz'.indexOf(tw);
    if (bx === ax) throw new NodeError('"toward" must differ from "axis"');
    const r = axisRange(g, ax), Lh = r.hi - r.lo;
    const theta = (p.angle * Math.PI) / 180;
    if (Math.abs(theta) < 1e-9 || Lh <= 0) return g;
    const R = Lh / theta;
    const Pd = g.P;
    for (let i = 0; i < g.numPoints; i++) {
      const s = Pd[i * 3 + ax] - r.lo; // distance along the length axis
      const d = (Pd[i * 3 + bx] - r.c[bx]) * sign; // offset toward bend direction
      const a = s / R, rr = R - d;
      Pd[i * 3 + ax] = r.lo + rr * Math.sin(a);
      Pd[i * 3 + bx] = r.c[bx] + sign * (R - rr * Math.cos(a));
    }
    return refreshNormals(g);
  },
});

defineNode({
  type: 'taper',
  category: 'deform',
  summary: 'Scale cross-sections along an axis (linear or ramp), e.g. tapering columns or horns.',
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    axis: { type: 'enum', options: ['y', 'x', 'z'], default: 'y', desc: 'taper axis' },
    scale_start: { type: 'float', default: 1, desc: 'scale at the bbox start' },
    scale_end: { type: 'float', default: 0.5, desc: 'scale at the bbox end' },
    ramp: { type: 'ramp', default: [[0, 0], [1, 1]], desc: 'interpolation profile from start (0) to end (1)' },
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const ax = 'xyz'.indexOf(p.axis), u = (ax + 1) % 3, v = (ax + 2) % 3;
    const r = axisRange(g, ax);
    const Pd = g.P;
    for (let i = 0; i < g.numPoints; i++) {
      const t = r.hi > r.lo ? (Pd[i * 3 + ax] - r.lo) / (r.hi - r.lo) : 0;
      const k = evalRamp(p.ramp, t) as number;
      const s = p.scale_start + (p.scale_end - p.scale_start) * k;
      Pd[i * 3 + u] = r.c[u] + (Pd[i * 3 + u] - r.c[u]) * s;
      Pd[i * 3 + v] = r.c[v] + (Pd[i * 3 + v] - r.c[v]) * s;
    }
    return refreshNormals(g);
  },
});

defineNode({
  type: 'smooth',
  category: 'deform',
  summary: 'Relax point positions (Laplacian or volume-preserving Taubin smoothing).',
  aliases: ['relax', 'laplacian'],
  inputs: [{ name: 'geo', desc: 'mesh or curves' }],
  params: {
    iterations: { type: 'int', default: 10, min: 0, desc: 'smoothing passes', aliases: ['iter'] },
    strength: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'move fraction per pass' },
    method: { type: 'enum', options: ['taubin', 'laplacian'], default: 'taubin', desc: 'taubin avoids shrinking' },
    preserve_boundary: { type: 'bool', default: true, desc: 'pin open-boundary and curve end points' },
    group: P.group('point'),
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const sel = mask(g, 'point', p.group);
    const { start, nb } = pointNeighbors(g);
    const pin = new Uint8Array(g.numPoints);
    if (p.preserve_boundary) {
      const E = buildEdges(g);
      for (let e = 0; e < E.a.length; e++) if (E.count[e] === 1 && g.primClosed[E.firstPrim[e]]) { pin[E.a[e]] = 1; pin[E.b[e]] = 1; }
      for (let pr = 0; pr < g.numPrims; pr++) if (!g.primClosed[pr]) {
        pin[g.vertexPoint[g.primStart[pr]]] = 1;
        pin[g.vertexPoint[g.primStart[pr + 1] - 1]] = 1;
      }
    }
    const Pd = g.P, tmp = new Float64Array(Pd.length);
    const pass = (lam: number) => {
      tmp.set(Pd);
      for (let i = 0; i < g.numPoints; i++) {
        if (pin[i] || (sel && !sel[i])) continue;
        const s = start[i], e = start[i + 1];
        if (e === s) continue;
        let x = 0, y = 0, z = 0;
        for (let k = s; k < e; k++) { const j = nb[k]; x += tmp[j * 3]; y += tmp[j * 3 + 1]; z += tmp[j * 3 + 2]; }
        const c = e - s;
        Pd[i * 3] += (x / c - tmp[i * 3]) * lam;
        Pd[i * 3 + 1] += (y / c - tmp[i * 3 + 1]) * lam;
        Pd[i * 3 + 2] += (z / c - tmp[i * 3 + 2]) * lam;
      }
    };
    for (let it = 0; it < p.iterations; it++) {
      pass(p.strength);
      if (p.method === 'taubin') pass(-p.strength * 1.04);
    }
    return refreshNormals(g);
  },
});

defineNode({
  type: 'peak',
  category: 'deform',
  summary: 'Push points along their normals by a distance (inflate / shrink).',
  aliases: ['inflate', 'push'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    distance: { type: 'float', default: 0.05, desc: 'offset along N', aliases: ['dist', 'amount'] },
    group: P.group('point'),
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const sel = mask(g, 'point', p.group);
    const N = getPointNormals(g).slice(), Pd = g.P;
    for (let i = 0; i < g.numPoints; i++) if (!sel || sel[i]) for (let c = 0; c < 3; c++) Pd[i * 3 + c] += N[i * 3 + c] * p.distance;
    return refreshNormals(g);
  },
});

defineNode({
  type: 'jitter',
  category: 'deform',
  summary: 'Random offset per point (deterministic by seed).',
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    scale: { type: 'vec3', default: [0.05, 0.05, 0.05], desc: 'max offset per axis (single number = uniform)', aliases: ['amount', 'amplitude'] },
    seed: P.seed(),
    group: P.group('point'),
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const sel = mask(g, 'point', p.group);
    const Pd = g.P;
    for (let i = 0; i < g.numPoints; i++) {
      if (sel && !sel[i]) continue;
      for (let c = 0; c < 3; c++) Pd[i * 3 + c] += (rand(i * 3 + c, p.seed) * 2 - 1) * p.scale[c];
    }
    return refreshNormals(g);
  },
});

defineNode({
  type: 'ray',
  category: 'deform',
  summary: 'Project points onto a target surface (along a direction, along N, or to the closest point).',
  aliases: ['project', 'raycast', 'snap_to_surface'],
  inputs: [{ name: 'geo', desc: 'points/geometry to move' }, { name: 'target', desc: 'collision surface' }],
  params: {
    mode: { type: 'enum', options: ['direction', 'normal', 'closest'], default: 'direction', desc: 'how to find the hit' },
    direction: { type: 'vec3', default: [0, -1, 0], desc: 'ray direction (mode=direction)' },
    bidirectional: { type: 'bool', default: true, desc: 'also try the opposite direction' },
    max_distance: { type: 'float', default: 1e9, desc: 'ignore hits further than this' },
    lift: { type: 'float', default: 0, desc: 'offset from the surface along its normal after projection' },
    orient: { type: 'bool', default: true, desc: 'set point N to the surface normal at the hit' },
    delete_misses: { type: 'bool', default: false, desc: 'delete points that do not hit' },
    group: P.group('point'),
  },
  outputs: 'point N (orient), hitprim, hitdist',
  cook: ({ input, p }) => {
    const g = input(0).clone(), tgt = input(1);
    const bvh = new TriBVH(tgt);
    if (!bvh.numTris) throw new NodeError('target has no polygons to hit');
    const fn = primNormals(tgt);
    const sel = mask(g, 'point', p.group);
    const Pd = g.P;
    const N = p.mode === 'normal' ? getPointNormals(g).slice() : null;
    const outN = p.orient ? (g.points.add('N', 'float', 3).data as Float64Array) : null;
    const hp = g.points.add('hitprim', 'int', 1).data as Int32Array;
    const hd = g.points.add('hitdist', 'float', 1).data as Float64Array;
    const miss = new Uint8Array(g.numPoints);
    const dir = normalize(p.direction);
    for (let i = 0; i < g.numPoints; i++) {
      if (sel && !sel[i]) continue;
      const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
      let hit: { pos: number[]; prim: number; dist: number } | null = null;
      if (p.mode === 'closest') {
        const c = bvh.closest(x, y, z, p.max_distance);
        if (c) hit = { pos: c.pos, prim: c.prim, dist: c.dist };
      } else {
        const d = N ? [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]] : dir;
        const a = bvh.raycast(x, y, z, d[0], d[1], d[2], p.max_distance, 0);
        const b = p.bidirectional ? bvh.raycast(x, y, z, -d[0], -d[1], -d[2], p.max_distance, 0) : null;
        const best = a && (!b || a.t <= b.t) ? a : b;
        if (best) hit = { pos: best.pos, prim: best.prim, dist: best.t };
      }
      if (!hit) { miss[i] = 1; hp[i] = -1; hd[i] = -1; continue; }
      const nx = fn[hit.prim * 3], ny = fn[hit.prim * 3 + 1], nz = fn[hit.prim * 3 + 2];
      Pd[i * 3] = hit.pos[0] + nx * p.lift; Pd[i * 3 + 1] = hit.pos[1] + ny * p.lift; Pd[i * 3 + 2] = hit.pos[2] + nz * p.lift;
      if (outN) { outN[i * 3] = nx; outN[i * 3 + 1] = ny; outN[i * 3 + 2] = nz; }
      hp[i] = hit.prim; hd[i] = hit.dist;
    }
    if (p.delete_misses) return g.subsetPoints(miss.map((m) => (m ? 0 : 1)));
    return g;
  },
});

export { cross };
