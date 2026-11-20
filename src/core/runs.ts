// Runs: water, rust and dirt that flow down a surface under gravity from source parts (rust under a bolt, rain streaks
// under a ledge). They are traced in 3D over the receiving surface, so a run crosses uv seams and edges without seeing
// them and works on a box, a cylinder or a creature alike (nodes/runs.ts bakes them into uv space).
//
//   start points   points on the source parts, moved to the closest point of the receiving surface (every prim that is
//                  not a source), kept within TOUCH of the source and off ledges, thinned to `density` runs per metre
//                  (random order, minimum spacing 1 / density between runs, every connected piece of a source gets one)
//   walking        a step of `step` metres along gravity projected onto the tangent plane of the smooth surface normal,
//                  bent sideways by 3D noise (wobble), then snapped back onto the surface (closest point). A step that
//                  ends in the air beyond a convex edge takes the direction of the gap as the surface normal there
//   ledge          a surface whose normal is within `ledge` degrees of up stops the run; it pools there (a lens along
//                  the ledge, `pool` times the run's width). Overhang: a surface turned down (normal·gravity above
//                  OVERHANG) is left by a drip: a ray along gravity to the next surface below, where the run goes on
//   emergence      the part of a run under its source part (within the run's own width of it) is not drawn: a run
//                  begins where it comes out from under the part
//   per texel      the closest run segments within the widest run (a grid over the segments), accepted where the
//                  texel's normal agrees with the segment's: coverage of a stripe of the run's width over the texel
//                  (so thin runs stay thin at any resolution), gaps along the run from 3D noise, per run width wander
//
// Everything a texel reads is a function of its 3D position and normal, so both sides of a uv seam give one value.
// Single-threaded and deterministic (hash-seeded, no Math.random).
import type { Geometry } from './geometry.ts';
import { RayScene } from './analysis.ts';
import { makeNoise } from './noise.ts';
import { hash32, hashNumber } from './random.ts';
import { TriBVH, closestOnTri, closestScratch } from './spatial.ts';
import { triangulate, vertexNormals } from './topology.ts';

/** A source part touches the surface when it is within this of it (metres, at the default run size: it scales with the mid width, see scales()). */
export const TOUCH = 0.01;
/** A surface turned down this much (normal · gravity) is an overhang: runs drip off it (about 15° past vertical). */
export const OVERHANG = 0.26;
/** Most runs a node traces (a warning says when the density was thinned to fit). */
export const MAX_RUNS = 20000;
/** Most segments a trace may hold (about 100 bytes each) and most registrations of segments in the texel grid (a lens spans many cells); a refusal names the params to lower. A variable only so that tests can lower it. */
export const limits = { maxSegments: 400000, maxItems: 40_000_000 };
/** Faces meeting at more than this angle (degrees) are a crease: flow direction does not smooth across it. */
export const CREASE = 40;
/**
 * The metre constants below are tuned for runs of the default size (widths 3 to 10 mm, lengths 5 to 25 cm); they scale
 * with the mid width (kw) and the mid length (kl) of the params, so a run looks the same at any scale.
 */
export const REF_WIDTH = 0.0065;
export const REF_LENGTH = 0.15;
/** The mid width and length of the ranges, as the factors the metre constants scale with. */
export function scales(prm: { width: [number, number]; length: [number, number] }): { kw: number; kl: number } {
  const w = (Math.max(1e-5, prm.width[0]) + Math.max(1e-5, prm.width[1])) / 2, l = (Math.max(1e-4, prm.length[0]) + Math.max(1e-4, prm.length[1])) / 2;
  return { kw: w / REF_WIDTH, kl: l / REF_LENGTH };
}
/** A trace or a bake that would hold more than a limit: the node turns it into a refusal. */
export class FlowLimit extends Error {
  kind: 'segments' | 'cells';
  count: number;
  constructor(kind: 'segments' | 'cells', count: number) { super(`${kind} limit`); this.kind = kind; this.count = count; }
}

const HP1 = 73856093, HP2 = 19349663, HP3 = 83492791;
/** A 32-bit hash of a seed, a salt and a position quantised to `unit` metres: randomness that follows where things are. */
export function hpos(sd: number, salt: number, x: number, y: number, z: number, unit: number): number {
  let h = hash32((sd ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);
  h = hash32((h ^ Math.imul(Math.round(x / unit), HP1)) >>> 0);
  h = hash32((h ^ Math.imul(Math.round(y / unit), HP2)) >>> 0);
  h = hash32((h ^ Math.imul(Math.round(z / unit), HP3)) >>> 0);
  return h;
}
/** The k-th random 0..1 of a hash. */
const r01 = (h: number, k: number) => hash32((h + Math.imul(k + 1, 0x85ebca6b)) >>> 0) / 4294967296;
/** Most spills over a ledge's edge one run may take. */
const MAX_SPILLS = 3;
/** Strength of a run after it spilled over an edge. */
const SPILL_AMP = 0.65;
/** Most drips one run may take. */
const MAX_DRIPS = 6;

export interface FlowParams {
  density: number;
  direction: [number, number, number];
  /** length range per run (metres, drawn part: from where it comes out from under its source) */
  length: [number, number];
  /** width range at the head (metres); runs taper to 30 % at the tail */
  width: [number, number];
  wobble: number;
  breakup: number;
  /** degrees: a surface whose normal is within this of up is a ledge */
  ledge: number;
  pool: number;
  drip: boolean;
  /** walking step in metres (0 = half the smallest width) */
  step: number;
  /** metres: a pool on a ledge whose edge is this near spills over it and runs on below (0 = pools stay) */
  spill: number;
  seed: number;
}

// ---------------------------------------------------------------- sources

export interface Candidates {
  /** start candidates, 3 per candidate */
  P: Float64Array;
  /** part of each candidate */
  part: Int32Array;
  /** name of each part (the prim name, else "part N" or "point N") */
  names: string[];
}

/**
 * Points over the surface of the source parts (triangles by area, at least one per triangle; every random value is keyed
 * by where the triangle is, so the order of the prims does not matter) and
 * the source's loose points. Parts are the connected pieces of the source (labelled by their prim name when it has
 * them); each loose point is a part of its own.
 */
export function sampleSources(g: Geometry, seed: number, unit = REF_WIDTH * 1e-3, kw = 1, maxCount = 300000): Candidates {
  const { tris, triPrim } = triangulate(g);
  const nt = tris.length / 3, P = g.P, vp = g.vertexPoint;
  // parts
  const nameAttr = g.prims.get('name');
  const named = nameAttr && nameAttr.type === 'string';
  const parent = new Int32Array(g.numPoints);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const used = new Uint8Array(g.numPoints);
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p]) continue;
    const s = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s; v < e; v++) {
      used[vp[v]] = 1;
      const a = find(vp[s]), b = find(vp[v]);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const partOf = new Map<string, number>(), names: string[] = [];
  const part = (key: string, label: string) => {
    let i = partOf.get(key);
    if (i === undefined) { i = names.length; partOf.set(key, i); names.push(label); }
    return i;
  };
  const primPart = new Int32Array(g.numPrims).fill(-1);
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p]) continue;
    const root = find(vp[g.primStart[p]]), nm = named ? String(nameAttr!.get(p) ?? '') : '';
    primPart[p] = part(`c:${root}`, nm || `part ${root}`);
  }
  // triangle areas and the sampling spacing
  const area = new Float64Array(nt);
  let total = 0;
  for (let t = 0; t < nt; t++) {
    const a = vp[tris[t * 3]] * 3, b = vp[tris[t * 3 + 1]] * 3, c = vp[tris[t * 3 + 2]] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    area[t] = 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    total += area[t];
  }
  const sp = Math.max(0.003 * kw, Math.sqrt(total / maxCount));
  const out: number[] = [], pp: number[] = [];
  const sd = hashNumber(seed);
  for (let t = 0; t < nt; t++) {
    const a = vp[tris[t * 3]] * 3, b = vp[tris[t * 3 + 1]] * 3, c = vp[tris[t * 3 + 2]] * 3;
    const want = area[t] / (sp * sp);
    const th = hpos(sd, 1, (P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3, unit);
    const n = Math.max(1, Math.floor(want + r01(th, 0)));
    for (let k = 0; k < n; k++) {
      const u = Math.sqrt(r01(th, 2 * k + 1)), v = r01(th, 2 * k + 2);
      const w0 = 1 - u, w1 = u * (1 - v), w2 = u * v;
      out.push(P[a] * w0 + P[b] * w1 + P[c] * w2, P[a + 1] * w0 + P[b + 1] * w1 + P[c + 1] * w2, P[a + 2] * w0 + P[b + 2] * w1 + P[c + 2] * w2);
      pp.push(primPart[triPrim[t]]);
    }
  }
  for (let i = 0; i < g.numPoints; i++) {
    if (used[i]) continue;
    out.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    pp.push(part(`p:${i}`, `point ${i}`));
  }
  return { P: Float64Array.from(out), part: Int32Array.from(pp), names };
}

