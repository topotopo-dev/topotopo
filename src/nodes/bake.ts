// Bake nodes (category "texture"): surface data of a mesh baked into an image in its uv space, Substance Painter /
// Marmoset style. Input 0 is the (low-poly) mesh with uv; the optional input 1 is a high-res source that bake_normal,
// bake_height and bake_world_normal read (rays along the low normals within a cage) and that the ray and curvature bakes
// sample instead of the low surface. Triangles are rasterised in uv space with conservative coverage, `supersample` ×
// `supersample` samples per texel, then averaged; `padding` dilates the islands so mipmaps do not bleed. Every bake
// writes layer C (the map) and layer "mask" (the texel coverage 0..1, before padding). Rays and curvature run in chunks
// on the worker pool (kernels "occlusion", "bake_project", "bake_curvature"). Algorithms: core/bake.ts.
import type { Geometry } from '../core/geometry.ts';
import { Image, MAIN_LAYER } from '../core/image.ts';
import {
  averagedVertexNormals, bakeSamples, curvatureEdges, dilate, edgeGrid, idColor, interpolate, interpolateCorners, normalize3, resolve, uvIslands, vertexPositions, vertexValues,
} from '../core/bake.ts';
import { cornerTangents, loadMikkTSpace, mikkTSpaceReady, shadingFrame } from '../core/tangents.ts';
import type { BakeSamples, CurvatureArgs } from '../core/bake.ts';
import { RayScene, bboxDiagonal } from '../core/analysis.ts';
import type { RaySampleOptions } from '../core/analysis.ts';
import { pointNormals, resolveVertexNormals, triangulate } from '../core/topology.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext, NodeDef, ParamDef } from '../graph/types.ts';
import { andThen } from '../graph/parallel.ts';
import { P, mask } from './util.ts';
import { NAMED_BY_NODE, imageGeo, nameParam, outName, resolutionParam, size2 } from './texture.ts';

/** Most samples a bake may rasterise (output texels × supersample²): 4096², about 1 GB of per-sample arrays at full coverage. */
const MAX_SAMPLES = 4096 * 4096;

// ---------------------------------------------------------------- shared params

const BAKE_PARAMS = (): Record<string, ParamDef> => ({
  resolution: resolutionParam(1024),
  supersample: { type: 'int', default: 1, min: 1, max: 4, desc: 'samples per texel along each axis (2 = 4 samples averaged: smoother edges, 4× the work)', aliases: ['ssaa', 'antialiasing', 'subsampling'] },
  padding: { type: 'int', default: 4, min: 0, max: 256, desc: 'dilate islands by this many texels (no background bleeding in mipmaps)', aliases: ['dilation', 'margin', 'edge_padding'] },
  uv_attrib: { type: 'string', default: 'uv', desc: 'vertex or point uv attribute to bake into', aliases: ['uv_name', 'uvattrib'] },
  group: P.group('prim', 'prims to bake ("" = all); the others leave their texels empty'),
  keep_mesh: { type: 'bool', default: false, desc: 'output the input mesh with the image added (off: only the image)', aliases: ['keep_input', 'keep'] },
  name: nameParam(),
});

const INPUTS = [
  { name: 'geo', desc: 'mesh to bake (needs uv without overlaps: uv_unwrap or uv_layout)' },
  { name: 'high', desc: 'optional high-res source, near the mesh (within cage)', optional: true },
];

const cageParam = (): ParamDef => ({ type: 'float', default: 0, min: 0, desc: 'high-res input: search distance along the cage normals on each side (metres; 0 = auto: 2% of the bbox diagonal)', aliases: ['cage_distance', 'max_frontal_distance', 'ray_distance'] });
const cageNormalsParam = (): ParamDef => ({ type: 'enum', options: ['averaged', 'mesh'], default: 'averaged', desc: 'high-res input: ray directions: averaged normals over every face at a position (no gaps at hard edges) or the mesh\'s own normals', aliases: ['ray_normals', 'average_normals'] });

/** The setup every bake shares: triangles, uv, covered samples, per-sample position and normal. */
interface Bake {
  ctx: CookContext;
  g: Geometry;
  tris: Uint32Array;
  triPrim: Uint32Array;
  uv: Float64Array;
  s: BakeSamples;
  /** per-sample world position and unit normal of the low mesh */
  readonly P: Float64Array;
  readonly N: Float64Array;
  diag: number;
}

function readUVNamed(g: Geometry, name: string): Float64Array | null {
  const f = g.findAttrib(name || 'uv', ['vertex', 'point']);
  if (!f || f.attr.type !== 'float') return null;
  const a = f.attr, d = a.data as Float64Array, s = a.size;
  const out = new Float64Array(g.numVertices * 2);
  for (let v = 0; v < g.numVertices; v++) {
    const i = (f.cls === 'vertex' ? v : g.vertexPoint[v]) * s;
    out[v * 2] = d[i];
    out[v * 2 + 1] = s > 1 ? d[i + 1] : 0;
  }
  return out;
}

