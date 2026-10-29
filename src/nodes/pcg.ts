// PCG nodes (procedural content generation, the Houdini scatter/instancing toolkit and Unreal PCG's point filters):
// mask, attribute_from_map, orient, points_along_curve, cluster, prune. Scatter v2 and copy_to_points variants live in
// copy.ts; the kernels in core/pcg.ts. The usual chain: mask → scatter {density_mask} → orient → prune → copy_to_points
// {pack} → export (help topic "pcg").
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import type { Attribute } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { evalRamp } from '../graph/params.ts';
import { pointNormals, primNormals, triangulate } from '../core/topology.ts';
import { KDTree } from '../core/spatial.ts';
import { RayScene, SegmentTree, SurfaceQuery, bboxDiagonal, discreteCurvature, fillFromNearestValid, newNearest, rayMeasure } from '../core/analysis.ts';
import { fractal, makeNoise } from '../core/noise.ts';
import { rng } from '../core/random.ts';
import { qAxisAngle, qMul, qNormalize, qRotate } from '../core/math.ts';
import type { Quat, Vec3 } from '../core/math.ts';
import {
  MASK_COMBINE, TriSurface, band, combineMask, elementSeed, frameQuat, kmeans, perpTo, radiusClusters, sampleImage,
  sphereOverlapPrune,
} from '../core/pcg.ts';
import type { Clusters, TriPoint, WrapMode } from '../core/pcg.ts';
import { decodePNG } from '../io/png-decode.ts';
import { rmFrames } from './curves.ts';
import { evaluateSplines } from '../core/splines.ts';
import { P, getPointNormals, mask } from './util.ts';

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);
const unit = (v: ArrayLike<number>): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
};
const hasPolygons = (g: Geometry) => {
  for (let p = 0; p < g.numPrims; p++) if (g.primClosed[p] && g.primSize(p) >= 3 && !(g.primKind && g.primKind[p])) return true;
  return false;
};
/** A float point attribute of the given size, or null. */
const floatPoint = (g: Geometry, name: string, size: number): Float64Array | null => {
  const a = g.points.get(name);
  return a && a.type === 'float' && a.size === size && !a.isArray ? (a.data as Float64Array) : null;
};
/** Ramp keys that are the identity [[0,0],[1,1]]. */
const isIdentityRamp = (r: any) => !r || (r.length === 2 && r[0].pos === 0 && r[0].value === 0 && r[1].pos === 1 && r[1].value === 1);
const rampValue = (r: any, x: number) => { const v = evalRamp(r, x); return clamp01(Array.isArray(v) ? Number(v[0]) : Number(v)); };

/**
 * Closest points and normals on the polygons of a reference geometry (smooth: point normals interpolated over the
 * triangle; else the face normal).
 */
class SurfaceNormals {
  surf: TriSurface;
  tris: Uint32Array;
  triPrim: Uint32Array;
  g: Geometry;
  N: Float64Array;
  faceN: Float64Array;
  smooth: boolean;
  tp: TriPoint = { x: 0, y: 0, z: 0, b0: 1, b1: 0, b2: 0 };

  constructor(g: Geometry, smooth = true) {
    const { tris, triPrim } = triangulate(g);
    this.g = g; this.tris = tris; this.triPrim = triPrim; this.smooth = smooth;
    this.surf = new TriSurface(g, tris);
    this.N = smooth ? getPointNormals(g) : new Float64Array(0);
    this.faceN = primNormals(g);
  }

  get empty() { return this.surf.numTris === 0; }

  /** Closest point → out position (tp) and the unit normal there; false without triangles. */
  at(x: number, y: number, z: number, n: number[]): boolean {
    const t = this.surf.closest(x, y, z, this.tp);
    if (t < 0) return false;
    if (this.smooth) {
      const w = [this.tp.b0, this.tp.b1, this.tp.b2], N = this.N;
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < 3; k++) { const p = this.g.vertexPoint[this.tris[t * 3 + k]] * 3; nx += N[p] * w[k]; ny += N[p + 1] * w[k]; nz += N[p + 2] * w[k]; }
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-12) { n[0] = nx / l; n[1] = ny / l; n[2] = nz / l; return true; }
    }
    const pr = this.triPrim[t] * 3, F = this.faceN;
    n[0] = F[pr]; n[1] = F[pr + 1]; n[2] = F[pr + 2];
    return true;
  }
}

/**
 * Point normals for masks and orientation: the point N attribute; else, for a point cloud with a reference surface,
 * the surface normal at the closest point; else normals computed from the input's polygons; else +Y.
 */
function normalsFor(g: Geometry, ref: Geometry | null, warn: (m: string) => void): Float64Array {
  const own = floatPoint(g, 'N', 3);
  if (own) return own;
  if (ref && hasPolygons(ref) && !hasPolygons(g)) {
    const sn = new SurfaceNormals(ref);
    const out = new Float64Array(g.numPoints * 3), n = [0, 1, 0], P = g.P;
    for (let i = 0; i < g.numPoints; i++) {
      if (!sn.at(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], n)) { n[0] = 0; n[1] = 1; n[2] = 0; }
      out[i * 3] = n[0]; out[i * 3 + 1] = n[1]; out[i * 3 + 2] = n[2];
    }
    return out;
  }
  if (hasPolygons(g)) return getPointNormals(g);
  if (g.numPoints) warn('points have no N and there is no surface (input 1) to take normals from: using +Y');
  const out = new Float64Array(g.numPoints * 3);
  for (let i = 0; i < g.numPoints; i++) out[i * 3 + 1] = 1;
  return out;
}

const angleDeg = (a: ArrayLike<number>, o: number, b: Vec3) => {
  const l = Math.hypot(a[o], a[o + 1], a[o + 2]);
  if (!(l > 1e-12)) return NaN;
  const c = (a[o] * b[0] + a[o + 1] * b[1] + a[o + 2] * b[2]) / l;
  return (Math.acos(c > 1 ? 1 : c < -1 ? -1 : c) * 180) / Math.PI;
};

// ---------------------------------------------------------------- mask

const MASK_BY = ['slope', 'height', 'curvature', 'occlusion', 'distance', 'direction', 'noise', 'attribute', 'group', 'inside'];