// ---------------------------------------------------------------- the runs

/** Run segments in struct-of-arrays form (what the per-texel pass reads). */
export interface RunSet {
  /** runs traced (ids 1..count) */
  count: number;
  /** segments, each drawn as a stripe between its ends */
  segs: number;
  /** 6 per segment: end a, end b */
  A: Float64Array;
  /** 6 per segment: surface normal at a and b */
  NRM: Float32Array;
  /** 2 per segment: half width at a and b (metres) */
  HW: Float32Array;
  /** 2 per segment: drawn arc length from where the run emerged, at a and b (metres) */
  SS: Float32Array;
  /** run of each segment (1-based) */
  ID: Int32Array;
  /** 1 = a pool lens (no gaps) */
  POOL: Uint8Array;
  /** strength of each segment (1, less after a spill) */
  AMP: Float32Array;
  /** drawn length of each run (index 0 unused) */
  runLen: Float32Array;
  /** a random 0..1 per run (index 0 unused) */
  strength: Float32Array;
  /** 1 = the run ended in a pool (index 0 unused); the others fade out toward their tail */
  pooled: Uint8Array;
  /** the number written to the id layer: a hash of where the run starts (index 0 unused), so it does not change when other parts are added or reordered */
  key: Float32Array;
  /** the scale factors the metre constants follow (mid width and mid length over the defaults') */
  kw: number;
  kl: number;
}

export interface TraceStats {
  /** candidate points sampled on the sources */
  candidates: number;
  /** candidates within TOUCH of the receiving surface */
  touching: number;
  /** touching candidates on a ledge or an overhang (no run starts there) */
  ledgeRejected: number;
  /** runs started (some never come out from under their source and leave no run) */
  started: number;
  /** runs that stopped on a ledge, ended by length, dripped off an overhang, or were lost (left the surface, buried) */
  ended: { ledge: number; length: number; fell: number; lost: number };
  /** drips that landed on a surface below */
  drips: number;
  /** spills over the edge of a ledge */
  spills: number;
  /** the density was thinned to the run limit */
  capped: boolean;
  /** parts that touch the surface (names) */
  touchingParts: string[];
}

export interface Traced { runs: RunSet; stats: TraceStats }

/** Growable typed arrays of the segments. */
class SegList {
  count = 0;
  cap = 1024;
  A = new Float64Array(this.cap * 6); NRM = new Float32Array(this.cap * 6); HW = new Float32Array(this.cap * 2); SS = new Float32Array(this.cap * 2);
  ID = new Int32Array(this.cap); POOL = new Uint8Array(this.cap); AMP = new Float32Array(this.cap);
  private grow() {
    const c = this.cap * 2;
    const g = <T extends Float64Array | Float32Array | Int32Array | Uint8Array>(a: T, per: number): T => { const o = new (a.constructor as any)(c * per) as T; o.set(a); return o; };
    this.A = g(this.A, 6); this.NRM = g(this.NRM, 6); this.HW = g(this.HW, 2); this.SS = g(this.SS, 2); this.ID = g(this.ID, 1); this.POOL = g(this.POOL, 1); this.AMP = g(this.AMP, 1);
    this.cap = c;
  }
  push(a: ArrayLike<number>, b: ArrayLike<number>, na: ArrayLike<number>, nb: ArrayLike<number>, hwa: number, hwb: number, sa: number, sb: number, id: number, pool: number, amp = 1) {
    if (this.count >= limits.maxSegments) throw new FlowLimit('segments', this.count);
    if (this.count === this.cap) this.grow();
    const k = this.count++, o = k * 6;
    this.A[o] = a[0]; this.A[o + 1] = a[1]; this.A[o + 2] = a[2]; this.A[o + 3] = b[0]; this.A[o + 4] = b[1]; this.A[o + 5] = b[2];
    this.NRM[o] = na[0]; this.NRM[o + 1] = na[1]; this.NRM[o + 2] = na[2]; this.NRM[o + 3] = nb[0]; this.NRM[o + 4] = nb[1]; this.NRM[o + 5] = nb[2];
    this.HW[k * 2] = hwa; this.HW[k * 2 + 1] = hwb; this.SS[k * 2] = sa; this.SS[k * 2 + 1] = sb; this.ID[k] = id; this.POOL[k] = pool; this.AMP[k] = amp;
  }
  /**
   * Merge the consecutive segments of the run drawn since `first` that run on as one straight stripe: every vertex in
   * between within `tol` of the chord, the half width within 8 % of the straight taper, the surface normal turning less
   * than about 5°, the same strength, no longer than `maxLen`. A run is walked in tiny steps; the texel pass wants
   * few long stripes. Pool lenses stay as they are.
   */
  simplify(first: number, tol: number, maxLen: number) {
    const A = this.A, N = this.NRM, HW = this.HW, SS = this.SS, end = this.count;
    let out = first, i = first;
    while (i < end) {
      let j = i;
      if (!this.POOL[i]) {
        for (; j + 1 < end; j++) {
          const k = j + 1;
          if (this.POOL[k] || this.AMP[k] !== this.AMP[i]) break;
          const jb = j * 6 + 3, ka = k * 6;
          if (A[jb] !== A[ka] || A[jb + 1] !== A[ka + 1] || A[jb + 2] !== A[ka + 2]) break; // not connected (a drip)
          // chord from the start of i to the end of k
          const ax = A[i * 6], ay = A[i * 6 + 1], az = A[i * 6 + 2], bx = A[k * 6 + 3], by = A[k * 6 + 4], bz = A[k * 6 + 5];
          const dx = bx - ax, dy = by - ay, dz = bz - az, l2 = dx * dx + dy * dy + dz * dz;
          if (l2 > maxLen * maxLen) break;
          if (N[i * 6] * N[k * 6 + 3] + N[i * 6 + 1] * N[k * 6 + 4] + N[i * 6 + 2] * N[k * 6 + 5] < 0.996) break;
          const s0 = SS[i * 2], s1 = SS[k * 2 + 1], hw0 = HW[i * 2], hw1 = HW[k * 2 + 1];
          let ok = true;
          for (let m = i; m <= j && ok; m++) {
            // the end vertex of segment m
            const px = A[m * 6 + 3] - ax, py = A[m * 6 + 4] - ay, pz = A[m * 6 + 5] - az;
            const t = l2 > 0 ? (px * dx + py * dy + pz * dz) / l2 : 0;
            const ex = px - dx * t, ey = py - dy * t, ez = pz - dz * t;
            if (ex * ex + ey * ey + ez * ez > tol * tol) ok = false;
            const f = s1 > s0 ? (SS[m * 2 + 1] - s0) / (s1 - s0) : t, hwl = hw0 + (hw1 - hw0) * f, hwm = HW[m * 2 + 1];
            if (Math.abs(hwm - hwl) > 0.08 * Math.max(hwm, hwl)) ok = false;
          }
          if (!ok) break;
        }
      }
      // write segments i..j as one at `out`
      const id = this.ID[i], pool = this.POOL[i], amp = this.AMP[i];
      const a0 = [A[i * 6], A[i * 6 + 1], A[i * 6 + 2]], b0 = [A[j * 6 + 3], A[j * 6 + 4], A[j * 6 + 5]];
      const na = [N[i * 6], N[i * 6 + 1], N[i * 6 + 2]], nb = [N[j * 6 + 3], N[j * 6 + 4], N[j * 6 + 5]];
      const hwa = HW[i * 2], hwb = HW[j * 2 + 1], sa = SS[i * 2], sb = SS[j * 2 + 1];
      A[out * 6] = a0[0]; A[out * 6 + 1] = a0[1]; A[out * 6 + 2] = a0[2]; A[out * 6 + 3] = b0[0]; A[out * 6 + 4] = b0[1]; A[out * 6 + 5] = b0[2];
      N[out * 6] = na[0]; N[out * 6 + 1] = na[1]; N[out * 6 + 2] = na[2]; N[out * 6 + 3] = nb[0]; N[out * 6 + 4] = nb[1]; N[out * 6 + 5] = nb[2];
      HW[out * 2] = hwa; HW[out * 2 + 1] = hwb; SS[out * 2] = sa; SS[out * 2 + 1] = sb; this.ID[out] = id; this.POOL[out] = pool; this.AMP[out] = amp;
      out++; i = j + 1;
    }
    this.count = out;
  }
}

