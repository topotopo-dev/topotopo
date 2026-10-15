// Unreal Landscape bundle: everything Unreal needs to rebuild a topotopo terrain scene, in one directory.
//
//   landscape.json           manifest: the exact Landscape import settings (section size, sections per component,
//                            component count, scale, location for the New Landscape panel and for the actor), the
//                            files below and the manual import steps
//   heightmap.png / .json    16-bit heightmap and its sidecar (io/heightmap.ts; the manifest repeats its numbers)
//   layers/<layer>.png       every other heightfield layer (or only `layers` when given) as an 8-bit weight map (0..1 layers as they are, other
//                            ranges normalised, the range recorded in the manifest)
//   objects.glb              the geometry's meshes and packed instances (EXT_mesh_gpu_instancing), when it has prims
//   objects_expanded.glb     the same with the instances as real geometry (for importers without the extension;
//                            written up to EXPANDED_TRIANGLE_LIMIT triangles)
//   objects_static.glb       only the ordinary (non-instanced) meshes, at any instance count: what the Unreal plugin
//                            places as level geometry next to the instance stream (buildings, roads)
//   instances.csv           the instance stream as Unreal PCG rows (one row per packed instance, Mesh column)
//   instances.meshes.json    Mesh → meshes/<Mesh>.glb, one GLB per packed source (metres, Y-up, at the origin)
//   tiles/<x>_<y>/          opt-in tile_size (quads): overlapping heightmaps, weight layers and instance CSVs;
//                            version 2 adds tiles and tile_grid; root source files and shared meshes are retained
//
// Unreal's import picks the component layout with FLandscapeImportHelper's rule (unrealComponents below): the
// largest section size (7, 15, 31, 63, 127, 255 quads) and sections per component (2, then 1) that divide the
// heightmap exactly with at most 32 components per side. The New Landscape panel centres the landscape on the
// location it is given, so the manifest gives that centre (new_landscape_location_cm) as well as the corner where
// the actor ends up (actor_location_cm, = the heightmap sidecar's location_cm).
import { Geometry } from '../core/geometry.ts';
import { Heightfield, heightfieldsOf, layerStats } from '../core/heightfield.ts';
import { encodeGreyPNG, heightmapExport } from './heightmap.ts';
import type { HeightmapOptions } from './heightmap.ts';
import { exportGLB } from './gltf.ts';
import { exportCSV, instanceMeshesJSON } from './points.ts';
import { safeName } from './common.ts';
import type { ExportOptions } from './common.ts';
import { expandedTriangles, flattenSource, stripPacked } from '../core/packed.ts';
import { packedPrims, packedSourceNames } from './common.ts';

export interface BundleFile { path: string; bytes: Uint8Array }

/** objects_expanded.glb is written while the expanded instances stay below this many triangles. */
export const EXPANDED_TRIANGLE_LIMIT = 2_000_000;

const SECTION_SIZES = [7, 15, 31, 63, 127, 255];
const SECTIONS_PER_COMPONENT = [1, 2];

export interface LandscapeComponents {
  /** quads per section */
  sectionSize: number;
  /** sections per component side (1 = 1×1, 2 = 2×2) */
  sectionsPerComponent: number;
  /** components along X and Y */
  components: [number, number];
  /** vertices Unreal creates per side: components × sections × section size + 1 */
  resolution: [number, number];
  /** the heightmap fits exactly (otherwise Unreal pads or crops it) */
  exact: boolean;
}

/**
 * The component layout Unreal's landscape import chooses for a W × H heightmap (FLandscapeImportHelper::
 * ChooseBestComponentSizeForImport): an exact fit with the largest section size and sections per component and at
 * most 32 components per side; otherwise the smallest section size ≥ 63 with one section that covers the map.
 */
export function unrealComponents(w: number, h: number): LandscapeComponents {
  for (let si = SECTION_SIZES.length - 1; si >= 0; si--) {
    for (let ni = SECTIONS_PER_COMPONENT.length - 1; ni >= 0; ni--) {
      const ss = SECTION_SIZES[si], ns = SECTIONS_PER_COMPONENT[ni], q = ss * ns;
      if ((w - 1) % q === 0 && (w - 1) / q <= 32 && (h - 1) % q === 0 && (h - 1) / q <= 32 && w > 1 && h > 1) {
        const c: [number, number] = [(w - 1) / q, (h - 1) / q];
        return { sectionSize: ss, sectionsPerComponent: ns, components: c, resolution: [c[0] * q + 1, c[1] * q + 1], exact: true };
      }
    }
  }
  for (const ss of SECTION_SIZES) {
    if (ss < 63) continue;
    const c: [number, number] = [Math.max(1, Math.ceil((w - 1) / ss)), Math.max(1, Math.ceil((h - 1) / ss))];
    if (c[0] <= 32 && c[1] <= 32) return { sectionSize: ss, sectionsPerComponent: 1, components: c, resolution: [c[0] * ss + 1, c[1] * ss + 1], exact: false };
  }
  const c: [number, number] = [Math.ceil((w - 1) / 255), Math.ceil((h - 1) / 255)];
  return { sectionSize: 255, sectionsPerComponent: 1, components: c, resolution: [c[0] * 255 + 1, c[1] * 255 + 1], exact: false };
}

