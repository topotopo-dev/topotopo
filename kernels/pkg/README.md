# topotopo-kernels

Original Rust implementation of a kinetic, weighted straight skeleton, mitered polygon
offsets, and hip/gable roof surfaces. The checked-in `pkg/` is the browser-compatible
WebAssembly build; normal TopoTopo users do not install Rust. See [BUILD.md](BUILD.md).

## Heightfield erosion (session 4)

`src/wasm/kernels.ts` exposes `erode_droplet`, `erode_pipe`, `thermal_erode`, and
`flow_accumulation`. Heights and optional hardness/freeze/rain maps are flat row-major
`Float32Array` buffers. Width is X, rows are Z, height is Y, and cell size is metres.
Kernel angles are radians; node angles remain degrees. Inputs are never modified.
All six erosion result layers are f32: `height`, `sediment`, `debris`, `flow`, `water`,
`wear`. Seeds are explicit u64 in Rust/bigint at the WASM boundary. The TypeScript
adapter accepts numbers too and passes their exact JS-compatible initial RNG state,
including negative/fractional seeds. Native/bigint calls use the u64 seed directly.

The droplet solver ports the existing seeded, tiled droplet model with f64 working
arrays, inertia, weighted erosion brushes, deposit smoothing, evaporation and a
separate eight-neighbour thermal pass. It retains signed net sediment/debris and raw
flow/water accumulations internally. The node adds/clips deposits and normalises the
two water masks exactly as before. Fully frozen samples cannot receive deposits;
weights are renormalised onto unfrozen receivers. This corrects the JS model's
partial-mask deposition leak on the opt-in kernel path. Droplet `wear` sums positive
net eroded depth per pass, so erosion followed by redeposition in that same pass is
not counted as gross wear.

