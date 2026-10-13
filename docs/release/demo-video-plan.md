# Demo video plan: TopoTopo, 2–3 minutes

A plan one person can shoot, record and cut in one day. The video serves the v0.2 release and the MegaGrants
application (ROADMAP §7, step 3: graph → terrain and instances → Unreal, plus an agent building and verifying a prop).
It leads with the pipeline; the agent segment comes near the end as one feature among others.

Target length 2:55. Narration is about 350 words, read at about 140 words per minute, which leaves short pauses
between shots.

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
| 2 | 0:10–0:32 | 22 s | `examples/house_city.json`, then `shelf/house.json` | house_city orbit, then the seed change |
| 3 | 0:32–0:52 | 20 s | `examples/erosion_models.json` (the four `heightfield_erode` nodes) | erosion_models orbit, push in on the front row |
| 4 | 0:52–1:10 | 18 s | `examples/quad_remesh.json`, then `examples/textures.json` | quad_remesh still, then textures still |
| 5 | 1:10–1:32 | 22 s | `examples/unreal_demo.json`, then the terminal running `npm run export:demo` | unreal_demo orbit, then the file list in `out/unreal_demo/` |
| 6 | 1:32–2:02 | 30 s | Unreal Editor 5.8, level `L_Demo` (full frame) | overlays: import settings, instance count, row 0 |
| 7 | 2:02–2:14 | 12 s | Blender 5.2 with `scene.glb` | Houdini 22 with `scene.geo` |
| 8 | 2:14–2:40 | 26 s | MCP conversation (Claude Code), sped up | live viewer |
| 9 | 2:40–2:55 | 15 s | closing card (full frame) | |

### Shot 1: title (0:00–0:10)

- On screen: "TopoTopo" and the line "A procedural geometry engine: Houdini-style node graphs, headless, deterministic,
  exports to Unreal, Blender and Houdini." Background: `examples/renders/unreal_demo.png` (persp tile, cropped), dimmed.
- Narration: "TopoTopo is an open-source procedural geometry engine. You write node graphs as JSON, and it cooks them
  into geometry, with no editor and no GPU."

### Shot 2: nested generators (0:10–0:32)

- Left: `examples/house_city.json`. Highlight the `vars` (`houses_x`, `houses_z`, `spacing`, `seed`), the
  `attrib_randomize` nodes (w, d, floors, pitch, yaw) and the `foreach` body that places a `house` per lot. Cut to
  `shelf/house.json`: `wall_segment` per footprint edge inside a `foreach`, `roof_skeleton` on top.
- Right: orbit of `house_city` (matcap shading). At 0:26 change `"seed": 7` to `"seed": 8` on the left and cut to the
  second orbit (pre-rendered).
- Caption: "12 houses · each house is a shelf asset made of shelf assets".
- Narration: "This street is twelve houses. Each lot is a point with a random width, depth, floor count and roof
  pitch. Each house is a shelf asset that is itself a graph: walls along the footprint and a straight-skeleton roof.
  Change the seed and the street changes. Edit the wall asset and every house follows."

### Shot 3: terrain and erosion (0:32–0:52)

- Left: `examples/erosion_models.json`, the four `heightfield_erode` nodes: `method: droplet` with `backend: js` and
  `backend: kernel`, `method: pipe`, `method: stream_power`.
- Right: orbit of `erosion_models`, then a slow push in on the front row (pipe left, pipe plus stream power right).
- Caption: "back: droplets (TypeScript, WebAssembly) · front: virtual pipes, pipes + stream power".
- Narration: "Terrain is a heightfield with named layers. Here the same ridged terrain is eroded four ways: droplets
  in TypeScript and in WebAssembly, a virtual-pipe water model, and pipes with stream-power incision. The erosion
  kernels are Rust compiled to WebAssembly, so nothing needs a native build."

### Shot 4: quad remeshing, textures and bakes (0:52–1:10)

- Left: the `remesh_quad` nodes in `examples/quad_remesh.json`, then the texture chain in `examples/textures.json`.
- Right: `examples/renders/quad_remesh.png` (input on the left of each pair, quads on the right; crop to the two
  spheres, the box and the rock, and leave out the tube, whose cap shows the known pinching), then
  `examples/renders/textures.png` (brick wall and crate on the left, the five maps on the right).
- Narration: "Field-aligned quad remeshing turns triangle meshes into quad-dominant ones. Materials come from texture
  nodes and bakes: the brick wall and the crate's worn edges are generated in the graph, so the asset ships with
  textures and no image files of unknown licence."

### Shot 5: the Unreal demo graph and export (1:10–1:32)

