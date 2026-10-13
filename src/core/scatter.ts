// Scatter on the worker pool: the stages of the scatter node (src/nodes/copy.ts) and heightfield_scatter that run in
// chunks through CookContext.parallelMap (kernels registered in kernels.ts), and the serial steps between them.
//
//   scatter_candidates       area-weighted surface candidates: triangle, barycentrics, position. The seeded draws
//                            come from rngAt (candidate k takes draws 3k+1..3k+3), so chunks need no shared state.
//   scatter_elim_neighbours  weighted sample elimination with one radius: each candidate's neighbour list and the
//                            weight contributions (1 - d / r)^8, per KD-tree slot; the heap that removes candidates
//                            stays serial (sampleEliminate).
//   scatter_elim_pairs       the same with radii that follow the density: each candidate's interacting pairs, summed
//                            into the weights here in discovery order.
//   scatter_conflicts        exact minimum distance: each candidate's earlier candidates closer than r, on the hash
//                            grid PointGrid uses; the greedy pass over them is serial (minDistanceSelectWith).
//   scatter_relax            one relaxation pass: each point's repulsion from its neighbours, then the closest point
//                            on the surface and its spacing there.
// Every kernel does the floating-point operations of the serial code it replaces, in its order, and the serial
// steps consume the chunks in element order, so the pool on and off give the same bits (test/pool.ts). Without a
// RunKernel (or below a kernel's size threshold) everything runs here in one piece. Host-agnostic.
import { KDTree, neighbourBuffer } from './spatial.ts';
import type { TriBVHArrays } from './spatial.ts';
import { PointGrid, TriSurface, cellKey, minDistanceSelect } from './pcg.ts';
import type { TriPoint } from './pcg.ts';
import { hash32, rngAt } from './random.ts';
import { hypot3 } from './math.ts';
import type { TypedArray } from './kernels.ts';

/** A job for RunKernel (the shape of CookContext.parallelMap's KernelJob). */
export interface ScatterJob {
  count: number;
  args?: any;
  inputs?: Record<string, TypedArray | null | undefined>;
  outputs?: Record<string, TypedArray>;
  results?: Record<string, TypedArray>;
  shared?: Record<string, TypedArray>;
}

/** CookContext.parallelMap: runs a registered kernel in chunks on the worker pool, or in one piece here. */
export type RunKernel = (kernel: string, job: ScatterJob, opts?: { minElements?: number; chunks?: number }) =>
  { values: any[] } | Promise<{ values: any[] }>;

type Maybe<T> = T | Promise<T>;
/** f(x) for a value, x.then(f) for a promise (f may return a promise: it is flattened either way). */
const then = <T, R>(x: Maybe<T>, f: (v: T) => R | Promise<R>): Maybe<R> => (x instanceof Promise ? x.then(f) : f(x));

/** Run a kernel through `run`, or here over all elements with `range` when there is none. The chunks' return values. */
function runKernel(
  run: RunKernel | undefined, kernel: string, job: ScatterJob, minElements: number,
  range: (args: any, A: Record<string, any>, start: number, end: number) => any,
): Maybe<any[]> {
  if (run) return then(run(kernel, job, { minElements }), (r) => r.values);
  const A: Record<string, any> = { ...job.shared };
  for (const [n, v] of Object.entries(job.inputs ?? {})) if (v) A[n] = v;
  Object.assign(A, job.outputs, job.results);
  return [range(job.args, A, 0, job.count)];
}

// ---------------------------------------------------------------- KD tree

/** Build the deferred ranges (lo, hi pairs in A.ranges) [start, end) of a KD tree given as arrays (TP, idx, axis). */
export function kdBuildRange(_a: unknown, A: Record<string, any>, start: number, end: number): void {
  const kd = KDTree.fromArrays(A as any), R: Int32Array = A.ranges;
  for (let e = start; e < end; e++) kd.buildRange(R[e * 2], R[e * 2 + 1]);
}

