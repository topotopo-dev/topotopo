use polyforge_kernels::sdf::{
    Grid, grid_blur, grid_csg, grid_dilate, grid_erode, grid_offset, grid_resample, sdf_from_mesh,
};

fn cube() -> (Vec<f64>, Vec<u32>) {
    let p = vec![
        -1., -1., -1., 1., -1., -1., 1., 1., -1., -1., 1., -1., -1., -1., 1., 1., -1., 1., 1., 1.,
        1., -1., 1., 1.,
    ];
    let t = vec![
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3,
        1, 2, 6, 1, 6, 5,
    ];
    (p, t)
}

fn analytic(
    dims: [u32; 3],
    origin: [f64; 3],
    voxel: f64,
    f: impl Fn(f64, f64, f64) -> f64,
) -> Grid {
    let mut values = Vec::new();
    for z in 0..dims[2] {
        for y in 0..dims[1] {
            for x in 0..dims[0] {
                values.push(f(
                    origin[0] + x as f64 * voxel,
                    origin[1] + y as f64 * voxel,
                    origin[2] + z as f64 * voxel,
                ) as f32);
            }
        }
    }
    Grid {
        dims,
        origin,
        voxel,
        values,
    }
}

#[test]
fn mesh_narrow_band_exact_sign_and_background() {
    let (p, t) = cube();
    let grid = sdf_from_mesh(&p, &t, 0.25, 2., 4., false).unwrap();
    grid.validate().unwrap();
    assert_eq!(grid.dims, [17; 3]);
    assert_eq!(grid.origin, [-2.; 3]);
    assert_eq!(grid.sample(0., 0., 0.), f64::NEG_INFINITY);
    assert_eq!(grid.sample(2., 2., 2.), f64::INFINITY);
    assert!((grid.sample(1.25, 0., 0.) - 0.25).abs() < 1e-7);
    assert!((grid.sample(0.75, 0., 0.) + 0.25).abs() < 1e-7);
    assert!((grid.sample(1.25, 1.25, 0.) - libm::sqrt(0.125)).abs() < 1e-7);
    let replay = sdf_from_mesh(&p, &t, 0.25, 2., 4., false).unwrap();
    assert_eq!(grid, replay);
}

#[test]
fn winding_accepts_reverse_orientation_and_open_box() {
    let (p, mut t) = cube();
    let original = sdf_from_mesh(&p, &t, 0.25, 2., 2., false).unwrap();
    for face in t.chunks_exact_mut(3) {
        face.swap(1, 2);
    }
    let reversed = sdf_from_mesh(&p, &t, 0.25, 2., 2., false).unwrap();
    assert_eq!(original.values, reversed.values);
    t.drain(0..6); // remove the entire rear face, leave an open box
    let open = sdf_from_mesh(&p, &t, 0.25, 2., 2., false).unwrap();
    assert!(open.sample(0., 0., 0.) < 0.);
    assert!(open.sample(1.5, 0., 0.) > 0.);
    assert!(open.values.iter().all(|x| !x.is_nan()));
}

#[test]
fn winding_nonzero_rule_for_overlapping_meshes() {
    let (mut p, mut t) = cube();
    let p2: Vec<_> = p
        .chunks_exact(3)
        .flat_map(|v| [v[0] + 0.5, v[1], v[2]])
        .collect();
    let t2: Vec<_> = t.iter().map(|&v| v + 8).collect();
    p.extend(p2);
    t.extend(t2);
    let grid = sdf_from_mesh(&p, &t, 0.25, 2., 2., false).unwrap();
    assert!(grid.sample(0.25, 0., 0.) < 0.);
    assert!(grid.sample(-0.75, 0., 0.) < 0.);
    assert!(grid.sample(1.25, 0., 0.) < 0.);
    assert!(grid.sample(1.75, 0., 0.) > 0.);
}

#[test]
fn filled_distances_keep_band_and_approximate_background() {
    let (p, t) = cube();
    let band = sdf_from_mesh(&p, &t, 0.2, 2., 4., false).unwrap();
    let filled = sdf_from_mesh(&p, &t, 0.2, 2., 4., true).unwrap();
    assert!(filled.values.iter().all(|v| v.is_finite()));
    for (a, b) in band.values.iter().zip(&filled.values) {
        if a.is_finite() {
            assert_eq!(a, b);
        }
        assert_eq!(a.is_sign_negative(), b.is_sign_negative());
    }
    assert!((filled.sample(0., 0., 0.) + 1.).abs() < 0.15);
    assert!((filled.sample(1.8, 1.8, 1.8) - libm::sqrt(3.) * 0.8).abs() < 0.25);
}

