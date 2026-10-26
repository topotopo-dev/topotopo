// Topology tests: half-edge structure, vertex/edge groups and their propagation, group patterns,
// group tooling nodes, crease subdivision and hard-edge normals.
//   node test/topology.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry, GeoBuilder } from '../src/core/geometry.ts';
import { EdgeSet, edgeKey, edgeFromKey, edgeList } from '../src/core/edges.ts';
import { halfEdges } from '../src/core/halfedge.ts';
import type { HalfEdgeMesh } from '../src/core/halfedge.ts';
import { evalGroup, evalEdgeGroup } from '../src/core/groups.ts';
import { convertSelection } from '../src/core/groupconvert.ts';
import { boundaryLoops, primArea, primNormals, topologyReport, triangleReport, triangulate } from '../src/core/topology.ts';
import { readFileSync } from 'node:fs';
import { geoFromJSON, geoToJSON } from '../src/io/json.ts';
import { summarize, inspect } from '../src/inspect.ts';
import type { NodeSpec } from '../src/graph/types.ts';

const engine = new Engine(createNodeHost());
await engine.init();

let fail = 0, pass = 0;
const check = (ok: any, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const throws = (f: () => any) => { try { f(); return false; } catch { return true; } };

async function cook(nodes: Record<string, NodeSpec>, output?: string): Promise<Geometry> {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return r.geo;
}
const sum = (m: Uint8Array | null | undefined) => (m ? m.reduce((s, x) => s + x, 0) : -1);

/** Invariants every geometry must satisfy, including the new group maps. */
function groupInvariants(g: Geometry, label: string) {
  const errs: string[] = [];
  for (const [k, m] of g.pointGroups) if (m.length !== g.numPoints) errs.push(`point group ${k}`);
  for (const [k, m] of g.primGroups) if (m.length !== g.numPrims) errs.push(`prim group ${k}`);
  for (const [k, m] of g.vertexGroups) if (m.length !== g.numVertices) errs.push(`vertex group ${k} size ${m.length} != ${g.numVertices}`);
  for (const [k, s] of g.edgeGroups) for (const [a, b] of s) if (a < 0 || b >= g.numPoints || a >= b) { errs.push(`edge group ${k} pair ${a}-${b}`); break; }
  check(!errs.length, `${label}: group invariants${errs.length ? ' ' + errs.join(', ') : ''}`);
}

/** Half-edge structural invariants. */
function heInvariants(he: HalfEdgeMesh, label: string) {
  let ok = true;
  const why: string[] = [];
  for (let h = 0; h < he.numHalfEdges; h++) {
    if (he.heNext[he.hePrev[h]] !== h || he.hePrev[he.heNext[h]] !== h) { ok = false; why.push(`next/prev at ${h}`); break; }
    if (he.heFace[he.heNext[h]] !== he.heFace[h]) { ok = false; why.push(`face at ${h}`); break; }
    const t = he.heTwin[h];
    if (t >= 0 && (he.heTwin[t] !== h || he.heOrigin[t] !== he.dest(h) || he.dest(t) !== he.heOrigin[h])) { ok = false; why.push(`twin at ${h}`); break; }
    if (he.edgeId(he.heOrigin[h], he.dest(h)) !== he.heEdge[h]) { ok = false; why.push(`edge id at ${h}`); break; }
  }
  for (let p = 0; p < he.pointFirst.length; p++) {
    const f = he.pointFirst[p];
    if (f >= 0 && he.heOrigin[f] !== p) { ok = false; why.push(`pointFirst ${p}`); break; }
    // pointFirst prefers a boundary half-edge
    if (f >= 0 && he.heTwin[f] >= 0) for (const h of he.outgoing(p)) if (he.heTwin[h] < 0) { ok = false; why.push(`pointFirst not boundary at ${p}`); break; }
  }
  check(ok, `${label}: next/prev/twin/edge invariants${why.length ? ' ' + why.join(', ') : ''}`);
}

function euler(he: HalfEdgeMesh) {
  let V = 0, F = 0;
  for (let p = 0; p < he.pointFirst.length; p++) if (he.pointFirst[p] >= 0) V++;
  for (let f = 0; f < he.faceFirst.length; f++) if (he.faceFirst[f] >= 0) F++;
  return V - he.numEdges + F;
}

// ---------------------------------------------------------------- EdgeSet basics
{
  const s = new EdgeSet();
  s.add(5, 2); s.add(2, 5); s.add(3, 3); s.add(1, 9);
  check(s.size === 2 && s.has(2, 5) && s.has(5, 2) && !s.has(3, 3), 'EdgeSet: unordered pairs, self-edges ignored');
  check(Array.from(s.toPairs()).join(',') === '1,9,2,5', 'EdgeSet: toPairs sorted (min, max)');
  check(edgeFromKey(edgeKey(7, 3)).join(',') === '3,7' && throws(() => edgeKey(-1, 2)) && throws(() => edgeKey(0, 2 ** 26)), 'edgeKey canonical + guarded');
  const r = s.remap(Int32Array.from([0, 4, 7, -1, 0, 7, 0, 0, 0, 3]));
  check(r.size === 1 && r.has(4, 3), 'EdgeSet.remap drops vanished and collapsed edges');
  check(EdgeSet.fromPairs([0, 1, 2, 3]).size === 2 && s.shifted(10).has(12, 15), 'EdgeSet.fromPairs / shifted');
}

// ---------------------------------------------------------------- half-edge structure
const box = await cook({ b: { type: 'box' } });
const grid = await cook({ g: { type: 'grid', params: { divisions: [10, 10] } } });
const ico = await cook({ s: { type: 'sphere', params: { type: 'ico', level: 2 } } });
const torus = await cook({ t: { type: 'torus', params: { rows: 16, cols: 48 } } });
{
  const he = halfEdges(box);
  heInvariants(he, 'box');
  check(he.isManifold && euler(he) === 2 && he.numEdges === 12, `box: manifold, euler ${euler(he)}, ${he.numEdges} edges`);
  let all90 = true;
  for (let e = 0; e < he.numEdges; e++) if (Math.abs(he.dihedralAngle(e) - 90) > 1e-9) all90 = false;
  check(all90, 'box: every dihedral angle is 90');
  check(halfEdges(box) === he && halfEdges(box.clone()) !== he, 'half-edge cache per geometry object');
  check(he.pointOneRing(0).length === 3 && he.pointPrims(0).length === 3 && he.faceNeighbors(0).length === 4, 'box: one-ring 3, point prims 3, face neighbours 4');
}
{
  const he = halfEdges(grid);
  heInvariants(he, 'grid');
  const loops = he.boundaryLoops();
  check(loops.length === 1 && loops[0].length === 40, `grid: 1 boundary loop of 40 points (got ${loops.length}, ${loops[0]?.length})`);
  const old = boundaryLoops(grid);
  check(old.length === 1 && new Set(old[0]).size === 40 && old[0].every((p) => loops[0].includes(p)), 'grid: same loop points as topology.boundaryLoops');
  // orientation matches topology.boundaryLoops (cyclic rotation of the same sequence)
  const i0 = loops[0].indexOf(old[0][0]);
  check(old[0].every((p, k) => loops[0][(i0 + k) % 40] === p), 'grid: boundary loop orientation matches topology.boundaryLoops');
  // interior point: valence 4
  const mid = he.edgeA[he.numEdges >> 1];
  check(he.pointOneRing(60).length === 4, 'grid: interior one-ring has 4 points');
  // edge ring across the grid: 10 quads crossed → 11 rungs
  let interior = -1;
  for (let e = 0; e < he.numEdges && interior < 0; e++) if (!he.isBoundaryEdge(e)) interior = e;
  const ring = he.edgeRing(he.edgeA[interior], he.edgeB[interior])!;
  check(ring && !ring.closed && ring.edges.length === 11 && new Set(ring.edges).size === 11, `grid: edge ring spans the grid (${ring?.edges.length} rungs)`);
  const loop = he.edgeLoop(he.edgeA[interior], he.edgeB[interior])!;
  check(loop && !loop.closed && loop.edges.length === 10 && loop.points.length === 11, `grid: interior edge loop runs boundary to boundary (${loop?.edges.length} edges)`);
  let bnd = -1;
  for (let e = 0; e < he.numEdges && bnd < 0; e++) {
    const a = he.edgeA[e], b = he.edgeB[e];
    if (he.isBoundaryEdge(e) && he.outgoing(a).length === 2 && he.outgoing(b).length === 2) bnd = e;
  }
  const bl = he.edgeLoop(he.edgeA[bnd], he.edgeB[bnd])!;
  check(bl && bl.edges.length === 10 && bl.edges.every((e) => he.isBoundaryEdge(e)), `grid: boundary edge loop follows one side (${bl?.edges.length} edges)`);
  const w = he.walkBoundary(he.pointFirst[0]);
  check(w.closed && w.halfEdges.length === 40, 'grid: walkBoundary from a corner point');
  void mid;
}
{
  const he = halfEdges(ico);
  heInvariants(he, 'ico sphere');
  check(he.isManifold && euler(he) === 2 && he.boundaryLoops().length === 0, `ico sphere: closed, euler ${euler(he)}`);
}
{
  const he = halfEdges(torus);
  heInvariants(he, 'torus');
  check(he.isManifold && euler(he) === 0, `torus: manifold, euler ${euler(he)} (genus 1)`);
  const loop = he.edgeLoop(he.edgeA[0], he.edgeB[0])!;
  check(loop.closed && (loop.edges.length === 16 || loop.edges.length === 48) && new Set(loop.points).size === loop.points.length, `torus: edge loop is a full ring (${loop.edges.length} edges, closed=${loop.closed})`);
  const ring = he.edgeRing(he.edgeA[0], he.edgeB[0])!;
  check(ring.closed && ring.edges.length === 64 - loop.edges.length, `torus: edge ring closes (${ring.edges.length} rungs)`);
  check(he.pointOneRing(5).length === 4, 'torus: valence 4');
}
{
  // three triangles sharing edge 0-1 (non-manifold); must not throw
  const g = new Geometry({ positions: [0, 0, 0, 1, 0, 0, 0.5, 1, 0, 0.5, -1, 0, 0.5, 0, 1], prims: [[0, 1, 2], [1, 0, 3], [0, 1, 4]] });
  const he = halfEdges(g);
  heInvariants(he, 'non-manifold fan');
  const e = he.edgeId(0, 1);
  check(!he.isManifold && he.nonManifoldEdges.has(e) && he.edgeValence(e) === 3, 'non-manifold: edge flagged, valence 3');
  const twins = [0, 1, 2].map((f) => he.heTwin[he.halfEdge(0, 1) === -1 ? 0 : he.faceHalfEdges(f)[f === 1 ? 0 : 0]]);
  check(twins.filter((t) => t >= 0).length === 2, 'non-manifold: only the first consistent pair becomes twins');
  check(Number.isFinite(he.dihedralAngle(e)) && he.pointOneRing(0).length === 4, 'non-manifold: queries still answer');
}
{
  // two quads whose shared edge runs the same way (inconsistent winding)
  const g = new Geometry({ positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, -1, 0, 0, -1, 0], prims: [[0, 1, 2, 3], [0, 1, 4, 5]] });
  const he = halfEdges(g);
  heInvariants(he, 'flipped winding');
  const e = he.edgeId(0, 1);
  check(!he.isManifold && he.flippedEdges.has(e) && he.heTwin[he.edgeHalf[e]] === -1, 'flipped winding: flagged, no twin');
  check(Math.abs(he.dihedralAngle(e)) < 1e-9, 'flipped winding: dihedral compensates the flipped normal (flat = 0)');
  check(inspect(g, { detail: 'topology' }).includes('inconsistent winding'), 'inspect topology reports inconsistent winding');
}

