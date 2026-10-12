// Attribute, group, colour and UV nodes.
import { Geometry, defaultValueFor } from '../core/geometry.ts';
import type { AttribClass, AttribType } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { rand, gaussian, rng } from '../core/random.ts';
import { fractal, makeNoise } from '../core/noise.ts';
import { connectivity, primArea, primCentroid, primNormals, primPerimeter, vertexNormals, pointNormals, signedVolume } from '../core/topology.ts';
import { KDTree, TriBVH } from '../core/spatial.ts';
import { evalRamp, parseColor } from '../graph/params.ts';
import { runWrangle } from '../core/wrangle.ts';
import { P, getPointNormals, mask, wrangleTime } from './util.ts';
import { normalize } from '../core/math.ts';

const CLS = { type: 'enum' as const, options: ['point', 'prim', 'vertex', 'detail'], default: 'point', desc: 'attribute class' };

function globRe(pattern: string) {
  const parts = pattern.split(/[\s,]+/).filter(Boolean);
  const pos = parts.filter((p) => !p.startsWith('^')).map((p) => new RegExp('^' + p.replace(/[.+$()|[\]\\{}]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'));
  const neg = parts.filter((p) => p.startsWith('^')).map((p) => new RegExp('^' + p.slice(1).replace(/[.+$()|[\]\\{}]/g, '\\$&').replace(/\*/g, '.*') + '$'));
  return (name: string) => pos.some((r) => r.test(name)) && !neg.some((r) => r.test(name));
}

function elemCount(g: Geometry, cls: AttribClass) {
  return cls === 'point' ? g.numPoints : cls === 'prim' ? g.numPrims : cls === 'vertex' ? g.numVertices : 1;
}

defineNode({
  type: 'attrib_create',
  category: 'attribute',
  summary: 'Create/set an attribute to a constant value (type inferred from the value).',
  aliases: ['attribcreate', 'set_attrib', 'attribute_create'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    name: { type: 'string', default: 'attr', desc: 'attribute name' },
    class: CLS,
    value: { type: 'json', default: 0, desc: 'value: number, [x,y,z...] or "string"' },
    type: { type: 'enum', options: ['auto', 'float', 'int', 'string'], default: 'auto', desc: 'force a type' },
    group: { type: 'group', default: '', desc: 'only set elements in this group (point/prim classes)' },
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    if (!p.name) throw new NodeError('name is empty');
    const v = p.value;
    const type: AttribType = p.type !== 'auto' ? p.type : typeof v === 'string' ? 'string' : 'float';
    const size = Array.isArray(v) ? v.length : 1;
    const a = g.table(p.class).add(p.name, type, size, type === 'string' ? '' : defaultValueFor(p.name, size, type));
    const sel = p.class === 'point' || p.class === 'prim' ? mask(g, p.class, p.group) : null;
    for (let i = 0; i < elemCount(g, p.class); i++) if (!sel || sel[i]) a.set(i, v);
    return g;
  },
});

defineNode({
  type: 'attrib_randomize',
  category: 'attribute',
  summary: 'Random attribute values: uniform range, normal distribution, unit directions, or random choice from a list.',
  aliases: ['attribrandomize', 'randomize'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    name: { type: 'string', default: 'pscale', desc: 'attribute name' },
    class: CLS,
    distribution: { type: 'enum', options: ['uniform', 'normal', 'direction', 'choice', 'orient'], default: 'uniform', desc: 'uniform in [min,max]; normal (mean=min, stddev=max); direction = unit vector; choice = pick from "values"; orient = random rotation quaternion' },
    min: { type: 'json', default: 0.5, desc: 'number or vector (same size as max)' },
    max: { type: 'json', default: 1.5, desc: 'number or vector' },
    values: { type: 'json', default: [], desc: 'choice: list of values to pick from (numbers, vectors or strings)' },
    seed: P.seed(),
    group: { type: 'group', default: '', desc: 'only these elements' },
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const n = elemCount(g, p.class);
    const sel = p.class === 'point' || p.class === 'prim' ? mask(g, p.class, p.group) : null;
    const lo = Array.isArray(p.min) ? p.min : [p.min], hi = Array.isArray(p.max) ? p.max : [p.max];
    const vec = Array.isArray(p.min) || Array.isArray(p.max);
    let size = Math.max(lo.length, hi.length), type: AttribType = 'float';
    if (p.distribution === 'direction') size = 3;
    if (p.distribution === 'orient') size = 4;
    if (p.distribution === 'choice') {
      if (!Array.isArray(p.values) || !p.values.length) throw new NodeError('choice needs a non-empty "values" list');
      const f = p.values[0];
      type = typeof f === 'string' ? 'string' : 'float';
      size = Array.isArray(f) ? f.length : 1;
    }
    const a = g.table(p.class).add(p.name, type, size);
    for (let i = 0; i < n; i++) {
      if (sel && !sel[i]) continue;
      const r = rng(p.seed * 7919 + i * 31 + 1);
      let v: any;
      switch (p.distribution) {
        case 'normal': v = Array.from({ length: size }, (_, c) => (lo[c] ?? lo[0]) + gaussian(r) * (hi[c] ?? hi[0])); break;
        case 'direction': { const z = r() * 2 - 1, t = r() * Math.PI * 2, s = Math.sqrt(1 - z * z); v = [s * Math.cos(t), z, s * Math.sin(t)]; break; }
        case 'orient': {
          const u1 = r(), u2 = r() * Math.PI * 2, u3 = r() * Math.PI * 2;
          v = [Math.sqrt(1 - u1) * Math.sin(u2), Math.sqrt(1 - u1) * Math.cos(u2), Math.sqrt(u1) * Math.sin(u3), Math.sqrt(u1) * Math.cos(u3)];
          break;
        }
        case 'choice': v = p.values[Math.floor(r() * p.values.length) % p.values.length]; break;
        default: v = Array.from({ length: size }, (_, c) => { const a0 = lo[c] ?? lo[0], b0 = hi[c] ?? hi[0]; return a0 + (b0 - a0) * r(); });
      }
      a.set(i, !vec && Array.isArray(v) && v.length === 1 ? v[0] : v);
    }
    return g;
  },
});

defineNode({
  type: 'attrib_promote',
  category: 'attribute',
  summary: 'Move an attribute between classes (point ↔ prim ↔ vertex ↔ detail) with average/min/max/sum/first.',
  aliases: ['attribpromote', 'promote'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    name: { type: 'string', default: 'Cd', desc: 'attribute name' },
    from: { type: 'enum', options: ['point', 'prim', 'vertex', 'detail'], default: 'point', desc: 'source class', aliases: ['inclass', 'from_class'] },
    to: { type: 'enum', options: ['point', 'prim', 'vertex', 'detail'], default: 'prim', desc: 'destination class', aliases: ['outclass', 'to_class'] },
    method: { type: 'enum', options: ['average', 'min', 'max', 'sum', 'first', 'last'], default: 'average', desc: 'how to combine multiple sources' },
    new_name: { type: 'string', default: '', desc: 'rename on promotion ("" = same name)' },
    keep_original: { type: 'bool', default: false, desc: 'keep the source attribute' },
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const src = g.table(p.from).get(p.name);
    if (!src) throw new NodeError(`no ${p.from} attribute "${p.name}". ${p.from} attributes: ${g.table(p.from).names().join(', ') || '(none)'}`);
    const outName = p.new_name || p.name;
    const n = elemCount(g, p.to), s = src.size;
    // contributors: for each destination element, list of source indices
    const contrib: number[][] = Array.from({ length: n }, () => []);
    const vprim = g.vertexPrims();
    const add = (dst: number, si: number) => contrib[dst].push(si);
    const F = p.from, T = p.to;
    if (F === 'detail') for (let i = 0; i < n; i++) add(i, 0);
    else if (T === 'detail') for (let i = 0; i < elemCount(g, F); i++) add(0, i);
    else if (F === 'point' && T === 'prim') for (let pr = 0; pr < g.numPrims; pr++) for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) add(pr, g.vertexPoint[v]);
    else if (F === 'prim' && T === 'point') for (let v = 0; v < g.numVertices; v++) add(g.vertexPoint[v], vprim[v]);
    else if (F === 'point' && T === 'vertex') for (let v = 0; v < g.numVertices; v++) add(v, g.vertexPoint[v]);
    else if (F === 'vertex' && T === 'point') for (let v = 0; v < g.numVertices; v++) add(g.vertexPoint[v], v);
    else if (F === 'prim' && T === 'vertex') for (let v = 0; v < g.numVertices; v++) add(v, vprim[v]);
    else if (F === 'vertex' && T === 'prim') for (let v = 0; v < g.numVertices; v++) add(vprim[v], v);
    else if (F === T) throw new NodeError('from and to are the same class');
    const dst = g.table(T).add(outName, src.type === 'string' ? 'string' : src.type, s);
    for (let i = 0; i < n; i++) {
      const c = contrib[i];
      if (!c.length) continue;
      if (src.type === 'string' || p.method === 'first') { dst.set(i, src.get(c[0])); continue; }
      if (p.method === 'last') { dst.set(i, src.get(c[c.length - 1])); continue; }
      const out = new Array(s).fill(p.method === 'min' ? Infinity : p.method === 'max' ? -Infinity : 0);
      const d = src.data as Float64Array;
      for (const si of c) for (let k = 0; k < s; k++) {
        const x = d[si * s + k];
        if (p.method === 'min') out[k] = Math.min(out[k], x);
        else if (p.method === 'max') out[k] = Math.max(out[k], x);
        else out[k] += x;
      }
      if (p.method === 'average') for (let k = 0; k < s; k++) out[k] /= c.length;
      dst.set(i, out);
    }
    if (!p.keep_original) g.table(F).delete(p.name);
    return g;
  },
});

defineNode({
  type: 'attrib_delete',
  category: 'attribute',
  summary: 'Delete attributes by name pattern (wildcards, "^name" to keep).',
  aliases: ['attribdelete', 'delete_attrib'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    names: { type: 'string', default: '', desc: 'space-separated names/patterns, e.g. "Cd uv* ^uv2"', aliases: ['name', 'pattern'] },
    class: { type: 'enum', options: ['all', 'point', 'prim', 'vertex', 'detail'], default: 'all', desc: 'which classes' },
    groups: { type: 'string', default: '', desc: 'also delete groups matching this pattern' },
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const m = globRe(p.names);
    for (const c of ['point', 'prim', 'vertex', 'detail'] as AttribClass[]) {
      if (p.class !== 'all' && p.class !== c) continue;
      for (const n of g.table(c).names()) if (n !== 'P' && m(n)) g.table(c).delete(n);
    }
    if (p.groups) {
      const gm = globRe(p.groups);
      for (const map of [g.pointGroups, g.primGroups]) for (const k of [...map.keys()]) if (gm(k)) map.delete(k);
    }
    return g;
  },
});

defineNode({
  type: 'attrib_rename',
  category: 'attribute',
  summary: 'Rename an attribute.',
  aliases: ['attribrename', 'rename_attrib'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    from: { type: 'string', default: '', desc: 'existing name' },
    to: { type: 'string', default: '', desc: 'new name' },
    class: { type: 'enum', options: ['auto', 'point', 'prim', 'vertex', 'detail'], default: 'auto', desc: 'class (auto = first found)' },
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const classes: AttribClass[] = p.class === 'auto' ? ['point', 'vertex', 'prim', 'detail'] : [p.class];
    for (const c of classes) {
      const a = g.table(c).get(p.from);
      if (a) { g.table(c).delete(p.from); g.table(c).map.set(p.to, a); return g; }
    }
    throw new NodeError(`attribute "${p.from}" not found`);
  },
});

defineNode({
  type: 'attrib_copy',
  category: 'attribute',
  summary: 'Copy attributes from the second input by element index (or by matching an id attribute).',
  aliases: ['attribcopy', 'copy_attrib'],
  inputs: [{ name: 'dest', desc: 'geometry receiving attributes' }, { name: 'source', desc: 'geometry providing attributes' }],
  params: {
    names: { type: 'string', default: '*', desc: 'attribute name pattern', aliases: ['name', 'pattern'] },
    class: { type: 'enum', options: ['point', 'prim', 'vertex', 'detail'], default: 'point', desc: 'class' },
    match_by: { type: 'string', default: '', desc: 'match elements by this int/string attribute instead of index (e.g. "id" or "name")' },
  },
  cook: ({ input, p }) => {
    const g = input(0).clone(), s = input(1);
    const m = globRe(p.names);
    const dt = g.table(p.class), st = s.table(p.class);
    let map: (i: number) => number = (i) => (i < st.count ? i : -1);
    if (p.match_by) {
      const da = dt.get(p.match_by), sa = st.get(p.match_by);
      if (!da || !sa) throw new NodeError(`match_by attribute "${p.match_by}" missing on dest or source`);
      const idx = new Map<any, number>();
      for (let i = 0; i < st.count; i++) idx.set(sa.get(i), i);
      map = (i) => idx.get(da.get(i)) ?? -1;
    }
    for (const [name, a] of st.map) {
      if (name === 'P' || !m(name) || name === p.match_by) continue;
      const d = dt.add(name, a.type, a.size);
      for (let i = 0; i < dt.count; i++) { const j = map(i); if (j >= 0) d.set(i, a.get(j)); }
    }
    return g;
  },
});

defineNode({
  type: 'attrib_transfer',
  category: 'attribute',
  summary: 'Transfer point attributes from the nearest points (or surface) of the second input, with distance falloff.',
  aliases: ['attribtransfer', 'transfer'],
  inputs: [{ name: 'dest', desc: 'geometry receiving attributes' }, { name: 'source', desc: 'geometry providing attributes' }],
  params: {
    names: { type: 'string', default: 'Cd', desc: 'attribute name pattern (point attributes of source)' },
    method: { type: 'enum', options: ['nearest_point', 'surface'], default: 'nearest_point', desc: 'nearest source point, or barycentric interpolation on the closest surface point' },
    max_distance: { type: 'float', default: 1e9, desc: 'no transfer beyond this distance' },
    blend_width: { type: 'float', default: 0, min: 0, desc: 'fade out over this distance before max_distance (0 = hard)' },
  },
  cook: ({ input, p }) => {
    const g = input(0).clone(), s = input(1);
    const m = globRe(p.names);
    const names = s.points.names().filter((n) => n !== 'P' && m(n));
    if (!names.length) throw new NodeError(`source has no point attributes matching "${p.names}" (has: ${s.points.names().join(', ')})`);
    const kd = p.method === 'nearest_point' ? new KDTree(s.P) : null;
    const bvh = p.method === 'surface' ? new TriBVH(s) : null;
    const Pd = g.P;
    for (const name of names) {
      const sa = s.points.get(name)!;
      const da = g.points.get(name) && g.points.get(name)!.size === sa.size ? g.points.get(name)! : g.points.add(name, sa.type, sa.size);
      for (let i = 0; i < g.numPoints; i++) {
        const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
        let val: any = null, dist = Infinity;
        if (kd) {
          const r = kd.nearest(x, y, z, p.max_distance);
          if (r.index >= 0) { val = sa.get(r.index); dist = r.dist; }
        } else if (bvh) {
          const r = bvh.closest(x, y, z, p.max_distance);
          if (r) {
            dist = r.dist;
            const tv = [bvh.triVtx[r.tri * 3], bvh.triVtx[r.tri * 3 + 1], bvh.triVtx[r.tri * 3 + 2]].map((v) => s.vertexPoint[v]);
            if (sa.type === 'float') {
              const d = sa.data as Float64Array;
              val = Array.from({ length: sa.size }, (_, c) => r.bary[0] * d[tv[0] * sa.size + c] + r.bary[1] * d[tv[1] * sa.size + c] + r.bary[2] * d[tv[2] * sa.size + c]);
              if (sa.size === 1) val = val[0];
            } else val = sa.get(tv[r.bary.indexOf(Math.max(...r.bary))]);
          }
        }
        if (val === null) continue;
        if (p.blend_width > 0 && sa.type === 'float' && dist > p.max_distance - p.blend_width) {
          const w = Math.max(0, (p.max_distance - dist) / p.blend_width);
          const cur = da.get(i);
          val = Array.isArray(val) ? val.map((v: number, c: number) => (cur as number[])[c] + (v - (cur as number[])[c]) * w) : (cur as number) + ((val as number) - (cur as number)) * w;
        }
        da.set(i, val);
      }
    }
    return g;
  },
});

defineNode({
  type: 'attrib_noise',
  category: 'attribute',
  summary: 'Write fractal noise into a float or vector attribute (e.g. for masks, colour variation, weights).',
  aliases: ['attribnoise'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    name: { type: 'string', default: 'mask', desc: 'attribute name' },
    size: { type: 'int', default: 1, min: 1, max: 4, desc: 'components (1 = float, 3 = vector)' },
    range: { type: 'vec2', default: [0, 1], desc: 'output range (noise -1..1 is mapped into this)' },
    frequency: { type: 'vec3', default: [1, 1, 1], desc: 'noise frequency' },
    offset: { type: 'vec3', default: [0, 0, 0], desc: 'noise offset' },
    noise: { type: 'enum', options: ['perlin', 'simplex', 'value', 'worley'], default: 'perlin', desc: 'base noise' },
    fractal: { type: 'enum', options: ['fbm', 'ridged', 'turbulence', 'none'], default: 'fbm', desc: 'fractal mode' },
    octaves: { type: 'int', default: 3, min: 1, max: 12, desc: 'octaves' },
    contrast: { type: 'float', default: 1, desc: 'contrast around the midpoint' },
    seed: P.seed(),
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const a = g.points.add(p.name, 'float', p.size);
    const d = a.data as Float64Array;
    const fns = Array.from({ length: p.size }, (_, c) => fractal(makeNoise(p.noise, p.seed + c * 101), { octaves: p.octaves, fractal: p.fractal }));
    const Pd = g.P;
    for (let i = 0; i < g.numPoints; i++) {
      const x = Pd[i * 3] * p.frequency[0] + p.offset[0], y = Pd[i * 3 + 1] * p.frequency[1] + p.offset[1], z = Pd[i * 3 + 2] * p.frequency[2] + p.offset[2];
      for (let c = 0; c < p.size; c++) {
        let v = fns[c](x, y, z);
        if (p.noise === 'worley') v = v * 2 - 1;
        v = Math.max(-1, Math.min(1, v * p.contrast));
        d[i * p.size + c] = p.range[0] + (v * 0.5 + 0.5) * (p.range[1] - p.range[0]);
      }
    }
    return g;
  },
});

defineNode({
  type: 'color',
  category: 'attribute',
  summary: 'Set Cd: constant, random per element/piece, or a ramp driven by an attribute (auto-ranged).',
  aliases: ['colour', 'cd'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    mode: { type: 'enum', options: ['constant', 'random', 'ramp'], default: 'constant', desc: 'how colours are chosen' },
    color: { type: 'color', default: [1, 1, 1], desc: 'constant colour: [r,g,b] 0..1, "#rrggbb", or a name', aliases: ['cd', 'rgb'] },
    class: { type: 'enum', options: ['point', 'prim', 'vertex', 'detail'], default: 'point', desc: 'where to store Cd' },
    by: { type: 'string', default: '', desc: 'random: attribute whose value picks the colour (e.g. "class", "name", "copynum"); "" = per element' },
    hue_range: { type: 'vec2', default: [0, 1], desc: 'random: hue range' },
    saturation: { type: 'vec2', default: [0.5, 0.8], desc: 'random: saturation range' },
    value: { type: 'vec2', default: [0.8, 1], desc: 'random: brightness range' },
    attrib: { type: 'string', default: 'P.y', desc: 'ramp: driving attribute (".x/.y/.z" picks a component; vectors use length)' },
    ramp: { type: 'ramp', default: [[0, '#1d2b53'], [0.5, '#2a9d8f'], [1, '#f4e285']], desc: 'ramp keys [pos, colour]' },
    range: { type: 'vec2', default: [0, 0], desc: 'ramp: attribute range mapped to 0..1 ([0,0] = auto min/max)' },
    group: { type: 'group', default: '', desc: 'only colour these elements (point/prim class)' },
    seed: P.seed(),
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const cls: AttribClass = p.class;
    const n = elemCount(g, cls);
    const a = g.table(cls).add('Cd', 'float', 3);
    const sel = cls === 'point' || cls === 'prim' ? mask(g, cls, p.group) : null;
    const hsv = (h: number, s: number, v: number) => {
      const i = Math.floor(h * 6), f = h * 6 - i, pp = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
      return [[v, t, pp], [q, v, pp], [pp, v, t], [pp, q, v], [t, pp, v], [v, pp, q]][((i % 6) + 6) % 6];
    };
    if (p.mode === 'constant') { for (let i = 0; i < n; i++) if (!sel || sel[i]) a.set(i, p.color); return g; }
    if (p.mode === 'random') {
      let keyOf: (i: number) => number = (i) => i;
      if (p.by) {
        const f = g.findAttrib(p.by, [cls, 'prim', 'point', 'vertex']);
        if (!f) throw new NodeError(`"by" attribute "${p.by}" not found`);
        const vprim = g.vertexPrims();
        const fetch = (i: number) => {
          if (f.cls === cls) return f.attr.get(i);
          if (f.cls === 'prim' && cls === 'point') { return null; }
          if (f.cls === 'prim' && cls === 'vertex') return f.attr.get(vprim[i]);
          if (f.cls === 'point' && cls === 'vertex') return f.attr.get(g.vertexPoint[i]);
          if (f.cls === 'point' && cls === 'prim') return f.attr.get(g.vertexPoint[g.primStart[i]]);
          return f.attr.get(0);
        };
        const ptPrim = new Int32Array(g.numPoints).fill(-1);
        if (f.cls === 'prim' && cls === 'point') for (let pr = 0; pr < g.numPrims; pr++) for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) ptPrim[g.vertexPoint[v]] = pr;
        const ids = new Map<string, number>();
        keyOf = (i) => {
          const v = f.cls === 'prim' && cls === 'point' ? (ptPrim[i] >= 0 ? f.attr.get(ptPrim[i]) : -1) : fetch(i);
          const k = JSON.stringify(v);
          let id = ids.get(k);
          if (id === undefined) { id = typeof v === 'number' ? v : ids.size + 1000; ids.set(k, id); }
          return id;
        };
      }
      for (let i = 0; i < n; i++) {
        if (sel && !sel[i]) continue;
        const k = keyOf(i);
        const h = p.hue_range[0] + rand(k, p.seed + 0.1) * (p.hue_range[1] - p.hue_range[0]);
        const s = p.saturation[0] + rand(k, p.seed + 0.2) * (p.saturation[1] - p.saturation[0]);
        const v = p.value[0] + rand(k, p.seed + 0.3) * (p.value[1] - p.value[0]);
        a.set(i, hsv(((h % 1) + 1) % 1, s, v));
      }
      return g;
    }
    // ramp
    const [aname, comp] = String(p.attrib).split('.');
    const ci = comp ? 'xyzw'.indexOf(comp) : -1;
    const f = g.findAttrib(aname, [cls, 'point', 'prim', 'vertex', 'detail']);
    let get: (i: number) => number;
    const vprim = g.vertexPrims();
    if (!f) {
      if (aname === 'P' && cls === 'prim') get = (i) => { const c = primCentroid(g, i); return ci >= 0 ? c[ci] : Math.hypot(...c); };
      else throw new NodeError(`ramp attribute "${aname}" not found`);
    } else {
      const raw = (i: number) => {
        if (f.cls === cls || f.cls === 'detail') return f.attr.get(f.cls === 'detail' ? 0 : i);
        if (cls === 'vertex') return f.attr.get(f.cls === 'point' ? g.vertexPoint[i] : vprim[i]);
        if (cls === 'prim' && f.cls === 'point') return f.attr.get(g.vertexPoint[g.primStart[i]]);
        if (cls === 'point' && f.cls === 'prim') return 0;
        return f.attr.get(i);
      };
      get = (i) => { const v = raw(i); return Array.isArray(v) ? (ci >= 0 ? v[ci] : Math.hypot(...v)) : Number(v); };
    }
    let [lo, hi] = p.range;
    if (lo === hi) { lo = Infinity; hi = -Infinity; for (let i = 0; i < n; i++) { const v = get(i); lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    for (let i = 0; i < n; i++) {
      if (sel && !sel[i]) continue;
      const t = hi > lo ? (get(i) - lo) / (hi - lo) : 0;
      const c = evalRamp(p.ramp, t);
      a.set(i, Array.isArray(c) ? c : [c, c, c]);
    }
    return g;
  },
});

// ---------------------------------------------------------------- groups

defineNode({
  type: 'group',
  category: 'group',
  summary: 'Create/modify a point or prim group by pattern, JS expression, bounding box, normal direction or random %.',
  aliases: ['group_create', 'groupcreate', 'select'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    name: { type: 'string', default: 'group1', desc: 'group name' },
    class: { type: 'enum', options: ['prim', 'point'], default: 'prim', desc: 'element class' },
    pattern: { type: 'group', default: '', desc: 'base pattern ("" = no pattern filter): names, ranges, "@P.y>0", "!grp"' },
    expr: { type: 'code', default: '', desc: 'JS wrangle-style boolean expression per element, e.g. "@P.y > 0.5 && @N.y > 0.9"' },
    bbox_min: { type: 'vec3', default: [-1e9, -1e9, -1e9], desc: 'keep elements inside this box (points; prims use centroid)' },
    bbox_max: { type: 'vec3', default: [1e9, 1e9, 1e9], desc: 'box max' },
    normal: { type: 'vec3', default: [0, 0, 0], desc: 'keep elements whose normal is within spread_angle of this direction ([0,0,0] = off)' },
    spread_angle: { type: 'float', default: 30, desc: 'normal test cone half-angle in degrees' },
    random: { type: 'float', default: 1, min: 0, max: 1, desc: 'keep this fraction at random (1 = all)' },
    seed: P.seed(),
    mode: { type: 'enum', options: ['replace', 'union', 'intersect', 'subtract'], default: 'replace', desc: 'combine with an existing group of the same name' },
    invert: { type: 'bool', default: false, desc: 'invert the selection' },
  },
  cook: (ctx) => {
    const { input, p, engine, vars, inputs } = ctx;
    let g = input(0).clone();
    const cls: 'point' | 'prim' = p.class;
    const n = cls === 'point' ? g.numPoints : g.numPrims;
    const sel = new Uint8Array(n).fill(1);
    const base = mask(g, cls, p.pattern);
    if (base) for (let i = 0; i < n; i++) sel[i] &= base[i];
    const bmin = p.bbox_min, bmax = p.bbox_max;
    const hasBox = bmin.some((v: number) => v > -1e8) || bmax.some((v: number) => v < 1e8);
    const useN = Math.hypot(...p.normal) > 0;
    const pn = useN ? (cls === 'prim' ? primNormals(g) : getPointNormals(g)) : null;
    const dir = useN ? normalize(p.normal) : [0, 0, 0];
    const cosT = Math.cos((p.spread_angle * Math.PI) / 180);
    for (let i = 0; i < n; i++) {
      if (!sel[i]) continue;
      const c = cls === 'prim' ? primCentroid(g, i) : [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]];
      if (hasBox && !(c[0] >= bmin[0] && c[0] <= bmax[0] && c[1] >= bmin[1] && c[1] <= bmax[1] && c[2] >= bmin[2] && c[2] <= bmax[2])) { sel[i] = 0; continue; }
      if (pn && pn[i * 3] * dir[0] + pn[i * 3 + 1] * dir[1] + pn[i * 3 + 2] * dir[2] < cosT) { sel[i] = 0; continue; }
      if (p.random < 1 && rand(i, p.seed + 0.77) >= p.random) sel[i] = 0;
    }
    if (p.expr && p.expr.trim()) {
      const tmp = g.clone();
      const r = runWrangle(tmp, {
        code: `@group___pfexpr = (${p.expr}) ? 1 : 0;`,
        runOver: cls === 'point' ? 'points' : 'prims', mask: null,
        inputs: [g, ...inputs.slice(1).map((x) => x ?? new Geometry())], vars, host: engine.host, timeoutMs: engine.scriptTimeoutMs,
        time: wrangleTime(ctx, p.expr),
      });
      const em = r.geo.groups(cls).get('__pfexpr')!;
      for (let i = 0; i < n; i++) sel[i] &= em[i];
    }
    if (p.invert) for (let i = 0; i < n; i++) sel[i] = sel[i] ? 0 : 1;
    const prev = g.groups(cls).get(p.name);
    if (prev && p.mode !== 'replace')
      for (let i = 0; i < n; i++) sel[i] = p.mode === 'union' ? sel[i] | prev[i] : p.mode === 'intersect' ? sel[i] & prev[i] : prev[i] & (sel[i] ^ 1);
    g.addGroup(cls, p.name, sel);
    return g;
  },
});

defineNode({
  type: 'delete',
  category: 'group',
  summary: 'Delete (or keep only) points/prims matching a group pattern (Houdini Blast).',
  aliases: ['blast', 'remove', 'keep'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    group: { type: 'group', default: '', desc: 'what to delete: group name, "!name", range "0-10", or "@P.y<0"' },
    class: { type: 'enum', options: ['prim', 'point'], default: 'prim', desc: 'element class of the pattern' },
    keep: { type: 'bool', default: false, desc: 'invert: keep the matches, delete the rest', aliases: ['invert', 'negate', 'delete_non_selected'] },
    remove_unused_points: { type: 'bool', default: true, desc: 'drop points no longer used by prims (prim mode)' },
  },
  cook: ({ input, p }) => {
    const g = input(0);
    const cls: 'point' | 'prim' = p.class;
    const m = mask(g, cls, p.group);
    const n = cls === 'point' ? g.numPoints : g.numPrims;
    const keep = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const hit = m ? m[i] : 1; keep[i] = p.keep ? hit : hit ? 0 : 1; }
    if (cls === 'prim') {
      const hadIsolated = g.numPrims === 0;
      return hadIsolated ? g : g.subsetPrims(keep, p.remove_unused_points);
    }
    return g.subsetPoints(keep);
  },
});

// ---------------------------------------------------------------- measure / connectivity / sort

defineNode({
  type: 'measure',
  category: 'attribute',
  summary: 'Measure prim area/perimeter, curve length, per-piece volume/area, or point curvature into attributes.',
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    measure: { type: 'enum', options: ['area', 'perimeter', 'length', 'volume', 'curvature', 'total_area'], default: 'area', desc: 'what to measure (volume/total_area per connected piece; curvature = point mean-curvature proxy)' },
    name: { type: 'string', default: '', desc: 'output attribute ("" = the measure name)' },
  },
  outputs: 'prim area/perimeter/length/volume, point curvature',
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const name = p.name || p.measure;
    if (p.measure === 'curvature') {
      const N = pointNormals(g);
      const { start, nb } = neighborsOf(g);
      const a = g.points.add(name, 'float', 1).data as Float64Array;
      const Pd = g.P;
      for (let i = 0; i < g.numPoints; i++) {
        let s = 0, c = 0;
        for (let k = start[i]; k < start[i + 1]; k++) {
          const j = nb[k];
          const dx = Pd[j * 3] - Pd[i * 3], dy = Pd[j * 3 + 1] - Pd[i * 3 + 1], dz = Pd[j * 3 + 2] - Pd[i * 3 + 2];
          const l2 = dx * dx + dy * dy + dz * dz;
          if (l2 > 0) { s += (2 * (dx * N[i * 3] + dy * N[i * 3 + 1] + dz * N[i * 3 + 2])) / l2; c++; }
        }
        a[i] = c ? -s / c : 0;
      }
      return g;
    }
    const a = g.prims.add(name, 'float', 1).data as Float64Array;
    if (p.measure === 'area') for (let pr = 0; pr < g.numPrims; pr++) a[pr] = primArea(g, pr);
    else if (p.measure === 'perimeter' || p.measure === 'length') for (let pr = 0; pr < g.numPrims; pr++) a[pr] = primPerimeter(g, pr);
    else {
      const conn = connectivity(g);
      const acc = new Float64Array(conn.count);
      for (let k = 0; k < conn.count; k++) {
        const piece = g.subsetPrims(Uint8Array.from(conn.primClass, (c) => (c === k ? 1 : 0)), true);
        acc[k] = p.measure === 'volume' ? Math.abs(signedVolume(piece)) : Array.from({ length: piece.numPrims }, (_, i) => primArea(piece, i)).reduce((s, x) => s + x, 0);
      }
      for (let pr = 0; pr < g.numPrims; pr++) a[pr] = conn.primClass[pr] >= 0 ? acc[conn.primClass[pr]] : 0;
    }
    return g;
  },
});

