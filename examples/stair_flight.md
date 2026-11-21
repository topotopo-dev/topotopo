# Stair flight

A straight stair flight mapped onto one trim sheet: stone treads and risers, a cheek wall in courses, and a metal handrail with a post at each end.

## In
- steps: 3–6, default 4. Treads in the flight.
- rise: 0.15–0.2 m, default 0.17. Riser height.
- run: 0.25–0.32 m, default 0.28. Tread depth.
- width: 0.9–1.3 m, default 1.1. Width of the flight.
- rail_height: 0.85–1.05 m, default 0.95. Handrail height above the slope.
- rail_radius: 0.02–0.04 m, default 0.025. Handrail and post radius.

## Out
- flight (mesh): the flight, with every face on the stair sheet.

## Promises
- flight: the flight fills its run, its rise and its width, rail included.
- mapped: every face names a band of the sheet.
- sheet: the sheet description is carried on the geometry.
- named: every face is named.
- uv: every face has uv.

## Look
Stone steps beside a cheek wall, with a dark metal handrail rising along them. The sheet view shows the bands, and the model is coloured the same way, one colour per band.
