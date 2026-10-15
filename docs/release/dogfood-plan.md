# Real-life testing week (dogfooding), October 16–19

Goal: use the published package and the Unreal plugin exactly as a new user would, build one real environment,
and turn every rough edge into a fix or an issue before v0.2 and the video.

## Setup as a user (day 1, morning)
- Fresh folder, Node 22: `npx -y topotopo --help`, `npx -y topotopo mcp` wired into Claude Code's `.mcp.json`
  (the README's snippet, nothing from the repo checkout).
- Fresh Unreal 5.8 project: copy the packaged plugin, enable it, restart; `TopoTopo.ImportScene` on a bundle
  exported by the published CLI, not the repo's demo files.
- Note every step where the README was not enough: those become doc fixes first.

## The target: a small playable environment
1. Terrain: 1 km², heightfield noise → erosion (pipe model) → `heightfield_fill_sinks` → roads via
   `project_curve`, a river from the flow layer; export the Landscape bundle with weight layers.
2. Village: 20–30 houses from the `house` generator on lots along the road, varied per lot; a wall and a gate
   from the shelf; a market square with crates settled by `rbd_stack`, a tarp draped over a stall.
3. Vegetation and props: masks from slope/flow/road distance → scatter → packed instances (5–8 variants);
   rocks settled on the slopes; particles runoff trails baked to curves for a dry creek bed.
4. Textures: procedural brick/roof/ground sets with AO/curvature bakes for the houses.
5. Export: `unreal_landscape` (tiled, 2×2), `scene.glb` for Blender/Houdini, the instance CSV for PCG.
6. In Unreal: one-command import, PCG graph with the plugin nodes, a quick lighting pass, a walk-through at
   player scale: what looks wrong at eye level, what pops, what is too slow.

## What to record
- A friction log (docs/release/dogfood-log.md): time per step, confusing params, missing nodes, slow cooks
  (anything over 5 s at this scale), wrong defaults, docs gaps, Unreal import warnings.
- Hard bugs → fixed the same day with a failing-first test; design gaps → GitHub issues labelled `dogfood`.
- Screenshots and short clips from the walk-through: candidates for the video and the README.

## Exit criteria
- The environment can be rebuilt from its graph JSON by `npx topotopo` in one command with no manual step.
- Every friction item is fixed, filed or consciously deferred (noted with a reason).
- v0.2 tag follows the fix batch.
