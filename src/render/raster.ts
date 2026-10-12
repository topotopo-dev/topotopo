// Headless software renderer: multi-view, smooth-shaded, z-buffered images of geometry.
// Designed as an LLM feedback channel: labelled views, backfaces tinted blue (inverted
// normals stand out), wireframe, curves, points, attribute colour maps, group highlight.
import { Geometry } from '../core/geometry.ts';
import { buildEdges, connectivity, primNormals, resolveVertexNormals, triangulate } from '../core/topology.ts';
import { drawText, textWidth } from './font.ts';
import { withHeightfieldPreview } from '../core/heightfield.ts';
import type { Vec3 } from '../core/math.ts';

export type ViewName = 'persp' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface RenderOptions {
  views?: ViewName[];
  size?: number;
  wireframe?: boolean | 'auto';
  colorBy?: string | null;
  highlight?: { cls: 'point' | 'prim'; mask: Uint8Array; label?: string } | null;
  points?: boolean | 'auto';
  grid?: boolean;
  azimuth?: number;
  elevation?: number;
  zoom?: number;
  target?: Vec3 | null;
  ssaa?: number;
  title?: string;
}

export interface RenderResult { width: number; height: number; rgba: Uint8Array; notes: string[] }

interface Cam {
  name: ViewName;
  persp: boolean;
  eye: Vec3; f: Vec3; r: Vec3; u: Vec3; c: Vec3;
  focal: number; scale: number;
}

const ORTHO: Record<string, { f: Vec3; r: Vec3; u: Vec3; label: string }> = {
  front: { f: [0, 0, -1], r: [1, 0, 0], u: [0, 1, 0], label: 'FRONT  X> Y^' },
  back: { f: [0, 0, 1], r: [-1, 0, 0], u: [0, 1, 0], label: 'BACK  -X> Y^' },
  right: { f: [-1, 0, 0], r: [0, 0, -1], u: [0, 1, 0], label: 'RIGHT  -Z> Y^' },
  left: { f: [1, 0, 0], r: [0, 0, 1], u: [0, 1, 0], label: 'LEFT  Z> Y^' },
  top: { f: [0, -1, 0], r: [1, 0, 0], u: [0, 0, -1], label: 'TOP  X> -Z^' },
  bottom: { f: [0, 1, 0], r: [1, 0, 0], u: [0, 0, 1], label: 'BOTTOM  X> Z^' },
};

const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: number[]): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross3 = (a: number[], b: number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const VIRIDIS = [[0.267, 0.005, 0.329], [0.229, 0.322, 0.546], [0.128, 0.567, 0.551], [0.369, 0.789, 0.383], [0.993, 0.906, 0.144]];
function colormap(t: number): number[] {
  t = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(t)), f = t - i;
  return [0, 1, 2].map((c) => VIRIDIS[i][c] + (VIRIDIS[i + 1][c] - VIRIDIS[i][c]) * f);
}
function catColor(k: number): number[] {
  const h = ((k * 0.618033988749895) % 1 + 1) % 1, s = 0.65, v = 0.95;
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}
function hashStr(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

function makeCam(name: ViewName, bmin: Vec3, bmax: Vec3, W: number, H: number, o: RenderOptions): Cam {
  const c: Vec3 = o.target ?? [(bmin[0] + bmax[0]) / 2, (bmin[1] + bmax[1]) / 2, (bmin[2] + bmax[2]) / 2];
  const ext = [bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]];
  const R = Math.max(1e-6, Math.hypot(ext[0], ext[1], ext[2]) / 2);
  const zoom = Math.max(0.05, Math.min(20, o.zoom ?? 1));
  if (name === 'persp') {
    const az = ((o.azimuth ?? 35) * Math.PI) / 180, el = ((o.elevation ?? 25) * Math.PI) / 180;
    const fov = (32 * Math.PI) / 180;
    const dist = (R / Math.sin(fov / 2)) * 1.05 / zoom;
    const dir: Vec3 = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
    const eye: Vec3 = [c[0] + dir[0] * dist, c[1] + dir[1] * dist, c[2] + dir[2] * dist];
    const f = norm3([c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]]);
    let r = cross3(f, [0, 1, 0]);
    if (Math.hypot(...r) < 1e-6) r = [1, 0, 0];
    r = norm3(r);
    const u = cross3(r, f);
    return { name, persp: true, eye, f, r, u, c, focal: Math.min(W, H) / 2 / Math.tan(fov / 2), scale: 1 };
  }
  const v = ORTHO[name];
  const halfW = Math.abs(v.r[0]) * ext[0] / 2 + Math.abs(v.r[1]) * ext[1] / 2 + Math.abs(v.r[2]) * ext[2] / 2;
  const halfH = Math.abs(v.u[0]) * ext[0] / 2 + Math.abs(v.u[1]) * ext[1] / 2 + Math.abs(v.u[2]) * ext[2] / 2;
  const s = Math.min((W / 2) * 0.86 / Math.max(halfW, 1e-6), (H / 2) * 0.82 / Math.max(halfH, 1e-6)) * zoom;
  return { name, persp: false, eye: c, f: v.f, r: v.r, u: v.u, c, focal: 0, scale: s };
}

