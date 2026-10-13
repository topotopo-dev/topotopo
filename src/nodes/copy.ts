// Scattering and instancing.
import { Attribute, AttribTable, GeoBuilder, Geometry, defaultValueFor } from '../core/geometry.ts';
import { EdgeSet } from '../core/edges.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { rng, rngState } from '../core/random.ts';
import { connectivity, primNormals, triangulate } from '../core/topology.ts';
import { composePackedXforms } from '../core/packed.ts';
import { TriBVH } from '../core/spatial.ts';
import { TriSurface, elementSeed } from '../core/pcg.ts';
import { minDistanceSelectWith, relaxOnSurface, relaxSpacing, relaxWeight, sampleEliminate, surfaceCandidates } from '../core/scatter.ts';
import { lookAtBasis, m4apply, m4applyDir, m4basis, m4euler, m4fromQuat, m4mul, m4normalMatrix, m4scale, m4translate, normalize, qAxisAngle, qFromMat, qMul, qNormalize } from '../core/math.ts';
import type { Mat4, Quat, Vec3 } from '../core/math.ts';
import { P, mask } from './util.ts';

// ---------------------------------------------------------------- scatter
// The sampling stages (candidates, sample elimination, exact minimum distance, relaxation) live in core/scatter.ts and
// run in chunks on the worker pool through ctx.parallelMap; sampleEliminate is re-exported for heightfield_scatter.
export { sampleEliminate };

/**
 * The surface-scatter result for the points keep[k] (triangle candT[c], barycentric weights candW[3c..3c+2], position
 * pos[3c..3c+2] for c = keep[k]): what GeoBuilder.build gives for points added with provenance {i: corners, w} plus the
 * N, sourceprim and sourceprimuv attributes (the scatter node's builder path without emitted vertex/prim attributes),
 * assembled in typed arrays. Source point attributes not in skip are interpolated (floats blended with the weights,
 * others from the heaviest corner), P follows them, then N, sourceprim and sourceprimuv; no prims, no groups.
 */
function scatterSurfaceGeo(
  g: Geometry, skip: Set<string>, keep: ArrayLike<number>, candT: Int32Array, candW: Float64Array, pos: Float64Array,
  tris: ArrayLike<number>, triPrim: ArrayLike<number>, fn: Float64Array, writeSourceprim: boolean, writePrimuv: boolean,
): Geometry {
  const n = keep.length, vp = g.vertexPoint;
  const corner = new Int32Array(n * 3), wt = new Float64Array(n * 3), dom = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const c = keep[k], t = candT[c];
    let best = -1, bw = -Infinity;
    for (let j = 0; j < 3; j++) {
      const q = vp[tris[t * 3 + j]], wj = candW[c * 3 + j];
      corner[k * 3 + j] = q; wt[k * 3 + j] = wj;
      if (wj > bw) { bw = wj; best = q; }
    }
    dom[k] = best;
  }
  const out = Geometry.blank();
  const pts = new AttribTable(n);
  for (const [name, a] of g.points.map) {
    if (skip.has(name) || name === 'P') continue;
    if (a.isArray) { pts.map.set(name, a.gather(dom)); continue; }
    const d = Attribute.create(a.type, a.size, n, a.def), sz = a.size;
    if (a.type === 'float') {
      const sd = a.data as Float64Array, dd = d.data as Float64Array;
      for (let k = 0; k < n; k++)
        for (let c = 0; c < sz; c++) {
          let acc = 0;
          for (let j = 0; j < 3; j++) acc += sd[corner[k * 3 + j] * sz + c] * wt[k * 3 + j];
          dd[k * sz + c] = acc;
        }
    } else if (a.type === 'string') {
      const sd = a.data as string[], dd = d.data as string[];
      for (let k = 0; k < n; k++) if (dom[k] >= 0) dd[k] = String(sd[dom[k]]);
    } else {
      const sd = a.data as Int32Array, dd = d.data as Int32Array, cnt = a.count;
      for (let k = 0; k < n; k++) {
        const j = dom[k];
        if (j < 0) continue;
        if (j < cnt) for (let c = 0; c < sz; c++) dd[k * sz + c] = sd[j * sz + c];
        else d.set(k, a.get(j));
      }
    }
    pts.map.set(name, d);
  }
  const P = pts.add('P', 'float', 3).data as Float64Array;
  for (let k = 0; k < n; k++) { const c = keep[k]; P[k * 3] = pos[c * 3]; P[k * 3 + 1] = pos[c * 3 + 1]; P[k * 3 + 2] = pos[c * 3 + 2]; }
  // N: the prim normal, or the point N interpolated and normalised
  const nA = g.points.get('N');
  const exN = pts.get('N');
  const NA = exN && exN.type === 'float' && exN.size === 3 ? exN : pts.add('N', 'float', 3, defaultValueFor('N', 3, 'float'));
  const Nd = NA.data as Float64Array;
  const ndat = nA && nA.size === 3 ? (nA.data as Float64Array) : null;
  for (let k = 0; k < n; k++) {
    const c = keep[k], pr = triPrim[candT[c]];
    if (ndat) {
      const w0 = candW[c * 3], w1 = candW[c * 3 + 1], w2 = candW[c * 3 + 2];
      const i0 = corner[k * 3], i1 = corner[k * 3 + 1], i2 = corner[k * 3 + 2];
      const x = w0 * ndat[i0 * 3] + w1 * ndat[i1 * 3] + w2 * ndat[i2 * 3];
      const y = w0 * ndat[i0 * 3 + 1] + w1 * ndat[i1 * 3 + 1] + w2 * ndat[i2 * 3 + 1];
      const z = w0 * ndat[i0 * 3 + 2] + w1 * ndat[i1 * 3 + 2] + w2 * ndat[i2 * 3 + 2];
      const l = Math.hypot(x, y, z);
      if (l > 1e-20) { Nd[k * 3] = x / l; Nd[k * 3 + 1] = y / l; Nd[k * 3 + 2] = z / l; } else { Nd[k * 3] = 0; Nd[k * 3 + 1] = 0; Nd[k * 3 + 2] = 0; }
    } else { Nd[k * 3] = fn[pr * 3]; Nd[k * 3 + 1] = fn[pr * 3 + 1]; Nd[k * 3 + 2] = fn[pr * 3 + 2]; }
  }
  if (writeSourceprim) {
    const ex = pts.get('sourceprim');
    const SA = ex && ex.type === 'int' && ex.size === 1 ? ex : pts.add('sourceprim', 'int', 1, defaultValueFor('sourceprim', 1, 'int'));
    const Sd = SA.data as Int32Array;
    for (let k = 0; k < n; k++) Sd[k] = triPrim[candT[keep[k]]];
  }
  if (writePrimuv) {
    const ex = pts.get('sourceprimuv');
    const UA = ex && ex.type === 'float' && ex.size === 3 ? ex : pts.add('sourceprimuv', 'float', 3, defaultValueFor('sourceprimuv', 3, 'float'));
    const Ud = UA.data as Float64Array;
    for (let k = 0; k < n; k++) {
      const c = keep[k], t = candT[c], pr = triPrim[t];
      let u = 0, v = 0;
      for (let j = 0; j < 3; j++) { const q = cornerPrimUV(g, tris[t * 3 + j], pr); u += candW[c * 3 + j] * q[0]; v += candW[c * 3 + j] * q[1]; }
      Ud[k * 3] = u; Ud[k * 3 + 1] = v; Ud[k * 3 + 2] = 0;
    }
  }
  out.points = pts;
  out.vertices = g.vertices.gather(new Int32Array(0));
  out.prims = g.prims.gather(new Int32Array(0));
  out.detail = g.detail.clone();
  out.primStart = new Int32Array(1);
  out.vertexPoint = new Int32Array(0);
  out.primClosed = new Uint8Array(0);
  out.pointGroups = new Map();
  out.primGroups = new Map();
  out.vertexGroups = new Map();
  out.edgeGroups = new Map();
  out.volumes = g.volumes.slice();
  return out;
}

/** Most points one scatter may make (guards against runaway densities). */
const MAX_SCATTER = 10_000_000;

/** A numeric point, vertex or prim attribute (looked up in that order) read per triangle corner / segment end. */
type CornerReader = (v: number, pt: number, pr: number) => number;

function cornerReader(g: Geometry, name: string, param: string): CornerReader | null {
  if (!name) return null;
  const ok = (a: Attribute | undefined): a is Attribute => !!a && a.type !== 'string' && !a.isArray;
  const pa = g.points.get(name), va = g.vertices.get(name), ra = g.prims.get(name);
  if (ok(pa)) { const d = pa.data as Float64Array, s = pa.size; return (_v, pt) => d[pt * s]; }
  if (ok(va)) { const d = va.data as Float64Array, s = va.size; return (v) => d[v * s]; }
  if (ok(ra)) { const d = ra.data as Float64Array, s = ra.size; return (_v, _pt, pr) => d[pr * s]; }
  const list = (t: AttribTable) => t.names().filter((n) => ok(t.get(n))).join(', ') || 'none';
  throw new NodeError(`${param} "${name}" is not a numeric point, vertex or prim attribute`, `point: ${list(g.points)} · vertex: ${list(g.vertices)} · prim: ${list(g.prims)}`);
}

