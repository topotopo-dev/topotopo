// Analytic lighting and an infinity floor for perspective renders. All distances in the presets are
// fractions of the scene radius or height. Light colours are linear; backdrop and floor are display RGB.
import { cross, dot, normalize, smoothstep } from '../core/math.ts';
import type { Vec3 } from '../core/math.ts';
import { ALPHA_BLEND, ALPHA_MASK } from './pbr.ts';
import type { PBRScene } from './pbr.ts';

interface Light { d: Vec3; c: Vec3 }
interface Lobe extends Light { width: number; strip: number }
type Backdrop = { top: Vec3; floor: Vec3; vignette: number } & (
  { kind: 'sweep'; bottom: Vec3; pool: number; fade: number } |
  { kind: 'daylight'; haze: Vec3; hazeDistance: number; skyRise: number }
);

interface Environment {
  world: boolean;
  lights: Light[];
  sky: Vec3;
  horizon: Vec3;
  ground: Vec3;
  lobes: Lobe[];
  backdrop: Backdrop;
  penumbra: number;
  cast: number;
  contact: number;
}

const PRESETS = {
  studio: {
    world: false,
    lights: [
      { d: [-0.65, 0.62, 0.38], c: [1.74, 1.67, 1.56] },
      { d: [0.75, 0.12, 0.45], c: [0.44, 0.45, 0.46] },
      { d: [0.86, 0.37, -0.34], c: [1.08, 1.06, 1.03] },
    ],
    sky: [0.39, 0.39, 0.4], horizon: [0.31, 0.3, 0.29], ground: [0.31, 0.29, 0.26],
    lobes: [
      { d: [-0.42, 0.89, 0.16], c: [0.67, 0.63, 0.57], width: 0.91, strip: 1.5 },
      { d: [0.91, 0.25, 0.4], c: [0.48, 0.5, 0.55], width: 0.82, strip: 7 },
    ],
    backdrop: {
      kind: 'sweep', top: [0.73, 0.723, 0.714], bottom: [0.79, 0.782, 0.768], floor: [0.688, 0.681, 0.668],
      vignette: 0.038, pool: 0.022, fade: 3.6,
    },
    penumbra: 0.035, cast: 0.23, contact: 0.27,
  },
  studio_dark: {
    world: false,
    lights: [
      { d: [-0.68, 0.66, 0.25], c: [1.25, 1.18, 1.11] },
      { d: [0.76, 0.13, 0.48], c: [0.54, 0.55, 0.59] },
      { d: [0.33, 0.48, -0.81], c: [1.65, 1.7, 1.8] },
    ],
    sky: [0.23, 0.25, 0.29], horizon: [0.24, 0.24, 0.26], ground: [0.12, 0.12, 0.13],
    lobes: [
      { d: [-0.39, 0.91, 0.14], c: [0.68, 0.65, 0.59], width: 0.86, strip: 1.7 },
      { d: [0.9, 0.23, 0.23], c: [0.57, 0.63, 0.74], width: 0.82, strip: 9 },
    ],
    backdrop: {
      kind: 'sweep', top: [0.117, 0.124, 0.14], bottom: [0.154, 0.16, 0.174], floor: [0.145, 0.149, 0.16],
      vignette: 0.023, pool: 0.115, fade: 3.2,
    },
    penumbra: 0.04, cast: 0.40, contact: 0.35,
  },
  daylight: {
    world: true,
    lights: [
      { d: [-0.66, 0.643, 0.39], c: [2.36, 2.17, 1.90] },
      { d: [0.52, 0.76, -0.39], c: [0.24, 0.27, 0.32] },
      { d: [0.65, 0.3, 0.45], c: [0.12, 0.136, 0.158] },
    ],
    sky: [0.23, 0.25, 0.29], horizon: [0.24, 0.25, 0.26], ground: [0.24, 0.22, 0.20],
    lobes: [
      { d: [-0.29, 0.94, 0.18], c: [0.16, 0.17, 0.19], width: 0.94, strip: 1.2 },
      { d: [-0.66, 0.643, 0.39], c: [0.60, 0.53, 0.44], width: 0.40, strip: 4 },
    ],
    backdrop: {
      kind: 'daylight', top: [0.56, 0.705, 0.82], haze: [0.85, 0.84, 0.81], floor: [0.72, 0.70, 0.65],
      vignette: 0.005, hazeDistance: 11, skyRise: 0.31,
    },
    penumbra: 0.016, cast: 0.29, contact: 0.23,
  },
} satisfies Record<string, Environment>;