// ---------------------------------------------------------------- group patterns
{
  // box points: face 0 is [0,1,2,3]
  const es = (pat: string, g = box) => evalEdgeGroup(g, pat);
  check(es('p0-1').size === 1 && es('p0-1').has(0, 1), 'edge pattern p0-1');
  check(es('p0-1-2').size === 2 && es('p0-1-2-3-0').size === 4, 'edge chains p0-1-2 and closed p0-1-2-3-0');
  check(es('p0-2').size === 0, 'edge pattern on a non-edge (diagonal) selects nothing');
  check(es('angle>80').size === 12 && es('angle<10').size === 0, 'angle>80 on a box selects 12 edges');
  check(es('boundary').size === 0 && es('shared').size === 12, 'box: no boundary edges, 12 shared');
  check(es('boundary', grid).size === 40 && es('unshared', grid).size === 40 && es('!boundary', grid).size === edgeList(grid).count - 40, 'grid: boundary/unshared/!boundary');
  check(es('border:0').size === 4 && es('border:0-1').size === 8 && es('border:0-1', grid).size === 6, 'border of a prim group');
  check(es('0e1').size === 1 && es('0e1').has(1, 2), 'prim side 0e1');
  check(es('0-3').size === 4 && es('p0-1 ^p0-1').size === 0, 'edge index ranges and ^');
  check(es('@P.y>0.4').size === 4 && es('length>0.99').size === 12, '@P on edge midpoints, length selector');
  check(throws(() => evalGroup(box, 'edge', 'nosuchgroup')), 'unknown edge group throws');
  const bg = box.clone();
  bg.addEdgeGroup('rim', es('@P.y>0.4'));
  check(es('rim', bg).size === 4 && es('group:rim', bg).size === 4 && es('rim ^p0-1', bg).size === 4, 'named edge group');
  bg.addGroup('prim', 'top', evalGroup(bg, 'prim', '@P.y>0.4')!);
  check(es('prim:top', bg).size === 4 && es('top', bg).size === 4, 'edge pattern naming a prim group → its sides');
  check(sum(evalGroup(bg, 'point', 'rim')) === 4 && sum(evalGroup(bg, 'prim', 'rim')) === 1, 'point/prim patterns naming an edge group (endpoints / prims with every side grouped)');
  // vertex patterns
  check(sum(evalGroup(box, 'vertex', '0-3')) === 4 && sum(evalGroup(box, 'vertex', '@P.y>0')) === 12 && sum(evalGroup(box, 'vertex', '@ptnum==0')) === 3, 'vertex patterns: range, @P via point, @ptnum');
  check(sum(evalGroup(bg, 'vertex', 'top')) === 4 && sum(evalGroup(bg, 'vertex', 'rim')) === 12, 'vertex pattern naming prim / edge groups');
  bg.addGroup('vertex', 'corner', evalGroup(bg, 'vertex', '0 5')!);
  check(sum(evalGroup(bg, 'vertex', 'corner')) === 2 && sum(evalGroup(bg, 'vertex', '!corner')) === 22, 'named vertex group and !');
  check(sum(evalGroup(bg, 'point', 'corner')) === 2, 'point pattern naming a vertex group');
  // existing point/prim behaviour unchanged
  check(sum(evalGroup(box, 'point', '@P.y>0')) === 4 && sum(evalGroup(bg, 'point', 'top')) === 4, 'point patterns unchanged');
}

