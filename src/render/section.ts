// Plane sections for the renderer: slice triangles by an axis-aligned plane into oriented segments,
// then fill the cross-section by winding number. Outward-facing closed pieces give counter-clockwise
// outer loops (+1); cavities and holes cancel to 0; inside-out (flipped) pieces give -1, so flipped
// normals stay visible in a section. Pure functions over typed arrays (host-agnostic).

export interface Slice {
  /** number of segments */
  n: number;
  /** x0 y0 z0 x1 y1 z1 per segment (world space), oriented: seen from +axis the solid lies to the left */
  seg: Float64Array;
  /** connected piece of the source triangle */
  piece: Int32Array;
}

/** Plane-frame axes (u, v) for a slice along axis k, chosen so that u × v = +k (right-handed). */
export const PLANE_UV: [number, number][] = [[1, 2], [2, 0], [0, 1]];

/**
 * Slice triangles (`tris` index vertices, `vp` maps vertices to points) with the plane P[k] = c.
 * `triPiece(t)` returns the piece id of triangle t, or -1 to skip it.
 * A vertex exactly on the plane counts as below it, so every crossing edge is cut exactly once and
 * neighbouring triangles produce bit-identical shared endpoints.
 */
export function sliceTriangles(P: Float64Array, vp: Int32Array, tris: Uint32Array, triPiece: (t: number) => number, k: number, c: number): Slice {
  let cap = 1024, n = 0;
  let seg = new Float64Array(cap * 6), piece = new Int32Array(cap);
  const nt = tris.length / 3;
  const q = [0, 0, 0, 0, 0, 0];
  let m = 0;
  const cut = (p: number, r: number, dp: number, dr: number) => {
    // interpolate from the lower point index so both triangles sharing the edge agree exactly
    if (p > r) { const t = p; p = r; r = t; const d = dp; dp = dr; dr = d; }
    const t = dp / (dp - dr), o = m * 3;
    for (let a = 0; a < 3; a++) q[o + a] = a === k ? c : P[p * 3 + a] + (P[r * 3 + a] - P[p * 3 + a]) * t;
    m++;
  };
  for (let t = 0; t < nt; t++) {
    const a = vp[tris[t * 3]], b = vp[tris[t * 3 + 1]], d = vp[tris[t * 3 + 2]];
    const da = P[a * 3 + k] - c, db = P[b * 3 + k] - c, dd = P[d * 3 + k] - c;
    const sa = da > 0, sb = db > 0, sd = dd > 0;
    if (sa === sb && sb === sd) continue;
    const pc = triPiece(t);
    if (pc < 0) continue;
    m = 0;
    if (sa !== sb) cut(a, b, da, db);
    if (sb !== sd) cut(b, d, db, dd);
    if (sd !== sa) cut(d, a, dd, da);
    if (m !== 2) continue;
    // orientation: (seg × axis) · triangle normal > 0 puts the triangle's outside on the right
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const wx = P[d * 3] - P[a * 3], wy = P[d * 3 + 1] - P[a * 3 + 1], wz = P[d * 3 + 2] - P[a * 3 + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const sx = q[3] - q[0], sy = q[4] - q[1], sz = q[5] - q[2];
    // seg × e_k
    const cx = k === 0 ? 0 : k === 1 ? -sz : sy;
    const cy = k === 0 ? sz : k === 1 ? 0 : -sx;
    const cz = k === 0 ? -sy : k === 1 ? sx : 0;
    const flip = cx * nx + cy * ny + cz * nz < 0;
    if (n === cap) {
      cap *= 2;
      const s2 = new Float64Array(cap * 6); s2.set(seg); seg = s2;
      const p2 = new Int32Array(cap); p2.set(piece); piece = p2;
    }
    const o = n * 6;
    if (flip) { seg[o] = q[3]; seg[o + 1] = q[4]; seg[o + 2] = q[5]; seg[o + 3] = q[0]; seg[o + 4] = q[1]; seg[o + 5] = q[2]; }
    else for (let i = 0; i < 6; i++) seg[o + i] = q[i];
    piece[n++] = pc;
  }
  return { n, seg: seg.subarray(0, n * 6), piece: piece.subarray(0, n) };
}

/**
 * Winding numbers on an nx × ny cell grid. `seg2` holds oriented 2D segments (x0 y0 x1 y1) in cell
 * units, y up, cell (i, j) centred at (i, j). Counter-clockwise loops add +1 inside.
 * Returns one signed byte per cell (row-major, row j = y), clamped to ±127.
 */
export function windingGrid(seg2: Float64Array, n: number, nx: number, ny: number): Int8Array {
  const grid = new Int8Array(nx * ny);
  // crossings of each segment with the row centre lines y = j
  let cap = 256, m = 0;
  let key = new Float64Array(cap), dir = new Int8Array(cap);
  const KX = nx + 16;
  for (let s = 0; s < n; s++) {
    const x0 = seg2[s * 4], y0 = seg2[s * 4 + 1], x1 = seg2[s * 4 + 2], y1 = seg2[s * 4 + 3];
    if (y0 === y1 || !Number.isFinite(x0 + y0 + x1 + y1)) continue;
    const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
    const j0 = Math.max(0, Math.ceil(lo)), j1 = Math.min(ny - 1, Math.ceil(hi) - 1);
    const d = y1 > y0 ? -1 : 1, slope = (x1 - x0) / (y1 - y0);
    for (let j = j0; j <= j1; j++) {
      if (m === cap) {
        cap *= 2;
        const k2 = new Float64Array(cap); k2.set(key); key = k2;
        const d2 = new Int8Array(cap); d2.set(dir); dir = d2;
      }
      const x = Math.max(-4, Math.min(nx + 4, x0 + (j - y0) * slope));
      key[m] = j * KX + x + 8;
      dir[m++] = d;
    }
  }
  if (!m) return grid;
  const idx = new Int32Array(m);
  for (let i = 0; i < m; i++) idx[i] = i;
  const kk = key;
  idx.sort((a, b) => kk[a] - kk[b]);
  let i = 0;
  while (i < m) {
    const j = Math.floor(kk[idx[i]] / KX);
    let w = 0, prev = 0;
    for (; i < m; i++) {
      const e = idx[i], jj = Math.floor(kk[e] / KX);
      if (jj !== j) break;
      const x = kk[e] - jj * KX - 8;
      if (w !== 0) {
        const a = Math.max(0, Math.ceil(prev)), b = Math.min(nx - 1, Math.ceil(x) - 1);
        const v = w > 127 ? 127 : w < -127 ? -127 : w;
        for (let c = a; c <= b; c++) grid[j * nx + c] = v;
      }
      w += dir[e];
      prev = x;
    }
  }
  return grid;
}
