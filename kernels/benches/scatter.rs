// Native stage timings: cargo bench --features profile --bench scatter.
// Node acceptance timings, including the WASM ABI, live in bench/bench.ts.
use topotopo_kernels::scatter::eliminate;
fn main() {
    let n = 1_000_000;
    let mut state = 1_u32;
    let p: Vec<f64> = (0..n * 3)
        .map(|k| {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            if k % 3 == 1 {
                0.0
            } else {
                f64::from(state) / 4294967296.0 * 100.0
            }
        })
        .collect();
    let radius = (10000.0 / (2.0 * 3.0_f64.sqrt() * 100000.0)).sqrt();
    let now = std::time::Instant::now();
    let kept = eliminate(&p, &[], n / 10, radius).unwrap();
    println!(
        "{} kept in {:.3} s",
        kept.len(),
        now.elapsed().as_secs_f64()
    );
}
