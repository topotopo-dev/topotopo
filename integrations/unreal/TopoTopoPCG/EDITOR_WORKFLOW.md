<!-- Copyright 2026 faxcorp, Apache-2.0 -->
# Import a TopoTopo scene in Unreal Editor

Enable **TopoTopoPCG**, **PCG**, and **Interchange Framework**, then restart the editor yourself after installing the built plugin. The plugin provides **Tools > Import TopoTopo scene** and the equivalent editor console command below. These operations run in the current level, outside Play/Simulate mode.

In the `.uproject` `Plugins` array, use `{"Name":"TopoTopoPCG","Enabled":true,"SupportedTargetPlatforms":["Win64"]}`.
This matches the plugin descriptor and avoids UE 5.8's "SupportedTargetPlatforms value differs" startup warning;
update an existing entry as part of installation. Do not replace binaries while the editor has this plugin loaded.

Run `npm run export:demo` in the repository to produce `out/unreal_demo/landscape/`. This folder contains `instances.csv`, `instances.meshes.json`, five `meshes/*.glb` prototypes, `objects_expanded.glb`, `heightmap.png`, `landscape.json`, and ten `layers/*.png` weightmaps.

Open a disposable empty level in the intended project. Use a **new, empty** destination such as `/Game/TopoTopo/PluginDemo`; the existing manually verified `/Game/TopoTopo/Demo` is separate. In the Tools dialog, paste the absolute path to `out/unreal_demo/landscape`, set the destination, and optionally select Landscape import. Its weight-layer and generated-material checkboxes default on and become available when Landscape import is selected. The bundle path may also be relative to the Unreal project directory.

The command for the repository's demo bundle, entered in the Unreal Output Log console, is:

```text
TopoTopo.ImportScene "C:/path/to/topotopo/out/unreal_demo/landscape" /Game/TopoTopo/PluginDemo landscape=1 layers=1 material=1 objects=1
```

`landscape=0` skips terrain (the default). `layers=1` and `material=1` default on when a Landscape is imported;
`layers=0` skips weightmap decoding and layer-info creation, while `material=0` leaves the Landscape without
an assigned material. `layers=1 material=0` imports the weights for your own material; `layers=0 material=1`
creates a plain grass fallback. Layer/material options do nothing when `landscape=0`. `objects=0` skips
the ordinary objects (`objects_static.glb`, or `objects_expanded.glb` in bundles from before it existed);
`objects=1` is the default. `lighting=1` adds a sun, sky atmosphere, real-time sky light and height fog where the level
has none (default `lighting=0`). Unknown options and values other than `0`/`1` are errors.
The destination must be below `/Game/TopoTopo/` and contain no existing assets, including subfolders. To repeat
an import, choose another set name; the utility does not overwrite assets or clear an earlier level import.

## What the command creates

