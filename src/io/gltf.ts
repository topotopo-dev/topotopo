// glTF 2.0 (GLB and .gltf) export and import through gltf-transform, in its platform-independent form:
// a Document plus a PlatformIO subclass whose file access goes through a caller-supplied reader (Host.readFile).
//
// Export layout
//   one node + mesh per prim "name" (splitByName), one primitive per material within a mesh:
//   polygons → TRIANGLES, polylines → one LINE_STRIP per curve (or LINES), isolated points → POINTS.
//   Scene empties (isolated points marked scene_empty, core/scene.ts; the scene_null node) → nodes without a mesh, under
//   their parent (the scene, another empty or a uniquely named mesh node), with the local TRS that reproduces their
//   geometry-space transform; other set point attributes → node extras. Missing, ambiguous or cyclic parents, and
//   parents that are GPU-instanced meshes, are errors.
//   POSITION · NORMAL (N, else computed) · TANGENT (see below) · TEXCOORD_0/1 from uv/uv2 (V flipped, core/texcoord.ts)
//   · COLOR_0 from Cd (+Alpha → VEC4).
//   TANGENT (option tangents, default 'auto'): MikkTSpace tangents (core/tangents.ts) computed per triangle corner from
//   the exported positions, normals and uv BEFORE vertices are welded, so uv seams, hard normals and mirrored islands
//   keep their own frames, for every primitive whose material has a normal map; a supplied point/vertex "tangent"
//   float[4] attribute is written on the others ('preserve': everywhere it exists). Collapsed or missing uvs are
//   reported, never written as invalid tangents.
//   Custom attributes (option custom, default off): every other numeric point/vertex attribute of size 1–4 becomes
//   `_NAME` (upper-cased; float, or the smallest integer type that holds an int attribute). The original names and
//   types are kept in mesh extras (topotopo.attributes), so imports restore them exactly. POINTS always carry pscale
//   as `_PSCALE`. Attributes only scene empties use (scene_empty, parent, orient, scale and their extras, at their
//   defaults on every mesh point) are never written as mesh channels.
//   Materials: the prim "material" attribute names a material of the detail table "materials" (core/materials.ts).
//   Colour space: TopoTopo colours (Cd, material base/emissive colours) are display values; glTF defines
//   baseColorFactor, emissiveFactor and COLOR_0 as linear, so they are converted on export and back on import.
//   A named material wins over Cd: a primitive whose prim "material" names a material of the table is written with
//   that material as it is, and its Cd / Alpha are not exported (option vertexColors writes them there too).
//   Elsewhere, and with vertexColors, vertex colours win: a primitive with Cd gets baseColorFactor white × COLOR_0,
//   the material supplies the PBR scalars; the original material is kept in material extras (topotopo.material) for
//   lossless re-import. A primitive whose Cd is one constant colour writes it as the baseColorFactor instead of
//   COLOR_0 (the same colour under glTF's factor × COLOR_0, and visible in engines whose default materials ignore
//   vertex colours, such as Unreal's Interchange); primitive extras (topotopo.Cd) restore it as point Cd on import.
//   Options: quantize (KHR_mesh_quantization), compress 'meshopt' (EXT_meshopt_compression, implies quantize),
//   compress 'draco' (KHR_draco_mesh_compression, only when the optional draco3dgltf package is installed).
//   Packed instances (instancing 'packed', the default): one mesh + node per packed source with EXT_mesh_gpu_instancing
//   (TRANSLATION / ROTATION / SCALE per instance; a 3×3 with shear is written as its nearest rotation and the
//   scale of its columns, with a warning); the rest of the geometry as above. instancing 'expand' writes real copies.
//   Per-instance attributes (custom, default off): the anchor point / packed prim attributes become extra instance
//   accessors with the extension's "_" prefix: Cd (+ Alpha) → _COLOR (VEC3/VEC4 float), every other numeric attribute
//   of size 1–4 → _NAME, single strings → _NAME indices into a table in the node's extras; all as 32-bit floats (exact
//   for integers below 2^24; 1- and 2-byte components break EXT_meshopt_compression's 4-byte instance strides); the
//   transform inputs (N, up, orient, rot, scale, trans, pivot) are folded into TRS and skipped.
//   Node extras (topotopo.instanceAttributes) keep names, classes, types and string tables for re-import.
//   Node and mesh names are packedSourceNames() (the source's prim "name", else source_<i>), as in the instance stream.
//   Textures: the material table's texture paths (base colour, normal, roughness) are read with options.readFile and
//   embedded (PNG / JPEG) as baseColorTexture, normalTexture and metallicRoughnessTexture (roughness = green channel);
//   a map replaces its factor (baseColorFactor white, roughnessFactor 1). Without readFile the maps are skipped.
//   "image:<name>" paths are image volumes of the geometry (texture nodes), encoded to PNG in memory; an "orm" map is
//   both the metallicRoughness and the occlusion texture (metallicFactor 1).
//   options.source (how the export was made, io/source.ts) → asset.extras.source.
//
// Import
//   node hierarchy flattened with world transforms (nodes without a mesh → scene empties: points with scene_empty 1,
//   name, parent = the nearest imported ancestor, P / orient / scale in world space, extras as attributes), EXT_mesh_gpu_instancing as packed prims (one source per mesh;
//   instancing 'expand' = real geometry), every primitive mode,
//   meshopt (meshoptimizer decoder) and Draco (when draco3dgltf is installed) decoded, external .bin files read
//   relative to the file. Mesh/node names → prim "name", materials → prim "material" + table, COLOR_0 → Cd/Alpha,
//   TEXCOORD_0/1 → uv/uv2, TANGENT → point "tangent" (float[4]; node transforms applied, w flipped under mirrors),
//   custom `_X` → attributes, instance `_X` accessors → anchor attributes. Texture images are
//   not decoded: their paths (URI resolved against the file, or "embedded:<name>" for images inside a GLB) go into the
//   material table's textures entries; files written by topotopo restore the original paths from material extras,
//   and their "image:<name>" textures are decoded back into image volumes (8-bit precision).
import { Document, GLB_BUFFER, MathUtils, PlatformIO, Primitive } from '@gltf-transform/core';
import type { Accessor, JSONDocument, Material as GMaterial, Node as GNode, Texture } from '@gltf-transform/core';
import {
  ALL_EXTENSIONS, EXTMeshGPUInstancing, EXTMeshoptCompression, KHRDracoMeshCompression, KHRMaterialsEmissiveStrength, KHRMaterialsUnlit, KHRMeshQuantization,
} from '@gltf-transform/extensions';
import type { EmissiveStrength, InstancedMesh } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { Attribute, AttribTable, Geometry, defaultValueFor } from '../core/geometry.ts';
import type { AttribClass, AttribType } from '../core/geometry.ts';
import { resolveVertexNormals, triangulate } from '../core/topology.ts';
import { TANGENT_ATTRIB, cornerTangents, loadMikkTSpace, tangentProblem, transformTangents, vertexUV } from '../core/tangents.ts';
import { gltfV } from '../core/texcoord.ts';
import { DEFAULT_MATERIAL, materialAlphaMode, mergeMaterialTables, normalizeMaterial, primMaterials, texturePaths, writeMaterials } from '../core/materials.ts';
import type { Material, MaterialTable, MaterialTextures } from '../core/materials.ts';
import { m4apply, m4applyDir, m4fromQuat, m4invert, m4mul, m4normalMatrix, m4scale, m4translate } from '../core/math.ts';
import { EMPTY_ATTRIB, PARENT_ATTRIB, sceneEmpties } from '../core/scene.ts';
import type { SceneEmpty } from '../core/scene.ts';
import type { Mat4 } from '../core/math.ts';
import { INSTANCE_ATTRIB_SKIP, anchorAttribs, anchorValue, baseOf, decomposeXform, isolatedMask, packedSourceNames, pieces, xf, xfDir, xfLinear } from './common.ts';
import type { AnchorAttrib, ExportOptions } from './common.ts';
import { DEFAULT_TRANSFER, expandPacked, flattenSource, packedFromMatrices, stripPacked, xform3 } from '../core/packed.ts';
import { hasSplinesDeep, splinesToPolylinesDeep } from '../core/splines.ts';
import { imageFromPNG, imageTextureData } from './textures.ts';
import { decodePNG } from './png-decode.ts';
import { imageRef } from '../core/image.ts';
import type { Image } from '../core/image.ts';

/** Above this many polylines per material and mesh, curves go into one LINES primitive instead of LINE_STRIPs. */
const MAX_LINE_STRIPS = 256;
/** Attributes with a dedicated glTF semantic (never exported as `_NAME`). */
const RESERVED = new Set(['P', 'N', 'uv', 'uv2', 'Cd', 'Alpha', 'material', 'name', TANGENT_ATTRIB]);
const TYPES = ['SCALAR', 'VEC2', 'VEC3', 'VEC4'] as const;
const DRACO_MODULE = 'draco3dgltf';

type TypedArray = Float32Array<ArrayBuffer> | Int8Array<ArrayBuffer> | Uint8Array<ArrayBuffer> | Int16Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;

// ------------------------------------------------------------------ IO

/**
 * PlatformIO whose reads go through `readFile` (e.g. Host.readFile). Paths are resolved against the directory of
 * the file being read; data: URIs are handled by gltf-transform.
 */
export class HostIO extends PlatformIO {
  private readFn: ((path: string) => Promise<Uint8Array>) | null;

  constructor(readFile?: (path: string) => Promise<Uint8Array>) {
    super();
    this.readFn = readFile ?? null;
  }

  protected async readURI(uri: string, type: 'view' | 'text'): Promise<any> {
    if (!this.readFn) throw new Error(`cannot read "${uri}": no file access here (use .glb or embedded data URIs)`);
    const bytes = await this.readFn(uri);
    return type === 'text' ? new TextDecoder().decode(bytes) : bytes;
  }

  protected resolve(base: string, path: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/') || !base) return path;
    return base.replace(/[\\/]+$/, '') + '/' + path;
  }

  protected dirname(uri: string): string {
    const i = Math.max(uri.lastIndexOf('/'), uri.lastIndexOf('\\'));
    return i >= 0 ? uri.slice(0, i) : '';
  }

