//! Four-pipe shallow-water hydraulic erosion, with conservative characteristic
//! sediment remapping, optional stream power and a separate thermal pass.
//!
//! Based on Mei, Decaudin and Hu (Pacific Graphics 2007). Closed cells share
//! exactly the same face flux; outgoing flux is limited to available water.
//! Sediment uses conservative X-then-Z characteristic remapping with adjacent
//! gathers, preserving mass without a global rescaling of the sediment map.

use crate::erosion_flow::{FlowMethod, flow_accumulation, validate_grid};

#[cfg(all(target_arch = "wasm32", feature = "simd"))]
#[path = "erosion_simd.rs"]
mod simd;

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
    let mut transport_flux = vec![0.0f32; 3 * w];
    let mut horizontal_flux = vec![0.0f32; w];
    let mut horizontal_load = vec![0.0f32; w];
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
        for z in 0..h {
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
            let above = &mobility[z.saturating_sub(1) * w..z.saturating_sub(1) * w + w];
            let below = &mobility[(z + 1).min(h - 1) * w..(z + 1).min(h - 1) * w + w];
            let flux = &mut transport_flux[(z % 3) * w..(z % 3 + 1) * w];
            let output = &mut remapped[start..start + w];
            if has_frozen {
                transport_prepare_row::<true>(
                    suspended,
                    velocity,
                    row_mobility,
                    above,
                    below,
                    &mut horizontal_flux,
                    &mut horizontal_load,
                    flux,
                    output,
                    z,
                    h,
                    flow_dt,
                );
            } else {
                transport_prepare_row::<false>(
                    suspended,
                    velocity,
                    row_mobility,
                    above,
                    below,
                    &mut horizontal_flux,
                    &mut horizontal_load,
                    flux,
                    output,
                    z,
                    h,
                    flow_dt,
                );
            }
            // Once row z's outgoing transfers exist, both neighbors of z-1
            // are available. Three flux rows suffice, with no full-grid velocity.
            if z > 0 {
                let above = if z > 1 {
                    &transport_flux[((z - 2) % 3) * w..((z - 2) % 3 + 1) * w]
                } else {
                    &[]
                };
                let below = &transport_flux[(z % 3) * w..(z % 3 + 1) * w];
                transport_receive_row(&mut remapped[(z - 1) * w..z * w], above, below);
            }
            profile.mark("transport");
        }
        let above = &transport_flux[((h - 2) % 3) * w..((h - 2) % 3 + 1) * w];
        transport_receive_row(&mut remapped[(h - 1) * w..h * w], above, &[]);
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
    #[cfg(all(target_arch = "wasm32", feature = "simd"))]
    // Slice bounds are checked in the helper; selection requires simd128.
    let start = unsafe {
        simd::update_water_prefix(
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
            capacity_speed,
            limited_speed,
            dt,
            flow_dt,
            velocity_limit,
        )
    };
    #[cfg(not(all(target_arch = "wasm32", feature = "simd")))]
    let start = 0;
    for x in start..n {
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

// Conservative, dimension-split characteristic remapping. Each donor retains
// its load minus its outgoing transfer; each receiver gathers the two adjacent
// transfers. Unlike backward bilinear sampling, this conserves sediment in
// converging/diverging flow without a global mass correction. CFL bounds each
// displacement by 0.45 cells. Frozen receivers and outer edges reflect sediment.
// The fixed X then Z order introduces directional splitting on varying velocity.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn transport_prepare_row<const FROZEN: bool>(
    source: &[f32],
    velocity: &[[f32; 2]],
    mobility: &[f32],
    above_mobility: &[f32],
    below_mobility: &[f32],
    horizontal_flux: &mut [f32],
    horizontal_load: &mut [f32],
    vertical_flux: &mut [f32],
    output: &mut [f32],
    z: usize,
    h: usize,
    flow_dt: f32,
) {
    let w = source.len();
    assert!(
        w >= 2
            && h >= 2
            && z < h
            && velocity.len() == w
            && mobility.len() == w
            && above_mobility.len() == w
            && below_mobility.len() == w
            && horizontal_flux.len() == w
            && horizontal_load.len() == w
            && vertical_flux.len() == w
            && output.len() == w
    );
    for x in 0..w {
        let d = velocity[x][0] * flow_dt;
        let allowed = if d < 0.0 {
            x > 0 && (!FROZEN || mobility[x - 1] > 0.0)
        } else {
            x + 1 < w && (!FROZEN || mobility[x + 1] > 0.0)
        };
        let transfer = if allowed { source[x] * d.abs() } else { 0.0 };
        horizontal_flux[x] = transfer.copysign(d);
        horizontal_load[x] = source[x] - transfer;
    }
    // Separate interior from borders so the stencil has no lane-dependent bounds.
    horizontal_load[0] += upper(-horizontal_flux[1], 0.0);
    for x in 1..w - 1 {
        horizontal_load[x] = horizontal_load[x]
            + upper(horizontal_flux[x - 1], 0.0)
            + upper(-horizontal_flux[x + 1], 0.0);
    }
    horizontal_load[w - 1] += upper(horizontal_flux[w - 2], 0.0);
    for x in 0..w {
        let d = velocity[x][1] * flow_dt;
        let allowed = if d < 0.0 {
            z > 0 && (!FROZEN || above_mobility[x] > 0.0)
        } else {
            z + 1 < h && (!FROZEN || below_mobility[x] > 0.0)
        };
        let transfer = if allowed {
            horizontal_load[x] * d.abs()
        } else {
            0.0
        };
        vertical_flux[x] = transfer.copysign(d);
        output[x] = horizontal_load[x] - transfer;
    }
}

