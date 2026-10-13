//! Dense, x-fast sampled signed distance grids. Distances are negative inside.
//! Infinite samples encode the signed background outside a narrow band.

mod mesh;
pub use mesh::sdf_from_mesh;

/// The allocation limit also bounds intermediate buffers in WASM's 32-bit memory.
pub const MAX_GRID_SAMPLES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    pub dims: [u32; 3],
    pub origin: [f64; 3],
    pub voxel: f64,
    pub values: Vec<f32>,
}

impl Grid {
    pub fn validate(&self) -> Result<(), String> {
        let count = layout_len(self.dims, self.origin, self.voxel)?;
        if self.values.len() != count {
            return Err("grid values length must equal dims[0] * dims[1] * dims[2]".into());
        }
        if self.values.iter().any(|v| v.is_nan()) {
            return Err("grid values must not contain NaN (signed infinity is allowed)".into());
        }
        Ok(())
    }

    /// Trilinear sampling. Outside the grid is positive infinity. Mixed finite and
    /// infinite corners use a finite signed cap of grid diagonal + voxel; a stencil
    /// containing only the same signed infinity keeps that infinity.
    pub fn sample(&self, x: f64, y: f64, z: f64) -> f64 {
        if self.dims.iter().any(|&d| d < 2)
            || self
                .dims
                .iter()
                .try_fold(1_usize, |n, &d| n.checked_mul(d as usize))
                != Some(self.values.len())
        {
            return f64::INFINITY;
        }
        let p = [x, y, z];
        let mut cell = [0; 3];
        let mut t = [0.0; 3];
        for axis in 0..3 {
            let upper = self.origin[axis] + (self.dims[axis] - 1) as f64 * self.voxel;
            if !p[axis].is_finite() || p[axis] < self.origin[axis] || p[axis] > upper {
                return f64::INFINITY;
            }
            let q = (p[axis] - self.origin[axis]) / self.voxel;
            if !q.is_finite() {
                return f64::INFINITY;
            }
            let q = q.clamp(0.0, (self.dims[axis] - 1) as f64);
            cell[axis] = (q as usize).min(self.dims[axis] as usize - 2);
            t[axis] = q - cell[axis] as f64;
        }
        let cap = self.distance_cap();
        let mut value = 0.0;
        let mut all_positive_infinity = true;
        let mut all_negative_infinity = true;
        let mut all_negative_zero = true;
        for dz in 0..2 {
            for dy in 0..2 {
                for dx in 0..2 {
                    let weight = if dx == 0 { 1.0 - t[0] } else { t[0] }
                        * if dy == 0 { 1.0 - t[1] } else { t[1] }
                        * if dz == 0 { 1.0 - t[2] } else { t[2] };
                    if weight == 0.0 {
                        continue;
                    }
                    let index = cell[0]
                        + dx
                        + self.dims[0] as usize
                            * (cell[1] + dy + self.dims[1] as usize * (cell[2] + dz));
                    let v = self.values[index] as f64;
                    all_positive_infinity &= v == f64::INFINITY;
                    all_negative_infinity &= v == f64::NEG_INFINITY;
                    all_negative_zero &= v == 0.0 && v.is_sign_negative();
                    value += weight * if v.is_finite() { v } else { cap.copysign(v) };
                }
            }
        }
        if all_positive_infinity {
            f64::INFINITY
        } else if all_negative_infinity {
            f64::NEG_INFINITY
        } else if all_negative_zero {
            -0.0
        } else {
            value
        }
    }

    pub fn distance_cap(&self) -> f64 {
        let extent = self.dims.map(|d| d.saturating_sub(1) as f64 * self.voxel);
        libm::sqrt(extent[0] * extent[0] + extent[1] * extent[1] + extent[2] * extent[2])
            + self.voxel
    }
}

pub(crate) fn layout_len(dims: [u32; 3], origin: [f64; 3], voxel: f64) -> Result<usize, String> {
    if !voxel.is_finite() || voxel <= 0.0 {
        return Err("voxel size must be finite and greater than zero".into());
    }
    if dims.iter().any(|&d| d < 2) {
        return Err("every grid dimension must be at least two samples".into());
    }
    let mut count = 1_usize;
    for axis in 0..3 {
        count = count
            .checked_mul(dims[axis] as usize)
            .filter(|&n| n <= MAX_GRID_SAMPLES)
            .ok_or("grid exceeds the 67108864 sample allocation limit; increase voxel size")?;
        let extent = (dims[axis] - 1) as f64 * voxel;
        if !origin[axis].is_finite()
            || !extent.is_finite()
            || !(origin[axis] + extent).is_finite()
            || extent > f32::MAX as f64 / 16.0
        {
            return Err("grid origin or extent exceeds the supported finite distance range".into());
        }
        if origin[axis] + voxel <= origin[axis]
            || origin[axis] + extent <= origin[axis] + (dims[axis] - 2) as f64 * voxel
        {
            return Err("grid voxel spacing is not representable at this origin/extent; increase voxel size or move the grid closer to zero".into());
        }
    }
    Ok(count)
}

