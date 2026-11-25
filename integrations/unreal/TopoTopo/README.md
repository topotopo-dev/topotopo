# TopoTopo for Unreal Engine 5.8

TopoTopo imports `.topo` packages, loads point streams for PCG, and places Landscapes and scenes.

## Install

Install Node.js 22.18 or newer, TopoTopo (`npm install -g topotopo`) and the Visual Studio C++ toolchain.
Close the editor and run:

```text
topotopo unreal setup <project folder or .uproject>
```

Setup copies the plugin source to `Plugins/TopoTopo/`, enables it for Win64, and configures Auto Reimport and `.gitignore`.
It removes earlier plugin installs made by TopoTopo and their project entries. Open the project and let Unreal build the
plugin when prompted. PCG and Interchange are plugin dependencies. Run setup again after updating TopoTopo.

## Import a `.topo` package

Put the whole package in its own folder under the project's `Content/`, for example `Content/props/props.topo`.
Accept the Auto Reimport prompt or import the `.topo` from the Content Browser. The package asset shows each output's
status. Outputs go to `outputs/<output id>/` beside the package. Use a distinct destination for each package.

| Output | Unreal assets |
|---|---|
| Mesh | Static Mesh with materials, textures, LODs and sockets. A piece named `<name>-convcolonly` becomes convex collision. |
| Instances | Prototype Static Meshes, a **TopoTopo Instances** asset, and a PCG Data Asset with `MeshPath` metadata. Drag the Instances asset into a level to place hierarchical instanced meshes. |
| Points | A PCG Data Asset with the stream's point attributes. |
| Textures | One Texture per image. |
| Terrain or scene with a heightfield | A bundle on disk. Use **Place Terrain in Level** on the package asset. |

In a PCG graph, use **Load Data Asset** to load an imported `<id>_Points` asset. A **TopoTopo Instance Spawner** uses
`MeshPath` to choose the mesh. To turn a placed Instances actor into a Blueprint, use **Convert Selection to Blueprint Class**.

Auto Reimport tracks changes to `.topo`. **Editor Preferences > Plugins > TopoTopo > Live Cook** also tracks graphs,
inputs and assets while the editor is open. Right-click the package to **Reimport** or **Recook**, or run `TopoTopo.CookAll`
in the console to import missing package assets and start a cook for each package. A failed output keeps its last good
assets and reports the error on the package and in the TopoTopo Message Log.

Edit **Output Folder**, **Per Output Folders**, **Skip Outputs** and **Instance Mode** on the package asset. Commit the
package, `.uasset` files and `<package>/.topotopo/unreal.json`. Keep the intermediate files in `Saved/TopoTopo/` local.
Run `topotopo unreal status <project> --strict` to check package freshness and Auto Reimport exclusions.

## Place terrain

Right-click a package asset with a terrain output and choose **Place Terrain in Level**. The heightfield must fit
Unreal's component grid. Common sizes are 127, 253, 505, 1009, 2017 or 4033 samples per side. Use `heightfield_resample`
to fit the grid. The plugin imports height, paint weights and a starter material. When the package publishes terrain
separately, placement also adds its mesh and instance outputs. Re-place the ground after its height or paint weights
change. The [editor workflow](EDITOR_WORKFLOW.md) describes weight layers and tiled imports.

## Without a window (CI)

After `topotopo unreal setup`, build the Editor target using `Build.bat` from the engine's `Engine/Build/BatchFiles/` folder.

```text
Build.bat <Project>Editor Win64 Development -Project="<project>.uproject" -WaitMutex -NoHotReloadFromIDE
```

Put the package folder under `Content/` and use an existing map, such as `/Game/Maps/Empty`.

```text
UnrealEditor-Cmd.exe <project>.uproject <map> -unattended -nosplash -RenderOffscreen -ExecCmds="TopoTopo.CookAll,TopoTopo.PlaceTerrain <package> save,QUIT_EDITOR"
```

