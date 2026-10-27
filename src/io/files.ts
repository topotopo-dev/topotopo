// Multi-file export: the files one export writes, as (path, bytes) pairs, without touching a file system (the CLI and
// the MCP server write them). Most formats are one file; these are several:
//   png16 / r16      heightmap + .json sidecar;  mask_png: one PNG per layer (io/heightmap.ts)
//   csv / pointsjson of packed instances (instance rows): the stream + <base>.meshes.json + <base>_meshes/<Mesh>.glb
//                    (one GLB per packed source; meshes: false leaves the GLBs out)
//   unreal_landscape a directory (the path, or the directory of a .json path naming the manifest): io/unreal.ts
//   usda             + <name>_textures/<image>.png for "image:<name>" material textures (io/textures.ts)
//   textures         a directory with one PNG per image volume (io/textures.ts)
// With options.source (how the export was made, io/source.ts) the sidecar or manifest above records it: the heightmap
// .json, <base>.meshes.json, the bundle's landscape.json. Every other export gets <path>.source.json next to it (the
// textures folder: source.json inside it), and glb / gltf also carry it in asset.extras.source.
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
import { texturesExport, usdTextureFiles } from './textures.ts';
import { SOURCE_SUFFIX, sourceManifestBytes } from './source.ts';

export interface ExportFile { path: string; bytes: Uint8Array }
export type FileExportOptions = ExportOptions & HeightmapOptions & {
  /** instance streams: also write one GLB per packed source next to the stream (default true) */
  meshes?: boolean;
  /** unreal_landscape: quads per tile; 0 (default) keeps the single-landscape bundle. */
  tile_size?: number;
};

export interface ExportFiles {
  files: ExportFile[];
  summary: string;
  /** with options.source: the file that records it (a sidecar, the bundle manifest, or a standalone manifest) */
  sourceFile?: string;
  /** with options.source: the standalone <path>.source.json written for it (also sourceFile), when there is one */
  sourceManifest?: string;
}

/** Path without its extension (".points.json" counts as one). */
export function stripExtension(p: string): string {
  if (/\.points\.json$/i.test(p)) return p.slice(0, -'.points.json'.length);
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const dot = p.lastIndexOf('.');
  return dot > cut ? p.slice(0, dot) : p;
}

/** The folder a textures export writes into: the path, or the directory of a .png path. */
const texturesDir = (path: string) => (/\.png$/i.test(path) ? dirOf(path) : path.replace(/[\\/]+$/, ''));

/** Where the standalone source manifest of an export to `path` goes: <path>.source.json, or source.json inside a textures folder. */
export function sourceManifestPath(format: string, path: string): string {
  return format === 'textures' ? joinPath(texturesDir(path), 'source.json') : path.replace(/[\\/]+$/, '') + SOURCE_SUFFIX;
}

/** Formats whose one file carries the source block itself (asset.extras.source): the file alone tells how it was made. */
export const SOURCE_INSIDE: readonly ExportFormat[] = ['glb', 'gltf'];

/**
 * What an export of each format writes (the files of formatFiles below, and the record exportFilesAsync adds), in a
 * line for a person choosing a format: the viewer's export and download menus. `instances`: the geometry holds packed
 * instances, which csv and points.json write as instance rows and obj, ply and stl expand into geometry; `images`: it
 * carries images (textures), which usda writes as PNGs beside the stage.
 */
export function formatWrites(format: ExportFormat, o: { instances?: boolean; images?: boolean } = {}): string {
  const rows = o.instances ? ', one row per instance + .meshes.json with how it was made + one GLB per source mesh' : '';
  const expanded = o.instances ? ' (instances expanded)' : '';
  const record = ' + .source.json with how it was made';
  const lines: Record<ExportFormat, string> = {
    glb: 'binary glTF with its textures and how it was made inside (+ .source.json in exports/)',
    gltf: 'glTF JSON with its buffers, textures and how it was made inside (+ .source.json in exports/)',
    usda: `USD stage${o.instances ? ' (instances as a PointInstancer)' : ''}${o.images ? ' + its textures as PNGs' : ''}${record}`,
    obj: `OBJ with vertex colours, no materials${expanded}${record}`,
    geo: `Houdini .geo with every attribute and group${record}`,
    ply: `binary PLY with the point attributes${expanded}${record}`,
    stl: `binary STL triangles, no colours${expanded}${record}`,
    json: `TopoTopo JSON, everything lossless${record}`,
    csv: rows ? `CSV for Unreal PCG${rows}` : `CSV, one row per point${record}`,
    pointsjson: rows ? `points JSON${rows}` : `points JSON with every point attribute${record}`,
    png16: '16-bit PNG + JSON sidecar with the height range and how it was made',
    r16: 'RAW 16-bit heightmap + JSON sidecar with the height range and how it was made',
    mask_png: `8-bit PNG of the mask layer (an Unreal weight layer)${record}`,
    unreal_landscape: 'a folder: heightmap, weight layers, meshes and instances + landscape.json with the import settings and how it was made',
    textures: 'a folder of PNGs, one per image + source.json with how it was made',
  };
  return lines[format];
}

