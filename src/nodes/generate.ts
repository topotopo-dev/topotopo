// Generators: primitives, point sets, parametric shapes, terrain.
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { Vec3 } from '../core/math.ts';
import { orientOutward, pointNormals, primNewell } from '../core/topology.ts';
import { rng } from '../core/random.ts';
import { fractal, makeNoise } from '../core/noise.ts';
import { FRAMES, P } from './util.ts';
import type { PlaneName } from './util.ts';

// ---------------------------------------------------------------- shared builders

export function makeBox(size: Vec3, center: Vec3, div: number[]): Geometry {
  const b = new GeoBuilder();
  const key = new Map<number, number>();
  const D = div.map((d) => Math.max(1, Math.round(d)));
  const pt = (i: number, j: number, k: number) => {
    const kk = (i * (D[1] + 1) + j) * (D[2] + 1) + k;
    let p = key.get(kk);
    if (p === undefined) {
      p = b.addPoint(
        center[0] + size[0] * (i / D[0] - 0.5),
        center[1] + size[1] * (j / D[1] - 0.5),
        center[2] + size[2] * (k / D[2] - 0.5),
      );
      key.set(kk, p);
    }
    return p;
  };
  const uv = b.attrib('vertex', 'uv', 3);
  for (let a = 0; a < 3; a++)
    for (const s of [0, 1]) {
      const u = (a + 1) % 3, v = (a + 2) % 3;
      for (let i = 0; i < D[u]; i++)
        for (let j = 0; j < D[v]; j++) {
          const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
          if (s === 0) corners.reverse();
          const ids = corners.map(([ci, cj]) => {
            const c = [0, 0, 0];
            c[a] = s * D[a]; c[u] = ci; c[v] = cj;
            return pt(c[0], c[1], c[2]);
          });
          const v0 = b.numVertices;
          b.addPrim(ids, true);
          corners.forEach(([ci, cj], k) => uv.set(v0 + k, [ci / D[u], cj / D[v], 0]));
        }
    }
  return b.build();
}

export function makeGrid(size: [number, number], div: [number, number], plane: PlaneName, center: Vec3): Geometry {
  const { U, V } = FRAMES[plane];
  const [nu, nv] = [Math.max(1, div[0]), Math.max(1, div[1])];
  const b = new GeoBuilder();
  const uv = b.attrib('point', 'uv', 3);
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const u = (i / nu - 0.5) * size[0], v = (j / nv - 0.5) * size[1];
      const p = b.addPoint(center[0] + U[0] * u + V[0] * v, center[1] + U[1] * u + V[1] * v, center[2] + U[2] * u + V[2] * v);
      uv.set(p, [i / nu, j / nv, 0]);
    }
  const id = (i: number, j: number) => j * (nu + 1) + i;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) b.addPrim([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
  return b.build();
}

function uvSphere(r: number, rows: number, cols: number): Geometry {
  rows = Math.max(2, rows); cols = Math.max(3, cols);
  const b = new GeoBuilder();
  const uv = b.attrib('vertex', 'uv', 3);
  const top = b.addPoint(0, r, 0);
  const ring: number[][] = [];
  for (let i = 1; i < rows; i++) {
    const th = (Math.PI * i) / rows, row: number[] = [];
    for (let c = 0; c < cols; c++) {
      const ph = (2 * Math.PI * c) / cols;
      row.push(b.addPoint(r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), -r * Math.sin(th) * Math.sin(ph)));
    }
    ring.push(row);
  }
  const bot = b.addPoint(0, -r, 0);
  const addUV = (us: number[][]) => { const v0 = b.numVertices - us.length; us.forEach((t, k) => uv.set(v0 + k, [t[0], t[1], 0])); };
  for (let c = 0; c < cols; c++) {
    const c1 = (c + 1) % cols, u0 = c / cols, u1 = (c + 1) / cols;
    b.addPrim([top, ring[0][c], ring[0][c1]]);
    addUV([[(u0 + u1) / 2, 1], [u0, 1 - 1 / rows], [u1, 1 - 1 / rows]]);
    for (let i = 0; i < rows - 2; i++) {
      b.addPrim([ring[i][c], ring[i + 1][c], ring[i + 1][c1], ring[i][c1]]);
      const va = 1 - (i + 1) / rows, vb = 1 - (i + 2) / rows;
      addUV([[u0, va], [u0, vb], [u1, vb], [u1, va]]);
    }
    b.addPrim([ring[rows - 2][c], bot, ring[rows - 2][c1]]);
    addUV([[u0, 1 / rows], [(u0 + u1) / 2, 0], [u1, 1 / rows]]);
  }
  return b.build();
}

