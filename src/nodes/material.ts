// Material assignment: names a material per prim and keeps the PBR parameters in the detail table
// (see src/core/materials.ts). Exporters write them as glTF materials.
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { MATERIAL_ATTRIB, normalizeMaterial, readMaterials, writeMaterials } from '../core/materials.ts';
import { P, mask } from './util.ts';

defineNode({
  type: 'material',
  category: 'attribute',
  packed: 'keep',
  summary: 'Assign a named material (PBR base colour, metallic, roughness, emissive, alpha) to prims; exporters write it as a glTF material.',
  description:
    'Writes the prim string attribute "material" for the selected prims and adds (or replaces) the entry in the detail ' +
    'material table "materials" (JSON). Vertex colours (Cd) still win in exports: a material then supplies the PBR scalars. ' +
    'Assign several materials by chaining material nodes with different groups.',
  aliases: ['material_assign', 'shop', 'assign_material', 'materialassign'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  outputs: 'prim "material" (string), detail "materials" (JSON table)',
  params: {
    name: { type: 'string', default: 'material', desc: 'material name (also the glTF material name)', aliases: ['shop_materialpath', 'material', 'path', 'materialpath'] },
    group: P.group('prim', 'prims to assign ("" = all). e.g. "top", "@P.y>0", "0-9"'),
    base_color: { type: 'color', default: [0.8, 0.8, 0.8], desc: 'base colour [r,g,b] 0..1, "#rrggbb" or a name', aliases: ['basecolor', 'color', 'cd', 'albedo', 'diffuse'] },
    metallic: { type: 'float', default: 0, min: 0, max: 1, desc: 'metalness 0..1', aliases: ['metal', 'metalness'] },
    roughness: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'roughness 0..1', aliases: ['rough'] },
    emissive: { type: 'color', default: [0, 0, 0], desc: 'emitted colour; components above 1 export with KHR_materials_emissive_strength', aliases: ['emission', 'emit'] },
    alpha: { type: 'float', default: 1, min: 0, max: 1, desc: 'opacity; below 1 exports with alphaMode BLEND', aliases: ['opacity', 'opac'] },
    double_sided: { type: 'bool', default: false, desc: 'render both faces', aliases: ['doublesided', 'two_sided'] },
    unlit: { type: 'bool', default: false, desc: 'unlit shading (KHR_materials_unlit)', aliases: ['emissive_only', 'flat'] },
  },
  example: { type: 'material', params: { name: 'brick', base_color: '#a5462e', roughness: 0.9, group: '@P.y<0.5' } },
  cook: ({ input, p }) => {
    const name = String(p.name ?? '').trim();
    if (!name) throw new NodeError('material name is empty');
    const g = input(0).clone();
    const sel = mask(g, 'prim', p.group);
    const a = g.prims.add(MATERIAL_ATTRIB, 'string', 1);
    for (let i = 0; i < g.numPrims; i++) if (!sel || sel[i]) a.set(i, name);
    const table = readMaterials(g);
    table[name] = normalizeMaterial({
      baseColor: p.base_color, metallic: p.metallic, roughness: p.roughness, emissive: p.emissive,
      alpha: p.alpha, doubleSided: !!p.double_sided, unlit: !!p.unlit,
    });
    writeMaterials(g, table);
    return g;
  },
});