// ---------------------------------------------------------------- conversions
{
  const top = evalGroup(box, 'point', '@P.y>0')!;
  check(sum(convertSelection(box, 'point', 'prim', top, 'any') as Uint8Array) === 5 && sum(convertSelection(box, 'point', 'prim', top, 'all') as Uint8Array) === 1, 'point→prim any (5) / all (1)');
  const rim = evalEdgeGroup(box, '@P.y>0.4');
  check(sum(convertSelection(box, 'edge', 'prim', rim, 'any') as Uint8Array) === 5 && sum(convertSelection(box, 'edge', 'prim', rim, 'all') as Uint8Array) === 1, 'edge→prim any (5) / all (1)');
  check(sum(convertSelection(box, 'edge', 'point', rim) as Uint8Array) === 4, 'edge→point endpoints');
  const topPrim = evalGroup(box, 'prim', '@P.y>0.4')!;
  check((convertSelection(box, 'prim', 'edge', topPrim) as EdgeSet).size === 4 && sum(convertSelection(box, 'prim', 'point', topPrim) as Uint8Array) === 4, 'prim→edge sides, prim→point points');
  check((convertSelection(box, 'point', 'edge', top, 'all') as EdgeSet).size === 4 && (convertSelection(box, 'point', 'edge', top, 'any') as EdgeSet).size === 8, 'point→edge all (both ends) / any');
  check(sum(convertSelection(box, 'point', 'vertex', top) as Uint8Array) === 12 && sum(convertSelection(box, 'vertex', 'point', convertSelection(box, 'point', 'vertex', top) as Uint8Array, 'all') as Uint8Array) === 4, 'point↔vertex');
}

