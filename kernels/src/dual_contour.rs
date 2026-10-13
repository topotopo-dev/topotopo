//! Uniform-grid dual contouring with one QEF vertex per cell surface component.
//!
//! Shared bilinear face decisions connect the edge crossings into disjoint loops,
//! instead of collapsing unrelated sheets onto one vertex. Conservative shared
//! face/edge subdivision triangulates each dual polygon into cell-local fans:
//! clamping alone does not prevent ordinary QEF quads from self-intersecting.
//! This is a uniform contourer, not Schaefer/Ju adaptive octree clustering.

use crate::sdf::Grid;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

const NONE: u32 = u32::MAX;
const INSET: f64 = 1e-6;
const MAX_ACTIVE_CELLS: usize = 1_000_000;
const MAX_OUTPUT_VERTICES: usize = 2_000_000;
const MAX_OUTPUT_TRIANGLES: usize = 4_000_000;
const BUDGET_ERROR: &str = "dual_contour: surface exceeds the work/output budget (1000000 active cells, 2000000 vertices, 4000000 triangles); increase voxel size or blur the grid";
const ALLOCATION_ERROR: &str =
    "dual_contour: insufficient memory for the surface; increase voxel size or blur the grid";

fn check_budget(current: usize, additional: usize, limit: usize) -> Result<(), String> {
    if current.checked_add(additional).is_none_or(|n| n > limit) {
        Err(BUDGET_ERROR.into())
    } else {
        Ok(())
    }
}

fn reserve<T>(values: &mut Vec<T>, additional: usize) -> Result<(), String> {
    if additional <= values.capacity() - values.len() {
        return Ok(());
    }
    let bytes = values
        .len()
        .checked_add(additional)
        .and_then(|n| n.checked_mul(std::mem::size_of::<T>()));
    if bytes.is_none_or(|n| n > isize::MAX as usize) {
        return Err(ALLOCATION_ERROR.into());
    }
    values
        .try_reserve(additional)
        .map_err(|_| ALLOCATION_ERROR.into())
}

fn reserve_vertex(mesh: &mut DualMesh) -> Result<(), String> {
    check_budget(mesh.cell_index.len(), 1, MAX_OUTPUT_VERTICES)?;
    reserve(&mut mesh.positions, 3)?;
    reserve(&mut mesh.cell_index, 1)
}

// This map is lookup-only: output order comes exclusively from grid traversal.
// A fixed integer hash avoids randomized keys and BTreeMap's per-edge descent.
#[derive(Default)]
struct EdgeHasher(u64);
impl Hasher for EdgeHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 = (self.0 ^ u64::from(byte)).wrapping_mul(0x100000001b3);
        }
    }
    fn write_usize(&mut self, value: usize) {
        let mut value = (value as u64).wrapping_add(0x9e3779b97f4a7c15);
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d049bb133111eb);
        self.0 = value ^ (value >> 31);
    }
}
// Corner number is x + 2*y + 4*z; edges are directed along a positive axis.
const EDGES: [[usize; 2]; 12] = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
];
// Face corners and their four successive edges use the same global orientation
// from either adjacent cell, including exact saddle ties.
const FACES: [([usize; 4], [usize; 4]); 6] = [
    ([0, 2, 6, 4], [4, 10, 6, 8]),
    ([1, 3, 7, 5], [5, 11, 7, 9]),
    ([0, 1, 5, 4], [0, 9, 2, 8]),
    ([2, 3, 7, 6], [1, 11, 3, 10]),
    ([0, 1, 3, 2], [0, 5, 1, 4]),
    ([4, 5, 7, 6], [2, 7, 3, 6]),
];

#[derive(Clone, Debug, Default)]
pub struct DualMesh {
    pub positions: Vec<f64>,
    pub prim_start: Vec<u32>,
    pub vertex_point: Vec<u32>,
    /// Flattened x-fast lower grid-sample index of each vertex's source cell.
    pub cell_index: Vec<u32>,
}

