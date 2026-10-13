# Session 1 measurements

2026-10-13, Windows, Intel Core i7-10700K @ 3.80 GHz, Rust 1.94.0 release build.
Other agents were running repository checks concurrently, so these are development
measurements rather than an isolated performance comparison.

Command: `cargo bench --manifest-path kernels/Cargo.toml --bench wavefront`.
The fixture has 200 angle-ordered points with radial noise from the fixed LCG seed 11.
Each entry includes the entire kernel call and allocation; 11 repetitions, median:

```text
straight_skeleton: 200 vertices, median 77.256 ms, min 71.685 ms, 11 runs
roof: 200 vertices, median 80.119 ms, min 76.180 ms, 11 runs
```

The roof uses a uniform pitch of 35 degrees. Native debug tests were approximately
410 ms per call; concurrent debug runs varied substantially. Browser and Node WASM
timings are reported by `test/kernels.ts` and the session handoff, not inferred here.

Final optimized WASM is **148,068 bytes** (148.1 kB), including all provenance outputs.
SHA-256: `dd6f32d1a04f5ff452da77bf5d409172d7214f520c88eaa1c700dc1ed243bb50`.
The maximum allowed size for this slice is 1,000,000 bytes.

# Session 2 measurements

2026-10-13, Windows 10.0.26200 x64, Intel Core i7-10700K @ 3.80 GHz (16 logical
CPUs), Node v24.14.0, Rust 1.94.0. Release now uses optimization level 3 and
`wasm-opt -O3`, without fast-math, relaxed SIMD or explicit fused multiply-add.
No new dependencies. These are single development-machine runs, not medians or
cross-platform performance claims. The final benchmark was run without concurrent
repository gates; unrelated machine activity was not controlled.

Command: `node bench/sdfgrid.ts`. Twelve outward-wound triangles form a box
`[-1,1]^3`; band is 3 voxels, padding 4 voxels. At 256 samples per axis the exact
spacing is `0.008097165991910932` (rounded outwards to keep ceil at exactly 256).
Each measured call includes BVH construction, grid sampling, allocations, JS/WASM
copies and returned mesh arrays. WASM initialization is excluded. A 64³ call warms
the module first. Contouring uses iso 0, QEF tolerance 1e-6, sharp=true and clamping.

| Grid | Fill | Grid construction | Dual contouring | Total |
|---|---|---:|---:|---:|
| 64³ warmup | false | 49.534 ms | 59.651 ms | 109.185 ms |
| 256³ | false | 872.308 ms | 950.782 ms | **1823.090 ms** |
| 256³ | true | 11230.039 ms | 1276.862 ms | **12506.902 ms** |

**The 1500 ms target is not met**, even for this simple box. Filled mode is dominated
by Eikonal sweeps; conservative contouring produces more triangles than regular dual
quads. The final 256³ output has 732,110 vertices and 1,464,216 triangles. A complex or
open mesh can be substantially slower. The initial size-optimized implementation took
about 7 seconds unfilled and 21.6 seconds filled; conservative band blocks, triangle
bounds, signed scanlines and faster build settings improved this without changing the
existing skeleton API. These exploratory totals used evolving contour geometry and
are not a controlled apples-to-apples speedup measurement.

The complete final WASM (skeleton + sampled grids + contouring) is **282,546 bytes**,
below the 1,500,000-byte budget. SHA-256:
`ef4c1fd1171743dfa9732c34eac145367c8915f421ef6749c842b1dfa3794796`.

Correctness measurements in the Rust corpus: sphere area error **0.192276%**;
maximum shifted-box corner error **0.037767851** at voxel 0.08 (limit 0.04);
torus Euler characteristic 0 (genus 1). Sixteen seeded five-sphere unions check
closed, consistently wound manifold edges and vertex fans, deterministic replay and
no proper nonadjacent triangle crossings. Exact-grid-aligned zero sets and internal
negative-zero samples are also covered. These tests do not establish absence of
every coplanar contact or prove all exotic multi-loop configurations.

Chrome ran the updated `kernels/demo.html` against this module: **12/12 passed**
(nine unchanged skeleton/offset/roof checks, three closed/replayed grid contours).
The browser and Node tests establish same-module deterministic replay. An exhaustive
native/WASM/Linux/macOS/Windows bit-identity matrix has not been run.

