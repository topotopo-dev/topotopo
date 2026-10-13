//! Weighted sample elimination and exact greedy minimum-distance selection.
//!
//! The f64 entry points preserve the TypeScript KD layout, stable neighbour order,
//! floating-point operation order and left-child heap ties. The f32 ABI widens
//! inputs before doing the same work; it does not round existing f64 geometry.

/// Resource bounds also keep indices and aggregate CSR offsets within i32.
pub const MAX_POINTS: usize = 5_000_000;
pub const MAX_NEIGHBOURS: usize = 64_000_000;
const MAX_COORD: f64 = 1e150;

pub(crate) fn validate_positions(positions: &[f64]) -> Result<usize, String> {
    if !positions.len().is_multiple_of(3) {
        return Err("scatter positions length must be divisible by three".into());
    }
    let n = positions.len() / 3;
    if n > MAX_POINTS {
        return Err(format!("scatter supports at most {MAX_POINTS} candidates"));
    }
    if positions
        .iter()
        .any(|v| !v.is_finite() || v.abs() > MAX_COORD)
    {
        return Err("scatter positions must be finite and have magnitude <= 1e150".into());
    }
    Ok(n)
}

/// Kahan-scaled hypotenuse, in the same operation order as core/math.ts.
pub(crate) fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    let [ax, ay, az] = [x.abs(), y.abs(), z.abs()];
    let m = ax.max(ay).max(az);
    if m == 0.0 {
        return 0.0;
    }
    let [n0, n1, n2] = [ax / m, ay / m, az / m];
    let s0 = n0 * n0;
    let s1 = n1 * n1;
    let t = s0 + s1;
    let c = (t - s0) - s1;
    (t + (n2 * n2 - c)).sqrt() * m
}

fn reserved<T>(capacity: usize) -> Result<Vec<T>, String> {
    let mut values = Vec::new();
    values
        .try_reserve_exact(capacity)
        .map_err(|_| "scatter allocation failed; reduce candidates or radius".to_string())?;
    Ok(values)
}

fn filled<T: Clone>(count: usize, value: T) -> Result<Vec<T>, String> {
    let mut values = reserved(count)?;
    values.resize(count, value);
    Ok(values)
}

fn grow_bounded<T>(values: &mut Vec<T>, needed: usize, limit: usize) -> Result<(), String> {
    if needed > limit {
        return Err("scatter neighbour budget exceeded; reduce candidates or radius".into());
    }
    if needed > values.capacity() {
        let capacity = needed
            .max(values.capacity().saturating_mul(3) / 2)
            .min(limit);
        values
            .try_reserve_exact(capacity - values.len())
            .map_err(|_| "scatter allocation failed; reduce candidates or radius".to_string())?;
    }
    Ok(())
}

pub(crate) struct KdTree {
    pub positions: Vec<f64>,
    pub indices: Vec<usize>,
    pub axes: Vec<usize>,
}

#[derive(Clone, Copy)]
pub(crate) struct Neighbour {
    pub index: usize,
    pub slot: usize,
    pub distance2: f64,
}

impl KdTree {
    pub fn new(positions: &[f64]) -> Result<Self, String> {
        let n = positions.len() / 3;
        let mut coordinates = reserved(positions.len())?;
        coordinates.extend_from_slice(positions);
        let mut indices = reserved(n)?;
        indices.extend(0..n);
        let mut tree = Self {
            positions: coordinates,
            indices,
            axes: filled(n, 0)?,
        };
        tree.build(0, n);
        Ok(tree)
    }

    fn build(&mut self, lo: usize, hi: usize) {
        if hi - lo <= 1 {
            return;
        }
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for p in self.positions[lo * 3..hi * 3].chunks_exact(3) {
            for a in 0..3 {
                min[a] = min[a].min(p[a]);
                max[a] = max[a].max(p[a]);
            }
        }
        let ex = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        let axis = if ex[0] >= ex[1] && ex[0] >= ex[2] {
            0
        } else if ex[1] >= ex[2] {
            1
        } else {
            2
        };
        let mid = (lo + hi) / 2;
        self.select(lo, hi - 1, mid, axis);
        self.axes[mid] = axis;
        self.build(lo, mid);
        self.build(mid + 1, hi);
    }

