# TopoTopo for Godot 4.7

This addon imports TopoTopo packages. A package inside the project (a folder holding `<id>.topo`) imports as a
status resource, and each of its published outputs is cooked into a plain GLB (textures outputs: PNGs) that Godot
imports itself. Levels and code use the GLBs, never the `.topo`; an output's own Advanced Import Settings survive every
recook. While the package's graphs change (in TopoTopo's viewer, by an agent over MCP, by hand), the outputs follow:
only outputs whose sources changed cook again, in the background, and only files whose bytes changed are written.

## Install

```text
topotopo godot setup <godot project folder>
```

It copies this addon into `addons/topotopo/`, records where TopoTopo and node are, hides each package's TopoTopo
folders from Godot (`.gdignore`), enables the plugin, adds the cook's files to `.gitignore` and keeps the addon out of
every export preset. If Godot has the project open, enable **Project > Project Settings > Plugins > TopoTopo**.

## In the editor

- **The TopoTopo panel** (bottom panel): which TopoTopo cooks, each package's state, its outputs (drag one into a
  scene), errors per output with the node and a hint, skipped outputs, orphans, and Open in TopoTopo, Recook, Show
  Outputs, Show Report, Remove Orphans. **Locate TopoTopo...** sets where it is; **Import When Unfocused** is Godot's
  own setting, for working beside the viewer.
- **The FileSystem dock's context menu** on a `.topo` or any of its outputs: Open in TopoTopo, Recook, Show Cook Report.
- **Project > Tools > TopoTopo**: Cook Stale Packages, Recook All, Show TopoTopo Panel.
- **A failed output** keeps its last good GLB. The `.topo` gets Godot's ImportFail icon, Output has
  `TopoTopo: <package> > <output>: [<node>] <message> (hint: …)`, and a toast and the panel say it too.

## Settings

Editor Settings > FileSystem > Import > TopoTopo (per machine): `topotopo_path` (a TopoTopo `src/cli.ts`, `dist/cli.js`
or folder; empty: found by itself), `node_path`, `live_cook` (cook when package files change), `watch_interval`
(seconds; 0: only when the editor gets focus) and `cook_timeout`.

TopoTopo is found in this order: the environment variable `TOPOTOPO_CLI`, the editor setting, `node_modules/topotopo`
in the project folder or above it, the install record `topotopo godot setup` writes, `topotopo` on `PATH`.

## What to commit

The addon, the packages with their `.gdignore` files, `<id>.topo.import`, each package's `.topotopo/godot.json`, and the
output folders with Godot's `.import` files. Not `.godot/`, `*.topotopo-part` or `.topotopo/cook.lock`. A teammate or
build machine without TopoTopo then imports the committed outputs as they are.

## CI

Godot exits 0 even when imports fail, so check the packages after importing:

```text
godot --headless --path <project> --import
topotopo godot status <project> --strict
```

Without TopoTopo on the machine: `godot --headless --path <project> --script res://addons/topotopo/tools/check.gd`
exits 1 when a package is stale, failed or never cooked.

The contract between this addon and TopoTopo is `integrations/godot/PROTOCOL.md` in the TopoTopo repository.
