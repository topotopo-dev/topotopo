//! Row-local CFL maxima and evaporation, separated from sparse terrain edits.
//!
//! Inputs are nonnegative finite depths and limited speeds. Independent lane
//! accumulators avoid a serial maximum dependency over the entire row. Tied
//! signed zeros retain the last input's sign, matching the ordered scalar fold.

#[inline(always)]
fn upper(a: f32, b: f32) -> f32 {
    if a > b { a } else { b }
}

/// Return maxima before evaporation and multiply each depth by `factor` once.
/// Water and speed samples must be finite and nonnegative; either sign of zero
/// is accepted. The empty row has maxima `(0, 0)`.
#[inline(never)]
pub(super) fn reduce_evaporate(
    water: &mut [f32],
    limited_speed: &[f32],
    factor: f32,
) -> (f32, f32) {
    let n = water.len();
    assert_eq!(limited_speed.len(), n);
    let last_depth = water.last().copied().unwrap_or(0.0);
    let last_speed = limited_speed.last().copied().unwrap_or(0.0);
    #[cfg(all(target_arch = "wasm32", feature = "simd"))]
    // SAFETY: this module is selected only in the simd128 build. The helper
    // checks every slice length before its unaligned vector loads and stores.
    let (start, mut depths, mut speeds) = unsafe { reduce_prefix(water, limited_speed, factor) };
    #[cfg(not(all(target_arch = "wasm32", feature = "simd")))]
    let (start, mut depths, mut speeds) = {
        let end = n - n % 8;
        let mut depths = [0.0f32; 8];
        let mut speeds = [0.0f32; 8];
        for x in (0..end).step_by(8) {
            // Eight independent recurrence chains let LLVM vectorize native
            // loads, ordered maxima and stores without reassociating floats.
            for lane in 0..8 {
                let depth = water[x + lane];
                depths[lane] = upper(depths[lane], depth);
                speeds[lane] = upper(speeds[lane], limited_speed[x + lane]);
                water[x + lane] = depth * factor;
            }
        }
        (end, depths, speeds)
    };
    for x in start..n {
        let depth = water[x];
        depths[0] = upper(depths[0], depth);
        speeds[0] = upper(speeds[0], limited_speed[x]);
        water[x] = depth * factor;
    }
    let max_depth = depths.into_iter().fold(0.0, upper);
    let max_speed = speeds.into_iter().fold(0.0, upper);
    // Regrouping finite nonnegative maxima changes only all-zero tie signs.
    // The original row fold always chooses the final zero in that case.
    (
        if max_depth == 0.0 {
            last_depth
        } else {
            max_depth
        },
        if max_speed == 0.0 {
            last_speed
        } else {
            max_speed
        },
    )
}

#[cfg(all(target_arch = "wasm32", feature = "simd"))]
#[target_feature(enable = "simd128")]
unsafe fn reduce_prefix(
    water: &mut [f32],
    limited_speed: &[f32],
    factor: f32,
) -> (usize, [f32; 8], [f32; 8]) {
    use std::arch::wasm32::{
        f32x4_gt, f32x4_mul, f32x4_splat, v128_bitselect, v128_load, v128_store,
    };
    let n = water.len();
    assert_eq!(limited_speed.len(), n);
    let end = n - n % 8;
    let zero = f32x4_splat(0.0);
    let factor4 = f32x4_splat(factor);
    let mut depth_a = zero;
    let mut depth_b = zero;
    let mut speed_a = zero;
    let mut speed_b = zero;
    for x in (0..end).step_by(8) {
        // SAFETY: x+8 <= end <= both slice lengths; unaligned accesses are
        // permitted. Mutable water cannot alias the immutable speed slice.
        unsafe {
            let a = v128_load(water.as_ptr().add(x).cast());
            let b = v128_load(water.as_ptr().add(x + 4).cast());
            let sa = v128_load(limited_speed.as_ptr().add(x).cast());
            let sb = v128_load(limited_speed.as_ptr().add(x + 4).cast());
            depth_a = v128_bitselect(depth_a, a, f32x4_gt(depth_a, a));
            depth_b = v128_bitselect(depth_b, b, f32x4_gt(depth_b, b));
            speed_a = v128_bitselect(speed_a, sa, f32x4_gt(speed_a, sa));
            speed_b = v128_bitselect(speed_b, sb, f32x4_gt(speed_b, sb));
            v128_store(water.as_mut_ptr().add(x).cast(), f32x4_mul(a, factor4));
            v128_store(water.as_mut_ptr().add(x + 4).cast(), f32x4_mul(b, factor4));
        }
    }
    let mut depths = [0.0f32; 8];
    let mut speeds = [0.0f32; 8];
    // SAFETY: each destination is eight f32 values (two unaligned vectors).
    unsafe {
        v128_store(depths.as_mut_ptr().cast(), depth_a);
        v128_store(depths.as_mut_ptr().add(4).cast(), depth_b);
        v128_store(speeds.as_mut_ptr().cast(), speed_a);
        v128_store(speeds.as_mut_ptr().add(4).cast(), speed_b);
    }
    (end, depths, speeds)
}

#[cfg(test)]
mod tests {
    use super::{reduce_evaporate, upper};

    fn reference(water: &mut [f32], speeds: &[f32], factor: f32) -> (f32, f32) {
        let mut max_depth = 0.0;
        let mut max_speed = 0.0;
        for (depth, &speed) in water.iter_mut().zip(speeds) {
            max_depth = upper(max_depth, *depth);
            max_speed = upper(max_speed, speed);
            *depth *= factor;
        }
        (max_depth, max_speed)
    }

    #[test]
    fn row_reduction_and_evaporation_match_scalar_bits() {
        for width in 1..=129 {
            for mode in 0..4 {
                let water: Vec<f32> = (0..width)
                    .map(|i| match mode {
                        0 => ((i * 7919 + width * 13) % 65536) as f32 / 8192.0,
                        1 => {
                            if i % 2 == 0 {
                                0.0
                            } else {
                                -0.0
                            }
                        }
                        2 => {
                            if i % 2 == 0 {
                                -0.0
                            } else {
                                0.0
                            }
                        }
                        _ => f32::from_bits(((i * 53 + 1) % 1024) as u32),
                    })
                    .collect();
                let speeds: Vec<f32> = (0..width)
                    .map(|i| {
                        if mode == 0 || mode == 3 {
                            ((i * 193 + width * 7) % 8192) as f32 / 16384.0
                        } else {
                            water[width - 1 - i]
                        }
                    })
                    .collect();
                for factor in [0.0, 0.5, 0.99, 1.0] {
                    let mut expected = water.clone();
                    let mut actual = water.clone();
                    let expected_maxima = reference(&mut expected, &speeds, factor);
                    let actual_maxima = reduce_evaporate(&mut actual, &speeds, factor);
                    assert_eq!(actual_maxima.0.to_bits(), expected_maxima.0.to_bits());
                    assert_eq!(actual_maxima.1.to_bits(), expected_maxima.1.to_bits());
                    assert!(
                        actual
                            .iter()
                            .zip(&expected)
                            .all(|(a, b)| a.to_bits() == b.to_bits())
                    );
                }
            }
        }
        assert_eq!(reduce_evaporate(&mut [], &[], 0.5), (0.0, 0.0));
    }
}
