// Scene output nodes: scene_null adds a named scene empty (an attachment socket) that exports as a meshless node.
// Contract: core/scene.ts.
import { Geometry } from '../core/geometry.ts';
import { m4trs, qFromMat } from '../core/math.ts';
import type { Vec3 } from '../core/math.ts';
import { emptyGeometry } from '../core/scene.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';

defineNode({
  type: 'scene_null',
  category: 'io',
  packed: 'keep',
  summary: 'Add a named scene empty (attachment socket): a meshless node in glTF export, parented to the root, another empty or a mesh.',
  description:
    'Houdini: a Null object; Blender/Unreal: an Empty / socket. Adds one isolated point marked scene_empty = 1 with point ' +
    'attributes name, parent, orient and scale (help topic "export"). translation, rotation and scale are in geometry ' +
    '(model) space, so later transform nodes move the empty with the mesh; glTF export writes it as a node without a ' +
    'mesh under its parent with the local transform that keeps this geometry-space placement. parent names another ' +
    'empty or a mesh (the prim "name" of the pieces export splits by); missing, ambiguous and cyclic parents are export ' +
    'errors. Other point attributes set on the empty (e.g. a "forward" vector) export as node extras. The empty\'s ' +
    'attributes (scene_empty, parent, orient, scale and such extras) only hold their defaults on the mesh points after ' +
    'a merge, and export never writes them as mesh channels, even with custom_attribs. Ordinary loose points still ' +
    'export as POINTS.',
  aliases: ['null_object', 'empty', 'socket', 'locator', 'scene_empty', 'attachment_point'],
  inputs: [{ name: 'geo', desc: 'geometry to add the empty to (optional)', optional: true }],
  params: {
    name: { type: 'string', default: 'socket', desc: 'node name of the empty (unique when something parents to it)', aliases: ['node_name', 'socket_name'] },
    parent: { type: 'string', default: '', desc: 'parent: "" = scene root, else the name of another empty or of a mesh (prim "name")', aliases: ['parent_name', 'attach_to'] },
    translation: { type: 'vec3', default: [0, 0, 0], desc: 'position in geometry (model) space, metres', aliases: ['translate', 't', 'position'] },
    rotation: { type: 'vec3', default: [0, 0, 0], desc: 'rotation in geometry space, degrees (x, then y, then z)', aliases: ['rotate', 'r'] },
    scale: { type: 'vec3', default: [1, 1, 1], desc: 'scale', aliases: ['s'] },
  },
  outputs: 'the input plus one point: scene_empty 1, name, parent, orient, scale',
  example: {
    nodes: {
      body: { type: 'box', params: { size: [0.12, 0.2, 0.12] } },
      named: { type: 'attrib_create', in: ['body'], params: { name: 'name', class: 'prim', value: 'housing' } },
      wick: { type: 'scene_null', in: ['named'], params: { name: 'wick', parent: 'housing', translation: [0, -0.05, 0] } },
      flame: { type: 'scene_null', in: ['wick'], params: { name: 'flame', parent: 'wick', translation: [0, -0.03, 0], rotation: [0, 45, 0] } },
    },
    output: 'flame',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const name = String(p.name ?? '').trim(), parent = String(p.parent ?? '').trim();
    if (!name) throw new NodeError('scene_null: name is empty', 'give the empty a name, e.g. "handle"');
    if (parent === name) throw new NodeError(`scene_null: "${name}" cannot be its own parent`, 'use "" for the scene root or name another empty or mesh');
    const s = p.scale as number[];
    if (!s.every((x) => Number.isFinite(x) && x !== 0)) throw new NodeError(`scene_null: scale (${s.join(', ')}) needs finite, non-zero components`, 'a zero scale cannot be inverted for children');
    const q = qFromMat(m4trs([0, 0, 0], p.rotation as Vec3, [1, 1, 1]));
    const e = emptyGeometry(name, parent, p.translation as Vec3, q, s as Vec3);
    return ctx.hasInput(0) ? Geometry.merge([ctx.input(0), e]) : e;
  },
});
