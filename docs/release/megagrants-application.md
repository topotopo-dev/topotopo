# Epic MegaGrants application: TopoTopo (draft)

Draft for the next MegaGrants submission window. ROADMAP §7 recorded on 2026-10-13 that both 2026 cycles are closed
(cycle 1: January 12 – March 20, notices June 15–19; cycle 2: June 29 – September 4, notices December 7–11) and that
the next window is expected to be cycle 1 of 2027, opening around January 2027 with notices around June 2027
[verify: 2027 dates on the official MegaGrants page and FAQ].

How to use this file:
- The sections follow the order of Epic's form as we understand it: title and summary, category, description, use of
  Unreal Engine, status, team, amount and budget, milestones, open source, links. [verify: field names, order and
  character limits against the live form; shorter variants are given where a limit is likely.]
- Every number is taken from the repository at commit 81895f2 (2026-10-13, after the Phase 3 merges). Refresh them on
  submission day with the commands in the last section.
- Anything that could not be confirmed from the repository is marked [verify].

---

## Applicant

- Applicant: faxcorp [verify: apply as an individual or as the faxcorp studio; legal name; country; tax details]
- Contact: hello@topotopo.dev
- Role: sole maintainer and copyright holder (LICENSE and NOTICE: "Copyright (c) 2026 faxcorp")

## Project title

TopoTopo

## One-line summary

An open-source procedural geometry engine: node graphs in JSON, cooked headless and deterministic, with exports built
for Unreal Engine (PCG instance streams, Landscape heightmaps and weight layers, glTF for Interchange) as well as
Blender and Houdini. Built for LLM agents through MCP, and for people through the CLI.

## Category

Open-source tools: "building or enhancing open-source tools with Unreal Engine" (the eligibility category recorded in
ROADMAP §7). [verify: the exact category label on the form]

## Project description

Short version (about 600 characters):

> TopoTopo is an Apache-2.0 procedural geometry engine. Artists and tools programmers describe content as JSON node
> graphs in the style of Houdini SOPs (222 node types, 37 ready-made assets); the engine cooks them headless on
> Node.js, with no GPU and no editor, and every cook is reproducible from the graph and its seeds. Output goes straight
> into Unreal Engine: Landscape heightmaps with exact import settings, weight layers, instance streams with PCG
> columns, and glTF meshes with materials. The Unreal 5.8 round trip was verified on 2026-10-13. The grant funds an
> Unreal plugin that removes the remaining manual import steps.

### What it is

TopoTopo (developed as Polyforge and renamed before its first public release) is a procedural geometry engine. A
graph is a JSON file of named nodes with sparse parameters; the engine cooks it lazily from the output node, caches
every result by a content signature, and re-cooks only what is downstream of an edit. The node library covers modelling (bevel, knife,
bridge, quad fill, booleans, deformers), curves and splines (Bezier, NURBS, sweeps, fillets), UVs (xatlas unwrap, LSCM),
remeshing (isotropic, field-aligned quad, voxel with dual contouring), scattering and packed instancing, heightfield
terrain (masks, droplet, virtual-pipe and stream-power erosion, drainage, roads), sampled SDF grids, procedural textures
and bakes, simulation for set dressing (rigid-body settling and stacking on Rapier, particles with trails, XPBD cloth
draping and inflation), a frame solver, and in-graph checks. A shelf of graph assets (walls, houses, straight-skeleton roofs, stairs,
fences, props, trees, rocks, PCG helpers) is used like nodes, and assets can contain other assets.

The core is TypeScript that runs unchanged in Node and in browsers; heavy algorithms (straight skeleton, SDF grids and
dual contouring, quad remeshing, erosion and drainage) are a Rust crate compiled to WebAssembly and committed, in a SIMD
build with a scalar fallback that returns the same bytes, so users never need a native build. All randomness is seeded hashing, so a cook is reproducible from the graph alone.

### The problem it solves for Unreal users

Procedural content that has to exist outside the editor (generated on a build machine, reviewed in source control,
regenerated when a parameter changes) needs a generator that is scriptable, reproducible and free to deploy on every
machine. TopoTopo is built for that:

- **Text in, files out.** A graph is a diffable JSON file. `topotopo graph.json --export level/` cooks it from the
  command line on Node 22.18 or later with no licence server, GPU or editor.
- **Deterministic.** The same graph and seed produce the same geometry. The test suite holds a content fingerprint for
  every node type that cooks on its own, every example graph and every shelf asset (290 fingerprints), so any change
  in output shows up as a reviewable diff.
- **Engine-ready output.** The exporters write what Unreal imports: a Landscape bundle whose manifest states the exact
  import settings, 8-bit weight layers, an instance stream with PCG column names in Unreal units and axes, and glTF
  with materials and `EXT_mesh_gpu_instancing`. The same scene also goes to USD (PointInstancer), Houdini `.geo`
  (packed primitives) and Blender (glTF).
- **Generators that compose.** Shelf assets nest: the `house` asset builds one `wall_segment` per footprint edge and a
  straight-skeleton roof, and `examples/house_city.json` spawns twelve varied houses from it. Editing the wall asset
  changes every house; identical walls are cooked once (12 houses in about 250 ms, WORKLOG 2026-10-13).

### Agent and MCP support (a feature, not the headline)

TopoTopo ships a Model Context Protocol server with 12 tools (catalog, help, build, edit, inspect, render, export,
graphs, assets, explain, diff, preview). A coding agent can write a whole graph in one call, read counts and attribute
statistics, look at a rendered quad view, and check its own result with `assert` nodes, `explain` (shape descriptors
in words) and `diff` (Hausdorff distance between versions). For Unreal teams this means generators can be written and
adjusted by an assistant while the output stays a plain, reviewable graph file.

## How the project uses and benefits Unreal Engine

Short version (about 600 characters):

> TopoTopo writes the files Unreal needs: a 16-bit Landscape heightmap sized to a valid Landscape resolution with a
> manifest of the exact import settings, weight layers, an instance stream (CSV with PCG columns, Z-up centimetres) and
> glTF meshes with materials for Interchange. In Unreal 5.8 the 536-instance demo level was rebuilt from these files
> and checked: instance vertices within 0.1 cm, tree bases on the Landscape (median gap 0.16 cm). The grant builds an
> open-source Unreal plugin: a PCG element for TopoTopo point streams, one-click Landscape and mesh import, and a PCG
> node that cooks a TopoTopo graph.

### Verified in Unreal Engine 5.8 (2026-10-13)

The demo graph `examples/unreal_demo.json` builds a 126 × 126 m eroded massif on a 253 × 253 heightfield, cuts a road
along a curve, paints grass, rock and road layers, and scatters 536 packed instances: 292 trees in three variants
(pine, fir, oak) on gentle ground and 244 rocks in two variants on steep slopes. `npm run export:demo` writes the file
set; the project `topotopotest` holds the resulting level `L_Demo`. What was checked in the editor (WORKLOG row P2-G):

1. **Landscape.** The `unreal_landscape` bundle contains `heightmap.png` (16-bit), one 8-bit PNG per layer and
   `landscape.json` with the import settings. 253 × 253 is an exact Landscape fit: section size 63 quads, 2 × 2
   sections per component, 2 × 2 components, scale (50, 50, 4.603792), location (0, 0, 1169.3223). Imported through
   Landscape mode with those values, line traces from the editor show the terrain ending exactly at ±6300 cm, the low
   corner at −9.2485 cm (the exported `height_min`), and the 292 tree bases on the surface (median gap 0.16 cm, 90th
   percentile 0.9 cm; the six larger gaps are trees inside a half-buried rock, where the trace hits the rock).
2. **Instance stream.** `instances.csv` has one row per instance: `Name`, `Position.X/Y/Z` (centimetres, Z-up),
   `Rotation.Roll/Pitch/Yaw`, `Scale.X/Y/Z`, `Density`, `Color.R/G/B/A`, `Seed`, `Mesh`, plus the graph's own
   attributes (height, slope, mask, tint …), with one GLB per source mesh. An editor Python script spawned the 536
   rows as actors. Applying the rows with Unreal's rotator convention puts all 39,350 transformed vertices within
   0.1 cm of the expanded reference geometry; in the editor, row 0's transform reads back equal to the CSV and a line
   trace from above hits the pine's apex at the predicted height.
