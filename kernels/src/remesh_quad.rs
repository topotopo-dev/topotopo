//! Intrinsic, deterministic field-guided quad-dominant remeshing.
//!
//! The hierarchy and local frame/translation compatibility solve follow the
//! ideas of Jakob et al. (2015), implemented independently. Extraction is a
//! conservative quotient of the triangle graph: zero lattice translations are
//! contracted subject to the manifold link condition; diagonals are dissolved.
//! Conservative local cleanup repairs avoidable valence defects; residual
//! non-quads are converted with a conforming local split.

use std::collections::{BTreeMap, BTreeSet};

mod project;
use project::Projector;
mod defects;
use defects::DefectTree;
mod annulus;
mod caps;
mod cleanup;
mod translation;
use cleanup::cleanup_polygons;
mod extract;
use extract::{extract, improve_topology, pair_residual_triangles, polygon_normal, quad_subdivide};

type V3 = [f64; 3];
const NONE: usize = usize::MAX;
const MAX_WORK_FACES: usize = 2_000_000;

#[derive(Clone, Debug)]
pub struct RemeshOptions {
    pub target_edge_length: f64,
    pub target_face_count: u32,
    pub quad_only: bool,
    pub cleanup: bool,
    /// Radians. Zero disables automatic sharp-edge detection.
    pub feature_angle: f64,
    pub align_boundaries: bool,
    pub smooth_iterations: u32,
    pub preserve_sharp: bool,
    /// Paired input point indices defining hard alignment curves.
    pub crease_edges: Vec<u32>,
    /// Orientation-only field constraints. Geometric seam support remains exact
    /// for corner attributes, without pinning the lattice position origins.
    pub direction_edges: Vec<u32>,
    /// Paired input indices whose endpoints and edges must remain unchanged.
    pub locked_edges: Vec<u32>,
    pub max_faces: u32,
}

