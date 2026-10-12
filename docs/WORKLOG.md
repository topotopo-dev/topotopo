# Worklog: the Houdini-parity run

Orchestration state for the long-horizon implementation of [ROADMAP.md](ROADMAP.md). The orchestrator (Claude Fable)
keeps this file current; implementation agents (Claude Opus) work one item each in isolated git worktrees. Read this
before touching the repo during the run.

## Decisions (2026-10-12)
- Scope: roadmap phases 0–2 (foundation, modelling parity, PCG/instancing). Volumes/sim/CAD and the GUI wait.
- Source control: agents commit on worktree branches; the orchestrator verifies, merges into `main`, pushes to
  `github.com/faxlab/polyforge` after every merge. No PRs.
- Licence: MIT, LICENSE file added. Dependencies must be MIT/Apache-2.0/ISC/BSD/MPL-2.0 (file-level). No GPL/AGPL.
  LGPL only as a separately loaded module. `straight-skeleton` on npm wraps CGAL (GPL): do not add it.
- Toolchains: anything needed may be installed (Rust + wasm-pack, emscripten). Rust 1.94 is present.
- External apps: Houdini (parity oracle), Blender (import checks) and Unreal 5.8 (round trip, after its reinstall
  finishes) may be driven through their MCP servers.
- Parallelism: decided per item; typically 2–3 agents at once, split so they touch different files.

## Conventions for implementation agents
- Follow `CLAUDE.md`: erasable TS only, `import type`, `.ts` import extensions, no build step; `src/core`, `src/graph`,
  `src/nodes` stay host-agnostic; one `defineNode()` per node with typed, defaulted, described params; clone before
  writing; Y-up, metres, degrees; Houdini attribute names.
- Every item ships tests (hooked into `npm test`) and docs (`src/mcp/docs.ts` topics, `docs/DESIGN.md` where the model
  changes, README node table).
- Verify before reporting: `npm run typecheck`, `npm test`, and `npm run showcase` when rendering or geometry output
  could change (then look at `examples/renders/*.png`).
- Commit on the worktree branch only. Never switch branches, never touch `main`, never push.
- Final report: branch name, worktree path, change summary, new/changed nodes and params, test output summary, known
  limitations, merge notes for the orchestrator.

## Merge procedure (orchestrator)
1. Read the agent report, skim the diff (`git diff main...<branch> --stat`, then the core files).
2. `git merge --no-ff <branch>` into `main` (resolve conflicts, typically `package.json` scripts, `test/`, `docs.ts`).
3. `npm run typecheck && npm test && npm run showcase`; look at changed renders.
4. Update this worklog (status table + log), README node table if needed; commit; `git push`.
5. Remove the worktree and branch.

## Work items

Status: `queued` → `running (agent)` → `review` → `merged` / `dropped`.

