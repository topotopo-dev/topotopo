# Blob creature

A cartoon creature made of smooth blended shapes: a round body, a head, legs and a tail that melt into each other, and
two eyes, as a closed mesh.

## In
- body_size: 0.3–2 m, default 1. Length of the body.
- head: 0.3–1, default 0.6. Size of the head next to the body.
- legs: 2–8, default 4. Number of legs.
- tail: 0–2, default 0.8. Length of the tail next to the body; 0 leaves it off.
- blend: 0.02–0.4 m, default 0.15. How softly the parts melt into each other.
- spines: 0–1, default 0.5. Rounded spines in a row along the back; 0 leaves them off.
- feature_size: 0.02–0.1 m, default 0.04. Size of the smallest feature kept.
- seed: 0–9999, default 1. Changes the pose of the legs.

## Out
- creature (mesh): the body as one closed piece with uv in a skin material, and two eyes.

## Promises
- closed: the body is one closed piece facing out, without tangles.
- standing: the creature stands on its feet, its lowest point on the ground.

## Look
A friendly, rounded creature standing on stubby legs, its head and tail melting smoothly into the body, a row of
rounded spines along its back and two dark eyes.