// ---------------------------------------------------------------- nodes: group / promote / expand / combine / delete / rename
{
  const g = await cook({
    b: { type: 'box' },
    e: { type: 'group', in: ['b'], params: { class: 'edge', name: 'sharp', pattern: 'angle>30' } },
    t: { type: 'group', in: ['e'], params: { class: 'edge', name: 'rim', pattern: '@P.y>0.4' } },
    v: { type: 'group', in: ['t'], params: { class: 'vertex', name: 'vtop', expr: '@P.y > 0' } },
    w: { type: 'group', in: ['v'], params: { class: 'edge', name: 'xpos', expr: '@P.x > 0' } },
    u: { type: 'group', in: ['w'], params: { class: 'edge', name: 'rim', pattern: 'p0-1', mode: 'union' } },
  }, 'u');
  check(g.edgeGroups.get('sharp')?.size === 12 && g.edgeGroups.get('xpos')?.size === 4, 'group node: edge class pattern and expr (both points)');
  check(g.edgeGroups.get('rim')?.size === 5 && sum(g.vertexGroups.get('vtop')) === 12, 'group node: union mode on edges, vertex expr');
  groupInvariants(g, 'group node output');
  const s = summarize(g);
  check(s.includes('vertex[vtop 12]') && s.includes('edge[sharp 12, rim 5, xpos 4]'), 'summary lists vertex and edge groups');
  const ins = inspect(g, { detail: 'elements', cls: 'edge', group: 'rim', count: 20 });
  check(ins.includes('p0-1') && ins.includes('angle=90') && ins.includes('groups=sharp,rim'), 'inspect lists edges with groups');
  const pr = await cook({
    b: { type: 'box' },
    t: { type: 'group', in: ['b'], params: { class: 'point', name: 'top', pattern: '@P.y>0' } },
    any: { type: 'group_promote', in: ['t'], params: { group: 'top', from: 'point', to: 'prim', new_name: 'anyp', delete_source: false } },
    all: { type: 'group_promote', in: ['any'], params: { group: 'top', from: 'point', to: 'prim', include: 'all' } },
    ed: { type: 'group_promote', in: ['all'], params: { group: 'top', from: 'prim', to: 'edge', new_name: 'topedges', delete_source: false } },
  }, 'ed');
  check(sum(pr.primGroups.get('anyp')) === 5 && sum(pr.primGroups.get('top')) === 1 && !pr.pointGroups.has('top'), 'group_promote: any/all, delete_source');
  check(pr.edgeGroups.get('topedges')?.size === 4, 'group_promote: prim → edge');
  const ex = await cook({
    g: { type: 'grid', params: { divisions: [10, 10] } },
    c: { type: 'group', in: ['g'], params: { class: 'prim', name: 'c', pattern: '55' } },
    e1: { type: 'group_expand', in: ['c'], params: { group: 'c', class: 'prim', steps: 1, new_name: 'e1' } },
    e2: { type: 'group_expand', in: ['e1'], params: { group: 'c', class: 'prim', steps: 1, connectivity: 'point', new_name: 'e2' } },
    e3: { type: 'group_expand', in: ['e2'], params: { group: 'e2', class: 'prim', steps: -1, new_name: 'e3' } },
    p: { type: 'group', in: ['e3'], params: { class: 'point', name: 'p', pattern: '60' } },
    pe: { type: 'group_expand', in: ['p'], params: { group: 'p', class: 'point', steps: 1 } },
    ed: { type: 'group', in: ['pe'], params: { class: 'edge', name: 'ed', pattern: 'p60-61' } },
    ee: { type: 'group_expand', in: ['ed'], params: { group: 'ed', class: 'edge', steps: 1 } },
  }, 'ee');
  check(sum(ex.primGroups.get('e1')) === 5 && sum(ex.primGroups.get('e2')) === 9 && sum(ex.primGroups.get('e3')) === 1, `group_expand on a grid: +1 edge 5, +1 point 9, shrink 3x3 → 1`);
  check(sum(ex.pointGroups.get('p')) === 5 && ex.edgeGroups.get('ed')?.size === 7, 'group_expand: point +1 = 5, edge +1 = 7');
  const cb = await cook({
    b: { type: 'box' },
    a: { type: 'group', in: ['b'], params: { name: 'a', pattern: '0-2' } },
    c: { type: 'group', in: ['a'], params: { name: 'c', pattern: '1-3' } },
    x: { type: 'group_combine', in: ['c'], params: { name: 'x', expr: 'a & !c' } },
    y: { type: 'group_combine', in: ['x'], params: { name: 'y', expr: 'a ^ c' } },
    z: { type: 'group_combine', in: ['y'], params: { name: 'z', expr: '(a | c) & !2' } },
    w: { type: 'group_combine', in: ['z'], params: { name: 'w', expr: 'a @P.y > 0.4' } },
    q: { type: 'group_combine', in: ['w'], params: { name: 'q', class: 'edge', expr: 'angle>80 & !p0-1' } },
    d: { type: 'group_delete', in: ['q'], params: { groups: 'a', class: 'prim' } },
    r: { type: 'group_rename', in: ['d'], params: { from: 'q', to: 'qq' } },
  }, 'r');
  const ids = (m?: Uint8Array) => (m ? [...m].flatMap((x, i) => (x ? [i] : [])).join(',') : 'none');
  check(ids(cb.primGroups.get('x')) === '0' && ids(cb.primGroups.get('y')) === '0,3' && ids(cb.primGroups.get('z')) === '0,1,3', 'group_combine: & ! ^ | ( )');
  check(sum(cb.primGroups.get('w')) === 4, 'group_combine: juxtaposition = union, spaced @ test');
  check(cb.edgeGroups.get('qq')?.size === 11 && !cb.edgeGroups.has('q') && !cb.primGroups.has('a'), 'group_combine on edges, group_rename, group_delete');
}

// ---------------------------------------------------------------- delete vertex / edge
{
  const dv = await cook({ b: { type: 'box' }, d: { type: 'delete', in: ['b'], params: { class: 'vertex', group: '0' } } }, 'd');
  check(dv.numPrims === 5 && dv.numPoints === 8, 'delete vertex: polygon losing a corner is deleted');
  const curve = await cook({ c: { type: 'curve', params: { points: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]] } }, d: { type: 'delete', in: ['c'], params: { class: 'vertex', group: '1' } } }, 'd');
  check(curve.numPrims === 1 && curve.numVertices === 3 && curve.numPoints === 3, 'delete vertex: polyline shrinks');
  const de = await cook({ b: { type: 'box' }, d: { type: 'delete', in: ['b'], params: { class: 'edge', group: 'p0-1' } } }, 'd');
  check(de.numPrims === 4, 'delete edge: both prims using the edge are deleted');
  const ke = await cook({ b: { type: 'box' }, d: { type: 'delete', in: ['b'], params: { class: 'edge', group: 'p0-1', keep: true } } }, 'd');
  check(ke.numPrims === 2, 'delete edge keep: only prims using the edge stay');
}

