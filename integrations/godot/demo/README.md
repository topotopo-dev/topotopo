# TopoTopo demo for Godot 4.7

A small Godot project with three TopoTopo packages, for a first live test of the TopoTopo plugin:

| Package | Output | What Godot gets |
|---|---|---|
| `assets/crate` | `crate` | `crate.glb`: a wooden crate with three sockets (`handle`, `side_left`, `side_right`) and two LOD pieces (`crate_lod0`, `crate_lod1`) |
| `assets/yard` | `ground`, `stones` | `ground.glb`, and `stones.glb`: 40 stones of three kinds as `MultiMeshInstance3D` nodes, each turned, scaled and tinted |
| `assets/bricks` | `bricks` | a texture set: `brick_color.png`, `brick_normal.png`, `brick_roughness.png` |

The demo starts uncooked: the first time Godot opens it, the plugin cooks every package. Its `.gitignore` keeps what
the cook and Godot write out of the repository. (In a game you commit the outputs, their `.import` files and the
records, so a machine without TopoTopo still builds it.)

## 1. Set it up (one command)

In the TopoTopo folder:

```text
node src/cli.ts godot setup integrations/godot/demo
```

(Where TopoTopo is installed: `topotopo godot setup <path to the demo>`.) It copies the plugin into `addons/topotopo/`
and records where TopoTopo and node are, so Godot finds them; the demo has the rest already.

## 2. Open it

Open Godot 4.7, **Import** the demo's `project.godot`, and open it.

- A **TopoTopo** tab is in the bottom panel. Its first line names the TopoTopo it found, for example
  `TopoTopo 0.4.0 at <TopoTopo folder>/src/cli.ts (the install record …), node v24…`.
- The three packages cook in the background while the editor stays usable: the panel shows each one cooking, then
  `ok`. The outputs appear in the FileSystem dock under `assets/*/outputs/`.
- **Project > Tools > TopoTopo** has Cook Stale Packages, Recook All and Show TopoTopo Panel.
- The panel can be moved like any dock (its menu: bottom panel or floating).

## 3. Place the outputs

**Scene > New Scene > 3D Scene**, then drag `crate.glb`, `ground.glb` and `stones.glb` from the FileSystem dock (or
from the TopoTopo panel) into the viewport. Save the scene as `level.tscn` and keep it open.

- The crate has `Node3D` children `handle`, `side_left` and `side_right` (its sockets) beside the meshes `crate_lod0`
  and `crate_lod1`.
- The stones are three `MultiMeshInstance3D` nodes (`stone_block`, `stone_pillar`, `stone_round`) in shades of grey.
- Double-click `brick_color.png`: the texture set is ordinary textures.

## 4. Change a package while the level is open

Right-click `assets/crate/crate.topo` (or `crate.glb`) and choose **Open in TopoTopo**. The browser opens TopoTopo's
viewer on the crate. Under **Controls** on the right, change **Width** from `0.8` to `1.2`. The package saves the
change automatically. Click back into Godot.

- Within a few seconds a toast says `TopoTopo: crate updated: crate`, and the open level shows the new crate.
- The editor stays usable while it cooks.

## 5. Work side by side

- With Godot unfocused (you are in the browser), change **Width** again: Godot does not import it until you click back
  into Godot, which is Godot's own rule.
- Tick **Import When Unfocused** in the TopoTopo panel (Godot's own setting) and change **Width** in the viewer: the level
  updates without clicking into Godot.
- With Godot focused, ask an agent to change the crate over MCP: the level updates the same way.

## 6. Your own Godot settings survive

Double-click `crate.glb` (Advanced Import Settings), set **Root Type** to `StaticBody3D` and **Reimport**. Then change
the crate again in the viewer: after its reimport the root is still a `StaticBody3D`.

## 7. A graph that does not cook

Ask your agent to temporarily break the crate's `lod0` input connection (replace `rounded` with `nowhere` in
`assets/crate/graphs/crate.json`). Keep the level open while it does this.

- `crate.topo` gets Godot's red ImportFail icon.
- An error toast says `TopoTopo: crate: 1 of 1 outputs did not cook; the last good result is kept`.
- Output has `TopoTopo: crate > crate: [<node>] <message>`, and the panel shows the error under the output.
- The level keeps the last good crate.

Ask the agent to restore the connection: the icon, the panel and the level are current again.

## 8. A cook inside an import

Open **Editor Settings**, enable **Advanced Settings**, then turn off **FileSystem > Import > TopoTopo > Live Cook**.
Change the crate in the viewer: it saves automatically, but nothing cooks. Select `crate.topo`, and in the Import
dock press **Reimport**: the import cooks the crate, and the
open level shows the new crate once the import has finished. Turn Live Cook on again.

## 9. Deleted, closed, recooked

- Delete `crate.glb` in the FileSystem dock: it comes back. Godot may reset that file's import settings when it
  disappears; restore any custom settings after this check.
- Close Godot, change a graph (in the viewer, or `graphs/crate.json` in a text editor), open the demo again: it cooks
  at startup.
- Right-click `crate.topo` and choose **Recook**: when nothing changed, nothing is written or imported again (Show
  Cook Report lists every output as `unchanged`).

Edits in the viewer change the demo's graphs in this repository: `git checkout integrations/godot/demo` puts them back.

## If something is off

Note the step, and copy the lines starting with `TopoTopo:` from the Output panel and the first line of the TopoTopo
panel (which TopoTopo it found, and from where). **Project > Tools > TopoTopo > Show TopoTopo Panel** brings the panel
back when it is closed.
