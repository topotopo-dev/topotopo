// World-space moves of selected guides and CVs, and their handles in view pixels.
import { mm, pivotOf, translateMarker } from './markers.js';
import { parseId } from './selection.js';

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const PLANES = { xy: 'z', yz: 'x', xz: 'y' };
const START = 14;
/** Within this many pixels of an arrow's line the pointer is on the arrow. */
const ON = 3;
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const rounded = (v) => mm(v) + 0;

/** One position per whole guide or selected CV, with a move from the original list. */
export function moveTargets(list, items, hidden) {
  const selected = new Map();
  for (const id of items) {
    const { obj, piece } = parseId(id);
    if (!obj.startsWith('guide:')) continue;
    const key = obj.slice(6);
    if (hidden.has(key) || selected.get(key) === null) continue;
    if (piece === null) selected.set(key, null);
    else {
      if (!selected.has(key)) selected.set(key, new Set());
      selected.get(key).add(piece);
    }
  }
  const positions = [], moves = new Map();
  let cvs = 0, name;
  for (const m of list) {
    if (!selected.has(m.id)) continue;
    const pieces = selected.get(m.id);
    if (pieces === null) {
      positions.push(pivotOf(m));
      moves.set(m, (d) => translateMarker(m, d));
    } else {
      if (m.kind !== 'path' && m.kind !== 'zone') continue;
      const keys = [...pieces].filter((k) => k < m.points.length);
      if (!keys.length) continue;
      for (const k of keys) positions.push(m.points[k]);
      cvs += keys.length;
      moves.set(m, (d) => ({ ...m, points: m.points.map((p, k) => pieces.has(k) ? p.map((v, i) => rounded(v + d[i])) : p) }));
    }
    name = m.name;
  }
  if (!positions.length) return null;
  return {
    pivot: [0, 1, 2].map((i) => rounded(positions.reduce((sum, p) => sum + p[i], 0) / positions.length)),
    guides: moves.size, cvs, name: moves.size === 1 ? name : null,
    move: (d) => list.map((m) => moves.get(m)?.(d) ?? m),
  };
}

/**
 * The projected endpoints already include the side-on length `size`. An endpoint's `depth` (its distance from the
 * camera) orders the arrows far to near, the order they are drawn in, so the nearest arrow ends on top.
 */
export function moveGizmo(pivot, axes, size) {
  if (!(size > 0)) return [];
  const shapes = [];
  for (const id of Object.keys(AXES)) {
    const to = axes[id];
    if (to && Math.hypot(to.x - pivot.x, to.y - pivot.y) >= START) shapes.push({ id, kind: 'arrow', from: pivot, to });
  }
  shapes.sort((a, b) => (b.to.depth ?? 0) - (a.to.depth ?? 0));
  for (const id of Object.keys(PLANES)) {
    const a = axes[id[0]], b = axes[id[1]];
    if (!a || !b) continue;
    const ax = a.x - pivot.x, ay = a.y - pivot.y, bx = b.x - pivot.x, by = b.y - pivot.y;
    if (Math.abs(ax * by - ay * bx) < 60 / 0.04) continue;
    const at = (u, v) => ({ x: pivot.x + u * ax + v * bx, y: pivot.y + u * ay + v * by });
    shapes.push({ id, kind: 'square', corners: [at(0.3, 0.3), at(0.5, 0.3), at(0.5, 0.5), at(0.3, 0.5)] });
  }
  return shapes;
}

/** The handle under a view point: a square before any arrow, and of two arrows under the pointer the one drawn on top. */
export function hitGizmo(shapes, x, y) {
  let best = null, distance = Infinity;
  for (const shape of shapes) {
    if (shape.kind === 'square') {
      const sides = shape.corners.map((a, i, corners) => {
        const b = corners[(i + 1) % corners.length];
        return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      });
      if (sides.every((s) => s >= 0) || sides.every((s) => s <= 0)) return shape.id;
    } else {
      const { from, to } = shape;
      const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
      const px = x - from.x, py = y - from.y;
      const along = (px * dx + py * dy) / length;
      if (along < START || along > length + 4) continue;
      const away = Math.abs(px * dy - py * dx) / length;
      // a later arrow is drawn over the earlier ones: it wins when the pointer is on it, or when it is the nearer one
      if (away <= 6 && (away < distance || away <= ON)) { best = shape.id; distance = away; }
    }
  }
  return best;
}

/** Distance along the axis to the point closest to the ray. */
export function axisMove(ray, pivot, axis) {
  const c = dot(ray.direction, axis), denom = 1 - c * c;
  if (denom <= 1e-6) return null;
  const offset = sub(ray.origin, pivot);
  const alongAxis = dot(offset, axis), alongRay = dot(offset, ray.direction);
  const t = Math.max(0, (c * alongAxis - alongRay) / denom);
  return alongAxis + c * t;
}

export function planeMove(ray, pivot, normal) {
  const c = dot(ray.direction, normal);
  if (Math.abs(c) <= 1e-6) return null;
  const t = dot(sub(pivot, ray.origin), normal) / c;
  return t < 0 ? null : ray.origin.map((v, i) => v + t * ray.direction[i]);
}

export function moveDelta(id, startRay, ray, pivot) {
  if (Object.hasOwn(AXES, id)) {
    const axis = AXES[id], start = axisMove(startRay, pivot, axis), end = axisMove(ray, pivot, axis);
    return start === null || end === null ? null : axis.map((v) => v ? rounded(end - start) : 0);
  }
  if (!Object.hasOwn(PLANES, id)) return null;
  const normal = AXES[PLANES[id]];
  const start = planeMove(startRay, pivot, normal), end = planeMove(ray, pivot, normal);
  return start === null || end === null ? null : end.map((v, i) => normal[i] ? 0 : rounded(v - start[i]));
}

export function moveText(id, d) {
  return 'move ' + Object.keys(AXES).flatMap((a, i) => id.includes(a) ? [`${a.toUpperCase()} ${d[i].toFixed(2)} m`] : []).join(' · ');
}

export function moveLabel({ guides, cvs, name }) {
  if (guides !== 1) return `move ${guides} guides`;
  if (cvs === 0) return `move ${name}`;
  return `move ${cvs === 1 ? 'CV' : `${cvs} CVs`} of ${name}`;
}

export function typedValue(text, current) {
  const input = text.trim(), op = input[0];
  const relative = ['+', '*', '/'].includes(op);
  const raw = (relative ? input.slice(1).trim() : input).replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || (op === '/' && n === 0)) return null;
  const v = mm(op === '+' ? current + n : op === '*' ? current * n : op === '/' ? current / n : n);
  return Number.isFinite(v) ? v || 0 : null;
}
