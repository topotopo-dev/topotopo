# Polyforge roadmap: towards Houdini-class geometry

Status as of 2026-10-12: 96 node types, ~12k lines of TypeScript, immutable geometry with provenance-preserving
`GeoBuilder`, content-hashed lazy cooking, MCP server, software renderer, 10 example graphs, 322 lines of tests.

> **Status 2026-10-13 (end of day).** Phases 0–2 below are done, including the Unreal round trip: verified in Unreal 5.8
> on 2026-10-13 (instance rows, glTF through Interchange, the Landscape import with the manifest values), with the same
> scene loading in Blender 5.2 and Houdini 22. Phase 3 has started: procedural textures and bakes shipped (§6a), and
> three Rust/WASM kernel sessions are merged (straight-skeleton roofs and offsets, sampled SDF grids with dual
> contouring, field-aligned quad remeshing). Totals: 216 node types (each with a documented example that is cooked in
> the tests), 37 shelf assets, 280 golden fingerprints, 29 rendered examples, worker pool, exporters for
> Unreal/Blender/Houdini. Remaining before the first release: the rename to TopoTopo, a tagged v0.2 on npm, and the
> grant applications (§7). Then Phase 3 continues with volumes beyond the sampled grids, simulation-lite and CAD; on
> the kernel track the erosion kernel, a quad-remesher speed pass and a dual-contouring quality pass are next. Live
> item status: [WORKLOG.md](WORKLOG.md).

The target is parity with Houdini SOPs, Blender Geometry Nodes and Unreal PCG for **creating geometry**: modelling,
procedural assembly, scattering and instancing, terrain, curves, volumes, and the export that feeds engines. Rendering,
character tools and film-scale simulation are out of scope.

Houdini ships ~450 SOPs. The subset a production modelling and PCG pipeline actually uses is about 180. Polyforge has
96 of them, so the node gap is 80–100 nodes. The harder part is not the node count. It is five structural features that
most of the missing nodes depend on: edge topology, packed instancing, sampled volumes and heightfields, time, and a
test suite that lets the engine change safely.

---

## 1. Structural gaps in the engine

These come first. Every later phase depends on at least one of them.

### 1.1 Edge topology, edge groups, vertex groups
Houdini has four element classes with groups: point, vertex, prim, **edge**. Polyforge has point and prim groups only,
and `buildEdges()` is a one-off helper rather than a structure nodes can share.

- Add **edge groups** (stored as sorted point pairs, Houdini-compatible), edge patterns in `evalGroup`
  (`p12-13`, `@edge...`, boundary/unshared edges, by angle, by group border), and **vertex groups**.
- Add a lazily built, cached **half-edge structure** (typed arrays: `twin`, `next`, `prev`, `vertex`, `face`) that is
  derived from a `Geometry` on demand and memoised by object identity. Bevel, polysplit, loops, dissolve, bridge,
  isotropic remesh and crease subdivision all need it.
- `creaseweight` attribute support in Catmull-Clark, hard-edge groups feeding `normal` (cusp by group, not only angle).

### 1.2 Packed primitives and instancing
The single most important feature for PCG scale. A forest of a million trees must stay a point cloud plus a small
library of meshes.

- New prim kind `packed`: a reference to an immutable shared `Geometry` plus a transform (and optional `variant`).
- `copy_to_points` defaults to packed output; `unpack` node; booleans, deformers and others auto-unpack with a warning.
- Content hashing of packed sources keeps the cache cheap. Render instances directly in the rasteriser.
- Export: glTF `EXT_mesh_gpu_instancing`, USD `PointInstancer`, and a plain point stream for Unreal PCG / ISM.

### 1.3 Sampled volumes and heightfields
The current SDF is a lazy sample function. That is elegant and composable, keep it as the **implicit** kind, but add:

- **Grid volume** prim: dense tiled `Float32Array` with bounds and voxel size. Ops: blur, dilate/erode, open/close,
  remap, combine, resample, from implicit, from mesh (narrow band), to mesh (marching cubes **and dual contouring** for
  sharp features).