function neighborsOf(g: Geometry) {
  // local import to avoid a cycle in docs ordering
  const cnt = new Int32Array(g.numPoints + 1);
  const pairs: number[] = [];
  for (let pr = 0; pr < g.numPrims; pr++) {
    const s = g.primStart[pr], e = g.primStart[pr + 1];
    const last = g.primClosed[pr] ? e : e - 1;
    for (let v = s; v < last; v++) { const a = g.vertexPoint[v], b = g.vertexPoint[v + 1 < e ? v + 1 : s]; pairs.push(a, b); cnt[a + 1]++; cnt[b + 1]++; }
  }
  for (let i = 0; i < g.numPoints; i++) cnt[i + 1] += cnt[i];
  const nb = new Int32Array(pairs.length), fill = cnt.slice(0, g.numPoints);
  for (let k = 0; k < pairs.length; k += 2) { nb[fill[pairs[k]]++] = pairs[k + 1]; nb[fill[pairs[k + 1]]++] = pairs[k]; }
  return { start: cnt, nb };
}

defineNode({
  type: 'connectivity',
  category: 'attribute',
  summary: 'Label connected pieces with an integer attribute (default "class"), optionally a string "name".',
  aliases: ['pieces', 'label_pieces'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    class: { type: 'enum', options: ['prim', 'point'], default: 'prim', desc: 'where to write the piece id' },
    attrib: { type: 'string', default: 'class', desc: 'int attribute name' },
    name_prefix: { type: 'string', default: '', desc: 'if set, also write prim string attribute "name" = prefix + id' },
  },
  outputs: 'class (int), optional prim name',
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const c = connectivity(g);
    if (p.class === 'prim') (g.prims.add(p.attrib, 'int', 1).data as Int32Array).set(c.primClass);
    else (g.points.add(p.attrib, 'int', 1).data as Int32Array).set(c.ptClass);
    if (p.name_prefix) {
      const a = g.prims.add('name', 'string', 1);
      for (let pr = 0; pr < g.numPrims; pr++) a.set(pr, p.name_prefix + c.primClass[pr]);
    }
    g.detail.add('piece_count', 'int', 1).set(0, c.count);
    return g;
  },
});