function setup(ctx: CookContext): Bake {
  const { p, type } = ctx;
  const g = ctx.input(0);
  const [W, H] = size2(p, type);
  const S = Math.max(1, Math.min(4, Math.round(p.supersample)));
  if (W * H * S * S > MAX_SAMPLES) throw new NodeError(`${type}: ${W} × ${H} at supersample ${S} is ${(W * H * S * S).toLocaleString('en-US')} samples (at most ${MAX_SAMPLES.toLocaleString('en-US')})`, 'lower resolution or supersample');
  const { tris, triPrim } = triangulate(g);
  if (!tris.length) throw new NodeError(`${type}: input 0 has no polygons to bake`, 'bakes need a mesh with uv (e.g. box → uv_unwrap → bake_ao)');
  const uv = readUVNamed(g, p.uv_attrib);
  if (!uv) throw new NodeError(`${type}: input 0 has no "${p.uv_attrib || 'uv'}" attribute`, 'unwrap it first: uv_unwrap (xatlas), uv_flatten + uv_layout, or uv_project for simple shapes; islands must not overlap');
  const sel = mask(g, 'prim', p.group);
  let skip: Uint8Array | null = null;
  if (sel) { skip = new Uint8Array(triPrim.length); for (let t = 0; t < triPrim.length; t++) skip[t] = sel[triPrim[t]] ? 0 : 1; }
  const s = bakeSamples(uv, tris, W, H, S, skip);
  if (s.outside) ctx.warn(`${type}: ${s.outside} triangle(s) reach outside the 0..1 uv square (clipped; UDIM tiles are not baked)`);
  if (!s.n) ctx.warn(`${type}: no texel is covered (uv collapsed or outside 0..1)`);
  // per-sample positions and normals, interpolated on first use (id, mask and colour bakes do not need them)
  let P: Float64Array | null = null, N: Float64Array | null = null;
  return {
    ctx, g, tris, triPrim, uv, s, diag: bboxDiagonal(g) || 1,
    get P() { return (P ??= interpolate(s, tris, vertexPositions(g), 3)); },
    get N() {
      if (!N) { N = interpolate(s, tris, resolveVertexNormals(g, 60), 3); normalize3(N); }
      return N;
    },
  };
}

/** Resolve per-sample values into the output image (C + mask + extra layers), pad, and wrap it as the node's output. */
function finish(b: Bake, vals: ArrayLike<number>, ch: number, background: number[], extra: Record<string, { vals: ArrayLike<number>; ch: number; background: number[] }> = {}): Geometry {
  const { ctx, s } = b, p = ctx.p;
  const { data, coverage } = resolve(s, vals, ch);
  const img = new Image(s.W, s.H, outName(ctx));
  const pad = Math.max(0, Math.round(p.padding));
  dilate(data, ch, s.W, s.H, coverage, pad, background);
  img.set(MAIN_LAYER, data);
  for (const [k, e] of Object.entries(extra)) {
    const r = resolve(s, e.vals, e.ch);
    dilate(r.data, e.ch, s.W, s.H, coverage, pad, e.background);
    img.set(k, r.data);
  }
  img.set('mask', coverage);
  let covered = 0;
  for (let i = 0; i < coverage.length; i++) if (coverage[i] > 0) covered++;
  ctx.stat('texels', covered);
  ctx.stat('coverage', covered / coverage.length);
  if (!p.keep_mesh) return imageGeo(img);
  const g = ctx.input(0).clone();
  g.volumes.push(img);
  return g;
}

/** The high-res input, when connected and holding polygons. */
function highOf(ctx: CookContext): Geometry | null {
  if (!ctx.hasInput(1)) return null;
  const h = ctx.input(1);
  return triangulate(h).tris.length ? h : null;
}

/**
 * Project the samples onto the high-res mesh along the cage directions R (kernel bake_project): D = signed distance of
 * the hit above the low surface along R (NaN = miss) and NO = the high normal there. Resolves to the value (no promise)
 * when the kernel ran on this thread.
 */
function project(b: Bake, high: Geometry, cage: number, normals: boolean) {
  const scene = RayScene.of(high);
  const HN = normals ? pointNormalsOf(high) : new Float64Array(0);
  const R = rayDirs(b);
  const D = new Float64Array(b.s.n), NO = new Float64Array(normals ? b.s.n * 3 : 0);
  const run = b.ctx.parallelMap('bake_project', {
    count: b.s.n, args: { cage }, inputs: { P: b.P, N: R }, results: normals ? { D, NO } : { D }, shared: { ...scene.toArrays(), HN },
  });
  return andThen(run, () => ({ D, NO, scene, R }));
}

/** Cage ray directions per sample: averaged normals (default; no gaps at hard edges) or the mesh's own normals. */
function rayDirs(b: Bake): Float64Array {
  if (b.ctx.p.cage_normals === 'mesh') return b.N;
  const R = interpolate(b.s, b.tris, averagedVertexNormals(b.g, 1e-6 * b.diag), 3);
  normalize3(R);
  return R;
}

/**
 * Point normals of a mesh: its point N when present, else area-weighted face normals. Points whose N is zero or not
 * finite take the computed normal: a merge of parts with and without N fills the missing ones with zeros, which would
 * bake as grey.
 */
