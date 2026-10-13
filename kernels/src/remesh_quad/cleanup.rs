//! Conservative local repairs of the extracted polygon mesh.

use super::*;

type EdgeRecord = (usize, usize, usize);

fn records(polygons: &[Vec<usize>]) -> Vec<EdgeRecord> {
    let mut result = Vec::with_capacity(polygons.len() * 4);
    for (f, p) in polygons.iter().enumerate() {
        for k in 0..p.len() {
            let (a, b) = pair(p[k], p[(k + 1) % p.len()]);
            result.push((a, b, f));
        }
    }
    result.sort_unstable();
    result
}

/// Dissolve a doublet: two faces sharing both edges at an interior degree-two
/// point. Their outer loop replaces both faces, so no edge is detached and the
/// Euler characteristic is unchanged. Constrained points and curves are kept.
fn dissolve_doublets(
    vertices: &mut [Vertex],
    polygons: &mut Vec<Vec<usize>>,
    hard: &BTreeSet<(usize, usize)>,
    h: f64,
) {
    for _ in 0..4 {
        let edges = records(polygons);
        let mut neighbours = vec![Vec::new(); vertices.len()];
        let mut incident = vec![Vec::new(); vertices.len()];
        let mut boundary = vec![false; vertices.len()];
        let mut i = 0;
        while i < edges.len() {
            let (a, b, _) = edges[i];
            let mut j = i + 1;
            while j < edges.len() && (edges[j].0, edges[j].1) == (a, b) {
                j += 1;
            }
            neighbours[a].push(b);
            neighbours[b].push(a);
            if j - i != 2 {
                boundary[a] = true;
                boundary[b] = true;
            }
            i = j;
        }
        for (f, p) in polygons.iter().enumerate() {
            for &v in p {
                incident[v].push(f);
            }
        }
        let mut changed = false;
        let mut touched = vec![false; polygons.len()];
        for v in 0..vertices.len() {
            if neighbours[v].len() != 2
                || incident[v].len() != 2
                || boundary[v]
                || vertices[v].fixed
                || vertices[v].locked
                || norm(vertices[v].curve) > 0.0
                || neighbours[v].iter().any(|&w| hard.contains(&pair(v, w)))
            {
                continue;
            }
            let f = incident[v][0];
            let g = incident[v][1];
            if touched[f] || touched[g] {
                continue;
            }
            let mut sides = Vec::new();
            for p in [&polygons[f], &polygons[g]] {
                for k in 0..p.len() {
                    let a = p[k];
                    let b = p[(k + 1) % p.len()];
                    if a != v && b != v {
                        sides.push((a, b));
                    }
                }
            }
            if !(3..=4).contains(&sides.len()) {
                continue;
            }
            let mut outer = vec![sides[0].0];
            for _ in 1..sides.len() {
                let Some(&(_, next)) = sides.iter().find(|&&(a, _)| a == *outer.last().unwrap())
                else {
                    break;
                };
                if outer.contains(&next) {
                    break;
                }
                outer.push(next);
            }
            if outer.len() != sides.len()
                || !sides.contains(&(*outer.last().unwrap(), outer[0]))
                || !extract::valid_polygon(&outer, vertices, h)
            {
                continue;
            }
            let n = polygon_normal(&outer, vertices);
            if [f, g]
                .iter()
                .any(|&face| dot(n, polygon_normal(&polygons[face], vertices)) <= 0.0)
            {
                continue;
            }
            // A tiny closed component can have another face with this loop.
            let mut key = outer.clone();
            key.sort_unstable();
            if polygons.iter().enumerate().any(|(index, p)| {
                if index == f || index == g || p.len() != key.len() {
                    return false;
                }
                let mut other = p.clone();
                other.sort_unstable();
                key == other
            }) {
                continue;
            }
            polygons[f] = outer;
            polygons[g].clear();
            vertices[v].alive = false;
            touched[f] = true;
            touched[g] = true;
            changed = true;
        }
        polygons.retain(|p| !p.is_empty());
        if !changed {
            break;
        }
    }
}

