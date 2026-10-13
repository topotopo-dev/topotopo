// Wrangle fuzz: random snippets from a small grammar, plus malformed and never-ending ones; and the "=expr" sandbox:
// parameter expressions that try to escape it or never finish, with the worker pool off and on.
//
//   node test/fuzz.ts [--count N] [--seed S] [--verbose]      (FUZZ_COUNT env also sets the count)
//
// Asserts:
//   - nothing hangs: infinite loops (in wrangles, and in script nodes after an await) are stopped by the sandbox
//     timeout (the run happens in a child process with a hard wall-clock limit, so a timeout that fails to fire
//     fails the test instead of hanging CI),
//   - malformed code fails the wrangle node (a per-node error, never a throw) with a "(line N: …)" hint,
//   - valid code cooks, passes checkGeo, and is deterministic,
//   - "=expr" params that reach for process, globalThis, this.constructor.constructor, import(), fetch, require or
//     the engine realm through any object fail their node with a clear error, and loops (also after an await, in a
//     getter of the result, in a thrown object, in a regular expression) are stopped by the expression timeout,
//   - the code params of heightfield_layer, sdf_expr, parametric_curve and parametric_surface run under the script
//     timeout (loops, also in one sample, after an await or in a thrown object's message getter, fail the node) and
//     cannot close the wrapper they are compiled in (syntax error instead of code that runs while compiling),
//   - an sdf_expr field sampled later (sdf_to_mesh, inside manifold's WASM mesher, and sdf_grid; also through
//     transform/sdf_modify/sdf_combine) runs under the script timeout: loops away from the origin, a slow field, and
//     message getters of what it throws fail the sampling node with its own error, and manifold still works after,
//   - what wrangle and script code throws is read inside the timeout (message, stack and toString getters that never
//     return), with the pool off and on (point wrangles in workers), and a script cannot close its function either;
//     ordinary error texts are unchanged.
import { spawnSync } from 'node:child_process';
import { rng } from '../src/core/random.ts';
import { heightfieldsOf } from '../src/core/heightfield.ts';
import { Engine } from '../src/graph/engine.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import { createNodeHost } from '../src/host/node.ts';
import { addFixture, checkGeo, createFixtureEngine } from './fixtures.ts';
import { fingerprint } from './fingerprint.ts';

const args = process.argv.slice(2);
const HARD_LIMIT_MS = 240_000;

