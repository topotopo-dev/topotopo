// MikkTSpace tangents: the tangent basis that normal-map bakers, glTF (TANGENT), Blender, Unreal and Unity agree on.
//
// The generator is the WebAssembly build three.js ships as examples/jsm/libs/mikktspace.module.js (mikktspace-wasm by
// Don McCurdy, a build of the gltf-rs `mikktspace` crate, itself a port of Morten S. Mikkelsen's reference code; see
// NOTICE). It embeds its WASM as a data: URI and instantiates it with fetch + WebAssembly, which Node and browsers both
// have, so this module stays host-independent. Loading is asynchronous: call loadMikkTSpace() (async paths: exporters,
// renderPBR, the bake_normal cook) before the synchronous functions below.
//
// Input is a triangle soup, three corners per triangle, as the renderer and exporter triangulate polygons
// (topology.triangulate). Tangents are computed per corner BEFORE any welding: MikkTSpace itself shares a tangent
// between corners only where position, normal and uv all agree, so uv seams, hard normals and mirrored uv islands keep
// their own frames. uvs are in TopoTopo's convention (core/texcoord.ts); the w (handedness) it returns is glTF's.
//
// Never invalid: corners whose uvs are missing, non-finite or collapsed (zero uv area), and any corner MikkTSpace
// cannot resolve, get a unit fallback tangent perpendicular to the normal with w = +1, and are counted in the
// diagnostics so callers can report them instead of exporting silent garbage.
import type { Geometry } from './geometry.ts';

interface MikkModule { generateTangents(position: Float32Array, normal: Float32Array, texcoord: Float32Array): Float32Array; ready: PromiseLike<void> }

let mod: MikkModule | null = null;
let loading: Promise<MikkModule> | null = null;

/** Load (once) and initialise the MikkTSpace WebAssembly module. */
export async function loadMikkTSpace(): Promise<void> {
  if (mod) return;
  if (!loading) {
    loading = (async () => {
      const spec = 'three/examples/jsm/libs/mikktspace.module.js';
      const m: any = await import(spec);
      await m.ready;
      return m as MikkModule;
    })();
    loading.catch(() => { loading = null; });
  }
  mod = await loading;
}

/** True once loadMikkTSpace() has finished. */
export const mikkTSpaceReady = () => mod !== null;

/** uv triangles whose doubled area is below this fraction of their squared edge lengths are collapsed. */
const UV_DEGENERATE = 1e-9;

export interface TangentDiagnostics {
  triangles: number;
  /** triangles with a non-finite uv corner */
  uvNonFinite: number;
  /** triangles whose uvs are collinear or coincide (zero uv area) */
  uvDegenerate: number;
  /** corners that received the fallback tangent */
  fallbackCorners: number;
  /** the first triangle with a non-finite or collapsed uv, or -1 (warnings say where it is) */
  firstBad: number;
}

/**
 * MikkTSpace tangents for a triangle soup: pos and nrm 9 floats per triangle, uv 6 (TopoTopo convention). Returns 12
 * floats per triangle: xyz unit tangent and w = ±1 (bitangent = w · cross(N, T)). Throws when the module is not
 * loaded.
 */