/**
 * Attribute name pattern: globs separated by spaces or commas, "^glob" excludes ("" matches nothing, "*" everything;
 * only exclusions = everything else).
 */
export function namePattern(pattern: string): (name: string) => boolean {
  const toks = String(pattern ?? '').split(/[\s,]+/).filter(Boolean);
  const re = (s: string) => new RegExp('^' + s.replace(/[.+?${}()|[\]\\^]/g, '\\$&').replace(/\*/g, '.*') + '$');
  const inc = toks.filter((t) => !t.startsWith('^')).map(re), exc = toks.filter((t) => t.startsWith('^')).map((t) => re(t.slice(1)));
  const all = !inc.length && exc.length > 0;
  return (n) => (all || inc.some((r) => r.test(n))) && !exc.some((r) => r.test(n));
}

/** Prim uv of corner vertex v of prim pr (the SurfaceQuery convention: triangle barycentrics, quad bilinear corners, n-gon polar). */
function cornerPrimUV(g: Geometry, v: number, pr: number): [number, number] {
  const s = g.primStart[pr], n = g.primStart[pr + 1] - s, c = v - s;
  if (n === 3) return [c === 1 ? 1 : 0, c === 2 ? 1 : 0];
  if (n === 4) return [c === 1 || c === 2 ? 1 : 0, c >= 2 ? 1 : 0];
  const a = (2 * Math.PI * c) / n;
  return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)];
}

/** Points to make: count, or density × density_scale × measure (see the generate_by param). */
function scatterCount(p: Record<string, any>, weighted: number, autoMeasure: number, warn: (m: string) => void): number {
  let n: number;
  if (p.generate_by === 'count' || (p.generate_by === 'auto' && !(p.density > 0))) n = p.count;
  else {
    n = Math.round(p.density * p.density_scale * (p.generate_by === 'density' ? weighted : autoMeasure));
    if (p.generate_by === 'density' && !(p.density > 0)) warn('generate_by "density" with density 0 makes no points: set density (points per square metre)');
  }
  if (!(n >= 0)) n = 0;
  if (n > MAX_SCATTER) throw new NodeError(`scatter: ${n.toLocaleString('en-US')} points is too many (max ${MAX_SCATTER.toLocaleString('en-US')}); lower count, density or density_scale`);
  return n;
}

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);