if (!args.includes('--child')) {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, [process.argv[1], '--child', ...args], { stdio: 'inherit', timeout: HARD_LIMIT_MS });
  if (res.error || res.signal) {
    console.log(`FAIL wrangle fuzz did not finish within ${HARD_LIMIT_MS / 1000}s (${res.signal ?? res.error?.message}): a sandbox timeout did not fire`);
    process.exit(1);
  }
  if (args.includes('--verbose')) console.log(`(fuzz child finished in ${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(res.status ?? 1);
}

const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const COUNT = Number(flag('--count') ?? process.env.FUZZ_COUNT ?? 100);
const SEED = Number(flag('--seed') ?? 1);
const VERBOSE = args.includes('--verbose');
const TIMEOUT_MS = 1000;

// ------------------------------------------------------------------ grammar

type Rand = () => number;
const pick = <T>(r: Rand, a: T[]): T => a[Math.floor(r() * a.length)];
const num = (r: Rand) => String(Math.round((r() * 4 - 2) * 100) / 100);

function scalar(r: Rand, d: number, inLoop: boolean): string {
  if (d <= 0 || r() < 0.4) {
    const leaves = ['@P.x', '@P.y', '@P.z', '@ptnum', '@numpt', '@pscale', '@foo', 'rand(@ptnum)', 'rand(@ptnum, 3)',
      'noise(@P)', 'snoise(mul(@P, 2))', 'length(@P)', 'dot(@N, [0, 1, 0])', '@Cd.r', 'worley(@P)', num(r), num(r)];
    if (inLoop) leaves.push('i', 'i * 0.1');
    return pick(r, leaves);
  }
  const a = scalar(r, d - 1, inLoop), b = scalar(r, d - 1, inLoop);
  return pick(r, [
    `(${a} + ${b})`, `(${a} - ${b})`, `(${a} * ${b})`, `sin(${a})`, `cos(${a} * 3)`, `abs(${a})`,
    `fit(${a}, -1, 1, 0, 1)`, `clamp(${a}, 0, 1)`, `min(${a}, ${b})`, `max(${a}, ${b})`, `smoothstep(0, 1, ${a})`,
    `fbm(@P, 3, 2, 0.5)`, `ridged(@P, 2, 2, 0.5)`, `randrange(@ptnum, -1, 1)`, `(${a} > ${b} ? ${a} : ${b})`,
  ]);
}

function vector(r: Rand, d: number, inLoop: boolean): string {
  if (d <= 0 || r() < 0.4) {
    return pick(r, ['@P', '@Cd', '@N', 'randv(@ptnum)', 'vnoise(@P)', 'curlnoise(@P)', 'hsv2rgb(rand(@ptnum), 0.6, 1)',
      `[${scalar(r, 0, inLoop)}, ${scalar(r, 0, inLoop)}, ${scalar(r, 0, inLoop)}]`, '[0, 1, 0]']);
  }
  const a = vector(r, d - 1, inLoop), b = vector(r, d - 1, inLoop), s = scalar(r, d - 1, inLoop);
  return pick(r, [`add(${a}, ${b})`, `sub(${a}, ${b})`, `mul(${a}, ${s})`, `normalize(${a})`, `cross(${a}, ${b})`, `lerp(${a}, ${b}, 0.5)`]);
}

function statement(r: Rand, d: number, inLoop = false): string {
  const S = () => scalar(r, 2, inLoop), V = () => vector(r, 2, inLoop);
  const simple = [
    () => `@P.y += ${S()} * 0.1;`,
    () => `@P = add(@P, mul(${V()}, 0.05));`,
    () => `@Cd = ${V()};`,
    () => `@N = normalize(${V()});`,
    () => `@pscale = ${S()};`,
    () => `f@foo = ${S()};`,
    () => `@foo = ${S()};`,
    () => `v@bar = ${V()};`,
    () => `i@id = @ptnum;`,
    () => `s@name = "piece" + (@ptnum % 3);`,
    () => `@group_sel = ${S()} > 0;`,
    () => `setpointattrib(0, "w", @ptnum, ${S()});`,
    () => `{ const t = ${S()}; @P.x += t * 0.01; }`,
    () => `if (@ptnum % ${2 + Math.floor(r() * 5)} == 0) { const p = addpoint(0, ${V()}); addprim(0, "polyline", [@ptnum, p]); }`,
    () => `if (${S()} > 0.8) removepoint(0, @ptnum);`,
    () => `if (@ptnum == 0 && @numpt >= 3) addprim(0, "poly", [0, 1, 2]);`,
  ];
  if (d <= 0 || r() < 0.6) return pick(r, simple)();
  return pick(r, [
    () => `if (${S()} > 0) { ${statement(r, d - 1, inLoop)} } else { ${statement(r, d - 1, inLoop)} }`,
    () => `for (let i = 0; i < ${1 + Math.floor(r() * 4)}; i++) { ${statement(r, d - 1, true)} }`,
    () => `if (${S()} < 0.5) { ${statement(r, d - 1, inLoop)} }`,
  ])();
}

function snippet(r: Rand): string {
  const n = 1 + Math.floor(r() * 5);
  return Array.from({ length: n }, () => statement(r, 2)).join('\n');
}

// ------------------------------------------------------------------ cases

interface Case { kind: 'valid' | 'malformed' | 'hang'; code: string; runOver: string; source: string; line?: number; knownGap?: string; node?: 'wrangle' | 'script' }

/** Curated malformed snippets with the line the error hint must point at. */
const MALFORMED: { code: string; line?: number; knownGap?: string }[] = [
  { code: '@P.y += ;', line: 1 },
  { code: '@Cd = [1, 0, 0;', line: 1 },
  { code: 'if (@P.x > 0 { @Cd = [1, 0, 0]; }', line: 1 },
  { code: '@P.y += 1;\n@P.x += * 2;', line: 2 },
  { code: 'for (let i = 0; i < 3; i++ { @P.y += i; }', line: 1 },
  { code: '@P = add(@P, [0, 1, 0]));', line: 1 },
  { code: 'let = 5;', line: 1 },
  { code: '@P.y += 0.1;\n\n@Cd = [1, 0, 0]\n@N = ;', line: 4 },
  { code: '@P.y += "unterminated;', line: 1 },
  { code: '@P..y = 1;', line: 1 },
  { code: '@P.y = undefinedFunction(@P.x);', line: 1 },
  { code: '@P.y += 1;\nnull.foo;', line: 2 },
  { code: 'error("boom at " + @ptnum);', line: 1 },
  { code: '@P.y += 1;\nconst q = @P;\nq.nope.deeper = 1;', line: 3 },
  // bracket mistakes: inside the kernel the parser only noticed these past the snippet's end, and a stray `}` closed
  // the kernel's wrapper; the snippet is now parsed on its own first, unclosed brackets point at the opening line
  { code: '@Cd = [1, 0, 0', line: 1 },
  { code: '}', line: 1 },
  { code: '@P.y += 1;\n}\n@Cd = [1, 0, 0];', line: 2 },
  { code: 'if (@P.x > 0) {\n  @P.y += 1;\n', line: 1 },
  { code: '@P.y += 1; // [\n@Cd = [1,\n0,\n0', line: 2 },
  { code: 'const s = `${@P.x}`;\nif (s) {\n  @P.y += /[{]/.test(s) ? 1 : 0;\n', line: 2 },
  // balanced the other way round: this compiled inside the kernel before (closing the wrapper and reopening it)
  { code: '}, __x = function(){', line: 1 },
];

const HANGS = ['while(true){}', 'for(;;){ @P.y += 0; }', 'while (@P.y < 1e9) { @Cd = [0, 0, 0]; }', 'let k = 0;\nwhile (k >= 0) { k++; }'];

/** Script nodes that never finish after an await: the continuations must be inside the timeout too. */
const SCRIPT_HANGS = [
  'await 0; while(true){}',
  "const s = await lib.run('sphere', { radius: 0.5 });\nwhile (true) {}",
  "for (;;) await lib.run('box');",
  // script is an async node: its promise settles outside the realm
  "await lib.run('script', { code: 'return geo;' });\nwhile (true) {}",
  "for (;;) await lib.run('script', { code: 'await 0; return geo;' });",
  'await new Promise(() => {});',
];

function buildCases(): Case[] {
  const r = rng(SEED);
  const sources = ['MESH', 'GRID', 'COLORED', 'CURVE', 'PTS', 'BOX'];
  const runOver = () => pick(r, ['points', 'points', 'points', 'points', 'prims', 'detail']);
  const cases: Case[] = [];
  for (let i = 0; i < COUNT; i++) cases.push({ kind: 'valid', code: snippet(r), runOver: runOver(), source: pick(r, sources) });
  for (const m of MALFORMED) cases.push({ kind: 'malformed', ...m, runOver: 'points', source: 'MESH' });
  // generated syntax errors at a random line of a valid snippet (each one is detected on its own line)
  for (let i = 0; i < Math.max(5, Math.round(COUNT / 5)); i++) {
    const lines = snippet(r).split('\n');
    const at = Math.floor(r() * (lines.length + 1));
    lines.splice(at, 0, pick(r, ['@P.y +* 2;', '@Cd = ;', 'if (@P.x > ) { }', 'const = 1;', '@P.y += (1;', '@P = add(@P,, 1);']));
    cases.push({ kind: 'malformed', code: lines.join('\n'), line: at + 1, runOver: runOver(), source: pick(r, sources) });
  }
  for (const code of HANGS) cases.push({ kind: 'hang', code, runOver: 'points', source: 'MESH' });
  cases.push({ kind: 'hang', code: 'while(true){}', runOver: 'prims', source: 'BOX' });
  for (const code of SCRIPT_HANGS) cases.push({ kind: 'hang', code, runOver: '-', source: 'MESH', node: 'script' });
  return cases;
}

// ------------------------------------------------------------------ run

async function cookCase(engine: Engine, c: Case) {
  const nodes: Record<string, NodeSpec> = {};
  addFixture(nodes, c.source);
  nodes.w = c.node === 'script'
    ? { type: 'script', in: [c.source], params: { code: c.code } }
    : { type: 'wrangle', in: [c.source], params: { code: c.code, run_over: c.runOver } };
  engine.cache.clear();
  return engine.cook({ nodes, output: 'w' });
}

const { engine } = await createFixtureEngine();
engine.scriptTimeoutMs = TIMEOUT_MS;
const t0 = performance.now();
const cases = buildCases();
let fail = 0, gaps = 0;
const counts = { valid: 0, malformed: 0, hang: 0 };

for (const [i, c] of cases.entries()) {
  counts[c.kind]++;
  const problems: string[] = [];
  const t = performance.now();
  let r;
  try {
    r = await cookCase(engine, c);
  } catch (e: any) {
    problems.push(`engine.cook threw: ${e?.stack ?? e}`);
  }
  const ms = performance.now() - t;
  if (r) {
    const err = r.errors.find((e) => e.node === 'w');
    if (c.kind === 'valid') {
      if (!r.ok || !r.geo) problems.push(`valid snippet failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
      else {
        const inv = checkGeo(r.geo);
        if (inv.length) problems.push(`checkGeo: ${inv.join(', ')}`);
        const again = await cookCase(engine, c);
        if (JSON.stringify(fingerprint(r.geo)) !== JSON.stringify(again.geo && fingerprint(again.geo))) problems.push('not deterministic (second cook differs)');
      }
    } else if (c.kind === 'malformed') {
      if (r.ok || !err) problems.push(`malformed snippet did not fail the wrangle node (ok=${r.ok}, errors: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ') || 'none'})`);
      else {
        const m = /\(line (\d+):/.exec(err.message);
        if (c.knownGap) {
          if (m) console.log(`note: known gap now has a line hint, remove knownGap: ${JSON.stringify(c.code)} → ${err.message}`);
          else { gaps++; if (VERBOSE) console.log(`gap  #${i} no line hint (${c.knownGap}): ${err.message}`); }
        } else if (!m) problems.push(`error has no line hint: ${err.message}`);
        else if (c.line !== undefined && Number(m[1]) !== c.line) problems.push(`line hint ${m[1]}, expected ${c.line}: ${err.message}`);
      }
    } else {
      if (r.ok || !err || !/exceeded \d+ ms/.test(err.message)) problems.push(`infinite loop was not stopped by the timeout: ${err?.message ?? 'cooked ok'}`);
      if (ms > TIMEOUT_MS * 3 + 2000) problems.push(`timeout fired late: ${ms.toFixed(0)} ms for a ${TIMEOUT_MS} ms limit`);
    }
  }
  if (problems.length) {
    fail++;
    console.log(`FAIL #${i} ${c.node ?? 'wrangle'} ${c.kind} (run_over ${c.runOver}, on ${c.source})`);
    console.log('  code: ' + JSON.stringify(c.code));
    for (const p of problems) console.log('  ' + p);
  } else if (VERBOSE) console.log(`ok   #${i} ${c.kind.padEnd(9)} ${ms.toFixed(0).padStart(5)}ms ${JSON.stringify(c.code).slice(0, 100)}`);
}

