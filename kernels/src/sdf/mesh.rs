use super::{Grid, fill_distances, layout_len};

type V3 = [f64; 3];
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[derive(Clone)]
struct Triangle {
    p: [V3; 3],
    min: V3,
    max: V3,
    centroid: V3,
    area_vector: V3,
    area: f64,
}

struct Node {
    min: V3,
    max: V3,
    center: V3,
    radius_squared: f64,
    area_vector: V3,
    start: usize,
    end: usize,
    children: Option<[usize; 2]>,
}

struct Bvh {
    triangles: Vec<Triangle>,
    order: Vec<usize>,
    nodes: Vec<Node>,
}

impl Bvh {
    fn build(triangles: Vec<Triangle>) -> Self {
        let count = triangles.len();
        let mut bvh = Self {
            triangles,
            order: (0..count).collect(),
            nodes: Vec::with_capacity(count / 2 + 1),
        };
        bvh.build_node(0, count);
        bvh
    }

    fn build_node(&mut self, start: usize, end: usize) -> usize {
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        let mut center = [0.0; 3];
        let mut area_vector = [0.0; 3];
        let mut area = 0.0;
        for &index in &self.order[start..end] {
            let triangle = &self.triangles[index];
            area += triangle.area;
            for axis in 0..3 {
                min[axis] = min[axis].min(triangle.min[axis]);
                max[axis] = max[axis].max(triangle.max[axis]);
                center[axis] += triangle.centroid[axis] * triangle.area;
                area_vector[axis] += triangle.area_vector[axis];
            }
        }
        for axis in 0..3 {
            center[axis] = if area > 0.0 {
                center[axis] / area
            } else {
                (min[axis] + max[axis]) * 0.5
            };
        }
        let radius_squared = (0..3)
            .map(|axis| {
                let d = (max[axis] - center[axis]).max(center[axis] - min[axis]);
                d * d
            })
            .sum();
        let index = self.nodes.len();
        self.nodes.push(Node {
            min,
            max,
            center,
            radius_squared,
            area_vector,
            start,
            end,
            children: None,
        });
        if end - start > 2 {
            let mut axis = 0;
            for other in 1..3 {
                if max[other] - min[other] > max[axis] - min[axis] {
                    axis = other;
                }
            }
            self.order[start..end].sort_unstable_by(|&a, &b| {
                self.triangles[a].centroid[axis]
                    .total_cmp(&self.triangles[b].centroid[axis])
                    .then(a.cmp(&b))
            });
            let middle = start + (end - start) / 2;
            let children = [self.build_node(start, middle), self.build_node(middle, end)];
            self.nodes[index].children = Some(children);
        }
        index
    }

    fn distance(&self, p: V3, maximum_squared: f64) -> f64 {
        let d = self.distance_node(0, p, maximum_squared);
        if d <= maximum_squared {
            libm::sqrt(d)
        } else {
            f64::INFINITY
        }
    }

    fn distance_node(&self, index: usize, p: V3, mut best: f64) -> f64 {
        let node = &self.nodes[index];
        if box_distance(p, node) > best {
            return f64::INFINITY;
        }
        if let Some([left, right]) = node.children {
            let dl = box_distance(p, &self.nodes[left]);
            let dr = box_distance(p, &self.nodes[right]);
            let (first, second) = if dl <= dr {
                (left, right)
            } else {
                (right, left)
            };
            let first_distance = self.distance_node(first, p, best);
            best = best.min(first_distance);
            return first_distance.min(self.distance_node(second, p, best));
        } else {
            let mut found = false;
            for &triangle in &self.order[node.start..node.end] {
                let triangle = &self.triangles[triangle];
                if bounds_distance(p, triangle.min, triangle.max) > best {
                    continue;
                }
                let distance = triangle_distance(p, &triangle.p);
                if distance <= best {
                    best = distance;
                    found = true;
                }
            }
            if !found {
                return f64::INFINITY;
            }
        }
        best
    }

    fn inside(&self, p: V3) -> bool {
        let angle = self.solid_angle(0, p, true).abs();
        // Far-node monopole truncation is deliberately conservative. Near the
        // classification threshold recompute the complete solid-angle sum.
        let angle = if (4.0..=8.5).contains(&angle) {
            self.solid_angle(0, p, false).abs()
        } else {
            angle
        };
        angle > 2.0 * std::f64::consts::PI
    }

