# Worklog: the Houdini-parity run

Orchestration state for the long-horizon implementation of [ROADMAP.md](ROADMAP.md). The orchestrator (Claude Fable)
keeps this file current; implementation agents (Claude Opus) work one item each in isolated git worktrees. Read this
before touching the repo during the run.

## Decisions (2026-10-12)
- Scope: roadmap phases 0–2 (foundation, modelling parity, PCG/instancing). Volumes/sim/CAD and the GUI wait.
- Source control: agents commit on worktree branches; the orchestrator verifies, merges into `main`, pushes to
  `github.com/faxlab/polyforge` after every merge. No PRs.
- Licence: Apache-2.0 since 2026-10-12 (was MIT; decision 2 below). LICENSE + generated NOTICE. Dependencies must be MIT/Apache-2.0/ISC/BSD/MPL-2.0 (file-level). No GPL/AGPL.
  LGPL only as a separately loaded module. `straight-skeleton` on npm wraps CGAL (GPL): do not add it.
- Toolchains: anything needed may be installed (Rust + wasm-pack, emscripten). Rust 1.94 is present.
- External apps: Houdini (parity oracle), Blender (import checks) and Unreal 5.8 (round trip, after its reinstall
  finishes) may be driven through their MCP servers.
- Parallelism: decided per item; typically 2–3 agents at once, split so they touch different files.

## Decisions (2026-10-12, from the side discussion)
1. **Name: TopoTopo** (brand), `topotopo` for the package, CLI, GitHub org and crates; CLI alias `topo`. The code rename
   happens in ONE dedicated commit right before the first tagged release (package name, MCP server name in `.mcp.json`,
   `POLYFORGE_*` env vars, CLI, README, docs, examples, the kernels crate name in `docs/briefs/external-agent.md`).
   Until then the code says polyforge. Availability check (2026-10-12): npm `topotopo` free, crates.io free, PyPI free;
   GitHub `topotopo` is TAKEN (a user account since 2015); domains: `.com` registered, `.org` registered, `.io`
   registered, `.dev` FREE, `.app` FREE, `.net` FREE; no software, company or trademark found under the full word.
   The user registers handles and domains; trademark filing is deferred until revenue or a grant (reminder item).
2. **Licence: Apache-2.0** (switched from MIT while the author is sole contributor) with a NOTICE file carrying every
   third-party licence text, including the bundled DejaVu font and xatlas (its npm tarball ships no licence file).
3. **Contribution hygiene**: CONTRIBUTING.md (one maintainer, slow reviews, small PRs, issue before large changes, every
   node needs tests and docs), Contributor Covenant code of conduct, DCO sign-off check in CI, issue templates (bug
   reports must include the graph JSON that reproduces them).
4. **Positioning leads with the pipeline, not AI**: README first line, package.json description and landing copy read
   "a procedural geometry engine: Houdini-style node graphs, headless, deterministic, exports to Unreal, Blender and
   Houdini". Agent and MCP support is a feature section. Internal docs may keep saying LLM-native.
5. **Milestone after Phase 2: grant applications** (Epic MegaGrants, NLnet NGI Zero) built on an Unreal 5.8 demo.
   Sequence: packed instancing (P2-A, done) → PCG point stream + USD PointInstancer (P2-E part 2) → heightfields with
   Landscape export (P2-C, done) → Unreal round trip (P2-G) → tagged v0.2 on npm under the new name → 2–3 minute demo
   video plan. Draft the application text from ROADMAP and WORKLOG when the demo renders.

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
| P0-F | Performance: `fuse` (5.0 s at 500k, superlinear), `subdivide` (1.4 s/level at 100k), `copy_to_points` (3.1 s for 10M tris), `scatter` (1.4 s/1M) | running (agent) | started 2026-10-12 from 202ef7a |

### Phase 1: modelling parity
| id | item | status | notes |
|---|---|---|---|
| P1-A | `polybevel` (edge + point, chamfer/round, segments) | merged | db74e85, 2026-10-12. Node is poly_bevel (aliases polybevel, bevel, chamfer). 121 nodes. Limits: boundary edges skipped; clamp is one global factor; irregular round corners relaxed, not spherical |
| P1-B | `polysplit`/`knife`, `polybridge`, `polyfill` (quad), edge loop/ring/dissolve/collapse/divide ops | merged | 80ed39a, 2026-10-12. 119 nodes. Limits: knife above/below groups single plane; polybridge inner-face heuristic; polyfill quad fan pole |
| P1-C | Deformers: `soft_transform` with falloff ramps, `lattice`, `path_deform`, `point_deform`, `rest` | merged | 553beb1, 2026-10-12. 107 nodes. Limits: lattice cage must be axis-aligned; path_deform polylines only; point_deform max_points 4 default (8 measured better) |
| P1-D | UVs: `uv_unwrap` (xatlas), `uv_layout`, `uv_flatten` (LSCM), UV view in render | merged | 522dc77, 2026-10-12. xatlas-wasm 0.1.3 (MIT). Limits: uv_layout packs bounding rects; unwrap 2.7 s/20k tris; autoseam rough |
| P1-E | `remesh_isotropic`, attribute-preserving `decimate` (meshopt), `mesh_repair`, `lod` | merged | 9eea4c9, 2026-10-12. 153 nodes. Limits: meshoptimizer can pinch thin parts at very low ratios; a process exiting right after meshoptimizer WASM calls can trip a libuv assertion (node --no-wasm-dynamic-tiering avoids it; P0-E follow-up) |
| P1-F | Measures: `curvature`, `occlusion`/`thickness` bake, `distance`, `assert`/`expect`, `explain` + `diff` MCP tools | merged | b55cdd2, 2026-10-12. 125 nodes. Limits: occlusion 50k×32 ≈ 2.3 s (TriBVH build sorts arrays; P0-F); `thickness` alias still runs occlusion mode because nodes cannot see the alias used (engine could pass ctx.alias); self-intersection test misses coplanar overlaps; assert expr cannot read vars |
| P1-G | Render upgrades: wireframe/edge overlay, cross-section, normal/up glyphs, group/piece labels | merged | 8a9db22, 2026-10-12. CLI render supersampling flag is --render-scale (--scale stays export units). Limits: section view has no labels/glyphs; clip caps sampled on a 2048-cell grid; points:true now sizes by pscale |

