// The engine core never touches Node or DOM APIs directly; a Host supplies them.
// src/host/node.ts implements this for Node (MCP server, CLI). A browser host
// (Web Worker + fetch/OPFS) can implement the same interface for the future GUI.

/**
 * A job for a worker thread: run the registered kernel `kernel` (src/core/kernels.ts, or a host kernel such as
 * 'wrangle') on typed arrays plus a small JSON argument.
 */
export interface PoolTask {
  kernel: string;
  /** small structured-cloneable argument */
  args?: any;
  /** element range handed to the kernel (kernels index arrays globally and process [start, end)) */
  range?: [number, number];
  /**
   * Arrays the kernel reads and writes. SharedArrayBuffer-backed arrays are shared with the worker (the kernel writes
   * straight into them); others are copied in, or moved when `transfer` is true (the caller's arrays are detached).
   * The worker hands the non-shared arrays back in the result, moved, not copied.
   */
  arrays?: Record<string, ArrayBufferView>;
  /** the caller allows moving the ArrayBuffers of `arrays` to the worker instead of copying them */
  transfer?: boolean;
  /**
   * Read-only data reused across tasks (e.g. a BVH), cached in each worker under `key` (a content hash): it is sent
   * only to workers that do not hold it yet, and the kernel can memoise objects built from it under the same key.
   */
  shared?: { key: string; arrays: Record<string, ArrayBufferView> };
  /** wall-clock limit in ms (0 / absent = none): the task fails with a "timed out" error and its worker is replaced */
  timeoutMs?: number;
}

/** What a pool task resolves with: the kernel's return value and the task's non-shared arrays, handed back. */
export interface PoolResult<V = any> {
  value: V;
  arrays: Record<string, ArrayBufferView>;
}

/**
 * Worker threads for per-element kernels (worker_threads in Node; Web Workers in a browser host). Workers start on
 * the first task and stop when idle. A failing kernel rejects its task with an error naming the kernel; a crashed or
 * timed-out worker fails only its own task and is replaced.
 */
export interface WorkerPool {
  /** number of worker threads (at most this many tasks run at once) */
  readonly size: number;
  /** override of every kernel's size threshold (elements below which work stays on the calling thread), for tests */
  readonly minElements?: number;
  /** threads running or starting (0 = cold: the next task would wait for a thread to start) */
  readonly threads: number;
  /**
   * Start every thread now; resolves when they are up. `background`: the starting threads do not keep the process
   * alive (parallelMap warms a cold pool this way while it runs its first job on the calling thread).
   */
  warm(background?: boolean): Promise<void>;
  run<T = PoolResult>(task: PoolTask): Promise<T>;
  /** stop all workers; pending tasks fail. The pool restarts on the next run. */
  close(): Promise<void>;
  /** counters for tests and diagnostics */
  stats(): { workers: number; busy: number; queued: number; started: number; tasks: number; crashes: number; timeouts: number };
}

/**
 * The realm "=expr" parameter expressions run in (src/graph/expr.ts), separate from the script realm and used by
 * nothing else: the engine installs the expression library there, freezes the realm's built-ins and disables its
 * Function constructors.
 */
export interface ExprSandbox {
  /** Evaluate a script in the sandbox realm and return its completion value (the engine compiles functions with it). */
  compile(source: string): any;
  /** Parse `body` as a function body without running it (as Host.checkSyntax). */
  checkSyntax(body: string): { message: string; line: number } | null;
  /**
   * Call `job` with a wall-clock limit. Microtasks the realm queues while it runs (continuations of async code) also
   * run before `run` returns, inside the limit. On timeout `job` is stopped wherever it is and a "timed out" error is
   * thrown.
   */
  run(job: () => void, timeoutMs: number): void;
}

export interface Host {
  name: string;
  /** Read a file (or URL) as bytes. */
  readFile(path: string): Promise<Uint8Array>;
  /**
   * Directory (path or URL, read with readFile) of the shipped asset shelf: `index.json` there lists the asset files.
   * The engine registers them as node types of category "shelf" on init. Absent = no shelf.
   */
  shelfPath?: string;
  /** A string that changes when the file changes (mtime+size), for cache keys. */
  fileStamp(path: string): string;
  resolvePath(path: string): string;
  /**
   * Compile JS source inside the scripting realm (which has the snippet library
   * installed) and return the resulting value (usually a function).
   */
  compile(source: string): any;
  /**
   * Parse `body` as a function body without running it. Returns the first syntax error, with its 1-based line in
   * `body`, or null when it parses. A body that parses is complete: it cannot close a wrapper it is pasted into.
   */
  checkSyntax?(body: string): { message: string; line: number } | null;
  /** Run fn with a wall-clock limit; throws on timeout. */
  runGuarded<T>(fn: () => T, timeoutMs?: number): T;
  /**
   * Where "=expr" expressions are compiled and run. Absent: the engine compiles them with `new Function` in its own
   * realm, with the same restricted names but no realm isolation and no timeout, so such a host must not cook
   * graphs from untrusted sources.
   */
  exprSandbox?: ExprSandbox;
  /**
   * Run an async fn from the scripting realm with a wall-clock limit that also covers its continuations: code the
   * realm runs after an `await` is time-limited like synchronous code, and the whole run (including time spent in
   * engine calls it awaits) must finish within timeoutMs. fn receives `wake`: call it when a promise from outside
   * the realm that the code may be awaiting settles, so the realm continues without polling delay.
   * Rejects with a "timed out" error on timeout.
   */
  runGuardedAsync<T>(fn: (wake: () => void) => T | Promise<T>, timeoutMs?: number): Promise<T>;
  /** Locate a font file: explicit path, family name, or a platform default. */
  findFont(name?: string): string | null;
  /**
   * All candidate font files for a request, best first (the first entry equals findFont(name)).
   * Callers try them in order because not every system font parses (opentype.js rejects some GSUB tables).
   */
  fontCandidates?(name?: string): string[];
  /**
   * Worker pool for chunked kernels (CookContext.parallelMap) and the signal to cook independent graph branches
   * concurrently. Absent (TOPOTOPO_WORKERS=0, or a host without threads): everything runs on the calling thread.
   */
  pool?: WorkerPool;
}
