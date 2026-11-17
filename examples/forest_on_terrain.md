# Forest on terrain

A forest with rocks on rolling terrain, ready for a game engine: trees on the gentle ground, rocks gathered on the
slopes, bare ground where it is too steep.

## In
- seed: 0–9999, default 1. Changes the hills and the layout, not the look.
- size: 50–500 m, default 200. Side of the square terrain.
- relief: 5–80 m, default 25. Height of the hills.
- tree_density: 0–1, default 0.6. How full the forest is.
- rock_density: 0–1, default 0.3. How many rocks lie on the slopes.
- max_slope: 10–60°, default 30. Steeper ground stays bare of trees.

## Out
- terrain (terrain): the ground, with paint layers for grass, forest floor and rock.
- trees (instances): pine, fir and oak trees, packed.
- rocks (instances): rocks of several shapes, packed.

## Promises
- slope: no tree stands on ground steeper than max_slope.
- grounded: every tree and rock stands on the ground; none floats or sinks.
- inside: every tree and rock stays within the terrain.

## Look
Rolling green hills under a dense mixed forest with clearings, grey rocks gathered on the steeper slopes and bare rock
on the steepest ground, seen from above at an angle.
