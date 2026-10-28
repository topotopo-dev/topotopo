#!/usr/bin/env node
// Command line: cook a graph JSON file, then render / export / inspect.
//   node src/cli.ts <graph.json> [--node name | --output name] [--var name=value]… [--frame N | --frames A-B[:step]] [--fps 24]
//                   [--render out.png] [--views quad|quad_uv|turntable|persp|front,top|persp,uv|persp,section] [--checker] [--color-by attr]
//                   [--wireframe all|hard|boundary|groups] [--section y:0.5] [--clip x:0.5] [--glyphs N|up|orient|v] [--labels groups,pieces,points,prims,attrib:name]
//                   [--shading flat|matcap|ao|pbr] [--exposure 0] [--legend] [--size 800] [--render-scale 2] [--heightfield-res 256|full]
//                   [--heightfield-layer mask|<layer>|none] [--export out.glb]
//                   [--compress meshopt] [--quantize] [--tangents auto|preserve|none] [--pcg | --pcg-struct] [--attributes P,N,pscale] [--up-axis z] [--scale 100]
//                   [--instancing packed|expand] [--instances rows|expand] [--no-meshes]
//                   [--inspect summary|attributes|topology|all|uv [--uv-resolution 1024] [--json]]
//   --output picks a named output (the graph's "outputs"); --var overrides a graph var for this run (src/graph/vars.ts).
//   --export formats: .glb .gltf .obj .usda .ply .stl .json .geo (Houdini) .csv .points.json
//   Packed instances to .csv/.points.json: one row per instance + <name>.meshes.json + <name>_meshes/<Mesh>.glb.
//   Heightfields: --export terrain.png (16-bit heightmap + terrain.json sidecar for Unreal), .r16/.raw, or
//                 --format mask_png --layers mask,flow; --layer picks the layer;
//                 --format unreal_landscape --export out/level (a directory: heightmap, layers, manifest, objects.glb,
//                 instance stream).
//   Every export records how it was made (src/io/source.ts) in its sidecar or manifest, or in <file>.source.json.
//   With --frames, --render/--export paths may contain {frame} or {frame:04} (zero-padded);
//   without a pattern a .0001-style frame number is inserted before the extension.
//   node src/cli.ts --catalog | --help-node scatter | --help-topic export | --version
//   node src/cli.ts mcp [--workspace dir] [--viewer]   the MCP server (src/mcp/server.ts) over stdio
//   node src/cli.ts view <graph.json> [--port 7341]      live 3D viewer in the browser, re-cooks on every save;
//                                                         files dropped on the page go to inputs/ beside the graph file
//   node src/cli.ts gallery [--port 7340] [--library dir]  the gallery website of the libraries (src/gallery/cli.ts)
//   node src/cli.ts library add|list|new|bake …           libraries and projects; edit <project> opens the live viewer
//   node src/cli.ts init|use|packages|publish|search …    a project and its packages (src/gallery/packages.ts);
//                                                         --follow owner/name on a cook or view uses a package's
//                                                         working folder instead of its copy, for that run
//   node src/cli.ts outdated|update …                     the newer versions of what a project uses, and the
//                                                         before/after of an update (src/gallery/update.ts)
// Installed from npm the same commands are `topotopo …` (package.json bin → dist/cli.js, built by npm run build).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import './nodes/index.ts';
import { Engine } from './graph/engine.ts';
import type { CookReport, FrameRange } from './graph/engine.ts';
import { allNodeDefs } from './graph/registry.ts';
import { KINDS } from './graph/outputs.ts';
import { createNodeHost } from './host/node.ts';
import { renderGeometryAsync } from './render/raster.ts';
import { parseViews } from './render/raster.ts';
import type { RenderOptions } from './render/raster.ts';
import { renderArgs } from './render/options.ts';
import { encodePNG } from './render/png.ts';
import { EXPORT_FORMATS, exportFormatFromPath } from './io/export.ts';
import type { ExportFormat } from './io/export.ts';
import { exportSource } from './io/source.ts';
import { packagesUsed } from './graph/packages.ts';
import { openPackages } from './gallery/packages.ts';
import { ArtifactStore } from './host/artifacts.ts';
import { prepareTarget, serializeExport, writeExportFiles, writeTargets } from './host/export-targets.ts';
import type { PreparedTarget } from './host/export-targets.ts';
import { TOPOTOPO_VERSION } from './host/version.ts';
import { publishedOutputs } from './io/targets.ts';
import { inspect } from './inspect.ts';
import { uvReport } from './core/uvreport.ts';
import { didYouMean } from './graph/params.ts';
import { parseVarArg, withVars } from './graph/vars.ts';
import { catalogText, nodeDoc, topicList, topicText } from './mcp/docs.ts';