defineNode({
  type: 'scatter',
  category: 'copy',
  summary: 'Scatter points on surfaces (area-weighted, blue-noise spacing; by count or per m²; density attribute and 0..1 mask; relaxation; exact minimum distance), along curves, or inside volumes.',
  description:
    'Houdini: Scatter (Scatter and Align). Unreal PCG: Surface Sampler (Spline Sampler for curves, Volume Sampler). ' +
    'generate_by: count = exactly count points; density = density × density_scale points per square metre (per metre on curves, ' +
    'per cubic metre in volumes) of area × weight; auto = density when density > 0, else count (there, for compatibility, density_attrib ' +
    'only redistributes the points while density_mask still scales the total). Weight per point = density_attrib (≥ 0, point, vertex or ' +
    'prim attribute, Houdini\'s density attribute) × density_mask (clamped 0..1, e.g. the "mask" of the mask node). relax: blue-noise ' +
    'spacing by weighted sample elimination (5 candidates per point) whose radii follow the weights (auto mode with only density_attrib ' +
    'keeps the legacy uniform radius, which evens the density out). relax_iterations: Lloyd-style point relaxation afterwards (surface ' +
    'mode): points push apart to the spacing of the local density (relax_radius to fix it) and are projected back onto the surface ' +
    'through a BVH; points that end where the weight is 0 are dropped. min_distance: exact minimum distance between points (dart ' +
    'throwing over the candidates; fewer than count points when the surface is full). max_per_prim: at most that many points per source ' +
    'prim. emit_attributes: which source attributes the points carry (point and vertex attributes interpolated, prim attributes copied; ' +
    '"^name" excludes). Packed input is unpacked first. Chain: mask → scatter → orient → prune → copy_to_points (help topic "pcg").',
  aliases: ['scatter_points', 'distribute'],
  inputs: [{ name: 'geo', desc: 'surface, curves, or closed mesh (volume mode)' }],
  params: {
    count: { type: 'int', default: 500, min: 0, desc: 'number of points', aliases: ['npts', 'points', 'num'] },
    density: { type: 'float', default: 0, min: 0, desc: 'points per unit area/length/volume (overrides count when > 0)' },
    mode: { type: 'enum', options: ['auto', 'surface', 'curve', 'volume'], default: 'auto', desc: 'auto = surface if polygons, curve if only polylines' },
    relax: { type: 'bool', default: true, desc: 'even (blue-noise) spacing via sample elimination' },
    density_attrib: { type: 'string', default: '', desc: 'point, vertex or prim float attribute (≥ 0) scaling the local density (e.g. a noise mask; 2 = twice as many points as 1)', aliases: ['densityattrib', 'density_attribute'] },
    seed: P.seed(),
    group: P.group('prim'),
    keep_attribs: { type: 'bool', default: true, desc: 'carry source attributes onto the scattered points (see emit_attributes)' },
    generate_by: { type: 'enum', options: ['auto', 'count', 'density'], default: 'auto', desc: 'count = exactly count points; density = density × density_scale points per m² of area × weight; auto = density when density > 0, else count', aliases: ['generateby', 'count_mode', 'method'] },
    density_mask: { type: 'string', default: '', desc: 'point, vertex or prim attribute 0..1 multiplying the density (e.g. "mask" from the mask node)', aliases: ['mask', 'mask_attrib', 'density_mask_attrib'] },
    density_scale: { type: 'float', default: 1, min: 0, desc: 'multiplies density (density and auto modes)', aliases: ['densityscale'] },
    relax_iterations: { type: 'int', default: 0, min: 0, max: 100, desc: 'surface: Lloyd-style relaxation passes (points push apart and are projected back onto the surface)', aliases: ['relaxiterations', 'relax_iter', 'relax_passes'] },
    relax_radius: { type: 'float', default: 0, min: 0, desc: 'relaxation spacing in metres (0 = from the local density)' },
    min_distance: { type: 'float', default: 0, min: 0, desc: 'exact minimum distance between points (0 = off); the count can come out lower', aliases: ['mindist', 'min_dist', 'poisson_radius'] },
    max_per_prim: { type: 'int', default: 0, min: 0, desc: 'at most this many points per source prim (0 = no limit)', aliases: ['maxperprim'] },
    emit_attributes: { type: 'string', default: '*', desc: 'source attributes carried onto the points (pattern: point/vertex interpolated, prim copied; "^Cd" excludes)', aliases: ['attributes', 'interpolate', 'emit'] },
    write_sourceprim: { type: 'bool', default: true, desc: 'write int sourceprim (the source prim of each point)', aliases: ['source_prim', 'sourceprim'] },
    write_primuv: { type: 'bool', default: false, desc: 'write sourceprimuv (prim uv of the point on its source prim, Houdini primuv convention)', aliases: ['prim_uv', 'sourceprimuv'] },
    write_seed: { type: 'bool', default: false, desc: 'write int seed per point (PCG $Seed; a hash of seed and the point number)', aliases: ['seed_attrib', 'pcg_seed'] },
  },
  outputs: 'point N (surface normal), sourceprim; optional sourceprimuv, seed; source attributes (emit_attributes)',
  example: {
    nodes: {
      ground: { type: 'grid', params: { size: [20, 20], divisions: [40, 40] } },
      m: { type: 'mask', in: ['ground'], params: { by: 'noise', min: 0.5, max: 1, falloff: 0.1 } },
      pts: { type: 'scatter', in: ['m'], params: { generate_by: 'density', density: 2, density_mask: 'mask', min_distance: 0.3 } },
    },
    output: 'pts',
  },
  cook: async ({ input, p, warn, parallelMap }) => {
    const g = input(0);
    const r = rng(p.seed + 0.5);
    const sel = mask(g, 'prim', p.group);
    let hasPoly = false, hasLine = false;
    for (let pr = 0; pr < g.numPrims; pr++) if (!sel || sel[pr]) { if (g.primClosed[pr]) hasPoly = true; else hasLine = true; }
    const mode = p.mode === 'auto' ? (hasPoly ? 'surface' : hasLine ? 'curve' : 'volume') : p.mode;
    const dA = cornerReader(g, p.density_attrib, 'density_attrib');
    const mA = cornerReader(g, p.density_mask, 'density_mask');
    const weighted = !!(dA || mA);
    const dw = (v: number, pt: number, pr: number) => (dA ? Math.max(0, dA(v, pt, pr)) : 1) * (mA ? clamp01(mA(v, pt, pr)) : 1);
    const mw = (v: number, pt: number, pr: number) => (mA ? clamp01(mA(v, pt, pr)) : 1);
    const md = Math.max(0, p.min_distance || 0), cap = Math.max(0, Math.floor(p.max_per_prim || 0));
    const extra = md > 0 || cap > 0;
    const emitOk = namePattern(p.emit_attributes);
    const b = new GeoBuilder(g);
    if (!p.keep_attribs) for (const n of g.points.names()) b.skip.point.add(n);
    else for (const n of g.points.names()) if (n !== 'P' && !emitOk(n)) b.skip.point.add(n);
    b.skip.point.add('N');
    b.keepSrcGroups = false;
    const Nout = b.attrib('point', 'N', 3);
    const sp = p.write_sourceprim ? b.attrib('point', 'sourceprim', 1, 'int') : null;
    const puv = p.write_primuv ? b.attrib('point', 'sourceprimuv', 3) : null;
    // vertex and prim attributes carried onto the points (point attributes travel through the builder's provenance)
    const reserved = new Set(['P', 'N', 'sourceprim', 'sourceprimuv', 'seed']);
    const emits: { name: string; cls: 'vertex' | 'prim'; a: Attribute; out: ReturnType<GeoBuilder['attrib']> }[] = [];
    if (p.keep_attribs)
      for (const cls of ['vertex', 'prim'] as const)
        for (const name of g.table(cls).names()) {
          if (reserved.has(name) || g.points.has(name) || emits.some((e) => e.name === name) || !emitOk(name)) continue;
          const a = g.table(cls).get(name)!;
          emits.push({ name, cls, a, out: b.attrib('point', name, a.size, a.type, a.def) });
        }
    const emitAt = (id: number, verts: number[], w: number[], pr: number) => {
      for (const e of emits) {
        const a = e.a;
        if (e.cls === 'prim') { e.out.set(id, a.isArray ? a.getArray(pr) : a.get(pr)); continue; }
        if (a.type === 'float' && !a.isArray) {
          const s = a.size, d = a.data as Float64Array;
          const v = new Array(s).fill(0);
          for (let k = 0; k < verts.length; k++) for (let c = 0; c < s; c++) v[c] += d[verts[k] * s + c] * w[k];
          e.out.set(id, s === 1 ? v[0] : v);
        } else {
          let best = 0;
          for (let k = 1; k < verts.length; k++) if (w[k] > w[best]) best = k;
          e.out.set(id, a.isArray ? a.getArray(verts[best]) : a.get(verts[best]));
        }
      }
    };
    const finish = (built?: Geometry): Geometry => {
      const out = built ?? b.build();
      for (const e of emits) { out.vertices.delete(e.name); out.prims.delete(e.name); }
      if (p.write_seed) { const s = out.points.add('seed', 'int', 1).data as Int32Array; for (let i = 0; i < s.length; i++) s[i] = elementSeed(p.seed, i); }
      return out;
    };
    const Pd = g.P, vp = g.vertexPoint;

    if (mode === 'surface') {
      if (!hasPoly) throw new NodeError('no polygons to scatter on (use mode=curve for polylines or volume for a bounding box)');
      const { tris, triPrim } = triangulate(g, sel);
      const nt = tris.length / 3;
      const cdf = new Float64Array(nt);
      let total = 0, area = 0, maskedArea = 0;
      for (let t = 0; t < nt; t++) {
        const va = tris[t * 3], vb = tris[t * 3 + 1], vc = tris[t * 3 + 2], pr = triPrim[t];
        const a = vp[va], bb = vp[vb], c = vp[vc];
        const ux = Pd[bb * 3] - Pd[a * 3], uy = Pd[bb * 3 + 1] - Pd[a * 3 + 1], uz = Pd[bb * 3 + 2] - Pd[a * 3 + 2];
        const vx = Pd[c * 3] - Pd[a * 3], vy = Pd[c * 3 + 1] - Pd[a * 3 + 1], vz = Pd[c * 3 + 2] - Pd[a * 3 + 2];
        const ar = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        area += ar;
        total += ar * (dw(va, a, pr) + dw(vb, bb, pr) + dw(vc, c, pr)) / 3;
        if (mA) maskedArea += ar * (mw(va, a, pr) + mw(vb, bb, pr) + mw(vc, c, pr)) / 3;
        cdf[t] = total;
      }
      if (!(total > 0)) {
        if (mA && area > 0) { warn(`density_mask "${p.density_mask}" is 0 everywhere: no points`); return finish(); }
        throw new NodeError('zero scatter area (or density attribute is 0 everywhere)');
      }
      const count = scatterCount(p, total, mA ? maskedArea : area, warn);
      const ncand = p.relax || extra ? count * 5 : count;
      const fn = primNormals(g);
      // candidates: triangle, barycentric weights and position, in typed arrays (in chunks on the pool; candidate k
      // takes draws 3k+1..3k+3 of the node's generator, as the serial loop did)
      const tp = new Int32Array(nt * 3);
      for (let k = 0; k < nt * 3; k++) tp[k] = vp[tris[k]];
      const { candT, candW, pos } = await surfaceCandidates(Pd, tp, cdf, ncand, rngState(p.seed + 0.5), parallelMap);
      // weight at a point of triangle t (barycentrics w)
      const wAt = (t: number, w: ArrayLike<number>, o = 0) => {
        let s = 0;
        for (let j = 0; j < 3; j++) { const v = tris[t * 3 + j]; s += w[o + j] * dw(v, vp[v], triPrim[t]); }
        return s;
      };
      const wMean = total / area;
      // spacing that follows the weights (sqrt(mean / local) of the uniform spacing); the legacy auto mode with only
      // density_attrib keeps uniform radii, which even the density out
      const adaptive = weighted && (!!mA || p.generate_by !== 'auto');
      let rscale: Float64Array | undefined;
      if (adaptive && p.relax && count > 0) {
        rscale = new Float64Array(ncand);
        for (let k = 0; k < ncand; k++) { const wl = wAt(candT[k], candW, k * 3); rscale[k] = wl > 0 ? Math.min(4, Math.max(0.25, Math.sqrt(wMean / wl))) : 4; }
      }
      let keep = p.relax && count > 0
        ? await sampleEliminate(pos, count, Math.sqrt(area / (2 * Math.sqrt(3) * count)), rscale, parallelMap)
        : Int32Array.from({ length: ncand }, (_, i) => i);
      const perPrim = cap > 0 ? new Int32Array(g.numPrims) : null;
      if (extra) {
        // the well-spaced selection first, the other candidates as refill; exact distance test and per-prim cap
        const inKeep = new Uint8Array(ncand), order = new Int32Array(ncand);
        let o = 0;
        for (const k of keep) { inKeep[k] = 1; order[o++] = k; }
        for (let k = 0; k < ncand; k++) if (!inKeep[k]) order[o++] = k;
        keep = (await minDistanceSelectWith(pos, order, md, count,
          perPrim ? (k) => perPrim[triPrim[candT[k]]] < cap : undefined,
          perPrim ? (k) => { perPrim[triPrim[candT[k]]]++; } : undefined, parallelMap)).sort();
      }
      // the chosen candidates, as indices into the candidate arrays
      let outKeep: ArrayLike<number> = keep, outT = candT, outW = candW, outPos = pos;
      if (p.relax_iterations > 0 && keep.length > 1) {
        // the kept points become arrays of their own (triangle, barycentrics, position), relaxed in place
        const n = keep.length;
        const RT = new Int32Array(n), RW = new Float64Array(n * 3), RP = new Float64Array(n * 3);
        for (let i = 0; i < n; i++) {
          const k = keep[i];
          RT[i] = candT[k];
          RW[i * 3] = candW[k * 3]; RW[i * 3 + 1] = candW[k * 3 + 1]; RW[i * 3 + 2] = candW[k * 3 + 2];
          RP[i * 3] = pos[k * 3]; RP[i * 3 + 1] = pos[k * 3 + 1]; RP[i * 3 + 2] = pos[k * 3 + 2];
        }
        // the weight at each triangle corner, for the spacing that follows the density
        let cw: Float64Array | null = null;
        if (weighted) {
          cw = new Float64Array(nt * 3);
          for (let t = 0; t < nt; t++) for (let j = 0; j < 3; j++) { const v = tris[t * 3 + j]; cw[t * 3 + j] = dw(v, vp[v], triPrim[t]); }
        }
        const base = { radius: p.relax_radius, weighted, dBar: Math.sqrt((2 * area) / (Math.sqrt(3) * n)), wMean };
        const spacing = new Float64Array(n);
        for (let i = 0; i < n; i++) spacing[i] = relaxSpacing({ ...base, smax: 0 }, cw, RT[i], RW[i * 3], RW[i * 3 + 1], RW[i * 3 + 2]);
        await relaxOnSurface(new TriSurface(g, tris), RP, spacing, RT, RW, p.relax_iterations, base, cw, parallelMap);
        // points relaxed into zero-density areas go; the distance and per-prim limits are enforced again
        let order: Int32Array = Int32Array.from({ length: n }, (_, i) => i);
        if (cw) order = order.filter((i) => relaxWeight(cw, RT[i], RW[i * 3], RW[i * 3 + 1], RW[i * 3 + 2]) > 0);
        if (extra) {
          if (perPrim) perPrim.fill(0);
          order = (await minDistanceSelectWith(RP, order, md, Infinity,
            perPrim ? (i) => perPrim[triPrim[RT[i]]] < cap : undefined,
            perPrim ? (i) => { perPrim[triPrim[RT[i]]]++; } : undefined, parallelMap)).sort();
        }
        outKeep = order; outT = RT; outW = RW; outPos = RP;
      }
      // no emitted vertex/prim attributes: assemble the result directly (what the builder path below gives)
      if (!emits.length) return finish(scatterSurfaceGeo(g, b.skip.point, outKeep, outT, outW, outPos, tris, triPrim, fn, !!sp, !!puv));
      const nA = g.points.get('N');
      for (let o = 0; o < outKeep.length; o++) {
        const k = outKeep[o];
        const c = { t: outT[k], w: [outW[k * 3], outW[k * 3 + 1], outW[k * 3 + 2]], pos: [outPos[k * 3], outPos[k * 3 + 1], outPos[k * 3 + 2]] };
        const verts = [tris[c.t * 3], tris[c.t * 3 + 1], tris[c.t * 3 + 2]];
        const ids = verts.map((v) => vp[v]);
        const id = b.addPoint(c.pos[0], c.pos[1], c.pos[2], { i: ids, w: c.w });
        const pr = triPrim[c.t];
        let n: number[] = [fn[pr * 3], fn[pr * 3 + 1], fn[pr * 3 + 2]];
        if (nA && nA.size === 3) {
          const d = nA.data as Float64Array;
          n = normalize([0, 1, 2].map((cc) => c.w[0] * d[ids[0] * 3 + cc] + c.w[1] * d[ids[1] * 3 + cc] + c.w[2] * d[ids[2] * 3 + cc]) as Vec3);
        }
        Nout.set(id, n);
        if (sp) sp.set(id, pr);
        if (puv) {
          let u = 0, v = 0;
          for (let j = 0; j < 3; j++) { const q = cornerPrimUV(g, verts[j], pr); u += c.w[j] * q[0]; v += c.w[j] * q[1]; }
          puv.set(id, [u, v, 0]);
        }
        if (emits.length) emitAt(id, verts, c.w, pr);
      }
      return finish();
    }

    if (mode === 'curve') {
      const segs: { a: number; b: number; va: number; vb: number; pr: number; len: number; u0: number; u1: number }[] = [];
      let total = 0;
      for (let pr = 0; pr < g.numPrims; pr++) {
        if (sel && !sel[pr]) continue;
        const s = g.primStart[pr], e = g.primStart[pr + 1];
        const last = g.primClosed[pr] ? e : e - 1;
        const nseg = Math.max(1, last - s);
        for (let v = s; v < last; v++) {
          const vb = v + 1 < e ? v + 1 : s;
          const a = vp[v], bb = vp[vb];
          const len = Math.hypot(Pd[bb * 3] - Pd[a * 3], Pd[bb * 3 + 1] - Pd[a * 3 + 1], Pd[bb * 3 + 2] - Pd[a * 3 + 2]) * (dw(v, a, pr) + dw(vb, bb, pr)) / 2;
          total += len;
          segs.push({ a, b: bb, va: v, vb, pr, len: total, u0: (v - s) / nseg, u1: (v - s + 1) / nseg });
        }
      }
      if (!segs.length || !(total > 0)) {
        if (mA && segs.length) { warn(`density_mask "${p.density_mask}" is 0 everywhere: no points`); return finish(); }
        throw new NodeError('no curve length to scatter along');
      }
      const count = scatterCount(p, total, total, warn);
      const picks: { sg: number; f: number }[] = [];
      const pos = new Float64Array(count * 3);
      for (let k = 0; k < count; k++) {
        const x = p.relax ? ((k + 0.5) / count) * total : r() * total;
        let lo = 0, hi = segs.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (segs[mid].len < x) lo = mid + 1; else hi = mid; }
        const sg = segs[lo], prev = lo ? segs[lo - 1].len : 0;
        const f = sg.len > prev ? (x - prev) / (sg.len - prev) : 0;
        picks.push({ sg: lo, f });
        for (let c = 0; c < 3; c++) pos[k * 3 + c] = Pd[sg.a * 3 + c] * (1 - f) + Pd[sg.b * 3 + c] * f;
      }
      let order: ArrayLike<number> = Int32Array.from({ length: count }, (_, i) => i);
      if (extra) {
        const perPrim = cap > 0 ? new Int32Array(g.numPrims) : null;
        order = await minDistanceSelectWith(pos, order, md, Infinity,
          perPrim ? (k) => perPrim[segs[picks[k].sg].pr] < cap : undefined,
          perPrim ? (k) => { perPrim[segs[picks[k].sg].pr]++; } : undefined, parallelMap);
      }
      for (let o = 0; o < order.length; o++) {
        const { sg: si, f } = picks[order[o]], sg = segs[si];
        const id = b.blendPoint([sg.a, sg.b], [1 - f, f]);
        Nout.set(id, normalize([Pd[sg.b * 3] - Pd[sg.a * 3], Pd[sg.b * 3 + 1] - Pd[sg.a * 3 + 1], Pd[sg.b * 3 + 2] - Pd[sg.a * 3 + 2]]));
        if (sp) sp.set(id, sg.pr);
        if (puv) puv.set(id, [sg.u0 + (sg.u1 - sg.u0) * f, 0, 0]);
        if (emits.length) emitAt(id, [sg.va, sg.vb], [1 - f, f], sg.pr);
      }
      return finish();
    }

    // volume
    const bb = g.bbox();
    const ext = [0, 1, 2].map((a) => bb.max[a] - bb.min[a]);
    const closed = hasPoly ? new TriBVH(g) : null;
    const vol = Math.max(1e-12, ext[0] * ext[1] * ext[2]);
    const count = scatterCount(p, vol, vol, warn);
    const ncand = p.relax || md > 0 ? count * 5 : count;
    const pos: number[] = [];
    let tries = 0;
    while (pos.length / 3 < ncand && tries++ < ncand * 200) {
      const q = [bb.min[0] + r() * ext[0], bb.min[1] + r() * ext[1], bb.min[2] + r() * ext[2]];
      if (closed && !closed.inside(q[0], q[1], q[2])) continue;
      pos.push(q[0], q[1], q[2]);
    }
    const P0 = Float64Array.from(pos);
    const nc = P0.length / 3;
    let keep = p.relax && count > 0 && nc > count
      ? await sampleEliminate(P0, count, Math.cbrt(vol / count) * 0.6, undefined, parallelMap)
      : Int32Array.from({ length: Math.min(nc, count) }, (_, i) => i);
    if (md > 0) {
      const inKeep = new Uint8Array(nc), order = new Int32Array(nc);
      let o = 0;
      for (const k of keep) { inKeep[k] = 1; order[o++] = k; }
      for (let k = 0; k < nc; k++) if (!inKeep[k]) order[o++] = k;
      keep = (await minDistanceSelectWith(P0, order, md, count, undefined, undefined, parallelMap)).sort();
    }
    const out = new Geometry({ positions: Array.from(keep).flatMap((k) => [P0[k * 3], P0[k * 3 + 1], P0[k * 3 + 2]]) });
    if (p.write_seed) { const s = out.points.add('seed', 'int', 1).data as Int32Array; for (let i = 0; i < s.length; i++) s[i] = elementSeed(p.seed, i); }
    return out;
  },
});