- **Heightfield** prim: 2D grid with named layers (`height`, `mask`, `flow`, `sediment`, user layers). This is the
  Houdini heightfield model and maps directly to Unreal Landscape and its weight layers.

### 1.4 Time
`@Time`/`@Frame` are recognised by the wrangle scanner but the engine has no notion of time.

- `time`/`frame` in `CookOptions`, included in signatures only for nodes that read them (`usesTime` on the def).
- **`solver` node**: feedback over frames (growth, particle advection, settling), with a per-frame cache.
- CLI and MCP `cook` accept frame ranges; `export` can write per-frame files.

### 1.5 Expressions and parameter references
`=expr` evaluates against `vars` only. Houdini graphs lean on `ch()`, `npoints()`, `bbox()`, `detail()`, `point()`.

- Expression functions that read **cooked upstream geometry**: `npoints("node")`, `bbox("node").size.y`,
  `detail("node","attr")`, `point("node", i, "attr")`, `centroid("node")`.
- Parameter references between nodes: `ch("node/param")`. Both become edges in the dependency graph.
- Typed `vars` with ranges already exist; add `ramp` and `path` var types for assets.

### 1.6 Attribute model additions
- **Array attributes** (`float[]`, `int[]`, `string[]`) for neighbour lists, piece membership, per-point spline
  samples. **Dict attributes** are lower priority.
- Material data: a `material` string attribute plus a detail-level material table (name → PBR params) that exporters
  write as glTF/USD materials. Not shading, just carrying names and colours through to engines.
- Storage precision: `Float64Array` everywhere doubles memory versus Houdini's default 32-bit. Keep 64-bit for `P`
  (booleans, large world coordinates) and consider 32-bit for everything else once packed prims remove the biggest
  memory cases. Decision deferred, not urgent.

### 1.7 Performance architecture
- Worker pool (`worker_threads` in Node, Web Workers in the browser) behind the `Host` interface: cook independent
  branches in parallel, chunk wrangles over `SharedArrayBuffer` views.
- Hot kernels in WASM. Preferred route: a small Rust crate (`polyforge-kernels`) compiled with `wasm-bindgen`, because
  the Rust geometry ecosystem (see §4) is MIT/Apache and already WASM-ready. Candidates: half-edge ops, subdivision,
  SDF/grid sampling, erosion, isotropic remeshing.
- GPU compute via WebGPU for erosion, SDF sampling and scatter. Native in browsers; in Node through Dawn bindings
  (`webgpu` npm package). Needs a spike before committing.
- A benchmark suite with fixed targets, e.g. scatter + packed copy of 1M points under one second, Catmull-Clark of
  100k faces × 2 levels under one second, 500k-triangle boolean (manifold) under three seconds.

### 1.8 Quality infrastructure
This is the largest production-readiness gap today.

- **Golden tests**: every node cooks a fixed fixture and the result's content hash, bbox, counts and a small render are
  compared. Failures show a diff render.
- **Property tests**: random graphs from the catalogue, checking invariants (`checkGeo`), watertightness after solid
  ops, attribute preservation through every node that uses `GeoBuilder`.
- **Fuzzing** the wrangle compiler and the group-pattern parser.
- **Parity tests against Houdini**: the same operation (subdivide, polyextrude, resample, scatter density) cooked in
  Polyforge and in Houdini through the existing Houdini MCP, compared by Hausdorff distance. Houdini becomes the oracle.
- Graph format `version` field with migrations, and node deprecation aliases so old graphs keep cooking.
- Generated node reference (Markdown/HTML) from `NodeDef`s, published with the repo.

---

## 2. Node suite gaps, by Houdini category

Names are Houdini's; Polyforge aliases should accept them.

