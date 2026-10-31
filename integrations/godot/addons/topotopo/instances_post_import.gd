@tool
extends EditorScenePostImportPlugin
## Runs after Godot made the meshes of an imported scene (LODs, shadow meshes, extracted materials included): every
## MeshInstance3D that gltf_instancing.gd marked with instance rows becomes a MultiMeshInstance3D of the same mesh, in
## the same place in the tree. Nodes without the mark, and so every other GLB of the game, are left alone.


func _post_process(scene: Node) -> void:
	var marked: Array = []
	_collect(scene, marked)
	for n in marked:
		_replace(n, scene)


func _collect(n: Node, out: Array) -> void:
	for c in n.get_children():
		_collect(c, out)
	if n is MeshInstance3D and n.has_meta("topotopo_instances"):
		out.append(n)


func _replace(n: MeshInstance3D, root: Node) -> void:
	var rows: PackedFloat32Array = n.get_meta("topotopo_instances")
	var colors: PackedFloat32Array = n.get_meta("topotopo_instance_colors", PackedFloat32Array())
	var count := rows.size() / 12
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = colors.size() > 0
	mm.mesh = n.mesh
	mm.instance_count = count
	if colors.size():
		var buf := PackedFloat32Array()
		buf.resize(count * 16)
		for i in count:
			for c in 12:
				buf[i * 16 + c] = rows[i * 12 + c]
			for c in 4:
				buf[i * 16 + 12 + c] = colors[i * 4 + c]
		mm.buffer = buf
	elif count > 0:
		mm.buffer = rows
	var mmi := MultiMeshInstance3D.new()
	mmi.name = n.name
	mmi.transform = n.transform
	mmi.visible = n.visible
	mmi.layers = n.layers
	mmi.cast_shadow = n.cast_shadow
	mmi.visibility_range_begin = n.visibility_range_begin
	mmi.visibility_range_begin_margin = n.visibility_range_begin_margin
	mmi.visibility_range_end = n.visibility_range_end
	mmi.visibility_range_end_margin = n.visibility_range_end_margin
	mmi.visibility_range_fade_mode = n.visibility_range_fade_mode
	mmi.gi_mode = n.gi_mode
	mmi.multimesh = mm
	mmi.material_overlay = n.material_overlay
	_copy_materials(n, mmi, colors.size() > 0)
	var parent := n.get_parent()
	var at := n.get_index()
	parent.remove_child(n)
	parent.add_child(mmi)
	parent.move_child(mmi, at)
	mmi.owner = root
	for c in n.get_children():
		n.remove_child(c)
		mmi.add_child(c)
		_own(c, root)
	n.free()


## Keep the effective materials, including Godot's import overrides. Instance colours use material copies; surface
## overrides need a private mesh because MultiMeshInstance3D has no per-instance surface override API.
func _copy_materials(n: MeshInstance3D, mmi: MultiMeshInstance3D, coloured: bool) -> void:
	if n.material_override:
		mmi.material_override = _coloured(n.material_override) if coloured else n.material_override
		return
	var mesh := n.mesh
	if mesh == null:
		return
	if mesh.get_surface_count() <= 1:
		var base: Material = n.get_active_material(0) if mesh.get_surface_count() == 1 else null
		mmi.material_override = _coloured(base) if coloured else base
		return
	if mesh is ArrayMesh:
		var overrides := coloured
		for i in mesh.get_surface_count():
			overrides = overrides or n.get_surface_override_material(i) != null
		if not overrides:
			return
		var copy: ArrayMesh = mesh.duplicate()
		for i in mesh.get_surface_count():
			var base := n.get_active_material(i)
			copy.surface_set_material(i, _coloured(base) if coloured else base)
		mmi.multimesh.mesh = copy


func _coloured(base: Material) -> Material:
	if base is BaseMaterial3D:
		var m: BaseMaterial3D = base.duplicate()
		m.vertex_color_use_as_albedo = true
		return m
	if base != null:
		return base
	var s := StandardMaterial3D.new()
	s.vertex_color_use_as_albedo = true
	return s


func _own(n: Node, root: Node) -> void:
	n.owner = root
	for c in n.get_children():
		_own(c, root)