    fn select(&mut self, lo: usize, hi: usize, k: usize, axis: usize) {
        let (mut l, mut r) = (lo as isize, hi as isize);
        while r > l {
            let pivot = self.positions[((l + r) / 2) as usize * 3 + axis];
            let (mut i, mut j) = (l, r);
            while i <= j {
                while self.positions[i as usize * 3 + axis] < pivot {
                    i += 1;
                }
                while self.positions[j as usize * 3 + axis] > pivot {
                    j -= 1;
                }
                if i <= j {
                    self.indices.swap(i as usize, j as usize);
                    for a in 0..3 {
                        self.positions.swap(i as usize * 3 + a, j as usize * 3 + a);
                    }
                    i += 1;
                    j -= 1;
                }
            }
            if k as isize <= j {
                r = j;
            } else if k as isize >= i {
                l = i;
            } else {
                break;
            }
        }
    }

    pub fn neighbours(&self, p: [f64; 3], radius: f64, out: &mut Vec<Neighbour>) {
        out.clear();
        if self.indices.is_empty() {
            return;
        }
        // A balanced tree over MAX_POINTS needs fewer than 24 deferred ranges.
        let mut stack = [(0, 0); 64];
        stack[0] = (0, self.indices.len());
        let mut len = 1;
        let r2 = radius * radius;
        while len > 0 {
            len -= 1;
            let (lo, hi) = stack[len];
            if lo >= hi {
                continue;
            }
            let mid = (lo + hi) / 2;
            let ax = self.axes[mid];
            let dx = self.positions[mid * 3] - p[0];
            let dy = self.positions[mid * 3 + 1] - p[1];
            let dz = self.positions[mid * 3 + 2] - p[2];
            let distance2 = dx * dx + dy * dy + dz * dz;
            if distance2 <= r2 {
                out.push(Neighbour {
                    index: self.indices[mid],
                    slot: mid,
                    distance2,
                });
            }
            if hi - lo == 1 {
                continue;
            }
            let diff = p[ax] - self.positions[mid * 3 + ax];
            if diff >= -radius {
                stack[len] = (mid + 1, hi);
                len += 1;
            }
            if diff <= radius {
                stack[len] = (lo, mid);
                len += 1;
            }
        }
        // Stable ordering preserves preorder for equal squared distances.
        if out.len() <= 32 {
            for k in 1..out.len() {
                let value = out[k];
                let mut j = k;
                while j > 0 && out[j - 1].distance2 > value.distance2 {
                    out[j] = out[j - 1];
                    j -= 1;
                }
                out[j] = value;
            }
        } else {
            out.sort_by(|a, b| a.distance2.total_cmp(&b.distance2));
        }
    }
}

struct Lists {
    start: Vec<usize>,
    neighbours: Vec<usize>,
    contributions: Vec<f64>,
    weights: Vec<f64>,
}

/// A dense grid is worthwhile for flat and compact candidate sets. Sorting by
/// distance and KD preorder reproduces the KD query's stable order exactly.
/// Sparse/extreme domains retain KD queries rather than allocating their volume.
struct SearchGrid {
    heads: Vec<usize>,
    next: Vec<usize>,
    rank: Vec<usize>,
    origin: [i64; 3],
    dims: [usize; 3],
    inv: f64,
}

impl SearchGrid {
    fn new(kd: &KdTree, cell: f64) -> Option<Self> {
        let n = kd.indices.len();
        if n < 256 || cell * cell < f64::MIN_POSITIVE {
            return None;
        }
        let inv = 1.0 / cell;
        let mut low = [i64::MAX; 3];
        let mut high = [i64::MIN; 3];
        for p in kd.positions.chunks_exact(3) {
            for c in 0..3 {
                let x = (p[c] * inv).floor();
                if !x.is_finite() || x.abs() > 4_503_599_627_370_492.0 {
                    return None;
                }
                low[c] = low[c].min(x as i64);
                high[c] = high[c].max(x as i64);
            }
        }
        let dims = std::array::from_fn(|c| (high[c] - low[c] + 1) as usize);
        let size = dims[0].checked_mul(dims[1])?.checked_mul(dims[2])?;
        if size > n.saturating_mul(4) || size > 16_000_000 {
            return None;
        }
        let mut heads = Vec::new();
        heads.try_reserve_exact(size).ok()?;
        heads.resize(size, usize::MAX);
        let mut next = filled(n, usize::MAX).ok()?;
        for (s, p) in kd.positions.chunks_exact(3).enumerate() {
            let cell: [usize; 3] =
                std::array::from_fn(|c| ((p[c] * inv).floor() as i64 - low[c]) as usize);
            let k = (cell[0] * dims[1] + cell[1]) * dims[2] + cell[2];
            next[s] = heads[k];
            heads[k] = s;
        }
        let mut rank = filled(n, 0).ok()?;
        fn preorder(rank: &mut [usize], lo: usize, hi: usize, counter: &mut usize) {
            if lo >= hi {
                return;
            }
            let mid = (lo + hi) / 2;
            rank[mid] = *counter;
            *counter += 1;
            preorder(rank, lo, mid, counter);
            preorder(rank, mid + 1, hi, counter);
        }
        preorder(&mut rank, 0, n, &mut 0);
        Some(Self {
            heads,
            next,
            rank,
            origin: low,
            dims,
            inv,
        })
    }

