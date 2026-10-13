//! Seeded droplet erosion matching `src/core/erosion.ts` operation and RNG order.
//!
//! Terrain and accumulators use f64 internally; the public layers are f32. Sediment
//! and debris are signed net changes, and flow/water are raw accumulations, exactly
//! as in the TypeScript core (the node clips deposits and normalises water/flow).

use crate::erosion::ErosionResult;

#[derive(Clone, Debug)]
pub struct DropletParams {
    pub iterations: u32,
    /// Loader-only initial Mulberry32 state for the full JS numeric-seed domain.
    /// Native callers normally leave this unset and pass an explicit u64 seed.
    pub rng_state: Option<u32>,
    pub rain_density: f64,
    pub rain_amount: f64,
    pub erosion_rate: f64,
    pub deposition_rate: f64,
    pub sediment_capacity: f64,
    pub evaporation: f64,
    pub inertia: f64,
    pub gravity: f64,
    pub min_slope: f64,
    pub erosion_radius: f64,
    pub max_lifetime: u32,
    /// Angle of repose in radians, unlike the node's degrees.
    pub talus_angle: f64,
    pub thermal_rate: f64,
    pub open_boundary: bool,
}

impl Default for DropletParams {
    fn default() -> Self {
        Self {
            iterations: 50,
            rng_state: None,
            rain_density: 0.02,
            rain_amount: 1.0,
            erosion_rate: 0.3,
            deposition_rate: 0.3,
            sediment_capacity: 1.0,
            evaporation: 0.1,
            inertia: 0.1,
            gravity: 4.0,
            min_slope: 0.01,
            erosion_radius: 3.0,
            max_lifetime: 30,
            talus_angle: 40.0 * std::f64::consts::PI / 180.0,
            thermal_rate: 0.1,
            open_boundary: false,
        }
    }
}

fn validate_field(
    height: &[f32],
    hardness: Option<&[f32]>,
    freeze: Option<&[f32]>,
    w: usize,
    h: usize,
    cell: f64,
) -> Result<usize, String> {
    let n = w
        .checked_mul(h)
        .filter(|n| w >= 2 && h >= 2 && *n <= 16_777_216)
        .ok_or("erosion requires dimensions >= 2 and at most 16777216 samples")?;
    if !cell.is_finite() || !(1e-12..=1e12).contains(&cell) {
        return Err("erosion cell size must be finite and within [1e-12, 1e12]".into());
    }
    for (name, layer) in [
        ("height", Some(height)),
        ("hardness", hardness),
        ("freeze", freeze),
    ] {
        if let Some(a) = layer
            && (a.len() != n || a.iter().any(|v| !v.is_finite()))
        {
            return Err(format!("erosion {name} layer needs {n} finite samples"));
        }
    }
    Ok(n)
}

fn validate_params(p: &DropletParams, n: usize) -> Result<usize, String> {
    for (name, value) in [
        ("rain_density", p.rain_density),
        ("rain_amount", p.rain_amount),
        ("erosion_rate", p.erosion_rate),
        ("deposition_rate", p.deposition_rate),
        ("sediment_capacity", p.sediment_capacity),
        ("evaporation", p.evaporation),
        ("inertia", p.inertia),
        ("gravity", p.gravity),
        ("min_slope", p.min_slope),
        ("erosion_radius", p.erosion_radius),
        ("talus_angle", p.talus_angle),
        ("thermal_rate", p.thermal_rate),
    ] {
        if !value.is_finite() || !(0.0..=1e6).contains(&value) {
            return Err(format!(
                "droplet {name} must be finite and within [0, 1000000]"
            ));
        }
    }
    if p.rain_density > 1.0 || p.erosion_radius > 64.0 || p.max_lifetime > 4096 {
        return Err(
            "droplet limits: rain_density <= 1, erosion_radius <= 64, max_lifetime <= 4096".into(),
        );
    }
    let count = (p.rain_density * n as f64).round() as usize;
    if p.iterations > 5000
        || count as f64 * f64::from(p.iterations) * f64::from(p.max_lifetime.max(1)) > 4e9
        || n as f64 * f64::from(p.iterations) > 4e9
    {
        return Err(
            "droplet work limit exceeded; reduce resolution, iterations or droplet count".into(),
        );
    }
    Ok(count)
}

