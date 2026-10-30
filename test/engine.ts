// Engine tests: time and time-dependent caching, the solver node, expression references to other
// nodes, graph versioning, deprecation, progress reports and stopping a cook, and the CLI frame range.
//   node test/engine.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import '../src/nodes/index.ts';
import { Engine, resolveTime, STOPPED } from '../src/graph/engine.ts';
import type { CookOptions, CookReport } from '../src/graph/engine.ts';
import { allNodeDefs, defineNode } from '../src/graph/registry.ts';
import { createNodeHost, packageBaseDir } from '../src/host/node.ts';
import { replayArgs } from '../src/io/source.ts';
import { exportOptionFlags } from '../src/io/targets.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { scanExpr } from '../src/graph/params.ts';
import { EXPR_HELPERS, REF_FUNCS, evalExpr, isSimpleExpr } from '../src/graph/expr.ts';
import type { Host } from '../src/host/types.ts';
import { rand } from '../src/core/random.ts';
import { clamp, fit, lerp, smoothstep } from '../src/core/math.ts';
import { catalogText, nodeDoc, TOPICS } from '../src/mcp/docs.ts';
import { SNIPPET_LIB_NAMES } from '../src/core/snippet-lib.ts';
import { JS_GLOBALS } from '../src/core/usercode.ts';
import { renderNodeReference } from '../scripts/gen-docs.ts';
import { Session } from '../src/session.ts';
import { makeTools } from '../src/mcp/tools.ts';
import { Geometry } from '../src/core/geometry.ts';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
/** The graphs TopoTopo ships: examples/*.json and the graphs of its own packages (library/<name>/graphs/), by path. */
const shippedGraphs = (): [string, any][] => [
  ...fs.readdirSync(path.join(root, 'examples')).filter((f) => f.endsWith('.json') && f !== 'project.json').map((f) => `examples/${f}`),
  ...fs.readdirSync(path.join(root, 'library')).flatMap((k) => fs.readdirSync(path.join(root, 'library', k, 'graphs')).filter((f) => f.endsWith('.json')).map((f) => `library/${k}/graphs/${f}`)),
].map((rel) => [rel, JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-engine-'));

let failures = 0, passes = 0;
const check = (cond: any, msg: string) => {
  if (cond) passes++;
  else failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const section = (s: string) => console.log(`\n== ${s}`);

const newEngine = async () => {
  const e = new Engine(createNodeHost({ baseDir: tmp }));
  await e.init();
  return e;
};
const engine = await newEngine();
const cook = async (g: GraphSpec, o: CookOptions = {}, e = engine): Promise<CookReport> => {
  const r = await e.cook(g, o);
  if (!r.ok) console.log('   cook errors:', r.errors.map((x) => `[${x.node}] ${x.message}`).join('; '));
  return r;
};
const res = (r: CookReport, n: string) => r.results.get(n)!;
const bboxOf = (g: Geometry | null) => g!.bbox();
const size3 = (g: Geometry | null) => { const b = g!.bbox(); return [0, 1, 2].map((k) => +(b.max[k] - b.min[k]).toFixed(6)); };

// test-only nodes (registered in this process only)
let counter = 0;
defineNode({
  type: 'test_counter', category: 'flow', summary: 'test only: counts cooks, passes input 0 through',
  inputs: [{ name: 'geo', desc: 'geometry', optional: true }], params: {},
  cook: ({ input }) => { counter++; return input(0); },
});
defineNode({
  type: 'test_old_box', category: 'generate', summary: 'test only: a deprecated box',
  deprecated: 'use "box" instead', inputs: [], params: { size: { type: 'float', default: 1, desc: 'edge length' } },
  cook: async ({ p, engine: e }) => (await e.cook({ nodes: { b: { type: 'box', params: { size: p.size } } } })).geo!,
});

// ------------------------------------------------------------------ time
section('time resolution');
{
  const a = resolveTime({});
  check(a.frame === 1 && a.time === 0 && a.fps === 24 && near(a.timeInc, 1 / 24), 'defaults: frame 1, time 0, 24 fps');
  check(resolveTime({ frame: 25 }).time === 1, 'frame 25 → time 1 s');
  check(resolveTime({ time: 0.5 }).frame === 13, 'time 0.5 s → frame 13');
  check(resolveTime({ time: 1, fps: 30 }).frame === 31, 'fps 30: time 1 → frame 31');
  const bad = await engine.cook({ nodes: { b: { type: 'box' } } }, { frame: NaN });
  check(!bad.ok && /frame must be a finite number/.test(bad.errors[0]?.message ?? ''), 'non-finite frame is a cook error');
}

section('time-independent nodes keep their signature across frames');
{
  const e = await newEngine();
  const g: GraphSpec = {
    nodes: {
      b: { type: 'box', params: { size: [1, 2, 1] } },
      t: { type: 'transform', in: ['b'], params: { translate: [0, 1, 0] } },
      w: { type: 'wrangle', in: ['t'], params: { code: '@P.y *= 2;' } },
    },
  };
  const r1 = await cook(g, { frame: 1 }, e);
  const r7 = await cook(g, { frame: 7 }, e);
  for (const n of ['b', 't', 'w']) check(res(r1, n).sig === res(r7, n).sig && res(r7, n).cached, `${n}: same signature at frames 1 and 7, cache hit`);
  check(!r7.timeDependent && !res(r7, 'w').timeDependent, 'report and wrangle without @Frame are not time-dependent');
  check(r7.frame === 7 && near(r7.time, 6 / 24), 'report carries frame and time');
}

section('wrangle @Frame re-cooks per frame, upstream stays cached');
{
  const e = await newEngine();
  const g: GraphSpec = {
    nodes: {
      grid: { type: 'grid', params: { size: [2, 2], divisions: [2, 2] } },
      w: { type: 'wrangle', in: ['grid'], params: { code: '@P.y = @Frame * 0.5; f@t = @Time; f@dt = @TimeInc;' } },
      down: { type: 'transform', in: ['w'], params: { translate: [0, 0, 0] } },
    },
  };
  const r1 = await cook(g, { frame: 1 }, e);
  const r3 = await cook(g, { frame: 3 }, e);
  check(res(r3, 'grid').cached && res(r3, 'grid').sig === res(r1, 'grid').sig, 'upstream grid cached at frame 3');
  check(!res(r3, 'w').cached && res(r3, 'w').sig !== res(r1, 'w').sig, 'wrangle re-cooked with a new signature');
  check(res(r3, 'w').timeDependent && res(r3, 'down').timeDependent && r3.timeDependent, 'wrangle and downstream flagged time-dependent');
  check(near(r3.geo!.P[1], 1.5) && near(r1.geo!.P[1], 0.5), '@Frame value reaches the snippet');
  check(near(r3.geo!.points.get('t')!.get(0) as number, 2 / 24) && near(r3.geo!.points.get('dt')!.get(0) as number, 1 / 24), '@Time and @TimeInc values');
  const again = await cook(g, { frame: 3 }, e);
  check(res(again, 'w').cached && res(again, 'down').cached, 'cooking frame 3 again is a cache hit');
}

section('"=expr" params reading time');
{
  const e = await newEngine();
  const g: GraphSpec = {
    nodes: {
      b: { type: 'box' },
      t: { type: 'transform', in: ['b'], params: { translate: [0, '=frame * 0.25', '=time'] } },
      shadow: { type: 'transform', in: ['b'], params: { translate: [0, '=frame', 0] } },
    },
    vars: {},
    output: 't',
  };
  const r1 = await cook(g, { frame: 1 }, e);
  const r5 = await cook(g, { frame: 5 }, e);
  check(res(r5, 't').timeDependent && res(r5, 't').sig !== res(r1, 't').sig, 'node whose expression reads frame is time-dependent');
  check(near(bboxOf(r5.geo).min[1], 1.25 - 0.5) && near(bboxOf(r5.geo).min[2], 4 / 24 - 0.5), 'frame and time values in expressions');
  // a graph var cannot be named like the time: it would hide it from every expression (a solver body's own frame var is
  // the step's time, see "solver")
  const gv: GraphSpec = { ...g, vars: { frame: 2 }, output: 'shadow' };
  const s1 = await e.cook(gv, { frame: 1 });
  check(!s1.ok && s1.errors.some((x) => x.node === '(vars)' && /var "frame" would hide the cook time/.test(x.message)), 'a graph var named frame is rejected: it would hide the time');
}

section('script lib.frame and foreach/asset bodies propagate time dependence');
{
  const e = await newEngine();
  const g: GraphSpec = {
    nodes: {
      s: { type: 'script', params: { code: "return await lib.run('box', { size: lib.frame });" } },
      plain: { type: 'script', params: { code: "return await lib.run('box', { size: 2 });" } },
      runexpr: { type: 'script', params: { code: "return await lib.run('box', { size: '=frame' });" } },
      out: { type: 'merge', in: ['s', 'plain', 'runexpr'] },
    },
  };
  const r2 = await cook(g, { frame: 2 }, e);
  const r4 = await cook(g, { frame: 4 }, e);
  check(res(r4, 's').timeDependent && !res(r4, 's').cached && near(bboxOf(res(r4, 's').geo).max[0], 2), 'script reading lib.frame is time-dependent');
  check(!res(r4, 'plain').timeDependent && res(r4, 'plain').cached && res(r4, 'plain').sig === res(r2, 'plain').sig, 'script without time stays cached');
  check(res(r4, 'runexpr').timeDependent && near(bboxOf(res(r4, 'runexpr').geo).max[0], 2), 'lib.run("=frame") marks the script time-dependent');

  const loop: GraphSpec = {
    nodes: {
      b: { type: 'box' },
      f: {
        type: 'foreach', in: ['b'],
        params: { mode: 'count', count: 2, body: { nodes: { i: { type: 'input' }, w: { type: 'wrangle', in: ['i'], params: { code: '@P.y += @Frame;' } } }, output: 'w' } },
      },
      still: { type: 'foreach', in: ['b'], params: { mode: 'count', count: 2, body: { nodes: { i: { type: 'input' }, t: { type: 'transform', in: ['i'], params: { translate: [0, '=iteration', 0] } } }, output: 't' } } },
      out: { type: 'merge', in: ['f', 'still'] },
    },
  };
  const l1 = await cook(loop, { frame: 1 }, e);
  const l3 = await cook(loop, { frame: 3 }, e);
  check(res(l3, 'f').timeDependent && res(l3, 'f').sig !== res(l1, 'f').sig && near(bboxOf(res(l3, 'f').geo).max[1], 3.5), 'foreach with a time-dependent body re-cooks per frame (discovered while cooking)');
  check(!res(l3, 'still').timeDependent && res(l3, 'still').cached, 'foreach with a static body stays cached');
  const l3b = await cook(loop, { frame: 3 }, e);
  check(res(l3b, 'f').cached && res(l3b, 'f').sig === res(l3, 'f').sig, 'discovered dependence: same frame is a cache hit');

  // foreach now re-cooks when a parent var used only inside its body changes
  const vg = (h: number): GraphSpec => ({
    vars: { h },
    nodes: { b: { type: 'box' }, f: { type: 'foreach', in: ['b'], params: { mode: 'count', count: 1, body: { nodes: { i: { type: 'input' }, t: { type: 'transform', in: ['i'], params: { translate: [0, '=h', 0] } } }, output: 't' } } } },
  });
  const v1 = await cook(vg(1), {}, e), v5 = await cook(vg(5), {}, e);
  check(near(bboxOf(v1.geo).max[1], 1.5) && near(bboxOf(v5.geo).max[1], 5.5), 'foreach body sees changed parent vars (cache keyed on vars)');

  e.registerAsset('test_bob', { vars: { amp: 1 }, nodes: { i: { type: 'input' }, w: { type: 'wrangle', in: ['i'], params: { code: '@P.y += @Frame * amp;' } } }, output: 'w' });
  const ag: GraphSpec = { nodes: { b: { type: 'box' }, a: { type: 'test_bob', in: ['b'] } } };
  const a1 = await cook(ag, { frame: 1 }, e), a2 = await cook(ag, { frame: 2 }, e);
  check(res(a2, 'a').timeDependent && near(bboxOf(a2.geo).max[1] - bboxOf(a1.geo).max[1], 1), 'asset with a time-dependent body is time-dependent');
}

// ------------------------------------------------------------------ solver
section('solver');
{
  const e = await newEngine();
  const grow: GraphSpec = {
    nodes: {
      seed: { type: 'box', params: { size: [1, 1, 1], center: [0, 0.5, 0] } },
      sim: {
        type: 'solver', in: ['seed'],
        params: {
          body: {
            nodes: {
              prev: { type: 'input', params: { index: 0 } },
              count: { type: 'test_counter', in: ['prev'] },
              top: { type: 'group', in: ['count'], params: { name: 'up', class: 'prim', normal: [0, 1, 0], spread_angle: 5 } },
              grow: { type: 'poly_extrude', in: ['top'], params: { group: 'up', distance: 0.1 } },
            },
            output: 'grow',
          },
        },
      },
    },
    output: 'sim',
  };
  const heights: number[] = [];
  for (const f of [1, 3, 6]) heights.push(bboxOf((await cook(grow, { frame: f }, e)).geo).max[1]);
  check(near(heights[0], 1.1) && near(heights[1], 1.3) && near(heights[2], 1.6), `growth: height grows with frame (${heights.map((h) => h.toFixed(2)).join(', ')})`);

  const e2 = await newEngine();
  counter = 0;
  const r10 = await cook(grow, { frame: 10 }, e2);
  check(counter === 10 && res(r10, 'sim').stats?.body_runs === 10, `frame 10 from scratch: body ran 10 times (counter ${counter})`);
  counter = 0;
  const r11 = await cook(grow, { frame: 11 }, e2);
  const st = res(r11, 'sim').stats!;
  check(counter === 1 && st.body_runs === 1 && st.resumed_from === 10, `frame 11 after frame 10: body ran once, resumed from frame ${st.resumed_from} (counter ${counter})`);
  check(near(bboxOf(r11.geo).max[1], 2.1), 'frame 11 result continues frame 10');
  counter = 0;
  const r5 = await cook(grow, { frame: 5 }, e2);
  check(counter === 0 && res(r5, 'sim').stats?.resumed_from === 5 && near(bboxOf(r5.geo).max[1], 1.5), 'going back to frame 5 reuses the cached frame state');
  const r10b = await cook(grow, { frame: 10 }, e2);
  check(res(r10b, 'sim').cached && res(r10b, 'seed').cached, 'frame 10 again: cache hit');
  check(res(r10b, 'sim').sig !== res(r11, 'sim').sig && res(r10b, 'seed').sig === res(r11, 'seed').sig, 'solver signature depends on the frame, its static input does not');

  // before start_frame the initial geometry passes through; start_frame runs the body once
  const late: GraphSpec = structuredClone(grow);
  late.nodes.sim.params!.start_frame = 5;
  const b4 = await cook(late, { frame: 4 }, e2), at5 = await cook(late, { frame: 5 }, e2);
  check(near(bboxOf(b4.geo).max[1], 1) && near(bboxOf(at5.geo).max[1], 1.1), 'start_frame: earlier frames pass the initial geometry through');

  // substeps, body vars and time
  const sub: GraphSpec = {
    nodes: {
      seed: { type: 'box' },
      sim: {
        type: 'solver', in: ['seed'],
        params: {
          substeps: 2,
          body: {
            nodes: {
              prev: { type: 'input', params: { index: 0 } },
              w: { type: 'wrangle', in: ['prev'], params: { run_over: 'detail', code: 'f@runs = (@runs || 0) + 1; f@f = @Frame; f@dt = @TimeInc; f@it = iteration; f@sub = substep; f@vf = frame; f@vt = time;' } },
            },
            output: 'w',
          },
        },
      },
    },
  };
  const s3 = await cook(sub, { frame: 3 }, e2);
  const d = (k: string) => s3.geo!.detail.get(k)!.get(0) as number;
  check(d('runs') === 6 && d('f') === 3 && near(d('dt'), 1 / 48) && d('it') === 2 && d('sub') === 1, `substeps 2 at frame 3: 6 runs, @Frame ${d('f')}, @TimeInc ${d('dt').toFixed(4)}, iteration ${d('it')}, substep ${d('sub')}`);
  check(d('vf') === 3 && near(d('vt'), 2 / 24), 'body vars frame/time match the step time');

  // extra inputs are cooked at each simulated frame
  const extra: GraphSpec = {
    nodes: {
      seed: { type: 'merge' },
      mover: { type: 'box', params: { size: 0.2, center: ['=frame', 0, 0] } },
      sim: {
        type: 'solver', in: ['seed', 'mover'],
        params: { body: { nodes: { prev: { type: 'input', params: { index: 0 } }, x: { type: 'input', params: { index: 2 } }, m: { type: 'merge', in: ['prev', 'x'] } }, output: 'm' } },
      },
    },
    output: 'sim',
  };
  const x3 = await cook(extra, { frame: 3 }, e2);
  const xb = bboxOf(x3.geo);
  check(x3.geo!.numPrims === 18 && near(xb.min[0], 0.9) && near(xb.max[0], 3.1), 'extra input is evaluated at every simulated frame (snapshots at x = 1, 2, 3)');

  // cookFrames over a range reuses the cache
  const e3 = await newEngine();
  counter = 0;
  const seen: number[] = [];
  const cf = await e3.cookFrames(grow, { start: 1, end: 8, step: 1 }, (r, f) => { seen.push(f); });
  check(cf.frames === 8 && !cf.failed.length && seen.join(',') === '1,2,3,4,5,6,7,8' && counter === 8, `cookFrames 1-8: body ran ${counter} times in total (once per frame)`);
}

// ------------------------------------------------------------------ expression references
section('expression references to other nodes');
{
  const e = await newEngine();
  const valid = (boxSize: number[]): GraphSpec => ({
    nodes: {
      box1: { type: 'box', params: { size: boxSize, center: [0, boxSize[1] / 2, 0] } },
      g: { type: 'grid', params: { size: [2, 2], divisions: [3, 3] } },
      info: { type: 'wrangle', in: ['g'], params: { run_over: 'detail', code: 'f@height = 7.5; v@dir = [1, 2, 3];' } },
      unrelated: { type: 'sphere', params: { radius: 0.5 } },
      onTop: { type: 'transform', in: ['unrelated'], params: { translate: [0, "=bbox('box1').max.y", 0] } },
      counted: { type: 'box', params: { size: "=npoints('g')" } },
      det: { type: 'box', params: { size: ["=detail('info', 'height')", "=detail('info', 'dir', 1)", "=detail('info', 'dir').z"] } },
      pt: { type: 'box', params: { center: "=point('g', 0, 'P')", size: "=centroid('box1').y" } },
      chs: { type: 'box', params: { size: ["=ch('box1', 'size')[0]", "=ch('box1/size').y", "=nprims('box1') + nvertices('box1') / 100"] } },
      pr: { type: 'box', params: { size: "=prim('box1', 0, 'P').x + 3" } },
      out: { type: 'merge', in: ['onTop', 'counted', 'det', 'pt', 'chs', 'pr'] },
    },
  });
  const r = await cook(valid([2, 3, 4]), {}, e);
  check(r.ok, 'graph with expression references cooks');
  const size = (rep: CookReport, n: string) => { const b = bboxOf(res(rep, n).geo); return [0, 1, 2].map((k) => +(b.max[k] - b.min[k]).toFixed(6)); };
  check(near(bboxOf(res(r, 'onTop').geo).min[1], 2.5), 'bbox("box1").max.y = 3 (sphere moved on top)');
  check(size(r, 'counted').join() === '16,16,16', 'npoints("g") = 16');
  check(size(r, 'det').join() === '7.5,2,3', 'detail() value, component index and .z accessor');
  const g0 = res(r, 'g').geo!;
  check(near(bboxOf(res(r, 'pt').geo).min[0], g0.P[0] - 0.75) && near(size(r, 'pt')[0], 1.5), 'point("g", 0, "P") and centroid("box1").y');
  check(size(r, 'chs').join() === '2,3,6.24', 'ch("box1", "size") / ch("box1/size") / nprims + nvertices');
  const b1 = res(r, 'box1').geo!, pp = b1.primPoints(0);
  const cx = pp.reduce((s, p) => s + b1.P[p * 3], 0) / pp.length;
  check(near(size(r, 'pr')[0], cx + 3), 'prim("box1", 0, "P") = prim centroid');
  check(res(r, 'g').geo !== null && res(r, 'info').geo !== null, 'referenced nodes are cooked although not wired');
  const leaf = e.findOutput({ nodes: { base: { type: 'box' }, top: { type: 'sphere', params: { center: [0, "=bbox('base').max.y", 0] } } } });
  check(leaf.name === 'top' && !leaf.note, 'expression-referenced nodes are not end nodes');

  const r2 = await cook(valid([2, 5, 4]), {}, e);
  check(!res(r2, 'onTop').cached && near(bboxOf(res(r2, 'onTop').geo).min[1], 4.5), 'changing the referenced box re-cooks the dependent node');
  check(!res(r2, 'chs').cached && size(r2, 'chs')[1] === 5, 'ch() dependent re-cooks with the new value');
  check(res(r2, 'counted').cached && res(r2, 'det').cached && res(r2, 'unrelated').cached, 'nodes referencing unchanged nodes stay cached');

  // hidden dependency on a time-dependent node makes the dependent time-dependent
  const anim: GraphSpec = {
    nodes: {
      mover: { type: 'box', params: { center: [0, '=frame', 0] } },
      follower: { type: 'sphere', params: { center: [0, "=bbox('mover').max.y", 0] } },
    },
    output: 'follower',
  };
  const f2 = await cook(anim, { frame: 2 }, e), f4 = await cook(anim, { frame: 4 }, e);
  check(res(f4, 'follower').timeDependent && near(bboxOf(f4.geo).max[1] - bboxOf(f2.geo).max[1], 2), 'reading a time-dependent node follows it over frames');

  // inside a body: references resolve to nodes of that body
  const body: GraphSpec = {
    nodes: {
      b: { type: 'box' },
      f: { type: 'foreach', in: ['b'], params: { mode: 'count', count: 2, body: { nodes: { i: { type: 'input' }, s: { type: 'sphere', params: { radius: 0.1, center: [0, "=bbox('i').max.y + iteration", 0] } } }, output: 's' } } },
    },
  };
  const rb = await cook(body, {}, e);
  check(rb.ok && near(bboxOf(rb.geo).max[1], 1.6), 'references inside a foreach body resolve to body nodes');

  // validation
  const unknown = await e.cook({ nodes: { box1: { type: 'box' }, t: { type: 'transform', in: ['box1'], params: { translate: [0, "=bbox('box2').max.y", 0] } } } });
  const um = unknown.errors.map((x) => x.message).join(' | ');
  check(!unknown.ok && /unknown node "box2"/.test(um) && /did you mean box1/.test(um), `unknown reference: ${um.slice(0, 100)}`);
  const unknownParam = await e.cook({ nodes: { box1: { type: 'box' }, t: { type: 'box', params: { size: "=ch('box1/sise')" } } } });
  check(!unknownParam.ok && /no param "sise"/.test(unknownParam.errors[0]?.message ?? '') && /"size"/.test(unknownParam.errors[0]?.message ?? ''), 'ch() unknown param: did-you-mean');
  const cyc = await e.cook({ nodes: { a: { type: 'box', params: { size: "=npoints('b')" } }, b: { type: 'transform', in: ['a'] } } });
  const cm = cyc.errors.map((x) => x.message).join(' | ');
  check(!cyc.ok && /cycle: .*a.*b.*a/.test(cm), `cycle through a reference: ${cm}`);
  const selfCh = await e.cook({ nodes: { box1: { type: 'box', params: { size: 2, center: [0, "=ch('box1/size')[1] / 2", 0] } } } });
  check(!selfCh.ok && selfCh.errors.some((x) => /cycle: box1 \(params\) → box1 \(params\)/.test(x.message)), 'ch() of the same node is reported as a cycle');
  const dyn = await e.cook({ vars: { n: 'g' }, nodes: { g: { type: 'grid' }, b: { type: 'box', params: { size: '=npoints(n)' } } } });
  check(!dyn.ok && /string literal/.test(dyn.errors[0]?.message ?? ''), 'dynamic node names are rejected');
  const inVars = await e.cook({ vars: { h: "=npoints('g')" }, nodes: { g: { type: 'grid' } } });
  check(!inVars.ok && inVars.errors.some((x) => x.node === '(vars)' && /vars are graph constants/.test(x.message)), 'reference functions in vars are rejected');
  const failing = await e.cook({ nodes: { bad: { type: 'box', params: { size: '=nope_var' } }, t: { type: 'box', params: { size: "=npoints('bad')" } } }, output: 't' });
  check(!failing.ok && failing.errors.some((x) => x.node === 'bad') && !failing.errors.some((x) => x.node === 't'), 'a failing referenced node is reported once, at its source');
  const outOfRange = await e.cook({ nodes: { g: { type: 'grid', params: { divisions: [1, 1] } }, t: { type: 'box', params: { center: "=point('g', 9, 'P')" } } }, output: 't' });
  check(!outOfRange.ok && /index out of range/.test(outOfRange.errors[0]?.message ?? ''), 'point() index out of range is a clear error');

  // dry run defers reference functions
  const dr = e.dryRun(valid([2, 3, 4]));
  check(!dr.errors.length && dr.notes.some((n) => /onTop: translate read other nodes/.test(n)), 'dryRun: reference params are deferred, not errors');

  // static scan
  const sc = scanExpr(`npoints("a") + bbox('b').size.y + ch("c/size")[0] + ch('d', 'radius') + x.point(1) + detail(\`e\`, 'h')`);
  check(sc.geo.join() === 'a,b,e' && sc.ch.map((c) => `${c.node}.${c.param}`).join() === 'c.size,d.radius' && !sc.errors.length, 'scanExpr finds literal references only');
}

// ------------------------------------------------------------------ expression sandbox
// (hostile and never-ending expressions, with the worker pool off and on, are in test/fuzz.ts)
section('expression sandbox');
{
  const host = engine.host;
  const ev = (src: string, vars: Record<string, any> = {}) => evalExpr(src, vars, { host });
  const errOf = (f: () => any) => { try { f(); return ''; } catch (e: any) { return String(e?.message ?? e); } };
  check(!!host.exprSandbox, 'the Node host provides an expression sandbox');

  // the helpers are built inside the sandbox realm: they must compute what the engine's own functions compute
  const xs = [0, 1, -1, 2.5, -7.25, 0.1, 1e9, 2 ** 31, -(2 ** 31) - 1, 2 ** 40 + 0.5, 123456789, Math.PI];
  let same = ev('rand(3)') === rand(3);
  for (const x of xs) {
    for (const s of [0, 1, 2.5, -3, 17]) if (ev(`rand(${x}, ${s})`) !== rand(x, s)) same = false;
    if (ev(`clamp(${x}, -2, 3)`) !== clamp(x, -2, 3) || ev(`lerp(-1, 4, ${x})`) !== lerp(-1, 4, x)) same = false;
    if (ev(`fit(${x}, -1, 3, 10, 20)`) !== fit(x, -1, 3, 10, 20) || ev(`smoothstep(-1, 2, ${x})`) !== smoothstep(-1, 2, x)) same = false;
  }
  check(same, 'rand, clamp, fit, lerp, smoothstep in the sandbox equal src/core/random.ts and src/core/math.ts');
  check(ev('frac(-1.25) + mod(-1, 3) + degrees(radians(90)) + TAU / PI + pick([4, 5, 6], -1) + E * 0') === 0.75 + 2 + 90 + 2 + 6, 'frac, mod, radians, degrees, TAU, pick');
  const missing = [...EXPR_HELPERS, ...REF_FUNCS].filter((n) => /not/.test(errOf(() => ev(`typeof ${n}`))));
  const undocumented = EXPR_HELPERS.filter((n) => !['Math', 'NaN', 'Infinity', 'undefined'].includes(n) && !new RegExp(`\\b${n}\\b`).test(TOPICS.expressions));
  check(!missing.length && !undocumented.length, `every helper is in scope and documented in topic "expressions"${missing.length + undocumented.length ? `; missing: ${missing.join(', ')}; undocumented: ${undocumented.join(', ')}` : ''}`);

  // the static check: every expression shipped in examples/ and in TopoTopo's own packages runs without the per-call timer
  const shipped: string[] = [];
  const walk = (v: any) => {
    if (typeof v === 'string') { if (v.length > 1 && v[0] === '=') shipped.push(v.slice(1)); }
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  for (const [, g] of shippedGraphs()) walk(g);
  const timedShipped = shipped.filter((s) => !isSimpleExpr(s));
  check(shipped.length > 100 && !timedShipped.length, `all ${shipped.length} shipped expressions run without the timer${timedShipped.length ? '; not: ' + timedShipped.join(' | ') : ''}`);
  const timedForms = [
    '(() => 1)()', 'list.map(sin)', "'a'.match('a')", '/a/.test(s)', '`t`', 'h = 1', '({ a: 1 }).a', 'new Array(3)', 'f?.(1)',
    'h // c', 'h /* c */ + 1', '[...list]', 'Math.max.apply(null, list)', '(sin)(1)', "list['map'](sin)", 'h++', "'a' in b", 'this',
    'h; 1', 'h <!-- c', 'x.Math.max(1)', 'sin(1)' + ' + sin(1)'.repeat(40), 'h'.repeat(1001), '\\u0068',
  ];
  const plainForms = [
    'h * 2', "bbox('a').max.y + 1", 'Math.min(a, b) / 2', 'c ? 1 : 0', '[1, 2, h][i % 3]', 'typeof h', 'h / 2 / 3', "s == 'x' && !t",
    'a?.b ?? 0', "ch('n/size')[0]", 'pick([1, 2, 3], iteration)', '0x1f + 1e-3 + .5 + 1_000', 'attr.import_x', 'x.while',
  ];
  check(timedForms.every((s) => !isSimpleExpr(s)), `forms that need the timer are detected${timedForms.some(isSimpleExpr) ? '; missed: ' + timedForms.filter(isSimpleExpr).join(' | ') : ''}`);
  check(plainForms.every(isSimpleExpr), `straight-line forms skip the timer${plainForms.some((s) => !isSimpleExpr(s)) ? '; not: ' + plainForms.filter((s) => !isSimpleExpr(s)).join(' | ') : ''}`);
  check(ev('[1, 2, 3].map((x) => x * h).reduce((a, b) => a + b)', { h: 2 }) === 12 && ev('(() => { let s = 0; for (let i = 0; i < 4; i++) s += i; return s; })()') === 6, 'timed expressions (function literals, loops) still evaluate');

  // timed expressions remember their result together with everything they read: a re-cook with the same inputs skips
  // the timed host call, any changed input (var, time, referenced geometry, a var shadowing a helper) re-evaluates
  {
    const e = await newEngine();
    const sb = e.host.exprSandbox!;
    const run0 = sb.run;
    let timedRuns = 0;
    sb.run = (job, ms) => { timedRuns++; return run0.call(sb, job, ms); };
    const g = (h: number, size: number, extra: Record<string, any> = {}): GraphSpec => ({
      vars: { h, ...extra },
      nodes: {
        base: { type: 'box', params: { size } },
        t: { type: 'box', params: { size: 0.5, center: ['=(() => h * 2)()', "=(() => bbox('base').max.y)()", '=(() => frame + sin(0))()'] } },
      },
      output: 't',
    });
    const center = (r: CookReport) => { const b = bboxOf(r.geo); return [0, 1, 2].map((k) => +((b.max[k] + b.min[k]) / 2).toFixed(6)).join(); };
    const a = await cook(g(2, 1), {}, e);
    const runsA = timedRuns;
    e.cache.clear();
    const b = await cook(g(2, 1), {}, e);
    const runsB = timedRuns - runsA;
    const c = await cook(g(3, 4), { frame: 5 }, e);
    check(runsA === 3 && runsB === 0 && center(a) === '4,0.5,1' && center(b) === '4,0.5,1' && res(b, 't').timeDependent, `same inputs: remembered results, no timed call (${runsA} then ${runsB}), still time-dependent`);
    // graphs cannot declare a var named like a helper, but a scope can have one (assert's bbox, a solver body's frame)
    const shadow = '(() => typeof sin + typeof frame)()';
    const s0 = evalExpr(shadow, {}, { host: e.host }), s1 = evalExpr(shadow, { sin: 5, frame: 2 }, { host: e.host });
    check(center(c) === '6,2,5' && s0 === 'functionnumber' && s1 === 'numbernumber', `changed var, geometry and frame re-evaluate (${center(c)}); a var shadowing a helper is not served from memory (${s0}, ${s1})`);
    const rnd = async () => (await cook({ nodes: { t: { type: 'box', params: { size: '=(() => 1 + Math.random())()' } } } }, {}, e)).geo!.bbox().max[0];
    e.cache.clear();
    const r1 = await rnd();
    e.cache.clear();
    check(r1 !== await rnd(), 'an expression that reads Math (Math.random) is not remembered');
  }

  // errors name the param and the expression
  const r1 = await engine.cook({ nodes: { b: { type: 'box', params: { size: '=nope_var * 2' } } } });
  check(!r1.ok && /^param "size": expression "=nope_var \* 2" failed: nope_var is not defined/.test(r1.errors[0]?.message ?? ''), `error names the param and the expression: ${r1.errors[0]?.message}`);
  const r2 = await engine.cook({ nodes: { b: { type: 'box' }, t: { type: 'transform', in: ['b'], params: { translate: [0, '=1 +', 0] } } } });
  check(!r2.ok && /^param "translate"\[1\]: syntax error in expression "=1 \+"/.test(r2.errors[0]?.message ?? ''), `syntax error names the param component: ${r2.errors[0]?.message}`);
  const r3 = await engine.cook({ nodes: { b: { type: 'box', params: { size: '=(() => {\n  return 1 +;\n})()' } } } });
  check(!r3.ok && /syntax error in expression .*\(line 2\)$/s.test(r3.errors[0]?.message ?? ''), `multi-line syntax error names the line: ${r3.errors[0]?.message.split('\n').pop()}`);

  // values cross the realm boundary as copies: vars are read-only, results are engine-realm data
  const vv = { list: [3, 1, 2] };
  const r4 = await engine.cook({ vars: vv, nodes: { b: { type: 'box', params: { size: '=list.sort()[0]' } } } });
  check(!r4.ok && /read only/.test(r4.errors[0]?.message ?? '') && vv.list.join() === '3,1,2', 'vars are read-only in expressions and the graph vars stay untouched');
  const arr = ev("[1, [2, h], 'x']", { h: 5 });
  check(Object.getPrototypeOf(arr) === Array.prototype && Object.getPrototypeOf(arr[1]) === Array.prototype && arr.flat().join() === '1,2,5,x', 'array results are engine-realm arrays');
  check(/gives a function/.test(errOf(() => ev('sin'))) && /circular/.test(errOf(() => ev('(() => { const a = []; a.push(a); return a; })()'))), 'functions and circular results are errors');
  check(ev('v.x + v.z', { v: Object.defineProperty([1, 2, 3], 'x', { get() { return 1; } }) }) === 4, 'vectors keep .x .y .z in vars');

  // a host without exprSandbox (e.g. a browser host) falls back to new Function: the same names are hidden, but
  // there is no realm isolation and no timeout (so no loop cases here)
  const fbHost: Host = Object.assign(createNodeHost({ baseDir: tmp, workers: 0 }), { exprSandbox: undefined });
  const fb = new Engine(fbHost);
  fb.manifold = engine.manifold;
  const fbMsgs: string[] = [];
  for (const x of ['=process.pid', '=globalThis.process.pid', "=fetch('x') ? 1 : 1", "=import('node:fs') ? 1 : 1", "=this.constructor.constructor('return process')().pid", "=require('fs') ? 1 : 1"]) {
    const r = await fb.cook({ nodes: { b: { type: 'box', params: { center: [0, x, 0] } } } });
    fbMsgs.push(r.ok ? `${x} cooked` : r.errors[0].message);
  }
  check(fbMsgs.every((m) => /is not available in expressions/.test(m)), `fallback hides host names${fbMsgs.some((m) => !/is not available/.test(m)) ? ': ' + fbMsgs.join(' | ') : ''}`);
  const fbOk = await fb.cook({ vars: { h: 2 }, nodes: { b: { type: 'box', params: { size: ['=h * sin(PI / 2)', "=[1, 2].map((x) => x * h)[1]", '=rand(3) * 0 + 1'] } } } });
  check(fbOk.ok && size3(fbOk.geo).join() === '2,4,1', 'fallback evaluates plain and timed forms');
  const fbConv = await fb.cook({ vars: { n: '3' }, nodes: { b: { type: 'box', params: { size: ['=Number(n)', '=parseFloat("1.5m")', '=String(n).length'] } } } });
  check(fbConv.ok && size3(fbConv.geo).join() === '3,1.5,1', 'fallback has the conversions too');
}

// ------------------------------------------------------------------ conversions in expressions
section('expression conversions: Number, parseFloat, parseInt, String, Boolean, isFinite, isNaN');
{
  const host = engine.host;
  const ev = (src: string, vars: Record<string, any> = {}) => evalExpr(src, vars, { host });
  // a terrain graph's menu var holds text ("8") and Number() failed in "=" expressions (+x worked)
  check(ev('Number(res) * 2', { res: '8' }) === 16 && ev('+res * 2', { res: '8' }) === 16, 'Number(x) converts like +x');
  check(ev('parseFloat(s)', { s: '2.5 m' }) === 2.5 && ev('parseInt(s, 10)', { s: '42px' }) === 42 && ev('parseInt("ff", 16)') === 255, 'parseFloat, parseInt (with a radix)');
  check(ev('String(n) + "x"', { n: 3 }) === '3x' && ev('Boolean(0)') === false && ev('Boolean(s)', { s: 'no' }) === true, 'String, Boolean');
  check(ev('isFinite(Number(s))', { s: '1e3' }) === true && ev('isNaN(Number(s))', { s: 'abc' }) === true && ev('Number.isInteger(n)', { n: 4 }) === true, 'isFinite, isNaN, Number.isInteger');
  check(['Number(x)', 'parseInt(s, 10) + 1', 'String(n)', 'Boolean(b)', 'isNaN(Number(s))', 'Number.isInteger(n)', 'Number.parseFloat(s)'].every(isSimpleExpr) && !isSimpleExpr('Number.prototype.toFixed.call(1, 2)'),
    'conversions are straight-line calls: they run without the timer (Number.<name> like Math.<name>)');
  const r = await engine.cook({ vars: { res: '8' }, nodes: { b: { type: 'box', params: { size: ['=Number(res)', '=parseInt(res) / 2', '=Number.isInteger(Number(res)) ? 1 : 0'] } } } });
  check(r.ok && size3(r.geo).join() === '8,4,1', 'in node params');
}

// ------------------------------------------------------------------ enum options that are numbers
section('enum options may be numbers: the value is the number');
{
  const e = await newEngine();
  e.registerAsset('test_res_box', {
    vars: { res: 8, mode: 'b' },
    params: { res: { type: 'enum', options: [4, 8, 16], desc: 'resolution' }, mode: { type: 'enum', options: ['a', 'b'], desc: 'mode' } },
    nodes: { b: { type: 'box', params: { size: ['=res + 1', '=typeof res == "number" ? 1 : 0', '=mode == "b" ? 2 : 3'] } } }, output: 'b',
  });
  const run = async (params: Record<string, any>) => e.cook({ nodes: { a: { type: 'test_res_box', params } } });
  const def = await run({}), sixteen = await run({ res: 16 }), text = await run({ res: '4' }), bad = await run({ res: 5 }), idx = await run({ mode: 0 }), byIdx = await run({ res: 1 });
  check(def.ok && size3(def.geo).join() === '9,1,2' && sixteen.ok && size3(sixteen.geo).join() === '17,1,2', 'a numeric option is a number in the asset ("=res + 1" adds)');
  check(text.ok && size3(text.geo).join() === '5,1,2', 'the same number written as text picks the numeric option ("4" → 4)');
  check(!bad.ok && /param "res" must be one of: 4 \| 8 \| 16 \(got 5\)/.test(bad.errors[0]?.message ?? ''), `a number that is not an option is an error (${bad.errors[0]?.message})`);
  check(idx.ok && size3(idx.geo)[2] === 3 && !byIdx.ok, 'a whole number is an index into text options only (mode 0 = "a"; res 1 is not an option)');
  const untyped = e.registerAsset('test_untyped_options', { vars: { n: 2 }, params: { n: { options: [1, 2, 3], desc: 'n' } }, nodes: { b: { type: 'box', params: { size: '=n' } } }, output: 'b' });
  check(untyped.params.n.type === 'enum' && JSON.stringify(untyped.params.n.options) === '[1,2,3]', 'a declared var with options and no type is an enum');
  const badOpts = await e.cook({ vars: { k: 1 }, params: { k: { type: 'enum', options: [{ a: 1 }] as any, desc: 'k' } }, nodes: { b: { type: 'box' } } });
  check(!badOpts.ok && /options must be a list of strings or numbers/.test(badOpts.errors[0]?.message ?? ''), 'options that are neither strings nor numbers are rejected');
  check(/\| `4`, `8`, `16` \|/.test(renderNodeReference([], [e.root.assets.get('test_res_box')!.def])), 'the node reference lists numeric options');
}

// ------------------------------------------------------------------ graph vars in code: one form, by their bare name
section('graph vars: expressions and code read them by their bare name');
{
  const e = await newEngine();
  const hf = { type: 'heightfield', params: { size: [4, 4], resolution: 1 } };
  const top = (r: CookReport) => +bboxOf(r.geo).max[1].toFixed(6);
  // every place user code runs reads the same var the same way
  const reads: [string, GraphSpec, (r: CookReport) => boolean][] = [
    ['"=expr" param', { nodes: { b: { type: 'box', params: { size: '=h * 2' } } } }, (r) => top(r) === 0.75],
    ['wrangle', { nodes: { b: { type: 'box' }, w: { type: 'wrangle', in: ['b'], params: { code: '@P.y += h;' } } } }, (r) => top(r) === 1.25],
    ['script', { nodes: { s: { type: 'script', params: { code: "return await lib.run('box', { size: h * 4 });" } } } }, (r) => top(r) === 1.5],
    ['heightfield_layer', { nodes: { f: hf, l: { type: 'heightfield_layer', in: ['f'], params: { expression: 'height + h' } }, m: { type: 'heightfield_to_mesh', in: ['l'] } } }, (r) => top(r) === 0.75],
    ['sdf_expr', { nodes: { s: { type: 'sdf_expr', params: { code: 'sdSphere(p, h)' } }, m: { type: 'sdf_to_mesh', in: ['s'], params: { divisions: 16 } } } }, (r) => Math.abs(top(r) - 0.75) < 0.05],
    ['parametric_curve', { nodes: { c: { type: 'parametric_curve', params: { expr: '[t, t * h, 0]', count: 3 } } } }, (r) => top(r) === 0.75],
    ['parametric_surface', { nodes: { c: { type: 'parametric_surface', params: { expr: '[u, h, v]', divisions: [2, 2] } } } }, (r) => top(r) === 0.75],
    ['group expr', { nodes: { b: { type: 'box' }, g: { type: 'group', in: ['b'], params: { class: 'point', name: 'up', expr: '@P.y > h - 0.5' } }, d: { type: 'delete', in: ['g'], params: { class: 'point', group: 'up' } } } }, (r) => top(r) === -0.5],
    ['assert expr', { nodes: { b: { type: 'box' }, a: { type: 'assert', in: ['b'], params: { expr: 'npoints == 8 && h == 0.75' } } } }, (r) => top(r) === 0.5],
    ['foreach body wrangle', { nodes: { b: { type: 'box' }, f: { type: 'foreach', in: ['b'], params: { mode: 'count', count: 2, body: { nodes: { i: { type: 'input' }, w: { type: 'wrangle', in: ['i'], params: { code: '@P.y += h * iteration + value;' } } }, output: 'w' } } } } }, (r) => top(r) === 2.25],
  ];
  const bad: string[] = [];
  for (const [label, g, ok] of reads) {
    const r = await e.cook({ ...g, vars: { h: 0.75 } });
    if (!r.ok || !ok(r)) bad.push(`${label}: ${r.ok ? `top ${top(r)}` : r.errors.map((x) => x.message).join('; ')}`);
  }
  check(!bad.length, `"=expr" params, wrangle, script, heightfield_layer, sdf_expr, parametric curves and surfaces, group and assert expressions and loop bodies read h${bad.length ? ': ' + bad.join(' | ') : ''}`);

  // the old form fails everywhere, saying what to write instead
  const old: [string, GraphSpec, string][] = [
    ['"=expr" param', { nodes: { b: { type: 'box', params: { size: '=vars.h * 2' } } } }, 'param "size": expression "=vars.h * 2" failed: vars.h: read graph vars by their bare name: h'],
    ['wrangle', { nodes: { b: { type: 'box' }, w: { type: 'wrangle', in: ['b'], params: { code: '@P.y += vars.h;' } } } }, 'wrangle error: vars.h: read graph vars by their bare name: h (line 1: @P.y += vars.h;)'],
    ['script', { nodes: { s: { type: 'script', params: { code: "return await lib.run('box', { size: vars.h });" } } } }, 'script error: vars.h: read graph vars by their bare name: h'],
    ['heightfield_layer', { nodes: { f: hf, l: { type: 'heightfield_layer', in: ['f'], params: { expression: 'height + vars.h' } } } }, 'heightfield_layer: vars.h: read graph vars by their bare name: h'],
    ['sdf_expr', { nodes: { s: { type: 'sdf_expr', params: { code: 'sdSphere(p, vars.h)' } } } }, 'sdf_expr: vars.h: read graph vars by their bare name: h'],
    ['parametric_curve', { nodes: { c: { type: 'parametric_curve', params: { expr: '[t, vars.h, 0]' } } } }, 'parametric_curve: vars.h: read graph vars by their bare name: h'],
    ['assert expr', { nodes: { b: { type: 'box' }, a: { type: 'assert', in: ['b'], params: { expr: 'vars.h > 0' } } } }, 'assert expr "vars.h > 0" cannot be evaluated: vars.h: read graph vars by their bare name: h'],
    ['destructuring', { nodes: { b: { type: 'box' }, w: { type: 'wrangle', in: ['b'], params: { code: 'const { h } = vars;' } } } }, 'wrangle error: vars.h: read graph vars by their bare name: h'],
    ['the whole object', { nodes: { b: { type: 'box' }, w: { type: 'wrangle', in: ['b'], params: { code: 'Object.keys(vars);' } } } }, 'wrangle error: vars: read graph vars by their bare name (height, not vars.height)'],
  ];
  const unclear: string[] = [];
  for (const [label, g, want] of old) {
    const r = await e.cook({ ...g, vars: { h: 0.75 } });
    const msg = r.errors[0]?.message ?? '';
    if (r.ok || !msg.startsWith(want)) unclear.push(`${label}: ${r.ok ? 'cooked' : msg}`);
  }
  check(!unclear.length, `vars.h fails in every realm with what to write instead${unclear.length ? ': ' + unclear.join(' | ') : ''}`);

  // the code's own names come first; vars are read-only copies
  const local = await e.cook({ vars: { h: 0.75, list: [1, 2] }, nodes: { b: { type: 'box' }, w: { type: 'wrangle', in: ['b'], params: { code: 'const h = 2; @P.y += h;' } } } });
  const own = await e.cook({ vars: { ptnum: 5 } as any, nodes: { b: { type: 'box' } } });
  check(local.ok && top(local) === 2.5 && !own.ok, 'a local of the code hides the var of the same name (and a graph cannot declare a wrangle\'s own names such as ptnum)');
  const vv = { h: 0.75, list: [1, 2] };
  const write = await e.cook({ vars: vv, nodes: { b: { type: 'box' }, w: { type: 'wrangle', in: ['b'], params: { code: 'h = 2;' } } } });
  const push = await e.cook({ vars: vv, nodes: { b: { type: 'box' }, w: { type: 'wrangle', in: ['b'], params: { code: 'list.push(3);' } } } });
  const scriptPush = await e.cook({ vars: vv, nodes: { s: { type: 'script', params: { code: 'list[0] = 9; return geo;' } } } });
  check(/Assignment to constant variable/.test(write.errors[0]?.message ?? '') && /not extensible/.test(push.errors[0]?.message ?? '') && /read only/.test(scriptPush.errors[0]?.message ?? '') && vv.list.join() === '1,2',
    'assigning a var or changing its value fails, and the graph\'s own value stays');

  // heightfield_layer: a layer of the same name comes first, with a warning
  const layerVar = await e.cook({ vars: { height: 5 }, nodes: { f: hf, l: { type: 'heightfield_layer', in: ['f'], params: { expression: 'height + 1' } }, m: { type: 'heightfield_to_mesh', in: ['l'] } } });
  check(layerVar.ok && top(layerVar) === 1 && layerVar.warnings.some((w) => /^height in the expression is this node's own \(a layer or a sample variable\), not the graph var of that name/.test(w.message)),
    `heightfield_layer: the layer named height comes first, and the cook says the var is hidden (${layerVar.warnings.map((w) => w.message).join('; ')})`);

  // names a graph cannot declare: code could not read them, or they would hide one of code's own names
  const names: [string, RegExp][] = [
    ['class', /is a JavaScript keyword/], ['default', /is a JavaScript keyword/], ['noise', /would hide the helper noise/],
    ['rand', /would hide the helper rand/], ['length', /would hide the helper length/], ['bbox', /would hide the helper bbox/],
    ['Number', /would hide the helper Number/], ['JSON', /would hide JavaScript's JSON/], ['time', /would hide the cook time/],
    ['Frame', /would hide @Frame in wrangles/], ['vars', /has no vars object/], ['__env', /belong to the engine/], ['2d', /not a name code can read/],
    ['my-var', /not a name code can read/],
  ];
  const wrong: string[] = [];
  for (const [n, want] of names) {
    const r = await e.cook({ vars: { [n]: 1 }, nodes: { b: { type: 'box' } } });
    const err = r.errors.find((x) => x.node === '(vars)');
    if (r.ok || !err || !want.test(err.message) || !/bare name/.test(err.hint ?? '')) wrong.push(`${n}: ${r.ok ? 'accepted' : r.errors.map((x) => x.message).join('; ')}`);
  }
  const declared = await e.cook({ vars: {}, params: { rand: { type: 'float', desc: 'r' } }, nodes: { b: { type: 'box' } } });
  const nested = await e.cook({ nodes: { b: { type: 'box' }, f: { type: 'foreach', in: ['b'], params: { mode: 'count', count: 1, body: { vars: { noise: 1 }, nodes: { i: { type: 'input' } }, output: 'i' } } } } });
  const fine = await e.cook({ vars: { height: 1, seed: 2, wall_length: 3, _x: 4, $k: 5, value: 6 }, nodes: { b: { type: 'box' } } });
  check(!wrong.length && !declared.ok && nested.errors.some((x) => x.node === 'f/(vars)') && fine.ok, `var names that code cannot read by name, or that would hide its own names, are rejected where the graph declares them (vars, params, a body)${wrong.length ? ': ' + wrong.join(' | ') : ''}`);
  const realmGlobals = Object.getOwnPropertyNames(e.host.compile('globalThis')).filter((k) => !SNIPPET_LIB_NAMES.includes(k) && !k.startsWith('__') && !JS_GLOBALS.has(k));
  check(!realmGlobals.length, `every global of the scripting realm is a name a var cannot take${realmGlobals.length ? '; not listed in JS_GLOBALS: ' + realmGlobals.join(', ') : ''}`);

  // caching: code is keyed by the vars it names, so changing another var leaves it cached
  const keyed = (h: number, k: number): GraphSpec => ({
    vars: { h, k },
    nodes: {
      b: { type: 'box' },
      w: { type: 'wrangle', in: ['b'], params: { code: '@P.y += h;' } },
      g: { type: 'group', in: ['b'], params: { class: 'point', name: 'up', expr: '@P.y > h' } },
      a: { type: 'assert', in: ['b'], params: { expr: 'h < 10' } },
      l: { type: 'heightfield_layer', in: ['f'], params: { expression: 'height + h' } }, f: hf,
      s: { type: 'sdf_expr', params: { code: 'sdSphere(p, h)' } },
      c: { type: 'parametric_curve', params: { expr: '[t, h, 0]', count: 3 } },
      sc: { type: 'script', params: { code: 'return geo;' } },
      out: { type: 'merge', in: ['w', 'g', 'a', 'l', 's', 'c', 'sc'] },
    },
    output: 'out',
  });
  const codeNodes = ['w', 'g', 'a', 'l', 's', 'c'];
  const k1 = await cook(keyed(0.5, 1), {}, e), k2 = await cook(keyed(0.5, 2), {}, e), k3 = await cook(keyed(0.25, 2), {}, e);
  check(k1.ok && codeNodes.every((n) => res(k2, n).cached && res(k2, n).sig === res(k1, n).sig) && !res(k2, 'sc').cached,
    'changing a var the code does not name leaves wrangle, group, assert, heightfield_layer, sdf_expr and parametric nodes cached (a script, whose lib.run params can read any var, re-cooks)');
  check(codeNodes.every((n) => !res(k3, n).cached && res(k3, n).sig !== res(k2, n).sig) && top(k3) !== top(k2), 'changing a var the code names re-cooks it');
}

// ------------------------------------------------------------------ the one form everywhere we ship and teach
section('shipped graphs, help topics and node docs read vars by their bare name');
{
  const oldForm = /(?<![\w$.])vars(\.[A-Za-z_$]|\[)/;
  const hits: string[] = [];
  const walk = (where: string, v: any) => {
    // ("height, not vars.height" says what not to write)
    if (typeof v === 'string') { if (oldForm.test(v.replace(/not `?vars\.height/g, ''))) hits.push(where); }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${where}.${k}`, x);
  };
  for (const [rel, g] of shippedGraphs()) walk(rel, g);
  for (const [k, t] of Object.entries(TOPICS)) walk(`topic ${k}`, t);
  for (const d of allNodeDefs()) walk(`node ${d.type}`, nodeDoc(d));
  walk('README.md', fs.readFileSync(path.join(root, 'README.md'), 'utf8'));
  check(!hits.length, `no vars.name anywhere${hits.length ? ': ' + hits.join(', ') : ''}`);
}

// ------------------------------------------------------------------ param coercion
section('param coercion');
{
  // A number param had to be finite, a numeric string did not: "Infinity" or "1e999" (JSON has no Infinity, so a
  // string is how one arrives from a graph file or an MCP client) reached the node as Infinity (resample
  // {count: "Infinity"} ran the process out of memory); here a box of infinite size cooked with a warning
  const bad = [
    { type: 'box', params: { size: ['Infinity', 1, 1] } }, { type: 'sphere', params: { radius: '-Infinity' } },
    { type: 'box', params: { center: [0, '1e999', 0] } },
  ];
  const msgs: string[] = [];
  for (const n of bad) {
    const r = await cook({ nodes: { n } });
    msgs.push(r.ok ? `${JSON.stringify(n.params)} cooked` : r.errors[0].message);
  }
  check(msgs.every((m) => /^param "(size|radius|center)"(\[\d\])? (expects a number|is not a number)/.test(m)), `non-finite numeric strings are rejected like non-finite numbers: ${msgs.join(' | ')}`);
  const ok = await cook({ nodes: { b: { type: 'box', params: { size: ['2', ' 0.5 ', '1e2'] } } } });
  check(ok.ok && size3(ok.geo).join() === '2,0.5,100', 'finite numeric strings still coerce');
}

// ------------------------------------------------------------------ versioning and deprecation
section('graph version field');
{
  // graphs are read as they are: no migrations (no backwards compatibility for now); a version, when given, is a number
  const any = await engine.cook({ version: 7, nodes: { b: { type: 'box' } } });
  check(any.ok, 'a graph cooks whatever version it says');
  const badV = await engine.cook({ version: -1 as any, nodes: { b: { type: 'box' } } });
  check(!badV.ok && badV.errors.some((e) => /"version" must be a non-negative integer/.test(e.message)), 'a malformed version is an error');

  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsDir, 'graphs'), { recursive: true });
  const ws = new Session(wsDir, await newEngine());
  ws.load();

  // rename keeps expression references working
  ws.setGraph('refs', { nodes: { base: { type: 'box' }, top: { type: 'sphere', params: { center: [0, "=bbox('base').max.y", 0], radius: "=ch('base/size')[0] / 4" } } }, output: 'top' });
  const ed = ws.applyEdits('refs', [{ op: 'rename', node: 'base', to: 'plinth' }]);
  const tp = ed.graph.nodes.top.params!;
  check(tp.center[1] === "=bbox('plinth').max.y" && tp.radius === "=ch('plinth/size')[0] / 4" && ed.notes.some((n) => /expression references/.test(n)), 'rename rewrites expression references');

  // MCP tools in-process: frame parameter and docs
  const tools = makeTools(ws);
  const call = async (name: string, a: any) => {
    const r = await tools.find((t) => t.name === name)!.run(a);
    return { txt: r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'), isError: !!r.isError };
  };
  const solverGraph = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'solver_growth.json'), 'utf8'));
  const b12 = await call('build', { name: 'anim', graph: solverGraph, frame: 12 });
  check(!b12.isError && /cooked at frame 12/.test(b12.txt) && /stats: grow resumed_from=1 frames=11 body_runs=11/.test(b12.txt) && /time-dependent: .*grow/.test(b12.txt), 'MCP build frame:12 reports the frame and solver stats');
  const b1 = await call('build', { name: 'anim', graph: solverGraph });
  check(!b1.isError && !/at frame/.test(b1.txt.split('\n')[0]), 'MCP build at frame 1 does not mention the frame');
  const insp = await call('inspect', { graph: 'anim', frame: 12 });
  check(/anim\/out at frame 12/.test(insp.txt), 'MCP inspect frame');
  const ex = await call('export', { graph: 'anim', path: 'exports/anim.obj', frame: 3 });
  check(!ex.isError && /at frame 3/.test(ex.txt) && fs.existsSync(path.join(wsDir, 'exports', 'anim.obj')), 'MCP export frame');
  const help = await call('help', { topic: 'time' });
  check(/SOLVER vs FOREACH/.test(help.txt) && /\{frame:04\}/.test(help.txt), 'help topic time');
  check(/bbox\('n'\)/.test(TOPICS.expressions) && /ch\('n', 'param'\)/.test(TOPICS.expressions) && /dynamic names/.test(TOPICS.expressions), 'expressions topic documents reference functions');
}

section('deprecation');
{
  const cat = catalogText(allNodeDefs());
  check(!/test_old_box/.test(cat) && /deprecated node type\(s\) hidden/.test(cat), 'catalog hides deprecated nodes');
  check(/test_old_box ◦ \(deprecated\)/.test(catalogText(allNodeDefs(), { deprecated: true })), 'catalog lists them when asked');
  const doc = nodeDoc(allNodeDefs().find((d) => d.type === 'test_old_box')!);
  check(/DEPRECATED: use "box" instead/.test(doc), 'help shows the deprecation notice');
  const r = await engine.cook({ nodes: { old: { type: 'test_old_box', params: { size: 2 } } } });
  check(r.ok && r.warnings.some((w) => w.node === 'old' && /deprecated: use "box" instead/.test(w.message)), 'cooking a deprecated node warns');
  const again = await engine.cook({ nodes: { old: { type: 'test_old_box', params: { size: 2 } } } });
  check(res(again, 'old').cached && again.warnings.some((w) => /deprecated/.test(w.message)), 'the warning repeats on cache hits');
  check(engine.dryRun({ nodes: { old: { type: 'test_old_box' } } }).notes.some((n) => /deprecated/.test(n)), 'dryRun notes deprecated nodes');
}

section('param ranges');
{
  // a value outside a param's min/max is clamped, and the cook says so (a silent clamp hid a wall asset whose range
  // was narrower than the house that drives it)
  const g = { nodes: { s: { type: 'sphere', params: { type: 'ico', level: 9 } } } };
  const r = await engine.cook(g);
  check(r.ok && r.warnings.some((w) => w.node === 's' && /^param "level" 9 clamped to 7 \(range 0\.\.7\)$/.test(w.message)), `clamping warns: ${r.warnings.map((w) => w.message).join('; ')}`);
  const again = await engine.cook(g);
  check(res(again, 's').cached && again.warnings.some((w) => /clamped to 7/.test(w.message)), 'the clamp warning repeats on cache hits');
  check(engine.dryRun(g).warnings.some((w) => w.node === 's' && /clamped to 7/.test(w.message)), 'dryRun reports the clamp');
  const vec = await engine.cook({ nodes: { b: { type: 'box', params: { divisions: [1, 600, 1] } } } });
  check(vec.ok && vec.warnings.some((w) => /^param "divisions"\[1\] 600 clamped to 512/.test(w.message)), 'vector components clamp with the index');
}

// ------------------------------------------------------------------ CLI
section('CLI --frames');
{
  const out = path.join(tmp, 'cli');
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'src', 'cli.ts'), path.join(root, 'examples', 'solver_growth.json'), ...args], { cwd: root, encoding: 'utf8' });
  const p = run('--frames', '1-3', '--export', path.join(out, 'tower.obj'), '--render', path.join(out, 'r_{frame:04}.png'), '--views', 'persp');
  check(p.status === 0, `cli exit status ${p.status}${p.status ? ': ' + p.stderr.slice(0, 300) : ''}`);
  const want = ['tower.0001.obj', 'tower.0002.obj', 'tower.0003.obj', 'r_0001.png', 'r_0002.png', 'r_0003.png'];
  const have = fs.existsSync(out) ? fs.readdirSync(out) : [];
  check(want.every((f) => have.includes(f)), `numbered files written: ${have.sort().join(', ')}`);
  const lines = (f: string) => fs.readFileSync(path.join(out, f), 'utf8').split('\n').filter((l) => l.startsWith('f ')).length;
  check(lines('tower.0001.obj') < lines('tower.0003.obj'), `frames differ (${lines('tower.0001.obj')} vs ${lines('tower.0003.obj')} faces)`);
  check(/frame 3: out/.test(p.stdout) && /3\/3 ok/.test(p.stdout), 'per-frame log lines');
  const q = run('--frames', '2-4:2', '--export', path.join(out, 'step_{frame}.json'));
  check(q.status === 0 && fs.existsSync(path.join(out, 'step_2.json')) && fs.existsSync(path.join(out, 'step_4.json')) && !fs.existsSync(path.join(out, 'step_3.json')), '{frame} pattern with a step');
  const single = run('--frame', '5');
  check(single.status === 0 && /at frame 5/.test(single.stdout), '--frame N');
  const badRange = run('--frames', '5-1');
  check(badRange.status !== 0 && /before start/.test(badRange.stderr), 'invalid range is rejected');
}

section('CLI arguments');
{
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'src', 'cli.ts'), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const v = cli('--version');
  check(v.status === 0 && v.stdout.trim() === `topotopo ${pkg.version}`, `--version prints the package version (${v.stdout.trim()})`);
  check(cli('-v').stdout.trim() === `topotopo ${pkg.version}`, '-v is the short form');
  const unknown = cli('--no-such-flag');
  check(unknown.status === 1 && /unknown option "--no-such-flag"/.test(unknown.stderr) && !/at .*cli\.ts/.test(unknown.stderr), 'an unknown leading option fails without a stack trace');
  const missing = cli(path.join(tmp, 'nope.json'));
  check(missing.status === 1 && /no such graph file/.test(missing.stderr) && !/ENOENT/.test(missing.stderr), 'a missing graph file is reported plainly');
  const bad = path.join(tmp, 'bad.json'); fs.writeFileSync(bad, '{ nodes: ');
  const badJson = cli(bad);
  check(badJson.status === 1 && /not valid JSON/.test(badJson.stderr), 'invalid JSON is reported plainly');
  const cat = cli('--catalog');
  check(cat.status === 0 && /\[package\]/.test(cat.stdout) && /^\s+topotopo\/architecture\/house — House built from a footprint polygon/m.test(cat.stdout), `--catalog lists the outputs of TopoTopo's own packages (status ${cat.status}, ${cat.stdout.length} chars)`);
  const hn = cli('--help-node', 'topotopo/architecture/house');
  check(hn.status === 0 && /footprint/.test(hn.stdout) && /floors/.test(hn.stdout) && /\nin this folder: package topotopo\/architecture: this graph is in no package/.test(hn.stdout),
    '--help-node documents one, and says what naming it does in a folder that is in no package');
  check(/unknown node "nope_node"/.test(cli('--help-node', 'nope_node').stdout), '--help-node names an unknown type');
  check(/--help-node <type> for a node's params; --help-topic <name> for a topic: overview, library, graph/.test(cat.stdout) && !/Use help \{nodes/.test(cat.stdout),
    '--catalog ends with the command line\'s help flags and the topic names');
  const topic = cli('--help-topic', 'export');
  check(topic.status === 0 && topic.stdout.trim() === TOPICS.export.trim(), '--help-topic prints an MCP help topic');
  check(/^TopoTopo: .*\n\nWORKFLOW/.test(cli('--help-topic', 'overview').stdout), '--help-topic overview prints the operating guide');
  const badTopic = cli('--help-topic', 'exprt');
  check(badTopic.status === 1 && /unknown topic "exprt" \(did you mean export\?\); topics: overview, library, graph, /.test(badTopic.stderr) && !badTopic.stdout,
    '--help-topic: an unknown name fails and lists the topics');
}

section('CLI --output, --var and export sources (replay from the manifest)');
{
  // tuning a terrain from the command line: vars for one run, a named output, and a record that makes it again
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'src', 'cli.ts'), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const dir = path.join(tmp, 'replay');
  fs.mkdirSync(dir, { recursive: true });
  const g = path.join(dir, 'land.json');
  fs.writeFileSync(g, JSON.stringify({
    nodes: {
      hf: { type: 'heightfield', params: { size: [20, 20], resolution: 0.5 } },
      hills: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: '=relief', element_size: 8, seed: '=seed' } },
      ground: { type: 'heightfield_to_mesh', in: ['hills'] },
      pts: { type: 'scatter', in: ['ground'], params: { count: '=count', seed: 2 } },
      out: { type: 'merge', in: ['ground', 'pts'] },
    },
    output: 'out',
    outputs: { mesh: { node: 'ground', label: 'Ground mesh', export: 'glb' }, field: { node: 'hills' } },
    vars: { relief: 2, seed: 1, count: 10 },
  }, null, 2));
  const first = cli(g, '--output', 'mesh', '--var', 'relief=5', '--var', 'seed=3', '--export', path.join(dir, 'a', 'land.glb'));
  check(first.status === 0 && /cooked .*land\.json → output "mesh" \(ground\) with relief=5, seed=3/.test(first.stdout) && /; source: .*land\.glb\.source\.json/.test(first.stdout),
    `--output and --var: the named output cooked with the overrides (${first.status ? first.stderr.slice(0, 200) : first.stdout.split('\n')[0]})`);
  const manifestFile = path.join(dir, 'a', 'land.glb.source.json');
  const man = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const s = man?.source;
  check(man?.format === 'topotopo-export-source' && JSON.stringify(man.files) === '["land.glb"]' && s.graph === 'land' && s.output === 'mesh' && s.node === 'ground'
    && s.frame === 1 && s.fps === 24 && JSON.stringify(s.vars) === '{"count":10,"relief":5,"seed":3}' && JSON.stringify(s.seeds) === '{"hills":"=seed","pts":2}'
    && JSON.stringify(s.export) === '{"format":"glb","options":{"compress":"none","custom_attribs":false,"instancing":"packed","materials":true,"quantize":false,"scale":1,"split_by_name":true,"tangents":"auto","up_axis":"y","vertex_colors":false}}'
    && /^[0-9a-f]{64}$/.test(s.graph_sha256) && s.topotopo === pkg.version,
    `the export writes land.glb.source.json: graph, output, node, frame, fps, every var after overrides, seeds, format and every option with its default, graph hash, version (${JSON.stringify(s?.export)})`);
  const glb = fs.readFileSync(path.join(dir, 'a', 'land.glb'));
  const asset = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')).asset;
  check(JSON.stringify(asset.extras?.source) === JSON.stringify(s), 'the GLB carries the same block in asset.extras.source');
  // replay: the manifest's output, frame, fps, vars, format and every option on the command line give the same bytes
  const replay = replayArgs(s, path.join(dir, 'b', 'land.glb'), exportOptionFlags);
  const again = cli(g, ...replay);
  check(again.status === 0 && sha(path.join(dir, 'b', 'land.glb')) === sha(path.join(dir, 'a', 'land.glb'))
    && fs.readFileSync(path.join(dir, 'b', 'land.glb.source.json'), 'utf8') === fs.readFileSync(manifestFile, 'utf8'),
    `replaying the manifest (${replay.join(' ')}) writes the same GLB and a byte-identical manifest`);
  const plain = cli(g, '--output', 'mesh', '--export', path.join(dir, 'c', 'land.glb'));
  const plainSource = JSON.parse(fs.readFileSync(path.join(dir, 'c', 'land.glb.source.json'), 'utf8')).source;
  check(plain.status === 0 && sha(path.join(dir, 'c', 'land.glb')) !== sha(path.join(dir, 'a', 'land.glb')) && plainSource.graph_sha256 !== s.graph_sha256 && plainSource.vars.relief === 2,
    'without the overrides the export and its graph hash differ (the file\'s own vars)');
  // the same output through its export target writes the same bytes
  const all = cli(g, '--var', 'relief=5', '--var', 'seed=3', '--export-all');
  check(all.status === 0 && sha(path.join(dir, 'exports', 'mesh.glb')) === sha(path.join(dir, 'a', 'land.glb'))
    && JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'exports', 'mesh.glb.source.json'), 'utf8')).source) === JSON.stringify(s),
    '--export-all with the same vars writes the same GLB and source through the output\'s export target');
  // a heightmap keeps the source in its sidecar
  // an export target with options of its own (custom attributes on, Z up, centimetres): its record replays on the CLI
  const tg = path.join(dir, 'target.json');
  fs.writeFileSync(tg, JSON.stringify({
    nodes: { b: { type: 'box', params: { divisions: [2, 2, 2] } }, h: { type: 'attrib_randomize', in: ['b'], params: { name: 'heat' } } },
    output: 'h', export: { format: 'glb', path: 'crate.glb', custom_attribs: true, up_axis: 'z', scale: 100 },
  }));
  const tAll = cli(tg, '--export-all');
  const tSrc = JSON.parse(fs.readFileSync(path.join(dir, 'exports', 'crate.glb.source.json'), 'utf8')).source;
  const tReplay = cli(tg, ...replayArgs(tSrc, path.join(dir, 'r', 'crate.glb'), exportOptionFlags));
  check(tAll.status === 0 && tSrc.export.options.custom_attribs === true && tSrc.export.options.materials === true && tReplay.status === 0
    && sha(path.join(dir, 'r', 'crate.glb')) === sha(path.join(dir, 'exports', 'crate.glb'))
    && JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'r', 'crate.glb.source.json'), 'utf8')).source) === JSON.stringify(tSrc),
    `an export target's record (custom attributes on, Z up, cm) replays on the CLI to the same bytes and record (${replayArgs(tSrc, 'crate.glb', exportOptionFlags).join(' ')})`);
  const on = cli(tg, '--custom-attribs', '--export', path.join(dir, 'r', 'on.glb')), off = cli(tg, '--no-custom-attribs', '--export', path.join(dir, 'r', 'off.glb'));
  const dflt = cli(tg, '--export', path.join(dir, 'r', 'default.glb'));
  check(on.status === 0 && off.status === 0 && dflt.status === 0 && sha(path.join(dir, 'r', 'on.glb')) !== sha(path.join(dir, 'r', 'off.glb')) && sha(path.join(dir, 'r', 'default.glb')) === sha(path.join(dir, 'r', 'off.glb'))
    && /"custom_attribs": false/.test(fs.readFileSync(path.join(dir, 'r', 'off.glb.source.json'), 'utf8')) && /_HEAT/.test(fs.readFileSync(path.join(dir, 'r', 'on.glb')).toString('latin1')),
    '--custom-attribs / --no-custom-attribs on the CLI export: off by default for glTF, and the record says which');
  const badFlag = cli(tg, '--up-axis', 'x', '--export', path.join(dir, 'r', 'bad.glb'));
  check(badFlag.status === 1 && /--up_axis must be one of y, z|--up-axis must be one of y, z/.test(badFlag.stderr), `an export flag with a value it does not take is refused (${badFlag.stderr.trim()})`);
  const field = cli(g, '--output', 'field', '--var', 'relief=5', '--export', path.join(dir, 'h', 'field.png'));
  const side = JSON.parse(fs.readFileSync(path.join(dir, 'h', 'field.json'), 'utf8'));
  check(field.status === 0 && side.source.output === 'field' && side.source.node === 'hills' && side.source.export.format === 'png16' && side.height_max > 0
    && fs.readdirSync(path.join(dir, 'h')).sort().join() === 'field.json,field.png', 'png16: the sidecar records the source, no separate manifest');
  // --output renders and inspects the named output
  const look = cli(g, '--output', 'field', '--views', 'top', '--size', '128', '--render', path.join(dir, 'field_top.png'));
  check(look.status === 0 && /heightfield "heightfield": 41×41 samples/.test(look.stdout) && fs.existsSync(path.join(dir, 'field_top.png')), '--output renders and inspects the named output');
  // mistakes are named
  const nodeAsOut = cli(g, '--output', 'ground'), outAsNode = cli(g, '--node', 'mesh');
  check(nodeAsOut.status === 1 && /has no output "ground", but a node of that name: --node ground/.test(nodeAsOut.stderr)
    && outAsNode.status === 1 && /has no node "mesh", but an output of that name: --output mesh/.test(outAsNode.stderr), `--output naming a node suggests --node, and the reverse (${nodeAsOut.stderr.trim()})`);
  const badOut = cli(g, '--output', 'mesj');
  check(badOut.status === 1 && /no output "mesj" \(did you mean mesh\?\); its outputs: mesh, field/.test(badOut.stderr), `--output: an unknown name lists the outputs (${badOut.stderr.trim()})`);
  const noOuts = path.join(dir, 'plain.json');
  fs.writeFileSync(noOuts, JSON.stringify({ nodes: { b: { type: 'box' } } }));
  check(/publishes no "outputs"/.test(cli(noOuts, '--output', 'x').stderr), '--output on a graph without outputs says so');
  const badVar = cli(g, '--var', 'relif=3');
  check(badVar.status === 1 && /unknown var "relif" \(did you mean relief\?\); the graph's vars: relief, seed, count/.test(badVar.stderr), `--var: an unknown var names the known ones (${badVar.stderr.trim()})`);
  check(/not valid JSON/.test(cli(g, '--var', 'relief=[1,').stderr) && /name=value/.test(cli(g, '--var', 'relief').stderr) && /name=value/.test(cli(g, '--var').stderr),
    '--var: malformed values fail with a plain message');
  check(/either --node or --output/.test(cli(g, '--node', 'ground', '--output', 'mesh').stderr), '--node and --output together are refused');
}

