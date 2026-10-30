@tool
extends EditorPlugin
## Drives the addon's window flow in a headless editor (step 11 of npm run test:godot): it adds the window's parts to
## the TopoTopo plugin (panel, context menu, inspector), turns on Godot's "Import Resources When Unfocused" (a headless
## editor never has focus), then changes a package's files the way TopoTopo's viewer or an agent does and checks what
## the editor does: a background cook while the editor keeps running frames, the changed GLB reimported, a broken graph
## failing the .topo and keeping the GLB, no cook loop, a deleted output restored, a no-op recook leaving the imports.
## Prints PASS/FAIL lines and quits with 1 on a failure.
##   godot --headless --editor --path <project>   (with res://tests/live/plugin.cfg enabled)

const PROPS := "res://assets/props/props.topo"
const CRATE := "res://assets/props/outputs/crate/crate.glb"
const SCATTER := "res://assets/props/outputs/scatter/scatter.glb"
const GRAPH := "res://assets/props/graphs/crate.json"

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
	check(await until(idle, 120.0), "the editor starts and settles (first scan done, nothing cooking)")
	EditorInterface.get_editor_settings().set_setting("interface/editor/behavior/import_resources_when_unfocused", true)
	EditorInterface.get_editor_settings().set_setting("filesystem/import/topotopo/watch_interval", 0.2)
	host.add_window_parts()
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

	# an edit, as TopoTopo's viewer saves it: a background cook while the editor runs, then the GLB is reimported
	var before := imported_md5(CRATE)
	var seq0: int = host.runner._seq
	edit_graph(func(g): g.nodes.paint.params.roughness = 0.35)
	var started := await until(func(): return host.packages[PROPS].cooking, 10.0)
	var frame0 := Engine.get_process_frames()
	check(started, "the watcher sees the edited graph and starts a background cook")
	var done := await until(func(): return idle() and imported_md5(CRATE) == FileAccess.get_md5(CRATE) and imported_md5(CRATE) != before, 120.0)
	check(done, "crate.glb is cooked and reimported (Godot's import saw its new bytes)")
	check(Engine.get_process_frames() - frame0 > 5, "the editor kept running frames during the cook (%d)" % (Engine.get_process_frames() - frame0))
	check(host.runner._seq == seq0 + 1 and host.packages[PROPS].fresh.state == "ok", "one cook, and the package is current")
	await until(func(): return host.topo_import_valid(PROPS), 5.0)
	check(host.topo_import_valid(PROPS), "the .topo import is valid")

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

	# a package that does not open (a broken manifest): one cook says why, then nothing until its files change
	var manifest := FileAccess.get_file_as_string(PROPS)
	var mf := FileAccess.open(PROPS, FileAccess.WRITE)
	mf.store_string("{ not json")
	mf.close()
	check(await until(func(): return idle() and host.packages[PROPS].error != "", 60.0), "a broken manifest: the package says why: %s" % String(host.packages[PROPS].error).get_slice("\n", 0))
	var seq2: int = host.runner._seq
	await wait(2.0)
	check(host.runner._seq == seq2, "no cook loop on a package that does not open")
	mf = FileAccess.open(PROPS, FileAccess.WRITE)
	mf.store_string(manifest)
	mf.close()
	check(await until(func(): return idle() and host.packages[PROPS].fresh.state == "ok", 60.0), "the manifest restored: the package is current")

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

	print("live: %d passed, %d failed" % [passes, failures])
	get_tree().quit(1 if failures else 0)
