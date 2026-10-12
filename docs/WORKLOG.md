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
| P0-B | Engine: time/frame in cook options, `usesTime`, `solver` node, expression functions reading upstream geometry (`npoints`, `bbox`, `detail`, `point`, `prim`, `centroid`) and `ch()` references, graph `version` + migrations, node deprecation, CLI `--frame/--frames`, MCP `frame` | running (agent) | started 2026-10-12 |
| P0-C1 | Geometry model: vertex groups, edge groups (point-pair canonical form), half-edge structure with cache, edge/vertex group patterns, `group` node for all classes, `group_promote`, `group_expand`, crease-aware `subdivide`, `normal` hard edges, JSON IO round trip, inspect/summary output | running (agent) | started 2026-10-12 |
| P0-C2 | Array attributes (`float[]`, `int[]`, `string[]`) through builder, merge, wrangle, JSON IO | queued | after C1 |
| P0-D | Worker pool behind `Host` (parallel branches, chunked wrangles) + benchmarks gate | queued | after A, B |
| P0-E | Bugs from P0-A: (1) `subdivide levels:0` mutates its input via `refreshNormals` on the uncloned input, audit all 8 `refreshNormals` callers; (2) `fill`/`offset_curve`/`boolean2d` throw raw TypeError on empty input; (3) `script` node can hang the process: vm timeout covers only the synchronous part, `await 0; while(true){}` hangs the MCP server; (4) wrangle syntax errors after the snippet end (unclosed `[`, stray `}`) have no line hint and a stray `}` escapes the kernel wrapper; (5) `boolean` fixture is empty (sphere encloses box); (6) only 7/96 NodeDefs have `example` | queued | after B and C1 (they edit code.ts, wrangle.ts, topology.ts) |
| P0-F | Performance: `fuse` (5.0 s at 500k, superlinear), `subdivide` (1.4 s/level at 100k), `copy_to_points` (3.1 s for 10M tris), `scatter` (1.4 s/1M) | queued | after C1 and P2-A (packed copies change the copy case) |

### Phase 1: modelling parity
| id | item | status | notes |
|---|---|---|---|
| P1-A | `polybevel` (edge + point, chamfer/round, segments) | queued | after C1 |
| P1-B | `polysplit`/`knife`, `polybridge`, `polyfill` (quad), edge loop/ring/dissolve/collapse/divide ops | queued | after C1 |
| P1-C | Deformers: `soft_transform` with falloff ramps, `lattice`, `path_deform`, `point_deform`, `rest` | running (agent) | started 2026-10-12 from cc5fb0a |
| P1-D | UVs: `uv_unwrap` (xatlas), `uv_layout`, `uv_flatten` (LSCM), UV view in render | running (agent) | started 2026-10-12 from cc5fb0a |
| P1-E | `remesh_isotropic`, attribute-preserving `decimate` (meshopt), `mesh_repair`, `lod` | queued | after C1 |
| P1-F | Measures: `curvature`, `occlusion`/`thickness` bake, `distance`, `assert`/`expect`, `explain` + `diff` MCP tools | queued | |
| P1-G | Render upgrades: wireframe/edge overlay, cross-section, normal/up glyphs, group/piece labels | queued | |

### Phase 2: PCG and instancing
| id | item | status | notes |
|---|---|---|---|
| P2-A | Packed primitives: `packed` prim kind, packed `copy_to_points`, `unpack`, auto-unpack, instanced rendering | queued | |
| P2-B | `copy_to_points` variants, scatter v2 (density attr/map/mask, relax, min distance, collision prune), masks by slope/height/curvature/occlusion/distance, `attribute_from_map` (PNG/EXR), orient helpers, points along splines, clustering | queued | after P2-A |
| P2-C | Heightfield prim + suite: create/from mesh/from image/noise/remap/blur/terrace/cutout/mask by feature/project/path/scatter/to mesh/to sdf, erosion, 16-bit PNG/RAW export | queued | |
| P2-D | Spline toolkit: bezier/nurbs prims, fillet, 3D offset, spline fit, project to surface, curveu/ramp attributes | queued | |
| P2-E | Exports: gltf-transform writer with instancing/materials/compression/LOD, USD PointInstancer + materials, Houdini `.geo` JSON read/write, PCG point stream, CSV/JSON points, material attribute + table | queued | after P2-A |
| P2-F | Asset shelf: 30+ curated graph assets (fence, rail, stairs, road, roof, window grid, tree, rock, cliff, pipes, cable, crate, barrel, bricks, tiles, hex grid, scaffold, pillar, arch) with golden renders | queued | after P2-B |
| P2-G | Houdini parity tests through the Houdini MCP; Unreal round trip through the Unreal MCP | queued | needs apps running |

## Log
- 2026-10-12: roadmap written, decisions taken, LICENSE added, run started. P0-A, P0-B, P0-C1 launched.
- 2026-10-12: P0-A merged (cc5fb0a). `npm test` now has seven layers; goldens must be updated after geometry changes. Six bugs filed as P0-E, four slow cases as P0-F. P1-C and P1-D launched.
