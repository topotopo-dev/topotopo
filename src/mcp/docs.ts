// LLM-facing documentation: operating guide, topic pages, and generated node references.
import type { NodeDef, ParamDef } from '../graph/types.ts';
import { CATEGORY_ORDER } from '../graph/registry.ts';

export const INSTRUCTIONS = `Polyforge: a procedural geometry engine (Houdini-SOP style) you drive with JSON node graphs.

WORKFLOW
1. catalog → see node types (100+, Houdini names work as aliases: copytopoints, attribwrangle, polyextrude, mountain…).
2. help {nodes:[...]} for exact params before using unfamiliar nodes; help {topic:"wrangle"|"graph"|"recipes"…} for concepts.
3. build {graph} the WHOLE network in one call (dry_run:true validates without cooking). Every response reports errors per node with did-you-mean hints.
4. render to SEE it (quad view: persp/front/right/top; backfaces are tinted blue = flipped normals; views "quad_uv" + checker:true for UVs; overlays for specific questions: wireframe "hard"/"boundary", views "section", glyphs "N", label_groups, shading "matcap", see help topic "render"). inspect for numbers (bbox, attributes, watertightness).
5. edit {ops} for incremental changes (set params, insert nodes, rewire) — only downstream nodes re-cook.
6. export to glb/gltf (materials, textures, meshopt), geo (Houdini), csv (Unreal PCG points / instance rows), points.json, usda, obj/ply/stl/json for Unreal, Blender, Houdini; unreal_landscape = a whole terrain scene for Unreal.
7. verify: assert nodes guard invariants in the graph (watertight, counts, bbox, expr); explain {graph} reads a result in words; diff {a, b} shows what an edit changed. See help topic "verify".
INSTANCING: copy_to_points {pack:true} / pack make packed instances (millions stay cheap; glb, usda and geo export them as instances, csv/points.json as one row per instance). See help topic "instancing".
PCG: mask → scatter {density_mask} → orient → prune → copy_to_points {pack, variants, variant_weights}; points_along_curve, cluster, attribute_from_map. See help topic "pcg".
CURVES: bezier / nurbs make spline prims (CVs + order, exact everywhere); convert_curve, resample, fillet_curve, offset_curve_3d, project_curve (roads on terrain), spline_fit, curve_attribs (curveu, frames, ramps). See help topic "curves".

CONVENTIONS: Y-up, metres, angles in degrees (wrangle trig uses radians). Houdini attribute names (P N Cd uv pscale orient up scale width name class piece). Polygons are closed prims, polylines are open prims.
GRAPH: {"nodes": {"name": {"type": "...", "in": ["upstream", ...], "params": {...}}}, "output": "name", "vars": {"k": 1}}. Params accept "=expr" using vars (e.g. "=height*0.5"), time (frame, time) and other nodes (npoints('pts'), bbox('base').size.y, ch('box1/size')).
TIME: build/edit/render/inspect/export take "frame" (default 1). solver = per-frame feedback (growth, accumulation). See help topic "time".
ESCAPE HATCHES: wrangle (per-element JS with @P/@Cd syntax), script (whole-geometry JS with the engine library), sdf_expr (signed distance functions). If a node is missing, write it with these.
TERRAIN: heightfield → heightfield_noise → heightfield_erode → masks / heightfield_path → heightfield_scatter + copy_to_points, heightfield_to_mesh; export png16 for an Unreal Landscape, or unreal_landscape for the landscape + layers + instances bundle. See help topic "heightfield".`;

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
EDITS (applied after the loop, geohandle 0 optional):
  addpoint(0,pos)→pt  addprim(0,"poly"|"polyline",[pts])→prim  removepoint(0,pt)  removeprim(0,pr,andpoints)
  setpointattrib(0,"name",pt,v) setprimattrib setvertexattrib setdetailattrib(0,"name",v) setpointgroup(0,"g",pt,1) setprimgroup
  setvertexgroup(0,"g",v,1) setedgegroup(0,"g",pt0,pt1,1)  (0 removes)
