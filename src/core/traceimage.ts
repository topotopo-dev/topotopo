// Binary image contours on pixel edges. Foreground uses 4-connectivity, so diagonal contacts
// remain separate. Simplification only removes a vertex when its swept triangle is empty of
// every other boundary and the accumulated error stays within tolerance.
export type PixelPoint = [number, number];
export interface ImageContour { points: PixelPoint[]; component: number; hole: boolean }
const MAX_EDGES = 1_000_000;

const cross = (a: PixelPoint, b: PixelPoint, c: PixelPoint) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function area(p: PixelPoint[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
  return a / 2;
}
function collinear(p: PixelPoint[]): PixelPoint[] {
  return p.filter((v, i) => cross(p[(i + p.length - 1) % p.length], v, p[(i + 1) % p.length]) !== 0);
}

export function traceMask(mask: Float32Array, w: number, h: number, threshold: number, minArea: number, tolerance: number): ImageContour[] {
  const n = w * h, labels = new Int32Array(n), queue = new Int32Array(n), counts: number[] = [];
  // Stable row-major component numbering and linear-time flood fill.
  for (let s = 0; s < n; s++) {
    if (labels[s] || !(mask[s] >= threshold)) continue;
    const id = counts.length + 1;
    let head = 0, tail = 1;
    queue[0] = s; labels[s] = id;
    const visit = (k: number) => { if (!labels[k] && mask[k] >= threshold) { labels[k] = id; queue[tail++] = k; } };
    while (head < tail) {
      const k = queue[head++], x = k % w;
      if (x > 0) visit(k - 1);
      if (x + 1 < w) visit(k + 1);
      if (k >= w) visit(k - w);
      if (k + w < n) visit(k + w);
    }
    counts.push(tail);
  }
  const inside = (x: number, y: number) => x >= 0 && x < w && y >= 0 && y < h && labels[y * w + x] > 0 && counts[labels[y * w + x] - 1] >= minArea;
  const seen = new Uint8Array(n), out: ImageContour[] = [];
  let edges = 0;
  // Edge directions: right, down, left, up; foreground is always to the right.
  const dx = [1, 0, -1, 0], dy = [0, 1, 0, -1];
  const boundary = (x: number, y: number, d: number) => inside(x, y) && !inside(x + (d === 1 ? 1 : d === 3 ? -1 : 0), y + (d === 2 ? 1 : d === 0 ? -1 : 0));
  const edgeAt = (x: number, y: number, d: number): [number, number] => [x - (d === 1 || d === 2 ? 1 : 0), y - (d === 2 || d === 3 ? 1 : 0)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inside(x, y)) continue;
    for (let d = 0; d < 4; d++) {
      if ((seen[y * w + x] & (1 << d)) || !boundary(x, y, d)) continue;
      const start = (y * w + x) * 4 + d, points: PixelPoint[] = [];
      let px = x, py = y, dir = d;
      let vx = x + (d === 1 || d === 2 ? 1 : 0), vy = y + (d === 2 || d === 3 ? 1 : 0);
      do {
        if (++edges > MAX_EDGES) throw new Error('trace_image: more than 1,000,000 boundary edges; crop the image, lower its resolution, or increase min_area');
        seen[py * w + px] |= 1 << dir;
        points.push([vx, vy]);
        vx += dx[dir]; vy += dy[dir];
        let found = false;
        for (const turn of [1, 0, 3, 2]) {
          const nd = (dir + turn) % 4, [nx, ny] = edgeAt(vx, vy, nd);
          if (!boundary(nx, ny, nd)) continue;
          px = nx; py = ny; dir = nd; found = true; break;
        }
        if (!found) throw new Error('trace_image: open boundary');
      } while ((py * w + px) * 4 + dir !== start);
      const clean = collinear(points);
      if (clean.length >= 3) out.push({ points: clean, component: labels[y * w + x] - 1, hole: area(clean) < 0 });
    }
  }
  if (tolerance > 0) simplifyContours(out, tolerance);
  return out;
}

interface Vertex {
  p: PixelPoint; prev: number; next: number; loop: number; active: boolean;
  // Original corners represented by the outgoing edge, for a non-accumulating error bound.
  span: PixelPoint[];
}
function dist2(p: PixelPoint, a: PixelPoint, b: PixelPoint): number {
  const x = b[0] - a[0], y = b[1] - a[1], len = x * x + y * y;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * x + (p[1] - a[1]) * y) / len)) : 0;
  return (p[0] - a[0] - t * x) ** 2 + (p[1] - a[1] - t * y) ** 2;
}
function inTriangle(p: PixelPoint, a: PixelPoint, b: PixelPoint, c: PixelPoint): boolean {
  const x = cross(a, b, p), y = cross(b, c, p), z = cross(c, a, p);
  return (x >= 0 && y >= 0 && z >= 0) || (x <= 0 && y <= 0 && z <= 0);
}
function intersects(a: PixelPoint, b: PixelPoint, c: PixelPoint, d: PixelPoint): boolean {
  return Math.max(a[0], b[0]) >= Math.min(c[0], d[0]) && Math.max(c[0], d[0]) >= Math.min(a[0], b[0]) &&
    Math.max(a[1], b[1]) >= Math.min(c[1], d[1]) && Math.max(c[1], d[1]) >= Math.min(a[1], b[1]) &&
    cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
}