// ---------------------------------------------------------------- edge/vertex group propagation
{
  const g0 = box.clone();
  g0.addEdgeGroup('rim', evalEdgeGroup(g0, '@P.y>0.4'));
  g0.addGroup('vertex', 'v0', evalGroup(g0, 'vertex', '0-3')!);
  const c = g0.clone();
  c.edgeGroups.get('rim')!.add(0, 1);
  check(g0.edgeGroups.get('rim')!.size === 4 && c.edgeGroups.get('rim')!.size === 5 && sum(c.vertexGroups.get('v0')) === 4, 'clone: deep copies of edge and vertex groups');
  const m = Geometry.merge([g0, g0]);
  const rim = m.edgeGroups.get('rim')!;
  check(rim.size === 8 && [...g0.edgeGroups.get('rim')!].every(([a, b]) => rim.has(a, b) && rim.has(a + 8, b + 8)), 'merge: edge groups unioned with point offsets');
  check(sum(m.vertexGroups.get('v0')) === 8 && m.vertexGroups.get('v0')!.length === 48, 'merge: vertex groups offset');
  groupInvariants(m, 'merge');
  const topPrim = evalGroup(g0, 'prim', '@P.y>0.4')!;
  const noTop = g0.subsetPrims(topPrim.map((x) => 1 - x));
  check(noTop.edgeGroups.get('rim')!.size === 4, 'subsetPrims: edges still bounding a prim stay');
  const bottomOnly = g0.subsetPrims(evalGroup(g0, 'prim', '@P.y<-0.4')!);
  check(bottomOnly.edgeGroups.get('rim')!.size === 0 && bottomOnly.numPoints === 4, 'subsetPrims: edges of deleted prims leave the group');
  groupInvariants(noTop, 'subsetPrims');
  const sp = g0.subsetPoints(evalGroup(g0, 'point', '@P.x<0')!);
  groupInvariants(sp, 'subsetPoints');
  check(sp.edgeGroups.get('rim')!.size === 1, 'subsetPoints: remapped, edges of deleted points/prims dropped');
  // GeoBuilder rules
  const bld = new GeoBuilder(g0);
  for (let i = 0; i < g0.numPoints; i++) bld.copyPoint(i);
  const mid = bld.blendPoint([0, 1], [0.5, 0.5]);
  bld.addPrim([0, 1, 2, 3], true, 0, [0, 1, 2, 3]);
  bld.addPrim([0, mid, 1, 5], true, 0, [0, { i: [0, 1], w: [0.5, 0.5] }, 1, { i: [5], w: [1] }]);
  const bg = bld.build();
  check(bg.edgeGroups.get('rim')!.size === [...g0.edgeGroups.get('rim')!].filter(([a, b]) => [[0, 1], [1, 2], [2, 3], [0, 3]].some(([x, y]) => x === a && y === b)).length, 'GeoBuilder: edge group follows edges between single-source points');
  check(Array.from(bg.vertexGroups.get('v0')!).join('') === '11111010', 'GeoBuilder: vertex group follows single-source corners, blends drop out');
}
{
  const g = await cook({
    b: { type: 'box' },
    t: { type: 'group', in: ['b'], params: { class: 'edge', name: 'rim', pattern: '@P.y>0.4' } },
    v: { type: 'group', in: ['t'], params: { class: 'vertex', name: 'vt', pattern: '@P.y>0' } },
    x: { type: 'transform', in: ['v'], params: { translate: [1, 2, 3], rotate: [0, 45, 0] } },
    f: { type: 'facet', in: ['x'] },
  }, 'x');
  check(g.edgeGroups.get('rim')?.size === 4 && sum(g.vertexGroups.get('vt')) === 12, 'transform keeps edge and vertex groups');
  const fa = await cook({
    b: { type: 'box' },
    f: { type: 'facet', in: ['b'] },
    t: { type: 'group', in: ['f'], params: { class: 'edge', name: 'rim', pattern: '@P.y>0.4' } },
    v: { type: 'group', in: ['t'], params: { class: 'vertex', name: 'vt', pattern: '@P.y>0' } },
  }, 'v');
  check(fa.numPoints === 24 && fa.edgeGroups.get('rim')?.size === 8, 'facet: rim edges duplicated per prim (8 pairs)');
  const fu = await cook({
    b: { type: 'box' },
    f: { type: 'facet', in: ['b'] },
    t: { type: 'group', in: ['f'], params: { class: 'edge', name: 'rim', pattern: '@P.y>0.4' } },
    v: { type: 'group', in: ['t'], params: { class: 'vertex', name: 'vt', pattern: '@P.y>0' } },
    u: { type: 'fuse', in: ['v'] },
  }, 'u');
  const fl = edgeList(fu);
  const rimF = fu.edgeGroups.get('rim')!;
  check(fu.numPoints === 8 && rimF.size === 4 && [...rimF].every(([a, b]) => fl.index.has(edgeKey(a, b)) && fu.P[a * 3 + 1] > 0.4 && fu.P[b * 3 + 1] > 0.4), 'fuse: edge group remapped through welded points (4 rim edges)');
  check(sum(fu.vertexGroups.get('vt')) === 12, 'fuse: vertex groups kept');
  groupInvariants(fu, 'fuse');
  const ext = await cook({
    b: { type: 'box' },
    t: { type: 'group', in: ['b'], params: { class: 'edge', name: 'rim', pattern: '@P.y>0.4' } },
    p: { type: 'group', in: ['t'], params: { class: 'prim', name: 'top', pattern: '@P.y>0.4' } },
    x: { type: 'poly_extrude', in: ['p'], params: { group: 'top', distance: 0.5 } },
  }, 'x');
  const orig = [...evalEdgeGroup(box, '@P.y>0.4')];
  const rimX = ext.edgeGroups.get('rim')!;
  check(orig.every(([a, b]) => rimX.has(a, b)) && rimX.size === 8, `poly_extrude: original rim edges keep membership (+ extruded copies, ${rimX.size})`);
  groupInvariants(ext, 'poly_extrude');
  const json = geoFromJSON(JSON.parse(JSON.stringify(geoToJSON(fa))));
  check(json.edgeGroups.get('rim')?.size === 8 && [...fa.edgeGroups.get('rim')!].every(([a, b]) => json.edgeGroups.get('rim')!.has(a, b)) && Array.from(json.vertexGroups.get('vt')!).join() === Array.from(fa.vertexGroups.get('vt')!).join(), 'JSON round trip keeps vertex and edge groups');
  check(!('edge' in geoToJSON(box).groups) && !('vertex' in geoToJSON(box).groups), 'JSON without vertex/edge groups is unchanged');
  const sub = await cook({
    b: { type: 'box' },
    t: { type: 'group', in: ['b'], params: { class: 'edge', name: 'rim', pattern: '@P.y>0.4' } },
    s: { type: 'subdivide', in: ['t'], params: { levels: 2 } },
  }, 's');
  const sl = edgeList(sub);
  check(sub.edgeGroups.get('rim')?.size === 16 && [...sub.edgeGroups.get('rim')!].every(([a, b]) => sl.index.has(edgeKey(a, b))), 'subdivide: edge group follows the child edges (4 → 16)');
  const cp = await cook({
    b: { type: 'box' },
    t: { type: 'group', in: ['b'], params: { class: 'edge', name: 'rim', pattern: '@P.y>0.4' } },
    pts: { type: 'points', params: { positions: [[0, 0, 0], [3, 0, 0], [6, 0, 0]] } },
    c: { type: 'copy_to_points', in: ['t', 'pts'] },
  }, 'c');
  check(cp.edgeGroups.get('rim')?.size === 12, 'copy_to_points: edge groups per copy');
  groupInvariants(cp, 'copy_to_points');
}

