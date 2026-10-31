@tool
extends EditorPlugin
## TopoTopo's Godot addon. A TopoTopo package inside the project imports as <id>.topo; its published outputs are cooked
## (topotopo cook --jobs …) into plain GLBs and PNGs that Godot imports itself, and kept current while the package's
## files change. PROTOCOL.md in the TopoTopo repository is the contract with the command line.
##
## This script is the hub: it registers the importer, the glTF instancing extension and its post-import step, the
## export filter, the context menu, the inspector header, the dock and the editor settings; it keeps the packages'
## state, runs cooks through runner.gd and imports what they wrote. watcher.gd decides when to cook.

const PROTOCOL := 1
const Record := preload("record.gd")
const Runner := preload("runner.gd")
const Importer := preload("package_importer.gd")
const Instancing := preload("gltf_instancing.gd")
const PostImport := preload("instances_post_import.gd")
const ExportFilter := preload("export_filter.gd")
const ContextMenu := preload("context_menu.gd")
const Inspector := preload("inspector.gd")
const Dock := preload("dock.tscn")
const Watcher := preload("watcher.gd")

const SETTING := "filesystem/import/topotopo/"
const UNFOCUSED := "interface/editor/behavior/import_resources_when_unfocused"
const MENU := "TopoTopo"

## The packages' state changed (the dock and the inspector redraw).
signal packages_changed

## The project folder (absolute, no trailing slash).
var project := ""
var record: Record
var runner: Runner
var headless := false
## res:// of each .topo -> its state: {topo, abs, dir, id, fresh, record, report, cooking, progress, error, crashed,
## last_ms, last_time, copy, root}
var packages := {}
var first_scan_done := false

var _importer: Importer
var _instancing: Instancing
var _post_import: PostImport
var _export_filter: ExportFilter
var _context_menu: ContextMenu
var _inspector: Inspector
var _dock: Control
var _watcher: Node
var _menu: PopupMenu

var _batch_depth := 0
var _batch := PackedStringArray()
## Godot's nested texture import can clear its outer scene-reload list. Reimport those scenes once after
## the outer batch finishes, when their extracted textures are current. Let Godot preserve the edited instances.
var _nested_scenes := {}
var _scene_retry_md5 := {}
var _force_reimport := {}
var _flushing := false
## Files a cook wrote, to import (res:// -> true when the import waits for the focus rule).
var _pending := {}
## .topo files whose status resource may be behind their record: res:// -> {gated (waits for the focus rule),
## written (a cook rewrote the record)}.
var _refresh := {}
## What each .topo's last import saw (res:// -> {record: the record's md5, state: its freshness state}).
var _imported := {}
var _said_missing := false
var _said_skipped := {}
var _viewers := {}
var _flush_queued := false
var _tries := {}


func _get_plugin_name() -> String:
	return "TopoTopo"


func _enter_tree() -> void:
	# a headless editor (--import, --export-*) cooks before its first scan and has no window parts;
	# TOPOTOPO_GODOT_WINDOW=1 makes one work as with a window (the tests drive the window's flow that way)
	headless = DisplayServer.get_name() == "headless" and OS.get_environment("TOPOTOPO_GODOT_WINDOW") != "1"
	project = ProjectSettings.globalize_path("res://").replace("\\", "/").trim_suffix("/")
	record = Record.new()
	_register_settings()
	runner = Runner.new(project, editor_settings())
	_importer = Importer.new()
	_importer.host = self
	add_import_plugin(_importer)
	_instancing = Instancing.new()
	GLTFDocument.register_gltf_document_extension(_instancing)
	_post_import = PostImport.new()
	add_scene_post_import_plugin(_post_import)
	_export_filter = ExportFilter.new()
	_export_filter.host = self
	add_export_plugin(_export_filter)
	var efs := EditorInterface.get_resource_filesystem()
	efs.resources_reimporting.connect(_on_reimporting)
	efs.resources_reimported.connect(_on_reimported)
	efs.filesystem_changed.connect(_on_filesystem_changed)
	_watcher = Watcher.new()
	_watcher.host = self
	add_child(_watcher)
	if not headless:
		add_window_parts()
	_startup()


## The parts of the editor's window: the context menu, the inspector header, the panel, Project > Tools > TopoTopo, and
## the reaction to settings. A headless editor (--import, --export-*) has none, and cooks before its first scan
## instead of in the background.
func add_window_parts() -> void:
	if _dock:
		return
	_context_menu = ContextMenu.new()
	_context_menu.host = self
	add_context_menu_plugin(EditorContextMenuPlugin.CONTEXT_SLOT_FILESYSTEM, _context_menu)
	_inspector = Inspector.new()
	_inspector.host = self
	add_inspector_plugin(_inspector)
	_dock = Dock.instantiate()
	_dock.host = self
	add_dock(_dock)
	_menu = PopupMenu.new()
	_menu.add_item("Cook Stale Packages", 0)
	_menu.add_item("Recook All", 1)
	_menu.add_separator()
	_menu.add_item("Show TopoTopo Panel", 2)
	_menu.id_pressed.connect(_on_menu)
	add_tool_submenu_item(MENU, _menu)
	EditorInterface.get_editor_settings().settings_changed.connect(_on_settings_changed)


