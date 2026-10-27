// Code nodes: per-element wrangles and whole-geometry scripts.
import { GeoBuilder, Geometry, isGeometry } from '../core/geometry.ts';
import { defineNode, getNodeDef } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext } from '../graph/types.ts';
import { runWrangleParallel } from '../core/wrangle.ts';
import { andThen } from '../graph/parallel.ts';
import type { RunOver } from '../core/wrangle.ts';
import { resolveParams } from '../graph/params.ts';
import * as math from '../core/math.ts';
import * as topology from '../core/topology.ts';
import * as random from '../core/random.ts';
import { fractal, makeCurl, makeNoise } from '../core/noise.ts';
import { KDTree, TriBVH } from '../core/spatial.ts';
import { fromManifold, propLayout, toManifold } from '../core/manifold.ts';
import { evalGroup, evalEdgeGroup } from '../core/groups.ts';
import { halfEdges } from '../core/halfedge.ts';
import { EdgeSet } from '../core/edges.ts';
import { convertSelection } from '../core/groupconvert.ts';
import { appendElements } from '../core/wrangle.ts';
import { composePackedXforms, expandPacked, packedInfo } from '../core/packed.ts';
import { codeVarDecl, codeVarNames, codeVarValues, describeGuarded, runUserCode } from '../core/usercode.ts';
import { scriptVarsGuard } from '../core/snippet-lib.ts';
import { mask, wrangleTime } from './util.ts';

/** points below which a wrangle stays on the cooking thread (copying the attributes would cost more than it saves) */
const WRANGLE_MIN_POINTS = 65536;

defineNode({
  type: 'wrangle',
  category: 'code',
  // points/prims/detail work on instances (anchors, packed prims); vertices are the instances' corners
  packed: (p) => (p.run_over === 'vertices' ? 'unpack' : 'keep'),
  summary: 'Run a JS snippet per point / prim / vertex (or once) with VEX-style @attributes. The universal escape hatch.',
  aliases: ['attribwrangle', 'pointwrangle', 'primwrangle', 'vex', 'snippet', 'attribute_wrangle'],
  description:
    'Code runs once per element with @attr bound to the current element. Read/write any attribute: @P, @N, @Cd, @pscale, @orient... ' +
    'New attributes are created on write (type from prefix f@ i@ v@ p@ u@ s@, a known name, or the first assigned value). ' +
    'Vectors are arrays with .x/.y/.z accessors; use add/sub/mul/div/dot/cross/normalize/length/lerp/fit (no operator overloading). ' +
    'Element numbers: @ptnum @primnum @vtxnum @numpt @numprim @elemnum. Groups: @group_name = 1. ' +
    'Time: @Frame @Time @TimeInc (the wrangle re-cooks per frame only when the code uses them). ' +
    'Graph vars by their bare name, read-only, as in "=expr" params: @P.y += height * 0.5 (iteration, value … inside a foreach). ' +
    'Inputs 1-3 are readable with point(1, "P", i), nearpoint(1, pos), xyzdist(1, pos)… ' +
    'Create/delete with addpoint, addprim, removepoint, removeprim (applied after the run). See help topic "wrangle" for the full function list.',
  inputs: [
    { name: 'geo', desc: 'geometry to process' },
    { name: 'input1', desc: 'extra input readable as 1', optional: true },
    { name: 'input2', desc: 'extra input readable as 2', optional: true },
    { name: 'input3', desc: 'extra input readable as 3', optional: true },
  ],
  params: {
    code: { type: 'code', default: '', desc: 'JS snippet (statements). Example: "@P.y += noise(@P) * 0.2; @Cd = [@P.y, 0.5, 1];"', aliases: ['snippet', 'vexpression', 'vex'] },
    run_over: { type: 'enum', options: ['points', 'prims', 'vertices', 'detail'], default: 'points', desc: 'element class to iterate', aliases: ['class', 'runover'] },
    group: { type: 'group', default: '', desc: 'only run on elements in this group (point, prim or vertex pattern, matching run_over)' },
  },
  usesVars: (p) => String(p.code ?? ''),
  example: { type: 'wrangle', params: { run_over: 'points', code: '@P.y += sin(@P.x * 4) * 0.2;\n@Cd = hsv2rgb(fit(@P.y, -0.2, 0.2, 0.6, 0), 0.7, 1);' } },
  cook: (ctx) => {
    const { input, inputs, p, vars, engine, warn } = ctx;
    const g = input(0);
    const ro = p.run_over as RunOver;
    const m = ro === 'points' ? mask(g, 'point', p.group) : ro === 'prims' ? mask(g, 'prim', p.group) : ro === 'vertices' ? mask(g, 'vertex', p.group) : null;
    if (!p.code.trim()) return g;
    // point wrangles without cross-element calls run in chunks on the worker pool (each worker compiles the same
    // kernel in its own realm); everything else runs here
    const res = runWrangleParallel(g.clone(), {
      code: p.code, runOver: ro, mask: m, vars, host: engine.host, timeoutMs: engine.scriptTimeoutMs,
      inputs: [g, ...inputs.slice(1).map((x) => x ?? (null as any))],
      time: wrangleTime(ctx, p.code),
    }, (job, serial) => ctx.parallelMap('wrangle', job, {
      serial, minElements: WRANGLE_MIN_POINTS,
      // the worker's realm stops the snippet at scriptTimeoutMs; the pool's limit only catches a stuck worker
      timeoutMs: engine.scriptTimeoutMs + 10000,
    }));
    return andThen(res, (r) => {
      for (const l of r.log.slice(0, 20)) warn(l.startsWith('warning') || l.startsWith('note') ? l : `print: ${l}`);
      if (r.log.length > 20) warn(`(${r.log.length - 20} more log lines)`);
      return r.geo;
    });
  },
});

