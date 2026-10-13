use std::collections::{BTreeMap, BTreeSet};

const EPS: f64 = 2.0e-11;
const TIME_EPS: f64 = 2.0e-13;

#[derive(Clone, Copy, Debug, Default)]
struct P {
    x: f64,
    y: f64,
}
impl P {
    fn add(self, b: Self) -> Self {
        Self {
            x: self.x + b.x,
            y: self.y + b.y,
        }
    }
    fn sub(self, b: Self) -> Self {
        Self {
            x: self.x - b.x,
            y: self.y - b.y,
        }
    }
    fn mul(self, k: f64) -> Self {
        Self {
            x: self.x * k,
            y: self.y * k,
        }
    }
    fn dot(self, b: Self) -> f64 {
        self.x * b.x + self.y * b.y
    }
    fn cross(self, b: Self) -> f64 {
        self.x * b.y - self.y * b.x
    }
    fn len(self) -> f64 {
        self.dot(self).sqrt()
    }
    fn near(self, b: Self) -> bool {
        self.sub(b).len() <= EPS
    }
}

fn orient(a: P, b: P, c: P) -> f64 {
    robust::orient2d(
        robust::Coord { x: a.x, y: a.y },
        robust::Coord { x: b.x, y: b.y },
        robust::Coord { x: c.x, y: c.y },
    )
}
fn area(p: &[P]) -> f64 {
    // Translate before summing to avoid cancellation on georeferenced input.
    let Some(origin) = p.first() else {
        return 0.0;
    };
    p.iter()
        .zip(p.iter().cycle().skip(1))
        .map(|(a, b)| a.sub(*origin).cross(b.sub(*origin)))
        .sum::<f64>()
        * 0.5
}
fn inside(p: P, ring: &[P]) -> bool {
    let mut hit = false;
    for (a, b) in ring.iter().zip(ring.iter().cycle().skip(1)) {
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            hit = !hit;
        }
    }
    hit
}
fn on_segment(p: P, a: P, b: P) -> bool {
    let d = b.sub(a);
    let l = d.len();
    l > EPS
        && d.cross(p.sub(a)).abs() <= EPS * l
        && p.sub(a).dot(d) >= -EPS * l
        && p.sub(b).dot(d) <= EPS * l
}
fn intersects(a: P, b: P, c: P, d: P) -> bool {
    let o1 = orient(a, b, c);
    let o2 = orient(a, b, d);
    let o3 = orient(c, d, a);
    let o4 = orient(c, d, b);
    (o1.signum() != o2.signum() && o3.signum() != o4.signum())
        || on_segment(c, a, b)
        || on_segment(d, a, b)
        || on_segment(a, c, d)
        || on_segment(b, c, d)
}

#[derive(Clone, Debug)]
struct Edge {
    n: P,
    tangent: P,
    speed: f64,
    source: usize,
}
#[derive(Clone, Debug)]
struct Vertex {
    p: P,
    v: P,
    left: usize,
    right: usize,
    node: usize,
}
#[derive(Clone, Copy, Debug)]
struct Node {
    p: P,
    time: f64,
    source: i32,
}
#[derive(Clone, Copy, Debug)]
struct Fragment {
    a: usize,
    b: usize,
    edge: usize,
}
#[derive(Debug)]
struct Input {
    rings: Vec<Vec<P>>,
    ids: Vec<Vec<usize>>,
    edges: Vec<Edge>,
    origin: P,
    scale: f64,
    count: usize,
    original: Vec<P>,
}

