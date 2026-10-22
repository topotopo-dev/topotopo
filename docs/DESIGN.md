# TopoTopo design notes

## The question: browser, or a desktop app?

**The browser isn't the limit for SOP-style geometry any more.**

- **Compute.** WebAssembly runs native-compiled kernels at roughly 1–2× native speed, with SIMD and threads (threads
  need cross-origin isolation). manifold-3d (booleans, Minkowski, level sets) and meshoptimizer already
  ship as WASM, and both run unchanged in Node and the browser. OpenCascade (B-rep CAD), CGAL ports, Draco and
  xatlas also exist as WASM.
- **GPU.** WebGPU compute shaders are available for heavy parallel work: point clouds, SDF sampling,
  scattering, and later simulation.
- **Memory.** wasm32 can address 4 GB. Memory64 is shipping, which raises the limit further. That is enough for
  SOP-scale assets. The limits only show up at film-scale VDBs, FLIP or pyro.
- **Files.** The File System Access API in Chromium, OPFS, drag-and-drop and downloads cover a modelling
  tool's needs.

So the right answer is to avoid choosing. Build an **isomorphic core**: pure TypeScript plus WASM, with no DOM and
no Node APIs. Then run that core under several hosts:

| host | used for | status |
|---|---|---|
| Node process + MCP (stdio) | LLM agents: Claude Code, Claude Desktop, any MCP client | **done** |
| Node CLI | batch cooking, CI, pipelines | **done** |
| Browser (engine in a Web Worker) | the future human GUI: node editor, viewport, parameter panels; cannot convert `.blend` (export GLB first) | live viewer with a Controls panel, drop zone and reference layers done (served by the Node process); engine in a Worker and the node editor not built yet |
| Desktop wrapper (Tauri/Electron) | optional, if you want native files, bigger memory, a local GPU | later, same web GUI |

MCP needs a local process anyway, because stdio servers are processes. That means the LLM side runs in Node today, and
the human side can be pure browser with no install. Every Node-specific capability sits behind `src/host/types.ts`
(`Host`): file reading, the script sandbox, and PNG compression. A browser host implements the same interface with
`fetch`/OPFS, a Worker realm and `CompressionStream`.

## Architecture

```
src/core/      geometry model + algorithms (no I/O)
  geometry.ts    Geometry (points/vertices/prims/detail attribute tables, point/vertex/prim/edge groups, SDF, heightfield and image volumes,
                 packed prims), GeoBuilder
  packed.ts      packed primitives: expansion (unpack, auto-unpack, render budget), transform composition, statistics
  splines.ts     Bezier/NURBS curve prims: de Casteljau/de Boor evaluation, derivatives, arc length, closest point,
                 adaptive polylines, exact Bezier ⇄ NURBS conversion, interpolation and least-squares fitting
  geohash.ts     content hash of a geometry (deduplicates packed sources)
  heightfield.ts heightfield volumes: grid + named layers, bilinear sampling, blur, distance transforms, rasterising meshes/curves, to-mesh, render preview
  erosion.ts     erodeStep: droplet hydraulic + thermal erosion over typed arrays (the WASM-replaceable kernel)
  image.ts       image volumes: 2D float grids with named grey/RGBA layers, sampling, resizing, stats, bytes for PNG, JSON
  texture.ts     texture generators and filters over Float32Array layers (patterns, cells, blends, blur, normals, AO …);
                 texnoise.ts periodic 2D noise (perlin/value/worley on a wrapped lattice, simplex on a 4D torus)
  bake.ts        uv-space baking: conservative uv rasterisation with supersampling, resolve + padding, islands, tangents,
                 high-res projection and edge-curvature kernels
  edges.ts       EdgeSet (unordered point pairs, integer keys), unique-edge list
  halfedge.ts    half-edge mesh derived on demand and cached per Geometry: loops, rings, one-rings, boundaries, dihedral angles
  topology.ts    normals (hard edges), triangulation (earcut), edges, connectivity, boundary loops, health report
  bevel.ts       poly bevel on the half-edge fans: chamfer/round strips, mitres, corner patches, exact clamp, point bevel
  groups.ts      Houdini group patterns for all four classes ("top", "!top", "0-10", "@P.y>0", "p3-7", "angle>30", "border:top")
  groupconvert.ts  any/all conversion of selections between point, vertex, prim and edge
  polyedit.ts    polygon-editing kernels: edge-point insertion + face splits (knife, polysplit, edge divide), plane chords,
                 quad rings, chain ordering, bridge, hole fill (quad fan, Coons grid), dissolve, collapse
  remesh.ts      isotropic remeshing kernel (typed arrays in/out: the swap point for a native remesher), closest-point BVH,
                 Geometry wrapper (features, seams, provenance); decimate.ts meshoptimizer decimation; repair.ts mesh repair
  spatial.ts     KD-tree (points), triangle BVH (closest point, rays, inside tests)
  pcg.ts         PCG kernels: incremental point grid, exact min-distance and sphere-overlap selection, k-means / radius
                 clusters, mask bands and combination, image sampling, instance frames (scatter v2, pcg nodes)
  scatter.ts     scatter kernels for the pool: candidate sampling, blue-noise sample elimination (neighbour lists, pairs,
                 conflicts), surface relaxation, KD build; the same code runs single-threaded (bit-identical)
  xpbd.ts        XPBD cloth (drape, inflate): constraint model, stretch chains solved exactly, colour-sorted Gauss-Seidel,
                 tethers, volume, collider contact planes (pseudo-normals; the "cloth_collide" kernel), floor, friction, wind
  analysis.ts    measures: discrete curvature, packet ray casting (occlusion, thickness), closest points on meshes/curves/points,
                 self-intersections, pieces/genus/cavities, PCA, mirror symmetry, Hausdorff sampling (measure nodes, explain, diff)
  particles.ts   particle simulation (the particles node): emission, the per-particle integration kernel (forces, analytic-
                 gradient curl noise, fields, floor and mesh collisions, trail rings), the state as a point Geometry, output
  manifold.ts    Geometry ⇄ manifold-3d (attributes carried as properties, provenance via reserved IDs)
  rbd.ts         rigid-body settling on Rapier: pieces (packed instances, polygon pieces), shapes, the world, write-back
  noise.ts       perlin / simplex / value / worley, fBm / ridged / turbulence, curl
  wrangle.ts     @-syntax compiler → per-element kernels; deferred addpoint/addprim/remove; chunked point wrangles
  kernels.ts     kernel registry for the worker pool: pure per-element functions over typed arrays (noise, rays)
  snippet-lib.ts VEX-like helper library installed into the script realm (vectors, quaternions, noise, SDF ops)
src/graph/     node system
  types.ts       NodeDef / ParamDef / GraphSpec — the schema that drives docs, validation and (later) GUI widgets
  params.ts      name resolution (aliases, case-insensitive, did-you-mean), "=expr" evaluation and reference scanning, coercion
  engine.ts      validation, lazy pull cooking, content-addressed cache, time, subgraphs/assets, concurrent branches
  parallel.ts    CookContext.parallelMap: a kernel in chunks on the host's worker pool, or in one piece without it
  migrate.ts     graph format versions and migrations
src/nodes/     200+ node types, one defineNode() each (typed params with defaults and descriptions, a cooked example)
src/render/    software rasteriser → PNG (labelled multi-view images for LLM vision); texview.ts: the texture view, base
               colour sampling of image textures, and the flat textured quads the live viewer shows for images
src/inspect.ts, src/explain.ts  text views of geometry: summaries, statistics, a "reads as" description, diffs
src/io/        import/export: glTF via gltf-transform (gltf.ts), Houdini .geo/.bgeo (hgeo.ts), CSV + points JSON and the
               instance stream (points.ts), obj, stl, ply, usda, native json; materials table helpers in core/materials.ts ·
               heightmaps (png16, r16, mask_png) · PNG decoder · multi-file exports (files.ts) · Unreal Landscape bundle (unreal.ts) ·
               image volumes to and from PNG files (textures.ts: glTF/USD texture data, the "textures" format, the PNG
               reader behind image_file and the file node)
src/wasm/      loaders: kernels.ts (the Rust kernels, read through Host.readFile), rapier.ts (Rapier, a lazy import)
src/host/      Node host: fs, vm sandbox (timeouts), fonts, worker pool (pool.ts, worker.ts), optional convertFile
               (.blend -> cached GLB through headless Blender), isDirectory/listDir for file-node folder imports
src/mcp/       MCP server, tool implementations, LLM docs; inputs.ts: the inputs tool (what people dropped into inputs/)
src/viewer/    live preview: tiny HTTP + SSE server and the editor page (index.html, a shell loading the ES modules of
               app/; built to design/viewer.md)
src/workspace.ts  the workspace folder: graphs/ (named graphs as JSON), assets/, inputs/ (files people drop in: meshes,
               guide curves and points, PNG masks; listInputs; `topotopo view` passes the inputs/ beside the graph
               file, made by the first drop), exports/; edit operations and edit() (apply, validate, store, cook,
               notify: the one path for the MCP edit tool and the viewer's controls)
shelf/        shipped graph assets (one GraphSpec per file + index.json + thumbs/), registered as category "shelf"
```

### Geometry model
This is Houdini's model, deliberately. The model is general enough for meshes, curves, point clouds and instancing,
and both Houdini users and LLMs already know its conventions (`P N Cd uv pscale orient up name class`):

- **points** hold positions and per-point attributes. **prims** are polygons (closed) or polylines (open), stored as
  CSR (`primStart`, `vertexPoint`). **vertices** are polygon corners, which carry UV seams and hard normals.
  **detail** holds one value per geometry.
- Attributes are typed arrays (float/int with tuple size 1–16, or strings) with Houdini default values.
- **Array attributes** (`float[]`, `int[]`, `string[]`) hold a variable-length list per element: neighbour lists,
  piece membership, per-point samples. Storage is CSR, like prims: `offsets` (count + 1) into one flat
  `Float64Array`/`Int32Array`/`string[]`, so a million short arrays cost two typed arrays rather than a million
  objects. `Attribute.get(i)` returns a copy as a JS array and `set(i, list)` takes any length. A set that changes a
  length does not shift the tail: the attribute switches to a loose layout (per-element start and length, entries
  appended to storage that grows geometrically), and `compact()` restores canonical CSR. Clone, gather, merge, IO
  and fingerprints compact first. Arrays are never interpolated: `GeoBuilder` copies the single source's array, or
  the heaviest source's for a blend; `merge` gives inputs without the attribute empty arrays and unifies the entry
  type (string over float over int; a fixed tuple in another input becomes an array of its components). Wrangles bind
  them with `f[]@`/`i[]@`/`s[]@`, reading a copy and writing it back after each element.
- **Groups exist for all four Houdini classes.** Point, vertex and prim groups are byte masks (one byte per element).
  **Edge groups** are `EdgeSet`s of unordered point pairs (`edgeKey(a, b) = min·2^26 + max`, a safe integer), the
  representation Houdini uses. An edge needs no id of its own, so edge groups survive anything that keeps point
  numbers (transforms, deformers, attribute nodes). Point renumbering remaps them: `subsetPoints`, `fuse` and `sort`
  remap, `merge` and copies offset, and deleting prims drops the pairs that no longer bound a prim. Group patterns cover all four
  classes (`p3-7`, chains, `boundary`, `angle>30`, `border:grp` for edges), and naming a group of another class
  converts it with Houdini's any/all incidence rules (`groupconvert.ts`).