#[derive(Clone, Copy, Default)]
struct Hermite {
    p: [f64; 3],
    n: [f64; 3],
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

// A negative signed zero from mesh winding represents an internal source face.
// Treating it as outside would open a crack inside overlapping closed meshes.
fn inside(v: f64) -> bool {
    v < 0. || (v == 0. && v.is_sign_negative())
}

fn crossing_fraction(a: f64, b: f64) -> f64 {
    if a == 0. && b == 0. {
        0.5
    } else {
        (a / (a - b)).clamp(0., 1.)
    }
}

fn finite_delta(a: f64, b: f64, fallback: f64) -> f64 {
    if a.is_finite() && b.is_finite() {
        a - b
    } else {
        fallback
    }
}

fn gradient(grid: &Grid, p: [usize; 3]) -> [f64; 3] {
    let strides = [
        1,
        grid.dims[0] as usize,
        grid.dims[0] as usize * grid.dims[1] as usize,
    ];
    let i = p[0] + strides[1] * p[1] + strides[2] * p[2];
    let center = f64::from(grid.values[i]);
    let mut result = [0.; 3];
    for axis in 0..3 {
        let lo = if p[axis] > 0 {
            f64::from(grid.values[i - strides[axis]])
        } else {
            center
        };
        let hi = if p[axis] + 1 < grid.dims[axis] as usize {
            f64::from(grid.values[i + strides[axis]])
        } else {
            center
        };
        // Minmod limits the finite-difference slope at a sharp feature instead
        // of averaging two unrelated one-sided slopes across a box crease.
        // At a narrow-band boundary use a finite one-sided derivative. Infinity
        // means a signed sentinel, never a numeric distance to differentiate.
        result[axis] = if lo.is_finite() && hi.is_finite() {
            if center.is_finite() && p[axis] > 0 && p[axis] + 1 < grid.dims[axis] as usize {
                let backward = center - lo;
                let forward = hi - center;
                if backward * forward <= 0. {
                    0.
                } else {
                    backward.signum() * backward.abs().min(forward.abs())
                }
            } else {
                hi - lo
            }
        } else if center.is_finite() && hi.is_finite() {
            hi - center
        } else if center.is_finite() && lo.is_finite() {
            center - lo
        } else {
            0.
        };
    }
    result
}

fn root(parent: &[usize; 12], mut i: usize) -> usize {
    while parent[i] != i {
        i = parent[i];
    }
    i
}

fn join(parent: &mut [usize; 12], a: usize, b: usize) {
    let a = root(parent, a);
    let b = root(parent, b);
    parent[a.max(b)] = a.min(b);
}

/// Connect the two crossings on an ordinary face, or use its bilinear saddle
/// (the asymptotic decider) on a checkerboard face. Decisions use only the four
/// shared samples; adjacent cells cannot disagree.
fn components(values: &[f64; 8], crossed: &[bool; 12]) -> [usize; 12] {
    let mut parent = std::array::from_fn(|i| i);
    for (corners, edges) in FACES {
        let mut selected = [0; 4];
        let mut n = 0;
        for e in edges {
            if crossed[e] {
                selected[n] = e;
                n += 1;
            }
        }
        if n == 2 {
            join(&mut parent, selected[0], selected[1]);
        } else if n == 4 {
            let a = values[corners[0]];
            let b = values[corners[1]];
            let c = values[corners[2]];
            let d = values[corners[3]];
            let scale = a.abs().max(b.abs()).max(c.abs()).max(d.abs()).max(1.);
            let determinant = (a / scale) * (c / scale) - (b / scale) * (d / scale);
            if determinant >= 0. {
                join(&mut parent, edges[0], edges[1]);
                join(&mut parent, edges[2], edges[3]);
            } else {
                join(&mut parent, edges[0], edges[3]);
                join(&mut parent, edges[1], edges[2]);
            }
        }
    }
    std::array::from_fn(|i| root(&parent, i))
}

/// Symmetric Jacobi eigensolver. All arithmetic has fixed order; libm supplies
/// the only transcendental operation, so the native and WASM paths agree.
fn pseudo_solve(mut a: [[f64; 3]; 3], b: [f64; 3], tolerance: f64) -> [f64; 3] {
    let mut v = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];
    for _ in 0..12 {
        let mut changed = false;
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            if a[p][q].abs() <= 1e-15 * (a[p][p].abs() + a[q][q].abs()).max(1.) {
                continue;
            }
            changed = true;
            let tau = (a[q][q] - a[p][p]) / (2. * a[p][q]);
            let t = if tau >= 0. { 1. } else { -1. } / (tau.abs() + libm::sqrt(1. + tau * tau));
            let c = 1. / libm::sqrt(1. + t * t);
            let s = t * c;
            let apq = a[p][q];
            a[p][p] -= t * apq;
            a[q][q] += t * apq;
            a[p][q] = 0.;
            a[q][p] = 0.;
            for r in 0..3 {
                if r != p && r != q {
                    let arp = a[r][p];
                    let arq = a[r][q];
                    a[r][p] = c * arp - s * arq;
                    a[p][r] = a[r][p];
                    a[r][q] = s * arp + c * arq;
                    a[q][r] = a[r][q];
                }
                let vrp = v[r][p];
                let vrq = v[r][q];
                v[r][p] = c * vrp - s * vrq;
                v[r][q] = s * vrp + c * vrq;
            }
        }
        if !changed {
            break;
        }
    }
    let threshold = (a[0][0].max(a[1][1]).max(a[2][2]) * tolerance * tolerance).max(1e-12);
    let mut x = [0.; 3];
    for (i, row) in a.iter().enumerate() {
        if row[i] > threshold {
            let s = (v[0][i] * b[0] + v[1][i] * b[1] + v[2][i] * b[2]) / row[i];
            for j in 0..3 {
                x[j] += v[j][i] * s;
            }
        }
    }
    x
}

