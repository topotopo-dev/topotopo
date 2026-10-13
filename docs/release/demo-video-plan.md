# Demo video plan: TopoTopo, 2–3 minutes

A plan one person can shoot, record and cut in one day. The video serves the v0.2 release and the MegaGrants
application (ROADMAP §7, step 3: graph → terrain and instances → Unreal, plus an agent building and verifying a prop).
It leads with the pipeline; the agent segment comes near the end as one feature among others.

Target length 2:55. Narration is about 345 words, read at about 140 words per minute, which leaves short pauses
between shots.

**Change from the first plan:** shot 5 is new (simulation: crates and rocks settling, a tarp draped over crates,
particle runoff trails), 24 s. To stay at 2:55 the other shots give up 24 s: the push in of the erosion shot and the
third Unreal insert (row 0 of the CSV against the actor's details; the 0.1 cm caption stays) are dropped, and the
house street, quad remeshing and textures, Unreal demo graph, and Blender and Houdini shots are each shortened by
2–4 s, with their narration trimmed to fit.

## Layout

Most shots are a split screen on a 1920 × 1080 timeline:
- **Left pane (960 × 1080):** the TopoTopo graph JSON in VS Code, a terminal, or the MCP conversation.
- **Right pane (960 × 1080):** the result: a TopoTopo render sequence (960 px wide, centred, with bands above and
  below for captions), the live viewer, or an application viewport.

Unreal, Blender and Houdini shots use the full frame or a left/right split between two applications.

## Shot list

| # | time | length | left | right |
|---|---|---|---|---|
| 1 | 0:00–0:10 | 10 s | title card (full frame) | |
| 2 | 0:10–0:28 | 18 s | `examples/house_city.json`, then `shelf/house.json` | house_city orbit, then the seed change |
| 3 | 0:28–0:44 | 16 s | `examples/erosion_models.json` (the four `heightfield_erode` nodes) | erosion_models orbit |
| 4 | 0:44–0:58 | 14 s | `examples/quad_remesh.json`, then `examples/textures.json` | quad_remesh still, then textures still |
| 5 | 0:58–1:22 | 24 s | `examples/rbd_settle.json`, `examples/drape.json`, `examples/particles.json` | crates dropping onto the pile among settled rocks, the draped tarp, runoff trails growing |
| 6 | 1:22–1:40 | 18 s | `examples/unreal_demo.json`, then the terminal running `npm run export:demo` | unreal_demo orbit, then the file list in `out/unreal_demo/` |
| 7 | 1:40–2:04 | 24 s | Unreal Editor 5.8, level `L_Demo` (full frame) | overlays: import settings, instance count |
| 8 | 2:04–2:14 | 10 s | Blender 5.2 with `scene.glb` | Houdini 22 with `scene.geo` |
| 9 | 2:14–2:40 | 26 s | MCP conversation (Claude Code), sped up | live viewer |
| 10 | 2:40–2:55 | 15 s | closing card (full frame) | |

### Shot 1: title (0:00–0:10)

- On screen: "TopoTopo" and the line "A procedural geometry engine: Houdini-style node graphs, headless, deterministic,
  exports to Unreal, Blender and Houdini." Background: `examples/renders/unreal_demo.png` (persp tile, cropped), dimmed.
- Narration: "TopoTopo is an open-source procedural geometry engine: JSON node graphs in, geometry out, with no editor
  and no GPU."

### Shot 2: nested generators (0:10–0:28)

- Left: `examples/house_city.json`. Highlight the `vars` (`houses_x`, `houses_z`, `spacing`, `seed`), the
  `attrib_randomize` nodes (w, d, floors, pitch, yaw) and the `foreach` body that places a `house` per lot. Cut to
  `shelf/house.json`: `wall_segment` per footprint edge inside a `foreach`, `roof_skeleton` on top.
- Right: orbit of `house_city` (matcap shading). At 0:22 change `"seed": 7` to `"seed": 8` on the left and cut to the
  second orbit (pre-rendered).
- Caption: "12 houses · each house is a shelf asset made of shelf assets".
- Narration: "This street is twelve houses, each a shelf asset built from other assets: walls along a random footprint
  and a straight-skeleton roof. Change the seed and the street changes; edit the wall asset and every house follows."

### Shot 3: terrain and erosion (0:28–0:44)

- Left: `examples/erosion_models.json`, the four `heightfield_erode` nodes: `method: droplet` with `backend: js` and
  `backend: kernel`, `method: pipe`, `method: stream_power`.
- Right: orbit of `erosion_models`.
- Caption: "back: droplets (TypeScript, WebAssembly) · front: virtual pipes, pipes + stream power".
- Narration: "Terrain is a heightfield with named layers. The same ridges, eroded four ways: droplets in TypeScript and
  in WebAssembly, virtual-pipe water, and pipes with stream-power incision. The kernels are Rust compiled to
  WebAssembly: no native build."

### Shot 4: quad remeshing, textures and bakes (0:44–0:58)

- Left: the `remesh_quad` nodes in `examples/quad_remesh.json`, then the texture chain in `examples/textures.json`.
- Right: `examples/renders/quad_remesh.png` (input on the left of each pair, quads on the right: two spheres, the box,
  the tube; since kernels session 7 the tube's cap is a regular grid with one transition ring, so it can stay in
  frame), then `examples/renders/textures.png` (brick wall and crate on the left, the five maps on the right).
- Narration: "Field-aligned quad remeshing turns triangle meshes into quad-dominant ones. Materials come from texture
  nodes and bakes generated in the graph, so assets ship with textures and no image files of unknown licence."

### Shot 5: simulation (0:58–1:22)

- Left, three cuts in step with the right pane:
  1. `examples/rbd_settle.json`: the `settled_rocks` node (`rbd_settle`, the shelf rocks dropped onto the terrain)
     and the `crate_piles` node (`rbd_stack`, `interval: 30`).
  2. `examples/drape.json`: the `tarp_draped` node (`drape`, the `tarp` grid over the `crates` merge).
  3. `examples/particles.json`: the `runoff` node (`particles`, the eroded heightfield as collision surface and
     field, `curl: true`, `trails: 40`).
- Right:
  1. 0:58–1:08 (10 s): the crate drop. A frame sequence of `rbd_settle.json` with `animate: true` on `crate_piles`:
     the 116 rocks already rest on the terrain, and the 16 crates fall one every half second onto the pad and pile up
     against each other and the rocks (see Capture settings).
  2. 1:08–1:15 (7 s): a partial orbit of `drape.json` (persp only): the tarp over the stacked crates, the banner and
     the cushion behind it.
  3. 1:15–1:22 (7 s): a frame sequence of `particles.json` started from zero steps: trails grow down the ridges of
     the eroded massif, white at birth, amber, then red; the fountain to the right.
- Captions: "rbd_settle · rbd_stack (Rapier): 116 rocks settled, 16 crates stacked", then "drape · XPBD cloth", then
  "particles · runoff trails on the eroded massif".
- Narration: "Simulation nodes settle what scatter places. Rocks dropped on the terrain come to rest, and crates fall
  one at a time into a pile, using the Rapier physics engine. A cloth tarp drapes over stacked crates, and particles
  run off the ridges as trails."

### Shot 6: the Unreal demo graph and export (1:22–1:40)

- Left: `examples/unreal_demo.json`: the `description`, the `heightfield` node (126 × 126 m, 253 × 253 samples), the
  `heightfield_scatter` and `copy_to_points` (`pack: true`, `variants: name`) nodes. Cut to the terminal running
  `npm run export:demo` and its file summary.
- Right: orbit of `unreal_demo`, then the folder `out/unreal_demo/` with `landscape/`, `scene.glb`, `scene.usda`,
  `scene.geo`, `instances.csv` (4 s).
- Caption: "126 m terrain · 292 trees, 244 rocks · 536 packed instances".
- Narration: "Now a level for Unreal. One graph erodes a hundred-and-twenty-six-metre massif, cuts a road, and scatters
  536 packed trees and rocks by slope. One command writes the Landscape bundle, glTF, USD, a Houdini file and the
  instance stream."

### Shot 7: Unreal Engine 5.8 (1:40–2:04)

- Full frame: Unreal Editor, project `topotopotest`, level `L_Demo`. 12 s camera move over the Landscape and the
  forest (Level Sequence rendered with Movie Render Queue, or a recorded viewport move as fallback).
- Then two 6 s inserts with captions:
  1. The Landscape import values from `out/unreal_demo/landscape/landscape.json` next to the Landscape actor's details
     (section size 63, 2 × 2 sections, 2 × 2 components, location (0, 0, 1169.3223), scale (50, 50, 4.603792)).
  2. The Outliner filtered to the instance actors, showing 536.
- Caption at the end: "all 39,350 instance vertices within 0.1 cm · tree bases on the Landscape, median gap 0.16 cm".
- Narration: "In Unreal Engine 5.8 the heightmap imports with the settings from the bundle's manifest, and the meshes
  come in through Interchange with their materials. The 536 rows of the instance stream land where TopoTopo placed
  them: every transformed vertex within a millimetre, and the tree bases sit on the Landscape."

### Shot 8: Blender and Houdini (2:04–2:14)

- Left: Blender 5.2, `out/unreal_demo/scene.glb` imported; Outliner open on the instance collection, viewport on the
  forest.
- Right: Houdini 22, a File SOP reading `out/unreal_demo/scene.geo`; Geometry Spreadsheet on primitives showing the
  PackedGeometry rows; the node info showing the counts.
- Caption: "Blender: 536 instances, 5 meshes · Houdini: 536 packed primitives, every attribute".
- Narration: "The same scene opens in Blender as 536 instances sharing five meshes, and in Houdini with every attribute
  and 536 packed primitives."

### Shot 9: an agent builds and checks a prop (2:14–2:40)

- Left: a Claude Code session with the TopoTopo MCP server, shown at 4× speed (say so in the caption). Prompt
  (rehearsed): "Build a three-legged stool with a 0.45 m high round seat as one watertight piece. Add an assert that
  checks it, render it, and explain the result."
- Right: the live viewer (MCP `preview` tool), which updates as the agent builds and edits.
- Expected tool calls: `help`, `build` (with an `assert` node), `render`, `explain`, possibly `edit`. Cut to the
  `assert` result and the `explain` summary in the conversation.
- Caption: "MCP server · 12 tools · shown at 4× speed".
- Narration: "TopoTopo also ships an MCP server, so a coding agent can drive it. The agent writes the graph in one
  call, reads back counts and checks, looks at a render, and verifies its own result with an assert node and explain."

### Shot 10: closing (2:40–2:55)

- On screen: "222 node types · 37 shelf assets · 290 golden tests · Apache-2.0", then `npx topotopo`,
  `topotopo.dev`, `github.com/topotopo-dev/topotopo`. Background: the Unreal still from shot 7. [verify: `npx
  topotopo` runs from the published package and the repository is public under that name on the recording day]
- Narration: "Two hundred and twenty-two node types, thirty-seven shelf assets, every one tested. Apache 2.0. Try it
  with npx topotopo, or at topotopo dot dev."

Numbers in captions and narration come from the node registry, `shelf/`, `test/golden/`, `docs/DESIGN.md` (the
rigid-body measurements: 116 rocks and 16 crates in `examples/rbd_settle.json`) and docs/WORKLOG.md (P2-G), counted at
commit 81895f2 (2026-10-13; the commands are in the Counting section of `docs/release/v0.2-release-notes.md`). Re-check
them on the recording day.

## Capture settings

- **Timeline and delivery:** 1920 × 1080, 30 fps. H.264 High profile, 12–16 Mbit/s, AAC 192 kbit/s 48 kHz, loudness
  about −14 LUFS. Also export an SRT caption file from the narration script.
- **Screen recording:** OBS Studio, canvas 1920 × 1080, 30 fps (60 fps for the Unreal viewport fallback, conformed to
  30 in the edit), recording to MKV and remuxed to MP4, hardware encoder at high quality (CQP about 18).
- **Display:** record on a 1920 × 1080 desktop at 100% scaling, or a 4K desktop at 200% scaled down, so text stays
  sharp. Focus assist on, taskbar hidden, desktop icons hidden.
- **Editor text:** VS Code dark theme, font size about 20 px at 1080p, minimap and breadcrumbs off, word wrap on,
  window exactly 960 × 1080 (a window-sizing utility or OBS crop).
- **Windows used:** VS Code (graph JSON), Windows Terminal (CLI and export), a browser on the live viewer
  (`localhost`), Unreal Editor 5.8, Blender 5.2, Houdini 22, Claude Code (terminal or desktop app).
- **TopoTopo render sequences** (no screen capture needed, sharper than recording the viewer): the CLI renders one
  frame per azimuth. Example for shot 2, 120 frames (4 s at 30 fps), one full turn starting at the example's own
  camera angle:

  ```bash
  mkdir -p out/video/house_city
  for i in $(seq 0 119); do
    node src/cli.ts examples/house_city.json --render "out/video/house_city/$(printf %03d $i).png" \
      --views persp --azimuth $((38 + i * 3)) --elevation 28 --size 960 --shading matcap --no-view-labels
  done
  ffmpeg -framerate 30 -i out/video/house_city/%03d.png -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" \
    -c:v libx264 -pix_fmt yuv420p out/video/house_city.mp4
  ```

  Starting angles from each example's `meta.render`: house_city 38/28, erosion_models 25/55, unreal_demo 30/32,
  drape 32/22, rbd_settle 30/30 (zoom 2), particles 30/32 (azimuth/elevation). Frames are 960 px wide and square plus
  the footer line (node name, counts, bbox), which stays on because it shows real numbers. Each frame re-cooks the
  graph; erosion_models runs two 200-step pipe models per frame, so start that loop first [verify: time per frame; if
  it is too slow, export the cooked result once with `--export out/video/erosion_models.json` and orbit a one-node
  graph whose `file` node reads it]. `drape.json` cooks in about 2 s per process, so its 210-frame orbit (7 s; 1° per
  frame from azimuth 32) takes a few minutes.
- **Simulation sequences for shot 5** (one CLI process each; `--frames` cooks the frames in order and reuses the
  previous frame's state, about 0.2 s of cooking per frame on the test machine):

  ```bash
  mkdir -p out/video/rbd_settle out/video/particles
  # crates: rbd_stack shows the drop in progress when animate is on (frame f = (f - 1) / 30 s of simulation)
  node -e "const fs=require('fs');const g=JSON.parse(fs.readFileSync('examples/rbd_settle.json','utf8'));g.nodes.crate_piles.params.animate=true;fs.writeFileSync('out/video/rbd_settle_anim.json',JSON.stringify(g,null,1))"
  node src/cli.ts out/video/rbd_settle_anim.json --frames 1-300 --fps 30 --render "out/video/rbd_settle/{frame:04}.png" \
    --views persp --azimuth 30 --elevation 30 --zoom 2 --size 960 --no-view-labels
  # runoff: start both particle nodes from zero steps so the trails grow on screen
  node -e "const fs=require('fs');const g=JSON.parse(fs.readFileSync('examples/particles.json','utf8'));g.nodes.runoff.params.steps=0;g.nodes.fountain.params.steps=0;fs.writeFileSync('out/video/particles_seq.json',JSON.stringify(g,null,1))"
  node src/cli.ts out/video/particles_seq.json --frames 1-210 --render "out/video/particles/{frame:04}.png" \
    --views persp --azimuth 30 --elevation 32 --size 960 --no-view-labels
  ffmpeg -framerate 30 -start_number 1 -i out/video/rbd_settle/%04d.png -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" \
    -c:v libx264 -pix_fmt yuv420p out/video/rbd_settle.mp4
  ```

  Both were tried on a few frames at 480 px (2026-10-13): the crates appear one every 0.5 s of simulation (four by
  frame 61), and the runoff trails start from bare terrain. The particles run at their own 24 fps, so 210 frames
  played at 30 fps are slightly faster than real time. [verify: time per frame at 960 px; that the 16th crate has
  landed before frame 300, otherwise extend the range and trim in the edit]
- **Unreal:** Level Sequence with one Cine Camera, two or three keys over 12 s, rendered with Movie Render Queue at
  1920 × 1080, 30 fps, anti-aliasing 8 spatial samples [verify: Movie Render Queue plugin enabled in topotopotest].
  Fallback: OBS capture of the viewport in Game View (G) with the editor UI hidden (F11).
- **Audio:** USB microphone, narration recorded per shot in a quiet room, 48 kHz mono; no music, or a track whose
  licence allows this use (note it in the description).

## Assets to prepare

The day before:
- [ ] The code rename is merged (R-4, 8391fc5), so the CLI, the MCP server name and the viewer title read `topotopo`.
      Keep the former name "Polyforge" out of frame wherever it is left: the working checkout's folder, the GitHub URL
      until the repository is renamed to topotopo-dev/topotopo, and the Unreal content path below.
- [ ] Clone the repository fresh into a folder named `topotopo`, run `npm ci`, `npm test` (exit code 0) and
      `npm run showcase`, and look at the renders used here:
      `examples/renders/house_city.png`, `erosion_models.png`, `quad_remesh.png`, `textures.png`, `rbd_settle.png`,
      `drape.png`, `particles.png`, `unreal_demo.png` (B-roll if time allows: `shelf_street.png`,
      `skeleton_roofs.png`, `forest.png`, `terrain_erosion.png`).
- [ ] `npm run export:demo`; check `out/unreal_demo/demo.json` reports 536 instances and 5 sources, and that
      `landscape/landscape.json`, `scene.glb`, `scene.geo`, `scene.usda` and `instances.csv` exist.
- [ ] Render the orbit sequences (they can run overnight): house_city (seed 7 and seed 8; copy the graph to
      `out/video/house_city_seed8.json` and change `vars.seed` there instead of editing the example; the shelf is
      found from any folder), erosion_models, drape, unreal_demo; and the two simulation sequences for shot 5
      (crate drop, runoff). Encode each to MP4.
- [ ] Unreal: open project `topotopotest` in Unreal 5.8 [verify: project path on disk]. Open
      `/Game/Polyforge/Demo/L_Demo` (the folder was created before the rename); rename the folder to
      `/Game/TopoTopo/Demo` or keep the Content Browser out of frame. Check:
  - [ ] `Content/Python/init_unreal.py` (which calls `pf_verify.py` at startup to import the GLBs and spawn the CSV
        rows) is disabled for the session, so the editor does not re-import or spawn duplicates [verify: what the
        script does on a second start].
  - [ ] The Landscape is in `L_Demo` with the manifest values, and has a material that reads well on camera
        [verify: whether a Landscape material exists; weight layers from `landscape/layers/*.png` have not been
        imported in the editor yet, so do not show paint layers unless that is tested first].
  - [ ] 536 instance actors, materials bark, needles, leaves, rock and asphalt assigned.
  - [ ] Lighting: Directional Light, Sky Atmosphere, Sky Light, Exponential Height Fog; build or use Lumen.
  - [ ] Level Sequence with the camera move; one test render in Movie Render Queue.
  - [ ] Screenshots for the inserts: Landscape details, Outliner count.
- [ ] Blender 5.2: import `out/unreal_demo/scene.glb`, frame the forest, save as `out/video/scene_blender.blend`.
- [ ] Houdini 22: File SOP on `out/unreal_demo/scene.geo`, Geometry Spreadsheet on primitives, save
      `out/video/scene_houdini.hip` [verify: licence edition and whether its watermark shows].
- [ ] Claude Code with the TopoTopo MCP server configured (see the MCP section of
      `docs/release/v0.2-release-notes.md`); run the shot 9 prompt twice and keep the cleaner take.
- [ ] Title card and closing card (1920 × 1080 PNG); caption text from this file.
- [ ] Narration script printed from this file; microphone level checked.

## Schedule for the day

| time | task |
|---|---|
| 08:30–09:00 | check the orbit and simulation sequences and exports from the day before; open every application once |
| 09:00–10:15 | record the left panes of shots 2–6 (VS Code, terminal running `npm run export:demo`) |
| 10:15–12:30 | Unreal: lighting, camera sequence, Movie Render Queue render (runs over the break), inserts for shot 7 |
| 12:30–13:15 | break |
| 13:15–14:00 | Blender and Houdini captures (shot 8) |
| 14:00–15:00 | agent segment takes (shot 9) |
| 15:00–15:45 | narration, shot by shot |
| 15:45–17:45 | edit: split layouts, captions, title and closing cards, audio levels |
| 17:45–18:30 | watch through twice, check every number against the repo, export, upload as unlisted |

If the day runs short, replace the crate drop in shot 5 with the still `examples/renders/rbd_settle.png` and the
runoff sequence with `examples/renders/particles.png`, and keep the shot length.
