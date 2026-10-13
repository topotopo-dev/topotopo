// Signed distance fields: an implicit-modelling toolkit. Volumes travel inside Geometry
// (geo.volumes) as sample functions, so they merge/transform like any other data;
// sdf_to_mesh polygonises them with manifold-3d's level-set mesher.
import { Geometry } from '../core/geometry.ts';
import type { SdfVolume as Volume, Volume as AnyVolume } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext } from '../graph/types.ts';
import { runUserCode } from '../core/usercode.ts';
import { M, fromManifold, propLayout } from '../core/manifold.ts';
import { TriBVH } from '../core/spatial.ts';
import { triangulate } from '../core/topology.ts';
import { fractal, makeNoise } from '../core/noise.ts';
import { m4euler, m4invert, m4apply } from '../core/math.ts';
import type { Vec3 } from '../core/math.ts';
import { P } from './util.ts';

type Fn = (x: number, y: number, z: number) => number;
interface Box { min: Vec3; max: Vec3 }

const len = Math.hypot;

/** An SDF volume; `scripted` when sample runs user code (see SdfVolume.scripted). */
function vol(name: string, bounds: Box, sample: Fn, scripted?: boolean): Volume {
  return scripted ? { name, kind: 'sdf', bounds, sample, scripted: true } : { name, kind: 'sdf', bounds, sample };
}

/**
 * Evaluate an SDF volume: `work` samples the field with the function it is given (directly, or from inside manifold's
 * WASM level-set mesher). A field that runs user code (`scripted`: an sdf_expr upstream) is evaluated like a wrangle:
 * the whole call runs under the script timeout, and what the code throws is read inside it. The sampler handed to
 * `work` also checks the deadline itself (every 64 samples), so a field that is merely slow stops with an ordinary
 * exception between samples rather than wherever the host's watchdog interrupts (it is armed a little later and stops
 * a sample that never returns; the mesher's working memory is then not freed). Analytic fields run `work` as it is,
 * with no limit and no overhead.
 */
export function evalSdf<T>(ctx: CookContext, v: Volume, work: (sample: Fn) => T): T {
  if (!v.scripted) return work(v.sample);
  const ms = ctx.engine.scriptTimeoutMs, f = v.sample, deadline = Date.now() + ms;
  let n = 0, expired = false;
  const sample: Fn = (x, y, z) => {
    if ((++n & 63) === 0 && Date.now() > deadline) { expired = true; throw new Error('SDF sampling ran out of time'); }
    return f(x, y, z);
  };
  try {
    return runUserCode(ctx.engine.host, () => work(sample), ms + Math.min(ms, 2000));
  } catch (e: any) {
    if (expired || e.timedOut) throw new NodeError(`${ctx.type}: SDF code (sdf_expr) exceeded ${ms} ms (infinite loop?)`);
    throw new NodeError(`${ctx.type}: SDF code (sdf_expr) failed: ${e.message}`);
  }
}

/** The SDF volumes of a geometry (heightfields are skipped; heightfield_to_sdf converts them). */
const sdfsOf = (g: Geometry): Volume[] => g.volumes.filter((v: AnyVolume): v is Volume => v.kind === 'sdf');

function unionVolumes(g: Geometry, what: string): Volume {
  const vs = sdfsOf(g);
  if (!vs.length) throw new NodeError(`${what}: input has no SDF volume (create one with sdf_shape, sdf_expr or sdf_from_mesh${g.volumes.length ? '; heightfields convert with heightfield_to_sdf' : ''})`);
  if (vs.length === 1) return vs[0];
  const b = boxUnion(vs.map((v) => v.bounds));
  return vol('union', b, (x, y, z) => { let d = Infinity; for (const v of vs) d = Math.min(d, v.sample(x, y, z)); return d; }, vs.some((v) => v.scripted));
}

function boxUnion(bs: Box[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bs) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], b.min[a]); max[a] = Math.max(max[a], b.max[a]); }
  return { min, max };
}
const pad = (b: Box, r: number): Box => ({ min: b.min.map((v) => v - r) as Vec3, max: b.max.map((v) => v + r) as Vec3 });

