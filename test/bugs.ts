// Regression tests for bugs found by the property and fuzz tests, plus a deterministic immutability sweep.
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

// ------------------------------------------------------------------ 5. the boolean fixture has a real result

{
  const r = await engine.cook(fixtureGraphFor('boolean'));
  const g = r.geo;
  const count = (name: string) => g?.primGroups.get(name)?.reduce((s, x) => s + x, 0) ?? 0;
  check(r.ok && g && g.numPrims > 0 && count('from_a') > 0 && count('from_b') > 0,
    `boolean fixture cuts B out of A (${g?.numPrims} prims, from_a ${count('from_a')}, from_b ${count('from_b')})`, errs(r));
}

// ------------------------------------------------------------------ 5b. boolean with overlapping pieces in B
// A cutter made of overlapping pieces used to go to the kernel as one multi-piece solid: where the pieces overlap the
// region counted twice and stayed solid, with no warning. B's pieces are now unioned first (cavities kept).

{
  const { signedVolume } = await import('../src/core/topology.ts');
  const { solidReport } = await import('../src/core/report.ts');
  const nodes = (op: string, extra: Record<string, NodeSpec> = {}, a = 'a'): Record<string, NodeSpec> => ({
    a: { type: 'box', params: { size: [4, 4, 4] } },
    ma: { type: 'material', in: ['a'], params: { name: 'stone' } },
    b1: { type: 'box', params: { size: [2, 2, 6] } },
    b2: { type: 'box', params: { size: [3, 3, 2] } },
    b: { type: 'merge', in: ['b1', 'b2'] },
    mb: { type: 'material', in: ['b'], params: { name: 'cut' } },
    ...extra,
    c: { type: 'boolean', in: [a, 'mb'], params: { operation: op } },
  });
  // inside A, B1 takes 2×2×4 = 16, B2 3×3×2 = 18, their overlap 2×2×2 = 8: the union of B's pieces in A is 26
  for (const [op, want, graph] of [
    ['subtract', 64 - 26, nodes('subtract', {}, 'ma')],
    ['intersect', 26, nodes('intersect', {}, 'ma')],
    ['union', 72, nodes('union', {}, 'ma')],
    // a hollow cutter: the inner shell (a cavity in B1, outside B2) stays with its piece, so a core is left standing
    ['subtract hollow', 64 - 26 + 0.125, nodes('subtract', {
      h0: { type: 'box', params: { size: [0.5, 0.5, 0.5], center: [0, 0, 1.5] } }, h: { type: 'reverse', in: ['h0'] },
      b: { type: 'merge', in: ['b1', 'b2', 'h'] },
    }, 'ma')],
  ] as [string, number, GraphSpec['nodes']][]) {
    const r = await engine.cook({ nodes: graph, output: 'c' });
    const g = r.geo;
    const vol = g ? signedVolume(g) : NaN;
    check(r.ok && Math.abs(vol - want) < 1e-4 && solidReport(g!).closedAfterWeld,
      `boolean ${op} with overlapping pieces in B has volume ${want} and is closed (${vol.toFixed(4)})`, errs(r));
    if (op !== 'subtract' || !g) continue;
    const mat = g.prims.get('material'), fromB = g.primGroups.get('from_b')!, fromA = g.primGroups.get('from_a')!;
    let bad = 0, cut = 0;
    for (let pr = 0; pr < g.numPrims; pr++) {
      const m = mat?.get(pr);
      if (fromB[pr]) cut++;
      if (fromB[pr] ? m !== 'cut' : !fromA[pr] || m !== 'stone') bad++;
    }
    check(cut > 0 && bad === 0, `boolean subtract: the cut faces carry B's material, the rest A's (${cut} cut faces, ${bad} wrong)`);
  }
  // A's own overlapping pieces are unioned too, with or without B
  const two = { a1: { type: 'box', params: { size: [4, 4, 4] } }, a2: { type: 'box', params: { size: [1, 1, 1], center: [1.5, 1.5, 1.5] } }, aa: { type: 'merge', in: ['a1', 'a2'] } };
  const ra = await engine.cook({ nodes: nodes('subtract', two, 'aa'), output: 'c' });
  check(ra.ok && Math.abs(signedVolume(ra.geo!) - 38) < 1e-4, `boolean subtract with overlapping pieces in A and B (${ra.geo && signedVolume(ra.geo).toFixed(4)})`, errs(ra));
  // without B a hollow A keeps its cavity
  const rh = await engine.cook({ nodes: {
    o: { type: 'box', params: { size: [4, 4, 4] } }, i0: { type: 'box', params: { size: [2, 2, 2] } }, i: { type: 'reverse', in: ['i0'] },
    a: { type: 'merge', in: ['o', 'i'] }, c: { type: 'boolean', in: ['a'] },
  }, output: 'c' });
  check(rh.ok && Math.abs(signedVolume(rh.geo!) - 56) < 1e-4, `boolean without B keeps a cavity in A (${rh.geo && signedVolume(rh.geo).toFixed(4)})`, errs(rh));
  // touching pieces fuse into one
  const rt = await engine.cook({ nodes: {
    t1: { type: 'box' }, t2: { type: 'box', params: { center: [1, 0, 0] } }, a: { type: 'merge', in: ['t1', 't2'] }, c: { type: 'boolean', in: ['a'] },
  }, output: 'c' });
  check(rt.ok && solidReport(rt.geo!).pieces === 1 && Math.abs(signedVolume(rt.geo!) - 2) < 1e-6, `boolean without B fuses touching pieces (${rt.geo && solidReport(rt.geo).pieces} pieces)`, errs(rt));
}