/** Every file an export of `format` to `path` writes, plus a one-line summary. */
export async function exportFilesAsync(g: Geometry, format: ExportFormat | 'unreal_landscape', path: string, o: FileExportOptions = {}): Promise<ExportFiles> {
  const res = await formatFiles(g, format, path, o);
  if (!o.source) return { files: res.files, summary: res.summary };
  if (res.sourceFile) return res;
  const at = sourceManifestPath(format, path);
  return { files: [...res.files, { path: at, bytes: sourceManifestBytes(o.source, at, res.files.map((f) => f.path)) }], summary: res.summary, sourceFile: at, sourceManifest: at };
}

/** The files of the format; sourceFile names the sidecar that took options.source, if one did. */
async function formatFiles(g: Geometry, format: ExportFormat | 'unreal_landscape', path: string, o: FileExportOptions): Promise<ExportFiles> {
  if (format === 'textures') {
    // a directory (or the directory of a .png path) with one PNG per image
    return texturesExport(g, texturesDir(path), { deflate: o.deflate, layers: o.layers });
  }
  const nImages = g.volumes.filter((v) => v.kind === 'image').length;
  if (nImages && !['glb', 'gltf', 'usda', 'json'].includes(format)) o.warn?.(`${format}: ${nImages} image(s) not written (${format} has no images; glb/gltf embed the textures materials use, usda writes them next to the file, format "textures" writes every image as PNG)`);
  if (format === 'usda') {
    // image textures as PNGs in <name>_textures/ next to the .usda, referenced relative to it
    const tex = usdTextureFiles(g, path, o.deflate, o.warn);
    const map = o.texturePath;
    const bytes = await exportGeometryAsync(g, format, { ...o, texturePath: (t) => tex.assetPath.get(t) ?? (t.startsWith('image:') ? t : map ? map(t) : t) });
    return { files: [{ path, bytes }, ...tex.files], summary: `usda, ${(bytes.byteLength / 1024).toFixed(1)} KB${tex.files.length ? ` + ${tex.files.length} texture PNG(s)` : ''}` };
  }
  if (HEIGHTMAP_FORMATS.includes(format as HeightmapFormat)) {
    const res = heightmapExport(g, format as HeightmapFormat, o);
    const paths = heightmapPaths(path, res.files);
    const sidecar = res.files.findIndex((f) => f.kind === 'sidecar');
    return { files: res.files.map((f, i) => ({ path: paths[i], bytes: f.bytes })), summary: res.summary, sourceFile: o.source && sidecar >= 0 ? paths[sidecar] : undefined };
  }
  if (format === 'unreal_landscape') {
    const isManifest = /\.json$/i.test(path);
    const dir = isManifest ? dirOf(path) : path.replace(/[\\/]+$/, '');
    const manifestName = isManifest ? baseOf(path) : undefined;
    const res = await unrealLandscapeBundle(g, { ...o, manifestName });
    return { files: res.files.map((f) => ({ path: joinPath(dir, f.path), bytes: f.bytes })), summary: res.summary, sourceFile: o.source ? joinPath(dir, manifestName || 'landscape.json') : undefined };
  }
  const bytes = await exportGeometryAsync(g, format, o);
  const files: ExportFile[] = [{ path, bytes }];
  if ((format === 'csv' || format === 'pointsjson') && instanceRows(g, o)) {
    const base = stripExtension(path);
    const meshDir = baseOf(base) + '_meshes';
    files.push({ path: base + '.meshes.json', bytes: new TextEncoder().encode(instanceMeshesJSON(g, { meshDir, stream: baseOf(path), source: o.source })) });
    if (o.meshes !== false) {
      const names = packedSourceNames(g);
      for (let s = 0; s < g.packedSources.length; s++) {
        files.push({ path: joinPath(dirOf(base), meshDir, names[s] + '.glb'), bytes: await exportGLB(flattenSource(g.packedSources[s]), { materials: o.materials, readFile: o.readFile, warn: o.warn, custom: o.custom }) });
      }
    }
    return {
      files, summary: `${g.numPacked} instance rows (Mesh column) of ${g.packedSources.length} source mesh(es); sidecar ${baseOf(base)}.meshes.json${o.meshes !== false ? ` + ${meshDir}/*.glb` : ''}`,
      sourceFile: o.source ? base + '.meshes.json' : undefined,
    };
  }
  return { files, summary: `${format}, ${(bytes.byteLength / 1024).toFixed(1)} KB` };
}