    fn solid_angle(&self, index: usize, p: V3, approximate: bool) -> f64 {
        let node = &self.nodes[index];
        let r = sub(node.center, p);
        let squared = dot(r, r);
        if approximate && squared > 36.0 * node.radius_squared && squared > 0.0 {
            return dot(node.area_vector, r) / (squared * libm::sqrt(squared));
        }
        if let Some([a, b]) = node.children {
            return self.solid_angle(a, p, approximate) + self.solid_angle(b, p, approximate);
        }
        let mut sum = 0.0;
        for &index in &self.order[node.start..node.end] {
            let triangle = &self.triangles[index];
            if triangle.area == 0.0 {
                continue;
            }
            let a = sub(triangle.p[0], p);
            let b = sub(triangle.p[1], p);
            let c = sub(triangle.p[2], p);
            let lengths = [
                libm::sqrt(dot(a, a)),
                libm::sqrt(dot(b, b)),
                libm::sqrt(dot(c, c)),
            ];
            let numerator = dot(a, cross(b, c));
            let denominator = lengths[0] * lengths[1] * lengths[2]
                + dot(a, b) * lengths[2]
                + dot(b, c) * lengths[0]
                + dot(c, a) * lengths[1];
            if numerator == 0.0 {
                continue;
            }
            sum += 2.0 * libm::atan2(numerator, denominator);
        }
        sum
    }
}

fn box_distance(p: V3, node: &Node) -> f64 {
    bounds_distance(p, node.min, node.max)
}

fn bounds_distance(p: V3, min: V3, max: V3) -> f64 {
    let mut sum = 0.0;
    for (axis, &point) in p.iter().enumerate() {
        let d = (min[axis] - point).max(0.0).max(point - max[axis]);
        sum += d * d;
    }
    sum
}

fn segment_distance(p: V3, a: V3, b: V3) -> f64 {
    let edge = sub(b, a);
    let offset = sub(p, a);
    let denominator = dot(edge, edge);
    let t = if denominator == 0.0 {
        0.0
    } else {
        (dot(offset, edge) / denominator).clamp(0.0, 1.0)
    };
    let d = [
        offset[0] - t * edge[0],
        offset[1] - t * edge[1],
        offset[2] - t * edge[2],
    ];
    dot(d, d)
}

/// Squared exact closest distance, including degenerate triangles.
fn triangle_distance(p: V3, triangle: &[V3; 3]) -> f64 {
    let [a, b, c] = *triangle;
    let ab = sub(b, a);
    let ac = sub(c, a);
    let normal = cross(ab, ac);
    let normal_squared = dot(normal, normal);
    let ap = sub(p, a);
    if normal_squared > 0.0 {
        // Barycentrics of the orthogonal projection. Cross products avoid the
        // catastrophic cancellation of (ab.ab * ac.ac - ab.ac * ab.ac).
        let u = dot(cross(ap, ac), normal) / normal_squared;
        let v = dot(cross(ab, ap), normal) / normal_squared;
        if u >= 0.0 && v >= 0.0 && u + v <= 1.0 {
            let distance = dot(ap, normal);
            return distance * distance / normal_squared;
        }
    }
    segment_distance(p, a, b)
        .min(segment_distance(p, b, c))
        .min(segment_distance(p, c, a))
}

/// On a consistently oriented closed mesh the generalized winding number is an
/// integer. A signed crossing scan computes that integer exactly, avoiding solid
/// angle evaluation per voxel. Coincident position indices are canonicalized so
/// normal/UV seams do not disable this fast path.
fn is_closed(positions: &[f64], tris: &[u32]) -> bool {
    let mut order: Vec<usize> = (0..positions.len() / 3).collect();
    order.sort_unstable_by(|&a, &b| {
        for axis in 0..3 {
            let cmp = positions[3 * a + axis].total_cmp(&positions[3 * b + axis]);
            if !cmp.is_eq() {
                return cmp;
            }
        }
        a.cmp(&b)
    });
    let mut canonical = vec![0_u32; order.len()];
    let mut previous = order[0];
    for &point in &order {
        if positions[3 * point..3 * point + 3] != positions[3 * previous..3 * previous + 3] {
            previous = point;
        }
        canonical[point] = previous as u32;
    }
    let mut edges = Vec::with_capacity(tris.len());
    for triangle in tris.chunks_exact(3) {
        let t: [u32; 3] = std::array::from_fn(|i| canonical[triangle[i] as usize]);
        for edge in 0..3 {
            let a = t[edge];
            let b = t[(edge + 1) % 3];
            if a == b {
                return false;
            }
            edges.push((a.min(b), a.max(b), if a < b { 1_i8 } else { -1_i8 }));
        }
    }
    edges.sort_unstable();
    for pair in edges.chunks(2) {
        if pair.len() != 2
            || pair[0].0 != pair[1].0
            || pair[0].1 != pair[1].1
            || pair[0].2 == pair[1].2
        {
            return false;
        }
    }
    true
}

