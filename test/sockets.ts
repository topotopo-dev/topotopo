// Scene empties (scene_null, core/scene.ts) exported as meshless glTF nodes: hierarchy, local transforms under empties
// and transformed meshes, export axis/scale, ordinary points, invalid parents, and the GLB round trip.
//   node test/sockets.ts
import '../src/nodes/index.ts';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import type { Node as GNode } from '@gltf-transform/core';
import { createRequire } from 'node:module';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { HostIO, exportGLB, importGLTFAsync } from '../src/io/gltf.ts';
import type { ExportOptions } from '../src/io/common.ts';
import type { Geometry } from '../src/core/geometry.ts';
import type { NodeSpec } from '../src/graph/types.ts';
import { sceneEmpties } from '../src/core/scene.ts';
import { previewGLB } from '../src/render/preview.ts';
import { m4fromQuat, m4trs, qFromMat } from '../src/core/math.ts';
import type { Vec3 } from '../src/core/math.ts';

const validator = createRequire(import.meta.url)('gltf-validator');
const engine = new Engine(createNodeHost());
await engine.init();

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
async function cook(nodes: Record<string, NodeSpec>, output: string): Promise<Geometry> {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return r.geo;
}
const doc = async (bytes: Uint8Array) => new HostIO().registerExtensions(ALL_EXTENSIONS).readBinary(bytes);
const nodeNamed = (d: Awaited<ReturnType<typeof doc>>, name: string) => d.getRoot().listNodes().filter((n) => n.getName() === name);
/** World matrix of an empty as the geometry describes it (translation, orient, scale). */
const expected = (t: Vec3, rDeg: Vec3, s: Vec3 = [1, 1, 1]) => m4trs(t, rDeg, s);
const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol = 1e-9) => a.length === b.length && Array.from(a).every((x, i) => Math.abs(x - b[i]) <= tol);
const throwsWith = async (f: () => Promise<unknown>, re: RegExp) => { try { await f(); return ''; } catch (e: any) { return re.test(e.message) ? e.message : `wrong error: ${e.message}`; } };

const named = (name: string, input: string): NodeSpec => ({ type: 'attrib_create', in: [input], params: { name: 'name', class: 'prim', value: name } });
const BODY: Record<string, NodeSpec> = {
  box: { type: 'box', params: { size: [0.06, 0.1, 0.3] } },
  body: named('housing', 'box'),
  m0: { type: 'box', params: { size: [0.03, 0.12, 0.04], center: [0, -0.06, 0.08] } },
  glass: named('glass_lod0', 'm0'),
  both: { type: 'merge', in: ['body', 'glass'] },
};

