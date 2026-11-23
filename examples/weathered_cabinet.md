# Weathered cabinet

A metal utility cabinet that has hung on an outside wall for years: chipped paint, rust runs, grime and dust.

## In
- wear: 0–1, default 0.5. How much paint chips off the edges and latch.
- dirt: 0–1, default 0.5. Grime, rain marks and dust.
- rust: 0–1, default 0.5. Rust in chips and runs from the hardware.
- age: 0–1, default 0.5. How long the cabinet has been exposed.
- exposure: one of outdoor, sheltered or indoor, default outdoor. Where the cabinet hangs.
- resolution: one of 256, 512 or 1024, default 512. Pixels along each side of every map.
- seed: 0–9999, default 1. Changes where the chips, patches and runs appear.

## Out
- cabinet (mesh): the cabinet with one weathered material, its colour, normal and occlusion-roughness-metal maps.
- masks (textures): the named masks the surface was made from.

## Promises
- maps: one material with colour, normal and ORM maps of resolution pixels.
- masks: the masks hold edge wear, cavity, dust, rust runs, dirt runs and fade.
- uv: no two faces share texels.

## Look
A pale grey cabinet with chipped edges showing grey primer and bare steel near the latch and hinges, orange rust runs below the hinges and bolts, grey rain marks under the louvres, dust on the top against the wall, darker grime in the seams.

## Cook
Up to 6 s: it bakes rays for the weathering masks at 512 pixels (5.1 s cold).
