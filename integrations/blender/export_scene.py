"""Headless .blend -> static GLB for TopoTopo. Never saves or overwrites the .blend."""
import json
import os
import copy
import struct
import sys
import traceback
from collections import Counter

import bpy


def static_copies():
    """Bake evaluated geometry/transforms into copies; keep linked, unmodified meshes shared."""
    scenes = list(bpy.data.scenes)
    original_scene = bpy.context.window.scene
    objects = list(dict.fromkeys(obj for scene in scenes for obj in scene.objects))
    print("TopoTopo objects before export: " + json.dumps(dict(sorted(Counter(o.type for o in objects).items()))), flush=True)

    # Excluded collections must be evaluated too, even though visibility is not an export filter.
    def enable(layer):
        layer.exclude = False
        layer.hide_viewport = False
        for child in layer.children:
            enable(child)

    for collection in bpy.data.collections:
        collection.hide_viewport = False
    for scene in scenes:
        for layer in scene.view_layers:
            enable(layer.layer_collection)
    for obj in objects:
        obj.hide_viewport = False
        obj.hide_render = False
        obj.hide_set(False)

    copies, worlds, names, data_copies = {}, {}, {}, {}
    for scene in scenes:
        bpy.context.window.scene = scene
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        for obj in list(scene.objects):
            if obj in copies:
                continue
            evaluated = obj.evaluated_get(depsgraph)
            worlds[obj] = evaluated.matrix_world.copy()
            names[obj] = obj.name
            if obj.type in {'MESH', 'CURVE', 'SURFACE', 'FONT'}:
                if obj.type == 'MESH' and not obj.modifiers and not obj.data.shape_keys:
                    if obj.data not in data_copies:
                        data_copies[obj.data] = obj.data.copy()
                    mesh = data_copies[obj.data]
                else:
                    # Unlike the exporter’s curve path, this also retains unbevelled curve edges.
                    mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
                    if mesh is None:
                        raise RuntimeError("Could not evaluate " + obj.name + " as a mesh")
                    for key in obj.data.keys():
                        if key not in mesh:
                            mesh[key] = obj.data[key]
                copy = bpy.data.objects.new(obj.name, mesh)
                for key in obj.keys():
                    copy[key] = obj[key]
                for index, slot in enumerate(obj.material_slots):
                    if index < len(copy.material_slots) and slot.link == 'OBJECT':
                        copy.material_slots[index].link = 'OBJECT'
                        copy.material_slots[index].material = slot.material
            else:
                copy = obj.copy()
                copy.animation_data_clear()
                copy.constraints.clear()
            copies[obj] = copy

    # Relink copies in the existing collection hierarchy; originals are removed only from this process's memory.
    parents = {obj: obj.parent for obj in objects}
    for obj, copy in copies.items():
        for collection in obj.users_collection:
            collection.objects.link(copy)
        copy.parent = copies.get(parents[obj])
        copy.parent_type = 'OBJECT'
        copy.matrix_parent_inverse.identity()
    def depth(obj):
        return 0 if parents[obj] not in parents else 1 + depth(parents[obj])
    for obj in sorted(objects, key=depth):
        copies[obj].matrix_world = worlds[obj]
    desired_names = [(copies[obj], names[obj]) for obj in objects]
    for obj in objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    for copy, name in desired_names:
        copy.name = name
    for scene in scenes:
        scene.unit_settings.scale_length = 1.0  # apply units once to the exported roots, including collection instances
    bpy.context.window.scene = original_scene
    bpy.context.view_layer.update()
    print("TopoTopo objects after conversion: " + json.dumps(dict(sorted(Counter(o.type for o in copies.values()).items()))), flush=True)


