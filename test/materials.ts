// Material outputs: materials and their maps with no geometry are an output of kind "material". Made by
// texture_to_material or material with nothing in input 0; used through the material node's input 1 (the entry and its
// maps copied in, a clashing map renamed); shown on preview spheres; exported as PNGs + materials.json; published with
// each map's size, and used from another project by its package name.
//   node test/materials.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import type { Geometry } from '../src/core/geometry.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import { readMaterials } from '../src/core/materials.ts';
import { referenceableImages } from '../src/core/image.ts';
import { outputKind } from '../src/io/kinds.ts';
import { exportFilesAsync } from '../src/io/files.ts';
import { renderGeometry } from '../src/render/raster.ts';
import { previewGLB } from '../src/render/preview.ts';
import { openPackages, publishPackage, kindTagsText } from '../src/packages/registry.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-materials-'));
process.env.TOPOTOPO_CONFIG = path.join(tmp, 'cfg', 'config.json');
delete process.env.TOPOTOPO_LIBRARIES;

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const engine = new Engine(createNodeHost());
await engine.init();
async function cook(nodes: Record<string, NodeSpec>, output: string): Promise<Geometry> {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return r.geo;
}
async function cookError(nodes: Record<string, NodeSpec>, output: string) {
  const r = await engine.cook({ nodes, output });
  return r.ok ? '' : r.errors.map((e) => e.message).join('; ');
}

const MAPS: Record<string, NodeSpec> = {
  bricks: { type: 'tex_pattern', params: { resolution: 64 } },
  brick_color: { type: 'tex_colorize', in: ['bricks'], params: { ramp: [[0, '#6b6b66'], [1, '#a5462e']] } },
  bricks_hi: { type: 'tex_pattern', params: { resolution: 128 } },
  brick_normal: { type: 'tex_normal_from_height', in: ['bricks_hi'], params: { depth: 0.02 } },
  maps: { type: 'merge', in: ['brick_color', 'brick_normal'] },
  brick: { type: 'texture_to_material', in: [null as unknown as string, 'maps'], params: { material: 'brick', base_color: 'brick_color', normal: 'brick_normal' } },
  paint: { type: 'material', params: { name: 'paint', base_color: '#336699', roughness: 0.3 } },
  box: { type: 'box' },
  uv: { type: 'uv_project', in: ['box'], params: { method: 'box' } },
  use: { type: 'material', in: ['uv', 'brick'], params: { group: '@P.y>0' } },
  renamed: { type: 'material', in: ['uv', 'brick'], params: { name: 'wall' } },
  both: { type: 'merge', in: ['brick', 'paint'] },
  pick: { type: 'material', in: ['uv', 'both'], params: { from: 'paint' } },
  which: { type: 'material', in: ['uv', 'both'] },
  nothing: { type: 'material', in: ['uv', 'box'] },
  unknown: { type: 'material', in: ['uv', 'both'], params: { from: 'steel' } },
  // the target already carries a different image named brick_color: the copied one is renamed
  own: { type: 'tex_noise', params: { resolution: 32, name: 'brick_color' } },
  ownmat: { type: 'texture_to_material', in: ['uv', 'own'], params: { material: 'old', base_color: 'brick_color' } },
  clash: { type: 'material', in: ['ownmat', 'brick'], params: { group: '@P.y>0' } },
};

// ---------------------------------------------------------------- what it is

{
  const brick = await cook(MAPS, 'brick'), paint = await cook(MAPS, 'paint');
  const info = outputKind(brick);
  check(brick.numPoints === 0 && brick.numPrims === 0 && !brick.prims.get('material'), 'texture_to_material without a mesh: no geometry, no prim attribute');
  check(info.kind === 'material' && info.published === 'material' && info.materials === 1, `kind material (${info.kind}, ${info.published})`);
  check(info.text === '1 material, 2 maps (64 × 64, 128 × 128 px)', `its words: ${info.text}`);
  check([...referenceableImages(brick).keys()].sort().join(',') === 'brick_color,brick_normal', 'it carries exactly the maps it uses');
  const pi = outputKind(paint);
  check(pi.published === 'material' && pi.text === '1 material', `material without a mesh: a plain material output (${pi.text})`);
  const tex = outputKind(await cook(MAPS, 'brick_color'));
  check(tex.published === 'textures', 'images without a material stay textures');
  const used = outputKind(await cook(MAPS, 'use'));
  check(used.published === 'mesh' && used.materials === 0, 'a mesh wearing it stays a mesh');
}

// ---------------------------------------------------------------- using it

{
  const use = await cook(MAPS, 'use');
  const t = readMaterials(use), mat = use.prims.get('material')!;
  const assigned = Array.from({ length: use.numPrims }, (_, p) => mat.get(p));
  check(t.brick && t.brick.textures?.baseColor === 'image:brick_color' && t.brick.textures?.normal === 'image:brick_normal', 'material input 1: the entry is copied with its maps');
  check(assigned.filter((m) => m === 'brick').length === 1, 'material input 1: assigned to the group only (the top face)');
  check(referenceableImages(use).size === 2, 'material input 1: its maps travel with it');
  const renamed = await cook(MAPS, 'renamed');
  check(readMaterials(renamed).wall?.textures?.normal === 'image:brick_normal' && !readMaterials(renamed).brick, 'name renames the material in the target');
  const pick = await cook(MAPS, 'pick');
  check(readMaterials(pick).paint?.roughness === 0.3 && !readMaterials(pick).brick, 'from picks one of several');
  check(/holds 2 materials: say which with from/.test(await cookError(MAPS, 'which')), 'several materials and no from: an error that lists them');
  check(/carries no material/.test(await cookError(MAPS, 'nothing')), 'a source without materials: an error');
  check(/no material "steel".*|its materials/.test(await cookError(MAPS, 'unknown')), 'from naming a material the source lacks: an error');
  const clash = await cook(MAPS, 'clash');
  const ct = readMaterials(clash), imgs = referenceableImages(clash);
  check(ct.old.textures?.baseColor === 'image:brick_color' && ct.brick.textures?.baseColor === 'image:brick_brick_color' && imgs.get('brick_brick_color')?.width === 64 && imgs.get('brick_color')?.width === 32,
    'a copied map that clashes with the target\'s image is renamed, both kept');
}