3. **Interchange glTF.** The GLBs import through Interchange with their materials (bark, needles, leaves, rock,
   asphalt); the axis mapping X = x, Y = z, Z = y is confirmed, and the per-name meshes have the same bounds (to
   0.01 cm) as the union of the CSV-placed actors.

Still manual today, and the reason for the plugin: the Landscape import is done in the Landscape mode dialog with
values copied from the manifest; loading `instances.csv` into a PCG graph through *Load Data Table* first needs a
user-defined row struct; weight-layer PNGs are exported but their import into Landscape paint layers has not been
checked in the editor yet.

### What the grant builds: the TopoTopoPCG plugin

An Apache-2.0 C++ editor plugin for Unreal Engine 5.8, specified in `docs/briefs/external-agent.md` (package 3) and
not started yet:

- A PCG element that reads a TopoTopo point stream (CSV or `points.json`) into PCG point data with every attribute,
  converting Y-up metres to Z-up centimetres and `orient`, or `N` plus `up`, to rotations.
- An import action for TopoTopo GLB files as Static Meshes (split by the `name` attribute, with materials), and an
  "instances from point stream" action that creates ISM/HISM components.
- A one-click Landscape import that reads `landscape.json` and applies heightmap, resolution, scale, location and
  weight layers, so the dialog step above disappears.
- A "Cook with TopoTopo" PCG node that runs the TopoTopo CLI on a graph with a timeout, so a PCG graph can call a
  TopoTopo generator and consume its points and meshes.
- A sample project with the demo level, a 100k-point stream test and documented install steps.

### Who benefits

- Unreal developers get a free, permissively licensed generator for terrain, buildings, props and scatter that runs on
  build machines and in CI, plus a plugin that brings its output into PCG and Landscape without hand-copied settings.
- Teams that already use Houdini or Blender can move the same scene between the three applications (`.geo` with
  packed primitives, USD PointInstancer, glTF), which was checked in Houdini 22 and Blender 5.2.
- The open-source 3D ecosystem gets permissive implementations of algorithms that were hard to source under a
  permissive licence: a weighted straight skeleton (the npm package `straight-skeleton` wraps CGAL, which is GPL),
  field-aligned quad remeshing, virtual-pipe erosion and dual contouring, as a Rust crate that compiles to WebAssembly.

## Current status and evidence

As of 2026-10-13, commit 81895f2 (counted with a script over the node registry and the repository folders; the
commands are in the Counting section of `docs/release/v0.2-release-notes.md`):

| measure | value | source |
|---|---|---|
| node types | 222 in 19 categories | node registry; `docs/nodes.md` (generated from the node definitions; `npm test` fails if stale) |
| shelf assets | 37 | `shelf/*.json` without `index.json`; `docs/nodes.md` |
| texture nodes | 37 (generators, filters, uv-space bakes) | `docs/nodes.md` |
| heightfield nodes | 24 | `docs/nodes.md` |
| simulation nodes | 5 (`rbd_settle`, `rbd_stack`, `particles`, `drape`, `inflate`) | `docs/nodes.md` |
| golden fingerprints | 290 (220 node fixtures, 33 example graphs, 37 shelf assets) | `test/golden/` |
| example graphs | 33, each rendered by `npm run showcase` | `examples/`, `examples/renders/` |
| documented examples | one per node type, all 222 cooked by the tests, none with warnings | `test/examples.ts` |
| test programs in `npm test` | 37 (smoke, golden, property and fuzz, docs, examples, NOTICE, io, interop, MCP end to end, feature suites including kernels, particles, rigid bodies and cloth) | `package.json` |
| Rust kernel tests | 95, run with and without the SIMD feature | `kernels/` |
| WebAssembly kernels | SIMD and scalar builds, 1.34 MB together, byte-identical results in 426 comparisons | `kernels/pkg`, `kernels/pkg-simd`, `kernels/BENCH.md` |
| source size | about 53,100 lines of TypeScript in `src/`, 13,200 lines of tests, 14,000 lines of Rust | `git ls-files` line counts |
| MCP tools | 12 | `README.md` |
| history | first commit 2026-10-03; 286 commits by 2026-10-13 | `git log` |

