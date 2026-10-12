// Wrangle: per-element JavaScript with VEX-style @attribute syntax.
//
//   @P.y += noise(@P) * 0.2;          // read/modify point position
//   @Cd = hsv2rgb(rand(@ptnum), 0.6, 1);
//   f@height = @P.y;                  // typed creation: f i v p u s prefixes
//   i[]@nbrs = nearpoints(0, @P, 0.5); // array attributes: f[] i[] s[] (read = copy, written back)
//   if (@P.y < 0) removepoint(0, @ptnum);
//   @group_top = @N.y > 0.9;          // group membership
//
// The snippet is compiled into a kernel that loops over elements, binding each
// referenced attribute to a local variable and writing it back afterwards.
import { Attribute, Geometry, defaultValueFor, isArrayType } from './geometry.ts';
import type { AttribClass, AttribType } from './geometry.ts';
import { primCentroid, primNormals, pointNeighbors, pointPrims } from './topology.ts';
import { KDTree, TriBVH } from './spatial.ts';
import type { Host } from '../host/types.ts';

export type RunOver = 'points' | 'prims' | 'vertices' | 'detail';

const CLASS_OF: Record<RunOver, AttribClass> = { points: 'point', prims: 'prim', vertices: 'vertex', detail: 'detail' };

const PREFIX_TYPE: Record<string, { type: AttribType; size: number }> = {
  f: { type: 'float', size: 1 }, i: { type: 'int', size: 1 }, v: { type: 'float', size: 3 },
  p: { type: 'float', size: 4 }, u: { type: 'float', size: 2 }, s: { type: 'string', size: 1 },
  // array attributes (variable length per element)
  'f[]': { type: 'float[]', size: 1 }, 'i[]': { type: 'int[]', size: 1 }, 's[]': { type: 'string[]', size: 1 },
};

const KNOWN: Record<string, { type: AttribType; size: number }> = {
  P: { type: 'float', size: 3 }, N: { type: 'float', size: 3 }, Cd: { type: 'float', size: 3 },
  v: { type: 'float', size: 3 }, up: { type: 'float', size: 3 }, rest: { type: 'float', size: 3 },
  scale: { type: 'float', size: 3 }, force: { type: 'float', size: 3 }, uv: { type: 'float', size: 3 },
  orient: { type: 'float', size: 4 }, rot: { type: 'float', size: 4 },
  pscale: { type: 'float', size: 1 }, Alpha: { type: 'float', size: 1 }, width: { type: 'float', size: 1 },
  density: { type: 'float', size: 1 }, mass: { type: 'float', size: 1 }, curveu: { type: 'float', size: 1 },
  id: { type: 'int', size: 1 }, class: { type: 'int', size: 1 }, piece: { type: 'int', size: 1 },
  variant: { type: 'int', size: 1 }, copynum: { type: 'int', size: 1 },
  name: { type: 'string', size: 1 }, path: { type: 'string', size: 1 }, material: { type: 'string', size: 1 },
};

const SPECIAL = new Set(['ptnum', 'primnum', 'vtxnum', 'elemnum', 'numpt', 'numprim', 'numvtx', 'numelem', 'Frame', 'Time', 'TimeInc']);
const TIME_REFS = ['Frame', 'Time', 'TimeInc'];

const REF = /(?<![\w$.@])([fivpus](?:\[\])?)?@([A-Za-z_][A-Za-z0-9_]*)/g;

interface Binding {
  name: string;
  local: string;
  /** 'array': an array attribute; data is the Attribute (read with getArray, written with set) */
  kind: 'attr' | 'new' | 'group' | 'centroid' | 'primN' | 'input' | 'array';
  cls: AttribClass;
  /** how to index the data: element, point-of-vertex, or 0 (detail) */
  index: 'elem' | 'vpoint' | 'zero';
  size: number;
  type: AttribType | 'any';
  readonly: boolean;
  data?: any;
}

