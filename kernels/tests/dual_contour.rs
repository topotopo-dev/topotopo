use std::collections::{BTreeMap, BTreeSet};
use topotopo_kernels::dual_contour::{DualMesh, dual_contour, dual_contour_with_options};
use topotopo_kernels::sdf::Grid;

fn field(n: u32, voxel: f64, origin: [f64; 3], sample: impl Fn(f64, f64, f64) -> f64) -> Grid {
    let mut values = Vec::new();
    for z in 0..n {
        for y in 0..n {
            for x in 0..n {
                values.push(sample(
                    origin[0] + f64::from(x) * voxel,
                    origin[1] + f64::from(y) * voxel,
                    origin[2] + f64::from(z) * voxel,
                ) as f32);
            }
        }
    }
    Grid {
        dims: [n; 3],
        origin,
        voxel,
        values,
    }
}
fn sphere(x: f64, y: f64, z: f64) -> f64 {
    libm::sqrt(x * x + y * y + z * z) - 1.
}
fn contour(grid: &Grid) -> DualMesh {
    dual_contour(grid, 0., 1e-6, true, true).unwrap()
}
fn point(mesh: &DualMesh, i: u32) -> [f64; 3] {
    std::array::from_fn(|axis| mesh.positions[i as usize * 3 + axis])
}
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| a[i] - b[i])
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn triangles(mesh: &DualMesh) -> Vec<[u32; 3]> {
    let mut result = Vec::new();
    for bounds in mesh.prim_start.windows(2) {
        let poly = &mesh.vertex_point[bounds[0] as usize..bounds[1] as usize];
        for i in 1..poly.len() - 1 {
            result.push([poly[0], poly[i], poly[i + 1]]);
        }
    }
    result
}
fn area(mesh: &DualMesh) -> f64 {
    triangles(mesh)
        .into_iter()
        .map(|[a, b, c]| {
            let normal = cross(
                sub(point(mesh, b), point(mesh, a)),
                sub(point(mesh, c), point(mesh, a)),
            );
            libm::sqrt(dot(normal, normal)) * 0.5
        })
        .sum()
}
fn signed_volume(mesh: &DualMesh) -> f64 {
    triangles(mesh)
        .into_iter()
        .map(|[a, b, c]| dot(point(mesh, a), cross(point(mesh, b), point(mesh, c))) / 6.)
        .sum()
}

/// Check all edge incidence, winding, and a connected circular link at every
/// vertex. Edge incidence alone would miss two closed sheets pinched at a point.
fn manifold(mesh: &DualMesh) -> i64 {
    let mut edges = BTreeMap::<(u32, u32), Vec<bool>>::new();
    let mut links = vec![Vec::<(u32, u32)>::new(); mesh.positions.len() / 3];
    for bounds in mesh.prim_start.windows(2) {
        let polygon = &mesh.vertex_point[bounds[0] as usize..bounds[1] as usize];
        assert_eq!(polygon.iter().collect::<BTreeSet<_>>().len(), polygon.len());
        for i in 0..polygon.len() {
            let a = polygon[i];
            let b = polygon[(i + 1) % polygon.len()];
            edges.entry((a.min(b), a.max(b))).or_default().push(a < b);
            links[a as usize].push((polygon[(i + polygon.len() - 1) % polygon.len()], b));
        }
    }
    for (edge, incidence) in &edges {
        assert_eq!(incidence.len(), 2, "edge {edge:?} has {incidence:?}");
        assert_ne!(
            incidence[0], incidence[1],
            "inconsistent winding at {edge:?}"
        );
    }
    for (vertex, link) in links.iter().enumerate() {
        assert!(!link.is_empty(), "unused vertex {vertex}");
        let mut neighbors = BTreeMap::<u32, Vec<u32>>::new();
        for (a, b) in link {
            neighbors.entry(*a).or_default().push(*b);
            neighbors.entry(*b).or_default().push(*a);
        }
        assert!(
            neighbors.values().all(|n| n.len() == 2),
            "non circular link at {vertex}"
        );
        let mut seen = BTreeSet::new();
        let mut queue = vec![*neighbors.keys().next().unwrap()];
        while let Some(v) = queue.pop() {
            if seen.insert(v) {
                queue.extend_from_slice(&neighbors[&v]);
            }
        }
        assert_eq!(seen.len(), neighbors.len(), "pinched vertex {vertex}");
    }
    mesh.positions.len() as i64 / 3 - edges.len() as i64 + mesh.prim_start.len() as i64 - 1
}

