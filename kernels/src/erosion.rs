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

// The solver validates finite inputs and checks finite outputs. Unlike
// `f32::min/max`, these ordered comparisons do not require a NaN-select sequence
// (or a scalar fminf/fmaxf call in WASM) for every stencil/reduction operation.
// A NaN second operand propagates, so the final numerical-range check remains.
#[inline(always)]
fn lower(a: f32, b: f32) -> f32 {
    if a < b { a } else { b }
}

#[inline(always)]
fn upper(a: f32, b: f32) -> f32 {
    if a > b { a } else { b }
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
    let mut profile = crate::erosion_profile::Profile::new("pipe");
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
    let stride = w + 2;
    let padded_n = stride * (h + 2);
    // Zero ghost fluxes encode the external incoming boundary condition.
    let mut flux_west = vec![0.0f32; padded_n];
    let mut flux_east = vec![0.0f32; padded_n];
    let mut flux_north = vec![0.0f32; padded_n];
    let mut flux_south = vec![0.0f32; padded_n];
    let mut suspended = vec![0.0f32; n];
    let mut remapped = vec![0.0f32; n];
    let mut velocity = vec![[0.0f32; 2]; w];
    let mut row_speed = vec![0.0f32; w];
    let mut row_limited_speed = vec![0.0f32; w];
    let mut row_change = vec![0.0f32; w];
    let mut row_after = vec![0.0f32; w];
    let mut surface = vec![0.0f32; padded_n];
    let mut thermal_delta = if p.thermal_rate > 0.0 {
        vec![0.0f32; n]
    } else {
        Vec::new()
    };
    let mobility: Vec<f32> = (0..n).map(|i| 1.0 - freeze.map_or(0.0, |a| a[i])).collect();
    let has_frozen = mobility.contains(&0.0);
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
    // Gradients change only when an f32 terrain sample actually changes.
    // Keep a deduplicated work list, preallocated for the entire grid.
    let mut slope_factor = vec![0.0f32; n];
    let mut slope_magnitude = vec![0.0f32; n];
    let mut relief = vec![0.0f32; n];
    let mut gradient_dirty = Vec::with_capacity(n);
    gradient_dirty.extend(0..n);
    let mut gradient_marked = vec![true; n];
    #[cfg(all(feature = "profile", not(target_arch = "wasm32")))]
    let mut gradient_updates = 0u64;
    let mut max_depth = 0.0f32;
    let max_rain_rate = p.rain_amount * rain.map_or(1.0, |a| a.iter().copied().fold(0.0, f32::max));
    let mut max_velocity = 0.0;
    let talus = libm::tanf(p.talus_angle) * cell;
    let mut thermal_margin = if p.thermal_rate > 0.0 {
        inactive_thermal_margin(height, w, h, talus)
    } else {
        f64::NEG_INFINITY
    };
    profile.mark("setup");
    for _ in 0..p.iterations {
        #[cfg(all(feature = "profile", not(target_arch = "wasm32")))]
        {
            gradient_updates += gradient_dirty.len() as u64;
        }
        for &i in &gradient_dirty {
            let x = i % w;
            let z = i / w;
            let a = result.height[i];
            let west = result.height[if x > 0 { i - 1 } else { i }];
            let east = result.height[if x + 1 < w { i + 1 } else { i }];
            let north = result.height[if z > 0 { i - w } else { i }];
            let south = result.height[if z + 1 < h { i + w } else { i }];
            let gx = if x > 0 && x + 1 < w {
                inv_cell * 0.5
            } else {
                inv_cell
            };
            let gz = if z > 0 && z + 1 < h {
                inv_cell * 0.5
            } else {
                inv_cell
            };
            let dx = (east - west) * gx;
            let dz = (south - north) * gz;
            let squared = dx * dx + dz * dz;
            slope_factor[i] = (squared / (1.0 + squared)).sqrt();
            if !incision.is_empty() {
                slope_magnitude[i] = squared.sqrt();
            }
            relief[i] = upper(a - lower(lower(lower(west, east), north), south), 0.0);
            gradient_marked[i] = false;
        }
        gradient_dirty.clear();
        profile.mark("terrain gradients");
        // The user time step is an upper bound, never permission to violate CFL.
        let cfl = 0.4 * cell / (max_velocity + (p.gravity * upper(max_depth, cell)).sqrt());
        let tentative_dt = if p.time_step > 0.0 {
            lower(cfl, p.time_step)
        } else {
            cfl
        };
        // Bound the depth after this step's rain too. Since the corrected step
        // cannot exceed tentative_dt, its actual rainfall is at most this bound.
        let rain_depth_bound = upper(max_depth + max_rain_rate * tentative_dt, cell);
        let dt = lower(
            tentative_dt,
            0.4 * cell / (max_velocity + (p.gravity * rain_depth_bound).sqrt()),
        );
        let rainfall = p.rain_amount * dt;
        let acceleration = dt * p.gravity;
        let budget_scale = cell / dt;
        // Prepare one row ahead, then consume its north neighbor's flux.
        // Rain/surface and flux form one streaming sweep over the grid.
        for next in 0..=h {
            if next < h {
                let start = next * w;
                let base = (next + 1) * stride;
                let water = &mut result.water[start..start + w];
                let height = &result.height[start..start + w];
                let out = &mut surface[base..base + stride];
                if let Some(rain) = rain {
                    rain_surface_row::<true>(
                        water,
                        height,
                        &rain[start..start + w],
                        out,
                        rainfall,
                        p.open_boundary,
                    );
                } else {
                    rain_surface_row::<false>(water, height, &[], out, rainfall, p.open_boundary);
                }
                if next == 0 {
                    if p.open_boundary {
                        surface[1..w + 1].copy_from_slice(height);
                    } else {
                        surface.copy_within(stride + 1..stride + w + 1, 1);
                    }
                }
                if next + 1 == h {
                    let destination = (h + 1) * stride + 1;
                    if p.open_boundary {
                        surface[destination..destination + w].copy_from_slice(height);
                    } else {
                        surface.copy_within(h * stride + 1..h * stride + w + 1, destination);
                    }
                }
            }
            if next == 0 {
                continue;
            }
            let z = next - 1;
            let start = z * w;
            let base = (z + 1) * stride + 1;
            let center = &surface[base..base + w];
            let west = &surface[base - 1..base - 1 + w];
            let east = &surface[base + 1..base + 1 + w];
            let north = &surface[base - stride..base - stride + w];
            let south = &surface[base + stride..base + stride + w];
            let water = &result.water[start..start + w];
            let qw = &mut flux_west[base..base + w];
            let qe = &mut flux_east[base..base + w];
            let qn = &mut flux_north[base..base + w];
            let qs = &mut flux_south[base..base + w];
            if p.open_boundary {
                update_flux_row::<true>(
                    qw,
                    qe,
                    qn,
                    qs,
                    center,
                    west,
                    east,
                    north,
                    south,
                    water,
                    acceleration,
                    budget_scale,
                    z == 0,
                    z + 1 == h,
                );
            } else {
                update_flux_row::<false>(
                    qw,
                    qe,
                    qn,
                    qs,
                    center,
                    west,
                    east,
                    north,
                    south,
                    water,
                    acceleration,
                    budget_scale,
                    false,
                    false,
                );
            }
        }
        profile.mark("rain/surface/flux");
        max_depth = 0.0;
        max_velocity = 0.0;
        let mut max_height_change = 0.0f32;
        let flow_dt = dt * inv_cell;
        let velocity_limit = 0.45 * cell / dt;
        let erosion_dt = lower(p.erosion_rate * dt, 1.0);
        let deposition_dt = lower(p.deposition_rate * dt, 1.0);
        let evaporation_factor = upper(1.0 - p.evaporation * dt, 0.0);
        // A receiver lies at most one row ahead. Clear that row immediately
        // before the first possible scatter, keeping its writes in cache.
        remapped[..w].fill(0.0);
        for z in 0..h {
            if z + 1 < h {
                remapped[(z + 1) * w..(z + 2) * w].fill(0.0);
            }
            let start = z * w;
            let base = (z + 1) * stride + 1;
            let qw = &flux_west[base..base + w];
            let qe = &flux_east[base..base + w];
            let qn = &flux_north[base..base + w];
            let qs = &flux_south[base..base + w];
            let iw = &flux_east[base - 1..base - 1 + w];
            let ie = &flux_west[base + 1..base + 1 + w];
            let it = &flux_south[base - stride..base - stride + w];
            let ib = &flux_north[base + stride..base + stride + w];
            let capacity_slope = &slope_factor[start..start + w];
            let relief = &relief[start..start + w];
            let height = &mut result.height[start..start + w];
            let water = &mut result.water[start..start + w];
            let flow = &mut result.flow[start..start + w];
            let sediment = &mut result.sediment[start..start + w];
            let wear = &mut result.wear[start..start + w];
            let suspended = &mut suspended[start..start + w];
            let velocity = &mut velocity[..];
            let row_mobility = &mobility[start..start + w];
            let softness = &softness[start..start + w];
            update_water_row(
                qw,
                qe,
                qn,
                qs,
                iw,
                ie,
                it,
                ib,
                water,
                flow,
                velocity,
                &mut row_speed,
                &mut row_limited_speed,
                dt,
                flow_dt,
                velocity_limit,
            );
            profile.mark("water/velocity");
            if incision.is_empty() {
                erode_row::<false>(
                    height,
                    suspended,
                    &mut row_after,
                    &mut row_change,
                    water,
                    &row_speed,
                    capacity_slope,
                    relief,
                    row_mobility,
                    softness,
                    &[],
                    &[],
                    p,
                    dt,
                    erosion_dt,
                    deposition_dt,
                );
            } else {
                erode_row::<true>(
                    height,
                    suspended,
                    &mut row_after,
                    &mut row_change,
                    water,
                    &row_speed,
                    capacity_slope,
                    relief,
                    row_mobility,
                    softness,
                    &incision[start..start + w],
                    &slope_magnitude[start..start + w],
                    p,
                    dt,
                    erosion_dt,
                    deposition_dt,
                );
            }
            profile.mark("erosion/deposition");
            for x in 0..w {
                max_depth = upper(max_depth, water[x]);
                #[cfg(not(all(target_arch = "wasm32", feature = "simd")))]
                {
                    water[x] *= evaporation_factor;
                }
                max_velocity = upper(max_velocity, row_limited_speed[x]);
                if row_change[x] != 0.0 {
                    // Preserve the computed f32 height, rather than rebuilding
                    // it from its rounded difference. Only changed cells need
                    // material/layer stores or gradient invalidation.
                    height[x] = row_after[x];
                    let deposited = lower(upper(row_change[x], 0.0), suspended[x]);
                    let eroded = upper(-row_change[x], 0.0);
                    suspended[x] = suspended[x] - deposited + eroded;
                    sediment[x] += deposited;
                    wear[x] += eroded;
                    max_height_change = upper(max_height_change, row_change[x].abs());
                    let i = start + x;
                    for j in [
                        i,
                        if x > 0 { i - 1 } else { i },
                        if x + 1 < w { i + 1 } else { i },
                        if z > 0 { i - w } else { i },
                        if z + 1 < h { i + w } else { i },
                    ] {
                        if !gradient_marked[j] {
                            gradient_marked[j] = true;
                            gradient_dirty.push(j);
                        }
                    }
                }
            }
            #[cfg(all(target_arch = "wasm32", feature = "simd"))]
            // The optional SIMD build preserves the same lane multiplication.
            unsafe {
                evaporate_simd(water, evaporation_factor);
            }
            profile.mark("reductions/evaporation");
            let first = z.saturating_sub(1);
            let end = (z + 2).min(h);
            let destination = &mut remapped[first * w..end * w];
            let receiver_mobility = &mobility[first * w..end * w];
            if has_frozen {
                transport_row::<true>(
                    suspended,
                    velocity,
                    receiver_mobility,
                    destination,
                    z,
                    h,
                    flow_dt,
                );
            } else {
                transport_row::<false>(
                    suspended,
                    velocity,
                    receiver_mobility,
                    destination,
                    z,
                    h,
                    flow_dt,
                );
            }
            profile.mark("transport");
        }
        std::mem::swap(&mut suspended, &mut remapped);
        if thermal_margin >= 0.0 {
            // Neighbor differences can grow by at most twice the largest actual
            // height change. Outward rounding keeps this a conservative proof,
            // including changes smaller than the terrain's f32 precision.
            thermal_margin =
                (thermal_margin - 2.0 * f64::from(max_height_change.next_up())).next_down();
        }
        if p.thermal_rate > 0.0 && thermal_margin < 0.0 {
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
            // Thermal movement can alter every stencil; rebuild the cache
            // next step instead of depending on hydraulic invalidation alone.
            gradient_dirty.clear();
            gradient_dirty.extend(0..n);
            gradient_marked.fill(true);
        }
        profile.mark("thermal");
    }
    #[cfg(all(feature = "profile", not(target_arch = "wasm32")))]
    println!(
        "pipe gradient updates={gradient_updates}; subnormal samples at final step: flux={} water={} suspended={}",
        flux_west
            .iter()
            .chain(&flux_east)
            .chain(&flux_north)
            .chain(&flux_south)
            .filter(|v| v.is_subnormal())
            .count(),
        result.water.iter().filter(|v| v.is_subnormal()).count(),
        suspended.iter().filter(|v| v.is_subnormal()).count(),
    );
    // Expose deposited thickness rather than an invisible suspended load.
    for (i, load) in suspended.into_iter().enumerate() {
        if mobility[i] > 0.0 {
            result.height[i] += load;
            result.sediment[i] += load;
        }
    }
    let max_flow = result.flow.iter().copied().fold(0.0f32, upper);
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
    profile.mark("finalize");
    profile.finish();
    Ok(result)
}

