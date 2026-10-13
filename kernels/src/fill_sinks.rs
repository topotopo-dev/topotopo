//! Deterministic priority-flood depression filling (Barnes et al., 2014).
//!
//! Eight-connected borders and explicitly protected cells are outlets. A FIFO
//! handles depressions at epsilon zero (the improved priority-flood algorithm).
//! The monotone radix queue orders finite IEEE-754 elevations exactly; equal
//! priorities use a fixed insertion order, independent of platform or SIMD.

use std::collections::VecDeque;

use crate::erosion_flow::validate_grid;

#[derive(Clone, Copy, Debug, Default)]
pub struct FillParams {
    /// Minimum rise per receiver edge, in height units (not slope per metre).
    pub epsilon: f32,
    /// Zero fills every depression; otherwise retain entire deeper depressions.
    pub max_depth: f32,
    pub write_direction: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FillResult {
    pub height: Vec<f32>,
    pub fill: Vec<f32>,
    /// Standing water depth above the unchanged bed of retained lakes.
    pub lake: Vec<f32>,
    /// E, SE, S, SW, W, NW, N, NE = 0..7; outlet/lake = 255.
    /// A non-increasing, acyclic path to an outlet, including resolved flats.
    pub direction: Vec<u8>,
}

#[derive(Clone, Copy)]
struct Entry {
    key: u32,
    index: u32,
}

struct RadixQueue {
    buckets: [Vec<Entry>; 33],
    last: u32,
    len: usize,
}

impl RadixQueue {
    fn new() -> Self {
        Self {
            buckets: std::array::from_fn(|_| Vec::new()),
            last: 0,
            len: 0,
        }
    }

    fn push(&mut self, elevation: f32, index: usize) {
        let bits = elevation.to_bits();
        // Canonicalise signed zero: both have the same numeric elevation.
        let key = if elevation == 0.0 {
            0x8000_0000
        } else if bits & 0x8000_0000 == 0 {
            bits ^ 0x8000_0000
        } else {
            !bits
        };
        let bucket = (32 - (key ^ self.last).leading_zeros()) as usize;
        self.buckets[bucket].push(Entry {
            key,
            index: index as u32,
        });
        self.len += 1;
    }