- **Half-edge structure.** `halfEdges(g)` derives a half-edge mesh from the closed polygons as typed arrays: origin,
  face, next, prev, twin, per-point and per-face entry points, and an undirected edge index. It is built lazily and
  cached per `Geometry` object in a `WeakMap`. Geometry is immutable once cooked, so the cache stays valid; it is also
  revalidated against the identity of the topology arrays. Non-manifold edges and inconsistent winding are recorded
  rather than thrown. Loops, rings, one-rings, boundary walks and dihedral angles are queries on it, and modelling
  operations such as bevel, polysplit and bridge build on it. Edge ids follow first occurrence while walking prims,
  which is the order that edge index ranges in patterns address.
- **Packed primitives** (instances) are Houdini's packed prims: a prim of kind 1 (`primKind`) with one vertex on an
  anchor point, a reference to a shared, immutable source `Geometry` (`packedSources[packedSource[p]]`) and a 3×3
  rotation·scale (`packedXform`, column-major); world = translate(anchor `P`) · packedXform · source. The per-prim arrays
  are allocated lazily (absent = none) and travel with `clone` (sources shared), `merge` (sources deduplicated by
  identity and by a content hash, indices remapped, never copied), subsets (an instance lives while its anchor point and
  vertex do; unused sources are dropped) and `GeoBuilder` (a one-vertex prim copied from a packed prim stays packed).
  `bbox()` covers each instance's transformed source box, not the anchors. A `NodeDef` declares `packed: 'keep'` when
  it handles instances (transform and point deformers move anchors, transform also composes into `packedXform`;
  attribute, group, delete, merge and flow nodes work on the instance level); for all other nodes the engine expands
  the inputs first (`expandPacked`, cached under the input signature) with one warning. Expansion copies sources
  through `Geometry.merge` in instance order, transforms P/N/v/up/orient per instance and copies anchor attributes
  where the source has none. The renderer expands within a triangle budget (an evenly spread subset beyond it); glTF
  writes `EXT_mesh_gpu_instancing` (anchor attributes as `_NAME` instance accessors), USD a `PointInstancer` (ids,
  velocities, per-instance primvars), Houdini `.geo` `PackedGeometry` prims whose sources are stored once in
  `sharedprimitivedata`; CSV and points JSON write the **instance stream**: one row per instance with the decomposed
  transform (P, orient, scale; Unreal Position/Rotation/Scale for PCG), a `Mesh` column naming the source and the
  anchor attributes, plus a sidecar mapping `Mesh` to one GLB per source. Sources are named alike in every format
  (`packedSourceNames`: the source's single prim `name`, else `source_<i>`). Formats without instancing expand.
- **Spline primitives** are the prim kinds 2 (Bezier curve) and 3 (NURBS curve) in the same `primKind` array as packed
  prims (Houdini's BezierCurve / NURBCurve). The prim's vertices are its control points (CVs) in order and `primClosed`
  says whether the curve is closed; everything else is ordinary attributes, so it survives every generic operation:
  the order (degree + 1) is the prim int `spline_order` (default 4), a NURBS knot vector the prim `float[]` `knots`
  (open: n + order knots, clamped by default; closed: periodic, n + 1 breakpoints), rational weights the point float `Pw`
  (default 1). Bezier curves are Houdini-style segments of `order` CVs that share their end CVs (7 CVs of order 4 = two
  cubic segments). Spline prims have packedSource −1 and an identity packedXform, and code must test packed prims with
  `primKind[p] === 1` (`isPacked`), never by truthiness. Clone, merge, subsets and `gatherPacked` keep the kinds;
  `GeoBuilder` does not (a prim it builds from a spline prim is a polygon/polyline, so resampling or offsetting nodes
  produce plain curves). Evaluation lives in `core/splines.ts`: de Casteljau per Bezier segment, de Boor in homogeneous
  coordinates for NURBS, basis derivatives for tangents and curvature, Gauss–Legendre arc length per span, Newton closest
  points, and polylines by adaptive subdivision (each chord within a tolerance, default 1/2000 of the CV box diagonal).
  A knot vector that no longer fits (a CV deleted) is replaced by a uniform one with a note rather than failing.
  A `NodeDef` declares `splines: 'keep'` when it handles spline prims; by default nodes that keep packed prims also keep
  splines (they move points or edit attributes and groups, so transform and deformers move CVs exactly as Houdini does),
  and the curve nodes that sample curves themselves (resample exactly by arc length, carve, ends, sweep, polywire, the
  spline toolkit) keep them too. For every other node the engine converts spline prims to polylines before cooking,
  cached under the input signature, with one warning — the same hook as the packed auto-unpack, chosen over a separate
  mechanism so a node has one place that says what geometry it accepts. The renderer draws splines as their polylines
  (inside `expandForRender`), exporters write them as polylines with a note (`json` keeps them losslessly; `.geo` writes
  `PolygonCurve_run`, not NURBCurve/BezierCurve), and summaries name them ("2 Bezier curves").
- **SDF volumes** travel inside the geometry as lazy sample functions, so implicit modelling composes like any other node.
- **Heightfield volumes** are the second volume kind (`Volume = SdfVolume | HeightfieldVolume`, `core/heightfield.ts`),
  Houdini's terrain model: a regular grid of samples in the XZ plane, Y up, with named `Float32Array` layers (`height`
  in world Y, `mask`, `flow`, `sediment`, `debris`, `water`, user layers). Samples sit on grid nodes: sample (i, j) is at
  `origin + (i, j) × cellSize`, so a W × H field spans (W − 1) × (H − 1) cells, which is how Unreal Landscape counts
  vertices; layers are row-major (`j × width + i`). `sample(x, z)` / `sampleLayer(name, x, z)` interpolate bilinearly.
  `Geometry.clone()` and `merge()` give each heightfield its own layer map but share the arrays (copy-on-write: nodes
  write through `Heightfield.writable(name)`), and `bbox(true)` includes the field. The renderer and the live viewer
  draw a heightfield through its preview mesh (decimated to at most 256² quads, layers as point attributes, mask in
  red); `heightfield_to_mesh` and `heightfield_to_sdf` convert it. Erosion lives behind one function,
  `erodeStep(field, params, rng)` in `core/erosion.ts`, over plain typed arrays (particle droplets + thermal talus
  relaxation, deterministic, mass-conserving with closed borders), so a WASM kernel can replace it. Export writes
  16-bit PNG / RAW heightmaps with a JSON sidecar holding the range and the Unreal import scale (`io/heightmap.ts`),
  and `io/png-decode.ts` is a dependency-free PNG decoder (inflate included) for heightmap, mask and image import.
  `heightfield_fill_sinks` calls the Rust priority-flood kernel over eight neighbours; `fill` is added terrain depth
  and `lake` is retained standing water depth in metres. A positive `max_depth` preserves an entire connected
  depression if its deepest point exceeds the limit, with no partial clipping of the lake bed. No-fill masks
  have 0..1 values: samples at 1 are untouched terminal outlets, and lower values remain eligible for filling.
  Protected outlets and retained lakes are exceptions to border drainage.
  Zero-epsilon filling retains flats and returns acyclic receiver directions; positive epsilon gives every
  unrestricted interior cell a lower neighbour. `heightfield_flow.fill_sinks` uses a virtual filled surface,
  leaving height unchanged. Stream-power erosion can use the same routing; pipe methods seed water from a lake
  layer and update lake depth within its original footprint to match simulated water. Legacy droplet water is
  still a normalised resting mask. See `kernels/README.md` and `examples/drainage.json`.
- **Image volumes** are the third volume kind (`Volume = SdfVolume | HeightfieldVolume | ImageVolume`,
  `core/image.ts`): Substance Designer / Houdini COP textures. A width × height grid of float pixels with named layers
  of 1 (grey) or 4 (RGBA, interleaved) channels; "C" is the image itself, nodes add others ("id" random per cell, "mask"
  bake coverage, "convex"/"concave", "distance"). Pixel (i, j) is column i, row j from the top, row-major, so rows go to
  PNG in order and glTF's flipped t needs no flip; texel centres sit at u = (i + 0.5) / W, v = 1 − (j + 0.5) / H.
  Images are not placed in space (empty bounds, skipped by bbox and transform) but otherwise behave like heightfields:
  `clone()`/`merge()` give each its own layer map sharing the arrays (nodes replace a layer, never write into it), the
  JSON format stores layers as base64 float32, fingerprints hash every layer, inspect lists size and per-layer ranges.
  **Values are written as they are** (round(v × 255) in 8-bit files; no transfer curve). Data maps are linear by
  nature; colour layers hold display values exactly as colour params and Cd do (`"#a5462e"` → 0.65, 0.27, 0.18, and the
  renderer shows those numbers), so a base colour PNG has the bytes of the colours that made it and glTF/USD read it
  as sRGB as they require. Colour *values* are different: glTF's baseColorFactor, emissiveFactor and COLOR_0 and USD's
  colour inputs and displayColor are linear, so those exporters decode display values to linear on the way out (the
  glTF importer encodes them back, losslessly); `.geo` keeps Houdini's raw Cd for now (dogfood log, colour space). The alternative, linear colour in memory with sRGB encoding on export, would need a
  colour-space tag per image (is this RGBA a colour or a normal map?) and would make texture colours disagree with the
  same hex in a material or a Cd attribute everywhere the engine shows them; blending in display space is also what
  Substance Designer and image editors do by default.
  PNG files read back the same way: `image_file` (and the `file` node for `.png`, with its defaults) stores sample / max
  with no curve, keeping 16-bit precision, so colour PNGs (sRGB by convention) and data maps both load as the numbers
  they hold and a PNG the engine wrote reads back unchanged; its `srgb: false` exists only for files of linear-light
  colour, whose grey and RGB it encodes to display values (never alpha). Grey files (1–2 channels) load grey by default,
  colour files RGBA, and a grey image keeps the file's alpha in layer "A". The live viewer cannot draw a bare image, so
  its GLB routes turn image-only geometry into flat unlit quads (`withImagePreview`, render/texview.ts) whose materials
  are named "image:<name>"; the page keeps their pixels when it ghosts reference layers.
  Materials reference images as `image:<name>` texture paths (`texture_to_material`, or any material map path); the
  exporters encode them from memory: glTF embeds PNGs (an `orm` slot is both `occlusionTexture` and
  `metallicRoughnessTexture`), USD writes `<name>_textures/<image>.png` next to the `.usda` (`io/files.ts`), and the
  `textures` format writes every image as a PNG; `.geo` and the mesh formats skip images with a note.
  **Generators** compute every pixel from its centre independently (seeded hashing, periodic noise lattices for
  tileable output), so `tex_noise` and `tex_cells` run in chunks on the worker pool with identical bits. **Filters** read
  one layer of one image of input 0 (`image`/`layer` params), write the result into that layer, and pass everything else
  through; inputs of other sizes are resized to the first (bilinear up, area average down); `tileable` makes
  neighbourhood filters wrap. **Bakes** (`core/bake.ts`) rasterise the mesh's triangles in uv space at `supersample`²
  samples per texel (centre test, then conservative coverage: a texel whose square touches a triangle takes its closest
  point), evaluate only covered samples (positions and normals interpolated; rays through the existing `occlusion`
  kernel; the high-res projection along averaged-normal cage rays in `bake_project`; edge curvature in
  `bake_curvature`), average them per texel (coverage → layer "mask") and dilate the islands by `padding` texels with
  the exact distance transform. Curvature is measured from the mesh's dihedral angles in 3D, not from a normal map, so
  uv seams do not show: every edge carries its signed bend (angle / 90°) and a texel sums the bends of the edge length
  within a radius under a (1 − d²/r²)² kernel, normalised so a 90° edge through the texel reads 1 (a smooth surface of
  radius R reads about 1.25 r / R).
- **GeoBuilder** records the *provenance* of each new element: a source index or a weighted blend. On `build()`,
  every attribute and group of the source is interpolated automatically. That is why subdivide, extrude, resample,
  clip, sweep and the rest preserve `uv`, `Cd` and custom attributes without per-node code. Point and prim groups
  follow the dominant source. A vertex group follows corners that copy a single source vertex. An edge group follows
  new edges whose two points each copy a single source point when those two points formed a grouped edge; blended
  points drop out. Nodes that split edges add the child edges explicitly (subdivide does).

### Cooking
- Graphs are pulled lazily from the output node, so unconnected branches cost nothing.
- Every result is cached by a **content signature**: `hash(type, resolved params, input signatures[, vars][, references])`.
  Editing a parameter re-cooks only what is downstream. Foreach iterations with identical inputs, and repeated asset
  instances, are cached for free. Nodes whose code or nested bodies read graph vars (`usesVars`: wrangle, script,
  foreach, solver, …) include the vars.
- Errors are per node, with hints. Downstream nodes report "input failed" instead of cascading noise.
- Cooked geometry is immutable by convention. Nodes `clone()` before writing.
- `switch` cooks only the selected candidate (`NodeDef.inputsUsed`: params are resolved first, the unused inputs are
  not cooked and count as `unused` in the signature), so an unselected branch costs nothing and may even fail.

**Concurrency.** When the host has a worker pool (`Engine.concurrent`), `cookOne` starts the pulls of all inputs of a
node at once, together with its params (and the nodes their expressions reference), and `foreach` runs a window of
independent iterations at a time. Node cooks still run on the main thread (they need the realm and the registry), so
branches overlap where a cook awaits: a chunked kernel on the pool, file I/O. Two rules keep this invisible:
- **One cook per signature in flight.** `Engine.inflight` maps a signature being cooked to its promise; a second cook
  of it (an identical node in another branch, an identical foreach iteration) waits and reports a cache hit, as it
  would after a sequential cook. If the shared cook fails, the waiter cooks itself. A nested cook does not wait for an
  ancestor (`CookOptions.ancestors`, passed by `subcook` and `inputAt`), so a recursive asset still hits the depth
  limit instead of deadlocking.
- **Sequential reports.** After the target is cooked, `cook()` waits for every pull it started and rebuilds
  `report.results` in the order a one-input-at-a-time cook visits nodes, dropping nodes such a cook would not have
  reached (it stops at a node's first failed input or reference); results that shared an in-flight cook swap roles so
  the first one in that order is the one that cooked. Results, errors and warnings are therefore the same with and
  without the pool (test/pool.ts compares them; the golden and property layers pass in both modes).
Without a pool (`TOPOTOPO_WORKERS=0`) inputs are pulled one at a time, exactly as before.

**Time.** A cook happens at a frame (`CookOptions.frame`/`time`/`fps`; frame 1 = time 0, 24 fps by default), exposed
to nodes as `ctx.frame`, `ctx.time`, `ctx.fps`, `ctx.timeInc`. Time enters a signature only for nodes that depend on
it, so everything else stays cached across frames:
- `NodeDef.usesTime` nodes (the solver) always;
- nodes whose `"=expr"` params read `frame`, `time`, `fps` or `timeInc` (the expression scope records the read);
- nodes whose cook reads `ctx.frame` & co. The context getters record the read: a wrangle passes time only when its code
  references `@Frame`/`@Time`/`@TimeInc`, a script only when it reads `lib.frame` etc., and foreach/asset/graph_ref
  bodies cooked through `ctx.subcook` propagate their body's dependence. Because this is only known after cooking, the
  engine first looks the node up under its time-free signature; a node found time-dependent is re-keyed with the time
  and its base signature is remembered (`timeDeps`), so later cooks go straight to the time-mixed key.
- `NodeResult.timeDependent` also covers dependence through inputs and references; `input` nodes of a body are not
  time-dependent themselves (the parent's input signature already carries it).
`cookFrames(graph, {start, end, step}, cb)` cooks a range in order with the shared cache.

**Solver.** Houdini's SOP solver: cooking frame N runs the body for frames `start_frame..N` (times `substeps`), feeding
each result back as body input 0. Frame states are chained by signature: `S(start-1) = hash(params, vars, initial
input at start_frame)`, `S(f) = hash(S(f-1), f, extra-input signatures at f)`. Each state is cached under `S(f)`, so the
solver resumes from the latest cached frame (10 → 11 runs the body once) and earlier frames are cache hits. Extra
inputs that are time-dependent are re-cooked at each simulated frame (`ctx.inputAt`); inputs inside a nested graph are
taken at the parent's frame. `foreach` with feedback is the count-based, time-free counterpart.

**Expression references.** `npoints nprims nvertices bbox centroid detail point prim` read cooked geometry of another
node of the same graph (or body), `ch` reads another node's resolved param. A regex scan of the `"=expr"` strings finds
them before cooking (node names must be string literals). They are hidden dependencies: validation reports unknown
names (did-you-mean), unknown `ch` params and cycles over a combined graph where a node's cook depends on its inputs
and its params, and its params depend on the geometry (or params, for `ch`) they read. Referenced nodes cook before
the param is resolved, and their signatures (for `ch`, the referenced value) are mixed into the reader's signature.
Graph `vars` may not use these functions; `dryRun` reports such params as deferred.

**Versioning.** `GraphSpec.version` (current `GRAPH_VERSION = 1`). `migrateGraph` applies registered migrations in
order and stamps the version; unversioned graphs are version 0. It runs on whole documents (Engine.cook at depth 0,
workspace load and save, MCP build, asset registration); nested bodies belong to their parent document, so migrations
walk into them (`forEachNode`). `NodeDef.deprecated` names the replacement: the catalog hides such nodes unless asked,
`help` shows the notice, and cooking warns.

### Host and script sandbox

User code (wrangle kernels, `script`, `sdf_expr`, parametric expressions) is compiled into one scripting realm per
host (`Host.compile`), which has the snippet library installed. In the Node host it is a `vm` context created with
`DONT_CONTEXTIFY` (an ordinary global object, so global lookups in hot loops stay fast) and
`microtaskMode: 'afterEvaluate'`: the realm has its own microtask queue, drained at the end of every `runInContext`
call and inside that call's timeout.
- The realm is set up once, before any user code, by `SCRIPT_REALM_SETUP` (`src/core/snippet-lib.ts`): it installs the
  snippet library and declares the realm's control object `__topotopo` as a global `const`, a frozen object of realm
  functions (`run`, `setJob`, `setCur`). The job of a timed call and the wrangle's geometry API (what `point()`,
  `addpoint()` … dispatch to) are closure variables behind it. After setup the host never reads or writes a property
  of the realm's global object, which user code can redefine: until R-18 the job and the API were the globals `__job`
  and `__cur`, written outside the time limit, and a script that gave them a looping setter hung the process (in a
  pool worker, the worker). A global `const` can be neither reassigned nor shadowed at the top level, where user code
  never runs.
- `runGuarded(fn, ms)` runs synchronous code (wrangles, parametric expressions, `heightfield_layer` expressions over a
  whole layer, the `sdf_expr` probe at the origin) in a timed call. Code pasted into a wrapper function is parsed on
  its own first (`Host.checkSyntax`; the `script` body through the realm's `AsyncFunction` constructor, which rejects
  a body that closes its function), so it cannot close the wrapper and run while compiling, outside the timeout.
- What user code throws is user code too: a `message` or `stack` getter, a `toString`, a realm's
  `Error.prepareStackTrace`. `runUserCode` (`src/core/usercode.ts`) catches inside the timed call and reads the
  message and stack there, so the node (and a pool worker running a point wrangle) only ever handles plain strings;
  it also tells the host's timeout apart from a user error that merely says "timed out". The `script` node reads its
  rejection reason with another timed call (`describeGuarded`, the rest of the time limit).
- An `sdf_expr` field is sampled long after its node has cooked, by `sdf_to_mesh` (from inside manifold's WASM
  level-set mesher) and `sdf_grid`. Volumes whose `sample` runs user code carry `scripted: true` (kept by
  `transform`, `sdf_modify`, `sdf_combine`), and those nodes run the whole evaluation in one timed call (`evalSdf`);
  analytic volumes run as before, unlimited and without overhead. The sampler also checks the deadline itself every
  64 samples and throws an ordinary exception, so a merely slow field stops between samples; the watchdog, armed
  `min(ms, 2 s)` later, only stops a sample that never returns (it then unwinds through the WASM mesher, whose working
  memory is not freed; manifold keeps working).
- `runGuardedAsync(fn, ms)` runs the `script` node. Its synchronous part and every continuation queued inside the
  realm (`await 0`, `await` on a realm promise) run in the first timed call, so `await 0; while (true) {}` is stopped
  like a synchronous loop. With the default shared microtask queue, continuations ran after `runInContext` had
  returned, outside the timeout, and such a script hung the process (and the MCP server). A promise from outside the
  realm (`lib.run` of an async node such as `script`, `file` or `foreach`) settles in the main queue, and the realm
  continuation it releases waits in the realm queue until the host drains it with another timed call: `lib.run`
  calls `wake` when such a promise settles, and a 15 ms poll covers anything else. The whole run, time spent in
  awaited engine calls included, has a wall-clock deadline, so `await new Promise(() => {})` or an endless chain of
  awaits also fails the node. After the run, `lib.run` refuses to cook, so a continuation left over from a timed-out
  script dies at its next call. Subscribing to the run's promise also happens in the first timed call: `then` is
  looked up on the realm's `Promise.prototype`, which a script can replace with a loop (R-17).
- What a script hands back is read after the timed call: its result, and the inputs and params of a `lib.run` of an
  async node (which cooks on in the main queue). `instanceof Geometry` on a Proxy runs its `getPrototypeOf` trap, so a
  returned Proxy hung the process (R-17 N2). Geometries now carry a brand (a WeakSet filled by the constructor and
  `Geometry.blank()`, which replaces `Object.create(Geometry.prototype)` in the fast paths): `isGeometry` runs no
  code of the value, the script node and the engine accept only branded results (with their original prototype), and
  `lib.run` refuses unbranded inputs and copies its params with `structuredClone` inside the call (getters run there;
  a Proxy or a function is refused without running it). A script still holds engine objects (`lib.Geometry`, its
  inputs) and can change them; that stays in the "not a security boundary" gap.
- `lib.run` is wrapped in a realm-side async function: a synchronous node's result resolves a realm promise, so
  `await lib.run('box')` continues inside the same timed call with no drain. Only async nodes cost a drain, about
  0.2 ms each (a `vm` timeout starts a watchdog thread per call).
- Unhandled rejections of realm promises (an un-awaited `lib.run` that fails, an async callback that throws) are
  dropped instead of taking the process down; any other unhandled rejection is re-thrown as Node does by default.
- `checkSyntax(body)` parses a function body without running it (`vm.compileFunction`). Wrangle snippets go
  through it before their kernel is generated: error positions are then the user's own lines (an unclosed `[`
  points at the line that opened it), and only a complete function body is pasted into the kernel, so a stray `}`
  can no longer close the kernel's wrapper.

**Expressions** (`"=expr"` params and the `assert` expr, `src/graph/expr.ts`) used to be compiled with `new Function`
in the engine's own realm, with no timeout and every global in reach, so any graph JSON could run arbitrary code. They
now go through `Host.exprSandbox`, which in the Node host is a second vm realm used by nothing else, created on first
use (`DONT_CONTEXTIFY`, `microtaskMode: 'afterEvaluate'`).
- The engine builds the expression library inside that realm (`exprRealmSetup`, compiled from its source text like
  the snippet library) after locking the realm down: the Function constructors (`fn.constructor` of plain, async and
  generator functions) throw, and every built-in reachable from the global object and from the hidden iterator and
  generator prototypes is frozen (about 800 objects, ~3 ms once per host). An expression therefore only ever holds
  objects of that realm: vars are copied in (frozen, once per node), the reference functions (`npoints`, `bbox`, `ch`
  …) get primitives and their results are copied in, results and error messages are copied out. A single object of
  the engine realm would do, since its `.constructor.constructor` is the engine's `Function`.
- Every free identifier resolves through a scope proxy (`with`) whose `has` claims every name, so nothing reaches the
  realm's global scope: vars, then the helpers (`sin` … `pick`, `Math`, the reference functions), then
  `frame`/`time`/`fps`/`timeInc`; any other name throws (`process is not available in expressions …`). The expression
  is the body of a strict function called with a `this` that throws when read; `import` is rejected before compiling;
  assigning to a name throws. Unless it is straight-line (below), the body is syntax-checked on its own first, as
  wrangle snippets are, so it cannot close its wrapper. Compiled functions are cached per host by source text.
- Timer: a vm timeout starts a watchdog thread per call (~0.15 ms idle, ~0.5 ms on a loaded machine), which alone
  would make a graph with 1000 expressions several times slower. `isSimpleExpr` admits straight-line code (numbers,
  strings, names, operators, member reads, array literals and at most 32 calls of a bare name or `Math.<name>`, under
  1000 characters): it cannot loop, since vars hold data and every callable name is a helper or reference function,
  and runs without the timer. Everything else (function literals, loops, regular expressions, method calls,
  templates, object literals, assignments) runs in `exprSandbox.run` under `scriptTimeoutMs`, which also covers async
  continuations (the realm's microtask queue drains inside the timed call) and getters of the result or of a thrown
  object (both are read inside the call). All 475 expressions in `examples/` and `shelf/` are straight-line.
- Memo: a timed evaluation records what it reads through the scope (vars and time values, helper names, reference
  calls with their results, as fingerprints). With the realm frozen and vars copied, an expression is a function of
  those reads, except through `Math.random`: one that reads `Math` is never remembered. A later evaluation whose
  reads all give the same values (re-read in order, reference functions called again) returns the remembered result
  without the timed call, so only the first cook of a timed expression, or one whose inputs changed, pays for the
  watchdog thread. Failed evaluations are not remembered; up to 8 results per source text, 256 reads each.
- Compiling: the straight-line expressions of a node are compiled in one script (they cannot contain braces, so none
  can leave its wrapper), about half the cost of a script each; the realm and its lockdown cost ~10 ms per host.
- Error messages name the param and the expression: `param "translate"[1]: expression "=bbox('x').max.y" failed: …`.
- A host without `exprSandbox` (a future browser host that provides none) gets the same wrapper and scope compiled
  with `new Function` in the engine realm: the same names are hidden, but there is no realm isolation and no timeout.
- Wrangles are not sealed the same way: their realm also holds engine objects (the geometry API, attribute arrays),
  so the vm realm limits mistakes there, not attackers (README, Security).

Measured with the shapes of `bench/expr.ts`, the previous evaluation (`new Function`) and the sandbox loaded in one
process and run interleaved (i7-10700K shared with other jobs, so ±25 % noise, see the first row; median of 15, ms).
Cold = geometry cache cleared (expressions already compiled), warm = every node a cache hit, which is dominated by
resolving params; first cook = a fresh process, so every expression is compiled and the realm is set up:

| graph | expressions | cold before → after | warm before → after | first cook before → after |
|---|---|---|---|---|
| no expressions: 1000 transforms (noise reference) | 0 | 78.9 → 99.7 | 37.7 → 42.9 | |
| chain: 1000 transforms, one expression each | 1000 | 78.1 → 87.6 (1.12×) | 44.9 → 42.5 (0.95×) | 127 → 142 (1.12×) |
| wide: 100 transforms, ten distinct expressions each | 1000 | 12.9 → 12.7 (0.99×) | 8.7 → 9.1 (1.04×) | 39 → 51 (1.30×) |
| refs: 100 boxes reading bbox/npoints/ch/centroid | 1000 | 34.7 → 32.5 (0.94×) | 22.0 → 26.7 (1.21×) | 55 → 70 (1.27×) |
| loops: 100 transforms, an arrow function with a loop each (timed) | 100 | 7.5 → 7.2 (0.96×) | 3.7 → 3.5 (0.96×) | 15 → 65 (4.4×) |

The loops row is the price of the timer: ~0.5 ms per timed expression the first time it is evaluated with given
inputs (a watchdog thread per call); re-cooks reuse the remembered results.

Measured (i7-10700K): the wrangle benchmark (`wrangle_1m`) and the `script` fixture cook in the same time as before
(within noise; 1M points 90–116 ms, fixture script ~0.7 ms), 500 `await lib.run('box')` in one script ~9 ms both
before and after. The alternative, running scripts in a `worker_threads` Worker and terminating it on timeout,
costs ~300 ms per worker start (engine modules plus manifold WASM), would need geometry to be serialised for every
input, output and `lib.run` call, and could not share the engine cache; it was not used. The browser host can use a
Worker realm, where `terminate()` is the timeout. (Point wrangles do run in workers now, see the worker pool below:
there only the attribute arrays travel, the workers are already running, and the snippet cannot reach the engine.)

### Resource limits

R-17 found that valid but huge params took the process down or kept it busy for hours (N4): a fatal heap OOM is not
an exception a node can catch, and nothing limited a simulation's time. Since R-18 (`test/limits.ts`):
- **Counts.** Every int param that counts something has a `max` (values above are clamped, like values below `min`);
  the registry scan in the test lists the int params that are not counts (seeds, frames, indices, an offset, a pixel
  height). The maxes keep one node at its max within the default heap, measured: a 2048 × 2048 grid builds 4.2 M quads
  in ~1 GB of builder arrays while 4096 × 4096 ran out of heap, so 2D divisions stop at 2048, box/bound/quad sphere
  divisions at 512 (six faces), 1D curve counts at 10^6, per-element counts (segments per corner or span, sides) at 10^4,
  guards (max_particles, max_faces, max_length …) at a few times their default, limits whose off value is 0 or -1 at
  2^31 − 1. Products of counts are guarded where a per-axis max cannot bound them (`point_grid` ≤ 20 M points, besides
  the existing heightfield, texture and scatter limits). Inputs still multiply (resample count × curves): the guarantee
  is per param, not a per-cook memory budget. `group_expand` also stops once a step changes nothing.
- **Time.** `engine.simTimeoutMs` (default 600 s; `TOPOTOPO_SIM_TIMEOUT_MS` in the MCP server) bounds one cook of the
  long-running nodes, checked from `simBudget` (`src/nodes/util.ts`): rbd every 5 solver steps, drape/inflate every
  step, particles between batches (a batch also ends after about 10 M particle-steps, which does not change the result),
  heightfield_erode's JS path every iteration. remesh_quad and the erosion kernels make one WASM call that nothing on
  its own thread can stop: when the host has a pool and the call is big (≥ 50 k triangles, ≥ 2·10^7 samples ×
  iterations, or any size under `TOPOTOPO_POOL_MIN`), it runs on a pool worker as the task `wasm`
  (`src/nodes/wasmcall.ts`) whose limit is the rest of the budget; past it the worker is terminated and replaced and the
  node fails. The worker runs the same WASM build on copies of the arrays, so the bits are the same (the golden layer
  passes with every such call on the pool). Without a pool those calls still cannot be stopped.

### Worker pool

`Host.pool` (a `WorkerPool`: `size`, `threads`, `run(task)`, `warm()`, `close()`, `stats()`) runs registered kernels on
worker threads. A `PoolTask` names a kernel and carries typed arrays (shared, copied, or moved with `transfer: true`), a
small JSON argument, an element range, optional `shared` read-only data under a content key, and an optional
`timeoutMs`. The Node implementation (`src/host/pool.ts`, workers load `src/host/worker.ts`):
- `TOPOTOPO_WORKERS` threads (default `availableParallelism() - 1`; `0` = no pool, everything as before). Every host
  created with the environment's settings shares one pool; `createNodeHost({ workers })` gives a host its own.
- Lazy: no thread exists before the first task, and a cold pool runs that first job on the calling thread while its
  threads start in the background (~0.3 s for 15 threads, mostly module loading), so a one-shot CLI cook is not
  slower. Threads stop after `TOPOTOPO_WORKERS_IDLE_MS` (30 s) idle and keep the process alive only while busy.
- One task per worker at a time. A kernel error rejects the task with the kernel's name ("kernel "x" failed: …"); a
  wrangle error comes back as the same message the main thread would give (with the snippet line). A worker that
  crashes, or runs past the task's `timeoutMs` (it is terminated), fails only its task and is replaced on demand.
  Workers that cannot start at all make the pool reject with `POOL_UNAVAILABLE`; `parallelMap` then runs here.
- Shared data is sent to a worker once and cached there (LRU of 8 keys); a worker that dropped it asks again.
- The MCP server closes the pool when its client closes stdin (or on SIGINT/SIGTERM), the CLI when it is done.

**Kernel registry** (`src/core/kernels.ts`). Pure functions over typed arrays, no Geometry objects, no realm. A kernel
processes elements `[start, end)` with global indices and writes only their slots of its outputs; per-element
randomness is seeded by the element index, and it does the same floating-point operations in the same order as the
serial code it came from, so any chunking gives the same bits. Each kernel has a size threshold (`minElements`) and
optionally more chunks per worker for uneven work (rays). `selftest.*` kernels exist for test/pool.ts.

**`ctx.parallelMap(kernel, job, opts)`** (`src/graph/parallel.ts`). Without a pool, below the threshold, or with a
cold pool it runs the kernel once over all elements, synchronously, on the node's own arrays (the result is not a
promise, so a node using it stays synchronous). Otherwise inputs, `outputs` (copied in, so skipped elements keep their
values) and `results` (fresh arrays: zeroed) are copied once into SharedArrayBuffers, the range is split into
contiguous chunks (default one per thread), and when every chunk has finished the outputs are copied back. Inputs and
results that already live in a SharedArrayBuffer are handed over as they are (results written in place), for large
arrays that go through several jobs (the density-mask elimination's pairs and neighbour lists). The error of
the first failing chunk in element order is the node's error. `Engine.poolStats` counts pool and serial runs.
`TOPOTOPO_POOL_MIN` overrides every threshold (`1` forces the pool: `npm run test:pool` runs the golden layer so).

What runs in chunks:
| node | kernel | notes |
|---|---|---|
| `noise_displace` | `noise_displace`: the noise values per point (1, or 3 for 3d/curl) | the displacement arithmetic stays on the main thread; when the normals have to be computed from the polygons, that happens on the main thread while four chunks sample the noise |
| `attrib_noise` | `attrib_noise`: the attribute values | |
| `occlusion` (occlusion, cavity, thickness) | `occlusion`: the rays of each point | the BVH is built once on the main thread and shared as arrays (`RayScene.toArrays`), keyed by a content hash; threshold by ray count (32k rays); 4 chunks per thread |
| `tex_noise`, `tex_cells` | `tex_noise`, `tex_cells`: one value per pixel | 64k+ pixels; every pixel from its own centre |
| `bake_ao`, `bake_thickness` | `occlusion`: the rays of each covered texel sample | the low (or high-res) mesh's BVH shared as arrays, as for the occlusion node |
| `bake_normal`, `bake_height` (and the ray / curvature bakes with a high-res input) | `bake_project`: one cage ray per sample into the high-res BVH, plus its point normals | |
| `bake_curvature` | `bake_curvature`: the edges near each sample | edges and their uniform grid shared |
| `wrangle` over points | `wrangle` (host kernel in worker.ts) | each worker compiles the same generated kernel source in its own realm (a Node host with the snippet library); only when the snippet binds numeric attributes and groups and calls none of `GEOMETRY_FUNCTIONS` (point(), neighbours(), nearpoints(), addpoint(), setpointattrib(), print() …), `globalThis`/`this`/`eval`, nor writes `vars`; 64k+ points |
| `particles` | `particles`: each particle through a whole run of steps (forces, drag, collisions, its trail ring) | births are decided first on the main thread, so the particles never interact; the collision BVH and the field (KD tree + v, heightfield gradients, a sampled SDF) are shared as arrays; threshold by particle-steps (200k); 4 chunks per thread (later births run fewer steps) |
| `scatter`, `heightfield_scatter` | `scatter_candidates`, `scatter_elim_neighbours`, `scatter_elim_pairs`, `scatter_elim_lists`, `scatter_conflicts`, `scatter_relax`, `kd_build` (src/core/scatter.ts) | candidate sampling and the JS backend's search/relaxation stages run in chunks, bit-identical to the single-thread path; `scatter` also supports Rust/WASM elimination, ordered minimum-distance selection and projected relaxation through `backend` (see below); `heightfield_scatter` retains its JS path |
| `drape`, `inflate` | `cloth_collide` (src/core/xpbd.ts): each cloth point's contact plane against the collider, once per step | the collider BVH and pseudo-normals are shared as arrays; 4096+ points. The constraint solve (Gauss-Seidel and chain solves, the order is the result) stays on the main thread |

`scatter.backend` is `auto` by default: use the already loaded WASM module, otherwise the existing JS path.
`kernel` explicitly loads it through the host; `js` forces the reference implementation. The cache signature tracks
auto's loaded state. The Rust call retains f64 geometry coordinates, builds its KD tree and weighted interaction
lists, and consumes them through an indexed binary max-heap. Minimum-distance rejection is an ordered incremental
grid pass with optional per-prim capacities. Projected repulsion uses the existing flat triangle BVH and triangle
tie order. Candidate sampling and attribute interpolation remain in TS; large elimination jobs use one warmed
worker with cloned inputs when a pool is present, and otherwise run on the cooking thread; minimum-distance
selection and projected relaxation stay on that thread.
Elimination itself has no hard minimum-spacing guarantee; the separate `min_distance` pass provides that constraint.
See `kernels/BENCH.md` session 12 for parity checks, worker placement measurements and performance limits.

Not in chunks, and why:
- `heightfield_erode`: droplets run one after another over the terrain the previous ones left; a split would change
  the result (no deterministic decomposition of the droplet model).
- `sdf_to_mesh`: manifold's level-set mesher calls the SDF from WASM at grid positions it chooses. Evaluating the SDF
  is ~10% of the cook (128³ torus: 1.83M calls, ~0.1 s of ~1 s); precomputing it would need manifold's grid
  positions bit for bit and still pay the per-call crossing. The rest is the mesher.
- `script` (whole geometry, async `lib.run`, engine cache), prim/vertex/detail wrangles, wrangles that read other
  elements or edit the geometry, and every node without a ported kernel run on the main thread as before.

Measured (i7-10700K, 8 cores / 16 threads; serial = `TOPOTOPO_WORKERS=0`; the node's cook time, best of 5 after a
warm-up, two rounds; other jobs shared the machine, so ±10%):

| case | serial | 7 workers | 15 workers (default) | the serial remainder |
|---|---|---|---|---|
| `occlusion_50k` (32 rays/point) | 2140 ms | 686 ms (3.1×) | 568 ms (3.8×) | BVH build (~0.33 s) |
| `noise_displace_1m` (normal mode, normals from the polygons) | 294 ms | 132 ms (2.2×) | 137 ms (2.1×) | point normals (~0.09 s), clone, copies |
| `noise_displace` 1M, direction mode | 217 ms | 91 ms (2.4×) | 81 ms (2.7×) | clone, copies, displacement |
| `noise_displace` 1M on points with N | 324 ms | 243 ms | 207 ms (1.6×) | `refreshNormals` (~0.09 s) |
| `attrib_noise` 1M, size 3 | 608 ms | 182 ms (3.3×) | 136 ms (4.5×) | copies |
| `wrangle_1m` (one sin per point) | 90 ms | 71 ms (1.3×) | 70 ms (1.3×) | clone, bindings, attribute copies |
| `wrangle` 1M with `noise()` | 255 ms | 115 ms (2.2×) | 110 ms (2.3×) | as above |
| `sdf_to_mesh_128`, all other cases | — | unchanged (within noise) | unchanged | not ported |

The point normals that bound noise_displace are a scatter-add over the vertices, memory-bound and not split: computing
the per-polygon Newell vectors on the pool and summing them here (bit-identical) was tried and saved nothing, because
the sums and the normalisation are most of pointNormals' cost.

### Cloth (XPBD)

`drape` and `inflate` (category `sim`, `src/nodes/cloth.ts`) run the extended position-based dynamics solver of
`src/core/xpbd.ts` from the input positions for `steps` steps of 1/fps s and output the last state with the input's
topology and attributes (P moved, `v`, `rest_P`, `N`, `pinned`). The cook is not time-dependent; a graph animates a
drape by driving `steps` with `=frame` (each frame re-simulates) or feeds a solver.
- **Model.** One particle per point, mass from the triangle areas (`density`, kg/m²) or a `mass` attribute, inverse
  mass 0 when pinned. Polygons are triangulated for the constraints only. Every constraint is in compliance form
  (α = 1/k, α̃ = α/h²), so stiffnesses are physical and do not change with the step size: stretch on the polygon sides
  (N/m), shear on both quad diagonals (N/m), bending across shared edges (bending rigidity N·m scaled by 3|e|²/(A₁+A₂),
  the discrete-shells weight, so it is resolution independent), tethers from every point to its nearest pin
  (`tethers`), and for `inflate` one volume constraint C = V − pressure·V₀ with compliance V₀²/(k·area). Hinges that are
  flat at rest (every hinge of a grid) use the isometric bending of Bergou et al. 2006: q = Σ Kᵢxᵢ over a cotangent
  stencil is a linear vector constraint (no trigonometry, a precomputed denominator; a sweep is ~4× cheaper than the
  dihedral one), its compliance (K₃h)²/k matches ½kθ² for small folds, and a hinge folded past 90° (|q|² > 2(K₃h)²,
  where the quadratic energy ∝ 1 − cos θ stops pulling) is projected with the dihedral constraint instead. Hinges curved
  at rest (the edges of an inflated box) use the dihedral angle towards the input's rest angle (Bridson gradients, well
  defined at the flat state; a polynomial atan2 so the angle has the same bits everywhere).
- **Stretch chains.** Point-wise Gauss-Seidel moves a correction one edge per sweep, so cloth hanging N edges deep keeps a
  steady-state stretch that grows like N²·g·h² (a 1 m cloth on 20 rows, pinned at the top, 4 substeps × 2 sweeps: mean
  strain 6.5 %, max 48 %; a tablecloth over a box: max 100 %+ at the box edges). Over-relaxation made it worse (the PBD
  velocity update turns the overshoot into energy) and a height-ordered sweep turned unstable with one sweep per substep.
  The stretch edges are therefore grouped into straight chains (`stretchChains`: the rows and columns of a quad grid,
  greedy straightest paths on any mesh, each edge in one chain) and every chain is one block whose linearised system is
  tridiagonal and solved exactly (Thomas algorithm, `solveChains`), the block Gauss-Seidel of direct rod solvers. Points
  resting on a contact plane get the mobility w·(I − ννᵀ) in that solve: a correction slides them along the surface
  instead of pushing them in, where the contact projection would undo it (a rope over a box kept its edge link 20 %
  long). A sweep runs the point-wise constraints (shear, bend, tethers, volume, self collision) first and the chains
  last before the contacts, so the stiffest constraint has the last word. Measured (60 × 60 cloth, 150 steps, defaults):
  hanging cloth max strain 3 % without tethers, 0.00 % with them; tablecloth over a box mean 0.9 % (the remaining peaks
  are the one quad that tents over each sharp top corner); over a sphere mean 0.5 %, p99 3.1 % (was 9.2 % / 61 %).
  `inflate` solves stretch point-wise instead: exact chains are inextensible hoops, which buckle into lumps when the
  volume constraint pushes outwards (a sphere at pressure 1.5 ended 24 % out of round), while the point-wise sweep lets
  the skin stretch evenly (1 %). Its target volume also rises along a smoothstep over the first half of the steps: the
  volume constraint is effectively hard, and a jump to the full target threw the skin outwards in one substep.
- **Collisions** are speculative contact planes found once per step (`collideRange`, kernel `cloth_collide`): a point
  within its query radius (1.5 × thickness plus twice its travel in the step) of a collider triangle gets the plane
  through the closest point with the normal towards its side; the substeps keep it `thickness` in front. On closed,
  consistently wound pieces the side comes from angle-weighted pseudo-normals (Bærentzen & Aanæs), so points that end
  up inside are pushed out; on open pieces a point keeps the side it started the step on (a sheet collides from both
  sides). The floor is the plane y = floor_height. Coulomb friction removes tangential motion up to friction × the
  normal correction of the substep. Self collision is point-point with a spatial hash (pairs found per step, minimum
  distance 2 × thickness or the rest distance). Initial overlaps are pushed out without velocity. Point contacts let a
  sharp collider corner poke between cloth points (a tarp over crates showed the crate corners), so sharp convex
  corners of closed pieces facing up (a face normal more than 25° off the pseudo-normal, every neighbour below the
  tangent plane) get a corner-triangle contact per step: the cloth triangle around the nearest contacting point into
  which the corner projects is kept `thickness` in front of it (barycentric shares of the correction). Query cost:
  a point with a contact keeps its plane while it moves less than thickness/4, a point skips the query while the
  distance found at its last query (a miss searches twice the radius) minus its travel exceeds the radius, and the BVH
  search starts from the point's last triangle; on the 100 × 100 drape this halves the query time.
- **Determinism and threads.** The point-wise constraints are colour-sorted (no two constraints of a colour share a point),
  chains run in build order, sweeps within a substep alternate direction starting forward (alternating across substeps
  with one sweep each pumped a period-2 mode: a closed sphere crumpled from a 10⁻³ jitter), and the solve runs on the
  cooking thread. Only the collider
  queries go through `ctx.parallelMap`; they are pure per point, so a cook is bit-identical with and without the pool
  (test/cloth.ts checks it with a forced pool).
- **Limits** (against Vellum): static colliders only; per-point collision plus corner contacts (a sharp collider edge
  can still pass between the points of a coarse cloth, a cloth edge can slip past a thin collider), contacts found once per
  step; folded-over micro-wrinkles can remain where wrapping compresses the cloth (no self collision by default); no tearing,
  plasticity, welds/stitches, attach-to-animated-geometry, cloth-on-cloth friction, or edge-edge self collision;
  `inflate` uses one global volume constraint (no per-piece pressure).

### Particles

`particles` (src/nodes/particles.ts, src/core/particles.ts) is Houdini's POP network reduced to one node: points emit,
forces and fields push, the floor and a mesh collide, trails become polylines. The model is chosen so that it runs on the
worker pool bit for bit and can be cut into frames anywhere:
- **Particles never interact, and nothing that couples them depends on the integration.** Births depend only on the
  emitters, the step and the lifetimes: a rate per step and emitter point with a per-point random phase (fractions
  accumulate), `emit_all` at time 0, and `max_particles`, which counts a particle from its birth through its death step by
  age, also when a `die` collision removed it earlier (those keep their slot in `__pholders`). So a run of steps is emitted
  first (serially, cheap), then every particle integrates through it on its own: one `parallelMap` per run, not per step.
  Since `max_particles` counts live particles only, a high rate with a short life over many steps once materialised
  hundreds of millions of births in one run and exhausted the heap (R-17 N3). A run is now emitted and integrated in
  batches: emission stops at the end of the step at which its births reach `max_births` (default 1,000,000), the batch is
  integrated and compacted, and the next one starts from there (the result is the one of a single run, as for frames);
  and one step gives at most `max_births` births (the rest are refused and reported, like `max_particles`).
- **Per-particle randomness is drawn at birth** from (seed, emitter key, birth index): the emitter point's `id` when it has
  one, so reordering or adding emitter points leaves the other points' streams alone. A birth offset u ∈ (0, 1] inside the
  step (0 is reserved for `emit_all` particles, which exist at time 0) avoids banding; a particle's age after S steps is
  `(S − b − u)·dt` and its death step is computed from the same expression, so ages, lifetimes and the cap always agree.
- **One step**: acceleration = gravity + noise + field force + attraction, semi-implicit Euler, then exact exponential drag
  toward the air velocity (wind + air fields), then up to four contacts: the earliest of the floor plane and a ray along
  the move against the collision BVH. The ray starts a stand-off behind the particle (its radius, or a skin of 1e-5 of the
  collider size for points), so a resting particle keeps finding its surface; triangles are two-sided, the side being the
  one the particle's centre is on, and, within the stand-off, the side of its last contact normal (kept per particle in
  `__pcn`); a hit it moves away from is skipped. `die` removes it, `slide` removes the normal velocity, `bounce` reflects it
  (slower than 1.5·|g|·dt it rests instead); friction is Coulomb (tangential loss = μ × normal velocity change), so a
  particle rests on slopes below atan μ. Spheres (`use_pscale`) are also pushed out of any surface closer than their
  radius (closest-point query), because a centre ray only sees the planes it moves toward.