fn segment_triangle(a: [f64; 3], b: [f64; 3], t: [[f64; 3]; 3]) -> bool {
    let direction = sub(b, a);
    let ab = sub(t[1], t[0]);
    let ac = sub(t[2], t[0]);
    let p = cross(direction, ac);
    let determinant = dot(ab, p);
    if determinant.abs() < 1e-13 {
        return false;
    }
    let inv = 1. / determinant;
    let offset = sub(a, t[0]);
    let u = dot(offset, p) * inv;
    if u <= 1e-9 || u >= 1. - 1e-9 {
        return false;
    }
    let q = cross(offset, ab);
    let v = dot(direction, q) * inv;
    if v <= 1e-9 || u + v >= 1. - 1e-9 {
        return false;
    }
    let distance = dot(ac, q) * inv;
    distance > 1e-9 && distance < 1. - 1e-9
}
/// Conservative broadphase followed by strict segment/triangle intersections.
/// Shared-vertex neighbors and coplanar contacts are intentionally excluded.
fn no_proper_intersections(mesh: &DualMesh) {
    let triangles = triangles(mesh);
    let points: Vec<_> = triangles
        .iter()
        .map(|t| t.map(|i| point(mesh, i)))
        .collect();
    let boxes: Vec<([f64; 3], [f64; 3])> = points
        .iter()
        .map(|p| {
            (
                std::array::from_fn(|i| p[0][i].min(p[1][i]).min(p[2][i])),
                std::array::from_fn(|i| p[0][i].max(p[1][i]).max(p[2][i])),
            )
        })
        .collect();
    let mut sorted: Vec<_> = (0..triangles.len()).collect();
    sorted.sort_by(|a, b| boxes[*a].0[0].total_cmp(&boxes[*b].0[0]).then(a.cmp(b)));
    for (j, &a) in sorted.iter().enumerate() {
        for &b in &sorted[j + 1..] {
            if boxes[b].0[0] > boxes[a].1[0] {
                break;
            }
            if (1..3).any(|i| boxes[a].0[i] > boxes[b].1[i] || boxes[b].0[i] > boxes[a].1[i]) {
                continue;
            }
            if triangles[a].iter().any(|i| triangles[b].contains(i)) {
                continue;
            }
            for i in 0..3 {
                assert!(
                    !segment_triangle(points[a][i], points[a][(i + 1) % 3], points[b]),
                    "triangles {a}, {b} intersect: {:?} {:?} positions {:?} {:?} cells {:?} {:?}",
                    triangles[a],
                    triangles[b],
                    points[a],
                    points[b],
                    triangles[a].map(|v| mesh.cell_index[v as usize]),
                    triangles[b].map(|v| mesh.cell_index[v as usize])
                );
                assert!(
                    !segment_triangle(points[b][i], points[b][(i + 1) % 3], points[a]),
                    "triangles {a}, {b} intersect: {:?} {:?} positions {:?} {:?} cells {:?} {:?}",
                    triangles[a],
                    triangles[b],
                    points[a],
                    points[b],
                    triangles[a].map(|v| mesh.cell_index[v as usize]),
                    triangles[b].map(|v| mesh.cell_index[v as usize])
                );
            }
        }
    }
}

#[test]
fn sphere_area_within_one_percent_and_outward_winding() {
    let grid = field(33, 0.075, [-1.2; 3], sphere);
    let mesh = contour(&grid);
    let legacy = dual_contour_with_options(&grid, 0., 1e-6, true, true, true, 0., 0.5).unwrap();
    let digest = legacy
        .positions
        .iter()
        .flat_map(|v| v.to_bits().to_le_bytes())
        .chain(legacy.vertex_point.iter().flat_map(|v| v.to_le_bytes()))
        .fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
        });
    // Captured before the lookup-only edge map changed from BTreeMap to a
    // deterministic integer-hash table: traversal and every output bit match.
    assert_eq!(digest, 0x34f4c39a94811bd5);
    let analytic = 4. * std::f64::consts::PI;
    let error = (area(&mesh) / analytic - 1.).abs();
    println!("sphere surface area relative error: {:.6}%", error * 100.);
    assert!(error < 0.01, "sphere area relative error: {error}");
    assert_eq!(manifold(&mesh), 2);
    assert!(signed_volume(&mesh) > 4.);
    assert_eq!(mesh.cell_index.len() * 3, mesh.positions.len());
    no_proper_intersections(&mesh);
}