impl Input {
    fn new(outer: &[f64], holes: &[Vec<f64>], weights: &[f64]) -> Result<Self, String> {
        let raw: Vec<&[f64]> = std::iter::once(outer)
            .chain(holes.iter().map(Vec::as_slice))
            .collect();
        let count = raw.iter().map(|r| r.len() / 2).sum::<usize>();
        if count > 4096 {
            return Err("polygon has more than 4096 vertices; split the footprint first".into());
        }
        if !weights.is_empty() && weights.len() != 1 && weights.len() != count {
            return Err(format!(
                "weights must contain one value or {count} contour-edge values"
            ));
        }
        if weights.iter().any(|w| !w.is_finite() || *w < 0.0) {
            return Err("weights must be finite nonnegative wavefront speeds".into());
        }
        let mut lo = P {
            x: f64::INFINITY,
            y: f64::INFINITY,
        };
        let mut hi = P {
            x: f64::NEG_INFINITY,
            y: f64::NEG_INFINITY,
        };
        for (i, r) in raw.iter().enumerate() {
            if r.len() < 6 || r.len() % 2 != 0 {
                return Err(format!("contour {i} needs at least three x,y pairs"));
            }
            if r.iter().any(|v| !v.is_finite()) {
                return Err(format!("contour {i} contains a non-finite coordinate"));
            }
            for p in r.chunks_exact(2) {
                lo.x = lo.x.min(p[0]);
                lo.y = lo.y.min(p[1]);
                hi.x = hi.x.max(p[0]);
                hi.y = hi.y.max(p[1]);
            }
        }
        let scale = (hi.x - lo.x).max(hi.y - lo.y);
        if !scale.is_finite() || scale <= 0.0 {
            return Err("polygon has zero extent or exceeds the finite coordinate range".into());
        }
        let origin = lo;
        let mut rings = Vec::new();
        let mut ids = Vec::new();
        let mut edges = Vec::new();
        let mut start = 0;
        for (ri, r) in raw.iter().enumerate() {
            let mut ring: Vec<P> = r
                .chunks_exact(2)
                .map(|v| P {
                    x: (v[0] - origin.x) / scale,
                    y: (v[1] - origin.y) / scale,
                })
                .collect();
            let n = ring.len();
            for i in 0..n {
                for j in i + 1..n {
                    if ring[i].near(ring[j]) {
                        return Err(format!(
                            "contour {ri} has duplicate or indistinguishably close points {i} and {j}; omit the repeated closing point"
                        ));
                    }
                }
            }
            let a = area(&ring);
            if a.abs() <= EPS * EPS {
                return Err(format!("contour {ri} has zero area"));
            }
            for i in 0..n {
                for j in i + 1..n {
                    if j == i + 1 || (i == 0 && j == n - 1) {
                        continue;
                    }
                    if intersects(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n]) {
                        return Err(format!("contour {ri} self-intersects at edges {i} and {j}"));
                    }
                }
            }
            let mut source: Vec<usize> = (start..start + n).collect();
            if (a > 0.0) != (ri == 0) {
                ring.reverse();
                source.reverse();
            }
            let mut edge_ids = Vec::new();
            for i in 0..n {
                let next = (i + 1) % n;
                let original_edge = if source[next] == start + (source[i] - start + 1) % n {
                    source[i]
                } else {
                    source[next]
                };
                let d = ring[next].sub(ring[i]);
                let tangent = d.mul(1.0 / d.len());
                let speed = if weights.is_empty() {
                    1.0
                } else {
                    weights[if weights.len() == 1 { 0 } else { original_edge }]
                };
                edge_ids.push(edges.len());
                edges.push(Edge {
                    n: P {
                        x: -tangent.y,
                        y: tangent.x,
                    },
                    tangent,
                    speed,
                    source: original_edge,
                });
            }
            for i in 0..n {
                let prev = (i + n - 1) % n;
                let a = &edges[edge_ids[prev]];
                let b = &edges[edge_ids[i]];
                if a.n.cross(b.n).abs() < 1e-14 && a.n.dot(b.n) < 0.0 {
                    return Err(format!("contour {ri} backtracks at point {i}"));
                }
                if a.n.cross(b.n).abs() < 1e-14 && (a.speed - b.speed).abs() > EPS {
                    return Err("adjacent collinear edges need equal weights; merge the collinear run or equalize its pitches".into());
                }
            }
            rings.push(ring);
            ids.push(source);
            start += n;
        }
        for i in 0..rings.len() {
            for j in i + 1..rings.len() {
                for a in 0..rings[i].len() {
                    for b in 0..rings[j].len() {
                        if intersects(
                            rings[i][a],
                            rings[i][(a + 1) % rings[i].len()],
                            rings[j][b],
                            rings[j][(b + 1) % rings[j].len()],
                        ) {
                            return Err(format!("contours {i} and {j} intersect or touch"));
                        }
                    }
                }
                if i == 0 && !inside(rings[j][0], &rings[0]) {
                    return Err(format!("hole {j} lies outside the outer contour"));
                }
                if i > 0 && (inside(rings[j][0], &rings[i]) || inside(rings[i][0], &rings[j])) {
                    return Err(
                        "holes must not contain other holes; pass islands as separate polygons"
                            .into(),
                    );
                }
            }
        }
        if edges.iter().all(|e| e.speed == 0.0) {
            return Err(
                "at least one contour edge must have a positive speed (a non-gable pitch)".into(),
            );
        }
        Ok(Self {
            rings,
            ids,
            edges,
            origin,
            scale,
            count,
            original: raw
                .iter()
                .flat_map(|r| r.chunks_exact(2).map(|p| P { x: p[0], y: p[1] }))
                .collect(),
        })
    }
    fn world(&self, node: &Node) -> P {
        if node.source >= 0 {
            return self.original[node.source as usize];
        }
        P {
            x: node.p.x * self.scale + self.origin.x,
            y: node.p.y * self.scale + self.origin.y,
        }
    }
}