- **Curl noise** is the curl of three fBm Perlin potentials evaluated with analytic gradients (one evaluation per
  potential and octave gives value and gradient), divergence-free to rounding; 100k particles × 200 steps with curl noise
  and floor collisions take ≈ 2.5 s on 15 threads (≈ 13 s on one), without noise ≈ 0.3 s (≈ 1.3 s on one).
- **Fields** (input 2) are made shareable once per input geometry: points with `v` as a KD tree + values (nearest or
  inverse-distance weighted over k neighbours, an allocation-free k-nearest walk), a heightfield as per-sample gradient
  arrays (bilinear, zero outside the field), an SDF (lazy or sampled) resampled on a grid of `field_resolution` along its
  longest side over its bounds grown by a quarter on each side (outside it, the gradient at the grid boundary).

**State and time.** Between runs the simulation is a point Geometry: carried emitter attributes and groups, P, v, id,
life, pscale and the internal `__pb` (birth step), `__pu`, `__pkd` (death step), `__pcn`, `__ptrail` (a ring of the last
`trails` positions, as a float tuple of 3 × trails per particle), plus detail step / next id / refused births / slot holders.
A cook at `start_frame` (and any cook with `animate: false`, which never reads the frame) runs `steps` steps; with `animate`,
frame f runs `steps + (f − start_frame) × substeps`. States are cached in the engine cache like the solver's, chained
`S(start) = hash(params, inputs at start_frame)`, `S(f) = hash(S(f−1), f, inputs at f)`. A cook resumes from the latest
cached frame at or before its own: with static inputs it runs the remaining steps in one kernel run and caches only the
final state; with time-dependent inputs (an animated emitter, collider or field) it runs frame by frame with each frame's
inputs and caches every frame. The cost is therefore one frame's steps when stepping forward (`cookFrames`), the steps
from the start (or the latest cached earlier frame) when jumping, and a cache entry per state (≈ 100 bytes per particle
plus 24 × trails); because a run can be cut anywhere with the same bits (test/particles.ts compares frame-by-frame, direct
and pooled cooks), resuming never changes the result.