  /** Load external buffers (relative to `base`) into jsonDoc.resources; external images get empty placeholders. */
  async loadExternal(jsonDoc: JSONDocument, base: string): Promise<void> {
    const json = jsonDoc.json;
    for (const b of json.buffers ?? []) {
      const uri = b.uri;
      if (!uri || uri.startsWith('data:') || uri in jsonDoc.resources) continue;
      jsonDoc.resources[uri] = await this.readURI(this.resolve(base, decodeURIComponent(uri)), 'view');
    }
    for (const im of json.images ?? []) {
      const uri = im.uri;
      if (!uri || uri.startsWith('data:') || uri in jsonDoc.resources) continue;
      jsonDoc.resources[uri] = new Uint8Array(0); // textures are not decoded: the importer records their paths
    }
  }
}

async function loadDraco(kind: 'encoder' | 'decoder'): Promise<any> {
  let mod: any;
  try {
    const spec = DRACO_MODULE; // variable specifier: optional dependency, resolved at run time only
    mod = await import(spec);
  } catch {
    throw new Error(`Draco ${kind === 'encoder' ? 'compression' : 'decoding'} needs the optional package "draco3dgltf" (npm install draco3dgltf); use compress "meshopt" instead`);
  }
  const m = mod.default ?? mod;
  return kind === 'encoder' ? await m.createEncoderModule() : await m.createDecoderModule();
}

// ------------------------------------------------------------------ export: corner streams

/** One vertex channel of a glTF primitive. read() fills `size` numbers for a corner (vertex v, point pt, prim pr). */
interface Channel {
  semantic: string;
  size: number;
  int: boolean;
  /** value depends only on the point (no need to split shared vertices) */
  perPoint: boolean;
  /** k: index of the corner in the emitted corner list (per-triangle-corner channels such as TANGENT) */
  read(v: number, pt: number, pr: number, out: number[], o: number, k: number): void;
}

interface PrimOut {
  mode: number;
  channels: Channel[];
  data: number[][];
  count: number;
  indices: number[] | null;
  material: GMaterial | null;
  /** a constant vertex colour moved into the material's base colour factor (kept in primitive extras for re-import) */
  foldedColor?: number[];
}

/** Reader for a numeric attribute with Houdini lookup precedence; elements without that class read the default. */
function attribChannel(g: Geometry, name: string, semantic: string, order: AttribClass[], map?: (src: number[], out: number[], o: number) => void, size?: number): Channel | null {
  const f = g.findAttrib(name, order);
  if (!f || (f.attr.type !== 'float' && f.attr.type !== 'int')) return null; // strings and array attributes have no glTF form
  const a = f.attr, s = a.size, d = a.data as Float64Array | Int32Array, cls = f.cls;
  const def = (Array.isArray(a.def) ? a.def : []) as number[];
  const tmp = new Array(s).fill(0);
  const outSize = size ?? s;
  return {
    semantic, size: outSize, int: a.type === 'int' && !map, perPoint: cls === 'point' || cls === 'detail',
    read(v, pt, pr, out, o) {
      const i = cls === 'vertex' ? v : cls === 'point' ? pt : cls === 'prim' ? pr : 0;
      if (i < 0) for (let c = 0; c < s; c++) tmp[c] = def[c] ?? 0;
      else for (let c = 0; c < s; c++) tmp[c] = d[i * s + c];
      if (map) map(tmp, out, o);
      else for (let c = 0; c < outSize; c++) out[o + c] = c < s ? tmp[c] : 0;
    },
  };
}

/** COLOR_0 from Cd and Alpha (VEC4 when Alpha exists). */
function colorChannel(g: Geometry): Channel | null {
  const order: AttribClass[] = ['vertex', 'point', 'prim', 'detail'];
  const cd = attribChannel(g, 'Cd', 'COLOR_0', order, (src, out, o) => {
    if (src.length >= 3) { out[o] = src[0]; out[o + 1] = src[1]; out[o + 2] = src[2]; } else { out[o] = out[o + 1] = out[o + 2] = src[0]; }
  }, 3);
  const al = attribChannel(g, 'Alpha', 'COLOR_0', order, (src, out, o) => { out[o] = src[0]; }, 1);
  if (!cd && !al) return null;
  const size = al ? 4 : 3;
  return {
    semantic: 'COLOR_0', size, int: false, perPoint: (!cd || cd.perPoint) && (!al || al.perPoint),
    read(v, pt, pr, out, o, k) {
      if (cd) cd.read(v, pt, pr, out, o, k); else { out[o] = out[o + 1] = out[o + 2] = 1; }
      if (al) al.read(v, pt, pr, out, o + 3, k);
    },
  };
}

interface CustomInfo { name: string; type: 'float' | 'int' }

/**
 * Custom `_NAME` channels for numeric point/vertex attributes of size 1–4 (vertex wins on a name clash, as in
 * Houdini lookups). `only` restricts the names.
 */
function customChannels(g: Geometry, used: Set<string>, info: Record<string, CustomInfo>, only?: string[]): Channel[] {
  const out: Channel[] = [];
  const names = new Set<string>();
  for (const t of [g.vertices, g.points]) for (const [n, a] of t.map) if (!RESERVED.has(n) && (a.type === 'float' || a.type === 'int') && a.size >= 1 && a.size <= 4 && (!only || only.includes(n))) names.add(n);
  for (const n of names) {
    const ch = attribChannel(g, n, '', ['vertex', 'point']);
    if (!ch || ch.size > 4) continue;
    const base = '_' + n.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    let sem = base, k = 1;
    while (used.has(sem)) sem = base + '_' + k++;
    used.add(sem);
    ch.semantic = sem;
    info[sem] = { name: n, type: ch.int ? 'int' : 'float' };
    out.push(ch);
  }
  return out;
}

/** Emit corners into per-channel arrays; with `weld`, corners with equal point and per-corner values share a vertex. */
function emit(channels: Channel[], corners: ArrayLike<number>, vprim: Int32Array | null, g: Geometry, weld: boolean) {
  const data = channels.map(() => [] as number[]);
  const tmp = channels.map((c) => new Array(c.size).fill(0));
  const keyed = channels.filter((c) => !c.perPoint);
  const map = new Map<string | number, number>();
  const idx: number[] = [];
  let count = 0;
  for (let k = 0; k < corners.length; k++) {
    const v = corners[k];
    const pt = v >= 0 ? g.vertexPoint[v] : -1 - v;
    const pr = v >= 0 && vprim ? vprim[v] : -1;
    channels.forEach((c, ci) => c.read(v >= 0 ? v : -1, pt, pr, tmp[ci], 0, k));
    let key: string | number = pt;
    if (weld && keyed.length) {
      let s = String(pt);
      for (const c of keyed) { const t = tmp[channels.indexOf(c)]; for (let i = 0; i < c.size; i++) s += ',' + Math.round(t[i] * 1e5); }
      key = s;
    }
    let id = weld ? map.get(key) : undefined;
    if (id === undefined) {
      id = count++;
      if (weld) map.set(key, id);
      channels.forEach((c, ci) => { const t = tmp[ci]; for (let i = 0; i < c.size; i++) data[ci].push(t[i]); });
    }
    idx.push(id);
  }
  return { data, count, idx };
}

// ------------------------------------------------------------------ export: materials

interface MatState {
  doc: Document;
  table: MaterialTable;
  cache: Map<string, GMaterial>;
  defaultMat: Material;
  /** texture bytes by path (exportGLB preloads them); undefined = no texture support in this call */
  data?: Map<string, Uint8Array | null>;
  textures: Map<string, Texture | null>;
  /** textures by byte length, for the byte-for-byte check that writes each distinct image once */
  byLength: Map<number, { bytes: Uint8Array; tex: Texture }[]>;
  uris: Set<string>;
  warn?: (msg: string) => void;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** Image MIME type from the first bytes (PNG or JPEG), or null. */
export function imageMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

/**
 * The glTF texture for an image path (created once per path, and once per distinct image: a path whose bytes equal an
 * earlier one's, e.g. each LOD's copy of a map, shares its texture), or null when its bytes are missing or not PNG/JPEG.
 */
function textureFor(st: MatState, path: string): Texture | null {
  if (!st.data) return null;
  let t = st.textures.get(path);
  if (t !== undefined) return t;
  t = null;
  const bytes = st.data.get(path);
  const mime = bytes ? imageMime(bytes) : null;
  if (bytes && !mime) st.warn?.(`glTF: texture "${path}" is not a PNG or JPEG image; material exported without it`);
  if (bytes && mime) {
    const same = st.byLength.get(bytes.length)?.find((c) => sameBytes(c.bytes, bytes));
    if (same) t = same.tex;
    else {
      const base = (path.startsWith('image:') ? path.slice(6) : baseOf(path).replace(/\.[^.]*$/, '')).replace(/[^A-Za-z0-9_-]+/g, '_') || 'texture';
      const ext = mime === 'image/png' ? '.png' : '.jpg';
      let uri = base + ext, k = 1;
      while (st.uris.has(uri)) uri = `${base}_${k++}${ext}`;
      st.uris.add(uri);
      t = st.doc.createTexture(base).setImage(bytes).setMimeType(mime).setURI(uri);
      const list = st.byLength.get(bytes.length);
      if (list) list.push({ bytes, tex: t }); else st.byLength.set(bytes.length, [{ bytes, tex: t }]);
    }
  }
  st.textures.set(path, t);
  return t;
}

function getMaterial(st: MatState, name: string, vertexColors: boolean, blend: boolean, tint?: number[]): GMaterial {
  const key = `${name}\u0000${vertexColors ? 1 : 0}${blend ? 1 : 0}${tint ? `\u0000${tint.join(',')}` : ''}`;
  let m = st.cache.get(key);
  if (m) return m;
  const isDefault = !name;
  const mat = isDefault ? st.defaultMat : st.table[name] ?? normalizeMaterial({});
  const tex = (slot: keyof MaterialTextures) => (mat.textures?.[slot] ? textureFor(st, mat.textures[slot]!) : null);
  const baseTex = tex('baseColor'), normalTex = tex('normal'), ormTex = tex('orm');
  // an ORM map (occlusion R, roughness G, metallic B) is glTF's own layout: it is both the metallicRoughness and the
  // occlusion texture, and replaces a separate roughness map
  const roughTex = ormTex ?? tex('roughness');
  if (ormTex && mat.textures?.roughness) st.warn?.(`glTF: material "${name}" has an orm and a roughness map; the orm map's green channel is used`);
  // a map replaces its factor: white base colour under a base colour map, roughness 1 under a roughness map,
  // metallic 1 under an ORM map
  // a folded constant vertex colour multiplies a base colour map exactly as COLOR_0 would have
  const rgb = tint ?? (vertexColors || baseTex ? [1, 1, 1] : mat.baseColor);
  m = st.doc.createMaterial(isDefault ? 'default' : name)
    .setBaseColorFactor([toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2]), mat.alpha]) // glTF factors are linear
    .setMetallicFactor(ormTex ? 1 : mat.metallic)
    .setRoughnessFactor(roughTex ? 1 : mat.roughness)
    .setDoubleSided(mat.doubleSided);
  if (baseTex) m.setBaseColorTexture(baseTex);
  if (normalTex) m.setNormalTexture(normalTex);
  if (roughTex) m.setMetallicRoughnessTexture(roughTex);
  if (ormTex) m.setOcclusionTexture(ormTex);
  const emax = Math.max(...mat.emissive);
  if (emax > 1) {
    m.setEmissiveFactor([toLinear(mat.emissive[0] / emax), toLinear(mat.emissive[1] / emax), toLinear(mat.emissive[2] / emax)]);
    const ext = st.doc.createExtension(KHRMaterialsEmissiveStrength);
    m.setExtension('KHR_materials_emissive_strength', ext.createEmissiveStrength().setEmissiveStrength(emax));
  } else m.setEmissiveFactor([toLinear(mat.emissive[0]), toLinear(mat.emissive[1]), toLinear(mat.emissive[2])]);
  m.setAlphaMode(materialAlphaMode(mat, blend));
  if (mat.alphaMode === 'MASK') m.setAlphaCutoff(mat.alphaCutoff ?? 0.5);
  if (mat.unlit) m.setExtension('KHR_materials_unlit', st.doc.createExtension(KHRMaterialsUnlit).createUnlit());
  m.setExtras({ topotopo: isDefault ? { default: true } : { material: mat } });
  st.cache.set(key, m);
  return m;
}