def apply_scene_units(output, units):
    """Scale GLB roots, never prototypes: a collection instance must not apply the unit factor twice."""
    if all(value == 1.0 for value in units.values()):
        return
    with open(output, 'rb') as stream:
        data = stream.read()
    magic, version, length = struct.unpack_from('<4sII', data)
    if magic != b'glTF' or version != 2 or length != len(data):
        raise RuntimeError('Exporter did not produce a valid GLB container')
    chunks, offset = [], 12
    while offset < length:
        size, kind = struct.unpack_from('<II', data, offset)
        chunks.append((kind, data[offset + 8:offset + 8 + size]))
        offset += 8 + size
    document = json.loads(chunks[0][1])
    nodes = document.get('nodes', [])
    originals = copy.deepcopy(nodes)
    requests = {}
    for scene in document.get('scenes', []):
        factor = units.get(scene.get('name'), 1.0)
        for index, root in enumerate(scene.get('nodes', [])):
            requests.setdefault(root, {}).setdefault(factor, []).append((scene, index))

    def clone_tree(index):
        node = copy.deepcopy(originals[index])
        if 'children' in node:
            node['children'] = [clone_tree(child) for child in node['children']]
        nodes.append(node)
        return len(nodes) - 1

    for root, factors in requests.items():
        for variant, (factor, references) in enumerate(factors.items()):
            # Usually roots are unique per scene. If scenes share a root but use different units, share meshes
            # and copy only the node hierarchy so one scene's conversion cannot alter the other.
            target = root if variant == 0 else clone_tree(root)
            for scene, index in references:
                scene['nodes'][index] = target
            node = nodes[target]
            if 'matrix' in node:
                node['matrix'] = [value * factor if i % 4 != 3 else value for i, value in enumerate(node['matrix'])]
            else:
                node['translation'] = [value * factor for value in node.get('translation', [0, 0, 0])]
                node['scale'] = [value * factor for value in node.get('scale', [1, 1, 1])]
    payload = json.dumps(document, separators=(',', ':'), ensure_ascii=False).encode('utf8')
    chunks[0] = (chunks[0][0], payload + b' ' * (-len(payload) % 4))
    body = b''.join(struct.pack('<II', len(payload), kind) + payload for kind, payload in chunks)
    with open(output, 'wb') as stream:
        stream.write(struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body)
    print('TopoTopo scene unit scales: ' + json.dumps(units, sort_keys=True), flush=True)


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if len(args) != 1:
        raise RuntimeError("Expected one output .glb path after --")
    output = os.path.abspath(args[0])
    units = {scene.name: scene.unit_settings.scale_length for scene in bpy.data.scenes}
    static_copies()
    properties = bpy.ops.export_scene.gltf.get_rna_type().properties
    kwargs, missing = {}, []

    def option(identifiers, value):
        # Option identifiers come from RNA, not a version assumption. Aliases cover older exporters.
        for identifier in identifiers:
            if identifier in properties:
                kwargs[identifier] = value
                return
        missing.append('/'.join(identifiers))

    for identifiers, value in [
        (('filepath',), output), (('export_format',), 'GLB'), (('check_existing',), False),
        (('export_yup',), True), (('export_apply',), True),
        (('use_mesh_edges', 'export_loose_edges'), True),
        (('use_mesh_vertices', 'export_loose_points'), True),
        (('export_extras',), True), (('export_materials',), 'EXPORT'),
        (('export_image_format',), 'AUTO'), (('export_keep_originals',), False),
        (('export_cameras',), False), (('export_lights',), False),
        (('export_animations',), False), (('export_morph',), False), (('export_skins',), False),
        (('use_selection',), False), (('use_visible',), False), (('use_renderable',), False),
        (('use_active_collection',), False), (('use_active_collection_with_nested',), False),
        (('use_active_scene',), False), (('collection',), ''),
        (('export_hierarchy_full_collections',), True), (('export_hierarchy_flatten_objs',), False),
        (('export_gpu_instances',), False), (('will_save_settings',), False),
    ]:
        option(identifiers, value)
    print("TopoTopo exporter options set: " + json.dumps(kwargs, sort_keys=True), flush=True)
    print("TopoTopo exporter options missing: " + json.dumps(missing), flush=True)
    result = bpy.ops.export_scene.gltf(**kwargs)
    if 'FINISHED' not in result or not os.path.isfile(output):
        raise RuntimeError("glTF export did not finish: " + str(result))
    apply_scene_units(output, units)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        print("TopoTopo .blend conversion failed", file=sys.stderr, flush=True)
        # Blender otherwise reports many Python errors with exit code zero.
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)