fn hash32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846ca68b);
    x ^ (x >> 16)
}

/// Matches TypeScript rng(seed) for nonnegative integer seeds representable by JS.
struct Rng(u32);
impl Rng {
    fn new(seed: u64) -> Self {
        let hashed = if seed < (1 << 31) {
            hash32(seed as u32 ^ 0x9e3779b9)
        } else {
            let bits = (seed as f64).to_bits();
            hash32(bits as u32 ^ hash32((bits >> 32) as u32))
        };
        Self(hash32(hashed.wrapping_add(0x6d2b79f5)))
    }

    #[inline]
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = (self.0 ^ (self.0 >> 15)).wrapping_mul(1 | self.0);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4294967296.0
    }
}

struct Brush {
    radius: isize,
    offsets: Vec<(isize, isize, isize, f64)>,
    // Contiguous brush rows give the compiler one checked slice per row instead
    // of a bounds check for every scattered write in the common interior path.
    rows: Vec<(isize, Vec<f64>)>,
}

impl Brush {
    fn new(radius: f64, w: usize) -> Self {
        let radius = radius.max(1.0);
        let r = radius.ceil() as isize - 1;
        let mut offsets = Vec::new();
        let mut sum = 0.0;
        for z in -r..=r {
            for x in -r..=r {
                // JS Math.hypot uses scaled summation; libm is deterministic and
                // this tiny setup difference does not affect the model semantics.
                let d = libm::hypot(x as f64, z as f64);
                if d >= radius && (x != 0 || z != 0) {
                    continue;
                }
                let weight = (radius - d).max(1e-6);
                offsets.push((x, z, z * w as isize + x, weight));
                sum += weight;
            }
        }
        for (_, _, _, weight) in &mut offsets {
            *weight /= sum;
        }
        let mut rows = Vec::new();
        for z in -r..=r {
            let row: Vec<_> = offsets.iter().filter(|(_, dz, _, _)| *dz == z).collect();
            if let Some(first) = row.first() {
                rows.push((
                    first.2,
                    row.iter().map(|(_, _, _, weight)| *weight).collect(),
                ));
            }
        }
        Self {
            radius: r,
            offsets,
            rows,
        }
    }
}

struct Field<'a> {
    w: usize,
    h: usize,
    cell: f64,
    height: Vec<f64>,
    hardness: Option<&'a [f32]>,
    freeze: Option<&'a [f32]>,
    flow: Vec<f64>,
    water: Vec<f64>,
}

#[inline]
fn mobility(layer: Option<&[f32]>, k: usize) -> f64 {
    layer.map_or(1.0, |a| 1.0 - f64::from(a[k]).clamp(0.0, 1.0))
}

/// Deposit all material onto movable bilinear samples. The fallback is a sample
/// this droplet actually eroded, so a fully frozen termination quad is safe too.
#[inline]
fn deposit(f: &mut Field<'_>, k: usize, fx: f64, fz: f64, amount: f64, fallback: usize) {
    let q = [k, k + 1, k + f.w, k + f.w + 1];
    let mut weights = [
        (1.0 - fx) * (1.0 - fz),
        fx * (1.0 - fz),
        (1.0 - fx) * fz,
        fx * fz,
    ];
    if f.freeze.is_some() {
        let mut sum = 0.0;
        for s in 0..4 {
            weights[s] *= mobility(f.freeze, q[s]);
            sum += weights[s];
        }
        if sum <= 0.0 {
            f.height[fallback] += amount;
            return;
        }
        for weight in &mut weights {
            *weight /= sum;
        }
    }
    for s in 0..4 {
        f.height[q[s]] += weights[s] * amount;
    }
}

struct RainScratch {
    xs: Vec<f64>,
    zs: Vec<f64>,
    rank: Vec<usize>,
    start: Vec<usize>,
    tile_of: Vec<usize>,
    order: Vec<usize>,
}