Limits: no particle–particle interaction (no flocking, no SPH, no inter-particle collisions); sub-step emitter motion is
not interpolated; the field is sampled at the particle and collisions are against the static collider of the frame (a
moving collider does not push particles); spheres touching a mesh between contacts are resolved by the closest-point push,
not by a swept test; trails record one position per step.

### Sampled SDF grids

`Volume` also includes `kind: 'grid'` (`core/sdfgrid.ts`): a dense x-fast Float32
distance grid, dimensions, origin and uniform world-space voxel size. Values are
negative inside and signed infinities represent the unfilled narrow-band background.
Trilinear sampling, bounds, copy-on-write cloning, merge/subsets, native JSON and
quantized fingerprints preserve this volume alongside heightfields and images.
JSON uses explicit strings for signed infinities and negative zero.

The `sdf_grid`, `grid_combine`, `grid_offset`, `grid_blur`, `grid_dilate`, `grid_erode`,
`grid_resample`, `grid_to_mesh`, `grid_to_sdf` and `voxel_remesh` nodes call the Rust
WASM kernels through the existing host-agnostic loader. The renderer's grid preview
uses the existing manifold level-set path at bounded resolution. Grid-to-mesh drops
source attributes; voxel remesh can transfer Cd/material using the source triangle
BVH. Uniform dual contouring uses Hermite gradients and QEF feature placement with
cell-component separation; adaptive octree extraction is explicitly unsupported.
Grid CSG keeps A's domain, so sampling padding must include planned unions/offsets.
See `kernels/README.md` for the algorithm, data contract and limitations.