### Polygon modelling
| node | notes |
|---|---|
| `polybevel` | edge/point bevel, chamfer and rounded, needs half-edge; the defining modelling node |
| `polysplit` / `knife` | cut faces along a path or a plane with topology (not clip) |
| `polybridge` | bridge two edge loops, with divisions and twist |
| `polyfill` | quad-dominant hole fill (current `fill_holes` is n-gon only) |
| `edge loop` / `edge ring` selection, `dissolve`, `edge collapse`, `edge divide`, `edge straighten` | selection + ops |
| `polyexpand2d` | inset/outset with topology (the 2D offset exists via Clipper, this is the mesh version) |
| `thicken` / `polyextrude` along curve, `extrude` with spine | |
| `crease` + crease-aware `subdivide` | |
| `soft transform` / `edit` with falloff | moving a selection with a radius/ramp falloff |
| `lattice`, `pathdeform`, `pointdeform`, `wiredeform`, `shrinkwrap` | the deformer family (`ray` exists) |
| `rest` | store rest positions for stable noise on deforming geometry |
| `rbd material fracture` | concrete / glass / wood fracture patterns on top of the existing Voronoi fracture |

### Scatter, instancing, PCG
| node | notes |
|---|---|
| `scatter` v2 | density by attribute, by image map, by mask; relax; min distance; on volumes; collision pruning |
| `copy to points` v2 | packed output, `variant` selection from N inputs by attribute / weighted random |
| masks | by slope, height, curvature, ambient occlusion, distance to curve/mesh, visibility, flow |
| `attribute from map` | sample PNG/EXR images into attributes (needs an image reader) |
| `orient` helpers | align to normal/up/curve tangent, random rotation ranges, scale ramps |
| `pcg filters` | select by attribute range/expression, density falloff, self-pruning (exists as sample elimination) |
| `points along splines` | spacing, start/end offsets, count by length, with `curveu`, tangent, normal |
| `grouping by proximity` / `cluster` | k-means and radius clusters for piece assignment |

### Heightfields and terrain
| node | notes |
|---|---|
| `heightfield` create, from mesh, from image, noise, remap, blur, terrace, cutout | |
| `erosion` | hydraulic + thermal, GPU-friendly; the showcase terrain node |
| `heightfield mask` by feature (slope, height, curvature, flow, occlusion) and `mask blur/expand/noise` | |
| `heightfield project` (stamp meshes/curves), `path` (roads cut along curves with banking) | |
| `heightfield scatter` (by mask), `heightfield → mesh`, `heightfield → sdf` | |
| export | 16-bit PNG / RAW heightmaps and weight-layer images for Unreal Landscape |

### Curves
| node | notes |
|---|---|
| `bezier` / `nurbs` curve prims | evaluate to polylines on demand, keep the control form for editing |
| `fillet`, `curve offset 3D`, `curve boolean` (2D exists) | |
| `spline fit` from points, `smooth curve`, `project curve onto surface` | |
| `rail`, `fence`, `wall`, `road`, `cable` | shipped as graph assets built on `sweep` + packed copies |
| `attribute along curve` by ramp, `curveu` | |

### Volumes and SDF
| node | notes |
|---|---|
| grid volume ops | blur, dilate/erode, open/close, remap, combine, resample |
| `sdf fillet` (smooth union with radius exists; add surface fillet by SDF remesh) | |
| `voxel remesh` with dual contouring | sharp edges survive |
| `sdf from heightfield`, `volume from points` (pscale) | |

### Remesh, UV, cleanup, LOD
| node | notes |
|---|---|
| `uv unwrap` (xatlas), `uv layout`/pack, `uv flatten` (LSCM/BFF), `uv autoseam` | |
| `isotropic remesh` (Botsch–Kobbelt), `quad remesh` (Instant Meshes / QuadriFlow via WASM) | |
| `polyreduce` with attribute preservation (meshopt `simplifyWithAttributes`) | |
| `mesh repair` (self-intersections, non-manifold edges, degenerate faces), `lod` (multi-level output) | |

### Measurement and analysis
| node | notes |
|---|---|
| `curvature`, `ambient occlusion` / `thickness` bake (BVH rays), `distance` to mesh/curve, `convexity`, `visibility` | |
| `assert` / `expect` | watertight, counts, bbox, no flipped normals, min edge length, no self-intersections |