/**
 * new KDTree(P), with the lower levels built in chunks on the pool (kd_build): the top levels here until the ranges
 * are small enough to give every thread a few, then each range in a worker. The same tree as the serial build.
 */
export function buildKDTree(P: Float64Array, run?: RunKernel): Maybe<KDTree> {
  const n = P.length / 3;
  if (!run || n < 1024) return new KDTree(P);
  const kd = new KDTree(P, undefined, Math.ceil(n / 48));
  const ranges = Int32Array.from(kd.deferred);
  const job: ScatterJob = { count: ranges.length / 2, inputs: { ranges }, outputs: kd.arrays() };
  // the job counts ranges, so the size threshold (64k points) is applied here; a forced pool still takes it
  return then(runKernel(run, 'kd_build', job, n >= 65536 ? 2 : Infinity, kdBuildRange), () => kd);
}

// ---------------------------------------------------------------- candidates

export interface CandidateArgs {
  /** rngState(seed) of the node's generator */
  state: number;
  /** last value of the area CDF */
  total: number;
  /** triangles */
  nt: number;
}

/**
 * Candidates [start, end): candidate k takes draws 3k+1 (where along the area CDF), 3k+2 and 3k+3 (barycentrics:
 * s1 = sqrt(u), s2 = v, weights 1 - s1, s1 (1 - s2), s1 s2). A: cdf (per triangle), tp (point of each corner),
 * P; writes candT, candW (3 per candidate), pos (3 per candidate).
 */
export function candidatesRange(a: CandidateArgs, A: Record<string, any>, start: number, end: number): void {
  const cdf: Float64Array = A.cdf, tp: Int32Array = A.tp, P: Float64Array = A.P;
  const candT: Int32Array = A.candT, candW: Float64Array = A.candW, pos: Float64Array = A.pos;
  const nt = a.nt, total = a.total, s0 = a.state;
  for (let k = start; k < end; k++) {
    const x = rngAt(s0, 3 * k + 1) * total;
    let lo = 0, hi = nt - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < x) lo = mid + 1; else hi = mid; }
    const t = lo;
    const s1 = Math.sqrt(rngAt(s0, 3 * k + 2)), s2 = rngAt(s0, 3 * k + 3);
    const w0 = 1 - s1, w1 = s1 * (1 - s2), w2 = s1 * s2;
    const i0 = tp[t * 3] * 3, i1 = tp[t * 3 + 1] * 3, i2 = tp[t * 3 + 2] * 3;
    for (let c = 0; c < 3; c++) pos[k * 3 + c] = w0 * P[i0 + c] + w1 * P[i1 + c] + w2 * P[i2 + c];
    candT[k] = t; candW[k * 3] = w0; candW[k * 3 + 1] = w1; candW[k * 3 + 2] = w2;
  }
}

/**
 * `count` area-weighted candidates on triangles (corner points tp, cumulative areas × weights cdf), drawn from the
 * generator with start state `state`: the draws rng() would give in that order, so the result is what the serial loop
 * makes, on the pool or not.
 */
export function surfaceCandidates(
  P: Float64Array, tp: Int32Array, cdf: Float64Array, count: number, state: number, run?: RunKernel,
): Maybe<{ candT: Int32Array; candW: Float64Array; pos: Float64Array }> {
  const candT = new Int32Array(count), candW = new Float64Array(count * 3), pos = new Float64Array(count * 3);
  const nt = cdf.length, args: CandidateArgs = { state, total: nt ? cdf[nt - 1] : 0, nt };
  const job: ScatterJob = { count, args, inputs: { cdf, tp, P }, results: { candT, candW, pos } };
  return then(runKernel(run, 'scatter_candidates', job, 65536, candidatesRange), () => ({ candT, candW, pos }));
}

// ---------------------------------------------------------------- weighted sample elimination