defineNode({
  type: 'mask',
  category: 'pcg',
  packed: 'keep',
  summary: 'Write a 0..1 point mask from a feature (slope, height, curvature, occlusion, distance, direction, noise, attribute, group, inside), shaped by a band with falloff and a ramp, and combined with an existing mask. Feed scatter density_mask or prune.',
  description:
    'Houdini: Mask by Feature / attribute from features; Unreal PCG: Density Filter inputs (Normal To Density, Distance, Spatial Noise). ' +
    'The feature value v becomes 1 inside [min, max] and fades linearly to 0 over `falloff` outside it (a hard edge when falloff is 0), ' +
    'then ramp reshapes it, invert flips it, and combine merges it with the existing mask attribute (replace, multiply = and, max = or, add, ' +
    'subtract, min). Units of min/max per feature: slope = degrees between N and up (0 flat, 90 vertical; default 0..30 = gentle ground); ' +
    'height = metres along up (Y); curvature = mean curvature in 1/m (positive convex: ridges, bumps; negative concave: valleys); ' +
    'occlusion = 0..1 ambient occlusion (rays against the geometry and input 1); distance = metres to input 1 (mesh, curves or points; ' +
    'e.g. away from a road: min 3, max 1e9); direction = degrees between N and `direction` (e.g. north faces); noise = 0..1 fractal noise ' +
    '(frequency, octaves, seed); attribute = the value of source_attrib (first component); group = 1 for points matching `pattern`; ' +
    'inside = 1 inside input 1\'s closed mesh (falloff = soft edge in metres outside it). Normals: the point N, else for a point cloud ' +
    'the normal of input 1 at the closest point, else computed from the polygons. Packed instances keep their anchors.',
  aliases: ['pcg_mask', 'scatter_mask', 'mask_by_feature', 'maskbyfeature', 'point_mask'],
  inputs: [
    { name: 'geo', desc: 'points or mesh to mask (the mask is a point attribute)' },
    { name: 'reference', desc: 'distance / inside: what to measure to; slope, direction, curvature, occlusion of a point cloud: the surface it lies on', optional: true },
  ],
  params: {
    by: { type: 'enum', options: MASK_BY, default: 'slope', desc: 'feature to mask by', aliases: ['feature', 'type'] },
    min: { type: 'float', default: 0, desc: 'lowest feature value with mask 1 (units depend on `by`)', aliases: ['min_value', 'low'] },
    max: { type: 'float', default: 30, desc: 'highest feature value with mask 1', aliases: ['max_value', 'high'] },
    falloff: { type: 'float', default: 0, min: 0, desc: 'linear fade outside [min, max] in feature units (inside: metres outside the mesh); 0 = hard edge', aliases: ['fade', 'soft'] },
    ramp: { type: 'ramp', default: [[0, 0], [1, 1]], desc: 'reshape the 0..1 mask before combining' },
    invert: { type: 'bool', default: false, desc: 'invert the feature mask (1 - mask) before combining' },
    combine: { type: 'enum', options: MASK_COMBINE, default: 'replace', desc: 'merge with the existing mask attribute: multiply = and, max = or (missing attribute = start from scratch)', aliases: ['mode', 'operation', 'blend'] },
    name: { type: 'string', default: 'mask', desc: 'output point float attribute', aliases: ['output', 'output_attrib', 'mask_name'] },
    up: { type: 'vec3', default: [0, 1, 0], desc: 'slope: the "flat" normal; height: the axis heights are measured along', aliases: ['up_vector', 'axis'] },
    direction: { type: 'vec3', default: [1, 0, 0], desc: 'direction: the facing direction measured against N (angle in degrees)', aliases: ['facing'] },
    source_attrib: { type: 'string', default: '', desc: 'attribute: the point attribute to read (vectors: first component)', aliases: ['from_attrib', 'input_attrib', 'feature_attrib'] },
    pattern: { type: 'group', default: '', groupClass: 'point', desc: 'group: point group pattern that gets 1 (e.g. "top", "@P.y>2")' },
    frequency: { type: 'float', default: 0.2, min: 0, desc: 'noise: spatial frequency (1/m)', aliases: ['freq'] },
    octaves: { type: 'int', default: 3, min: 1, max: 8, desc: 'noise: fractal octaves' },
    samples: { type: 'int', default: 16, min: 1, max: 256, desc: 'occlusion: rays per point', aliases: ['rays'] },
    max_distance: { type: 'float', default: 0, min: 0, desc: 'occlusion: rays only count hits closer than this (0 = unlimited)', aliases: ['radius', 'maxdist'] },
    seed: P.seed(),
    group: P.group('point', 'points to write ("" = all); the others keep their mask (0 when new)'),
  },
  outputs: 'point float mask (or <name>)',
  example: {
    nodes: {
      land: { type: 'terrain', params: { size: [60, 60], height: 8 } },
      flat: { type: 'mask', in: ['land'], params: { by: 'slope', min: 0, max: 20, falloff: 10 } },
      low: { type: 'mask', in: ['flat'], params: { by: 'height', min: -100, max: 4, falloff: 1, combine: 'multiply' } },
      pts: { type: 'scatter', in: ['low'], params: { generate_by: 'density', density: 0.5, density_mask: 'mask' } },
    },
    output: 'pts',
  },
  cook: ({ input, hasInput, p, warn, stat }) => {
    const src = input(0);
    const ref = hasInput(1) ? input(1) : null;
    const g = src.clone();
    const n = g.numPoints, Pd = g.P;
    const sel = mask(g, 'point', p.group);
    const name = String(p.name || 'mask');
    const prevA = g.points.get(name);
    const prev = prevA && prevA.type !== 'string' && !prevA.isArray && prevA.size === 1 ? Float64Array.from(prevA.data as Float64Array) : null;
    const v = new Float64Array(n);
    const by = p.by as string;
    const needRef = (what: string) => {
      if (!ref || (!ref.numPoints && !ref.numPrims)) throw new NodeError(`mask by ${by}: connect ${what} as the second input`, '"in": ["points", "reference"]');
      return ref;
    };
    let direct = false; // group / inside give the mask directly (no band)
    switch (by) {
      case 'slope': case 'direction': {
        const N = normalsFor(g, ref, warn);
        const axis = unit(by === 'slope' ? p.up : p.direction);
        if (!(axis[0] || axis[1] || axis[2])) throw new NodeError(`mask by ${by}: ${by === 'slope' ? 'up' : 'direction'} is the zero vector`);
        for (let i = 0; i < n; i++) v[i] = angleDeg(N, i * 3, axis);
        break;
      }
      case 'height': {
        const ax = unit(p.up);
        if (!(ax[0] || ax[1] || ax[2])) throw new NodeError('mask by height: up is the zero vector');
        for (let i = 0; i < n; i++) v[i] = Pd[i * 3] * ax[0] + Pd[i * 3 + 1] * ax[1] + Pd[i * 3 + 2] * ax[2];
        break;
      }
      case 'curvature': {
        const surf = hasPolygons(g) ? g : ref && hasPolygons(ref) ? ref : null;
        if (!surf) throw new NodeError('mask by curvature needs polygons: a mesh, or points with the mesh they lie on as the second input');
        const c = discreteCurvature(surf, pointNormals(surf));
        fillFromNearestValid(surf, c.valid, [c.mean]);
        if (surf === g) v.set(c.mean.subarray(0, n));
        else {
          const kd = new KDTree(surf.P);
          for (let i = 0; i < n; i++) { const r = kd.nearest(Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2]); v[i] = r.index >= 0 ? c.mean[r.index] : 0; }
        }
        break;
      }
      case 'occlusion': {
        const parts = [hasPolygons(g) ? g : null, ref && hasPolygons(ref) ? ref : null].filter(Boolean) as Geometry[];
        if (!parts.length) throw new NodeError('mask by occlusion needs polygons to cast rays against: a mesh, or the surface as the second input');
        const scene = RayScene.of(parts.length > 1 ? Geometry.merge(parts) : parts[0]);
        const diag = bboxDiagonal(parts[0]) || 1;
        const N = normalsFor(g, ref, warn);
        const ao = rayMeasure(Pd, N, scene, { mode: 'occlusion', samples: p.samples, maxDistance: p.max_distance, bias: 1e-4 * diag, coneAngle: 90, seed: p.seed }, sel);
        v.set(ao);
        stat('rays', (sel ? sel.reduce((s, x) => s + x, 0) : n) * p.samples);
        break;
      }
      case 'distance': {
        const q = new SurfaceQuery(needRef('the geometry to measure to (mesh, curves or points)'));
        if (q.empty) throw new NodeError('mask by distance: the second input has nothing to measure to');
        const nr = newNearest();
        for (let i = 0; i < n; i++) v[i] = q.nearest(Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2], Infinity, nr) ? nr.dist : Infinity;
        break;
      }
      case 'inside': {
        const r = needRef('a closed mesh');
        const q = new SurfaceQuery(r);
        if (!q.hasPolygons) throw new NodeError('mask by inside: the second input has no polygons (it needs a closed mesh)');
        const nr = newNearest(), fall = Math.max(0, p.falloff);
        for (let i = 0; i < n; i++) {
          const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
          if (q.inside(x, y, z)) v[i] = 1;
          else if (fall > 0 && q.nearest(x, y, z, fall, nr)) v[i] = Math.max(0, 1 - nr.dist / fall);
          else v[i] = 0;
        }
        direct = true;
        break;
      }
      case 'noise': {
        const f = fractal(makeNoise('perlin', p.seed), { octaves: p.octaves });
        const fr = p.frequency;
        for (let i = 0; i < n; i++) v[i] = clamp01(0.5 + 0.5 * f(Pd[i * 3] * fr + 0.31, Pd[i * 3 + 1] * fr + 0.17, Pd[i * 3 + 2] * fr + 0.53));
        break;
      }
      case 'attribute': {
        if (!p.source_attrib) throw new NodeError('mask by attribute: set source_attrib (a numeric point attribute)');
        const a = g.points.get(p.source_attrib);
        if (!a || a.type === 'string' || a.isArray) {
          const nums = g.points.names().filter((k) => { const x = g.points.get(k)!; return x.type !== 'string' && !x.isArray && k !== 'P'; });
          throw new NodeError(`mask by attribute: "${p.source_attrib}" is not a numeric point attribute`, `point attributes: ${nums.join(', ') || 'none'}`);
        }
        const d = a.data as Float64Array, s = a.size;
        for (let i = 0; i < n; i++) v[i] = d[i * s];
        break;
      }
      case 'group': {
        const m = mask(g, 'point', p.pattern);
        for (let i = 0; i < n; i++) v[i] = !m || m[i] ? 1 : 0;
        direct = true;
        break;
      }
      default:
        throw new NodeError(`mask: unknown feature "${by}"`);
    }
    const out = g.points.add(name, 'float', 1).data as Float64Array;
    const linear = isIdentityRamp(p.ramp);
    const mode = p.combine as string;
    let sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      if (sel && !sel[i]) { out[i] = prev ? prev[i] : 0; continue; }
      let m = direct ? clamp01(v[i]) : band(v[i], p.min, p.max, p.falloff);
      if (!linear) m = rampValue(p.ramp, m);
      if (p.invert) m = 1 - m;
      out[i] = combineMask(mode, prev ? prev[i] : undefined, m);
      sum += out[i]; cnt++;
    }
    stat('mean', cnt ? sum / cnt : 0);
    return g;
  },
});