#[test]
fn box_corners_and_edges_are_within_a_tenth_voxel_and_straight() {
    let center = [0.023, -0.031, 0.017];
    let half = [0.67, 0.53, 0.59];
    let voxel = 0.08;
    let grid = field(27, voxel, [-1.04; 3], |x, y, z| {
        let q = std::array::from_fn::<_, 3, _>(|i| ([x, y, z][i] - center[i]).abs() - half[i]);
        libm::sqrt(q.iter().map(|v| v.max(0.).powi(2)).sum::<f64>())
            + q[0].max(q[1]).max(q[2]).min(0.)
    });
    let mesh = contour(&grid);
    assert_eq!(manifold(&mesh), 2);
    let mut max_corner_error: f64 = 0.;
    for corner in 0..8 {
        let p: [f64; 3] = std::array::from_fn(|i| {
            center[i]
                + if corner & (1 << i) == 0 {
                    -half[i]
                } else {
                    half[i]
                }
        });
        let distance = mesh
            .positions
            .chunks_exact(3)
            .map(|v| libm::sqrt((0..3).map(|i| (v[i] - p[i]).powi(2)).sum()))
            .fold(f64::INFINITY, f64::min);
        assert!(
            distance <= voxel * 0.1,
            "box corner {corner} error {distance}, tenth voxel {}",
            voxel * 0.1
        );
        max_corner_error = max_corner_error.max(distance);
    }
    assert_eq!(mesh.fallback_cells, 0);
    assert!(
        mesh.prim_start
            .windows(2)
            .all(|bounds| bounds[1] - bounds[0] == 4)
    );
    assert_eq!(
        mesh.cell_index.iter().collect::<BTreeSet<_>>().len(),
        mesh.cell_index.len()
    );
    let mut straightness: f64 = 0.;
    for axis in 0..3 {
        let u = (axis + 1) % 3;
        let v = (axis + 2) % 3;
        for a in [-1., 1.] {
            for b in [-1., 1.] {
                let target = [center[u] + a * half[u], center[v] + b * half[v]];
                let points: Vec<_> = mesh
                    .positions
                    .chunks_exact(3)
                    .filter(|p| {
                        (p[u] - target[0]).abs() < voxel * 0.1
                            && (p[v] - target[1]).abs() < voxel * 0.1
                            && (p[axis] - center[axis]).abs() < half[axis] - voxel
                    })
                    .collect();
                assert!(points.len() > 4);
                let mean = [
                    points.iter().map(|p| p[u]).sum::<f64>() / points.len() as f64,
                    points.iter().map(|p| p[v]).sum::<f64>() / points.len() as f64,
                ];
                for p in points {
                    straightness = straightness.max(libm::sqrt(
                        (p[u] - mean[0]).powi(2) + (p[v] - mean[1]).powi(2),
                    ));
                }
            }
        }
    }
    assert!(straightness < 0.05 * voxel);
    println!(
        "box maximum edge straightness deviation: {:.9} voxels",
        straightness / voxel
    );
    println!(
        "box maximum corner error: {max_corner_error:.9} (tenth voxel {})",
        voxel * 0.1
    );
    for axis in 0..3 {
        for a in [-1., 1.] {
            for b in [-1., 1.] {
                for t in [-0.7, 0., 0.7] {
                    let mut p = center;
                    p[axis] += t * half[axis];
                    p[(axis + 1) % 3] += a * half[(axis + 1) % 3];
                    p[(axis + 2) % 3] += b * half[(axis + 2) % 3];
                    let distance = mesh
                        .positions
                        .chunks_exact(3)
                        .filter(|v| (v[axis] - p[axis]).abs() <= voxel)
                        .map(|v| {
                            libm::sqrt(
                                (v[(axis + 1) % 3] - p[(axis + 1) % 3]).powi(2)
                                    + (v[(axis + 2) % 3] - p[(axis + 2) % 3]).powi(2),
                            )
                        })
                        .fold(f64::INFINITY, f64::min);
                    assert!(distance <= voxel * 0.1, "box edge error {distance}");
                }
            }
        }
    }
    no_proper_intersections(&mesh);
}