export function mikkTangents(pos: ArrayLike<number>, nrm: ArrayLike<number>, uv: ArrayLike<number>): { tangents: Float32Array; diag: TangentDiagnostics } {
  if (!mod) throw new Error('MikkTSpace is not loaded: await loadMikkTSpace() first (exportGLB, renderPBR and bake_normal do)');
  const nt = Math.floor(pos.length / 9);
  const diag: TangentDiagnostics = { triangles: nt, uvNonFinite: 0, uvDegenerate: 0, fallbackCorners: 0, firstBad: -1 };
  const bad = new Uint8Array(nt);
  const P = Float32Array.from(pos), N = Float32Array.from(nrm), T = Float32Array.from(uv);
  for (let t = 0; t < nt; t++) {
    let finite = true;
    for (let k = 0; k < 6; k++) if (!Number.isFinite(T[t * 6 + k])) { finite = false; T[t * 6 + k] = 0; }
    if (!finite) { diag.uvNonFinite++; bad[t] = 1; if (diag.firstBad < 0) diag.firstBad = t; continue; }
    const u0 = T[t * 6], v0 = T[t * 6 + 1], du1 = T[t * 6 + 2] - u0, dv1 = T[t * 6 + 3] - v0, du2 = T[t * 6 + 4] - u0, dv2 = T[t * 6 + 5] - v0;
    const e2 = du1 * du1 + dv1 * dv1 + du2 * du2 + dv2 * dv2 + (du2 - du1) ** 2 + (dv2 - dv1) ** 2;
    if (!(Math.abs(du1 * dv2 - du2 * dv1) > UV_DEGENERATE * e2)) { diag.uvDegenerate++; bad[t] = 1; if (diag.firstBad < 0) diag.firstBad = t; }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]);
    if (l > 0 && Number.isFinite(l)) { N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; } else { N[i] = 0; N[i + 1] = 0; N[i + 2] = 1; }
  }
  const out = nt ? mod.generateTangents(P, N, T) : new Float32Array(0);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const c = t * 3 + k, o = c * 4, n = c * 3;
    let x = out[o], y = out[o + 1], z = out[o + 2];
    const nx = N[n], ny = N[n + 1], nz = N[n + 2];
    // keep it exactly perpendicular to the (normalised, float) normal the consumer will see
    const d = x * nx + y * ny + z * nz;
    x -= nx * d; y -= ny * d; z -= nz * d;
    const l = Math.hypot(x, y, z), w = out[o + 3];
    if (!bad[t] && l > 1e-6 && Number.isFinite(l) && (w === 1 || w === -1)) { out[o] = x / l; out[o + 1] = y / l; out[o + 2] = z / l; continue; }
    diag.fallbackCorners++;
    // the world axis least aligned with N, made perpendicular to it
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const a = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    const e = a[0] * nx + a[1] * ny + a[2] * nz;
    const fx = a[0] - nx * e, fy = a[1] - ny * e, fz = a[2] - nz * e, fl = Math.hypot(fx, fy, fz);
    out[o] = fx / fl; out[o + 1] = fy / fl; out[o + 2] = fz / fl; out[o + 3] = 1;
  }
  return { tangents: out, diag };
}

/**
 * MikkTSpace tangents for the triangles `tris` (vertex indices, as topology.triangulate returns them) of g, with the
 * per-vertex normals N (3 per vertex, e.g. resolveVertexNormals) and per-vertex uv (2 per vertex, TopoTopo
 * convention). 12 floats per triangle, in g's space.
 */
export function cornerTangents(g: Geometry, tris: ArrayLike<number>, N: ArrayLike<number>, uv: ArrayLike<number>): { tangents: Float32Array; diag: TangentDiagnostics } {
  const nc = tris.length, P = g.P, vp = g.vertexPoint;
  const pos = new Float32Array(nc * 3), nrm = new Float32Array(nc * 3), tex = new Float32Array(nc * 2);
  for (let c = 0; c < nc; c++) {
    const v = tris[c], p = vp[v] * 3;
    pos[c * 3] = P[p]; pos[c * 3 + 1] = P[p + 1]; pos[c * 3 + 2] = P[p + 2];
    nrm[c * 3] = N[v * 3]; nrm[c * 3 + 1] = N[v * 3 + 1]; nrm[c * 3 + 2] = N[v * 3 + 2];
    tex[c * 2] = uv[v * 2]; tex[c * 2 + 1] = uv[v * 2 + 1];
  }
  return mikkTangents(pos, nrm, tex);
}

/** Per-vertex uv (2 per vertex) of a vertex or point attribute, or null when g has no such float attribute. */
export function vertexUV(g: Geometry, name = 'uv'): Float64Array | null {
  const f = g.findAttrib(name, ['vertex', 'point']);
  if (!f || f.attr.type !== 'float' || f.attr.isArray) return null;
  const a = f.attr, d = a.data as Float64Array, s = a.size;
  const out = new Float64Array(g.numVertices * 2);
  for (let v = 0; v < g.numVertices; v++) {
    const i = (f.cls === 'vertex' ? v : g.vertexPoint[v]) * s;
    out[v * 2] = d[i];
    out[v * 2 + 1] = s > 1 ? d[i + 1] : 0;
  }
  return out;
}