/**
 * One radius: for KD-tree slots [start, end), each candidate's neighbours within r2 = 2 rmax (as KDTree.neighbours
 * lists them, self excluded, as slot labels) and their contributions (1 - min(d, r2) / r2)^8; deg[s] and w[s] (the
 * sum in list order) are written per slot, the lists returned for the chunk.
 */
export function elimNeighboursRange(a: { r2: number }, A: Record<string, any>, start: number, end: number): { list: Int32Array; con: Float64Array } {
  const kd = KDTree.fromArrays(A as any), TP: Float64Array = A.TP, order: Int32Array = A.idx, labelOf: Int32Array = A.labelOf;
  const deg: Int32Array = A.deg, w: Float64Array = A.w, r2 = a.r2;
  const buf = neighbourBuffer();
  let list = new Int32Array(Math.max(16, (end - start) * 24)), con = new Float64Array(list.length), len = 0;
  for (let s = start; s < end; s++) {
    const i = order[s], ax = TP[s * 3], ay = TP[s * 3 + 1], az = TP[s * 3 + 2];
    const m = kd.neighbours(ax, ay, az, r2, buf);
    if (len + m > list.length) {
      const n = Math.max(len + m, list.length * 2), gl = new Int32Array(n), gc = new Float64Array(n);
      gl.set(list); gc.set(con); list = gl; con = gc;
    }
    const idx = buf.idx, l0 = len;
    let ws = 0;
    for (let k = 0; k < m; k++) {
      const j = idx[k];
      if (j === i) continue;
      const b = labelOf[j];
      // |a - b| is symmetric bit for bit, so both ends of a pair get the same contribution
      const d = hypot3(ax - TP[b * 3], ay - TP[b * 3 + 1], az - TP[b * 3 + 2]);
      const c = Math.pow(1 - Math.min(d, r2) / r2, 8);
      list[len] = b; con[len] = c; len++;
      ws += c;
    }
    deg[s] = len - l0;
    w[s] = ws;
  }
  return { list: list.slice(0, len), con: con.slice(0, len) };
}

/**
 * Radii that follow the density (candidate i has rmax · scale[i]): for candidates [start, end) in point order, the
 * pairs (i, j) found from i's side (the side with the larger radius, ties by index), d < rmax (s_i + s_j), with their
 * contribution (1 - d / (rmax (s_i + s_j)))^8, in discovery order; pc[i] = i's pair count.
 */
export function elimPairsRange(a: { rmax: number }, A: Record<string, any>, start: number, end: number): { pj: Int32Array; pf: Float64Array } {
  const kd = KDTree.fromArrays(A as any), pos: Float64Array = A.pos, scale: Float64Array = A.scale, pc: Int32Array = A.pc;
  const rmax = a.rmax, buf = neighbourBuffer();
  let pj = new Int32Array(Math.max(16, (end - start) * 12)), pf = new Float64Array(pj.length), np = 0;
  for (let i = start; i < end; i++) {
    const si = scale[i], x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const m = kd.neighbours(x, y, z, 2 * rmax * si, buf);
    if (np + m > pj.length) {
      const n = Math.max(np + m, pj.length * 2), gj = new Int32Array(n), gf = new Float64Array(n);
      gj.set(pj); gf.set(pf); pj = gj; pf = gf;
    }
    const idx = buf.idx, p0 = np;
    for (let k = 0; k < m; k++) {
      const j = idx[k];
      if (j === i || scale[j] > si || (scale[j] === si && j < i)) continue;
      const rr = rmax * (si + scale[j]);
      const d = hypot3(x - pos[j * 3], y - pos[j * 3 + 1], z - pos[j * 3 + 2]);
      if (d >= rr) continue;
      pj[np] = j; pf[np] = Math.pow(1 - d / rr, 8); np++;
    }
    pc[i] = np - p0;
  }
  return { pj: pj.slice(0, np), pf: pf.slice(0, np) };
}

