//! Four-pipe shallow-water hydraulic erosion, with conservative characteristic
//! sediment remapping, optional stream power and a separate thermal pass.
//!
//! Based on Mei, Decaudin and Hu (Pacific Graphics 2007). Closed cells share
//! exactly the same face flux; outgoing flux is limited to available water.
//! Sediment follows forward semi-Lagrangian characteristics and is scattered
//! bilinearly, preserving mass without a global rescaling of the sediment map.

use crate::erosion_flow::{FlowMethod, flow_accumulation, validate_grid};

#[derive(Clone, Debug, PartialEq)]
pub struct ErosionResult {
    pub height: Vec<f32>,
    pub sediment: Vec<f32>,
    pub debris: Vec<f32>,
    pub flow: Vec<f32>,
    pub water: Vec<f32>,
    pub wear: Vec<f32>,
}

#[derive(Clone, Debug)]
pub struct PipeParams {
    pub iterations: u32,
    /// Rain depth per second; rain map multiplies this amount.
    pub rain_amount: f32,
    /// Fraction of water evaporated per second.
    pub evaporation: f32,
    pub sediment_capacity: f32,
    pub erosion_rate: f32,
    pub deposition_rate: f32,
    pub gravity: f32,
    /// Radians.
    pub talus_angle: f32,
    pub thermal_rate: f32,
    /// Maximum step in seconds; zero selects the internal CFL step.
    pub time_step: f32,
    pub open_boundary: bool,
    pub stream_power_k: f32,
    pub stream_power_m: f32,
    pub stream_power_n: f32,
}

impl Default for PipeParams {
    fn default() -> Self {
        Self {
            iterations: 50,
            rain_amount: 1.0,
            evaporation: 0.1,
            sediment_capacity: 1.0,
            erosion_rate: 0.3,
            deposition_rate: 0.3,
            gravity: 4.0,
            talus_angle: 40.0 * std::f32::consts::PI / 180.0,
            thermal_rate: 0.1,
            time_step: 0.0,
            open_boundary: false,
            stream_power_k: 0.0,
            stream_power_m: 0.5,
            stream_power_n: 1.0,
        }
    }
}

fn validate_layer(layer: Option<&[f32]>, n: usize, name: &str, max: f32) -> Result<(), String> {
    if let Some(values) = layer
        && (values.len() != n
            || values
                .iter()
                .any(|v| !v.is_finite() || *v < 0.0 || *v > max))
    {
        return Err(format!(
            "erosion: {name} must have one finite sample in 0..{max} per grid cell"
        ));
    }
    Ok(())
}

fn validate_params(p: &PipeParams) -> Result<(), String> {
    let finite = [
        p.rain_amount,
        p.evaporation,
        p.sediment_capacity,
        p.erosion_rate,
        p.deposition_rate,
        p.gravity,
        p.talus_angle,
        p.thermal_rate,
        p.time_step,
        p.stream_power_k,
        p.stream_power_m,
        p.stream_power_n,
    ];
    if finite.iter().any(|v| !v.is_finite() || *v < 0.0)
        || p.iterations > 10_000
        || p.rain_amount > 1000.0
        || p.evaporation > 1.0
        || p.sediment_capacity > 1000.0
        || p.erosion_rate > 1.0
        || p.deposition_rate > 1.0
        || !(1e-4..=1000.0).contains(&p.gravity)
        || p.talus_angle >= std::f32::consts::FRAC_PI_2
        || p.thermal_rate > 1.0
        || p.time_step > 1000.0
        || p.stream_power_k > 1000.0
        || p.stream_power_m > 4.0
        || p.stream_power_n > 4.0
    {
        return Err("erosion: invalid pipe parameters (finite nonnegative values required; rates and evaporation 0..1, talus 0..pi/2, iterations <=10000, stream exponents <=4)".into());
    }
    Ok(())
}