const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`wrangle fuzz: ${cases.length} snippets (${counts.valid} valid, ${counts.malformed} malformed, ${counts.hang} infinite loops; seed ${SEED}), ${fail} failed, ${gaps} known line-hint gaps (${secs}s)`);

// ------------------------------------------------------------------ "=expr" sandbox

/**
 * Hostile parameter expressions. Each one gives a number when it gets out (so an escape cooks instead of failing),
 * and must fail the node with an error matching `want` that names the param and the expression. `loop` cases
 * never finish: the expression timeout has to stop them.
 */
const EXPR_CASES: { expr: string; want: RegExp; loop?: boolean }[] = [
  { expr: '=process.pid', want: /process is not available in expressions/ },
  { expr: '=globalThis.process.pid', want: /globalThis is not available in expressions/ },
  { expr: "=this.constructor.constructor('return process')().pid", want: /this is not available in expressions/ },
  { expr: "=import('node:fs') ? 1 : 1", want: /import is not available in expressions/ },
  { expr: "=import('data:text/javascript,globalThis.__pwned=1') ? 1 : 1", want: /import is not available in expressions/ },
  { expr: "=fetch('http://127.0.0.1:9') ? 1 : 1", want: /fetch is not available in expressions/ },
  { expr: "=require('node:fs') ? 1 : 1", want: /require is not available in expressions/ },
  { expr: "=Function('return process')().pid", want: /Function is not available in expressions/ },
  { expr: "=sin.constructor.constructor('return process')().pid", want: /the Function constructor is not available/ },
  { expr: "=(() => 0).constructor('return this')().process.pid", want: /the Function constructor is not available/ },
  { expr: "=(async () => 0).constructor('return 1') ? 1 : 1", want: /the Function constructor is not available/ },
  { expr: "=Math.max.constructor('return process')().pid", want: /the Function constructor is not available/ },
  { expr: "=bbox('src').max.constructor.constructor('return process')().pid", want: /the Function constructor is not available/ },
  { expr: "=list.constructor.constructor('return process')().pid", want: /the Function constructor is not available/ },
  { expr: "=(() => { try { return nope } catch (e) { return e.constructor.constructor('return process')().pid } })()", want: /the Function constructor is not available/ },
  { expr: "=(() => { try { point('src', 1e9, 'P') } catch (e) { return e.constructor.constructor('return process')().pid } })()", want: /the Function constructor is not available/ },
  { expr: '=[].constructor.prototype.polluted = 1', want: /not extensible/ },
  { expr: '=list.push(4)', want: /not extensible/ },
  { expr: '=list = 1', want: /cannot assign to "list"/ },
  { expr: '=(() => { while (true) {} })()', want: /exceeded \d+ ms/, loop: true },
  { expr: '=(() => { for (;;) {} })()', want: /exceeded \d+ ms/, loop: true },
  { expr: '=(async () => { await 0; while (true) {} })() ? 1 : 1', want: /exceeded \d+ ms/, loop: true },
  { expr: '=({ get x() { while (true) {} } })', want: /exceeded \d+ ms/, loop: true },
  { expr: '=(() => { throw { get message() { while (true) {} } } })()', want: /exceeded \d+ ms/, loop: true },
  { expr: "='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'.match('(a+)+$') ? 1 : 0", want: /exceeded \d+ ms/, loop: true },
];
const exprGraph = (expr: string): GraphSpec => ({
  vars: { list: [1, 2, 3] },
  nodes: { src: { type: 'box' }, t: { type: 'box', params: { size: 0.5, center: [0, expr, 0] } } },
  output: 't',
});
const EXPR_TIMEOUT_MS = 400;
let exprFail = 0;
const te = performance.now();
for (const workers of [0, 2]) {
  const e = new Engine(createNodeHost({ workers, shelf: false }));
  e.manifold = engine.manifold;
  e.scriptTimeoutMs = EXPR_TIMEOUT_MS;
  const mode = workers ? 'pool on' : 'pool off';
  const problems: string[] = [];
  if (e.concurrent !== !!workers) problems.push(`${mode}: engine.concurrent is ${e.concurrent}`);
  for (const c of EXPR_CASES) {
    const t = performance.now();
    let r;
    try { r = await e.cook(exprGraph(c.expr)); } catch (err: any) { problems.push(`${c.expr}: engine.cook threw ${err?.stack ?? err}`); continue; }
    const ms = performance.now() - t;
    const err = r.errors.find((x) => x.node === 't');
    if (r.ok || !err) problems.push(`${c.expr}: cooked (${r.ok ? 'escaped the sandbox, center y = ' + r.geo?.bbox().max[1] : r.errors.map((x) => x.message).join('; ')})`);
    else if (!c.want.test(err.message) || !err.message.includes('param "center"[1]') || !err.message.includes(c.expr)) problems.push(`${c.expr}: unclear error: ${err.message}`);
    if (c.loop && ms > EXPR_TIMEOUT_MS * 3 + 2000) problems.push(`${c.expr}: timeout fired late: ${ms.toFixed(0)} ms for a ${EXPR_TIMEOUT_MS} ms limit`);
    if (!c.loop && ms > 2000) problems.push(`${c.expr}: took ${ms.toFixed(0)} ms`);
    if (VERBOSE) console.log(`expr ${mode} ${ms.toFixed(0).padStart(5)}ms ${c.expr}: ${err?.message.slice(0, 120)}`);
  }
  await new Promise((res) => setTimeout(res, 20)); // let any stray promise settle
  const after = await e.cook(exprGraph('=list[2] + sin(0) + rand(1) * 0'));
  if (!after.ok || Math.abs(after.geo!.bbox().max[1] - 3.25) > 1e-9) problems.push(`${mode}: a plain expression no longer works after the hostile ones: ${after.errors.map((x) => x.message).join('; ')}`);
  if ((globalThis as any).__pwned !== undefined || ([] as any).polluted !== undefined || Object.isFrozen(Array.prototype)) problems.push(`${mode}: the engine realm was changed`);
  await e.host.pool?.close();
  for (const p of problems) { exprFail++; console.log(`FAIL expression sandbox, ${p}`); }
}
console.log(`expression sandbox: ${EXPR_CASES.length} hostile expressions × pool off/on, ${exprFail} failed (${((performance.now() - te) / 1000).toFixed(1)}s)`);