export type EnvironmentName = 'plain' | keyof typeof PRESETS;
export const ENVIRONMENT_NAMES: readonly EnvironmentName[] = ['plain', 'studio', 'studio_dark', 'daylight'];

export function checkEnvironment(name: unknown): asserts name is EnvironmentName {
  if (!ENVIRONMENT_NAMES.includes(name as EnvironmentName)) {
    throw new Error(`render: environment expects ${ENVIRONMENT_NAMES.join(', ')}, got ${JSON.stringify(name)}`);
  }
}

export function environmentPreset(name: Exclude<EnvironmentName, 'plain'>): Environment {
  return PRESETS[name];
}

const luminance = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const monochrome = (c: Vec3): Vec3 => { const y = luminance(c); return [y, y, y]; };

export function placeEnvironment(preset: Environment, r: Vec3, u: Vec3, f: Vec3, grey: boolean) {
  const place = ([x, y, z]: Vec3): Vec3 => normalize(preset.world ? [x, y, z] : [
    r[0] * x + u[0] * y - f[0] * z, r[1] * x + u[1] * y - f[1] * z, r[2] * x + u[2] * y - f[2] * z,
  ]);
  const colour = (c: Vec3) => grey ? monochrome(c) : c;
  const lights = preset.lights.map(({ d, c }) => ({ d: place(d), c: colour(c) }));
  if (lights[0].d[1] < 0.22) {
    const [x, , z] = lights[0].d;
    lights[0].d = normalize([x, 0.22, z]); // the studio key stays above the floor with a low camera
  }
  const lobes = preset.lobes.map(({ d, c, width, strip }) => {
    const dir = place(d);
    const side = normalize(cross(preset.world ? [0, 1, 0] : u, dir));
    return { d: dir, c: colour(c), side, width: width * width, strip };
  });
  const radiance = { sky: colour(preset.sky), horizon: colour(preset.horizon), ground: colour(preset.ground) };
  return { lights, lobes, radiance };
}

type Bounds = [min: Vec3, max: Vec3];
type Clip = { axis: number; at: number; sign: number };
interface Casters {
  p: Float64Array;
  tris: Uint32Array;
  points: Int32Array;
  depth: Float32Array;
  material: PBRScene;
  clip?: Clip;
}
interface DepthMap {
  u: Vec3; v: Vec3; d: Vec3;
  origin: Vec3;
  step: number;
  x0: number; y0: number;
  w: number; h: number;
  z: Float32Array;
}

