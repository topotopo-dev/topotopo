# Asset cleanup

A rough, broken scan turned into a game-ready asset: holes filled, tangles removed, even triangles, clean UVs and
levels of detail.

## In
- source: one of rock or column, default rock. The made-up scan to clean: a lumpy rock or a cracked column.
- detail: 0.02–0.2 m, default 0.05. Edge length of the cleaned mesh.
- lods: 1–4, default 3. Levels of detail after the full one.
- lod_ratio: 0.2–0.8, default 0.5. Share of the triangles each level keeps of the one before.
- texel_density: 128–2048, default 512. Texture pixels per metre the UVs are laid out for.
- seed: 0–9999, default 1. Changes the made-up scan, not the cleanup.

## Out
- asset (mesh): the cleaned asset, with uv.
- lods (mesh): its levels of detail, each a piece named for its level.

## Promises
- closed: the asset is one closed piece facing out, without holes or tangles.
- even: no edge is shorter than a fifth of detail.
- uv: every face has uv inside the 0 to 1 square.

## Look
The cleaned rock (or column) with an even triangle wireframe, a checker-textured copy beside it, and its smaller levels
of detail in a row.
