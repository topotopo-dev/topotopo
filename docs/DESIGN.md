# Polyforge design notes

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
| Browser (engine in a Web Worker) | the future human GUI: node editor, viewport, parameter panels | live viewer done; editor not built yet |
| Desktop wrapper (Tauri/Electron) | optional, if you want native files, bigger memory, a local GPU | later, same web GUI |

MCP needs a local process anyway, because stdio servers are processes. That means the LLM side runs in Node today, and
the human side can be pure browser with no install. Every Node-specific capability sits behind `src/host/types.ts`
(`Host`): file reading, the script sandbox, and PNG compression. A browser host implements the same interface with
`fetch`/OPFS, a Worker realm and `CompressionStream`.

## Architecture

```
src/core/      geometry model + algorithms (no I/O)
  geometry.ts    Geometry (points/vertices/prims/detail attribute tables, point/vertex/prim/edge groups, SDF volumes), GeoBuilder
  edges.ts       EdgeSet (unordered point pairs, integer keys), unique-edge list
  halfedge.ts    half-edge mesh derived on demand and cached per Geometry: loops, rings, one-rings, boundaries, dihedral angles
  topology.ts    normals (hard edges), triangulation (earcut), edges, connectivity, boundary loops, health report
  groups.ts      Houdini group patterns for all four classes ("top", "!top", "0-10", "@P.y>0", "p3-7", "angle>30", "border:top")
  groupconvert.ts  any/all conversion of selections between point, vertex, prim and edge
  spatial.ts     KD-tree (points), triangle BVH (closest point, rays, inside tests)
  manifold.ts    Geometry ⇄ manifold-3d (attributes carried as properties, provenance via reserved IDs)
  noise.ts       perlin / simplex / value / worley, fBm / ridged / turbulence, curl
  wrangle.ts     @-syntax compiler → per-element kernels; deferred addpoint/addprim/remove
  snippet-lib.ts VEX-like helper library installed into the script realm (vectors, quaternions, noise, SDF ops)
src/graph/     node system
  types.ts       NodeDef / ParamDef / GraphSpec — the schema that drives docs, validation and (later) GUI widgets
  params.ts      name resolution (aliases, case-insensitive, did-you-mean), "=expr" evaluation and reference scanning, coercion
  engine.ts      validation, lazy pull cooking, content-addressed cache, time, subgraphs/assets
  migrate.ts     graph format versions and migrations
src/nodes/     ~95 node types, one defineNode() each
src/render/    software rasteriser → PNG (labelled multi-view images for LLM vision)
src/io/        import (obj, stl, ply, glb/gltf, json) · export (glb, obj, usda, ply, stl, json)
src/host/      Node host: fs, vm sandbox (timeouts), fonts
src/mcp/       MCP server, tool implementations, LLM docs
src/viewer/    live preview: tiny HTTP + SSE server and a three.js page
src/workspace.ts  named graphs persisted as JSON, edit operations, assets
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
- **SDF volumes** travel inside the geometry as lazy sample functions, so implicit modelling composes like any other node.
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
   attribute statistics, watertightness, volume, genus and element listings.
5. **Vision feedback.** `render` returns a labelled quad view. Back faces of closed pieces are tinted blue, so flipped
   normals are obvious. Attributes can be colour-mapped, and groups are highlighted in orange. The renderer is pure JS,
   so it needs no GPU or browser.
6. **Code escape hatches.** `wrangle` is per-element JS with VEX-style `@P` syntax and helper names (`fit`, `rand`,
   `nearpoints`, `addprim`, …). `script` runs whole-geometry JS with the engine library and `lib.run(anyNode)`.
   `sdf_expr` uses IQ-style distance functions. If a node is missing, the agent can still do the thing. The
   sandbox is a vm realm with a timeout, so a runaway loop fails the node instead of hanging the server.
7. **Parametric by default.** `vars` plus `"=expr"` params make every graph tweakable. A graph with vars becomes a
   reusable **asset** node in one call, so the library grows with use.
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
  restored. A wrangle fuzz checks the sandbox timeout and that compile errors point at the snippet line.
- **Docs staleness**: `docs/nodes.md` must match the registry.
- **Benchmarks** (`npm run bench`) track the performance targets of the roadmap; they are informational.

## Sourced libraries

| library | licence | used for |
|---|---|---|
| manifold-3d | Apache-2.0 | booleans, convex hull, Minkowski, smoothing/refine, level-set meshing, 2D cross-sections (Clipper2): offset, 2D booleans, text fill, extrude |
| meshoptimizer | MIT | decimation |
| earcut | ISC | n-gon triangulation |
| d3-delaunay | ISC | 2D Delaunay / Voronoi |
| simplex-noise | MIT | simplex noise |
| opentype.js | MIT | TrueType/OpenType outlines for `text` |
| three | MIT | the live viewer (GLTFLoader, OrbitControls) |
| @modelcontextprotocol/sdk | MIT | MCP transport |

Written in-house: the geometry model, attribute-preserving builder, Catmull-Clark, poly extrude/inset, sweep with
rotation-minimising frames, L-systems, Voronoi fracture (manifold half-space trims), narrow-band mesh→SDF with fast
sweeping, scatter with blue-noise sample elimination, BVH/KD-tree, renderer, exporters/importers.

## Roadmap

**Next for the engine**
- Packed primitives and instancing. Copies would stay as references, and export would use glTF `EXT_mesh_gpu_instancing`
  or USD point instancers, so forests of a million trees stay cheap. This maps directly to Unreal ISM/HISM and PCG.
- UV unwrapping via xatlas (WASM), plus UV layout.
- PolyBevel (edge chamfer/fillet) and PolySplit/knife, built on the edge groups and the half-edge structure.
- Heightfield node set: erosion, masks, scatter by mask, terrain → Unreal Landscape heightmap export.
- Curve toolkit: NURBS/Bezier evaluation, fillet, curve booleans, path offset in 3D.
- Performance: move hot kernels (sdf sampling, rasteriser, subdivide) to Workers, WebGPU or WASM; add multithreaded cooking of
  independent branches.
- Optional CAD context: an OpenCascade/replicad module for B-rep fillets and STEP export.
- Houdini interop: `.bgeo`/`.geo` export, which keeps attributes and groups, and a USD layer writer with variants.

**GUI (makes the app usable without an LLM)**
- Browser app: a node editor (React Flow or LiteGraph), a three.js viewport, and parameter panels generated from
  `ParamDef`s. Every param already carries type, default, range, enum options and a description.
- The engine runs in a Web Worker. Graph JSON is the file format and is identical for humans and LLMs, and `ui: {x, y}`
  is already reserved in node specs.
- The MCP server and the GUI share one workspace. The live viewer (`preview` tool) already streams updates over SSE, so
  you can watch an agent build while you inspect intermediate nodes.
- Later: a GUI chat panel that calls the same tool layer, so an LLM can co-edit the open graph.