// ------------------------------------------------------------------ code params: heightfield_layer, sdf_expr, parametric

/**
 * Hostile code in the code params that run in the scripting realm outside a wrangle: heightfield_layer's expression
 * (run once per sample), sdf_expr's code (probed at the origin) and the parametric nodes' expressions (once per point).
 * Loops (also in one sample only, after an await, in the message getter or toString of a thrown object) must be
 * stopped by the script timeout, and code that tries to close the wrapper it is compiled in (which would run its loop
 * while compiling, outside any time limit) must be a syntax error.
 */
type CodeType = 'heightfield_layer' | 'sdf_expr' | 'parametric_curve' | 'parametric_surface';
const CODE_TYPES: CodeType[] = ['heightfield_layer', 'sdf_expr', 'parametric_curve', 'parametric_surface'];
const CODE_CASES: { code: string; want: RegExp; loop?: boolean; only?: CodeType | CodeType[] }[] = [
  { code: 'while (true) {}\nreturn 0;', want: /exceeded \d+ ms/, loop: true },
  { code: '(() => { for (;;) {} })()', want: /exceeded \d+ ms/, loop: true },
  { code: 'i == 10 && j == 10 ? (() => { while (true) {} })() : height', want: /exceeded \d+ ms/, loop: true, only: 'heightfield_layer' },
  { code: 'p[0] == 0 ? (() => { while (true) {} })() : sdSphere(p, 0.5)', want: /exceeded \d+ ms/, loop: true, only: 'sdf_expr' },
  { code: '(async () => { await 0; while (true) {} })(), 0', want: /exceeded \d+ ms/, loop: true },
  { code: '(() => { throw { get message() { while (true) {} } } })()', want: /exceeded \d+ ms/, loop: true },
  { code: '0); } })((() => { while (true) {} })()), (function () { return function () { return (0', want: /syntax error/ },
  { code: 'return 0; } })((() => { while (true) {} })()), (function () { return function () { return 0;', want: /syntax error/ },
  { code: 'return 0; }; })((() => { while (true) {} })()), (function () { return function () { return 0;', want: /syntax error/ },
  // R-13: the parametric nodes' wrapper, their loops part-way along, a thrown object's toString, an ordinary error
  { code: 'return 0; })((() => { while (true) {} })()), (function () { return [0,0,0];', want: /syntax error/ },
  { code: 'return 0; }), (() => { while (true) {} })(), (function () { return [0,0,0];', want: /syntax error/ },
  { code: 't > 0.5 ? (() => { while (true) {} })() : [t, 0, 0]', want: /^parametric_curve: code exceeded \d+ ms \(infinite loop\?\)$/, loop: true, only: 'parametric_curve' },
  { code: 'u > 0.5 && v > 0.5 ? (() => { while (true) {} })() : [u, 0, v]', want: /^parametric_surface: code exceeded \d+ ms \(infinite loop\?\)$/, loop: true, only: 'parametric_surface' },
  { code: 't > 0.5 ? (() => { throw { get message() { while (true) {} } } })() : [t, 0, 0]', want: /exceeded \d+ ms/, loop: true, only: 'parametric_curve' },
  { code: '(() => { throw { toString() { while (true) {} } } })()', want: /exceeded \d+ ms/, loop: true },
  { code: '(() => { throw new Error("boom") })()', want: /: boom$/ },
];
const codeGraph = (type: CodeType, code: string): GraphSpec => type === 'sdf_expr'
  ? { nodes: { t: { type: 'sdf_expr', params: { code } } }, output: 't' }
  : type === 'parametric_curve' ? { nodes: { t: { type: 'parametric_curve', params: { expr: code, count: 50 } } }, output: 't' }
  : type === 'parametric_surface' ? { nodes: { t: { type: 'parametric_surface', params: { expr: code, divisions: [8, 8] } } }, output: 't' }
  : { nodes: { hf: { type: 'heightfield', params: { size: [4, 4], resolution: 0.2 } }, t: { type: 'heightfield_layer', in: ['hf'], params: { layer: 'mask', expression: code } } }, output: 't' };
