use topotopo_kernels::{roof_mesh, skeleton};
use std::{hint::black_box, time::Instant};

fn main() {
    let mut state = 11u64;
    let mut polygon = Vec::new();
    for i in 0..200 {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let r = 4. + ((state >> 32) as u32 as f64 / u32::MAX as f64);
        let a = i as f64 * std::f64::consts::TAU / 200.;
        polygon.extend([r * libm::cos(a), r * libm::sin(a)]);
    }
    for roof in [false, true] {
        let mut timings = Vec::new();
        for _ in 0..11 {
            let start = Instant::now();
            if roof {
                black_box(
                    roof_mesh(black_box(&polygon), &[], &[35.], None).expect("benchmark polygon"),
                );
            } else {
                black_box(skeleton(black_box(&polygon), &[], &[]).expect("benchmark polygon"));
            }
            timings.push(start.elapsed().as_secs_f64() * 1000.);
        }
        timings.sort_by(f64::total_cmp);
        println!(
            "{}: 200 vertices, median {:.3} ms, min {:.3} ms, 11 runs",
            if roof { "roof" } else { "straight_skeleton" },
            timings[5],
            timings[0]
        );
    }
}
