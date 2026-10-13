<!-- Copyright 2026 faxcorp, Apache-2.0 -->
# Import a TopoTopo scene in Unreal Editor

Enable **TopoTopoPCG**, **PCG**, and **Interchange Framework**, then restart the editor yourself after installing the built plugin. The plugin provides **Tools > Import TopoTopo scene** and the equivalent editor console command below. These operations run in the current level, outside Play/Simulate mode.

Run `npm run export:demo` in the repository to produce `out/unreal_demo/landscape/`. This folder contains `instances.csv`, `instances.meshes.json`, five `meshes/*.glb` prototypes, `objects_expanded.glb`, `heightmap.png`, and `landscape.json`.

Open a disposable empty level in the intended project. Use a **new, empty** destination such as `/Game/TopoTopo/PluginDemo`; the existing manually verified `/Game/TopoTopo/Demo` is separate. In the Tools dialog, paste the absolute path to `out/unreal_demo/landscape`, set the destination, and optionally select Landscape import. The bundle path may also be relative to the Unreal project directory.

The exact command for this worktree, entered in the Unreal Output Log console, is:

```text
TopoTopo.ImportScene "C:/WORK/polyforge/.claude/worktrees/codex-kernels/out/unreal_demo/landscape" /Game/TopoTopo/PluginDemo landscape=1 objects=1
```

`landscape=0` skips terrain (the default). `objects=0` skips `objects_expanded.glb`; `objects=1` is the default. Unknown options are errors. The destination must be below `/Game/TopoTopo/` and contain no existing assets, including subfolders. To repeat an import, choose another set name; the utility does not overwrite assets or clear an earlier level import.

## What the command creates

- **Meshes/**: each sidecar prototype GLB imports through Interchange as one named Static Mesh with its material slots. Without the sidecar, `meshes/*.glb` filenames supply the mesh names. Import is stopped if a prototype produces multiple meshes or loses its expected name. Exact `Mesh -> asset path` entries are printed in `LogTopoTopoImport`.
- **Objects/**: Interchange imports the expanded GLB with mesh combination disabled, preserving per-name splits and materials. Expanded copies of any instanced prototypes are reference assets only. The utility places only ordinary meshes absent from the prototype list, such as `road`. It checks that the used prototype names survive the expanded import before placing anything, so unexpected importer renaming cannot silently duplicate the trees/rocks.
- **TopoTopo_PluginDemo**: one actor with a HISM component per prototype, populated from CSV world transforms. The demo has **536 instances** in **five prototype components**: pine 117, fir 81, oak 94, rock_a 119, rock_b 125. With `objects=1`, one additional HISM component has the ordinary road at the identity transform. The expanded pine/fir/oak/rock meshes are not placed.
- **TopoTopo_PluginDemo_Landscape** (optional): one Landscape from the 16-bit heightmap. It has 253 x 253 samples, 63 quads per section, 2 x 2 sections per component, and 2 x 2 components. The actor corner is `(-6300, -6300, 1169.3223)` cm, scale `(50, 50, 4.603792)`. Its XY extent is -6300 to +6300 cm. The UI's centered location `(0, 0, 1169.3223)` is not the actor corner.

The first pine transform is approximately position `(3740.24, -6233.69, 396.10)` cm, yaw `-105.95` degrees and uniform scale `2.029`. The CSV is already converted to Unreal axes and units; it is read in `AsWritten` mode. No second Y/Z swap or metre-to-centimetre scaling is applied.

The imports and level changes remain **unsaved**. Review them, then save explicitly. Placement is an editor transaction; imported Content Browser assets are not part of that actor undo transaction. A failed Interchange import may leave completed assets unsaved, and the failure log says so. Input streams, prototype files, destination, and optional heightmap layout are validated before asset import; the level is changed only after successful mesh import and name checks.

## Landscape support and limits

Landscape import uses the exported UE 5.8 C++ APIs `FLandscapeImportHelper::GetHeightmapImportDescriptor`, `GetHeightmapImportData`, and `ALandscape::Import`, linked against `LandscapeEditor` and `Landscape`. The importer accepts version 1 `topotopo-unreal-landscape` bundles whose `exact_fit` is true, whose heightmap matches the component layout, and whose dimensions are at most 8193 samples per side. It imports one heightfield; tiled/streaming proxy setup is not implemented.

Terrain material assignment and `layers/*.png` weightmaps remain manual: create a Landscape material with the desired Landscape Layer Blend names, assign it, create target layer info assets, and import the corresponding PNG under Landscape Paint > Target Layers. The importer does not invent terrain materials or interpret normalized layer ranges.

For manual heightmap import, use Landscape mode > Manage > New > Import from File, select `heightmap.png`, and copy `landscape.section_size_quads`, `sections_per_component`, `components`, `scale`, and **new_landscape_location_cm** from `landscape.json`. The editor centers the terrain on that location; its actor subsequently resides at **actor_location_cm**.

## PCG after import

Set a **TopoTopo Point Stream** node's file to the same `instances.csv`, coordinate mode to `AsWritten`, and mesh folder to `/Game/TopoTopo/PluginDemo/Meshes`. Its `Mesh` metadata retains the source names; `MeshPath` provides the resolved asset paths. Connect to the instance-spawner workflow in [README.md](README.md). The resulting graph is an alternative to the HISM actor placed by this utility; generate it in a separate level or remove the utility actor first to avoid double placement.

This utility supports this exported bundle layout, not an arbitrary glTF scene: it deliberately uses `objects_expanded.glb` and does not depend on `EXT_mesh_gpu_instancing` support. Each prototype must contain one named mesh (multiple material slots are fine). Mesh paths may be overridden in the PCG node for existing project assets. Imported assets retain Interchange's glTF material interpretation; runtime visual acceptance still requires checking the result in the editor.
