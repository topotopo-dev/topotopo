@tool
extends GLTFDocumentExtension
## Reads EXT_mesh_gpu_instancing, which TopoTopo writes for packed instances: each instance's TRANSLATION, ROTATION and
## SCALE (and _COLOR when the instances carry a colour) go into node metadata as MultiMesh rows, which
## instances_post_import.gd turns into a MultiMeshInstance3D after Godot made the meshes. GLBs without the extension
## are left alone.

const EXT := "EXT_mesh_gpu_instancing"


func _get_supported_extensions() -> PackedStringArray:
	return PackedStringArray([EXT])


func _import_preflight(_state: GLTFState, extensions: PackedStringArray) -> Error:
	return OK if extensions.has(EXT) else ERR_SKIP


static func _components(acc: GLTFAccessor) -> int:
	match acc.accessor_type:
		GLTFAccessor.TYPE_SCALAR:
			return 1
		GLTFAccessor.TYPE_VEC2:
			return 2
		GLTFAccessor.TYPE_VEC3:
			return 3
		GLTFAccessor.TYPE_VEC4:
			return 4
	return 0


## The floats of an accessor (count × components), or an error string.
static func _read(state: GLTFState, index: int, what: String, allowed: Array) -> Variant:
	var accessors := state.get_accessors()
	if index < 0 or index >= accessors.size():
		return "%s names accessor %d, which the file does not have" % [what, index]
	var acc: GLTFAccessor = accessors[index]
	var n := _components(acc)
	if not allowed.has(n):
		return "%s has %d components per instance; %s are read" % [what, n, " or ".join(allowed.map(func(x): return str(x)))]
	if acc.component_type != GLTFAccessor.COMPONENT_TYPE_SINGLE_FLOAT:
		return "%s is not float32 (component type %d); TopoTopo writes float32" % [what, acc.component_type]
	if acc.sparse_count > 0:
		return "%s is a sparse accessor, which is not read" % what
	var views := state.get_buffer_views()
	if acc.buffer_view < 0 or acc.buffer_view >= views.size():
		return "%s has no buffer view" % what
	var bv: GLTFBufferView = views[acc.buffer_view]
	var data := bv.load_buffer_view_data(state)
	var start := acc.byte_offset
	var stride := bv.byte_stride
	if stride <= 0 or stride == n * 4:
		if start + acc.count * n * 4 > data.size():
			return "%s reads past the end of its buffer view" % what
		return data.slice(start, start + acc.count * n * 4).to_float32_array()
	var out := PackedFloat32Array()
	out.resize(acc.count * n)
	for i in acc.count:
		var at := start + i * stride
		if at + n * 4 > data.size():
			return "%s reads past the end of its buffer view" % what
		var row := data.slice(at, at + n * 4).to_float32_array()
		for c in n:
			out[i * n + c] = row[c]
	return out


func _import_node(state: GLTFState, _gltf_node: GLTFNode, json: Dictionary, node: Node) -> Error:
	if not json.has("extensions") or typeof(json["extensions"]) != TYPE_DICTIONARY or not json["extensions"].has(EXT):
		return OK
	var file := state.filename if state.filename != "" else state.base_path
	var attrs = json["extensions"][EXT].get("attributes", {})
	if typeof(attrs) != TYPE_DICTIONARY:
		push_error("TopoTopo: %s: node %s: %s has no attributes" % [file, node.name, EXT])
		return ERR_INVALID_DATA
	var t = _read(state, int(attrs.get("TRANSLATION", -1)), "TRANSLATION", [3]) if attrs.has("TRANSLATION") else null
	var r = _read(state, int(attrs.get("ROTATION", -1)), "ROTATION", [4]) if attrs.has("ROTATION") else null
	var s = _read(state, int(attrs.get("SCALE", -1)), "SCALE", [3]) if attrs.has("SCALE") else null
	var col = _read(state, int(attrs.get("_COLOR", -1)), "_COLOR", [3, 4]) if attrs.has("_COLOR") else null
	for v in [t, r, s, col]:
		if typeof(v) == TYPE_STRING:
			push_error("TopoTopo: %s: node %s: %s" % [file, node.name, v])
			return ERR_INVALID_DATA
	var count := -1
	for pair in [[t, 3], [r, 4], [s, 3]]:
		if pair[0] != null:
			var c: int = pair[0].size() / pair[1]
			if count >= 0 and c != count:
				push_error("TopoTopo: %s: node %s: the instance attributes have different counts" % [file, node.name])
				return ERR_INVALID_DATA
			count = c
	if count < 0:
		push_error("TopoTopo: %s: node %s: %s names no TRANSLATION, ROTATION or SCALE" % [file, node.name, EXT])
		return ERR_INVALID_DATA
	for k in attrs.keys():
		if String(k).begins_with("_") and k != "_COLOR":
			push_warning("TopoTopo: %s: node %s: the instance attribute %s is dropped (a MultiMesh carries transforms and colours only)" % [file, node.name, k])
	# one MultiMesh row per instance: T·R·S, the basis by columns (scaled_local), 12 floats in MultiMesh 3D order
	var rows := PackedFloat32Array()
	rows.resize(count * 12)
	for i in count:
		var q := Quaternion(r[i * 4], r[i * 4 + 1], r[i * 4 + 2], r[i * 4 + 3]) if r != null else Quaternion.IDENTITY
		var b := Basis(q)
		if s != null:
			b = b.scaled_local(Vector3(s[i * 3], s[i * 3 + 1], s[i * 3 + 2]))
		var o := Vector3(t[i * 3], t[i * 3 + 1], t[i * 3 + 2]) if t != null else Vector3.ZERO
		var k := i * 12
		rows[k] = b.x.x
		rows[k + 1] = b.y.x
		rows[k + 2] = b.z.x
		rows[k + 3] = o.x
		rows[k + 4] = b.x.y
		rows[k + 5] = b.y.y
		rows[k + 6] = b.z.y
		rows[k + 7] = o.y
		rows[k + 8] = b.x.z
		rows[k + 9] = b.y.z
		rows[k + 10] = b.z.z
		rows[k + 11] = o.z
	node.set_meta("topotopo_instances", rows)
	if col != null:
		var size: int = col.size() / count if count > 0 else 4
		var colors := PackedFloat32Array()
		colors.resize(count * 4)
		for i in count:
			colors[i * 4] = col[i * size]
			colors[i * 4 + 1] = col[i * size + 1]
			colors[i * 4 + 2] = col[i * size + 2]
			colors[i * 4 + 3] = col[i * size + 3] if size == 4 else 1.0
		node.set_meta("topotopo_instance_colors", colors)
	return OK