export interface WrangleResult { geo: Geometry; log: string[] }

const kernelCache = new Map<string, any>();

/** Rewrite @refs to locals and collect what is referenced. */
export function scanRefs(code: string) {
  const refs = new Map<string, string | undefined>(); // name -> prefix
  const assigned = new Set<string>();
  for (const m of code.matchAll(REF)) {
    const [, prefix, name] = m;
    if (!refs.has(name) || prefix) refs.set(name, prefix ?? refs.get(name));
    const after = code.slice((m.index ?? 0) + m[0].length);
    if (/^\s*(=(?!=)|\+=|-=|\*=|\/=|%=|\+\+|--|\.[xyzwrgbauv]\s*(=(?!=)|\+=|-=|\*=|\/=)|\[\d\]\s*(=(?!=)|\+=|-=|\*=|\/=))/.test(after))
      assigned.add(name);
  }
  return { refs, assigned };
}

/** Does the snippet read @Frame, @Time or @TimeInc? (Only then is a wrangle time-dependent.) */
export function referencesTime(code: string): boolean {
  const { refs } = scanRefs(code);
  return TIME_REFS.some((k) => refs.has(k));
}

export interface WrangleTime { frame: number; time: number; timeInc: number }

export function runWrangle(
  geo: Geometry,
  opts: {
    code: string; runOver: RunOver; mask: Uint8Array | null; inputs: Geometry[]; vars: Record<string, any>; host: Host; timeoutMs: number;
    /** values of @Frame @Time @TimeInc (pass them only when referencesTime(code), so other wrangles stay time-independent) */
    time?: WrangleTime;
  },
): WrangleResult {
  const g = geo; // caller passes a clone we may mutate
  const runOver = opts.runOver;
  const cls = CLASS_OF[runOver];
  const n = runOver === 'points' ? g.numPoints : runOver === 'prims' ? g.numPrims : runOver === 'vertices' ? g.numVertices : 1;
  const { refs, assigned } = scanRefs(opts.code);
  const bindings: Binding[] = [];
  const log: string[] = [];
  const vprim = runOver === 'vertices' ? g.vertexPrims() : null;

  for (const [name, prefix] of refs) {
    if (SPECIAL.has(name)) continue;
    if (prefix && !PREFIX_TYPE[prefix]) throw new Error(`${prefix}@${name}: vector arrays are not supported; use f[]@${name} with flattened components (or several f[] attributes)`);
    const local = '__a_' + name;
    const ro = (why: string) => {
      if (assigned.has(name)) log.push(`warning: @${name} is ${why}; assignment ignored`);
    };
    // @opinputN_name
    const op = /^opinput(\d)_(\w+)$/.exec(name);
    if (op) {
      const inp = opts.inputs[+op[1]];
      if (!inp) throw new Error(`@${name}: input ${op[1]} is not connected`);
      const a = inp.table(cls).get(op[2]) ?? inp.points.get(op[2]);
      if (!a) throw new Error(`@${name}: input ${op[1]} has no ${cls} attribute "${op[2]}"`);
      bindings.push({ name, local, kind: 'input', cls, index: 'elem', size: a.size, type: a.type, readonly: true, data: a.isArray ? a : a.data });
      continue;
    }
    const grp = /^group_(\w+)$/.exec(name);
    if (grp && (cls === 'point' || cls === 'prim' || cls === 'vertex')) {
      const gname = grp[1];
      let mask = g.groups(cls).get(gname);
      if (!mask) mask = g.addGroup(cls, gname);
      bindings.push({ name, local, kind: 'group', cls, index: 'elem', size: 1, type: 'int', readonly: false, data: mask });
      continue;
    }
    // resolve attribute class by Houdini precedence
    const order: AttribClass[] =
      cls === 'point' ? ['point', 'detail'] :
      cls === 'prim' ? ['prim', 'detail'] :
      cls === 'vertex' ? ['vertex', 'point', 'prim', 'detail'] : ['detail'];
    let found: { c: AttribClass; a: Attribute } | null = null;
    for (const c of order) {
      const a = g.table(c).get(name);
      if (a) { found = { c, a }; break; }
    }
    const want = prefix ? PREFIX_TYPE[prefix] : undefined;
    if (found && want && (found.a.type !== want.type || found.a.size !== want.size) && found.c === cls) {
      // explicit prefix asks for a different type: recreate (keeps overlapping components)
      found = { c: cls, a: g.table(cls).add(name, want.type, want.size) };
    }
    if (found) {
      const index = found.c === cls ? 'elem' : found.c === 'detail' ? 'zero' : found.c === 'point' && cls === 'vertex' ? 'vpoint' : 'elem';
      let readonly = found.c === 'detail' && cls !== 'detail';
      if (found.c === 'prim' && cls === 'vertex') {
        readonly = true;
      }
      if (readonly) ro(`a ${found.c} attribute (read-only here; use set${found.c}attrib)`);
      const arr = found.a.isArray;
      const b: Binding = { name, local, kind: arr ? 'array' : 'attr', cls: found.c, index, size: found.a.size, type: found.a.type, readonly, data: arr ? found.a : found.a.data };
      if (found.c === 'prim' && cls === 'vertex') {
        b.index = 'elem';
        (b as any).primOfVertex = true;
      }
      bindings.push(b);
      continue;
    }
    if (cls === 'prim' && name === 'P') {
      ro('the primitive centroid');
      bindings.push({ name, local, kind: 'centroid', cls, index: 'elem', size: 3, type: 'float', readonly: true });
      continue;
    }
    if (cls === 'prim' && name === 'N') {
      ro('the primitive normal');
      bindings.push({ name, local, kind: 'primN', cls, index: 'elem', size: 3, type: 'float', readonly: true, data: primNormals(g) });
      continue;
    }
    if (cls === 'point' && name === 'N' && !assigned.has(name)) {
      log.push('note: @N read but no point normals exist; reading (0,0,0). Add a normal node first.');
    }
    const t = want ?? KNOWN[name];
    if (t) {
      const a = g.table(cls).add(name, t.type, t.size, defaultValueFor(name, t.size, t.type));
      bindings.push({ name, local, kind: a.isArray ? 'array' : 'attr', cls, index: 'elem', size: a.size, type: t.type, readonly: false, data: a.isArray ? a : a.data });
    } else {
      bindings.push({ name, local, kind: 'new', cls, index: 'elem', size: 0, type: 'any', readonly: false, data: new Array(n) });
    }
  }

  // ---- generate kernel source
  const src: string[] = [];
  src.push('(function(__env){', '"use strict";');
  src.push('const __n=__env.n, __mask=__env.mask, __vp=__env.vp, __vprim=__env.vprim, __B=__env.B;');
  src.push('const numpt=__env.numpt, numprim=__env.numprim, numvtx=__env.numvtx, numelem=__n, Frame=__env.frame, Time=__env.time, TimeInc=__env.timeInc;');
  src.push('const vars=__env.vars, iteration=vars.iteration, numiterations=vars.numiterations;');
  src.push('let ptnum=0, primnum=0, vtxnum=0, elemnum=0;');
  bindings.forEach((b, i) => src.push(`const __d${i}=__B[${i}].data; let ${b.local};`));
  // user code inside a closure so `return` exits just this element
  const body = opts.code.replace(REF, (_m, _p, name) => (SPECIAL.has(name) ? name : '__a_' + name));
  const bodyLine = src.join('\n').split('\n').length + 2; // kernel line holding the snippet's first line
  src.push('const __body=()=>{', body, '\n};');
  src.push('for (let __i=0; __i<__n; __i++) {', 'if (__mask && !__mask[__i]) continue;', 'elemnum=__i;');
  if (runOver === 'points') src.push('ptnum=__i;');
  if (runOver === 'prims') src.push('primnum=__i;');
  if (runOver === 'vertices') src.push('vtxnum=__i; ptnum=__vp[__i]; primnum=__vprim[__i];');
  bindings.forEach((b, i) => {
    const ix = b.index === 'zero' ? '0' : b.index === 'vpoint' ? '__vp[__i]' : (b as any).primOfVertex ? '__vprim[__i]' : '__i';
    src.push(`{const __ix=${ix};`);
    if (b.kind === 'array' || (b.kind === 'input' && isArrayType(b.type))) src.push(`${b.local}=__ga(__d${i},__ix);`);
    else switch (b.kind) {
      case 'centroid': src.push(`${b.local}=__arr(__env.centroid(__i));`); break;
      case 'primN': src.push(`${b.local}=__rd(__d${i},__i,3);`); break;
      case 'group': src.push(`${b.local}=__d${i}[__ix];`); break;
      case 'new': src.push(`${b.local}=__d${i}[__ix]===undefined?0:__d${i}[__ix];`); break;
      default:
        if (b.type === 'string' || b.size === 1) src.push(`${b.local}=__d${i}[__ix];`);
        else src.push(`${b.local}=__rd(__d${i},__ix,${b.size});`);
    }
    src.push('}');
  });
  src.push('__body();');
  bindings.forEach((b, i) => {
    if (b.readonly || b.kind === 'centroid' || b.kind === 'primN' || b.kind === 'input') return;
    const ix = b.index === 'zero' ? '0' : b.index === 'vpoint' ? '__vp[__i]' : '__i';
    if (b.kind === 'array') src.push(`__d${i}.set(${ix},${b.local});`);
    else if (b.kind === 'group') src.push(`__d${i}[${ix}]=${b.local}?1:0;`);
    else if (b.kind === 'new') src.push(`__d${i}[${ix}]=${b.local};`);
    else if (b.type === 'string') src.push(`__d${i}[${ix}]=String(${b.local});`);
    else if (b.size === 1) src.push(`__d${i}[${ix}]=(typeof ${b.local}==='number'?${b.local}:+(${b.local}?.[0]??${b.local}));`);
    else src.push(`__wf(__d${i},${ix},${b.size},${b.local});`);
  });
  src.push('}', '})');
  const source = src.join('\n');

  let kernel = kernelCache.get(source);
  if (!kernel) {
    // Parse the snippet on its own first (strict, like the kernel, same lines): its error positions are then the
    // user's lines, and only a complete function body reaches the kernel, so a stray `}` cannot close the kernel's
    // wrapper and an unclosed `[` cannot swallow it.
    const bad = opts.host.checkSyntax?.(`"use strict";${body}`);
    if (bad) throw new Error(`wrangle syntax error: ${bad.message}${syntaxLine(bad.line, bad.message, body, opts.code)}`);
    try {
      kernel = opts.host.compile(source);
    } catch (e: any) {
      throw new Error(`wrangle syntax error: ${e.message}${userLine(e, bodyLine, opts.code)}`);
    }
    if (kernelCache.size > 500) kernelCache.clear();
    kernelCache.set(source, kernel);
  }

  // ---- runtime API for geometry functions
  const api = new WrangleAPI(g, opts.inputs, log);
  const env = {
    n, mask: runOver === 'detail' ? null : opts.mask, vp: g.vertexPoint, vprim,
    B: bindings, numpt: g.numPoints, numprim: g.numPrims, numvtx: g.numVertices,
    frame: opts.time?.frame ?? opts.vars.frame ?? 1, time: opts.time?.time ?? opts.vars.time ?? 0,
    timeInc: opts.time?.timeInc ?? opts.vars.timeInc ?? 1 / 24, vars: opts.vars,
    centroid: (p: number) => primCentroid(g, p),
  };
  const realm = opts.host.compile('globalThis');
  realm.__cur = api;
  try {
    opts.host.runGuarded(() => kernel(env), opts.timeoutMs);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/timed out/i.test(msg)) throw new Error(`wrangle exceeded ${opts.timeoutMs} ms (infinite loop?)`);
    throw new Error(`wrangle error: ${msg}${userLine(e, bodyLine, opts.code)}`);
  } finally {
    realm.__cur = null;
  }

  // ---- materialise untyped new attributes
  for (const b of bindings) {
    if (b.kind !== 'new') continue;
    const vals = b.data as any[];
    const first = vals.find((v) => v !== undefined && v !== null);
    let type: AttribType = 'float', size = 1;
    if (typeof first === 'string') type = 'string';
    else if (typeof first === 'boolean') type = 'int';
    else if (first && first.length !== undefined) {
      size = Math.max(1, Math.min(16, first.length));
      if (vals.some((v) => v && v.length !== undefined && v.length !== first.length))
        log.push(`note: @${b.name} got arrays of different lengths and was stored as a float tuple of size ${size}; declare it f[]@${b.name} / i[]@${b.name} / s[]@${b.name} for an array attribute`);
    }
    const a = g.table(b.cls).add(b.name, type, size);
    for (let i = 0; i < vals.length; i++) if (vals[i] !== undefined) a.set(i, typeof vals[i] === 'boolean' ? +vals[i] : vals[i]);
  }
  const out = api.apply();
  // array attributes written element by element are left in their loose layout: restore canonical CSR
  for (const t of [out.points, out.vertices, out.prims, out.detail]) for (const a of t.map.values()) if (a.isArray) a.compact();
  return { geo: out, log };
}

