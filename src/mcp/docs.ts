// LLM-facing documentation: operating guide, topic pages, and generated node references.
import type { NodeDef, ParamDef } from '../graph/types.ts';
import { CATEGORY_ORDER } from '../graph/registry.ts';

export const INSTRUCTIONS = `Polyforge: a procedural geometry engine (Houdini-SOP style) you drive with JSON node graphs.

WORKFLOW
1. catalog → see node types (95+, Houdini names work as aliases: copytopoints, attribwrangle, polyextrude, mountain…).
2. help {nodes:[...]} for exact params before using unfamiliar nodes; help {topic:"wrangle"|"graph"|"recipes"…} for concepts.
3. build {graph} the WHOLE network in one call (dry_run:true validates without cooking). Every response reports errors per node with did-you-mean hints.
4. render to SEE it (quad view: persp/front/right/top; backfaces are tinted blue = flipped normals). inspect for numbers (bbox, attributes, watertightness).
5. edit {ops} for incremental changes (set params, insert nodes, rewire) — only downstream nodes re-cook.
6. export to glb/gltf (materials, meshopt), geo (Houdini), csv (Unreal PCG points), points.json, obj/usda/ply/stl/json for Unreal, Blender, Houdini.

CONVENTIONS: Y-up, metres, angles in degrees (wrangle trig uses radians). Houdini attribute names (P N Cd uv pscale orient up scale width name class piece). Polygons are closed prims, polylines are open prims.
GRAPH: {"nodes": {"name": {"type": "...", "in": ["upstream", ...], "params": {...}}}, "output": "name", "vars": {"k": 1}}. Params accept "=expr" using vars (e.g. "=height*0.5"), time (frame, time) and other nodes (npoints('pts'), bbox('base').size.y, ch('box1/size')).
TIME: build/edit/render/inspect/export take "frame" (default 1). solver = per-frame feedback (growth, accumulation). See help topic "time".
ESCAPE HATCHES: wrangle (per-element JS with @P/@Cd syntax), script (whole-geometry JS with the engine library), sdf_expr (signed distance functions). If a node is missing, write it with these.`;