fn projected_orientation(a: V3, b: V3, y: f64, z: f64) -> f64 {
    robust::orient2d(
        robust::Coord { x: a[1], y: a[2] },
        robust::Coord { x: b[1], y: b[2] },
        robust::Coord { x: y, y: z },
    )
}

fn scanline_crossings(
    triangles: &[Triangle],
    dims: [u32; 3],
    origin: V3,
    voxel: f64,
) -> Vec<Vec<(f64, i32)>> {
    let ny = dims[1] as usize;
    let nz = dims[2] as usize;
    let mut rows = vec![Vec::new(); ny * nz];
    for triangle in triangles {
        let mut p = triangle.p;
        let signed_area = projected_orientation(p[0], p[1], p[2][1], p[2][2]);
        if signed_area == 0.0 {
            continue;
        }
        let crossing = if signed_area > 0.0 { -1 } else { 1 };
        if signed_area < 0.0 {
            p.swap(1, 2);
        }
        let ymin =
            (libm::floor((triangle.min[1] - origin[1]) / voxel).max(0.0) as usize).min(ny - 1);
        let ymax =
            (libm::ceil((triangle.max[1] - origin[1]) / voxel).max(0.0) as usize).min(ny - 1);
        let zmin =
            (libm::floor((triangle.min[2] - origin[2]) / voxel).max(0.0) as usize).min(nz - 1);
        let zmax =
            (libm::ceil((triangle.max[2] - origin[2]) / voxel).max(0.0) as usize).min(nz - 1);
        for z in zmin..=zmax {
            let pz = origin[2] + z as f64 * voxel;
            for y in ymin..=ymax {
                let py = origin[1] + y as f64 * voxel;
                let mut weights = [0.0; 3];
                let mut inside = true;
                for edge in 0..3 {
                    let a = p[edge];
                    let b = p[(edge + 1) % 3];
                    let orientation = projected_orientation(a, b, py, pz);
                    let top_left = b[2] > a[2] || (b[2] == a[2] && b[1] < a[1]);
                    if orientation < 0.0 || (orientation == 0.0 && !top_left) {
                        inside = false;
                        break;
                    }
                    weights[(edge + 2) % 3] = orientation;
                }
                if inside {
                    let sum = weights[0] + weights[1] + weights[2];
                    let x =
                        (p[0][0] * weights[0] + p[1][0] * weights[1] + p[2][0] * weights[2]) / sum;
                    rows[y + ny * z].push((x, crossing));
                }
            }
        }
    }
    for row in &mut rows {
        row.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    }
    rows
}

/// Coarse conservative band mask. Empty 4^3 blocks skip BVH queries entirely;
/// marked blocks still use exact per-point triangle distances.
fn band_blocks(
    triangles: &[Triangle],
    dims: [u32; 3],
    origin: V3,
    voxel: f64,
    width: f64,
) -> ([usize; 3], Vec<bool>) {
    let blocks = dims.map(|d| (d as usize).div_ceil(4));
    let mut active = vec![false; blocks[0] * blocks[1] * blocks[2]];
    for triangle in triangles {
        let lower: [usize; 3] = std::array::from_fn(|i| {
            ((libm::floor((triangle.min[i] - width - origin[i]) / voxel).max(0.) as usize) / 4)
                .min(blocks[i] - 1)
        });
        let upper: [usize; 3] = std::array::from_fn(|i| {
            ((libm::ceil((triangle.max[i] + width - origin[i]) / voxel).max(0.) as usize) / 4)
                .min(blocks[i] - 1)
        });
        for z in lower[2]..=upper[2] {
            for y in lower[1]..=upper[1] {
                let start = lower[0] + blocks[0] * (y + blocks[1] * z);
                let end = upper[0] + blocks[0] * (y + blocks[1] * z) + 1;
                active[start..end].fill(true);
            }
        }
    }
    (blocks, active)
}