// ------------------------------------------------------------------ 5c. triangulation keeps every corner of a polygon
// earcut leaves out corners that repeat or lie on a straight run, so a polygon's edges through them were missing from
// its triangles: cracks in exports, and a boolean's own polygons (three slots unioned into a star leave three corners
// 1e-11 m apart) rejected as "not a closed solid" by the next boolean.

{
  const { Geometry } = await import('../src/core/geometry.ts');
  const { triangulate } = await import('../src/core/topology.ts');
  const { solidReport } = await import('../src/core/report.ts');
  // an L with a corner on its long edge, a repeated corner and two corners on a straight run of the short arm
  const ring: [number, number][] = [[0, 0], [1, 0], [2, 0], [2, 0], [2, 1], [1, 1], [1, 2], [1, 3], [0, 3]];
  const g = new Geometry({ positions: ring.flatMap(([x, z]) => [x, 0, z]), prims: [ring.map((_, i) => i)] });
  const { tris } = triangulate(g);
  const vp = g.vertexPoint, uses = new Map<string, number>();
  for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) { const key = `${vp[tris[t + k]]}>${vp[tris[t + (k + 1) % 3]]}`; uses.set(key, (uses.get(key) ?? 0) + 1); }
  const missing = ring.map((_, i) => `${i}>${(i + 1) % ring.length}`).filter((e) => uses.get(e) !== 1 && uses.get(e.split('>').reverse().join('>')) !== 1);
  check(missing.length === 0, `triangulate keeps every edge of a polygon with repeated and collinear corners (${missing.length ? 'missing ' + missing.join(', ') : `${tris.length / 3} triangles`})`);
  const star = await engine.cook({ nodes: {
    profile: { type: 'curve', params: { points: [[0, 0.2125, 0], [0.0275, 0.2125, 0], [0.0275, 0.2335, 0], [0.0225, 0.2335, 0], [0.0225, 0.24, 0], [0.0185, 0.24, 0], [0.0185, 0.2905, 0], [0.0092, 0.2905, 0], [0.0092, 0.262, 0], [0, 0.262, 0]] } },
    turned: { type: 'revolve', in: ['profile'], params: { segments: 18 } },
    laid: { type: 'transform', in: ['turned'], params: { rotate: [-90, 0, 0], translate: [0, 0.046, 0] } },
    welded: { type: 'fuse', in: ['laid'], params: { distance: 0.0001 } },
    slot: { type: 'box', params: { size: [0.005, 0.05, 0.0245], center: [0, 0.046, -0.2802] } },
    slots: { type: 'copy_xform', in: ['slot'], params: { count: 3, rotate: [0, 0, 60], pivot: [0, 0.046, 0] } },
    star: { type: 'boolean', in: ['slots'], params: { operation: 'union' } },
    cut: { type: 'boolean', in: ['welded', 'star'], params: { operation: 'subtract' } },
  }, output: 'cut' });
  check(star.ok && solidReport(star.geo!).closed, `a star of three slots, unioned, cuts a turned part (${star.geo ? `${star.geo.numPrims} prims` : 'no result'})`, errs(star));
}