/** Manual import steps for a bundle (also shown by help topic "export"). */
export const LANDSCAPE_IMPORT_STEPS = [
  'Unreal 5.8: Landscape mode (Shift+2) > Manage > New > Import from File.',
  'Heightmap File: heightmap.png. Check that Unreal reports the resolution in landscape.json (heightmap.resolution).',
  'Section Size, Sections Per Component and Number of Components: as in landscape.json (landscape.*); Overall Resolution must equal landscape.overall_resolution.',
  'Location: landscape.new_landscape_location_cm (the panel centres the landscape on it; the actor ends at actor_location_cm). Rotation 0, 0, 0. Scale: landscape.scale.',
  'Layers: give the landscape material one layer per layers[] entry (Landscape Layer Blend), then in the import panel (or later: Paint > Target Layers > right-click > Import) assign layers/<name>.png to each.',
  'Click Import. Height check: world Z (cm) = location.z + (value - 32768) * scale.z / 128, i.e. height_min..height_max metres x 100.',
  'Objects: import objects.glb (meshes + EXT_mesh_gpu_instancing instances) with the Interchange glTF importer at location 0; Unreal maps glTF Y-up metres to Z-up centimetres (X = x, Y = z, Z = y), matching the landscape. If the importer rejects EXT_mesh_gpu_instancing, import objects_expanded.glb (the instances as real meshes, one per source name).',
  'Instances for PCG: import meshes/*.glb as static meshes, read instances.csv (Position/Rotation/Scale in cm and degrees, Mesh = the static mesh name) with the TopoTopo PCG loader or a DataTable (pcg_struct export), and spawn by Mesh.',
];

const r = (x: number, d = 4) => +x.toFixed(d);

/**
 * The files of an Unreal Landscape bundle (paths relative to the bundle directory), its manifest and a summary.
 * The geometry needs a heightfield; packed instances and meshes in the same geometry go into objects.glb and the
 * instance stream.
 */