/**
 * Weighted sample elimination (Yuksel 2015) – picks a well-spaced subset of candidates. With `scale`, candidate i has
 * the radius rmax × scale[i] (pairs use the mean of their radii), so the spacing follows a varying density (smaller
 * radii where points should be denser); without it every candidate has rmax.
 *
 * Each point's neighbour list (as KDTree.neighbours orders it) and each pair's weight contribution (1 - d / r)^8 are
 * computed once into CSR arrays (in chunks on the pool when `run` is given: scatter_elim_neighbours /
 * scatter_elim_pairs) and reused when a removal lowers the neighbours' weights; the max-heap keeps the weights of its
 * slots next to the slots. Without scale, everything runs on the KD-tree's slot numbering (points in tree order, for
 * locality); with scale, pairs are found in point order and their weights accumulate in that order. The heap does the
 * same operations on the same weights (entries relabelled), so the kept subset is the same as the straightforward
 * version's, with or without the pool. Returns the kept indices, ascending.
 */
export function sampleEliminate(pos: Float64Array, target: number, rmax: number, scale?: ArrayLike<number>): Int32Array;
export function sampleEliminate(pos: Float64Array, target: number, rmax: number, scale: ArrayLike<number> | undefined, run: RunKernel | undefined): Maybe<Int32Array>;
export function sampleEliminate(pos: Float64Array, target: number, rmax: number, scale?: ArrayLike<number>, run?: RunKernel): Maybe<Int32Array> {
  const n = pos.length / 3;
  if (target >= n) return Int32Array.from({ length: n }, (_, i) => i);
  return then(buildKDTree(pos, run), (kd: KDTree) => {
    const tree = kd.arrays();
    if (!scale) {
      const order = kd.idx, labelOf = new Int32Array(n);
      for (let a = 0; a < n; a++) labelOf[order[a]] = a;
      const deg = new Int32Array(n), w = new Float64Array(n);
      const job: ScatterJob = { count: n, args: { r2: 2 * rmax }, inputs: { ...tree, labelOf }, results: { deg, w } };
      return then(runKernel(run, 'scatter_elim_neighbours', job, 32768, elimNeighboursRange), (chunks: { list: Int32Array; con: Float64Array }[]) => {
        const start = new Int32Array(n + 1);
        for (let a = 0; a < n; a++) start[a + 1] = start[a] + deg[a];
        const { nbr, con } = concatLists(chunks, start[n]);
        return eliminate(n, target, start, nbr, con, w, labelOf);
      });
    }
    const sc = scale instanceof Float64Array ? scale : Float64Array.from(scale);
    const pc = new Int32Array(n);
    const job: ScatterJob = { count: n, args: { rmax }, inputs: { ...tree, pos, scale: sc }, results: { pc } };
    return then(runKernel(run, 'scatter_elim_pairs', job, 32768, elimPairsRange), (chunks: { pj: Int32Array; pf: Float64Array }[]) => {
      // weights summed in discovery order (i ascending, each i's pairs in list order); each pair is listed at both
      // ends, and its removal weight equals its creation weight (same distance, same summed radius): stored with it
      const w = new Float64Array(n), deg = new Int32Array(n);
      for (let i = 0, c = 0, e = 0; i < n; i++) {
        for (let k = pc[i]; k > 0; k--) {
          while (e >= chunks[c].pj.length) { c++; e = 0; }
          const j = chunks[c].pj[e], f = chunks[c].pf[e]; e++;
          w[i] += f; w[j] += f;
          deg[i]++; deg[j]++;
        }
      }
      const start = new Int32Array(n + 1);
      for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
      const nbr = new Int32Array(start[n]), con = new Float64Array(start[n]), fill = start.slice(0, n);
      for (let i = 0, c = 0, e = 0; i < n; i++) {
        for (let k = pc[i]; k > 0; k--) {
          while (e >= chunks[c].pj.length) { c++; e = 0; }
          const j = chunks[c].pj[e], f = chunks[c].pf[e]; e++;
          nbr[fill[i]] = j; con[fill[i]++] = f;
          nbr[fill[j]] = i; con[fill[j]++] = f;
        }
      }
      return eliminate(n, target, start, nbr, con, w, null);
    });
  });
}

