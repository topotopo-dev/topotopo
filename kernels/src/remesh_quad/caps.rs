//! Structured interiors for convex planar patches bounded by a crease loop.
//! The boundary remains unchanged; a single transition ring joins it to a
//! rectangular grid aligned with the ambient seed of the orientation field.

use super::*;

fn find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// A quad annulus can join loops with different even counts. Ordinary cells
/// advance once on both loops; a transition cell advances twice on the outer
/// loop. Dynamic programming chooses a valid convex path, avoiding a triangle
/// fan and preserving every original crease sample.
fn stitch_ring(
    vertices: &[Vertex],
    outer: &[usize],
    inner: &[usize],
    h: f64,
) -> Option<Vec<Vec<usize>>> {
    let width = inner.len() + 1;
    let mut cost = vec![f64::INFINITY; (outer.len() + 1) * width];
    let mut previous = vec![0_u8; cost.len()];
    cost[0] = 0.0;
    for a in 0..=outer.len() {
        for b in 0..=inner.len() {
            if !cost[a * width + b].is_finite() {
                continue;
            }
            for (da, db, step) in [(1, 1, 1), (2, 0, 2)] {
                if a + da > outer.len() || b + db > inner.len() {
                    continue;
                }
                let p = if step == 1 {
                    vec![
                        outer[a % outer.len()],
                        outer[(a + 1) % outer.len()],
                        inner[(b + 1) % inner.len()],
                        inner[b % inner.len()],
                    ]
                } else {
                    vec![
                        outer[a % outer.len()],
                        outer[(a + 1) % outer.len()],
                        outer[(a + 2) % outer.len()],
                        inner[b % inner.len()],
                    ]
                };
                if !extract::valid_polygon(&p, vertices, h) {
                    continue;
                }
                let shape: f64 = (0..4)
                    .map(|k| {
                        let length = norm(sub(vertices[p[k]].p, vertices[p[(k + 1) % 4]].p)) / h;
                        (length - 1.0) * (length - 1.0)
                    })
                    .sum();
                let candidate = cost[a * width + b] + shape;
                let index = (a + da) * width + b + db;
                if candidate < cost[index] {
                    cost[index] = candidate;
                    previous[index] = step;
                }
            }
        }
    }
    if !cost.last()?.is_finite() {
        return None;
    }
    let mut a = outer.len();
    let mut b = inner.len();
    let mut result = Vec::new();
    while a > 0 || b > 0 {
        match previous[a * width + b] {
            1 => {
                a -= 1;
                b -= 1;
                result.push(vec![
                    outer[a],
                    outer[(a + 1) % outer.len()],
                    inner[(b + 1) % inner.len()],
                    inner[b],
                ]);
            }
            2 => {
                a -= 2;
                result.push(vec![
                    outer[a],
                    outer[a + 1],
                    outer[(a + 2) % outer.len()],
                    inner[b % inner.len()],
                ]);
            }
            _ => return None,
        }
    }
    result.reverse();
    Some(result)
}