const norm3 = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; };

/**
 * Trace the runs of `cands` over `recv` (the receiving surface: polygons, uv not needed). `src` (the source parts as
 * geometry) lets a run begin where it leaves them; without it (points as sources) runs begin at their start point.
 * `check` is called now and then and may throw (a time limit).
 */
export function traceRuns(recv: Geometry, src: Geometry | null, cands: Candidates, prm: FlowParams, check?: () => void): Traced {
  const bvh = new TriBVH(recv), rays = new RayScene(bvh);
  // flow direction comes from the geometry, never from authored normals: face normals, smoothed only across faces that
  // meet below the crease angle (a face wound the wrong way reads as turned down, and water goes through it)
  const vn = vertexNormals(recv, CREASE);
  const { kw, kl } = scales(prm);
  const unit = REF_WIDTH * 1e-3 * kw;
  const wobbleFreq = 12 / kl;
  const srcBvh = src && triangulate(src).tris.length ? new TriBVH(src) : null;
  const gl = Math.hypot(prm.direction[0], prm.direction[1], prm.direction[2]);
  const G: [number, number, number] = [prm.direction[0] / gl, prm.direction[1] / gl, prm.direction[2] / gl];
  const up: [number, number, number] = [-G[0], -G[1], -G[2]];
  const ledgeCos = Math.cos((Math.max(0, Math.min(90, prm.ledge)) * Math.PI) / 180);
  const [lmin, lmax] = [Math.max(1e-4, Math.min(prm.length[0], prm.length[1])), Math.max(1e-4, Math.max(prm.length[0], prm.length[1]))];
  const [wmin, wmax] = [Math.max(1e-5, Math.min(prm.width[0], prm.width[1])), Math.max(1e-5, Math.max(prm.width[0], prm.width[1]))];
  const h = Math.max(1e-4, prm.step > 0 ? prm.step : 0.5 * wmin);
  const sd = hashNumber(prm.seed);
  const noise = makeNoise('perlin', Math.floor(prm.seed * 131) + 17);
  const diag = (() => { const b = recv.bbox(); return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1; })();
  const sc = closestScratch();
  const stats: TraceStats = { started: 0, candidates: cands.part.length, touching: 0, ledgeRejected: 0, ended: { ledge: 0, length: 0, fell: 0, lost: 0 }, drips: 0, spills: 0, capped: false, touchingParts: [] };

  /** smooth surface normal of triangle t at barycentric (b0, b1, b2), unit, into out */
  const smooth = (t: number, b0: number, b1: number, b2: number, out: number[]) => {
    const v0 = bvh.triVtx[t * 3] * 3, v1 = bvh.triVtx[t * 3 + 1] * 3, v2 = bvh.triVtx[t * 3 + 2] * 3;
    out[0] = vn[v0] * b0 + vn[v1] * b1 + vn[v2] * b2;
    out[1] = vn[v0 + 1] * b0 + vn[v1 + 1] * b1 + vn[v2 + 1] * b2;
    out[2] = vn[v0 + 2] * b0 + vn[v1 + 2] * b1 + vn[v2 + 2] * b2;
    return norm3(out);
  };
  const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // ---- start points: touching the surface, off ledges
  interface Start { q: [number, number, number]; part: number; key: number; h: number }
  const starts: Start[] = [];
  const tn = [0, 0, 0];
  const touchingParts = new Set<number>();
  for (let i = 0; i < cands.part.length; i++) {
    const t = bvh.closestInto(cands.P[i * 3], cands.P[i * 3 + 1], cands.P[i * 3 + 2], TOUCH * kw, sc);
    if (t < 0) continue;
    stats.touching++;
    touchingParts.add(cands.part[i]);
    smooth(t, sc.b0, sc.b1, sc.b2, tn);
    // a start on a ledge is a pool; it only goes anywhere when it can spill over an edge
    if ((prm.spill <= 0 && dot(tn, up) >= ledgeCos) || dot(tn, G) > OVERHANG) { stats.ledgeRejected++; continue; }
    starts.push({ q: [sc.x, sc.y, sc.z], part: cands.part[i], key: hpos(sd, 5, sc.x, sc.y, sc.z, unit), h: hpos(sd, 6, sc.x, sc.y, sc.z, unit) });
  }
  stats.touchingParts = [...touchingParts].sort((a, b) => a - b).map((i) => cands.names[i]);

  // ---- thinning: random order, minimum spacing 1 / density between runs; a piece of a source that has none gets one
  starts.sort((a, b) => a.key - b.key || a.q[0] - b.q[0] || a.q[1] - b.q[1] || a.q[2] - b.q[2]);
  const cellSize = prm.density > 0 ? 1 / prm.density : 1, minD2 = cellSize * cellSize;
  const grid = new Map<string, Start[]>();
  const keyOf = (i: number, j: number, k: number) => `${i},${j},${k}`;
  const chosen: Start[] = [], partHas = new Set<number>();
  const take = (s: Start) => {
    const k = keyOf(Math.floor(s.q[0] / cellSize), Math.floor(s.q[1] / cellSize), Math.floor(s.q[2] / cellSize));
    const l = grid.get(k);
    if (l) l.push(s); else grid.set(k, [s]);
    chosen.push(s); partHas.add(s.part);
  };
  const crowded = (s: Start) => {
    const i = Math.floor(s.q[0] / cellSize), j = Math.floor(s.q[1] / cellSize), k = Math.floor(s.q[2] / cellSize);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const l = grid.get(keyOf(i + a, j + b, k + c));
      if (!l) continue;
      for (const o of l) { const dx = o.q[0] - s.q[0], dy = o.q[1] - s.q[1], dz = o.q[2] - s.q[2]; if (dx * dx + dy * dy + dz * dz < minD2) return true; }
    }
    return false;
  };
  if (prm.density > 0) {
    for (const s of starts) {
      if (chosen.length >= MAX_RUNS) { stats.capped = true; break; }
      if (!crowded(s)) take(s);
    }
    for (const s of starts) {
      if (chosen.length >= MAX_RUNS) { stats.capped = true; break; }
      if (!partHas.has(s.part)) take(s);
    }
  }

  stats.started = chosen.length;
  // ---- walk
  const segs = new SegList();
  const runLen: number[] = [0], strength: number[] = [0], pooled: number[] = [0], runKey: number[] = [0];
  const tp = [0, 0, 0], tb = [0, 0, 0];
  const x = [0, 0, 0], n = [0, 0, 0], nq = [0, 0, 0], d = [0, 0, 0], tx = [0, 0, 0], dir = [0, 0, 0], q = [0, 0, 0], e = [0, 0, 0], neff = [0, 0, 0], lastDir = [0, 0, 0], nPrev = [0, 0, 0];
  const noiseAt = (px: number, py: number, pz: number, ox: number, oy: number, oz: number) => noise(px * wobbleFreq + ox, py * wobbleFreq + oy, pz * wobbleFreq + oz);

  // the nearest edge of the ledge at p0 (normal nl) within `reach`: the pool spills there. Marches over the surface in
  // 16 directions; an edge is where the surface ends (a step lands in the air) or turns down steeper than a ledge; a
  // surface that rises in the way blocks that direction. E, EN (the normal to go on with) and ED (the direction) are set.
  // a ledge that rolls over ends where the surface is clearly steeper than a ledge (4° more), so the run is not stopped again at once
  const edgeCos = Math.cos((Math.min(89, Math.max(0, prm.ledge) + 4) * Math.PI) / 180);
  const edgeE = [0, 0, 0], edgeN = [0, 0, 0], edgeD = [0, 0, 0];
  const findEdge = (p0: number[], nl: number[], reach: number): boolean => {
    const ax = Math.abs(nl[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t1 = norm3([nl[1] * ax[2] - nl[2] * ax[1], nl[2] * ax[0] - nl[0] * ax[2], nl[0] * ax[1] - nl[1] * ax[0]]);
    const t2 = [nl[1] * t1[2] - nl[2] * t1[1], nl[2] * t1[0] - nl[0] * t1[2], nl[0] * t1[1] - nl[1] * t1[0]];
    const h2 = Math.max(h, reach / 24), steps = Math.ceil(reach / h2);
    let best = Infinity, found = false;
    const pp = [0, 0, 0], nc = [0, 0, 0], dd = [0, 0, 0], en = [0, 0, 0], eq = [0, 0, 0], ee = [0, 0, 0];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
      dd[0] = t1[0] * ca + t2[0] * sa; dd[1] = t1[1] * ca + t2[1] * sa; dd[2] = t1[2] * ca + t2[2] * sa;
      pp[0] = p0[0]; pp[1] = p0[1]; pp[2] = p0[2]; nc[0] = nl[0]; nc[1] = nl[1]; nc[2] = nl[2];
      let travelled = 0, hit = false, isAir = false;
      for (let i = 0; i < steps && !hit; i++) {
        if (rays.nearest(pp[0] + nc[0] * 1e-4, pp[1] + nc[1] * 1e-4, pp[2] + nc[2] * 1e-4, dd[0], dd[1], dd[2], 1.05 * h2, 1e-6) < Infinity) break;
        const sx = pp[0] + dd[0] * h2, sy = pp[1] + dd[1] * h2, sz = pp[2] + dd[2] * h2;
        const t = bvh.closestInto(sx, sy, sz, 4 * h2, sc);
        if (t < 0) { eq[0] = pp[0]; eq[1] = pp[1]; eq[2] = pp[2]; en[0] = dd[0] + G[0]; en[1] = dd[1] + G[1]; en[2] = dd[2] + G[2]; norm3(en); hit = true; isAir = true; }
        else {
          const qx = sc.x, qy = sc.y, qz = sc.z;
          smooth(t, sc.b0, sc.b1, sc.b2, en);
          ee[0] = sx - qx; ee[1] = sy - qy; ee[2] = sz - qz;
          const de = Math.hypot(ee[0], ee[1], ee[2]);
          if (de > 0.3 * h2 && dot(ee, en) > -0.2 * de) { eq[0] = qx; eq[1] = qy; eq[2] = qz; en[0] = ee[0] / de; en[1] = ee[1] / de; en[2] = ee[2] / de; hit = true; isAir = true; }
          else if (dot(en, up) < edgeCos) { eq[0] = qx; eq[1] = qy; eq[2] = qz; hit = true; }
          else { travelled += Math.hypot(qx - pp[0], qy - pp[1], qz - pp[2]); pp[0] = qx; pp[1] = qy; pp[2] = qz; nc[0] = en[0]; nc[1] = en[1]; nc[2] = en[2]; }
        }
        if (hit) {
          const dist = travelled + Math.hypot(eq[0] - pp[0], eq[1] - pp[1], eq[2] - pp[2]);
          if (dist > reach) break;
          // the lowest of equally near edges
          const score = dist * (1 - 0.15 * dot(dd, G));
          if (score < best) {
            best = score; found = true;
            edgeE[0] = eq[0]; edgeE[1] = eq[1]; edgeE[2] = eq[2];
            // an edge into the air goes on down the side below it: the normal pointing out, level
            const up_ = dot(en, up);
            const hx = en[0] - up_ * up[0], hy = en[1] - up_ * up[1], hz = en[2] - up_ * up[2], hl = Math.hypot(hx, hy, hz);
            if (isAir && hl > 0.2) { edgeN[0] = hx / hl; edgeN[1] = hy / hl; edgeN[2] = hz / hl; } else { edgeN[0] = en[0]; edgeN[1] = en[1]; edgeN[2] = en[2]; }
            edgeD[0] = dd[0]; edgeD[1] = dd[1]; edgeD[2] = dd[2];
          }
        }
      }
    }
    return found;
  };

  for (let r = 0; r < chosen.length; r++) {
    if ((r & 63) === 0) check?.();
    const id = r + 1, st = chosen[r];
    const u1 = r01(st.h, 1), u2 = r01(st.h, 2), u3 = r01(st.h, 3);
    // longer runs are the stronger ones: a threshold on strength drops the short ones first
    const L = lmin + (lmax - lmin) * Math.pow(0.45 * u1 + 0.55 * u2, 1.6);
    const w0 = wmin + (wmax - wmin) * u3;
    // a run is widest at its head (a small swell over the first 3 cm), thins to 30 % over its length
    const hw0 = 0.5 * w0;
    let ledgeFrom = 0, hwBase = hw0, sBase = 0, Lseg = L, sEnd = L, sBulb = 0, ampCur = 1, spills = 0;
    const hwAt = (sv: number) => hwBase * (1 - 0.7 * Math.min(1, Math.max(0, sv - sBase) / Lseg)) * (1 + 0.3 * Math.max(0, 1 - (sv - sBulb) / (0.03 * kl)));
    const bias = (r01(st.h, 4) - 0.5) * 0.5;
    const ox = r01(st.h, 6) * 97, oy = r01(st.h, 7) * 97, oz = r01(st.h, 8) * 97;
    const exitR = Math.max(0.0015 * kw, 1.2 * hw0);
    const maxHidden = Math.max(0.3 * kl, 2 * lmax);
    const first = segs.count;
    // state
    x[0] = st.q[0]; x[1] = st.q[1]; x[2] = st.q[2];
    const t0 = bvh.closestInto(x[0], x[1], x[2], 1e-3, sc);
    if (t0 < 0) continue;
    smooth(t0, sc.b0, sc.b1, sc.b2, n);
    let emerged = !srcBvh || srcBvh.closestInto(x[0], x[1], x[2], exitR, sc) < 0;
    let s = 0, hidden = 0, stuck = 0, drips = 0, reason: 'length' | 'ledge' | 'fell' | 'lost' = 'lost';
    let pa: number[] | null = emerged ? [x[0], x[1], x[2]] : null, na = [n[0], n[1], n[2]];
    lastDir[0] = G[0]; lastDir[1] = G[1]; lastDir[2] = G[2];
    nPrev[0] = n[0]; nPrev[1] = n[1]; nPrev[2] = n[2];
    let ledgeHit = false;

    /**
     * The run is on a ledge at x: a pool lens there, and when an edge of the ledge is within the spill reach the pool
     * runs to it (a trail at the pool's width) and the run goes on from the edge with less strength. False: it stays.
     */
    /** the pool lens at x: along `axis` when given, else sideways on the ledge (perpendicular to the way the run came and to its surface) */
    const pushLens = (axis?: number[]) => {
      const hp = hwAt(s) * Math.max(1, prm.pool);
      let lx: number, ly: number, lz: number;
      if (axis) { lx = axis[0]; ly = axis[1]; lz = axis[2]; } else {
        lx = lastDir[1] * nPrev[2] - lastDir[2] * nPrev[1]; ly = lastDir[2] * nPrev[0] - lastDir[0] * nPrev[2]; lz = lastDir[0] * nPrev[1] - lastDir[1] * nPrev[0];
        if (Math.hypot(lx, ly, lz) < 1e-6) { const ax = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]; lx = n[1] * ax[2] - n[2] * ax[1]; ly = n[2] * ax[0] - n[0] * ax[2]; lz = n[0] * ax[1] - n[1] * ax[0]; }
      }
      const ld = lx * n[0] + ly * n[1] + lz * n[2];
      const lv = norm3([lx - ld * n[0], ly - ld * n[1], lz - ld * n[2]]);
      const a = 2.5 * hp;
      segs.push([x[0] - lv[0] * a, x[1] - lv[1] * a, x[2] - lv[2] * a], [x[0] + lv[0] * a, x[1] + lv[1] * a, x[2] + lv[2] * a], n, n, hp, hp, s, s, id, 1, ampCur);
      return hp;
    };
    const onLedge = (): boolean => {
      const hp = pushLens();
      if (!(prm.spill > 0) || spills >= MAX_SPILLS || !findEdge(x, n, prm.spill)) return false;
      const dist = Math.hypot(edgeE[0] - x[0], edgeE[1] - x[1], edgeE[2] - x[2]);
      segs.push(x, edgeE, n, n, hwAt(s), hwAt(s), s, s + dist, id, 0, ampCur);
      s += dist; spills++; stats.spills++;
      x[0] = edgeE[0]; x[1] = edgeE[1]; x[2] = edgeE[2];
      n[0] = edgeN[0]; n[1] = edgeN[1]; n[2] = edgeN[2];
      pa = [x[0], x[1], x[2]]; na = [n[0], n[1], n[2]];
      lastDir[0] = edgeD[0]; lastDir[1] = edgeD[1]; lastDir[2] = edgeD[2];
      nPrev[0] = n[0]; nPrev[1] = n[1]; nPrev[2] = n[2];
      ledgeFrom = s + 0.012 * kw; ampCur *= SPILL_AMP; hwBase = Math.max(0.8 * hw0, 0.9 * hp); sBase = s; sBulb = s; Lseg = L; sEnd = s + Lseg; stuck = 0;
      return true;
    };
    /**
     * The bottom of a groove at x (the flow here runs back sideways the way the run came: two faces steeper than a ledge
     * meet in a valley): the water pools there, a lens along the groove, and when the groove slopes it runs on along it for
     * what is left of the run. Ends the run. False when the two faces do not meet in a line.
     */
    const valley = (): boolean => {
      const cx = nPrev[1] * n[2] - nPrev[2] * n[1], cy = nPrev[2] * n[0] - nPrev[0] * n[2], cz = nPrev[0] * n[1] - nPrev[1] * n[0];
      if (Math.hypot(cx, cy, cz) < 1e-3) return false;
      const t = norm3([cx, cy, cz]);
      if (dot(t, G) < 0) { t[0] = -t[0]; t[1] = -t[1]; t[2] = -t[2]; }
      const nb = norm3([nPrev[0] + n[0], nPrev[1] + n[1], nPrev[2] + n[2]]);
      n[0] = nb[0]; n[1] = nb[1]; n[2] = nb[2];
      pushLens(t);
      if (dot(t, G) < 0.05) { reason = 'ledge'; ledgeHit = true; return true; }
      pa = [x[0], x[1], x[2]];
      reason = 'length';
      for (let i = 0, steps = Math.ceil(Math.max(0, sEnd - s) / h); i < steps; i++) {
        const t3 = bvh.closestInto(x[0] + t[0] * h, x[1] + t[1] * h, x[2] + t[2] * h, 4 * h, sc);
        if (t3 < 0) { reason = 'fell'; break; }
        const mv = Math.hypot(sc.x - x[0], sc.y - x[1], sc.z - x[2]);
        if (mv < 0.3 * h) { reason = 'fell'; break; }
        const s1 = s + mv;
        segs.push(pa, [sc.x, sc.y, sc.z], nb, nb, hwAt(s), hwAt(s1), s, s1, id, 0, ampCur);
        s = s1; x[0] = sc.x; x[1] = sc.y; x[2] = sc.z; pa = [x[0], x[1], x[2]];
        if (s >= sEnd) break;
      }
      return true;
    };
    // a start on a ledge is a pool from the first: it spills over the nearest edge or stays
    let maxSteps = Math.ceil((L * (1 + MAX_SPILLS) + maxHidden) / h) + 200;
    if (prm.spill > 0 && dot(n, up) >= ledgeCos) {
      emerged = true; s = 1e-3 * kw; pa = [x[0], x[1], x[2]];
      if (!onLedge()) { reason = 'ledge'; ledgeHit = true; maxSteps = 0; }
    }
    for (let step = 0; step < maxSteps; step++) {
      // flow: gravity on the tangent plane, bent sideways by noise
      const gn = dot(G, n);
      d[0] = G[0] - gn * n[0]; d[1] = G[1] - gn * n[1]; d[2] = G[2] - gn * n[2];
      const dl = Math.hypot(d[0], d[1], d[2]);
      if (dl < 1e-3) { if (emerged && onLedge()) continue; reason = 'ledge'; ledgeHit = true; break; }
      d[0] /= dl; d[1] /= dl; d[2] /= dl;
      // the bottom of a groove: the flow here runs back sideways the way the run came
      if (emerged) {
        const lg = dot(lastDir, G), dg = dot(d, G);
        const ax = lastDir[0] - lg * G[0], ay = lastDir[1] - lg * G[1], az = lastDir[2] - lg * G[2];
        const bx = d[0] - dg * G[0], by = d[1] - dg * G[1], bz = d[2] - dg * G[2];
        const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
        if (la > 0.2 && lb > 0.2 && ax * bx + ay * by + az * bz < -0.2 * la * lb && valley()) break;
      }
      tx[0] = n[1] * d[2] - n[2] * d[1]; tx[1] = n[2] * d[0] - n[0] * d[2]; tx[2] = n[0] * d[1] - n[1] * d[0];
      norm3(tx);
      const lat = (noiseAt(x[0], x[1], x[2], ox, oy, oz) * 1.2 + bias) * prm.wobble;
      dir[0] = d[0] + tx[0] * lat; dir[1] = d[1] + tx[1] * lat; dir[2] = d[2] + tx[2] * lat;
      norm3(dir);
      // a surface that rises across the step (a shelf, a boss, a part sunk into the wall: the wall's own face goes on
      // buried inside it) is where the run goes on; else step and snap back onto the surface
      let air = false;
      const th = rays.nearest(x[0] + n[0] * 1e-4, x[1] + n[1] * 1e-4, x[2] + n[2] * 1e-4, dir[0], dir[1], dir[2], 1.05 * h, 1e-6);
      if (th < Infinity) {
        const tt = rays.lastTri;
        closestOnTri(bvh.T, tt * 9, x[0] + n[0] * 1e-4 + dir[0] * th, x[1] + n[1] * 1e-4 + dir[1] * th, x[2] + n[2] * 1e-4 + dir[2] * th, tp, tb);
        q[0] = tp[0]; q[1] = tp[1]; q[2] = tp[2];
        smooth(tt, tb[0], tb[1], tb[2], nq);
        neff[0] = nq[0]; neff[1] = nq[1]; neff[2] = nq[2];
      } else {
        const sx = x[0] + dir[0] * h, sy = x[1] + dir[1] * h, sz = x[2] + dir[2] * h;
        const t2 = bvh.closestInto(sx, sy, sz, 4 * h, sc);
        if (t2 < 0) { reason = 'lost'; break; }
        q[0] = sc.x; q[1] = sc.y; q[2] = sc.z;
        smooth(t2, sc.b0, sc.b1, sc.b2, nq);
        e[0] = sx - q[0]; e[1] = sy - q[1]; e[2] = sz - q[2];
        const de = Math.hypot(e[0], e[1], e[2]);
        // beyond a convex edge the gap points out of the surface: that is the normal there
        air = de > 0.3 * h && dot(e, nq) > -0.2 * de;
        if (air) { neff[0] = e[0] / de; neff[1] = e[1] / de; neff[2] = e[2] / de; } else { neff[0] = nq[0]; neff[1] = nq[1]; neff[2] = nq[2]; }
      }
      // the far side of a thin plate: the new face turns away and lies behind the old one (the two faces of a steep groove meet on it)
      if (dot(nq, n) < -0.2 && (q[0] - x[0]) * n[0] + (q[1] - x[1]) * n[1] + (q[2] - x[2]) * n[2] < -0.25 * h) { reason = 'lost'; break; }
      const move = Math.hypot(q[0] - x[0], q[1] - x[1], q[2] - x[2]);
      stuck = move < 0.1 * h ? stuck + 1 : 0;
      if (stuck >= 3) { reason = 'lost'; break; }
      lastDir[0] = (q[0] - x[0]) / (move || 1); lastDir[1] = (q[1] - x[1]) / (move || 1); lastDir[2] = (q[2] - x[2]) / (move || 1);
      nPrev[0] = n[0]; nPrev[1] = n[1]; nPrev[2] = n[2];
      x[0] = q[0]; x[1] = q[1]; x[2] = q[2];
      n[0] = nq[0]; n[1] = nq[1]; n[2] = nq[2];
      // draw
      if (!emerged) {
        hidden += move;
        if (hidden > maxHidden) { reason = 'lost'; break; }
        if (srcBvh!.closestInto(x[0], x[1], x[2], exitR, sc) < 0) { emerged = true; pa = [x[0], x[1], x[2]]; na = [n[0], n[1], n[2]]; s = 0; }
      } else {
        const s1 = s + move;
        if (pa) segs.push(pa, x, na, n, hwAt(s), hwAt(s1), s, s1, id, 0, ampCur);
        s = s1; pa = [x[0], x[1], x[2]]; na = [n[0], n[1], n[2]];
      }
      if (dot(neff, up) >= ledgeCos && s >= ledgeFrom) { if (emerged && onLedge()) continue; reason = 'ledge'; ledgeHit = true; break; }
      if (dot(neff, G) > OVERHANG) {
        // overhang: drip along gravity onto the surface below
        if (!prm.drip || drips >= MAX_DRIPS || !emerged) { reason = 'fell'; break; }
        const ex = x[0] + neff[0] * 2e-4, ey = x[1] + neff[1] * 2e-4, ez = x[2] + neff[2] * 2e-4;
        const tt = rays.nearest(ex, ey, ez, G[0], G[1], G[2], diag, 0);
        if (!(tt < Infinity)) { reason = 'fell'; break; }
        drips++; stats.drips++;
        const lx = ex + G[0] * tt, ly = ey + G[1] * tt, lz = ez + G[2] * tt;
        const t3 = bvh.closestInto(lx, ly, lz, 1e-3 + 1e-6 * diag, sc);
        if (t3 < 0) { reason = 'fell'; break; }
        x[0] = sc.x; x[1] = sc.y; x[2] = sc.z;
        smooth(t3, sc.b0, sc.b1, sc.b2, n);
        pa = [x[0], x[1], x[2]]; na = [n[0], n[1], n[2]];
        lastDir[0] = G[0]; lastDir[1] = G[1]; lastDir[2] = G[2];
        nPrev[0] = n[0]; nPrev[1] = n[1]; nPrev[2] = n[2];
        if (dot(n, up) >= ledgeCos) { if (onLedge()) continue; reason = 'ledge'; ledgeHit = true; break; }
        continue;
      }
      if (emerged && s >= sEnd) { reason = 'length'; break; }
    }
    if (!emerged && reason !== 'lost') reason = 'lost';
    const drawn = segs.count > first;
    if (!drawn) continue; // never came out from under its source
    segs.simplify(first, 0.12 * wmin, 8 * h);
    runLen.push(Math.max(s, 1e-6)); strength.push(u1); pooled.push(ledgeHit ? 1 : 0); runKey.push((hash32(st.h ^ 0x5bd1e995) % 16777215) + 1);
    stats.ended[reason]++;
    // the run number must match its slot: runs that never emerged leave no slot, so renumber this run's segments
    const slot = runLen.length - 1;
    if (slot !== id) for (let i = first; i < segs.count; i++) segs.ID[i] = slot;
  }

  const ns = segs.count;
  const rs: RunSet = {
    count: runLen.length - 1, segs: ns, kw, kl,
    A: segs.A.slice(0, ns * 6), NRM: segs.NRM.slice(0, ns * 6), HW: segs.HW.slice(0, ns * 2), SS: segs.SS.slice(0, ns * 2),
    ID: segs.ID.slice(0, ns), POOL: segs.POOL.slice(0, ns), AMP: segs.AMP.slice(0, ns), runLen: Float32Array.from(runLen), strength: Float32Array.from(strength),
    pooled: Uint8Array.from(pooled), key: Float32Array.from(runKey),
  };
  return { runs: rs, stats };
}