/** Display (sRGB-encoded) value to linear and back: glTF's factors and COLOR_0 are linear, TopoTopo colours are display
 *  values. */
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toDisplay = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** True when every element of a colour stream has the same rgb. */
const constantRGB = (d: number[], size: number) => {
  for (let i = size; i < d.length; i += size) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) return false;
  return true;
};

/** True when every rgb component of a colour stream is 1 (Houdini's default Cd). */
const rgbAllOnes = (d: number[], size: number) => {
  for (let i = 0; i < d.length; i++) if (i % size < 3 && d[i] !== 1) return false;
  return true;
};

// ------------------------------------------------------------------ export: document

/**
 * The empties' own point attributes are no mesh data: once the empties are split out (`g` holds only the other points,
 * a copy the caller owns), their marker, parent, orient, scale and extras hold nothing but the default fill a merge
 * gave the mesh points. Those are deleted so no mesh carries a channel for them; one a mesh point really sets stays.
 */
function dropEmptyAttributes(g: Geometry, empties: SceneEmpty[]): void {
  const names = new Set([EMPTY_ATTRIB, PARENT_ATTRIB, 'orient', 'scale']);
  for (const e of empties) for (const k of Object.keys(e.extras)) names.add(k);
  for (const n of names) {
    const a = g.points.get(n);
    if (!a) continue;
    if (n === EMPTY_ATTRIB || onlyDefaults(a)) g.points.delete(n);
  }
}

/** Every element of a fixed-size attribute holds its default (or, for numbers, all zeros: an unset fill). */
function onlyDefaults(a: Attribute): boolean {
  if (a.isArray) return false;
  if (a.type === 'string') { const d = a.def; return (a.data as string[]).every((s) => s === '' || s === d); }
  const d = a.def as number[], sz = a.size, data = a.data as Float64Array | Int32Array;
  for (let i = 0; i < data.length; i += sz) {
    let def = true, zero = true;
    for (let c = 0; c < sz; c++) { const x = data[i + c]; if (x !== (d[c] ?? 0)) def = false; if (x !== 0) zero = false; }
    if (!def && !zero) return false;
  }
  return true;
}

