// Demo video footage: render the engine shots of docs/release/demo-shots.json
// into out/video/<id>/frame_0001.png …, with the left-pane graph excerpt next to them as out/video/<id>/left.txt;
// --assemble then encodes out/video/<id>.mp4 per shot and out/video/contact_sheet.png with ffmpeg (if it is on PATH).
//   node scripts/demo-footage.ts [--shot id[,id…]] [--jobs N] [--assemble] [--no-render] [--limit N] [--out dir] [--list]
//     --shot      only these shots (ids from the shot list; default all)
//     --jobs N    processes per shot, each rendering a contiguous run of the missing frames (default: cores / 2, max 8)
//     --assemble  after rendering, encode the mp4s and the contact sheet (H.264 High, yuv420p, BT.709, the list's fps)
//     --no-render only assemble what is on disk
//     --limit N   render at most the first N frames of each shot (a quick look; the rest stay missing)
//     --out dir   output folder (default out/video)
//     --list      print the shots and exit
// Orbit shots cook once and move the camera (the render API, no re-cook per frame); sequence shots cook their frames
// in order so simulation state carries over (Engine.cookFrames, as the CLI's --frames), each process starting at the
// first frame of its run (rbd_* and particles give the same state however the frames are split). Frames match CLI
// renders with the same options, except the footer title, which is the example's name without "@ frame N".
// Deterministic and resumable: frames that exist are skipped (each is written to a temp file and renamed, so an
// interrupted run leaves no partial PNG); when a shot's render fields or its graph file change, its old frames are
// removed first (out/video/<id>/stamp.txt).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import type { CookReport } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { openPackages } from '../src/packages/registry.ts';
import { renderGeometry } from '../src/render/raster.ts';
import type { RenderOptions } from '../src/render/raster.ts';
import { renderArgs } from '../src/render/options.ts';
import { encodePNG } from '../src/render/png.ts';
import type { Geometry } from '../src/core/geometry.ts';

interface LeftExcerpt { file: string; paths: string[]; note?: string }
interface Shot {
  id: string;
  plan: string;
  graph: string;
  kind: 'orbit' | 'sequence' | 'still';
  set?: Record<string, unknown>;
  target?: string;
  title?: string;
  render: Record<string, unknown>;
  orbit?: { azimuth: number; degrees_per_frame: number; frames: number };
  frames?: [number, number];
  sim_fps?: number;
  seconds?: number;
  /** [width, height, y]: cut this from the frame (y: top edge; default centred on the square view tile) */
  crop?: [number, number, number?];
  caption?: string;
  left?: LeftExcerpt[];
}
interface ShotList { fps: number; pane: [number, number]; shots: Shot[] }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (f: string) => argv.includes(f);
const OUT = path.resolve(opt('--out') ?? path.join(ROOT, 'out', 'video'));
const LIST = path.join(ROOT, 'docs', 'release', 'demo-shots.json');
const FOOTER_BG = '1f1f21'; // the render's footer colour (raster.ts fills the image with 0.12, 0.12, 0.13)

const list: ShotList = JSON.parse(fs.readFileSync(LIST, 'utf8'));
const want = opt('--shot')?.split(',').map((s) => s.trim()).filter(Boolean);
if (want) for (const id of want) if (!list.shots.some((s) => s.id === id)) {
  console.error(`unknown shot "${id}" (${list.shots.map((s) => s.id).join(', ')})`);
  process.exit(1);
}
const shots = list.shots.filter((s) => !want || want.includes(s.id));
const limit = opt('--limit') !== undefined ? Number(opt('--limit')) : Infinity;
const part = opt('--part'); // internal: "k/N", a child process rendering the k-th of N runs of one shot's missing frames
const jobs = Math.max(1, Math.min(16, Number(opt('--jobs') ?? Math.min(8, Math.floor(os.availableParallelism() / 2))) || 1));

const frameCount = (s: Shot) => (s.kind === 'orbit' ? s.orbit!.frames : s.kind === 'sequence' ? s.frames![1] - s.frames![0] + 1 : 1);
const frameName = (i: number) => `frame_${String(i).padStart(4, '0')}.png`;
const shotDir = (s: Shot) => path.join(OUT, s.id);
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

