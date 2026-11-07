# Rail along a curve

A railing and pipes that follow a path: posts at even spacing, a handrail and pipes bending smoothly around every
corner.

## In
- length: 5–100 m, default 24. Length of the path.
- corner_radius: 0–3 m, default 0.8. How round the path's corners are.
- post_spacing: 0.5–5 m, default 1.5. Distance between two posts.
- rail_height: 0.6–1.5 m, default 1. Height of the handrail.
- pipes: 0–4, default 2. Pipes running beside the railing.
- pipe_radius: 0.02–0.2 m, default 0.05. Radius of every pipe.
- seed: 0–9999, default 1. Changes the path's turns.

## Out
- railing (mesh): the posts and the handrail, in painted steel.
- pipes (mesh): the pipes, in copper.
- path (curves): the path everything follows.

## Promises
- spacing: no two neighbouring posts stand farther apart than post_spacing.
- closed: every post, rail and pipe is a closed piece.
- height: the handrail stays at rail_height above the path.

## Look
A steel railing with evenly spaced posts and a smooth handrail winding along a path with rounded corners, and copper
pipes running beside it at a constant distance, bending with it.