// ---------------------------------------------------------------- attribute from map

defineNode({
  type: 'attribute_from_map',
  category: 'pcg',
  packed: 'keep',
  summary: 'Sample a PNG image (8/16-bit grey or RGB(A)) into a point attribute by uv or by a planar projection (xz ground maps, xy/yz walls): density maps, masks, colour.',
  description:
    'Houdini: Attribute from Map; Unreal PCG: Get Texture Data + Sample Texture. projection uv reads the uv attribute (point or vertex; ' +
    'GPU convention: pixel centres at (i + 0.5) / width, v = 0 at the bottom of the image unless flip_v). Planar projections map the ' +
    'image onto a size × size rectangle around center with the first and last pixels on its edges (the layout heightfield_from_image and ' +
    'export png16/mask_png use): xz = top view, column along +X, row 0 at min Z; xy = facing +Z, column along +X, row 0 at max Y; ' +
    'yz = facing +X, column along −Z, row 0 at max Y. channel luminance (Rec. 709), r, g, b, a or rgb (a vector); remap maps black..white ' +
    'to remap[0]..remap[1]. Bilinear or nearest filtering; wrap repeat, clamp or mirror outside the image. class vertex writes per vertex ' +
    '(uv seams stay sharp); point averages a point\'s vertices when uv is a vertex attribute. The file is re-read when it changes.',
  aliases: ['attribfrommap', 'attrib_from_image', 'texture_to_attrib', 'attrib_from_map', 'attribute_from_image', 'texture_sample'],
  inputs: [{ name: 'geo', desc: 'points or mesh' }],
  params: {
    path: { type: 'path', default: '', desc: 'PNG file or URL; a relative path reads from the project folder (nearest project.json), else the graph\'s folder', aliases: ['file', 'filename', 'map', 'texture', 'image'] },
    name: { type: 'string', default: '', desc: 'output attribute ("" = Cd for channel rgb, else mask)', aliases: ['attrib', 'attribute', 'output'] },
    channel: { type: 'enum', options: ['luminance', 'r', 'g', 'b', 'a', 'rgb'], default: 'luminance', desc: 'which channel (rgb writes a vector)' },
    projection: { type: 'enum', options: ['uv', 'xz', 'xy', 'yz'], default: 'uv', desc: 'uv attribute or a planar projection (xz = top view)', aliases: ['mapping'] },
    uv_attrib: { type: 'string', default: 'uv', desc: 'projection uv: the uv attribute (vertex or point)' },
    size: { type: 'vec2', default: [10, 10], desc: 'planar: extent of the image in metres (columns, rows)' },
    center: { type: 'vec3', default: [0, 0, 0], desc: 'planar: centre of the image rectangle', aliases: ['t', 'translate', 'origin'] },
    remap: { type: 'vec2', default: [0, 1], desc: 'output value for black and for white', aliases: ['range'] },
    wrap: { type: 'enum', options: ['clamp', 'repeat', 'mirror'], default: 'clamp', desc: 'outside the image: clamp to the edge, tile, or mirror' },
    filter: { type: 'enum', options: ['bilinear', 'nearest'], default: 'bilinear', desc: 'pixel interpolation', aliases: ['interpolation'] },
    flip_v: { type: 'bool', default: false, desc: 'flip the image vertically' },
    class: { type: 'enum', options: ['point', 'vertex'], default: 'point', desc: 'write a point attribute or a vertex attribute' },
    group: P.group('point', 'points to write ("" = all)'),
  },
  // relative paths read the scope's folder
  signatureExtra: (p, scope) => scope.files.fileStamp(p.path),
  outputs: 'point (or vertex) float <name> (vec3 for channel rgb)',
  example: { type: 'attribute_from_map', in: ['ground_pts'], params: { path: 'density.png', projection: 'xz', size: [100, 100], name: 'density' } },
  async cook({ input, p, scope, type, warn }) {
    if (!p.path) throw new NodeError(`${type}: path is empty`, 'a PNG file relative to the project folder, e.g. "inputs/density.png"');
    const bytes = await scope.files.readFile(p.path).catch((e: any) => { throw new NodeError(`${type}: cannot read "${p.path}": ${e.message}`); });
    let img;
    try { img = decodePNG(bytes); } catch (e: any) { throw new NodeError(`${type}: ${e.message}`); }
    const g = input(0).clone();
    const W = img.width, H = img.height;
    const rgb = p.channel === 'rgb';
    const name = String(p.name || (rgb ? 'Cd' : 'mask'));
    const lo = p.remap[0], hi = p.remap[1];
    const wrap = p.wrap as WrapMode, bil = p.filter !== 'nearest';
    const px = new Float64Array(4);
    // value(s) for image coordinates → into out at o
    const write = (x: number, y: number, out: Float64Array, o: number) => {
      sampleImage(img, x, y, wrap, bil, px);
      if (rgb) { for (let c = 0; c < 3; c++) out[o + c] = lo + (hi - lo) * px[c]; return; }
      const s = p.channel === 'r' ? px[0] : p.channel === 'g' ? px[1] : p.channel === 'b' ? px[2] : p.channel === 'a' ? px[3] : 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
      out[o] = lo + (hi - lo) * s;
    };
    const size = rgb ? 3 : 1;
    const cls = p.class as 'point' | 'vertex';
    const count = cls === 'vertex' ? g.numVertices : g.numPoints;
    const sel = mask(g, 'point', p.group);
    const vals = new Float64Array(count * size);
    const done = new Uint8Array(count);
    // image coordinates of a position (planar) or a uv
    const sx = p.size[0] || 1, sy = p.size[1] || 1, c = p.center;
    const planar = (X: number, Y: number, Z: number): [number, number] => {
      let fu: number, fv: number;
      if (p.projection === 'xz') { fu = (X - (c[0] - sx / 2)) / sx; fv = (Z - (c[2] - sy / 2)) / sy; }
      else if (p.projection === 'xy') { fu = (X - (c[0] - sx / 2)) / sx; fv = (c[1] + sy / 2 - Y) / sy; }
      else { fu = (c[2] + sx / 2 - Z) / sx; fv = (c[1] + sy / 2 - Y) / sy; }
      if (p.flip_v) fv = 1 - fv;
      return [fu * (W - 1), fv * (H - 1)];
    };
    const fromUV = (u: number, v: number): [number, number] => [u * W - 0.5, (p.flip_v ? v : 1 - v) * H - 0.5];
    const Pd = g.P;
    if (p.projection === 'uv') {
      const uvA = g.findAttrib(p.uv_attrib, ['vertex', 'point']);
      if (!uvA || uvA.attr.type !== 'float' || uvA.attr.isArray || uvA.attr.size < 2) {
        throw new NodeError(`${type}: no uv attribute "${p.uv_attrib}" (vertex or point, 2 or 3 floats)`, 'make one with uv_project / uv_unwrap, or use projection "xz" for ground maps');
      }
      const ua = uvA.attr, ud = ua.data as Float64Array, us = ua.size;
      if (uvA.cls === 'point') {
        for (let e = 0; e < count; e++) {
          const pt = cls === 'vertex' ? g.vertexPoint[e] : e;
          if (sel && !sel[pt]) continue;
          const [x, y] = fromUV(ud[pt * us], ud[pt * us + 1]);
          write(x, y, vals, e * size); done[e] = 1;
        }
      } else if (cls === 'vertex') {
        for (let e = 0; e < count; e++) {
          if (sel && !sel[g.vertexPoint[e]]) continue;
          const [x, y] = fromUV(ud[e * us], ud[e * us + 1]);
          write(x, y, vals, e * size); done[e] = 1;
        }
      } else {
        // point values from vertex uvs: average over the point's vertices
        const acc = new Float64Array(g.numPoints * size), n = new Int32Array(g.numPoints), tmp = new Float64Array(size);
        for (let v = 0; v < g.numVertices; v++) {
          const pt = g.vertexPoint[v];
          if (sel && !sel[pt]) continue;
          const [x, y] = fromUV(ud[v * us], ud[v * us + 1]);
          write(x, y, tmp, 0);
          for (let k = 0; k < size; k++) acc[pt * size + k] += tmp[k];
          n[pt]++;
        }
        let loose = 0;
        for (let pt = 0; pt < g.numPoints; pt++) {
          if (!n[pt]) { if (!sel || sel[pt]) loose++; continue; }
          for (let k = 0; k < size; k++) vals[pt * size + k] = acc[pt * size + k] / n[pt];
          done[pt] = 1;
        }
        if (loose) warn(`${loose} point(s) have no vertices to read the vertex uv from: left at the default`);
      }
    } else {
      for (let e = 0; e < count; e++) {
        const pt = cls === 'vertex' ? g.vertexPoint[e] : e;
        if (sel && !sel[pt]) continue;
        const [x, y] = planar(Pd[pt * 3], Pd[pt * 3 + 1], Pd[pt * 3 + 2]);
        write(x, y, vals, e * size); done[e] = 1;
      }
    }
    const a = g.table(cls).add(name, 'float', size);
    const d = a.data as Float64Array;
    for (let e = 0; e < count; e++) if (done[e]) for (let k = 0; k < size; k++) d[e * size + k] = vals[e * size + k];
    if (name === 'Cd' && cls === 'point') { g.vertices.delete('Cd'); g.prims.delete('Cd'); }
    return g;
  },
});