if (flag('--list')) {
  for (const s of list.shots) console.log(`${s.id.padEnd(24)} ${s.kind.padEnd(8)} ${String(frameCount(s)).padStart(4)} frames  ${s.graph}  — ${s.plan}`);
  process.exit(0);
}

// ---------------------------------------------------------------- graph and render options

/** The shot's graph with its `set` edits applied (dotted paths; objects are created as needed). */
function shotGraph(s: Shot): any {
  const g = JSON.parse(fs.readFileSync(path.join(ROOT, s.graph), 'utf8'));
  for (const [key, value] of Object.entries(s.set ?? {})) {
    const parts = key.split('.');
    let o = g;
    for (const k of parts.slice(0, -1)) o = o[k] ??= {};
    o[parts[parts.length - 1]] = value;
  }
  return g;
}

/** RenderOptions as the CLI builds them (renderArgs + views, colorBy, checker, title), so frames match CLI renders. */
function shotRender(s: Shot, title: string): RenderOptions {
  const r = s.render;
  return { ...renderArgs(r), colorBy: (r.color_by as string | undefined) ?? null, checker: r.checker === true, title };
}

/** The footer title: the example's name (the CLI adds "@ frame N" on sequences, which pushes the footer past 960 px). */
const titleOf = (s: Shot) => s.title ?? path.basename(s.graph, '.json');

function writePNG(file: string, img: { rgba: Uint8Array; width: number; height: number }) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, encodePNG(img.rgba, img.width, img.height, (d) => zlib.deflateSync(d)));
  fs.renameSync(tmp, file);
}