// ---------------------------------------------------------------- per texel

export interface RasterIn {
  /** sample positions and unit normals, 3 per sample */
  P: Float64Array;
  N: Float64Array;
  /** size of one sample in metres along the surface (the texel size over the supersampling) */
  tau: ArrayLike<number>;
  /** 1 = write nothing for this sample (the source parts themselves) */
  skip?: Uint8Array | null;
}

export interface RasterOut {
  C: Float32Array;
  along: Float32Array;
  head: Float32Array;
  strength: Float32Array;
  id: Float32Array;
  /** the broad stain around the runs (RasterOpts.stain), when asked for */
  stain?: Float32Array;
}

const smoothstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export interface RasterOpts {
  /** called now and then; may throw (a time limit) */
  check?: () => void;
  /** test every segment at every sample, without the grid (a reference for tests) */
  brute?: boolean;
  /**
   * The half width of a broad, faint stain around each run as a multiple of the run's head width (0 = none; out.stain):
   * it narrows to 45 % of that down the run, has no gaps, fades sideways ((1 − d²/w²)²) and along the run
   * ((1 − along)²) to nothing at the tail; where stains of runs meet they add up
   * (1 − Π(1 − v), one term per run), so many faint runs under an edge merge into a wash.
   */
  stain?: number;
  /** each run's stain times its strength (0..1) to this power: 0 = all alike, 2 = most faint and a few strong */
  stainSkew?: number;
  /**
   * Draw the stain exactly only at every step-th sample of the sample grid (both ways) and interpolate between them;
   * a sample whose four lattice corners are not all on its island and its surface is drawn exactly. pix is each
   * sample's index in the grid of gw × gh samples, island its uv island.
   */
  stainLattice?: { pix: Int32Array; gw: number; gh: number; step: number; island: ArrayLike<number> };
}