/** Build a gltf-transform Document for the geometry (no IO yet). */
export function gltfDocument(g: Geometry, o: ExportOptions = {}): Document {
  if (hasSplinesDeep(g)) g = splinesToPolylinesDeep(g).geo; // Bezier/NURBS prims (also in packed sources) as polylines
  // scene empties become nodes, not POINTS
  const empties = sceneEmpties(g);
  if (empties.length) {
    const keep = new Uint8Array(g.numPoints).fill(1);
    for (const e of empties) keep[e.point] = 0;
    g = g.subsetPoints(keep);
    dropEmptyAttributes(g, empties);
  }
  const doc = new Document();
  doc.getRoot().getAsset().generator = 'topotopo';
  // how the export was made (io/source.ts): the graph, its vars and seeds, the frame, the version
  if (o.source) doc.getRoot().getAsset().extras = { source: o.source };
  const buffer = doc.createBuffer();
  const scene = doc.createScene('scene');
  doc.getRoot().setDefaultScene(scene);
  const quantize = !!o.quantize || o.compress === 'meshopt';
  const useMaterials = o.materials !== false;
  const st: MatState = {
    doc, table: useMaterials ? mergeMaterialTables([g, ...g.packedSources]) : {}, cache: new Map(), defaultMat: DEFAULT_MATERIAL as Material,
    data: o.textureData, textures: new Map(), byLength: new Map(), uris: new Set(), warn: o.warn,
  };
  let noUV = 0;
  const custom = o.custom === true;
  const tangentMode = o.tangents ?? 'auto';
  const lineMode = o.lineMode ?? 'strip';
  // what to write: the geometry, or (packed) its non-instanced part plus one instanced mesh per packed source
  const split = o.splitByName ?? true;
  const jobs: MeshJob[] = [];
  if (!g.hasPacked()) jobs.push({ src: g, split });
  else if (o.instancing === 'expand') jobs.push({ src: expandPacked(g, { transfer: DEFAULT_TRANSFER }).geo, split });
  else jobs.push({ src: stripPacked(g), split }, ...instanceJobs(doc, buffer, g, o, quantize));

  for (const job of jobs) for (const { name, geo } of pieces(job.src, { ...o, splitByName: job.split })) {
    const outs: PrimOut[] = [];
    const info: Record<string, CustomInfo> = {};
    const used = new Set<string>();
    const mats = useMaterials ? primMaterials(geo) : null;
    const vprim = geo.vertexPrims();
    const posCh: Channel = {
      semantic: 'POSITION', size: 3, int: false, perPoint: true,
      read(_v, pt, _pr, out, oo) { const P = geo.P; const p = xf(P[pt * 3], P[pt * 3 + 1], P[pt * 3 + 2], o); out[oo] = p[0]; out[oo + 1] = p[1]; out[oo + 2] = p[2]; },
    };
    const uvCh = (n: string, sem: string) => attribChannel(geo, n, sem, ['vertex', 'point', 'prim', 'detail'], (s, out, oo) => { out[oo] = s[0]; out[oo + 1] = gltfV(s[1] ?? 0); }, 2);
    const color = colorChannel(geo);
    const customs = custom ? customChannels(geo, used, info) : [];
    // group prims by (closed, material)
    const groups = new Map<string, { closed: boolean; mat: string; mask: Uint8Array }>();
    for (let p = 0; p < geo.numPrims; p++) {
      const closed = !!geo.primClosed[p], mat = mats ? mats[p] : '';
      const key = (closed ? 'c' : 'o') + '\u0000' + mat;
      let gr = groups.get(key);
      if (!gr) { gr = { closed, mat, mask: new Uint8Array(geo.numPrims) }; groups.set(key, gr); }
      gr.mask[p] = 1;
    }
    const hasN = !!(geo.vertices.get('N') ?? geo.points.get('N'));
    let normals: Float64Array | null = null;
    // a named material decides the colour of its primitives: their Cd / Alpha are written only with vertexColors
    const colorFor = (mat: string): Channel | null => (color && (o.vertexColors === true || !(mat && st.table[mat])) ? color : null);
    const finishColor = (out: PrimOut, mat: string) => {
      // vertex colours win where they are set; all-white Cd lets the material colour through
      const ci = color ? out.channels.indexOf(color) : -1;
      let vc = false, blend = false, tint: number[] | undefined;
      if (ci >= 0) {
        const ch = out.channels[ci], d = out.data[ci];
        const rgbSet = !!geo.findAttrib('Cd') && !rgbAllOnes(d, ch.size);
        blend = ch.size === 4 && d.some((x, i) => i % 4 === 3 && x < 1);
        vc = rgbSet;
        // one colour over the whole primitive: the factor carries it (identical under glTF's factor × COLOR_0), so
        // engines that ignore vertex colours in their default materials (Unreal Interchange) still show it
        if (rgbSet && !blend && d.length >= ch.size && constantRGB(d, ch.size)) {
          tint = [d[0], d[1], d[2]].map((x) => Math.max(0, Math.min(1, x)));
          out.foldedColor = tint;
          vc = false;
        } else if (rgbSet && o.materialColorWins && mat && st.table[mat]) vc = false; // keeps COLOR_0, factor = material colour
        if ((!rgbSet || tint) && !blend) { out.channels.splice(ci, 1); out.data.splice(ci, 1); }
      }
      out.material = getMaterial(st, mat, vc, blend, tint);
      if (out.material.getBaseColorTexture() || out.material.getNormalTexture() || out.material.getMetallicRoughnessTexture()) {
        if (!out.channels.some((c) => c.semantic === 'TEXCOORD_0')) noUV++;
      }
    };
    /**
     * TANGENT of one triangle primitive (option tangents): the supplied tangent attribute where the mode takes it
     * (validated), else MikkTSpace per corner for a normal-mapped material, else none.
     */
    const tangentChannel = (tris: Uint32Array, nrm: Float64Array | null, mat: string, piece: string): Channel | null => {
      if (tangentMode === 'none') return null;
      const m = mat ? st.table[mat] : undefined;
      const normalMapped = !!(m?.textures?.normal && textureFor(st, m.textures.normal));
      const supplied = geo.findAttrib(TANGENT_ATTRIB, ['vertex', 'point']);
      const where = `mesh "${piece}"${mat ? ` material "${mat}"` : ''}`;
      if (supplied && (tangentMode === 'preserve' || !normalMapped)) {
        const bad = tangentProblem(geo);
        if (bad && tangentMode === 'preserve') throw new Error(`glTF: tangents "preserve": ${where}: ${bad}`);
        if (bad) o.warn?.(`glTF: ${where}: supplied tangent attribute not written (${bad})`);
        else if (!nrm) o.warn?.(`glTF: ${where}: tangent attribute without NORMAL (normals: false): no TANGENT written`);
        else {
          const L = xfLinear([1, 0, 0, 0, 1, 0, 0, 0, 1], 0, o), tmp = new Float64Array(4);
          return attribChannel(geo, TANGENT_ATTRIB, 'TANGENT', ['vertex', 'point'], (s, out, oo) => {
            tmp[0] = s[0]; tmp[1] = s[1]; tmp[2] = s[2]; tmp[3] = s[3];
            transformTangents(tmp, 1, L);
            out[oo] = tmp[0]; out[oo + 1] = tmp[1]; out[oo + 2] = tmp[2]; out[oo + 3] = tmp[3];
          }, 4);
        }
      }
      if (!normalMapped) return null;
      if (!nrm) { o.warn?.(`glTF: ${where}: normal map without NORMAL (normals: false): no TANGENT written`); return null; }
      const uv = vertexUV(geo, 'uv');
      if (!uv) return null; // reported once, as a textured primitive without uv
      const { tangents, diag } = cornerTangents(geo, tris, nrm, uv);
      if (diag.uvNonFinite || diag.uvDegenerate) {
        o.warn?.(`glTF: ${where}: ${diag.uvDegenerate} of ${diag.triangles} triangles have collapsed uvs${diag.uvNonFinite ? ` and ${diag.uvNonFinite} non-finite uvs` : ''}; their ${diag.fallbackCorners} corners get a fallback tangent (the normal map has no orientation there)`);
      } else if (diag.fallbackCorners) o.warn?.(`glTF: ${where}: MikkTSpace left ${diag.fallbackCorners} corners without a tangent; a fallback was written`);
      return {
        semantic: 'TANGENT', size: 4, int: false, perPoint: false,
        read(_v, _pt, _pr, out, oo, k) { const d = xfDir(tangents[k * 4], tangents[k * 4 + 1], tangents[k * 4 + 2], o); out[oo] = d[0]; out[oo + 1] = d[1]; out[oo + 2] = d[2]; out[oo + 3] = tangents[k * 4 + 3]; },
      };
    };
    for (const gr of groups.values()) {
      if (gr.closed) {
        const { tris } = triangulate(geo, gr.mask);
        if (!tris.length) continue;
        if (!normals && (o.normals !== false || hasN)) normals = resolveVertexNormals(geo, o.cuspAngle ?? 60);
        const chans: Channel[] = [posCh];
        if (normals) {
          const nn = normals;
          // point N (and no vertex N) gives one normal per point: no need to split shared vertices
          const pN = geo.points.get('N'), pointN = !geo.vertices.get('N') && !!pN && pN.size === 3 && pN.type === 'float';
          chans.push({ semantic: 'NORMAL', size: 3, int: false, perPoint: pointN, read(v, _pt, _pr, out, oo) { const d = xfDir(nn[v * 3], nn[v * 3 + 1], nn[v * 3 + 2], o); out[oo] = d[0]; out[oo + 1] = d[1]; out[oo + 2] = d[2]; } });
        }
        const uv0 = uvCh('uv', 'TEXCOORD_0'), uv1 = uvCh('uv2', 'TEXCOORD_1');
        const tan = tangentChannel(tris, normals, gr.mat, name);
        if (tan) chans.push(tan);
        if (uv0) chans.push(uv0);
        if (uv1) chans.push(uv1);
        const col = colorFor(gr.mat);
        if (col) chans.push(col);
        chans.push(...customs);
        const e = emit(chans, tris, vprim, geo, true);
        const out: PrimOut = { mode: Primitive.Mode.TRIANGLES, channels: chans, data: e.data, count: e.count, indices: e.idx, material: null };
        finishColor(out, gr.mat);
        outs.push(out);
      } else {
        const curves: number[][] = [];
        for (let p = 0; p < geo.numPrims; p++) {
          if (!gr.mask[p] || geo.primSize(p) < 2) continue;
          const c: number[] = [];
          for (let v = geo.primStart[p]; v < geo.primStart[p + 1]; v++) c.push(v);
          curves.push(c);
        }
        if (!curves.length) continue;
        const chans: Channel[] = [posCh];
        const uv0 = uvCh('uv', 'TEXCOORD_0');
        if (uv0) chans.push(uv0);
        const col = colorFor(gr.mat);
        if (col) chans.push(col);
        chans.push(...customs);
        const strips = lineMode === 'strip' && curves.length <= MAX_LINE_STRIPS;
        const batches = strips ? curves.map((c) => [c]) : [curves];
        for (const batch of batches) {
          const corners = batch.flat();
          const e = emit(chans, corners, vprim, geo, false);
          let indices: number[] | null = null;
          if (!strips) {
            indices = [];
            let base = 0;
            for (const c of batch) { for (let k = 0; k + 1 < c.length; k++) indices.push(base + k, base + k + 1); base += c.length; }
          }
          const out: PrimOut = { mode: strips ? Primitive.Mode.LINE_STRIP : Primitive.Mode.LINES, channels: chans.slice(), data: e.data, count: e.count, indices, material: null };
          finishColor(out, gr.mat);
          outs.push(out);
        }
      }
    }
    // isolated points
    const iso = isolatedMask(geo);
    const isoPts: number[] = [];
    iso.forEach((u, i) => { if (u) isoPts.push(-1 - i); });
    if (isoPts.length) {
      const chans: Channel[] = [posCh];
      const pn = geo.points.get('N');
      if (pn && pn.size === 3 && pn.type === 'float') {
        const d = pn.data as Float64Array;
        chans.push({ semantic: 'NORMAL', size: 3, int: false, perPoint: true, read(_v, pt, _pr, out, oo) {
          const l = Math.hypot(d[pt * 3], d[pt * 3 + 1], d[pt * 3 + 2]) || 1;
          const n = xfDir(d[pt * 3] / l, d[pt * 3 + 1] / l, d[pt * 3 + 2] / l, o); out[oo] = n[0]; out[oo + 1] = n[1]; out[oo + 2] = n[2];
        } });
      }
      if (color) chans.push(color);
      const ptCustoms = custom ? customs : customChannels(geo, used, info, ['pscale']);
      chans.push(...ptCustoms);
      const e = emit(chans, isoPts, null, geo, false);
      const out: PrimOut = { mode: Primitive.Mode.POINTS, channels: chans, data: e.data, count: e.count, indices: null, material: null };
      const ci = color ? chans.indexOf(color) : -1;
      if (ci >= 0 && rgbAllOnes(e.data[ci], chans[ci].size) && (chans[ci].size === 3 || !e.data[ci].some((x, i) => i % 4 === 3 && x < 1))) { chans.splice(ci, 1); e.data.splice(ci, 1); }
      outs.push(out);
    }
    if (!outs.length) continue;
    const w = writeMesh(doc, buffer, scene, name, outs, info, quantize);
    job.onMesh?.(w);
  }
  if (empties.length) writeEmpties(doc, scene, empties, o);
  if (quantize) doc.createExtension(KHRMeshQuantization).setRequired(true);
  if (noUV) o.warn?.(`glTF: ${noUV} primitive(s) use a textured material but have no uv attribute (add uv_project or uv_unwrap)`);
  return doc;
}

interface WrittenMesh { node: GNode; center: number[]; extent: number }

/**
 * Scene empties as meshless nodes. Parents resolve by name among the empties and the mesh nodes written so far; each
 * node gets the local TRS that places it at its geometry-space transform (in export space: axis conversion, scale).
 */
