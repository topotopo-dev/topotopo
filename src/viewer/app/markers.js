// Guides: what a person places in the view to direct the agent ("village here", "road along here", "keep this area
// empty"). The page edits the list and POSTs all of it; src/viewer/server.ts checks it with parseMarkers (this module,
// so the page and the server share one set of rules) and writes inputs/markers.json, which agents read like any
// input file (help topic "inputs": string attributes name and role, pscale = a null's radius).
// Plain functions, no DOM and no three.js: tested in Node (test/viewer-logic.ts).

/** The roles the LLM reads, and the editor's name for each. */
export const MARKER_KINDS = ['site', 'path', 'zone', 'volume'];
export const EDITOR_NAMES = { site: 'null', path: 'curve', zone: 'area', volume: 'volume' };
/** [fewest, most] points per kind: a null's point, a curve's CVs, an area's corners, a volume's two ground corners */
export const MARKER_POINTS = { site: [1, 1], path: [2, Infinity], zone: [3, Infinity], volume: [2, 2] };
export const DEFAULT_RADIUS = 5, DEFAULT_HEIGHT = 10;

/** A marker list that breaks a rule; the server answers it with 400 and the message. */
export class MarkerError extends Error {}

/**
 * A marker list (the POST /api/markers body, or the stored list) checked and normalised: names trimmed and unique
 * (ignoring case), the defaults filled in, ids given to markers without one. Throws MarkerError naming the problem.
 */
export function parseMarkers(body) {
  const list = body?.markers;
  if (!Array.isArray(list)) throw new MarkerError('the body must be {"markers": [{id, kind, name, points, rotate?, radius?, height?}, ...]}');
  const bad = (i, msg) => new MarkerError(`markers[${i}]: ${msg}`);
  const names = new Map(), ids = new Set();
  const out = list.map((m, i) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad(i, 'must be an object {id, kind, name, points}');
    const kind = m.kind;
    if (!MARKER_KINDS.includes(kind)) throw bad(i, `kind ${JSON.stringify(m.kind)}: use ${MARKER_KINDS.join(', ')}`);
    const name = typeof m.name === 'string' ? m.name.normalize('NFC').trim() : '';
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw bad(i, `${m.name === undefined ? 'no name' : `name ${JSON.stringify(m.name)}`}: give 1 to 100 printable characters`);
    const key = name.toLowerCase();
    if (names.has(key)) throw bad(i, `name "${name}" is taken by markers[${names.get(key)}]: names must be unique`);
    names.set(key, i);
    if (m.id !== undefined) {
      if (typeof m.id !== 'string' || !m.id || m.id.length > 64) throw bad(i, 'id must be a string of 1 to 64 characters');
      if (ids.has(m.id)) throw bad(i, `id "${m.id}" is used twice`);
      ids.add(m.id);
    }
    const [lo, hi] = MARKER_POINTS[kind];
    if (!Array.isArray(m.points) || m.points.length < lo || m.points.length > hi)
      throw bad(i, `a ${kind} needs ${lo === hi ? lo : `${lo} or more`} point${lo === 1 ? '' : 's'} [x, y, z] (got ${Array.isArray(m.points) ? m.points.length : JSON.stringify(m.points)})`);
    const points = m.points.map((p, k) => {
      if (!Array.isArray(p) || p.length !== 3 || !p.every((x) => typeof x === 'number' && Number.isFinite(x))) throw bad(i, `points[${k}] must be [x, y, z] in metres (got ${JSON.stringify(p)})`);
      return [p[0], p[1], p[2]];
    });
    const size = (v, what, def) => {
      if (v === undefined || v === null) return def;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw bad(i, `${what} must be a number of metres above 0 (got ${JSON.stringify(v)})`);
      return v;
    };
    const r = { id: m.id, kind, name, points };
    if ((kind === 'site' || kind === 'volume') && m.rotate !== undefined) {
      if (!Array.isArray(m.rotate) || m.rotate.length !== 3 || ![...m.rotate].every(Number.isFinite))
        throw bad(i, 'rotate must be [rx, ry, rz] in degrees (got ' + JSON.stringify(m.rotate) + ')');
      if (kind === 'volume' && (m.rotate[0] !== 0 || m.rotate[2] !== 0)) throw bad(i, 'a volume turns about Y only: rotate must be [0, ry, 0]');
      const rotate = m.rotate.map(roundAngle);
      if (rotate.some((v) => v !== 0)) r.rotate = rotate;
    }
    if (kind === 'site') r.radius = size(m.radius, 'radius', DEFAULT_RADIUS);
    if (kind === 'volume') {
      r.height = size(m.height, 'height', DEFAULT_HEIGHT);
      if (points[0][0] === points[1][0] || points[0][2] === points[1][2]) throw bad(i, 'a volume\'s two corners must differ in x and in z');
    }
    return r;
  });
  let n = 0;
  for (const m of out) if (m.id === undefined) { do m.id = `m${++n}`; while (ids.has(m.id)); ids.add(m.id); }
  return out;
}

