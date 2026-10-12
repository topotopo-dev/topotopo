#!/usr/bin/env node
// Command line: cook a graph JSON file, then render / export / inspect.
//   node src/cli.ts <graph.json> [--node name] [--frame N | --frames A-B[:step]] [--fps 24]
//                   [--render out.png] [--views quad|quad_uv|turntable|persp|front,top|persp,uv|persp,section] [--checker] [--color-by attr]
//                   [--wireframe all|hard|boundary|groups] [--section y:0.5] [--clip x:0.5] [--glyphs N|up|orient|v] [--labels groups,pieces,points,prims,attrib:name]
//                   [--shading flat|matcap|ao] [--legend] [--size 800] [--render-scale 2] [--export out.glb]
//                   [--compress meshopt] [--quantize] [--pcg | --pcg-struct] [--attributes P,N,pscale] [--up-axis z] [--scale 100]
//                   [--instancing packed|expand]
//                   [--inspect summary|attributes|topology|all]
//   --export formats: .glb .gltf .obj .usda .ply .stl .json .geo (Houdini) .csv .points.json
//   Heightfields: --export terrain.png (16-bit heightmap + terrain.json sidecar for Unreal), .r16/.raw, or
//                 --format mask_png --layers mask,flow; --layer picks the layer.
//   With --frames, --render/--export paths may contain {frame} or {frame:04} (zero-padded);
//   without a pattern a .0001-style frame number is inserted before the extension.
//   node src/cli.ts --catalog | --help-node scatter
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import './nodes/index.ts';
import { Engine } from './graph/engine.ts';
import type { CookReport, FrameRange } from './graph/engine.ts';
import { allNodeDefs } from './graph/registry.ts';
import { createNodeHost } from './host/node.ts';
import { renderGeometry } from './render/raster.ts';
import { parseViews } from './render/raster.ts';
import type { RenderOptions } from './render/raster.ts';
import { renderArgs } from './render/options.ts';
import { encodePNG } from './render/png.ts';
import { exportFormatFromPath, exportGeometryAsync } from './io/export.ts';
import type { ExportFormat } from './io/export.ts';
import { HEIGHTMAP_FORMATS, heightmapExport, heightmapPaths } from './io/heightmap.ts';
import type { HeightmapFormat } from './io/heightmap.ts';
import { inspect } from './inspect.ts';
import { catalogText, nodeDoc } from './mcp/docs.ts';

const argv = process.argv.slice(2);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const fail = (msg: string): never => { console.error(msg); process.exit(1); };

if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log([
    'usage: node src/cli.ts <graph.json> [--node n] [--frame N | --frames A-B[:step]] [--fps 24]',
    '         [--render out.png] [--views quad|quad_uv|turntable|persp|front,top|persp,uv|persp,section] [--checker] [--color-by attr] [--export out.glb] [--inspect all]',
    '         render overlays: [--wireframe all|hard|boundary|groups] [--hard-angle 30] [--section y:0.5] [--clip x:0.5[:abs]]',
    '                          [--glyphs N|up|orient|v] [--glyph-attrib a] [--labels groups,pieces,points,prims,attrib:name] [--legend] [--points]',
    '                          [--shading flat|matcap|ao] [--size 800] [--render-scale 2] [--azimuth 35] [--elevation 25] [--zoom 1] [--look-at x,y,z] [--ortho-scale w]',
    '         export options: [--compress none|meshopt|draco] [--quantize] [--pcg | --pcg-struct] [--attributes P,N,pscale] [--up-axis y|z] [--scale 100]',
    '                         [--instancing packed|expand] (packed instances: glb/usda keep them by default)',
    '       export formats: .glb .gltf .obj .usda .ply .stl .json .geo (Houdini) .csv .points.json',
    '       with --frames, output paths may use {frame} or {frame:04}; otherwise out.0001.png style names are written',
    '       node src/cli.ts --catalog | --help-node <type>',
  ].join('\n'));
  process.exit(0);
}
if (argv.includes('--catalog')) { console.log(catalogText(allNodeDefs())); process.exit(0); }
if (opt('--help-node')) {
  const d = allNodeDefs().find((x) => x.type === opt('--help-node'));
  console.log(d ? nodeDoc(d) : 'unknown node');
  process.exit(0);
}