DEBUG: print(...) (shows as warnings), error("msg") aborts. Use 'return' to skip the rest for the current element.
Vars: vars.name (graph vars), iteration/numiterations inside foreach.
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
  ""                    every edge shared by two polygons. Boundary and non-manifold edges are skipped with a warning.
  mode "points" takes a point pattern instead ("0", "@P.y>0", a point group) and truncates those corners.
EDGE GROUPS IN NODES: poly_bevel, subdivide creases (+ creaseweight attribute), normal hard_edges. Edge groups follow points:
  they survive transforms, fuse (remapped), merge (offset), copies, deletes (edges that no longer bound a prim
  drop out) and every node that rebuilds geometry where an edge's two points are copied 1:1; subdivide moves them to
  the child edges. Booleans, remesh and other solid ops drop them.
WRANGLE: @group_x works in vertices mode too; invertexgroup(i,"g",v) inedgegroup(i,"g",pt0,pt1) setvertexgroup(0,"g",v,1)
  setedgegroup(0,"g",pt0,pt1,1). Scripts: lib.halfEdges(geo) (edge loops/rings, one-rings, boundaries), lib.EdgeSet,
  lib.evalEdgeGroup(geo, pattern), lib.convertSelection(geo, from, to, sel, include).
Groups produced by nodes: poly_extrude front/side, poly_bevel bevel/bevel_corner (+ edge group bevel_edges), extrude top/bottom/side, boolean from_a/from_b, sweep caps/sides,
clip above/below/cap, fill_holes filled, lsystem leaves/J/K/M, voronoi_fracture inside, knife cut (edge + point) and
above/below, polysplit split (edge + point), edge_divide divided, polybridge bridge, polyfill fill, dissolve dissolved,
edge_collapse collapsed. Create custom ones with "group".`,

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
sdf_expr: write the distance in JS: p = [x,y,z]; return a number. Inputs via sdf(0, p), sdf(1, p).
  IQ-style helpers: sdSphere(p,r) sdBox(p,[hx,hy,hz]) sdRoundBox(p,b,r) sdTorus(p,R,r) sdCapsule(p,a,b,r) sdCylinder(p,h,r)
  sdCone(p,h,r) sdEllipsoid(p,[rx,ry,rz]) sdPlane(p,n,h) sdOctahedron(p,s) sdHexPrism(p,[r,h]) sdSegment(p,a,b,r)
  opUnion opSubtract(a,b) opIntersect smin/opSmoothUnion(a,b,k) smax opSmoothSubtract(a,b,k) opRound(d,r) opOnion(d,t)
  opRepeat(p,[cx,cy,cz]) opTwist(p,k) opBend(p,k) opTranslate(p,t) opRotateX/Y/Z(p,radians) opMirrorX(p)
  plus all wrangle math (add, sub, mul, noise, fbm …).
Example: {"type":"sdf_expr","params":{"code":"const b = sdBox(p,[0.6,0.3,0.4]); const s = sdSphere(sub(p,[0,0.35,0]),0.35); return smin(b, s, 0.15) + 0.03*noise(mul(p,6));"}}
Then: {"type":"sdf_to_mesh","in":["that"],"params":{"divisions":120}}. Set bounds_min/bounds_max to enclose the shape.`,

  heightfield: `HEIGHTFIELDS (terrain; Houdini's HeightField model, exports to Unreal Landscape)
A heightfield is a volume carried in the geometry (like an SDF), not polygons: a regular grid of samples in the XZ
plane, Y up, with named float layers. Samples sit on grid nodes: size 20 at resolution 0.1 = 201 × 201 samples (Unreal
counts landscape vertices the same way). Layers: height (world Y), mask (0..1 selection), flow, sediment, debris, water
(written by heightfield_erode), path (heightfield_path) and any user layer (rock, snow …).
WORKFLOW
  heightfield {size, resolution} → heightfield_noise {fractal: "ridged", amplitude, element_size, range: "positive"}
  → heightfield_erode {iterations: 60} (gullies and sediment fans; writes flow, sediment, debris, water)
  → heightfield_path (road along a curve, writes "path") · heightfield_project (stamp meshes/curves: plateaus, ridges)
  → heightfield_mask_by_feature (slope/height/curvature/direction/flow/occlusion) → heightfield_scatter → copy_to_points
  → heightfield_to_mesh {color: "terrain"} for polygons (layers become point attributes), or export png16.
  Other sources: heightfield_from_mesh (project polygons along Y), heightfield_from_image (8/16-bit PNG).
  Layer tools: heightfield_layer (expression over layers "height * mask + 2", or copy/rename/delete/fill), remap, blur,
  terrace, clip, cutout, mask_noise, mask_blur, mask_expand, resample (e.g. samples [505, 505]), transform (translate,
  scale, 90° turns; the generic transform node works too), to_sdf (solid terrain for caves/overhangs with sdf_combine).
MASKS: every mask node combines with the existing mask (mode replace/add/subtract/multiply/max/min): chain them,
  multiply = and, max = or. Most layer nodes take mask_layer to blend their effect by a mask.
  e.g. rocks on steep slopes off the road: mask_by_feature slope 33° → heightfield_layer {layer:"mask", expression:"mask * (1 - path)"}.
EROSION: droplets (rain_density per sample per iteration, rain_amount, erosion_rate, deposition_rate, sediment_capacity,
  evaporation, inertia, gravity, max_lifetime) + thermal (thermal_talus_angle, thermal_rate); hardness_layer (1 = rock),
  freeze_layer (1 = untouched); boundary closed conserves material. Deterministic per seed. Cost ≈ samples ×
  rain_density × iterations × 30 steps (512² × 100 iterations ≈ 2–3 s). Stronger: more iterations or sediment_capacity.
RENDER / INSPECT: render draws heightfields as a shaded grid (the mask in red); color_by any layer name. inspect and
  every cook summary list the grid and each layer's min/max/mean.
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
See them: render draws instances (an evenly spread subset above 600k triangles, with a note "rendering 9.5k of 30k
  instances"); inspect/build summaries say "packed: N instances of K sources (M triangles expanded)".
Export: glb/gltf → EXT_mesh_gpu_instancing (one mesh + node per source, named like the source's prim "name",
  TRANSLATION/ROTATION/SCALE per instance, anchor attributes as _NAME instance accessors (Cd → _COLOR); shear is
  approximated with a warning); usda → one PointInstancer (prototypes = sources, protoIndices, positions, orientations,
  scales, ids, velocities, primvars per instance); geo → Houdini PackedGeometry prims sharing embedded sources;
  csv / points.json → one row per instance (instance stream: Position/Rotation/Scale or P/orient/scale, Mesh column)
  + <name>.meshes.json + one GLB per source; json keeps them losslessly; obj/ply/stl expand them (warned).
  instancing:"expand" (export option) always writes real geometry (instances:"expand" for csv/points.json only).
  Unreal: instances.csv + meshes for PCG / ISM, or glb instances where the importer supports EXT_mesh_gpu_instancing;
  USD PointInstancer → HISM.
Example (forest): terrain → mask → scatter → orient → prune → copy_to_points {pack:true, variants:"name", variant_weights}
  with trees = merge of three meshes named pine/fir/oak (examples/forest.json; help topic "pcg").`,

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
  WASM loads lazily through the host. roof_skeleton is the footprint-input shelf asset with overhang and thickness.
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
  fillet_curve {radius, type round|chamfer|bezier, segments, group (corner points), angle_min, clamp}   rounds polyline
      corners in 3D (new points in point group "fillet").
  offset_curve_3d {distance, lift, frame rmf|plane, up, corner mitre|round|bevel, both}   parallel curves in 3D:
      rails, kerbs, lanes (both:true = two rails, prim side ±1; frame "plane" keeps them level). offset_curve is the
      2D (Clipper) grow/shrink of CLOSED flat shapes; use offset_curve_3d for open paths or anything not flat.
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

  assets: `ASSETS (reusable custom nodes, like HDAs)
Any graph with vars can be saved as a node type: assets {action:"save", name:"rock_cluster", from_graph:"main"}.
The graph's vars become parameters (add "params": {"var": {"desc": "...", "min": 0, "max": 1}} for docs/ranges).
Inputs: put {"type":"input","params":{"index":0,"label":"surface"}} nodes in the graph.
Then use it like any node: {"type": "rock_cluster", "in": ["terrain"], "params": {"count": 50}}.
Assets are stored as JSON in workspace/assets and load on startup.
SHELF: 35 shipped assets (catalog {category:"shelf"}; help {nodes:["stairs"]} for params), used like nodes:
  {"type": "stairs", "params": {"steps": 12, "style": "open"}}   {"type": "wall_segment", "params": {"windows": 3, "door": true}}
  architecture: wall_segment window_frame door_frame stairs spiral_stairs railing fence pillar arch roof_gable roof_hip
    brick_wall tile_floor hex_grid_floor scaffold beam_truss
  props: crate barrel pallet log rock cliff_block tree_lowpoly bush lamp_post bollard bench sign_post sandbag_wall cable pipe_run
  terrain/PCG: road_strip scatter_rocks forest_patch grass_clumps
  Pivots sit at the base (y = 0, Y up, metres; walls start at x = 0, roofs at the wall top); every piece has prim name and
  material. Curve assets (railing, fence, pipe_run, road_strip) take the curve as input 0, surface assets (scatter_rocks,
  forest_patch, grass_clumps) the surface; unconnected they build a default one. The PCG ones output packed instances.
  To change one: assets {action:"fork", name:"stairs", to:"my_stairs"} copies its graph into the workspace; edit it, then
  assets {action:"save", name:"stairs", from_graph:"my_stairs"} overrides the shelf asset (delete restores the original).`,

  uv: `UV TOOLKIT (uv = vertex attribute (u, v, 0); seams are edges where the corner uv differs)
Which node:
  uv_project   planar/box/cylindrical/spherical projection. Fast, no packing; boxes and simple shapes.
  uv_unwrap    automatic (xatlas): cuts charts by angle/cost, flattens and packs into 0..1. Default for props and
               hard-surface. Keeps polygons; writes prim chart. use_seams:true keeps existing seams as chart borders.
               Big smooth meshes chart slowly: max_chart_area -1 (auto) caps chart size above ~1000 triangles.
  uv_flatten   LSCM (conformal) per chart, charts bounded by YOUR seams: uv discontinuities (use_seams), the
               "seams" edge group, point pairs ({"seams": [[a,b],[b,c]]}), a prim chart attribute, the group border.
               Closed charts / handles are cut open automatically (cut_closed). pins: [a,b] fixes orientation.
  uv_autoseam  experimental: proposes charts (xatlas or normal clustering) → prim chart + point seam; then uv_flatten.
  uv_layout    (re)pack islands: min-area rotation, uniform texel density (scale_mode), padding in texels at
               resolution, udims N for UDIM tiles 1001.. ; island_attrib "chart" packs by chart. Writes prim island.
  uv_transform translate/scale/rotate existing uv.
Typical: geo → uv_unwrap → render {views:"quad_uv", checker:true}.  Manual: delete uv → uv_flatten {seams:[...]} → uv_layout.
SEE IT: render views "uv" (or "quad_uv" = persp + uv): the 0..1 square with a 0.1 grid and UDIM labels, polygons filled
by chart/island colour, island borders yellow, overlapping uv in RED (footer/notes give the overlap %).
render checker:true shades 3D views with an 8×8 uv checker: squares should look square and equal-sized
(stretch = rectangles, density = cell size, mirrored charts flip the red/green gradient).
Export: uv → glTF TEXCOORD_0 (v flipped), OBJ vt, USD primvars:st.`,

  render: `RENDER (pick the overlay that answers your question; everything is off by default)
render {node?, views, …} returns a PNG; build/edit take the same options as render:{…}. The footer names the active
overlays and notes pieces, open edges and back-facing % (also returned as text notes).
VIEWS: "quad" (persp/front/right/top, default) · "turntable" (persp at azimuth 0/90/180/270) · "quad_uv" · a list of
  persp, front, back, left, right, top, bottom, uv, section, persp@<azimuth>. azimuth/elevation/zoom, look_at [x,y,z],
  ortho_scale (world width of ortho views), size (pixels per view), scale 2 (a 2× image).
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
Labels never overlap: ones without room are skipped (note says how many; raise size or lower max_labels).
Examples: render {views:["persp","section"], section_axis:"z", wireframe:"hard", label_groups:true}
          render {views:"turntable", shading:"matcap"} · render {glyphs:"N", clip:{axis:"x", offset:0.5}}
CLI: --wireframe all --section y:0.5 --clip x:0.5 --glyphs N --labels groups,pieces --shading matcap --legend --size 1600 --scale 2`,

  export: `EXPORT
export {path:"exports/thing.glb"} — format from the extension:
  glb / gltf    glTF 2.0 via gltf-transform (recommended for Unreal, Blender, web)
  geo           Houdini JSON geometry: every attribute (all classes), group and polyline, lossless (precision 64 or 32)
  csv           point stream, one row per point: P.x,P.y,P.z,N.x,…,pscale,name (strings quoted); prims are ignored
  points.json   {format:"polyforge-points", count, attributes:{P:{type,size,data}}} (same schema on import)
  obj usda ply stl json (lossless polyforge)
Options: up_axis "y" (default) | "z", scale (100 = m → cm), split_by_name (one mesh per prim "name", default true),
  custom_attribs, materials (default true), compress "none" | "meshopt" (EXT_meshopt_compression + KHR_mesh_quantization,
  ~3× smaller; for web engines such as three.js/Babylon.js) | "draco" (only with the optional draco3dgltf package),
  quantize (KHR_mesh_quantization alone), attributes ["P","pscale",…] (csv / points.json), pcg / pcg_struct (csv),
  precision 64 | 32 (geo), instancing "packed" | "expand", instances "rows" | "expand" (csv / points.json of packed
  prims), meshes (instance rows: also write one GLB per source, default true). For Unreal and Blender keep the default
  uncompressed GLB.
glTF layout: one node+mesh per "name", one primitive per material. Polygons → TRIANGLES, polylines → one LINE_STRIP each
  (LINES above 256 curves), loose points → POINTS with pscale as _PSCALE. N → NORMAL (else computed, 60° cusp),
  uv/uv2 → TEXCOORD_0/1 (V flipped), Cd (+Alpha) → COLOR_0. Custom attributes: every other numeric point/vertex attribute
  of size 1-4 → _NAME (upper-cased, float or the smallest int type); mesh extras keep the original names and types.
MATERIALS: the material node writes prim "material" + the detail table. Vertex colours win: prims whose Cd is not all
  white export baseColor white × COLOR_0 with the material's metallic/roughness/emissive; otherwise baseColor = the
  material colour. alpha < 1 → alphaMode BLEND; unlit → KHR_materials_unlit; emissive above 1 → KHR_materials_emissive_strength.
TEXTURES: material {base_color_map, normal_map, roughness_map} (PNG/JPEG paths relative to the workspace/graph; the mesh
  needs uv). glb/gltf embed the images (baseColorTexture, normalTexture, metallicRoughnessTexture = roughness in green; a
  map replaces its factor). usda: UsdUVTexture shaders reading primvars:st, asset paths relative to the .usda. geo/json
  keep the paths in the material table. glTF import records texture paths (or "embedded:<name>") without decoding.
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
  Manual import (Unreal 5.8): 1. Landscape mode (Shift+2) > Manage > New > Import from File, heightmap.png. 2. Section
  Size, Sections Per Component, Number of Components from landscape.json; Overall Resolution must match. 3. Location =
  new_landscape_location_cm, Rotation 0, Scale = landscape.scale. 4. One landscape material layer per layers[] entry;
  assign layers/<name>.png in the import panel (or Paint > Target Layers > Import). 5. Import. 6. objects.glb through the
  Interchange glTF import at the origin (X = x, Y = z, Z = y, cm), or meshes/*.glb + instances.csv for PCG / ISM by Mesh.
HOUDINI: File SOP reads .geo (and glb/obj/usd); packed prims are written as PackedGeometry with embedded geometry
  stored once in sharedprimitivedata (layout not yet confirmed against a Houdini-written file: instancing "expand" is
  the safe path). CSV points: Table Import SOP, map P.x/P.y/P.z → P (and other columns).
  A material name becomes a Houdini material path with a wrangle: s@shop_materialpath = "/mat/" + s@material;
BLENDER: File > Import > glTF 2.0 (custom attributes arrive as mesh attributes named _NAME).
PACKED INSTANCES (help topic "instancing"): glb/gltf write EXT_mesh_gpu_instancing with per-instance attributes, usda a
  PointInstancer with per-instance primvars, geo PackedGeometry prims, csv/points.json the instance stream, json keeps
  them; obj/ply/stl expand them. Option instancing "expand" writes real geometry everywhere.
SPLINES (Bezier/NURBS prims, help topic "curves"): every format but json writes the evaluated polylines (closed curves as
  polygons), with a note; json keeps the spline prims. convert_curve first to choose the resolution.
Heightfields: png16 (.png) / r16 (.r16, .raw) heightmaps with a .json sidecar (range + Unreal Landscape scale/location),
mask_png (8-bit weight layers; layers: [...]); height_min/height_max fix the range. See help topic "heightfield".
IMPORT (file node): obj, stl, ply, glb/gltf (meshopt; Draco with draco3dgltf; external .bin; node transforms;
  EXT_mesh_gpu_instancing as packed prims with their _NAME instance attributes on the anchors, instancing:"expand" for
  geometry; names → "name", materials → "material" + table with texture paths), geo and uncompressed bgeo
  (Houdini; embedded packed geometry → packed prims; not .bgeo.sc; volumes and packed disk prims skipped), csv (P.x | x,y,z | P[x] | Unreal Position.X or struct cells), points.json,
  json (polyforge, points stream or Houdini geo, detected). up_axis "z" converts Z-up sources.`,

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
   bbox.min/.max/.size/.center (.x .y .z) volume area pieces open_pieces genus closed boundary_edges).
   on_fail: error (default) | warn | mark → detail assert_failed (count) + assert_report, groups assert_fail;
   then render {highlight:"assert_fail"} shows where. Each assert records stats checks/failed in the cook report.