defineNode({
  type: 'sort',
  category: 'topology',
  summary: 'Reorder points or prims: by axis, random, attribute value, or reverse.',
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    class: { type: 'enum', options: ['point', 'prim'], default: 'point', desc: 'what to sort' },
    by: { type: 'enum', options: ['x', 'y', 'z', 'random', 'attribute', 'reverse'], default: 'x', desc: 'sort key' },
    attrib: { type: 'string', default: '', desc: 'attribute for by=attribute (first component)' },
    descending: { type: 'bool', default: false, desc: 'reverse the order' },
    seed: P.seed(),
  },
  cook: ({ input, p }) => {
    const g = input(0);
    const n = p.class === 'point' ? g.numPoints : g.numPrims;
    let key: (i: number) => number;
    const pos = (i: number) => (p.class === 'point' ? [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]] : primCentroid(g, i));
    if (p.by === 'random') key = (i) => rand(i, p.seed);
    else if (p.by === 'reverse') key = (i) => -i;
    else if (p.by === 'attribute') {
      const a = g.table(p.class).get(p.attrib);
      if (!a) throw new NodeError(`no ${p.class} attribute "${p.attrib}"`);
      key = (i) => { const v = a.get(i); return Array.isArray(v) ? v[0] : typeof v === 'string' ? 0 : v; };
    } else { const ax = 'xyz'.indexOf(p.by); key = (i) => pos(i)[ax]; }
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => key(a) - key(b) || a - b);
    if (p.descending) order.reverse();
    if (p.class === 'prim') {
      const out = g.clone();
      const vtx: number[] = [], starts = [0];
      for (const pr of order) { for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) vtx.push(v); starts.push(vtx.length); }
      out.prims = g.prims.gather(order);
      out.vertices = g.vertices.gather(vtx);
      out.primStart = Int32Array.from(starts);
      out.vertexPoint = Int32Array.from(vtx, (v) => g.vertexPoint[v]);
      out.primClosed = Uint8Array.from(order, (pr) => g.primClosed[pr]);
      out.primGroups = new Map([...g.primGroups].map(([k, m]) => [k, Uint8Array.from(order, (pr) => m[pr])]));
      return out;
    }
    const inv = new Int32Array(n);
    order.forEach((old, nw) => (inv[old] = nw));
    const out = g.clone();
    out.points = g.points.gather(order);
    for (let v = 0; v < out.numVertices; v++) out.vertexPoint[v] = inv[g.vertexPoint[v]];
    out.pointGroups = new Map([...g.pointGroups].map(([k, m]) => [k, Uint8Array.from(order, (i) => m[i])]));
    return out;
  },
});

