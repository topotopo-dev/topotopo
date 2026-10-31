@tool
extends EditorPlugin
## Drives the addon's window flow in a headless editor (step 11 of npm run test:godot; TOPOTOPO_GODOT_WINDOW=1 makes the
## TopoTopo plugin work as with a window: panel, context menu, inspector, background cooks). It turns on Godot's
## "Import Resources When Unfocused" (a headless editor never has focus), checks the startup cook of a package never
## cooked, then changes a package's files the way TopoTopo's viewer or an agent does and checks what the editor does:
## a background cook while the editor keeps running frames, the changed GLB reimported, a broken graph failing the
## .topo and keeping the GLB, no cook loop, a deleted output restored, a no-op recook leaving the imports.
## Prints PASS/FAIL lines and quits with 1 on a failure.
##   TOPOTOPO_GODOT_WINDOW=1 godot --headless --editor --path <project>   (with res://tests/live/plugin.cfg enabled)

const PROPS := "res://assets/props/props.topo"
const CRATE := "res://assets/props/outputs/crate/crate.glb"
const SCATTER := "res://assets/props/outputs/scatter/scatter.glb"
const GRAPH := "res://assets/props/graphs/crate.json"
const KIT := "res://assets/kit/kit.topo"
const KIT_GLB := "res://assets/kit/outputs/kit/kit.glb"

var host: EditorPlugin
var failures := 0
var passes := 0


func _enter_tree() -> void:
	_run.call_deferred()


func check(ok: bool, what: String) -> void:
	if ok:
		passes += 1
	else:
		failures += 1
	print("%s %s" % ["PASS" if ok else "FAIL", what])


