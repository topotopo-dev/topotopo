// Code nodes: per-element wrangles and whole-geometry scripts.
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import { defineNode, getNodeDef } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext } from '../graph/types.ts';
import { runWrangle } from '../core/wrangle.ts';
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
import { mask, wrangleTime } from './util.ts';

defineNode({
  type: 'wrangle',
  category: 'code',
  summary: 'Run a JS snippet per point / prim / vertex (or once) with VEX-style @attributes. The universal escape hatch.',
  aliases: ['attribwrangle', 'pointwrangle', 'primwrangle', 'vex', 'snippet', 'attribute_wrangle'],
  description:
    'Code runs once per element with @attr bound to the current element. Read/write any attribute: @P, @N, @Cd, @pscale, @orient... ' +
    'New attributes are created on write (type from prefix f@ i@ v@ p@ u@ s@, a known name, or the first assigned value). ' +
    'Vectors are arrays with .x/.y/.z accessors; use add/sub/mul/div/dot/cross/normalize/length/lerp/fit (no operator overloading). ' +
    'Element numbers: @ptnum @primnum @vtxnum @numpt @numprim @elemnum. Groups: @group_name = 1. ' +
    'Time: @Frame @Time @TimeInc (the wrangle re-cooks per frame only when the code uses them). ' +
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
  usesVars: true,
  example: { type: 'wrangle', params: { run_over: 'points', code: '@P.y += sin(@P.x * 4) * 0.2;\n@Cd = hsv2rgb(fit(@P.y, -0.2, 0.2, 0.6, 0), 0.7, 1);' } },
  cook: (ctx) => {
    const { input, inputs, p, vars, engine, warn } = ctx;
    const g = input(0);
    const ro = p.run_over as RunOver;
    const m = ro === 'points' ? mask(g, 'point', p.group) : ro === 'prims' ? mask(g, 'prim', p.group) : ro === 'vertices' ? mask(g, 'vertex', p.group) : null;
    if (!p.code.trim()) return g;
    const r = runWrangle(g.clone(), {
      code: p.code, runOver: ro, mask: m, vars, host: engine.host, timeoutMs: engine.scriptTimeoutMs,
      inputs: [g, ...inputs.slice(1).map((x) => x ?? (null as any))],
      time: wrangleTime(ctx, p.code),
    });
    for (const l of r.log.slice(0, 20)) warn(l.startsWith('warning') || l.startsWith('note') ? l : `print: ${l}`);
    if (r.log.length > 20) warn(`(${r.log.length - 20} more log lines)`);
    return r.geo;
  },
});

/** Library object handed to script nodes. */
function scriptLib(ctx: CookContext) {
  const engine = ctx.engine;
  return {
    Geometry, GeoBuilder, math, topology, random,
    noise: { makeNoise, fractal, makeCurl },
    KDTree, TriBVH, evalGroup, appendElements,
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
    async run(type: string, params: Record<string, any> = {}, ...inputs: Geometry[]) {
      const def = engine.resolveDef(type);
      if (!def) throw new Error(`lib.run: unknown node type "${type}"`);
      // "=frame" etc. read the script's own time (and mark it time-dependent)
      const rp = resolveParams(def, params, ctx.vars, { time: ctx });
      if (rp.errors.length) throw new Error(`lib.run(${type}): ${rp.errors.join('; ')}`);
      // inherit from ctx through the prototype so its time getters stay lazy
      const sub: CookContext = Object.assign(Object.create(ctx), {
        node: `${ctx.node}/${type}`, type: def.type, p: rp.values, inputs,
        input: (i: number) => inputs[i] ?? new Geometry(), hasInput: (i: number) => !!inputs[i], inputSigs: inputs.map(() => 'script'),
      });
      return await def.cook(sub);
    },
    warn: (m: string) => ctx.warn(String(m)),
  };
}

defineNode({
  type: 'script',
  category: 'code',
  summary: 'Arbitrary JS over the whole geometry with the engine library (builder, math, noise, BVH, manifold, lib.run any node). Return a Geometry.',
  aliases: ['python', 'js', 'javascript', 'python_sop'],
  description:
    'The body of `async function(geo, inputs, lib, vars)`. geo is a writable clone of input 0; inputs[i] are the raw inputs. ' +
    'lib: Geometry, GeoBuilder, math, topology, random, noise, KDTree, TriBVH, manifold, merge(geos), run(type, params, ...inputs), warn(msg), ' +
    'frame, time, fps, timeInc (reading them makes the script re-cook per frame). ' +
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
  usesVars: true,
  example: {
    type: 'script',
    params: { code: "const parts = [];\nfor (let i = 0; i < 5; i++) parts.push(await lib.run('box', { size: [1, i + 1, 1], center: [i * 1.5, (i + 1) / 2, 0] }));\nreturn lib.merge(parts);" },
  },
  async cook(ctx) {
    const { inputs, p, engine } = ctx;
    let fn;
    try {
      fn = engine.host.compile(`(async function(geo, inputs, lib, vars){ "use strict";\n${p.code}\n})`);
    } catch (e: any) {
      throw new NodeError(`script syntax error: ${e.message}`);
    }
    const geo = (inputs[0] ?? new Geometry()).clone();
    let res: any;
    try {
      const pr = engine.host.runGuarded(() => fn(geo, inputs.map((g) => g ?? new Geometry()), scriptLib(ctx), ctx.vars), engine.scriptTimeoutMs);
      res = await pr;
    } catch (e: any) {
      throw new NodeError(`script error: ${e?.message ?? e}`);
    }
    if (!(res instanceof Geometry)) throw new NodeError(`script must return a Geometry (got ${res === undefined ? 'undefined — add "return geo;"' : typeof res})`);
    return res;
  },
});

export { getNodeDef };
