#!/usr/bin/env node
// Command line: cook a graph JSON file, then render / export / inspect.
//   node src/cli.ts <graph.json> [--node name] [--frame N | --frames A-B[:step]] [--fps 24]
//                   [--render out.png] [--views quad|quad_uv|turntable|persp|front,top|persp,uv|persp,section] [--checker] [--color-by attr]
//                   [--wireframe all|hard|boundary|groups] [--section y:0.5] [--clip x:0.5] [--glyphs N|up|orient|v] [--labels groups,pieces,points,prims,attrib:name]
//                   [--shading flat|matcap|ao] [--legend] [--size 800] [--render-scale 2] [--export out.glb]
//                   [--compress meshopt] [--quantize] [--pcg | --pcg-struct] [--attributes P,N,pscale] [--up-axis z] [--scale 100]
//                   [--instancing packed|expand] [--instances rows|expand] [--no-meshes]
//                   [--inspect summary|attributes|topology|all]
//   --export formats: .glb .gltf .obj .usda .ply .stl .json .geo (Houdini) .csv .points.json
//   Packed instances to .csv/.points.json: one row per instance + <name>.meshes.json + <name>_meshes/<Mesh>.glb.
//   Heightfields: --export terrain.png (16-bit heightmap + terrain.json sidecar for Unreal), .r16/.raw, or
//                 --format mask_png --layers mask,flow; --layer picks the layer;
//                 --format unreal_landscape --export out/level (a directory: heightmap, layers, manifest, objects.glb,
//                 instance stream).
//   With --frames, --render/--export paths may contain {frame} or {frame:04} (zero-padded);
//   without a pattern a .0001-style frame number is inserted before the extension.
//   node src/cli.ts --catalog | --help-node scatter | --version
//   node src/cli.ts mcp [--workspace dir] [--viewer]   the MCP server (src/mcp/server.ts) over stdio
//   node src/cli.ts view <graph.json> [--port 7341]      live 3D viewer in the browser, re-cooks on every save;
//                                                         files dropped on the page go to inputs/ beside the graph file
// Installed from npm the same commands are `topotopo …` (package.json bin → dist/cli.js, built by npm run build).
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
import { EXPORT_FORMATS, exportFormatFromPath } from './io/export.ts';
import type { ExportFormat } from './io/export.ts';
import { exportFilesAsync } from './io/files.ts';
import { ArtifactStore } from './host/artifacts.ts';
import { prepareTarget, writeTargets } from './host/export-targets.ts';
import type { PreparedTarget } from './host/export-targets.ts';
import { publishedOutputs } from './io/targets.ts';
import { inspect } from './inspect.ts';
import { catalogText, nodeDoc } from './mcp/docs.ts';

const argv = process.argv.slice(2);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const fail = (msg: string): never => { console.error(msg); process.exit(1); };
/** A graph file's name as a graph (view mode) and in receipts and default export file names. */
const graphName = (file: string) => path.basename(file).replace(/\.json$/i, '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]/, 'g$&') || 'graph';
// the command as the user typed it: the sources from a clone, or the package's bin (dist/cli.js)
const prog = import.meta.url.endsWith('.ts') ? 'node src/cli.ts' : 'topotopo';

if (argv.includes('-v') || argv.includes('-V') || argv.includes('--version')) {
  // package.json sits one level above both src/cli.ts and dist/cli.js
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(`topotopo ${pkg.version}`);
  process.exit(0);
}
if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log([
    `usage: ${prog} <graph.json> [--node n] [--frame N | --frames A-B[:step]] [--fps 24]`,
    '         [--render out.png] [--views quad|quad_uv|turntable|persp|front,top|persp,uv|persp,section] [--checker] [--color-by attr] [--export out.glb] [--inspect all]',
    '         [--export-all] (every output with an export target in the graph, into exports/ beside it)',
    '         render overlays: [--wireframe all|hard|boundary|groups] [--hard-angle 30] [--section y:0.5] [--clip x:0.5[:abs]]',
    '                          [--glyphs N|up|orient|v] [--glyph-attrib a] [--labels groups,pieces,points,prims,attrib:name] [--legend] [--points]',
    '                          [--shading flat|matcap|ao] [--size 800] [--render-scale 2] [--azimuth 35] [--elevation 25] [--zoom 1] [--look-at x,y,z] [--ortho-scale w]',
    '                          [--textures] (base colour maps on meshes) [--texture name|image/layer|material] (adds the texture view)',
    '                          [--max-triangles 600000] (packed instances drawn; above it an evenly spread subset)',
    '         several renders per cook: repeat --render; options after a --render apply to it, options before the first apply to all',
    '           e.g. --views top --render h.png --color-by height --render r.png --color-by river',
    '                          [--no-view-labels] (no view name labels or axis gizmo, e.g. for thumbnails)',
    '         export options: [--compress none|meshopt|draco] [--quantize] [--pcg | --pcg-struct] [--attributes P,N,pscale] [--up-axis y|z] [--scale 100]',
    '                         [--instancing packed|expand] (packed instances: glb/usda/geo keep them by default)',
    '                         [--instances rows|expand] [--no-meshes] (csv/points.json of packed instances: one row per instance + meshes sidecar + GLBs)',
    '       export formats: .glb .gltf .obj .usda .ply .stl .json .geo (Houdini) .csv .points.json; heightfields .png (png16) .r16,',
    '                       --format mask_png --layers a,b, --format unreal_landscape (a directory bundle; --tile-size 1008 for tiled Landscape);',
    '                       images: --format textures --export out/maps (one PNG per image; --layers a,b or * for extra layers)',
    '       with --frames, output paths may use {frame} or {frame:04}; otherwise out.0001.png style names are written',
    `       ${prog} --catalog | --help-node <type> | --version`,
    `       ${prog} mcp [--workspace dir] [--viewer]   (the MCP server over stdio, for MCP clients)`,
    `       ${prog} view <graph.json> [--port 7341]   (live 3D viewer in the browser; re-cooks when the file is saved; files dropped on the page go to inputs/ beside it)`,
  ].join('\n'));
  process.exit(0);
}
if (argv.includes('--catalog') || opt('--help-node')) {
  // node types plus the shelf assets (house, stairs, …), which the engine registers when it starts
  const engine = new Engine(createNodeHost({ baseDir: process.cwd() }));
  await engine.init();
  const defs = [...allNodeDefs(), ...[...engine.assets.values()].map((x) => x.def)];
  if (argv.includes('--catalog')) console.log(catalogText(defs));
  else {
    const d = defs.find((x) => x.type === opt('--help-node'));
    console.log(d ? nodeDoc(d) : `unknown node "${opt('--help-node')}" (see --catalog)`);
  }
  process.exit(0);
}

