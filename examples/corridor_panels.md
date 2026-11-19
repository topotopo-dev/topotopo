# Corridor panels

A sci-fi corridor wall on one trim sheet: a frame, a row of panels fitted to a hotspot rectangle, a small sign on its own rectangle, and a rail along the top.

## In
- width: 1.6–3 m, default 2. Width of the wall.
- height: 2.2–3 m, default 2.5. Height of the wall.
- columns: 2–4, default 3. Panels across the wall.
- gap: 0.04–0.1 m, default 0.06. Gap around and between the panels.
- seed: 0–999, default 1. Tie-break for the hotspot fit.

## Out
- wall (mesh): the wall, frame, panels, sign and rail.

## Promises
- wall: the wall fills its width and height and stays in front of its back face.
- mapped: every face names a band or rectangle of the sheet.
- sheet: the sheet description is carried on the geometry.
- uv: every face has uv.

## Look
A dark metal wall with a row of lighter panels, a small sign low on the right, and a rail along the top. The sheet view shows the frame and rail bands and the two rectangles, in the same colours as the model.
