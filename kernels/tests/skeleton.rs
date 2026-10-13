use polyforge_kernels::{Roof, Skeleton, offset, roof_mesh, skeleton};
use std::collections::BTreeMap;
const RECT: &[f64] = &[0., 0., 6., 0., 6., 4., 0., 4.];
const L: &[f64] = &[0., 0., 6., 0., 6., 2., 2., 2., 2., 6., 0., 6.];
const U: &[f64] = &[
    0., 0., 6., 0., 6., 6., 4., 6., 4., 2., 2., 2., 2., 6., 0., 6.,
];
const OUTER: &[f64] = &[0., 0., 8., 0., 8., 8., 0., 8.];
const HOLE: &[f64] = &[2., 2., 2., 6., 6., 6., 6., 2.];
fn area(points: &[f64]) -> f64 {
    let n = points.len() / 2;
    (0..n)
        .map(|i| {
            points[2 * i] * points[2 * ((i + 1) % n) + 1]
                - points[2 * i + 1] * points[2 * ((i + 1) % n)]
        })
        .sum::<f64>()
        * 0.5
}
fn tile(s: &Skeleton, expected: f64) {
    let mut sum = 0.;
    for bounds in s.face_start.windows(2) {
        let p: Vec<f64> = s.face_vertex_index[bounds[0] as usize..bounds[1] as usize]
            .iter()
            .flat_map(|i| {
                [
                    s.vertices[2 * (*i as usize)],
                    s.vertices[2 * (*i as usize) + 1],
                ]
            })
            .collect();
        let a = area(&p);
        assert!(a >= -1e-12, "negative face {p:?}");
        simple(&p);
        sum += a;
    }
    assert!(
        (sum - expected).abs() < 1e-9,
        "tile area {sum}, expected {expected}"
    );
}
fn orient(a: &[f64], b: &[f64], c: &[f64]) -> f64 {
    robust::orient2d(
        robust::Coord { x: a[0], y: a[1] },
        robust::Coord { x: b[0], y: b[1] },
        robust::Coord { x: c[0], y: c[1] },
    )
}
fn proper_cross(a: &[f64], b: &[f64], c: &[f64], d: &[f64]) -> bool {
    orient(a, b, c) * orient(a, b, d) < -1e-20 && orient(c, d, a) * orient(c, d, b) < -1e-20
}
fn simple(p: &[f64]) {
    let points: Vec<_> = p.chunks_exact(2).collect();
    let n = points.len();
    for i in 0..n {
        for j in i + 1..n {
            assert!(points[i] != points[j], "face repeats a vertex: {p:?}");
            if j == i + 1 || (i == 0 && j == n - 1) {
                continue;
            }
            assert!(
                !proper_cross(
                    points[i],
                    points[(i + 1) % n],
                    points[j],
                    points[(j + 1) % n]
                ),
                "face crosses itself: {p:?}"
            );
        }
    }
}
fn arcs_inside(s: &Skeleton, outer: &[f64], holes: &[Vec<f64>]) {
    for arc in s.arcs.chunks_exact(4) {
        for ring in std::iter::once(outer).chain(holes.iter().map(Vec::as_slice)) {
            let n = ring.len() / 2;
            for i in 0..n {
                assert!(
                    !proper_cross(
                        &arc[0..2],
                        &arc[2..4],
                        &ring[2 * i..2 * i + 2],
                        &ring[2 * ((i + 1) % n)..2 * ((i + 1) % n) + 2]
                    ),
                    "skeleton arc crosses contour"
                );
            }
        }
    }
}
fn roof_topology(r: &Roof) {
    let mut edges = BTreeMap::<(u32, u32), (usize, i32)>::new();
    for bounds in r.face_start.windows(2) {
        let face = &r.face_vertex_index[bounds[0] as usize..bounds[1] as usize];
        for (&a, &b) in face.iter().zip(face.iter().cycle().skip(1)) {
            let key = if a < b { (a, b) } else { (b, a) };
            let e = edges.entry(key).or_default();
            e.0 += 1;
            e.1 += if a < b { 1 } else { -1 };
        }
    }
    for ((a, b), (count, orientation)) in edges {
        let eave = r.vertices[3 * a as usize + 2] == 0. && r.vertices[3 * b as usize + 2] == 0.;
        if eave {
            assert_eq!(count, 1, "eave must appear once");
        } else {
            assert_eq!(count, 2, "interior edge {a}-{b} incidence {count}");
            assert_eq!(orientation, 0, "interior edge winding");
        }
    }
}
#[test]
fn rectangle() {
    let s = skeleton(RECT, &[], &[]).unwrap();
    assert_eq!(s.face_edge.len(), 4);
    assert_eq!(s.vertices.len() / 2, 6);
    tile(&s, 24.);
    assert_eq!(s, skeleton(RECT, &[], &[]).unwrap());
}
#[test]
fn l_shape() {
    tile(&skeleton(L, &[], &[]).unwrap(), 20.);
}
#[test]
fn u_shape() {
    tile(&skeleton(U, &[], &[]).unwrap(), 28.);
}
#[test]
fn hole() {
    tile(&skeleton(OUTER, &[HOLE.to_vec()], &[]).unwrap(), 48.);
}
#[test]
fn collinear() {
    let p = [0., 0., 3., 0., 6., 0., 6., 4., 0., 4.];
    tile(&skeleton(&p, &[], &[]).unwrap(), 24.);
}
#[test]
fn duplicate_rejected() {
    assert!(
        skeleton(&[0., 0., 6., 0., 6., 4., 0., 0.], &[], &[])
            .unwrap_err()
            .contains("duplicate")
    );
}
#[test]
fn offsets() {
    let a = offset(RECT, &[], 0.5).unwrap();
    assert!((area(&a.vertices) - 15.).abs() < 1e-10);
    let b = offset(RECT, &[], -0.5).unwrap();
    assert!((area(&b.vertices) - 35.).abs() < 1e-10);
    assert_eq!(offset(RECT, &[], 9.).unwrap().polygon_start.len(), 1);
    for p in [L, U] {
        assert!(!offset(p, &[], -0.4).unwrap().vertices.is_empty());
    }
    offset(OUTER, &[HOLE.to_vec()], -0.35).unwrap();
}
#[test]
fn roofs() {
    for (p, holes) in [
        (RECT, vec![]),
        (L, vec![]),
        (U, vec![]),
        (OUTER, vec![HOLE.to_vec()]),
    ] {
        let r = roof_mesh(p, &holes, &[32.], None).unwrap();
        assert!(!r.vertices.is_empty());
        roof_topology(&r);
        let c = roof_mesh(p, &holes, &[32.], Some(0.3)).unwrap();
        assert!(c.face_edge.contains(&u32::MAX));
        roof_topology(&c);
    }
}
#[test]
fn weighted() {
    let s = skeleton(RECT, &[], &[1., 2., 1., 2.]).unwrap();
    tile(&s, 24.);
    let r = roof_mesh(RECT, &[], &[30., 60., 30., 60.], None).unwrap();
    assert!(
        (r.vertices.chunks_exact(3).map(|p| p[2]).fold(0., f64::max) - 2. / 3f64.sqrt()).abs()
            < 1e-10
    );
}
#[test]
fn gable() {
    let r = roof_mesh(RECT, &[], &[45., 90., 45., 90.], None).unwrap();
    assert!((r.vertices.chunks_exact(3).map(|p| p[2]).fold(0., f64::max) - 2.).abs() < 1e-10);
}
fn noisy(n: usize, seed: u64) -> Vec<f64> {
    let mut state = seed;
    let mut p = Vec::new();
    for i in 0..n {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let r = 4. + ((state >> 32) as u32 as f64 / u32::MAX as f64);
        let a = i as f64 * std::f64::consts::TAU / n as f64;
        p.extend([r * libm::cos(a), r * libm::sin(a)]);
    }
    p
}
#[test]
fn noisy_200() {
    let p = noisy(200, 11);
    let now = std::time::Instant::now();
    let s = skeleton(&p, &[], &[]).unwrap();
    tile(&s, area(&p));
    eprintln!("200 vertex skeleton: {:?}", now.elapsed());
    let now = std::time::Instant::now();
    roof_mesh(&p, &[], &[35.], None).unwrap();
    eprintln!("200 vertex roof: {:?}", now.elapsed());
}
#[test]
fn random_simple_property() {
    for seed in 0..300 {
        let p = noisy(5 + (seed % 31) as usize, seed + 1);
        let s = skeleton(&p, &[], &[]).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        tile(&s, area(&p));
        arcs_inside(&s, &p, &[]);
        let weights: Vec<f64> = (0..p.len() / 2)
            .map(|i| 0.5 + ((i as u64 * 17 + seed) % 29) as f64 / 11.)
            .collect();
        let weighted =
            skeleton(&p, &[], &weights).unwrap_or_else(|e| panic!("weighted seed {seed}: {e}"));
        tile(&weighted, area(&p));
        arcs_inside(&weighted, &p, &[]);
    }
}
#[test]
fn capped_collinear() {
    let p = [0., 0., 2., 0., 3., 0., 6., 0., 6., 4., 0., 4.];
    roof_topology(&roof_mesh(&p, &[], &[45.], Some(0.5)).unwrap());
}
#[test]
fn literature_regressions() {
    // Independently digitized from the primary papers' figures, not from code.
    // Huber thesis (2011), p27 Fig13: invalid Felkel-Obdrzalek split candidate.
    let felkel = [
        0., 0., 9.5, 0., 9.5, 7.75, 6.5, 7.625, 9.5, 9., 6., 9., 5., 8., 4., 9., 0., 9., 0., 5.,
        0.5, 4., 0., 3.,
    ];
    // Aichholzer et al. (1995), p760 Fig5: unrestricted-plane lower-envelope fails.
    let aichholzer = [
        0., 0.7, 19.2, 0., 18.45, 8.85, 6.6, 8.1, 4.4, 11.8, 4.05, 8.1, 3.65, 13.25, 0.85, 4.4,
        1.6, 4.25, 0.8, 4.1,
    ];
    for p in [&felkel[..], &aichholzer[..]] {
        let s = skeleton(p, &[], &[]).unwrap();
        tile(&s, area(p));
        arcs_inside(&s, p, &[]);
        roof_topology(&roof_mesh(p, &[], &[32.], None).unwrap());
    }
}
#[test]
fn near_parallel() {
    let p = [0., 0., 3., 1e-8, 6., 0., 6., 4., 0., 4.];
    let s = skeleton(&p, &[], &[]).unwrap();
    tile(&s, area(&p));
}
#[test]
fn invalid_inputs() {
    for p in [
        vec![],
        vec![0., 0., 1., 0., f64::NAN, 1.],
        vec![0., 0., 1., 1., 0., 1., 1., 0.],
        vec![0., 0., 1., 0., 2., 0.],
    ] {
        assert!(skeleton(&p, &[], &[]).is_err());
    }
    assert!(skeleton(RECT, &[vec![9., 9., 10., 9., 10., 10.]], &[]).is_err());
    assert!(roof_mesh(RECT, &[], &[0.], None).is_err());
    assert!(roof_mesh(RECT, &[], &[90.], None).is_err());
}