const NUM = String.raw`-?\d+(?:\.\d+)?`;

/** "1-48", "1-48:2", "-5-10" → FrameRange */
function parseFrames(s: string): FrameRange {
  const m = new RegExp(`^(${NUM})-(${NUM})(?::(${NUM}))?$`).exec(s.trim());
  if (!m) fail(`--frames expects A-B or A-B:step (e.g. 1-48 or 1-48:2), got "${s}"`);
  const r = { start: Number(m![1]), end: Number(m![2]), step: m![3] !== undefined ? Number(m![3]) : 1 };
  if (r.end < r.start) fail(`--frames: end ${r.end} is before start ${r.start}`);
  if (!(r.step > 0)) fail(`--frames: step must be > 0, got ${r.step}`);
  return r;
}

/** Frame number text, zero-padded to `width` digits (fractional frames keep their decimals). */
function frameText(frame: number, width: number): string {
  const a = Math.abs(frame), int = Math.trunc(a), frac = +(a - int).toFixed(6);
  return (frame < 0 ? '-' : '') + String(int).padStart(width, '0') + (frac > 0 ? String(frac).slice(1) : '');
}

const FRAME_TOKEN = /\{frame(?::(\d+))?\}/g;

/** Output path for a frame: substitute {frame} / {frame:04}, or insert .0001 before the extension. */
function framePath(p: string, frame: number): string {
  if (/\{frame(?::\d+)?\}/.test(p)) return p.replace(FRAME_TOKEN, (_m, w) => frameText(frame, w ? Number(w) : 0));
  const ext = path.extname(p);
  return p.slice(0, p.length - ext.length) + '.' + frameText(frame, 4) + ext;
}

const file = argv[0];
const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
const engine = new Engine(createNodeHost({ baseDir: path.dirname(path.resolve(file)) }));
await engine.init();
const target = opt('--node');
const fps = opt('--fps') !== undefined ? Number(opt('--fps')) : undefined;
const framesArg = opt('--frames');
const frameArg = opt('--frame');
if (framesArg && frameArg) fail('use either --frame or --frames, not both');
const single = frameArg !== undefined ? Number(frameArg) : undefined;
if (single !== undefined && !Number.isFinite(single)) fail(`--frame expects a number, got "${frameArg}"`);

function report(r: CookReport) {
  for (const e of r.errors) console.error(`error [${e.node}] ${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`);
  for (const w of r.warnings) console.error(`warning [${w.node}] ${w.message}`);
}

/** Render overlay flags → render tool arguments → RenderOptions (src/render/options.ts). */
function renderFlags(): RenderOptions {
  const a: Record<string, unknown> = {};
  for (const [f, k] of [['--wireframe', 'wireframe'], ['--hard-angle', 'hard_angle'], ['--section', 'section'], ['--clip', 'clip'], ['--glyphs', 'glyphs'],
    ['--glyph-attrib', 'glyph_attrib'], ['--glyph-scale', 'glyph_scale'], ['--max-glyphs', 'max_glyphs'], ['--labels', 'labels'], ['--max-labels', 'max_labels'],
    ['--shading', 'shading'], ['--ao-radius', 'ao_radius'], ['--size', 'size'], ['--render-scale', 'scale'], ['--azimuth', 'azimuth'], ['--elevation', 'elevation'],
    ['--zoom', 'zoom'], ['--look-at', 'look_at'], ['--ortho-scale', 'ortho_scale']]) if (opt(f) !== undefined) a[k] = opt(f);
  for (const [f, k] of [['--legend', 'legend'], ['--points', 'points'], ['--annotate', 'annotate']]) if (argv.includes(f)) a[k] = true;
  try { return renderArgs(a); } catch (e: any) { return fail(e.message); }
}