function smin(a: number, b: number, k: number) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function shapeFn(p: any): { f: Fn; r: Vec3 } {
  const [sx, sy, sz] = p.size.map((v: number) => v / 2);
  switch (p.shape) {
    case 'sphere': return { f: (x, y, z) => len(x, y, z) - p.radius, r: [p.radius, p.radius, p.radius] };
    case 'box': case 'round_box': {
      const rr = p.shape === 'round_box' ? Math.min(p.radius2, sx, sy, sz) : 0;
      return {
        f: (x, y, z) => {
          const qx = Math.abs(x) - sx + rr, qy = Math.abs(y) - sy + rr, qz = Math.abs(z) - sz + rr;
          return len(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - rr;
        },
        r: [sx, sy, sz],
      };
    }
    case 'torus': return { f: (x, y, z) => len(len(x, z) - p.radius, y) - p.radius2, r: [p.radius + p.radius2, p.radius2, p.radius + p.radius2] };
    case 'capsule': {
      const h = p.height / 2;
      return { f: (x, y, z) => len(x, y - Math.max(-h, Math.min(h, y)), z) - p.radius, r: [p.radius, h + p.radius, p.radius] };
    }
    case 'cylinder': {
      const h = p.height / 2;
      return {
        f: (x, y, z) => { const dx = len(x, z) - p.radius, dy = Math.abs(y) - h; return Math.min(Math.max(dx, dy), 0) + len(Math.max(dx, 0), Math.max(dy, 0)); },
        r: [p.radius, h, p.radius],
      };
    }
    case 'cone': {
      // base radius at y=-h/2, apex at y=+h/2 (exact cone distance, IQ)
      const h = p.height, r = p.radius;
      return {
        f: (x, y, z) => {
          const qx = len(x, z), qy = y + h / 2;
          const k1x = 0, k1y = h, k2x = -r, k2y = h;
          const cax = qx - Math.min(qx, qy < h / 2 ? r : 0);
          void k1x;
          const cay = Math.abs(qy - h / 2) - h / 2;
          const t = Math.max(0, Math.min(1, ((-qx) * k2x + (k1y - qy) * k2y) / (k2x * k2x + k2y * k2y)));
          const cbx = qx + k2x * t, cby = qy - k1y + k2y * t;
          const s = cbx < 0 && cay < 0 ? -1 : 1;
          return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
        },
        r: [r, h / 2, r],
      };
    }
    case 'ellipsoid': return {
      f: (x, y, z) => {
        const k0 = len(x / sx, y / sy, z / sz), k1 = len(x / (sx * sx), y / (sy * sy), z / (sz * sz));
        return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(sx, sy, sz);
      },
      r: [sx, sy, sz],
    };
    case 'octahedron': return { f: (x, y, z) => (Math.abs(x) + Math.abs(y) + Math.abs(z) - p.radius) * 0.57735027, r: [p.radius, p.radius, p.radius] };
    default: throw new NodeError(`unknown sdf shape ${p.shape}`);
  }
}

defineNode({
  type: 'sdf_shape',
  category: 'sdf',
  summary: 'SDF primitive volume (sphere, box, round_box, torus, capsule, cylinder, cone, ellipsoid, octahedron). Mesh it with sdf_to_mesh.',
  aliases: ['sdf_primitive', 'sdf'],
  inputs: [],
  params: {
    shape: { type: 'enum', options: ['sphere', 'box', 'round_box', 'torus', 'capsule', 'cylinder', 'cone', 'ellipsoid', 'octahedron'], default: 'sphere', desc: 'primitive' },
    radius: { type: 'float', default: 0.5, desc: 'sphere/capsule/cylinder/cone/octahedron radius; torus major radius' },
    radius2: { type: 'float', default: 0.1, desc: 'torus minor radius; round_box corner radius' },
    size: { type: 'vec3', default: [1, 1, 1], desc: 'box/round_box/ellipsoid full size' },
    height: { type: 'float', default: 1, desc: 'capsule/cylinder/cone height (along Y)' },
    center: P.center(),
    rotate: { type: 'vec3', default: [0, 0, 0], desc: 'rotation in degrees' },
    name: { type: 'string', default: 'sdf', desc: 'volume name' },
  },
  example: { type: 'sdf_shape', params: { shape: 'round_box', size: [1, 0.5, 1], radius2: 0.1 } },
  cook: ({ p }) => {
    const { f, r } = shapeFn(p);
    const rot = p.rotate.some((v: number) => v !== 0);
    const R = rot ? m4euler(p.rotate) : null, Ri = R ? m4invert(R) : null;
    const c = p.center, tmp = [0, 0, 0];
    const sample: Fn = Ri
      ? (x, y, z) => { m4apply(Ri, x - c[0], y - c[1], z - c[2], tmp); return f(tmp[0], tmp[1], tmp[2]); }
      : (x, y, z) => f(x - c[0], y - c[1], z - c[2]);
    const ext = rot ? Math.hypot(...r) : 0;
    const half: Vec3 = rot ? [ext, ext, ext] : r;
    const g = new Geometry();
    g.volumes = [vol(p.name, pad({ min: [c[0] - half[0], c[1] - half[1], c[2] - half[2]], max: [c[0] + half[0], c[1] + half[1], c[2] + half[2]] }, 0.01), sample)];
    return g;
  },
});

defineNode({
  type: 'sdf_expr',
  category: 'sdf',
  summary: 'SDF from JS code: return a signed distance for point p ([x,y,z]). IQ helpers built in (sdSphere, sdBox, smin, opTwist…). sdf(i, p) samples input i.',
  description:
    'The code runs sandboxed like a wrangle, under the script timeout (TOPOTOPO_SCRIPT_TIMEOUT_MS, default 30 s). ' +
    'This node only probes the field at the origin; the nodes that sample it later (sdf_to_mesh, sdf_grid, also after ' +
    'transform, sdf_modify or sdf_combine) run all of their sampling under that limit, so the whole mesh or grid must ' +
    'be computed within it: a field that loops anywhere, or is too slow for the resolution, fails the sampling node ' +
    'with "SDF code (sdf_expr) exceeded N ms".',
  aliases: ['sdf_code', 'sdf_wrangle', 'implicit'],
  inputs: [
    { name: 'a', desc: 'optional SDF input, sampled as sdf(0, p)', optional: true },
    { name: 'b', desc: 'optional SDF input, sampled as sdf(1, p)', optional: true },
  ],
  params: {
    code: { type: 'code', default: 'smin(sdSphere(p, 0.6), sdBox(sub(p, [0.6, 0, 0]), [0.3, 0.3, 0.3]), 0.25)', desc: 'expression or body with return; p = [x,y,z]; negative inside' },
    bounds_min: { type: 'vec3', default: [-1.5, -1.5, -1.5], desc: 'meshing region min' },
    bounds_max: { type: 'vec3', default: [1.5, 1.5, 1.5], desc: 'meshing region max' },
    auto_bounds: { type: 'bool', default: false, desc: 'use the union of input volume bounds (padded) instead' },
    name: { type: 'string', default: 'sdf', desc: 'volume name' },
  },
  usesVars: true,
  example: { type: 'sdf_expr', params: { code: 'const q = opTwist(p, 2.0);\nreturn sdTorus(q, 0.8, 0.2);' } },
  cook: ({ inputs, p, engine, vars }) => {
    const ins = inputs.map((g) => (g && sdfsOf(g).length ? unionVolumes(g, 'sdf_expr').sample : null));
    const body = /\breturn\b/.test(p.code) ? p.code : `return (${p.code});`;
    // as a wrangle: the body is parsed on its own first (a complete function body cannot close the wrapper, so
    // nothing runs while compiling), and the probe call runs under the host's time limit, which also covers async
    // continuations and reading the message of whatever the code throws
    const syntax = engine.host.checkSyntax?.(`"use strict";${body}`);
    if (syntax) throw new NodeError(`sdf_expr syntax error: ${syntax.message}${p.code.includes('\n') ? ` (line ${syntax.line})` : ''}`);
    let make;
    try {
      make = engine.host.compile(`(function(__in, vars){ "use strict"; const sdf = (i, q) => { const f = __in[i]; if (!f) throw new Error('sdf input ' + i + ' has no volume'); return f(q[0], q[1], q[2]); };\nreturn function(x, y, z){ const p = [x, y, z];\n${body}\n}; })`);
    } catch (e: any) {
      throw new NodeError(`sdf_expr syntax error: ${e.message}`);
    }
    const f = make(ins, vars);
    let t: any, failed: string | undefined;
    try {
      engine.host.runGuarded(() => {
        try { t = f(0, 0, 0); } catch (e: any) {
          try { const m = e?.message; failed = typeof m === 'string' ? m : String(e); } catch { failed = 'an exception that cannot be described'; }
        }
      }, engine.scriptTimeoutMs);
    } catch (e: any) {
      if (/timed out/i.test(String(e?.message))) throw new NodeError(`sdf_expr: code exceeded ${engine.scriptTimeoutMs} ms (infinite loop?)`);
      throw new NodeError(`sdf_expr: ${e?.message ?? e}`);
    }
    if (failed !== undefined) throw new NodeError(`sdf_expr: ${failed}`);
    if (typeof t !== 'number') throw new NodeError(`sdf_expr: code returned ${typeof t}, expected a number`);
    let bounds: Box = { min: p.bounds_min, max: p.bounds_max };
    if (p.auto_bounds) {
      const vs = inputs.flatMap((g) => (g ? sdfsOf(g).map((v) => v.bounds) : []));
      if (vs.length) bounds = pad(boxUnion(vs), 0.1);
    }
    const g = new Geometry();
    g.volumes = [vol(p.name, bounds, f, true)];
    return g;
  },
});

defineNode({
  type: 'sdf_combine',
  category: 'sdf',
  summary: 'Combine SDF volumes: union / subtract / intersect, hard or smooth (blend radius k).',
  aliases: ['sdf_boolean', 'sdf_blend', 'vdb_combine'],
  inputs: [{ name: 'a', desc: 'SDF A' }, { name: 'b', desc: 'SDF B (optional: combines all volumes of A)', optional: true }],
  params: {
    operation: { type: 'enum', options: ['union', 'subtract', 'intersect', 'smooth_union', 'smooth_subtract', 'smooth_intersect'], default: 'smooth_union', desc: 'operation', aliases: ['op', 'mode'] },
    k: { type: 'float', default: 0.2, min: 0, desc: 'blend radius for smooth operations', aliases: ['smoothness', 'blend', 'radius'] },
  },
  example: {
    nodes: {
      body: { type: 'sdf_shape', params: { shape: 'capsule', radius: 0.3, height: 1 } },
      head: { type: 'sdf_shape', params: { shape: 'sphere', radius: 0.35, center: [0, 0.8, 0] } },
      blob: { type: 'sdf_combine', in: ['body', 'head'], params: { operation: 'smooth_union', k: 0.2 } },
      mesh: { type: 'sdf_to_mesh', in: ['blob'] },
    },
    output: 'mesh',
  },
  cook: ({ input, hasInput, p }) => {
    const A = input(0);
    let vs: Volume[];
    if (hasInput(1)) vs = [unionVolumes(A, 'sdf_combine'), unionVolumes(input(1), 'sdf_combine')];
    else { vs = sdfsOf(A); if (vs.length < 2) throw new NodeError('sdf_combine needs input B or at least 2 volumes in A'); }
    const op = p.operation, k = p.k;
    const f2 = (a: number, b: number) => {
      switch (op) {
        case 'union': return Math.min(a, b);
        case 'subtract': return Math.max(a, -b);
        case 'intersect': return Math.max(a, b);
        case 'smooth_union': return smin(a, b, k);
        case 'smooth_subtract': return -smin(-a, b, k);
        default: return -smin(-a, -b, k);
      }
    };
    const fs = vs.map((v) => v.sample);
    const sample: Fn = (x, y, z) => { let d = fs[0](x, y, z); for (let i = 1; i < fs.length; i++) d = f2(d, fs[i](x, y, z)); return d; };
    let bounds: Box;
    if (op.includes('union')) bounds = pad(boxUnion(vs.map((v) => v.bounds)), op.startsWith('smooth') ? k : 0);
    else if (op.includes('subtract')) bounds = vs[0].bounds;
    else {
      const b = vs.map((v) => v.bounds);
      bounds = { min: [0, 1, 2].map((a) => Math.max(...b.map((x) => x.min[a]))) as Vec3, max: [0, 1, 2].map((a) => Math.min(...b.map((x) => x.max[a]))) as Vec3 };
    }
    const g = A.clone();
    g.volumes = [vol(op, bounds, sample, vs.some((v) => v.scripted))];
    if (hasInput(1)) return Geometry.merge([g, (() => { const h = input(1).clone(); h.volumes = []; return h; })()]);
    return g;
  },
});

defineNode({
  type: 'sdf_modify',
  category: 'sdf',
  summary: 'Modify SDF volumes: offset (grow/shrink), shell, noise displacement, twist, bend, repeat (domain repetition).',
  aliases: ['sdf_offset', 'sdf_noise', 'sdf_twist', 'vdb_reshape'],
  inputs: [{ name: 'sdf', desc: 'geometry with SDF volume(s)' }],
  params: {
    operation: { type: 'enum', options: ['offset', 'shell', 'noise', 'twist', 'bend', 'repeat'], default: 'offset', desc: 'modification', aliases: ['op', 'mode'] },
    amount: { type: 'float', default: 0.05, desc: 'offset distance (+ grows) / shell thickness / noise amplitude / twist or bend radians per unit' },
    frequency: { type: 'float', default: 3, desc: 'noise frequency' },
    octaves: { type: 'int', default: 3, min: 1, max: 8, desc: 'noise octaves' },
    period: { type: 'vec3', default: [1, 0, 1], desc: 'repeat: spacing per axis (0 = no repetition on that axis)' },
    count: { type: 'ivec3', default: [3, 1, 3], min: 1, max: 1000000, desc: 'repeat: number of copies per axis (limits the domain)' },
    seed: P.seed(),
  },
  example: {
    nodes: {
      ball: { type: 'sdf_shape', params: { shape: 'sphere', radius: 0.8 } },
      rough: { type: 'sdf_modify', in: ['ball'], params: { operation: 'noise', amount: 0.08, frequency: 4 } },
      mesh: { type: 'sdf_to_mesh', in: ['rough'] },
    },
    output: 'mesh',
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const v = unionVolumes(g, 'sdf_modify');
    const f = v.sample, a = p.amount;
    let sample: Fn = f, bounds = v.bounds;
    const c: Vec3 = [0, 1, 2].map((i) => (v.bounds.min[i] + v.bounds.max[i]) / 2) as Vec3;
    switch (p.operation) {
      case 'offset': sample = (x, y, z) => f(x, y, z) - a; bounds = pad(bounds, Math.max(0, a)); break;
      case 'shell': sample = (x, y, z) => Math.abs(f(x, y, z)) - a; bounds = pad(bounds, a); break;
      case 'noise': {
        const n = fractal(makeNoise('perlin', p.seed), { octaves: p.octaves });
        sample = (x, y, z) => f(x, y, z) + a * n(x * p.frequency, y * p.frequency, z * p.frequency);
        bounds = pad(bounds, Math.abs(a));
        break;
      }
      case 'twist': {
        sample = (x, y, z) => { const t = a * (y - c[1]), cs = Math.cos(t), sn = Math.sin(t), dx = x - c[0], dz = z - c[2]; return f(c[0] + cs * dx - sn * dz, y, c[2] + sn * dx + cs * dz); };
        const r = Math.hypot(bounds.max[0] - c[0], bounds.max[2] - c[2]);
        bounds = { min: [c[0] - r, bounds.min[1], c[2] - r], max: [c[0] + r, bounds.max[1], c[2] + r] };
        break;
      }
      case 'bend': {
        sample = (x, y, z) => { const t = a * (x - c[0]), cs = Math.cos(t), sn = Math.sin(t), dx = x - c[0], dy = y - c[1]; return f(c[0] + cs * dx - sn * dy, c[1] + sn * dx + cs * dy, z); };
        const r = Math.max(...[0, 1, 2].map((i) => bounds.max[i] - bounds.min[i]));
        bounds = pad(bounds, r * 0.5);
        break;
      }
      case 'repeat': {
        const per = p.period, cnt = p.count;
        sample = (x, y, z) => {
          const q = [x - c[0], y - c[1], z - c[2]];
          for (let i = 0; i < 3; i++) if (per[i] > 0) {
            const lim = (cnt[i] - 1) / 2;
            q[i] = q[i] - per[i] * Math.max(-lim, Math.min(lim, Math.round(q[i] / per[i])));
          }
          return f(q[0] + c[0], q[1] + c[1], q[2] + c[2]);
        };
        bounds = { min: [0, 1, 2].map((i) => bounds.min[i] - (per[i] > 0 ? per[i] * (cnt[i] - 1) / 2 : 0)) as Vec3, max: [0, 1, 2].map((i) => bounds.max[i] + (per[i] > 0 ? per[i] * (cnt[i] - 1) / 2 : 0)) as Vec3 };
        break;
      }
    }
    g.volumes = [vol(v.name, bounds, sample, v.scripted)];
    return g;
  },
});

/** Narrow-band exact distance + fast sweeping + parity sign. Returns a trilinear sampler. */
export function meshToSdf(g: Geometry, voxel: number, padVox = 3): Volume {
  const bvh = new TriBVH(g);
  if (!bvh.numTris) throw new NodeError('sdf_from_mesh: input has no polygons');
  const bb = g.bbox();
  const o: Vec3 = [bb.min[0] - padVox * voxel, bb.min[1] - padVox * voxel, bb.min[2] - padVox * voxel];
  const dims = [0, 1, 2].map((a) => Math.max(2, Math.ceil((bb.max[a] - bb.min[a]) / voxel) + 2 * padVox + 1));
  const [nx, ny, nz] = dims;
  if (nx * ny * nz > 1.6e7) throw new NodeError(`sdf_from_mesh: grid ${nx}x${ny}x${nz} too large; increase voxel_size`);
  const D = new Float32Array(nx * ny * nz).fill(Infinity);
  const id = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  // narrow band: exact distances near each triangle
  const T = bvh.T, band = 2;
  const tmpP = [0, 0, 0];
  const nt = T.length / 9;
  for (let t = 0; t < nt; t++) {
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) { const v = T[t * 9 + k * 3 + a]; mn[a] = Math.min(mn[a], v); mx[a] = Math.max(mx[a], v); }
    const i0 = Math.max(0, Math.floor((mn[0] - o[0]) / voxel) - band), i1 = Math.min(nx - 1, Math.ceil((mx[0] - o[0]) / voxel) + band);
    const j0 = Math.max(0, Math.floor((mn[1] - o[1]) / voxel) - band), j1 = Math.min(ny - 1, Math.ceil((mx[1] - o[1]) / voxel) + band);
    const k0 = Math.max(0, Math.floor((mn[2] - o[2]) / voxel) - band), k1 = Math.min(nz - 1, Math.ceil((mx[2] - o[2]) / voxel) + band);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      tmpP[0] = o[0] + i * voxel; tmpP[1] = o[1] + j * voxel; tmpP[2] = o[2] + k * voxel;
      const d = triDist(T, t * 9, tmpP[0], tmpP[1], tmpP[2]);
      const ix = id(i, j, k);
      if (d < D[ix]) D[ix] = d;
    }
  }
  // fast sweeping (Eikonal, |grad d| = 1) to fill the rest
  const h = voxel;
  for (let sweep = 0; sweep < 8; sweep++) {
    const sx = sweep & 1 ? -1 : 1, sy = sweep & 2 ? -1 : 1, sz = sweep & 4 ? -1 : 1;
    for (let k = sz > 0 ? 0 : nz - 1; k >= 0 && k < nz; k += sz)
      for (let j = sy > 0 ? 0 : ny - 1; j >= 0 && j < ny; j += sy)
        for (let i = sx > 0 ? 0 : nx - 1; i >= 0 && i < nx; i += sx) {
          const a = Math.min(i > 0 ? D[id(i - 1, j, k)] : Infinity, i < nx - 1 ? D[id(i + 1, j, k)] : Infinity);
          const b = Math.min(j > 0 ? D[id(i, j - 1, k)] : Infinity, j < ny - 1 ? D[id(i, j + 1, k)] : Infinity);
          const c = Math.min(k > 0 ? D[id(i, j, k - 1)] : Infinity, k < nz - 1 ? D[id(i, j, k + 1)] : Infinity);
          const s = [a, b, c].sort((x, y) => x - y);
          let u = s[0] + h;
          if (u > s[1]) {
            u = (s[0] + s[1] + Math.sqrt(Math.max(0, 2 * h * h - (s[0] - s[1]) ** 2))) / 2;
            if (u > s[2]) {
              const sum = s[0] + s[1] + s[2];
              const disc = sum * sum - 3 * (s[0] ** 2 + s[1] ** 2 + s[2] ** 2 - h * h);
              u = (sum + Math.sqrt(Math.max(0, disc))) / 3;
            }
          }
          const ix = id(i, j, k);
          if (u < D[ix]) D[ix] = u;
        }
  }
  // sign by ray parity along +X for each row (majority with +Y rows for robustness)
  const inside = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const y = o[1] + j * h, z = o[2] + k * h;
    const hits = bvh.raycastAll(o[0] - h, y + 1.37e-7, z + 2.71e-7, 1, 0, 0);
    let c = 0, hi = 0;
    for (let i = 0; i < nx; i++) {
      const t = i * h + h;
      while (hi < hits.length && hits[hi] < t) { c++; hi++; }
      if (c % 2 === 1) inside[id(i, j, k)] = 1;
    }
  }
  for (let i = 0; i < D.length; i++) if (inside[i]) D[i] = -D[i];
  const bounds: Box = { min: o, max: [o[0] + (nx - 1) * h, o[1] + (ny - 1) * h, o[2] + (nz - 1) * h] };
  const sample: Fn = (x, y, z) => {
    let fx = (x - o[0]) / h, fy = (y - o[1]) / h, fz = (z - o[2]) / h;
    let extra = 0;
    const cx = Math.max(0, Math.min(nx - 1.000001, fx)), cy = Math.max(0, Math.min(ny - 1.000001, fy)), cz = Math.max(0, Math.min(nz - 1.000001, fz));
    if (cx !== fx || cy !== fy || cz !== fz) extra = Math.hypot(cx - fx, cy - fy, cz - fz) * h;
    fx = cx; fy = cy; fz = cz;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const u = fx - i, v = fy - j, w = fz - k;
    const c00 = D[id(i, j, k)] * (1 - u) + D[id(i + 1, j, k)] * u;
    const c10 = D[id(i, j + 1, k)] * (1 - u) + D[id(i + 1, j + 1, k)] * u;
    const c01 = D[id(i, j, k + 1)] * (1 - u) + D[id(i + 1, j, k + 1)] * u;
    const c11 = D[id(i, j + 1, k + 1)] * (1 - u) + D[id(i + 1, j + 1, k + 1)] * u;
    return (c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w + extra;
  };
  return vol('mesh_sdf', bounds, sample);
}