## Wait (running frames) until `cond` holds or `seconds` pass; returns whether it held.
func until(cond: Callable, seconds: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while not cond.call():
		if Time.get_ticks_msec() - t0 > seconds * 1000.0:
			return false
		await get_tree().process_frame
	return true


func wait(seconds: float) -> void:
	await get_tree().create_timer(seconds).timeout


func idle() -> bool:
	var efs := EditorInterface.get_resource_filesystem()
	return host.first_scan_done and host.runner.runs.is_empty() and not efs.is_scanning() and not efs.is_importing() and not host.packages.get(PROPS, {}).get("cooking", false)


## The md5 Godot's last import of a file saw ("" when it has none).
static func imported_md5(file: String) -> String:
	var cf := ConfigFile.new()
	if cf.load("res://.godot/imported/%s-%s.md5" % [file.get_file(), file.md5_text()]) != OK:
		return ""
	return String(cf.get_value("", "source_md5", ""))


func edit_graph(fn: Callable) -> void:
	var g = JSON.parse_string(FileAccess.get_file_as_string(GRAPH))
	fn.call(g)
	var f := FileAccess.open(GRAPH, FileAccess.WRITE)
	f.store_string(JSON.stringify(g, "  ") + "\n")
	f.close()


func _run() -> void:
	for n in get_parent().get_children():
		if n is EditorPlugin and n.get_script() and n.get_script().resource_path == "res://addons/topotopo/plugin.gd":
			host = n
	check(host != null, "the TopoTopo plugin is loaded")
	if host == null:
		get_tree().quit(1)
		return
	check(not host.headless and host._dock != null, "TOPOTOPO_GODOT_WINDOW=1: the plugin works as with a window (panel, background cooks)")
	# a headless editor never has focus: Godot's own setting lets imports run unfocused
	EditorInterface.get_editor_settings().set_setting("interface/editor/behavior/import_resources_when_unfocused", true)
	EditorInterface.get_editor_settings().set_setting("filesystem/import/topotopo/watch_interval", 0.2)
	# the kit was never cooked: at startup it cooks in the background, and its GLB, in a new folder, is imported
	check(await until(func(): return idle() and host.packages.get(KIT, {}).get("fresh", {}).get("state") == "ok" and imported_md5(KIT_GLB) != "" and imported_md5(KIT_GLB) == FileAccess.get_md5(KIT_GLB), 120.0),
		"at startup the never-cooked kit cooks in the background and its new GLB is imported")
	check(await until(func(): return host.topo_import_valid(KIT), 10.0), "the kit's .topo import is valid")
	await wait(0.5)

	# the panel, the context menu, the inspector
	var dock = host._dock
	check(dock is EditorDock and dock.title == "TopoTopo" and dock.default_slot == EditorDock.DOCK_SLOT_BOTTOM, "the panel is an EditorDock in the bottom slot")
	dock.refresh()
	var rows := []
	var item: TreeItem = dock._tree.get_root().get_first_child() if dock._tree.get_root() else null
	while item:
		rows.append("%s|%s" % [item.get_text(0), item.get_text(1)])
		item = item.get_next()
	check(rows.size() == 2 and rows.any(func(r): return r.begins_with("props") and r.ends_with("|ok")), "the panel lists the packages: %s" % ", ".join(rows))
	check(dock._status.text.begins_with("TopoTopo %s at " % host.runner.version), "the panel says which TopoTopo cooks: %s" % dock._status.text)
	check(host.package_of_file(CRATE) == PROPS and host.package_of_file(PROPS) == PROPS and host.package_of_file("res://project.godot") == "", "the context menu's files: an output and the .topo belong to their package, other files to none")
	check(host._inspector._can_handle(load(PROPS)), "the inspector shows a header on the package's status resource")
	# Project > Tools > TopoTopo > Show TopoTopo Panel brings the panel back after it was closed
	dock.close()
	await get_tree().process_frame
	var closed: bool = not dock.is_visible_in_tree()
	host._on_menu(2)
	await get_tree().process_frame
	check(closed and dock.is_visible_in_tree() and dock.get_parent().get_class() == "EditorBottomPanel", "Show TopoTopo Panel opens the closed panel again, in the bottom panel")

	# an edit, as TopoTopo's viewer saves it: a background cook while the editor runs, then the GLB is reimported
	var before := imported_md5(CRATE)
	var seq0: int = host.runner._seq
	edit_graph(func(g): g.nodes.paint.params.roughness = snappedf(fmod(float(g.nodes.paint.params.roughness) + 0.07, 1.0), 0.01))
	var started := await until(func(): return host.packages[PROPS].cooking, 10.0)
	var frame0 := Engine.get_process_frames()
	check(started, "the watcher sees the edited graph and starts a background cook")
	var done := await until(func(): return idle() and imported_md5(CRATE) == FileAccess.get_md5(CRATE) and imported_md5(CRATE) != before, 120.0)
	check(done, "crate.glb is cooked and reimported (Godot's import saw its new bytes)")
	check(Engine.get_process_frames() - frame0 > 5, "the editor kept running frames during the cook (%d)" % (Engine.get_process_frames() - frame0))
	check(host.runner._seq == seq0 + 1 and host.packages[PROPS].fresh.state == "ok", "one cook, and the package is current")
	await until(func(): return host.topo_import_valid(PROPS), 5.0)
	check(host.topo_import_valid(PROPS), "the .topo import is valid")
	_check_materials()
	await _check_scene_reload()

	# a broken graph: the GLB stays, the .topo import fails, the panel shows the error, nothing cooks again by itself
	var good := FileAccess.get_md5(CRATE)
	edit_graph(func(g): g.nodes.body["in"] = ["nowhere"])
	check(await until(func(): return idle() and host.packages[PROPS].fresh.state == "failed" and not host.topo_import_valid(PROPS), 60.0), "a broken graph: the package is failed and the .topo import is failed")
	check(FileAccess.get_md5(CRATE) == good, "crate.glb keeps its last good bytes")
	dock.refresh()
	var errors := []
	var pk: TreeItem = dock._tree.get_root().get_first_child()
	while pk:
		var o := pk.get_first_child()
		while o:
			if o.get_first_child():
				errors.append(o.get_first_child().get_text(0) + " " + o.get_first_child().get_text(2))
			o = o.get_next()
		pk = pk.get_next()
	check(errors.size() == 1 and errors[0].begins_with("[body] "), "the panel shows the error under its output: %s" % ", ".join(errors))
	var seq1: int = host.runner._seq
	await wait(2.0)
	check(host.runner._seq == seq1, "no cook loop on a failed output")
	edit_graph(func(g): g.nodes.body.erase("in"))
	check(await until(func(): return idle() and host.packages[PROPS].fresh.state == "ok" and host.topo_import_valid(PROPS), 60.0), "fixed: the package is current and the .topo imports again")

	# Unreadable JSON in a hidden graph is an error, not the deliberate removal of its outputs.
	var graph_text := FileAccess.get_file_as_string(GRAPH)
	var seq_json: int = host.runner._seq
	var broken_graph := FileAccess.open(GRAPH, FileAccess.WRITE)
	broken_graph.store_string("{ not json")
	broken_graph.close()
	check(await until(func(): return idle() and host.packages[PROPS].error != "" and not host.topo_import_valid(PROPS), 60.0),
		"malformed graph JSON fails the package import and keeps its last good record")
	await wait(2.0)
	check(host.runner._seq == seq_json + 1 and FileAccess.get_md5(CRATE) == good, "malformed graph JSON keeps the GLB and is not retried until edited")
	broken_graph = FileAccess.open(GRAPH, FileAccess.WRITE)
	broken_graph.store_string(graph_text)
	broken_graph.close()
	check(await until(func(): return idle() and host.packages[PROPS].fresh.state == "ok" and host.topo_import_valid(PROPS), 60.0), "restoring graph JSON restores the valid import")

	# a package that does not open (a broken manifest): one cook says why, then nothing until its files change
	var manifest := FileAccess.get_file_as_string(PROPS)
	var seq_broken: int = host.runner._seq
	var mf := FileAccess.open(PROPS, FileAccess.WRITE)
	mf.store_string("{ not json")
	mf.close()
	check(await until(func(): return idle() and host.packages[PROPS].error != "" and not host.topo_import_valid(PROPS), 60.0), "a broken manifest: the .topo import fails and the package says why: %s" % String(host.packages[PROPS].error).get_slice("\n", 0))
	var seq2: int = host.runner._seq
	await wait(2.0)
	check(host.runner._seq == seq2 and seq2 - seq_broken == 1, "one cook, and no cook loop on a package that does not open (%d)" % (host.runner._seq - seq_broken))
	mf = FileAccess.open(PROPS, FileAccess.WRITE)
	mf.store_string(manifest)
	mf.close()
	check(await until(func(): return idle() and host.packages[PROPS].fresh.state == "ok" and host.packages[PROPS].error == "" and host.topo_import_valid(PROPS), 60.0), "the manifest restored: the package is current, its error gone, its .topo import valid")

	# an output renamed in its graph leaves its old file as an orphan; Remove Orphans deletes it and the record forgets it
	edit_graph(func(g):
		g.outputs["box_crate"] = g.outputs["crate"]
		g.outputs.erase("crate"))
	var orphan_glb := CRATE
	check(await until(func(): return idle() and host.packages[PROPS].fresh.state == "ok" and host.packages[PROPS].record.get("orphans", {}).has(orphan_glb), 60.0),
		"a renamed output: its old GLB is kept as an orphan (%s)" % JSON.stringify(host.packages[PROPS].record.get("orphans", {})))
	var reference := orphan_glb.get_base_dir().path_join("crate_reference.png")
	var image := Image.create(2, 2, false, Image.FORMAT_RGBA8)
	image.fill(Color.BLUE)
	image.save_png(reference)
	host.remove_orphans(PROPS)
	check(FileAccess.file_exists(reference), "Remove Orphans keeps an unrelated image with the same filename prefix")
	check(await until(func(): return idle() and not FileAccess.file_exists(orphan_glb) and host.packages[PROPS].record.get("orphans", {}).is_empty() and imported_md5(reference) == FileAccess.get_md5(reference), 60.0), "Remove Orphans deletes it, and the record forgets it")
	# Let the rescan finish before removing the probe's image, so it cannot disappear during its import.
	for suffix in ["", ".import", ".uid"]:
		if FileAccess.file_exists(reference + suffix):
			DirAccess.remove_absolute(reference + suffix)
	edit_graph(func(g):
		g.outputs["crate"] = g.outputs["box_crate"]
		g.outputs.erase("box_crate"))
	check(await until(func(): return idle() and FileAccess.file_exists(CRATE) and host.packages[PROPS].fresh.state == "ok" and imported_md5(CRATE) == FileAccess.get_md5(CRATE), 60.0), "renamed back: crate.glb is cooked and imported again")
	host.remove_orphans(PROPS)
	check(await until(func(): return idle() and host.packages[PROPS].record.get("orphans", {}).is_empty() and not DirAccess.dir_exists_absolute("res://assets/props/outputs/box_crate"), 60.0),
		"and box_crate.glb, now the orphan, is removed the same way, with the texture Godot extracted beside it and its folder")

	# a deleted output comes back
	DirAccess.remove_absolute(ProjectSettings.globalize_path(SCATTER))
	check(await until(func(): return idle() and FileAccess.file_exists(SCATTER), 60.0), "a deleted output is cooked again")

	# a recook that changes nothing leaves every file and import as it was
	var stamps := {}
	for f in [CRATE, SCATTER]:
		stamps[f] = [FileAccess.get_modified_time(f), imported_md5(f)]
	host.cook_now([PROPS], true)
	check(await until(func(): return host.packages[PROPS].cooking, 5.0) and await until(idle, 60.0), "Recook runs in the background")
	var same := true
	for f in stamps:
		same = same and stamps[f] == [FileAccess.get_modified_time(f), imported_md5(f)]
	var states := {}
	for o in host.packages[PROPS].report.get("outputs", []):
		states[o.id] = o.state
	check(same and states.get("crate") == "unchanged", "a no-op recook writes nothing and imports nothing (%s)" % JSON.stringify(states))

	# Show Cook Report prints the last report to Output and shows the panel (scripts/test-godot.mjs reads the log)
	host.show_report(PROPS)

	print("live: %d passed, %d failed" % [passes, failures])
	get_tree().quit(1 if failures else 0)


## Texture extraction can import a nested batch while the GLB imports. Check the actual open scene, not just its md5.
func _check_scene_reload() -> void:
	const SCENE := "res://live_reload.tscn"
	var f := FileAccess.open(SCENE, FileAccess.WRITE)
	f.store_string('[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="%s" id="1"]\n[node name="LiveReload" type="Node3D"]\n[node name="Crate" parent="." instance=ExtResource("1")]\n' % CRATE)
	f.close()
	EditorInterface.get_resource_filesystem().scan()
	await until(func(): return not EditorInterface.get_resource_filesystem().is_scanning(), 10.0)
	EditorInterface.open_scene_from_path(SCENE)
	var opened := await until(func(): return EditorInterface.get_edited_scene_root() != null and EditorInterface.get_edited_scene_root().scene_file_path == SCENE, 10.0)
	check(opened, "open a scene with an imported instance for the live geometry check")
	if not opened:
		return
	EditorInterface.get_edited_scene_root().get_node("Crate").position.x = 2.5
	EditorInterface.mark_scene_as_unsaved()
	var image := Image.create(2, 2, false, Image.FORMAT_RGBA8)
	image.fill(Color.RED)
	image.save_png("res://assets/props/inputs/decal.png")
	var before := imported_md5(CRATE)
	edit_graph(func(g):
		g.nodes.body.params.size[0] = 0.91
		g.nodes.coarse.params.size[0] = 0.91)
	check(await until(func(): return idle() and imported_md5(CRATE) != before and imported_md5(CRATE) == FileAccess.get_md5(CRATE), 60.0), "a geometry and embedded texture edit is cooked and imported")
	check(await until(func():
		var root := EditorInterface.get_edited_scene_root()
		var mesh := root.get_node_or_null("Crate/crate_lod0") as MeshInstance3D
		return mesh != null and is_equal_approx(mesh.mesh.get_aabb().size.x, 0.91), 10.0), "the already-placed instance gets its new geometry after nested texture imports")
	check(is_equal_approx(EditorInterface.get_edited_scene_root().get_node("Crate").position.x, 2.5), "live scene refresh preserves the instance's unsaved transform")
	EditorInterface.close_scene()
	for suffix in ["", ".uid"]:
		if FileAccess.file_exists(SCENE + suffix):
			DirAccess.remove_absolute(SCENE + suffix)


## Converting one instance must not change other users of its mesh or lose import material overrides.
func _check_materials() -> void:
	for coloured in [false, true]:
		for global_override in [false, true]:
			var scene := Node3D.new()
			var mesh := ArrayMesh.new()
			var shape := BoxMesh.new()
			var base := StandardMaterial3D.new()
			for i in 2:
				mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, shape.get_mesh_arrays())
				mesh.surface_set_material(i, base)
			var shadow := ArrayMesh.new()
			shadow.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, shape.get_mesh_arrays())
			mesh.shadow_mesh = shadow
			var plain := MeshInstance3D.new()
			plain.mesh = mesh
			scene.add_child(plain)
			var marked := MeshInstance3D.new()
			marked.mesh = mesh
			scene.add_child(marked)
			var material := StandardMaterial3D.new()
			material.albedo_color = Color.BLUE
			if global_override:
				marked.material_override = material
			else:
				marked.set_surface_override_material(1, material)
			marked.material_overlay = base
			marked.set_meta("topotopo_instances", PackedFloat32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]))
			if coloured:
				marked.set_meta("topotopo_instance_colors", PackedFloat32Array([1, 0.5, 0.5, 1]))
			host._post_import._post_process(scene)
			var converted: MultiMeshInstance3D = scene.get_child(1)
			var effective: BaseMaterial3D = converted.material_override if global_override else converted.multimesh.mesh.surface_get_material(1)
			check(mesh.surface_get_material(1) == base and not base.vertex_color_use_as_albedo,
				"MultiMesh leaves the shared mesh and its materials unchanged (coloured %s, override %s)" % [coloured, global_override])
			check(effective.albedo_color == Color.BLUE and effective.vertex_color_use_as_albedo == coloured and converted.material_overlay == base,
				"MultiMesh preserves the effective override and overlay (coloured %s, override %s)" % [coloured, global_override])
			check(converted.multimesh.mesh.shadow_mesh == shadow, "MultiMesh keeps the shadow mesh")
			scene.free()