if (argv[0] === 'view') {
  // `topotopo view <graph.json> [--port 7341]`: cook the file, serve the live 3D viewer, re-cook on every save
  const file = argv[1];
  if (!file || file.startsWith('-')) fail(`usage: ${prog} view <graph.json> [--port 7341]`);
  if (!fs.existsSync(file)) fail(`${prog}: no such graph file "${file}"`);
  const os = await import('node:os');
  const { Workspace } = await import('./workspace.ts');
  const { startViewer } = await import('./viewer/server.ts');
  const dir = path.dirname(path.resolve(file));
  const engine = new Engine(createNodeHost({ baseDir: dir }));
  await engine.init();
  // A scratch workspace holds the graph and assets: the graph file stays the only source. Files dropped on the
  // page go to inputs/ beside the graph file instead, made on the first drop: its file nodes read them as
  // "inputs/<name>" (the path an MCP workspace uses too), and they outlive the viewer.
  const ws = new Workspace(fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-view-')), engine, { inputs: path.join(dir, 'inputs'), exports: path.join(dir, 'exports') });
  ws.load();
  const name = graphName(file);
  const load = async () => {
    let spec;
    try { spec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`${file}: ${(e as Error).message} (keeping the last good version)`); return; }
    ws.setGraph(name, spec);
    const r = await ws.cook(name);
    console.log(`${r.ok ? 'cooked' : 'FAILED'} ${name} in ${r.ms.toFixed(0)} ms${r.ok ? '' : ': ' + r.errors.map((e) => `${e.node}: ${e.message}`).join('; ')}`);
    ws.bump(name);
  };
  await load();
  // an export target set on the page goes into the graph file, the only source here: only "export" keys change
  const persistGraph = (g: string) => {
    if (g !== name) return;
    const spec = ws.getGraph(name), raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (spec.export === undefined) delete raw.export; else raw.export = spec.export;
    for (const [id, o] of Object.entries(spec.outputs ?? {})) {
      if (!raw.outputs?.[id]) continue;
      if (o.export === undefined) delete raw.outputs[id].export; else raw.outputs[id].export = o.export;
    }
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  };
  const v = await startViewer(ws, opt('--port') !== undefined ? Number(opt('--port')) : undefined, { inputsWhere: `beside ${path.basename(file)}`, persistGraph });
  console.log(`view: ${v.url}  (watching ${file}; files dropped on the page go to ${path.join(path.dirname(file), 'inputs') + path.sep}; Ctrl+C to stop)`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  fs.watch(file, () => { clearTimeout(timer); timer = setTimeout(() => { load().catch((e) => console.error(String(e))); }, 150); });
} else if (argv[0] === 'mcp') {
  // `topotopo mcp [--workspace dir] [--viewer]`: the MCP server over stdio; src/mcp/server.ts reads the remaining
  // arguments from process.argv and runs until the client closes stdin
  process.argv.splice(2, 1);
  await import('./mcp/server.ts');
} else await cook();

/** Cook a graph file, then render / export / inspect it. */
async function cook() {
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
  if (file.startsWith('-')) fail(`${prog}: unknown option "${file}" (the first argument is the graph file; see --help)`);
  if (!fs.existsSync(file)) fail(`${prog}: no such graph file "${file}"`);
  let graph;
  try { graph = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { fail(`${prog}: ${file} is not valid JSON: ${(e as Error).message}`); }
  const engine = new Engine(createNodeHost({ baseDir: path.dirname(path.resolve(file)) }));
  await engine.init();
  const target = opt('--node');
  const fps = opt('--fps') !== undefined ? Number(opt('--fps')) : undefined;
  const framesArg = opt('--frames');
  const frameArg = opt('--frame');
  if (framesArg && frameArg) fail('use either --frame or --frames, not both');
  if (framesArg && argv.includes('--export-all')) fail('--export-all writes one frame: use --frame N, not --frames');
  const single = frameArg !== undefined ? Number(frameArg) : undefined;
  if (single !== undefined && !Number.isFinite(single)) fail(`--frame expects a number, got "${frameArg}"`);

  function report(r: CookReport) {
    for (const e of r.errors) console.error(`error [${e.node}] ${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`);
    for (const w of r.warnings) console.error(`warning [${w.node}] ${w.message}`);
  }

  /** Render overlay flags → render tool arguments → RenderOptions (src/render/options.ts). */
  function renderFlags(get: (f: string) => string | undefined, has: (f: string) => boolean): RenderOptions {
    const a: Record<string, unknown> = {};
    for (const [f, k] of [['--wireframe', 'wireframe'], ['--hard-angle', 'hard_angle'], ['--section', 'section'], ['--clip', 'clip'], ['--glyphs', 'glyphs'],
      ['--glyph-attrib', 'glyph_attrib'], ['--glyph-scale', 'glyph_scale'], ['--max-glyphs', 'max_glyphs'], ['--labels', 'labels'], ['--max-labels', 'max_labels'],
      ['--shading', 'shading'], ['--ao-radius', 'ao_radius'], ['--size', 'size'], ['--render-scale', 'scale'], ['--azimuth', 'azimuth'], ['--elevation', 'elevation'],
      ['--zoom', 'zoom'], ['--look-at', 'look_at'], ['--ortho-scale', 'ortho_scale'], ['--texture', 'texture'], ['--max-triangles', 'max_triangles']]) if (get(f) !== undefined) a[k] = get(f);
    for (const [f, k] of [['--legend', 'legend'], ['--points', 'points'], ['--annotate', 'annotate'], ['--textures', 'textures']]) if (has(f)) a[k] = true;
    if (has('--no-view-labels')) a.view_labels = false;
    try { return renderArgs(a); } catch (e: any) { return fail(e.message); }
  }

  // Several renders per run (one cook): every --render takes the render options that follow it, up to the next
  // --render; options before the first --render apply to all of them. With one --render this is the old behaviour.
  const renderAt = argv.flatMap((x, i) => (x === '--render' ? [i] : []));
  const sharedArgs = argv.slice(0, renderAt.length ? renderAt[0] : argv.length);
  const renders = renderAt.map((start, n) => {
    const seg = argv.slice(start, n + 1 < renderAt.length ? renderAt[n + 1] : argv.length);
    if (!seg[1] || seg[1].startsWith('--')) fail('--render needs an output path (e.g. --render out.png)');
    const from = (args: string[], f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
    return { out: seg[1], get: (f: string) => from(seg, f) ?? from(sharedArgs, f), has: (f: string) => seg.includes(f) || sharedArgs.includes(f) };
  });

  async function writeOutputs(r: CookReport, frame?: number) {
    const geo = r.geo!;
    const at = (p: string) => (frame === undefined ? p : framePath(p, frame));
    // Receipts for the viewer's saved files, only for files inside exports/ beside the graph: a run whose output goes
    // elsewhere leaves no exports/ folder behind (the viewer lists that folder's files without receipts too).
    const exportsDir = path.join(path.dirname(path.resolve(file)), 'exports');
    const record = (paths: string[], format: string) => {
      const inside = paths.every((p) => { const rel = path.relative(exportsDir, path.resolve(p)); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
      if (inside) new ArtifactStore(exportsDir).record(paths, { graph: graphName(file), node: r.target, format });
    };
    for (const { out, get, has } of renders) {
      const ro = renderFlags(get, has);
      const v = get('--views');
      let views = v === undefined || v === 'quad' ? undefined : parseViews(v);
      if (get('--section') !== undefined) views = !views && v === undefined ? ro.views : views && views.includes('section') ? views : [...(views ?? parseViews('quad')!), 'section'];
      if (get('--texture') !== undefined) views = !views && v === undefined ? ro.views : views && views.includes('texture') ? views : [...(views ?? parseViews('quad')!), 'texture'];
      const title = path.basename(file, '.json') + (r.frame !== 1 ? ` @ frame ${r.frame}` : '');
      const img = renderGeometry(geo, { ...ro, views, colorBy: get('--color-by') ?? null, checker: has('--checker'), title });
      const p = at(out);
      fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
      fs.writeFileSync(p, encodePNG(img.rgba, img.width, img.height, (d) => zlib.deflateSync(d)));
      record([p], 'png');
      console.log(`rendered ${p} (${img.width}x${img.height})${img.notes.length ? ' — ' + img.notes.join('; ') : ''}`);
    }
    const ex = opt('--export');
    if (ex) {
      const p = at(ex);
      const raw = (opt('--format') ?? exportFormatFromPath(ex)).toLowerCase();
      const fmt = (({ png: 'png16', raw: 'r16' } as Record<string, string>)[raw] ?? raw) as ExportFormat;
      if (!EXPORT_FORMATS.includes(fmt)) fail(`unknown export format "${fmt}" (${EXPORT_FORMATS.join(', ')}); pass --format`);
      const up = opt('--up-axis');
      if (argv.includes('--tile-size') && opt('--tile-size') === undefined) fail('--tile-size requires a number of quads (e.g. 1008)');
      const outDir = fmt === 'unreal_landscape' && !/\.json$/i.test(p) ? path.resolve(p) : path.dirname(path.resolve(p));
      const host = engine.host;
      const { files, summary } = await exportFilesAsync(geo, fmt, p, {
        splitByName: true,
        compress: opt('--compress') as any,
        quantize: argv.includes('--quantize') || undefined,
        pcg: argv.includes('--pcg') || argv.includes('--pcg-struct') || undefined,
        pcgStruct: argv.includes('--pcg-struct') || undefined,
        attributes: opt('--attributes'),
        upAxis: up === 'z' || up === 'y' ? up : undefined,
        scale: opt('--scale') !== undefined ? Number(opt('--scale')) : undefined,
        instancing: opt('--instancing') === 'expand' ? 'expand' : undefined,
        instances: opt('--instances') === 'expand' ? 'expand' : undefined,
        meshes: argv.includes('--no-meshes') ? false : undefined,
        layer: opt('--layer'), layers: opt('--layers')?.split(','),
        tile_size: opt('--tile-size') !== undefined ? Number(opt('--tile-size')) : undefined,
        deflate: (d) => zlib.deflateSync(d),
        readFile: (t) => host.readFile(t),
        texturePath: (t) => { const abs = host.resolvePath(t); return /^[a-z][a-z0-9+.-]*:\/\//i.test(abs) ? abs : path.relative(outDir, abs).split(path.sep).join('/'); },
        warn: (m) => console.warn(`warning: ${m}`),
      });
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.resolve(f.path)), { recursive: true });
        fs.writeFileSync(f.path, f.bytes);
      }
      if (files.length) record(files.map((f) => f.path), fmt);
      console.log(`exported ${files.length === 1 ? files[0].path : files.map((f) => f.path).join(', ')}${files.length > 1 || fmt !== 'glb' ? ` — ${summary}` : ''}`);
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
    if (argv.includes('--export-all')) await exportAll();
  }

  /** --export-all: every published output with an export target (io/targets.ts), into exports/ beside the graph. */
  async function exportAll() {
    const name = graphName(file), exportsDir = path.join(path.dirname(path.resolve(file)), 'exports');
    const published = publishedOutputs(name, graph, engine.findOutput(graph).name);
    if (!published.some((p) => p.target)) fail(`--export-all: no output of ${file} has an export target; add "export": "glb" to the graph (default output) or to an entry of "outputs"`);
    const prepared: PreparedTarget[] = [];
    for (const p of published) {
      if (!p.target) continue;
      const r = await engine.cook(graph, { target: p.node, frame: single, fps });
      report(r);
      if (!r.ok || !r.geo) fail(`--export-all: "${p.label}" did not cook; nothing was written`);
      prepared.push(await prepareTarget(r.geo!, name, p as typeof p & { target: NonNullable<typeof p.target> }, exportsDir, engine.host));
    }
    writeTargets(prepared, exportsDir);
    for (const p of prepared) console.log(`exported ${p.label} → ${path.join('exports', ...p.target.path.split('/'))} — ${p.summary}`);
    const skipped = published.filter((p) => !p.target).map((p) => p.label);
    if (skipped.length) console.log(`no export target (skipped): ${skipped.join(', ')}`);
  }
  // stop the kernel worker threads (idle ones would not hold the process, but a clean exit should not wait on them)
  await engine.host.pool?.close();
}
