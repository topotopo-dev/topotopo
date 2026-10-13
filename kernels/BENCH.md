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