function triDist(T: Float64Array, o: number, px: number, py: number, pz: number): number {
  // closest point on triangle (Ericson), distance only
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const abx = T[o + 3] - ax, aby = T[o + 4] - ay, abz = T[o + 5] - az;
  const acx = T[o + 6] - ax, acy = T[o + 7] - ay, acz = T[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);
  const bpx = px - T[o + 3], bpy = py - T[o + 4], bpz = pz - T[o + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return Math.hypot(apx - abx * v, apy - aby * v, apz - abz * v); }
  const cpx = px - T[o + 6], cpy = py - T[o + 7], cpz = pz - T[o + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return Math.hypot(apx - acx * w, apy - acy * w, apz - acz * w); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return Math.hypot(bpx - (T[o + 6] - T[o + 3]) * w, bpy - (T[o + 7] - T[o + 4]) * w, bpz - (T[o + 8] - T[o + 5]) * w);
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return Math.hypot(apx - abx * v - acx * w, apy - aby * v - acy * w, apz - abz * v - acz * w);
}

function autoVoxel(b: Box, divs: number) {
  return Math.max(...[0, 1, 2].map((a) => b.max[a] - b.min[a])) / divs;
}

defineNode({
  type: 'sdf_from_mesh',
  category: 'sdf',
  summary: 'Convert a closed mesh to an SDF volume (narrow band + sweeping), for blending meshes, offsets and remeshing.',
  aliases: ['vdb_from_polygons', 'mesh_to_sdf'],
  inputs: [{ name: 'mesh', desc: 'closed polygon mesh' }],
  params: {
    voxel_size: { type: 'float', default: 0, min: 0, desc: 'voxel size (0 = auto from divisions)' },
    divisions: { type: 'int', default: 64, min: 8, max: 256, desc: 'voxels across the largest dimension when voxel_size = 0' },
    keep_mesh: { type: 'bool', default: false, desc: 'keep the input polygons alongside the volume' },
  },
  example: {
    nodes: {
      box: { type: 'box' },
      field: { type: 'sdf_from_mesh', in: ['box'], params: { divisions: 48 } },
      grown: { type: 'sdf_to_mesh', in: ['field'], params: { iso: 0.1 } },
    },
    output: 'grown',
  },
  cook: ({ input, p }) => {
    const g = input(0);
    const voxel = p.voxel_size > 0 ? p.voxel_size : autoVoxel(g.bbox(), p.divisions);
    const v = meshToSdf(g, voxel);
    const out = p.keep_mesh ? g.clone() : new Geometry();
    out.volumes = [...(p.keep_mesh ? g.volumes : []), v];
    return out;
  },
});

/** Polygonise a volume with manifold's level-set mesher; optional gradient normals. */
export function sdfToMesh(v: Volume, edge: number, iso: number, normals: boolean): Geometry {
  const W = M();
  const b = pad(v.bounds, edge * 2);
  const f = v.sample;
  const m = W.Manifold.levelSet((q: number[]) => -f(q[0], q[1], q[2]) + 0, { min: b.min, max: b.max }, edge, -iso);
  const g = fromManifold(m, propLayout([])).geo;
  m.delete();
  if (normals && g.numPoints) {
    const N = g.points.add('N', 'float', 3).data as Float64Array;
    const e = edge * 0.25, Pd = g.P;
    for (let i = 0; i < g.numPoints; i++) {
      const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
      const nx = f(x + e, y, z) - f(x - e, y, z), ny = f(x, y + e, z) - f(x, y - e, z), nz = f(x, y, z + e) - f(x, y, z - e);
      const l = Math.hypot(nx, ny, nz) || 1;
      N[i * 3] = nx / l; N[i * 3 + 1] = ny / l; N[i * 3 + 2] = nz / l;
    }
  }
  return g;
}

defineNode({
  type: 'sdf_to_mesh',
  category: 'sdf',
  summary: 'Polygonise SDF volumes into a watertight triangle mesh (all volumes are unioned). Smooth normals from the field gradient.',
  description:
    'Meshes with the level-set mesher of manifold-3d. A field that runs user code (an sdf_expr upstream, also through ' +
    'transform, sdf_modify or sdf_combine) is meshed under the script timeout (TOPOTOPO_SCRIPT_TIMEOUT_MS, default 30 s): ' +
    'the whole meshing, normals included, must finish within it, else this node fails with "SDF code (sdf_expr) ' +
    'exceeded N ms" (raise edge_length or the timeout for a slow field). Analytic volumes (sdf_shape, sdf_from_mesh, ' +
    'grid_to_sdf, heightfield_to_sdf) have no limit.',
  aliases: ['convert_sdf', 'convert_vdb', 'mesh_sdf', 'polygonize', 'isosurface'],
  inputs: [{ name: 'sdf', desc: 'geometry with SDF volume(s)' }],
  params: {
    edge_length: { type: 'float', default: 0, min: 0, desc: 'target triangle edge length (0 = auto from divisions)', aliases: ['voxel_size', 'resolution'] },
    divisions: { type: 'int', default: 64, min: 8, max: 400, desc: 'cells across the largest dimension when edge_length = 0' },
    iso: { type: 'float', default: 0, desc: 'iso value (+ grows, − shrinks)', aliases: ['level', 'offset'] },
    normals: { type: 'bool', default: true, desc: 'write point N from the field gradient' },
    keep_input: { type: 'bool', default: false, desc: 'also keep the input polygons' },
  },
  example: {
    nodes: {
      ring: { type: 'sdf_shape', params: { shape: 'torus', radius: 0.8, radius2: 0.25 } },
      mesh: { type: 'sdf_to_mesh', in: ['ring'], params: { divisions: 80 } },
    },
    output: 'mesh',
  },
  cook: (ctx) => {
    const { input, p } = ctx;
    const g = input(0);
    const v = unionVolumes(g, 'sdf_to_mesh');
    const edge = p.edge_length > 0 ? p.edge_length : autoVoxel(v.bounds, p.divisions);
    const cells = [0, 1, 2].map((a) => (v.bounds.max[a] - v.bounds.min[a]) / edge).reduce((s, x) => s * x, 1);
    if (cells > 3e7) throw new NodeError(`sdf_to_mesh: ~${(cells / 1e6).toFixed(0)}M cells; raise edge_length`);
    // user code (sdf_expr) runs under the script timeout, inside manifold's mesher too
    const mesh = evalSdf(ctx, v, (sample) => sdfToMesh(sample === v.sample ? v : { ...v, sample }, edge, p.iso, p.normals));
    if (!p.keep_input) return mesh;
    const rest = g.clone();
    rest.volumes = [];
    return Geometry.merge([rest, mesh]);
  },
});

defineNode({
  type: 'remesh',
  category: 'topology',
  summary: 'Voxel remesh: rebuild a closed mesh as an even, watertight triangle mesh (mesh → SDF → isosurface).',
  description:
    'Always watertight and merges overlapping parts, but sharp edges round off and attributes are dropped. To keep the ' +
    'surface, sharp edges, boundaries, uv and other attributes use remesh_isotropic (Houdini Remesh SOP).',
  aliases: ['remesh_voxel'],
  inputs: [{ name: 'mesh', desc: 'closed mesh (may self-intersect; overlapping parts get merged)' }],
  params: {
    edge_length: { type: 'float', default: 0, min: 0, desc: 'target edge length (0 = auto from divisions)' },
    divisions: { type: 'int', default: 48, min: 8, max: 256, desc: 'resolution across the largest dimension when edge_length = 0' },
    offset: { type: 'float', default: 0, desc: 'grow (+) / shrink (−) the surface' },
  },
  example: { type: 'remesh', params: { divisions: 40, offset: 0.02 } },
  cook: ({ input, p }) => {
    const g = input(0);
    const edge = p.edge_length > 0 ? p.edge_length : autoVoxel(g.bbox(), p.divisions);
    const v = meshToSdf(g, edge * 0.75);
    return sdfToMesh(v, edge, p.offset, true);
  },
});

export { triangulate };
