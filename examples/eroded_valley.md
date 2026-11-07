# Eroded valley

A mountain valley worn by rain: sharp ridges, gullies and sediment fans, with a river along the valley floor, as a
terrain for a game engine.

## In
- size: 100–2000 m, default 400. Side of the square terrain.
- height: 20–600 m, default 150. From the valley floor to the highest ridge.
- erosion: 0–1, default 0.6. How long the rain wears the ground; 0 leaves it raw.
- river_depth: 0–20 m, default 4. How deep the river cuts into the valley floor.
- seed: 0–9999, default 1. Changes the mountains, not the look.

## Out
- terrain (terrain): the eroded ground, with layers for water flow, sediment and the river.
- river (curves): the river's course along the valley floor.
- preview (mesh): the terrain as a coloured mesh, rock on the slopes, grass on the floor and water in the river.

## Promises
- height: the ground stays between 0 and height.
- downhill: the river runs downhill all the way from its start to its end.

## Look
A deep valley between ridged mountains, seen from above at an angle: gullies down every slope, pale sediment fans where
they reach the floor, and a dark river channel winding along the bottom.