section('CLI heightfield render resolution');
{
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'src', 'cli.ts'), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  const big = path.join(tmp, 'big_field.json');
  fs.writeFileSync(big, JSON.stringify({ nodes: { hf: { type: 'heightfield', params: { size: [64, 64], samples: [513, 513] } }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 4, element_size: 16 } } } }));
  const sizeOf = (f: string) => { const d = fs.readFileSync(f); return [d.readUInt32BE(16), d.readUInt32BE(20)]; };
  const preview = cli(big, '--views', 'top', '--size', '160', '--render', path.join(tmp, 'hf_preview.png'));
  check(preview.status === 0 && /heightfield "heightfield" shown at 257×257 of 513×513 samples \(1 in 2 per side\); heightfield_res "full" \(CLI --heightfield-res full\)/.test(preview.stdout),
    `a 513 × 513 heightfield renders at 257 × 257 and the notes say so (${preview.stdout.split('\n').find((l) => l.startsWith('rendered')) ?? preview.stderr.slice(0, 200)})`);
  const full = cli(big, '--views', 'top', '--size', '160', '--heightfield-res', 'full', '--render', path.join(tmp, 'hf_full.png'));
  check(full.status === 0 && !/shown at/.test(full.stdout) && sizeOf(path.join(tmp, 'hf_preview.png'))[1] === sizeOf(path.join(tmp, 'hf_full.png'))[1] + 16,
    '--heightfield-res full draws every sample: no note, and no second footer line');
  const bad = cli(big, '--heightfield-res', 'lots', '--render', path.join(tmp, 'hf_bad.png'));
  check(bad.status === 1 && /heightfield_res expects quads per side/.test(bad.stderr), '--heightfield-res rejects a value that is not a number or "full"');
}