const ICO_V = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  return [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
})();
const ICO_F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];

function icoSphere(r: number, level: number): Geometry {
  let V = ICO_V.map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
  let F = ICO_F.map((f) => f.slice());
  for (let l = 0; l < level; l++) {
    const mid = new Map<number, number>();
    const m = (a: number, b: number) => {
      const k = a < b ? a * 1e6 + b : b * 1e6 + a;
      let i = mid.get(k);
      if (i === undefined) {
        const p = [V[a][0] + V[b][0], V[a][1] + V[b][1], V[a][2] + V[b][2]];
        const L = Math.hypot(p[0], p[1], p[2]);
        i = V.length; V.push([p[0] / L, p[1] / L, p[2] / L]); mid.set(k, i);
      }
      return i;
    };
    const NF: number[][] = [];
    for (const [a, b, c] of F) {
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      NF.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    F = NF;
  }
  return orientConvex(V.map((v) => [v[0] * r, v[1] * r, v[2] * r]), F);
}

/** Build polygons around the origin, flipping any face whose normal points inward. */
function orientConvex(V: number[][], F: number[][]): Geometry {
  const g = new Geometry({ positions: V.flat(), prims: F });
  const n = [0, 0, 0];
  for (let p = 0; p < g.numPrims; p++) {
    primNewell(g, p, n);
    const s = g.primStart[p], e = g.primStart[p + 1];
    let cx = 0, cy = 0, cz = 0;
    for (let v = s; v < e; v++) { const i = g.vertexPoint[v] * 3; cx += g.P[i]; cy += g.P[i + 1]; cz += g.P[i + 2]; }
    if (n[0] * cx + n[1] * cy + n[2] * cz < 0) g.vertexPoint.subarray(s, e).reverse();
  }
  return g;
}

function quadSphere(r: number, div: number): Geometry {
  const g = makeBox([2, 2, 2], [0, 0, 0], [div, div, div]);
  const P = g.P;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    const x2 = x * x, y2 = y * y, z2 = z * z;
    P[i] = r * x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3);
    P[i + 1] = r * y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3);
    P[i + 2] = r * z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3);
  }
  return g;
}

