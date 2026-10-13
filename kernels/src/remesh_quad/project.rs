//! Deterministic median BVH for exact closest-point/barycentric projection.
use super::{V3, add, cross, dot, mul, sub};
use std::cell::Cell;

struct Node {
    min: V3,
    max: V3,
    start: usize,
    end: usize,
    children: Option<[usize; 2]>,
}
pub(super) struct Projector {
    triangles: Vec<[V3; 3]>,
    order: Vec<usize>,
    nodes: Vec<Node>,
    segments: Vec<(V3, V3)>,
    segment_order: Vec<usize>,
    segment_nodes: Vec<Node>,
    // Coherent queries get a finite bound before traversing. The hint only
    // tightens pruning: equal-distance candidates still use input-index ties.
    hint: Cell<usize>,
}

fn bounds(p: V3, min: V3, max: V3) -> f64 {
    (0..3)
        .map(|k| {
            let d = (min[k] - p[k]).max(0.0).max(p[k] - max[k]);
            d * d
        })
        .sum()
}
fn segment(p: V3, a: V3, b: V3) -> (V3, f64) {
    let e = sub(b, a);
    let d = dot(e, e);
    let t = if d > 0.0 {
        (dot(sub(p, a), e) / d).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (add(a, mul(e, t)), t)
}
fn triangle(p: V3, t: &[V3; 3]) -> (V3, V3) {
    let [a, b, c] = *t;
    let ab = sub(b, a);
    let ac = sub(c, a);
    let n = cross(ab, ac);
    let n2 = dot(n, n);
    let ap = sub(p, a);
    if n2 > 0.0 {
        let u = dot(cross(ap, ac), n) / n2;
        let v = dot(cross(ab, ap), n) / n2;
        if u >= 0.0 && v >= 0.0 && u + v <= 1.0 {
            return (add(add(a, mul(ab, u)), mul(ac, v)), [1.0 - u - v, u, v]);
        }
    }
    let mut best = f64::INFINITY;
    let mut out = (a, [1.0, 0.0, 0.0]);
    for k in 0..3 {
        let (q, w) = segment(p, t[k], t[(k + 1) % 3]);
        let d = dot(sub(q, p), sub(q, p));
        if d < best {
            best = d;
            let mut bary = [0.; 3];
            bary[k] = 1.0 - w;
            bary[(k + 1) % 3] = w;
            out = (q, bary);
        }
    }
    out
}

impl Projector {
    pub(super) fn new(positions: &[f64], tris: &[u32], segments: &[(V3, V3)]) -> Self {
        let triangles: Vec<[V3; 3]> = tris
            .chunks_exact(3)
            .map(|t| {
                std::array::from_fn(|k| {
                    let i = t[k] as usize * 3;
                    [positions[i], positions[i + 1], positions[i + 2]]
                })
            })
            .collect();
        let mut result = Self {
            order: (0..triangles.len())
                .filter(|&i| {
                    let t = triangles[i];
                    let n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
                    libm::sqrt(dot(n, n)) > 1e-28
                })
                .collect(),
            triangles,
            nodes: Vec::new(),
            segments: segments.to_vec(),
            segment_order: (0..segments.len()).collect(),
            segment_nodes: Vec::new(),
            hint: Cell::new(usize::MAX),
        };
        if !result.order.is_empty() {
            result.build(0, result.order.len());
        }
        if !result.segment_order.is_empty() {
            result.build_segments(0, result.segment_order.len());
        }
        result
    }
    fn build(&mut self, start: usize, end: usize) -> usize {
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for &i in &self.order[start..end] {
            for p in self.triangles[i] {
                for k in 0..3 {
                    min[k] = min[k].min(p[k]);
                    max[k] = max[k].max(p[k]);
                }
            }
        }
        let id = self.nodes.len();
        self.nodes.push(Node {
            min,
            max,
            start,
            end,
            children: None,
        });
        if end - start > 8 {
            let mut axis = 0;
            for k in 1..3 {
                if max[k] - min[k] > max[axis] - min[axis] {
                    axis = k;
                }
            }
            let tris = &self.triangles;
            self.order[start..end].select_nth_unstable_by((end - start) / 2, |&a, &b| {
                let ca = tris[a][0][axis] + tris[a][1][axis] + tris[a][2][axis];
                let cb = tris[b][0][axis] + tris[b][1][axis] + tris[b][2][axis];
                ca.total_cmp(&cb).then(a.cmp(&b))
            });
            let mid = (start + end) / 2;
            let a = self.build(start, mid);
            let b = self.build(mid, end);
            self.nodes[id].children = Some([a, b]);
        }
        id
    }
    pub(super) fn closest(&self, p: V3) -> (V3, usize, V3) {
        self.closest_hint(p, self.hint.get())
    }
    // A persistent per-vertex source triangle gives relaxation queries a tight
    // bound. The exact BVH traversal and input-index tie break remain unchanged.
    pub(super) fn closest_hint(&self, p: V3, hint: usize) -> (V3, usize, V3) {
        let mut hit = (p, usize::MAX, [0.; 3]);
        let mut best = f64::INFINITY;
        if self.nodes.is_empty() {
            return hit;
        }
        let hint = if hint == usize::MAX {
            self.hint.get()
        } else {
            hint
        };
        if hint != usize::MAX {
            let (q, bary) = triangle(p, &self.triangles[hint]);
            best = dot(sub(q, p), sub(q, p));
            hit = (q, hint, bary);
        }
        // Median splits bound the depth below 32 for the two-million-face
        // input limit. Store distances to avoid repeating each child's bound.
        let mut stack = [(0usize, 0.0); 64];
        let mut count = 1;
        while count != 0 {
            count -= 1;
            let (node, distance) = stack[count];
            if distance > best {
                continue;
            }
            let n = &self.nodes[node];
            if let Some([a, b]) = n.children {
                let da = bounds(p, self.nodes[a].min, self.nodes[a].max);
                let db = bounds(p, self.nodes[b].min, self.nodes[b].max);
                let (near, far) = if da <= db {
                    ((a, da), (b, db))
                } else {
                    ((b, db), (a, da))
                };
                if far.1 <= best {
                    stack[count] = far;
                    count += 1;
                }
                if near.1 <= best {
                    stack[count] = near;
                    count += 1;
                }
                continue;
            }
            for &i in &self.order[n.start..n.end] {
                if i == hint {
                    continue;
                }
                let (q, bary) = triangle(p, &self.triangles[i]);
                let d = dot(sub(q, p), sub(q, p));
                if d < best || (d == best && i < hit.1) {
                    best = d;
                    hit = (q, i, bary);
                }
            }
        }
        self.hint.set(hit.1);
        hit
    }
    fn build_segments(&mut self, start: usize, end: usize) -> usize {
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for &i in &self.segment_order[start..end] {
            let (a, b) = self.segments[i];
            for k in 0..3 {
                min[k] = min[k].min(a[k]).min(b[k]);
                max[k] = max[k].max(a[k]).max(b[k]);
            }
        }
        let id = self.segment_nodes.len();
        self.segment_nodes.push(Node {
            min,
            max,
            start,
            end,
            children: None,
        });
        if end - start > 8 {
            let mut axis = 0;
            for k in 1..3 {
                if max[k] - min[k] > max[axis] - min[axis] {
                    axis = k;
                }
            }
            let segments = &self.segments;
            self.segment_order[start..end].select_nth_unstable_by((end - start) / 2, |&a, &b| {
                let ca = segments[a].0[axis] + segments[a].1[axis];
                let cb = segments[b].0[axis] + segments[b].1[axis];
                ca.total_cmp(&cb).then(a.cmp(&b))
            });
            let mid = (start + end) / 2;
            let a = self.build_segments(start, mid);
            let b = self.build_segments(mid, end);
            self.segment_nodes[id].children = Some([a, b]);
        }
        id
    }
    pub(super) fn curve(&self, p: V3) -> V3 {
        if self.segment_nodes.is_empty() {
            return p;
        }
        let mut best = f64::INFINITY;
        let mut best_index = usize::MAX;
        let mut result = p;
        let mut stack = [(0usize, 0.0); 64];
        let mut count = 1;
        while count != 0 {
            count -= 1;
            let (node, distance) = stack[count];
            if distance > best {
                continue;
            }
            let n = &self.segment_nodes[node];
            if let Some([a, b]) = n.children {
                let da = bounds(p, self.segment_nodes[a].min, self.segment_nodes[a].max);
                let db = bounds(p, self.segment_nodes[b].min, self.segment_nodes[b].max);
                let (near, far) = if da <= db {
                    ((a, da), (b, db))
                } else {
                    ((b, db), (a, da))
                };
                if far.1 <= best {
                    stack[count] = far;
                    count += 1;
                }
                if near.1 <= best {
                    stack[count] = near;
                    count += 1;
                }
                continue;
            }
            for &i in &self.segment_order[n.start..n.end] {
                let (a, b) = self.segments[i];
                let (q, _) = segment(p, a, b);
                let d = dot(sub(q, p), sub(q, p));
                if d < best || (d == best && i < best_index) {
                    best = d;
                    best_index = i;
                    result = q;
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_ignores_removed_degenerates_and_retains_source_indices() {
        let p = [
            0., 0., 2., 1., 0., 2., 2., 0., 2., 0., 0., 0., 1., 0., 0., 0., 1., 0.,
        ];
        let projector = Projector::new(&p, &[0, 1, 2, 3, 4, 5], &[]);
        let hit = projector.closest([0.25, 0.25, 2.]);
        assert_eq!(hit.1, 1);
        assert_eq!(hit.0, [0.25, 0.25, 0.]);
        assert_eq!(hit.2, [0.5, 0.25, 0.25]);
    }

    #[test]
    fn curve_bvh_matches_exhaustive_projection_and_query_order() {
        let segments: Vec<_> = (0..100)
            .map(|i| {
                let x = f64::from(i);
                ([x, 0., 0.], [x, 1., 0.])
            })
            .collect();
        let projector = Projector::new(
            &[0., 0., 0., 100., 0., 0., 0., 100., 0.],
            &[0, 1, 2],
            &segments,
        );
        for i in (0..199).rev() {
            let p = [f64::from(i) * 0.5, 0.25, 0.2];
            let expected = [libm::floor(p[0]).min(99.), 0.25, 0.];
            assert_eq!(projector.curve(p), expected);
            let a = projector.closest(p);
            projector.closest([50., 30., -10.]);
            assert_eq!(a, projector.closest(p));
            assert_eq!(a, projector.closest_hint(p, 0));
        }
    }
}