/** The list as POST /api/markers takes it, in the key order the server stores. */
export const markersBody = (list) => JSON.stringify({ markers: list.map(({ id, kind, name, points, rotate, radius, height }) =>
  ({ id, kind, name, points, rotate, ...(kind === 'site' ? { radius } : {}), ...(kind === 'volume' ? { height } : {}) })) });

/** Whether it is safe to take the guides from disk. */
export const shouldReloadGuides = (saving, editing) => !saving && !editing;

/** A deep copy of a list (undo snapshots). */
export const cloneMarkers = (list) => list.map((m) => ({ ...m, points: m.points.map((p) => [p[0], p[1], p[2]]), ...(m.rotate ? { rotate: m.rotate.slice() } : {}) }));

/** The next free default name for a kind, as Houdini names new objects: null1, curve2, area1, volume3. */
export function nextName(list, kind) {
  const base = EDITOR_NAMES[kind] ?? kind;
  const re = new RegExp(`^${base}\\s*(\\d+)$`, 'i');
  let n = 0;
  for (const m of list) { const r = re.exec(m.name); if (r) n = Math.max(n, Number(r[1])); }
  let name;
  do name = `${base}${++n}`; while (list.some((m) => m.name.toLowerCase() === name));
  return name;
}

/** A new name for marker `id` checked by the server's rules: {name} or {error}. */
export function checkName(list, id, raw) {
  const name = String(raw ?? '').normalize('NFC').trim();
  if (!name) return { error: 'a guide needs a name' };
  if (name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return { error: 'give 1 to 100 printable characters' };
  const clash = list.find((o) => o.id !== id && o.name.toLowerCase() === name.toLowerCase());
  if (clash) return { error: `"${name}" is taken by another guide: names must be unique` };
  return { name };
}

/** Coordinates are kept to the millimetre. */
export const mm = (x) => Math.round(x * 1000) / 1000;
/** How many points a finished guide of this kind needs. */
export const minPoints = (kind) => MARKER_POINTS[kind]?.[0] ?? 1;

export const rotateOf = (m) => m.rotate ?? [0, 0, 0];
const RAD = Math.PI / 180;
// At this magnitude consecutive numbers are already farther apart than 0.001 degrees.
const roundAngle = (x) => Math.abs(x) < 2 ** 43 ? mm(x) || 0 : x;

/** A unit quaternion [x, y, z, w], applying X, then Y, then Z. */
export function quatOfRotate(r) {
  if (r.every((v) => v === 0)) return [0, 0, 0, 1];
  const half = r.map((v) => (v % 360) * RAD / 2);
  const [sx, sy, sz] = half.map(Math.sin), [cx, cy, cz] = half.map(Math.cos);
  const q = [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
  return q.map((v) => (q[3] < 0 ? -v : v) || 0);
}

/** The XYZ angles of a quaternion, with the combined X/Z turn on X at either pole. */
export function rotateOfQuat(q) {
  const scale = Math.max(...q.map(Math.abs));
  if (!(scale > 0) || !Number.isFinite(scale)) return [0, 0, 0];
  const unit = q.map((v) => v / scale);
  const len = Math.hypot(...unit);
  const [x, y, z, w] = unit.map((v) => v / len);
  const r00 = 1 - 2 * (y * y + z * z), r10 = 2 * (x * y + w * z);
  const ry = roundAngle(Math.atan2(2 * (w * y - x * z), Math.hypot(r00, r10)) / RAD);
  if (Math.abs(ry) === 90) return [roundAngle(Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + z * z)) / RAD), ry, 0];
  return [
    roundAngle(Math.atan2(2 * (y * z + w * x), 1 - 2 * (x * x + y * y)) / RAD),
    ry,
    roundAngle(Math.atan2(r10, r00) / RAD),
  ];
}