export const TOPICS: Record<string, string> = {
  graph: `GRAPH FORMAT
{
  "nodes": {
    "ground": {"type": "grid", "params": {"size": [10, 10], "divisions": [20, 20]}},
    "pts":    {"type": "scatter", "in": ["ground"], "params": {"count": 200, "seed": 1}},
    "rock":   {"type": "sphere", "params": {"type": "ico", "level": 2, "radius": 0.2}},
    "rocks":  {"type": "copy_to_points", "in": ["rock", "pts"]},
    "out":    {"type": "merge", "in": ["ground", "rocks"]}
  },
  "output": "out",
  "vars": {"density": 200}
}
- "in": ordered input list (null = unconnected), a single name, or {"inputName": node} (names from help).
- Output node: "output", else a node named out/OUT, else the last unconnected node.
- Node names: letters, digits, _ . -  Node types & params are case/underscore-insensitive and accept Houdini-style aliases.
- "bypass": true passes input 0 through. "note": free text. "ui": {x,y} reserved for the future GUI.
- Vectors: a single number broadcasts ("size": 2 → [2,2,2]). Colours accept [r,g,b], "#ff8800" or names.
- build mode "merge" upserts nodes into the existing graph; edit ops: set, add, remove (auto-rewires), connect, rename, output, vars, bypass, replace, insert (after a node, rewiring its consumers).
- Several graphs can coexist (name param); graph_ref composes them. Graphs persist as JSON in the workspace.`,

  expressions: `PARAM EXPRESSIONS
Any non-code param can be a string starting with "=": a JS expression evaluated with graph vars.
  "vars": {"floors": 6, "h": 3}   →   "height": "=floors*h",  "count": "=floors*4"
Helpers: sin cos tan asin acos atan atan2 sqrt pow exp log abs floor ceil round min max sign hypot PI TAU E
         clamp fit lerp smoothstep frac mod radians degrees rand(x, seed) pick(array, i)
Time: frame, time (seconds), fps, timeInc. "=sin(time*2)" animates; the node then re-cooks per frame (see topic time).
Inside foreach bodies: iteration, numiterations, value, attr (e.g. "=attr.height"), plus parent vars.
Inside solver bodies: iteration (frames since start_frame), substep, and frame/time/timeInc are the step's time.
READING OTHER NODES (n = a node of the same graph or body, named by a string literal; single quotes avoid JSON escaping):
  npoints('n') nprims('n') nvertices('n')         element counts of n's cooked geometry
  bbox('n') → {min, max, size, center, empty}      vectors are arrays with .x .y .z: "=bbox('base').size.y"
  centroid('n') → mean point position              (bbox('n').center is the box centre)
  detail('n', 'attr'[, comp])                      detail attribute value
  point('n', i, 'attr'[, comp])  prim('n', i, 'attr'[, comp])   (prim 'P' = centroid when no prim P exists)
  ch('n', 'param') or ch('n/param')               another node's resolved param value (defaults included)
  e.g. stack on top: "translate": [0, "=bbox('base').max.y", 0]    match a count: "count": "=npoints('pts')"
Referenced nodes are dependencies: they cook first (even if not wired), changing them re-cooks this node, unknown
names get did-you-mean errors, and reading a node downstream of yourself is a cycle error.
Not supported: dynamic names (npoints(name) with a variable), and these functions inside graph "vars".
Assets: their vars become node parameters.
Expressions are per-node constants. For per-element logic use wrangle.`,

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
  Body vars: iteration (frames since start_frame, from 0), substep, and frame/time/timeInc = the step's time (fractional between substeps).
SOLVER vs FOREACH: foreach feedback:true is count-based (N iterations in one cook, no time, cached as a whole);
  the solver's result depends on the frame you cook at and is advanced frame by frame.`,

  wrangle: `WRANGLE (per-element JavaScript with VEX-style @attributes)
{"type": "wrangle", "in": ["geo"], "params": {"run_over": "points", "code": "@P.y += noise(@P*2) * 0.1;"}}
run_over: points | prims | vertices | detail (once). group: limits elements.
@name reads/writes the current element's attribute. Unknown names are created on write.
  Type prefixes for new attributes: f@ float, i@ int, v@ vec3, p@ vec4/quaternion, u@ vec2, s@ string.
  Known names get Houdini types (Cd/N/v/up/scale/uv = vec3, orient = vec4, pscale/width = float, id/class = int, name = string).
Specials: @ptnum @primnum @vtxnum @elemnum @numpt @numprim @numvtx @numelem; time: @Frame @Time @TimeInc (only then is the wrangle re-cooked per frame)
Groups: @group_top = 1 (membership of the current element). Inputs: @opinput1_P reads input 1 at the same index.
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
EDITS (applied after the loop, geohandle 0 optional):
  addpoint(0,pos)→pt  addprim(0,"poly"|"polyline",[pts])→prim  removepoint(0,pt)  removeprim(0,pr,andpoints)
  setpointattrib(0,"name",pt,v) setprimattrib setvertexattrib setdetailattrib(0,"name",v) setpointgroup(0,"g",pt,1) setprimgroup
DEBUG: print(...) (shows as warnings), error("msg") aborts. Use 'return' to skip the rest for the current element.
Vars: vars.name (graph vars), iteration/numiterations inside foreach.
SDF helpers are also available (see topic sdf).`,

  groups: `GROUP PATTERNS (any "group" param; also delete/group nodes)
  ""  or  *          all elements
  top                named group (wildcards: side*)
  !top               everything not in top     ^top  removes top from the selection so far
  0-10  5  0-100:2   element index ranges (:2 = every 2nd)
  @P.y>0.5           attribute test, ops = == != > < >= <= ; components .x .y .z .w .r .g .b
  @class==3   @name=piece*   @Cd.r<0.2   @ptnum<100
Tokens are space-separated and applied left to right (union unless prefixed ! or ^).
A point pattern may name a prim group (selects its points) and vice versa (prims whose points are all selected).
Groups produced by nodes: poly_extrude front/side, extrude top/bottom/side, boolean from_a/from_b, sweep caps/sides,
clip above/below/cap, fill_holes filled, lsystem leaves/J/K/M, voronoi_fracture inside. Create custom ones with "group".`,

  attributes: `ATTRIBUTES (Houdini conventions)
Classes: point (P and per-point data), vertex (per polygon corner: uv seams, hard normals), prim (per face/curve), detail (global).
Lookup precedence when reading: vertex > point > prim > detail.
Common names:
  P vec3 position · N vec3 normal · Cd vec3 colour (0-1) · Alpha · uv vec3 (u,v,0) · v velocity
  pscale float uniform scale · scale vec3 · orient vec4 quaternion (x,y,z,w) · up vec3 · rot · trans · pivot   (copy_to_points)
  width float curve diameter (polywire, USD curves) · curveu 0..1 along curves (resample)
  name string piece name (export splits meshes by it) · class int piece id (connectivity) · copynum int (copy nodes)
  material string prim: material name (material node); detail "materials" = JSON table name → {baseColor, metallic,
    roughness, emissive, alpha, doubleSided, unlit} that exporters write as glTF materials (Houdini shop_materialpath is read too)
  id int · piece · variant int (copy_to_points variants) · height (terrain 0-1)
Instancing transform: P + trans, rotation from orient, else N (+Z axis) and up (+Y axis), then rot; scale = pscale * scale.
Types: float/int with tuple size 1-4 (up to 16), or string. Merging unions attributes; missing values take defaults
(Cd/pscale/scale default 1, orient identity).`,

  sdf: `SDF / IMPLICIT MODELLING
Volumes are signed distance functions (negative inside) carried in geometry; nodes compose them lazily.
  sdf_shape (sphere box round_box torus capsule cylinder cone ellipsoid octahedron) → sdf_combine (union/subtract/intersect,
  smooth_* with blend k) → sdf_modify (offset shell noise twist bend repeat) → sdf_to_mesh (watertight triangles, smooth N).
  sdf_from_mesh turns closed meshes into volumes (blend meshes, offsets); remesh = voxel remesh.
sdf_expr: write the distance in JS: p = [x,y,z]; return a number. Inputs via sdf(0, p), sdf(1, p).
  IQ-style helpers: sdSphere(p,r) sdBox(p,[hx,hy,hz]) sdRoundBox(p,b,r) sdTorus(p,R,r) sdCapsule(p,a,b,r) sdCylinder(p,h,r)
  sdCone(p,h,r) sdEllipsoid(p,[rx,ry,rz]) sdPlane(p,n,h) sdOctahedron(p,s) sdHexPrism(p,[r,h]) sdSegment(p,a,b,r)
  opUnion opSubtract(a,b) opIntersect smin/opSmoothUnion(a,b,k) smax opSmoothSubtract(a,b,k) opRound(d,r) opOnion(d,t)
  opRepeat(p,[cx,cy,cz]) opTwist(p,k) opBend(p,k) opTranslate(p,t) opRotateX/Y/Z(p,radians) opMirrorX(p)
  plus all wrangle math (add, sub, mul, noise, fbm …).
Example: {"type":"sdf_expr","params":{"code":"const b = sdBox(p,[0.6,0.3,0.4]); const s = sdSphere(sub(p,[0,0.35,0]),0.35); return smin(b, s, 0.15) + 0.03*noise(mul(p,6));"}}
Then: {"type":"sdf_to_mesh","in":["that"],"params":{"divisions":120}}. Set bounds_min/bounds_max to enclose the shape.`,

  loops: `FOREACH LOOPS
{"type": "foreach", "in": ["lots"], "params": {"mode": "prims", "body": {
   "nodes": {
     "lot":  {"type": "input", "params": {"index": 0}},
     "bldg": {"type": "extrude", "in": ["lot"], "params": {"height": "=2 + rand(iteration, 7) * 10"}}
   },
   "output": "bldg"}}}
Modes: pieces (by piece_attrib or connectivity) · prims · points · count (N times; feedback:true chains results).
Body input index 0 = current element/piece (or the previous result with feedback); 1 = whole input; 2 = foreach input 2.
Vars in the body: iteration, numiterations, value, attr (the element's attributes, e.g. "=attr.height"), parent vars.
Results are merged (or the last one with feedback). Identical iterations are cached.
For feedback over animation frames (growth, accumulation) use solver instead (help topic "time").`,

  assets: `ASSETS (reusable custom nodes, like HDAs)
Any graph with vars can be saved as a node type: assets {action:"save", name:"rock_cluster", from_graph:"main"}.
The graph's vars become parameters (add "params": {"var": {"desc": "...", "min": 0, "max": 1}} for docs/ranges).
Inputs: put {"type":"input","params":{"index":0,"label":"surface"}} nodes in the graph.
Then use it like any node: {"type": "rock_cluster", "in": ["terrain"], "params": {"count": 50}}.
Assets are stored as JSON in workspace/assets and load on startup.`,

  export: `EXPORT
export {path:"exports/thing.glb"} — format from the extension:
  glb / gltf    glTF 2.0 via gltf-transform (recommended for Unreal, Blender, web)
  geo           Houdini JSON geometry: every attribute (all classes), group and polyline, lossless (precision 64 or 32)
  csv           point stream, one row per point: P.x,P.y,P.z,N.x,…,pscale,name (strings quoted); prims are ignored
  points.json   {format:"polyforge-points", count, attributes:{P:{type,size,data}}} (same schema on import)
  obj usda ply stl json (lossless polyforge)
Options: up_axis "y" (default) | "z", scale (100 = m → cm), split_by_name (one mesh per prim "name", default true),
  custom_attribs, materials (default true), compress "none" | "meshopt" (EXT_meshopt_compression + KHR_mesh_quantization,
  ~3× smaller) | "draco" (only with the optional draco3dgltf package), quantize (KHR_mesh_quantization alone),
  attributes ["P","pscale",…] (csv / points.json), pcg / pcg_struct (csv), precision 64 | 32 (geo).
glTF layout: one node+mesh per "name", one primitive per material. Polygons → TRIANGLES, polylines → one LINE_STRIP each
  (LINES above 256 curves), loose points → POINTS with pscale as _PSCALE. N → NORMAL (else computed, 60° cusp),
  uv/uv2 → TEXCOORD_0/1 (V flipped), Cd (+Alpha) → COLOR_0. Custom attributes: every other numeric point/vertex attribute
  of size 1-4 → _NAME (upper-cased, float or the smallest int type); mesh extras keep the original names and types.
MATERIALS: the material node writes prim "material" + the detail table. Vertex colours win: prims whose Cd is not all
  white export baseColor white × COLOR_0 with the material's metallic/roughness/emissive; otherwise baseColor = the
  material colour. alpha < 1 → alphaMode BLEND; unlit → KHR_materials_unlit; emissive above 1 → KHR_materials_emissive_strength.
UNREAL: import the GLB (Interchange): meshes, materials and vertex colours. PCG points: export csv with pcg:true
  (Name, Position.X/Y/Z, Rotation.Roll/Pitch/Yaw, Scale.X/Y/Z, Density, Color.R/G/B/A, Seed, then other attributes).
  Unreal space: X = x, Y = z, Z = y (Y/Z swap, like Unreal's glTF importer and Houdini Engine), centimetres (scale
  default 100). Rotation from orient, else N (+Z) and up (+Y), then rot; Scale = scale × pscale; Seed = seed or a hash.
  For a DataTable use pcg_struct:true: Position "(X=…,Y=…,Z=…)", Rotation "(Pitch=…,Yaw=…,Roll=…)", Scale, Density,
  Color "(X=r,Y=g,Z=b,W=a)", Seed. Create a row struct {Vector Position; Rotator Rotation; Vector Scale; float Density;
  Vector4 Color; int Seed} (+ any extra columns), import the CSV as a DataTable with it, then in a PCG graph use
  "Load Data Table" (or Get Data Table Row) and map Position/Rotation/Scale/Density/Color/Seed onto the point
  properties ($Position …) with Attribute Rename/Copy if your version keeps them as attributes; spawn with Static Mesh Spawner.
HOUDINI: File SOP reads .geo (and glb/obj/usd). CSV points: Table Import SOP, map P.x/P.y/P.z → P (and other columns).
  A material name becomes a Houdini material path with a wrangle: s@shop_materialpath = "/mat/" + s@material;
BLENDER: File > Import > glTF 2.0 (custom attributes arrive as mesh attributes named _NAME; meshopt files import).
IMPORT (file node): obj, stl, ply, glb/gltf (meshopt; Draco with draco3dgltf; external .bin; node transforms and
  EXT_mesh_gpu_instancing expanded; names → "name", materials → "material" + table), geo and uncompressed bgeo
  (Houdini; not .bgeo.sc; volumes skipped), csv (P.x | x,y,z | P[x] | Unreal Position.X or struct cells), points.json,
  json (polyforge, points stream or Houdini geo, detected). up_axis "z" converts Z-up sources.`,

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
9) Panel greebles: grid → poly_extrude individual with group "@P.x>0" random → color by group via group/color nodes.`,
};

export function topicList() {
  return Object.keys(TOPICS);
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

export function nodeDoc(def: NodeDef): string {
  const out = [`## ${def.type} (${def.category})${def.aliases?.length ? ` aka ${def.aliases.join(', ')}` : ''}`];
  if (def.deprecated) out.push(`DEPRECATED: ${def.deprecated}`);
  out.push(def.summary);
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