function depthMap(casters: Casters, bounds: Bounds, u: Vec3, v: Vec3, d: Vec3, step: number, pad: number, floorY?: number): DepthMap {
  const { p, tris, points, depth, material, clip } = casters;
  const [min, max] = bounds;
  const origin: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  // Project the box for the allocation. Keep a border of empty samples for the filters.
  const half = max.map((m, i) => (m - min[i]) / (2 * step));
  const rx = Math.ceil(Math.abs(u[0]) * half[0] + Math.abs(u[1]) * half[1] + Math.abs(u[2]) * half[2]) + pad;
  const ry = Math.ceil(Math.abs(v[0]) * half[0] + Math.abs(v[1]) * half[1] + Math.abs(v[2]) * half[2]) + pad;
  const w = 2 * rx + 1, h = 2 * ry + 1, x0 = rx, y0 = ry;
  const z = new Float32Array(w * h).fill(-Infinity);
  const projected = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = (p[i] - origin[0]) / step, y = (p[i + 1] - origin[1]) / step, z = (p[i + 2] - origin[2]) / step;
    projected[i] = x0 + x * u[0] + y * u[1] + z * u[2];
    projected[i + 1] = y0 + x * v[0] + y * v[1] + z * v[2];
    projected[i + 2] = x * d[0] + y * d[1] + z * d[2];
  }
  const uv0 = [0, 0], uv1 = [0, 0], uv2 = [0, 0];
  for (let i = 0; i < tris.length; i += 3) {
    const t = i / 3, alpha = material.triAlpha[t];
    if (alpha === ALPHA_BLEND) continue;
    const a = points[tris[i]] * 3, b = points[tris[i + 1]] * 3, c = points[tris[i + 2]] * 3;
    if (depth[a / 3] < 1e-4 || depth[b / 3] < 1e-4 || depth[c / 3] < 1e-4) continue;
    const ca = clip ? (p[a + clip.axis] - clip.at) * clip.sign : 0;
    const cb = clip ? (p[b + clip.axis] - clip.at) * clip.sign : 0;
    const cc = clip ? (p[c + clip.axis] - clip.at) * clip.sign : 0;
    if (ca > 0 && cb > 0 && cc > 0) continue;
    const clipped = ca > 0 || cb > 0 || cc > 0;
    const ya = p[a + 1], yb = p[b + 1], yc = p[c + 1];
    if (floorY !== undefined && Math.max(ya, yb, yc) < floorY) continue;
    const ax = projected[a], ay = projected[a + 1], bx = projected[b], by = projected[b + 1], cx = projected[c], cy = projected[c + 1];
    const inv = 1 / ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    if (!Number.isFinite(inv)) continue;
    const left = Math.ceil(Math.min(ax, bx, cx)), right = Math.floor(Math.max(ax, bx, cx));
    const top = Math.ceil(Math.min(ay, by, cy)), bottom = Math.floor(Math.max(ay, by, cy));
    if (left > right || top > bottom) continue;
    const za = projected[a + 2], zb = projected[b + 2], zc = projected[c + 2];
    const masked = alpha === ALPHA_MASK, cut = masked ? material.cutoff(t) : 0;
    if (masked && material.hasUV) {
      material.uvAt(t, 1, 0, 0, uv0); material.uvAt(t, 0, 1, 0, uv1); material.uvAt(t, 0, 0, 1, uv2);
    }
    const g0x = (by - cy) * inv, g0y = (cx - bx) * inv, g1x = (cy - ay) * inv, g1y = (ax - cx) * inv;
    const du0 = uv0[0] - uv2[0], du1 = uv1[0] - uv2[0], dv0 = uv0[1] - uv2[1], dv1 = uv1[1] - uv2[1];
    const dudx = g0x * du0 + g1x * du1, dvdx = g0x * dv0 + g1x * dv1;
    const dudy = g0y * du0 + g1y * du1, dvdy = g0y * dv0 + g1y * dv1;
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) * inv;
      const w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) * inv, w2 = 1 - w0 - w1;
      if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
      if (clipped && ca * w0 + cb * w1 + cc * w2 > 0) continue;
      if (floorY !== undefined && (ya - floorY) * w0 + (yb - floorY) * w1 + (yc - floorY) * w2 < 0) continue;
      const i = y * w + x, q = za * w0 + zb * w1 + zc * w2;
      if (q <= z[i]) continue;
      if (masked && material.maskAlpha(t, w0, w1, w2, dudx, dvdx, dudy, dvdy) < cut) continue;
      z[i] = q;
    }
  }
  return { u, v, d, origin, step, x0, y0, w, h, z };
}

/** Two box passes per axis form a separable tent. The map's empty border is wider than the filter. */
function blur(map: DepthMap, radius: number) {
  const { w, h, z } = map;
  if (radius < 1) return;
  const temp = new Float32Array(z.length), inv = 1 / (2 * radius + 1);
  const pass = (src: Float32Array, dst: Float32Array, len: number, lines: number, by: number, next: number) => {
    for (let j = 0; j < lines; j++) {
      const start = j * next;
      let sum = 0;
      for (let i = 0; i < radius; i++) sum += src[start + i * by];
      for (let i = 0; i < len; i++) {
        if (i + radius < len) sum += src[start + (i + radius) * by];
        if (i > radius) sum -= src[start + (i - radius - 1) * by];
        dst[start + i * by] = sum * inv;
      }
    }
  };
  pass(z, temp, w, h, 1, w); pass(temp, z, w, h, 1, w);
  pass(z, temp, h, w, w, 1); pass(temp, z, h, w, w, 1);
}

