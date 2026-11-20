// Vectors in a wrangle are plain arrays and the language has no operator overloading: `-v@N`, `v@N * -1`, `v@N *= 2`,
// `v@a + v@b` used to turn the vector into NaN (or a string) and write that into the attribute without a word. They now
// fail with what to write instead, and the functions that do the work (neg, mul, div, add, sub) give exact values, on
// points, prims and vertices, with the worker pool on and off.
//   node test/wrangle-vectors.ts
import './cache-guard.ts';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import { createNodeHost } from '../src/host/node.ts';
import type { Geometry } from '../src/core/geometry.ts';
import { fingerprint } from './fingerprint.ts';

let fail = 0, pass = 0;
const check = (ok: any, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};

const newEngine = async (workers: number, minElements?: number) => {
  const e = new Engine(createNodeHost({ workers, pool: minElements !== undefined ? { minElements } : undefined }));
  await e.init();
  return e;
};
const off = await newEngine(0);
const on = await newEngine(4, 1); // every point wrangle goes to the pool, whatever its size

const SRC: Record<string, NodeSpec> = {
  box: { type: 'box', params: { divisions: [3, 3, 3] } },
  // a grid with point normals: @N is a real attribute
  grid: { type: 'grid', params: { size: [2, 2], divisions: [8, 8] } },
  n: { type: 'normal', in: ['grid'], params: { class: 'point' } },
};

type Over = 'points' | 'prims' | 'vertices';
const OVERS: Over[] = ['points', 'prims', 'vertices'];
const TABLE = { points: 'points', prims: 'prims', vertices: 'vertices' } as const;

/** a wrangle over `over` on the box, once with the pool off and once on; both must agree bit for bit */
async function run(code: string, over: Over, vars: Record<string, any> = {}, source = 'box') {
  const graph: GraphSpec = { vars, nodes: { ...SRC, w: { type: 'wrangle', in: [source], params: { run_over: over, code } } }, output: 'w' } as any;
  off.cache.clear(); on.cache.clear();
  const a = await off.cook(structuredClone(graph));
  const b = await on.cook(structuredClone(graph));
  const same = a.ok === b.ok
    && JSON.stringify(a.errors.map((e) => e.message)) === JSON.stringify(b.errors.map((e) => e.message))
    && (!a.geo || !b.geo || JSON.stringify(fingerprint(a.geo)) === JSON.stringify(fingerprint(b.geo)));
  return { ...a, same };
}

const read = (g: Geometry, over: Over, name: string, i = 0): number[] => {
  const t = g[TABLE[over]];
  const a = t.get(name);
  if (!a) return [];
  const v: any = a.get(i);
  return typeof v === 'number' ? [v] : Array.from(v as ArrayLike<number>);
};
/** every float entry of every attribute of a table is finite */
const finite = (g: Geometry, over: Over): boolean => {
  const t = g[TABLE[over]];
  for (const n of t.names()) {
    const a = t.get(n)!;
    if (a.type !== 'float' || a.isArray) continue;
    for (let i = 0; i < a.data.length; i++) if (!Number.isFinite(a.data[i])) return false;
  }
  return true;
};
const near = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);

// ------------------------------------------------------------------ the functions that negate and scale: exact values

const D = [0.25, -0.5, 2];
const FUNCTIONS: { label: string; code: string; want: number[]; name?: string }[] = [
  { label: 'neg(v@dir)', code: 'v@a = neg(v@dir);', want: [-0.25, 0.5, -2] },
  { label: 'neg of the same attribute, in place', code: 'v@dir = neg(v@dir); v@a = v@dir;', want: [-0.25, 0.5, -2] },
  { label: 'mul(v, -1) and mul(-1, v)', code: 'v@a = mul(v@dir, -1); v@b = mul(-1, v@dir); v@a = add(v@a, v@b);', want: [-0.5, 1, -4] },
  { label: 'mul(v, -k) with a graph var', code: 'v@a = mul(v@dir, -k);', want: [-0.5, 1, -4] },
  { label: 'div(v, -2)', code: 'v@a = div(v@dir, -2);', want: [-0.125, 0.25, -1] },
  { label: 'add and sub with a vector and with a scalar', code: 'v@a = sub(add(v@dir, [1, 1, 1]), 0.5);', want: [0.75, -0.0, 2.5] },
  { label: 'neg(normalize(v))', code: 'v@a = neg(normalize([0, 3, 4]));', want: [0, -0.6, -0.8] },
  { label: 'neg of a local vector and of a literal', code: 'const q = [0.1, 0.2, 0.3]; v@a = add(neg(q), neg([1, 1, 1]));', want: [-1.1, -1.2, -1.3] },
  { label: 'set(-v.x, -v.y, -v.z)', code: 'v@a = set(-v@dir.x, -v@dir.y, -v@dir.z);', want: [-0.25, 0.5, -2] },
  { label: 'a negated component', code: 'v@a = [1, -v@dir.y, 1];', want: [1, 0.5, 1] },
  { label: 'a negative scalar times a component', code: 'v@a = [-1 * v@dir.x, v@dir.y * -1, -k * v@dir.z];', want: [-0.25, 0.5, -4] },
  { label: 'unary minus on a float attribute', code: 'f@s = 3; f@s = -f@s; v@a = [f@s, 0, 0];', want: [-3, 0, 0] },
  { label: 'compound assignment on a component', code: 'v@dir.x *= -1; v@dir.y -= 1; v@dir.z /= -2; v@a = v@dir;', want: [-0.25, -1.5, -1] },
  { label: 'a vector printed with String()', code: 's@t = String(v@dir) + "|" + `${v@dir}`; v@a = [s@t.length, 0, 0];', want: [2 * '0.25,-0.5,2'.length + 1, 0, 0] },
];
for (const over of OVERS) {
  for (const f of FUNCTIONS) {
    const r = await run(`v@dir = [0.25, -0.5, 2];\n${f.code}`, over, { k: 2 });
    const got = r.geo ? read(r.geo, over, 'a') : [];
    check(r.ok && r.same && r.geo && finite(r.geo, over) && near(got, f.want),
      `${over}: ${f.label} = ${JSON.stringify(f.want)}${r.ok && r.same && near(got, f.want) ? '' : ` (got ${JSON.stringify(got)}${r.ok ? '' : ': ' + r.errors[0]?.message}${r.same ? '' : ', pool on and off differ'})`}`);
  }
}