### Phase 2: PCG and instancing
| id | item | status | notes |
|---|---|---|---|
| P2-A | Packed primitives: `packed` prim kind, packed `copy_to_points`, `unpack`, auto-unpack, instanced rendering | merged | 7715c68, 2026-10-12. 127 nodes. 1M packed copies 0.23 s; unpack 100k×100 tris 0.4 s. Limits: no per-instance attributes in glTF/USD; renderer expands within a 600k-triangle budget; .glb import now packed by default |
| P2-B | `copy_to_points` variants, scatter v2 (density attr/map/mask, relax, min distance, collision prune), masks by slope/height/curvature/occlusion/distance, `attribute_from_map` (PNG/EXR), orient helpers, points along splines, clustering | merged | 2026-10-12. 159 nodes; new category pcg. Limits: blue-noise relax ≈ 10 s/100k (P0-F); curve mode has no relaxation; PNG maps only |
| P2-C | Heightfield prim + suite: create/from mesh/from image/noise/remap/blur/terrace/cutout/mask by feature/project/path/scatter/to mesh/to sdf, erosion, 16-bit PNG/RAW export | merged | fa4b59d, 2026-10-12. 23 heightfield nodes, droplet + thermal erosion (512²×100 ≈ 2.3 s), png16/r16/mask export with Unreal sidecar. Limits: fields stay axis-aligned; Unreal axis convention not yet verified in the editor; no pipe-model erosion |
| P2-D | Spline toolkit: bezier/nurbs prims, fillet, 3D offset, spline fit, project to surface, curveu/ramp attributes | running (agent) | started 2026-10-12 from 202ef7a |
| P2-E | Exports: gltf-transform writer with instancing/materials/compression/LOD, USD PointInstancer + materials, Houdini `.geo` JSON read/write, PCG point stream, CSV/JSON points, material attribute + table | part 1 merged, part 2 running (agent) | 0d1ec15, 2026-10-12. gltf-transform GLB/glTF (validated), Houdini .geo/.bgeo read + .geo write (verified on SideFX Labs files), CSV/points JSON with PCG columns, material node + table. Open: external checks in Houdini/Blender/Unreal (scratchpad verify/ files); .geo key layout unconfirmed against a Houdini-written ASCII file; part 2 (packed instancing, USD PointInstancer) after P2-A |
| P2-F | Asset shelf: 30+ curated graph assets (fence, rail, stairs, road, roof, window grid, tree, rock, cliff, pipes, cable, crate, barrel, bricks, tiles, hex grid, scaffold, pillar, arch) with golden renders | running (agent) | started 2026-10-12 after P2-B |
| P2-G | Houdini parity tests through the Houdini MCP; Unreal round trip through the Unreal MCP | queued | needs apps running |

### Release and outreach (after Phase 2)
| id | item | status | notes |
|---|---|---|---|
| R-1 | Licence switch MIT → Apache-2.0, NOTICE with all third-party licence texts (generated by `scripts/gen-notice.ts`) | done | Apache-2.0 LICENSE, NOTICE generated (138 packages + DejaVu + xatlas text), `npm run notice`, staleness check in `npm test` |
| R-2 | CONTRIBUTING.md, CODE_OF_CONDUCT.md (Contributor Covenant 2.1), DCO check workflow, issue templates | done | CONTRIBUTING.md, CODE_OF_CONDUCT.md (Contributor Covenant 2.1), .github/workflows/dco.yml (pull requests), issue templates |
| R-3 | Positioning copy: README first line, package.json description | done | README first paragraph, package.json description |
| R-4 | Rename to topotopo in one commit before the first tagged release | queued | decision 1; blocked on the user registering the handles |
| R-5 | Tagged v0.2 on npm under the new name; demo video plan; grant application drafts (Epic MegaGrants, NLnet NGI Zero) | queued | decision 5; after P2-E2, P2-G |
| R-6 | Trademark filing reminder: once there is revenue or a grant | queued | decision 1 |

## External track
- An outside agent (different vendor) takes `docs/briefs/external-agent.md`: package 1 is the Rust→WASM kernels crate (straight skeleton, isotropic/quad remeshing, erosion, SDF grids + dual contouring, point kernels), package 2 a 2026 landscape audit, package 3 an optional UE 5.8 PCG plugin. Integration of the kernels into nodes stays with this run (P0-F perf, P2-C heightfields, P1-E remesh).

## Log
- 2026-10-12: P2-B merged cleanly. P2-F launched.
- 2026-10-12: R-1..R-3 done (202ef7a). Launched P2-B, P2-D, P2-E2, P0-F.
- 2026-10-12: P2-C and P1-E merged (fa4b59d, 9eea4c9). All Phase 0–2 agents reported; no agent running. Decisions 1–5 recorded; availability check done. Running next: R-1..R-3 (orchestrator), then P2-B, P2-D, P2-E2, P2-F, P0-D, P0-F.
- 2026-10-12: P2-A merged (7715c68). Found that test/uv.ts had been failing on main since P2-E1 (sync GLB export) and my summary grep hid it: from now on every test run checks the exit code. Fixed by P2-A.
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