#[inline]
fn power(value: f32, exponent: f32) -> f32 {
    if exponent == 1.0 {
        value
    } else if exponent == 0.5 {
        value.sqrt()
    } else if exponent == 0.0 {
        1.0
    } else {
        libm::powf(value, exponent)
    }
}

/// Uniform rain is deterministic and does not consume the seed. It remains an
/// explicit parameter for API compatibility and future stochastic rain models.
#[allow(clippy::too_many_arguments)]
pub fn erode_pipe(
    height: &[f32],
    hardness: Option<&[f32]>,
    freeze: Option<&[f32]>,
    rain: Option<&[f32]>,
    w: usize,
    h: usize,
    cell: f32,
    p: &PipeParams,
    _seed: u64,
) -> Result<ErosionResult, String> {
    let n = validate_grid(height, w, h, cell)?;
    validate_layer(hardness, n, "hardness", 1.0)?;
    validate_layer(freeze, n, "freeze", 1.0)?;
    validate_layer(rain, n, "rain map", 1000.0)?;
    validate_params(p)?;
    if (n as u64) * p.iterations as u64 > 4_000_000_000 {
        return Err(
            "erosion: grid times iteration count exceeds the 4 billion cell-step limit".into(),
        );
    }
    let mut result = ErosionResult {
        height: height.to_vec(),
        sediment: vec![0.0; n],
        debris: vec![0.0; n],
        flow: vec![0.0; n],
        water: vec![0.0; n],
        wear: vec![0.0; n],
    };
    if p.iterations == 0 {
        return Ok(result);
    }
    // All work buffers are allocated once; the hot loops never allocate.
    let mut flux = vec![[0.0f32; 4]; n]; // west, east, north, south; per-unit-width discharge
    let mut suspended = vec![0.0f32; n];
    let mut remapped = vec![0.0f32; n];
    let mut velocity = vec![[0.0f32; 2]; n];
    let mut surface = vec![0.0f32; n];
    let mut thermal_delta = if p.thermal_rate > 0.0 {
        vec![0.0f32; n]
    } else {
        Vec::new()
    };
    let mobility: Vec<f32> = (0..n).map(|i| 1.0 - freeze.map_or(0.0, |a| a[i])).collect();
    let softness: Vec<f32> = (0..n)
        .map(|i| mobility[i] * (1.0 - hardness.map_or(0.0, |a| a[i])))
        .collect();
    let incision = if p.stream_power_k > 0.0 {
        // Reference drainage is intentionally computed on the incoming DEM.
        // Updating it mid-solve can cause discontinuous jumps in the network.
        flow_accumulation(height, w, h, cell, FlowMethod::Dinf)?
            .drainage
            .into_iter()
            .map(|a| {
                (p.stream_power_k as f64 * libm::pow(a as f64, p.stream_power_m as f64)).min(1e12)
                    as f32
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let inv_cell = 1.0 / cell;
    let mut max_depth = 0.0f32;
    let max_rain_rate = p.rain_amount * rain.map_or(1.0, |a| a.iter().copied().fold(0.0, f32::max));
    let mut max_velocity = 0.0;
    let talus = libm::tanf(p.talus_angle) * cell;
    for _ in 0..p.iterations {
        // The user time step is an upper bound, never permission to violate CFL.
        let cfl = 0.4 * cell / (max_velocity + (p.gravity * max_depth.max(cell)).sqrt());
        let tentative_dt = if p.time_step > 0.0 {
            cfl.min(p.time_step)
        } else {
            cfl
        };
        // Bound the depth after this step's rain too. Since the corrected step
        // cannot exceed tentative_dt, its actual rainfall is at most this bound.
        let rain_depth_bound = (max_depth + max_rain_rate * tentative_dt).max(cell);
        let dt =
            tentative_dt.min(0.4 * cell / (max_velocity + (p.gravity * rain_depth_bound).sqrt()));
        let rainfall = p.rain_amount * dt;
        for i in 0..n {
            result.water[i] += rainfall * rain.map_or(1.0, |a| a[i]);
            surface[i] = result.height[i] + result.water[i];
        }
        // Flux update with a local water budget. All faces are read before any
        // water depth is written, eliminating traversal-order dependence.
        let acceleration = dt * p.gravity;
        let budget_scale = cell / dt;
        for z in 0..h {
            for x in 0..w {
                let i = z * w + x;
                let s = surface[i];
                let out_head = if p.open_boundary {
                    result.water[i]
                } else {
                    0.0
                };
                let west = if x > 0 { s - surface[i - 1] } else { out_head };
                let east = if x + 1 < w {
                    s - surface[i + 1]
                } else {
                    out_head
                };
                let north = if z > 0 { s - surface[i - w] } else { out_head };
                let south = if z + 1 < h {
                    s - surface[i + w]
                } else {
                    out_head
                };
                let old = flux[i];
                let mut q = [
                    (old[0] + acceleration * west).max(0.0),
                    (old[1] + acceleration * east).max(0.0),
                    (old[2] + acceleration * north).max(0.0),
                    (old[3] + acceleration * south).max(0.0),
                ];
                if !p.open_boundary {
                    if x == 0 {
                        q[0] = 0.0;
                    }
                    if x + 1 == w {
                        q[1] = 0.0;
                    }
                    if z == 0 {
                        q[2] = 0.0;
                    }
                    if z + 1 == h {
                        q[3] = 0.0;
                    }
                }
                let total = q[0] + q[1] + q[2] + q[3];
                let scale = (result.water[i] * budget_scale / total.max(1e-30)).min(1.0);
                flux[i] = [q[0] * scale, q[1] * scale, q[2] * scale, q[3] * scale];
            }
        }
        max_depth = 0.0;
        max_velocity = 0.0;
        let flow_dt = dt * inv_cell;
        let velocity_limit = 0.45 * cell / dt;
        surface.copy_from_slice(&result.height);
        for z in 0..h {
            for x in 0..w {
                let i = z * w + x;
                let q = flux[i];
                let west = if x > 0 { flux[i - 1][1] } else { 0.0 };
                let east = if x + 1 < w { flux[i + 1][0] } else { 0.0 };
                let north = if z > 0 { flux[i - w][3] } else { 0.0 };
                let south = if z + 1 < h { flux[i + w][2] } else { 0.0 };
                let old_depth = result.water[i];
                let depth = (old_depth
                    + flow_dt * (west + east + north + south - q[0] - q[1] - q[2] - q[3]))
                    .max(0.0);
                result.water[i] = depth;
                max_depth = max_depth.max(depth);
                let denominator = (old_depth + depth).max(1e-12);
                let mut vx = (west - q[0] + q[1] - east) / denominator;
                let mut vz = (north - q[2] + q[3] - south) / denominator;
                let raw_speed = (vx * vx + vz * vz).sqrt();
                let speed = raw_speed.min(velocity_limit);
                if raw_speed > velocity_limit {
                    let s = velocity_limit / raw_speed;
                    vx *= s;
                    vz *= s;
                }
                velocity[i] = [vx, vz];
                max_velocity = max_velocity.max(speed);
                result.flow[i] += speed * dt;
                // The terrain snapshot makes this fused update independent of
                // traversal; the velocity magnitude is reused for capacity.
                let a = surface[i];
                let west = surface[if x > 0 { i - 1 } else { i }];
                let east = surface[if x + 1 < w { i + 1 } else { i }];
                let north = surface[if z > 0 { i - w } else { i }];
                let south = surface[if z + 1 < h { i + w } else { i }];
                let dx = (east - west) * inv_cell / if x > 0 && x + 1 < w { 2.0 } else { 1.0 };
                let dz = (south - north) * inv_cell / if z > 0 && z + 1 < h { 2.0 } else { 1.0 };
                let slope = (dx * dx + dz * dz).sqrt();
                let speed = if raw_speed > velocity_limit {
                    (vx * vx + vz * vz).sqrt()
                } else {
                    raw_speed
                };
                let cap = (p.sediment_capacity
                    * speed
                    * (slope / (1.0 + slope * slope).sqrt())
                    * result.water[i])
                    .min(1e8);
                let material = suspended[i];
                if material > cap {
                    let requested =
                        (material - cap) * (p.deposition_rate * dt).min(1.0) * mobility[i];
                    let before = result.height[i];
                    result.height[i] += requested;
                    let deposited = (result.height[i] - before).max(0.0).min(material);
                    suspended[i] -= deposited;
                    result.sediment[i] += deposited;
                } else {
                    let relief = (a - west.min(east).min(north).min(south)).max(0.0);
                    let hydraulic = (cap - material) * (p.erosion_rate * dt).min(1.0);
                    let stream = if incision.is_empty() || result.water[i] <= 1e-12 {
                        0.0
                    } else {
                        (incision[i] * power(slope, p.stream_power_n) * dt).min(1e8)
                    };
                    let requested = (hydraulic + stream).min(relief * 0.25) * softness[i];
                    let before = result.height[i];
                    result.height[i] -= requested;
                    let eroded = (before - result.height[i]).max(0.0);
                    suspended[i] += eroded;
                    result.wear[i] += eroded;
                }
            }
        }
        remapped.fill(0.0);
        for z in 0..h {
            for x in 0..w {
                let i = z * w + x;
                let material = suspended[i];
                if material == 0.0 {
                    continue;
                }
                let v = velocity[i];
                let tx = (x as f32 + v[0] * flow_dt).clamp(0.0, (w - 1) as f32);
                let tz = (z as f32 + v[1] * flow_dt).clamp(0.0, (h - 1) as f32);
                let x0 = (tx as usize).min(w - 2);
                let z0 = (tz as usize).min(h - 2);
                let fx = tx - x0 as f32;
                let fz = tz - z0 as f32;
                let indices = [
                    z0 * w + x0,
                    z0 * w + x0 + 1,
                    (z0 + 1) * w + x0,
                    (z0 + 1) * w + x0 + 1,
                ];
                let mut weights = [
                    (1.0 - fx) * (1.0 - fz),
                    fx * (1.0 - fz),
                    (1.0 - fx) * fz,
                    fx * fz,
                ];
                let mut sum = 0.0;
                for k in 0..4 {
                    if mobility[indices[k]] == 0.0 {
                        weights[k] = 0.0;
                    }
                    sum += weights[k];
                }
                if sum <= 0.0 {
                    remapped[i] += material;
                    continue;
                }
                // The last nonzero receiver gets the subtraction remainder.
                let last = (0..4).rfind(|&k| weights[k] > 0.0).unwrap_or(0);
                let mut remainder = material;
                for k in 0..last {
                    let part = (material * weights[k] / sum).min(remainder);
                    remapped[indices[k]] += part;
                    remainder -= part;
                }
                remapped[indices[last]] += remainder;
            }
        }
        std::mem::swap(&mut suspended, &mut remapped);
        // Open boundaries discard water only. Suspended rock remains in-grid,
        // and settles at the endpoint; no unreported material export is hidden.
        evaporate(&mut result.water, (1.0 - p.evaporation * dt).max(0.0));
        if p.thermal_rate > 0.0 {
            thermal_pass(
                &mut result,
                &mut thermal_delta,
                &softness,
                &mobility,
                w,
                h,
                talus,
                p.thermal_rate,
            );
        }
    }
    // Expose deposited thickness rather than an invisible suspended load.
    for (i, load) in suspended.into_iter().enumerate() {
        if mobility[i] > 0.0 {
            result.height[i] += load;
            result.sediment[i] += load;
        }
    }
    let max_flow = result.flow.iter().copied().fold(0.0f32, f32::max);
    if max_flow > 0.0 {
        for v in &mut result.flow {
            *v /= max_flow;
        }
    }
    if result
        .height
        .iter()
        .chain(&result.water)
        .chain(&result.sediment)
        .chain(&result.debris)
        .chain(&result.wear)
        .chain(&result.flow)
        .any(|v| !v.is_finite())
    {
        return Err("erosion: numerical range exceeded; reduce rain, stream power, iterations or input relief".into());
    }
    Ok(result)
}

fn evaporate(water: &mut [f32], factor: f32) {
    #[cfg(all(target_arch = "wasm32", feature = "simd"))]
    // This branch is opt-in and the module advertises its SIMD requirement.
    unsafe {
        evaporate_simd(water, factor);
    }
    #[cfg(not(all(target_arch = "wasm32", feature = "simd")))]
    for v in water {
        *v *= factor;
    }
}

#[cfg(all(target_arch = "wasm32", feature = "simd"))]
#[target_feature(enable = "simd128")]
unsafe fn evaporate_simd(water: &mut [f32], factor: f32) {
    use std::arch::wasm32::{f32x4_mul, f32x4_splat, v128_load, v128_store};
    let factor4 = f32x4_splat(factor);
    let mut chunks = water.chunks_exact_mut(4);
    for chunk in &mut chunks {
        // Each chunk has precisely four valid f32 lanes; unaligned v128 access
        // is supported. Operation order matches the scalar lane multiplication.
        unsafe {
            let v = v128_load(chunk.as_ptr().cast());
            v128_store(chunk.as_mut_ptr().cast(), f32x4_mul(v, factor4));
        }
    }
    for v in chunks.into_remainder() {
        *v *= factor;
    }
}

#[allow(clippy::too_many_arguments)]
fn thermal_pass(
    result: &mut ErosionResult,
    delta: &mut [f32],
    softness: &[f32],
    mobility: &[f32],
    w: usize,
    h: usize,
    talus: f32,
    rate: f32,
) {
    delta.fill(0.0);
    for z in 0..h {
        for x in 0..w {
            let i = z * w + x;
            if softness[i] == 0.0 {
                continue;
            }
            if x > 0 && x + 1 < w && z > 0 && z + 1 < h {
                let a = result.height[i];
                let cardinal = result.height[i - 1]
                    .min(result.height[i + 1])
                    .min(result.height[i - w])
                    .min(result.height[i + w]);
                let diagonal = result.height[i - w - 1]
                    .min(result.height[i - w + 1])
                    .min(result.height[i + w - 1])
                    .min(result.height[i + w + 1]);
                if a - cardinal <= talus && a - diagonal <= talus * std::f32::consts::SQRT_2 {
                    continue;
                }
            }
            let mut targets = [0usize; 8];
            let mut excess = [0.0f32; 8];
            let mut sum = 0.0;
            let mut maximum = 0.0f32;
            let mut count = 0;
            for dz in -1isize..=1 {
                for dx in -1isize..=1 {
                    if dx == 0 && dz == 0 {
                        continue;
                    }
                    let nx = x as isize + dx;
                    let nz = z as isize + dz;
                    if nx < 0 || nz < 0 || nx >= w as isize || nz >= h as isize {
                        continue;
                    }
                    let j = nz as usize * w + nx as usize;
                    let threshold = talus
                        * if dx != 0 && dz != 0 {
                            std::f32::consts::SQRT_2
                        } else {
                            1.0
                        };
                    let amount =
                        (result.height[i] - result.height[j] - threshold).max(0.0) * mobility[j];
                    if amount == 0.0 {
                        continue;
                    }
                    targets[count] = j;
                    excess[count] = amount;
                    count += 1;
                    sum += amount;
                    maximum = maximum.max(amount);
                }
            }
            if sum == 0.0 {
                continue;
            }
            let amount = maximum * 0.25 * rate * softness[i];
            delta[i] -= amount;
            result.wear[i] += amount;
            let mut remaining = amount;
            for k in 0..count {
                let part = if k + 1 == count {
                    remaining
                } else {
                    (amount * excess[k] / sum).min(remaining)
                };
                remaining -= part;
                let j = targets[k];
                delta[j] += part;
                result.debris[j] += part;
            }
        }
    }
    for (v, d) in result.height.iter_mut().zip(delta) {
        *v += *d;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sum(a: &[f32]) -> f64 {
        a.iter().map(|&x| x as f64).sum()
    }
    fn terrain(w: usize, h: usize, seed: u32) -> Vec<f32> {
        let mut state = seed;
        (0..w * h)
            .map(|i| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                10.0 + (w - i % w) as f32 * 0.15 + (state >> 8) as f32 / 16777216.0 * 0.4
            })
            .collect()
    }
    #[test]
    fn closed_material_is_conserved_and_layers_finite() {
        for seed in 1..=12 {
            let w = 9 + seed as usize;
            let h = 13;
            let input = terrain(w, h, seed);
            let p = PipeParams {
                iterations: 40,
                stream_power_k: if seed % 2 == 0 { 0.1 } else { 0.0 },
                ..Default::default()
            };
            let r = erode_pipe(&input, None, None, None, w, h, 0.5, &p, seed as u64).unwrap();
            assert!((sum(&r.height) - sum(&input)).abs() / sum(&input).abs() < 1e-5);
            for layer in [&r.water, &r.sediment, &r.flow, &r.debris, &r.wear] {
                assert!(layer.iter().all(|v| v.is_finite() && *v >= 0.0));
            }
            assert!(r.flow.iter().all(|v| *v <= 1.0));
            assert_eq!(
                r,
                erode_pipe(&input, None, None, None, w, h, 0.5, &p, seed as u64).unwrap()
            );
        }
    }
    #[test]
    fn hard_and_frozen_terrain_never_erodes() {
        let input = terrain(18, 17, 5);
        let full = vec![1.0; input.len()];
        let p = PipeParams {
            iterations: 60,
            stream_power_k: 0.3,
            talus_angle: 0.01,
            ..Default::default()
        };
        for (hard, freeze) in [(Some(full.as_slice()), None), (None, Some(full.as_slice()))] {
            let r = erode_pipe(&input, hard, freeze, None, 18, 17, 1.0, &p, 5).unwrap();
            assert_eq!(r.height, input);
            assert!(r.wear.iter().all(|v| *v == 0.0));
        }
    }
    #[test]
    fn flat_terrain_stays_flat() {
        let input = vec![7.5; 23 * 19];
        let p = PipeParams {
            iterations: 70,
            stream_power_k: 0.02,
            ..Default::default()
        };
        let r = erode_pipe(&input, None, None, None, 23, 19, 1.0, &p, 10).unwrap();
        assert_eq!(r.height, input);
        assert!(r.water.windows(2).all(|v| v[0] == v[1]));
        assert!(r.flow.iter().all(|v| *v == 0.0));
    }
    #[test]
    fn open_edges_release_water() {
        let input = vec![0.0; 16 * 16];
        let p = PipeParams {
            iterations: 30,
            thermal_rate: 0.0,
            ..Default::default()
        };
        let closed = erode_pipe(&input, None, None, None, 16, 16, 1.0, &p, 0).unwrap();
        let open = erode_pipe(
            &input,
            None,
            None,
            None,
            16,
            16,
            1.0,
            &PipeParams {
                open_boundary: true,
                ..p
            },
            0,
        )
        .unwrap();
        assert!(sum(&open.water) < sum(&closed.water));
        assert_eq!(open.height, input);
    }
    #[test]
    fn raining_plane_carries_water_to_low_edge() {
        let w = 17;
        let h = 13;
        let input: Vec<f32> = (0..w * h).map(|i| 8.0 - (i % w) as f32 * 0.1).collect();
        let p = PipeParams {
            iterations: 45,
            thermal_rate: 0.0,
            erosion_rate: 0.0,
            rain_amount: 0.1,
            ..Default::default()
        };
        let r = erode_pipe(&input, None, None, None, w, h, 1.0, &p, 1).unwrap();
        let high: f32 = (0..h).map(|z| r.water[z * w]).sum();
        let low: f32 = (0..h).map(|z| r.water[z * w + w - 1]).sum();
        assert!(low > high * 2.0);
        assert_eq!(r.height, input);
    }
    #[test]
    fn rain_map_and_freeze_are_respected() {
        let input = terrain(12, 11, 2);
        let rain = vec![0.0; input.len()];
        let p = PipeParams {
            thermal_rate: 0.0,
            iterations: 30,
            ..Default::default()
        };
        let dry = erode_pipe(&input, None, None, Some(&rain), 12, 11, 1.0, &p, 1).unwrap();
        assert_eq!(dry.height, input);
        assert!(dry.water.iter().all(|v| *v == 0.0));
        let mut freeze = vec![0.0; input.len()];
        for i in (0..input.len()).step_by(3) {
            freeze[i] = 1.0;
        }
        let wet = erode_pipe(&input, None, Some(&freeze), None, 12, 11, 1.0, &p, 1).unwrap();
        for i in (0..input.len()).step_by(3) {
            assert_eq!(wet.height[i], input[i]);
        }
        assert!((sum(&wet.height) - sum(&input)).abs() / sum(&input) < 1e-5);
    }
    #[test]
    fn valley_stream_power_carves_a_monotone_channel() {
        let w = 31;
        let h = 41;
        let input: Vec<f32> = (0..w * h)
            .map(|i| 10.0 + (h - i / w) as f32 * 0.3 + ((i % w) as f32 - 15.0).abs() * 0.5)
            .collect();
        let p = PipeParams {
            iterations: 35,
            thermal_rate: 0.0,
            erosion_rate: 0.0,
            stream_power_k: 0.03,
            open_boundary: true,
            ..Default::default()
        };
        let r = erode_pipe(&input, None, None, None, w, h, 1.0, &p, 0).unwrap();
        assert!(r.wear[20 * w + 15] > 0.0);
        for z in 0..h - 1 {
            assert!(r.height[z * w + 15] > r.height[(z + 1) * w + 15]);
        }
        assert!(r.wear[20 * w + 15] > r.wear[20 * w + 4]);
    }
    #[test]
    fn timestep_accounts_for_incoming_rain() {
        let input = [0.0; 9];
        let rain = [1000.0; 9];
        let p = PipeParams {
            iterations: 1,
            rain_amount: 1000.0,
            evaporation: 0.0,
            thermal_rate: 0.0,
            time_step: 1000.0,
            ..Default::default()
        };
        let r = erode_pipe(&input, None, None, Some(&rain), 3, 3, 1.0, &p, 0).unwrap();
        let elapsed = r.water[4] / (p.rain_amount * rain[4]);
        let courant = elapsed * (p.gravity * r.water[4]).sqrt();
        assert!(
            courant <= 0.4,
            "rainfall must not bypass the gravity-wave CFL bound"
        );
    }

    #[test]
    fn malformed_and_extreme_inputs_are_errors_not_panics() {
        let p = PipeParams::default();
        assert!(erode_pipe(&[0.0; 4], Some(&[]), None, None, 2, 2, 1.0, &p, 0).is_err());
        assert!(erode_pipe(&[0.0; 4], None, None, None, usize::MAX, 2, 1.0, &p, 0).is_err());
        assert!(
            erode_pipe(
                &[0.0; 4],
                None,
                None,
                None,
                2,
                2,
                1.0,
                &PipeParams { gravity: 0.0, ..p },
                0
            )
            .is_err()
        );
        for seed in 1..40 {
            let input = terrain(7, 9, seed);
            let p = PipeParams {
                iterations: 8,
                rain_amount: 1000.0,
                time_step: 1000.0,
                gravity: 1000.0,
                stream_power_k: 1000.0,
                stream_power_m: 4.0,
                stream_power_n: 4.0,
                ..Default::default()
            };
            let r = erode_pipe(&input, None, None, None, 7, 9, 0.01, &p, seed as u64).unwrap();
            assert!(r.height.iter().all(|v| v.is_finite()));
        }
    }
}
