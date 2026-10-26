// Scene empties: transforms that export as meshless scene nodes (attachment sockets such as a muzzle or a magazine
// well), carried as isolated points with a reserved marker so they never become visible geometry.
//
// Contract (point attributes of an isolated point):
//   scene_empty  int 1         marks the point as an empty (absent or 0: an ordinary loose point, exported as POINTS)
//   name         string        the scene node's name
//   parent       string        "" = scene root; else the name of another empty or of a mesh (prim "name") it hangs under
//   P            float[3]      translation in geometry (model) space
//   orient       float[4]      rotation in geometry space, quaternion (x, y, z, w)
//   scale        float[3]      scale
// The transform is absolute (geometry space), so transform nodes move empties with the mesh; exporters derive the
// local transform relative to the parent. Other point attributes whose value differs from their default travel as
// node extras (glTF), e.g. a socket's "forward" direction.
import type { Geometry } from './geometry.ts';
import { Geometry as Geo, defaultValueFor } from './geometry.ts';
import type { Quat, Vec3 } from './math.ts';

export const EMPTY_ATTRIB = 'scene_empty';
export const PARENT_ATTRIB = 'parent';
/** Point attributes the empty contract owns (not written as extras). */
export const EMPTY_RESERVED = new Set(['P', 'orient', 'scale', 'name', PARENT_ATTRIB, EMPTY_ATTRIB, 'pscale', 'path']);

export interface SceneEmpty {
  point: number;
  name: string;
  parent: string;
  P: Vec3;
  orient: Quat;
  scale: Vec3;
  /** other point attributes that differ from their defaults */
  extras: Record<string, number | number[] | string>;
}

/** Points marked scene_empty = 1. Throws when a marked point is used by a primitive (it would be drawn). */
export function sceneEmpties(g: Geometry): SceneEmpty[] {
  const m = g.points.get(EMPTY_ATTRIB);
  if (!m || m.type !== 'int' || m.size !== 1) return [];
  const flag = m.data as Int32Array;
  let any = false;
  for (let i = 0; i < g.numPoints; i++) if (flag[i]) { any = true; break; }
  if (!any) return [];
  const used = new Uint8Array(g.numPoints);
  for (let v = 0; v < g.numVertices; v++) used[g.vertexPoint[v]] = 1;
  const str = (n: string, i: number) => { const a = g.points.get(n); return a && a.type === 'string' ? String(a.get(i) ?? '') : ''; };
  const vec = (n: string, i: number, size: number, def: number[]) => {
    const a = g.points.get(n);
    if (!a || a.type !== 'float' || a.size !== size) return def.slice();
    return Array.from((a.data as Float64Array).subarray(i * size, i * size + size));
  };
  const out: SceneEmpty[] = [];
  for (let i = 0; i < g.numPoints; i++) {
    if (!flag[i]) continue;
    if (used[i]) throw new Error(`scene empty: point ${i} ("${str('name', i)}") is marked ${EMPTY_ATTRIB} but used by a primitive; empties must be isolated points`);
    const extras: SceneEmpty['extras'] = {};
    for (const [k, a] of g.points.map) {
      if (EMPTY_RESERVED.has(k) || a.isArray) continue;
      const v = a.get(i), d = a.def;
      if (a.type === 'string') { if (v !== '' && v !== d) extras[k] = v as string; continue; }
      const arr = Array.isArray(v) ? (v as number[]) : [v as number];
      if (!arr.every(Number.isFinite)) continue;
      const def = Array.isArray(d) ? (d as number[]) : [];
      if (arr.every((x, c) => x === (def[c] ?? 0))) continue;
      extras[k] = arr.length === 1 ? arr[0] : arr;
    }
    const q = vec('orient', i, 4, [0, 0, 0, 1]), ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    out.push({
      point: i, name: str('name', i), parent: str(PARENT_ATTRIB, i), P: [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]],
      orient: [q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql], scale: vec('scale', i, 3, [1, 1, 1]) as Vec3, extras,
    });
  }
  return out;
}

/** A geometry holding one empty (merge it with the rest). */
export function emptyGeometry(name: string, parent: string, P: Vec3, orient: Quat, scale: Vec3): Geometry {
  const g = new Geo({ positions: P });
  g.points.add(EMPTY_ATTRIB, 'int', 1).set(0, 1);
  g.points.add('name', 'string', 1).set(0, name);
  g.points.add(PARENT_ATTRIB, 'string', 1).set(0, parent);
  g.points.add('orient', 'float', 4, defaultValueFor('orient', 4, 'float')).set(0, orient);
  g.points.add('scale', 'float', 3, defaultValueFor('scale', 3, 'float')).set(0, scale);
  return g;
}
