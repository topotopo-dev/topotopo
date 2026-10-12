import { Geometry } from '../core/geometry.ts';
import type { GroupClass } from '../core/geometry.ts';
import type { EdgeSet } from '../core/edges.ts';
import { evalEdgeGroup, evalGroup, GroupError } from '../core/groups.ts';
import { pointNormals } from '../core/topology.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext, ParamDef } from '../graph/types.ts';
import type { Vec3 } from '../core/math.ts';
import { referencesTime } from '../core/wrangle.ts';
import type { WrangleTime } from '../core/wrangle.ts';

/** @Frame/@Time/@TimeInc values for a wrangle snippet, read from the context (which makes the node time-dependent) only when the code uses them. */
export function wrangleTime(ctx: CookContext, code: string): WrangleTime | undefined {
  return referencesTime(code) ? { frame: ctx.frame, time: ctx.time, timeInc: ctx.timeInc } : undefined;
}

export type PlaneName = 'xz' | 'xy' | 'yz';

/** Right-handed plane frames: U × V = N. 'xz' lies on the ground facing +Y. */
export const FRAMES: Record<PlaneName, { U: Vec3; V: Vec3; N: Vec3 }> = {
  xz: { U: [1, 0, 0], V: [0, 0, -1], N: [0, 1, 0] },
  xy: { U: [1, 0, 0], V: [0, 1, 0], N: [0, 0, 1] },
  yz: { U: [0, 1, 0], V: [0, 0, 1], N: [1, 0, 0] },
};

export const AXES: Record<string, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] };

/** Group pattern → mask (null = all). For cls 'edge' the mask runs over edgeList(g); prefer edgeMask. */
export function mask(g: Geometry, cls: GroupClass, pattern: string): Uint8Array | null {
  try {
    return evalGroup(g, cls, pattern);
  } catch (e: any) {
    if (e instanceof GroupError) throw new NodeError(e.message, groupHint(cls));
    throw e;
  }
}

/** Edge group pattern → EdgeSet ("" = every edge). */
export function edgeMask(g: Geometry, pattern: string): EdgeSet {
  try {
    return evalEdgeGroup(g, pattern);
  } catch (e: any) {
    if (e instanceof GroupError) throw new NodeError(e.message, groupHint('edge'));
    throw e;
  }
}

function groupHint(cls: GroupClass) {
  return cls === 'edge'
    ? 'edge patterns: "name", "p3-7", "p0-1-2-3-0", "boundary", "angle>30", "border:primgroup", "@P.y>0", "0-10"'
    : 'group patterns: "name", "!name", "0-10", "@P.y>0", "@class==2", "*"';
}

/** Point normals: existing point N, else vertex N averaged, else computed from faces. */
export function getPointNormals(g: Geometry): Float64Array {
  const pn = g.points.get('N');
  if (pn && pn.size === 3 && pn.type === 'float') return pn.data as Float64Array;
  const vn = g.vertices.get('N');
  if (vn && vn.size === 3) {
    const out = new Float64Array(g.numPoints * 3);
    for (let v = 0; v < g.numVertices; v++) {
      const p = g.vertexPoint[v];
      for (let c = 0; c < 3; c++) out[p * 3 + c] += (vn.data as Float64Array)[v * 3 + c];
    }
    for (let i = 0; i < out.length; i += 3) {
      const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
      out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
    }
    return out;
  }
  return pointNormals(g);
}

/** Common param definitions. */
export const P = {
  group: (cls: 'point' | 'prim' = 'prim', desc?: string): ParamDef => ({
    type: 'group', default: '', groupClass: cls,
    desc: desc ?? `${cls} group pattern to affect ("" = all). e.g. "top", "!top", "0-9", "@P.y>0"`,
  }),
  seed: (): ParamDef => ({ type: 'float', default: 0, desc: 'random seed' }),
  plane: (def: PlaneName = 'xz'): ParamDef => ({ type: 'enum', options: ['xz', 'xy', 'yz'], default: def, desc: 'orientation plane (xz = ground, facing +Y; xy = facing +Z; yz = facing +X)' }),
  center: (): ParamDef => ({ type: 'vec3', default: [0, 0, 0], desc: 'center position', aliases: ['t', 'translate', 'position', 'pos', 'origin'] }),
};

export function emptyIfNone(g: Geometry | null): Geometry {
  return g ?? new Geometry();
}

/** Build a polyline/polygon geometry from point lists. */
export function polyGeo(curves: number[][][], closed: boolean | boolean[]): Geometry {
  const pos: number[] = [];
  const prims: number[][] = [];
  for (const c of curves) {
    const ids: number[] = [];
    for (const p of c) { ids.push(pos.length / 3); pos.push(p[0], p[1], p[2]); }
    prims.push(ids);
  }
  return new Geometry({ positions: pos, prims, closed });
}

export function requirePrims(g: Geometry, node: string) {
  if (g.numPrims === 0) throw new NodeError(`${node}: input has no primitives (${g.numPoints} points)`);
}
