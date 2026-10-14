//! Strict native SSE2 flux and water updates, matching the simd128 operation order.
//!
//! Unconstrained flux groups skip the budget division. A group with no limited
//! velocities skips the limiter's division and second square root. Every operation
//! is a separate intrinsic; no FMA or reassociation.

use std::arch::x86_64::{
    __m128, _mm_add_ps, _mm_and_ps, _mm_andnot_ps, _mm_castsi128_ps, _mm_cmpgt_ps, _mm_cmplt_ps,
    _mm_div_ps, _mm_loadu_ps, _mm_max_ps, _mm_min_ps, _mm_movemask_ps, _mm_mul_ps, _mm_or_ps,
    _mm_set_epi32, _mm_set1_ps, _mm_sqrt_ps, _mm_storeu_ps, _mm_sub_ps, _mm_unpackhi_ps,
    _mm_unpacklo_ps,
};

#[inline]
fn select(mask: __m128, on_true: __m128, on_false: __m128) -> __m128 {
    // SAFETY: this module is only compiled for x86_64, where SSE2 is mandatory.
    unsafe { _mm_or_ps(_mm_and_ps(mask, on_true), _mm_andnot_ps(mask, on_false)) }
}

/// Update the largest four-cell flux prefix, retaining scalar arithmetic order.
/// The caller processes the remaining tail using the original full row width.
///
/// # Safety
/// SSE2 must be available (guaranteed on x86_64). All slice lengths are checked
/// before unaligned loads/stores; Rust's mutable borrows exclude aliasing.
#[target_feature(enable = "sse2")]
#[allow(clippy::too_many_arguments)]
pub(super) unsafe fn update_flux_prefix<const OPEN: bool>(
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
) -> usize {
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
    let end = n - n % 4;
    let zero = _mm_set1_ps(0.0);
    let one = _mm_set1_ps(1.0);
    let minimum_flux = _mm_set1_ps(1e-30);
    let acceleration4 = _mm_set1_ps(acceleration);
    let budget_scale4 = _mm_set1_ps(budget_scale);
    let first_lane = _mm_castsi128_ps(_mm_set_epi32(0, 0, 0, -1));
    let last_lane = _mm_castsi128_ps(_mm_set_epi32(-1, 0, 0, 0));
    for x in (0..end).step_by(4) {
        // SAFETY: x + 4 <= end <= n, and every input/output slice has n cells.
        unsafe {
            let s = _mm_loadu_ps(center.as_ptr().add(x));
            let water4 = _mm_loadu_ps(water.as_ptr().add(x));
            let mut dw = _mm_sub_ps(s, _mm_loadu_ps(west.as_ptr().add(x)));
            let mut de = _mm_sub_ps(s, _mm_loadu_ps(east.as_ptr().add(x)));
            if OPEN && x == 0 {
                dw = select(first_lane, water4, dw);
            }
            if OPEN && x + 4 == n {
                de = select(last_lane, water4, de);
            }
            let dn = if OPEN && top {
                water4
            } else {
                _mm_sub_ps(s, _mm_loadu_ps(north.as_ptr().add(x)))
            };
            let ds = if OPEN && bottom {
                water4
            } else {
                _mm_sub_ps(s, _mm_loadu_ps(south.as_ptr().add(x)))
            };
            let a = _mm_add_ps(
                _mm_loadu_ps(qw.as_ptr().add(x)),
                _mm_mul_ps(acceleration4, dw),
            );
            let b = _mm_add_ps(
                _mm_loadu_ps(qe.as_ptr().add(x)),
                _mm_mul_ps(acceleration4, de),
            );
            let c = _mm_add_ps(
                _mm_loadu_ps(qn.as_ptr().add(x)),
                _mm_mul_ps(acceleration4, dn),
            );
            let d = _mm_add_ps(
                _mm_loadu_ps(qs.as_ptr().add(x)),
                _mm_mul_ps(acceleration4, ds),
            );
            // SSE max/min return their second operand on ties or unordered
            // comparisons, matching upper/lower, including signed zeros.
            let a = _mm_max_ps(a, zero);
            let b = _mm_max_ps(b, zero);
            let c = _mm_max_ps(c, zero);
            let d = _mm_max_ps(d, zero);
            let total = _mm_add_ps(_mm_add_ps(_mm_add_ps(a, b), c), d);
            let denominator = _mm_max_ps(total, minimum_flux);
            let budget = _mm_mul_ps(water4, budget_scale4);
            // For nonnegative budgets and positive denominators, budget >=
            // denominator guarantees the original ratio clamps to exactly 1.
            let scale = if _mm_movemask_ps(_mm_cmplt_ps(budget, denominator)) != 0 {
                let ratio = _mm_div_ps(budget, denominator);
                _mm_min_ps(ratio, one)
            } else {
                one
            };
            _mm_storeu_ps(qw.as_mut_ptr().add(x), _mm_mul_ps(a, scale));
            _mm_storeu_ps(qe.as_mut_ptr().add(x), _mm_mul_ps(b, scale));
            _mm_storeu_ps(qn.as_mut_ptr().add(x), _mm_mul_ps(c, scale));
            _mm_storeu_ps(qs.as_mut_ptr().add(x), _mm_mul_ps(d, scale));
        }
    }
    end
}

