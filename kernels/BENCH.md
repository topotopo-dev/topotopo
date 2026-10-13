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