### Rust kernels and straight skeletons

`kernels/` is a standalone Rust crate with a committed `wasm-pack --target web` package in `kernels/pkg/`.
`npm run kernels:build` is the developer rebuild entry point; ordinary users only need Node. The host-agnostic
`src/wasm/kernels.ts` accepts bytes in `loadKernels`, shares concurrent initialisation, and retries failed loads.
`loadHostKernels` reads the module-relative WASM through `Host.readFile` once per host on first use. Browser hosts
can read the same URL with `fetch`; importing the node registry performs no kernel I/O.

`straight_skeleton` takes closed XZ footprints, detects nested holes (also doubled bridges within one primitive),
and emits skeleton/contour lines, signed polygon offsets, or a pitched roof. Kernel coordinates are 2D f64 pairs;
roof coordinates add height as their third component. The adapter maps this to Y-up, preserves contour provenance
with `GeoBuilder`, and writes prim `kind` on arcs or prim `edge` on roof faces. Pitch attributes belong to the
outgoing edge of a point, or all edges of a primitive. See `kernels/README.md` for the event algorithm, numerical
limits, array contracts and dependency licences; `kernels/BUILD.md` records the reproducible build commands.

### Field-aligned quad remeshing

`remesh_quad` is a separate topology node backed by `kernels/src/remesh_quad.rs`; the existing isotropic and voxel
remeshers retain their APIs and outputs. The kernel accepts f64 positions and indexed triangles, optimizes four-way
tangent orientations and periodic position origins on a hierarchy, and extracts polygon CSR. Density is a target
length or an approximate face count. Sharp edges, explicit creases and boundaries constrain the solve; locked edges
preserve the exact partition at a selected group's border.