section('CLI several renders per cook, triangle budget');
{
  // dogfood 2026-10-15: three layers cost three cooks; dense instancing previewed as a 10% subset
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'src', 'cli.ts'), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  const g = path.join(tmp, 'many.json');
  fs.writeFileSync(g, JSON.stringify({ nodes: {
    s: { type: 'sphere', params: { type: 'ico', level: 2 } },
    pts: { type: 'point_grid', params: { counts: [60, 1, 60], size: [60, 0, 60] } },
    h: { type: 'wrangle', in: ['pts'], params: { code: '@height = @P.x;' } },
    c: { type: 'copy_to_points', in: ['s', 'h'], params: { pack: true } },
  }, output: 'c' }));
  const a = path.join(tmp, 'r_a.png'), b = path.join(tmp, 'r_b.png');
  const two = cli(g, '--views', 'top', '--size', '200', '--render', a, '--color-by', 'height', '--render', b, '--size', '160');
  const sizeOf = (f: string) => { const d = fs.readFileSync(f); return [d.readUInt32BE(16), d.readUInt32BE(20)]; };
  check(two.status === 0 && (two.stdout.match(/^cooked /gm) ?? []).length === 1 && fs.existsSync(a) && fs.existsSync(b),
    `two --render flags: one cook, two files (${(two.stdout.match(/^cooked /gm) ?? []).length} cook line)`);
  check(/rendered .*r_a\.png.*color by height/.test(two.stdout) && !/rendered .*r_b\.png.*color by/.test(two.stdout) && sizeOf(a)[0] === 200 && sizeOf(b)[0] === 160,
    `per-render options: colour only on the first, size 200 / 160 (${sizeOf(a)[0]} / ${sizeOf(b)[0]}); shared --views top on both`);
  check(/warning: --size after the last --render apply to .*r_b\.png only; options before the first --render apply to every render/.test(two.stderr), `options after the last of several --render: a warning (${two.stderr.trim().slice(0, 120)})`);
  const one = cli(g, '--views', 'top', '--render', a, '--size', '120');
  check(one.status === 0 && !/warning/.test(one.stderr), 'one --render: options after it are its own, no warning');
  const capped = cli(g, '--views', 'top', '--size', '120', '--render', a);
  const lifted = cli(g, '--views', 'top', '--size', '120', '--render', a, '--max-triangles', '2000000');
  check(/rendering .* of 3\.6k instances/.test(capped.stdout) && lifted.status === 0 && !/rendering .* of/.test(lifted.stdout),
    '--max-triangles: 1.15M instance triangles draw as a subset by default and in full with a 2M budget');
}