async function writeOutputs(r: CookReport, frame?: number) {
  const geo = r.geo!;
  const out = opt('--render');
  const at = (p: string) => (frame === undefined ? p : framePath(p, frame));
  if (out) {
    const ro = renderFlags();
    const v = opt('--views');
    let views = v === undefined || v === 'quad' ? undefined : parseViews(v);
    if (opt('--section') !== undefined) views = !views && v === undefined ? ro.views : views && views.includes('section') ? views : [...(views ?? parseViews('quad')!), 'section'];
    const title = path.basename(file, '.json') + (r.frame !== 1 ? ` @ frame ${r.frame}` : '');
    const img = renderGeometry(geo, { ...ro, views, colorBy: opt('--color-by') ?? null, checker: argv.includes('--checker'), title });
    const p = at(out);
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
    fs.writeFileSync(p, encodePNG(img.rgba, img.width, img.height, (d) => zlib.deflateSync(d)));
    console.log(`rendered ${p} (${img.width}x${img.height})${img.notes.length ? ' — ' + img.notes.join('; ') : ''}`);
  }
  const ex = opt('--export');
  if (ex) {
    const p = at(ex);
    const raw = (opt('--format') ?? exportFormatFromPath(ex)).toLowerCase();
    const fmt = (({ png: 'png16', raw: 'r16' } as Record<string, string>)[raw] ?? raw) as ExportFormat;
    if (HEIGHTMAP_FORMATS.includes(fmt as HeightmapFormat)) {
      // heightfield -> heightmap + JSON sidecar (png16/r16) or one PNG per mask layer
      fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
      const res = heightmapExport(geo, fmt as HeightmapFormat, { layer: opt('--layer'), layers: opt('--layers')?.split(','), deflate: (d) => zlib.deflateSync(d) });
      const paths = heightmapPaths(p, res.files);
      res.files.forEach((f, i) => fs.writeFileSync(paths[i], f.bytes));
      console.log(`exported ${paths.join(', ')}: ${res.summary}`);
      return;
    }
    const up = opt('--up-axis');
    const bytes = await exportGeometryAsync(geo, fmt, {
      splitByName: true,
      compress: opt('--compress') as any,
      quantize: argv.includes('--quantize') || undefined,
      pcg: argv.includes('--pcg') || argv.includes('--pcg-struct') || undefined,
      pcgStruct: argv.includes('--pcg-struct') || undefined,
      attributes: opt('--attributes'),
      upAxis: up === 'z' || up === 'y' ? up : undefined,
      scale: opt('--scale') !== undefined ? Number(opt('--scale')) : undefined,
      instancing: opt('--instancing') === 'expand' ? 'expand' : undefined,
      warn: (m) => console.warn(`warning: ${m}`),
    });
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
    fs.writeFileSync(p, bytes);
    console.log(`exported ${p}`);
  }
}

if (framesArg) {
  const range = parseFrames(framesArg);
  const res = await engine.cookFrames(graph, range, async (r, f) => {
    report(r);
    if (!r.ok || !r.geo) return;
    const cooked = [...r.results.values()].filter((n) => !n.cached && !n.error).length;
    console.log(`frame ${f}: ${r.target} in ${r.ms.toFixed(0)} ms (${cooked} node(s) cooked) — ${r.geo.numPoints} points, ${r.geo.numPrims} prims`);
    if (opt('--inspect')) console.log(inspect(r.geo, { detail: opt('--inspect') as any }));
    await writeOutputs(r, f);
  }, { target, fps });
  console.log(`cooked ${file} frames ${range.start}-${range.end}${range.step !== 1 ? `:${range.step}` : ''}: ${res.frames - res.failed.length}/${res.frames} ok`);
  if (res.failed.length) fail(`failed frames: ${res.failed.join(', ')}`);
} else {
  const r = await engine.cook(graph, { target, frame: single, fps });
  report(r);
  if (!r.ok || !r.geo) process.exit(1);
  console.log(`cooked ${file} → ${r.target}${r.frame !== 1 ? ` at frame ${r.frame}` : ''} in ${r.ms.toFixed(0)} ms`);
  console.log(inspect(r.geo, { detail: (opt('--inspect') as any) ?? 'summary' }));
  await writeOutputs(r);
}