function platonic(shape: string, r: number): Geometry {
  let V: number[][], F: number[][];
  switch (shape) {
    case 'tetrahedron':
      V = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
      F = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
      break;
    case 'cube':
      V = [];
      for (let i = 0; i < 8; i++) V.push([i & 4 ? 1 : -1, i & 2 ? 1 : -1, i & 1 ? 1 : -1]);
      F = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
      break;
    case 'octahedron':
      V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      F = [[0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2], [1, 4, 2], [1, 3, 4], [1, 5, 3], [1, 2, 5]];
      break;
    case 'dodecahedron': {
      // dual of the icosahedron: face centroids become vertices
      const IV = ICO_V;
      V = ICO_F.map((f) => [0, 1, 2].map((c) => (IV[f[0]][c] + IV[f[1]][c] + IV[f[2]][c]) / 3));
      F = [];
      for (let vi = 0; vi < IV.length; vi++) {
        const around = ICO_F.map((f, fi) => (f.includes(vi) ? fi : -1)).filter((x) => x >= 0);
        const n = IV[vi], ln = Math.hypot(n[0], n[1], n[2]);
        const nz = [n[0] / ln, n[1] / ln, n[2] / ln];
        const ref = Math.abs(nz[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const ax = [ref[1] * nz[2] - ref[2] * nz[1], ref[2] * nz[0] - ref[0] * nz[2], ref[0] * nz[1] - ref[1] * nz[0]];
        const ay = [nz[1] * ax[2] - nz[2] * ax[1], nz[2] * ax[0] - nz[0] * ax[2], nz[0] * ax[1] - nz[1] * ax[0]];
        around.sort((a, b) => {
          const ang = (k: number) => Math.atan2(V[k][0] * ay[0] + V[k][1] * ay[1] + V[k][2] * ay[2], V[k][0] * ax[0] + V[k][1] * ax[1] + V[k][2] * ax[2]);
          return ang(a) - ang(b);
        });
        F.push(around);
      }
      break;
    }
    default:
      V = ICO_V; F = ICO_F;
  }
  const s = r / Math.hypot(V[0][0], V[0][1], V[0][2]);
  return orientConvex(V.map((v) => [v[0] * s, v[1] * s, v[2] * s]), F);
}

function makeTube(rb: number, rt: number, h: number, rows: number, cols: number, caps: boolean, center: Vec3, axis: string): Geometry {
  rows = Math.max(1, rows); cols = Math.max(3, cols);
  const b = new GeoBuilder();
  const uv = b.attrib('vertex', 'uv', 3);
  const rings: number[][] = [];
  for (let r = 0; r <= rows; r++) {
    const t = r / rows, rad = rb + (rt - rb) * t, y = -h / 2 + h * t;
    if (rad <= 1e-12 && (r === 0 || r === rows)) { rings.push([b.addPoint(0, y, 0)]); continue; }
    const ring: number[] = [];
    for (let c = 0; c < cols; c++) {
      const ph = (2 * Math.PI * c) / cols;
      ring.push(b.addPoint(rad * Math.cos(ph), y, -rad * Math.sin(ph)));
    }
    rings.push(ring);
  }
  const at = (ring: number[], c: number) => (ring.length === 1 ? ring[0] : ring[c % cols]);
  for (let r = 0; r < rows; r++) {
    const lo = rings[r], hi = rings[r + 1];
    for (let c = 0; c < cols; c++) {
      const ids = [at(lo, c), at(lo, c + 1), at(hi, c + 1), at(hi, c)];
      const uvs = [[c / cols, r / rows], [(c + 1) / cols, r / rows], [(c + 1) / cols, (r + 1) / rows], [c / cols, (r + 1) / rows]];
      const keep = ids.map((id, k) => (k === 0 || id !== ids[k - 1]) && !(k === 3 && id === ids[0]));
      const fid = ids.filter((_, k) => keep[k]), fuv = uvs.filter((_, k) => keep[k]);
      if (fid.length < 3) continue;
      const v0 = b.numVertices;
      b.addPrim(fid);
      fuv.forEach((t, k) => uv.set(v0 + k, [t[0], t[1], 0]));
    }
  }
  if (caps) {
    const bot = rings[0], top = rings[rows];
    if (top.length > 1) {
      const v0 = b.numVertices;
      b.addPrim(top);
      top.forEach((_, c) => { const a = (2 * Math.PI * c) / cols; uv.set(v0 + c, [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a), 0]); });
    }
    if (bot.length > 1) {
      const v0 = b.numVertices;
      const rev = bot.slice().reverse();
      b.addPrim(rev);
      rev.forEach((_, k) => { const c = cols - 1 - k, a = (2 * Math.PI * c) / cols; uv.set(v0 + k, [0.5 + 0.5 * Math.cos(a), 0.5 - 0.5 * Math.sin(a), 0]); });
    }
  }
  const g = b.build();
  orientAxis(g, axis, center);
  return g;
}

/** Rotate geometry built along +Y onto another axis, then translate. */
function orientAxis(g: Geometry, axis: string, c: Vec3) {
  const Pd = g.P;
  for (let i = 0; i < Pd.length; i += 3) {
    let x = Pd[i], y = Pd[i + 1], z = Pd[i + 2];
    if (axis === 'x') [x, y, z] = [y, -x, z];
    else if (axis === 'z') [x, y, z] = [x, -z, y];
    Pd[i] = x + c[0]; Pd[i + 1] = y + c[1]; Pd[i + 2] = z + c[2];
  }
}

function makeTorus(R: number, r: number, rows: number, cols: number): Geometry {
  rows = Math.max(3, rows); cols = Math.max(3, cols);
  const b = new GeoBuilder();
  const uv = b.attrib('vertex', 'uv', 3);
  const id = (c: number, k: number) => (c % cols) * rows + (k % rows);
  for (let c = 0; c < cols; c++) {
    const ph = (2 * Math.PI * c) / cols;
    for (let k = 0; k < rows; k++) {
      const th = (2 * Math.PI * k) / rows, rr = R + r * Math.cos(th);
      b.addPoint(rr * Math.cos(ph), r * Math.sin(th), -rr * Math.sin(ph));
    }
  }
  for (let c = 0; c < cols; c++)
    for (let k = 0; k < rows; k++) {
      const v0 = b.numVertices;
      b.addPrim([id(c, k), id(c + 1, k), id(c + 1, k + 1), id(c, k + 1)]);
      [[c, k], [c + 1, k], [c + 1, k + 1], [c, k + 1]].forEach(([a, bb], j) => uv.set(v0 + j, [a / cols, bb / rows, 0]));
    }
  return b.build();
}

function translate(g: Geometry, c: Vec3) {
  if (!c[0] && !c[1] && !c[2]) return g;
  const Pd = g.P;
  for (let i = 0; i < Pd.length; i += 3) { Pd[i] += c[0]; Pd[i + 1] += c[1]; Pd[i + 2] += c[2]; }
  return g;
}

// ---------------------------------------------------------------- nodes

defineNode({
  type: 'box',
  category: 'generate',
  summary: 'Axis-aligned box (watertight quads, optional divisions, box-mapped uv).',
  aliases: ['cube'],
  inputs: [],
  params: {
    size: { type: 'vec3', default: [1, 1, 1], desc: 'edge lengths X Y Z (a single number = uniform)', aliases: ['scale', 'dims'] },
    center: P.center(),
    divisions: { type: 'ivec3', default: [1, 1, 1], min: 1, desc: 'quads along X Y Z', aliases: ['divs', 'div'] },
  },
  outputs: 'vertex uv',
  example: { type: 'box', params: { size: [2, 1, 1], center: [0, 0.5, 0] } },
  cook: ({ p }) => makeBox(p.size, p.center, p.divisions),
});

defineNode({
  type: 'grid',
  category: 'generate',
  summary: 'Flat grid of quads (default lies on the XZ ground plane facing +Y).',
  inputs: [],
  params: {
    size: { type: 'vec2', default: [4, 4], desc: 'width and depth' },
    divisions: { type: 'ivec2', default: [10, 10], min: 1, desc: 'quads along each side', aliases: ['rows', 'cols', 'res', 'resolution'] },
    plane: P.plane('xz'),
    center: P.center(),
  },
  outputs: 'point uv',
  cook: ({ p }) => makeGrid(p.size, p.divisions, p.plane, p.center),
});

defineNode({
  type: 'sphere',
  category: 'generate',
  summary: 'Sphere: polar uv-sphere, geodesic icosphere, or quad sphere. Watertight, with point normals.',
  inputs: [],
  params: {
    type: { type: 'enum', options: ['uv', 'ico', 'quad'], default: 'uv', desc: 'uv = latitude/longitude, ico = geodesic triangles, quad = spherified cube' },
    radius: { type: 'float', default: 1, min: 0, desc: 'radius', aliases: ['rad', 'r'] },
    scale: { type: 'vec3', default: [1, 1, 1], desc: 'non-uniform scale (ellipsoid)' },
    center: P.center(),
    rows: { type: 'int', default: 16, min: 2, desc: 'uv: latitude bands' },
    cols: { type: 'int', default: 32, min: 3, desc: 'uv: longitude segments', aliases: ['columns', 'segments'] },
    level: { type: 'int', default: 3, min: 0, max: 7, desc: 'ico: subdivision level (20*4^level triangles)', aliases: ['frequency', 'subdivisions'] },
    divisions: { type: 'int', default: 8, min: 1, desc: 'quad: quads per cube-face edge' },
  },
  outputs: 'point N; uv (uv type)',
  cook: ({ p }) => {
    const g = p.type === 'ico' ? icoSphere(p.radius, p.level) : p.type === 'quad' ? quadSphere(p.radius, p.divisions) : uvSphere(p.radius, p.rows, p.cols);
    const Pd = g.P;
    for (let i = 0; i < Pd.length; i += 3) { Pd[i] *= p.scale[0]; Pd[i + 1] *= p.scale[1]; Pd[i + 2] *= p.scale[2]; }
    (g.points.add('N', 'float', 3).data as Float64Array).set(pointNormals(g));
    return translate(g, p.center);
  },
});

defineNode({
  type: 'tube',
  category: 'generate',
  summary: 'Cylinder / cone / frustum along an axis, optional end caps (watertight when capped).',
  aliases: ['cylinder', 'cone'],
  inputs: [],
  params: {
    radius: { type: 'float', default: 0.5, min: 0, desc: 'radius (both ends unless radius_top is set)', aliases: ['rad', 'r'] },
    radius_top: { type: 'float', default: -1, desc: 'top radius; -1 = same as radius; 0 = cone apex' },
    height: { type: 'float', default: 1, desc: 'length along the axis', aliases: ['h', 'length'] },
    rows: { type: 'int', default: 1, min: 1, desc: 'segments along the axis' },
    cols: { type: 'int', default: 24, min: 3, desc: 'segments around', aliases: ['columns', 'segments', 'sides'] },
    caps: { type: 'bool', default: true, desc: 'close the ends with n-gons' },
    axis: { type: 'enum', options: ['y', 'x', 'z'], default: 'y', desc: 'axis direction' },
    center: P.center(),
  },
  outputs: 'vertex uv',
  cook: ({ p }) => makeTube(p.radius, p.radius_top < 0 ? p.radius : p.radius_top, p.height, p.rows, p.cols, p.caps, p.center, p.axis),
});

defineNode({
  type: 'torus',
  category: 'generate',
  summary: 'Torus (ring) around the Y axis.',
  inputs: [],
  params: {
    radius: { type: 'float', default: 1, desc: 'major radius (center of tube)', aliases: ['major_radius', 'R'] },
    radius2: { type: 'float', default: 0.25, desc: 'minor radius (tube thickness)', aliases: ['minor_radius', 'tube_radius', 'r'] },
    rows: { type: 'int', default: 16, min: 3, desc: 'segments around the tube' },
    cols: { type: 'int', default: 48, min: 3, desc: 'segments around the ring' },
    center: P.center(),
  },
  outputs: 'vertex uv',
  cook: ({ p }) => translate(makeTorus(p.radius, p.radius2, p.rows, p.cols), p.center),
});

defineNode({
  type: 'platonic',
  category: 'generate',
  summary: 'Platonic solids: tetrahedron, cube, octahedron, dodecahedron, icosahedron.',
  inputs: [],
  params: {
    shape: { type: 'enum', options: ['tetrahedron', 'cube', 'octahedron', 'dodecahedron', 'icosahedron'], default: 'icosahedron', desc: 'solid type' },
    radius: { type: 'float', default: 1, desc: 'circumradius' },
    center: P.center(),
  },
  cook: ({ p }) => translate(platonic(p.shape, p.radius), p.center),
});

defineNode({
  type: 'points',
  category: 'generate',
  summary: 'Explicit points (and optional per-point attributes) from lists. No primitives.',
  aliases: ['add', 'point'],
  inputs: [],
  params: {
    positions: { type: 'json', default: [[0, 0, 0]], desc: 'list of [x,y,z] (2-number entries are placed on the ground: [x, 0, z])', aliases: ['points', 'pts', 'P'] },
    attribs: { type: 'json', default: {}, desc: 'per-point attributes: {"pscale": [1, 0.5], "Cd": [[1,0,0],[0,1,0]], "name": ["a","b"]}' },
    polyline: { type: 'enum', options: ['none', 'open', 'closed'], default: 'none', desc: 'also connect the points as a polyline / polygon' },
  },
  example: { type: 'points', params: { positions: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], attribs: { pscale: [1, 2, 3] } } },
  cook: ({ p }) => {
    const pos: number[] = [];
    if (!Array.isArray(p.positions)) throw new NodeError('positions must be a list of [x,y,z]');
    for (const q of p.positions) {
      if (!Array.isArray(q) || q.length < 2) throw new NodeError(`bad point ${JSON.stringify(q)} (want [x,y,z])`);
      if (q.length === 2) pos.push(+q[0], 0, +q[1]); else pos.push(+q[0], +q[1], +q[2]);
    }
    const n = pos.length / 3;
    const ids = Array.from({ length: n }, (_, i) => i);
    const g = new Geometry({ positions: pos, prims: p.polyline !== 'none' && n > 1 ? [ids] : [], closed: p.polyline === 'closed' });
    for (const [name, vals] of Object.entries(p.attribs ?? {})) {
      if (!Array.isArray(vals)) throw new NodeError(`attribs.${name} must be a list with one value per point`);
      const first = vals.find((v) => v !== null && v !== undefined);
      const type = typeof first === 'string' ? 'string' : 'float';
      const size = Array.isArray(first) ? first.length : 1;
      const a = g.points.add(name, type, size);
      for (let i = 0; i < Math.min(n, vals.length); i++) a.set(i, vals[i]);
    }
    return g;
  },
});

