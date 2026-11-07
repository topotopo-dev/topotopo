# Town from lots

A town quarter built from a plan: the ground is cut into irregular lots along streets, and every lot gets a house that
follows its shape, with a roof that fits.

## In
- area: 60–400 m, default 120. Side of the square quarter.
- lots: 4–60, default 20. How many lots the quarter is cut into.
- street_width: 4–12 m, default 6. Width of the streets between the lots.
- floors: 1–5, default 2. Floors of an ordinary house.
- extra_floors: 0–3, default 1. Floors a few houses get on top, at random.
- roof_pitch: 15–60°, default 35. Slope of every roof.
- seed: 0–9999, default 1. Changes the plan and which houses grow taller.

## Out
- houses (mesh): every house, with walls, windows, doors and a roof.
- lots (curves): the outline of every lot, for gardens, fences or paths.
- streets (mesh): the street surface between the lots.

## Promises
- one_per_lot: every lot has exactly one house.
- inside: the town stays within the quarter.
- grounded: every house stands on the ground, none sinks below the street.

## Look
A dense town quarter from above at an angle: irregular blocks of houses of different heights, pitched and hipped roofs
that follow every footprint, grey streets between them. No two houses overlap.