/** The chunks' lists end to end (one chunk: its arrays as they are). */
function concatLists(chunks: { list: Int32Array; con: Float64Array }[], len: number): { nbr: Int32Array; con: Float64Array } {
  if (chunks.length === 1) return { nbr: chunks[0].list, con: chunks[0].con };
  const nbr = new Int32Array(len), con = new Float64Array(len);
  let o = 0;
  for (const c of chunks) { nbr.set(c.list, o); con.set(c.con, o); o += c.list.length; }
  return { nbr, con };
}

/**
 * The elimination itself: remove the heaviest candidate until `target` remain, lowering its neighbours' weights by
 * their pair's contribution. Labels are KD slots (labelOf maps point → slot) or point indices (labelOf null).
 *
 * An indexed binary max-heap (heap[k] = label at position k, hw[k] = its current weight, where[label] = its position,
 * -1 once removed). Elements sift down through a hole (the children move up, the element is written once), which
 * leaves every element where the swap-by-swap version leaves it (same comparisons, ties to the left child). Weights
 * only decrease, so an updated element only ever sinks. The heap holds each weight, so w is only read to fill it.
 */
function eliminate(
  n: number, target: number, start: Int32Array, nbr: Int32Array, con: Float64Array, w: Float64Array, labelOf: Int32Array | null,
): Int32Array {
  const heap = new Int32Array(n), where = new Int32Array(n), hw = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = labelOf ? labelOf[i] : i; heap[i] = a; where[a] = i; hw[i] = w[a]; }
  let size = n;
  for (let k = (size >> 1) - 1; k >= 0; k--) siftDown(heap, hw, where, size, k, heap[k], hw[k]);
  while (size > target) {
    const a = heap[0];
    where[a] = -1;
    // the last element takes the root and sinks
    size--;
    if (size > 0) siftDown(heap, hw, where, size, 0, heap[size], hw[size]);
    for (let e = start[a]; e < start[a + 1]; e++) {
      const b = nbr[e], k = where[b];
      if (k < 0) continue;
      siftDown(heap, hw, where, size, k, b, hw[k] - con[e]);
    }
  }
  const out = new Int32Array(size);
  for (let i = 0, o = 0; i < n; i++) if (where[labelOf ? labelOf[i] : i] >= 0) out[o++] = i;
  return out;
}

/**
 * Put label x with weight wx at position k of the heap (size `size`) and let it sink below every child heavier than it
 * (the heavier child first, the left one on ties). A module function, so the optimised code keeps its call target from
 * one call to the next (per-call closures made every later call deoptimise).
 */
function siftDown(heap: Int32Array, hw: Float64Array, where: Int32Array, size: number, k: number, x: number, wx: number) {
  for (;;) {
    const l = 2 * k + 1, r = l + 1;
    let m = k, mw = wx;
    if (l < size && hw[l] > mw) { m = l; mw = hw[l]; }
    if (r < size && hw[r] > mw) { m = r; mw = hw[r]; }
    if (m === k) break;
    const c = heap[m];
    heap[k] = c; hw[k] = mw; where[c] = k;
    k = m;
  }
  heap[k] = x; hw[k] = wx; where[x] = k;
}

// ---------------------------------------------------------------- exact minimum distance

export interface ConflictArgs {
  /** the first candidate (position in the order) of this job */
  k0: number;
  r2: number;
  /** 1 / cell size (cell = r, as PointGrid) and the cells searched around a point (PointGrid's span) */
  inv: number;
  span: number;
  /** bucket = cell key & mask */
  mask: number;
}

/**
 * Candidates k0 + [start, end) of the order: the earlier candidates (positions k2 < k) closer than r (d² < r²), found
 * in the (2 span + 1)³ cells around k as PointGrid keys them (same cell function, same key, same distance test), as
 * positions in the order; cnt[k - k0] = their number.
 */