func _exit_tree() -> void:
	var efs := EditorInterface.get_resource_filesystem()
	if efs.resources_reimporting.is_connected(_on_reimporting):
		efs.resources_reimporting.disconnect(_on_reimporting)
		efs.resources_reimported.disconnect(_on_reimported)
		efs.filesystem_changed.disconnect(_on_filesystem_changed)
	if EditorInterface.get_editor_settings().settings_changed.is_connected(_on_settings_changed):
		EditorInterface.get_editor_settings().settings_changed.disconnect(_on_settings_changed)
	runner.kill_all()
	for v in _viewers.values():
		if OS.is_process_running(v.pid):
			OS.kill(v.pid)
	_viewers.clear()
	if _menu:
		remove_tool_menu_item(MENU)
		_menu = null
	if _dock:
		remove_dock(_dock)
		_dock.queue_free()
		_dock = null
	if _inspector:
		remove_inspector_plugin(_inspector)
		_inspector.host = null
	if _context_menu:
		remove_context_menu_plugin(_context_menu)
		_context_menu.host = null
	remove_export_plugin(_export_filter)
	_export_filter.host = null
	remove_scene_post_import_plugin(_post_import)
	GLTFDocument.unregister_gltf_document_extension(_instancing)
	remove_import_plugin(_importer)
	_importer.host = null
	if _watcher:
		_watcher.queue_free()
		_watcher = null


# ------------------------------------------------------------------------------------------------------- settings

func _register_settings() -> void:
	var es := EditorInterface.get_editor_settings()
	var defs := [
		["topotopo_path", "", TYPE_STRING, PROPERTY_HINT_GLOBAL_FILE, "*.ts,*.js"],
		["node_path", "", TYPE_STRING, PROPERTY_HINT_GLOBAL_FILE, "*.exe" if OS.get_name() == "Windows" else ""],
		["live_cook", true, TYPE_BOOL, PROPERTY_HINT_NONE, ""],
		["watch_interval", 1.0, TYPE_FLOAT, PROPERTY_HINT_RANGE, "0,10,0.1,suffix:s"],
		["cook_timeout", 600.0, TYPE_FLOAT, PROPERTY_HINT_RANGE, "10,7200,1,suffix:s"],
	]
	for d in defs:
		var name: String = SETTING + d[0]
		if not es.has_setting(name):
			es.set_setting(name, d[1])
		es.set_initial_value(name, d[1], false)
		es.add_property_info({"name": name, "type": d[2], "hint": d[3], "hint_string": d[4]})


func editor_settings() -> Dictionary:
	var es := EditorInterface.get_editor_settings()
	var val := func(k: String, d): return es.get_setting(SETTING + k) if es.has_setting(SETTING + k) else d
	return {
		"topotopo_path": String(val.call("topotopo_path", "")), "node_path": String(val.call("node_path", "")),
		"live_cook": bool(val.call("live_cook", true)), "watch_interval": float(val.call("watch_interval", 1.0)),
		"cook_timeout": float(val.call("cook_timeout", 600.0)),
	}


func _on_settings_changed() -> void:
	var es := EditorInterface.get_editor_settings()
	if es.check_changed_settings_in_group(SETTING.trim_suffix("/")):
		var s := editor_settings()
		var where_changed: bool = s.topotopo_path != runner.settings.topotopo_path or s.node_path != runner.settings.node_path
		runner.settings = s
		if where_changed:
			_look_again()
		packages_changed.emit()
	elif es.check_changed_settings_in_group(UNFOCUSED):
		packages_changed.emit()
		queue_flush()


## Look for TopoTopo again (where it is was set): check every package, and cook the stale ones once it is found.
func _look_again() -> void:
	runner.reset()
	_said_missing = false
	check_all()
	if runner.found() and bool(runner.settings.get("live_cook", true)) and _watcher:
		var stale := []
		for t in packages:
			if is_stale(packages[t].fresh) and not packages[t].copy and not packages[t].root:
				stale.append(t)
		if stale.size():
			_watcher.cook_background(stale, false)


## Godot's own "Import Resources When Unfocused".
func import_when_unfocused() -> bool:
	var es := EditorInterface.get_editor_settings()
	return es.has_setting(UNFOCUSED) and bool(es.get_setting(UNFOCUSED))


func set_import_when_unfocused(on: bool) -> void:
	EditorInterface.get_editor_settings().set_setting(UNFOCUSED, on)