const argv = process.argv.slice(2);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const fail = (msg: string): never => { console.error(msg); process.exit(1); };
/** A graph file's name as a graph (view mode) and in receipts and default export file names. */
const graphName = (file: string) => path.basename(file).replace(/\.json$/i, '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]/, 'g$&') || 'graph';
// the command as the user typed it: the sources from a clone, or the package's bin (dist/cli.js)
const prog = import.meta.url.endsWith('.ts') ? 'node src/cli.ts' : 'topotopo';

if (argv.includes('-v') || argv.includes('-V') || argv.includes('--version')) {
  console.log(`topotopo ${TOPOTOPO_VERSION}`);
  process.exit(0);
}
if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log([
    `usage: ${prog} <graph.json> [--node n | --output name] [--var name=value]… [--frame N | --frames A-B[:step]] [--fps 24]`,
    '         [--render out.png] [--views quad|quad_uv|turntable|persp|front,top|persp,uv|persp,section] [--checker] [--color-by attr] [--export out.glb] [--inspect all|topology|uv] [--uv-resolution 1024] [--json] (uv: overlaps, utilization, texel density; --json: the report as JSON)',
    '         [--output name] (a named output, the graph\'s "outputs", instead of the default; render, export and inspect it)',
    '         [--var name=value] (override a graph var for this run; repeat it; numbers, true/false and JSON values are parsed, other text is a string)',
    '         [--export-all] (every output with an export target in the graph, into exports/ beside it)',
    '         [--follow owner/name] (use that package\'s working folder in the project\'s libraries instead of its copy, for this run; repeat it)',
    '         render overlays: [--wireframe all|hard|boundary|groups] [--hard-angle 30] [--section y:0.5] [--clip x:0.5[:abs]]',
    '                          [--glyphs N|up|orient|v] [--glyph-attrib a] [--labels groups,pieces,points,prims,attrib:name] [--legend] [--points]',
    '                          [--shading flat|matcap|ao|pbr] [--exposure 0] [--size 800] [--render-scale 2] [--azimuth 35] [--elevation 25] [--zoom 1] [--look-at x,y,z] [--ortho-scale w]',
    '                          [--textures] (base colour maps on meshes) [--texture name|image/layer|material] (adds the texture view)',
    '                          [--max-triangles 600000] (packed instances drawn; above it an evenly spread subset)',
    '                          [--heightfield-res 256|full] (heightfields: quads drawn per side, default 256, said in the footer when a field has more; full = every sample)',
    '                          [--heightfield-layer flow] (heightfields: the layer drawn in red, default mask; none draws none)',
    '         several renders per cook: repeat --render; options after a --render apply to it, options before the first apply to all',
    '           e.g. --views top --render h.png --color-by height --render r.png --color-by river',
    '                          [--no-view-labels] (no view name labels or axis gizmo, e.g. for thumbnails)',
    '         export options: [--compress none|meshopt|draco] [--quantize] [--tangents auto|preserve|none] [--pcg | --pcg-struct] [--attributes P,N,pscale] [--up-axis y|z] [--scale 100]',
    '                         [--instancing packed|expand] (packed instances: glb/usda/geo keep them by default)',
    '                         [--instances rows|expand] [--no-meshes] (csv/points.json of packed instances: one row per instance + meshes sidecar + GLBs)',
    '       export formats: .glb .gltf .obj .usda .ply .stl .json .geo (Houdini) .csv .points.json; heightfields .png (png16) .r16,',
    '                       --format mask_png --layers a,b, --format unreal_landscape (a directory bundle; --tile-size 1008 for tiled Landscape);',
    '                       images: --format textures --export out/maps (one PNG per image; --layers a,b or * for extra layers)',
    '       every export records how it was made (graph, graph hash, output, node, frame, fps, vars, seeds, options, version) in its sidecar',
    '                       (heightmap .json, <name>.meshes.json, landscape.json) or in <file>.source.json beside it; --help-topic export',
    '       with --frames, output paths may use {frame} or {frame:04}; otherwise out.0001.png style names are written',
    `       ${prog} --catalog | --help-node <type> | --help-topic <name> | --version   (in a project: its packages' outputs too, --help-node owner/name/output)`,
    `       ${prog} mcp [--workspace dir] [--viewer]   (the MCP server over stdio, for MCP clients)`,
    `       ${prog} view <graph.json> [--port 7341] [--follow owner/name]   (live 3D viewer in the browser; re-cooks when the file is saved; files dropped on the page go to inputs/ beside it)`,
    `       ${prog} gallery [--port 7340] [--library <folder>] [--no-bake]   (the gallery website: every library's projects, stable links for a board)`,
    `       ${prog} library add <name> <folder> | list | new <library> <folder/name> [--title t] [--tags a,b] | bake <project>|--stale|--all`,
    `       ${prog} edit <project folder> [--port 7341]   (the live viewer on a gallery project)`,
    `       ${prog} init [folder] [--package owner/name]   (make a folder a project: project.json)`,
    `       ${prog} use owner/name [folder]   (add a package to the project: its newest version in the libraries project.json lists, copied into packages/)`,
    `       ${prog} packages [folder]   (what the project uses, and the packages in its libraries with their newest version, note and outputs)`,
    `       ${prog} publish [folder] --note "what changed" [--big]   (publish the next version of the project's package into versions/; --help-topic packages)`,
    `       ${prog} publish [folder] --check [--note "..."] [--big]   (a dry run: every check and cook, the version number it would get, blocks and warnings; writes nothing)`,
    `       ${prog} search [words] [--kind ${KINDS.join('|')}] [--tag t]   (the outputs of every library, and whether this folder's project can use them)`,
    `       ${prog} outdated [folder]   (the newer versions of the packages the project uses, small and big, with the notes of each)`,
    `       ${prog} update owner/name [folder] [--to <version>] [--render <folder>]   (the before/after of an update: every place the project uses it, cooked`,
    '         with the version in use and the new one, what changed and the notes between; nothing is written. Without --to: the newest version',
    '         with the same big number; a big version needs --to. --render writes an overlay render of each place that changed into a folder)',
    `       ${prog} update owner/name [folder] [--to <version>] --apply   (apply it: copy the new version in, update "uses" and the lock, delete copies nothing uses)`,
  ].join('\n'));
  process.exit(0);
}
if (argv.includes('--help-topic')) {
  // the MCP help topics (src/mcp/docs.ts), the same text the help tool returns
  const name = opt('--help-topic');
  const topics = ['overview', ...topicList()];
  if (name === undefined || name.startsWith('-')) fail(`--help-topic needs a topic: ${topics.join(', ')}`);
  const text = topicText(name!);
  if (text === null) {
    const s = didYouMean(name!, topics);
    fail(`unknown topic "${name}"${s.length ? ` (did you mean ${s.join(', ')}?)` : ''}; topics: ${topics.join(', ')}`);
  }
  console.log(text);
  process.exit(0);
}
if (argv.includes('--catalog') || opt('--help-node')) {
  // node types, the current folder's assets, the outputs of the packages its project uses, and those of TopoTopo's own
  // packages (house, stairs, …) it does not use yet
  const engine = new Engine(createNodeHost({ baseDir: process.cwd() }));
  await engine.init();
  openPackages(engine, process.cwd());
  const defs = [...allNodeDefs(), ...engine.assetsIn().map((x) => x.def), ...engine.packageDefs()];
  if (argv.includes('--catalog')) console.log(catalogText(defs, { cli: true }));
  else {
    const name = opt('--help-node')!;
    const d = defs.find((x) => x.type === name) ?? (name.includes('/') ? engine.resolveDef(name) : undefined);
    // a package output this folder cannot cook as it is (one of TopoTopo's own it does not use, a folder in no project)
    const why = name.includes('/') && !engine.resolveDef(name) ? engine.packageIssue(name) : null;
    const said = why ? `${why.error}${why.hint ? ` (${why.hint})` : ''}` : '';
    console.log(d ? `${nodeDoc(d)}${said ? `\nin this folder: ${said}` : ''}` : said || `unknown node "${name}" (see --catalog)`);
  }
  process.exit(0);
}

