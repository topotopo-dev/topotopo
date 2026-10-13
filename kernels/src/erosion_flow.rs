//! D8 and triangular-facet D-infinity drainage (Tarboton, 1997).
//!
//! Accumulation includes each cell's own area in square input units. Flats and
//! depressions are sinks: this intentionally does not fill or breach the DEM.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowMethod {
    D8,
    Dinf,
}

#[derive(Clone, Debug)]
pub struct FlowResult {
    pub drainage: Vec<f32>,
    /// Dominant receiver: E, SE, S, SW, W, NW, N, NE = 0..7; sink = 255.
    /// D-infinity accumulation uses both facet receivers, despite this compact
    /// direction layer recording only the receiver with the larger share.
    pub direction: Vec<u8>,
}

const DX: [isize; 8] = [1, 1, 0, -1, -1, -1, 0, 1];
const DZ: [isize; 8] = [0, 1, 1, 1, 0, -1, -1, -1];

pub(crate) fn validate_grid(
    height: &[f32],
    w: usize,
    h: usize,
    cell: f32,
) -> Result<usize, String> {
    let n = w
        .checked_mul(h)
        .ok_or("erosion: grid dimensions overflow")?;
    if w < 2 || h < 2 || n > 16_777_216 || n != height.len() {
        return Err("erosion: expected a 2D grid of 2..16,777,216 finite samples with matching width and height".into());
    }
    if !cell.is_finite() || !(1e-6..=1e6).contains(&cell) {
        return Err("erosion: cell size must be finite and between 1e-6 and 1e6".into());
    }
    if height.iter().any(|v| !v.is_finite() || v.abs() > 1e8) {
        return Err("erosion: height samples must be finite and have magnitude at most 1e8".into());
    }
    Ok(n)
}

pub fn flow_accumulation(
    height: &[f32],
    w: usize,
    h: usize,
    cell: f32,
    method: FlowMethod,
) -> Result<FlowResult, String> {
    flow_on_surface(height, w, h, cell, method, None)
}

/// Fill pits without changing the caller's terrain, resolving horizontal spill
/// surfaces with the priority-flood parent forest. Strict downhill D8/D-infinity
/// receivers are preferred; only their otherwise terminal flats use the forest.
pub fn flow_accumulation_filled(
    height: &[f32],
    w: usize,
    h: usize,
    cell: f32,
    method: FlowMethod,
) -> Result<FlowResult, String> {
    let filled = crate::fill_sinks::fill_sinks(
        height,
        w,
        h,
        &crate::fill_sinks::FillParams {
            write_direction: true,
            ..Default::default()
        },
        None,
    )?;
    flow_on_surface(&filled.height, w, h, cell, method, Some(&filled.direction))
}

