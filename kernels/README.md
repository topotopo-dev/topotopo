# topotopo-kernels

Original Rust implementation of a kinetic, weighted straight skeleton, mitered polygon
offsets, and hip/gable roof surfaces. The checked-in `pkg-simd/` and `pkg/` are the
SIMD and scalar WebAssembly builds; normal TopoTopo users do not install Rust.
The loader feature-detects simd128 and defaults to SIMD, with scalar fallback.
See [BUILD.md](BUILD.md).

## Scatter selection (session 12)

`scatter_eliminate(positions, scale, target_count, r_max)` and
`scatter_min_distance(positions, order, radius, limit, groups, group_cap)` expose
flat `Float32Array` positions; the `_f64` entry points use `Float64Array` and retain
the precision of the engine's existing geometry. Both return candidate indices in
an `Int32Array`; inputs are never modified. The loader adapters select the matching
precision and pass empty arrays for absent scale/groups. `scale[i]` multiplies the
elimination radius at candidate i, rather than acting as an acceptance probability.

Weighted sample elimination uses an original port of the existing Yuksel-style
selection: the same middle-pivot KD quickselect, widest-axis ties, stable
distance-sorted preorder, neighbour contribution `(1 - d / radius)^8`, indexed
binary max-heap, and left-child heap ties as the TypeScript implementation. Uniform
samples use KD slot labels for locality. Variable-radius samples enumerate each
pair from its larger-radius endpoint (point-index ties), append the pair at both
ends in discovery order, and sum contributions in that order. Arithmetic is f64,
with the same scaled Kahan hypotenuse and three repeated squarings for the eighth
power. The TypeScript fallback uses those same three multiplies: V8 `Math.pow`
and Rust `libm::pow` can differ by an ulp, which changes close heap comparisons.
This is a documented deterministic arithmetic variant of the previous scatter
implementation, while all traversal, addition and heap tie rules are retained. Exactly
`min(target_count, candidate_count)` ascending indices are returned.

Compact candidate domains use a dense grid, limited to four cells per candidate
and 16M cells, with outward-rounded query bounds. Neighbours are sorted by squared
distance and KD preorder rank, retaining the reference's exact list order; sparse
domains and extreme radii use the KD search. Large selection buffers reserve
fallibly, and geometric growth is capped at the neighbour budget, so spare capacity
cannot silently double past that limit.

Elimination improves spacing but does not promise a hard minimum distance for an
arbitrary candidate set. `scatter_min_distance` provides that guarantee: greedy
dart throwing visits the supplied order, checks previously accepted candidates in
a hashed grid, and accepts pairs at exactly the requested radius. Optional
nonnegative per-candidate group IDs and a uniform positive group cap express the
node's per-primitive limit. Hash collisions only add distance checks; bucket order
and randomized group-map hashes do not affect the result. Radius zero applies the
order, output limit and group cap without distance rejection. The output retains
acceptance order and may contain fewer than the requested limit.

Checked limits are 5,000,000 candidates and 64,000,000 directed neighbour entries.
Positions must be finite, with magnitude at most `1e150`; elimination radii and
scaled radii must remain positive and bounded. Malformed shapes, invalid indices,
nonfinite or negative parameters, invalid groups, underflowing scaled radii or
positive minimum distances whose squares underflow to zero, and
excessive pair lists return errors. Minimum-distance grid coordinates are limited
to the exact integer range `abs(position / radius) <= 2^52 - 4`, so hostile tiny
radii cannot produce overflowing or nonadvancing cell loops. No dependencies were
added. See [BENCH.md](BENCH.md) for measured parity, timing and remaining limits.

