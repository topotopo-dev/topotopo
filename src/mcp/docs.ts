// LLM-facing documentation: operating guide, topic pages, and generated node references.
import type { GraphSpec, NodeDef, ParamDef } from '../graph/types.ts';
import { CATEGORY_ORDER } from '../graph/registry.ts';
import { PACKAGE_COMMANDS } from '../packages/commands.ts';

export const INSTRUCTIONS = `TopoTopo: a procedural geometry engine (Houdini-SOP style) you drive with JSON node graphs.

WORKFLOW
0. inputs {action:"list"} → the person's own files in the project inputs/ folder (guide curves, sites, zones, blockouts, PNG masks). Building a landscape or scene: look there first and build on them (help topic "inputs").
1. catalog → see node types (100+, Houdini names work as aliases: copytopoints, attribwrangle, polyextrude, mountain…) and TopoTopo's own packages, ready-made generators by full name (topotopo/architecture/house, topotopo/nature/tree_lowpoly, topotopo/street/road_strip …).
2. help {nodes:[...]} for exact params before using unfamiliar nodes; help {topic:"wrangle"|"graph"|"recipes"…} for concepts.
3. build {graph} the WHOLE network in one call (dry_run:true validates without cooking). Every response reports errors per node with did-you-mean hints.
4. render to SEE it (quad view: persp/front/right/top; backfaces are tinted blue = flipped normals; views "quad_uv" + checker:true for UVs; overlays for specific questions: wireframe "hard"/"boundary", views "section", glyphs "N", label_groups, shading "matcap", see help topic "render"). inspect for numbers (bbox, attributes, watertightness).
5. edit {ops} for incremental changes (set params, insert nodes, rewire) — only downstream nodes re-cook.
6. export to glb/gltf (materials, textures, meshopt), geo (Houdini), csv (Unreal PCG points / instance rows), points.json, usda, obj/ply/stl/json for Unreal, Blender, Houdini; unreal_landscape = a whole terrain scene for Unreal. Every export records its source (graph, vars, seeds, frame, version) so it can be made again (help topic "export").
7. verify: assert nodes guard invariants in the graph (watertight, counts, bbox, expr); explain {graph} reads a result in words; diff {a, b} shows what an edit changed. See help topic "verify".
OUTPUTS: publish intended deliverables in graph.outputs: {"rotor":{"node":"rotor_final","label":"Rotor"}}. The default graph.output stays unchanged. The viewer lists every graph and named result, its generated textures and image layers; clicking a result isolates it. Each card says what the result is (mesh, instances, points, curves, terrain, textures, material, volume or scene; its size) and offers the formats that write it: Download (the export as a file, or a zip with its sidecars) and Export (its target in exports/). Rendered images and exports are saved and visible too. Use descriptive names; keep intermediate work in the node outliner. Rename/remove edits maintain published references. In a project that is a package, give each output "tags" (["conifer", "low-poly"]: search finds outputs by them) and a "description" (else its graph's is recorded); "kind" (mesh, instances, points, curves, terrain, textures, material, volume, scene; a mesh with scene_null sockets is a mesh; materials alone are a material) pins what it must cook to: build warns and publishing blocks when it does not.
INSTANCING: copy_to_points {pack:true} / pack make packed instances (millions stay cheap; glb, usda and geo export them as instances, csv/points.json as one row per instance). See help topic "instancing".
PCG: mask → scatter {density_mask} → orient → prune → copy_to_points {pack, variants, variant_weights}; points_along_curve, cluster, attribute_from_map. See help topic "pcg".
CURVES: bezier / nurbs make spline prims (CVs + order, exact everywhere); convert_curve, resample, fillet_curve, offset_curve_3d, project_curve (roads on terrain), spline_fit, curve_attribs (curveu, frames, ramps). See help topic "curves".
CLOTH: drape {steps} simulates a mesh as cloth over a collider (input 1) and the floor, from pins (pin_group / input 2) and in wind; inflate {pressure} puffs a closed mesh into a cushion or balloon. See help topic "cloth".

CONVENTIONS: Y-up, metres, angles in degrees (wrangle trig uses radians). Houdini attribute names (P N Cd uv pscale orient up scale width name class piece). Polygons are closed prims, polylines are open prims.
GRAPH: {"nodes": {"name": {"type": "...", "in": ["upstream", ...], "params": {...}}}, "output": "name", "vars": {"k": 1}}. Params accept "=expr" using vars by their bare name (e.g. "=height*0.5"), time (frame, time) and other nodes (npoints('pts'), bbox('base').size.y, ch('box1/size')). Code (wrangle, script, sdf_expr, heightfield_layer, parametric, group and assert expressions) reads vars the same way: height, not vars.height.
HUMANS TUNE VARS: declare "params" for the 3–8 vars a person would tune ({"k": {type, desc, min, max, options, label, step}}); the live viewer (preview) shows them as sliders and menus. People change vars at any time, so read the graph (graphs {action:"get"}) before assuming a var's value. See help topic "graph".
TIME: build/edit/render/inspect/export take "frame" (default 1). solver = per-frame feedback (growth, accumulation). See help topic "time".
PARTICLES: particles(emitter points, collision mesh, field) = Houdini POPs in one node: emission, gravity/drag/wind, curl noise, fields, floor and mesh collisions, trails as polylines; steps with the frame. See help topic "particles".
ESCAPE HATCHES: wrangle (per-element JS with @P/@Cd syntax), script (whole-geometry JS with the engine library), sdf_expr (signed distance functions). If a node is missing, write it with these.
TERRAIN: heightfield → heightfield_noise → heightfield_erode → masks / heightfield_path → heightfield_scatter + copy_to_points, heightfield_to_mesh; heightfield_crop works on one tile of a big map; export png16 for an Unreal Landscape, or unreal_landscape for the landscape + layers + instances bundle. See help topic "heightfield".
PHYSICS: rbd_settle drops pieces (packed instances) onto a terrain/container/ground until they rest, so scattered rocks and props sit in contact; rbd_stack drops them one at a time into piles. See help topic "rbd".
LIBRARIES: the person's projects live in libraries the TopoTopo Gallery website shows (their board links to them). library {action:"list"} finds one, {action:"open"} makes it the folder every tool works in, {action:"create"} starts one. See help topic "library".
PACKAGES: a project uses the published outputs of other projects as node types, {"type": "owner/name/output"} (help {nodes:[...]} gives their params and version); a build that names one adds it to the project once the graph validates. TopoTopo's own packages are four kits built into TopoTopo, used the same way: topotopo/architecture (walls, windows, doors, houses, roofs, stairs, railings, floors), topotopo/nature (rocks, cliffs, trees, bushes, logs, forests, grass), topotopo/props (barrels, crates, pallets, sandbags, pipes) and topotopo/street (roads, lamp posts, bollards, benches, signs, fences, cables), e.g. {"type": "topotopo/nature/rock", "params": {"size": 2}}. Only a project's graphs use packages: the server makes its project one when it starts if the folder holds nothing but a project's own folders (its first reply says so), and library {action:"init"} makes any other open project one when the person says so. library {action:"packages"} lists them, {action:"search", query?, kind?, tag?} finds outputs in every library ("a conifer", every terrain) and says whether the project can use each, {action:"set", libraries:[...]} lists a library the person names, {action:"publish", dry_run:true} says what publishing would do (show it to the person; publish {note} only when they say so), {action:"outdated"} lists newer versions, {action:"update", package} shows the before/after of an update, which you apply (from, to, apply:true) only when the person says so. See help topic "packages".`;

/**
 * The complete example of help topic "inputs": guides.glb's path.* curves cut roads into a heightfield and its zone.*
 * areas mask a tree scatter; the vars a person tunes are exposed as params. test/mcp.ts cooks it on a real guides.glb.
 */
export const INPUTS_EXAMPLE: GraphSpec = {
  nodes: {
    guides: { type: 'file', params: { path: 'inputs/guides.glb' } },
    roles: { type: 'wrangle', in: ['guides'], params: { run_over: 'prims', code: "s@role = s@role || @name.split('.')[0].toLowerCase();" } },
    paths: { type: 'delete', in: ['roles'], params: { group: '@role=path', keep: true } },
    zones: { type: 'delete', in: ['roles'], params: { group: '@role=zone', keep: true } },
    areas: { type: 'ends', in: ['zones'], params: { mode: 'close' } },
    ground: { type: 'heightfield', params: { size: '=extent', resolution: 1 } },
    hills: { type: 'heightfield_noise', in: ['ground'], params: { amplitude: '=relief', element_size: 60 } },
    road: { type: 'heightfield_path', in: ['hills', 'paths'], params: { width: '=road_width' } },
    zone_mask: { type: 'heightfield_mask_by_object', in: ['road', 'areas'], params: { by: 'footprint', distance: 0, falloff: 3 } },
    off_road: { type: 'heightfield_layer', in: ['zone_mask'], params: { layer: 'mask', expression: 'mask * (1 - path)' } },
    spots: { type: 'heightfield_scatter', in: ['off_road'], params: { density: '=tree_density', align: 'upright', seed: 3 } },
    tree: { type: 'topotopo/nature/tree_lowpoly', params: { height: 7 } },
    trees: { type: 'copy_to_points', in: ['tree', 'spots'], params: { pack: true } },
    land: { type: 'heightfield_to_mesh', in: ['off_road'], params: { color: 'terrain' } },
    out: { type: 'merge', in: ['land', 'trees'] },
  },
  output: 'out',
  vars: { extent: 200, relief: 6, road_width: 5, tree_density: 0.02 },
  params: {
    relief: { type: 'float', min: 0, max: 30, step: 0.5, label: 'Hill height (m)', desc: 'terrain relief in metres' },
    road_width: { type: 'float', min: 2, max: 12, label: 'Road width (m)', desc: 'flat width of the roads drawn as path.*' },
    tree_density: { type: 'float', min: 0, max: 0.1, step: 0.005, label: 'Trees per m²', desc: 'tree density inside the zone.* areas' },
  },
};

