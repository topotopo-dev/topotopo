// Baking a package's previews: .web/thumb.png (512 px matcap, or the graph's meta.thumbnail_render: a "pbr" one
// renders through the asynchronous entry, which loads MikkTSpace and the textures itself) and .web/preview.glb
// (meshopt), plus
// .web/bake.json recording the bake key they were made from. The web app never cooks in its own process (cooks
// block the event loop and cannot be cancelled): BakeQueue runs `topotopo library bake <dir>` children one at a time,
// with a shorter simulation limit, a hard time limit and a low priority. A failed bake keeps the previous files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../nodes/index.ts';
import { Engine } from '../graph/engine.ts';
import { createNodeHost } from '../host/node.ts';
import { previewGLB, thumbOptions } from '../render/preview.ts';
import { renderGeometryAsync } from '../render/raster.ts';
import { encodePNG } from '../render/png.ts';
import { bakeKey, webDir, readBakeState } from './library.ts';
import { readManifest, renameInto, writeAtomic } from '../package.ts';
import type { BakeState } from './library.ts';
import { openPackage } from '../open.ts';

export const THUMB_SIZE = 512;
/** a preview.glb above this is not written (the page shows the thumbnail instead) */
export const MAX_PREVIEW_GLB = 50 * 1024 * 1024;
/** a bake child is stopped after this */
export const BAKE_TIMEOUT_MS = 300_000;
/** the simulation limit inside a bake child (the engine's default is 600 s per node) */
export const BAKE_SIM_TIMEOUT_MS = 120_000;

/** Bake one package in this process. Never throws for a graph problem: the result (also in bake.json) says. */
export async function bakePackage(dir: string): Promise<BakeState> {
  const m = readManifest(dir);
  const key = bakeKey(dir, m);
  const out = process.env.TOPOTOPO_BAKE_OUTPUT ?? webDir(dir);
  fs.mkdirSync(out, { recursive: true });
  const t0 = performance.now();
  const finish = (s: Omit<BakeState, 'key' | 'at' | 'ms'>): BakeState => {
    const state: BakeState = { key, at: Date.now(), ms: Math.round(performance.now() - t0), ...s };
    writeAtomic(path.join(out, 'bake.json'), JSON.stringify(state, null, 1) + '\n');
    return state;
  };
  try {
    const engine = new Engine(createNodeHost({ baseDir: dir }));
    await engine.init();
    // the packages it uses, from its copies (a bake adds none), its graphs and its assets
    const ws = openPackage(engine, dir).session;
    const name = m.bake.graph ?? m.graph;
    const file = path.relative(ws.dir, ws.graphFile(name)).split(path.sep).join('/');
    const unread = ws.unread.find((x) => x.file === file);
    if (unread) return finish({ ok: false, error: `the graph file ${unread.file} cannot be read: ${unread.error}` });
    const g = ws.graphs.get(name);
    if (!g) return finish({ ok: false, error: `no default graph yet: the package has no graph "${name}" (its manifest's "graph")` });
    const r = await engine.cook(g, { target: m.bake.node, frame: m.bake.frame });
    if (!r.ok || !r.geo) return finish({ ok: false, error: r.errors.map((e) => `[${e.node}] ${e.message}`).join('\n') || 'the cook gave no geometry' });
    // the asynchronous render: shading "pbr" needs MikkTSpace and the material's textures, which it loads (a package
    // needs no preload script of its own)
    const img = await renderGeometryAsync(r.geo, thumbOptions(g, THUMB_SIZE), (p) => engine.host.readFile(p));
    const side = img.width; // a single square view tile sits above the footer
    writeAtomic(path.join(out, 'thumb.png'), encodePNG(img.rgba.subarray(0, side * side * 4), side, side, (d) => zlib.deflateSync(d, { level: 9 })));
    const glb = await previewGLB(r.geo, { compress: 'meshopt' });
    const small = glb.length <= MAX_PREVIEW_GLB;
    if (small) writeAtomic(path.join(out, 'preview.glb'), glb);
    else fs.rmSync(path.join(out, 'preview.glb'), { force: true });
    const warnings = r.warnings.map((w) => `[${w.node}] ${w.message}`);
    if (!small) warnings.push(`preview.glb would be ${(glb.length / 2 ** 20).toFixed(0)} MB (over ${MAX_PREVIEW_GLB / 2 ** 20} MB): not written`);
    return finish({ ok: true, glb: small, points: r.geo.numPoints, prims: r.geo.numPrims, warnings });
  } catch (e: any) {
    return finish({ ok: false, error: String(e?.message ?? e) });
  }
}

// ------------------------------------------------------------------------------------------------------ BakeQueue

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', import.meta.url.endsWith('.ts') ? 'cli.ts' : 'cli.js');