export function catalogText(defs: NodeDef[], filter?: { category?: string; search?: string; deprecated?: boolean }): string {
  let list = defs;
  const hidden = filter?.deprecated ? 0 : list.filter((d) => d.deprecated).length;
  if (!filter?.deprecated) list = list.filter((d) => !d.deprecated);
  if (filter?.category) list = list.filter((d) => d.category === filter.category);
  if (filter?.search) {
    const s = filter.search.toLowerCase();
    list = list.filter((d) => (d.type + ' ' + (d.aliases ?? []).join(' ') + ' ' + d.summary + ' ' + (d.description ?? '')).toLowerCase().includes(s));
  }
  const cats = [...new Set([...CATEGORY_ORDER, 'asset', ...list.map((d) => d.category)])];
  const out: string[] = [];
  for (const c of cats) {
    const items = list.filter((d) => d.category === c);
    if (!items.length) continue;
    out.push(`[${c}]`);
    for (const d of items) out.push(`  ${d.type}${d.inputs.length ? '' : ' ◦'}${d.deprecated ? ' (deprecated)' : ''} — ${d.summary}`);
  }
  out.push('(◦ = generator, no inputs). Use help {nodes:[...]} for params. Help topics: ' + topicList().join(', '));
  if (hidden) out.push(`${hidden} deprecated node type(s) hidden (include_deprecated: true lists them).`);
  return out.join('\n');
}
