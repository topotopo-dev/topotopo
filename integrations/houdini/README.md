# Houdini materials

Load the `.geo` with a File SOP. Packed prims load as Packed Geometry.
TopoTopo writes `material` and `shop_materialpath` (`/mat/<material name>`) on assigned prims and a `materials` detail JSON table.
Use material names that are valid Houdini node names and make texture file paths accessible from the scene.

In Houdini's Python Shell, run this with the path to your script and SOP, then save the scene.

```python
from runpy import run_path
run_path("integrations/houdini/topotopo_materials.py")["build_materials"]("/obj/geo1/file1")
```

With hython, load the scene, build or update the shaders under `/mat`, and save the scene in place.
`hython topotopo_materials.py <hip file> <sop node path>`
