# Building the checked-in WASM

Normal installation and `npm test` use the committed `pkg/` and require no Rust.
Run these commands from the repository root to rebuild:

```powershell
rustup target add wasm32-unknown-unknown
npm run kernels:build
# Equivalent: wasm-pack build kernels --target web --release
cargo test --manifest-path kernels/Cargo.toml
cargo clippy --manifest-path kernels/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path kernels/Cargo.toml --check
cargo bench --manifest-path kernels/Cargo.toml --bench wavefront
cargo bench --manifest-path kernels/Cargo.toml --bench remesh_quad
node bench/remeshquad.ts
```

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
--enable-nontrapping-float-to-int`. The session's budget is strictly below 1,000,000 bytes
for session 1; session 2's total WASM budget is 1,500,000 bytes and session 3's is
2,000,000 bytes. The existing Node smoke test also retains its stricter 1,000,000-byte
check. See [BENCH.md](BENCH.md)
for the measured size.

The speed-focused release settings are intentional: sampled-grid BVH traversal and
dual-contouring loops are CPU-bound, and the combined module remains comfortably
within the session-2 size budget. No fast-math, relaxed SIMD, or explicit fused
multiply-add flags are enabled; scalar operation order remains deterministic.

Commit `pkg/polyforge_kernels.js`, `polyforge_kernels_bg.wasm`, both `.d.ts` files,
`package.json`, `README.md` and `LICENSE`. `wasm-pack` writes a `pkg/.gitignore` containing
`*`; add generated files with explicit `git add -f <paths>` the first time. Once tracked,
subsequent builds update them normally. Never commit `target/`.

For a browser smoke test, serve the repository over HTTP and open `kernels/demo.html`.
It fetches the same committed WASM bytes and checks rectangle, L-shape and courtyard
skeleton, offset, roof and replay determinism. `file://` access is not supported by the
browser's fetch rules. The production host-agnostic loader lives in `src/wasm/kernels.ts`.
The current demo also checks three SDF contours and both quad remeshing modes,
including deterministic replay and point provenance.