/** --follow owner/name (repeatable): packages whose working folders a cook uses instead of their copies. */
const followArgs = argv.flatMap((x, i) => (x === '--follow' ? [argv[i + 1]] : []));
if (followArgs.some((f) => f === undefined || f.startsWith('--'))) fail('--follow needs a package: --follow owner/name');

if (argv[0] === 'view') {
  // `topotopo view <graph.json> [--port 7341]`: cook the file, serve the live 3D viewer and follow its saves; the values
  // tuned on the page are session values over the file, written into it on request (src/viewer/graph-file.ts)
  const file = argv[1];
  if (!file || file.startsWith('-')) fail(`usage: ${prog} view <graph.json> [--port 7341] [--follow owner/name]`);
  if (!fs.existsSync(file)) fail(`${prog}: no such graph file "${file}"`);
  const { viewGraphFile } = await import('./viewer/graph-file.ts');
  try { await viewGraphFile(file, { name: graphName(file), port: opt('--port') !== undefined ? Number(opt('--port')) : undefined, follow: followArgs }); }
  catch (e) { fail(`${prog} view: ${(e as Error).message}`); }
} else if (['gallery', 'library', 'edit', 'init', 'use', 'packages', 'publish', 'search', 'outdated', 'update'].includes(argv[0])) {
  // the gallery website, its libraries and its editor; a project's packages (src/gallery/cli.ts)
  const g = await import('./gallery/cli.ts');
  const commands: Record<string, (argv: string[], prog: string) => Promise<void>> = {
    gallery: g.galleryCommand, library: g.libraryCommand, edit: g.editCommand, init: g.initCommand, use: g.useCommand, packages: g.packagesCommand,
    publish: g.publishCommand, search: g.searchCommand, outdated: g.outdatedCommand, update: g.updateCommand,
  };
  await commands[argv[0]](argv.slice(1), prog);
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
  // --var name=value (repeatable): the graph's vars for this run; exports record the result, so a manifest replays
  const varArgs = argv.flatMap((x, i) => (x === '--var' ? [argv[i + 1]] : []));
  if (varArgs.some((v) => v === undefined || v.startsWith('--'))) fail('--var needs name=value (e.g. --var relief=8)');
  try { graph = withVars(graph, varArgs.map(parseVarArg)); } catch (e) { fail(`--var: ${(e as Error).message}`); }
  // --output name: a named output (graph.outputs) instead of the default output
  const outputName = opt('--output');
  if (argv.includes('--output') && (outputName === undefined || outputName.startsWith('--'))) fail('--output needs the name of one of the graph\'s outputs');
  if (outputName !== undefined && opt('--node') !== undefined) fail('use either --node or --output, not both');
  let target = opt('--node');
  if (outputName !== undefined) {
    const outs: Record<string, any> = graph?.outputs && typeof graph.outputs === 'object' ? graph.outputs : {};
    const o = Object.hasOwn(outs, outputName) ? outs[outputName] : undefined;
    if (!o || typeof o.node !== 'string') {
      const names = Object.keys(outs), s = didYouMean(outputName, names);
      fail(`--output: ${file} has no output "${outputName}"${s.length ? ` (did you mean ${s.join(', ')}?)` : ''}; ${names.length ? `its outputs: ${names.join(', ')}` : 'it publishes no "outputs" (--node picks any node)'}`);
    }
    target = o.node;
  }
  const engine = new Engine(createNodeHost({ baseDir: path.dirname(path.resolve(file)) }));
  await engine.init();
  // the packages of the project the file belongs to: one the graph names for the first time is added, and --follow
  // uses a package's working folder for this run
  let pk: ReturnType<typeof openPackages>;
  try { pk = openPackages(engine, path.dirname(path.resolve(file)), { follow: followArgs }); } catch (e) { fail(`--follow: ${(e as Error).message}`); }
  for (const n of pk!.addFor(graph)) console.log(n);
  for (const p of pk!.check()) console.error(`warning: ${p}`);
  for (const f of pk!.following()) console.log(`following ${f.package}: its working folder ${f.dir} instead of its copy`);
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
      ['--zoom', 'zoom'], ['--look-at', 'look_at'], ['--ortho-scale', 'ortho_scale'], ['--texture', 'texture'], ['--max-triangles', 'max_triangles'], ['--exposure', 'exposure'],
      ['--heightfield-res', 'heightfield_res'], ['--heightfield-layer', 'heightfield_layer']]) if (get(f) !== undefined) a[k] = get(f);
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
      const img = await renderGeometryAsync(geo, { ...ro, views, colorBy: get('--color-by') ?? null, checker: has('--checker'), title }, (t) => engine.host.readFile(t));
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
      if (argv.includes('--tile-size') && opt('--tile-size') === undefined) fail('--tile-size requires a number of quads (e.g. 1008)');
      if (opt('--tangents') !== undefined && !['auto', 'preserve', 'none'].includes(opt('--tangents')!)) fail(`--tangents must be auto, preserve or none (got "${opt('--tangents')}")`);
      // the export tool's options (the MCP export tool and export targets use the same names and code)
      const a = exportArgs();
      const source = exportSource({ graph: graphName(file), spec: graph, node: r.target, output: outputName, frame: r.frame, fps: r.fps, format: fmt, options: a, packages: packagesUsed(engine, graph), version: TOPOTOPO_VERSION });
      const res = await serializeExport(geo, fmt, p, a, engine.host, source);
      for (const w of res.warnings) console.warn(`warning: ${w}`);
      writeExportFiles(res.files);
      if (res.files.length) record(res.files.map((f) => f.path), fmt);
      const files = res.files.filter((f) => f.path !== res.sourceManifest);
      console.log(`exported ${files.length === 1 ? files[0].path : files.map((f) => f.path).join(', ')}${files.length > 1 || fmt !== 'glb' ? ` — ${res.summary}` : ''}${res.sourceFile ? `; source: ${res.sourceFile}` : ''}`);
    }
  }

  /** The export flags given, as the export tool's options (snake_case, as export targets and the MCP export tool name them). */
  function exportArgs(): Record<string, unknown> {
    const a: Record<string, unknown> = {};
    const up = opt('--up-axis');
    if (up === 'y' || up === 'z') a.up_axis = up;
    for (const [f, k] of [['--compress', 'compress'], ['--tangents', 'tangents'], ['--layer', 'layer']]) if (opt(f) !== undefined) a[k] = opt(f);
    for (const [f, k] of [['--scale', 'scale'], ['--tile-size', 'tile_size']]) if (opt(f) !== undefined) a[k] = Number(opt(f));
    if (opt('--attributes') !== undefined) a.attributes = opt('--attributes')!.split(/[\s,]+/).filter(Boolean);
    if (opt('--layers') !== undefined) a.layers = opt('--layers')!.split(',');
    if (argv.includes('--quantize')) a.quantize = true;
    if (argv.includes('--pcg') || argv.includes('--pcg-struct')) a.pcg = true;
    if (argv.includes('--pcg-struct')) a.pcg_struct = true;
    if (opt('--instancing') === 'expand') a.instancing = 'expand';
    if (opt('--instances') === 'expand') a.instances = 'expand';
    if (argv.includes('--no-meshes')) a.meshes = false;
    return a;
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
    const vars = varArgs.length ? ` with ${varArgs.map((v) => v.trim()).join(', ')}` : '';
    console.log(`cooked ${file} → ${outputName !== undefined ? `output "${outputName}" (${r.target})` : r.target}${r.frame !== 1 ? ` at frame ${r.frame}` : ''}${vars} in ${r.ms.toFixed(0)} ms`);
    if (opt('--inspect') === 'uv' && argv.includes('--json')) console.log(JSON.stringify(uvReport(r.geo, { resolution: opt('--uv-resolution') !== undefined ? Number(opt('--uv-resolution')) : undefined }), null, 2));
    else console.log(inspect(r.geo, { detail: (opt('--inspect') as any) ?? 'summary', uvResolution: opt('--uv-resolution') !== undefined ? Number(opt('--uv-resolution')) : undefined }));
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
      prepared.push(await prepareTarget(r.geo!, name, p as typeof p & { target: NonNullable<typeof p.target> }, exportsDir, engine.host, { frame: r.frame, fps: r.fps, packages: packagesUsed(engine, graph) }));
    }
    writeTargets(prepared, exportsDir);
    const rel = (f: string) => path.join('exports', path.relative(exportsDir, f));
    for (const p of prepared) console.log(`exported ${p.label} → ${path.join('exports', ...p.target.path.split('/'))} — ${p.summary}${p.sourceFile ? `; source: ${rel(p.sourceFile)}` : ''}`);
    const skipped = published.filter((p) => !p.target).map((p) => p.label);
    if (skipped.length) console.log(`no export target (skipped): ${skipped.join(', ')}`);
  }
  // stop the kernel worker threads (idle ones would not hold the process, but a clean exit should not wait on them)
  await engine.host.pool?.close();
}
