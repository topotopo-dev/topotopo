# Briefs for an external agent

Three self-contained work packages for an agent working outside the Polyforge orchestration. They are ordered by
expected impact. Package 1 is the one to start with; packages 2 and 3 are independent of it.

## Context (read once)

Polyforge is an LLM-native procedural geometry engine: Houdini-SOP-style node graphs in JSON, cooked by a
TypeScript core that runs unchanged in Node 22+ and in browsers (WebAssembly for heavy libraries: manifold-3d,
meshoptimizer). It exposes an MCP server so LLM agents can build geometry. Repository: `github.com/faxlab/polyforge`
(MIT). Read `README.md`, `docs/DESIGN.md`, `docs/ROADMAP.md` (the gap analysis and the library survey) and
`docs/WORKLOG.md` (what is in flight; do not duplicate it).

Hard constraints for anything that lands in the repo:
- Licences: MIT, Apache-2.0, BSD, ISC, MPL-2.0 (file-level) only. No GPL/AGPL anywhere in a dependency tree
  (CGAL, TetGen, MeshFix are out). LGPL only as a separately loaded module.
- Everything must run in Node 22+ **and** in a browser: no native Node addons, no OS threads unless optional
  (WASM threads via SharedArrayBuffer can be an opt-in build), no filesystem access inside kernels.
- Determinism: the same inputs and seed give bit-identical outputs on every platform (no HashMap iteration order
  leaking into results, no platform-dependent float paths such as FMA differences; prefer explicit operation order).
- Y-up, metres, degrees at the node level; kernels take radians and are unit-agnostic.
- Polygons are stored CSR-style: `prim_start: u32[nprims+1]`, `vertex_point: u32[nverts]`, `closed: u8[nprims]`
  (0 = polyline). Positions are `f64` in the engine; kernels may take `f32` or `f64`, say which.

---

## Package 1 (primary): `polyforge-kernels`, a Rust → WASM compute crate

### Why
The TypeScript core is fine up to about 100k elements. Above that, and for algorithms that are hard to make robust,
we want native kernels. The benchmark baseline in `bench/baseline.json` shows the current pain: fuse of 500k points
5.0 s, Catmull-Clark of 100k faces × 2 levels 7.4 s, copy to 100k points 3.1 s. Several roadmap nodes have no robust
permissive implementation we can source (straight skeleton, quad remeshing, erosion, dual contouring).

### Deliverable
A Cargo crate in `kernels/` (workspace at the repo root), built with `wasm-pack build --target web --release` into
`kernels/pkg/` (committed, so users never need Rust), plus:
- `kernels/BUILD.md`: exact toolchain versions and commands; a `npm run kernels:build` script.
- A thin TypeScript loader `src/wasm/kernels.ts` that initialises the module once (works in Node via
  `fs.readFile` of the `.wasm`, in browsers via `fetch`; follow how `src/core/manifold.ts` loads manifold-3d) and
  exposes typed functions. Keep it host-agnostic by taking the wasm bytes from the caller.
- Rust unit tests and property tests (proptest or quickcheck) for every kernel, `cargo bench` (criterion) for the
  big ones, and a Node smoke test `test/kernels.ts` that loads `kernels/pkg` and runs each kernel on a small case.
- WASM size budget: under 2 MB for the whole module (use `opt-level = "s"` or `z` where it does not hurt, `lto`,
  `wasm-opt`). No `std::collections::HashMap` with default hasher in anything that affects output order.

### API contract (so integration is mechanical)
Flat typed arrays in, flat typed arrays out, through `wasm-bindgen`. Every mesh-producing kernel returns
**provenance** so the engine can interpolate attributes with its `GeoBuilder`:
- `src_point: i32[n_out_points]` (index of the single source point, or -1),
- `blend_offset: u32[n_out_points+1]`, `blend_index: u32[]`, `blend_weight: f32[]` (CSR of weighted sources for
  points that are not plain copies),
- `src_prim: i32[n_out_prims]` (the input polygon a new polygon derives from, or -1),
- the same for vertices when the kernel preserves per-corner data (`src_vertex`).
Errors are `Result<_, String>` with a message a human can act on. No panics on bad input: validate and return `Err`.
Seeds are explicit `u64` parameters.

### Kernels, in priority order
1. **Straight skeleton** (`straight_skeleton`): weighted straight skeleton of a polygon with holes (Felkel–Obdržálek
   with the known fixes, or the Biedl et al. formulation; weights optional). Output: skeleton arcs, and per input
   edge its "roof face" polygon (needed for roofs: `roof(polygon, pitch per edge)` → faces with heights), plus an
   `offset(polygon, d)` built from the skeleton. Must survive collinear vertices, near-parallel edges, split and
   edge events in any order, and the classic failure corpus (include the test polygons from the CGAL/polyskel issue
   trackers, re-implemented, not copied). This replaces an npm package we cannot use because it wraps CGAL (GPL).
2. **Isotropic remeshing** (`remesh_isotropic`): Botsch–Kobbelt (split long, collapse short, flip for valence,
   tangential relaxation, project back to the input surface with a BVH), with feature-edge preservation by dihedral
   angle, boundary preservation, and an optional per-point target edge length (`f32[]`) for adaptive density.
   Target: 100k triangles, 10 iterations, under 1 s.