function pointNormalsOf(g: Geometry): Float64Array {
  const a = g.points.get('N');
  if (!a || a.type !== 'float' || a.size !== 3) return pointNormals(g);
  const N = a.data as Float64Array;
  let out: Float64Array | null = null, computed: Float64Array | null = null;
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]);
    if (l > 1e-12 && Number.isFinite(l)) continue;
    out ??= N.slice();
    computed ??= pointNormals(g);
    out[i] = computed[i]; out[i + 1] = computed[i + 1]; out[i + 2] = computed[i + 2];
  }
  return out ?? N;
}

/** andThen() for a callback that may itself return a promise (a cook result); keeps synchronous runs synchronous. */
const chain = <T>(x: T | Promise<T>, f: (v: T) => Geometry | Promise<Geometry>): Geometry | Promise<Geometry> => (x instanceof Promise ? x.then(f) : f(x));

const cageOf = (b: Bake) => (b.ctx.p.cage > 0 ? b.ctx.p.cage : 0.02 * b.diag);

/** Samples moved onto the high mesh (P, N) where the projection hit; the low surface elsewhere. */
function onHigh(b: Bake, high: Geometry) {
  return andThen(project(b, high, cageOf(b), true), ({ D, NO, scene, R }) => {
    const P = b.P.slice(), N = b.N.slice();
    let miss = 0;
    for (let i = 0; i < b.s.n; i++) {
      const d = D[i];
      if (!(d === d)) { miss++; continue; }
      for (let c = 0; c < 3; c++) { P[i * 3 + c] += R[i * 3 + c] * d; N[i * 3 + c] = NO[i * 3 + c]; }
    }
    if (miss) b.ctx.warn(`${b.ctx.type}: ${miss} of ${b.s.n} samples found no high-res surface within the cage (${cageOf(b).toPrecision(3)} m); they use the low surface (raise cage)`);
    return { P, N, scene, D, miss };
  });
}

function defineBake(def: Omit<NodeDef, 'category' | 'inputs'> & { inputs?: NodeDef['inputs'] }) {
  defineNode({ category: 'texture', inputs: INPUTS, usesNodeName: NAMED_BY_NODE, ...def } as NodeDef);
}

const BAKE_DOC = 'Input 0 needs non-overlapping uv in 0..1 (uv_unwrap); layer "mask" holds the coverage. ';

// ---------------------------------------------------------------- ray bakes

function rayBake(ctx: CookContext, mode: 'occlusion' | 'thickness') {
  const b = setup(ctx), p = ctx.p;
  const high = highOf(ctx);
  const go = (P: Float64Array, N: Float64Array, scene: RayScene) => {
    const diag = b.diag;
    const maxD = p.max_distance > 0 ? p.max_distance : mode === 'thickness' ? 0.25 * diag : 0;
    const opts: RaySampleOptions = { mode, samples: p.samples, maxDistance: maxD, bias: p.bias > 0 ? p.bias : 1e-4 * diag, coneAngle: p.cone_angle > 0 ? p.cone_angle : mode === 'thickness' ? 30 : 90, seed: p.seed };
    const out = new Float64Array(b.s.n);
    const run = ctx.parallelMap('occlusion', { count: b.s.n, args: opts, inputs: { P, N }, results: { out }, shared: scene.toArrays() }, { minElements: Math.ceil(32768 / Math.max(1, p.samples)) });
    return andThen(run, () => {
      const v = new Float32Array(b.s.n);
      for (let i = 0; i < b.s.n; i++) {
        let x = mode === 'occlusion' ? 1 - out[i] : Math.min(1, out[i] / maxD);
        if (p.invert) x = 1 - x;
        v[i] = x;
      }
      ctx.stat('rays', b.s.n * p.samples);
      return finish(b, v, 1, [mode === 'occlusion' ? 1 : 0]);
    });
  };
  if (!high) return go(b.P, b.N, RayScene.of(b.g));
  return chain(onHigh(b, high), (h) => go(h.P, h.N, h.scene));
}

const RAY_PARAMS: Record<string, ParamDef> = {
  samples: { type: 'int', default: 16, min: 1, max: 1024, desc: 'rays per sample (stratified; more = smoother, linear cost)', aliases: ['rays', 'secondary_rays'] },
  bias: { type: 'float', default: 0, min: 0, desc: 'ray start offset along the normal against self-hits (0 = auto: 1e-4 of the bbox diagonal)' },
  seed: P.seed(),
  invert: { type: 'bool', default: false, desc: 'write 1 - value' },
  cage: cageParam(), cage_normals: cageNormalsParam(),
};