impl RainScratch {
    fn new(count: usize, w: usize, h: usize) -> Self {
        let nt = w.div_ceil(32) * h.div_ceil(32);
        Self {
            xs: vec![0.0; count],
            zs: vec![0.0; count],
            rank: vec![0; nt],
            start: vec![0; nt + 1],
            tile_of: vec![0; count],
            order: vec![0; count],
        }
    }
}

fn hydraulic_pass(
    f: &mut Field<'_>,
    p: &DropletParams,
    rng: &mut Rng,
    brush: &Brush,
    scratch: &mut RainScratch,
) {
    let w = f.w;
    let max_x = w - 1;
    let max_z = f.h - 1;
    let inv = 1.0 / f.cell;
    let inertia = p.inertia.clamp(0.0, 1.0);
    let follow = 1.0 - inertia;
    let erode_k = p.erosion_rate.clamp(0.0, 1.0);
    let dep_k = p.deposition_rate.clamp(0.0, 1.0);
    let keep = 1.0 - p.evaporation.clamp(0.0, 1.0);
    let plain = f.hardness.is_none() && f.freeze.is_none();
    let count = scratch.xs.len();
    for d in 0..count {
        scratch.xs[d] = rng.next() * max_x as f64;
        scratch.zs[d] = rng.next() * max_z as f64;
    }
    let nt = scratch.rank.len();
    for (t, rank) in scratch.rank.iter_mut().enumerate() {
        *rank = t;
    }
    for t in (1..nt).rev() {
        let s = (rng.next() * (t + 1) as f64) as usize;
        scratch.rank.swap(t, s);
    }
    scratch.start.fill(0);
    let ntx = w.div_ceil(32);
    for d in 0..count {
        let t =
            scratch.rank[(scratch.zs[d] / 32.0) as usize * ntx + (scratch.xs[d] / 32.0) as usize];
        scratch.tile_of[d] = t;
        scratch.start[t + 1] += 1;
    }
    for t in 0..nt {
        scratch.start[t + 1] += scratch.start[t];
    }
    for d in 0..count {
        let t = scratch.tile_of[d];
        scratch.order[scratch.start[t]] = d;
        scratch.start[t] += 1;
    }
    for &d in &scratch.order {
        let mut px = scratch.xs[d];
        let mut pz = scratch.zs[d];
        let (mut dx, mut dz, mut speed, mut water, mut load) = (0.0, 0.0, 1.0, p.rain_amount, 0.0);
        let mut alive = true;
        let mut fallback = 0;
        for _ in 0..p.max_lifetime.max(1) {
            let ix = px as usize;
            let iz = pz as usize;
            let fx = px - ix as f64;
            let fz = pz - iz as f64;
            let k = iz * w + ix;
            let [h00, h10, h01, h11] = [
                f.height[k],
                f.height[k + 1],
                f.height[k + w],
                f.height[k + w + 1],
            ];
            let gx = ((h10 - h00) * (1.0 - fz) + (h11 - h01) * fz) * inv;
            let gz = ((h01 - h00) * (1.0 - fx) + (h11 - h10) * fx) * inv;
            let h_old =
                (h00 * (1.0 - fx) + h10 * fx) * (1.0 - fz) + (h01 * (1.0 - fx) + h11 * fx) * fz;
            dx = dx * inertia - gx * follow;
            dz = dz * inertia - gz * follow;
            let len = (dx * dx + dz * dz).sqrt();
            f.flow[k] += water;
            if len < 1e-12 {
                break;
            }
            dx /= len;
            dz /= len;
            let nx = px + dx;
            let nz = pz + dz;
            if nx < 0.0 || nx >= max_x as f64 || nz < 0.0 || nz >= max_z as f64 {
                if p.open_boundary {
                    load = 0.0;
                }
                alive = false;
                break;
            }
            let jx = nx as usize;
            let jz = nz as usize;
            let ux = nx - jx as f64;
            let uz = nz - jz as f64;
            let m = jz * w + jx;
            let h_new = (f.height[m] * (1.0 - ux) + f.height[m + 1] * ux) * (1.0 - uz)
                + (f.height[m + w] * (1.0 - ux) + f.height[m + w + 1] * ux) * uz;
            let dh = (h_new - h_old) * inv;
            let cap = (-dh).max(p.min_slope) * speed * water * p.sediment_capacity;
            if load > cap || dh > 0.0 {
                let mut amount = if dh > 0.0 {
                    dh.min(load)
                } else {
                    (load - cap) * dep_k
                };
                if let Some(freeze) = f.freeze {
                    // JS typed-array reads are doubles: promote before summing.
                    let mean = (f64::from(freeze[k])
                        + f64::from(freeze[k + 1])
                        + f64::from(freeze[k + w])
                        + f64::from(freeze[k + w + 1]))
                        * 0.25;
                    amount *= 1.0 - mean.clamp(0.0, 1.0);
                }
                if amount > 0.0 {
                    load -= amount;
                    deposit(f, k, fx, fz, amount * f.cell, fallback);
                }
            } else {
                let amount = ((cap - load) * erode_k).min(-dh) * f.cell;
                if amount > 0.0 {
                    let r = brush.radius as usize;
                    if plain && ix >= r && ix + r <= max_x && iz >= r && iz + r <= max_z {
                        for (offset, weights) in &brush.rows {
                            let first = (k as isize + offset) as usize;
                            let row = &mut f.height[first..first + weights.len()];
                            for (sample, weight) in row.iter_mut().zip(weights) {
                                *sample -= weight * amount;
                            }
                        }
                        load += amount * inv;
                    } else {
                        let mut taken = 0.0;
                        for &(bx, bz, _, weight) in &brush.offsets {
                            let x = ix as isize + bx;
                            let z = iz as isize + bz;
                            if x < 0 || x > max_x as isize || z < 0 || z > max_z as isize {
                                continue;
                            }
                            let q = z as usize * w + x as usize;
                            let eroded =
                                weight * amount * mobility(f.hardness, q) * mobility(f.freeze, q);
                            f.height[q] -= eroded;
                            taken += eroded;
                            if eroded > 0.0 {
                                fallback = q;
                            }
                        }
                        load += taken * inv;
                    }
                }
            }
            let v2 = speed * speed - dh * p.gravity;
            speed = if v2 > 0.0 { v2.sqrt() } else { 0.0 };
            water *= keep;
            px = nx;
            pz = nz;
        }
        if load > 0.0 {
            let ix = px as usize;
            let iz = pz as usize;
            deposit(
                f,
                iz * w + ix,
                px - ix as f64,
                pz - iz as f64,
                load * f.cell,
                fallback,
            );
        }
        if alive {
            f.water[pz as usize * w + px as usize] += water / (1.0 + speed * speed);
        }
    }
}