- Left: `examples/unreal_demo.json`: the `description`, the `heightfield` node (126 × 126 m, 253 × 253 samples), the
  `heightfield_scatter` and `copy_to_points` (`pack: true`, `variants: name`) nodes. Cut to the terminal running
  `npm run export:demo` (or the renamed CLI) and its file summary.
- Right: orbit of `unreal_demo`, then the folder `out/unreal_demo/` with `landscape/`, `scene.glb`, `scene.usda`,
  `scene.geo`, `instances.csv`.
- Caption: "126 m terrain · 292 trees, 244 rocks · 536 packed instances".
- Narration: "Now a level for Unreal. One graph builds a hundred-and-twenty-six-metre eroded massif on a 253 by 253
  heightfield, cuts a road, and scatters 536 packed instances: three tree variants on gentle ground and two rock
  variants on steep slopes. One command writes the Landscape bundle, glTF, USD, a Houdini file and the instance
  stream."

### Shot 6: Unreal Engine 5.8 (1:32–2:02)

- Full frame: Unreal Editor, project `topotopotest`, level `L_Demo`. 12 s camera move over the Landscape and the
  forest (Level Sequence rendered with Movie Render Queue, or a recorded viewport move as fallback).
- Then three 5–6 s inserts with captions:
  1. The Landscape import values from `out/unreal_demo/landscape/landscape.json` next to the Landscape actor's details
     (section size 63, 2 × 2 sections, 2 × 2 components, location (0, 0, 1169.3223), scale (50, 50, 4.603792)).
  2. The Outliner filtered to the instance actors, showing 536.
  3. Row 0 of `instances.csv` next to the details panel of that actor (location, rotation, scale equal).
- Caption at the end: "all 39,350 instance vertices within 0.1 cm · tree bases on the Landscape, median gap 0.16 cm".
- Narration: "In Unreal Engine 5.8 the heightmap imports with the settings from the bundle's manifest, and the meshes
  come in through Interchange with their materials. The 536 rows of the instance stream land where TopoTopo placed
  them: every transformed vertex within a millimetre, and the tree bases sit on the Landscape."

### Shot 7: Blender and Houdini (2:02–2:14)

- Left: Blender 5.2, `out/unreal_demo/scene.glb` imported; Outliner open on the instance collection, viewport on the
  forest.
- Right: Houdini 22, a File SOP reading `out/unreal_demo/scene.geo`; Geometry Spreadsheet on primitives showing the
  PackedGeometry rows; the node info showing the counts.
- Caption: "Blender: 536 instances, 5 meshes · Houdini: 536 packed primitives, every attribute".
- Narration: "The same scene opens in Blender as 536 instances sharing five meshes, and in Houdini with every attribute
  and 536 packed primitives."

### Shot 8: an agent builds and checks a prop (2:14–2:40)

- Left: a Claude Code session with the TopoTopo MCP server, shown at 4× speed (say so in the caption). Prompt
  (rehearsed): "Build a three-legged stool with a 0.45 m high round seat as one watertight piece. Add an assert that
  checks it, render it, and explain the result."
- Right: the live viewer (MCP `preview` tool), which updates as the agent builds and edits.
- Expected tool calls: `help`, `build` (with an `assert` node), `render`, `explain`, possibly `edit`. Cut to the
  `assert` result and the `explain` summary in the conversation.
- Caption: "MCP server · 12 tools · shown at 4× speed".
- Narration: "TopoTopo also ships an MCP server, so a coding agent can drive it. The agent writes the graph in one
  call, reads back counts and checks, looks at a render, and verifies its own result with an assert node and explain."

### Shot 9: closing (2:40–2:55)

- On screen: "217 node types · 37 shelf assets · 282 golden tests · Apache-2.0", then `npx topotopo`,
  `topotopo.dev`, `github.com/topotopo-dev/topotopo`. Background: the Unreal still from shot 6. [verify: `npx
  topotopo` runs from the published package, see the install section of `docs/release/v0.2-release-notes.md`]
- Narration: "Two hundred and seventeen node types, thirty-seven shelf assets, every one tested. Apache 2.0. Try it with
  npx topotopo, or at topotopo dot dev."

Numbers in captions and narration come from `docs/nodes.md`, `test/golden/` and docs/WORKLOG.md (P2-G) as of
2026-10-13; re-check them on the recording day.

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

  Starting angles from each example's `meta.render`: house_city 38/28, erosion_models 25/55, unreal_demo 30/32
  (azimuth/elevation). Frames are 960 px wide and square plus the footer line (node name, counts, bbox), which stays
  on because it shows real numbers. Each frame re-cooks the graph; erosion_models runs two 200-step pipe models per
  frame, so start that loop first [verify: time per frame; if it is too slow, export the cooked result once with
  `--export out/video/erosion_models.json` and orbit a one-node graph whose `file` node reads it].