// ---------------------------------------------------------------- orient

const ORIENT_MODES = ['normal_up', 'surface', 'curve_tangent', 'direction', 'random', 'look_at'];

/**
 * Unit tangent of a polyline (pts; a closed curve repeats its first point at the end) at fraction f of segment k: the
 * segment direction, or at a vertex the mean of the two segments that meet there (the tangent at a curve point).
 */
function curveTangent(pts: number[][], closed: boolean, k: number, f: number): Vec3 {
  const nseg = pts.length - 1;
  const seg = (s: number) => unit([pts[s + 1][0] - pts[s][0], pts[s + 1][1] - pts[s][1], pts[s + 1][2] - pts[s][2]]);
  const t = seg(k);
  let other = -1;
  if (f <= 1e-9) other = k > 0 ? k - 1 : closed ? nseg - 1 : -1;
  else if (f >= 1 - 1e-9) other = k < nseg - 1 ? k + 1 : closed ? 0 : -1;
  if (other < 0) return t;
  const o = seg(other), m = unit([t[0] + o[0], t[1] + o[1], t[2] + o[2]]);
  return m[0] || m[1] || m[2] ? m : t;
}

/** Closest point on the curves of a geometry, with the curve tangent and a rotation-minimising up there. */
class CurveFrames {
  tree: SegmentTree;
  /** per prim: vertex positions (closed curves repeat the first) and their RMF up vectors */
  curves: { pts: number[][]; Y: Vec3[]; closed: boolean }[] = [];
  nr = newNearest();

  constructor(g: Geometry, up: Vec3) {
    const pos: number[] = [], prims: number[][] = [];
    const P = g.P;
    for (let pr = 0; pr < g.numPrims; pr++) {
      const ids = g.primPoints(pr);
      const closed = !!g.primClosed[pr] && ids.length > 2;
      const pts = ids.map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
      const Y = pts.length >= 2 ? rmFrames(pts, closed, up).Y : pts.map(() => [0, 1, 0] as Vec3);
      if (closed) { pts.push(pts[0]); Y.push(Y[0]); }
      this.curves.push({ pts, Y, closed });
      const base = pos.length / 3;
      for (const q of pts) pos.push(q[0], q[1], q[2]);
      prims.push(pts.map((_, k) => base + k));
    }
    this.tree = new SegmentTree(new Geometry({ positions: pos, prims, closed: false }));
  }

  get empty() { return this.tree.numSegments === 0; }

  /** Tangent T and up Y at the closest curve point; false when there are no curves. */
  at(x: number, y: number, z: number, T: number[], Y: number[]): boolean {
    if (!this.tree.closest(x, y, z, Infinity, this.nr)) return false;
    const c = this.curves[this.nr.prim], nseg = c.pts.length - 1;
    let k = Math.floor(this.nr.u * nseg);
    if (k >= nseg) k = nseg - 1;
    if (k < 0) k = 0;
    const f = Math.min(1, Math.max(0, this.nr.u * nseg - k));
    const t = curveTangent(c.pts, c.closed, k, f);
    T[0] = t[0]; T[1] = t[1]; T[2] = t[2];
    const ya = c.Y[k], yb = c.Y[k + 1];
    const yl = perpTo([ya[0] + (yb[0] - ya[0]) * f, ya[1] + (yb[1] - ya[1]) * f, ya[2] + (yb[2] - ya[2]) * f], t) ?? perpTo([0, 1, 0], t) ?? perpTo([1, 0, 0], t)!;
    Y[0] = yl[0]; Y[1] = yl[1]; Y[2] = yl[2];
    return true;
  }
}