/** Turn a point about the vertical line through c. */
export function turnY(p, c, deg) {
  if (deg === 0) return p;
  const a = (deg % 360) * RAD, cos = Math.cos(a), sin = Math.sin(a);
  const x = p[0] - c[0], z = p[2] - c[2];
  return [c[0] + cos * x + sin * z, p[1], c[2] - sin * x + cos * z];
}

/** A volume's box as the server builds it: the lower corner's y, up by height. */
export function boxOf(m) {
  const [a, c] = m.points;
  const lo = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2])];
  return { lo, hi: [Math.max(a[0], c[0]), lo[1] + (m.height ?? DEFAULT_HEIGHT), Math.max(a[2], c[2])] };
}
/** A volume's eight world corners, indexed by 4i + 2j + k for the local sides of x, y, z. */
export function boxPoints(m) {
  const { lo, hi } = boxOf(m), turn = rotateOf(m)[1];
  const c = lo.map((v, a) => (v + hi[a]) / 2), out = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) out.push(turnY([x, y, z], c, turn));
  return out;
}

/** A volume's local dimensions in x, y, z. */
export function volumeSize(m) {
  const { lo, hi } = boxOf(m);
  return [hi[0] - lo[0], m.height ?? DEFAULT_HEIGHT, hi[2] - lo[2]];
}

