# The viewer: a production editor viewport

Status: standard, updated 2026-10-19 for outputs, images and TopoTopo navigation. Every change to `src/viewer` is built to this document; a brief that departs
from it says so and why.

## 1. What it is

The viewer is the human's side of TopoTopo: a professional 3D editor viewport over the same workspace the MCP
server serves. It shows what the graph cooks, lets a person measure, inspect, place guides (nulls, curves, areas,
volumes) and tune exposed parameters, and it grows into a full editor (outliner, properties, node editor) so the
tool is usable without an LLM. The LLM conversation stays in Claude Code or any MCP client; the viewer never gets a
chat panel. The viewer talks to the engine through the viewer server (`src/viewer/server.ts`); it never holds
state the workspace does not: graphs, inputs and markers are files.

Standards, not inventions. Someone who knows Maya, Houdini, Blender or Unreal must be able to read every element on
screen without a legend and navigate without a tutorial. Nothing cute: no floating labels on everything, no glowing
discs, no inertia, no saturated fills.

## 2. Layout

```
+-----------------------------------------------------------------------------------+
| graph ▾   persp ▾   shaded ▾   snap: grid ▢ point ▢ surface ▢   step 1 m   [quad] |
+----------------+-----------------------------------------------+------------------+
| OUTLINER       | VIEWPORT (single, or 2×2 quad: persp/top/     | PROPERTIES       |
|  ▾ output      |  front/right)                                 |  name            |
|  ▾ graph nodes |                                               |  kind / role     |
|  ▾ inputs      |   grid, axis gizmo, view name + grid step,    |  translate       |
|  ▾ guides      |   cursor position (ortho), selection dims     |  rotate          |
+----------------+-----------------------------------------------+  scale           |
| status: cook time · counts · last error                        |  kind fields     |
+---------------------------------------------------------------+  attributes      |
                                                                 |  CONTROLS (vars) |
                                                                 +------------------+
```

- **Outputs / Outliner** (left): Outputs is the default tab. Cards grouped by graph list the main result, named
  published results, their textures, saved renders and exports, with thumbnails and loading/error states.
  Clicking a card isolates that result; Scene restores the previous scene camera, reference layers and guides.
  First explicit selection frames a model, then each output keeps its own camera. Updates never reframe.
  The Outliner tab keeps the existing tree. Output (the cooked result, the node being followed), the graph's nodes (click to
  view a node's result), inputs (reference layers, one per file in `inputs/`), guides (markers). Each row: visibility
  eye, display mode, name. Selection in the outliner and in the viewport are the same selection.
- **Viewport** (centre): single view or a 2×2 quad (persp, top, front, right). Each view prints its name and, for
  orthographic views, the grid step and the cursor's world position. An axis gizmo in a corner shows orientation and
  snaps the view to an axis when clicked.
- **Properties** (right): the selected object. For a guide: name, kind, translate / rotate / scale as editable
  numbers, kind fields (radius, height), and the attributes the LLM will read (`name`, `role`, `pscale`, `orient`).
  For a reference layer: file, counts, bbox, display mode, transform offset. For the output: the geometry summary.
  Below it, the graph's exposed vars as the Controls panel.
- **Node editor**: a second pane (tab or split under the viewport) in a later phase, editing the same graph JSON.

## 3. Navigation

Four keymap presets, chosen in the top bar and remembered per browser: **TopoTopo** (the default), **Maya**,
**Houdini** and **Blender**. Existing saved choices remain in use. A preset binds every action of section 9;
the actions themselves are the same. Navigation in TopoTopo needs no modifier keys:

| action | input |
|---|---|
| tumble | right drag |
| track | middle drag (also right drag in orthographic views) |
| zoom toward cursor | wheel |
| select / box-select | left click / left drag |
| frame selection | F |
| frame all | A |
| toggle single / quad view | Space (tap) |
| perspective / top / front / right | view menu, or 1 / 2 / 3 / 4 |
| wire / shaded / shaded + wire | 5 / 6 / 7 |
| orthographic toggle of the current view | O |

No inertia or damping: the camera moves only when the person navigates, frames, or first opens an output.
Loading a layer, placing a guide, saving or re-cooking never moves the camera. TopoTopo picks the nearest visible
mesh surface beneath the cursor on orbit start, without moving the camera, and holds that pivot for the drag.
A miss keeps that camera's previous pivot; selection does not override it. Pan moves the camera and pivot equally,
using surface depth when available. Wheel zoom anchors to the hit or the navigation-depth plane and cannot cross it.
Orbit remains upright; pointer cancellation and window blur release navigation. Other presets retain their
selection-centred orbit. Tumble becomes pan in TopoTopo orthographic views. Near and far
planes follow the scene size (logarithmic depth stays on) so a 1 km terrain and a 2 cm bolt both work.

## 4. Grid, units, readouts