// a float attribute assigned an array takes its first entry (an empty array gives 0), as before
for (const over of OVERS) {
  const r = await run('f@s = [5]; f@t = []; f@u = 7;', over);
  check(r.ok && r.same && near([read(r.geo!, over, 's')[0], read(r.geo!, over, 't')[0], read(r.geo!, over, 'u')[0]], [5, 0, 7]), `${over}: a float attribute assigned [5], [] and 7 holds 5, 0 and 7`);
}

// the known vector attributes and the other sizes
{
  const r = await run('@P = neg(@P); @Cd = sub([1, 1, 1], @Cd); @N = mul(@N, -1);', 'points', {}, 'n');
  const base = await off.cook({ nodes: SRC, output: 'n' } as any);
  const g = r.geo!, b = base.geo!;
  let ok = r.ok && r.same && finite(g, 'points');
  for (let i = 0; i < b.numPoints; i++) {
    ok = ok && near(read(g, 'points', 'N', i), read(b, 'points', 'N', i).map((x) => -x)) && near(read(g, 'points', 'P', i), read(b, 'points', 'P', i).map((x) => -x));
  }
  check(ok, 'points: P and N negated with neg() and mul(v, -1) on every point (N as a real point attribute)');
}
for (const over of OVERS) {
  const r = await run('u@uv2 = [1, -2]; p@orient = [1, 2, 3, 4]; u@uv2 = neg(u@uv2); p@orient = neg(p@orient); v@a = [@uv2[0], @uv2[1], @orient[3]];', over);
  const got = r.geo ? read(r.geo, over, 'a') : [];
  check(r.ok && r.same && near(got, [-1, 2, -4]) && near(read(r.geo!, over, 'orient'), [-1, -2, -3, -4]) && near(read(r.geo!, over, 'uv2'), [-1, 2]),
    `${over}: neg() on a vec2 and a vec4 attribute (${JSON.stringify(got)})`);
}

// ------------------------------------------------------------------ the operators: a clear error, never NaN in an attribute

