// inspect detail "scene": what a glb export of the geometry holds, read back from the exported bytes themselves (the
// GLB's JSON chunk), so it is the export and not a guess at it: the node tree (meshes, scene empties and their
// parents, local and world positions, extras), each mesh's primitives (triangles, vertex attributes, material), the
// materials with their factors and maps, and the images (size, format, bytes). Pure: no file system.

/** A node of the exported scene. */
export interface SceneNode {
  name: string;
  /** the parent node's name, or null at the scene root */
  parent: string | null;
  /** "mesh" (with its mesh), "instances" (EXT_mesh_gpu_instancing), "empty" (a socket / scene empty) */
  kind: 'mesh' | 'instances' | 'empty';
  mesh: string | null;
  /** local translation, and the world position of the node's origin (metres, Y up) */
  translation: [number, number, number];
  world: [number, number, number];
  instances: number;
  extras: string[];
}
export interface SceneMesh { name: string; primitives: { material: string | null; mode: string; triangles: number; vertices: number; attributes: string[] }[]; triangles: number }
export interface SceneMaterial { name: string; baseColor: number[]; metallic: number; roughness: number; maps: Record<string, string>; alphaMode: string; doubleSided: boolean; unlit: boolean }
export interface SceneImage { name: string; mimeType: string; bytes: number; width: number; height: number }
export interface SceneReport { nodes: SceneNode[]; meshes: SceneMesh[]; materials: SceneMaterial[]; images: SceneImage[]; extensions: string[]; bytes: number; triangles: number }

const MODES = ['POINTS', 'LINES', 'LINE_LOOP', 'LINE_STRIP', 'TRIANGLES', 'TRIANGLE_STRIP', 'TRIANGLE_FAN'];

/** The JSON chunk and binary chunk of a GLB. */
function glbChunks(bytes: Uint8Array): { json: any; bin: Uint8Array | null } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file');
  let o = 12, json: any = null, bin: Uint8Array | null = null;
  while (o + 8 <= bytes.length) {
    const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === 0x004e4942) bin = data;
    o += 8 + len;
  }
  if (!json) throw new Error('GLB without a JSON chunk');
  return { json, bin };
}

/** Width and height of a PNG or JPEG from its header (0 × 0 when unknown). */
function imageSize(b: Uint8Array | null): [number, number] {
  if (!b || b.length < 24) return [0, 0];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === 0x89 && b[1] === 0x50) return [dv.getUint32(16), dv.getUint32(20)];
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) break;
      const m = b[o + 1], len = dv.getUint16(o + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [dv.getUint16(o + 7), dv.getUint16(o + 5)];
      o += 2 + len;
    }
  }
  return [0, 0];
}