/**
 * The orthonormal shading frame at a surface sample, as bake_normal writes and the PBR preview reads it: N normalised,
 * T = the interpolated tangent made perpendicular to N and normalised, B = w · cross(N, T) with w the sign of the
 * interpolated handedness. Fills out[0..8] with T, B, N; returns false (out untouched) when T is parallel to N.
 */
export function shadingFrame(nx: number, ny: number, nz: number, tx: number, ty: number, tz: number, w: number, out: number[] | Float64Array): boolean {
  const nl = Math.hypot(nx, ny, nz);
  if (!(nl > 0)) return false;
  nx /= nl; ny /= nl; nz /= nl;
  const d = tx * nx + ty * ny + tz * nz;
  tx -= nx * d; ty -= ny * d; tz -= nz * d;
  const tl = Math.hypot(tx, ty, tz);
  if (!(tl > 1e-12)) return false;
  tx /= tl; ty /= tl; tz /= tl;
  const sg = w < 0 ? -1 : 1;
  out[0] = tx; out[1] = ty; out[2] = tz;
  out[3] = (ny * tz - nz * ty) * sg; out[4] = (nz * tx - nx * tz) * sg; out[5] = (nx * ty - ny * tx) * sg;
  out[6] = nx; out[7] = ny; out[8] = nz;
  return true;
}

/** The standard tangent attribute: float, 4 components (xyz unit tangent, w = ±1 handedness), point or vertex class. */
export const TANGENT_ATTRIB = 'tangent';

/**
 * Check a supplied tangent attribute: every element finite, |xyz| within 1e-3 of 1, w exactly ±1. Returns null when
 * valid, else a description of the first problem (element class, index and value).
 */
export function tangentProblem(g: Geometry): string | null {
  const f = g.findAttrib(TANGENT_ATTRIB, ['vertex', 'point']);
  if (!f) return null;
  const a = f.attr;
  if (a.type !== 'float' || a.isArray || a.size !== 4) return `"${TANGENT_ATTRIB}" is ${a.isArray ? 'an array' : `${a.type}[${a.size}]`}, not float[4]`;
  const d = a.data as Float64Array, n = f.cls === 'vertex' ? g.numVertices : g.numPoints;
  for (let i = 0; i < n; i++) {
    const x = d[i * 4], y = d[i * 4 + 1], z = d[i * 4 + 2], w = d[i * 4 + 3];
    const l = Math.hypot(x, y, z);
    if (!Number.isFinite(l) || Math.abs(l - 1) > 1e-3 || (w !== 1 && w !== -1)) return `${f.cls} ${i} has tangent (${[x, y, z, w].map((q) => +q.toPrecision(4)).join(', ')}): xyz must be unit length and w ±1`;
  }
  return null;
}

/**
 * Transform tangent vectors in place by the 3×3 linear part L (column-major, 9 numbers): xyz → normalize(L · xyz),
 * w → w · sign(det L) (a mirror flips the bitangent relative to cross(N, T)). sel limits the elements.
 */
export function transformTangents(d: Float64Array, count: number, L: ArrayLike<number>, sel?: (i: number) => boolean): void {
  const det = L[0] * (L[4] * L[8] - L[7] * L[5]) - L[3] * (L[1] * L[8] - L[7] * L[2]) + L[6] * (L[1] * L[5] - L[4] * L[2]);
  const s = det < 0 ? -1 : 1;
  for (let i = 0; i < count; i++) {
    if (sel && !sel(i)) continue;
    const x = d[i * 4], y = d[i * 4 + 1], z = d[i * 4 + 2];
    const tx = L[0] * x + L[3] * y + L[6] * z, ty = L[1] * x + L[4] * y + L[7] * z, tz = L[2] * x + L[5] * y + L[8] * z;
    const l = Math.hypot(tx, ty, tz) || 1;
    d[i * 4] = tx / l; d[i * 4 + 1] = ty / l; d[i * 4 + 2] = tz / l; d[i * 4 + 3] *= s;
  }
}