let codeFail = 0, codeRuns = 0;
const tc = performance.now();
for (const workers of [0, 2]) {
  const e = new Engine(createNodeHost({ workers, shelf: false }));
  e.manifold = engine.manifold;
  e.scriptTimeoutMs = EXPR_TIMEOUT_MS;
  const mode = workers ? 'pool on' : 'pool off';
  const problems: string[] = [];
  for (const type of CODE_TYPES) {
    for (const c of CODE_CASES) {
      if (c.only && ![c.only].flat().includes(type)) continue;
      codeRuns++;
      const t = performance.now();
      let r;
      try { r = await e.cook(codeGraph(type, c.code)); } catch (err: any) { problems.push(`${type} ${JSON.stringify(c.code)}: engine.cook threw ${err?.stack ?? err}`); continue; }
      const ms = performance.now() - t;
      const err = r.errors.find((x) => x.node === 't');
      if (r.ok || !err) problems.push(`${type} ${JSON.stringify(c.code)}: cooked`);
      else if (!c.want.test(err.message) || !err.message.startsWith(`${type}`)) problems.push(`${type} ${JSON.stringify(c.code)}: unclear error: ${err.message}`);
      if (c.loop && ms > EXPR_TIMEOUT_MS * 3 + 2000) problems.push(`${type} ${JSON.stringify(c.code)}: timeout fired late: ${ms.toFixed(0)} ms for a ${EXPR_TIMEOUT_MS} ms limit`);
      if (!c.loop && ms > 2000) problems.push(`${type} ${JSON.stringify(c.code)}: took ${ms.toFixed(0)} ms`);
      if (VERBOSE) console.log(`code ${mode} ${ms.toFixed(0).padStart(5)}ms ${type} ${JSON.stringify(c.code)}: ${err?.message.slice(0, 120)}`);
    }
  }
  await new Promise((res) => setTimeout(res, 20)); // let any stray promise settle
  // the scripting realm still works: plain code in both nodes and a wrangle
  e.cache.clear();
  const layer = await e.cook(codeGraph('heightfield_layer', 'x + 1'));
  const hf = layer.geo ? heightfieldsOf(layer.geo)[0] : undefined;
  if (!layer.ok || !hf || Math.abs(hf.read('mask')[hf.width - 1] - (hf.x(hf.width - 1) + 1)) > 1e-6) problems.push(`${mode}: heightfield_layer no longer works after the hostile code: ${layer.errors.map((x) => x.message).join('; ')}`);
  const sdf = await e.cook({ nodes: { s: { type: 'sdf_expr', params: { code: 'sdSphere(p, 0.5)' } }, m: { type: 'sdf_to_mesh', in: ['s'], params: { divisions: 16 } } }, output: 'm' });
  if (!sdf.ok || !(sdf.geo!.numPrims > 0)) problems.push(`${mode}: sdf_expr no longer works after the hostile code: ${sdf.errors.map((x) => x.message).join('; ')}`);
  const wr = await e.cook({ nodes: { b: { type: 'box' }, w: { type: 'wrangle', in: ['b'], params: { code: '@P.y += 1;' } } }, output: 'w' });
  if (!wr.ok || Math.abs(wr.geo!.bbox().max[1] - 1.5) > 1e-9) problems.push(`${mode}: a wrangle no longer works after the hostile code: ${wr.errors.map((x) => x.message).join('; ')}`);
  const curve = await e.cook(codeGraph('parametric_curve', '[t, 2 * t, 0]'));
  if (!curve.ok || Math.abs(curve.geo!.bbox().max[1] - 2) > 1e-9) problems.push(`${mode}: parametric_curve no longer works after the hostile code: ${curve.errors.map((x) => x.message).join('; ')}`);
  await e.host.pool?.close();
  for (const p of problems) { codeFail++; console.log(`FAIL code params, ${mode}: ${p}`); }
}
console.log(`code params: ${codeRuns} hostile heightfield_layer/sdf_expr/parametric cooks over pool off/on, ${codeFail} failed (${((performance.now() - tc) / 1000).toFixed(1)}s)`);

