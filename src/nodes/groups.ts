// Group tooling: promote between classes, expand/shrink, combine, delete, rename.
import { Geometry, GROUP_CLASSES } from '../core/geometry.ts';
import type { GroupClass } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { EdgeSet, edgeKey, edgeList, maskToEdgeSet } from '../core/edges.ts';
import type { EdgeList } from '../core/edges.ts';
import { convertSelection } from '../core/groupconvert.ts';
import { evalGroup, GroupError } from '../core/groups.ts';

const CLASS4 = ['point', 'vertex', 'prim', 'edge'];

/** Name matcher: space/comma separated globs, "^name" excludes. */
function nameMatcher(pattern: string) {
  const parts = String(pattern).split(/[\s,]+/).filter(Boolean);
  const re = (p: string) => new RegExp('^' + p.replace(/[.+$()|[\]\\{}]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  const pos = parts.filter((p) => !p.startsWith('^')).map(re);
  const neg = parts.filter((p) => p.startsWith('^')).map((p) => re(p.slice(1)));
  return (name: string) => pos.some((r) => r.test(name)) && !neg.some((r) => r.test(name));
}

function available(g: Geometry, classes: readonly GroupClass[] = GROUP_CLASSES): string {
  const all = classes.flatMap((c) => g.groupNames(c).map((k) => `${c}:${k}`));
  return all.length ? all.join(', ') : '(none)';
}

function getGroup(g: Geometry, cls: GroupClass, name: string): Uint8Array | EdgeSet | undefined {
  return cls === 'edge' ? g.edgeGroups.get(name) : g.groups(cls).get(name);
}

function setGroup(g: Geometry, cls: GroupClass, name: string, sel: Uint8Array | EdgeSet) {
  if (cls === 'edge') g.addEdgeGroup(name, sel as EdgeSet);
  else g.addGroup(cls, name, sel as Uint8Array);
}

function deleteGroup(g: Geometry, cls: GroupClass, name: string) {
  if (cls === 'edge') g.edgeGroups.delete(name);
  else g.groups(cls).delete(name);
}

defineNode({
  type: 'group_promote',
  category: 'group',
  packed: 'keep',
  summary: 'Convert groups between point, vertex, prim and edge classes, with any/all inclusion (Houdini Group Promote).',
  description:
    'An element of the target class joins when any (or all) of the source-class elements touching it are in the group. ' +
    'Touching: a prim touches its points, vertices and sides; an edge touches its two points; a vertex touches its point, ' +
    'its prim and the two sides it bounds. Examples: point→prim any = prims with a selected point, all = prims entirely in ' +
    'the group; prim→point = all their points; prim→edge = all their sides; edge→point = endpoints; edge→prim any = prims ' +
    'using a grouped edge, all = prims whose every side is grouped; point→edge all = edges with both points selected.',
  aliases: ['grouppromote', 'promote_group', 'group_convert', 'groupconvert'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    group: { type: 'string', default: '', desc: 'source group name(s); wildcards and several names allowed ("top", "side* rim")', aliases: ['groups', 'group_name'] },
    from: { type: 'enum', options: CLASS4, default: 'point', desc: 'class of the source group', aliases: ['fromtype', 'from_class', 'in_class'] },
    to: { type: 'enum', options: CLASS4, default: 'prim', desc: 'class to convert to', aliases: ['totype', 'to_class', 'out_class'] },
    include: { type: 'enum', options: ['any', 'all'], default: 'any', desc: 'any = touched by at least one grouped element; all = every touching element is grouped (Houdini "include only elements entirely contained")' },
    new_name: { type: 'string', default: '', desc: 'name of the converted group ("" = keep the name; several matched groups are unioned into it)', aliases: ['output', 'newname'] },
    delete_source: { type: 'bool', default: true, desc: 'remove the source group after converting' },
  },
  example: {
    nodes: {
      box: { type: 'box', params: { divisions: [2, 2, 2] } },
      top: { type: 'group', in: ['box'], params: { name: 'top', class: 'point', expr: '@P.y > 0.4' } },
      faces: { type: 'group_promote', in: ['top'], params: { group: 'top', from: 'point', to: 'prim', include: 'all' } },
    },
    output: 'faces',
  },
  cook: ({ input, p, warn }) => {
    const g = input(0).clone();
    const from = p.from as GroupClass, to = p.to as GroupClass;
    if (!String(p.group).trim()) { warn(`"group" is empty: nothing to convert (groups: ${available(g)})`); return g; }
    const match = nameMatcher(p.group);
    const names = g.groupNames(from).filter(match);
    if (!names.length) throw new NodeError(`group_promote: no ${from} group matches "${p.group}"`, `groups: ${available(g)}`);
    const list = from === 'edge' || to === 'edge' ? edgeList(g) : undefined;
    const results: [string, Uint8Array | EdgeSet][] = names.map((name) => [p.new_name || name, convertSelection(g, from, to, getGroup(g, from, name)!, p.include, list)]);
    if (p.delete_source) for (const name of names) deleteGroup(g, from, name);
    const merged = new Map<string, Uint8Array | EdgeSet>();
    for (const [name, sel] of results) {
      const prev = merged.get(name);
      if (!prev) merged.set(name, sel);
      else if (prev instanceof EdgeSet) merged.set(name, prev.union(sel as EdgeSet));
      else merged.set(name, prev.map((x, i) => x | (sel as Uint8Array)[i]));
    }
    for (const [name, sel] of merged) setGroup(g, to, name, sel);
    return g;
  },
});

/**
 * Connector lists for expand/shrink: elements are neighbours when they share a connector
 * (points share edges, prims share edges or points, edges share points). CSR over connectors.
 */
function connectors(g: Geometry, cls: 'point' | 'prim' | 'edge', via: 'edge' | 'point', list: EdgeList): { start: Int32Array; items: Int32Array } {
  const pairs: number[] = []; // connector, element
  let nc = 0;
  if (cls === 'point') {
    nc = list.count;
    for (let i = 0; i < list.count; i++) pairs.push(i, list.a[i], i, list.b[i]);
  } else if (cls === 'edge') {
    nc = g.numPoints;
    for (let i = 0; i < list.count; i++) pairs.push(list.a[i], i, list.b[i], i);
  } else if (via === 'point') {
    nc = g.numPoints;
    for (let pr = 0; pr < g.numPrims; pr++) for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) pairs.push(g.vertexPoint[v], pr);
  } else {
    nc = list.count;
    for (let pr = 0; pr < g.numPrims; pr++) {
      const s = g.primStart[pr], e = g.primStart[pr + 1];
      const last = g.primClosed[pr] ? e : e - 1;
      for (let v = s; v < last; v++) {
        const a = g.vertexPoint[v], b = g.vertexPoint[v + 1 < e ? v + 1 : s];
        if (a === b) continue;
        const ei = list.index.get(edgeKey(a, b));
        if (ei !== undefined) pairs.push(ei, pr);
      }
    }
  }
  const start = new Int32Array(nc + 1);
  for (let k = 0; k < pairs.length; k += 2) start[pairs[k] + 1]++;
  for (let c = 0; c < nc; c++) start[c + 1] += start[c];
  const items = new Int32Array(pairs.length / 2), fill = start.slice(0, nc);
  for (let k = 0; k < pairs.length; k += 2) items[fill[pairs[k]]++] = pairs[k + 1];
  return { start, items };
}

defineNode({
  type: 'group_expand',
  category: 'group',
  packed: 'keep',
  summary: 'Grow or shrink a point, prim or edge group by N steps across connectivity (negative steps shrink).',
  description:
    'Grow adds every neighbour of the group per step; shrink removes every member that has a neighbour outside the group. ' +
    'Neighbours: points share an edge; prims share an edge (or a point, connectivity = point); edges share a point.',
  aliases: ['groupexpand', 'grow_group', 'groupgrow', 'shrink_group'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    group: { type: 'string', default: '', desc: 'group to expand (name); a group pattern also works when new_name is set', aliases: ['name', 'base_group'] },
    class: { type: 'enum', options: ['prim', 'point', 'edge'], default: 'prim', desc: 'element class of the group' },
    steps: { type: 'int', default: 1, min: -100000, max: 100000, desc: 'steps to grow (negative = shrink)', aliases: ['iterations', 'amount', 'numsteps'] },
    connectivity: { type: 'enum', options: ['edge', 'point'], default: 'edge', desc: 'prim class: neighbours share an edge or only a point' },
    new_name: { type: 'string', default: '', desc: 'output group ("" = overwrite the input group)', aliases: ['output', 'newname'] },
  },
  example: {
    nodes: {
      ball: { type: 'sphere', params: { type: 'quad' } },
      top: { type: 'group', in: ['ball'], params: { name: 'top', normal: [0, 1, 0], spread_angle: 15 } },
      grown: { type: 'group_expand', in: ['top'], params: { group: 'top', class: 'prim', steps: 2 } },
    },
    output: 'grown',
  },
  cook: ({ input, p, warn }) => {
    const g = input(0).clone();
    const cls = p.class as 'point' | 'prim' | 'edge';
    const name = String(p.group).trim();
    if (!name) { warn(`"group" is empty: nothing to expand (groups: ${available(g)})`); return g; }
    const out = p.new_name || name;
    if (!p.new_name && !/^[\w.]+$/.test(name)) throw new NodeError(`group_expand: "${name}" is a pattern, not a group name; set new_name`);
    const list = edgeList(g);
    let sel: Uint8Array;
    try {
      sel = evalGroup(g, cls, name, list) ?? new Uint8Array(cls === 'point' ? g.numPoints : cls === 'prim' ? g.numPrims : list.count).fill(1);
    } catch (e: any) {
      if (e instanceof GroupError) throw new NodeError(`group_expand: ${e.message}`);
      throw e;
    }
    const { start, items } = connectors(g, cls, p.connectivity, list);
    const nc = start.length - 1;
    const grow = p.steps > 0, to = grow ? 1 : 0;
    // a step that changes nothing ends the expansion (the rest would change nothing either)
    for (let s = 0; s < Math.abs(p.steps); s++) {
      const next = sel.slice();
      let changed = false;
      for (let c = 0; c < nc; c++) {
        let touch = false;
        for (let k = start[c]; k < start[c + 1]; k++) if (grow ? sel[items[k]] : !sel[items[k]]) { touch = true; break; }
        if (touch) for (let k = start[c]; k < start[c + 1]; k++) if (next[items[k]] !== to) { next[items[k]] = to; changed = true; }
      }
      sel = next;
      if (!changed) break;
    }
    if (cls === 'edge') g.addEdgeGroup(out, maskToEdgeSet(list, sel));
    else g.addGroup(cls, out, sel);
    return g;
  },
});

defineNode({
  type: 'group_delete',
  category: 'group',
  packed: 'keep',
  summary: 'Delete groups by name (wildcards, "^name" keeps) from one or all classes.',
  aliases: ['groupdelete', 'delete_group', 'remove_group'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    groups: { type: 'string', default: '', desc: 'names to delete: "tmp*", "a b c", "* ^keep"', aliases: ['group', 'names', 'pattern'] },
    class: { type: 'enum', options: ['all', ...CLASS4], default: 'all', desc: 'which classes' },
  },
  example: {
    nodes: {
      box: { type: 'box' },
      tmp: { type: 'group', in: ['box'], params: { name: 'tmp_top', normal: [0, 1, 0] } },
      clean: { type: 'group_delete', in: ['tmp'], params: { groups: 'tmp*' } },
    },
    output: 'clean',
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const match = nameMatcher(p.groups);
    for (const c of GROUP_CLASSES) {
      if (p.class !== 'all' && p.class !== c) continue;
      for (const k of g.groupNames(c)) if (match(k)) deleteGroup(g, c, k);
    }
    return g;
  },
});

defineNode({
  type: 'group_rename',
  category: 'group',
  packed: 'keep',
  summary: 'Rename a group (any class).',
  aliases: ['grouprename', 'rename_group'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    from: { type: 'string', default: '', desc: 'existing group name' },
    to: { type: 'string', default: '', desc: 'new name (replaces a same-named group of that class)' },
    class: { type: 'enum', options: ['auto', ...CLASS4], default: 'auto', desc: 'class (auto = first class that has the group: point, vertex, prim, edge)' },
  },
  example: {
    nodes: {
      box: { type: 'box' },
      top: { type: 'group', in: ['box'], params: { name: 'top', normal: [0, 1, 0] } },
      roof: { type: 'group_rename', in: ['top'], params: { from: 'top', to: 'roof' } },
    },
    output: 'roof',
  },
  cook: ({ input, p, warn }) => {
    const g = input(0).clone();
    if (!p.from && !p.to) { warn(`"from"/"to" are empty: nothing renamed (groups: ${available(g)})`); return g; }
    if (!p.to) throw new NodeError('group_rename: "to" is empty');
    const classes = p.class === 'auto' ? GROUP_CLASSES : [p.class as GroupClass];
    for (const c of classes) {
      const grp = getGroup(g, c, p.from);
      if (!grp) continue;
      deleteGroup(g, c, p.from);
      setGroup(g, c, p.to, grp);
      return g;
    }
    throw new NodeError(`group_rename: no ${p.class === 'auto' ? '' : p.class + ' '}group "${p.from}"`, `groups: ${available(g)}`);
  },
});

// ---------------------------------------------------------------- group_combine

type Tok = { op: string } | { name: string };

function lexCombine(expr: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if ('&|^()'.includes(c) || (c === '!' && expr[i + 1] !== '=')) { out.push({ op: c }); i++; continue; }
    let j = i;
    // an operand runs to the next space or operator; "!=" inside an attribute test stays in the operand
    while (j < expr.length && !/\s/.test(expr[j]) && !'&|^()'.includes(expr[j]) && !(expr[j] === '!' && expr[j + 1] !== '=')) j++;
    // re-join "@attr op value" written with spaces (e.g. "@P.y > 0")
    let name = expr.slice(i, j);
    let k = j;
    while (k < expr.length && /\s/.test(expr[k])) k++;
    const opm = /^(==|!=|>=|<=|=|>|<)/.exec(expr.slice(k));
    if (name.startsWith('@') && !/(==|!=|>=|<=|=|>|<)/.test(name) && opm) {
      k += opm[0].length;
      while (k < expr.length && /\s/.test(expr[k])) k++;
      let m = k;
      while (m < expr.length && !/\s/.test(expr[m]) && !'&|^()'.includes(expr[m])) m++;
      name += opm[0] + expr.slice(k, m);
      j = m;
    }
    out.push({ name });
    i = j;
  }
  return out;
}