/** Map an error inside the generated kernel back to the user's snippet line. */
function userLine(e: any, bodyLine: number, code: string): string {
  const m = /snippet\.js:(\d+)/.exec(String(e?.stack ?? ''));
  if (!m) return '';
  const line = Number(m[1]) - bodyLine + 1;
  const lines = code.split('\n');
  if (line < 1 || line > lines.length) return '';
  return ` (line ${line}: ${lines[line - 1].trim().slice(0, 80)})`;
}

/**
 * " (line N: text)" for a syntax error the parser reported at `line` of the snippet (`src` is the snippet after the
 * @-rewrite, same lines as `code`). At the end of input the culprit is the innermost bracket left open, so the hint
 * names it and points at its line (": '[' is never closed (line 1: …)"); a line past the end (or blank) moves up to
 * the last line with code.
 */
function syntaxLine(line: number, message: string, src: string, code: string): string {
  const lines = code.split('\n');
  let note = '';
  if (/end of input/i.test(message)) {
    const open = unclosedBracket(src);
    if (open) { line = open.line; note = `: '${open.ch}' is never closed`; }
  }
  line = Math.min(Math.max(1, line), lines.length);
  while (line > 1 && !lines[line - 1].trim()) line--;
  return `${note} (line ${line}: ${lines[line - 1].trim().slice(0, 80)})`;
}

