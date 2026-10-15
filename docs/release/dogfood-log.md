# Dogfood friction log

Companion to [dogfood-plan.md](dogfood-plan.md). One line per finding: what happened, how long it cost, what we did.
Status: **fixed** (commit), **filed** (issue), **deferred** (reason), **open**.

| # | Date | Step | Finding | Status |
|---|------|------|---------|--------|
| 1 | 2026-10-15 | fresh install | `npm install topotopo@0.1.0` in an empty folder: 143 packages, 14 s; `npx topotopo --help`, `--catalog` and cooking a box graph with `--inspect all` work from the published tarball. | ok |
| 2 | 2026-10-15 | fresh install | `topotopo --version` (and any unknown leading option, a missing graph file, or invalid JSON) printed a Node ENOENT stack trace. | fixed: `--version`/`-v`, plain one-line errors, tests in test/engine.ts |
| 3 | 2026-10-15 | site | https://www.topotopo.dev has no certificate yet (the apex has one and enforces HTTPS; http://www redirects to the apex, so only a typed `https://www` URL fails). | open: GitHub issues the www cert later; re-check |
| 4 | 2026-10-15 | MCP via npx | The README `.mcp.json` snippet works from an empty folder: `npx -y topotopo mcp --workspace ws` answers `initialize` in 13 s cold (npx fetch), 2.3 s warm; 12 tools; `build` cooks a 2-node graph in 14 ms. | ok |
| 5 | 2026-10-15 | MCP via npx | Graph identifier is `name` on build/edit but `graph` on inspect/render/export/explain (because build's `graph` is the spec): I passed `name` to render and got `no graph "main"`. | fixed: render/inspect/export accept `name` too, parameters described |
| 6 | 2026-10-15 | terrain | 1 km² valley at 505² (ridged + fbm noise, a valley-shaping expression, pipe erosion ×150, fill sinks, flow, river mask, one road cut) cooks in 4–6 s from the published CLI. | ok |
| 7 | 2026-10-15 | CLI | Every CLI run re-cooks the whole graph, so rendering three layers (`--color-by height`, `river`, `path`) costs three full cooks. Wanted: several renders per run, or an on-disk cook cache. | open |
| 8 | 2026-10-15 | CLI | The render log printed the color-by legend twice when it did not fit the footer. | fixed: one note |
| 9 | 2026-10-15 | terrain | `heightfield_flow` with fill_sinks routes drainage in dead-straight lines across filled flats, so the river mask looks synthetic there. | open: meander/jitter option or lake-aware masking |
| 10 | 2026-10-15 | CLI | `--catalog` and `--help-node` did not know the 37 shelf assets (`house` answered "unknown node"), although graphs cook them. | fixed 6df149f |
| 11 | 2026-10-15 | village | `heightfield_scatter` has no `min_distance`, so lots overlapped and two houses intersected; `prune` overlap after it works, but the knob belongs on the scatter (as on `scatter`). | open |
| 12 | 2026-10-15 | village | A missing layer in a `heightfield_layer` expression reported "lots is not defined". | fixed 6df149f: names the layer and lists the available ones |
| 13 | 2026-10-15 | village | 26 varied houses from the `house` asset via `foreach` over scattered lots cook in about 1 s; flattened lots by stamping discs with `heightfield_project`. | ok |
| 14 | 2026-10-15 | render | Previews cap at 600k triangles: 12.9k low-poly trees display as about 1.2k. Wanted: a budget flag or far-instance LOD for dense previews (README and video renders too). | open |
| 15 | 2026-10-15 | export | `--layers a,b` was ignored by `--format unreal_landscape`; all 17 layers, including direction codes and lake depths, became weight maps. | fixed 6df149f |
| 16 | 2026-10-15 | inspect | `--inspect summary` printed the whole materials JSON detail string (1.6 kB). | fixed: cut to 100 chars in summary |
| 17 | 2026-10-15 | Unreal | Import stopped: prototype mesh `rock` and its glTF material `rock` were created in the same folder, Interchange renamed the mesh to `rock1`, and the plugin refuses unpredictable names. The demo never hit it (meshes `rock_a`, `rock_b`). | fixed c7d85ae: plugin 0.1.4 moves materials/textures to `Meshes/Materials` and `Meshes/Textures`; editor test `PrototypeMaterialNameCollision`, 17/17 pass |
| 18 | 2026-10-15 | Unreal | The village never arrived: the bundle carries ordinary meshes only inside `objects_expanded.glb`, which is skipped above 2 M expanded triangles (12.9k trees = 6.4 M), so the plugin placed "0 ordinary objects". | fixing: exporter writes `objects_static.glb` (ordinary meshes only, any instance count); plugin places all of it |
| 19 | 2026-10-15 | Unreal | Trees, bushes and rocks imported white. Shelf assets write `Cd` = material colour; glTF got a white factor × `COLOR_0`, and Unreal's Interchange materials ignore vertex colours. | fixing: constant `Cd` folds into the factor (lossless, restored on import); the Unreal bundle's GLBs use the material colour as factor and keep `COLOR_0` |
| 20 | 2026-10-15 | village | `variant_weights` follow the pieces' alphabetical order (`bush`, `tree`), not the merge order: [3, 1] gave three bushes per tree. | open: accept `{tree: 3, bush: 1}` or report the piece order in the cook notes |
| 21 | 2026-10-15 | Unreal | My verification script creates the level from the open-world template, which brings its own 2 km Landscape under the import. | fixed in the test project's startup script (not product code) |
| 22 | 2026-10-15 | Unreal | After the fixes the village, colours and road arrive, but every colour looks washed out: TopoTopo stores display values (by design), glTF factors/`COLOR_0` and USD colours are linear, and both exporters wrote the display values unchanged, so every glTF/USD consumer showed them too light. | fixed: glTF and USD exporters linearise colours, the glTF importer converts back (lossless); `.geo` left raw pending a Houdini check |
| 23 | 2026-10-15 | Unreal | My startup scripts imported into the editor's unsaved open-world startup map (level creation failed on a just-deleted asset), mixing in the old demo import. | harness only: give the level a fresh name per run and retire the P2-G verification hook |

The environment graph lives outside the repository while it grows (`C:/WORK/topotopo-dogfood/environment.json`); it moves to `examples/` once it rebuilds end to end with no manual step.