## Set where TopoTopo is (the editor setting), then look for it again.
func locate(path: String) -> void:
	EditorInterface.get_editor_settings().set_setting(SETTING + "topotopo_path", path)
	runner.settings = editor_settings()
	_look_again()
	packages_changed.emit()


# ------------------------------------------------------------------------------------------------------- packages

func _abs(res: String) -> String:
	return Record.res_to_abs(project, res)


func _res(abs_path: String) -> String:
	return Record.abs_to_res(project, abs_path)


## Find the packages Godot's scan sees (a .topo outside a .gdignore folder) and drop those that are gone.
func scan_packages() -> void:
	var seen := {}
	for abs_topo in Record.find_topos(project):
		var res := _res(abs_topo)
		if res == "":
			continue
		seen[res] = true
		if not packages.has(res):
			packages[res] = {
				"topo": res, "abs": abs_topo, "dir": abs_topo.get_base_dir(), "id": abs_topo.get_file().get_basename(),
				"fresh": {"state": "never_cooked", "why": "record", "path": "", "note": "", "text": "not checked yet"},
				"record": null, "report": null, "cooking": false, "progress": "", "error": "", "crashed": "",
				"last_ms": -1, "last_time": "", "copy": Record.is_published_copy(abs_topo),
				"root": abs_topo.get_base_dir() == project, "options": {},
			}
	for res in packages.keys():
		if not seen.has(res):
			packages.erase(res)


## The import options of a package, from its .topo.import (or `params` when given), as the record compares them.
func options_for(topo: String, params = null) -> Dictionary:
	var p: Dictionary = params if typeof(params) == TYPE_DICTIONARY else Record.import_params(_abs(topo))
	return Record.options_from_params(p, topo, project)


## Check a package's freshness now (and read its record); returns the freshness.
func check(topo: String, opts = null) -> Dictionary:
	if not packages.has(topo):
		scan_packages()
	var st = packages.get(topo)
	if st == null:
		return {"state": "stale", "why": "record", "path": "", "note": "", "text": "%s is not a package Godot sees" % topo}
	var o: Dictionary = opts if typeof(opts) == TYPE_DICTIONARY else options_for(topo)
	st.options = o
	if st.copy:
		st.fresh = {"state": "failed", "why": "copy", "path": "", "note": "", "text": "a published copy; hide its folder with .gdignore (topotopo godot setup)"}
		return st.fresh
	if st.root:
		st.fresh = {"state": "failed", "why": "root", "path": "", "note": "", "text": "a package at the project's root is not supported (its assets/ would hide the game's art): move it into a folder"}
		return st.fresh
	if o.has("error"):
		st.fresh = {"state": "stale", "why": "options", "path": "", "note": "", "text": o.error}
		return st.fresh
	var r := Record.read_record(st.dir)
	st.record = r.record
	if r.error != "":
		st.fresh = {"state": "stale", "why": "record", "path": "", "note": "", "text": r.error}
	else:
		st.fresh = record.freshness(st.dir, r.record, o, project, runner.version if runner.found() else "")
	if not is_stale(st.fresh) and not st.cooking:
		# what made the last cook fail is gone (its record is current)
		st.error = ""
		st.crashed = ""
	return st.fresh


func check_all() -> void:
	scan_packages()
	for topo in packages:
		check(topo)


static func is_stale(fr: Dictionary) -> bool:
	return fr.state == "stale" or fr.state == "never_cooked"


## Whether the last cook of a package did not finish it and its files are the same since (it is not cooked again by
## itself until they change; Recook retries).
func failed_unchanged(topo: String) -> bool:
	var st = packages.get(topo)
	return st != null and st.crashed != "" and st.error != "" and _watcher != null and not headless and _watcher.source_stamp(topo) == st.crashed


## The report file of a package's cooks (res://.godot/topotopo/<id>-<md5 of its res path>.report.json).
func report_path(topo: String) -> String:
	return project.path_join(".godot/topotopo/%s-%s.report.json" % [topo.get_file().get_basename(), topo.md5_text().substr(0, 12)])


## A package's job for the jobs file, with its options given explicitly.
func job_for(topo: String, opts = null) -> Dictionary:
	var o: Dictionary = opts if typeof(opts) == TYPE_DICTIONARY else options_for(topo)
	return {
		"package": _abs(topo), "into": o.folder, "per_output_folders": o.per_output_folders, "skip": Array(o.skip),
		"instancing": o.instancing, "report": report_path(topo), "timeout": runner.settings.cook_timeout,
	}