#[test]
fn trilinear_exact_linear_field_and_infinite_policy() {
    let mut g = analytic([3; 3], [-1.; 3], 1., |x, y, z| 2. * x + 3. * y - z);
    assert!((g.sample(0.2, -0.3, 0.1) + 0.6).abs() < 1e-12);
    assert_eq!(g.sample(1., 1., 1.), 4.);
    assert_eq!(g.sample(1.001, 0., 0.), f64::INFINITY);
    g.values.fill(f32::INFINITY);
    assert_eq!(g.sample(0.2, 0.3, 0.1), f64::INFINITY);
    g.values[13] = 0.;
    assert_eq!(g.sample(0., 0., 0.), 0.);
    assert!(g.sample(0.2, 0.3, 0.1).is_finite());
    g.values[14] = f32::NEG_INFINITY;
    assert!(g.sample(0.5, 0., 0.).is_finite());
    g.values[13] = -0.;
    assert!(g.sample(0., 0., 0.).is_sign_negative());
}

#[test]
fn all_csg_operations_and_resampled_layouts() {
    let a = analytic([5; 3], [-1.; 3], 0.5, |x, _, _| x);
    let b = analytic([3; 3], [-1.; 3], 1., |_, y, _| y);
    for (op, expected) in [("union", -0.5), ("intersect", 0.5), ("subtract", -0.5)] {
        assert_eq!(
            grid_csg(&a, &b, op, 0.).unwrap().sample(-0.5, 0.5, 0.),
            expected
        );
    }
    assert_eq!(
        grid_csg(&a, &b, "smooth_union", 1.)
            .unwrap()
            .sample(0., 0., 0.),
        -0.25
    );
    assert_eq!(
        grid_csg(&a, &b, "smooth_intersect", 1.)
            .unwrap()
            .sample(0., 0., 0.),
        0.25
    );
    assert_eq!(
        grid_csg(&a, &b, "smooth_subtract", 1.)
            .unwrap()
            .sample(0., 0., 0.),
        0.25
    );
    let resampled = grid_resample(&a, 0.25).unwrap();
    assert_eq!(resampled.dims, [9; 3]);
    assert_eq!(resampled.sample(0.25, 0.25, 0.25), 0.25);
    assert_eq!(grid_resample(&a, a.voxel).unwrap(), a);
    let mut empty = b.clone();
    empty.values.fill(f32::INFINITY);
    for op in [
        "union",
        "intersect",
        "subtract",
        "smooth_union",
        "smooth_intersect",
        "smooth_subtract",
    ] {
        assert!(
            grid_csg(&a, &empty, op, 0.5)
                .unwrap()
                .values
                .iter()
                .all(|v| !v.is_nan())
        );
    }
}

#[test]
fn blur_morphology_and_property_replay() {
    let linear = analytic([9; 3], [-1.; 3], 0.25, |x, _, _| x);
    assert_eq!(
        grid_offset(&linear, 0.25).unwrap().sample(0., 0., 0.),
        -0.25
    );
    assert_eq!(
        grid_dilate(&linear, 0.25).unwrap(),
        grid_offset(&linear, 0.25).unwrap()
    );
    assert_eq!(grid_erode(&linear, 0.25).unwrap().sample(0., 0., 0.), 0.25);
    assert!(grid_blur(&linear, 2).unwrap().sample(0., 0., 0.).abs() < 1e-7);
    let mut background = linear.clone();
    background.values.fill(f32::NEG_INFINITY);
    assert_eq!(grid_blur(&background, 2).unwrap(), background);
    let (p, t) = cube();
    assert!(
        grid_blur(&sdf_from_mesh(&p, &t, 0.25, 2., 2., false).unwrap(), 1)
            .unwrap()
            .values
            .iter()
            .all(|v| v.is_finite())
    );
    let mut state = 0x51df_u32;
    for _ in 0..32 {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        let d = (state as f64 / u32::MAX as f64 - 0.5) * 0.5;
        let offset = grid_offset(&linear, d).unwrap();
        let replay = grid_offset(&linear, d).unwrap();
        assert_eq!(offset, replay);
        let union = grid_csg(&linear, &offset, "union", 0.).unwrap();
        let intersect = grid_csg(&linear, &offset, "intersect", 0.).unwrap();
        for i in 0..linear.values.len() {
            assert!(union.values[i] <= linear.values[i]);
            assert!(intersect.values[i] >= linear.values[i]);
        }
    }
}