export interface BakeQueueOptions {
  /** called after each bake with the package folder and its new state (null: the child died without one) */
  onDone?: (dir: string, state: BakeState | null) => void;
  onChange?: (dir?: string) => void;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export interface BakeItem {
  dir: string;
  state: 'waiting' | 'baking' | 'done' | 'failed' | 'skipped';
  startedAt?: number;
  ms?: number;
  error?: string;
}

export interface BakeSnapshot {
  paused: boolean;
  items: BakeItem[];
  done: number;
  failed: number;
  skipped: number;
  total: number;
  leftMs?: number;
}

/** Bakes in child processes, one at a time, each package once however often it is asked for meanwhile. */
export class BakeQueue {
  private items = new Map<string, BakeItem>();
  private order: BakeItem[] = [];
  private waiting = 0;
  private lastMs = new Map<string, number>();
  private skippedKeys = new Map<string, string>();
  private running: BakeItem | null = null;
  private child: ReturnType<typeof spawn> | null = null;
  private closed = false;
  private paused = false;
  private endedAt?: number;
  private opts: BakeQueueOptions;
  constructor(opts: BakeQueueOptions = {}) { this.opts = opts; }

  /** Ask for a bake; true when it was added or moved to the front. */
  add(dir: string, { first = false } = {}): boolean {
    if (this.closed) return false;
    this.skippedKeys.delete(dir);
    const previous = this.items.get(dir);
    if (previous?.state === 'baking') return false;
    const head = first ? this.order.find((item) => item.state === 'waiting') : undefined;
    if (previous?.state === 'waiting') {
      if (!head || head === previous) return false;
      this.order.splice(this.order.indexOf(previous), 1);
      this.order.splice(this.order.indexOf(head), 0, previous);
    } else {
      if (!this.size) { this.items.clear(); this.order = []; this.lastMs.clear(); this.endedAt = undefined; }
      else if (previous) this.order.splice(this.order.indexOf(previous), 1);
      const item: BakeItem = { dir, state: 'waiting' };
      this.items.set(dir, item);
      const ms = readBakeState(dir)?.ms;
      if (ms !== undefined && Number.isFinite(ms) && ms >= 0) this.lastMs.set(dir, ms);
      else this.lastMs.delete(dir);
      if (head) this.order.splice(this.order.indexOf(head), 0, item);
      else this.order.push(item);
      this.waiting++;
    }
    this.changed(dir);
    this.next();
    return true;
  }

  state(dir: string) { return this.items.get(dir)?.state; }
  pending(dir: string) { const state = this.state(dir); return state === 'waiting' || state === 'baking'; }
  get size() { return this.waiting + (this.running?.state === 'baking' ? 1 : 0); }
  get finishedAt() { return this.endedAt; }

  snapshot(now = Date.now()): BakeSnapshot {
    let done = 0, failed = 0, skipped = 0, timed = 0, finishedMs = 0;
    for (const { state, ms } of this.order) {
      if (state === 'done') done++;
      if (state === 'failed') failed++;
      if (state === 'skipped') skipped++;
      if ((state === 'done' || state === 'failed') && ms !== undefined) { timed++; finishedMs += ms; }
    }
    const average = timed ? finishedMs / timed : undefined;
    let leftMs = 0, estimated = true;
    for (const { dir, state, startedAt } of this.order) {
      if (state !== 'waiting' && state !== 'baking') continue;
      const ms = this.lastMs.get(dir) ?? average;
      if (ms === undefined) { estimated = false; break; }
      leftMs += Math.max(0, ms - (startedAt === undefined ? 0 : Math.max(0, now - startedAt)));
    }
    return { paused: this.paused, items: this.order.map((item) => ({ ...item })), done, failed, skipped, total: this.order.length, ...(estimated ? { leftMs } : {}) };
  }

  pause() {
    if (this.closed || this.paused) return;
    this.paused = true;
    this.changed();
  }

  resume() {
    if (this.closed || !this.paused) return;
    this.paused = false;
    this.changed();
    this.next();
  }

  wasSkipped(dir: string, key: string) {
    const skipped = this.skippedKeys.get(dir);
    if (skipped === key) return true;
    if (skipped !== undefined) this.skippedKeys.delete(dir);
    return false;
  }

  skip(dir: string): boolean {
    const item = this.items.get(dir);
    if (!item || !this.pending(dir)) return false;
    try { this.skippedKeys.set(dir, bakeKey(dir, readManifest(dir))); } catch { /* the package was removed */ }
    if (item === this.running) {
      item.ms = Date.now() - item.startedAt!;
      this.child?.kill();
    } else this.waiting--;
    item.state = 'skipped';
    this.changed(dir);
    return true;
  }

  private changed(dir?: string) {
    if (!this.size && this.items.size) this.endedAt ??= Date.now();
    this.opts.onChange?.(dir);
  }

  /** Resolves when nothing is queued or running. */
  async idle(): Promise<void> {
    while (this.running || this.size) await new Promise((r) => setTimeout(r, 50));
  }

