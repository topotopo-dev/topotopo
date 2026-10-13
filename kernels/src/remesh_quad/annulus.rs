//! Regular strips for a ruled annulus between corresponding planar feature
//! loops. Recognition verifies translation correspondence and projection; it
//! does not assume a circular cross section or a particular world axis.

use super::*;

fn find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

pub(super) fn regularize(
    vertices: &mut Vec<Vertex>,
    polygons: &mut Vec<Vec<usize>>,
    hard: &mut BTreeSet<(usize, usize)>,
    projector: &Projector,
    h: f64,
) {
    let mut sides = BTreeMap::<(usize, usize), Vec<usize>>::new();
    for (f, p) in polygons.iter().enumerate() {
        for k in 0..p.len() {
            sides
                .entry(pair(p[k], p[(k + 1) % p.len()]))
                .or_default()
                .push(f);
        }
    }
    let mut parent: Vec<_> = (0..polygons.len()).collect();
    for (&edge, faces) in &sides {
        if faces.len() == 2 && !hard.contains(&edge) {
            let a = find(&mut parent, faces[0]);
            let b = find(&mut parent, faces[1]);
            parent[b] = a;
        }
    }
    let mut patches = BTreeMap::<usize, Vec<usize>>::new();
    for f in 0..polygons.len() {
        patches.entry(find(&mut parent, f)).or_default().push(f);
    }
    let mut added = Vec::new();
    for patch in patches.values() {
        if patch.len() < 8 {
            continue;
        }
        let face_set: BTreeSet<_> = patch.iter().copied().collect();
        let mut next = BTreeMap::new();
        let mut incoming = BTreeSet::new();
        let mut internal_hard = BTreeSet::new();
        let mut patch_vertices = BTreeSet::new();
        let mut patch_edges = BTreeSet::new();
        let mut valid = true;
        for &f in patch {
            let p = &polygons[f];
            if p.iter().any(|&v| vertices[v].locked) {
                valid = false;
            }
            for k in 0..p.len() {
                let a = p[k];
                let b = p[(k + 1) % p.len()];
                let edge = pair(a, b);
                patch_vertices.insert(a);
                patch_edges.insert(edge);
                let count = sides[&edge].iter().filter(|f| face_set.contains(f)).count();
                if count == 1 {
                    if !hard.contains(&edge) || next.insert(a, b).is_some() || !incoming.insert(b) {
                        valid = false;
                    }
                } else if hard.contains(&edge) {
                    internal_hard.insert(edge);
                }
            }
        }
        if !valid
            || patch_vertices.len() + patch.len() != patch_edges.len()
            || next.len() < 16
            || next.len() > 512
        {
            continue;
        }
        let mut loops = Vec::new();
        let mut remaining: BTreeSet<_> = next.keys().copied().collect();
        while let Some(&first) = remaining.first() {
            let mut loop_ = vec![first];
            remaining.remove(&first);
            let mut current = first;
            loop {
                let Some(&v) = next.get(&current) else {
                    valid = false;
                    break;
                };
                if v == first {
                    break;
                }
                if !remaining.remove(&v) {
                    valid = false;
                    break;
                }
                loop_.push(v);
                current = v;
            }
            loops.push(loop_);
            if !valid || loops.len() > 2 {
                break;
            }
        }
        if !valid || loops.len() != 2 || loops[0].len() != loops[1].len() || loops[0].len() < 8 {
            continue;
        }
        let centers: [V3; 2] = std::array::from_fn(|k| {
            mul(
                loops[k].iter().fold([0.; 3], |s, &v| add(s, vertices[v].p)),
                1.0 / loops[k].len() as f64,
            )
        });
        let offset = sub(centers[1], centers[0]);
        let axis = unit(offset);
        let distance = norm(offset);
        if distance < h * 2.0
            || loops.iter().enumerate().any(|(k, loop_)| {
                loop_
                    .iter()
                    .any(|&v| dot(sub(vertices[v].p, centers[k]), axis).abs() > h * 1e-6)
            })
        {
            continue;
        }
        loops[1].reverse();
        let count = loops[0].len();
        let rotation = (0..count)
            .min_by(|&a, &b| {
                let score = |shift: usize| {
                    (0..count)
                        .map(|k| {
                            let delta = sub(
                                sub(
                                    vertices[loops[1][(k + shift) % count]].p,
                                    vertices[loops[0][k]].p,
                                ),
                                offset,
                            );
                            dot(delta, delta)
                        })
                        .sum::<f64>()
                };
                score(a).total_cmp(&score(b)).then(a.cmp(&b))
            })
            .unwrap();
        loops[1].rotate_left(rotation);
        if (0..count).any(|k| {
            norm(sub(
                sub(vertices[loops[1][k]].p, vertices[loops[0][k]].p),
                offset,
            )) > h * 0.05
        }) {
            continue;
        }
        // Check the complete old patch, not just the replacement samples: a
        // bulge between the candidate rails must not be silently flattened.
        if patch_vertices.iter().any(|&index| {
            let p = vertices[index].p;
            let along = dot(sub(p, centers[0]), axis);
            if along < -h * 1e-6 || along > distance + h * 1e-6 {
                return true;
            }
            let planar = sub(p, mul(axis, along));
            let closest = (0..count)
                .map(|k| {
                    let a = vertices[loops[0][k]].p;
                    let b = vertices[loops[0][(k + 1) % count]].p;
                    let edge = sub(b, a);
                    let t = (dot(sub(planar, a), edge) / dot(edge, edge)).clamp(0.0, 1.0);
                    norm(sub(planar, add(a, mul(edge, t))))
                })
                .fold(f64::INFINITY, f64::min);
            closest > h * 0.05
        }) {
            continue;
        }
        let mut constrained_columns = BTreeSet::new();
        let mut column_edges = BTreeMap::<usize, Vec<(usize, usize)>>::new();
        for &(a, b) in &internal_hard {
            let column = (0..count).find(|&k| {
                [a, b].iter().all(|&v| {
                    norm(tangent(sub(vertices[v].p, vertices[loops[0][k]].p), axis)) < h * 1e-6
                })
            });
            if let Some(k) = column {
                constrained_columns.insert(k);
                column_edges.entry(k).or_default().push((a, b));
            } else {
                valid = false;
                break;
            }
        }
        if !valid {
            continue;
        }
        // Only complete boundary-to-boundary rails may be resampled. A partial
        // crease or seam has meaningful endpoints and must remain untouched.
        for (&k, edges) in &column_edges {
            let mut links = BTreeMap::<usize, Vec<usize>>::new();
            for &(a, b) in edges {
                links.entry(a).or_default().push(b);
                links.entry(b).or_default().push(a);
            }
            let start = loops[0][k];
            let end = loops[1][k];
            if links.get(&start).map(Vec::len) != Some(1)
                || links.get(&end).map(Vec::len) != Some(1)
                || links
                    .iter()
                    .any(|(&v, ns)| ns.len() != if v == start || v == end { 1 } else { 2 })
            {
                valid = false;
                break;
            }
            let mut current = start;
            let mut previous = NONE;
            for _ in 0..edges.len() {
                let Some(&next) = links[&current].iter().find(|&&v| v != previous) else {
                    valid = false;
                    break;
                };
                previous = current;
                current = next;
            }
            if current != end {
                valid = false;
            }
        }
        if !valid {
            continue;
        }
        // The preserved loop may be sampled more densely than h. Allocate
        // strips by surface area so those mandatory samples do not multiply
        // the requested total face count.
        let patch_area: f64 = patch
            .iter()
            .map(|&f| norm(polygon_normal(&polygons[f], vertices)) * 0.5)
            .sum();
        let rows = (patch_area / (h * h * count as f64)).round().max(2.0) as usize;
        if rows * count > MAX_WORK_FACES {
            continue;
        }
        let old_count = vertices.len();
        let mut grid = loops[0].clone();
        for row in 1..rows {
            for k in 0..count {
                let p = add(
                    vertices[loops[0][k]].p,
                    mul(
                        sub(vertices[loops[1][k]].p, vertices[loops[0][k]].p),
                        row as f64 / rows as f64,
                    ),
                );
                let projected = projector.closest(p).0;
                if norm(sub(projected, p)) > h * 0.01 {
                    valid = false;
                    break;
                }
                let mut vertex = vertices[loops[0][k]].clone();
                vertex.p = projected;
                vertex.q = projected;
                vertex.n = unit(cross(
                    sub(
                        vertices[loops[0][(k + 1) % count]].p,
                        vertices[loops[0][(k + count - 1) % count]].p,
                    ),
                    axis,
                ));
                vertex.u = axis;
                vertex.curve = if constrained_columns.contains(&k) {
                    axis
                } else {
                    [0.; 3]
                };
                vertex.direction = vertex.curve;
                vertex.position_constraint = constrained_columns.contains(&k);
                vertex.fixed = false;
                vertex.locked = false;
                vertex.alive = true;
                grid.push(vertices.len());
                vertices.push(vertex);
            }
            if !valid {
                break;
            }
        }
        grid.extend_from_slice(&loops[1]);
        let mut replacement = Vec::with_capacity(rows * count);
        if valid {
            for row in 0..rows {
                for k in 0..count {
                    let next = (k + 1) % count;
                    let p = vec![
                        grid[row * count + k],
                        grid[row * count + next],
                        grid[(row + 1) * count + next],
                        grid[(row + 1) * count + k],
                    ];
                    if !extract::valid_polygon(&p, vertices, h) {
                        valid = false;
                        break;
                    }
                    replacement.push(p);
                }
            }
        }
        if !valid {
            vertices.truncate(old_count);
            continue;
        }
        for edge in internal_hard {
            hard.remove(&edge);
        }
        for &k in &constrained_columns {
            for row in 0..rows {
                hard.insert(pair(grid[row * count + k], grid[(row + 1) * count + k]));
            }
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

    type Fixture = (
        Vec<Vertex>,
        Vec<Vec<usize>>,
        BTreeSet<(usize, usize)>,
        Projector,
    );

    fn fixture(bulged: bool, partial_crease: bool) -> Fixture {
        let count = 16;
        let rows = 4;
        let mut vertices = Vec::new();
        for row in 0..=rows {
            let radius = if bulged && row == 1 { 1.3 } else { 1.0 };
            for col in 0..count {
                let angle = col as f64 * std::f64::consts::TAU / count as f64;
                let p = [
                    radius * libm::cos(angle),
                    row as f64 / rows as f64,
                    radius * libm::sin(angle),
                ];
                vertices.push(Vertex {
                    p,
                    q: p,
                    n: [libm::cos(angle), 0., libm::sin(angle)],
                    u: [0., 1., 0.],
                    curve: [0.; 3],
                    direction: [0.; 3],
                    position_constraint: false,
                    fixed: row == 0 || row == rows,
                    locked: false,
                    alive: true,
                });
            }
        }
        let mut polygons = Vec::new();
        let mut triangles = Vec::new();
        for row in 0..rows {
            for col in 0..count {
                let a = row * count + col;
                let b = row * count + (col + 1) % count;
                let c = b + count;
                let d = a + count;
                polygons.push(vec![a, d, c, b]);
                triangles.extend([a as u32, d as u32, c as u32, a as u32, c as u32, b as u32]);
            }
        }
        let mut hard = BTreeSet::new();
        for row in [0, rows] {
            for col in 0..count {
                hard.insert(pair(row * count + col, row * count + (col + 1) % count));
            }
        }
        if partial_crease {
            hard.insert((count, count * 2));
        }
        let positions: Vec<_> = vertices.iter().flat_map(|v| v.p).collect();
        let segments: Vec<_> = hard
            .iter()
            .map(|&(a, b)| (vertices[a].p, vertices[b].p))
            .collect();
        let projector = Projector::new(&positions, &triangles, &segments);
        (vertices, polygons, hard, projector)
    }

    #[test]
    fn ruled_annulus_control_is_replaced() {
        let (mut vertices, mut polygons, mut hard, projector) = fixture(false, false);
        let original = polygons.clone();
        regularize(&mut vertices, &mut polygons, &mut hard, &projector, 0.5);
        assert_ne!(
            polygons, original,
            "control must exercise the recognized annulus path"
        );
        assert!(polygons.iter().all(|p| p.len() == 4));
    }

    #[test]
    fn annulus_rejects_an_unsampled_bulge() {
        let (mut vertices, mut polygons, mut hard, projector) = fixture(true, false);
        let original = polygons.clone();
        let count = vertices.len();
        regularize(&mut vertices, &mut polygons, &mut hard, &projector, 0.5);
        assert_eq!(polygons, original);
        assert_eq!(vertices.len(), count);
    }

    #[test]
    fn annulus_preserves_partial_crease_endpoints() {
        let (mut vertices, mut polygons, mut hard, projector) = fixture(false, true);
        let original = polygons.clone();
        let original_hard = hard.clone();
        let count = vertices.len();
        regularize(&mut vertices, &mut polygons, &mut hard, &projector, 0.5);
        assert_eq!(polygons, original);
        assert_eq!(hard, original_hard);
        assert_eq!(vertices.len(), count);
    }
}