/** Spatially indexed conservative vertex removal; never collapses a hole or joins two components. */
function simplifyContours(loops: ImageContour[], tolerance: number): void {
  const verts: Vertex[] = [], counts = loops.map((l) => l.points.length), first: number[] = [];
  for (let l = 0; l < loops.length; l++) {
    const points = loops[l].points, start = verts.length;
    first.push(start);
    points.forEach((p, i) => verts.push({ p, prev: start + (i + points.length - 1) % points.length, next: start + (i + 1) % points.length, loop: l, active: true, span: [p] }));
  }
  // Index edges by bounding boxes. Existing long straight boundaries are cheap (one cell wide).
  const cell = 16, bins = new Map<string, Set<number>>();
  const keys = (a: PixelPoint, b: PixelPoint, c?: PixelPoint): string[] => {
    const minx = Math.floor(Math.min(a[0], b[0], c?.[0] ?? a[0]) / cell), maxx = Math.floor(Math.max(a[0], b[0], c?.[0] ?? a[0]) / cell);
    const miny = Math.floor(Math.min(a[1], b[1], c?.[1] ?? a[1]) / cell), maxy = Math.floor(Math.max(a[1], b[1], c?.[1] ?? a[1]) / cell);
    const result: string[] = [];
    for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) result.push(x + ',' + y);
    return result;
  };
  const index = (i: number, add: boolean) => {
    for (const k of keys(verts[i].p, verts[verts[i].next].p)) {
      if (add) { let s = bins.get(k); if (!s) bins.set(k, s = new Set()); s.add(i); }
      else { const s = bins.get(k); s?.delete(i); if (!s?.size) bins.delete(k); }
    }
  };
  verts.forEach((_, i) => index(i, true));
  // Pixel masks can have zero-width contacts (including repeated vertices within one
  // outline). Keep the participating components exact: changing even the ordering of
  // their wedges can change how a downstream polygon fill resolves such pinches.
  const fixedComponents = new Set<number>();
  verts.forEach((v, i) => {
    for (const e of bins.get(Math.floor(v.p[0] / cell) + ',' + Math.floor(v.p[1] / cell)) ?? []) {
      if (e === i || e === v.prev) continue;
      const a = verts[e].p, b = verts[verts[e].next].p;
      if (cross(a, b, v.p) === 0 && v.p[0] >= Math.min(a[0], b[0]) && v.p[0] <= Math.max(a[0], b[0]) &&
          v.p[1] >= Math.min(a[1], b[1]) && v.p[1] <= Math.max(a[1], b[1])) {
        fixedComponents.add(loops[v.loop].component); fixedComponents.add(loops[verts[e].loop].component);
      }
    }
  });
  // Preserve contacts as well as crossings: a diagonal pinch can close a hole even when
  // no pair of segments crosses strictly. Only an actual shared adjacent vertex is allowed.
  const blocked = (a: number, b: number, c: number, d: number) => {
    if (!intersects(verts[a].p, verts[b].p, verts[c].p, verts[d].p)) return false;
    const shared = a === c || a === d ? a : b === c || b === d ? b : -1;
    if (shared < 0) return true;
    const s = verts[shared].p, p = verts[a === shared ? b : a].p, q = verts[c === shared ? d : c].p;
    return cross(s, p, q) === 0 && (p[0] - s[0]) * (q[0] - s[0]) + (p[1] - s[1]) * (q[1] - s[1]) > 0;
  };
  const pending = verts.map((_, i) => i), queued = new Set(pending);
  for (let head = 0; head < pending.length; head++) {
    const i = pending[head]; queued.delete(i);
    const v = verts[i];
    if (!v.active || counts[v.loop] <= 3 || fixedComponents.has(loops[v.loop].component)) continue;
    const p = verts[v.prev], n = verts[v.next], a = p.p, b = v.p, c = n.p;
    if ((a[0] === c[0] && a[1] === c[1]) || dist2(b, a, c) > tolerance * tolerance) continue;
    if (p.span.some((q) => dist2(q, a, c) > tolerance * tolerance) || v.span.some((q) => dist2(q, a, c) > tolerance * tolerance)) continue;
    const candidates = new Set<number>();
    for (const k of keys(a, b, c)) for (const e of bins.get(k) ?? []) candidates.add(e);
    let safe = true;
    for (const e of candidates) {
      if (e === v.prev || e === i) continue;
      const edge = verts[e], end = edge.next, q = edge.p, r = verts[end].p;
      // Only the actual adjacent vertices may touch the swept triangle.
      if ((e !== v.prev && e !== v.next && inTriangle(q, a, b, c)) ||
          (end !== v.prev && end !== v.next && inTriangle(r, a, b, c)) ||
          blocked(v.prev, v.next, e, end) || blocked(v.prev, i, e, end) || blocked(i, v.next, e, end)) { safe = false; break; }
    }
    if (!safe) continue;
    index(v.prev, false); index(i, false);
    p.span = p.span.concat(v.span); p.next = v.next; n.prev = v.prev;
    v.active = false; counts[v.loop]--;
    if (first[v.loop] === i) first[v.loop] = v.next;
    index(v.prev, true);
    for (const k of [v.prev, v.next]) if (!queued.has(k)) { pending.push(k); queued.add(k); }
  }
  for (let l = 0; l < loops.length; l++) {
    const points: PixelPoint[] = [];
    let i = first[l];
    do { points.push(verts[i].p); i = verts[i].next; } while (i !== first[l]);
    loops[l].points = points;
  }
}

