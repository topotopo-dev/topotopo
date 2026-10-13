//! Scatter repulsion and surface projection over the existing TypeScript BVH layout.
//! All arithmetic stays f64, in the operation and traversal order of scatter.ts,
//! spatial.ts and TriSurface.closest. No triangle rebuilding changes projection ties.

use crate::scatter::{KdTree, hypot3};

/// Borrowed arrays from `TriSurface.arrays()` (T and C may have different corner order).
#[derive(Clone, Copy)]
pub struct Surface<'a> {
    pub triangles: &'a [f64],
    pub nodes: &'a [f64],
    pub child: &'a [i32],
    pub order: &'a [i32],
    pub tri_prim: &'a [u32],
    pub corners: &'a [f64],
}

#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub radius: f64,
    pub weighted: bool,
    pub d_bar: f64,
    pub w_mean: f64,
    pub iterations: usize,
}

#[derive(Debug, PartialEq)]
pub struct Relaxed {
    pub positions: Vec<f64>,
    pub spacing: Vec<f64>,
    pub triangles: Vec<i32>,
    pub barycentrics: Vec<f64>,
}

#[derive(Clone, Copy, Default)]
struct Hit {
    point: [f64; 3],
    bary: [f64; 3],
    triangle: usize,
}

const MAX_POINTS: usize = 4_000_000;
const MAX_TRIS: usize = 4_000_000;
// Fourth powers occur in the barycentric calculation. This limit leaves ample
// headroom for finite intermediates even when candidates lie far from the mesh.
const MAX_COORD: f64 = 1e50;

fn finite_bounded(a: &[f64], max: f64) -> bool {
    a.iter().all(|v| v.is_finite() && v.abs() <= max)
}