// ---------------------------------------------------------------- seeing and exporting it

{
  const brick = await cook(MAPS, 'brick');
  const r = renderGeometry(brick, { size: 160 });
  let lit = 0;
  for (let i = 0; i < r.rgba.length; i += 4) if (Math.abs(r.rgba[i] - r.rgba[i + 2]) > 30) lit++;
  check(r.width > 0 && lit > 500, `render: a preview sphere wearing the base colour map (${lit} coloured pixels)`);
  const glb = await previewGLB(brick);
  check(glb.byteLength > 20000, `preview GLB: spheres with the material and its maps (${glb.byteLength} bytes)`);
  const both = await cook(MAPS, 'both');
  const r2 = renderGeometry(both, { size: 160 });
  check(r2.width > r.width * 0.9, 'render: two materials, two spheres');
  const dir = path.join(tmp, 'maps');
  const res = await exportFilesAsync(brick, 'textures', dir, { deflate: (d) => d });
  const names = res.files.map((f) => path.basename(f.path)).sort();
  check(names.join(',') === 'brick_color.png,brick_normal.png,materials.json', `textures export: the maps and materials.json (${names.join(', ')})`);
  const mj = JSON.parse(new TextDecoder().decode(res.files.find((f) => f.path.endsWith('materials.json'))!.bytes));
  check(mj.materials.brick.maps.baseColor === 'brick_color.png' && mj.materials.brick.maps.normal === 'brick_normal.png' && mj.materials.brick.roughness === 0.8,
    'materials.json: each material with its values and the files of its maps');
}

// ---------------------------------------------------------------- publishing and using it from another project

{
  const lib = path.join(tmp, 'lib'), mats = path.join(lib, 'mats'), house = path.join(tmp, 'house');
  const json = (f: string, d: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 1)); };
  const matGraph: GraphSpec = { nodes: structuredClone(MAPS), output: 'brick', outputs: { brick: { node: 'brick', kind: 'material', tags: ['brick'], description: 'Old brick.' } } };
  json(path.join(mats, 'project.json'), { id: 'mats', title: 'mats', graph: 'main', package: 'studio/mats' });
  json(path.join(mats, 'graphs', 'main.json'), matGraph);
  const e1 = new Engine(createNodeHost({ baseDir: mats }));
  await e1.init();
  const pub = await publishPackage(openPackages(e1, mats), { note: 'first' });
  check(pub.version === '1.0' && !pub.blocks.length, `publish a material output (${pub.version}${pub.blocks.length ? ': ' + pub.blocks.join('; ') : ''})`);
  const vj = JSON.parse(fs.readFileSync(path.join(mats, 'versions', '1.0', 'version.json'), 'utf8'));
  check(vj.outputs.brick.kind === 'material' && JSON.stringify(vj.outputs.brick.maps) === '{"brick":{"baseColor":[64,64],"normal":[128,128]}}', `version.json: kind material and each map's size (${JSON.stringify(vj.outputs.brick.maps)})`);
  check(kindTagsText(vj.outputs.brick) === 'material [brick]  maps baseColor 64, normal 128', `listings say the maps: ${kindTagsText(vj.outputs.brick)}`);
  // pinned material, cooks to a mesh: blocked
  json(path.join(mats, 'graphs', 'main.json'), { ...matGraph, outputs: { brick: { node: 'use', kind: 'material' } } });
  const e2 = new Engine(createNodeHost({ baseDir: mats }));
  await e2.init();
  const bad = await publishPackage(openPackages(e2, mats), { note: 'wrong', dryRun: true } as any);
  check(bad.blocks.some((b) => /its "kind" is "material", and it cooks to mesh/.test(b)), 'pinned material that cooks to a mesh: publishing blocks');
  json(path.join(mats, 'graphs', 'main.json'), matGraph);
  // another project uses it by name on its own mesh
  json(path.join(house, 'project.json'), { id: 'house', title: 'house', graph: 'main', libraries: ['../lib'] });
  const houseGraph: GraphSpec = {
    nodes: {
      box: { type: 'box' }, uv: { type: 'uv_project', in: ['box'], params: { method: 'box' } },
      brick: { type: 'studio/mats/brick' },
      wall: { type: 'material', in: ['uv', 'brick'] },
    },
    output: 'wall',
  };
  json(path.join(house, 'graphs', 'main.json'), houseGraph);
  const e3 = new Engine(createNodeHost({ baseDir: house }));
  await e3.init();
  const pk = openPackages(e3, house);
  pk.addFor(houseGraph);
  const r = await e3.cook(houseGraph, { scope: pk.engine.root });
  const g = r.geo;
  check(r.ok && g && readMaterials(g).brick?.textures?.normal === 'image:brick_normal' && referenceableImages(g).get('brick_normal')?.width === 128,
    `another project wears studio/mats/brick (${r.ok ? 'ok' : r.errors.map((x) => x.message).join('; ')})`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