/** Quaternion (x, y, z, w) applied to v. */
function qrot(q: number[], v: number[]): number[] {
  const [x, y, z, w] = q, ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

/** The scene a GLB holds (see the file comment). */
export function glbSceneReport(bytes: Uint8Array): SceneReport {
  const { json, bin } = glbChunks(bytes);
  const acc = (i: number | undefined) => (i === undefined ? null : json.accessors?.[i] ?? null);
  const images: SceneImage[] = (json.images ?? []).map((im: any, i: number) => {
    const bv = im.bufferView !== undefined ? json.bufferViews?.[im.bufferView] : null;
    const data = bv && bin ? bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength) : null;
    const [w, h] = imageSize(data);
    return { name: im.name ?? `image_${i}`, mimeType: im.mimeType ?? (im.uri ? 'uri' : '?'), bytes: bv?.byteLength ?? 0, width: w, height: h };
  });
  const texName = (t: any) => {
    if (!t || t.index === undefined) return null;
    const tex = json.textures?.[t.index];
    const src = tex?.source ?? tex?.extensions?.EXT_texture_webp?.source;
    const im = src !== undefined ? images[src] : undefined;
    return im ? `${im.name}${im.width ? ` ${im.width}×${im.height}` : ''}` : `texture ${t.index}`;
  };
  const materials: SceneMaterial[] = (json.materials ?? []).map((m: any, i: number) => {
    const pbr = m.pbrMetallicRoughness ?? {}, maps: Record<string, string> = {};
    const put = (k: string, t: any) => { const nm = texName(t); if (nm) maps[k] = nm; };
    put('baseColor', pbr.baseColorTexture); put('metallicRoughness', pbr.metallicRoughnessTexture);
    put('normal', m.normalTexture); put('occlusion', m.occlusionTexture); put('emissive', m.emissiveTexture);
    return {
      name: m.name ?? `material_${i}`, baseColor: pbr.baseColorFactor ?? [1, 1, 1, 1], metallic: pbr.metallicFactor ?? 1, roughness: pbr.roughnessFactor ?? 1,
      maps, alphaMode: m.alphaMode ?? 'OPAQUE', doubleSided: !!m.doubleSided, unlit: !!m.extensions?.KHR_materials_unlit,
    };
  });
  const meshes: SceneMesh[] = (json.meshes ?? []).map((m: any, i: number) => {
    const prims = (m.primitives ?? []).map((p: any) => {
      const mode = MODES[p.mode ?? 4] ?? String(p.mode);
      const pos = acc(p.attributes?.POSITION), idx = acc(p.indices);
      const count = idx ? idx.count : pos ? pos.count : 0;
      const triangles = mode === 'TRIANGLES' ? Math.floor(count / 3) : mode === 'TRIANGLE_STRIP' || mode === 'TRIANGLE_FAN' ? Math.max(0, count - 2) : 0;
      return { material: p.material !== undefined ? materials[p.material]?.name ?? `material ${p.material}` : null, mode, triangles, vertices: pos?.count ?? 0, attributes: Object.keys(p.attributes ?? {}) };
    });
    return { name: m.name ?? `mesh_${i}`, primitives: prims, triangles: prims.reduce((s: number, p: { triangles: number }) => s + p.triangles, 0) };
  });
  // the node tree, depth first from the scene roots
  const nodes: SceneNode[] = [];
  let triangles = 0;
  const scene = json.scenes?.[json.scene ?? 0];
  const walk = (i: number, parent: string | null, world: { t: number[]; r: number[]; s: number[] }, depth: number) => {
    const nd = json.nodes?.[i];
    if (!nd || depth > 64) return;
    const t = nd.translation ?? [0, 0, 0], r = nd.rotation ?? [0, 0, 0, 1], sc = nd.scale ?? [1, 1, 1];
    // the world origin: parent's transform applied to the local translation (matrices: none are written by the exporter)
    const rt = qrot(world.r, [t[0] * world.s[0], t[1] * world.s[1], t[2] * world.s[2]]);
    const wt = [world.t[0] + rt[0], world.t[1] + rt[1], world.t[2] + rt[2]];
    const qr = world.r, wr = [ // world rotation = parent ∘ local
      qr[3] * r[0] + qr[0] * r[3] + qr[1] * r[2] - qr[2] * r[1], qr[3] * r[1] - qr[0] * r[2] + qr[1] * r[3] + qr[2] * r[0],
      qr[3] * r[2] + qr[0] * r[1] - qr[1] * r[0] + qr[2] * r[3], qr[3] * r[3] - qr[0] * r[0] - qr[1] * r[1] - qr[2] * r[2]];
    const inst = nd.extensions?.EXT_mesh_gpu_instancing;
    const ic = inst ? acc(inst.attributes?.TRANSLATION ?? inst.attributes?.ROTATION ?? inst.attributes?.SCALE)?.count ?? 0 : 0;
    const mesh = nd.mesh !== undefined ? meshes[nd.mesh] : null;
    if (mesh) triangles += mesh.triangles * (inst ? ic : 1);
    const name = nd.name ?? `node_${i}`;
    nodes.push({
      name, parent, kind: mesh ? (inst ? 'instances' : 'mesh') : 'empty', mesh: mesh?.name ?? null,
      translation: [t[0], t[1], t[2]], world: [wt[0], wt[1], wt[2]], instances: ic,
      extras: nd.extras && typeof nd.extras === 'object' ? Object.keys(nd.extras).filter((k) => k !== 'topotopo') : [],
    });
    for (const c of nd.children ?? []) walk(c, name, { t: wt, r: wr, s: [world.s[0] * sc[0], world.s[1] * sc[1], world.s[2] * sc[2]] }, depth + 1);
  };
  for (const i of scene?.nodes ?? []) walk(i, null, { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }, 0);
  return { nodes, meshes, materials, images, extensions: json.extensionsUsed ?? [], bytes: bytes.length, triangles };
}

