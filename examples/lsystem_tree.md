# L-system tree

A stylised tree grown from rules: a trunk that branches again and again, thinning as it goes, with leaf cards at the
tips, for a low-poly game.

## In
- generations: 2–7, default 5. How many times the branches split.
- angle: 10–60°, default 25. Angle between a branch and its parent.
- height: 2–20 m, default 6. Height of the tree.
- taper: 0.4–0.95, default 0.7. How much thinner each branch is than its parent.
- leaf_size: 0–1 m, default 0.3. Size of the leaf cards; 0 leaves the tree bare.
- seed: 0–9999, default 1. Changes the twists and the leaves.

## Out
- tree (mesh): trunk and branches in bark, leaf cards in a leaf material, all with uv.

## Promises
- grounded: the trunk starts on the ground and the tree stays within height.
- uv: every face has uv.

## Look
A tree with a sturdy trunk splitting into ever thinner, slightly twisted branches, clusters of green leaf cards at the
tips, standing on the ground.