// ------------------------------------------------------------------ fields sampled later; what wrangles and scripts throw

/**
 * User code that runs after its own node has cooked: an sdf_expr field is only probed at the origin by sdf_expr and is
 * sampled later by sdf_to_mesh (from inside manifold's WASM level-set mesher) and sdf_grid. Code that loops only away
 * from the origin, a field that is merely slow, and thrown objects whose message never comes back must fail the
 * sampling node with its own error within the timeout, also when the field passed through transform, sdf_modify and
 * sdf_combine (the "user code" mark travels with it). Analytic fields keep running without a limit.
 */
type SampleType = 'sdf_to_mesh' | 'sdf_grid' | 'sdf_to_mesh (chain)';
const SAMPLE_TYPES: SampleType[] = ['sdf_to_mesh', 'sdf_grid', 'sdf_to_mesh (chain)'];
const SAMPLE_CASES: { code: string; want: RegExp; loop?: boolean }[] = [
  { code: 'p[0] > 0.5 ? (() => { while (true) {} })() : sdSphere(p, 0.5)', want: /: SDF code \(sdf_expr\) exceeded \d+ ms \(infinite loop\?\)$/, loop: true },
  { code: 'p[0] > 0.5 ? (() => { throw { get message() { while (true) {} } } })() : sdSphere(p, 0.5)', want: /exceeded \d+ ms/, loop: true },
  { code: 'p[0] > 0.5 ? (() => { throw { toString() { while (true) {} } } })() : sdSphere(p, 0.5)', want: /exceeded \d+ ms/, loop: true },
  { code: '(p[0] > 0.5 && (async () => { await 0; while (true) {} })(), sdSphere(p, 0.5))', want: /exceeded \d+ ms/, loop: true },
  // slow everywhere (2 ms a sample): stopped between samples by the sampler's own deadline check
  { code: '(() => { const t = Date.now(); while (Date.now() - t < 2) {} })(), sdSphere(p, 0.5)', want: /exceeded \d+ ms/, loop: true },
  { code: "p[0] > 0.5 ? (() => { throw new Error('boom') })() : sdSphere(p, 0.5)", want: /: SDF code \(sdf_expr\) failed: boom$/ },
];
const sampleGraph = (type: SampleType, code: string): GraphSpec => {
  const field: NodeSpec = { type: 'sdf_expr', params: { code } };
  if (type === 'sdf_grid') return { nodes: { s: field, t: { type: 'sdf_grid', in: ['s'], params: { voxel_size: 0.1 } } }, output: 't' };
  if (type === 'sdf_to_mesh') return { nodes: { s: field, t: { type: 'sdf_to_mesh', in: ['s'], params: { divisions: 24 } } }, output: 't' };
  return {
    nodes: {
      s: field, moved: { type: 'transform', in: ['s'], params: { translate: [0.1, 0, 0] } },
      grown: { type: 'sdf_modify', in: ['moved'], params: { operation: 'offset', amount: 0.01 } },
      box: { type: 'sdf_shape', params: { shape: 'box', size: [0.2, 0.2, 0.2], center: [0, 1, 0] } },
      both: { type: 'sdf_combine', in: ['grown', 'box'], params: { operation: 'union' } },
      t: { type: 'sdf_to_mesh', in: ['both'], params: { divisions: 24 } },
    },
    output: 't',
  };
};

/**
 * What wrangle and script code throws is user code too: a message or stack getter, or a toString, that never returns
 * hung the process when the node read the error after the guarded run. Also a script body that closes its function
 * (it ran while compiling, with no time limit). Ordinary errors keep their texts. With the pool on, point wrangles run
 * in workers (minElements 1), where the worker reads the error.
 */