    fn neighbours(&self, kd: &KdTree, p: [f64; 3], radius: f64, out: &mut Vec<Neighbour>) {
        if radius * radius < f64::MIN_POSITIVE || radius * self.inv > 4_503_599_627_370_492.0 {
            kd.neighbours(p, radius, out);
            return;
        }
        out.clear();
        // Outward rounding covers cell-boundary arithmetic without searching
        // a full extra ring of cells on every query.
        let lo: [usize; 3] = std::array::from_fn(|c| {
            let q = (((p[c] - radius).next_down() * self.inv).next_down().floor() as i64
                - self.origin[c])
                .max(0);
            q.min(self.dims[c] as i64 - 1) as usize
        });
        let hi: [usize; 3] = std::array::from_fn(|c| {
            let q = (((p[c] + radius).next_up() * self.inv).next_up().floor() as i64
                - self.origin[c])
                .max(0);
            q.min(self.dims[c] as i64 - 1) as usize
        });
        let r2 = radius * radius;
        for x in lo[0]..=hi[0] {
            for y in lo[1]..=hi[1] {
                for z in lo[2]..=hi[2] {
                    let mut s = self.heads[(x * self.dims[1] + y) * self.dims[2] + z];
                    while s != usize::MAX {
                        let dx = kd.positions[s * 3] - p[0];
                        let dy = kd.positions[s * 3 + 1] - p[1];
                        let dz = kd.positions[s * 3 + 2] - p[2];
                        let distance2 = dx * dx + dy * dy + dz * dz;
                        if distance2 <= r2 {
                            out.push(Neighbour {
                                index: kd.indices[s],
                                slot: s,
                                distance2,
                            });
                        }
                        s = self.next[s];
                    }
                }
            }
        }
        out.sort_unstable_by(|a, b| {
            a.distance2
                .total_cmp(&b.distance2)
                .then_with(|| self.rank[a.slot].cmp(&self.rank[b.slot]))
        });
    }
}

fn contribution(distance: f64, radius: f64) -> f64 {
    let base = 1.0 - distance.min(radius) / radius;
    let square = base * base;
    let fourth = square * square;
    fourth * fourth
}

fn uniform_lists(kd: &KdTree, radius: f64) -> Result<Lists, String> {
    let n = kd.indices.len();
    let mut lists = Lists {
        start: reserved(n + 1)?,
        neighbours: reserved(n.saturating_mul(24).min(MAX_NEIGHBOURS))?,
        contributions: reserved(n.saturating_mul(24).min(MAX_NEIGHBOURS))?,
        weights: filled(n, 0.0)?,
    };
    let mut found = Vec::with_capacity(64);
    let grid = SearchGrid::new(kd, radius);
    for s in 0..n {
        lists.start.push(lists.neighbours.len());
        let p = [
            kd.positions[s * 3],
            kd.positions[s * 3 + 1],
            kd.positions[s * 3 + 2],
        ];
        if let Some(grid) = &grid {
            grid.neighbours(kd, p, radius, &mut found);
        } else {
            kd.neighbours(p, radius, &mut found);
        }
        if lists.neighbours.len() + found.len().saturating_sub(1) > MAX_NEIGHBOURS {
            return Err("scatter neighbour budget exceeded; reduce candidates or radius".into());
        }
        let needed = lists.neighbours.len() + found.len().saturating_sub(1);
        grow_bounded(&mut lists.neighbours, needed, MAX_NEIGHBOURS)?;
        grow_bounded(&mut lists.contributions, needed, MAX_NEIGHBOURS)?;
        for neighbour in &found {
            let b = neighbour.slot;
            if b == s {
                continue;
            }
            let d = hypot3(
                p[0] - kd.positions[b * 3],
                p[1] - kd.positions[b * 3 + 1],
                p[2] - kd.positions[b * 3 + 2],
            );
            let c = contribution(d, radius);
            lists.neighbours.push(b);
            lists.contributions.push(c);
            lists.weights[s] += c;
        }
    }
    lists.start.push(lists.neighbours.len());
    Ok(lists)
}

