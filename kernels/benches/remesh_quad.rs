use topotopo_kernels::remesh_quad::{RemeshOptions, remesh_quad};
use std::{hint::black_box, time::Instant};

fn main() {
    // Same 100,000-triangle analytic grid as bench/remeshquad.ts. Native uses
    // deterministic libm for fixture generation; Node uses its Math functions.
    let mut positions = Vec::with_capacity(201 * 251 * 3);
    for row in 0..=200 {
        for col in 0..=250 {
            let x = -1.0 + 2.0 * f64::from(col) / 250.0;
            let z = 1.0 - 2.0 * f64::from(row) / 200.0;
            positions.extend([x, 0.035 * libm::sin(3.0 * x) * libm::cos(5.0 * z), z]);
        }
    }
    let mut triangles = Vec::with_capacity(300_000);
    for row in 0..200 {
        for col in 0..250 {
            let a = row * 251 + col;
            triangles.extend([a, a + 1, a + 252, a, a + 252, a + 251]);
        }
    }
    let options = RemeshOptions {
        target_face_count: 25_000,
        smooth_iterations: 8,
        ..RemeshOptions::default()
    };
    let mut timings = Vec::new();
    for run in 0..4 {
        let start = Instant::now();
        let mesh = remesh_quad(black_box(&positions), black_box(&triangles), &options)
            .expect("valid noisy grid benchmark");
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        if run > 0 {
            timings.push(ms);
        }
        println!(
            "noisy_grid run {run} (0=warmup): {ms:.3} ms, {} faces, {} points, {:.4} quad fraction, {} singularities, edge min/mean/max {:.6}/{:.6}/{:.6}",
            mesh.prim_start.len() - 1,
            mesh.positions.len() / 3,
            mesh.quality.quad_fraction,
            mesh.quality.singularities,
            mesh.quality.edge_length_min,
            mesh.quality.edge_length_mean,
            mesh.quality.edge_length_max,
        );
        black_box(mesh);
    }
    timings.sort_by(f64::total_cmp);
    println!("noisy_grid native release median: {:.3} ms", timings[1]);
}
