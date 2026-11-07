# Sci-fi panel

A sci-fi wall panel for a game level: a framed plate broken into recessed sections, with vents, pipes and small
greebles, that tiles side by side.

## In
- width: 1–8 m, default 3. Width of the panel.
- height: 1–6 m, default 3. Height of the panel.
- sections: 1–6, default 3. Recessed sections across the panel.
- depth: 0.02–0.3 m, default 0.1. How deep the sections are recessed.
- greebles: 0–1, default 0.5. How busy the small details are.
- bevel: 0–0.02 m, default 0.01. Rounding of every hard edge.
- seed: 0–9999, default 1. Changes the details, not the layout of the sections.

## Out
- panel (mesh): the panel, with uv, in painted metal and dark rubber.

## Promises
- tiles: the panel fills exactly width by height, so panels side by side meet without gaps or overlaps.
- flat_back: nothing sticks out behind the wall it hangs on.
- uv: every face has uv.

## Look
A dark grey metal panel with a raised frame, recessed sections with vents and panel lines, pipes and small boxes in the
recesses, and softly bevelled edges catching the light.
