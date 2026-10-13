// CookContext.parallelMap: run a registered per-element kernel (src/core/kernels.ts) over a node's arrays, in chunks
// on the host's worker pool when there is one and the job is large enough, else in one piece on this thread.
//
// Pool path: inputs, outputs and shared data are copied once into SharedArrayBuffers that every worker sees; the
// range [0, count) is split into contiguous chunks, each written by one task into its own slots of the outputs; when
// all chunks have finished the outputs are copied back into the caller's arrays. Outputs start as copies of the
// caller's arrays, so elements a kernel skips (masked out) keep their values. Inputs and results that already live in
// a SharedArrayBuffer are handed to the workers as they are (no copy in; results are written in place). Shared data
// (a BVH) also goes to the workers under a content hash, so a worker that already holds it reuses it. Failures: the
// error of the first failing chunk (in element order) rejects the run; a pool that cannot start workers falls back to
// this thread.
// Host-agnostic: needs only SharedArrayBuffer and the Host's WorkerPool.
import { KERNELS, hashArrays } from '../core/kernels.ts';
import type { KernelContext, TypedArray } from '../core/kernels.ts';
import type { PoolResult, WorkerPool } from '../host/types.ts';

export interface KernelJob {
  /** number of elements: kernels process [0, count) */
  count: number;
  /** small structured-cloneable argument (params) */
  args?: any;
  /** read-only arrays (null/undefined entries are left out, e.g. an absent group mask; shared memory is not copied) */
  inputs?: Record<string, TypedArray | null | undefined>;
  /** arrays the kernel writes per element (indexed globally); written in place */
  outputs?: Record<string, TypedArray>;
  /**
   * Like outputs, for freshly allocated (all-zero) arrays: on the pool their shared copies start zeroed instead of
   * being copied in. Elements the kernel skips come back as 0. A result that lives in a SharedArrayBuffer (all zero)
   * is written in place.
   */
  results?: Record<string, TypedArray>;
  /** large read-only data reused across chunks and cooks (cached in each worker under a content hash) */
  shared?: Record<string, TypedArray>;
  /**
   * The content key of `shared` when the caller already knows it (data reused by a series of jobs, e.g. a collider
   * queried once per simulation step): the arrays are not hashed again and their shared copies are reused by later
   * jobs with the same key. The key must change whenever the shared data does (hashArrays(shared) once is safe).
   */
  sharedKey?: string;
}

export interface ParallelOptions {
  /** elements below which the job stays on this thread (default: the kernel's minElements) */
  minElements?: number;
  /** number of chunks (default: pool size × the kernel's chunksPerWorker) */
  chunks?: number;
  /** wall-clock limit per chunk in ms (0 = none) */
  timeoutMs?: number;
  /**
   * Run the job on this thread. Required for host kernels that have no entry in KERNELS (the wrangle kernel runs in
   * the worker's realm; on this thread it runs in the main realm); registry kernels default to KERNELS[kernel].run.
   */
  serial?: () => any;
}

export interface ParallelRun {
  /** true when the job ran on worker threads */
  parallel: boolean;
  chunks: number;
  /** return values of the kernel, one per chunk, in element order */
  values: any[];
}

/** Pool usage counters (Engine.poolStats). */
export interface PoolStats {
  /** jobs that ran on worker threads */
  parallel: number;
  /** jobs that ran on the cooking thread (no pool, or below the size threshold) */
  serial: number;
  /** chunks dispatched to workers */
  chunks: number;
}

/** memo for kernels run on this thread: shared data is not cached here, so objects are built per run */
const localCtx: KernelContext = { sharedKey: '', memo: (_key, make) => make() };

const DEFAULT_MIN = 50000;

/** Shared copies of the most recent jobs that named their sharedKey (reused while the key repeats; 4 keys kept). */
const keyedShared = new Map<string, Record<string, ArrayBufferView>>();

const isShared = (a: ArrayBufferView) => a.buffer instanceof SharedArrayBuffer;

/** a read-only array as the workers see it: itself when it is shared memory already, else a shared copy */
const sharedView = <T extends TypedArray>(a: T): T => (isShared(a) ? a : sharedCopy(a));

function sharedCopy<T extends TypedArray>(a: T): T {
  const C = a.constructor as any;
  const v = new C(new SharedArrayBuffer(a.byteLength)) as T;
  v.set(a as any);
  return v;
}