/**
 * Library object handed to script nodes. `wake` tells the host that a promise the script may await has settled;
 * `run.stopped` turns lib.run into an error once the script has finished or timed out (a stray continuation must
 * not keep cooking nodes).
 */
function scriptLib(ctx: CookContext, wake: () => void, run: { stopped: boolean }) {
  const engine = ctx.engine;
  // compiled in the script realm: a synchronous node's result resolves a realm promise, so `await lib.run(...)`
  // continues inside the same time-limited call; an async node hands back its outcome (see run below), which the
  // realm awaits and turns back into the node's value or error
  const realmAsync = engine.host.compile('(function(f){ return async function run(...a) { const r = f(...a); if (r && r.libRunOutcome) { const o = await r.libRunOutcome; if (o.failed) throw o.error; return o.value; } return r; }; })');
  return {
    Geometry, GeoBuilder, math, topology, random,
    noise: { makeNoise, fractal, makeCurl },
    KDTree, TriBVH, evalGroup, appendElements,
    // packed prims: expand instances, compose a matrix into instance transforms, statistics
    packed: { expand: expandPacked, compose: composePackedXforms, info: packedInfo },
    // topology: half-edge mesh (cached per geometry), edge sets, edge patterns, group conversion
    halfEdges, EdgeSet, evalEdgeGroup, convertSelection,
    manifold: { wasm: engine.manifold, toManifold, fromManifold, propLayout },
    merge: (geos: Geometry[]) => Geometry.merge(geos),
    // time: reading any of these makes the script time-dependent (re-cooked per frame)
    get frame() { return ctx.frame; },
    get time() { return ctx.time; },
    get fps() { return ctx.fps; },
    get timeInc() { return ctx.timeInc; },
    /** Run any node type directly: await lib.run('sphere', {radius: 2}) */
    run: realmAsync((type: string, params: Record<string, any> = {}, ...inputs: Geometry[]) => {
      if (run.stopped) throw new Error(`lib.run(${type}): the script has already finished or timed out`);
      // an async node reads its inputs after the script's timed call has returned: only real geometries go in
      for (let i = 0; i < inputs.length; i++) {
        const bad = inputs[i] === undefined || inputs[i] === null ? '' : notGeometry(inputs[i]);
        if (bad) throw new Error(`lib.run(${type}): input ${i} is not a Geometry (got ${bad})`);
      }
      const def = engine.resolveDef(type);
      if (!def) throw new Error(`lib.run: unknown node type "${type}"`);
      // ... and their params as plain data of this realm: json and graph params (a foreach body) are kept as given and
      // read later. The copy runs the params' getters now; a Proxy or a function is refused without running it.
      try { params = structuredClone(params ?? {}); } catch (e: any) {
        if (e?.name === 'DataCloneError') throw new Error(`lib.run(${type}): params must be plain data (numbers, strings, arrays, objects), not functions or proxies`);
        throw e;
      }
      // "=frame" etc. read the script's own time (and mark it time-dependent)
      const rp = resolveParams(def, params, ctx.vars, { time: ctx, host: engine.host, timeoutMs: engine.scriptTimeoutMs });
      if (rp.errors.length) throw new Error(`lib.run(${type}): ${rp.errors.join('; ')}`);
      for (const w of rp.warnings) ctx.warn(`lib.run(${type}): ${w}`);
      // inherit from ctx through the prototype so its time getters stay lazy
      const sub: CookContext = Object.assign(Object.create(ctx), {
        node: `${ctx.node}/${type}`, type: def.type, p: rp.values, inputs,
        input: (i: number) => inputs[i] ?? new Geometry(), hasInput: (i: number) => !!inputs[i], inputSigs: inputs.map(() => 'script'),
      });
      // The script's time limit can stop it anywhere, also between starting an async node and listening to it: that
      // node's promise would then reject later with nobody listening, which ends the process (MCP server included).
      // So an async node's promise is awaited right inside `outcome`, with no call in between that the limit could
      // stop, and `outcome` never rejects. A synchronous node returns (or throws) here, as before.
      let started: any, thrownNow: { error: unknown } | null = null;
      const isAsync = () => !!started && typeof started.then === 'function';
      const outcome = (async () => {
        try {
          started = def.cook(sub);
          // property reads only from here to the await: a function call is where the limit could stop the script
          if (!started || typeof started.then !== 'function') return null;
          return { value: await started };
        } catch (error) {
          if (!isAsync()) { thrownNow = { error }; return null; }
          return { failed: true, error };
        } finally { if (isAsync()) wake(); }
      })();
      if (thrownNow) throw (thrownNow as { error: unknown }).error;
      return isAsync() ? { libRunOutcome: outcome } : started;
    }),
    warn: (m: string) => ctx.warn(String(m)),
  };
}

