# Unreal landscape

A landscape for Unreal Engine: an eroded terrain sized to fit an Unreal Landscape exactly, with paint layers, a road,
and trees and rocks as instances.

## In
- samples: one of 127, 253 or 505, default 253. Samples along each side, a size Unreal Landscape takes as it is.
- spacing: 0.5–4 m, default 1. Distance between two samples.
- height: 10–200 m, default 40. Height of the mountains.
- tree_density: 0–1, default 0.5. How full the forest on the gentle ground is.
- rock_density: 0–1, default 0.4. How many rocks lie on the steep slopes.
- road: on or off, default on. A road winding across the map.
- seed: 0–9999, default 1. Changes the mountains and the layout, not the look.

## Out
- landscape (terrain): the ground, with the weight layers grass, rock and road.
- trees (instances): pine, fir and oak trees on gentle ground away from the road, packed.
- rocks (instances): rocks on the steep slopes, packed.
- road (mesh): the road surface winding along the mountain's +Z flank in TopoTopo (+Y in Unreal).

`topotopo init --example unreal_landscape <folder>` makes it a package that uses `topotopo/nature`. In Unreal, **Place Terrain in Level** (or `TopoTopo.PlaceTerrain`) places the four outputs together.
To export the entire scene as one Landscape bundle, select the `level_out` node, in the package folder:

```text
topotopo graphs/main.json --node level_out --format unreal_landscape --export out/level
```

## Promises
- fits_unreal: the ground has a size Unreal Landscape takes as it is, without resampling.
- clear_road: no tree or rock stands on the road.
- grounded: every tree and rock stands on the ground; none floats or sinks.

## Look
An eroded massif seen from above at an angle: a road winding across it, forest on the gentle ground, grey rocks on the
steep slopes, and the grass, rock and road layers painted where they belong.
