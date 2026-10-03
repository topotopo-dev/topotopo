// Smoke test: cook every node type with sensible inputs; check geometry invariants.
//   node test/smoke.ts [filter]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { allNodeDefs } from '../src/graph/registry.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { exportOBJ } from '../src/io/export.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polyforge-smoke-'));
const engine = new Engine(createNodeHost({ baseDir: tmp }));
await engine.init();

const SRC: Record<string, NodeSpec> = {
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

const objPath = path.join(tmp, 'cube.obj');
fs.writeFileSync(objPath, exportOBJ((await engine.cook({ nodes: { b: { type: 'box' } } })).geo!));

const INPUTS: Record<string, string[]> = {
  resample: ['CURVE'], carve: ['CURVE'], ends: ['CIRCLE'], sweep: ['CURVE', 'PROFILEXY'], polywire: ['CURVE'], revolve: ['PROFILE'],
  extrude: ['SHAPE'], offset_curve: ['SHAPE'], boolean2d: ['SHAPE', 'CIRCLE'], fill: ['SHAPE'], loft: ['LOFT'],
  copy_to_points: ['MESH', 'PTS'], ray: ['PTS_ABOVE', 'MESH'], attrib_copy: ['MESH', 'COLORED'], attrib_transfer: ['MESH', 'COLORED'],
  boolean: ['BOX', 'MESH'], minkowski: ['BOX', 'SMALLSPHERE'], voronoi_fracture: ['MESH'], convex_hull: ['PTS'],
  sdf_combine: ['SDF', 'SDF2'], sdf_modify: ['SDF'], sdf_to_mesh: ['SDF'], sdf_from_mesh: ['MESH'],
  triangulate2d: ['PTS'], voronoi2d: ['PTS'], merge: ['MESH', 'BOX'], switch: ['MESH', 'BOX'],
  uv_transform: ['BOX'], poly_extrude: ['BOX'], subdivide: ['BOX'], fill_holes: ['GRID'], clip: ['MESH'], slice: ['MESH'],
  scatter: ['MESH'], decimate: ['MESH'], remesh: ['BOX'], smooth_solid: ['BOX'], foreach: ['BOX'],
};
const PARAMS: Record<string, any> = {
  wrangle: { code: '@P.y += sin(@P.x * 3) * 0.1;\n@Cd = hsv2rgb(rand(@ptnum), 0.6, 1);\nif (@ptnum == 0) { const p = addpoint(0, [0, 2, 0]); addprim(0, "polyline", [0, p]); }' },
  script: { code: "const s = await lib.run('sphere', { radius: 0.5 });\nreturn lib.merge([geo, s]);" },
  foreach: { mode: 'prims', body: { nodes: { i: { type: 'input', params: { index: 0 } }, x: { type: 'poly_extrude', in: ['i'], params: { distance: '=0.1 + iteration * 0.01' } } }, output: 'x' } },
  file: { path: objPath },
  attrib_rename: { from: 'N', to: 'nrm' },
  attrib_promote: { name: 'N', from: 'point', to: 'prim' },
  attrib_delete: { names: 'N' },
  delete: { group: '@P.y>0' },
  group: { name: 'top', expr: '@P.y > 0.2' },
  sdf_expr: { code: 'smin(sdSphere(p, 0.5), sdBox(sub(p, [0.5, 0, 0]), [0.3, 0.3, 0.3]), 0.2)' },
  copy_xform: { count: 3, translate: [1.5, 0, 0], rotate: [0, 30, 0] },
  measure: { measure: 'volume' },
  text: { text: 'Hi', depth: 0.2 },
  lsystem: { generations: 3 },
  graph_ref: null,
};
const SKIP = new Set(['input', 'graph_ref']);

function checkGeo(g: Geometry): string[] {
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

const filter = process.argv[2];
let fail = 0, pass = 0;
const rows: string[] = [];
for (const def of allNodeDefs()) {
  if (SKIP.has(def.type) || (filter && !def.type.includes(filter))) continue;
  const ins = INPUTS[def.type] ?? (def.inputs.length && !def.inputs[0].optional ? ['MESH'] : []);
  const nodes: Record<string, NodeSpec> = {};
  const add = (k: string) => {
    if (nodes[k]) return;
    const s = structuredClone(SRC[k]);
    nodes[k] = s;
    const deps = Array.isArray(s.in) ? s.in : [];
    for (const d of deps) if (typeof d === 'string') add(d);
  };
  ins.forEach(add);
  nodes.target = { type: def.type, in: ins, params: PARAMS[def.type] ?? {} };
  const graph: GraphSpec = { nodes, output: 'target' };
  const t0 = performance.now();
  let line: string;
  try {
    const r = await engine.cook(graph);
    const ms = performance.now() - t0;
    if (!r.ok || !r.geo) { fail++; line = `FAIL ${def.type}: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`; }
    else {
      const errs = checkGeo(r.geo);
      if (errs.length) { fail++; line = `FAIL ${def.type}: invariants: ${errs.join(', ')}`; }
      else { pass++; line = `ok   ${def.type.padEnd(18)} ${ms.toFixed(0).padStart(5)}ms  ${r.geo.numPoints} pts ${r.geo.numPrims} prims${r.geo.volumes.length ? ` ${r.geo.volumes.length} vol` : ''}${r.warnings.length ? `  (warn: ${r.warnings[0].message.slice(0, 60)})` : ''}`; }
    }
  } catch (e: any) {
    fail++;
    line = `FAIL ${def.type}: threw ${e?.stack ?? e}`;
  }
  rows.push(line);
  console.log(line);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