defineNode({
  type: 'script',
  category: 'code',
  packed: 'keep',
  summary: 'Arbitrary JS over the whole geometry with the engine library (builder, math, noise, BVH, manifold, lib.run any node). Return a Geometry.',
  aliases: ['python', 'js', 'javascript', 'python_sop'],
  description:
    'The body of `async function(geo, inputs, lib)`. geo is a writable clone of input 0; inputs[i] are the raw inputs. ' +
    'lib: Geometry, GeoBuilder, math, topology, random, noise, KDTree, TriBVH, manifold, merge(geos), run(type, params, ...inputs), warn(msg), ' +
    'frame, time, fps, timeInc (reading them makes the script re-cook per frame). ' +
    'Graph vars by their bare name, read-only, as in "=expr" params (e.g. `lib.run(\'box\', { size: height })`). ' +
    'Must return a Geometry (e.g. `return geo;`).',
  inputs: [
    { name: 'geo', desc: 'main input (optional)', optional: true },
    { name: 'input1', desc: 'extra input', optional: true },
    { name: 'input2', desc: 'extra input', optional: true },
    { name: 'input3', desc: 'extra input', optional: true },
  ],
  params: {
    code: { type: 'code', default: 'return geo;', desc: 'async function body; may use await lib.run(...)' },
  },
  // every var: besides the ones its code names, the "=expr" params it hands to lib.run can read any of them
  usesVars: true,
  example: {
    type: 'script',
    params: { code: "const parts = [];\nfor (let i = 0; i < 5; i++) parts.push(await lib.run('box', { size: [1, i + 1, 1], center: [i * 1.5, (i + 1) / 2, 0] }));\nreturn lib.merge(parts);" },
  },
  async cook(ctx) {
    const { inputs, p, engine } = ctx;
    const ms = engine.scriptTimeoutMs;
    const code = String(p.code ?? '');
    // the graph vars the code names: constants of a function around it, so its own names come first
    const names = codeVarNames(code, ctx.vars);
    const values = codeVarValues(ctx.vars, names);
    let fn;
    try {
      // The realm's AsyncFunction constructor parses the body on its own: code that would close the function it is
      // pasted into (and run while compiling, outside any time limit) is a syntax error. Only a body that parses is
      // compiled inside the function that binds the vars. Looked up, called and its error read under the time limit
      // all the same (earlier code may have changed the realm).
      fn = runUserCode(engine.host, () => {
        const AsyncFunction = engine.host.compile('(async function () {}).constructor');
        new AsyncFunction('geo', 'inputs', 'lib', `"use strict";\n${code}`);
        const make = engine.host.compile(`(function (__vars, __varsGuard) { "use strict"; ${codeVarDecl(names)}\nreturn async function (geo, inputs, lib) { "use strict";\n${code}\n}; })`);
        return make(values, scriptVarsGuard(engine.host));
      }, ms);
    } catch (e: any) {
      if (e.timedOut) throw new NodeError(`script exceeded ${ms} ms (infinite loop?)`);
      throw new NodeError(`script syntax error: ${/single function literal/i.test(e.message) ? 'unbalanced brackets: the code closes the function it runs in' : e.message}`);
    }
    const geo = (inputs[0] ?? new Geometry()).clone();
    let res: any;
    const run = { stopped: false };
    const t0 = Date.now();
    try {
      // the host limits the whole run, awaited continuations included (an `await` must not escape the timeout)
      res = await engine.host.runGuardedAsync((wake) => fn(geo, inputs.map((g) => g ?? new Geometry()), scriptLib(ctx, wake, run)), ms);
    } catch (e: any) {
      // what the script threw is user code too (a message getter, toString): read it within the rest of the time limit
      const d = describeGuarded(engine.host, e, Math.max(ms - (Date.now() - t0), Math.min(ms, 100)));
      if (!d || /timed out/i.test(d.message)) throw new NodeError(`script exceeded ${ms} ms (infinite loop?)`);
      throw new NodeError(`script error: ${d.message}`);
    } finally {
      run.stopped = true;
    }
    // what the script returned is user code too: `instanceof` (and Object.getPrototypeOf) run a Proxy's
    // getPrototypeOf trap here, outside the time limit, so only the engine's brand check looks at it
    const bad = notGeometry(res);
    if (bad) throw new NodeError(`script must return a Geometry (got ${bad})`, 'return geo, a geometry from lib.run, or one built with lib.GeoBuilder / new lib.Geometry()');
    return res;
  },
});

const getProto = Object.getPrototypeOf;

/**
 * Why a value user code handed to the engine is not a usable Geometry, or '' when it is one. Runs no code of the value:
 * the brand check (isGeometry) never touches a Proxy, and the prototype of a branded (hence ordinary) object is read
 * without traps. A geometry whose prototype was replaced (with a Proxy, say) would run user code at every method call.
 */
function notGeometry(x: unknown): string {
  if (isGeometry(x)) return getProto(x) === Geometry.prototype ? '' : 'a geometry whose prototype was replaced';
  if (x === undefined) return 'undefined — add "return geo;"';
  if (x === null) return 'null';
  if (typeof x === 'object' || typeof x === 'function') return 'an object that is not a Geometry the engine made (a Proxy, a copy or a look-alike)';
  return typeof x;
}

export { getNodeDef };