function cookError(s: Shot, r: CookReport): Error {
  return new Error(`${s.id}: ${s.graph} failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
}

async function newEngine(s: Shot): Promise<Engine> {
  const engine = new Engine(createNodeHost({ baseDir: path.dirname(path.join(ROOT, s.graph)) }));
  await engine.init();
  // a graph of a package (examples/ is one) cooks the packages it names from the package's copies
  openPackages(engine, path.dirname(path.join(ROOT, s.graph)));
  return engine;
}

// ---------------------------------------------------------------- left pane excerpts

/** Text spans of object members: "nodes.w" → [offset of the key, offset after the value). */
function memberSpans(src: string): Map<string, [number, number]> {
  const spans = new Map<string, [number, number]>();
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const str = () => { i++; while (src[i] !== '"') i += src[i] === '\\' ? 2 : 1; i++; };
  const value = (p: string) => {
    ws();
    const c = src[i];
    if (c === '{') {
      i++; ws();
      while (src[i] !== '}') {
        const k0 = i;
        str();
        const key = JSON.parse(src.slice(k0, i));
        ws(); i++; // ':'
        const sub = p ? `${p}.${key}` : key;
        value(sub);
        spans.set(sub, [k0, i]);
        ws();
        if (src[i] === ',') { i++; ws(); }
      }
      i++;
    } else if (c === '[') {
      i++; ws();
      while (src[i] !== ']') { value(''); ws(); if (src[i] === ',') { i++; ws(); } }
      i++;
    } else if (c === '"') str();
    else while (i < src.length && !/[\s,\]}]/.test(src[i])) i++;
  };
  value('');
  return spans;
}

/** The lines of each named member, verbatim and in file order, each run of lines headed by its file and line numbers. */
function excerpt(e: LeftExcerpt): string {
  const src = fs.readFileSync(path.join(ROOT, e.file), 'utf8').replace(/\r\n/g, '\n');
  const spans = memberSpans(src);
  const lineOf = (off: number) => src.slice(0, off).split('\n').length - 1;
  const ranges = e.paths.map((p) => {
    const sp = spans.get(p);
    if (!sp) throw new Error(`left: ${e.file} has no member "${p}"`);
    return [lineOf(sp[0]), lineOf(sp[1] - 1)] as [number, number];
  }).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const lines = src.split('\n');
  const out: string[] = [];
  if (e.note) out.push(`// ${e.note}`);
  for (const [a, b] of merged) out.push(`// ${e.file}, line${a === b ? ` ${a + 1}` : `s ${a + 1}-${b + 1}`}`, ...lines.slice(a, b + 1));
  return out.join('\n');
}

function writeLeft(s: Shot) {
  if (!s.left?.length) return;
  fs.mkdirSync(shotDir(s), { recursive: true });
  fs.writeFileSync(path.join(shotDir(s), 'left.txt'), s.left.map(excerpt).join('\n\n') + '\n');
}

// ---------------------------------------------------------------- rendering

interface ShotStats { id: string; frames: number; jobs: number; rendered: number; cookMs: number; renderMs: number; wallMs: number; width: number; height: number }

const missing = (s: Shot) => {
  const n = Math.min(frameCount(s), limit);
  const out: number[] = [];
  for (let i = 1; i <= n; i++) if (!fs.existsSync(path.join(shotDir(s), frameName(i)))) out.push(i);
  return out;
};

/** Orbit and still shots: cook once, render the frames `todo` (1-based) with the camera turned per frame. */
async function renderCamera(s: Shot, todo: number[]): Promise<Omit<ShotStats, 'id' | 'frames' | 'jobs' | 'wallMs'>> {
  const engine = await newEngine(s);
  const t0 = performance.now();
  const r = await engine.cook(shotGraph(s), { target: s.target });
  if (!r.ok || !r.geo) throw cookError(s, r);
  const cookMs = performance.now() - t0;
  const geo: Geometry = r.geo;
  let renderMs = 0, width = 0, height = 0;
  for (const i of todo) {
    const t1 = performance.now();
    const ro = shotRender(s, titleOf(s));
    if (s.kind === 'orbit') ro.azimuth = +(s.orbit!.azimuth + (i - 1) * s.orbit!.degrees_per_frame).toFixed(6);
    const img = renderGeometry(geo, ro);
    writePNG(path.join(shotDir(s), frameName(i)), img);
    renderMs += performance.now() - t1;
    width = img.width; height = img.height;
  }
  await engine.host.pool?.close();
  return { rendered: todo.length, cookMs, renderMs, width, height };
}

/** Sequence shots: cook the frames in order from the first missing one; render the missing frames. */
async function renderSequence(s: Shot, todo: number[]): Promise<Omit<ShotStats, 'id' | 'frames' | 'jobs' | 'wallMs'>> {
  const engine = await newEngine(s);
  const [first] = s.frames!;
  const want = new Set(todo.map((i) => first + i - 1));
  const end = first + todo[todo.length - 1] - 1;
  let cookMs = 0, renderMs = 0, width = 0, height = 0, n = 0;
  const res = await engine.cookFrames(shotGraph(s), { start: first + todo[0] - 1, end }, async (r, f) => {
    if (!r.ok || !r.geo) throw cookError(s, r);
    cookMs += r.ms;
    if (!want.has(f)) return;
    const t1 = performance.now();
    const img = renderGeometry(r.geo, shotRender(s, titleOf(s)));
    writePNG(path.join(shotDir(s), frameName(f - first + 1)), img);
    renderMs += performance.now() - t1;
    width = img.width; height = img.height; n++;
  }, { target: s.target, fps: s.sim_fps });
  if (res.failed.length) throw new Error(`${s.id}: frames failed: ${res.failed.join(', ')}`);
  await engine.host.pool?.close();
  return { rendered: n, cookMs, renderMs, width, height };
}

/** Run n child processes on one shot, each rendering a contiguous run of the missing frames. */
async function renderParallel(s: Shot, n: number): Promise<Omit<ShotStats, 'id' | 'frames' | 'jobs' | 'wallMs'>> {
  const script = fileURLToPath(import.meta.url);
  const runs = Array.from({ length: n }, (_, k) => new Promise<any>((resolve, reject) => {
    const args = [script, '--shot', s.id, '--part', `${k}/${n}`, '--out', OUT, ...(Number.isFinite(limit) ? ['--limit', String(limit)] : [])];
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      const m = /^PART (.*)$/m.exec(text);
      if (code !== 0 || !m) reject(new Error(`${s.id}: part ${k}/${n} exited with ${code}\n${text}`));
      else resolve(JSON.parse(m[1]));
    });
  }));
  const parts = await Promise.all(runs);
  return {
    rendered: parts.reduce((a, p) => a + p.rendered, 0),
    cookMs: parts.reduce((a, p) => a + p.cookMs, 0),
    renderMs: parts.reduce((a, p) => a + p.renderMs, 0),
    width: parts.find((p) => p.width)?.width ?? 0,
    height: parts.find((p) => p.height)?.height ?? 0,
  };
}

