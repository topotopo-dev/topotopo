# The TopoTopo cook protocol for the Unreal plugin

This is the contract between the TopoTopo command line and the Unreal plugin (`TopoTopoImport/`). The cook is the one the
Godot addon uses, so [the Godot protocol](../godot/PROTOCOL.md) defines the jobs file, the progress lines, the report, the
record and freshness; this page says what differs for Unreal. Protocol version **1**, record schema **1**. TopoTopo's side
is `src/host/cook.ts`, `src/host/cook-command.ts` and `src/host/unreal.ts`; its tests are `test/unreal.ts`.

## Finding TopoTopo

As for Godot, with Editor Preferences > Plugins > TopoTopo in place of Godot's editor settings. The CLI: `TOPOTOPO_CLI`; the
TopoTopo Path setting; `node_modules/topotopo/dist/cli.js` in the project folder or a folder above it; `"install".cli` in the
user's config (`~/.topotopo/config.json`, or the file `TOPOTOPO_CONFIG` names), which `topotopo unreal setup` writes;
`topotopo.cmd` / `topotopo` on `PATH`. Node: `TOPOTOPO_NODE`; the Node Path setting; `"install".node`; `node` on `PATH`; then
`C:/Program Files/nodejs`, `/usr/local/bin`, `/opt/homebrew/bin` and `/usr/bin`. Node 22.18 or newer runs TopoTopo.

## Commands

```text
topotopo cook <.topo | package folder | folder>... --for unreal [--into </Game/folder>] [--flat] [--skip a,b] [--instancing packed|expand] [--force] [--no-cache] [--timeout <s>] [--report <file>] [--progress json] [--quiet]
topotopo cook --jobs <jobs.json> [--force] [--no-cache] [--progress json]
topotopo unreal setup <unreal project folder or .uproject> [--no-enable] [--with-pcg]
topotopo unreal status <unreal project folder or .uproject> [--strict] [--json]
```

The plugin runs `<node> <cli> cook --jobs <jobs.json> --progress json`, adding `--force --no-cache` for Recook, with the jobs
file and the report under `Saved/TopoTopo/reports/`:

```json
{"for": "unreal", "protocol": 1,
 "jobs": [{"package": "C:/game/Content/props/props.topo", "report": "C:/game/Saved/TopoTopo/reports/props-1f2e3d4c.json", "timeout": 600}]}
```

`into` in a job and `--into` take a content path (`/Game/...`) or an absolute folder under `Content/`. A jobs file without
`"for"` means Godot, so the plugin always writes it. Exit codes are Godot's. Exit 2 means a package outside `Content/` or a
plugin's `Content/`, a package directly in `Content/`, a published copy, or a folder name Unreal refuses in a content path.

## The import options

`<id>.topo.import` under `[params]`, with Godot's keys: the plugin writes it from the package asset's options, and the cook
reads it. `outputs/folder` is relative to the package folder or a content path. The options as the record holds them, where
`folder` is a normalised content path:

```json
{"folder": "/Game/props/outputs", "instancing": "packed", "per_output_folders": true, "skip": ["kit"]}
```

## Output files

Assets are the plugin's business; a cook writes intermediate files, below the project, at the content path of the output's
folder under `Saved/TopoTopo/`. Everything there belongs to the cook. For the option above, an output `crate` goes in
`Saved/TopoTopo/Game/props/outputs/crate/`:

| kind | files |
|---|---|
| mesh | `<id>.glb`; prims named `*_lod<n>` split into `<id>.glb` and `<id>_lod<i>.glb`; `<id>.sockets.json` when it has `scene_null` points |
| instances | `<id>.instances.csv`, `<id>.instances.meshes.json`, `<id>_meshes/<source>.glb`, and `<id>.glb` for any plain meshes beside them |
| points | `<id>.points.csv` |
| textures | one PNG per image |
| terrain | the `unreal_landscape` bundle: `landscape.json`, `heightmap.png`, `heightmap.json`, `layers/*.png`, ... |
| scene | by what it holds: with a heightfield a terrain bundle, else as mesh and instances |
| curves, material, volume | none: skipped, with why |

The GLB is y up, in metres, with materials and embedded images, and uncompressed. A GLB that would require an extension
Interchange does not read fails that output and writes nothing. The CSVs have the PCG columns in Unreal axes and centimetres:
X = x, Y = z, Z = y, with rotation as a rotator. Sockets use the same axes:

```json
{"format": "topotopo-sockets", "version": 1, "units": "centimetres, Unreal axes X = x, Y = z, Z = y",
 "sockets": [{"name": "handle", "location": [0, 0, 120], "rotation": {"pitch": 0, "yaw": 0, "roll": 0}, "scale": [1, 1, 1]}]}
```

The record is `<package>/.topotopo/unreal.json`, committed. It names files relative to the project, and a missing output file
does not make a package stale: a checkout without `Saved/TopoTopo/` is still current. What it commits instead is the `.uasset`
files.

## The import steps

Each output of a report carries `import`: what the plugin does with its files, in order. What each kind becomes in Unreal is
decided here, on TopoTopo's side, and tested without the editor.

```json
{"as": "static_mesh", "file": "Saved/TopoTopo/Game/props/outputs/crate/crate.glb", "folder": "/Game/props/outputs/crate", "name": "crate",
 "lods": ["Saved/TopoTopo/Game/props/outputs/crate/crate_lod1.glb"], "sockets": "Saved/TopoTopo/Game/props/outputs/crate/crate.sockets.json"}
```

| `as` | fields | the plugin |
|---|---|---|
| `static_mesh` | `file`, `folder`, `name`, optional `lods`, `sockets` | imports the GLB with Interchange as one Static Mesh `folder/name`, its materials and textures in `Materials/` and `Textures/` below it; each LOD GLB becomes the next LOD; sockets tagged `TopoTopo` are replaced |
| `texture` | `file`, `folder`, `name` | imports the PNG as a Texture |
| `instances` | `file`, `folder`, `name`, `meshes` | writes a TopoTopo Instances asset from the rows, its groups by the `Mesh` column; `meshes` maps each value to an asset; rebuilds actors in open levels |
| `points` | `file`, `folder`, `name`, optional `meshes` | writes a PCG Data Asset; the columns that are no native point property become attributes (whole numbers, numbers or strings), and `meshes` adds a `MeshPath` attribute |
| `landscape` | `file`, `folder`, `name` | keeps the bundle's path on the package asset: placing it is a separate action, through TopoTopoPCG's `TopoTopo.ImportScene` |

A step runs when a file it names has another hash in the record than when it last ran, when its asset is missing, or on Recook.
An output whose `state` is `failed` runs no steps: its assets stay. A step the plugin does not know fails that output and asks
for `topotopo unreal setup`.

## Setup and status

`unreal setup` copies the plugin to `Plugins/TopoTopoImport/`, replacing what an earlier setup copied and leaving what the build
wrote beside it (`Binaries/`, `Intermediate/`). It writes the install record, enables the plugin in the `.uproject`, adds the
exclusions to the `/Game/` entry of Auto Reimport in `Config/DefaultEditorPerProjectUserSettings.ini`, and adds `*.topotopo-part`,
`**/.topotopo/cook.lock` and `Saved/TopoTopo/` to `.gitignore`. `--no-enable` leaves the `.uproject` alone; `--with-pcg` also
installs TopoTopoPCG the same way. The exclusions are `*/graphs/*`, `*/assets/*`, `*/inputs/*`, `*/exports/*`, `*/versions/*`,
`*/packages/*`, `*/attachments/*`, `*/.topotopo/*`, `*/topotopo-packages/*`, `topotopo-packages/*`, `*topotopo-workspace.json`;
the plugin adds any that are missing when the editor starts, because a user's saved settings can hold another list.

`unreal status` lists every package under `Content/` and every plugin's `Content/`, with the freshness rule, each output, and the
folders Auto Reimport still sees. `--strict` exits 1 when a package is not current or a folder is seen. `--json` prints the same as
JSON.

## Reimporting

The `.topo` is the source file of its package asset, so Auto Reimport reimports when it changes. The exclusions keep the working
folders from Auto Reimport, so the plugin watches `Content/` itself: a change under a package's `graphs/`, `assets/` or `inputs/`
waits 0.5 s for quiet, then cooks that package in the background; a change in `topotopo-packages/` or the workspace file does so
for every package. When the cook ends, its steps run once no Play session, dialog, save or other import is in the way. The same
runs for every package at startup. One cook runs at a time.