fn smooth_deposits(f: &mut Field<'_>, before: &[f64], deposits: &mut [f64], scratch: &mut [f64]) {
    if f.freeze.is_some() {
        return;
    }
    deposits.fill(0.0);
    scratch.fill(0.0);
    let mut any = false;
    for k in 0..f.height.len() {
        let d = f.height[k] - before[k];
        if d > 0.0 {
            deposits[k] = d;
            f.height[k] -= d;
            any = true;
        }
    }
    if !any {
        return;
    }
    let w = f.w;
    for j in 0..f.h {
        for i in 0..w {
            let k = j * w + i;
            let v = deposits[k];
            if v == 0.0 {
                continue;
            }
            if i == 0 {
                scratch[k] += v * (2.0 / 3.0);
                scratch[k + 1] += v / 3.0;
            } else if i == w - 1 {
                scratch[k] += v * (2.0 / 3.0);
                scratch[k - 1] += v / 3.0;
            } else {
                scratch[k - 1] += v * 0.25;
                scratch[k] += v * 0.5;
                scratch[k + 1] += v * 0.25;
            }
        }
    }
    for j in 0..f.h {
        for i in 0..w {
            let k = j * w + i;
            let v = scratch[k];
            if v == 0.0 {
                continue;
            }
            if j == 0 {
                f.height[k] += v * (2.0 / 3.0);
                f.height[k + w] += v / 3.0;
            } else if j == f.h - 1 {
                f.height[k] += v * (2.0 / 3.0);
                f.height[k - w] += v / 3.0;
            } else {
                f.height[k - w] += v * 0.25;
                f.height[k] += v * 0.5;
                f.height[k + w] += v * 0.25;
            }
        }
    }
}