#[test]
fn offsets_after_topology_events() {
    for d in [-1.0, -1.25, -3.0, 0.25, 0.999, 1.0, 1.01, 3.0] {
        for (p, holes) in [(U, vec![]), (OUTER, vec![HOLE.to_vec()])] {
            let o = offset(p, &holes, d).unwrap_or_else(|e| panic!("offset {d}: {e}"));
            for bounds in o.polygon_start.windows(2) {
                let ring: Vec<f64> = o.polygon_vertex_index[bounds[0] as usize..bounds[1] as usize]
                    .iter()
                    .flat_map(|i| {
                        [
                            o.vertices[2 * (*i as usize)],
                            o.vertices[2 * (*i as usize) + 1],
                        ]
                    })
                    .collect();
                simple(&ring);
            }
        }
    }
}

#[test]
fn weighted_holes_property() {
    let hole = vec![1.3, 1.1, 1.3, 4.7, 5.6, 4.7, 5.6, 1.1];
    for seed in 0..100 {
        let weights: Vec<f64> = (0..8)
            .map(|i| 0.5 + ((i * 17 + seed * 7) % 29) as f64 / 11.)
            .collect();
        let s = skeleton(OUTER, std::slice::from_ref(&hole), &weights)
            .unwrap_or_else(|e| panic!("weighted hole seed {seed}: {e}"));
        tile(&s, 64. + area(&hole));
        arcs_inside(&s, OUTER, std::slice::from_ref(&hole));
    }
}