### Simulation-lite
| node | notes |
|---|---|
| `rbd` settle/stack via Rapier (drop rocks, stack crates, fill containers) | |
| `particles` | advect by velocity/noise/curl fields, collide with meshes, trails to curves |
| `cloth`/`drape` via XPBD (Vellum-lite) | tarps, cables, banners |
| `solver` | generic frame feedback (growth, reaction-diffusion, erosion steps) |

### IO and interop
| item | notes |
|---|---|
| Houdini `.geo` JSON | documented format, keeps every attribute and group, pure JS writer + reader |
| glTF via `gltf-transform` | instancing, materials, Draco / meshopt compression, `MSFT_lod` |
| USD | `PointInstancer`, materials, variants, per-frame layers |
| Unreal PCG | point streams with PCG names (`Density`, `Steepness`, `Seed`, `Color`) + a small UE plugin that turns
  them into a PCG data asset / ISM. Today the Unreal MCP can already import GLB and spawn actors from point lists. |
| images | PNG/EXR reading for maps, 16-bit PNG/RAW writing for heightmaps |
| CSV/JSON point IO | for any PCG tool |

---

## 3. Shipped asset library (the "shelf")

Houdini's value is partly the shelf and the HDA library. Polyforge's equivalent is JSON graph assets, and LLMs can
write them. Ship and regression-render 30–50 curated assets: fence, railing, stairs, road, roof (straight skeleton),
window grid, tree, rock, cliff, pipe run, cable, crate, barrel, brick wall, tiles, hex grid, scaffold, pillar, arch.
Each asset has typed `params`, a description, a thumbnail, and a golden test.

---

## 4. Open-source libraries worth using

Versions and licences checked against npm on 2026-10-12.

### Already in
| library | licence | role |
|---|---|---|
| manifold-3d 3.5 | Apache-2.0 | booleans, hull, Minkowski, level sets, Clipper2 2D (offset, 2D booleans) |
| meshoptimizer 1.3 | MIT | decimation; extend to `simplifyWithAttributes`, `simplifyPoints`, cache/overdraw optimisation, meshopt compression |
| earcut, d3-delaunay, simplex-noise, opentype.js, three | ISC/MIT | triangulation, 2D Delaunay/Voronoi, noise, fonts, viewer |

### Adopt next (npm, WASM or pure JS)
| library | licence | role | cost |
|---|---|---|---|
| `xatlas-three` 0.2 / `xatlas-web` 0.1 | MIT | UV unwrap and pack (xatlas WASM) | low |
| `@gltf-transform/core` + `extensions` 4.5 | MIT | production glTF writer: instancing, materials, Draco/meshopt, LOD | low |
| `@dimforge/rapier3d-compat` 0.21 | Apache-2.0 | rigid bodies, colliders, convex decomposition, shape/ray queries | medium |
| `verb-nurbs` 3.0 | MIT | NURBS curves/surfaces, intersections, tessellation (old but pure JS; own B-spline eval is also small) | low |
| `bezier-js` 6.1 | MIT | Bezier utilities (split, offset, arc length) | low |
| straight skeleton | own code | `straight-skeleton` 3.x on npm wraps CGAL (GPL), so it is out. Its v1 branch is pure TypeScript under MIT and can serve as a reference; otherwise port Felkel–Obdržálek in-house | medium |
| `delaunator` 5.1 + `robust-predicates` 3.0 | ISC / Unlicense | fast 2D Delaunay and exact predicates (d3-delaunay wraps Delaunator already) | low |
| `poisson-disk-sampling` 2.3 | MIT | Bridson N-D sampling (own sample elimination already exists) | low |
| `pngjs` / `fast-png`, `jpeg-js` | MIT / BSD | image reading for `attribute from map` | low |
| `webgpu` 0.6 | MIT | Dawn WebGPU bindings for Node: GPU compute headless | spike |
| `opencascade.js` 1.1 / `replicad` 1.1 | LGPL-2.1 / MIT | optional CAD module: B-rep fillets/chamfers, true lofts, STEP import/export. ~30 MB WASM, load on demand | high |
| `comlink`, React Flow or Rete.js, `leva` | Apache / MIT | GUI phase: worker RPC, node editor, parameter panels | later |

