//! Hierarchical tangent orientation and lattice position fields.

use super::{Edge, NONE, V3, Vertex, add, axis, cross, dot, mul, norm, pair, sub, tangent, unit};

struct Level {
    vertices: Vec<Vertex>,
    neighbours: Neighbours,
    seeds: Vec<V3>,
    parent: Vec<usize>,
}

/// Compact adjacency avoids an allocation for every fine-level sample. Entries
/// retain canonical edge order, so Gauss--Seidel traversal remains deterministic.
struct Neighbours {
    offsets: Vec<usize>,
    indices: Vec<usize>,
}

impl Neighbours {
    fn new(n: usize, edges: &[(usize, usize)]) -> Self {
        let mut offsets = vec![0; n + 1];
        for &(a, b) in edges {
            offsets[a + 1] += 1;
            offsets[b + 1] += 1;
        }
        for i in 0..n {
            offsets[i + 1] += offsets[i];
        }
        let mut cursor = offsets[..n].to_vec();
        let mut indices = vec![0; edges.len() * 2];
        for &(a, b) in edges {
            indices[cursor[a]] = b;
            cursor[a] += 1;
            indices[cursor[b]] = a;
            cursor[b] += 1;
        }
        Self { offsets, indices }
    }

    fn at(&self, i: usize) -> &[usize] {
        &self.indices[self.offsets[i]..self.offsets[i + 1]]
    }
}

fn unit2(u: [f64; 2]) -> [f64; 2] {
    let length = (u[0] * u[0] + u[1] * u[1]).sqrt();
    if length > 1e-30 {
        [u[0] / length, u[1] / length]
    } else {
        [0.0; 2]
    }
}

fn compatible2(u: [f64; 2], reference: [f64; 2]) -> [f64; 2] {
    let a = u[0] * reference[0] + u[1] * reference[1];
    let b = -u[1] * reference[0] + u[0] * reference[1];
    if a.abs() >= b.abs() {
        let sign = if a < 0.0 { -1.0 } else { 1.0 };
        [u[0] * sign, u[1] * sign]
    } else {
        let sign = if b < 0.0 { -1.0 } else { 1.0 };
        [-u[1] * sign, u[0] * sign]
    }
}