// ---------------------------------------------------------------- normals / uv

defineNode({
  type: 'normal',
  category: 'topology',
  summary: 'Compute normals N on points (smooth), vertices (hard edges above the cusp angle) or prims (flat).',
  aliases: ['normals', 'compute_normals'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    class: { type: 'enum', options: ['vertex', 'point', 'prim'], default: 'vertex', desc: 'vertex = smooth with hard edges past cusp_angle' },
    cusp_angle: { type: 'float', default: 60, min: 0, max: 180, desc: 'vertex mode: faces meeting sharper than this keep hard edges' },
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    for (const c of ['point', 'vertex', 'prim'] as const) if (c !== p.class) g.table(c).delete('N');
    const data = p.class === 'point' ? pointNormals(g) : p.class === 'prim' ? primNormals(g) : vertexNormals(g, p.cusp_angle);
    (g.table(p.class).add('N', 'float', 3).data as Float64Array).set(data);
    return g;
  },
});

defineNode({
  type: 'uv_project',
  category: 'uv',
  summary: 'Project UVs: planar, box (tri-planar per face), cylindrical or spherical.',
  aliases: ['uvproject', 'texture', 'uv_texture'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    method: { type: 'enum', options: ['box', 'planar', 'cylindrical', 'spherical'], default: 'box', desc: 'projection type' },
    axis: { type: 'enum', options: ['y', 'x', 'z'], default: 'y', desc: 'projection axis (planar normal / cylinder axis)' },
    scale: { type: 'vec2', default: [1, 1], desc: 'world units per UV tile (box/planar); tiles around (cyl/sph)' },
    offset: { type: 'vec2', default: [0, 0], desc: 'uv offset' },
    center: { type: 'vec3', default: [0, 0, 0], desc: 'projection center (cyl/sph)' },
  },
  outputs: 'vertex uv',
  cook: ({ input, p }) => {
    const g = input(0).clone();
    g.points.delete('uv');
    const uv = g.vertices.add('uv', 'float', 3).data as Float64Array;
    const pn = primNormals(g), vprim = g.vertexPrims();
    const Pd = g.P;
    const ax = 'xyz'.indexOf(p.axis);
    for (let v = 0; v < g.numVertices; v++) {
      const pt = g.vertexPoint[v];
      const x = Pd[pt * 3], y = Pd[pt * 3 + 1], z = Pd[pt * 3 + 2];
      let u = 0, w = 0;
      if (p.method === 'planar' || p.method === 'box') {
        let a = ax;
        if (p.method === 'box') {
          const pr = vprim[v];
          const n = [Math.abs(pn[pr * 3]), Math.abs(pn[pr * 3 + 1]), Math.abs(pn[pr * 3 + 2])];
          a = n[0] >= n[1] && n[0] >= n[2] ? 0 : n[1] >= n[2] ? 1 : 2;
        }
        const q = [x, y, z];
        const [i0, i1] = a === 0 ? [2, 1] : a === 1 ? [0, 2] : [0, 1];
        u = q[i0] / p.scale[0]; w = q[i1] / p.scale[1];
      } else {
        const d = [x - p.center[0], y - p.center[1], z - p.center[2]];
        const i0 = (ax + 1) % 3, i1 = (ax + 2) % 3;
        const ang = Math.atan2(d[i1], d[i0]) / (2 * Math.PI) + 0.5;
        if (p.method === 'cylindrical') { u = ang * p.scale[0]; w = d[ax] / p.scale[1]; }
        else { const r = Math.hypot(d[0], d[1], d[2]) || 1; u = ang * p.scale[0]; w = (Math.acos(Math.max(-1, Math.min(1, d[ax] / r))) / Math.PI) * p.scale[1]; }
      }
      uv[v * 3] = u + p.offset[0]; uv[v * 3 + 1] = w + p.offset[1]; uv[v * 3 + 2] = 0;
    }
    return g;
  },
});