impl Surface<'_> {
    fn validate(&self) -> Result<(), String> {
        let nt = self.order.len();
        let nc = self.corners.len() / 9;
        let nn = self.nodes.len() / 6;
        if nt > MAX_TRIS
            || !self.triangles.len().is_multiple_of(9)
            || self.triangles.len() / 9 != nt
            || !self.corners.len().is_multiple_of(9)
            || self.tri_prim.len() != nt
            || !self.nodes.len().is_multiple_of(6)
            || self.child.len() != nn * 2
            || (nt > 0 && nn == 0)
            || nn > 2 * nt.max(1)
        {
            return Err("scatter_relax: invalid surface array lengths".into());
        }
        if !finite_bounded(self.triangles, MAX_COORD)
            || !finite_bounded(self.corners, MAX_COORD)
            || !finite_bounded(self.nodes, MAX_COORD)
            || self.order.iter().any(|&i| i < 0 || i as usize >= nt)
            || self.tri_prim.iter().any(|&i| i as usize >= nc)
        {
            return Err("scatter_relax: invalid surface coordinates or triangle indices".into());
        }
        // TriBVH's empty constructor retains one zeroed placeholder node.
        // closest() exits before inspecting it when there are no triangles.
        if nt == 0 {
            return Ok(());
        }
        // The TS BVH is numbered parent-first. Requiring one parent for each
        // non-root node prevents cycles and exponential DAG traversals in hostile input.
        let mut parents = vec![0_u8; nn];
        for n in 0..nn {
            let b = n * 6;
            if (0..3).any(|c| self.nodes[b + c] > self.nodes[b + c + 3]) {
                return Err("scatter_relax: inverted BVH bounds".into());
            }
            let c0 = self.child[n * 2];
            let c1 = self.child[n * 2 + 1];
            if c0 < 0 {
                let start = (-1_i64 - i64::from(c0)) as usize;
                if c1 < 0 || start > nt || c1 as usize > nt - start {
                    return Err("scatter_relax: invalid BVH leaf range".into());
                }
            } else {
                for c in [c0, c1] {
                    if c < 0 || c as usize <= n || c as usize >= nn {
                        return Err("scatter_relax: invalid BVH child".into());
                    }
                    let p = &mut parents[c as usize];
                    if *p != 0 {
                        return Err("scatter_relax: BVH child has multiple parents".into());
                    }
                    *p = 1;
                }
            }
        }
        if parents.iter().skip(1).any(|&p| p != 1) {
            return Err("scatter_relax: unreachable BVH node".into());
        }
        Ok(())
    }

    fn box_distance2(&self, n: usize, q: [f64; 3]) -> f64 {
        let b = n * 6;
        let mut delta = [0.0; 3];
        for c in 0..3 {
            let d = self.nodes[b + c] - q[c];
            let e = q[c] - self.nodes[b + 3 + c];
            delta[c] = if d > e {
                if d > 0.0 { d } else { 0.0 }
            } else if e > 0.0 {
                e
            } else {
                0.0
            };
        }
        dot(delta, delta)
    }

    fn closest(&self, q: [f64; 3], stack: &mut Vec<usize>) -> Option<Hit> {
        if self.order.is_empty() {
            return None;
        }
        let mut best2 = f64::INFINITY;
        let mut hit = None;
        stack.clear();
        stack.push(0);
        while let Some(n) = stack.pop() {
            if self.box_distance2(n, q) >= best2 {
                continue;
            }
            let c0 = self.child[n * 2];
            let c1 = self.child[n * 2 + 1];
            if c0 < 0 {
                let start = (-1_i64 - i64::from(c0)) as usize;
                for &t in &self.order[start..start + c1 as usize] {
                    let (mut candidate, d2) = closest_on_tri(self.triangles, t as usize * 9, q);
                    if d2 < best2 {
                        best2 = d2;
                        candidate.triangle = self.tri_prim[t as usize] as usize;
                        hit = Some(candidate);
                    }
                }
            } else {
                let c0 = c0 as usize;
                let c1 = c1 as usize;
                let d0 = self.box_distance2(c0, q);
                let d1 = self.box_distance2(c1, q);
                if d0 < d1 {
                    stack.push(c1);
                    stack.push(c0);
                } else {
                    stack.push(c0);
                    stack.push(c1);
                }
            }
        }
        // TriSurface recomputes barycentrics in the selected triangle list's
        // corner order, which may differ from the BVH's triangulation order.
        hit.map(|mut h| {
            let o = h.triangle * 9;
            let a = triple(self.corners, o);
            let v0 = sub(triple(self.corners, o + 3), a);
            let v1 = sub(triple(self.corners, o + 6), a);
            let v2 = sub(h.point, a);
            let d00 = dot(v0, v0);
            let d01 = dot(v0, v1);
            let d11 = dot(v1, v1);
            let d20 = dot(v2, v0);
            let d21 = dot(v2, v1);
            let den = d00 * d11 - d01 * d01;
            if den.abs() > 1e-30 {
                let mut b1 = (d11 * d20 - d01 * d21) / den;
                let mut b2 = (d00 * d21 - d01 * d20) / den;
                if b1 < 0.0 {
                    b1 = 0.0;
                }
                if b2 < 0.0 {
                    b2 = 0.0;
                }
                let mut b0 = 1.0 - b1 - b2;
                if b0 < 0.0 {
                    let s = b1 + b2;
                    b1 /= s;
                    b2 /= s;
                    b0 = 0.0;
                }
                h.bary = [b0, b1, b2];
            }
            h
        })
    }
}

