# Optional CAD module (P3-D): decision note

Proposal, 2026-10-14; nothing is built. Web facts carry a source tag [S1]–[S14], all checked 2026-10-14; untagged
statements are our reading or estimates.

**Recommendation: later.** Build it after the v0.2 release and the MegaGrants submission (Q1 2027), or earlier if a
user or funder asks for STEP, starting with a 2–3 day spike. Ship it as a separate package, `@topotopo/cad`, from its
own repository; never bundle it into the core.

## 1. Licensing

OCCT is LGPL-2.1 plus the Open CASCADE exception 1.0 [S1, S2] (SPDX `OCCT-exception-1.0` [S3]). The exception lets
object code that incorporates OCCT header material (inlines, templates, generic classes) be distributed "under terms
of your choice, provided that you give prominent notice" that it uses OCCT [S2]. It does not lift LGPL §6 for OCCT
itself: a WASM binary links OCCT statically, so it must ship with its source (§6a or §6d) or be a run-time-loaded copy
the user can replace (§6b) [S4].

| WASM build | licence | OCCT / Emscripten | latest | WASM |
|---|---|---|---|---|
| `opencascade.js` (donalffons) | LGPL-2.1-only | 7.x / old | 1.1.1 2020-09-27; beta 2023-03-23; last push 2023-08-15 | 65.9 MB / 50.3 MB [S5] |
| `libcascade` (taucad fork) | LGPL-2.1-only WITH OCCT exception | 8.0.1 / 6.0.5 | 3.1.0 2026-10-13, Node ≥ 22 | 42.7 MB (single and multi) [S6] |
| `replicad-opencascadejs` (MIT `replicad` sits on it) | LGPL-2.1-only | taucad image | 1.1.0 2026-09-04 | 22.5 MB, 248 bindings [S10] |

Upstream opencascade.js is dormant; libcascade, and replicad's custom build on its image, are maintained on current
Emscripten [S5, S6, S10].

To comply, `@topotopo/cad` (own code Apache-2.0, which §6 allows because it permits modification and reverse
engineering [S4]) needs:
1. libcascade (or replicad-opencascadejs) as an exactly pinned dependency, WASM neither vendored nor patched: the LGPL
   code reaches users as its own package, loaded at run time and replaceable with npm `overrides` (§6b).
2. NOTICE and README: "uses Open CASCADE Technology (LGPL-2.1 with the OCCT exception) via libcascade", both licence
   texts, a source link, how to swap in a rebuilt WASM; OCCT named in version banners once loaded (§6).
3. A trimmed build of our own is a modified Library: publish it as an LGPL package (`@topotopo/cad-occt`) with every
   build input (config, pinned commits, Docker digest, C++ wrappers, which may stay Apache-2.0 under the exception).

