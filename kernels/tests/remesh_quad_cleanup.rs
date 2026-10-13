use std::collections::BTreeMap;
use topotopo_kernels::remesh_quad::{QuadMesh, RemeshOptions, remesh_quad};

fn capped_tube(columns: usize, rows: usize) -> (Vec<f64>, Vec<u32>) {
    let mut p = Vec::new();
    for row in 0..=rows {
        for col in 0..columns {
            let angle = col as f64 * std::f64::consts::TAU / columns as f64;
            p.extend([
                0.65 * libm::cos(angle),
                1.6 * row as f64 / rows as f64 - 0.8,
                0.65 * libm::sin(angle),
            ]);
        }
    }
    let bottom = p.len() / 3;
    p.extend([0.0, -0.8, 0.0]);
    let top = p.len() / 3;
    p.extend([0.0, 0.8, 0.0]);
    let mut t = Vec::new();
    for row in 0..rows {
        for col in 0..columns {
            let a = row * columns + col;
            let b = row * columns + (col + 1) % columns;
            let d = a + columns;
            let c = b + columns;
            t.extend([a as u32, d as u32, b as u32, d as u32, c as u32, b as u32]);
        }
    }
    for col in 0..columns {
        let next = (col + 1) % columns;
        t.extend([bottom as u32, col as u32, next as u32]);
        t.extend([
            top as u32,
            (rows * columns + next) as u32,
            (rows * columns + col) as u32,
        ]);
    }
    (p, t)
}

fn closed_valences(mesh: &QuadMesh) -> Vec<usize> {
    let mut incidences = BTreeMap::<(u32, u32), (usize, i32)>::new();
    for offsets in mesh.prim_start.windows(2) {
        let polygon = &mesh.vertex_point[offsets[0] as usize..offsets[1] as usize];
        for k in 0..polygon.len() {
            let a = polygon[k];
            let b = polygon[(k + 1) % polygon.len()];
            let entry = incidences.entry((a.min(b), a.max(b))).or_default();
            entry.0 += 1;
            entry.1 += if a < b { 1 } else { -1 };
        }
    }
    let mut valence = vec![0; mesh.positions.len() / 3];
    for ((a, b), (count, direction)) in incidences {
        assert_eq!(count, 2, "closed surface edge has {count} incident faces");
        assert_eq!(direction, 0, "adjacent faces must have opposite winding");
        valence[a as usize] += 1;
        valence[b as usize] += 1;
    }
    valence
}

#[test]
fn quads_only_tube_count_and_cleanup_are_deterministic() {
    let (positions, triangles) = capped_tube(32, 8);
    let options = RemeshOptions {
        target_face_count: 350,
        quad_only: true,
        smooth_iterations: 10,
        ..RemeshOptions::default()
    };
    let mesh = remesh_quad(&positions, &triangles, &options).unwrap();
    let faces = mesh.prim_start.len() - 1;
    println!(
        "tube: {faces} quads, {} points, {} irregular vertices",
        mesh.positions.len() / 3,
        mesh.quality.singularities
    );
    assert!(
        (298..=402).contains(&faces),
        "350 requested tube faces must stay within 15%; got {faces}"
    );
    assert!(mesh.prim_start.windows(2).all(|w| w[1] - w[0] == 4));
    assert!(
        closed_valences(&mesh).into_iter().all(|degree| degree >= 3),
        "cleanup must remove interior degree-two doublets"
    );
    let repeated = remesh_quad(&positions, &triangles, &options).unwrap();
    assert_eq!(mesh.positions, repeated.positions);
    assert_eq!(mesh.prim_start, repeated.prim_start);
    assert_eq!(mesh.vertex_point, repeated.vertex_point);
    assert_eq!(mesh.source_triangle, repeated.source_triangle);
    assert_eq!(mesh.barycentric, repeated.barycentric);
    assert_eq!(mesh.src_prim, repeated.src_prim);
}

