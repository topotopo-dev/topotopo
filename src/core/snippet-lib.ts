// The function below is stringified and evaluated INSIDE the scripting realm, so it
// must be completely self-contained: no imports, no references to outer scope.
// It installs VEX-flavoured helpers as globals. Numeric results cross realms freely;
// arrays are always created here so they get the realm's Array.prototype accessors
// (.x .y .z .w / .r .g .b .a / .u .v).
//
// `host` supplies number-returning primitives implemented in the engine realm
// (noise, hashing). Geometry query/edit functions dispatch through globalThis.__cur,
// which the engine sets for each wrangle run.

export function installSnippetLib(g: any, host: any) {
  const AP = g.Array.prototype;
  const acc = (name: string, i: number) =>
    Object.defineProperty(AP, name, {
      get() { return this[i]; },
      set(v) { this[i] = v; },
      enumerable: false,
      configurable: true,
    });
  acc('x', 0); acc('y', 1); acc('z', 2); acc('w', 3);
  acc('r', 0); acc('g', 1); acc('b', 2); acc('a', 3);
  acc('u', 0); acc('v', 1);

  const isA = Array.isArray;
  const toArr = (v: any) => (v == null ? v : isA(v) || ArrayBuffer.isView(v) ? Array.from(v as any) : v);
  const map2 = (a: any, b: any, f: (x: number, y: number) => number): any => {
    if (isA(a) && isA(b)) { const n = Math.max(a.length, b.length), o = new Array(n); for (let i = 0; i < n; i++) o[i] = f(a[i] ?? 0, b[i] ?? 0); return o; }
    if (isA(a)) { const o = new Array(a.length); for (let i = 0; i < a.length; i++) o[i] = f(a[i], b); return o; }
    if (isA(b)) { const o = new Array(b.length); for (let i = 0; i < b.length; i++) o[i] = f(a, b[i]); return o; }
    return f(a, b);
  };
  const map1 = (a: any, f: (x: number) => number): any => (isA(a) ? a.map(f) : f(a));

  const L: Record<string, any> = {};
  L.PI = Math.PI; L.TAU = Math.PI * 2; L.E = Math.E;
  for (const k of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'exp', 'log', 'log2', 'log10', 'sqrt', 'cbrt', 'trunc'])
    L[k] = (a: any) => map1(a, (Math as any)[k]);
  L.atan2 = (y: number, x: number) => Math.atan2(y, x);
  L.pow = (a: any, b: any) => map2(a, b, Math.pow);
  L.abs = (a: any) => map1(a, Math.abs);
  L.floor = (a: any) => map1(a, Math.floor);
  L.ceil = (a: any) => map1(a, Math.ceil);
  L.round = (a: any) => map1(a, Math.round);
  L.sign = (a: any) => map1(a, Math.sign);
  L.frac = (a: any) => map1(a, (x) => x - Math.floor(x));
  L.mod = (a: any, b: any) => map2(a, b, (x, y) => ((x % y) + y) % y);
  // min/max of several values are component-wise; of ONE array they return its smallest/largest entry (VEX)
  const extreme = (a: any[], less: boolean) => {
    if (!a.length) return 0;
    let m = a[0];
    for (let i = 1; i < a.length; i++) if (less ? a[i] < m : a[i] > m) m = a[i];
    return m;
  };
  L.min = (a: any, ...r: any[]) => (!r.length && isA(a) ? extreme(a, true) : r.reduce((m, b) => map2(m, b, Math.min), a));
  L.max = (a: any, ...r: any[]) => (!r.length && isA(a) ? extreme(a, false) : r.reduce((m, b) => map2(m, b, Math.max), a));
  L.clamp = (x: any, lo: any, hi: any) => map2(map2(x, lo, Math.max), hi, Math.min);
  L.radians = (d: any) => map1(d, (x) => (x * Math.PI) / 180);
  L.degrees = (r: any) => map1(r, (x) => (x * 180) / Math.PI);

  L.vec2 = (x = 0, y = x) => [x, y];
  L.vec3 = (x = 0, y = x, z = y) => [x, y, z];
  L.vec4 = (x = 0, y = x, z = y, w = z) => [x, y, z, w];
  L.set = (...a: number[]) => a.slice();
  L.add = (a: any, ...r: any[]) => r.reduce((m, b) => map2(m, b, (x, y) => x + y), a);
  L.sub = (a: any, b: any) => map2(a, b, (x, y) => x - y);
  L.mul = (a: any, ...r: any[]) => r.reduce((m, b) => map2(m, b, (x, y) => x * y), a);
  L.div = (a: any, b: any) => map2(a, b, (x, y) => x / y);
  L.neg = (a: any) => map1(a, (x) => -x);
  L.dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]; return s; };
  L.cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  L.length2 = (a: any) => (isA(a) ? a.reduce((s: number, x: number) => s + x * x, 0) : a * a);
  L.length = (a: any) => Math.sqrt(L.length2(a));
  L.distance = (a: any, b: any) => L.length(L.sub(a, b));
  L.distance2 = (a: any, b: any) => L.length2(L.sub(a, b));
  L.normalize = (a: number[]) => { const l = L.length(a); return l > 1e-20 ? a.map((x) => x / l) : a.map(() => 0); };
  L.lerp = L.mix = (a: any, b: any, t: number) => map2(a, b, (x, y) => x + (y - x) * t);
  L.fit = (x: any, a: number, b: number, c: any, d: any) => {
    const t = map1(x, (v) => (b === a ? 0 : Math.min(1, Math.max(0, (v - a) / (b - a)))));
    return isA(c) || isA(d) ? L.lerp(c, d, t as number) : map1(t, (tt) => c + (d - c) * tt);
  };
  L.fit01 = (x: any, c: any, d: any) => L.fit(x, 0, 1, c, d);
  L.fit11 = (x: any, c: any, d: any) => L.fit(x, -1, 1, c, d);
  L.efit = (x: any, a: number, b: number, c: number, d: number) => map1(x, (v) => c + ((v - a) / (b - a)) * (d - c));
  L.smoothstep = L.smooth = (e0: number, e1: number, x: any) =>
    map1(x, (v) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); });
  L.avg = (...a: any[]) => { if (a.length === 1 && isA(a[0])) a = a[0]; return a.length ? L.div(L.add(...(a as [any])), a.length) : 0; };
  L.sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

  // arrays (array attributes read as JS arrays: f[]@ i[]@ s[]@). All return new arrays; inputs are not modified.
  L.len = (a: any) => (a == null ? 0 : typeof a === 'object' || typeof a === 'string' ? (a.length ?? 0) : 1);
  L.append = (a: any[], ...v: any[]) => { const o = Array.from(a ?? []); for (const x of v) o.push(x); return o; };
  L.concat = (...arrs: any[][]) => { const o: any[] = []; for (const a of arrs) for (const x of a ?? []) o.push(x); return o; };
  L.slice = (a: any, start = 0, end?: number) => (typeof a === 'string' ? a.slice(start, end) : Array.from(a ?? []).slice(start, end));
  L.find = (a: any, v: any) => (a == null ? -1 : a.indexOf(v));
  const cmp = (x: any, y: any) => (typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0);
  L.sort = (a: any[]) => Array.from(a ?? []).sort(cmp);
  L.argsort = (a: any[]) => Array.from(a ?? [], (_: any, i: number) => i).sort((i: number, j: number) => cmp(a[i], a[j]) || i - j);
  L.reverse = (a: any) => (typeof a === 'string' ? a.split('').reverse().join('') : Array.from(a ?? []).reverse());
  L.unique = (a: any[]) => Array.from(new Set(a ?? []));
  L.uniquevals = (a: any[]) => L.sort(L.unique(a));
  L.isvalidindex = (a: any, i: number) => a != null && Number.isInteger(i) && i >= 0 && i < a.length;
  L.reflect = (d: number[], n: number[]) => L.sub(d, L.mul(n, 2 * L.dot(d, n)));
  L.project = (a: number[], b: number[]) => L.mul(b, L.dot(a, b) / (L.dot(b, b) || 1));

  // rotations (angles in RADIANS, like VEX)
  L.quaternion = (angle: any, axis?: number[]) => {
    if (axis === undefined && isA(angle)) return L.eulertoquaternion(angle);
    const a = L.normalize(axis ?? [0, 1, 0]), h = angle / 2, s = Math.sin(h);
    return [a[0] * s, a[1] * s, a[2] * s, Math.cos(h)];
  };
  L.qmultiply = (a: number[], b: number[]) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  L.qrotate = (q: number[], v: number[]) => {
    const [x, y, z, w] = q;
    const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2];
    const iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  };
  L.qinvert = (q: number[]) => [-q[0], -q[1], -q[2], q[3]];
  L.eulertoquaternion = (r: number[], order = 'xyz') => {
    let q = [0, 0, 0, 1];
    for (const ax of order) {
      const i = ax === 'x' ? 0 : ax === 'y' ? 1 : 2;
      const axis = [0, 0, 0]; axis[i] = 1;
      q = L.qmultiply(L.quaternion(r[i], axis), q);
    }
    return q;
  };
  L.dihedral = (a: number[], b: number[]) => {
    const na = L.normalize(a), nb = L.normalize(b), d = L.dot(na, nb);
    if (d < -0.999999) {
      let ax = L.cross([1, 0, 0], na);
      if (L.length(ax) < 1e-6) ax = L.cross([0, 1, 0], na);
      ax = L.normalize(ax);
      return [ax[0], ax[1], ax[2], 0];
    }
    const c = L.cross(na, nb), q = [c[0], c[1], c[2], 1 + d], l = L.length(q);
    return q.map((x: number) => x / l);
  };
  L.slerp = (a: number[], b: number[], t: number) => {
    let cos = L.dot(a, b), bb = b;
    if (cos < 0) { cos = -cos; bb = b.map((x) => -x); }
    if (cos > 0.9995) return L.normalize(L.lerp(a, bb, t));
    const th = Math.acos(cos), s = Math.sin(th);
    return L.add(L.mul(a, Math.sin((1 - t) * th) / s), L.mul(bb, Math.sin(t * th) / s));
  };
  /** quaternion whose +Z axis points along dir and +Y toward up (copy_to_points convention) */
  L.lookat = (dir: number[], up: number[] = [0, 1, 0]) => {
    const z = L.normalize(dir);
    let x = L.cross(up, z);
    if (L.length(x) < 1e-8) x = L.cross(Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], z);
    x = L.normalize(x);
    const y = L.cross(z, x);
    const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2];
    const tr = m00 + m11 + m22;
    let q;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]; }
    else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
    else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
    else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
    return L.normalize(q);
  };
  /** rotate vector v around axis by angle (radians) */
  L.rotate = (v: number[], angle: number, axis: number[] = [0, 1, 0]) => L.qrotate(L.quaternion(angle, axis), v);

  // randomness (deterministic hashes; never Math.random)
  L.rand = (...a: any[]) => host.rand(a.flat(4));
  L.randv = (...a: any[]) => { const s = a.flat(4); return [host.rand([...s, 0.11]), host.rand([...s, 0.37]), host.rand([...s, 0.73])]; };
  L.randdir = (...a: any[]) => {
    const s = a.flat(4), z = host.rand([...s, 1.3]) * 2 - 1, t = host.rand([...s, 2.9]) * Math.PI * 2, r = Math.sqrt(1 - z * z);
    return [r * Math.cos(t), z, r * Math.sin(t)];
  };
  L.randrange = (seed: any, lo: number, hi: number) => lo + host.rand([seed]) * (hi - lo);
  L.randint = (seed: any, lo: number, hi: number) => Math.floor(lo + host.rand([seed]) * (hi - lo + 1));
  L.pick = (arr: any[], seed: any) => arr[Math.floor(host.rand([seed]) * arr.length) % arr.length];
  L.shuffle = (arr: any[], seed: any) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(host.rand([seed, i]) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };

  // noise: p may be number | [x,y] | [x,y,z]; results ~[-1,1] (worley: distance ≥ 0)
  const P3 = (p: any) => (isA(p) ? [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0] : [p, 0, 0]);
  L.noise = (p: any, seed = 0) => { const q = P3(p); return host.noise('perlin', seed, q[0], q[1], q[2]); };
  L.snoise = (p: any, seed = 0) => { const q = P3(p); return host.noise('simplex', seed, q[0], q[1], q[2]); };
  L.vnoise = (p: any, seed = 0) => { const q = P3(p); return [host.noise('perlin', seed, q[0], q[1], q[2]), host.noise('perlin', seed + 101, q[0], q[1], q[2]), host.noise('perlin', seed + 202, q[0], q[1], q[2])]; };
  L.worley = (p: any, seed = 0) => { const q = P3(p); return host.noise('worley', seed, q[0], q[1], q[2]); };
  L.fbm = (p: any, octaves = 4, lacunarity = 2, gain = 0.5, seed = 0) => {
    const q = P3(p); let s = 0, a = 1, f = 1, n = 0;
    for (let i = 0; i < octaves; i++) { s += a * host.noise('perlin', seed, q[0] * f + i * 17.1, q[1] * f + i * 9.7, q[2] * f + i * 3.3); n += a; a *= gain; f *= lacunarity; }
    return s / n;
  };
  L.ridged = (p: any, octaves = 4, lacunarity = 2, gain = 0.5, seed = 0) => {
    const q = P3(p); let s = 0, a = 1, f = 1, n = 0;
    for (let i = 0; i < octaves; i++) { const r = 1 - Math.abs(host.noise('perlin', seed, q[0] * f + i * 17.1, q[1] * f + i * 9.7, q[2] * f + i * 3.3)); s += a * r * r; n += a; a *= gain; f *= lacunarity; }
    return s / n;
  };
  L.curlnoise = (p: any, seed = 0) => { const q = P3(p); const r = host.curl(seed, q[0], q[1], q[2]); return [r[0], r[1], r[2]]; };

  // colour
  L.hsv2rgb = (h: any, s?: number, v?: number) => {
    if (isA(h)) [h, s, v] = h;
    h = (((h as number) % 1) + 1) % 1;
    const i = Math.floor(h * 6), f = h * 6 - i, p = v! * (1 - s!), q = v! * (1 - f * s!), t = v! * (1 - (1 - f) * s!);
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6].slice();
  };
  L.rgb2hsv = (r: any, gg?: number, b?: number) => {
    if (isA(r)) [r, gg, b] = r;
    const mx = Math.max(r, gg!, b!), mn = Math.min(r, gg!, b!), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((gg! - b!) / d) % 6 : mx === gg ? (b! - r) / d + 2 : (r - gg!) / d + 4;
    return [((h / 6) % 1 + 1) % 1, mx ? d / mx : 0, mx];
  };
  L.ramp = (keys: any[], t: number) => {
    if (!keys.length) return 0;
    const k = keys.map((e: any) => (isA(e) ? { pos: e[0], value: e.length > 2 ? e.slice(1) : e[1] } : e));
    if (t <= k[0].pos) return toArr(k[0].value);
    for (let i = 0; i < k.length - 1; i++)
      if (t <= k[i + 1].pos) { const u = (t - k[i].pos) / (k[i + 1].pos - k[i].pos || 1); return L.lerp(k[i].value, k[i + 1].value, u); }
    return toArr(k[k.length - 1].value);
  };

  // geometry access — inputs: 0 = geometry being processed (pre-edit), 1..3 = other inputs
  const C = () => g.__cur;
  L.npoints = (i = 0) => C().npoints(i);
  L.nprims = (i = 0) => C().nprims(i);
  L.nvertices = (i = 0) => C().nvertices(i);
  L.point = (i: number, name: string, pt: number) => toArr(C().attr(i, 'point', name, pt));
  L.prim = (i: number, name: string, pr: number) => toArr(C().attr(i, 'prim', name, pr));
  L.vertex = (i: number, name: string, v: number) => toArr(C().attr(i, 'vertex', name, v));
  L.detail = (i: number, name: string) => toArr(C().attr(i, 'detail', name, 0));
  L.haspointattrib = (i: number, name: string) => C().hasattr(i, 'point', name);
  L.hasprimattrib = (i: number, name: string) => C().hasattr(i, 'prim', name);
  L.primpoints = (i: number, pr: number) => toArr(C().primpoints(i, pr));
  L.pointprims = (i: number, pt: number) => toArr(C().pointprims(i, pt));
  L.neighbours = L.neighbors = (i: number, pt: number) => toArr(C().neighbours(i, pt));
  L.neighbourcount = (i: number, pt: number) => C().neighbours(i, pt).length;
  L.primvertexcount = (i: number, pr: number) => C().primpoints(i, pr).length;
  L.nearpoint = (i: number, pos: number[], maxd = Infinity) => C().nearpoint(i, pos, maxd);
  L.nearpoints = (i: number, pos: number[], maxd = Infinity, maxn = 1e9) => toArr(C().nearpoints(i, pos, maxd, maxn));
  L.xyzdist = (i: number, pos: number[]) => C().closest(i, pos).dist;
  L.minpos = (i: number, pos: number[]) => toArr(C().closest(i, pos).pos);
  L.closest = (i: number, pos: number[]) => { const r = C().closest(i, pos); return { dist: r.dist, pos: toArr(r.pos), prim: r.prim }; };
  L.intersect = (i: number, orig: number[], dir: number[]) => {
    const r = C().intersect(i, orig, dir);
    return r ? { prim: r.prim, pos: toArr(r.pos), dist: r.dist } : { prim: -1, pos: toArr(orig), dist: -1 };
  };
  L.inpointgroup = (i: number, grp: string, pt: number) => C().ingroup(i, 'point', grp, pt);
  L.inprimgroup = (i: number, grp: string, pr: number) => C().ingroup(i, 'prim', grp, pr);
  L.invertexgroup = (i: number, grp: string, v: number) => C().ingroup(i, 'vertex', grp, v);
  L.inedgegroup = (i: number, grp: string, a: number, b: number) => C().inedgegroup(i, grp, a, b);
  L.pointattribtype = (i: number, name: string) => C().attrtype(i, 'point', name);

  // edits (applied after the wrangle finishes, like VEX). geohandle 0 may be omitted.
  const h = (a: any[]) => (typeof a[0] === 'number' && a.length > 1 && !isA(a[0]) && a[0] === 0 ? a.slice(1) : a);
  L.addpoint = (...a: any[]) => { const r = h(a); return C().addpoint(isA(r[0]) ? r[0] : r.length >= 3 ? [r[0], r[1], r[2]] : r[0]); };
  L.addprim = (...a: any[]) => {
    // addprim(0, "poly", [pts]) | addprim([pts], closed=true) | addprim(0, "polyline", p0, p1, ...)
    const r = h(a);
    if (typeof r[0] === 'string') {
      const closed = r[0] !== 'polyline';
      const pts = isA(r[1]) ? r[1] : r.slice(1);
      return C().addprim(pts, closed);
    }
    return C().addprim(r[0], r[1] ?? true);
  };
  L.removepoint = (...a: any[]) => { const r = h(a); C().removepoint(r[0]); };
  L.removeprim = (...a: any[]) => { const r = h(a); C().removeprim(r[0], r[1] ?? true); };
  L.setpointattrib = (...a: any[]) => { const r = h(a); C().setattr('point', r[0], r[1], r[2]); };
  L.setprimattrib = (...a: any[]) => { const r = h(a); C().setattr('prim', r[0], r[1], r[2]); };
  L.setvertexattrib = (...a: any[]) => { const r = h(a); C().setattr('vertex', r[0], r[1], r[2]); };
  L.setdetailattrib = (...a: any[]) => { const r = h(a); C().setattr('detail', r[0], 0, r[1]); };
  L.setpointgroup = (...a: any[]) => { const r = h(a); C().setgroup('point', r[0], r[1], r[2] ?? 1); };
  L.setprimgroup = (...a: any[]) => { const r = h(a); C().setgroup('prim', r[0], r[1], r[2] ?? 1); };
  L.setvertexgroup = (...a: any[]) => { const r = h(a); C().setgroup('vertex', r[0], r[1], r[2] ?? 1); };
  // setedgegroup(0, "name", pt0, pt1, value=1)
  L.setedgegroup = (...a: any[]) => { const r = h(a); C().setedgegroup(r[0], r[1], r[2], r[3] ?? 1); };

  L.print = L.printf = (...a: any[]) => C().log(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '));
  L.warning = (m: string) => C().log('warning: ' + m);
  L.error = (m: string) => { throw new Error(m); };

  // -------- SDF primitives & operators (Inigo Quilez conventions; negative = inside)
  const len3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);
  L.sdSphere = (p: number[], r = 1) => len3(p[0], p[1], p[2]) - r;
  L.sdBox = (p: number[], b: number[] = [1, 1, 1]) => {
    const qx = Math.abs(p[0]) - b[0], qy = Math.abs(p[1]) - b[1], qz = Math.abs(p[2]) - b[2];
    return len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
  };
  L.sdRoundBox = (p: number[], b: number[], r: number) => L.sdBox(p, [b[0] - r, b[1] - r, b[2] - r]) - r;
  L.sdTorus = (p: number[], R = 1, r = 0.25) => { const q = Math.hypot(p[0], p[2]) - R; return Math.hypot(q, p[1]) - r; };
  L.sdCapsule = (p: number[], a: number[], b: number[], r: number) => {
    const pa = L.sub(p, a), ba = L.sub(b, a), t = Math.min(1, Math.max(0, L.dot(pa, ba) / (L.dot(ba, ba) || 1)));
    return L.length(L.sub(pa, L.mul(ba, t))) - r;
  };
  L.sdCylinder = (p: number[], h = 1, r = 0.5) => {
    const dx = Math.hypot(p[0], p[2]) - r, dy = Math.abs(p[1]) - h / 2;
    return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  };
  L.sdCone = (p: number[], h = 1, r = 0.5) => {
    // cone with base radius r at y=0 and apex at y=h
    const q = [Math.hypot(p[0], p[2]), p[1]];
    const k1 = [0, h], k2 = [-r, 2 * h];
    const ca = [q[0] - Math.min(q[0], q[1] < 0 ? r : 0), Math.abs(q[1] - h / 2) - h / 2];
    const t = Math.min(1, Math.max(0, ((k1[0] - q[0]) * k2[0] + (k1[1] - q[1]) * k2[1]) / (k2[0] * k2[0] + k2[1] * k2[1])));
    const cb = [q[0] - k1[0] + k2[0] * t, q[1] - k1[1] + k2[1] * t];
    const s = cb[0] < 0 && ca[1] < 0 ? -1 : 1;
    return s * Math.sqrt(Math.min(ca[0] * ca[0] + ca[1] * ca[1], cb[0] * cb[0] + cb[1] * cb[1]));
  };
  L.sdEllipsoid = (p: number[], r: number[]) => {
    const k0 = len3(p[0] / r[0], p[1] / r[1], p[2] / r[2]), k1 = len3(p[0] / (r[0] * r[0]), p[1] / (r[1] * r[1]), p[2] / (r[2] * r[2]));
    return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(r[0], r[1], r[2]);
  };
  L.sdPlane = (p: number[], n: number[] = [0, 1, 0], h = 0) => L.dot(p, L.normalize(n)) + h;
  L.sdOctahedron = (p: number[], s = 1) => (Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]) - s) * 0.57735027;
  L.sdHexPrism = (p: number[], h: number[] = [0.5, 0.5]) => {
    const k = [-0.8660254, 0.5, 0.57735];
    let px = Math.abs(p[0]), py = Math.abs(p[1]); const pz = Math.abs(p[2]);
    const d0 = 2 * Math.min(k[0] * px + k[1] * py, 0);
    px -= d0 * k[0]; py -= d0 * k[1];
    const cx = Math.min(Math.max(px, -k[2] * h[0]), k[2] * h[0]);
    const dx = Math.hypot(px - cx, py - h[0]) * Math.sign(py - h[0]), dy = pz - h[1];
    return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  };
  L.sdSegment = (p: number[], a: number[], b: number[], r = 0.1) => L.sdCapsule(p, a, b, r);
  L.opUnion = (a: number, b: number) => Math.min(a, b);
  L.opSubtract = (a: number, b: number) => Math.max(a, -b); // a minus b
  L.opIntersect = (a: number, b: number) => Math.max(a, b);
  L.smin = L.opSmoothUnion = (a: number, b: number, k = 0.1) => {
    if (k <= 0) return Math.min(a, b);
    const hh = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.min(a, b) - hh * hh * k * 0.25;
  };
  L.smax = L.opSmoothIntersect = (a: number, b: number, k = 0.1) => -L.smin(-a, -b, k);
  L.opSmoothSubtract = (a: number, b: number, k = 0.1) => L.smax(a, -b, k);
  L.opRound = (d: number, r: number) => d - r;
  L.opOnion = (d: number, t: number) => Math.abs(d) - t;
  L.opRepeat = (p: number[], c: number[]) => p.map((v, i) => (c[i] ? v - c[i] * Math.round(v / c[i]) : v));
  L.opTwist = (p: number[], k: number) => { const c = Math.cos(k * p[1]), s = Math.sin(k * p[1]); return [c * p[0] - s * p[2], p[1], s * p[0] + c * p[2]]; };
  L.opBend = (p: number[], k: number) => { const c = Math.cos(k * p[0]), s = Math.sin(k * p[0]); return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]]; };
  L.opTranslate = (p: number[], t: number[]) => L.sub(p, t);
  L.opRotateY = (p: number[], a: number) => { const c = Math.cos(a), s = Math.sin(a); return [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]]; };
  L.opRotateX = (p: number[], a: number) => { const c = Math.cos(a), s = Math.sin(a); return [p[0], c * p[1] + s * p[2], -s * p[1] + c * p[2]]; };
  L.opRotateZ = (p: number[], a: number) => { const c = Math.cos(a), s = Math.sin(a); return [c * p[0] + s * p[1], -s * p[0] + c * p[1], p[2]]; };
  L.opMirrorX = (p: number[]) => [Math.abs(p[0]), p[1], p[2]];

  // internal write helpers used by generated wrangle kernels
  L.__wf = (d: any, i: number, s: number, v: any) => {
    const o = i * s;
    if (typeof v === 'number') { for (let c = 0; c < s; c++) d[o + c] = v; return; }
    if (typeof v === 'boolean') { for (let c = 0; c < s; c++) d[o + c] = v ? 1 : 0; return; }
    if (v && v.length !== undefined) { for (let c = 0; c < s; c++) d[o + c] = c < v.length ? +v[c] : 0; return; }
    for (let c = 0; c < s; c++) d[o + c] = NaN;
  };
  L.__rd = (d: any, i: number, s: number) => { const o = i * s, a = new Array(s); for (let c = 0; c < s; c++) a[c] = d[o + c]; return a; };
  // array attribute element i as a realm array (a copy; the kernel writes it back with attr.set)
  L.__ga = (attr: any, i: number) => attr.getArray(i, []);
  L.__arr = toArr;

  for (const k of Object.keys(L)) g[k] = L[k];
  g.__snippetLibNames = Object.keys(L).filter((k) => !k.startsWith('__'));
}