defineNode({
  type: 'point_grid',
  category: 'generate',
  summary: '3D lattice of points (optionally jittered) — e.g. for scattering, voxel art, instancing.',
  aliases: ['lattice_points', 'points_from_volume'],
  inputs: [],
  params: {
    counts: { type: 'ivec3', default: [5, 1, 5], min: 1, desc: 'points along X Y Z' },
    size: { type: 'vec3', default: [4, 0, 4], desc: 'extent along X Y Z' },
    center: P.center(),
    jitter: { type: 'float', default: 0, min: 0, desc: 'random offset as a fraction of the spacing' },
    seed: P.seed(),
  },
  cook: ({ p }) => {
    const [cx, cy, cz] = p.counts;
    const r = rng(p.seed);
    const pos: number[] = [];
    const sp = [0, 1, 2].map((a) => (p.counts[a] > 1 ? p.size[a] / (p.counts[a] - 1) : 0));
    for (let k = 0; k < cz; k++)
      for (let j = 0; j < cy; j++)
        for (let i = 0; i < cx; i++) {
          const q = [i, j, k].map((t, a) => (p.counts[a] > 1 ? (t / (p.counts[a] - 1) - 0.5) * p.size[a] : 0) + p.center[a] + (p.jitter ? (r() - 0.5) * p.jitter * sp[a] : 0));
          pos.push(q[0], q[1], q[2]);
        }
    return new Geometry({ positions: pos });
  },
});

