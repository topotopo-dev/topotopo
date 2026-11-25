#!/usr/bin/env node
// Command line: cook a graph JSON file, then render / export / inspect.
//   node src/cli.ts <graph.json> [--node name | --output name] [--var name=value]… [--frame N | --frames A-B[:step]] [--fps 24]
//                   [--render out.png] [--views quad|quad_uv|turntable|persp|front_left|front,top|persp,uv|persp,section] [--checker] [--color-by attr]
//                   [--wireframe all|hard|boundary|groups] [--section y:0.5] [--clip x:0.5] [--glyphs N|up|orient|v|comb] [--labels groups,pieces,points,prims,attrib:name]
//                   [--shading flat|matcap|zebra|ao|pbr] [--exposure 0] [--cd auto|ignore|multiply] [--grey] [--legend] [--size 800|1600x600] [--render-scale 2] [--heightfield-res 256|full]
//                   [--transparent] [--no-grid] [--underlay ref.png [--underlay-opacity 0.5] [--underlay-fit bounds|width|height|view]] [--sockets]
//                   [--heightfield-layer mask|<layer>|none] [--export out.glb] [--export out.obj]
//                   [--compress meshopt] [--maps embed|external|none] [--quantize] [--tangents auto|preserve|none] [--pcg | --pcg-struct] [--attributes P,N,pscale] [--up-axis z] [--scale 100]
//                   [--instancing packed|expand] [--instances rows|expand] [--no-meshes] [--custom-attribs | --no-custom-attribs] [--vertex-colors] [--no-materials]
//                   [--split-by-name | --no-split-by-name] [--precision 32|64] [--height-min 0 --height-max 100] [--heightfield 0]
//                   (every option of the export tool has a flag; booleans take --name / --no-name)
//                   [--inspect summary|attributes|topology|all|uv|budget|scene [--uv-resolution 1024] [--uv-attrib uv2] [--uv-per-piece] [--json]]
//   Results of nodes that cooked for 0.5 s or more are kept on disk between runs (src/host/diskcache.ts); --no-cache leaves
//   that alone, TOPOTOPO_NODE_CACHE_DIR moves the folder, TOPOTOPO_NODE_CACHE=off switches it off.
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
//   node src/cli.ts --catalog | --help-node scatter | --help-topic export | --help-example <name> | --version
//   node src/cli.ts mcp [--package dir] [--viewer]   the MCP server (src/mcp/server.ts) over stdio
//   node src/cli.ts view <graph.json> [--port 7341]      live 3D viewer in the browser, re-cooks on every save;
//                                                         guides and dropped files go to the package's inputs/
//   node src/cli.ts web [--port 7340] [--library dir]  the web app for the workspaces and libraries (src/packages/commands.ts)
//   node src/cli.ts open [<file.topo | file.topows | folder>]   open a package or workspace in the browser (what a
//                                                         double-click runs); starts the web app unseen when none runs;
//                                                         open --stop stops that web app
//   node src/cli.ts setup [--remove]                      Windows: file links so a double-click opens a package or
//                                                         workspace, a folder menu entry, the Start menu; --remove undoes it
//   node src/cli.ts library add|remove|list|new|bake …    registered libraries and packages; edit [folder] opens the
//                                                         live viewer on a package
// The workspace around packages (src/workspace.ts), a package and the packages it uses (src/packages/commands.ts,
// src/packages/registry.ts, src/packages/update.ts):
//   node src/cli.ts workspace [folder]
//   node src/cli.ts workspace init [folder] [--name n] [--engine godot:<path>|unreal:<path>|none] [--library <name or folder>] [--follow | --no-follow]
//   node src/cli.ts workspace library add|remove <name or folder> [--workspace <folder>]
//   node src/cli.ts workspace add|list [folder]
//   node src/cli.ts init [--example <name>] [folder] [--name owner/name]
//   node src/cli.ts use owner/name [owner/name ...] [folder] [--version 1.1]
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
// A package's published outputs cooked for an Unreal project, and the Unreal plugin (src/host/unreal.ts, integrations/unreal/PROTOCOL.md):
//   node src/cli.ts cook <.topo | package folder | folder>... --for unreal [--into </Game/folder>] [--flat] [--skip a,b] [--instancing packed|expand] [--force] [--no-cache] [--timeout <s>] [--report <file>] [--progress json] [--quiet]
//   node src/cli.ts unreal setup <unreal project folder or .uproject> [--no-enable] [--with-pcg]
//   node src/cli.ts unreal status <unreal project folder or .uproject> [--strict] [--json]
// Installed from npm the same commands are `topotopo …` (package.json bin → dist/cli.js, built by npm run build).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import './nodes/index.ts';
import { Engine, resolveTime } from './graph/engine.ts';
import type { CookReport, FrameRange } from './graph/engine.ts';
import { allNodeDefs } from './graph/registry.ts';
import { KINDS } from './graph/outputs.ts';
import { cacheBytesFromEnv, createNodeHost, limitsFromEnv } from './host/node.ts';
import { diskCacheLines, timingLines } from './graph/timing.ts';
import { renderGeometryAsync } from './render/raster.ts';
import { parseViews } from './render/raster.ts';
import type { RenderOptions } from './render/raster.ts';
import { renderArgs } from './render/options.ts';
import { encodePNG } from './render/png.ts';
import { EXPORT_FORMATS, exportFormatFromPath } from './io/export.ts';
import type { ExportFormat } from './io/export.ts';
import { exportSource } from './io/source.ts';
import { fittingFormats, outputKind } from './io/kinds.ts';
import { packagesUsed } from './graph/packages.ts';
import { PACKAGE_COMMANDS } from './packages/commands.ts';
import { GODOT_COMMANDS } from './host/godot-commands.ts';
import { UNREAL_COMMANDS } from './host/unreal-commands.ts';
import { setProgram, writeAtomic } from './package.ts';
import { refreshGraph, refreshNotes } from './graph/refresh.ts';
import { isGraph } from './graph/types.ts';
import type { GraphSpec } from './graph/types.ts';
import { openPackages } from './packages/registry.ts';
import { ArtifactStore } from './host/artifacts.ts';
import { checkExportFiles, checkTargetCollisions, ExportConflict, exportsFolderFor, filesShaFor, prepareTarget, serializeExport, unchangedTargetFiles, writeExportFiles, writeTargets } from './host/export-targets.ts';
import type { PreparedTarget } from './host/export-targets.ts';
import { TOPOTOPO_VERSION } from './host/version.ts';
import { engineSha256 } from './host/engine-code.ts';
import { exportOptionsFromFlags, prefixGone, publishedOutputs, resolveTarget } from './io/targets.ts';
import { budgetReport, inspect, nodeBudgetInput, summarize } from './inspect.ts';
import { glbSceneReport, sceneReportText } from './io/inspect-scene.ts';
import { uvReport } from './core/uvreport.ts';
import { didYouMean, norm } from './graph/params.ts';
import { parseVarArg, withVars } from './graph/vars.ts';
import { catalogText, nodeDoc, topicList, topicText } from './mcp/docs.ts';
import { exampleText, readExamples } from './mcp/examples.ts';