// ------------------------------------------------------------------ 5d. revolve caps wind with its sides
// The caps of a partial revolve were wound against the sides they share edges with (8 inconsistent edges for a square
// profile), so the closed solid was inside-out at its caps and orienting it outward could not fix it; flip hid it.

{
  const { solidReport } = await import('../src/core/report.ts');
  const { signedVolume } = await import('../src/core/topology.ts');
  const ccw = [[3, 0, 0], [3.6, 0, 0], [3.6, 4, 0], [3, 4, 0]];
  const profiles: [string, number[][], number[]][] = [
    ['square', ccw, [0, 1, 0]],
    ['square drawn clockwise', ccw.slice().reverse(), [0, 1, 0]],
    ['profile touching the axis', [[0, 0, 0], [1, 0, 0], [0.6, 1, 0], [0, 1.4, 0]], [0, 1, 0]],
    ['square about X', [[0, 3, 0], [0, 3.6, 0], [1, 3.6, 0], [1, 3, 0]], [1, 0, 0]],
  ];
  const angles = [[-30, 30], [0, 300], [-360, -60], [0, 90], [90, 0], [0, -120], [45, 46]];
  const bad: string[] = [];
  let cases = 0;
  for (const [name, points, axis] of profiles) for (const angle of angles) {
    const vols: number[] = [];
    for (const flip of [false, true]) {
      const r = await engine.cook({ nodes: {
        p: { type: 'curve', params: { points, closed: true } },
        a: { type: 'revolve', in: ['p'], params: { segments: 10, angle, axis, caps: true, flip } },
      }, output: 'a' });
      cases++;
      const rep = r.geo && solidReport(r.geo);
      const vol = r.geo ? signedVolume(r.geo) : NaN;
      vols.push(vol);
      if (!r.ok || !rep!.closed || rep!.flippedEdges || rep!.inwardPieces || !(vol > 0))
        bad.push(`${name} angle [${angle}] flip ${flip}: ${r.ok ? `closed ${rep!.closed}, ${rep!.flippedEdges} inconsistent edges, ${rep!.inwardPieces} inward, volume ${vol.toFixed(3)}` : errs(r)}`);
    }
    if (Math.abs(vols[0] - vols[1]) > 1e-9) bad.push(`${name} angle [${angle}]: flip changes the volume (${vols[0]} vs ${vols[1]})`);
  }
  check(bad.length === 0, `capped partial revolves are consistent, closed and outward for every angle, profile direction and flip (${cases} cooks)`, bad.slice(0, 6).join('\n'));
}

// ------------------------------------------------------------------ 5e. polywire width is not scaled by pscale
// polywire multiplied width by pscale, so particle trails (pscale 0.05, width 0.2) came out 20 times too thin.