function writeEmpties(doc: Document, scene: ReturnType<Document['createScene']>, empties: SceneEmpty[], o: ExportOptions) {
  const meshNodes = new Map<string, GNode[]>();
  for (const n of doc.getRoot().listNodes()) {
    const l = meshNodes.get(n.getName());
    if (l) l.push(n); else meshNodes.set(n.getName(), [n]);
  }
  const byName = new Map<string, SceneEmpty[]>();
  for (const e of empties) {
    if (!e.name) throw new Error(`glTF: scene empty at point ${e.point} has no name`);
    const l = byName.get(e.name);
    if (l) l.push(e); else byName.set(e.name, [e]);
  }
  type Parent = { empty: SceneEmpty } | { node: GNode } | null;
  const parentOf = new Map<SceneEmpty, Parent>();
  for (const e of empties) {
    if (!e.parent) { parentOf.set(e, null); continue; }
    const es = byName.get(e.parent) ?? [], ms = meshNodes.get(e.parent) ?? [];
    const where = `glTF: scene empty "${e.name}": parent "${e.parent}"`;
    // without splitByName every mesh is merged into one node ("mesh"), so a named mesh parent no longer exists: the
    // empty goes on the scene root, where its geometry-space transform places it the same (previews, viewers)
    if (!es.length && !ms.length && o.splitByName === false) { parentOf.set(e, null); continue; }
    if (!es.length && !ms.length) throw new Error(`${where} is neither an empty nor a mesh (meshes: ${[...meshNodes.keys()].slice(0, 12).join(', ') || 'none'}; empties: ${[...byName.keys()].slice(0, 12).join(', ')})`);
    if (es.length + ms.length > 1) throw new Error(`${where} is ambiguous: ${es.length} empt${es.length === 1 ? 'y' : 'ies'} and ${ms.length} mesh${ms.length === 1 ? '' : 'es'} have that name`);
    if (ms.length && ms[0].getExtension('EXT_mesh_gpu_instancing')) throw new Error(`${where} is a GPU-instanced mesh; parenting to an individual instance is not supported (parent to the scene or an empty instead)`);
    parentOf.set(e, es.length ? { empty: es[0] } : { node: ms[0] });
  }
  for (const e of empties) {
    const chain: string[] = [];
    const seen = new Set<SceneEmpty>();
    for (let c: SceneEmpty | null = e; c;) {
      if (seen.has(c)) throw new Error(`glTF: scene empties form a parent cycle: ${[...chain, c.name].join(' → ')}`);
      seen.add(c); chain.push(c.name);
      const pr = parentOf.get(c);
      c = pr && 'empty' in pr ? pr.empty : null;
    }
  }
  // world matrix in export space: translation converted like positions, rotation conjugated by the axis change
  const world = new Map<SceneEmpty, Float64Array>();
  for (const e of empties) {
    const R = xfLinear(xform3(m4fromQuat(e.orient)), 0, o), t = xf(e.P[0], e.P[1], e.P[2], o);
    const m = new Float64Array(16);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = R[c * 3 + r] * e.scale[c];
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
    world.set(e, m);
  }
  const made = new Map<SceneEmpty, GNode>();
  const make = (e: SceneEmpty): GNode => {
    const done = made.get(e);
    if (done) return done;
    const pr = parentOf.get(e)!;
    const parentNode = pr ? ('empty' in pr ? make(pr.empty) : pr.node) : null;
    const pw = pr ? ('empty' in pr ? world.get(pr.empty)! : (Float64Array.from(pr.node.getWorldMatrix()) as unknown as Mat4)) : null;
    const local = pw ? m4mul(m4invert(pw as Mat4), world.get(e)! as unknown as Mat4) : (world.get(e)! as unknown as Mat4);
    const { q, s, shear } = decomposeXform(xform3(local));
    if (shear) o.warn?.(`glTF: scene empty "${e.name}": its transform relative to "${e.parent}" has shear (non-uniform parent scale with rotation); the nearest TRS was written`);
    const node = doc.createNode(e.name).setTranslation([local[12], local[13], local[14]]).setRotation([q[0], q[1], q[2], q[3]]).setScale([s[0], s[1], s[2]]);
    if (Object.keys(e.extras).length) node.setExtras(e.extras);
    if (parentNode) parentNode.addChild(node); else scene.addChild(node);
    made.set(e, node);
    return node;
  };
  for (const e of empties) make(e);
}
interface MeshJob { src: Geometry; split: boolean; onMesh?: (w: WrittenMesh) => void }

/**
 * One job per packed source: its geometry (nested instances expanded) as a single mesh whose node gets
 * EXT_mesh_gpu_instancing with every instance's TRS in export space (axis conversion and scale applied).
 */
function instanceJobs(doc: Document, buffer: ReturnType<Document['createBuffer']>, g: Geometry, o: ExportOptions, quantize: boolean): MeshJob[] {
  const kind = g.primKind!, S = g.packedSource!, X = g.packedXform!, P = g.P;
  const bySrc = new Map<number, number[]>();
  for (let p = 0; p < kind.length; p++) {
    if (kind[p] !== 1 || g.primStart[p + 1] - g.primStart[p] !== 1) continue;
    let l = bySrc.get(S[p]);
    if (!l) { l = []; bySrc.set(S[p], l); }
    l.push(p);
  }
  const ext = doc.createExtension(EXTMeshGPUInstancing).setRequired(true);
  const names = packedSourceNames(g);
  const iattrs = o.custom === true ? instanceAttribSpecs(g) : [];
  const info: Record<string, InstanceAttribInfo> = {};
  for (const ia of iattrs) info[ia.sem] = { name: ia.a.name, cls: ia.a.cls, type: ia.type, size: ia.size, ...(ia.strings ? { strings: ia.strings } : {}) };
  let sheared = 0;
  const jobs: MeshJob[] = [];
  for (const [s, prims] of bySrc) {
    const n = prims.length;
    const T = new Float64Array(n * 3), L = new Float64Array(n * 9), Q = new Float32Array(n * 4), SC = new Float64Array(n * 3);
    prims.forEach((p, i) => {
      const a = g.vertexPoint[g.primStart[p]];
      T.set(xf(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], o), i * 3);
      L.set(xfLinear(X, p * 9, o), i * 9); // linear part in export space (axis conversion)
      const d = decomposeXform(L, i * 9);
      if (d.shear) sheared++;
      Q.set(d.q, i * 4);
      SC.set(d.s, i * 3);
    });
    const src = flattenSource(g.packedSources[s]);
    const label = names[s] ?? `source_${s}`;
    jobs.push({
      src, split: false,
      onMesh: ({ node, center, extent }) => {
        node.setName(label);
        node.getMesh()?.setName(label);
        // the quantization volume of the mesh (node TRS) folds into each instance: T·R·S·(Tc·Se) = T(t + RS·c)·R·(S·e)
        if (quantize) node.setTranslation([0, 0, 0]).setScale([1, 1, 1]);
        const tr = new Float32Array(n * 3), sc = new Float32Array(n * 3);
        const e = quantize ? extent : 1;
        for (let i = 0; i < n; i++) for (let r = 0; r < 3; r++) {
          const off = quantize ? L[i * 9 + r] * center[0] + L[i * 9 + 3 + r] * center[1] + L[i * 9 + 6 + r] * center[2] : 0;
          tr[i * 3 + r] = T[i * 3 + r] + off;
          sc[i * 3 + r] = SC[i * 3 + r] * e;
        }
        const ro = Q;
        const acc = (arr: Float32Array, type: 'VEC3' | 'VEC4') => doc.createAccessor().setArray(arr as Float32Array<ArrayBuffer>).setType(type).setBuffer(buffer);
        const im = ext.createInstancedMesh()
          .setAttribute('TRANSLATION', acc(tr, 'VEC3')).setAttribute('ROTATION', acc(ro, 'VEC4')).setAttribute('SCALE', acc(sc, 'VEC3'));
        for (const ia of iattrs) {
          const vals = instanceAttribValues(g, ia, prims);
          im.setAttribute(ia.sem, doc.createAccessor().setArray(vals).setType(TYPES[ia.size - 1]).setBuffer(buffer));
        }
        node.setExtension('EXT_mesh_gpu_instancing', im);
        if (iattrs.length) node.setExtras({ topotopo: { instanceAttributes: info } });
      },
    });
  }
  if (sheared) o.warn?.(`glTF instancing: ${sheared} instance transform(s) have shear (non-uniform scale after rotation), written as rotation + per-axis scale; use instancing "expand" for exact geometry`);
  return jobs;
}

interface InstanceAttribInfo { name: string; cls: 'point' | 'prim'; type: 'float' | 'int' | 'string'; size: number; strings?: string[] }
interface InstanceAttribSpec { sem: string; a: AnchorAttrib; type: 'float' | 'int' | 'string'; size: number; alpha: AnchorAttrib | null; strings?: string[]; index?: Map<string, number> }

/** The per-instance attributes written as `_NAME` instance accessors (see the module comment). */
function instanceAttribSpecs(g: Geometry): InstanceAttribSpec[] {
  const list = anchorAttribs(g, INSTANCE_ATTRIB_SKIP);
  const cd = list.find((x) => x.name === 'Cd' && x.attr.type === 'float' && x.attr.size === 3) ?? null;
  const alpha = cd ? list.find((x) => x.name === 'Alpha' && x.attr.type === 'float' && x.attr.size === 1) ?? null : null;
  const used = new Set(['TRANSLATION', 'ROTATION', 'SCALE']);
  const out: InstanceAttribSpec[] = [];
  for (const a of list) {
    if (a === alpha) continue; // folded into _COLOR
    if (a.attr.type !== 'string' && (a.attr.size < 1 || a.attr.size > 4)) continue;
    const base = a === cd ? '_COLOR' : '_' + a.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    let sem = base, k = 1;
    while (used.has(sem)) sem = `${base}_${k++}`;
    used.add(sem);
    if (a.attr.type === 'string') {
      // a table of the values in first-use order (instances in prim order)
      const index = new Map<string, number>(), strings: string[] = [];
      for (let p = 0; p < g.numPrims; p++) {
        if (!g.isPacked(p)) continue;
        const v = anchorValue(g, a, p) as string;
        if (!index.has(v)) { index.set(v, strings.length); strings.push(v); }
      }
      out.push({ sem, a, type: 'string', size: 1, alpha: null, strings, index });
    } else out.push({ sem, a, type: a.attr.type === 'int' ? 'int' : 'float', size: a === cd && alpha ? 4 : a.attr.size, alpha: a === cd ? alpha : null });
  }
  return out;
}

/** Accessor array (32-bit float, see the module comment) of one per-instance attribute over the given packed prims. */
function instanceAttribValues(g: Geometry, ia: InstanceAttribSpec, prims: number[]): TypedArray {
  const size = ia.size, out = new Float32Array(prims.length * size);
  prims.forEach((p, i) => {
    if (ia.type === 'string') { out[i] = ia.index!.get(anchorValue(g, ia.a, p) as string) ?? 0; return; }
    const v = anchorValue(g, ia.a, p) as number[];
    for (let c = 0; c < ia.a.attr.size && c < size; c++) out[i * size + c] = v[c];
    if (ia.alpha) out[i * size + 3] = (anchorValue(g, ia.alpha, p) as number[])[0];
  });
  return out;
}