**The core stays clean.** `topotopo` holds no OCCT code and never calls it; it imports the Apache-2.0 package only if
the user installed it (npm does not install optional peers [S11]), so we never distribute a combined work. The policy
("LGPL only for optional modules our code never calls") does not cover `@topotopo/cad`, which calls OCCT: keep the core
rule, add one sentence naming that package and repository as the sole exception, and give the CAD repository its own
allow-list. The separate repository keeps `npm run notice`, core CI and the grant application's licence paragraph
(permissive dependencies, one stated LGPL exception: sharp's libvips) true as written.

## 2. Size and runtime

| item | value |
|---|---|
| libcascade full (5,348 symbols) | 42.7 MB WASM [S6, S8] |
| start-up | 488 ms single-threaded, 676 ms multi-threaded (38.5 MB build, M2 Pro, Node 24) [S7] |
| replicad build: booleans, fillet, chamfer, STEP read/write, BRepMesh, BinTools | 22.5 MB [S10] |
| trim-guide estimates | STEP viewer 2–4 MB; booleans + fillets + sweep 12–20 MB [S8] |
| our set (BRepPrimAPI, BRepAlgoAPI, BRepFilletAPI, STEPControl, BRepMesh) | estimate 15–22 MB: the replicad build already holds these toolkits, which dominate size over bindings; measure in the spike |
| speed (M2 Pro) | fillet all edges 5.8 ms, 40-box fuse 66 ms, assembly STEP import + mesh 1.9 s; 1.1–1.8× native [S7] |
| Rapier, for scale | 3.1 MB, ~60 ms to load (DESIGN.md) |

libcascade declares Node ≥ 22 and uses native WASM exceptions and SIMD [S6, S10] (confirm on 22.18). The replicad build
starts at 100 MB of memory and caps at 4 GB (wasm32) [S10]. The multi-threaded build is 1.24× faster over the suite but adds 39 % start-up
and needs SharedArrayBuffer (COOP/COEP in browsers); STEP readers stay sequential [S7, S8]. Use single-threaded.

## 3. Alternatives

| option | licence | gives | lacks |
|---|---|---|---|
| Manifold 3.5 (in) | Apache-2.0 | robust mesh booleans, `smooth_solid` (smoothOut + refine) [S14], `minkowski` | exact surfaces, STEP, radius on chosen edges |
| `poly_bevel` (ours, TypeScript, not Rust) | Apache-2.0 | chamfer/round profiles, mitres, corner patches, clamp, edge patterns | faceted, constant offset, no exact curved blends, no STEP |
| Fornjot | 0BSD | simple B-rep models | project shut down; too few features for real use [S12] |
| truck | Apache-2.0 | NURBS B-rep, booleans, partial STEP | single-edge fillet only, unreleased; last crate 2024-09-20 [S13] |

For TopoTopo's users (Unreal environments, props, PCG), `poly_bevel`, `smooth_solid`, `minkowski` and SDF smooth unions
cover well over 80 % of fillet needs. What remains is STEP exchange with CAD and manufacturing, which no mesh fillet
provides; a Rust port of `poly_bevel` would buy speed, not coverage.

## 4. Proposed design

**Packaging.** `topotopo-dev/topotopo-cad` publishes `@topotopo/cad`; `topotopo` lists it as an optional peer.
`src/wasm/cad.ts` mirrors `rapier.ts` (shared promise, retry, `CAD_NOT_INSTALLED` with the install hint, non-literal
import specifier so bundlers tolerate its absence). NodeDefs live in the core so `catalog` and docs list them; cooks
delegate to the package.

| node | OCCT | key params |
|---|---|---|
| `cad_solid` | BRepPrimAPI; prism/revol of an input curve (spline prims become exact B-splines) | shape, size, radius, height, angle |
| `cad_boolean` | BRepAlgoAPI_BuilderAlgo | operation, fuzzy tolerance |
| `cad_fillet`, `cad_chamfer` | BRepFilletAPI_MakeFillet / MakeChamfer | radius or distance, edges |
| `cad_step_import` | STEPControl_Reader | file, unit (metres), up axis (STEP is usually Z-up) |
| `cad_step_export` | STEPControl_Writer, as `export` format `step` | AP214/AP242 |
| `cad_to_mesh` | BRepMesh_IncrementalMesh | deflection (m), angle (°), relative |

Edge selectors follow the group patterns: `""` (all), `angle>30`, `convex`, `concave`, `dir:y`, `@P.y>0.5` (edge
midpoint), `face:top`.

**Shapes in the graph.** A `Volume` kind `{ kind: 'brep', name, data, key, xform, bounds, faceTags, preview }`:
`data` is OCCT binary BRep (BinTools), the immutable source of truth, `key` its hash; `preview` is a default-deflection
mesh, so render, bbox, inspect, fingerprints and exporters need no OCCT; `xform` keeps `transform` in the core. Live
handles stay in the package, cached per instance by `key`, `delete()`d on eviction. Graph JSON exports carry STEP text
as planned; STEP round trips are not bit-exact (our reading), so native JSON and worker transfer use the BRep bytes.

**Provenance.** Face tags follow OCCT history (`Modified`/`Generated`): tags survive a fillet, and new blend faces get
`fillet`/`chamfer`. `cad_to_mesh` writes prim `face` and `surface`, prim groups from tags, exact `N`, `uv` from face
parameters, and edge group `cad_edges`.

**Worker pool.** An instance is single-threaded and its handles cannot leave its heap. Small operations run on the
main thread; big ones on one dedicated CAD worker (≥ 100 MB), not on every pool worker. A killed worker loses nothing,
because shapes are bytes.

**Determinism.** OCCT walks some maps keyed by shape addresses, so results can depend on heap history (libcascade
fixed one case in BRepOffset on 2026-10-12 [S9]). Hence: canonical face order in `cad_to_mesh`, a two-instance test
with different allocation histories, single-threaded build only, libcascade pinned (upgrades change goldens, as with
Rapier), and a fixed STEP header timestamp.

**Errors and time.** `StdFail_NotDone` or `IsDone() == false` becomes a node error with a hint (largest radius that
fits); `BRepCheck_Analyzer` warns on invalid results. A WASM abort kills the instance: recreate it and rebuild shapes
from bytes. One OCCT call cannot be interrupted on its own thread, so the `remesh_quad` rule applies: run it on the CAD
worker within the rest of `simTimeoutMs`, then terminate and replace the worker (unbounded without a pool).

**Tests.** CAD repository: examples cook; mesh-independent invariants (BRepGProp volume and area to 1e-9 relative,
face/edge counts, validity, kept through STEP export → import); goldens as quantised `cad_to_mesh` fingerprints at a
fixed deflection (0.01 m, 15°); the determinism test. Core: a `brep` fixture round-trips JSON and fingerprints, and
`cad_*` fail cleanly (examples skipped with a note) without the package.

## 5. Effort, plan, recommendation

| phase | content | effort | who |
|---|---|---|---|
| 0 Spike | libcascade and replicad builds in Node 22.18 and a worker; box → fillet → mesh → STEP; size, start-up, memory, determinism | 2–3 days | Opus or Codex |
| 1 Core hooks | `brep` volume, loader, NodeDefs, policy sentence | 3–4 days | Opus |
| 2 Package | nodes, selectors, history tags, errors, CAD worker, goldens | 1.5–2 weeks | Codex (self-contained, brief-driven) |
| 3 STEP and docs | import/export, units, axes, NOTICE, docs, examples, renders | 1 week | Codex |
| 4 Later | trimmed build, browser bundle, sweeps and lofts from spline prims | 1 week | optional |

That is 4–5 weeks of agent time plus review. Risks: the maintained build is a one-company fork (libcascade, 10 stars;
upstream dormant since 2023) whose API still changes (v3 broke it); OCCT fillets often fail on agent-made input;
determinism gaps; a 22–43 MB install; golden churn on OCCT upgrades for one reviewer.

**Why later.** The grant application leaves CAD out (`docs/release/megagrants-application.md`) and the demo video has
no CAD shot. The target users are served by the mesh tools (§3). For a self-funded project with one maintainer, the
v0.2 release and the grant are the money path; a 4–5 week item with a licence exception is not. **Why not never.** The
design is cheap, the dependency is maintained again (OCCT 8.0.1, Emscripten 6.0.5), and STEP is the one capability the
mesh stack cannot imitate.

## Sources (checked 2026-10-14)

- [S1] https://occt3d.com/open-cascade-technology/index.html (redirected from dev.opencascade.org/resources/licensing)
- [S2] https://github.com/Open-Cascade-SAS/OCCT/blob/master/OCCT_LGPL_EXCEPTION.txt
- [S3] https://spdx.org/licenses/OCCT-exception-1.0.html
- [S4] https://opensource.org/license/lgpl-2-1 (§5–6)
- [S5] https://github.com/donalffons/opencascade.js, https://www.npmjs.com/package/opencascade.js, https://unpkg.com/opencascade.js@1.1.1/?meta, https://unpkg.com/opencascade.js@2.0.0-beta.b5ff984/?meta
- [S6] https://github.com/taucad/opencascade.js, https://www.npmjs.com/package/libcascade, https://unpkg.com/libcascade@3.1.0/?meta
- [S7] https://github.com/taucad/opencascade.js/blob/main/BENCHMARKS.md
- [S8] https://libcascade.xyz/docs/toolchain/guides/trim-symbols, https://libcascade.xyz/docs/package/guides/multi-threading
- [S9] https://github.com/taucad/opencascade.js/commit/97f71a844d
- [S10] https://github.com/sgenoud/replicad/tree/main/packages/replicad-opencascadejs, https://unpkg.com/replicad-opencascadejs@1.1.0/?meta
- [S11] https://docs.npmjs.com/cli/v10/configuring-npm/package-json#peerdependenciesmeta
- [S12] https://github.com/hannobraun/fornjot
- [S13] https://github.com/ricosjp/truck (README, CHANGELOG), https://crates.io/crates/truck-shapeops
- [S14] https://manifoldcad.org/jsdocs/classes/manifold_encapsulated_types.Manifold.html

Local context: ROADMAP.md §2, §4, §6; DESIGN.md (Architecture, Resource limits, Worker pool, Rigid bodies);
WORKLOG.md (P3-D); CONTRIBUTING.md; AGENTS.md; src/wasm/rapier.ts; src/core/bevel.ts; src/nodes/solid.ts.