  /**
   * Stop for good the way a person would: nothing queued is started, a bake that is running is given `limitMs` to finish
   * (it writes its files whole or not at all), and is ended only after that.
   */
  async stop(limitMs: number): Promise<void> {
    this.dropWaiting();
    for (const t0 = Date.now(); this.running && Date.now() - t0 < limitMs; ) await new Promise((r) => setTimeout(r, 50));
    this.child?.kill();
  }

  close() {
    this.dropWaiting();
    this.child?.kill();
  }

  private dropWaiting() {
    this.closed = true;
    if (!this.waiting) return;
    for (const item of this.order) if (item.state === 'waiting') this.items.delete(item.dir);
    this.order = this.order.filter((item) => item.state !== 'waiting');
    this.waiting = 0;
    this.changed();
  }

  private next() {
    if (this.running || this.closed || this.paused) return;
    const item = this.order.find((item) => item.state === 'waiting');
    if (!item) return;
    const { dir } = item;
    const t0 = item.startedAt = Date.now();
    item.state = 'baking';
    this.waiting--;
    this.running = item;
    const out = webDir(dir);
    let stage: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let stderr = '';
    const finish = (why: string) => {
      clearTimeout(timer);
      if (item.state !== 'skipped') {
        let state: BakeState | null = null;
        try {
          const result = stage && fs.existsSync(path.join(stage, 'bake.json')) ? JSON.parse(fs.readFileSync(path.join(stage, 'bake.json'), 'utf8')) as BakeState : null;
          if (result && stage) {
            if (result.ok) {
              renameInto(path.join(stage, 'thumb.png'), path.join(out, 'thumb.png'));
              if (result.glb) renameInto(path.join(stage, 'preview.glb'), path.join(out, 'preview.glb'));
              else fs.rmSync(path.join(out, 'preview.glb'), { force: true });
            }
            renameInto(path.join(stage, 'bake.json'), path.join(out, 'bake.json'));
            state = result;
          }
        } catch (e) { why = `could not save the preview files: ${e instanceof Error ? e.message : String(e)}`; }
        item.ms = state?.ms ?? Date.now() - t0;
        // A timeout or crash has no result to publish. Record it so the same bake is not asked for in a loop.
        if (!state) {
          try {
            const failed: BakeState = { key: bakeKey(dir, readManifest(dir)), at: Date.now(), ok: false, error: why, ms: item.ms };
            fs.mkdirSync(out, { recursive: true });
            writeAtomic(path.join(out, 'bake.json'), JSON.stringify(failed, null, 1) + '\n');
            state = failed;
          } catch { /* the folder may be gone by now */ }
        }
        item.state = state?.ok ? 'done' : 'failed';
        if (!state?.ok) item.error = state?.error ?? why;
        this.opts.log?.(`bake ${dir}: ${state?.ok ? `ok in ${state.ms} ms` : `failed: ${item.error}`}`);
        this.opts.onDone?.(dir, state);
        this.changed(dir);
      }
      if (stage) try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* the temporary files are no longer used */ }
      this.child = null;
      this.running = null;
      this.next();
    };
    try {
      // The child prepares files privately so Skip can leave the previous preview untouched.
      if (!fs.existsSync(out)) fs.mkdirSync(out);
      // a web app that was ended during a bake leaves its private folder behind: it is of no use now
      for (const e of fs.readdirSync(out)) if (e.startsWith('.bake-')) try { fs.rmSync(path.join(out, e), { recursive: true, force: true }); } catch { /* in use: left for the next bake */ }
      stage = fs.mkdtempSync(path.join(out, '.bake-'));
      const child = spawn(process.execPath, [cli, 'library', 'bake', dir], {
        env: { ...process.env, TOPOTOPO_BAKE_OUTPUT: stage, TOPOTOPO_SIM_TIMEOUT_MS: process.env.TOPOTOPO_SIM_TIMEOUT_MS ?? String(BAKE_SIM_TIMEOUT_MS) },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      try { if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed: normal priority */ }
      let spawnError: string | undefined;
      child.on('error', (e) => { spawnError = e.message; });
      child.stderr?.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
      timer = setTimeout(() => child.kill(), this.opts.timeoutMs ?? BAKE_TIMEOUT_MS);
      timer.unref();
      child.on('close', (code, signal) => {
        const why = signal ? `stopped after ${((Date.now() - t0) / 1000).toFixed(0)} s (the bake time limit is ${(this.opts.timeoutMs ?? BAKE_TIMEOUT_MS) / 1000} s)`
          : spawnError ?? (stderr.trim().split('\n').slice(-3).join(' ') || `the preview stopped unexpectedly (code ${code})`);
        finish(why);
      });
    } catch (e) {
      this.changed(dir);
      finish(e instanceof Error ? e.message : String(e));
      return;
    }
    this.changed(dir);
  }
}