function compileFn(engine: any, args: string[], code: string) {
  const body = /\breturn\b/.test(code) ? code : `return (${code});`;
  try {
    return engine.host.compile(`(function(${args.join(',')}){"use strict";\n${body}\n})`);
  } catch (e: any) {
    throw new NodeError(`expression syntax error: ${e.message}`);
  }
}

defineNode({
  type: 'parametric_curve',
  category: 'curve',
  summary: 'Curve from a JS expression of t returning [x,y,z] (e.g. helices, knots, Lissajous).',
  inputs: [],
  params: {
    expr: { type: 'code', default: '[cos(t*TAU), t, sin(t*TAU)]', desc: 'JS expression (or body with return) of t (and i) returning [x,y,z]. Snippet helpers available.' },
    range: { type: 'vec2', default: [0, 1], desc: 't start and end' },
    count: { type: 'int', default: 100, min: 2, desc: 'number of points', aliases: ['points', 'segments'] },
    closed: { type: 'bool', default: false, desc: 'closed curve (polygon)' },
  },
  usesVars: true,
  example: { type: 'parametric_curve', params: { expr: '[(2+cos(3*t))*cos(2*t), sin(3*t), (2+cos(3*t))*sin(2*t)]', range: [0, 6.2832], count: 400, closed: true } },
  cook: ({ p, engine }) => {
    const f = compileFn(engine, ['t', 'i'], p.expr);
    const n = p.count, pos: number[] = [];
    engine.host.runGuarded(() => {
      const last = p.closed ? n : n - 1;
      for (let i = 0; i < n; i++) {
        const t = p.range[0] + ((p.range[1] - p.range[0]) * i) / Math.max(1, last);
        const v = f(t, i);
        pos.push(+v[0] || 0, +v[1] || 0, +v[2] || 0);
      }
    }, engine.scriptTimeoutMs);
    return new Geometry({ positions: pos, prims: [Array.from({ length: n }, (_, i) => i)], closed: p.closed });
  },
});