/** The scene report as text. */
export function sceneReportText(r: SceneReport): string[] {
  const n = (x: number) => x.toLocaleString('en-US');
  const f = (x: number) => (Math.abs(x) < 5e-4 ? 0 : x).toFixed(3);
  const p3 = (v: number[]) => `(${v.map(f).join(', ')})`;
  const kb = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(2)} MB` : `${(b / 1024).toFixed(1)} KB`);
  const out = [`scene (the glb export, read back): ${r.nodes.length} nodes, ${r.meshes.length} meshes, ${n(r.triangles)} triangles, ${r.materials.length} materials, ${r.images.length} images; ${kb(r.bytes)}${r.extensions.length ? `; extensions ${r.extensions.join(', ')}` : ''}`];
  out.push('nodes (parent → child; positions in metres, Y up):');
  const depth = new Map<string, number>();
  for (const nd of r.nodes) {
    const d = nd.parent === null ? 0 : (depth.get(nd.parent) ?? 0) + 1;
    depth.set(nd.name, d);
    const mesh = nd.mesh ? r.meshes.find((m) => m.name === nd.mesh) : null;
    const what = nd.kind === 'empty' ? 'empty (socket)' : `${nd.kind === 'instances' ? `${n(nd.instances)} instances of ` : ''}mesh "${nd.mesh}": ${n(mesh?.triangles ?? 0)} tris, ${mesh?.primitives.length ?? 0} primitive(s)${mesh && mesh.primitives.some((p) => p.material) ? ` [${[...new Set(mesh.primitives.map((p) => p.material ?? 'no material'))].join(', ')}]` : ''}`;
    out.push(`  ${'  '.repeat(d)}${nd.name}: ${what}; at ${p3(nd.world)}${nd.parent !== null ? `, local ${p3(nd.translation)}` : ''}${nd.extras.length ? `; extras ${nd.extras.join(', ')}` : ''}`);
  }
  const attrs = [...new Set(r.meshes.flatMap((m) => m.primitives.flatMap((p) => p.attributes)))].sort();
  if (attrs.length) out.push(`vertex attributes: ${attrs.join(', ')}`);
  if (r.materials.length) {
    out.push('materials:');
    for (const m of r.materials) {
      const maps = Object.entries(m.maps).map(([k, v]) => `${k} ${v}`);
      out.push(`  ${m.name}: base colour factor (linear) (${m.baseColor.slice(0, 3).map((x) => x.toFixed(2)).join(', ')}${m.baseColor[3] !== undefined && m.baseColor[3] !== 1 ? `, alpha ${m.baseColor[3].toFixed(2)}` : ''}), metallic ${m.metallic.toFixed(2)}, roughness ${m.roughness.toFixed(2)}${m.alphaMode !== 'OPAQUE' ? `, ${m.alphaMode}` : ''}${m.doubleSided ? ', double-sided' : ''}${m.unlit ? ', unlit' : ''}${maps.length ? `; maps: ${maps.join(', ')}` : '; no maps'}`);
    }
  }
  if (r.images.length) out.push(`images: ${r.images.map((im) => `${im.name} ${im.width ? `${im.width}×${im.height} ` : ''}${im.mimeType.replace('image/', '')} ${kb(im.bytes)}`).join(', ')}`);
  return out;
}