#[test]
fn unequal_collinear_weights_rejected() {
    let p = [0., 0., 3., 0., 6., 0., 6., 4., 0., 4.];
    assert!(
        skeleton(&p, &[], &[1., 2., 1., 1., 1.])
            .unwrap_err()
            .contains("collinear")
    );
}

#[test]
fn output_overflow_is_a_clear_error() {
    let p = [0., 0., 1e308, 0., 1e308, 1e308, 0., 1e308];
    assert!(
        offset(&p, &[], -1e308)
            .unwrap_err()
            .contains("finite coordinate range")
    );
    assert!(
        roof_mesh(&p, &[], &[89.], None)
            .unwrap_err()
            .contains("finite coordinate range")
    );
}

#[test]
fn provenance_is_complete_and_normalized() {
    let s = skeleton(OUTER, &[HOLE.to_vec()], &[]).unwrap();
    let r = roof_mesh(OUTER, &[HOLE.to_vec()], &[35.], Some(0.5)).unwrap();
    let o = offset(OUTER, &[HOLE.to_vec()], 0.3).unwrap();
    for (p, count, corners, faces) in [
        (
            &s.provenance,
            s.vertices.len() / 2,
            s.face_vertex_index.len(),
            s.face_edge.len(),
        ),
        (
            &r.provenance,
            r.vertices.len() / 3,
            r.face_vertex_index.len(),
            r.face_edge.len(),
        ),
        (
            &o.provenance,
            o.vertices.len() / 2,
            o.polygon_vertex_index.len(),
            o.polygon_hole.len(),
        ),
    ] {
        assert_eq!(p.src_point.len(), count);
        assert_eq!(p.blend_offset.len(), count + 1);
        assert_eq!(p.src_vertex.len(), corners);
        assert_eq!(p.src_prim.len(), faces);
        assert_eq!(
            *p.blend_offset.last().unwrap() as usize,
            p.blend_index.len()
        );
        assert_eq!(p.blend_index.len(), p.blend_weight.len());
        for i in 0..count {
            let a = p.blend_offset[i] as usize;
            let b = p.blend_offset[i + 1] as usize;
            if p.src_point[i] >= 0 {
                assert_eq!(a, b);
            } else {
                assert!(b > a);
                assert!((p.blend_weight[a..b].iter().sum::<f32>() - 1.).abs() < 1e-6);
                assert!(p.blend_index[a..b].iter().all(|id| *id < 8));
            }
        }
    }
    assert!(s.provenance.src_prim.contains(&1));
    assert!(r.provenance.src_prim.contains(&-1));
    let z = offset(RECT, &[], 0.).unwrap();
    assert_eq!(z.provenance.src_point, vec![0, 1, 2, 3]);
}