`scatter_relax` accepts f64 positions, per-point spacing, triangle indices and
barycentrics, plus the existing `TriSurface.arrays()` buffers (`T`, `nodes`, `child`,
`order`, `triPrim`, `C`), optional corner weights, iterations and spacing options.
It rebuilds a KD tree for each repulsion pass, caps each movement at half its
spacing and projects through the supplied BVH, preserving its closest-triangle
ties and recomputing barycentrics in the original corner order. Returned arrays
are `positions`, `spacing`, `triangles`, `barycentrics`; inputs remain unchanged.
The only direction change is for pairs closer than `1e-12`: normalized hash-bit
directions replace host trigonometry in both JS and Rust for deterministic rounding.
Point/triangle budgets are 4M each, iterations at most 1024, finite coordinates,
weights and spacing bounded by `1e50`. BVH validation rejects invalid indices,
cycles, multiple parents and unreachable nodes before traversal.

The scatter node defaults to `backend:auto`: already loaded kernels, otherwise JS;
`kernel` loads the shipped package, and `js` forces the reference path. Auto uses JS
for candidate/relaxation counts beyond the kernel budgets. Sampling and attribute
interpolation remain in TS; heightfield_scatter retains its TS integration.
`cargo bench --manifest-path kernels/Cargo.toml --features profile --bench scatter`
prints native KD/search/heap stage timings. `bench/bench.ts` measures Node acceptance
with ABI copies, while `bench/scatter-placement.ts` compares full worker round trips.
For 1M+ candidates, the node sends elimination to one warmed pool worker with
cloned inputs; the candidate arrays remain available for attribute interpolation.
Small/cold-pool jobs, minimum-distance rejection and projected relaxation run on the
cooking thread. The host initializes WASM once per worker on its first such job;
the full-stage registry entry rejects split ranges, and an unavailable pool falls
back to the loaded main-thread kernel.
The pool threshold override can force this path for parity tests. The conservative
default only offloads the size measured by the placement benchmark; smaller jobs
retain the main-thread path.

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

Sediment follows conservative, dimension-split characteristics: an X transfer and
then a Z transfer, each retaining the donor's load minus its outgoing amount and
gathering incoming amounts from adjacent donors. This is bilinear remapping for
constant velocity, and conserves mass in converging/diverging flow without global
rescaling. With spatially varying velocity, Z uses the intermediate receiver's
velocity; the fixed X-then-Z order introduces directional splitting bias. Frozen
receivers reflect transfers at each stage, so sediment cannot cross a frozen wall
(unlike the previous diagonal scatter, which could bypass frozen cardinal cells).
Remaining load
settles at the end of a call; `sediment` records deposited thickness, `debris` thermal
deposits, `water` actual depth and `flow` normalised integrated speed. Closed edges
keep water/material; open pipe edges lose water **only**, keeping rock in-grid.
Droplet open edges retain their original behaviour of losing the carried load.
Pipe thermal transport is a separate conservative eight-neighbour talus pass.
Optional stream power is `K * A^m * S^n`; reference contributing area is calculated
from the incoming terrain, so the drainage network does not jump during a solve.

The pipe implementation reuses padded, separate flux arrays and row
scratch buffers. Rain/flux and water/erosion/transport form two fluid sweeps;
sediment gathering streams through a three-row transfer ring instead of storing
full-grid velocities or scattering into shared destinations. Four-cell SIMD
water updates skip the limiter division and second square root when no lane
requires limiting. All arithmetic retains scalar operation order;
terrain slopes are refreshed only around actual height changes. A conservative
talus margin can prove thermal transport inactive; once that proof expires the
ordinary thermal stencil runs every iteration. The droplet implementation
keeps f64 arithmetic and RNG order: f32 and reassociated interpolation experiments
failed the full-reference flow-correlation threshold. Row bounds are validated
before the small unchecked stencil/scatter loops; no work buffers allocate inside
either iteration loop. SIMD droplet smoothing retains the original addition order,
and paired thermal inactivity checks preserve scalar transfers for active cells.
See the session-6 measurements and limits in [BENCH.md](BENCH.md).

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
bit-identity is not established by one native/WASM comparison. The `simd` build
uses strict simd128, without relaxed SIMD, fast-math or fused multiply-add.
Scalar/SIMD corpus parity compares every returned byte, with no floating tolerance;
golden and pool tests exercise the default SIMD path. `TOPOTOPO_WASM=scalar|simd`
selects an explicit path before import. No dependencies were added; existing crate
licences below still apply.
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

