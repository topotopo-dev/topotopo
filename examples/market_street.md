# Market street

A town street ready for a level: a road with kerbs, pavements and lamp posts, a row of houses along one side and a
small park with paths, trees and benches on the other.

## In
- length: 40–200 m, default 80. Length of the street.
- road_width: 5–14 m, default 8. Width of the road between the kerbs.
- house_width: 6–16 m, default 10. Frontage of each house; as many houses as fit along the street.
- floors: 1–4, default 2. Floors of every house.
- lamp_spacing: 8–40 m, default 16. Distance between lamp posts, on both pavements.
- park_density: 0–1, default 0.5. How full of trees and bushes the park is.
- seed: 0–9999, default 1. Changes the houses' details, the props and the trees, not the layout.

## Out
- street (scene): the road, kerbs, pavements, lane markings and lamp posts.
- houses (scene): the houses, with walls, windows, doors and roofs.
- park (scene): the lawn, paths, trees, bushes and benches.
- block (scene): all of it together.

## Promises
- grounded: nothing reaches below the ground.
- fits: everything stays within the street's length and 70 m across it.
- lamps: lamp posts line both pavements, never more than lamp_spacing apart.

## Look
A sunny street seen from above at an angle: grey asphalt with white markings, lamp posts on both pavements, a row of
houses with varied roofs on one side and a green park with paths, trees and benches on the other. Nothing floats or
sinks.
