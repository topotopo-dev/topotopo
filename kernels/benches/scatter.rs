// Native stage timings: cargo bench --features profile --bench scatter.
// Node acceptance timings, including the WASM ABI, live in bench/bench.ts.
use topotopo_kernels::scatter::{eliminate, min_distance};
use topotopo_kernels::scatter_relax::{Params, Surface, relax};

fn timed<T>(name: &str, call: impl FnOnce() -> T) -> T {
    println!("case: {name}");
    let now = std::time::Instant::now();
    let result = call();
    println!("{name}: {:.3} ms", now.elapsed().as_secs_f64() * 1000.0);
    result
}

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
    let kept = timed("uniform_1m", || eliminate(&p, &[], n / 10, radius).unwrap());
    assert_eq!(kept.len(), n / 10);
    let masked = &p[..500_000 * 3];
    let scale: Vec<f64> = masked.chunks_exact(3).map(|p| 0.5 + p[0] / 100.0).collect();
    let kept = timed("varying_500k", || {
        eliminate(masked, &scale, 100_000, radius).unwrap()
    });
    assert_eq!(kept.len(), 100_000);
    let order: Vec<i32> = (0..500_000).collect();
    let selected = timed("min_distance_500k", || {
        min_distance(masked, &order, 0.25, 100_000, &[], 0).unwrap()
    });
    assert!(!selected.is_empty());

    let corners = [
        0.0, 0.0, 0.0, 100.0, 0.0, 0.0, 0.0, 0.0, 100.0, 100.0, 0.0, 0.0, 100.0, 0.0, 100.0, 0.0,
        0.0, 100.0,
    ];
    let surface = Surface {
        triangles: &corners,
        corners: &corners,
        nodes: &[0.0, 0.0, 0.0, 100.0, 0.0, 100.0],
        child: &[-1, 2],
        order: &[0, 1],
        tri_prim: &[0, 1],
    };
    let positions = &p[..100_000 * 3];
    let spacing = vec![0.5; 100_000];
    let triangles = vec![0; 100_000];
    let barycentrics = vec![0.0; 100_000 * 3];
    let relaxed = timed("relax_100k_5", || {
        relax(
            positions,
            &spacing,
            &triangles,
            &barycentrics,
            surface,
            &[],
            Params {
                radius: 0.5,
                weighted: false,
                d_bar: 0.5,
                w_mean: 1.0,
                iterations: 5,
            },
        )
        .unwrap()
    });
    assert_eq!(relaxed.positions.len(), positions.len());
}
