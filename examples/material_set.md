# Material set

A set of tileable game materials made from scratch: rough stone blocks, wood planks and worn painted metal, each with
colour, normal and packed roughness maps.

## In
- resolution: one of 256, 512 or 1024, default 512. Pixels along each side of every map.
- tile_size: 0.5–4 m, default 1. Metres one tile of each material covers.
- wear: 0–1, default 0.4. How worn the edges and the paint are.
- dirt: 0–1, default 0.3. Dirt and grime in the cracks.
- seed: 0–9999, default 1. Changes the patterns, not the materials.

## Out
- stone (material): rough stone blocks with dark mortar.
- wood (material): wood planks with grain and knots.
- metal (material): painted metal plates with chipped paint and rust.
- swatches (mesh): a sample tile of each material, side by side.

## Promises
- swatches: one swatch per material, each with uv.
- maps: every material has colour, normal and roughness maps of resolution pixels.

## Look
Three square swatches side by side: grey stone blocks with dark mortar, warm brown planks with visible grain, and blue
painted metal plates with chipped edges and rust running from the rivets. Each tiles without a visible seam.
