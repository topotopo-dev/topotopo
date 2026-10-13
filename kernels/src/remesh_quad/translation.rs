//! Remove avoidable integer translation curl before taking the mesh quotient.
//!
//! Local position smoothing can leave a one-cell dislocation despite a smooth
//! orientation field. Route each integer unit through the triangle dual graph
//! to an opposite unit or a cross-field singularity. Hard edges and open
//! boundaries are barriers. Refit the continuous origins to the corrected offsets,
//! then select the equivalent origin nearest each surface sample.
use super::{
    Edge, Face, NONE, Vertex, add, cross, dot, mul, nearby, norm, pair, sub, tangent, transport,
};
use std::collections::BTreeSet;

type I2 = [i32; 2];
const MAX_LABEL: f64 = (i32::MAX / 32) as f64;
const MAX_VISITS: usize = 8_000_000;
const MAX_PATH: usize = 4096;
const MAX_UNITS_PER_FACE: usize = 32;
const REFIT_ROUNDS: usize = 128;

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct TranslationRepair {
    pub defects_before: usize,
    pub defects_after: usize,
    pub routed_units: usize,
    pub visited_states: usize,
    pub limited: bool,
}

#[derive(Clone, Copy, Default)]
struct Incidence {
    edge: usize,
    /// Rotation taking this edge's canonical translation into the face frame.
    rotation: i32,
}

fn overflow() -> String {
    "remesh_quad: integer translation correction exceeds its safe range; increase target_length"
        .into()
}

fn plus(a: I2, b: I2) -> Result<I2, String> {
    Ok([
        a[0].checked_add(b[0]).ok_or_else(overflow)?,
        a[1].checked_add(b[1]).ok_or_else(overflow)?,
    ])
}

fn rotate(v: I2, r: i32) -> Result<I2, String> {
    Ok(match r.rem_euclid(4) {
        0 => v,
        1 => [v[1].checked_neg().ok_or_else(overflow)?, v[0]],
        2 => [
            v[0].checked_neg().ok_or_else(overflow)?,
            v[1].checked_neg().ok_or_else(overflow)?,
        ],
        _ => [v[1], v[0].checked_neg().ok_or_else(overflow)?],
    })
}

fn unit_direction(direction: usize) -> I2 {
    match direction {
        0 => [1, 0],
        1 => [0, 1],
        2 => [-1, 0],
        _ => [0, -1],
    }
}

fn coefficient(incidence: &[Incidence; 3], edge: usize) -> Result<i32, String> {
    incidence
        .iter()
        .find(|i| i.edge == edge)
        .map(|i| i.rotation)
        .ok_or_else(|| {
            "remesh_quad: inconsistent face-edge incidence during translation repair".into()
        })
}

