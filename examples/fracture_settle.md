# Fracture and settle

A stone wall that breaks into pieces which fall and come to rest on the ground, for a destruction effect or a ruin.

## In
- wall_width: 2–12 m, default 5. Width of the wall.
- wall_height: 1–6 m, default 2.5. Height of the wall.
- thickness: 0.1–1 m, default 0.4. Thickness of the wall.
- pieces: 10–200, default 40. How many pieces it breaks into.
- impact: 0–1, default 0.5. How hard the wall is hit in its middle; 0 lets it collapse.
- seed: 0–9999, default 1. Changes the cracks and the fall.

## Out
- broken (mesh): the pieces where they come to rest, in stone with their broken faces in raw stone.
- intact (mesh): the wall before it falls, already cut into the same pieces.

## Promises
- pieces: the wall breaks into exactly pieces closed pieces.
- whole: together the pieces hold as much stone as the wall.
- rest: every piece lies on or above the ground.

## Look
A heap of stone chunks at the foot of where the wall stood, a few pieces thrown farther, rough grey broken faces
showing on every piece.