#[test]
fn torus_has_genus_one() {
    let grid = field(41, 0.06, [-1.2; 3], |x, y, z| {
        let ring = libm::sqrt(x * x + z * z) - 0.73;
        libm::sqrt(ring * ring + y * y) - 0.27
    });
    let mesh = contour(&grid);
    let max_error = mesh
        .positions
        .chunks_exact(3)
        .map(|p| {
            let ring = libm::sqrt(p[0] * p[0] + p[2] * p[2]) - 0.73;
            (libm::sqrt(ring * ring + p[1] * p[1]) - 0.27).abs() / grid.voxel
        })
        .fold(0., f64::max);
    assert!(max_error <= 0.1, "torus residual {max_error} voxels");
    println!("torus max analytic distance residual={max_error:.9} voxels");
    println!(
        "torus vertices={}, faces={}, fallback_cells={}",
        mesh.positions.len() / 3,
        mesh.prim_start.len() - 1,
        mesh.fallback_cells
    );
    assert_eq!(manifold(&mesh), 0);
    assert!(signed_volume(&mesh) > 0.);
    no_proper_intersections(&mesh);
}

#[test]
fn seeded_random_unions_are_manifold_deterministic_and_do_not_cross() {
    let mut state = 0x5df_cafe_78b3_u64;
    let mut rand = || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 32) as f64 / f64::from(u32::MAX)
    };
    for case in 0..16 {
        let balls: Vec<_> = (0..5)
            .map(|_| {
                (
                    [rand() * 1.2 - 0.6, rand() * 1.2 - 0.6, rand() * 1.2 - 0.6],
                    0.25 + rand() * 0.3,
                )
            })
            .collect();
        let grid = field(29, 0.1, [-1.4; 3], |x, y, z| {
            balls
                .iter()
                .map(|(c, r)| {
                    libm::sqrt((x - c[0]).powi(2) + (y - c[1]).powi(2) + (z - c[2]).powi(2)) - r
                })
                .fold(f64::INFINITY, f64::min)
        });
        let mesh = dual_contour(&grid, 0., 1e-6, true, true)
            .unwrap_or_else(|e| panic!("case {case}: {e}"));
        let max_error = mesh
            .positions
            .chunks_exact(3)
            .map(|p| {
                balls
                    .iter()
                    .map(|(c, r)| {
                        libm::sqrt((0..3).map(|a| (p[a] - c[a]).powi(2)).sum::<f64>()) - r
                    })
                    .fold(f64::INFINITY, f64::min)
                    .abs()
                    / grid.voxel
            })
            .fold(0., f64::max);
        println!("union {case}: max analytic distance residual={max_error:.9} voxels");
        println!(
            "union {case}: vertices={}, faces={}, fallback_cells={}",
            mesh.positions.len() / 3,
            mesh.prim_start.len() - 1,
            mesh.fallback_cells
        );
        manifold(&mesh);
        no_proper_intersections(&mesh);
        let again = contour(&grid);
        assert_eq!(mesh.positions, again.positions);
        assert_eq!(mesh.vertex_point, again.vertex_point);
        assert_eq!(mesh.cell_index, again.cell_index);
    }
}

#[test]
fn validation_empty_and_infinite_band_samples() {
    let mut grid = field(17, 0.2, [-1.6; 3], sphere);
    for v in &mut grid.values {
        if v.abs() > 0.5 {
            *v = if *v < 0. {
                f32::NEG_INFINITY
            } else {
                f32::INFINITY
            };
        }
    }
    let mesh = contour(&grid);
    assert_eq!(manifold(&mesh), 2);
    assert!(dual_contour(&grid, f64::NAN, 1e-6, true, true).is_err());
    assert!(dual_contour(&grid, 0., 0., true, true).is_err());
    assert!(dual_contour(&grid, 0., f64::NAN, true, true).is_err());
    let smooth = dual_contour(&grid, 0., 1e-6, false, true).unwrap();
    assert_eq!(manifold(&smooth), 2);
    assert_ne!(smooth.positions, mesh.positions);
    grid.values.fill(1.);
    let empty = contour(&grid);
    assert!(empty.positions.is_empty());
    assert_eq!(empty.prim_start, vec![0]);
    grid.values[0] = -1.;
    assert!(
        dual_contour(&grid, 0., 1e-6, true, true)
            .unwrap_err()
            .contains("boundary")
    );
    grid.values.pop();
    assert!(dual_contour(&grid, 0., 1e-6, true, true).is_err());
}