/** The innermost bracket left open at the end of JS source (strings, comments, templates and regex literals skipped). */
function unclosedBracket(src: string): { ch: string; line: number } | null {
  const stack: { ch: string; line: number }[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let line = 1, prev = '', word = '', gap = false, inTemplate = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') line++;
    if (inTemplate) {
      if (c === '\\') i++;
      else if (c === '`') inTemplate = false;
      else if (c === '$' && src[i + 1] === '{') { stack.push({ ch: '${', line }); inTemplate = false; i++; }
      continue;
    }
    if (/\s/.test(c)) { gap = true; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i + 1 < src.length && src[i + 1] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return null;
      for (let k = i; k < end; k++) if (src[k] === '\n') line++;
      i = end + 1;
      continue;
    }
    // a slash starts a regex literal after an operator, an opening bracket or a keyword like return
    if (c === '/' && (!prev || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /^(return|typeof|case|do|else|in|of|new|delete|void|throw)$/.test(word))) {
      let cls = false;
      for (i++; i < src.length && src[i] !== '\n'; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        else if (src[i] === '/' && !cls) break;
      }
      if (src[i] === '\n') line++;
      prev = '/'; word = ''; gap = false;
      continue;
    }
    if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c && src[i] !== '\n'; i++) if (src[i] === '\\') i++;
      if (src[i] === '\n') line++;
      prev = c; word = ''; gap = false;
      continue;
    }
    if (c === '`') { inTemplate = true; prev = c; word = ''; gap = false; continue; }
    if (c === '(' || c === '[' || c === '{') stack.push({ ch: c, line });
    else if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop();
      if (top?.ch === '${' && c === '}') inTemplate = true;
      else if (!top || top.ch !== pairs[c]) return null; // mismatched: the parser's own position is better
    }
    const w = /[\w$]/.test(c);
    word = w ? (!gap && /[\w$]/.test(prev) ? word + c : c) : '';
    prev = c; gap = false;
  }
  const top = stack[stack.length - 1];
  return top && top.ch !== '${' ? top : null;
}