impl Default for RemeshOptions {
    fn default() -> Self {
        Self {
            target_edge_length: 0.0,
            target_face_count: 0,
            quad_only: false,
            cleanup: true,
            feature_angle: std::f64::consts::FRAC_PI_4,
            align_boundaries: true,
            smooth_iterations: 8,
            preserve_sharp: true,
            crease_edges: Vec::new(),
            direction_edges: Vec::new(),
            locked_edges: Vec::new(),
            max_faces: 1_000_000,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct QuadQuality {
    pub quad_fraction: f64,
    /// Interior vertices with valence other than four (boundary vertices excluded).
    pub singularities: u32,
    /// Interior irregular vertices divided by all output vertices.
    pub irregular_fraction: f64,
    pub edge_length_min: f64,
    pub edge_length_mean: f64,
    pub edge_length_max: f64,
    /// Absolute distance to a face plane, measured in input units.
    pub planarity_mean: f64,
    pub planarity_max: f64,
    pub target_edge_length: f64,
}

#[derive(Clone, Debug)]
pub struct QuadMesh {
    pub positions: Vec<f64>,
    pub prim_start: Vec<u32>,
    pub vertex_point: Vec<u32>,
    pub source_triangle: Vec<u32>,
    /// Three weights per output point, on source_triangle.
    pub barycentric: Vec<f64>,
    /// Input triangle under each polygon centroid.
    pub src_prim: Vec<i32>,
    pub quality: QuadQuality,
}

fn add(a: V3, b: V3) -> V3 {
    std::array::from_fn(|k| a[k] + b[k])
}
fn sub(a: V3, b: V3) -> V3 {
    std::array::from_fn(|k| a[k] - b[k])
}
fn mul(a: V3, s: f64) -> V3 {
    a.map(|v| v * s)
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
fn unit(a: V3) -> V3 {
    let d = norm(a);
    if d > 1e-30 { mul(a, 1.0 / d) } else { [0.0; 3] }
}
fn tangent(v: V3, n: V3) -> V3 {
    sub(v, mul(n, dot(v, n)))
}
fn axis(n: V3) -> V3 {
    let mut k = 0;
    for j in 1..3 {
        if n[j].abs() < n[k].abs() {
            k = j;
        }
    }
    let mut v = [0.0; 3];
    v[k] = 1.0;
    let t = unit(tangent(v, n));
    let b = cross(n, t);
    // Project an ambient cubic cross onto the tangent plane. Summing fourth
    // powers makes the seed independent of tangent-basis sign/quarter turns;
    // unlike choosing one world axis, there are no arbitrary chart seams.
    let mut re = 0.0;
    let mut im = 0.0;
    for k in 0..3 {
        let x = t[k];
        let y = b[k];
        re += x * x * x * x - 6.0 * x * x * y * y + y * y * y * y;
        im += 4.0 * x * y * (x * x - y * y);
    }
    let angle = 0.25 * libm::atan2(im, re);
    add(mul(t, libm::cos(angle)), mul(b, libm::sin(angle)))
}
fn pair(a: usize, b: usize) -> (usize, usize) {
    (a.min(b), a.max(b))
}

#[derive(Clone)]
struct Vertex {
    p: V3,
    n: V3,
    u: V3,
    q: V3,
    /// Curve tangent; zero means unconstrained. Corners are fixed.
    curve: V3,
    direction: V3,
    position_constraint: bool,
    fixed: bool,
    locked: bool,
    alive: bool,
}

#[derive(Clone)]
struct Face {
    v: [usize; 3],
    alive: bool,
}

#[derive(Clone, Copy)]
struct Edge {
    a: usize,
    b: usize,
    f: usize,
    g: usize,
}

fn edges(faces: &[Face]) -> Result<Vec<Edge>, String> {
    let mut all = Vec::with_capacity(3 * faces.len());
    for (f, face) in faces.iter().enumerate().filter(|(_, f)| f.alive) {
        for k in 0..3 {
            let a = face.v[k];
            let b = face.v[(k + 1) % 3];
            all.push((a.min(b), a.max(b), f, a < b));
        }
    }
    all.sort_unstable();
    let mut out = Vec::with_capacity(all.len() / 2);
    let mut i = 0;
    while i < all.len() {
        let (a, b, f, direction) = all[i];
        let mut j = i + 1;
        while j < all.len() && all[j].0 == a && all[j].1 == b {
            j += 1;
        }
        if j - i > 2 {
            return Err(format!(
                "remesh_quad: non-manifold edge {a}-{b} has {} incident triangles; repair the input first",
                j - i
            ));
        }
        if j - i == 2 && all[i + 1].3 == direction {
            return Err(format!(
                "remesh_quad: inconsistent winding at edge {a}-{b}; orient the input first"
            ));
        }
        out.push(Edge {
            a,
            b,
            f,
            g: if j - i == 2 { all[i + 1].2 } else { NONE },
        });
        i = j;
    }
    Ok(out)
}

fn face_normal(face: &Face, vertices: &[Vertex]) -> V3 {
    cross(
        sub(vertices[face.v[1]].p, vertices[face.v[0]].p),
        sub(vertices[face.v[2]].p, vertices[face.v[0]].p),
    )
}

fn normals(vertices: &mut [Vertex], faces: &[Face]) {
    for v in vertices.iter_mut() {
        v.n = [0.0; 3];
    }
    for f in faces.iter().filter(|f| f.alive) {
        let n = face_normal(f, vertices);
        for &i in &f.v {
            vertices[i].n = add(vertices[i].n, n);
        }
    }
    for v in vertices {
        v.n = unit(v.n);
        v.u = axis(v.n);
    }
}

fn validate(positions: &[f64], tris: &[u32], o: &RemeshOptions) -> Result<(), String> {
    if positions.is_empty() || !positions.len().is_multiple_of(3) || positions.len() / 3 > 1_000_000
    {
        return Err("remesh_quad: positions must contain xyz triples for 1..1000000 points".into());
    }
    if tris.is_empty() || !tris.len().is_multiple_of(3) || tris.len() / 3 > MAX_WORK_FACES {
        return Err(
            "remesh_quad: triangles must contain index triples for 1..2000000 triangles".into(),
        );
    }
    if positions.iter().any(|v| !v.is_finite() || v.abs() > 1e15) {
        return Err("remesh_quad: positions must be finite with magnitude at most 1e15".into());
    }
    if tris.iter().any(|&v| v as usize >= positions.len() / 3) {
        return Err("remesh_quad: triangle index outside positions".into());
    }
    if !o.target_edge_length.is_finite()
        || o.target_edge_length < 0.0
        || o.target_edge_length > 1e15
    {
        return Err("remesh_quad: target length must be finite and nonnegative".into());
    }
    if !o.feature_angle.is_finite() || !(0.0..=std::f64::consts::PI).contains(&o.feature_angle) {
        return Err("remesh_quad: feature angle must be in 0..pi radians".into());
    }
    if o.smooth_iterations > 100 {
        return Err("remesh_quad: smooth_iterations must be at most 100".into());
    }
    if o.max_faces == 0 || o.max_faces as usize > MAX_WORK_FACES {
        return Err("remesh_quad: max_faces must be in 1..2000000".into());
    }
    for (name, list) in [
        ("crease_edges", &o.crease_edges),
        ("direction_edges", &o.direction_edges),
        ("locked_edges", &o.locked_edges),
    ] {
        if !list.len().is_multiple_of(2) || list.iter().any(|&v| v as usize >= positions.len() / 3)
        {
            return Err(format!(
                "remesh_quad: {name} must contain valid point-index pairs"
            ));
        }
    }
    Ok(())
}

/// Independently implemented multiresolution field remesher. Input must be an
/// oriented manifold triangle mesh; disconnected components and boundaries are
/// supported. Degenerate triangles are removed before manifold validation.
pub fn remesh_quad(
    positions: &[f64],
    tris: &[u32],
    options: &RemeshOptions,
) -> Result<QuadMesh, String> {
    let mut profile = crate::erosion_profile::Profile::new("remesh_quad");
    validate(positions, tris, options)?;
    let mut vertices: Vec<Vertex> = positions
        .chunks_exact(3)
        .map(|p| Vertex {
            p: [p[0], p[1], p[2]],
            n: [0.; 3],
            u: [0.; 3],
            q: [p[0], p[1], p[2]],
            curve: [0.; 3],
            direction: [0.; 3],
            position_constraint: false,
            fixed: false,
            locked: false,
            alive: true,
        })
        .collect();
    let mut faces: Vec<Face> = tris
        .chunks_exact(3)
        .map(|t| Face {
            v: [t[0] as usize, t[1] as usize, t[2] as usize],
            alive: true,
        })
        .collect();
    let mut area = 0.0;
    for f in &mut faces {
        let a = norm(face_normal(f, &vertices));
        if a <= 1e-28 {
            f.alive = false;
        } else {
            area += 0.5 * a;
        }
    }
    if area <= 0.0 || !area.is_finite() {
        return Err("remesh_quad: input has no nondegenerate surface".into());
    }
    let mut mesh_edges = edges(&faces)?;
    check_vertex_fans(vertices.len(), &faces, &mesh_edges)?;
    normals(&mut vertices, &faces);
    let mut hard: BTreeSet<_> = options
        .crease_edges
        .chunks_exact(2)
        .map(|p| pair(p[0] as usize, p[1] as usize))
        .collect();
    let mut directions: BTreeSet<_> = options
        .direction_edges
        .chunks_exact(2)
        .map(|p| pair(p[0] as usize, p[1] as usize))
        .collect();
    let locked: BTreeSet<_> = options
        .locked_edges
        .chunks_exact(2)
        .map(|p| pair(p[0] as usize, p[1] as usize))
        .collect();
    let existing: BTreeSet<_> = mesh_edges.iter().map(|e| (e.a, e.b)).collect();
    if hard
        .iter()
        .chain(locked.iter())
        .chain(directions.iter())
        .any(|p| !existing.contains(p))
    {
        return Err("remesh_quad: constraint pair does not name an input triangle edge".into());
    }
    for e in &mesh_edges {
        let sharp = options.preserve_sharp
            && options.feature_angle > 0.0
            && e.g != NONE
            && dot(
                unit(face_normal(&faces[e.f], &vertices)),
                unit(face_normal(&faces[e.g], &vertices)),
            ) < libm::cos(options.feature_angle);
        if sharp || (e.g == NONE && options.align_boundaries) || locked.contains(&(e.a, e.b)) {
            hard.insert((e.a, e.b));
        }
    }
    let segments: Vec<_> = hard
        .union(&directions)
        .map(|&(a, b)| (vertices[a].p, vertices[b].p))
        .collect();
    profile.mark("validation_setup");
    let projector = Projector::new(positions, tris, &segments);
    profile.mark("projector_build");
    set_constraints(&mut vertices, &hard, &locked);
    let length = if options.target_face_count > 0 {
        libm::sqrt(area / options.target_face_count as f64)
    } else if options.target_edge_length > 0.0 {
        options.target_edge_length
    } else {
        mesh_edges
            .iter()
            .map(|e| norm(sub(vertices[e.a].p, vertices[e.b].p)))
            .sum::<f64>()
            / mesh_edges.len() as f64
    };
    if length < 1e-14 || !length.is_finite() {
        return Err("remesh_quad: target length is too small for a stable field".into());
    }
    if area / (length * length) > options.max_faces as f64 * 1.5 {
        return Err(
            "remesh_quad: requested density exceeds max_faces; increase target_length or max_faces"
                .into(),
        );
    }
    // Sample at the requested density; only residual non-quads are split.
    let work_length = length;
    refine(
        &mut vertices,
        &mut faces,
        &mut hard,
        &mut directions,
        &locked,
        work_length,
        options.max_faces as usize,
    )?;
    mesh_edges = edges(&faces)?;
    normals(&mut vertices, &faces);
    set_constraints(&mut vertices, &hard, &locked);
    set_directions(&mut vertices, &directions);
    hard.extend(&directions);
    profile.mark("refinement");
    solve_fields(
        &mut vertices,
        &mesh_edges,
        work_length,
        options.smooth_iterations,
    );
    profile.mark("fields_total");
    translation::repair(&mut vertices, &faces, &mesh_edges, &hard, work_length)?;
    profile.mark("translation");
    let mut hard = contract(&mut vertices, &mut faces, &hard, work_length, &projector);
    profile.mark("contraction");
    mesh_edges = edges(&faces)?;
    let mut polygons = extract(&vertices, &faces, &mesh_edges, &hard, work_length);
    profile.mark("extraction");
    if options.cleanup {
        cleanup_polygons(&mut vertices, &mut polygons, &hard, &projector, work_length);
    }
    profile.mark("cleanup");
    if options.quad_only {
        // Condition the parents before inserting projected edge/face points.
        // Ordinary quad-dominant extraction already uses the repaired lattice.
        relax_polygons(&mut vertices, &polygons, &projector, work_length, 3);
        pair_residual_triangles(&vertices, &mut polygons, &hard, work_length);
        if !options.cleanup {
            improve_topology(&vertices, &mut polygons, &hard, work_length);
        }
        annulus::regularize(
            &mut vertices,
            &mut polygons,
            &mut hard,
            &projector,
            work_length,
        );
        caps::regularize_planar_patches(
            &mut vertices,
            &mut polygons,
            &mut hard,
            &projector,
            work_length,
        );
        quad_subdivide(
            &mut vertices,
            &mut polygons,
            &projector,
            &hard,
            &locked,
            options.max_faces as usize,
        )?;
    }
    profile.mark("quad_conversion");
    if polygons.len() > options.max_faces as usize {
        return Err(format!(
            "remesh_quad: extracted {} faces exceeds max_faces {}; increase the guard or target length",
            polygons.len(),
            options.max_faces
        ));
    }
    relax_polygons(
        &mut vertices,
        &polygons,
        &projector,
        length,
        options.smooth_iterations.min(8),
    );
    profile.mark("projection");
    let result = finish(&vertices, &polygons, &projector, length);
    profile.mark("provenance_quality");
    profile.finish();
    result
}

fn check_vertex_fans(n: usize, faces: &[Face], mesh_edges: &[Edge]) -> Result<(), String> {
    let mut links = vec![Vec::new(); n];
    let mut incident = vec![0; n];
    for f in faces.iter().filter(|f| f.alive) {
        for &v in &f.v {
            incident[v] += 1;
        }
    }
    for e in mesh_edges {
        if e.g != NONE {
            links[e.a].push((e.f, e.g));
            links[e.b].push((e.f, e.g));
        }
    }
    for v in 0..n {
        if incident[v] < 2 {
            continue;
        }
        let mut reached = BTreeSet::new();
        if let Some(&(a, b)) = links[v].first() {
            reached.insert(a);
            reached.insert(b);
        }
        loop {
            let before = reached.len();
            for &(a, b) in &links[v] {
                if reached.contains(&a) || reached.contains(&b) {
                    reached.insert(a);
                    reached.insert(b);
                }
            }
            if before == reached.len() {
                break;
            }
        }
        if reached.len() != incident[v] {
            return Err(format!(
                "remesh_quad: non-manifold vertex {v} has disconnected fans; split or repair it first"
            ));
        }
    }
    Ok(())
}

fn set_constraints(
    vertices: &mut [Vertex],
    hard: &BTreeSet<(usize, usize)>,
    locked: &BTreeSet<(usize, usize)>,
) {
    let mut directions = vec![Vec::new(); vertices.len()];
    for &(a, b) in hard {
        directions[a].push(unit(sub(vertices[b].p, vertices[a].p)));
        directions[b].push(unit(sub(vertices[a].p, vertices[b].p)));
    }
    for (i, v) in vertices.iter_mut().enumerate() {
        v.curve = [0.; 3];
        v.fixed = false;
        v.locked = false;
        v.position_constraint = !directions[i].is_empty();
        if !directions[i].is_empty() {
            v.curve = directions[i][0];
            // Keep geometric curve bends exact for source-segment attribution.
            // Collinear runs can resample; locked endpoints remain exact below.
            v.fixed =
                directions[i].len() != 2 || dot(directions[i][0], directions[i][1]) > -1.0 + 1e-10;
            if directions[i].len() == 2 && !v.fixed {
                v.curve = unit(sub(directions[i][0], directions[i][1]));
            }
        }
    }
    for &(a, b) in locked {
        for i in [a, b] {
            vertices[i].fixed = true;
            vertices[i].locked = true;
            vertices[i].position_constraint = true;
        }
    }
}

fn set_directions(vertices: &mut [Vertex], edges: &BTreeSet<(usize, usize)>) {
    let mut neighbours = vec![Vec::new(); vertices.len()];
    for &(a, b) in edges {
        neighbours[a].push(b);
        neighbours[b].push(a);
    }
    for i in 0..vertices.len() {
        let ns = &neighbours[i];
        if ns.is_empty() {
            continue;
        }
        let a = unit(sub(vertices[ns[0]].p, vertices[i].p));
        let b = if ns.len() == 2 {
            unit(sub(vertices[ns[1]].p, vertices[i].p))
        } else {
            a
        };
        // Branch junctions have no unique preferred seam direction. Keep their
        // geometry for attribute wedges, but let the surrounding cross field choose.
        vertices[i].direction = if ns.len() == 2 {
            unit(sub(a, b))
        } else {
            [0.; 3]
        };
        // A seam bend must retain its geometric corner even when it lies
        // on a detected crease; otherwise wedge recognition loses that seam.
        vertices[i].fixed |= ns.len() != 2 || dot(a, b) > -1.0 + 1e-10;
        if !vertices[i].position_constraint {
            vertices[i].curve = if ns.len() == 2 { unit(sub(a, b)) } else { a };
            vertices[i].fixed = ns.len() != 2 || dot(a, b) > -1.0 + 1e-10;
        }
    }
}

fn refine(
    vertices: &mut Vec<Vertex>,
    faces: &mut Vec<Face>,
    hard: &mut BTreeSet<(usize, usize)>,
    directions: &mut BTreeSet<(usize, usize)>,
    locked: &BTreeSet<(usize, usize)>,
    h: f64,
    max_faces: usize,
) -> Result<(), String> {
    for _ in 0..12 {
        let e = edges(faces)?;
        let mut split = BTreeMap::new();
        for edge in e {
            if vertices[edge.a].locked
                || vertices[edge.b].locked
                || norm(sub(vertices[edge.a].p, vertices[edge.b].p)) <= h * 0.9
                || locked.contains(&(edge.a, edge.b))
            {
                continue;
            }
            let mut v = vertices[edge.a].clone();
            v.p = mul(add(vertices[edge.a].p, vertices[edge.b].p), 0.5);
            v.q = v.p;
            v.fixed = false;
            v.locked = false;
            let index = vertices.len();
            vertices.push(v);
            split.insert((edge.a, edge.b), index);
            if directions.remove(&(edge.a, edge.b)) {
                directions.insert(pair(edge.a, index));
                directions.insert(pair(edge.b, index));
            }
            if hard.remove(&(edge.a, edge.b)) {
                hard.insert(pair(edge.a, index));
                hard.insert(pair(edge.b, index));
            }
        }
        if split.is_empty() {
            return Ok(());
        }
        let limit = MAX_WORK_FACES.min(max_faces.saturating_mul(16).max(faces.len()));
        if faces.len().saturating_add(split.len() * 2) > limit {
            return Err("remesh_quad: field sampling exceeds the 2000000-triangle work budget; increase target_length".into());
        }
        let mut refined = Vec::with_capacity(faces.len() + split.len() * 2);
        for f in faces.iter().filter(|f| f.alive) {
            let [a, b, c] = f.v;
            let m = [
                split.get(&pair(a, b)).copied(),
                split.get(&pair(b, c)).copied(),
                split.get(&pair(c, a)).copied(),
            ];
            let mut push = |v| refined.push(Face { v, alive: true });
            match m.iter().filter(|v| v.is_some()).count() {
                0 => push(f.v),
                1 => {
                    let k = m.iter().position(|v| v.is_some()).unwrap_or(0);
                    let a = f.v[k];
                    let b = f.v[(k + 1) % 3];
                    let c = f.v[(k + 2) % 3];
                    let mid = m[k].unwrap_or(a);
                    push([a, mid, c]);
                    push([mid, b, c]);
                }
                2 => {
                    let k = m.iter().position(|v| v.is_none()).unwrap_or(0);
                    let a = f.v[k];
                    let b = f.v[(k + 1) % 3];
                    let c = f.v[(k + 2) % 3];
                    let x = m[(k + 1) % 3].unwrap_or(b);
                    let y = m[(k + 2) % 3].unwrap_or(c);
                    push([a, b, x]);
                    push([a, x, y]);
                    push([y, x, c]);
                }
                _ => {
                    let x = m[0].unwrap_or(a);
                    let y = m[1].unwrap_or(b);
                    let z = m[2].unwrap_or(c);
                    push([a, x, z]);
                    push([x, b, y]);
                    push([z, y, c]);
                    push([x, y, z]);
                }
            }
        }
        *faces = refined;
    }
    Err("remesh_quad: target length requires more than 12 refinement levels; increase it".into())
}

mod field;
use field::{nearby, solve_fields, transport};

fn star(i: usize, incident: &[Vec<usize>], faces: &[Face], result: &mut Vec<usize>) {
    result.clear();
    for &f in &incident[i] {
        if faces[f].alive {
            for &v in &faces[f].v {
                if v != i {
                    result.push(v);
                }
            }
        }
    }
    result.sort_unstable();
    result.dedup();
}

fn lattice_error(a: &Vertex, b: &Vertex, h: f64) -> f64 {
    let d = sub(b.q, a.q);
    let v = cross(a.n, a.u);
    let x = dot(d, a.u) / h;
    let y = dot(d, v) / h;
    x.abs().max(y.abs())
}

fn contract(
    vertices: &mut [Vertex],
    faces: &mut [Face],
    input_hard: &BTreeSet<(usize, usize)>,
    h: f64,
    projector: &Projector,
) -> BTreeSet<(usize, usize)> {
    let mut hard = input_hard.clone();
    let mut incident = vec![Vec::new(); vertices.len()];
    for (i, f) in faces.iter().enumerate().filter(|(_, f)| f.alive) {
        for &v in &f.v {
            incident[v].push(i);
        }
    }
    let mut mass = vec![1.0; vertices.len()];
    let mut hints = vec![NONE; vertices.len()];
    let mut na = Vec::with_capacity(32);
    let mut nb = Vec::with_capacity(32);
    let mut both = Vec::with_capacity(4);
    let mut touched = Vec::with_capacity(32);
    let mut surviving = Vec::with_capacity(32);
    for _ in 0..5 {
        let Ok(mesh_edges) = edges(faces) else { break };
        let mut candidates: Vec<_> = mesh_edges
            .iter()
            .map(|e| (lattice_error(&vertices[e.a], &vertices[e.b], h), e.a, e.b))
            .filter(|c| c.0 < 0.52)
            .collect();
        candidates
            .sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
        let mut collapsed = 0;
        for (_, mut a, mut b) in candidates {
            if !vertices[a].alive
                || !vertices[b].alive
                || lattice_error(&vertices[a], &vertices[b], h) >= 0.52
            {
                continue;
            }
            if vertices[a].locked || vertices[b].locked || (vertices[a].fixed && vertices[b].fixed)
            {
                continue;
            }
            let ca = norm(vertices[a].curve) > 0.0;
            let cb = norm(vertices[b].curve) > 0.0;
            if ca && cb && !hard.contains(&pair(a, b)) {
                continue;
            }
            if vertices[b].fixed || (!ca && cb) {
                std::mem::swap(&mut a, &mut b);
            }
            star(a, &incident, faces, &mut na);
            star(b, &incident, faces, &mut nb);
            if !na.contains(&b) {
                continue;
            }
            let common = na.iter().filter(|v| nb.binary_search(v).is_ok()).count();
            both.clear();
            for &f in &incident[a] {
                if faces[f].alive && faces[f].v.contains(&a) && faces[f].v.contains(&b) {
                    both.push(f);
                }
            }
            both.sort_unstable();
            both.dedup();
            if common != both.len() || both.is_empty() {
                continue;
            }
            // A boundary edge can contract only along its boundary curve. A
            // free interior edge joining two boundary vertices is prohibited.
            if both.len() == 1 && !(ca && cb) {
                continue;
            }
            let fixed = vertices[a].fixed;
            let q = if fixed || norm(vertices[a].curve) > 0.0 {
                vertices[a].q
            } else {
                mul(
                    add(mul(vertices[a].q, mass[a]), mul(vertices[b].q, mass[b])),
                    1.0 / (mass[a] + mass[b]),
                )
            };
            let mut p = if fixed || norm(vertices[a].curve) > 0.0 {
                vertices[a].p
            } else {
                mul(
                    add(mul(vertices[a].p, mass[a]), mul(vertices[b].p, mass[b])),
                    1.0 / (mass[a] + mass[b]),
                )
            };
            if !fixed {
                p = if norm(vertices[a].curve) > 0.0 {
                    projector.curve(p)
                } else {
                    let hit = projector.closest_hint(p, hints[a]);
                    hints[a] = hit.1;
                    hit.0
                };
            }
            touched.clear();
            touched.extend_from_slice(&incident[a]);
            touched.extend_from_slice(&incident[b]);
            touched.sort_unstable();
            touched.dedup();
            let mut valid = true;
            surviving.clear();
            for &f in &touched {
                let face = &faces[f];
                if !face.alive || both.contains(&f) {
                    continue;
                }
                let mut key = face.v.map(|v| if v == b { a } else { v });
                key.sort_unstable();
                if surviving.contains(&key) {
                    valid = false;
                    break;
                }
                surviving.push(key);
                let before = face_normal(face, vertices);
                let ps = face
                    .v
                    .map(|v| if v == a || v == b { p } else { vertices[v].p });
                let after = cross(sub(ps[1], ps[0]), sub(ps[2], ps[0]));
                if dot(before, after) <= 0.05 * norm(before) * norm(after)
                    || norm(after) < h * h * 1e-10
                {
                    valid = false;
                    break;
                }
            }
            if !valid {
                continue;
            }
            for &f in &touched {
                if both.contains(&f) {
                    faces[f].alive = false;
                    continue;
                }
                for v in &mut faces[f].v {
                    if *v == b {
                        *v = a;
                    }
                }
            }
            for &n in &nb {
                if hard.remove(&pair(b, n)) && n != a {
                    hard.insert(pair(a, n));
                }
            }
            vertices[a].p = p;
            vertices[a].q = q;
            vertices[a].n = unit(add(
                mul(vertices[a].n, mass[a]),
                mul(vertices[b].n, mass[b]),
            ));
            vertices[a].u = unit(tangent(vertices[a].u, vertices[a].n));
            mass[a] += mass[b];
            vertices[b].alive = false;
            incident[a].clear();
            incident[a].extend_from_slice(&touched);
            incident[b].clear();
            collapsed += 1;
        }
        if collapsed == 0 {
            break;
        }
    }
    hard
}

fn relax_polygons(
    vertices: &mut [Vertex],
    polygons: &[Vec<usize>],
    projector: &Projector,
    h: f64,
    iterations: u32,
) {
    let mut neighbours = vec![Vec::new(); vertices.len()];
    let mut incident = vec![Vec::new(); vertices.len()];
    for (f, p) in polygons.iter().enumerate() {
        for k in 0..p.len() {
            let a = p[k];
            let b = p[(k + 1) % p.len()];
            neighbours[a].push(b);
            neighbours[b].push(a);
            incident[a].push(f);
        }
    }
    for n in &mut neighbours {
        n.sort_unstable();
        n.dedup();
    }
    let mut before = Vec::with_capacity(16);
    let mut hints = vec![NONE; vertices.len()];
    for _ in 0..iterations {
        for i in 0..vertices.len() {
            let v = &vertices[i];
            if !v.alive || v.fixed || neighbours[i].is_empty() {
                continue;
            }
            let mean = mul(
                neighbours[i]
                    .iter()
                    .fold([0.; 3], |s, &j| add(s, vertices[j].p)),
                1.0 / neighbours[i].len() as f64,
            );
            let mut delta = tangent(sub(mean, v.p), v.n);
            if norm(v.curve) > 0.0 {
                delta = mul(v.curve, dot(delta, v.curve));
            }
            let candidate = add(v.p, mul(delta, 0.35));
            let p = if norm(v.curve) > 0.0 {
                projector.curve(candidate)
            } else {
                let hit = projector.closest_hint(candidate, hints[i]);
                hints[i] = hit.1;
                hit.0
            };
            if norm(sub(p, v.p)) > h * 0.5 {
                continue;
            }
            before.clear();
            before.extend(
                incident[i]
                    .iter()
                    .map(|&f| polygon_normal(&polygons[f], vertices)),
            );
            let old = vertices[i].p;
            vertices[i].p = p;
            let good = incident[i].iter().enumerate().all(|(k, &f)| {
                let n = polygon_normal(&polygons[f], vertices);
                dot(n, before[k]) > 0.1 * norm(n) * norm(before[k])
                    && norm(n) > h * h * 1e-10
                    && (0..polygons[f].len()).all(|j| {
                        let p = &polygons[f];
                        let a = vertices[p[j]].p;
                        let b = vertices[p[(j + 1) % p.len()]].p;
                        let c = vertices[p[(j + 2) % p.len()]].p;
                        dot(cross(sub(b, a), sub(c, b)), n) > 0.0
                    })
            });
            if !good {
                vertices[i].p = old;
            }
        }
    }
}

fn finish(
    vertices: &[Vertex],
    polygons: &[Vec<usize>],
    projector: &Projector,
    h: f64,
) -> Result<QuadMesh, String> {
    if polygons.is_empty() {
        return Err("remesh_quad: extraction produced no surface; decrease target length".into());
    }
    let mut remap = vec![NONE; vertices.len()];
    let mut used = vec![false; vertices.len()];
    for p in polygons {
        for &v in p {
            used[v] = true;
        }
    }
    let mut positions = Vec::new();
    let mut source_triangle = Vec::new();
    let mut barycentric = Vec::new();
    for (i, v) in vertices.iter().enumerate() {
        if used[i] {
            remap[i] = positions.len() / 3;
            positions.extend_from_slice(&v.p);
            let (_, tri, bary) = projector.closest(v.p);
            source_triangle.push(tri as u32);
            barycentric.extend_from_slice(&bary);
        }
    }
    let mut prim_start = vec![0];
    let mut vertex_point = Vec::new();
    let mut src_prim = Vec::new();
    let mut all_edges = Vec::with_capacity(polygons.len() * 4);
    let mut face_keys = BTreeSet::new();
    let mut planarity_mean: f64 = 0.0;
    let mut planarity_max: f64 = 0.0;
    for p in polygons {
        let mut key = p.clone();
        key.sort_unstable();
        if p.len() < 3 || key.windows(2).any(|w| w[0] == w[1]) || !face_keys.insert(key) {
            return Err("remesh_quad: extraction produced a duplicate or collapsed polygon; decrease target length".into());
        }
        if p.iter()
            .any(|&v| vertices[v].p.iter().any(|x| !x.is_finite()))
            || norm(polygon_normal(p, vertices)) < h * h * 1e-12
        {
            return Err(
                "remesh_quad: extraction produced a degenerate polygon; decrease target length"
                    .into(),
            );
        }
        let mut center = [0.; 3];
        for &v in p {
            vertex_point.push(remap[v] as u32);
            center = add(center, vertices[v].p);
        }
        center = mul(center, 1.0 / p.len() as f64);
        src_prim.push(projector.closest(center).1 as i32);
        prim_start.push(vertex_point.len() as u32);
        let n = unit(polygon_normal(p, vertices));
        let mut deviation: f64 = 0.0;
        for k in 0..p.len() {
            deviation = deviation.max(dot(sub(vertices[p[k]].p, center), n).abs());
            let (a, b) = pair(p[k], p[(k + 1) % p.len()]);
            all_edges.push((a, b, if p[k] == a { 1 } else { -1 }));
        }
        planarity_mean += deviation;
        planarity_max = planarity_max.max(deviation);
    }
    let mut valence = vec![0; vertices.len()];
    let mut boundary = vec![false; vertices.len()];
    let mut minimum = f64::INFINITY;
    let mut maximum: f64 = 0.0;
    let mut sum = 0.0;
    all_edges.sort_unstable();
    let mut i = 0;
    let mut edge_count = 0;
    while i < all_edges.len() {
        let (a, b, _) = all_edges[i];
        let mut end = i + 1;
        while end < all_edges.len() && (all_edges[end].0, all_edges[end].1) == (a, b) {
            end += 1;
        }
        let count = end - i;
        let direction = all_edges[i..end].iter().map(|e| e.2).sum::<i32>();
        i = end;
        edge_count += 1;
        if count > 2 {
            return Err(
                "remesh_quad: extraction produced a non-manifold edge; use a smaller target length"
                    .into(),
            );
        }
        if count == 2 && direction != 0 {
            return Err(
                "remesh_quad: extraction produced inconsistent winding; decrease target length"
                    .into(),
            );
        }
        valence[a] += 1;
        valence[b] += 1;
        if count == 1 {
            boundary[a] = true;
            boundary[b] = true;
        }
        let length = norm(sub(vertices[a].p, vertices[b].p));
        minimum = minimum.min(length);
        maximum = maximum.max(length);
        sum += length;
    }
    let singularities = (0..vertices.len())
        .filter(|&v| used[v] && !boundary[v] && valence[v] != 4)
        .count() as u32;
    let quality = QuadQuality {
        quad_fraction: polygons.iter().filter(|p| p.len() == 4).count() as f64
            / polygons.len() as f64,
        singularities,
        irregular_fraction: singularities as f64 / (positions.len() / 3) as f64,
        edge_length_min: minimum,
        edge_length_mean: sum / edge_count as f64,
        edge_length_max: maximum,
        planarity_mean: planarity_mean / polygons.len() as f64,
        planarity_max,
        target_edge_length: h,
    };
    Ok(QuadMesh {
        positions,
        prim_start,
        vertex_point,
        source_triangle,
        barycentric,
        src_prim,
        quality,
    })
}