function floorSample(map: DepthMap) {
  const { u, v, origin, step, x0, y0, w, h, z } = map;
  const ux = u[0] / step, uz = u[2] / step, vx = v[0] / step, vz = v[2] / step;
  return (x: number, y: number, pz: number) => {
    x -= origin[0]; y -= origin[1]; pz -= origin[2];
    const a = x * ux + pz * uz + y * (u[1] / step) + x0, b = x * vx + pz * vz + y * (v[1] / step) + y0;
    if (a < 0 || a >= w - 1 || b < 0 || b >= h - 1) return 0;
    const i = Math.floor(a), j = Math.floor(b), fx = a - i, fy = b - j;
    const k = j * w + i;
    return (z[k] * (1 - fx) + z[k + 1] * fx) * (1 - fy) + (z[k + w] * (1 - fx) + z[k + w + 1] * fx) * fy;
  };
}

export function environmentShadow(preset: Environment, casters: Casters, bounds: Bounds, radius: number, height: number, key: Vec3, floorY?: number) {
  const extent = Math.max(radius, Math.hypot(...bounds[1].map((x, i) => x - bounds[0][i])) / 2);
  const step = extent / 568;
  const penumbra = radius * preset.penumbra / step;
  const u = normalize(cross([0, 1, 0], key)), v = cross(key, u);
  const map = depthMap(casters, bounds, u, v, key, step, Math.ceil(penumbra) + 3);
  const { w, h, z, origin, x0, y0 } = map;
  // A conservative block maximum skips PCF where the whole filter footprint is clear.
  const bw = Math.ceil(w / 16), blocks = new Float32Array(bw * Math.ceil(h / 16)).fill(-Infinity);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = (j >> 4) * bw + (i >> 4), q = z[j * w + i];
    if (q > blocks[k]) blocks[k] = q;
  }
  // Receiver-plane depth at each filter tap, using the geometric normal rather than the shading normal.
  const slope = (nx: number, ny: number, nz: number): [number, number] => {
    const n: Vec3 = [nx, ny, nz], nd = dot(n, key);
    return nd === 0 ? [0, 0] : [-dot(n, u) / nd, -dot(n, v) / nd];
  };
  // A narrower filter on geometry retains contact at small features. Fractional edge weights
  // slide the box continuously between texels, so moving a receiver does not jump between taps.
  const filter = Math.max(2, Math.min(5, Math.round(penumbra / 4)));
  const diameter = 2 * filter + 1, reach = filter + 1;
  const visibility = (x: number, y: number, pz: number, gx: number, gy: number) => {
    x = (x - origin[0]) / step; y = (y - origin[1]) / step; pz = (pz - origin[2]) / step;
    const a = x * u[0] + y * u[1] + pz * u[2] + x0, b = x * v[0] + y * v[1] + pz * v[2] + y0;
    if (a < reach || a >= w - 1 - reach || b < reach || b >= h - 1 - reach) return 1;
    const tilt = Math.abs(gx) + Math.abs(gy);
    // A texel of normal offset covers quantisation and the change of plane between nearby smooth facets.
    const q = x * key[0] + y * key[1] + pz * key[2] + 0.25 + 0.85 * (1 + tilt);
    const lo = q - (reach + 1) * tilt;
    const left = Math.floor(a) - filter, top = Math.floor(b) - filter;
    const right = left + diameter, bottom = top + diameter;
    const i0 = left >> 4, i1 = right >> 4, j0 = top >> 4, j1 = bottom >> 4;
    let high = -Infinity;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) high = Math.max(high, blocks[j * bw + i]);
    if (high <= lo) return 1;
    let blocked = 0;
    const fx = a - (left + filter), fy = b - (top + filter);
    for (let j = top; j <= bottom; j++) {
      const start = j * w, depth = q + (j - b) * gy + (left - a) * gx;
      let count = z[start + left] > depth ? 1 - fx : 0;
      let d = depth + gx;
      for (let i = left + 1; i < right; i++, d += gx) if (z[start + i] > d) count++;
      if (z[start + right] > d) count += fx;
      blocked += count * (j === top ? 1 - fy : j === bottom ? fy : 1);
    }
    return 1 - blocked / (diameter * diameter);
  };
  let cast: ReturnType<typeof floorSample> | undefined, contact: ReturnType<typeof floorSample> | undefined;
  if (floorY !== undefined) {
    const ground = { ...map, z: new Float32Array(z.length) };
    const fy = (floorY - origin[1]) / step;
    // Every texel of this light-space image has a known floor depth. Filter the comparisons once for the
    // entire plane, then bilinearly sample them at camera pixels. A coplanar triangle has zero coverage.
    const plane = slope(0, 1, 0), base = fy / key[1] + 0.015;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = j * w + i;
      ground.z[k] = z[k] > base + (i - x0) * plane[0] + (j - y0) * plane[1] ? 1 : 0;
    }
    blur(ground, Math.max(1, Math.round(penumbra / 2)));
    cast = floorSample(ground);
    const contactStep = extent / 260, contactWidth = Math.max(0.006 * radius, Math.min(0.032 * radius, height * 0.085));
    const filter = Math.max(1, Math.round(contactWidth / (2 * contactStep)));
    const near = depthMap(casters, bounds, [1, 0, 0], [0, 0, 1], [0, -1, 0], contactStep, 2 * filter + 3, floorY);
    const falloff = Math.max(height * 0.10, radius * 0.002);
    for (let i = 0; i < near.z.length; i++) {
      near.z[i] = 1 - smoothstep(0, falloff, near.origin[1] - floorY - near.z[i] * contactStep);
    }
    blur(near, filter);
    contact = floorSample(near);
  }
  return { visibility, slope, cast, contact };
}

