// Snapping in world coordinates and viewport pixels.
import { mm } from './markers.js';
import { fmtStep } from './units.js';

export const SNAP_PX = 12;
export const SNAP_TARGETS = ['grid', 'point', 'surface'];
const AXES = ['x', 'y', 'z'];

export const snapMode = ({ on, target, held }) => held ?? (on ? target : null);
export const snapTo = (v, step) => mm(Math.round(v / step) * step) || 0;
export const gridPoint = (p, step, axes) => p.map((v, i) => axes.includes(AXES[i]) ? snapTo(v, step) : v);
export const landMove = (id, pivot, point) => pivot.map((v, i) => id.includes(AXES[i]) ? mm(point[i] - v) || 0 : 0);

export function gridMove(id, pivot, delta, step) {
  return landMove(id, pivot, gridPoint(pivot.map((v, i) => v + delta[i]), step, id));
}

export const snapTurn = (degrees) => snapTo(degrees, 15);
export const snapScale = (factor) => Math.max(0.1, snapTo(factor, 0.1));

export function nearestOnScreen(candidates, project, x, y, px = SNAP_PX) {
  let best = null;
  for (const candidate of candidates) {
    const q = project(candidate.point);
    if (!q) continue;
    const d = Math.hypot(q.x - x, q.y - y);
    if (d <= px && (!best || d < best.d)) best = { ...candidate, d };
  }
  return best;
}

export function snapText(mode, step) {
  if (mode === 'grid') return `snap to grid ${fmtStep(step)}`;
  return mode ? `snap to ${mode}` : '';
}

/** The closest vertex to a world ray in pixels, without projecting the vertices. */
export function nearestVertexOnRay(positions, matrix, ray, pixel, px = SNAP_PX) {
  const [ox, oy, oz] = ray.origin, [rx, ry, rz] = ray.direction;
  let best = null;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    let x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (matrix) {
      const a = x, b = y, c = z;
      x = matrix[0] * a + matrix[4] * b + matrix[8] * c + matrix[12];
      y = matrix[1] * a + matrix[5] * b + matrix[9] * c + matrix[13];
      z = matrix[2] * a + matrix[6] * b + matrix[10] * c + matrix[14];
    }
    const vx = x - ox, vy = y - oy, vz = z - oz;
    const depth = vx * rx + vy * ry + vz * rz;
    if (!(depth > 0)) continue;
    const scale = pixel(depth);
    if (!(scale > 0)) continue;
    const limit = (best?.away ?? px) * scale;
    // A vertex outside the bound on any axis cannot fit within the pixel radius.
    const dx = vx - depth * rx;
    if (Math.abs(dx) > limit) continue;
    const dy = vy - depth * ry;
    if (Math.abs(dy) > limit) continue;
    const dz = vz - depth * rz;
    if (Math.abs(dz) > limit) continue;
    const squared = dx * dx + dy * dy + dz * dz;
    if (squared > limit * limit) continue;
    const away = Math.sqrt(squared) / scale;
    if (away <= px && (!best || away < best.away)) best = { point: [x, y, z], depth, away };
  }
  return best;
}
