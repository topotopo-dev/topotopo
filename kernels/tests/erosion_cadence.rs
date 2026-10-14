use topotopo_kernels::erosion::{ErosionResult, PipeParams, erode_pipe};

fn terrain(w: usize, h: usize) -> Vec<f32> {
    (0..w * h)
        .map(|i| 10.0 + (((i % w) * 13 + (i / w) * 47) % 31) as f32 / 8.0)
        .collect()
}

fn assert_bits(actual: &[f32], expected: &[f32]) {
    assert_eq!(actual.len(), expected.len());
    for (i, (&a, &b)) in actual.iter().zip(expected).enumerate() {
        assert_eq!(a.to_bits(), b.to_bits(), "sample {i}: {a} != {b}");
    }
}

fn assert_result_bits(actual: &ErosionResult, expected: &ErosionResult) {
    for (a, b) in [
        (&actual.height, &expected.height),
        (&actual.sediment, &expected.sediment),
        (&actual.debris, &expected.debris),
        (&actual.flow, &expected.flow),
        (&actual.water, &expected.water),
        (&actual.wear, &expected.wear),
    ] {
        assert_bits(a, b);
    }
}

#[test]
fn interval_one_preserves_default_for_pipe_and_filled_stream_power() {
    assert_eq!(PipeParams::default().thermal_interval, 1);
    let (w, h) = (17, 11);
    let input = terrain(w, h);
    for stream_power_k in [0.0, 0.02] {
        let params = PipeParams {
            iterations: 9,
            rain_amount: 0.05,
            talus_angle: 0.1,
            stream_power_k,
            fill_sinks: stream_power_k > 0.0,
            ..Default::default()
        };
        let default = erode_pipe(&input, None, None, None, w, h, 0.5, &params, 3).unwrap();
        let explicit = erode_pipe(
            &input,
            None,
            None,
            None,
            w,
            h,
            0.5,
            &PipeParams {
                thermal_interval: 1,
                ..params
            },
            3,
        )
        .unwrap();
        assert_result_bits(&explicit, &default);
    }
}

#[test]
fn cadence_counts_full_intervals_and_final_remainder_on_thin_and_wide_grids() {
    // Hydraulic motion is disabled, so a separate call for each scheduled
    // relaxation gives an independent cadence oracle. Width 259 crosses the
    // hot-span boundary and has a SIMD tail; the two thin cases exercise both
    // surface-ring boundary drains without relying on a square domain.
    for (w, h) in [(2, 5), (5, 2), (259, 5)] {
        let input = terrain(w, h);
        let one_step = PipeParams {
            iterations: 1,
            rain_amount: 0.0,
            erosion_rate: 0.0,
            deposition_rate: 0.0,
            talus_angle: 0.0,
            thermal_rate: 0.2,
            ..Default::default()
        };
        for (iterations, passes) in [(0, 0), (1, 1), (3, 1), (4, 1), (5, 2), (8, 2), (11, 3)] {
            let actual = erode_pipe(
                &input,
                None,
                None,
                None,
                w,
                h,
                1.0,
                &PipeParams {
                    iterations,
                    thermal_interval: 4,
                    ..one_step.clone()
                },
                0,
            )
            .unwrap();
            let mut reference = input.clone();
            for _ in 0..passes {
                reference = erode_pipe(&reference, None, None, None, w, h, 1.0, &one_step, 0)
                    .unwrap()
                    .height;
            }
            assert_bits(&actual.height, &reference);
            assert!(actual.water.iter().all(|&v| v == 0.0));
            assert!(actual.flow.iter().all(|&v| v == 0.0));
            if passes > 0 {
                assert!(actual.debris.iter().any(|&v| v > 0.0));
                assert!(actual.height.iter().zip(&input).any(|(a, b)| a != b));
            }
        }
    }
}

#[test]
fn sparse_thermal_cadence_preserves_frozen_cells_and_closed_material() {
    let (w, h) = (33, 17);
    let input = terrain(w, h);
    let freeze: Vec<f32> = (0..input.len())
        .map(|i| {
            if i % 7 == 0 || i % w == w / 2 {
                1.0
            } else {
                0.0
            }
        })
        .collect();
    let params = PipeParams {
        iterations: 13,
        thermal_interval: 4,
        rain_amount: 0.2,
        talus_angle: 0.0,
        thermal_rate: 0.3,
        ..Default::default()
    };
    let result = erode_pipe(&input, None, Some(&freeze), None, w, h, 0.5, &params, 2).unwrap();
    for (i, &frozen) in freeze.iter().enumerate() {
        if frozen == 1.0 {
            assert_eq!(result.height[i].to_bits(), input[i].to_bits());
            assert_eq!(result.wear[i], 0.0);
            assert_eq!(result.debris[i], 0.0);
        }
    }
    let before: f64 = input.iter().map(|&v| f64::from(v)).sum();
    let after: f64 = result.height.iter().map(|&v| f64::from(v)).sum();
    assert!((after - before).abs() <= before * 1e-6);
    for layer in [
        &result.sediment,
        &result.debris,
        &result.flow,
        &result.water,
        &result.wear,
    ] {
        assert!(layer.iter().all(|&v| v.is_finite() && v >= 0.0));
    }
    let replay = erode_pipe(&input, None, Some(&freeze), None, w, h, 0.5, &params, 2).unwrap();
    assert_result_bits(&result, &replay);
}

#[test]
fn absent_masks_match_explicit_zero_masks_across_multiple_spans() {
    let (w, h) = (513, 7);
    let input = terrain(w, h);
    let zero_mask = vec![0.0; input.len()];
    for thermal_interval in [1, 4] {
        let params = PipeParams {
            iterations: 9,
            thermal_interval,
            rain_amount: 0.05,
            time_step: 0.02,
            talus_angle: 0.1,
            thermal_rate: 0.2,
            ..Default::default()
        };
        let unmasked = erode_pipe(&input, None, None, None, w, h, 0.5, &params, 4).unwrap();
        let zero_masked = erode_pipe(
            &input,
            Some(&zero_mask),
            Some(&zero_mask),
            None,
            w,
            h,
            0.5,
            &params,
            4,
        )
        .unwrap();
        assert_result_bits(&zero_masked, &unmasked);
    }
}

#[test]
fn invalid_intervals_fail_even_when_no_steps_or_thermal_work_are_requested() {
    let input = terrain(2, 2);
    for thermal_interval in [0, 10_001, u32::MAX] {
        for iterations in [0, 1] {
            let params = PipeParams {
                iterations,
                thermal_interval,
                thermal_rate: 0.0,
                ..Default::default()
            };
            assert!(erode_pipe(&input, None, None, None, 2, 2, 1.0, &params, 0).is_err());
        }
    }
}
