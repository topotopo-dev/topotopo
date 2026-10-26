// Tangent space: MikkTSpace TANGENT in glTF export and import, the tangents export policy, transforms of a supplied
// tangent attribute, and bake_normal agreeing with the exported frame.
//   node test/tangents.ts
import '../src/nodes/index.ts';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { HostIO, exportGLB, importGLTFAsync } from '../src/io/gltf.ts';
import type { Geometry } from '../src/core/geometry.ts';
import type { NodeSpec } from '../src/graph/types.ts';
import type { ExportOptions } from '../src/io/common.ts';
import { loadMikkTSpace, mikkTangents, shadingFrame } from '../src/core/tangents.ts';
import { bakeSamples, interpolate } from '../src/core/bake.ts';
import { triangulate } from '../src/core/topology.ts';
import { referenceableImages } from '../src/core/image.ts';

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
const glb = async (g: Geometry, o: ExportOptions = {}) => {
  const warnings: string[] = [];
  const bytes = await exportGLB(g, { deflate: (d) => zlib.deflateSync(d), warn: (m) => warnings.push(m), ...o });
  return { bytes, warnings };
};
const validate = async (bytes: Uint8Array) => {
  const r = await validator.validateBytes(bytes, { maxIssues: 1000, writeTimestamp: false });
  const codes = (r.issues.messages as any[]).map((m) => m.code as string);
  return { errors: r.issues.numErrors as number, codes, generated: codes.filter((c) => c === 'MESH_PRIMITIVE_GENERATED_TANGENT_SPACE').length };
};
/** Every primitive of a GLB: whether its material has a normal map and its TANGENT / NORMAL arrays. */
async function primitives(bytes: Uint8Array) {
  const doc = await new HostIO().registerExtensions(ALL_EXTENSIONS).readBinary(bytes);
  const out: { normalMapped: boolean; T: Float32Array | null; N: Float32Array | null; count: number }[] = [];
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const t = p.getAttribute('TANGENT'), n = p.getAttribute('NORMAL');
    out.push({ normalMapped: !!p.getMaterial()?.getNormalTexture(), T: t ? (t.getArray() as Float32Array) : null, N: n ? (n.getArray() as Float32Array) : null, count: p.getAttribute('POSITION')!.getCount() });
  }
  return out;
}
const reimport = (bytes: Uint8Array) => importGLTFAsync(bytes);
/** Valid glTF tangents: unit xyz perpendicular to the normal, w exactly ±1. */
function tangentHealth(T: Float32Array, N: Float32Array) {
  let worstLen = 0, worstDot = 0, badW = 0;
  for (let i = 0; i < T.length / 4; i++) {
    const x = T[i * 4], y = T[i * 4 + 1], z = T[i * 4 + 2], w = T[i * 4 + 3];
    worstLen = Math.max(worstLen, Math.abs(Math.hypot(x, y, z) - 1));
    worstDot = Math.max(worstDot, Math.abs(x * N[i * 3] + y * N[i * 3 + 1] + z * N[i * 3 + 2]));
    if (w !== 1 && w !== -1) badW++;
  }
  return { worstLen, worstDot, badW };
}

const NORMAL_MAP: Record<string, NodeSpec> = {
  noise: { type: 'tex_noise', params: { resolution: 64, seed: 7 } },
  normal: { type: 'tex_normal_from_height', in: ['noise'], params: { name: 'normal', format: 'opengl' } },
};
const withNormalMap = (input: string): Record<string, NodeSpec> => ({ ...NORMAL_MAP, out: { type: 'texture_to_material', in: [input, 'normal'], params: { material: 'test', normal: 'normal' } } });

await loadMikkTSpace();

