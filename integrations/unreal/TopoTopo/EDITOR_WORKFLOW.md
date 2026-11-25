<!-- Copyright 2026 faxcorp, Apache-2.0 -->
# Import a TopoTopo scene in Unreal Editor

Install **TopoTopo** with `topotopo unreal setup` and open the editor. The plugin provides **Tools > Import TopoTopo scene** and the equivalent console command below. Use them in the current level outside Play or Simulate mode.

In the `.uproject` `Plugins` array, use `{"Name":"TopoTopo","Enabled":true,"SupportedTargetPlatforms":["Win64"]}`.
Setup writes this entry by default. Close the editor before replacing the plugin.

Run `npm run export:demo` in the repository to export `examples/unreal_landscape.json` into `out/unreal_landscape/landscape/`. This folder contains `instances.csv`, `instances.meshes.json`, six `meshes/*.glb` prototypes, `objects_static.glb`, `heightmap.png`, `landscape.json`, and three `layers/*.png` weightmaps.

Open an empty level and choose a fresh destination such as `/Game/TopoTopo/PluginDemo`. In the Tools dialog, paste the absolute path to `out/unreal_landscape/landscape`, set the destination, and optionally select Landscape import. Its weight-layer and generated-material checkboxes default on and become available when Landscape import is selected. The bundle path may also be relative to the Unreal project directory.

The command for the repository's demo bundle, entered in the Unreal Output Log console, is:

```text
TopoTopo.ImportScene "<repository>/out/unreal_landscape/landscape" /Game/TopoTopo/PluginDemo landscape=1 layers=1 material=1 objects=1
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
- **Objects/**: Interchange imports `objects_static.glb` with mesh combination disabled. For older bundles with only `objects_expanded.glb`, the utility validates expected prototype names and places only ordinary meshes such as `road`.
- **TopoTopo_PluginDemo**: one actor with a HISM component per prototype, populated from CSV world transforms. The demo has **1,418 instances** in **six prototype components** (pine 373, fir 333, oak 499, boulder 71, slab 63, stone 79). With `objects=1`, an additional component places the road at the identity transform.
- **TopoTopo_PluginDemo_Landscape** (optional): one Landscape from the 16-bit heightmap. It has 253 x 253 samples, 63 quads per section, 2 x 2 sections per component, and 2 x 2 components. The actor corner is `(-12600, -12600, 2006.4552)` cm, scale `(100, 100, 7.742521)`. Its XY extent is -12600 to +12600 cm. Use `(0, 0, 2006.4552)` as the centered location in the manual import panel.
- **Landscape/LI_*** (`landscape=1 layers=1`): `ULandscapeLayerInfoObject` assets for every manifest layer,
  assigned to the Landscape with their PNG weights. The demo assigns `LI_rock`, `LI_grass`, and `LI_road` in that order.
- **Landscape/M_TopoTopo_PluginDemo** (`landscape=1 material=1`): generated material assigned to the
  Landscape. The final destination folder supplies the set name in `M_TopoTopo_<set>`; all four demo
  Landscape assets live under `/Game/TopoTopo/PluginDemo/Landscape/`.

The first oak is at approximately `(669.61, 9904.88, 147.66)` cm with yaw `5.98` degrees and uniform scale `1.157`. Read the CSV in `AsWritten` mode to use its Unreal axes and units.

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
TopoTopo.ImportScene "<repository>/out/unreal_landscape_tiled/landscape" /Game/TopoTopo/TiledDemo landscape=1 layers=1 material=1 objects=1
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
The standard TopoTopo heightfield nodes enforce a 4097 x 4097 total-sample budget. The exporter uses dense source arrays
and keeps both global and tiled output bytes in memory.

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
material's **LB_WeightBlend** inputs. If a source layer has values outside 0 to 1, the exporter normalises it to 0 to 255.
The importer uses the stored PNG bytes.

The generated material has Landscape Layer Blend inputs for colour and roughness, with every imported
name in manifest order and `LB_WeightBlend` selected. It normalizes overlapping contributions in the shader
and fills uncovered regions with grass, without modifying stored weights. A constant tangent-space normal
`(0,0,1)` follows the Landscape geometry. The demo palette is:

| Layers | Appearance |
|---|---|
| `rock` | Grey rock. |
| `grass` | Grass green. |
| `road` | Dark asphalt. |

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
`Automation RunTests TopoTopo.PCG.GraphSpawnsDemo`. It builds and runs the two-node graph in an isolated test
world, waits up to 60 seconds, and checks 1,418 output points, six component counts and the first oak transform.
It uses the PluginDemo meshes. If it reports missing meshes, import the new demo and rerun. Missing CSV fails.
See [Editor tests](README.md#editor-tests) for startup arguments.

Run `Automation RunTests TopoTopo.Editor.WeightLayers` to import the terrain into a separate transient
editor world with layers and material enabled. It checks three layer infos, exact PNG weight bytes and the
material's named weight-blend inputs and connected surface outputs. Pass the same CSV option or set
`-TopoTopoDemoBundle="<absolute bundle directory>"` or `TOPOTOPO_DEMO_BUNDLE`. If the manifest is absent,
supply the bundle and rerun.

`Automation RunTests TopoTopo.Editor.TiledLandscape` verifies the tiled demo manifest, shared borders and CSV
partition. Pass `-TopoTopoDemoTiledBundle="<absolute tiled bundle directory>"` or `TOPOTOPO_DEMO_TILED_BUNDLE`.
It also runs three self-contained tests using synthetic
2 x 2 tiles of 8 x 8 samples (15 x 15 assembled), known height/weight functions and 1/2/3/4 cube instances
per tile. `Plain` expects four parent components and no proxies; `WorldPartition` expects four proxies,
no parent components, one shared Landscape GUID/material/layer info, exact vertex heights/weights at all
seams, and four independent spatial HISM actors with ten unchanged world transforms in total.
`Validation` rejects malformed seams, shared ranges, tile positions, padding and stream counts. Fixtures
are generated during the tests. Run these in an editor with the plugin enabled.

This utility supports this exported bundle layout, not an arbitrary glTF scene: it places ordinary objects from `objects_static.glb` (all of its meshes) or, in older bundles, from `objects_expanded.glb` (only names absent from the instance stream), and does not depend on `EXT_mesh_gpu_instancing` support. Each prototype must contain one named mesh (multiple material slots are fine). Mesh paths may be overridden in the PCG node for existing project assets. Imported assets retain Interchange's glTF material interpretation; runtime visual acceptance still requires checking the result in the editor.