#[test]
fn grid_aligned_zero_faces_and_internal_negative_zero_do_not_degenerate() {
    let box_sample = |x: f64, y: f64, z: f64| {
        let q = [x.abs() - 0.5, y.abs() - 0.5, z.abs() - 0.5]
            .map(|v| if v.abs() < 1e-12 { 0. } else { v });
        libm::sqrt(q.iter().map(|v| v.max(0.).powi(2)).sum::<f64>())
            + q[0].max(q[1]).max(q[2]).min(0.)
    };
    let mut grid = field(19, 0.1, [-0.9; 3], box_sample);
    let mesh = contour(&grid);
    assert_eq!(manifold(&mesh), 2);
    no_proper_intersections(&mesh);
    for t in triangles(&mesh) {
        let [a, b, c] = t.map(|v| point(&mesh, v));
        let normal = cross(sub(b, a), sub(c, a));
        assert!(
            dot(normal, normal) > 0.,
            "degenerate aligned-box triangle {t:?}"
        );
    }
    // Simulate an exactly sampled internal source-mesh face. Winding stores
    // its zero distance with the negative sign; it must not open an inner sheet.
    for z in 5..14 {
        for y in 5..14 {
            grid.values[9 + 19 * (y + 19 * z)] = -0.;
        }
    }
    let inside = contour(&grid);
    assert_eq!(manifold(&inside), 2);
    assert_eq!(inside.vertex_point, mesh.vertex_point);
    no_proper_intersections(&inside);
    // The option is accepted when the unconstrained fits stay in their cells;
    // unsafe fits return a specific error rather than silently getting clamped.
    match dual_contour(&grid, 0., 1e-6, true, false) {
        Ok(unclamped) => {
            assert_eq!(manifold(&unclamped), 2);
            no_proper_intersections(&unclamped);
        }
        Err(message) => assert!(
            message.contains("unconstrained QEF leaves its source cell"),
            "{message}"
        ),
    }
}

#[test]
fn extraction_controls_preserve_manifold_and_unsupported_octree_retains_uniform() {
    let grid = field(17, 0.15, [-1.2; 3], sphere);
    let uniform = dual_contour_with_options(&grid, 0., 1e-6, true, true, false, 0., 0.5).unwrap();
    let adaptive = dual_contour_with_options(&grid, 0., 1e-6, true, true, false, 0.1, 0.5).unwrap();
    assert_eq!(adaptive.positions, uniform.positions);
    assert_eq!(adaptive.prim_start, uniform.prim_start);
    assert_eq!(adaptive.vertex_point, uniform.vertex_point);
    assert_eq!(adaptive.adaptive_collapses, 0);
    assert_eq!(manifold(&adaptive), 2);
    let sensitive = dual_contour_with_options(&grid, 0., 1e-6, true, true, false, 0., 0.).unwrap();
    let relaxed = dual_contour_with_options(&grid, 0., 1e-6, true, true, false, 0., 1.).unwrap();
    assert_ne!(sensitive.positions, relaxed.positions);
    assert!(sensitive.fallback_cells > relaxed.fallback_cells);
    assert_eq!(manifold(&sensitive), 2);
    assert_eq!(manifold(&relaxed), 2);
    no_proper_intersections(&sensitive);
    no_proper_intersections(&relaxed);
    for tolerance in [-0.1, f64::NAN, f64::INFINITY] {
        assert!(
            dual_contour_with_options(&grid, 0., 1e-6, true, true, false, tolerance, 0.5).is_err()
        );
    }
    for threshold in [-0.1, 1.1, f64::NAN, f64::INFINITY] {
        assert!(
            dual_contour_with_options(&grid, 0., 1e-6, true, true, false, 0., threshold).is_err()
        );
    }
}

#[test]
fn axial_affine_reconstruction_respects_scaled_implicit_values() {
    let make = |scale: f64| {
        field(27, 0.08, [-1.04; 3], |x, y, z| {
            let center = [0.023, -0.031, 0.017];
            let half = [0.67, 0.53, 0.59];
            let q = std::array::from_fn::<_, 3, _>(|i| ([x, y, z][i] - center[i]).abs() - half[i]);
            scale
                * (libm::sqrt(q.iter().map(|v| v.max(0.).powi(2)).sum::<f64>())
                    + q[0].max(q[1]).max(q[2]).min(0.))
        })
    };
    let expected = contour(&make(1.));
    for scale in [0.2, 2.] {
        let actual = contour(&make(scale));
        assert_eq!(actual.vertex_point, expected.vertex_point);
        assert_eq!(actual.prim_start, expected.prim_start);
        assert_eq!(actual.fallback_cells, 0);
        let max_error = actual
            .positions
            .iter()
            .zip(&expected.positions)
            .map(|(a, b)| (a - b).abs())
            .fold(0., f64::max);
        assert!(max_error < 0.08 * 1e-5, "scale {scale}: {max_error}");
        assert_eq!(manifold(&actual), 2);
    }
}