/// Samples exact BVH triangle distances within `band` voxels. Generalized winding
/// number (absolute value > 1/2) supplies the sign for both closed and open meshes;
/// far BVH nodes use a dipole approximation and ambiguous signs use the exact sum.
/// Padding is in voxels, independent of band width. With `fill`, Eikonal fast
/// sweeping fills the signed background while preserving all exact band samples.
pub fn sdf_from_mesh(
    positions: &[f64],
    tris: &[u32],
    voxel: f64,
    band: f64,
    padding: f64,
    fill: bool,
) -> Result<Grid, String> {
    if positions.is_empty() || !positions.len().is_multiple_of(3) || positions.len() / 3 > 4_000_000
    {
        return Err("mesh positions must contain xyz triples for 1..4000000 points".into());
    }
    if tris.is_empty() || !tris.len().is_multiple_of(3) || tris.len() / 3 > 4_000_000 {
        return Err("mesh triangles must contain index triples for 1..4000000 triangles".into());
    }
    if positions.iter().any(|v| !v.is_finite() || v.abs() > 1e30) {
        return Err("mesh positions must be finite with magnitude at most 1e30".into());
    }
    if tris
        .iter()
        .any(|&index| index as usize >= positions.len() / 3)
    {
        return Err("mesh triangle index is outside the positions array".into());
    }
    if !voxel.is_finite() || voxel <= 0.0 || voxel > 1e30 {
        return Err("mesh voxel size must be finite, positive and at most 1e30".into());
    }
    if !band.is_finite() || band < 1.0 || !padding.is_finite() || padding < 0.0 {
        return Err(
            "band must be at least one voxel; padding must be finite and nonnegative".into(),
        );
    }
    let width = voxel * band;
    let margin = voxel * padding;
    if !margin.is_finite() || margin > 1e30 || !width.is_finite() || width > 1e30 {
        return Err("band width or padding exceeds the finite distance range".into());
    }
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let mut triangles = Vec::with_capacity(tris.len() / 3);
    for indices in tris.chunks_exact(3) {
        let p = std::array::from_fn(|i| {
            let offset = indices[i] as usize * 3;
            [
                positions[offset],
                positions[offset + 1],
                positions[offset + 2],
            ]
        });
        let triangle_min = std::array::from_fn(|i| p[0][i].min(p[1][i]).min(p[2][i]));
        let triangle_max = std::array::from_fn(|i| p[0][i].max(p[1][i]).max(p[2][i]));
        let centroid = std::array::from_fn(|i| (p[0][i] + p[1][i] + p[2][i]) / 3.0);
        let area_vector = cross(sub(p[1], p[0]), sub(p[2], p[0])).map(|v| v * 0.5);
        let area = libm::sqrt(dot(area_vector, area_vector));
        for axis in 0..3 {
            min[axis] = min[axis].min(triangle_min[axis]);
            max[axis] = max[axis].max(triangle_max[axis]);
        }
        triangles.push(Triangle {
            p,
            min: triangle_min,
            max: triangle_max,
            centroid,
            area_vector,
            area,
        });
    }
    let origin = min.map(|v| v - margin);
    let mut dims = [0; 3];
    for axis in 0..3 {
        let cells = libm::ceil((max[axis] - min[axis] + 2.0 * margin) / voxel);
        if cells > u32::MAX as f64 - 1.0 {
            return Err("mesh grid dimensions overflow; increase voxel size".into());
        }
        dims[axis] = (cells as u32).max(1) + 1;
    }
    let count = layout_len(dims, origin, voxel)?;
    let crossings =
        if dims[1] as usize * dims[2] as usize <= 1_048_576 && is_closed(positions, tris) {
            Some(scanline_crossings(&triangles, dims, origin, voxel))
        } else {
            None
        };
    let (blocks, active) = band_blocks(&triangles, dims, origin, voxel, width);
    let bvh = Bvh::build(triangles);
    let mut result = Grid {
        dims,
        origin,
        voxel,
        values: Vec::with_capacity(count),
    };
    for z in 0..dims[2] {
        for y in 0..dims[1] {
            let row = crossings
                .as_ref()
                .map(|rows| &rows[(y + dims[1] * z) as usize]);
            let mut next_crossing = 0;
            let mut winding = 0_i32;
            for x in 0..dims[0] {
                let point = [
                    origin[0] + x as f64 * voxel,
                    origin[1] + y as f64 * voxel,
                    origin[2] + z as f64 * voxel,
                ];
                let block =
                    x as usize / 4 + blocks[0] * (y as usize / 4 + blocks[1] * (z as usize / 4));
                let distance = if active[block] {
                    bvh.distance(point, width * width)
                } else {
                    f64::INFINITY
                };
                let inside = if let Some(row) = row {
                    while next_crossing < row.len() && row[next_crossing].0 <= point[0] {
                        winding += row[next_crossing].1;
                        next_crossing += 1;
                    }
                    winding != 0
                } else {
                    bvh.inside(point)
                };
                result.values.push(if inside {
                    -(distance as f32)
                } else {
                    distance as f32
                });
            }
        }
    }
    if fill {
        fill_distances(&mut result)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_triangle_regions_and_degenerate() {
        let triangle = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]];
        assert!((triangle_distance([0.2, 0.2, 3.], &triangle) - 9.).abs() < 1e-14);
        assert!((triangle_distance([1., 1., 0.], &triangle) - 0.5).abs() < 1e-14);
        assert_eq!(triangle_distance([-1., 0., 0.], &triangle), 1.);
        assert_eq!(
            triangle_distance([0., 2., 0.], &[[0.; 3], [1., 0., 0.], [0.; 3]]),
            4.
        );
    }
}
