// Node worker pool (worker_threads) behind Host.pool: runs registered kernels (src/core/kernels.ts, plus the
// wrangle kernel in src/host/worker.ts) on typed arrays.
//
//   POLYFORGE_WORKERS         number of worker threads (default: availableParallelism() - 1; 0 disables the pool)
//   POLYFORGE_WORKERS_IDLE_MS idle time after which a worker stops (default 30000)
//   POLYFORGE_POOL_MIN        overrides every kernel's size threshold (tests force the pool with 1)
//
// Workers start on demand (no thread exists until the first task), one task each at a time. Idle workers do not
// keep the process alive (unref) and stop after the idle time. A kernel error rejects its task with the kernel's
// name; a worker that crashes or exceeds the task's timeoutMs fails only that task and is replaced on demand.
// If workers cannot start at all, tasks reject with code POOL_UNAVAILABLE (parallelMap then runs on the caller).
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { PoolResult, PoolTask, WorkerPool } from './types.ts';

export interface NodePoolOptions {
  size: number;
  idleMs?: number;
  minElements?: number;
  /** worker entry module (default ./worker.ts) */
  workerUrl?: URL;
}

/** POLYFORGE_WORKERS → worker count (default: one less than the available parallelism; 0 disables). */
export function workersFromEnv(env: Record<string, string | undefined> = process.env): number {
  const v = env.POLYFORGE_WORKERS;
  if (v === undefined || v.trim() === '') {
    const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(0, n - 1);
  }
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

interface Job {
  id: number;
  task: PoolTask;
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** the shared data was re-sent after the worker reported it missing */
  resent?: boolean;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  busy: Job | null;
  /** shared keys this worker holds */
  shared: Set<string>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** set when the pool terminated the worker on purpose (timeout, idle, close): its exit is not a crash */
  retired?: boolean;
  /** uncaught error reported before the exit */
  error?: any;
}

const unavailable = (msg: string) => Object.assign(new Error(msg), { code: 'POOL_UNAVAILABLE' });

class NodeWorkerPool implements WorkerPool {
  readonly size: number;
  readonly minElements?: number;
  private idleMs: number;
  private url: URL;
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  private counters = { started: 0, tasks: 0, crashes: 0, timeouts: 0 };
  /** consecutive workers that died before becoming ready */
  private startFailures = 0;
  private broken: Error | null = null;

  constructor(o: NodePoolOptions) {
    this.size = Math.max(0, Math.floor(o.size));
    this.idleMs = o.idleMs ?? 30000;
    this.minElements = o.minElements;
    this.url = o.workerUrl ?? new URL('./worker.ts', import.meta.url);
  }

  run<T = PoolResult>(task: PoolTask): Promise<T> {
    if (this.broken) return Promise.reject(unavailable(`worker pool unavailable: ${this.broken.message}`));
    if (!(this.size > 0)) return Promise.reject(unavailable('worker pool has no threads'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, task, resolve, reject });
      this.pump();
    });
  }

  stats() {
    return {
      workers: this.slots.length, busy: this.slots.filter((s) => s.busy).length, queued: this.queue.length,
      ...this.counters,
    };
  }

  async close(): Promise<void> {
    const err = new Error('worker pool closed');
    for (const j of this.queue.splice(0)) j.reject(err);
    const exits = this.slots.map((s) => {
      s.retired = true;
      clearTimeout(s.idleTimer);
      if (s.busy) { clearTimeout(s.busy.timer); s.busy.reject(err); s.busy = null; }
      return s.worker.terminate().catch(() => 0);
    });
    this.slots = [];
    this.broken = null;
    this.startFailures = 0;
    await Promise.all(exits);
  }

  // ------------------------------------------------------------ scheduling

  private pump() {
    while (this.queue.length) {
      const slot = this.slots.find((s) => s.ready && !s.busy);
      if (!slot) break;
      this.dispatch(slot, this.queue.shift()!);
    }
    // start workers for the tasks still waiting (those already starting will take some of them)
    const starting = this.slots.filter((s) => !s.ready).length;
    for (let need = this.queue.length - starting; need > 0 && this.slots.length < this.size; need--) this.spawn();
  }

  private spawn() {
    const worker = new Worker(this.url, { name: 'polyforge-kernels' });
    const slot: Slot = { worker, ready: false, busy: null, shared: new Set() };
    this.slots.push(slot);
    this.counters.started++;
    worker.on('message', (m: any) => this.onMessage(slot, m));
    worker.on('error', (e) => { slot.error = e; });
    worker.on('exit', (code) => this.onExit(slot, code));
  }

  private dispatch(slot: Slot, job: Job) {
    const t = job.task;
    slot.busy = job;
    clearTimeout(slot.idleTimer);
    slot.worker.ref();
    let shared: { key: string; arrays?: Record<string, ArrayBufferView> } | undefined;
    if (t.shared) shared = slot.shared.has(t.shared.key) ? { key: t.shared.key } : t.shared;
    const transfer: ArrayBuffer[] = [];
    if (t.transfer) {
      for (const a of Object.values(t.arrays ?? {})) {
        const b = a.buffer;
        if (b instanceof ArrayBuffer && !transfer.includes(b)) transfer.push(b);
      }
    }
    try {
      slot.worker.postMessage({ type: 'run', id: job.id, kernel: t.kernel, args: t.args, range: t.range ?? [0, 0], arrays: t.arrays ?? {}, shared }, transfer);
    } catch (e: any) {
      slot.busy = null;
      job.reject(new Error(`kernel "${t.kernel}": cannot send the task to a worker: ${e?.message ?? e}`));
      this.idle(slot);
      return;
    }
    if (shared?.arrays) slot.shared.add(shared.key);
    const ms = t.timeoutMs ?? 0;
    if (ms > 0) {
      job.timer = setTimeout(() => {
        if (slot.busy !== job) return;
        slot.busy = null;
        this.counters.timeouts++;
        job.reject(new Error(`kernel "${t.kernel}" timed out after ${ms} ms`));
        this.retire(slot);
        this.pump();
      }, ms);
    }
  }

  private onMessage(slot: Slot, m: any) {
    if (m?.type === 'ready') {
      slot.ready = true;
      this.startFailures = 0;
      this.pump();
      if (!slot.busy) this.idle(slot);
      return;
    }
    if (m?.type !== 'result') return;
    const job = slot.busy;
    if (!job || job.id !== m.id) return; // a task that already timed out
    clearTimeout(job.timer);
    slot.busy = null;
    if (m.missingShared && !job.resent) {
      // the worker dropped the shared data from its cache: send it again with the data
      slot.shared.delete(m.missingShared);
      job.resent = true;
      this.queue.unshift(job);
    } else if (m.ok) {
      this.counters.tasks++;
      job.resolve({ value: m.value, arrays: m.arrays ?? {} });
    } else {
      this.counters.tasks++;
      const msg = m.missingShared ? `shared data "${m.missingShared}" missing in the worker` : m.error;
      const e = m.user ? new Error(msg) : new Error(`kernel "${job.task.kernel}" failed: ${msg}`);
      (e as any).kernel = job.task.kernel;
      if (m.stack) (e as any).workerStack = m.stack;
      job.reject(e);
    }
    this.pump();
    if (!slot.busy) this.idle(slot);
  }

  private onExit(slot: Slot, code: number) {
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    clearTimeout(slot.idleTimer);
    const job = slot.busy;
    slot.busy = null;
    if (slot.retired) { this.pump(); return; }
    const why = slot.error ? `${slot.error?.message ?? slot.error}` : `exit code ${code}`;
    if (!slot.ready) {
      // died while starting: after two in a row, give up (tasks run on the caller instead)
      if (++this.startFailures >= 2) {
        this.broken = new Error(`worker threads fail to start (${why})`);
        const err = unavailable(`worker pool unavailable: ${this.broken.message}`);
        for (const j of this.queue.splice(0)) j.reject(err);
        return;
      }
    }
    if (job) {
      clearTimeout(job.timer);
      this.counters.crashes++;
      job.reject(new Error(`kernel "${job.task.kernel}": worker thread crashed (${why}); it has been replaced`));
    }
    this.pump();
  }

  /** a worker without work: do not keep the process alive; stop it after idleMs */
  private idle(slot: Slot) {
    slot.worker.unref();
    clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => {
      if (slot.busy) return;
      this.retire(slot);
    }, this.idleMs);
    slot.idleTimer.unref?.();
  }

  private retire(slot: Slot) {
    slot.retired = true;
    clearTimeout(slot.idleTimer);
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    slot.worker.terminate().catch(() => 0);
  }
}

/** A worker pool, or undefined when size is 0. */
export function createNodePool(o: NodePoolOptions): WorkerPool | undefined {
  return o.size > 0 ? new NodeWorkerPool(o) : undefined;
}

/** Pool settings from the environment (POLYFORGE_WORKERS, POLYFORGE_WORKERS_IDLE_MS, POLYFORGE_POOL_MIN). */
export function poolOptionsFromEnv(env: Record<string, string | undefined> = process.env): NodePoolOptions {
  const num = (v: string | undefined) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return { size: workersFromEnv(env), idleMs: num(env.POLYFORGE_WORKERS_IDLE_MS), minElements: num(env.POLYFORGE_POOL_MIN) };
}