## Start a cook of packages (one process). `blocking`: wait for it. `gated`: what it writes waits for the focus rule
## before it is imported (a background cook). Returns the run, or {} when nothing could start.
func cook(topos: Array, force := false, blocking := false, gated := true, opts := {}) -> Dictionary:
	var jobs := []
	var selected := []
	for t in topos:
		if packages.has(t) and not packages[t].copy and not packages[t].root:
			var o: Dictionary = opts[t] if typeof(opts.get(t)) == TYPE_DICTIONARY else options_for(t)
			if o.has("error"):
				check(t, o)
				packages[t].error = o.error
				packages[t].crashed = _watcher.source_stamp(t) if _watcher and not headless else ""
				_error("TopoTopo: %s: %s" % [t, o.error])
				continue
			jobs.append(job_for(t, o))
			selected.append(t)
	if jobs.is_empty():
		packages_changed.emit()
		return {}
	var run := runner.start(jobs, force)
	if run.has("error"):
		for t in selected:
			if packages.has(t):
				packages[t].error = run.error
		_error("TopoTopo: the cook could not start: %s" % run.error)
		packages_changed.emit()
		return {}
	run.gated = gated
	for t in selected:
		if packages.has(t):
			packages[t].cooking = true
			packages[t].progress = "waiting"
			packages[t].error = ""
			# the package's files as this cook reads them: a cook that ends stale with the same files is not retried
			packages[t].cook_stamp = _watcher.source_stamp(t) if _watcher and not headless else ""
	packages_changed.emit()
	if blocking:
		runner.wait(run)
		collect(run)
	return run


## Wait for a package of a running cook (blocking), then take in what it did.
func wait_for(run: Dictionary, topo_abs: String) -> void:
	runner.wait_package(run, topo_abs)
	collect(run)


## Read the running cooks (non-blocking) and take in what finished.
func poll_runs() -> void:
	for run in runner.runs.duplicate():
		var events := runner.poll(run)
		for ev in events:
			var res := _res(String(ev.get("package", "")))
			if packages.has(res) and ev.get("event") == "output":
				var pk = run.packages.get(Runner._key(String(ev.package)))
				if pk:
					packages[res].progress = "cooking %s (%d of %d)" % [ev.get("output", ""), pk.finished, pk.total]
		if events.size():
			packages_changed.emit()
		collect(run)


## Take in every package of a run that finished and was not taken in yet.
func collect(run: Dictionary) -> void:
	for k in run.order:
		var pk = run.packages[k]
		if pk.done and not pk.get("handled", false):
			pk.handled = true
			_package_done(run, pk)
	if run.exited and not run.handled:
		run.handled = true
		if _watcher:
			_watcher.run_ended(run)


func _package_done(run: Dictionary, pk: Dictionary) -> void:
	var topo := _res(pk.topo)
	var st = packages.get(topo)
	if st == null:
		return
	st.cooking = false
	st.progress = ""
	var gated := bool(run.get("gated", true))
	var stamp: String = st.get("cook_stamp", "")
	if pk.crash != "":
		if run.killed == "restart":
			return
		st.error = pk.crash
		# not tried again until the package's files change (they may have changed while it cooked)
		st.crashed = stamp if stamp != "" else "crashed"
		_error("TopoTopo: %s: %s" % [st.id, pk.crash])
		toast("TopoTopo: %s did not cook: %s" % [st.id, pk.crash.get_slice("\n", 0)], EditorToaster.SEVERITY_ERROR)
		check(topo)
		_refresh[topo] = {"gated": gated, "written": false}
		packages_changed.emit()
		queue_flush()
		return
	var rep: Dictionary = pk.result
	st.report = rep
	st.error = ""
	st.crashed = ""
	st.last_ms = int(rep.get("ms", 0))
	st.last_time = Time.get_datetime_string_from_system(false, true)
	var written := []
	for o in rep.get("outputs", []):
		for f in o.get("written", []):
			_pending[f] = gated
		if not o.get("written", []).is_empty():
			written.append(o.id)
	for e in rep.get("errors", []):
		_error("TopoTopo: %s: %s" % [st.id, e])
	check(topo)
	if is_stale(st.fresh):
		# the package did not open, or its files changed while it cooked: say why. Files changed meanwhile cook again
		# (run_ended); the same files are not cooked again by themselves when the package did not open, nor after a second
		# cook that left its record stale (TopoTopo and this addon would disagree on them).
		st.error = String(rep.errors[0]) if rep.get("errors", []).size() else st.fresh.text
		var same: bool = stamp != "" and _watcher != null and _watcher.source_stamp(topo) == stamp
		if same and (rep.get("record") == "none" or int(st.get("retries", 0)) >= 1):
			st.crashed = stamp
			st.retries = 0
		else:
			st.retries = int(st.get("retries", 0)) + 1 if same else 0
	else:
		st.retries = 0
	_refresh[topo] = {"gated": gated, "written": rep.get("record") == "written" or written.size() > 0}
	if rep.get("ok", false) and written.size():
		toast("TopoTopo: %s updated: %s" % [st.id, ", ".join(written)], EditorToaster.SEVERITY_INFO)
	elif not rep.get("ok", false) and rep.get("errors", []).size():
		toast("TopoTopo: %s did not cook: %s" % [st.id, String(rep.errors[0])], EditorToaster.SEVERITY_ERROR)
	packages_changed.emit()
	queue_flush()