#[inline(never)]
fn rain_surface_row<const RAIN: bool>(
    water: &mut [f32],
    height: &[f32],
    rain: &[f32],
    surface: &mut [f32],
    rainfall: f32,
    open: bool,
) {
    let w = water.len();
    assert!(w >= 2 && height.len() == w && surface.len() == w + 2 && (!RAIN || rain.len() == w));
    for x in 0..w {
        water[x] += if RAIN { rainfall * rain[x] } else { rainfall };
        surface[x + 1] = height[x] + water[x];
    }
    surface[0] = if open { height[0] } else { surface[1] };
    surface[w + 1] = if open { height[w - 1] } else { surface[w] };
}

// Separate row entry points give LLVM disjoint mutable slice parameters.
// Length checks occur once per row; the cell loops have no index checks.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn update_flux_row<const OPEN: bool>(
    qw: &mut [f32],
    qe: &mut [f32],
    qn: &mut [f32],
    qs: &mut [f32],
    center: &[f32],
    west: &[f32],
    east: &[f32],
    north: &[f32],
    south: &[f32],
    water: &[f32],
    acceleration: f32,
    budget_scale: f32,
    top: bool,
    bottom: bool,
) {
    let n = water.len();
    assert!(
        qw.len() == n
            && qe.len() == n
            && qn.len() == n
            && qs.len() == n
            && center.len() == n
            && west.len() == n
            && east.len() == n
            && north.len() == n
            && south.len() == n
    );
    for x in 0..n {
        let s = center[x];
        let dw = if OPEN && x == 0 {
            water[x]
        } else {
            s - west[x]
        };
        let de = if OPEN && x + 1 == n {
            water[x]
        } else {
            s - east[x]
        };
        let dn = if OPEN && top { water[x] } else { s - north[x] };
        let ds = if OPEN && bottom {
            water[x]
        } else {
            s - south[x]
        };
        let a = upper(qw[x] + acceleration * dw, 0.0);
        let b = upper(qe[x] + acceleration * de, 0.0);
        let c = upper(qn[x] + acceleration * dn, 0.0);
        let d = upper(qs[x] + acceleration * ds, 0.0);
        let scale = lower(water[x] * budget_scale / upper(a + b + c + d, 1e-30), 1.0);
        qw[x] = a * scale;
        qe[x] = b * scale;
        qn[x] = c * scale;
        qs[x] = d * scale;
    }
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn update_water_row(
    qw: &[f32],
    qe: &[f32],
    qn: &[f32],
    qs: &[f32],
    iw: &[f32],
    ie: &[f32],
    it: &[f32],
    ib: &[f32],
    water: &mut [f32],
    flow: &mut [f32],
    velocity: &mut [[f32; 2]],
    capacity_speed: &mut [f32],
    limited_speed: &mut [f32],
    dt: f32,
    flow_dt: f32,
    velocity_limit: f32,
) {
    let n = water.len();
    assert!(
        qw.len() == n
            && qe.len() == n
            && qn.len() == n
            && qs.len() == n
            && iw.len() == n
            && ie.len() == n
            && it.len() == n
            && ib.len() == n
            && flow.len() == n
            && velocity.len() == n
            && capacity_speed.len() == n
            && limited_speed.len() == n
    );
    for x in 0..n {
        let old = water[x];
        let depth = upper(
            old + flow_dt * (iw[x] + ie[x] + it[x] + ib[x] - qw[x] - qe[x] - qn[x] - qs[x]),
            0.0,
        );
        water[x] = depth;
        let inv_depth = 1.0 / upper(old + depth, 1e-12);
        let vx = (iw[x] - qw[x] + qe[x] - ie[x]) * inv_depth;
        let vz = (it[x] - qn[x] + qs[x] - ib[x]) * inv_depth;
        let raw_speed = (vx * vx + vz * vz).sqrt();
        let limited = raw_speed > velocity_limit;
        let scale = if limited {
            velocity_limit / raw_speed
        } else {
            1.0
        };
        let vx = vx * scale;
        let vz = vz * scale;
        velocity[x] = [vx, vz];
        let speed = lower(raw_speed, velocity_limit);
        limited_speed[x] = speed;
        flow[x] += speed * dt;
        capacity_speed[x] = if limited {
            (vx * vx + vz * vz).sqrt()
        } else {
            raw_speed
        };
    }
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn erode_row<const STREAM: bool>(
    height: &[f32],
    suspended: &[f32],
    after_height: &mut [f32],
    change: &mut [f32],
    water: &[f32],
    speed: &[f32],
    slope: &[f32],
    relief: &[f32],
    mobility: &[f32],
    softness: &[f32],
    incision: &[f32],
    slope_magnitude: &[f32],
    p: &PipeParams,
    dt: f32,
    erosion_dt: f32,
    deposition_dt: f32,
) {
    let n = height.len();
    assert!(
        suspended.len() == n
            && after_height.len() == n
            && change.len() == n
            && water.len() == n
            && speed.len() == n
            && slope.len() == n
            && relief.len() == n
            && mobility.len() == n
            && softness.len() == n
            && (!STREAM || (incision.len() == n && slope_magnitude.len() == n))
    );
    for x in 0..n {
        let before = height[x];
        let material = suspended[x];
        let cap = lower(p.sediment_capacity * speed[x] * slope[x] * water[x], 1e8);
        let delta = cap - material;
        let deposition = upper(-delta, 0.0) * deposition_dt * mobility[x];
        let hydraulic = upper(delta, 0.0) * erosion_dt;
        let stream = if STREAM && delta >= 0.0 && water[x] > 1e-12 {
            lower(
                incision[x] * power(slope_magnitude[x], p.stream_power_n) * dt,
                1e8,
            )
        } else {
            0.0
        };
        let erosion = lower(hydraulic + stream, relief[x] * 0.25) * softness[x];
        let after = before + (deposition - erosion);
        after_height[x] = after;
        change[x] = after - before;
    }
}

#[inline(never)]
fn transport_row<const FROZEN: bool>(
    suspended: &[f32],
    velocity: &[[f32; 2]],
    mobility: &[f32],
    remapped: &mut [f32],
    z: usize,
    h: usize,
    flow_dt: f32,
) {
    let w = suspended.len();
    let first = z.saturating_sub(1);
    let end = (z + 2).min(h);
    assert!(
        w >= 2
            && h >= 2
            && z < h
            && velocity.len() == w
            && remapped.len() == (end - first) * w
            && mobility.len() == remapped.len()
    );
    for x in 0..w {
        let material = suspended[x];
        if material == 0.0 {
            continue;
        }
        let (x0, fx) = transport_coordinate(x, w, velocity[x][0] * flow_dt);
        let (z0, fz) = transport_coordinate(z, h, velocity[x][1] * flow_dt);
        let i = (z0 - first) * w + x0;
        let w0 = (1.0 - fx) * (1.0 - fz);
        let w1 = fx * (1.0 - fz);
        let w2 = (1.0 - fx) * fz;
        let w3 = fx * fz;
        // Row bounds were checked once above. Integer transport_coordinate
        // returns x0 in 0..w-1 and z0 in first..end-1, independently of float
        // displacement (even NaN). Thus i, i+1, i+w, i+w+1 are all inside the
        // checked 2/3-row window. No unchecked access escapes this proof.
        unsafe {
            if !FROZEN && w3 > 0.0 {
                let sum = w0 + w1 + w2 + w3;
                let inv_sum = if sum == 1.0 { 1.0 } else { 1.0 / sum };
                let a = lower(material * w0 * inv_sum, material);
                let remaining = material - a;
                let b = lower(material * w1 * inv_sum, remaining);
                let remaining = remaining - b;
                let c = lower(material * w2 * inv_sum, remaining);
                *remapped.get_unchecked_mut(i) += a;
                *remapped.get_unchecked_mut(i + 1) += b;
                *remapped.get_unchecked_mut(i + w) += c;
                *remapped.get_unchecked_mut(i + w + 1) += remaining - c;
            } else {
                let indices = [i, i + 1, i + w, i + w + 1];
                let mut weights = [w0, w1, w2, w3];
                let mut sum = 0.0;
                for k in 0..4 {
                    if FROZEN && *mobility.get_unchecked(indices[k]) == 0.0 {
                        weights[k] = 0.0;
                    }
                    sum += weights[k];
                }
                if sum <= 0.0 {
                    *remapped.get_unchecked_mut((z - first) * w + x) += material;
                    continue;
                }
                let inv_sum = if sum == 1.0 { 1.0 } else { 1.0 / sum };
                let last = (0..4).rfind(|&k| weights[k] > 0.0).unwrap_or(0);
                let mut remaining = material;
                for k in 0..last {
                    let part = lower(material * weights[k] * inv_sum, remaining);
                    *remapped.get_unchecked_mut(indices[k]) += part;
                    remaining -= part;
                }
                *remapped.get_unchecked_mut(indices[last]) += remaining;
            }
        }
    }
}

#[inline(always)]
fn transport_coordinate(index: usize, length: usize, displacement: f32) -> (usize, f32) {
    if index == 0 {
        (0, upper(displacement, 0.0))
    } else if index + 1 == length {
        (length - 2, 1.0 + lower(displacement, 0.0))
    } else {
        let backward = usize::from(displacement < 0.0);
        (index - backward, displacement + backward as f32)
    }
}

// A nonnegative result proves every thermal stencil is inactive. Widening the
// f32 operands and outward rounding bounds both subtractions, even if their
// exponents differ greatly. Once this proof expires we use the ordinary
// thermal solver permanently, rather than guessing from the incoming DEM.
fn inactive_thermal_margin(height: &[f32], w: usize, h: usize, talus: f32) -> f64 {
    let diagonal = f64::from(talus * std::f32::consts::SQRT_2);
    let cardinal = f64::from(talus);
    let mut margin = f64::INFINITY;
    for z in 0..h {
        for x in 0..w {
            let i = z * w + x;
            let a = f64::from(height[i]);
            for (valid, j, threshold) in [
                (x + 1 < w, i + 1, cardinal),
                (z + 1 < h, i + w, cardinal),
                (x + 1 < w && z + 1 < h, i + w + 1, diagonal),
                (x > 0 && z + 1 < h, i + w - 1, diagonal),
            ] {
                if valid {
                    let difference = (a - f64::from(height[j])).abs().next_up();
                    margin = margin.min((threshold - difference).next_down());
                }
            }
        }
    }
    margin.next_down()
}

#[cfg(all(target_arch = "wasm32", feature = "simd"))]
#[target_feature(enable = "simd128")]
unsafe fn evaporate_simd(water: &mut [f32], factor: f32) {
    use std::arch::wasm32::{f32x4_mul, f32x4_splat, v128_load, v128_store};
    let factor4 = f32x4_splat(factor);
    let mut chunks = water.chunks_exact_mut(4);
    for chunk in &mut chunks {
        // Each chunk contains exactly four valid f32 lanes; unaligned v128
        // access is supported and the operation matches scalar multiplication.
        unsafe {
            let value = v128_load(chunk.as_ptr().cast());
            v128_store(chunk.as_mut_ptr().cast(), f32x4_mul(value, factor4));
        }
    }
    for value in chunks.into_remainder() {
        *value *= factor;
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
                let cardinal = lower(
                    lower(
                        lower(result.height[i - 1], result.height[i + 1]),
                        result.height[i - w],
                    ),
                    result.height[i + w],
                );
                let diagonal = lower(
                    lower(
                        lower(result.height[i - w - 1], result.height[i - w + 1]),
                        result.height[i + w - 1],
                    ),
                    result.height[i + w + 1],
                );
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
                        upper(result.height[i] - result.height[j] - threshold, 0.0) * mobility[j];
                    if amount == 0.0 {
                        continue;
                    }
                    targets[count] = j;
                    excess[count] = amount;
                    count += 1;
                    sum += amount;
                    maximum = upper(maximum, amount);
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
                    lower(amount * excess[k] / sum, remaining)
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
    fn inactive_thermal_proof_agrees_with_stencil_near_talus() {
        let w = 3;
        let h = 3;
        let n = w * h;
        let mobility = vec![1.0; n];
        let mut checked = 0;
        for talus in [f32::MIN_POSITIVE, 0.25, 1e6] {
            for peak in [talus.next_down(), talus, talus.next_up()] {
                let mut height = vec![0.0; n];
                height[4] = peak;
                let mut margin = inactive_thermal_margin(&height, w, h, talus);
                for step in 0..8 {
                    let mut reference = ErosionResult {
                        height: height.clone(),
                        sediment: vec![0.0; n],
                        debris: vec![0.0; n],
                        flow: vec![0.0; n],
                        water: vec![0.0; n],
                        wear: vec![0.0; n],
                    };
                    thermal_pass(
                        &mut reference,
                        &mut vec![0.0; n],
                        &mobility,
                        &mobility,
                        w,
                        h,
                        talus,
                        1.0,
                    );
                    if margin >= 0.0 {
                        checked += 1;
                        assert_eq!(reference.height, height);
                        assert!(reference.debris.iter().all(|v| *v == 0.0));
                        assert!(reference.wear.iter().all(|v| *v == 0.0));
                    }
                    let old = height[step % n];
                    height[step % n] = if step % 2 == 0 {
                        old.next_up()
                    } else {
                        old.next_down()
                    };
                    let change = (height[step % n] - old).abs().next_up();
                    margin = (margin - 2.0 * f64::from(change)).next_down();
                }
            }
        }
        assert!(checked > 0);
    }
    #[test]
    fn unmasked_transport_matches_masked_path_and_conserves_material() {
        let values = [-0.45, -f32::MIN_POSITIVE, 0.0, f32::MIN_POSITIVE, 0.45];
        for (w, h) in [(2usize, 2usize), (3, 7), (19, 2), (17, 13)] {
            for z in 0..h {
                let count = ((z + 2).min(h) - z.saturating_sub(1)) * w;
                let mobility = vec![1.0; count];
                let material: Vec<f32> = (0..w).map(|x| (x + 1) as f32 / 16.0).collect();
                for phase in 0..values.len() {
                    let velocity: Vec<[f32; 2]> = (0..w)
                        .map(|x| {
                            [
                                values[(x + phase) % values.len()],
                                values[(x * 3 + phase) % values.len()],
                            ]
                        })
                        .collect();
                    let mut fast = vec![0.0; count];
                    let mut reference = vec![0.0; count];
                    transport_row::<false>(&material, &velocity, &mobility, &mut fast, z, h, 1.0);
                    transport_row::<true>(
                        &material,
                        &velocity,
                        &mobility,
                        &mut reference,
                        z,
                        h,
                        1.0,
                    );
                    assert_eq!(fast, reference);
                    assert!((sum(&fast) - sum(&material)).abs() / sum(&material) < 1e-6);
                }
            }
        }
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
