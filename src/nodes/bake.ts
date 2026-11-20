// Bake nodes (category "texture"): surface data of a mesh baked into an image in its uv space, Substance Painter /
// Marmoset style. Input 0 is the (low-poly) mesh with uv; the optional input 1 is a high-res source that bake_normal,
// bake_height and bake_world_normal read (rays along the low normals within a cage) and that the ray and curvature bakes
// sample instead of the low surface. Triangles are rasterised in uv space with conservative coverage, `supersample` ×
// `supersample` samples per texel, then averaged; `padding` dilates the islands so mipmaps do not bleed. Every bake
// writes layer C (the map) and layer "mask" (the texel coverage 0..1, before padding). Rays and curvature run in chunks
// on the worker pool (kernels "occlusion", "bake_project", "bake_curvature"). Algorithms: core/bake.ts.
import type { Geometry } from '../core/geometry.ts';
import { Image, MAIN_LAYER, imageRef, referenceableImages, sampleUV } from '../core/image.ts';
import { MATERIAL_KINDS, primMaterials, readMaterials, resolveKind } from '../core/materials.ts';
import { uvOverlapCheck, uvPairText } from '../core/uvoverlap.ts';
import { medianTexelSize, triangleTexelSizes } from '../core/texelsize.ts';
import {
  applyPadding, averagedVertexNormals, bakeSamples, curvatureEdges, edgeGrid, idColor, interpolate, interpolateCorners, memoBake, normalize3, paddingMap, rasterizeUV, resolve, uvIslands, vertexPositions, vertexValues,
} from '../core/bake.ts';
import { MIKK_RESET_BYTES, cornerTangents, loadMikkTSpace, mikkTSpaceHeapBytes, mikkTSpaceReady, shadingFrame } from '../core/tangents.ts';
import type { BakeSamples, CurvatureArgs } from '../core/bake.ts';
import { bakeMemoStats } from '../core/bake.ts';
import { PAST_DEADLINE, runBuried, runCurvature, runInterp, surfaceCloud, surfaceMesh, afterRun } from '../core/surface.ts';
import type { SurfaceCloud, SurfaceMesh } from '../core/surface.ts';
import { RayScene, bboxDiagonal } from '../core/analysis.ts';
import type { RaySampleOptions } from '../core/analysis.ts';
import { pointNormals, resolveVertexNormals, triangulate } from '../core/topology.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext, NodeDef, ParamDef } from '../graph/types.ts';
import { andThen } from '../graph/parallel.ts';
import { didYouMean } from '../graph/params.ts';
import { partsOf, primWhere } from '../core/report.ts';
import { tiledScene } from '../core/trimtile.ts';
import { P, mask, simBudget } from './util.ts';
import { NAMED_BY_NODE, imageGeo, nameParam, outName, resolutionParam, size2 } from './texture.ts';

/** Most samples a bake may rasterise (output texels × supersample²): 4096², about 1 GB of per-sample arrays at full coverage. */
const MAX_SAMPLES = 4096 * 4096;

// ---------------------------------------------------------------- shared params

