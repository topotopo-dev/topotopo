# Image cutouts and texture atlases

These are general image/geometry operations. Plant structure, deformation, normal shaping and LOD remain graphs
built from existing nodes. See [the runnable graph](../examples/image_cutouts.json) and
[its preview](../examples/renders/image_cutouts.png). Run `npm run test:imageops` for the focused tests.

```sh
node src/cli.ts examples/image_cutouts.json --export out/image_cutouts.glb
node src/cli.ts view examples/image_cutouts.json
```

The example uses procedural images, including a perforated shape, disconnected islands and narrow strips.
It crops, traces, fills, restores UVs, deforms and copies meshes, packs three aligned maps, remaps UVs and exports
one double-sided masked material. Its repeated copies deliberately share UVs (the UV view reports overlap).
Replace the procedural source images with `image_file` nodes to use generated or authored textures.

## Extract and trace

`tex_crop` selects an image by name and transforms **all** its layers together. `origin:[x,y]` starts at the
top-left pixel. `size:[w,h]` selects the crop; zero means the remaining source extent on that axis.
`resolution:[0,0]` preserves crop size. Outside pixels are zero, without wrapping. `filter:"nearest"`
preserves categorical masks; `"filtered"` uses existing area/bilinear resizing. No transfer curve or normal-vector
renormalization is applied. Cropping without resizing copies exact values.

`trace_image` selects an image/layer/channel and traces the foreground where values are at least `threshold`.
Alpha requires RGBA; use `channel:"luminance"` or R/G/B for a grey mask. Contours follow pixel-cell boundaries.
Foreground uses **4-connectivity**, so diagonal contacts stay separate. `min_area` measures connected foreground
pixels and removes an entire component, retaining the holes of surviving components.

The output is closed XY curves with point `uv`, primitive `class` (stable row-major component ID),
`contour_id` and `hole` (0/1). IDs may have gaps after filtering. Outer contours are counter-clockwise in XY,
holes clockwise. The canvas starts at (0,0), has `width` metres along X, and follows the original aspect along Y.
Transparent margins are retained. Detail `image_size` is [widthPixels,heightPixels]; `image_width` is metres.
Simplification only accepts removals that do not cross or swallow another boundary and whose accumulated
distance error stays within `tolerance` pixels. It can retain more vertices than a plain polyline simplifier.
Components with zero-width boundary contacts retain their exact contours, preserving downstream fill behavior.

`fill` reconstructs faces and does not preserve contour attributes. Rebuild UVs **before deformation**:

```json
{"type":"uv_project","params":{"method":"planar","axis":"z","scale":[1,0.5]}}
```

Here the traced width is 1 metre and the source canvas is twice as wide as it is tall.
Use canvas dimensions rather than the silhouette bounding box. Connect the original image branch separately
to `texture_to_material`; it supplies textures without merging image/layout geometry into the mesh.

## Pack aligned maps

Combine named images with `merge`, then use `tex_pack`:

```json
{
  "resolution": [2048, 2048],
  "padding": 8,
  "name": "atlas",
  "items": [
    {"name":"leaf_a","maps":{"color":"leaf_a_color","normal":"leaf_a_normal","roughness":"leaf_a_rough"}},
    {"name":"leaf_b","maps":{"color":"leaf_b_color","normal":"leaf_b_normal","roughness":"leaf_b_rough"}}
  ]
}
```

Every item must provide the same map labels. Maps within an item have matching pixel dimensions; a given map
label has the same channel count across items. Inputs use their main layers (`tex_output` can extract another
layer first). Empty `items` packs each input image as an item under map label `C`.

The deterministic skyline packer keeps native resolution and does not rotate. An overflow is an error with
a hint to resize inputs or change atlas dimensions/gutters. The image outputs above are `atlas_color`,
`atlas_normal` and `atlas_roughness`. Unoccupied pixels and gutters are zero.

One placement point per item, in **items order**, exposes:

| Attribute | Meaning |
|---|---|
| `name` | Item name |
| `rect` | Integer [x,y,width,height], top-left pixel origin, excluding gutters |
| `uv_offset` | [x/atlasWidth, 1-(y+height)/atlasHeight] |
| `uv_scale` | [width/atlasWidth, height/atlasHeight] |

Detail `atlas_size` is [width,height]. Point positions are rectangle centres in UV space for inspection.
To remap mesh UVs, feed the mesh into wrangle input 0 and the atlas into input 1; run over vertices:

```js
const offset = point(1, "uv_offset", 0);
const scale = point(1, "uv_scale", 0);
@uv = [@uv.x * scale[0] + offset[0], @uv.y * scale[1] + offset[1], 0];
```

Use the appropriate item index instead of 0. Placement points are metadata: do not merge them into the mesh.
Use `texture_to_material` to attach the atlas images.

## Padding and opacity

`tex_dilate` copies the nearest valid source into a band of `radius` pixels. It uses RGBA alpha by default,
or an explicit same-sized mask through input 1 with `mask_image`, `mask_layer` and `mask_channel`.
Validity is strictly greater than `mask_threshold`. Grey source images require an explicit mask.
Like every texture filter it names its result after its own node; to pad one image of the atlas in place, set
`name` to that image's name (the example's `{"image":"cutouts_color","name":"cutouts_color"}`).

Valid pixels and pixels outside the band are untouched. `preserve_alpha:true` retains every original alpha
value while padding RGB. The nearest-site tie rule is topmost then leftmost. For atlas data/normal maps use
the color atlas alpha as the explicit mask. Keep dilation radius within the allocated gutter. Padding reduces
filtering halos; it does not guarantee separation at arbitrarily small mip levels or preserve alpha coverage
across every mip. Resizing masks and choosing the runtime cutoff remain graph/material decisions.

Create the material first:

```json
{"type":"material","params":{"name":"cutouts","alpha_mode":"mask","alpha_cutoff":0.5,"double_sided":true}}
```

Then assign maps with `texture_to_material`. Explicit `opaque`, `mask`, and `blend` modes survive JSON and
standard GLB import/export. `auto` is the legacy scalar/vertex-alpha inference, including its opaque default.
Masking multiplies material opacity, base-color texture alpha and vertex `Alpha`, discarding below the cutoff.
The headless renderer discards masked samples before depth writes; the live viewer uses the GLB material.
Headless preview still samples image volumes rather than external texture paths: load PNGs with `image_file`.
This upgrade adds masked preview, not a new order-independent blended-transparency renderer.

## Limits and verification

Existing image limits apply (at most 4096² pixels per image). Crop and resized outputs are both checked.
Packing accepts at most 4096 items and 1 GiB of output layers. Tracing stops at one million boundary edges with
a crop/resolution/filtering hint rather than constructing unbounded geometry.

`test/imageops.ts` covers pixel accuracy, topology (including all 512 binary 3×3 masks), source immutability,
map alignment and UV placement, alpha/depth behavior, GLB validation/import and the complete example.
All four nodes also have registry examples, fixtures and golden fingerprints.

