//! Strict simd128 flux and water updates. No relaxed SIMD or fused operations.
//!
//! The ordinary LLVM vector loop evaluates both arms of the velocity limiter,
//! including a second square root, for every group. One mask test lets groups
//! that need no limiter skip its division and capacity-speed sqrt. Unconstrained
//! flux groups likewise skip their budget division.

use std::arch::wasm32::{
    f32x4_add, f32x4_div, f32x4_gt, f32x4_lt, f32x4_mul, f32x4_splat, f32x4_sqrt, f32x4_sub, i32x4,
    i32x4_shuffle, v128_any_true, v128_bitselect, v128_load, v128_store,
};

/// Update the largest four-cell flux prefix, retaining scalar arithmetic order.
/// The caller processes the remaining tail using the original full row width.
///
/// # Safety
/// The executing WebAssembly engine must support simd128. All slice lengths are
/// checked before loads/stores; Rust's mutable borrows exclude aliasing.
#[target_feature(enable = "simd128")]
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
    let zero = f32x4_splat(0.0);
    let one = f32x4_splat(1.0);
    let minimum_flux = f32x4_splat(1e-30);
    let acceleration4 = f32x4_splat(acceleration);
    let budget_scale4 = f32x4_splat(budget_scale);
    let first_lane = i32x4(-1, 0, 0, 0);
    let last_lane = i32x4(0, 0, 0, -1);
    for x in (0..end).step_by(4) {
        // SAFETY: x + 4 <= end <= n, and every input/output slice has n cells.
        unsafe {
            let s = v128_load(center.as_ptr().add(x).cast());
            let water4 = v128_load(water.as_ptr().add(x).cast());
            let mut dw = f32x4_sub(s, v128_load(west.as_ptr().add(x).cast()));
            let mut de = f32x4_sub(s, v128_load(east.as_ptr().add(x).cast()));
            if OPEN && x == 0 {
                dw = v128_bitselect(water4, dw, first_lane);
            }
            if OPEN && x + 4 == n {
                de = v128_bitselect(water4, de, last_lane);
            }
            let dn = if OPEN && top {
                water4
            } else {
                f32x4_sub(s, v128_load(north.as_ptr().add(x).cast()))
            };
            let ds = if OPEN && bottom {
                water4
            } else {
                f32x4_sub(s, v128_load(south.as_ptr().add(x).cast()))
            };
            let a = f32x4_add(
                v128_load(qw.as_ptr().add(x).cast()),
                f32x4_mul(acceleration4, dw),
            );
            let b = f32x4_add(
                v128_load(qe.as_ptr().add(x).cast()),
                f32x4_mul(acceleration4, de),
            );
            let c = f32x4_add(
                v128_load(qn.as_ptr().add(x).cast()),
                f32x4_mul(acceleration4, dn),
            );
            let d = f32x4_add(
                v128_load(qs.as_ptr().add(x).cast()),
                f32x4_mul(acceleration4, ds),
            );
            let a = v128_bitselect(a, zero, f32x4_gt(a, zero));
            let b = v128_bitselect(b, zero, f32x4_gt(b, zero));
            let c = v128_bitselect(c, zero, f32x4_gt(c, zero));
            let d = v128_bitselect(d, zero, f32x4_gt(d, zero));
            let total = f32x4_add(f32x4_add(f32x4_add(a, b), c), d);
            let denominator = v128_bitselect(total, minimum_flux, f32x4_gt(total, minimum_flux));
            let budget = f32x4_mul(water4, budget_scale4);
            // Nonnegative budget >= positive denominator makes the original
            // ratio clamp to exactly 1, so unconstrained groups need no divide.
            let scale = if v128_any_true(f32x4_lt(budget, denominator)) {
                let ratio = f32x4_div(budget, denominator);
                v128_bitselect(ratio, one, f32x4_lt(ratio, one))
            } else {
                one
            };
            v128_store(qw.as_mut_ptr().add(x).cast(), f32x4_mul(a, scale));
            v128_store(qe.as_mut_ptr().add(x).cast(), f32x4_mul(b, scale));
            v128_store(qn.as_mut_ptr().add(x).cast(), f32x4_mul(c, scale));
            v128_store(qs.as_mut_ptr().add(x).cast(), f32x4_mul(d, scale));
        }
    }
    end
}

