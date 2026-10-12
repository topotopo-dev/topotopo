// Wrangle fuzz: random snippets from a small grammar, plus malformed and never-ending ones.
//
//   node test/fuzz.ts [--count N] [--seed S] [--verbose]      (FUZZ_COUNT env also sets the count)
//
// Asserts:
//   - nothing hangs: infinite loops are stopped by the sandbox timeout (the run happens in a child process
//     with a hard wall-clock limit, so a timeout that fails to fire fails the test instead of hanging CI),
//   - malformed code fails the wrangle node (a per-node error, never a throw) with a "(line N: …)" hint,
//   - valid code cooks, passes checkGeo, and is deterministic.
import { spawnSync } from 'node:child_process';
import { rng } from '../src/core/random.ts';
import type { Engine } from '../src/graph/engine.ts';
import type { NodeSpec } from '../src/graph/types.ts';
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

interface Case { kind: 'valid' | 'malformed' | 'hang'; code: string; runOver: string; source: string; line?: number; knownGap?: string }

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
  // the parser only notices these at the end of the generated kernel, past the snippet's last line
  { code: '@Cd = [1, 0, 0', knownGap: 'unclosed bracket: error is reported after the snippet ends' },
  { code: '}', knownGap: 'stray closing brace closes the generated kernel early' },
];

const HANGS = ['while(true){}', 'for(;;){ @P.y += 0; }', 'while (@P.y < 1e9) { @Cd = [0, 0, 0]; }', 'let k = 0;\nwhile (k >= 0) { k++; }'];

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
  return cases;
}

// ------------------------------------------------------------------ run

async function cookCase(engine: Engine, c: Case) {
  const nodes: Record<string, NodeSpec> = {};
  addFixture(nodes, c.source);
  nodes.w = { type: 'wrangle', in: [c.source], params: { code: c.code, run_over: c.runOver } };
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
    console.log(`FAIL #${i} ${c.kind} (run_over ${c.runOver}, on ${c.source})`);
    console.log('  code: ' + JSON.stringify(c.code));
    for (const p of problems) console.log('  ' + p);
  } else if (VERBOSE) console.log(`ok   #${i} ${c.kind.padEnd(9)} ${ms.toFixed(0).padStart(5)}ms ${JSON.stringify(c.code).slice(0, 100)}`);
}

const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`wrangle fuzz: ${cases.length} snippets (${counts.valid} valid, ${counts.malformed} malformed, ${counts.hang} infinite loops; seed ${SEED}), ${fail} failed, ${gaps} known line-hint gaps (${secs}s)`);
process.exit(fail ? 1 : 0);