fn varying_lists(
    kd: &KdTree,
    positions: &[f64],
    scale: &[f64],
    rmax: f64,
) -> Result<Lists, String> {
    let n = kd.indices.len();
    let mut pairs = reserved(n.saturating_mul(12).min(MAX_NEIGHBOURS / 2))?;
    let mut pstart = reserved(n + 1)?;
    let mut degree = filled(n, 0_usize)?;
    let mut found = Vec::with_capacity(64);
    let grid = SearchGrid::new(kd, 2.0 * rmax);
    for i in 0..n {
        pstart.push(pairs.len());
        let p = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
        let si = scale[i];
        if let Some(grid) = &grid {
            grid.neighbours(kd, p, 2.0 * rmax * si, &mut found);
        } else {
            kd.neighbours(p, 2.0 * rmax * si, &mut found);
        }
        for neighbour in &found {
            let j = neighbour.index;
            if j == i || scale[j] > si || (scale[j] == si && j < i) {
                continue;
            }
            let radius = rmax * (si + scale[j]);
            let d = hypot3(
                p[0] - positions[j * 3],
                p[1] - positions[j * 3 + 1],
                p[2] - positions[j * 3 + 2],
            );
            if d >= radius {
                continue;
            }
            if pairs.len() == MAX_NEIGHBOURS / 2 {
                return Err(
                    "scatter neighbour budget exceeded; reduce candidates or radius".into(),
                );
            }
            let needed = pairs.len() + 1;
            grow_bounded(&mut pairs, needed, MAX_NEIGHBOURS / 2)?;
            pairs.push((j, contribution(d, radius)));
            degree[i] += 1;
            degree[j] += 1;
        }
    }
    pstart.push(pairs.len());
    let mut start = reserved(n + 1)?;
    start.push(0);
    for i in 0..n {
        start.push(start[i] + degree[i]);
    }
    let mut fill = reserved(n)?;
    fill.extend_from_slice(&start[..n]);
    let mut lists = Lists {
        start,
        neighbours: filled(pairs.len() * 2, 0)?,
        contributions: filled(pairs.len() * 2, 0.0)?,
        weights: filled(n, 0.0)?,
    };
    // Pair discovery order gives each endpoint exactly the TS addition order.
    for i in 0..n {
        for &(j, c) in &pairs[pstart[i]..pstart[i + 1]] {
            for (a, b) in [(i, j), (j, i)] {
                lists.neighbours[fill[a]] = b;
                lists.contributions[fill[a]] = c;
                fill[a] += 1;
                lists.weights[a] += c;
            }
        }
    }
    Ok(lists)
}

struct Heap {
    labels: Vec<usize>,
    weights: Vec<f64>,
    at: Vec<usize>,
    size: usize,
}

impl Heap {
    fn sift_down(&mut self, mut k: usize, x: usize, weight: f64) {
        loop {
            let l = 2 * k + 1;
            let r = l + 1;
            let mut m = k;
            let mut mw = weight;
            if l < self.size && self.weights[l] > mw {
                m = l;
                mw = self.weights[l];
            }
            if r < self.size && self.weights[r] > mw {
                m = r;
                mw = self.weights[r];
            }
            if m == k {
                break;
            }
            let c = self.labels[m];
            self.labels[k] = c;
            self.weights[k] = mw;
            self.at[c] = k;
            k = m;
        }
        self.labels[k] = x;
        self.weights[k] = weight;
        self.at[x] = k;
    }
}