pub(crate) fn flow_on_surface(
    height: &[f32],
    w: usize,
    h: usize,
    cell: f32,
    method: FlowMethod,
    flat_direction: Option<&[u8]>,
) -> Result<FlowResult, String> {
    let n = validate_grid(height, w, h, cell)?;
    let mut receiver = vec![[usize::MAX; 2]; n];
    let mut fraction = vec![0.0f32; n];
    let mut direction = vec![255; n];
    for z in 0..h {
        for x in 0..w {
            let i = z * w + x;
            let mut neighbours = [usize::MAX; 8];
            let mut best = 0.0f32;
            for d in 0..8 {
                let nx = x as isize + DX[d];
                let nz = z as isize + DZ[d];
                if nx < 0 || nz < 0 || nx >= w as isize || nz >= h as isize {
                    continue;
                }
                let j = nz as usize * w + nx as usize;
                neighbours[d] = j;
                let slope = (height[i] - height[j])
                    * if d % 2 == 0 {
                        1.0
                    } else {
                        std::f32::consts::FRAC_1_SQRT_2
                    };
                if slope > best {
                    best = slope;
                    receiver[i] = [j, usize::MAX];
                    direction[i] = d as u8;
                }
            }
            if best == 0.0
                && let Some(flat) = flat_direction
                && flat[i] < 8
            {
                let d = flat[i] as usize;
                receiver[i] = [neighbours[d], usize::MAX];
                direction[i] = flat[i];
            }
            if method == FlowMethod::D8 {
                continue;
            }
            for a in 0..8 {
                let b = (a + 1) % 8;
                let ia = neighbours[a];
                let ib = neighbours[b];
                if ia == usize::MAX
                    || ib == usize::MAX
                    || height[ia] >= height[i]
                    || height[ib] >= height[i]
                {
                    continue;
                }
                let ax = DX[a] as f32;
                let az = DZ[a] as f32;
                let bx = DX[b] as f32;
                let bz = DZ[b] as f32;
                // Every consecutive pair has determinant +1 on a square grid.
                let da = height[i] - height[ia];
                let db = height[i] - height[ib];
                let gx = da * bz - db * az;
                let gz = ax * db - bx * da;
                let cross_a = ax * gz - az * gx;
                let cross_b = gx * bz - gz * bx;
                if cross_a < 0.0 || cross_b < 0.0 {
                    continue;
                }
                let slope = libm::sqrtf(gx * gx + gz * gz);
                if slope > best {
                    best = slope;
                    let angle = libm::atan2f(cross_a, ax * gx + az * gz);
                    let share = (angle / std::f32::consts::FRAC_PI_4).clamp(0.0, 1.0);
                    receiver[i] = [ia, ib];
                    fraction[i] = share;
                    direction[i] = if share > 0.5 { b } else { a } as u8;
                }
            }
        }
    }
    let mut order: Vec<usize> = (0..n).collect();
    // Explicit index tie-break gives the same addition order on every platform.
    if flat_direction.is_some() {
        // Equal-height flood parents are not necessarily index ordered. Kahn's
        // traversal preserves every contributor, with an explicit index-ordered
        // initial queue and fixed receiver order for reproducible f32 sums.
        let mut incoming = vec![0u8; n];
        for links in &receiver {
            for &j in links {
                if j != usize::MAX {
                    incoming[j] += 1;
                }
            }
        }
        order.clear();
        order.extend((0..n).filter(|&i| incoming[i] == 0));
        let mut head = 0;
        while head < order.len() {
            let i = order[head];
            head += 1;
            for &j in &receiver[i] {
                if j != usize::MAX {
                    incoming[j] -= 1;
                    if incoming[j] == 0 {
                        order.push(j);
                    }
                }
            }
        }
        if order.len() != n {
            return Err("flow: filled drainage graph contains a cycle".into());
        }
    } else {
        order.sort_unstable_by(|&a, &b| height[b].total_cmp(&height[a]).then(a.cmp(&b)));
    }
    let mut drainage = vec![cell * cell; n];
    for i in order {
        let [a, b] = receiver[i];
        if a != usize::MAX {
            let second = drainage[i] * fraction[i];
            drainage[a] += drainage[i] - second;
            if b != usize::MAX {
                drainage[b] += second;
            }
        }
    }
    Ok(FlowResult {
        drainage,
        direction,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plane_drains_toward_low_edge() {
        let w = 12;
        let h = 9;
        let heights: Vec<f32> = (0..w * h).map(|i| (w - i % w) as f32).collect();
        for method in [FlowMethod::D8, FlowMethod::Dinf] {
            let r = flow_accumulation(&heights, w, h, 2.0, method).unwrap();
            for z in 0..h {
                for x in 0..w - 1 {
                    assert_eq!(r.direction[z * w + x], 0);
                    assert!((r.drainage[z * w + x] - (x + 1) as f32 * 4.0).abs() < 1e-4);
                }
                assert_eq!(r.direction[z * w + w - 1], 255);
                assert_eq!(r.drainage[z * w + w - 1], w as f32 * 4.0);
            }
        }
    }

    #[test]
    fn cone_drains_radially_and_conserves_contributing_area() {
        let w = 31;
        let heights: Vec<f32> = (0..w * w)
            .map(|i| {
                let x = i % w;
                let z = i / w;
                22.0 - libm::sqrtf((x as f32 - 15.0).powi(2) + (z as f32 - 15.0).powi(2))
            })
            .collect();
        for method in [FlowMethod::D8, FlowMethod::Dinf] {
            let r = flow_accumulation(&heights, w, w, 1.0, method).unwrap();
            let mut total = 0.0;
            for i in 0..w * w {
                let d = r.direction[i];
                if d == 255 {
                    total += r.drainage[i];
                    continue;
                }
                let x = i % w;
                let z = i / w;
                assert!(
                    (x as f32 - 15.0) * DX[d as usize] as f32
                        + (z as f32 - 15.0) * DZ[d as usize] as f32
                        >= 0.0
                );
            }
            assert!((total - (w * w) as f32).abs() < 0.01);
        }
    }

    #[test]
    fn filled_flats_conserve_area_and_have_only_border_outlets() {
        let w = 13;
        for seed in 0..20 {
            let heights: Vec<f32> = (0..w * w)
                .map(|i| {
                    if seed == 0 {
                        0.0
                    } else {
                        ((i * 7919 + seed * 31337) % 47) as f32 - 20.0
                    }
                })
                .collect();
            for method in [FlowMethod::D8, FlowMethod::Dinf] {
                let flow = flow_accumulation_filled(&heights, w, w, 1.0, method).unwrap();
                let mut total = 0.0;
                for i in 0..w * w {
                    if flow.direction[i] == 255 {
                        assert!(i < w || i >= w * (w - 1) || i % w == 0 || i % w == w - 1);
                        total += flow.drainage[i];
                    }
                }
                assert!((total - (w * w) as f32).abs() < 0.001);
            }
        }
    }

    #[test]
    fn bad_grid_returns_error() {
        assert!(flow_accumulation(&[], usize::MAX, 2, 1.0, FlowMethod::D8).is_err());
        assert!(flow_accumulation(&[f32::NAN; 4], 2, 2, 1.0, FlowMethod::Dinf).is_err());
        assert!(flow_accumulation(&[0.0; 4], 2, 2, 0.0, FlowMethod::D8).is_err());
    }
}
