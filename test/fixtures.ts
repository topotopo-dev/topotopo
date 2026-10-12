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
import { encodeGreyPNG } from '../src/io/heightmap.ts';
import { encodePNG } from '../src/render/png.ts';
import zlib from 'node:zlib';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';

/** Named source geometry. A fixture may wire other fixtures (`in`), which are pulled in automatically. */
export const SRC: Record<string, NodeSpec> = {
  MESH: { type: 'sphere', params: { type: 'ico', level: 2 } },
  BOX: { type: 'box', params: { divisions: [2, 2, 2] } },
  SMALLSPHERE: { type: 'sphere', params: { type: 'ico', level: 1, radius: 0.1 } },
  // boolean cutter: bites the +x+y+z corner off BOX (the unit MESH sphere would enclose the box and leave nothing)
  CUTTER: { type: 'sphere', params: { type: 'ico', level: 2, radius: 0.6, center: [0.5, 0.5, 0.5] } },
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
  // deformers (P1-C): lattice cages, a bar along +Z for path_deform, a point proxy for point_deform
  LATTICE_REST: { type: 'bound', in: ['MESH'], params: { divisions: [2, 2, 2] } },
  LATTICE_DEF: { type: 'twist', in: ['LATTICE_REST'], params: { angle: 60 } },
  ZBAR: { type: 'box', params: { size: [0.2, 0.2, 2], center: [0, 0, 1], divisions: [1, 1, 10] } },
  PROXY: { type: 'point_grid', params: { counts: [3, 3, 3], size: [1.2, 1.2, 1.2] } },
  PROXY_DEF: { type: 'bend', in: ['PROXY'], params: { angle: 60 } },
  NBRS: { type: 'attrib_array', in: ['GRID'], params: { mode: 'from_neighbours' } },
  CUBE: { type: 'box' },
  OPENTUBE: { type: 'tube', params: { cols: 12, caps: false } },
  // packed prims (P2-A): three identical boxes (pack shares one source), and packed copies of a coloured sphere
  PIECES: { type: 'copy_xform', in: ['BOX'], params: { count: 3, translate: [1.5, 0, 0], copy_attrib: '' } },
  PACKED: { type: 'copy_to_points', in: ['COLORED', 'PTS'], params: { pack: true } },
  // heightfields (P2-C): a 4 × 4 m field at 0.1 m (41 × 41 samples), noise hills, a slope mask, a curve and a stamp
  HF: { type: 'heightfield', params: { size: [4, 4], resolution: 0.1 } },
  HFN: { type: 'heightfield_noise', in: ['HF'], params: { amplitude: 0.8, element_size: 2, seed: 1 } },
  HFM: { type: 'heightfield_mask_by_feature', in: ['HFN'], params: { feature: 'slope', min_angle: 25 } },
  HF_CURVE: { type: 'curve', params: { points: [[-2, 0, -1], [0, 0.4, 0.5], [2, 0, 1]], smooth: true } },
  HF_STAMP: { type: 'box', params: { size: [1, 1, 1], center: [0.6, 0.5, 0] } },
  // mesh_repair (P1-E): a box with a missing face and four reversed faces
  HOLED: { type: 'delete', in: ['BOX'], params: { group: '0' } },
  BROKEN: { type: 'reverse', in: ['HOLED'], params: { group: '1-4' } },
  // spline toolkit (P2-D): a weighted NURBS, the default Bezier, a noisy helix, a zig-zag path, a road over bumps
  NURBS: { type: 'nurbs', params: { points: [[0, 0, 0], [1, 0.5, 1], [2.5, 0, 1.2], [3, 0.8, 0], [4.2, 0.2, -0.5], [5, 0, 0.4]], weights: [1, 2, 1, 1, 0.5, 1] } },
  BEZIER: { type: 'bezier' },
  SPIRAL: { type: 'spiral', params: { turns: 1.5, points_per_turn: 40 } },
  NOISY: { type: 'jitter', in: ['SPIRAL'], params: { amount: 0.04 } },
  ZIGZAG: { type: 'curve', params: { points: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [2, 0.5, 1], [2, 0, 2]] } },
  BUMPY: { type: 'noise_displace', in: ['GRID'], params: { amplitude: 0.3 } },
  ROAD: { type: 'curve', params: { points: [[-0.9, 1, -0.8], [0, 1, 0.2], [0.9, 1, 0.7]] } },
  // shelf assets (P2-F): a rising smooth path, a polyline with corners for pipes, a road centre line, a hilly ground
  SHELF_PATH: { type: 'curve', params: { points: [[0, 0, 0], [3, 0, 1], [6, 0.3, 0.5], [8, 0.6, -1]], smooth: true } },
  SHELF_PIPE: { type: 'curve', params: { points: [[0, 0.6, 0], [2, 0.6, 0], [2, 1.5, 0], [2, 1.5, 2], [4.5, 1.5, 2]] } },
  SHELF_ROAD: { type: 'curve', params: { points: [[-10, 0, 0], [0, 0, 4], [10, 0, 0]], smooth: true, subdivisions: 8 } },
  SHELF_GROUND: { type: 'terrain', params: { size: [16, 16], divisions: [24, 24], height: 1.5, frequency: 0.12, octaves: 3, seed: 3 } },
};