# --------------------------------------------------------------------------------------------- importing outputs

func _on_reimporting(paths: PackedStringArray) -> void:
	_batch_depth += 1
	if _batch_depth != 1:
		if not headless and not EditorInterface.get_open_scene_roots().is_empty():
			for f in _batch:
				if f.get_extension() == "glb" and package_of_file(f) != "":
					_nested_scenes[f] = true
		return
	_batch = paths
	# one cook process for every stale package of the batch; each .topo's _import waits for its package
	var stale := []
	var opts := {}
	for p in paths:
		if p.get_extension() != "topo":
			continue
		if not packages.has(p):
			scan_packages()
		if not packages.has(p) or not runner.found() or not runner.run_with(_abs(p)).is_empty():
			continue
		var o := options_for(p)
		var fr := check(p, o)
		if is_stale(fr) and (fr.why == "options" or not failed_unchanged(p)):
			stale.append(p)
			opts[p] = o
	if stale.size():
		cook(stale, false, false, false, opts)


func _on_reimported(_paths: PackedStringArray) -> void:
	_batch_depth = maxi(0, _batch_depth - 1)
	if _batch_depth == 0:
		for f in _nested_scenes:
			var md5 := FileAccess.get_md5(f)
			if md5 != "" and _scene_retry_md5.get(f, "") != md5:
				_scene_retry_md5[f] = md5
				_force_reimport[f] = true
				_pending[f] = true
		_nested_scenes.clear()
		_batch = PackedStringArray()
		queue_flush()


## The current import batch (the outermost resources_reimporting), empty outside one.
func batch() -> PackedStringArray:
	return _batch


## A .topo was imported with the record as it is now.
func imported(topo: String) -> void:
	var st = packages.get(topo)
	if st:
		_imported[topo] = {"record": FileAccess.get_md5(st.dir.path_join(Record.RECORD)), "state": st.fresh.state}
		_refresh.erase(topo)


## Whether a .topo's import is behind its package: valid while the package is not ok (or the other way round), or made
## from another record or state than now. When this session has not imported it, a record a cook rewrote (`written`)
## counts as behind.
func topo_behind(topo: String, written: bool) -> bool:
	var st = packages.get(topo)
	if st == null or not FileAccess.file_exists(st.abs):
		return false
	if topo_import_valid(topo) != (st.fresh.state == "ok"):
		return true
	var seen = _imported.get(topo)
	if seen != null:
		return seen.record != FileAccess.get_md5(st.dir.path_join(Record.RECORD)) or seen.state != st.fresh.state
	return written


## Import a .topo again once nothing else imports (and the focus rule allows it), if its import is behind.
func refresh_later(topo: String, written := false) -> void:
	_refresh[topo] = {"gated": not headless, "written": written}
	queue_flush()


func queue_flush() -> void:
	if _flush_queued:
		return
	_flush_queued = true
	_flush_deferred.call_deferred()


func _flush_deferred() -> void:
	_flush_queued = false
	flush()


## Whether imports may run now: Godot has focus, or its "Import Resources When Unfocused" is on (always headless).
func focus_allows() -> bool:
	if headless:
		return true
	if import_when_unfocused():
		return true
	var w := EditorInterface.get_base_control().get_window()
	return w != null and w.has_focus()


## Whether a file's import is missing or older than its bytes: "new", "changed" or "".
func needs_import(file: String) -> String:
	if not FileAccess.file_exists(_abs(file) + ".import"):
		return "new"
	var md5 := ConfigFile.new()
	if md5.load("res://.godot/imported/%s-%s.md5" % [file.get_file(), file.md5_text()]) != OK:
		return "changed"
	return "" if String(md5.get_value("", "source_md5", "")) == FileAccess.get_md5(file) else "changed"


## Import what cooks wrote, once nothing else imports: new files first, then changed ones, then the .topo files whose
## status resource is behind their record. Files Godot imported itself meanwhile are left alone. A file in a folder
## Godot's file system does not hold yet is found by a scan (Godot's update_file cannot add folders).
func flush() -> void:
	# Import progress can run editor frames and callbacks before reimport_files returns.
	if _flushing:
		return
	_flushing = true
	_flush()
	_flushing = false


