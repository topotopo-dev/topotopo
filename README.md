# Polyforge

A procedural geometry engine in the spirit of Houdini SOPs. You build JSON node graphs; the engine cooks them into
geometry. It runs headless (Node + WebAssembly, no GPU) and plugs into LLM agents as an **MCP server**. The core is
browser-ready, so it can sit under a future GUI.

- **over 100 node types**: generators, curves and sweeps, deformers, attributes and groups, polygon modelling, scattering and
  instancing, robust booleans, Voronoi fracture, an SDF/implicit toolkit, heightfield terrain (masks, hydraulic and
  thermal erosion, roads, scattering), L-systems, text, loops, a frame solver, assets, and code nodes.
- **Time**: every cook happens at a frame. Only time-dependent nodes re-cook when the frame changes, and the `solver`
  node advances a simulation frame by frame from its cached previous state.
- **Built for agents**: one-call graph builds, did-you-mean validation, text summaries, a multi-view **render** the
  model can look at, incremental edits with content-hash caching, and JS escape hatches (`wrangle` with `@P` syntax,
  `script`, `sdf_expr`).
- **Pipeline output**: GLB, OBJ, USDA, PLY, STL and lossless JSON, with Y/Z-up and scale. Mesh splitting follows the
  `name` attribute, for Unreal, Blender and Houdini. Heightfields export as Unreal Landscape heightmaps (16-bit PNG or
  RAW `.r16` with a JSON sidecar holding the import scale) and 8-bit weight layers.
- **Live preview**: a local three.js page that refreshes whenever a graph changes. Click any node to see its result.

The design notes, including whether the browser is a limitation, are in [docs/DESIGN.md](docs/DESIGN.md).

![city](examples/renders/voronoi_city.png)

## Setup

Requires Node ≥ 22.18 (it runs the TypeScript sources directly; no build step).

```bash
npm install
```

```bash
npm test
```

