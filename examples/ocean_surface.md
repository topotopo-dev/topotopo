# Ocean surface

An animated ocean surface for a water plane: rolling swells with smaller waves on top, moving with time, with foam
where the waves crest.

## In
- size: 10–500 m, default 100. Side of the square patch.
- wave_height: 0–6 m, default 1.5. Height of the largest swells.
- wave_length: 5–100 m, default 30. Distance between the largest swells.
- choppiness: 0–1, default 0.4. How sharp the crests are.
- wind_direction: 0–360°, default 30. Where the waves run to.
- detail: 0.25–4 m, default 1. Distance between the surface's vertices.
- seed: 0–9999, default 1. Changes the waves, not the sea state.

## Out
- surface (mesh): the water surface at the current frame, with uv and a foam value, in a water material.

## Promises
- height: the waves stay within wave_height above and below sea level.
- foam: every point carries a foam value between 0 and 1.
- size: the patch covers exactly size by size, so patches tile.

## Look
A deep blue-green sea seen at a low angle: long swells running with the wind, smaller waves on their backs, and pale
foam along the sharpest crests.
