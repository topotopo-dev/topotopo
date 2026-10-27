# TopoTopoPCG for Unreal Engine 5.8

Plugin version **0.1.5** (descriptor version 6) adds `lighting=1`: a sun, sky atmosphere, real-time sky light and
height fog for previewing, each only where the level has none, and gives every prototype its own material folder
(`Meshes/Materials/<prototype>`), because prototypes share material names such as `bark`. 0.1.4 keeps prototype
meshes at `<set>/Meshes/<name>` even when a glTF material has the same name, and places
ordinary objects from `objects_static.glb`, which the exporter writes at any instance count; 0.1.3 added tiled
Landscape bundles.

Copyright 2026 faxcorp, Apache-2.0. Original plugin code, no third-party code or new npm dependencies.
Unreal Engine and its plugins remain subject to Epic's licences.

## Install and build

Copy `TopoTopoPCG/` into `<project>/Plugins/TopoTopoPCG/`. Enable **TopoTopo PCG**, **Procedural Content
Generation Framework (PCG)** and **Interchange Framework**, then restart the editor when convenient. Source
installation needs UE 5.8 and Visual Studio's C++ toolchain. A packaged plugin includes the Win64 binaries.
The `TopoTopoPCG` runtime module contains the parser and PCG nodes; `TopoTopoPCGEditor` contains the Tools command.

The descriptor supports **Win64**. In the project's `.uproject` `Plugins` array, keep this entry consistent
with `TopoTopoPCG.uplugin` (including when upgrading an existing installation):

```json
{ "Name": "TopoTopoPCG", "Enabled": true, "SupportedTargetPlatforms": ["Win64"] }
```

An entry containing only `Name` and `Enabled` triggers UE 5.8's startup warning that the
`SupportedTargetPlatforms` value differs. This is the plugin reference, not the project's target-platform list.

From the repository root in PowerShell:

```powershell
npm run export:demo
$plugin = (Resolve-Path integrations/unreal/TopoTopoPCG/TopoTopoPCG.uplugin).Path
$out = Join-Path (Get-Location) 'integrations/unreal/_build/plugin'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$package = Join-Path $out 'TopoTopoPCG'
& 'C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\RunUAT.bat' BuildPlugin "-Plugin=$plugin" "-Package=$package" -TargetPlatforms=Win64 -Rocket *> (Join-Path $out 'BuildPlugin.log')
if ($LASTEXITCODE -ne 0) { throw 'BuildPlugin failed; see integrations/unreal/_build/plugin/BuildPlugin.log' }
```

BuildPlugin runs the compiler without opening an editor. The package output, intermediate files and logs are
gitignored. Do not copy new binaries over a plugin loaded by a running editor.

## Workflow 1: import a complete scene

Run `npm run export:demo`. The bundle is `out/unreal_demo/landscape/`: five `meshes/*.glb` prototypes,
`instances.csv`, `instances.meshes.json`, `objects_expanded.glb`, `heightmap.png`, `landscape.json`, and ten
`layers/*.png` weightmaps.
In a fresh level, use **Tools > Import TopoTopo scene** with that absolute bundle directory and a new content
folder, for example `/Game/TopoTopo/PluginDemo`. Enable Landscape import for the demo terrain; weight layers
and a generated terrain material default on. The console equivalent is:

```text
TopoTopo.ImportScene "C:/path/to/topotopo/out/unreal_demo/landscape" /Game/TopoTopo/PluginDemo landscape=1 layers=1 material=1 objects=1 lighting=1
```

`lighting=1` (off by default) adds the four actors of Unreal's Basic level (directional sun as the atmosphere sun light, sky
atmosphere, real-time sky light, exponential height fog), each only when the level has none of that kind.

`layers=0` skips the weight PNGs and layer-info assets. `material=0` skips generated material creation and
assignment. With `layers=0 material=1`, the generated material is a simple grass fallback. These options have
no effect when `landscape=0` (the default); the dialog enables their controls when Landscape import is selected.