// ---------------------------------------------------------------- copy to points

const XFORM_ATTRIBS = new Set(['P', 'N', 'v', 'up', 'orient', 'pscale', 'scale', 'rot', 'trans', 'pivot', 'transform', 'Alpha', 'sourceprim', 'variant']);

/**
 * Template points with copy_to_points' scale_attrib / rotate_attrib folded into the standard attributes, so packed and
 * real copies share one transform path: scale ← scale × factor (float = uniform, vec3 per axis), rot ← rot · extra
 * (float = yaw degrees about +Y, vec3 = Euler XYZ degrees, vec4 = quaternion).
 */
function foldExtraXforms(t: Geometry, scaleAttrib: string, rotateAttrib: string): Geometry {
  const numeric = (name: string, what: string) => {
    const a = t.points.get(name);
    if (!a || a.type === 'string' || a.isArray) throw new NodeError(`${what} "${name}" is not a numeric point attribute of the template points`, `point attributes: ${t.points.names().join(', ') || 'none'}`);
    return a;
  };
  const sA = scaleAttrib ? numeric(scaleAttrib, 'scale_attrib') : null;
  const rA = rotateAttrib ? numeric(rotateAttrib, 'rotate_attrib') : null;
  const g = t.clone();
  const n = g.numPoints;
  if (sA) {
    const sc = g.points.add('scale', 'float', 3).data as Float64Array, d = sA.data as Float64Array, s = sA.size;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) sc[i * 3 + c] *= s >= 3 ? d[i * s + c] : d[i * s];
  }
  if (rA) {
    const rot = g.points.add('rot', 'float', 4).data as Float64Array, d = rA.data as Float64Array, s = rA.size;
    for (let i = 0; i < n; i++) {
      let e: Quat;
      if (s === 4) e = qNormalize([d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]]);
      else if (s === 3) e = qFromMat(m4euler([d[i * 3], d[i * 3 + 1], d[i * 3 + 2]]));
      else e = qAxisAngle([0, 1, 0], d[i * s]);
      const q = qMul([rot[i * 4], rot[i * 4 + 1], rot[i * 4 + 2], rot[i * 4 + 3]], e);
      rot.set(q, i * 4);
    }
  }
  return g;
}

