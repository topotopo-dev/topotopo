//! Native SDF construction profile; run with `cargo run --release --features
//! profile --example sdfgrid_bench -- --resolution=256`. The matching Node/WASM
//! benchmark includes contouring and transfer costs in `bench/sdfgrid.ts`.
use std::time::Instant;
use topotopo_kernels::sdf::sdf_from_mesh;

fn main() {
    let resolution = std::env::args()
        .find_map(|arg| arg.strip_prefix("--resolution=").map(str::to_owned))
        .map(|value| value.parse::<usize>().expect("integer resolution"))
        .unwrap_or(256);
    assert!((16..=384).contains(&resolution));
    let positions = [
        -1., -1., -1., 1., -1., -1., 1., 1., -1., -1., 1., -1., -1., -1., 1., 1., -1., 1., 1., 1.,
        1., -1., 1., 1.,
    ];
    let triangles = [
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3,
        1, 2, 6, 1, 6, 5,
    ];
    for (samples, fill, warmup) in [
        (64.min(resolution), false, true),
        (resolution, false, false),
        (resolution, true, false),
    ] {
        let voxel = 2. / (samples - 9) as f64 * (1. + 1e-12);
        let start = Instant::now();
        let grid = sdf_from_mesh(&positions, &triangles, voxel, 3., 4., fill).unwrap();
        let ms = start.elapsed().as_secs_f64() * 1000.;
        assert_eq!(grid.dims, [samples as u32; 3]);
        println!(
            "{{\"resolution\":{samples},\"fill\":{fill},\"warmup\":{warmup},\"grid_ms\":{ms:.6},\"samples\":{}}}",
            grid.values.len()
        );
    }
}