The adapter in `src/nodes/remeshquad.ts` triangulates selected polygons, records their original point/corner/prim
indices, and transfers attributes with `GeoBuilder` using final source-triangle barycentrics. Vertex attributes use
connected wedges on each side of UV seams, while prim attributes follow the source triangle at each face centre.
Unselected primitives pass through; existing normals are recomputed for the remeshed region. Detail attributes
include `quad_fraction`, interior irregular-valence count `singularities`, `irregular_fraction` (that count divided
by all output vertices), and edge-length/planarity statistics. Default `cleanup` repairs local topology defects.
UV seams retain their geometry for wedge transfer while constraining only the orientation field, leaving lattice
position origins free. `quads_only` conformingly splits residual non-quads and affected neighbours, and fits suitable
planar crease-bounded patches with a grid and one ring. Face counts remain approximate; it is best effort when locked
borders prevent that refinement. Algorithm limits and measured acceptance are recorded in `kernels/README.md`
and `kernels/BENCH.md`; `examples/quad_remesh.json` exposes every polygon edge for visual review.

### Rigid bodies (Rapier)

`rbd_settle` and `rbd_stack` (category `sim`) are Houdini's RBD drop/settle idiom for procedural assembly: pieces fall
under gravity and come to rest on a terrain, in a container or on a ground plane, so scattered rocks and props sit in
contact instead of floating or intersecting. The physics is Rapier (`@dimforge/rapier3d-compat`, Apache-2.0), the
compat build whose JavaScript inlines the WASM as base64 (4.3 MB module, 3.1 MB of WASM; 1.66 MB gzipped). Nothing
reads a file: `src/wasm/rapier.ts` imports the package on the first rbd cook (about 60 ms to import and instantiate),
so the dependency costs nothing until a graph uses it, and a browser bundle splits it into its own chunk. The core
(`src/core/rbd.ts`) receives the loaded module and stays host-agnostic.

- **Pieces.** Every packed prim is a piece. Its body frame is the anchor and the rotation Q of `packedXform = Q·U`
  (Gram-Schmidt; U holds scale and shear, a negative entry when it mirrors). The convex hull is computed once per
  source by Rapier's quickhull, in a scratch world, and every instance applies its U to the hull vertices (hulls
  commute with linear maps, so 1,000 instances of three rock sources cost three hulls). Polygons are grouped into
  pieces by `piece`, `copynum` (unpacked copy_to_points), `name`, or connectivity; points shared by two pieces are split
  first. An unpacked piece's frame is its bounding-box centre, unrotated. Hull input points are sorted by position, so a
  piece gets the same hull packed or unpacked and whatever its point numbering.
- **Shapes.** `convex_hull` (default), `box` and `sphere` bound the hull vertices; `mesh` (exact triangles) only for
  static pieces (`active` = 0). Smooth pieces with more than `hull_points` (64) hull vertices are reduced: a greedy on
  the support function (start from the extremes along 26 directions, then add the vertex that gives the full hull's
  support in the direction where the chosen set falls shortest, over the hull's face normals and 256 sphere directions;
  one quickhull at the end). Collision cost grows with hull size (1,000 shelf rocks: 3.5 s exact, 2.1 s reduced); a
  reduced piece can sink in by the remaining shortfall, about 3 % of its radius for the shelf rock and at most 4.7 % in
  `test/rbd.ts`. Input 1 (terrain, heightfields as the triangles `heightfield_to_mesh` draws, containers, earlier settled
  pieces; packed input expanded) is one static trimesh with Rapier's internal-edge fix (two-sided); without it a ground
  plane at `ground`.
- **Simulation.** A fixed step (`steps_per_second`, 60), Rapier's `lengthUnit` set to the median piece size, CCD on.
  Every 5 steps the pieces are checked: a piece more than twice its radius below the lowest collider is removed and
  marked fallen; a piece that has stayed below 4 × `sleep_threshold` for 0.5 s gets `rest_damping` (angular, 40 % of it
  linear) until it speeds up past 10 × the threshold again, which ends the slow wobbling that otherwise keeps convex
  pieces on a triangle mesh awake for seconds; the simulation ends when every piece is asleep or has stayed below the
  threshold for 0.5 s, or after `duration`. After the first step, pieces overlapping by more than 5 % of their radius
  are counted for a warning. `rbd_stack` drops the pieces one every `interval` steps; with `lift` each is first moved up
  until it clears what is under its drop position (a downward shape cast from above everything; one step with only the
  static colliders runs first so the broad phase sees them).