#[inline(never)]
fn transport_receive_row(output: &mut [f32], above: &[f32], below: &[f32]) {
    let w = output.len();
    assert!((above.is_empty() || above.len() == w) && (below.is_empty() || below.len() == w));
    for x in 0..w {
        let a = if above.is_empty() {
            0.0
        } else {
            upper(above[x], 0.0)
        };
        let b = if below.is_empty() {
            0.0
        } else {
            upper(-below[x], 0.0)
        };
        output[x] = output[x] + a + b;
    }
}

// Test adapter for the same streamed row functions used by erode_pipe. The
// independent test oracle scatters in f64 and does not share this implementation.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn transport_gather<const FROZEN: bool>(
    material: &mut [f32],
    scratch: &mut [f32],
    velocity: &[[f32; 2]],
    mobility: &[f32],
    w: usize,
    h: usize,
    flow_dt: f32,
) {
    let n = w * h;
    assert!(
        material.len() == n && scratch.len() == n && velocity.len() == n && mobility.len() == n
    );
    let mut horizontal_flux = vec![0.0; w];
    let mut horizontal_load = vec![0.0; w];
    let mut flux = vec![0.0; w * 3];
    for z in 0..h {
        let start = z * w;
        let above = &mobility[z.saturating_sub(1) * w..z.saturating_sub(1) * w + w];
        let below = &mobility[(z + 1).min(h - 1) * w..(z + 1).min(h - 1) * w + w];
        transport_prepare_row::<FROZEN>(
            &material[start..start + w],
            &velocity[start..start + w],
            &mobility[start..start + w],
            above,
            below,
            &mut horizontal_flux,
            &mut horizontal_load,
            &mut flux[(z % 3) * w..(z % 3 + 1) * w],
            &mut scratch[start..start + w],
            z,
            h,
            flow_dt,
        );
        if z > 0 {
            let above = if z > 1 {
                &flux[((z - 2) % 3) * w..((z - 2) % 3 + 1) * w]
            } else {
                &[]
            };
            let below = &flux[(z % 3) * w..(z % 3 + 1) * w];
            transport_receive_row(&mut scratch[(z - 1) * w..z * w], above, below);
        }
    }
    let above = &flux[((h - 2) % 3) * w..((h - 2) % 3 + 1) * w];
    transport_receive_row(&mut scratch[(h - 1) * w..h * w], above, &[]);
    material.copy_from_slice(scratch);
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
    fn gather_constant_velocity_impulse_has_bilinear_weights() {
        let w = 7;
        let h = 7;
        let center = 3 * w + 3;
        for dx in [-0.375f32, 0.0, 0.375] {
            for dz in [-0.25f32, 0.0, 0.25] {
                let mut material = vec![0.0; w * h];
                material[center] = 8.0;
                let velocity = vec![[dx * 2.0, dz * 2.0]; w * h];
                transport_gather::<false>(
                    &mut material,
                    &mut vec![f32::NAN; w * h],
                    &velocity,
                    &vec![1.0; w * h],
                    w,
                    h,
                    0.5,
                );
                let mut expected = vec![0.0; w * h];
                let nx = if dx < 0.0 { 2 } else { 4 };
                let nz = if dz < 0.0 { 2 } else { 4 };
                // Exact binary fractions: no tolerance can hide a wrong receiver or weight.
                expected[center] = 8.0 * (1.0 - dx.abs()) * (1.0 - dz.abs());
                expected[3 * w + nx] = 8.0 * dx.abs() * (1.0 - dz.abs());
                expected[nz * w + 3] = 8.0 * (1.0 - dx.abs()) * dz.abs();
                expected[nz * w + nx] = 8.0 * dx.abs() * dz.abs();
                assert_eq!(material, expected, "displacement ({dx}, {dz})");
                assert_eq!(sum(&material), 8.0);
            }
        }
    }

    #[test]
    fn gather_varying_velocity_matches_independent_forward_remap() {
        // The oracle deposits donors into a new f64 buffer for each axis, independently
        // of the production flux/gather implementation and its row-based addressing.
        let values = [
            -0.45,
            -f32::MIN_POSITIVE,
            -0.0,
            0.0,
            f32::MIN_POSITIVE,
            0.25,
            0.45,
        ];
        for (w, h) in [(2usize, 2usize), (2, 19), (19, 2), (3, 7), (8, 9), (17, 13)] {
            let n = w * h;
            for masked in [false, true] {
                let mobility: Vec<f32> = (0..n)
                    .map(|i| if masked && i % 7 == 0 { 0.0 } else { 1.0 })
                    .collect();
                let initial: Vec<f32> = (0..n)
                    .map(|i| ((i * 17 % 29) + 1) as f32 / 32.0 * mobility[i])
                    .collect();
                let velocity: Vec<[f32; 2]> = (0..n)
                    .map(|i| [values[i % values.len()], values[(i * 3 + 2) % values.len()]])
                    .collect();
                let mut expected: Vec<f64> = initial.iter().map(|&v| f64::from(v)).collect();
                for (axis, length, stride) in [(0, w, 1), (1, h, w)] {
                    let mut next = vec![0.0; n];
                    for i in 0..n {
                        let coordinate = if axis == 0 { i % w } else { i / w };
                        let displacement = velocity[i][axis] * 0.75;
                        let target = if displacement < 0.0 && coordinate > 0 {
                            Some(i - stride)
                        } else if displacement > 0.0 && coordinate + 1 < length {
                            Some(i + stride)
                        } else {
                            None
                        };
                        let target = target.filter(|&j| mobility[j] > 0.0);
                        if let Some(j) = target {
                            let amount = expected[i] * f64::from(displacement.abs());
                            next[i] += expected[i] - amount;
                            next[j] += amount;
                        } else {
                            next[i] += expected[i];
                        }
                    }
                    expected = next;
                }
                let mut material = initial.clone();
                let mut scratch = vec![f32::NAN; n];

                if masked {
                    transport_gather::<true>(
                        &mut material,
                        &mut scratch,
                        &velocity,
                        &mobility,
                        w,
                        h,
                        0.75,
                    );
                } else {
                    transport_gather::<false>(
                        &mut material,
                        &mut scratch,
                        &velocity,
                        &mobility,
                        w,
                        h,
                        0.75,
                    );
                    let mut frozen_path = initial;
                    transport_gather::<true>(
                        &mut frozen_path,
                        &mut scratch,
                        &velocity,
                        &mobility,
                        w,
                        h,
                        0.75,
                    );
                    assert_eq!(
                        material, frozen_path,
                        "unit mobility must not change remapping"
                    );
                }
                for (i, (&actual, &want)) in material.iter().zip(&expected).enumerate() {
                    assert!(actual.is_finite() && actual >= 0.0);
                    assert!(
                        (f64::from(actual) - want).abs() <= 2e-7 * want.max(1.0),
                        "{w}x{h} masked={masked} sample {i}: {actual} != {want}"
                    );
                    if mobility[i] == 0.0 {
                        assert_eq!(actual, 0.0, "frozen receiver {i}");
                    }
                }
            }
        }
    }

    #[test]
    fn gather_conserves_nonnegative_material_and_replays_over_hundreds_of_steps() {
        for (w, h) in [(2usize, 2usize), (2, 19), (19, 2), (3, 7), (8, 9), (17, 13)] {
            let n = w * h;
            let initial: Vec<f32> = (0..n).map(|i| (i * 977 % 47 + 1) as f32 / 64.0).collect();
            let total = sum(&initial);
            let run = || {
                let mut material = initial.clone();
                let mut scratch = vec![f32::NAN; n];

                let mobility = vec![1.0; n];
                let mut velocity = vec![[0.0; 2]; n];
                for step in 0..400 {
                    for (i, value) in velocity.iter_mut().enumerate() {
                        *value = [
                            ((i * 17 + step * 13) % 91) as f32 / 100.0 - 0.45,
                            ((i * 31 + step * 7) % 91) as f32 / 100.0 - 0.45,
                        ];
                    }
                    transport_gather::<false>(
                        &mut material,
                        &mut scratch,
                        &velocity,
                        &mobility,
                        w,
                        h,
                        1.0,
                    );
                    assert!(material.iter().all(|v| v.is_finite() && *v >= 0.0));
                    assert!(
                        (sum(&material) - total).abs() <= total * 2e-5,
                        "{w}x{h}: step {step} changed total material"
                    );
                }
                material.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
            };
            assert_eq!(run(), run(), "{w}x{h}: bit-exact replay");
        }
    }

    #[test]
    fn gather_frozen_wall_and_interior_receivers_do_not_leak() {
        let w = 9;
        let h = 7;
        let n = w * h;
        let wall = 4;
        let mut mobility = vec![1.0; n];
        for z in 0..h {
            mobility[z * w + wall] = 0.0;
        }
        let isolated = 3 * w + 2;
        mobility[isolated] = 0.0;
        let mut material: Vec<f32> = (0..n)
            .map(|i| if i % w < wall { mobility[i] / 4.0 } else { 0.0 })
            .collect();
        let total = sum(&material);
        let mut scratch = vec![f32::NAN; n];

        for step in 0..400 {
            let velocity: Vec<[f32; 2]> = (0..n)
                .map(|i| {
                    [
                        0.45,
                        if (i / w + step) % 2 == 0 {
                            0.375
                        } else {
                            -0.375
                        },
                    ]
                })
                .collect();
            transport_gather::<true>(&mut material, &mut scratch, &velocity, &mobility, w, h, 1.0);
            assert!(material.iter().all(|v| v.is_finite() && *v >= 0.0));
            assert!((sum(&material) - total).abs() <= total * 2e-5);
            assert_eq!(material[isolated], 0.0);
            for (i, &value) in material.iter().enumerate() {
                if i % w >= wall {
                    assert_eq!(
                        value, 0.0,
                        "step {step}: material crossed frozen wall at {i}"
                    );
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
