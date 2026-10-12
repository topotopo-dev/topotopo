// Flow control: merge, switch, null, subgraph inputs, for-each loops, graph references, file import.
import { Geometry } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { connectivity } from '../core/topology.ts';
import { stableStringify } from '../graph/engine.ts';
import { hashString } from '../core/random.ts';
import { importGeometry } from '../io/import.ts';
import { fusePoints } from './transform.ts';

defineNode({
  type: 'merge',
  category: 'flow',
  summary: 'Combine any number of inputs into one geometry (attributes and groups are unioned).',
  aliases: ['combine', 'join'],
  inputs: [{ name: 'inputs', desc: 'any number of geometries', multi: true }],
  params: {},
  cook: ({ inputs }) => Geometry.merge(inputs.filter((g): g is Geometry => !!g)),
});

defineNode({
  type: 'switch',
  category: 'flow',
  summary: 'Pass through one of several inputs by index (use "=expr" to drive it from vars).',
  inputs: [{ name: 'inputs', desc: 'candidate geometries', multi: true }],
  params: { index: { type: 'int', default: 0, desc: 'which input to output (clamped)', aliases: ['input'] } },
  cook: ({ inputs, p }) => {
    if (!inputs.length) return new Geometry();
    const i = Math.max(0, Math.min(inputs.length - 1, p.index));
    return inputs[i] ?? new Geometry();
  },
});

defineNode({
  type: 'null',
  category: 'flow',
  summary: 'Pass-through. Use as a named output/marker (e.g. "OUT").',
  aliases: ['output', 'out', 'passthrough'],
  inputs: [{ name: 'geo', desc: 'geometry', optional: true }],
  params: {},
  cook: ({ input }) => input(0),
});

defineNode({
  type: 'input',
  category: 'flow',
  summary: 'Inside a subgraph (foreach body or asset): receives the parent input with this index.',
  aliases: ['subnet_input', 'loop_input'],
  inputs: [],
  params: {
    index: { type: 'int', default: 0, min: 0, desc: 'foreach: 0 = current piece/feedback, 1 = whole input, 2 = foreach second input. assets: input number' },
    label: { type: 'string', default: '', desc: 'documentation label for asset inputs' },
  },
  cook: () => new Geometry(), // provided by the engine
});

