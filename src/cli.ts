#!/usr/bin/env node
// Command line: cook a graph JSON file, then render / export / inspect.
//   node src/cli.ts <graph.json> [--node name | --output name] [--var name=value]… [--frame N | --frames A-B[:step]] [--fps 24]
//                   [--render out.png] [--views quad|quad_uv|turntable|persp|front_left|front,top|persp,uv|persp,section] [--checker] [--color-by attr]
//                   [--wireframe all|hard|boundary|groups] [--section y:0.5] [--clip x:0.5] [--glyphs N|up|orient|v] [--labels groups,pieces,points,prims,attrib:name]
//                   [--shading flat|matcap|ao|pbr] [--exposure 0] [--legend] [--size 800|1600x600] [--render-scale 2] [--heightfield-res 256|full]
//                   [--transparent] [--no-grid] [--underlay ref.png [--underlay-opacity 0.5] [--underlay-fit bounds|width|height|view]] [--sockets]
//                   [--heightfield-layer mask|<layer>|none] [--export out.glb]
//                   [--compress meshopt] [--quantize] [--tangents auto|preserve|none] [--pcg | --pcg-struct] [--attributes P,N,pscale] [--up-axis z] [--scale 100]
//                   [--instancing packed|expand] [--instances rows|expand] [--no-meshes] [--custom-attribs | --no-custom-attribs] [--vertex-colors] [--no-materials]
//                   [--split-by-name | --no-split-by-name] [--precision 32|64] [--height-min 0 --height-max 100] [--heightfield 0]
//                   (every option of the export tool has a flag; booleans take --name / --no-name)
//                   [--inspect summary|attributes|topology|all|uv|budget|scene [--uv-resolution 1024] [--json]]
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
//   node src/cli.ts mcp [--package dir] [--viewer]   the MCP server (src/mcp/server.ts) over stdio
//   node src/cli.ts view <graph.json> [--port 7341]      live 3D viewer in the browser, re-cooks on every save;
//                                                         files dropped on the page go to inputs/ beside the graph file
//   node src/cli.ts web [--port 7340] [--library dir]  the web app for the libraries (src/packages/commands.ts)
//   node src/cli.ts library add|list|new|bake …           registered libraries and packages; edit [folder] opens the
//                                                         live viewer on a package
// The workspace (the game) around packages (src/workspace.ts), a package and the packages it uses (src/packages/commands.ts,
// src/packages/registry.ts, src/packages/update.ts):
//   node src/cli.ts workspace [folder]
//   node src/cli.ts workspace init [folder] [--name n] [--engine godot:<path>|unreal:<path>|none] [--assets <folder>] [--library <folder or name>] [--follow | --no-follow]
//   node src/cli.ts workspace add|list [folder]
//   node src/cli.ts init [folder] [--package owner/name]
//   node src/cli.ts libraries add|remove <folder or name> [folder]
//   node src/cli.ts use owner/name [folder] [--version 1.1]
//   node src/cli.ts remove owner/name [folder]
//   node src/cli.ts packages [owner/name] [folder]
//   node src/cli.ts publish [folder] --note "..." [--big] [--dry-run]
//   node src/cli.ts search [words] [folder] [--kind k] [--tag t]
//   node src/cli.ts outdated [folder]
//   node src/cli.ts check [folder]
//   node src/cli.ts update owner/name [folder] [--to 1.4] [--render <folder>]
//   node src/cli.ts update owner/name [folder] --from 1.3 --to 1.4 --apply
//   A graph-file cook adds a package its graph names for the first time (and says so); --locked fails instead, for a
//   build machine. --follow owner/name on a cook or view uses a package's working folder instead of its copy, for
//   looking: exports use the published copy.
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
import { PACKAGE_COMMANDS } from './packages/commands.ts';
import { setProgram } from './package.ts';
import { openPackages } from './packages/registry.ts';
import { ArtifactStore } from './host/artifacts.ts';
import { exportsFolderFor, prepareTarget, serializeExport, writeExportFiles, writeTargets } from './host/export-targets.ts';
import type { PreparedTarget } from './host/export-targets.ts';
import { TOPOTOPO_VERSION } from './host/version.ts';
import { exportOptionsFromFlags, publishedOutputs } from './io/targets.ts';
import { budgetReport, inspect, nodeBudgetInput, summarize } from './inspect.ts';
import { glbSceneReport, sceneReportText } from './io/inspect-scene.ts';
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
// the hints of every command name it so
setProgram(prog);