- Metres, Y up. The ground grid lies on y = 0, adaptive: minor lines every `step`, major every 10 × step, `step`
  chosen from 0.01, 0.1, 1, 10, 100, 1000 m by zoom; the current step is printed in each view ("grid 1 m").
- World axes through the origin: X red, Y green, Z blue, drawn under the grid lines.
- Orthographic views print the cursor's world coordinates; every view prints the selection's bbox size while
  something is selected.
- The status bar shows the last cook time, point/prim counts and the last error, in one line.

## 5. Selection

- Click selects, Shift-click adds, Ctrl-click removes, drag in empty space box-selects, click in empty space
  clears. Esc clears the selection and leaves any mode.
- Selection highlight: one accent colour (orange, `#f0a030`) as an outline or wireframe over the object; hover
  shows a thinner, dimmer version. The pivot of the selection is drawn as a small cross.
- The outliner row of a selected object is highlighted; selecting a row selects in the viewport and vice versa.

## 6. Transform and snapping

- Gizmo on the selection: W move, E rotate, R scale (Maya keys); world / local toggle; axis handles and planar
  handles; the handle under the cursor highlights.
- Snapping, held or toggled (Maya): X grid, C curve or surface, V point (vertices of the output and of reference
  layers). Grid snapping uses the printed step; rotation snaps to 15°, scale to 0.1 when the grid snap is on.
- Typed values: the properties panel's translate / rotate / scale fields are editable and accept expressions such as
  `+2` or `*0.5`. Enter applies, Esc reverts.
- Every edit of a guide saves through the markers route; nothing is lost on reload.

## 7. Objects and how they are drawn

Guides keep the roles the LLM reads (`site`, `path`, `zone`, `volume`), drawn as the standard objects they are:

| role | editor name | drawn as |
|---|---|---|
| site | null | an axis cross (three short lines) at the point, oriented by `orient`; the radius as a thin circle only while selected or hovered; name on hover or selection |
| path | curve | a polyline with its CVs as small squares, a direction tick near the end, one colour; CVs are selectable and movable |
| zone | area | a closed curve with a subtle diagonal hatch inside (no solid fill) |
| volume | volume | a wire box with its size printed on one edge while selected |

- The output geometry: display modes shaded, wire, shaded + wire, points, bounding box; backfaces tinted blue and
  open or non-manifold edges drawn the way the render tool draws them (`help {topic:"render"}`), so a person and the
  LLM see the same thing.
- Reference layers (inputs): the same display modes per layer; ghost is a mode, not the default; PNG inputs stand
  as unlit image planes at their pixel aspect, one metre tall unless scaled.
- Labels never float permanently: hover or selection only, drawn in the UI font, not as sprites.
- Colours: viewport background neutral dark grey (`#2b2d31`), grid two greys, geometry matte with the material's
  base colour, guides one desaturated cyan, selection orange. No gradients, no glow.

## 8. Controls (exposed vars)

Unchanged in purpose: the graph's `params` draw as sliders, number fields, checkboxes, selects, vector fields and
colour pickers in the properties column; drags post at most every 100 ms and re-cook only what depends on the var;
reset per control. Undeclared vars appear under "other vars".

## 9. Keymap presets (complete)

One table of actions, four bindings. TopoTopo uses the navigation and shading bindings above, and Maya's other
bindings below. The page holds this as data (`app/keymap.js`), the top bar selects the
preset, `?` shows the active table as an overlay. Mouse buttons are L / M / R; "held" means the key acts while down.

| action | Maya | Houdini | Blender |
|---|---|---|---|
| tumble | Alt + L drag | Space + L drag | M drag |
| track | Alt + M drag | Space + M drag | Shift + M drag |
| dolly | Alt + R drag, wheel | Space + R drag, wheel | Ctrl + M drag, wheel |
| frame selection | F | Space+G | Numpad . |
| frame all | A | Space+H | Home |
| single / quad view | Space (tap) | Space+B | Ctrl+Alt+Q |
| perspective | Alt+1 | Space+1 | Numpad 5 (toggles with ortho) |
| top / front / right | Alt+2 / Alt+3 / Alt+4 | Space+2 / Space+3 / Space+4 | Numpad 7 / 1 / 3 |
| orthographic toggle | O | O | Numpad 5 |
| select mode | Q | S | W |
| move / rotate / scale | W / E / R | T / R / E | G / R / S |
| snap to grid (held) | X | X | Ctrl (held, with the snap target set to grid) |
| snap to surface or curve (held) | C | C | Ctrl (target: surface) |
| snap to point (held) | V | V | Ctrl (target: point) |
| snapping on / off | toolbar | toolbar | Shift+Tab |
| wire / shaded / shaded + wire | 4 / 5 / 6 | W (cycles) | Shift+Z (wire toggle), Z (cycles) |
| place a null / curve / area / volume | Shift+1 / 2 / 3 / 4 | Shift+1 / 2 / 3 / 4 | Shift+1 / 2 / 3 / 4 |
| finish a curve / remove its last point / cancel | Enter / Backspace / Esc | Enter / Backspace / Esc | Enter / Backspace / Esc |
| delete the selection | Delete | Delete | X, Delete |
| undo / redo (guides and vars) | Ctrl+Z / Ctrl+Y (also Z / Shift+Z) | Ctrl+Z / Ctrl+Y | Ctrl+Z / Ctrl+Shift+Z |
| hide the selection / show all | H / Shift+H | H / Shift+H | H / Alt+H |
| keymap overlay | ? | ? | ? |