func _flush() -> void:
	if _pending.is_empty() and _refresh.is_empty():
		return
	var efs := EditorInterface.get_resource_filesystem()
	if _batch_depth > 0 or efs.is_scanning() or efs.is_importing():
		return
	var allowed := focus_allows()
	var fresh_files := PackedStringArray()
	var changed := PackedStringArray()
	var unknown := {}
	for f in _pending.keys():
		var gated: bool = _pending[f]
		if gated and not allowed:
			continue
		_pending.erase(f)
		var force := _force_reimport.has(f)
		_force_reimport.erase(f)
		if not FileAccess.file_exists(_abs(f)):
			continue
		var need := needs_import(f)
		if need == "" and not force:
			continue
		if not _efs_knows(f):
			efs.update_file(f)
		if not _efs_knows(f):
			unknown[f] = gated
		elif need == "new":
			fresh_files.append(f)
		else:
			changed.append(f)
	var topos := PackedStringArray()
	for t in _refresh.keys():
		var r: Dictionary = _refresh[t]
		if r.gated and not allowed:
			continue
		_refresh.erase(t)
		if packages.has(t) and not packages[t].cooking:
			check(t)
			if topo_behind(t, r.written):
				topos.append(t)
	if fresh_files.size():
		efs.reimport_files(fresh_files)
	if changed.size():
		efs.reimport_files(changed)
	if unknown.size():
		if headless:
			_scan_now()
		else:
			# Godot's scan imports them; what it misses is imported on a later flush (three tries)
			for f in unknown:
				_tries[f] = int(_tries.get(f, 0)) + 1
				if _tries[f] <= 3:
					_pending[f] = unknown[f]
				else:
					_tries.erase(f)
					_warning("TopoTopo: %s was cooked but Godot's file system does not show it: rescan (FileSystem dock > Rescan)" % f)
			efs.scan_sources()
	if topos.size():
		if efs.is_scanning() or efs.is_importing():
			for t in topos:
				_refresh[t] = {"gated": false, "written": true}
		else:
			efs.reimport_files(topos)


func _efs_knows(file: String) -> bool:
	var dir := EditorInterface.get_resource_filesystem().get_filesystem_path(file.get_base_dir())
	return dir != null and dir.find_file_index(file.get_file()) >= 0


## Headless only: scan the project now and finish the scan on this thread, so that files the startup cook wrote in new
## folders are imported before --import quits (Godot's first scan took the folders before plugins loaded, and
## --import ends the frame after it).
func _scan_now() -> void:
	var efs := EditorInterface.get_resource_filesystem()
	efs.scan()
	var t0 := Time.get_ticks_msec()
	while efs.is_scanning() and Time.get_ticks_msec() - t0 < 600000:
		OS.delay_msec(5)
		efs.notification(Node.NOTIFICATION_PROCESS)


## Whether Godot holds a valid import of a .topo.
func topo_import_valid(topo: String) -> bool:
	var efs := EditorInterface.get_resource_filesystem()
	var dir := efs.get_filesystem_path(topo.get_base_dir())
	if dir == null:
		return false
	var i := dir.find_file_index(topo.get_file())
	return i >= 0 and dir.get_file_import_is_valid(i)


func _on_filesystem_changed() -> void:
	if not first_scan_done and not EditorInterface.get_resource_filesystem().is_scanning():
		_after_first_scan()
	else:
		scan_packages()
		packages_changed.emit()


## After the first scan: a .topo whose import is invalid but whose record is current now is imported again.
func _after_first_scan() -> void:
	if first_scan_done:
		return
	first_scan_done = true
	scan_packages()
	for topo in packages:
		var st = packages[topo]
		if st.copy or st.root or st.cooking:
			continue
		check(topo)
		if topo_behind(topo, false):
			_refresh[topo] = {"gated": false, "written": false}
	packages_changed.emit()
	queue_flush()


# --------------------------------------------------------------------------------------------------------- startup

## Editor start: every record is checked. Headless (--import, --export-*): stale packages cook now, in one process,
## so the first scan imports their new files. With a window: they cook in the background (watcher.gd).
func _startup() -> void:
	scan_packages()
	var stale := []
	for topo in packages:
		var st = packages[topo]
		if st.copy:
			_error("TopoTopo: %s is a published copy; hide its folder with .gdignore (topotopo godot setup %s)" % [topo, project])
			continue
		if st.root:
			_error("TopoTopo: %s: a package at the project's root is not supported (its assets/ would hide the game's art): move it into a folder" % topo)
			continue
		if is_stale(check(topo)):
			stale.append(topo)
	if stale.size() and not runner.found():
		for topo in stale:
			_warning("TopoTopo: %s: %s; TopoTopo is not set up here (%s), so the committed outputs are used" % [topo, packages[topo].fresh.text, runner.problem])
		# after the first scan, their .topo imports say it too (Godot's red ImportFail icon)
		say_missing_once()
	elif stale.size():
		if headless:
			print("TopoTopo: cooking %d stale package%s before the first scan: %s" % [stale.size(), "" if stale.size() == 1 else "s", ", ".join(stale)])
			cook(stale, false, true, false)
		elif bool(runner.settings.get("live_cook", true)):
			var newer := stale.filter(func(t): return packages[t].fresh.why == "version")
			if newer.size():
				toast("TopoTopo %s is newer than the one that cooked %d package%s: cooking %s again" % [runner.version, newer.size(), "" if newer.size() == 1 else "s", "it" if newer.size() == 1 else "them"], EditorToaster.SEVERITY_INFO)
			_watcher.cook_background(stale, false)
	if not headless:
		_watcher.rebaseline()
	_maybe_scanned.call_deferred()