3. **Quad remeshing** (`remesh_quad`): field-aligned quad-dominant remeshing (Instant Meshes style: orientation field
   + position field smoothing on a multiresolution hierarchy, then extraction) with target edge length and optional
   crease alignment. Pure quad output is not required; quad-dominant with a `quad_fraction` report is.
4. **Heightfield erosion** (`erode`): hydraulic (particle or grid-based pipe model) and thermal erosion on a
   heightfield `f32[w*h]` with cell size, optional `hardness` layer, parameters for rain, evaporation, sediment
   capacity, deposition/erosion rates, talus angle, iterations, seed. Outputs: height, `flow`, `sediment`, `wear`
   layers. Target: 1024² × 200 iterations under 2 s single-threaded; keep the inner loops SIMD-friendly
   (`wasm32 simd128` behind a feature flag).
5. **SDF grids** (`sdf`): narrow-band signed distance from a triangle mesh (exact distance via BVH inside the band,
   fast sweeping outside, sign by generalized winding number so non-watertight input still works), grid CSG
   (union/intersect/subtract/smooth variants), dilate/erode/blur, and **dual contouring with QEF** so sharp features
   survive meshing (manifold output; Hermite data from the grid). Target: 256³ band + DC under 1.5 s.
6. **Point kernels** (`points`): `fuse` (spatial hash, tolerance, returns a remap `u32[]`), `relax_on_surface`
   (Lloyd/repulsion relaxation of points constrained to a mesh with a BVH), `sample_elimination` (weighted blue noise,
   Yuksel 2015) and `poisson_disk_on_mesh`, each at 1M points in well under a second.
7. Stretch: geodesic distance by the heat method (sparse Cholesky, no external solver crate with a bad licence),
   ABF++ or BFF parameterisation, self-intersection detection and local repair.

Dependencies allowed: `nalgebra`/`glam`, `parry3d` (BVH/queries), `kiddo`, `robust` (exact predicates), `rayon`
only behind a feature flag, `wasm-bindgen`, `js-sys`. Check every crate's licence; the whole tree must be permissive.

### Acceptance
`cargo test` and `cargo clippy -- -D warnings` clean; `test/kernels.ts` passes in Node 22 and 24; the TS loader works
in a browser (a tiny `kernels/demo.html` that loads the module and runs `fuse` is enough); benchmarks in
`kernels/BENCH.md` with the machine noted. Report each kernel's limits honestly.

---

## Package 2: 2026 landscape audit (research, written report)

A written report (`docs/research/landscape-2026.md`) answering, with sources and dates:
1. For every library in `docs/ROADMAP.md` §4: current version, maintenance status, licence changes, known
   problems, and better alternatives that appeared since mid-2026. Specifically: xatlas and its WASM wrappers (is
   there a maintained headless build?), OpenVDB/NanoVDB for WASM, gltf-transform, Rapier, geometry-central WASM
   builds, Instant Meshes/QuadriFlow ports, Rust geometry crates (`baby_shark`, `parry`, `cavalier_contours`,
   `i_overlay`), and WebGPU in Node (Dawn bindings: does `webgpu` on npm work on Windows/Linux today, and is Deno a
   better headless GPU host?).
2. Unreal Engine 5.8 PCG: the supported ways to bring external point data and meshes in (PCG Data Assets, external
   data tables, the point cloud and Alembic routes, Interchange for GLB/USD), the attribute names and coordinate
   conventions PCG expects (`$Position`, `$Rotation`, `$Scale`, `$Density`, `$Seed`, bounds, steepness), and whether
   a C++ PCG element can load a JSON file at graph execution time. What changed between 5.5 and 5.8.
3. Houdini 21 and Blender 5.0 Geometry Nodes: new or renamed nodes in the modelling, scatter, heightfield and curve
   families that Polyforge should mirror (names and parameter conventions), and any new interchange features (USD,
   `.bgeo` changes).
4. glTF and USD in 2026: extensions worth supporting for instancing, LODs, materials and metadata; USD versions
   Houdini/Blender/Unreal read today; whether `usda` text remains sufficient or `usdc` is now expected.
5. Any new permissive implementations of: straight skeleton, robust booleans beyond manifold, quad remeshing,
   erosion, exact geodesics, mesh parameterisation. If something solid exists, say so with its licence, and package
   1's scope shrinks accordingly.

Keep it factual and short: a table per topic, then recommendations with a one-line reason each.

---

## Package 3 (optional): Unreal Engine 5.8 bridge plugin

A C++ editor plugin `PolyforgePCG` for UE 5.8, in its own repository:
- A PCG element (`UPCGPolyforgeLoadSettings` + element) that reads a Polyforge point stream (CSV or the
  `points.json` schema from `src/io/points.ts`) into PCG point data with every attribute preserved, converting
  Y-up metres to Z-up centimetres and `orient`/`N`+`up` to rotations.
- An editor utility (or Interchange pipeline) that imports Polyforge GLB files as Static Meshes with their `name`
  split and materials, and an "instance from point stream" action that creates ISM/HISM components.
- Optionally, a "Cook with Polyforge" node that runs the Polyforge CLI (`node src/cli.ts graph.json --export …`)
  as a subprocess with a timeout, so a PCG graph can call a Polyforge graph.
Tests: a sample level that loads a 100k-point stream and a GLB. Document the install.

Verification on our side: the orchestrator can drive the Unreal editor through its MCP once UE 5.8 is installed, so
report exactly which files to load and what to expect.