defineNode({
  type: 'orient',
  category: 'pcg',
  packed: 'keep',
  summary: 'Orient points for instancing: write orient (quaternion), N and up from the point normal + up, a surface (input 1), the nearest curve tangent (RMF), a fixed direction, a look-at target or random rotations; plus random yaw, tilt and scale ranges.',
  description:
    'Houdini: Attribute Randomize (orient, pscale) + Orient Along Curve + Scatter and Align; Unreal PCG: Transform Points (rotation and ' +
    'scale ranges). Frame convention as copy_to_points: +Z = N, +Y = up. mode gives the main direction: normal_up = the point N (and ' +
    'the point up, else the up param); surface = the normal of input 1 (or of the input\'s own polygons) at the closest point (snap ' +
    'moves the points onto it); curve_tangent = the tangent of the closest curve of input 1 (or of the input\'s own curves) with a ' +
    'rotation-minimising up; direction = the direction param; look_at = towards target; random = a random rotation of up to max_angle ' +
    'about axis ([0,0,0] = any axis) applied to the normal_up frame. align_axis z (default) puts the main direction on +Z (N) and makes ' +
    'the up param perpendicular for +Y; align_axis y puts it on +Y (upright models such as trees, rocks or posts follow the surface) and ' +
    'takes +Z from the direction param (the up param in direction mode). upright keeps +Y on the up param and only turns the heading ' +
    '(posts along a sloped road). Then random_yaw turns about the instance\'s +Y and tilt leans ' +
    'it by an angle in the range towards a random side (degrees). Scale: scale_min..scale_max, random per point or picked by scale_attrib ' +
    '(0..1, e.g. a mask): uniform → pscale, per axis → scale. Points outside group keep their attributes.',
  aliases: ['pcg_orient', 'align', 'orient_points', 'transform_points'],
  inputs: [
    { name: 'points', desc: 'points to orient' },
    { name: 'reference', desc: 'surface (mode surface) or curves (mode curve_tangent)', optional: true },
  ],
  params: {
    mode: { type: 'enum', options: ORIENT_MODES, default: 'normal_up', desc: 'where the main direction comes from' },
    align_axis: { type: 'enum', options: ['z', 'y'], default: 'z', desc: 'instance axis that follows the main direction: z = N (Houdini copy), y = up (upright models)', aliases: ['axis_mode', 'align_to'] },
    up: { type: 'vec3', default: [0, 1, 0], desc: 'reference up (+Y) when the main direction drives +Z', aliases: ['up_vector'] },
    direction: { type: 'vec3', default: [0, 0, 1], desc: 'mode direction: the main direction; align_axis y: the reference for +Z', aliases: ['dir', 'heading'] },
    target: { type: 'vec3', default: [0, 0, 0], desc: 'look_at: the point instances face', aliases: ['look_at_point'] },
    axis: { type: 'vec3', default: [0, 1, 0], desc: 'random: rotation axis ([0,0,0] = a random axis per point)' },
    max_angle: { type: 'float', default: 180, min: 0, max: 180, desc: 'random: largest rotation in degrees (either way)' },
    random_yaw: { type: 'vec2', default: [0, 0], desc: 'random turn about the instance up axis, degrees [min, max] (e.g. [0, 360])', aliases: ['yaw', 'random_heading', 'rotation_range'] },
    tilt: { type: 'vec2', default: [0, 0], desc: 'random lean away from up, degrees [min, max], towards a random side', aliases: ['random_tilt', 'lean'] },
    scale_min: { type: 'vec3', default: [1, 1, 1], desc: 'smallest scale (a number for all axes)', aliases: ['min_scale'] },
    scale_max: { type: 'vec3', default: [1, 1, 1], desc: 'largest scale', aliases: ['max_scale'] },
    uniform_scale: { type: 'bool', default: true, desc: 'one random factor (x component of the range) → pscale; off: per-axis factors → scale' },
    scale_attrib: { type: 'string', default: '', desc: 'point attribute 0..1 picking the scale between min and max instead of a random value (a scale ramp by mask)' },
    upright: { type: 'bool', default: false, desc: 'keep +Y on the up param: only the heading (+Z projected onto the horizontal plane) follows the mode (lamp posts on a sloped road, buildings)', aliases: ['keep_upright', 'yaw_only'] },
    snap: { type: 'bool', default: false, desc: 'surface: move the points onto the surface' },
    write: { type: 'enum', options: ['both', 'orient', 'n_up'], default: 'both', desc: 'attributes to write: orient + N + up, only orient, or only N + up' },
    seed: P.seed(),
    group: P.group('point', 'points to orient ("" = all)'),
  },
  outputs: 'point orient (quaternion), N, up; pscale or scale when a scale range is set',
  example: {
    nodes: {
      ground: { type: 'grid', params: { size: [20, 20] } },
      pts: { type: 'scatter', in: ['ground'], params: { count: 200 } },
      o: { type: 'orient', in: ['pts'], params: { mode: 'direction', align_axis: 'z', random_yaw: [0, 360], tilt: [0, 8], scale_min: 0.7, scale_max: 1.3 } },
    },
    output: 'o',
  },
  cook: ({ input, hasInput, p, warn }) => {
    const src = input(0);
    const g = src.clone();
    const n = g.numPoints, Pd = g.P;
    const sel = mask(g, 'point', p.group);
    const ref = hasInput(1) ? input(1) : null;
    const mode = p.mode as string, alignY = p.align_axis === 'y';
    const upP = unit(p.up), dirP = unit(p.direction);
    if (!(upP[0] || upP[1] || upP[2])) throw new NodeError('orient: up is the zero vector');
    const Nattr = floatPoint(g, 'N', 3), upAttr = floatPoint(g, 'up', 3);
    let ownN: Float64Array | null = null;
    if (mode === 'normal_up' || mode === 'random') ownN = Nattr ?? (hasPolygons(g) ? getPointNormals(g) : null);
    let surf: SurfaceNormals | null = null, curves: CurveFrames | null = null;
    if (mode === 'surface') {
      const s = ref && hasPolygons(ref) ? ref : hasPolygons(g) ? g : null;
      if (!s) throw new NodeError('orient surface: connect the surface (polygons) as the second input', '"in": ["points", "terrain"]');
      surf = new SurfaceNormals(s);
    } else if (mode === 'curve_tangent') {
      const hasCurves = (x: Geometry) => { for (let k = 0; k < x.numPrims; k++) if (x.primSize(k) >= 2 && !(x.primKind && x.primKind[k] === 1)) return true; return false; };
      // Bezier/NURBS curves give their evaluated tangents
      const s = ref && hasCurves(ref) ? evaluateSplines(ref) : hasCurves(g) ? evaluateSplines(g) : null;
      if (!s) throw new NodeError('orient curve_tangent: connect the curves as the second input', '"in": ["points", "road"]');
      curves = new CurveFrames(s, upP);
    } else if (mode === 'direction' && !(dirP[0] || dirP[1] || dirP[2])) throw new NodeError('orient: direction is the zero vector');
    if (mode === 'normal_up' && !ownN && n) warn('points have no N (and no polygons): N defaults to the direction param');
    const scA = p.scale_attrib ? g.points.get(p.scale_attrib) : null;
    if (p.scale_attrib && (!scA || scA.type === 'string' || scA.isArray)) throw new NodeError(`orient: scale_attrib "${p.scale_attrib}" is not a numeric point attribute`);
    const smin = p.scale_min as number[], smax = p.scale_max as number[];
    const doScale = !!scA || smin.some((x: number) => x !== 1) || smax.some((x: number) => x !== 1);
    const doYaw = p.random_yaw[0] !== 0 || p.random_yaw[1] !== 0, doTilt = p.tilt[0] !== 0 || p.tilt[1] !== 0;
    const writeQ = p.write !== 'n_up', writeNU = p.write !== 'orient';
    const hadOrient = g.points.has('orient');
    const oA = writeQ ? (g.points.add('orient', 'float', 4).data as Float64Array) : null;
    const NA = writeNU ? (g.points.add('N', 'float', 3).data as Float64Array) : null;
    const UA = writeNU ? (g.points.add('up', 'float', 3).data as Float64Array) : null;
    const psA = doScale && p.uniform_scale ? (g.points.add('pscale', 'float', 1).data as Float64Array) : null;
    const scV = doScale && !p.uniform_scale ? (g.points.add('scale', 'float', 3).data as Float64Array) : null;
    const prim = [0, 0, 1], sec = [0, 1, 0], T = [0, 0, 0], Y = [0, 1, 0];
    for (let i = 0; i < n; i++) {
      const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
      if (sel && !sel[i]) {
        // unselected points: a new orient attribute must not override the frame copy_to_points would use
        if (oA && !hadOrient) {
          const q = frameQuat(Nattr ? [Nattr[i * 3], Nattr[i * 3 + 1], Nattr[i * 3 + 2]] : [0, 0, 1], upAttr ? [upAttr[i * 3], upAttr[i * 3 + 1], upAttr[i * 3 + 2]] : [0, 1, 0]);
          oA.set(q, i * 4);
        }
        continue;
      }
      const r = rng(p.seed * 7919 + i * 31 + 3);
      const ry = r(), rt = r(), rd = r(), ra = r(), rx1 = r(), rx2 = r();
      // main direction and the reference for the other axis
      let main: number[] = dirP, ref2: number[] = upP;
      switch (mode) {
        case 'normal_up': case 'random':
          main = ownN ? [ownN[i * 3], ownN[i * 3 + 1], ownN[i * 3 + 2]] : dirP;
          ref2 = upAttr ? [upAttr[i * 3], upAttr[i * 3 + 1], upAttr[i * 3 + 2]] : upP;
          break;
        case 'surface':
          if (surf!.at(x, y, z, prim)) {
            main = prim.slice();
            if (p.snap) { Pd[i * 3] = surf!.tp.x; Pd[i * 3 + 1] = surf!.tp.y; Pd[i * 3 + 2] = surf!.tp.z; }
          }
          break;
        case 'curve_tangent':
          if (curves!.at(x, y, z, T, Y)) { main = T.slice(); ref2 = Y.slice(); }
          break;
        case 'look_at': {
          const d = [p.target[0] - x, p.target[1] - y, p.target[2] - z];
          main = Math.hypot(d[0], d[1], d[2]) > 1e-12 ? d : dirP;
          break;
        }
      }
      let N: number[], U: number[];
      if (!alignY) { N = main; U = ref2; }
      else {
        U = main;
        // +Z reference: the direction param (curve_tangent: the curve's up; direction mode: the up param)
        const zr = mode === 'curve_tangent' ? ref2 : mode === 'direction' ? upP : dirP;
        const u = unit(U);
        N = perpTo(zr, u) ?? perpTo([0, 0, 1], u) ?? perpTo([1, 0, 0], u)!;
      }
      if (p.upright) {
        N = perpTo(unit(N), upP) ?? perpTo(dirP, upP) ?? perpTo([0, 0, 1], upP) ?? perpTo([1, 0, 0], upP)!;
        U = upP;
      }
      let q: Quat = frameQuat(N, U);
      if (mode === 'random') {
        let ax = unit(p.axis);
        if (!(ax[0] || ax[1] || ax[2])) {
          const zz = rx1 * 2 - 1, t = rx2 * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - zz * zz));
          ax = [s * Math.cos(t), zz, s * Math.sin(t)];
        }
        q = qNormalize(qMul(qAxisAngle(ax, (ra * 2 - 1) * p.max_angle), q));
      }
      if (doYaw) q = qMul(q, qAxisAngle([0, 1, 0], p.random_yaw[0] + (p.random_yaw[1] - p.random_yaw[0]) * ry));
      if (doTilt) {
        const phi = rd * Math.PI * 2;
        q = qMul(q, qAxisAngle([Math.cos(phi), 0, Math.sin(phi)], p.tilt[0] + (p.tilt[1] - p.tilt[0]) * rt));
      }
      q = qNormalize(q);
      if (oA) oA.set(q, i * 4);
      if (NA) NA.set(qRotate(q, [0, 0, 1]), i * 3);
      if (UA) UA.set(qRotate(q, [0, 1, 0]), i * 3);
      if (doScale) {
        const t0 = scA ? clamp01((scA.data as Float64Array)[i * scA.size]) : r();
        if (psA) psA[i] = smin[0] + (smax[0] - smin[0]) * t0;
        else if (scV) for (let c = 0; c < 3; c++) {
          const t = scA ? t0 : c === 0 ? t0 : r();
          scV[i * 3 + c] = smin[c] + (smax[c] - smin[c]) * t;
        }
      }
    }
    return g;
  },
});