/// Update the largest four-cell prefix; the caller handles `returned..water.len()`
/// with the scalar operation sequence.
///
/// # Safety
/// SSE2 must be available (guaranteed on x86_64). Slice lengths are checked here
/// before any load/store, and Rust's mutable borrows exclude aliasing. All memory
/// operations accept unaligned pointers; no additional alignment is required.
#[target_feature(enable = "sse2")]
#[allow(clippy::too_many_arguments)]
pub(super) unsafe fn update_water_prefix(
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
) -> usize {
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
    let end = n - n % 4;
    let zero = _mm_set1_ps(0.0);
    let one = _mm_set1_ps(1.0);
    let minimum_depth = _mm_set1_ps(1e-12);
    let flow_dt4 = _mm_set1_ps(flow_dt);
    let dt4 = _mm_set1_ps(dt);
    let limit4 = _mm_set1_ps(velocity_limit);
    for x in (0..end).step_by(4) {
        // SAFETY: x + 4 <= end <= n and every slice has n cells. A velocity cell
        // is exactly two contiguous f32 values, so the stores cover four cells.
        unsafe {
            let qw4 = _mm_loadu_ps(qw.as_ptr().add(x));
            let qe4 = _mm_loadu_ps(qe.as_ptr().add(x));
            let qn4 = _mm_loadu_ps(qn.as_ptr().add(x));
            let qs4 = _mm_loadu_ps(qs.as_ptr().add(x));
            let iw4 = _mm_loadu_ps(iw.as_ptr().add(x));
            let ie4 = _mm_loadu_ps(ie.as_ptr().add(x));
            let it4 = _mm_loadu_ps(it.as_ptr().add(x));
            let ib4 = _mm_loadu_ps(ib.as_ptr().add(x));
            let old = _mm_loadu_ps(water.as_ptr().add(x));
            // Match the scalar left-associative sum exactly; do not reassociate.
            let net = _mm_sub_ps(
                _mm_sub_ps(
                    _mm_sub_ps(
                        _mm_sub_ps(_mm_add_ps(_mm_add_ps(_mm_add_ps(iw4, ie4), it4), ib4), qw4),
                        qe4,
                    ),
                    qn4,
                ),
                qs4,
            );
            let depth = _mm_add_ps(old, _mm_mul_ps(flow_dt4, net));
            // Native SSE max/min select their second operand on ties or NaNs;
            // this matches upper/lower and differs from WASM's min/max rules.
            let depth = _mm_max_ps(depth, zero);
            _mm_storeu_ps(water.as_mut_ptr().add(x), depth);
            let sum_depth = _mm_add_ps(old, depth);
            let denominator = _mm_max_ps(sum_depth, minimum_depth);
            let inv_depth = _mm_div_ps(one, denominator);
            let mut vx = _mm_mul_ps(
                _mm_sub_ps(_mm_add_ps(_mm_sub_ps(iw4, qw4), qe4), ie4),
                inv_depth,
            );
            let mut vz = _mm_mul_ps(
                _mm_sub_ps(_mm_add_ps(_mm_sub_ps(it4, qn4), qs4), ib4),
                inv_depth,
            );
            let raw_speed = _mm_sqrt_ps(_mm_add_ps(_mm_mul_ps(vx, vx), _mm_mul_ps(vz, vz)));
            let limited = _mm_cmpgt_ps(raw_speed, limit4);
            let capacity = if _mm_movemask_ps(limited) != 0 {
                let scale = select(limited, _mm_div_ps(limit4, raw_speed), one);
                vx = _mm_mul_ps(vx, scale);
                vz = _mm_mul_ps(vz, scale);
                let scaled_speed = _mm_sqrt_ps(_mm_add_ps(_mm_mul_ps(vx, vx), _mm_mul_ps(vz, vz)));
                select(limited, scaled_speed, raw_speed)
            } else {
                // Multiplication by exactly 1 preserves finite velocities,
                // including either signed zero, so it can be omitted here.
                raw_speed
            };
            let speed = _mm_min_ps(raw_speed, limit4);
            let flow4 = _mm_add_ps(_mm_loadu_ps(flow.as_ptr().add(x)), _mm_mul_ps(speed, dt4));
            _mm_storeu_ps(flow.as_mut_ptr().add(x), flow4);
            _mm_storeu_ps(limited_speed.as_mut_ptr().add(x), speed);
            _mm_storeu_ps(capacity_speed.as_mut_ptr().add(x), capacity);
            _mm_storeu_ps(velocity.as_mut_ptr().add(x).cast(), _mm_unpacklo_ps(vx, vz));
            _mm_storeu_ps(
                velocity.as_mut_ptr().add(x + 2).cast(),
                _mm_unpackhi_ps(vx, vz),
            );
        }
    }
    end
}