    fn pop(&mut self) -> Option<usize> {
        if self.len == 0 {
            return None;
        }
        if self.buckets[0].is_empty() {
            let bucket = (1..33).find(|&i| !self.buckets[i].is_empty())?;
            self.last = self.buckets[bucket].iter().map(|e| e.key).min()?;
            // Taking the bucket allows its allocation to be reused next time.
            let mut entries = std::mem::take(&mut self.buckets[bucket]);
            for entry in entries.drain(..) {
                let next = (32 - (entry.key ^ self.last).leading_zeros()) as usize;
                self.buckets[next].push(entry);
            }
            self.buckets[bucket] = entries;
        }
        self.len -= 1;
        self.buckets[0].pop().map(|e| e.index as usize)
    }
}

#[inline(always)]
fn neighbours(i: usize, w: usize, n: usize) -> [usize; 8] {
    let x = i % w;
    if x > 0 && x + 1 < w && i >= w && i + w < n {
        return [
            i + 1,
            i + w + 1,
            i + w,
            i + w - 1,
            i - 1,
            i - w - 1,
            i - w,
            i - w + 1,
        ];
    }
    let east = x + 1 < w;
    let west = x > 0;
    let north = i >= w;
    let south = i + w < n;
    [
        if east { i + 1 } else { usize::MAX },
        if east && south { i + w + 1 } else { usize::MAX },
        if south { i + w } else { usize::MAX },
        if west && south { i + w - 1 } else { usize::MAX },
        if west { i - 1 } else { usize::MAX },
        if west && north { i - w - 1 } else { usize::MAX },
        if north { i - w } else { usize::MAX },
        if east && north { i - w + 1 } else { usize::MAX },
    ]
}

fn flood(
    height: &[f32],
    w: usize,
    h: usize,
    mask: Option<&[f32]>,
    epsilon: f32,
) -> Result<(Vec<f32>, Vec<u8>), String> {
    let n = height.len();
    let mut filled = height.to_vec();
    let mut direction = vec![255u8; n];
    let mut visited = vec![false; n];
    let mut open = RadixQueue::new();
    let mut pit = VecDeque::new();
    let mut seed = |i: usize| {
        if !visited[i] {
            visited[i] = true;
            open.push(height[i], i);
        }
    };
    for i in 0..w {
        seed(i);
    }
    for z in 1..h - 1 {
        seed(z * w);
        seed(z * w + w - 1);
    }
    for i in n - w..n {
        seed(i);
    }
    if let Some(mask) = mask {
        for (i, &value) in mask.iter().enumerate() {
            if value >= 1.0 {
                seed(i);
            }
        }
    }
    while let Some(i) = pit.pop_front().or_else(|| open.pop()) {
        let level = filled[i];
        let threshold = if epsilon == 0.0 {
            level
        } else {
            (level + epsilon).max(level.next_up())
        };
        for (d, j) in neighbours(i, w, w * h).into_iter().enumerate() {
            if j == usize::MAX || visited[j] {
                continue;
            }
            visited[j] = true;
            direction[j] = ((d + 4) % 8) as u8;
            if height[j] <= threshold {
                if !threshold.is_finite() || threshold > 1e8 {
                    return Err(
                        "fill_sinks: epsilon gradient exceeds the supported height range".into(),
                    );
                }
                filled[j] = threshold;
                if epsilon == 0.0 {
                    pit.push_back(j);
                } else {
                    open.push(threshold, j);
                }
            } else {
                open.push(height[j], j);
            }
        }
    }
    Ok((filled, direction))
}

pub fn fill_sinks(
    height: &[f32],
    w: usize,
    h: usize,
    p: &FillParams,
    mask: Option<&[f32]>,
) -> Result<FillResult, String> {
    let n = validate_grid(height, w, h, 1.0)?;
    if !p.epsilon.is_finite()
        || !(0.0..=1e6).contains(&p.epsilon)
        || !p.max_depth.is_finite()
        || !(0.0..=2e8).contains(&p.max_depth)
    {
        return Err("fill_sinks: epsilon must be finite in 0..1e6 and max_depth in 0..2e8 (zero is unlimited)".into());
    }
    if mask.is_some_and(|a| {
        a.len() != n || a.iter().any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
    }) {
        return Err(
            "fill_sinks: mask must have one finite value in 0..1 per cell (1 protects the cell)"
                .into(),
        );
    }
    // Lake classification uses the physical, horizontal spill surface; an
    // epsilon rise must not connect otherwise separate lakes over a saddle.
    let first_epsilon = if p.max_depth > 0.0 { 0.0 } else { p.epsilon };
    let (mut filled, mut direction) = flood(height, w, h, mask, first_epsilon)?;
    let mut lake = vec![0.0; n];
    if p.max_depth > 0.0 {
        let mut seen = vec![false; n];
        let mut component = Vec::new();
        for start in 0..n {
            if seen[start] || filled[start] <= height[start] {
                continue;
            }
            component.clear();
            component.push(start);
            seen[start] = true;
            let mut deepest = 0.0f32;
            let mut head = 0;
            while head < component.len() {
                let i = component[head];
                head += 1;
                deepest = deepest.max(filled[i] - height[i]);
                for j in neighbours(i, w, n) {
                    if j != usize::MAX && !seen[j] && filled[j] > height[j] {
                        seen[j] = true;
                        component.push(j);
                    }
                }
            }
            if deepest > p.max_depth {
                for &i in &component {
                    lake[i] = filled[i] - height[i];
                }
            }
        }
        if p.epsilon > 0.0 {
            (filled, direction) = flood(height, w, h, mask, p.epsilon)?;
        }
        for i in 0..n {
            if lake[i] > 0.0 {
                filled[i] = height[i];
                direction[i] = 255;
            }
        }
    }
    let fill = filled
        .iter()
        .zip(height)
        .map(|(a, b)| (a - b).max(0.0))
        .collect();
    if !p.write_direction {
        direction.clear();
    }
    Ok(FillResult {
        height: filled,
        fill,
        lake,
        direction,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bowl(w: usize) -> Vec<f32> {
        (0..w * w)
            .map(|i| {
                if i / w == 0 || i / w == w - 1 || i % w == 0 || i % w == w - 1 {
                    5.0
                } else {
                    -3.0
                }
            })
            .collect()
    }

    #[test]
    fn every_cell_reaches_border_and_fill_is_nonnegative() {
        let w = 33;
        for epsilon in [0.0, 0.001, f32::MIN_POSITIVE] {
            let input = bowl(w);
            let result = fill_sinks(
                &input,
                w,
                w,
                &FillParams {
                    epsilon,
                    write_direction: true,
                    ..FillParams::default()
                },
                None,
            )
            .unwrap();
            for (start, &original) in input.iter().enumerate() {
                assert!(result.fill[start] >= 0.0);
                assert_eq!(result.fill[start], result.height[start] - original);
                let mut i = start;
                let mut steps = 0;
                while result.direction[i] != 255 {
                    let j = neighbours(i, w, w * w)[result.direction[i] as usize];
                    assert!(result.height[j] <= result.height[i]);
                    if epsilon > 0.0 {
                        assert!(result.height[j] < result.height[i]);
                    }
                    i = j;
                    steps += 1;
                    assert!(steps < w * w);
                }
                assert!(i < w || i >= w * (w - 1) || i % w == 0 || i % w == w - 1);
            }
        }
    }

    #[test]
    fn fixed_mask_cells_are_unchanged_outlets() {
        let input = bowl(7);
        let mut mask = vec![0.0; 49];
        mask[24] = 1.0;
        let result = fill_sinks(
            &input,
            7,
            7,
            &FillParams {
                epsilon: 0.01,
                write_direction: true,
                ..FillParams::default()
            },
            Some(&mask),
        )
        .unwrap();
        assert_eq!(result.height[24], input[24]);
        assert_eq!(result.fill[24], 0.0);
        assert_eq!(result.direction[24], 255);
    }

    #[test]
    fn threshold_retains_the_whole_lake_and_reports_water_depth() {
        let mut input = bowl(7);
        input[16] = 4.0; // A shallow part of the same deep lake is retained too.
        for epsilon in [0.0, 0.01] {
            let result = fill_sinks(
                &input,
                7,
                7,
                &FillParams {
                    max_depth: 2.0,
                    epsilon,
                    ..FillParams::default()
                },
                None,
            )
            .unwrap();
            assert_eq!(result.height, input);
            assert_eq!(result.lake[16], 1.0);
            assert_eq!(result.lake[24], 8.0);
            assert!(result.fill.iter().all(|&v| v == 0.0));
        }
        let result = fill_sinks(
            &input,
            7,
            7,
            &FillParams {
                max_depth: 8.0,
                ..FillParams::default()
            },
            None,
        )
        .unwrap();
        assert!(result.lake.iter().all(|&v| v == 0.0));
        assert_eq!(result.fill[24], 8.0);
    }

    #[test]
    fn deterministic_on_irregular_signed_terrain() {
        let input: Vec<f32> = (0..31 * 23)
            .map(|i| ((i * 7919 % 177) as f32 - 80.0) * 0.2)
            .collect();
        for epsilon in [0.0, 0.0001] {
            let p = FillParams {
                epsilon,
                write_direction: true,
                ..FillParams::default()
            };
            let a = fill_sinks(&input, 31, 23, &p, None).unwrap();
            let b = fill_sinks(&input, 31, 23, &p, None).unwrap();
            assert_eq!(a, b);
            for start in 0..input.len() {
                let mut i = start;
                let mut steps = 0;
                while a.direction[i] < 8 {
                    let j = neighbours(i, 31, input.len())[a.direction[i] as usize];
                    assert!(a.height[j] <= a.height[i]);
                    if epsilon > 0.0 {
                        assert!(a.height[j] < a.height[i]);
                    }
                    i = j;
                    steps += 1;
                    assert!(steps < input.len());
                }
                assert!(!(31..31 * 22).contains(&i) || i % 31 == 0 || i % 31 == 30);
            }
        }
    }

    #[test]
    fn matches_independent_minimax_spill_reference() {
        // Bellman relaxation from the border is deliberately independent of the
        // heap/FIFO implementation. Include small rectangular and signed grids.
        for seed in 1..40usize {
            let w = 3 + seed % 9;
            let h = 3 + seed % 7;
            let input: Vec<f32> = (0..w * h)
                .map(|i| ((i * 7919 + seed * 31337) % 97) as f32 - 48.0)
                .collect();
            let mut reference = vec![f32::INFINITY; input.len()];
            for i in 0..input.len() {
                if i < w || i >= w * (h - 1) || i % w == 0 || i % w == w - 1 {
                    reference[i] = input[i];
                }
            }
            loop {
                let mut changed = false;
                for i in 0..input.len() {
                    let lowest = neighbours(i, w, input.len())
                        .into_iter()
                        .filter(|&j| j != usize::MAX)
                        .map(|j| reference[j])
                        .fold(f32::INFINITY, f32::min);
                    let candidate = lowest.max(input[i]);
                    if candidate < reference[i] {
                        reference[i] = candidate;
                        changed = true;
                    }
                }
                if !changed {
                    break;
                }
            }
            assert_eq!(
                fill_sinks(&input, w, h, &FillParams::default(), None)
                    .unwrap()
                    .height,
                reference
            );
        }
    }

    #[test]
    fn hostile_inputs_return_errors_without_panics() {
        for input in [
            vec![f32::NAN; 4],
            vec![f32::INFINITY; 4],
            vec![1e9; 4],
            vec![],
        ] {
            assert!(fill_sinks(&input, 2, 2, &FillParams::default(), None).is_err());
        }
        assert!(fill_sinks(&[0.0; 4], usize::MAX, 2, &FillParams::default(), None).is_err());
        assert!(
            fill_sinks(
                &[0.0; 4],
                2,
                2,
                &FillParams {
                    epsilon: -1.0,
                    ..FillParams::default()
                },
                None
            )
            .is_err()
        );
        assert!(
            fill_sinks(
                &[0.0; 4],
                2,
                2,
                &FillParams {
                    max_depth: f32::NAN,
                    ..FillParams::default()
                },
                None
            )
            .is_err()
        );
        assert!(fill_sinks(&[0.0; 4], 2, 2, &FillParams::default(), Some(&[0.0])).is_err());
        assert!(
            fill_sinks(
                &[0.0; 4],
                2,
                2,
                &FillParams::default(),
                Some(&[f32::NAN; 4])
            )
            .is_err()
        );
        assert!(
            fill_sinks(
                &[1e8; 9],
                3,
                3,
                &FillParams {
                    epsilon: 1e6,
                    ..FillParams::default()
                },
                None
            )
            .is_err()
        );
    }
}