`npm test` cooks every node type and checks geometry invariants, compares golden fingerprints, runs random-graph
property tests and a wrangle fuzz, checks the node reference is current, round-trips every file format and runs the
MCP server end to end, the way a real client would. See [Testing](#testing). To re-render the examples into
`examples/renders`:

```bash
npm run showcase
```

To browse the examples in the live 3D viewer without an MCP client:

```bash
npm run preview
```

### Connect to Claude Code
The repository includes [.mcp.json](.mcp.json), so opening a Claude Code session in this folder offers the `polyforge` server.
To register it from anywhere, use an absolute path:

```bash
claude mcp add polyforge -- node /absolute/path/to/polyforge/src/mcp/server.ts --workspace /absolute/path/to/polyforge/workspace
```

### Other MCP clients (Claude Desktop, …)
```json
{
  "mcpServers": {
    "polyforge": {
      "command": "node",
      "args": ["C:/path/to/polyforge/src/mcp/server.ts", "--workspace", "C:/path/to/polyforge/workspace"]
    }
  }
}
```
Options: `--viewer` (start the live preview immediately), or set `POLYFORGE_PORT`, `POLYFORGE_WORKSPACE` and
`POLYFORGE_SCRIPT_TIMEOUT_MS`.

## MCP tools

| tool | purpose |
|---|---|
| `catalog` | node types by category (filter/search) |
| `help` | exact node docs (params, defaults, ranges, aliases, examples) and topics: graph, expressions, time, wrangle, groups, attributes, sdf, heightfield, loops, assets, export, recipes |
| `build` | create/replace a graph and cook it; `dry_run`, `mode: "merge"`, optional `render`, `frame` (also on edit, inspect, render, export) |
| `edit` | incremental ops: set, add, insert-after, remove (auto-rewire), connect, rename, replace, output, vars, bypass |
| `inspect` | summary, attribute stats, topology health (watertight, pieces, volume, genus), element listings |
| `render` | PNG with persp/front/right/top views, colour by attribute, group highlight, flipped normals in blue |
| `export` | glb / obj / usda / ply / stl / json; heightfields: png16 / r16 (+ JSON sidecar with the Unreal import numbers) / mask_png |
| `graphs` | list / get / delete / rename / duplicate workspace graphs (stored as JSON in `workspace/graphs`) |
| `assets` | save a graph with vars as a reusable node type (like an HDA); list / get / delete |
| `preview` | start the live viewer and return its URL |

## Graph format

```json
{
  "vars": { "count": 200 },
  "nodes": {
    "ground": { "type": "terrain", "params": { "size": [30, 30], "height": 3 } },
    "pts":    { "type": "scatter", "in": ["ground"], "params": { "count": "=count", "seed": 1 } },
    "rock":   { "type": "sphere", "params": { "type": "ico", "level": 2, "radius": 0.3 } },
    "rough":  { "type": "noise_displace", "in": ["rock"], "params": { "amplitude": 0.08, "frequency": 4 } },
    "rocks":  { "type": "copy_to_points", "in": ["rough", "pts"] },
    "out":    { "type": "merge", "in": ["ground", "rocks"] }
  }
}
```

The conventions are Houdini's: Y-up, metres, degrees, and attributes such as `P N Cd uv pscale orient up width name class`.

Any param can be an expression: a string starting with `=` is evaluated as JavaScript with the graph `vars`
(`"=count * 2"`), the cook time (`frame`, `time`, `fps`, `timeInc`) and functions that read other nodes of the same
graph: `npoints('pts')`, `nprims`, `nvertices`, `bbox('base').size.y` (also `min`, `max`, `center`), `centroid`,
`detail('n', 'attr')`, `point('n', i, 'P')`, `prim('n', i, 'attr')` and `ch('box1/size')` for another node's param.
Referenced nodes become dependencies: they are cooked first, editing them re-cooks the reader, and unknown names or
cycles are reported before cooking. Node names must be string literals; these functions are not available in `vars`.

Group patterns look like `top`, `!top`, `0-10` or `@P.y>0.5`. A wrangle snippet looks like this:

```js
@P.y += noise(mul(@P, 2)) * 0.1;
@Cd = hsv2rgb(rand(@ptnum), 0.6, 1);
if (@P.y < 0) removepoint(0, @ptnum);
```

## Node types

| category | nodes |
|---|---|
| generate | `box` `grid` `sphere` `tube` `torus` `platonic` `points` `point_grid` `parametric_surface` `terrain` `lsystem` `text` |
| curve | `parametric_curve` `line` `circle` `curve` `spiral` `shape2d` `resample` `carve` `ends` `sweep` `polywire` `revolve` `extrude` `offset_curve` `boolean2d` `fill` `loft` `voronoi2d` `triangulate2d` |
| transform | `transform` `match_size` `mirror` |
| deform | `noise_displace` `twist` `bend` `taper` `smooth` `peak` `jitter` `ray` `soft_transform` `lattice` `path_deform` `point_deform` `rest` |
| attribute | `attrib_create` `attrib_randomize` `attrib_promote` `attrib_delete` `attrib_rename` `attrib_copy` `attrib_transfer` `attrib_array` `attrib_noise` `color` `measure` `connectivity` (float/int tuples, strings, and float[]/int[]/string[] array attributes) |
| group | `group` `delete` `group_promote` `group_expand` `group_combine` `group_delete` `group_rename` (point, vertex, prim and edge groups) |
| topology | `sort` `normal` `fuse` `clean` `reverse` `facet` `triangulate` `subdivide` `poly_extrude` `grid_split` `fill_holes` `bound` `decimate` `remesh` |
| copy | `copy_xform` `scatter` `copy_to_points` |
| solid | `convex_hull` `boolean` `clip` `minkowski` `smooth_solid` `voronoi_fracture` `slice` |
| sdf | `sdf_shape` `sdf_expr` `sdf_combine` `sdf_modify` `sdf_from_mesh` `sdf_to_mesh` |
| heightfield | `heightfield` `heightfield_noise` `heightfield_from_mesh` `heightfield_from_image` `heightfield_to_mesh` `heightfield_to_sdf` `heightfield_remap` `heightfield_blur` `heightfield_terrace` `heightfield_clip` `heightfield_cutout` `heightfield_layer` `heightfield_mask_by_feature` `heightfield_mask_by_object` `heightfield_mask_noise` `heightfield_mask_blur` `heightfield_mask_expand` `heightfield_erode` `heightfield_project` `heightfield_path` `heightfield_scatter` `heightfield_resample` `heightfield_transform` (grids in XZ with named layers; export `png16`/`r16`/`mask_png` for Unreal Landscape) |
| uv | `uv_project` `uv_transform` |
| code | `wrangle` `script` |
| flow | `merge` `switch` `null` `input` `foreach` `solver` `graph_ref` (plus saved assets) |
| io | `file` (obj, stl, ply, glb/gltf, json) |

Every node's inputs, parameters (types, defaults, ranges, options, aliases) and outputs are listed in the generated
[node reference](docs/nodes.md).

## Examples

[examples/](examples) has thirteen graphs, each rendered by `node test/showcase.ts` into [examples/renders](examples/renders):
rocks on terrain, an L-system tree, a Voronoi-fractured sphere, an SDF creature, a procedural building (foreach,
grid_split, inset/extrude windows), an engraved sign (text + boolean), a Voronoi city, spiral stairs (copy_xform + sweep), wrangle waves, a CSG
bracket, deformers, an eroded heightfield terrain with a road and rocks on its steep slopes, and a solver growth
animation (rendered at the frame named by its `meta.frame`).

To cook a graph from the command line:

```bash
node src/cli.ts examples/tree.json --render out/tree.png --export out/tree.glb
node src/cli.ts examples/terrain_erosion.json --node road --export out/terrain.png   # 16-bit heightmap + terrain.json (Unreal)
```

Animated graphs cook at a frame (`--frame 40`) or over a range. With `--frames`, output paths may contain `{frame}` or
`{frame:04}`; without a pattern, `.0001`-style frame numbers are inserted before the extension:

```bash
node src/cli.ts examples/solver_growth.json --frames 1-48 --render "out/growth_{frame:04}.png" --export out/growth.glb
```

## Testing

`npm test` runs these layers in order; each can also run alone.

| layer | command | what it checks |
|---|---|---|
| smoke | `npm run test:smoke [-- filter]` | every node type cooks on its fixture inputs and passes the geometry invariants (`checkGeo`) |
| golden | `npm run test:golden [-- filter]` | every node fixture and every `examples/*.json` graph matches its fingerprint in `test/golden/` |
| property | `npm run test:property` | 150 random node chains: no exception escapes the engine, invariants hold, cooks are deterministic, the cache returns the same result after a param is changed and restored; plus a wrangle fuzz (random, malformed and never-ending snippets) |
| docs | `npm run test:docs` | `docs/nodes.md` matches the node definitions |
| io | `node test/io.ts` | export → import round trips for every format |
| mcp | `node test/mcp.ts` | the MCP server end to end over stdio |
| arrays | `node test/arrays.ts` | array attributes: storage, merge and builder rules, wrangle `f[]@`/`i[]@`/`s[]@` and helpers, `attrib_array`, JSON, inspect, fingerprints, every node type fed array attributes |
| heightfield | `node test/heightfield.ts` | heightfields: the volume model, every heightfield node's behaviour (round trips, masks, erosion determinism and mass conservation, roads, scattering), the erosion speed target (512² × 100 iterations), png16/r16/mask_png export through the PNG decoder, render/inspect hooks, MCP export |

Fixtures (source geometry, per-node inputs and params) live in `test/fixtures.ts`; `fixtureGraphFor(type)` builds the
graph every layer uses to cook a node.

**Golden fingerprints.** A fingerprint holds counts, the bbox (rounded to 1e-4), the attribute schema and group names
per class, and hashes of positions (quantised to 1e-5), topology and every attribute (1e-4). They are stable across runs
and tolerant to float noise, and there is one JSON file per node or example, so a change shows up as a readable git
diff. When a change to geometry output is intended:

```bash
npm run test:update            # rewrite test/golden/*.json (removes files for deleted nodes)
npm run test:update -- sweep   # only names containing "sweep"
git diff test/golden           # review what changed, then commit it with the code
```

A failing golden prints each changed field with its old and new value. Nothing depends on the machine: the `text`
node defaults to the bundled `assets/fonts/DejaVuSans.ttf`, so its fingerprint is the same everywhere.

**Property tests and fuzz.** `node test/property.ts --count 1000 --seed 7` explores more graphs; a failure prints
the graph JSON and the `--seed S --only I` flags to reproduce it. `--strict` also fails on node errors that look like
internal JS errors. `node test/fuzz.ts --count 500` runs more wrangle snippets.

**Node reference.** `npm run docs` regenerates [docs/nodes.md](docs/nodes.md) from the `NodeDef`s. Commit it with any
node or param change; `npm test` fails while it is stale.

**Benchmarks.** `npm run bench` times named cooks (scatter, copy, subdivide, boolean, noise, wrangle, SDF meshing,
triangulate, merge, fuse) against targets from the roadmap and prints a Markdown table. `--quick` uses smaller sizes,
`--filter name` selects cases. Results go to `bench/last.json`; `bench/baseline.json` is a reference run (informational,
never failing).

CI (`.github/workflows/ci.yml`) runs `npm run typecheck` and `npm test` on Node 22 and 24 for every push and pull request.

## Layout

`src/core` holds the geometry model and algorithms. `src/graph` holds the node system and cooking engine, and `src/nodes`
the node library. The renderer is in `src/render`, import/export in `src/io`, and the MCP server, tools and docs in
`src/mcp`. `src/viewer` has the live preview, and `src/host` the Node host (sandbox, files, fonts). The structure is
described in [docs/DESIGN.md](docs/DESIGN.md).