2. EXPLAIN AFTER A BUILD/EDIT: explain {graph, node?} describes the result in words, e.g.
   "reads as: one closed piece, box-like, 2 × 1 × 1 m, 3 cm thin walls, mirror-symmetric in x, z", then pieces,
   watertight/genus/boundary loops, flipped normals, symmetry planes, principal axis + aspect, sampled thickness,
   degenerate faces, polygon mix, attributes, groups. Compare it with what you meant to build.
3. DIFF TO SEE WHAT A CHANGE DID: graphs {action:"duplicate", name:"main", to:"before"} → edit → diff {a:"before", b:"main"}:
   counts, bbox delta, topology/volume, attribute and group changes, Hausdorff + mean distance, per-point displacement
   (same point count), verdict. a/b: "graph", "graph/node" or {graph, node, frame} (two nodes or two frames work too).
   render:true overlays them: grey = unchanged, blue = only in b, orange = only in a.
4. RENDER for what text cannot tell (proportions, style); inspect for one attribute's numbers.
MEASURE NODES (category measure) turn shape into attributes for masks and colour:
  curvature   type mean|gaussian|principal_min|principal_max|convexity (1/m; normalize → 0..1) — wear on convex edges
  occlusion   mode occlusion → ao 0..1 | cavity → cavity 0..1 | thickness → metres (rays inward; closed meshes);
              optional occluder input — dirt in crevices, scatter masks under overhangs, thin-wall checks
  distance    to a mesh surface, curves or points (second input); signed (inside < 0), max_distance, extra → nearest_prim/uv/P
  e.g. {"type":"occlusion","in":["rock"]} → {"type":"color","params":{"mode":"ramp","attrib":"ao","range":[0,1]}}`,

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
 adaptive size) → uv_unwrap → lod {levels:4, ratios:[1,0.5,0.25,0.1]} (prim lod + name _LOD0…, export split_by_name) or
 decimate {ratio, attributes:"uv N"} for one level. remesh (voxel) only when the input is beyond repair (it drops attributes).
14) Street from shelf assets (help topic assets): road_strip on a line → lamp_post packed onto points_along_curve
 {side_offset, both_sides}; a house = four wall_segment walls (the street-facing one rotated 180°, sides ±90°, door:true
 on the front) + roof_gable/roof_hip translated to the wall top; fence, bench, crate, tree_lowpoly placed with transform
 or copy_to_points; forest_patch on a grid for a park. Whole graph: examples/shelf_street.json.`,
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
  const cats = [...new Set([...CATEGORY_ORDER, 'shelf', 'asset', ...list.map((d) => d.category)])];
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