fn triple(a: &[f64], o: usize) -> [f64; 3] {
    [a[o], a[o + 1], a[o + 2]]
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Ericson's closest-triangle regions, with the TS branch and expression order.
fn closest_on_tri(t: &[f64], o: usize, p: [f64; 3]) -> (Hit, f64) {
    let a = triple(t, o);
    let b = triple(t, o + 3);
    let c = triple(t, o + 6);
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(p, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    let bary = if d1 <= 0.0 && d2 <= 0.0 {
        [1.0, 0.0, 0.0]
    } else {
        let bp = sub(p, b);
        let d3 = dot(ab, bp);
        let d4 = dot(ac, bp);
        if d3 >= 0.0 && d4 <= d3 {
            [0.0, 1.0, 0.0]
        } else {
            let vc = d1 * d4 - d3 * d2;
            if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
                let t = d1 / (d1 - d3);
                [1.0 - t, t, 0.0]
            } else {
                let cp = sub(p, c);
                let d5 = dot(ab, cp);
                let d6 = dot(ac, cp);
                if d6 >= 0.0 && d5 <= d6 {
                    [0.0, 0.0, 1.0]
                } else {
                    let vb = d5 * d2 - d1 * d6;
                    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
                        let t = d2 / (d2 - d6);
                        [1.0 - t, 0.0, t]
                    } else {
                        let va = d3 * d6 - d5 * d4;
                        if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
                            let t = (d4 - d3) / (d4 - d3 + (d5 - d6));
                            [0.0, 1.0 - t, t]
                        } else {
                            let den = 1.0 / (va + vb + vc);
                            let v = vb * den;
                            let w = vc * den;
                            [1.0 - v - w, v, w]
                        }
                    }
                }
            }
        }
    };
    let mut point = [0.0; 3];
    for k in 0..3 {
        point[k] = a[k] * bary[0] + b[k] * bary[1] + c[k] * bary[2];
    }
    let d = sub(point, p);
    (
        Hit {
            point,
            bary,
            triangle: 0,
        },
        dot(d, d),
    )
}

fn spacing(p: Params, cw: &[f64], h: Hit) -> f64 {
    if p.radius > 0.0 {
        return p.radius;
    }
    if !p.weighted || cw.is_empty() {
        return p.d_bar;
    }
    let o = h.triangle * 3;
    let mut weight = 0.0;
    weight += h.bary[0] * cw[o];
    weight += h.bary[1] * cw[o + 1];
    weight += h.bary[2] * cw[o + 2];
    let s = if weight > 0.0 {
        p.d_bar * (p.w_mean / weight).sqrt()
    } else {
        4.0 * p.d_bar
    };
    s.max(0.25 * p.d_bar).min(4.0 * p.d_bar)
}

fn hash32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846ca68b);
    x ^ (x >> 16)
}

// Coincident candidates use the same normalized hash-bit direction in TS and
// Rust. This degeneracy-only variant replaces host sin/cos, whose final bits can
// differ across engines and native libm implementations.
fn pair_direction(i: usize, j: usize) -> [f64; 3] {
    let h = hash32(
        (i.min(j) as u32)
            .wrapping_mul(7919)
            .wrapping_add(i.max(j) as u32),
    );
    let mut x = f64::from(h & 65535) / 32768.0 - 1.0;
    let mut z = f64::from(h >> 16) / 32768.0 - 1.0;
    if x == 0.0 && z == 0.0 {
        x = 1.0;
    }
    let norm = hypot3(x, 0.0, z);
    x /= norm;
    z /= norm;
    if i > j { [-x, 0.0, -z] } else { [x, 0.0, z] }
}

