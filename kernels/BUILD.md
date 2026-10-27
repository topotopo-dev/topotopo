# Building the checked-in WASM

Normal installation and `npm test` use the committed `pkg/` (scalar) and `pkg-simd/`
(simd128) and require no Rust. `npm run kernels:build` rebuilds both packages; the
loader selects SIMD by default when its feature probe succeeds.
Run these commands from the repository root to rebuild:

```powershell
rustup target add wasm32-unknown-unknown
npm run kernels:build
cargo test --manifest-path kernels/Cargo.toml
cargo test --manifest-path kernels/Cargo.toml --features simd
cargo clippy --manifest-path kernels/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path kernels/Cargo.toml --all-targets --features simd -- -D warnings
cargo fmt --manifest-path kernels/Cargo.toml --check
node test/kernelsloader.ts
node test/erosionsimd.ts
cargo bench --manifest-path kernels/Cargo.toml --bench wavefront
cargo bench --manifest-path kernels/Cargo.toml --bench remesh_quad
node bench/remeshquad.ts
cargo bench --manifest-path kernels/Cargo.toml --bench erosion
node bench/erosion.ts --runs=3
```

Opt-in erosion pass profiling uses the same fixtures and a monotonic clock:

```powershell
cargo bench --manifest-path kernels/Cargo.toml --bench erosion --features profile
node scripts/kernels-build.ts --features profile
node bench/erosion.ts --runs=3
# Restore both ordinary packages before tests, acceptance timings and commit.
npm run kernels:build
```

The `profile` feature adds native/WASM JSON timings; ordinary builds erase the
clocks and counters. Row-fused pipe passes call the clock once per row/stage, so
profile totals include clock overhead. Droplet sub-step samples cover one in 256
droplets, overlap the coarse hydraulic timer, and include substantial timing
overhead. Use uninstrumented builds for acceptance. Both erosion benchmark commands
accept `--pipe-only`, `--droplet-only`, and `--runs=N` (Cargo arguments follow `--`).
Native `--runs` controls pipe repetitions; its droplet fixture remains one analytic
valley call. Node also prints process CPU time, including any WASM compiler threads,
as a contention diagnostic; the acceptance target always uses elapsed time.
Before timing, inspect `tasklist /FI "IMAGENAME eq node.exe"` and
`tasklist /FI "IMAGENAME eq cargo.exe"`; use process command lines to distinguish
repository servers, builds and tests from unrelated tools. Run benchmarks
sequentially without concurrent repository work. An exit code of zero validates
execution, not the speed targets.

Toolchain used on 2026-10-13:

```text
rustc 1.94.0 (4a4ef493e 2026-03-02)
cargo 1.94.0 (85eff7c80 2026-01-15)
wasm-pack 0.15.0
wasm-bindgen 0.2.129 (locked crate and generated bindings)
target wasm32-unknown-unknown
```

`Cargo.lock` must be retained. Release settings are optimization level 3, LTO, one codegen
unit, stripped symbols and panic=abort. Invalid geometry is handled by Rust `Result`
errors, not panics. `wasm-pack` runs `wasm-opt -O3 --enable-bulk-memory
--enable-nontrapping-float-to-int --enable-simd`. The combined scalar and
SIMD WASM budget is 2,500,000 bytes, enforced by `kernels:build`, `build` and
`pack:test`. The existing Node smoke test also retains its stricter 1,000,000-byte
per-module check.

The speed-focused release settings are intentional: sampled-grid BVH traversal and
dual-contouring loops are CPU-bound, and the combined module remains comfortably
within the combined size budget. No fast-math, relaxed SIMD, or explicit fused
multiply-add flags are enabled; scalar operation order remains deterministic.

## Two builds and runtime selection

`scripts/kernels-build.ts` runs the following two release builds with separate
`RUSTFLAGS` (or appends to `CARGO_ENCODED_RUSTFLAGS` if it is set):

```powershell
$env:RUSTFLAGS = '-C target-feature=-simd128,-relaxed-simd'
wasm-pack build kernels --target web --release --out-dir pkg -- --no-default-features
$env:RUSTFLAGS = '-C target-feature=+simd128,-relaxed-simd'
wasm-pack build kernels --target web --release --out-dir pkg-simd -- --no-default-features --features simd
Remove-Item Env:RUSTFLAGS
```

Each directory has its own JS glue, declarations and `topotopo_kernels_bg.wasm`.
Both builds run wasm-opt with SIMD instruction support enabled; the scalar Rust
build disables the SIMD target feature and does not enable the crate's `simd`
feature. No relaxed SIMD, fast-math or FMA is enabled.

`src/wasm/kernels.ts` calls `WebAssembly.validate` on a minimal module containing
`v128.const` before importing either glue module. A supported runtime chooses
`pkg-simd`; otherwise it chooses `pkg`. Detection does not compile either full
kernel module or inspect user-agent/version strings. Only the selected bytes are
read through the host. Importing the loader does not perform I/O or instantiate
WASM, and concurrent callers still share a single initialisation.

For deterministic testing or comparisons, set `TOPOTOPO_WASM=scalar` or
`TOPOTOPO_WASM=simd` **before the first import**, including imports in workers.
Forcing SIMD on an unsupported runtime fails with a clear error. Invalid values
also fail; an unset or empty value means automatic detection. Browser hosts need
no environment variable and select by the same feature probe.

```powershell
$env:TOPOTOPO_WASM = 'scalar'
node bench/erosion.ts --runs=3
$env:TOPOTOPO_WASM = 'simd'
node bench/erosion.ts --runs=3
Remove-Item Env:TOPOTOPO_WASM
```

`test/kernelsloader.ts` covers both overrides, automatic selection, an unsupported
SIMD fallback, invalid/unsupported overrides, and feature detection without a
Node process global. `test/erosionsimd.ts` compares every kernel export across
the two shipped builds. Both run in `npm test` and `npm run test:kernels`.
`npm run pack:test` verifies the two complete modules in the tarball, automatic
SIMD selection from an installed package and scalar/SIMD override execution.

In **both** `pkg/` and `pkg-simd/`, commit `topotopo_kernels.js`,
`topotopo_kernels_bg.wasm`, both `.d.ts` files, `package.json`, `README.md`,
`LICENSE` and `.npmignore`. `wasm-pack` writes a `.gitignore` containing `*`;
`npm run kernels:build` removes it from each output. The checked-in `.npmignore`
also prevents npm from hiding the generated modules if wasm-pack is invoked
directly. Add generated files with explicit paths; never commit `target/`,
`dist/` or tarballs.

For a browser smoke test, serve the repository over HTTP and open `kernels/demo.html`.
It fetches the same committed WASM bytes and checks rectangle, L-shape and courtyard
skeleton, offset, roof and replay determinism. `file://` access is not supported by the
browser's fetch rules. The production host-agnostic loader lives in `src/wasm/kernels.ts`.
The current demo also checks three SDF contours and both quad remeshing modes,
including deterministic replay and point provenance.
