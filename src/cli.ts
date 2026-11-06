#!/usr/bin/env node
// Command line: cook a graph JSON file, then render / export / inspect.
//   node src/cli.ts <graph.json> [--node name | --output name] [--var name=value]… [--frame N | --frames A-B[:step]] [--fps 24]
//                   [--render out.png] [--views quad|quad_uv|turntable|persp|front_left|front,top|persp,uv|persp,section] [--checker] [--color-by attr]
//                   [--wireframe all|hard|boundary|groups] [--section y:0.5] [--clip x:0.5] [--glyphs N|up|orient|v] [--labels groups,pieces,points,prims,attrib:name]
//                   [--shading flat|matcap|ao|pbr] [--exposure 0] [--cd auto|ignore|multiply] [--grey] [--legend] [--size 800|1600x600] [--render-scale 2] [--heightfield-res 256|full]
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
//   node src/cli.ts web [--port 7340] [--library dir]  the web app for the workspaces and libraries (src/packages/commands.ts)
//   node src/cli.ts library add|remove|list|new|bake …    registered libraries and packages; edit [folder] opens the
//                                                         live viewer on a package
// The workspace around packages (src/workspace.ts), a package and the packages it uses (src/packages/commands.ts,
// src/packages/registry.ts, src/packages/update.ts):
//   node src/cli.ts workspace [folder]
//   node src/cli.ts workspace init [folder] [--name n] [--engine godot:<path>|unreal:<path>|none] [--library <name or folder>] [--follow | --no-follow]
//   node src/cli.ts workspace library add|remove <name or folder> [--workspace <folder>]
//   node src/cli.ts workspace add|list [folder]
//   node src/cli.ts init [folder] [--name owner/name]
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
//   build machine. --follow owner/name on a cook or view uses a package's working folder instead of its copy; a
//   graph-file cook's exports use it too (their source record says so under "followed"), but with --locked, which
//   exports published versions alone. The viewer's exports use the published copy.
// A package's published outputs cooked into a Godot project, and the Godot plugin (src/host/godot.ts, src/host/cook.ts;
// integrations/godot/PROTOCOL.md):
//   node src/cli.ts cook <.topo | package folder | folder>... --for godot [--into <folder>] [--flat] [--skip a,b] [--instancing packed|expand] [--adopt] [--force] [--no-cache] [--timeout <s>] [--report <file>] [--progress json] [--quiet]
//   node src/cli.ts cook --jobs <jobs.json> [--force] [--no-cache] [--progress json]
//   node src/cli.ts godot setup <godot project folder> [--no-enable]
//   node src/cli.ts godot status <godot project folder> [--strict] [--json]
// Installed from npm the same commands are `topotopo …` (package.json bin → dist/cli.js, built by npm run build).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import './nodes/index.ts';
import { Engine } from './graph/engine.ts';
import type { CookReport, FrameRange } from './graph/engine.ts';
import { allNodeDefs } from './graph/registry.ts';
import { KINDS } from './graph/outputs.ts';
import { createNodeHost, limitsFromEnv } from './host/node.ts';
import { timingLines } from './graph/timing.ts';
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
import { GODOT_COMMANDS } from './host/godot-commands.ts';
import { setProgram, writeAtomic } from './package.ts';
import { refreshGraph, refreshNotes } from './graph/refresh.ts';
import { isGraph } from './graph/types.ts';
import type { GraphSpec } from './graph/types.ts';
import { openPackages } from './packages/registry.ts';
import { ArtifactStore } from './host/artifacts.ts';
import { exportsFolderFor, prepareTarget, serializeExport, writeExportFiles, writeTargets } from './host/export-targets.ts';
import type { PreparedTarget } from './host/export-targets.ts';
import { TOPOTOPO_VERSION } from './host/version.ts';
import { exportOptionsFromFlags, prefixGone, publishedOutputs } from './io/targets.ts';
import { budgetReport, inspect, nodeBudgetInput, summarize } from './inspect.ts';
import { glbSceneReport, sceneReportText } from './io/inspect-scene.ts';
import { uvReport } from './core/uvreport.ts';
import { didYouMean } from './graph/params.ts';
import { parseVarArg, withVars } from './graph/vars.ts';
import { catalogText, nodeDoc, topicList, topicText } from './mcp/docs.ts';

