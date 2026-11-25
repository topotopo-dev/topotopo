"""Create Houdini shaders from the material table in a TopoTopo .geo export."""

import argparse
from itertools import chain
import json

import hou


def build_materials(geo_node_path, mat_path="/mat"):
    """Build or update Principled Shader 2.0 nodes and return their paths."""
    sop = hou.node(geo_node_path)
    if not isinstance(sop, hou.SopNode):
        raise ValueError(f"Choose a SOP node path such as /obj/geo1/file1. Received {geo_node_path!r}.")

    geo = sop.geometry()
    embedded = (
        prim.getEmbeddedGeometry()
        for prim in geo.iterPrims()
        if isinstance(prim, hou.PackedGeometry)
    )
    materials = {}
    seen_tables = set()
    for part in chain((geo,), embedded):
        attrib = part.findGlobalAttrib("materials")
        if attrib is None:
            continue
        source = part.stringAttribValue(attrib)
        if not source or source in seen_tables:
            continue
        seen_tables.add(source)
        for name, material in json.loads(source).items():
            materials.setdefault(name, material)

    if not materials:
        return []
    network = hou.node(mat_path)
    if network is None:
        raise ValueError(f"Create a material network at {mat_path!r} and run the script again.")

    shader_type = "principledshader::2.0"
    existing = {node.name(): node for node in network.children()}
    paths = []
    for name, material in materials.items():
        shader = existing.get(name)
        if shader is None:
            shader = network.createNode(shader_type, name, exact_type_name=True)
        elif shader.type().name() != shader_type:
            raise ValueError(f"Rename the node at {shader.path()} to make room for a Principled Shader 2.0.")

        textures = {
            slot: path
            for slot, path in material.get("textures", {}).items()
            if path and not path.startswith(("image:", "embedded:"))
        }
        base_color = textures.get("baseColor", "")
        normal = textures.get("normal", "")
        orm = textures.get("orm", "")
        packing = material.get("packing", "orm")
        packing = {"arm": "orm", "rma": "rmo", "mrao": "mrox", "mask_map": "moxs"}.get(packing, packing)
        # The shader's scalar texture menus use 0 for luminance and 1, 2, 3 for RGB.
        rough_channel = packing[:3].find("r") + 1 if orm else 0
        metal_channel = packing[:3].find("m") + 1 if orm else 0
        roughness = orm if rough_channel else textures.get("roughness", "")
        metallic = orm if metal_channel else ""

        shader.parmTuple("basecolor").set(material.get("baseColor", (0.8, 0.8, 0.8)), follow_parm_references=False)
        parms = {
            "rough": material.get("roughness", 0.8),
            "metallic": material.get("metallic", 0),
            "basecolor_useTexture": bool(base_color),
            "basecolor_texture": base_color,
            "rough_useTexture": bool(roughness),
            "rough_texture": roughness,
            "rough_monoChannel": rough_channel,
            "metallic_useTexture": bool(metallic),
            "metallic_texture": metallic,
            "metallic_monoChannel": metal_channel,
            "baseBumpAndNormal_enable": bool(normal),
            "baseBumpAndNormal_type": "normal",
            "baseNormal_texture": normal,
            "baseNormal_flipY": material.get("normalFormat") == "directx",
        }
        for parm, value in parms.items():
            shader.parm(parm).set(value, follow_parm_reference=False)
        shader.setMaterialFlag(True)
        paths.append(shader.path())

    return paths


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build TopoTopo materials and save them in a Houdini scene.")
    parser.add_argument("hip_file", metavar="HIP_FILE", help="Houdini scene to load and save")
    parser.add_argument("sop_node_path", metavar="SOP_NODE_PATH", help="Path of the SOP with the imported .geo")
    args = parser.parse_args()
    hou.hipFile.load(args.hip_file, suppress_save_prompt=True)
    build_materials(args.sop_node_path)
    hou.hipFile.save()
