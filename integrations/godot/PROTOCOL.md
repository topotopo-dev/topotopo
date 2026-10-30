# The TopoTopo cook protocol for the Godot addon

This is the contract between the TopoTopo command line and the Godot addon (`addons/topotopo/`): how the addon finds
TopoTopo, the commands it runs, the jobs file it writes, the progress lines and report it reads, the record committed
with every package, and the one definition of freshness both sides implement. Protocol version **1**, record schema
**1**. TopoTopo's side is `src/host/cook.ts` and `src/host/godot.ts`; its tests are `test/cook.ts`.

## Finding TopoTopo

The CLI, in this order: the environment variable `TOPOTOPO_CLI`; the editor setting
`filesystem/import/topotopo/topotopo_path`; `node_modules/topotopo/dist/cli.js` in the project folder or a folder above
it; `"install".cli` in the user's config (`~/.topotopo/config.json`, or the file `TOPOTOPO_CONFIG` names), which
`topotopo godot setup` writes; `topotopo.cmd` / `topotopo` on `PATH`. A folder means its `src/cli.ts` when that exists
(a checkout), else its `dist/cli.js`.

Node, in this order: `TOPOTOPO_NODE`; the editor setting `filesystem/import/topotopo/node_path`; `"install".node` in the
user's config; `node` found on `PATH`. Node 22.18 or newer runs TopoTopo.

The install record, as `godot setup` writes it into the user's config (other keys of the file are kept):

```json
{"install": {"node": "C:/Program Files/nodejs/node.exe", "cli": "C:/tools/topotopo/src/cli.ts"}}
```

`<node> <cli> --version` prints `topotopo X.Y.Z` (one line, exit 0).

## Commands

```text
topotopo cook <.topo | package folder | folder>... --for godot [--into <folder>] [--flat] [--skip a,b] [--instancing packed|expand] [--adopt] [--force] [--no-cache] [--timeout <s>] [--report <file>] [--progress json] [--quiet]
topotopo cook --jobs <jobs.json> [--force] [--no-cache] [--progress json]
topotopo godot setup <godot project folder> [--no-enable]
topotopo godot status <godot project folder> [--strict] [--json]
```

The addon runs `<node> <cli> cook --jobs <jobs.json> --progress json`, adding `--force --no-cache` for an explicit
recook. Arguments are absolute paths with forward slashes and no trailing slash. A folder target means every package
below it; `--report` takes one package. `--quiet` leaves out the summary lines; failures are still printed.

- `--force`: cook every output again, ignoring the record and the cache.
- `--no-cache`: no cache lookup (results are still stored in it).
- `--adopt`: take over files at the output paths that no record lists and no source block names (once, for a package
  whose GLBs existed before the plugin; their `.import` files and uids are kept).
- `--timeout <s>`: per package; the cook stops, the remaining outputs fail with a timeout error, the record and report
  are still written.

### Exit codes

| code | meaning |
|---|---|
| 0 | every output is ok: written, unchanged or cached (skipped outputs count as ok) |
| 1 | at least one output or package failed, or a package timed out; records and reports are still written |
| 2 | usage, setup or protocol error: an unknown option, a jobs file of another protocol, a published copy, a package outside a Godot project or at its root, an output folder outside the project; nothing is written |

Any other code, or a missing or unreadable report, is a crash: show the last lines of stderr.

## The jobs file

UTF-8 JSON, written by the addon (for example into `res://.godot/topotopo/`):

```json
{"for": "godot", "protocol": 1,
 "jobs": [{"package": "C:/game/assets/props/props.topo", "into": "C:/game/assets/props/outputs", "per_output_folders": true,
           "skip": ["kit"], "instancing": "packed", "report": "C:/game/.godot/topotopo/props-1f2e.report.json", "timeout": 600}]}
```

| field | type | meaning |
|---|---|---|
| `for` | `"godot"` | optional; another value exits 2 |
| `protocol` | `1` | another value exits 2 with "update the Godot addon: topotopo godot setup <project>" |
| `jobs[].package` | string | the `.topo` file (absolute); a package folder works too |
| `jobs[].into` | string | the output folder: absolute inside the project, or `res://…`; default from the import options |
| `jobs[].per_output_folders` | bool | default from the import options |
| `jobs[].skip` | string[] | output ids not cooked; default from the import options |
| `jobs[].instancing` | `"packed"` \| `"expand"` | default from the import options |
| `jobs[].report` | string | the report file (absolute); always written when given |
| `jobs[].timeout` | number | seconds for this package |
| `jobs[].adopt` | bool | as `--adopt` |

A field left out falls back to `<id>.topo.import`, then to the defaults. Every job is checked before anything cooks;
then the packages cook one after the other in the one process.