/// Offsets the zero set outwards by `distance` world units.
pub fn grid_offset(grid: &Grid, distance: f64) -> Result<Grid, String> {
    grid.validate()?;
    if !distance.is_finite() || distance.abs() > f32::MAX as f64 / 16.0 {
        return Err("grid offset must be a finite representable distance".into());
    }
    let mut result = grid.clone();
    for value in &mut result.values {
        let shifted = *value as f64 - distance;
        if value.is_finite() && shifted.abs() > f32::MAX as f64 {
            return Err("grid offset overflows a finite distance sample; rescale the grid".into());
        }
        *value = shifted as f32;
    }
    Ok(result)
}

pub fn grid_dilate(grid: &Grid, distance: f64) -> Result<Grid, String> {
    if distance < 0.0 {
        return Err("dilation distance must be nonnegative".into());
    }
    grid_offset(grid, distance)
}

pub fn grid_erode(grid: &Grid, distance: f64) -> Result<Grid, String> {
    if distance < 0.0 {
        return Err("erosion distance must be nonnegative".into());
    }
    grid_offset(grid, -distance)
}

/// CSG adopts a's layout. Samples of b outside b's bounds are positive infinity.
pub fn grid_csg(a: &Grid, b: &Grid, op: &str, k: f64) -> Result<Grid, String> {
    a.validate()?;
    b.validate()?;
    if !k.is_finite() || k < 0.0 || k > f32::MAX as f64 / 16.0 {
        return Err("CSG smoothing distance must be finite, nonnegative and representable".into());
    }
    let operation = match op {
        "union" => 0,
        "intersect" => 1,
        "subtract" => 2,
        "smooth_union" => 3,
        "smooth_intersect" => 4,
        "smooth_subtract" => 5,
        _ => return Err("unknown grid CSG operation".into()),
    };
    let same_layout = a.dims == b.dims && a.origin == b.origin && a.voxel == b.voxel;
    let mut output = a.clone();
    let nx = a.dims[0] as usize;
    let ny = a.dims[1] as usize;
    for (i, value) in output.values.iter_mut().enumerate() {
        let av = a.values[i] as f64;
        let bv = if same_layout {
            b.values[i] as f64
        } else {
            b.sample(
                a.origin[0] + (i % nx) as f64 * a.voxel,
                a.origin[1] + ((i / nx) % ny) as f64 * a.voxel,
                a.origin[2] + (i / (nx * ny)) as f64 * a.voxel,
            )
        };
        let combined = match operation {
            0 => av.min(bv),
            1 => av.max(bv),
            2 => av.max(-bv),
            3 => smooth_min(av, bv, k),
            4 => -smooth_min(-av, -bv, k),
            _ => -smooth_min(-av, bv, k),
        };
        if combined.is_finite() && combined.abs() > f32::MAX as f64 {
            return Err("grid CSG overflows a finite distance sample; rescale the grids".into());
        }
        *value = combined as f32;
    }
    Ok(output)
}

fn smooth_min(a: f64, b: f64, k: f64) -> f64 {
    if k == 0.0 || !a.is_finite() || !b.is_finite() {
        return a.min(b);
    }
    let h = (k - (a - b).abs()).max(0.0) / k;
    a.min(b) - h * h * k * 0.25
}

/// Separable box blur, radius in voxels, with clamped boundary samples. Narrow-band
/// infinities are first extended by the same Eikonal sweeper used for filled grids.
pub fn grid_blur(grid: &Grid, radius: u32) -> Result<Grid, String> {
    grid.validate()?;
    if radius > 1024 {
        return Err("grid blur radius must be at most 1024 voxels".into());
    }
    if radius == 0 {
        return Ok(grid.clone());
    }
    let mut result = grid.clone();
    if result
        .values
        .iter()
        .all(|v| *v == result.values[0] && v.is_infinite())
    {
        return Ok(result);
    }
    if result.values.iter().any(|v| v.is_infinite()) {
        fill_distances(&mut result)?;
    }
    let dims = grid.dims.map(|d| d as usize);
    let strides = [1, dims[0], dims[0] * dims[1]];
    let mut buffer = vec![0.0; grid.values.len()];
    let radius = radius as usize;
    let count = (2 * radius + 1) as f64;
    for axis in 0..3 {
        let stride = strides[axis];
        let length = dims[axis];
        for base in 0..result.values.len() {
            if (base / stride) % length != 0 {
                continue;
            }
            let mut sum = result.values[base] as f64 * (radius + 1) as f64;
            for k in 1..=radius {
                sum += result.values[base + k.min(length - 1) * stride] as f64;
            }
            for x in 0..length {
                buffer[base + x * stride] = (sum / count) as f32;
                let outgoing = x.saturating_sub(radius);
                let incoming = (x + radius + 1).min(length - 1);
                sum += result.values[base + incoming * stride] as f64
                    - result.values[base + outgoing * stride] as f64;
            }
        }
        std::mem::swap(&mut result.values, &mut buffer);
    }
    Ok(result)
}