### Compile to WASM yourself (C++/Rust, permissive licences)
| project | licence | role |
|---|---|---|
| geometry-central | MIT | geodesic distance (heat method), BFF parameterisation, intrinsic remeshing, vector heat |
| Instant Meshes / QuadriFlow | BSD-3 | quad remeshing |
| PoissonRecon | MIT | point cloud → surface |
| libigl (core) | MPL-2.0 | ARAP, harmonic/biharmonic deformation, winding numbers, SLIM (avoid its GPL parts) |
| OpenVDB / NanoVDB | MPL-2.0 | real VDB grids and `.vdb` IO; large build, only if sampled volumes outgrow the in-house grid |
| fTetWild | MPL-2.0 | tetrahedral meshing, only if solid FEM ever matters |
| Rust crates: `baby_shark`, `parry3d`, `cavalier_contours`, `i_overlay`, `kiddo` | MIT / Apache | remeshing, simplification, voxel remesh, booleans, 2D offset with arcs, 2D booleans, KD-trees; all WASM-ready |

### Avoid
CGAL (GPL for most packages, including its straight skeleton and the npm `straight-skeleton` wrapper), TetGen (AGPL),
MeshFix (GPL). They would change Polyforge's licence. LGPL code such as OpenCascade is acceptable only as a separately
loaded, replaceable WASM module, never bundled into the core.

### Commercial use
Polyforge is Apache-2.0 (switched from MIT on 2026-10-12 while the author was the sole contributor). Every dependency
in use is MIT, Apache-2.0 or ISC, so commercial use, hosting and selling derived products are all permitted; the
obligations are keeping the licence notices, which the generated NOTICE file carries. The geometry a user produces is theirs. Relicensing Polyforge itself stays simple while there are
no outside contributors; adopt a CLA or DCO before accepting external pull requests if relicensing should remain possible.

---

## 5. Ideas that make Polyforge more than a Houdini clone

1. **Packed-first PCG.** Instance streams plus variant libraries as the native output, with Unreal PCG and USD
   PointInstancer export. Cheap, deterministic, textual: the one place an LLM-driven tool can beat Houdini on workflow.
2. **Self-verification for agents.** `assert`/`expect` nodes, an `explain` tool that returns shape descriptors
   (symmetry, pieces, aspect ratio, holes, genus, thin features, degenerate faces), and a `diff` tool that compares two
   graph versions by Hausdorff distance and a ghost-overlay render. Fewer vision round-trips, fewer silent regressions.
3. **Renders that answer questions.** Wireframe and edge overlays, cross-section views, normal and up glyphs,
   measurement callouts, a **UV view** (mandatory for UV work), heightfield layer views.
4. **Houdini as the oracle.** Parity tests through the Houdini MCP: cook the same op in both, compare. A unique way to
   get correctness without re-deriving every algorithm's edge cases.
5. **Self-extending engine.** Promote a `script` node plus a param schema to a named node type stored in the workspace,
   with a golden test. Agents write nodes, not just graphs. Assets already do this for graphs.
6. **Cook server.** Batch cooking of many graphs and frame ranges from the CLI, so CI builds asset libraries from JSON.
7. **Unreal round trip today.** The Unreal MCP already imports GLB and spawns actors. A `polyforge → unreal` push
   (export GLB, import as static mesh, place instances from a point list) can be built before the PCG plugin exists.

---