## Field-aligned quad remeshing (sessions 3 and 7)

```js
const mesh = remesh_quad(positions, tris, {
  target_length: 0.1,       // 0: input mean edge length
  target_faces: 0,         // >0: takes precedence over target_length
  quad_only: false,
  cleanup: true,
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
- `quality`: `quad_fraction`, `singularities`, `irregular_fraction`, `edge_length_min/mean/max`,
  `planarity_mean/max`, and the effective `target_edge_length`. Singularities count
  interior output vertices whose edge valence differs from four; boundaries are
  excluded. `irregular_fraction` divides that count by all output vertices. Planarity is absolute maximum vertex distance to each face's Newell
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
manifold/normal checks, then joins compatible triangle pairs. Default cleanup removes valence-two doublets, conservatively collapses short edges
below 0.3 times the target length, transports residual triangles, and rotates local
polygon diagonals to reduce valence defects. New transport/flip diagonals must lie
between 0.3 and 2 times the target length before final relaxation, preventing valence
improvement from creating long boundary fans. Cleanup can be disabled with `cleanup: false`.
Pure-quad mode uses conforming local edge splits around residual non-quads; the local
splitter leaves unaffected quad topology intact. Convex planar patches bounded by suitable crease loops can
use a rectangular interior grid and a single transition ring. Geometrically verified
ruled annuli between corresponding planar loops use projected quad strips, with
original boundary samples and complete longitudinal constraints retained. Shape,
Euler, free-boundary and partial-crease guards reject unsuitable replacements.
Vertices finally relax/project onto the original triangles or feature segments.
Exact nearest-triangle barycentrics and deterministic source-index tie breaks supply
the attribute contract. Triangle and feature-segment queries use balanced BVHs.

The `remesh_quad` node adds the aliases `quadremesh`, `quad_remesh`, `instant_meshes`.
It preserves selected-region borders, point attributes through `GeoBuilder`, vertex
UVs per connected wedge, prim attributes from the source triangle and existing
normals recomputed from the result. `crease_group` supplies hard curve constraints;
Material/group borders are also constrained. UV seams use `direction_edges`:
orientation constraints and exact geometric seam support for the existing wedge
transfer, without pinning lattice position origins. They remain extraction barriers. Empty group selections
pass through. `max_faces` counts both the retained complement and generated faces.
Detail quality statistics describe the remeshed region, excluding retained primitives.

The solver retains f64 fields, ordered clustering, CSR neighbours, cached tangent
connections and separate position arrays. Fine hierarchy levels use fewer relaxation
sweeps with change-based early-out. Projection keeps exact nearest-triangle searches
with persistent source-triangle hints; provenance uses the same barycentric contract.

Inputs are limited to one million points and two million triangles; refinement is
also capped at two million triangles. Self-intersecting inputs are not repaired.
Face counts remain approximate, especially with locked borders or dense geometric
constraints. Local cleanup and bounded integer correction do not establish global
integrability or intersection freedom on arbitrary surfaces. Scalar/SIMD parity is
tested on the regression corpus, not an exhaustive operating-system/compiler matrix. Session-7 measured
acceptance, scalar/SIMD comparisons and remaining limits are in [BENCH.md](BENCH.md).

Run `node test/remeshquad.ts`, `node bench/remeshquad.ts` and
`cargo bench --manifest-path kernels/Cargo.toml --bench remesh_quad`.
Inspect `examples/renders/quad_remesh.png`: gray inputs and colored results for a
noisy sphere, bevelled box, shelf rock and capped tube, with every polygon edge visible.

## Sampled SDF grids (sessions 2 and 8)

The original skeleton API is unchanged. Additional generated WASM exports are:

```js
const grid = sdf_from_mesh(positions, tris, voxel, band, padding, fill);
grid_csg(a, b, 'smooth_union', k);
grid_offset(grid, distance);
grid_dilate(grid, distance);
grid_erode(grid, distance);
grid_blur(grid, radius);
grid_resample(grid, newVoxel);
dual_contour(grid, iso, qefTolerance, sharp, clampToCell, conservative, adaptive, sharpThreshold);
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
Dependency marks skip a repeated solve when none of its neighbours changed, without
changing the sweep order, stopping rule or output bits. Closed-mesh winding fills
scanline spans, and distance queries visit only active narrow-band block spans.
Each 4-cubed block keeps up to eight candidate triangles for direct distance tests;
dense blocks fall back to the BVH. Converged rows skip whole sweep spans. Added
scratch space is one byte per sample, one native integer per grid row, and 36 bytes
per band block (previously one byte), plus cached triangle normals.
These farther distances are approximations. CSG resamples B trilinearly onto A's
layout and clips to A's bounds. Smooth operations use polynomial smooth min/max.
Offset and morphology subtract/add distance; blur is a separable box filter. Those
operations do not redistance or enlarge the grid. Start filled and sufficiently padded
for large edits. Trilinear sampling outside bounds is positive infinity; mixed
finite/infinite stencils use a signed domain-diagonal cap, so distances beyond a narrow
band are intentionally not exact.