// ---------------------------------------------------------------- points along curves

defineNode({
  type: 'points_along_curve',
  category: 'pcg',
  summary: 'Points along curves at a spacing (metres, with start/end offsets), a count, per segment or at the curve points; writes curveu, tangent, N, up (rotation-minimising), orient and curve_id. Lamp posts, fence posts, road markings.',
  description:
    'Houdini: Resample (+ Orient Along Curve) to points; Unreal PCG: Spline Sampler (distance / subdivision modes). mode distance: ' +
    'points every `spacing` metres of arc length from start_offset to the curve length − end_offset (count > 0 instead spreads ' +
    'exactly count points evenly over that range); subdivision: per_segment points on every segment (the vertices and evenly between ' +
    'them); at_points: one point per curve vertex. jitter moves points randomly by up to ±jitter metres along the curve. side_offset ' +
    'shifts them sideways (positive = right of the direction of travel, T × up), both_sides adds the mirrored point on the left (side ' +
    '= -1). Attributes: curveu (0..1 of the arc length), tangent = N (unit, along the curve), up (rotation-minimising frame starting from ' +
    'the up param), orient (+Z along the curve), curve_id (source prim); source point attributes are interpolated and prim attributes ' +
    'copied. Closed curves (polygons) are walked as loops.',
  aliases: ['pcg_spline_sampler', 'curve_points', 'spline_sampler', 'points_along_spline', 'sample_curve'],
  inputs: [{ name: 'curves', desc: 'polylines or polygons (outlines); Bezier/NURBS curves are sampled adaptively' }],
  splines: 'keep',
  params: {
    mode: { type: 'enum', options: ['distance', 'subdivision', 'at_points'], default: 'distance', desc: 'distance = by spacing (or count); subdivision = per segment; at_points = the curve vertices' },
    spacing: { type: 'float', default: 1, min: 1e-4, desc: 'distance: metres of arc length between points', aliases: ['step', 'length', 'seglen', 'distance'] },
    count: { type: 'int', default: 0, min: 0, max: 5000000, desc: 'distance: exactly this many points per curve, evenly spread (0 = use spacing)', aliases: ['npts', 'points'] },
    per_segment: { type: 'int', default: 1, min: 1, max: 10000, desc: 'subdivision: points per segment', aliases: ['segments', 'subdivisions'] },
    start_offset: { type: 'float', default: 0, min: 0, desc: 'skip this many metres at the start', aliases: ['start'] },
    end_offset: { type: 'float', default: 0, min: 0, desc: 'skip this many metres at the end', aliases: ['end'] },
    jitter: { type: 'float', default: 0, min: 0, desc: 'random move along the curve, metres (±)' },
    side_offset: { type: 'float', default: 0, desc: 'sideways offset in metres (positive = right of the direction of travel)', aliases: ['offset', 'lateral_offset'] },
    both_sides: { type: 'bool', default: false, desc: 'also place the mirrored point on the other side (side_offset ≠ 0)' },
    up: { type: 'vec3', default: [0, 1, 0], desc: 'up vector the rotation-minimising frame starts from', aliases: ['up_vector'] },
    seed: P.seed(),
    group: P.group('prim', 'curves to sample ("" = all)'),
  },
  outputs: 'points: curveu, tangent, N, up, orient, curve_id (side with a side offset); source point/prim attributes',
  example: {
    nodes: {
      road: { type: 'curve', params: { points: [[-20, 0, -5], [0, 0, 5], [20, 0, 0]], smooth: true } },
      lamps: { type: 'points_along_curve', in: ['road'], params: { spacing: 8, start_offset: 2, side_offset: 4, both_sides: true } },
    },
    output: 'lamps',
  },
  cook: ({ input, p, warn }) => {
    const g = evaluateSplines(input(0));
    const sel = mask(g, 'prim', p.group);
    const b = new GeoBuilder(g);
    b.keepSrcGroups = true;
    for (const n of g.vertices.names()) b.skip.vertex.add(n);
    for (const n of g.prims.names()) b.skip.prim.add(n);
    const cu = b.attrib('point', 'curveu', 1), tg = b.attrib('point', 'tangent', 3), Na = b.attrib('point', 'N', 3);
    const ua = b.attrib('point', 'up', 3), oa = b.attrib('point', 'orient', 4), ci = b.attrib('point', 'curve_id', 1, 'int');
    const side = p.side_offset !== 0 ? b.attrib('point', 'side', 1, 'int') : null;
    const primCopies = g.prims.names().filter((k) => !g.points.has(k) && !['curveu', 'tangent', 'N', 'up', 'orient', 'curve_id', 'side', 'P'].includes(k))
      .map((k) => { const a = g.prims.get(k)!; return { a, out: b.attrib('point', k, a.size, a.type, a.def) }; });
    const up = unit(p.up);
    if (!(up[0] || up[1] || up[2])) throw new NodeError('points_along_curve: up is the zero vector');
    const r = rng(p.seed + 0.125);
    const Pd = g.P;
    let made = 0, skipped = 0;
    for (let pr = 0; pr < g.numPrims; pr++) {
      if ((sel && !sel[pr]) || (g.primKind && g.primKind[pr] === 1)) continue;
      const ids = g.primPoints(pr);
      if (ids.length < 2) continue;
      const closed = !!g.primClosed[pr] && ids.length > 2;
      const pts = ids.map((i) => [Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2]]);
      const Yv = rmFrames(pts, closed, up).Y;
      const src = ids.slice();
      if (closed) { pts.push(pts[0]); Yv.push(Yv[0]); src.push(ids[0]); }
      const nseg = pts.length - 1;
      const L = new Float64Array(pts.length);
      for (let k = 1; k < pts.length; k++) L[k] = L[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1], pts[k][2] - pts[k - 1][2]);
      const total = L[nseg];
      if (!(total > 0)) { skipped++; continue; }
      const a = Math.min(p.start_offset, total), e = Math.max(a, total - p.end_offset);
      let S: number[] = [];
      if (p.mode === 'distance') {
        if (p.count > 0) {
          const c = p.count;
          // closed loops without offsets: the last point would repeat the first
          const span = closed && p.start_offset === 0 && p.end_offset === 0 ? total : e - a;
          const div = closed && p.start_offset === 0 && p.end_offset === 0 ? c : Math.max(1, c - 1);
          for (let k = 0; k < c; k++) S.push(c === 1 && !(closed && span === total) ? (a + e) / 2 : a + (span * k) / div);
        } else {
          const step = Math.max(1e-4, p.spacing);
          const lim = closed && p.end_offset === 0 ? e - step * 1e-6 : e + step * 1e-9;
          const max = Math.ceil((e - a) / step) + 2;
          if (max > 5e6) throw new NodeError(`points_along_curve: ${max.toLocaleString('en-US')} points on one curve is too many; raise spacing`);
          for (let k = 0; a + k * step <= lim && k < max; k++) S.push(a + k * step);
        }
      } else if (p.mode === 'subdivision') {
        const m = Math.max(1, Math.floor(p.per_segment));
        for (let k = 0; k < nseg; k++) for (let j = 0; j < m; j++) S.push(L[k] + ((L[k + 1] - L[k]) * j) / m);
        if (!closed) S.push(total);
        S = S.filter((s) => s >= a - 1e-12 && s <= e + 1e-12);
      } else {
        for (let k = 0; k < (closed ? nseg : nseg + 1); k++) S.push(L[k]);
        S = S.filter((s) => s >= a - 1e-12 && s <= e + 1e-12);
      }
      if (p.jitter > 0 && S.length) {
        S = S.map((s) => Math.min(e, Math.max(a, s + (r() * 2 - 1) * p.jitter)));
        S.sort((x, y) => x - y);
      }
      let k = 0;
      for (const s of S) {
        while (k < nseg - 1 && L[k + 1] < s) k++;
        const segL = L[k + 1] - L[k], f = segL > 0 ? Math.min(1, Math.max(0, (s - L[k]) / segL)) : 0;
        const A = pts[k], B = pts[k + 1];
        const T = curveTangent(pts, closed, k, f);
        const yi = [Yv[k][0] + (Yv[k + 1][0] - Yv[k][0]) * f, Yv[k][1] + (Yv[k + 1][1] - Yv[k][1]) * f, Yv[k][2] + (Yv[k + 1][2] - Yv[k][2]) * f];
        const U = perpTo(yi, T) ?? perpTo(up, T) ?? perpTo([1, 0, 0], T)!;
        const q = frameQuat(T, U);
        const base = [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f];
        // right of travel: T × up
        const R = [T[1] * U[2] - T[2] * U[1], T[2] * U[0] - T[0] * U[2], T[0] * U[1] - T[1] * U[0]];
        const sides = p.side_offset !== 0 ? (p.both_sides ? [1, -1] : [1]) : [0];
        for (const sd of sides) {
          const o = sd * p.side_offset;
          const id = b.addPoint(base[0] + R[0] * o, base[1] + R[1] * o, base[2] + R[2] * o, { i: [src[k], src[k + 1]], w: [1 - f, f] });
          cu.set(id, s / total); tg.set(id, T); Na.set(id, T); ua.set(id, U); oa.set(id, q); ci.set(id, pr);
          if (side) side.set(id, sd);
          for (const c of primCopies) c.out.set(id, c.a.isArray ? c.a.getArray(pr) : c.a.get(pr));
          made++;
        }
      }
    }
    if (skipped) warn(`${skipped} curve(s) of zero length skipped`);
    if (!made && g.numPrims) warn('no points: check spacing and the start/end offsets against the curve lengths');
    const out = b.build();
    for (const n of out.vertices.names()) out.vertices.delete(n);
    for (const n of out.prims.names()) out.prims.delete(n);
    return out;
  },
});