// ---------------------------------------------------------------- wrangle
{
  const g = await cook({
    b: { type: 'box' },
    w: { type: 'wrangle', in: ['b'], params: { run_over: 'vertices', code: '@group_even = @vtxnum % 2 == 0;' } },
    d: { type: 'wrangle', in: ['w'], params: { run_over: 'detail', code: 'setedgegroup(0, "e", 0, 1); setedgegroup(0, "e", 1, 2); setvertexgroup(0, "vv", 3, 1);' } },
    q: { type: 'wrangle', in: ['d'], params: { run_over: 'points', code: '@hit = inedgegroup(0, "e", @ptnum, 1) ? 1 : 0; @iv = invertexgroup(0, "even", 0) ? 1 : 0;' } },
    vw: { type: 'wrangle', in: ['q'], params: { run_over: 'vertices', group: 'even', code: '@mark = 1;' } },
  }, 'vw');
  check(sum(g.vertexGroups.get('even')) === 12, 'wrangle @group_x in vertices mode');
  check(g.edgeGroups.get('e')?.size === 2 && sum(g.vertexGroups.get('vv')) === 1, 'wrangle setedgegroup / setvertexgroup');
  const hit = g.points.get('hit')!.data;
  check(hit[0] === 1 && hit[2] === 1 && hit[3] === 0 && g.points.get('iv')!.data[0] === 1, 'wrangle inedgegroup / invertexgroup');
  check(sum(Uint8Array.from(g.vertices.get('mark')!.data as Float64Array)) === 12, 'wrangle group param in vertices mode');
}