Final validation (all exit 0):

- `cargo test --manifest-path kernels/Cargo.toml`: 2 library + 6 contour + 10 grid +
  21 unchanged skeleton tests passed (39 total), zero failures.
- `cargo clippy --manifest-path kernels/Cargo.toml --all-targets -- -D warnings`
- `cargo fmt --manifest-path kernels/Cargo.toml --check`
- `npm run kernels:build`: release build and wasm-opt completed, committed web package.
- `npm run typecheck`
- `npm run docs`: `unchanged docs/nodes.md (215 node types + shelf assets, 411155 bytes)`.
- `npm run test:update`: 278 cases, zero failures. Eleven new golden files; SHA-256
  comparison confirms all 267 files present at session start are byte-identical.
- `npm test`: full chained command exited 0, including 278 golden cases, the existing
  suites, `kernels: 55 passed, 0 failed`, and `sdfgrid: 89 integration checks passed`
  plus the imported grid core checks.
- `npm run showcase`: all 28 graphs rendered; SHA-256 comparison confirms all 27
  pre-existing PNGs are byte-identical. The new PNG was visually inspected.
- `git diff --check`: no whitespace errors.

The orchestrator should inspect `examples/renders/voxel_remesh.png`: sharp QEF
contouring on the left, existing smooth meshing in the centre, morphology/blur on
the right. Conservative fans can leave fine edge faceting; acceptance of that visual
tradeoff needs human review. Adaptive extraction, the 1.5-second performance target,
and exhaustive platform/geometric guarantees remain open.

# Session 3 measurements

2026-10-13, Windows 10.0.26200 x64, Intel Core i7-10700K @ 3.80 GHz (16 logical
CPUs), Node v24.14.0, Rust 1.94.0 release. No dependencies or release flags changed.
Final timed runs had no concurrent repository gates or agent benchmarks; unrelated
machine activity was not controlled. These are measurements on one machine.

Command: `node bench/remeshquad.ts`. Both inputs have exactly 100,000 triangles;
`target_faces=25000`, `smooth_iterations=8`, default quad-dominant mode. The first
input is a 201-row, 250-column UV sphere scaled radially by
`1 + .025*sin(7*x)*sin(5*y)*cos(6*z)`. The second is a 250-by-200 grid with
`y=.035*sin(3*x)*cos(5*z)`, x/z in [-1,1]. Raw calls supply positions and triangles,
without the node's additional UV-seam constraints. Each fixture has one full-size
warmup and three measured calls. Times include hierarchy, fields, extraction,
projection, provenance, quality, allocation and JS/WASM copies; initialization and
input generation are excluded. Quality is identical across the four calls.

| Node/WASM raw kernel | Warmup ms | Three measured runs ms | Median ms | Output faces / quads | Quad fraction |
|---|---:|---|---:|---:|---:|
| Noisy sphere | 9739.588 | 8315.331, 8350.060, 8359.691 | **8350.060** | 27,803 / 27,625 | 99.3598% |
| Noisy grid | 3743.622 | 3957.411, 4353.820, 5168.815 | **4353.820** | 25,303 / 24,997 | 98.7907% |

**The 3-second Node target is not met.** The large sphere also misses the <2%
irregular-vertex target: 760 / 27,716 = **2.7421%**. The grid reports 324 interior
irregular vertices / 25,600 points; the benchmark's separate raw valence count
includes 898 boundary vertices and must not be confused with the report's interior
singularity count. Edge lengths within +/-35% of the requested length are 98.6329%
(sphere) and 98.9902% (grid).

| Raw output | Target length | Edge min / mean / max | Planarity mean / max |
|---|---:|---|---|
| Sphere | .022450469 | .004689564 / .021357020 / .032927712 | .000028527 / .000197901 |
| Grid | .012683496 | .007426174 / .012609103 / .016007094 | .000008354 / .000028474 |

The same sphere through the complete node, including UV-seam constraints, attribute
transfer and normals, took **10918.549 ms** (one call): 31,141 faces, 30,385 points,
95.1318% quads and 2,957 irregular vertices (**9.7318%**). Thus the small regression
sphere is not evidence that all large or constrained spheres meet the quality goal.
Field regularity, constrained extraction quality and runtime remain follow-up work.