fn qef(points: &[Hermite], tolerance: f64, sharp: bool, clamp: bool) -> [f64; 3] {
    let mut center = [0.; 3];
    for h in points {
        for (c, p) in center.iter_mut().zip(h.p) {
            *c += p;
        }
    }
    for c in &mut center {
        *c /= points.len() as f64;
    }
    if !sharp {
        return center;
    }
    let mut matrix = [[0.; 3]; 3];
    let mut rhs = [0.; 3];
    for h in points {
        let b = dot(h.n, std::array::from_fn(|i| h.p[i] - center[i]));
        for i in 0..3 {
            rhs[i] += h.n[i] * b;
            for (j, cell) in matrix[i].iter_mut().enumerate() {
                *cell += h.n[i] * h.n[j];
            }
        }
    }
    let delta = pseudo_solve(matrix, rhs, tolerance);
    let result = std::array::from_fn(|i| center[i] + delta[i]);
    if !clamp || result.iter().all(|x| *x >= 0. && *x <= 1.) {
        return result;
    }
    // Solve the constrained least-squares problem on all faces/edges/corners.
    // Simply clipping an unconstrained minimizer does not minimize the QEF.
    let error = |p: [f64; 3]| -> f64 {
        points
            .iter()
            .map(|h| {
                let r = dot(h.n, std::array::from_fn(|i| p[i] - h.p[i]));
                r * r
            })
            .sum()
    };
    let mut best = center;
    let mut best_error = error(best);
    for state in 1..27 {
        let mut code = state;
        let mut fixed = [false; 3];
        let mut shift = [0.; 3];
        for i in 0..3 {
            let s = code % 3;
            code /= 3;
            fixed[i] = s != 0;
            if fixed[i] {
                shift[i] = if s == 1 { -center[i] } else { 1. - center[i] };
            }
        }
        let mut a = matrix;
        let mut b = rhs;
        for i in 0..3 {
            if fixed[i] {
                a[i] = [0.; 3];
                b[i] = 0.;
            } else {
                for j in 0..3 {
                    if fixed[j] {
                        b[i] -= matrix[i][j] * shift[j];
                        a[i][j] = 0.;
                    }
                }
            }
        }
        let solution = pseudo_solve(a, b, tolerance);
        let candidate =
            std::array::from_fn(|i| center[i] + if fixed[i] { shift[i] } else { solution[i] });
        if candidate.iter().all(|x| *x >= -1e-12 && *x <= 1. + 1e-12) {
            let candidate = candidate.map(|x| x.clamp(0., 1.));
            let e = error(candidate);
            if e < best_error {
                best = candidate;
                best_error = e;
            }
        }
    }
    best
}