/** Geometry functions available to wrangles (queries read inputs; edits are deferred). */
export class WrangleAPI {
  g: Geometry;
  inputs: Geometry[];
  logs: string[];
  private kd = new Map<number, KDTree>();
  private bvh = new Map<number, TriBVH>();
  private nbr = new Map<number, ReturnType<typeof pointNeighbors>>();
  private pp = new Map<number, ReturnType<typeof pointPrims>>();
  newPts: number[][] = [];
  newPrims: { pts: number[]; closed: boolean }[] = [];
  delPts = new Set<number>();
  delPrims = new Set<number>();
  sets: { cls: AttribClass; idx: number; name: string; value: any }[] = [];
  groupSets: { cls: 'point' | 'prim' | 'vertex'; name: string; idx: number; value: number }[] = [];
  edgeSets: { name: string; a: number; b: number; value: number }[] = [];

  constructor(g: Geometry, inputs: Geometry[], logs: string[]) {
    this.g = g;
    this.inputs = inputs;
    this.logs = logs;
  }

  geo(i: number): Geometry {
    if (i === 0) return this.inputs[0] ?? this.g;
    const g = this.inputs[i];
    if (!g) throw new Error(`input ${i} is not connected`);
    return g;
  }
  npoints(i: number) { return this.geo(i).numPoints; }
  nprims(i: number) { return this.geo(i).numPrims; }
  nvertices(i: number) { return this.geo(i).numVertices; }
  hasattr(i: number, cls: AttribClass, name: string) { return this.geo(i).table(cls).has(name); }
  attrtype(i: number, cls: AttribClass, name: string) { const a = this.geo(i).table(cls).get(name); return a ? (a.isArray ? a.type : `${a.type}${a.size}`) : ''; }
  attr(i: number, cls: AttribClass, name: string, idx: number) {
    const g = this.geo(i);
    if (cls === 'prim' && name === 'P' && !g.prims.has('P')) return primCentroid(g, idx);
    const a = g.table(cls).get(name);
    if (!a) throw new Error(`input ${i} has no ${cls} attribute "${name}"`);
    if (idx < 0 || idx >= a.count) return a.isArray ? [] : a.type === 'string' ? '' : a.size === 1 ? 0 : new Array(a.size).fill(0);
    return a.get(idx);
  }
  primpoints(i: number, p: number) { return this.geo(i).primPoints(p); }
  pointprims(i: number, pt: number) {
    let m = this.pp.get(i);
    if (!m) { m = pointPrims(this.geo(i)); this.pp.set(i, m); }
    return [...new Set(Array.from(m.prims.subarray(m.start[pt], m.start[pt + 1])))];
  }
  neighbours(i: number, pt: number) {
    let m = this.nbr.get(i);
    if (!m) { m = pointNeighbors(this.geo(i)); this.nbr.set(i, m); }
    return Array.from(m.nb.subarray(m.start[pt], m.start[pt + 1]));
  }
  private kdOf(i: number) {
    let k = this.kd.get(i);
    if (!k) { k = new KDTree(this.geo(i).P); this.kd.set(i, k); }
    return k;
  }
  private bvhOf(i: number) {
    let b = this.bvh.get(i);
    if (!b) { b = new TriBVH(this.geo(i)); this.bvh.set(i, b); }
    return b;
  }
  nearpoint(i: number, pos: number[], maxd: number) { return this.kdOf(i).nearest(pos[0], pos[1], pos[2], maxd).index; }
  nearpoints(i: number, pos: number[], maxd: number, maxn: number) {
    return maxd === Infinity ? this.kdOf(i).knn(pos[0], pos[1], pos[2], Math.min(maxn, this.geo(i).numPoints)) : this.kdOf(i).within(pos[0], pos[1], pos[2], maxd, maxn);
  }
  closest(i: number, pos: number[]) {
    const r = this.bvhOf(i).closest(pos[0], pos[1], pos[2]);
    return r ? { dist: r.dist, pos: r.pos, prim: r.prim } : { dist: Infinity, pos: [pos[0], pos[1], pos[2]], prim: -1 };
  }
  intersect(i: number, o: number[], d: number[]) {
    const r = this.bvhOf(i).raycast(o[0], o[1], o[2], d[0], d[1], d[2]);
    return r ? { prim: r.prim, pos: r.pos, dist: r.t * Math.hypot(d[0], d[1], d[2]) } : null;
  }
  ingroup(i: number, cls: 'point' | 'prim' | 'vertex', name: string, idx: number) {
    const m = this.geo(i).groups(cls).get(name);
    return m ? m[idx] === 1 : false;
  }
  inedgegroup(i: number, name: string, a: number, b: number) {
    const s = this.geo(i).edgeGroups.get(name);
    return s ? s.has(a, b) : false;
  }
  addpoint(pos: any): number {
    if (typeof pos === 'number') {
      // addpoint(0, ptnum) copies an existing point's position
      const P = this.g.P;
      pos = [P[pos * 3], P[pos * 3 + 1], P[pos * 3 + 2]];
    }
    this.newPts.push([+pos[0] || 0, +pos[1] || 0, +pos[2] || 0]);
    return this.g.numPoints + this.newPts.length - 1;
  }
  addprim(pts: any, closed: boolean) {
    this.newPrims.push({ pts: Array.from(pts as ArrayLike<number>, Number), closed: !!closed });
    return this.g.numPrims + this.newPrims.length - 1;
  }
  removepoint(pt: number) { this.delPts.add(pt); }
  removeprim(p: number, andPoints: boolean) {
    this.delPrims.add(p);
    if (andPoints) (this as any).delPrimPts = true;
  }
  // argument order of the snippet-lib callers: setpointattrib(0, name, idx, value) → setattr('point', name, idx, value)
  setattr(cls: AttribClass, name: string, idx: number, value: any) { this.sets.push({ cls, idx: Number(idx), name: String(name), value: Array.isArray(value) ? value.slice() : value }); }
  setgroup(cls: 'point' | 'prim' | 'vertex', name: string, idx: number, value: any) { this.groupSets.push({ cls, name, idx, value: value ? 1 : 0 }); }
  setedgegroup(name: string, a: number, b: number, value: any) { this.edgeSets.push({ name, a: Number(a), b: Number(b), value: value ? 1 : 0 }); }
  log(msg: string) { if (this.logs.length < 50) this.logs.push(msg); }