if (argv.includes('-v') || argv.includes('-V') || argv.includes('--version')) {
  console.log(`topotopo ${TOPOTOPO_VERSION}`);
  process.exit(0);
}
if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log([
    `usage: ${prog} <graph.json> [--node n | --output name] [--var name=value]… [--frame N | --frames A-B[:step]] [--fps 24]`,
    '         [--render out.png] [--views quad|quad_uv|turntable|persp|front_left|front,top|persp,uv|persp,section] [--checker] [--color-by attr] [--export out.glb]',
    '         [--inspect summary|attributes|topology|all|uv|budget|scene] [--uv-resolution 1024] [--json]',
    '           summary: one screen (counts, triangles, bbox in mm, parts, materials, images, uv state, closed or open edges)',
    '           topology: a closed solid or why not (open edges after welding seam splits, non-manifold, flipped, inward), with where',
    '           uv: overlaps (in-tile, tiling, across LODs), utilization, texel density; budget: triangles per part, per LOD and per node',
    '           scene: the glb export read back (nodes and parents, meshes, materials, maps, images; takes the export options)',
    '           --json: the uv, budget or scene report as JSON',
    '         [--output name] (a named output, the graph\'s "outputs", instead of the default; render, export and inspect it)',
    '         [--var name=value] (override a graph var for this run; repeat it; numbers, true/false and JSON values are parsed, other text is a string)',
    '         [--export-all] (every output with an export target in the graph, into exports/ of its package folder)',
    '         relative paths in the graph (file nodes, maps) read from its package folder: the nearest folder with a project.json at or',
    '           above the graph file, else the graph file\'s folder; --render/--export/--underlay paths are relative to the current folder',
    '         [--follow owner/name] (show that package\'s working folder in the package\'s libraries instead of its copy, for this run: renders and inspect use it, exports the published copy; repeat it)',
    '         [--locked] (a build machine: a package the graph names that the package does not use, or a copy missing or edited by hand, fails the run instead of being added)',
    '         render overlays: [--wireframe all|hard|boundary|groups] [--hard-angle 30] [--section y:0.5] [--clip x:0.5[:abs]]',
    '                          [--glyphs N|up|orient|v] [--glyph-attrib a] [--labels groups,pieces,points,prims,attrib:name] [--legend] [--points]',
    '                          [--shading flat|matcap|ao|pbr] [--exposure 0] [--size 800|1600x600] [--render-scale 2]',
    '                          views: persp front back left right top bottom front_left front_right back_left back_right uv section texture persp@<az>',
    '                          framing: every 3D view fits the bounds; [--zoom 1] is relative to that fit (above 1 only with --look-at or --ortho-scale)',
    '                          [--azimuth 35] (degrees around +Y: 0 = camera on +Z at the front, 90 = on +X, the right side) [--elevation 25] (degrees above the horizon)',
    '                          [--look-at x,y,z] (world metres, Y up, +Z front) [--ortho-scale 0.5] (metres across an ortho view)',
    '                          [--transparent] (PNG with alpha) [--no-grid] [--sockets] (scene empties as labelled dots with orient axes)',
    '                          [--underlay ref.png] (a reference PNG behind the 3D views) [--underlay-opacity 0.5] [--underlay-fit bounds|width|height|view]',
    '                          [--textures] (base colour maps on meshes) [--texture name|image/layer|material] (adds the texture view)',
    '                          [--max-triangles 600000] (packed instances drawn; above it an evenly spread subset)',
    '                          [--heightfield-res 256|full] (heightfields: quads drawn per side, default 256, said in the footer when a field has more; full = every sample)',
    '                          [--heightfield-layer flow] (heightfields: the layer drawn in red, default mask; none draws none)',
    '                          [--no-view-labels] (no view name labels or axis gizmo, e.g. for thumbnails)',
    '         several renders per cook: repeat --render; the options after a --render apply to that render (up to the next --render),',
    '           options before the first --render apply to every render. Example (both 1200x600):',
    '             --size 1200x600 --render side.png --views front --underlay ref.png --render beauty.png --views front_left --shading pbr',
    '           side.png: the front view over the reference; beauty.png: a pbr three-quarter view. Options after the last of several',
    '           --render apply to it alone (a warning says so)',
    '         export options (every option of the export tool; booleans as --name / --no-name):',
    '                         [--compress none|meshopt|draco] [--quantize] [--tangents auto|preserve|none] [--pcg | --pcg-struct] [--attributes P,N,pscale] [--up-axis y|z] [--scale 100]',
    '                         [--custom-attribs | --no-custom-attribs] (extra numeric attributes; glTF and USD default off, PLY on) [--materials | --no-materials]',
    '                         [--vertex-colors | --no-vertex-colors] (glTF: also write Cd as COLOR_0 on prims with a named material; default off)',
    '                         [--split-by-name | --no-split-by-name] [--precision 32|64] (geo) [--layer height] [--height-min 0] [--height-max 100] [--heightfield 0]',
    '                         [--instancing packed|expand] (packed instances: glb/usda/geo keep them by default)',
    '                         [--instances rows|expand] [--no-meshes] (csv/points.json of packed instances: one row per instance + meshes sidecar + GLBs)',
    '       export formats: .glb .gltf .obj .usda .ply .stl .json .geo (Houdini) .csv .points.json; heightfields .png (png16) .r16,',
    '                       --format mask_png --layers a,b, --format unreal_landscape (a directory bundle; --tile-size 1008 for tiled Landscape);',
    '                       images: --format textures --export out/maps (one PNG per image; --layers a,b or * for extra layers)',
    '       every export records how it was made (graph, graph hash, output, node, frame, fps, vars, seeds, every option with its default, version)',
    '                       in its sidecar; replay: --output/--node, --frame, --fps, --var per var, --format and each option as its flag',
    '                       (heightmap .json, <name>.meshes.json, landscape.json) or in <file>.source.json beside it; --help-topic export',
    '       with --frames, output paths may use {frame} or {frame:04}; otherwise out.0001.png style names are written',
    `       ${prog} --catalog | --help-node <type> | --help-topic <name> | --version   (in a package: the outputs of the packages it uses too, --help-node owner/name/output)`,
    `       ${prog} mcp [--package dir] [--viewer]   (the MCP server over stdio, for MCP clients)`,
    `       ${prog} view <graph.json> [--port 7341] [--follow owner/name]   (live 3D viewer in the browser; re-cooks when the file is saved; files dropped on the page go to inputs/ beside it)`,
    `       ${prog} web [--port 7340] [--library <folder>] [--no-bake]   (the web app: every library's packages, stable links for a board)`,
    `       ${prog} library add <name> <folder> | list | new <library> <folder/name> [--title t] [--tags a,b] | bake <package>|--stale|--all   (registered libraries)`,
    `       ${prog} edit [folder] [--port 7341]   (the live viewer on a package, default the current folder's)`,
    '       a package and the packages it uses (a folder named must exist; default: the current folder\'s package; kinds: ' + KINDS.join(', ') + '; --help-topic packages):',
    ...PACKAGE_COMMANDS.map((c) => `       ${prog} ${c.usage}   (${c.what})`),
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
  // node types, the current folder's assets, the outputs of the packages its package uses, and those of TopoTopo's own
  // packages (house, stairs, …) it does not use yet
  const engine = new Engine(createNodeHost({ baseDir: process.cwd() }));
  await engine.init();
  const pk = openPackages(engine, process.cwd());
  const defs = [...allNodeDefs(), ...engine.assetsIn().map((x) => x.def), ...engine.packageDefs()];
  if (argv.includes('--catalog')) console.log(catalogText(defs, { cli: true }));
  else {
    const name = opt('--help-node')!;
    // an output of a package that the package does not use yet is read where its library holds it (nothing is copied)
    const d = defs.find((x) => x.type === name) ?? (name.includes('/') ? engine.resolveDef(name) ?? pk.describe(name) ?? undefined : undefined);
    // a package output this folder cannot cook as it is (one of TopoTopo's own it does not use, a folder in no package)
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
} else if (['web', 'library', 'edit', 'workspace', 'init', 'libraries', 'use', 'remove', 'packages', 'publish', 'search', 'outdated', 'check', 'update'].includes(argv[0])) {
  // the web app, its libraries and its editor; a package and the packages it uses (src/packages/commands.ts). A command that ends
  // gives its exit code; the web app and the editor keep running
  const { commands } = await import('./packages/commands.ts');
  const code = await commands[argv[0]](argv.slice(1), prog);
  if (typeof code === 'number') process.exit(code);
} else if (argv[0] === 'mcp') {
  // `topotopo mcp [--package dir] [--viewer]`: the MCP server over stdio; src/mcp/server.ts reads the remaining
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
  if (target !== undefined && graph?.nodes && !Object.hasOwn(graph.nodes, target) && graph?.outputs && Object.hasOwn(graph.outputs, target))
    fail(`--node: ${file} has no node "${target}", but an output of that name: --output ${target}`);
  if (outputName !== undefined) {
    const outs: Record<string, any> = graph?.outputs && typeof graph.outputs === 'object' ? graph.outputs : {};
    const o = Object.hasOwn(outs, outputName) ? outs[outputName] : undefined;
    if (!o || typeof o.node !== 'string') {
      const names = Object.keys(outs), s = didYouMean(outputName, names);
      const isNode = !!graph?.nodes && typeof graph.nodes === 'object' && Object.hasOwn(graph.nodes, outputName);
      fail(`--output: ${file} has no output "${outputName}"${isNode ? `, but a node of that name: --node ${outputName}` : s.length ? ` (did you mean ${s.join(', ')}?)` : ''}; ${names.length ? `its outputs: ${names.join(', ')}` : 'it publishes no "outputs" (--node picks any node)'}`);
    }
    target = o.node;
  }
  const engine = new Engine(createNodeHost({ baseDir: path.dirname(path.resolve(file)) }));
  await engine.init();
  // the packages of the package the file belongs to: one the graph names for the first time is added (said), and
  // --follow uses a package's working folder for this run. A graph that does not validate as a dry run sees it adds
  // nothing: its errors are said and the run ends. --locked (a build machine) adds nothing and changes no file: a
  // package the package does not use, or a copy missing or edited by hand, fails the run instead.
  let pk: ReturnType<typeof openPackages>;
  try { pk = openPackages(engine, path.dirname(path.resolve(file)), { follow: followArgs }); } catch (e) { fail(`--follow: ${(e as Error).message}`); }
  const dry = pk!.dryRun(graph);
  const invalid = engine.validate(graph, '', { ...engine.root, id: dry.id, packages: dry.resolver }).errors;
  if (invalid.length) fail(invalid.map((e) => `error [${e.node}] ${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`).join('\n'));
  if (argv.includes('--locked')) {
    const unlocked = pk!.locked(graph);
    if (unlocked.length) fail(unlocked.map((x) => `--locked: ${x}`).join('\n'));
  } else for (const n of pk!.addFor(graph)) console.log(n);
  for (const p of pk!.check()) console.error(`warning: ${p}`);
  for (const f of pk!.following()) console.log(`following ${f.package}: its working folder ${f.dir} instead of its copy, for renders and inspect (exports use the published copy)`);
  // the packages shown live (--follow, a workspace that follows its own) are for looking: an export cooks with their
  // published copies (a cook of its own when the graph names one) and says so
  const exportNote = pk!.publishedNote(graph);
  const exportScope = exportNote ? pk!.published() : null;
  const forExport = async (r: CookReport, node = r.target): Promise<CookReport> => {
    if (!exportScope) return r;
    const e = await engine.cook(graph, { target: node, frame: r.frame, fps: r.fps, scope: exportScope });
    if (!e.ok || !e.geo) fail(`export: with the published copies, ${node} does not cook (${e.errors.map((x) => `${x.node}: ${x.message}`).join('; ') || 'no geometry'}); nothing was written`);
    return e;
  };
  const fps = opt('--fps') !== undefined ? Number(opt('--fps')) : undefined;
  const framesArg = opt('--frames');
  const frameArg = opt('--frame');
  if (framesArg && frameArg) fail('use either --frame or --frames, not both');
  if (framesArg && argv.includes('--export-all')) fail('--export-all writes one frame: use --frame N, not --frames');
  const single = frameArg !== undefined ? Number(frameArg) : undefined;
  if (single !== undefined && !Number.isFinite(single)) fail(`--frame expects a number, got "${frameArg}"`);

  // --inspect <detail>: checked before cooking
  const INSPECT_DETAILS = ['summary', 'attributes', 'topology', 'all', 'uv', 'budget', 'scene'];
  const inspectDetail = opt('--inspect');
  if (argv.includes('--inspect') && (inspectDetail === undefined || !INSPECT_DETAILS.includes(inspectDetail))) {
    const s = inspectDetail ? didYouMean(inspectDetail, INSPECT_DETAILS) : [];
    fail(`--inspect needs one of ${INSPECT_DETAILS.join(', ')}${inspectDetail ? `, got "${inspectDetail}"${s.length ? ` (did you mean ${s.join(', ')}?)` : ''}` : ''}`);
  }
  const uvRes = opt('--uv-resolution') !== undefined ? Number(opt('--uv-resolution')) : undefined;

  /** The --inspect report of a cook: text, or the uv / budget / scene report as JSON with --json. */
  async function inspectText(r: CookReport): Promise<string> {
    const geo = r.geo!, json = argv.includes('--json');
    if (inspectDetail === 'scene') {
      // the glb export with the export options given, read back
      const res = await serializeExport(geo, 'glb', 'scene.glb', exportArgs(), engine.host);
      const glb = res.files.find((f) => /\.glb$/i.test(f.path));
      if (!glb) return 'scene: the glb export wrote no file';
      const rep = glbSceneReport(glb.bytes);
      const warn = res.warnings.map((w) => `warning: ${w}`);
      return json ? JSON.stringify(rep, null, 2) : [...sceneReportText(rep), ...warn].join('\n');
    }
    if (inspectDetail === 'uv' && json) return JSON.stringify(uvReport(geo, { resolution: uvRes }), null, 2);
    if (inspectDetail === 'budget' && json) return JSON.stringify(budgetReport(geo, nodeBudgetInput(graph, r.results)), null, 2);
    return inspect(geo, { detail: inspectDetail as any, uvResolution: uvRes, nodes: inspectDetail === 'budget' ? nodeBudgetInput(graph, r.results) : undefined });
  }

  function report(r: CookReport) {
    for (const e of r.errors) console.error(`error [${e.node}] ${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`);
    for (const w of r.warnings) console.error(`warning [${w.node}] ${w.message}`);
  }

  /** Every render flag (renderFlags reads them, plus --views, --color-by, --checker). */
  const RENDER_FLAGS = ['--wireframe', '--hard-angle', '--section', '--clip', '--glyphs', '--glyph-attrib', '--glyph-scale', '--max-glyphs', '--labels', '--max-labels',
    '--shading', '--ao-radius', '--size', '--render-scale', '--azimuth', '--elevation', '--zoom', '--look-at', '--ortho-scale', '--texture', '--max-triangles', '--exposure',
    '--heightfield-res', '--heightfield-layer', '--underlay', '--underlay-opacity', '--underlay-fit', '--legend', '--points', '--annotate', '--textures', '--transparent',
    '--sockets', '--no-view-labels', '--no-grid', '--views', '--color-by', '--checker'];

  /** Render overlay flags → render tool arguments → RenderOptions (src/render/options.ts). */
  function renderFlags(get: (f: string) => string | undefined, has: (f: string) => boolean): RenderOptions {
    const a: Record<string, unknown> = {};
    for (const [f, k] of [['--wireframe', 'wireframe'], ['--hard-angle', 'hard_angle'], ['--section', 'section'], ['--clip', 'clip'], ['--glyphs', 'glyphs'],
      ['--glyph-attrib', 'glyph_attrib'], ['--glyph-scale', 'glyph_scale'], ['--max-glyphs', 'max_glyphs'], ['--labels', 'labels'], ['--max-labels', 'max_labels'],
      ['--shading', 'shading'], ['--ao-radius', 'ao_radius'], ['--size', 'size'], ['--render-scale', 'scale'], ['--azimuth', 'azimuth'], ['--elevation', 'elevation'],
      ['--zoom', 'zoom'], ['--look-at', 'look_at'], ['--ortho-scale', 'ortho_scale'], ['--texture', 'texture'], ['--max-triangles', 'max_triangles'], ['--exposure', 'exposure'],
      ['--heightfield-res', 'heightfield_res'], ['--heightfield-layer', 'heightfield_layer'], ['--underlay-opacity', 'underlay_opacity'], ['--underlay-fit', 'underlay_fit']]) if (get(f) !== undefined) a[k] = get(f);
    for (const [f, k] of [['--legend', 'legend'], ['--points', 'points'], ['--annotate', 'annotate'], ['--textures', 'textures'], ['--transparent', 'transparent'], ['--sockets', 'sockets']]) if (has(f)) a[k] = true;
    if (has('--no-view-labels')) a.view_labels = false;
    if (has('--no-grid')) a.grid = false;
    // a reference image path is relative to the current folder, as the output paths are
    if (get('--underlay') !== undefined) a.underlay = path.resolve(get('--underlay')!);
    try { return renderArgs(a); } catch (e: any) { return fail(e.message); }
  }

  // Several renders per run (one cook): every --render takes the render options that follow it, up to the next
  // --render; options before the first --render apply to all of them. With one --render this is the old behaviour.
  const renderAt = argv.flatMap((x, i) => (x === '--render' ? [i] : []));
  const sharedArgs = argv.slice(0, renderAt.length ? renderAt[0] : argv.length);
  // with several renders, options after the last --render belong to that render only: say so (a person who meant them
  // for every render puts them before the first --render)
  if (renderAt.length > 1) {
    const last = argv.slice(renderAt[renderAt.length - 1] + 2).filter((x) => RENDER_FLAGS.includes(x));
    if (last.length) console.error(`warning: ${last.join(' ')} after the last --render apply to ${argv[renderAt[renderAt.length - 1] + 1]} only; options before the first --render apply to every render`);
  }
  const renders = renderAt.map((start, n) => {
    const seg = argv.slice(start, n + 1 < renderAt.length ? renderAt[n + 1] : argv.length);
    if (!seg[1] || seg[1].startsWith('--')) fail('--render needs an output path (e.g. --render out.png)');
    const from = (args: string[], f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
    return { out: seg[1], get: (f: string) => from(seg, f) ?? from(sharedArgs, f), has: (f: string) => seg.includes(f) || sharedArgs.includes(f) };
  });

  async function writeOutputs(r: CookReport, frame?: number) {
    const geo = r.geo!;
    const at = (p: string) => (frame === undefined ? p : framePath(p, frame));
    // Receipts for the viewer's saved files, only for files inside the package's exports/ (exportsFolderFor): a run whose
    // output goes elsewhere leaves no exports/ folder behind (the viewer lists that folder's files without receipts too).
    const exportsDir = exportsFolderFor(file);
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
      // the export tool's options (the MCP export tool and export targets use the same names and code)
      const a = exportArgs();
      const x = await forExport(r);
      const source = exportSource({ graph: graphName(file), spec: graph, node: r.target, output: outputName, frame: r.frame, fps: r.fps, format: fmt, options: a, packages: packagesUsed(engine, graph, exportScope ?? engine.root), version: TOPOTOPO_VERSION });
      const res = await serializeExport(x.geo!, fmt, p, a, engine.host, source);
      for (const w of res.warnings) console.warn(`warning: ${w}`);
      writeExportFiles(res.files);
      if (res.files.length) record(res.files.map((f) => f.path), fmt);
      const files = res.files.filter((f) => f.path !== res.sourceManifest);
      console.log(`exported ${files.length === 1 ? files[0].path : files.map((f) => f.path).join(', ')}${files.length > 1 || fmt !== 'glb' ? ` — ${res.summary}` : ''}${res.sourceFile ? `; source: ${res.sourceFile}` : ''}`);
      if (exportNote) console.log(exportNote);
    }
  }

  /** The export flags given, as the export tool's options (snake_case, as export targets and the MCP export tool name them). */
  function exportArgs(): Record<string, unknown> {
    // every option of the export tool has a flag: --name value, booleans --name / --no-name (io/targets.ts)
    try { return exportOptionsFromFlags(argv); } catch (e) { return fail(`export: ${(e as Error).message}`); }
  }

  if (framesArg) {
    const range = parseFrames(framesArg);
    const res = await engine.cookFrames(graph, range, async (r, f) => {
      report(r);
      if (!r.ok || !r.geo) return;
      const cooked = [...r.results.values()].filter((n) => !n.cached && !n.error).length;
      console.log(`frame ${f}: ${r.target} in ${r.ms.toFixed(0)} ms (${cooked} node(s) cooked) — ${r.geo.numPoints} points, ${r.geo.numPrims} prims`);
      if (inspectDetail) console.log(await inspectText(r));
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
    // without --inspect the short summary; --inspect <detail> the report (src/inspect.ts, io/inspect-scene.ts)
    console.log(inspectDetail ? await inspectText(r) : summarize(r.geo));
    await writeOutputs(r);
    if (argv.includes('--export-all')) await exportAll();
  }

  /** --export-all: every published output with an export target (io/targets.ts), into the package's exports/ (exportsFolderFor). */
  async function exportAll() {
    const name = graphName(file), exportsDir = exportsFolderFor(file);
    const published = publishedOutputs(name, graph, engine.findOutput(graph).name);
    if (!published.some((p) => p.target)) fail(`--export-all: no output of ${file} has an export target; add "export": "glb" to the graph (default output) or to an entry of "outputs"`);
    const prepared: PreparedTarget[] = [];
    for (const p of published) {
      if (!p.target) continue;
      const r = await engine.cook(graph, { target: p.node, frame: single, fps, ...(exportScope ? { scope: exportScope } : {}) });
      report(r);
      if (!r.ok || !r.geo) fail(`--export-all: "${p.label}" did not cook${exportScope ? ' with the published copies' : ''}; nothing was written`);
      prepared.push(await prepareTarget(r.geo!, name, p as typeof p & { target: NonNullable<typeof p.target> }, exportsDir, engine.host, { frame: r.frame, fps: r.fps, packages: packagesUsed(engine, graph, exportScope ?? engine.root) }));
    }
    writeTargets(prepared, exportsDir);
    // paths as the person finds them from where they ran the command
    const rel = (f: string) => path.relative(process.cwd(), f) || f;
    for (const p of prepared) console.log(`exported ${p.label} → ${rel(path.join(p.root, ...p.target.path.split('/')))} — ${p.summary}${p.sourceFile ? `; source: ${rel(p.sourceFile)}` : ''}`);
    const skipped = published.filter((p) => !p.target).map((p) => p.label);
    if (skipped.length) console.log(`no export target (skipped): ${skipped.join(', ')}`);
    if (exportNote) console.log(exportNote);
  }
  // stop the kernel worker threads (idle ones would not hold the process, but a clean exit should not wait on them)
  await engine.host.pool?.close();
}