/// `mesh_edges` is the canonical sorted edge list of the live triangles.
pub(super) fn repair(
    vertices: &mut [Vertex],
    faces: &[Face],
    mesh_edges: &[Edge],
    hard: &BTreeSet<(usize, usize)>,
    h: f64,
) -> Result<TranslationRepair, String> {
    let mut profile = crate::erosion_profile::Profile::new("remesh_quad_translation");
    let state_count = faces
        .len()
        .checked_mul(4)
        .filter(|&n| n < u32::MAX as usize)
        .ok_or_else(|| "remesh_quad: translation repair exceeds its face budget".to_string())?;
    let mut translations = Vec::with_capacity(mesh_edges.len());
    let mut turns = Vec::with_capacity(mesh_edges.len());
    let blocked: Vec<_> = mesh_edges
        .iter()
        .map(|e| hard.contains(&(e.a, e.b)))
        .collect();
    for e in mesh_edges {
        let a = &vertices[e.a];
        let b = &vertices[e.b];
        let d = sub(b.q, a.q);
        let values = [dot(d, a.u) / h, dot(d, cross(a.n, a.u)) / h];
        if values.iter().any(|v| !v.is_finite() || v.abs() > MAX_LABEL) {
            return Err("remesh_quad: a constrained edge spans too many field cells; increase target_length or subdivide the locked border".into());
        }
        translations.push(values.map(|v| libm::round(v) as i32));
        let u = transport(b.u, b.n, a.n);
        turns.push(libm::round(
            libm::atan2(dot(u, cross(a.n, a.u)), dot(u, a.u)) / std::f64::consts::FRAC_PI_2,
        ) as i32);
    }
    let mut incidences = vec![[Incidence::default(); 3]; faces.len()];
    let mut sink = vec![false; faces.len()];
    let mut charge = vec![[0, 0]; faces.len()];
    for (f, face) in faces.iter().enumerate().filter(|(_, f)| f.alive) {
        let mut frame = 0;
        for (k, incidence) in incidences[f].iter_mut().enumerate() {
            let a = face.v[k];
            let b = face.v[(k + 1) % 3];
            let edge = mesh_edges
                .binary_search_by_key(&pair(a, b), |e| (e.a, e.b))
                .map_err(|_| {
                    "remesh_quad: missing triangle edge during translation repair".to_string()
                })?;
            let rotation = if a < b {
                frame
            } else {
                frame - turns[edge] + 2
            };
            *incidence = Incidence { edge, rotation };
            charge[f] = plus(charge[f], rotate(translations[edge], rotation)?)?;
            frame += if a < b { turns[edge] } else { -turns[edge] };
        }
        sink[f] |= frame.rem_euclid(4) != 0;
    }
    let count_defects = |charge: &[I2]| {
        charge
            .iter()
            .enumerate()
            .filter(|&(f, q)| faces[f].alive && !sink[f] && *q != [0, 0])
            .count()
    };
    let mut report = TranslationRepair {
        defects_before: count_defects(&charge),
        ..TranslationRepair::default()
    };
    profile.mark("setup");
    if report.defects_before == 0 {
        profile.finish();
        return Ok(report);
    }

    // Cache dual adjacency and frame turns once instead of resolving the
    // neighbouring incidence for every state visited by every cancellation.
    let mut dual = vec![[(NONE, 0usize); 3]; faces.len()];
    for (f, entries) in incidences.iter().enumerate() {
        for (k, &Incidence { edge, rotation }) in entries.iter().enumerate() {
            if !faces[f].alive {
                continue;
            }
            let e = &mesh_edges[edge];
            if blocked[edge] || e.g == NONE {
                continue;
            }
            let g = if e.f == f { e.g } else { e.f };
            let turn = (coefficient(&incidences[g], edge)? - rotation + 2).rem_euclid(4) as usize;
            dual[f][k] = (g, turn);
        }
    }
    // Generation stamps avoid clearing O(faces) storage for every routed unit.
    let mut previous = vec![u32::MAX; state_count];
    let mut used_edge = vec![u32::MAX; state_count];
    let mut stamp = vec![0_u32; state_count];
    let mut generation = 0_u32;
    let mut queue = Vec::with_capacity(state_count.min(65536));
    let mut path = Vec::new();
    'sources: for source in 0..faces.len() {
        if sink[source] || !faces[source].alive {
            continue;
        }
        for _ in 0..MAX_UNITS_PER_FACE {
            let q = charge[source];
            if q == [0, 0] {
                break;
            }
            let direction = if q[0] > 0 {
                0
            } else if q[0] < 0 {
                2
            } else if q[1] > 0 {
                1
            } else {
                3
            };
            let start = source * 4 + direction;
            generation = generation.checked_add(1).ok_or_else(overflow)?;
            queue.clear();
            queue.push(start);
            let mut head = 0;
            previous[start] = start as u32;
            stamp[start] = generation;
            let mut target = NONE;
            while head < queue.len() {
                let state = queue[head];
                head += 1;
                report.visited_states += 1;
                if report.visited_states > MAX_VISITS {
                    report.limited = true;
                    break 'sources;
                }
                let f = state / 4;
                let direction = state % 4;
                for (k, &(g, turn)) in dual[f].iter().enumerate() {
                    if g == NONE {
                        continue;
                    }
                    let edge = incidences[f][k].edge;
                    let dir = (direction + turn) & 3;
                    let next = g * 4 + dir;
                    if stamp[next] == generation {
                        continue;
                    }
                    stamp[next] = generation;
                    previous[next] = state as u32;
                    used_edge[next] = edge as u32;
                    let cancels = match dir {
                        0 => charge[g][0] < 0,
                        1 => charge[g][1] < 0,
                        2 => charge[g][0] > 0,
                        _ => charge[g][1] > 0,
                    };
                    if g != source && (sink[g] || cancels) {
                        target = next;
                        break;
                    }
                    queue.push(next);
                }
                if target != NONE {
                    break;
                }
            }
            if target == NONE {
                break;
            }
            path.clear();
            let mut state = target;
            while state != start {
                if path.len() >= MAX_PATH {
                    report.limited = true;
                    break 'sources;
                }
                let from = previous[state] as usize;
                path.push((from, state, used_edge[state] as usize));
                state = from;
            }
            for &(from, to, edge) in path.iter().rev() {
                let f = from / 4;
                let g = to / 4;
                let cf = coefficient(&incidences[f], edge)?;
                let cg = coefficient(&incidences[g], edge)?;
                let delta = rotate(unit_direction(from % 4), 2 - cf)?;
                translations[edge] = plus(translations[edge], delta)?;
                charge[f] = plus(charge[f], rotate(delta, cf)?)?;
                charge[g] = plus(charge[g], rotate(delta, cg)?)?;
            }
            report.routed_units += 1;
        }
    }
    profile.mark("routing");
    report.defects_after = count_defects(&charge);
    report.limited |= report.defects_after != 0;
    // A partly repaired transition system can move defects onto unrelated
    // patches during the refit. Keep the original continuous field unless the
    // entire attempted correction is consistent away from orientation poles.
    // No vertex origins have been modified yet, so this is a transactional no-op.
    if report.routed_units == 0 || report.defects_after != 0 {
        profile.finish();
        return Ok(report);
    }

    let mut offsets = vec![0usize; vertices.len() + 1];
    for e in mesh_edges {
        offsets[e.a + 1] += 1;
        offsets[e.b + 1] += 1;
    }
    for i in 1..offsets.len() {
        offsets[i] += offsets[i - 1];
    }
    let mut cursor = offsets.clone();
    let mut adjacent = vec![(0usize, [0.; 3]); mesh_edges.len() * 2];
    for (i, e) in mesh_edges.iter().enumerate() {
        let a = &vertices[e.a];
        let b = &vertices[e.b];
        let ta = translations[i];
        let tb = rotate(ta, -turns[i])?;
        let da = add(
            mul(a.u, f64::from(ta[0])),
            mul(cross(a.n, a.u), f64::from(ta[1])),
        );
        let db = add(
            mul(b.u, f64::from(tb[0])),
            mul(cross(b.n, b.u), f64::from(tb[1])),
        );
        let d = mul(add(da, db), h * 0.5);
        adjacent[cursor[e.a]] = (e.b, mul(d, -1.0));
        cursor[e.a] += 1;
        adjacent[cursor[e.b]] = (e.a, d);
        cursor[e.b] += 1;
    }
    let mut origins: Vec<_> = vertices.iter().map(|v| v.q).collect();
    let curved: Vec<_> = vertices
        .iter()
        .map(|v| v.position_constraint && norm(v.curve) > 0.0)
        .collect();
    for round in 0..REFIT_ROUNDS {
        let mut max_change: f64 = 0.0;
        for i in 0..vertices.len() {
            let ns = &adjacent[offsets[i]..offsets[i + 1]];
            if (vertices[i].fixed && vertices[i].position_constraint) || ns.is_empty() {
                continue;
            }
            let mut q = [0.0; 3];
            for &(j, d) in ns {
                q = add(q, add(origins[j], d));
            }
            q = mul(q, 1.0 / ns.len() as f64);
            let v = &vertices[i];
            q = add(v.p, tangent(sub(q, v.p), v.n));
            if curved[i] {
                q = add(v.p, mul(v.curve, dot(sub(q, v.p), v.curve)));
            }
            if q.iter().any(|x| !x.is_finite()) {
                return Err(
                    "remesh_quad: translation field refit became non-finite; rescale the input"
                        .into(),
                );
            }
            let change = sub(q, origins[i]);
            max_change = max_change.max(dot(change, change));
            origins[i] = q;
        }
        if round >= 8 && max_change < h * h * 1e-10 {
            break;
        }
    }
    for (v, q) in vertices.iter_mut().zip(origins) {
        if !v.fixed || !v.position_constraint {
            v.q = nearby(q, v.p, v.u, v.n, h);
        }
    }
    profile.mark("refit");
    profile.finish();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square() -> (Vec<Vertex>, Vec<Face>, Vec<Edge>) {
        let vertices = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, -1.0],
            [0.0, 0.0, -1.0],
        ]
        .into_iter()
        .map(|p| Vertex {
            p,
            q: p,
            n: [0.0, 1.0, 0.0],
            u: [1.0, 0.0, 0.0],
            curve: [0.0; 3],
            direction: [0.0; 3],
            position_constraint: true,
            fixed: false,
            locked: false,
            alive: true,
        })
        .collect();
        let faces = vec![
            Face {
                v: [0, 1, 2],
                alive: true,
            },
            Face {
                v: [0, 2, 3],
                alive: true,
            },
        ];
        let edges = super::super::edges(&faces).unwrap();
        (vertices, faces, edges)
    }

    fn introduce_pair(vertices: &mut [Vertex]) {
        // Integer rounding makes the shared diagonal carry one unit, while each outer
        // half-step rounds to zero. The two triangles consequently have opposite curl.
        vertices[1].q[0] = 0.4;
        vertices[2].q[0] = 0.8;
        vertices[3].q[0] = 0.4;
    }

    #[test]
    fn checked_integer_rotation_and_addition_do_not_wrap() {
        for turn in -8..=8 {
            assert_eq!(
                rotate(rotate([23, -17], turn).unwrap(), -turn).unwrap(),
                [23, -17]
            );
        }
        assert_eq!(plus([5, -7], [-2, 3]).unwrap(), [3, -4]);
        assert!(plus([i32::MAX, 0], [1, 0]).is_err());
        assert!(plus([0, i32::MIN], [0, -1]).is_err());
        assert!(rotate([i32::MIN, 0], 2).is_err());
        assert!(rotate([0, i32::MIN], 1).is_err());
    }

    #[test]
    fn defect_free_field_is_a_bit_exact_noop_in_quarter_turn_frames() {
        let (mut vertices, faces, edges) = square();
        vertices[1].u = [0.0, 0.0, -1.0];
        vertices[2].u = [-1.0, 0.0, 0.0];
        vertices[3].u = [0.0, 0.0, 1.0];
        let before: Vec<_> = vertices.iter().map(|v| v.q.map(f64::to_bits)).collect();
        let report = repair(&mut vertices, &faces, &edges, &BTreeSet::new(), 1.0).unwrap();
        assert_eq!(report.defects_before, 0);
        assert_eq!(report.defects_after, 0);
        assert_eq!(report.routed_units, 0);
        assert!(!report.limited);
        assert_eq!(
            before,
            vertices
                .iter()
                .map(|v| v.q.map(f64::to_bits))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn paired_curl_routes_across_the_dual_edge_and_keeps_fixed_origins() {
        let (mut vertices, faces, edges) = square();
        introduce_pair(&mut vertices);
        vertices[0].fixed = true;
        let fixed = vertices[0].q.map(f64::to_bits);
        let report = repair(&mut vertices, &faces, &edges, &BTreeSet::new(), 1.0).unwrap();
        assert_eq!(report.defects_before, 2);
        assert_eq!(report.defects_after, 0);
        assert_eq!(report.routed_units, 1);
        assert!(!report.limited);
        assert_eq!(vertices[0].q.map(f64::to_bits), fixed);
        assert!(vertices.iter().all(|v| v.q.iter().all(|n| n.is_finite())));
        // Check the realized continuous field too, rather than trusting the integer report alone.
        for face in &faces {
            let charge: f64 = (0..3)
                .map(|i| libm::round(vertices[face.v[(i + 1) % 3]].q[0] - vertices[face.v[i]].q[0]))
                .sum();
            assert_eq!(charge, 0.0);
        }
    }

    #[test]
    fn a_hard_diagonal_is_a_routing_barrier_and_reports_unresolved_curl() {
        let (mut vertices, faces, edges) = square();
        introduce_pair(&mut vertices);
        let before: Vec<_> = vertices.iter().map(|v| v.q.map(f64::to_bits)).collect();
        let hard = BTreeSet::from([(0, 2)]);
        let report = repair(&mut vertices, &faces, &edges, &hard, 1.0).unwrap();
        assert_eq!(report.defects_before, 2);
        assert_eq!(report.defects_after, 2);
        assert_eq!(report.routed_units, 0);
        assert!(report.limited);
        assert_eq!(
            before,
            vertices
                .iter()
                .map(|v| v.q.map(f64::to_bits))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn disconnected_components_and_dead_faces_do_not_cross_route() {
        let (mut vertices, mut faces, _) = square();
        introduce_pair(&mut vertices);
        let (mut other, other_faces, _) = square();
        introduce_pair(&mut other);
        for v in &mut other {
            v.p[0] += 8.0;
            v.q[0] += 8.0;
        }
        vertices.extend(other);
        // A tombstone has no usable vertex indices, and must never be read as a live face.
        faces.insert(
            1,
            Face {
                v: [usize::MAX; 3],
                alive: false,
            },
        );
        faces.extend(other_faces.into_iter().map(|f| Face {
            v: f.v.map(|v| v + 4),
            alive: true,
        }));
        let edges = super::super::edges(&faces).unwrap();
        let hard = BTreeSet::from([(0, 2)]);
        let report = repair(&mut vertices, &faces, &edges, &hard, 1.0).unwrap();
        assert_eq!(report.defects_before, 4);
        assert_eq!(report.defects_after, 2);
        assert_eq!(report.routed_units, 1);
        assert!(report.limited);
        // Neither routing nor a committed refit may join disconnected components.
        assert!(vertices[..4].iter().all(|v| v.q[0] < 2.0));
        assert!(vertices[4..].iter().all(|v| v.q[0] > 7.0));
        assert!(vertices.iter().all(|v| v.q.iter().all(|n| n.is_finite())));
    }

    #[test]
    fn incomplete_global_repair_keeps_every_original_origin_bit_exact() {
        let (mut vertices, mut faces, edges) = square();
        introduce_pair(&mut vertices);
        let original: Vec<_> = vertices.iter().map(|v| v.q.map(f64::to_bits)).collect();
        // This component can be repaired and would actually change its continuous field in isolation.
        let mut isolated = vertices.clone();
        let committed = repair(&mut isolated, &faces, &edges, &BTreeSet::new(), 1.0).unwrap();
        assert!(committed.routed_units > 0);
        assert_eq!(committed.defects_after, 0);
        assert_ne!(
            original,
            isolated
                .iter()
                .map(|v| v.q.map(f64::to_bits))
                .collect::<Vec<_>>()
        );

        let (mut blocked, blocked_faces, _) = square();
        introduce_pair(&mut blocked);
        for vertex in &mut blocked {
            vertex.p[0] += 8.0;
            vertex.q[0] += 8.0;
        }
        vertices.extend(blocked);
        faces.extend(blocked_faces.into_iter().map(|face| Face {
            v: face.v.map(|index| index + 4),
            alive: true,
        }));
        let edges = super::super::edges(&faces).unwrap();
        let before: Vec<_> = vertices.iter().map(|v| v.q.map(f64::to_bits)).collect();
        let report = repair(
            &mut vertices,
            &faces,
            &edges,
            &BTreeSet::from([(4, 6)]),
            1.0,
        )
        .unwrap();
        assert!(
            report.routed_units > 0,
            "first component must make integer progress"
        );
        assert!(
            report.defects_after > 0,
            "hard barrier must leave unresolved curl"
        );
        assert!(report.limited);
        assert_eq!(
            before,
            vertices
                .iter()
                .map(|v| v.q.map(f64::to_bits))
                .collect::<Vec<_>>(),
            "partial integer progress must not mutate either component's continuous origins"
        );
    }

    #[test]
    fn out_of_range_lattice_labels_return_an_error_without_mutation() {
        let (mut vertices, faces, edges) = square();
        vertices[1].q[0] = MAX_LABEL * 2.0;
        let before: Vec<_> = vertices.iter().map(|v| v.q.map(f64::to_bits)).collect();
        let error = repair(&mut vertices, &faces, &edges, &BTreeSet::new(), 1.0).unwrap_err();
        assert!(error.contains("too many field cells"), "{error}");
        assert_eq!(
            before,
            vertices
                .iter()
                .map(|v| v.q.map(f64::to_bits))
                .collect::<Vec<_>>()
        );
    }
}