## The import options

The `.topo`'s import file, `<id>.topo.import`, holds them under `[params]` as Godot Variant text (quoted strings,
`true`/`false`, integers). Only these keys are read:

| key | default | meaning |
|---|---|---|
| `outputs/folder` | `"outputs"` | the output folder: relative to the package folder, or `res://…` |
| `outputs/per_output_folders` | `true` | `true`: `<folder>/<id>/<id>.glb`; `false`: `<folder>/<id>.glb` |
| `outputs/skip` | `""` | comma-separated output ids not to cook (spaces around ids ignored) |
| `instances/mode` | `0` | `0` MultiMesh (instancing `packed`), `1` Expand (instancing `expand`) |

The options as the record holds and compares them:

```json
{"folder": "res://assets/props/outputs", "instancing": "packed", "per_output_folders": true, "skip": ["kit"]}
```

`folder` is a normalised `res://` path: a relative folder resolved against the package folder, `.` and `..` segments
resolved, no doubled or trailing slash (the project folder itself is `res://`). `skip` is sorted, each id once. Two
options are the same when all four values are equal.

## Progress lines

With `--progress json`, stdout carries one JSON object per line, in ASCII: every character from U+007F up is written as
`\uXXXX`, so any decoding of the pipe reads it. Paths use forward slashes; compare them without case on Windows.
Summary and error lines go to stderr then (unless `--quiet`).

```json
{"event":"start","package":"C:/game/assets/props/props.topo","outputs":5}
{"event":"output","package":"C:/game/assets/props/props.topo","output":"crate","state":"written","ms":120}
{"event":"done","package":"C:/game/assets/props/props.topo","ok":true,"report":"C:/game/.godot/topotopo/props-1f2e.report.json"}
```

Every package gets one `start` (also when it fails before listing its outputs: `"outputs": 0`), one `output` per
output it lists (in id order, failed outputs that cannot be published first) and one `done`. `state` is one of
`written`, `unchanged`, `cached`, `failed`, `skipped`. `report` is `""` when the job named none. Failures are also
printed to stderr as `TopoTopo: <package> > <output>: [<node>] <message> (hint: <hint>)`.

## The report

UTF-8 JSON, written for every job that names one, also on failure:

```json
{"protocol": 1, "topotopo": "0.4.0", "ok": false, "ms": 1234, "record": "written",
 "package": {"id": "props", "name": "studio/props", "dir": "C:/game/assets/props", "topo": "C:/game/assets/props/props.topo"},
 "outputs": [{"id": "crate", "label": "Crate", "kind": "mesh", "default": false, "state": "failed",
              "files": ["res://assets/props/outputs/crate/crate.glb"], "written": [], "instances": {}, "cooked": true, "ms": 120,
              "errors": [{"node": "bevel1", "message": "…", "hint": "…"}], "warnings": []}],
 "orphans": ["res://assets/props/outputs/old/old.glb"], "exposed": ["graphs/"], "errors": [], "warnings": []}
```

| field | meaning |
|---|---|
| `ok` | no output failed and the package opened |
| `record` | `written`, `unchanged`, or `none` (the package did not open) |
| `package.name` | the publish name, or `null` |
| `outputs[].files` | the output's files (`res://`); a failed output: its last good files |
| `outputs[].written` | the files this run wrote (their bytes changed) |
| `outputs[].cooked` | cooked in this run (by the engine or from the cache), not carried over from the record |
| `outputs[].errors` | `{node, message, hint}`; `node` and `hint` are `""` when there is none |
| `outputs[].warnings` | strings; a skipped output's first warning says why |
| `orphans` | files outputs had and have no more, kept on disk (a level may use them) |
| `exposed` | the package's TopoTopo folders Godot imports (no `.gdignore`): `graphs/`, `assets/`, `inputs/`, `exports/`, `versions/`, `packages/` |
| `errors` | package-level errors (strings): the manifest does not open, the lock is held, a timeout |
| `warnings` | package-level warnings (strings), the record's notes among them |

## Output files

- Kinds mesh, scene, instances, curves and points: `<id>.glb`. Textures: one PNG per image, named after the image.
  Terrain, material and volume outputs are not imported: they are listed as skipped with why.
- With per-output folders: `<folder>/<id>/…`; without: `<folder>/…`. Two outputs writing one path fail.
- The GLB: y up, metres, materials with embedded images, no compression and no quantization; node names as authored
  (sockets are meshless nodes, `_lod0`/`_lod1` pieces sibling meshes, Godot's `-col`/`-colonly`/`-convcolonly`
  suffixes kept). It requires no glTF extension but these: `EXT_texture_webp`, `GODOT_single_root`,
  `KHR_animation_pointer`, `KHR_lights_punctual`, `KHR_materials_emissive_strength`,
  `KHR_materials_pbrSpecularGlossiness`, `KHR_materials_unlit`, `KHR_node_visibility`, `KHR_texture_basisu`,
  `KHR_texture_transform`, `OMI_collider`, `OMI_physics_body`, `OMI_physics_shape`, and `EXT_mesh_gpu_instancing` with
  instancing `packed`.