// ---------------------------------------------------------------- cluster

/** Hue from a cluster id (golden-ratio steps), as an RGB colour with saturation 0.65, value 0.95. */
function clusterColor(c: number): [number, number, number] {
  const h = (((c * 0.618033988749895 + 0.13) % 1) + 1) % 1, s = 0.65, v = 0.95;
  const i = Math.floor(h * 6), f = h * 6 - i, pp = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, pp];
    case 1: return [q, v, pp];
    case 2: return [pp, v, t];
    case 3: return [pp, q, v];
    case 4: return [t, pp, v];
    default: return [v, pp, q];
  }
}

defineNode({
  type: 'cluster',
  category: 'pcg',
  packed: 'keep',
  summary: 'Cluster points: k-means (count clusters) or by radius; writes an int cluster id (optionally the cluster centre and a debug colour). Piece assignment, grouping scattered objects, LOD cells.',
  description:
    'Houdini: Cluster Points SOP (k-means, attribute "cluster"); Unreal PCG: no direct node (use cluster ids with Attribute Partition). ' +
    'kmeans: seeded k-means++ start, then Lloyd iterations (stops when nothing changes); radius: leader clustering, points visited in a ' +
    'seeded random order take every unassigned point within radius, so each cluster fits in a ball of that radius. Cluster ids are ' +
    'numbered in point order (cluster 0 holds the first point). center writes cluster_center (the centroid of the cluster); color ' +
    'writes Cd per cluster for a debug render. Points outside group get cluster -1. Packed instances are clustered by their anchors.',
  aliases: ['pcg_cluster', 'kmeans', 'clusterpoints', 'cluster_points'],
  inputs: [{ name: 'points', desc: 'points (or any geometry: its points are clustered)' }],
  params: {
    method: { type: 'enum', options: ['kmeans', 'radius'], default: 'kmeans', desc: 'k-means with count clusters, or radius clusters', aliases: ['mode'] },
    count: { type: 'int', default: 8, min: 1, max: 100000, desc: 'kmeans: number of clusters', aliases: ['clusters', 'k', 'num_clusters'] },
    iterations: { type: 'int', default: 10, min: 1, max: 1000, desc: 'kmeans: Lloyd iterations at most', aliases: ['iter'] },
    radius: { type: 'float', default: 1, min: 0, desc: 'radius: cluster radius in metres' },
    seed: P.seed(),
    name: { type: 'string', default: 'cluster', desc: 'output point int attribute', aliases: ['attrib', 'output'] },
    center: { type: 'bool', default: false, desc: 'also write cluster_center (vec3)', aliases: ['write_center', 'cluster_center'] },
    color: { type: 'bool', default: false, desc: 'also write Cd per cluster (debug view)', aliases: ['colorize', 'visualize'] },
    group: P.group('point', 'points to cluster ("" = all); the others get -1'),
  },
  outputs: 'point int cluster (or <name>); optional cluster_center, Cd',
  example: { nodes: { g: { type: 'grid', params: { size: [20, 20] } }, s: { type: 'scatter', in: ['g'], params: { count: 400 } }, c: { type: 'cluster', in: ['s'], params: { count: 6, color: true } } }, output: 'c' },
  cook: ({ input, p, stat }) => {
    const g = input(0).clone();
    const n = g.numPoints;
    const sel = mask(g, 'point', p.group);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (!sel || sel[i]) idx.push(i);
    const res: Clusters = p.method === 'radius' ? radiusClusters(g.P, idx, Math.max(0, p.radius), p.seed) : kmeans(g.P, idx, p.count, p.iterations, p.seed);
    const L = g.points.add(String(p.name || 'cluster'), 'int', 1).data as Int32Array;
    L.fill(-1);
    idx.forEach((i, a) => { L[i] = res.label[a]; });
    if (p.center) {
      const C = g.points.add('cluster_center', 'float', 3).data as Float64Array;
      idx.forEach((i, a) => C.set(res.centers.subarray(res.label[a] * 3, res.label[a] * 3 + 3), i * 3));
    }
    if (p.color) {
      const cd = g.points.add('Cd', 'float', 3).data as Float64Array;
      idx.forEach((i, a) => cd.set(clusterColor(res.label[a]), i * 3));
      g.vertices.delete('Cd'); g.prims.delete('Cd');
    }
    stat('clusters', res.k);
    return g;
  },
});

