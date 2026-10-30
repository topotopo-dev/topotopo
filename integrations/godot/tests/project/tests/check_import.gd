extends SceneTree
## Loads what an import made and writes what it holds as JSON, for scripts/test-godot.mjs to compare with the cook:
## each GLB's scene (every node's class, name, transform; meshes and their materials; MultiMesh instance counts and
## buffers), each texture, and each .topo's status resource.
##   godot --headless --path <project> --script res://tests/check_import.gd -- <out.json> <res path>...


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var out := {}
	for i in range(1, args.size()):
		out[args[i]] = _load(args[i])
	var f := FileAccess.open(args[0], FileAccess.WRITE)
	f.store_string(JSON.stringify(out, "  "))
	f.close()
	print("check_import: %d files" % (args.size() - 1))
	quit()


func _load(path: String) -> Dictionary:
	if not ResourceLoader.exists(path):
		return {"error": "not loadable"}
	var res = load(path)
	if res == null:
		return {"error": "load returned null"}
	var d := {"class": res.get_class()}
	if res is PackedScene:
		var root: Node = res.instantiate()
		var nodes := []
		_walk(root, root, nodes)
		d["nodes"] = nodes
		root.free()
	elif res is MeshLibrary:
		d["items"] = res.get_item_list().size()
	elif res is Texture2D:
		d["size"] = [res.get_width(), res.get_height()]
	elif res.get_script() != null:
		d["script"] = res.get_script().resource_path
		for k in ["package_id", "package_name", "title", "status", "message", "topotopo_version", "outputs", "skipped", "orphans"]:
			d[k] = res.get(k)
	return d


static func _xform(t: Transform3D) -> Array:
	return [t.basis.x.x, t.basis.y.x, t.basis.z.x, t.origin.x, t.basis.x.y, t.basis.y.y, t.basis.z.y, t.origin.y,
		t.basis.x.z, t.basis.y.z, t.basis.z.z, t.origin.z]


static func _material(m: Material) -> Dictionary:
	if m == null:
		return {}
	var d := {"class": m.get_class(), "path": m.resource_path}
	if m is BaseMaterial3D:
		d["albedo_texture"] = m.albedo_texture.resource_path if m.albedo_texture else ""
		d["vertex_color_use_as_albedo"] = m.vertex_color_use_as_albedo
	return d


func _walk(n: Node, root: Node, out: Array) -> void:
	var e := {"name": String(n.name), "path": String(root.get_path_to(n)), "class": n.get_class()}
	if n is Node3D:
		e["transform"] = _xform(n.transform)
	if n is MeshInstance3D and n.mesh:
		e["mesh"] = n.mesh.get_class()
		var mats := []
		for s in n.mesh.get_surface_count():
			mats.append(_material(n.get_active_material(s)))
		e["materials"] = mats
	if n is MultiMeshInstance3D and n.multimesh:
		var mm: MultiMesh = n.multimesh
		e["instance_count"] = mm.instance_count
		e["use_colors"] = mm.use_colors
		e["buffer"] = Array(mm.buffer)
		e["mesh"] = mm.mesh.get_class() if mm.mesh else ""
		e["material_override"] = _material(n.material_override)
		e["has_meta"] = n.has_meta("topotopo_instances")
	out.append(e)
	for c in n.get_children():
		_walk(c, root, out)