defineBake({
  type: 'bake_ao',
  summary: 'Bake ambient occlusion into uv space: white = open sky, dark in gaps, corners and contact areas.',
  description:
    'Substance Painter / Marmoset "Ambient Occlusion". ' + BAKE_DOC + 'Each texel casts `samples` cosine-weighted rays over the ' +
    'hemisphere of its normal against the mesh (or the high-res input, sampled at the projected point); C = 1 - the fraction ' +
    'that hit within max_distance. Combine with bake_curvature for edge wear and dirt masks; pack into ORM with tex_channel.',
  aliases: ['ao_bake', 'bake_ambient_occlusion', 'bake_occlusion'],
  params: {
    ...BAKE_PARAMS(),
    ...RAY_PARAMS,
    max_distance: { type: 'float', default: 0, min: 0, desc: 'hits farther than this do not occlude (metres; 0 = unlimited)', aliases: ['max_occluder_distance', 'distance', 'radius'] },
    cone_angle: { type: 'float', default: 0, min: 0, max: 90, desc: 'half-angle of the ray cone in degrees (0 = auto: 90, the hemisphere)', aliases: ['spread', 'angle'] },
  },
  outputs: 'image <name> (default: the node name): C grey 0..1 (1 = open), mask',
  example: {
    nodes: {
      crate: { type: 'topotopo/props/crate' },
      uv: { type: 'uv_unwrap', in: ['crate'] },
      ao: { type: 'bake_ao', in: ['uv'], params: { resolution: 512, samples: 24 } },
    },
    output: 'ao',
  },
  cook: (ctx) => rayBake(ctx, 'occlusion'),
});

defineBake({
  type: 'bake_thickness',
  summary: 'Bake thickness into uv space: rays into the mesh measure how thick it is under each texel (white = thick).',
  description:
    'Substance Painter "Thickness". ' + BAKE_DOC + 'Each texel casts `samples` rays in a cone around its inward normal; C = the ' +
    'mean distance to the far side divided by max_distance (misses count as max_distance). invert gives white where thin ' +
    '(translucency, subsurface masks).',
  aliases: ['thickness_bake', 'bake_thick'],
  params: {
    ...BAKE_PARAMS(),
    ...RAY_PARAMS,
    max_distance: { type: 'float', default: 0, min: 0, desc: 'thickness that maps to 1 (metres; 0 = auto: 25% of the bbox diagonal)', aliases: ['distance', 'radius'] },
    cone_angle: { type: 'float', default: 0, min: 0, max: 90, desc: 'half-angle of the ray cone in degrees (0 = auto: 30)', aliases: ['spread', 'angle'] },
  },
  outputs: 'image <name> (default: the node name): C grey 0..1, mask',
  example: {
    nodes: {
      ring: { type: 'torus' },
      uv: { type: 'uv_unwrap', in: ['ring'] },
      thick: { type: 'bake_thickness', in: ['uv'], params: { resolution: 256, samples: 16 } },
    },
    output: 'thick',
  },
  cook: (ctx) => rayBake(ctx, 'thickness'),
});

// ---------------------------------------------------------------- curvature

defineBake({
  type: 'bake_curvature',
  summary: 'Bake edge curvature into uv space: 0.5 flat, brighter on convex edges and bevels, darker in concave creases (edge wear and dirt masks).',
  description:
    'Substance Painter "Curvature". ' + BAKE_DOC + 'Measured from the mesh\'s dihedral angles in 3D (uv seams do not show): every ' +
    'edge carries its signed bend (angle / 90°, + convex), and a texel sums the bends of the edge length within `radius`, ' +
    'weighted (1 - d²/r²)² and normalised so a 90° edge through the texel reads 1. C = 0.5 + 0.5 × strength × value; ' +
    'layers "convex" and "concave" hold the two sides 0..1. Edges whose faces both turn away from a texel (the far side ' +
    'of a thin plank) are ignored; points are matched by position, so unwelded boxes work. tex_histogram_scan or ' +
    'tex_levels on "convex" make an edge-wear mask.',
  aliases: ['curvature_bake', 'bake_edges', 'edge_wear_bake'],
  params: {
    ...BAKE_PARAMS(),
    radius: { type: 'float', default: 0, min: 0, desc: 'how far an edge reaches across the surface (metres; 0 = auto: 1% of the bbox diagonal)', aliases: ['width', 'edge_width', 'distance'] },
    strength: { type: 'float', default: 1, min: 0, desc: 'contrast multiplier', aliases: ['intensity', 'contrast'] },
    min_angle: { type: 'float', default: 0.5, min: 0, max: 179, desc: 'edges bending less than this (degrees) are ignored' },
    cage: cageParam(), cage_normals: cageNormalsParam(),
  },
  outputs: 'image <name> (default: the node name): C grey (0.5 = flat), convex, concave, mask',
  example: {
    nodes: {
      box: { type: 'box' },
      pocket: { type: 'poly_extrude', in: ['box'], params: { group: '@P.y>0.4', distance: -0.2, inset: 0.15 } },
      uv: { type: 'uv_unwrap', in: ['pocket'] },
      curv: { type: 'bake_curvature', in: ['uv'], params: { resolution: 512 } },
    },
    output: 'curv',
  },
  cook: (ctx) => {
    const b = setup(ctx), p = ctx.p;
    const high = highOf(ctx);
    const go = (P: Float64Array, N: Float64Array, src: Geometry) => {
      const r = p.radius > 0 ? p.radius : 0.01 * b.diag;
      const edges = curvatureEdges(src, 1e-6 * (bboxDiagonal(src) || 1), p.min_angle);
      const grid = edgeGrid(edges, r);
      const args: CurvatureArgs = { radius: r, facing: 0.25, origin: grid.origin, cell: grid.cell, dims: grid.dims };
      const V = new Float64Array(b.s.n);
      ctx.stat('edges', edges.count);
      const run = ctx.parallelMap('bake_curvature', {
        count: b.s.n, args, inputs: { P, N }, results: { V }, shared: { E: edges.E, D: edges.D, K: edges.K, FN: edges.FN, start: grid.start, items: grid.items },
      });
      return andThen(run, () => {
        const k = p.strength, n = b.s.n;
        const C = new Float32Array(n), cx = new Float32Array(n), cc = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const v = V[i] * k;
          C[i] = Math.max(0, Math.min(1, 0.5 + 0.5 * v));
          cx[i] = Math.max(0, Math.min(1, v));
          cc[i] = Math.max(0, Math.min(1, -v));
        }
        return finish(b, C, 1, [0.5], { convex: { vals: cx, ch: 1, background: [0] }, concave: { vals: cc, ch: 1, background: [0] } });
      });
    };
    if (!high) return go(b.P, b.N, b.g);
    return chain(onHigh(b, high), (h) => go(h.P, h.N, high));
  },
});