### Phase 0: foundation
| id | item | status | notes |
|---|---|---|---|
| P0-A | Test infrastructure: shared fixtures, golden tests per node + per example, property tests (random graphs, determinism, cache correctness), wrangle fuzz, benchmark harness, node reference generator (`docs/nodes.md`), GitHub Actions CI | merged | cc5fb0a, 2026-10-12. Baseline bench on i7-10700K: fuse 500k = 5.0 s, subdivide 100k×2 = 7.4 s, copy_to_points 100k = 3.1 s, scatter 1M = 1.4 s are over target |
| P0-B | Engine: time/frame in cook options, `usesTime`, `solver` node, expression functions reading upstream geometry (`npoints`, `bbox`, `detail`, `point`, `prim`, `centroid`) and `ch()` references, graph `version` + migrations, node deprecation, CLI `--frame/--frames`, MCP `frame` | merged | acfabed, 2026-10-12. Also fixed foreach not re-cooking on parent var change. Limits: viewer cooks frame 1, MCP export single frame, sdf_expr/parametric code cannot read time |
| P0-C1 | Geometry model: vertex groups, edge groups (point-pair canonical form), half-edge structure with cache, edge/vertex group patterns, `group` node for all classes, `group_promote`, `group_expand`, crease-aware `subdivide`, `normal` hard edges, JSON IO round trip, inspect/summary output | merged | ddcd449, 2026-10-12. 102 nodes. Agent had finished and was merging main when the PC crashed; orchestrator completed the merge |
| P0-C2 | Array attributes (`float[]`, `int[]`, `string[]`) through builder, merge, wrangle, JSON IO | merged | 3506ba8, 2026-10-12. 108 nodes. CSR storage, never blended; no vector arrays; index arrays not renumbered by topology ops. Also fixed setpointattrib & co. |
| P0-D | Worker pool behind `Host` (parallel branches, chunked wrangles) + benchmarks gate | queued | after A, B |
| P0-E | Bugs from P0-A: (1) `subdivide levels:0` mutates its input via `refreshNormals` on the uncloned input, audit all 8 `refreshNormals` callers; (2) `fill`/`offset_curve`/`boolean2d` throw raw TypeError on empty input; (3) `script` node can hang the process: vm timeout covers only the synchronous part, `await 0; while(true){}` hangs the MCP server; (4) wrangle syntax errors after the snippet end (unclosed `[`, stray `}`) have no line hint and a stray `}` escapes the kernel wrapper; (5) `boolean` fixture is empty (sphere encloses box); (6) only 7/96 NodeDefs have `example` | merged | 5b11ce0, 2026-10-12. Script sandbox: microtaskMode afterEvaluate + Host.runGuardedAsync; wrangle line hints via Host.checkSyntax; test/bugs.ts sweeps. Open: script syntax errors have no line hint; boolean2d xor leaks CrossSections; vm realm is not a security boundary |
| P0-F | Performance: `fuse` (5.0 s at 500k, superlinear), `subdivide` (1.4 s/level at 100k), `copy_to_points` (3.1 s for 10M tris), `scatter` (1.4 s/1M) | queued | after P2-A. Add: TriBVH build (Array sort per node) flagged by P1-F; occlusion 50k×32 over target; uv_unwrap 2.7 s/20k tris |

### Phase 1: modelling parity
| id | item | status | notes |
|---|---|---|---|
| P1-A | `polybevel` (edge + point, chamfer/round, segments) | merged | db74e85, 2026-10-12. Node is poly_bevel (aliases polybevel, bevel, chamfer). 121 nodes. Limits: boundary edges skipped; clamp is one global factor; irregular round corners relaxed, not spherical |
| P1-B | `polysplit`/`knife`, `polybridge`, `polyfill` (quad), edge loop/ring/dissolve/collapse/divide ops | merged | 80ed39a, 2026-10-12. 119 nodes. Limits: knife above/below groups single plane; polybridge inner-face heuristic; polyfill quad fan pole |
| P1-C | Deformers: `soft_transform` with falloff ramps, `lattice`, `path_deform`, `point_deform`, `rest` | merged | 553beb1, 2026-10-12. 107 nodes. Limits: lattice cage must be axis-aligned; path_deform polylines only; point_deform max_points 4 default (8 measured better) |
| P1-D | UVs: `uv_unwrap` (xatlas), `uv_layout`, `uv_flatten` (LSCM), UV view in render | merged | 522dc77, 2026-10-12. xatlas-wasm 0.1.3 (MIT). Limits: uv_layout packs bounding rects; unwrap 2.7 s/20k tris; autoseam rough |
| P1-E | `remesh_isotropic`, attribute-preserving `decimate` (meshopt), `mesh_repair`, `lod` | running (agent) | started 2026-10-12 from 2e787d2 |
| P1-F | Measures: `curvature`, `occlusion`/`thickness` bake, `distance`, `assert`/`expect`, `explain` + `diff` MCP tools | merged | b55cdd2, 2026-10-12. 125 nodes. Limits: occlusion 50k×32 ≈ 2.3 s (TriBVH build sorts arrays; P0-F); `thickness` alias still runs occlusion mode because nodes cannot see the alias used (engine could pass ctx.alias); self-intersection test misses coplanar overlaps; assert expr cannot read vars |
| P1-G | Render upgrades: wireframe/edge overlay, cross-section, normal/up glyphs, group/piece labels | merged | 8a9db22, 2026-10-12. CLI render supersampling flag is --render-scale (--scale stays export units). Limits: section view has no labels/glyphs; clip caps sampled on a 2048-cell grid; points:true now sizes by pscale |

