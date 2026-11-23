// Transforms of selected guides and CVs, and their gizmos in view pixels.
import { DEFAULT_RADIUS, mm, pivotOf, quatOfRotate, rotateOf, rotateOfQuat, setRotate, setVolumeSize, translateMarker, turnY, volumeSize } from './markers.js';
import { parseId } from './selection.js';

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const AXIS_IDS = Object.keys(AXES);
const PLANES = { xy: 'z', yz: 'x', xz: 'y' };
const RAD = Math.PI / 180;
const START = 14;
/** Within this many pixels of an arrow's line the pointer is on the arrow. */
const ON = 3;
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = ([x, y, z], [a, b, c]) => [y * c - z * b, z * a - x * c, x * b - y * a];
const rounded = (v) => mm(v) + 0;
/** A radius or a height after a scale: to the millimetre, never zero. */
const positiveSize = (v) => Math.max(0.001, rounded(v));
const signedTurn = (v) => {
  const angle = v % 360;
  return angle <= -180 ? angle + 360 : angle > 180 ? angle - 360 : angle || 0;
};

function turnPoint(p, pivot, axis, cos, sin) {
  const v = sub(p, pivot), across = cross(axis, v);
  return p.map((value, i) => axis[i] ? value : rounded(pivot[i] + v[i] * cos + across[i] * sin));
}

function turnNull(m, points, axis, degrees) {
  const [a, b, c, d] = quatOfRotate(axis.map((v) => v * degrees));
  const [x, y, z, w] = quatOfRotate(rotateOf(m));
  const rotate = rotateOfQuat([
    d * x + a * w + b * z - c * y,
    d * y - a * z + b * w + c * x,
    d * z + a * y - b * x + c * w,
    d * w - a * x - b * y - c * z,
  ]);
  const next = { ...m, points, rotate };
  if (rotate.every((v) => v === 0)) delete next.rotate;
  return next;
}

function scaleVolume(m, factors) {
  const size = volumeSize(m);
  return factors.reduce((box, factor, i) => {
    if (factor === 1) return box;
    // A millimetre can round both corners to the same coordinate. Two always leave room.
    return setVolumeSize(box, i, positiveSize(size[i] * factor)) ?? setVolumeSize(box, i, 0.002) ?? box;
  }, m);
}

function volumePoints(m, edit) {
  const points = m.points.map(edit);
  for (const i of [0, 2]) {
    // Keep a box on either side of its corner after rounding a very small width.
    if (points[0][i] === points[1][i]) {
      points[1][i] = rounded(points[0][i] + Math.sign(m.points[1][i] - m.points[0][i]) * 0.001);
    }
  }
  return points;
}

/** One position per whole guide or selected CV, with transforms from the original list. */
export function transformTargets(list, items, hidden) {
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
  const positions = [], touched = new Map();
  let cvs = 0;
  for (const m of list) {
    if (!selected.has(m.id)) continue;
    const pieces = selected.get(m.id);
    if (pieces === null) {
      positions.push(pivotOf(m));
    } else {
      if (m.kind !== 'path' && m.kind !== 'zone') continue;
      const keys = [...pieces].filter((k) => k < m.points.length);
      if (!keys.length) continue;
      for (const k of keys) positions.push(m.points[k]);
      cvs += keys.length;
    }
    touched.set(m, pieces);
  }
  if (!positions.length) return null;
  const pivot = [0, 1, 2].map((i) => rounded(positions.reduce((sum, p) => sum + p[i], 0) / positions.length));
  const guides = touched.size, lone = guides === 1 ? touched.keys().next().value : null;
  const singleCV = positions.length === 1 && cvs === 1;
  const rings = singleCV ? [] : [...touched.keys()].some((m) => m.kind === 'volume') ? ['y'] : AXIS_IDS.slice();
  const scales = singleCV ? 'none' : !lone || lone.kind === 'site' ? 'all' : 'axes';
  const apply = (edit) => list.map((m) => touched.has(m) ? edit(m, touched.get(m)) : m);
  const pointsOf = (m, pieces, edit) => m.points.map((p, k) => !pieces || pieces.has(k) ? edit(p) : p);
  return {
    pivot, guides, cvs, name: lone?.name ?? null, rings, scales, ids: [...touched.keys()].map((m) => m.id),
    frame: lone?.kind === 'volume' ? rotateOf(lone)[1] : 0,
    move: (d) => apply((m, pieces) => pieces === null ? translateMarker(m, d)
      : { ...m, points: pointsOf(m, pieces, (p) => p.map((v, i) => rounded(v + d[i]))) }),
    rotate(axis, degrees) {
      const turn = degrees % 360;
      if (!turn || !rings.includes(axis)) return list.slice();
      const normal = AXES[axis], cos = Math.cos(turn * RAD), sin = Math.sin(turn * RAD);
      return apply((m, pieces) => {
        if (m.kind === 'volume') {
          const centre = pivotOf(m);
          const d = sub(turnY(centre, pivot, turn), centre);
          const next = lone ? m : { ...m, points: volumePoints(m, (p) => p.map((v, i) => d[i] ? rounded(v + d[i]) : v)) };
          return setRotate(next, 1, signedTurn(rounded(rotateOf(m)[1] % 360 + turn)));
        }
        const points = lone && m.kind === 'site' ? m.points : pointsOf(m, pieces, (p) => turnPoint(p, pivot, normal, cos, sin));
        return m.kind === 'site' ? turnNull(m, points, normal, turn) : { ...m, points };
      });
    },
    scale(factors) {
      if (scales === 'none' || factors.every((v) => v === 1)) return list.slice();
      const scalePoint = (p) => p.map((v, i) => factors[i] === 1 ? v : rounded(pivot[i] + (v - pivot[i]) * factors[i]));
      return apply((m, pieces) => {
        if (m.kind === 'volume') {
          if (lone) return scaleVolume(m, factors);
          const height = positiveSize(volumeSize(m)[1] * factors[1]);
          return { ...m, points: volumePoints(m, scalePoint), height };
        }
        const points = lone && m.kind === 'site' ? m.points : pointsOf(m, pieces, scalePoint);
        return m.kind === 'site' ? { ...m, points, radius: positiveSize((m.radius ?? DEFAULT_RADIUS) * factors[0]) } : { ...m, points };
      });
    },
  };
}