Verification beyond unit tests:
- Every GLB written by the tests is checked with the Khronos glTF validator.
- `npm test` passes with the worker pool on and off, and compares results bit for bit between the two.
- Property tests cook 150 random node chains per run (no exception escapes, cooks are deterministic, the cache returns
  the same result after a parameter is changed and restored); a fuzz runs malformed and never-ending wrangle snippets
  and hostile expressions, scripts and SDF fields, which must fail their node within the script timeout instead of
  hanging the process.
- External round trips (WORKLOG P2-G, 2026-10-13): Unreal 5.8 as described above; Blender 5.2 imports `scene.glb` as
  536 instances sharing 5 mesh datablocks with 7 materials, and `scene.usda` as 7 meshes plus the PointInstancer;
  Houdini 22.0.466 loads `scene.geo` with 0 errors (63,645 polygons and 536 PackedGeometry primitives over 5 embedded
  sources, every attribute present).
- Rust/WASM kernels, seven sessions merged: straight skeleton (roofs and offsets for any footprint with holes), sampled
  SDF grids with CSG, morphology and dual contouring, field-aligned quad remeshing, heightfield erosion (droplet,
  virtual pipe, stream power) and D8/D-infinity drainage; then an erosion speed pass, SIMD builds by default with a
  scalar fallback (pipe erosion from 21.8 s to 4.6 s in Node), and a quad-remesher pass that met its regularity
  targets (1.83 % irregular vertices on the large test sphere, 2.69 % with UV seams; a quads-only tube asked for 350
  faces gets 346) and roughly halved its time.
- Simulation nodes merged in Phase 3: `rbd_settle` and `rbd_stack` on Rapier (the showcase settles 116 rocks on a
  51k-triangle terrain in 2.6 s and stacks 16 crates in 0.35 s; 1,000 packed rocks settle in 2.1–2.4 s), `particles`
  (100k particles × 200 steps with floor collisions in 0.25 s on the worker pool) and XPBD cloth (`drape`, `inflate`).
  Particles and cloth give identical bits with the worker pool on and off; rigid bodies are deterministic for the
  same Rapier version.
- User code is contained: `"=expr"` parameters run in their own sandboxed realm, and every known hang path in user
  code (wrangles, scripts, parametric and heightfield expressions, SDF fields wherever they are sampled) fails its
  node within the script timeout. A `vm` realm is not a security boundary, which the README states.
- The npm package builds to JavaScript and is tested by installing its tarball in an empty project and running the
  CLI, the library, the worker pool, both kernel builds and the MCP server from there (`npm run pack:test`).

Known limits we state up front (from the WORKLOG and `kernels/BENCH.md`; the kernel numbers were measured with other
jobs loading the machine):
- The quad remesher takes 5.1 s for a 100k-triangle sphere in Node with the SIMD build, against a 3 s target.
- Virtual-pipe erosion of 1024² × 200 steps takes 3.2 s native and 4.6 s in Node against 2 s / 4 s targets; the
  droplet kernel is 1.46× faster than TypeScript against a 3× target.
- Dual contouring of a 256³ band takes 1.8 s against a 1.5 s target and leaves fine serration along sharp edges.
- Cloth: a 100 × 100 drape for 200 steps against a 5k-triangle collider takes 3.3–3.4 s against a 3 s target;
  colliders are static, and there is no tearing.
- Rigid bodies collide as convex shapes (no convex decomposition); particles do not interact with each other.
- Bit identity across platforms is tested by replay, native/WASM fixtures and scalar/SIMD comparisons on one machine,
  not by a full platform matrix.

## Team