fn velocity(a: &Edge, b: &Edge) -> Result<P, String> {
    let det = a.n.cross(b.n);
    if det.abs() < 1e-14 {
        if a.n.dot(b.n) > 0.0 && (a.speed - b.speed).abs() <= EPS {
            return Ok(a.n.mul(a.speed));
        }
        return Err("wavefront contains an unresolved parallel-edge event; simplify nearly coincident edges".into());
    }
    let v = P {
        x: (a.speed * b.n.y - a.n.y * b.speed) / det,
        y: (a.n.x * b.speed - a.speed * b.n.x) / det,
    };
    if !v.x.is_finite() || !v.y.is_finite() {
        return Err("wavefront velocity exceeds the finite numeric range".into());
    }
    Ok(v)
}

#[derive(Debug)]
struct Sim {
    input: Input,
    loops: Vec<Vec<Vertex>>,
    nodes: Vec<Node>,
    boundaries: Vec<Vec<(usize, usize)>>,
    contour: BTreeSet<(usize, usize)>,
    time: f64,
}
fn key(a: usize, b: usize) -> (usize, usize) {
    if a < b { (a, b) } else { (b, a) }
}
impl Sim {
    fn new(input: Input, reverse: bool) -> Result<Self, String> {
        let mut s = Self {
            boundaries: vec![Vec::new(); input.count],
            input,
            loops: Vec::new(),
            nodes: Vec::new(),
            contour: BTreeSet::new(),
            time: 0.0,
        };
        if reverse {
            for e in &mut s.input.edges {
                e.speed = -e.speed;
            }
        }
        let mut edge_start = 0;
        for (ri, ring) in s.input.rings.iter().enumerate() {
            let n = ring.len();
            let base = s.nodes.len();
            let mut lp = Vec::new();
            for (i, p) in ring.iter().enumerate() {
                let left = edge_start + (i + n - 1) % n;
                let right = edge_start + i;
                s.nodes.push(Node {
                    p: *p,
                    time: 0.0,
                    source: s.input.ids[ri][i] as i32,
                });
                lp.push(Vertex {
                    p: *p,
                    v: velocity(&s.input.edges[left], &s.input.edges[right])?,
                    left,
                    right,
                    node: base + i,
                });
                s.boundaries[s.input.edges[right].source].push((base + i, base + (i + 1) % n));
                s.contour.insert(key(base + i, base + (i + 1) % n));
            }
            edge_start += n;
            s.loops.push(lp);
        }
        Ok(s)
    }
    fn next_event(&self) -> Option<f64> {
        let mut earliest = f64::INFINITY;
        for (li, lp) in self.loops.iter().enumerate() {
            for (i, v) in lp.iter().enumerate() {
                let b = &lp[(i + 1) % lp.len()];
                let e = &self.input.edges[v.right];
                let length = b.p.sub(v.p).dot(e.tangent);
                let change = b.v.sub(v.v).dot(e.tangent);
                if change < -TIME_EPS {
                    let dt = -length / change;
                    if dt > TIME_EPS && dt < earliest {
                        earliest = dt;
                    }
                }
                for (lj, target) in self.loops.iter().enumerate() {
                    for (j, a) in target.iter().enumerate() {
                        if li == lj && (j == i || (j + 1) % target.len() == i) {
                            continue;
                        }
                        let b = &target[(j + 1) % target.len()];
                        let edge = &self.input.edges[a.right];
                        let denominator = edge.n.dot(v.v) - edge.speed;
                        if denominator.abs() < TIME_EPS {
                            continue;
                        }
                        let dt = -edge.n.dot(v.p.sub(a.p)) / denominator;
                        if dt <= TIME_EPS || dt >= earliest || !dt.is_finite() {
                            continue;
                        }
                        let p = v.p.add(v.v.mul(dt));
                        let pa = a.p.add(a.v.mul(dt));
                        let pb = b.p.add(b.v.mul(dt));
                        if on_segment(p, pa, pb) {
                            earliest = dt;
                        }
                    }
                }
            }
        }
        if earliest.is_finite() {
            Some(earliest)
        } else {
            None
        }
    }
    fn advance(&mut self, dt: f64) -> Result<Vec<Fragment>, String> {
        self.time += dt;
        let mut at = Vec::<usize>::new();
        let mut locations = Vec::new();
        for lp in &self.loops {
            let mut ids = Vec::new();
            for v in lp {
                let p = v.p.add(v.v.mul(dt));
                if !p.x.is_finite() || !p.y.is_finite() {
                    return Err("wavefront position exceeds the finite numeric range".into());
                }
                let node = if let Some(id) = at.iter().find(|id| self.nodes[**id].p.near(p)) {
                    *id
                } else {
                    let id = if self.nodes[v.node].p.near(p)
                        && (self.nodes[v.node].time - self.time).abs() <= TIME_EPS
                    {
                        v.node
                    } else {
                        self.nodes.push(Node {
                            p,
                            time: self.time,
                            source: -1,
                        });
                        self.nodes.len() - 1
                    };
                    at.push(id);
                    id
                };
                if node != v.node {
                    self.boundaries[self.input.edges[v.left].source].push((v.node, node));
                    self.boundaries[self.input.edges[v.right].source].push((node, v.node));
                }
                ids.push(node);
            }
            locations.push(ids);
        }
        let mut fragments = Vec::new();
        for (lp, ids) in self.loops.iter().zip(&locations) {
            for (i, v) in lp.iter().enumerate() {
                let a = ids[i];
                let b = ids[(i + 1) % ids.len()];
                if a == b {
                    continue;
                }
                let pa = self.nodes[a].p;
                let pb = self.nodes[b].p;
                let d = pb.sub(pa);
                let l = d.dot(d);
                let mut cuts = vec![(0.0, a), (1.0, b)];
                for id in &at {
                    if *id != a && *id != b && on_segment(self.nodes[*id].p, pa, pb) {
                        let t = self.nodes[*id].p.sub(pa).dot(d) / l;
                        if t > EPS && t < 1.0 - EPS {
                            cuts.push((t, *id));
                        }
                    }
                }
                cuts.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                for pair in cuts.windows(2) {
                    if pair[0].1 != pair[1].1 {
                        fragments.push(Fragment {
                            a: pair[0].1,
                            b: pair[1].1,
                            edge: v.right,
                        });
                    }
                }
            }
        }
        Ok(fragments)
    }
    fn resolve(&mut self, fragments: Vec<Fragment>) -> Result<(), String> {
        let mut by_segment = BTreeMap::<(usize, usize), Vec<Fragment>>::new();
        for f in fragments {
            by_segment.entry(key(f.a, f.b)).or_default().push(f);
        }
        let mut live = Vec::new();
        for (_, fs) in by_segment {
            if fs.len() == 1 {
                live.push(fs[0]);
                continue;
            }
            if fs.len() == 2 && fs[0].a == fs[1].b {
                for f in fs {
                    self.boundaries[self.input.edges[f.edge].source].push((f.b, f.a));
                }
            } else {
                return Err("simultaneous same-direction overlapping wavefronts cannot be resolved at this precision".into());
            }
        }
        let mut outgoing = BTreeMap::<usize, Vec<usize>>::new();
        for (i, f) in live.iter().enumerate() {
            outgoing.entry(f.a).or_default().push(i);
        }
        let mut next = vec![usize::MAX; live.len()];
        let mut claimed = BTreeSet::new();
        for (i, f) in live.iter().enumerate() {
            let reverse = self.nodes[f.a].p.sub(self.nodes[f.b].p);
            let choices = outgoing
                .get(&f.b)
                .ok_or("wavefront event left an unpaired incoming edge")?;
            let angle = libm::atan2(reverse.y, reverse.x);
            let best = choices
                .iter()
                .filter(|j| !claimed.contains(*j))
                .map(|j| {
                    let d = self.nodes[live[*j].b].p.sub(self.nodes[f.b].p);
                    let turn = (angle - libm::atan2(d.y, d.x)).rem_euclid(std::f64::consts::TAU);
                    (*j, turn)
                })
                .min_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)))
                .ok_or("wavefront event has incompatible edge incidences")?;
            next[i] = best.0;
            claimed.insert(best.0);
        }
        let mut used = vec![false; live.len()];
        let mut loops = Vec::new();
        for first in 0..live.len() {
            if used[first] {
                continue;
            }
            let mut chain = Vec::new();
            let mut i = first;
            loop {
                if used[i] {
                    if i != first {
                        return Err("wavefront reconnection did not form disjoint cycles".into());
                    }
                    break;
                }
                used[i] = true;
                chain.push(i);
                i = next[i];
            }
            if chain.len() < 3 {
                return Err("wavefront retained a degenerate two-edge cycle".into());
            }
            let mut lp = Vec::new();
            for k in 0..chain.len() {
                let f = live[chain[k]];
                let prev = live[chain[(k + chain.len() - 1) % chain.len()]];
                lp.push(Vertex {
                    p: self.nodes[f.a].p,
                    v: velocity(&self.input.edges[prev.edge], &self.input.edges[f.edge])?,
                    left: prev.edge,
                    right: f.edge,
                    node: f.a,
                });
            }
            loops.push(lp);
        }
        self.loops = loops;
        Ok(())
    }
    fn run(&mut self, limit: Option<f64>) -> Result<(), String> {
        let max_events = self.input.count * self.input.count + 32;
        for _ in 0..max_events {
            if self.loops.is_empty() {
                return Ok(());
            }
            let next = self.next_event();
            if let Some(target) = limit {
                if target <= self.time + TIME_EPS {
                    return Ok(());
                }
                if next.is_none_or(|dt| self.time + dt > target + TIME_EPS) {
                    let fragments = self.advance(target - self.time)?;
                    // At a non-event no reconnection is needed, but constructing the
                    // same graph keeps offset and roof cap output on the exact mesh.
                    self.resolve(fragments)?;
                    return Ok(());
                }
            }
            let dt = next.ok_or(
                "wavefront did not terminate; this degenerate weight configuration is unsupported",
            )?;
            let fragments = self.advance(dt)?;
            self.resolve(fragments)?;
        }
        Err("wavefront event budget exceeded; simplify almost coincident contour edges".into())
    }
    fn close_faces(&mut self) {
        for lp in &self.loops {
            for (i, v) in lp.iter().enumerate() {
                self.boundaries[self.input.edges[v.right].source]
                    .push((lp[(i + 1) % lp.len()].node, v.node));
            }
        }
    }
    fn faces(&self) -> Result<(Vec<Vec<usize>>, Vec<u32>), String> {
        let mut faces = Vec::new();
        let mut source = Vec::new();
        for (edge, segments) in self.boundaries.iter().enumerate() {
            let mut remaining = BTreeSet::new();
            for &(a, b) in segments {
                if a == b {
                    continue;
                }
                if !remaining.remove(&(b, a)) {
                    remaining.insert((a, b));
                }
            }
            while let Some(&(first, second)) = remaining.first() {
                remaining.remove(&(first, second));
                let mut face = vec![first];
                let mut at = second;
                let mut guard = 0;
                while at != first {
                    face.push(at);
                    let candidates: Vec<_> = remaining
                        .range((at, 0)..=(at, usize::MAX))
                        .copied()
                        .collect();
                    if candidates.is_empty() {
                        return Err(format!(
                            "roof face {edge} has an open boundary at event vertex {at}"
                        ));
                    }
                    let pair = candidates[0];
                    remaining.remove(&pair);
                    at = pair.1;
                    guard += 1;
                    if guard > segments.len() {
                        return Err("roof boundary cycle exceeded its edge count".into());
                    }
                }
                if face.len() >= 3 {
                    faces.push(face);
                    source.push(edge as u32);
                }
            }
        }
        Ok((faces, source))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Skeleton {
    pub arcs: Vec<f64>,
    pub arc_kind: Vec<u8>,
    pub vertices: Vec<f64>,
    pub face_start: Vec<u32>,
    pub face_vertex_index: Vec<u32>,
    pub face_edge: Vec<u32>,
    pub node_time: Vec<f64>,
    pub provenance: Provenance,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Roof {
    pub vertices: Vec<f64>,
    pub face_start: Vec<u32>,
    pub face_vertex_index: Vec<u32>,
    pub face_edge: Vec<u32>,
    pub provenance: Provenance,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Offset {
    pub vertices: Vec<f64>,
    pub polygon_start: Vec<u32>,
    pub polygon_vertex_index: Vec<u32>,
    pub polygon_hole: Vec<u8>,
    pub provenance: Provenance,
}

/// Attribute transfer metadata. Generated points blend the endpoints of their
/// nearest input contour edge; ties use the original input edge index.
#[derive(Clone, Debug, PartialEq)]
pub struct Provenance {
    pub src_point: Vec<i32>,
    pub blend_offset: Vec<u32>,
    pub blend_index: Vec<u32>,
    pub blend_weight: Vec<f32>,
    pub src_prim: Vec<i32>,
    pub src_vertex: Vec<i32>,
}

fn source_ring(input: &Input, edge: u32) -> i32 {
    if edge == u32::MAX {
        return -1;
    }
    let mut end = 0;
    for (i, ring) in input.rings.iter().enumerate() {
        end += ring.len();
        if (edge as usize) < end {
            return i as i32;
        }
    }
    -1
}

fn provenance(input: &Input, nodes: &[Node], indices: &[u32], src_prim: Vec<i32>) -> Provenance {
    let src_point: Vec<i32> = nodes.iter().map(|n| n.source).collect();
    let mut blend_offset = vec![0];
    let mut blend_index = Vec::new();
    let mut blend_weight = Vec::new();
    for node in nodes {
        if node.source < 0 {
            let mut best = (f64::INFINITY, usize::MAX, 0usize, 0usize, 0.0);
            let mut edge_start = 0;
            for (ri, ring) in input.rings.iter().enumerate() {
                for i in 0..ring.len() {
                    let j = (i + 1) % ring.len();
                    let d = ring[j].sub(ring[i]);
                    let t = (node.p.sub(ring[i]).dot(d) / d.dot(d)).clamp(0.0, 1.0);
                    let delta = node.p.sub(ring[i].add(d.mul(t)));
                    let distance = delta.dot(delta);
                    let edge = input.edges[edge_start + i].source;
                    if distance < best.0 || (distance == best.0 && edge < best.1) {
                        best = (distance, edge, input.ids[ri][i], input.ids[ri][j], t);
                    }
                }
                edge_start += ring.len();
            }
            if best.4 < 1.0 {
                blend_index.push(best.2 as u32);
                blend_weight.push((1.0 - best.4) as f32);
            }
            if best.4 > 0.0 {
                blend_index.push(best.3 as u32);
                blend_weight.push(best.4 as f32);
            }
        }
        blend_offset.push(blend_index.len() as u32);
    }
    let src_vertex = indices.iter().map(|i| src_point[*i as usize]).collect();
    Provenance {
        src_point,
        blend_offset,
        blend_index,
        blend_weight,
        src_prim,
        src_vertex,
    }
}

fn compact(s: &Sim, faces: &mut [Vec<usize>]) -> (Vec<Node>, Vec<u32>, Vec<u32>) {
    let mut neighbors = BTreeMap::<usize, BTreeSet<usize>>::new();
    for face in faces.iter() {
        for (&a, &b) in face.iter().zip(face.iter().cycle().skip(1)) {
            neighbors.entry(a).or_default().insert(b);
            neighbors.entry(b).or_default().insert(a);
        }
    }
    let mut remove = BTreeSet::new();
    for (&i, adj) in &neighbors {
        if s.nodes[i].source >= 0 || adj.len() != 2 {
            continue;
        }
        let ends: Vec<usize> = adj.iter().copied().collect();
        let a = s.nodes[ends[0]];
        let b = s.nodes[ends[1]];
        let p = s.nodes[i];
        let d = b.p.sub(a.p);
        let q = p.p.sub(a.p);
        let dt = b.time - a.time;
        let qt = p.time - a.time;
        let norm = (d.dot(d) + dt * dt).sqrt();
        if norm > EPS
            && d.cross(q).abs() <= EPS * norm
            && (d.x * qt - dt * q.x).abs() <= EPS * norm
            && (d.y * qt - dt * q.y).abs() <= EPS * norm
        {
            remove.insert(i);
        }
    }
    for face in faces.iter_mut() {
        face.retain(|i| !remove.contains(i));
    }
    let used: BTreeSet<usize> = faces.iter().flatten().copied().collect();
    let mut remap = BTreeMap::new();
    let mut nodes = Vec::new();
    for i in used {
        remap.insert(i, nodes.len() as u32);
        nodes.push(s.nodes[i]);
    }
    let mut start = vec![0];
    let mut indices = Vec::new();
    for face in faces {
        indices.extend(face.iter().map(|i| remap[i]));
        start.push(indices.len() as u32);
    }
    (nodes, start, indices)
}

pub fn skeleton(outer: &[f64], holes: &[Vec<f64>], weights: &[f64]) -> Result<Skeleton, String> {
    let mut s = Sim::new(Input::new(outer, holes, weights)?, false)?;
    s.run(None)?;
    let (mut faces, face_edge) = s.faces()?;
    let (nodes, face_start, face_vertex_index) = compact(&s, &mut faces);
    let vertices = nodes
        .iter()
        .flat_map(|n| {
            let p = s.input.world(n);
            [p.x, p.y]
        })
        .collect::<Vec<_>>();
    let node_time: Vec<f64> = nodes.iter().map(|n| n.time * s.input.scale).collect();
    if vertices.iter().chain(&node_time).any(|v| !v.is_finite()) {
        return Err(
            "skeleton output exceeds the finite coordinate range; rescale the footprint or weights"
                .into(),
        );
    }
    let provenance = provenance(
        &s.input,
        &nodes,
        &face_vertex_index,
        face_edge
            .iter()
            .map(|e| source_ring(&s.input, *e))
            .collect(),
    );
    let mut edges = BTreeMap::new();
    for face in 0..face_edge.len() {
        let ids = &face_vertex_index[face_start[face] as usize..face_start[face + 1] as usize];
        for (&a, &b) in ids.iter().zip(ids.iter().cycle().skip(1)) {
            edges.insert(
                key(a as usize, b as usize),
                if nodes[a as usize].time == 0.0 && nodes[b as usize].time == 0.0 {
                    1u8
                } else {
                    0u8
                },
            );
        }
    }
    let mut arcs = Vec::new();
    let mut arc_kind = Vec::new();
    for ((a, b), kind) in edges {
        arcs.extend([
            vertices[2 * a],
            vertices[2 * a + 1],
            vertices[2 * b],
            vertices[2 * b + 1],
        ]);
        arc_kind.push(kind);
    }
    Ok(Skeleton {
        arcs,
        arc_kind,
        vertices,
        face_start,
        face_vertex_index,
        face_edge,
        node_time,
        provenance,
    })
}

pub fn offset(outer: &[f64], holes: &[Vec<f64>], distance: f64) -> Result<Offset, String> {
    if !distance.is_finite() {
        return Err("offset distance must be finite".into());
    }
    let mut s = Sim::new(Input::new(outer, holes, &[])?, distance < 0.0)?;
    s.run(Some(distance.abs() / s.input.scale))?;
    let mut vertices = Vec::new();
    let mut polygon_start = vec![0];
    let mut polygon_vertex_index = Vec::new();
    let mut polygon_hole = Vec::new();
    let mut nodes = Vec::new();
    let mut src_prim = Vec::new();
    for lp in &s.loops {
        let points: Vec<P> = lp.iter().map(|v| v.p).collect();
        if area(&points).abs() <= EPS * EPS {
            continue;
        }
        polygon_hole.push(u8::from(area(&points) < 0.0));
        src_prim.push(source_ring(
            &s.input,
            s.input.edges[lp[0].right].source as u32,
        ));
        for v in lp {
            polygon_vertex_index.push((vertices.len() / 2) as u32);
            let n = s.nodes[v.node];
            let p = s.input.world(&n);
            nodes.push(n);
            vertices.extend([p.x, p.y]);
        }
        polygon_start.push(polygon_vertex_index.len() as u32);
    }
    if vertices.iter().any(|v| !v.is_finite()) {
        return Err("offset output exceeds the finite coordinate range; rescale the footprint or reduce distance".into());
    }
    let provenance = provenance(&s.input, &nodes, &polygon_vertex_index, src_prim);
    Ok(Offset {
        vertices,
        polygon_start,
        polygon_vertex_index,
        polygon_hole,
        provenance,
    })
}

pub fn roof_mesh(
    outer: &[f64],
    holes: &[Vec<f64>],
    pitch: &[f64],
    height_cap: Option<f64>,
) -> Result<Roof, String> {
    if pitch.is_empty()
        || pitch
            .iter()
            .any(|p| !p.is_finite() || *p <= 0.0 || *p > 90.0)
    {
        return Err("roof pitch must be in (0, 90] degrees; 90 is a vertical gable".into());
    }
    if height_cap.is_some_and(|h| !h.is_finite() || h <= 0.0) {
        return Err("height_cap must be finite and positive".into());
    }
    let weights: Vec<f64> = pitch
        .iter()
        .map(|p| {
            if *p == 90.0 {
                0.0
            } else {
                1.0 / libm::tan(*p * (std::f64::consts::PI / 180.0))
            }
        })
        .collect();
    let mut s = Sim::new(Input::new(outer, holes, &weights)?, false)?;
    s.run(height_cap.map(|h| h / s.input.scale))?;
    s.close_faces();
    let (mut faces, mut face_edge) = s.faces()?;
    if !s.loops.is_empty() {
        let outer_loops: Vec<usize> = s
            .loops
            .iter()
            .enumerate()
            .filter(|(_, lp)| area(&lp.iter().map(|v| v.p).collect::<Vec<_>>()) > 0.0)
            .map(|(i, _)| i)
            .collect();
        for oi in outer_loops {
            let mut data = Vec::new();
            let mut map = Vec::new();
            let mut holes_start = Vec::new();
            let ring: Vec<P> = s.loops[oi].iter().map(|v| v.p).collect();
            for v in &s.loops[oi] {
                data.extend([v.p.x, v.p.y]);
                map.push(v.node);
            }
            for (i, lp) in s.loops.iter().enumerate() {
                let points: Vec<P> = lp.iter().map(|v| v.p).collect();
                if i == oi || area(&points) > 0.0 || !inside(points[0], &ring) {
                    continue;
                }
                holes_start.push(map.len());
                for v in lp {
                    data.extend([v.p.x, v.p.y]);
                    map.push(v.node);
                }
            }
            let triangles = earcutr::earcut(&data, &holes_start, 2)
                .map_err(|_| "could not triangulate the flat roof cap")?;
            for tri in triangles.chunks_exact(3) {
                let mut face = vec![map[tri[0]], map[tri[1]], map[tri[2]]];
                if orient(s.nodes[face[0]].p, s.nodes[face[1]].p, s.nodes[face[2]].p) < 0.0 {
                    face.reverse();
                }
                faces.push(face);
                face_edge.push(u32::MAX);
            }
        }
    }
    let (nodes, face_start, face_vertex_index) = compact(&s, &mut faces);
    let vertices: Vec<f64> = nodes
        .iter()
        .flat_map(|n| {
            let p = s.input.world(n);
            [p.x, p.y, n.time * s.input.scale]
        })
        .collect();
    if vertices.iter().any(|v| !v.is_finite()) {
        return Err("roof output exceeds the finite coordinate range; rescale the footprint or reduce pitch".into());
    }
    let provenance = provenance(
        &s.input,
        &nodes,
        &face_vertex_index,
        face_edge
            .iter()
            .map(|e| source_ring(&s.input, *e))
            .collect(),
    );
    Ok(Roof {
        vertices,
        face_start,
        face_vertex_index,
        face_edge,
        provenance,
    })
}