export const pathLength = (pts) => pts.slice(1).reduce((s, p, k) => s + Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1], p[2] - pts[k][2]), 0);
/** The area of a polygon seen from above (x, z), m². */
export const topArea = (pts) => Math.abs(pts.reduce((s, p, k) => { const q = pts[(k + 1) % pts.length]; return s + p[0] * q[2] - q[0] * p[2]; }, 0)) / 2;
export function insideTop(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, , zi] = pts[i], [xj, , zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
export const centroid = (pts) => [0, 1, 2].map((a) => pts.reduce((s, p) => s + p[a], 0) / Math.max(1, pts.length));

/** The point halfway along a polyline. */
export function halfway(P) {
  let left = pathLength(P) / 2;
  for (let k = 1; k < P.length; k++) {
    const a = P[k - 1], b = P[k], d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (d > 0 && d >= left) { const t = left / d; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
    left -= d;
  }
  return P[P.length - 1].slice();
}

/** Where a guide's transform sits: a null's point, a curve's or an area's CV centre, a volume's box centre. */
export function pivotOf(m) {
  if (m.kind === 'site') return m.points[0].slice();
  if (m.kind === 'volume') { const { lo, hi } = boxOf(m); return [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2); }
  return centroid(m.points);
}

/** The bounds framing a guide shows: a null with its radius, the CVs, the box. */
export function boundsOf(m) {
  if (m.kind === 'volume') return pointBounds(boxPoints(m));
  if (m.kind === 'site') {
    const [x, y, z] = m.points[0], r = m.radius ?? DEFAULT_RADIUS;
    return { lo: [x - r, y - r * 0.1, z - r], hi: [x + r, y + r * 0.1, z + r] };
  }
  return pointBounds(m.points);
}

export function pointBounds(points) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
  return { lo, hi };
}

/**
 * The attributes the LLM reads for a guide in inputs/markers.json, as the server writes them (markersGeometry in
 * src/viewer/server.ts): rows {cls, name, type, value}.
 */
export function markerAttributes(m) {
  if (m.kind === 'site') {
    return [
      { cls: 'point', name: 'name', type: 'string', value: m.name },
      { cls: 'point', name: 'role', type: 'string', value: 'site' },
      { cls: 'point', name: 'pscale', type: 'float', value: m.radius ?? DEFAULT_RADIUS },
      { cls: 'point', name: 'orient', type: 'float4', value: quatOfRotate(rotateOf(m)).map((v) => Math.round(v * 10000) / 10000 || 0) },
    ];
  }
  return [
    { cls: 'prim', name: 'name', type: 'string', value: m.name },
    { cls: 'prim', name: 'role', type: 'string', value: m.kind },
  ];
}

/** The elements a guide becomes in inputs/markers.json: {points, prims, text}. */
export function markerElements(m) {
  const n = m.points.length;
  if (m.kind === 'site') return { points: 1, prims: 0, text: '1 point' };
  if (m.kind === 'path') return { points: n, prims: 1, text: `1 open polyline, ${n} points` };
  if (m.kind === 'zone') return { points: n, prims: 1, text: `1 closed polygon facing up, ${n} points` };
  return { points: 8, prims: 6, text: '1 closed box: 6 quads facing out, 8 points' };
}

/** A group pattern picking one guide out of inputs/markers.json (patterns split on spaces: "?" matches one). */
export const groupOf = (m) => `@name=${m.name.replace(/\s/g, '?')}`;

/**
 * The diagonal hatch inside an area: segments [[x, y, z], [x, y, z]] of lines at 45° in x, z, `spacing` apart,
 * clipped to the polygon (even-odd), each end at the height of the edge it meets.
 */
export function hatchSegments(pts, spacing) {
  const n = pts.length, out = [];
  if (n < 3 || !(spacing > 0)) return out;
  // lines u = x + z = const, walked along v = x - z
  const U = pts.map((p) => p[0] + p[2]), V = pts.map((p) => p[0] - p[2]);
  const u0 = Math.min(...U), u1 = Math.max(...U);
  if ((u1 - u0) / spacing > 2000) spacing = (u1 - u0) / 2000;
  for (let u = Math.ceil(u0 / spacing) * spacing; u <= u1; u += spacing) {
    const hits = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = U[i], b = U[j];
      if ((a <= u) === (b <= u)) continue;
      const t = (u - a) / (b - a);
      hits.push({ v: V[i] + (V[j] - V[i]) * t, y: pts[i][1] + (pts[j][1] - pts[i][1]) * t });
    }
    hits.sort((p, q) => p.v - q.v);
    for (let k = 0; k + 1 < hits.length; k += 2) {
      const a = hits[k], b = hits[k + 1];
      if (b.v - a.v < 1e-9) continue;
      // x = (u + v) / 2, z = (u - v) / 2
      out.push([[(u + a.v) / 2, a.y, (u - a.v) / 2], [(u + b.v) / 2, b.y, (u - b.v) / 2]]);
    }
  }
  return out;
}

// ------------------------------------------------------------------ direct edits (dragging in the view)
// Each takes a marker and returns a new one (the input is left alone), points kept to the millimetre; null when the
// edit would break the kind's rules (MARKER_POINTS, a volume's corners differing in x and z).
const mm3 = (p) => [mm(p[0]), mm(p[1]), mm(p[2])];
const withPoints = (m, points) => ({ ...m, points });