// ---------------------------------------------------------------- nested empties and a mesh parent
{
  const g = await cook({
    ...BODY,
    a: { type: 'scene_null', in: ['both'], params: { name: 'wick', parent: 'housing', translation: [0, 0.02, -0.15], rotation: [0, 30, 0] } },
    b: { type: 'scene_null', in: ['a'], params: { name: 'flame', parent: 'wick', translation: [0.01, 0.03, -0.2], rotation: [10, 0, 45], scale: [2, 2, 2] } },
    c: { type: 'scene_null', in: ['b'], params: { name: 'spark', parent: 'flame', translation: [0, 0.05, -0.25] } },
    d: { type: 'scene_null', in: ['c'], params: { name: 'glass_socket', parent: 'glass_lod0', translation: [0, -0.1, 0.08], rotation: [0, 0, 180] } },
    e: { type: 'scene_null', in: ['d'], params: { name: 'root_socket', translation: [1, 2, 3] } },
  }, 'e');
  check(sceneEmpties(g).length === 5, 'scene_null adds marked isolated points (5 empties)');
  const bytes = await exportGLB(g);
  const v = await validator.validateBytes(bytes, { maxIssues: 100, writeTimestamp: false });
  check(v.issues.numErrors === 0, `validator: ${v.issues.numErrors} errors`);
  const d = await doc(bytes);
  const prims = d.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
  check(prims.every((p) => p.getMode() !== 0), 'no POINTS primitive: empties are not written as geometry');
  const [wk] = nodeNamed(d, 'wick'), [fl] = nodeNamed(d, 'flame'), [sp] = nodeNamed(d, 'spark'), [ms] = nodeNamed(d, 'glass_socket'), [rs] = nodeNamed(d, 'root_socket');
  check(wk && !wk.getMesh() && wk.getParentNode()?.getName() === 'housing', 'wick: meshless node under the housing mesh node');
  check(fl?.getParentNode() === wk && sp?.getParentNode() === fl, 'flame under wick, spark under flame (nested empties)');
  check(ms?.getParentNode()?.getName() === 'glass_lod0' && !!ms.getParentNode()?.getMesh(), 'glass_socket under the separate glass mesh');
  check(rs && !rs.getParentNode() && d.getRoot().listScenes()[0].listChildren().includes(rs), 'root_socket at the scene root');
  const W = (n: GNode) => n.getWorldMatrix();
  check(close(W(wk), expected([0, 0.02, -0.15], [0, 30, 0])), 'wick world matrix = its geometry-space transform');
  check(close(W(fl), expected([0.01, 0.03, -0.2], [10, 0, 45], [2, 2, 2])), 'flame (rotated, scaled, under a rotated empty): world matrix exact');
  check(close(W(sp), expected([0, 0.05, -0.25], [0, 0, 0])) && close(sp.getScale(), [0.5, 0.5, 0.5]), 'spark under a scaled empty: world exact, local scale compensates (0.5)');
  check(close(W(ms), expected([0, -0.1, 0.08], [0, 0, 180])), 'glass_socket world matrix exact');
  check(close(wk.getTranslation(), [0, 0.02, -0.15]) && !close(fl.getTranslation(), [0.01, 0.03, -0.2]), 'local translations: under an unmoved mesh node = geometry space; under a rotated empty = relative to it');

  // transformed mesh parent: quantization puts a translation + scale on mesh nodes
  const q = await doc(await exportGLB(g, { quantize: true }));
  const [qm] = nodeNamed(q, 'wick'), [qms] = nodeNamed(q, 'glass_socket');
  const rec = qm.getParentNode()!;
  check(!close(rec.getScale(), [1, 1, 1]) && close(qm.getWorldMatrix(), expected([0, 0.02, -0.15], [0, 30, 0]), 1e-9) && close(qms.getWorldMatrix(), expected([0, -0.1, 0.08], [0, 0, 180]), 1e-9),
    `quantized export (mesh nodes scaled ${rec.getScale().map((x) => +x.toFixed(3)).join(', ')}): empties keep their world placement`);

  // export space: Z-up and centimetres
  const opt: ExportOptions = { upAxis: 'z', scale: 100 };
  const z = await doc(await exportGLB(g, opt));
  const zm = nodeNamed(z, 'wick')[0].getWorldMatrix();
  const want = expected([0, 0.02, -0.15], [0, 30, 0]);
  // C = (x, y, z) → (x, -z, y): translation converted and scaled, rotation conjugated, no scale on the empty itself
  const C = (v: number[]) => [v[0], -v[2], v[1]];
  const tw = C([want[12], want[13], want[14]]).map((x) => x * 100);
  const cols = [0, 1, 2].map((c) => C([want[c * 4], want[c * 4 + 1], want[c * 4 + 2]]));
  const conj = [cols[0], cols[2].map((x) => -x), cols[1]];
  check(close([zm[12], zm[13], zm[14]], tw, 1e-9) && close([...conj[0], ...conj[1], ...conj[2]], [zm[0], zm[1], zm[2], zm[4], zm[5], zm[6], zm[8], zm[9], zm[10]], 1e-12),
    'up_axis z + scale 100: the empty is placed in export space (translation ×100, rotation converted, unit scale)');

  // round trip: import keeps markers, names, parents and transforms; re-export gives the same nodes
  const back = await importGLTFAsync(bytes);
  const e2 = sceneEmpties(back), byN = new Map(e2.map((e) => [e.name, e]));
  check(e2.length === 5 && byN.get('flame')?.parent === 'wick' && byN.get('glass_socket')?.parent === 'glass_lod0' && byN.get('root_socket')?.parent === '', 'import: empties come back marked, with names and parents');
  const fe = byN.get('flame')!;
  check(close(m4trs(fe.P, [0, 0, 0], fe.scale), expected([0.01, 0.03, -0.2], [0, 0, 0], [2, 2, 2]), 1e-6) && close(qFromMat(m4fromQuat(fe.orient)), qFromMat(expected([0, 0, 0], [10, 0, 45])), 1e-6), 'import: world P / orient / scale of a nested empty');
  const again = await doc(await exportGLB(back));
  const same = ['wick', 'flame', 'spark', 'glass_socket', 'root_socket'].every((n) => {
    const a = nodeNamed(d, n)[0], b = nodeNamed(again, n)[0];
    return b && b.getParentNode()?.getName() === a.getParentNode()?.getName() && close(a.getWorldMatrix(), b.getWorldMatrix(), 1e-6);
  });
  check(same, 'GLB → import → GLB: the same empties under the same parents at the same world transforms');
}

// ---------------------------------------------------------------- ordinary points, extras
{
  const pts = await cook({ p: { type: 'point_grid', params: { counts: [2, 1, 1] } }, s: { type: 'scene_null', in: ['p'], params: { name: 'tip' } }, f: { type: 'wrangle', in: ['s'], params: { snippet: 'if (i@scene_empty) v@forward = set(0, 0, -1);' } } }, 'f');
  const d = await doc(await exportGLB(pts));
  const points = d.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).filter((p) => p.getMode() === 0);
  check(points.length === 1 && points[0].getAttribute('POSITION')!.getCount() === 2, 'ordinary loose points still export as one POINTS primitive (2 points, the empty left out)');
  const [tip] = nodeNamed(d, 'tip');
  check(JSON.stringify(tip?.getExtras()) === JSON.stringify({ forward: [0, 0, -1] }), `set attributes on an empty become node extras (${JSON.stringify(tip?.getExtras())})`);
  const back = await importGLTFAsync(await exportGLB(pts));
  const e = sceneEmpties(back)[0];
  check(e && close(back.points.get('forward')!.get(e.point) as number[], [0, 0, -1]), 'node extras come back as point attributes on import');
}

