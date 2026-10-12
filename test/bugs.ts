// Regression tests for bugs found by the property and fuzz tests (P0-E), plus a deterministic immutability sweep.
//   node test/bugs.ts [--verbose]
import { allNodeDefs } from '../src/graph/registry.ts';
import type { GraphSpec, NodeDef, NodeSpec } from '../src/graph/types.ts';
import { SKIP, checkGeo, createFixtureEngine, fixtureGraphFor } from './fixtures.ts';
import { diffFields, fingerprint, formatDiff } from './fingerprint.ts';

const VERBOSE = process.argv.includes('--verbose');
const { engine } = await createFixtureEngine();

let fail = 0, pass = 0;
const check = (ok: any, msg: string, detail = '') => {
  if (ok) pass++; else fail++;
  if (!ok || VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}${!ok && detail ? '\n  ' + detail.split('\n').join('\n  ') : ''}`);
};
const fpOf = (g: any) => JSON.stringify(fingerprint(g));
const errs = (r: { errors: { node: string; message: string }[] }) => r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ');

// ------------------------------------------------------------------ 1. subdivide levels:0 must not touch its input

{
  // the wrangle leaves N inconsistent with the shape, so a normal refresh on the input would change it
  const nodes: Record<string, NodeSpec> = {
    s: { type: 'sphere', params: { type: 'ico', level: 1 } },
    j: { type: 'jitter', in: ['s'], params: { scale: [0.2, 0.2, 0.2] } },
    w: { type: 'wrangle', in: ['j'], params: { code: '@N = [0, 1, 0];' } },
    d: { type: 'subdivide', in: ['w'], params: { levels: 0 } },
  };
  engine.cache.clear();
  const up = await engine.cook({ nodes, output: 'w' });
  const before = fpOf(up.geo!);
  const down = await engine.cook({ nodes, output: 'd' });
  check(down.ok, 'subdivide levels:0 cooks', errs(down));
  const after = fpOf(up.geo!);
  check(before === after, 'subdivide levels:0 leaves the cached upstream result byte-identical',
    formatDiff(diffFields(JSON.parse(before), JSON.parse(after)), 8).join('\n'));
  check(down.geo && fpOf(down.geo) === before, 'subdivide levels:0 passes its input through');
}

// ------------------------------------------------------------------ immutability sweep over every node fixture

/** Param variants per node: the fixture params, then each enum option, each bool flipped, each int at its minimum. */
function variants(def: NodeDef, base: Record<string, any>): Record<string, any>[] {
  const out: Record<string, any>[] = [base];
  for (const [name, pd] of Object.entries(def.params)) {
    if (name in base) continue;
    if (pd.type === 'enum') for (const o of pd.options ?? []) { if (o !== pd.default) out.push({ ...base, [name]: o }); }
    else if (pd.type === 'bool') out.push({ ...base, [name]: !pd.default });
    else if (pd.type === 'int' && pd.min !== undefined && pd.min !== pd.default) out.push({ ...base, [name]: pd.min });
  }
  return out.slice(0, 24);
}

{
  const t0 = performance.now();
  let cooks = 0;
  const broken = new Set<string>();
  for (const def of allNodeDefs()) {
    if (SKIP.has(def.type) || !def.inputs.length) continue;
    const fixture = fixtureGraphFor(def.type);
    // second pass: input 0 carries point normals that do not match its shape, so an in-place normal refresh shows up
    const ins = Array.isArray(fixture.nodes.target.in) ? fixture.nodes.target.in : [];
    const stale: GraphSpec | null = typeof ins[0] === 'string'
      ? { ...fixture, nodes: { ...fixture.nodes, STALE_N: { type: 'wrangle', in: [ins[0]], params: { code: '@N = [0, 1, 0];' } }, target: { ...fixture.nodes.target, in: ['STALE_N', ...ins.slice(1)] } } }
      : null;
    for (const graph of stale ? [fixture, stale] : [fixture])
    for (const params of variants(def, graph.nodes.target.params ?? {})) {
      const upstream = Object.keys(graph.nodes).filter((n) => n !== 'target');
      const g: GraphSpec = { ...graph, nodes: { ...graph.nodes, target: { ...graph.nodes.target, params } } };
      // cook (or fetch from the cache) every upstream result first, then the target: the cache hands the target
      // the very objects fingerprinted here
      const before = new Map<string, { geo: any; fp: string }>();
      for (const n of upstream) {
        const r = await engine.cook({ ...g, output: n });
        if (r.geo) before.set(n, { geo: r.geo, fp: fpOf(r.geo) });
      }
      const t = performance.now();
      await engine.cook(g);
      cooks++;
      for (const [n, b] of before) {
        const now = fpOf(b.geo);
        if (now !== b.fp && !broken.has(def.type)) {
          broken.add(def.type);
          check(false, `immutability: ${def.type} ${JSON.stringify(params)} wrote to its input "${n}"`,
            formatDiff(diffFields(JSON.parse(b.fp), JSON.parse(now)), 8).join('\n'));
        }
      }
      if (performance.now() - t > 1500) break; // slow node: the fixture params are enough
    }
  }
  check(!broken.size, `immutability sweep: ${cooks} cooks, no node writes to its inputs (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}

// ------------------------------------------------------------------ 2. edge-case inputs: node errors, never raw JS errors

/** Same pattern as property.ts --strict: errors that are JS faults rather than a NodeError with a message. */
const INTERNAL = /(TypeError|RangeError|ReferenceError|Cannot read propert|is not a function|is not iterable|is not defined|Invalid array length|Maximum call stack|undefined \(reading)/;

/** Degenerate inputs, built by script nodes so they do not depend on other nodes' edge behaviour. */
const EDGE: Record<string, string> = {
  EMPTY: 'return new lib.Geometry();',
  ONE_POINT: 'return new lib.Geometry({ positions: [0.1, 0.2, 0.3] });',
  POINTS: 'return new lib.Geometry({ positions: [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1] });',
  LINE: 'return new lib.Geometry({ positions: [0, 0, 0, 1, 0.5, 0], prims: [[0, 1]], closed: false });',
  DEGENERATE: 'return new lib.Geometry({ positions: [0, 0, 0, 0, 0, 0, 0, 0, 0], prims: [[0, 1, 2]] });',
  COLLINEAR: 'return new lib.Geometry({ positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], prims: [[0, 1, 2]] });',
};

for (const name of ['fill', 'offset_curve', 'boolean2d']) {
  for (const edge of ['EMPTY', 'POINTS']) {
    const nodes: Record<string, NodeSpec> = { e: { type: 'script', params: { code: EDGE[edge] } }, t: { type: name, in: ['e'] } };
    const r = await engine.cook({ nodes, output: 't' });
    check(r.ok && r.geo && r.geo.numPrims === 0, `${name} on ${edge} input cooks to empty geometry`, errs(r));
  }
}
{
  // boolean2d with one empty side: union / xor give the other side, in its own plane
  const nodes: Record<string, NodeSpec> = {
    e: { type: 'script', params: { code: EDGE.EMPTY } },
    c: { type: 'circle', params: { radius: 0.5, center: [0, 2, 0] } },
    u: { type: 'boolean2d', in: ['e', 'c'], params: { operation: 'union' } },
    s: { type: 'boolean2d', in: ['c', 'e'], params: { operation: 'subtract' } },
    i: { type: 'boolean2d', in: ['e', 'c'], params: { operation: 'intersect' } },
  };
  const u = await engine.cook({ nodes, output: 'u' });
  check(u.ok && u.geo!.numPrims === 1 && Math.abs(u.geo!.bbox().min[1] - 2) < 1e-6, 'boolean2d union(empty, circle) = circle at its own height', errs(u) || `prims ${u.geo?.numPrims} y ${u.geo?.bbox().min[1]}`);
  const s = await engine.cook({ nodes, output: 's' });
  check(s.ok && s.geo!.numPrims === 1, 'boolean2d subtract(circle, empty) = circle', errs(s));
  const i = await engine.cook({ nodes, output: 'i' });
  check(i.ok && i.geo!.numPrims === 0, 'boolean2d intersect(empty, circle) = empty', errs(i));
}

{
  const t0 = performance.now();
  let cooks = 0;
  const internal: string[] = [];
  for (const def of allNodeDefs()) {
    if (SKIP.has(def.type) || !def.inputs.length) continue;
    const fixture = fixtureGraphFor(def.type);
    const ins = Array.isArray(fixture.nodes.target.in) ? fixture.nodes.target.in : [];
    for (const edge of Object.keys(EDGE)) {
      // input 0 degenerate (other inputs from the fixtures), then every input degenerate
      for (const all of ins.length > 1 ? [false, true] : [false]) {
        const nodes: Record<string, NodeSpec> = { ...fixture.nodes, [edge]: { type: 'script', params: { code: EDGE[edge] } } };
        const wired = ins.length ? ins.map((x, k) => (k === 0 || all ? edge : x)) : [edge];
        nodes.target = { ...fixture.nodes.target, in: wired };
        let r;
        try {
          r = await engine.cook({ nodes, output: 'target' });
        } catch (e: any) {
          internal.push(`${def.type} on ${edge}${all ? ' (all inputs)' : ''}: engine.cook threw ${e?.message ?? e}`);
          continue;
        }
        cooks++;
        const err = r.errors.find((e) => e.node === 'target');
        if (err && INTERNAL.test(err.message)) internal.push(`${def.type} on ${edge}${all ? ' (all inputs)' : ''}: ${err.message.slice(0, 160)}`);
        if (r.geo) {
          const inv = checkGeo(r.geo);
          if (inv.length) internal.push(`${def.type} on ${edge}${all ? ' (all inputs)' : ''}: checkGeo ${inv.join(', ')}`);
        }
      }
    }
  }
  check(!internal.length, `edge-case sweep: ${cooks} cooks on empty / point / line / degenerate inputs, no raw JS errors (${((performance.now() - t0) / 1000).toFixed(1)}s)`, internal.join('\n'));
}

// ------------------------------------------------------------------ 3. script continuations are inside the timeout

{
  const script = async (code: string, src = 'b') => {
    engine.cache.clear();
    const nodes: Record<string, NodeSpec> = { b: { type: 'box' }, s: { type: 'script', in: [src], params: { code } } };
    const t = performance.now();
    const r = await engine.cook({ nodes, output: 's' });
    return { r, ms: performance.now() - t };
  };
  const saved = engine.scriptTimeoutMs;
  engine.scriptTimeoutMs = 400;
  for (const code of ['await 0; while (true) {}', "await lib.run('sphere');\nwhile (true) {}", "await lib.run('script', { code: 'return geo;' });\nwhile (true) {}", 'await new Promise(() => {});']) {
    const { r, ms } = await script(code);
    check(!r.ok && /script exceeded 400 ms/.test(r.errors[0]?.message ?? '') && ms < 2000, `script timeout covers ${JSON.stringify(code)} (${ms.toFixed(0)} ms)`, errs(r));
  }
  engine.scriptTimeoutMs = saved;

  // lib.run keeps working across awaits, for synchronous nodes and for async ones (script, file), also in parallel
  const fileObj = (await engine.cook(fixtureGraphFor('file'))).geo!;
  const ok = [
    ["const a = await lib.run('box');\nawait 0;\nconst b = await lib.run('sphere', { radius: 0.5 });\nreturn lib.merge([a, b]);", 6 + 512],
    ["const s = await lib.run('script', { code: 'await 0; return lib.run(\"box\");' });\nreturn s;", 6],
    [`const f = await lib.run('file', { path: ${JSON.stringify(fixtureGraphFor('file').nodes.target.params!.path)} });\nreturn f;`, fileObj.numPrims],
    ["const ps = [];\nfor (let i = 0; i < 10; i++) ps.push(lib.run('script', { code: 'await 0; return lib.run(\"box\", { center: [' + i + ', 0, 0] });' }));\nreturn lib.merge(await Promise.all(ps));", 60],
    ["const parts = [];\nfor (let i = 0; i < 50; i++) parts.push(await lib.run('script', { code: 'return lib.run(\"box\");' }));\nreturn lib.merge(parts);", 300],
  ] as const;
  for (const [code, prims] of ok) {
    const { r, ms } = await script(code);
    check(r.ok && r.geo!.numPrims === prims, `script with lib.run after await cooks (${ms.toFixed(0)} ms): ${JSON.stringify(code).slice(0, 70)}`, errs(r) || `prims ${r.geo?.numPrims}, want ${prims}`);
  }
  const { r: err } = await script("await lib.run('nope');");
  check(!err.ok && /unknown node type "nope"/.test(err.errors[0]?.message ?? ''), 'lib.run errors still reject the awaiting script', errs(err));

  // stray rejections inside a script must not take the process down (they used to: unhandled rejection)
  for (const code of ["lib.run('nope'); return geo;", "Promise.reject(new Error('x')); return geo;", "[1, 2].forEach(async () => { throw new Error('cb'); }); return geo;"]) {
    const { r } = await script(code);
    await new Promise((res) => setTimeout(res, 20));
    check(r.ok, `stray rejection does not crash the process: ${code}`, errs(r));
  }
  const w = await engine.cook({ nodes: { b: { type: 'box' }, w: { type: 'wrangle', in: ['b'], params: { code: '@P.y += 1;' } } }, output: 'w' });
  check(w.ok && w.geo!.bbox().min[1] > 0, 'a wrangle after timed-out scripts still cooks', errs(w));
}

console.log(`bugs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