/// Repulsion and closest-surface projection for all iterations. Empty `cw` means
/// no corner density weights. Inputs are unchanged, and an empty surface leaves
/// the candidate's position, spacing and provenance unchanged.
pub fn relax(
    positions: &[f64],
    initial_spacing: &[f64],
    triangles: &[i32],
    barycentrics: &[f64],
    surface: Surface<'_>,
    cw: &[f64],
    p: Params,
) -> Result<Relaxed, String> {
    let n = initial_spacing.len();
    if n > MAX_POINTS
        || positions.len() != n * 3
        || triangles.len() != n
        || barycentrics.len() != n * 3
        || !finite_bounded(positions, MAX_COORD)
        || !finite_bounded(initial_spacing, MAX_COORD)
        || initial_spacing.iter().any(|&s| s < 0.0)
        || !finite_bounded(barycentrics, MAX_COORD)
    {
        return Err("scatter_relax: invalid point arrays or spacing".into());
    }
    surface.validate()?;
    if (!cw.is_empty() && cw.len() != surface.corners.len() / 3)
        || !finite_bounded(cw, MAX_COORD)
        || cw.iter().any(|&w| w < 0.0)
        || !finite_bounded(&[p.radius, p.d_bar, p.w_mean], MAX_COORD)
        || p.radius < 0.0
        || p.d_bar < 0.0
        || p.w_mean < 0.0
        || p.iterations > 1024
    {
        return Err("scatter_relax: invalid density weights or parameters".into());
    }
    let mut out = Relaxed {
        positions: positions.to_vec(),
        spacing: initial_spacing.to_vec(),
        triangles: triangles.to_vec(),
        barycentrics: barycentrics.to_vec(),
    };
    if n < 2 || p.iterations == 0 || surface.order.is_empty() {
        return Ok(out);
    }
    let mut next_p = out.positions.clone();
    let mut next_s = out.spacing.clone();
    let mut neighbours = Vec::with_capacity(64);
    let mut stack = Vec::with_capacity(128);
    for _ in 0..p.iterations {
        let smax = out.spacing.iter().copied().fold(0.0, f64::max);
        if smax <= 0.0 {
            break;
        }
        let kd = KdTree::new(&out.positions)?;
        for i in 0..n {
            let q = triple(&out.positions, i * 3);
            let si = out.spacing[i];
            let mut d = [0.0; 3];
            if si > 0.0 {
                kd.neighbours(q, (si + smax) / 2.0, &mut neighbours);
                for neighbour in &neighbours {
                    let j = neighbour.index;
                    if j == i {
                        continue;
                    }
                    let rest = (si + out.spacing[j]) / 2.0;
                    let mut e = sub(q, triple(&out.positions, j * 3));
                    let distance = hypot3(e[0], e[1], e[2]);
                    if distance >= rest {
                        continue;
                    }
                    let push = if distance < 1e-12 {
                        e = pair_direction(i, j);
                        rest * 0.5
                    } else {
                        (rest - distance) * 0.5 / distance
                    };
                    for k in 0..3 {
                        d[k] += e[k] * push;
                    }
                }
                let len = hypot3(d[0], d[1], d[2]);
                let cap = 0.5 * si;
                if len > cap {
                    let scale = cap / len;
                    for value in &mut d {
                        *value *= scale;
                    }
                }
            }
            if let Some(hit) = surface.closest([q[0] + d[0], q[1] + d[1], q[2] + d[2]], &mut stack)
            {
                next_p[i * 3..i * 3 + 3].copy_from_slice(&hit.point);
                next_s[i] = spacing(p, cw, hit);
                out.triangles[i] = hit.triangle as i32;
                out.barycentrics[i * 3..i * 3 + 3].copy_from_slice(&hit.bary);
            } else {
                next_p[i * 3..i * 3 + 3].copy_from_slice(&q);
                next_s[i] = si;
            }
        }
        std::mem::swap(&mut out.positions, &mut next_p);
        std::mem::swap(&mut out.spacing, &mut next_s);
    }
    if !finite_bounded(&out.positions, f64::MAX)
        || !finite_bounded(&out.spacing, f64::MAX)
        || !finite_bounded(&out.barycentrics, f64::MAX)
    {
        return Err("scatter_relax: non-finite relaxation result".into());
    }
    Ok(out)
}