const argv = process.argv.slice(2);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
/** One output of a cook run: its own options (args) and those for every output (base: before the first --output). */
interface Unit { args: string[]; base: string[]; outputName?: string; target?: string }
/** An option's value for an output: its own before the one for every output. */
const uopt = (u: Unit, f: string) => { for (const l of [u.args, u.base]) { const i = l.indexOf(f); if (i >= 0) return l[i + 1]; } return undefined; };
const uhas = (u: Unit, f: string) => u.args.includes(f) || u.base.includes(f);
const fail = (msg: string): never => { console.error(msg); process.exit(1); };
// the time limits every engine of this process takes from the environment: a value that is not a number fails here
try { limitsFromEnv(); } catch (e) { fail((e as Error).message); }
/** A graph file's name as a graph (view mode) and in receipts and default export file names. */
const graphName = (file: string) => path.basename(file).replace(/\.json$/i, '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]/, 'g$&') || 'graph';
// the command as the user typed it: the sources from a clone, or the package's bin (dist/cli.js)
const prog = import.meta.url.endsWith('.ts') ? 'node src/cli.ts' : 'topotopo';
// the hints of every command name it so
setProgram(prog);

// the global version flag is the first argument (or the only one); later ones belong to the command (use <package> --version 1.0)
if (['-v', '-V', '--version'].includes(argv[0] ?? '')) {
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
    '         several outputs in one run: repeat --output; each takes the options after it up to the next --output (its --export,',
    '           --format, --render, --inspect, export options); options before the first --output apply to every output. The graph,',
    '           its packages and shared nodes (a material package\'s maps) load and cook once:',
    '           --scale 100 --output wall --export wall.glb --output gate --export gate.glb --render gate.png',
    '         [--var name=value] (override a graph var for this run; repeat it; numbers, true/false and JSON values are parsed, other text is a string)',
    '         [--export-all] (every output with an export target in the graph, into exports/ of its package folder)',
    '         [--timing] (every cooked node with its time, slowest first, and the lib.run time of a script by node type; said without the flag for the slowest nodes of a cook that takes 1 s or more)',
    '         time limits (environment, milliseconds; also for the MCP server and the viewer): TOPOTOPO_SCRIPT_TIMEOUT_MS (user code: expressions, wrangles, a whole script; default 30000), TOPOTOPO_SIM_TIMEOUT_MS (one cook of a simulation node; default 600000)',
    '         relative paths in the graph (file nodes, maps) read from its package folder: the nearest folder with a .topo file at or',
    '           above the graph file, else the graph file\'s folder; --render/--export/--underlay paths are relative to the current folder',
    '         [--follow owner/name] (use that package\'s working folder, where the package finds it, instead of its copy, for this run: renders, inspect and exports use it, unpublished (the export\'s source record lists it under "followed"); repeat it)',
    '         [--locked] (a build machine: a package the graph names that the package does not use, or a copy missing or edited by hand, fails the run instead of being added; exports use the published copies, whatever --follow shows)',
    '         render overlays: [--wireframe all|hard|boundary|groups] [--hard-angle 30] [--section y:0.5] [--clip x:0.5[:abs]]',
    '                          [--glyphs N|up|orient|v] [--glyph-attrib a] [--labels groups,pieces,points,prims,attrib:name] [--legend] [--points]',
    '                          [--shading flat|matcap|ao|pbr] [--exposure 0] [--size 800|1600x600] [--render-scale 2]',
    '                          [--cd auto|ignore|multiply] (shading pbr: auto = a named material wins over Cd, Cd colours prims without one; multiply = Cd tints the material too)',
    '                          [--grey] (value check: pbr with every base colour a neutral 18% grey; roughness, metallic and normal maps still apply)',
    '                          views: persp front back left right top bottom front_left front_right back_left back_right uv section texture persp@<az>',
    '                          framing: every 3D view fits the bounds; [--zoom 1] is relative to that fit (above 1 only with --look-at or --ortho-scale)',
    '                          [--azimuth 35] (degrees around +Y: 0 = camera on +Z at the front, 90 = on +X, the right side) [--elevation 25] (degrees above the horizon)',
    '                          [--look-at x,y,z] (world metres, Y up, +Z front) [--ortho-scale 0.5] (metres across an ortho view)',
    '                          camera by position: [--from x,y,z --to x,y,z] [--fov 40] (degrees across the width): the persp view from exactly there, nothing fitted,',
    '                            to match a concept or game camera (an --underlay then fills the view); without --views the render is that one view',
    '                          [--bounds x0,y0,z0,x1,y1,z1] (world metres: every 3D view frames these corners instead of the own box of the geometry, so a sequence shares one camera)',
    '                          [--transparent] (PNG with alpha) [--no-grid] [--sockets] (scene empties as labelled dots with orient axes)',
    '                          [--underlay ref.png] (a reference PNG behind the 3D views) [--underlay-opacity 0.5] [--underlay-fit bounds|width|height|view]',
    '                          [--textures] (base colour maps on meshes) [--texture name|image/layer|material] (adds the texture view)',
    '                          [--max-triangles 600000] (packed instances drawn; above it an evenly spread subset)',
    '                          [--heightfield-res 256|full] (heightfields: quads drawn per side, default 256, said in the footer when a field has more; full = every sample)',
    '                          [--heightfield-layer flow] (heightfields: the layer drawn in red, default mask; none draws none)',
    '                          [--no-view-labels] (no view name labels or axis gizmo, e.g. for thumbnails) [--no-footer] (no footer strip: the image is the tiles only)',
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
    `       ${prog} refresh <graph.json> <generated.json | ->   (a regenerated graph written over graph.json keeping what a person tuned: changed var values that still fit, control labels and steps, node ui, meta; - reads stdin)`,
    `       ${prog} web [--port 7340] [--library <folder>] [--no-bake]   (the web app: the registered workspaces and every library's packages, stable links for a board)`,
    `       ${prog} library add <name> <folder> | remove <name> | list | new <library or workspace> <folder/name> [--title t] [--tags a,b] | bake <package>|--stale|--all   (registered libraries)`,
    `       ${prog} edit [folder] [--port 7341]   (the live viewer on a package, default the current folder's)`,
    '       a package and the packages it uses (a folder named must exist; default: the current folder\'s package; kinds: ' + KINDS.join(', ') + '; --help-topic packages):',
    ...PACKAGE_COMMANDS.map((c) => `       ${prog} ${c.usage}   (${c.what})`),
    '       Godot (exit 0 ok, 1 an output or package failed, 2 usage or setup; --help-topic godot):',
    ...GODOT_COMMANDS.map((c) => `       ${prog} ${c.usage}   (${c.what})`),
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
    // an output of a package this one does not use yet is read where its library holds it (nothing is copied)
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

if (argv[0] === 'refresh') {
  // `topotopo refresh <graph.json> <generated.json | ->`: a generator's new graph written over graph.json, keeping what
  // a person tuned on it (src/graph/refresh.ts); a viewer following graph.json cooks the result
  const [file, from] = [argv[1], argv[2]];
  if (!file || file.startsWith('-') || !from || (from.startsWith('-') && from !== '-')) fail(`usage: ${prog} refresh <graph.json> <generated.json | - (read from stdin)>`);
  const read = (f: string, what: string): GraphSpec => {
    let g: unknown;
    try { g = JSON.parse(fs.readFileSync(f === '-' ? 0 : f, 'utf8')); } catch (e) { return fail(`${prog} refresh: ${what} ${f === '-' ? '(stdin)' : `"${f}"`}: ${(e as Error).message}`); }
    return isGraph(g) ? g : fail(`${prog} refresh: ${what} ${f === '-' ? '(stdin)' : `"${f}"`} is not a graph (an object with "nodes")`);
  };
  const generated = read(from, 'the generated graph');
  const existed = fs.existsSync(file);
  const r = refreshGraph(existed ? read(file, 'the graph') : { nodes: {} }, generated);
  writeAtomic(file, JSON.stringify(r.graph, null, 2));
  console.log(`${existed ? 'refreshed' : 'wrote'} ${file}`);
  for (const n of refreshNotes(r)) console.log(n);
  process.exit(0);
}

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
} else if (argv[0] === 'cook' || argv[0] === 'godot') {
  // a package's published outputs cooked into a Godot project, and the Godot plugin's setup and status
  // (src/host/godot.ts, src/host/cook.ts): exit 0, 1 (an output or package failed), 2 (usage, setup or protocol)
  const { cookCommand, godotCommand } = await import('./host/godot.ts');
  const { consoleIo } = await import('./packages/commands.ts');
  process.exit(await (argv[0] === 'cook' ? cookCommand : godotCommand)(argv.slice(1), consoleIo));
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
  // --output name: a named output (graph.outputs) instead of the default output. Several outputs in one run: repeat
  // --output; each takes the options that follow it, up to the next --output (its --export, --format, --render,
  // --inspect and export options), and options before the first --output apply to every output. The graph, its
  // packages and the engine load once, so the nodes the outputs share (a material package's maps) cook once. With one
  // --output (or none) options are read from anywhere, as always.
  const outputAt = argv.flatMap((x, i) => (x === '--output' ? [i] : []));
  const multi = outputAt.length > 1;
  const units: Unit[] = multi ? outputAt.map((s, n) => ({ args: argv.slice(s, outputAt[n + 1] ?? argv.length), base: argv.slice(0, outputAt[0]) })) : [{ args: argv, base: [] }];
  if (multi) {
    for (const f of ['--var', '--follow', '--locked', '--frame', '--frames', '--fps', '--timing', '--node', '--export-all'])
      if (units.some((u) => u.args.includes(f))) fail(`${f} applies to the whole run: put it before the first --output`);
    for (const f of ['--export', '--render']) if (units[0].base.includes(f)) fail(`${f} before the first --output would write every output to one file: give each --output its own ${f}`);
    if (argv.includes('--frames')) fail('several outputs in one run cook one frame: use --frame N, not --frames');
    if (argv.includes('--export-all')) fail('--export-all already exports every output with an export target: leave out --output, or give each --output its own --export');
  }
  for (const u of units) {
    const outputName = uopt(u, '--output');
    if (uhas(u, '--output') && (outputName === undefined || outputName.startsWith('--'))) fail('--output needs the name of one of the graph\'s outputs');
    if (outputName !== undefined && uopt(u, '--node') !== undefined) fail('use either --node or --output, not both');
    let target = uopt(u, '--node');
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
    u.outputName = outputName; u.target = target;
  }
  const engine = new Engine(createNodeHost({ baseDir: path.dirname(path.resolve(file)) }));
  await engine.init();
  // the packages the file's package uses: one the graph names for the first time is added (said), and
  // --follow uses a package's working folder for this run. A graph that does not validate as a dry run sees it adds
  // nothing: its errors are said and the run ends. --locked (a build machine) adds nothing and changes no file: a
  // package it does not use, or a copy missing or edited by hand, fails the run instead.
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
  // --follow names the working folders exports use too (their source record lists them under "followed"); --locked
  // exports published versions alone. Other packages shown live (a workspace that follows its own) are for looking:
  // an export cooks with their published copies (a cook of its own when the graph names one) and says so
  const locked = argv.includes('--locked'), exportFollow = locked ? [] : followArgs;
  for (const f of pk!.following()) {
    console.log(`following ${f.package}: its working folder ${f.dir} instead of its copy, ${exportFollow.includes(f.package) ? 'for renders, inspect and exports (unpublished: the export\'s source record says so)' : 'for renders and inspect (exports use the published copy)'}`);
  }
  const exportNote = pk!.publishedNote(graph, exportFollow);
  const exportScope = exportNote ? pk!.published(exportFollow) : null;
  /** What to do about followed packages an export would cook from published copies: publish them, or follow them. */
  const publishOrFollow = (pkgs: { package: string; dir: string }[]) => pkgs.map((u) => (locked
    ? `publish ${u.package} (${prog} publish ${u.dir} --note "...") and use it: --locked exports published versions alone`
    : `publish ${u.package} (${prog} publish ${u.dir} --note "...") or pass --follow ${u.package} to export from its working folder`)).join('; ');
  /** Why an export cannot cook with the published copies: followed packages it names that have none in use. */
  const exportBlocked = () => {
    const missing = pk!.unpublished(graph, exportFollow);
    return missing.length ? `${missing.map((u) => u.package).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no published version in use (this run shows ${missing.length === 1 ? 'its working folder' : 'their working folders'}, for looking): ${publishOrFollow(missing)}` : null;
  };
  const forExport = async (r: CookReport, node = r.target): Promise<CookReport> => {
    if (!exportScope) return r;
    const blocked = exportBlocked();
    if (blocked) fail(`export: ${blocked}; nothing was written`);
    const e = await engine.cook(graph, { target: node, frame: r.frame, fps: r.fps, scope: exportScope });
    if (!e.ok || !e.geo) {
      const shown = pk!.following().filter((f) => !exportFollow.includes(f.package)).map((f) => ({ package: f.package, dir: f.dir }));
      fail(`export: with the published copies, ${node} does not cook (${e.errors.map((x) => `${x.node}: ${x.message}`).join('; ') || 'no geometry'})${shown.length ? `: ${publishOrFollow(shown)}` : ''}; nothing was written`);
    }
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
  /** The --inspect detail of an output (undefined: the short summary). */
  const inspectOf = (u: Unit) => {
    const d = uopt(u, '--inspect');
    if (uhas(u, '--inspect') && (d === undefined || !INSPECT_DETAILS.includes(d))) {
      const s = d ? didYouMean(d, INSPECT_DETAILS) : [];
      fail(`--inspect needs one of ${INSPECT_DETAILS.join(', ')}${d ? `, got "${d}"${s.length ? ` (did you mean ${s.join(', ')}?)` : ''}` : ''}`);
    }
    return d;
  };
  for (const u of units) inspectOf(u);

  /** The --inspect report of a cook: text, or the uv / budget / scene report as JSON with --json. */
  async function inspectText(r: CookReport, u: Unit): Promise<string> {
    const inspectDetail = inspectOf(u), uvRes = uopt(u, '--uv-resolution') !== undefined ? Number(uopt(u, '--uv-resolution')) : undefined;
    const geo = r.geo!, json = uhas(u, '--json');
    if (inspectDetail === 'scene') {
      // the glb export with the export options given, read back
      const res = await serializeExport(geo, 'glb', 'scene.glb', exportArgs(u), engine.host);
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
  /** Where the cook's time went: with --timing every cooked node, else the slowest when the cook took a second or more. */
  const timingFlag = argv.includes('--timing');
  function timing(r: CookReport) {
    if (!timingFlag && r.ms < 1000) return;
    for (const l of timingLines(r, engine.scriptTimeoutMs, timingFlag ? { minMs: 0, nodes: Infinity } : {})) console.log(l);
  }

  /** Every render flag (renderFlags reads them, plus --views, --color-by, --checker). */
  const RENDER_FLAGS = ['--wireframe', '--hard-angle', '--section', '--clip', '--glyphs', '--glyph-attrib', '--glyph-scale', '--max-glyphs', '--labels', '--max-labels',
    '--shading', '--ao-radius', '--size', '--render-scale', '--azimuth', '--elevation', '--zoom', '--look-at', '--bounds', '--ortho-scale', '--texture', '--max-triangles', '--exposure', '--cd',
    '--heightfield-res', '--heightfield-layer', '--underlay', '--underlay-opacity', '--underlay-fit', '--legend', '--points', '--annotate', '--textures', '--transparent',
    '--sockets', '--grey', '--no-view-labels', '--no-footer', '--no-grid', '--views', '--color-by', '--checker', '--from', '--to', '--fov'];

  /** Render overlay flags → render tool arguments → RenderOptions (src/render/options.ts). */
  function renderFlags(get: (f: string) => string | undefined, has: (f: string) => boolean): RenderOptions {
    const a: Record<string, unknown> = {};
    for (const [f, k] of [['--wireframe', 'wireframe'], ['--hard-angle', 'hard_angle'], ['--section', 'section'], ['--clip', 'clip'], ['--glyphs', 'glyphs'],
      ['--glyph-attrib', 'glyph_attrib'], ['--glyph-scale', 'glyph_scale'], ['--max-glyphs', 'max_glyphs'], ['--labels', 'labels'], ['--max-labels', 'max_labels'],
      ['--shading', 'shading'], ['--ao-radius', 'ao_radius'], ['--size', 'size'], ['--render-scale', 'scale'], ['--azimuth', 'azimuth'], ['--elevation', 'elevation'],
      ['--zoom', 'zoom'], ['--look-at', 'look_at'], ['--bounds', 'bounds'], ['--ortho-scale', 'ortho_scale'], ['--texture', 'texture'], ['--max-triangles', 'max_triangles'], ['--exposure', 'exposure'], ['--cd', 'cd'],
      ['--heightfield-res', 'heightfield_res'], ['--heightfield-layer', 'heightfield_layer'], ['--underlay-opacity', 'underlay_opacity'], ['--underlay-fit', 'underlay_fit']]) if (get(f) !== undefined) a[k] = get(f);
    for (const [f, k] of [['--legend', 'legend'], ['--points', 'points'], ['--annotate', 'annotate'], ['--textures', 'textures'], ['--transparent', 'transparent'], ['--sockets', 'sockets'], ['--grey', 'grey']]) if (has(f)) a[k] = true;
    // a camera by position: --from x,y,z --to x,y,z [--fov 40]
    if (get('--from') !== undefined || get('--to') !== undefined || get('--fov') !== undefined) {
      if (get('--from') === undefined || get('--to') === undefined) return fail('a camera by position needs --from x,y,z and --to x,y,z (world metres; --fov is optional, degrees across the width, default 40)');
      a.camera = { from: get('--from'), to: get('--to'), ...(get('--fov') !== undefined ? { fov: get('--fov') } : {}) };
    }
    if (has('--no-view-labels')) a.view_labels = false;
    if (has('--no-grid')) a.grid = false;
    if (has('--no-footer')) a.footer = false;
    // a reference image path is relative to the current folder, as the output paths are
    if (get('--underlay') !== undefined) a.underlay = path.resolve(get('--underlay')!);
    try { return renderArgs(a); } catch (e: any) { return fail(e.message); }
  }

  // Several renders per cook: every --render takes the render options that follow it, up to the next --render;
  // options before the first --render apply to all of them (and, with several outputs, the options before the first
  // --output to every output's renders). With one --render this is the old behaviour.
  function rendersOf(u: Unit) {
    const av = u.args;
    const renderAt = av.flatMap((x, i) => (x === '--render' ? [i] : []));
    const sharedArgs = av.slice(0, renderAt.length ? renderAt[0] : av.length);
    // with several renders, options after the last --render belong to that render only: say so (a person who meant
    // them for every render puts them before the first --render)
    if (renderAt.length > 1) {
      const last = av.slice(renderAt[renderAt.length - 1] + 2).filter((x) => RENDER_FLAGS.includes(x));
      if (last.length) console.error(`warning: ${last.join(' ')} after the last --render apply to ${av[renderAt[renderAt.length - 1] + 1]} only; options before the first --render apply to every render`);
    }
    return renderAt.map((start, n) => {
      const seg = av.slice(start, n + 1 < renderAt.length ? renderAt[n + 1] : av.length);
      if (!seg[1] || seg[1].startsWith('--')) fail('--render needs an output path (e.g. --render out.png)');
      const from = (args: string[], f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
      return { out: seg[1], get: (f: string) => from(seg, f) ?? from(sharedArgs, f) ?? from(u.base, f), has: (f: string) => seg.includes(f) || sharedArgs.includes(f) || u.base.includes(f) };
    });
  }
  const rendersByUnit = new Map(units.map((u) => [u, rendersOf(u)]));

  async function writeOutputs(r: CookReport, u: Unit, frame?: number) {
    const geo = r.geo!;
    const at = (p: string) => (frame === undefined ? p : framePath(p, frame));
    // Receipts for the viewer's saved files, only for files inside the package's exports/ (exportsFolderFor): a run whose
    // output goes elsewhere leaves no exports/ folder behind (the viewer lists that folder's files without receipts too).
    const exportsDir = exportsFolderFor(file);
    const record = (paths: string[], format: string) => {
      const inside = paths.every((p) => { const rel = path.relative(exportsDir, path.resolve(p)); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
      if (inside) new ArtifactStore(exportsDir).record(paths, { graph: graphName(file), node: r.target, format });
    };
    for (const { out, get, has } of rendersByUnit.get(u)!) {
      const ro = renderFlags(get, has);
      const v = get('--views');
      let views = v === undefined || v === 'quad' ? undefined : parseViews(v);
      if (get('--section') !== undefined) views = !views && v === undefined ? ro.views : views && views.includes('section') ? views : [...(views ?? parseViews('quad')!), 'section'];
      if (get('--texture') !== undefined) views = !views && v === undefined ? ro.views : views && views.includes('texture') ? views : [...(views ?? parseViews('quad')!), 'texture'];
      const title = path.basename(file, '.json') + (multi ? ` · ${u.outputName}` : '') + (r.frame !== 1 ? ` @ frame ${r.frame}` : '');
      const img = await renderGeometryAsync(geo, { ...ro, views, colorBy: get('--color-by') ?? null, checker: has('--checker'), title }, (t) => engine.host.readFile(t));
      const p = at(out);
      fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
      fs.writeFileSync(p, encodePNG(img.rgba, img.width, img.height, (d) => zlib.deflateSync(d)));
      record([p], 'png');
      console.log(`rendered ${p} (${img.width}x${img.height})${img.notes.length ? ' — ' + img.notes.join('; ') : ''}`);
    }
    const ex = uopt(u, '--export');
    if (ex) {
      const p = at(ex);
      const raw = (uopt(u, '--format') ?? exportFormatFromPath(ex)).toLowerCase();
      const fmt = (({ png: 'png16', raw: 'r16' } as Record<string, string>)[raw] ?? raw) as ExportFormat;
      if (!EXPORT_FORMATS.includes(fmt)) fail(`unknown export format "${fmt}" (${EXPORT_FORMATS.join(', ')}); pass --format`);
      // the export tool's options (the MCP export tool and export targets use the same names and code)
      const a = exportArgs(u);
      const x = await forExport(r);
      const source = exportSource({ graph: graphName(file), spec: graph, node: r.target, output: u.outputName, frame: r.frame, fps: r.fps, format: fmt, options: a, packages: packagesUsed(engine, graph, exportScope ?? engine.root), version: TOPOTOPO_VERSION });
      const res = await serializeExport(x.geo!, fmt, p, a, engine.host, source);
      for (const w of res.warnings) console.warn(`warning: ${w}`);
      writeExportFiles(res.files);
      if (res.files.length) record(res.files.map((f) => f.path), fmt);
      const files = res.files.filter((f) => f.path !== res.sourceManifest);
      console.log(`exported ${files.length === 1 ? files[0].path : files.map((f) => f.path).join(', ')}${files.length > 1 || fmt !== 'glb' ? ` — ${res.summary}` : ''}${res.sourceFile ? `; source: ${res.sourceFile}` : ''}`);
      if (exportNote) console.log(exportNote);
    }
  }

  /**
   * The export flags given for an output, as the export tool's options (snake_case, as export targets and the MCP
   * export tool name them): its own over those for every output.
   */
  function exportArgs(u: Unit): Record<string, unknown> {
    // every option of the export tool has a flag: --name value, booleans --name / --no-name (io/targets.ts)
    try { return { ...exportOptionsFromFlags(u.base), ...exportOptionsFromFlags(u.args) }; } catch (e) { return fail(`export: ${(e as Error).message}`); }
  }

  if (framesArg) {
    const range = parseFrames(framesArg);
    const res = await engine.cookFrames(graph, range, async (r, f) => {
      report(r);
      if (!r.ok || !r.geo) return;
      const cooked = [...r.results.values()].filter((n) => !n.cached && !n.error).length;
      console.log(`frame ${f}: ${r.target} in ${r.ms.toFixed(0)} ms (${cooked} node(s) cooked) — ${r.geo.numPoints} points, ${r.geo.numPrims} prims`);
      if (inspectOf(units[0])) console.log(await inspectText(r, units[0]));
      await writeOutputs(r, units[0], f);
    }, { target: units[0].target, fps });
    console.log(`cooked ${file} frames ${range.start}-${range.end}${range.step !== 1 ? `:${range.step}` : ''}: ${res.frames - res.failed.length}/${res.frames} ok`);
    if (res.failed.length) fail(`failed frames: ${res.failed.join(', ')}`);
  } else {
    const failed: string[] = [], t0 = performance.now();
    for (const u of units) {
      const r = await engine.cook(graph, { target: u.target, frame: single, fps });
      report(r);
      if (!r.ok || !r.geo) {
        timing(r);
        if (!multi) process.exit(1);
        console.error(`output "${u.outputName}" did not cook: nothing was written for it`);
        failed.push(u.outputName!);
        continue;
      }
      const vars = varArgs.length ? ` with ${varArgs.map((v) => v.trim()).join(', ')}` : '';
      const reused = multi && u !== units[0] ? [...r.results.values()].filter((n) => n.cached).length : 0;
      console.log(`cooked ${file} → ${u.outputName !== undefined ? `output "${u.outputName}" (${r.target})` : r.target}${r.frame !== 1 ? ` at frame ${r.frame}` : ''}${vars} in ${r.ms.toFixed(0)} ms${reused ? ` (${reused} node${reused === 1 ? '' : 's'} reused from the outputs before)` : ''}`);
      timing(r);
      // without --inspect the short summary; --inspect <detail> the report (src/inspect.ts, io/inspect-scene.ts)
      console.log(inspectOf(u) ? await inspectText(r, u) : summarize(r.geo));
      await writeOutputs(r, u);
    }
    if (argv.includes('--export-all')) await exportAll();
    if (multi) console.log(`${units.length - failed.length} of ${units.length} outputs in one run, ${((performance.now() - t0) / 1000).toFixed(1)} s${failed.length ? `; did not cook: ${failed.join(', ')}` : ''}`);
    if (failed.length) { await engine.host.pool?.close(); process.exit(1); }
  }

  /** --export-all: every published output with an export target (io/targets.ts), into the package's exports/ (exportsFolderFor). */
  async function exportAll() {
    const name = graphName(file), exportsDir = exportsFolderFor(file);
    const published = publishedOutputs(name, graph, engine.findOutput(graph).name);
    if (!published.some((p) => p.target)) fail(`--export-all: no output of ${file} has an export target; add "export": "glb" to the graph (default output) or to an entry of "outputs"`);
    const prepared: PreparedTarget[] = [];
    // a target the export refuses (its path written with a prefix that is gone) fails the run before anything cooks
    const refused = published.find((p) => p.target?.refused);
    if (refused) fail(`--export-all: "${refused.label}": ${prefixGone(refused.target!.refused!)}; nothing was written`);
    const blocked = exportScope ? exportBlocked() : null;
    if (blocked) fail(`--export-all: ${blocked}; nothing was written`);
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