/** Fixture inputs of the shelf assets that take one (curve input 0 or surface input 0); test/shelf.ts checks coverage. */
export const SHELF_INPUTS: Record<string, string[]> = {
  railing: ['SHELF_PATH'], fence: ['SHELF_PATH'], pipe_run: ['SHELF_PIPE'], road_strip: ['SHELF_ROAD'],
  scatter_rocks: ['SHELF_GROUND'], forest_patch: ['SHELF_GROUND'], grass_clumps: ['SHELF_GROUND'],
};

/** A graph that cooks the shelf asset `name` at its defaults (on its fixture inputs, if it takes any) as node `target`. */
export function shelfFixtureGraph(name: string, params: Record<string, any> = {}): GraphSpec {
  const ins = SHELF_INPUTS[name] ?? [];
  const nodes: Record<string, NodeSpec> = {};
  ins.forEach((k) => addFixture(nodes, k));
  nodes.target = { type: name, ...(ins.length ? { in: ins } : {}), params: structuredClone(params) };
  return { nodes, output: 'target' };
}

/** Fixture inputs per node type. Nodes not listed get MESH when their first input is required, else nothing. */
export const INPUTS: Record<string, string[]> = {
  resample: ['CURVE'], carve: ['CURVE'], ends: ['CIRCLE'], sweep: ['CURVE', 'PROFILEXY'], polywire: ['CURVE'], revolve: ['PROFILE'],
  extrude: ['SHAPE'], offset_curve: ['SHAPE'], boolean2d: ['SHAPE', 'CIRCLE'], fill: ['SHAPE'], loft: ['LOFT'],
  copy_to_points: ['MESH', 'PTS'], ray: ['PTS_ABOVE', 'MESH'], attrib_copy: ['MESH', 'COLORED'], attrib_transfer: ['MESH', 'COLORED'],
  boolean: ['BOX', 'CUTTER'], minkowski: ['BOX', 'SMALLSPHERE'], voronoi_fracture: ['MESH'], convex_hull: ['PTS'],
  sdf_combine: ['SDF', 'SDF2'], sdf_modify: ['SDF'], sdf_to_mesh: ['SDF'], sdf_from_mesh: ['MESH'],
  triangulate2d: ['PTS'], voronoi2d: ['PTS'], merge: ['MESH', 'BOX'], switch: ['MESH', 'BOX'],
  uv_transform: ['BOX'], uv_flatten: ['BOX'], uv_layout: ['BOX'], uv_unwrap: ['BOX'], uv_autoseam: ['MESH'], poly_extrude: ['BOX'], poly_bevel: ['BOX'], subdivide: ['BOX'], fill_holes: ['GRID'], clip: ['MESH'], slice: ['MESH'],
  scatter: ['MESH'], decimate: ['MESH'], remesh: ['BOX'], smooth_solid: ['BOX'], foreach: ['BOX'],
  soft_transform: ['GRID'], lattice: ['MESH', 'LATTICE_REST', 'LATTICE_DEF'], path_deform: ['ZBAR', 'CURVE'],
  point_deform: ['MESH', 'PROXY', 'PROXY_DEF'],
  attrib_array: ['NBRS'],
  polysplit: ['BOX'], edge_divide: ['BOX'], dissolve: ['GRID'], polybridge: ['CUBE'], polyfill: ['OPENTUBE'],
  // measure (P1-F): curvature on the box (flat faces, sharp edges), distance from grid points to the sphere
  curvature: ['BOX'], distance: ['GRID', 'MESH'],
  pack: ['PIECES'], unpack: ['PACKED'],
  heightfield_noise: ['HF'], heightfield_mask_noise: ['HF'], heightfield_to_mesh: ['HFN'], heightfield_to_sdf: ['HFN'],
  heightfield_remap: ['HFN'], heightfield_blur: ['HFN'], heightfield_mask_blur: ['HFM'], heightfield_terrace: ['HFN'],
  heightfield_clip: ['HFN'], heightfield_cutout: ['HFN', 'CIRCLE'], heightfield_layer: ['HFN'],
  heightfield_mask_by_feature: ['HFN'], heightfield_mask_by_object: ['HFN', 'HF_CURVE'], heightfield_mask_expand: ['HFM'],
  heightfield_erode: ['HFN'], heightfield_project: ['HFN', 'HF_STAMP'], heightfield_path: ['HFN', 'HF_CURVE'],
  heightfield_scatter: ['HFM'], heightfield_resample: ['HFN'], heightfield_transform: ['HFN'],
  remesh_isotropic: ['BOX'], mesh_repair: ['BROKEN'],
  // PCG (P2-B): masks on the sphere, a colour map on the grid (point uv), points from scatter, samples along the curve
  attribute_from_map: ['GRID'], orient: ['PTS'], points_along_curve: ['CURVE'], cluster: ['PTS'], prune: ['PTS'],
  convert_curve: ['NURBS'], spline_fit: ['NOISY'], fillet_curve: ['ZIGZAG'], offset_curve_3d: ['NURBS'], project_curve: ['ROAD', 'BUMPY'],
  curve_attribs: ['NURBS'],
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
  material: { name: 'red', base_color: [1, 0, 0], roughness: 0.4, group: '@P.y>0' },
  text: { text: 'Hi', depth: 0.2 },
  lsystem: { generations: 3 },
  soft_transform: { group: '24', translate: [0, 0.5, 0], rotate: [0, 0, 20], radius: 0.8, weight_attrib: 'softweight' },
  path_deform: { stretch: true, twist: 90 },
  // input already has point int[] nbrs (from_neighbours); the fixture adds prim int[] pts
  attrib_array: { mode: 'from_group_points' },
  distance: { signed: true, extra: true },
  assert: { watertight: true, no_flipped: true, no_degenerate: true, expr: 'pieces == 1 && genus == 0', on_fail: 'mark' },
  graph_ref: null,
  knife: { origin: [0, 0.1, 0], direction: [0.3, 1, 0.2] },
  polysplit: { count: 2 },
  edge_divide: { group: 'ring:0', divisions: 3, connect: true },
  dissolve: { group: '@P.x>0.1' },
  edge_collapse: { group: '0-40:8' },
  polybridge: { source: '@P.y>0.4', target: '@P.y<-0.4', divisions: 2, blend: 0.5, delete_inner_faces: true },
  heightfield_from_mesh: { resolution: 0.05 },
  heightfield_layer: { layer: 'combo', expression: 'height * 2 + sin(x * 3) * 0.1 + mask' },
  heightfield_cutout: { value: -0.5, feather: 0.2 },
  heightfield_mask_by_object: { distance: 0.3, falloff: 0.3 },
  heightfield_erode: { iterations: 8 },
  heightfield_project: { radius: 0.4 },
  heightfield_path: { width: 0.6, shoulder: 0.4, smooth: 1, bank: 5 },
  heightfield_scatter: { density: 4 },
  heightfield_resample: { factor: 0.5 },
  heightfield_transform: { translate: [1, 0.5, 0], rotate: 90, height_scale: 1.5 },
  // heightfield_from_image: { path } is filled in by createFixtureEngine() (a 16-bit PNG written to the temp dir)
  remesh_isotropic: { target_length: 0.2, iterations: 4 },
  mesh_repair: { self_intersections: 'report' },
  lod: { levels: 3 },
  mask: { by: 'slope', min: 0, max: 45, falloff: 15 },
  // attribute_from_map: { path } is filled in by createFixtureEngine() (an RGBA PNG written to the temp dir)
  orient: { random_yaw: [0, 360], tilt: [0, 10], scale_min: 0.8, scale_max: 1.2 },
  points_along_curve: { spacing: 0.3, start_offset: 0.1 },
  cluster: { count: 5, center: true, color: true },
  prune: { radius: 0.15 },
  nurbs: { weights: [1, 1, 3, 1, 1, 1] },
  convert_curve: { to: 'bezier' },
  spline_fit: { tolerance: 0.08, smoothing: 0.2 },
  fillet_curve: { radius: 0.3, segments: 4 },
  offset_curve_3d: { distance: 0.3, both: true, lift: 0.2 },
  project_curve: { spacing: 0.1, lift: 0.02 },
  curve_attribs: { frame: true, curvature: true, segment: true, ramp_attrib: 'width', ramp: [[0, 0.2], [1, 0.05]] },
};