defineNode({
  type: 'parametric_surface',
  category: 'generate',
  summary: 'Surface from a JS expression of (u, v) returning [x,y,z]; optional wrapping for closed surfaces.',
  inputs: [],
  params: {
    expr: { type: 'code', default: '[(1+0.5*cos(v*TAU))*cos(u*TAU), 0.5*sin(v*TAU), (1+0.5*cos(v*TAU))*sin(u*TAU)]', desc: 'JS expression of u, v returning [x,y,z]' },
    u_range: { type: 'vec2', default: [0, 1], desc: 'u start/end' },
    v_range: { type: 'vec2', default: [0, 1], desc: 'v start/end' },
    divisions: { type: 'ivec2', default: [48, 24], min: 1, desc: 'quads along u and v' },
    wrap_u: { type: 'bool', default: false, desc: 'u is periodic: join last column to first (no seam)' },
    wrap_v: { type: 'bool', default: false, desc: 'v is periodic' },
    flip: { type: 'bool', default: false, desc: 'reverse face winding' },
  },
  usesVars: true,
  outputs: 'vertex uv',
  cook: ({ p, engine }) => {
    const f = compileFn(engine, ['u', 'v'], p.expr);
    const [nu, nv] = p.divisions;
    const cu = p.wrap_u ? nu : nu + 1, cv = p.wrap_v ? nv : nv + 1;
    const b = new GeoBuilder();
    const uv = b.attrib('vertex', 'uv', 3);
    engine.host.runGuarded(() => {
      for (let j = 0; j < cv; j++)
        for (let i = 0; i < cu; i++) {
          const u = p.u_range[0] + ((p.u_range[1] - p.u_range[0]) * i) / nu;
          const v = p.v_range[0] + ((p.v_range[1] - p.v_range[0]) * j) / nv;
          const q = f(u, v);
          b.addPoint(+q[0] || 0, +q[1] || 0, +q[2] || 0);
        }
    }, engine.scriptTimeoutMs);
    const id = (i: number, j: number) => (j % cv) * cu + (i % cu);
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const q = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)];
        const t = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
        if (p.flip) { q.reverse(); t.reverse(); }
        const v0 = b.numVertices;
        b.addPrim(q);
        t.forEach(([a, c], k) => uv.set(v0 + k, [a / nu, c / nv, 0]));
      }
    return b.build();
  },
});