interface ThrowCase { node: 'wrangle' | 'script'; code: string; want: RegExp; loop?: boolean }
const THROW_CASES: ThrowCase[] = [
  { node: 'wrangle', code: 'throw { get message() { while (true) {} } };', want: /^wrangle exceeded \d+ ms \(infinite loop\?\)$/, loop: true },
  { node: 'wrangle', code: "throw { message: 'x', get stack() { while (true) {} } };", want: /^wrangle exceeded \d+ ms/, loop: true },
  { node: 'wrangle', code: 'throw { toString() { while (true) {} } };', want: /^wrangle exceeded \d+ ms/, loop: true },
  { node: 'wrangle', code: '@P.y += 1;\nif (@ptnum == 3) throw { get message() { while (true) {} } };', want: /^wrangle exceeded \d+ ms/, loop: true },
  { node: 'wrangle', code: '@P.y += 1;\nnull.foo;', want: /^wrangle error: Cannot read properties of null \(reading 'foo'\) \(line 2: null\.foo;\)$/ },
  { node: 'wrangle', code: "throw 'plain';", want: /^wrangle error: plain$/ },
  // a user error that says "timed out" is not taken for the timeout
  { node: 'wrangle', code: "throw { message: 'timed out on purpose' };", want: /^wrangle error: timed out on purpose$/ },
  { node: 'script', code: 'throw { get message() { while (true) {} } };', want: /^script exceeded \d+ ms \(infinite loop\?\)$/, loop: true },
  { node: 'script', code: 'await 0;\nthrow { get message() { while (true) {} } };', want: /^script exceeded \d+ ms/, loop: true },
  { node: 'script', code: "await lib.run('box');\nthrow { toString() { while (true) {} } };", want: /^script exceeded \d+ ms/, loop: true },
  { node: 'script', code: 'return geo; }), (() => { while (true) {} })(), (async function () {', want: /^script syntax error: / },
  { node: 'script', code: 'return geo; })((() => { while (true) {} })()), (async function () {', want: /^script syntax error: / },
  { node: 'script', code: 'null.foo;', want: /^script error: Cannot read properties of null \(reading 'foo'\)$/ },
  { node: 'script', code: 'return geo +;', want: /^script syntax error: Unexpected token ';'$/ },
];
const throwGraph = (c: { node: 'wrangle' | 'script'; code: string }): GraphSpec => c.node === 'script'
  ? { nodes: { t: { type: 'script', params: { code: c.code } } }, output: 't' }
  : { nodes: { g: { type: 'grid', params: { divisions: [20, 20] } }, t: { type: 'wrangle', in: ['g'], params: { code: c.code } } }, output: 't' };