// ---------------------------------------------------------------- position and normals

defineBake({
  type: 'bake_position',
  summary: 'Bake world position into uv space as RGB (bbox-normalised by default): gradients, masks by height or direction.',
  description:
    'Substance Painter "Position". ' + BAKE_DOC + 'mode bbox maps each axis of the bounding box to 0..1 (R = X, G = Y, B = Z), ' +
    'uniform maps the largest axis to 0..1 and keeps the proportions (centred), world writes metres as they are (data, ' +
    'beyond 0..1). Feed tex_channel extract (channel g) for a bottom-to-top gradient.',
  aliases: ['position_bake', 'bake_world_position'],
  inputs: [INPUTS[0]],
  params: {
    ...BAKE_PARAMS(),
    mode: { type: 'enum', options: ['bbox', 'uniform', 'world'], default: 'bbox', desc: 'how positions map to colour', aliases: ['normalize'] },
  },
  outputs: 'image <name> (default: the node name): C RGBA, mask',
  example: {
    nodes: {
      crate: { type: 'topotopo/props/crate' },
      uv: { type: 'uv_unwrap', in: ['crate'] },
      pos: { type: 'bake_position', in: ['uv'], params: { resolution: 256 } },
    },
    output: 'pos',
  },
  cook: (ctx) => {
    const b = setup(ctx), p = ctx.p;
    const bb = b.g.bbox();
    const size = [0, 1, 2].map((c) => bb.max[c] - bb.min[c]);
    const big = Math.max(...size) || 1;
    const n = b.s.n, out = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const x = b.P[i * 3 + c];
        out[i * 4 + c] = p.mode === 'world' ? x : p.mode === 'uniform' ? (x - (bb.min[c] + bb.max[c]) / 2) / big + 0.5 : size[c] > 0 ? (x - bb.min[c]) / size[c] : 0.5;
      }
      out[i * 4 + 3] = 1;
    }
    return finish(b, out, 4, [0, 0, 0, 1]);
  },
});

defineBake({
  type: 'bake_world_normal',
  summary: 'Bake world-space normals into uv space as RGB (0.5 + 0.5 n): the mesh\'s own, or the high-res input\'s along the cage.',
  description: 'Substance Painter "World Space Normal". ' + BAKE_DOC + 'Without input 1 the mesh\'s interpolated vertex normals (N, else computed with a 60° cusp); with a high-res input its normals where the cage rays hit it. Green-channel masks (tex_channel extract g) give "facing up" for dust and snow.',
  aliases: ['world_normal_bake', 'bake_worldspace_normal'],
  params: { ...BAKE_PARAMS(), cage: cageParam(), cage_normals: cageNormalsParam() },
  outputs: 'image <name> (default: the node name): C RGBA, mask',
  example: {
    nodes: {
      ball: { type: 'sphere', params: { rows: 8, cols: 16 } },
      uv: { type: 'uv_unwrap', in: ['ball'] },
      nrm: { type: 'bake_world_normal', in: ['uv'], params: { resolution: 256 } },
    },
    output: 'nrm',
  },
  cook: (ctx) => {
    const b = setup(ctx);
    const high = highOf(ctx);
    const go = (N: Float64Array) => {
      const n = b.s.n, out = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) out[i * 4 + c] = 0.5 + 0.5 * N[i * 3 + c]; out[i * 4 + 3] = 1; }
      return finish(b, out, 4, [0.5, 1, 0.5, 1]);
    };
    if (!high) return go(b.N);
    return chain(onHigh(b, high), (h) => go(h.N));
  },
});