// ---------------------------------------------------------------- the Uzi repro: box → unwrap → normal-mapped material
{
  const g = await cook({ box: { type: 'box' }, uv: { type: 'uv_unwrap', in: ['box'], params: { resolution: 64 } }, ...withNormalMap('uv') }, 'out');
  const { bytes, warnings } = await glb(g);
  const v = await validate(bytes), prims = await primitives(bytes);
  check(v.errors === 0 && v.generated === 0, `normal-mapped box: validator ${v.errors} errors, ${v.generated} MESH_PRIMITIVE_GENERATED_TANGENT_SPACE (was 1 before TANGENT export)`);
  check(!v.codes.some((c) => c.startsWith('ACCESSOR_')), `no accessor issues (${[...new Set(v.codes)].join(', ') || 'none'})`);
  check(prims.length === 1 && prims[0].normalMapped && !!prims[0].T && prims[0].T.length === prims[0].count * 4, 'the normal-mapped primitive carries a VEC4 TANGENT per vertex');
  const h = tangentHealth(prims[0].T!, prims[0].N!);
  check(h.worstLen < 1e-6 && h.worstDot < 1e-6 && h.badW === 0, `hard-edged box: every tangent unit (${h.worstLen.toExponential(1)}), perpendicular to its split NORMAL (${h.worstDot.toExponential(1)}), w ±1`);
  check(!warnings.length, `no export warnings (${warnings.join('; ')})`);
  const nonce = await glb(g, { tangents: 'none' });
  const vn = await validate(nonce.bytes);
  check(vn.generated === 1 && !(await primitives(nonce.bytes))[0].T, 'tangents "none": no TANGENT, the validator reports the runtime-generated tangent space again');
  const q = await glb(g, { quantize: true });
  const vq = await validate(q.bytes);
  check(vq.errors === 0 && vq.generated === 0 && !vq.codes.some((c) => c.startsWith('ACCESSOR_')), `quantized export: TANGENT as normalized bytes validates (${[...new Set(vq.codes)].join(', ') || 'no issues'})`);

  // import → TANGENT comes back as point tangent; preserve writes it unchanged; auto regenerates the same frame
  const back = await reimport(bytes);
  const ta = back.points.get('tangent');
  check(!!ta && ta.size === 4 && ta.type === 'float', 'import: TANGENT → point attribute "tangent" float[4]');
  const pre = await primitives((await glb(back, { tangents: 'preserve' })).bytes), auto = await primitives((await glb(back)).bytes);
  const same = (a: Float32Array, b: Float32Array, tol: number) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);
  check(same(pre[0].T!, prims[0].T!, 0), 'export → import → export (preserve): TANGENT bit-identical');
  check(same(auto[0].T!, prims[0].T!, 1e-6), 'export → import → export (auto, normal-mapped): MikkTSpace regenerates the same tangents');
}

// ---------------------------------------------------------------- mirrored uv islands and their seam
{
  // a plane facing +Y, u = |x| (left half mirrored), v = z
  const g = await cook({
    grid: { type: 'grid', params: { size: [2, 2], rows: 4, cols: 4 } },
    uvw: { type: 'wrangle', in: ['grid'], params: { snippet: '@uv = set(abs(@P.x) * 0.5, @P.z * 0.5 + 0.5, 0);' } },
    ...withNormalMap('uvw'),
  }, 'out');
  const { bytes } = await glb(g);
  const back = await reimport(bytes), T = back.points.get('tangent')!.data as Float64Array, P = back.P;
  let right = true, left = true, seamPlus = 0, seamMinus = 0;
  for (let i = 0; i < back.numPoints; i++) {
    const x = P[i * 3], t = [T[i * 4], T[i * 4 + 1], T[i * 4 + 2]], w = T[i * 4 + 3];
    if (Math.abs(x) < 1e-6) { if (w > 0) seamPlus++; else seamMinus++; continue; }
    // T = dP/du; bitangent w·(N × T) must be dP/dv = +Z
    if (x > 0 && !(t[0] > 0.999 && w === -1)) right = false;
    if (x < 0 && !(t[0] < -0.999 && w === 1)) left = false;
  }
  check(right && left, 'mirrored uv: T follows +u on each half (+X right, -X left) with opposite handedness, bitangent along +v on both');
  check(seamPlus === 5 && seamMinus === 5, `mirror seam: the 5 seam points are split into a w=+1 and a w=-1 copy (${seamPlus} / ${seamMinus})`);
  const v = await validate(bytes);
  check(v.errors === 0 && v.generated === 0, 'mirrored plane validates with TANGENT');
}

// ---------------------------------------------------------------- uv seams split tangents, smooth shading keeps them shared
{
  const g = await cook({ s: { type: 'sphere', params: { rows: 12, cols: 16 } }, uv: { type: 'uv_unwrap', in: ['s'], params: { resolution: 128 } }, ...withNormalMap('uv') }, 'out');
  const { bytes } = await glb(g);
  const [p] = await primitives(bytes);
  const h = tangentHealth(p.T!, p.N!);
  check(h.worstLen < 1e-6 && h.worstDot < 1e-6 && h.badW === 0, 'unwrapped smooth sphere: unit tangents perpendicular to the smooth normals');
  const noTan = await primitives((await glb(g, { tangents: 'none' })).bytes);
  check(p.count >= noTan[0].count && p.count <= noTan[0].count * 1.1, `tangents add at most 10% vertices to the welded sphere (${noTan[0].count} → ${p.count}): seams split, the rest stays shared`);
}