- **Meshes/**: each sidecar prototype GLB imports through Interchange as one named Static Mesh with its material slots. Without the sidecar, `meshes/*.glb` filenames supply the mesh names. Import is stopped if a prototype produces multiple meshes or loses its expected name. Exact `Mesh -> asset path` entries are printed in `LogTopoTopoImport`.
- **Objects/**: Interchange imports the expanded GLB with mesh combination disabled, preserving per-name splits and materials. Expanded copies of any instanced prototypes are reference assets only. The utility places only ordinary meshes absent from the prototype list, such as `road`. It checks that the used prototype names survive the expanded import before placing anything, so unexpected importer renaming cannot silently duplicate the trees/rocks.
- **TopoTopo_PluginDemo**: one actor with a HISM component per prototype, populated from CSV world transforms. The demo has **536 instances** in **five prototype components**: pine 117, fir 81, oak 94, rock_a 119, rock_b 125. With `objects=1`, one additional HISM component has the ordinary road at the identity transform. The expanded pine/fir/oak/rock meshes are not placed.
- **TopoTopo_PluginDemo_Landscape** (optional): one Landscape from the 16-bit heightmap. It has 253 x 253 samples, 63 quads per section, 2 x 2 sections per component, and 2 x 2 components. The actor corner is `(-6300, -6300, 1169.3223)` cm, scale `(50, 50, 4.603792)`. Its XY extent is -6300 to +6300 cm. The UI's centered location `(0, 0, 1169.3223)` is not the actor corner.
- **Landscape/LI_*** (`landscape=1 layers=1`): `ULandscapeLayerInfoObject` assets for every manifest layer,
  assigned to the Landscape with their PNG weights. Demo order: `LI_mask`, `LI_sediment`, `LI_debris`,
  `LI_flow`, `LI_water`, `LI_path`, `LI_rock`, `LI_road`, `LI_grass`, `LI_trees`. The order is preserved even
  for layers whose PNG is entirely zero.
- **Landscape/M_TopoTopo_PluginDemo** (`landscape=1 material=1`): generated material assigned to the
  Landscape. The final destination folder supplies the set name in `M_TopoTopo_<set>`; all eleven demo
  Landscape assets live under `/Game/TopoTopo/PluginDemo/Landscape/`.

The first pine transform is approximately position `(3740.24, -6233.69, 396.10)` cm, yaw `-105.95` degrees and uniform scale `2.029`. The CSV is already converted to Unreal axes and units; it is read in `AsWritten` mode. No second Y/Z swap or metre-to-centimetre scaling is applied.

Current CSVs call the prim name attribute `name_attr`, separate from the canonical `Name` row key. For older
CSVs containing both `Name` and `name` (or `Mesh` and `mesh`, etc.), the loader retains the canonical column,
imports the other as `<name>_attr`, and logs a warning. Include/exclude filters use that renamed metadata name.
Exact duplicates and collisions with an existing suffixed name remain errors rather than discarding data.
Both `topotopo-instance-meshes` and legacy `polyforge-instance-meshes` sidecars are accepted at version 1;
native PCG JSON similarly accepts `topotopo-points` and `polyforge-points` at version 1.

The imports and level changes remain **unsaved**. Review them, then save explicitly. Placement is an editor transaction; imported Content Browser assets are not part of that actor undo transaction. A failed Interchange import may leave completed assets unsaved, and the failure log says so. Input streams, prototype files, destination, and optional heightmap layout are validated before asset import; the level is changed only after successful mesh import and name checks.

## Landscape support and limits

Landscape import uses the exported UE 5.8 C++ APIs `FLandscapeImportHelper::GetHeightmapImportDescriptor`, `GetHeightmapImportData`, and `ALandscape::Import`, linked against `LandscapeEditor` and `Landscape`. Version 1 `topotopo-unreal-landscape` and legacy `polyforge-unreal-landscape` bundles require `exact_fit=true`, a matching component layout, and at most 8193 samples per side. Tiled version 2 adds the path below; single-heightmap import is unchanged.

### Tiled version 2 bundles

Generate the demo with `npm run export:demo -- --tiles 2` and import its bundle:

```text
TopoTopo.ImportScene "C:/path/to/topotopo/out/unreal_demo_tiled/landscape" /Game/TopoTopo/TiledDemo landscape=1 layers=1 material=1 objects=1
```

The exporter option `tile_size` is **quads per tile**, with zero retaining v1. Each tile file has
`tile_size + 1` samples in each direction, including the shared border. The manifest's `tile_grid` contains
`tile_size_quads`, `grid`, `source_resolution`, `padded_resolution`, and `padding:{right,bottom,mode:"edge"}`.
The row-major `tiles` array records `grid_position`, inclusive `sample_min`/`sample_max`,
`world_offset_cm` relative to `landscape.actor_location_cm`, a `heightmap` object with the shared height
range, weight `layers`, and `instances:{csv,count,meshes}` (or null). All paths are bundle-root-relative;
the mesh sidecar is shared at `instances.meshes.json`. Padding extends only right/bottom by repeating the
source edge. Root `landscape.overall_resolution` is the padded grid; the retained root PNG is the original
source-sized heightmap and is not used by the tiled importer.

Before creating assets, the importer validates tile-grid coverage, component alignment, ranges, offsets,
padding and layer order/encoding, then checks every shared height and weight sample for exact equality.
It assembles one full height/weight grid and calls `ALandscape::Import` with all components. In a World
Partition level it then calls `ULandscapeSubsystem::ChangeGridSize` with the number of components per
tile, following the native New Landscape panel's import route. This moves each tile's components to one
`ALandscapeStreamingProxy`, sharing the parent Landscape's GUID, layer infos and generated material. A
plain level keeps all components on its single Landscape; no streaming proxies or sublevels are added.
This command does not change the level's partition setting. Epic documents
[tiled heightmap import](https://dev.epicgames.com/documentation/unreal-engine/importing-and-exporting-landscape-heightmaps-in-unreal-engine)
and the underlying [Landscape import API](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Landscape/ALandscapeProxy/Import).

For tiles of 253/1009/2017 samples, use 63 quads per section and 2 x 2 sections per component, giving
2 x 2/8 x 8/16 x 16 components respectively. 127 quads per section cannot exact-fit 1009/2017 samples;
see Epic's [recommended sizes table](https://dev.epicgames.com/documentation/unreal-engine/landscape-technical-guide-in-unreal-engine).
The tiled importer supports individual files up to 8193 samples and an assembled padded grid up to
32769 samples per side. It holds full arrays during native import. At 16K x 16K, UE 5.8 allocates roughly
6 GiB for its normal buffer alone, plus masks, heights and textures; tiling does not guarantee a small
peak import memory footprint. Large terrains have not been performance-tested yet.
The standard TopoTopo heightfield nodes still enforce a 4097 x 4097 total-sample budget; this work does
not raise that generation limit or establish 16K generation. The exporter uses dense source arrays and
keeps both global and tiled output bytes in memory.

Each tile has an independent `TopoTopo_<set>_Tile_<x>_<y>` actor, with a HISM component per used prototype.
It reads that tile's CSV using the shared mesh mapping and preserves world transforms. The tile streams
must contain the exact global stream's mesh/transform multiset and the declared per-tile counts. Actors
are spatially loaded, with no Landscape references or parent attachment: they can stream independently
under the level's configured runtime grid. Instance bounds may span multiple runtime cells; one tile
actor does not force the same unload moment as its terrain proxy. The ordinary scene actor still holds
unpartitioned road/ordinary objects. Tile splitting applies even with `landscape=0`.

Layer-info assets and the material are created once for the whole Landscape. Because there is no single
padded height/weight source file, tiled imports leave one-file reimport paths empty instead of recording
the first tile as the full Landscape source. Regenerate with a fresh bundle and new content destination.
Assets and level changes remain unsaved for review, including World Partition's external actor packages.

Weightmaps are decoded as 8-bit greyscale PNGs (with or without alpha; alpha is ignored) and passed in manifest
order as `FLandscapeImportLayerInfo::LayerData` to the same `ALandscape::Import` call as the heightmap, using
`ELandscapeImportAlphamapType::Additive`. UE 5.8 writes these into the default Landscape edit layer through
its internal `FLandscapeEditDataInterface::SetAlphaData` path. The plugin adds target-layer assignments before
import so source paths and all-zero layers remain represented. It does not use the generic weightmap
descriptor decoder, which does not cover the greyscale-plus-alpha fixture.

Each layer-info asset uses `SetBlendMethod(ELandscapeTargetLayerBlendMethod::None, false)`, UE 5.8's replacement
for `bNoWeightBlend`, so overlapping input masks keep their original byte values instead of being
renormalized against one another during import or painting. This paint-layer setting is separate from the
material's **LB_WeightBlend** inputs. `sediment` and `debris` are already normalised in the exported demo:
their **PNG range 0..255 represents the normalised layer**, not the original physical min/max values recorded
in `landscape.json`. Import uses the PNG as written; it neither rescales it again nor reverses that normalization.

The generated material has Landscape Layer Blend inputs for colour and roughness, with every imported
name in manifest order and `LB_WeightBlend` selected. It normalizes overlapping contributions in the shader
and fills uncovered regions with grass, without modifying stored weights. A constant tangent-space normal
`(0,0,1)` follows the Landscape geometry. The demo palette is:

| Layers | Appearance |
|---|---|
| `mask`, `grass`, `trees` | Grass greens; `mask` is the primary base layer. |
| `rock` | Grey rock. |
| `sediment`, `debris` | Sandy tan. |
| `flow`, `water` | Dark blue wet areas, with lower roughness. |
| `road` | Dark asphalt. |
| `path` | Beige dirt. |

The normal and per-layer roughness are intentionally simple; this is an editable demo material, without
textures or production terrain features. Graphs use the public `UMaterial` expression collection and
editor-only material data APIs directly; a `MaterialEditor` module dependency is not required. Select the
Landscape, replace **Landscape Material** in Details
with your own material or instance, and retain the imported names to reuse the existing target-layer
assignments and weights. New names need their own infos under Landscape Paint > Target Layers. You can
also edit the generated material directly. Review shader compilation and appearance, then explicitly save
the material, layer infos and level. Runtime virtual textures, Nanite Landscape and foliage remain out of scope.

For a v1 manual heightmap import, use Landscape mode > Manage > New > Import from File, select `heightmap.png`, and copy `landscape.section_size_quads`, `sections_per_component`, `components`, `scale`, and **new_landscape_location_cm** from `landscape.json`. The editor centers the terrain on that location; its actor subsequently resides at **actor_location_cm**. V2's nested tile directories are consumed by this plugin; do not import only the original root PNG using the padded grid settings.

## PCG after import

Set a **TopoTopo Point Stream** node's file to the same `instances.csv`, coordinate mode to `AsWritten`, and mesh folder to `/Game/TopoTopo/PluginDemo/Meshes`. Its `Mesh` metadata retains the source names; `MeshPath` provides the resolved asset paths. Connect to the instance-spawner workflow in [README.md](README.md). The resulting graph is an alternative to the HISM actor placed by this utility; generate it in a separate level or remove the utility actor first to avoid double placement.

For automation, supply `-TopoTopoDemoCSV="<absolute path>/instances.csv"` at editor startup and run
`Automation RunTests TopoTopo.PCG.GraphSpawns536`. It builds and runs the two-node graph in an isolated test
world, waits for PCG generation across automation frames (60-second timeout), checks 536 output points and
the five component counts/first pine transform, then cleans up. It can use the existing PluginDemo meshes
without modifying the imported scene. Missing meshes produce an explicit `SKIPPED` warning, which is not
PCG acceptance; missing CSV fails. Full test names and expected outcomes are in [README.md](README.md#automation-and-editor-checks).

Run `Automation RunTests TopoTopo.Editor.WeightLayers` to import the terrain into a separate transient
editor world with layers and material enabled. It checks ten layer infos, all PNG weight bytes and means
(within 2%), and the material's complete named weight-blend inputs and connected surface outputs. It needs
only the bundle, not previously imported meshes. Locate it with the same CSV option/environment variable,
or `-TopoTopoDemoBundle="<absolute bundle directory>"` / `TOPOTOPO_DEMO_BUNDLE`. An absent manifest gives an
explicit **SKIPPED** warning; rerun with the bundle for acceptance. A malformed or incomplete present
bundle fails. The test creates no persistent assets and does not change or save the current level.

`Automation RunTests TopoTopo.Editor.TiledLandscape` runs three self-contained tests with synthetic
2 x 2 tiles of 8 x 8 samples (15 x 15 assembled), known height/weight functions and 1/2/3/4 cube instances
per tile. `Plain` expects four parent components and no proxies; `WorldPartition` expects four proxies,
no parent components, one shared Landscape GUID/material/layer info, exact vertex heights/weights at all
seams, and four independent spatial HISM actors with ten unchanged world transforms in total.
`Validation` rejects malformed seams, shared ranges, tile positions, padding and stream counts. Fixtures
are generated during the tests; they need no demo import and never skip. Run these in the editor after
installing the package; BuildPlugin compilation alone is not an editor pass or runtime-streaming proof.

This utility supports this exported bundle layout, not an arbitrary glTF scene: it places ordinary objects from `objects_static.glb` (all of its meshes) or, in older bundles, from `objects_expanded.glb` (only names absent from the instance stream), and does not depend on `EXT_mesh_gpu_instancing` support. Each prototype must contain one named mesh (multiple material slots are fine). Mesh paths may be overridden in the PCG node for existing project assets. Imported assets retain Interchange's glTF material interpretation; runtime visual acceptance still requires checking the result in the editor.