/** Set an angle on a null, or a volume's turn about Y. */
export function setRotate(m, axis, value) {
  if (!Number.isInteger(axis) || axis < 0 || axis > 2 || !Number.isFinite(value)) return null;
  if (m.kind !== 'site' && !(m.kind === 'volume' && axis === 1)) return null;
  const { rotate, ...next } = m, angles = rotateOf(m).slice();
  angles[axis] = roundAngle(value);
  if (angles.some((v) => v !== 0)) next.rotate = angles;
  return next;
}

/** Change a volume's local size, about its centre in X/Z and up from its floor in Y. */
export function setVolumeSize(m, axis, v) {
  if (m.kind !== 'volume' || !(v > 0) || !Number.isFinite(v)) return null;
  if (axis === 1) return { ...m, height: v };
  if (axis !== 0 && axis !== 2) return null;
  const [a, b] = m.points, c = (a[axis] + b[axis]) / 2;
  const half = (a[axis] < b[axis] ? v : -v) / 2;
  const points = [a.slice(), b.slice()];
  points[0][axis] = mm(c - half); points[1][axis] = mm(c + half);
  if (!points.every((p) => Number.isFinite(p[axis])) || points[0][axis] === points[1][axis]) return null;
  return withPoints(m, points);
}

/** Point `k` (a null's point, a CV, a volume's ground corner as stored) moved to `p`. */
export function movePoint(m, k, p) {
  if (!(k >= 0 && k < m.points.length)) return null;
  const points = m.points.map((q, i) => (i === k ? mm3(p) : q.slice()));
  if (m.kind === 'volume' && (points[0][0] === points[1][0] || points[0][2] === points[1][2])) return null;
  return withPoints(m, points);
}

/** The whole guide moved by `d` [dx, dy, dz]. */
export const translateMarker = (m, d) => withPoints(m, m.points.map((p) => mm3([p[0] + d[0], p[1] + d[1], p[2] + d[2]])));

/**
 * The segments of a curve or an area as pairs of point indices: a curve's k → k+1, an area's also its closing edge
 * (last → 0). Nulls and volumes have none.
 */
export function segmentsOf(m) {
  if (m.kind !== 'path' && m.kind !== 'zone') return [];
  const n = m.points.length, out = [];
  for (let k = 0; k + 1 < n; k++) out.push([k, k + 1]);
  if (m.kind === 'zone' && n >= 3) out.push([n - 1, 0]);
  return out;
}

/** A new CV at `p` on segment `s` (segmentsOf's index): it lands between the segment's two ends. */
export function insertPoint(m, s, p) {
  const seg = segmentsOf(m)[s];
  if (!seg) return null;
  const points = m.points.map((q) => q.slice());
  // the closing edge of an area (last → 0) takes its new corner at the end
  points.splice(seg[1] === 0 ? points.length : seg[1], 0, mm3(p));
  return withPoints(m, points);
}

/** CV `k` removed; null when the guide would have fewer points than its kind needs (a curve 2, an area 3). */
export function removePoint(m, k) {
  if (m.kind !== 'path' && m.kind !== 'zone') return null;
  if (!(k >= 0 && k < m.points.length) || m.points.length - 1 < minPoints(m.kind)) return null;
  return withPoints(m, m.points.filter((_, i) => i !== k).map((q) => q.slice()));
}

/** A volume's four ground corners [x, lo y, z], walked around the box: (lo x, lo z), (hi x, lo z), (hi x, hi z), (lo x, hi z). */
export function volumeCorners(m) {
  const p = boxPoints(m);
  return [p[0], p[4], p[5], p[1]];
}

/** A volume with ground corner `k` (volumeCorners' order) dragged to `p` in x and z; the opposite corner stays. */
export function resizeVolume(m, k, p) {
  const fixed = volumeCorners(m)[(k + 2) % 4], target = [p[0], fixed[1], p[2]];
  const c = fixed.map((v, i) => (v + target[i]) / 2), turn = rotateOf(m)[1];
  const a = mm3(turnY(fixed, c, -turn)), b = mm3(turnY(target, c, -turn));
  if (a[0] === b[0] || a[2] === b[2]) return null;
  return withPoints(m, [a, b]);
}
