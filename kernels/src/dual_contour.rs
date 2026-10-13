//! Uniform Hermite dual contouring: a QEF vertex per cell surface component,
//! and an outward-oriented polygon for each sign-changing primal grid edge.
//!
//! The uniform component construction follows Schaefer, Ju and Warren's
//! manifold dual contouring formulation (TVCG 2007, section III). Shared
//! asymptotic face decisions keep unrelated sheets distinct. Ambiguous cells
//! and sharply varying fits clamped against a cell boundary use conforming
//! cell-local conservative fans; shared face connectors prevent T junctions.
//! The legacy all-fan method remains available, byte-for-byte. Adaptive octree
//! clustering is not implemented: the adaptive tolerance currently retains the
//! uniform mesh. Local safeguards are not a proof against all geometric contacts.

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
    /// Cells replaced by conforming conservative patches after safety checks.
    pub fallback_cells: u32,
    /// Successful topology-preserving adaptive vertex collapses.
    pub adaptive_collapses: u32,
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

fn gradient(grid: &Grid, p: [usize; 3], limited: bool) -> [f64; 3] {
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
            if limited
                && center.is_finite()
                && p[axis] > 0
                && p[axis] + 1 < grid.dims[axis] as usize
            {
                let backward = center - lo;
                let forward = hi - center;
                if backward * forward <= 0. {
                    0.
                } else {
                    backward.signum() * backward.abs().min(forward.abs())
                }
            } else {
                (hi - lo)
                    / if p[axis] > 0 && p[axis] + 1 < grid.dims[axis] as usize {
                        2.
                    } else {
                        1.
                    }
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

// Project only when two finite exterior differences establish an affine
// distance stencil. Using its actual slope also respects uniformly rescaled
// implicit fields; a unit-gradient assumption would silently move their zero.
fn affine_edge_root(
    grid: &Grid,
    outside: [usize; 3],
    axis: usize,
    high: bool,
    value: f64,
) -> Option<f64> {
    let stride = [
        1,
        grid.dims[0] as usize,
        grid.dims[0] as usize * grid.dims[1] as usize,
    ][axis];
    if high && outside[axis] + 2 >= grid.dims[axis] as usize || !high && outside[axis] < 2 {
        return None;
    }
    let i = outside[0] + grid.dims[0] as usize * (outside[1] + grid.dims[1] as usize * outside[2]);
    let samples = if high {
        [i, i + stride, i + stride * 2]
    } else {
        [i, i - stride, i - stride * 2]
    }
    .map(|index| f64::from(grid.values[index]));
    if samples.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let d0 = samples[1] - samples[0];
    let d1 = samples[2] - samples[1];
    if d0 <= 0. || (d0 - d1).abs() > 1e-4 * d0.abs().max(d1.abs()) {
        return None;
    }
    let result = if high { 1. - value / d0 } else { value / d0 };
    (0. ..=1.).contains(&result).then_some(result)
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
    dual_contour_with_options(
        grid,
        iso,
        qef_tolerance,
        sharp,
        clamp_to_cell,
        false,
        0.,
        0.5,
    )
}

/// Extract ordinary edge-dual polygons, or the original conservative fan mesh.
/// `adaptive` is a geometric tolerance in voxels; unsafe clusters stay uniform.
/// `sharp_threshold` is a feature-normal variation (1 - absolute normal dot product).
#[allow(clippy::too_many_arguments)]
pub fn dual_contour_with_options(
    grid: &Grid,
    iso: f64,
    qef_tolerance: f64,
    sharp: bool,
    clamp_to_cell: bool,
    conservative: bool,
    adaptive: f64,
    sharp_threshold: f64,
) -> Result<DualMesh, String> {
    let mut profile = crate::erosion_profile::Profile::new("dual_contour");
    grid.validate()?;
    if !adaptive.is_finite() || adaptive < 0. {
        return Err("dual_contour: adaptive must be finite and non-negative".into());
    }
    if !sharp_threshold.is_finite() || !(0. ..=1.).contains(&sharp_threshold) {
        return Err("dual_contour: sharp_threshold must be in [0, 1]".into());
    }
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
    profile.mark("validation");
    let mut mesh = DualMesh {
        prim_start: vec![0],
        ..DualMesh::default()
    };
    let mut cells = Vec::<(usize, [u32; 12])>::new();
    let mut unsafe_cells = Vec::new();
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
            let row = index(0, y, z);
            let column_signs = |i: usize| {
                u8::from(negative(i))
                    | (u8::from(negative(i + nx)) << 1)
                    | (u8::from(negative(i + layer)) << 2)
                    | (u8::from(negative(i + nx + layer)) << 3)
            };
            let mut left = column_signs(row);
            for x in 0..nx - 1 {
                let base = row + x;
                let right = column_signs(base + 1);
                let uniform = left == right && (left == 0 || left == 15);
                left = right;
                if uniform {
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
                                conservative,
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
                    if sharp && !conservative {
                        // An exact affine exterior stencil is stronger Hermite
                        // evidence than interpolating through the medial-axis
                        // kink on the inside of a sharp box edge. Recover its
                        // plane root instead of averaging unrelated face normals.
                        let outside = if inside(values[a]) { b } else { a };
                        let axis = e / 4;
                        let mut n = gradients[outside];
                        if (0..3).any(|a| a != axis && n[a].abs() > 1e-15) {
                            n = gradient(
                                grid,
                                [
                                    x + (outside & 1),
                                    y + ((outside >> 1) & 1),
                                    z + ((outside >> 2) & 1),
                                ],
                                true,
                            );
                        }
                        let length = libm::sqrt(dot(n, n));
                        if length > 1e-15 && n[axis].abs() / length > 1. - 1e-12 {
                            let position = [
                                x + (outside & 1),
                                y + ((outside >> 1) & 1),
                                z + ((outside >> 2) & 1),
                            ];
                            if let Some(root) = affine_edge_root(
                                grid,
                                position,
                                axis,
                                outside == b,
                                values[outside],
                            ) {
                                h.p[axis] = root;
                                h.n = [0.; 3];
                                h.n[axis] = n[axis].signum();
                            }
                        }
                    }
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
                let mut unsafe_cell = component_count > 1
                    || FACES
                        .iter()
                        .any(|(_, edges)| edges.iter().all(|&e| crossed[e]));
                let affine_axial = hermite
                    .iter()
                    .enumerate()
                    .filter(|(e, _)| crossed[*e])
                    .all(|(_, h)| h.n.iter().filter(|n| n.abs() > 1e-10).count() == 1);
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
                    let mut p = qef(
                        &h[..n],
                        qef_tolerance,
                        sharp && component_count == 1,
                        clamp_to_cell,
                    );
                    if p.iter().any(|v| !v.is_finite() || *v < 0. || *v > 1.) {
                        return Err("dual_contour: an unconstrained QEF leaves its source cell; enable clamp_to_cell for safe extraction".into());
                    }
                    if !conservative
                        && !affine_axial
                        && p.iter().any(|v| *v <= 1e-9 || *v >= 1. - 1e-9)
                    {
                        let mut variation: f64 = 0.;
                        for a in &h[..n] {
                            for b in &h[..n] {
                                variation = variation.max(1. - dot(a.n, b.n).abs());
                            }
                        }
                        if variation > sharp_threshold {
                            unsafe_cell = true;
                        } else {
                            // A smooth patch can have an ill-conditioned fit
                            // outside its cell. The Hermite mass point is the
                            // stable in-cell fallback without sharpening a fold.
                            p = qef(&h[..n], qef_tolerance, false, true);
                        }
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
                reserve(&mut unsafe_cells, 1)?;
                unsafe_cells.push(unsafe_cell);
            }
        }
    }
    profile.mark("hermite_qef");
    if conservative {
        surface_fans(grid, iso, &cells, &mut mesh)?;
    } else {
        surface_dual(
            grid,
            iso,
            &cells,
            &unsafe_cells,
            &mut mesh,
            sharp,
            qef_tolerance,
        )?;
    }
    profile.mark("connectivity");
    validate_edges(&mesh)?;
    profile.mark("edge_validation");
    profile.finish();
    Ok(mesh)
}

fn point(mesh: &DualMesh, vertex: u32) -> [f64; 3] {
    std::array::from_fn(|axis| mesh.positions[3 * vertex as usize + axis])
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

fn polygon(mesh: &mut DualMesh, vertices: &[u32]) -> Result<(), String> {
    let triangles = mesh.vertex_point.len() - 2 * (mesh.prim_start.len() - 1);
    check_budget(triangles, vertices.len() - 2, MAX_OUTPUT_TRIANGLES)?;
    reserve(&mut mesh.vertex_point, vertices.len())?;
    reserve(&mut mesh.prim_start, 1)?;
    mesh.vertex_point.extend_from_slice(vertices);
    mesh.prim_start.push(mesh.vertex_point.len() as u32);
    Ok(())
}

// A quad remains a quad if its fourth corner is within 1e-4 voxel of the
// first triangle's plane. Otherwise select the diagonal with the most aligned
// triangle normals, breaking exact ties by the stable global vertex numbers.
fn dual_quad(mesh: &mut DualMesh, vertices: [u32; 4], voxel: f64) -> Result<(), String> {
    let p = vertices.map(|v| point(mesh, v));
    let normal = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    let squared = dot(normal, normal);
    let height = dot(normal, sub(p[3], p[0]));
    if squared > 0. && height * height <= squared * (voxel * 1e-4).powi(2) {
        return polygon(mesh, &vertices);
    }
    let score = |a: usize, b: usize, c: usize, d: usize| {
        let n0 = cross(sub(p[b], p[a]), sub(p[c], p[a]));
        let n1 = cross(sub(p[c], p[a]), sub(p[d], p[a]));
        dot(n0, n1) / libm::sqrt((dot(n0, n0) * dot(n1, n1)).max(1e-60))
    };
    if score(0, 1, 2, 3) >= score(1, 2, 3, 0) {
        polygon(mesh, &[vertices[0], vertices[1], vertices[2]])?;
        polygon(mesh, &[vertices[0], vertices[2], vertices[3]])
    } else {
        polygon(mesh, &[vertices[1], vertices[2], vertices[3]])?;
        polygon(mesh, &[vertices[1], vertices[3], vertices[0]])
    }
}

fn surface_dual(
    grid: &Grid,
    iso: f64,
    cells: &[(usize, [u32; 12])],
    unsafe_cells: &[bool],
    mesh: &mut DualMesh,
    sharp: bool,
    qef_tolerance: f64,
) -> Result<(), String> {
    let nx = grid.dims[0] as usize;
    let layer = nx * grid.dims[1] as usize;
    let mut lookup = Vec::new();
    reserve(&mut lookup, grid.values.len())?;
    lookup.resize(grid.values.len(), NONE);
    for (i, &(base, _)) in cells.iter().enumerate() {
        lookup[base] = i as u32;
    }
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
    let edge_key = |base: usize, e: usize| 3 * (base + offsets[EDGES[e][0]]) + e / 4;
    let mut split_edges = HashMap::<usize, (), BuildHasherDefault<EdgeHasher>>::default();
    for (i, &(base, vertices)) in cells.iter().enumerate() {
        if unsafe_cells[i] {
            for (e, &v) in vertices.iter().enumerate() {
                if v != NONE {
                    let key = edge_key(base, e);
                    if !split_edges.contains_key(&key) {
                        split_edges
                            .try_reserve(1)
                            .map_err(|_| ALLOCATION_ERROR.to_string())?;
                        split_edges.insert(key, ());
                    }
                }
            }
        }
    }
    // Every patch incident on a dangerous edge uses cell-interior fan centres.
    // The shared face connectors are also inserted into neighbouring quads, so
    // the transition never creates an unmatched edge or a T junction.
    for &(base, vertices) in cells {
        if vertices
            .iter()
            .enumerate()
            .any(|(e, &v)| v != NONE && split_edges.contains_key(&edge_key(base, e)))
        {
            mesh.fallback_cells += 1;
            let xyz = [base % nx, (base / nx) % grid.dims[1] as usize, base / layer];
            for &v in &vertices {
                if v == NONE {
                    continue;
                }
                for (axis, &coordinate) in xyz.iter().enumerate() {
                    let lo = grid.origin[axis] + (coordinate as f64 + INSET) * grid.voxel;
                    let hi = lo + (1. - 2. * INSET) * grid.voxel;
                    mesh.positions[v as usize * 3 + axis] =
                        mesh.positions[v as usize * 3 + axis].clamp(lo, hi);
                }
            }
        }
    }
    let crossing = |key: usize| {
        let sample = key / 3;
        let axis = key % 3;
        let stride = [1, nx, layer][axis];
        let a = f64::from(grid.values[sample]) - iso;
        let b = f64::from(grid.values[sample + stride]) - iso;
        let mut t = crossing_fraction(a, b);
        let xyz = [
            sample % nx,
            (sample / nx) % grid.dims[1] as usize,
            sample / layer,
        ];
        let mut high_xyz = xyz;
        high_xyz[axis] += 1;
        let ga = gradient(grid, xyz, false);
        let gb = gradient(grid, high_xyz, false);
        let mut normal = std::array::from_fn(|i| ga[i] * (1. - t) + gb[i] * t);
        if sharp {
            let outside = if inside(a) { high_xyz } else { xyz };
            let n = gradient(grid, outside, true);
            let length = libm::sqrt(dot(n, n));
            if length > 1e-15
                && n[axis].abs() / length > 1. - 1e-12
                && let Some(root) = affine_edge_root(
                    grid,
                    outside,
                    axis,
                    inside(a),
                    if inside(a) { b } else { a },
                )
            {
                t = root;
                normal = [0.; 3];
                normal[axis] = n[axis].signum();
            }
        }
        let t = t.clamp(INSET, 1. - INSET);
        let length = libm::sqrt(dot(normal, normal));
        if length > 1e-15 {
            for value in &mut normal {
                *value /= length;
            }
        } else {
            normal[axis] = (b - a).signum();
        }
        Hermite {
            p: std::array::from_fn::<_, 3, _>(|i| {
                grid.origin[i] + (xyz[i] as f64 + if i == axis { t } else { 0. }) * grid.voxel
            }),
            n: normal,
        }
    };
    let mut connectors = HashMap::<(usize, usize), u32, BuildHasherDefault<EdgeHasher>>::default();
    for &(base, edge_vertex) in cells {
        let rings = [
            [(0, 0), (nx, 1), (nx + layer, 3), (layer, 2)],
            [(0, 4), (layer, 6), (layer + 1, 7), (1, 5)],
            [(0, 8), (1, 9), (1 + nx, 11), (nx, 10)],
        ];
        for (axis, ring) in rings.into_iter().enumerate() {
            if edge_vertex[axis * 4] == NONE {
                continue;
            }
            let key = edge_key(base, axis * 4);
            let split = split_edges.contains_key(&key);
            let mut perimeter = [NONE; 8];
            let mut count = 0;
            for (j, (delta, edge)) in ring.into_iter().enumerate() {
                let cell_base = base - delta;
                let id = lookup[cell_base];
                if id == NONE {
                    return Err("dual_contour: incomplete sign-changing edge ring".into());
                }
                perimeter[count] = cells[id as usize].1[edge];
                count += 1;
                if split_edges.is_empty() {
                    continue;
                }
                let other_delta = ring[(j + 1) % 4].0;
                let face_axis = if delta.abs_diff(other_delta) == 1 {
                    0
                } else if delta.abs_diff(other_delta) == nx {
                    1
                } else {
                    2
                };
                let face = face_axis * 2 + usize::from(other_delta < delta);
                let (corners, edges) = FACES[face];
                let values = offsets.map(|o| f64::from(grid.values[cell_base + o]) - iso);
                let selected: Vec<_> = edges
                    .iter()
                    .copied()
                    .filter(|&e| cells[id as usize].1[e] != NONE)
                    .collect();
                let other = if selected.len() == 2 {
                    if selected[0] == edge {
                        selected[1]
                    } else {
                        selected[0]
                    }
                } else {
                    let [a, b, c, d] = corners.map(|c| values[c]);
                    let scale = a.abs().max(b.abs()).max(c.abs()).max(d.abs()).max(1.);
                    let k = edges
                        .iter()
                        .position(|&e| e == edge)
                        .expect("incident edge belongs to face");
                    edges[if (a / scale) * (c / scale) - (b / scale) * (d / scale) >= 0. {
                        k ^ 1
                    } else {
                        3 - k
                    }]
                };
                let other_key = edge_key(cell_base, other);
                if !split && !split_edges.contains_key(&other_key) {
                    continue;
                }
                let pair = (key.min(other_key), key.max(other_key));
                let connector = if let Some(&v) = connectors.get(&pair) {
                    v
                } else {
                    let p = crossing(key);
                    let q = crossing(other_key);
                    let mut center = std::array::from_fn(|a| (p.p[a] + q.p[a]) * 0.5);
                    let axial_plane =
                        |n: [f64; 3]| n.iter().filter(|v| v.abs() > 1e-10).count() == 1;
                    if sharp
                        && selected.len() == 2
                        && axial_plane(p.n)
                        && axial_plane(q.n)
                        && dot(p.n, q.n).abs() < 1e-10
                    {
                        // Two independently detected axial affine stencils
                        // identify a sharp planar junction. Solve their QEF on
                        // the shared face instead of beveling that junction.
                        // Blended normals at arbitrary CSG seams do not justify
                        // extrapolating a feature: retain the safe mass point.
                        let u = (face_axis + 1) % 3;
                        let v = (face_axis + 2) % 3;
                        let aa = p.n[u] * p.n[u] + q.n[u] * q.n[u];
                        let ab = p.n[u] * p.n[v] + q.n[u] * q.n[v];
                        let bb = p.n[v] * p.n[v] + q.n[v] * q.n[v];
                        let pa = dot(p.n, sub(p.p, center));
                        let qa = dot(q.n, sub(q.p, center));
                        let ru = p.n[u] * pa + q.n[u] * qa;
                        let rv = p.n[v] * pa + q.n[v] * qa;
                        let determinant = aa * bb - ab * ab;
                        if determinant > (aa + bb).powi(2) * qef_tolerance.powi(2).max(1e-12) {
                            let mut candidate = center;
                            candidate[u] += (bb * ru - ab * rv) / determinant;
                            candidate[v] += (aa * rv - ab * ru) / determinant;
                            let xyz = [
                                cell_base % nx,
                                (cell_base / nx) % grid.dims[1] as usize,
                                cell_base / layer,
                            ];
                            if [u, v].iter().all(|&a| {
                                let local =
                                    (candidate[a] - grid.origin[a]) / grid.voxel - xyz[a] as f64;
                                (INSET..=1. - INSET).contains(&local)
                            }) {
                                center = candidate;
                            }
                        }
                    }
                    reserve_vertex(mesh)?;
                    let v = mesh.cell_index.len() as u32;
                    mesh.positions.extend_from_slice(&center);
                    mesh.cell_index.push(cell_base as u32);
                    connectors
                        .try_reserve(1)
                        .map_err(|_| ALLOCATION_ERROR.to_string())?;
                    connectors.insert(pair, v);
                    v
                };
                perimeter[count] = connector;
                count += 1;
            }
            if !inside(f64::from(grid.values[base]) - iso) {
                perimeter[..count].reverse();
            }
            if count == 4 && !split {
                dual_quad(mesh, perimeter[..4].try_into().unwrap(), grid.voxel)?;
            } else {
                reserve_vertex(mesh)?;
                let center = mesh.cell_index.len() as u32;
                mesh.positions.extend_from_slice(&crossing(key).p);
                mesh.cell_index.push(base as u32);
                for j in 0..count {
                    polygon(mesh, &[center, perimeter[j], perimeter[(j + 1) % count]])?;
                }
            }
        }
    }
    Ok(())
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