Placement keys are the same everywhere because no application has a convention for them; Z was avoided (undo in
Maya). In the Houdini preset a tap of Space does nothing and Space is only a modifier. In the Blender preset the
snap target (grid, surface, point) is a top-bar choice and Ctrl applies it while dragging, as in Blender. Transform
and snapping bindings belong to phase 2 and stay unbound until then; the tables ship complete so a preset never
changes shape later.

## 10. Structure

`src/viewer/index.html` is replaced by a page that loads ES modules served by the viewer server from
`src/viewer/app/`, no build step, three.js from the served `/vendor/three/`:

```
app/main.js        boot, layout, undo stack
app/keymap.js      the action table and TopoTopo / Maya / Houdini / Blender presets, the overlay
app/api.js         the server routes (graphs, geo, vars, inputs, markers, events)
app/camera.js      surface navigation, views, quad layout, framing (no OrbitControls)
app/outputs.js     output cards, isolated previews, downloads and export dialog
app/image-view.js  image layers, channel display, pan/zoom, checkerboard and UV overlay
app/grid.js        adaptive grid, axes, axis gizmo, readouts
app/scene.js       output geometry, display modes, backface and edge overlays
app/layers.js      reference layers (inputs) with display modes
app/guides.js      nulls, curves, areas, volumes: drawing, placement modes, CV editing
app/select.js      picking, box select, highlight, pivot
app/gizmo.js       TransformControls wrapper, snapping, numeric edits
app/outliner.js    the tree
app/props.js       the properties panel and the Controls section
app/style.css
```

Logic that does not need a browser (snapping maths, grid step choice, marker validation, keymap tables, the undo
stack, selection set operations) lives in plain functions and is tested in Node (`test/viewer*.ts`); the browser
pane check with a screenshot is part of every viewer session's report.

## 11. Phases

1. **Viewport**: layout, Maya navigation, single and quad views, grid and readouts, selection, outliner, properties,
   guides redrawn as nulls / curves / areas / volumes, reference layer display modes, Controls moved into the
   properties column. The current markers, inputs and controls behaviour is kept; the look and the interaction are
   replaced.
2. **Transform**: gizmo, snapping, typed values, CV editing, undo and redo.
3. **Node editor**: nodes and wires for the same graph JSON, parameter panels from `ParamDef`, cook on edit through
   the existing routes; the engine moves into a Web Worker when the page needs to run without the Node server.

## 12. Non-goals

Modelling and sculpting tools, animation, rendering settings, a chat panel, cute defaults.

## 13. Images, publication and exports

- Graphs publish additional deliverables with `outputs: {id: {node, label?}}`; the existing `output` stays the
  default. Renaming/removing nodes maintains these references. Intermediate nodes remain in the outliner.
- Discover and cook outputs asynchronously. Cache previews by revision. Failed outputs stay listed, with an error
  and their last valid preview when available; background updates do not change the selected card or camera.
- Published images, including images in packed sources, expose every named layer. The 2D viewer has drag pan,
  cursor-centred wheel zoom, Fit, 100%, dimensions, RGB/RGBA/R/G/B/A, checkerboard and optional mesh UVs.
  Generated images default to RGB so an AO-packed alpha does not hide colour. Alpha can be viewed as greyscale.
- Open image and drop accept PNG, JPEG and WebP, keep originals under project inputs, and decode JPEG/WebP in the
  browser. This does not add JPEG/WebP to procedural image nodes. Each image remembers its zoom and pan.
- Export… operates on the actual cooked result, with format, filename, destination display and relevant options.
  GLB is the mesh default. Formats describe information they omit. Collision suffixes are automatic; Replace is
  explicit. A stale result must refresh before export, and its receipt records the source revision.
- Persistent exports live in workspace `exports/`, or beside the graph for `topotopo view`. The CLI and MCP
  register exports and renders (including explicit destinations); the viewer also discovers agent-written files.
  Saved bundles expose individual files and deterministic ZIPs retaining relative texture/sidecar paths.
- The viewer's output API serves validated catalogue identifiers, never arbitrary client-supplied file paths.
  Output-change SSE events refresh cards and contents. Asset history, FBX, painting and the node editor are deferred.
