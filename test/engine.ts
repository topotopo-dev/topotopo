// Engine tests: time and time-dependent caching, the solver node, expression references to other
// nodes, graph versioning, deprecation, and the CLI frame range.
//   node test/engine.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import '../src/nodes/index.ts';
import { Engine, resolveTime } from '../src/graph/engine.ts';
import type { CookOptions, CookReport } from '../src/graph/engine.ts';
import { allNodeDefs, defineNode } from '../src/graph/registry.ts';
import { createNodeHost } from '../src/host/node.ts';
import { GRAPH_VERSION } from '../src/graph/types.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { migrateGraph, migrateGraphDetailed } from '../src/graph/migrate.ts';
import { scanExpr } from '../src/graph/params.ts';
import { catalogText, nodeDoc, TOPICS } from '../src/mcp/docs.ts';
import { Workspace } from '../src/workspace.ts';
import { makeTools } from '../src/mcp/tools.ts';
import { Geometry } from '../src/core/geometry.ts';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polyforge-engine-'));

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
  // a var named "frame" shadows the time identifier: no time dependence
  const gv: GraphSpec = { ...g, vars: { frame: 2 }, output: 'shadow' };
  const s1 = await cook(gv, { frame: 1 }, e);
  const s9 = await cook(gv, { frame: 9 }, e);
  check(!res(s9, 'shadow').timeDependent && res(s9, 'shadow').sig === res(s1, 'shadow').sig && near(bboxOf(s9.geo).min[1], 1.5), 'a graph var named frame shadows time');
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

  e.registerAsset('test_bob', { vars: { amp: 1 }, nodes: { i: { type: 'input' }, w: { type: 'wrangle', in: ['i'], params: { code: '@P.y += @Frame * vars.amp;' } } }, output: 'w' });
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
              w: { type: 'wrangle', in: ['prev'], params: { run_over: 'detail', code: 'f@runs = (@runs || 0) + 1; f@f = @Frame; f@dt = @TimeInc; f@it = iteration; f@sub = vars.substep;' } },
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

// ------------------------------------------------------------------ versioning and deprecation
section('graph versioning');
{
  const m = migrateGraphDetailed({ nodes: { b: { type: 'box' } } });
  check(m.graph.version === GRAPH_VERSION && GRAPH_VERSION === 1 && m.applied.length === 1 && /v0 → v1/.test(m.applied[0]), 'unversioned graph migrates 0 → 1 and is stamped');
  const same = { version: 1, nodes: {} } as GraphSpec;
  check(migrateGraph(same) === same, 'current-version graph is returned unchanged');
  const newer = migrateGraphDetailed({ version: 99, nodes: { b: { type: 'box' } } });
  check(newer.graph.version === 99 && /newer than this engine/.test(newer.notes[0] ?? ''), 'newer graph versions are cooked as is, with a note');
  const badV = await engine.cook({ version: -1 as any, nodes: { b: { type: 'box' } } });
  check(badV.ok && badV.notes.some((n) => /non-negative integer/.test(n)), 'invalid version: note, treated as current');

  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsDir, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'graphs', 'old.json'), JSON.stringify({ nodes: { b: { type: 'box' } } }));
  const ws = new Workspace(wsDir, await newEngine());
  ws.load();
  check(ws.getGraph('old').version === 1, 'workspace load migrates graphs');
  ws.setGraph('fresh', { nodes: { b: { type: 'box' } } });
  const saved = JSON.parse(fs.readFileSync(path.join(wsDir, 'graphs', 'fresh.json'), 'utf8'));
  check(saved.version === 1, 'workspace save writes the version');

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

console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