Command: `cargo bench --manifest-path kernels/Cargo.toml --bench remesh_quad`.
The native fixture is the same analytic grid, generated with libm rather than JS
Math. Warmup 2843.727 ms; measured 2996.556, 3033.310, 3075.068 ms; median
**3033.310 ms**. Output: 25,303 faces, 25,600 points, 98.7907% quads, 324 interior
irregular vertices. Do not infer a native sphere timing from the WASM results.

Correctness corpus (strict assertions, no ignored quality tests):

- Rust sphere: 659 points / 659 faces, **99.3930% quads**, 10 irregular vertices
  (**1.5175%**), **98.4802%** of edges within +/-35%, watertight.
- Node sphere: 671 points / 673 faces, **98.8113% quads**, 2 irregular vertices
  (**0.2981%**), **98.21%** of edges within +/-35%, watertight. Its JS-generated
  input is numerically different from the independently generated Rust input.
- All twelve sharp box edges aligned within 5 degrees; 24 deterministic noisy
  grids have no degenerate faces or nonmanifold edges, including quads-only cases.
- Attribute/UV wedges, group restrictions, exact retained borders, immutable
  inputs, distant retained components, aliases and pool on/off parity pass.
- Seven translation tests include overflow rejection, quarter-frame compatibility,
  charge cancellation, hard barriers, disconnected/dead faces, fixed origins and
  bit-exact rollback when only part of an integer correction can complete.
- Exact binary-fraction grid fixture produces native/WASM FNV-1a mesh digest
  **`fdf29ca20258fc73`** (25 points, 16 faces). This is one cross-target fixture,
  not a Linux/macOS/Windows or compiler/hardware identity matrix.

Final validation (all commands exit 0):

- `cargo test --manifest-path kernels/Cargo.toml`: **58 passed, 0 failed**
  (12 library + 6 contour + 9 quad + 10 grid + 21 unchanged skeleton tests).
- `cargo clippy --manifest-path kernels/Cargo.toml --all-targets -- -D warnings`
- `cargo fmt --manifest-path kernels/Cargo.toml --check`
- `npm run kernels:build`: release build and wasm-opt completed. Whole WASM is
  **492,075 bytes**, below 2,000,000 bytes. SHA-256:
  `88c6103fa9edefe7b2c24e10c1ab0fe1d8c9ec6ca1829dbae7583af1892b00e1`.
- `npm run typecheck`
- `npm run docs`: `unchanged docs/nodes.md (216 node types + shelf assets, 414294 bytes)`.
- `npm run test:update`: `2 written, 278 unchanged, 0 failed (280 cases)`.
  All 278 pre-existing golden SHA-256 hashes match the session-start baseline.
- `npm test`: full chained command exits 0; `280 passed, 0 failed, 0 skipped`
  goldens, `kernels: 55 passed, 0 failed`, `sdfgrid: 89 integration checks passed`,
  and `remeshquad: 748 integration checks passed`, plus all prior suites.
- `npm run showcase`: all **29** graphs rendered; all **28** pre-existing PNG
  SHA-256 hashes match the baseline. The new render was visually inspected.
- Chrome `kernels/demo.html`: **14/14** pass against the final WASM.
- `git diff --check`: no whitespace errors.

Inspect [the wireframe comparison](../examples/renders/quad_remesh.png): gray
input then colored output for the noisy sphere, bevelled box, shelf rock and capped
tube. All four outputs are closed/manifold and have no proper triangle crossings
in the automated check. The capped tube has **1,646 quads for a 350-face target**
(4.70x), with visibly dense/pinched cap flow. Hard curves keep fine sampling before
the conforming pure-quad split; locked group borders can instead retain triangles.
The implementation lacks the reference remeshers' broader extraction cleanup and
singularity relocation, uses averaged vertex frames at sharp junctions, and has no
guarantee of post-fit global integrability or arbitrary-surface intersection freedom.
No copied reference source or new dependencies are included. Large-input quality,
the 3-second target, denser feature constraints and exhaustive platform guarantees
remain unfinished; repository gate success does not establish those claims.