/// Collapse only very short, unconstrained interior edges that satisfy the
/// polygon link condition and do not increase squared valence deviation.
fn collapse_short_edges(
    vertices: &mut [Vertex],
    polygons: &mut Vec<Vec<usize>>,
    hard: &BTreeSet<(usize, usize)>,
    projector: &Projector,
    h: f64,
) {
    for _ in 0..3 {
        let edges = records(polygons);
        let mut neighbours = vec![Vec::new(); vertices.len()];
        let mut incident = vec![Vec::new(); vertices.len()];
        let mut boundary = vec![false; vertices.len()];
        let mut candidates = Vec::new();
        let mut i = 0;
        while i < edges.len() {
            let (a, b, _) = edges[i];
            let mut j = i + 1;
            while j < edges.len() && (edges[j].0, edges[j].1) == (a, b) {
                j += 1;
            }
            neighbours[a].push(b);
            neighbours[b].push(a);
            if j - i != 2 {
                boundary[a] = true;
                boundary[b] = true;
            } else {
                let distance = norm(sub(vertices[a].p, vertices[b].p));
                if distance < h * 0.3 && !hard.contains(&(a, b)) {
                    candidates.push((distance, a, b));
                }
            }
            i = j;
        }
        if candidates.is_empty() {
            break;
        }
        for n in &mut neighbours {
            n.sort_unstable();
        }
        for (f, p) in polygons.iter().enumerate() {
            for &v in p {
                incident[v].push(f);
            }
        }
        candidates
            .sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
        let mut touched = vec![false; vertices.len()];
        let mut changed = false;
        for (_, a, b) in candidates {
            if [a, b].iter().any(|&v| {
                boundary[v]
                    || vertices[v].fixed
                    || vertices[v].locked
                    || norm(vertices[v].curve) > 0.0
                    || touched[v]
                    || neighbours[v].iter().any(|&w| touched[w])
            }) {
                continue;
            }
            let common: Vec<_> = neighbours[a]
                .iter()
                .copied()
                .filter(|v| neighbours[b].binary_search(v).is_ok())
                .collect();
            let mut triangles = Vec::new();
            for &f in &incident[a] {
                if polygons[f].len() == 3 && polygons[f].contains(&b) {
                    triangles.push(*polygons[f].iter().find(|&&v| v != a && v != b).unwrap());
                }
            }
            triangles.sort_unstable();
            if common != triangles {
                continue;
            }
            let degree = neighbours[a].len() + neighbours[b].len() - 2 - common.len();
            if degree < 3 {
                continue;
            }
            let deviation = |v: usize| (neighbours[v].len() as i32 - 4).pow(2);
            let before =
                deviation(a) + deviation(b) + common.iter().map(|&v| deviation(v)).sum::<i32>();
            let after = (degree as i32 - 4).pow(2)
                + common
                    .iter()
                    .map(|&v| (neighbours[v].len() as i32 - 5).pow(2))
                    .sum::<i32>();
            if after > before {
                continue;
            }
            let mut affected = incident[a].clone();
            affected.extend_from_slice(&incident[b]);
            affected.sort_unstable();
            affected.dedup();
            let mut replacements = Vec::with_capacity(affected.len());
            for &f in &affected {
                let mut p: Vec<_> = polygons[f]
                    .iter()
                    .map(|&v| if v == b { a } else { v })
                    .collect();
                p.dedup();
                if p.first() == p.last() {
                    p.pop();
                }
                if p.len() < 3 {
                    p.clear();
                }
                replacements.push(p);
            }
            let before_normals: Vec<_> = affected
                .iter()
                .map(|&f| polygon_normal(&polygons[f], vertices))
                .collect();
            let old = vertices[a].p;
            vertices[a].p = projector.closest(mul(add(old, vertices[b].p), 0.5)).0;
            let mut valid = true;
            let mut keys = BTreeSet::new();
            for (p, &normal) in replacements.iter().zip(&before_normals) {
                if p.is_empty() {
                    continue;
                }
                let mut key = p.clone();
                key.sort_unstable();
                if !keys.insert(key)
                    || !extract::valid_polygon(p, vertices, h)
                    || dot(polygon_normal(p, vertices), normal) <= 0.0
                {
                    valid = false;
                    break;
                }
            }
            if !valid {
                vertices[a].p = old;
                continue;
            }
            for (&f, p) in affected.iter().zip(replacements) {
                polygons[f] = p;
            }
            vertices[b].alive = false;
            for v in [a, b]
                .into_iter()
                .chain(neighbours[a].iter().copied())
                .chain(neighbours[b].iter().copied())
            {
                touched[v] = true;
            }
            changed = true;
        }
        polygons.retain(|p| !p.is_empty());
        if !changed {
            break;
        }
    }
}

