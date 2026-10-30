// Export sidecars: the JSON files an export writes beside its main file (io/files.ts). They are metadata of that
// export, not geometry to read:
//   source      <file>.source.json, and source.json inside a textures folder: how the export was made (io/source.ts)
//   heightmap   <name>.json beside a png16 / r16 heightmap: the height range, the Unreal import numbers, the source
//   meshes      <base>.meshes.json beside csv / points.json instance rows: Mesh → GLB, the source
//   landscape   landscape.json in an unreal_landscape folder: the import settings, the files, the source
// Each declares its "format" as its first key, so the first bytes of a file tell a sidecar from a geometry JSON. The
// viewer's Outputs and Inputs lists (and Session.listInputs, ArtifactStore.list) show a sidecar with the file it
// describes. Pure: callers pass names and the first bytes of the files.

export type SidecarRole = 'source' | 'heightmap' | 'meshes' | 'landscape';

/** The "format" each kind of sidecar declares. */
export const SIDECAR_FORMATS: Record<string, SidecarRole> = {
  'topotopo-export-source': 'source', png16: 'heightmap', r16: 'heightmap', 'topotopo-instance-meshes': 'meshes', 'topotopo-unreal-landscape': 'landscape',
};

/** What each kind of sidecar is called. */
export const SIDECAR_NAMES: Record<SidecarRole, string> = {
  source: 'export source', heightmap: 'heightmap sidecar', meshes: 'instance meshes sidecar', landscape: 'Unreal Landscape manifest',
};

/** What each kind of sidecar holds, in a few words. */
export const SIDECAR_TEXT: Record<SidecarRole, string> = {
  source: 'how it was made',
  heightmap: 'height range, Unreal import settings, how it was made',
  meshes: 'the instance meshes, how it was made',
  landscape: 'Landscape import settings, the files, how it was made',
};

/** Bytes of a JSON file worth reading to find its format: the key comes first in every sidecar. */
export const SIDECAR_HEAD_BYTES = 512;

/** The "format" a JSON document declares at its start ({"format": "png16", …}), or null. */
export function jsonFormat(head: string | Uint8Array): string | null {
  const s = typeof head === 'string' ? head : new TextDecoder().decode(head.subarray(0, SIDECAR_HEAD_BYTES));
  const m = /^\s*\{\s*"format"\s*:\s*"([^"\\]{1,64})"/.exec(s);
  return m ? m[1] : null;
}

/** Could this file be a sidecar (a .json)? Only those are worth reading. */
export const maybeSidecar = (file: string) => /\.json$/i.test(file);

export interface Sidecar {
  role: SidecarRole;
  /** the file (or, for a folder's source.json and landscape.json, the folder) it describes; null when it is not there */
  of: string | null;
}

const dirOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

/**
 * Is `file` (a "/"-separated path) a sidecar, and of what? `format` is the format its first bytes declare (jsonFormat),
 * `exists(p)` whether a file or folder `p` is there. A JSON that declares another format (a TopoTopo geometry, a points
 * stream) or none is not a sidecar: null.
 */
export function sidecarOf(file: string, format: string | null, exists: (p: string) => boolean): Sidecar | null {
  const role = format ? SIDECAR_FORMATS[format] : undefined;
  if (!role || !maybeSidecar(file)) return null;
  const pick = (...c: string[]) => c.find((p) => p && p !== file && exists(p)) ?? null;
  const lower = file.toLowerCase(), folder = dirOf(file);
  if (role === 'source') return { role, of: lower.endsWith('.source.json') ? pick(file.slice(0, -'.source.json'.length)) : pick(folder) };
  if (role === 'meshes') {
    const base = lower.endsWith('.meshes.json') ? file.slice(0, -'.meshes.json'.length) : file.slice(0, -'.json'.length);
    return { role, of: pick(base + '.csv', base + '.points.json') };
  }
  // the heightmap's own file: <name>.png for png16, <name>.r16 for r16 (io/heightmap.ts heightmapPaths)
  if (role === 'heightmap') return { role, of: pick(file.slice(0, -'.json'.length) + (format === 'r16' ? '.r16' : '.png')) };
  return { role, of: pick(folder) };
}