// ---------------------------------------------------------------- prune

/** Group-pattern expression with spaces around comparison operators removed ("@mask < 0.5" → "@mask<0.5"). */
const tightExpr = (s: string) => String(s ?? '').replace(/\s*(==|!=|>=|<=|=|>|<)\s*/g, '$1').trim();

defineNode({
  type: 'prune',
  category: 'pcg',
  packed: 'keep',
  summary: 'Remove points: overlapping spheres (pscale × radius; largest or random wins), a random fraction by a mask (density filter), an attribute expression (@mask<0.5), or points near / inside other geometry (input 1).',
  description:
    'Unreal PCG: Self Pruning (overlap), Density Filter (density), Attribute Filter (expression), Difference / Bounds Modifier ' +
    '(near_geometry); Houdini: Delete by expression, Fuse/Scatter relax. overlap: each point is a sphere of radius × pscale (radius ' +
    'alone without use_pscale or pscale); spheres are kept in priority order (largest first, smallest first, random, point order, or ' +
    'by priority_attrib, highest first) and any sphere overlapping a kept one is removed, so no two kept spheres overlap (exact). ' +
    'density: keep each point with probability attrib × fraction (seeded; a missing attrib counts as 1). expression: remove points ' +
    'matching a point group pattern (@mask<0.5, "@P.y>3 @height<0.2" = either, "!top"). near_geometry: remove points within distance ' +
    'of input 1 (mesh surface, curves or points) and, with inside, points inside its closed polygons (e.g. buildings, roads). ' +
    'invert keeps what would be removed. Points outside group are kept and do not take part. Removing a point removes the prims using ' +
    'it; packed instances go with their anchor points.',
  aliases: ['pcg_prune', 'self_prune', 'bounds_prune', 'density_filter', 'self_pruning', 'point_filter'],
  inputs: [
    { name: 'points', desc: 'points to prune' },
    { name: 'blocker', desc: 'near_geometry: the geometry points must keep away from', optional: true },
  ],
  params: {
    mode: { type: 'enum', options: ['overlap', 'density', 'expression', 'near_geometry'], default: 'overlap', desc: 'how to choose the points to remove' },
    radius: { type: 'float', default: 0.5, min: 0, desc: 'overlap: sphere radius in metres (times pscale)', aliases: ['rad', 'bounds_radius'] },
    use_pscale: { type: 'bool', default: true, desc: 'overlap: multiply radius by the point pscale' },
    priority: { type: 'enum', options: ['largest', 'smallest', 'random', 'order', 'attribute'], default: 'largest', desc: 'overlap: which sphere wins (ties are broken randomly)' },
    priority_attrib: { type: 'string', default: '', desc: 'overlap, priority attribute: point attribute, highest value wins' },
    attrib: { type: 'string', default: 'mask', desc: 'density: keep probability attribute (0..1)', aliases: ['density_attrib', 'mask_attrib'] },
    fraction: { type: 'float', default: 1, min: 0, desc: 'density: multiplies the keep probability (0.3 = keep about 30% where the mask is 1)', aliases: ['keep_fraction', 'ratio'] },
    expression: { type: 'string', default: '@mask<0.5', desc: 'expression: point group pattern of the points to remove', aliases: ['expr', 'filter'] },
    distance: { type: 'float', default: 1, min: 0, desc: 'near_geometry: remove points closer than this to input 1 (metres)', aliases: ['dist', 'clearance'] },
    inside: { type: 'bool', default: true, desc: 'near_geometry: also remove points inside input 1\'s closed polygons' },
    invert: { type: 'bool', default: false, desc: 'keep the points that would be removed instead' },
    seed: P.seed(),
    group: P.group('point', 'points to test ("" = all); the others are kept'),
  },
  outputs: 'the kept points (and the prims whose points all survive)',
  example: { nodes: { g: { type: 'grid', params: { size: [10, 10] } }, s: { type: 'scatter', in: ['g'], params: { count: 300, relax: false } }, o: { type: 'orient', in: ['s'], params: { scale_min: 0.5, scale_max: 1.5 } }, p: { type: 'prune', in: ['o'], params: { mode: 'overlap', radius: 0.3 } } }, output: 'p' },
  cook: ({ input, hasInput, p, stat }) => {
    const g = input(0);
    const n = g.numPoints, Pd = g.P;
    const sel = mask(g, 'point', p.group);
    const test: number[] = [];
    for (let i = 0; i < n; i++) if (!sel || sel[i]) test.push(i);
    const remove = new Uint8Array(n);
    const hashR = (i: number) => elementSeed(p.seed, i) / 2147483648;
    switch (p.mode) {
      case 'overlap': {
        const ps = p.use_pscale ? floatPoint(g, 'pscale', 1) : null;
        const radius = new Float64Array(n);
        for (const i of test) radius[i] = Math.max(0, p.radius * (ps ? Math.abs(ps[i]) : 1));
        let key: (i: number) => number;
        if (p.priority === 'attribute') {
          const a = p.priority_attrib ? g.points.get(p.priority_attrib) : null;
          if (!a || a.type === 'string' || a.isArray) throw new NodeError(`prune: priority_attrib "${p.priority_attrib}" is not a numeric point attribute`);
          const d = a.data as Float64Array, s = a.size;
          key = (i) => -d[i * s];
        } else if (p.priority === 'largest') key = (i) => -radius[i];
        else if (p.priority === 'smallest') key = (i) => radius[i];
        else if (p.priority === 'order') key = (i) => i;
        else key = () => 0;
        const order = test.slice().sort((x, y) => key(x) - key(y) || (p.priority === 'order' ? 0 : hashR(x) - hashR(y)) || x - y);
        const keep = sphereOverlapPrune(Pd, radius, order);
        for (const i of test) if (!keep[i]) remove[i] = 1;
        break;
      }
      case 'density': {
        const a = p.attrib ? g.points.get(p.attrib) : null;
        const d = a && a.type !== 'string' && !a.isArray ? (a.data as Float64Array) : null, s = a ? a.size : 1;
        for (const i of test) if (hashR(i) >= (d ? clamp01(d[i * s]) : 1) * p.fraction) remove[i] = 1;
        break;
      }
      case 'expression': {
        const m = mask(g, 'point', tightExpr(p.expression));
        for (const i of test) if (!m || m[i]) remove[i] = 1;
        break;
      }
      case 'near_geometry': {
        if (!hasInput(1)) throw new NodeError('prune near_geometry: connect the geometry to keep away from as the second input', '"in": ["points", "buildings"]');
        const q = new SurfaceQuery(input(1));
        if (q.empty) throw new NodeError('prune near_geometry: the second input is empty');
        const nr = newNearest(), dist = Math.max(0, p.distance);
        for (const i of test) {
          const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
          if ((dist > 0 && q.nearest(x, y, z, dist, nr) && nr.dist < dist) || (p.inside && q.hasPolygons && q.inside(x, y, z))) remove[i] = 1;
        }
        break;
      }
      default:
        throw new NodeError(`prune: unknown mode "${p.mode}"`);
    }
    if (p.invert) for (const i of test) remove[i] = remove[i] ? 0 : 1;
    let removed = 0;
    for (let i = 0; i < n; i++) removed += remove[i];
    stat('removed', removed);
    if (!removed) return g;
    return g.subsetPoints(remove.map((x) => (x ? 0 : 1)));
  },
});

export { clusterColor };