/// A protected curve corner cannot be dissolved without changing the curve.
/// Open one of its incident quads across the missing diagonal instead. This
/// preserves every constrained edge and raises its valence from two to three.
fn split_protected_doublets(vertices: &[Vertex], polygons: &mut Vec<Vec<usize>>, h: f64) {
    let edges = records(polygons);
    let mut degree = vec![0; vertices.len()];
    let mut boundary = vec![false; vertices.len()];
    let mut incident = vec![Vec::new(); vertices.len()];
    let mut i = 0;
    while i < edges.len() {
        let (a, b, _) = edges[i];
        let mut j = i + 1;
        while j < edges.len() && (edges[j].0, edges[j].1) == (a, b) {
            j += 1;
        }
        degree[a] += 1;
        degree[b] += 1;
        if j - i == 1 {
            boundary[a] = true;
            boundary[b] = true;
        }
        i = j;
    }
    for (f, p) in polygons.iter().enumerate() {
        for &v in p {
            incident[v].push(f);
        }
    }
    let mut touched = vec![false; polygons.len()];
    for v in 0..vertices.len() {
        if degree[v] != 2 || boundary[v] {
            continue;
        }
        for &f in &incident[v] {
            if touched[f] || polygons[f].len() != 4 {
                continue;
            }
            let p = &polygons[f];
            let k = p.iter().position(|&w| w == v).unwrap();
            let opposite = p[(k + 2) % 4];
            if edges
                .binary_search_by(|e| (e.0, e.1).cmp(&pair(v, opposite)))
                .is_ok()
            {
                continue;
            }
            let a = vec![v, p[(k + 1) % 4], opposite];
            let b = vec![v, opposite, p[(k + 3) % 4]];
            let patch_normal = polygon_normal(p, vertices);
            if !extract::valid_replacement(&a, vertices, h, patch_normal)
                || !extract::valid_replacement(&b, vertices, h, patch_normal)
            {
                continue;
            }
            polygons[f] = a;
            polygons.push(b);
            touched[f] = true;
            degree[v] += 1;
            degree[opposite] += 1;
            break;
        }
    }
}

pub(super) fn cleanup_polygons(
    vertices: &mut [Vertex],
    polygons: &mut Vec<Vec<usize>>,
    hard: &BTreeSet<(usize, usize)>,
    projector: &Projector,
    h: f64,
) {
    let initial_vertices = vertices.to_vec();
    let initial_polygons = polygons.clone();
    let initial_irregular = irregular_count(vertices.len(), polygons);
    dissolve_doublets(vertices, polygons, hard, h);
    collapse_short_edges(vertices, polygons, hard, projector, h);
    pair_residual_triangles(vertices, polygons, hard, h);
    improve_topology(vertices, polygons, hard, h);
    dissolve_doublets(vertices, polygons, hard, h);
    if polygons.len() < 4096 {
        // A short projected relaxation can unlock a convex flip that was
        // blocked by a sliver. Keep this additional solve off dense meshes.
        relax_polygons(vertices, polygons, projector, h, 2);
        improve_topology(vertices, polygons, hard, h);
        dissolve_doublets(vertices, polygons, hard, h);
    }
    // Triangle movement may briefly create singularities that later flips
    // cancel. Judge the completed cleanup, rather than rejecting those useful
    // intermediate paths on an already regular mesh.
    if irregular_count(vertices.len(), polygons) > initial_irregular {
        vertices.clone_from_slice(&initial_vertices);
        *polygons = initial_polygons.clone();
        if polygons.len() < 4096 {
            // An already regular mixed mesh can be better left unpaired.
            // Optimize its existing diagonal choices before accepting rollback.
            improve_topology(vertices, polygons, hard, h);
            relax_polygons(vertices, polygons, projector, h, 2);
            improve_topology(vertices, polygons, hard, h);
            if irregular_count(vertices.len(), polygons) > initial_irregular {
                vertices.clone_from_slice(&initial_vertices);
                *polygons = initial_polygons;
            }
        }
    }
    split_protected_doublets(vertices, polygons, h);
}

fn irregular_count(vertex_count: usize, polygons: &[Vec<usize>]) -> usize {
    let edges = records(polygons);
    let mut degree = vec![0; vertex_count];
    let mut boundary = vec![false; vertex_count];
    let mut i = 0;
    while i < edges.len() {
        let (a, b, _) = edges[i];
        let mut j = i + 1;
        while j < edges.len() && (edges[j].0, edges[j].1) == (a, b) {
            j += 1;
        }
        degree[a] += 1;
        degree[b] += 1;
        if j - i == 1 {
            boundary[a] = true;
            boundary[b] = true;
        }
        i = j;
    }
    (0..vertex_count)
        .filter(|&v| degree[v] > 0 && degree[v] != 4 && !boundary[v])
        .count()
}
