// Strict triangle-pair contact test for self-intersection checks (analysis.selfIntersections with strict: true, used by
// solidify): two triangles of one mesh may meet only along what they share. Reported:
//   - no shared corner: any contact, touching included (crossing edges, a vertex on the other face, coplanar overlap)
//   - one shared corner: any common point other than that corner (one folds through the other near the corner)
//   - a shared edge: coplanar overlap of positive area (one folded back onto the other); non-coplanar triangles that
//     share an edge can only meet along it
// Non-coplanar pairs use the interval overlap of both triangles on the line where their planes meet (Möller);
// coplanar ones are clipped in 2D. Tolerances scale with the mesh size (eps = lengths, rel = areas).
const dot = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => ax * bx + ay * by + az * bz;

/** Signed doubled area of a 2D triangle. */
const area2 = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** Clip CCW triangle a against CCW triangle b (2D, 6 numbers each): intersection polygon area. */
function clipArea(a: number[], b: number[]): number {
  let poly = a.slice();
  for (let e = 0; e < 3 && poly.length >= 6; e++) {
    const ax = b[e * 2], ay = b[e * 2 + 1], bx = b[((e + 1) % 3) * 2], by = b[((e + 1) % 3) * 2 + 1];
    const out: number[] = [], n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const cx = poly[i * 2], cy = poly[i * 2 + 1], dx = poly[((i + 1) % n) * 2], dy = poly[((i + 1) % n) * 2 + 1];
      const sc = area2(ax, ay, bx, by, cx, cy), sd = area2(ax, ay, bx, by, dx, dy);
      if (sc >= 0) out.push(cx, cy);
      if ((sc >= 0) !== (sd >= 0)) { const t = sc / (sc - sd); out.push(cx + (dx - cx) * t, cy + (dy - cy) * t); }
    }
    poly = out;
  }
  if (poly.length < 6) return 0;
  let s = 0;
  for (let i = 0, n = poly.length / 2; i < n; i++) { const j = (i + 1) % n; s += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1]; }
  return Math.abs(s) / 2;
}

/** 2D segments p1p2 and q1q2 touch or cross (within eps). */
function segTouch(p1x: number, p1y: number, p2x: number, p2y: number, q1x: number, q1y: number, q2x: number, q2y: number, eps: number): boolean {
  const lp = Math.hypot(p2x - p1x, p2y - p1y) || 1, lq = Math.hypot(q2x - q1x, q2y - q1y) || 1;
  const d1 = area2(q1x, q1y, q2x, q2y, p1x, p1y) / lq, d2 = area2(q1x, q1y, q2x, q2y, p2x, p2y) / lq;
  const d3 = area2(p1x, p1y, p2x, p2y, q1x, q1y) / lp, d4 = area2(p1x, p1y, p2x, p2y, q2x, q2y) / lp;
  if (((d1 > eps && d2 > eps) || (d1 < -eps && d2 < -eps)) || ((d3 > eps && d4 > eps) || (d3 < -eps && d4 < -eps))) return false;
  // collinear-ish: projections must overlap
  const ux = (p2x - p1x) / lp, uy = (p2y - p1y) / lp;
  const a0 = 0, a1 = lp, b0 = (q1x - p1x) * ux + (q1y - p1y) * uy, b1 = (q2x - p1x) * ux + (q2y - p1y) * uy;
  if (Math.abs(d1) <= eps && Math.abs(d2) <= eps) return Math.min(a1, Math.max(b0, b1)) - Math.max(a0, Math.min(b0, b1)) >= -eps;
  return true;
}

/**
 * Triangles A (offset a) and B (offset b) in T (9 numbers each) meet beyond what they share: `shared` corners (0, 1
 * or 2; the shared corners must be the same points). eps: length tolerance.
 */