/** Per-instance accessors of an EXT_mesh_gpu_instancing node → anchor point / packed prim attributes of `part`. */
function applyInstanceAttribs(part: Geometry, inst: InstancedMesh, info: Record<string, InstanceAttribInfo>, warn: (m: string) => void) {
  const n = part.numPrims;
  for (const sem of inst.listSemantics()) {
    if (!sem.startsWith('_')) continue;
    const r = readAccessor(inst.getAttribute(sem)!);
    if (r.count !== n) { warn(`EXT_mesh_gpu_instancing: ${sem} has ${r.count} values for ${n} instances; skipped`); continue; }
    const spec = info[sem];
    const t = spec?.cls === 'prim' ? part.prims : part.points; // anchor point i belongs to packed prim i
    if (spec?.type === 'string') {
      const table = spec.strings ?? [];
      t.map.set(spec.name, new Attribute('string', 1, Array.from({ length: n }, (_, i) => String(table[Math.round(r.data[i])] ?? ''))));
      continue;
    }
    const name = spec?.name ?? (sem === '_COLOR' ? 'Cd' : sem.slice(1).toLowerCase());
    if (name === 'Cd' && r.size >= 3) {
      const cd = t.add('Cd', 'float', 3).data as Float64Array;
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) cd[i * 3 + c] = r.data[i * r.size + c];
      if (r.size === 4) { const al = t.add('Alpha', 'float', 1).data as Float64Array; for (let i = 0; i < n; i++) al[i] = r.data[i * 4 + 3]; }
      continue;
    }
    const type: AttribType = spec?.type === 'int' ? 'int' : 'float';
    const size = r.size;
    const at = new Attribute(type, size, type === 'int' ? new Int32Array(n * size) : new Float64Array(n * size), defaultValueFor(name, size, type));
    const d = at.data as Float64Array | Int32Array;
    for (let i = 0; i < n * size; i++) d[i] = type === 'int' ? Math.round(r.data[i]) : r.data[i];
    t.map.set(name, at);
  }
}

/** Create accessors (optionally quantized), the mesh and its node. */
function writeMesh(doc: Document, buffer: ReturnType<Document['createBuffer']>, scene: ReturnType<Document['createScene']>, name: string, outs: PrimOut[], info: Record<string, CustomInfo>, quantize: boolean): WrittenMesh {
  const mesh = doc.createMesh(name);
  const node = doc.createNode(name).setMesh(mesh);
  // quantization volume: uniform scale keeps normals undistorted
  let center = [0, 0, 0], extent = 1;
  if (quantize) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const out of outs) {
      const d = out.data[out.channels.findIndex((c) => c.semantic === 'POSITION')];
      for (let i = 0; i < d.length; i++) { const c = i % 3; if (d[i] < mn[c]) mn[c] = d[i]; if (d[i] > mx[c]) mx[c] = d[i]; }
    }
    center = [0, 1, 2].map((c) => (mn[c] + mx[c]) / 2);
    extent = Math.max(...[0, 1, 2].map((c) => (mx[c] - mn[c]) / 2)) || 1;
    node.setTranslation([center[0], center[1], center[2]]).setScale([extent, extent, extent]);
  }
  const acc = (arr: TypedArray, size: number, normalized = false) =>
    doc.createAccessor().setArray(arr).setType(TYPES[size - 1]).setBuffer(buffer).setNormalized(normalized);
  for (const out of outs) {
    const prim = doc.createPrimitive().setMode(out.mode as any);
    if (out.foldedColor) prim.setExtras({ topotopo: { Cd: out.foldedColor } });
    out.channels.forEach((ch, ci) => {
      const d = out.data[ci];
      let a: Accessor;
      if (ch.semantic === 'POSITION' && quantize) {
        const q = new Int16Array(d.length);
        for (let i = 0; i < d.length; i++) q[i] = Math.round(Math.max(-1, Math.min(1, (d[i] - center[i % 3]) / extent)) * 32767);
        a = acc(q as any, 3, true);
      } else if ((ch.semantic === 'NORMAL' || ch.semantic === 'TANGENT') && quantize) {
        a = acc(Int8Array.from(d, (x) => Math.round(Math.max(-1, Math.min(1, x)) * 127)), ch.size, true);
      } else if (ch.semantic.startsWith('TEXCOORD_') && quantize && d.every((x) => x >= 0 && x <= 1)) {
        a = acc(Uint16Array.from(d, (x) => Math.round(x * 65535)), 2, true);
      } else if (ch.semantic === 'COLOR_0' && quantize && d.every((x) => x >= 0 && x <= 1)) {
        // COLOR_0 is linear: rgb from display values, alpha as it is
        a = acc(Uint16Array.from(d, (x, i) => Math.round((i % ch.size < 3 ? toLinear(x) : x) * 65535)), ch.size, true);
      } else if (ch.semantic === 'COLOR_0') {
        a = acc(Float32Array.from(d, (x, i) => { const c = Math.max(0, Math.min(1, x)); return i % ch.size < 3 ? toLinear(c) : c; }), ch.size);
      } else if (ch.int) {
        let mn = Infinity, mx = -Infinity;
        for (const x of d) { if (x < mn) mn = x; if (x > mx) mx = x; }
        const arr = mn >= -128 && mx <= 127 ? Int8Array.from(d) : mn >= 0 && mx <= 255 ? Uint8Array.from(d)
          : mn >= -32768 && mx <= 32767 ? Int16Array.from(d) : mn >= 0 && mx <= 65535 ? Uint16Array.from(d) : Float32Array.from(d);
        a = acc(arr, ch.size);
      } else a = acc(Float32Array.from(d), ch.size);
      prim.setAttribute(ch.semantic, a);
    });
    if (out.indices) {
      const n = out.count;
      prim.setIndices(acc(n < 65535 ? Uint16Array.from(out.indices) : Uint32Array.from(out.indices), 1));
    }
    if (out.material) prim.setMaterial(out.material);
    mesh.addPrimitive(prim);
  }
  if (Object.keys(info).length) mesh.setExtras({ topotopo: { attributes: info } });
  scene.addChild(node);
  return { node, center, extent };
}

async function exportIO(doc: Document, o: ExportOptions): Promise<HostIO> {
  const io = new HostIO().registerExtensions(ALL_EXTENSIONS);
  if (o.compress === 'meshopt') {
    await MeshoptEncoder.ready;
    io.registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  } else if (o.compress === 'draco') {
    io.registerDependencies({ 'draco3d.encoder': await loadDraco('encoder') });
    doc.createExtension(KHRDracoMeshCompression).setRequired(true);
  }
  return io;
}

/**
 * Read the material table's texture files (o.readFile) for gltfDocument; warns about each one it cannot read.
 * "image:<name>" textures are image volumes of the geometry, encoded to PNG in memory (io/textures.ts).
 */
async function withTextures(g: Geometry, o: ExportOptions): Promise<ExportOptions> {
  if (o.materials === false || o.textureData) return o;
  const paths = texturePaths(mergeMaterialTables([g, ...g.packedSources]));
  if (!paths.length) return o;
  const data = imageTextureData(g, o.deflate, o.warn, 'glTF');
  const files = paths.filter((p) => !data.has(p));
  for (const p of files) {
    if (!o.readFile) { data.set(p, null); continue; }
    try { data.set(p, await o.readFile(p)); } catch (e: any) { data.set(p, null); o.warn?.(`glTF: texture "${p}" could not be read (${e?.message ?? e}); material exported without it`); }
  }
  if (!o.readFile && files.length) o.warn?.(`glTF: ${files.length} texture map(s) skipped: no file access in this export (pass readFile)`);
  return { ...o, textureData: data };
}

/** GLB bytes. */
export async function exportGLB(g: Geometry, o: ExportOptions = {}): Promise<Uint8Array> {
  o = await withTextures(g, o);
  if (o.tangents !== 'none') await loadMikkTSpace();
  const doc = gltfDocument(g, o);
  const io = await exportIO(doc, o);
  return io.writeBinary(doc);
}

/** Self-contained .gltf JSON text (buffers embedded as data URIs). */
export async function exportGLTF(g: Geometry, o: ExportOptions = {}): Promise<string> {
  o = await withTextures(g, o);
  if (o.tangents !== 'none') await loadMikkTSpace();
  const doc = gltfDocument(g, o);
  const io = await exportIO(doc, o);
  const { json, resources } = await io.writeJSON(doc, { format: 'GLTF' as any });
  for (const b of json.buffers ?? []) {
    if (!b.uri) continue;
    const data = resources[b.uri];
    if (data) b.uri = 'data:application/octet-stream;base64,' + base64(data);
    else delete b.uri; // meshopt fallback buffer: no data
  }
  for (const im of json.images ?? []) {
    if (!im.uri || im.uri.startsWith('data:')) continue;
    const data = resources[im.uri];
    if (data) im.uri = `data:${im.mimeType ?? imageMime(data) ?? 'image/png'};base64,` + base64(data);
  }
  return JSON.stringify(json);
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ------------------------------------------------------------------ import

export interface GLTFImportOptions {
  /** reads external files (buffers) by path; usually Host.readFile */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** path of the file being read, to resolve relative URIs */
  path?: string;
  warn?: (msg: string) => void;
  /** EXT_mesh_gpu_instancing: 'packed' (default) = packed prims sharing one source per mesh; 'expand' = real geometry */
  instancing?: 'packed' | 'expand';
}

const isGLB = (b: Uint8Array) => b.byteLength >= 12 && new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true) === 0x46546c67;

function containerToJSON(bytes: Uint8Array): JSONDocument {
  if (!isGLB(bytes)) return { json: JSON.parse(new TextDecoder().decode(bytes)), resources: {} };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let json: any = null, bin: Uint8Array | null = null;
  for (let off = 12; off + 8 <= bytes.byteLength;) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const chunk = bytes.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004e4942 && !bin) bin = chunk;
    off += 8 + len;
  }
  if (!json) throw new Error('GLB: missing JSON chunk');
  // gltf-transform keeps views on the buffer: copy so the result does not alias the caller's bytes
  return { json, resources: bin ? { [GLB_BUFFER]: bin.slice() } : {} };
}

/** Read an accessor as float64 (normalized integers decoded). */
function readAccessor(a: Accessor): { size: number; count: number; data: Float64Array } {
  const arr = a.getArray() as ArrayLike<number> | null;
  const size = a.getElementSize(), count = a.getCount();
  const data = new Float64Array(count * size);
  if (!arr) return { size, count, data };
  if (a.getNormalized()) { const ct = a.getComponentType(); for (let i = 0; i < data.length; i++) data[i] = MathUtils.decodeNormalizedInt(arr[i], ct); }
  else data.set(arr);
  return { size, count, data };
}

/** Path of a texture's image: its URI resolved against `base`, or "embedded:<name>" for an image stored in the file. */
function texturePathOf(t: Texture | null, base: string, index: (t: Texture) => number): string | undefined {
  if (!t) return undefined;
  const uri = t.getURI();
  if (uri && !uri.startsWith('data:') && t.getImage()?.byteLength === 0) {
    const u = decodeURIComponent(uri);
    return /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('/') || /^[A-Za-z]:[\\/]/.test(u) || !base ? u : base.replace(/[\\/]+$/, '') + '/' + u;
  }
  return `embedded:${t.getName() || (uri && !uri.startsWith('data:') ? uri : `image_${index(t)}`)}`;
}