// ---------------------------------------------------------------- crease subdivision
{
  const crease = (levels: number, weight: number, extra: Record<string, any> = {}) => cook({
    b: { type: 'box' },
    t: { type: 'group', in: ['b'], params: { class: 'edge', name: 'top', pattern: '@P.y>0.4' } },
    s: { type: 'subdivide', in: ['t'], params: { levels, creases: weight > 0 ? 'top' : '', crease_weight: weight, ...extra } },
  }, 's');
  const ys = (g: Geometry) => { const out: number[] = []; for (let i = 0; i < g.numPoints; i++) out.push(g.P[i * 3 + 1]); return out; };
  const sharp = await crease(3, 10);
  const yS = ys(sharp);
  const onTop = yS.filter((y) => Math.abs(y - 0.5) < 1e-6).length;
  check(Math.max(...yS) <= 0.5 + 1e-6 && onTop >= 81, `crease 10, 3 levels: flat top at y = 0.5 (${onTop} points on it)`);
  // the top face stays planar: every point of a prim touching the top plane... the top region normals point up
  const fn = primNormals(sharp);
  let upFaces = 0;
  for (let p = 0; p < sharp.numPrims; p++) if (fn[p * 3 + 1] > 1 - 1e-9) upFaces++;
  check(upFaces === 64, `crease: 64 flat top faces (got ${upFaces})`);
  const minY = Math.min(...yS);
  let maxX = 0;
  for (let i = 0; i < sharp.numPoints; i++) if (Math.abs(sharp.P[i * 3 + 1]) < 0.05) maxX = Math.max(maxX, Math.abs(sharp.P[i * 3]));
  check(minY > -0.45 && maxX < 0.5 - 0.02, `crease: bottom and sides are rounded (min y ${minY.toFixed(3)}, mid |x| ${maxX.toFixed(3)})`);
  const smooth = await crease(2, 0), semi = await crease(2, 1), hard2 = await crease(2, 10);
  const top = (g: Geometry) => Math.max(...ys(g));
  // how far the surface reaches toward the top x+ edge in the z = 0 plane (x + y; the sharp crease follows
  // a B-spline of the top square, so it stays a bit below 1)
  const reach = (g: Geometry) => { let r = -Infinity; for (let i = 0; i < g.numPoints; i++) if (Math.abs(g.P[i * 3 + 2]) < 1e-9) r = Math.max(r, g.P[i * 3] + g.P[i * 3 + 1]); return r; };
  check(reach(smooth) < reach(semi) - 1e-3 && reach(semi) < reach(hard2) - 1e-3 && Math.abs(top(semi) - 0.5) < 1e-9, `crease 1, 2 levels is between smooth and sharp (${reach(smooth).toFixed(4)} < ${reach(semi).toFixed(4)} < ${reach(hard2).toFixed(4)})`);
  const half = await crease(1, 0.5), s1 = await crease(1, 0), h1 = await crease(1, 10);
  check(reach(s1) < reach(half) - 1e-3 && reach(half) < reach(h1) - 1e-3, `crease 0.5 blends sharp and smooth rules (${reach(s1).toFixed(4)} < ${reach(half).toFixed(4)} < ${reach(h1).toFixed(4)})`);
  // creaseweight attribute (vertex class, Houdini convention: both corners carry the weight)
  const viaAttr = await cook({
    b: { type: 'box' },
    a: { type: 'wrangle', in: ['b'], params: { run_over: 'vertices', code: 'f@creaseweight = @P.y > 0 && primpoints(0, @primnum).every((q) => point(0, "P", q).y > 0) ? 10 : 0;' } },
    s: { type: 'subdivide', in: ['a'], params: { levels: 3 } },
  }, 's');
  check(Math.abs(top(viaAttr) - 0.5) < 1e-9 && ys(viaAttr).filter((y) => Math.abs(y - 0.5) < 1e-6).length >= 81 && viaAttr.vertices.has('creaseweight'), 'creaseweight vertex attribute creases the top and propagates');
  const viaPoint = await cook({
    b: { type: 'box' },
    a: { type: 'attrib_create', in: ['b'], params: { name: 'creaseweight', class: 'point', value: 10, group: '@P.y>0' } },
    s: { type: 'subdivide', in: ['a'], params: { levels: 2 } },
  }, 's');
  check(Math.abs(top(viaPoint) - 0.5) < 1e-9, 'creaseweight point attribute (both endpoints) creases the top');
  // chaining: weight 2 over 1+1 levels == weight 2 over 2 levels (sharpness carried in the attribute)
  const chained = await cook({
    b: { type: 'box' },
    a: { type: 'attrib_create', in: ['b'], params: { name: 'creaseweight', class: 'point', value: 2, group: '@P.y>0' } },
    s1: { type: 'subdivide', in: ['a'], params: { levels: 1 } },
    s2: { type: 'subdivide', in: ['s1'], params: { levels: 1 } },
    s: { type: 'subdivide', in: ['a'], params: { levels: 2 } },
  }, 's2');
  const direct = await cook({
    b: { type: 'box' },
    a: { type: 'attrib_create', in: ['b'], params: { name: 'creaseweight', class: 'point', value: 2, group: '@P.y>0' } },
    s: { type: 'subdivide', in: ['a'], params: { levels: 2 } },
  }, 's');
  check(Math.abs(top(chained) - top(direct)) < 1e-12 && chained.numPoints === direct.numPoints, 'crease sharpness carries over chained subdivide nodes');
  // corner: 3 creases meeting stay fixed
  const corner = await cook({
    b: { type: 'box' },
    s: { type: 'subdivide', in: ['b'], params: { levels: 3, creases: '*', crease_weight: 10 } },
  }, 's');
  check(Math.abs(Math.max(...ys(corner)) - 0.5) < 1e-12 && corner.bbox().max[0] === 0.5, 'all edges creased: box corners stay fixed');
}

// ---------------------------------------------------------------- hard-edge normals
{
  const vn = async (params: Record<string, any>) => cook({ b: { type: 'box' }, n: { type: 'normal', in: ['b'], params: { class: 'vertex', ...params } } }, 'n');
  const faceAligned = (g: Geometry) => {
    const fn = primNormals(g), N = g.vertices.get('N')!.data as Float64Array, vp = g.vertexPrims();
    let worst = 0;
    for (let v = 0; v < g.numVertices; v++) {
      const p = vp[v];
      worst = Math.max(worst, 1 - (N[v * 3] * fn[p * 3] + N[v * 3 + 1] * fn[p * 3 + 1] + N[v * 3 + 2] * fn[p * 3 + 2]));
    }
    return worst < 1e-12;
  };
  check(!faceAligned(await vn({ cusp_angle: 180 })), 'cusp 180 without hard edges: smooth corners (control)');
  check(faceAligned(await vn({ cusp_angle: 180, hard_edges: '*' })), 'hard_edges = all edges: face-aligned vertex normals');
  const partial = await vn({ cusp_angle: 180, hard_edges: '@P.y>0.4' });
  const N = partial.vertices.get('N')!.data as Float64Array, vp = partial.vertexPrims(), fn = primNormals(partial);
  let topOk = true;
  for (let v = 0; v < partial.numVertices; v++) if (fn[vp[v] * 3 + 1] > 0.9 && N[v * 3 + 1] < 1 - 1e-12) topOk = false;
  check(topOk, 'hard rim: the top face is flat-shaded, sides stay smooth across vertical edges');
}