/** What the frames depend on: the shot's render fields and its graph file. Frames made under another stamp are stale. */
function stamp(s: Shot): string {
  const { graph, kind, set, target, title, render, orbit, frames, sim_fps } = s;
  return createHash('sha256').update(JSON.stringify({ graph, kind, set, target, title, render, orbit, frames, sim_fps }))
    .update(fs.readFileSync(path.join(ROOT, s.graph))).digest('hex').slice(0, 16);
}

async function renderShot(s: Shot): Promise<ShotStats> {
  const t0 = performance.now();
  const dir = shotDir(s);
  fs.mkdirSync(dir, { recursive: true });
  const stampFile = path.join(dir, 'stamp.txt'), now = stamp(s);
  if (!fs.existsSync(stampFile) || fs.readFileSync(stampFile, 'utf8').trim() !== now) {
    const old = fs.readdirSync(dir).filter((f) => /^frame_\d+\.png$/.test(f));
    if (old.length) console.log(`${s.id}: the shot or its graph changed since its frames were rendered; removing ${old.length} frames`);
    for (const f of old) fs.rmSync(path.join(dir, f));
    fs.writeFileSync(stampFile, now + '\n');
  }
  writeLeft(s);
  const todo = missing(s);
  const frames = frameCount(s);
  if (!todo.length) {
    console.log(`${s.id}: ${frames} frames on disk, nothing to render`);
    return { id: s.id, frames, jobs: 0, rendered: 0, cookMs: 0, renderMs: 0, wallMs: 0, width: 0, height: 0 };
  }
  console.log(`${s.id}: rendering ${todo.length} of ${frames} frames (${s.kind}, ${s.graph})`);
  const n = Math.min(jobs, Math.ceil(todo.length / (s.kind === 'sequence' ? 30 : 10)));
  const st = n > 1 ? await renderParallel(s, n) : s.kind === 'sequence' ? await renderSequence(s, todo) : await renderCamera(s, todo);
  const wallMs = performance.now() - t0;
  console.log(`${s.id}: ${st.rendered} frames ${st.width}x${st.height}, cook ${(st.cookMs / 1000).toFixed(1)} s, ` +
    `render ${(st.renderMs / st.rendered).toFixed(0)} ms/frame${n > 1 ? ` on ${n} processes` : ''}, wall ${(wallMs / 1000).toFixed(1)} s`);
  return { id: s.id, frames, jobs: n, ...st, wallMs };
}

// ---------------------------------------------------------------- assembly (ffmpeg)

function hasFfmpeg(): boolean {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
  return r.status === 0;
}

