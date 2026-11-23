# Worn machine

A small workshop machine indoors: worn paint where hands and tools touch it, oily grime in the corners, dust on top; no rain and no rust runs.

## In
- wear: 0–1, default 0.5. Wear on the handle, lever and painted edges.
- dirt: 0–1, default 0.5. Oily grime and dust.
- age: 0–1, default 0.5. How long the machine has been used.
- resolution: one of 256, 512 or 1024, default 512. Pixels along each side of every map.
- seed: 0–9999, default 1. Changes where the wear and dirt collect.

## Out
- machine (mesh): the machine with one weathered material and its maps.
- masks (textures): its masks.

## Promises
- maps: one material with colour, normal and ORM maps of resolution pixels.
- masks: the masks hold edge wear, handled, cavity and dust.
- uv: no two faces share texels.

## Look
A green-grey machine with bright worn metal on the handle and lever edges, dark glossy grime in the corners and around the motor, a grey dust film on top, no streaks.

## Cook
Up to 6 s: it bakes rays for the weathering masks at 512 pixels (4.0 s cold).