The pipe solver implements four nonnegative virtual outflows per sample, following
the shallow-water approach of [Mei, Decaudin and Hu (2007)](https://evasion.imag.fr/Publications/2007/MDH07/)
and the terrain-modelling context of [Št'ava et al. (2008)](https://www.cs.purdue.edu/cgvlab/www/publications/Stava08SCA/).
It is an original implementation, with no copied reference source. Rain is a uniform
depth rate optionally multiplied by a rain map; this model does not consume the seed.
The timestep is at most `0.4 * cell / (max_velocity + sqrt(gravity * max_depth))`,
using at least one cell of depth and an upper bound on incoming rain. `time_step` is an optional upper
bound. Each cell's total outflow is limited by available water. Velocities are capped
to a 0.45-cell travel distance per step. Carry capacity depends on slope, velocity
and water depth; hardness scales excavation. Hydraulic/stream incision cannot remove
more than a quarter of the local downward relief per step.

Sediment follows forward semi-Lagrangian characteristics with a conservative
bilinear scatter and a subtraction remainder on the last receiver. Remaining load
settles at the end of a call; `sediment` records deposited thickness, `debris` thermal
deposits, `water` actual depth and `flow` normalised integrated speed. Closed edges
keep water/material; open pipe edges lose water **only**, keeping rock in-grid.
Droplet open edges retain their original behaviour of losing the carried load.
Pipe thermal transport is a separate conservative eight-neighbour talus pass.
Optional stream power is `K * A^m * S^n`; reference contributing area is calculated
from the incoming terrain, so the drainage network does not jump during a solve.

The session-5 pipe implementation reuses padded, separate flux arrays and row
scratch buffers. Rain/flux and water/erosion/transport form two fluid sweeps;
terrain slopes are refreshed only around actual height changes. A conservative
talus margin can prove thermal transport inactive; once that proof expires the
ordinary thermal stencil runs every iteration. Frozen receivers and conservative
transport remainders retain their original semantics. The droplet implementation
keeps f64 arithmetic and RNG order: f32 and reassociated interpolation experiments
failed the full-reference flow-correlation threshold. Row bounds are validated
before the small unchecked stencil/scatter loops; no work buffers allocate inside
either iteration loop. See the session-5 measurements and limits in [BENCH.md](BENCH.md).

`flow_accumulation` offers D8 and triangular-facet D-infinity routing. Accumulation
includes each sample's own cell area. Stable height/index ordering fixes the sum
order. The u8 direction codes are E, SE, S, SW, W, NW, N, NE = 0..7; 255 means sink.
D-infinity accumulates through both receivers but reports the dominant direction.
There is no depression filling/breaching: pits retain drainage. `heightfield_flow`
writes float layers `drainage` and `direction`, optionally log-scaled/normalised.

Compatibility: `heightfield_erode` defaults to `method:droplet, backend:js` and keeps
the old layer schema and output. Explicit `kernel` loads WASM; `auto` uses an already
loaded kernel and otherwise JS. Pipe/stream_power require the kernel. `wear` is added
only on kernel paths to keep existing goldens unchanged. Each call starts a fresh
water simulation; chaining pipe nodes does not resume flux/suspended-water state.

Limits: dense grids up to 16,777,216 samples, bounded iterations and cell-work counts;
extreme/nonfinite inputs fail with a useful error. f32 rounding limits conservation
precision. The pipe model is single-layer terrain, without undercuts, stratigraphy,
bank collapse or turbulence; its four directions can show grid bias. Fixed operation
order and libm avoid platform-dependent transcendental paths, but exhaustive platform
bit-identity is not established by one native/WASM comparison. `simd` opts into a
wasm32 simd128 evaporation loop with identical per-lane arithmetic; default builds
remain scalar. No dependencies were added; existing crate licences below still apply.
See [BENCH.md](BENCH.md) for measured acceptance and performance, and
`examples/renders/erosion_models.png` for the four-model comparison.

## API and geometry

The generated `pkg/topotopo_kernels.js` exports:

```js
await init({ module_or_path: wasmBytes });
straight_skeleton(outer, holes, weights); // weights optional
offset_polygon(outer, holes, distance);
roof(outer, holes, pitch_per_edge, height_cap); // cap optional
```

`outer` and each member of `holes` are `Float64Array` x,y pairs, without a repeated
closing point. `holes` is a JavaScript Array of those typed arrays. Either winding is
accepted; the kernel normalizes the outer contour counterclockwise and holes clockwise.
Source edge numbers always refer to the supplied outgoing contour edges: outer first,
then each hole. Coordinates are double precision and unit agnostic.

`straight_skeleton` returns `vertices` (xy `Float64Array`), `node_time` (one f64 per
vertex), `arcs` (x0,y0,x1,y1), `arc_kind` (`Uint8Array`, skeleton=0, contour=1),
`face_start` and `face_vertex_index` (CSR `Uint32Array`), and `face_edge` (`Uint32Array`).
`src_point` (`Int32Array`) gives the exact input point index or -1 for generated points.
Collinear samples on a moving vertex's trajectory are removed consistently from both
adjacent faces. Contour point bits are preserved exactly. A source edge can have more
than one face component, in which case its `face_edge` index is repeated.

All three functions also return the kernel programme's provenance fields:
`blend_offset`/`blend_index` (`Uint32Array`) and `blend_weight` (`Float32Array`) describe
the interpolation for generated points. The nearest input contour segment supplies its
two endpoint weights; source-edge order breaks distance ties. Original points have a
`src_point` and no blend entries. `src_prim` (`Int32Array`) identifies the source contour
ring (outer=0, holes=1...), with -1 for flat cap faces; an offset component uses its first
surviving edge's source ring. `src_vertex` is the original flat input corner for exact
copies, or -1 for generated corners. These are attribute-transfer weights, not a claim
that a generated point's new position lies on the original contour. Native Rust results
group these fields in `.provenance`; WASM result objects expose them at the top level.

`weights` are **wavefront speeds**, either one value or one per contour edge, default 1.
The offset time of an unweighted skeleton vertex is its perpendicular distance to its
incident input edges. Negative weights are rejected. Zero speed represents a stationary
gable edge; at least one edge must move.

`offset_polygon` returns `vertices` (xy), `polygon_start` and `polygon_vertex_index`
(CSR), and `polygon_hole` (0 outer, 1 hole). Positive distance erodes the footprint;
negative distance expands it. Offset components can split, disappear, or lose holes.
This is a mitered offset, not a round Euclidean buffer. Outward offsets propagate the
same kinetic lines in the opposite direction, through their topology events.

`roof` accepts one pitch or one per contour edge, **in degrees**, in (0,90]. The speed
is `cot(pitch)`, making the event time the roof height and every sloping face satisfy
`height = inward_distance * tan(pitch)`. A pitch of exactly 90 is the explicit gable
flag (stationary wavefront); extremely large weights are not interpreted as gables.
The result is `vertices` (x,y,height), face CSR, `face_edge`, and `src_point`. Sloping
faces use contour source edge indices; horizontal cap triangles use `0xffffffff`.
`height_cap` is a positive height: it stops the wavefront and triangulates the remaining
footprint, preserving courtyard holes. The roof includes gable faces but no bottom.
The TypeScript node maps this to TopoTopo's XZ footprint and Y-up convention.

## Algorithm and numeric contract

The algorithm advances inward-moving supporting lines to their earliest edge collapse
or vertex/edge contact. It searches **all** vertices for weighted contacts, not only
reflex vertices. Every contact at that time is handled together: touching edges are
subdivided at shared event nodes, oppositely oriented overlaps disappear into ridge
arcs, and surviving incidences reconnect by the clockwise angular order. The traced
wavefront vertex paths bound the source-edge roof faces. This is a straight skeleton,
not a medial axis or the lower envelope of unrestricted input-edge planes.

The implementation is independent of other straight-skeleton source code. Mathematical
references and independently reconstructed test diagrams:

- Biedl et al., [Weighted straight skeletons in the plane](https://pmc.ncbi.nlm.nih.gov/articles/PMC4235777/),
  positive-weight event resolution and coincident wavefronts.
- Huber, [Computing Straight Skeletons and Motorcycle Graphs: Theory and Practice](https://www.sthu.org/research/publications/files/phdthesis.pdf),
  2011, p.27 Figure 13 (the Felkel-Obdrzalek incorrect split-candidate example).
- Aichholzer et al., [A Novel Type of Skeleton for Polygons](https://www.jucs.org/jucs_1_12/a_novel_type_of/Aichholzer_O.pdf),
  1995, p.760 Figure 5 (the unrestricted lower-envelope counterexample).

Input validation uses adaptive orientation predicates (`robust`). The wavefront uses
normalized f64 coordinates, spatial tolerance 2e-11 of the footprint's maximum extent,
and event-time tolerance 2e-13 in normalized units. Event arithmetic is not exact
algebraic arithmetic. Sorted vectors, BTreeMap/BTreeSet, fixed traversal order and
`libm` transcendental functions avoid hash order and system-math variation. Native
and WASM use the same scalar operations without explicit fused multiply-add. Same
module/input replay determinism is tested; universal hardware/compiler bit identity
has not been established by an exhaustive platform matrix.

Current limits are explicit:

- At most 4096 contour vertices. Event search and incidence rebuilding are deliberately
  exhaustive (roughly cubic time on typical inputs); this session prioritizes correctness.
- Adjacent exactly collinear edges with **different** speeds/pitches are rejected with
  an actionable error. Equal-speed collinear points are supported and keep provenance.
- Touching/intersecting contours, nested holes, duplicate points, zero-area rings, all
  stationary edges and nonfinite/overflowing results are rejected. Islands belong in a
  separate polygon call. Geometrically distinct points within the spatial tolerance
  cannot be distinguished and are rejected when detected in the input.
- Near-antiparallel or coincident events below the tolerance can be unresolved. The
  kernel returns an error for unresolved topology or its bounded event budget; it does
  not fall back to approximate geometry. This is not a proof of robustness for every
  degeneracy in the literature.
- Extreme wavefront speed ranges are not normalized independently of the coordinates.
  Even a rectangle with a uniform speed such as 1e-14 or 1e14 can therefore return the
  unsupported-event error at the fixed time tolerance. Use moderate speeds or rescale
  the weights and then convert the returned times accordingly. Ordinary roof pitches
  and the explicit 90-degree gable are covered by tests; pitches extremely close to
  zero or 90 degrees can encounter the same limit.
- The Rust isotropic remesher and point kernels are not included; sessions 3/4 add quad remeshing and erosion.

## Tests

`cargo test` covers rectangle (four faces), L/U shapes, courtyard, 200 noisy vertices,
collinear/near-parallel points, invalid/overflowing input, weighted/gable roofs, caps,
offsets across topology events, both literature regressions, and deterministic property
loops over 300 random simple radial polygons with unit and unequal speeds plus 100
weighted courtyard cases. Properties check simple faces, area tiling to absolute 1e-9,
and no proper skeleton/contour crossings. Roof tests check edge incidence and orientation
on the open eaves, including capped collinear footprints. No random test dependency is
needed: the property corpus uses a fixed integer LCG and documented seeds.

## Dependency licences

`Cargo.lock` pins the complete graph. This crate is Apache-2.0. No GPL/AGPL source or
dependency is used. `earcutr` is only used for flat cap triangulation, not skeletons.

| Crate | Locked version | Licence | Purpose |
|---|---|---|---|
| robust | 1.2.0 | MIT OR Apache-2.0 | Adaptive orientation predicates |
| libm | 0.2.16 | MIT | Deterministic transcendental math |
| earcutr | 0.5.0 | ISC | Flat roof cap triangulation |
| wasm-bindgen | 0.2.129 | MIT OR Apache-2.0 | WASM bindings |
| js-sys | 0.3.106 | MIT OR Apache-2.0 | JS objects and typed arrays |
| autocfg | 1.5.1 | Apache-2.0 OR MIT | Build dependency |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 | Bindgen build dependency |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 | Transitive |
| either | 1.19.0 | MIT OR Apache-2.0 | Triangulation transitive |
| futures-core | 0.3.34 | MIT OR Apache-2.0 | js-sys transitive |
| futures-task | 0.3.34 | MIT OR Apache-2.0 | js-sys transitive |
| futures-util | 0.3.34 | MIT OR Apache-2.0 | js-sys transitive |
| itertools | 0.14.0 | MIT OR Apache-2.0 | Triangulation transitive |
| num-traits | 0.2.19 | MIT OR Apache-2.0 | Triangulation transitive |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | Transitive |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | js-sys transitive |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | Bindgen build dependency |
| quote | 1.0.47 | MIT OR Apache-2.0 | Bindgen build dependency |
| rustversion | 1.0.23 | MIT OR Apache-2.0 | Bindgen build dependency |
| slab | 0.4.12 | MIT | js-sys transitive |
| syn | 3.0.9 | MIT OR Apache-2.0 | Bindgen build dependency |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | Compiler-only identifier tables |
| wasm-bindgen-macro | 0.2.129 | MIT OR Apache-2.0 | Bindgen build dependency |
| wasm-bindgen-macro-support | 0.2.129 | MIT OR Apache-2.0 | Bindgen build dependency |
| wasm-bindgen-shared | 0.2.129 | MIT OR Apache-2.0 | Bindgen transitive |

`unicode-ident` is a compiler-only transitive dependency; its Unicode-3.0 data-table
licence is permitted by the repository's build-time licence rule. Its identifier
tables are not linked into the shipped WASM. Sessions 2, 3 and 4 add no dependencies.

## Field-aligned quad remeshing (session 3)

```js
const mesh = remesh_quad(positions, tris, {
  target_length: 0.1,       // 0: input mean edge length
  target_faces: 0,         // >0: takes precedence over target_length
  quad_only: false,
  feature_angle: Math.PI / 4, // radians in the kernel; degrees in the node
  align_boundaries: true,
  smooth_iterations: 8,
  preserve_sharp: true,
  crease_edges: new Uint32Array(), // flat input point-index pairs
  locked_edges: new Uint32Array(), // exact group-border edges/endpoints
  max_faces: 1000000,
});
```

The existing skeleton and grid entry points are unchanged. Native Rust uses
`remesh_quad::remesh_quad(&positions, &tris, &RemeshOptions)`; its density fields
are named `target_edge_length` and `target_face_count`. Inputs are f64 xyz triples
and u32 triangle triples. The returned `QuadMesh`/JS object contains:

- `positions: Float64Array`, `prim_start` and `vertex_point: Uint32Array`: polygon CSR.
- `source_triangle: Uint32Array` and `barycentric: Float64Array`: one original triangle
  index and three final-projection weights for every output point.
- `src_prim: Int32Array`: original triangle under each output face centroid.
- The WASM adapter additionally returns `src_point`, `blend_offset`, `blend_index`,
  and f32 `blend_weight` in the established provenance contract. `src_vertex` is -1
  because raw input triangles carry no wedge attributes. The node reconstructs
  per-corner provenance from the original geometry on each side of UV seams.
- `quality`: `quad_fraction`, `singularities`, `edge_length_min/mean/max`,
  `planarity_mean/max`, and the effective `target_edge_length`. Singularities count
  interior output vertices whose edge valence differs from four; boundaries are
  excluded. Planarity is absolute maximum vertex distance to each face's Newell
  plane, averaged and maximized over faces, in input units.

The implementation independently follows the local field/hierarchy approach of
[Jakob et al., Instant Field-Aligned Meshes (2015)](https://rgl.epfl.ch/publications/Jakob2015Instant).
It contains no copied Instant Meshes or QuadriFlow source and adds no dependencies.
Four equivalent tangent directions are compared after normal transport. Periodic
position origins are relaxed in the local tangent lattices, coarse to fine through
a deterministic adjacent-vertex clustering hierarchy. Input sampling is refined as
needed. A bounded integer translation-cycle correction routes opposite unit defects
through the triangle dual graph, stopping at cross-field singularities and respecting
hard-edge barriers. Only a complete correction is fitted back to continuous tangent
origins; an unresolved or search-budget-limited attempt leaves the original field
unchanged. This improves local consistency but is not a globally optimized integer
parametrization or a guarantee of exact integrability after fitting.
Extraction contracts edges with near-zero lattice translation subject to
manifold/normal checks, then joins compatible triangle pairs. Pure-quad mode also
uses residual triangle transport and local polygon-diagonal rotations to condition
the parent faces before subdivision.
Vertices finally relax/project onto the original triangles or feature segments.
Exact nearest-triangle barycentrics and deterministic source-index tie breaks supply
the attribute contract. Triangle and feature-segment queries use balanced BVHs.

The `remesh_quad` node adds the aliases `quadremesh`, `quad_remesh`, `instant_meshes`.
It preserves selected-region borders, point attributes through `GeoBuilder`, vertex
UVs per connected wedge, prim attributes from the source triangle and existing
normals recomputed from the result. `crease_group` supplies hard curve constraints;
UV seams and material/group borders are also constrained. Empty group selections
pass through. `max_faces` counts both the retained complement and generated faces.
Detail quality statistics describe the remeshed region, excluding retained primitives.

This is a conservative implementation with narrower capabilities than the reference
remeshers. Face counts are approximate. On unconstrained surfaces, pure-quad mode
solves at twice the requested edge length, then conformingly splits every polygon
once to approach the requested density. With hard curves it retains the finer solve
to avoid folded coarse parent patches, so output density can exceed the target by
about four times or more;
it retains residual triangles when locked borders prohibit this refinement.
Noncollinear feature-curve vertices are pinned, so densely sampled hard curves can
dominate the output density. Input limits are 1M points and 2M triangles; refinement
also has a 2M-triangle work limit. Degenerate source triangles are removed; ambiguous
non-manifold edges, inconsistent winding and disconnected vertex fans are rejected
with an actionable error. Self-intersecting manifold input is not repaired.
Universal hardware/compiler bit identity and arbitrary-surface quality are not
established by same-module replay tests. Exact acceptance measurements and remaining
quality/performance gaps are recorded in [BENCH.md](BENCH.md).

Run `node test/remeshquad.ts`, `node bench/remeshquad.ts` and
`cargo bench --manifest-path kernels/Cargo.toml --bench remesh_quad`.
Inspect `examples/renders/quad_remesh.png`: gray inputs and colored results for a
noisy sphere, bevelled box, shelf rock and capped tube, with every polygon edge visible.

## Sampled SDF grids (session 2)

The original skeleton API is unchanged. Additional generated WASM exports are:

```js
const grid = sdf_from_mesh(positions, tris, voxel, band, padding, fill);
grid_csg(a, b, 'smooth_union', k);
grid_offset(grid, distance);
grid_dilate(grid, distance);
grid_erode(grid, distance);
grid_blur(grid, radius);
grid_resample(grid, newVoxel);
dual_contour(grid, iso, qefTolerance, sharp, clampToCell);
```

`positions` are xyz `Float64Array`; `tris` are point indices in `Uint32Array`.
Grid objects contain `dims: Uint32Array(3)`, `origin: Float64Array(3)`, `voxel: number`
and `values: Float32Array(nx*ny*nz)`. X varies fastest: `x + nx*(y + ny*z)`.
Samples lie at grid nodes, so world extent is `(dims-1)*voxel`. Distances are negative
inside. Band and bounding-box padding are both in voxels; padding is independent of
the band. `fill=false` stores signed infinities outside the exact distance band.
All operations validate inputs, allocate outputs and leave inputs unchanged. Dense
allocation is limited to 64 Mi samples; this is not a sparse OpenVDB tree.

Mesh conversion uses exact point-triangle distances with a deterministic BVH.
Signs use absolute generalized winding greater than one half. Consistently oriented
closed meshes use signed scanline crossings (integer winding), so overlapping shells
accumulate instead of cancelling by parity. Open soups use triangle solid angles,
accelerated in the far field by BVH dipole moments with exact evaluation near the
classification threshold (this acceleration has no certified error bound). The
mathematical reference is [Barill et al., Fast Winding Numbers (2018)](https://www.dgp.toronto.edu/projects/fast-winding-numbers/);
the implementation is original. This sign is usable for many open meshes, not a guarantee
that every open sheet defines an interior. Oppositely wound overlapping shells can
cancel. Degenerate triangles contribute distance but no winding.

With `fill=true`, up to four cycles of eight-direction Eikonal fast sweeping propagate unsigned distances
outside the exact band while retaining the winding signs and all exact band samples.
These farther distances are approximations. CSG resamples B trilinearly onto A's
layout and clips to A's bounds. Smooth operations use polynomial smooth min/max.
Offset and morphology subtract/add distance; blur is a separable box filter. Those
operations do not redistance or enlarge the grid. Start filled and sufficiently padded
for large edits. Trilinear sampling outside bounds is positive infinity; mixed
finite/infinite stencils use a signed domain-diagonal cap, so distances beyond a narrow
band are intentionally not exact.

Dual contouring returns `positions: Float64Array`, polygon CSR `prim_start` and
`vertex_point: Uint32Array`, plus `cell_index: Uint32Array` identifying the flattened
lower grid corner for every output vertex. The native equivalent is `DualMesh`.
Hermite samples interpolate sign-changing grid edges and use minmod finite-difference
gradients. A centered symmetric-Jacobi pseudoinverse minimizes the QEF; an active-set
solver minimizes it within the cell when clamping is enabled. Shared bilinear face
asymptotic decisions split separate crossing loops. Each loop is triangulated through
its QEF vertex and shared grid-edge crossings, keeping triangles within one cell
instead of emitting potentially folded dual quads. Multi-loop cells use separate
crossing centroids; `sharp=false` uses centroids throughout. A 1e-6-voxel inset avoids
exact-zero endpoint collapses. Signed negative zero at iso zero retains inside sign.
This is a conservative uniform primal/dual hybrid, not the full Schaefer/Ju adaptive
octree algorithm. Unclamped QEF fits are accepted only when they stay in their cells;
otherwise the caller gets a clear enable-clamping error.

The surface budget is 1M active cells, 2M output vertices and 4M triangles, with checked
growth and fallible reservations. Boundary-crossing level sets and infinite samples
on crossing edges return actionable errors. Increase padding/band width or use a
coarser grid. Tests establish area, sharpness, incidence, vertex fans and absence of
proper nonadjacent crossings on the corpus; arbitrary coplanar contacts and all
exotic multi-loop cases are not proven. Cross-platform bit identity still needs a
platform matrix. No Rust marching-cubes kernel is included; the TypeScript adapter
uses existing manifold-3d. That fallback can fold at coarse concave junctions: the
showcase uses 0.06m voxels after its 0.08m comparison exposed two crossings in the
fallback. All three final showcase variants pass the crossing check.

`src/core/sdfgrid.ts` carries these grids through geometry cloning, merging, subsets,
bounds, JSON and fingerprints. JSON uses explicit `+Infinity`, `-Infinity` and `-0`
string sentinels to preserve Float32 values. Grid transforms support translation,
uniform scale, mirrors and axis-aligned rotations; convert to an implicit SDF before
arbitrary rotations or nonuniform scale. Renderer previews use the smooth existing
mesher, capped at 64 cells along the largest dimension.

The ten `sdf` nodes expose sampling, CSG, filters and conversions. `grid_to_mesh`
drops source attributes and supplies point `grid_cell` provenance for dual contouring.
`voxel_remesh` optionally transfers `Cd` by barycentric interpolation on the nearest
source triangle and `material` by the nearest triangle to each new face centre,
including the material table and referenced image volumes. UVs and other source
attributes are not transferred. `voxel_remesh` now names this dedicated node; the
existing `remesh` node and its `remesh_voxel` alias retain their old behavior.

Run `node test/sdfgrid.ts` for Node integration, `node bench/sdfgrid.ts` for the 256³
box benchmark, and inspect `examples/renders/voxel_remesh.png` (sharp left, smooth
middle, dilate/erode/blur right). Existing goldens and render hashes are checked
separately from the new example. Benchmarks and platform verification limits are in
[BENCH.md](BENCH.md).