#[cfg(target_arch = "wasm32")]
mod binding {
    use super::{Params, Surface, relax};
    use js_sys::{Float64Array, Int32Array, Object, Reflect};
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub fn scatter_relax(
        positions: &[f64],
        spacing: &[f64],
        triangles: &[i32],
        barycentrics: &[f64],
        t: &[f64],
        nodes: &[f64],
        child: &[i32],
        order: &[i32],
        tri_prim: &[u32],
        corners: &[f64],
        cw: &[f64],
        iterations: usize,
        options: JsValue,
    ) -> Result<Object, JsValue> {
        if options.is_null() || !options.is_object() {
            return Err(JsValue::from_str("scatter_relax options must be an object"));
        }
        let number = |name: &str, default: f64| -> Result<f64, JsValue> {
            let v = Reflect::get(&options, &JsValue::from_str(name))?;
            if v.is_undefined() {
                return Ok(default);
            }
            v.as_f64()
                .ok_or_else(|| JsValue::from_str(&format!("scatter_relax {name} must be a number")))
        };
        let weighted = Reflect::get(&options, &JsValue::from_str("weighted"))?;
        let weighted = if weighted.is_undefined() {
            false
        } else {
            weighted
                .as_bool()
                .ok_or_else(|| JsValue::from_str("scatter_relax weighted must be boolean"))?
        };
        let params = Params {
            radius: number("radius", 0.0)?,
            d_bar: number("d_bar", 0.0)?,
            w_mean: number("w_mean", 1.0)?,
            weighted,
            iterations,
        };
        let surface = Surface {
            triangles: t,
            nodes,
            child,
            order,
            tri_prim,
            corners,
        };
        let r = relax(
            positions,
            spacing,
            triangles,
            barycentrics,
            surface,
            cw,
            params,
        )
        .map_err(|e| JsValue::from_str(&e))?;
        let result = Object::new();
        for (key, value) in [
            ("positions", &r.positions),
            ("spacing", &r.spacing),
            ("barycentrics", &r.barycentrics),
        ] {
            Reflect::set(
                &result,
                &JsValue::from_str(key),
                &Float64Array::from(value.as_slice()),
            )?;
        }
        Reflect::set(
            &result,
            &JsValue::from_str("triangles"),
            &Int32Array::from(r.triangles.as_slice()),
        )?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CORNERS: [f64; 9] = [0.0, 0.0, 0.0, 8.0, 0.0, 0.0, 0.0, 0.0, 8.0];
    const NODES: [f64; 6] = [0.0, 0.0, 0.0, 8.0, 0.0, 8.0];

    fn surface() -> Surface<'static> {
        Surface {
            triangles: &CORNERS,
            nodes: &NODES,
            child: &[-1, 1],
            order: &[0],
            tri_prim: &[0],
            corners: &CORNERS,
        }
    }

    fn params() -> Params {
        Params {
            radius: 0.5,
            weighted: false,
            d_bar: 0.5,
            w_mean: 1.0,
            iterations: 1,
        }
    }