- Packed instances: one node per packed source (named after it) with `EXT_mesh_gpu_instancing`: float accessors
  `TRANSLATION` (VEC3), `ROTATION` (VEC4, quaternion xyzw), `SCALE` (VEC3) and, when the instances carry a colour,
  `_COLOR` (VEC3, or VEC4 with alpha). No other instance attribute is written. Each instance is T·R·S.
- `asset.extras.source` records how the GLB was made; its `package` is the package's publish name, else its id. A PNG
  carries the same in a `tEXt` chunk with the keyword `TopoTopo package`.
- No `.json` file is written into the project beside the outputs.

Writing rules: a file is written as `<file>.topotopo-part` and moved into place only when its bytes differ, so an
unchanged file keeps its time and Godot does not reimport it. A file at an output path is replaced only when the
record lists it (as an output file or an orphan), when it was cooked for this package (its source block or `tEXt`
chunk names it), or with `--adopt`. A failed output keeps its last good files. A cook holds
`<package>/.topotopo/cook.lock` (the holder's pid); a lock whose process has ended is taken over. `godot setup` adds
`*.topotopo-part` and `**/.topotopo/cook.lock` to the project's `.gitignore`.

## The record

`<package>/.topotopo/godot.json`, committed with the outputs and their `.import` files. Canonical JSON: keys sorted at
every level (by UTF-16 code unit), 2-space indent, one key or array item per line, LF line ends, a trailing newline.
No times, no machine paths: sources are relative to the package folder with forward slashes (a file outside the
Godot project is absolute, and noted); output files are `res://` paths. The record is written last, and only when its
bytes change.

```json
{
  "folders": {"assets": [], "graphs": ["crate.json", "yard.json"], "inputs": ["decal.png", "notes.txt"]},
  "for": "godot",
  "name": "studio/props",
  "notes": [],
  "options": {"folder": "res://assets/props/outputs", "instancing": "packed", "per_output_folders": true, "skip": []},
  "orphans": {"res://assets/props/outputs/old/old.glb": "old"},
  "outputs": {
    "crate": {
      "default": false,
      "deps": ["graphs/crate.json", "inputs/decal.png", "props.topo"],
      "errors": [],
      "files": {"res://assets/props/outputs/crate/crate.glb": "<sha256>"},
      "folders": [],
      "graph": "crate", "instances": {}, "kind": "mesh", "label": "Crate", "node": "handle",
      "state": "ok", "warnings": []
    }
  },
  "package": "props",
  "schema": 1,
  "skipped": {"island": {"deps": ["graphs/yard.json", "props.topo"], "folders": [], "graph": "yard", "kind": "terrain", "label": "Island", "node": "island", "why": "terrain outputs are not imported into Godot yet"}},
  "sources": {"graphs/crate.json": "<contentSha>", "graphs/yard.json": "<contentSha>", "inputs/decal.png": "<contentSha>", "props.topo": "<contentSha>"},
  "topotopo": "0.4.0"
}
```

| field | meaning |
|---|---|
| `folders` | folder (relative to the package) → its listing: always `assets`, `graphs`, `inputs`, plus every folder an output listed |
| `name` | the publish name, or `null` |
| `notes` | package-level notes (strings): graphs that cannot be read, a missing default output, files read from outside the project |
| `options` | the options the package was cooked with |
| `orphans` | file (`res://`) → the output it belonged to; files kept on disk, removed only by the user |
| `outputs` | output id → its entry. The default output is named after its output name, or the package id when it has none |
| `outputs.*.deps` | every file the output read, relative to the package, sorted |
| `outputs.*.files` | file (`res://`) → SHA-256 of its bytes (lowercase hex); a failed output: its last good files, or none |
| `outputs.*.folders` | the folders it listed (their listings are in `folders`) |
| `outputs.*.instances` | packed instances per source name |
| `outputs.*.state` | `ok` or `failed`; `errors` holds `{node, message, hint}` |
| `package` | the package id (the `.topo` file's name) |
| `skipped` | output id → why it is not imported: `{"why"}` for one in `skip`, `{"why", "kind", "graph", "node", "label", "deps", "folders"}` for one of a kind not imported |
| `sources` | every dep of every output and skipped output → its contentSha |
| `topotopo` | the TopoTopo version that cooked it |

## contentSha

The SHA-256 (lowercase hex) of a file's content, read the way version control reads text, so a checkout that turns LF
into CRLF (`core.autocrlf`) keeps every hash:

1. A file whose name (the path as the record names it) ends, ignoring case, in `.png .jpg .jpeg .webp .gif .avif .bmp
   .tga .tif .tiff .exr .hdr .dds .ktx .ktx2 .glb .bin .bgeo .sc .usdc .usdz .fbx .abc .vdb .r16 .r32 .raw .wasm .ttf
   .otf .woff .woff2 .zip .gz .7z .pdf .mp4 .webm .wav .ogg .mp3` is hashed as it is.
2. A file with a NUL byte in its first 8000 bytes is hashed as it is.
3. Any other file is hashed with every CR LF pair replaced by LF (a lone CR is kept).

Output files are hashed as they are (plain SHA-256 of the bytes).

## Listings

A folder's listing is every file below it, recursively, as a path relative to the folder with forward slashes. Left
out: every file or folder whose name starts with `.`; the files engines write beside ours (`*.import`, `*.uid`,
`*.translation`, `*.uasset`); `*.topotopo-part`. A folder that does not exist lists nothing. The record sorts
listings; a reader compares them as sets.

## Freshness

One definition, checked in this order; the first rule that applies decides:

| # | check | result | `why` | `path` |
|---|---|---|---|---|
| 1 | no record file | never cooked | `record` | |
| 2 | `schema` greater than 1 | stale (update the addon) | `newer_schema` | |
| 2 | `schema` not 1, or `for` not `"godot"` | stale | `schema` | |
| 3 | `options` differ from the current import options | stale | `options` | |
| 4 | a `sources` file is missing, or its contentSha differs (in key order) | stale | `source` | the source |
| 5 | a `folders` listing differs (in key order) | stale | `folder` | the folder |
| 6 | an output file is missing, or its SHA-256 differs (outputs in id order, files in key order) | stale | `output` | the `res://` file |
| 7 | TopoTopo is found and its version is newer than `topotopo` | stale | `version` | |
| 8 | an output has state `failed` | failed | `failed` | the first such output id |
| 9 | otherwise | ok | `""` | |

Versions compare by their dot-separated numbers (a missing part is 0): `0.10.0` is newer than `0.4.1`. When TopoTopo is
found and is older than the record's `topotopo`, the result keeps its state and carries the note `update_topotopo`
(an older TopoTopo never recooks a newer cook on that ground alone). When TopoTopo is not found, rule 7 is skipped.

A reader may skip hashing a source whose modification time and size are unchanged since it last hashed it.

The golden values both sides are tested against are `test/data/cook/freshness.json` in the TopoTopo repository:
`contentSha` lists files (`name`, `base64`, `sha`); `cases` lists packages: `files` (path in a project → base64 bytes;
the project folder is the root), `package` (the package folder in it), `record` (or `null`), `options`, `installed`
(or `null`) and `expect` (`state`, `why`, `path`, `note`). `node test/cook.ts --update` writes them.

## What cooks again

A cook recooks every output with `--force`, without a record, when the options changed, when the installed TopoTopo is
newer than the record's, or when the `graphs/` listing changed. Otherwise an output cooks again when it is new, failed
before, names another graph or node, or when one of its deps, the listing of a folder it listed, or one of its files no
longer matches the record. Every other output is carried over unchanged. A result is taken from the cook cache
(`~/.topotopo/cache/cook`, or `$TOPOTOPO_CACHE/cook`) when its deps and listings match the package as it is.

## Setup and status

`topotopo godot setup <project>` copies the addon into `addons/topotopo/`, writes the install record, writes an empty
`.gdignore` into the `graphs/`, `assets/`, `inputs/`, `exports/`, `versions/` and `packages/` folders of every package
Godot sees (and into a workspace's `topotopo-packages/`), enables `res://addons/topotopo/plugin.cfg` in
`project.godot` `[editor_plugins]` (unless `--no-enable`), adds the cook's lines to `.gitignore`, adds `addons/topotopo/*`
to the `exclude_filter` of every preset in `export_presets.cfg`, and warns about output folders no LFS pattern covers.
A package at the project's root is not supported.

`topotopo godot status <project>` checks every `.topo` Godot's scan sees (names starting with `.` unseen; a folder
holding `.gdignore`, or below the root `project.godot`, not entered) with the freshness rule, and lists exposed
TopoTopo folders, published copies Godot sees, output folders LFS does not cover and export presets that would ship
the addon. `--strict` exits 1 when a package is stale, failed, never cooked or at the project's root, exposes a folder,
or a published copy is visible. `--json` prints the same as JSON.