defineBake({
  type: 'bake_normal',
  summary: 'Bake a tangent-space normal map from a high-res mesh (input 1) onto the uv of the low mesh: OpenGL or DirectX.',
  description:
    'Substance Painter / Marmoset "Normal". ' + BAKE_DOC + 'For each texel a ray from cage above the low surface along -N finds ' +
    'the high-res surface (within cage below); its interpolated normal is written in the low mesh\'s MikkTSpace tangent ' +
    'frame as 0.5 + 0.5 n: the frame glTF export writes as TANGENT and Blender, Unreal and Unity compute, so the map ' +
    'decodes the same everywhere (N interpolated and normalised, T the interpolated MikkTSpace tangent made ' +
    'perpendicular to N, B = w · N × T). Misses and a missing input 1 give the flat (0.5, 0.5, 1). glTF and Blender ' +
    'read OpenGL; Unreal DirectX (or flip green on import).',
  aliases: ['normal_bake', 'bake_tangent_normal', 'bake_normal_map'],
  params: {
    ...BAKE_PARAMS(),
    cage: cageParam(), cage_normals: cageNormalsParam(),
    format: { type: 'enum', options: ['opengl', 'directx'], default: 'opengl', desc: 'green channel convention', aliases: ['convention'] },
  },
  outputs: 'image <name> (default: the node name): C RGBA, mask',
  example: {
    nodes: {
      low: { type: 'box', params: { divisions: [2, 2, 2] } },
      uv: { type: 'uv_unwrap', in: ['low'] },
      high: { type: 'subdivide', in: ['low'], params: { levels: 3 } },
      nrm: { type: 'bake_normal', in: ['uv', 'high'], params: { resolution: 512, cage: 0.4 } },
    },
    output: 'nrm',
  },
  cook: (ctx) => {
    const b = setup(ctx), p = ctx.p;
    const high = highOf(ctx);
    const n = b.s.n, out = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { out[i * 4] = 0.5; out[i * 4 + 1] = 0.5; out[i * 4 + 2] = 1; out[i * 4 + 3] = 1; }
    if (!high) {
      ctx.warn(`${ctx.type}: no high-res mesh on input 1: the map is flat (0.5, 0.5, 1)`);
      return finish(b, out, 4, [0.5, 0.5, 1, 1]);
    }
    const dx = p.format === 'directx' ? -1 : 1;
    const bakeWith = () => {
      // the same vertex normals (cusp 60°) and uv the exporter writes, so the frame matches the exported TANGENT
      const { tangents, diag } = cornerTangents(b.g, b.tris, resolveVertexNormals(b.g, 60), b.uv);
      if (diag.uvDegenerate || diag.uvNonFinite) ctx.warn(`${ctx.type}: ${diag.uvDegenerate + diag.uvNonFinite} of ${diag.triangles} triangles have collapsed or non-finite uvs: no tangent frame there (flat texels)`);
      const T = interpolateCorners(b.s, tangents, 4), f = new Float64Array(9);
      const collapsed = new Uint8Array(diag.triangles);
      for (let t = 0; t < diag.triangles; t++) {
        const u0 = b.uv[b.tris[t * 3] * 2], v0 = b.uv[b.tris[t * 3] * 2 + 1];
        const du1 = b.uv[b.tris[t * 3 + 1] * 2] - u0, dv1 = b.uv[b.tris[t * 3 + 1] * 2 + 1] - v0, du2 = b.uv[b.tris[t * 3 + 2] * 2] - u0, dv2 = b.uv[b.tris[t * 3 + 2] * 2 + 1] - v0;
        if (!(Math.abs(du1 * dv2 - du2 * dv1) > 0)) collapsed[t] = 1;
      }
      return andThen(onHigh(b, high), (h) => {
        for (let i = 0; i < n; i++) {
          if (!(h.D[i] === h.D[i]) || collapsed[b.s.tri[i]]) continue;
          if (!shadingFrame(b.N[i * 3], b.N[i * 3 + 1], b.N[i * 3 + 2], T[i * 4], T[i * 4 + 1], T[i * 4 + 2], T[i * 4 + 3], f)) continue;
          const hx = h.N[i * 3], hy = h.N[i * 3 + 1], hz = h.N[i * 3 + 2];
          const u = hx * f[0] + hy * f[1] + hz * f[2], v = hx * f[3] + hy * f[4] + hz * f[5], w = hx * f[6] + hy * f[7] + hz * f[8];
          const l = Math.hypot(u, v, w) || 1;
          out[i * 4] = 0.5 + (0.5 * u) / l; out[i * 4 + 1] = 0.5 + (0.5 * v * dx) / l; out[i * 4 + 2] = 0.5 + (0.5 * w) / l;
        }
        return finish(b, out, 4, [0.5, 0.5, 1, 1]);
      });
    };
    return mikkTSpaceReady() ? bakeWith() : loadMikkTSpace().then(bakeWith);
  },
});