const OX: [isize; 8] = [1, -1, 0, 0, 1, 1, -1, -1];
const OZ: [isize; 8] = [0, 0, 1, -1, 1, -1, 1, -1];

#[allow(clippy::too_many_arguments)]
fn thermal_cell(
    height: &[f64],
    delta: &mut [f64],
    hardness: Option<&[f32]>,
    freeze: Option<&[f32]>,
    w: usize,
    h: usize,
    i: usize,
    j: usize,
    talus: f64,
    diagonal: f64,
    rate: f64,
) {
    let k = j * w + i;
    if freeze.is_some_and(|f| f[k] >= 0.5) {
        return;
    }
    let mut excess = [0.0; 8];
    let mut neighbors = [0; 8];
    let mut total = 0.0;
    let mut maximum: f64 = 0.0;
    for s in 0..8 {
        let x = i as isize + OX[s];
        let z = j as isize + OZ[s];
        if x < 0 || x >= w as isize || z < 0 || z >= h as isize {
            continue;
        }
        let q = z as usize * w + x as usize;
        neighbors[s] = q;
        let d = height[k] - height[q] - if s < 4 { talus } else { diagonal };
        if d > 0.0 && !freeze.is_some_and(|f| f[q] >= 0.5) {
            excess[s] = d;
            total += d;
            maximum = maximum.max(d);
        }
    }
    if total <= 0.0 {
        return;
    }
    let moved = rate * maximum * 0.5 * mobility(hardness, k);
    if moved <= 0.0 {
        return;
    }
    delta[k] -= moved;
    let scale = moved / total;
    for s in 0..8 {
        if excess[s] > 0.0 {
            delta[neighbors[s]] += excess[s] * scale;
        }
    }
}

/// Jacobi eight-neighbour talus relaxation. Scratch is reused by the caller.
#[allow(clippy::too_many_arguments)]
pub(crate) fn thermal_pass(
    height: &mut [f64],
    debris: &mut [f64],
    delta: &mut [f64],
    hardness: Option<&[f32]>,
    freeze: Option<&[f32]>,
    w: usize,
    h: usize,
    cell: f64,
    angle: f64,
    rate: f64,
) {
    delta.fill(0.0);
    let talus = libm::tan(angle.clamp(0.0, 89.9 * std::f64::consts::PI / 180.0)) * cell;
    let diagonal = talus * std::f64::consts::SQRT_2;
    let rate = rate.clamp(0.0, 1.0);
    for j in 0..h {
        for i in 0..w {
            if i == 0 || i + 1 == w || j == 0 || j + 1 == h || freeze.is_some() {
                thermal_cell(
                    height, delta, hardness, freeze, w, h, i, j, talus, diagonal, rate,
                );
                continue;
            }
            let k = j * w + i;
            let hk = height[k];
            let q = [
                k + 1,
                k - 1,
                k + w,
                k - w,
                k + w + 1,
                k - w + 1,
                k + w - 1,
                k - w - 1,
            ];
            let mut e = [
                hk - height[q[0]] - talus,
                hk - height[q[1]] - talus,
                hk - height[q[2]] - talus,
                hk - height[q[3]] - talus,
                hk - height[q[4]] - diagonal,
                hk - height[q[5]] - diagonal,
                hk - height[q[6]] - diagonal,
                hk - height[q[7]] - diagonal,
            ];
            if e.iter().all(|d| *d <= 0.0) {
                continue;
            }
            let mut maximum: f64 = 0.0;
            let mut total = 0.0;
            for d in &mut e {
                *d = d.max(0.0);
                total += *d;
                maximum = maximum.max(*d);
            }
            let moved = rate * maximum * 0.5 * mobility(hardness, k);
            if moved <= 0.0 {
                continue;
            }
            let scale = moved / total;
            delta[k] -= moved;
            for s in 0..8 {
                delta[q[s]] += e[s] * scale;
            }
        }
    }
    for k in 0..height.len() {
        if delta[k] != 0.0 {
            height[k] += delta[k];
            debris[k] += delta[k];
        }
    }
}

