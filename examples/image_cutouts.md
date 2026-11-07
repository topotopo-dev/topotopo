# Image cutouts

Game props cut out of pictures: the shapes in each picture are traced into flat, double-sided cards that keep the
picture as a masked texture, all packed into one atlas, for foliage, decals and background props.

## In
- outline: 0.2–4 px, default 0.8. How far the outline may stray from the picture's edge; more cuts fewer polygons.
- bend: 0–0.5 m, default 0.16. How far each card bends out of flat.
- copies: 1–6, default 2. Copies of each card, stacked and turned.
- padding: 0–16 px, default 8. Colour bled around each shape in the atlas, against seams seen from far.
- atlas_size: one of 256, 512 or 1024, default 512. Width of the atlas in pixels.

## Out
- cards (mesh): the cut-out cards, with uv into the atlas and one double-sided, alpha-masked material.
- atlas (textures): the packed colour, normal and roughness maps.

## Promises
- in_atlas: every card's uv stays inside the atlas.
- holes: a hole in a shape stays a hole in its card.

## Look
Rows of bent cards cut from three pictures (a ring with a hole, scattered round islands and narrow strips), each card
showing its picture with clean cut edges, beside the atlas they share.