/// Minimal rotation transports a tangent vector without introducing a global
/// coordinate-chart seam. The four equivalent representatives are then matched.
pub(super) fn transport(v: V3, from: V3, to: V3) -> V3 {
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
pub(super) fn nearby(q: V3, reference: V3, u: V3, n: V3, h: f64) -> V3 {
    nearby_axes(q, reference, u, cross(n, u), h)
}

fn nearby_axes(q: V3, reference: V3, u: V3, v: V3, h: f64) -> V3 {
    let d = sub(q, reference);
    sub(
        sub(q, mul(u, h * round_lattice(dot(d, u) / h))),
        mul(v, h * round_lattice(dot(d, v) / h)),
    )
}

/// IEEE ties-away rounding expressed with the WASM/native trunc instruction.
/// Adding 0.5 before floor would incorrectly round representable values just
/// below half integers; comparing the exact fractional part avoids that error.
#[inline]
pub(super) fn round_lattice(value: f64) -> f64 {
    let integer = value.trunc();
    let fraction = value - integer;
    if fraction >= 0.5 {
        integer + 1.0
    } else if fraction <= -0.5 {
        integer - 1.0
    } else {
        integer
    }
}

pub(super) fn solve_fields(vertices: &mut [Vertex], mesh_edges: &[Edge], h: f64, iterations: u32) {
    let mut profile = crate::erosion_profile::Profile::new("remesh_quad_fields");
    let mut levels = vec![Level {
        vertices: vertices.to_vec(),
        seeds: vertices.iter().map(|v| v.u).collect(),
        neighbours: Neighbours::new(
            vertices.len(),
            &mesh_edges.iter().map(|e| (e.a, e.b)).collect::<Vec<_>>(),
        ),
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
            if !(v.fixed && v.position_constraint) {
                for &j in fine.neighbours.at(i) {
                    let w = &fine.vertices[j];
                    if parent[j] != NONE
                        || (w.fixed && w.position_constraint)
                        || dot(v.n, w.n) < 0.25
                        || (v.position_constraint && norm(v.curve) > 0.0)
                            != (w.position_constraint && norm(w.curve) > 0.0)
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
        for i in 0..fine.vertices.len() {
            for &j in fine.neighbours.at(i) {
                if i < j && parent[i] != parent[j] {
                    coarse_edges.push(pair(parent[i], parent[j]));
                }
            }
        }
        coarse_edges.sort_unstable();
        coarse_edges.dedup();
        let neighbours = Neighbours::new(coarse.len(), &coarse_edges);
        levels[last].parent = parent;
        levels.push(Level {
            seeds: coarse.iter().map(|v| v.u).collect(),
            vertices: coarse,
            neighbours,
            parent: Vec::new(),
        });
    }
    profile.mark("hierarchy");
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
        profile.mark("prolongation");
        let l = &mut levels[level];
        // Express the four-way field in a fixed tangent basis at each sample.
        // A cached two-dimensional connection represents the same minimal
        // rotation as transport(), avoiding a 3D rotation and normalization for
        // every incident edge on every smoothing sweep.
        let second: Vec<_> = l
            .vertices
            .iter()
            .zip(&l.seeds)
            .map(|(v, &u)| cross(v.n, u))
            .collect();
        let mut directions: Vec<_> = l
            .vertices
            .iter()
            .enumerate()
            .map(|(i, v)| unit2([dot(v.u, l.seeds[i]), dot(v.u, second[i])]))
            .collect();
        let mut connections = Vec::with_capacity(l.neighbours.indices.len());
        for (i, v) in l.vertices.iter().enumerate() {
            for &j in l.neighbours.at(i) {
                let u = transport(l.seeds[j], l.vertices[j].n, v.n);
                connections.push(unit2([dot(u, l.seeds[i]), dot(u, second[i])]));
            }
        }
        let constrained: Vec<_> = l
            .vertices
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let d = if dot(v.direction, v.direction) > 0.0 {
                    v.direction
                } else if v.position_constraint {
                    v.curve
                } else {
                    [0.0; 3]
                };
                unit2([dot(d, l.seeds[i]), dot(d, second[i])])
            })
            .collect();
        for round in 0..iterations.max(1) {
            let mut max_change: f64 = 0.0;
            for i in 0..l.vertices.len() {
                if constrained[i] != [0.0; 2] {
                    directions[i] = constrained[i];
                    continue;
                }
                let reference = directions[i];
                let seed = compatible2([1.0, 0.0], reference);
                let weight = l.neighbours.at(i).len() as f64 * 0.5;
                let mut sum = [seed[0] * weight, seed[1] * weight];
                for (offset, &j) in l.neighbours.at(i).iter().enumerate() {
                    let [c, s] = connections[l.neighbours.offsets[i] + offset];
                    let [x, y] = directions[j];
                    let t = compatible2([c * x - s * y, s * x + c * y], reference);
                    sum[0] += t[0];
                    sum[1] += t[1];
                }
                let direction = unit2(sum);
                if direction != [0.0; 2] {
                    let change = [direction[0] - reference[0], direction[1] - reference[1]];
                    max_change = max_change.max(change[0] * change[0] + change[1] * change[1]);
                    directions[i] = direction;
                }
            }
            if round >= 2 && max_change < 1e-14 {
                break;
            }
        }
        for (i, v) in l.vertices.iter_mut().enumerate() {
            let [x, y] = directions[i];
            v.u = unit(add(mul(l.seeds[i], x), mul(second[i], y)));
        }
        profile.mark("orientation");
        let perpendicular: Vec<_> = l.vertices.iter().map(|v| cross(v.n, v.u)).collect();
        let directions: Vec<_> = l.vertices.iter().map(|v| v.u).collect();
        let mut origins: Vec<_> = l.vertices.iter().map(|v| v.q).collect();
        let curved: Vec<_> = l
            .vertices
            .iter()
            .map(|v| v.position_constraint && dot(v.curve, v.curve) > 0.0)
            .collect();
        // Coarse corrections carry long-range phase coherence. Fine levels need
        // only local relaxation after prolongation; spending the same 32 sweeps
        // on every dense input level dominates the solve without improving scale.
        let sweeps = iterations.max(1)
            * if level < 2 {
                1
            } else if level < 4 {
                2
            } else {
                4
            };
        for round in 0..sweeps {
            let mut max_change: f64 = 0.0;
            for i in 0..l.vertices.len() {
                let v = &l.vertices[i];
                if v.fixed && v.position_constraint {
                    origins[i] = v.p;
                    continue;
                }
                let mut sum = origins[i];
                let mut weight = 1.0;
                for &j in l.neighbours.at(i) {
                    let q = nearby_axes(origins[j], origins[i], directions[j], perpendicular[j], h);
                    sum = add(sum, q);
                    weight += 1.0;
                }
                // Tangent projection is linear; project the sum once instead
                // of projecting every incident neighbour and then the sum again.
                let mut q = add(v.p, tangent(sub(mul(sum, 1.0 / weight), v.p), v.n));
                if curved[i] {
                    q = add(v.p, mul(v.curve, dot(sub(q, v.p), v.curve)));
                }
                q = nearby_axes(q, v.p, v.u, perpendicular[i], h);
                let change = sub(
                    nearby_axes(q, origins[i], v.u, perpendicular[i], h),
                    origins[i],
                );
                max_change = max_change.max(dot(change, change));
                origins[i] = q;
            }
            if round >= 3 && max_change < h * h * 1e-10 {
                break;
            }
        }
        for (v, q) in l.vertices.iter_mut().zip(origins) {
            v.q = q;
        }
        profile.mark("position");
    }
    for (v, f) in vertices.iter_mut().zip(&levels[0].vertices) {
        v.u = f.u;
        v.q = f.q;
    }
    profile.finish();
}

#[cfg(test)]
mod tests {
    use super::round_lattice;

    #[test]
    fn lattice_round_matches_libm_at_half_integers_and_finite_bit_patterns() {
        for integer in -1024..=1024 {
            let half = f64::from(integer) + 0.5;
            for value in [half.next_down(), half, half.next_up()] {
                assert_eq!(round_lattice(value).to_bits(), libm::round(value).to_bits());
            }
        }
        let mut state = 0x2b99_2ddf_a232_49d6_u64;
        for _ in 0..100_000 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let value = f64::from_bits(state);
            if value.is_finite() {
                assert_eq!(round_lattice(value).to_bits(), libm::round(value).to_bits());
            }
        }
        for value in [-0.0, 0.0, f64::MIN_POSITIVE, -f64::MIN_POSITIVE] {
            assert_eq!(round_lattice(value).to_bits(), libm::round(value).to_bits());
        }
    }
}