fn layer_f32(values: Vec<f64>) -> Result<Vec<f32>, String> {
    values.into_iter().map(|v| {
        let v = v as f32;
        if v.is_finite() { Ok(v) } else { Err("erosion produced an unrepresentable layer; reduce height or parameter magnitudes".into()) }
    }).collect()
}

/// Run the TypeScript-compatible droplet model over a copied flat height layer.
#[allow(clippy::too_many_arguments)]
pub fn erode_droplet(
    height: &[f32],
    hardness: Option<&[f32]>,
    freeze: Option<&[f32]>,
    w: usize,
    h: usize,
    cell: f64,
    params: &DropletParams,
    seed: u64,
) -> Result<ErosionResult, String> {
    let n = validate_field(height, hardness, freeze, w, h, cell)?;
    let count = validate_params(params, n)?;
    let mut field = Field {
        w,
        h,
        cell,
        height: height.iter().map(|v| f64::from(*v)).collect(),
        hardness,
        freeze,
        flow: vec![0.0; n],
        water: vec![0.0; n],
    };
    let mut sediment = vec![0.0; n];
    let mut debris = vec![0.0; n];
    let mut wear = vec![0.0; n];
    let mut before = vec![0.0; n];
    let mut deposits = vec![0.0; n];
    let mut scratch = vec![0.0; n];
    let mut rain = RainScratch::new(count, w, h);
    let brush = Brush::new(params.erosion_radius, w);
    let mut rng = params.rng_state.map_or_else(|| Rng::new(seed), Rng);
    for _ in 0..params.iterations {
        if params.rain_density > 0.0 && params.rain_amount > 0.0 {
            before.copy_from_slice(&field.height);
            hydraulic_pass(&mut field, params, &mut rng, &brush, &mut rain);
            smooth_deposits(&mut field, &before, &mut deposits, &mut scratch);
            for k in 0..n {
                let delta = field.height[k] - before[k];
                sediment[k] += delta;
                wear[k] += (-delta).max(0.0);
            }
        }
        if params.thermal_rate > 0.0 {
            thermal_pass(
                &mut field.height,
                &mut debris,
                &mut scratch,
                hardness,
                freeze,
                w,
                h,
                cell,
                params.talus_angle,
                params.thermal_rate,
            );
            for k in 0..n {
                wear[k] += (-scratch[k]).max(0.0);
            }
        }
    }
    Ok(ErosionResult {
        height: layer_f32(field.height)?,
        sediment: layer_f32(sediment)?,
        debris: layer_f32(debris)?,
        flow: layer_f32(field.flow)?,
        water: layer_f32(field.water)?,
        wear: layer_f32(wear)?,
    })
}