interface FloorCamera { eye: Vec3; f: Vec3; r: Vec3; u: Vec3; ox: number; oy: number; focal: number }

// Keep the dither at output pixel resolution so supersampling does not average it away.
const backdropDither = (x: number, y: number, ss: number) =>
  (((Math.imul((x / ss) | 0, 1973) + Math.imul((y / ss) | 0, 9277)) & 255) / 256 - 0.5) / 255;

function drawDaylight(
  col: Float32Array, w: number, h: number, ss: number, cam: FloorCamera, preset: Environment,
  backdrop: Extract<Backdrop, { kind: 'daylight' }>, grey: boolean, floorY: number | undefined,
  radius: number, shadow?: ReturnType<typeof environmentShadow>,
) {
  const { eye, f, r, u, ox, oy, focal } = cam;
  const sky = grey ? monochrome(backdrop.top) : backdrop.top, haze = grey ? monochrome(backdrop.haze) : backdrop.haze;
  const floor = grey ? monochrome(backdrop.floor) : backdrop.floor;
  const cast = shadow?.cast, contact = shadow?.contact, hazeScale = radius * backdrop.hazeDistance;
  // The perspective camera has a level right vector. Each row shares the same vertical ray component
  // and the same distance along the floor in the camera's forward direction.
  for (let y = 0; y < h; y++) {
    const v = (oy - y - 0.5) / focal, sy = 2 * (y + 0.5) / h - 1;
    const fx = f[0] + v * u[0], fy = f[1] + v * u[1], fz = f[2] + v * u[2];
    const t = floorY !== undefined && fy < 0 ? (floorY - eye[1]) / fy : 0;
    const distance = t * Math.hypot(fx, fz) / hazeScale;
    const groundMix = t > 0 ? 1 / (1 + distance * distance) : 0;
    for (let x = 0; x < w; x++) {
      const s = (x + 0.5 - ox) / focal, sx = 2 * (x + 0.5) / w - 1;
      const shade = backdrop.vignette * (sx * sx + sy * sy * 0.35);
      const dither = backdropDither(x, y, ss);
      let red = haze[0], green = haze[1], blue = haze[2];
      if (fy > 0) {
        const mix = smoothstep(0, backdrop.skyRise, fy / Math.sqrt(1 + v * v + s * s));
        red += (sky[0] - red) * mix;
        green += (sky[1] - green) * mix;
        blue += (sky[2] - blue) * mix;
      } else if (groundMix > 0) {
        const px = eye[0] + t * (fx + s * r[0]), pz = eye[2] + t * (fz + s * r[2]);
        const k = (1 - preset.cast * (cast?.(px, floorY!, pz) ?? 0)) * (1 - preset.contact * (contact?.(px, floorY!, pz) ?? 0));
        red += (floor[0] * k - red) * groundMix;
        green += (floor[1] * k - green) * groundMix;
        blue += (floor[2] * k - blue) * groundMix;
      }
      const i = (y * w + x) * 3;
      col[i] = red - shade + dither; col[i + 1] = green - shade + dither; col[i + 2] = blue - shade + dither;
    }
  }
}