// ---------------------------------------------------------------- supplied tangents under transforms
{
  // non-orthogonal uv on a plane: the tangent is dP/du, so it transforms exactly with the geometry
  const base: Record<string, NodeSpec> = {
    grid: { type: 'grid', params: { size: [2, 2], rows: 4, cols: 4 } },
    uvw: { type: 'wrangle', in: ['grid'], params: { snippet: '@uv = set(@P.x + 0.5 * @P.z, @P.z - 0.3 * @P.x, 0);' } },
  };
  const src = await reimport((await glb(await cook({ ...base, ...withNormalMap('uvw') }, 'out'))).bytes);
  for (const [label, scale] of [['mirror x', [-1, 1, 1]], ['non-uniform', [2, 1, 0.5]], ['mirror + squash', [1, 0.7, -3]]] as const) {
    // the transform node on the imported geometry (supplied tangent), against MikkTSpace on the transformed source
    const viaNode = (await engine.cook({ nodes: { i: { type: 'input', params: { index: 0 } }, t: { type: 'transform', in: ['i'], params: { scale } } }, output: 't' }, { inputs: [{ geo: src, sig: 'tangent-src' }] })).geo;
    const ref = await reimport((await glb(await cook({ ...base, t: { type: 'transform', in: ['uvw'], params: { scale } }, ...withNormalMap('t') }, 'out'))).bytes);
    if (!viaNode) { check(false, `${label}: transform cook`); continue; }
    const key = (g: Geometry, i: number) => [0, 1, 2].map((c) => Math.round(g.P[i * 3 + c] * 1e4)).join(',');
    const refT = new Map<string, number[]>();
    const rt = ref.points.get('tangent')!.data as Float64Array;
    for (let i = 0; i < ref.numPoints; i++) refT.set(key(ref, i), Array.from(rt.subarray(i * 4, i * 4 + 4)));
    const mt = viaNode.points.get('tangent')!.data as Float64Array;
    let worst = 0, signs = true, matched = 0;
    for (let i = 0; i < viaNode.numPoints; i++) {
      const r = refT.get(key(viaNode, i));
      if (!r) continue;
      matched++;
      worst = Math.max(worst, Math.hypot(mt[i * 4] - r[0], mt[i * 4 + 1] - r[1], mt[i * 4 + 2] - r[2]));
      if (mt[i * 4 + 3] !== r[3]) signs = false;
    }
    check(matched === ref.numPoints && worst < 1e-5 && signs, `${label} ${JSON.stringify(scale)}: transformed supplied tangents equal MikkTSpace on the transformed mesh (max |ΔT| ${worst.toExponential(1)}, handedness ${signs ? 'matches' : 'WRONG'})`);
  }
}

// ---------------------------------------------------------------- the policy: malformed, supplied without a normal map, collapsed uv
{
  const bad = await cook({ b: { type: 'box' }, t: { type: 'wrangle', in: ['b'], params: { snippet: 'p@tangent = set(1, 1, 0, 1);' } } } as any, 't');
  let threw = '';
  try { await glb(bad, { tangents: 'preserve' }); } catch (e: any) { threw = e.message; }
  check(/preserve.*unit length/.test(threw), `preserve rejects a malformed tangent attribute (${threw.slice(0, 90)})`);
  const auto = await glb(bad);
  check(auto.warnings.some((w) => w.includes('not written')) && !(await primitives(auto.bytes))[0].T, 'auto drops a malformed supplied tangent with a warning');
  const good = await cook({ b: { type: 'box' }, t: { type: 'wrangle', in: ['b'], params: { snippet: 'p@tangent = set(0, 0, 1, -1);' } } } as any, 't');
  const kept = await primitives((await glb(good)).bytes);
  check(!!kept[0].T && kept[0].T[2] === 1 && kept[0].T[3] === -1, 'auto writes a valid supplied tangent on a primitive without a normal map');
  const flat = await cook({ box: { type: 'box' }, uvz: { type: 'wrangle', in: ['box'], params: { run_over: 'vertices', snippet: 'v@uv = set(0.5, 0.5, 0);' } }, ...withNormalMap('uvz') }, 'out');
  const fl = await glb(flat);
  const vf = await validate(fl.bytes), [fp] = await primitives(fl.bytes);
  const hf = tangentHealth(fp.T!, fp.N!);
  check(fl.warnings.some((w) => /12 of 12 triangles have collapsed uvs/.test(w)), `collapsed uvs are reported (${fl.warnings.find((w) => w.includes('collapsed'))?.slice(0, 110)})`);
  check(vf.errors === 0 && hf.worstLen < 1e-6 && hf.worstDot < 1e-6 && hf.badW === 0, 'collapsed uvs: fallback tangents are still valid (unit, perpendicular, w ±1)');
  const nan = mikkTangents([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 0, NaN, 0, 0, 1]);
  check(nan.diag.uvNonFinite === 1 && nan.diag.fallbackCorners === 3 && [...nan.tangents].every(Number.isFinite), 'non-finite uvs: counted, fallback tangents finite');
}

