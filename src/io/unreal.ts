// Unreal Landscape bundle: everything Unreal needs to rebuild a polyforge terrain scene, in one directory.
//
//   landscape.json           manifest: the exact Landscape import settings (section size, sections per component,
//                            component count, scale, location for the New Landscape panel and for the actor), the
//                            files below and the manual import steps
//   heightmap.png / .json    16-bit heightmap and its sidecar (io/heightmap.ts; the manifest repeats its numbers)
//   layers/<layer>.png       every other heightfield layer as an 8-bit weight map (0..1 layers as they are, other
//                            ranges normalised, the range recorded in the manifest)
//   objects.glb              the geometry's meshes and packed instances (EXT_mesh_gpu_instancing), when it has prims
//   instances.csv            the instance stream as Unreal PCG rows (one row per packed instance, Mesh column)
//   instances.meshes.json    Mesh → meshes/<Mesh>.glb, one GLB per packed source (metres, Y-up, at the origin)
//
// Unreal's import picks the component layout with FLandscapeImportHelper's rule (unrealComponents below): the
// largest section size (7, 15, 31, 63, 127, 255 quads) and sections per component (2, then 1) that divide the
// heightmap exactly with at most 32 components per side. The New Landscape panel centres the landscape on the
// location it is given, so the manifest gives that centre (new_landscape_location_cm) as well as the corner where
// the actor ends up (actor_location_cm, = the heightmap sidecar's location_cm).
import type { Geometry } from '../core/geometry.ts';
import { heightfieldsOf, layerStats } from '../core/heightfield.ts';
import { encodeGreyPNG, heightmapExport } from './heightmap.ts';
import type { HeightmapOptions } from './heightmap.ts';
import { exportGLB } from './gltf.ts';
import { exportCSV, instanceMeshesJSON } from './points.ts';
import { safeName } from './common.ts';
import type { ExportOptions } from './common.ts';
import { flattenSource } from '../core/packed.ts';
import { packedSourceNames } from './common.ts';

export interface BundleFile { path: string; bytes: Uint8Array }

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
  'Objects: import objects.glb (meshes + EXT_mesh_gpu_instancing instances) with the Interchange glTF importer at location 0; Unreal maps glTF Y-up metres to Z-up centimetres (X = x, Y = z, Z = y), matching the landscape.',
  'Instances for PCG: import meshes/*.glb as static meshes, read instances.csv (Position/Rotation/Scale in cm and degrees, Mesh = the static mesh name) with the Polyforge PCG loader or a DataTable (pcg_struct export), and spawn by Mesh.',
];

const r = (x: number, d = 4) => +x.toFixed(d);

/**
 * The files of an Unreal Landscape bundle (paths relative to the bundle directory), its manifest and a summary.
 * The geometry needs a heightfield; packed instances and meshes in the same geometry go into objects.glb and the
 * instance stream.
 */
export async function unrealLandscapeBundle(g: Geometry, o: ExportOptions & HeightmapOptions & { manifestName?: string } = {}): Promise<{ files: BundleFile[]; manifest: Record<string, any>; summary: string }> {
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
  for (const [name, a] of hf.layers) {
    if (name === heightLayer) continue;
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
    layers.push({
      name, file: `layers/${file}.png`, min: r(st.min, 6), max: r(st.max, 6),
      encoding: unit ? 'value = round(clamp(layer, 0, 1) * 255)' : `value = round((layer - ${r(lo, 6)}) / ${r(span, 6)} * 255) (normalised: the layer is outside 0..1)`,
    });
  }
  // meshes and instances of the same geometry
  let objects: string | null = null, instances: Record<string, any> | null = null;
  const glbOpts: ExportOptions = { materials: o.materials, readFile: o.readFile, warn: o.warn, custom: o.custom };
  if (g.numPrims > 0) {
    files.push({ path: 'objects.glb', bytes: await exportGLB(g, glbOpts) });
    objects = 'objects.glb';
  }
  if (g.hasPacked()) {
    files.push({ path: 'instances.csv', bytes: new TextEncoder().encode(exportCSV(g, { pcg: true, scale: 100, warn: o.warn })) });
    files.push({ path: 'instances.meshes.json', bytes: new TextEncoder().encode(instanceMeshesJSON(g, { meshDir: 'meshes', stream: 'instances.csv', scene: objects ?? undefined })) });
    const names = packedSourceNames(g);
    for (let s = 0; s < g.packedSources.length; s++) files.push({ path: `meshes/${names[s]}.glb`, bytes: await exportGLB(flattenSource(g.packedSources[s]), glbOpts) });
    instances = { count: g.numPacked, csv: 'instances.csv', meshes: 'instances.meshes.json', mesh_dir: 'meshes', sources: names };
  }
  const manifest: Record<string, any> = {
    format: 'polyforge-unreal-landscape', version: 1,
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
    instances,
    manual_import: LANDSCAPE_IMPORT_STEPS,
  };
  const name = o.manifestName || 'landscape.json';
  files.unshift({ path: name, bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n') });
  const summary = `Unreal Landscape bundle: heightmap ${hf.width}×${hf.height} (${comp.exact ? '' : 'not an exact fit, '}${comp.sectionSize} quads/section, ${comp.sectionsPerComponent}×${comp.sectionsPerComponent} sections, ${comp.components.join('×')} components), scale (${scale.join(', ')}), ` +
    `${layers.length} layer(s)${objects ? ', objects.glb' : ''}${instances ? `, ${instances.count} instances of ${instances.sources.length} mesh(es) (instances.csv + meshes/)` : ''}`;
  return { files, manifest, summary };
}