defineNode({
  type: 'foreach',
  category: 'flow',
  summary: 'Loop a subgraph over connected pieces, attribute values, points, prims, or N times (with optional feedback).',
  aliases: ['for_each', 'loop', 'foreach_piece', 'for_loop'],
  description:
    'The body is a nested graph. Inside it, an {"type":"input","params":{"index":0}} node yields the current piece ' +
    '(or the previous iteration\'s result in feedback mode); index 1 yields the whole input; index 2 the foreach\'s second input. ' +
    'Vars available to "=expr" params and code: iteration, numiterations, value (piece attribute value / element number), ' +
    'attr (object of the element\'s attributes, e.g. attr.height), plus all parent vars.',
  inputs: [
    { name: 'geo', desc: 'geometry to iterate over (optional for count mode)', optional: true },
    { name: 'extra', desc: 'available inside the body as input index 2', optional: true },
  ],
  params: {
    mode: { type: 'enum', options: ['pieces', 'count', 'points', 'prims'], default: 'pieces', desc: 'pieces = by piece_attrib (or connectivity); count = N iterations; points/prims = one element each' },
    piece_attrib: { type: 'string', default: '', desc: 'pieces: prim attribute to group by ("" = connectivity)' },
    count: { type: 'int', default: 4, min: 0, desc: 'count mode: iterations' },
    feedback: { type: 'bool', default: false, desc: 'count mode: feed each result into the next iteration (output = last)' },
    body: { type: 'graph', desc: 'subgraph {nodes, output} run per iteration' },
    max_iterations: { type: 'int', default: 10000, min: 1, desc: 'safety limit' },
  },
  example: {
    type: 'foreach',
    in: ['pieces'],
    params: {
      mode: 'pieces',
      body: {
        nodes: {
          piece: { type: 'input', params: { index: 0 } },
          lift: { type: 'transform', in: ['piece'], params: { translate: [0, '=iteration * 0.2', 0] } },
        },
        output: 'lift',
      },
    },
  },
  async cook(ctx) {
    const { p, engine } = ctx;
    if (!p.body || !p.body.nodes) throw new NodeError('foreach needs a "body" graph: {"nodes": {...}, "output": "..."}');
    const src = ctx.input(0), extra = ctx.input(1);
    const items: { geo: Geometry; value: any; attr: Record<string, any> }[] = [];
    const attrsOf = (g: Geometry, cls: 'point' | 'prim', i: number) => {
      const o: Record<string, any> = {};
      for (const [k, a] of g.table(cls).map) o[k] = a.get(i);
      return o;
    };
    if (p.mode === 'count') {
      for (let i = 0; i < p.count; i++) items.push({ geo: src, value: i, attr: {} });
    } else if (p.mode === 'points') {
      for (let i = 0; i < src.numPoints; i++) {
        const m = new Uint8Array(src.numPoints); m[i] = 1;
        const one = src.subsetPoints(m);
        one.primStart = new Int32Array(1); one.vertexPoint = new Int32Array(0); one.primClosed = new Uint8Array(0);
        one.prims = one.prims.gather([]); one.vertices = one.vertices.gather([]); one.primGroups = new Map(); one.vertexGroups = new Map(); one.edgeGroups = new Map();
        items.push({ geo: one, value: i, attr: attrsOf(src, 'point', i) });
      }
    } else if (p.mode === 'prims') {
      for (let i = 0; i < src.numPrims; i++) {
        const m = new Uint8Array(src.numPrims); m[i] = 1;
        items.push({ geo: src.subsetPrims(m), value: i, attr: attrsOf(src, 'prim', i) });
      }
    } else {
      let key: Int32Array | any[];
      if (p.piece_attrib) {
        const a = src.prims.get(p.piece_attrib);
        if (!a) throw new NodeError(`piece_attrib "${p.piece_attrib}" is not a prim attribute (prim attributes: ${src.prims.names().join(', ') || 'none'})`);
        key = Array.from({ length: src.numPrims }, (_, i) => a.get(i));
      } else key = connectivity(src).primClass;
      const order: any[] = [];
      const groups = new Map<string, number[]>();
      for (let i = 0; i < src.numPrims; i++) {
        const k = JSON.stringify(key[i]);
        if (!groups.has(k)) { groups.set(k, []); order.push(key[i]); }
        groups.get(k)!.push(i);
      }
      for (const v of order) {
        const m = new Uint8Array(src.numPrims);
        for (const i of groups.get(JSON.stringify(v))!) m[i] = 1;
        const piece = src.subsetPrims(m);
        items.push({ geo: piece, value: v, attr: piece.numPrims ? attrsOf(piece, 'prim', 0) : {} });
      }
    }
    if (items.length > p.max_iterations) throw new NodeError(`foreach: ${items.length} iterations exceeds max_iterations (${p.max_iterations})`);
    const outs: Geometry[] = [];
    let prev: { geo: Geometry; sig: string } = { geo: src, sig: ctx.inputSigs[0] ?? 'none' };
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const pieceSig = p.mode === 'count' ? (p.feedback ? prev.sig : ctx.inputSigs[0] ?? 'none') : `${ctx.inputSigs[0]}:${p.mode}:${p.piece_attrib}:${i}`;
      const r = await engine.cook(p.body, {
        vars: { ...ctx.vars, iteration: i, numiterations: items.length, value: it.value, attr: it.attr },
        inputs: [
          { geo: p.feedback ? prev.geo : it.geo, sig: pieceSig },
          { geo: src, sig: ctx.inputSigs[0] ?? 'none' },
          { geo: extra, sig: ctx.inputSigs[1] ?? 'none' },
        ],
        depth: ctx.depth + 1,
      });
      if (!r.ok || !r.geo) throw new NodeError(`foreach iteration ${i}: ${r.errors.map((e) => `${e.node}: ${e.message}`).join('; ')}`);
      for (const w of r.warnings.slice(0, 3)) ctx.warn(`[iter ${i}] ${w.node}: ${w.message}`);
      if (p.feedback) prev = { geo: r.geo, sig: r.results.get(r.target)?.sig ?? `fb${i}` };
      else outs.push(r.geo);
    }
    return p.feedback ? prev.geo : Geometry.merge(outs);
  },
});