export async function unrealLandscapeBundle(g: Geometry, o: ExportOptions & HeightmapOptions & { manifestName?: string; tile_size?: number } = {}): Promise<{ files: BundleFile[]; manifest: Record<string, any>; summary: string }> {
  const tileSize = o.tile_size ?? 0;
  if (!Number.isSafeInteger(tileSize) || tileSize < 0 || tileSize > 8160) throw new Error('export unreal_landscape: tile_size must be an integer from 0 to 8160 quads');
  const tileComp = tileSize ? unrealComponents(tileSize + 1, tileSize + 1) : null;
  if (tileComp && !tileComp.exact) throw new Error(`export unreal_landscape: tile_size ${tileSize} quads does not fit Unreal sections exactly (use e.g. 126, 252, 1008 or 2016)`);
  const hfs = heightfieldsOf(g);
  if (!hfs.length) throw new Error('export unreal_landscape: the geometry has no heightfield (merge the heightfield with the instances/meshes you want in the bundle)');
  const hm = heightmapExport(g, 'png16', { layer: o.layer, heightMin: o.heightMin, heightMax: o.heightMax, heightfield: o.heightfield, deflate: o.deflate });
  const hf = hfs[o.heightfield ?? 0];
  const files: BundleFile[] = [
    { path: 'heightmap.png', bytes: hm.files[0].bytes },
    { path: 'heightmap.json', bytes: hm.files[1].bytes },
  ];
  const info = hm.info as Record<string, any>;
  const ue = info.unreal as Record<string, any>;
  const comp = unrealComponents(hf.width, hf.height);
  const quads = [comp.resolution[0] - 1, comp.resolution[1] - 1];
  const scale = ue.scale as number[], corner = ue.location_cm as number[];
  const centre = [r(corner[0] + (quads[0] / 2) * scale[0]), r(corner[1] + (quads[1] / 2) * scale[1]), corner[2]];
  // weight layers
  const heightLayer = o.layer || 'height';
  const layers: Record<string, any>[] = [];
  const usedNames = new Set<string>();
  const weightBytes = new Map<string, Uint8Array>();
  if (o.layers) for (const want of o.layers) if (!hf.layers.has(want)) throw new Error(`export unreal_landscape: layer "${want}" not found (layers: ${[...hf.layers.keys()].join(', ')})`);
  for (const [name, a] of hf.layers) {
    if (name === heightLayer) continue;
    if (o.layers && !o.layers.includes(name)) continue; // --layers a,b: only these weight maps
    const st = layerStats(a);
    if (!st) continue;
    const unit = st.min >= 0 && st.max <= 1;
    const lo = unit ? 0 : st.min, span = unit ? 1 : st.max - st.min;
    const v = new Uint8Array(a.length);
    if (span > 0) for (let i = 0; i < a.length; i++) { const x = (a[i] - lo) / span; v[i] = !(x > 0) ? 0 : x >= 1 ? 255 : Math.round(x * 255); }
    let file = safeName(name) || 'layer', k = 1;
    while (usedNames.has(file)) file = `${safeName(name)}_${k++}`;
    usedNames.add(file);
    files.push({ path: `layers/${file}.png`, bytes: encodeGreyPNG(v, hf.width, hf.height, 8, o.deflate) });
    if (tileSize) weightBytes.set(name, v);
    layers.push({
      name, file: `layers/${file}.png`, min: r(st.min, 6), max: r(st.max, 6),
      encoding: unit ? 'value = round(clamp(layer, 0, 1) * 255)' : `value = round((layer - ${r(lo, 6)}) / ${r(span, 6)} * 255) (normalised: the layer is outside 0..1)`,
    });
  }
  // meshes and instances of the same geometry
  let objects: string | null = null, expanded: string | null = null, statics: string | null = null, instances: Record<string, any> | null = null;
  // Unreal's default glTF materials ignore vertex colours: the material colour must be the factor
  const glbOpts: ExportOptions = { materials: o.materials, readFile: o.readFile, warn: o.warn, custom: o.custom, materialColorWins: true };
  if (g.numPrims > 0) {
    files.push({ path: 'objects.glb', bytes: await exportGLB(g, glbOpts) });
    objects = 'objects.glb';
    if (g.hasPacked() && expandedTriangles(g) <= EXPANDED_TRIANGLE_LIMIT) {
      files.push({ path: 'objects_expanded.glb', bytes: await exportGLB(g, { ...glbOpts, instancing: 'expand' }) });
      expanded = 'objects_expanded.glb';
    }
    // the ordinary meshes alone (buildings, roads): small at any instance count, so an importer can place them as
    // level geometry next to the instance stream even when objects_expanded.glb is skipped for size
    const plain = stripPacked(g);
    if (plain.numPrims > 0) {
      files.push({ path: 'objects_static.glb', bytes: await exportGLB(plain, glbOpts) });
      statics = 'objects_static.glb';
    }
  }
  if (g.hasPacked()) {
    files.push({ path: 'instances.csv', bytes: new TextEncoder().encode(exportCSV(g, { pcg: true, scale: 100, warn: (m) => { if (!/other point/.test(m)) o.warn?.(m); } })) });
    files.push({ path: 'instances.meshes.json', bytes: new TextEncoder().encode(instanceMeshesJSON(g, { meshDir: 'meshes', stream: 'instances.csv', scene: objects ?? undefined })) });
    const names = packedSourceNames(g);
    for (let s = 0; s < g.packedSources.length; s++) files.push({ path: `meshes/${names[s]}.glb`, bytes: await exportGLB(flattenSource(g.packedSources[s]), glbOpts) });
    instances = { count: g.numPacked, csv: 'instances.csv', meshes: 'instances.meshes.json', mesh_dir: 'meshes', sources: names };
  }
  const manifest: Record<string, any> = {
    format: 'topotopo-unreal-landscape', version: 1,
    heightfield: hf.name,
    heightmap: {
      file: 'heightmap.png', sidecar: 'heightmap.json', layer: info.layer, resolution: info.resolution, cell_size_m: info.cell_size,
      height_min_m: info.height_min, height_max_m: info.height_max, encoding: info.encoding,
    },
    landscape: {
      section_size_quads: comp.sectionSize,
      sections_per_component: comp.sectionsPerComponent,
      sections_per_component_label: `${comp.sectionsPerComponent}x${comp.sectionsPerComponent} Sections`,
      components: comp.components,
      overall_resolution: comp.resolution,
      exact_fit: comp.exact,
      scale,
      rotation: [0, 0, 0],
      new_landscape_location_cm: centre,
      actor_location_cm: corner,
      z_formula: ue.world_z_formula,
      ...(comp.exact ? {} : { note: `the heightmap (${hf.width}×${hf.height}) does not fit Unreal's component grid exactly; Unreal pads or crops it to ${comp.resolution.join('×')}. Resample to 127, 253, 505, 1009, 2017 or 4033 samples per side (heightfield_resample) for an exact fit.` }),
    },
    axes: ue.axes,
    layers,
    objects,
    objects_expanded: expanded,
    objects_static: statics,
    instances,
    manual_import: LANDSCAPE_IMPORT_STEPS,
  };
  if (tileComp) addTiles(g, hf, tileSize, tileComp, manifest, files, weightBytes, o);
  const name = o.manifestName || 'landscape.json';
  files.unshift({ path: name, bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n') });
  const layoutSummary = tileComp
    ? `tiled ${manifest.tile_grid.grid.join('×')}, ${tileSize} quads/tile (${tileComp.sectionSize} quads/section, ${tileComp.sectionsPerComponent}×${tileComp.sectionsPerComponent} sections, ${tileComp.components.join('×')} components/tile), padded ${manifest.tile_grid.padded_resolution.join('×')} (right ${manifest.tile_grid.padding.right}, bottom ${manifest.tile_grid.padding.bottom}), shared height range`
    : `heightmap ${hf.width}×${hf.height} (${comp.exact ? '' : 'not an exact fit, '}${comp.sectionSize} quads/section, ${comp.sectionsPerComponent}×${comp.sectionsPerComponent} sections, ${comp.components.join('×')} components)`;
  const summary = `Unreal Landscape bundle: ${layoutSummary}, scale (${scale.join(', ')}), ` +
    `${layers.length} layer(s)${objects ? ', objects.glb' : ''}${instances ? `, ${instances.count} instances of ${instances.sources.length} mesh(es) (instances.csv + meshes/)` : ''}`;
  return { files, manifest, summary };
}

/** Copy inclusive tile samples, repeating the outermost source sample in the padded area. */
function tileSamples(src: ArrayLike<number>, hf: Heightfield, q: number, x: number, y: number, dst: Float32Array | Uint8Array): void {
  const side = q + 1;
  for (let j = 0; j < side; j++) {
    const row = Math.min(y * q + j, hf.height - 1) * hf.width;
    for (let i = 0; i < side; i++) dst[j * side + i] = src[row + Math.min(x * q + i, hf.width - 1)];
  }
}

/** Keep CSV records verbatim, including row IDs, seeds, quoting and embedded newlines in attributes. */
function csvRecords(csv: string): string[] {
  const records: string[] = [];
  let quoted = false, start = 0;
  for (let i = 0; i < csv.length; i++) {
    if (csv[i] === '"') quoted = !quoted;
    else if (csv[i] === '\n' && !quoted) { records.push(csv.slice(start, i)); start = i + 1; }
  }
  if (start < csv.length) records.push(csv.slice(start));
  return records;
}

function addTiles(g: Geometry, hf: Heightfield, q: number, comp: LandscapeComponents, manifest: Record<string, any>, files: BundleFile[], weightBytes: Map<string, Uint8Array>, o: HeightmapOptions): void {
  const nx = Math.ceil((hf.width - 1) / q), ny = Math.ceil((hf.height - 1) / q);
  const width = nx * q + 1, height = ny * q + 1, side = q + 1;
  const scale = manifest.landscape.scale as number[], corner = manifest.landscape.actor_location_cm as number[];
  manifest.version = 2;
  manifest.tile_grid = {
    tile_size_quads: q, grid: [nx, ny], source_resolution: [hf.width, hf.height], padded_resolution: [width, height],
    padding: { right: width - hf.width, bottom: height - hf.height, mode: 'edge' },
    overlap_samples: 1, sample_ranges: 'inclusive; column = X, row = Z (Unreal Y)',
    height_range: 'shared: heightmap.height_min_m and heightmap.height_max_m for every tile',
    instance_assignment: 'anchor position; half-open tile bounds, seam belongs to positive tile, outer boundary and out-of-bounds anchors clamped to nearest tile; world-space CSV rows unchanged',
    tile_components: comp.components,
  };
  manifest.landscape = {
    ...manifest.landscape,
    section_size_quads: comp.sectionSize, sections_per_component: comp.sectionsPerComponent,
    sections_per_component_label: `${comp.sectionsPerComponent}x${comp.sectionsPerComponent} Sections`,
    components: [nx * comp.components[0], ny * comp.components[1]], overall_resolution: [width, height], exact_fit: true,
    new_landscape_location_cm: [r(corner[0] + (width - 1) * scale[0] / 2), r(corner[1] + (height - 1) * scale[1] / 2), corner[2]],
  };
  delete manifest.landscape.note;
  const buckets: string[][] = Array.from({ length: nx * ny }, () => []);
  let header = '';
  if (manifest.instances) {
    const records = csvRecords(new TextDecoder().decode(files.find((f) => f.path === 'instances.csv')!.bytes));
    header = records[0];
    const prims = packedPrims(g);
    for (let k = 0; k < prims.length; k++) {
      const p = g.vertexPoint[g.primStart[prims[k]]] * 3;
      if (!Number.isFinite(g.P[p]) || !Number.isFinite(g.P[p + 2])) throw new Error('export unreal_landscape: tiled instance anchors must have finite X/Z positions');
      const x = Math.max(0, Math.min(nx - 1, Math.floor(hf.fx(g.P[p]) / q)));
      const y = Math.max(0, Math.min(ny - 1, Math.floor(hf.fz(g.P[p + 2]) / q)));
      buckets[y * nx + x].push(records[k + 1]);
    }
  }
  const tiles: Record<string, any>[] = [];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const dir = `tiles/${x}_${y}`;
    const heightValues = new Float32Array(side * side);
    tileSamples(hf.layer(manifest.heightmap.layer)!, hf, q, x, y, heightValues);
    const tileField = new Heightfield(side, side, hf.cellSize, [hf.x(x * q), hf.z(y * q)], new Map([[manifest.heightmap.layer, heightValues]]), hf.name);
    const tileGeo = new Geometry();
    tileGeo.volumes.push(tileField);
    const hm = heightmapExport(tileGeo, 'png16', { layer: manifest.heightmap.layer, heightMin: manifest.heightmap.height_min_m, heightMax: manifest.heightmap.height_max_m, deflate: o.deflate });
    files.push({ path: `${dir}/heightmap.png`, bytes: hm.files[0].bytes }, { path: `${dir}/heightmap.json`, bytes: hm.files[1].bytes });
    const layers = manifest.layers.map((layer: Record<string, any>) => {
      const values = new Uint8Array(side * side);
      tileSamples(weightBytes.get(layer.name)!, hf, q, x, y, values);
      const file = `${dir}/${layer.file}`;
      files.push({ path: file, bytes: encodeGreyPNG(values, side, side, 8, o.deflate) });
      return { ...layer, file };
    });
    let instances: Record<string, any> | null = null;
    if (manifest.instances) {
      const rows = buckets[y * nx + x], csv = `${dir}/instances.csv`;
      files.push({ path: csv, bytes: new TextEncoder().encode([header, ...rows].join('\n') + '\n') });
      instances = { csv, count: rows.length, meshes: manifest.instances.meshes };
    }
    tiles.push({
      grid_position: [x, y], sample_min: [x * q, y * q], sample_max: [(x + 1) * q, (y + 1) * q],
      world_offset_cm: [x * q * scale[0], y * q * scale[1], 0],
      heightmap: { ...manifest.heightmap, file: `${dir}/heightmap.png`, sidecar: `${dir}/heightmap.json`, resolution: [side, side] },
      layers, instances,
    });
  }
  manifest.tiles = tiles;
  manifest.manual_import = [
    'TopoTopo.ImportScene "<this directory>" /Game/TopoTopo/MyTiledSet landscape=1 imports tiles with their shared height range, layers and material; World Partition levels get one streaming proxy per tile, plain levels one Landscape with all tile components.',
    'All tile paths are relative to this bundle directory. Tile sample_min/sample_max are inclusive and adjacent tiles share one sample. Padding repeats the source right/bottom edge without changing sample spacing or the origin.',
    'The root heightmap/layers retain the source resolution for inspection; tiled import uses tiles[]. The root instances.csv and mesh sidecar are shared; each tile CSV contains unchanged world-space rows assigned by anchor position.',
    'Per tile: use landscape.section_size_quads and sections_per_component, and tile_grid.tile_components. Recommended: 253 samples = 63 / 2x2 / 2x2 components; 1009 = 63 / 2x2 / 8x8; 2017 = 63 / 2x2 / 16x16 (127-quad sections do not fit those resolutions).',
  ];
}