/** Material table entry from a glTF material (lossless for topotopo files via extras). */
function materialEntry(m: GMaterial, base = '', index: (t: Texture) => number = () => 0): Material {
  const ex = (m.getExtras() as any)?.topotopo?.material;
  if (ex) return normalizeMaterial(ex);
  const bc = m.getBaseColorFactor(), em = m.getEmissiveFactor();
  const strength = (m.getExtension('KHR_materials_emissive_strength') as EmissiveStrength | null)?.getEmissiveStrength() ?? 1;
  // glTF factors are linear; the material table holds display values
  return normalizeMaterial({
    baseColor: [toDisplay(bc[0]), toDisplay(bc[1]), toDisplay(bc[2])], metallic: m.getMetallicFactor(), roughness: m.getRoughnessFactor(),
    emissive: [toDisplay(em[0]) * strength, toDisplay(em[1]) * strength, toDisplay(em[2]) * strength], alpha: bc[3],
    doubleSided: m.getDoubleSided(), unlit: !!m.getExtension('KHR_materials_unlit'),
    alphaMode: m.getAlphaMode(), alphaCutoff: m.getAlphaCutoff(),
    textures: {
      baseColor: texturePathOf(m.getBaseColorTexture(), base, index),
      normal: texturePathOf(m.getNormalTexture(), base, index),
      roughness: texturePathOf(m.getMetallicRoughnessTexture(), base, index),
    },
  });
}

/** Local-space geometry of one primitive (prims in CSR, attributes on points). */
function primitiveGeometry(prim: Primitive, attrInfo: Record<string, CustomInfo>, warn: (m: string) => void): Geometry | null {
  const pos = prim.getAttribute('POSITION');
  if (!pos) return null;
  const P = readAccessor(pos);
  const n = P.count;
  const ia = prim.getIndices();
  const idx: ArrayLike<number> = ia ? (ia.getArray() as ArrayLike<number>) : Uint32Array.from({ length: n }, (_, i) => i);
  const starts: number[] = [0], vp: number[] = [], closed: number[] = [];
  const add = (pts: ArrayLike<number>, c: boolean) => { for (let k = 0; k < pts.length; k++) vp.push(pts[k]); starts.push(vp.length); closed.push(c ? 1 : 0); };
  const mode = prim.getMode();
  const M = Primitive.Mode;
  if (mode === M.TRIANGLES) for (let i = 0; i + 2 < idx.length; i += 3) add([idx[i], idx[i + 1], idx[i + 2]], true);
  else if (mode === M.TRIANGLE_STRIP) for (let i = 0; i + 2 < idx.length; i++) add(i % 2 ? [idx[i + 1], idx[i], idx[i + 2]] : [idx[i], idx[i + 1], idx[i + 2]], true);
  else if (mode === M.TRIANGLE_FAN) for (let i = 1; i + 1 < idx.length; i++) add([idx[0], idx[i], idx[i + 1]], true);
  else if (mode === M.LINES) {
    // chain consecutive segments that share an index back into polylines
    let cur: number[] = [];
    for (let i = 0; i + 1 < idx.length; i += 2) {
      if (cur.length && cur[cur.length - 1] === idx[i]) cur.push(idx[i + 1]);
      else { if (cur.length) add(cur, false); cur = [idx[i], idx[i + 1]]; }
    }
    if (cur.length) add(cur, false);
  } else if (mode === M.LINE_STRIP) { if (idx.length >= 2) add(Array.from(idx), false); }
  else if (mode === M.LINE_LOOP) { if (idx.length >= 2) add(Array.from(idx), true); }
  else if (mode !== M.POINTS) warn(`glTF primitive mode ${mode} is not supported; points only`);
  const g = new Geometry({ positions: P.data });
  g.primStart = Int32Array.from(starts);
  g.vertexPoint = Int32Array.from(vp);
  g.primClosed = Uint8Array.from(closed);
  g.vertices = new AttribTable(vp.length);
  g.prims = new AttribTable(closed.length);
  const setPt = (name: string, a: Accessor, size: number, type: AttribType, map?: (src: Float64Array, i: number, out: Float64Array) => void) => {
    const r = readAccessor(a);
    const at = new Attribute(type, size, type === 'int' ? new Int32Array(n * size) : new Float64Array(n * size), defaultValueFor(name, size, type));
    const d = at.data as Float64Array;
    for (let i = 0; i < n; i++) {
      if (map) map(r.data, i, d);
      else for (let c = 0; c < size; c++) d[i * size + c] = type === 'int' ? Math.round(r.data[i * r.size + c]) : r.data[i * r.size + c];
    }
    g.points.set(name, at);
  };
  for (const sem of prim.listSemantics()) {
    const a = prim.getAttribute(sem)!;
    const es = a.getElementSize();
    if (sem === 'POSITION') continue;
    if (sem === 'NORMAL') setPt('N', a, 3, 'float');
    else if (sem === 'TANGENT' && es === 4) setPt(TANGENT_ATTRIB, a, 4, 'float');
    else if (sem === 'TEXCOORD_0' || sem === 'TEXCOORD_1') setPt(sem === 'TEXCOORD_0' ? 'uv' : 'uv2', a, 3, 'float', (s, i, out) => { out[i * 3] = s[i * es]; out[i * 3 + 1] = gltfV(s[i * es + 1]); out[i * 3 + 2] = 0; });
    else if (sem === 'COLOR_0') {
      // COLOR_0 is linear; Cd holds display values
      setPt('Cd', a, 3, 'float', (s, i, out) => { out[i * 3] = toDisplay(s[i * es]); out[i * 3 + 1] = toDisplay(s[i * es + 1]); out[i * 3 + 2] = toDisplay(s[i * es + 2]); });
      if (es === 4) setPt('Alpha', a, 1, 'float', (s, i, out) => { out[i] = s[i * 4 + 3]; });
    } else if (sem.startsWith('_') && es <= 16) {
      const inf = attrInfo[sem];
      const name = inf?.name ?? sem.slice(1).toLowerCase();
      setPt(name, a, es, inf?.type === 'int' ? 'int' : 'float');
    }
    // JOINTS_n, WEIGHTS_n, TEXCOORD_2+, COLOR_1+ are not imported
  }
  // a constant Cd that the exporter folded into the material factor comes back as the point colour it was
  const folded = (prim.getExtras() as any)?.topotopo?.Cd;
  if (!prim.getAttribute('COLOR_0') && Array.isArray(folded) && folded.length === 3 && folded.every((x: unknown) => typeof x === 'number')) {
    const cd = new Attribute('float', 3, new Float64Array(n * 3), defaultValueFor('Cd', 3, 'float'));
    const d = cd.data as Float64Array;
    for (let i = 0; i < n; i++) { d[i * 3] = folded[0]; d[i * 3 + 1] = folded[1]; d[i * 3 + 2] = folded[2]; }
    g.points.set('Cd', cd);
  }
  return g;
}

function transformGeo(local: Geometry, m: Mat4): Geometry {
  const g = local.clone();
  const P = g.P;
  for (let i = 0; i < P.length; i += 3) m4apply(m, P[i], P[i + 1], P[i + 2], P, i);
  const N = g.points.get('N');
  if (N) {
    const nm = m4normalMatrix(m), d = N.data as Float64Array;
    for (let i = 0; i < d.length; i += 3) {
      m4applyDir(nm, d[i], d[i + 1], d[i + 2], d, i);
      const l = Math.hypot(d[i], d[i + 1], d[i + 2]) || 1;
      d[i] /= l; d[i + 1] /= l; d[i + 2] /= l;
    }
  }
  const T = g.points.get(TANGENT_ATTRIB);
  if (T && T.size === 4) transformTangents(T.data as Float64Array, g.numPoints, xform3(m));
  return g;
}

/** EXT_mesh_gpu_instancing: one matrix per instance (TRANSLATION · ROTATION · SCALE). */
function instanceMatrices(inst: InstancedMesh): Mat4[] {
  const T = inst.getAttribute('TRANSLATION'), R = inst.getAttribute('ROTATION'), S = inst.getAttribute('SCALE');
  const t = T ? readAccessor(T) : null, r = R ? readAccessor(R) : null, s = S ? readAccessor(S) : null;
  const count = (t ?? r ?? s)?.count ?? 0;
  const out: Mat4[] = [];
  for (let i = 0; i < count; i++) {
    const tr = t ? m4translate(t.data[i * 3], t.data[i * 3 + 1], t.data[i * 3 + 2]) : m4scale(1, 1, 1);
    const ro = r ? m4fromQuat([r.data[i * 4], r.data[i * 4 + 1], r.data[i * 4 + 2], r.data[i * 4 + 3]]) : m4scale(1, 1, 1);
    const sc = s ? m4scale(s.data[i * 3], s.data[i * 3 + 1], s.data[i * 3 + 2]) : m4scale(1, 1, 1);
    out.push(m4mul(tr, m4mul(ro, sc)));
  }
  return out;
}

const RESERVED_EXTRAS = new Set(`P N uv uv2 Cd Alpha material name path orient scale pscale ${EMPTY_ATTRIB} ${PARENT_ATTRIB}`.split(' '));

/**
 * The parent an imported empty refers to: the name (node name, else its mesh's) of the nearest ancestor that is imported
 * as an empty or a mesh; cameras, lights and GPU-instanced meshes are skipped (the world transform is kept either way).
 */
function importedParent(node: GNode): string {
  for (let p = node.getParentNode(); p; p = p.getParentNode()) {
    if (p.getCamera() || p.getExtension('KHR_lights_punctual') || p.getExtension('EXT_mesh_gpu_instancing')) continue;
    return p.getName() || p.getMesh()?.getName() || '';
  }
  return '';
}

function constantAttribute(table: AttribTable, name: string, type: AttribType, size: number, value: number | string | number[]) {
  const a = table.add(name, type, size);
  for (let i = 0; i < table.count; i++) a.set(i, value);
}