/** Render the geometry; returns RGBA pixels. */
export function renderGeometry(g: Geometry, o: RenderOptions = {}): RenderResult {
  g = withHeightfieldPreview(g); // heightfields draw as their (decimated) grid mesh with layers as attributes
  const views: ViewName[] = o.views?.length ? o.views : ['persp', 'front', 'right', 'top'];
  const tile = Math.max(128, Math.min(1600, Math.round(o.size ?? (views.length === 1 ? 800 : 512))));
  const ss = Math.max(1, Math.min(3, Math.round(o.ssaa ?? 2)));
  const cols = views.length === 1 ? 1 : views.length <= 4 ? 2 : 3;
  const rows = Math.ceil(views.length / cols);
  const footerH = 22;
  const outW = cols * tile + (cols - 1) * 2, outH = rows * tile + (rows - 1) * 2 + footerH;
  const notes: string[] = [];

  // --- scene data shared by all views
  const Pd = g.P, np = g.numPoints;
  const bb = g.bbox(true);
  const bmin = bb.min, bmax = bb.max;
  const { tris, triPrim } = triangulate(g);
  const nTri = tris.length / 3;
  if (nTri > 4e6) notes.push(`large mesh (${nTri} triangles) — render may be slow`);
  const vnorm = nTri ? resolveVertexNormals(g, 50) : new Float64Array(0);
  const nrmOf = (v: number, out: number[]) => { out[0] = vnorm[v * 3]; out[1] = vnorm[v * 3 + 1]; out[2] = vnorm[v * 3 + 2]; };
  // back faces are only suspicious on closed pieces; open sheets/cards are shaded two-sided
  const conn = nTri ? connectivity(g) : null;
  const closedPiece = new Uint8Array(conn ? conn.count : 0).fill(1);
  if (conn && nTri) {
    const E0 = buildEdges(g);
    for (let e = 0; e < E0.a.length; e++) if (E0.count[e] !== 2) closedPiece[conn.primClass[E0.firstPrim[e]]] = 0;
  }

  // --- colours per vertex (Cd, colour-by, highlight)
  const vprim = g.vertexPrims();
  const BASE = [0.78, 0.74, 0.68];
  let colorOf: (v: number) => number[] = () => BASE;
  let pointColorOf: (p: number) => number[] | null = () => null;
  let legend = '';
  const resolveAttr = (name: string) => g.findAttrib(name, ['vertex', 'point', 'prim', 'detail']);
  const elemIndex = (cls: string, v: number) => (cls === 'vertex' ? v : cls === 'point' ? g.vertexPoint[v] : cls === 'prim' ? vprim[v] : 0);
  if (o.colorBy) {
    const [aname, comp] = o.colorBy.split('.');
    const f = resolveAttr(aname);
    if (!f) notes.push(`colorBy: no attribute "${aname}"`);
    else {
      const a = f.attr;
      const ci = comp ? 'xyzwrgb'.indexOf(comp) % 4 : -1;
      if (a.type === 'string' || (a.type === 'int' && a.size === 1)) {
        const seen = new Set<any>();
        for (let i = 0; i < a.count; i++) seen.add(a.get(i));
        const toKey = (x: any) => (typeof x === 'string' ? hashStr(x) : x);
        colorOf = (v) => catColor(toKey(a.get(elemIndex(f.cls, v))));
        pointColorOf = f.cls === 'point' ? (p) => catColor(toKey(a.get(p))) : () => null;
        legend = `COLOR BY ${aname} (${seen.size} VALUES)`;
      } else {
        const scalar = (i: number) => {
          if (a.isArray) return a.arrayLength(i); // array attributes (float[]/int[]/string[]) colour by their length
          const x = a.get(i);
          if (!Array.isArray(x)) return x as number;
          return ci >= 0 ? x[ci] : Math.hypot(...x);
        };
        const rgb = a.size === 3 && ci < 0 && (aname === 'Cd' || aname === 'N' || aname.toLowerCase().includes('color'));
        if (rgb && aname === 'N') {
          colorOf = (v) => (a.get(elemIndex(f.cls, v)) as number[]).map((x) => x * 0.5 + 0.5);
          pointColorOf = f.cls === 'point' ? (p) => (a.get(p) as number[]).map((x) => x * 0.5 + 0.5) : () => null;
          legend = 'COLOR BY N (XYZ AS RGB)';
        } else if (rgb) {
          colorOf = (v) => a.get(elemIndex(f.cls, v)) as number[];
          pointColorOf = f.cls === 'point' ? (p) => a.get(p) as number[] : () => null;
          legend = `COLOR BY ${aname} (RGB)`;
        } else {
          let lo = Infinity, hi = -Infinity;
          for (let i = 0; i < a.count; i++) { const s = scalar(i); if (s < lo) lo = s; if (s > hi) hi = s; }
          const span = hi > lo ? hi - lo : 1;
          colorOf = (v) => colormap((scalar(elemIndex(f.cls, v)) - lo) / span);
          pointColorOf = f.cls === 'point' ? (p) => colormap((scalar(p) - lo) / span) : () => null;
          legend = `COLOR BY ${o.colorBy} [${fmtNum(lo)} .. ${fmtNum(hi)}]`;
        }
      }
    }
  } else {
    const f = resolveAttr('Cd');
    if (f && f.attr.type === 'float') {
      const a = f.attr;
      const get = (i: number) => { const x = a.get(i); return Array.isArray(x) ? x : [x as number, x as number, x as number]; };
      colorOf = (v) => get(elemIndex(f.cls, v));
      if (f.cls === 'point') pointColorOf = (p) => get(p);
    }
  }
  const hl = o.highlight;
  if (hl) {
    const inner = colorOf;
    const HC = [1, 0.55, 0.1];
    colorOf = (v) => {
      const on = hl.cls === 'prim' ? hl.mask[vprim[v]] : hl.mask[g.vertexPoint[v]];
      const c = inner(v);
      return on ? HC : [c[0] * 0.35 + 0.25, c[1] * 0.35 + 0.25, c[2] * 0.35 + 0.25];
    };
    let n = 0;
    for (let i = 0; i < hl.mask.length; i++) if (hl.mask[i]) n++;
    legend = (legend ? legend + '  ' : '') + `HIGHLIGHT ${hl.label ?? 'GROUP'}: ${n} ${hl.cls.toUpperCase()}S`;
  }

  // isolated points + polylines
  const used = new Uint8Array(np);
  for (let v = 0; v < g.numVertices; v++) used[g.vertexPoint[v]] = 1;
  let isolated = 0;
  for (let i = 0; i < np; i++) if (!used[i]) isolated++;
  const showAllPts = o.points === true;
  const drawPts = showAllPts || (o.points !== false && isolated > 0);
  const closedPrims = g.primClosed.reduce((s, c) => s + c, 0);
  const wire = o.wireframe === true || (o.wireframe !== false && closedPrims > 0 && closedPrims <= 6000);
  const edges = wire ? buildEdges(g) : null;
  // triangle-dominant meshes (boolean/remesh output): hide edges between coplanar faces so the
  // wireframe shows shape, not triangulation slivers
  let edgeVisible: Uint8Array | null = null;
  if (edges) {
    let triCount = 0;
    for (let p = 0; p < g.numPrims; p++) if (g.primClosed[p] && g.primSize(p) === 3) triCount++;
    if (triCount > closedPrims * 0.5) {
      const fn = primNormals(g);
      edgeVisible = new Uint8Array(edges.a.length).fill(1);
      for (let e = 0; e < edges.a.length; e++) {
        const p1 = edges.firstPrim[e], p2 = edges.secondPrim[e];
        if (edges.count[e] === 2 && p2 >= 0 && fn[p1 * 3] * fn[p2 * 3] + fn[p1 * 3 + 1] * fn[p2 * 3 + 1] + fn[p1 * 3 + 2] * fn[p2 * 3 + 2] > 0.9995) edgeVisible[e] = 0;
      }
    }
  }
  const ptRadius = (np > 50000 ? 1 : np > 5000 ? 1.5 : 2.6) * ss;

  // --- output buffer (final res, RGB float) and per-tile SSAA buffers
  const out = new Float32Array(outW * outH * 3);
  for (let i = 0; i < out.length; i += 3) { out[i] = 0.12; out[i + 1] = 0.12; out[i + 2] = 0.13; }

  views.forEach((vname, vi) => {
    const W = tile * ss, H = tile * ss;
    const col = new Float32Array(W * H * 3);
    const zb = new Float32Array(W * H).fill(-Infinity);
    for (let y = 0; y < H; y++) {
      const t = y / H;
      const r = 0.44 - t * 0.2, gg = 0.46 - t * 0.2, b = 0.5 - t * 0.2;
      for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; col[i] = r; col[i + 1] = gg; col[i + 2] = b; }
    }
    const cam = makeCam(vname, bmin, bmax, W, H, o);
    // project points
    const sx = new Float32Array(np), sy = new Float32Array(np), cz = new Float32Array(np), vz = new Float32Array(np);
    const project = (x: number, y: number, z: number, outp: number[]) => {
      const dx = x - cam.eye[0], dy = y - cam.eye[1], dz = z - cam.eye[2];
      const X = dx * cam.r[0] + dy * cam.r[1] + dz * cam.r[2];
      const Y = dx * cam.u[0] + dy * cam.u[1] + dz * cam.u[2];
      const Z = dx * cam.f[0] + dy * cam.f[1] + dz * cam.f[2];
      if (cam.persp) { outp[0] = W / 2 + (X / Z) * cam.focal; outp[1] = H / 2 - (Y / Z) * cam.focal; outp[2] = Z > 1e-6 ? 1 / Z : -Infinity; outp[3] = Z; }
      else { outp[0] = W / 2 + X * cam.scale; outp[1] = H / 2 - Y * cam.scale; outp[2] = -Z; outp[3] = Z; }
    };
    const tmp = [0, 0, 0, 0];
    for (let i = 0; i < np; i++) { project(Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2], tmp); sx[i] = tmp[0]; sy[i] = tmp[1]; cz[i] = tmp[2]; vz[i] = tmp[3]; }
    const sceneR = Math.max(1e-6, Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) / 2);

    // ground grid (persp only), drawn first without depth
    if (vname === 'persp' && o.grid !== false) {
      const step = Math.pow(10, Math.floor(Math.log10(sceneR * 0.5)));
      const ext = Math.ceil((sceneR * 1.6) / step) * step;
      const cx = Math.round(cam.c[0] / step) * step, czz = Math.round(cam.c[2] / step) * step;
      const p0 = [0, 0, 0, 0], p1 = [0, 0, 0, 0];
      for (let k = -ext; k <= ext + 1e-9; k += step) {
        const major = Math.abs(Math.round((k + (0 * cx)) / step) % 10) === 0;
        for (const dir of [0, 1]) {
          const a = dir ? [cx + k, 0, czz - ext] : [cx - ext, 0, czz + k];
          const b = dir ? [cx + k, 0, czz + ext] : [cx + ext, 0, czz + k];
          project(a[0], a[1], a[2], p0); project(b[0], b[1], b[2], p1);
          if (p0[3] <= 0 || p1[3] <= 0) continue;
          const isAxis = Math.abs((dir ? cx + k : czz + k)) < step * 1e-6;
          const color = isAxis ? (dir ? [0.35, 0.45, 0.85] : [0.85, 0.35, 0.35]) : [0.62, 0.64, 0.68];
          drawLine(col, null, W, H, p0[0], p0[1], 0, p1[0], p1[1], 0, color, isAxis ? 0.55 : major ? 0.28 : 0.16, ss, false, 0);
        }
      }
    }

    // triangles
    const L1 = norm3([-0.45, 0.65, 0.6]), L2 = norm3([0.7, 0.15, 0.5]);
    const H1 = norm3([L1[0], L1[1], L1[2] + 1]);
    const na = [0, 0, 0], nb = [0, 0, 0], nc = [0, 0, 0];
    const tn = [0, 0, 0];
    for (let t = 0; t < nTri; t++) {
      const va = tris[t * 3], vb = tris[t * 3 + 1], vc = tris[t * 3 + 2];
      const a = g.vertexPoint[va], b = g.vertexPoint[vb], c = g.vertexPoint[vc];
      if (cam.persp && (vz[a] < 1e-4 || vz[b] < 1e-4 || vz[c] < 1e-4)) continue;
      const ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], cx = sx[c], cy = sy[c];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-12) continue;
      let minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
      let minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
      if (minX > maxX || minY > maxY) continue;
      // facing (world space)
      const e1 = [Pd[b * 3] - Pd[a * 3], Pd[b * 3 + 1] - Pd[a * 3 + 1], Pd[b * 3 + 2] - Pd[a * 3 + 2]];
      const e2 = [Pd[c * 3] - Pd[a * 3], Pd[c * 3 + 1] - Pd[a * 3 + 1], Pd[c * 3 + 2] - Pd[a * 3 + 2]];
      const fnw = cross3(e1, e2);
      const toCam = cam.persp ? [cam.eye[0] - Pd[a * 3], cam.eye[1] - Pd[a * 3 + 1], cam.eye[2] - Pd[a * 3 + 2]] : [-cam.f[0], -cam.f[1], -cam.f[2]];
      const back = dot3(fnw, toCam) < 0;
      const suspicious = back && conn !== null && closedPiece[conn.primClass[triPrim[t]]] === 1;
      nrmOf(va, na); nrmOf(vb, nb); nrmOf(vc, nc);
      // camera-space normals
      const toCamSpace = (n: number[], o2: number[]) => { const x = dot3(n, cam.r), y = dot3(n, cam.u), z = -dot3(n, cam.f); o2[0] = x; o2[1] = y; o2[2] = z; };
      const ca = [0, 0, 0], cb = [0, 0, 0], cc = [0, 0, 0];
      toCamSpace(na, ca); toCamSpace(nb, cb); toCamSpace(nc, cc);
      let colA = colorOf(va), colB = colorOf(vb), colC = colorOf(vc);
      if (suspicious) {
        const tint = (q: number[]) => [q[0] * 0.35 + 0.12, q[1] * 0.35 + 0.22, q[2] * 0.35 + 0.6];
        colA = tint(colA); colB = tint(colB); colC = tint(colC);
      }
      const za = cz[a], zb2 = cz[b], zc = cz[c];
      const inv = 1 / area;
      for (let py = minY; py <= maxY; py++) {
        const yy = py + 0.5;
        for (let px = minX; px <= maxX; px++) {
          const xx = px + 0.5;
          let w0 = ((bx - xx) * (cy - yy) - (by - yy) * (cx - xx)) * inv;
          let w1 = ((cx - xx) * (ay - yy) - (cy - yy) * (ax - xx)) * inv;
          let w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const depth = w0 * za + w1 * zb2 + w2 * zc;
          const zi = py * W + px;
          if (depth <= zb[zi]) continue;
          zb[zi] = depth;
          if (cam.persp) { const s = w0 * za + w1 * zb2 + w2 * zc; w0 = (w0 * za) / s; w1 = (w1 * zb2) / s; w2 = 1 - w0 - w1; }
          tn[0] = ca[0] * w0 + cb[0] * w1 + cc[0] * w2;
          tn[1] = ca[1] * w0 + cb[1] * w1 + cc[1] * w2;
          tn[2] = ca[2] * w0 + cb[2] * w1 + cc[2] * w2;
          const l = Math.hypot(tn[0], tn[1], tn[2]) || 1;
          let nx = tn[0] / l, ny = tn[1] / l, nz = tn[2] / l;
          if (back) { nx = -nx; ny = -ny; nz = -nz; }
          const dif1 = Math.max(0, nx * L1[0] + ny * L1[1] + nz * L1[2]);
          const dif2 = Math.max(0, nx * L2[0] + ny * L2[1] + nz * L2[2]);
          const spec = Math.pow(Math.max(0, nx * H1[0] + ny * H1[1] + nz * H1[2]), 40) * 0.18;
          const amb = 0.22 + 0.13 * (ny * 0.5 + 0.5);
          const rim = Math.pow(1 - Math.max(0, nz), 3) * 0.12;
          const k = amb + dif1 * 0.62 + dif2 * 0.22;
          const ci = zi * 3;
          col[ci] = aces((colA[0] * w0 + colB[0] * w1 + colC[0] * w2) * k + spec + rim);
          col[ci + 1] = aces((colA[1] * w0 + colB[1] * w1 + colC[1] * w2) * k + spec + rim);
          col[ci + 2] = aces((colA[2] * w0 + colB[2] * w1 + colC[2] * w2) * k + spec + rim);
        }
      }
    }

    const tol = (d: number) => (cam.persp ? Math.abs(d) * 0.004 + 1e-6 : sceneR * 0.004);
    // wireframe (polygon edges, depth-tested)
    if (edges) {
      for (let e = 0; e < edges.a.length; e++) {
        if (edgeVisible && !edgeVisible[e]) continue;
        const a = edges.a[e], b = edges.b[e];
        if (cam.persp && (vz[a] < 1e-4 || vz[b] < 1e-4)) continue;
        drawLine(col, zb, W, H, sx[a], sy[a], cz[a], sx[b], sy[b], cz[b], [0.06, 0.06, 0.08], 0.55, Math.max(1, ss * 0.75), true, tol(cz[a]));
      }
    }
    // polylines
    for (let pr = 0; pr < g.numPrims; pr++) {
      if (g.primClosed[pr]) continue;
      const s = g.primStart[pr], e = g.primStart[pr + 1];
      for (let v = s; v < e - 1; v++) {
        const a = g.vertexPoint[v], b = g.vertexPoint[v + 1];
        if (cam.persp && (vz[a] < 1e-4 || vz[b] < 1e-4)) continue;
        const ccol = colorOf(v);
        const c0 = ccol === BASE ? [0.2, 0.6, 1.0] : ccol;
        drawLine(col, zb, W, H, sx[a], sy[a], cz[a], sx[b], sy[b], cz[b], c0, 1, 2 * ss, true, tol(cz[a]), true);
      }
    }
    // points
    if (drawPts) {
      for (let i = 0; i < np; i++) {
        if (!showAllPts && used[i]) continue;
        if (cam.persp && vz[i] < 1e-4) continue;
        const pc = pointColorOf(i) ?? (hl && hl.cls === 'point' ? (hl.mask[i] ? [1, 0.55, 0.1] : [0.5, 0.5, 0.5]) : [1, 0.85, 0.25]);
        drawDisc(col, zb, W, H, sx[i], sy[i], cz[i], ptRadius, pc, tol(cz[i]));
      }
    }
    // volumes without polygons: draw their bounds
    if (g.volumes.length && !nTri) {
      for (const vol of g.volumes) {
        const bmn = vol.bounds.min, bmx = vol.bounds.max;
        const corners: number[][] = [];
        for (let k = 0; k < 8; k++) { const q = [0, 0, 0, 0]; project(k & 1 ? bmx[0] : bmn[0], k & 2 ? bmx[1] : bmn[1], k & 4 ? bmx[2] : bmn[2], q); corners.push(q); }
        for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]])
          drawLine(col, null, W, H, corners[i][0], corners[i][1], 0, corners[j][0], corners[j][1], 0, [0.4, 1, 0.6], 0.9, ss, false, 0);
      }
      if (vi === 0) notes.push('geometry holds only SDF volumes (drawn as green boxes); add sdf_to_mesh to see the surface');
    }
    // axis gizmo
    if (vname === 'persp') {
      const ox = 34 * ss, oy = H - 34 * ss, len = 22 * ss;
      for (const [ax, colr, lab] of [[[1, 0, 0], [0.95, 0.3, 0.3], 'X'], [[0, 1, 0], [0.4, 0.9, 0.4], 'Y'], [[0, 0, 1], [0.4, 0.6, 1], 'Z']] as [number[], number[], string][]) {
        const ex = ox + dot3(ax, cam.r) * len, ey = oy - dot3(ax, cam.u) * len;
        drawLine(col, null, W, H, ox, oy, 0, ex, ey, 0, colr, 1, 2 * ss, false, 0);
        drawText(col, W, H, Math.round(ex + 2 * ss), Math.round(ey - 4 * ss), lab, colr, ss, true);
      }
    }
    // downsample into output
    const tx = (vi % cols) * (tile + 2), ty = Math.floor(vi / cols) * (tile + 2);
    const inv = 1 / (ss * ss);
    for (let y = 0; y < tile; y++)
      for (let x = 0; x < tile; x++) {
        let r = 0, gg = 0, b = 0;
        for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) { const k = ((y * ss + j) * W + x * ss + i) * 3; r += col[k]; gg += col[k + 1]; b += col[k + 2]; }
        const k = ((ty + y) * outW + tx + x) * 3;
        out[k] = r * inv; out[k + 1] = gg * inv; out[k + 2] = b * inv;
      }
    const label = vname === 'persp' ? `PERSP  AZ ${Math.round(o.azimuth ?? 35)} EL ${Math.round(o.elevation ?? 25)}` : ORTHO[vname].label;
    drawText(out, outW, outH, tx + 6, ty + 6, label, [1, 1, 1], 2);
  });

  // footer
  const fy = outH - footerH + 4;
  const ext = [bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]];
  const stats = `${np} PTS  ${g.numPrims} PRIMS  BBOX ${fmtNum(ext[0])}×${fmtNum(ext[1])}×${fmtNum(ext[2])}  CENTER ${fmtNum((bmin[0] + bmax[0]) / 2)},${fmtNum((bmin[1] + bmax[1]) / 2)},${fmtNum((bmin[2] + bmax[2]) / 2)}`;
  drawText(out, outW, outH, 6, fy, (o.title ? o.title.toUpperCase() + '  ' : '') + stats, [0.85, 0.85, 0.85], 2, false);
  if (legend) {
    const lx = outW - textWidth(legend, 2) - 8;
    if (lx > textWidth(stats, 2) + 30) drawText(out, outW, outH, lx, fy, legend, [1, 0.85, 0.4], 2, false);
    else notes.push(legend.toLowerCase());
  }
  const rgba = new Uint8Array(outW * outH * 4);
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    rgba[j] = toSRGB(out[i]); rgba[j + 1] = toSRGB(out[i + 1]); rgba[j + 2] = toSRGB(out[i + 2]); rgba[j + 3] = 255;
  }
  if (legend) notes.push(legend.toLowerCase());
  return { width: outW, height: outH, rgba, notes };
}