{
  const tubeRadius = async (code: string, params: Record<string, any> = {}) => {
    const r = await engine.cook({ nodes: {
      l: { type: 'line', params: { origin: [0, 0, 0], direction: [1, 0, 0], length: 2, points: 3 } },
      w: { type: 'wrangle', in: ['l'], params: { code } },
      t: { type: 'polywire', in: ['w'], params: { divisions: 16, ...params } },
    }, output: 't' });
    if (!r.ok || !r.geo) return NaN;
    const b = r.geo.bbox();
    return (b.max[1] - b.min[1]) / 2;
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const w = await tubeRadius('@pscale = 0.05; @width = 0.2;');
  check(near(w, 0.1), `polywire takes the radius from width alone when pscale is small (radius ${w}, want 0.1)`);
  const wOff = await tubeRadius('@pscale = 0.05; @width = 0.2;', { use_width: false, radius: 0.5 });
  check(near(wOff, 0.025), `polywire with use_width off keeps radius × pscale (radius ${wOff}, want 0.025)`);
  const ps = await tubeRadius('@pscale = 2;', { radius: 0.1 });
  check(near(ps, 0.2), `polywire without width keeps radius × pscale (radius ${ps}, want 0.2)`);
  const sw = await engine.cook({ nodes: {
    l: { type: 'line', params: { origin: [0, 0, 0], direction: [1, 0, 0], length: 2, points: 3 } },
    w: { type: 'wrangle', in: ['l'], params: { code: '@pscale = 0.5; @width = 4;' } },
    s: { type: 'sweep', in: ['w'], params: { radius: 0.2, divisions: 16, caps: false } },
  }, output: 's' });
  const sb = sw.geo?.bbox();
  check(sb && near((sb.max[1] - sb.min[1]) / 2, 0.1), `sweep still scales its profile by pscale and ignores width (${sb ? (sb.max[1] - sb.min[1]) / 2 : errs(sw)})`);
}

// ------------------------------------------------------------------ 6. watertight ray-triangle tests
// A ray through a shared edge or vertex used to miss both triangles or hit several (Möller–Trumbore rounding): the
// `ray` node lost points on seams and inside/outside parity counts went wrong.

{
  const { Geometry } = await import('../src/core/geometry.ts');
  const { TriBVH } = await import('../src/core/spatial.ts');
  const { RayScene } = await import('../src/core/analysis.ts');
  const { rng } = await import('../src/core/random.ts');
  const D = new Float64Array(96), ID = new Float64Array(96);
  /** Every query of one ray: raycast hits, raycastAll / countHits count, nearest is finite, the packet test hits. */
  const probe = (g: InstanceType<typeof Geometry>, o: number[], d: number[]) => {
    const bvh = new TriBVH(g), sc = new RayScene(bvh);
    D[0] = d[0]; D[1] = d[1]; D[2] = d[2];
    for (let c = 0; c < 3; c++) ID[c] = 1 / (d[c] || 1e-300);
    return {
      hit: !!bvh.raycast(o[0], o[1], o[2], d[0], d[1], d[2], Infinity, 0),
      all: bvh.raycastAll(o[0], o[1], o[2], d[0], d[1], d[2]).length,
      count: sc.countHits(o[0], o[1], o[2], d[0], d[1], d[2]),
      near: sc.nearest(o[0], o[1], o[2], d[0], d[1], d[2]) < Infinity,
      packet: sc.occludedPacket(o[0], o[1], o[2], D, ID, 1, Infinity) === 1,
    };
  };
  const once = (r: ReturnType<typeof probe>) => r.hit && r.near && r.packet && r.all === 1 && r.count === 1;
  const show = (r: ReturnType<typeof probe>) => JSON.stringify(r);

  // two-triangle quads (shared diagonal 0-2), tilted and non-planar but not folded along the ray, rays through the seam
  const r = rng(11);
  let rays = 0, bad = 0, firstBad = '';
  for (let k = 0; k < 3000; k++) {
    const pts = Array.from({ length: 12 }, () => r() * 2 - 1);
    const g = new Geometry({ positions: pts, prims: [[0, 1, 2], [0, 2, 3]] });
    const t = r(), q = [0, 1, 2].map((c) => pts[c] + (pts[6 + c] - pts[c]) * t);
    const o = [q[0] + r() * 4 - 2, q[1] + 3, q[2] + r() * 4 - 2], d = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
    const facing = (i: number, j: number, l: number) => {
      const u = [0, 1, 2].map((c) => pts[j * 3 + c] - pts[i * 3 + c]), v = [0, 1, 2].map((c) => pts[l * 3 + c] - pts[i * 3 + c]);
      return Math.sign((u[1] * v[2] - u[2] * v[1]) * d[0] + (u[2] * v[0] - u[0] * v[2]) * d[1] + (u[0] * v[1] - u[1] * v[0]) * d[2]);
    };
    if (facing(0, 1, 2) !== facing(0, 2, 3)) continue; // a folded silhouette may rightly give 0 or 2
    rays++;
    const res = probe(g, o, d);
    if (!once(res)) { bad++; firstBad ||= `quad ${k}: ${show(res)}`; }
  }
  check(rays > 1000 && bad === 0, `rays down the seam of ${rays} two-triangle quads hit exactly one triangle`, `${bad} wrong; first: ${firstBad}`);

  // exact seam of an axis-aligned quad: vertical rays through the diagonal
  const quad = new Geometry({ positions: [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], prims: [[0, 1, 2], [0, 2, 3]] });
  bad = 0; firstBad = '';
  for (let k = 0; k <= 40; k++) {
    const t = -1 + k / 20 + (k % 3) * 1e-3;
    const res = probe(quad, [t, 2, t], [0, -1, 0]);
    if (!(t > -1 && t < 1) || once(res)) continue;
    bad++; firstBad ||= `t ${t}: ${show(res)}`;
  }
  check(bad === 0, 'vertical rays through the diagonal of a quad hit exactly one triangle', firstBad);

  // a fan of 7 triangles around a vertex: rays through the centre vertex, vertical and tilted
  const ring = [[1, 0.1], [0.6, 0.9], [-0.3, 1.1], [-1.2, 0.2], [-0.8, -0.9], [0.1, -1.3], [0.9, -0.7]];
  const fanPos = [0.05, 0.02, -0.03, ...ring.flatMap(([x, z], i) => [x, 0.1 * Math.sin(i), z])];
  const fan = new Geometry({ positions: fanPos, prims: ring.map((_, i) => [0, 1 + i, 1 + ((i + 1) % ring.length)]) });
  bad = 0; firstBad = '';
  for (const d of [[0, -1, 0], [0.3, -1, 0.2], [-0.5, -1, 0.1], [0.01, -1, -0.7], [1e-9, -1, 0]]) {
    const o = [0.05 - d[0] * 2, 0.02 - d[1] * 2, -0.03 - d[2] * 2];
    const res = probe(fan, o, d);
    if (!once(res)) { bad++; firstBad ||= `dir ${d}: ${show(res)}`; }
  }
  check(bad === 0, 'rays through the centre vertex of a triangle fan hit exactly one triangle', firstBad);

  // interior vertices and edge midpoints of a triangulated grid, and box corners seen from inside
  const grid = (await engine.cook({ nodes: { g: { type: 'grid', params: { size: [3, 3], divisions: [5, 5] } }, t: { type: 'triangulate', in: ['g'] } }, output: 't' })).geo!;
  bad = 0; firstBad = '';
  for (let i = 0; i < grid.numPoints; i++) {
    const x = grid.P[i * 3], z = grid.P[i * 3 + 2];
    if (Math.abs(x) > 1.4 || Math.abs(z) > 1.4) continue;
    const res = probe(grid, [x, 1, z], [0, -1, 0]);
    if (!once(res)) { bad++; firstBad ||= `point ${i}: ${show(res)}`; }
  }
  check(bad === 0, 'vertical rays through the interior vertices of a triangulated grid hit exactly one triangle', firstBad);
  const box = (await engine.cook({ nodes: { b: { type: 'box', params: { divisions: [2, 2, 2] } } }, output: 'b' })).geo!;
  bad = 0; firstBad = '';
  for (let i = 0; i < box.numPoints; i++) {
    const res = probe(box, [0, 0, 0], [box.P[i * 3], box.P[i * 3 + 1], box.P[i * 3 + 2]]);
    if (!once(res)) { bad++; firstBad ||= `point ${i}: ${show(res)}`; }
  }
  check(bad === 0, 'rays from inside a box through its vertices cross the surface exactly once', firstBad);

  // the ray node projects every point above a grid's vertices, seams and boundary (boundaries stay closed)
  const pr = await engine.cook({ nodes: {
    g: { type: 'grid', params: { size: [2, 2], divisions: [4, 4] } }, t: { type: 'triangulate', in: ['g'] },
    p: { type: 'point_grid', params: { counts: [9, 1, 9], size: [2, 0, 2], center: [0, 1, 0] } },
    r: { type: 'ray', in: ['p', 't'], params: { delete_misses: true } },
  }, output: 'r' });
  check(pr.ok && pr.geo!.numPoints === 81, `ray node keeps all 81 points above a grid's vertices, seams and border (${pr.geo?.numPoints})`, errs(pr));
}

console.log(`bugs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
