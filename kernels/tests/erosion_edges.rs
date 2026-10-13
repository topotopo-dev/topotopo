//! Boundary regressions for halo stencils and brushes larger than the terrain.

use polyforge_kernels::erosion::{ErosionResult, PipeParams, erode_pipe};
use polyforge_kernels::erosion_droplet::{DropletParams, erode_droplet};

fn sum(values: &[f32]) -> f64 {
    values.iter().map(|&value| f64::from(value)).sum()
}

fn terrain(w: usize, h: usize) -> Vec<f32> {
    (0..w * h)
        .map(|i| 10.0 + (i % w) as f32 * 0.25 + (i / w) as f32 * 0.125)
        .collect()
}

fn assert_finite(result: &ErosionResult, n: usize) {
    for layer in [
        &result.height,
        &result.sediment,
        &result.debris,
        &result.flow,
        &result.water,
        &result.wear,
    ] {
        assert_eq!(layer.len(), n);
        assert!(layer.iter().all(|value| value.is_finite()));
    }
    assert!(result.wear.iter().all(|&value| value >= 0.0));
    assert!(result.water.iter().all(|&value| value >= 0.0));
    assert!(result.flow.iter().all(|&value| value >= 0.0));
}

fn assert_conserved(input: &[f32], output: &[f32]) {
    let relative_error = (sum(output) - sum(input)).abs() / sum(input).abs();
    assert!(
        relative_error < 1e-6,
        "relative material error {relative_error}"
    );
}

#[test]
fn skinny_pipe_stencils_preserve_material_masks_and_replay() {
    for (w, h) in [(2, 2), (2, 9), (9, 2), (3, 4)] {
        let input = terrain(w, h);
        let n = input.len();
        let hardness: Vec<f32> = (0..n)
            .map(|i| if i % 5 == 1 { 1.0 } else { 0.25 })
            .collect();
        let freeze: Vec<f32> = (0..n).map(|i| if i % 7 == 0 { 1.0 } else { 0.0 }).collect();
        let rain: Vec<f32> = (0..n).map(|i| if i % 3 == 0 { 0.0 } else { 1.0 }).collect();
        for open_boundary in [false, true] {
            let params = PipeParams {
                iterations: 9,
                rain_amount: 0.08,
                talus_angle: 0.1,
                thermal_rate: 0.2,
                stream_power_k: 0.04,
                open_boundary,
                ..PipeParams::default()
            };
            for masked in [false, true] {
                let run = || {
                    erode_pipe(
                        &input,
                        masked.then_some(hardness.as_slice()),
                        masked.then_some(freeze.as_slice()),
                        masked.then_some(rain.as_slice()),
                        w,
                        h,
                        0.25,
                        &params,
                        7,
                    )
                    .unwrap()
                };
                let result = run();
                assert_finite(&result, n);
                assert_eq!(result, run(), "{w}x{h}, open={open_boundary}");
                // Pipe open boundaries export water only; all rock stays in-grid.
                assert_conserved(&input, &result.height);
                assert!(result.flow.iter().all(|&value| value <= 1.0));
                if masked {
                    for i in 0..n {
                        if freeze[i] == 1.0 {
                            assert_eq!(result.height[i], input[i], "frozen cell {i}");
                        }
                        if hardness[i] == 1.0 {
                            assert_eq!(result.wear[i], 0.0, "hard cell {i}");
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn oversized_droplet_brushes_preserve_skinny_grid_boundaries() {
    for (w, h) in [(2, 2), (2, 9), (9, 2), (3, 4)] {
        let input = terrain(w, h);
        let n = input.len();
        let hardness: Vec<f32> = (0..n)
            .map(|i| if i % 5 == 1 { 1.0 } else { 0.25 })
            .collect();
        let freeze: Vec<f32> = (0..n).map(|i| if i % 7 == 0 { 1.0 } else { 0.0 }).collect();
        for open_boundary in [false, true] {
            let params = DropletParams {
                iterations: 7,
                rain_density: 0.5,
                erosion_radius: 12.0,
                max_lifetime: 9,
                talus_angle: 0.1,
                thermal_rate: 0.2,
                open_boundary,
                ..DropletParams::default()
            };
            for masked in [false, true] {
                let run = || {
                    erode_droplet(
                        &input,
                        masked.then_some(hardness.as_slice()),
                        masked.then_some(freeze.as_slice()),
                        w,
                        h,
                        0.25,
                        &params,
                        7,
                    )
                    .unwrap()
                };
                let result = run();
                assert_finite(&result, n);
                assert_eq!(result, run(), "{w}x{h}, open={open_boundary}");
                if !open_boundary {
                    assert_conserved(&input, &result.height);
                }
                if masked {
                    for i in 0..n {
                        if freeze[i] == 1.0 {
                            assert_eq!(result.height[i], input[i], "frozen cell {i}");
                        }
                        if hardness[i] == 1.0 {
                            assert_eq!(result.wear[i], 0.0, "hard cell {i}");
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn open_pipe_edges_drain_water_below_the_terrain_height_precision() {
    let w = 7;
    let h = 5;
    let input = vec![100_000_000.0; w * h];
    let params = PipeParams {
        iterations: 8,
        rain_amount: 0.01,
        evaporation: 0.0,
        erosion_rate: 0.0,
        thermal_rate: 0.0,
        ..PipeParams::default()
    };
    let closed = erode_pipe(&input, None, None, None, w, h, 1.0, &params, 1).unwrap();
    let open = erode_pipe(
        &input,
        None,
        None,
        None,
        w,
        h,
        1.0,
        &PipeParams {
            open_boundary: true,
            ..params
        },
        1,
    )
    .unwrap();
    assert_finite(&closed, input.len());
    assert_finite(&open, input.len());
    // At this elevation, adding the shallow water to f32 terrain rounds it away.
    // The outgoing boundary head must still use the water depth directly.
    assert!(
        closed
            .water
            .iter()
            .all(|&depth| input[0] + depth == input[0])
    );
    assert!(sum(&open.water) < sum(&closed.water));
    assert_eq!(open.height, input);
    assert_eq!(closed.height, input);
}