/// Remove heaviest samples until exactly target_count remain, returned ascending.
/// Optional scale multiplies each sample's radius; it is not a probability weight.
/// Elimination encourages spacing but does not impose a hard minimum distance.
pub fn eliminate(
    positions: &[f64],
    scale: &[f64],
    target_count: usize,
    rmax: f64,
) -> Result<Vec<i32>, String> {
    let mut profile = crate::erosion_profile::Profile::new("scatter_eliminate");
    let n = validate_positions(positions)?;
    if !rmax.is_finite() || rmax <= 0.0 || rmax > MAX_COORD / 2.0 {
        return Err("scatter rmax must be finite, positive and <= 5e149".into());
    }
    if !scale.is_empty() && scale.len() != n {
        return Err("scatter scale length must match the candidate count or be empty".into());
    }
    if scale.iter().any(|s| {
        !s.is_finite()
            || *s <= 0.0
            || *s > f64::MAX / 2.0
            || 2.0 * rmax * *s == 0.0
            || 2.0 * rmax * *s > MAX_COORD
    }) {
        return Err("scatter scales must be finite, positive and have bounded radii".into());
    }
    if target_count >= n {
        return Ok((0..n as i32).collect());
    }
    if target_count == 0 {
        return Ok(Vec::new());
    }
    let kd = KdTree::new(positions)?;
    profile.mark("kd_build");
    let mut labels = reserved(n)?;
    labels.extend(0..n);
    let lists = if scale.is_empty() {
        for slot in 0..n {
            labels[kd.indices[slot]] = slot;
        }
        uniform_lists(&kd, 2.0 * rmax)?
    } else {
        varying_lists(&kd, positions, scale, rmax)?
    };
    profile.mark("neighbours");
    let mut heap_labels = reserved(n)?;
    heap_labels.extend_from_slice(&labels);
    let mut heap = Heap {
        labels: heap_labels,
        weights: filled(n, 0.0)?,
        at: filled(n, 0)?,
        size: n,
    };
    for (i, &a) in labels.iter().enumerate() {
        heap.at[a] = i;
        heap.weights[i] = lists.weights[a];
    }
    for k in (0..n / 2).rev() {
        heap.sift_down(k, heap.labels[k], heap.weights[k]);
    }
    profile.mark("heap_build");
    while heap.size > target_count {
        let a = heap.labels[0];
        heap.at[a] = usize::MAX;
        heap.size -= 1;
        if heap.size > 0 {
            heap.sift_down(0, heap.labels[heap.size], heap.weights[heap.size]);
        }
        for e in lists.start[a]..lists.start[a + 1] {
            let b = lists.neighbours[e];
            let k = heap.at[b];
            if k == usize::MAX {
                continue;
            }
            heap.sift_down(k, b, heap.weights[k] - lists.contributions[e]);
        }
    }
    profile.mark("heap_remove");
    profile.finish();
    Ok(labels
        .iter()
        .enumerate()
        .filter_map(|(i, &a)| (heap.at[a] != usize::MAX).then_some(i as i32))
        .collect())
}

fn cell_key(x: i64, y: i64, z: i64) -> u32 {
    (x as u32).wrapping_mul(73_856_093)
        ^ (y as u32).wrapping_mul(19_349_663)
        ^ (z as u32).wrapping_mul(83_492_791)
}