#[test]
fn invalid_inputs_return_errors() {
    let (p, t) = cube();
    for voxel in [0., -1., f64::NAN, f64::INFINITY, 1e-15] {
        assert!(sdf_from_mesh(&p, &t, voxel, 2., 0., false).is_err());
    }
    assert!(sdf_from_mesh(&p, &[999, 0, 1], 0.2, 2., 0., false).is_err());
    assert!(sdf_from_mesh(&[], &t, 0.2, 2., 0., false).is_err());
    assert!(sdf_from_mesh(&p, &t, 0.2, 0., 0., false).is_err());
    let grid = analytic([3; 3], [0.; 3], 1., |x, _, _| x);
    assert!(grid_offset(&grid, f64::NAN).is_err());
    assert!(grid_dilate(&grid, -1.).is_err());
    assert!(grid_erode(&grid, -1.).is_err());
    assert!(grid_blur(&grid, 1025).is_err());
    assert!(grid_resample(&grid, 0.).is_err());
    assert!(grid_csg(&grid, &grid, "invalid", 0.).is_err());
    assert!(grid_csg(&grid, &grid, "union", f64::NAN).is_err());
    assert!(grid_csg(&grid, &grid, "smooth_union", 1e308).is_err());
    let mut extreme = grid.clone();
    extreme.values.fill(f32::MAX);
    assert!(grid_offset(&extreme, -(f32::MAX as f64) / 32.).is_err());
    let mut collapsed = grid.clone();
    collapsed.origin[0] = 1e308;
    assert!(
        collapsed
            .validate()
            .unwrap_err()
            .contains("spacing is not representable")
    );
    collapsed.origin = [1. - f64::EPSILON / 2., 0., 0.];
    collapsed.voxel = f64::EPSILON / 2.;
    assert!(
        collapsed
            .validate()
            .unwrap_err()
            .contains("spacing is not representable")
    );
    let mut invalid = grid.clone();
    invalid.values[0] = f32::NAN;
    assert!(invalid.validate().is_err());
    invalid.dims = [0; 3];
    assert_eq!(invalid.sample(0., 0., 0.), f64::INFINITY);
}

#[test]
fn exact_lattice_endpoints_do_not_leak_positive_infinity() {
    let grid = analytic([15; 3], [-1.; 3], 0.15, |x, y, z| x + y + z);
    for z in 0..15 {
        for y in 0..15 {
            for x in 0..15 {
                let value = grid.sample(
                    -1. + x as f64 * 0.15,
                    -1. + y as f64 * 0.15,
                    -1. + z as f64 * 0.15,
                );
                assert!(value.is_finite());
            }
        }
    }
}

#[test]
fn closed_scanline_properties_rotated_boxes_and_duplicate_seams() {
    let (original, indices) = cube();
    let mut state = 0xabc123_u32;
    for _ in 0..16 {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        let angle = (state as f64 / u32::MAX as f64) * std::f64::consts::TAU;
        let (s, c) = (libm::sin(angle), libm::cos(angle));
        let positions: Vec<_> = original
            .chunks_exact(3)
            .flat_map(|v| {
                [
                    c * v[0] - s * v[1] + 0.071,
                    s * v[0] + c * v[1] - 0.093,
                    v[2] + 0.131,
                ]
            })
            .collect();
        let grid = sdf_from_mesh(&positions, &indices, 0.23, 2., 3., false).unwrap();
        for z in 0..grid.dims[2] {
            for y in 0..grid.dims[1] {
                for x in 0..grid.dims[0] {
                    let px = grid.origin[0] + x as f64 * grid.voxel - 0.071;
                    let py = grid.origin[1] + y as f64 * grid.voxel + 0.093;
                    let pz = grid.origin[2] + z as f64 * grid.voxel - 0.131;
                    let q = [
                        (c * px + s * py).abs() - 1.,
                        (-s * px + c * py).abs() - 1.,
                        pz.abs() - 1.,
                    ];
                    let expected = libm::sqrt(
                        q[0].max(0.).powi(2) + q[1].max(0.).powi(2) + q[2].max(0.).powi(2),
                    ) + q[0].max(q[1]).max(q[2]).min(0.);
                    let index = (x + grid.dims[0] * (y + grid.dims[1] * z)) as usize;
                    if expected.abs() > 1e-8 {
                        assert_eq!(grid.values[index] < 0., expected < 0.);
                    }
                    if expected.abs() < grid.voxel * 2. - 1e-8 {
                        assert!((grid.values[index] as f64 - expected).abs() < 1e-6);
                    } else if expected.abs() > grid.voxel * 2. + 1e-8 {
                        assert!(grid.values[index].is_infinite());
                    }
                }
            }
        }
    }
    let seam_positions: Vec<_> = indices
        .iter()
        .flat_map(|&i| original[3 * i as usize..3 * i as usize + 3].iter().copied())
        .collect();
    let seam_indices: Vec<_> = (0..indices.len() as u32).collect();
    assert_eq!(
        sdf_from_mesh(&original, &indices, 0.25, 2., 3., false).unwrap(),
        sdf_from_mesh(&seam_positions, &seam_indices, 0.25, 2., 3., false).unwrap()
    );
}
