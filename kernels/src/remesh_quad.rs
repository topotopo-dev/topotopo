//! Intrinsic, deterministic field-guided quad-dominant remeshing.
//!
//! The hierarchy and local frame/translation compatibility solve follow the
//! ideas of Jakob et al. (2015), implemented independently. Extraction is a
//! conservative quotient of the triangle graph: zero lattice translations are
//! contracted subject to the manifold link condition; diagonals are dissolved.
//! Extraction lacks the reference implementation's extensive topology cleanup
//! and singularity relocation, so difficult fields retain irregular vertices.

use std::collections::{BTreeMap, BTreeSet};

mod project;
use project::Projector;
mod defects;
use defects::DefectTree;
mod translation;

type V3 = [f64; 3];
const NONE: usize = usize::MAX;
const MAX_WORK_FACES: usize = 2_000_000;

#[derive(Clone, Debug)]
pub struct RemeshOptions {
    pub target_edge_length: f64,
    pub target_face_count: u32,
    pub quad_only: bool,
    /// Radians. Zero disables automatic sharp-edge detection.
    pub feature_angle: f64,
    pub align_boundaries: bool,
    pub smooth_iterations: u32,
    pub preserve_sharp: bool,
    /// Paired input point indices defining hard alignment curves.
    pub crease_edges: Vec<u32>,
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
            feature_angle: std::f64::consts::FRAC_PI_4,
            align_boundaries: true,
            smooth_iterations: 8,
            preserve_sharp: true,
            crease_edges: Vec::new(),
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
    libm::sqrt(dot(a, a))
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

fn adjacency(n: usize, e: &[Edge]) -> Vec<Vec<usize>> {
    let mut result = vec![Vec::new(); n];
    for edge in e {
        result[edge.a].push(edge.b);
        result[edge.b].push(edge.a);
    }
    result
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
    validate(positions, tris, options)?;
    let mut vertices: Vec<Vertex> = positions
        .chunks_exact(3)
        .map(|p| Vertex {
            p: [p[0], p[1], p[2]],
            n: [0.; 3],
            u: [0.; 3],
            q: [p[0], p[1], p[2]],
            curve: [0.; 3],
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
    let locked: BTreeSet<_> = options
        .locked_edges
        .chunks_exact(2)
        .map(|p| pair(p[0] as usize, p[1] as usize))
        .collect();
    let existing: BTreeSet<_> = mesh_edges.iter().map(|e| (e.a, e.b)).collect();
    if hard
        .iter()
        .chain(locked.iter())
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
        .iter()
        .map(|&(a, b)| (vertices[a].p, vertices[b].p))
        .collect();
    let projector = Projector::new(positions, tris, &segments);
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
    // A quotient needs more than one input sample per output cell. Adaptive
    // conforming edge splits leave all explicitly locked borders unchanged.
    // Smooth unconstrained surfaces can solve coarsely before one uniform quad
    // split. Pinned feature curves need the requested sampling already here:
    // a coarse parent face beside a densely sampled curve can fold on projection.
    let work_length = if options.quad_only && hard.is_empty() {
        length * 2.0
    } else {
        length
    };
    refine(
        &mut vertices,
        &mut faces,
        &mut hard,
        &locked,
        work_length,
        options.max_faces as usize,
    )?;
    mesh_edges = edges(&faces)?;
    normals(&mut vertices, &faces);
    set_constraints(&mut vertices, &hard, &locked);
    solve_fields(
        &mut vertices,
        &mesh_edges,
        work_length,
        options.smooth_iterations,
    );
    translation::repair(&mut vertices, &faces, &mesh_edges, &hard, work_length)?;
    let hard = contract(&mut vertices, &mut faces, &hard, work_length, &projector);
    mesh_edges = edges(&faces)?;
    let mut polygons = extract(&vertices, &faces, &mesh_edges, &hard, work_length);
    if options.quad_only {
        // Condition the parents before inserting projected edge/face points.
        // Ordinary quad-dominant extraction already uses the repaired lattice.
        relax_polygons(&mut vertices, &polygons, &projector, work_length, 3);
        pair_residual_triangles(&vertices, &mut polygons, &hard, work_length);
        improve_topology(&vertices, &mut polygons, &hard, work_length);
        quad_subdivide(
            &mut vertices,
            &mut polygons,
            &projector,
            &hard,
            &locked,
            options.max_faces as usize,
        )?;
    }
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
    finish(&vertices, &polygons, &projector, length)
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
        if !directions[i].is_empty() {
            v.curve = directions[i][0];
            // Preserve the exact piecewise-linear hard curve: a contraction
            // across even a small bend would replace two segments by a chord,
            // crossing a UV/material seam. Straight runs can be resampled.
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
        }
    }
}

fn refine(
    vertices: &mut Vec<Vertex>,
    faces: &mut Vec<Face>,
    hard: &mut BTreeSet<(usize, usize)>,
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
                || norm(sub(vertices[edge.a].p, vertices[edge.b].p)) <= h * 0.8
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

struct Level {
    vertices: Vec<Vertex>,
    neighbours: Vec<Vec<usize>>,
    parent: Vec<usize>,
}

/// Minimal rotation transports a tangent vector without introducing a global
/// coordinate-chart seam. The four equivalent representatives are then matched.
fn transport(v: V3, from: V3, to: V3) -> V3 {
    let c = dot(from, to);
    let k = cross(from, to);
    if c > -0.999999 {
        add(
            add(v, cross(k, v)),
            mul(cross(k, cross(k, v)), 1.0 / (1.0 + c)),
        )
    } else {
        tangent(v, to)
    }
}
fn compatible(u: V3, n: V3, reference: V3) -> V3 {
    let v = cross(n, u);
    let a = dot(u, reference);
    let b = dot(v, reference);
    if a.abs() >= b.abs() {
        mul(u, if a < 0.0 { -1.0 } else { 1.0 })
    } else {
        mul(v, if b < 0.0 { -1.0 } else { 1.0 })
    }
}
fn nearby(q: V3, reference: V3, u: V3, n: V3, h: f64) -> V3 {
    let v = cross(n, u);
    let d = sub(q, reference);
    sub(
        sub(q, mul(u, h * libm::round(dot(d, u) / h))),
        mul(v, h * libm::round(dot(d, v) / h)),
    )
}

fn solve_fields(vertices: &mut [Vertex], mesh_edges: &[Edge], h: f64, iterations: u32) {
    let mut levels = vec![Level {
        vertices: vertices.to_vec(),
        neighbours: adjacency(vertices.len(), mesh_edges),
        parent: Vec::new(),
    }];
    while levels.last().is_some_and(|l| l.vertices.len() > 32) && levels.len() < 12 {
        let last = levels.len() - 1;
        let fine = &levels[last];
        let mut parent = vec![NONE; fine.vertices.len()];
        let mut coarse = Vec::new();
        for i in 0..fine.vertices.len() {
            if parent[i] != NONE {
                continue;
            }
            let v = &fine.vertices[i];
            let mut chosen = NONE;
            let mut best = f64::INFINITY;
            if !v.fixed {
                for &j in &fine.neighbours[i] {
                    let w = &fine.vertices[j];
                    if parent[j] != NONE
                        || w.fixed
                        || dot(v.n, w.n) < 0.25
                        || (norm(v.curve) > 0.0) != (norm(w.curve) > 0.0)
                    {
                        continue;
                    }
                    let d = dot(sub(v.p, w.p), sub(v.p, w.p));
                    if d < best {
                        best = d;
                        chosen = j;
                    }
                }
            }
            let index = coarse.len();
            parent[i] = index;
            let mut out = v.clone();
            if chosen != NONE {
                parent[chosen] = index;
                let w = &fine.vertices[chosen];
                out.p = mul(add(v.p, w.p), 0.5);
                out.n = unit(add(v.n, w.n));
                out.q = out.p;
                out.u = axis(out.n);
            }
            coarse.push(out);
        }
        if coarse.len() * 10 > fine.vertices.len() * 9 {
            break;
        }
        let mut coarse_edges = Vec::new();
        for (i, ns) in fine.neighbours.iter().enumerate() {
            for &j in ns {
                if parent[i] != parent[j] {
                    coarse_edges.push(pair(parent[i], parent[j]));
                }
            }
        }
        coarse_edges.sort_unstable();
        coarse_edges.dedup();
        let mut neighbours = vec![Vec::new(); coarse.len()];
        for (a, b) in coarse_edges {
            neighbours[a].push(b);
            neighbours[b].push(a);
        }
        levels[last].parent = parent;
        levels.push(Level {
            vertices: coarse,
            neighbours,
            parent: Vec::new(),
        });
    }
    for level in (0..levels.len()).rev() {
        if level + 1 < levels.len() {
            let (fine, coarse) = levels.split_at_mut(level + 1);
            let fine = &mut fine[level];
            let coarse = &coarse[0];
            for (i, v) in fine.vertices.iter_mut().enumerate() {
                let c = &coarse.vertices[fine.parent[i]];
                v.u = unit(transport(c.u, c.n, v.n));
                if norm(v.u) == 0.0 {
                    v.u = axis(v.n);
                }
                v.q = add(v.p, tangent(sub(c.q, v.p), v.n));
                v.q = nearby(v.q, v.p, v.u, v.n, h);
            }
        }
        let l = &mut levels[level];
        let seeds: Vec<_> = l.vertices.iter().map(|v| axis(v.n)).collect();
        for _ in 0..iterations.max(1) {
            for (i, &seed) in seeds.iter().enumerate() {
                let v = &l.vertices[i];
                let n = v.n;
                let mut sum = mul(compatible(seed, n, v.u), l.neighbours[i].len() as f64 * 0.5);
                for &j in &l.neighbours[i] {
                    let w = &l.vertices[j];
                    let t = unit(transport(w.u, w.n, n));
                    sum = add(sum, compatible(t, n, v.u));
                }
                let direction = if norm(v.curve) > 0.0 {
                    unit(tangent(v.curve, n))
                } else {
                    unit(tangent(sum, n))
                };
                if norm(direction) > 0.0 {
                    l.vertices[i].u = direction;
                }
            }
        }
        for _ in 0..(iterations.max(1) * 4) {
            for i in 0..l.vertices.len() {
                let v = &l.vertices[i];
                if v.fixed {
                    l.vertices[i].q = v.p;
                    continue;
                }
                let mut sum = v.q;
                let mut weight = 1.0;
                for &j in &l.neighbours[i] {
                    let w = &l.vertices[j];
                    let q = nearby(w.q, v.q, w.u, w.n, h);
                    let q = add(v.p, tangent(sub(q, v.p), v.n));
                    sum = add(sum, q);
                    weight += 1.0;
                }
                let mut q = add(v.p, tangent(sub(mul(sum, 1.0 / weight), v.p), v.n));
                if norm(v.curve) > 0.0 {
                    q = add(v.p, mul(v.curve, dot(sub(q, v.p), v.curve)));
                }
                l.vertices[i].q = nearby(q, v.p, v.u, v.n, h);
            }
        }
    }
    for (v, f) in vertices.iter_mut().zip(&levels[0].vertices) {
        v.u = f.u;
        v.q = f.q;
    }
}

fn star(i: usize, incident: &[Vec<usize>], faces: &[Face]) -> Vec<usize> {
    let mut result = Vec::new();
    for &f in &incident[i] {
        if faces[f].alive && faces[f].v.contains(&i) {
            for &v in &faces[f].v {
                if v != i {
                    result.push(v);
                }
            }
        }
    }
    result.sort_unstable();
    result.dedup();
    result
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
            let na = star(a, &incident, faces);
            let nb = star(b, &incident, faces);
            if !na.contains(&b) {
                continue;
            }
            let common: Vec<_> = na
                .iter()
                .filter(|v| nb.binary_search(v).is_ok())
                .copied()
                .collect();
            let mut both = Vec::new();
            for &f in &incident[a] {
                if faces[f].alive && faces[f].v.contains(&a) && faces[f].v.contains(&b) {
                    both.push(f);
                }
            }
            both.sort_unstable();
            both.dedup();
            if common.len() != both.len() || both.is_empty() {
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
                    projector.closest(p).0
                };
            }
            let mut touched = incident[a].clone();
            touched.extend_from_slice(&incident[b]);
            touched.sort_unstable();
            touched.dedup();
            let mut valid = true;
            let mut surviving = BTreeSet::new();
            for &f in &touched {
                let face = &faces[f];
                if !face.alive || both.contains(&f) {
                    continue;
                }
                let mut key = face.v.map(|v| if v == b { a } else { v });
                key.sort_unstable();
                if !surviving.insert(key) {
                    valid = false;
                    break;
                }
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
            incident[a] = touched;
            incident[b].clear();
            collapsed += 1;
        }
        if collapsed == 0 {
            break;
        }
    }
    hard
}

fn quad_for(e: &Edge, faces: &[Face]) -> [usize; 4] {
    let f = &faces[e.f];
    let g = &faces[e.g];
    for k in 0..3 {
        let a = f.v[k];
        let b = f.v[(k + 1) % 3];
        if pair(a, b) == (e.a, e.b) {
            let c = f.v[(k + 2) % 3];
            let d = g.v.iter().copied().find(|&v| v != a && v != b).unwrap_or(a);
            return [a, d, b, c];
        }
    }
    [0; 4]
}
fn polygon_normal(poly: &[usize], vertices: &[Vertex]) -> V3 {
    let p = vertices[poly[0]].p;
    let mut n = [0.; 3];
    for k in 1..poly.len() - 1 {
        n = add(
            n,
            cross(sub(vertices[poly[k]].p, p), sub(vertices[poly[k + 1]].p, p)),
        );
    }
    n
}
fn quad_score(q: &[usize; 4], vertices: &[Vertex], h: f64) -> Option<f64> {
    let n = unit(polygon_normal(q, vertices));
    if norm(n) == 0.0 {
        return None;
    }
    let mut score = 0.0;
    for k in 0..4 {
        let a = &vertices[q[k]];
        let b = &vertices[q[(k + 1) % 4]];
        let c = &vertices[q[(k + 2) % 4]];
        let e = sub(b.p, a.p);
        let f = sub(c.p, b.p);
        let le = norm(e);
        let lf = norm(f);
        if le < h * 1e-6 || lf < h * 1e-6 || dot(cross(e, f), n) < 0.02 * le * lf {
            return None;
        }
        let t = unit(e);
        let align = dot(t, a.u).abs().max(dot(t, cross(a.n, a.u)).abs());
        score += (1.0 - align) * 3.0
            + (le / h - 1.0) * (le / h - 1.0) * 0.2
            + dot(e, f).abs() / (le * lf) * 0.5;
    }
    Some(score)
}

fn extract(
    vertices: &[Vertex],
    faces: &[Face],
    mesh_edges: &[Edge],
    hard: &BTreeSet<(usize, usize)>,
    h: f64,
) -> Vec<Vec<usize>> {
    let mut candidates = Vec::new();
    let mut by_face = vec![Vec::new(); faces.len()];
    for e in mesh_edges {
        if e.g == NONE || hard.contains(&(e.a, e.b)) {
            continue;
        }
        let q = quad_for(e, faces);
        if let Some(score) = quad_score(&q, vertices, h) {
            candidates.push((score, e.f, e.g, q));
        }
    }
    candidates.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut matched = vec![NONE; faces.len()];
    for (index, c) in candidates.iter().enumerate() {
        by_face[c.1].push(index);
        by_face[c.2].push(index);
        if matched[c.1] == NONE && matched[c.2] == NONE {
            matched[c.1] = index;
            matched[c.2] = index;
        }
    }
    // Deterministic length-three augmenting paths reduce residual triangles
    // without ever dissolving a nonconvex or hard edge.
    for _ in 0..3 {
        let mut changed = false;
        for f in 0..faces.len() {
            if !faces[f].alive || matched[f] != NONE {
                continue;
            }
            'search: for &a in &by_face[f] {
                let ca = &candidates[a];
                let g = if ca.1 == f { ca.2 } else { ca.1 };
                if matched[g] == NONE {
                    matched[f] = a;
                    matched[g] = a;
                    changed = true;
                    break;
                }
                let old = matched[g];
                let cb = &candidates[old];
                let other = if cb.1 == g { cb.2 } else { cb.1 };
                for &b in &by_face[other] {
                    let cc = &candidates[b];
                    let end = if cc.1 == other { cc.2 } else { cc.1 };
                    if end != f && matched[end] == NONE {
                        matched[f] = a;
                        matched[g] = a;
                        matched[other] = b;
                        matched[end] = b;
                        changed = true;
                        break 'search;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
    let mut visited = vec![false; faces.len()];
    for f in 0..faces.len() {
        if !faces[f].alive || matched[f] != NONE {
            continue;
        }
        if let Some(path) = augment_matching(f, 7, &candidates, &by_face, &matched, &mut visited) {
            for m in path {
                let c = &candidates[m];
                matched[c.1] = m;
                matched[c.2] = m;
                visited[c.1] = false;
                visited[c.2] = false;
            }
        }
    }
    // A tetrahedron can otherwise be paired into two opposite quads containing
    // the same four vertices. Keep the original triangles in this case.
    let mut selected = BTreeMap::new();
    for f in 0..faces.len() {
        let m = matched[f];
        if m == NONE || f != candidates[m].1.min(candidates[m].2) {
            continue;
        }
        let c = &candidates[m];
        let mut key = c.3;
        key.sort_unstable();
        if let Some(other) = selected.insert(key, m) {
            let old = &candidates[other];
            matched[old.1] = NONE;
            matched[old.2] = NONE;
            matched[c.1] = NONE;
            matched[c.2] = NONE;
        }
    }
    let mut polygons = Vec::new();
    for (f, face) in faces.iter().enumerate().filter(|(_, f)| f.alive) {
        let m = matched[f];
        if m == NONE {
            polygons.push(face.v.to_vec());
        } else {
            let c = &candidates[m];
            if f == c.1.min(c.2) {
                polygons.push(c.3.to_vec());
            }
        }
    }
    polygons
}

fn augment_matching(
    f: usize,
    depth: usize,
    candidates: &[(f64, usize, usize, [usize; 4])],
    by_face: &[Vec<usize>],
    matched: &[usize],
    visited: &mut [bool],
) -> Option<Vec<usize>> {
    if depth == 0 || visited[f] {
        return None;
    }
    visited[f] = true;
    for &m in &by_face[f] {
        let c = &candidates[m];
        let g = if c.1 == f { c.2 } else { c.1 };
        if visited[g] {
            continue;
        }
        if matched[g] == NONE {
            return Some(vec![m]);
        }
        visited[g] = true;
        let old = &candidates[matched[g]];
        let other = if old.1 == g { old.2 } else { old.1 };
        if let Some(mut path) =
            augment_matching(other, depth - 1, candidates, by_face, matched, visited)
        {
            path.push(m);
            return Some(path);
        }
        visited[g] = false;
    }
    visited[f] = false;
    None
}

/// The union boundary of two adjacent faces, with their common edge removed.
fn union_loop(a: &[usize], b: &[usize], edge: (usize, usize)) -> Option<Vec<usize>> {
    let mut boundary = Vec::new();
    for p in [a, b] {
        for k in 0..p.len() {
            let x = p[k];
            let y = p[(k + 1) % p.len()];
            if pair(x, y) != edge {
                boundary.push((x, y));
            }
        }
    }
    let start = boundary.first()?.0;
    let mut result = vec![start];
    let mut current = start;
    for _ in 0..boundary.len() - 1 {
        let next = boundary.iter().find(|e| e.0 == current)?.1;
        if result.contains(&next) {
            return None;
        }
        result.push(next);
        current = next;
    }
    if !boundary.contains(&(current, start)) {
        return None;
    }
    Some(result)
}

/// Move a residual triangle across neighbouring quads by a pentagon diagonal
/// change, then annihilate it with another triangle. This preserves all vertices
/// and all hard edges, avoiding global midpoint refinement in the common case.
fn pair_residual_triangles(
    vertices: &[Vertex],
    polygons: &mut Vec<Vec<usize>>,
    hard: &BTreeSet<(usize, usize)>,
    h: f64,
) {
    for _ in 0..4 {
        let mut face_keys = BTreeMap::new();
        for (f, p) in polygons.iter().enumerate() {
            let mut key = p.clone();
            key.sort_unstable();
            face_keys.insert(key, f);
        }
        let mut records = Vec::new();
        for (f, p) in polygons.iter().enumerate() {
            for k in 0..p.len() {
                let (a, b) = pair(p[k], p[(k + 1) % p.len()]);
                records.push((a, b, f));
            }
        }
        records.sort_unstable();
        let mut neighbours = vec![Vec::new(); polygons.len()];
        let mut i = 0;
        while i < records.len() {
            let (a, b, f) = records[i];
            let mut j = i + 1;
            while j < records.len() && records[j].0 == a && records[j].1 == b {
                j += 1;
            }
            if j - i == 2 && !hard.contains(&(a, b)) {
                let g = records[i + 1].2;
                neighbours[f].push((g, (a, b)));
                neighbours[g].push((f, (a, b)));
            }
            i = j;
        }
        let mut changed = 0;
        let mut touched = vec![false; polygons.len()];
        let mut previous = vec![NONE; polygons.len()];
        let mut seen = vec![NONE; polygons.len()];
        for start in 0..polygons.len() {
            if polygons[start].len() != 3 || touched[start] {
                continue;
            }
            previous[start] = start;
            seen[start] = start;
            let mut queue = vec![start];
            let mut head = 0;
            let mut end = NONE;
            while head < queue.len() && queue.len() < 512 {
                let f = queue[head];
                head += 1;
                for &(g, _) in &neighbours[f] {
                    if seen[g] == start || touched[g] || polygons[g].is_empty() {
                        continue;
                    }
                    previous[g] = f;
                    seen[g] = start;
                    queue.push(g);
                    if polygons[g].len() == 3 {
                        end = g;
                        break;
                    }
                }
                if end != NONE {
                    break;
                }
            }
            if end == NONE {
                continue;
            }
            let mut path = vec![end];
            let mut current = end;
            while current != start {
                current = previous[current];
                path.push(current);
            }
            path.reverse();
            let saved: Vec<_> = path.iter().map(|&f| polygons[f].clone()).collect();
            let mut ok = true;
            for step in 0..path.len() - 1 {
                let f = path[step];
                let g = path[step + 1];
                let Some(&(_, edge)) = neighbours[f].iter().find(|&&(n, _)| n == g) else {
                    ok = false;
                    break;
                };
                let Some(p) = union_loop(&polygons[f], &polygons[g], edge) else {
                    ok = false;
                    break;
                };
                if p.len() == 4 {
                    if valid_polygon(&p, vertices, h) {
                        polygons[f] = p;
                        polygons[g].clear();
                    } else {
                        ok = false;
                    }
                    break;
                }
                if p.len() != 5 || step + 2 >= path.len() {
                    ok = false;
                    break;
                }
                let next = path[step + 2];
                let Some(&(_, target)) = neighbours[g].iter().find(|&&(n, _)| n == next) else {
                    ok = false;
                    break;
                };
                let mut best = None;
                let mut score = f64::INFINITY;
                for k in 0..5 {
                    let tri = vec![p[k], p[(k + 1) % 5], p[(k + 2) % 5]];
                    if !(0..3).any(|j| pair(tri[j], tri[(j + 1) % 3]) == target) {
                        continue;
                    }
                    let quad = vec![p[(k + 2) % 5], p[(k + 3) % 5], p[(k + 4) % 5], p[k]];
                    let diag = pair(p[k], p[(k + 2) % 5]);
                    if records.binary_search_by(|e| (e.0, e.1).cmp(&diag)).is_ok() {
                        continue;
                    }
                    if !valid_polygon(&tri, vertices, h) || !valid_polygon(&quad, vertices, h) {
                        continue;
                    }
                    let q: [usize; 4] = [quad[0], quad[1], quad[2], quad[3]];
                    let cost = quad_score(&q, vertices, h).unwrap_or(f64::INFINITY);
                    if cost < score {
                        score = cost;
                        best = Some((tri, quad));
                    }
                }
                if let Some((tri, quad)) = best {
                    polygons[f] = quad;
                    polygons[g] = tri;
                } else {
                    ok = false;
                    break;
                }
            }
            if ok {
                let mut new_keys = BTreeSet::new();
                for &f in &path {
                    if polygons[f].is_empty() {
                        continue;
                    }
                    let mut key = polygons[f].clone();
                    key.sort_unstable();
                    if !new_keys.insert(key.clone())
                        || face_keys
                            .get(&key)
                            .is_some_and(|other| !path.contains(other))
                    {
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                for p in &saved {
                    let mut key = p.clone();
                    key.sort_unstable();
                    face_keys.remove(&key);
                }
                for &f in &path {
                    if !polygons[f].is_empty() {
                        let mut key = polygons[f].clone();
                        key.sort_unstable();
                        face_keys.insert(key, f);
                    }
                }
                for &f in &path {
                    touched[f] = true;
                }
                changed += 1;
            } else {
                for (&f, p) in path.iter().zip(saved) {
                    polygons[f] = p;
                }
            }
        }
        polygons.retain(|p| !p.is_empty());
        if changed == 0 {
            break;
        }
    }
}

fn valid_polygon(p: &[usize], vertices: &[Vertex], h: f64) -> bool {
    let n = polygon_normal(p, vertices);
    let size = norm(n);
    if size < h * h * 1e-8 {
        return false;
    }
    (0..p.len()).all(|k| {
        let a = vertices[p[k]].p;
        let b = vertices[p[(k + 1) % p.len()]].p;
        let c = vertices[p[(k + 2) % p.len()]].p;
        let e = sub(b, a);
        let f = sub(c, b);
        dot(cross(e, f), n) > 0.02 * norm(e) * norm(f) * size && norm(e) > h * 0.05
    })
}

fn improve_topology(
    vertices: &[Vertex],
    polygons: &mut [Vec<usize>],
    hard: &BTreeSet<(usize, usize)>,
    h: f64,
) {
    let mut tabu = BTreeSet::new();
    for _ in 0..24 {
        let mut edges = Vec::new();
        for (f, p) in polygons.iter().enumerate() {
            for k in 0..p.len() {
                let (a, b) = pair(p[k], p[(k + 1) % p.len()]);
                edges.push((a, b, f));
            }
        }
        edges.sort_unstable();
        let mut valence = vec![0_i32; vertices.len()];
        let mut boundary = vec![false; vertices.len()];
        let mut shared = Vec::new();
        let mut i = 0;
        while i < edges.len() {
            let (a, b, f) = edges[i];
            let mut j = i + 1;
            while j < edges.len() && edges[j].0 == a && edges[j].1 == b {
                j += 1;
            }
            valence[a] += 1;
            valence[b] += 1;
            if j - i == 1 {
                boundary[a] = true;
                boundary[b] = true;
            } else if j - i == 2 && !hard.contains(&(a, b)) {
                shared.push((a, b, f, edges[i + 1].2));
            }
            i = j;
        }
        let mut used = vec![false; polygons.len()];
        let mut changed = 0;
        let deficits: Vec<_> = (0..vertices.len())
            .filter(|&v| vertices[v].alive && !boundary[v] && valence[v] > 0 && valence[v] < 4)
            .collect();
        let deficit_tree = DefectTree::new(
            if deficits.len() < 2048 {
                &deficits
            } else {
                &[]
            },
            vertices,
        );
        for (a, b, f, g) in shared {
            if used[f] || used[g] {
                continue;
            }
            let Some(p) = union_loop(&polygons[f], &polygons[g], (a, b)) else {
                continue;
            };
            if p.len() != 6 && p.len() != 5 {
                continue;
            }
            let stride = if p.len() == 6 { 3 } else { 2 };
            let mut best = None;
            let mut best_energy = 0_i32;
            let mut best_shape = f64::INFINITY;
            let mut best_potential = -1e-8;
            for k in 0..p.len() {
                let x = p[k];
                let y = p[(k + stride) % p.len()];
                if pair(x, y) == (a, b) || tabu.contains(&pair(x, y)) {
                    continue;
                }
                // Avoid connecting already adjacent vertices: this would make
                // duplicate edges and can pinch a handle.
                if edges
                    .binary_search_by(|e| (e.0, e.1).cmp(&pair(x, y)))
                    .is_ok()
                {
                    continue;
                }
                let first: Vec<_> = (0..=stride).map(|j| p[(k + j) % p.len()]).collect();
                let second: Vec<_> = (stride..=p.len()).map(|j| p[(k + j) % p.len()]).collect();
                if !valid_polygon(&first, vertices, h) || !valid_polygon(&second, vertices, h) {
                    continue;
                }
                let mut changes = BTreeMap::<usize, i32>::new();
                *changes.entry(a).or_default() -= 1;
                *changes.entry(b).or_default() -= 1;
                *changes.entry(x).or_default() += 1;
                *changes.entry(y).or_default() += 1;
                let energy = changes
                    .iter()
                    .map(|(&v, &d)| {
                        let target = if boundary[v] { 3 } else { 4 };
                        let e = valence[v] - target;
                        (e + d) * (e + d) - e * e
                    })
                    .sum::<i32>();
                let shape = (norm(sub(vertices[x].p, vertices[y].p)) / h - 1.0).abs();
                let mut potential = 0.0;
                if energy == 0 && deficits.len() < 2048 {
                    for (&v, &change) in &changes {
                        for (after, sign) in [(false, -1.0), (true, 1.0)] {
                            let degree = valence[v] + if after { change } else { 0 };
                            if degree <= 4 || boundary[v] {
                                continue;
                            }
                            let eligible = |other: usize| {
                                let d = valence[other]
                                    + if after {
                                        *changes.get(&other).unwrap_or(&0)
                                    } else {
                                        0
                                    };
                                d > 0 && d < 4 && !boundary[other]
                            };
                            let initial =
                                deficit_tree.distance(vertices[v].p, vertices, 100.0 * h, eligible)
                                    / h;
                            let closest = changes
                                .keys()
                                .copied()
                                .filter(|&other| eligible(other))
                                .map(|other| norm(sub(vertices[v].p, vertices[other].p)) / h)
                                .fold(initial.min(100.0), f64::min);
                            potential += sign * f64::from(degree - 4) * closest;
                        }
                    }
                }
                if energy < best_energy
                    || (energy == best_energy && energy < 0 && shape < best_shape)
                    || (energy == 0 && best_energy == 0 && potential < best_potential)
                {
                    best_energy = energy;
                    best_shape = shape;
                    best_potential = potential;
                    best = Some((first, second, changes));
                }
            }
            if let Some((first, second, changes)) = best {
                tabu.insert((a, b));
                polygons[f] = first;
                polygons[g] = second;
                for (v, d) in changes {
                    valence[v] += d;
                }
                used[f] = true;
                used[g] = true;
                changed += 1;
            }
        }
        if changed == 0 {
            break;
        }
    }
}

fn quad_subdivide(
    vertices: &mut Vec<Vertex>,
    polygons: &mut Vec<Vec<usize>>,
    projector: &Projector,
    hard: &BTreeSet<(usize, usize)>,
    locked: &BTreeSet<(usize, usize)>,
    max_faces: usize,
) -> Result<(), String> {
    // Splitting a locked group border would create a T junction with the
    // untouched complement. Best effort deliberately retains these triangles.
    if !locked.is_empty() {
        return Ok(());
    }
    let count: usize = polygons.iter().map(Vec::len).sum();
    if count > max_faces {
        return Err("remesh_quad: conforming quads_only refinement exceeds max_faces; increase the guard or target length".into());
    }
    let mut edge_points = BTreeMap::new();
    let mut result = Vec::with_capacity(count);
    for p in polygons.iter() {
        let mut mids = Vec::with_capacity(p.len());
        for k in 0..p.len() {
            let a = p[k];
            let b = p[(k + 1) % p.len()];
            let key = pair(a, b);
            let mid = *edge_points.entry(key).or_insert_with(|| {
                let mut v = vertices[a].clone();
                v.p = mul(add(v.p, vertices[b].p), 0.5);
                v.fixed = false;
                v.locked = false;
                let curved = hard.contains(&key);
                v.p = if curved {
                    projector.curve(v.p)
                } else {
                    projector.closest(v.p).0
                };
                if !curved {
                    v.curve = [0.; 3];
                } else {
                    v.curve = unit(sub(vertices[b].p, vertices[a].p));
                }
                v.q = v.p;
                let index = vertices.len();
                vertices.push(v);
                index
            });
            mids.push(mid);
        }
        let center = mul(
            p.iter().fold([0.; 3], |a, &i| add(a, vertices[i].p)),
            1.0 / p.len() as f64,
        );
        let mut v = vertices[p[0]].clone();
        v.p = projector.closest(center).0;
        v.q = v.p;
        v.curve = [0.; 3];
        v.fixed = false;
        v.locked = false;
        let center = vertices.len();
        vertices.push(v);
        for k in 0..p.len() {
            result.push(vec![
                p[k],
                mids[k],
                center,
                mids[(k + p.len() - 1) % p.len()],
            ]);
        }
    }
    *polygons = result;
    Ok(())
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
                projector.closest(candidate).0
            };
            if norm(sub(p, v.p)) > h * 0.5 {
                continue;
            }
            let before: Vec<_> = incident[i]
                .iter()
                .map(|&f| polygon_normal(&polygons[f], vertices))
                .collect();
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
    let mut all_edges = BTreeMap::<(usize, usize), usize>::new();
    let mut directions = BTreeMap::<(usize, usize), i32>::new();
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
            *all_edges
                .entry(pair(p[k], p[(k + 1) % p.len()]))
                .or_default() += 1;
            *directions
                .entry(pair(p[k], p[(k + 1) % p.len()]))
                .or_default() += if p[k] < p[(k + 1) % p.len()] { 1 } else { -1 };
        }
        planarity_mean += deviation;
        planarity_max = planarity_max.max(deviation);
    }
    let mut valence = vec![0; vertices.len()];
    let mut boundary = vec![false; vertices.len()];
    let mut minimum = f64::INFINITY;
    let mut maximum: f64 = 0.0;
    let mut sum = 0.0;
    for (&(a, b), &count) in &all_edges {
        if count > 2 {
            return Err(
                "remesh_quad: extraction produced a non-manifold edge; use a smaller target length"
                    .into(),
            );
        }
        if count == 2 && directions[&(a, b)] != 0 {
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
        edge_length_min: minimum,
        edge_length_mean: sum / all_edges.len() as f64,
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