export function drawEnvironment(
  col: Float32Array, w: number, h: number, ss: number, cam: FloorCamera, preset: Environment, grey: boolean,
  floorY: number | undefined, centre: Vec3, radius: number, shadow?: ReturnType<typeof environmentShadow>,
) {
  const backdrop = preset.backdrop;
  if (backdrop.kind === 'daylight') {
    drawDaylight(col, w, h, ss, cam, preset, backdrop, grey, floorY, radius, shadow);
    return;
  }
  const { eye, f, r, u, ox, oy, focal } = cam;
  const top = grey ? monochrome(backdrop.top) : backdrop.top, bottom = grey ? monochrome(backdrop.bottom) : backdrop.bottom;
  const floor = grey ? monochrome(backdrop.floor) : backdrop.floor;
  const span = 1 / (radius * radius), fade = 1 / (backdrop.fade * backdrop.fade);
  const cast = shadow?.cast, contact = shadow?.contact;
  for (let y = 0; y < h; y++) {
    const v = (oy - y - 0.5) / focal, sy = 2 * (y + 0.5) / h - 1, sy2 = sy * sy;
    const grad = smoothstep(0, 1, (y + 0.5) / h);
    const br = top[0] + (bottom[0] - top[0]) * grad, bg = top[1] + (bottom[1] - top[1]) * grad, bb = top[2] + (bottom[2] - top[2]) * grad;
    const fx = f[0] + v * u[0], fy = f[1] + v * u[1], fz = f[2] + v * u[2];
    for (let x = 0; x < w; x++) {
      const sx = 2 * (x + 0.5) / w - 1;
      const shade = backdrop.vignette * (sx * sx + sy2 * 0.35);
      let red = br - shade, green = bg - shade, blue = bb - shade;
      if (floorY !== undefined) {
        const s = (x + 0.5 - ox) / focal, dy = fy + s * r[1];
        if (dy < 0) {
          const t = (floorY - eye[1]) / dy;
          const px = eye[0] + t * (fx + s * r[0]), pz = eye[2] + t * (fz + s * r[2]);
          const dx = px - centre[0], dz = pz - centre[2], d2 = (dx * dx + dz * dz) * span;
          const mix = 1 - smoothstep(0, 1, d2 * fade);
          if (mix > 0) {
            const k = (1 - preset.cast * (cast?.(px, floorY, pz) ?? 0)) * (1 - preset.contact * (contact?.(px, floorY, pz) ?? 0));
            const pool = backdrop.pool / (1 + d2 * 0.87);
            red += ((floor[0] + pool) * k - red) * mix;
            green += ((floor[1] + pool) * k - green) * mix;
            blue += ((floor[2] + pool) * k - blue) * mix;
          }
        }
      }
      const dither = backdropDither(x, y, ss);
      const i = (y * w + x) * 3;
      col[i] = red + dither; col[i + 1] = green + dither; col[i + 2] = blue + dither;
    }
  }
}