/** Instance transform for template point i (Houdini attribute conventions). */
export function pointTransform(t: Geometry, i: number): Mat4 {
  const Pd = t.P;
  const get = (n: string) => t.points.get(n);
  const pos: Vec3 = [Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2]];
  const tr = get('trans');
  if (tr && tr.size === 3) { const v = tr.get(i) as number[]; pos[0] += v[0]; pos[1] += v[1]; pos[2] += v[2]; }
  let R: Mat4;
  const o = get('orient');
  if (o && o.size === 4) R = m4fromQuat(o.get(i) as any);
  else {
    const N = get('N') ?? get('v');
    const up = get('up');
    if (N && N.size === 3) {
      const d = N.get(i) as number[];
      R = Math.hypot(d[0], d[1], d[2]) > 1e-12 ? lookAtBasis(d as Vec3, up && up.size === 3 ? (up.get(i) as Vec3) : [0, 1, 0]) : m4scale(1, 1, 1);
    } else R = m4scale(1, 1, 1);
  }
  const rot = get('rot');
  if (rot && rot.size === 4) R = m4mul(R, m4fromQuat(rot.get(i) as any));
  const ps = get('pscale'), sc = get('scale');
  const s = ps ? (ps.get(i) as number) : 1;
  const sv = sc && sc.size === 3 ? (sc.get(i) as number[]) : [1, 1, 1];
  let M = m4mul(m4translate(pos[0], pos[1], pos[2]), m4mul(R, m4scale(s * sv[0], s * sv[1], s * sv[2])));
  const pv = get('pivot');
  if (pv && pv.size === 3) { const v = pv.get(i) as number[]; M = m4mul(M, m4translate(-v[0], -v[1], -v[2])); }
  return M;
}

/**
 * pointTransform + m4normalMatrix for many template points without allocating: xf(i) fills xf.M and xf.Nm with the
 * values pointTransform(t, i) and m4normalMatrix of it would return, by the same arithmetic in the same order (the
 * products with the identity's zeros and ones included, so signed zeros match too). Returns null when an attribute
 * pointTransform would read is not a plain numeric tuple (string, array, a pscale that is not a scalar); callers then
 * use pointTransform.
 */
function pointXformer(t: Geometry): ({ (i: number): void; M: Float64Array; Nm: Float64Array }) | null {
  const get = (n: string) => t.points.get(n);
  const numeric = (a: Attribute | undefined | null) => !!a && a.type !== 'string' && !a.isArray;
  const Pd = t.P;
  const trA = get('trans'), oA = get('orient'), NA = get('N') ?? get('v'), upA = get('up'), rotA = get('rot'), psA = get('pscale'), scA = get('scale'), pvA = get('pivot');
  const tr = trA && trA.size === 3 ? trA : null, orient = oA && oA.size === 4 ? oA : null;
  const N = !orient && NA && NA.size === 3 ? NA : null, up = N && upA && upA.size === 3 ? upA : null;
  const rot = rotA && rotA.size === 4 ? rotA : null, sc = scA && scA.size === 3 ? scA : null, pv = pvA && pvA.size === 3 ? pvA : null;
  for (const a of [tr, orient, N, up, rot, sc, pv]) if (a && !numeric(a)) return null;
  if (psA && (!numeric(psA) || psA.size !== 1)) return null;
  const trD = tr?.data as Float64Array, oD = orient?.data as Float64Array, nD = N?.data as Float64Array, upD = up?.data as Float64Array;
  const rotD = rot?.data as Float64Array, psD = psA?.data as Float64Array, scD = sc?.data as Float64Array, pvD = pv?.data as Float64Array;
  let R = new Float64Array(16), R2 = new Float64Array(16), M = new Float64Array(16), M2 = new Float64Array(16);
  const Q = new Float64Array(16), S = new Float64Array(16), RS = new Float64Array(16), T = new Float64Array(16), inv = new Float64Array(16);
  const Nm = new Float64Array(16);
  const identity = (m: Float64Array) => { m.fill(0); m[0] = m[5] = m[10] = m[15] = 1; };
  // m4mul(a, b) into o (o is neither a nor b)
  const mul = (a: Float64Array, b: Float64Array, o: Float64Array) => {
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++)
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  };
  // m4fromQuat
  const quat = (d: Float64Array, o: number, m: Float64Array) => {
    const x = d[o], y = d[o + 1], z = d[o + 2], w = d[o + 3];
    identity(m);
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w);
    m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w);
    m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y);
  };
  // lookAtBasis(dir, up)
  const lookAt = (d0: number, d1: number, d2: number, u0: number, u1: number, u2: number, m: Float64Array) => {
    const l = Math.hypot(d0, d1, d2);
    let z0 = 0, z1 = 0, z2 = 0;
    if (l > 1e-20) { z0 = d0 / l; z1 = d1 / l; z2 = d2 / l; }
    identity(m);
    if (Math.hypot(z0, z1, z2) === 0) return;
    let x0 = u1 * z2 - u2 * z1, x1 = u2 * z0 - u0 * z2, x2 = u0 * z1 - u1 * z0;
    if (Math.hypot(x0, x1, x2) < 1e-8) {
      const a0 = Math.abs(z1) < 0.9 ? 0 : 1, a1 = Math.abs(z1) < 0.9 ? 1 : 0, a2 = 0;
      x0 = a1 * z2 - a2 * z1; x1 = a2 * z0 - a0 * z2; x2 = a0 * z1 - a1 * z0;
    }
    const xl = Math.hypot(x0, x1, x2);
    if (xl > 1e-20) { x0 = x0 / xl; x1 = x1 / xl; x2 = x2 / xl; } else { x0 = 0; x1 = 0; x2 = 0; }
    m[0] = x0; m[1] = x1; m[2] = x2;
    m[4] = z1 * x2 - z2 * x1; m[5] = z2 * x0 - z0 * x2; m[6] = z0 * x1 - z1 * x0;
    m[8] = z0; m[9] = z1; m[10] = z2;
    m[12] = 0; m[13] = 0; m[14] = 0;
  };
  const xf = (i: number) => {
    let px = Pd[i * 3], py = Pd[i * 3 + 1], pz = Pd[i * 3 + 2];
    if (tr) { px += trD[i * 3]; py += trD[i * 3 + 1]; pz += trD[i * 3 + 2]; }
    if (orient) quat(oD, i * 4, R);
    else if (N) {
      const d0 = nD[i * 3], d1 = nD[i * 3 + 1], d2 = nD[i * 3 + 2];
      if (Math.hypot(d0, d1, d2) > 1e-12) lookAt(d0, d1, d2, up ? upD[i * 3] : 0, up ? upD[i * 3 + 1] : 1, up ? upD[i * 3 + 2] : 0, R);
      else identity(R);
    } else identity(R);
    if (rot) { quat(rotD, i * 4, Q); mul(R, Q, R2); const sw = R; R = R2; R2 = sw; }
    const s = psA ? psD[i] : 1;
    identity(S);
    S[0] = s * (sc ? scD[i * 3] : 1); S[5] = s * (sc ? scD[i * 3 + 1] : 1); S[10] = s * (sc ? scD[i * 3 + 2] : 1);
    mul(R, S, RS);
    identity(T); T[12] = px; T[13] = py; T[14] = pz;
    mul(T, RS, M);
    if (pv) { identity(T); T[12] = -pvD[i * 3]; T[13] = -pvD[i * 3 + 1]; T[14] = -pvD[i * 3 + 2]; mul(M, T, M2); const sw = M; M = M2; M2 = sw; }
    xf.M = M;
    // m4normalMatrix(M): m4invert (identity when singular), upper 3×3 transposed
    const a = M;
    inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
    inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
    inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
    inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
    inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
    inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
    inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
    inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
    inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
    inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
    inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
    inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
    inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
    inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
    inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
    inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
    let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
    if (Math.abs(det) < 1e-30) identity(inv);
    else { det = 1 / det; for (let k = 0; k < 16; k++) inv[k] *= det; }
    identity(Nm);
    Nm[0] = inv[0]; Nm[1] = inv[4]; Nm[2] = inv[8];
    Nm[4] = inv[1]; Nm[5] = inv[5]; Nm[6] = inv[9];
    Nm[8] = inv[2]; Nm[9] = inv[6]; Nm[10] = inv[10];
  };
  xf.M = M;
  xf.Nm = Nm;
  return xf;
}