/**
 * The run values at every sample: the strongest run there (a stripe of the run's width, box-filtered over the sample
 * size, with gaps from 3D noise along the run and a wandering width); along, head, strength and id of that run.
 * A grid over the segments holds each one in every cell its reach touches, where the reach is the farthest a sample can
 * still be covered: the widest the run gets (width wander) plus half the filter window. The cell size follows the
 * ordinary runs; a wide pool lens just fills more cells.
 */
export function rasterRuns(rs: RunSet, inp: RasterIn, breakup: number, seed: number, out: RasterOut, opts: RasterOpts = {}): void {
  const n = inp.P.length / 3, check = opts.check;
  out.C.fill(0); out.along.fill(0); out.head.fill(0); out.strength.fill(0); out.id.fill(0);
  out.stain?.fill(0);
  if (!rs.segs || !n) return;
  const A = rs.A, ns = rs.segs;
  // the filter window of a sample is its size, but a few coarse triangles do not set the reach (the median decides)
  const stride = Math.max(1, Math.floor(n / 4096)), tv: number[] = [];
  for (let i = 0; i < n; i += stride) tv.push(inp.tau[i]);
  tv.sort((a, b) => a - b);
  const med = tv[tv.length >> 1] || 0;
  const tauCap = Math.max(1e-6, Math.min(tv[tv.length - 1] || 0, 3 * med));
  const wander = breakup > 0 ? 1 + 0.5 * breakup : 1;
  /** how far from a run segment of half width hw a sample can still be covered */
  const reachOf = (hw: number, pool: boolean, tau: number) => { const w = pool ? 1 : wander; return w * hw + 0.5 * Math.max(tau, 0.6 * w * hw); };
  const noise = makeNoise('perlin', Math.floor(seed * 131) + 91);
  const FA = 1 / (0.05 * rs.kl), FB = 1 / (0.025 * rs.kw), FW = 1 / (0.015 * rs.kl);
  const P = inp.P, N = inp.N;

  // the grid
  let items: Int32Array | null = null, count: Int32Array | null = null;
  let mnx = 0, mny = 0, mnz = 0, cs = 1, dx = 1, dy = 1, dz = 1;
  if (!opts.brute) {
    let r0 = 0, rAll = 0;
    mnx = mny = mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let k = 0; k < ns; k++) {
      const hw = Math.max(rs.HW[k * 2], rs.HW[k * 2 + 1]), r = reachOf(hw, rs.POOL[k] === 1, tauCap);
      if (rs.POOL[k] !== 1 && r > r0) r0 = r;
      if (r > rAll) rAll = r;
      for (let e = 0; e < 2; e++) {
        const x = A[k * 6 + e * 3], y = A[k * 6 + e * 3 + 1], z = A[k * 6 + e * 3 + 2];
        mnx = Math.min(mnx, x - r); mny = Math.min(mny, y - r); mnz = Math.min(mnz, z - r);
        mxx = Math.max(mxx, x + r); mxy = Math.max(mxy, y + r); mxz = Math.max(mxz, z + r);
      }
    }
    mnx -= 1e-6; mny -= 1e-6; mnz -= 1e-6;
    cs = Math.max(r0 || rAll, 1e-4);
    const dimsFor = (c: number) => [Math.max(1, Math.ceil((mxx - mnx) / c)), Math.max(1, Math.ceil((mxy - mny) / c)), Math.max(1, Math.ceil((mxz - mnz) / c))];
    let dims = dimsFor(cs);
    while (dims[0] * dims[1] * dims[2] > 2_000_000) { cs *= 1.4; dims = dimsFor(cs); }
    [dx, dy, dz] = dims;
    const cells = dx * dy * dz;
    count = new Int32Array(cells + 1);
    let total = 0;
    const range = (k: number, f: (cell: number) => void) => {
      const r = reachOf(Math.max(rs.HW[k * 2], rs.HW[k * 2 + 1]), rs.POOL[k] === 1, tauCap);
      const x0 = Math.min(A[k * 6], A[k * 6 + 3]) - r, x1 = Math.max(A[k * 6], A[k * 6 + 3]) + r;
      const y0 = Math.min(A[k * 6 + 1], A[k * 6 + 4]) - r, y1 = Math.max(A[k * 6 + 1], A[k * 6 + 4]) + r;
      const z0 = Math.min(A[k * 6 + 2], A[k * 6 + 5]) - r, z1 = Math.max(A[k * 6 + 2], A[k * 6 + 5]) + r;
      const i0 = Math.max(0, Math.floor((x0 - mnx) / cs)), i1 = Math.min(dx - 1, Math.floor((x1 - mnx) / cs));
      const j0 = Math.max(0, Math.floor((y0 - mny) / cs)), j1 = Math.min(dy - 1, Math.floor((y1 - mny) / cs));
      const k0 = Math.max(0, Math.floor((z0 - mnz) / cs)), k1 = Math.min(dz - 1, Math.floor((z1 - mnz) / cs));
      for (let kk = k0; kk <= k1; kk++) for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) f((kk * dy + jj) * dx + ii);
    };
    for (let k = 0; k < ns; k++) {
      if ((k & 255) === 0) check?.();
      range(k, (c) => { count![c + 1]++; total++; });
      if (total > limits.maxItems) throw new FlowLimit('cells', total);
    }
    for (let c = 0; c < cells; c++) count[c + 1] += count[c];
    items = new Int32Array(count[cells]);
    const fill = count.slice(0, cells);
    for (let k = 0; k < ns; k++) {
      if ((k & 255) === 0) check?.();
      range(k, (c) => { items![fill[c]++] = k; });
    }
  }
  const all = opts.brute ? Int32Array.from({ length: ns }, (_, k) => k) : null;

  for (let i = 0; i < n; i++) {
    if ((i & 4095) === 0) check?.();
    if (inp.skip && inp.skip[i]) continue;
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
    let list: Int32Array, s0: number, s1: number;
    if (all) { list = all; s0 = 0; s1 = ns; } else {
      const ci = Math.floor((px - mnx) / cs), cj = Math.floor((py - mny) / cs), ck = Math.floor((pz - mnz) / cs);
      if (ci < 0 || cj < 0 || ck < 0 || ci >= dx || cj >= dy || ck >= dz) continue;
      const cell = (ck * dy + cj) * dx + ci;
      s0 = count![cell]; s1 = count![cell + 1];
      if (s0 === s1) continue;
      list = items!;
    }
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2], tau = Math.max(1e-6, Math.min(inp.tau[i], tauCap));
    let best = 0, bk = -1, bAlong = 0;
    for (let m = s0; m < s1; m++) {
      const k = all ? m : list[m], o = k * 6;
      const ax = A[o], ay = A[o + 1], az = A[o + 2];
      const ex = A[o + 3] - ax, ey = A[o + 4] - ay, ez = A[o + 5] - az;
      const l2 = ex * ex + ey * ey + ez * ez;
      let t = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + ex * t - px, cy = ay + ey * t - py, cz = az + ez * t - pz;
      const d2 = cx * cx + cy * cy + cz * cz;
      let hw = rs.HW[k * 2] + (rs.HW[k * 2 + 1] - rs.HW[k * 2]) * t;
      const pool = rs.POOL[k] === 1;
      const reach = reachOf(hw, pool, tau);
      if (d2 > reach * reach) continue; // beyond the widest the run gets plus the filter
      const dist = Math.sqrt(d2);
      // the texel lies on the same surface: its normal agrees with the run's there
      const mx = rs.NRM[o] + (rs.NRM[o + 3] - rs.NRM[o]) * t, my = rs.NRM[o + 1] + (rs.NRM[o + 4] - rs.NRM[o + 1]) * t, mz = rs.NRM[o + 2] + (rs.NRM[o + 5] - rs.NRM[o + 2]) * t;
      if (nx * mx + ny * my + nz * mz < 0.5 * Math.sqrt(mx * mx + my * my + mz * mz)) continue;
      const id = rs.ID[k], rk = rs.key[id] % 1021;
      const sAbs = rs.SS[k * 2] + (rs.SS[k * 2 + 1] - rs.SS[k * 2]) * t;
      const along = Math.min(1, sAbs / rs.runLen[id]);
      let gate = 1;
      if (!pool && breakup > 0) {
        // gaps along the run (3D noise in drawn length and sideways offset), a width that wanders
        const side = (cx * (rs.NRM[o + 1] * ez - rs.NRM[o + 2] * ey) + cy * (rs.NRM[o + 2] * ex - rs.NRM[o] * ez) + cz * (rs.NRM[o] * ey - rs.NRM[o + 1] * ex)) > 0 ? -1 : 1;
        const u = 0.5 + 0.6 * noise(sAbs * FA + 0.37, side * dist * FB + 0.21, rk * 1.37 + 0.31);
        // the share of the run that is a gap grows toward the tail; u has a spread of about 0.17 around 0.5
        const thr = 0.5 + 0.425 * (breakup * (0.35 + 0.5 * along) - 0.5);
        gate = smoothstep(thr, thr + 0.12, u);
        hw *= 1 + 0.5 * breakup * noise(sAbs * FW + 0.13, 0.5, rk * 0.77 + 0.11);
      }
      if (gate <= 0) continue;
      // box-filtered coverage of the stripe [-hw, hw] over a window as wide as the sample or, for a soft edge, 0.6 of the run
      const win = Math.max(tau, 0.6 * hw);
      const lo = Math.max(-hw, dist - 0.5 * win), hi = Math.min(hw, dist + 0.5 * win);
      // the strength of a run dies away along it (barely there at the tail) unless it ends in a pool; a spill is weaker
      const fade = pool || rs.pooled[id] ? 1 : 1 - 0.96 * smoothstep(0.25, 1, along);
      const cov = hi > lo ? ((hi - lo) / win) * gate * fade * rs.AMP[k] : 0;
      if (cov > best) { best = cov; bk = id; bAlong = along; if (cov >= 1) break; }
    }
    if (bk < 0) continue;
    const v = Math.min(1, best);
    out.C[i] = v; out.along[i] = bAlong;
    const hd = Math.max(0, 1 - bAlong / 0.35);
    out.head[i] = v * hd * hd; out.strength[i] = rs.strength[bk]; out.id[i] = rs.key[bk];
  }
  if (out.stain && opts.stain && opts.stain > 0) rasterStain(rs, inp, tauCap, opts.stain, out.stain, opts);
}