### Phase 2: PCG and instancing
| id | item | status | notes |
|---|---|---|---|
| P2-A | Packed primitives: `packed` prim kind, packed `copy_to_points`, `unpack`, auto-unpack, instanced rendering | running (agent) | started 2026-10-12 from 87ac66f |
| P2-B | `copy_to_points` variants, scatter v2 (density attr/map/mask, relax, min distance, collision prune), masks by slope/height/curvature/occlusion/distance, `attribute_from_map` (PNG/EXR), orient helpers, points along splines, clustering | queued | after P2-A |
| P2-C | Heightfield prim + suite: create/from mesh/from image/noise/remap/blur/terrace/cutout/mask by feature/project/path/scatter/to mesh/to sdf, erosion, 16-bit PNG/RAW export | running (agent) | started 2026-10-12 from ac5f6b9 |
| P2-D | Spline toolkit: bezier/nurbs prims, fillet, 3D offset, spline fit, project to surface, curveu/ramp attributes | queued | |
| P2-E | Exports: gltf-transform writer with instancing/materials/compression/LOD, USD PointInstancer + materials, Houdini `.geo` JSON read/write, PCG point stream, CSV/JSON points, material attribute + table | part 1 merged | 0d1ec15, 2026-10-12. gltf-transform GLB/glTF (validated), Houdini .geo/.bgeo read + .geo write (verified on SideFX Labs files), CSV/points JSON with PCG columns, material node + table. Open: external checks in Houdini/Blender/Unreal (scratchpad verify/ files); .geo key layout unconfirmed against a Houdini-written ASCII file; part 2 (packed instancing, USD PointInstancer) after P2-A |
| P2-F | Asset shelf: 30+ curated graph assets (fence, rail, stairs, road, roof, window grid, tree, rock, cliff, pipes, cable, crate, barrel, bricks, tiles, hex grid, scaffold, pillar, arch) with golden renders | queued | after P2-B |
| P2-G | Houdini parity tests through the Houdini MCP; Unreal round trip through the Unreal MCP | queued | needs apps running |

## External track
- An outside agent (different vendor) takes `docs/briefs/external-agent.md`: package 1 is the Rust→WASM kernels crate (straight skeleton, isotropic/quad remeshing, erosion, SDF grids + dual contouring, point kernels), package 2 a 2026 landscape audit, package 3 an optional UE 5.8 PCG plugin. Integration of the kernels into nodes stays with this run (P0-F perf, P2-C heightfields, P1-E remesh).

## Log
- 2026-10-12: P1-G merged (8a9db22): overlays, section/clip, glyphs, labels, shading, presets. Running: P2-C, P1-E, P2-A.
- 2026-10-12: P1-F merged (b55cdd2): curvature, occlusion, distance, assert; explain and diff tools. Running: P2-C, P1-E, P1-G, P2-A.
- 2026-10-12: P1-A merged (db74e85). GitHub Actions stopped: the account budget for the private repo is exhausted; tests run locally at every merge. Running: P1-F, P2-C, P1-E, P1-G, P2-A.
- 2026-10-12: P2-E1 merged (0d1ec15). Dependency note: manifold-3d pulls @gltf-transform/functions → sharp (LGPL libvips, optional native, unused by us). Blender addon not reachable for the GLB check.
- 2026-10-12: P0-E, P1-D, P1-B merged (5b11ce0, 522dc77, 80ed39a). P2-C, P1-E, P1-G launched. Running: P2-E1, P1-A, P1-F, P2-C, P1-E, P1-G.
- 2026-10-12: P0-C2 merged (3506ba8): array attributes. P1-F launched.
- 2026-10-12: P1-C merged (553beb1): soft_transform, lattice, path_deform, point_deform, rest.
- 2026-10-12: text node now defaults to the bundled DejaVu Sans with a glyph layout fallback (74db5c2); goldens no longer machine dependent. External-agent briefs written.
- 2026-10-12: PC crashed with four agents running. P0-C1 was complete on disk and was merged (ddcd449); P1-C, P1-D, P2-E1 resumed from their transcripts (little on disk). `.gitattributes` added (LF).
- 2026-10-12: roadmap written, decisions taken, LICENSE added, run started. P0-A, P0-B, P0-C1 launched.
- 2026-10-12: CI failed on Linux: opentype.js rejects DejaVu Sans (GSUB lookup 6 format 2). Fixed by trying font candidates in order (`Host.fontCandidates`) and installing Liberation/FreeFont in CI.
- 2026-10-12: P0-B merged (acfabed): time, solver, expression references, versioning. 97 nodes.
- 2026-10-12: P0-A merged (cc5fb0a). `npm test` now has seven layers; goldens must be updated after geometry changes. Six bugs filed as P0-E, four slow cases as P0-F. P1-C and P1-D launched.