// ---------------------------------------------------------------- invalid parents
{
  const empty = (name: string, parent: string, input: string): NodeSpec => ({ type: 'scene_null', in: [input], params: { name, parent } });
  const missing = await cook({ ...BODY, a: empty('a', 'nowhere', 'both') }, 'a');
  check(await throwsWith(() => exportGLB(missing), /parent "nowhere" is neither an empty nor a mesh/), 'a missing parent is an export error');
  const dup = await cook({ ...BODY, a: empty('x', '', 'both'), b: empty('x', '', 'a'), c: empty('child', 'x', 'b') }, 'c');
  check(await throwsWith(() => exportGLB(dup), /parent "x" is ambiguous: 2 empties/), 'a parent name shared by two empties is ambiguous');
  const clash = await cook({ ...BODY, a: empty('housing', '', 'both'), c: empty('child', 'housing', 'a') }, 'c');
  check(await throwsWith(() => exportGLB(clash), /ambiguous: 1 empty and 1 mesh/), 'a parent name shared by an empty and a mesh is ambiguous');
  const cyc = await cook({ ...BODY, a: empty('a', 'b', 'both'), b: empty('b', 'c', 'a'), c: empty('c', 'a', 'b') }, 'c');
  check(await throwsWith(() => exportGLB(cyc), /parent cycle: a → b → c → a/), 'a parent cycle is an export error naming the cycle');
  const inst = await cook({
    pt: { type: 'point_grid', params: { counts: [2, 1, 1] } }, b: { type: 'box', params: { size: [0.1, 0.1, 0.1] } }, nb: named('crate', 'b'),
    c: { type: 'copy_to_points', in: ['nb', 'pt'], params: { pack: true } }, s: empty('handle', 'crate', 'c'),
  }, 's');
  const instErr = await throwsWith(() => exportGLB(inst), /GPU-instanced mesh/);
  check(instErr && !instErr.startsWith('wrong'), `parenting to a GPU-instanced mesh is rejected (${instErr})`);
  const self = await engine.cook({ nodes: { s: { type: 'scene_null', params: { name: 'a', parent: 'a' } } }, output: 's' });
  check(!self.ok && /own parent/.test(self.errors[0]?.message ?? ''), 'scene_null rejects itself as parent');
  const used = (await cook({ ...BODY, a: empty('a', '', 'both') }, 'a')).clone();
  used.vertexPoint[0] = sceneEmpties(used)[0].point;
  check(await throwsWith(() => exportGLB(used), /used by a primitive/), 'a marked point used by a primitive is an error, not a silent mesh vertex');
}

// ---------------------------------------------------------------- the empties' attributes stay off the meshes
{
  const g = await cook({ ...BODY, a: { type: 'scene_null', in: ['both'], params: { name: 'wick', parent: 'housing', translation: [0, 0, -0.2], rotation: [0, -90, 0] } } }, 'a');
  const d = await doc(await exportGLB(g));
  const sem = d.getRoot().listMeshes().flatMap((m) => m.listPrimitives().flatMap((p) => p.listSemantics()));
  check(!sem.some((x) => /^_/.test(x)), `default export: mesh primitives carry no custom channels (${[...new Set(sem)].join(', ')})`);
  // asked for custom attributes: the mesh's own come along, the empties' marker, parent, orient, scale and extras do not
  const worn = await cook({
    ...BODY,
    wear: { type: 'attrib_create', in: ['both'], params: { name: 'wear', class: 'point', value: 0.25 } },
    a: { type: 'scene_null', in: ['wear'], params: { name: 'wick', parent: 'housing', translation: [0, 0, -0.2], rotation: [0, -90, 0], scale: [2, 2, 2] } },
    fwd: { type: 'wrangle', in: ['a'], params: { snippet: 'if (i@scene_empty) v@forward = set(0, 0, -1);' } },
  }, 'fwd');
  const dc = await doc(await exportGLB(worn, { custom: true }));
  const semc = [...new Set(dc.getRoot().listMeshes().flatMap((m) => m.listPrimitives().flatMap((p) => p.listSemantics())))];
  check(semc.includes('_WEAR') && !semc.some((x) => /^_(SCENE_EMPTY|PARENT|ORIENT|SCALE|FORWARD)$/.test(x)), `custom attributes: the mesh's own _WEAR, none of the empties' (${semc.join(', ')})`);
  const wick = nodeNamed(dc, 'wick')[0];
  check(wick && close((wick.getExtras() as any)?.forward ?? [], [0, 0, -1]), 'the empty keeps its extra as node extras');
  // the gallery's preview GLB merges every mesh into one node: a mesh-parented empty goes on the root, in place
  const pv = await doc(await previewGLB(g));
  const m = nodeNamed(pv, 'wick')[0];
  check(m && !m.getParentNode() && close(m.getTranslation(), [0, 0, -0.2], 1e-6), 'preview GLB: an empty parented to a mesh lands on the scene root at its position');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