/// Extract a closed level set. Boundary-crossing surfaces are rejected with an
/// actionable padding error instead of returning holes. Signed infinities are
/// accepted away from the surface; every crossed edge needs finite distances.
pub fn dual_contour(
    grid: &Grid,
    iso: f64,
    qef_tolerance: f64,
    sharp: bool,
    clamp_to_cell: bool,
) -> Result<DualMesh, String> {
    grid.validate()?;
    if !iso.is_finite() {
        return Err("dual_contour: iso must be finite".into());
    }
    if !qef_tolerance.is_finite() || qef_tolerance <= 0. || qef_tolerance > 1. {
        return Err("dual_contour: qef_tolerance must be in (0, 1]".into());
    }
    let [nx, ny, nz] = grid.dims.map(|d| d as usize);
    let layer = nx * ny;
    let index = |x: usize, y: usize, z: usize| x + nx * y + layer * z;
    let negative = |i: usize| inside(f64::from(grid.values[i]) - iso);
    let boundary_sign = negative(0);
    let boundary_error = "dual_contour: level set reaches the grid boundary; enlarge the grid padding or reduce the iso/offset";
    for z in 0..nz {
        for y in 0..ny {
            if negative(index(0, y, z)) != boundary_sign
                || negative(index(nx - 1, y, z)) != boundary_sign
            {
                return Err(boundary_error.into());
            }
        }
    }
    for z in 0..nz {
        for x in 0..nx {
            if negative(index(x, 0, z)) != boundary_sign
                || negative(index(x, ny - 1, z)) != boundary_sign
            {
                return Err(boundary_error.into());
            }
        }
    }
    for y in 0..ny {
        for x in 0..nx {
            if negative(index(x, y, 0)) != boundary_sign
                || negative(index(x, y, nz - 1)) != boundary_sign
            {
                return Err(boundary_error.into());
            }
        }
    }
    let mut mesh = DualMesh {
        prim_start: vec![0],
        ..DualMesh::default()
    };
    let mut cells = Vec::<(usize, [u32; 12])>::new();
    let corner_offset = [
        0,
        1,
        nx,
        nx + 1,
        layer,
        layer + 1,
        layer + nx,
        layer + nx + 1,
    ];
    for z in 0..nz - 1 {
        for y in 0..ny - 1 {
            for x in 0..nx - 1 {
                let base = index(x, y, z);
                let sign = negative(base);
                if corner_offset.iter().all(|off| negative(base + off) == sign) {
                    continue;
                }
                check_budget(cells.len(), 1, MAX_ACTIVE_CELLS)?;
                reserve(&mut cells, 1)?;
                let values = corner_offset.map(|off| f64::from(grid.values[base + off]) - iso);
                let crossed = EDGES.map(|[a, b]| inside(values[a]) != inside(values[b]));
                let mut hermite = [Hermite::default(); 12];
                let mut gradients = [[0.; 3]; 8];
                let mut computed = [false; 8];
                for (e, [a, b]) in EDGES.into_iter().enumerate() {
                    if !crossed[e] {
                        continue;
                    }
                    if !values[a].is_finite() || !values[b].is_finite() {
                        return Err("dual_contour: a sign-changing edge has an infinite sample; increase band width or fill the grid".into());
                    }
                    let t = crossing_fraction(values[a], values[b]);
                    for c in [a, b] {
                        if !computed[c] {
                            gradients[c] = gradient(
                                grid,
                                [x + (c & 1), y + ((c >> 1) & 1), z + ((c >> 2) & 1)],
                            );
                            computed[c] = true;
                        }
                    }
                    let mut h = Hermite {
                        p: std::array::from_fn(|i| {
                            ((a >> i) & 1) as f64
                                + t * (((b >> i) & 1) as f64 - ((a >> i) & 1) as f64)
                        }),
                        n: std::array::from_fn(|i| {
                            gradients[a][i] * (1. - t) + gradients[b][i] * t
                        }),
                    };
                    let mut len = libm::sqrt(dot(h.n, h.n));
                    if len < 1e-15 {
                        // A pathological cancellation must still yield a valid
                        // plane normal in the crossing direction.
                        h.n[e / 4] = finite_delta(values[b], values[a], 1.).signum();
                        len = 1.;
                    }
                    for n in &mut h.n {
                        *n /= len;
                    }
                    hermite[e] = h;
                }
                let component = components(&values, &crossed);
                let component_count = (0..12).filter(|&i| crossed[i] && component[i] == i).count();
                let mut edge_vertex = [NONE; 12];
                for e in 0..12 {
                    if !crossed[e] || component[e] != e {
                        continue;
                    }
                    let mut h = [Hermite::default(); 12];
                    let mut n = 0;
                    for j in 0..12 {
                        if crossed[j] && component[j] == e {
                            h[n] = hermite[j];
                            n += 1;
                        }
                    }
                    // Several sheets share this voxel: each must remain near
                    // its own crossing loop instead of fitting a remote crease.
                    let p = qef(
                        &h[..n],
                        qef_tolerance,
                        sharp && component_count == 1,
                        clamp_to_cell,
                    );
                    if p.iter().any(|v| !v.is_finite() || *v < 0. || *v > 1.) {
                        return Err("dual_contour: an unconstrained QEF leaves its source cell; enable clamp_to_cell for safe extraction".into());
                    }
                    reserve_vertex(&mut mesh)?;
                    let vertex = mesh.cell_index.len() as u32;
                    for (i, coordinate) in [x, y, z].into_iter().enumerate() {
                        mesh.positions
                            .push(grid.origin[i] + (coordinate as f64 + p[i]) * grid.voxel);
                    }
                    mesh.cell_index.push(base as u32);
                    for j in 0..12 {
                        if crossed[j] && component[j] == e {
                            edge_vertex[j] = vertex;
                        }
                    }
                }
                cells.push((base, edge_vertex));
            }
        }
    }
    surface_fans(grid, iso, &cells, &mut mesh)?;
    validate_edges(&mesh)?;
    Ok(mesh)
}

