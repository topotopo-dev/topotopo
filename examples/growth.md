# Growth

A coral-like form that grows frame by frame, for a timelapse or a growth effect: it swells unevenly into knobs and
folds.

## In
- seed_size: 0.2–2 m, default 0.5. Size of the round seed it grows from.
- rate: 0.005–0.05 m, default 0.02. How far the surface grows each frame.
- lumpiness: 0–1, default 0.6. How unevenly it grows: 0 swells like a balloon, 1 throws out knobs.
- edge_length: 0.02–0.2 m, default 0.05. Edge length the surface keeps as it grows.
- seed: 0–9999, default 1. Changes where the knobs come out.

## Out
- form (mesh): the form at the current frame, one closed piece in a coral material.

## Promises
- closed: the form stays one closed piece facing out.
- grows: it is never smaller than the seed it started from.
- even: no edge is shorter than a quarter of edge_length.

## Look
A pale coral-like lump with rounded knobs and folds, evenly meshed, resting on the ground.