/// Greedy dart throwing in the supplied order, optionally capped per group.
/// A zero radius only applies order/limit/group filtering. Distances equal to the
/// radius are accepted. Empty groups or a zero cap disable the group restriction.
pub fn min_distance(
    positions: &[f64],
    order: &[i32],
    radius: f64,
    limit: usize,
    groups: &[i32],
    group_cap: usize,
) -> Result<Vec<i32>, String> {
    let n = validate_positions(positions)?;
    if order.len() > MAX_POINTS || order.iter().any(|&i| i < 0 || i as usize >= n) {
        return Err("scatter order contains an invalid candidate index or is too long".into());
    }
    if !radius.is_finite()
        || !(0.0..=MAX_COORD).contains(&radius)
        || (radius > 0.0 && radius * radius == 0.0)
    {
        return Err("scatter minimum distance must be finite, within 0..1e150 and have a nonzero squared radius when positive".into());
    }
    if !groups.is_empty() && (groups.len() != n || groups.iter().any(|&g| g < 0)) {
        return Err(
            "scatter groups must be empty or contain one nonnegative group per candidate".into(),
        );
    }
    let limit = limit.min(order.len());
    let mut out = reserved(limit)?;
    if limit == 0 {
        return Ok(out);
    }
    let inv = if radius > 0.0 { 1.0 / radius } else { 0.0 };
    if radius > 0.0
        && (!inv.is_finite()
            || positions
                .iter()
                .any(|v| (v * inv).abs() > 4_503_599_627_370_492.0))
    {
        return Err("scatter position/radius ratio exceeds the exact grid coordinate range".into());
    }
    let table_size = (order.len().saturating_mul(2)).max(16).next_power_of_two();
    let mut heads = filled(table_size, usize::MAX)?;
    let mut next = reserved(limit)?;
    let mut keys = reserved(limit)?;
    let mut counts = std::collections::HashMap::<i32, usize>::new();
    let capped = group_cap > 0 && !groups.is_empty();
    let r2 = radius * radius;
    let span = (radius * inv).ceil().max(1.0) as i64;
    for &candidate in order {
        if out.len() == limit {
            break;
        }
        let i = candidate as usize;
        if capped && counts.get(&groups[i]).copied().unwrap_or(0) >= group_cap {
            continue;
        }
        let p = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
        let cell = [
            (p[0] * inv).floor() as i64,
            (p[1] * inv).floor() as i64,
            (p[2] * inv).floor() as i64,
        ];
        let mut conflict = false;
        if radius > 0.0 {
            'cells: for x in cell[0] - span..=cell[0] + span {
                for y in cell[1] - span..=cell[1] + span {
                    for z in cell[2] - span..=cell[2] + span {
                        let key = cell_key(x, y, z);
                        let mut e = heads[key as usize & (table_size - 1)];
                        while e != usize::MAX {
                            if keys[e] == key {
                                let j = out[e] as usize;
                                let dx = positions[j * 3] - p[0];
                                let dy = positions[j * 3 + 1] - p[1];
                                let dz = positions[j * 3 + 2] - p[2];
                                if dx * dx + dy * dy + dz * dz < r2 {
                                    conflict = true;
                                    break 'cells;
                                }
                            }
                            e = next[e];
                        }
                    }
                }
            }
        }
        if conflict {
            continue;
        }
        let key = cell_key(cell[0], cell[1], cell[2]);
        let bucket = key as usize & (table_size - 1);
        next.push(heads[bucket]);
        keys.push(key);
        heads[bucket] = out.len();
        out.push(candidate);
        if capped {
            counts
                .try_reserve(1)
                .map_err(|_| "scatter group allocation failed; reduce candidates".to_string())?;
            *counts.entry(groups[i]).or_default() += 1;
        }
    }
    Ok(out)
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    fn integer(value: f64, name: &str) -> Result<usize, JsValue> {
        if !value.is_finite()
            || value < 0.0
            || value.fract() != 0.0
            || value > super::MAX_POINTS as f64
        {
            return Err(JsValue::from_str(&format!(
                "scatter {name} must be an integer in 0..{}",
                super::MAX_POINTS
            )));
        }
        Ok(value as usize)
    }

    #[wasm_bindgen]
    pub fn scatter_eliminate_f64(
        positions: &[f64],
        scale: &[f64],
        target_count: f64,
        r_max: f64,
    ) -> Result<Vec<i32>, JsValue> {
        super::eliminate(
            positions,
            scale,
            integer(target_count, "target_count")?,
            r_max,
        )
        .map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn scatter_eliminate(
        positions: &[f32],
        scale: &[f32],
        target_count: f64,
        r_max: f64,
    ) -> Result<Vec<i32>, JsValue> {
        let positions: Vec<f64> = positions.iter().map(|&v| f64::from(v)).collect();
        let scale: Vec<f64> = scale.iter().map(|&v| f64::from(v)).collect();
        scatter_eliminate_f64(&positions, &scale, target_count, r_max)
    }

    #[wasm_bindgen]
    pub fn scatter_min_distance_f64(
        positions: &[f64],
        order: &[i32],
        radius: f64,
        limit: f64,
        groups: &[i32],
        group_cap: f64,
    ) -> Result<Vec<i32>, JsValue> {
        let limit = if limit == f64::INFINITY {
            order.len()
        } else {
            integer(limit, "limit")?
        };
        super::min_distance(
            positions,
            order,
            radius,
            limit,
            groups,
            integer(group_cap, "group_cap")?,
        )
        .map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn scatter_min_distance(
        positions: &[f32],
        order: &[i32],
        radius: f64,
        limit: f64,
        groups: &[i32],
        group_cap: f64,
    ) -> Result<Vec<i32>, JsValue> {
        let positions: Vec<f64> = positions.iter().map(|&v| f64::from(v)).collect();
        scatter_min_distance_f64(&positions, order, radius, limit, groups, group_cap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn points(n: usize, seed: u32) -> Vec<f64> {
        let mut s = seed;
        (0..n * 3)
            .map(|k| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                if k % 3 == 1 {
                    0.0
                } else {
                    f64::from(s) / 4_294_967_296.0
                }
            })
            .collect()
    }

    #[test]
    fn exact_counts_determinism_and_subsets() {
        for seed in 0..12 {
            let p = points(96, seed);
            for target in [0, 1, 11, 32, 95, 96, 120] {
                for scale in [
                    Vec::new(),
                    (0..96).map(|i| 0.5 + (i % 7) as f64 / 6.0).collect(),
                ] {
                    let a = eliminate(&p, &scale, target, 0.1).unwrap();
                    assert_eq!(a.len(), target.min(96));
                    assert_eq!(a, eliminate(&p, &scale, target, 0.1).unwrap());
                    assert!(a.windows(2).all(|v| v[0] < v[1]));
                    assert!(a.iter().all(|&v| (0..96).contains(&v)));
                }
            }
        }
    }

    #[test]
    fn grid_queries_preserve_kd_preorder_and_distance_ties() {
        for seed in 0..8 {
            let mut p = points(384, seed);
            if seed % 2 == 0 {
                for v in &mut p {
                    *v = (*v * 16.0).round() / 16.0;
                }
            }
            let kd = KdTree::new(&p).unwrap();
            let grid = SearchGrid::new(&kd, 0.13).unwrap();
            let (mut a, mut b) = (Vec::new(), Vec::new());
            for i in 0..384 {
                let q = [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
                for radius in [0.0, 0.025, 0.13, 0.26, 0.52] {
                    kd.neighbours(q, radius, &mut a);
                    grid.neighbours(&kd, q, radius, &mut b);
                    assert_eq!(
                        a.iter()
                            .map(|n| (n.slot, n.distance2.to_bits()))
                            .collect::<Vec<_>>(),
                        b.iter()
                            .map(|n| (n.slot, n.distance2.to_bits()))
                            .collect::<Vec<_>>()
                    );
                }
            }
        }
        // Huge valid adaptive radii must fall back before converting an
        // unbounded search extent to integer grid coordinates.
        let p = vec![1e-150; 384 * 3];
        let kd = KdTree::new(&p).unwrap();
        let grid = SearchGrid::new(&kd, 2e-151).unwrap();
        let (mut a, mut b) = (Vec::new(), Vec::new());
        kd.neighbours([1e-150; 3], 1e147, &mut a);
        grid.neighbours(&kd, [1e-150; 3], 1e147, &mut b);
        assert_eq!(
            a.iter().map(|n| n.slot).collect::<Vec<_>>(),
            b.iter().map(|n| n.slot).collect::<Vec<_>>()
        );
    }

    #[test]
    fn matches_typescript_reference_and_composed_spacing() {
        // Generated directly with sampleEliminate and KDTree in core/scatter.ts.
        let p = points(24, 7);
        assert_eq!(
            KdTree::new(&p).unwrap().indices,
            [
                19, 2, 10, 18, 14, 6, 13, 11, 20, 8, 12, 5, 9, 0, 16, 15, 22, 17, 4, 7, 21, 23, 3,
                1
            ]
        );
        let kept = eliminate(&p, &[], 7, 0.25).unwrap();
        assert_eq!(kept, [1, 2, 5, 11, 16, 17, 21]);
        let scale: Vec<f64> = (0..24).map(|i| 0.5 + (i % 7) as f64 / 6.0).collect();
        assert_eq!(
            eliminate(&p, &scale, 7, 0.25).unwrap(),
            [1, 2, 8, 9, 14, 15, 21]
        );
        // WSE itself has no hard r_min theorem for arbitrary candidates. Applying
        // the exact pass at this computed uniform spacing does enforce the bound.
        let r_min = (1.0 / (7.0 * 2.0 * 3.0_f64.sqrt())).sqrt();
        let spaced = min_distance(&p, &kept, r_min, kept.len(), &[], 0).unwrap();
        for (a, &i) in spaced.iter().enumerate() {
            for &j in &spaced[a + 1..] {
                let i = i as usize * 3;
                let j = j as usize * 3;
                let d = hypot3(p[i] - p[j], p[i + 1] - p[j + 1], p[i + 2] - p[j + 2]);
                assert!(d + 1e-14 >= r_min);
            }
        }
    }

    #[test]
    fn greedy_minimum_matches_brute_force_and_spacing() {
        for seed in 0..20 {
            let p = points(128, seed);
            let order: Vec<i32> = (0..128).rev().collect();
            let radius = 0.025 + f64::from(seed) * 0.005;
            let mut brute = Vec::new();
            for &i in &order {
                if brute.iter().all(|&j: &i32| {
                    let i = i as usize * 3;
                    let j = j as usize * 3;
                    let dx = p[i] - p[j];
                    let dy = p[i + 1] - p[j + 1];
                    let dz = p[i + 2] - p[j + 2];
                    dx * dx + dy * dy + dz * dz >= radius * radius
                }) {
                    brute.push(i);
                }
            }
            let actual = min_distance(&p, &order, radius, order.len(), &[], 0).unwrap();
            assert_eq!(actual, brute);
            assert_eq!(
                actual,
                min_distance(&p, &order, radius, order.len(), &[], 0).unwrap()
            );
        }
    }

    #[test]
    fn exact_radius_groups_and_degenerate_inputs() {
        let p = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0];
        assert_eq!(
            min_distance(&p, &[0, 1, 2, 3], 1.0, 4, &[], 0).unwrap(),
            [0, 1, 3]
        );
        assert_eq!(
            min_distance(&p, &[3, 2, 1, 0], 0.0, 4, &[5, 5, 7, 7], 1).unwrap(),
            [3, 1]
        );
        assert_eq!(eliminate(&[0.0; 90], &[], 7, 1.0).unwrap().len(), 7);
        assert_eq!(eliminate(&[], &[], 0, 1.0).unwrap(), []);
        assert_eq!(min_distance(&[], &[], 0.0, 0, &[], 0).unwrap(), []);
    }

    #[test]
    fn rejects_hostile_inputs_without_panics() {
        for p in [
            vec![0.0],
            vec![f64::NAN; 3],
            vec![f64::INFINITY; 3],
            vec![1e151; 3],
        ] {
            assert!(eliminate(&p, &[], 1, 1.0).is_err());
            assert!(min_distance(&p, &[0], 1.0, 1, &[], 0).is_err());
        }
        let p = points(8, 0);
        for radius in [f64::NAN, f64::INFINITY, -1.0, 1e151] {
            assert!(eliminate(&p, &[], 2, radius).is_err());
            assert!(min_distance(&p, &[0], radius, 1, &[], 0).is_err());
        }
        for scale in [
            vec![1.0],
            vec![0.0; 8],
            vec![-1.0; 8],
            vec![f64::NAN; 8],
            vec![f64::INFINITY; 8],
        ] {
            assert!(eliminate(&p, &scale, 2, 1.0).is_err());
        }
        assert!(eliminate(&p, &[1e-300; 8], 2, 1e-300).is_err());
        assert!(eliminate(&p, &[f64::MAX; 8], 2, 1e-300).is_err());
        for order in [vec![-1], vec![8], vec![i32::MAX]] {
            assert!(min_distance(&p, &order, 1.0, 1, &[], 0).is_err());
        }
        assert!(min_distance(&p, &[0], f64::MIN_POSITIVE, 1, &[], 0).is_err());
        assert!(min_distance(&[0.0; 6], &[0, 1], 1e-200, 2, &[], 0).is_err());
        assert!(min_distance(&p, &[0], 1.0, 1, &[1], 1).is_err());
        assert!(min_distance(&p, &[0], 1.0, 1, &[-1; 8], 1).is_err());
    }
}