func _maybe_scanned() -> void:
	var efs := EditorInterface.get_resource_filesystem()
	if not first_scan_done and not efs.is_scanning() and not efs.is_importing() and efs.get_filesystem().get_subdir_count() + efs.get_filesystem().get_file_count() > 0:
		_after_first_scan()


# ------------------------------------------------------------------------------------------------------- commands

## Cook the stale packages now (in the background). `force`: every package, ignoring records and the cache.
func cook_now(topos: Array, force: bool) -> void:
	if not runner.found():
		toast("TopoTopo is not set up: %s" % runner.problem, EditorToaster.SEVERITY_ERROR)
		return
	var list := []
	for t in topos:
		var st = packages.get(t)
		if st == null or st.copy or st.root:
			continue
		if force or is_stale(check(t)):
			list.append(t)
	if list.is_empty():
		toast("TopoTopo: every package is current", EditorToaster.SEVERITY_INFO)
		return
	_watcher.cook_background(list, force)


func _on_menu(id: int) -> void:
	check_all()
	match id:
		0:
			cook_now(packages.keys(), false)
		1:
			cook_now(packages.keys(), true)
		2:
			show_panel()


func show_panel() -> void:
	if _dock and _dock.has_method("make_visible"):
		_dock.make_visible()


## The package a file belongs to: its .topo, or the .topo whose record lists it as an output or orphan ("" for none).
func package_of_file(path: String) -> String:
	if path.get_extension() == "topo" and packages.has(path):
		return path
	for topo in packages:
		var rec = packages[topo].record
		if rec == null:
			continue
		if Record.output_files(rec).has(path) or (typeof(rec.get("orphans")) == TYPE_DICTIONARY and rec.orphans.has(path)):
			return topo
	return ""


## Open TopoTopo's live viewer on a package in the browser (one viewer per package for the session).
func open_in_topotopo(topo: String) -> void:
	var st = packages.get(topo)
	if st == null:
		return
	if not runner.found():
		toast("TopoTopo is not set up: %s" % runner.problem, EditorToaster.SEVERITY_ERROR)
		return
	var v = _viewers.get(st.dir)
	if v and OS.is_process_running(v.pid):
		if v.url != "":
			OS.shell_open(v.url)
		else:
			v.wanted = true
		return
	var p := OS.execute_with_pipe(runner.node, PackedStringArray([Runner.arg_path(runner.cli), "edit", Runner.arg_path(st.dir), "--json"]), false)
	if p.is_empty():
		toast("TopoTopo: the viewer could not start", EditorToaster.SEVERITY_ERROR)
		return
	_viewers[st.dir] = {"pid": p.pid, "stdio": p.stdio, "stderr": p.stderr, "buf": PackedByteArray(), "url": "", "wanted": true, "id": st.id}
	print("TopoTopo: starting the viewer on %s…" % st.id)


## Read the viewers' first line ({"url"}) and open it once it is there.
func poll_viewers() -> void:
	for dir in _viewers.keys():
		var v = _viewers[dir]
		var a: PackedByteArray = v.stdio.get_buffer(4096)
		v.stderr.get_buffer(65536)
		if a.size():
			var buf: PackedByteArray = v.buf
			buf.append_array(a)
			v.buf = buf
			var i := buf.find(10)
			if i >= 0 and v.url == "":
				var line = JSON.parse_string(buf.slice(0, i).get_string_from_ascii())
				if typeof(line) == TYPE_DICTIONARY and line.has("url"):
					v.url = String(line.url)
					print("TopoTopo: the viewer on %s is at %s" % [v.id, v.url])
		if v.url != "" and v.wanted:
			v.wanted = false
			OS.shell_open(v.url)
		if not OS.is_process_running(v.pid):
			if v.url == "":
				toast("TopoTopo: the viewer on %s stopped before it opened" % v.id, EditorToaster.SEVERITY_ERROR)
			_viewers.erase(dir)