defineNode({
  type: 'uv_transform',
  category: 'uv',
  summary: 'Translate / scale / rotate existing UVs (vertex or point uv).',
  aliases: ['uvtransform'],
  inputs: [{ name: 'geo', desc: 'geometry with uv' }],
  params: {
    translate: { type: 'vec2', default: [0, 0], desc: 'offset', aliases: ['t'] },
    scale: { type: 'vec2', default: [1, 1], desc: 'scale', aliases: ['s'] },
    rotate: { type: 'float', default: 0, desc: 'degrees', aliases: ['r'] },
    pivot: { type: 'vec2', default: [0.5, 0.5], desc: 'pivot' },
  },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const f = g.findAttrib('uv', ['vertex', 'point']);
    if (!f) throw new NodeError('no uv attribute (run uv_project first)');
    const d = f.attr.data as Float64Array, s = f.attr.size;
    const a = (p.rotate * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    for (let i = 0; i < f.attr.count; i++) {
      let u = (d[i * s] - p.pivot[0]) * p.scale[0], v = (d[i * s + 1] - p.pivot[1]) * p.scale[1];
      [u, v] = [u * c - v * sn, u * sn + v * c];
      d[i * s] = u + p.pivot[0] + p.translate[0];
      d[i * s + 1] = v + p.pivot[1] + p.translate[1];
    }
    return g;
  },
});