let laterFail = 0, laterRuns = 0;
const tl = performance.now();
for (const workers of [0, 2]) {
  // pool on: every kernel (point wrangles included) goes to the workers, whatever its size
  const e = new Engine(createNodeHost({ workers, shelf: false, ...(workers ? { pool: { minElements: 1 } } : {}) }));
  e.manifold = engine.manifold;
  e.scriptTimeoutMs = EXPR_TIMEOUT_MS;
  const mode = workers ? 'pool on' : 'pool off';
  const problems: string[] = [];
  const ballGraph: GraphSpec = { nodes: { s: { type: 'sdf_expr', params: { code: 'sdSphere(p, 0.5)' } }, m: { type: 'sdf_to_mesh', in: ['s'], params: { divisions: 24 } } }, output: 'm' };
  const ballBefore = await e.cook(ballGraph);
  const cases = [
    ...SAMPLE_TYPES.flatMap((type) => SAMPLE_CASES.map((c) => ({ label: type, prefix: type.split(' ')[0], graph: sampleGraph(type, c.code), ...c }))),
    ...THROW_CASES.map((c) => ({ label: c.node, prefix: c.node, graph: throwGraph(c), ...c })),
  ];
  for (const c of cases) {
    laterRuns++;
    const t = performance.now();
    let r;
    try { r = await e.cook(c.graph); } catch (err: any) { problems.push(`${c.label} ${JSON.stringify(c.code)}: engine.cook threw ${err?.stack ?? err}`); continue; }
    const ms = performance.now() - t;
    const err = r.errors.find((x) => x.node === 't');
    if (r.ok || !err) problems.push(`${c.label} ${JSON.stringify(c.code)}: cooked${r.ok ? '' : ` (${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')})`}`);
    else if (!c.want.test(err.message) || !err.message.startsWith(c.prefix)) problems.push(`${c.label} ${JSON.stringify(c.code)}: unclear error: ${err.message}`);
    if (c.loop && ms > EXPR_TIMEOUT_MS * 3 + 2000) problems.push(`${c.label} ${JSON.stringify(c.code)}: timeout fired late: ${ms.toFixed(0)} ms for a ${EXPR_TIMEOUT_MS} ms limit`);
    if (!c.loop && ms > 2000) problems.push(`${c.label} ${JSON.stringify(c.code)}: took ${ms.toFixed(0)} ms`);
    if (VERBOSE) console.log(`later ${mode} ${ms.toFixed(0).padStart(5)}ms ${c.label} ${JSON.stringify(c.code)}: ${err?.message.slice(0, 120)}`);
  }
  await new Promise((res) => setTimeout(res, 20)); // let any stray promise settle
  // manifold's mesher and the scripting realms still work, with the same results as before the hostile code
  e.cache.clear();
  const ballAfter = await e.cook(ballGraph);
  if (!ballBefore.ok || !ballAfter.ok || JSON.stringify(fingerprint(ballBefore.geo!)) !== JSON.stringify(fingerprint(ballAfter.geo!))) problems.push(`${mode}: sdf_expr → sdf_to_mesh differs after the hostile code: ${ballAfter.errors.map((x) => x.message).join('; ')}`);
  const shape = await e.cook({ nodes: { s: { type: 'sdf_shape', params: { shape: 'torus' } }, m: { type: 'sdf_to_mesh', in: ['s'] } }, output: 'm' });
  if (!shape.ok || !(shape.geo!.numPrims > 0)) problems.push(`${mode}: an analytic sdf_to_mesh fails after the hostile code: ${shape.errors.map((x) => x.message).join('; ')}`);
  const wr = await e.cook(throwGraph({ node: 'wrangle', code: '@P.y += @ptnum;' }));
  if (!wr.ok || wr.geo!.bbox().max[1] !== 440) problems.push(`${mode}: a wrangle no longer works after the hostile code: ${wr.errors.map((x) => x.message).join('; ')}`);
  const sc = await e.cook(throwGraph({ node: 'script', code: "return await lib.run('box', { size: 2 });" }));
  if (!sc.ok || sc.geo!.bbox().max[1] !== 1) problems.push(`${mode}: a script no longer works after the hostile code: ${sc.errors.map((x) => x.message).join('; ')}`);
  // with the pool on, the wrangles (7 hostile or failing ones and the one above) ran in workers
  const tasks = e.host.pool?.stats().tasks ?? 0;
  if (workers && tasks < 8) problems.push(`${mode}: the wrangles did not run on the pool (${tasks} tasks)`);
  await e.host.pool?.close();
  for (const p of problems) { laterFail++; console.log(`FAIL later sampling / thrown values, ${mode}: ${p}`); }
}
console.log(`later sampling, thrown values: ${laterRuns} hostile sdf_to_mesh/sdf_grid/wrangle/script cooks over pool off/on, ${laterFail} failed (${((performance.now() - tl) / 1000).toFixed(1)}s)`);

// ------------------------------------------------------------------ a realm whose stack formatting never returns

/**
 * The scripting realm is shared by every cook of a host, and code can change it: with Error.prepareStackTrace looping,
 * reading the stack of any error created in that realm (a SyntaxError of a syntax check, the host's own timeout error)
 * never returns. Later failing nodes must still fail within the timeout, never hang. The realm is poisoned by a script
 * (main realm) and a point wrangle (the workers' realms when the pool is on), each engine is used for nothing else.
 */
const POISON_CASES: { graph: GraphSpec; prefix: string; want: RegExp }[] = [
  { graph: throwGraph({ node: 'wrangle', code: '@P.y += 1;\nnull.foo;' }), prefix: 'wrangle', want: /^wrangle (exceeded \d+ ms|error: Cannot read)/ },
  { graph: throwGraph({ node: 'wrangle', code: '@P.y += ;' }), prefix: 'wrangle', want: /^wrangle syntax error: .*\(line 1: @P\.y \+= ;\)$/ },
  { graph: throwGraph({ node: 'wrangle', code: 'while (true) {}' }), prefix: 'wrangle', want: /^wrangle exceeded \d+ ms/ },
  { graph: throwGraph({ node: 'script', code: 'null.foo;' }), prefix: 'script', want: /^script error: Cannot read properties of null \(reading 'foo'\)$/ },
  { graph: throwGraph({ node: 'script', code: 'return geo +;' }), prefix: 'script', want: /^script syntax error: Unexpected token ';'$/ },
  { graph: throwGraph({ node: 'script', code: 'while (true) {}' }), prefix: 'script', want: /^script exceeded \d+ ms/ },
  { graph: codeGraph('parametric_curve', '(() => { throw new Error("boom") })()'), prefix: 'parametric_curve', want: /^parametric_curve: boom$/ },
  { graph: codeGraph('parametric_curve', '[t +, 0, 0]'), prefix: 'parametric_curve', want: /^parametric_curve: expression syntax error: / },
  { graph: codeGraph('heightfield_layer', 'x +'), prefix: 'heightfield_layer', want: /^heightfield_layer: expression syntax error: / },
  { graph: sampleGraph('sdf_to_mesh', "p[0] > 0.5 ? (() => { throw new Error('boom') })() : sdSphere(p, 0.5)"), prefix: 'sdf_to_mesh', want: /^sdf_to_mesh: SDF code \(sdf_expr\) failed: boom$/ },
];
let poisonFail = 0;
const tp = performance.now();
for (const workers of [0, 2]) {
  const e = new Engine(createNodeHost({ workers, shelf: false, ...(workers ? { pool: { minElements: 1 } } : {}) }));
  e.manifold = engine.manifold;
  e.scriptTimeoutMs = EXPR_TIMEOUT_MS;
  const mode = workers ? 'pool on' : 'pool off';
  const problems: string[] = [];
  const poison = 'Error.prepareStackTrace = () => { while (true) {} };';
  for (const g of [throwGraph({ node: 'script', code: poison + '\nreturn geo;' }), throwGraph({ node: 'wrangle', code: poison })]) {
    const r = await e.cook(g);
    if (!r.ok) problems.push(`poisoning the realm failed: ${r.errors.map((x) => x.message).join('; ')}`);
  }
  for (const c of POISON_CASES) {
    e.cache.clear();
    const t = performance.now();
    let r;
    try { r = await e.cook(c.graph); } catch (err: any) { problems.push(`${c.prefix}: engine.cook threw ${err?.stack ?? err}`); continue; }
    const ms = performance.now() - t;
    const err = r.errors.find((x) => x.node === 't');
    if (r.ok || !err) problems.push(`${c.prefix}: cooked${r.ok ? '' : ` (${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')})`}`);
    else if (!c.want.test(err.message) || !err.message.startsWith(c.prefix)) problems.push(`${c.prefix}: unclear error: ${err.message}`);
    if (ms > EXPR_TIMEOUT_MS * 3 + 2000) problems.push(`${c.prefix}: took ${ms.toFixed(0)} ms for a ${EXPR_TIMEOUT_MS} ms limit`);
    if (VERBOSE) console.log(`poisoned ${mode} ${ms.toFixed(0).padStart(5)}ms ${c.prefix}: ${err?.message.slice(0, 120)}`);
  }
  await e.host.pool?.close();
  for (const p of problems) { poisonFail++; console.log(`FAIL poisoned realm, ${mode}: ${p}`); }
}
console.log(`poisoned realm: ${POISON_CASES.length} failing nodes × pool off/on after Error.prepareStackTrace loops, ${poisonFail} failed (${((performance.now() - tp) / 1000).toFixed(1)}s)`);
process.exit(fail || exprFail || codeFail || laterFail || poisonFail ? 1 : 0);
