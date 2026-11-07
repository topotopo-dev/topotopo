# Sparks

A burst of sparks for an effect: hot sparks fly out from a point, fall, bounce on the floor and cool down over a few
seconds.

## In
- count: 50–5000, default 600. Sparks in the burst.
- speed: 1–20 m/s, default 6. How fast they fly out.
- spread: 5–180°, default 60. Width of the cone they fly out in.
- bounce: 0–1, default 0.4. How much of its speed a spark keeps when it hits the floor.
- life: 0.5–5 s, default 2. How long a spark glows.
- seed: 0–9999, default 1. Changes each spark's path, not the burst.

## Out
- sparks (points): the sparks at the current frame, with velocity, age and colour.
- trails (curves): each spark's path over its last few frames, for streaks.

## Promises
- floor: no spark goes below the floor.
- age: no spark is older than life.
- count: there are never more than count sparks.

## Look
A fountain of orange-white sparks frozen mid-flight, streaks bending down under gravity, some bouncing off the floor in
a ring around the source, the oldest dimming to dark red.