/** Parse and evaluate a group boolean expression: | union, & intersect, ^ xor, ! not, ( ), juxtaposition = union. */
function evalCombine(expr: string, operand: (name: string) => Uint8Array, n: number): Uint8Array {
  const toks = lexCombine(expr);
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (t: Tok | undefined, op: string) => !!t && 'op' in t && t.op === op;
  const fail = (msg: string) => new NodeError(`group_combine: ${msg} in "${expr}"`, 'operators: | (or), & (and), ^ (xor), ! (not), parentheses; operands are group names or group-pattern tokens');
  const startsUnary = (t: Tok | undefined) => !!t && ('name' in t || t.op === '!' || t.op === '(');
  function unary(): Uint8Array {
    const t = peek();
    if (!t) throw fail('unexpected end');
    if (isOp(t, '!')) { pos++; return unary().map((x) => (x ? 0 : 1)); }
    if (isOp(t, '(')) {
      pos++;
      const v = orExpr();
      if (!isOp(peek(), ')')) throw fail('missing ")"');
      pos++;
      return v;
    }
    if ('name' in t) { pos++; return operand(t.name); }
    throw fail(`unexpected "${t.op}"`);
  }
  function andExpr(): Uint8Array {
    let v = unary();
    while (isOp(peek(), '&')) { pos++; const r = unary(); v = v.map((x, i) => x & r[i]); }
    return v;
  }
  function xorExpr(): Uint8Array {
    let v = andExpr();
    while (isOp(peek(), '^')) { pos++; const r = andExpr(); v = v.map((x, i) => x ^ r[i]); }
    return v;
  }
  function orExpr(): Uint8Array {
    let v = xorExpr();
    for (;;) {
      if (isOp(peek(), '|')) pos++;
      else if (!startsUnary(peek())) break;
      const r = xorExpr();
      v = v.map((x, i) => x | r[i]);
    }
    return v;
  }
  if (!toks.length) throw fail('empty expression');
  const v = orExpr();
  if (pos < toks.length) throw fail(`unexpected "${'op' in toks[pos] ? (toks[pos] as any).op : (toks[pos] as any).name}"`);
  if (v.length !== n) throw fail('size mismatch');
  return v;
}