/** Projected axes under START pixels are foreshortened. The nearest end is drawn last. */
function axisShapes(pivot, axes, kind) {
  const shapes = [];
  for (const id of AXIS_IDS) {
    const to = axes[id];
    if (to && Math.hypot(to.x - pivot.x, to.y - pivot.y) >= START) shapes.push({ id, kind, from: pivot, to });
  }
  shapes.sort((a, b) => (b.to.depth ?? 0) - (a.to.depth ?? 0));
  return shapes;
}

/** The projected endpoints already include the side-on length `size`. */
export function moveGizmo(pivot, axes, size) {
  if (!(size > 0)) return [];
  const shapes = axisShapes(pivot, axes, 'arrow');
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
      if (away <= 6 && (away <= distance || away <= ON)) { best = shape.id; distance = away; }
    }
  }
  return best;
}

/** World points in the direction of a positive turn about the axis. */
export function ringPoints(pivot, axis, radius, n = 64) {
  return Array.from({ length: n }, (_, k) => {
    const t = 2 * Math.PI * k / n, c = radius * Math.cos(t), s = radius * Math.sin(t);
    const offset = axis === 'x' ? [0, c, s] : axis === 'y' ? [s, 0, c] : [c, s, 0];
    return pivot.map((v, i) => v + offset[i]);
  });
}

export function rotateGizmo(rings) {
  return AXIS_IDS.flatMap((id) => rings[id] ? [{ id, kind: 'ring', points: rings[id] }] : []);
}

export function hitRing(shapes, x, y) {
  let best = null, distance = Infinity, depth = Infinity;
  for (const { id, points } of shapes) {
    for (let k = 0; k < points.length; k++) {
      const a = points[k], b = points[(k + 1) % points.length];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
      if (!length2) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2));
      const away = Math.hypot(a.x + t * dx - x, a.y + t * dy - y);
      const meanDepth = (a.depth + b.depth) / 2;
      if (away <= 6 && (away <= ON && distance <= ON ? meanDepth < depth || (meanDepth === depth && away < distance) : away < distance)) {
        best = { id, k }; distance = away; depth = meanDepth;
      }
    }
  }
  return best;
}

export const ringFromFace = (axis, ray) => Math.abs(dot(ray.direction, AXES[axis])) >= 0.3;

export function ringTurn(axis, pivot, startRay, ray) {
  const normal = AXES[axis], start = planeMove(startRay, pivot, normal), end = planeMove(ray, pivot, normal);
  if (!start || !end) return null;
  const a = sub(start, pivot), b = sub(end, pivot);
  if (!Math.hypot(...a) || !Math.hypot(...b)) return null;
  return signedTurn(Math.round((Math.atan2(dot(normal, cross(a, b)), dot(a, b)) / RAD) * 10) / 10);
}

export const unwrapTurn = (previous, next) => (next + 360 * Math.round((previous - next) / 360)) || 0;

export function tangentTurn(tangent, dx, dy, size) {
  return Math.round(((tangent.x * dx + tangent.y * dy) / size / RAD) * 10) / 10 || 0;
}

export function scaleGizmo(pivot, axes, size, scales) {
  if (!(size > 0) || scales === 'none') return [];
  const stems = scales === 'axes' ? axisShapes(pivot, axes, 'stem') : [];
  return [...stems, { id: 'all', kind: 'centre', at: pivot }];
}

export function hitScale(shapes, x, y) {
  const centre = shapes.find((shape) => shape.kind === 'centre');
  if (centre && Math.abs(centre.at.x - x) <= 7 && Math.abs(centre.at.y - y) <= 7) return 'all';
  return hitGizmo(shapes.filter((shape) => shape.kind === 'stem'), x, y);
}

export function scaleFactor(shape, dx, dy, size) {
  if (shape.kind === 'centre') return rounded(Math.max(0.01, 1 + (dx - dy) / size));
  const x = shape.to.x - shape.from.x, y = shape.to.y - shape.from.y;
  return rounded(Math.max(0.01, 1 + (x * dx + y * dy) / (x * x + y * y)));
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
  return 'move ' + AXIS_IDS.flatMap((a, i) => id.includes(a) ? [`${a.toUpperCase()} ${d[i].toFixed(2)} m`] : []).join(' · ');
}

export const rotateText = (axis, degrees) => `rotate ${axis.toUpperCase()} ${degrees.toFixed(1)}°`;
export const scaleText = (id, factor) => `scale ${id === 'all' ? '' : id.toUpperCase() + ' '}${factor.toFixed(3)}`;

export function transformLabel(verb, { guides, cvs, name }) {
  if (guides !== 1) return `${verb} ${guides} guides`;
  if (cvs === 0) return `${verb} ${name}`;
  return `${verb} ${cvs === 1 ? 'CV' : `${cvs} CVs`} of ${name}`;
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