/** Filmic tone curve (Narkowicz ACES fit) so light colours keep detail instead of clipping. */
function aces(x: number) {
  x *= 1.1;
  return Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
}

function toSRGB(x: number) {
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}

export function fmtNum(x: number) {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a >= 1000) return x.toFixed(0);
  if (a >= 10) return x.toFixed(1);
  if (a >= 0.01 || a === 0) return x.toFixed(2);
  return x.toExponential(1);
}

function drawLine(
  col: Float32Array, zb: Float32Array | null, W: number, H: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  c: number[], alpha: number, width: number, depthTest: boolean, tol: number, writeDepth = false,
) {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  if (!Number.isFinite(steps) || steps > 1e5) return;
  const hw = Math.max(0.5, width / 2);
  for (let s = 0; s <= steps; s++) {
    const t = steps ? s / steps : 0;
    const x = x0 + dx * t, y = y0 + dy * t, z = z0 + (z1 - z0) * t;
    const xa = Math.floor(x - hw + 0.5), xb = Math.floor(x + hw - 0.5), ya = Math.floor(y - hw + 0.5), yb = Math.floor(y + hw - 0.5);
    for (let py = ya; py <= yb; py++) {
      if (py < 0 || py >= H) continue;
      for (let px = xa; px <= xb; px++) {
        if (px < 0 || px >= W) continue;
        const zi = py * W + px;
        if (depthTest && zb && z < zb[zi] - tol) continue;
        if (writeDepth && zb) zb[zi] = Math.max(zb[zi], z);
        const i = zi * 3;
        col[i] += (c[0] - col[i]) * alpha; col[i + 1] += (c[1] - col[i + 1]) * alpha; col[i + 2] += (c[2] - col[i + 2]) * alpha;
      }
    }
  }
}

function drawDisc(col: Float32Array, zb: Float32Array, W: number, H: number, x: number, y: number, z: number, r: number, c: number[], tol: number) {
  const x0 = Math.floor(x - r), x1 = Math.ceil(x + r), y0 = Math.floor(y - r), y1 = Math.ceil(y + r);
  for (let py = Math.max(0, y0); py <= Math.min(H - 1, y1); py++)
    for (let px = Math.max(0, x0); px <= Math.min(W - 1, x1); px++) {
      const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
      if (d > r) continue;
      const zi = py * W + px;
      if (z < zb[zi] - tol) continue;
      zb[zi] = Math.max(zb[zi], z);
      const i = zi * 3;
      const edge = d > r - 1.2 ? 0.35 : 1;
      col[i] = c[0] * edge; col[i + 1] = c[1] * edge; col[i + 2] = c[2] * edge;
    }
}