- **Output.** A copy of the input with every piece moved rigidly: packed pieces change only the anchor P and
  `packedXform = R(q)·U` (instances stay instances and keep their sources); unpacked pieces move their points and rotate
  N/up/tangentu/force and compose `orient`. Points (anchors for packed pieces) get `v`, `w`, `settled` and `contacts`;
  fallen pieces are in point group `fallen` (or deleted). `active` defaults to 1, so geometry merged without it moves.
- **Determinism.** Same inputs, params and seed give the same bits: Rapier's WASM arithmetic is IEEE-754 without
  platform-dependent rounding (no SIMD build, no threads), bodies are inserted in a spatial order (y, x, z of their
  input pose to 1e-6 m, then a 64-bit hash of the piece's shape in its body frame, exact pose, velocities and
  `active`) so permuting the input changes nothing, and the jitter is seeded by that rank. Until R-18 pieces at the same
  position were ordered by input index, so permuting coincident pieces of different shapes changed the result;
  identical pieces still tie, and being interchangeable they give the same set of results. `rbd_stack`'s order
  `height` breaks equal heights by the same rank (order `input` follows the input by definition). Tested: two engines
  with another simulation in between, pool off and on, reversed prim and point order, four coincident pieces of
  different shapes in three orders. A different Rapier version may settle differently (goldens would change).
- **Time.** By default the nodes ignore the frame (a plain cook is the settled result, cached across frames). With
  `animate` the cook reads the frame and fps and simulates `(frame - start_frame) / fps` seconds; the node keeps the
  world of its last two signatures, so cooking frame 11 after frame 10 runs only the steps in between, and the last
  frame equals the settled cook bit for bit.

Measured (i7-10700K; other jobs kept the machine at 50–100 % CPU, so idle numbers are lower; the whole cook of the
node, Rapier loaded):

| case | time | steps |
|---|---|---|
| 1,000 packed shelf rocks (151 hull vertices → 64) dropped 1–2 m onto the ground | 2.1 s (3.5 s at 100 % load) | 325–415 |
| the same with exact hulls (`hull_points` 0) | 3.5 s | 475 |
| 1,000 packed boxes / ico spheres (42 vertices) | 0.9 s / 1.4 s | 190 / 255 |
| 1,000 unpacked rocks (a hull per piece, 162k points written back) | 3.7 s | 335 |
| 1,000 rocks in a 10-layer column, 219 starting in contact | 5.5 s | 440 |
| `examples/rbd_settle.json`: 116 rocks on a 51k-triangle terrain, then 16 crates | 2.6 s + 0.35 s | 720 / 545 |

Most of the time goes to the first second or two, while every piece is awake; sleeping pieces cost nothing. A piece
on a triangle mesh touches tens of triangles, so terrain contacts are the main cost (the showcase rocks: 3.6 ms
per step on average over 720 steps for 116 pieces).

## What makes it LLM-friendly

These are the decisions that most affect how well an agent can work with it:

1. **One JSON graph, submitted atomically.** Nodes are referenced by name, there are no IDs to track, and parameters
   are sparse because defaults cover the rest. Whole networks are written in one tool call.
2. **Self-describing schema.** `catalog` and `help` are generated from the same `NodeDef`s that validate input.
   Docs can't drift from behaviour.
3. **Lenient input with explicit feedback.** Houdini aliases (`copytopoints`, `attribwrangle`, `mountain`, `polyextrude`) are accepted, and
   names are case- and underscore-insensitive. A scalar broadcasts to a vector, and colours accept `"#hex"` or names.
   Unknown types and params fail with *did-you-mean* suggestions plus the list of valid names. `dry_run` validates without cooking.
4. **Text-first verification.** Each cook returns counts, bbox, attribute tables and groups. `inspect` adds
   attribute statistics, watertightness, volume, genus and element listings. `assert` nodes turn invariants
   (watertight, counts, bbox, an expression) into node errors that list every failed check with its measured value;
   `explain` describes a result in words (pieces, symmetry, principal axis, wall thickness, flipped normals) and `diff`
   compares two versions (bbox delta, schema changes, Hausdorff distance, an overlay render), so an agent can check
   its work without a vision round-trip.
5. **Vision feedback.** `render` returns a labelled quad view. Back faces of closed pieces are tinted blue, so flipped
   normals are obvious. Attributes can be colour-mapped, and groups are highlighted in orange. The renderer is pure JS,
   so it needs no GPU or browser.
6. **Code escape hatches.** `wrangle` is per-element JS with VEX-style `@P` syntax and helper names (`fit`, `rand`,
   `nearpoints`, `addprim`, …). `script` runs whole-geometry JS with the engine library and `lib.run(anyNode)`.
   `sdf_expr` uses IQ-style distance functions. If a node is missing, the agent can still do the thing. The
   sandbox is a vm realm with a timeout, so a runaway loop fails the node instead of hanging the server.
7. **Parametric by default.** `vars` plus `"=expr"` params make every graph tweakable. A graph with vars becomes a
   reusable **asset** node in one call, so the library grows with use. The **shelf** ships 35 such assets
   (`shelf/*.json`): `Engine.init` reads `shelf/index.json` through `Host.readFile` from `Host.shelfPath` (a
   directory or URL, so a browser host can serve the same files) and registers each graph with category `shelf`;
   workspace assets of the same name are registered over them and win. Shelf assets may use each other (index order
   lists dependencies first), and re-registering any asset with a different graph clears the result cache.
8. **Deterministic.** All randomness is seeded hashing, so the same graph always produces the same geometry.
9. **Incremental edits.** `edit` ops (`set`, `insert` after a node, `remove` with auto-rewire, `rename`, `vars`) keep
   iteration cheap in both tokens and time.

## Quality

The `NodeDef`s are the single source for validation, the MCP docs and the generated [node reference](nodes.md), and
they also drive the tests: `test/fixtures.ts` gives every node type a fixture graph that all test layers share.

- **Smoke**: every node cooks and passes structural invariants (`checkGeo`: CSR topology, table sizes, finite `P`).
- **Golden**: every node fixture and example graph has a fingerprint in `test/golden/` (counts, bbox, attribute schema,
  groups, quantised hashes of positions, topology and attributes, sampled SDFs). Fingerprints are deterministic and
  tolerant to float noise, so any change in output, intended or not, is visible as a git diff and reviewed.
- **Property**: random chains from the registry check the engine's contracts: errors are per node and never thrown,
  cooks are deterministic, and the content-addressed cache gives the same result after a param is changed and
  restored. A wrangle fuzz checks the sandbox timeout and that compile errors point at the snippet line; hostile
  `"=expr"` params (escapes and endless loops) must fail their node clearly, with the pool off and on; since R-11
  they run in the host's vm sandbox with a timeout. Since R-12 the code params of `heightfield_layer` and `sdf_expr`
  run under the script timeout too (loops, also after an await or in a thrown object's message getter, and wrapper
  escapes are fuzzed with the pool off and on). Since R-13 so do the parametric nodes, an `sdf_expr` field sampled
  later by `sdf_to_mesh` and `sdf_grid` (also through transform/modify/combine), and what wrangles and scripts throw
  (message/stack/toString getters that never return, in workers too); `test/examples.ts` fails on any example warning.
- **Docs staleness**: `docs/nodes.md` must match the registry, and the README's node table must name every node type.
- **Examples**: every `NodeDef` carries an `example` (a node spec or a small graph, shown by `help` and in the node
  reference) and `test/examples.ts` cooks each one: node specs on the node's fixture inputs, graphs as written.
- **Benchmarks** (`npm run bench`) track the performance targets of the roadmap; they are informational.

## Sourced libraries

| library | licence | used for |
|---|---|---|
| manifold-3d | Apache-2.0 | booleans, convex hull, Minkowski, smoothing/refine, level-set meshing, 2D cross-sections (Clipper2): offset, 2D booleans, text fill, extrude |
| meshoptimizer | MIT | decimation (simplifyWithAttributes, simplifySloppy, simplifyPoints), `lod`; meshopt compression/decompression for glTF (EXT_meshopt_compression) |
| @dimforge/rapier3d-compat (Rapier) | Apache-2.0 | rigid bodies for `rbd_settle` / `rbd_stack`: convex hulls, trimesh colliders, contacts, shape casts (WASM inlined, imported on first use) |
| xatlas-wasm (xatlas by Jonathan Young) | MIT | `uv_unwrap` / `uv_autoseam`: chart segmentation, parameterisation, atlas packing (single-file ES module, WASM embedded) |
| @gltf-transform/core + extensions | MIT | glTF 2.0 document model, GLB/glTF reading and writing, KHR/EXT extensions (materials, quantization, meshopt, Draco, instancing) |
| earcut | ISC | n-gon triangulation |
| d3-delaunay | ISC | 2D Delaunay / Voronoi |
| simplex-noise | MIT | simplex noise |
| opentype.js | MIT | TrueType/OpenType outlines for `text` |
| three | MIT | the live viewer (GLTFLoader, fat lines) |
| @modelcontextprotocol/sdk | MIT | MCP transport |
| DejaVu Sans (assets/fonts) | Bitstream Vera licence (redistributable) | bundled default font for `text`, so output is identical on every machine; system fonts are used only when named |

Written in-house: the geometry model, attribute-preserving builder, Catmull-Clark, LSCM flattening with cut graphs, UV island packing, poly extrude/inset, sweep with
rotation-minimising frames, L-systems, Voronoi fracture (manifold half-space trims), narrow-band mesh→SDF with fast
sweeping, scatter with blue-noise sample elimination, BVH/KD-tree, renderer, exporters/importers (OBJ/STL/PLY/USDA,
Houdini `.geo` JSON and binary JSON, CSV/points JSON; glTF builds on gltf-transform). Tests validate every GLB with the
Khronos `gltf-validator` (Apache-2.0, dev dependency only).

**Scene import.** The `file` node reads `.blend` through optional `Host.convertFile(path, 'glb')`: the Node host
finds Blender (`TOPOTOPO_BLENDER`, PATH, then standard installations), runs the shipped `integrations/blender/export_scene.py`
headlessly with a timeout (`TOPOTOPO_BLENDER_TIMEOUT`, seconds, default 300), and caches GLBs under `.cache/blend/`
by resolved path and file stamp. The script uses static copies/evaluated geometry, preserves linked meshes and
collections, applies scene units once at the exported GLB roots (so collection instances do not double-scale),
and never saves the source. The browser has no converter; export a GLB there instead.

glTF import walks the default/first scene in traversal order. Empties become points with world `P`, unit quaternion
`orient`, `scale`, `pscale`, `name` and ancestor `path`; cameras/lights are skipped with one count. Shared meshes
without the GPU extension use one unnamed local source and one packed prim per referencing node: `name`, `path`
and object extras belong to that prim, so unpack can transfer each instance's label. Existing GPU-extension sources
retain their source labels and per-instance metadata. Single-use meshes and `instancing: 'expand'` stay expanded.
When empty-point attributes share a packed-prim key, import mirrors that value onto the instance's anchor before
merging: existing unpack/export point precedence then keeps the value (unpacked names can be point attributes).

Node extras override mesh extras; scalar numbers, booleans, strings and numeric vectors of length 2–4 become
attributes. Reserved geometry names warn once, nested values and `topotopo` are ignored, and sorted extras keys
feed the existing `Geometry.merge` schema/default/type rules. Folder imports use sorted immediate files and stamp
the listing plus every file. Each file's `name` becomes its stem, or `<stem>/<name>` if it already has multiple
distinct names across prims and isolated points; packed prims participate too. This is the variant input for
`copy_to_points {variants: 'name'}`.

