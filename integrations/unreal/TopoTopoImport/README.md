# TopoTopo Import for Unreal Engine 5.8

Makes a TopoTopo package a source asset. Put a package's folder in `Content/`, and its `<id>.topo` imports like any other
source file: TopoTopo cooks the package's published outputs and they arrive as ordinary Unreal assets. Change the package,
and Auto Reimport brings them up to date.

## Install

You need [Node.js](https://nodejs.org) 22.18 or newer, [TopoTopo](https://topotopo.dev) (`npm install -g topotopo`), and Visual
Studio with its C++ toolchain, because the plugin ships as source. With the editor closed:

```bash
topotopo unreal setup <your project folder>
```

That copies the plugin to `Plugins/TopoTopoImport/`, enables it in the `.uproject`, records where TopoTopo is, excludes
TopoTopo's working folders from Auto Reimport (in `Config/DefaultEditorPerProjectUserSettings.ini`), and adds the cooked
files to `.gitignore`. Open the project and let Unreal build the plugin when it asks. Add `--with-pcg` to also install
TopoTopoPCG, which places terrain in a level. Run it again after updating TopoTopo.

## Import a package

Put the package in a folder of its own inside `Content/`, such as `Content/props/props.topo`, and answer yes when
Auto Reimport offers to import it. Or use Import in the Content Browser and choose the `.topo`. A package outside `Content/`
is refused: its graphs and inputs must stay beside its manifest.

You get a **TopoTopo Package** asset, which holds the import options and what happened to each output. By default, each
output's assets go to `outputs/<output id>/` beside the package.

| Output kind | What you get |
|---|---|
| mesh | A Static Mesh with its materials and textures (in `Materials/` and `Textures/`), `_lod<n>` pieces as its LODs, `scene_null` points as sockets tagged `TopoTopo` |
| instances | One Static Mesh per packed source in `Meshes/`, a **TopoTopo Instances** asset, and a PCG Data Asset (`<id>_Points`) with one point per instance |
| points | A PCG Data Asset (`<id>_Points`); every column becomes an attribute |
| textures | One Texture per image |
| terrain, or a scene with a heightfield | A landscape bundle kept on disk. **Place Terrain in Level** on the package brings it in through TopoTopoPCG |
| curves, material, volume | Not imported yet. The package asset lists them under Skipped, with why |

Levels use these assets, never the package asset, which stays in the editor. Drag a TopoTopo Instances asset into a level to
place it as hierarchical instanced static meshes. In a PCG graph, read `<id>_Points` with a Load Data Asset node; its
`MeshPath` attribute names each point's mesh for a Static Mesh Spawner.

Axes are converted the same way everywhere: Unreal X is TopoTopo x, Y is z, Z is y, in centimetres.

## How reimport works

- **The `.topo` changes**: Auto Reimport (Editor Preferences > Loading & Saving) reimports the package with a progress dialog.
- **A graph, input or asset changes**, from the viewer, an agent or by hand: the plugin cooks in the background and imports
  when the editor is free, not during Play. The same happens at startup for what changed while the editor was closed. Turn it
  off under Editor Preferences > Plugins > TopoTopo > Live Cook; it also follows Monitor Content Directories.
- **By hand**: Reimport on the package asset, or Recook to cook every output again from scratch. `TopoTopo.CookAll` in the
  console does every package.

Only what changed is cooked, and only what was cooked differently is imported. Assets are updated where they are, so levels
keep their references, and instance actors in open levels rebuild.

When an output fails, its last good assets stay. The error is on the package asset and in Window > Message Log > TopoTopo, as
`TopoTopo: <package> > <output>: [<node>] <message>`. Assets of an output that no longer exists stay too, in case a level uses
them, and the package asset lists their files under Orphans.

## What to commit

Commit the package and the `.uasset` files, including the record `<package>/.topotopo/unreal.json`. Cooked files stay out of
the repository: they live in `Saved/TopoTopo/`, and a checkout without them is still current.

```bash
topotopo unreal status <your project folder> --strict
```

That exits 1 when a package is stale, failed or never cooked, or when Auto Reimport can still see TopoTopo's folders, so it fits CI.

## Options

On the package asset, written to `<id>.topo.import` beside the manifest, and cooked as soon as you change them:

- **Output Folder**: relative to the package, or a content path such as `/Game/Props`
- **Per Output Folders**: each output in a folder of its own
- **Skip Outputs**: output ids not to cook, comma-separated
- **Instance Mode**: Instanced, or Expand to merge real copies into one Static Mesh

Editor Preferences > Plugins > TopoTopo sets where TopoTopo and Node.js are, when they are not found by themselves, the Live
Cook switch and the cook timeout.

Assets are not deleted, and placed terrain does not follow a reimport: place it again. Packages in a plugin's `Content/` import
and cook, but Auto Reimport watches only `/Game/` unless you add the plugin's folder to its list.

The contract between this plugin and the command line is [PROTOCOL.md](../PROTOCOL.md).