## Remove the files a package's outputs no longer write (its orphans), with Godot's files beside them: their .import and
## .uid, the textures Godot extracted from an orphan GLB (<name>_<image>.png beside it), and the folder when that
## leaves it empty.
func remove_orphans(topo: String) -> void:
	var st = packages.get(topo)
	if st == null or st.record == null:
		return
	var orphans = st.record.get("orphans", {})
	var current := Record.output_files(st.record)
	var removed := []
	for f in orphans:
		if current.has(f):
			continue
		var a := _abs(f)
		var files := [a]
		if f.get_extension().to_lower() == "glb":
			var prefix := a.get_file().get_basename() + "_"
			# Only textures the imported scene actually uses. A matching filename alone does not make an image ours.
			for dependency in ResourceLoader.get_dependencies(f):
				var texture := dependency.get_slice("::", dependency.get_slice_count("::") - 1)
				if texture.begins_with("res://") and texture.get_base_dir() == f.get_base_dir() and texture.get_file().begins_with(prefix) \
						and ["png", "jpg", "jpeg", "webp"].has(texture.get_extension().to_lower()) and not current.has(texture):
					files.append(_abs(texture))
		for file in files:
			for side in ["", ".import", ".uid"]:
				if FileAccess.file_exists(file + side):
					DirAccess.remove_absolute(file + side)
		removed.append(f)
		if DirAccess.get_files_at(a.get_base_dir()).is_empty() and DirAccess.get_directories_at(a.get_base_dir()).is_empty():
			DirAccess.remove_absolute(a.get_base_dir())
	if removed.size():
		print("TopoTopo: %s: removed %s" % [st.id, ", ".join(removed)])
		EditorInterface.get_resource_filesystem().scan()
		# the record lists them until the next cook, which leaves out orphans that are gone: cook it now (its outputs
		# are carried over when current)
		if runner.found() and _watcher:
			_watcher.cook_background([topo], false)


## Print a package's last report to Output.
func show_report(topo: String) -> void:
	var st = packages.get(topo)
	if st == null:
		return
	var rep = st.report if st.report != null else Runner._read_report(report_path(topo))
	print("TopoTopo: %s (%s): %s" % [st.id, topo, st.fresh.text])
	if rep == null:
		print("  no cook report in this project yet (%s)" % report_path(topo))
	else:
		print("  last cook: %s, %d ms, record %s" % ["ok" if rep.get("ok") else "failed", int(rep.get("ms", 0)), rep.get("record", "")])
		for o in rep.get("outputs", []):
			print("  %s (%s): %s%s" % [o.id, o.get("kind", ""), o.state, (" → " + ", ".join(o.files)) if o.get("files", []).size() else ""])
			for e in o.get("errors", []):
				print("    %s%s%s" % ["[%s] " % e.node if e.node != "" else "", e.message, " (hint: %s)" % e.hint if e.hint != "" else ""])
			for w in o.get("warnings", []):
				print("    warning: %s" % w)
		for f in rep.get("orphans", []):
			print("  orphan (kept, no longer cooked): %s" % f)
		for e in rep.get("errors", []):
			print("  error: %s" % e)
	show_panel()


## Every package an export would ship stale, failed or never cooked: a line each for the export log.
func export_problems() -> PackedStringArray:
	check_all()
	var out := PackedStringArray()
	for topo in packages:
		var st = packages[topo]
		if st.fresh.state != "ok":
			out.append("%s: %s%s" % [st.id, st.fresh.state.replace("_", " "), (": " + st.fresh.text) if st.fresh.text != "" else ""])
	return out


## The message of a stale package when TopoTopo is not set up here.
func not_set_up_text(topo: String, fr: Dictionary) -> String:
	var st = packages.get(topo, {})
	var cooked: String = String(st.record.get("topotopo", "")) if st.get("record") != null else ""
	var what := ("%s has never been cooked" % topo.get_file()) if fr.state == "never_cooked" else ("%s: %s" % [topo.get_file(), fr.text])
	return "TopoTopo: %s and TopoTopo is not set up here (%s); %s. Set Editor Settings > FileSystem > Import > TopoTopo, or run topotopo godot setup %s." % [
		what, runner.problem, ("the committed outputs (cooked with %s) are still used" % cooked) if cooked != "" else "nothing can be imported until it is cooked", project]


## Once per session: a warning toast that TopoTopo is not set up, with the panel's Locate button.
func say_missing_once() -> void:
	if _said_missing:
		return
	_said_missing = true
	toast("TopoTopo is not set up here: stale packages keep their committed outputs (Locate TopoTopo… in the TopoTopo panel)", EditorToaster.SEVERITY_WARNING)


func say_skipped_once(topo: String, rec) -> void:
	if _said_skipped.has(topo) or typeof(rec) != TYPE_DICTIONARY:
		return
	_said_skipped[topo] = true
	var skipped = rec.get("skipped", {})
	for id in Record._sorted_keys(skipped):
		var why := String(skipped[id].get("why", "")) if typeof(skipped[id]) == TYPE_DICTIONARY else ""
		if why != "":
			print("TopoTopo: %s > %s: not imported: %s" % [topo.get_file().get_basename(), id, why])


func toast(message: String, severity: int) -> void:
	if headless:
		return
	var t := EditorInterface.get_editor_toaster()
	if t:
		t.push_toast(message, severity)


func _error(message: String) -> void:
	push_error(message)


func _warning(message: String) -> void:
	push_warning(message)