/// Fused plain-pipe water, erosion/deposition, layer commits, evaporation and X donors.
///
/// # Safety
/// SSE2 must be available (guaranteed on x86_64). Slice lengths are checked
/// before all unaligned memory accesses; mutable borrows exclude aliasing.
/// The caller must select this function only for unmasked, no-stream erosion.
#[target_feature(enable = "sse2")]
#[allow(clippy::too_many_arguments)]
pub(super) unsafe fn update_plain_prefix(
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
    height: &mut [f32],
    suspended: &mut [f32],
    sediment: &mut [f32],
    wear: &mut [f32],
    slope: &[f32],
    relief: &[f32],
    change: &mut [f32],
    horizontal_flux: &mut [f32],
    x_offset: usize,
    width: usize,
    dt: f32,
    flow_dt: f32,
    velocity_limit: f32,
    erosion_dt: f32,
    deposition_dt: f32,
    evaporation_factor: f32,
    sediment_capacity: f32,
) -> (usize, f32, f32) {
    use std::arch::x86_64::{_mm_cmpneq_ps, _mm_xor_ps};
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
            && height.len() == n
            && suspended.len() == n
            && sediment.len() == n
            && wear.len() == n
            && slope.len() == n
            && relief.len() == n
            && change.len() == n
            && horizontal_flux.len() == n
            && width >= 2
            && x_offset <= width
            && n <= width - x_offset
    );
    let end = n - n % 4;
    let zero = _mm_set1_ps(0.0);
    let one = _mm_set1_ps(1.0);
    let sign = _mm_set1_ps(-0.0);
    let minimum_depth = _mm_set1_ps(1e-12);
    let flow_dt4 = _mm_set1_ps(flow_dt);
    let dt4 = _mm_set1_ps(dt);
    let limit4 = _mm_set1_ps(velocity_limit);
    let erosion_dt4 = _mm_set1_ps(erosion_dt);
    let deposition_dt4 = _mm_set1_ps(deposition_dt);
    let evaporation4 = _mm_set1_ps(evaporation_factor);
    let capacity4 = _mm_set1_ps(sediment_capacity);
    let maximum_capacity = _mm_set1_ps(1e8);
    let quarter = _mm_set1_ps(0.25);
    let first_lane = _mm_castsi128_ps(_mm_set_epi32(0, 0, 0, -1));
    let last_lane = _mm_castsi128_ps(_mm_set_epi32(-1, 0, 0, 0));
    let mut max_depth4 = zero;
    let mut max_speed4 = zero;
    for x in (0..end).step_by(4) {
        // SAFETY: x + 4 <= end <= n; every slice has n cells. A velocity cell
        // is two contiguous f32 values, so the two vector stores cover four cells.
        unsafe {
            let qw4 = _mm_loadu_ps(qw.as_ptr().add(x));
            let qe4 = _mm_loadu_ps(qe.as_ptr().add(x));
            let qn4 = _mm_loadu_ps(qn.as_ptr().add(x));
            let qs4 = _mm_loadu_ps(qs.as_ptr().add(x));
            let iw4 = _mm_loadu_ps(iw.as_ptr().add(x));
            let ie4 = _mm_loadu_ps(ie.as_ptr().add(x));
            let it4 = _mm_loadu_ps(it.as_ptr().add(x));
            let ib4 = _mm_loadu_ps(ib.as_ptr().add(x));
            let old = _mm_loadu_ps(water.as_ptr().add(x));
            let net = _mm_sub_ps(
                _mm_sub_ps(
                    _mm_sub_ps(
                        _mm_sub_ps(_mm_add_ps(_mm_add_ps(_mm_add_ps(iw4, ie4), it4), ib4), qw4),
                        qe4,
                    ),
                    qn4,
                ),
                qs4,
            );
            let depth = _mm_max_ps(_mm_add_ps(old, _mm_mul_ps(flow_dt4, net)), zero);
            let inv_depth = _mm_div_ps(one, _mm_max_ps(_mm_add_ps(old, depth), minimum_depth));
            let mut vx = _mm_mul_ps(
                _mm_sub_ps(_mm_add_ps(_mm_sub_ps(iw4, qw4), qe4), ie4),
                inv_depth,
            );
            let mut vz = _mm_mul_ps(
                _mm_sub_ps(_mm_add_ps(_mm_sub_ps(it4, qn4), qs4), ib4),
                inv_depth,
            );
            let raw_speed = _mm_sqrt_ps(_mm_add_ps(_mm_mul_ps(vx, vx), _mm_mul_ps(vz, vz)));
            let limited = _mm_cmpgt_ps(raw_speed, limit4);
            let capacity_speed = if _mm_movemask_ps(limited) != 0 {
                let scale = select(limited, _mm_div_ps(limit4, raw_speed), one);
                vx = _mm_mul_ps(vx, scale);
                vz = _mm_mul_ps(vz, scale);
                let scaled_speed = _mm_sqrt_ps(_mm_add_ps(_mm_mul_ps(vx, vx), _mm_mul_ps(vz, vz)));
                select(limited, scaled_speed, raw_speed)
            } else {
                raw_speed
            };
            let speed = _mm_min_ps(raw_speed, limit4);
            max_depth4 = _mm_max_ps(max_depth4, depth);
            max_speed4 = _mm_max_ps(max_speed4, speed);
            _mm_storeu_ps(
                flow.as_mut_ptr().add(x),
                _mm_add_ps(_mm_loadu_ps(flow.as_ptr().add(x)), _mm_mul_ps(speed, dt4)),
            );
            _mm_storeu_ps(velocity.as_mut_ptr().add(x).cast(), _mm_unpacklo_ps(vx, vz));
            _mm_storeu_ps(
                velocity.as_mut_ptr().add(x + 2).cast(),
                _mm_unpackhi_ps(vx, vz),
            );
            let displacement_x = _mm_mul_ps(vx, flow_dt4);

            // erode_row::<false, false>: preserve all left-associative products
            // and the hydraulic + 0 stream term, even when their result is zero.
            let before = _mm_loadu_ps(height.as_ptr().add(x));
            let material = _mm_loadu_ps(suspended.as_ptr().add(x));
            let capacity = _mm_min_ps(
                _mm_mul_ps(
                    _mm_mul_ps(
                        _mm_mul_ps(capacity4, capacity_speed),
                        _mm_loadu_ps(slope.as_ptr().add(x)),
                    ),
                    depth,
                ),
                maximum_capacity,
            );
            let delta = _mm_sub_ps(capacity, material);
            let deposition = _mm_mul_ps(_mm_max_ps(_mm_xor_ps(delta, sign), zero), deposition_dt4);
            let hydraulic = _mm_mul_ps(_mm_max_ps(delta, zero), erosion_dt4);
            let erosion = _mm_min_ps(
                _mm_add_ps(hydraulic, zero),
                _mm_mul_ps(_mm_loadu_ps(relief.as_ptr().add(x)), quarter),
            );
            let after = _mm_add_ps(before, _mm_sub_ps(deposition, erosion));
            let difference = _mm_sub_ps(after, before);
            _mm_storeu_ps(change.as_mut_ptr().add(x), difference);
            let changed = _mm_cmpneq_ps(difference, zero);
            let mut transported_material = material;
            if _mm_movemask_ps(changed) != 0 {
                // The scalar sparse loop skips every operation on unchanged
                // cells. Select the original bits in those lanes, including -0.
                let deposited = _mm_min_ps(_mm_max_ps(difference, zero), material);
                let eroded = _mm_max_ps(_mm_xor_ps(difference, sign), zero);
                let old_sediment = _mm_loadu_ps(sediment.as_ptr().add(x));
                let old_wear = _mm_loadu_ps(wear.as_ptr().add(x));
                _mm_storeu_ps(height.as_mut_ptr().add(x), select(changed, after, before));
                transported_material = select(
                    changed,
                    _mm_add_ps(_mm_sub_ps(material, deposited), eroded),
                    material,
                );
                _mm_storeu_ps(suspended.as_mut_ptr().add(x), transported_material);
                _mm_storeu_ps(
                    sediment.as_mut_ptr().add(x),
                    select(changed, _mm_add_ps(old_sediment, deposited), old_sediment),
                );
                _mm_storeu_ps(
                    wear.as_mut_ptr().add(x),
                    select(changed, _mm_add_ps(old_wear, eroded), old_wear),
                );
            }
            // Prepare the original unmasked X-donor expression while both
            // updated suspension and velocity are already in registers. The
            // offsets are global row coordinates, never block-local borders.
            let mut transfer =
                _mm_mul_ps(transported_material, _mm_andnot_ps(sign, displacement_x));
            if x_offset + x == 0 {
                let blocked = _mm_and_ps(first_lane, _mm_cmplt_ps(displacement_x, zero));
                transfer = _mm_andnot_ps(blocked, transfer);
            }
            if x_offset + x + 4 == width {
                // The original d < 0 branch treats both zero signs as the
                // nonnegative direction, so the last lane blocks -0 as well.
                let blocked = _mm_andnot_ps(_mm_cmplt_ps(displacement_x, zero), last_lane);
                transfer = _mm_andnot_ps(blocked, transfer);
            }
            let signed_transfer = _mm_or_ps(
                _mm_andnot_ps(sign, transfer),
                _mm_and_ps(sign, displacement_x),
            );
            _mm_storeu_ps(horizontal_flux.as_mut_ptr().add(x), signed_transfer);
            // Erosion used the depth before evaporation. The CFL maxima above
            // likewise use that depth, matching reduce_evaporate's contract.
            _mm_storeu_ps(water.as_mut_ptr().add(x), _mm_mul_ps(depth, evaporation4));
        }
    }
    let mut depth_lanes = [0.0f32; 4];
    let mut speed_lanes = [0.0f32; 4];
    // SAFETY: each stack array contains four f32 values and unaligned stores are allowed.
    unsafe {
        _mm_storeu_ps(depth_lanes.as_mut_ptr(), max_depth4);
        _mm_storeu_ps(speed_lanes.as_mut_ptr(), max_speed4);
    }
    // Finite nonnegative depth/speed make lane-wise maxima order independent.
    let max_depth = depth_lanes.into_iter().fold(0.0, crate::erosion::upper);
    let max_speed = speed_lanes.into_iter().fold(0.0, crate::erosion::upper);
    (end, max_depth, max_speed)
}

