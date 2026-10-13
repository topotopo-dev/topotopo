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

## Session 4 — heightfield erosion (2026-10-13)

Machine: Intel Core i7-10700K @ 3.80 GHz, Windows `10.0.26200` x64,
Node **v24.14.0**, Rust **1.94.0 (4a4ef493e 2026-03-02)**,
Cargo **1.94.0 (85eff7c80 2026-01-15)**. Native release uses opt-level 3,
LTO and one codegen unit. WASM uses the default **scalar** build, no SIMD,
threads, fast-math or FMA. Timed commands ran sequentially after repository gates.

Commands from the repository root:

```powershell
cargo bench --manifest-path kernels/Cargo.toml --bench erosion
node bench/erosion.ts --runs=3
node bench/erosion.ts --runs=3 --droplet-only
```

The pipe case is exactly 1024² samples × 200 iterations, cell 1 m, seed 1,
closed boundaries, rain 0.01 m/s, thermal rate 0.1, otherwise `PipeParams` defaults.
Its exact binary-fraction valley is
`32 + (1023-z)/64 + abs(x-512)/128`. Both native and WASM finish with height sum
**44032000.007678986**. Allocation, validation and output production are timed;
Node timings include input/output copies. Native compilation and WASM loading
are outside the timers. Node gets a small 32² warm-up, not a full-grid warm-up;
V8 tiering remains visible in the successive pipe runs below.

Droplet acceptance uses the **512² terrain from `test/heightfield.ts`**, rounded
once to the f32 input ABI for both backends: six-octave seed-1 simplex noise,
`(noise(x*0.01,0,z*0.01)*0.5+0.5)*5`, cell 0.1 m, 100 iterations,
`DEFAULT_EROSION`, seed 1. The dedicated `--droplet-only` command records this
comparison independently of the longer pipe timing. Each method runs three times.

| case | run 1 (ms) | run 2 (ms) | run 3 (ms) | median (ms) | acceptance |
|---|---:|---:|---:|---:|---|
| Pipe native, 1024² × 200 | 12994.535 | 12816.003 | 12473.615 | **12816.003** | **missed** <2000 ms |
| Pipe Node/WASM, 1024² × 200 | 32812.4568 | 21779.2872 | 15597.5653 | **21779.2872** | **missed** <4000 ms |
| Droplet JS, 512² × 100 | 2020.7966 | 2018.4709 | 2217.0057 | **2020.7966** | reference |
| Droplet Node/WASM, 512² × 100 | 2030.6863 | 2001.4898 | 2331.7343 | **2030.6863** | **missed** ≥3× JS |

The droplet median ratio is **0.9951298731×**: no measured speedup. The native
benchmark also times an analytic 512² valley at **1582.699 ms**, but this is a
different terrain and must not be used to claim a speedup against the noisy JS case.
These performance targets remain unfinished. Reusable scratch buffers, contiguous
brush rows, fused water/erosion traversal, hardware square roots and thermal early
rejection did not meet them; correctness gates do not substitute for performance.

Correctness evidence:

- Small noise-terrain integration: JS/WASM raw flow correlation
  **1.000000000**, signed sediment correlation **1.000000000**, closed-height
  relative material error **1.858314400999194e-11**.
- Full 512² × 100 reference-terrain benchmark: flow/sediment correlations both
  **approximately 1.0** (raw floating reductions `1.0000000000000695` and
  `1.0000000000000167`). JS height sum **664053.6035092796**, WASM
  **664053.6035628319**. Negative/fractional numeric seeds also pass >0.9
  integration correlations using the exact JS initial RNG state.
- Rust tests cover closed conservation, deterministic replay, finite layers,
  hardness/freeze, flat and tilted terrain, rain maps, open water discharge,
  a monotone stream-power valley, malformed/extreme inputs and the incoming-rain
  CFL bound. Seeded property sweeps use no new test dependency.
- Node cooks cover every method, immutable defaults, layer ranges, worker-pool
  on/off equality, auto availability/cache changes, numeric seeds, radial cone
  drainage and generated-WASM validation errors without traps.
- Native and WASM match all six FNV-1a f32-byte digests on the exact 33×25 valley
  fixture emitted by `kernels/benches/erosion.rs` and asserted in the Node suite:
  height **fe7a521d**, sediment **cbc320b7**, debris **355aea95**, flow
  **27155547**, water **831ccee1**, wear **114a9886**. This is one cross-target
  fixture, not a complete operating-system/hardware/compiler identity matrix.

Final verification, all commands exit **0**:

- `cargo test --manifest-path kernels/Cargo.toml`: **76 passed, 0 failed**
  (30 library, 6 contour, 9 quad, 10 grid, 21 skeleton; existing tests retained).
- `cargo clippy --manifest-path kernels/Cargo.toml --all-targets -- -D warnings`.
- `cargo clippy --manifest-path kernels/Cargo.toml --lib --target wasm32-unknown-unknown --features simd -- -D warnings`.
  This extra check exposed one pre-existing range-check lint in `src/wasm.rs`;
  its equivalent range expression was corrected, with no API/output change.
- `cargo fmt --manifest-path kernels/Cargo.toml --check`.
- `npm run kernels:build`: release build + wasm-opt completed. Whole scalar WASM:
  **558,684 bytes**, below both the requested 2,500,000-byte budget and the
  unchanged original smoke test's 1,000,000-byte limit. SHA-256:
  `58607305d2997051ac0dde5b0e4cffc5f4003713511fccc6edc96dafb685c7bf`.
- `npm run typecheck`.
- `npm run docs`: `unchanged docs/nodes.md (217 node types + shelf assets, 417694 bytes)`.
- `npm run test:update`: initially **2 written, 280 unchanged, 0 failed**;
  final replay **0 written, 282 unchanged, 0 failed**. All **280 pre-existing
  golden SHA-256 hashes** equal the session-start baseline.
- `npm test`: full chained command exit 0; **282 passed, 0 failed, 0 skipped**
  goldens; original kernel **55**, SDF **89**, quad **748**, erosion **2077**
  integration checks pass, along with every preceding suite and NOTICE check.
- `npm run showcase`: all **30** graphs rendered; all **29 pre-existing PNG
  SHA-256 hashes** equal the session-start baseline.
- Optional SIMD: `wasm-pack build kernels --target web --release --no-opt --out-dir ../out/session4/pkg-simd -- --features simd`,
  then `node test/erosionsimd.ts`: **30 scalar/SIMD exact comparisons passed**.
  The separate artifact is ignored; the checked-in module remains scalar.
- `git diff --check`: no whitespace errors.

Inspect [erosion_models.png](../examples/renders/erosion_models.png): back row
JS droplet (left), kernel droplet (right); front row pipe (left), pipe + stream
power (right). The render was inspected: the droplet pair matches visually,
pipe ridges remain sharper, and no obvious checkerboards, grid-aligned streaks
or terrain spikes appear at this resolution. Water bounds are checked numerically;
the shaded terrain image does not itself prove water-simulation stability.

Limits: dense single-threaded simulation; open pipe edges export water but retain
sediment; pipe calls settle residual suspension and do not resume flux state;
stream-power drainage is fixed from the incoming DEM; D-infinity reports only its
dominant direction and does not fill pits. Droplet wear is accumulated net erosion
per pass, not gross excavation followed by same-pass redeposition. Full cross-platform
bit identity and all three speed thresholds remain unproven/unmet. No dependencies
were added; the existing MIT/Apache-2.0/ISC runtime and permitted build-tool licences
are recorded in `README.md`. Existing default nodes, APIs and tests are retained.

## Session 5 - erosion performance (K-4b, 2026-10-13)

### Baseline captured before optimization

Same i7-10700K / Windows 10.0.26200 / Node v24.14.0 / Rust 1.94.0 and exact
session-4 fixtures. The only solver changes at this point are opt-in timers.
`profile` uses native Instant / WASM performance.now and emits JSON per call;
ordinary builds erase all clocks and counters. Commands:

```powershell
cargo bench --manifest-path kernels/Cargo.toml --bench erosion --features profile
npm run kernels:build -- -- --features profile
node bench/erosion.ts --runs=3
```

The tables use each pass's median across the three full calls (native droplet is
one analytic-valley call, not the noisy TypeScript comparison). Warmups and the
small parity fixture are excluded. Allocation, validation, and output conversion
are included; Node outer times also include copies. Small warmups remain exactly
as in session 4. These timers are diagnostic; acceptance uses uninstrumented builds.

| Pipe pass, 1024^2 x 200 | Native before ms | WASM before ms |
|---|---:|---:|
| Setup | 6.946 | 7.715 |
| Rain / surface | 343.800 | 434.358 |
| Flux | 2925.805 | 2343.616 |
| Water / velocity / erosion | 12928.238 | 8622.957 |
| Sediment transport | 5692.413 | 3881.003 |
| Evaporation | 148.021 | 121.227 |
| Thermal | 2865.536 | 1950.044 |
| Finalize | 15.049 | 11.584 |
| Outer call median | **25053.348** | **17364.552** |

Profiled native pipe calls: 26161.932, 25053.348, 19645.016 ms.
Profiled WASM pipe calls: 35392.917, 16777.384, 17364.552 ms. Height sum remains
44032000.007678986; all six original native/WASM parity digests match session 4.

| Droplet pass, 512^2 x 100 | Native analytic valley before ms | WASM noisy reference before ms |
|---|---:|---:|
| Validation / setup | 0.790 | 0.974 |
| Copy height | 29.279 | 21.265 |
| RNG | 2.400 | 2.246 |
| Tile sort | 3.811 | 3.037 |
| Motion / brush / deposition | 1533.864 | 1222.134 |
| Smooth deposits | 354.074 | 253.875 |
| Hydraulic layers | 90.553 | 119.829 |
| Thermal | 201.773 | 378.057 |
| Thermal wear | 43.200 | 61.721 |
| Output layers | 6.540 | 3.851 |
| Outer call | **2266.751** | **2068.868** (median) |

The simultaneous JS reference median is 2472.213 ms; profiled WASM droplet calls
are 2111.150, 2000.198, 2068.868 ms (1.195x). Flow/sediment correlations are both
approximately 1.0 and relative closed material error is 8.06482685248169e-11.
Sampling every 256th droplet further isolates motion/capacity, brush, and deposit.
On native these sampled totals are 7.253 / 1.429 / 2.277 ms (61946 / 16735 / 45211
intervals); on the noisy WASM median they are 7.458 / 2.605 / 3.260 ms. These overlap
the hydraulic timer and include clock overhead: do not add or extrapolate them
as true whole-pass costs. Radius 3 retains the TypeScript disk's **25** active
samples in a 5-by-5 brush, not 49 active cells.

The machine had substantial unrelated activity: one snapshot during native runs
reported 67% total CPU utilization on 16 logical processors, with other Node,
System, capture and NVIDIA processes active. Our compilation, gates and timed
workloads run sequentially; no unrelated processes are changed. Absolute timings
and before/after deltas therefore have environmental noise and must not be
presented as controlled hardware microbenchmarks. The uninstrumented native
baseline recheck is recorded below.

Sampling-profiler availability: samply and cargo-flamegraph absent; Windows WPR
and xperf installed. `wpr -start CPU.light -instancename TopoTopoK4b` failed with
0xc5585011, "Failed to enable the policy to profile system performance." Both
unique/default WPR status checks confirmed no recording remains. No profiler
package/dependency was installed. Release already had opt-level=3, LTO, one
codegen unit, panic=abort, and wasm-opt -O3; there was no missing release flag.

The uninstrumented native baseline recheck completed before algorithm edits:
14602.466, 12691.650, 12451.516 ms, median **12691.650 ms**. Analytic-valley
droplet: **1555.969 ms**. This reproduces session-4 native performance after the
heavier background load subsided; native and WASM profiling runs were not under
identical load. Original binaries/artifacts and logs are retained locally under
ignored `out/session5/` for paired checks.

### Optimization experiments

All entries below are whole-call exploratory measurements, not additive isolated
CPU costs; differing background activity and V8 tiering limit small-delta claims.
Intermediate builds and rejected candidates are saved locally in `out/session5/`.

- Finite dynamic min/max comparisons alone: native pipe 12572.356 ms (one call),
  versus uninstrumented baseline median 12691.650 ms; the 119.294 ms difference
  is too small to distinguish from noise.