defineNode({
  type: 'group_combine',
  category: 'group',
  packed: 'keep',
  summary: 'Boolean combination of groups into a new group: "a & !b | c" (| or, & and, ^ xor, ! not, parentheses).',
  description:
    'Operands are group names (wildcards allowed) or any single group-pattern token of the class, e.g. "@P.y>0", "0-10", ' +
    '"boundary" or "angle>30" for edges; a group of another class is converted like in patterns. Precedence: ! then & then ^ then |; ' +
    'operands written next to each other are unioned.',
  aliases: ['groupcombine', 'combine_groups', 'group_bool', 'groupbool'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    name: { type: 'string', default: 'combined', desc: 'output group name (replaces an existing group of that class)', aliases: ['output'] },
    class: { type: 'enum', options: ['prim', 'point', 'vertex', 'edge'], default: 'prim', desc: 'element class' },
    expr: { type: 'string', default: '', desc: 'boolean expression, e.g. "top & !side*", "(a | b) & @P.y>0", "boundary ^ seams"', aliases: ['expression', 'pattern'] },
  },
  example: {
    nodes: {
      box: { type: 'box', params: { divisions: [3, 3, 3] } },
      upper: { type: 'group', in: ['box'], params: { name: 'upper', expr: '@P.y > 0' } },
      top: { type: 'group', in: ['upper'], params: { name: 'top', normal: [0, 1, 0] } },
      walls: { type: 'group_combine', in: ['top'], params: { name: 'upper_walls', class: 'prim', expr: 'upper & !top' } },
    },
    output: 'walls',
  },
  cook: ({ input, p, warn }) => {
    const g = input(0).clone();
    if (!String(p.expr).trim()) { warn(`"expr" is empty: no group created (groups: ${available(g)})`); return g; }
    const cls = p.class as GroupClass;
    const list = cls === 'edge' ? edgeList(g) : undefined;
    const n = cls === 'edge' ? list!.count : g.count(cls);
    const operand = (name: string) => {
      try {
        return evalGroup(g, cls, name, list) ?? new Uint8Array(n).fill(1);
      } catch (e: any) {
        if (e instanceof GroupError) throw new NodeError(`group_combine: ${e.message}`);
        throw e;
      }
    };
    const sel = evalCombine(String(p.expr), operand, n);
    if (cls === 'edge') g.addEdgeGroup(p.name, maskToEdgeSet(list!, sel));
    else g.addGroup(cls, p.name, sel);
    return g;
  },
});