/// Update the largest four-cell prefix; the caller handles `returned..water.len()`
/// with the scalar operation sequence.
///
/// # Safety
/// The executing WebAssembly engine must support simd128. Slice lengths are
/// checked here before any load/store, and Rust's mutable borrows exclude aliasing.
#[target_feature(enable = "simd128")]
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
    let zero = f32x4_splat(0.0);
    let one = f32x4_splat(1.0);
    let minimum_depth = f32x4_splat(1e-12);
    let flow_dt4 = f32x4_splat(flow_dt);
    let dt4 = f32x4_splat(dt);
    let limit4 = f32x4_splat(velocity_limit);
    for x in (0..end).step_by(4) {
        // SAFETY: x + 4 <= end <= n and every slice has n cells. Loads/stores
        // permit unaligned pointers; each velocity cell contains two f32 values.
        unsafe {
            let qw4 = v128_load(qw.as_ptr().add(x).cast());
            let qe4 = v128_load(qe.as_ptr().add(x).cast());
            let qn4 = v128_load(qn.as_ptr().add(x).cast());
            let qs4 = v128_load(qs.as_ptr().add(x).cast());
            let iw4 = v128_load(iw.as_ptr().add(x).cast());
            let ie4 = v128_load(ie.as_ptr().add(x).cast());
            let it4 = v128_load(it.as_ptr().add(x).cast());
            let ib4 = v128_load(ib.as_ptr().add(x).cast());
            let old = v128_load(water.as_ptr().add(x).cast());
            // Match the scalar left-associative sum exactly; do not reassociate.
            let net = f32x4_sub(
                f32x4_sub(
                    f32x4_sub(
                        f32x4_sub(f32x4_add(f32x4_add(f32x4_add(iw4, ie4), it4), ib4), qw4),
                        qe4,
                    ),
                    qn4,
                ),
                qs4,
            );
            let depth = f32x4_add(old, f32x4_mul(flow_dt4, net));
            // Ordered comparisons select the second operand on ties, matching
            // upper()/lower() even for signed zero (unlike SIMD min/max).
            let depth = v128_bitselect(depth, zero, f32x4_gt(depth, zero));
            v128_store(water.as_mut_ptr().add(x).cast(), depth);
            let sum_depth = f32x4_add(old, depth);
            let denominator =
                v128_bitselect(sum_depth, minimum_depth, f32x4_gt(sum_depth, minimum_depth));
            let inv_depth = f32x4_div(one, denominator);
            let mut vx = f32x4_mul(
                f32x4_sub(f32x4_add(f32x4_sub(iw4, qw4), qe4), ie4),
                inv_depth,
            );
            let mut vz = f32x4_mul(
                f32x4_sub(f32x4_add(f32x4_sub(it4, qn4), qs4), ib4),
                inv_depth,
            );
            let raw_speed = f32x4_sqrt(f32x4_add(f32x4_mul(vx, vx), f32x4_mul(vz, vz)));
            let limited = f32x4_gt(raw_speed, limit4);
            let capacity = if v128_any_true(limited) {
                let scale = v128_bitselect(f32x4_div(limit4, raw_speed), one, limited);
                vx = f32x4_mul(vx, scale);
                vz = f32x4_mul(vz, scale);
                let scaled_speed = f32x4_sqrt(f32x4_add(f32x4_mul(vx, vx), f32x4_mul(vz, vz)));
                v128_bitselect(scaled_speed, raw_speed, limited)
            } else {
                // Multiplication by exactly 1 is bit-preserving for finite
                // velocities, including either signed zero.
                raw_speed
            };
            let speed = v128_bitselect(raw_speed, limit4, f32x4_lt(raw_speed, limit4));
            let flow4 = f32x4_add(
                v128_load(flow.as_ptr().add(x).cast()),
                f32x4_mul(speed, dt4),
            );
            v128_store(flow.as_mut_ptr().add(x).cast(), flow4);
            v128_store(limited_speed.as_mut_ptr().add(x).cast(), speed);
            v128_store(capacity_speed.as_mut_ptr().add(x).cast(), capacity);
            v128_store(
                velocity.as_mut_ptr().add(x).cast(),
                i32x4_shuffle::<0, 4, 1, 5>(vx, vz),
            );
            v128_store(
                velocity.as_mut_ptr().add(x + 2).cast(),
                i32x4_shuffle::<2, 6, 3, 7>(vx, vz),
            );
        }
    }
    end
}