const argv = process.argv.slice(2);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
/** One output of a cook run: its own options (args) and those for every output (base: before the first --output). */
interface Unit { args: string[]; base: string[]; outputName?: string; target?: string }
/** An option's value for an output: its own before the one for every output. */
const uopt = (u: Unit, f: string) => { for (const l of [u.args, u.base]) { const i = l.indexOf(f); if (i >= 0) return l[i + 1]; } return undefined; };
const uhas = (u: Unit, f: string) => u.args.includes(f) || u.base.includes(f);
const fail = (msg: string): never => { console.error(msg); process.exit(1); };
// the time limits every engine of this process takes from the environment: a value that is not a number fails here
try { limitsFromEnv(); cacheBytesFromEnv(); } catch (e) { fail((e as Error).message); }
/** A graph file's name as a graph (view mode) and in receipts and default export file names. */
const graphName = (file: string) => path.basename(file).replace(/\.json$/i, '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]/, 'g$&') || 'graph';
// the command as the user typed it: the sources from a clone, or the package's bin (dist/cli.js)
const prog = import.meta.url.endsWith('.ts') ? 'node src/cli.ts' : 'topotopo';
// the hints of every command name it so
setProgram(prog);

function issueText(message: string, hint?: string, hintLabel = 'hint: '): string {
  const pkg = /^package (\S+): this graph is in no package, and only packages use packages$/.exec(message);
  return pkg ? `run ${prog} init <folder> first: only a package can use packages (this graph needs ${pkg[1]})`
    : `${message}${hint ? ` (${hintLabel}${hint})` : ''}`;
}

// the global version flag is the first argument (or the only one); later ones belong to the command (use <package> --version 1.0)
if (['-v', '-V', '--version'].includes(argv[0] ?? '')) {
  console.log(`topotopo ${TOPOTOPO_VERSION}`);
  process.exit(0);
}
if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log([
    'First job',
    `  ${prog} --help-topic examples    Find an example to start from.`,
    `  ${prog} init --example <name> parts    Make a package from it (or init parts for an empty one).`,
    `  ${prog} parts/graphs/main.json --render preview.png`,
    `  ${prog} parts/graphs/main.json --export part.glb`,
    `  ${prog} edit parts    Open the package in the editor.`,
    `  ${prog} mcp    Connect an AI client over stdio.`,
    '',
    `usage: ${prog} <graph.json> [--node n | --output name] [--var name=value]… [--frame N | --frames A-B[:step]] [--fps 24]`,
    '         [--render out.png] [--views quad|quad_uv|turntable|persp|front_left|front,top|persp,uv|persp,section] [--checker] [--color-by attr] [--export out.glb] [--export out.obj]',
    '         [--inspect summary|attributes|topology|all|uv|budget|scene] [--uv-resolution 1024] [--uv-attrib uv2] [--uv-per-piece] [--json]',
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
    '         [--export-all] (every published output into exports/ of its package folder, using the editor\'s first fitting format when there is no target.',
    '           One line per output says written, unchanged or failed. Exit 1 if any output fails. In a package, unchanged exports are kept.)',
    '         [--force] (--export-all: export every output, the unchanged ones too)',
    '         [--overwrite] (--export / --export-all: replace files that were changed or were not written by TopoTopo)',
    '         [--timing] (every cooked node with its time, slowest first, and the lib.run time of a script by node type; said without the flag for the slowest nodes of a cook that takes 1 s or more)',
    '         [--no-cache] (leave the disk cache alone: a node that cooked for 0.5 s or more is otherwise stored, compressed, up to 4 GB (the least recently used go first), and the next run that cooks it the same loads it; the report says which nodes were loaded.',
    '           Where: topotopo/nodes in the OS cache folder (Windows %LOCALAPPDATA%, macOS ~/Library/Caches, else $XDG_CACHE_HOME or ~/.cache); deleting that folder clears the cache. Environment, also for the MCP server: TOPOTOPO_NODE_CACHE_DIR=<folder> moves it, TOPOTOPO_NODE_CACHE=off switches the cache off.',
    '           A result is used when the node\'s signature (type, params, inputs), the engine\'s code and every file it was made from (the node\'s own and those of the nodes below it, side files and fonts too, by modification time and size: a tool that keeps both is not noticed) are as they were.',
    '           Never stored: a node that cooks a graph inside itself (foreach, graph_ref, assets, package outputs, solver; the nodes inside are), a result with an SDF volume, and anything made from a URL, a .blend converted by Blender, a node type a scope defines used inside another graph, a solver, or a script that runs nodes with lib.run)',
    '         time limits (environment, milliseconds; also for the MCP server and the viewer): TOPOTOPO_SCRIPT_TIMEOUT_MS (user code: expressions, wrangles, a whole script; default 30000), TOPOTOPO_SIM_TIMEOUT_MS (one cook of a simulation node; default 600000)',
    '         TOPOTOPO_EDITOR_IDLE_MS (how long an editor started with --json waits after its last tab closes; default 600000 ms)',
    '         memory for cooked results: TOPOTOPO_CACHE_MB (megabytes; default a quarter of the memory of the machine)',
    '         relative paths in the graph (file nodes, maps) read from its package folder: the nearest folder with a .topo file at or',
    '           above the graph file, else the graph file\'s folder; --render/--export/--underlay paths are relative to the current folder',
    '         [--follow owner/name] (use that package\'s working folder, where the package finds it, instead of its copy, for this run: renders, inspect and exports use it, unpublished (the export\'s source record lists it under "followed"); repeat it)',
    '         [--locked] (a build machine: a package the graph names that the package does not use, or a copy missing or edited by hand, fails the run instead of being added; exports use the published copies, whatever --follow shows)',
    '         render overlays: [--wireframe all|hard|boundary|groups] [--hard-angle 30] [--section y:0.5] [--clip x:0.5[:abs]]',
    '                          [--glyphs N|up|orient|v|comb] [--glyph-attrib a] [--labels groups,pieces,points,prims,attrib:name] [--legend] [--points]',
    '                          [--shading flat|matcap|zebra|ao|pbr] [--exposure 0] [--size 800|1600x600] (whole PNG including footer) [--render-scale 2]',
    '                          Zebra reflects black and white stripes to show how smoothly surfaces flow.',
    '                          [--cd auto|ignore|multiply] (shading pbr: auto = a named material wins over Cd, Cd colours prims without one; multiply = Cd tints the material too)',
    '                          [--grey] works with pbr (neutral 18% grey, retaining roughness, metallic and normal maps) and matcap (uniform clay). It implies pbr if shading is omitted.',
    '                          views: persp front back left right top bottom front_left front_right back_left back_right uv sheet section texture persp@<az>',
    '                          framing: every 3D view fits the bounds; [--zoom 1] is relative to that fit (above 1 only with --look-at or --ortho-scale)',
    '                          [--azimuth 35] (degrees around +Y: 0 = camera on +Z at the front, 90 = on +X, the right side) [--elevation 25] (degrees above the horizon)',
    '                          [--look-at x,y,z] (world metres, Y up, +Z front) [--ortho-scale 0.5] (metres across an ortho view)',
    '                          Coordinates accept commas, spaces or both, for example --from "6 1.7 9" --to 0,2,0.',
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
    '         Repeat --export to write several files per output. Each file uses its own extension unless --format applies.',
    '           Export options before the first --export apply to every export. Options after an --export apply to that file up to the next --export.',
    '         export options (every option of the export tool; booleans as --name / --no-name):',
    '                         [--compress none|meshopt|draco] [--quantize] [--tangents auto|preserve|none] [--pcg | --pcg-struct] [--attributes P,N,pscale] [--up-axis y|z] [--scale 100]',
    '                         [--maps embed|external|none] (glb/gltf texture maps: inside the file (default), once each in a shared maps/ folder referenced by URI (--export-all: exports/maps/), or none: material names and factors only)',
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
    `       ${prog} --catalog | --help-node <type or alias> | --help-topic <name> | --help-example <name> | --version   (in a package: the outputs of the packages it uses too, --help-node owner/name/output; --help-topic examples lists the examples)`,
    `       ${prog} mcp [--package dir] [--viewer]   (the MCP server over stdio, for MCP clients)`,
    `       ${prog} view <graph.json> [--port 7341] [--follow owner/name]   (live 3D viewer in the browser; re-cooks when the file is saved; guides and files dropped on the page go to the package's inputs/, beside the file in no package)`,
    `       ${prog} refresh <graph.json> <generated.json | ->   (a regenerated graph written over graph.json keeping what a person tuned: changed var values that still fit, control labels and steps, node ui, meta; - reads stdin)`,
    `       ${prog} web [--port 7340] [--library <folder>] [--no-bake]   (the web app: the registered workspaces and every library's packages, stable links for a board)`,
    `       ${prog} open [<file.topo | file.topows | folder>]   (open a package or workspace in the browser, starting the web app unseen when none runs: what double-clicking the file runs; no path: the home page; open --stop stops that web app; $TOPOTOPO_HOME names the TopoTopo folder, $TOPOTOPO_BROWSER_LOG a file to write the address to instead of opening a browser)`,
    `       ${prog} setup [--remove]   (Windows: after this, double-clicking a .topo package or .topows workspace opens it in TopoTopo with its icon, folders get "Open in TopoTopo" in the right-click menu and TopoTopo is in the Start menu; per user, no administrator rights; setup --remove puts the registry and the Start menu back as they were; $TOPOTOPO_HOME names the TopoTopo folder, which holds the record setup undoes from)`,
    `       ${prog} library add <name> <folder> | remove <name> | list | new <library or workspace> <folder/name> [--title t] [--tags a,b] | bake <package>|--stale|--all   (registered libraries)`,
    `       ${prog} edit [folder] [--port 7341]   (the live viewer on a package, default the current folder's)`,
    '       a package and the packages it uses (a folder named must exist; default: the current folder\'s package; kinds: ' + KINDS.join(', ') + '; --help-topic packages):',
    ...PACKAGE_COMMANDS.map((c) => `       ${prog} ${c.usage}   (${c.usage === 'check [folder]'
      ? 'cook the published outputs of the working graphs, the newest published versions and the versions in listed libraries. Exit 1 on a broken output, changing nothing but missing .gdignore files inside a Godot project' : c.what})`),
    '       Godot (exit 0 ok, 1 an output or package failed, 2 usage or setup; --help-topic godot):',
    ...GODOT_COMMANDS.map((c) => `       ${prog} ${c.usage}   (${c.what})`),
    '       Unreal (the same exit codes; --help-topic unreal):',
    ...UNREAL_COMMANDS.map((c) => `       ${prog} ${c.usage}   (${c.what})`),
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
if (argv.includes('--help-example')) {
  // an example's card and graph (src/mcp/examples.ts), the same text help {examples:[name]} returns
  const name = opt('--help-example');
  if (name === undefined || name.startsWith('-')) fail(`--help-example needs an example: ${readExamples().map((e) => e.name).join(', ')}`);
  const text = exampleText(name!);
  if (text.startsWith('unknown example')) fail(text);
  console.log(text);
  console.log(`
To start a package from it: ${prog} init --example ${name} <folder>`);
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
    const resolved = engine.resolveDef(name);
    const d = resolved ?? (name.includes('/') ? pk.describe(name) : null);
    // a package output this folder cannot cook as it is (one of TopoTopo's own it does not use, a folder in no package)
    const why = name.includes('/') && !resolved ? engine.packageIssue(name) : null;
    const said = why ? issueText(why.error, why.hint, '') : '';
    const alias = d?.aliases?.some((n) => norm(n) === norm(name)) && norm(d.type) !== norm(name) ? `${name} is another name for ${d.type}\n` : '';
    console.log(d ? `${alias}${nodeDoc(d)}${said ? `\nin this folder: ${said}` : ''}` : said || `unknown node "${name}" (see --catalog)`);
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
    try { g = JSON.parse(fs.readFileSync(f === '-' ? 0 : f, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return fail(`${prog} refresh: ${what} ${f === '-' ? '(stdin)' : `"${f}"`}: ${(e as Error).message}`); }
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
} else if (argv[0] === 'open') {
  // `topotopo open [<file|folder>]`: a package or workspace in the browser, through the web app of this user (src/host/open.ts)
  const { openCommand } = await import('./host/open.ts');
  const { consoleIo } = await import('./packages/commands.ts');
  process.exit(await openCommand(argv.slice(1), prog, consoleIo));
} else if (argv[0] === 'setup') {
  // `topotopo setup [--remove]`: the Windows file links, folder menu entry and Start menu entry (src/host/setup.ts)
  const { setupCommand } = await import('./host/setup.ts');
  const { consoleIo } = await import('./packages/commands.ts');
  process.exit(await setupCommand(argv.slice(1), prog, consoleIo));
} else if (['web', 'library', 'edit', 'workspace', 'init', 'libraries', 'use', 'remove', 'packages', 'publish', 'search', 'outdated', 'check', 'update'].includes(argv[0])) {
  // the web app, its libraries and its editor; a package and the packages it uses (src/packages/commands.ts). A command that ends
  // gives its exit code; the web app and the editor keep running
  const { commands } = await import('./packages/commands.ts');
  const code = await commands[argv[0]](argv.slice(1), prog);
  if (typeof code === 'number') process.exit(code);
} else if (argv[0] === 'cook' || argv[0] === 'godot' || argv[0] === 'unreal') {
  // a package's published outputs cooked into an engine project, and the engine plugins' setup and status
  // (src/host/cook-command.ts, godot.ts, unreal.ts, cook.ts): exit 0, 1 (an output or package failed), 2 (usage, setup or protocol)
  const { cookCommand } = await import('./host/cook-command.ts');
  const { godotCommand } = await import('./host/godot.ts');
  const { unrealCommand } = await import('./host/unreal.ts');
  const { consoleIo } = await import('./packages/commands.ts');
  process.exit(await (argv[0] === 'cook' ? cookCommand : argv[0] === 'godot' ? godotCommand : unrealCommand)(argv.slice(1), consoleIo));
} else if (argv[0] === 'mcp') {
  // `topotopo mcp [--package dir] [--viewer]`: the MCP server over stdio; src/mcp/server.ts reads the remaining
  // arguments from process.argv and runs until the client closes stdin
  process.argv.splice(2, 1);
  await import('./mcp/server.ts');
} else {
  try { await cook(); }
  catch (e) { if (e instanceof ExportConflict) fail(e.message); throw e; }
}

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
  try { graph = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
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
    if (argv.includes('--export-all')) fail('--export-all already exports every published output: leave out --output, or give each --output its own --export');
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
  const engine = new Engine(createNodeHost({ baseDir: path.dirname(path.resolve(file)), nodeCache: !argv.includes('--no-cache') }));
  await engine.init();
  // the packages the file's package uses: one the graph names for the first time is added (said), and
  // --follow uses a package's working folder for this run. A graph that does not validate as a dry run sees it adds
  // nothing: its errors are said and the run ends. --locked (a build machine) adds nothing and changes no file: a
  // package it does not use, or a copy missing or edited by hand, fails the run instead.
  let pk: ReturnType<typeof openPackages>;
  try { pk = openPackages(engine, path.dirname(path.resolve(file)), { follow: followArgs }); } catch (e) { fail(`--follow: ${(e as Error).message}`); }
  const dry = pk!.dryRun(graph);
  const invalid = engine.validate(graph, '', { ...engine.root, id: dry.id, packages: dry.resolver }).errors;
  if (invalid.length) {
    const errors = invalid.map((e) => `[${e.node}] ${issueText(e.message, e.hint)}`);
    if (argv.includes('--export-all') && isGraph(graph)) return failedExports(errors.join(' · '));
    fail(errors.map((e) => `error ${e}`).join('\n'));
  }
  if (argv.includes('--locked')) {
    const unlocked = pk!.locked(graph);
    if (unlocked.length) {
      if (argv.includes('--export-all')) return failedExports(`--locked: ${unlocked.join(' · ')}`);
      fail(unlocked.map((x) => `--locked: ${x}`).join('\n'));
    }
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
    const geo = r.geo!, json = uhas(u, '--json'), perPiece = uhas(u, '--uv-per-piece'), uvAttrib = uopt(u, '--uv-attrib');
    if (inspectDetail === 'scene') {
      // the glb export with the export options given, read back
      const res = await serializeExport(geo, 'glb', 'scene.glb', exportArgs(u), engine.host);
      const glb = res.files.find((f) => /\.glb$/i.test(f.path));
      if (!glb) return 'scene: the glb export wrote no file';
      const rep = glbSceneReport(glb.bytes);
      const warn = res.warnings.map((w) => `warning: ${w}`);
      return json ? JSON.stringify(rep, null, 2) : [...sceneReportText(rep), ...warn].join('\n');
    }
    if (inspectDetail === 'uv' && json) return JSON.stringify(uvReport(geo, { resolution: uvRes, perPiece, attribute: uvAttrib }), null, 2);
    if (inspectDetail === 'budget' && json) return JSON.stringify(budgetReport(geo, nodeBudgetInput(graph, r.results)), null, 2);
    return inspect(geo, { detail: inspectDetail as any, uvResolution: uvRes, uvPerPiece: perPiece, uvAttrib, nodes: inspectDetail === 'budget' ? nodeBudgetInput(graph, r.results) : undefined });
  }

  function report(r: CookReport) {
    for (const e of r.errors) console.error(`error [${e.node}] ${issueText(e.message, e.hint)}`);
    for (const w of r.warnings) console.error(`warning [${w.node}] ${w.message}`);
  }
  /** Where the cook's time went: with --timing every cooked node, else the slowest when the cook took a second or more. */
  const timingFlag = argv.includes('--timing');
  function timing(r: CookReport) {
    if (!timingFlag && r.ms < 1000) { for (const l of diskCacheLines(r)) console.log(l); return; }
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
    try { return renderArgs(a, { canvasSize: true }); } catch (e: any) { return fail(e.message); }
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
      const from = (args: string[], f: string) => {
        const i = args.indexOf(f);
        if (i < 0) return undefined;
        if (!['--from', '--to', '--look-at', '--bounds'].includes(f)) return args[i + 1];
        let end = i + 1;
        while (end < args.length && !args[end].startsWith('--')) end++;
        return args.slice(i + 1, end).join(' ');
      };
      return { out: seg[1], get: (f: string) => from(seg, f) ?? from(sharedArgs, f) ?? from(u.base, f), has: (f: string) => seg.includes(f) || sharedArgs.includes(f) || u.base.includes(f) };
    });
  }
  const rendersByUnit = new Map(units.map((u) => [u, rendersOf(u)]));

  // Each --export takes its own options over those before the first --export and the shared output options.
  function exportsOf(u: Unit) {
    const starts = u.args.flatMap((arg, i) => arg === '--export' ? [i] : []);
    const shared = starts.length > 1 ? u.args.slice(0, starts[0]) : [];
    return starts.map((start, i) => {
      const args = starts.length === 1 ? u.args : u.args.slice(start, starts[i + 1]);
      const format = uopt({ args, base: shared }, '--format') ?? uopt({ args: u.base, base: [] }, '--format');
      return { out: u.args[start + 1], format, args, shared };
    });
  }
  const exportsByUnit = new Map(units.map((u) => [u, exportsOf(u)]));

  const exportsDir = exportsFolderFor(file);
  const exportWrite = { packageDir: path.dirname(exportsDir), hint: 'pass --overwrite to replace it, or export to another path' };

  async function prepareExports(r: CookReport, u: Unit, frame?: number) {
    const prepared: { fmt: ExportFormat; res: Awaited<ReturnType<typeof serializeExport>> }[] = [];
    for (const { out, format, args, shared } of exportsByUnit.get(u)!) {
      if (!out || out.startsWith('--')) fail('--export needs an output path (e.g. --export out.glb)');
      const p = frame === undefined ? out : framePath(out, frame);
      const raw = (format ?? exportFormatFromPath(out)).toLowerCase();
      const fmt = (({ png: 'png16', raw: 'r16' } as Record<string, string>)[raw] ?? raw) as ExportFormat;
      if (!EXPORT_FORMATS.includes(fmt)) fail(`unknown export format "${fmt}" (${EXPORT_FORMATS.join(', ')}); pass --format`);
      const a = exportArgs({ args, base: u.base }, shared);
      const x = await forExport(r);
      const source = exportSource({ graph: graphName(file), spec: graph, node: r.target, output: u.outputName, frame: r.frame, fps: r.fps, format: fmt, options: a, packages: packagesUsed(engine, graph, exportScope ?? engine.root), files: filesShaFor(file), version: TOPOTOPO_VERSION, engine: engineSha256() });
      prepared.push({ fmt, res: await serializeExport(x.geo!, fmt, p, a, engine.host, source) });
    }
    return prepared;
  }

  async function writeOutputs(r: CookReport, u: Unit, frame?: number, prepared?: Awaited<ReturnType<typeof prepareExports>>) {
    const geo = r.geo!;
    const at = (p: string) => (frame === undefined ? p : framePath(p, frame));
    const exports = prepared ?? await prepareExports(r, u, frame);
    const options = { ...exportWrite, overwrite: uhas(u, '--overwrite') };
    const renders = rendersByUnit.get(u)!;
    if (exports.length > 1 || (exports.length && renders.length)) checkExportFiles(exports.map((ex) => ex.res), options);
    // Receipts for the viewer's saved files, only for files inside the package's exports/ (exportsFolderFor): a run whose
    // output goes elsewhere leaves no exports/ folder behind (the viewer lists that folder's files without receipts too).
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
      const title = path.basename(file, '.json') + (multi ? ` · ${u.outputName}` : '') + (r.frame !== 1 ? ` @ frame ${r.frame}` : '');
      const img = await renderGeometryAsync(geo, { ...ro, views, colorBy: get('--color-by') ?? null, checker: has('--checker'), title }, (t) => engine.host.readFile(t))
        .catch((e: Error) => fail(e.message));
      const p = at(out);
      fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
      fs.writeFileSync(p, encodePNG(img.rgba, img.width, img.height, (d) => zlib.deflateSync(d)));
      record([p], 'png');
      console.log(`rendered ${p} (${img.width}x${img.height})${img.notes.length ? ' — ' + img.notes.join('; ') : ''}`);
    }
    const summaries: string[] = [];
    for (const { fmt, res } of exports) {
      for (const w of res.warnings) console.warn(`warning: ${w}`);
      writeExportFiles(res, options);
      if (res.files.length) record(res.files.map((f) => f.path), fmt);
      const files = res.files.filter((f) => f.path !== res.sourceManifest);
      summaries.push(`exported ${files.length === 1 ? files[0].path : files.map((f) => f.path).join(', ')}${files.length > 1 || fmt !== 'glb' ? ` — ${res.summary}` : ''}${res.sourceFile ? `; source: ${res.sourceFile}` : ''}`);
    }
    if (summaries.length) {
      console.log(summaries.join(' | '));
      if (exportNote) console.log(exportNote);
    }
  }

  /**
   * The export flags given for an output, as the export tool's options (snake_case, as export targets and the MCP
   * export tool name them): its own over those for every output.
   */
  function exportArgs(u: Unit, shared: string[] = []): Record<string, unknown> {
    // every option of the export tool has a flag: --name value, booleans --name / --no-name (io/targets.ts)
    try { return { ...exportOptionsFromFlags(u.base), ...exportOptionsFromFlags(shared), ...exportOptionsFromFlags(u.args) }; } catch (e) { return fail(`export: ${(e as Error).message}`); }
  }

  if (framesArg) {
    const range = parseFrames(framesArg), unit = units[0];
    // A later frame can add files of its own. Check the serialized files of every frame before writing the first.
    const preflight = exportsByUnit.get(unit)!.length > 0 && !uhas(unit, '--overwrite');
    const pending: { report: CookReport; frame: number; prepared: Awaited<ReturnType<typeof prepareExports>> }[] = [];
    const res = await engine.cookFrames(graph, range, async (r, f) => {
      report(r);
      if (!r.ok || !r.geo) return;
      const cooked = [...r.results.values()].filter((n) => !n.cached && !n.error).length;
      console.log(`frame ${f}: ${r.target} in ${r.ms.toFixed(0)} ms (${cooked} node(s) cooked) — ${r.geo.numPoints} points, ${r.geo.numPrims} prims`);
      if (inspectOf(units[0])) console.log(await inspectText(r, units[0]));
      if (preflight) pending.push({ report: r, frame: f, prepared: await prepareExports(r, unit, f) });
      else await writeOutputs(r, unit, f);
    }, { target: units[0].target, fps });
    checkExportFiles(pending.flatMap((p) => p.prepared.map((ex) => ex.res)), exportWrite);
    for (const p of pending) await writeOutputs(p.report, unit, p.frame, p.prepared);
    console.log(`cooked ${file} frames ${range.start}-${range.end}${range.step !== 1 ? `:${range.step}` : ''}: ${res.frames - res.failed.length}/${res.frames} ok`);
    if (res.failed.length) fail(`failed frames: ${res.failed.join(', ')}`);
  } else {
    const failed: string[] = [], t0 = performance.now();
    // --export-all alone cooks the outputs it exports, not the default output first
    const onlyExportAll = argv.includes('--export-all') && !['--output', '--node', '--export', '--render', '--inspect'].some((f) => argv.includes(f));
    for (const u of onlyExportAll ? [] : units) {
      const r = await engine.cook(graph, { target: u.target, frame: single, fps });
      report(r);
      if (!r.ok || !r.geo) {
        timing(r);
        if (!multi && !argv.includes('--export-all')) process.exit(1);
        if (multi) console.error(`output "${u.outputName}" did not cook: nothing was written for it`);
        failed.push(u.outputName ?? r.target);
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

  function outputsForExport() {
    const spec: GraphSpec = graph;
    const outputs = Object.fromEntries(Object.entries(spec.outputs ?? {}).filter(([, o]) => o && o.publish !== false));
    return publishedOutputs(graphName(file), { ...spec, outputs }, engine.findOutput(spec).name).map((p) => ({ ...p, spec }));
  }

  type ExportLine = { label: string; status: 'written' | 'unchanged' | 'FAILED'; detail: string };
  function showExports(lines: ExportLine[]) {
    const counts = { written: 0, unchanged: 0, FAILED: 0 };
    for (const [i, { label, status, detail }] of lines.entries()) {
      console.log(`[${i + 1}/${lines.length}] ${JSON.stringify(label)} ${status}: ${detail.replace(/\r?\n/g, ' · ')}`);
      counts[status]++;
    }
    console.log(`--export-all: ${counts.written} written, ${counts.unchanged} unchanged, ${counts.FAILED} failed`);
    if (counts.FAILED) process.exitCode = 1;
  }

  async function failedExports(detail: string) {
    showExports(outputsForExport().map(({ label }) => ({ label, status: 'FAILED', detail })));
    await engine.host.pool?.close();
  }

  /** Cook each published output with one engine, then write the exports that could be prepared. */
  async function exportAll() {
    const name = graphName(file), exportsDir = exportsFolderFor(file);
    const blocked = exportScope ? exportBlocked() : null;
    if (blocked) return failedExports(blocked);
    const rel = (f: string) => path.relative(process.cwd(), f) || f;
    const time = resolveTime({ frame: single, fps });
    const cook = { frame: time.frame, fps: time.fps, packages: packagesUsed(engine, graph, exportScope ?? engine.root), files: filesShaFor(file) };
    const force = argv.includes('--force');
    const options = { ...exportWrite, overwrite: argv.includes('--overwrite') };
    const lines: ExportLine[] = [];
    const pending: { output: PreparedTarget; line: ExportLine }[] = [];
    const kept: NonNullable<ReturnType<typeof unchangedTargetFiles>>[] = [];
    for (const p of outputsForExport()) {
      const line: ExportLine = { label: p.label, status: 'FAILED', detail: '' };
      lines.push(line);
      const t = performance.now();
      try {
        if (p.target?.refused) throw new Error(prefixGone(p.target.refused));
        const keep = (target: NonNullable<typeof p.target>, fallback = '') => {
          const last = !force && unchangedTargetFiles(name, { ...p, target }, exportsDir, cook);
          if (!last) return false;
          kept.push(last);
          line.status = 'unchanged';
          line.detail = `${rel(path.join(exportsDir, target.path))} kept${fallback}`;
          return true;
        };
        if (p.target && keep(p.target)) continue;
        const r = await engine.cook(graph, { target: p.node, frame: single, fps, scope: exportScope ?? engine.root });
        if (!r.ok || !r.geo) {
          const reason = r.errors.map((e) => `[${e.node}] ${issueText(e.message, e.hint)}`).join(' · ') || 'it produced no geometry';
          throw new Error(`did not cook${exportScope ? ' with the published copies' : ''}: ${reason}`);
        }
        const info = outputKind(r.geo);
        const format = p.target ? undefined : fittingFormats(info)[0]?.format;
        const fallback = format ? ` (default format: ${format})` : '';
        const target = p.target ?? (format ? resolveTarget(format, p.output ?? name) : null);
        if (!target) throw new Error('no export target: add "export": {"format": ..., "path": ...} to the output');
        if (format && keep(target, fallback)) continue;
        const output = await prepareTarget(r.geo, name, { ...p, target }, exportsDir, engine.host, cook);
        const dest = rel(path.join(exportsDir, target.path));
        const warnings = [...new Set([...r.warnings.map((w) => `[${w.node}] ${w.message}`), ...output.warnings])];
        line.detail = `${dest}${fallback} — ${info.published ?? 'empty'}, ${output.summary}, ${((performance.now() - t) / 1000).toFixed(1)} s`
          + `${output.sourceFile ? ` · source: ${rel(output.sourceFile)}` : ''}${warnings.length ? ` · warning: ${warnings.join(' · ')}` : ''}`;
        pending.push({ output, line });
      } catch (e) { line.detail = (e as Error).message; }
    }
    try {
      checkTargetCollisions([...kept, ...pending.map((p) => p.output)]);
      for (const { output, line } of pending) {
        try { writeTargets([output], exportsDir, options); line.status = 'written'; }
        catch (e) { line.detail = (e as Error).message; }
      }
    } catch (e) { for (const { line } of pending) line.detail = (e as Error).message; }
    if (exportNote) console.log(exportNote);
    showExports(lines);
  }
  // stop the kernel worker threads (idle ones would not hold the process, but a clean exit should not wait on them)
  await engine.host.pool?.close();
}