pub fn grid_resample(grid: &Grid, new_voxel: f64) -> Result<Grid, String> {
    grid.validate()?;
    if !new_voxel.is_finite() || new_voxel <= 0.0 {
        return Err("resample voxel size must be finite and greater than zero".into());
    }
    if new_voxel == grid.voxel {
        return Ok(grid.clone());
    }
    let mut dims = [0; 3];
    for (axis, dim) in dims.iter_mut().enumerate() {
        let cells = libm::ceil((grid.dims[axis] - 1) as f64 * grid.voxel / new_voxel);
        if cells > u32::MAX as f64 - 1.0 {
            return Err("resampled grid dimensions overflow; increase voxel size".into());
        }
        *dim = (cells as u32).max(1) + 1;
    }
    let count = layout_len(dims, grid.origin, new_voxel)?;
    let mut result = Grid {
        dims,
        origin: grid.origin,
        voxel: new_voxel,
        values: Vec::with_capacity(count),
    };
    for z in 0..dims[2] {
        for y in 0..dims[1] {
            for x in 0..dims[0] {
                result.values.push(grid.sample(
                    grid.origin[0] + x as f64 * new_voxel,
                    grid.origin[1] + y as f64 * new_voxel,
                    grid.origin[2] + z as f64 * new_voxel,
                ) as f32);
            }
        }
    }
    Ok(result)
}

/// Extend finite narrow-band samples by solving |grad d|=1 in eight sweep orders.
/// Existing exact band values are fixed. The original winding signs are retained.
pub(crate) fn fill_distances(grid: &mut Grid) -> Result<(), String> {
    if !grid.values.iter().any(|v| v.is_finite()) {
        // A homogeneous empty/full grid is a valid background with no surface.
        if grid.values.iter().all(|v| *v == grid.values[0]) {
            return Ok(());
        }
        return Err("cannot fill a signed grid with no finite distance samples".into());
    }
    let dims = grid.dims.map(|d| d as usize);
    let strides = [1, dims[0], dims[0] * dims[1]];
    let mut distance: Vec<f32> = grid.values.iter().map(|v| v.abs()).collect();
    for _cycle in 0..4 {
        let mut changed = false;
        for order in 0..8 {
            for iz in 0..dims[2] {
                let z = if order & 4 == 0 { iz } else { dims[2] - 1 - iz };
                for iy in 0..dims[1] {
                    let y = if order & 2 == 0 { iy } else { dims[1] - 1 - iy };
                    for ix in 0..dims[0] {
                        let x = if order & 1 == 0 { ix } else { dims[0] - 1 - ix };
                        let i = x + dims[0] * (y + dims[1] * z);
                        if grid.values[i].is_finite() {
                            continue;
                        }
                        let xyz = [x, y, z];
                        let mut neighbours = [f64::INFINITY; 3];
                        for axis in 0..3 {
                            if xyz[axis] > 0 {
                                neighbours[axis] = distance[i - strides[axis]] as f64;
                            }
                            if xyz[axis] + 1 < dims[axis] {
                                neighbours[axis] =
                                    neighbours[axis].min(distance[i + strides[axis]] as f64);
                            }
                        }
                        let candidate = eikonal(neighbours, grid.voxel) as f32;
                        if candidate < distance[i] {
                            distance[i] = candidate;
                            changed = true;
                        }
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
    for (value, distance) in grid.values.iter_mut().zip(distance) {
        *value = distance.copysign(*value);
    }
    Ok(())
}

fn eikonal(mut v: [f64; 3], h: f64) -> f64 {
    if v[0] > v[1] {
        v.swap(0, 1);
    }
    if v[1] > v[2] {
        v.swap(1, 2);
    }
    if v[0] > v[1] {
        v.swap(0, 1);
    }
    if !v[0].is_finite() {
        return f64::INFINITY;
    }
    let mut d = v[0] + h;
    if d > v[1] {
        let delta = v[0] - v[1];
        d = (v[0] + v[1] + libm::sqrt((2.0 * h * h - delta * delta).max(0.0))) * 0.5;
    }
    if d > v[2] {
        let sum = v[0] + v[1] + v[2];
        let square = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
        d = (sum + libm::sqrt((sum * sum - 3.0 * (square - h * h)).max(0.0))) / 3.0;
    }
    d
}