export function conflictsRange(a: ConflictArgs, A: Record<string, any>, start: number, end: number): Int32Array {
  const P: Float64Array = A.P, order: Int32Array = A.order, key: Int32Array = A.key, bstart: Int32Array = A.bstart, items: Int32Array = A.items;
  const cnt: Int32Array = A.cnt, r2 = a.r2, inv = a.inv, span = a.span, mask = a.mask, k0 = a.k0;
  let list = new Int32Array(Math.max(16, (end - start) * 8)), len = 0;
  for (let q = start; q < end; q++) {
    const k = k0 + q, i = order[k], x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv), l0 = len;
    for (let ix = cx - span; ix <= cx + span; ix++)
      for (let iy = cy - span; iy <= cy + span; iy++)
        for (let iz = cz - span; iz <= cz + span; iz++) {
          const ck = cellKey(ix, iy, iz), b = ck & mask;
          for (let e = bstart[b]; e < bstart[b + 1]; e++) {
            const k2 = items[e];
            if (k2 >= k) break;
            if (key[k2] !== ck) continue;
            const j = order[k2];
            const dx = P[j * 3] - x, dy = P[j * 3 + 1] - y, dz = P[j * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz < r2) {
              if (len === list.length) { const g = new Int32Array(len * 2); g.set(list); list = g; }
              list[len++] = k2;
            }
          }
        }
    cnt[q] = len - l0;
  }
  return list.slice(0, len);
}

/**
 * minDistanceSelect (pcg.ts) with the distance tests on the pool: greedy dart throwing over candidates in the given
 * order, a candidate kept when accept(i) allows it and no kept point is closer than r, until `limit` are kept; kept(i)
 * is told about every kept one. The candidates are bucketed once by the cells PointGrid would use; each one's earlier
 * candidates closer than r are listed in chunks (scatter_conflicts), and the greedy pass then only checks those lists
 * against the kept flags, so it keeps exactly the candidates minDistanceSelect keeps. The lists are made in blocks
 * of growing size, so a pass that reaches `limit` early does not list the rest. Dense cases (many candidates per cell,
 * where the lists would be long and the greedy grid is cheap) and a non-finite r run minDistanceSelect itself.
 * Returns the kept candidate indices in the order they were kept.
 */
export function minDistanceSelectWith(
  P: Float64Array, order: ArrayLike<number>, r: number, limit = Infinity,
  accept?: (i: number) => boolean, kept?: (i: number) => void, run?: RunKernel,
): Maybe<Int32Array> {
  const m = order.length;
  if (!(r > 0) || !Number.isFinite(r) || m < 2) return minDistanceSelect(P, order, r, limit, accept, kept);
  // PointGrid's cell function: cell = r, inv = 1 / cell, keys of floor(P · inv)
  const pg = new PointGrid(P, r), inv = 1 / pg.cell, span = Math.max(1, Math.ceil(r * inv));
  let tsize = 16;
  while (tsize < 2 * m) tsize *= 2;
  const mask = tsize - 1, ord = Int32Array.from(order), key = new Int32Array(m), bstart = new Int32Array(tsize + 1);
  for (let k = 0; k < m; k++) {
    const i = ord[k];
    key[k] = cellKey(Math.floor(P[i * 3] * inv), Math.floor(P[i * 3 + 1] * inv), Math.floor(P[i * 3 + 2] * inv));
    bstart[(key[k] & mask) + 1]++;
  }
  // dense: the average candidate shares its bucket with many others
  let same = 0;
  for (let b = 1; b <= tsize; b++) same += bstart[b] * bstart[b];
  if (same > 24 * m) return minDistanceSelect(P, order, r, limit, accept, kept);
  for (let b = 0; b < tsize; b++) bstart[b + 1] += bstart[b];
  const items = new Int32Array(m), fill = bstart.slice(0, tsize);
  for (let k = 0; k < m; k++) items[fill[key[k] & mask]++] = k;
  const keptFlag = new Uint8Array(m), out: number[] = [];
  const r2 = r * r;
  // blocks of candidates: lists for [k0, k1), then the greedy pass over them
  const step = (k0: number, size: number): Maybe<Int32Array> => {
    const k1 = Math.min(m, k0 + size), cnt = new Int32Array(k1 - k0);
    const args: ConflictArgs = { k0, r2, inv, span, mask };
    const job: ScatterJob = { count: k1 - k0, args, inputs: { P, order: ord, key, bstart, items }, results: { cnt } };
    return then(runKernel(run, 'scatter_conflicts', job, 16384, conflictsRange), (lists: Int32Array[]) => {
      let li = 0, e = 0, list = lists[0];
      let k = k0;
      for (; k < k1 && out.length < limit; k++) {
        const q = k - k0, c = cnt[q];
        // this candidate's conflicts: the next c entries of the chunk lists
        let conflict = false;
        for (let t = 0; t < c; t++) {
          while (e >= list.length) { li++; list = lists[li]; e = 0; }
          if (keptFlag[list[e++]]) conflict = true;
        }
        const i = ord[k];
        if (accept && !accept(i)) continue;
        if (conflict) continue;
        keptFlag[k] = 1;
        out.push(i);
        if (kept) kept(i);
      }
      if (k < m && out.length < limit) return step(k1, size * 2);
      return Int32Array.from(out);
    });
  };
  const first = Number.isFinite(limit) ? Math.max(4096, Math.ceil(limit * 1.25)) : m;
  return step(0, first);
}

