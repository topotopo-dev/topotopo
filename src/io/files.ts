// Multi-file export: the files one export writes, as (path, bytes) pairs, without touching a file system (the CLI and
// the MCP server write them). Most formats are one file; these are several:
//   png16 / r16      heightmap + .json sidecar;  mask_png: one PNG per layer (io/heightmap.ts)
//   csv / pointsjson of packed instances (instance rows): the stream + <base>.meshes.json + <base>_meshes/<Mesh>.glb
//                    (one GLB per packed source; meshes: false leaves the GLBs out)
//   unreal_landscape a directory (the path, or the directory of a .json path naming the manifest): io/unreal.ts
import type { Geometry } from '../core/geometry.ts';
import { exportGeometryAsync } from './export.ts';
import type { ExportFormat } from './export.ts';
import { HEIGHTMAP_FORMATS, heightmapExport, heightmapPaths } from './heightmap.ts';
import type { HeightmapFormat, HeightmapOptions } from './heightmap.ts';
import { instanceMeshesJSON, instanceRows } from './points.ts';
import { exportGLB } from './gltf.ts';
import { flattenSource } from '../core/packed.ts';
import { baseOf, dirOf, joinPath, packedSourceNames } from './common.ts';
import type { ExportOptions } from './common.ts';
import { unrealLandscapeBundle } from './unreal.ts';

export interface ExportFile { path: string; bytes: Uint8Array }
export type FileExportOptions = ExportOptions & HeightmapOptions & {
  /** instance streams: also write one GLB per packed source next to the stream (default true) */
  meshes?: boolean;
};

/** Path without its extension (".points.json" counts as one). */
export function stripExtension(p: string): string {
  if (/\.points\.json$/i.test(p)) return p.slice(0, -'.points.json'.length);
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const dot = p.lastIndexOf('.');
  return dot > cut ? p.slice(0, dot) : p;
}

/** Every file an export of `format` to `path` writes, plus a one-line summary. */
export async function exportFilesAsync(g: Geometry, format: ExportFormat | 'unreal_landscape', path: string, o: FileExportOptions = {}): Promise<{ files: ExportFile[]; summary: string }> {
  if (HEIGHTMAP_FORMATS.includes(format as HeightmapFormat)) {
    const res = heightmapExport(g, format as HeightmapFormat, o);
    const paths = heightmapPaths(path, res.files);
    return { files: res.files.map((f, i) => ({ path: paths[i], bytes: f.bytes })), summary: res.summary };
  }
  if (format === 'unreal_landscape') {
    const isManifest = /\.json$/i.test(path);
    const dir = isManifest ? dirOf(path) : path.replace(/[\\/]+$/, '');
    const res = await unrealLandscapeBundle(g, { ...o, manifestName: isManifest ? baseOf(path) : undefined });
    return { files: res.files.map((f) => ({ path: joinPath(dir, f.path), bytes: f.bytes })), summary: res.summary };
  }
  const bytes = await exportGeometryAsync(g, format, o);
  const files: ExportFile[] = [{ path, bytes }];
  if ((format === 'csv' || format === 'pointsjson') && instanceRows(g, o)) {
    const base = stripExtension(path);
    const meshDir = baseOf(base) + '_meshes';
    files.push({ path: base + '.meshes.json', bytes: new TextEncoder().encode(instanceMeshesJSON(g, { meshDir, stream: baseOf(path) })) });
    if (o.meshes !== false) {
      const names = packedSourceNames(g);
      for (let s = 0; s < g.packedSources.length; s++) {
        files.push({ path: joinPath(dirOf(base), meshDir, names[s] + '.glb'), bytes: await exportGLB(flattenSource(g.packedSources[s]), { materials: o.materials, readFile: o.readFile, warn: o.warn, custom: o.custom }) });
      }
    }
    return { files, summary: `${g.numPacked} instance rows (Mesh column) of ${g.packedSources.length} source mesh(es); sidecar ${baseOf(base)}.meshes.json${o.meshes !== false ? ` + ${meshDir}/*.glb` : ''}` };
  }
  return { files, summary: `${format}, ${(bytes.byteLength / 1024).toFixed(1)} KB` };
}