export function trianglesContact(T: ArrayLike<number>, a: number, b: number, shared: number, eps: number): boolean {
  const A = [T[a], T[a + 1], T[a + 2], T[a + 3], T[a + 4], T[a + 5], T[a + 6], T[a + 7], T[a + 8]];
  const B = [T[b], T[b + 1], T[b + 2], T[b + 3], T[b + 4], T[b + 5], T[b + 6], T[b + 7], T[b + 8]];
  const nrm = (X: number[]) => {
    const ux = X[3] - X[0], uy = X[4] - X[1], uz = X[5] - X[2], wx = X[6] - X[0], wy = X[7] - X[1], wz = X[8] - X[2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz);
    return l > 0 ? [nx / l, ny / l, nz / l, l / 2] : null;
  };
  const nA = nrm(A), nB = nrm(B);
  if (!nA || !nB) return false; // degenerate triangles are reported by the degeneracy checks
  // distances of each triangle's corners to the other's plane
  const dA = [0, 1, 2].map((k) => dot(A[k * 3] - B[0], A[k * 3 + 1] - B[1], A[k * 3 + 2] - B[2], nB[0], nB[1], nB[2]));
  const dB = [0, 1, 2].map((k) => dot(B[k * 3] - A[0], B[k * 3 + 1] - A[1], B[k * 3 + 2] - A[2], nA[0], nA[1], nA[2]));
  const side = (d: number[]) => (d.every((x) => x > eps) ? 1 : d.every((x) => x < -eps) ? -1 : 0);
  if (side(dA) !== 0 || side(dB) !== 0) return false;
  const coplanar = dA.every((x) => Math.abs(x) <= eps) && dB.every((x) => Math.abs(x) <= eps);
  if (coplanar) {
    // project on the dominant axis plane of A's normal, orient both counter-clockwise
    const ax = Math.abs(nA[0]), ay = Math.abs(nA[1]), az = Math.abs(nA[2]);
    const [i, j] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [2, 0] : [0, 1];
    const p2 = (X: number[]) => { const q = [X[i], X[j], X[3 + i], X[3 + j], X[6 + i], X[6 + j]]; return area2(q[0], q[1], q[2], q[3], q[4], q[5]) < 0 ? [q[0], q[1], q[4], q[5], q[2], q[3]] : q; };
    const pa = p2(A), pb = p2(B);
    const proj = Math.max(ax, ay, az) || 1;
    const ov = clipArea(pa, pb) / proj;
    if (ov > 1e-9 * Math.min(nA[3], nB[3])) return true;
    if (shared) return false;
    // no area in common: touching edges or corners still count when nothing is shared
    for (let e = 0; e < 3; e++) for (let f = 0; f < 3; f++) {
      if (segTouch(pa[e * 2], pa[e * 2 + 1], pa[((e + 1) % 3) * 2], pa[((e + 1) % 3) * 2 + 1], pb[f * 2], pb[f * 2 + 1], pb[((f + 1) % 3) * 2], pb[((f + 1) % 3) * 2 + 1], eps * proj)) return true;
    }
    return false;
  }
  if (shared >= 2) return false;
  // interval of each triangle on the line L = nA × nB, from the points where its edges meet the other plane
  const Lx = nA[1] * nB[2] - nA[2] * nB[1], Ly = nA[2] * nB[0] - nA[0] * nB[2], Lz = nA[0] * nB[1] - nA[1] * nB[0];
  const interval = (X: number[], d: number[]): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    const add = (x: number, y: number, z: number) => { const s = x * Lx + y * Ly + z * Lz; if (s < lo) lo = s; if (s > hi) hi = s; };
    for (let k = 0; k < 3; k++) {
      const m = (k + 1) % 3;
      if (Math.abs(d[k]) <= eps) add(X[k * 3], X[k * 3 + 1], X[k * 3 + 2]);
      if ((d[k] > eps && d[m] < -eps) || (d[k] < -eps && d[m] > eps)) {
        const t = d[k] / (d[k] - d[m]);
        add(X[k * 3] + (X[m * 3] - X[k * 3]) * t, X[k * 3 + 1] + (X[m * 3 + 1] - X[k * 3 + 1]) * t, X[k * 3 + 2] + (X[m * 3 + 2] - X[k * 3 + 2]) * t);
      }
    }
    return [lo, hi];
  };
  const [a0, a1] = interval(A, dA), [b0, b1] = interval(B, dB);
  const ll = Math.hypot(Lx, Ly, Lz) || 1;
  const overlap = (Math.min(a1, b1) - Math.max(a0, b0)) / ll;
  // one shared corner: the planes' line runs through it and both intervals contain it; more than a point in common is a fold
  return shared === 1 ? overlap > eps : overlap >= -eps;
}
