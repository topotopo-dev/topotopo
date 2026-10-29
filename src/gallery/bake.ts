// Baking a project's previews: .gallery/thumb.png (512 px matcap, or the graph's meta.thumbnail_render: a "pbr" one
// renders through the asynchronous entry, which loads MikkTSpace and the textures itself) and .gallery/preview.glb
// (meshopt), plus
// .gallery/bake.json recording the bake key they were made from. The gallery never cooks in its own process (cooks
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
import { Session } from '../session.ts';
import { previewGLB, thumbOptions } from '../render/preview.ts';
import { renderGeometryAsync } from '../render/raster.ts';
import { encodePNG } from '../render/png.ts';
import { bakeKey, galleryDir, readBakeState } from './library.ts';
import { readManifest, writeAtomic } from '../project.ts';
import type { BakeState } from './library.ts';
import { openPackages } from '../packages/registry.ts';

export const THUMB_SIZE = 512;
/** a preview.glb above this is not written (the page shows the thumbnail instead) */
export const MAX_PREVIEW_GLB = 50 * 1024 * 1024;
/** a bake child is stopped after this */
export const BAKE_TIMEOUT_MS = 300_000;
/** the simulation limit inside a bake child (the engine's default is 600 s per node) */
export const BAKE_SIM_TIMEOUT_MS = 120_000;

/** Bake one project in this process. Never throws for a graph problem: the result (also in bake.json) says. */
export async function bakeProject(dir: string): Promise<BakeState> {
  const m = readManifest(dir);
  const key = bakeKey(dir, m);
  const out = galleryDir(dir);
  fs.mkdirSync(out, { recursive: true });
  const t0 = performance.now();
  const finish = (s: Omit<BakeState, 'key' | 'at' | 'ms'>): BakeState => {
    const state: BakeState = { key, at: Date.now(), ms: Math.round(performance.now() - t0), ...s };
    writeAtomic(path.join(out, 'bake.json'), JSON.stringify(state, null, 1) + '\n');
    return state;
  };
  try {
    const engine = new Engine(createNodeHost({ baseDir: dir }));
    if (process.env.TOPOTOPO_SIM_TIMEOUT_MS) engine.simTimeoutMs = Number(process.env.TOPOTOPO_SIM_TIMEOUT_MS);
    if (process.env.TOPOTOPO_SCRIPT_TIMEOUT_MS) engine.scriptTimeoutMs = Number(process.env.TOPOTOPO_SCRIPT_TIMEOUT_MS);
    await engine.init();
    // the packages the project uses, from its copies (a bake adds none)
    openPackages(engine, dir);
    const ws = new Session(dir, engine);
    ws.load();
    const name = m.bake.graph ?? m.graph;
    const g = ws.graphs.get(name);
    if (!g) return finish({ ok: false, error: `no default graph yet: the project has no graph "${name}" (project.json "graph")` });
    const r = await engine.cook(g, { target: m.bake.node, frame: m.bake.frame });
    if (!r.ok || !r.geo) return finish({ ok: false, error: r.errors.map((e) => `[${e.node}] ${e.message}`).join('\n') || 'the cook gave no geometry' });
    // the asynchronous render: shading "pbr" needs MikkTSpace and the material's textures, which it loads (a project
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
  /** called after each bake with the project folder and its new state (null: the child died without one) */
  onDone?: (dir: string, state: BakeState | null) => void;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Bakes in child processes, one at a time, each project once however often it is asked for meanwhile. */
export class BakeQueue {
  private queue: string[] = [];
  private running: string | null = null;
  private child: ReturnType<typeof spawn> | null = null;
  private closed = false;
  private opts: BakeQueueOptions;
  constructor(opts: BakeQueueOptions = {}) { this.opts = opts; }

  /** Ask for a bake; true when it was queued now (false: queued or running already). */
  add(dir: string): boolean {
    if (this.closed || this.running === dir || this.queue.includes(dir)) return false;
    this.queue.push(dir);
    this.next();
    return true;
  }

  pending(dir: string) { return this.running === dir || this.queue.includes(dir); }
  get size() { return this.queue.length + (this.running ? 1 : 0); }

  /** Resolves when nothing is queued or running. */
  async idle(): Promise<void> {
    while (this.size) await new Promise((r) => setTimeout(r, 50));
  }

  close() {
    this.closed = true;
    this.queue = [];
    this.child?.kill();
  }

  private next() {
    if (this.running || this.closed) return;
    const dir = this.queue.shift();
    if (!dir) return;
    this.running = dir;
    const t0 = Date.now();
    const child = spawn(process.execPath, [cli, 'library', 'bake', dir], {
      env: { ...process.env, TOPOTOPO_SIM_TIMEOUT_MS: process.env.TOPOTOPO_SIM_TIMEOUT_MS ?? String(BAKE_SIM_TIMEOUT_MS) },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    try { if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed: normal priority */ }
    let stderr = '';
    child.stderr?.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
    const timer = setTimeout(() => child.kill(), this.opts.timeoutMs ?? BAKE_TIMEOUT_MS);
    timer.unref();
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      this.child = null;
      this.running = null;
      let state = readBakeState(dir);
      // killed (time limit) or crashed: record it, so the page says why and the same key is not retried in a loop
      if (!state || state.at < t0) {
        const why = signal ? `stopped after ${((Date.now() - t0) / 1000).toFixed(0)} s (the bake time limit is ${(this.opts.timeoutMs ?? BAKE_TIMEOUT_MS) / 1000} s)` : `the bake process failed (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`;
        try {
          state = { key: bakeKey(dir, readManifest(dir)), at: Date.now(), ok: false, error: why };
          fs.mkdirSync(galleryDir(dir), { recursive: true });
          writeAtomic(path.join(galleryDir(dir), 'bake.json'), JSON.stringify(state, null, 1) + '\n');
        } catch { state = null; }
      }
      this.opts.log?.(`bake ${dir}: ${state?.ok ? `ok in ${state.ms} ms` : `failed: ${state?.error ?? 'no result'}`}`);
      this.opts.onDone?.(dir, state);
      this.next();
    });
  }
}