/** A graph as JSON with one node (and one param) per line: readable in a topic page, and JSON.parse gives it back. */
export function graphLines(g: GraphSpec): string {
  const rows = (o: Record<string, any>) => Object.entries(o).map(([k, v]) => `   ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  const parts = Object.entries(g).map(([k, v]) =>
    (k === 'nodes' || k === 'params') && v && typeof v === 'object' ? `${JSON.stringify(k)}: {\n${rows(v)}\n }` : `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{${parts.join(',\n ')}}`;
}

export const TOPICS: Record<string, string> = {
  library: `LIBRARIES AND THE GALLERY
A library is a folder the person listed (\`topotopo library add <name> <folder>\`, kept in ~/.topotopo/config.json). A
project is any folder in it holding project.json, with the folders TopoTopo works with:
  props/lantern/project.json    {id, title, description, tags, graph:"main", bake:{graph?, node?, frame?}, links:[{label, url}]}
  props/lantern/graphs/ assets/ inputs/ exports/  as in any project
  props/lantern/attachments/    concept art, references, source files (shown on the project's gallery page)
  props/lantern/.gallery/       thumb.png, preview.glb, bake.json: derived, never edit
The parent folders ("props") are the project's collection. The gallery (\`topotopo gallery\`, http://127.0.0.1:7340)
shows every library as a grid; each project has a page (/p/<library>/<id>), a thumbnail (…/thumb.png) and an
iframe embed (/embed/<library>/<id>) that the person's board pastes; a package's page lists its versions and outputs
with their kinds and tags (the grid's search finds outputs by name, kind and tag), a project's the packages it uses.
It bakes the previews by itself after graphs, assets or inputs change, from the
graph named in "graph" (or "bake": another graph, a node, a frame).

WORKING IN A PROJECT
- library {action:"list", query?, tag?} → find it; library {action:"get", library, id, thumbnail:true} → what it holds.
- library {action:"open", library, id} → every tool (build, edit, render, export, inputs, assets, preview) now works
  in that folder. Build the project's model into graph "main" (or the manifest's "graph").
- library {action:"create", library, path:"props/barrel", title, tags, links} → a new project, opened.
- library {action:"init"} → the server's folder becomes a project where it is none (project.json in its folder), when
  the person wants its graphs to use packages. When the server starts it makes its folder, named or not, a project
  if the folder is in no project and holds nothing but what TopoTopo makes itself (graphs/, assets/, exports/,
  inputs/), or nothing at all; a folder with anything else in it (a repository, the person's own files) stays as it is
  until the person says so.
- library {action:"set", tags, links, description, bake:{frame: 48}} → edit project.json (bake.frame for
  simulations that settle after frame 1; bake.node to show one part).
- library {action:"bake"} → render the previews now and see the thumbnail.
Put reference images the person gives you in attachments/, guide files in inputs/. Links in "links" point back to the
board or concept pages, so the gallery page and the board link both ways.
A project can be a package that other projects use, and use packages itself: help topic "packages". To find a
ready-made output in any library ("a conifer", every terrain): library {action:"search", query?, kind?, tag?}.`,
  graph: `GRAPH FORMAT
{
  "nodes": {
    "ground": {"type": "grid", "params": {"size": [10, 10], "divisions": [20, 20]}},
    "pts":    {"type": "scatter", "in": ["ground"], "params": {"count": "=rock_count", "seed": 1}},
    "rock":   {"type": "sphere", "params": {"type": "ico", "level": 2, "radius": 0.2}},
    "rocks":  {"type": "copy_to_points", "in": ["rock", "pts"]},
    "out":    {"type": "merge", "in": ["ground", "rocks"]}
  },
  "output": "out",
  "vars": {"rock_count": 200},
  "params": {"rock_count": {"type": "int", "min": 0, "max": 2000, "label": "Rocks", "desc": "number of rocks"}}
}
- "vars": graph constants that "=expr" params and code read by their bare name ("=rock_count * 2", @P.y += height).
  Name them so code can: letters, digits and _, and not a JavaScript keyword (class, default …), a helper (noise,
  rand, length, detail …), a built-in (Math, Number, JSON …), the time (frame, time, fps, timeInc) or a wrangle name
  (ptnum, Frame …); the build says when a name is taken. "params": one entry per var a person would tune (3–8 of them):
  {type (float int bool string enum), desc, min, max, options (enum: strings or numbers; the var holds the option,
  so [4, 8, 16] gives numbers), label (control name), step (slider step)}.
  The live viewer (preview) renders them as controls: sliders for numbers with a range, menus for options, checkboxes
  for bools. They are also the parameters when the graph is saved as an asset.
- People change vars at any time (the viewer's controls edit the stored graph): read it with graphs {action:"get"}
  before assuming a var's value, and edit {op:"vars"} rather than rebuilding to change one. When a person asks to
  keep a value, keep it.
- Command line: --var name=value sets a var for one run without editing the file (repeat it; numbers, true/false and
  JSON values are parsed, other text is a string; an unknown name lists the graph's vars), and --output <id> renders,
  exports and inspects a named output instead of the default: topotopo terrain.json --output land --var relief=8
  --render r.png --export land.glb. Exports record the vars they were made with (help topic "export", SOURCE).
- The viewer shows each cook as it runs (the node, the time) and has a Stop button: a cook a person stopped fails with
  "cook stopped" at the node it stopped at. That is their decision, not an error to retry: ask before cooking it again.
- "in": ordered input list (null = unconnected), a single name, or {"inputName": node} (names from help).
- Output node: "output", else a node named out/OUT, else the last unconnected node.
- Optional "outputs": {"rotor":{"node":"rotor_final","label":"Rotor"}} publishes additional deliverables beside
  the default. Publish complete assets and useful separate parts; the viewer isolates each on click and lists
  its textures/layers. In a project that is a package they are its outputs; "publish": false keeps one (a viewer-only
  preview) out of the package, "tags" and "description" say what it is to search, and "kind" pins what it cooks to
  (help topic "packages"). Rename/remove edits maintain references. The latest render of each graph node is saved as
  exports/renders/<graph>-<node>.png (each render overwrites it) unless save_to is supplied; explicit render/export
  destinations are registered in the viewer too.
- Optional "export" (on the graph for the default output, or on an entry of "outputs") is where that output
  exports: a format ("glb" → exports/<graph or output id>.glb) or {"format":"obj","path":"parts/a.obj","up_axis":"z"}
  (the export tool's options), always inside exports/, or "path": "engine:props/crate.glb" inside the game engine's
  assets folder that the workspace names (topotopo-workspace.json engine.assets: Godot imports it from there). The
  person's Export buttons in the viewer, export {output} / export {all:true} and the CLI's --export-all write these
  targets; set one with edit {op:"export", output?, export}.
  The viewer's Download buttons need no target: they offer the formats that fit the output (a heightfield: png16,
  r16, mask_png, unreal_landscape; a mesh: glb, gltf, usda, obj …) and hand the person the files, with their record.
- Node names: letters, digits, _ . -  Node types & params are case/underscore-insensitive and accept Houdini-style aliases.
- "bypass": true passes input 0 through. "note": free text. "ui": {x,y} reserved for the future GUI.
- Vectors: a single number broadcasts ("size": 2 → [2,2,2]). Colours accept [r,g,b], "#ff8800" or names.
- build mode "merge" upserts nodes into the existing graph; edit ops: set, add, remove (auto-rewires), connect, rename, output, vars, bypass, replace, insert (after a node, rewiring its consumers).
- Several graphs can coexist (name param); graph_ref composes them. Graphs persist as JSON in the project.`,

  inputs: `HUMAN INPUT (guides, blockouts and masks in the project inputs/ folder)
People feed in their own material by dropping files into <project>/inputs/ (or onto the live viewer, or with its Add
input button): meshes, guide curves and points drawn in Blender, Houdini or Unreal, placeholder blockouts, PNG masks and
heightmaps. Every tool answer ends with a note when inputs/ has files new or changed since your last call. Before building a
landscape or scene, call inputs {action:"list"}; inputs {action:"describe", path} tells what one holds (polygons, open
polylines, loose points, packed prims; bbox in metres; attributes; every name and role value; materials). Read a file
with a file node: {"type":"file","params":{"path":"inputs/guides.glb"}} (relative paths read from the project folder,
the nearest folder with a project.json at or above the graph, else the graph's folder; the list gives the exact path).
MARKERS: what a person places by clicking in the live viewer (Site / Path / Zone / Volume modes) is written as
  inputs/markers.json with the same name and role attributes (sites: points with pscale and orient; paths open and
  zones closed polylines; volumes closed boxes), so describe it and read it like any other input.
FORMATS: glb/gltf (+Y up already; object names → prim "name", materials → "material"), obj/stl/ply (no up axis:
  Unreal exports and Blender exports with Up = Z are Z-up, so add "up_axis":"z"), geo/bgeo (Houdini), csv and
  points.json (one point per row; columns such as name, role, pscale become point attributes), blend (needs Blender
  installed; it converts the file headlessly). Images: png (8/16-bit grey or colour).
CONVENTIONS: only Houdini attributes and groups, all optional, no add-on to install.
  name  string: the object name (the glTF importer writes it on prims; csv/points.json name columns land on points)
  role  string on points or prims: what a guide means: site, path, zone, volume, blockout (below)
  People mark roles with a name prefix on their objects: site.well, path.river, zone.park, volume.no_trees,
  blockout.house (Blender's .001 suffixes do no harm), or with a custom property "role" on the object (it arrives as an
  attribute once the importer keeps glTF extras).
  Derive role from the prefix, keeping a role the file brought (run_over "points" for point guides):
    {"type":"wrangle","in":["guides"],"params":{"run_over":"prims","code":"s@role = s@role || @name.split('.')[0].toLowerCase();"}}
  Select with group patterns: "@role=path", or straight by name prefix "@name=path.*" (a glob; space-separated tokens
  are a union: "@name=path.* @name=zone.*"), e.g. {"type":"delete","in":["guides"],"params":{"group":"@name=path.*","keep":true}}.
ROLES AND RECIPES
  site      a point marks a location (a well, a lone tree, a house spot); pscale = radius in metres, orient or N = heading.
            copy_to_points(asset, sites) {pack:true} puts a copy on every site (scaled by pscale, turned by orient/N);
            foreach {mode:"points"} builds one per site ("=attr.pscale", "=attr.name" in the body). A site drawn as a
            small mesh: pack {by:"name", pivot:"bbox_center_bottom"} gives one anchor point per object.
  path      an open polyline: road, river, wall, fence line. project_curve(paths, terrain mesh) {spacing:1} drapes it on
            a mesh; heightfield_path(terrain, paths) {width, shoulder} cuts a road into a heightfield (layer "path");
            points_along_curve {spacing, side_offset, both_sides} for posts, lamps or trees along it; sweep
            {shape:"ribbon", radius} for a road surface or a wall; heightfield_mask_by_object {by:"distance"} for a river bed.
  zone      a closed polyline or a filled polygon is an area: a park, a field, a no-build zone. Loops drawn as edges
            arrive as polylines ending on their first point: ends {mode:"close"} makes them polygons.
            On a heightfield, heightfield_mask_by_object(terrain, zones) {by:"footprint", falloff} rasterises the polygons
            into the mask layer (mode add / max / subtract / multiply combines several): heightfield_scatter reads it, and
            heightfield_noise, heightfield_remap, heightfield_blur, heightfield_terrace and heightfield_layer blend their
            effect by it (mask_layer:"mask").
            Points inside a zone (top view), as point group in_zone:
            {"type":"wrangle","in":["pts","zones"],"params":{"run_over":"points","code":"@group_in_zone = intersect(1, [@P.x, 1e6, @P.z], [0, -1, 0]).prim >= 0 ? 1 : 0;"}}
            then delete {group:"in_zone"} or {group:"in_zone", keep:true}.
  volume    a closed mesh or box: a region where scatter thins out or thickens. prune(pts, volumes) {mode:"near_geometry",
            distance:0} removes the points inside; mask(ground mesh, volumes) {by:"inside", falloff} → scatter
            {density_mask:"mask"} scatters there (invert:true for a hole); group {class:"point", pattern:"@mask>0.5"} groups
            them. Let volumes reach below the ground. On a heightfield use heightfield_mask_by_object {by:"footprint"}.
  blockout  a placeholder mesh to replace: bound {per_piece:true} gives each piece's box; foreach {mode:"pieces",
            piece_attrib:"name"} runs a body per object, where a package output takes its size from the piece
            ("width": "=bbox('piece').size.x", piece = the body's input node) and match_size(asset, piece) moves it in
            place. A footprint polygon feeds the house asset directly (its input 0).
IMAGES: PNG masks and heightmaps. heightfield_from_image {path:"inputs/height.png", size:[x, z], height_min, height_max}
  makes a terrain (16-bit greys keep the detail); with a heightfield connected it writes into layer (e.g. "mask",
  height_min 0, height_max 1), the image lying at size/center in the world (fit "field" stretches it over the
  connected heightfield instead). attribute_from_map {path, projection:"xz", size, center, name:"mask"} samples it onto
  points (scatter density_mask, prune {mode:"density"}). Textures: a node albedo = image_file {path:"inputs/albedo.png"}
  loads it as an image named "albedo" (after the node; a file node names it after the file) for the texture nodes and
  texture_to_material {base_color:"albedo"}.
EXAMPLE: inputs/guides.glb holds path.* curves and zone.* areas: roads cut into hills, trees in the zones off the road,
the vars a person would tune exposed as params:
${graphLines(INPUTS_EXAMPLE)}
Afterwards render it, and tell the person which of their guides you used for what.`,

  expressions: `PARAM EXPRESSIONS
Any non-code param can be a string starting with "=": a JS expression evaluated with graph vars.
  "vars": {"floors": 6, "h": 3}   →   "height": "=floors*h",  "count": "=floors*4"
ONE FORM: expressions and code (wrangle, script, sdf_expr, heightfield_layer, parametric curves and surfaces, group and
  assert expressions, loop bodies) read graph vars by their bare name: height, not vars.height (an error says so).
  Vars are read-only; in code a local of the same name comes first.
Helpers: sin cos tan asin acos atan atan2 sqrt pow exp log abs floor ceil round min max sign hypot PI TAU E
         clamp fit lerp smoothstep frac mod radians degrees rand(x, seed) pick(array, i)
Conversions: Number(x) parseFloat(s) parseInt(s, radix) String(x) Boolean(x) isFinite(x) isNaN(x), Number.isInteger …
  e.g. a menu var holding text: "=Number(res) * 2".
Time: frame, time (seconds), fps, timeInc. "=sin(time*2)" animates; the node then re-cooks per frame (see topic time).
Inside foreach bodies: iteration, numiterations, value, attr (e.g. "=attr.height"), plus parent vars.
Inside solver bodies: iteration (frames since start_frame), substep, and frame/time/timeInc are the step's time.
READING OTHER NODES (n = a node of the same graph or body, named by a string literal; single quotes avoid JSON escaping):
  npoints('n') nprims('n') nvertices('n')         element counts of n's cooked geometry
  bbox('n') → {min, max, size, center, empty}      vectors are arrays with .x .y .z: "=bbox('base').size.y"
  centroid('n') → mean point position              (bbox('n').center is the box centre)
  detail('n', 'attr'[, comp])                      detail attribute value
  point('n', i, 'attr'[, comp])  prim('n', i, 'attr'[, comp])   (prim 'P' = centroid when no prim P exists)
  primintrinsic('n', i, 'name'[, comp])            computed prim values (topic instancing): "=primintrinsic('rocks', 0, 'bounds', 3)" = ymax
  ch('n', 'param') or ch('n/param')               another node's resolved param value (defaults included)
  e.g. stack on top: "translate": [0, "=bbox('base').max.y", 0]    match a count: "count": "=npoints('pts')"
Referenced nodes are dependencies: they cook first (even if not wired), changing them re-cooks this node, unknown
names get did-you-mean errors, and reading a node downstream of yourself is a cycle error.
Not supported: dynamic names (npoints(name) with a variable), and these functions inside graph "vars".
Assets: their vars become node parameters.
Expressions are per-node constants. For per-element logic use wrangle.
SANDBOX: an expression sees only graph vars (read-only copies), frame/time/fps/timeInc, Math, the helpers and
  conversions above and the reference functions; any other name (process, require, globalThis, fetch, JSON …) is an
  error, and so are import, \`this\` and assigning to a name. Errors name the param and the expression: param "size":
  expression "=…" failed: ….
  Straight-line expressions (operators, helper, conversion and Math calls) run directly; ones with functions, loops, regular
  expressions or method calls run under the script timeout (TOPOTOPO_SCRIPT_TIMEOUT_MS, default 30 s), ~0.5 ms more
  each the first time (the result is reused while the vars, time and nodes it read stay the same).
SECURITY: a graph is code. Expressions and wrangles run sandboxed with a timeout on Node, but can still allocate
  memory and burn CPU until the timeout; do not cook graphs from untrusted sources in a privileged process.`,

  time: `TIME
Every cook happens at a frame: build/edit/render/inspect/export accept "frame" (default 1). frame 1 = time 0; time = (frame-1)/fps, fps 24.
CLI: --frame 12, or --frames 1-48[:step] with --render "out/f{frame:04}.png" / --export "out/f.glb" (→ f.0001.glb, f.0002.glb …).
Only time-dependent nodes re-cook when the frame changes; everything else stays cached:
  - "=expr" params reading frame, time, fps or timeInc       "rotate": [0, "=frame*3", 0]
  - wrangles using @Frame, @Time or @TimeInc                  @P.y += sin(@Time*4 + @P.x) * 0.1;
  - scripts reading lib.frame / lib.time / lib.fps / lib.timeInc
  - solver, and loops/assets whose body is time-dependent, plus everything downstream of them.
SOLVER (Houdini SOP Solver): feedback over frames.
  {"type":"solver","in":["seed"],"params":{"start_frame":1,"body":{"nodes":{
     "prev":{"type":"input","params":{"index":0}},
     "grow":{"type":"poly_extrude","in":["prev"],"params":{"group":"@N.y>0.9","distance":0.1}}},"output":"grow"}}}
  Body inputs: 0 = previous frame's result (initial geometry on start_frame), 1 = initial, 2/3 = solver inputs 2/3 at that frame.
  Cooking frame N runs the body for frames start_frame..N (substeps times each); before start_frame the input passes through.
  Each frame's state is cached, so stepping 10 → 11 runs the body once; jumping back is a cache hit.
  Body vars (by their bare name in "=expr" params and code): iteration (frames since start_frame, from 0), substep, and
  frame/time/timeInc = the step's time (fractional between substeps).
SOLVER vs FOREACH: foreach feedback:true is count-based (N iterations in one cook, no time, cached as a whole);
  the solver's result depends on the frame you cook at and is advanced frame by frame.
PARTICLES: the particles node is a solver too: frame f runs steps + (f - start_frame) × substeps steps, every frame's state is
  cached the same way (10 → 11 runs one frame), and animate:false makes it time-independent (always "steps" steps).
LIMITS: one cook of rbd_settle, rbd_stack, drape, inflate, particles, heightfield_erode or remesh_quad stops with an error
  naming the node after TOPOTOPO_SIM_TIMEOUT_MS (default 10 min; lower steps/duration/iterations, not the limit). Params that
  count something have a max (help shows it); larger values are clamped.`,

  wrangle: `WRANGLE (per-element JavaScript with VEX-style @attributes)
{"type": "wrangle", "in": ["geo"], "params": {"run_over": "points", "code": "@P.y += noise(@P*2) * 0.1;"}}
run_over: points | prims | vertices | detail (once). group: limits elements.
@name reads/writes the current element's attribute. Unknown names are created on write.
  Type prefixes for new attributes: f@ float, i@ int, v@ vec3, p@ vec4/quaternion, u@ vec2, s@ string.
  Known names get Houdini types (Cd/N/v/up/scale/uv = vec3, orient = vec4, pscale/width = float, id/class = int, name = string).
ARRAYS (variable length per element): f[]@ float[], i[]@ int[], s[]@ string[]; plain @name binds an existing array.
  i[]@nbrs = nearpoints(0, @P, 0.5);   i[]@pts = primpoints(0, @primnum);   s[]@tags = ["wall"]; @tags.push("red");
  Reads are JS array copies written back after each element (so push/splice/assignment all persist). Without a []
  prefix a new attribute assigned arrays becomes a fixed-size TUPLE, so declare arrays with f[]@/i[]@/s[]@.
  len(a) append(a, v) (one entry) concat(a, b) slice(a, start, end) find(a, v) (-1 = missing) sort argsort reverse
  unique (first-occurrence order) uniquevals (sorted) isvalidindex(a, i) sum avg; min(a)/max(a) of ONE array = its
  smallest/largest entry (min(a, b) stays component-wise). All return new arrays. point(0,"nbrs",pt) reads arrays too.
Specials: @ptnum @primnum @vtxnum @elemnum @numpt @numprim @numvtx @numelem; time: @Frame @Time @TimeInc (only then is the wrangle re-cooked per frame)
Groups: @group_top = 1 (membership of the current element: point, prim or vertex group by run_over). Inputs: @opinput1_P reads input 1 at the same index.
Prim mode: @P = centroid (read-only), @N = face normal (read-only) when no prim attrib exists.
VECTORS are JS arrays with .x .y .z .w (.r .g .b) accessors. NO operator overloading: use
  add(a,b,...) sub(a,b) mul(a,b,...) div(a,b) (vector/scalar broadcasting) neg dot cross length length2 distance normalize
  lerp/mix fit fit01 fit11 efit clamp smoothstep min max abs floor ceil frac mod pow sqrt sin cos… avg sum reflect project
  vec2 vec3 vec4 set radians degrees PI TAU
ROTATION (radians, like VEX): quaternion(angle, axis) qmultiply qrotate qinvert eulertoquaternion([rx,ry,rz]) dihedral(a,b) slerp
  lookat(dir, up) → quaternion with +Z along dir, +Y toward up; rotate(v, angle, axis)
RANDOM (deterministic): rand(seed...) [0,1)  randv(seed) vec3  randdir(seed) unit vec  randrange(seed, lo, hi)  randint  pick(arr, seed)  shuffle
NOISE (p = number | vec2 | vec3, ~[-1,1]): noise(p, seed) perlin, snoise simplex, vnoise vec3, worley (F1 distance), fbm(p, oct, lac, gain), ridged(...), curlnoise(p)
COLOUR: hsv2rgb(h,s,v) rgb2hsv(rgb) ramp([[0,[0,0,1]],[1,[1,0,0]]], t)
GEOMETRY QUERIES (input 0 = incoming geometry, 1..3 = other inputs):
  npoints(i) nprims(i) nvertices(i) point(i,"name",pt) prim(i,"name",pr) vertex(i,"name",v) detail(i,"name")
  primpoints(i,pr) pointprims(i,pt) neighbours(i,pt) neighbourcount primvertexcount haspointattrib hasprimattrib
  nearpoint(i,pos[,maxdist]) nearpoints(i,pos,maxdist,maxcount) xyzdist(i,pos) minpos(i,pos) closest(i,pos)→{dist,pos,prim}
  intersect(i,orig,dir)→{prim,pos,dist} (prim -1 = miss)  inpointgroup(i,"grp",pt) inprimgroup(i,"grp",pr)
  invertexgroup(i,"grp",v) inedgegroup(i,"grp",pt0,pt1)
  primintrinsic(i,"name",pr): read-only values computed per prim: "bounds" [xmin,xmax,ymin,ymax,zmin,zmax], "typename"
    ("Poly" | "PackedGeometry" | "BezierCurve" | "NURBCurve"), "vertexcount", "closed"; on packed prims "packedbounds" (the
    source's own box), "transform" (3×3), "packedfulltransform" (4×4), "pivot" (topic instancing)
EDITS (applied after the loop, geohandle 0 optional):
  addpoint(0,pos)→pt  addprim(0,"poly"|"polyline",[pts])→prim  removepoint(0,pt)  removeprim(0,pr,andpoints)
  setpointattrib(0,"name",pt,v) setprimattrib setvertexattrib setdetailattrib(0,"name",v) setpointgroup(0,"g",pt,1) setprimgroup
  setvertexgroup(0,"g",v,1) setedgegroup(0,"g",pt0,pt1,1)  (0 removes)
DEBUG: print(...) (shows as warnings), error("msg") aborts. Use 'return' to skip the rest for the current element.
VARS: graph vars by their bare name, as in "=expr" params: @P.y += height * 0.5; rand(@ptnum, seed). Read-only (writing
  one is an error); a local of the same name comes first. Inside foreach also iteration numiterations value attr, inside
  solver iteration substep frame time timeInc. A wrangle re-cooks when a var it names changes, not for other vars.
SPEED: a point wrangle over 64k+ points that calls no geometry query/edit/print function runs in parallel on worker threads (same result).
SDF helpers are also available (see topic sdf).`,

  groups: `GROUP PATTERNS (any "group" param; also delete/group nodes)
  ""  or  *          all elements
  top                named group (wildcards: side*)
  !top               everything not in top     ^top  removes top from the selection so far
  0-10  5  0-100:2   element index ranges (:2 = every 2nd)
  @P.y>0.5           attribute test, ops = == != > < >= <= ; components .x .y .z .w .r .g .b
  @class==3   @name=piece*   @Cd.r<0.2   @ptnum<100
Tokens are space-separated and applied left to right (union unless prefixed ! or ^).
STRING ATTRIBUTES (name, path, a material or part label):
  @name=barrel        exactly "barrel" (= and == are the same)
  @name=bar*  @name=*rel  @name=b?rrel   wildcards: * any run, ? one character; case-sensitive
  @name!=frame        every element whose name is not "frame"
  "@name=barrel @name=stock"         either (a space is a union)
  "* ^@name=barrel ^@name=stock"     all but those two
  Quotes around the value are optional (@name='bolt*'); a value cannot hold a space (it splits the tokens), so name
  parts with _ or -. < > <= >= never match a string. Digits in a string compare as text: @lod=1 matches "1", not "01".
  A prim test reads the prim attribute, then the detail one, then the point one (a string from the prim's first point,
  numbers averaged over its points); a point test reads the point attribute, then the detail one.
RECIPES: material per part {"type":"material","params":{"name":"glass","group":"@name=Glass*"}} · prims 0 to 11
  "0-11" · all glass but the first three prims "@name=Glass* ^0-2" · pieces without names: name them first with
  attrib_string {"format":"part_{piece:03}"} (connected pieces; piece_attrib for class / copynum), then select
  "@name=part_00*". Help topic "materials" has the material recipes.
FOUR CLASSES: point, prim, vertex (polygon corners), edge (unordered point pairs, Houdini edge groups).
  group node: "class": "point" | "prim" | "vertex" | "edge". delete: class vertex removes corners (a polygon losing
  one is deleted, polylines shrink); class edge deletes every prim using one of the edges.
VERTEX patterns: names, ranges (vertex numbers), @attr reads vertex then point/prim/detail attributes; @vtxnum @ptnum @primnum.
EDGE patterns (index ranges address the unique-edge list: first occurrence walking prims, polyline segments included;
  inspect {class:"edge"} lists it with p-pairs, lengths and angles):
  p3-7               the edge between points 3 and 7       p0-1-2-3   chain      p0-1-2-3-0  closed chain
  2e1                side 1 of prim 2 (its vertex 1 → vertex 2)
  boundary | unshared   edges used by one polygon     shared   used by 2+     nonmanifold   used by 3+
  angle>30  angle<=5    dihedral angle between the two polygons in degrees (box edges = 90; boundary edges never match)
  length<0.1            edge length
  border:top            border of a prim group or pattern (sides used by exactly one selected polygon)
  loop:p3-7  ring:p3-7  edge loop (straight through 4-valent quad points) / edge ring (opposite sides of quads) through
                        each edge of the token after the colon, e.g. loop:rim, ring:0
  @P.y>0                attribute test on the average of the two endpoints' point attributes; @edgenum
  group:x edge:x        only edge groups      prim:x point:x vertex:x   convert a group of that class
  A bare name is an edge group first, then a keyword above, then a group of another class.
CROSS-CLASS NAMES: a pattern may name a group of another class; it is converted:
  to points = points touched by the elements; to prims = prims whose points/vertices/sides are ALL selected;
  to vertices = vertices of the selected points/prims/edges; to edges = sides of selected prims, or edges whose two
  points are selected.
GROUP TOOLS: group_promote (from → to class, include any | all, e.g. point→prim all = prims entirely in the group,
  edge→prim any = prims using a grouped edge), group_expand (grow/shrink point/prim/edge groups by N steps; negative
  shrinks), group_combine ("a & !b | c", ^ xor, parentheses), group_delete, group_rename.
SELECTING EDGES TO BEVEL (poly_bevel group; also subdivide creases, normal hard_edges):
  "angle>80"            sharp edges only (box edges = 90, flat subdivision edges = 0)
  "angle>80 ^@P.y<0.9"  sharp edges minus those low down (^ removes): e.g. only the top rim of a box of height 1
  "border:top"          rim of a prim group (extrude's top cap, poly_extrude's front faces)
  "p3-7" "p0-1-2-3-0"   explicit edges / closed chains of point numbers
  "rim"                 an edge group made with {"type":"group","params":{"class":"edge","name":"rim","pattern":"..."}}
  "bevel_edges"         poly_bevel's output group (where the bevel meets the faces): bevel again to soften the first
  ""                    every edge shared by two polygons where the surface bends (flat edges inside a plane, such as
                        the splits of a boolean's cut face, are skipped). Boundary and non-manifold edges are skipped
                        with a warning.
  mode "points" takes a point pattern instead ("0", "@P.y>0", a point group) and truncates those corners.
EDGE GROUPS IN NODES: poly_bevel, subdivide creases (+ creaseweight attribute), normal hard_edges. Edge groups follow points:
  they survive transforms, fuse (remapped), merge (offset), copies, deletes (edges that no longer bound a prim
  drop out) and every node that rebuilds geometry where an edge's two points are copied 1:1; subdivide moves them to
  the child edges. Booleans, remesh and other solid ops drop them.
WRANGLE: @group_x works in vertices mode too; invertexgroup(i,"g",v) inedgegroup(i,"g",pt0,pt1) setvertexgroup(0,"g",v,1)
  setedgegroup(0,"g",pt0,pt1,1). Scripts: lib.halfEdges(geo) (edge loops/rings, one-rings, boundaries), lib.EdgeSet,
  lib.evalEdgeGroup(geo, pattern), lib.convertSelection(geo, from, to, sel, include).
Groups produced by nodes: poly_extrude front/side, poly_bevel bevel/bevel_corner (+ edge group bevel_edges), extrude top/bottom/side, boolean from_a/from_b, sweep caps/sides, loft caps/sides, curve fillet, remove_interior interior,
clip above/below/cap, fill_holes filled, lsystem leaves/J/K/M, voronoi_fracture inside, knife cut (edge + point) and
above/below, polysplit split (edge + point), edge_divide divided, polybridge bridge, polyfill fill, dissolve dissolved,
edge_collapse collapsed. Create custom ones with "group".`,

  materials: `MATERIALS (assign by name, range or group; name the pieces first)
A material is a prim string "material" naming an entry of the detail table "materials" (PBR base colour, metallic,
roughness, emissive, alpha, maps). The material node writes both for the prims of its group ("" = all); chain one
node per material, the later one winning where groups overlap. Maps: base_color_map / normal_map / roughness_map file
paths, or images from the texture nodes through texture_to_material (help topic "textures").
PICK THE PRIMS (any group pattern, help topic "groups"; string tests take wildcards and are case-sensitive):
  by name          {"type":"material","params":{"name":"glass","group":"@name=Glass*","alpha":0.3}}
                   "@name=*lass*" contains · "@name=glass_* @name=Glass_*" either · "@name!=frame" all but
  by prim range    "0-11" (prims 0 to 11) · "0-100:2" every second · "6-11 ^7" without 7 · "@name=Glass* ^0-2"
  by node groups   extrude "top" / "side", poly_extrude "front", poly_bevel "bevel", boolean "from_b" (the cut
                   faces), clip "cap" … ; by attribute "@P.y>1.5", "@N.y>0.9" (facing up)
NAME THE PIECES FIRST when they have no names (one node each):
  connected pieces  attrib_string {"format":"part_{piece:03}"} → part_000 … (or connectivity {name_prefix:"part_"})
  copies            attrib_string {"format":"crate_{copynum}"} after copy_xform / copy_to_points
  engine suffixes   attrib_string {"format":"hull_{piece:03}-convcolonly"} names 146 collision hulls at once
  clean up          attrib_string {"find":"_LOD","replace":"_lod"} · {"find":"\\\\.\\\\d+$","regex":true} · {"case":"lower"}
  prefix            attrib_string {"format":"gun_{value}"} keeps each name behind a prefix
  Then material {group:"@name=hull_*"} and export split_by_name write one mesh per name.
EXPORT: glTF writes one material per table entry; a named material decides the colour of its prims (their Cd is
  dropped unless vertex_colors:true). Merging pieces whose materials or images share a name but differ (two package
  outputs that both call their map "basecolor") renames the later one ("paint_2", "<material>_basecolor"), so every
  piece keeps its own look. Inspect the table: inspect lists materials; render {shading:"pbr", textures:true}.
MATERIAL OUTPUTS (a material as a package output, kind "material": materials and their maps, no geometry):
  make    texture nodes → texture_to_material with NOTHING in input 0, the images in input 1 ("in": {"images": "maps"}
          or [null, "maps"]), {material:"steel", base_color, normal, orm} → the output; or material {name, base_color,
          roughness} with no input for a plain one.
          Each map keeps its texture node's resolution (a 4k normal beside a 512 mask); expose one as a param (a var
          such as "normal_resolution" read by that node) to let a use change it.
  use     {"type":"owner/materials/steel", "params":{...}} → input 1 of material {group:"@name=body*"} on the mesh: the
          material and its maps are copied in and assigned (from names one when the source holds several; name
          renames it). The material node's own colour and map params are not used then.
  see     renders, the viewer and the Gallery show it on spheres (one per material) with its base colour maps;
          publishing records each map's size (packages lists "maps baseColor 2048, normal 4096").
  export  format "textures": one PNG per map + materials.json (each material's values and the files of its maps), for
          engines to rebuild it; glb and usda need a mesh: export the mesh that uses it.`,

  attributes: `ATTRIBUTES (Houdini conventions)
Classes: point (P and per-point data), vertex (per polygon corner: uv seams, hard normals), prim (per face/curve), detail (global).
Lookup precedence when reading: vertex > point > prim > detail.
Common names:
  P vec3 position · N vec3 normal · Cd vec3 colour (0-1) · Alpha · uv vec3 (u,v,0) · v velocity
  pscale float uniform scale · scale vec3 · orient vec4 quaternion (x,y,z,w) · up vec3 · rot · trans · pivot   (copy_to_points)
  width float curve diameter (polywire, USD curves) · curveu 0..1 along curves (resample)
  name string piece name (export splits meshes by it) · class int piece id (connectivity) · copynum int (copy nodes)
  material string prim: material name (material node); detail "materials" = JSON table name → {baseColor, metallic,
    roughness, emissive, alpha, doubleSided, unlit, textures: {baseColor, normal, roughness} file paths} that exporters
    write as glTF / USD materials (Houdini shop_materialpath is read too)
  id int · piece · variant int (copy_to_points variants) · height (terrain 0-1)
Instancing transform: P + trans, rotation from orient, else N (+Z axis) and up (+Y axis), then rot; scale = pscale * scale.
Types: float/int with tuple size 1-4 (up to 16), or string. Merging unions attributes; missing values take defaults
(Cd/pscale/scale default 1, orient identity).
ARRAY ATTRIBUTES: float[] int[] string[] hold a variable-length list per element (neighbour lists, piece membership,
  per-point samples). A TUPLE has a fixed size for every element (P, Cd, uv); an ARRAY's length differs per element.
  Default = empty array. Inspect/summaries show "nbrs int[] (len 2–6, avg 4.1)".
  Make them: attrib_array (from_neighbours: point int[] nbrs; from_group_points: prim int[] pts; from_attributes packs
  attributes), attrib_create {"type":"float[]","value":[1,2,3]} (with type auto [1,2,3] is a float TUPLE of size 3),
  wrangle i[]@nbrs = nearpoints(0, @P, 0.5).  Read them: attrib_array to_attributes (name_0, name_1 …) or length.
  Rules: new elements copy their source's array (a blended element takes the heaviest source's, never an average);
  merge gives inputs without the array empty arrays; attrib_promote copies (many → one needs method first/last);
  attrib_transfer copies the nearest point's array; render color_by an array colours by its length; group patterns
  do not test arrays (unpack with attrib_array first); exporters (glb obj usda ply stl) skip them; json keeps them.
  Arrays of point/prim numbers (nbrs, pts) are not renumbered when topology changes: rebuild them after fuse, sort,
  delete, booleans, subdivide …
  Wrangle: i[]@a f[]@a s[]@a declare/bind arrays; plain @a binds an existing array. @a is a JS array copy that is
  written back after the element, so @a.push(x) persists. Helpers: len append concat slice find sort argsort reverse
  unique uniquevals isvalidindex sum avg, min/max of ONE array = its smallest/largest entry. Vector arrays (v[]@) are
  not supported: use f[]@ with flattened components. Script: geo.points.add("a", "int[]"), a.get(i) → array, a.set(i, [..]).`,

  sdf: `SDF / IMPLICIT MODELLING
Volumes are signed distance functions (negative inside) carried in geometry; nodes compose them lazily.
  sdf_shape (sphere box round_box torus capsule cylinder cone ellipsoid octahedron) → sdf_combine (union/subtract/intersect,
  smooth_* with blend k) → sdf_modify (offset shell noise twist bend repeat) → sdf_to_mesh (watertight triangles, smooth N).
  sdf_from_mesh turns closed meshes into volumes (blend meshes, offsets); remesh = voxel remesh (remesh_isotropic keeps
  sharp edges, boundaries and attributes).
sdf_expr: write the distance in JS: p = [x,y,z]; return a number. Inputs via sdf(0, p), sdf(1, p); graph vars by their
  bare name (sdSphere(p, radius)).
  IQ-style helpers: sdSphere(p,r) sdBox(p,[hx,hy,hz]) sdRoundBox(p,b,r) sdTorus(p,R,r) sdCapsule(p,a,b,r) sdCylinder(p,h,r)
  sdCone(p,h,r) sdEllipsoid(p,[rx,ry,rz]) sdPlane(p,n,h) sdOctahedron(p,s) sdHexPrism(p,[r,h]) sdSegment(p,a,b,r)
  opUnion opSubtract(a,b) opIntersect smin/opSmoothUnion(a,b,k) smax opSmoothSubtract(a,b,k) opRound(d,r) opOnion(d,t)
  opRepeat(p,[cx,cy,cz]) opTwist(p,k) opBend(p,k) opTranslate(p,t) opRotateX/Y/Z(p,radians) opMirrorX(p)
  plus all wrangle math (add, sub, mul, noise, fbm …).
Example: {"type":"sdf_expr","params":{"code":"const b = sdBox(p,[0.6,0.3,0.4]); const s = sdSphere(sub(p,[0,0.35,0]),0.35); return smin(b, s, 0.15) + 0.03*noise(mul(p,6));"}}
Then: {"type":"sdf_to_mesh","in":["that"],"params":{"divisions":120}}. Set bounds_min/bounds_max to enclose the shape.
Time limit: sdf_expr code is sandboxed like a wrangle. sdf_to_mesh and sdf_grid sample a field that comes from sdf_expr
  (also through transform/sdf_modify/sdf_combine) under the script timeout (TOPOTOPO_SCRIPT_TIMEOUT_MS, default 30 s)
  for the whole mesh or grid: a loop or a field too slow for the resolution fails them with "SDF code (sdf_expr)
  exceeded N ms". Analytic volumes (sdf_shape, sdf_from_mesh …) have no limit.`,

  heightfield: `HEIGHTFIELDS (terrain; Houdini's HeightField model, exports to Unreal Landscape)
A heightfield is a volume carried in the geometry (like an SDF), not polygons: a regular grid of samples in the XZ
plane, Y up, with named float layers. Samples sit on grid nodes: size 20 at resolution 0.1 = 201 × 201 samples (Unreal
counts landscape vertices the same way). Layers: height (world Y), mask (0..1 selection), flow, sediment, debris, water
(written by heightfield_erode), path (heightfield_path) and any user layer (rock, snow …).
WORKFLOW
  heightfield {size, resolution} → heightfield_noise {fractal: "ridged", amplitude, element_size, range: "positive"}
    (warp_amplitude, warp_element_size: a domain warp in metres bends ridges, escarpments and rivers into meanders;
    terrace a broad warped noise for cliff bands, carve a band of a warped mask_noise around 0.5 for a river)
  → heightfield_erode {iterations: 60} (gullies and sediment fans; writes flow, sediment, debris, water)
  → heightfield_path (road along a curve, writes "path") · heightfield_project (stamp meshes/curves: plateaus, ridges)
  → heightfield_mask_by_feature (slope/height/curvature/direction/flow/occlusion) → heightfield_scatter → copy_to_points
    (heightfield_scatter {align: "upright"} for trees and buildings, {align: "slope"} for rocks that follow the ground;
    without align, copy_to_points aims each copy's +Z along N, which lays Y-up models down;
    {min_distance: 12} for lots that never overlap; heightfield_project {level: "mean"} levels the pads under them)
  → heightfield_to_mesh {color: "terrain"} for polygons (layers become point attributes), or export png16.
  Other sources: heightfield_from_mesh (project polygons along Y), heightfield_from_image (8/16-bit PNG).
  Layer tools: heightfield_layer (expression over layers and graph vars "height * mask + lift", or copy/rename/delete/
  fill; a layer named like a var comes first, with a warning, so name terrain vars apart from layers: relief, not height), remap
  (input_min..input_max → output range), blur, terrace (levels at base + n × step_height), clip, cutout, mask_noise,
  mask_blur, mask_expand, resample (e.g. samples [505, 505]), crop (a tile or world bounds, samples kept exactly),
  transform (translate, scale, 90° turns; the generic transform node works too), to_sdf (solid terrain for
  caves/overhangs with sdf_combine).
TILES: a big map (4 × 4 km at 2 m = 2001² samples) is previewed and processed one tile at a time at full resolution:
  heightfield {size:[4000, 4000], resolution:2} → heightfield_crop {tiles:[8, 8], tile:[3, 5], margin:40} → the chain.
  Everything that works at world positions gives the tile the same samples as the whole map: noise (and its warp),
  terrace levels step/range, remap's input range, layer expressions in x z, masks by height and by object distance,
  mask_noise, clip, from_image (fit world). Cell sizes exact in binary (0.25, 0.5, 1, 2 m) make the positions
  bit-identical. Filters read neighbours: crop with a margin of their reach (a sample for slope and direction masks;
  blur radius, curvature and occlusion radius, mask_expand and footprint distance + falloff, cutout feather, path
  shoulder + smooth, project radius and whole pieces for its level mean) and crop the margin off again
  (heightfield_crop {mode:"bounds"} to the crop_core_min / crop_core_max detail attributes). Not local, so a tile only
  matches statistically: erosion (droplets and water cross tile borders: erode the whole map, or a tile with a margin),
  heightfield_flow / fill_sinks (catchments), heightfield_scatter (points drawn over the field; scatter on the map and
  keep the tile's points). Tied to the field's own extent: the options terrace levels "layer", remap and
  heightfield_to_tex auto_range, heightfield_flow normalise, transform pivot_at_center and from_image fit "field" (all
  off by default), and layer variables i j u v, to_mesh uv and its height / terrain colours, to_sdf's bottom.
  Exports: pass the same height_min / height_max to every tile.
MASKS: every mask node combines with the existing mask (mode replace/add/subtract/multiply/max/min): chain them,
  multiply = and, max = or. Most layer nodes take mask_layer to blend their effect by a mask.
  e.g. rocks on steep slopes off the road: mask_by_feature slope 33° → heightfield_layer {layer:"mask", expression:"mask * (1 - path)"}.
EROSION: droplets in metres, so the same params erode alike at any spacing (an 8 m preview like the 2 m map, finer
  detail aside): rain_density droplets per m² per iteration, max_distance metres a droplet travels, erosion_radius the
  brush radius in metres (about a gully's half-width). erosion_rate, deposition_rate, evaporation, inertia, gravity and
  thermal_rate act per droplet step of erosion_radius / 3 and sediment_capacity is a volume in those steps cubed; the
  node converts them to the field's cells (cells of erosion_radius / 3 take them as given: the defaults at 0.1 m).
  Scale: for a terrain λ times larger multiply erosion_radius and max_distance by λ and divide rain_density by λ², the
  rest unchanged (a 4 km map at 2 m: erosion_radius 6, max_distance 60, rain_density 0.005). Thermal:
  thermal_talus_angle, thermal_rate; hardness_layer (1 = rock), freeze_layer (1 = untouched); boundary closed conserves
  material. Deterministic per seed. Cost ≈ rain_density × area × iterations × max_distance / cell droplet steps
  (512² × 100 iterations at the defaults ≈ 2–3 s). Stronger: more iterations, rain_density or sediment_capacity. Not
  local: a tile erodes like the same area of the map only statistically (see TILES).
  method droplet / backend js is the unchanged default. backend kernel loads WASM; auto uses an already loaded
  kernel or falls back to js. method pipe and stream_power require the kernel. Pipe uses virtual pipes, CFL-limited
  time_step (0 = automatic, shorter on finer cells; a time_step below the limit of every spacing simulates the same
  time per iteration), rain_amount in metres/second, optional rain_layer multiplier, evaporation and thermal
  talus relaxation. stream_power adds stream_power_k * drainage^stream_power_m * slope^stream_power_n incision.
  Kernel erosion also writes wear (cumulative eroded depth); pipe water is remaining water depth in metres.
  heightfield_flow {method:"dinf", log_scale:true} writes drainage and direction without erosion: drainage is
  ln(1 + contributing area in m²) (raw area without log_scale; normalise:true divides by the field's largest value,
  which depends on its extent); direction E/SE/S/SW/W/NW/N/NE = 0..7, sink = 255. D8 routes one receiver,
  D-infinity splits across two downhill receivers; local pits retain flow unless fill_sinks:true routes over a
  virtually filled surface (height stays unchanged). stream_power accepts the same opt-in fill_sinks flag.
  See examples/erosion_models.json for all four erosion methods on the same ridged terrain.
DRAINAGE: heightfield_fill_sinks uses deterministic priority-flood to raise closed depressions to their spill level.
  epsilon:0 keeps flat spill surfaces; epsilon>0 adds a strict downhill gradient (metres per neighbour step).
  max_depth:0 fills every depression; a positive limit retains each connected depression whose maximum depth exceeds
  it. The entire retained lake bed stays unchanged. fill is added terrain depth, lake is standing water depth, both
  in metres and nonnegative; water surface = height + lake. write_fill/write_lake control those output layers.
  mask_layer names a no-fill layer (values must be 0..1; cells at 1 stay untouched as terminal outlets).
  Protected outlets and retained lakes are exceptions to border drainage. Pipe/stream_power erosion initializes from lake and writes simulated water
  depth back to lake within that original lake footprint. Droplet water remains its legacy normalised resting mask.
  See examples/drainage.json: unfilled massif beside shallow fills, blue retained lakes and coloured accumulation.
RENDER / INSPECT: render draws heightfields as a shaded grid with the mask in red; heightfield_layer:"flow" draws
  another layer in red instead ("none": none; the viewer's layer picker does the same), color_by any layer name maps
  it to colours. It draws at most 256 quads per side, so a 513 × 513 field shows at 257 × 257 (the footer and a note
  say so); heightfield_res: "full" (CLI --heightfield-res full) draws every sample. inspect and every cook summary
  list the grid and each layer's min/max/mean.
UNREAL LANDSCAPE: export {path: "exports/terrain.png"} (png16) or ".r16" writes the heightmap plus terrain.json with
  height_min / height_max and the import settings. Pixel column = X, row = Z (row 0 at min Z); Unreal X = X,
  Unreal Y = Z, Unreal Z = Y, centimetres.
  value v → h = height_min + v / 65535 × range.  Unreal: Z_cm = location.z + (v − 32768) × scale.z / 128, so
  scale.z = range_m × 12800 / 65535 (≈ range_m / 512 × 100: Z scale 100 spans 512 m), scale.x = scale.y = cell × 100,
  location = (origin.x × 100, origin.z × 100, 100 × (height_min + range × 32768 / 65535)).
  Prefer resolutions Unreal likes (127, 253, 505, 1009, 2017, 4033 per side): heightfield_resample {samples: [505, 505]}.
  Weight layers: export {format: "mask_png", layers: ["mask", "flow"]} → one 8-bit PNG per layer (name_<layer>.png).
  Tiles: pass the same height_min / height_max to every export.
  Whole scene: export {format: "unreal_landscape", path: "exports/level"} of a merge(heightfield, meshes, instances) →
  heightmap + every layer + landscape.json (the exact Landscape import settings and steps) + objects.glb + the instance
  stream; help topic "export" (UNREAL LANDSCAPE BUNDLE). examples/unreal_demo.json is a complete scene.`,

  textures: `PROCEDURAL TEXTURES AND BAKES (Substance Designer / Houdini COP style; category "texture")
An image is a volume carried in the geometry (like a heightfield): a 2D grid of float pixels with named layers of 1
(grey) or 4 (RGBA) channels. Layer "C" is the image; nodes add others ("id" per-cell random, "mask" bake coverage,
"convex"/"concave" curvature, "distance" heights). Pixel (i, j): column i, row j from the TOP; uv (0,0) = bottom-left.
Values are written to PNG as value × 255 with no transfer curve: colours hold the numbers colour params give
("#a5462e" → 0.65, 0.27, 0.18), so files match the colours you typed; data maps (heights, masks, roughness, normals)
are linear. Images merge, clone and cache like geometry; materials reference them as "image:<name>".
NAMES: every image is named after the node that made or last filtered it ("rust_mask" for the node rust_mask), unless
  that node's name param says otherwise, so default names in a graph never collide and texture_to_material slots name
  nodes: {base_color:"paint", normal:"detail_normal"}. A node whose input holds several images never picks one: it
  stops and lists them; set image (foreground_image, mask_image, detail_image … for the other inputs) to the one to
  use, or isolate it with tex_output {image, keep_only:true}. To edit one image of a stack in place (an atlas, a
  material's maps), give the filter name = that image's name. merge (and every node that merges) keeps an image or
  material several inputs carry (same name and content, e.g. textured LOD branches) once; when two inputs use a name
  for different images or materials (two package outputs whose maps are all "basecolor"), the later one is renamed
  ("<material>_basecolor", "paint_2") with its material table and prim "material", so each piece keeps its own maps
  in renders, the viewer and every export.
GENERATORS (no input, resolution [w, h], name): tex_noise (perlin/simplex/value/worley × fbm/ridged/turbulence,
  tileable default: whole cells per octave; simplex tiles on a 4D torus) · tex_pattern (bricks, tiles, checker, stripes,
  hex, dots: 1 on the cells, 0 in the gaps; grid is a line mask, 1 on the lines, 0 in the cells: for grooved cells use
  tiles; gap = mortar or line width, bevel, variation; layer "id" = random per cell) · tex_cells (Voronoi distance /
  edges / id / crackle) · tex_gradient · tex_constant (one grey value, or an RGBA colour with channels:"rgba";
  input 0 = an image to take the size from) · tex_shape (disc, square, polygon, star, ring; falloff; tile) ·
  tex_splatter (blobs) · tex_scratches (strokes) · tex_text.
FILES: image_file {path:"inputs/brick.png"} loads a PNG (8/16-bit, grey or colour) as an image named after the node
  (name sets another; the file node reads .png the same way, named after the file); layers auto/grey/rgba; srgb
  (default on) keeps the stored values, which suits colour and data maps alike (off only for linear-light colour).
  Input 0 = a geometry to add it to, so image_file nodes chain. People drop their own textures and masks into inputs/.
FILTERS (input 0 = an image; image/layer pick what to process, the result replaces that layer and takes the filter's
  name; every other image and the mesh pass through): tex_blend (normal, add, subtract, multiply, screen, overlay, min,
  max, difference, divide; opacity; input 2 = mask) · tex_levels · tex_curves (ramp) · tex_blur (gaussian/box, tileable
  keeps the mean) · tex_warp (directional/slope/vector by input 1) · tex_transform (offset, rotate, scale, tile) ·
  tex_edge_detect · tex_invert · tex_threshold · tex_histogram_scan (THE mask maker: coverage 0.3 = the brightest 30 %
  turn white, whatever the input's range; or position = a value cut; contrast = hardness; stat coverage) ·
  tex_normal_from_height (physical: depth = metres a value of 1 stands, size = metres the image spans, so the slope is
  real and the same at any resolution; paint grain 0.0003, hammered metal 0.002, bricks 0.015; opengl/directx) ·
  tex_normal_blend (detail normal map over a base, e.g. micro grain over a bake: mode rnm (default, reoriented: both
  reliefs keep their depth) | udn | linear; strength scales the detail; input 2 = mask; never tex_blend overlay on
  normals) · tex_height_to_ao · tex_colorize (gradient map) · tex_channel (pack inputs 0..3 into RGBA, e.g. ORM; or
  extract) · tex_tile_sampler (stamp input 0 on a grid with jitter/rotation/scale; mask input 1) · tex_output (rename,
  or copy a layer out as a new image: brick_ids = tex_output {layer:"id"}; keep_only drops the rest).
  To process a layer as its own image, copy it out first (tex_output layer:"id") and filter that.
  Inputs of different sizes are resized to the first input (bilinear up, area average down).
BAKES (input 0 = mesh with non-overlapping uv in 0..1: uv_unwrap; input 1 = optional high-res mesh): bake_ao
  (samples, max_distance; white = open), bake_curvature (edges' dihedral angles within radius: 0.5 flat, bright convex,
  dark concave; layers convex/concave; creases where separate parts cut into each other count as concave too),
  bake_thickness, bake_position (bbox/uniform/world), bake_world_normal,
  bake_normal (tangent space from the high mesh along averaged-normal cage rays; cage distance), bake_height (high above
  low; layer distance in metres), bake_island_id (colour per uv island, layer id, stat islands), bake_mask
  (mask_group or a numeric attribute), bake_vertex_color (Cd + Alpha). Shared: resolution (default 1024), supersample
  (1..4), padding (texels of edge dilation, default 4), group (prims to bake), keep_mesh (output the mesh too).
  With a high-res mesh: cage (search distance), cage_attrib (default "cage": a float prim/point attribute of the mesh
  that sets the cage per part, e.g. attrib_create {name:"cage", class:"prim", group:"@name=grip", value:0.03}),
  match_name (each named piece projects only onto the high prims of its name: parts sharing one atlas), and layer
  "missed" (1 where no high surface was found within the cage; stat missed) to see where to raise the cage.
  Rays and curvature run on the worker pool. The output is only the image unless keep_mesh.
MATERIALS: texture_to_material {material, base_color, normal, roughness, metallic, occlusion, orm} on input 0 (mesh
  with uv) + input 1 (merged images): writes "image:<name>" slots into the material table, assigns the material (all
  prims when new, else group) and carries the images. occlusion/metallic images are packed into "<material>_orm".
  The material node's *_map paths accept "image:<name>" as well.
CUTOUTS: tex_crop extracts a top-left pixel rectangle (all layers), optionally resizes. trace_image reads alpha
  or a selected channel into closed XY curves, including holes; fill builds faces. Restore UVs after fill using
  uv_project {method:"planar",axis:"z",scale:[width,width*imageHeight/imageWidth]} BEFORE deforming.
  tex_pack items:[{name:"leaf",maps:{color:"leaf_color",normal:"leaf_normal"}}] creates aligned atlas images and
  placement points: name, rect [x,y,w,h], uv_offset, uv_scale. In a vertex wrangle, read these from input 1:
  atlasUV = localUV * uv_scale + uv_offset. Output points follow items order. No rotation or automatic downscale.
  tex_dilate pads nearest valid pixels; alpha stays unchanged by default. For grey/data maps supply an explicit
  validity mask (same size). Pack padding reserves empty gutters; dilate supplies the edge values.
  material {alpha_mode:"mask",alpha_cutoff:0.5,double_sided:true} BEFORE texture_to_material enables cutouts.
  Omitted/auto alpha mode retains legacy behaviour; explicit opaque/mask/blend overrides scalar/vertex auto mode.
  Complete example: examples/image_cutouts.json; workflow and layout contract: docs/image-cutouts.md.
SEE IT: render of a geometry holding only images shows the "texture" view; render {texture:"<image>"|"image/layer"|
  "<material>"} adds the view (a material shows its maps as a labelled strip); render {textures:true} samples base
  colour maps on the mesh (texture × Cd, like glTF). inspect lists every image with size and per-layer ranges.
EXPORT: glb/gltf embed the image textures as PNG (ORM = occlusionTexture + metallicRoughnessTexture); usda writes
  <name>_textures/<image>.png next to the file (ORM through orm_map r/g/b); format "textures" writes every image as
  <dir>/<image>.png (layers: ["id"] or ["*"] for extra layers); json keeps images losslessly; geo/obj/… skip them.
RECIPE (brick wall + worn crate: examples/textures.json):
  bricks = tex_pattern {pattern:"bricks", count:[4, 12], bevel:0.15} · ids = tex_output(bricks) {layer:"id"}
  color = tex_blend(tex_colorize(grain mortar greys), tex_colorize(ids, brick reds), bricks as mask)
  normal = tex_normal_from_height(bricks) {depth:0.035, size:1.6} · crate: uv_unwrap → bake_ao + bake_curvature →
  tex_output layer "convex" → tex_blend subtract noise → tex_histogram_scan {coverage} = edge wear →
  tex_blend(wood, paint, wear) → tex_channel(ao, rough) = ORM → texture_to_material {base_color, orm}.
  Detail on a bake: grain = tex_noise {scale:60} → grain_n = tex_normal_from_height {depth:0.0003, size:<uv span in m>}
  → tex_normal_blend(baked_normal, grain_n) {mode:"rnm"}.`,

  loops: `FOREACH LOOPS
{"type": "foreach", "in": ["lots"], "params": {"mode": "prims", "body": {
   "nodes": {
     "lot":  {"type": "input", "params": {"index": 0}},
     "bldg": {"type": "extrude", "in": ["lot"], "params": {"height": "=2 + rand(iteration, 7) * 10"}}
   },
   "output": "bldg"}}}
Modes: pieces (by piece_attrib or connectivity) · prims · points · count (N times; feedback:true chains results).
Body input index 0 = current element/piece (or the previous result with feedback); 1 = whole input; 2 = foreach input 2.
Vars in the body, by their bare name in "=expr" params and code: iteration, numiterations, value, attr (the element's
attributes, e.g. "=attr.height"), parent vars.
Results are merged (or the last one with feedback). Identical iterations are cached.
For feedback over animation frames (growth, accumulation) use solver instead (help topic "time").`,

  instancing: `PACKED PRIMITIVES (instances)
A packed prim is one point (the anchor: P = instance position) + one prim that references a shared source geometry with a
3×3 rotation·scale. A million trees = a million points + one small mesh. world = translate(anchor P) · transform · source.
Make them:
  copy_to_points {pack:true}   one instance per template point (orient | N+up, rot, pscale, scale, pivot, trans as usual);
                               template point attributes go onto the anchors. Variants: variants "name" (split the source
                               by prim name) or "piece" (connectivity), the point attribute variant_attrib picks one
                               (string name or int index), e.g. trees = merge of named tree meshes.
  pack {by: connectivity|name|attrib|all, pivot}   pieces → instances; identical pieces share one source;
                               constant name/Cd/material per piece move onto the instance.
  file *.glb                   EXT_mesh_gpu_instancing comes in packed (instancing:"expand" for real geometry).
Nodes that KEEP instances (work on anchors / packed prims): transform (also rotates/scales each instance), match_size,
  copy_xform, copy_to_points, merge, switch, null, foreach (pieces/prims/points: one iteration per instance), solver,
  graph_ref, file, delete (not edge dissolve), group, group_*, attrib_* (create, randomize, promote, delete, rename,
  copy, transfer, array, noise), color, material, sort, wrangle (points/prims/detail; vertices unpacks), script, pack,
  unpack, bound (box of the instances), rest, and deformers that move points (noise_displace, jitter, twist, bend,
  taper, soft_transform, lattice, path_deform, point_deform): they move the anchors, i.e. whole instances.
Every other node (boolean, subdivide, scatter, normal, measure, uv_*, …) gets the instances UNPACKED automatically,
  with a warning "unpacked N instances for <node>" (cached, so it happens once). Add an unpack node yourself to choose:
  unpack {group, transfer_attributes:"name Cd material piece", limit, piece_attrib, recursive}.
  Anchor attributes are copied onto the unpacked geometry only where the source has none (Cd: in any class), so a
  source's own colours win and an anchor Cd tints colourless sources.
Read them: primintrinsic(0, "bounds", pr) in a wrangle (or primintrinsic('n', pr, 'bounds') in an expression) is the
  instance's world box [xmin, xmax, ymin, ymax, zmin, zmax], computed when read; "packedbounds" is the source's own box;
  "transform" is the 3×3 rotation·scale and "packedfulltransform" the 4×4 with the anchor position as its last row, both
  row-major for row vectors (p' = p · M + t); "typename" is "PackedGeometry". Sit every instance on the ground:
  wrangle {run_over:"prims", code:"const b = primintrinsic(0, 'bounds', @primnum), pt = primpoints(0, @primnum)[0];
  const p = point(0, 'P', pt); p[1] -= b[2]; setpointattrib(0, 'P', pt, p);"}
See them: render draws instances (an evenly spread subset above 600k triangles, with a note "rendering 9.5k of 30k
  instances"); inspect/build summaries say "packed: N instances of K sources (M triangles expanded)".
Export: glb/gltf → EXT_mesh_gpu_instancing (one mesh + node per source, named like the source's prim "name",
  TRANSLATION/ROTATION/SCALE per instance, with custom_attribs:true the anchor attributes as _NAME instance accessors
  (Cd → _COLOR); shear is approximated with a warning); usda → one PointInstancer (prototypes = sources, protoIndices,
  positions, orientations, scales, ids, velocities, with custom_attribs:true primvars per instance); geo → Houdini PackedGeometry prims sharing embedded sources;
  csv / points.json → one row per instance (instance stream: Position/Rotation/Scale or P/orient/scale, Mesh column)
  + <name>.meshes.json + one GLB per source; json keeps them losslessly; obj/ply/stl expand them (warned).
  instancing:"expand" (export option) always writes real geometry (instances:"expand" for csv/points.json only).
  Unreal: instances.csv + meshes for PCG / ISM, or glb instances where the importer supports EXT_mesh_gpu_instancing;
  USD PointInstancer → HISM.
Example (forest): terrain → mask → scatter → orient → prune → copy_to_points {pack:true, variants:"name", variant_weights}
  with trees = merge of three meshes named pine/fir/oak (examples/forest.json; help topic "pcg").`,

  rbd: `RIGID BODIES: SETTLE AND STACK (Houdini RBD drop / settle, Rapier physics; category "sim")
Use it when placed pieces must rest physically: rocks on a terrain, props on a floor, crates in a pile, a container filled.
  rbd_settle {in: [pieces, collision?]}   every piece falls under gravity and comes to rest; the output is the input with
                                each piece moved rigidly (packed input stays packed: only anchors and instance transforms change).
  rbd_stack  {interval, order, lift}       the same, but pieces drop one at a time (every interval steps), each lifted
                                above whatever is already under it: give crates the SAME position and they pile up.
PIECES (input 0): every packed prim is one piece (copy_to_points {pack:true} or pack); its convex hull is computed once per
  source and shared by all instances (fast: 1,000 pieces in about 1–3 s). Polygons are grouped by pieces: auto = prim
  attribute piece, else copynum (unpacked copy_to_points), else name, else connected parts; or connectivity / name /
  attrib + piece_attrib. Points shared by two pieces are split. Pieces must NOT start inside each other or the ground
  (they are pushed apart violently; a warning counts them): lift the template points (transform translate [0, 1, 0]),
  space them (scatter min_distance), or use rbd_stack.
COLLISION (input 1): terrain mesh, heightfield, container, settled pieces from an earlier rbd node (merge them): exact
  triangles, static. Not connected: a ground plane at y = ground (ground_plane on adds it to input 1 too; connected but
  without polygons or heightfields: nothing to land on, with a warning).
ATTRIBUTES IN: active (prim or point int, default 1) = 0 → the piece stays put but others collide with it; v (m/s) and
  w (rad/s) on the points (anchors) = initial velocity. OUT (points; packed: anchors): v, w, settled (0/1), contacts
  (how many colliders touch it), group "fallen" (fell off the collision geometry; delete_fallen removes them).
PARAMS: collision_shape convex_hull | box | sphere | mesh (exact triangles, static pieces only); hull_points (64: hulls
  of smooth pieces are reduced, pieces may sink in by a few % of their radius; 0 = exact); friction 0.7, restitution 0,
  density, gravity; duration (s, upper bound: the simulation ends once every piece has stayed below sleep_threshold
  for 0.5 s), steps_per_second 60; angular_damping 0.5 (stops round pieces rolling forever) and rest_damping (damps
  pieces that are nearly at rest so wobbling ends); seed + jitter (a tiny random start offset/tilt that breaks
  perfectly symmetric stacks, deterministic); max_pieces guard; keep_packed.
DETERMINISTIC: same inputs + params + seed → the same result, bit for bit (Rapier's WASM build; bodies are inserted in
  a spatial order, so the input order does not matter). A different Rapier version may settle differently.
TIME: by default the node ignores the frame and shows the settled result on every frame. animate:true shows the
  simulation at (frame - start_frame) / fps seconds; cooking a later frame resumes the previous frame's world.
STATS: the build/inspect report lists steps, sim_time, pieces, settled, fallen per rbd node; warnings say when pieces
  started overlapping, fell off, or were still moving at the end (raise duration or angular_damping).
Example: rocks on a terrain, then a crate pile on the terrain and the settled rocks:
  "rocks": {"type":"copy_to_points","in":["rock","pts_lifted"],"params":{"pack":true}},
  "settled": {"type":"rbd_settle","in":["rocks","terrain"],"params":{"delete_fallen":true}},
  "ground2": {"type":"merge","in":["terrain","settled"]},
  "crates": {"type":"copy_to_points","in":["crate","same_spot_x16"],"params":{"pack":true}},
  "pile": {"type":"rbd_stack","in":["crates","ground2"],"params":{"interval":30}}   (examples/rbd_settle.json)`,

  pcg: `PCG: SCATTERING AND INSTANCING (Houdini scatter/copy toolkit, Unreal PCG point filters)
THE CHAIN
  mask (0..1 point attribute from features) → scatter {density_mask:"mask"} → orient (frames, random yaw/tilt/scale)
  → prune (overlaps, density, expression, keep-out geometry) → copy_to_points {pack:true, variants, variant_weights}
  → export glb (EXT_mesh_gpu_instancing) / usda (PointInstancer) / csv {pcg:true} (Unreal PCG point stream, help "export").
  Points carry everything as Houdini attributes: P, N, up, orient, pscale, scale, Cd, name, variant, seed, mask, cluster.
mask {by, min, max, falloff, ramp, invert, combine, name:"mask"}: v = feature; 1 inside [min, max], linear fade over falloff.
  by slope (degrees from up; default 0..30 = gentle) | height (metres along up) | curvature (1/m, + convex, − concave)
  | occlusion (0..1 AO, samples) | distance (metres to input 1: mesh, curve or points) | direction (degrees between N and
  direction) | noise (0..1, frequency, octaves) | attribute (source_attrib) | group (pattern) | inside (input 1 closed mesh;
  falloff = soft edge outside). combine replace | multiply (and) | max (or) | add | subtract | min with the existing mask.
  Chain masks: {by:"slope", max:25, falloff:10} → {by:"distance", min:5, max:1e9, falloff:3, combine:"multiply"} (input 1 = road).
  Point clouds without N take slope/direction/curvature/occlusion from the surface in input 1.
attribute_from_map {path, projection:"uv"|"xz"|"xy"|"yz", size, center, channel, remap, name}: PNG → point attribute
  (density maps, masks, Cd). xz = top view, image spans size × size around center (same layout as heightfield png16).
scatter: generate_by count (exactly count) | density (density × density_scale per m² × weight) | auto (legacy: density > 0 →
  density, else count). weight = density_attrib (point/vertex/prim, ≥ 0) × density_mask (0..1). relax (blue noise, follows
  the weights), relax_iterations (Lloyd-style push-apart on the surface), min_distance (exact), max_per_prim,
  emit_attributes ("*": point/vertex attributes interpolated, prim attributes copied; "^uv" excludes), write_primuv
  (sourceprimuv), write_seed (int seed). Curves: mode curve; volumes: mode volume.
  backend auto (default) uses WASM when already loaded, otherwise JS; kernel loads WASM, js forces the reference path.
  Elimination, ordered minimum-distance rejection (including per-prim caps), and surface relaxation have Rust kernels.
  min_distance can reduce the count; blue-noise elimination alone is not a hard separation constraint.
orient {mode, align_axis, upright, random_yaw, tilt, scale_min/max, scale_attrib}: writes orient + N + up (+Z = N, +Y = up,
  as copy_to_points reads them). mode normal_up (point N/up) | surface (normal of input 1; snap) | curve_tangent (nearest
  curve of input 1, rotation-minimising up) | direction | look_at (target) | random (axis, max_angle).
  Trees/rocks on terrain: {mode:"surface", align_axis:"y"} (up follows the slope) or {mode:"direction", random_yaw:[0,360]}
  (upright). Posts along a sloped road: {mode:"normal_up", upright:true} after points_along_curve.
points_along_curve {spacing | count | mode subdivision/at_points, start_offset, end_offset, jitter, side_offset, both_sides}:
  curveu, tangent = N, up (RMF), orient, curve_id, side; Unreal PCG Spline Sampler.
prune {mode}: overlap (spheres radius × pscale, priority largest | smallest | random | order | attribute: none overlap) |
  density (keep with probability attrib × fraction) | expression ("@mask<0.5" removed) | near_geometry (within distance
  of input 1, inside its closed polygons). invert keeps the others.
cluster {method kmeans (count, iterations) | radius, center, color}: int cluster per point; color:true for a debug render.
copy_to_points: variants "name"/"piece" + variant_attrib (exact pick) or variant_weights [3, 1, 1] (seeded weighted pick);
  scale_attrib (e.g. "mask": bigger where the mask is high), rotate_attrib (float yaw degrees, vec3 Euler, vec4 quaternion).
  pack:true for anything above a few thousand copies.
Houdini ↔ Unreal PCG: mask ≈ Density Filter inputs / Mask by Feature; scatter ≈ Surface/Spline/Volume Sampler; orient ≈
  Transform Points; prune ≈ Self Pruning / Density Filter / Difference; copy_to_points pack ≈ Static Mesh Spawner.
Example: examples/forest.json (30k candidates → pruned packed forest) and examples/pcg_scatter.json (road, lamps, rocks).`,

  curves: `CURVES (polylines and Bezier / NURBS spline prims)
straight_skeleton {mode skeleton|offset|roof, distance, pitch, pitch_attrib, height_cap, group}
  Closed XZ polygons with contained holes; skeleton outputs lines with prim kind (0 skeleton, 1 contour).
  offset uses positive distance inward and negative outward; roof uses degrees and prim edge provenance.
  WASM loads lazily through the host. topotopo/architecture/roof_skeleton is the roof on a footprint input, with overhang and thickness.
Polylines are open prims of points; closed curves are polygons (faces). Spline prims are Houdini's Bezier/NURBS curves:
  the prim's points are its CONTROL POINTS (CVs) and the curve is evaluated exactly wherever it is needed.
  bezier {points, order, closed, weights}   segments of order CVs sharing their ends: 7 CVs of order 4 = 2 cubic segments
                                            (CVs 0-3, 3-6); closed: segments × (order-1) CVs. order 4 = cubic.
  nurbs {points, order, closed, knots, parameterization, weights, fit}   clamped open curves start/end on their end CVs;
                                            fit:true passes THROUGH the points (CVs computed). knots [] = automatic.
  Attributes: prim spline_order, prim float[] knots (NURBS), point Pw (weights, default 1). Point attributes on CVs
  (Cd, width, pscale) blend along the curve with its basis weights.
Which nodes see the spline itself: transform and every deformer move the CVs (the curve follows, like Houdini);
  attribute/group/delete/merge/copy/wrangle/script/pack nodes work on the CV points; resample samples the TRUE curve
  evenly by arc length (treat_splines "control_polygon" = the CV hull); carve, ends, sweep, polywire, offset_curve_3d,
  project_curve, curve_attribs evaluate it themselves. EVERY OTHER node gets polylines automatically, with a warning
  "converted N spline curves to polylines for <node>" (adaptive: chords within 1/2000 of the curve size). To choose the
  resolution put convert_curve {to:"polyline", tolerance | segments per span} or resample before such nodes.
  render draws the evaluated curves; export writes polylines (json keeps splines).
Nodes:
  convert_curve {to: polyline|bezier|nurbs, order, fit, tolerance, segments}   spline → polyline evaluates; bezier ⇄
      nurbs is exact; polyline → spline uses the points as CVs, or passes through them with fit:true.
  spline_fit {tolerance | cv_count, smoothing, order, output nurbs|polyline}   least-squares NURBS through ordered points:
      denoise GPS-like / jittered polylines, compress dense curves (prim fit_error = largest deviation).
  curve {points, corner_radius, corner_segments}   corner_radius rounds corners as you draw: one radius, or one per point
      (0 = sharp), e.g. [0, 0.004, 0.004, 0]; a point that is not [x, y, z] (NaN, null) is an error naming it.
  fillet_curve {radius, type round|chamfer|bezier, segments, group (corner points), angle_min, clamp}   rounds polyline
      corners in 3D (new points in point group "fillet").
  offset_curve_3d {distance, lift, frame rmf|plane, up, corner mitre|round|bevel, both}   parallel curves in 3D:
      rails, kerbs, lanes (both:true = two rails, prim side ±1; frame "plane" keeps them level). offset_curve is the
      2D (Clipper) grow/shrink of CLOSED flat shapes; on a flat OPEN path it makes a strap outline (width 2 × distance,
      cap butt|round|square): offset_curve → extrude for a flat band; sweep {shape:"rect", size:[w, h]} for one that
      follows a 3D path.
  loft {sections, resample auto|length|none, caps}   skins through the curves in prim order, or through copies of ONE
      profile placed by sections [{offset, scale, rotate}, ...]; sections with the same point count join point to point
      (insets keep their corners), closed sections are turned to the first one's winding; closed results face outward.
  revolve {axis, origin, angle}   lathe about any axis line; draw the profile in a plane that holds the axis.
  shape2d capsule | slot   a stadium (rect with half-circle ends) in size; extrude for a slot cutter.
  project_curve (curves, surface | heightfield) {mode direction|closest, direction, spacing, lift, misses}   drapes a
      curve onto terrain; spacing resamples first so it follows the bumps; writes point hit and N (smooth normals).
  curve_attribs {curveu, arclength, tangent (tangentu), frame (N = tangent, up), curvature, segment, ramp_attrib + ramp}
      e.g. ramp_attrib "width" + ramp [[0,0.3],[1,0.05]] → polywire tapers; frame:true → copy_to_points aligns copies.
Recipes:
  Road on terrain: nurbs {points, fit:true} → project_curve (terrain) {spacing:0.3, lift:0.1} → wrangle "@up = @N;"
    → sweep {shape:"ribbon", radius:1.2}. (On a heightfield: heightfield_path cuts the road into the terrain.)
  Handrails: curve (corners) → fillet_curve {radius:1.5} → offset_curve_3d {distance:0.7, lift:0.9, both:true,
    frame:"plane"} → sweep {radius:0.04}; posts: resample the rails {length:1.5} → copy_to_points a thin box.
  Letter / logo outline: bezier {closed:true, points} (+ inner contours for holes) → convert_curve → extrude.
  Cable with sag: nurbs {points:[a, mid lowered, b]} → resample {length:0.05} → polywire; taper with curve_attribs.
See examples/splines.json.`,

  particles: `PARTICLES (Houdini POP network in one node; category "sim")
{"type":"particles","in":["emitter","collision","field"],"params":{...}}: inputs 1 and 2 are optional.
EMIT: every point of input 0 emits emit_rate particles per step (0.25 = one every 4 steps; per-point random phase);
  emit_all: one per point at time 0 (emit_rate 0 = a single burst). Start velocity = point v + speed × point N (+Y without N)
  + a random vector up to velocity_var. Point attributes and groups (Cd, pscale, custom) are copied at birth; a point id seeds
  that point's random stream. life (s, 0 = forever) ± life_var; max_particles caps the particles holding a slot (birth to end of life);
  max_births (guard, 1,000,000) caps the births of one step and the births held at once (runs are simulated in batches).
FORCES (per step, dt = 1/(fps × substeps)): gravity; noise (m/s², noise_size m, curl:true = divergence-free swirls, noise_octaves);
  drag pulls the velocity toward the air velocity = wind + air fields (wind does nothing without drag); attract (spring 1/s²)
  to attract_point or, with attract_to:"surface", to the closest point of input 1.
FIELD (input 2): points with v (field_sample nearest | idw over field_neighbours, field_max_distance), a heightfield
  (-gradient of height: flows downhill) or an SDF volume (-gradient of the distance: toward the surface); field_mode force (an
  acceleration, × field_scale) or air (adds to the air velocity, acts through drag).
COLLIDE: floor:true (+ floor_height) and the polygons / heightfields of input 1; collide none | die | slide | bounce (bounce 0..1,
  friction = Coulomb μ). Particles collide as points (a 1e-5 × scene-size skin off the surface) or, use_pscale, as spheres.
OUTPUT: points with P v age life id (birth order) pscale + carried attributes; trails N (>= 2) keeps the last N positions per
  particle as an open polyline (point age at that position, curveu 0 tail → 1 head, prim id); output both | points | trails.
TIME: a cook at start_frame (default 1) runs "steps" steps; frame f runs steps + (f - start_frame) × substeps, each frame's state
  cached (stepping forward runs one frame; jumping back re-simulates from the latest cached earlier frame or the start).
  animate:false = always "steps" steps, time-independent. Same bits with or without the worker pool and however it is stepped.
RECIPES: fountain = one point, speed 6, velocity_var 1.3, life 3, floor:true, collide bounce, trails 6. Runoff on terrain =
  emitters scattered on ridges (heightfield_mask_by_feature curvature convex + heightfield_scatter), the heightfield as input 1
  and 2 (field_scale 3, drag 1.4), noise 4 curl, collide slide, trails 40 output trails, color ramp by age
  (examples/particles.json). Sparks: emit_all burst, velocity_var 5, life 0.5 ± 0.3, drag 1. Swarm on a mesh: attract_to surface.`,

  assets: `ASSETS (reusable custom nodes, like HDAs)
Any graph with vars can be saved as a node type: assets {action:"save", name:"rock_cluster", from_graph:"main"}.
The graph's vars become parameters (add "params": {"var": {"desc": "...", "min": 0, "max": 1}} for docs/ranges).
Inputs: put {"type":"input","params":{"index":0,"label":"surface"}} nodes in the graph.
Then use it like any node: {"type": "rock_cluster", "in": ["terrain"], "params": {"count": 50}}.
Assets are stored as JSON in the project's assets/ folder and load on startup; list, get and delete work on them.
Ready-made generators are TopoTopo's own packages, used by full name (help topic "packages"): walls, houses, roofs,
stairs, rocks, trees, props and roads such as {"type": "topotopo/architecture/stairs", "params": {"steps": 12}}. To
change one: assets {action:"fork", name:"topotopo/architecture/stairs", to:"my_stairs"} copies the output's graph into
the project's assets as my_stairs (an output whose graph names the kit's other outputs adds the kit to the project);
assets {action:"get", name:"my_stairs"} shows it, assets {action:"save", name:"my_stairs", graph} writes it back, and
{"type": "my_stairs"} uses it.`,

  packages: `PACKAGES (a project uses another project's published outputs by name)
A package is a project with a full name and published versions. Its author names it once in project.json, "package":
"owner/name" (lower-case letters, digits, - and _; the owner "topotopo" is reserved for TopoTopo's own), and publishes:
  library {action:"publish", dry_run:true}               CLI: topotopo publish [folder] --dry-run
  library {action:"publish", note:"taller pines"}        CLI: topotopo publish [folder] --note "taller pines" [--big]
Publishing is permanent: run the dry run, show it to the person, and publish when they say so.
A graph uses an output of a package as a node type; "owner/name" alone is the package's default output:
  {"type": "studio/trees/pine", "in": ["ground"], "params": {"height": 6}}      {"type": "studio/trees"}
Its params are the vars of the output's graph that its node reads, with their "params" declarations (ranges clamp,
options are checked), and its inputs that graph's input nodes. help {nodes:["studio/trees/pine"]} gives them with the
version and its note, also for an output search found in a library the project lists but does not use yet (read there,
nothing copied); catalog {category:"package"} lists the outputs of the packages the project uses and TopoTopo's own.

WHAT A PACKAGE PUBLISHES: every named output ("outputs") of every graph in graphs/ but those marked "publish": false
(viewer-only previews), and the default output: the output node ("output") of the graph project.json shows ("graph"),
which must be set. Output names follow the same rule as the package name and are unique in the package. A graph that
holds several outputs gives each the vars its node reads: publishing warns about an output that does not read some of
its graph's vars (they are not its params; give it a graph of its own for params of its own).

WHAT AN OUTPUT IS: its kind, its tags and its description, which search, the catalog and help show.
  "outputs": {"pine": {"node": "out", "label": "Pine", "kind": "mesh", "tags": ["conifer", "low-poly"], "description": "…"}}
- kind: mesh, instances (packed), points, curves, terrain (heightfields), textures (images alone), material (materials
  and their maps, no geometry: help topic "materials"), volume, or scene (several of these: a street with its lamp
  posts as instances). A mesh that carries scene_null sockets is a mesh: the
  sockets are part of a mesh asset, and scene means several kinds of geometry together. Publishing cooks every output
  and records the kind it cooks to. "kind" pins it: publishing blocks when the output cooks to another, and build, edit
  and the viewer warn before that. A kind not on the list is an error wherever the graph is read.
- tags: free words search finds the output by: lower-case letters, digits and -, starting with a letter or digit, at
  most 64 characters, at most 16 per output, each once ("low-poly", "street-furniture"); a malformed one is an error. A
  project's own "tags" in project.json stay the Gallery's; search matches both.
- description: the output's "description", else its graph's "description" (a kit's outputs, one graph each, need no
  more). The default output carries the tags and description of the named output it is, if any.
Every listing says an output's kind and tags the same way: mesh [conifer, low-poly].

OUTPUTS OF THE SAME PACKAGE: a package's graphs and assets name its own outputs by full name, as any project does: a kit
whose pieces build on each other, a house of the kit's walls ({"type": "studio/kit/wall"} in the house's graph). They
resolve to the same version, with no entry in "uses"; in the project that is the package, to its graphs as they are now
(its working folder), and in a followed working folder to that folder. Outputs that name each other in a loop (a names
b and b names a, or a names itself) do not resolve, and publishing refuses them.

VERSIONS: big.small from 1.0, each a folder versions/<version>/ in the package that is never written over: project.json,
graphs/, assets/, inputs/, the copies the package uses (packages/) and version.json (the note, the time, a hash of every
other file, each output's graph, node, kind, tags, description, params and inputs). The hash reads text files with LF
line ends, so a checkout that turns them into CRLF changes nothing; binary files count as they are. exports/,
attachments/ and other files are not part of a version. The number comes from the version before: big (2.0) when
something a user relies on goes away or means something else (an output removed, renamed or marked "publish": false;
an output of another kind; a param removed, renamed or of another type; a narrower range; a removed option; an input
removed or moved), small (1.4) for everything else (new outputs, params, options and inputs, wider ranges, other
defaults, labels, tags, descriptions, a kind pinned or unpinned that stays the same, any change to the geometry).
big:true (--big) marks a version big when its meaning changed in a way the tools cannot see (a model that now faces
another way).
PUBLISHING goes in steps and stops at the first that blocks, so each problem is said once, at its cause, and a version
number only for what would publish: (1) what the project declares: its name, the note, its outputs (names, kinds,
tags, descriptions, clashes, the default output), loops, files it cannot read, its copies (none missing or edited by
hand), a package this session follows; (2) every output cooked as a project that uses the package cooks it, in the
package's own scope: one that does not cook, cooks to nothing or to another kind than pinned blocks; a warning is said
once, under the output it belongs to (not again under a line-up that cooks it); (3) nothing changed since the last
version blocks; (4) the number, the changes and the warnings: an output without tags or a description, one that does
not read some of its graph's vars, an output of another kind than before, URLs and files outside the package that its
nodes read (a version holds no copy of them) and a version above 50 MB. A DRY RUN, library {action:"publish",
dry_run:true, note?, big?} (CLI: topotopo publish --dry-run), goes through every step and writes nothing.

USING PACKAGES: project.json "uses" holds the version the project uses of each ({"studio/trees": "1.3"}), and packages/
its own copy of each, and of the packages those use, flat: packages/<owner>/<name>/<version>/, each version once, with
packages/lock.json (each copy's hash, the library it came from, its own uses). The copies are committed with the project,
so it cooks anywhere without the libraries, and what it uses never changes by itself; a copy edited by hand is warned
about, and the warning goes once the copy is restored. init writes a .gitattributes that keeps versions/ and packages/
byte for byte, and a .gitignore for packages/.cache.json (the hashes of the copies' files, kept between runs) and
packages/.lock (held while a command, the viewer or an MCP server writes project.json and the lock).
IN A WORKSPACE (a game's folder with topotopo-workspace.json; CLI: topotopo workspace init): its projects share one copy
of each package version, in topotopo-packages/ beside that file, whose "uses" names the version the whole game uses.
A first use in any of its projects adds the package there; Update compares every place every project uses it and
changes them all; remove is refused while a project still names it. A project that is a package keeps its own "uses"
and copies, which are published with it. workspace init moves the copies of the projects inside that kept their own
(two projects that used different versions get the newer, said).
LIBRARIES: a project finds packages only in the libraries its project.json lists, "libraries": ["../shared/library",
"game"]: a path written from the project ("./lib", "../lib") for a library in the same repository (every checkout and
worktree uses its own), else a registered library's name. An entry that does not work (no such folder, a name not
registered, a package's folder instead of its library's) is reported, and the others still count. A library with a
library.json ({"name": "game-materials"}) goes by that name in the lock and the listings. The tools never list
a library by themselves: library {action:"set", libraries:[...]} (CLI: topotopo libraries add|remove) does it when the
person names one. Besides those, every project looks in TopoTopo's built-in library, "topotopo" (no other library takes
that name): it holds TopoTopo's own packages (owner "topotopo"), which a project uses, copies and locks like any other;
a newer version a TopoTopo release brings shows as an update. Only a project's graphs use packages: in a folder that
is none, naming one fails and says so, and library {action:"init"} (CLI: topotopo init) makes it a project, when the
person says so.
- First use: a build or edit whose graph names a package the project does not use yet adds its newest version once the
  graph validates (a graph they reject adds nothing and writes nothing), and the response says so. A dry run (build
  {dry_run:true}) checks the graph against that version, read where its library holds it, copies and writes nothing,
  and a note says what build or edit would add. A graph-file cook (topotopo graph.json) adds it too and says so;
  --locked fails instead, for a build machine. library {action:"use", package:"studio/trees", version?} (CLI: topotopo
  use studio/trees [--version 1.1]) adds one explicitly; library {action:"remove", package} (CLI: topotopo remove) drops
  one no graph of the project names any more, with the copies nothing else uses.
- library {action:"packages"} (CLI: topotopo packages) lists what the project uses, one line each (version, outputs, up
  to date or "1.3 is out"), the other packages in its libraries, the libraries, and what it could not check;
  {action:"packages", package:"studio/trees"} (CLI: topotopo packages studio/trees) shows one package: its versions and
  notes, its outputs with their kinds, tags, params and inputs.
- A package output cooks in its version's own scope: its own assets, graphs (graph_ref) and files (relative paths read
  the version's folder) and the versions it uses. Nothing leaks either way, and two versions of one package (one the
  project uses, one another package uses) cook side by side. Its result names the version's texture files by paths
  relative to the project's folder (absolute only for a followed working folder outside the project), so exports name
  no folder of this machine.
- Errors never guess: a package not in "uses" says how to add it, an unknown output lists the package's outputs, a
  missing copy says which and which package's use copies it again, and a package found only in a registered library
  the project does not list names that library and the entry that lists it.

SEARCH: library {action:"search", query?, kind?, tag?} (CLI: topotopo search [words] [folder] --kind k --tag t, the
folder written as a path: ., ./forest, ../forest) looks through the newest version of every package in TopoTopo's
built-in library, the libraries the project lists and every library registered on the machine. Every word of query
must start a word of an output's full name, label, description or tags, or of its package's title or project tags
("tree" finds trees, not topotopo/street); kind and tag match exactly: {query:"conifer"}, {kind:"terrain"},
{query:"brick", tag:"masonry"}. Results come by library, the project's own first (those it lists, then TopoTopo's
built-in library), each with its full name, kind, tags, label, version and description, and say whether the project can
use it: TopoTopo's own packages and those of a library it lists, yes (a graph that names one adds it); another
library's only once its project.json lists it, and the result says the entry that lists it.

TOPOTOPO'S OWN PACKAGES: four kits in TopoTopo's built-in library, every one a package of the owner "topotopo"; their
outputs are listed by the catalog (category "package") and help even where the project does not use them yet:
  topotopo/architecture  wall_segment window_frame door_frame house stairs spiral_stairs railing pillar arch roof_gable
                         roof_hip roof_skeleton brick_wall tile_floor hex_grid_floor scaffold beam_truss
  topotopo/nature        rock cliff_block tree_lowpoly bush log forest_patch grass_clumps scatter_rocks
  topotopo/props         crate barrel pallet sandbag_wall pipe_run
  topotopo/street        road_strip lamp_post bollard bench sign_post fence cable
  {"type": "topotopo/architecture/stairs", "params": {"steps": 12, "style": "open"}}   {"type": "topotopo/nature/rock"}
  A kit's name alone ("topotopo/nature"), or its output "kit", is its default output: its outputs side by side. Every
  output has a pinned kind (mesh; instances for scatter_rocks, forest_patch and grass_clumps; the nature kit's line-up a
  scene) and tags (search {tag:"street-furniture"}, {query:"conifer"}, {tag:"low-poly"}). Pivots sit at the base (y = 0,
  Y up, metres; walls start at x = 0, roofs at the wall top); every piece has prim name and material. Outputs that
  follow a curve (railing, fence, pipe_run, road_strip) take the curve as input 0, those that dress a surface
  (scatter_rocks, forest_patch, grass_clumps) the surface; unconnected they build a default one. Those three output
  packed instances. A kit's pieces build on each other (house is the kit's wall_segment and roof_skeleton). The first
  use copies the kit into the project like any package, and a newer version a TopoTopo release brings shows as an
  update. In an installed TopoTopo they have no working folder to follow; TopoTopo's repository publishes them.

FOLLOWING, for one session: library {action:"follow", package:"studio/trees", on:true} (CLI: --follow studio/trees on a
graph cook or topotopo view) shows the package's working folder in the project's libraries instead of its copy, until
on:false or the end of the session; nothing about it is saved. Every edit there re-cooks. Following is for looking
(the viewer, renders, inspect): exports and publishing use the published copy, and an export made while following
says which published version it used. A workspace with "follow": true (topotopo workspace init --follow) follows its
own packages this way, those whose working folder is inside it. Other packages' versions keep the copies they hold.

OUT OF DATE AND UPDATE: what a project uses changes only by an update, after a before/after.
- library {action:"outdated"} (CLI: topotopo outdated) lists the packages the project uses that have newer versions:
  the newer versions with their notes (and their outputs of another kind), one line for those up to date, what it could
  not check, and the update to run for each.
- library {action:"update", package:"studio/trees", to?} (CLI: topotopo update studio/trees [--to 2.0]) is the
  before/after: every place the project uses the package (each node of its type in graphs/, assets/ and the graph files
  in the project's folder, nested graphs included, with its params and inputs as they are) cooked with the version in
  use and with the new one; what changed in each (counts, size, attributes, the largest move) with an overlay render
  (grey the same, blue only with the new version, orange only with the old); the notes of the versions between. Without
  "to" it goes to the newest version with the same big number (none newer is no failure: it says so). A big version is
  named with "to", and the before/after then lists what the graphs must change, place by place: params they set that it
  no longer has (with did-you-mean), values its narrower range clamps, options it no longer has, outputs they use and
  inputs they wire that are gone. The new version is read where its library holds it: nothing is written. It says how
  far it is, stops when the call is cancelled (CLI: Ctrl+C) and reuses what was cooked before.
- Show the before/after to the person and apply it only when they say so, naming the versions it showed:
  {action:"update", package, from, to, apply:true} (CLI: the command the before/after ends with, --from 1.3 --to 1.4
  --apply) copies the new version in with the versions it uses, sets "uses" and the lock, and deletes the copies
  nothing uses any more. It is refused when project.json uses another version by then. After a big update the graphs
  report what they must change until they do.

IN THE VIEWER (preview, topotopo edit, topotopo view on a graph in a project): the Packages tab, in every project, has
Find packages (TopoTopo's kits and every library) and a box per package used: the version in use with a badge (up to
date, update available, live), the nodes that use it, its outputs with their kinds and tags (those in use marked), and
Update only when a newer version exists. The Scene tree marks the nodes of a package with an update or a live folder.
The card of an output that cooks to another kind than its "kind" says so. Update first compares every place with the
version in use (a) and the new one (b), its progress in the cook line and Stop; a place shows alone in the view as a,
as b or both overlaid, with what changed in a line; it applies only when the person confirms, and a big version whose
graphs must change asks once more and gives the person a line to copy for you. "Source: Published | Live folder" shows
a package's working folder for the viewer's session (never saved; not offered for TopoTopo's kits outside TopoTopo's
repository); results that use it are marked as showing unpublished edits, their exports and downloads write the
published version, and a save in a working folder
the session does not follow is offered in that package's box.

EXPORTS record the package versions their graph used in the source block: "packages": {"studio/trees@1.3": "<hash>"}.

THE CLI COMMANDS (a folder named must exist; without one, the current folder's project):
${PACKAGE_COMMANDS.map((c) => `  topotopo ${c.usage}\n      ${c.what}`).join('\n')}`,
  uv: `UV TOOLKIT (uv = vertex attribute (u, v, 0); seams are edges where the corner uv differs)
Which node:
  uv_project   planar/box/cylindrical/spherical projection. Fast, no packing (uv = position / scale, over many tiles):
               tiling textures, boxes. box: each polygon along the axis its normal is closest to (X faces u = z, v = y;
               Y faces u = x, v = z; Z faces u = x, v = y); both sides of an axis share it, so faces looking along +X,
               +Y and -Z are MIRRORED (text reads backwards; inspect uv counts them) and -X, -Y, +Z read right.
  uv_unwrap    automatic (xatlas): cuts charts by angle/cost, flattens and packs into 0..1. Default for props and
               hard-surface. Keeps polygons; writes prim chart. Each connected piece is charted on its own; polygons
               xatlas cuts across charts become triangles (exact uv); faces with no area collapse onto a neighbour's
               chart (never to uv 0,0); folded charts are charted again or cut; thin charts (bevel strips) join a
               neighbour (merge_thin); charts longer than the tile, rings and arcs are cut when that packs denser
               (cut_long). The result is checked and warnings name the part. use_seams:true keeps existing seams.
               Big smooth meshes chart slowly: max_chart_area -1 (auto) caps chart size above ~1000 triangles; a higher
               max_cost makes fewer, larger charts (less space lost to padding).
  uv_flatten   LSCM (conformal) per chart, charts bounded by YOUR seams: uv discontinuities (use_seams), the
               "seams" edge group, point pairs ({"seams": [[a,b],[b,c]]}), a prim chart attribute, the group border.
               Closed charts / handles are cut open automatically (cut_closed). pins: [a,b] fixes orientation.
  uv_autoseam  experimental: proposes charts (xatlas or normal clustering) → prim chart + point seam; then uv_flatten.
  uv_layout    (re)pack islands without overlaps: island_attrib "chart" packs by chart; writes prim island. Islands that
               do not fit at any scale leave the uv unchanged, with a warning (never a silent overlap).
  uv_transform translate/scale/rotate existing uv.
Packing (uv_unwrap and uv_layout): islands on the texel grid of resolution, padding texels apart (half of it to the tile
  border), uniform texel density (uv area ∝ 3D area), every gap filled (inside rings, between arms).
  orient: min_rect (densest; 90° turns allowed) | world (world up +Y → +v, horizontal islands +X → +u; no turns) |
    keep (as it is; no turns). Rotations never mirror.
  texel_weight: a prim float attribute scaling density per island (2 = twice the texels per metre; <= 0 counts as 1):
    attrib_create {name:"texel_weight", class:"prim", value:2, group:"@name=sight"} gives the sight more texels.
  texels_per_unit (0 = largest that fits) with fit: atlas (default: everything in 0..1, the density lowered if needed,
    with a warning) | udim (keep the density, spill into tiles 1001, 1002 …; uv_layout up to udims) | stack (uv_unwrap:
    more atlases, all in 0..1, prim atlas).
Rails, ladders, pipes (long thin parts): orient min_rect lays each strip along the tile and the packer stacks the strips
  side by side, filling the gaps with small charts; leave cut_long on (a chart longer than the tile is cut into parts)
  and merge_thin on (bevel strips join the face beside them). Every chart loses a padding border, so fewer, wider charts
  fill more: unwrap with a higher max_cost, or give a part your own seams (use_seams). inspect uv names the lowest and
  highest density charts: compare them to spot a part that came out too coarse.
Typical: geo → uv_unwrap → render {views:"quad_uv", checker:true}.  Manual: delete uv → uv_flatten {seams:[...]} → uv_layout.
LODs: decimate / lod after uv_unwrap keep the uv free of folds (keep_uv, default on: where a collapse would fold the uv
  they reduce in steps around it, so a level can stop above its target; the warning names the parts). The full
  reduction: reduce first, then uv_unwrap each level.
SEE IT: render views "uv" (or "quad_uv" = persp + uv): the 0..1 square with a 0.1 grid and UDIM labels, polygons filled
by chart/island colour, island borders yellow, overlapping uv in RED (footer/notes give the overlap %); overlap that is
expected is amber: charts of a repeating texture (they run across tile borders: the label says TILING) and LODs that
share the uv space (prim names ending _lod0, _lod1 …).
render checker:true shades 3D views with an 8×8 uv checker: squares should look square and equal-sized
(stretch = rectangles, density = cell size, mirrored charts flip the red/green gradient).
MEASURE IT: inspect {detail:"uv", resolution:1024, json:true}: exact overlaps (triangle pairs with the part and world
position of each, and their areas; folds inside one chart included; shared edges are not overlaps), split into
overlap.inTile (between atlas charts, each inside one tile: what a bake suffers), overlap.tiling (a chart runs across
tile borders, as uv_project over many tiles does: a repeating texture, flagged tiling:true; expected) and
overlap.acrossLods (prims named _lod0 / _lod1 … share the uv space on purpose); collapsed / non-finite / out-of-tile
triangles (the first one named with its position), UDIM tiles, charts, mirrored triangles, utilization (exact for a
clean atlas in 0..1, else a labelled raster ESTIMATE; tileUtilization per UDIM tile), texel density (density: overall,
per chart 5 % / median / 95 %, the lowest and highest chart and where; texels/m with a resolution) and per-piece
(prim "name") surface, uv area and texel density. An analysis that hits its bounds says INCOMPLETE.
CLI: --inspect uv --uv-resolution 1024 [--json].
Export: uv → glTF TEXCOORD_0 (v flipped), OBJ vt, USD primvars:st.`,

  render: `RENDER (pick the overlay that answers your question; everything is off by default)
render {node?, views, …} returns a PNG; build/edit take the same options as render:{…}. The footer names the active
overlays and notes pieces, open edges and back-facing % (also returned as text notes).
VIEWS: "quad" (persp/front/right/top, default) · "turntable" (persp at azimuth 0/90/180/270) · "quad_uv" · a list of
  persp, front, back, left, right, top, bottom, uv, section, texture, persp@<azimuth>, and the three-quarter views
  front_left, front_right, back_left, back_right (persp at azimuth -45, 45, -135, 135).
  "texture" draws images flat (texture:"<image>" | "image/layer" | "<material>" picks; a geometry holding only images
  renders as it by default); textures:true shows base colour maps on the mesh. Help topic "textures".
FRAMING: every 3D view fits the bounds: the bbox corners fill the view with a small margin, so nothing is cropped.
  azimuth: degrees around +Y; 0 = the camera on +Z looking at the front, 90 = on +X (the right side), 180 = the back,
    -90 = the left; default 35. elevation: degrees above the horizon (default 25; 90 looks straight down).
    e.g. render {views:"persp", azimuth:-90, elevation:10} looks at the left side from just above.
  zoom: relative to the fit (1 = fit, 0.5 = half size). Above 1 it magnifies around look_at and crops, so it only
    applies with look_at (or ortho_scale); without them it is held at 1 and a note says so.
  look_at: [x, y, z] in world metres (x right, y up, z towards the front; Y-up like everything else); the view centres
    on it and still fits the bounds around it. e.g. render {views:"persp", look_at:[0.6, 0.15, 0], zoom:4} (a muzzle).
  ortho_scale: the world width in metres across an ortho or section view (default: fit the bounds).
    e.g. render {views:"front", ortho_scale:0.5} shows 50 cm across the front view, at any size.
  size: pixels per view, n or "WxH": size:"1600x600" gives wide views a long prop fills (the fit follows the aspect);
    scale 2 makes a 2× image.
BACKGROUND: transparent:true gives a PNG with alpha (background pixels 0; no ground grid or axis gizmo; the footer
  stays). grid:false drops the persp ground grid. underlay:"inputs/side.png" draws a reference image (PNG, relative to
  the project) behind the 3D views at underlay_opacity (default 0.5); underlay_fit "bounds" (default: fitted into the
  rectangle the bounds cover in that view, keeping its aspect, so a reference cropped to the object lines up with it),
  "width" / "height" (its width or height spans the bounds'), "view" (the whole view). Pick the view that matches the
  picture: render {views:"front", underlay:"inputs/side.png", size:"1600x500"}.
SOCKETS: sockets:true draws scene empties (scene_null: attachment points) as dots with their name and orient axes
  (X red, Y green, Z blue), through the surface. pbr renders hide empties unless sockets is set.
QUESTION → OPTION
  How dense / clean is the topology? Where are the triangles, poles, slivers?  wireframe:"all" (every edge, 1 px)
  Which edges are creases?                         wireframe:"hard" (dihedral > hard_angle, default 30) + crease/hard/sharp edge groups
  Is it watertight? Where are holes, non-manifold edges, winding flips?  wireframe:"boundary" (pink open, yellow non-manifold, violet flipped)
  What do my edge groups contain?                  wireframe:"groups" (one colour per edge group, legend)
  What is inside? How thick are the walls? Do parts overlap?  views:["persp","section"] + section_axis x|y|z, section_offset
                   (bbox fraction, default 0.5; section_absolute:true = coordinate). The cut is filled RED; BLUE = an inside-out
                   (flipped) solid; open sheets show as yellow lines; the far half is ghosted. Cavities stay empty.
                   clip:{axis, offset} cuts the persp view instead, removing the camera's side (cap:false shows the inside).
  Which way do normals / up / velocities / instances point?  glyphs:"N" | "up" | "v" | "orient" | "custom" (glyph_attrib),
                   glyph_scale (default 5% of the bbox diagonal), max_glyphs (default 400, evenly subsampled). Lines start on
                   the surface with a bright tip; parts behind the surface are dimmed. orient: X red, Y green, Z blue.
                   N missing → computed face normals. Flipped normals: glyphs point into the surface (dimmed) + blue faces.
  Which group is which? What is where?             label_groups:true (names on the group, prim-group borders and group points in
                   the label colour, legend with counts) · label_pieces:true (#0, #1 … connected pieces) · label_attrib:"name"
                   (each distinct value of a string/int attribute) · point_numbers / prim_numbers (visible ones, first max_labels)
  What do the colours mean?                        color_by + legend:true (gradient bar with min/max, or categorical swatches)
  What shape is it?                                shading:"matcap" (clay, reads form) · "ao" (ambient occlusion: creases and
                   cavities darken; ao_radius px) · "flat" (facets, ignores N)
  How do the materials read? Roughness, metal, maps?  shading:"pbr": the metallic-roughness material glTF export writes
                   (base colour map × vertex colour, tangent-space normal map in the exported MikkTSpace frame, orm or
                   roughness map, metallic, emissive, unlit) under a fixed camera-relative studio rig (key, fill, rim and a
                   sky/ground environment), GGX specular, ACES, exposure (stops, default 0). Deterministic: the same graph
                   gives the same PNG. Texture files are read from disk; transparency is not evaluated (shaded opaque,
                   with a note), nor are missing or non-PNG maps (named in the notes). color_by and highlight tint
                   the shaded material (the attribute colour lit by the material's brightness); checker is not shown.
POLYGON EDGES: wireframe "auto" (the default) draws polygon edges on meshes under 6,000 polygons, never under shading
  "pbr" or textures:true (they would read as marks in the material); the footer says EDGES AUTO when it draws them.
  wireframe:false hides them, true draws them always.
Labels never overlap: ones without room are skipped (note says how many; raise size or lower max_labels).
view_labels:false drops each view's name label and the persp axis gizmo (clean thumbnails, e.g. those of TopoTopo's own packages).
Heightfields draw at most heightfield_res quads per side (default 256; "full" = every sample): a larger field is
  drawn decimated (a 513 × 513 field at 257 × 257) and the footer and a note say so. They show the mask in red;
  heightfield_layer:"flow" shows another layer (0..1 layers as they are, others from their min to their max, named
  in the legend) and "none" none.
Examples: render {views:["persp","section"], section_axis:"z", wireframe:"hard", label_groups:true}
          render {views:"turntable", shading:"matcap"} · render {glyphs:"N", clip:{axis:"x", offset:0.5}}
CLI: several renders per cook: the options after a --render apply to that render, up to the next --render; options before the
  first --render apply to every render. Example: both renders 1200x600; side.png the front view over the reference,
  beauty.png a pbr three-quarter view:
    topotopo g.json --size 1200x600 --render side.png --views front --underlay ref.png --render beauty.png --views front_left --shading pbr
CLI: --wireframe all --section y:0.5 --clip x:0.5 --glyphs N --labels groups,pieces --shading matcap --legend --size 1600 --scale 2
  --shading pbr --exposure 0.5 --views front_left --size 1600x600 --transparent --no-grid --sockets
  --azimuth -90 --elevation 10 --look-at 0.6,0.15,0 --zoom 4 --ortho-scale 0.5
  --underlay ref.png --underlay-opacity 0.6 --underlay-fit width (CLI paths are relative to the current folder)
  --no-view-labels --heightfield-res full --heightfield-layer flow`,

  export: `EXPORT
export {output:"crate"} / export {} (the default output) / export {all:true}: the graph's export targets (help topic
  "graph": "export" on the graph or an output), written inside exports/, the same files the viewer's Export buttons write.
PATHS: one rule for the CLI, the MCP server and the viewer: relative paths inside a graph (file nodes, material maps,
  image files) read from its project folder, the nearest folder with a project.json at or above the graph file, else
  the graph file's folder (MCP: the server's folder); exports/ is that project's (a graph in <project>/graphs/ exports into
  <project>/exports/, never beside itself), and exports/.outputs.json records the files by their project paths. The
  CLI's own --render / --export / --underlay paths are relative to the current folder.
export {path:"exports/thing.glb"} — format from the extension:
  glb / gltf    glTF 2.0 via gltf-transform (recommended for Unreal, Blender, web)
  geo           Houdini JSON geometry: every attribute (all classes), group and polyline, lossless (precision 64 or 32)
  csv           point stream, one row per point: P.x,P.y,P.z,N.x,…,pscale,name (strings quoted); prims are ignored
  points.json   {format:"topotopo-points", count, attributes:{P:{type,size,data}}} (same schema on import)
  obj usda ply stl json (lossless topotopo)
  textures      format:"textures", path = a folder: every image volume as <image>.png (help topic "textures")
Options: up_axis "y" (default) | "z", scale (100 = m → cm), split_by_name (one mesh per prim "name", default true),
  custom_attribs (extra numeric attributes: default off for glb / gltf / usda and the GLBs of instance rows and bundles,
  on for ply; below), materials (default true), vertex_colors (glTF, default false: prims with a named material are
  written in that material, their Cd dropped; true keeps Cd as COLOR_0 there too, below), compress "none" | "meshopt" (EXT_meshopt_compression + KHR_mesh_quantization,
  ~3× smaller; for web engines such as three.js/Babylon.js) | "draco" (only with the optional draco3dgltf package),
  quantize (KHR_mesh_quantization alone), tangents "auto" | "preserve" | "none" (glTF TANGENT, below), attributes ["P","pscale",…] (csv / points.json), pcg / pcg_struct (csv),
  precision 64 | 32 (geo), instancing "packed" | "expand", instances "rows" | "expand" (csv / points.json of packed
  prims), meshes (instance rows: also write one GLB per source, default true). For Unreal and Blender keep the default
  uncompressed GLB.
SOURCE: every export (export tool, export targets and the viewer's Export and Download buttons, the CLI's --export and
  --export-all) records how it was made, so it can be made again: a "source" block {graph, graph_sha256 (SHA-256 of the graph JSON as
  cooked: vars after overrides, keys sorted, no whitespace), output (a named output, else null), node, frame, fps, vars
  (all of them, after overrides), seeds (the seed params the graph sets, by node: "loop/pts" inside a body, as written),
  export: {format, options: every option the format reads, the given ones and the defaults of the rest}, topotopo (the
  version)}. png16 / r16 carry it in their .json sidecar, csv / points.json
  instance rows in <name>.meshes.json, unreal_landscape in landscape.json; every other export writes <file>.source.json
  next to the file ({format:"topotopo-export-source", version, files, source}; a textures folder: source.json inside
  it), and glb / gltf also carry it in asset.extras.source. Nothing in it depends on the time or the machine: the same
  graph, values and options give the same bytes, and a later version changing a default does not change what the
  record replays. Replay on the command line: topotopo <graph>.json --output <output> (or --node <node>) --frame <frame>
  --fps <fps>, one --var <name>=<value as JSON> per var, --format <format>, every option as its flag (up_axis "z" →
  --up-axis z, custom_attribs false → --no-custom-attribs, layers ["a","b"] → --layers a,b) and --export <path>. e.g.
    topotopo graphs/crate.json --node h --frame 1 --fps 24 --format glb --compress none --custom-attribs
      --instancing packed --materials --no-quantize --scale 100 --split-by-name --tangents auto --up-axis z --export crate.glb
  These sidecars and manifests are metadata of the file beside them: inputs list and the viewer show
  them with it (kind "metadata"), and a file node reading one says what to read instead.
glTF layout: one node+mesh per "name", one primitive per material. Polygons → TRIANGLES, polylines → one LINE_STRIP each
  (LINES above 256 curves), loose points → POINTS with pscale as _PSCALE. Scene empties (scene_null: isolated points with
  scene_empty 1, name, parent, orient, scale) → meshless nodes (sockets) under their parent: the scene, another empty or
  a uniquely named mesh, with the local TRS that keeps their geometry-space placement; set point attributes → node extras;
  missing, ambiguous or cyclic parents and GPU-instanced parents are errors; import brings them back. N → NORMAL (else computed, 60° cusp),
  uv/uv2 → TEXCOORD_0/1 (V flipped), Cd (+Alpha) → COLOR_0 (not on prims with a named material unless vertex_colors,
  MATERIALS below). TANGENT (tangents "auto", the default): MikkTSpace
  tangents (xyz + handedness w) for every primitive whose material has a normal map, computed per corner before
  vertices are welded (uv seams, hard normals and mirrored islands keep their own frames), the same frame bake_normal
  bakes in; a valid point/vertex "tangent" float[4] (from an import) is written on other primitives. "preserve" writes
  the supplied attribute wherever it exists (malformed = error), "none" never writes TANGENT. Collapsed uvs are
  reported. Import reads TANGENT back as point "tangent" (transforms keep it: xyz rotated, w flipped by mirrors).
  Custom attributes (custom_attribs true): every other numeric point/vertex attribute of size 1-4 → _NAME (upper-cased,
  float or the smallest int type), mesh extras keep the original names and types, and packed instances carry their
  anchor attributes as per-instance accessors. The attributes only scene empties use (scene_empty, parent, orient, scale,
  their extras) never become mesh channels.
MATERIALS: the material node writes prim "material" + the detail table. A named material wins: its prims export in that
  material as it is and their Cd / Alpha are dropped (Cd left from colouring parts does not become COLOR_0 or a second,
  white or tinted copy of the material). Prims without a material, and every prim with vertex_colors:true, keep their
  Cd: not all white → baseColor white × COLOR_0 with the material's metallic/roughness/emissive (one constant Cd is
  folded into the factor). alpha < 1 → alphaMode BLEND; unlit → KHR_materials_unlit; emissive above 1 → KHR_materials_emissive_strength.
TEXTURES: material {base_color_map, normal_map, roughness_map} (PNG/JPEG paths relative to the project folder; the mesh
  needs uv). glb/gltf embed the images (baseColorTexture, normalTexture, metallicRoughnessTexture = roughness in green; a
  map replaces its factor). usda: UsdUVTexture shaders reading primvars:st, asset paths relative to the .usda. geo/json
  keep the paths in the material table. glTF import records texture paths (or "embedded:<name>") without decoding.
  "image:<name>" textures (texture_to_material, texture nodes) are image volumes of the geometry: glb/gltf encode them
  to PNG in memory, usda writes <name>_textures/<image>.png next to the .usda, format "textures" writes every image as
  PNG into a folder (layers: extra layers); an orm map becomes glTF's occlusion + metallicRoughness texture. Topic "textures".
  USD materials: UsdPreviewSurface per table entry under /root/materials, bound per mesh or per GeomSubset.
UNREAL: import the GLB (Interchange): meshes, materials and vertex colours. PCG points: export csv with pcg:true
  (Name, Position.X/Y/Z, Rotation.Roll/Pitch/Yaw, Scale.X/Y/Z, Density, Color.R/G/B/A, Seed, then other attributes).
  Unreal space: X = x, Y = z, Z = y (Y/Z swap, like Unreal's glTF importer and Houdini Engine), centimetres (scale
  default 100). Rotation from orient, else N (+Z) and up (+Y), then rot; Scale = scale × pscale; Seed = seed or a hash.
  For a DataTable use pcg_struct:true: Position "(X=…,Y=…,Z=…)", Rotation "(Pitch=…,Yaw=…,Roll=…)", Scale, Density,
  Color "(X=r,Y=g,Z=b,W=a)", Seed. Create a row struct {Vector Position; Rotator Rotation; Vector Scale; float Density;
  Vector4 Color; int Seed} (+ any extra columns), import the CSV as a DataTable with it, then in a PCG graph use
  "Load Data Table" (or Get Data Table Row) and map Position/Rotation/Scale/Density/Color/Seed onto the point
  properties ($Position …) with Attribute Rename/Copy if your version keeps them as attributes; spawn with Static Mesh Spawner.
INSTANCE STREAM (csv / points.json of packed prims, instances "rows"): one row per instance in prim order. P = anchor
  position, orient + scale = the instance 3×3 decomposed (mirror = negative scale x), Mesh = the source name (its single
  prim "name", else source_<i>; the same names as the glTF nodes and USD prototypes), then every other anchor point /
  packed prim attribute (id, variant, tint, height…). The transform inputs (N, up, orient, rot, scale, pscale, trans,
  pivot) are not repeated: copy_to_points folded them into the transform. pcg:true writes Position/Rotation/Scale
  (Unreal cm, degrees) + Mesh right after Seed. Next to it: <name>.meshes.json (Mesh → <name>_meshes/<Mesh>.glb,
  instance counts, bounds, materials) and the GLBs (one source each, metres, Y-up, at the origin; meshes:false skips them).
UNREAL LANDSCAPE BUNDLE: export {format:"unreal_landscape", path:"exports/level"} (a directory; a path ending in .json
  names the manifest) of a geometry with a heightfield, plus the meshes/instances to place on it (merge them):
  landscape.json (manifest), heightmap.png + heightmap.json (png16 + sidecar), layers/<layer>.png (every other layer, 8-bit;
  layers outside 0..1 normalised, the range in the manifest), objects.glb (meshes + EXT_mesh_gpu_instancing instances),
  objects_expanded.glb (the same with real copies, for importers without the extension),
  instances.csv + instances.meshes.json + meshes/<Mesh>.glb (the instance stream). landscape.* in the manifest gives
  Unreal's import layout for the heightmap (section size, sections per component, components, overall resolution: exact
  for 127/253/505/1009/2017/4033 samples), scale, new_landscape_location_cm (the centre: the New Landscape panel centres
  on it) and actor_location_cm (the corner, where the actor ends up).
  Tiled terrain: export {format:"unreal_landscape", path:"exports/level", tile_size:1008}. tile_size is QUADS per
  tile (0, the default, keeps the existing single-landscape files byte-identical); 1008 gives 1009 samples per tile.
  The tile size must fit Unreal components exactly. Typical samples: 253 = 63 quads/section, 2×2 sections/component,
  2×2 components; 1009 = 63, 2×2, 8×8; 2017 = 63, 2×2, 16×16. Sections of 127 quads instead give 2033 samples for
  2×2 sections and 8×8 components (127 does not divide 1008 or 2016).
  Version-2 landscape.json adds tile_grid (tile_size_quads, grid, source_resolution, padded_resolution, padding) and
  tiles[]. Each tile records grid_position, inclusive sample_min/sample_max, relative world_offset_cm, heightmap,
  layers and instances. Shared landscape.section_size_quads / sections_per_component and tile_grid.tile_components
  describe each tile's component layout. tiles/<x>_<y>/heightmap.png + heightmap.json and layers/*.png
  share their last/first row or column exactly; all heights and weight layers use one shared encoding range.
  Non-fitting source edges are padded by repeating the last column/row; padding.right/bottom records the added
  samples. Padding extends the terrain at the same cell size, without moving the source or its instances.
  tiles/<x>_<y>/instances.csv partitions the global instances.csv by anchor X/Z: a seam belongs to the tile on its
  positive side, the outer boundary and outside anchors clamp to the outer tile. Every row is kept exactly once,
  with its original world transform; instances.meshes.json and meshes/*.glb are shared across all tiles.
  TopoTopo.ImportScene reads tiled manifests directly: partitioned levels use Landscape streaming proxies; plain
  levels use one Landscape with the tile components. Each tile gets its own HISM actor, with shared meshes,
  LandscapeLayerInfo assets and generated landscape material. npm run export:demo -- --tiles 2 writes a 2×2 demo
  to out/unreal_demo_tiled/ (126 quads / 127 samples per tile, no padding); in PowerShell, use npm.cmd to pass --tiles.
  Export keeps the dense source and root/tile file bytes in memory; standard heightfield nodes retain their existing
  4097×4097 total-sample cap. Unreal imports a full assembled grid before proxy splitting; large-grid memory is not bounded by tile_size.
  Manual single-landscape import (Unreal 5.8, tile_size:0): 1. Landscape mode (Shift+2) > Manage > New > Import from File, heightmap.png. 2. Section
  Size, Sections Per Component, Number of Components from landscape.json; Overall Resolution must match. 3. Location =
  new_landscape_location_cm, Rotation 0, Scale = landscape.scale. 4. One landscape material layer per layers[] entry;
  assign layers/<name>.png in the import panel (or Paint > Target Layers > Import). 5. Import. 6. objects.glb through the
  Interchange glTF import at the origin (X = x, Y = z, Z = y, cm), or meshes/*.glb + instances.csv for PCG / ISM by Mesh.
HOUDINI: File SOP reads .geo (and glb/obj/usd); packed prims are written as PackedGeometry with embedded geometry
  stored once in sharedprimitivedata (layout not yet confirmed against a Houdini-written file: instancing "expand" is
  the safe path). CSV points: Table Import SOP, map P.x/P.y/P.z → P (and other columns).
  A material name becomes a Houdini material path with a wrangle: s@shop_materialpath = "/mat/" + s@material;
BLENDER: File > Import > glTF 2.0 (custom attributes, exported with custom_attribs:true, arrive as mesh attributes
  named _NAME).
PACKED INSTANCES (help topic "instancing"): glb/gltf write EXT_mesh_gpu_instancing (per-instance attributes with
  custom_attribs:true), usda a PointInstancer (per-instance primvars with custom_attribs:true), geo PackedGeometry prims, csv/points.json the instance stream, json keeps
  them; obj/ply/stl expand them. Option instancing "expand" writes real geometry everywhere.
SPLINES (Bezier/NURBS prims, help topic "curves"): every format but json writes the evaluated polylines (closed curves as
  polygons), with a note; json keeps the spline prims. convert_curve first to choose the resolution.
Heightfields: png16 (.png) / r16 (.r16, .raw) heightmaps with a .json sidecar (range + Unreal Landscape scale/location),
mask_png (8-bit weight layers; layers: [...]); height_min/height_max fix the range. See help topic "heightfield".
IMPORT (file node): obj, stl, ply, glb/gltf (meshopt; Draco with draco3dgltf; external .bin; node transforms;
  EXT_mesh_gpu_instancing as packed prims with their _NAME instance attributes on the anchors, instancing:"expand" for
  geometry; names → "name", materials → "material" + table with texture paths), geo and uncompressed bgeo
  (Houdini; embedded packed geometry → packed prims; not .bgeo.sc; volumes and packed disk prims skipped), csv (P.x | x,y,z | P[x] | Unreal Position.X or struct cells), points.json,
  json (topotopo, points stream or Houdini geo, detected). up_axis "z" converts Z-up sources.`,

  verify: `VERIFY YOUR WORK (cheap checks before reaching for a render)
1. ASSERT IN THE GRAPH: an assert node passes geometry through and fails the build/edit when an invariant breaks,
   with one message listing every failed check and its measured value.
   {"type":"assert","in":["out"],"params":{"watertight":true,"no_flipped":true,"max_prims":20000,
     "bbox_min":[-5,0,-5],"bbox_max":[5,10,5],"expr":"pieces == 1 && volume > 2"}}
   Checks (all off by default): watertight, manifold, no_flipped (winding + closed pieces facing outward; cavity walls
   of hollow solids are fine), min_points/max_points, min_prims/max_prims (-1 = off), bbox_min/bbox_max ([x,y,z] or
   null), min_edge_length, no_degenerate (zero-area faces, coincident points within tolerance), no_self_intersections
   (BVH, stops after max_tests candidate pairs and says so), attrib (must exist; attrib_min/attrib_max bound its first
   component; attrib_class), group (exists and is non-empty), expr (JS over npoints nprims nvertices npolys nlines
   bbox.min/.max/.size/.center (.x .y .z) volume area pieces open_pieces genus closed boundary_edges, and the graph
   vars by their bare name: "npoints == count * 8").
   on_fail: error (default) | warn | mark → detail assert_failed (count) + assert_report, groups assert_fail;
   then render {highlight:"assert_fail"} shows where. Each assert records stats checks/failed in the cook report.
   Every failed check names its first offender: the part (prim "name", groups) and its world position.
   inspect {detail:"topology"} says whether the mesh is a closed solid and, when not, why: open edges (counted after
   welding the vertex splits of uv/normal seams, which a re-imported GLB has), non-manifold edges, flipped faces, pieces
   facing inward, degenerate faces, each with a count, where the first one is and the fix. Solid ops (boolean …) give
   the same causes when they refuse a mesh.
2. EXPLAIN AFTER A BUILD/EDIT: explain {graph, node?} describes the result in words, e.g.
   "reads as: one closed piece, box-like, 2 × 1 × 1 m, 3 cm thin walls, mirror-symmetric in x, z", then pieces,
   watertight/genus/boundary loops, flipped normals, symmetry planes, principal axis + aspect, sampled thickness,
   degenerate faces, polygon mix, attributes, groups. Compare it with what you meant to build.
3. DIFF TO SEE WHAT A CHANGE DID: graphs {action:"duplicate", name:"main", to:"before"} → edit → diff {a:"before", b:"main"}:
   counts, bbox delta, topology/volume, attribute and group changes, heightfields, images and SDF grids (sample by
   sample), Hausdorff + mean distance, per-point displacement (same point count), verdict. a/b: "graph", "graph/node" or {graph, node, frame} (two nodes or two frames work too).
   render:true overlays them: grey = unchanged, blue = only in b, orange = only in a.
4. RENDER for what text cannot tell (proportions, style); inspect for one attribute's numbers.
5. INSPECT {detail} (CLI --inspect <detail>):
   summary (default)  one screen: counts and triangles, bbox in metres to the millimetre, parts (prim "name"),
                      materials and their maps, images, uv state (charts, in-tile overlap, tiling, utilization), closed
                      or open edges (after welding seam splits)
   budget             triangles per part (prim "name": each exports as its own mesh), split per LOD when the names
                      end in _lod0, _lod1 …, and per node (the triangles each node adds over its inputs), sorted, with
                      totals; packed instances count expanded. json:true (CLI --json) appends it as JSON
   scene              the glb export read back from its bytes: the node tree (meshes, sockets and their parents, world
                      and local positions), triangles per mesh, materials with factors and maps, images with size;
                      export_options (CLI: the export flags) as the export takes them
   topology / uv / attributes / elements / all   (see above and help topic "uv")
MEASURE NODES (category measure) turn shape into attributes for masks and colour:
  curvature   type mean|gaussian|principal_min|principal_max|convexity (1/m; normalize → 0..1) — wear on convex edges
  occlusion   mode occlusion → ao 0..1 | cavity → cavity 0..1 | thickness → metres (rays inward; closed meshes);
              optional occluder input — dirt in crevices, scatter masks under overhangs, thin-wall checks
  distance    to a mesh surface, curves or points (second input); signed (inside < 0), max_distance, extra → nearest_prim/uv/P
  e.g. {"type":"occlusion","in":["rock"]} → {"type":"color","params":{"mode":"ramp","attrib":"ao","range":[0,1]}}`,

  cloth: `CLOTH AND PRESSURE (category "sim": drape, inflate; XPBD, Vellum-lite)
drape simulates input 0 as cloth for "steps" steps of 1/fps s and outputs the last state: the same points, prims and
attributes with P moved plus v, rest_P (the input positions), N and pinned. Not time-dependent: every cook simulates from
the input ("steps": "=frame" re-simulates per frame; use solver for frame-to-frame feedback).
INPUTS: 0 cloth (any polygon mesh; quads stay quads; polylines become strings), 1 collider (static mesh, optional),
 2 pins (points: the nearest cloth point to each is pinned; pin_snap:true moves it onto the pin first).
PINS: pin_group "@P.y>1.99" (a top edge), a point attribute pin != 0, or input 2. Tethers keep pinned cloth from sagging.
RECIPES
 tablecloth: grid {size:[2,2], divisions:[40,40], center:[0,1.2,0]} + box table → drape(grid, table) {steps:100}
 tarp over props: merge the props (crates, rocks) into input 1; thickness 0.02-0.03; bend_stiffness 0.003 for a stiff tarp
 banner: grid {plane:"xy"} → drape {pin_group:"@P.y>1.99", wind:[0,0,2]} (wind 5+ m/s flies light cloth flat)
 hang from hooks: drape(cloth, null, hooks) {pin_snap:true}
 cushion: box {size:[0.8,0.2,0.8], divisions:[16,4,16]} → inflate {pressure:1.6} (gravity [0,-9.81,0] + floor:true rests it)
 balloon: sphere → inflate {pressure:2.5, stretch_stiffness:300} (a soft skin stretches)
PARAMS are physical and independent of the step size: stretch_stiffness N/m (1e4+ ≈ inextensible), shear_stiffness N/m,
 bend_stiffness N·m (1e-5 silk … 1e-2 leather), density kg/m², damping 1/s, drag ½ρCd. steps = settle time (steps/fps s);
 raise substeps (not iterations) for stiffer cloth and cleaner contacts. thickness keeps points off colliders and the
 floor; self_collision (off by default) works with thickness ≈ half the edge length; max_points guards the cost.
CHECK: inspect stats (substeps, contacts; inflate: volume_ratio); render views "persp" for the folds.
LIMITS: collision is per point plus sharp corners (a sharp collider edge can pass between the points of a coarse cloth: refine it),
 colliders are static, contacts are found once per step, no tearing, plasticity or cloth-on-cloth friction.`,

  recipes: `RECIPES (copy, then adapt)
1) Rocks on terrain:
 {"nodes":{"t":{"type":"terrain","params":{"size":[30,30],"height":4}},
  "pts":{"type":"scatter","in":["t"],"params":{"count":150,"seed":2}},
  "keep":{"type":"delete","in":["pts"],"params":{"class":"point","group":"@N.y<0.85"}},
  "sc":{"type":"attrib_randomize","in":["keep"],"params":{"name":"pscale","min":0.2,"max":0.7}},
  "rock":{"type":"sphere","params":{"type":"ico","level":2}},
  "rk":{"type":"noise_displace","in":["rock"],"params":{"amplitude":0.3,"frequency":1.5}},
  "rocks":{"type":"copy_to_points","in":["rk","sc"]},
  "out":{"type":"merge","in":["t","rocks"]}}}
2) Tree: lsystem → polywire (uses width) + leaves: copy a small grid to group "leaves" points via delete keep.
 {"nodes":{"ls":{"type":"lsystem","params":{"axiom":"A","rules":{"A":"F[&+A!J][&-A!J][^A!J]"},"generations":6,"tropism_strength":0.1}},
  "trunk":{"type":"polywire","in":["ls"],"params":{"divisions":6}},
  "lp":{"type":"delete","in":["ls"],"params":{"class":"point","group":"leaves","keep":true}},
  "leaf":{"type":"grid","params":{"size":[0.2,0.3],"divisions":[1,1],"plane":"xy"}},
  "leaves":{"type":"copy_to_points","in":["leaf","lp"]},
  "out":{"type":"merge","in":["trunk","leaves"]}}}
3) Building floors with foreach count: body transforms a floor slab by "=iteration*3".
4) Carved block: box → boolean subtract with sphere/tube → smooth_solid for rounded edges.
5) Shatter: sphere → voronoi_fracture count 20 gap 0.02 → render color_by:"class".
6) Sign: text {text:"HELLO", depth:0.2} + box backing, merge.
7) Organic blob: sdf_expr with smin of spheres + noise → sdf_to_mesh.
8) Pipes: curve (smooth) → sweep (circle radius 0.05) or polywire.
9) Panel greebles: grid → poly_extrude individual with group "@P.x>0" random → color by group via group/color nodes.
10) Deformers: bend with a cage: geo → bound {divisions:[1,6,1]} → bend → lattice(geo, bent cage, divisions [1,6,1]); wrap along a curve: geo laid along +Z → path_deform(geo, curve) {stretch:true}; pull a spot: soft_transform {group, translate, radius}; drive a mesh by a coarse proxy: point_deform(geo, rest pts, deformed pts). Add rest before deforming so noise_displace/attrib_noise patterns stick.
11) Hard-surface block-out: box → polysplit {edge:"length>1.2", count:2} (loop cuts; new points in point group "split")
 → group_promote {group:"split", from:"point", to:"prim", include:"all", new_name:"band", delete_source:false}
 → poly_extrude {group:"band", distance:0.1, inset:0.03} → bevel the rims (polybevel) or subdivide with creases. knife splits along a
 plane with the cut in edge group "cut"; polybridge {source:"border:a", target:"border:b", delete_inner_faces:true} tunnels
 between two face groups; polyfill {mode:"grid"} caps holes with quads; dissolve {group:"split"} removes loops again.
12) Rounded / chamfered hard-surface edges: box → poly_bevel {group:"angle>80", offset:0.05, divisions:3} (divisions 0 =
 chamfer; shape 1 = squarer, -0.5 = flat, -1 = cove). Only the rim of a slab: extrude → poly_bevel {group:"border:top"}.
13) Clean asset pipeline: imported/broken mesh → mesh_repair (fuse, winding, small holes; report in detail repair_report)
 → remesh_isotropic {target_length, feature_angle:40} (even triangles before uv_unwrap or simulation; target_attrib for
 adaptive size) → uv_unwrap → lod {levels:4, ratios:[1,0.5,0.25,0.1]} (prim lod + name {name}_lod0… from name_format,
 export split_by_name; group "@name=magazine" for one part; mode switch + level for one level, named the same way) or
 decimate {ratio, attributes:"uv N"} for one level. A level that stops short warns with what holds it (uv seams, hard
 normals, group / prim attribute borders): reduce before unwrapping and compute vertex normals after lod. remesh_quad {target_faces:2000, feature_angle:45} produces field-aligned
 quad-dominant polygons with point/vertex/prim attributes; mode:"quads_only" conformingly subdivides all faces and can
 exceed target_faces, especially along hard curves. crease_group aligns explicit edges; group keeps its border fixed.
 Inspect detail quad_fraction and singularities, and the wireframe (examples/quad_remesh.json). remesh (voxel) only
 when the input is beyond repair (it drops attributes).
14) Street from TopoTopo's own packages (help topic packages): topotopo/street/road_strip on a line →
 topotopo/street/lamp_post packed onto points_along_curve {side_offset, both_sides}; a house = four
 topotopo/architecture/wall_segment walls (the street-facing one rotated 180°, sides ±90°, door:true on the front) +
 topotopo/architecture/roof_gable or roof_hip translated to the wall top; topotopo/street/fence and bench,
 topotopo/props/crate and topotopo/nature/tree_lowpoly placed with transform or copy_to_points;
 topotopo/nature/forest_patch on a grid for a park. Whole graph: examples/street_block.json.`,
};

export function topicList() {
  return Object.keys(TOPICS);
}

/** A help topic's text ("overview" or "instructions": the operating guide), or null for a name that is not a topic. */
export function topicText(name: string): string | null {
  if (name === 'overview' || name === 'instructions') return INSTRUCTIONS;
  return Object.hasOwn(TOPICS, name) ? TOPICS[name] : null;
}

function paramLine(name: string, pd: ParamDef): string {
  let d = pd.default;
  if (pd.type === 'graph') d = '{nodes, output}';
  const def = d === undefined ? '' : ` = ${typeof d === 'string' ? JSON.stringify(d.length > 60 ? d.slice(0, 57) + '...' : d) : JSON.stringify(d)}`;
  const range = pd.min !== undefined || pd.max !== undefined ? ` [${pd.min ?? ''}..${pd.max ?? ''}]` : '';
  const opts = pd.options ? ` {${pd.options.join('|')}}` : '';
  const al = pd.aliases?.length ? ` (aka ${pd.aliases.join(', ')})` : '';
  return `  ${name} ${pd.type}${opts}${def}${range} — ${pd.desc}${al}`;
}

/**
 * A package output's kind and tags (NodeDef.package) as every listing says them, "mesh [conifer, low-poly]" (a working
 * folder's output that pins no kind: "kind not pinned [...]"); '' for other node types.
 */
export function kindTags(def: NodeDef): string {
  const p = def.package;
  return p ? `${p.kind ?? 'kind not pinned'}${p.tags?.length ? ` [${p.tags.join(', ')}]` : ''}` : '';
}

export function nodeDoc(def: NodeDef): string {
  const out = [`## ${def.type} (${def.category})${def.aliases?.length ? ` aka ${def.aliases.join(', ')}` : ''}`];
  if (def.deprecated) out.push(`DEPRECATED: ${def.deprecated}`);
  out.push(def.summary);
  if (kindTags(def)) out.push(`what it is: ${kindTags(def)}`);
  if (def.description) out.push(def.description);
  if (def.usesTime) out.push('time-dependent: re-cooks when the frame changes (see help topic "time").');
  out.push(def.inputs.length ? 'inputs:' : 'inputs: none (generator)');
  def.inputs.forEach((i, k) => out.push(`  ${k} ${i.name}${i.optional ? ' (optional)' : ''}${i.multi ? ' (any number)' : ''} — ${i.desc}`));
  const ps = Object.entries(def.params);
  out.push(ps.length ? 'params:' : 'params: none');
  for (const [k, pd] of ps) out.push(paramLine(k, pd));
  if (def.outputs) out.push(`writes: ${def.outputs}`);
  if (def.example) out.push(`example: ${JSON.stringify(def.example)}`);
  return out.join('\n');
}

/** The catalog by category; `cli` ends it with the command line's help flags instead of the MCP help tool. */
export function catalogText(defs: NodeDef[], filter?: { category?: string; search?: string; deprecated?: boolean; cli?: boolean }): string {
  let list = defs;
  const hidden = filter?.deprecated ? 0 : list.filter((d) => d.deprecated).length;
  if (!filter?.deprecated) list = list.filter((d) => !d.deprecated);
  if (filter?.category) list = list.filter((d) => d.category === filter.category);
  if (filter?.search) {
    const s = filter.search.toLowerCase();
    list = list.filter((d) => (d.type + ' ' + (d.aliases ?? []).join(' ') + ' ' + d.summary + ' ' + (d.description ?? '') + ' ' + kindTags(d)).toLowerCase().includes(s));
  }
  const cats = [...new Set([...CATEGORY_ORDER, 'asset', 'package', ...list.map((d) => d.category)])];
  const out: string[] = [];
  for (const c of cats) {
    const items = list.filter((d) => d.category === c);
    if (!items.length) continue;
    out.push(`[${c}]`);
    for (const d of items) out.push(`  ${d.type}${d.inputs.length ? '' : ' ◦'}${d.deprecated ? ' (deprecated)' : ''} — ${d.summary}${kindTags(d) ? `  (${kindTags(d)})` : ''}`);
  }
  out.push(filter?.cli
    ? '(◦ = generator, no inputs). --help-node <type> for a node\'s params; --help-topic <name> for a topic: overview, ' + topicList().join(', ')
    : '(◦ = generator, no inputs). Use help {nodes:[...]} for params. Help topics: ' + topicList().join(', '));
  if (hidden) out.push(`${hidden} deprecated node type(s) hidden (include_deprecated: true lists them).`);
  return out.join('\n');
}