/**
 * The broad stain (RasterOpts.stain) in its own pass: it reaches several times as far as the runs, so it has its own grid
 * (cells a sixth of its reach, so a sample tests little beyond the segments that can reach it) over the drawn segments
 * that are not pools, and the grid of the runs stays as fine as the runs.
 */
function rasterStain(rs: RunSet, inp: RasterIn, tauCap: number, K: number, stain: Float32Array, opts: RasterOpts): void {
  const n = inp.P.length / 3, A = rs.A, ns = rs.segs, check = opts.check, P = inp.P, N = inp.N;
  // the head half width of each run (its widest segment end): the stain's width at the head
  const headHW = new Float32Array(rs.runLen.length);
  // and where it is first drawn (out from under its source): the stain begins there, with no round cap above it
  const startS = new Float32Array(rs.runLen.length).fill(Infinity);
  for (let k = 0; k < ns; k++) { const id = rs.ID[k]; headHW[id] = Math.max(headHW[id], rs.HW[k * 2], rs.HW[k * 2 + 1]); if (rs.AMP[k] > 0) startS[id] = Math.min(startS[id], rs.SS[k * 2]); }
  const segs: number[] = [];
  for (let k = 0; k < ns; k++) if (rs.POOL[k] !== 1 && rs.AMP[k] > 0) segs.push(k);
  if (!segs.length) return;
  const skew = Math.max(0, opts.stainSkew ?? 0), runW = new Float32Array(rs.runLen.length);
  for (let r = 0; r < runW.length; r++) runW[r] = skew > 0 ? Math.max(0, Math.min(1, rs.strength[r])) ** skew : 1;
  /** the farthest the stain reaches from segment k (widest at the head), plus half a sample */
  const reach = (k: number) => K * headHW[rs.ID[k]] + 0.5 * tauCap;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity, rMax = 0;
  for (const k of segs) {
    const r = reach(k);
    if (r > rMax) rMax = r;
    for (let e = 0; e < 2; e++) {
      const x = A[k * 6 + e * 3], y = A[k * 6 + e * 3 + 1], z = A[k * 6 + e * 3 + 2];
      mnx = Math.min(mnx, x - r); mny = Math.min(mny, y - r); mnz = Math.min(mnz, z - r);
      mxx = Math.max(mxx, x + r); mxy = Math.max(mxy, y + r); mxz = Math.max(mxz, z + r);
    }
  }
  mnx -= 1e-6; mny -= 1e-6; mnz -= 1e-6;
  let cs = Math.max(rMax / 6, 1e-4);
  const dimsFor = (c: number) => [Math.max(1, Math.ceil((mxx - mnx) / c)), Math.max(1, Math.ceil((mxy - mny) / c)), Math.max(1, Math.ceil((mxz - mnz) / c))];
  let dims = dimsFor(cs);
  // coarser cells when the segments would register in too many (many runs, broad stains)
  const registrations = (c: number) => {
    let t = 0;
    for (const k of segs) {
      const r = reach(k), o = k * 6;
      t += (Math.floor((Math.abs(A[o + 3] - A[o]) + 2 * r) / c) + 2) * (Math.floor((Math.abs(A[o + 4] - A[o + 1]) + 2 * r) / c) + 2) * (Math.floor((Math.abs(A[o + 5] - A[o + 2]) + 2 * r) / c) + 2);
    }
    return t;
  };
  while (dims[0] * dims[1] * dims[2] > 4_000_000 || registrations(cs) > limits.maxItems / 2) { cs *= 1.4; dims = dimsFor(cs); }
  const [dx, dy, dz] = dims, cells = dx * dy * dz;
  const count = new Int32Array(cells + 1);
  let total = 0;
  const range = (k: number, f: (cell: number) => void) => {
    const r = reach(k);
    const i0 = Math.max(0, Math.floor((Math.min(A[k * 6], A[k * 6 + 3]) - r - mnx) / cs)), i1 = Math.min(dx - 1, Math.floor((Math.max(A[k * 6], A[k * 6 + 3]) + r - mnx) / cs));
    const j0 = Math.max(0, Math.floor((Math.min(A[k * 6 + 1], A[k * 6 + 4]) - r - mny) / cs)), j1 = Math.min(dy - 1, Math.floor((Math.max(A[k * 6 + 1], A[k * 6 + 4]) + r - mny) / cs));
    const k0 = Math.max(0, Math.floor((Math.min(A[k * 6 + 2], A[k * 6 + 5]) - r - mnz) / cs)), k1 = Math.min(dz - 1, Math.floor((Math.max(A[k * 6 + 2], A[k * 6 + 5]) + r - mnz) / cs));
    for (let kk = k0; kk <= k1; kk++) for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) f((kk * dy + jj) * dx + ii);
  };
  for (let m = 0; m < segs.length; m++) {
    if ((m & 255) === 0) check?.();
    range(segs[m], (c) => { count[c + 1]++; total++; });
    if (total > limits.maxItems) throw new FlowLimit('cells', total);
  }
  for (let c = 0; c < cells; c++) count[c + 1] += count[c];
  const items = new Int32Array(count[cells]), fill = count.slice(0, cells);
  for (let m = 0; m < segs.length; m++) {
    if ((m & 255) === 0) check?.();
    range(segs[m], (c) => { items[fill[c]++] = segs[m]; });
  }
  /** the stain at sample i: per run its strongest segment, the runs added up (a cell lists a run's segments in a row) */
  const stainAt = (i: number): number => {
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
    const ci = Math.floor((px - mnx) / cs), cj = Math.floor((py - mny) / cs), ck = Math.floor((pz - mnz) / cs);
    if (ci < 0 || cj < 0 || ck < 0 || ci >= dx || cj >= dy || ck >= dz) return 0;
    const cell = (ck * dy + cj) * dx + ci, s0 = count[cell], s1 = count[cell + 1];
    if (s0 === s1) return 0;
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    let rest = 1, run = -1, best = 0;
    for (let m = s0; m < s1; m++) {
      const k = items[m], o = k * 6, id = rs.ID[k];
      if (id !== run) { rest *= 1 - Math.min(1, best); run = id; best = 0; }
      const ax = A[o], ay = A[o + 1], az = A[o + 2];
      const ex = A[o + 3] - ax, ey = A[o + 4] - ay, ez = A[o + 5] - az;
      const l2 = ex * ex + ey * ey + ez * ez;
      let t = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / l2 : 0;
      // no round cap above where the run is first drawn
      if (t < 0 && rs.SS[k * 2] <= startS[id]) continue;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + ex * t - px, cy = ay + ey * t - py, cz = az + ez * t - pz;
      const d2 = cx * cx + cy * cy + cz * cz;
      const sAbs = rs.SS[k * 2] + (rs.SS[k * 2 + 1] - rs.SS[k * 2]) * t;
      const along = Math.min(1, sAbs / rs.runLen[id]);
      // widest at the head, narrowing to under half down the run: many runs under an edge merge into a wash there and
      // part into streaks lower down
      const sw = K * headHW[id] * (1 - 0.55 * along);
      if (d2 >= sw * sw) continue;
      // the sample lies on the same surface: its normal agrees with the run's there
      const mx = rs.NRM[o] + (rs.NRM[o + 3] - rs.NRM[o]) * t, my = rs.NRM[o + 1] + (rs.NRM[o + 4] - rs.NRM[o + 1]) * t, mz = rs.NRM[o + 2] + (rs.NRM[o + 5] - rs.NRM[o + 2]) * t;
      if (nx * mx + ny * my + nz * mz < 0.5 * Math.sqrt(mx * mx + my * my + mz * mz)) continue;
      const q = 1 - d2 / (sw * sw), fade = 1 - along, v = q * q * fade * fade * rs.AMP[k] * runW[id];
      if (v > best) best = v;
    }
    rest *= 1 - Math.min(1, best);
    return 1 - rest;
  };
  const lat = opts.stainLattice, f = lat ? Math.max(1, Math.floor(lat.step)) : 1;
  if (!lat || f === 1) {
    for (let i = 0; i < n; i++) {
      if ((i & 4095) === 0) check?.();
      if (!(inp.skip && inp.skip[i])) stain[i] = stainAt(i);
    }
    return;
  }
  // the lattice exactly, then every other sample from its four corners when they lie on its island and surface
  const { pix, gw, gh, island } = lat;
  const at = new Int32Array(gw * gh).fill(-1);
  for (let i = 0; i < n; i++) at[pix[i]] = i;
  const done = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if ((i & 4095) === 0) check?.();
    const x = pix[i] % gw, y = (pix[i] - x) / gw;
    if (x % f || y % f) continue;
    done[i] = 1;
    if (!(inp.skip && inp.skip[i])) stain[i] = stainAt(i);
  }
  const corner = (i: number, x: number, y: number): number => {
    if (x >= gw || y >= gh) return -1;
    const j = at[y * gw + x];
    if (j < 0 || !done[j] || (inp.skip && inp.skip[j]) || island[j] !== island[i]) return -1;
    return N[i * 3] * N[j * 3] + N[i * 3 + 1] * N[j * 3 + 1] + N[i * 3 + 2] * N[j * 3 + 2] >= 0.95 ? j : -1;
  };
  for (let i = 0; i < n; i++) {
    if ((i & 4095) === 0) check?.();
    if (done[i] || (inp.skip && inp.skip[i])) continue;
    const x = pix[i] % gw, y = (pix[i] - x) / gw, x0 = x - (x % f), y0 = y - (y % f);
    const a = corner(i, x0, y0), b = corner(i, x0 + f, y0), c = corner(i, x0, y0 + f), d = corner(i, x0 + f, y0 + f);
    if (a < 0 || b < 0 || c < 0 || d < 0) { stain[i] = stainAt(i); continue; }
    const tx = (x - x0) / f, ty = (y - y0) / f;
    stain[i] = (stain[a] * (1 - tx) + stain[b] * tx) * (1 - ty) + (stain[c] * (1 - tx) + stain[d] * tx) * ty;
  }
}

// ---------------------------------------------------------------- texel size

/**
 * Metres per texel of each triangle: sqrt(3D area / uv area in texels) (NaN where the uv area is 0). `uv` is two floats
 * per vertex of the triangulation, `tris` its vertex triples, `pos` three floats per vertex.
 */
export function triTexelSizes(pos: ArrayLike<number>, uv: ArrayLike<number>, tris: ArrayLike<number>, W: number, H: number): Float32Array {
  const nt = tris.length / 3, out = new Float32Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const wx = pos[c * 3] - pos[a * 3], wy = pos[c * 3 + 1] - pos[a * 3 + 1], wz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const a3 = 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    const au = 0.5 * Math.abs((uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) - (uv[b * 2 + 1] - uv[a * 2 + 1]) * (uv[c * 2] - uv[a * 2])) * W * H;
    out[t] = au > 1e-12 ? Math.sqrt(a3 / au) : NaN;
  }
  return out;
}