#[test]
fn cleanup_preserves_outward_orientation_on_planar_box_patches() {
    // Exact node box triangle/UV-seam ordering: the earlier cleanup transported
    // a triangle outside a concave two-face patch, reversing it on x = -0.5.
    let positions = vec![
        -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
        0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5,
    ];
    let triangles = vec![
        0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 4, 7, 0, 4, 0, 3, 2, 1, 6, 2, 6, 5, 2, 5, 4, 2, 4, 3,
        0, 7, 6, 0, 6, 1,
    ];
    let directions = vec![
        0, 1, 0, 3, 0, 7, 1, 2, 1, 6, 2, 3, 2, 5, 3, 4, 4, 5, 4, 7, 5, 6, 6, 7,
    ];
    let mesh = remesh_quad(
        &positions,
        &triangles,
        &RemeshOptions {
            target_edge_length: 0.2,
            direction_edges: directions,
            ..RemeshOptions::default()
        },
    )
    .unwrap();
    closed_valences(&mesh);
    for offsets in mesh.prim_start.windows(2) {
        let polygon = &mesh.vertex_point[offsets[0] as usize..offsets[1] as usize];
        let point = |v: u32| {
            let v = v as usize * 3;
            [
                mesh.positions[v],
                mesh.positions[v + 1],
                mesh.positions[v + 2],
            ]
        };
        let origin = point(polygon[0]);
        let mut normal = [0.; 3];
        for k in 1..polygon.len() - 1 {
            let b = point(polygon[k]);
            let c = point(polygon[k + 1]);
            let a: [f64; 3] = std::array::from_fn(|j| b[j] - origin[j]);
            let b: [f64; 3] = std::array::from_fn(|j| c[j] - origin[j]);
            normal[0] += a[1] * b[2] - a[2] * b[1];
            normal[1] += a[2] * b[0] - a[0] * b[2];
            normal[2] += a[0] * b[1] - a[1] * b[0];
        }
        let signed = (0..3).map(|j| normal[j] * origin[j]).sum::<f64>();
        assert!(
            signed > 1e-10,
            "cleanup reversed or overlapped a box polygon: {polygon:?}"
        );
    }
}

#[test]
fn cleanup_does_not_grow_long_boundary_fans_on_dense_grid() {
    // The 100k-triangle benchmark exposed interior diagonals spanning nine
    // fixed boundary samples: valence improved while max edge grew to 5.92h.
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
    let mesh = remesh_quad(
        &positions,
        &triangles,
        &RemeshOptions {
            target_face_count: 25_000,
            ..RemeshOptions::default()
        },
    )
    .unwrap();
    let h = mesh.quality.target_edge_length;
    assert!(
        mesh.quality.edge_length_max < h * 2.0,
        "cleanup created a long boundary fan: {}h",
        mesh.quality.edge_length_max / h
    );
    assert!(
        mesh.quality.edge_length_min > h * 0.25,
        "cleanup created a tiny sliver: {}h",
        mesh.quality.edge_length_min / h
    );
    let mut edges = std::collections::BTreeSet::new();
    for offsets in mesh.prim_start.windows(2) {
        let p = &mesh.vertex_point[offsets[0] as usize..offsets[1] as usize];
        for k in 0..p.len() {
            let (a, b) = (p[k], p[(k + 1) % p.len()]);
            edges.insert((a.min(b), a.max(b)));
        }
    }
    let within = edges
        .iter()
        .filter(|&&(a, b)| {
            let squared: f64 = (0..3)
                .map(|k| {
                    let d = mesh.positions[a as usize * 3 + k] - mesh.positions[b as usize * 3 + k];
                    d * d
                })
                .sum();
            (libm::sqrt(squared) - h).abs() <= h * 0.35
        })
        .count();
    assert!(
        within as f64 / edges.len() as f64 > 0.985,
        "cleanup reduced the regular grid edge-length fraction"
    );
}