function repeatTable(t: AttribTable, reps: { src: Int32Array }[]): AttribTable {
  let total = 0;
  for (const r of reps) total += r.src.length;
  if (!t.map.size) return new AttribTable(total); // nothing to gather: skip the index list
  const idx = new Int32Array(total);
  let o = 0;
  for (const r of reps) { idx.set(r.src, o); o += r.src.length; }
  return t.gather(idx);
}

defineNode({
  type: 'copy_to_points',
  category: 'copy',
  packed: 'keep',
  summary: 'Instance geometry onto points using P, orient | N+up, pscale, scale, rot, pivot, trans. Template point attributes (Cd…) are copied over. pack:true makes packed instances (cheap at millions).',
  aliases: ['copytopoints', 'instance', 'copy_to_pts'],
  description:
    'pack:false (default) makes real copies. pack:true makes one packed prim per template point: an anchor point at the instance position ' +
    'carrying the template point attributes, referencing the shared source with the instance rotation/scale (no geometry is copied). ' +
    'Packed instances render, export to glb (EXT_mesh_gpu_instancing) and usda (PointInstancer), survive transform/merge/delete/attribute ' +
    'nodes, and are expanded automatically for nodes that need polygons (or explicitly with unpack). ' +
    'Variants: variants "name" (split the source by prim name) or "piece" (by connectivity), or piece_attrib for any prim attribute; ' +
    'the template point attribute variant_attrib picks one per copy (an int index into the pieces, sorted by value for attributes, ' +
    'or the exact value, e.g. a string name); without that attribute the pieces cycle, or, with variant_weights, are picked at random ' +
    'with those weights (seeded; PCG Static Mesh Spawner weights). scale_attrib and rotate_attrib add a scale and a local rotation from ' +
    'any template attribute (e.g. a mask driving the size) on top of pscale/scale/orient/rot. Unreal PCG: Static Mesh Spawner.',
  inputs: [{ name: 'geo', desc: 'geometry to copy' }, { name: 'points', desc: 'template points' }],
  params: {
    group: P.group('point', 'template points to use ("" = all)'),
    pack: { type: 'bool', default: false, desc: 'output packed instances (one point + one packed prim per copy, sharing the source) instead of real copies', aliases: ['pack_and_instance', 'packed'] },
    copy_attribs: { type: 'string', default: '*', desc: 'template point attributes copied onto the copies (pattern; transform attributes are always excluded)' },
    copy_attrib: { type: 'string', default: 'copynum', desc: 'prim int attribute with the copy index ("" = none)' },
    variants: { type: 'enum', options: ['none', 'name', 'piece'], default: 'none', desc: 'split the source into variants: name = by prim "name", piece = by connectivity (none = only when piece_attrib is set)' },
    piece_attrib: { type: 'string', default: '', desc: 'variants: source prim attribute that splits the geometry into pieces (e.g. "name" or "class")' },
    variant_attrib: { type: 'string', default: 'variant', desc: 'variants: template point attribute choosing a piece (int index into sorted piece values, or the exact value)' },
    variant_weights: { type: 'json', default: [], desc: 'variants: weights per piece (in piece order) for a seeded weighted random pick when the template has no variant_attrib attribute, e.g. [3, 1, 1]; missing weights are 0', aliases: ['weights', 'variant_probabilities'] },
    seed: { type: 'float', default: 0, desc: 'variant_weights: random seed' },
    scale_attrib: { type: 'string', default: '', desc: 'template point attribute multiplying the copy scale (float = uniform, vec3 = per axis), on top of pscale and scale', aliases: ['scale_by'] },
    rotate_attrib: { type: 'string', default: '', desc: 'template point attribute adding a local rotation after orient/N/rot: float = degrees about +Y (yaw), vec3 = Euler degrees (XYZ), vec4 = quaternion', aliases: ['rotate_by'] },
  },
  outputs: 'prim copynum; template point attributes on copied points (pack: on the instance anchor points)',
  example: {
    nodes: {
      pine: { type: 'tube', params: { radius: 0.4, radius_top: 0, height: 1.5, center: [0, 0.75, 0] } },
      pine_named: { type: 'attrib_create', in: ['pine'], params: { name: 'name', class: 'prim', value: 'pine' } },
      rock: { type: 'sphere', params: { type: 'ico', level: 1, radius: 0.3 } },
      rock_named: { type: 'attrib_create', in: ['rock'], params: { name: 'name', class: 'prim', value: 'rock' } },
      library: { type: 'merge', in: ['pine_named', 'rock_named'] },
      ground: { type: 'grid', params: { size: [20, 20] } },
      pts: { type: 'scatter', in: ['ground'], params: { count: 200 } },
      forest: { type: 'copy_to_points', in: ['library', 'pts'], params: { pack: true, variants: 'name', variant_weights: [3, 1] } },
    },
    output: 'forest',
  },
  cook: ({ input, p, warn }) => {
    const src = input(0);
    const t = p.scale_attrib || p.rotate_attrib ? foldExtraXforms(input(1), p.scale_attrib, p.rotate_attrib) : input(1);
    const sel = mask(t, 'point', p.group);
    const tpts: number[] = [];
    for (let i = 0; i < t.numPoints; i++) if (!sel || sel[i]) tpts.push(i);
    if (!tpts.length || (!src.numPoints && !src.volumes.length)) return new Geometry();
    // variants
    let pieceOf: ((i: number) => Geometry) | null = null;
    let pieceKey: ((i: number) => any) | null = null;
    let subsets: Map<any, Geometry> | null = null;
    const splitAttr = p.variants === 'name' ? 'name' : p.variants === 'piece' ? '' : p.piece_attrib;
    if (p.variants === 'piece' || splitAttr) {
      let values: any[];
      subsets = new Map<any, Geometry>();
      if (!splitAttr) {
        // connectivity pieces, numbered 0.. in the order of their first prim
        const conn = connectivity(src);
        const order: number[] = [], index = new Map<number, number>();
        for (let pr = 0; pr < src.numPrims; pr++) { const c = conn.primClass[pr]; if (c >= 0 && !index.has(c)) { index.set(c, order.length); order.push(c); } }
        values = order.map((_, k) => k);
        order.forEach((c, k) => subsets!.set(k, src.subsetPrims(Uint8Array.from(conn.primClass, (x) => (x === c ? 1 : 0)))));
      } else {
        const pa = src.prims.get(splitAttr);
        if (!pa) throw new NodeError(p.variants === 'name' ? 'variants "name": the source has no prim attribute "name" (set it with attrib_create or name pieces before merging)' : `piece_attrib "${splitAttr}" not on source prims`);
        values = [...new Set(Array.from({ length: src.numPrims }, (_, i) => pa.get(i) as any))].sort((a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0));
        for (const v of values) subsets.set(v, src.subsetPrims(Uint8Array.from({ length: src.numPrims }, (_, i) => (pa.get(i) === v ? 1 : 0))));
      }
      const va = p.variant_attrib ? t.points.get(p.variant_attrib) : undefined;
      const wts = Array.isArray(p.variant_weights) ? p.variant_weights.map((x: any) => Math.max(0, Number(x) || 0)) : [];
      let wcdf: Float64Array | null = null;
      if (wts.length && va) warn(`variant_weights ignored: the template points have "${p.variant_attrib}", which picks the variants`);
      else if (wts.length && values.length) {
        if (wts.length !== values.length) warn(`variant_weights has ${wts.length} weight(s) for ${values.length} variant(s) (${values.join(', ')}); missing weights are 0`);
        wcdf = new Float64Array(values.length);
        let acc = 0;
        for (let k = 0; k < values.length; k++) { acc += wts[k] ?? 0; wcdf[k] = acc; }
        if (!(acc > 0)) throw new NodeError('variant_weights are all 0: no variant can be picked');
      }
      pieceKey = (i) => {
        if (!values.length) return undefined;
        if (!va && wcdf) {
          const x = (elementSeed(p.seed, i) / 2147483648) * wcdf[wcdf.length - 1];
          let k = 0;
          while (k < wcdf.length - 1 && !(x < wcdf[k])) k++;
          return values[k];
        }
        if (!va) return values[i % values.length];
        const v = va.get(i) as any;
        if (subsets!.has(v)) return v;
        if (typeof v === 'number') return values[((Math.floor(v) % values.length) + values.length) % values.length];
        return undefined;
      };
      pieceOf = (i) => subsets!.get(pieceKey!(i)) ?? new Geometry();
    } else if (Array.isArray(p.variant_weights) && p.variant_weights.length) warn('variant_weights needs variants ("name" or "piece") or piece_attrib to split the source into variants');
    const copyNames = new Set<string>();
    const pats = String(p.copy_attribs).split(/[\s,]+/).filter(Boolean);
    const matches = (n: string) => pats.some((pt) => !pt.startsWith('^') && new RegExp('^' + pt.replace(/\*/g, '.*') + '$').test(n)) && !pats.some((pt) => pt.startsWith('^') && new RegExp('^' + pt.slice(1).replace(/\*/g, '.*') + '$').test(n));
    for (const n of t.points.names()) if (!XFORM_ATTRIBS.has(n) && matches(n)) copyNames.add(n);

    if (p.pack) {
      const sources = subsets ? [...subsets.values()] : [src];
      const keyIndex = subsets ? new Map([...subsets.keys()].map((k, i) => [k, i])) : null;
      const pick = (ti: number) => (keyIndex ? keyIndex.get(pieceKey!(ti)) ?? -1 : 0);
      return packedCopies(src, sources, pick, t, tpts, copyNames, p.copy_attrib);
    }

    if (!pieceOf) {
      // fast path: one source repeated
      const np = src.numPoints, nv = src.numVertices, npr = src.numPrims, nc = tpts.length;
      const out = Geometry.blank();
      const rep = (n: number) => {
        const ident = new Int32Array(n); // one identity index list shared by every copy
        for (let i = 0; i < n; i++) ident[i] = i;
        return tpts.map(() => ({ src: ident }));
      };
      out.points = repeatTable(src.points, rep(np));
      out.vertices = repeatTable(src.vertices, rep(nv));
      out.prims = repeatTable(src.prims, rep(npr));
      out.detail = src.detail.clone();
      out.primStart = new Int32Array(npr * nc + 1);
      out.vertexPoint = new Int32Array(nv * nc);
      out.primClosed = new Uint8Array(npr * nc);
      out.pointGroups = new Map([...src.pointGroups].map(([k, m]) => { const o = new Uint8Array(np * nc); for (let c = 0; c < nc; c++) o.set(m, c * np); return [k, o]; }));
      out.primGroups = new Map([...src.primGroups].map(([k, m]) => { const o = new Uint8Array(npr * nc); for (let c = 0; c < nc; c++) o.set(m, c * npr); return [k, o]; }));
      out.vertexGroups = new Map([...src.vertexGroups].map(([k, m]) => { const o = new Uint8Array(nv * nc); for (let c = 0; c < nc; c++) o.set(m, c * nv); return [k, o]; }));
      out.edgeGroups = new Map([...src.edgeGroups].map(([k, e]) => { const o = new EdgeSet(); for (let c = 0; c < nc; c++) for (const [a, b] of e) o.add(a + c * np, b + c * np); return [k, o]; }));
      out.volumes = [];
      // packed prims in the source: repeated, each copy composing its transform into theirs
      if (src.primKind) {
        out.primKind = new Uint8Array(npr * nc);
        out.packedSource = new Int32Array(npr * nc);
        out.packedXform = new Float64Array(npr * nc * 9);
        out.packedSources = src.packedSources.slice();
        for (let c = 0; c < nc; c++) {
          out.primKind.set(src.primKind, c * npr);
          out.packedSource.set(src.packedSource!, c * npr);
          out.packedXform.set(src.packedXform!, c * npr * 9);
        }
      }
      const Pd = out.P, sP = src.P;
      const NA = out.points.get('N'), VNA = out.vertices.get('N');
      const vecA = ['v', 'up'].map((n) => out.points.get(n)).filter((a) => a && a.size === 3) as Attribute[];
      const cn = p.copy_attrib ? (out.prims.add(p.copy_attrib, 'int', 1).data as Int32Array) : null;
      const tmp = [0, 0, 0];
      const xf = pointXformer(t);
      tpts.forEach((ti, c) => {
        let M: Mat4, Nm: Mat4;
        if (xf) { xf(ti); M = xf.M; Nm = xf.Nm; } else { M = pointTransform(t, ti); Nm = m4normalMatrix(M); }
        for (let i = 0; i < np; i++) m4apply(M, sP[i * 3], sP[i * 3 + 1], sP[i * 3 + 2], Pd, (c * np + i) * 3);
        for (const [A, cnt] of [[NA, np], [VNA, nv]] as [Attribute | undefined, number][]) {
          if (!A || A.size !== 3) continue;
          const d = A.data as Float64Array;
          for (let i = c * cnt; i < (c + 1) * cnt; i++) {
            m4applyDir(Nm, d[i * 3], d[i * 3 + 1], d[i * 3 + 2], tmp);
            const l = Math.hypot(tmp[0], tmp[1], tmp[2]) || 1;
            d[i * 3] = tmp[0] / l; d[i * 3 + 1] = tmp[1] / l; d[i * 3 + 2] = tmp[2] / l;
          }
        }
        for (const A of vecA) { const d = A.data as Float64Array; for (let i = c * np; i < (c + 1) * np; i++) m4applyDir(M, d[i * 3], d[i * 3 + 1], d[i * 3 + 2], d, i * 3); }
        for (let v = 0; v < nv; v++) out.vertexPoint[c * nv + v] = src.vertexPoint[v] + c * np;
        for (let pr = 0; pr < npr; pr++) { out.primStart[c * npr + pr] = src.primStart[pr] + c * nv; out.primClosed[c * npr + pr] = src.primClosed[pr]; }
        if (cn) cn.fill(c, c * npr, (c + 1) * npr);
        if (out.primKind) composePackedXforms(out, M, null, c * npr, (c + 1) * npr);
      });
      out.primStart[npr * nc] = nv * nc;
      for (const n of copyNames) {
        const ta = t.points.get(n)!;
        const a = out.points.add(n, ta.type, ta.size);
        if (a.type !== 'string' && !a.isArray && !ta.isArray && a.size === ta.size) {
          // numeric tuple: the values a.set(i, ta.get(ti)) writes, filled per copy
          const d = a.data as Float64Array, sz = a.size, tup = new Float64Array(sz);
          tpts.forEach((ti, c) => {
            const v = ta.get(ti);
            for (let k = 0; k < sz; k++) tup[k] = typeof v === 'number' ? v : k < (v as number[]).length ? Number((v as number[])[k]) : 0;
            for (let i = c * np; i < (c + 1) * np; i++) for (let k = 0; k < sz; k++) d[i * sz + k] = tup[k];
          });
        } else tpts.forEach((ti, c) => { const v = ta.get(ti); for (let i = c * np; i < (c + 1) * np; i++) a.set(i, v); });
        if (n === 'Cd') { out.prims.delete('Cd'); out.vertices.delete('Cd'); }
      }
      return out;
    }
    // variants path: transform each chosen piece
    const parts: Geometry[] = [];
    tpts.forEach((ti, c) => {
      const piece = pieceOf!(ti);
      if (!piece.numPoints) return;
      const M = pointTransform(t, ti), Nm = m4normalMatrix(M);
      const g = piece.clone();
      const Pd = g.P;
      for (let i = 0; i < g.numPoints; i++) m4apply(M, Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2], Pd, i * 3);
      if (g.primKind) composePackedXforms(g, M);
      for (const cls of ['point', 'vertex'] as const) {
        const A = g.table(cls).get('N');
        if (!A || A.size !== 3) continue;
        const d = A.data as Float64Array;
        for (let i = 0; i < A.count; i++) {
          m4applyDir(Nm, d[i * 3], d[i * 3 + 1], d[i * 3 + 2], d, i * 3);
          const l = Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]) || 1;
          d[i * 3] /= l; d[i * 3 + 1] /= l; d[i * 3 + 2] /= l;
        }
      }
      if (p.copy_attrib) (g.prims.add(p.copy_attrib, 'int', 1).data as Int32Array).fill(c);
      for (const n of copyNames) {
        const ta = t.points.get(n)!;
        const a = g.points.add(n, ta.type, ta.size);
        const v = ta.get(ti);
        for (let i = 0; i < g.numPoints; i++) a.set(i, v);
      }
      parts.push(g);
    });
    return Geometry.merge(parts);
  },
});

