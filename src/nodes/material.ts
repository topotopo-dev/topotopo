// Material assignment: names a material per prim and keeps the PBR parameters in the detail table
// (see src/core/materials.ts). Exporters write them as glTF materials.
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { Geometry, sameImage } from '../core/geometry.ts';
import { referenceableImages } from '../core/image.ts';
import type { Image } from '../core/image.ts';
import { MATERIAL_ATTRIB, normalizeMaterial, readMaterials, writeMaterials } from '../core/materials.ts';
import type { Material } from '../core/materials.ts';
import { P, mask } from './util.ts';

defineNode({
  type: 'material',
  category: 'attribute',
  packed: 'keep',
  summary: 'Assign a named material (PBR base colour, metallic, roughness, emissive, alpha) to prims, or one from a material output; exporters write it as a glTF material.',
  description:
    'Writes the prim string attribute "material" for the selected prims and adds (or replaces) the entry in the detail ' +
    'material table "materials" (JSON). In glTF export the material decides the colour of its prims and their Cd is not ' +
    'written (export option vertex_colors keeps it). Assign several materials by chaining material nodes with different ' +
    'groups: by name pattern "@name=Glass*", prim ranges "0-11", or node groups (help topic "materials"). Texture maps are file paths (PNG or ' +
    'JPEG, relative to the package folder): glb/gltf embed them, usda references them through UsdUVTexture shaders, ' +
    'geo and json keep the paths in the table. A map replaces its scalar (base_color, roughness) in exports. ' +
    'Input 1 takes the material from elsewhere, typically a material output of a package ({"type": "owner/materials/steel"}): ' +
    'its entry and the maps it uses are copied in (from names it when the source holds several) and the colour and map ' +
    'params here are not used. With nothing in input 0 the result is the material alone: a material output.',
  aliases: ['material_assign', 'shop', 'assign_material', 'materialassign'],
  inputs: [
    { name: 'geo', desc: 'geometry (none: the material alone, for a material output)', optional: true },
    { name: 'source', desc: 'a material output, or any geometry carrying materials, to take the material from', optional: true },
  ],
  outputs: 'prim "material" (string), detail "materials" (JSON table); with a source, the images its maps use',
  params: {
    name: { type: 'string', default: '', desc: 'material name, also the glTF material name ("" = "material", or the source material\'s own name with input 1)', aliases: ['shop_materialpath', 'material', 'path', 'materialpath'] },
    from: { type: 'string', default: '', desc: 'input 1: which of its materials ("" = its only one)', aliases: ['source_material', 'use'] },
    group: P.group('prim', 'prims to assign ("" = all). e.g. "top", "@P.y>0", "0-9"'),
    base_color: { type: 'color', default: [0.8, 0.8, 0.8], desc: 'base colour [r,g,b] 0..1, "#rrggbb" or a name', aliases: ['basecolor', 'color', 'cd', 'albedo', 'diffuse'] },
    metallic: { type: 'float', default: 0, min: 0, max: 1, desc: 'metalness 0..1', aliases: ['metal', 'metalness'] },
    roughness: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'roughness 0..1', aliases: ['rough'] },
    emissive: { type: 'color', default: [0, 0, 0], desc: 'emitted colour; components above 1 export with KHR_materials_emissive_strength', aliases: ['emission', 'emit'] },
    alpha: { type: 'float', default: 1, min: 0, max: 1, desc: 'opacity; below 1 exports with alphaMode BLEND', aliases: ['opacity', 'opac'] },
    alpha_mode: { type: 'enum', options: ['auto', 'opaque', 'mask', 'blend'], default: 'auto', desc: 'auto preserves legacy scalar/vertex opacity; mask cuts out pixels below alpha_cutoff; explicit modes override auto' },
    alpha_cutoff: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'mask: discard where material alpha × texture alpha × vertex Alpha is below this value' },
    double_sided: { type: 'bool', default: false, desc: 'render both faces', aliases: ['doublesided', 'two_sided'] },
    unlit: { type: 'bool', default: false, desc: 'unlit shading (KHR_materials_unlit)', aliases: ['emissive_only', 'flat'] },
    base_color_map: { type: 'path', default: '', desc: 'base colour texture (sRGB PNG/JPEG path, or "image:<name>" for an image the geometry carries; "" = none); uses the uv attribute', aliases: ['basecolor_map', 'albedo_map', 'diffuse_map', 'color_map', 'basecolor_texture', 'base_color_texture'] },
    normal_map: { type: 'path', default: '', desc: 'tangent-space normal map (PNG/JPEG path or "image:<name>", OpenGL convention: +Y up; "" = none)', aliases: ['normal_texture', 'bump_map'] },
    roughness_map: { type: 'path', default: '', desc: 'roughness texture (grey PNG/JPEG path or "image:<name>"; "" = none); glTF reads its green channel', aliases: ['roughness_texture', 'rough_map'] },
  },
  example: { type: 'material', params: { name: 'brick', base_color: '#a5462e', roughness: 0.9, group: '@P.y<0.5' } },
  cook: ({ input, hasInput, p }) => {
    const g = hasInput(0) ? input(0).clone() : new Geometry();
    let name = String(p.name ?? '').trim();
    let entry: Material;
    let images: Image[] = [];
    if (hasInput(1)) {
      const src = input(1), table = readMaterials(src), names = Object.keys(table);
      const want = String(p.from ?? '').trim();
      if (!names.length) throw new NodeError('input 1 carries no material', 'wire a material output (kind material) or any geometry that has materials into input 1');
      if (want && !table[want]) throw new NodeError(`input 1 has no material "${want}"`, `its materials: ${names.join(', ')}`);
      if (!want && names.length > 1) throw new NodeError(`input 1 holds ${names.length} materials: say which with from`, `its materials: ${names.join(', ')}`);
      const from = want || names[0];
      entry = normalizeMaterial(table[from]);
      if (!name) name = from;
      // the maps it uses travel with it
      const pool = referenceableImages(src);
      for (const ref of Object.values(entry.textures ?? {})) {
        if (!ref?.startsWith('image:')) continue;
        const im = pool.get(ref.slice(6));
        if (!im) throw new NodeError(`input 1: material "${from}" uses image "${ref.slice(6)}", which it does not carry`);
        images.push(im);
      }
    } else {
      if (!name) name = 'material';
      entry = normalizeMaterial({
        baseColor: p.base_color, metallic: p.metallic, roughness: p.roughness, emissive: p.emissive,
        alpha: p.alpha, doubleSided: !!p.double_sided, unlit: !!p.unlit,
        alphaMode: p.alpha_mode, alphaCutoff: p.alpha_cutoff,
        textures: { baseColor: p.base_color_map, normal: p.normal_map, roughness: p.roughness_map },
      });
    }
    // copied maps join the target's images; one that differs from a target image of the same name is renamed
    // "<material>_<map>" (as Geometry.merge does), and the entry follows
    const have = referenceableImages(g);
    const textures: Record<string, string> = { ...(entry.textures ?? {}) };
    for (const im of images) {
      const old = have.get(im.name);
      if (old && sameImage(old, im)) continue;
      let copy = im;
      if (old) {
        let n = `${name}_${im.name}`, k = 2;
        while (have.has(n)) n = `${name}_${im.name}_${k++}`;
        copy = im.clone(); copy.name = n;
        for (const [slot, ref] of Object.entries(textures)) if (ref === `image:${im.name}`) textures[slot] = `image:${n}`;
      }
      g.volumes.push(copy);
      have.set(copy.name, copy);
    }
    if (images.length) entry = { ...entry, textures: textures as Material['textures'] };
    if (g.numPrims) {
      const sel = mask(g, 'prim', p.group);
      const a = g.prims.add(MATERIAL_ATTRIB, 'string', 1);
      for (let i = 0; i < g.numPrims; i++) if (!sel || sel[i]) a.set(i, name);
    }
    const table = readMaterials(g);
    table[name] = entry;
    writeMaterials(g, table);
    return g;
  },
});