`CookAll` reports each package and finishes all its cooks and imports before the next command runs, then prints the
counts. `PlaceTerrain` accepts an asset name or a path such as `/Game/Terrain/terrain`. Omit the package to place all
packages with terrain. `save` saves the level and the assets made by placement; the map must have been saved before.
Place the terrain once: each `PlaceTerrain` adds a new set. On later starts `TopoTopo.CookAll` alone updates the placed
road and instances; place the ground again only after its heights or paint weights change.

Use `QUIT_EDITOR` to exit. `quit` hangs the offscreen editor. To run Python, use `-ExecCmds="py <file>"` with the
Python Editor Script Plugin enabled. To change a graph's values before the next start, edit the values in the graph's
`vars` block. The defaults in `params` describe its controls.

## Read a point stream in PCG

1. Add **TopoTopo Point Stream** to a PCG graph. Set **File Path** to the CSV or `points.json` file. Relative paths start
   at the project directory.
2. Set **Coordinate Mode** to **AsWritten** for Unreal PCG CSV, which already uses Z-up centimetres. For native TopoTopo
   point streams, use **FromTopoTopoYUp** to convert Y-up metres into Unreal coordinates.
3. Set **Mesh Folder** to the prototype assets' content folder if the stream has an `instances.meshes.json` sidecar.
   Each `Mesh` name resolves to `<Mesh Folder>/<name>.<name>`. Use **Mesh Mapping** to select assets explicitly.
4. Connect **Out** to **TopoTopo Instance Spawner > In** and connect the spawner to the graph's **Output**. Assign the
   graph to a PCG component and Generate. The stream supplies world transforms. Regenerate to load edits to the file.

The spawner is Unreal's Static Mesh Spawner with its selector set to `MeshPath`. Point Stream also feeds PCG filters and
attribute operations. **Attribute Include/Exclude** filter metadata by exact name. Density, colour and seed use native
PCG properties. For a runtime build, include referenced meshes in the cook, for example with **Additional Asset Directories to Cook**.

## Import a scene bundle

From the repository, run `npm run export:demo` to export `examples/unreal_landscape.json` into `out/unreal_landscape/`.
The `landscape/` bundle contains a 253 × 253 heightmap, `rock`, `grass` and `road` weightmaps, the road mesh, and 1,418
instances of six prototype meshes. Run `npm run export:demo -- --tiles 2` for the 2 × 2 bundle in `out/unreal_landscape_tiled/`.

In an empty level, choose **Tools > Import TopoTopo scene**, give it the absolute bundle path and choose a fresh destination
under `/Game/TopoTopo/`. Enable Landscape import to place terrain. The equivalent Output Log console command is:

```text
TopoTopo.ImportScene "<repository>/out/unreal_landscape/landscape" /Game/TopoTopo/PluginDemo landscape=1 layers=1 material=1 objects=1 lighting=1
```

The plugin imports prototype meshes under `Meshes/` and uses the CSV to place instances. With `objects=1` it also places
ordinary meshes such as the road. `lighting=1` adds preview lighting where the level is missing it. Review and save the
assets and level. See [the editor workflow](EDITOR_WORKFLOW.md) for the import options and the World Partition path.

## Editor tests

Export both bundles and import the single Landscape bundle to `/Game/TopoTopo/PluginDemo` before running the PCG graph test.
The test uses the six meshes under `Meshes/`. For an installed copy of the plugin, start the editor with:

```text
-TopoTopoDemoCSV="<repository>/out/unreal_landscape/landscape/instances.csv"
-TopoTopoDemoBundle="<repository>/out/unreal_landscape/landscape"
-TopoTopoDemoTiledBundle="<repository>/out/unreal_landscape_tiled/landscape"
```

Run `Automation RunTests TopoTopo` in the Output Log, or filter for `TopoTopo` in Session Frontend > Automation.
The point-stream and PCG graph tests check 1,418 points and the first oak transform. The PCG graph also checks six ISM/HISM
components and their instance counts. `TopoTopo.Editor.WeightLayers` checks the ordered layers, exact imported weight
bytes and material wiring. `TopoTopo.Editor.TiledLandscape` covers the tiled bundle and synthetic plain-level, World
Partition and validation cases. If a test reports `SKIPPED`, supply its bundle or meshes and rerun it.

See the [cook protocol](../PROTOCOL.md) for the CLI contract.