/**
 * Instance transforms of template points, written without allocations (1M points in a few tens of ms):
 * pos (3 per point) = translation, X (9 per point) = rotation·scale, column-major. Same conventions and the same
 * arithmetic as pointTransform: P + trans; orient, else N (or v) with up, else identity; then rot; times
 * pscale·scale; pivot moves the translation by -(R·S)·pivot.
 */
export function instanceXforms(t: Geometry, tpts: ArrayLike<number>): { pos: Float64Array; X: Float64Array } {
  const n = tpts.length, pos = new Float64Array(n * 3), X = new Float64Array(n * 9);
  const get = (name: string) => t.points.get(name);
  const f = (a: Attribute | undefined, size: number) => (a && a.size === size && a.type !== 'string' && !a.isArray ? (a.data as Float64Array) : null);
  const Pd = t.P, tr = f(get('trans'), 3), orient = f(get('orient'), 4);
  const NA = get('N') ?? get('v'), N = f(NA, 3), up = f(get('up'), 3), rot = f(get('rot'), 4);
  const psA = get('pscale'), ps = psA && psA.size === 1 && psA.type !== 'string' && !psA.isArray ? (psA.data as Float64Array) : null;
  const sc = f(get('scale'), 3), pv = f(get('pivot'), 3);
  const R = new Float64Array(9), Q = new Float64Array(9);
  const quat = (d: Float64Array, o: number, out: Float64Array) => {
    // m4fromQuat (no normalisation, as there)
    const x = d[o], y = d[o + 1], z = d[o + 2], w = d[o + 3];
    out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y + z * w); out[2] = 2 * (x * z - y * w);
    out[3] = 2 * (x * y - z * w); out[4] = 1 - 2 * (x * x + z * z); out[5] = 2 * (y * z + x * w);
    out[6] = 2 * (x * z + y * w); out[7] = 2 * (y * z - x * w); out[8] = 1 - 2 * (x * x + y * y);
  };
  for (let k = 0; k < n; k++) {
    const i = tpts[k];
    let px = Pd[i * 3], py = Pd[i * 3 + 1], pz = Pd[i * 3 + 2];
    if (tr) { px += tr[i * 3]; py += tr[i * 3 + 1]; pz += tr[i * 3 + 2]; }
    R[0] = 1; R[1] = 0; R[2] = 0; R[3] = 0; R[4] = 1; R[5] = 0; R[6] = 0; R[7] = 0; R[8] = 1;
    if (orient) quat(orient, i * 4, R);
    else if (N) {
      // lookAtBasis(N, up): z = N, x = up × z (fallback axis when parallel), y = z × x
      const dx = N[i * 3], dy = N[i * 3 + 1], dz = N[i * 3 + 2];
      if (Math.hypot(dx, dy, dz) > 1e-12) {
        const l = Math.hypot(dx, dy, dz);
        const zx = l > 1e-20 ? dx / l : 0, zy = l > 1e-20 ? dy / l : 0, zz = l > 1e-20 ? dz / l : 0;
        if (Math.hypot(zx, zy, zz) !== 0) {
          const ux = up ? up[i * 3] : 0, uy = up ? up[i * 3 + 1] : 1, uz = up ? up[i * 3 + 2] : 0;
          let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
          if (Math.hypot(xx, xy, xz) < 1e-8) {
            const ax = Math.abs(zy) < 0.9 ? 0 : 1, ay = Math.abs(zy) < 0.9 ? 1 : 0;
            xx = ay * zz - 0 * zy; xy = 0 * zx - ax * zz; xz = ax * zy - ay * zx;
          }
          const xl = Math.hypot(xx, xy, xz);
          if (xl > 1e-20) { xx /= xl; xy /= xl; xz /= xl; } else { xx = 0; xy = 0; xz = 0; }
          R[0] = xx; R[1] = xy; R[2] = xz;
          R[3] = zy * xz - zz * xy; R[4] = zz * xx - zx * xz; R[5] = zx * xy - zy * xx;
          R[6] = zx; R[7] = zy; R[8] = zz;
        }
      }
    }
    if (rot) {
      quat(rot, i * 4, Q);
      // R := R · Q, column by column
      const r0 = R[0], r1 = R[1], r2 = R[2], r3 = R[3], r4 = R[4], r5 = R[5], r6 = R[6], r7 = R[7], r8 = R[8];
      for (let c = 0; c < 3; c++) {
        const q0 = Q[c * 3], q1 = Q[c * 3 + 1], q2 = Q[c * 3 + 2];
        R[c * 3] = r0 * q0 + r3 * q1 + r6 * q2;
        R[c * 3 + 1] = r1 * q0 + r4 * q1 + r7 * q2;
        R[c * 3 + 2] = r2 * q0 + r5 * q1 + r8 * q2;
      }
    }
    const s = ps ? ps[i] : 1;
    const sx = s * (sc ? sc[i * 3] : 1), sy = s * (sc ? sc[i * 3 + 1] : 1), sz = s * (sc ? sc[i * 3 + 2] : 1);
    const o = k * 9;
    X[o] = R[0] * sx; X[o + 1] = R[1] * sx; X[o + 2] = R[2] * sx;
    X[o + 3] = R[3] * sy; X[o + 4] = R[4] * sy; X[o + 5] = R[5] * sy;
    X[o + 6] = R[6] * sz; X[o + 7] = R[7] * sz; X[o + 8] = R[8] * sz;
    if (pv) {
      const vx = -pv[i * 3], vy = -pv[i * 3 + 1], vz = -pv[i * 3 + 2];
      px += X[o] * vx + X[o + 3] * vy + X[o + 6] * vz;
      py += X[o + 1] * vx + X[o + 4] * vy + X[o + 7] * vz;
      pz += X[o + 2] * vx + X[o + 5] * vy + X[o + 8] * vz;
    }
    pos[k * 3] = px; pos[k * 3 + 1] = py; pos[k * 3 + 2] = pz;
  }
  return { pos, X };
}