/// Standalone mass-conserving eight-neighbour thermal erosion, angle in radians.
#[allow(clippy::too_many_arguments)]
pub fn thermal_erode(
    height: &[f32],
    hardness: Option<&[f32]>,
    freeze: Option<&[f32]>,
    w: usize,
    h: usize,
    cell: f64,
    talus_angle: f64,
    rate: f64,
    iterations: u32,
) -> Result<ErosionResult, String> {
    erode_droplet(
        height,
        hardness,
        freeze,
        w,
        h,
        cell,
        &DropletParams {
            iterations,
            rain_density: 0.0,
            talus_angle,
            thermal_rate: rate,
            ..DropletParams::default()
        },
        0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terrain(w: usize, h: usize, seed: u64) -> Vec<f32> {
        let mut r = Rng::new(seed);
        (0..w * h)
            .map(|k| (10.0 + (w - k % w) as f64 * 0.2 + r.next() * 3.0) as f32)
            .collect()
    }

    fn sum(a: &[f32]) -> f64 {
        a.iter().map(|v| f64::from(*v)).sum()
    }

    #[test]
    fn rng_matches_typescript_reference() {
        for (seed, expected) in [
            (
                0,
                [0.6134175739716738, 0.12176125170662999, 0.6140559134073555],
            ),
            (
                42,
                [0.14669241849333048, 0.8418400217778981, 0.4460546048358083],
            ),
            (
                2147483648,
                [0.9086854311171919, 0.19760641129687428, 0.9331283164210618],
            ),
            (
                4294967296,
                [0.6967794187366962, 0.7782201629597694, 0.9597157230600715],
            ),
        ] {
            let mut random = Rng::new(seed);
            for sample in expected {
                assert_eq!(random.next(), sample);
            }
        }
    }

    #[test]
    fn properties_closed_mass_finite_and_deterministic() {
        for seed in 0..12 {
            let w = 13 + seed as usize % 7;
            let h = 15 + seed as usize % 5;
            let input = terrain(w, h, seed);
            let params = DropletParams {
                iterations: 12,
                rain_density: 0.15,
                talus_angle: 0.3,
                ..DropletParams::default()
            };
            let a = erode_droplet(&input, None, None, w, h, 0.5, &params, seed).unwrap();
            let b = erode_droplet(&input, None, None, w, h, 0.5, &params, seed).unwrap();
            assert_eq!(a.height, b.height);
            assert_eq!(a.flow, b.flow);
            assert_eq!(a.sediment, b.sediment);
            assert!((sum(&input) - sum(&a.height)).abs() / sum(&input).abs() < 1e-6);
            for layer in [
                &a.height,
                &a.sediment,
                &a.debris,
                &a.flow,
                &a.water,
                &a.wear,
            ] {
                assert!(layer.iter().all(|v| v.is_finite()));
            }
            assert!(a.wear.iter().all(|v| *v >= 0.0));
        }
    }

    #[test]
    fn flat_and_hard_terrain_do_not_erode() {
        let params = DropletParams {
            iterations: 20,
            rain_density: 0.2,
            ..DropletParams::default()
        };
        let flat = vec![7.0; 32 * 32];
        let out = erode_droplet(&flat, None, None, 32, 32, 1.0, &params, 44).unwrap();
        assert_eq!(out.height, flat);
        let input = terrain(32, 32, 44);
        let hardness = vec![1.0; input.len()];
        let out = erode_droplet(&input, Some(&hardness), None, 32, 32, 0.1, &params, 44).unwrap();
        assert_eq!(out.height, input);
        assert!(out.wear.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn frozen_cells_unchanged_and_mass_preserved() {
        let input = terrain(24, 24, 9);
        let freeze: Vec<f32> = (0..input.len())
            .map(|k| if k % 24 > 12 { 1.0 } else { 0.0 })
            .collect();
        let params = DropletParams {
            iterations: 30,
            rain_density: 0.2,
            talus_angle: 0.1,
            ..DropletParams::default()
        };
        let out = erode_droplet(&input, None, Some(&freeze), 24, 24, 0.1, &params, 12).unwrap();
        for k in 0..input.len() {
            if freeze[k] == 1.0 {
                assert_eq!(input[k], out.height[k]);
            }
        }
        assert!((sum(&input) - sum(&out.height)).abs() / sum(&input) < 1e-6);
    }

    #[test]
    fn thermal_conserves_material_and_lowers_a_spike() {
        let mut input = vec![1.0; 17 * 17];
        input[8 * 17 + 8] = 20.0;
        let out = thermal_erode(&input, None, None, 17, 17, 1.0, 0.5, 0.3, 50).unwrap();
        assert!(out.height[8 * 17 + 8] < 10.0);
        assert!((sum(&input) - sum(&out.height)).abs() < 1e-4);
        assert!(out.sediment.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn malformed_inputs_return_errors() {
        let p = DropletParams::default();
        for (w, h) in [(0, 4), (1, 4), (usize::MAX, 2), (4, 4)] {
            assert!(erode_droplet(&[], None, None, w, h, 1.0, &p, 0).is_err());
        }
        assert!(erode_droplet(&[0.0; 4], None, None, 2, 2, f64::NAN, &p, 0).is_err());
        assert!(erode_droplet(&[f32::NAN; 4], None, None, 2, 2, 1.0, &p, 0).is_err());
        assert!(erode_droplet(&[0.0; 4], Some(&[0.0]), None, 2, 2, 1.0, &p, 0).is_err());
        let huge = DropletParams {
            erosion_radius: 1e30,
            ..p
        };
        assert!(erode_droplet(&[0.0; 4], None, None, 2, 2, 1.0, &huge, 0).is_err());
    }
}
