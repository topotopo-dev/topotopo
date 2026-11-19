# Cloth drape

A tablecloth draped over a table: it falls over the edges in soft folds and rests on the table top, a set-dressing
prop.

## In
- table_width: 0.6–3 m, default 1.6. Width of the table.
- table_depth: 0.6–2 m, default 0.9. Depth of the table.
- cloth_size: 1–4 m, default 2.4. Side of the square cloth.
- stiffness: 0–1, default 0.3. How stiff the cloth is: 0 hangs like silk, 1 like canvas.
- thickness: 0.002–0.02 m, default 0.004. Thickness of the cloth.
- seed: 0–9999, default 1. Changes how the folds fall.

## Out
- cloth (mesh): the draped cloth, with uv, in linen.
- table (mesh): the table it lies on, in wood.

## Promises
- above_floor: no part of the cloth goes below the floor.
- rests: the cloth's highest point is the table top, give or take its thickness.
- uv: every face of the cloth has uv.

## Look
A light linen cloth lying on a wooden table, hanging over all four edges in soft vertical folds, its corners falling
into points, nothing poking through.