// ---------------------------------------------------------------- quad triangulation and triangle health
{
  const quad = (pts: number[][], scale = 1) => {
    const b = new GeoBuilder();
    for (const [x, y, z] of pts) b.addPoint(x * scale, y * scale, z * scale);
    b.addPrim(pts.map((_, i) => i));
    return b.build();
  };
  /** Smallest triangle area along the polygon normal (negative = flipped), total triangle area and polygon area. */
  const triHealth = (g: Geometry) => {
    const { tris, triPrim } = triangulate(g), fn = primNormals(g), P = g.P, vp = g.vertexPoint;
    let minSigned = Infinity, sum = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = vp[tris[t]] * 3, b = vp[tris[t + 1]] * 3, c = vp[tris[t + 2]] * 3, f = triPrim[t / 3] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
      const s = 0.5 * ((uy * wz - uz * wy) * fn[f] + (uz * wx - ux * wz) * fn[f + 1] + (ux * wy - uy * wx) * fn[f + 2]);
      minSigned = Math.min(minSigned, s); sum += s;
    }
    let area = 0;
    for (let p = 0; p < g.numPrims; p++) area += primArea(g, p);
    return { minSigned, sum, area };
  };
  const firstDiag = (g: Geometry) => { const t = triangulate(g).tris; return t[0] === 0 && t[2] === 2 ? '02' : t[0] === 1 && t[2] === 3 ? '13' : `${t[0]}${t[2]}`; };

  check(firstDiag(quad([[0, 0, 0], [1, 0, 0], [1.2, 1, 0], [0, 1, 0]])) === '02', 'healthy quad keeps the 0-2 diagonal (existing triangulation preserved)');
  // corner 1 lies exactly on the segment 0-2: the 0-2 diagonal would make a zero-area triangle
  const collinear = [[0, 0, 0], [1, 0.5, 0], [2, 1, 0], [0, 1, 0]];
  for (const scale of [1, 1e-4, 1e4]) {
    const g = quad(collinear, scale), h = triHealth(g), r = triangleReport(g);
    check(firstDiag(g) === '13' && h.minSigned > 1e-3 * h.area && Math.abs(h.sum - h.area) < 1e-12 * h.area,
      `collinear-corner quad at scale ${scale}: 1-3 diagonal, both triangles keep area and winding, coverage exact`);
    check(r.degenerate === 0 && r.nearDegenerate === 0, `collinear-corner quad at scale ${scale}: triangleReport sees no slivers`);
  }
  const hc = triHealth(quad([[0, 0, 0], [2, 0, 0], [0.5, 0.5, 0], [0, 2, 0]]));
  check(hc.minSigned > 0 && Math.abs(hc.sum - hc.area) < 1e-12 * hc.area, 'concave dart quad: both triangles face the polygon normal, coverage exact');
  const hr = triHealth(quad([[0, 1, 0], [2, 1, 0], [1, 0.5, 0], [0, 0, 0]]));
  check(hr.minSigned > 0 && Math.abs(hr.sum - hr.area) < 1e-12 * hr.area, 'clockwise collinear-corner quad: triangles follow the winding, coverage exact');
  // a genuinely collapsed quad still triangulates and is reported, not hidden
  const rf = triangleReport(quad([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]));
  check(rf.triangles === 2 && rf.degenerate === 2 && rf.degeneratePrims.join() === '0' && rf.minArea === 0, 'collapsed quad keeps both triangles and reports them degenerate (prim 0)');

  // Uzi guard regression: boolean then bevel left two quads whose first diagonal was a zero-area sliver
  const spec = JSON.parse(readFileSync(new URL('./data/guard-bevel.graph.json', import.meta.url), 'utf8'));
  const g = (await engine.cook(spec, { target: 'post_cut_bevel' })).geo!;
  const r = triangleReport(g), t = topologyReport(g);
  check(r.triangles === 346 && r.degenerate === 0 && r.nearDegenerate === 0 && r.minArea > 1e-9,
    `guard bevel: 346 triangles, none degenerate or near-degenerate (min area ${r.minArea.toExponential(2)}, min quality ${r.minQuality.toExponential(2)})`);
  check(t.closed && t.degenerate === 0, 'guard bevel: still a closed manifold with no degenerate polygons');
  // projected (signed, along each polygon's Newell normal) triangle areas sum to the polygon's area, also for the
  // non-planar bevel corners, and the triangle mesh is closed with consistent winding: every directed edge once,
  // its reverse once
  const { tris, triPrim } = triangulate(g), fn = primNormals(g), per = new Float64Array(g.numPrims), P = g.P, vp = g.vertexPoint;
  const directed = new Map<string, number>();
  for (let k = 0; k < tris.length; k += 3) {
    const a = vp[tris[k]] * 3, b = vp[tris[k + 1]] * 3, c = vp[tris[k + 2]] * 3, f = triPrim[k / 3] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const s = 0.5 * ((uy * wz - uz * wy) * fn[f] + (uz * wx - ux * wz) * fn[f + 1] + (ux * wy - uy * wx) * fn[f + 2]);
    for (const [x, y] of [[a, b], [b, c], [c, a]]) directed.set(`${x / 3}>${y / 3}`, (directed.get(`${x / 3}>${y / 3}`) ?? 0) + 1);
    per[triPrim[k / 3]] += s;
  }
  let cover = 0;
  for (let p = 0; p < g.numPrims; p++) cover = Math.max(cover, Math.abs(per[p] - primArea(g, p)) / primArea(g, p));
  let windingOk = true;
  for (const [k, cnt] of directed) { const [x, y] = k.split('>'); if (cnt !== 1 || directed.get(`${y}>${x}`) !== 1) windingOk = false; }
  check(cover < 1e-9 && windingOk, `guard bevel: every polygon's triangles cover its projected area (worst relative error ${cover.toExponential(2)}); triangle mesh closed with consistent winding`);
  check(/346 render\/export triangles; .* 0 degenerate, 0 near-degenerate/.test(inspect(g, { detail: 'topology' })), 'inspect topology reports render/export triangle health');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