// ---------------------------------------------------------------- bake_normal decodes with the exported frame
{
  const R = 64;
  const nodes: Record<string, NodeSpec> = {
    low: { type: 'box', params: { divisions: [2, 2, 2] } },
    uv: { type: 'uv_unwrap', in: ['low'], params: { resolution: R } },
    high: { type: 'subdivide', in: ['low'], params: { levels: 3 } },
    tn: { type: 'bake_normal', in: ['uv', 'high'], params: { resolution: R, cage: 0.4, padding: 0, name: 'normal' } },
    wn: { type: 'bake_world_normal', in: ['uv', 'high'], params: { resolution: R, cage: 0.4, padding: 0 } },
    mat: { type: 'texture_to_material', in: ['uv', 'tn'], params: { material: 'baked', normal: 'normal' } },
  };
  const tn = [...referenceableImages(await cook(nodes, 'tn')).values()][0], wn = [...referenceableImages(await cook(nodes, 'wn')).values()][0];
  const low = await reimport((await glb(await cook(nodes, 'mat'))).bytes);
  // the exported mesh, rasterised like a renderer: interpolated NORMAL and TANGENT per texel
  const { tris } = triangulate(low);
  const vt = (name: string, size: number) => { const d = low.points.get(name)!.data as Float64Array; return Float64Array.from({ length: low.numVertices * size }, (_, k) => d[low.vertexPoint[Math.floor(k / size)] * size + (k % size)]); };
  const s = bakeSamples(vt('uv', 3).filter((_, k) => k % 3 < 2), tris, R, R, 1);
  const N = interpolate(s, tris, vt('N', 3), 3), T = interpolate(s, tris, vt('tangent', 4), 4);
  const tc = tn.layer('C')!, wc = wn.layer('C')!, mask = tn.layer('mask')!;
  const f = new Float64Array(9);
  let n = 0, sum = 0, worst = 0;
  for (let k = 0; k < s.n; k++) {
    const px = s.texel[k];
    if (mask[px] < 1 || !shadingFrame(N[k * 3], N[k * 3 + 1], N[k * 3 + 2], T[k * 4], T[k * 4 + 1], T[k * 4 + 2], T[k * 4 + 3], f)) continue;
    const x = tc[px * 4] * 2 - 1, y = tc[px * 4 + 1] * 2 - 1, z = tc[px * 4 + 2] * 2 - 1;
    const d = [0, 1, 2].map((c) => x * f[c] + y * f[3 + c] + z * f[6 + c]);
    const e = [0, 1, 2].map((c) => wc[px * 4 + c] * 2 - 1);
    const ang = Math.acos(Math.min(1, (d[0] * e[0] + d[1] * e[1] + d[2] * e[2]) / Math.hypot(...d) / Math.hypot(...e))) * 180 / Math.PI;
    n++; sum += ang; worst = Math.max(worst, ang);
  }
  check(n > 0.5 * R * R * 0.4 && sum / n < 0.05 && worst < 0.5, `bake_normal decoded with the exported TANGENT/NORMAL equals bake_world_normal (${n} texels, mean ${(sum / n).toFixed(4)}°, max ${worst.toFixed(3)}°)`);
}

// ---------------------------------------------------------------- a merged high mesh with partial N bakes no grey texels
{
  // merge fills N with zeros on the parts that had none; those must bake with computed normals, not as (0.5, 0.5, 0.5)
  const R = 64;
  const nodes: Record<string, NodeSpec> = {
    low: { type: 'box', params: { size: [0.1, 0.1, 0.1] } },
    uv: { type: 'uv_unwrap', in: ['low'], params: { resolution: R } },
    hb: { type: 'poly_bevel', in: ['low'], params: { offset: 0.01, divisions: 4 } },
    hbn: { type: 'attrib_delete', in: ['hb'], params: { pattern: 'N' } },
    dot: { type: 'sphere', params: { radius: 0.004, center: [0, 0.05, 0] } },
    dotn: { type: 'normal', in: ['dot'], params: { class: 'point' } },
    high: { type: 'merge', in: ['hbn', 'dotn'] },
    tn: { type: 'bake_normal', in: ['uv', 'high'], params: { resolution: R, padding: 0, name: 'normal' } },
  };
  const img = [...referenceableImages(await cook(nodes, 'tn')).values()][0];
  const c = img.layer('C')!, mask = img.layer('mask')!;
  let grey = 0, n = 0;
  for (let px = 0; px < R * R; px++) if (mask[px] >= 1) { n++; if (c[px * 4 + 2] < 0.6) grey++; }
  check(n > 0 && grey === 0, `bake_normal: a merged high mesh whose N is partly zero bakes no grey texels (${grey} of ${n})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
