//! Seeded droplet erosion matching `src/core/erosion.ts` operation and RNG order.
//!
//! Terrain and accumulators use f64 internally; the public layers are f32. Sediment
//! and debris are signed net changes, and flow/water are raw accumulations, exactly
//! as in the TypeScript core (the node clips deposits and normalises water/flow).

use crate::erosion::ErosionResult;
use crate::erosion_profile::Profile;

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
    square5: Option<[f64; 25]>,
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
            square5: (r == 2 && offsets.len() == 25).then(|| std::array::from_fn(|i| offsets[i].3)),
            offsets,
            rows,
        }
    }
}

// All arguments in these hot-path comparisons are finite, bounded intermediates
// of a validated simulation. Unlike Rust's NaN-aware min/max, compare-select
// needs no fmin/fmax helper call on scalar WebAssembly.
#[inline(always)]
fn finite_min(a: f64, b: f64) -> f64 {
    if a < b { a } else { b }
}

#[inline(always)]
fn finite_max(a: f64, b: f64) -> f64 {
    if a > b { a } else { b }
}

#[inline(always)]
fn quad(height: &[f64], k: usize, w: usize) -> [f64; 4] {
    let top = &height[k..k + 2];
    let bottom = &height[k + w..k + w + 2];
    [top[0], top[1], bottom[0], bottom[1]]
}

