// Small, allocation-light linear algebra used across the engine.
// Conventions: right-handed, Y-up, angles in degrees at API boundaries,
// matrices are column-major Float64Array(16) (same layout as three.js / glTF).

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w
export type Mat4 = Float64Array;

export const DEG = Math.PI / 180;

/**
 * Math.hypot(x, y, z) without its per-call allocation, for hot loops. It does V8's operations in V8's order (the
 * magnitudes scaled by the largest, squares Kahan-summed, sqrt times the largest; Infinity before NaN, 0 when all are
 * 0), so the result is Math.hypot's bit for bit there (test/property.ts checks this on the running engine).
 */
export function hypot3(x: number, y: number, z: number): number {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax === Infinity || ay === Infinity || az === Infinity) return Infinity;
  if (ax !== ax || ay !== ay || az !== az) return NaN;
  let m = 0;
  if (ax > m) m = ax;
  if (ay > m) m = ay;
  if (az > m) m = az;
  if (m === 0) return 0;
  const n0 = ax / m, n1 = ay / m, n2 = az / m;
  // Kahan: the first step leaves no compensation; the third one's is not needed
  const s0 = n0 * n0, s1 = n1 * n1, t = s0 + s1;
  const c = (t - s0) - s1;
  return Math.sqrt(t + (n2 * n2 - c)) * m;
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-20 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const fit = (x: number, a: number, b: number, c: number, d: number) =>
  b === a ? c : c + ((clamp(x, Math.min(a, b), Math.max(a, b)) - a) / (b - a)) * (d - c);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Any unit vector perpendicular to n. */
export function perpendicular(n: Vec3): Vec3 {
  const a: Vec3 = Math.abs(n[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  return normalize(cross(a, n));
}

// ---------------------------------------------------------------- Mat4

export function m4identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** out = a * b (apply b first, then a). */
export function m4mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

export function m4translate(x: number, y: number, z: number): Mat4 {
  const m = m4identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

export function m4scale(x: number, y: number, z: number): Mat4 {
  const m = m4identity();
  m[0] = x; m[5] = y; m[10] = z;
  return m;
}

export function m4rotX(deg: number): Mat4 {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG), m = m4identity();
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
  return m;
}
export function m4rotY(deg: number): Mat4 {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG), m = m4identity();
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
  return m;
}
export function m4rotZ(deg: number): Mat4 {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG), m = m4identity();
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
  return m;
}

/** Euler rotation in degrees. order names the application order, e.g. "xyz" = rotate X first. */
export function m4euler(r: Vec3, order = 'xyz'): Mat4 {
  let m = m4identity();
  for (const ax of order) {
    const rm = ax === 'x' ? m4rotX(r[0]) : ax === 'y' ? m4rotY(r[1]) : m4rotZ(r[2]);
    m = m4mul(rm, m);
  }
  return m;
}

/**
 * Houdini-style transform: T * R * S about a pivot.
 * xord: application order of scale/rotate/translate (default "srt").
 */
export function m4trs(
  t: Vec3, rDeg: Vec3, s: Vec3, pivot: Vec3 = [0, 0, 0], xord = 'srt', rord = 'xyz',
): Mat4 {
  const parts: Record<string, Mat4> = {
    s: m4scale(s[0], s[1], s[2]),
    r: m4euler(rDeg, rord),
    t: m4translate(t[0], t[1], t[2]),
  };
  let m = m4translate(-pivot[0], -pivot[1], -pivot[2]);
  for (const k of xord) m = m4mul(parts[k], m);
  return m4mul(m4translate(pivot[0], pivot[1], pivot[2]), m);
}

export function m4fromQuat(q: Quat): Mat4 {
  const [x, y, z, w] = q;
  const m = m4identity();
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y);
  return m;
}

export function m4apply(m: Mat4, x: number, y: number, z: number, out: number[] | Float64Array = [0, 0, 0], o = 0) {
  out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

export function m4applyDir(m: Mat4, x: number, y: number, z: number, out: number[] | Float64Array = [0, 0, 0], o = 0) {
  out[o] = m[0] * x + m[4] * y + m[8] * z;
  out[o + 1] = m[1] * x + m[5] * y + m[9] * z;
  out[o + 2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

export function m4invert(m: Mat4): Mat4 {
  const inv = new Float64Array(16);
  const a = m;
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (Math.abs(det) < 1e-30) return m4identity();
  det = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}

/** Inverse-transpose of the upper 3x3, as a Mat4, for transforming normals. */
export function m4normalMatrix(m: Mat4): Mat4 {
  const inv = m4invert(m);
  const n = m4identity();
  n[0] = inv[0]; n[1] = inv[4]; n[2] = inv[8];
  n[4] = inv[1]; n[5] = inv[5]; n[6] = inv[9];
  n[8] = inv[2]; n[9] = inv[6]; n[10] = inv[10];
  return n;
}

export function m4determinant3(m: Mat4): number {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

/** Build a matrix from basis vectors (columns) and origin. */
export function m4basis(x: Vec3, y: Vec3, z: Vec3, o: Vec3 = [0, 0, 0]): Mat4 {
  const m = m4identity();
  m[0] = x[0]; m[1] = x[1]; m[2] = x[2];
  m[4] = y[0]; m[5] = y[1]; m[6] = y[2];
  m[8] = z[0]; m[9] = z[1]; m[10] = z[2];
  m[12] = o[0]; m[13] = o[1]; m[14] = o[2];
  return m;
}

// ---------------------------------------------------------------- Quaternions

export function qAxisAngle(axis: Vec3, deg: number): Quat {
  const a = normalize(axis), h = (deg * DEG) / 2, s = Math.sin(h);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(h)];
}

export function qMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function qRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

export function qNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Quaternion from a rotation matrix (columns = basis). */
export function qFromMat(m: Mat4): Quat {
  const m00 = m[0], m01 = m[4], m02 = m[8], m10 = m[1], m11 = m[5], m12 = m[9], m20 = m[2], m21 = m[6], m22 = m[10];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  return qNormalize([x, y, z, w]);
}

/**
 * Houdini copy/instance convention: local +Z points along `dir` (N), local +Y toward `up`.
 * Returns the rotation as a matrix.
 */
export function lookAtBasis(dir: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
  const z = normalize(dir);
  if (length(z) === 0) return m4identity();
  let x = cross(up, z);
  if (length(x) < 1e-8) x = cross(Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], z);
  x = normalize(x);
  const y = cross(z, x);
  return m4basis(x, y, z);
}

/** Rotation taking unit vector a onto unit vector b. */
export function qFromTo(a: Vec3, b: Vec3): Quat {
  const na = normalize(a), nb = normalize(b);
  const d = dot(na, nb);
  if (d < -0.999999) {
    const ax = perpendicular(na);
    return [ax[0], ax[1], ax[2], 0];
  }
  const c = cross(na, nb);
  return qNormalize([c[0], c[1], c[2], 1 + d]);
}
