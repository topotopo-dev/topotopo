// Shared test fixtures: source geometry, per-node inputs and params, geometry invariants.
// Every test layer (smoke, golden, property, fuzz, bench) cooks nodes the same way through these.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { getNodeDef } from '../src/graph/registry.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { exportOBJ } from '../src/io/export.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';

/** Named source geometry. A fixture may wire other fixtures (`in`), which are pulled in automatically. */
export const SRC: Record<string, NodeSpec> = {
  MESH: { type: 'sphere', params: { type: 'ico', level: 2 } },
  BOX: { type: 'box', params: { divisions: [2, 2, 2] } },
  SMALLSPHERE: { type: 'sphere', params: { type: 'ico', level: 1, radius: 0.1 } },
  GRID: { type: 'grid', params: { size: [2, 2], divisions: [6, 6] } },
  CURVE: { type: 'curve', params: { points: [[0, 0, 0], [1, 0.5, 0.2], [2, 0, 0.5], [3, 0.4, 0]], smooth: true } },
  CIRCLE: { type: 'circle', params: { radius: 0.6, segments: 24 } },
  SHAPE: { type: 'shape2d', params: { shape: 'star', radius: 1, inner_radius: 0.5, sides: 5 } },
  PROFILE: { type: 'curve', params: { points: [[0.0, 0, 0], [0.6, 0.1, 0], [0.4, 0.8, 0], [0.5, 1.4, 0]] } },
  PROFILEXY: { type: 'circle', params: { radius: 0.1, plane: 'xy', segments: 8 } },
  PTS: { type: 'scatter', in: ['GRID'], params: { count: 60 } },
  PTS_ABOVE: { type: 'point_grid', params: { counts: [5, 1, 5], size: [1, 0, 1], center: [0, 3, 0] } },
  SDF: { type: 'sdf_shape', params: { shape: 'sphere', radius: 0.6 } },
  SDF2: { type: 'sdf_shape', params: { shape: 'box', size: [0.8, 0.8, 0.8], center: [0.5, 0, 0] } },
  LOFT: { type: 'merge', in: ['CIRCLE', 'CIRCLE_UP'] },
  CIRCLE_UP: { type: 'circle', params: { radius: 0.3, segments: 24, center: [0, 1, 0] } },
  COLORED: { type: 'color', in: ['MESH'], params: { mode: 'random' } },
};

/** Fixture inputs per node type. Nodes not listed get MESH when their first input is required, else nothing. */
export const INPUTS: Record<string, string[]> = {
  resample: ['CURVE'], carve: ['CURVE'], ends: ['CIRCLE'], sweep: ['CURVE', 'PROFILEXY'], polywire: ['CURVE'], revolve: ['PROFILE'],
  extrude: ['SHAPE'], offset_curve: ['SHAPE'], boolean2d: ['SHAPE', 'CIRCLE'], fill: ['SHAPE'], loft: ['LOFT'],
  copy_to_points: ['MESH', 'PTS'], ray: ['PTS_ABOVE', 'MESH'], attrib_copy: ['MESH', 'COLORED'], attrib_transfer: ['MESH', 'COLORED'],
  boolean: ['BOX', 'MESH'], minkowski: ['BOX', 'SMALLSPHERE'], voronoi_fracture: ['MESH'], convex_hull: ['PTS'],
  sdf_combine: ['SDF', 'SDF2'], sdf_modify: ['SDF'], sdf_to_mesh: ['SDF'], sdf_from_mesh: ['MESH'],
  triangulate2d: ['PTS'], voronoi2d: ['PTS'], merge: ['MESH', 'BOX'], switch: ['MESH', 'BOX'],
  uv_transform: ['BOX'], poly_extrude: ['BOX'], poly_bevel: ['BOX'], subdivide: ['BOX'], fill_holes: ['GRID'], clip: ['MESH'], slice: ['MESH'],
  scatter: ['MESH'], decimate: ['MESH'], remesh: ['BOX'], smooth_solid: ['BOX'], foreach: ['BOX'],
};

/** Fixture params per node type (everything else cooks with defaults). `file` is filled in by createFixtureEngine(). */
export const PARAMS: Record<string, any> = {
  wrangle: { code: '@P.y += sin(@P.x * 3) * 0.1;\n@Cd = hsv2rgb(rand(@ptnum), 0.6, 1);\nif (@ptnum == 0) { const p = addpoint(0, [0, 2, 0]); addprim(0, "polyline", [0, p]); }' },
  script: { code: "const s = await lib.run('sphere', { radius: 0.5 });\nreturn lib.merge([geo, s]);" },
  foreach: { mode: 'prims', body: { nodes: { i: { type: 'input', params: { index: 0 } }, x: { type: 'poly_extrude', in: ['i'], params: { distance: '=0.1 + iteration * 0.01' } } }, output: 'x' } },
  file: { path: 'cube.obj' },
  attrib_rename: { from: 'N', to: 'nrm' },
  attrib_promote: { name: 'N', from: 'point', to: 'prim' },
  attrib_delete: { names: 'N' },
  delete: { group: '@P.y>0' },
  poly_bevel: { group: 'angle>80', offset: 0.1, divisions: 2 },
  group: { name: 'top', expr: '@P.y > 0.2' },
  sdf_expr: { code: 'smin(sdSphere(p, 0.5), sdBox(sub(p, [0.5, 0, 0]), [0.3, 0.3, 0.3]), 0.2)' },
  copy_xform: { count: 3, translate: [1.5, 0, 0], rotate: [0, 30, 0] },
  measure: { measure: 'volume' },
  text: { text: 'Hi', depth: 0.2 },
  lsystem: { generations: 3 },
  graph_ref: null,
};