#[inline(always)]
fn erode_square5(height: &mut [f64], k: usize, w: usize, weights: &[f64; 25], amount: f64) {
    let first = k - 2 * w - 2;
    for z in 0..5 {
        // The interior check establishes each full brush row is in the field;
        // the one checked slice removes all five individual write checks.
        let row = &mut height[first + z * w..first + z * w + 5];
        row[0] -= weights[z * 5] * amount;
        row[1] -= weights[z * 5 + 1] * amount;
        row[2] -= weights[z * 5 + 2] * amount;
        row[3] -= weights[z * 5 + 3] * amount;
        row[4] -= weights[z * 5 + 4] * amount;
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
#[allow(clippy::too_many_arguments)]
fn deposit<const MASKED: bool>(
    height: &mut [f64],
    freeze: Option<&[f32]>,
    w: usize,
    k: usize,
    fx: f64,
    fz: f64,
    amount: f64,
    fallback: usize,
) {
    if !MASKED || freeze.is_none() {
        let top = &mut height[k..k + 2];
        top[0] += (1.0 - fx) * (1.0 - fz) * amount;
        top[1] += fx * (1.0 - fz) * amount;
        let bottom = &mut height[k + w..k + w + 2];
        bottom[0] += (1.0 - fx) * fz * amount;
        bottom[1] += fx * fz * amount;
        return;
    }
    let q = [k, k + 1, k + w, k + w + 1];
    let mut weights = [
        (1.0 - fx) * (1.0 - fz),
        fx * (1.0 - fz),
        (1.0 - fx) * fz,
        fx * fz,
    ];
    if freeze.is_some() {
        let mut sum = 0.0;
        for s in 0..4 {
            weights[s] *= mobility(freeze, q[s]);
            sum += weights[s];
        }
        if sum <= 0.0 {
            height[fallback] += amount;
            return;
        }
        for weight in &mut weights {
            *weight /= sum;
        }
    }
    for s in 0..4 {
        height[q[s]] += weights[s] * amount;
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

#[inline(never)]
fn hydraulic_pass(
    f: &mut Field<'_>,
    p: &DropletParams,
    rng: &mut Rng,
    brush: &Brush,
    scratch: &mut RainScratch,
    profile: &mut Profile,
    #[cfg(feature = "profile")] samples: &mut Profile,
) {
    let w = f.w;
    let max_x = w - 1;
    let max_z = f.h - 1;
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
    profile.mark("rain_rng");
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
    profile.mark("rain_tile_sort");
    if f.hardness.is_none() && f.freeze.is_none() {
        droplet_loop::<false>(
            &mut f.height,
            &mut f.flow,
            &mut f.water,
            f.hardness,
            f.freeze,
            w,
            f.h,
            f.cell,
            p,
            brush,
            scratch,
            #[cfg(feature = "profile")]
            samples,
        );
    } else {
        droplet_loop::<true>(
            &mut f.height,
            &mut f.flow,
            &mut f.water,
            f.hardness,
            f.freeze,
            w,
            f.h,
            f.cell,
            p,
            brush,
            scratch,
            #[cfg(feature = "profile")]
            samples,
        );
    }
    profile.mark("droplet_motion_brush_deposit");
}

#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn droplet_loop<const MASKED: bool>(
    height: &mut [f64],
    flow: &mut [f64],
    water_layer: &mut [f64],
    hardness: Option<&[f32]>,
    freeze: Option<&[f32]>,
    w: usize,
    h: usize,
    cell: f64,
    p: &DropletParams,
    brush: &Brush,
    scratch: &RainScratch,
    #[cfg(feature = "profile")] samples: &mut Profile,
) {
    let max_x = w - 1;
    let max_z = h - 1;
    let inv = 1.0 / cell;
    let inertia = p.inertia.clamp(0.0, 1.0);
    let follow = 1.0 - inertia;
    let erode_k = p.erosion_rate.clamp(0.0, 1.0);
    let dep_k = p.deposition_rate.clamp(0.0, 1.0);
    let keep = 1.0 - p.evaporation.clamp(0.0, 1.0);
    let plain = !MASKED;
    for &d in &scratch.order {
        // Sample one in 256 droplets. These sub-pass intervals overlap the
        // complete hydraulic timer and must not be added to its elapsed time.
        #[cfg(feature = "profile")]
        let sampled = d & 255 == 0;
        let mut px = scratch.xs[d];
        let mut pz = scratch.zs[d];
        let (mut dx, mut dz, mut speed, mut water, mut load) = (0.0, 0.0, 1.0, p.rain_amount, 0.0);
        let mut alive = true;
        let mut fallback = 0;
        let mut ix = px as i32 as usize;
        let mut iz = pz as i32 as usize;
        let mut fx = px - ix as f64;
        let mut fz = pz - iz as f64;
        let mut k = iz * w + ix;
        for _ in 0..p.max_lifetime.max(1) {
            #[cfg(feature = "profile")]
            if sampled {
                samples.reset();
            }
            let [h00, h10, h01, h11] = quad(height, k, w);
            let gx = ((h10 - h00) * (1.0 - fz) + (h11 - h01) * fz) * inv;
            let gz = ((h01 - h00) * (1.0 - fx) + (h11 - h10) * fx) * inv;
            let h_old =
                (h00 * (1.0 - fx) + h10 * fx) * (1.0 - fz) + (h01 * (1.0 - fx) + h11 * fx) * fz;
            dx = dx * inertia - gx * follow;
            dz = dz * inertia - gz * follow;
            let len = (dx * dx + dz * dz).sqrt();
            flow[k] += water;
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
            let jx = nx as i32 as usize;
            let jz = nz as i32 as usize;
            let ux = nx - jx as f64;
            let uz = nz - jz as f64;
            let m = jz * w + jx;
            let [h00, h10, h01, h11] = quad(height, m, w);
            let h_new =
                (h00 * (1.0 - ux) + h10 * ux) * (1.0 - uz) + (h01 * (1.0 - ux) + h11 * ux) * uz;
            let dh = (h_new - h_old) * inv;
            let cap = finite_max(-dh, p.min_slope) * speed * water * p.sediment_capacity;
            #[cfg(feature = "profile")]
            if sampled {
                samples.mark("motion_capacity");
                samples.reset();
            }
            if load > cap || dh > 0.0 {
                let mut amount = if dh > 0.0 {
                    finite_min(dh, load)
                } else {
                    (load - cap) * dep_k
                };
                if MASKED && let Some(freeze) = freeze {
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
                    deposit::<MASKED>(height, freeze, w, k, fx, fz, amount * cell, fallback);
                }
                #[cfg(feature = "profile")]
                if sampled {
                    samples.mark("deposit");
                }
            } else {
                let amount = finite_min((cap - load) * erode_k, -dh) * cell;
                if amount > 0.0 {
                    let r = brush.radius as usize;
                    if plain && ix >= r && ix + r <= max_x && iz >= r && iz + r <= max_z {
                        if let Some(weights) = &brush.square5 {
                            erode_square5(height, k, w, weights, amount);
                        } else {
                            for (offset, weights) in &brush.rows {
                                let first = (k as isize + offset) as usize;
                                let row = &mut height[first..first + weights.len()];
                                for (sample, weight) in row.iter_mut().zip(weights) {
                                    *sample -= weight * amount;
                                }
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
                            let eroded = if MASKED {
                                weight * amount * mobility(hardness, q) * mobility(freeze, q)
                            } else {
                                weight * amount
                            };
                            height[q] -= eroded;
                            taken += eroded;
                            if eroded > 0.0 {
                                fallback = q;
                            }
                        }
                        load += taken * inv;
                    }
                }
                #[cfg(feature = "profile")]
                if sampled {
                    samples.mark("brush");
                }
            }
            let v2 = speed * speed - dh * p.gravity;
            speed = if v2 > 0.0 { v2.sqrt() } else { 0.0 };
            water *= keep;
            px = nx;
            pz = nz;
            ix = jx;
            iz = jz;
            fx = ux;
            fz = uz;
            k = m;
        }
        if load > 0.0 {
            deposit::<MASKED>(height, freeze, w, k, fx, fz, load * cell, fallback);
        }
        if alive {
            water_layer[k] += water / (1.0 + speed * speed);
        }
    }
}

fn hydraulic_layers(height: &[f64], before: &[f64], sediment: &mut [f64], wear: &mut [f64]) {
    for (((height, before), sediment), wear) in height.iter().zip(before).zip(sediment).zip(wear) {
        let delta = height - before;
        *sediment += delta;
        *wear += finite_max(-delta, 0.0);
    }
}

/// Interior gather with the scalar scatter's three ordered additions. Selecting
/// the unchanged height for zero contributors retains signed-zero behavior while
/// removing per-lane branches from the dense smoothing/layer pass.
#[cfg(all(target_arch = "wasm32", feature = "simd"))]
#[allow(clippy::too_many_arguments)]
#[inline]
#[target_feature(enable = "simd128")]
unsafe fn smooth_interior_row(
    above: &[f64],
    row: &[f64],
    below: &[f64],
    height: &mut [f64],
    before: &[f64],
    sediment: &mut [f64],
    wear: &mut [f64],
) {
    use std::arch::wasm32::{
        f64x2_add, f64x2_gt, f64x2_mul, f64x2_ne, f64x2_neg, f64x2_splat, f64x2_sub,
        v128_bitselect, v128_load, v128_store,
    };
    let w = height.len();
    assert_eq!(above.len(), w);
    assert_eq!(row.len(), w);
    assert_eq!(below.len(), w);
    assert_eq!(before.len(), w);
    assert_eq!(sediment.len(), w);
    assert_eq!(wear.len(), w);
    let quarter = f64x2_splat(0.25);
    let half = f64x2_splat(0.5);
    let zero = f64x2_splat(0.0);
    let paired = w & !1;
    for i in (0..paired).step_by(2) {
        // SAFETY: all slices have length w, and i + 1 < paired <= w.
        // Unaligned loads/stores are supported by the WASM intrinsics.
        unsafe {
            let mut value = v128_load(height.as_ptr().add(i).cast());
            for (source, factor) in [(above, quarter), (row, half), (below, quarter)] {
                let contribution = v128_load(source.as_ptr().add(i).cast());
                let sum = f64x2_add(value, f64x2_mul(contribution, factor));
                value = v128_bitselect(sum, value, f64x2_ne(contribution, zero));
            }
            let change = f64x2_sub(value, v128_load(before.as_ptr().add(i).cast()));
            v128_store(height.as_mut_ptr().add(i).cast(), value);
            let previous_sediment = v128_load(sediment.as_ptr().add(i).cast());
            v128_store(
                sediment.as_mut_ptr().add(i).cast(),
                f64x2_add(previous_sediment, change),
            );
            let removed = f64x2_neg(change);
            let removed = v128_bitselect(removed, zero, f64x2_gt(removed, zero));
            let previous_wear = v128_load(wear.as_ptr().add(i).cast());
            v128_store(
                wear.as_mut_ptr().add(i).cast(),
                f64x2_add(previous_wear, removed),
            );
        }
    }
    if paired < w {
        let i = paired;
        for (source, factor) in [(above, 0.25), (row, 0.5), (below, 0.25)] {
            if source[i] != 0.0 {
                height[i] += source[i] * factor;
            }
        }
        let change = height[i] - before[i];
        sediment[i] += change;
        wear[i] += finite_max(-change, 0.0);
    }
}

#[inline(never)]
fn smooth_deposits(
    f: &mut Field<'_>,
    before: &[f64],
    deposits: &mut [f64],
    scratch: &mut [f64],
    sediment: &mut [f64],
    wear: &mut [f64],
) {
    if f.freeze.is_some() {
        hydraulic_layers(&f.height, before, sediment, wear);
        return;
    }
    let mut any = false;
    for ((height, before), deposited) in f.height.iter_mut().zip(before).zip(deposits.iter_mut()) {
        let d = *height - before;
        if d > 0.0 {
            *deposited = d;
            *height -= d;
            any = true;
        } else {
            *deposited = 0.0;
        }
    }
    if !any {
        hydraulic_layers(&f.height, before, sediment, wear);
        return;
    }
    let w = f.w;
    for (source, target) in deposits.chunks_exact(w).zip(scratch.chunks_exact_mut(w)) {
        if w == 2 {
            target[0] = source[0] * (2.0 / 3.0) + source[1] / 3.0;
            target[1] = source[0] / 3.0 + source[1] * (2.0 / 3.0);
        } else {
            target[0] = source[0] * (2.0 / 3.0) + source[1] * 0.25;
            target[w - 1] = source[w - 2] * 0.25 + source[w - 1] * (2.0 / 3.0);
            if w == 3 {
                target[1] = source[0] / 3.0 + source[1] * 0.5 + source[2] / 3.0;
            } else {
                target[1] = source[0] / 3.0 + source[1] * 0.5 + source[2] * 0.25;
                target[w - 2] = source[w - 3] * 0.25 + source[w - 2] * 0.5 + source[w - 1] / 3.0;
                for (target, source) in target[2..w - 2].iter_mut().zip(source[1..w - 1].windows(3))
                {
                    *target = source[0] * 0.25 + source[1] * 0.5 + source[2] * 0.25;
                }
            }
        }
    }
    for j in 0..f.h {
        let base = j * w;
        let above = if j > 0 { &scratch[base - w..base] } else { &[] };
        let row = &scratch[base..base + w];
        let below = if j + 1 < f.h {
            &scratch[base + w..base + 2 * w]
        } else {
            &[]
        };
        #[cfg(all(target_arch = "wasm32", feature = "simd"))]
        if j >= 2 && j + 2 < f.h {
            // Only the interior uses 1/4, 1/2, 1/4 coefficients. The adjacent
            // border rows below retain their exact 1/3 divisions.
            unsafe {
                smooth_interior_row(
                    above,
                    row,
                    below,
                    &mut f.height[base..base + w],
                    &before[base..base + w],
                    &mut sediment[base..base + w],
                    &mut wear[base..base + w],
                );
            }
            continue;
        }
        for (i, (((height, before), sediment), wear)) in f.height[base..base + w]
            .iter_mut()
            .zip(&before[base..base + w])
            .zip(&mut sediment[base..base + w])
            .zip(&mut wear[base..base + w])
            .enumerate()
        {
            // Gather in the original scatter's addition order, retaining exact
            // border divisions and skipping zero additions to preserve -0.
            if j > 0 && above[i] != 0.0 {
                *height += if j == 1 {
                    above[i] / 3.0
                } else {
                    above[i] * 0.25
                };
            }
            if row[i] != 0.0 {
                *height += row[i]
                    * if j == 0 || j + 1 == f.h {
                        2.0 / 3.0
                    } else {
                        0.5
                    };
            }
            if j + 1 < f.h && below[i] != 0.0 {
                *height += if j + 2 == f.h {
                    below[i] / 3.0
                } else {
                    below[i] * 0.25
                };
            }
            let delta = *height - before;
            *sediment += delta;
            *wear += finite_max(-delta, 0.0);
        }
    }
}

const OX: [isize; 8] = [1, -1, 0, 0, 1, 1, -1, -1];
const OZ: [isize; 8] = [0, 0, 1, -1, 1, -1, 1, -1];

/// Test two adjacent thermal cells together. Most cells of a smooth heightfield
/// have no excess slope, so their eight comparisons need no scalar transfer
/// bookkeeping. Active cells still use the original arithmetic and scatter order.
#[cfg(all(target_arch = "wasm32", feature = "simd"))]
#[inline]
#[target_feature(enable = "simd128")]
unsafe fn thermal_pair_active(
    previous: &[f64],
    current: &[f64],
    next: &[f64],
    i: usize,
    talus: f64,
    diagonal: f64,
) -> u8 {
    use std::arch::wasm32::{f64x2_gt, f64x2_splat, f64x2_sub, i64x2_bitmask, v128_load, v128_or};
    // SAFETY: thermal_row checks all row lengths, and calls only for
    // 1 <= i < w - 2. Every two-lane load at i - 1, i, or i + 1 is in bounds.
    unsafe {
        let center = v128_load(current.as_ptr().add(i).cast());
        let cardinal = f64x2_splat(talus);
        let diagonal = f64x2_splat(diagonal);
        let zero = f64x2_splat(0.0);
        let mut active = zero;
        for (row, offset, threshold) in [
            (current, i + 1, cardinal),
            (current, i - 1, cardinal),
            (next, i, cardinal),
            (previous, i, cardinal),
            (next, i + 1, diagonal),
            (previous, i + 1, diagonal),
            (next, i - 1, diagonal),
            (previous, i - 1, diagonal),
        ] {
            let neighbor = v128_load(row.as_ptr().add(offset).cast());
            let excess = f64x2_sub(f64x2_sub(center, neighbor), threshold);
            active = v128_or(active, f64x2_gt(excess, zero));
        }
        i64x2_bitmask(active)
    }
}

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
            maximum = finite_max(maximum, d);
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

/// No-alias row stencil. All six row lengths are checked once before the loop.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn thermal_row(
    previous_height: &[f64],
    height: &[f64],
    next_height: &[f64],
    previous_delta: &mut [f64],
    delta: &mut [f64],
    next_delta: &mut [f64],
    hardness: Option<&[f32]>,
    talus: f64,
    diagonal: f64,
    rate: f64,
) {
    let w = height.len();
    assert!(w >= 2);
    assert_eq!(previous_height.len(), w);
    assert_eq!(next_height.len(), w);
    assert_eq!(previous_delta.len(), w);
    assert_eq!(delta.len(), w);
    assert_eq!(next_delta.len(), w);
    assert!(hardness.is_none_or(|a| a.len() == w));
    #[cfg(all(target_arch = "wasm32", feature = "simd"))]
    let mut active_pair = 0;
    for i in 1..w - 1 {
        #[cfg(all(target_arch = "wasm32", feature = "simd"))]
        {
            if i & 1 == 1 {
                active_pair = if i + 2 < w {
                    // SAFETY: row lengths are checked above, i >= 1 and
                    // i + 2 < w bounds every neighbor of both adjacent cells.
                    unsafe {
                        thermal_pair_active(
                            previous_height,
                            height,
                            next_height,
                            i,
                            talus,
                            diagonal,
                        )
                    }
                } else {
                    1
                };
            }
            let active = active_pair & 1 != 0;
            active_pair >>= 1;
            if !active {
                continue;
            }
        }
        // SAFETY: every row has the checked length w and 1 <= i < w - 1,
        // hence i - 1, i and i + 1 are valid in every row. No pointer escapes.
        let mut excess = unsafe {
            let hk = *height.get_unchecked(i);
            [
                hk - *height.get_unchecked(i + 1) - talus,
                hk - *height.get_unchecked(i - 1) - talus,
                hk - *next_height.get_unchecked(i) - talus,
                hk - *previous_height.get_unchecked(i) - talus,
                hk - *next_height.get_unchecked(i + 1) - diagonal,
                hk - *previous_height.get_unchecked(i + 1) - diagonal,
                hk - *next_height.get_unchecked(i - 1) - diagonal,
                hk - *previous_height.get_unchecked(i - 1) - diagonal,
            ]
        };
        if excess.iter().all(|v| *v <= 0.0) {
            continue;
        }
        let mut maximum = 0.0;
        let mut total = 0.0;
        for value in &mut excess {
            *value = finite_max(*value, 0.0);
            total += *value;
            maximum = finite_max(maximum, *value);
        }
        let moved = rate * maximum * 0.5 * mobility(hardness, i);
        if moved <= 0.0 {
            continue;
        }
        let scale = moved / total;
        // SAFETY: same checked row bounds as the reads. The mutable rows are
        // separate split_at_mut slices and each temporary element borrow ends
        // before the next write. Preserve the original neighbour update order.
        unsafe {
            *delta.get_unchecked_mut(i) -= moved;
            *delta.get_unchecked_mut(i + 1) += excess[0] * scale;
            *delta.get_unchecked_mut(i - 1) += excess[1] * scale;
            *next_delta.get_unchecked_mut(i) += excess[2] * scale;
            *previous_delta.get_unchecked_mut(i) += excess[3] * scale;
            *next_delta.get_unchecked_mut(i + 1) += excess[4] * scale;
            *previous_delta.get_unchecked_mut(i + 1) += excess[5] * scale;
            *next_delta.get_unchecked_mut(i - 1) += excess[6] * scale;
            *previous_delta.get_unchecked_mut(i - 1) += excess[7] * scale;
        }
    }
}

/// Jacobi eight-neighbour talus relaxation. Scratch is reused by the caller.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
pub(crate) fn thermal_pass(
    height: &mut [f64],
    debris: &mut [f64],
    delta: &mut [f64],
    wear: &mut [f64],
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
    if freeze.is_some() {
        for j in 0..h {
            for i in 0..w {
                thermal_cell(
                    height, delta, hardness, freeze, w, h, i, j, talus, diagonal, rate,
                );
            }
        }
    } else {
        for i in 0..w {
            thermal_cell(
                height, delta, hardness, None, w, h, i, 0, talus, diagonal, rate,
            );
        }
        for j in 1..h - 1 {
            thermal_cell(
                height, delta, hardness, None, w, h, 0, j, talus, diagonal, rate,
            );
            let base = j * w;
            let previous_height = &height[base - w..base];
            let current_height = &height[base..base + w];
            let next_height = &height[base + w..base + 2 * w];
            let (previous, remainder) = delta.split_at_mut(base);
            let previous_delta = &mut previous[base - w..];
            let (current_delta, next) = remainder.split_at_mut(w);
            let next_delta = &mut next[..w];
            thermal_row(
                previous_height,
                current_height,
                next_height,
                previous_delta,
                current_delta,
                next_delta,
                hardness.map(|a| &a[base..base + w]),
                talus,
                diagonal,
                rate,
            );
            thermal_cell(
                height,
                delta,
                hardness,
                None,
                w,
                h,
                w - 1,
                j,
                talus,
                diagonal,
                rate,
            );
        }
        for i in 0..w {
            thermal_cell(
                height,
                delta,
                hardness,
                None,
                w,
                h,
                i,
                h - 1,
                talus,
                diagonal,
                rate,
            );
        }
    }
    for (((height, debris), delta), wear) in height.iter_mut().zip(debris).zip(delta).zip(wear) {
        if *delta != 0.0 {
            *height += *delta;
            *debris += *delta;
        }
        *wear += finite_max(-*delta, 0.0);
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
    let mut profile = Profile::new("droplet");
    #[cfg(feature = "profile")]
    let mut samples = Profile::new("droplet_samples_1_in_256");
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
    profile.mark("validation_setup");
    for _ in 0..params.iterations {
        if params.rain_density > 0.0 && params.rain_amount > 0.0 {
            before.copy_from_slice(&field.height);
            profile.mark("copy_height");
            hydraulic_pass(
                &mut field,
                params,
                &mut rng,
                &brush,
                &mut rain,
                &mut profile,
                #[cfg(feature = "profile")]
                &mut samples,
            );
            smooth_deposits(
                &mut field,
                &before,
                &mut deposits,
                &mut scratch,
                &mut sediment,
                &mut wear,
            );
            profile.mark("smooth_deposits_and_layers");
        }
        if params.thermal_rate > 0.0 {
            thermal_pass(
                &mut field.height,
                &mut debris,
                &mut scratch,
                &mut wear,
                hardness,
                freeze,
                w,
                h,
                cell,
                params.talus_angle,
                params.thermal_rate,
            );
            profile.mark("thermal_and_wear");
        }
    }
    let result = ErosionResult {
        height: layer_f32(field.height)?,
        sediment: layer_f32(sediment)?,
        debris: layer_f32(debris)?,
        flow: layer_f32(field.flow)?,
        water: layer_f32(field.water)?,
        wear: layer_f32(wear)?,
    };
    profile.mark("output_layers");
    profile.finish();
    #[cfg(feature = "profile")]
    samples.finish();
    Ok(result)
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
    fn thermal_rows_match_checked_cells_at_small_grid_borders() {
        for w in 2..8 {
            for h in 2..8 {
                for masked in 0..3 {
                    let input: Vec<f64> = terrain(w, h, 3).into_iter().map(f64::from).collect();
                    let hard: Vec<f32> = (0..w * h).map(|k| (k % 5) as f32 * 0.25).collect();
                    let frozen: Vec<f32> = (0..w * h)
                        .map(|k| if k % 7 == 0 { 1.0 } else { 0.0 })
                        .collect();
                    let hardness = (masked > 0).then_some(hard.as_slice());
                    let freeze = (masked == 2).then_some(frozen.as_slice());
                    let mut expected = input.clone();
                    let mut reference_delta = vec![0.0; w * h];
                    let talus = libm::tan(0.2) * 0.7;
                    for j in 0..h {
                        for i in 0..w {
                            thermal_cell(
                                &input,
                                &mut reference_delta,
                                hardness,
                                freeze,
                                w,
                                h,
                                i,
                                j,
                                talus,
                                talus * std::f64::consts::SQRT_2,
                                0.3,
                            );
                        }
                    }
                    for (height, delta) in expected.iter_mut().zip(&reference_delta) {
                        if *delta != 0.0 {
                            *height += delta;
                        }
                    }
                    let mut actual = input;
                    let mut debris = vec![0.0; w * h];
                    let mut delta = vec![0.0; w * h];
                    let mut wear = vec![0.0; w * h];
                    thermal_pass(
                        &mut actual,
                        &mut debris,
                        &mut delta,
                        &mut wear,
                        hardness,
                        freeze,
                        w,
                        h,
                        0.7,
                        0.2,
                        0.3,
                    );
                    assert_eq!(actual, expected, "{w} x {h}, mask {masked}");
                    assert_eq!(delta, reference_delta);
                    assert_eq!(debris, reference_delta);
                    for (wear, delta) in wear.iter().zip(&reference_delta) {
                        assert_eq!(*wear, finite_max(-*delta, 0.0));
                    }
                }
            }
        }
    }

    #[test]
    fn gathered_deposits_match_scatter_at_small_grid_borders() {
        // A scalar scatter reference checks the gather's special 2/3 borders,
        // overlapping small-grid cases and fused signed-layer accounting.
        for w in 2..8 {
            for h in 2..8 {
                let n = w * h;
                let before: Vec<f64> = (0..n).map(|k| 4.0 + (k % 7) as f64 / 16.0).collect();
                for pattern in 0..3 {
                    let after: Vec<f64> = before
                        .iter()
                        .enumerate()
                        .map(|(k, v)| {
                            v + if pattern == 0 {
                                -0.125
                            } else {
                                [-0.375, 0.0, 0.1, 0.75][(k + pattern) % 4]
                            }
                        })
                        .collect();
                    let mut expected = after.clone();
                    let mut deposited = vec![0.0; n];
                    let mut horizontal = vec![0.0; n];
                    for k in 0..n {
                        let d = expected[k] - before[k];
                        if d > 0.0 {
                            deposited[k] = d;
                            expected[k] -= d;
                        }
                    }
                    for j in 0..h {
                        for i in 0..w {
                            let k = j * w + i;
                            let v = deposited[k];
                            if v == 0.0 {
                                continue;
                            }
                            if i == 0 {
                                horizontal[k] += v * (2.0 / 3.0);
                                horizontal[k + 1] += v / 3.0;
                            } else if i + 1 == w {
                                horizontal[k] += v * (2.0 / 3.0);
                                horizontal[k - 1] += v / 3.0;
                            } else {
                                horizontal[k - 1] += v * 0.25;
                                horizontal[k] += v * 0.5;
                                horizontal[k + 1] += v * 0.25;
                            }
                        }
                    }
                    for j in 0..h {
                        for i in 0..w {
                            let k = j * w + i;
                            let v = horizontal[k];
                            if v == 0.0 {
                                continue;
                            }
                            if j == 0 {
                                expected[k] += v * (2.0 / 3.0);
                                expected[k + w] += v / 3.0;
                            } else if j + 1 == h {
                                expected[k] += v * (2.0 / 3.0);
                                expected[k - w] += v / 3.0;
                            } else {
                                expected[k - w] += v * 0.25;
                                expected[k] += v * 0.5;
                                expected[k + w] += v * 0.25;
                            }
                        }
                    }
                    let mut field = Field {
                        w,
                        h,
                        cell: 1.0,
                        height: after,
                        hardness: None,
                        freeze: None,
                        flow: vec![0.0; n],
                        water: vec![0.0; n],
                    };
                    let mut sediment = vec![0.0; n];
                    let mut wear = vec![0.0; n];
                    smooth_deposits(
                        &mut field,
                        &before,
                        &mut deposited,
                        &mut horizontal,
                        &mut sediment,
                        &mut wear,
                    );
                    assert_eq!(field.height, expected, "{w} x {h}, pattern {pattern}");
                    for k in 0..n {
                        let delta = expected[k] - before[k];
                        assert_eq!(sediment[k], delta);
                        assert_eq!(wear[k], (-delta).max(0.0));
                    }
                }
            }
        }
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
