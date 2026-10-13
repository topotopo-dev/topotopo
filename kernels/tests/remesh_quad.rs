use std::collections::{BTreeMap, BTreeSet};
use topotopo_kernels::remesh_quad::{QuadMesh, RemeshOptions, remesh_quad};

type Point = [f64; 3];

fn sub(a: Point, b: Point) -> Point {
    std::array::from_fn(|k| a[k] - b[k])
}
fn cross(a: Point, b: Point) -> Point {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn length(a: Point) -> f64 {
    libm::sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
}
fn point(p: &[f64], i: u32) -> Point {
    let i = i as usize * 3;
    [p[i], p[i + 1], p[i + 2]]
}
fn pair(a: u32, b: u32) -> (u32, u32) {
    (a.min(b), a.max(b))
}
fn cube() -> (Vec<f64>, Vec<u32>) {
    (
        vec![
            -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5,
            0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
        ],
        vec![
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7,
            3, 1, 2, 6, 1, 6, 5,
        ],
    )
}
fn ico_sphere(level: usize) -> (Vec<f64>, Vec<u32>) {
    let t = (1.0 + libm::sqrt(5.0)) / 2.0;
    let mut points = vec![
        [-1.0, t, 0.0],
        [1.0, t, 0.0],
        [-1.0, -t, 0.0],
        [1.0, -t, 0.0],
        [0.0, -1.0, t],
        [0.0, 1.0, t],
        [0.0, -1.0, -t],
        [0.0, 1.0, -t],
        [t, 0.0, -1.0],
        [t, 0.0, 1.0],
        [-t, 0.0, -1.0],
        [-t, 0.0, 1.0],
    ];
    for p in &mut points {
        let l = length(*p);
        *p = p.map(|v| v / l);
    }
    let mut faces = vec![
        [0, 11, 5],
        [0, 5, 1],
        [0, 1, 7],
        [0, 7, 10],
        [0, 10, 11],
        [1, 5, 9],
        [5, 11, 4],
        [11, 10, 2],
        [10, 7, 6],
        [7, 1, 8],
        [3, 9, 4],
        [3, 4, 2],
        [3, 2, 6],
        [3, 6, 8],
        [3, 8, 9],
        [4, 9, 5],
        [2, 4, 11],
        [6, 2, 10],
        [8, 6, 7],
        [9, 8, 1],
    ];
    for _ in 0..level {
        let mut midpoints = BTreeMap::new();
        let mut next = Vec::with_capacity(faces.len() * 4);
        for [a, b, c] in faces {
            let mut midpoint = |x: u32, y: u32| {
                *midpoints.entry(pair(x, y)).or_insert_with(|| {
                    let p = std::array::from_fn(|k| points[x as usize][k] + points[y as usize][k]);
                    let l = length(p);
                    let index = points.len() as u32;
                    points.push(p.map(|v| v / l));
                    index
                })
            };
            let ab = midpoint(a, b);
            let bc = midpoint(b, c);
            let ca = midpoint(c, a);
            next.extend([[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]);
        }
        faces = next;
    }
    (
        points.into_iter().flatten().collect(),
        faces.into_iter().flatten().collect(),
    )
}

fn edges(mesh: &QuadMesh) -> BTreeMap<(u32, u32), Vec<(u32, u32)>> {
    let mut edges = BTreeMap::<_, Vec<_>>::new();
    for offsets in mesh.prim_start.windows(2) {
        let face = &mesh.vertex_point[offsets[0] as usize..offsets[1] as usize];
        for (a, b) in face
            .iter()
            .copied()
            .zip(face.iter().copied().cycle().skip(1))
            .take(face.len())
        {
            edges.entry(pair(a, b)).or_default().push((a, b));
        }
    }
    edges
}
fn assert_mesh(mesh: &QuadMesh, source: &[f64], tris: &[u32], closed: bool) {
    assert!(!mesh.positions.is_empty());
    assert!(mesh.positions.iter().all(|v| v.is_finite()));
    assert_eq!(mesh.prim_start[0], 0);
    assert_eq!(
        mesh.prim_start.last().copied().unwrap() as usize,
        mesh.vertex_point.len()
    );
    let n = mesh.positions.len() / 3;
    assert_eq!(mesh.source_triangle.len(), n);
    assert_eq!(mesh.barycentric.len(), n * 3);
    assert_eq!(mesh.src_prim.len(), mesh.prim_start.len() - 1);
    let mut unique_faces = BTreeSet::new();
    for offsets in mesh.prim_start.windows(2) {
        let face = &mesh.vertex_point[offsets[0] as usize..offsets[1] as usize];
        assert!((3..=4).contains(&face.len()));
        assert_eq!(face.iter().collect::<BTreeSet<_>>().len(), face.len());
        let mut sorted = face.to_vec();
        sorted.sort();
        assert!(
            unique_faces.insert(sorted),
            "duplicate/opposite polygon uses the same point set {face:?}"
        );
        assert!(face.iter().all(|&i| (i as usize) < n));
        let origin = point(&mesh.positions, face[0]);
        let mut area = [0.0; 3];
        for j in 1..face.len() - 1 {
            let v = cross(
                sub(point(&mesh.positions, face[j]), origin),
                sub(point(&mesh.positions, face[j + 1]), origin),
            );
            for k in 0..3 {
                area[k] += v[k];
            }
        }
        assert!(length(area) > 1e-12, "degenerate polygon {face:?}");
    }
    for incidences in edges(mesh).values() {
        assert!((1..=2).contains(&incidences.len()), "non-manifold edge");
        if closed {
            assert_eq!(incidences.len(), 2, "open edge on closed source");
        }
        if incidences.len() == 2 {
            assert_eq!(
                incidences[0],
                (incidences[1].1, incidences[1].0),
                "inconsistent winding"
            );
        }
    }
    for i in 0..n {
        let t = mesh.source_triangle[i] as usize;
        assert!(t < tris.len() / 3);
        let weights = &mesh.barycentric[i * 3..i * 3 + 3];
        assert!((weights.iter().sum::<f64>() - 1.0).abs() < 1e-10);
        assert!(weights.iter().all(|&w| (-1e-10..=1.0 + 1e-10).contains(&w)));
        for k in 0..3 {
            let projected: f64 = weights
                .iter()
                .enumerate()
                .map(|(j, w)| w * source[tris[t * 3 + j] as usize * 3 + k])
                .sum();
            assert!(
                (projected - mesh.positions[i * 3 + k]).abs() < 1e-9,
                "bad provenance at point {i}"
            );
        }
    }
    assert!(
        mesh.src_prim
            .iter()
            .all(|&t| t >= 0 && (t as usize) < tris.len() / 3)
    );
    assert!(mesh.quality.planarity_mean.is_finite() && mesh.quality.planarity_max.is_finite());
}

#[test]
fn sphere_quality_watertight_and_provenance() {
    let (p, t) = ico_sphere(3);
    let target = 0.14;
    let m = remesh_quad(
        &p,
        &t,
        &RemeshOptions {
            target_edge_length: target,
            ..RemeshOptions::default()
        },
    )
    .unwrap();
    assert_mesh(&m, &p, &t, true);
    let e = edges(&m);
    let within = e
        .keys()
        .filter(|&&(a, b)| {
            (length(sub(point(&m.positions, a), point(&m.positions, b))) - target).abs()
                <= target * 0.35
        })
        .count() as f64
        / e.len() as f64;
    let quads = m.prim_start.windows(2).filter(|v| v[1] - v[0] == 4).count();
    let fraction = quads as f64 / (m.prim_start.len() - 1) as f64;
    let mut valence = vec![0; m.positions.len() / 3];
    for &(a, b) in e.keys() {
        valence[a as usize] += 1;
        valence[b as usize] += 1;
    }
    let singularities = valence.iter().filter(|&&n| n != 4).count();
    assert_eq!(
        singularities, m.quality.singularities as usize,
        "quality reports actual irregular vertices"
    );
    assert!((fraction - m.quality.quad_fraction).abs() < 1e-12);
    println!(
        "sphere: {} points, {} faces, {:.4}% quads, {} singularities ({:.4}%), {:.4}% edges within 35%",
        valence.len(),
        m.prim_start.len() - 1,
        fraction * 100.0,
        singularities,
        100.0 * singularities as f64 / valence.len() as f64,
        within * 100.0
    );
    assert!(
        fraction > 0.9,
        "sphere quad fraction {fraction} must exceed 0.9"
    );
    assert!(
        within > 0.9,
        "sphere in-range edge fraction {within} must exceed 0.9"
    );
    assert!(
        (singularities as f64 / valence.len() as f64) < 0.02,
        "sphere singularities must be less than 2% of points"
    );
}

#[test]
fn box_features_follow_all_twelve_edges_within_five_degrees() {
    let (p, t) = cube();
    let m = remesh_quad(
        &p,
        &t,
        &RemeshOptions {
            target_edge_length: 0.2,
            ..RemeshOptions::default()
        },
    )
    .unwrap();
    assert_mesh(&m, &p, &t, true);
    let mut feature_length = [0.0; 12];
    for &(a, b) in edges(&m).keys() {
        let a = point(&m.positions, a);
        let b = point(&m.positions, b);
        let fixed: Vec<_> = (0..3)
            .filter(|&k| (a[k].abs() - 0.5).abs() < 1e-8 && (a[k] - b[k]).abs() < 1e-8)
            .collect();
        if fixed.len() != 2 {
            continue;
        }
        let moving = 3 - fixed[0] - fixed[1];
        let d = sub(a, b);
        assert!(d[moving].abs() / length(d) >= libm::cos(5.0 * std::f64::consts::PI / 180.0));
        let index =
            moving * 4 + usize::from(a[fixed[0]] > 0.0) * 2 + usize::from(a[fixed[1]] > 0.0);
        feature_length[index] += length(d);
    }
    for total in feature_length {
        assert!(
            (total - 1.0).abs() < 1e-7,
            "missing box edge coverage: {total}"
        );
    }
}

fn random(state: &mut u32) -> f64 {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    f64::from(*state) / f64::from(u32::MAX)
}

#[test]
fn property_seeded_noisy_grids_have_no_degenerates_or_nonmanifold_edges() {
    for seed in 1..=24 {
        let mut rng = seed;
        let width = 6 + (random(&mut rng) * 6.0) as u32;
        let height = 6 + (random(&mut rng) * 6.0) as u32;
        let mut p = Vec::new();
        for row in 0..=height {
            for col in 0..=width {
                p.extend([
                    f64::from(col) / f64::from(width),
                    (random(&mut rng) - 0.5) * 0.04,
                    -f64::from(row) / f64::from(height),
                ]);
            }
        }
        let mut t = Vec::new();
        for row in 0..height {
            for col in 0..width {
                let a = row * (width + 1) + col;
                let b = a + 1;
                let d = a + width + 1;
                let c = d + 1;
                if random(&mut rng) > 0.5 {
                    t.extend([a, b, c, a, c, d]);
                } else {
                    t.extend([a, b, d, b, c, d]);
                }
            }
        }
        let options = RemeshOptions {
            target_edge_length: 0.12 + random(&mut rng) * 0.08,
            quad_only: seed % 3 == 0,
            smooth_iterations: 5,
            ..RemeshOptions::default()
        };
        let m = remesh_quad(&p, &t, &options).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        assert_mesh(&m, &p, &t, false);
        if options.quad_only {
            assert!(
                m.prim_start.windows(2).all(|v| v[1] - v[0] == 4),
                "seed {seed}: residual nonquad"
            );
        }
    }
}

#[test]
fn malformed_and_nonmanifold_inputs_return_errors_and_do_not_mutate_inputs() {
    let (p, t) = cube();
    let options = RemeshOptions::default();
    assert!(remesh_quad(&[], &t, &options).is_err());
    assert!(remesh_quad(&p, &[], &options).is_err());
    assert!(remesh_quad(&p, &[0, 1], &options).is_err());
    assert!(remesh_quad(&p, &[0, 1, 900], &options).is_err());
    let mut bad = p.clone();
    bad[0] = f64::NAN;
    assert!(remesh_quad(&bad, &t, &options).is_err());
    for options in [
        RemeshOptions {
            target_edge_length: f64::NAN,
            ..options.clone()
        },
        RemeshOptions {
            target_edge_length: -1.0,
            ..options.clone()
        },
        RemeshOptions {
            feature_angle: f64::INFINITY,
            ..options.clone()
        },
        RemeshOptions {
            max_faces: 0,
            ..options.clone()
        },
        RemeshOptions {
            target_face_count: 500,
            max_faces: 10,
            ..options.clone()
        },
        RemeshOptions {
            locked_edges: vec![0, 900],
            ..options.clone()
        },
        RemeshOptions {
            crease_edges: vec![0],
            ..options.clone()
        },
    ] {
        assert!(remesh_quad(&p, &t, &options).is_err());
    }
    let mut nonmanifold = t.clone();
    nonmanifold.extend([0, 2, 7]);
    let error = remesh_quad(&p, &nonmanifold, &options).unwrap_err();
    assert!(error.contains("manifold"), "{error}");
    let before = (p.clone(), t.clone());
    let m = remesh_quad(&p, &t, &options).unwrap();
    assert_mesh(&m, &p, &t, true);
    assert_eq!((p, t), before);
}

fn hash_bytes(hash: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *hash ^= u64::from(*b);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}
fn digest(mesh: &QuadMesh) -> u64 {
    let mut hash = 0xcbf29ce484222325;
    for &n in &mesh.positions {
        hash_bytes(&mut hash, &n.to_le_bytes());
    }
    for array in [&mesh.prim_start, &mesh.vertex_point, &mesh.source_triangle] {
        for &n in array {
            hash_bytes(&mut hash, &n.to_le_bytes());
        }
    }
    for &n in &mesh.barycentric {
        hash_bytes(&mut hash, &n.to_le_bytes());
    }
    for &n in &mesh.src_prim {
        hash_bytes(&mut hash, &n.to_le_bytes());
    }
    hash
}

#[test]
fn deterministic_native_wasm_parity_fixture() {
    // Also constructed in test/remeshquad.ts: all inputs are exactly representable binary fractions.
    let mut p = Vec::new();
    for row in 0..5 {
        for col in 0..5 {
            p.extend([
                f64::from(col - 2) / 2.0,
                f64::from((col * 17 + row * 13) % 7 - 3) / 128.0,
                f64::from(2 - row) / 2.0,
            ]);
        }
    }
    let mut t = Vec::new();
    for row in 0..4 {
        for col in 0..4 {
            let a = row * 5 + col;
            if (row + col) % 2 == 0 {
                t.extend([a, a + 1, a + 6, a, a + 6, a + 5]);
            } else {
                t.extend([a, a + 1, a + 5, a + 1, a + 6, a + 5]);
            }
        }
    }
    let options = RemeshOptions {
        target_edge_length: 0.5,
        ..RemeshOptions::default()
    };
    let a = remesh_quad(&p, &t, &options).unwrap();
    let b = remesh_quad(&p, &t, &options).unwrap();
    assert_mesh(&a, &p, &t, false);
    assert_eq!(digest(&a), digest(&b));
    println!(
        "quad_parity_digest={:016x}; {} points, {} faces",
        digest(&a),
        a.positions.len() / 3,
        a.prim_start.len() - 1
    );
}

fn orient_convex(positions: &[f64], triangles: &mut [u32]) {
    for face in triangles.chunks_exact_mut(3) {
        let a = point(positions, face[0]);
        let b = point(positions, face[1]);
        let c = point(positions, face[2]);
        let normal = cross(sub(b, a), sub(c, a));
        let signed: f64 = (0..3).map(|k| normal[k] * (a[k] + b[k] + c[k])).sum();
        if signed < 0.0 {
            face.swap(1, 2);
        }
    }
}

#[test]
fn adversarial_small_closed_polyhedra_at_extreme_target_lengths() {
    let tetrahedron = (
        vec![
            0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5,
        ],
        vec![0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2],
    );
    let octahedron = (
        vec![
            0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, -1.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, -1.0,
            0.0,
        ],
        vec![
            0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 5, 2, 1, 5, 3, 2, 5, 4, 3, 5, 1, 4,
        ],
    );
    for (name, (positions, mut triangles)) in
        [("tetrahedron", tetrahedron), ("octahedron", octahedron)]
    {
        orient_convex(&positions, &mut triangles);
        for target in [1000.0, 1.0, 0.1] {
            for preserve_sharp in [true, false] {
                let result = remesh_quad(
                    &positions,
                    &triangles,
                    &RemeshOptions {
                        target_edge_length: target,
                        preserve_sharp,
                        ..RemeshOptions::default()
                    },
                )
                .unwrap_or_else(|e| panic!("{name} target {target}, sharp {preserve_sharp}: {e}"));
                assert_mesh(&result, &positions, &triangles, true);
                println!(
                    "{name} target {target}, sharp {preserve_sharp}: {} points, {} faces",
                    result.positions.len() / 3,
                    result.prim_start.len() - 1
                );
            }
        }
    }
}

fn component_boundaries(mesh: &QuadMesh) -> Vec<usize> {
    let mut parent: Vec<_> = (0..mesh.positions.len() / 3).collect();
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let edges = edges(mesh);
    for &(a, b) in edges.keys() {
        let a = find(&mut parent, a as usize);
        let b = find(&mut parent, b as usize);
        parent[b] = a;
    }
    let mut boundaries = BTreeMap::new();
    for (&(a, _), incidences) in &edges {
        let root = find(&mut parent, a as usize);
        *boundaries.entry(root).or_insert(0) += usize::from(incidences.len() == 1);
    }
    let mut result: Vec<_> = boundaries.into_values().collect();
    result.sort();
    result
}

#[test]
fn adversarial_disconnected_closed_and_mixed_open_components() {
    let (base_p, base_t) = cube();
    for closed_second in [true, false] {
        let mut p = base_p.clone();
        let mut t = base_t.clone();
        if closed_second {
            for point in base_p.chunks_exact(3) {
                p.extend([point[0] + 3.0, point[1], point[2]]);
            }
            t.extend(base_t.iter().map(|v| v + 8));
        } else {
            p.extend([2.5, 0.0, 0.5, 3.5, 0.0, 0.5, 3.5, 0.0, -0.5, 2.5, 0.0, -0.5]);
            t.extend([8, 9, 10, 8, 10, 11]);
        }
        let result = remesh_quad(
            &p,
            &t,
            &RemeshOptions {
                target_edge_length: 0.25,
                ..RemeshOptions::default()
            },
        )
        .unwrap();
        assert_mesh(&result, &p, &t, closed_second);
        let components = component_boundaries(&result);
        assert_eq!(
            components.len(),
            2,
            "disconnected components must stay separate"
        );
        assert_eq!(components[0], 0, "first closed component must stay closed");
        assert_eq!(components[1] == 0, closed_second);
        for starts in result.prim_start.windows(2) {
            let points = &result.vertex_point[starts[0] as usize..starts[1] as usize];
            let first_side = point(&result.positions, points[0])[0] < 1.0;
            assert!(
                points
                    .iter()
                    .all(|&v| (point(&result.positions, v)[0] < 1.0) == first_side),
                "face bridges disconnected components"
            );
        }
    }
}

#[test]
fn adversarial_removed_degenerate_triangles_never_supply_provenance() {
    let (mut p, mut t) = cube();
    // Deliberately near the surface, so an unfiltered nearest-triangle projector could prefer them.
    p.extend([0.0, 0.0, 0.55, 0.05, 0.0, 0.55, 0.1, 0.0, 0.55]);
    t.extend([8, 9, 10, 8, 8, 8]);
    let result = remesh_quad(
        &p,
        &t,
        &RemeshOptions {
            target_edge_length: 0.1,
            ..RemeshOptions::default()
        },
    )
    .unwrap();
    assert_mesh(&result, &p, &t, true);
    assert!(result.source_triangle.iter().all(|&triangle| triangle < 12));
    assert!(result.src_prim.iter().all(|&triangle| triangle < 12));
    for point in result.positions.chunks_exact(3) {
        let max = point.iter().map(|n| n.abs()).fold(0.0_f64, f64::max);
        assert!(
            (max - 0.5).abs() < 1e-9,
            "point left source cube for a degenerate triangle"
        );
    }
}

#[test]
fn adversarial_collinear_locked_border_keeps_exact_partition() {
    let mut p = Vec::new();
    for row in 0..3 {
        for col in 0..5 {
            p.extend([f64::from(col) / 4.0, 0.0, -f64::from(row) / 2.0]);
        }
    }
    let mut t = Vec::new();
    for row in 0..2 {
        for col in 0..4 {
            let a = row * 5 + col;
            t.extend([a, a + 1, a + 6, a, a + 6, a + 5]);
        }
    }
    for target in [0.1, 0.5] {
        let result = remesh_quad(
            &p,
            &t,
            &RemeshOptions {
                target_edge_length: target,
                locked_edges: vec![0, 1, 1, 2, 2, 3, 3, 4],
                ..RemeshOptions::default()
            },
        )
        .unwrap();
        assert_mesh(&result, &p, &t, false);
        let output_edges = edges(&result);
        for a in 0..4 {
            let find = |source: u32| {
                result
                    .positions
                    .chunks_exact(3)
                    .position(|p0| p0 == point(&p, source))
                    .expect("locked endpoint missing") as u32
            };
            let edge = pair(find(a), find(a + 1));
            assert_eq!(
                output_edges.get(&edge).map(Vec::len),
                Some(1),
                "locked border edge split, collapsed, or detached"
            );
        }
    }
}
