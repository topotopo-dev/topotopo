use super::*;

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
pub(super) fn polygon_normal(poly: &[usize], vertices: &[Vertex]) -> V3 {
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

pub(super) fn extract(
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
pub(super) fn pair_residual_triangles(
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
            let mut ends = Vec::new();
            while head < queue.len() && queue.len() < 512 && ends.len() < 8 {
                let f = queue[head];
                head += 1;
                for &(g, _) in &neighbours[f] {
                    if seen[g] == start || touched[g] || polygons[g].is_empty() {
                        continue;
                    }
                    previous[g] = f;
                    seen[g] = start;
                    if polygons[g].len() == 3 {
                        ends.push(g);
                    } else {
                        queue.push(g);
                    }
                }
            }
            // The nearest triangle's shortest path can be nonconvex. Try a
            // few other endpoints before conceding to midpoint refinement.
            for end in ends {
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
                    let patch_normal = add(
                        polygon_normal(&polygons[f], vertices),
                        polygon_normal(&polygons[g], vertices),
                    );
                    if p.len() == 4 {
                        if valid_replacement(&p, vertices, h, patch_normal) {
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
                        if !regular_diagonal(vertices, diag.0, diag.1, h)
                            || records.binary_search_by(|e| (e.0, e.1).cmp(&diag)).is_ok()
                        {
                            continue;
                        }
                        if !valid_replacement(&tri, vertices, h, patch_normal)
                            || !valid_replacement(&quad, vertices, h, patch_normal)
                        {
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
                    break;
                } else {
                    for (&f, p) in path.iter().zip(saved) {
                        polygons[f] = p;
                    }
                }
            }
        }
        polygons.retain(|p| !p.is_empty());
        if changed == 0 {
            break;
        }
    }
}

pub(super) fn valid_polygon(p: &[usize], vertices: &[Vertex], h: f64) -> bool {
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

/// Convexity alone also accepts a polygon wound backwards outside a concave
/// union. Replacement faces must retain the orientation of their source patch.
pub(super) fn valid_replacement(p: &[usize], vertices: &[Vertex], h: f64, reference: V3) -> bool {
    let normal = polygon_normal(p, vertices);
    valid_polygon(p, vertices, h) && dot(normal, reference) > 0.05 * norm(normal) * norm(reference)
}

/// Defect relocation must not exchange regularity for arbitrarily long fans
/// or tiny slivers. This applies only to a newly inserted, unconstrained edge;
/// existing boundary/crease samples keep their exact geometry and partition.
fn regular_diagonal(vertices: &[Vertex], a: usize, b: usize, h: f64) -> bool {
    let edge = sub(vertices[a].p, vertices[b].p);
    let length_squared = dot(edge, edge);
    length_squared >= h * h * 0.09 && length_squared <= h * h * 4.0
}

pub(super) fn improve_topology(
    vertices: &[Vertex],
    polygons: &mut [Vec<usize>],
    hard: &BTreeSet<(usize, usize)>,
    h: f64,
) {
    let mut tabu = BTreeSet::new();
    for _ in 0..if polygons.len() < 4096 { 32 } else { 24 } {
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
            // A fully regular two-face patch cannot improve valence energy or
            // move an existing defect. Most dense-grid edges stop here, before
            // allocating a union loop or querying the defect tree.
            if polygons[f]
                .iter()
                .chain(&polygons[g])
                .all(|&v| valence[v] == if boundary[v] { 3 } else { 4 })
            {
                continue;
            }
            let Some(p) = union_loop(&polygons[f], &polygons[g], (a, b)) else {
                continue;
            };
            if p.len() != 6 && p.len() != 5 {
                continue;
            }
            let patch_normal = add(
                polygon_normal(&polygons[f], vertices),
                polygon_normal(&polygons[g], vertices),
            );
            let stride = if p.len() == 6 { 3 } else { 2 };
            let mut best = None;
            let mut best_energy = 0_i32;
            let mut best_shape = f64::INFINITY;
            let mut best_potential = -1e-8;
            for k in 0..p.len() {
                let x = p[k];
                let y = p[(k + stride) % p.len()];
                if pair(x, y) == (a, b)
                    || tabu.contains(&pair(x, y))
                    || !regular_diagonal(vertices, x, y, h)
                {
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
                if !valid_replacement(&first, vertices, h, patch_normal)
                    || !valid_replacement(&second, vertices, h, patch_normal)
                {
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

fn polygon_center(vertices: &mut Vec<Vertex>, p: &[usize], projector: &Projector) -> usize {
    let center = mul(
        p.iter().fold([0.; 3], |a, &i| add(a, vertices[i].p)),
        1.0 / p.len() as f64,
    );
    let mut v = vertices[p[0]].clone();
    v.p = projector.closest(center).0;
    v.q = v.p;
    v.curve = [0.; 3];
    v.direction = [0.; 3];
    v.position_constraint = false;
    v.fixed = false;
    v.locked = false;
    let center = vertices.len();
    vertices.push(v);
    center
}

pub(super) fn quad_subdivide(
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
    // Mark only the edges of residual nonquads. A neighbouring quad must have
    // an even number of split edges; propagate an opposite cut when it has one
    // and complete the fourth cut when it has three. This is conforming local
    // refinement: unaffected quads keep their original density and vertices.
    let mut edge_faces = BTreeMap::<(usize, usize), Vec<usize>>::new();
    for (f, p) in polygons.iter().enumerate() {
        for k in 0..p.len() {
            edge_faces
                .entry(pair(p[k], p[(k + 1) % p.len()]))
                .or_default()
                .push(f);
        }
    }
    let mut split = BTreeSet::new();
    let mut queue = Vec::new();
    for p in polygons.iter().filter(|p| p.len() != 4) {
        for k in 0..p.len() {
            let edge = pair(p[k], p[(k + 1) % p.len()]);
            if split.insert(edge) {
                queue.extend_from_slice(&edge_faces[&edge]);
            }
        }
    }
    let mut head = 0;
    while head < queue.len() {
        let f = queue[head];
        head += 1;
        let p = &polygons[f];
        if p.len() != 4 {
            continue;
        }
        let marked: [bool; 4] =
            std::array::from_fn(|k| split.contains(&pair(p[k], p[(k + 1) % 4])));
        let count = marked.iter().filter(|&&b| b).count();
        let next = match count {
            1 => Some((marked.iter().position(|&b| b).unwrap() + 2) % 4),
            3 => marked.iter().position(|&b| !b),
            _ => None,
        };
        if let Some(k) = next {
            let edge = pair(p[k], p[(k + 1) % 4]);
            if split.insert(edge) {
                queue.extend_from_slice(&edge_faces[&edge]);
            }
        }
    }
    if split.is_empty() {
        return Ok(());
    }
    let count: usize = polygons
        .iter()
        .map(|p| {
            if p.len() != 4 {
                p.len()
            } else {
                match (0..4)
                    .filter(|&k| split.contains(&pair(p[k], p[(k + 1) % 4])))
                    .count()
                {
                    0 => 1,
                    2 => {
                        if (0..2).any(|k| {
                            split.contains(&pair(p[k], p[(k + 1) % 4]))
                                && split.contains(&pair(p[(k + 2) % 4], p[(k + 3) % 4]))
                        }) {
                            2
                        } else {
                            3
                        }
                    }
                    _ => 4,
                }
            }
        })
        .sum();
    if count > max_faces {
        return Err("remesh_quad: conforming quads_only refinement exceeds max_faces; increase the guard or target length".into());
    }
    let mut edge_points = BTreeMap::new();
    let mut result = Vec::with_capacity(count);
    for p in polygons.iter() {
        let mut mids = vec![NONE; p.len()];
        for k in 0..p.len() {
            let a = p[k];
            let b = p[(k + 1) % p.len()];
            let key = pair(a, b);
            if !split.contains(&key) {
                continue;
            }
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
                v.direction = v.curve;
                v.position_constraint = curved;
                v.q = v.p;
                let index = vertices.len();
                vertices.push(v);
                index
            });
            mids[k] = mid;
        }
        let marked = mids.iter().filter(|&&v| v != NONE).count();
        if marked == 0 {
            result.push(p.clone());
            continue;
        }
        if p.len() == 4 && marked == 2 {
            let first = mids.iter().position(|&v| v != NONE).unwrap();
            if mids[(first + 2) % 4] != NONE {
                // Opposite edge cuts are a straight two-quad strip.
                result.push(vec![
                    p[first],
                    mids[first],
                    mids[(first + 2) % 4],
                    p[(first + 3) % 4],
                ]);
                result.push(vec![
                    mids[first],
                    p[(first + 1) % 4],
                    p[(first + 2) % 4],
                    mids[(first + 2) % 4],
                ]);
            } else {
                // Adjacent cuts need three quads and an interior point;
                // a two-quad diagonal would leave a collinear midpoint corner.
                let k = (0..4)
                    .find(|&k| mids[k] != NONE && mids[(k + 1) % 4] != NONE)
                    .unwrap();
                let center = polygon_center(vertices, p, projector);
                result.push(vec![mids[k], p[(k + 1) % 4], mids[(k + 1) % 4], center]);
                result.push(vec![
                    mids[(k + 1) % 4],
                    p[(k + 2) % 4],
                    p[(k + 3) % 4],
                    center,
                ]);
                result.push(vec![p[(k + 3) % 4], p[k], mids[k], center]);
            }
            continue;
        }
        let center = polygon_center(vertices, p, projector);
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