  /** Apply deferred edits and return the resulting geometry. */
  apply(): Geometry {
    let g = this.g;
    if (this.newPts.length || this.newPrims.length) g = appendElements(g, this.newPts, this.newPrims);
    for (const s of this.sets) {
      const t = g.table(s.cls);
      let a = t.get(s.name);
      if (!a) {
        const known = KNOWN[s.name];
        const v = s.value;
        const type: AttribType = known?.type ?? (typeof v === 'string' ? 'string' : 'float');
        const size = known?.size ?? (Array.isArray(v) ? v.length : 1);
        a = t.add(s.name, type, size);
      }
      if (s.idx >= 0 && s.idx < t.count) a.set(s.idx, s.value);
    }
    for (const s of this.groupSets) {
      const n = g.count(s.cls);
      const m = g.groups(s.cls).get(s.name) ?? g.addGroup(s.cls, s.name);
      if (s.idx >= 0 && s.idx < n) m[s.idx] = s.value;
    }
    for (const s of this.edgeSets) {
      const set = g.edgeGroups.get(s.name) ?? g.addEdgeGroup(s.name);
      if (!(s.a >= 0 && s.b >= 0 && s.a < g.numPoints && s.b < g.numPoints)) continue;
      if (s.value) set.add(s.a, s.b); else set.delete(s.a, s.b);
    }
    if (this.delPrims.size) {
      const keep = new Uint8Array(g.numPrims).fill(1);
      for (const p of this.delPrims) if (p >= 0 && p < keep.length) keep[p] = 0;
      g = g.subsetPrims(keep, !!(this as any).delPrimPts);
    }
    if (this.delPts.size) {
      const keep = new Uint8Array(g.numPoints).fill(1);
      for (const p of this.delPts) if (p >= 0 && p < keep.length) keep[p] = 0;
      g = g.subsetPoints(keep);
    }
    return g;
  }
}