export const BAKE_PARAMS = (): Record<string, ParamDef> => ({
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
/** The params of every bake that reads a high-res mesh on input 1. */
const HIGH_PARAMS = (): Record<string, ParamDef> => ({
  cage: cageParam(), cage_normals: cageNormalsParam(),
  cage_attrib: { type: 'string', default: 'cage', desc: 'high-res input: a float attribute of the mesh (prim, point or vertex) that sets the cage where it is above 0, e.g. per part with attrib_create {name:"cage", class:"prim", group:"@name=grip", value:0.03}', aliases: ['cage_attribute'] },
  match_name: { type: 'bool', default: false, desc: 'high-res input: each piece projects only onto the high prims with the same prim "name" (parts sharing one atlas do not pick up their neighbours)', aliases: ['match_names', 'by_name'] },
});

/** The setup every bake shares: triangles, uv, covered samples, per-sample position and normal. */
export interface Bake {
  ctx: CookContext;
  g: Geometry;
  tris: Uint32Array;
  triPrim: Uint32Array;
  uv: Float64Array;
  /** per triangle, 1 where `group` leaves it out (null: every triangle is baked) */
  skip: Uint8Array | null;
  s: BakeSamples;
  /** per-sample world position and unit normal of the low mesh */
  readonly P: Float64Array;
  readonly N: Float64Array;
  diag: number;
  /** per sample, 1 where the projection onto the high-res mesh found nothing (the "missed" layer) */
  missed?: Float32Array;
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

export function setup(ctx: CookContext): Bake {
  const { p, type } = ctx;
  const g = ctx.input(0);
  const [W, H] = size2(p, type);
  const S = Math.max(1, Math.min(4, Math.round(p.supersample)));
  if (W * H * S * S > MAX_SAMPLES) throw new NodeError(`${type}: ${W} × ${H} at supersample ${S} is ${(W * H * S * S).toLocaleString('en-US')} samples (at most ${MAX_SAMPLES.toLocaleString('en-US')})`, 'lower resolution or supersample');
  // one rasterisation per mesh, uv, size and group, shared by every bake of this cook and the next: cooked
  // geometry is immutable, so the mesh object itself is the key
  const group = String(p.group ?? '');
  const r = memoBake(g, `samples|${p.uv_attrib || 'uv'}|${W}|${H}|${S}|${group}`, () => {
    const { tris, triPrim } = triangulate(g);
    if (!tris.length) throw new NodeError(`${type}: input 0 has no polygons to bake`, 'bakes need a mesh with uv (e.g. box → uv_unwrap → bake_ao)');
    const uv = readUVNamed(g, p.uv_attrib);
    if (!uv) throw new NodeError(`${type}: input 0 has no "${p.uv_attrib || 'uv'}" attribute`, 'unwrap it first: uv_unwrap (xatlas), uv_flatten + uv_layout, or uv_project for simple shapes; islands must not overlap');
    const sel = mask(g, 'prim', group);
    let skip: Uint8Array | null = null;
    if (sel) { skip = new Uint8Array(triPrim.length); for (let t = 0; t < triPrim.length; t++) skip[t] = sel[triPrim[t]] ? 0 : 1; }
    const s = bakeSamples(uv, tris, W, H, S, skip);
    // per-sample positions and normals, interpolated on first use (id, mask and colour bakes do not need them)
    return { tris, triPrim, uv, skip, s, P: null as Float64Array | null, N: null as Float64Array | null };
  });
  const { tris, triPrim, uv, s } = r;
  if (s.outside) ctx.warn(`${type}: ${s.outside} triangle(s) reach outside the 0..1 uv square (clipped; UDIM tiles are not baked)`);
  if (!s.n) ctx.warn(`${type}: no texel is covered (uv collapsed or outside 0..1)`);
  return {
    ctx, g, tris, triPrim, uv, skip: r.skip, s, diag: bboxDiagonal(g) || 1,
    get P() { return (r.P ??= interpolate(s, tris, vertexPositions(g), 3)); },
    get N() {
      if (!r.N) { const N = interpolate(s, tris, resolveVertexNormals(g, 60), 3); normalize3(N); r.N = N; }
      return r.N;
    },
  };
}

/**
 * Resolve per-sample values into the output image (C + mask + extra layers) and pad it: one padding map (from the
 * coverage) serves every layer. Returns the image with its coverage and the padding map.
 */
export function finishImage(b: Bake, vals: ArrayLike<number>, ch: number, background: number[], extra: Record<string, { vals: ArrayLike<number>; ch: number; background: number[] }> = {}): { img: Image; coverage: Float32Array; map: Int32Array } {
  const { ctx, s } = b, p = ctx.p;
  const { data, coverage } = resolve(s, vals, ch);
  const img = new Image(s.W, s.H, outName(ctx));
  const pad = Math.max(0, Math.round(p.padding));
  const map = paddingMap(coverage, s.W, s.H, pad);
  applyPadding(data, ch, map, background);
  img.set(MAIN_LAYER, data);
  // with a high-res mesh: where the projection found nothing, to see which parts need a larger cage
  const layers = b.missed ? { ...extra, missed: { vals: b.missed, ch: 1, background: [0] } } : extra;
  for (const [k, e] of Object.entries(layers)) {
    const r = resolve(s, e.vals, e.ch);
    applyPadding(r.data, e.ch, map, e.background);
    img.set(k, r.data);
  }
  img.set('mask', coverage);
  let covered = 0;
  for (let i = 0; i < coverage.length; i++) if (coverage[i] > 0) covered++;
  ctx.stat('texels', covered);
  ctx.stat('coverage', covered / coverage.length);
  return { img, coverage, map };
}

/** finishImage, wrapped as the node's output: the image alone, or the mesh with the image added (keep_mesh). */
function finish(b: Bake, vals: ArrayLike<number>, ch: number, background: number[], extra: Record<string, { vals: ArrayLike<number>; ch: number; background: number[] }> = {}): Geometry {
  const { img } = finishImage(b, vals, ch, background, extra);
  return wrapImage(b, img);
}

/**
 * The layers a bake adds so later nodes work in metres and stay on one island: "texel" (RGBA: R metres one texel covers
 * along u, G along v, at each sample's triangle) and "island" (the uv island; the first sample of a texel decides).
 * `first` maps each texel to its first sample when supersampled (null at supersample 1).
 */
export function texelLayers(b: Bake, P3: Float64Array): { texel: { vals: Float32Array; ch: number; background: number[] }; island: { vals: Float32Array; ch: number; background: number[] }; first: Int32Array | null } {
  const n = b.s.n, nt = b.s.W * b.s.H;
  const triTexel = triangleTexelSizes(P3, b.uv, b.tris, b.s.W, b.s.H);
  const isl = uvIslands(b.g, b.uv, b.tris);
  const T = new Float32Array(n * 4), ID = new Float32Array(n);
  const first = b.s.S > 1 ? new Int32Array(nt).fill(-1) : null;
  if (first) for (let i = 0; i < n; i++) if (first[b.s.texel[i]] < 0) first[b.s.texel[i]] = i;
  for (let i = 0; i < n; i++) {
    const f = first ? first[b.s.texel[i]] : i, t = b.s.tri[i];
    T[i * 4] = triTexel[t * 2]; T[i * 4 + 1] = triTexel[t * 2 + 1]; T[i * 4 + 3] = 1;
    ID[i] = isl.triIsland[b.s.tri[f]];
  }
  return { texel: { vals: T, ch: 4, background: [0, 0, 0, 1] }, island: { vals: ID, ch: 1, background: [-1] }, first };
}

/** The surface-measure setup of a bake's mesh, uv and size (core/surface.ts), made once and shared by every bake. */
export function surfaceOf(b: Bake): SurfaceMesh {
  const p = b.ctx.p, key = `surface|${p.uv_attrib || 'uv'}|${b.s.W}|${b.s.H}|${String(p.group ?? '')}`;
  const t0 = performance.now();
  const made = bakeMemoStats.made;
  const m = memoBake(b.g, key, () => surfaceMesh(b.g, b.tris, b.triPrim, b.uv, b.skip, b.s.W, b.s.H));
  if (bakeMemoStats.made !== made) b.ctx.stage('surface setup', performance.now() - t0);
  return m;
}

/** The cloud every k texels over a bake's atlas (shared like surfaceOf). */
export function cloudOf(b: Bake, mesh: SurfaceMesh, k: number): SurfaceCloud {
  const p = b.ctx.p, key = `cloud|${p.uv_attrib || 'uv'}|${b.s.W}|${b.s.H}|${String(p.group ?? '')}|${k}`;
  const t0 = performance.now();
  const made = bakeMemoStats.made;
  const c = memoBake(b.g, key, () => surfaceCloud(mesh, b.tris, b.uv, b.skip, b.s.W, b.s.H, k));
  if (bakeMemoStats.made !== made) b.ctx.stage('cloud', performance.now() - t0);
  b.ctx.stat('cloud_points', c.cloud.n);
  return c;
}

/**
 * A kernel runner for the surface measures under the time limit of long-running nodes: `deadline` goes into every
 * kernel's args (a kernel past it stops, on the pool or on this thread), and either way the node fails with the time
 * limit's error.
 */
export function surfaceRunner(ctx: CookContext, hint: string): { run: (kernel: string, job: any, o?: any) => any; deadline: number; check: () => void } {
  const budget = simBudget(ctx, hint), deadline = Date.now() + budget.left();
  const fail = (e: unknown): never => { if (String((e as any)?.message ?? e).includes(PAST_DEADLINE)) throw budget.error(); throw e; };
  const run = (kernel: string, job: any, o?: any) => {
    budget.check();
    try {
      const r = ctx.parallelMap(kernel, job, o);
      return r instanceof Promise ? r.catch(fail) : r;
    } catch (e) { return fail(e); }
  };
  return { run, deadline, check: () => budget.check() };
}

/** Curvature radius limit of the surface method: half the model's bounding-box diagonal. */
export function checkSurfaceRadius(b: Bake, r: number, what: string): void {
  if (r > 0.5 * b.diag) throw new NodeError(`${b.ctx.type}: ${what} ${+r.toPrecision(3)} m is more than half the model's size (bounding-box diagonal ${+b.diag.toPrecision(3)} m)`, `use a radius up to ${+(0.5 * b.diag).toPrecision(3)} m; a radius about the size of the wear or dirt you want reads best`);
}

/** Which cloud points lie inside a solid (null when nothing can bury anything); `sur` the surroundings in the scene. */
export function buriedOf(b: Bake, mesh: SurfaceMesh, sc: SurfaceCloud, scene: () => RayScene, sur: Geometry | null, run: (kernel: string, job: any, o?: any) => any, deadline: number): Uint8Array | null | Promise<Uint8Array | null> {
  const t0 = performance.now();
  return afterRun(runBuried(run, sc, mesh, scene(), sur, deadline), (B) => {
    if (B) {
      let k = 0;
      for (let i = 0; i < B.length; i++) k += B[i];
      b.ctx.stat('buried_points', k);
      b.ctx.stage('buried', performance.now() - t0);
    }
    return B;
  });
}

/** One line naming the parts that hold `prims` ("" when the mesh has no prim names). */
export function partsText(g: Geometry, prims: number[]): string {
  const s = partsOf(g, prims);
  return s ? ` (parts ${s})` : '';
}

/** The warnings of a surface setup: faces turned to agree with their neighbours, inward pieces, normals turned. */
export function surfaceWarnings(b: Bake, mesh: SurfaceMesh) {
  const { ctx, g } = b, o = mesh.orient;
  if (o.turned.length) ctx.warn(`${ctx.type}: ${o.turned.length} face(s) are wound against their neighbours or their normals${partsText(g, o.turned)}; they are measured turned`);
  if (o.inward.length) ctx.warn(`${ctx.type}: ${o.inward.length} closed piece(s) face inward (normals into the solid)${partsText(g, o.inward)}; they are measured so: reverse them if that is not intended`);
  if (mesh.turnedVertices) ctx.warn(`${ctx.type}: ${mesh.turnedVertices} vertex normal(s) point into their face and are measured turned to the face's side`);
}

export function wrapImage(b: Bake, img: Image): Geometry {
  if (!b.ctx.p.keep_mesh) return imageGeo(img);
  const g = b.ctx.input(0).clone();
  g.volumes.push(img);
  return g;
}

/** The high-res input, when connected and holding polygons. */
function highOf(ctx: CookContext): Geometry | null {
  if (!ctx.hasInput(1)) return null;
  const h = ctx.input(1);
  if (!triangulate(h).tris.length) return null;
  return ctx.p.tile ? tiledScene(h) : h;
}

/**
 * Project the samples onto the high-res mesh along the cage directions R (kernel bake_project): D = signed distance of
 * the hit above the low surface along R (NaN = miss) and NO = the high normal there. Resolves to the value (no promise)
 * when the kernel ran on this thread.
 */
function project(b: Bake, high: Geometry, cage: number, normals: boolean) {
  const { ctx } = b, n = b.s.n;
  const scene = RayScene.of(high);
  const R = rayDirs(b), C = cagesOf(b, cage);
  const D = new Float64Array(n), NO = new Float64Array(normals ? n * 3 : 0);
  const done = () => {
    const missed = new Float32Array(n);
    for (let i = 0; i < n; i++) if (!(D[i] === D[i])) missed[i] = 1;
    b.missed = missed;
    let count = 0;
    for (let i = 0; i < n; i++) count += missed[i];
    ctx.stat('missed', count);
    return { D, NO, scene, R };
  };
  // match_name: each named piece of the mesh projects onto the high prims of the same name only
  const lowName = b.g.prims.get('name'), highName = high.prims.get('name');
  if (!ctx.p.match_name || !lowName || lowName.type !== 'string' || !highName || highName.type !== 'string') {
    if (ctx.p.match_name) ctx.warn(`${ctx.type}: match_name needs a prim "name" on the mesh and on the high mesh; every high prim is matched`);
    const run = ctx.parallelMap('bake_project', {
      count: n, args: { cage }, inputs: { P: b.P, N: R, C }, results: normals ? { D, NO } : { D }, shared: { ...scene.toArrays(), HN: normals ? pointNormalsOf(high) : new Float64Array(0) },
    });
    return andThen(run, done);
  }
  const ln = lowName.data as string[], hn = highName.data as string[];
  const bySample = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = ln[b.triPrim[b.s.tri[i]]] ?? '';
    const l = bySample.get(k);
    if (l) l.push(i); else bySample.set(k, [i]);
  }
  const lonely: string[] = [], runs: (unknown | Promise<unknown>)[] = [];
  for (const [nm, idx] of bySample) {
    const sel = Uint8Array.from(hn, (x) => (x === nm ? 1 : 0));
    if (!sel.some((x) => x)) { lonely.push(nm || '(no name)'); for (const i of idx) D[i] = NaN; continue; }
    const sub = high.subsetPrims(sel), sc = RayScene.of(sub), m = idx.length;
    const Ps = new Float64Array(m * 3), Ns = new Float64Array(m * 3), Cs = C ? new Float64Array(m) : undefined;
    idx.forEach((i, k) => { for (let c = 0; c < 3; c++) { Ps[k * 3 + c] = b.P[i * 3 + c]; Ns[k * 3 + c] = R[i * 3 + c]; } if (Cs) Cs[k] = C![i]; });
    const Ds = new Float64Array(m), NOs = new Float64Array(normals ? m * 3 : 0);
    const run = ctx.parallelMap('bake_project', {
      count: m, args: { cage }, inputs: { P: Ps, N: Ns, C: Cs }, results: normals ? { D: Ds, NO: NOs } : { D: Ds }, shared: { ...sc.toArrays(), HN: normals ? pointNormalsOf(sub) : new Float64Array(0) },
    });
    runs.push(andThen(run, () => idx.forEach((i, k) => { D[i] = Ds[k]; if (normals) for (let c = 0; c < 3; c++) NO[i * 3 + c] = NOs[k * 3 + c]; })));
  }
  if (lonely.length) ctx.warn(`${ctx.type}: match_name: no high prims named ${lonely.slice(0, 8).map((x) => `"${x}"`).join(', ')}${lonely.length > 8 ? ' …' : ''}; those pieces bake as misses`);
  return runs.some((r) => r instanceof Promise) ? Promise.all(runs).then(done) : done();
}

/**
 * Per-sample cage distances where the mesh carries the cage_attrib attribute (prim, point or vertex; e.g. set per part
 * with attrib_create {name: "cage", class: "prim", group}): its value where > 0, else the node's cage. Null without one.
 */
function cagesOf(b: Bake, cage: number): Float64Array | undefined {
  const name = String(b.ctx.p.cage_attrib ?? '').trim();
  const f = name ? b.g.findAttrib(name, ['vertex', 'point', 'prim', 'detail']) : null;
  if (!f || f.attr.type === 'string' || f.attr.isArray) return undefined;
  const C = interpolate(b.s, b.tris, vertexValues(b.g, name, 1)!, 1);
  for (let i = 0; i < C.length; i++) if (!(C[i] > 0)) C[i] = cage;
  return C;
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

/** Where the projection missed, for its warning: the parts with missed samples (counts) and the first one's place. */
function missWhere(b: Bake): string {
  const m = b.missed;
  if (!m) return '';
  const prims: number[] = [];
  let first = -1;
  for (let i = 0; i < b.s.n; i++) if (m[i]) { if (first < 0) first = i; prims.push(b.triPrim[b.s.tri[i]]); }
  if (first < 0) return '';
  const parts = partsOf(b.g, prims);
  return `; ${parts ? `samples by part: ${parts}; ` : ''}the first at ${primWhere(b.g, b.triPrim[b.s.tri[first]], b.P.subarray(first * 3, first * 3 + 3))}`;
}

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
    if (miss) b.ctx.warn(`${b.ctx.type}: ${miss} of ${b.s.n} samples found no high-res surface within the cage (${cageOf(b).toPrecision(3)} m${b.ctx.p.cage_attrib && b.g.findAttrib(b.ctx.p.cage_attrib, ['vertex', 'point', 'prim', 'detail']) ? `, or attribute "${b.ctx.p.cage_attrib}"` : ''}); they use the low surface${missWhere(b)}. Layer "missed" shows where: raise cage there (cage_attrib per part)`);
    return { P, N, scene, D, miss };
  });
}