/** Node types that cannot cook standalone (subgraph input, references to workspace graphs). */
export const SKIP = new Set(['input', 'graph_ref']);

/** Node types whose output depends on the machine (system fonts), not just on the graph. */
export const ENV_DEPENDENT_TYPES = new Set(['text']);

/** Structural invariants every cooked geometry must satisfy. Returns a list of violations (empty = ok). */
export function checkGeo(g: Geometry): string[] {
  const errs: string[] = [];
  if (g.primStart.length !== g.numPrims + 1) errs.push('primStart length');
  if (g.primStart[g.numPrims] !== g.numVertices) errs.push('primStart end != numVertices');
  for (let p = 0; p < g.numPrims; p++) if (g.primStart[p + 1] < g.primStart[p]) { errs.push('primStart not monotonic'); break; }
  for (let v = 0; v < g.numVertices; v++) if (g.vertexPoint[v] < 0 || g.vertexPoint[v] >= g.numPoints) { errs.push(`vertex ${v} → bad point ${g.vertexPoint[v]}`); break; }
  for (const cls of ['point', 'vertex', 'prim', 'detail'] as const) {
    const t = g.table(cls);
    const want = cls === 'point' ? g.numPoints : cls === 'vertex' ? g.numVertices : cls === 'prim' ? g.numPrims : 1;
    if (t.count !== want) errs.push(`${cls} table count ${t.count} != ${want}`);
    for (const [k, a] of t.map) if (a.count !== want) errs.push(`${cls} attrib ${k} count ${a.count} != ${want}`);
  }
  for (const [k, m] of g.pointGroups) if (m.length !== g.numPoints) errs.push(`point group ${k} size`);
  for (const [k, m] of g.primGroups) if (m.length !== g.numPrims) errs.push(`prim group ${k} size`);
  for (let i = 0; i < g.P.length; i++) if (!Number.isFinite(g.P[i])) { errs.push('non-finite P'); break; }
  return errs;
}

/** Fixture names a node type cooks from (its INPUTS entry, else MESH for a required first input). */
export function fixtureInputsFor(type: string): string[] {
  const def = getNodeDef(type);
  if (!def) throw new Error(`unknown node type "${type}"`);
  return INPUTS[def.type] ?? (def.inputs.length && !def.inputs[0].optional ? ['MESH'] : []);
}

/** Add fixture `name` (and the fixtures it is wired to) to `nodes`, under the fixture's own name. */
export function addFixture(nodes: Record<string, NodeSpec>, name: string): void {
  if (nodes[name]) return;
  const src = SRC[name];
  if (!src) throw new Error(`unknown fixture "${name}"`);
  const s = structuredClone(src);
  nodes[name] = s;
  const deps = Array.isArray(s.in) ? s.in : [];
  for (const d of deps) if (typeof d === 'string') addFixture(nodes, d);
}

/**
 * A complete graph that cooks `nodeType` (type or alias) on its fixture inputs with its fixture params.
 * The node under test is called `target` and is the graph output.
 */
export function fixtureGraphFor(nodeType: string): GraphSpec {
  const def = getNodeDef(nodeType);
  if (!def) throw new Error(`unknown node type "${nodeType}"`);
  const ins = fixtureInputsFor(def.type);
  const nodes: Record<string, NodeSpec> = {};
  ins.forEach((k) => addFixture(nodes, k));
  nodes.target = { type: def.type, in: ins, params: structuredClone(PARAMS[def.type] ?? {}) };
  return { nodes, output: 'target' };
}

/** True when the graph (or a nested foreach body) contains a node whose output depends on the machine. */
export function graphIsEnvDependent(graph: GraphSpec): boolean {
  for (const spec of Object.values(graph.nodes ?? {})) {
    const def = getNodeDef(spec?.type);
    if (def && ENV_DEPENDENT_TYPES.has(def.type)) return true;
    for (const v of Object.values(spec?.params ?? {})) if (v && typeof v === 'object' && (v as any).nodes && graphIsEnvDependent(v as GraphSpec)) return true;
  }
  return false;
}

/**
 * An initialised engine whose host resolves relative paths in a fresh temp dir, which holds `cube.obj`
 * (the `file` node fixture). PARAMS.file.path is set to that absolute path.
 */
export async function createFixtureEngine(): Promise<{ engine: Engine; tmp: string; objPath: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polyforge-test-'));
  const engine = new Engine(createNodeHost({ baseDir: tmp }));
  await engine.init();
  const objPath = path.join(tmp, 'cube.obj');
  fs.writeFileSync(objPath, exportOBJ((await engine.cook({ nodes: { b: { type: 'box' } } })).geo!));
  PARAMS.file = { path: objPath };
  return { engine, tmp, objPath };
}

/** Repository root (works on Windows file URLs too). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