/** Node types that cannot cook standalone (subgraph input, references to workspace graphs). */
export const SKIP = new Set(['input', 'graph_ref']);

/**
 * Node types whose output depends on the machine, not just on the graph. The text node used to be one (system
 * fonts); it now defaults to the bundled assets/fonts/DejaVuSans.ttf, so the set is empty unless a fixture names a
 * system font explicitly.
 */
export const ENV_DEPENDENT_TYPES = new Set<string>([]);

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
  // packed prims: arrays sized to the prims, one vertex each, valid source, finite transform; sources consistent
  if (g.primKind) {
    const n = g.numPrims;
    if (g.primKind.length !== n || g.packedSource?.length !== n || g.packedXform?.length !== n * 9) errs.push('packed array sizes');
    else {
      let bad = '';
      for (let p = 0; p < n && !bad; p++) {
        const k = g.primKind[p];
        if (k !== 1) {
          // 0 polygon/polyline, 2 Bezier, 3 NURBS
          if (k > 3) bad = `prim ${p}: unknown kind ${k}`;
          else if (g.packedSource[p] !== -1) bad = `prim ${p}: not packed but has source ${g.packedSource[p]}`;
          else if (k >= 2 && g.primSize(p) < 1) bad = `spline prim ${p} has no CVs`;
          continue;
        }
        if (g.primSize(p) !== 1) bad = `packed prim ${p} has ${g.primSize(p)} vertices`;
        else if (!(g.packedSource[p] >= 0 && g.packedSource[p] < g.packedSources.length)) bad = `packed prim ${p}: source ${g.packedSource[p]} of ${g.packedSources.length}`;
        else if (g.primClosed[p]) bad = `packed prim ${p} is closed`;
        else for (let c = 0; c < 9; c++) if (!Number.isFinite(g.packedXform[p * 9 + c])) { bad = `packed prim ${p}: non-finite transform`; break; }
      }
      if (bad) errs.push(bad);
      if (!g.primKind.some((k) => k)) errs.push('prim kind arrays without packed or spline prims');
      if (g.packedSources.length && !g.primKind.includes(1)) errs.push('packed sources without packed prims');
      for (const [i, src] of g.packedSources.entries()) for (const e of checkGeo(src)) errs.push(`packed source ${i}: ${e}`);
    }
  }
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
  // heightfield_from_image: a 33 × 17 16-bit grey heightmap (ramp + bumps), zlib-compressed like real files
  const W = 33, H = 17, px = new Uint16Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) px[j * W + i] = Math.round(65535 * (0.5 * (i / (W - 1)) + 0.25 * (1 + Math.sin(i * 0.7) * Math.cos(j * 0.9)) * 0.5));
  const pngPath = path.join(tmp, 'height16.png');
  fs.writeFileSync(pngPath, encodeGreyPNG(px, W, H, 16, (d) => zlib.deflateSync(d)));
  PARAMS.heightfield_from_image = { path: pngPath, size: [4, 2], height_min: 0, height_max: 2 };
  // attribute_from_map: a 24 × 12 RGBA colour map (red across, green down, blue checker) sampled by the grid's uv
  const MW = 24, MH = 12, rgba = new Uint8Array(MW * MH * 4);
  for (let j = 0; j < MH; j++) for (let i = 0; i < MW; i++) {
    const o = (j * MW + i) * 4;
    rgba[o] = Math.round((255 * i) / (MW - 1)); rgba[o + 1] = Math.round((255 * j) / (MH - 1)); rgba[o + 2] = ((i >> 2) + (j >> 2)) % 2 ? 220 : 30; rgba[o + 3] = 255;
  }
  const mapPath = path.join(tmp, 'colormap.png');
  fs.writeFileSync(mapPath, encodePNG(rgba, MW, MH, (d) => zlib.deflateSync(d)));
  PARAMS.attribute_from_map = { path: mapPath, channel: 'rgb' };
  return { engine, tmp, objPath };
}

/** Repository root (works on Windows file URLs too). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