// ---------------------------------------------------------------- relaxation on a surface

export interface RelaxArgs {
  /** largest spacing of this pass */
  smax: number;
  /** fixed spacing (relax_radius > 0), else from the density */
  radius: number;
  /** the spacing follows the corner weights cw */
  weighted: boolean;
  /** mean spacing and mean weight */
  dBar: number;
  wMean: number;
}

/**
 * Spacing at a surface point (triangle t, barycentrics b0..b2): radius when set; dBar without weights; else
 * dBar · sqrt(wMean / weight), clamped to 0.25..4 dBar (4 dBar where the weight is 0). The weight is the corner
 * weights cw interpolated (summed in corner order from 0).
 */
export function relaxSpacing(a: RelaxArgs, cw: Float64Array | null, t: number, b0: number, b1: number, b2: number): number {
  if (a.radius > 0) return a.radius;
  if (!a.weighted || !cw) return a.dBar;
  const wl = relaxWeight(cw, t, b0, b1, b2);
  const s = wl > 0 ? a.dBar * Math.sqrt(a.wMean / wl) : 4 * a.dBar;
  return Math.min(4 * a.dBar, Math.max(0.25 * a.dBar, s));
}

/** The corner weights of triangle t interpolated at barycentrics b0..b2 (summed in corner order from 0). */
export function relaxWeight(cw: Float64Array, t: number, b0: number, b1: number, b2: number): number {
  let s = 0;
  s += b0 * cw[t * 3]; s += b1 * cw[t * 3 + 1]; s += b2 * cw[t * 3 + 2];
  return s;
}

/**
 * One relaxation pass for points [start, end) (relaxPoints' operations, then the surface projection): each point moves
 * away from the neighbours closer than the pair spacing (S_i + S_j) / 2 by half the overlap per neighbour (coincident
 * pairs push along a direction hashed from the pair), the move capped at half its spacing, then to the closest point
 * on the surface, where it takes the triangle, barycentrics and spacing. A: the KD tree of the pass (TP, idx, axis),
 * P and S of the pass (read), nP, nS, tri, bary (written; a point the surface does not return keeps its values), the
 * surface (TriSurface.arrays()) and cw (corner weights, may be absent).
 */