**Material data.** A prim string attribute `material` names a material; the detail string attribute `materials` holds
a JSON table `{name: {baseColor, metallic, roughness, emissive, alpha, doubleSided, unlit, textures?}}`
(`src/core/materials.ts`). It carries names, PBR scalars and texture paths (base colour, normal, roughness, ORM) to
engines, not shading: glTF embeds the images (files read through `Host.readFile`, `image:<name>` image volumes encoded
in memory), USD references them from `UsdUVTexture` shaders, `.geo` and JSON keep the paths. The renderer shows a material's base colour where a prim has no colour. `Geometry.merge` keeps the first detail value, so the `merge`
node and the exporters union tables (`mergeMaterialTables`); other internal merges keep their first input's table.

## Roadmap

Live item status is in [WORKLOG.md](WORKLOG.md); the long-range plan and its analysis in [ROADMAP.md](ROADMAP.md).

**Shipped in v0.2 (2026-10-22)**
- Roadmap phases 0–2: the test layers (smoke, golden, property, fuzz, docs, examples), time and `solver`, expression
  references, graph versioning, edge/vertex groups and the half-edge structure, array attributes, the worker pool;
  modelling parity (bevel, knife/polysplit, bridge, quad fill, loop ops, deformers, xatlas unwrap and LSCM, isotropic
  remesh, attribute-preserving decimation, LOD, measures and `assert`, render overlays); PCG and instancing (packed
  prims, copy variants, scatter v2, masks, the heightfield suite with erosion, the spline toolkit, the asset shelf,
  gltf-transform/USD/`.geo`/CSV exporters).
- The Unreal round trip, verified on 2026-10-13 in Unreal 5.8 (instance rows, Interchange glTF axes, the Landscape
  import with the manifest values), with the same scene loading in Blender 5.2 and Houdini 22. Since then the
  TopoTopoPCG plugin (0.1.5, `integrations/unreal/TopoTopoPCG`) imports an `unreal_landscape` bundle in one command
  (Landscape, weight layers, a generated material, HISM instances, static objects; tiled bundles as World Partition
  streaming proxies), and its 19 automation tests pass in the editor.
- Phase 3 except the optional CAD module: procedural textures and bakes (37 texture nodes, image volumes, materials
  referencing `image:<name>`, embedded export, the texture view; since 2026-10-17 also `image_file`, the PNG reader);
  sampled SDF grids; and simulation-lite in the `sim`
  category: `rbd_settle` and `rbd_stack` on Rapier ([Rigid bodies](#rigid-bodies-rapier)), `particles`
  ([Particles](#particles)), and XPBD cloth with `drape` and `inflate` ([Cloth](#cloth-xpbd)).
- Rust/WASM kernels, sessions 1–16 (9–11 and 16 also built the Unreal plugin): straight skeleton (roofs, offsets),
  sampled SDF grids with CSG, morphology and dual contouring, field-aligned quad remeshing, heightfield erosion (droplet, virtual-pipe and stream-power models behind
  `heightfield_erode`; the TypeScript droplet erosion stays the default) and D8/D-infinity drainage (`heightfield_flow`);
  an erosion speed pass (session 5); SIMD and scalar builds side by side, SIMD chosen by feature detection with
  `TOPOTOPO_WASM` as override and byte-identical results (session 6); quad-remesher regularity (1.83 % irregular
  vertices on the large sphere, 2.69 % with UV seams) and about a 2× speed-up (session 7); edge-dual dual contouring
  with QEF vertices, straight box edges and both speed targets met (session 8); scatter's sample elimination,
  minimum-distance rejection and relaxation behind `backend: auto`, byte-identical to the TypeScript path (sessions
  12–13); priority-flood depression filling and filled drainage routing (session 14); pipe erosion at 1.9 s native and
  3.0 s WebAssembly for 1024² × 200 steps, both targets met (session 15); tiled Landscape bundles (session 16).
- User code under the script timeout: `"=expr"` parameters in their own sandboxed realm (R-11), `heightfield_layer`
  expressions and `sdf_expr` fields wherever they are sampled (R-12, R-13 and the particles field guard), thrown values
  read inside the guard (`runUserCode`), script bodies compiled inside it; see
  [Host and script sandbox](#host-and-script-sandbox). Count parameters have maxima and the long-running nodes a
  wall-clock budget (`TOPOTOPO_SIM_TIMEOUT_MS`, R-18).
- The rename to TopoTopo in the code (R-4) and the publishable package: `dist/` build, `topotopo`/`topo` commands, the
  `mcp` subcommand, `npm run pack:test` (R-10). Public since 2026-10-15: github.com/topotopo-dev/topotopo, the docs
  site (R-14) at topotopo.dev, CI on Ubuntu and Windows (R-19).
- The testing week's fixes ([release/dogfood-log.md](release/dogfood-log.md)) and the first GUI pieces (below).

**Around the release**
- v0.2.0 released on 2026-10-22: npm, the tag and its GitHub release (Rapier stays a regular dependency). Next: the
  demo video and launch posts by the end of October.
- Grant applications (Epic MegaGrants, cycle 1 of 2027: the text in December, submission in the January–March window)
  built on the Unreal 5.8 demo video; trademark filing once there is revenue or a grant.

**Next for the engine**
- Kernels: speed targets still missed, mostly measured under load (`kernels/BENCH.md`): the droplet kernel 1.38×
  TypeScript (target 3×), the quad remesher 5.1 s for 100k triangles with the SIMD build (target 3 s), scatter of
  100k blue-noise points 0.65 s on 15 workers (target 0.5 s) and 1M → 100k elimination 3.2 s (target 1.5 s). Dual
  contouring leaves up to 0.4 voxel at sharp union junctions (target 0.1) and has no adaptive octree.
- From the testing week, after v0.2: an on-disk cook cache between CLI runs, far-instance LOD for dense previews, and
  drainage that does not run in straight lines across filled flats (dogfood log row 9).
- Simulation-lite follow-ups: convex decomposition for concave rigid pieces, moving and animated colliders for
  particles and cloth, particle–particle interaction, cloth tearing and welds, `drape` speed (3.3 s against a 3 s
  target for 100 × 100 × 200 steps).
- Performance follow-ups: done (scatter on the pool, one-pass point normals, SAH BVH with a `-0` ray-direction fix,
  relaxed scatter ≈ 1.2 s per 100k, the density-mask neighbour rebuild since R-12); still open: the AO bake
  (2048² × 16 rays ≈ 6 s) and a WebGPU spike.
- Packed primitives: packed disk references (Houdini packed disk prims), USD variants and per-frame layers, and
  instanced rendering in the rasteriser (it draws expanded copies within a triangle budget).
- Heightfields: `sample: unreal_triangles` is done (scatter and project_curve match a Landscape to 2e-14 m).
  The UE 5.8 TopoTopoPCG importer now creates ordered layer infos and imports the bundle's PNG weights with
  `ALandscape::Import`. Independent paint-layer storage preserves the exported bytes (including already
  normalised sediment/debris); the generated Landscape material blends colour/roughness and normalizes only
  its appearance. `layers=0` and `material=0` opt out independently. See the plugin's
  [editor workflow](../integrations/unreal/TopoTopoPCG/EDITOR_WORKFLOW.md) for assets and editor acceptance.
  Depression filling for drainage is implemented (K-11): `heightfield_fill_sinks`, optional filled routing in
  `heightfield_flow` and stream-power erosion; `unreal_landscape` export supports overlapping tiles, shared height/weight ranges and per-tile instance streams (K-12), imported as components in plain levels or streaming proxies in World Partition levels with independent spatial HISM actors per tile.
- Curves: curve booleans in 3D, NURBS surfaces, `.geo` NURBCurve/BezierCurve read/write, USD BasisCurves with a
  bspline/bezier basis, exact spline offsets (refit) and carve/ends that keep the spline form.
- Textures: MikkTSpace tangents, bakes outside the 0..1 uv square.
- Houdini interop: `.bgeo.sc` (Blosc) and a USD layer writer with variants.
- Phase 3 remainder: volumes beyond the sampled SDF grids (adaptive extraction, VDB IO, volumes from points) and an
  optional OpenCascade/replicad CAD module for B-rep fillets and STEP export (P3-D; its LGPL licence needs a decision
  first, and it would load as a separate module).

**GUI (makes the app usable without an LLM)**
- Order, decided 2026-10-17: the live viewer grows into the GUI in the order a person working with an agent needs it.
  Done: a Controls panel generated from the graph's `params` (`POST /api/vars`, bursts coalesced), a drop zone
  that stores files in `inputs/` and shows them as ghosted reference layers (`GET/POST /api/inputs`, `GET /api/input`;
  a PNG as a flat textured quad).
  Under `topotopo view <graph.json>` that is the `inputs/` folder beside the graph file, made by the first drop (the
  scratch workspace keeps only graphs and assets), so the graph reads drops as `inputs/<name>` and they
  outlive the viewer; the page names the folder (`GET /api/inputs_dir`).
  Done too: markers (sites, paths, zones and volumes placed by clicking, stored as `inputs/markers.json`). That first
  page was judged toy-like (damped camera, no orthographic views, no snapping, invented icons), so the viewer is now
  built to a standard, [design/viewer.md](design/viewer.md) (full editor direction). Phase 1, the production editor
  viewport, is done (2026-10-17): quad and orthographic views with a metre grid, selection, outliner and properties,
  guides drawn as nulls, curves, areas and volumes, keymap presets. Since 2026-10-19 the default navigation is
  TopoTopo surface navigation (no modifier keys; Maya, Houdini and Blender presets retained). Next: phase 2, a gizmo
  with snapping, typed values and CV editing; then phase 3, the node editor. No chat panel in the viewer: Claude Code
  is the conversation (decided 2026-10-17).
- Outputs now lists all graphs' default and named results, textures, renders and saved exports. Selection isolates
  a result, with per-result camera or image pan/zoom. The image viewer exposes channels, layers and mesh UVs.
  Outputs sits below Inputs in one Outliner; references stay exclusively in Inputs. Thumbnail sizes cycle in the
  header. Checked outputs export independently of preview selection, with project defaults, per-output overrides
  and temporary one-time settings. Fixed-size export dialogs scroll internally. Batch preparation validates every
  result and companion path before replacing any destinations; settings persist under `exports/.export-settings.json`.
  Export uses the actual cook and existing exporters, persists alongside the graph under `exports/`, records
  source revisions, and offers individual/ZIP downloads. JPEG/WebP are browser-viewable references only.
- Browser app, last: a node editor (React Flow or LiteGraph), the three.js viewport, and parameter panels generated
  from `ParamDef`s. Every param already carries type, default, range, enum options and a description.
- The engine runs in a Web Worker. Graph JSON is the file format and is identical for humans and LLMs, and `ui: {x, y}`
  is already reserved in node specs.
- Human input: people drop their own files into the workspace's `inputs/` folder (guide curves, sites, zones,
  blockouts, PNG masks); the `inputs` tool lists and describes them for the agent, and help topic `inputs` sets the
  conventions (plain `name` / `role` attributes, name prefixes such as `path.` and `zone.`). A graph's `params`
  (`VarDef`: type, desc, min, max, options, label, step) are the controls the viewer draws; people change vars through
  `Workspace.edit`, and an agent reads the graph before assuming a var's value. There is no lock: a person who wants
  a value kept says so (a lock was built and removed on 2026-10-17 as unneeded).
- The MCP server and the GUI share one workspace. The live viewer (`preview` tool) already streams updates over SSE, so
  you can watch an agent build while you inspect intermediate nodes.
- The LLM side stays in Claude Code (or any MCP client) talking to the same workspace; the viewer gets no chat panel.
