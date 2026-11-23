# Rusty drum

A steel drum left standing outside on the ground for years: faded paint, rust at the rims, rain marks and a muddy splash line.

## In
- wear: 0–1, default 0.5. How much paint chips off the hoops and rims.
- dirt: 0–1, default 0.5. Rain marks, stains and mud splash.
- rust: 0–1, default 0.5. Rust along the worn steel.
- age: 0–1, default 0.5. How long the drum has been outside.
- resolution: one of 256, 512 or 1024, default 512. Pixels along each side of every map.
- seed: 0–9999, default 1. Changes where the marks appear.

## Out
- drum (mesh): the drum with one weathered material and its maps.

## Promises
- maps: one material with colour, normal and ORM maps of resolution pixels.
- standing: the drum's lowest point is at height 0.
- uv: no two faces share texels.

## Look
A blue drum, paint chalky on top and on the sunny side, rust along the rolling hoops and the rims, water marks and a brown pool stain on the lid, a ragged band of mud splash around the foot.

## Cook
Up to 6 s: it bakes rays for the weathering masks and a lid stain at 512 pixels (4.3 s cold).
