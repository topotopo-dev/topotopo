# Guided town

A village laid out along your own guides: the roads, house plots, fences, woods and clearings you draw in the viewer
become a finished village, built again whenever you move one.

## In
- road_width: 3–14 m, default 7. Width of the asphalt of every road.
- lamp_spacing: 6–60 m, default 18. Distance between lamp posts along a road, on both sides.
- floors: 1–4, default 2. Floors of every house.
- roof_pitch: 10–60°, default 32. Slope of every roof.
- tree_density: 0–0.08, default 0.02. Trees and bushes per square metre of woodland.
- keep_clear: 0–20 m, default 4. How far trees stay from roads, houses and fences.
- seed: 0–1000, default 1. Changes where the trees stand, not the layout.

## Out
- village (scene): the meadow, roads with lamp posts, houses on their plots, fences, trees and bushes.

## Promises
- clear: no tree or bush of the woods stands within keep_clear of a road, a house or a fence.
- grounded: nothing reaches below the meadow.

## Look
A village seen from above at an angle: grey roads with lamp posts on both sides, houses with hipped roofs filling their
plots, picket fences, and woods of trees and bushes around a clearing, all on a green meadow.