/** Object extras only; topotopo's private round-trip metadata keeps its existing readers. */
function objectExtras(table: AttribTable, extras: Record<string, unknown>, collisions: Set<string>) {
  // Explicit key order keeps schemas stable even when producers serialize extras in a different order.
  for (const key of Object.keys(extras).sort()) {
    if (key === 'topotopo') continue;
    if (RESERVED_EXTRAS.has(key)) { collisions.add(key); continue; }
    const value = extras[key];
    if (typeof value === 'string') constantAttribute(table, key, 'string', 1, value);
    else if (typeof value === 'boolean') constantAttribute(table, key, 'int', 1, value ? 1 : 0);
    else if (typeof value === 'number' && Number.isFinite(value)) constantAttribute(table, key, Number.isInteger(value) ? 'int' : 'float', 1, value);
    else if (Array.isArray(value) && value.length >= 2 && value.length <= 4 && value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      constantAttribute(table, key, 'float', value.length, value);
    }
  }
}

/** Geometry from the default (or first) scene, traversed in scene order with world transforms. */
export function documentToGeometry(doc: Document, warn: (m: string) => void = () => {}, instancing: 'packed' | 'expand' = 'packed', base = ''): Geometry {
  const root = doc.getRoot();
  const texIndex = (t: Texture) => root.listTextures().indexOf(t);
  const table: MaterialTable = {};
  const matNames = new Map<GMaterial, string | null>();
  const matName = (m: GMaterial | null): string | null => {
    if (!m) return null;
    let n = matNames.get(m);
    if (n !== undefined) return n;
    if ((m.getExtras() as any)?.topotopo?.default) n = null;
    else {
      n = m.getName() || `material_${root.listMaterials().indexOf(m)}`;
      if (!(n in table)) table[n] = materialEntry(m, base, texIndex);
    }
    matNames.set(m, n);
    return n;
  };
  const parts: Geometry[] = [];
  const localCache = new Map<object, Geometry | null>();
  const sourceCache = new Map<object, Map<string, Geometry>>();
  const sharedSources = new Map<object, Geometry>();
  const nodes: GNode[] = [];
  const scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null;
  if (scene) scene.traverse((n) => { nodes.push(n); });
  else for (const n of root.listNodes()) if (!n.getParentNode()) n.traverse((n) => { nodes.push(n); });
  const meshRefs = new Map<object, number>();
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (mesh && !node.getExtension('EXT_mesh_gpu_instancing') && !node.getCamera() && !node.getExtension('KHR_lights_punctual')) meshRefs.set(mesh, (meshRefs.get(mesh) ?? 0) + 1);
  }
  const collisions = new Set<string>();
  let skipped = 0;
  let instanced = false;
  const visitNode = (node: GNode) => {
    if (node.getCamera() || node.getExtension('KHR_lights_punctual')) { skipped++; return; }
    const mesh = node.getMesh();
    const world = Float64Array.from(node.getWorldMatrix()) as unknown as Mat4;
    const ancestors: string[] = [];
    for (let p = node.getParentNode(); p; p = p.getParentNode()) ancestors.push(p.getName());
    const path = ancestors.reverse().join('/');
    const extras = { ...mesh?.getExtras(), ...node.getExtras() };
    if (!mesh) {
      const g = new Geometry({ positions: [world[12], world[13], world[14]] });
      const { q, s } = decomposeXform(xform3(world));
      constantAttribute(g.points, EMPTY_ATTRIB, 'int', 1, 1);
      constantAttribute(g.points, 'name', 'string', 1, node.getName());
      constantAttribute(g.points, PARENT_ATTRIB, 'string', 1, importedParent(node));
      constantAttribute(g.points, 'path', 'string', 1, path);
      constantAttribute(g.points, 'orient', 'float', 4, q);
      constantAttribute(g.points, 'scale', 'float', 3, s);
      constantAttribute(g.points, 'pscale', 'float', 1, 1);
      objectExtras(g.points, extras, collisions);
      parts.push(g);
      return;
    }
    const inst = node.getExtension('EXT_mesh_gpu_instancing') as InstancedMesh | null;
    const mats = inst ? instanceMatrices(inst).map((m) => m4mul(world, m)) : [world];
    const info = ((mesh.getExtras() as any)?.topotopo?.attributes ?? {}) as Record<string, CustomInfo>;
    const label = node.getName() || mesh.getName();
    const shared = !inst && (meshRefs.get(mesh) ?? 0) > 1;
    if ((inst || shared) && instancing === 'packed') {
      // Shared-node sources omit name: the packed prim owns it, so unpack's normal transfer keeps each label.
      // Existing EXT sources retain their labels for round trips and source naming in instance-stream exports.
      let byLabel = sourceCache.get(mesh);
      if (!byLabel) { byLabel = new Map(); sourceCache.set(mesh, byLabel); }
      let src = shared ? sharedSources.get(mesh) : byLabel.get(label);
      if (!src) {
        const ps: Geometry[] = [];
        for (const prim of mesh.listPrimitives()) {
          let local = localCache.get(prim);
          if (local === undefined) { local = primitiveGeometry(prim, info, warn); localCache.set(prim, local); }
          if (!local) continue;
          const g = local.clone();
          const mname = matName(prim.getMaterial());
          if (!shared && label) { const a = g.prims.add('name', 'string', 1); for (let k = 0; k < g.numPrims; k++) a.set(k, label); }
          if (mname) { const a = g.prims.add('material', 'string', 1); for (let k = 0; k < g.numPrims; k++) a.set(k, mname); }
          ps.push(g);
        }
        src = Geometry.merge(ps);
        if (shared) sharedSources.set(mesh, src);
        else byLabel.set(label, src);
      }
      const part = packedFromMatrices(src, mats);
      constantAttribute(part.prims, 'name', 'string', 1, label);
      constantAttribute(part.prims, 'path', 'string', 1, path);
      objectExtras(part.prims, extras, collisions);
      if (inst) applyInstanceAttribs(part, inst, ((node.getExtras() as any)?.topotopo?.instanceAttributes ?? {}) as Record<string, InstanceAttribInfo>, warn);
      // Native instance metadata can carry these in point class; expose the effective label on the prim too.
      for (const key of ['name', 'path']) {
        const a = part.points.get(key);
        if (a?.type === 'string') part.prims.set(key, a.clone());
      }
      parts.push(part);
      return;
    }
    if (inst) instanced = true;
    for (const prim of mesh.listPrimitives()) {
      let local = localCache.get(prim);
      if (local === undefined) { local = primitiveGeometry(prim, info, warn); localCache.set(prim, local); }
      if (!local) continue;
      const mname = matName(prim.getMaterial());
      for (const m of mats) {
        const g = transformGeo(local, m);
        if (label) { const a = g.prims.add('name', 'string', 1); for (let k = 0; k < g.numPrims; k++) a.set(k, label); }
        if (mname) { const a = g.prims.add('material', 'string', 1); for (let k = 0; k < g.numPrims; k++) a.set(k, mname); }
        constantAttribute(g.prims, 'path', 'string', 1, path);
        objectExtras(g.prims, extras, collisions);
        parts.push(g);
      }
    }
  };
  for (const node of nodes) visitNode(node);
  if (skipped) warn(`skipped ${skipped} cameras/lights`);
  if (collisions.size) warn(`glTF extras skipped reserved attributes: ${[...collisions].sort().join(', ')}`);
  if (instanced) warn('EXT_mesh_gpu_instancing instances were expanded into geometry');
  // Existing unpack/export rules prefer point attributes over prim attributes. Empty-point schemas must not
  // hide an instance's values with merge defaults. Mirror only colliding keys onto its anchor, before the normal
  // Geometry.merge handles type promotion/defaults. Explicit native instance point metadata still wins.
  const pointKeys = new Set(parts.flatMap((g) => g.points.names()));
  for (const part of parts) if (part.hasPacked()) {
    for (const [key, a] of part.prims.map) if (pointKeys.has(key) && !part.points.has(key)) part.points.set(key, a.clone());
  }
  const out = Geometry.merge(parts);
  if (Object.keys(table).length) writeMaterials(out, table);
  // "image:<name>" textures (topotopo files keep the paths in material extras): decode the embedded PNGs back into
  // image volumes, so a re-export writes them again
  const images = new Map<string, Image>();
  for (const [gm, n] of matNames) {
    const tex = n ? table[n]?.textures : undefined;
    if (!tex) continue;
    const slots: [string | undefined, Texture | null][] = [[tex.baseColor, gm.getBaseColorTexture()], [tex.normal, gm.getNormalTexture()], [tex.orm ?? tex.roughness, gm.getMetallicRoughnessTexture()]];
    for (const [path, t] of slots) {
      const name = imageRef(path);
      const bytes = t?.getImage();
      if (name === null || images.has(name) || !bytes?.length || imageMime(bytes) !== 'image/png') continue;
      try {
        // one layer per texture: a grey + alpha map stays RGBA, so a re-export writes its alpha
        const png = decodePNG(bytes);
        images.set(name, imageFromPNG(png, name, { layers: png.channels === 1 ? 'grey' : 'rgba' }));
      } catch (e: any) { warn(`texture "${path}": ${e?.message ?? e}`); }
    }
  }
  out.volumes.push(...images.values());
  return out;
}

/** Import GLB or .gltf bytes (external buffers through opts.readFile). */
export async function importGLTFAsync(bytes: Uint8Array, opts: GLTFImportOptions = {}): Promise<Geometry> {
  const io = new HostIO(opts.readFile).registerExtensions(ALL_EXTENSIONS);
  const jsonDoc = containerToJSON(bytes);
  const usedExt: string[] = jsonDoc.json.extensionsUsed ?? [];
  if (usedExt.includes('EXT_meshopt_compression')) {
    await MeshoptDecoder.ready;
    io.registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  }
  if (usedExt.includes('KHR_draco_mesh_compression')) io.registerDependencies({ 'draco3d.decoder': await loadDraco('decoder') });
  const base = opts.path ? opts.path.replace(/[?#].*$/, '').replace(/[^\\/]*$/, '').replace(/[\\/]$/, '') : '';
  await io.loadExternal(jsonDoc, base);
  const doc = await io.readJSON(jsonDoc);
  return documentToGeometry(doc, opts.warn, opts.instancing ?? 'packed', base);
}