See [the editor command and detailed import limits](EDITOR_WORKFLOW.md). The command uses native Interchange
GLB pipelines, keeps the mesh split by name and imports materials. Prototypes go into `<set>/Meshes` (their
materials and textures into `Meshes/Materials/<prototype>` and `Meshes/Textures/<prototype>`, so a material never
takes a mesh's name and prototypes sharing a material name do not collide),
expanded reference meshes into `<set>/Objects`. Only ordinary objects absent from the prototype list are placed from the
expanded file; placing its tree/rock reference meshes too would duplicate the CSV instances. Assets and level
changes remain unsaved for review. Repeated imports require a fresh destination folder.

Expected demo: 536 instances in five groups (117 pine, 81 fir, 94 oak, 119 rock_a, 125 rock_b), plus the road,
and optionally one 253 x 253 Landscape with ten assigned weight layers and a readable demo material.
With all Landscape options enabled, `/Game/TopoTopo/PluginDemo/Landscape/` contains:

```text
LI_mask       LI_sediment  LI_debris  LI_flow  LI_water
LI_path       LI_rock      LI_road    LI_grass LI_trees
M_TopoTopo_PluginDemo
```

The layer-info assets and material inputs follow manifest order. The shader uses weight-blend Landscape
Layer Blend inputs for colour and roughness, a surface-following normal, grass green for `mask`, grey rock,
tan sediment/debris, dark blue flow/water, beige path and dark asphalt road. It normalizes overlapping masks
in the shader and fills uncovered areas with grass. The stored PNG weights remain independent: layer infos
use UE 5.8's `BlendMethod=None` (the successor to non-weight-blended paint layers), preventing import-time
renormalization. In particular, `sediment` and `debris` PNG bytes are already **normalised to 0..255** from
their recorded source ranges; the importer preserves those bytes and does not reconstruct their physical values.

This is an editable starter material. Select the Landscape and replace **Landscape Material** with your own
material or instance. Keep the same layer names to reuse the assigned `LI_*` assets and painted weights;
use Landscape Paint > Target Layers to assign layer infos for any new names. Save the generated assets and
level explicitly after review. Full API details and the colour mapping are in [EDITOR_WORKFLOW.md](EDITOR_WORKFLOW.md).

### Tiled Landscapes

Run `npm run export:demo -- --tiles 2` to write a 2 x 2 bundle under `out/unreal_demo_tiled/landscape/`.
Import it with the same command into an empty level and new content folder:

```text
TopoTopo.ImportScene "C:/path/to/topotopo/out/unreal_demo_tiled/landscape" /Game/TopoTopo/TiledDemo landscape=1 layers=1 material=1 objects=1
```

Version 2 adds `tile_grid` and row-major `tiles` entries. The importer reads `tiles/<x>_<y>/heightmap.png`
and weight PNGs, requires identical shared border samples, and uses one shared height range, material and
set of layer infos. In a World Partition level, one parent Landscape owns one streaming proxy per tile;
in a plain level, one Landscape owns all components, with tile boundaries aligned to component edges.
The importer uses the current level's partition mode; it does not convert the level.

Each tile gets an independent, spatially loaded HISM actor using `tiles/<x>_<y>/instances.csv`, even when
`landscape=0`. These actors do not attach to or reference the Landscape. Mesh assets and the root
`instances.meshes.json` are shared; the root CSV is checked against the complete tile stream so missing,
duplicated or changed instance transforms fail before asset import. Ordinary objects such as the road
remain on the ordinary scene actor. World Partition decides runtime cells from actor bounds and its
configured runtime grid; a tile's instance actor and terrain proxy can therefore unload independently.

For example, a 253-sample tile uses 63 quads/section, 2 x 2 sections/component and 2 x 2 components.
1009/2017-sample tiles use that same 63/2 x 2 layout with 8 x 8/16 x 16 components. A 127-quad section
does not divide 1008 or 2016 quads exactly. See the [Epic Landscape technical guide](https://dev.epicgames.com/documentation/unreal-engine/landscape-technical-guide-in-unreal-engine).
Shared edge samples count in both adjacent files; right/bottom padding repeats the source edge and is
recorded in `tile_grid.padding`. The global heightmap retains its original source resolution for interchange;
the v2 plugin import consumes the tile files, including the padded area.

## Workflow 2: generate instances with PCG

Import the five prototype GLBs through workflow 1 (a separate level can hold its placed actors), or through
Content Browser Interchange into `/Game/TopoTopo/PluginDemo/Meshes`. In a fresh PCG graph:

1. Add **TopoTopo Point Stream**. Set **File Path** to the absolute `out/unreal_demo/landscape/instances.csv`.
   Set **Coordinate Mode = AsWritten**, **Mesh Folder = /Game/TopoTopo/PluginDemo/Meshes**.
2. Connect its **Out** to **TopoTopo Instance Spawner > In**. Connect the spawner's **Out** to graph **Output**
   to inspect the resulting points. The graph **Input** is not needed.
3. Assign this graph to a PCG component/volume and Generate. Positions are world space; moving the PCG actor
   does not offset the stream. Do not also keep workflow 1's instance actor in this level.
4. Inspect the point-stream node: 536 points, `Mesh` as the original name and `MeshPath` as a Soft Object Path.
   Inspect the spawner's mesh selector: **PCGMeshSelectorByAttribute**, **Attribute Name = MeshPath**.

`TopoTopo Instance Spawner` is a thin settings subclass of Unreal's Static Mesh Spawner. It selects `MeshPath`
by default and reuses the engine element unchanged: asset loading, descriptor grouping, ISM/HISM selection,
managed resource reuse and cleanup all stay under PCG. The built-in **Static Mesh Spawner** configured with
the same selector and attribute is equivalent. Change its template descriptor Component Class to HISM if
needed; PCG can optimize the descriptor (for example for Nanite) when Allow Descriptor Changes is enabled.

This release remains code-only (`CanContainContent: false`); no binary sample graph is shipped. UE's standalone
BuildPlugin can package content, but a serialized graph has not been created and editor-verified in this
no-editor build session. The steps above define the sample; `TopoTopo.PCG.GraphSpawns536` builds that same
two-node graph transiently for automation, without an MCP node registry or saved graph asset.

The sibling `<stream>.meshes.json` sidecar supplies valid source names. A source `pine` maps to
`<Mesh Folder>/pine.pine`. **Mesh Mapping** provides explicit per-name Static Mesh assets and takes precedence;
use it for renamed/importer-prefixed assets or without a sidecar. The node resolves paths without importing
or loading meshes; the spawner loads them. Runtime builds must cook those assets explicitly (for example
Additional Asset Directories to Cook); paths synthesized from external JSON are not cooker dependencies.

**Reimport on Change** defaults on: every graph generation reads the file again and downstream CRCs include
the output. There is no background file watcher; click Generate/Force Generate after editing a stream. When
off, normal PCG caching applies until settings change or the PCG cache is flushed.

## Workflow 3: native point data and attributes

Set File Path to a native `.points.json` / `points.json` stream and **Coordinate Mode = FromTopoTopoYUp**.
The same node can feed PCG filters, attribute operations or the spawner when the stream contains `Mesh`.
Native CSV with `P.x,P.y,P.z` is supported too. Absolute paths work, relative paths resolve against the
directory containing the `.uproject`, not the plugin or process working directory.

PCG CSV `Position.X/Y/Z`, `Rotation.Roll/Pitch/Yaw` and `Scale.X/Y/Z` are consumed directly. The DataTable
`pcg_struct` variant (`Position="(X=...,Y=...,Z=...)"`, etc.) is also accepted without a row struct.
Density, Color and Seed become native PCG properties. Zero seed remains zero. **Seed Column** and
**Density Column** override the defaults; empty uses the stream's standard columns.

Other columns become metadata. Numeric scalars are double or int64; strings stay strings; complete component
groups become Vector2/Vector/Vector4 (including RGBA colours). JSON retains declared float/int/string types.
PCG represents colours as Vector4. **Attribute Include/Exclude** filter metadata by exact, case-sensitive names;
empty include means all and exclude wins. They do not discard transforms or native point properties.
The CSV `Name` row key is consumed separately from the real `name_attr` attribute. The exporter suffixes
attributes that differ only by case from canonical `Name`, `Position`, `Rotation`, `Scale`, `Density`, `Color`,
`Seed` or `Mesh`: for example, `name` becomes `name_attr` and `mesh` becomes `mesh_attr`. Old CSVs with both
spellings are also accepted: the loader keeps the canonical spelling and renames the other to `<name>_attr`,
with a warning, before metadata filtering. Canonical columns win regardless of header order. A suffix that
would itself collide, an exact duplicate, or ambiguous noncanonical duplicates remain errors; no value is overwritten.
CSV has no type
schema: known integer names (`id`, `class`, `seed`, `copynum`, `piece`, `variant`, `ptnum`, `primnum`) become
int64 when all values are integral; other numeric scalars become double. Quoted scalar cells remain strings.
Tuples of 5..16 components become `name_0`, `name_1`, etc. Select their base name to include all components.
Invalid or case-colliding metadata names are rejected with a rename instruction, because Unreal metadata
names are case insensitive and do not allow periods. Additional metadata vectors retain source values;
coordinate conversion applies to the point transform, not arbitrary vector attributes.

Version 1 format tags accept both current and pre-rename bundles throughout the plugin:
`topotopo-points` / `polyforge-points`, `topotopo-instance-meshes` / `polyforge-instance-meshes`, and
`topotopo-unreal-landscape` / `polyforge-unreal-landscape`. Unknown tags and unsupported versions remain errors.

## Coordinates

TopoTopo uses Y-up metres; Unreal uses Z-up centimetres. The hand-verified mapping is:

```text
Unreal position = 100 * (TopoTopo x, TopoTopo z, TopoTopo y)
Unreal scale    = pscale * (scale.x, scale.z, scale.y)
```

PCG CSV already contains that conversion: use **AsWritten**, never negate yaw or multiply its positions by 100
again. Native streams use `orient` (quaternion x,y,z,w), otherwise `N` (or `v`) as forward with `up` (default
0,1,0), followed by `rot`. `trans` is added before position conversion. The rotation calculation follows
`src/io/points.ts`'s `unrealRotator` matrix-column permutation and atan2 equations, including roll; it is not a
generic Euler-axis swap. Nonuniform and negative scale are preserved. Shear is already approximated by the
exporter when it decomposes packed instances.

Landscape import uses `landscape.actor_location_cm` from the manifest. The manual Landscape panel instead
uses `new_landscape_location_cm` because that panel centres the grid. For this demo: section size 63,
2 x 2 sections, 2 x 2 components; panel location `(0,0,1169.3223)`, scale `(50,50,4.603792)`, actor location
`(-6300,-6300,1169.3223)`. Bounds should end at +/-6300 cm. Height is
`actorZ + (uint16Value - 32768) * scaleZ / 128`.

## Automation and editor checks

The C++ automation tests compile with the plugin. Running them and validating the imported scene belong to
the editor verification step; compilation alone does not prove rendering, import, undo or PCG regeneration.

For an installed copy of the plugin, provide the CSV explicitly when starting the editor:

```text
-TopoTopoDemoCSV="C:/path/to/topotopo/out/unreal_demo/landscape/instances.csv"
```

Alternatively set the `TOPOTOPO_DEMO_CSV` environment variable before starting it, or keep the repository's
`out/unreal_demo/landscape/instances.csv` reachable by walking up from the plugin folder. Both point-stream
demo tests fail with setup instructions if the CSV is missing; neither silently passes without that fixture.
The Landscape test also accepts that CSV path, or an explicit `-TopoTopoDemoBundle="<absolute bundle directory>"`
or `TOPOTOPO_DEMO_BUNDLE` directory. It emits an explicit `SKIPPED` warning if `landscape.json` is absent;
a present but malformed/incomplete bundle fails.

Open **Session Frontend** from the Tools menu, select **Automation**, refresh and filter `TopoTopo`; run the tests. The
Output Log console command for the acceptance fixture is:

```text
Automation RunTests TopoTopo.UnrealDemo.PointStream
```

The fixture checks 536 points and the first pine at `(3740.23858,-6233.69197,396.099846)`, rotator
`(Pitch=0,Yaw=-105.954505,Roll=0)`, uniform scale `2.02927671`, mesh counts, types and `name_attr` PCG metadata.

After importing the five meshes into `/Game/TopoTopo/PluginDemo/Meshes`, run the actual PCG path:

```text
Automation RunTests TopoTopo.PCG.GraphSpawns536
```

The test constructs **Point Stream > Instance Spawner > Output** on a transient component in an isolated
world, with an offset owner to verify world-space transforms. It uses `GenerateLocalGetTaskId(true)` and
`UPCGSubsystem::ScheduleGeneric` with that task as a dependency. A latent automation command ticks only that
world's PCG subsystem while editor frames service asynchronous work. A synchronous spin would block the
next-frame callbacks used by PCG. Completion or a 60-second timeout cancels pending work, cleans up managed
resources and destroys the test world. The current level and content assets are not saved or changed.

Expect 536 graph-output points, exactly five ISM/HISM components, counts pine 117 / fir 81 / oak 94 /
rock_a 119 / rock_b 125, and the first pine world transform above. ISM float storage is checked within
0.01 cm for position and 0.0001 for rotation degrees and scale. If any required mesh is absent, the test emits
**SKIPPED TopoTopo.PCG.GraphSpawns536** with the missing paths and import instructions. UE simple automation
displays this as success with a warning, **not an accepted PCG run**; import the meshes and rerun.

Run the Landscape import acceptance independently of the imported mesh assets:

```text
Automation RunTests TopoTopo.Editor.WeightLayers
```

It runs the command's heightmap/layer/material import path in an isolated transient editor world. Expect ten
layer infos and material layer references in manifest order, exact vertex-weight byte readback (including
all-zero maps), every layer's mean within 2% of its PNG mean, and connected colour/roughness/normal inputs.
The engine's built-in visibility target is excluded from the ten imported layers. Small 8x8 fixtures also
check `layers=0 material=1` (grass fallback) and `layers=1 material=0` (weights without an assigned material).
The world and generated assets are transient; the current level and Content Browser assets are not changed
or saved. **SKIPPED TopoTopo.Editor.WeightLayers** is a warning, **not Landscape acceptance**; supply the demo
bundle and rerun. Shader compilation and visual inspection still belong to the editor verification step.

`Automation RunTests TopoTopo` runs all sixteen tests. Individual names and expected results:

| Test | Expected result |
|---|---|
| `TopoTopo.UnrealDemo.PointStream` | 536 fixture points; five mesh totals, transforms, typed metadata including `name_attr`, mapping override. Requires CSV, no mesh assets. |
| `TopoTopo.PCG.GraphSpawns536` | Real graph generation and component/transform checks above. Requires CSV and five imported meshes; no skip for acceptance. |
| `TopoTopo.Stream.CSVCollisionCompatibility` | Canonical columns and suffixed attributes preserved, independent of column order; warnings and exact metadata filtering checked. |
| `TopoTopo.Stream.LegacyFormats` | Legacy points JSON keeps native conversion; both mesh-sidecar tags resolve identical paths and reject version 2. |
| `TopoTopo.Editor.LandscapeManifestCompatibility` | Both Landscape v1 tags decode the same 8x8 heightmap; unknown, incomplete v2 and non-exact manifests rejected. Creates only temporary fixture files. |
| `TopoTopo.Editor.TiledLandscape.Plain` | Generated 2 x 2 fixture: one 15 x 15 Landscape, four components, no proxies, exact height/weight readback and four HISM tile actors with 1/2/3/4 instances (10 total). |
| `TopoTopo.Editor.TiledLandscape.WorldPartition` | Same generated fixture in an isolated partitioned world: four proxies sharing the Landscape GUID, material and layer info; no parent components; exact seam samples and the same per-tile HISM counts/transforms. |
| `TopoTopo.Editor.TiledLandscape.Validation` | Inconsistent height ranges, seams, overlap positions, grid coordinates, padding and instance count/global-stream mismatches fail before import. |
| `TopoTopo.Editor.WeightPNGDecode` | 8-bit greyscale and greyscale-plus-alpha PNG samples decode unchanged; alpha is ignored and unsupported/malformed inputs are rejected. |
| `TopoTopo.Editor.WeightLayerManifest` | Manifest layer order, names, paths, min/max and encoding retained; invalid layers rejected without partial output. |
| `TopoTopo.Editor.WeightLayers` | Demo heightmap, ten assigned layer infos, PNG/readback means within 2% and exact bytes, assigned material with all layers and simple surface inputs; independent layer/material switches. Requires bundle; no skip for acceptance. |
| `TopoTopo.Stream.CSVAttributes` | RFC 4180, metadata types/vectors, native properties and filters pass. |
| `TopoTopo.Stream.JSONTransforms` | Native transform/axis conversion, seed, density, colour and metadata pass. |
| `TopoTopo.Stream.CSVVariants` | Native, flat PCG and struct PCG CSV variants pass. |
| `TopoTopo.Stream.RejectMalformed` | Invalid CSV/JSON and unresolved name collisions fail cleanly without partial output. |
| `TopoTopo.PCG.SpawnerDefaults` | `MeshPath` defaults survive duplication; customized copies retain their selector without changing fresh defaults. |

For visual validation use workflow 2's two-node graph in an empty level; check those five mesh counts and
the first pine transform. Force-generate twice, then Cleanup: components should be reused/removed by PCG,
not accumulated. Separately use workflow 1 with Landscape enabled; inspect the road and tree bases and
check the generated terrain colours (`mask` green base and dark `road`), the ten Paint target layers, and
save/reload the Landscape/material/infos. Do not run both instance workflows in the same level simultaneously.
Save/reload the graph and copy/paste its spawner node; verify that `MeshPath` remains the mesh selector.

The three tiled tests generate all files themselves and use Unreal's built-in cube mesh. They need no
exported demo or imported project assets and never skip on missing fixtures. Run
`Automation RunTests TopoTopo.Editor.TiledLandscape` in the installed plugin's editor. They create isolated
test worlds and temporary files, leaving the current level unchanged. BuildPlugin compiles these tests;
running them needs the editor.

## Limits

- Only Win64 UE 5.8 builds are provided. Float parsing and rotation formulas mirror the exporter;
  cross-platform bit identity of Unreal/libm operations has not been measured.
- File loading/parsing and editor import are synchronous. Large streams can stall generation; no 100k-point
  performance claim is made. External files are not automatically staged in packaged games.
- Landscape v1 supports one exact-fit heightmap up to 8193 samples per side; v2 supports tile files up to
  8193 samples and an assembled padded grid up to 32769 samples per side. Import assembles the full grid
  before calling Unreal's import API: it is synchronous and is not bounded-memory streaming. UE 5.8's
  full-grid normal buffer alone is about 6 GiB for 16K x 16K samples, in addition to heights, masks and
  textures. Large-grid memory/performance has not been editor-tested. Resampling, runtime virtual textures,
  Nanite Landscape and foliage are not implemented. Tiled terrain has no single-file reimport source;
  export and import a fresh bundle into a new destination to regenerate it.
- The standard TopoTopo heightfield nodes retain their 4097 x 4097 total-sample budget. This change does
  not lift that generation cap or demonstrate 16K terrain generation; the exporter uses dense source
  arrays and retains both global and tiled output bytes.
- `scene.glb` / `objects.glb` use `EXT_mesh_gpu_instancing`. The utility deliberately uses prototype GLBs plus
  the CSV; expanded reference GLBs are for the remaining ordinary objects and comparison.
- The optional **Cook with TopoTopo** subprocess element is not implemented. Cook/export externally, then
  regenerate PCG. Executing a TopoTopo graph executes code; this plugin itself never launches `npx` or a shell.