### 6a. Procedural textures and bakes (Phase 3, first)
Assets must ship with textures and never depend on files whose licence is unknown. A Substance-Designer-style image
node family (category `texture`): generators (noise, patterns, cells, shapes, gradients, splatter), filters (blend,
levels, blur, warp, transform, edge detect, normal from height, height to AO, channel packing, colorize, tile
sampler), and bakes from geometry in UV space (AO, curvature, thickness, position/normal, island ids, masks from
groups, vertex colour, high-to-low height). Images are 2D float layers carried on the geometry like heightfields and
referenced by materials as `image:<name>`; glTF embeds them, USD writes them next to the file, `textures` export writes
PNGs. A `texture` render view and persp texture sampling let agents look at the result. (Shipped 2026-10-13 as P3-T: 37 nodes.)

## 6. Sequencing

Each phase ends with golden tests and example renders. Performance work runs alongside every phase.

| phase | content | unlocks |
|---|---|---|
| **0. Foundation** | golden + property tests, benchmarks, edge/vertex groups, half-edge, array attributes, `time` + `solver`, expression functions, graph versioning | everything below |
| **1. Modelling parity** | polybevel, polysplit/knife, bridge, polyfill, loops/rings/dissolve, crease subdiv, soft transform, lattice, path/point deform, xatlas unwrap + layout, isotropic remesh, attribute-preserving decimation, curvature/AO/thickness, `assert` | hard-surface and prop work |
| **2. PCG and instancing** | packed prims, copy variants, scatter v2, masks, attribute from map, heightfield suite + erosion, spline toolkit, rail/fence/road/roof assets, PCG/USD/gltf-transform export, Houdini `.geo` | environments at engine scale |
| **3. Volumes, sim-lite, CAD** | grid volumes + VDB-like ops + dual contouring, Rapier RBD, particles, XPBD cloth, straight-skeleton roofs, optional OCCT module | organic shapes, settled scatters, CAD-grade fillets |
| **4. GUI** | browser node editor + viewport + generated param panels, engine in a Worker, shared workspace with the MCP server | human use without an LLM |

Suggested first sprint: phase 0 tests and benchmarks, then edge groups + half-edge + `polybevel`. Bevel is the node
that proves the topology layer and that artists check first.

## 7. Release and grants (after Phase 2)

Facts checked on 2026-10-13:
- **Epic MegaGrants** runs two submission cycles a year. 2026: cycle 1 January 12 – March 20 (notices June 15–19),
  cycle 2 June 29 – September 4 (notices December 7–11). Both are closed; the next window is expected to be cycle 1 of
  2027, opening around January 2027 with notices around June 2027. Typical awards are $5,000–$75,000, exceptional
  projects up to $150,000. Open-source tools "building or enhancing open-source tools with Unreal Engine" are an
  eligibility category; the stated criteria are the creative and innovative nature of the project, use of (or a
  project built around) Unreal Engine, and contribution to the open-source 3D graphics ecosystem. Confirm on the
  official MegaGrants page and FAQ before submitting.
- **NLnet**: the NGI Zero Commons Fund ended with its 13th call (June 1, 2026). Open now: the Restack and CodeSupply
  funds plus an open call, deadline November 3, 2026, 12:00 CET, grants €5,000–€50,000, strictly open source,
  mostly for Horizon-Europe-eligible applicants. NLnet states that AI-generated projects or proposals are not of
  interest and the form requires a disclosure of generative-AI use. This project is largely AI-implemented; any
  application must say so plainly, which makes NLnet a weak fit.

Plan toward a MegaGrants cycle-1-2027 submission:
1. Unreal 5.8 round trip verified in the editor (landscape bundle, instanced GLB, PCG stream), with screenshots.
   Verified 2026-10-13 (P2-G, see WORKLOG).
2. Rename to TopoTopo in one commit, tag v0.2, publish to npm, public repository, CI back on.
3. A 2–3 minute demo video: graph → terrain + instances → Unreal, plus an agent building and verifying a prop.
4. Application text drafted from ROADMAP and WORKLOG: problem, what exists (numbers), what the grant funds
   (milestones with costs), why it helps the Unreal and open-source 3D community, team and track record.
5. Optional: textures (P3-T) in the demo so assets arrive in Unreal with materials.
