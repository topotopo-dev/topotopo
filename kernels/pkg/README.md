# polyforge-kernels

Original Rust implementation of a kinetic, weighted straight skeleton, mitered polygon
offsets, and hip/gable roof surfaces. The checked-in `pkg/` is the browser-compatible
WebAssembly build; normal Polyforge users do not install Rust. See [BUILD.md](BUILD.md).

## API and geometry

The generated `pkg/polyforge_kernels.js` exports:

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
The TypeScript node maps this to Polyforge's XZ footprint and Y-up convention.

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
- Later remesh/erosion/SDF kernels are not included in this first slice.

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

**Allowlist exception pending:** `unicode-ident` includes the additional Unicode-3.0
data-table licence, which is outside the task's literal five-licence allowlist. It is
a compiler-only transitive dependency of the explicitly requested `wasm-bindgen`;
its identifier tables are not linked into the shipped WASM. This is disclosed rather
than representing the entire build dependency graph as satisfying that allowlist.
