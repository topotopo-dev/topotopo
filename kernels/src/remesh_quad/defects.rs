//! Exact nearest eligible defect queries for local valence optimization.
use super::{NONE, V3, Vertex, dot, sub};

struct Node {
    vertex: usize,
    axis: usize,
    children: [usize; 2],
}

pub(super) struct DefectTree {
    nodes: Vec<Node>,
}

impl DefectTree {
    pub(super) fn new(indices: &[usize], vertices: &[Vertex]) -> Self {
        let mut tree = Self {
            nodes: Vec::with_capacity(indices.len()),
        };
        tree.build(&mut indices.to_vec(), vertices);
        tree
    }

    fn build(&mut self, indices: &mut [usize], vertices: &[Vertex]) -> usize {
        if indices.is_empty() {
            return NONE;
        }
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for &i in indices.iter() {
            for k in 0..3 {
                lo[k] = lo[k].min(vertices[i].p[k]);
                hi[k] = hi[k].max(vertices[i].p[k]);
            }
        }
        let mut axis = 0;
        for k in 1..3 {
            if hi[k] - lo[k] > hi[axis] - lo[axis] {
                axis = k;
            }
        }
        let middle = indices.len() / 2;
        indices.select_nth_unstable_by(middle, |&a, &b| {
            vertices[a].p[axis]
                .total_cmp(&vertices[b].p[axis])
                .then(a.cmp(&b))
        });
        let id = self.nodes.len();
        self.nodes.push(Node {
            vertex: indices[middle],
            axis,
            children: [NONE; 2],
        });
        let (left, rest) = indices.split_at_mut(middle);
        let a = self.build(left, vertices);
        let b = self.build(&mut rest[1..], vertices);
        self.nodes[id].children = [a, b];
        id
    }

    pub(super) fn distance<F: FnMut(usize) -> bool>(
        &self,
        p: V3,
        vertices: &[Vertex],
        max_distance: f64,
        mut eligible: F,
    ) -> f64 {
        if self.nodes.is_empty() {
            return max_distance;
        }
        let mut best = max_distance * max_distance;
        self.visit(0, p, vertices, &mut best, &mut eligible);
        libm::sqrt(best)
    }

    fn visit<F: FnMut(usize) -> bool>(
        &self,
        id: usize,
        p: V3,
        vertices: &[Vertex],
        best: &mut f64,
        eligible: &mut F,
    ) {
        if id == NONE {
            return;
        }
        let node = &self.nodes[id];
        let q = vertices[node.vertex].p;
        if eligible(node.vertex) {
            let delta = sub(q, p);
            *best = best.min(dot(delta, delta));
        }
        let delta = p[node.axis] - q[node.axis];
        let near = usize::from(delta > 0.0);
        self.visit(node.children[near], p, vertices, best, eligible);
        if delta * delta <= *best {
            self.visit(node.children[1 - near], p, vertices, best, eligible);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eligible_nearest_matches_scan() {
        let vertices: Vec<_> = (0..150)
            .map(|i| Vertex {
                p: [(i % 7) as f64, (i % 13) as f64, (i % 23) as f64],
                n: [0.; 3],
                u: [0.; 3],
                q: [0.; 3],
                curve: [0.; 3],
                alive: true,
                fixed: false,
                locked: false,
            })
            .collect();
        let indices: Vec<_> = (0..vertices.len()).collect();
        let tree = DefectTree::new(&indices, &vertices);
        for i in 0..vertices.len() {
            let p = vertices[i].p;
            let eligible = |j: usize| !j.is_multiple_of(3) && j != i;
            let expected = indices
                .iter()
                .copied()
                .filter(|&j| eligible(j))
                .map(|j| libm::sqrt(dot(sub(vertices[j].p, p), sub(vertices[j].p, p))))
                .fold(100., f64::min);
            assert_eq!(tree.distance(p, &vertices, 100., eligible), expected);
        }
    }
}
