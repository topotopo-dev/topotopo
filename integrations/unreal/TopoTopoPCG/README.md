# TopoTopoPCG for Unreal Engine 5.8

Copyright 2026 faxcorp, Apache-2.0. Original plugin code, no third-party code or new npm dependencies.
Unreal Engine and its plugins remain subject to Epic's licences.

## Install and build

Copy `TopoTopoPCG/` into `<project>/Plugins/TopoTopoPCG/`. Enable **TopoTopo PCG**, **Procedural Content
Generation Framework (PCG)** and **Interchange Framework**, then restart the editor when convenient. Source
installation needs UE 5.8 and Visual Studio's C++ toolchain. A packaged plugin includes the Win64 binaries.
The `TopoTopoPCG` runtime module contains the parser and PCG nodes; `TopoTopoPCGEditor` contains the Tools command.

From the repository root in PowerShell:

```powershell
npm run export:demo
$plugin = (Resolve-Path integrations/unreal/TopoTopoPCG/TopoTopoPCG.uplugin).Path
$package = Join-Path (Get-Location) 'integrations/unreal/_build/TopoTopoPCG'
& 'C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\RunUAT.bat' BuildPlugin "-Plugin=$plugin" "-Package=$package" -TargetPlatforms=Win64 -Rocket *> out-topotopo-build.log
if ($LASTEXITCODE -ne 0) { throw 'BuildPlugin failed; see out-topotopo-build.log' }
```

BuildPlugin runs the compiler without opening an editor. The package output, intermediate files and logs are
gitignored. Do not copy new binaries over a plugin loaded by a running editor.

## Workflow 1: import a complete scene

Run `npm run export:demo`. The bundle is `out/unreal_demo/landscape/`: five `meshes/*.glb` prototypes,
`instances.csv`, `instances.meshes.json`, `objects_expanded.glb`, `heightmap.png` and `landscape.json`.
In a fresh level, use **Tools > Import TopoTopo scene** with that absolute bundle directory and a new content
folder, for example `/Game/TopoTopo/PluginDemo`. Enable Landscape import for the demo terrain.

See [the editor command and detailed import limits](EDITOR_WORKFLOW.md). The command uses native Interchange
GLB pipelines, keeps the mesh split by name and imports materials. Prototypes go into `<set>/Meshes`, expanded
reference meshes into `<set>/Objects`. Only ordinary objects absent from the prototype list are placed from the
expanded file; placing its tree/rock reference meshes too would duplicate the CSV instances. Assets and level
changes remain unsaved for review. Repeated imports require a fresh destination folder.

Expected demo: 536 instances in five groups (117 pine, 81 fir, 94 oak, 119 rock_a, 125 rock_b), plus the road,
and optionally one 253 x 253 Landscape. Heightfield materials and weight layers are assigned manually.

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
The CSV `Name` row key is consumed separately from the real lowercase `name` attribute. CSV has no type
schema: known integer names (`id`, `class`, `seed`, `copynum`, `piece`, `variant`, `ptnum`, `primnum`) become
int64 when all values are integral; other numeric scalars become double. Quoted scalar cells remain strings.
Tuples of 5..16 components become `name_0`, `name_1`, etc. Select their base name to include all components.
Invalid or case-colliding metadata names are rejected with a rename instruction, because Unreal metadata
names are case insensitive and do not allow periods. Additional metadata vectors retain source values;
coordinate conversion applies to the point transform, not arbitrary vector attributes.

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

## Automation and editor handoff

The C++ automation tests compile with the plugin. Running them and validating the imported scene belong to
the editor verification step; compilation alone does not prove rendering, import, undo or PCG regeneration.

For an installed copy of the plugin, provide the CSV explicitly when starting the editor:

```text
-TopoTopoDemoCSV="C:/WORK/polyforge/.claude/worktrees/codex-kernels/out/unreal_demo/landscape/instances.csv"
```

Alternatively set the `TOPOTOPO_DEMO_CSV` environment variable before starting it, or keep the repository's
`out/unreal_demo/landscape/instances.csv` reachable by walking up from the plugin folder. The demo test fails
with setup instructions if the file is missing; it never silently passes without the fixture.

Open **Session Frontend** from the Tools menu, select **Automation**, refresh and filter `TopoTopo`; run the tests. The
Output Log console command for the acceptance fixture is:

```text
Automation RunTests TopoTopo.UnrealDemo.PointStream
```

The fixture checks 536 points and the first pine at `(3740.23858,-6233.69197,396.099846)`, rotator
`(Pitch=0,Yaw=-105.954505,Roll=0)`, uniform scale `2.02927671`, mesh counts, types and PCG metadata.
Run `Automation RunTests TopoTopo` for the in-memory parser/conversion and spawner-default tests as well.

For visual validation use workflow 2's two-node graph in an empty level; check those five mesh counts and
the first pine transform. Force-generate twice, then Cleanup: components should be reused/removed by PCG,
not accumulated. Separately use workflow 1 with Landscape enabled; inspect the road and tree bases and
assign a Landscape material/layers. Do not run both instance workflows in the same level simultaneously.
Save/reload the graph and copy/paste its spawner node; verify that `MeshPath` remains the mesh selector.

## Limits

- Only Win64 UE 5.8 is built in this handoff. Float parsing and rotation formulas mirror the exporter;
  cross-platform bit identity of Unreal/libm operations has not been measured.
- File loading/parsing and editor import are synchronous. Large streams can stall generation; no 100k-point
  performance claim is made. External files are not automatically staged in packaged games.
- Landscape import supports a single exact-fit heightmap, not resampling, tiled/world-partition streaming,
  automatic layer-info/material creation or automatic weightmap assignment. Manual steps are in
  `landscape.json`'s `manual_import` list.
- `scene.glb` / `objects.glb` use `EXT_mesh_gpu_instancing`. The utility deliberately uses prototype GLBs plus
  the CSV; expanded reference GLBs are for the remaining ordinary objects and comparison.
- The optional **Cook with TopoTopo** subprocess element is not implemented. Cook/export externally, then
  regenerate PCG. Executing a TopoTopo graph executes code; this plugin itself never launches `npx` or a shell.