function serialRun(kernel: string, job: KernelJob, opts: ParallelOptions, stats?: PoolStats): ParallelRun {
  if (stats) stats.serial++;
  if (opts.serial) return { parallel: false, chunks: 1, values: [opts.serial()] };
  const k = KERNELS[kernel];
  if (!k) throw new Error(`parallelMap: unknown kernel "${kernel}"`);
  const a: Record<string, any> = { ...job.shared };
  for (const [n, v] of Object.entries(job.inputs ?? {})) if (v) a[n] = v;
  Object.assign(a, job.outputs, job.results);
  return { parallel: false, chunks: 1, values: [k.run(job.args, a, 0, job.count, localCtx)] };
}

/**
 * Run `kernel` over job.count elements. Synchronous (returns the result, not a promise) when it runs on this
 * thread; a promise when it went to the pool.
 */
export function parallelMap(
  pool: WorkerPool | undefined, kernel: string, job: KernelJob, opts: ParallelOptions = {}, stats?: PoolStats,
): ParallelRun | Promise<ParallelRun> {
  const k = KERNELS[kernel];
  if (!k && !opts.serial) throw new Error(`parallelMap: unknown kernel "${kernel}"`);
  const min = Math.max(1, pool?.minElements ?? opts.minElements ?? k?.minElements ?? DEFAULT_MIN);
  if (!pool || !(pool.size > 0) || typeof SharedArrayBuffer === 'undefined' || !(job.count >= min) || job.count < 2)
    return serialRun(kernel, job, opts, stats);
  // A cold pool (no thread started yet) would cost its start-up (~0.1-0.3 s) on this job: run it here and start the
  // threads for the next one, which waits for them if they are still starting (their 'ready' messages are only read
  // when this thread yields to the event loop). A forced pool (minElements override, tests) always uses the threads.
  if (pool.minElements === undefined && pool.threads === 0) {
    void pool.warm(true);
    return serialRun(kernel, job, opts, stats);
  }

  const chunks = Math.max(1, Math.min(job.count, Math.floor(opts.chunks ?? pool.size * (k?.chunksPerWorker ?? 1))));
  const arrays: Record<string, ArrayBufferView> = {};
  for (const [n, v] of Object.entries(job.inputs ?? {})) if (v) arrays[n] = sharedView(v);
  const outs: [string, TypedArray, TypedArray][] = [];
  for (const [n, v] of Object.entries(job.outputs ?? {})) {
    const c = sharedCopy(v);
    arrays[n] = c;
    outs.push([n, v, c]);
  }
  const inPlace: TypedArray[] = [];
  for (const [n, v] of Object.entries(job.results ?? {})) {
    if (isShared(v)) { arrays[n] = v; inPlace.push(v); continue; }
    const c = new (v.constructor as any)(new SharedArrayBuffer(v.byteLength)) as TypedArray;
    arrays[n] = c;
    outs.push([n, v, c]);
  }
  let shared: { key: string; arrays: Record<string, ArrayBufferView> } | undefined;
  if (job.shared && Object.keys(job.shared).length) {
    const key = job.sharedKey ?? hashArrays(job.shared);
    let sa = job.sharedKey ? keyedShared.get(key) : undefined;
    if (!sa) {
      sa = {};
      for (const [n, v] of Object.entries(job.shared)) sa[n] = sharedView(v);
      if (job.sharedKey) {
        keyedShared.set(key, sa);
        if (keyedShared.size > 4) keyedShared.delete(keyedShared.keys().next().value!);
      }
    }
    shared = { key, arrays: sa };
  }
  const args = job.args;
  const tasks: Promise<PoolResult>[] = [];
  for (let c = 0; c < chunks; c++) {
    const start = Math.floor((c * job.count) / chunks), end = Math.floor(((c + 1) * job.count) / chunks);
    tasks.push(pool.run<PoolResult>({ kernel, args, range: [start, end], arrays, shared, timeoutMs: opts.timeoutMs }));
  }
  return Promise.allSettled(tasks).then((settled) => {
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      // no worker could start (e.g. the worker module failed to load): do the work here instead
      if (settled.some((r) => r.status === 'rejected' && r.reason?.code === 'POOL_UNAVAILABLE')) {
        for (const v of inPlace) v.fill(0); // chunks that did run wrote into them
        return serialRun(kernel, job, opts, stats);
      }
      throw failed.reason;
    }
    for (const [, dst, src] of outs) dst.set(src as any);
    if (stats) { stats.parallel++; stats.chunks += chunks; }
    return { parallel: true, chunks, values: settled.map((r) => (r as PromiseFulfilledResult<PoolResult>).value.value) };
  });
}

/** `f(x)` when x is a value, `x.then(f)` when it is a promise: keeps a node synchronous when its kernel ran serially. */
export function then<T, R>(x: T | Promise<T>, f: (v: T) => R): R | Promise<R> {
  return x instanceof Promise ? x.then(f) : f(x);
}