/** Append points and prims (prims may reference existing or new points). New elements get attribute defaults. */
export function appendElements(g: Geometry, pts: number[][], prims: { pts: number[]; closed: boolean }[]): Geometry {
  const np0 = g.numPoints, npr0 = g.numPrims, nv0 = g.numVertices;
  const ptIdx = Int32Array.from({ length: np0 + pts.length }, (_, i) => (i < np0 ? i : -1));
  const out = g.clone();
  out.points = g.points.gather(ptIdx);
  const P = out.P;
  pts.forEach((p, k) => { P[(np0 + k) * 3] = p[0]; P[(np0 + k) * 3 + 1] = p[1]; P[(np0 + k) * 3 + 2] = p[2]; });
  const npts = np0 + pts.length;
  const valid = prims.filter((pr) => pr.pts.length >= (pr.closed ? 3 : 2) && pr.pts.every((i) => i >= 0 && i < npts));
  let addV = 0;
  for (const pr of valid) addV += pr.pts.length;
  out.vertices = g.vertices.gather(Int32Array.from({ length: nv0 + addV }, (_, i) => (i < nv0 ? i : -1)));
  out.prims = g.prims.gather(Int32Array.from({ length: npr0 + valid.length }, (_, i) => (i < npr0 ? i : -1)));
  out.primStart = new Int32Array(npr0 + valid.length + 1);
  out.primStart.set(g.primStart.subarray(0, npr0 + 1));
  out.vertexPoint = new Int32Array(nv0 + addV);
  out.vertexPoint.set(g.vertexPoint);
  out.primClosed = new Uint8Array(npr0 + valid.length);
  out.primClosed.set(g.primClosed);
  let v = nv0;
  valid.forEach((pr, k) => {
    for (const i of pr.pts) out.vertexPoint[v++] = i;
    out.primStart[npr0 + k + 1] = v;
    out.primClosed[npr0 + k] = pr.closed ? 1 : 0;
  });
  for (const [k, m] of g.pointGroups) { const nm = new Uint8Array(npts); nm.set(m); out.pointGroups.set(k, nm); }
  for (const [k, m] of g.primGroups) { const nm = new Uint8Array(out.numPrims); nm.set(m); out.primGroups.set(k, nm); }
  for (const [k, m] of g.vertexGroups) { const nm = new Uint8Array(out.numVertices); nm.set(m); out.vertexGroups.set(k, nm); }
  if (out.primKind) out.ensurePacked(); // new prims are not packed
  return out;
}