/**
 * Packed copy_to_points: one anchor point + one packed prim per copy. Template attributes go onto the anchors; the
 * attributes they replace in an unpacked copy (point attributes of the same name, and every Cd) are removed from
 * the shared sources once, so unpacking gives the same result as pack:false.
 */
function packedCopies(
  src: Geometry, sources: Geometry[], pick: (ti: number) => number, t: Geometry, tpts: number[], copyNames: Set<string>, copyAttrib: string,
): Geometry {
  const strip = (g: Geometry) => {
    const kill = [...copyNames].filter((n) => g.points.has(n) || (n === 'Cd' && g.findAttrib('Cd')));
    if (!kill.length) return g;
    const c = g.clone();
    for (const n of kill) {
      c.points.delete(n);
      if (n === 'Cd') { c.prims.delete('Cd'); c.vertices.delete('Cd'); }
    }
    return c;
  };
  const srcs = sources.map(strip);
  const chosen: number[] = [], copyIdx: number[] = [], srcIdx: number[] = [];
  tpts.forEach((ti, c) => {
    const s = pick(ti);
    if (s < 0 || !srcs[s] || !srcs[s].numPoints) return; // empty piece: no copy (as unpacked)
    chosen.push(ti); copyIdx.push(c); srcIdx.push(s);
  });
  const n = chosen.length;
  const { pos, X } = instanceXforms(t, chosen);
  const out = Geometry.blank();
  out.points = new AttribTable(n);
  (out.points.add('P', 'float', 3).data as Float64Array).set(pos);
  for (const name of copyNames) out.points.set(name, t.points.get(name)!.gather(chosen));
  out.vertices = new AttribTable(n);
  out.prims = new AttribTable(n);
  if (copyAttrib) (out.prims.add(copyAttrib, 'int', 1).data as Int32Array).set(copyIdx);
  out.detail = src.detail.clone();
  out.primStart = Int32Array.from({ length: n + 1 }, (_, i) => i);
  out.vertexPoint = Int32Array.from({ length: n }, (_, i) => i);
  out.primClosed = new Uint8Array(n);
  out.pointGroups = new Map();
  out.primGroups = new Map();
  out.vertexGroups = new Map();
  out.edgeGroups = new Map();
  out.volumes = [];
  out.primKind = new Uint8Array(n).fill(1);
  out.packedSource = Int32Array.from(srcIdx);
  out.packedXform = X;
  out.packedSources = srcs;
  return out.compactPackedSources();
}

export { m4basis };