- Conservative thermal inactivity proof: profiled native thermal fell to 0.120 ms
  (from the baseline's 2865.536 ms under heavier load); whole call 12247.199 ms. This
  checks a mathematical slope margin and actual terrain edits; it never changes
  the thermal frequency or omits a transfer that could be active.
- Padded flux SoA / row slices / shared reciprocals: profiled native water,
  velocity and erosion 5858.570 ms, versus 7102.127 ms in the previous experiment
  (1243.557 ms lower); whole call 11724.885 ms. Flow and suspension were checked
  for subnormal values (final counts flux 0, water 0, suspended 2); no FTZ or
  fast-math change was introduced.
- Gradient caching and relative transport coordinates: whole profiled call
  9437.567 ms; only 9,436,140 gradient updates out of 209,715,200 cell-iterations.
  Actual stored height changes invalidate the cell and its cardinal neighbours;
  active thermal work invalidates the whole cache.
- Independent row-slice arguments let LLVM vectorize the native water loop.
  Exploratory flux time fell from 1524.864 to 468.194 ms (1056.670 ms), and
  water/erosion from 4693.173 to 2082.537 ms (2610.636 ms). The whole profiled call
  was 7040.368 ms; an uninstrumented call was 7405.435 ms under different load.
- Row streaming and unrolled transport within a checked two/three-row window:
  uninstrumented calls 7405.435 to 4635.929 ms (2769.506 ms lower). Rain/flux is
  computed in the first sweep, with rain/surface streamed one row ahead of flux;
  water/erosion/transport forms the second sweep and reuses row scratch. The
  conservative scatter order is retained. Bounds are proven once per row before
  unchecked inner accesses; the checked-window proof and regression tests cover
  edges and thin grids.
- A final vectorizable erosion-delta loop and sparse application of nonzero
  stored f32 changes reduced an adjacent old/new native pair from 6808.121 to
  5401.178 ms (1406.943 ms, 20.7%). The original row-after value is stored directly,
  avoiding reconstruction roundoff. These stage deltas are not additive.
- Droplet checked row access, a precomputed 25-cell radius-3 brush and finite
  comparisons: WASM median 2032.327 ms, effectively unchanged from session 4.
  Gather smoothing with fused hydraulic layer accounting reduced the next median
  to 1958.612 ms (73.715 ms lower); all reference outputs/statistics remain exact.
- Full f32 droplet experiment: median 1945.294 ms, flow correlation 0.984869015,
  sediment 0.999553413, material error 4.64596e-9. **Rejected**: flow fails >0.99
  and speed barely improves. f64 terrain/trajectory precision is retained.
- Cached droplet cell indices and separate plain/masked monomorphized loops:
  median 2188.890 ms with JS 2219.216 ms; explicit independent mutable-slice
  arguments: 2228.554 ms with JS 2593.627 ms. These noisy comparisons do not establish
  individual gains. Both preserve reference checksum/correlations exactly.
- Reassociating the f64 bilinear expression: 2020.042 ms, flow correlation
  0.987178124, sediment 0.999663929, material error 5.73e-11. **Rejected** as well:
  chaotic trajectories require retaining the original arithmetic order.
- Droplet thermal row slices remove repeated checked indexing and fuse wear into
  the final apply loop. A fully warmed, alternating original/candidate WASM test
  just before the last wear fusion measured medians 4433.182 / 3669.266 ms:
  **763.916 ms lower (17.2%, 1.208x over original WASM)**. All six full-size output
  layers were bit-identical. This is a paired implementation comparison, not a
  3x speedup over TypeScript; no isolated timing is claimed for the last fusion.

Node's available V8 CPU sampler was also used:
`node --cpu-prof --cpu-prof-dir=out/session5 --cpu-prof-name=droplet-stage4.cpuprofile bench/erosion.ts --droplet-only --runs=1`.
The stripped/inlined WASM reports 1187 samples in one `wasm-function[32]`, without
inner-pass attribution; JS samples identify hydraulicPass, thermalRow and
smoothDeposits. The sampled run measured 1848.199 ms WASM versus 2016.427 ms
JS. Pass timers remain the useful source of inner-stage attribution.

### Final per-pass profile

The frozen implementation was rebuilt with `profile` and measured with the same
three-call commands above. Related original passes are summed **within each call
before taking the median** so they compare to the fused implementation. Medians
of different rows need not sum to the median whole call. Native droplet remains
one analytic-valley call; WASM droplet uses the noisy TypeScript reference.

| Pipe pass, ms | Native before | Native after | WASM before | WASM after |
|---|---:|---:|---:|---:|
| Setup | 6.946 | 34.396 | 7.715 | 42.502 |
| Cached terrain gradients (previously inside erosion) | - | 188.820 | - | 242.971 |
| Rain / surface / flux | 3367.947 | 1063.381 | 2777.973 | 3689.923 |
| Water / velocity / erosion / evaporation / reductions | 13098.209 | 2400.995 | 8744.184 | 9726.127 |
| Sediment transport | 5692.413 | 2596.184 | 3881.003 | 3786.671 |
| Thermal | 2865.536 | 0.051 | 1950.044 | 0.300 |
| Finalize | 15.049 | 16.898 | 11.584 | 39.921 |
| Profiled outer median | **25053.348** | **6444.438** | **17364.552** | **17624.611** |

After fusion, the water group splits into water/velocity **1256.100 / 5747.373 ms**,
erosion/deposition **669.949 / 2586.740 ms**, and reductions/evaporation
**474.946 / 1392.014 ms**, native / WASM respectively. Final profiled native pipe
calls: 5986.304, 6444.438, 7357.635 ms. WASM: 24507.749, 17624.611, 14036.247 ms.

| Droplet pass, ms | Native before | Native after | WASM before | WASM after |
|---|---:|---:|---:|---:|
| Validation / setup | 0.790 | 0.782 | 0.974 | 1.628 |
| Copy height | 29.279 | 34.266 | 21.265 | 42.268 |
| RNG | 2.400 | 2.939 | 2.246 | 3.577 |
| Tile sort | 3.811 | 5.978 | 3.037 | 5.914 |
| Motion / brush / deposition | 1533.864 | 1678.414 | 1222.134 | 1710.370 |
| Smoothing + hydraulic layers | 444.627 | 528.693 | 374.039 | 727.326 |
| Thermal + wear | 244.973 | 234.809 | 439.778 | 534.343 |
| Output layers | 6.540 | 41.186 | 3.851 | 8.866 |
| Profiled outer call/median | **2266.751** | **2527.618** | **2068.868** | **3041.310** |

Final sampled motion/brush/deposit totals are native **6.970 / 1.563 / 2.761 ms**;
WASM medians **11.582 / 3.512 / 5.115 ms**. They overlap the whole motion pass and
must not be extrapolated into actual costs. RNG is already a tiny fraction of the
solve; sampled diagnostics show substantial motion/deposition cost beyond brush.

The before/after columns are **not a controlled A/B test**. Total system CPU use
rose to 100% during final runs, and the row-fused pipe instrumentation makes
819,200 row-stage clock calls per solve in addition to iteration clocks, versus
the coarser baseline timers. WASM crossings and counter work perturb its profile.
The final WASM profiled pipe process CPU times were 20766, 11375, 11063 ms; wall
times above include descheduling, while process times also include compilation
threads. Neither subtracting these values nor scaling by machine utilization
would produce a valid idle-machine result. Use the ordinary build below for
acceptance. No unrelated processes were stopped or changed.

### Final ordinary scalar acceptance measurements

After restoring `npm run kernels:build` without features, ran sequentially:

```powershell
cargo bench --manifest-path kernels/Cargo.toml --bench erosion
node bench/erosion.ts --runs=3
```

| Exact session-4 case | Final times, ms | Median | Target | Result |
|---|---|---:|---:|---|
| Native pipe, 1024^2 x 200 | 4912.541 / 6638.599 / 6646.981 | **6638.599 ms** | <=2000 ms | Miss, 3.319x target time |
| Scalar WASM pipe, 1024^2 x 200 | 26280.581 / 14267.964 / 14310.899 | **14310.899 ms** | <=4000 ms | Miss, 3.578x target time |
| TypeScript droplet, 512^2 x 100 | 5294.871 / 4533.112 / 4464.529 | **4533.112 ms** | Reference | - |
| Scalar WASM droplet, 512^2 x 100 | 3433.256 / 3878.223 / 3488.212 | **3488.212 ms** | >=3x JS speed | **1.300x**, miss |

The final native median is 6053.051 ms lower than the session-5 ordinary baseline
(47.7%, 1.912x). The WASM median is 7468.388 ms lower than the recorded session-4
21779.287 ms (34.3%, 1.522x). Those are observed reductions, not controlled causal
measurements: unrelated load changed between sessions/runs. The final native
analytic-valley droplet call is 2123.648 ms and is not the noisy JS reference.

Final Node process CPU times: pipe 20938 / 12093 / 11734 ms, JS droplet
3907 / 3687 / 3391 ms, WASM droplet 2844 / 3046 / 2672 ms. These include all Node
threads and cannot replace wall-time acceptance. The session-4 tiny warmup is
retained exactly; the cold first pipe call is included in the median. Height
checksum remains 44032000.007678986 in every pipe call. Both commands exit 0 for
valid execution/statistics, but the native median exceeds its printed target and
Node prints both speed flags as false; benchmark exit 0 does **not** mean
performance acceptance passed.

**All three performance targets remain unmet.** Measurements are from a machine
with observed heavy unrelated CPU activity; no idle-machine result is claimed.

### Remaining costs and correctness

The reference pipe still transports sediment in 209,510,463 of 209,715,200
cell-iterations (99.90%). Conservative four-receiver scattering with bilinear
weight normalization and a subtraction remainder dominates the final native
profile; water/velocity dominates scalar WASM. Native assembly confirms vectorized
water and erosion loops, but scalar WASM cannot inherit that SIMD benefit.
Gradient caching removes most slope work, and the thermal inactivity proof removes
the thermal stencil on this fixture. Only 206 transported loads and 400 transfer
parts were subnormal over a diagnostic full solve, ruling out a widespread
denormal problem. The remaining division, square-root and scatter dependencies
have not been reduced enough to meet the targets. These observations identify
costs, not a proof that the targets are impossible.

A forced optimized-tier V8 diagnostic (`--no-liftoff`) measured 17096.030 ms versus
a preceding ordinary cold pipe call of 17573.126 ms under full machine load;
tiering alone did not explain the miss. No runtime dependencies, additional
parameters, approximation of droplet arithmetic, thermal-frequency change, or
multithreading was introduced. Pipe buffers are f32 and reused within the solve;
droplet f64 is an intentional exception to the proposed f32 lever because the
measured f32 candidate fails the required flow correlation.

The full 512^2 x 100 droplet comparison passes flow/sediment correlation >0.99
(both approximately 1.0) and relative material error **8.06482685248169e-11**.
Native and scalar WASM agree on all six updated 33-by-25 pipe digests:
height `d0714b86`, sediment `ddd8113b`, debris `355aea95`, flow `e02d6dc8`,
water `831ccee1`, wear `114a9886`. Reciprocals and relative-coordinate remapping
change some pipe rounding, so the explicit parity expectation was updated after
checking both targets. Same-build replay passes. This does not establish an
exhaustive cross-platform/compiler identity matrix.

### Final verification

All of these commands exited **0** against the final kernel source and ordinary scalar
package unless a separate profile/SIMD artifact is explicitly named:

- `cargo test --manifest-path kernels/Cargo.toml`: **83 passed, 0 failed**
  (34 library, 6 contour, 3 erosion edge, 9 quad, 10 grid, 21 skeleton).
- `cargo clippy --manifest-path kernels/Cargo.toml --all-targets -- -D warnings`.
  Additional profile all-target and wasm32 SIMD library Clippy checks also pass.
- `cargo fmt --manifest-path kernels/Cargo.toml --check`.
- `npm run kernels:build`: release plus wasm-opt -O3, **574,491 bytes**,
  below 2,500,000 bytes; SHA-256
  `d628b0e52a392cae2e10f7863e86f5aa4be985eadeeb5f9eb9cf52384b311ca4`.
  No profiling clock/log imports remain. A separate wasm-opt validation with
  `--disable-simd --disable-relaxed-simd` succeeds on these exact scalar bytes.
- `npm run typecheck`.
- `npm run docs`: unchanged `docs/nodes.md`, 217 node types + shelf assets,
  417694 bytes.
- `npm run test:update`: **1 written, 281 unchanged, 0 failed**.
  Only `test/golden/example.erosion_models.json` changed; the allowed
  `node.heightfield_flow.json` and all other 280 goldens remain byte-identical.
- `npm test`: the full chained command passes, including **282** goldens,
  **55** original kernel, **89** SDF, **748** quad and **2077** erosion checks,
  every preceding suite, docs staleness and NOTICE checks.
- `npm run showcase`: **30** graphs rendered. Only `erosion_models.png` changed;
  SHA-256 comparison against session-start hashes proves the other **29** PNGs
  and **281** goldens are unchanged.
- Optional SIMD: separate `out/session5/pkg-simd` build with `--features simd`
  and `node test/erosionsimd.ts out/session5/pkg-simd`: **30 exact comparisons**
  pass; the checked-in package remains scalar.
- `git diff --check`: no whitespace errors.

New tests compare gather smoothing and row thermal arithmetic against the checked
reference, cover 2-by-N/N-by-2 and other small masked/open/closed grids, oversized
droplet brushes, replay, finite layers, mass conservation, hardness/freeze, and
high-altitude shallow-water open boundaries. Independent review checked the row
bounds proofs and streamed accumulator clearing.

Inspect [erosion_models.png](../examples/renders/erosion_models.png). Visual review
after the final showcase found matching droplet views and no obvious checkerboards,
grid-aligned streaks or spikes. The shaded terrain view is not a water-stability
test. Gate logs, original binaries, hashes and experimental candidates are retained
locally in ignored `out/session5/`; none are added to the repository.

## Session 6 - default SIMD and erosion continuation (K-4c, 2026-10-13)

Machine: Intel Core i7-10700K @ 3.80 GHz, Windows 10.0.26200 x64,
Node v24.14.0. The cases, options, seed, f32 input terrain and small warmups are
unchanged from session 4: pipe 1024^2 x 200, and the noisy TypeScript-reference
droplet 512^2 x 100. Allocation, validation and all output layers remain inside
the timers; Node also includes JS/WASM input/output copies. Compilation and
module loading are outside the timers. Native droplet still uses the separate
analytic valley and cannot establish a speedup against the noisy JS fixture.

**The requested idle-machine condition was not achieved.** `tasklist` and process
command-line checks found no overlapping repository build/test/benchmark work,
but two repository MCP servers (PIDs 40020 and 29840) remained running. Their
cumulative CPU times stayed at 1.859375 and 1.5 seconds during the checked window;
that is evidence of inactivity during those observations, not evidence that the
processes were absent. Desktop activity included SysCap, Taskmgr and Godot. An
unrelated `npm install -g @openai/codex` also started during the droplet A/B run.
No unrelated processes were terminated. The tables report observed timings with
these limitations; they are not idle-machine acceptance evidence or controlled
cross-session speedup claims. Final pre-run total CPU snapshots were about 72%
before native timing and 59% before WASM timing.

### Builds, selection and parity

`npm run kernels:build` now writes two ordinary release packages: scalar
`kernels/pkg/` with `-C target-feature=-simd128,-relaxed-simd`, and
`kernels/pkg-simd/` with feature `simd` and
`-C target-feature=+simd128,-relaxed-simd`. Both have their own JS glue and
`topotopo_kernels_bg.wasm`. Both builds retain wasm-opt -O3, delete wasm-pack's
generated `.gitignore`, and retain `.npmignore` so npm includes the module.
Build and tarball checks enforce a combined WASM limit of 2,500,000 bytes.

The loader validates a minimal simd128 module, chooses SIMD when supported, and
otherwise loads scalar. `TOPOTOPO_WASM=scalar|simd` overrides selection before
the first import, including workers. No user-agent sniffing, relaxed SIMD,
fast-math, explicit fused multiply-add or new runtime dependencies are used.

The expanded parity corpus checks every kernel export: skeleton/offset/roof,
SDF construction and grid operations, dual contouring, quad remeshing, pipe and
droplet erosion, standalone thermal erosion, and D8/D-infinity drainage. It
compares every returned typed-array byte, topology/provenance/quality field and
signed zero. It includes odd/even vector tails, small grids, masks, zero rain,
open/closed boundaries, nonuniform rainfall, plateaus and positive/negative
impulses. The current corpus has **426 exact result comparisons** and **23
matching documented contour rejections**; rejections are not counted as cooked
results. No floating tolerance is needed. Golden and pool-parity tests retain
the default selected SIMD path; they are not silently forced to scalar.
The final ordinary modules pass the parity suite again. Scalar WASM is 576,140
bytes; SIMD is 571,237 bytes; combined **1,147,377 bytes**, below the budget.
Independent `wasm-opt --disable-simd` validation passes on the scalar bytes.
Both modules have 32 imports and no profiling/clock/log hooks. Final SHA-256:

```text
scalar 144aa933ffbc4fb8e9e5dbd8c98eea54133e64dac94d47ef81c393d6f9abf5c2
SIMD   e34137b0d297df06cacb083e9b4afeeb45eefb128429ccb56e0d68b3b7e24239
```

Final gate results are recorded below.

### What changed in erosion

- Pipe sediment transport now uses conservative X-then-Z gathering: subtract
  each outgoing transfer from its donor and gather the corresponding transfers
  from adjacent donors. Constant velocity yields separable bilinear remapping;
  converging/diverging flow conserves material up to f32 rounding without global
  rescaling. A backward bilinear heightfield sample alone would not provide that
  conservation property. The CFL limit keeps each displacement at most about
  0.45 cells, retaining nonnegative loads.
- Transport streams with the existing water/erosion rows: one velocity row,
  horizontal scratch rows and a three-row vertical-transfer ring. The initial
  full-grid gather experiment was replaced; the final implementation does not
  allocate a full-grid velocity or transfer array. Splitting interior stencils
  from borders permits contiguous compiler-vectorized work.
- The SIMD water/velocity helper handles four f32 cells per vector. A group
  whose velocity limiter is inactive avoids its division and second square
  root; a partially active group preserves scalar selection and operation order.
  Scalar tails handle widths not divisible by four.
- Droplet terrain/trajectories remain f64 with their original RNG and arithmetic
  order. Explicit f64x2 interior deposit smoothing preserves the original three
  ordered additions and skips zero contributions without changing signed zeros.
  Paired thermal checks skip inactive cells; active transfers keep scalar order.
- Sixteen-byte row alignment/padding was considered, but no aligned-allocation
  performance experiment or benefit is claimed. Neighbor stencils offset by one
  float cannot all be aligned together. The existing padded flux layout remains;
  the explicit SIMD loads/stores support unaligned addresses.

The new transport is a model change, not an algebraically identical rewrite of
the old scatter. On varying flow, the Z step uses the intermediate receiver's
velocity; fixed X-then-Z order introduces directional splitting bias. Frozen
cardinal receivers reflect each transfer, whereas the old diagonal scatter could
bypass a frozen cardinal cell. Dedicated tests check an independent f64 forward
remap, constant-velocity bilinear weights, repeated converging/diverging transfer,
nonnegative loads, mass preservation and frozen barriers. Existing all-layer
native/WASM parity is updated for the changed pipe model: height `13671b26`,
sediment `b2627087`, debris `355aea95`, flow `b8715d6e`, water `ac938cfe`, wear
`4f1e6002` (FNV-1a over f32 little-endian bytes). SHA-256 comparison against
session-start files confirms only `test/golden/example.erosion_models.json` and
`examples/renders/erosion_models.png` changed: the other **281 goldens and 29
renders are byte-identical**. Visual comparison retains the matching droplet
panels and shows no obvious new checkerboards or spikes in the pipe panels;
this shaded preview is not a water-stability proof.

### Fresh baseline and final ordinary measurements

The session-start scalar snapshot was retained before solver edits. Its ordinary
native pipe calls were 4499.663 / 4170.329 / 4072.085 ms. Scalar WASM calls were
16607.065 / 8925.160 / 8910.335 ms, including the cold first call in the median.
The native analytic-valley droplet call was 1428.598 ms.

| Same session-4 case | Session-start median ms | Final ordinary median ms | Target/result |
|---|---:|---:|---|
| Native pipe, 1024^2 x 200 | 4170.329 | **3185.542** | <=2000 ms; miss |
| Node/WASM pipe, 1024^2 x 200 | 8925.160 (scalar) | **4639.353** (SIMD) | <=4000 ms; miss |
| TypeScript droplet, 512^2 x 100 | 2486.240 | **2650.972** | Reference |
| Node/WASM droplet, 512^2 x 100 | 2142.122 (scalar), 1.161x JS | **1813.429** (SIMD) | >=3x JS; **1.462x**, miss |

Final native pipe calls: 3085.156 / 3185.542 / 3567.371 ms. SIMD WASM pipe:
7690.746 / 4616.315 / 4639.353 ms. TypeScript droplet: 2729.081 / 2650.972 /
2474.717 ms; SIMD droplet: 1719.819 / 1813.429 / 1835.044 ms. The final native
analytic-valley droplet call is 1728.425 ms, a different terrain from the JS test.
Node process CPU times are pipe 7578 / 4547 / 4531 ms, TypeScript droplet
3078 / 2907 / 2515 ms, SIMD droplet 1687 / 1782 / 1765 ms. Those CPU totals
include all Node threads and cannot replace wall-time acceptance.

All three observed performance targets remain missed, in addition to the idle
condition being unmet. Benchmark exit 0 checks execution/statistics, not speed.
The session-start/final changes include scalar-to-SIMD selection and varying
background load; the differences are not an isolated estimate of solver gains.

Representative commands from the repository root (compile before timing):

```powershell
cargo bench --manifest-path kernels/Cargo.toml --bench erosion --no-run
# Run the executable printed by Cargo, after the process audit.
tasklist /FI "IMAGENAME eq node.exe"
tasklist /FI "IMAGENAME eq cargo.exe"
& kernels/target/release/deps/erosion-20ea4bed521e97c8.exe --runs=3
npm run kernels:build
$env:TOPOTOPO_WASM = 'simd'
# Repeat tasklist and check repository command lines before each timed command.
node bench/erosion.ts --runs=3
Remove-Item Env:TOPOTOPO_WASM
```

### Per-pass profile of the streamed implementation

Opt-in commands: `cargo bench --manifest-path kernels/Cargo.toml --bench erosion
--features profile --no-run` followed by the generated benchmark executable;
`node scripts/kernels-build.ts --features profile` followed by
`TOPOTOPO_WASM=simd node bench/erosion.ts --runs=3` (set the environment variable
with PowerShell as above). Ordinary packages are rebuilt after profiling.

Pipe rows below are medians over the three full calls, excluding the small warmup
and parity fixture. Droplet native is one analytic-valley call; WASM is the median
of three noisy-reference calls. These are different droplet inputs. Medians of
individual passes need not add to the median complete call.

| Pipe pass, 1024^2 x 200, ms | Native | SIMD WASM |
|---|---:|---:|
| Setup | 39.571 | 38.232 |
| Cached terrain gradients | 137.641 | 211.078 |
| Rain / surface / flux | 1239.354 | 1217.198 |
| Water / velocity | 1215.575 | 1265.261 |
| Erosion / deposition | 787.684 | 1086.611 |
| Reductions / evaporation | 431.402 | 1022.007 |
| Sediment transport | 924.572 | 1238.593 |
| Thermal | 0.111 | 0.447 |
| Finalize | 17.708 | 11.426 |
| Profiled outer median | **4784.554** | **6097.608** |

Native profiled pipe calls: 4638.472 / 4884.005 / 4784.554 ms. SIMD WASM calls:
11311.012 / 5219.487 / 6097.608 ms. Both finish with height sum
44032000.007682800; the session-start scatter sum was 44032000.007678986.
Only 9,436,140 terrain-gradient updates are needed out of 209,715,200
cell-iterations. The conservative inactivity proof keeps this fixture's thermal
pass almost entirely inactive. Native final-step subnormal counts are flux 0,
water 0, suspension 4; those counts do not establish a broad denormal bottleneck.

| Droplet pass, 512^2 x 100, ms | Native analytic valley | SIMD WASM noisy reference |
|---|---:|---:|
| Validation / setup | 0.957 | 1.323 |
| Copy height | 35.982 | 30.066 |
| RNG | 2.546 | 2.991 |
| Tile sort | 4.197 | 4.221 |
| Motion / brush / deposition | 1447.685 | 1356.000 |
| Smoothing / hydraulic layers | 464.545 | 500.661 |
| Thermal / wear | 212.009 | 431.186 |
| Output layers | 8.916 | 5.904 |
| Profiled outer call / median | **2177.425** | **2333.879** |

The one-in-256 droplet sub-step samples report motion/brush/deposit totals of
7.033 / 1.450 / 2.580 ms native and 10.319 / 2.831 / 4.024 ms SIMD WASM. These
overlap the whole motion timer and include timing overhead; they cannot be added
or extrapolated into true whole-pass costs. Motion still dominates droplet work.
The pipe profile performs 204,800 marks for each of four row stages, plus
iteration marks. WASM clock crossings, stage accounting, tiering and background
load materially perturb its timings. Neither these measurements nor process CPU
time can replace ordinary wall-time acceptance.

### Pipe SIMD implementation A/B

`node out/session6/pipe-ab.ts` compares the original-source SIMD snapshot with
the final ordinary SIMD module on the exact session-4 pipe input. Each module
receives a full-size warmup before three alternating before/after pairs, with
`tasklist` before every timed call. Both sides already use SIMD, so this
comparison exercises the transport/water changes independently of merely
enabling the target feature. These warmups differ from acceptance.

| Fully warmed SIMD pipe implementation | Three calls, ms | Median ms |
|---|---|---:|
| Original session-start solver | 7328.898 / 6961.075 / 6077.325 | 6961.075 |
| Final streamed gather / water solver | 6402.720 / 5316.817 / 4665.263 | 5316.817 |

The observed median is 23.62% lower, or 1.309x the previous SIMD implementation.
Process CPU times were 6875 / 6547 / 6062 ms before and 5593 / 5078 / 4594 ms
after. Both series trend downward and background process counts changed during
the run; this remains an exploratory comparison on a non-idle machine.

Every returned layer is finite and nonnegative, flow stays normalized, and all
six layers replay byte-for-byte within each implementation. Relative closed
material errors are 1.74396e-10 before and 1.74482e-10 after. Equality across
the old and new pipe solvers is deliberately not asserted because the transport
model changed. Logs are retained locally in `out/session6/pipe-ab.log`,
`pipe-ab-processes.log` and `pipe-ab-initial-processes.txt`.

### Droplet SIMD implementation A/B

An isolated original-source snapshot was built with the same strict SIMD target
flags and wasm-opt settings into `out/session6/pkg-simd-before/`. The ignored
`node out/session6/droplet-ab.ts` loads that module and the candidate directly, uses
the exact session-4 noisy terrain, `DEFAULT_EROSION` with radians, and
`rngState(1)`. Each implementation receives one complete full-size warmup,
followed by three alternating pairs; `tasklist` is captured before every timed
call. All six returned layers match byte-for-byte after warmup and every pair.

| Fully warmed SIMD implementation | Three calls, ms | Median ms |
|---|---|---:|
| Original session-start solver | 1931.110 / 2053.323 / 2722.507 | 2053.323 |
| Candidate droplet SIMD helpers | 1900.833 / 1811.636 / 2176.417 | 1900.833 |

The observed median is 7.43% lower, or 1.080x the previous SIMD implementation.
This is not the speedup against TypeScript and uses different warmups from the
acceptance benchmark. Process CPU times were 1890 / 2016 / 2125 ms before and
1907 / 1813 / 2047 ms after. An unrelated Codex npm installation appeared during
the pairs and accumulated 11.141 CPU seconds, so this modest delta is not a
clean causal measurement. No 3x droplet acceptance is inferred from it.

On the full noisy reference, profiled SIMD flow/sediment correlations with JS
remain approximately 1.0 (1.0000000000000695 / 1.0000000000000167), with relative
closed material error 8.06482685248169e-11. Full-size six-layer equality against
the previous SIMD droplet implementation is additional evidence; it is not an
exhaustive operating-system/compiler/platform identity matrix.

### Final gates and remaining limits

All required final gates exited **0** on the ordinary packages:

- `cargo test --manifest-path kernels/Cargo.toml`, with default features and
  again with `--features simd`: **86 tests passed in each feature set**.
- `cargo clippy --manifest-path kernels/Cargo.toml --all-targets -- -D warnings`,
  and again with `--features simd` before `--`: both passed. Additional
  `--target wasm32-unknown-unknown --lib --features simd` Clippy passed, checking
  the actual SIMD-only code as well as native code.
- `cargo fmt --manifest-path kernels/Cargo.toml --check`. Formatting also fixes
  std/crate import ordering in six existing benchmark/test files after the rename.
- `npm run kernels:build`: both ordinary modules, **1,147,377 bytes combined**.
  Independent scalar validation with SIMD disabled passed; no profiling imports
  remain in either module. A final rebuild after the test-only lint correction
  reproduced both tested binaries byte-for-byte (SHA-256 values above).
- `npm run typecheck`; `npm run docs` (generated node docs unchanged).
- `npm run test:update`: **1 written, 281 unchanged, 0 failed**; only the permitted
  erosion example changed.
- `npm test`: the entire chained command passed, including **282 goldens**, all
  earlier suites and NOTICE checks, **7 loader scenarios**, **55 kernel / 89 SDF /
  748 quad / 2077 erosion checks**, and **426 exact scalar/SIMD results plus 23
  matching validation errors**.
- Additional `TOPOTOPO_WORKERS=4 TOPOTOPO_POOL_MIN=1 node test/golden.ts`:
  **282 passed**, using default SIMD with the pool forced on.
- `npm run build`: publishable JavaScript and both module-path checks passed.
- `npm run pack:test`: **25 checks passed**, installing the tarball into an empty
  project and exercising CLI, library/types, worker, MCP, automatic SIMD selection
  and both scalar/SIMD overrides.
- `npm run showcase`: **30 graphs rendered**; the hash and visual audit is above.
- `git diff --check`: passed.

The initial Clippy run flagged an indexed loop in the new test oracle; iterating
explicit axis descriptors resolved it, then both test/Clippy feature sets passed.
PowerShell's npm wrapper consumed forwarded profiling flags on the first attempt;
the documented direct `node scripts/kernels-build.ts --features profile` command
built both profiled packages successfully. Neither failure remains outstanding.
Logs, saved baseline modules, process audits and A/B scripts are retained only in
ignored `out/session6/`; build output and tarballs are not committed.

The strict idle-machine requirement remains unfulfilled, and all three observed
speed targets are still missed. Four-lane water work,
conservative gathering and f64x2 smoothing reduce identified costs, but remaining
water/flux/reduction passes, serial droplet trajectories and model-preserving
arithmetic remain substantial costs. Threads, GPU,
quad/contour feature work, relaxed arithmetic and new runtime dependencies remain
outside this session.

# Session 7 measurements - quad remesher quality and speed (K-3b)

The guarded remesher records **1.834229%** irregular vertices on the large raw sphere, **2.686296%** on the UV-constrained node, and **346 quads for a target of 350** on the tube. Final profiled SIMD medians are **4,188.203 ms sphere / 2,888.282 ms grid**. The ordinary SIMD medians are **5,091.995 ms sphere / 4,160.670 ms grid**, missing both 3-second targets, and **the requested idle-machine measurement was not achieved**.

2026-10-13, Windows 10.0.26200 x64, Intel Core i7-10700K @ 3.80 GHz (16 logical CPUs), Node v24.14.0. No new runtime dependencies.

**Changes**

- Retain deterministic pair-clustering hierarchy construction; use CSR adjacency, cached two-dimensional tangent connections, compact position arrays and Gauss-Seidel convergence checks. At eight requested iterations, position budgets are 8/16/32 sweeps from fine to coarse levels. Fields remain f64. Refinement now splits above 0.9h rather than 0.8h; the h trial was rejected because raw-sphere irregularity rose above 4%.
- Translation-curl repair uses CSR adjacency and compact origins, with transactional rollback if routing cannot complete. Its 128-round refit limit remains: shorter trials missed regularity. Lattice rounding preserves ties-away behavior and is tested against libm at adjacent half-integers and 100,000 finite bit patterns.
- Persistent source-triangle hints accelerate the existing exact BVH traversal while preserving input-index tie breaks and barycentric results; curve projection still uses the segment BVH. BVH-free parent-link projection and f32 fields were not introduced.
- Separate UV-seam orientation constraints from lattice position pinning while preserving exact seam geometry for corner attribute transfer. Add only node parameter `cleanup` (default true) and reported detail `irregular_fraction`; provenance and attribute-transfer formats remain unchanged.
- Cleanup dissolves unconstrained degree-two doublets, attempts valid short-edge collapses below 0.3h, pairs residual triangles and rotates edges to improve valence. **The new guard requires newly created diagonals to remain within 0.3h..2h**, resolving the candidate-2 grid outlier. Existing hard constraints and validity checks still take precedence over removing every short edge.
- Quads-only conversion splits residual non-quads and propagates conforming cuts only where needed. Eligible convex planar cap patches receive a structured interior and one transition ring joining the preserved crease loop; suitable ruled annuli use projected quad strips while retaining complete longitudinal seams. Initial target length is computed from surface area and requested face count; locked group borders may retain triangles.
- No opposite-index orientation cancellation pass was added: the observed raw and UV sphere fields each had eight same-sign poles and no opposite-sign pairs to cancel. Translation-curl repair and output-valence cleanup are distinct from orientation singularity cancellation.

**Method and machine state**

The exact Session-3 100k-triangle noisy polar sphere and 250-by-200 noisy grid request 25,000 faces with eight smoothing iterations. Raw calls have no UV seam constraints. Each fixture receives one full-size warmup, excluded, then three measured calls. Timings include hierarchy, fields, extraction, projection, provenance, quality, allocation and JS/WASM copies; module initialization and fixture generation are excluded.

Build profiles with `node scripts/kernels-build.ts --features profile` and select `TOPOTOPO_WASM=simd`. `node out/session7/bench-before.ts --runs=3` loads preserved packages from the session-start implementation (`b8bad0f38bc10cd5007bb64dfb4bce490a2313a1`, rebuilt with profile instrumentation) and forces raw-only mode; `node bench/remeshquad.ts --runs=3` measures the candidate plus one final UV node call. `--raw-only` omits that node call. Rebuild ordinary packages with `npm run kernels:build` before production timings and release gates.

Before timing, `tasklist /FI "IMAGENAME eq node.exe"`, the corresponding Cargo query, and repository command-line audits found no competing repository test/build/benchmark; all timed calls ran serially with our repository gates stopped. They did not establish an idle machine: earlier profile samples were 52.74-89.28% CPU, the final guarded profile samples are **62.82-92.46%**, and earlier production SIMD samples were 99.8-100%; final ordinary SIMD samples remain 97.73-99.81%. The pre-profile snapshot records background ffmpeg/browser activity. Audit files are under ignored `out/session7/`: `tasklist-*`, `repo-processes-*`, `profile-machine-before.json`, and `machine-production-simd.json`. These measurements cannot establish idle performance or an intrinsic scalar/SIMD speed advantage.

Each profile group is assigned to its following fixture record. Stage values are independent medians and need not sum to the median complete call. `fields_total` and `translation` are parent stages; do not add their substages twice. The named projection stage is final polygon relaxation; projection inside contraction/provenance remains charged to those stages.

**Final guarded profile-enabled timings**

| Fixture | Before SIMD median ms | Guarded SIMD measured calls, ms | Guarded median ms | Before/after | Sampled CPU, % |
|---|---:|---|---:|---:|---|
| Noisy sphere | 9472.055 | 4054.523, 4379.665, 4188.203 | 4188.203 | 2.261604x | 84.45, 92.46, 81.48 |
| Noisy grid | 4182.865 | 2768.174, 2888.282, 3183.688 | 2888.282 | 1.448219x | 62.82, 71.70, 81.99 |

| Stage, ms | Sphere before | Sphere guarded | Grid before | Grid guarded |
|---|---:|---:|---:|---:|
| Validation/setup | 79.883 | 86.869 | 60.496 | 62.116 |
| Projector construction | 63.597 | 78.308 | 64.175 | 64.442 |
| Refinement | 366.982 | 281.521 | 138.225 | 162.042 |
| Hierarchy | 171.552 | 70.268 | 83.777 | 54.405 |
| Field prolongation | 42.371 | 14.832 | 21.601 | 11.204 |
| Orientation field | 1214.233 | 163.728 | 642.553 | 131.392 |
| Position field | 2845.921 | 521.730 | 1406.305 | 408.176 |
| Fields subtotal | 4241.488 | 769.500 | 2145.462 | 612.748 |
| Translation total | 2697.589 | 1101.907 | 606.525 | 546.968 |
| Translation setup | not timed | 112.351 | not timed | 92.603 |
| Translation routing | not timed | 62.995 | not timed | 445.746 |
| Translation refit | not timed | 938.317 | not timed | not timed |
| Contraction | 1162.008 | 670.087 | 560.780 | 550.451 |
| Extraction | 89.335 | 72.640 | 72.708 | 50.749 |
| Cleanup | no separate stage | 416.569 | no separate stage | 454.578 |
| Quad conversion | 0.004 | 0.003 | 0.004 | 0.003 |
| Final projection/relaxation | 514.317 | 525.930 | 381.404 | 345.030 |
| Provenance and quality | 144.310 | 157.649 | 124.829 | 100.314 |

Cleanup is a new separately timed stage; baseline translation substages were not separately timed. The grid has no committed translation refit. Largest remaining sphere costs are translation refit (938.317 ms), contraction (670.088 ms), position smoothing (521.730 ms), final relaxation (525.930 ms), and cleanup (416.569 ms). Grid contraction (550.451 ms), routing (445.746 ms), cleanup (454.578 ms), and position smoothing (408.176 ms) now dominate its smaller field cost.

Source logs: `out/session7/before-final-simd.jsonl` and `final-profile-simd.jsonl`. `profile-summary.json` stores the complete final result under `final_guarded`; its earlier entries are explicitly historical candidate-2 data.

**Ordinary packages and scalar comparison**

| Final ordinary package | Sphere three calls / median ms | Grid three calls / median ms | CPU samples | Bytes / SHA-256 |
|---|---|---|---|---|
| SIMD | 5025.734, 5200.447, 5091.995 / **5091.995** | 4160.670, 4361.344, 3977.345 / **4160.670** | 97.73-99.81% | 668,388 / `d25c7fdc65af93bcf551adb20fdacb0e04701270dee05165e7f87a86ea146114` |
| Scalar | 7037.065, 6767.421, 7108.056 / **7037.065** | 5496.983, 5400.547, 5408.563 / **5408.563** | 98.21-100.00% | 674,084 / `2a9687a8732f6b982deede50aadf7a5cb93a2fb87ecc6b3d2ddf9268dbb7ee41` |

Final ordinary scalar/SIMD time ratios are **1.381986x sphere / 1.299926x grid**, both within 1.5x. Both ordinary SIMD medians exceed 3 seconds. Machine load differs between recordings, so these ratios do not isolate an intrinsic SIMD speedup or establish idle-machine acceptance. Source logs are `final-production-simd.jsonl` and `final-production-scalar.jsonl`.

**Final guarded quality and counts**

| Measurement | Before | Guarded result |
|---|---|---|
| Raw sphere interior irregular vertices | 760/27,716 = 2.742098% | 505/27,532 = 1.834229% |
| Raw sphere quads / faces | 27,625/27,803 | 27,509/27,551 |
| Raw sphere edges within +/-35% | 98.632851% | 99.072275% |
| Raw sphere edge min / mean / max | 0.004689564 / 0.021357020 / 0.032927712 | 0.006084961 / 0.021433956 / 0.033778093 |
| Grid interior irregular vertices | 324/25,600 = 1.265625% | 299/25,687 = 1.164013% |
| Grid quads / faces | 24,997/25,303 | 25,094/25,379 |
| Grid edges within +/-35% | 98.990216% | 99.014981% |
| Grid edge min / mean / max | 0.007426174 / 0.012609103 / 0.016007094 | 0.006315075 / 0.012629009 / 0.017371657 |
| UV node irregular vertices | Session 3: 9.7318% | 770/28,664 = 2.686296% |
| Tube quads, target 350 | Session 3: 1,646 | 346 (-1.142857%) |

The new diagonal guard resolves the candidate-2 cleanup regression: the grid maximum fell from .075080565 (5.91955h) to .017371657, with 99.014981% of edges within +/-35% of target. Grid raw valence counts include boundary vertices; use reported interior singularities for interior regularity.

Final profile quality records match across measured repeats. The single profiled UV node call took **4,229.631 ms**, producing **29,208 faces / 28,664 points**, with **96.261298% quads**; it is not a three-run median. The ordinary full UV node call took **6,457.560 ms**, including triangulation, wedge/attribute transfer, normals and Geometry construction. All eleven returned buffers and quality values match exactly between scalar and SIMD for the large sphere and four cleanup/mode/direction-constraint cases, without a tolerance; deterministic replay also passes. The final scalar-override quad suite passes all **780 checks**. The cap UV error assertion passes **<1e-6**; the test does not print the exact error on success.

**Final gates**

| Required gate | Final guarded result |
|---|---|
| `cargo test` default and `--features simd` | Both exit 0; 95 passed, 0 failed in each feature set |
| `cargo clippy --all-targets -- -D warnings`, both feature sets | Both exit 0 |
| `cargo fmt --check`; additional wasm32 SIMD clippy | Both exit 0 |
| `npm run kernels:build` | Exit 0; ordinary scalar + SIMD, 1,342,472 combined bytes; no profiling imports |
| `npm run typecheck`; `npm run docs` | Both exit 0; generated docs cover 217 node types |
| `npm run test:update` | Exit 0; 2 written, 280 unchanged, 0 failed (282 cases) |
| `npm test` | Exit 0 for the complete chain: 282 goldens, 780 quad checks, 55 kernel / 89 SDF / 2077 erosion checks, 426 scalar/SIMD comparisons and 23 matching validation errors |
| `npm run build`; `npm run pack:test` | Both exit 0; 106 built modules and 1 asset; 25 package checks passed |
| `npm run showcase`; `git diff --check` | Both exit 0; 30 graphs rendered, 29 unchanged render hashes; no whitespace errors |

Rust commands use `--manifest-path kernels/Cargo.toml`. The final native/WASM binary-fraction fixture has digest **`e512d6ca5c6cfb8b`** (25 points, 16 faces), including unquantized positions, topology and source-triangle barycentrics. Scalar/SIMD output comparisons are byte-exact, with exact quality values, as described above. Passing fixtures on this host is not an exhaustive OS/compiler/platform identity matrix. Only goldens `node.remesh_quad`, `example.quad_remesh`, and render `examples/renders/quad_remesh.png` may change: SHA-256 audit confirms all 280 other goldens and all 29 other renders are byte-identical to the session-start baseline.

Inspect `examples/renders/quad_remesh.png` for a regular tube-cap grid with one ring and aligned box edges: visually inspected after the final showcase run; the cap reads as a rectangular interior grid with one transition ring, the body has regular strips, and box feature edges remain aligned.

**Remaining limits**

- Strict idle-machine acceptance remains unmet; both final ordinary SIMD medians miss 3 seconds. The recordings do not prove either fixture meets the requested speed on an idle machine.
- f64 fields, exact BVH traversal, bounded integer routing and up to 128 translation-refit sweeps remain material costs. No opposite-index orientation cancellation was added because the observed sphere fields had eight same-sign poles.
- Hard constraints and validity checks can retain short edges or triangles. Target-count/cap-flow acceptance applies to the tested tube; structured caps require convex planar disks with even boundary counts of 8-512; annulus reconstruction requires matching translated loops and complete longitudinal constraints. Unsupported cases retain general extraction/conversion, and holes are preserved. Zero valence-two vertices is verified on the acceptance meshes, not guaranteed for arbitrary constrained input.
- No runtime dependencies were added. Erosion, dual contouring, new nodes, threads and GPU work remain outside this session.

Work stays on `codex/kernels`; no push or merge.

# Session 8 measurements: K-2b dual contouring

2026-10-13, Windows 10.0.26200 x64, Intel Core i7-10700K @ 3.80 GHz
(16 logical CPUs), Node v24.14.0, Rust 1.94.0. Starting HEAD was `cfb802b` on
`codex/kernels`. No runtime dependencies were added.

## Implementation and scope

The default is now edge-dual extraction: one QEF vertex per active cell component,
with a polygon around each sign-changing grid edge. Shared asymptotic face decisions
keep separate sheets separate. Ordinary cells have one vertex; collapsing multiple
components to one would produce non-manifold vertex links. Faces within 1e-4 voxel
of a plane stay quads; warped faces use a deterministic diagonal. Central Hermite
gradients, guarded affine axial one-sided reconstruction, constrained QEF fitting and
mass-point fallback preserve the tested box features. The affine reconstruction uses
the actual finite-difference slope, so scaling an implicit field does not move its zero set.

Ambiguous topology and unsafe sharp fits trigger local conservative patches with
shared face connectors. `fallback_cells` counts affected cells. These are local risk
checks, **not an exhaustive geometric self-intersection detector**; runtime validation
checks oriented edge incidence, while the corpus additionally checks vertex links and
proper nonadjacent triangle crossings. Explicit `dual_contouring_conservative` keeps
the session-2 geometry byte-identical. `sharp_threshold` is normal variation
`1 - abs(dot(n0,n1))`, from 0 to 1, default 0.5.

Both nodes expose all three methods, `adaptive`, and `sharp_threshold`. The optional
adaptive octree is **not implemented**: positive tolerances retain the uniform mesh
exactly, with `adaptive_collapses = 0`. Its tests verify this explicit retention and
manifoldness; they are not evidence of adaptive simplification or face reduction.

SDF construction now fills winding spans, queries bounded triangle lists in sparse
4-cubed band blocks (dense blocks use the full BVH), caches triangle normals, and
skips unchanged Eikonal dependencies and converged rows. Sweep order, stopping rule,
exact band samples and signs remain unchanged. Extra scratch: one byte/sample,
one native integer/grid row, and 36 bytes/band block (formerly one byte), plus
32 bytes/triangle for cached normal data.

## Per-stage Node/SIMD profiles

Same twelve-triangle box, spacing, band 3 and padding 4 as session 2, with a 64-cubed
warmup and three measured 256-cubed calls per fill mode. JS/WASM copies are included
in the external contour/total times. Internal stage timers exclude those copies.
Each entry is an independent median in milliseconds; medians need not sum exactly.

| Mode | Version | Winding/setup | Distance band | Sweeping | Contour incl. copies | Total |
|---|---|---:|---:|---:|---:|---:|
| Band | Before | 63.376 | 1178.738 | 0.003 | 1381.564 | 2639.214 |
| Band | After | 21.192 | 200.758 | 0.002 | 641.077 | 912.010 |
| Filled | Before | 63.712 | 1153.211 | 9956.675 | 1666.327 | 13512.840 |
| Filled | After | 23.162 | 226.306 | 941.593 | 723.108 | 1960.200 |

After contour internal stages (band / filled): Hermite/QEF **478.091 / 545.251 ms**,
connectivity **40.111 / 44.642 ms**, edge validation **75.569 / 79.109 ms**.
The final box has **366,056 vertices, 366,054 quads, zero fallback cells**, versus
732,110 vertices and 1,464,216 triangles in the original conservative extraction.

Commands: `node scripts/kernels-build.ts --features profile`, then
`node bench/sdfgrid.ts --runs=3`; the before run uses the instrumented starting
package via `--package=out/session8/before-profile/pkg-simd`. Profiling only split
the original sign/distance traversal into separately timed stages before optimization.
`winding_sign` includes scanline/BVH/block setup and output allocation. Source hashes
were verified unchanged across the final scalar and SIMD profile builds.

Measurements are **not idle-machine results**. Other repository processes were
present: the initial snapshot included a separate cloth `cpubench.ts` and
`test/arrays.ts`; profile snapshots included outside-session `test/showcase.ts`
and `test/remesh.ts`, and background ffmpeg work was observed. Our own builds and
tests were stopped during timed calls. Before profile CPU busy samples were
66.97-98.80%; final profile samples were 53.83-62.50%. The table establishes measured
times under differing contention, not a controlled speedup or platform-wide guarantee.
Raw logs/process snapshots are in ignored `out/session8/`.

## Ordinary release-build timings

After rebuilding without `profile`, the preserved starting SIMD package and final
SIMD package were run consecutively, three calls per mode, with all our other work
stopped. The process query before these runs found no other matching repository
test/benchmark commands; the end query found no matching test/benchmark/Cargo/ffmpeg
processes. This still was not idle: sampled machine CPU busy was 46.20-59.74% before
and 49.90-57.49% after. The raw results include every sample, not just the fastest.

| Mode | Version | Grid median | Contour median | Total median | Individual totals |
|---|---|---:|---:|---:|---|
| Band | Before | 944.141 ms | 1092.731 ms | 2108.487 ms | 1870.592, 2108.487, 2139.723 ms |
| Band | After | 246.888 ms | 629.091 ms | **866.090 ms** | 951.931, 842.193, 866.090 ms |
| Filled | Before | 8108.190 ms | 1143.973 ms | 9252.164 ms | 12509.829, 9252.164, 8913.286 ms |
| Filled | After | 1214.014 ms | 689.775 ms | **1937.339 ms** | 2556.006, 1818.333, 1937.339 ms |

Both requested speed targets are met in all three measured final calls: band below
1500 ms and filled below 4000 ms. These are Node/SIMD observations on this machine,
not an idle-machine or cross-platform performance claim. Commands:
`node bench/sdfgrid.ts --package=out/session8/before/pkg-simd --runs=3` and
`node bench/sdfgrid.ts --runs=3`. Final ordinary WASM sizes: scalar **696,943 bytes**,
SIMD **691,591 bytes**, combined **1,388,534 bytes** (limit 2,500,000).

## Quality, compatibility and remaining misses

- Final Node sphere area error **0.212807%**, below 1%; native finer sphere **0.087079%**.
- Shifted Node box maximum edge error **0.000000021 voxel**, line straightness
  **less than 1e-9 voxel**, maximum corner error **0.000000026 voxel**. All twelve
  edge strips and eight corners are checked. The ordinary box has one vertex per
  active cell and no conservative fallback. Scaled implicit-box values (0.2x and
  2x) have an additional native zero-set regression test.
- Torus Euler characteristic **0**, genus **1**, maximum sampled vertex analytic SDF
  residual **0.081733914 voxel** in Node (native fixture **0.052764840 voxel**).
- Sixteen five-sphere unions in Rust and sixteen sphere/box unions in Node have
  closed, consistently wound manifold edges and vertex links, deterministic replay,
  and no detected proper nonadjacent triangle crossings. **The 0.1-voxel union
  accuracy target is not met:** worst Node vertex residual **0.396347155 voxel**;
  native five-sphere corpus **0.425128611 voxel**. The worst Node point is an added
  conservative face connector in seed 13, near a sharp concave junction. These
  residuals are analytic SDF evaluations at vertices, not a certified Hausdorff bound.
- The optional adaptive octree is deferred, and automatic local guards are not an
  exhaustive intersection audit. Coplanar/shared-vertex contacts and arbitrary
  pathological grids remain outside the proven corpus. Scalar/SIMD byte parity
  on this machine does not establish the full native/WASM/OS platform matrix.
- Original-WASM compatibility audit: **28 grids**, **24 explicit conservative
  contours**, **180 arrays** byte-identical; four matching expected rejections.
  This includes shifted/rotated/open/reversed/seam-duplicated meshes and filled
  grids. The original conservative Rust sphere digest is retained. Sweeping tests
  compare 87 varied/scale-extreme cases to the original traversal byte-for-byte;
  17,442 sparse/empty/dense block queries match complete BVH distance f64 bits.

Only these geometry goldens changed via `npm run test:update`:
`node.grid_to_mesh.json`, `node.voxel_remesh.json`, and `example.voxel_remesh.json`;
the other **284** are unchanged. Inspect `examples/renders/voxel_remesh.png`: the
gold box's long edges and top perimeter are now clean lines; remaining torus/junction
faceting is visible. The blue marching-cubes comparison retains its original serration.

## Final release gates

All commands below exited **0**, on the final source and ordinary WASM packages:

- `cargo test --manifest-path kernels/Cargo.toml`: **100 tests passed**.
- `cargo test --manifest-path kernels/Cargo.toml --features simd`: **100 tests passed**.
- `cargo clippy --manifest-path kernels/Cargo.toml --all-targets -- -D warnings`.
- `cargo clippy --manifest-path kernels/Cargo.toml --features simd --all-targets -- -D warnings`.
- `cargo fmt --manifest-path kernels/Cargo.toml --check`.
- `npm run kernels:build`: both ordinary release packages, **1,388,534 bytes** combined.
- `npm run typecheck`.
- `npm run docs`; `npm run test:update`: **3 written, 284 unchanged, 0 failed**.
- `npm test`: complete chained command, **287 goldens**, **220 node examples with no
  warnings**, **288 SDF integration checks**, and **509 scalar/SIMD byte-exact result
  comparisons across 16 kernels**, including 115 contour results and 34 matching
  contour validation rejections. Existing skeleton/quad/erosion and other suites passed.
- `npm run build`: **111 modules**, one asset, compiled CLI/library output.
- `npm run pack:test`: installed tarball CLI/library/MCP/preview smoke test passed
  (**21 s**), including an installed `sdf_grid` WASM graph cook.
- `npm run showcase`: **32 renders**, **31 original PNG SHA-256 hashes unchanged**;
  only `voxel_remesh.png` changed and was visually inspected.
- `git diff --check`.

Final ordinary WASM SHA-256:

- Scalar: `3e1a27433fdb12a586cb5cde5775cc9672b11e15102b4cc37ede23ecf8450fb8`.
- SIMD: `58201a09021c1f7c02d1ec793fe9c028d86ebf144d030ceeff7d55b0759a8624`.
- Render: `20c2b34f64a90a1bb6841f8f1f254ca747693eff38a30aef6d48b85c6d015d5b`.

An intermediate scalar/SIMD mismatch was caused by changing contour source between
the two builds; rebuilding both from a frozen, hash-checked source resolved it. The
final parity gate has no tolerated numeric differences. No push or merge was performed.

# Session 12: K-10 scatter selection and projected relaxation (2026-10-14)

Branch `codex/kernels`, based on current main `eae1bc4` including the R-17 review.
No runtime dependencies were added. Implementation and correctness gates pass;
**all three requested performance targets remain unmet**.

## Algorithms and output contract

- Weighted sample elimination ports the TypeScript Yuksel-style algorithm, with
  the same KD quickselect, widest-axis ties, distance/preorder neighbour order,
  contribution addition order and indexed binary max-heap with left-child ties.
  Compact domains use a bounded dense grid, sorting each result by distance and
  KD preorder rank; sparse/extreme domains retain KD queries. Variable radii
  discover pairs from the larger-radius endpoint and retain discovery order.
- `scatter_min_distance` performs serial greedy rejection through a hashed grid
  in the supplied order, with optional per-group caps. Distances exactly equal
  to the requested radius are accepted. Rejection can reduce the output count.
- `scatter_relax` runs the complete repulsion/projection loop over f64 arrays,
  rebuilding the KD tree per pass and using the existing flat TriSurface/BVH
  projection, closest-triangle ties and barycentric recomputation. Sampling,
  attribute interpolation and `heightfield_scatter` integration remain in TS.
- Both f32 and f64 selection bindings ship. The node uses f64 to avoid rounding
  the existing candidate geometry. `backend:auto|kernel|js` defaults to auto;
  auto uses already loaded WASM and otherwise JS, while kernel loads WASM.
  Auto falls back to JS beyond the 5M selection / 4M relaxation budgets.

This is a **documented deterministic variant**, not legacy output identity:
`(1-d/r)^8` uses three repeated squarings in both JS and Rust because V8
`Math.pow` and Rust `libm::pow` differed by an ulp and changed heap comparisons.
For coincident pairs below `1e-12`, normalized hash-bit directions replace
sin/cos in both backends. The updated JS reference, scalar WASM and SIMD WASM
are byte-identical in the tested corpus, including pool on/off. No numeric
tolerance is used. The full OS/architecture matrix has not been exercised.

Elimination returns exactly `min(target, candidates)` points, but **does not
guarantee a hard computed r_min** for arbitrary inputs (duplicate candidates
make such a guarantee impossible). The uniform spacing property applies the
explicit minimum-distance pass after elimination and checks its pair distances;
it does not claim that WSE alone guarantees r_min. Rust properties also cover
counts, determinism, KD/grid query parity with distance ties, hostile parameters,
extreme radii, group caps, and valid/invalid projection BVHs.

## Node/SIMD timings versus targets

Node **v24.14.0**, Windows x64, Intel Core i7-10700K (16 logical CPUs). All tables
use one warm-up and **best of three** timed calls, as `bench/bench.ts` reports.
Graph input cooks are excluded from the scatter node time; the direct elimination
case includes KD/search/heap work and ABI copies, with candidate generation
outside timing. Final WASM packages are ordinary release builds, without profile.

| Case | Legacy JS, pool off | Final kernel, pool off | Legacy JS, 4 workers | Final kernel, 4 workers | Target |
|---|---:|---:|---:|---:|---:|
| 1M uniform candidates -> 100k elimination | not measured | 3185.9 ms | 9134.0 ms | **3754.7 ms** | <1500 ms, missed |
| 100k blue-noise points (500k candidates) | 2450.9 ms | 1186.2 ms | 1176.9 ms | **1070.7 ms** | <500 ms, missed |
| 100k blue-noise points with density mask | 3965.9 ms | 2111.1 ms | 1845.0 ms | **2333.2 ms** | <1000 ms, missed |
| 50k points, five projected relaxation passes | 2138.9 ms | 1081.5 ms | 900.8 ms | 1166.2 ms | 2000 ms |
| 100k requested, exact minimum distance (86.1k accepted) | 5146.5 ms | 1420.5 ms | 1995.2 ms | 1356.9 ms | 2000 ms |
| 1M points, relax off | 315.7 ms | 327.8 ms | 243.2 ms | 237.6 ms | 1000 ms |
| heightfield_scatter 100k (TS integration retained) | 1648.9 ms | 1412.7 ms | 972.6 ms | 958.2 ms | 2000 ms |

The direct elimination case always runs on the benchmark's calling thread; its
"4 workers" column describes the surrounding benchmark configuration, not
parallel heap execution. The final node offloads whole elimination stages only
at 1M+ candidates, so the 500k-candidate node cases above use main-thread WASM
with candidate sampling on the pool. Pool-off data uses the same final Rust
package; the final 4-worker column is a later run of the final selected policy.

Final selected-policy samples (ms, in execution order):

| Case | Samples |
|---|---|
| scatter_eliminate_1m | 3832.9, 3754.7, 3832.6 |
| scatter_1m | 262.9, 264.7, 237.6 |
| scatter_relax_100k | 1127.6, 1100.0, 1070.7 |
| scatter_relax_mask_100k | 2545.9, 2404.8, 2333.2 |
| scatter_relax_iter_50k | 1166.2, 1354.1, 1212.2 |
| scatter_min_distance_100k | 1473.9, 1356.9, 1877.5 |
| heightfield_scatter_100k | 1005.9, 1085.3, 958.2 |

These runs were sequential with our other CPU-intensive work stopped, but this
was not a controlled idle-machine measurement. Other repository activity was
observed, and sampled machine CPU busy around an earlier benchmark batch was
34.71% / 32.60%. An earlier final-package main-thread run reached 911.8 ms
uniform / 1845.0 ms mask / 3237.4 ms direct elimination. All three targets
missed there too. The updated JS reference with four workers reached 994.7 ms
uniform / 1521.6 ms mask / 868.4 ms five-pass relaxation / 8243.6 ms direct
elimination. Thus the serial kernel is not a universal improvement over the
parallel JS path: density-mask and multi-pass node timings regress in the final
batch. Background-load differences limit precise speedup claims.

Commands (PowerShell environment variables):

```powershell
$env:TOPOTOPO_WORKERS='0' # then repeat with '4'
$env:TOPOTOPO_WASM='simd'
node bench/bench.ts --filter scatter --backend kernel --runs 3 --output out/session12/final-selected.json
node bench/bench.ts --filter scatter --backend js --runs 3 --output out/session12/final-js-on.json
node bench/scatter-placement.ts --runs 3 --output out/session12/placement.json
cargo bench --manifest-path kernels/Cargo.toml --features profile --bench scatter
```

Local ignored raw reports/logs: `out/session12/before-off.json`, `before-on.json`,
`final-kernel-off.json`, `final-kernel-on.json`, `final-js-on.json`,
`final-selected.json`, and `placement.json`. Legacy baseline cooks preceded the
arithmetic change; the new direct case was measured against legacy JS before
editing that implementation.

## Worker placement and profiling

The same 1M planar candidates -> 100k selection was run in rotating interleaved
order on the main thread, a warmed worker with structured-cloned inputs, and a
worker with a prepared shared copy. Initial module loading/input generation are
outside timing; ABI copies, messages and shared-copy preparation are inside.
Every returned index array is checked exactly against the main-thread result.

| Placement | Three calls (ms) | Best | Median |
|---|---|---:|---:|
| main | 4228.8, 4147.0, 3959.5 | 3959.5 | 4147.0 |
| worker, cloned inputs | 4356.5, 3757.2, 3796.2 | 3757.2 | **3796.2** |
| worker, shared-copy preparation included | 4160.6, 4478.8, 3593.4 | 3593.4 | 4160.6 |

The cloned worker had the lowest median (8.5% below main); samples overlap and
do not establish a universal crossover. The node conservatively uses one
initialized pool worker for 1M+ candidates, retaining its arrays for interpolation.
Smaller/cold-pool jobs and unavailable-pool fallbacks run main-thread WASM.
The pool threshold override forces the worker path in parity tests. A trial
65536-candidate threshold did not improve the 500k-candidate node cases, so it
was not retained. Minimum-distance rejection and projected relaxation remain
on the cooking thread. Each worker loads WASM lazily once; the registry rejects
split ranges for this serial full-stage operation.

Native stage profiling on a separate deterministic LCG planar dataset (not the
Node RNG corpus) measured KD build 233.65 ms, neighbour search/list construction
1516.05 ms, heap build 35.02 ms and heap removals 1393.19 ms, 3202 ms total.
Neighbour construction and heap updates remain the major costs. The initial
pow/KD port took 3587 ms natively and about 8595 ms in the recovered Node retry.
Scatter's arithmetic is scalar in both packages; the SIMD package does not
introduce vectorized heap updates.

## Allocation failure recovery

The previous process died with `memory allocation of 1048576 bytes failed` in
the first kernel benchmark, with an earlier log also recording a WASM
`unreachable` trap. **It did not reproduce** after recovery with plentiful
memory: the initial package completed the same 1M elimination, and repeated
final full-size runs completed successfully. The original crash's exact cause
is not established; no runaway allocation was reproduced.

Review found a separate concrete capacity hazard: geometrically growing Vec
buffers could reserve beyond the logical 64M directed-neighbour budget. Large
KD/CSR/heap buffers now reserve fallibly, and neighbour capacity growth is capped
at the budget, returning a clear error instead of blindly requesting spare
capacity beyond it. Compact-grid allocation is also bounded and can fall back
to KD. This is bounded high-memory work, not a guarantee against host exhaustion
at the ABI or every scratch allocation. Whole benchmark process peak RSS was
1561.4 MB with the pool off and 1859.0 MB in the final selected four-worker run
(1899.7 MB in the earlier four-worker run). These are process peaks across the
entire batch, including workers/retained WASM memory, not live per-call bytes.

## Goldens, visual review and gates

`npm run test:update`: **3 written, 287 unchanged, 0 failed** (290 total):
`example.particles.json`, `example.terrain_erosion.json`,
`example.unreal_demo.json`. Their three matching PNGs changed; the other
**30/33** tracked render SHA-256 hashes are unchanged. Old/new images were
visually inspected: particle trail placement and scattered rock/tree placement
shift, with no visible projection failures; terrain and road geometry remain
the same. No node-type golden changed.

All required commands exited **0**:

- `cargo test --manifest-path kernels/Cargo.toml`: **111 tests passed**.
- `cargo test --manifest-path kernels/Cargo.toml --features simd`: **111 passed**.
- `cargo clippy --manifest-path kernels/Cargo.toml --all-targets -- -D warnings`.
- The same clippy command with `--features simd`.
- `cargo fmt --manifest-path kernels/Cargo.toml --check`.
- `npm run kernels:build`: scalar **759383 bytes**, SIMD **750700 bytes**,
  combined **1510083 bytes**, below the 2.5M budget.
- `npm run typecheck`, including a final repeat after the adapter edge-case fix.
- `npm run docs`; `npm run test:update`.
- `npm test`: complete chain exit 0, **290 goldens**, **222 examples**,
  **106 pool checks**, **514 exact scalar/SIMD comparisons across 21 exports**;
  the scatter suite passed 1593 checks in that chain and **1594** in the final
  focused run after adding the duplicate-order/group-cap regression.
- An additional SIMD-preloaded run of all 290 goldens passed, exercising auto
  scatter with WASM loaded from process start.
- `npm run build`: **114 modules**, one asset.
- `npm run pack:test`: installed CLI/library/MCP/preview and WASM cook passed,
  **21 seconds**.
- `npm run showcase`: **33 renders**, only the three reviewed changes above.
- `git diff --check`.

The first full npm attempt correctly stopped on missing coverage for the five
new public exports in the existing all-binding scalar/SIMD test. Actual result
comparisons were added for all five; the complete chain was then rerun to exit 0.

Final ordinary WASM SHA-256:

- Scalar: `c0aac4bcaf93f82ec3b50e6009e807ad1c7a5a73d61ea6a271f2017a347531be`.
- SIMD: `a4a7487dc849c5d433c8d10ca202552679358f584d84b6d352711195414aea3f`.

Remaining misses: 100k uniform <0.5 s, masked <1 s, and 1M elimination <1.5 s;
hard r_min is an explicit rejection contract rather than a WSE guarantee;
full cross-platform bit identity remains unverified. Current main was merged
before the final gates. No push was performed.
# Session 13 (K-10b): scatter speed and measured auto selection

## Measurement conditions and scope

Measured on Windows x64, Node v24.14.0, Intel i7-10700K at 3.80 GHz, 16 logical
processors. The default pool has 15 workers; four workers also reproduce session
12's comparison. No other Node, Cargo, rustc, build or test jobs from this
repository ran during timed measurements; collaborating agents held CPU-heavy
commands. Process audits are saved under `out/session13/`; the Codex launcher
was excluded. Unrelated user applications and MCP services remained open. Total
host CPU samples before the optimized profile were 3.8-8.3%, and before the first
final assertion 19.4-24.7%. Thus the repository was idle apart from the benchmark,
but the operating system was not completely quiescent.

Acceptance uses ordinary release SIMD packages. Separate profile builds provide
the stage breakdown and are replaced by `npm run kernels:build` before backend
comparisons. Baseline and optimized stage profiles are separate runs, so
scheduling, allocator state and code layout can affect their deltas. These are
machine-specific results; they do not establish a crossover on every CPU, mask
distribution or custom pool configuration.

Initial same-session baseline medians (three samples, four workers) were 4767.0
ms for direct 1M kernel elimination, 1650.3 ms for uniform 100k kernel scatter,
2884.6 ms for masked kernel scatter versus 2190.8 ms parallel JS, and 1247.7 ms
for projected 50k kernel scatter. Session 12 reported historical best times;
those must not be presented as like-for-like median baselines.

## Final auto rule

`auto` uses an already-loaded WASM module. Without one it retains the JS path;
explicit `kernel` loads WASM, and explicit `js` bypasses the rule. The benchmark
preloads WASM so it tests the loaded-module auto decision.

The following inclusive thresholds select parallel JS for an individual stage;
other eligible stages retain WASM:

| Stage | Candidate or point count | Effective workers |
|---|---:|---:|
| Adaptive elimination (density-dependent spacing) | >=200,000 candidates | >=3 |
| Adaptive elimination | >=500,000 candidates | 2 |
| Uniform elimination | >=500,000 candidates | >=4 |
| Uniform elimination | >=250,000 candidates | >=8 |
| Projected relaxation | >=50,000 retained points | >=3 |

Minimum-distance rejection stays in WASM when eligible, independently of the
elimination choice. This permits a mixed path, such as JS elimination followed
by WASM minimum-distance selection. Existing WASM size limits and JS fallbacks
remain in effect.

Effective workers are captured before candidate sampling can start a cold pool:
`min(pool.size, pool.threads)`. A missing/cold pool, unavailable
`SharedArrayBuffer`, or a stage below its pool threshold contributes zero.
The normal parallel eligibility thresholds are 32,768 candidates for elimination
and 2,048 points for relaxation; a host's `pool.minElements` override takes
precedence. Capturing actual started slots avoids selecting a parallel policy
from configured capacity alone.

Large surface-candidate and existing shared intermediate arrays use
`SharedArrayBuffer` where available, avoiding repeated preparation/copy-back
between stages. The WASM heap still receives its ABI copy. Whole WASM elimination
retains the existing started-pool threshold of 1M candidates (or the explicit
pool threshold override); the 500k placement experiment below did not justify
lowering it.

## Crossover calibration

These are whole scatter-node medians, with input-node cooks excluded.
The relaxed surface cases generate five candidates per requested point.
The preliminary adaptive sweep used three timed rounds; the final 200k
three-worker boundary check used six balanced rounds.

| Adaptive candidates | Workers | Kernel ms | JS ms |
|---:|---:|---:|---:|
| 25,000 | 4 | 65.6 | 128.6 |
| 50,000 | 4 | 120.8 | 141.3 |
| 75,000 | 4 | 174.9 | 191.8 |
| 100,000 | 4 | 243.9 | 252.3 |
| 150,000 | 4 | 374.0 | 414.6 |
| 200,000 | 4 | 586.8 | 528.9 |
| 250,000 | 4 | 844.9 | 687.8 |
| 500,000 | 4 | 2178.6 | 1505.1 |
| 500,000 | 2 | 2176.7 | 2080.2 |
| 200,000 | 3 | 521.4 | 514.3 |
| 250,000 | 3 | 778.4 | 706.1 |
| 500,000 | 3 | 2245.2 | 1622.1 |
| 500,000 | 15 | 2223.7 | 1228.2 |

The three-worker 200k boundary is measured, not interpolated: auto was 521.8 ms
against kernel 521.4 / JS 514.3 ms, a ratio of 1.0147 to the faster explicit
backend (`adaptive-3-40000.json`). The two-worker 500k boundary is close to
crossover. The four-worker sweep brackets its selected cutoff between 150k and
200k candidates; it does not identify a universal exact crossover.

Uniform calibration used six timed rounds covering all backend permutations.
The old policy still selected WASM during this calibration; the wider pool
results motivated the added uniform rule.

| Uniform candidates | Workers | Kernel ms | JS ms |
|---:|---:|---:|---:|
| 500,000 | 3 | 1072.7 | 1106.5 |
| 500,000 | 4 | 1006.0 | 998.5 |
| 500,000 | 8 | 1011.3 | 791.6 |
| 500,000 | 15 | 1043.1 | 729.8 |
| 250,000 | 8 | 465.0 | 360.1 |
| 250,000 | 15 | 506.3 | 379.0 |

The four-worker 500k result is near crossover; three workers retain WASM.
At eight and fifteen workers JS wins at both measured candidate counts.
The 250k cutoff at eight workers was checked directly rather than inferred
from the fifteen-worker result. Raw files are `uniform-{workers}-{count}.json`
in `out/session13/`, where the filename count is requested output points.

| Projected points (5 passes) | Workers | Entire kernel path ms | Entire JS path ms |
|---:|---:|---:|---:|
| 10,000 | 4 | 276.7 | 279.9 |
| 50,000 | 2 | 1165.6 | 1341.0 |
| 50,000 | 3 | 1090.1 | 1052.4 |
| 50,000 | 4 | 1078.2 | 954.2 |
| 50,000 | 15 | 1059.4 | 743.9 |

At three workers, mixed auto (WASM elimination, JS projected passes) measured
978.5 ms, below either whole-backend choice. Smaller projected workloads and
two-worker pools retain WASM. Adaptive/projected raw calibration files are
`mask-*.json` and `tune-scatter_*.json`; `tune-relax.json` records the old
policy's masked and projected regressions before dispatch changed.

## Auto assertion protocol and failed earlier run

`bench/bench.ts --assert-auto` checks, without rounding before comparison:

```text
median(auto) <= 1.05 * min(median(kernel), median(js))
```

The final protocol is fixed in advance: three warm-up rounds and twelve timed
rounds, using all six backend permutations twice. It balances execution
positions and preceding backends. Explicit `--runs` values are honored;
multiples of six preserve that balance. The six orders are auto/kernel/js,
kernel/js/auto, js/auto/kernel, auto/js/kernel, js/kernel/auto, and
kernel/auto/js. There are no conditional retries or relaxed comparison bounds.

Each case/pool combination runs in its own child process to release retained
WASM heaps and worker caches between cases. Graph caches are cleared and exposed
GC runs outside timing. Every complete backend path is warmed, including worker
WASM. Requested and started thread counts must match; crashes/timeouts fail the
measurement. Reports include samples, medians, requested/actual worker counts,
pool threshold overrides, per-backend pool counter deltas and process peak RSS.
Pool counter deltas cover timed whole-graph cooks, including input nodes.

The five scatter node cases run both without the pool and with the configured
pool. Direct 1M elimination has no pool integration and is measured once with
zero workers: eleven comparisons for a nonzero pool configuration.
`heightfield_scatter` has no backend parameter and is outside this assertion.
`--scatter-count N` tunes node counts without changing the direct case;
descriptions, throughput and count metadata reflect the override, and original
full-size speed targets are not claimed for smaller custom workloads.

The preceding seven-round run is retained as
`out/session13/assert-auto-4.json`: **7 passed, 5 failed, exit 1**.
Four failures used the same implementation under their compared labels
(random 1M scatter with pool off/on, uniform scatter with pool off, and
minimum-distance scatter with pool off); their ratios ranged from 1.0531 to
1.1882. These show timing variation, not established backend regressions.
Four-worker uniform scatter also failed (auto 1119.8 / kernel 1082.5 /
JS 1016.6 ms; ratio 1.1015), prompting the uniform crossover calibration.
The seven-round schedule had unequal positional exposure. Changing to a fixed
balanced schedule reduces order bias but does not guarantee a passing timing
result. Its failures remain recorded and are not counted as successful gates.

The local assertion checks the measured rule; it cannot guarantee that auto is
fastest on every workload or machine. Explicit backend overrides remain
available.

## Kernel changes and identity

Compact neighbour-grid cells now hold contiguous x/y/z columns instead of linked
lists. The SIMD package evaluates two independent f64 squared distances with
strict `f64x2` multiply/add operations in the scalar expression order; scalar
tails and the scalar package use the same distances. Both paths sort by distance
and original KD preorder, preserving equal-distance ties. Adaptive elimination
discards pairs already excluded by the selection rule before sorting them.
Projected relaxation uses the compact grid on each pass, while retaining the KD
layout needed for exact tie order. Sparse domains still use KD queries.

The minimum-distance selector uses direct dense-cell buckets for compact domains,
clamping searches to occupied domain bounds (nine cells rather than 27 on a flat
surface with span one); sparse domains retain the existing hash grid. Dense grids
require at least 256 candidates, at most four cells per candidate/order entry and
at most 16M cells. Cell dimensions use checked conversion, including on wasm32;
the new >2^32-cell-extent parity case exercises the sparse fallback.

The node continues to use f64 positions. The f32 ABI widens already-f32 inputs;
the node does not quantize f64 geometry because even small changes can alter
distance ties, accumulated weights, heap decisions and projected coordinates.
Neighbour lists are rebuilt per relaxation pass: positions, adaptive spacing and
KD tie rank change. A reused radius-margin list was not implemented or measured.
The heap algorithm and its left-child tie rule are unchanged. Its lower measured
time below is an observed end-to-end implementation result, not evidence of a new
heap algorithm; allocation/layout and runtime variation may contribute.

## WASM stage profile

`bench/scatter-profile.ts` runs the same prepared corpus before and after, with
one warm-up and three measured calls per case. The profile build reports Rust
stages; generated glue is instrumented in memory to time ABI allocation/copy-in
and copy-out. Shipped glue is not edited. Values below are per-stage medians in
milliseconds, so their sums need not equal the median total. Major corpus and
surface preparation, candidate generation and warm-up are outside these direct
calls. The synthetic relaxation callback still allocates its 50k triangle-index
array and small BVH/options objects inside total timing; Rust stage and ABI
copy timers exclude that JS preparation.

| Case | Stage | Before ms | After ms |
|---|---|---:|---:|
| Uniform 1M -> 100k | ABI copy-in / copy-out | 2.75 / 0.09 | 1.92 / 0.07 |
| | KD build | 340.35 | 308.47 |
| | Neighbour search + lists | 2001.75 | 1646.68 |
| | Heap build / removals | 41.25 / 2388.86 | 25.11 / 1285.89 |
| | Total | 4799.21 | 3258.10 |
| Uniform 500k -> 100k | ABI copy-in / copy-out | 1.75 / 0.10 | 1.17 / 0.07 |
| | KD build | 169.27 | 151.60 |
| | Neighbour search + lists | 523.09 | 499.60 |
| | Heap build / removals | 14.74 / 578.60 | 13.12 / 373.62 |
| | Total | 1291.80 | 1024.07 |
| Adaptive 500k -> 100k | ABI copy-in / copy-out | 1.92 / 0.07 | 1.67 / 0.07 |
| | KD build | 168.41 | 157.55 |
| | Neighbour search + lists | 2310.08 | 1852.02 |
| | Heap build / removals | 8.05 / 580.16 | 7.99 / 536.17 |
| | Total | 3048.66 | 2577.94 |
| Minimum-distance 500k | ABI copy-in / copy-out | 1.83 / 0.06 | 1.44 / 0.05 |
| | Grid preparation / selection | 4.09 / 257.19 | 7.52 / 71.56 |
| | Total | 263.64 | 82.95 |
| Planar relaxation 50k x 5 | ABI copy-in / copy-out | 0.34 / 0.58 | 0.36 / 0.62 |
| | KD build / grid build | 68.43 / 0.00 | 68.54 / 8.51 |
| | Neighbour search + repulsion | 205.71 | 112.80 |
| | Surface projection | 19.23 | 18.59 |
| | Total | 295.82 | 211.05 |
| Noisy-surface relaxation 50k x 5 | ABI copy-in / copy-out | 0.82 / 0.67 | 0.88 / 0.59 |
| | KD build / grid build | 68.15 / 0.00 | 71.40 / 2.62 |
| | Neighbour search + repulsion | 199.55 | 180.41 |
| | Surface projection | 315.72 | 279.18 |
| | Total | 589.88 | 548.82 |

Neighbour/list construction and serial heap removals still dominate elimination;
projection dominates the noisy-surface relaxation case. Median ABI copying stays
below three milliseconds per profiled call, so eliminating one copy cannot close the
remaining target gaps. The direct 1M profile still exceeds the 1500 ms target;
the synthetic adaptive corpus is not the node density-mask acceptance case.
Final node medians and the 500/1000/1500 ms acceptance targets belong in the
separate ordinary-build benchmark table.

Raw reports: `out/session13/before-profile.json`, `after-profile.json`, and the
derived `profile-summary.md`. The same native LCG corpus also improved; its
baseline is one sample, and after values are medians of three independent runs:

| Native corpus | Before ms | After ms | Selected stages, before -> after ms |
|---|---:|---:|---|
| Uniform 1M -> 100k | 4035.13 | 3058.36 | KD 229.06 -> 220.98; neighbours 1599.09 -> 1508.27; heap removals 2124.44 -> 1267.32 |
| Adaptive 500k -> 100k | 3599.99 | 2505.88 | neighbours 2469.65 -> 1859.35; heap removals 994.26 -> 498.79 |
| Minimum-distance 500k | 288.26 | 61.13 | grid preparation 5.12 -> 5.52; selection 282.70 -> 55.36 |
| Planar relaxation 100k x 5 | 895.15 | 426.36 | KD 119.24 -> 94.04; grid 0 -> 13.64; repulsion 735.09 -> 278.63; projection 34.78 -> 28.39 |

Native logs: `out/session13/before-native-profile.log` and
`native-after-{1,2,3}.log`. Native and WASM profile corpora use different RNGs and
relaxation sizes; their absolute timings are not directly comparable.

## Whole-worker placement check

The optimized 500k uniform candidates -> 100k case was measured in rotating
interleaved order after warming both WASM instances. Every worker result matched
the main-thread indices exactly. The three-call medians were:

| Placement | Median ms |
|---|---:|
| Main thread | 900.5 |
| One worker, structured-cloned inputs | 965.6 |
| One worker, shared-copy preparation included | 1000.6 |
| One worker, existing SharedArrayBuffer input | 1021.8 |

Moving the serial selection to a worker frees the cooking thread but did not
improve elapsed time in this measured case, even with existing shared inputs.
This does not establish a crossover for every size or density pattern. The
report is `out/session13/placement-500k.json` (Node v24.14.0, i7-10700K, SIMD).

## Final ordinary-build medians and targets

The balanced twelve-round acceptance run passed **11/11 comparisons, exit 0**
with the pool off/four workers. The five additional default-pool cases passed
**5/5, exit 0** with fifteen workers. All **16/16** comparisons meet the unchanged
1.05 limit; the largest ratio is **1.0456809255**, on four-worker projected
relaxation. These are ordinary SIMD release-build medians; input-node cooks
are excluded from scatter node timings, and direct elimination includes its
ABI copies. Ratios are calculated from unrounded medians.

| Case | Auto, pool off ms | Auto, 4 workers ms | Auto, 15 workers ms | Target ms | Target outcome |
|---|---:|---:|---:|---:|---|
| 1M candidates -> 100k direct elimination | 3237.7 | n/a (no pool integration) | n/a | 1500 | missed |
| Uniform 100k blue-noise points | 1050.2 | 902.9 | 649.6 | 500 | missed in all configurations |
| Masked 100k blue-noise points | 2106.9 | 1234.4 | 811.0 | 1000 | met with 15 workers |
| 50k points, five projected passes | 1110.2 | 851.9 | 586.6 | 2000 | met in all configurations |
| 100k requested, exact minimum distance | 1175.3 | 958.0 | 707.4 | 2000 | met in all configurations |
| 1M points, relaxation off | 369.6 | 257.4 | 235.1 | 1000 | met in all configurations |

Of the three K-10b speed targets, the 100k masked target is met by the default
15-worker pool. Uniform 100k still takes 649.6 ms against 500 ms, and direct 1M
elimination takes 3237.7 ms against 1500 ms. With four workers both uniform
(902.9 ms) and masked (1234.4 ms) scatter miss their targets. Passing the auto
regression check does not mean these absolute speed targets were all reached.

| Case | Workers | Auto ms | Kernel ms | JS ms | Auto / faster explicit | Result |
|---|---:|---:|---:|---:|---:|---|
| Direct elimination 1M -> 100k | 0 | 3237.7 | 3240.1 | 6913.3 | 0.9993 | pass |
| 1M points, relaxation off | 0 | 369.6 | 387.7 | 378.4 | 0.9767 | pass |
| Uniform 100k | 0 | 1050.2 | 1040.8 | 1773.5 | 1.0091 | pass |
| Masked 100k | 0 | 2106.9 | 2123.8 | 2900.3 | 0.9920 | pass |
| Projected 50k, five passes | 0 | 1110.2 | 1172.2 | 1854.0 | 0.9471 | pass |
| Minimum distance, 100k requested | 0 | 1175.3 | 1130.2 | 3343.6 | 1.0399 | pass |
| 1M points, relaxation off | 4 | 257.4 | 255.2 | 254.5 | 1.0114 | pass |
| Uniform 100k | 4 | 902.9 | 912.5 | 896.5 | 1.0071 | pass |
| Masked 100k | 4 | 1234.4 | 1779.0 | 1210.4 | 1.0198 | pass |
| Projected 50k, five passes | 4 | 851.9 | 957.1 | 814.7 | 1.0457 | pass |
| Minimum distance, 100k requested | 4 | 958.0 | 991.9 | 1308.6 | 0.9659 | pass |
| 1M points, relaxation off | 15 | 235.1 | 230.6 | 232.5 | 1.0198 | pass |
| Uniform 100k | 15 | 649.6 | 901.7 | 629.9 | 1.0313 | pass |
| Masked 100k | 15 | 811.0 | 1782.3 | 820.8 | 0.9881 | pass |
| Projected 50k, five passes | 15 | 586.6 | 944.4 | 562.7 | 1.0424 | pass |
| Minimum distance, 100k requested | 15 | 707.4 | 967.9 | 820.5 | 0.8621 | pass |

Raw reports are `out/session13/assert-auto-final-4.json` and
`out/session13/assert-auto-final-15.json`. The four-worker command was:

```powershell
$env:TOPOTOPO_WASM = 'simd'
node bench/bench.ts --assert-auto --workers 4 --runs 12 --output out/session13/assert-auto-final-4.json
```

`out/session13/verify-default-pool.ps1` then ran the five node cases with
`node --expose-gc bench/bench.ts --assert-auto-case CASE --workers 15 --runs 12`,
checked each child exit code and its `passed` result, and would exit 1 on an
assertion failure. It exited 0. The wrapper avoids repeating the completed
pool-off cases and the direct kernel case, which has no pool integration.

The largest reported child-process peak RSS was **2543.6 MiB** (2,667,159,552
bytes), in masked scatter with fifteen workers. This is the process high-water
mark across warm-ups and timed calls, including worker/WASM heaps and retained
allocations; it is not live allocation for one call or the sum of every child.

Ordinary release packages recorded in `out/session13/wasm-hashes.json`:

| Package | Bytes | SHA-256 |
|---|---:|---|
| Scalar | 764717 | `2e778b90e1cb697e74bf2f901f40b5ef36bab0266e7e304be5dd588ee3fe291d` |
| SIMD | 757192 | `23ed8e5d78f2134e988e0c6ba34343d106fa4596446663a3c811a8abbceafe94` |

Combined WASM size is **1,521,909 bytes**. Stage-profile timings above remain
separate from these ordinary-build acceptance measurements.

## Final identity and gates

The Rust commands below cover the final, unchanged Rust sources and the ordinary
release packages. The earlier focused profile-package runs passed 1716 scatter
checks and 124 pool checks; the expanded final TypeScript suites are verified
by the full npm chain below. No new runtime dependency was added.

| Required gate | Final result |
|---|---|
| `cargo test --manifest-path kernels/Cargo.toml` | Exit 0; 112 tests passed |
| `cargo test --manifest-path kernels/Cargo.toml --features simd` | Exit 0; 112 tests passed |
| `cargo clippy --manifest-path kernels/Cargo.toml --all-targets -- -D warnings` | Exit 0 |
| Same clippy command with `--features simd` | Exit 0 |
| `cargo fmt --manifest-path kernels/Cargo.toml --check` | Exit 0 |
| `npm run kernels:build` | Exit 0; scalar 764717 / SIMD 757192 bytes |
| `npm run typecheck` | Exit 0 after all dispatch/test edits |
| `npm test` (full chain) | Exit 0; 290 goldens, 222 examples, 1741 scatter checks, 151 pool checks, 514 scalar/SIMD comparisons across 21 exports |
| `npm run build` | Exit 0; 115 modules, one asset |
| `npm run pack:test` | Exit 0; installed CLI/library/MCP/preview and WASM cook passed, 16 seconds |
| `npm run showcase` and tracked-render byte comparison | Exit 0; all 33 SHA-256 hashes unchanged |
| Balanced `--assert-auto`, pool off/four workers | Exit 0; 11 passed, 0 failed |
| Additional default-pool (15 workers) auto coverage | Exit 0; 5 passed, 0 failed |

All 290 goldens and 33 tracked showcase renders remained unchanged; no golden
update was run. The particles, terrain_erosion and unreal_demo renders were also
visually inspected. Exact parity covers JS/scalar WASM/SIMD WASM, grid cutoffs and
SIMD tails, sparse/extreme domains, ordinary/shared worker inputs, and pool
on/off node cooks for the new adaptive, uniform and projected mixed paths.
Cross-platform determinism beyond the exercised machine is not established.
`npm run docs` and the final `git diff --check` also passed. Logs and gate exit
codes are retained in `out/session13/`, including `gate-status.json` and the
before/after render hash manifests. Package README copies were synchronized
after documenting the final auto rule; ordinary WASM binaries were unchanged.

Earlier unsuccessful setup attempts were corrected before their measurements:
the npm profile-build invocation stripped `--features` and was retried with
`node scripts/kernels-build.ts --features profile`; the first profile harness
call omitted TriSurface's explicit triangle list; typecheck found a profile
harness sample-array annotation error. Those attempts were not successful gates.
The corrected profile runner completed both before/after corpora, and a later
ordinary `npm run kernels:build` restored release packages. The chronological
log below preserves these retries and the last command for recovery.

## Progress and recovery log (chronological appendix)

Earlier policy descriptions in this appendix are progress snapshots; the final
rule and protocol above supersede them. Existing entries are retained verbatim.

- Started from clean `codex/kernels`, HEAD `66474568de0ab8a7ad3356aa30f10d363b316a42`.
- Process inventory before baseline: no other repository Node/Cargo/rustc jobs; the session's Codex launcher is excluded. Unrelated MCP services remain running. All agents are holding CPU-heavy commands during measurements.
- Last command starting: `TOPOTOPO_WORKERS=4 TOPOTOPO_WASM=simd node bench/bench.ts --filter scatter --backend kernel --runs 3 --output out/session13/before-kernel-4.json`.
- Baseline kernel (4 workers) completed, exit 0; last command starting: `TOPOTOPO_WORKERS=4 TOPOTOPO_WASM=simd node bench/bench.ts --filter scatter --backend js --runs 3 --output out/session13/before-js-4.json`.
- Baseline JS (4 workers) completed, exit 0; last command starting: `cargo bench --manifest-path kernels/Cargo.toml --features profile --bench scatter`, followed by baseline profile WASM build.
- Native baseline profile completed. The profile build command through npm failed before compilation because npm stripped `--features`; retrying with `node scripts/kernels-build.ts --features profile` (ordinary final build still uses `npm run kernels:build`).
- Baseline profile WASM build completed, exit 0; last command starting: `node --expose-gc bench/scatter-profile.ts --runs 3 --output out/session13/before-profile.json`.
- First profile runner stopped before measurements: missing explicit triangle list to TriSurface; fixed harness and retrying the same command.
- Baseline WASM profiling completed (all six cases), exit 0. Optimized Rust implementation restored; next commands: Rust format/tests/native profile (agent) and `npm run typecheck`.
- Typecheck passed after fixing the profile harness array annotation. Next: optimized profile WASM build; native tests may run concurrently, but timings wait until both finish.
- Optimized Rust gates passed: 112 tests per feature set, clippy both, fmt; focused WASM parity 1716 checks and pool 124 checks passed. Last command starting: optimized `bench/scatter-profile.ts` (all other repository tests/builds stopped).
- Optimized profile complete: direct1m median 3258ms, adaptive500k 2578ms, dense min-distance 83ms. Next: ordinary release `npm run kernels:build`, then interleaved auto selection benchmarks (not profile binaries).
- Ordinary scalar/SIMD build passed (764717/757192 bytes). Last command: `node bench/bench.ts --assert-auto --filter scatter_relax --workers 4 --runs 3 --output out/session13/tune-relax.json`; auto still selects all eligible kernels for this measurement.
- First interleaved assertion correctly failed old auto policy: four-worker masked auto2073/kernel2179/js1505ms and iterative auto1065/kernel1078/js954ms; uniform auto/kernel identical routing also showed 8% timing spread in three samples. Last command: masked crossover sweep, 4 workers at 5k/10k/50k output points and 2/15 workers at 100k, three timed rounds each.
- Masked crossover: 4 workers, 25k/50k candidates favour kernel (66/121ms vs JS129/141); 250k favours JS (688 vs845); 500k at2 workers is near crossover (2080 vs2177), and 15 workers favours JS (1228ms). Last command: refine 4-worker candidate cutoff and measure iterative cases at pool2/15.
- Iterative measurements: 10k output at4 workers roughly tied (kernel277/JS280ms), 50k at2 favours kernel (1166/1341), 50k at15 favours JS (1059/744). Last command: final crossover refinement (4-worker masked 30k/40k output; 3-worker masked and relaxation).
- Auto policy implemented: adaptive elimination uses JS at200k candidates/3+ workers or500k/2workers; projected relaxation uses JS at50k kept points/3+workers; other eligible stages stay WASM. Last command: 500k-candidate worker placement with ordinary/shared inputs.
- Placement500k favours main (median900.5ms vs worker clone965.6/shared-ready1021.8); retained 1M worker threshold. Policy typecheck and docs generation passed. Last command: final `node bench/bench.ts --assert-auto --workers 4 --runs 7 --output out/session13/assert-auto-4.json` (all repository build/test jobs stopped).
- First seven-round final assertion completed: 7 passed, 5 failed (four same-path/no-selection timing failures and a four-worker uniform crossover). Preserved `assert-auto-4.json`; switching to a fixed 12-round six-permutation schedule, three warm-ups, with the 1.05 bound unchanged. Next: six-round uniform pool-size calibration, then the complete final suite.
- Balanced uniform calibration completed (six timed rounds): 500k candidates kernel/JS medians at3 workers1073/1107ms, at4 workers1006/999, at8 workers1011/792, at15 workers1043/730; 250k at15 workers506/379. Next: verify250k uniform at8 workers and adaptive200k at3 before finalizing the extended rule.
- Uniform250k at8 workers confirmed kernel465/JS360ms; adaptive200k at3 confirmed auto522/kernel521/JS514 (ratio1.015). Final auto now also selects uniform JS at500k candidates/4+ workers or250k/8+. Last command starting: balanced final `node bench/bench.ts --assert-auto --workers 4 --runs 12 --output out/session13/assert-auto-final-4.json`.
- Balanced full assertion finished: 11 passed, 0 failed, exit0; maximum auto ratio1.0457. Last command starting: `out/session13/verify-default-pool.ps1`, five node cases at15 workers with three warm-ups/twelve balanced timed rounds each, using the same assertion measurement function (direct elimination has no pool path and is not repeated).
- Default15-worker follow-up finished: 5 passed, 0 failed, exit0; total16/16 final comparisons pass. Masked auto811ms meets1s target at15 workers; uniform650ms and direct3238ms still miss. Last command starting: `out/session13/verify-gates.ps1` (typecheck, full npm test, build, pack:test, showcase and SHA-256 render comparison); timing runs are finished.
- Final gates completed, all exit0: typecheck, full npm test, build, pack:test and showcase; 290 goldens unchanged and33/33 render hashes identical, with three relevant renders visually inspected. No process died during session13. Final review and signed-off commit follow; no push.

# Session 14 (K-11): depression filling and drainage (2026-10-14)

Started on clean `codex/kernels` at `3f470aacd6a23eb9f35d47a1dcd86530f0bbf8ce`.
This session adds `fill_sinks`, `heightfield_fill_sinks`, optional filled routing
for `heightfield_flow` and stream-power erosion, and `examples/drainage.json`.
No runtime or Rust dependency was added. All existing geometry outputs remain
unchanged with the default parameters.

## Algorithm and layer contract

An original eight-neighbour Barnes priority-flood implementation uses a monotone
radix queue over ordered Float32 bits, with deterministic LIFO equal-priority
buckets, row-major outlet insertion, and fixed compass-order neighbour visits.
At epsilon zero a FIFO depression queue bypasses priority operations for cells
below the current spill level. Positive epsilon uses at least the next Float32
value above the receiver, so every unrestricted interior cell has a lower
neighbour. The optional parent directions also resolve epsilon-zero flats.
Filled D8/D-infinity flow prefers ordinary downhill receivers, then uses those
parents on flats and accumulates in a deterministic topological order.

`fill` is added terrain thickness. `lake` is standing-water depth in metres over
unchanged ground: a positive `max_depth` retains a whole connected positive-fill
depression if its maximum physical spill depth exceeds the threshold. This
classification precedes epsilon, which cannot inflate lake depths. A mask of one
preserves a sample and treats it as a terminal outlet; fractional mask values
below one remain eligible for filling. Retained lakes and protected outlets are
explicit exceptions to border drainage. Zero `max_depth` means unlimited filling.

Filled flow does not replace the stored ground. Stream power optionally updates
filled routing each iteration and uses a minimum flat receiver drop of
`max(1e-4 * cell_size, one Float32 height step)` for incision. The pipe solver still
transports and deposits sediment, so positive pit wear need not produce the same
net lowering after deposition. Pipe/stream-power erosion initialize water from
`lake`; afterwards that layer equals simulated `water` within the original lake
footprint. Both are depths in metres; legacy droplet water remains its normalized
resting-water mask. There is no new lake-volume solver, breaching or tile system.

## Node SIMD timings

Intel Core i7-10700K (8 cores / 16 logical processors), Windows x64
`10.0.26200`, Node `v24.14.0`, ordinary release SIMD package. All session builds,
tests and rendering had finished before measuring; no repository compute job ran
alongside the benchmark. A two-second process sample immediately before timing
recorded 5% total background CPU and about 58 GiB free physical memory (usual
desktop/MCP services left running). Evidence: `out/session14/idle-before.json`.

`bench/drainage.ts` measures the public adapter call, including input validation,
allocation, JS-to-WASM copies, the flood, and all three returned Float32 layers.
Optional directions are disabled. Inputs and output checks are outside the timer;
two full-size warmups precede five calls, with forced GC before each call. Values
below are medians, not selected best runs. No worker pool participates.

The massif is a rounded hill with four octaves of deterministic integer-hash
bilinear value noise (cell wavelengths 128, 32, 8 and 2); the bowl exercises broad
closed depressions; the rough case adds independent per-cell hash noise to a hill.
All use identical explicit input generation at both grid sizes.

| Terrain | Epsilon | 1024² median ms | Target ms | 4096² median ms | Target ms |
|---|---:|---:|---:|---:|---:|
| Noisy massif | 0 | 70.3 | <150, met | 1605.0 | <2000, met |
| Closed bowl | 0 | 28.8 | <150, met | 1018.3 | <2000, met |
| Rough terrain | 0 | 61.3 | <150, met | 1772.5 | <2000, met |
| Noisy massif, epsilon gradient | 0.00001 | 73.7 | <150, met | 1654.3 | <2000, met |

All eight medians and every measured call meet their targets. The 4096² massif
actually fills 3,024,546 cells; the rough case fills 6,503,059; the bowl fills
16,760,836. Peak process RSS across the six epsilon-zero cases was **741.1 MiB**,
including the warmed WASM heap and JS copies. These timings cover filling,
not the additional flow accumulation or repeated stream-power solves, and do not
claim a bound for every possible DEM or positive lake-depth threshold.

```powershell
$env:TOPOTOPO_WASM = 'simd'
$env:TOPOTOPO_WORKERS = '0'
node --expose-gc bench/drainage.ts --runs=5 --output=out/session14/drainage.json
node --expose-gc bench/drainage.ts --runs=5 --terrain=massif --epsilon=0.00001 --output=out/session14/drainage-epsilon.json
```

Both commands exited 0. The JSON reports retain all samples, input fill counts,
fill-depth sums, package identity, target flags and peak RSS.

## Verification and artifacts

| Required gate | Final result |
|---|---|
| `cargo test --manifest-path kernels/Cargo.toml` | Exit 0, 121 tests (66 unit + 55 integration) |
| Same with `--features simd` | Exit 0, 121 tests |
| `cargo clippy --manifest-path kernels/Cargo.toml --all-targets -- -D warnings` | Exit 0 |
| Same clippy command with `--features simd` | Exit 0 |
| `cargo fmt --manifest-path kernels/Cargo.toml --check` | Exit 0 |
| `npm run kernels:build` | Exit 0; final rebuild byte-identical to tested packages |
| `npm run typecheck` | Exit 0 |
| `npm run test:update` | Exit 0; exactly 2 added, all 290 existing goldens unchanged |
| `npm run docs` | Exit 0; reference contains 223 node types |
| `npm test` | Exit 0, full chain (261 seconds) |
| `npm run build` | Exit 0; 115 modules, one asset |
| `npm run pack:test` | Exit 0; installed scalar/SIMD filling and retained lakes, plus both README links checked |
| `npm run showcase` | Exit 0; all 33 existing PNG hashes unchanged, only drainage added |

The full npm chain includes 156 heightfield checks, 2,109 erosion integration
checks (including real worker dispatch for fill, flow, stream power and lakes),
and 602 byte-exact scalar/SIMD comparisons across all 22 exports. Rust checks
include path termination, strict epsilon descent, masks, whole-lake thresholds,
repeatability, hostile inputs, independent minimax-spill relaxation on irregular
terrain, and conservation of contributing area after filled D8/D-infinity routing.
Cross-platform byte identity was not separately exercised on another operating
system; both shipped variants and pool execution were exercised on this machine.

New goldens are `node.heightfield_fill_sinks.json` and `example.drainage.json`.
The new `examples/renders/drainage.png` was visually inspected: the unfilled
massif is left, filled routing is right, tributaries are gold, rivers orange,
and the retained lake blue. The demo has 220 interior sinks before filling and
zero in filled routing, 1,764 filled samples and 383 retained lake samples.
Its water-surface height varies by only one Float32 step. Showcase and example
tests discover the new graph automatically; no registration code was necessary.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| Scalar WASM | 777644 | `a0c48ae0ff5664ec38074cbf4ee0bdb25b311e4e7dd3bc4071f0fb60eaa70df0` |
| SIMD WASM | 771210 | `1739933fd8209664072e3c0d6a864d8c45227fea9d8844927a949697d7ea0619` |
| Drainage render | — | `e3b7879dbd6b885817eac03dd780ba56d29925271f8d53e868912f822eef774b` |

Combined WASM is 1,548,854 bytes (limit 2,500,000). The source and generated
package READMEs use absolute repository URLs for BUILD/BENCH, fixing R-19's
tarball-relative links. Logs and before/after manifests are in `out/session14/`.

Initial targeted checks caught test-fixture assumptions (dry stream power cannot
incise; deposited sediment can restore bed height) and three Clippy style findings.
The fixtures and style were corrected, both final native test suites and Clippy
were rerun, and the final WASM build was byte-identical. An early shell wrapper's
trailing Windows-glob diagnostic exited 1 after passing native tests; the final
gate commands' exit codes above were checked individually. No failing acceptance
gate remains, and no push or unrelated project work was performed.