- **Unreal:** Level Sequence with one Cine Camera, two or three keys over 12 s, rendered with Movie Render Queue at
  1920 × 1080, 30 fps, anti-aliasing 8 spatial samples [verify: Movie Render Queue plugin enabled in topotopotest].
  Fallback: OBS capture of the viewport in Game View (G) with the editor UI hidden (F11).
- **Audio:** USB microphone, narration recorded per shot in a quiet room, 48 kHz mono; no music, or a track whose
  licence allows this use (note it in the description).

## Assets to prepare

The day before:
- [ ] The R-4 rename is merged, so the CLI, the MCP server name and the viewer title read `topotopo`. If it is not,
      record anyway and keep "TopoTopo" out of frame (terminal prompt, window titles, the UE content path).
- [ ] Clone the repository fresh into a folder named `topotopo`, run `npm ci`, `npm test` (exit code 0) and
      `npm run showcase`, and look at the renders used here:
      `examples/renders/house_city.png`, `erosion_models.png`, `quad_remesh.png`, `textures.png`, `unreal_demo.png`
      (B-roll if time allows: `shelf_street.png`, `skeleton_roofs.png`, `forest.png`, `terrain_erosion.png`).
- [ ] `npm run export:demo`; check `out/unreal_demo/demo.json` reports 536 instances and 5 sources, and that
      `landscape/landscape.json`, `scene.glb`, `scene.geo`, `scene.usda` and `instances.csv` exist.
- [ ] Render the orbit sequences (they can run overnight): house_city (seed 7 and seed 8; copy the graph to
      `out/video/house_city_seed8.json` and change `vars.seed` there instead of editing the example; the shelf is
      found from any folder), erosion_models, unreal_demo. Encode each to MP4.
- [ ] Unreal: open project `topotopotest` in Unreal 5.8 [verify: project path on disk]. Open
      `/Game/TopoTopo/Demo/L_Demo`; rename the folder to `/Game/TopoTopo/Demo` or keep the Content Browser out of
      frame. Check:
  - [ ] `Content/Python/init_unreal.py` (which calls `pf_verify.py` at startup to import the GLBs and spawn the CSV
        rows) is disabled for the session, so the editor does not re-import or spawn duplicates [verify: what the
        script does on a second start].
  - [ ] The Landscape is in `L_Demo` with the manifest values, and has a material that reads well on camera
        [verify: whether a Landscape material exists; weight layers from `landscape/layers/*.png` have not been
        imported in the editor yet, so do not show paint layers unless that is tested first].
  - [ ] 536 instance actors, materials bark, needles, leaves, rock and asphalt assigned.
  - [ ] Lighting: Directional Light, Sky Atmosphere, Sky Light, Exponential Height Fog; build or use Lumen.
  - [ ] Level Sequence with the camera move; one test render in Movie Render Queue.
  - [ ] Screenshots for the inserts: Landscape details, Outliner count, actor 0 details.
- [ ] Blender 5.2: import `out/unreal_demo/scene.glb`, frame the forest, save as `out/video/scene_blender.blend`.
- [ ] Houdini 22: File SOP on `out/unreal_demo/scene.geo`, Geometry Spreadsheet on primitives, save
      `out/video/scene_houdini.hip` [verify: licence edition and whether its watermark shows].
- [ ] Claude Code with the TopoTopo MCP server configured (see the MCP section of
      `docs/release/v0.2-release-notes.md`); run the shot 8 prompt twice and keep the cleaner take.
- [ ] Title card and closing card (1920 × 1080 PNG); caption text from this file.
- [ ] Narration script printed from this file; microphone level checked.

## Schedule for the day

| time | task |
|---|---|
| 08:30–09:00 | check the orbit sequences and exports from the day before; open every application once |
| 09:00–10:00 | record the left panes of shots 2–5 (VS Code, terminal running `npm run export:demo`) |
| 10:00–12:30 | Unreal: lighting, camera sequence, Movie Render Queue render (runs over the break), inserts for shot 6 |
| 12:30–13:15 | break |
| 13:15–14:00 | Blender and Houdini captures (shot 7) |
| 14:00–15:00 | agent segment takes (shot 8) |
| 15:00–15:45 | narration, shot by shot |
| 15:45–17:45 | edit: split layouts, captions, title and closing cards, audio levels |
| 17:45–18:30 | watch through twice, check every number against the repo, export, upload as unlisted |

If the day runs short, drop the push in from shot 3 and the third insert from shot 6 before cutting anything else.