// A simple loop on the boundary of a convex cell has an injective radial
// projection from an interior point. Keeping each triangle in its source cell
// prevents cross-cell folds. Separate loops use their own centroid above.
fn surface_fans(
    grid: &Grid,
    iso: f64,
    cells: &[(usize, [u32; 12])],
    mesh: &mut DualMesh,
) -> Result<(), String> {
    let nx = grid.dims[0] as usize;
    let ny = grid.dims[1] as usize;
    let layer = nx * ny;
    let offsets = [
        0,
        1,
        nx,
        nx + 1,
        layer,
        layer + 1,
        layer + nx,
        layer + nx + 1,
    ];
    let mut edge_vertices = HashMap::<usize, u32, BuildHasherDefault<EdgeHasher>>::default();
    for (vertex, &base) in mesh.cell_index.iter().enumerate() {
        let base = base as usize;
        let xyz = [base % nx, (base / nx) % ny, base / layer];
        for (axis, &coordinate) in xyz.iter().enumerate() {
            let lo = grid.origin[axis] + (coordinate as f64 + INSET) * grid.voxel;
            let hi = grid.origin[axis] + (coordinate as f64 + 1. - INSET) * grid.voxel;
            mesh.positions[vertex * 3 + axis] = mesh.positions[vertex * 3 + axis].clamp(lo, hi);
        }
    }
    mesh.prim_start = vec![0];
    mesh.vertex_point.clear();
    for &(base, edge_vertex) in cells {
        let xyz = [base % nx, (base / nx) % ny, base / layer];
        let values = offsets.map(|o| f64::from(grid.values[base + o]) - iso);
        let crossed = EDGES.map(|[a, b]| inside(values[a]) != inside(values[b]));
        let edge_keys =
            std::array::from_fn::<_, 12, _>(|e| 3 * (base + offsets[EDGES[e][0]]) + e / 4);
        let mut vertices = [NONE; 12];
        for e in 0..12 {
            if !crossed[e] {
                continue;
            }
            if let Some(&v) = edge_vertices.get(&edge_keys[e]) {
                vertices[e] = v;
                continue;
            }
            let [a, b] = EDGES[e];
            let t = crossing_fraction(values[a], values[b]).clamp(INSET, 1. - INSET);
            reserve_vertex(mesh)?;
            edge_vertices
                .try_reserve(1)
                .map_err(|_| ALLOCATION_ERROR.to_string())?;
            let v = mesh.cell_index.len() as u32;
            for (axis, &coordinate) in xyz.iter().enumerate() {
                let local = ((a >> axis) & 1) as f64
                    + t * (((b >> axis) & 1) as f64 - ((a >> axis) & 1) as f64);
                mesh.positions
                    .push(grid.origin[axis] + (coordinate as f64 + local) * grid.voxel);
            }
            mesh.cell_index.push(base as u32);
            edge_vertices.insert(edge_keys[e], v);
            vertices[e] = v;
        }
        for (corners, edges) in FACES {
            let selected: Vec<_> = edges.iter().copied().filter(|&e| crossed[e]).collect();
            let mut pairs = Vec::new();
            if selected.len() == 2 {
                pairs.push((selected[0], selected[1]));
            }
            if selected.len() == 4 {
                let [a, b, c, d] = corners.map(|c| values[c]);
                let scale = a.abs().max(b.abs()).max(c.abs()).max(d.abs()).max(1.);
                if (a / scale) * (c / scale) - (b / scale) * (d / scale) >= 0. {
                    pairs.push((edges[0], edges[1]));
                    pairs.push((edges[2], edges[3]));
                } else {
                    pairs.push((edges[0], edges[3]));
                    pairs.push((edges[1], edges[2]));
                }
            }
            for (a, b) in pairs {
                let va = vertices[a];
                let vb = vertices[b];
                let vc = edge_vertex[a];
                let p = std::array::from_fn::<_, 3, _>(|i| mesh.positions[va as usize * 3 + i]);
                let q = std::array::from_fn::<_, 3, _>(|i| mesh.positions[vb as usize * 3 + i]);
                let center =
                    std::array::from_fn::<_, 3, _>(|i| mesh.positions[vc as usize * 3 + i]);
                let u = std::array::from_fn::<_, 3, _>(|i| p[i] - center[i]);
                let v = std::array::from_fn::<_, 3, _>(|i| q[i] - center[i]);
                let normal = [
                    u[1] * v[2] - u[2] * v[1],
                    u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0],
                ];
                let mut triangle = [vc, va, vb];
                if normal[a / 4] * if inside(values[EDGES[a][0]]) { 1. } else { -1. } < 0. {
                    triangle.swap(1, 2);
                }
                check_budget(mesh.prim_start.len() - 1, 1, MAX_OUTPUT_TRIANGLES)?;
                reserve(&mut mesh.vertex_point, 3)?;
                reserve(&mut mesh.prim_start, 1)?;
                mesh.vertex_point.extend_from_slice(&triangle);
                mesh.prim_start.push(mesh.vertex_point.len() as u32);
            }
        }
    }
    Ok(())
}