    #[test]
    fn projection_regions_and_original_corner_order() {
        let mut stack = Vec::new();
        for (q, expected) in [
            ([2.0, 1.0, 2.0], [2.0, 0.0, 2.0]),
            ([-1.0, 1.0, -1.0], [0.0, 0.0, 0.0]),
            ([9.0, 0.0, 0.0], [8.0, 0.0, 0.0]),
            ([0.0, 0.0, 9.0], [0.0, 0.0, 8.0]),
            ([2.0, 1.0, -1.0], [2.0, 0.0, 0.0]),
            ([-1.0, 1.0, 2.0], [0.0, 0.0, 2.0]),
            ([5.0, 1.0, 5.0], [4.0, 0.0, 4.0]),
        ] {
            let h = surface().closest(q, &mut stack).unwrap();
            assert_eq!(h.point, expected);
            assert_eq!(h.bary.iter().sum::<f64>(), 1.0);
        }
        let reversed = [0.0, 0.0, 8.0, 8.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let s = Surface {
            corners: &reversed,
            ..surface()
        };
        let h = s.closest([2.0, 1.0, 2.0], &mut stack).unwrap();
        assert_eq!(h.bary, [0.25, 0.25, 0.5]);
    }

    #[test]
    fn repulsion_is_deterministic_capped_and_stays_on_surface() {
        for seed in 1_u32..20 {
            let n = 64;
            let mut state = seed;
            let mut positions = Vec::with_capacity(n * 3);
            for _ in 0..n {
                state = hash32(state);
                let x = f64::from(state) / f64::from(u32::MAX) * 3.0 + 0.5;
                state = hash32(state);
                let z = f64::from(state) / f64::from(u32::MAX) * 3.0 + 0.5;
                positions.extend_from_slice(&[x, 0.0, z]);
            }
            let spacing = vec![0.5; n];
            let triangles = vec![0; n];
            let bary = vec![0.0; n * 3];
            let run = || {
                relax(
                    &positions,
                    &spacing,
                    &triangles,
                    &bary,
                    surface(),
                    &[],
                    params(),
                )
                .unwrap()
            };
            let a = run();
            assert_eq!(a, run());
            for i in 0..n {
                let p = triple(&a.positions, i * 3);
                let d = sub(p, triple(&positions, i * 3));
                assert!(hypot3(d[0], d[1], d[2]) <= 0.25 + 1e-14);
                assert_eq!(p[1], 0.0);
                assert!(p[0] >= 0.0 && p[2] >= 0.0 && p[0] + p[2] <= 8.0 + 1e-14);
            }
        }
    }

    #[test]
    fn coincident_pair_and_density_are_finite() {
        let positions = [2.0, 0.0, 2.0, 2.0, 0.0, 2.0];
        let p = Params {
            radius: 0.0,
            weighted: true,
            iterations: 3,
            ..params()
        };
        let run = || {
            relax(
                &positions,
                &[0.5, 0.5],
                &[0, 0],
                &[0.5; 6],
                surface(),
                &[0.0, 1.0, 3.0],
                p,
            )
            .unwrap()
        };
        let r = run();
        assert_eq!(r, run());
        assert_ne!(&r.positions[0..3], &r.positions[3..6]);
        assert!(r.spacing.iter().all(|s| (0.125..=2.0).contains(s)));
        let h = Hit {
            triangle: 0,
            bary: [1.0, 0.0, 0.0],
            ..Hit::default()
        };
        assert_eq!(spacing(p, &[0.0; 3], h), 2.0);
        assert_eq!(spacing(p, &[1e10; 3], h), 0.125);
    }

    #[test]
    fn empty_surface_and_zero_iterations_preserve_inputs() {
        let positions = [2.0, 0.0, 2.0, 2.1, 0.0, 2.0];
        let expected = Relaxed {
            positions: positions.to_vec(),
            spacing: vec![0.5; 2],
            triangles: vec![0; 2],
            barycentrics: vec![0.5; 6],
        };
        let empty = Surface {
            triangles: &[],
            nodes: &[],
            child: &[],
            order: &[],
            tri_prim: &[],
            corners: &[],
        };
        for (surface, p) in [
            (empty, params()),
            (
                surface(),
                Params {
                    iterations: 0,
                    ..params()
                },
            ),
        ] {
            assert_eq!(
                relax(&positions, &[0.5; 2], &[0; 2], &[0.5; 6], surface, &[], p).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn malformed_and_hostile_inputs_return_errors() {
        let positions = [1.0; 6];
        let run = |s, p| relax(&positions, &[0.5; 2], &[0; 2], &[0.5; 6], s, &[], p);
        assert!(
            run(
                Surface {
                    child: &[0, 0],
                    ..surface()
                },
                params()
            )
            .is_err()
        );
        assert!(
            run(
                Surface {
                    child: &[i32::MIN, i32::MAX],
                    ..surface()
                },
                params()
            )
            .is_err()
        );
        assert!(
            run(
                Surface {
                    order: &[1],
                    ..surface()
                },
                params()
            )
            .is_err()
        );
        assert!(
            run(
                Surface {
                    tri_prim: &[u32::MAX],
                    ..surface()
                },
                params()
            )
            .is_err()
        );
        assert!(
            run(
                surface(),
                Params {
                    iterations: usize::MAX,
                    ..params()
                }
            )
            .is_err()
        );
        for invalid in [f64::NAN, f64::INFINITY, f64::MAX, -1.0] {
            assert!(
                run(
                    surface(),
                    Params {
                        radius: invalid,
                        ..params()
                    }
                )
                .is_err()
            );
        }
        assert!(
            relax(
                &[f64::NAN; 6],
                &[0.5; 2],
                &[0; 2],
                &[0.5; 6],
                surface(),
                &[],
                params()
            )
            .is_err()
        );
        assert!(
            relax(
                &positions,
                &[0.5; 2],
                &[0; 2],
                &[0.5; 6],
                surface(),
                &[0.5],
                params()
            )
            .is_err()
        );
        assert!(
            relax(
                &positions[..3],
                &[0.5; 2],
                &[0; 2],
                &[0.5; 6],
                surface(),
                &[],
                params()
            )
            .is_err()
        );
    }
}