defineNode({
  type: 'graph_ref',
  category: 'flow',
  summary: 'Use the output (or any node) of another graph in the workspace — compose scenes from separate graphs.',
  aliases: ['object_merge', 'reference', 'ref'],
  inputs: [],
  params: {
    graph: { type: 'string', default: '', desc: 'workspace graph name' },
    node: { type: 'string', default: '', desc: 'node in that graph ("" = its output)' },
    vars: { type: 'json', default: {}, desc: 'override that graph\'s vars' },
  },
  signatureExtra: (p, engine) => {
    const g = (engine as any).graphResolver?.(p.graph);
    return g ? String(hashString(stableStringify(g))) : 'missing';
  },
  async cook({ p, engine, depth }) {
    const resolver = (engine as any).graphResolver as ((n: string) => any) | undefined;
    if (!resolver) throw new NodeError('graph_ref needs a workspace (not available in this host)');
    const g = resolver(p.graph);
    if (!g) throw new NodeError(`no graph named "${p.graph}" in the workspace`);
    const r = await engine.cook(g, { target: p.node || undefined, vars: p.vars, depth: depth + 1 });
    if (!r.ok || !r.geo) throw new NodeError(`graph "${p.graph}" failed: ${r.errors.map((e) => `${e.node}: ${e.message}`).join('; ')}`);
    return r.geo;
  },
});

defineNode({
  type: 'file',
  category: 'io',
  summary: 'Load geometry from disk/URL: OBJ, STL, PLY, glTF/GLB, or polyforge JSON. Z-up files can be converted.',
  aliases: ['import', 'load', 'read'],
  inputs: [],
  params: {
    path: { type: 'path', default: '', desc: 'file path (relative to the workspace) or URL', aliases: ['file', 'filename'] },
    format: { type: 'enum', options: ['auto', 'obj', 'stl', 'ply', 'glb', 'gltf', 'json'], default: 'auto', desc: 'file format (auto = by extension)' },
    up_axis: { type: 'enum', options: ['y', 'z'], default: 'y', desc: 'source up axis; z converts Z-up files (Blender/Unreal exports) to Y-up' },
    scale: { type: 'float', default: 1, desc: 'uniform scale (e.g. 0.01 for centimetres → metres)' },
    weld: { type: 'bool', default: false, desc: 'fuse coincident points (glTF/STL meshes are split at seams; weld before booleans)' },
  },
  signatureExtra: (p, engine) => engine.host.fileStamp(p.path),
  async cook({ p, engine }) {
    if (!p.path) throw new NodeError('path is empty');
    const bytes = await engine.host.readFile(p.path).catch((e: any) => { throw new NodeError(`cannot read "${p.path}": ${e.message}`); });
    const fmt = p.format === 'auto' ? (String(p.path).split('?')[0].split('.').pop() ?? '').toLowerCase() : p.format;
    const g = importGeometry(bytes, fmt);
    if (p.up_axis === 'z' || p.scale !== 1) {
      const P = g.P;
      for (let i = 0; i < P.length; i += 3) {
        let x = P[i], y = P[i + 1], z = P[i + 2];
        if (p.up_axis === 'z') [x, y, z] = [x, z, -y];
        P[i] = x * p.scale; P[i + 1] = y * p.scale; P[i + 2] = z * p.scale;
      }
      const N = g.points.get('N') ?? g.vertices.get('N');
      if (N && p.up_axis === 'z') {
        const d = N.data as Float64Array;
        for (let i = 0; i < d.length; i += 3) { const y = d[i + 1]; d[i + 1] = d[i + 2]; d[i + 2] = -y; }
      }
    }
    if (p.weld) {
      const b = g.bbox();
      const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;
      return fusePoints(g, diag * 1e-7);
    }
    return g;
  },
});