// Sorting has no hash randomization and is cheaper than a tree per mesh edge.
// Validate incidence and winding before exposing the topology over the ABI.
fn validate_edges(mesh: &DualMesh) -> Result<(), String> {
    let mut edges = Vec::new();
    reserve(&mut edges, mesh.vertex_point.len())?;
    for bounds in mesh.prim_start.windows(2) {
        let polygon = &mesh.vertex_point[bounds[0] as usize..bounds[1] as usize];
        for j in 0..polygon.len() {
            let a = polygon[j];
            let b = polygon[(j + 1) % polygon.len()];
            edges.push(((u64::from(a.min(b)) << 32) | u64::from(a.max(b)), a < b));
        }
    }
    edges.sort_unstable();
    let mut i = 0;
    while i < edges.len() {
        let mut end = i + 1;
        while end < edges.len() && edges[end].0 == edges[i].0 {
            end += 1;
        }
        if end - i != 2 || edges[i].1 == edges[i + 1].1 {
            return Err("dual_contour: unresolved sub-voxel topology creates a non-manifold edge; resample at a finer voxel size or blur the grid".into());
        }
        i = end;
    }
    Ok(())
}

#[cfg(test)]
mod budget_tests {
    use super::*;

    #[test]
    fn output_and_work_budgets_reject_overflow_before_allocation() {
        for limit in [MAX_ACTIVE_CELLS, MAX_OUTPUT_VERTICES, MAX_OUTPUT_TRIANGLES] {
            assert!(check_budget(limit - 1, 1, limit).is_ok());
            assert!(
                check_budget(limit, 1, limit)
                    .unwrap_err()
                    .contains("increase voxel size")
            );
        }
        assert!(check_budget(usize::MAX, 1, usize::MAX).is_err());
        let mut values = Vec::<u64>::new();
        assert!(reserve(&mut values, usize::MAX).is_err());
        assert!(values.is_empty());
        assert_eq!(values.capacity(), 0);
    }
}