Dual contouring returns `positions: Float64Array`, polygon CSR `prim_start` and
`vertex_point: Uint32Array`, plus `cell_index: Uint32Array` identifying the flattened
lower grid corner for every output vertex. `fallback_cells` reports cells that
required conservative patches and `adaptive_collapses` reports accepted simplifications.
The native equivalent is `DualMesh`; the original five-argument `dual_contour`
function selects the new default, while `dual_contour_with_options` exposes all controls.
The default emits a dual polygon around each sign-changing grid edge, using a QEF
vertex in each incident cell. Planar faces stay quads (plane tolerance 1e-4 voxel);
warped faces use the diagonal with better aligned triangle normals, with stable ties.
Hermite normals interpolate finite grid derivatives; affine axial exterior evidence avoids
blending across a sharp box's interior medial axis. A centered symmetric-Jacobi
pseudoinverse minimizes the QEF, and an active-set solve constrains it to the cell.
Smooth unstable fits use the Hermite mass point. `sharp=false` uses mass points
throughout. Shared bilinear face decisions split separate crossing loops: ambiguous
multi-sheet cells require one vertex per component to preserve manifold vertex links.

Ambiguous topology and unsafe sharp fits trigger local conservative patches. Shared
face connectors make the transition conforming, without unmatched edges or T-junctions.
These guards detect risky local configurations, not every possible geometric
self-intersection. Runtime validation checks oriented edge incidence; the test corpus
also checks vertex links and proper nonadjacent triangle crossings. See session 8 in
`BENCH.md` for the remaining union-junction accuracy limit.
The explicit `conservative=true` path retains the session-2 minmod gradients and
cell-local fans byte-for-byte. Signed negative zero at iso zero retains inside sign.
Unclamped QEF fits are accepted only when they stay in their cells; otherwise the
caller gets a clear enable-clamping error. The construction follows the uniform
edge-dual/QEF approach described by
[Schaefer, Ju and Warren](https://people.engr.tamu.edu/schaefer/research/dualsimp_tvcg.pdf);
the adaptive octree simplifier is **not implemented**. Positive `adaptive` requests
currently retain the uniform mesh exactly and report zero `adaptive_collapses`.

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
Both `grid_to_mesh` and `voxel_remesh` accept `method: dual_contouring |
dual_contouring_conservative | marching_cubes`, `adaptive` (error tolerance in voxels,
zero for uniform extraction), and `sharp_threshold` (normal variation from zero to
one, default 0.5). Dual extraction adds the two statistics as detail attributes;
`grid_to_mesh` sums them when extracting several volumes.
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