export function relaxRange(a: RelaxArgs, A: Record<string, any>, start: number, end: number, surf: TriSurface): void {
  const kd = KDTree.fromArrays(A as any), P: Float64Array = A.P, S: Float64Array = A.S;
  const nP: Float64Array = A.nP, nS: Float64Array = A.nS, tri: Int32Array = A.tri, bary: Float64Array = A.bary;
  const cw: Float64Array | null = A.cw && A.cw.length ? A.cw : null, smax = a.smax;
  const buf = neighbourBuffer(), tp: TriPoint = { x: 0, y: 0, z: 0, b0: 1, b1: 0, b2: 0 };
  for (let i = start; i < end; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], si = S[i];
    let dx = 0, dy = 0, dz = 0;
    if (si > 0) {
      const m = kd.neighbours(x, y, z, (si + smax) / 2, buf), idx = buf.idx;
      for (let k = 0; k < m; k++) {
        const j = idx[k];
        if (j === i) continue;
        const rest = (si + S[j]) / 2;
        let ex = x - P[j * 3], ey = y - P[j * 3 + 1], ez = z - P[j * 3 + 2];
        let d = hypot3(ex, ey, ez);
        if (d >= rest) continue;
        if (d < 1e-12) {
          // coincident: push in a direction that depends on the pair only
          const h = hash32(Math.min(i, j) * 7919 + Math.max(i, j));
          const ang = (h / 4294967296) * Math.PI * 2;
          ex = Math.cos(ang); ey = 0; ez = Math.sin(ang); d = 1;
          if (i > j) { ex = -ex; ez = -ez; }
          const push = rest * 0.5;
          dx += ex * push; dy += ey * push; dz += ez * push;
          continue;
        }
        const push = (rest - d) * 0.5 / d;
        dx += ex * push; dy += ey * push; dz += ez * push;
      }
      const len = hypot3(dx, dy, dz), cap = 0.5 * si;
      if (len > cap) { const s = cap / len; dx *= s; dy *= s; dz *= s; }
    }
    const t = surf.closest(x + dx, y + dy, z + dz, tp);
    if (t < 0) continue;
    nP[i * 3] = tp.x; nP[i * 3 + 1] = tp.y; nP[i * 3 + 2] = tp.z;
    tri[i] = t; bary[i * 3] = tp.b0; bary[i * 3 + 1] = tp.b1; bary[i * 3 + 2] = tp.b2;
    nS[i] = relaxSpacing(a, cw, t, tp.b0, tp.b1, tp.b2);
  }
}

/**
 * Lloyd-style relaxation of points on a surface (relaxPoints with the closest-point projection), `iterations` passes
 * in chunks on the pool (scatter_relax). P, S (spacing), tri and bary (the points' triangles and barycentrics) are
 * updated in place. The KD tree of each pass is built here; the surface goes to the workers once (shared, cached).
 */
export function relaxOnSurface(
  surf: TriSurface, P: Float64Array, S: Float64Array, tri: Int32Array, bary: Float64Array, iterations: number,
  base: Omit<RelaxArgs, 'smax'>, cw: Float64Array | null, run?: RunKernel,
): Maybe<void> {
  const n = S.length;
  if (n < 2 || !(iterations > 0)) return;
  const shared: Record<string, TypedArray> = { ...(surf.arrays() as Required<TriBVHArrays> & { C: Float64Array }) };
  if (cw) shared.cw = cw;
  const pass = (it: number): Maybe<void> => {
    if (it >= iterations) return;
    let smax = 0;
    for (let i = 0; i < n; i++) if (S[i] > smax) smax = S[i];
    if (!(smax > 0)) return;
    return then(buildKDTree(P, run), (kd: KDTree) => {
      const nP = P.slice(), nS = S.slice();
      const args: RelaxArgs = { ...base, smax };
      const job: ScatterJob = { count: n, args, inputs: { ...kd.arrays(), P, S }, outputs: { nP, nS, tri, bary }, shared };
      return then(runKernel(run, 'scatter_relax', job, 2048, (ar, A, s, e) => relaxRange(ar, A, s, e, surf)), () => {
        P.set(nP); S.set(nS);
        return pass(it + 1);
      });
    });
  };
  return pass(0);
}