function ffmpeg(args: string[]) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed (exit ${r.status})`);
}

const ENCODE = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart'];
const TO_709 = 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p';

/** crop shots: the ffmpeg crop filter, by default centred on the square view tile (the image is iw wide, iw + footer high). */
const cropFilter = (s: Shot) => (s.crop ? `crop=${s.crop[0]}:${s.crop[1]}:(iw-${s.crop[0]})/2:${s.crop[2] ?? `(iw-${s.crop[1]})/2`},` : '');

/** The ffmpeg arguments that encode one shot (also printed by --assemble, quoted for a POSIX shell). */
function encodeArgs(s: Shot): string[] {
  const dir = rel(shotDir(s));
  const [pw, ph] = list.pane;
  const fit = s.crop ? cropFilter(s) : `pad=${pw}:${ph}:(ow-iw)/2:(oh-ih)/2:color=0x${FOOTER_BG},`;
  const input = s.kind === 'still'
    ? ['-loop', '1', '-framerate', String(list.fps), '-i', `${dir}/${frameName(1)}`, '-t', String(s.seconds ?? 5)]
    : ['-framerate', String(list.fps), '-start_number', '1', '-i', `${dir}/frame_%04d.png`];
  return [...input, '-vf', fit + TO_709, '-r', String(list.fps), ...ENCODE, `${rel(OUT)}/${s.id}.mp4`];
}
const shellLine = (args: string[]) => ['ffmpeg', '-y', ...args].map((a) => (/[\s(),;]/.test(a) ? `"${a}"` : a)).join(' ');

/** Encode the selected shots, then the contact sheet of every shot whose frames are all on disk. */
function assemble(sel: Shot[]) {
  for (const s of sel) {
    const miss = missing(s).length;
    if (miss) { console.log(`${s.id}: ${miss} frames missing, not encoded`); continue; }
    const args = encodeArgs(s);
    const t0 = performance.now();
    ffmpeg(args);
    console.log(`${s.id}.mp4 (${((performance.now() - t0) / 1000).toFixed(1)} s): ${shellLine(args)}`);
  }
  const done = list.shots.filter((s) => !missing(s).length);
  if (!done.length) return;
  // contact sheet: the middle frame of each shot (as cropped in its mp4), its id underneath, five per row
  const tmp = path.join(OUT, '.contact');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const C = 384, L = 36;
  done.forEach((s, k) => {
    const mid = Math.max(1, Math.ceil(Math.min(frameCount(s), limit) / 2));
    ffmpeg(['-i', `${rel(shotDir(s))}/${frameName(mid)}`, '-vf',
      `${cropFilter(s)}scale=${C}:${C}:force_original_aspect_ratio=decrease,pad=${C}:${C + L}:(ow-iw)/2:(${C}-ih)/2:color=0x${FOOTER_BG},` +
      `drawtext=fontfile=assets/fonts/DejaVuSans.ttf:text=${s.id}:x=(w-tw)/2:y=${C + 9}:fontsize=18:fontcolor=white`,
      '-frames:v', '1', `${rel(tmp)}/cell_${String(k).padStart(2, '0')}.png`]);
  });
  const cols = Math.min(5, done.length), rows = Math.ceil(done.length / cols);
  ffmpeg(['-framerate', '1', '-i', `${rel(tmp)}/cell_%02d.png`, '-vf', `tile=${cols}x${rows}:padding=4:margin=4:color=0x${FOOTER_BG}`,
    '-frames:v', '1', `${rel(OUT)}/contact_sheet.png`]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`contact_sheet.png: ${done.length} shots`);
}

// ---------------------------------------------------------------- main

if (part) {
  // child of renderParallel: one shot, the k-th of n contiguous runs of its missing frames
  const [k, n] = part.split('/').map(Number);
  const s = shots[0];
  const all = missing(s);
  const todo = all.slice(Math.floor((k * all.length) / n), Math.floor(((k + 1) * all.length) / n));
  const st = !todo.length ? { rendered: 0, cookMs: 0, renderMs: 0, width: 0, height: 0 }
    : s.kind === 'sequence' ? await renderSequence(s, todo) : await renderCamera(s, todo);
  console.log(`PART ${JSON.stringify(st)}`);
  process.exit(0);
}

const t0 = performance.now();
const stats: ShotStats[] = [];
if (!flag('--no-render')) for (const s of shots) stats.push(await renderShot(s));
if (stats.length) {
  // per-shot timings of this run, merged into out/video/timings.json (shots not run this time keep their entry)
  const file = path.join(OUT, 'timings.json');
  const prev: Record<string, unknown> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const st of stats) if (st.rendered) prev[st.id] = {
    frames: st.frames, rendered: st.rendered, size: `${st.width}x${st.height}`, cook_s: +(st.cookMs / 1000).toFixed(2),
    render_ms_per_frame: Math.round(st.renderMs / st.rendered), processes: st.jobs, wall_s: +(st.wallMs / 1000).toFixed(1),
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(prev, null, 2) + '\n');
}
if (flag('--assemble')) {
  if (hasFfmpeg()) assemble(shots);
  else {
    console.log('ffmpeg is not on PATH: frames only. Encode each shot with:');
    for (const s of shots) console.log(`  ${shellLine(encodeArgs(s))}`);
  }
}
console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