defineBake({
  type: 'bake_height',
  summary: 'Bake the height of a high-res mesh (input 1) above the low mesh along its normals: a displacement / height map.',
  description:
    'Substance Painter "Height". ' + BAKE_DOC + 'Rays along the low normals within ±cage find the high surface; layer "distance" ' +
    'holds the signed distance in metres (0 on a miss) and C maps it to 0..1: mode cage = 0.5 + d / (2 cage) (0.5 = on ' +
    'the low surface), normalize = the min..max of the hits (stats height_min / height_max). Feed tex_normal_from_height ' +
    'or use it as displacement.',
  aliases: ['height_bake', 'bake_displacement', 'displacement_bake'],
  params: {
    ...BAKE_PARAMS(),
    cage: cageParam(), cage_normals: cageNormalsParam(),
    mode: { type: 'enum', options: ['cage', 'normalize'], default: 'cage', desc: 'how distances map to 0..1', aliases: ['range'] },
  },
  outputs: 'image <name> (default: the node name): C grey 0..1, distance (metres), mask',
  example: {
    nodes: {
      low: { type: 'box', params: { divisions: [2, 2, 2] } },
      uv: { type: 'uv_unwrap', in: ['low'] },
      smooth: { type: 'subdivide', in: ['low'], params: { levels: 3 } },
      high: { type: 'noise_displace', in: ['smooth'], params: { amplitude: 0.05, frequency: 6 } },
      height: { type: 'bake_height', in: ['uv', 'high'], params: { resolution: 256, cage: 0.4 } },
    },
    output: 'height',
  },
  cook: (ctx) => {
    const b = setup(ctx), p = ctx.p;
    const high = highOf(ctx);
    if (!high) throw new NodeError(`${ctx.type}: connect a high-res mesh to input 1`, 'e.g. the subdivided or displaced version of the mesh, near it (within cage)');
    const cage = cageOf(b);
    return andThen(project(b, high, cage, false), ({ D }) => {
      const n = b.s.n, dist = new Float32Array(n), C = new Float32Array(n);
      let lo = Infinity, hi = -Infinity, miss = 0;
      for (let i = 0; i < n; i++) { const d = D[i]; if (d === d) { if (d < lo) lo = d; if (d > hi) hi = d; } else miss++; }
      if (miss) ctx.warn(`${ctx.type}: ${miss} of ${n} samples found no high-res surface within the cage (${cage.toPrecision(3)} m)`);
      const span = hi > lo ? hi - lo : 1;
      for (let i = 0; i < n; i++) {
        const d = D[i];
        dist[i] = d === d ? d : 0;
        C[i] = d === d ? (p.mode === 'normalize' ? (d - lo) / span : Math.max(0, Math.min(1, 0.5 + d / (2 * cage)))) : p.mode === 'normalize' ? 0 : 0.5;
      }
      if (hi >= lo) { ctx.stat('height_min', lo); ctx.stat('height_max', hi); }
      return finish(b, C, 1, [p.mode === 'normalize' ? 0 : 0.5], { distance: { vals: dist, ch: 1, background: [0] } });
    });
  },
});

// ---------------------------------------------------------------- ids, masks, colours

defineBake({
  type: 'bake_island_id',
  summary: 'Bake uv islands as random flat colours (an ID map for masking per island), with the island number in layer "id".',
  description: 'Substance Painter "ID" (by uv island). ' + BAKE_DOC + 'Islands are triangles connected through corners that share a point and a uv. C is a random colour per island (seed), layer "id" the island number 0..n-1 (the stat islands counts them).',
  aliases: ['island_id_bake', 'bake_id', 'id_bake', 'bake_uv_islands'],
  inputs: [INPUTS[0]],
  params: { ...BAKE_PARAMS(), seed: P.seed() },
  outputs: 'image <name> (default: the node name): C RGBA, id (island number), mask',
  example: {
    nodes: {
      crate: { type: 'topotopo/props/crate' },
      uv: { type: 'uv_unwrap', in: ['crate'] },
      ids: { type: 'bake_island_id', in: ['uv'], params: { resolution: 256 } },
    },
    output: 'ids',
  },
  cook: (ctx) => {
    const b = setup(ctx), p = ctx.p;
    const isl = uvIslands(b.g, b.uv, b.tris);
    ctx.stat('islands', isl.count);
    const n = b.s.n, col = new Float32Array(n * 4), id = new Float32Array(n);
    const pal = Array.from({ length: isl.count }, (_, k) => idColor(k, p.seed));
    for (let i = 0; i < n; i++) {
      const k = isl.triIsland[b.s.tri[i]], c = pal[k];
      col[i * 4] = c[0]; col[i * 4 + 1] = c[1]; col[i * 4 + 2] = c[2]; col[i * 4 + 3] = 1;
      id[i] = k;
    }
    // ids are labels: a texel straddling two islands takes the first sample's island, not an average
    if (b.s.S > 1) {
      const first = new Int32Array(b.s.W * b.s.H).fill(-1);
      for (let i = 0; i < n; i++) if (first[b.s.texel[i]] < 0) first[b.s.texel[i]] = i;
      for (let i = 0; i < n; i++) { const f = first[b.s.texel[i]]; id[i] = id[f]; for (let c = 0; c < 4; c++) col[i * 4 + c] = col[f * 4 + c]; }
    }
    return finish(b, col, 4, [0, 0, 0, 1], { id: { vals: id, ch: 1, background: [-1] } });
  },
});