One maintainer (faxcorp), who owns the code, the decisions and the releases. Development is AI-assisted, and we say so
plainly: most of the code was written by AI coding agents (Anthropic Claude models for the TypeScript engine and the
orchestration, OpenAI Codex sessions for the Rust kernels). Since 2026-10-12 the work has run as an orchestrated
process: an orchestrating agent briefs implementation agents, each on one scoped item in its own git worktree, and
merges are gated by the type checker, the full test suite, the rendered examples and, for interop, checks in Unreal,
Houdini and Blender. The maintainer sets scope, licence and release decisions and approves publishing. There are no other human contributors yet; CONTRIBUTING.md states that reviews are slow and that every node
needs tests, docs and an example.

[verify: maintainer's name and a short background paragraph (prior Unreal, tools or graphics work)]

## Requested amount and budget

**Requested: USD 60,000 for 12 months.** This sits inside the typical $5,000–$75,000 range recorded in ROADMAP §7.
The rationale: one maintainer working on the project for a year at a modest rate, with a third of that time on the
Unreal plugin and a sixth on documentation and video, plus the hardware and services needed to test on more than one
platform.

| item | detail | USD |
|---|---|---:|
| Maintainer time: engine, kernels, releases | 6 person-months at 4,000 [verify rate]: kernel performance passes, dual-contouring quality, Unreal-specific heightfield options, issue triage and reviews, regular releases | 24,000 |
| Maintainer time: Unreal plugin | 4 person-months: TopoTopoPCG plugin (PCG element, import actions, Landscape import, Cook node), sample project, testing on UE 5.8 and the current 5.x release | 16,000 |
| Maintainer time: documentation and video | 2 person-months: docs site at topotopo.dev, Unreal guides, four tutorial videos | 8,000 |
| AI coding tools | 12 months of the agent subscriptions used for development [verify cost] | 3,000 |
| Test hardware | a Linux machine and a Mac for the cross-platform determinism matrix and clean plugin builds [verify prices] | 3,000 |
| Software and services | Houdini licence for parity tests, domain, storage for sample assets and videos [verify prices] | 1,000 |
| Trademark filing | "TopoTopo", one class, one jurisdiction (WORKLOG R-6) [verify cost and whether eligible] | 1,500 |
| Contingency | about 6% | 3,500 |
| **Total** | | **60,000** |

Not funded by this request: the browser node editor (roadmap phase 4), simulation and CAD modules.

## Milestones

Self-funded before submission (planned for Q4 2026, WORKLOG R-4/R-5) [verify each is done by submission day]:
- Rename to TopoTopo: done in the code (package, commands, MCP server, environment variables, crate); still to do:
  the repository rename to github.com/topotopo-dev/topotopo, the public flip, CI back on.
- Tagged v0.2 on npm as `topotopo` (the package build and install test are in place).
- 2–3 minute demo video (`docs/release/demo-video-plan.md`).
- Phase 3 of the roadmap (textures, sampled volumes, rigid bodies, particles, cloth) is already done and self-funded.

Grant period, assuming funds arrive in July 2027 after notices around June 2027 [verify]:

| milestone | due | deliverables | budget share (USD) |
|---|---|---|---:|
| M1: plugin alpha | 2027-09-30 | TopoTopoPCG public under Apache-2.0: PCG element loading CSV and `points.json` streams with all attributes; sample level with a 100k-point stream; install guide | 14,000 |
| M2: plugin beta, engine release | 2027-12-31 | GLB import action (name split, materials), ISM/HISM from a point stream, one-click Landscape import including weight layers; engine release with the erosion pipe model under 4 s for 1024² × 200 in Node and the quad remesher under 3 s for 100k triangles, or a published account of why not | 18,000 |
| M3: Cook node and docs | 2028-03-31 | "Cook with TopoTopo" PCG node; docs site with the node reference and Unreal guides; four tutorial videos; Linux and macOS determinism matrix in CI | 16,000 |
| M4: release and report | 2028-06-30 | plugin tested on UE 5.8 and the current 5.x release; downloadable sample project with the demo level; engine release; public report with usage numbers and remaining limits | 12,000 |

The budget shares add up to the 60,000 total; hardware, tools and services are spent in M1–M2, the trademark filing in
M1, contingency as needed.

## Open-source commitment

- Licence: Apache-2.0 for the engine, the Rust kernels crate and the planned plugin. No open-core split: there is no
  paid edition and no feature held back (decision reaffirmed 2026-10-13).
- Public repository with full history: github.com/topotopo-dev/topotopo [verify: public on submission day].
- Dependencies that ship are permissive (MIT, Apache-2.0, BSD, ISC, MPL-2.0, Unicode-3.0, Zlib, 0BSD, Unlicense or
  CC0; the physics engine Rapier is Apache-2.0); no GPL or AGPL anywhere in the tree. The one exception, stated in
  CONTRIBUTING.md and NOTICE, is LGPL-3.0 libvips inside the optional platform binaries of sharp, an indirect
  dependency that TopoTopo never calls. A generated NOTICE file carries every third-party licence text, including the
  Rust crates compiled into the kernels, and `npm test` fails when it is stale.
- Contribution rules are in CONTRIBUTING.md (DCO sign-off, bug reports with the reproducing graph), with the
  Contributor Covenant 2.1 as code of conduct.
- The geometry a user generates is theirs, and textures made by texture nodes come from the graph, so assets do not
  depend on image files of unknown licence.

## Links

- Repository: https://github.com/topotopo-dev/topotopo [verify: public]
- Website: https://topotopo.dev [verify: site published]
- npm: https://www.npmjs.com/package/topotopo [verify: v0.2 published]
- Demo video: [placeholder: URL after upload]
- Node reference: https://github.com/topotopo-dev/topotopo/blob/main/docs/nodes.md
- Contact: hello@topotopo.dev

## Risks

| risk | effect | mitigation |
|---|---|---|
| One maintainer | work stops if the maintainer is unavailable | public repo, Apache-2.0, a test suite and generated docs that let someone else continue; CONTRIBUTING.md sets expectations |
| Young project | first commit 2026-10-03, no outside users yet | the public v0.2 and the video go out before submission; report downloads, issues and users on submission day [verify] |
| AI-written code | review depth per line is lower than in hand-written code; some funders weigh this negatively | disclosed in this application; every merge passes typecheck, 37 test programs, 290 fingerprints and rendered examples; interop checked in three applications [verify: Epic's position on AI-assisted projects] |
| Kernel performance | quad remeshing (5.1 s against 3 s) and pipe erosion in Node (4.6 s against 4 s) are still slower than their targets | the targets are milestone M2; numbers are published in `kernels/BENCH.md` either way |
| Unreal API changes | PCG and Interchange APIs move between 5.x releases | the file formats (CSV, GLB, PNG, JSON manifest) are the stable contract; the plugin stays thin and is tested on two engine versions |
| Cross-platform determinism | bit identity is not proven on every platform | Linux/macOS matrix in M3, funded test hardware |
| Name | no trademark filed yet | filing in M1 (budget line) |

## Before submitting

- Re-read the official MegaGrants page and FAQ: dates, form fields, category, limits, eligibility of AI-assisted
  projects. [verify]
- Refresh the numbers with the commands in the Counting section of `docs/release/v0.2-release-notes.md` (node types
  and categories from the registry, `shelf/*.json` without `index.json`, `examples/*.json`, `test/golden/*.json`,
  the Rust `#[test]` count), plus `git rev-list --count HEAD`, the tool table in README.md, and the limits in
  docs/WORKLOG.md and kernels/BENCH.md (kernels session 8, the dual-contouring pass, may change them).
- Confirm v0.2 is on npm and installs with `npx topotopo` on a clean machine (`npm run pack:test` covers the tarball
  locally; the published package still needs one check).
- Attach the demo video URL and two or three stills: `examples/renders/unreal_demo.png`, a screenshot of `L_Demo`,
  `examples/renders/house_city.png`.
- Fill in the applicant details and the maintainer background.
