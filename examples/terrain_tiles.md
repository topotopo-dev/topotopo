# Terrain tiles

A large terrain cut into square tiles that join without seams, so a big map can be cooked, streamed and exported one
tile at a time.

## In
- map_size: 256–4096 m, default 1024. Side of the whole map.
- tiles: 2–8, default 4. Tiles along each side of the map.
- tile_x: 0–7, default 1. Column of the tile cooked on its own, kept within the map.
- tile_z: 0–7, default 2. Row of the tile cooked on its own, kept within the map.
- relief: 10–400 m, default 120. Height of the escarpments.
- river: on or off, default on. A river winding across the map.
- seed: 0–9999, default 1. Changes the landforms, not the look.

## Out
- map (terrain): the whole map.
- tile (terrain): one tile, cooked on its own.

## Promises
- seamless: the tile cooked on its own matches the map where it lies, sample for sample.
- height: the ground stays between 0 and relief.

## Look
A wide map of winding escarpments with a river valley across it, and the chosen tile lifted above the spot it matches,
its edges lining up with the land around it.