defineBake({
  type: 'bake_mask',
  summary: 'Bake a mask into uv space from a prim group (1 inside) or a numeric attribute (its value), e.g. to paint per-part materials.',
  description: 'Substance Painter "ID" (by group / attribute). ' + BAKE_DOC + 'mask_group (a prim group pattern) gives 1 on its prims and 0 elsewhere; else attrib (point, vertex, prim or detail; component picks one of a vector, -1 = luminance) is interpolated as it is; with neither, C is the coverage itself.',
  aliases: ['mask_bake', 'bake_group', 'bake_attribute', 'attribute_bake'],
  inputs: [INPUTS[0]],
  params: {
    ...BAKE_PARAMS(),
    mask_group: { type: 'group', default: '', groupClass: 'prim', desc: 'prims that read 1 (e.g. "planks", "@P.y>0.5")', aliases: ['from_group', 'mask_prims'] },
    attrib: { type: 'string', default: '', desc: 'numeric attribute to bake when mask_group is empty', aliases: ['attribute', 'from_attrib'] },
    component: { type: 'int', default: 0, min: -1, max: 15, desc: 'vector component of attrib (-1 = luminance of the first three)' },
  },
  outputs: 'image <name> (default: the node name): C grey, mask',
  example: {
    nodes: {
      box: { type: 'box' },
      uv: { type: 'uv_unwrap', in: ['box'] },
      top: { type: 'bake_mask', in: ['uv'], params: { resolution: 256, mask_group: '@P.y>0.4', name: 'top_mask' } },
    },
    output: 'top',
  },
  cook: (ctx) => {
    const b = setup(ctx), p = ctx.p;
    const n = b.s.n, C = new Float32Array(n);
    const grp = String(p.mask_group ?? '').trim();
    if (grp) {
      const sel = mask(b.g, 'prim', grp)!;
      for (let i = 0; i < n; i++) C[i] = sel[b.triPrim[b.s.tri[i]]] ? 1 : 0;
    } else if (String(p.attrib ?? '').trim()) {
      const f = b.g.findAttrib(p.attrib, ['vertex', 'point', 'prim', 'detail']);
      if (!f || f.attr.type === 'string' || f.attr.isArray) throw new NodeError(`${ctx.type}: no numeric attribute "${p.attrib}"`, 'bake_mask reads float/int point, vertex, prim or detail attributes');
      const size = f.attr.size;
      const vals = vertexValues(b.g, p.attrib, size)!;
      const I = interpolate(b.s, b.tris, vals, size);
      const comp = p.component < 0 ? -1 : Math.min(size - 1, p.component);
      for (let i = 0; i < n; i++) C[i] = comp >= 0 ? I[i * size + comp] : size >= 3 ? I[i * size] * 0.2126 + I[i * size + 1] * 0.7152 + I[i * size + 2] * 0.0722 : I[i * size];
    } else C.fill(1);
    return finish(b, C, 1, [0]);
  },
});

defineBake({
  type: 'bake_vertex_color',
  summary: 'Bake a colour attribute (Cd, with Alpha) into uv space as an RGBA image.',
  description: 'Substance Painter "Color Map from Mesh". ' + BAKE_DOC + 'attrib (point, vertex, prim or detail; 1 or 3+ floats) is interpolated across the triangles; alpha_attrib fills A when present. Values are written as they are, the same numbers the renderer shows.',
  aliases: ['vertex_color_bake', 'bake_color', 'bake_cd', 'color_bake'],
  inputs: [INPUTS[0]],
  params: {
    ...BAKE_PARAMS(),
    attrib: { type: 'string', default: 'Cd', desc: 'colour attribute', aliases: ['attribute', 'color_attrib'] },
    alpha_attrib: { type: 'string', default: 'Alpha', desc: 'alpha attribute (missing = 1)' },
  },
  outputs: 'image <name> (default: the node name): C RGBA, mask',
  example: {
    nodes: {
      ball: { type: 'sphere', params: { rows: 12, cols: 24 } },
      tint: { type: 'color', in: ['ball'], params: { mode: 'ramp', attrib: 'P.y' } },
      uv: { type: 'uv_unwrap', in: ['tint'] },
      cd: { type: 'bake_vertex_color', in: ['uv'], params: { resolution: 256 } },
    },
    output: 'cd',
  },
  cook: (ctx) => {
    const b = setup(ctx), p = ctx.p;
    const vals = vertexValues(b.g, p.attrib, 3);
    if (!vals) throw new NodeError(`${ctx.type}: no numeric attribute "${p.attrib}"`, 'colour the mesh first (color, attrib_noise, wrangle @Cd) or name another attribute');
    const C3 = interpolate(b.s, b.tris, vals, 3);
    const av = String(p.alpha_attrib ?? '').trim() ? vertexValues(b.g, p.alpha_attrib, 1) : null;
    const A = av ? interpolate(b.s, b.tris, av, 1) : null;
    const n = b.s.n, out = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { out[i * 4] = C3[i * 3]; out[i * 4 + 1] = C3[i * 3 + 1]; out[i * 4 + 2] = C3[i * 3 + 2]; out[i * 4 + 3] = A ? A[i] : 1; }
    return finish(b, out, 4, [0, 0, 0, 1]);
  },
});