const OPERATORS: { label: string; code: string }[] = [
  { label: 'v@N *= -1', code: 'v@N *= -1;' },
  { label: 'v@N = -v@N', code: 'v@N = -v@N;' },
  { label: 'v@N = v@N * -1', code: 'v@N = v@N * -1;' },
  { label: 'v@N = -1 * v@N', code: 'v@N = -1 * v@N;' },
  { label: '@N = -@N', code: '@N = -@N;' },
  { label: 'v@dir = -v@dir on a user attribute', code: 'v@dir = [1, 2, 3]; v@dir = -v@dir;' },
  { label: 'v@Cd *= -1', code: '@Cd *= -1;' },
  { label: '@P = -@P', code: '@P = -@P;' },
  { label: 'unary minus on a local vector', code: 'const q = [1, 2, 3]; v@dir = -q;' },
  { label: 'unary minus on a literal', code: 'v@dir = -[1, 2, 3];' },
  { label: 'unary minus on a function result', code: 'v@dir = -normalize([0, 3, 4]);' },
  { label: 'vector * scalar', code: 'v@dir = [1, 2, 3] * 2;' },
  { label: 'scalar * vector with a variable', code: 'v@dir = k * [1, 2, 3];' },
  { label: 'vector * -variable', code: 'v@dir = [1, 2, 3] * -k;' },
  { label: 'vector + vector', code: 'v@dir = [1, 2, 3] + [1, 1, 1];' },
  { label: 'vector - vector', code: 'v@dir = [1, 2, 3] - [1, 1, 1];' },
  { label: 'v += scalar', code: 'v@dir = [1, 2, 3]; v@dir += 1;' },
  { label: 'v -= vector', code: 'v@dir = [1, 2, 3]; v@dir -= [1, 1, 1];' },
  { label: 'v /= scalar', code: 'v@dir = [1, 2, 3]; v@dir /= 2;' },
  { label: 'v *= vector', code: 'v@dir = [1, 2, 3]; v@dir *= [1, 1, 1];' },
  { label: 'vec2 attribute', code: 'u@uv2 = [1, 2]; u@uv2 = -u@uv2;' },
  { label: 'vec4 attribute', code: 'p@orient = [1, 2, 3, 4]; p@orient *= 2;' },
  { label: 'a vector compared with a number', code: 'if (v@dir > 0) @P.y += 1;' },
  { label: 'a vector added to a string', code: 's@t = "n" + [1, 2];' },
];
for (const over of OVERS) {
  for (const o of OPERATORS) {
    // prims and vertices: @N / @P are the face normal and centroid there (read-only), so every form is also tried on the user attribute
    const r = await run(o.code, over, { k: 2 });
    const msg = r.errors[0]?.message ?? '';
    check(!r.ok && r.same && /^wrangle error: vectors and arrays have no operators/.test(msg) && /use neg\(v\), mul\(v, s\)/.test(msg) && /\(line \d+: /.test(msg),
      `${over}: ${o.label} fails with a message that names the functions${!r.ok && /\(line \d+: /.test(msg) ? '' : ` (${r.ok ? 'cooked without an error' : msg})`}`);
  }
}

// the pool really ran the failing ones, and a big input gives the same error on every chunk
{
  const graph = { nodes: { g: { type: 'grid', params: { size: [4, 4], divisions: [120, 120] } }, w: { type: 'wrangle', in: ['g'], params: { code: 'v@dir = [1, 2, 3];\nv@dir = -v@dir;' } } }, output: 'w' } as any;
  const a = await off.cook(structuredClone(graph)), b = await on.cook(structuredClone(graph));
  check(!a.ok && !b.ok && a.errors[0].message === b.errors[0].message && /\(line 2: v@dir = -v@dir;\)/.test(b.errors[0].message),
    `a 14k point wrangle on the pool fails with the cooking thread's message: ${b.errors[0]?.message}`);
  const before2 = on.poolStats.parallel;
  const good = { nodes: { ...graph.nodes, w: { type: 'wrangle', in: ['g'], params: { code: 'v@dir = [1, 2, 3];\nv@dir = neg(v@dir);' } } }, output: 'w' } as any;
  const ga = await off.cook(structuredClone(good)), gb = await on.cook(structuredClone(good));
  check(ga.ok && gb.ok && JSON.stringify(fingerprint(ga.geo!)) === JSON.stringify(fingerprint(gb.geo!)) && finite(gb.geo!, 'points') && near(read(gb.geo!, 'points', 'dir', 14000), [-1, -2, -3]),
    'the same wrangle with neg() on 14k points: pool off = pool on, no NaN');
  check(on.poolStats.parallel > before2, 'and it ran on the worker pool');
}

// ------------------------------------------------------------------ the other places that run user code in the scripting realm

{
  const sdf = (code: string) => off.cook({ nodes: { s: { type: 'sdf_expr', params: { code } }, g: { type: 'sdf_grid', in: ['s'], params: { voxel_size: 0.25 } } }, output: 'g' } as any);
  const good = await sdf('sdSphere(sub(p, [0.1, 0, 0]), 0.5)');
  const bad = await sdf('sdSphere(p - [0.1, 0, 0], 0.5)');
  check(good.ok && !bad.ok && /vectors and arrays have no operators/.test(bad.errors[0]?.message ?? ''), `sdf_expr: p - [..] fails with the same message (${bad.errors[0]?.message})`);
  const par = (v: string) => off.cook({ nodes: { b: { type: 'box', params: { size: v } } }, output: 'b' } as any);
  const p1 = await par('=[1, 2, 3] * 2'), p2 = await par('=-[1, 2, 3]'), p3 = await par('=[1, 2, 3]');
  check(!p1.ok && !p2.ok && p3.ok, '"=expr" params: arithmetic on an array is an error already (the param check), a plain array is fine');
}

// ------------------------------------------------------------------ strings and component maths still work

for (const over of OVERS) {
  const r = await run('v@dir = [0.25, -0.5, 2]; f@h = v@dir.y * 2 + v@dir.x - -v@dir.z; s@name = "p" + @elemnum; v@a = [f@h, 0, 0];', over);
  check(r.ok && r.same && near(read(r.geo!, over, 'a'), [-1 + 0.25 + 2, 0, 0]), `${over}: scalar maths on components and string building still work`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await on.host.pool?.close();
process.exit(fail ? 1 : 0);