#[cfg(test)]
mod tests {
    use super::{update_flux_prefix, update_water_prefix};
    use crate::erosion::{lower, upper};

    fn bits(values: &[f32]) -> Vec<u32> {
        values.iter().map(|value| value.to_bits()).collect()
    }

    fn check_flux_prefix<const OPEN: bool>() {
        for n in 0..20 {
            for offset in 0..2 {
                let count = n + offset;
                let surfaces: [Vec<f32>; 5] = std::array::from_fn(|direction| {
                    (0..count)
                        .map(|i| ((i * 23 + direction * 17) % 67) as f32 / 32.0)
                        .collect()
                });
                let original: [Vec<f32>; 4] = std::array::from_fn(|direction| {
                    (0..count)
                        .map(|i| match i % 5 {
                            0 => -0.0,
                            1 => 0.0,
                            2 => f32::from_bits(1),
                            _ => ((i * 11 + direction * 7) % 23) as f32 / 32.0,
                        })
                        .collect()
                });
                for mixed in [false, true] {
                    let water: Vec<f32> = (0..count)
                        .map(|i| {
                            if mixed {
                                match i % 5 {
                                    0 => 0.0,
                                    1 => -0.0,
                                    2 => 1e-31,
                                    _ => (i % 11) as f32 / 32.0,
                                }
                            } else {
                                4.0
                            }
                        })
                        .collect();
                    for top in [false, true] {
                        for bottom in [false, true] {
                            for acceleration in [0.0, 0.125] {
                                for budget_scale in [0.0, 0.125, 1e20] {
                                    let mut actual = original.clone();
                                    let mut expected = original.clone();
                                    let end = n - n % 4;
                                    for x in 0..end {
                                        let i = x + offset;
                                        let s = surfaces[0][i];
                                        let dw = if OPEN && x == 0 {
                                            water[i]
                                        } else {
                                            s - surfaces[1][i]
                                        };
                                        let de = if OPEN && x + 1 == n {
                                            water[i]
                                        } else {
                                            s - surfaces[2][i]
                                        };
                                        let dn = if OPEN && top {
                                            water[i]
                                        } else {
                                            s - surfaces[3][i]
                                        };
                                        let ds = if OPEN && bottom {
                                            water[i]
                                        } else {
                                            s - surfaces[4][i]
                                        };
                                        let a = upper(expected[0][i] + acceleration * dw, 0.0);
                                        let b = upper(expected[1][i] + acceleration * de, 0.0);
                                        let c = upper(expected[2][i] + acceleration * dn, 0.0);
                                        let d = upper(expected[3][i] + acceleration * ds, 0.0);
                                        let scale = lower(
                                            water[i] * budget_scale / upper(a + b + c + d, 1e-30),
                                            1.0,
                                        );
                                        expected[0][i] = a * scale;
                                        expected[1][i] = b * scale;
                                        expected[2][i] = c * scale;
                                        expected[3][i] = d * scale;
                                    }
                                    let [qw, qe, qn, qs] = &mut actual;
                                    // SAFETY: SSE2 is available on x86_64; all slices
                                    // share the same checked length n after offset.
                                    let processed = unsafe {
                                        update_flux_prefix::<OPEN>(
                                            &mut qw[offset..],
                                            &mut qe[offset..],
                                            &mut qn[offset..],
                                            &mut qs[offset..],
                                            &surfaces[0][offset..],
                                            &surfaces[1][offset..],
                                            &surfaces[2][offset..],
                                            &surfaces[3][offset..],
                                            &surfaces[4][offset..],
                                            &water[offset..],
                                            acceleration,
                                            budget_scale,
                                            top,
                                            bottom,
                                        )
                                    };
                                    assert_eq!(processed, end);
                                    for direction in 0..4 {
                                        assert_eq!(
                                            bits(&actual[direction]),
                                            bits(&expected[direction]),
                                            "flux n={n}, offset={offset}, open={OPEN}, top={top}, bottom={bottom}, mixed={mixed}, acceleration={acceleration}, budget_scale={budget_scale}, direction={direction}"
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn flux_prefix_matches_scalar_bits_at_open_closed_edges_and_mixed_limits() {
        // All tail lengths and unaligned offsets; dry/signed-zero/subnormal lanes,
        // unconstrained groups, mixed budget limits and all open-boundary corners.
        check_flux_prefix::<false>();
        check_flux_prefix::<true>();
    }

    #[test]
    fn water_prefix_matches_scalar_bits_with_tails_and_unaligned_slices() {
        // Include empty/tiny slices, every SIMD tail, signed zeros, dry lanes,
        // mixed limiter groups and groups that skip the limiter entirely.
        for n in 0..20 {
            for offset in 0..2 {
                let count = n + offset;
                let flux: [Vec<f32>; 8] = std::array::from_fn(|direction| {
                    (0..count)
                        .map(|i| match i % 7 {
                            0 => 0.0,
                            1 => -0.0,
                            2 => f32::from_bits(1),
                            _ => ((i * 31 + direction * 17) % 59) as f32 / 64.0,
                        })
                        .collect()
                });
                for limit in [0.0, 0.125, 1e12] {
                    for flow_dt in [0.0, 0.03125, 0.5] {
                        let dt = 0.125;
                        let mut water: Vec<f32> = (0..count)
                            .map(|i| match i % 5 {
                                0 => 0.0,
                                1 => -0.0,
                                2 => 1e-13,
                                _ => (i % 11) as f32 / 32.0,
                            })
                            .collect();
                        let mut flow: Vec<f32> = (0..count).map(|i| i as f32 / 16.0).collect();
                        let mut velocity = vec![[-1234.0, 5678.0]; count];
                        let mut capacity = vec![1234.0; count];
                        let mut speed = vec![4321.0; count];
                        let mut expected_water = water.clone();
                        let mut expected_flow = flow.clone();
                        let mut expected_velocity = velocity.clone();
                        let mut expected_capacity = capacity.clone();
                        let mut expected_speed = speed.clone();
                        let end = n - n % 4;
                        for x in offset..offset + end {
                            let old = expected_water[x];
                            let depth = upper(
                                old + flow_dt
                                    * (flux[4][x] + flux[5][x] + flux[6][x] + flux[7][x]
                                        - flux[0][x]
                                        - flux[1][x]
                                        - flux[2][x]
                                        - flux[3][x]),
                                0.0,
                            );
                            expected_water[x] = depth;
                            let inv_depth = 1.0 / upper(old + depth, 1e-12);
                            let vx =
                                (flux[4][x] - flux[0][x] + flux[1][x] - flux[5][x]) * inv_depth;
                            let vz =
                                (flux[6][x] - flux[2][x] + flux[3][x] - flux[7][x]) * inv_depth;
                            let raw_speed = (vx * vx + vz * vz).sqrt();
                            let limited = raw_speed > limit;
                            let scale = if limited { limit / raw_speed } else { 1.0 };
                            let vx = vx * scale;
                            let vz = vz * scale;
                            expected_velocity[x] = [vx, vz];
                            expected_speed[x] = lower(raw_speed, limit);
                            expected_flow[x] += expected_speed[x] * dt;
                            expected_capacity[x] = if limited {
                                (vx * vx + vz * vz).sqrt()
                            } else {
                                raw_speed
                            };
                        }
                        // SAFETY: the module only exists on x86_64 (SSE2), and
                        // every slice has n cells after removing its prefix.
                        let processed = unsafe {
                            update_water_prefix(
                                &flux[0][offset..],
                                &flux[1][offset..],
                                &flux[2][offset..],
                                &flux[3][offset..],
                                &flux[4][offset..],
                                &flux[5][offset..],
                                &flux[6][offset..],
                                &flux[7][offset..],
                                &mut water[offset..],
                                &mut flow[offset..],
                                &mut velocity[offset..],
                                &mut capacity[offset..],
                                &mut speed[offset..],
                                dt,
                                flow_dt,
                                limit,
                            )
                        };
                        assert_eq!(processed, end);
                        assert_eq!(bits(&water), bits(&expected_water), "water n={n}");
                        assert_eq!(bits(&flow), bits(&expected_flow), "flow n={n}");
                        assert_eq!(bits(&capacity), bits(&expected_capacity), "capacity n={n}");
                        assert_eq!(bits(&speed), bits(&expected_speed), "speed n={n}");
                        for (actual, expected) in velocity.iter().zip(&expected_velocity) {
                            assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod fused_tests {
    use super::update_plain_prefix;
    use crate::erosion::{PipeParams, erode_row, lower, update_water_row, upper};

    fn bits(values: &[f32]) -> Vec<u32> {
        values.iter().map(|value| value.to_bits()).collect()
    }

    #[test]
    fn plain_prefix_matches_separate_passes_bits_and_sparse_zero_commits() {
        for (n, x_offset, right_padding) in
            (0..20).flat_map(|n| [(n, 0, 0), (n, 0, 3), (n, 3, 0), (n, 3, 3)])
        {
            let width = (x_offset + n + right_padding).max(2);
            for offset in 0..2 {
                let count = n + offset;
                let flux: [Vec<f32>; 8] = std::array::from_fn(|direction| {
                    (0..count)
                        .map(|i| match i % 7 {
                            0 => 0.0,
                            1 => -0.0,
                            2 => f32::from_bits(1),
                            _ => ((i * 31 + direction * 17) % 59) as f32 / 64.0,
                        })
                        .collect()
                });
                let slope: Vec<f32> = (0..count).map(|i| (i % 7) as f32 / 8.0).collect();
                let relief: Vec<f32> = (0..count).map(|i| (i % 3) as f32 / 4.0).collect();
                for limit in [0.0, 0.125, 1e12] {
                    for evaporation in [0.0, 0.95, 1.0] {
                        for sediment_capacity in [0.0, 1.0, 1e5] {
                            let mut water: Vec<f32> = (0..count)
                                .map(|i| match i % 5 {
                                    0 => 0.0,
                                    1 => -0.0,
                                    2 => 1e-13,
                                    _ => (i % 11) as f32 / 32.0,
                                })
                                .collect();
                            let mut height: Vec<f32> = (0..count)
                                .map(|i| [-0.0, 0.0, 1e5, 3.0, -2.0][i % 5])
                                .collect();
                            let mut material: Vec<f32> =
                                (0..count).map(|i| [0.0, 0.001, 2.0][i % 3]).collect();
                            let mut sediment: Vec<f32> = (0..count)
                                .map(|i| if i % 2 == 0 { -0.0 } else { 0.25 })
                                .collect();
                            let mut wear = sediment.clone();
                            let mut flow: Vec<f32> = (0..count).map(|i| i as f32 / 16.0).collect();
                            let mut velocity = vec![[-1234.0, 5678.0]; count];
                            let mut change = vec![-4321.0; count];
                            let mut horizontal_flux = vec![-6789.0; count];
                            let mut expected_horizontal = horizontal_flux.clone();
                            let mut ew = water.clone();
                            let mut eh = height.clone();
                            let mut em = material.clone();
                            let mut es = sediment.clone();
                            let mut er = wear.clone();
                            let mut ef = flow.clone();
                            let mut ev = velocity.clone();
                            let mut ec = change.clone();
                            let end = n - n % 4;
                            let range = offset..offset + end;
                            let mut capacity_speed = vec![0.0; end];
                            let mut limited_speed = vec![0.0; end];
                            let mut after = vec![0.0; end];
                            let mobility = vec![1.0; end];
                            let dt = 0.125;
                            let flow_dt = 0.03125;
                            let erosion_dt = 0.025;
                            let deposition_dt = 0.075;
                            update_water_row(
                                &flux[0][range.clone()],
                                &flux[1][range.clone()],
                                &flux[2][range.clone()],
                                &flux[3][range.clone()],
                                &flux[4][range.clone()],
                                &flux[5][range.clone()],
                                &flux[6][range.clone()],
                                &flux[7][range.clone()],
                                &mut ew[range.clone()],
                                &mut ef[range.clone()],
                                &mut ev[range.clone()],
                                &mut capacity_speed,
                                &mut limited_speed,
                                dt,
                                flow_dt,
                                limit,
                            );
                            erode_row::<false, false>(
                                &eh[range.clone()],
                                &em[range.clone()],
                                &mut after,
                                &mut ec[range.clone()],
                                &ew[range.clone()],
                                &capacity_speed,
                                &slope[range.clone()],
                                &relief[range.clone()],
                                &mobility,
                                &mobility,
                                &[],
                                &[],
                                &PipeParams {
                                    sediment_capacity,
                                    ..Default::default()
                                },
                                dt,
                                erosion_dt,
                                deposition_dt,
                            );
                            let mut max_depth = 0.0;
                            let mut max_speed = 0.0;
                            for j in 0..end {
                                let i = j + offset;
                                max_depth = upper(max_depth, ew[i]);
                                max_speed = upper(max_speed, limited_speed[j]);
                                ew[i] *= evaporation;
                                if ec[i] != 0.0 {
                                    eh[i] = after[j];
                                    let deposited = lower(upper(ec[i], 0.0), em[i]);
                                    let eroded = upper(-ec[i], 0.0);
                                    em[i] = em[i] - deposited + eroded;
                                    es[i] += deposited;
                                    er[i] += eroded;
                                }
                                let d = ev[i][0] * flow_dt;
                                let global_x = x_offset + j;
                                let allowed = if d < 0.0 {
                                    global_x > 0
                                } else {
                                    global_x + 1 < width
                                };
                                let transfer = if allowed { em[i] * d.abs() } else { 0.0 };
                                expected_horizontal[i] = transfer.copysign(d);
                            }
                            // SAFETY: x86_64 guarantees SSE2; every slice has n cells.
                            let result = unsafe {
                                update_plain_prefix(
                                    &flux[0][offset..],
                                    &flux[1][offset..],
                                    &flux[2][offset..],
                                    &flux[3][offset..],
                                    &flux[4][offset..],
                                    &flux[5][offset..],
                                    &flux[6][offset..],
                                    &flux[7][offset..],
                                    &mut water[offset..],
                                    &mut flow[offset..],
                                    &mut velocity[offset..],
                                    &mut height[offset..],
                                    &mut material[offset..],
                                    &mut sediment[offset..],
                                    &mut wear[offset..],
                                    &slope[offset..],
                                    &relief[offset..],
                                    &mut change[offset..],
                                    &mut horizontal_flux[offset..],
                                    x_offset,
                                    width,
                                    dt,
                                    flow_dt,
                                    limit,
                                    erosion_dt,
                                    deposition_dt,
                                    evaporation,
                                    sediment_capacity,
                                )
                            };
                            assert_eq!(result.0, end);
                            assert_eq!(result.1.to_bits(), max_depth.to_bits());
                            assert_eq!(result.2.to_bits(), max_speed.to_bits());
                            for (name, actual, expected) in [
                                ("water", &water, &ew),
                                ("flow", &flow, &ef),
                                ("height", &height, &eh),
                                ("suspended", &material, &em),
                                ("sediment", &sediment, &es),
                                ("wear", &wear, &er),
                                ("change", &change, &ec),
                                ("horizontal flux", &horizontal_flux, &expected_horizontal),
                            ] {
                                assert_eq!(
                                    bits(actual),
                                    bits(expected),
                                    "{name}: n={n}, offset={offset}, x_offset={x_offset}, width={width}, limit={limit}, evaporation={evaporation}, capacity={sediment_capacity}"
                                );
                            }
                            for (actual, expected) in velocity.iter().zip(&ev) {
                                assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
                            }
                        }
                    }
                }
            }
        }
    }
}