function defineBake(def: Omit<NodeDef, 'category' | 'inputs'> & { inputs?: NodeDef['inputs'] }) {
  defineNode({ category: 'texture', inputs: INPUTS, usesNodeName: NAMED_BY_NODE, ...def } as NodeDef);
}

export const BAKE_DOC = 'Input 0 needs non-overlapping uv in 0..1 (uv_unwrap); layer "mask" holds the coverage. Bakes that read a high-res mesh on input 1 add layer "missed": 1 where the cage ray found no high surface (stat missed); cage_attrib sets the cage per part and match_name keeps each named piece to the high prims of its name. ';

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
  if (!high) return go(b.P, b.N, RayScene.of(p.tile ? tiledScene(b.g) : b.g));
  return chain(onHigh(b, high), (h) => go(h.P, h.N, h.scene));
}

const RAY_PARAMS: Record<string, ParamDef> = {
  samples: { type: 'int', default: 16, min: 1, max: 1024, desc: 'rays per sample (stratified; more = smoother, linear cost)', aliases: ['rays', 'secondary_rays'] },
  bias: { type: 'float', default: 0, min: 0, desc: 'ray start offset along the normal against self-hits (0 = auto: 1e-4 of the bbox diagonal)' },
  seed: P.seed(),
  invert: { type: 'bool', default: false, desc: 'write 1 - value' },
  tile: { type: 'bool', default: true, desc: 'trim sheets: a band that tiles is copied one period past each open end, so the bake does not fade there (no effect without trim bands). Help topic trim_sheets.' },
  ...HIGH_PARAMS(),
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
    'of a thin plank) are ignored; points are matched by position, so unwelded boxes work. intersections (on by ' +
    'default) also finds the creases where separate parts cut into each other, as kitbashed meshes have them (a rivet ' +
    'or boss merged onto a plate, a box sunk into another): concave by the angle between the two faces, so dirt ' +
    'gathers there too (stat crossing_edges). tex_histogram_scan or tex_levels on "convex" make an edge-wear mask, ' +
    'on "concave" a dirt or cavity mask. method surface measures how the shading normals turn within radius instead, on ' +
    'a cloud of surface points interpolated in 3D (as bake_measure curvature): the facets of decimated and isosurface ' +
    'meshes do not read as edges, hard edges (split normals) still do, and each connected part is measured on its own ' +
    '(where parts intersect, cavity shows the seam); min_angle and intersections are for method ' +
    'dihedral, and it does not read a high-res input.',
  aliases: ['curvature_bake', 'bake_edges', 'edge_wear_bake'],
  params: {
    ...BAKE_PARAMS(),
    radius: { type: 'float', default: 0, min: 0, desc: 'how far an edge reaches across the surface (metres; 0 = auto: 1% of the bbox diagonal)', aliases: ['width', 'edge_width', 'distance'] },
    strength: { type: 'float', default: 1, min: 0, desc: 'contrast multiplier', aliases: ['intensity', 'contrast'] },
    method: { type: 'enum', options: ['dihedral', 'surface'], default: 'dihedral', desc: 'dihedral: the angles of the mesh edges near the texel; surface: how the shading normals turn within radius (facets smaller than radius do not show: decimated and isosurface meshes; other parts count where they are not buried, so junctions read concave; radius at most half the size of the model)', aliases: ['mode', 'curvature_method'] },
    min_angle: { type: 'float', default: 0.5, min: 0, max: 179, desc: 'dihedral: edges bending less than this (degrees) are ignored' },
    intersections: { type: 'bool', default: true, desc: 'dihedral: also find the concave creases where separate parts cut into each other (kitbashed meshes)', aliases: ['crossings', 'intersection_creases'] },
    tile: { type: 'bool', default: true, desc: 'trim sheets: a band that tiles is copied one period past each open end, so curvature does not fade there (no effect without trim bands). Help topic trim_sheets.' },
    ...HIGH_PARAMS(),
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
    const shape = (V: ArrayLike<number>) => {
      const k = p.strength, n = b.s.n;
      const C = new Float32Array(n), cx = new Float32Array(n), cc = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = V[i] * k;
        C[i] = Math.max(0, Math.min(1, 0.5 + 0.5 * v));
        cx[i] = Math.max(0, Math.min(1, v));
        cc[i] = Math.max(0, Math.min(1, -v));
      }
      return finish(b, C, 1, [0.5], { convex: { vals: cx, ch: 1, background: [0] }, concave: { vals: cc, ch: 1, background: [0] } });
    };
    if (p.method === 'surface') {
      if (high) throw new NodeError(`${ctx.type}: method surface reads the mesh's own shading normals; a high-res input 1 is not read`, 'disconnect input 1, or use method dihedral to sample the high-res mesh');
      const r = p.radius > 0 ? p.radius : 0.01 * b.diag;
      checkSurfaceRadius(b, r, 'radius');
      if (!b.s.n) return shape(new Float32Array(0));
      const mesh = surfaceOf(b);
      surfaceWarnings(b, mesh);
      // the cloud at least twice as dense as the radius, at most every 4 texels
      const k = Math.max(1, Math.min(4, mesh.median > 0 ? r / (2 * mesh.median) : 1));
      const sc = cloudOf(b, mesh, k);
      const { run, deadline } = surfaceRunner(ctx, 'a smaller radius or resolution; or raise the limit');
      return afterRun(buriedOf(b, mesh, sc, () => memoBake(b.g, 'rayscene', () => RayScene.of(b.g)), null, run, deadline), (CB) => {
        let t0 = performance.now();
        return afterRun(runCurvature(run, sc, r, CB, deadline), (CV) => {
          ctx.stage('curvature', performance.now() - t0);
          t0 = performance.now();
          return afterRun(runInterp(run, b.s, b.tris, mesh, sc, CV, 1, CB, deadline), (V) => {
            ctx.stage('interpolation', performance.now() - t0);
            return shape(V);
          });
        });
      });
    }
    const go = (P: Float64Array, N: Float64Array, src: Geometry) => {
      const r = p.radius > 0 ? p.radius : 0.01 * b.diag;
      const counts = { shared: 0, crossing: 0, capped: false };
      const edges = curvatureEdges(src, 1e-6 * (bboxDiagonal(src) || 1), p.min_angle, !!p.intersections, counts);
      if (counts.capped) ctx.warn(`${ctx.type}: the search for crossing parts stopped early on this large mesh; some creases where parts cut into each other may be missing`);
      const grid = edgeGrid(edges, r);
      const args: CurvatureArgs = { radius: r, facing: 0.25, origin: grid.origin, cell: grid.cell, dims: grid.dims };
      const V = new Float64Array(b.s.n);
      ctx.stat('edges', edges.count);
      ctx.stat('crossing_edges', counts.crossing);
      const run = ctx.parallelMap('bake_curvature', {
        count: b.s.n, args, inputs: { P, N }, results: { V }, shared: { E: edges.E, D: edges.D, K: edges.K, FN: edges.FN, start: grid.start, items: grid.items },
      });
      return andThen(run, () => shape(V));
    };
    if (!high) return go(b.P, b.N, p.tile ? tiledScene(b.g) : b.g);
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
  params: { ...BAKE_PARAMS(), ...HIGH_PARAMS() },
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
    ...HIGH_PARAMS(),
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
    return mikkTSpaceReady() && mikkTSpaceHeapBytes() <= MIKK_RESET_BYTES ? bakeWith() : loadMikkTSpace().then(bakeWith);
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
    ...HIGH_PARAMS(),
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
      if (miss) ctx.warn(`${ctx.type}: ${miss} of ${n} samples found no high-res surface within the cage (${cage.toPrecision(3)} m)${missWhere(b)}; layer "missed" shows where`);
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
  description: 'Substance Painter "ID" (by group / attribute). ' + BAKE_DOC + 'mask_group (a prim group pattern) gives 1 where any of its prims covers the texel and 0 elsewhere, so overlapping region prims add up instead of the topmost one winning; else attrib (point, vertex, prim or detail; component picks one of a vector, -1 = luminance) is interpolated as it is; with neither, C is the coverage itself.',
  aliases: ['mask_bake', 'bake_group', 'bake_attribute', 'attribute_bake'],
  inputs: [INPUTS[0]],
  params: {
    ...BAKE_PARAMS(),
    mask_group: { type: 'group', default: '', groupClass: 'prim', desc: 'prims that read 1 (e.g. "planks", "@P.y>0.5")', aliases: ['from_group', 'mask_prims'] },
    attrib: { type: 'string', default: '', desc: 'numeric attribute to bake when mask_group is empty; a comma list ("wear, dirt") bakes one layer per attribute, named after it, C = the first', aliases: ['attribute', 'from_attrib'] },
    component: { type: 'int', default: 0, min: -1, max: 15, desc: 'vector component of attrib (-1 = luminance of the first three)' },
  },
  outputs: 'image <name> (default: the node name): C grey, mask; with an attrib list also one layer per attribute',
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
      // the centre raster keeps the last triangle, so a group prim hidden under another would read 0; a second raster
      // of the group alone makes the mask their union. Texels only the conservative pass covered keep the winner.
      const skipG = new Uint8Array(b.triPrim.length);
      for (let t = 0; t < b.triPrim.length; t++) skipG[t] = sel[b.triPrim[t]] ? 0 : 1;
      const hit = rasterizeUV(b.uv, b.tris, b.s.W * b.s.S, b.s.H * b.s.S, false, skipG);
      for (let i = 0; i < n; i++) C[i] = hit.tri[b.s.pix[i]] >= 0 || sel[b.triPrim[b.s.tri[i]]] ? 1 : 0;
    } else if (String(p.attrib ?? '').trim()) {
      // a comma list bakes one layer per attribute (named after it), C = the first
      const names = String(p.attrib).split(',').map((s) => s.trim()).filter(Boolean);
      const layers: Record<string, { vals: Float32Array; ch: number; background: number[] }> = {};
      names.forEach((name, k) => {
        const f = b.g.findAttrib(name, ['vertex', 'point', 'prim', 'detail']);
        if (!f || f.attr.type === 'string' || f.attr.isArray) throw new NodeError(`${ctx.type}: no numeric attribute "${name}"`, 'bake_mask reads float/int point, vertex, prim or detail attributes');
        const size = f.attr.size;
        const vals = vertexValues(b.g, name, size)!;
        const I = interpolate(b.s, b.tris, vals, size);
        const comp = p.component < 0 ? -1 : Math.min(size - 1, p.component);
        const out = k === 0 ? C : new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = comp >= 0 ? I[i * size + comp] : size >= 3 ? I[i * size] * 0.2126 + I[i * size + 1] * 0.7152 + I[i * size + 2] * 0.0722 : I[i * size];
        if (names.length > 1) {
          const layer = identifier(name);
          if (layer === 'C' || layer === 'mask' || layers[layer]) throw new NodeError(`${ctx.type}: attribute "${name}" would write layer "${layer}" twice or over a reserved layer`, 'list each attribute once; C and mask are written by the node');
          layers[layer] = { vals: out, ch: 1, background: [0] };
        }
      });
      return finish(b, C, 1, [0], layers);
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

// ---------------------------------------------------------------- materials

const KIND_LIST = MATERIAL_KINDS.join(', ');

/** The names in quotes, at most `max` of them. */
const quoted = (names: string[], max = 6) => names.slice(0, max).map((n) => `"${n}"`).join(', ') + (names.length > max ? `, … ${names.length - max} more` : '');

/** A name an expression can read: every character that is not a letter, digit or underscore becomes an underscore. */
const identifier = (s: string) => s.replace(/[^A-Za-z0-9_$]/g, '_');

defineBake({
  type: 'bake_material',
  summary: 'Bake the material table into uv space: base colour, roughness and metallic from each prim\'s material, a 0/1 mask per material and per kind, and the texel size and uv island of every texel.',
  description:
    'Reads the prim attribute "material" and the detail table "materials" (the material node) and writes, in the uv space of the mesh ' +
    '(uv_attrib): C = the base colour (RGBA; where a material\'s base colour map is an "image:<name>" the geometry carries, the colour ' +
    'it shows), layer "roughness" and layer "metallic" (the material\'s values; a packed orm map gives roughness from its green and ' +
    'metallic from its blue channel times the factors, a roughness map its green channel), a 0/1 layer "mat_<material>" per material the ' +
    'baked prims use and a 0/1 layer "kind_<kind>" per kind present (masks: all, materials, kinds or none), layer "texel" ' +
    '(R = metres one texel covers along u, G along v, at that texel: tex_layers builds its normal map from it, so a step has the same ' +
    'slope at any resolution and on any shape of image) and layer "island" (the uv island, so a filter can stay on one). Maps are read ' +
    'with the mesh\'s "uv" attribute (the uv a material\'s maps use), whatever uv_attrib the bake is laid out with. A material\'s normal ' +
    'map is not carried (its detail is not in the stack yet: a warning names the material), nor is the occlusion of an orm map: give ' +
    'tex_layers an occlusion expression. Layer names are valid identifiers (a material "Paint.001" is "mat_Paint_001"; a warning ' +
    'lists the renames and two materials never share a name). A texel that two materials share takes the first sample\'s material for ' +
    'the labels (as bake_island_id does for ids); colours are averaged over the samples. The kind of a material is, in this order, ' +
    'the `kinds` entry for its name, its own `kind` field (the material node\'s kind param), its whole name when that is a kind or ' +
    'one of its names (painted_steel, paint, rubber, label …); a material that none tells has no kind layer. ' +
    BAKE_DOC + 'This is the base of tex_layers (its input 0), which reads layers roughness and metallic as the base values, texel and ' +
    'island for the normal, mask as coverage, and the masks mat_* and kind_* in its expressions. Faces whose uv overlap are warned about ' +
    '(a texel they share holds the last one\'s values). Stats: size (metres the image width covers, the median texel size times the width) and texel_mm.',
  aliases: ['material_bake', 'bake_materials', 'bake_material_table'],
  inputs: [INPUTS[0]],
  params: {
    ...BAKE_PARAMS(),
    kinds: { type: 'json', default: {}, desc: 'kind per material name, e.g. {"zinc_steel": "galvanised"}; wins over the material\'s own kind (kinds: ' + KIND_LIST + ')', aliases: ['material_kinds'] },
    masks: { type: 'enum', options: ['all', 'materials', 'kinds', 'none'], default: 'all', desc: 'which 0/1 mask layers to write: mat_<material>, kind_<kind>, both or neither', aliases: ['mask_layers', 'labels'] },
  },
  outputs: 'image <name> (default: the node name): C base colour RGBA, roughness, metallic, mat_<material> (0/1 per material), kind_<kind> (0/1 per kind present), texel (RGBA: R metres per texel along u, G along v), island, mask; stats size, texel_mm, texels, coverage',
  example: {
    nodes: {
      box: { type: 'box' },
      paint: { type: 'material', in: ['box'], params: { name: 'paint', base_color: '#6f8fae', roughness: 0.55, kind: 'painted_metal', group: '@P.y>0.4' } },
      steel: { type: 'material', in: ['paint'], params: { name: 'steel', base_color: '#9a9a96', roughness: 0.35, metallic: 1, kind: 'bare_steel', group: '@P.y<0.4' } },
      uv: { type: 'uv_unwrap', in: ['steel'] },
      base: { type: 'bake_material', in: ['uv'], params: { resolution: 256 } },
    },
    output: 'base',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const g = ctx.input(0);
    const per = primMaterials(g);
    if (!per) throw new NodeError(`${type}: input 0 has no prim attribute "material"`, 'assign materials first (material node); colours carried as Cd bake with bake_vertex_color');
    const b = setup(ctx);
    const table = readMaterials(g);
    // the prims this bake covers: those with a triangle that is not left out by the group
    const sel = mask(g, 'prim', p.group);
    const skip = sel ? Uint8Array.from(b.triPrim, (pr) => (sel[pr] ? 0 : 1)) : null;
    const primUsed = new Uint8Array(g.numPrims);
    for (let t = 0; t < b.triPrim.length; t++) if (!skip || !skip[t]) primUsed[b.triPrim[t]] = 1;
    const order: string[] = [], index = new Map<string, number>();
    const undefinedNames = new Set<string>();
    const primMat = new Int32Array(g.numPrims).fill(-1);
    let unassigned = 0;
    for (let i = 0; i < g.numPrims; i++) {
      if (!primUsed[i]) continue;
      const name = per[i] ?? '';
      if (!name) { unassigned++; continue; }
      if (!table[name]) { undefinedNames.add(name); continue; }
      let mi = index.get(name);
      if (mi === undefined) { mi = order.length; index.set(name, mi); order.push(name); }
      primMat[i] = mi;
    }
    const tableNames = Object.keys(table);
    if (undefinedNames.size) {
      const names = [...undefinedNames];
      throw new NodeError(`${type}: prims use material${names.length > 1 ? 's' : ''} ${quoted(names)}, which the material table does not define`, `materials: ${tableNames.join(', ') || '(none)'}`);
    }
    if (unassigned) throw new NodeError(`${type}: ${unassigned} prim${unassigned > 1 ? 's have' : ' has'} no material`, 'give every baked prim one (material node; an empty group assigns all prims), or bake a group');
    // maps: only images the geometry carries can be read here
    const pool = referenceableImages(g);
    interface MapSet { color?: Image; rough?: Image; orm?: Image }
    const maps = new Map<string, MapSet>();
    const withNormal: string[] = [];
    for (const name of order) {
      const tx = table[name].textures ?? {};
      const found: MapSet = {};
      for (const [slot, label, key] of [['baseColor', 'base colour', 'color'], ['roughness', 'roughness', 'rough'], ['orm', 'occlusion-roughness-metallic', 'orm']] as const) {
        const path = tx[slot];
        if (!path) continue;
        const ref = imageRef(path);
        if (ref === null) throw new NodeError(`${type}: material "${name}" has its ${label} map in a file ("${path}"); bakes read only images the geometry carries`, 'load it with image_file and set the map to "image:<name>"');
        const im = pool.get(ref);
        if (!im) throw new NodeError(`${type}: material "${name}" uses image "${ref}" for its ${label}, which input 0 does not carry`, `images: ${[...pool.keys()].join(', ') || '(none)'}; load it with image_file and set the map to "image:<name>"`);
        found[key] = im;
      }
      if (found.color || found.rough || found.orm) maps.set(name, found);
      if (tx.normal) withNormal.push(name);
    }
    if (withNormal.length) ctx.warn(`${type}: material${withNormal.length > 1 ? 's' : ''} ${quoted(withNormal)} ${withNormal.length > 1 ? 'have' : 'has'} a normal map; its detail is not carried into the stack (tex_layers makes a new normal from the layers' height)`);
    // the maps read the mesh's "uv", the uv a material's maps use, whatever the bake is laid out with
    let mapUV: Float64Array | null = null;
    if (maps.size) {
      mapUV = p.uv_attrib && p.uv_attrib !== 'uv' ? readUVNamed(g, 'uv') : b.uv;
      if (!mapUV) throw new NodeError(`${type}: materials ${quoted([...maps.keys()])} have maps, which read the "uv" attribute that input 0 does not have`, `a bake with uv_attrib "${p.uv_attrib}" still reads the maps with "uv"; give the mesh its map uv there, or remove the maps`);
    }
    // kinds
    const asked = p.kinds && typeof p.kinds === 'object' && !Array.isArray(p.kinds) ? (p.kinds as Record<string, unknown>) : null;
    if (p.kinds && !asked) throw new NodeError(`${type}: kinds must be an object of material name → kind`, `e.g. {"zinc_steel": "galvanised"}; kinds: ${KIND_LIST}`);
    for (const k of Object.keys(asked ?? {})) {
      if (!table[k]) throw new NodeError(`${type}: kinds names material "${k}", which the material table does not define`, `materials: ${tableNames.join(', ') || '(none)'}`);
    }
    const kinds = order.map((name) => {
      const r = resolveKind(name, table[name], asked);
      if (r.unknown !== undefined) {
        const near = didYouMean(r.unknown, [...MATERIAL_KINDS], 1);
        throw new NodeError(`${type}: unknown kind "${r.unknown}" for material "${name}"`, `kinds: ${KIND_LIST}${near.length ? `; did you mean "${near[0]}"?` : ''}`);
      }
      return r.kind;
    });
    const kindsPresent = [...new Set(kinds.filter(Boolean))];
    // layer names an expression can read
    const taken = new Set<string>(), layerOf = order.map((name) => {
      const base = `mat_${identifier(name)}`;
      let nm = base, k = 2;
      while (taken.has(nm)) nm = `${base}_${k++}`;
      taken.add(nm);
      return nm;
    });
    const renamed = order.map((name, i) => [name, layerOf[i]] as const).filter(([name, l]) => l !== `mat_${name}`);
    if (renamed.length && (p.masks === 'all' || p.masks === 'materials')) ctx.warn(`${type}: layer names are identifiers an expression can read: ${renamed.slice(0, 6).map(([m, l]) => `material "${m}" is ${l}`).join(', ')}${renamed.length > 6 ? `, … ${renamed.length - 6} more` : ''}`);
    // uv that overlap: a texel two faces share holds the last one's values
    const ov = uvOverlapCheck(b.uv, b.tris, b.triPrim, new Int32Array(g.numPrims), { skip: skip ? (x, y) => !!(skip[x] || skip[y]) : undefined });
    if (ov.within + ov.across > 0) {
      const first = ov.firstWithin ?? ov.firstAcross!;
      ctx.warn(`${type}: the uv of ${ov.within + ov.across} pair${ov.within + ov.across > 1 ? 's' : ''} of triangles overlap (first: ${uvPairText(g, b.uv, b.tris, b.triPrim, first.t[0], first.t[1])}); a texel they share holds the last one's values: unwrap again or lay the islands out (uv_layout)`);
    }
    // per-sample values
    const n = b.s.n, S = b.s.S, nt = b.s.W * b.s.H;
    const C = new Float32Array(n * 4), R = new Float32Array(n), M = new Float32Array(n);
    const sampleMat = new Int32Array(n);
    const UV = mapUV ? interpolate(b.s, b.tris, mapUV, 2) : null;
    const tmp = new Float32Array(4);
    const read = (im: Image, i: number) => { const a = im.layer(im.mainLayer)!, ch = im.channels(im.mainLayer); sampleUV(a, ch, im.width, im.height, UV![i * 2], UV![i * 2 + 1], tmp, true); return ch; };
    for (let i = 0; i < n; i++) {
      const mi = primMat[b.triPrim[b.s.tri[i]]];
      sampleMat[i] = mi;
      const name = order[mi], m = table[name], mp = maps.get(name);
      let r = m.baseColor[0], gr = m.baseColor[1], bl = m.baseColor[2], al = m.alpha, rough = m.roughness, metal = m.metallic;
      if (mp) {
        if (mp.color) {
          if (read(mp.color, i) === 4) { r = tmp[0]; gr = tmp[1]; bl = tmp[2]; al = m.alpha * tmp[3]; } else { r = gr = bl = tmp[0]; }
        }
        if (mp.orm) {
          // glTF: the factors multiply the packed map (G roughness, B metallic); a grey map is one value for all three
          const ch = read(mp.orm, i);
          rough = (ch === 4 ? tmp[1] : tmp[0]) * m.roughness;
          metal = (ch === 4 ? tmp[2] : tmp[0]) * m.metallic;
        } else if (mp.rough) {
          rough = read(mp.rough, i) === 4 ? tmp[1] : tmp[0];
        }
      }
      C[i * 4] = r; C[i * 4 + 1] = gr; C[i * 4 + 2] = bl; C[i * 4 + 3] = al;
      R[i] = rough; M[i] = metal;
    }
    const P3 = vertexPositions(g);
    const { texel: texelLayer, island: islandLayer, first } = texelLayers(b, P3);
    const texMat = new Int32Array(nt).fill(-1);
    for (let i = 0; i < n; i++) if ((first ? first[b.s.texel[i]] : i) === i) texMat[b.s.texel[i]] = sampleMat[i];
    const { img, map } = finishImage(b, C, 4, [0, 0, 0, 1], {
      roughness: { vals: R, ch: 1, background: [0.5] },
      metallic: { vals: M, ch: 1, background: [0] },
      texel: texelLayer,
      island: islandLayer,
    });
    // the labels from one material index per texel, padded through the same map as every layer
    const labels: Record<string, Float32Array> = {};
    const matLayers = p.masks === 'all' || p.masks === 'materials' ? order.map((_, mi) => (labels[layerOf[mi]] = new Float32Array(nt))) : null;
    const kindLayers = p.masks === 'all' || p.masks === 'kinds' ? new Map(kindsPresent.map((k) => [k, (labels[`kind_${k}`] = new Float32Array(nt))])) : null;
    for (let k = 0; k < nt; k++) {
      const s = map[k];
      const mi = s >= 0 ? texMat[s] : -1;
      if (mi < 0) continue;
      if (matLayers) matLayers[mi][k] = 1;
      if (kindLayers && kinds[mi]) kindLayers.get(kinds[mi])![k] = 1;
    }
    // the mask layer stays last, as in every bake
    const coverage = img.layer('mask')!;
    img.layers.delete('mask');
    for (const [k, v] of Object.entries(labels)) img.set(k, v);
    img.set('mask', coverage);
    const texel = medianTexelSize(P3, b.uv, b.tris, b.s.W, b.s.H, skip);
    ctx.stat('materials', order.length);
    ctx.stat('size', texel * b.s.W);
    ctx.stat('texel_mm', texel * 1000);
    return wrapImage(b, img);
  },
});
