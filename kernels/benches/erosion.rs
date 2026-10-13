use polyforge_kernels::erosion::{PipeParams, erode_pipe};
use polyforge_kernels::erosion_droplet::{DropletParams, erode_droplet};
use std::{hint::black_box, time::Instant};

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let runs: usize = args
        .iter()
        .find_map(|a| a.strip_prefix("--runs="))
        .map_or(3, |value| value.parse().expect("--runs must be an integer"));
    assert!((1..=10).contains(&runs));
    let pipe_only = args.iter().any(|a| a == "--pipe-only");
    let droplet_only = args.iter().any(|a| a == "--droplet-only");
    let w = 1024usize;
    let height: Vec<f32> = (0..w * w)
        .map(|i| 32.0 + (w - 1 - i / w) as f32 / 64.0 + (i % w).abs_diff(w / 2) as f32 / 128.0)
        .collect();
    let p = PipeParams {
        iterations: 200,
        rain_amount: 0.01,
        thermal_rate: 0.1,
        ..Default::default()
    };
    let mut times = Vec::new();
    for run in 0..if droplet_only { 0 } else { runs } {
        let start = Instant::now();
        let r = erode_pipe(black_box(&height), None, None, None, w, w, 1.0, &p, 1).unwrap();
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        let checksum: f64 = r.height.iter().map(|&v| v as f64).sum();
        println!(
            "pipe native 1024^2 x 200 closed rain=.01 thermal=.1 run {run}: {ms:.3} ms, height sum {checksum:.9}"
        );
        times.push(ms);
        black_box(r);
    }
    times.sort_by(f64::total_cmp);
    if !times.is_empty() {
        println!(
            "pipe native release median: {:.3} ms; target 2000 ms",
            times[times.len() / 2]
        );
    }
    if pipe_only {
        return;
    }
    let w = 512usize;
    let height: Vec<f32> = (0..w * w)
        .map(|i| 4.0 + (w - 1 - i / w) as f32 / 64.0 + (i % w).abs_diff(w / 2) as f32 / 128.0)
        .collect();
    let p = DropletParams {
        iterations: 100,
        ..Default::default()
    };
    let start = Instant::now();
    let r = erode_droplet(black_box(&height), None, None, w, w, 0.1, &p, 1).unwrap();
    println!(
        "droplet native 512^2 x 100 default parameters, analytic valley: {:.3} ms, height sum {:.9}",
        start.elapsed().as_secs_f64() * 1000.0,
        r.height.iter().map(|&v| v as f64).sum::<f64>()
    );
    let w = 33usize;
    let h = 25usize;
    let height: Vec<f32> = (0..w * h)
        .map(|i| 4.0 + (h - 1 - i / w) as f32 / 16.0 + (i % w).abs_diff(w / 2) as f32 / 32.0)
        .collect();
    let p = PipeParams {
        iterations: 25,
        rain_amount: 0.01,
        ..Default::default()
    };
    let r = erode_pipe(&height, None, None, None, w, h, 1.0, &p, 1).unwrap();
    // FNV-1a over f32 little-endian bytes, matching bench/erosion.ts parity check.
    for (name, layer) in [
        ("height", r.height),
        ("sediment", r.sediment),
        ("debris", r.debris),
        ("flow", r.flow),
        ("water", r.water),
        ("wear", r.wear),
    ] {
        let mut hash = 2166136261u32;
        for value in layer {
            for byte in value.to_bits().to_le_bytes() {
                hash = (hash ^ u32::from(byte)).wrapping_mul(16777619);
            }
        }
        println!("parity {name}: {hash:08x}");
    }
}