defineNode({
  type: 'terrain',
  category: 'generate',
  summary: 'Heightfield terrain: a ground grid displaced by fractal noise, with height attribute and normals.',
  aliases: ['heightfield', 'landscape'],
  inputs: [],
  params: {
    size: { type: 'vec2', default: [20, 20], desc: 'extent in X and Z' },
    divisions: { type: 'ivec2', default: [128, 128], min: 1, desc: 'grid resolution (quads)', aliases: ['resolution', 'res'] },
    height: { type: 'float', default: 3, desc: 'vertical scale (amplitude)', aliases: ['amplitude', 'amp'] },
    frequency: { type: 'float', default: 0.12, desc: 'base noise frequency (features per unit)', aliases: ['freq'] },
    noise: { type: 'enum', options: ['perlin', 'simplex', 'value', 'worley'], default: 'simplex', desc: 'base noise' },
    fractal: { type: 'enum', options: ['fbm', 'ridged', 'turbulence', 'none'], default: 'fbm', desc: 'layering mode (ridged = mountain ridges)' },
    octaves: { type: 'int', default: 6, min: 1, max: 12, desc: 'fractal octaves' },
    roughness: { type: 'float', default: 0.5, desc: 'amplitude gain per octave' },
    lacunarity: { type: 'float', default: 2, desc: 'frequency gain per octave' },
    offset: { type: 'vec3', default: [0, 0, 0], desc: 'noise space offset (scroll the terrain)' },
    terrace: { type: 'float', default: 0, min: 0, desc: 'terrace step height (0 = off)' },
    floor: { type: 'float', default: -1e9, desc: 'clamp heights below this (flat water/valley floor)' },
    falloff: { type: 'float', default: 0, min: 0, max: 1, desc: 'island falloff: lower the edges (0 = off, 1 = strong)' },
    seed: P.seed(),
    center: P.center(),
  },
  outputs: 'point height (0..1), point N, point uv',
  cook: ({ p }) => {
    const g = makeGrid(p.size, p.divisions, 'xz', [0, 0, 0]);
    const base = makeNoise(p.noise, p.seed);
    const n = fractal(base, { octaves: p.octaves, roughness: p.roughness, lacunarity: p.lacunarity, fractal: p.fractal });
    const Pd = g.P, np = g.numPoints;
    const h = new Float64Array(np);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < np; i++) {
      const x = Pd[i * 3], z = Pd[i * 3 + 2];
      let v = n((x + p.offset[0]) * p.frequency, p.offset[1], (z + p.offset[2]) * p.frequency);
      if (p.noise === 'worley') v = v * 2 - 1;
      if (p.falloff > 0) {
        const dx = (2 * x) / p.size[0], dz = (2 * z) / p.size[1];
        const d = Math.min(1, Math.hypot(dx, dz));
        v = v * (1 - p.falloff * d * d) - p.falloff * d * d;
      }
      let y = v * p.height;
      if (p.terrace > 0) { const s = y / p.terrace, f = Math.floor(s), t = s - f; y = (f + t * t * t * (t * (t * 6 - 15) + 10) * 0.35) * p.terrace; }
      y = Math.max(p.floor, y);
      h[i] = y;
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    const ha = g.points.add('height', 'float', 1).data as Float64Array;
    for (let i = 0; i < np; i++) {
      Pd[i * 3 + 1] = h[i];
      ha[i] = hi > lo ? (h[i] - lo) / (hi - lo) : 0;
    }
    (g.points.add('N', 'float', 3).data as Float64Array).set(pointNormals(g));
    return translate(g, p.center);
  },
});

export { orientOutward };