pub(super) fn regularize_planar_patches(
    vertices: &mut Vec<Vertex>,
    polygons: &mut Vec<Vec<usize>>,
    hard: &mut BTreeSet<(usize, usize)>,
    projector: &Projector,
    h: f64,
) {
    if hard.is_empty() {
        return;
    }
    let mut records = Vec::with_capacity(polygons.len() * 4);
    for (f, p) in polygons.iter().enumerate() {
        for k in 0..p.len() {
            let (a, b) = pair(p[k], p[(k + 1) % p.len()]);
            records.push((a, b, f));
        }
    }
    records.sort_unstable();
    let mut parent: Vec<_> = (0..polygons.len()).collect();
    let mut i = 0;
    while i < records.len() {
        let (a, b, f) = records[i];
        let mut j = i + 1;
        while j < records.len() && (records[j].0, records[j].1) == (a, b) {
            j += 1;
        }
        if j - i == 2 && !hard.contains(&(a, b)) {
            let root = find(&mut parent, f);
            let other = find(&mut parent, records[i + 1].2);
            parent[other] = root;
        }
        i = j;
    }
    let mut components = BTreeMap::<usize, Vec<usize>>::new();
    for f in 0..polygons.len() {
        components.entry(find(&mut parent, f)).or_default().push(f);
    }
    let planar = |patch: &[usize]| {
        let n = unit(polygon_normal(&polygons[patch[0]], vertices));
        let origin = vertices[polygons[patch[0]][0]].p;
        patch.iter().all(|&f| {
            dot(unit(polygon_normal(&polygons[f], vertices)), n) >= 1.0 - 1e-8
                && polygons[f]
                    .iter()
                    .all(|&v| dot(sub(vertices[v].p, origin), n).abs() <= h * 1e-6)
        })
    };
    let planar_roots: BTreeSet<_> = components
        .iter()
        .filter(|(_, patch)| planar(patch))
        .map(|(&root, _)| root)
        .collect();
    let area: f64 = polygons
        .iter()
        .map(|p| norm(polygon_normal(p, vertices)) * 0.5)
        .sum();
    let planar_area: f64 = components
        .iter()
        .filter(|(root, _)| planar_roots.contains(root))
        .flat_map(|(_, patch)| patch)
        .map(|&f| norm(polygon_normal(&polygons[f], vertices)) * 0.5)
        .sum();
    let other_faces: usize = components
        .iter()
        .filter(|(root, _)| !planar_roots.contains(root))
        .map(|(_, patch)| patch.len())
        .sum();
    let cap_budget = (area / (h * h) - other_faces as f64).max(0.0);
    let mut added = Vec::new();
    for patch in components.values() {
        if patch.len() < 8 {
            continue;
        }
        let n = unit(polygon_normal(&polygons[patch[0]], vertices));
        let origin = vertices[polygons[patch[0]][0]].p;
        if patch.iter().any(|&f| {
            dot(unit(polygon_normal(&polygons[f], vertices)), n) < 1.0 - 1e-8
                || polygons[f]
                    .iter()
                    .any(|&v| dot(sub(vertices[v].p, origin), n).abs() > h * 1e-6)
        }) {
            continue;
        }
        let mut next = BTreeMap::new();
        let mut incoming = BTreeSet::new();
        let patch_faces: BTreeSet<_> = patch.iter().copied().collect();
        let mut patch_vertices = BTreeSet::new();
        let mut patch_edges = BTreeSet::new();
        let mut valid = true;
        for &f in patch {
            let p = &polygons[f];
            for k in 0..p.len() {
                let a = p[k];
                let b = p[(k + 1) % p.len()];
                let edge = pair(a, b);
                patch_vertices.insert(a);
                patch_edges.insert(edge);
                let start = records.partition_point(|r| (r.0, r.1) < edge);
                let count = records[start..]
                    .iter()
                    .take_while(|r| (r.0, r.1) == edge)
                    .filter(|r| patch_faces.contains(&r.2))
                    .count();
                if count == 1 {
                    if !hard.contains(&edge) || next.insert(a, b).is_some() || !incoming.insert(b) {
                        valid = false;
                    }
                } else if hard.contains(&edge) {
                    // Replacing a cap must not erase an internal attribute or
                    // feature seam that did not disconnect its face component.
                    valid = false;
                }
            }
        }
        if !valid
            || patch_vertices.len() + patch.len() != patch_edges.len() + 1
            || next.len() < 8
            || next.len() > 512
            || !next.len().is_multiple_of(2)
        {
            continue;
        }
        let first = *next.first_key_value().unwrap().0;
        let mut boundary = vec![first];
        while boundary.len() < next.len() {
            let Some(&v) = next.get(boundary.last().unwrap()) else {
                valid = false;
                break;
            };
            if boundary.contains(&v) {
                valid = false;
                break;
            }
            boundary.push(v);
        }
        if !valid
            || next.get(boundary.last().unwrap()) != Some(&first)
            || boundary.iter().any(|&v| vertices[v].locked)
            // Rectangular feature patches already have their natural corners;
            // only smooth closed crease loops need an interior transition ring.
            || (0..boundary.len()).filter(|&k| {
                let a = vertices[boundary[k]].p;
                let b = vertices[boundary[(k + 1) % boundary.len()]].p;
                let c = vertices[boundary[(k + 2) % boundary.len()]].p;
                dot(unit(sub(a, b)), unit(sub(c, b))) > -libm::cos(std::f64::consts::PI / 6.0)
            }).count() >= 4
            || (0..boundary.len()).any(|k| {
                let a = vertices[boundary[k]].p;
                let b = vertices[boundary[(k + 1) % boundary.len()]].p;
                let c = vertices[boundary[(k + 2) % boundary.len()]].p;
                dot(cross(sub(b, a), sub(c, b)), n) < -h * h * 1e-8
            })
        {
            continue;
        }
        let center = mul(
            boundary.iter().fold([0.; 3], |s, &v| add(s, vertices[v].p)),
            1.0 / boundary.len() as f64,
        );
        let u = axis(n);
        let v = cross(n, u);
        let half_u = boundary
            .iter()
            .map(|&i| dot(sub(vertices[i].p, center), u).abs())
            .fold(0.0_f64, f64::max);
        let half_v = boundary
            .iter()
            .map(|&i| dot(sub(vertices[i].p, center), v).abs())
            .fold(0.0_f64, f64::max);
        if half_u.min(half_v) < h * 1.5 {
            continue;
        }
        let start = (0..boundary.len())
            .max_by(|&a, &b| {
                let score = |i: usize| {
                    let d = sub(vertices[boundary[i]].p, center);
                    dot(d, u) / half_u + dot(d, v) / half_v
                };
                score(a).total_cmp(&score(b)).then(b.cmp(&a))
            })
            .unwrap();
        boundary.rotate_left(start);
        let patch_area: f64 = patch
            .iter()
            .map(|&f| norm(polygon_normal(&polygons[f], vertices)) * 0.5)
            .sum();
        let target = cap_budget * patch_area / planar_area;
        let mut best = (f64::INFINITY, 2, 2);
        for nx in 2..boundary.len() / 2 - 1 {
            for ny in 2..=boundary.len() / 2 - nx {
                let count = nx * ny + boundary.len() / 2 + nx + ny;
                let score = (count as f64 - target).abs() / target.max(1.0)
                    + 0.1 * (libm::log(nx as f64 / ny as f64 / (half_u / half_v))).abs();
                if score < best.0 {
                    best = (score, nx, ny);
                }
            }
        }
        let (_, nx, ny) = best;
        // Keep a useful-width ring even at diagonal corners of a round cap.
        let mut scale = ((1.0 - h / half_u.min(half_v)) / libm::sqrt(2.0)).clamp(0.3, 0.7);
        let inside = |p: V3| {
            (0..boundary.len()).all(|k| {
                let a = vertices[boundary[k]].p;
                let b = vertices[boundary[(k + 1) % boundary.len()]].p;
                dot(cross(sub(b, a), sub(p, a)), n) >= h * h * 1e-5
            })
        };
        for _ in 0..8 {
            if [(-1., -1.), (-1., 1.), (1., -1.), (1., 1.)]
                .iter()
                .all(|&(x, y)| {
                    inside(add(
                        center,
                        add(mul(u, x * half_u * scale), mul(v, y * half_v * scale)),
                    ))
                })
            {
                break;
            }
            scale *= 0.8;
        }
        if scale < 0.25 {
            continue;
        }
        let old_count = vertices.len();
        let mut grid = Vec::with_capacity((nx + 1) * (ny + 1));
        for row in 0..=ny {
            for col in 0..=nx {
                let p = add(
                    center,
                    add(
                        mul(u, half_u * scale * (1.0 - 2.0 * col as f64 / nx as f64)),
                        mul(v, half_v * scale * (1.0 - 2.0 * row as f64 / ny as f64)),
                    ),
                );
                let mut vertex = vertices[boundary[0]].clone();
                vertex.p = projector.closest(p).0;
                vertex.q = vertex.p;
                vertex.n = n;
                vertex.u = u;
                vertex.curve = [0.; 3];
                vertex.direction = [0.; 3];
                vertex.position_constraint = false;
                vertex.fixed = false;
                vertex.locked = false;
                vertex.alive = true;
                grid.push(vertices.len());
                vertices.push(vertex);
            }
        }
        let mut inner = Vec::with_capacity(boundary.len());
        inner.extend_from_slice(&grid[..nx]);
        for row in 0..ny {
            inner.push(grid[row * (nx + 1) + nx]);
        }
        for col in (1..=nx).rev() {
            inner.push(grid[ny * (nx + 1) + col]);
        }
        for row in (1..=ny).rev() {
            inner.push(grid[row * (nx + 1)]);
        }
        let mut replacement = Vec::with_capacity(nx * ny + boundary.len());
        for row in 0..ny {
            for col in 0..nx {
                let a = row * (nx + 1) + col;
                replacement.push(vec![
                    grid[a],
                    grid[a + 1],
                    grid[a + nx + 2],
                    grid[a + nx + 1],
                ]);
            }
        }
        let mut ring = None;
        for shift in [0, 1, boundary.len() - 1, 2, boundary.len() - 2] {
            let mut rotated = boundary.clone();
            rotated.rotate_left(shift);
            if let Some(candidate) = stitch_ring(vertices, &rotated, &inner, h) {
                ring = Some(candidate);
                break;
            }
        }
        let Some(ring) = ring else {
            vertices.truncate(old_count);
            continue;
        };
        replacement.extend(ring);
        if replacement.iter().any(|p| {
            !extract::valid_polygon(p, vertices, h) || dot(polygon_normal(p, vertices), n) <= 0.0
        }) {
            vertices.truncate(old_count);
            continue;
        }
        for &f in patch {
            polygons[f].clear();
        }
        added.extend(replacement);
    }
    polygons.retain(|p| !p.is_empty());
    polygons.extend(added);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_does_not_fill_an_unconstrained_inner_boundary() {
        let count = 16;
        let mut vertices = Vec::new();
        for radius in [1.0, 0.4] {
            for col in 0..count {
                let angle = col as f64 * std::f64::consts::TAU / count as f64;
                let p = [radius * libm::cos(angle), 0., radius * libm::sin(angle)];
                vertices.push(Vertex {
                    p,
                    q: p,
                    n: [0., -1., 0.],
                    u: [1., 0., 0.],
                    curve: [0.; 3],
                    direction: [0.; 3],
                    position_constraint: false,
                    fixed: false,
                    locked: false,
                    alive: true,
                });
            }
        }
        let mut polygons = Vec::new();
        let mut triangles = Vec::new();
        let mut hard = BTreeSet::new();
        for col in 0..count {
            let next = (col + 1) % count;
            polygons.push(vec![col, next, next + count, col + count]);
            triangles.extend([
                col as u32,
                next as u32,
                (next + count) as u32,
                col as u32,
                (next + count) as u32,
                (col + count) as u32,
            ]);
            hard.insert(pair(col, next));
        }
        let positions: Vec<_> = vertices.iter().flat_map(|v| v.p).collect();
        let segments: Vec<_> = hard
            .iter()
            .map(|&(a, b)| (vertices[a].p, vertices[b].p))
            .collect();
        let projector = Projector::new(&positions, &triangles, &segments);
        let original = polygons.clone();
        let original_count = vertices.len();
        regularize_planar_patches(&mut vertices, &mut polygons, &mut hard, &projector, 0.2);
        assert_eq!(
            polygons, original,
            "the free inner hole must not be discarded"
        );
        assert_eq!(vertices.len(), original_count);
    }
}