section('relative paths read from the package folder');
{
  // a graph in a package's graphs/ reads "inputs/…" from the package, cooked from anywhere; export targets go to its exports/
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'src', 'cli.ts'), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(proj, 'graphs'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'inputs'), { recursive: true });
  const init = cli('init', proj);
  fs.writeFileSync(path.join(proj, 'inputs', 'tri.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  const g = path.join(proj, 'graphs', 'piece.json');
  fs.writeFileSync(g, JSON.stringify({ nodes: { f: { type: 'file', params: { path: 'inputs/tri.obj' } } }, output: 'f', export: 'obj' }));
  const r = cli(g, '--export-all');
  check(init.status === 0 && r.status === 0 && /3 points, 1 prims/.test(r.stdout) && fs.existsSync(path.join(proj, 'exports', 'piece.obj')) && !fs.existsSync(path.join(proj, 'graphs', 'exports')),
    `a graph in graphs/ reads inputs/ of its package, and --export-all writes the package's exports/ (${r.status ? r.stderr.trim().slice(0, 160) : 'ok'})`);
  check(packageBaseDir(path.join(proj, 'graphs')) === proj && packageBaseDir(path.join(tmp, 'cli')) === path.resolve(tmp, 'cli'), 'packageBaseDir: the nearest project.json, else the folder itself');
  const e = new Engine(createNodeHost({ baseDir: path.join(proj, 'graphs') }));
  check(e.host.resolvePath('inputs/tri.obj') === path.join(proj, 'inputs', 'tri.obj'), 'the node host resolves relative paths against the package folder');
}

section('progress and stop: CookOptions.onNode, signal, ctx.checkpoint');
{
  // test-only nodes: one holds the thread (a node cannot be interrupted), one waits in steps that check for a stop
  let busyCooks = 0;
  defineNode({
    type: 'test_progress_busy', category: 'flow', summary: 'test only: holds the thread for ms, then passes its input on', inputs: [{ name: 'in', desc: 'geometry', optional: true }],
    params: { ms: { type: 'int', default: 50, desc: 'ms' }, tag: { type: 'string', default: '', desc: 'signature tag' } },
    cook: (ctx) => { busyCooks++; const t = performance.now(); while (performance.now() - t < ctx.p.ms); return ctx.hasInput(0) ? ctx.input(0) : new Geometry(); },
  });
  defineNode({
    type: 'test_progress_steps', category: 'flow', summary: 'test only: waits for ms in 10 ms steps, checking for a stop', inputs: [{ name: 'in', desc: 'geometry', optional: true }],
    params: { ms: { type: 'int', default: 50, desc: 'ms' }, tag: { type: 'string', default: '', desc: 'signature tag' } },
    cook: async (ctx) => {
      for (let t = 0; t < ctx.p.ms; t += 10) { await ctx.checkpoint(); await new Promise((r) => setTimeout(r, 10)); }
      return ctx.hasInput(0) ? ctx.input(0) : new Geometry();
    },
  });
  const e = await newEngine();
  const chain = (tag: string, ms = 60): GraphSpec => ({
    nodes: {
      a: { type: 'test_progress_busy', params: { ms, tag } },
      b: { type: 'test_progress_busy', in: ['a'], params: { ms, tag } },
      c: { type: 'test_progress_busy', in: ['b'], params: { ms, tag } },
    }, output: 'c',
  });
  const seen: string[] = [];
  const onNode = (ev: any) => { seen.push(`${ev.phase}:${ev.node}${ev.depth ? `@${ev.depth}:${ev.within.join('/')}` : ''}`); };
  const r1 = await e.cook(chain('p'), { onNode });
  check(r1.ok && seen.join() === 'start:a,end:a,start:b,end:b,start:c,end:c', `onNode: each cooked node starts and ends, in cook order (${seen.join()})`);
  seen.length = 0;
  const r2 = await e.cook(chain('p'), { onNode });
  check(r2.ok && !seen.length, 'cache hits are not reported');

  // a stop while a node holds the thread: that node runs to its end, the next one does not cook
  const signal = { aborted: false };
  seen.length = 0;
  const r3 = await e.cook(chain('q'), { onNode: (ev) => { onNode(ev); if (ev.phase === 'end' && ev.node === 'a') signal.aborted = true; }, signal });
  check(!r3.ok && r3.stopped === 'b' && r3.errors.length === 1 && r3.errors[0].node === 'b' && r3.errors[0].message === STOPPED && seen.join() === 'start:a,end:a,start:b,end:b',
    `a stop at a node boundary: a finished, b is where it stopped, c is upstream-failed (${r3.stopped}; ${seen.join()})`);
  const before = busyCooks;
  const r4 = await e.cook(chain('q'));
  check(r4.ok && busyCooks - before === 2 && !r4.stopped, `nothing of the stopped cook is cached but what finished: the next cook cooks b and c only (${busyCooks - before} cooks)`);

  // a node that checks between its steps stops mid-way
  const steps: GraphSpec = { nodes: { s: { type: 'test_progress_steps', params: { ms: 3000, tag: 'x' } } }, output: 's' };
  const ac = new AbortController();
  const t0 = performance.now();
  setTimeout(() => ac.abort(), 150);
  const r5 = await e.cook(steps, { signal: ac.signal });
  const took = performance.now() - t0;
  check(!r5.ok && r5.stopped === 's' && r5.errors[0]?.message === STOPPED && took < 1500, `ctx.checkpoint stops a long node between its steps (${took.toFixed(0)} ms of 3000)`);
  const r6 = await e.cook(structuredClone(steps), { signal: { aborted: false } });
  check(r6.ok, 'and a cook without a stop runs it through');

  // nested cooks report their nodes inside the node that runs them, and stop with the cook
  const loop = (tag: string): GraphSpec => ({
    nodes: {
      seed: { type: 'box', params: { size: tag.length } },
      loop: { type: 'foreach', in: ['seed'], params: { mode: 'count', count: 3, body: { nodes: { i: { type: 'input', params: { index: 0 } }, w: { type: 'test_progress_busy', in: ['i'], params: { ms: 20, tag: `="${tag}" + iteration` } } }, output: 'w' } } },
    }, output: 'loop',
  });
  seen.length = 0;
  const r7 = await e.cook(loop('a'), { onNode });
  check(r7.ok && seen.filter((s) => s.startsWith('start:w@1:loop')).length === 3 && seen[0] === 'start:seed' && seen.includes('start:loop'),
    `nested cooks report depth 1 within "loop" (${seen.filter((s) => s.includes('@')).length / 2} body cooks)`);
  const ac2 = new AbortController();
  const r8 = await e.cook(loop('bb'), { signal: ac2.signal, onNode: (ev) => { if (ev.depth === 1) ac2.abort(); } });
  check(!r8.ok && r8.stopped === 'loop', `a stop inside a loop body stops the loop: the report names the loop node (${r8.stopped}: ${r8.errors[0]?.message})`);

  // an aborted signal from the start: cached results are still served, the first node to cook stops
  const r9 = await e.cook(chain('p'), { signal: { aborted: true } });
  const r10 = await e.cook(chain('fresh'), { signal: { aborted: true } });
  check(r9.ok && !r10.ok && r10.stopped === 'a', 'with a stop already asked for, cached results still come out and nothing new cooks');
}

section('CLI view');
{
  // `topotopo view <graph.json>`: serves the viewer and re-cooks when the file changes
  const { spawn } = await import('node:child_process');
  const gfile = path.join(tmp, 'view_graph.json');
  fs.writeFileSync(gfile, JSON.stringify({ nodes: { b: { type: 'box' } } }));
  const proc = spawn(process.execPath, [path.join(root, 'src', 'cli.ts'), 'view', gfile, '--port', '0'], { cwd: root });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const until = async (pred: () => boolean, ms: number) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100)); return pred(); };
  try {
    const up = await until(() => /view: http:\/\/127\.0\.0\.1:\d+\//.test(out), 30000);
    check(up, `view prints its URL (${out.trim().split('\n').pop()})`);
    if (up) {
      const url = /view: (http:\/\/127\.0\.0\.1:\d+)\//.exec(out)![1];
      const graphs = async () => (await (await fetch(url + '/api/graphs')).json()) as { name: string; version: number }[];
      const g1 = await graphs();
      check(g1.length === 1 && g1[0].name === 'view_graph' && g1[0].version >= 1, `view serves the graph file (${JSON.stringify(g1.map((g) => [g.name, g.version]))})`);
      const info1 = await (await fetch(`${url}/api/info?graph=view_graph`)).json() as any;
      check(/8 points/.test(JSON.stringify(info1)), 'view cooks it (a box: 8 points)');
      fs.writeFileSync(gfile, JSON.stringify({ nodes: { s: { type: 'sphere', params: { type: 'ico', level: 1 } } } }));
      const bumped = await until(() => /cooked view_graph.*\n.*cooked view_graph/s.test(out), 15000);
      const info2 = await (await fetch(`${url}/api/info?graph=view_graph`)).json() as any;
      check(bumped && /42 points/.test(JSON.stringify(info2)), 'view re-cooks when the file is saved (an ico sphere: 42 points)');
      // dropped files would go to inputs/ beside the graph file (test/viewer.ts drops one); the folder waits for a drop
      const listed = await (await fetch(`${url}/api/inputs`)).json() as any;
      check(Array.isArray(listed) && !listed.length && !fs.existsSync(path.join(tmp, 'inputs')), 'a view run without drops makes no inputs/ folder beside the graph');
    }
  } finally { proc.kill(); }
}

console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
