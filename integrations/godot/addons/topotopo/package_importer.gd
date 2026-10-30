@tool
extends EditorImportPlugin
## Imports a TopoTopo package (<id>.topo) as a status resource (package.gd). A stale package is cooked first; the
## outputs it writes are plain GLBs and PNGs Godot imports itself, with their own .import settings. The import never
## replaces an output that did not cook (the last good one stays), and never imports outputs itself while Godot is
## importing (plugin.gd imports what the cook wrote once the batch has ended).

const Record := preload("record.gd")
const Package := preload("package.gd")

## plugin.gd
var host: Object


func _get_importer_name() -> String:
	return "topotopo.package"


func _get_visible_name() -> String:
	return "TopoTopo Package"


func _get_recognized_extensions() -> PackedStringArray:
	return PackedStringArray(["topo"])


func _get_save_extension() -> String:
	return "res"


func _get_resource_type() -> String:
	return "Resource"


func _get_preset_count() -> int:
	return 1


func _get_preset_name(_preset_index: int) -> String:
	return "Default"


func _get_priority() -> float:
	return 1.0


## Before every other import of a batch (textures are 0, scenes 100), so a cook run from here writes the new bytes
## before Godot imports those files.
func _get_import_order() -> int:
	return -100


func _get_format_version() -> int:
	return 1


func _can_import_threaded() -> bool:
	return false


func _get_import_options(_path: String, _preset_index: int) -> Array[Dictionary]:
	return [
		{"name": "outputs/folder", "default_value": "outputs", "property_hint": PROPERTY_HINT_NONE, "hint_string": "",
			"description": "Where the outputs go: a folder relative to the package folder, or a res:// path."},
		{"name": "outputs/per_output_folders", "default_value": true,
			"description": "On: <folder>/<id>/<id>.glb. Off: <folder>/<id>.glb."},
		{"name": "outputs/skip", "default_value": "", "description": "Output ids not to cook, comma-separated."},
		{"name": "instances/mode", "default_value": 0, "property_hint": PROPERTY_HINT_ENUM, "hint_string": "MultiMesh,Expand",
			"description": "MultiMesh: packed instances become MultiMeshInstance3D nodes. Expand: real copies."},
	]


func _get_option_visibility(_path: String, _option_name: StringName, _options: Dictionary) -> bool:
	return true


func _import(source_file: String, save_path: String, options: Dictionary, _platform_variants: Array[String], gen_files: Array[String]) -> Error:
	var res := Package.new()
	res.package_id = source_file.get_file().get_basename()
	var abs_topo := ProjectSettings.globalize_path(source_file)
	_manifest(res, abs_topo)
	var code := _cook_if_stale(source_file, abs_topo, options, res)
	var st = host.packages.get(source_file) if host else null
	if st != null and st.record != null:
		var rec: Dictionary = st.record
		res.topotopo_version = String(rec.get("topotopo", ""))
		res.notes = PackedStringArray(rec.get("notes", []))
		res.orphans = rec.get("orphans", {})
		var skipped := {}
		for id in rec.get("skipped", {}):
			skipped[id] = String(rec.skipped[id].get("why", ""))
		res.skipped = skipped
		var outs := []
		for id in Record._sorted_keys(rec.get("outputs", {})):
			var o: Dictionary = rec.outputs[id]
			outs.append({"id": id, "label": o.get("label", id), "kind": o.get("kind", ""), "graph": o.get("graph", ""),
				"files": Record._sorted_keys(o.get("files", {})), "state": o.get("state", ""), "errors": o.get("errors", [])})
		res.outputs = outs
		# every output file is a file of this import: one deleted by hand imports the .topo again, which restores it
		for f in Record.output_files(rec):
			gen_files.append(f)
	var err := ResourceSaver.save(res, save_path + "." + _get_save_extension())
	if err != OK:
		push_error("TopoTopo: %s: the import could not be saved (error %d)" % [source_file, err])
		return err
	if host:
		host.imported(source_file)
		host.packages_changed.emit()
	return code


func _manifest(res: Package, abs_topo: String) -> void:
	# a manifest that does not parse is said by the cook, with where and why
	var json := JSON.new()
	if json.parse(FileAccess.get_file_as_string(abs_topo).trim_prefix("﻿")) != OK:
		return
	var raw = json.data
	if typeof(raw) == TYPE_DICTIONARY:
		res.title = String(raw.get("title", ""))
		res.package_name = String(raw.get("name", "")) if raw.get("name") != null else ""


func _fail(res: Package, status: String, message: String, code: Error) -> Error:
	res.status = status
	res.message = message
	push_error(message)
	return code


func _cook_if_stale(topo: String, abs_topo: String, options: Dictionary, res: Package) -> Error:
	if host == null:
		return _fail(res, "failed", "TopoTopo: %s: the TopoTopo plugin is not enabled" % topo, ERR_UNAVAILABLE)
	if Record.is_published_copy(abs_topo):
		return _fail(res, "failed", "TopoTopo: %s is a published copy; hide its folder with .gdignore (topotopo godot setup %s)" % [topo, host.project], ERR_INVALID_DATA)
	if abs_topo.get_base_dir() == host.project:
		return _fail(res, "failed", "TopoTopo: %s: a package at the project's root is not supported (its assets/ would hide the game's art): move it into a folder" % topo, ERR_INVALID_DATA)
	var opts: Dictionary = host.options_for(topo, options)
	if opts.has("error"):
		return _fail(res, "failed", "TopoTopo: %s: %s" % [topo, opts.error], ERR_INVALID_DATA)
	var fr: Dictionary = host.check(topo, opts)
	if host.is_stale(fr):
		if not host.runner.found():
			host.say_missing_once()
			return _fail(res, "stale_no_topotopo", host.not_set_up_text(topo, fr), ERR_UNAVAILABLE)
		# the last cook of these very files did not finish them: say why rather than cook them again (Recook retries)
		if fr.why != "options" and host.failed_unchanged(topo):
			return _fail(res, "failed", "TopoTopo: %s did not cook: %s" % [topo, host.packages[topo].error], FAILED)
		# a running cook that has this package (the batch's, or the watcher's): wait for it; else cook it now
		var run: Dictionary = host.runner.run_with(abs_topo)
		if not run.is_empty():
			host.wait_for(run, abs_topo)
			fr = host.check(topo, opts)
		# (a running cook had other import options than this import: cook with these)
		if run.is_empty() or (host.is_stale(fr) and fr.why == "options"):
			host.cook([topo], false, true, false, {topo: opts})
			fr = host.check(topo, opts)
		if host.is_stale(fr):
			var st = host.packages.get(topo, {})
			var why: String = st.get("error", "") if st.get("error", "") != "" else fr.text
			var code := ERR_TIMEOUT if why.contains("timed out") or why.contains("past its timeout") else FAILED
			return _fail(res, "failed", "TopoTopo: %s did not cook: %s" % [topo, why], code)
	host.say_skipped_once(topo, host.packages.get(topo, {}).get("record"))
	if fr.state == "failed":
		res.status = "failed"
		var lines := PackedStringArray()
		var rec = host.packages.get(topo, {}).get("record")
		var outputs = rec.get("outputs", {}) if typeof(rec) == TYPE_DICTIONARY else {}
		var pkg := topo.get_file().get_basename()
		for id in Record._sorted_keys(outputs):
			for e in outputs[id].get("errors", []):
				var line := "TopoTopo: %s > %s: %s%s%s" % [pkg, id, ("[%s] " % e.node) if String(e.get("node", "")) != "" else "", e.get("message", ""),
					(" (hint: %s)" % e.hint) if String(e.get("hint", "")) != "" else ""]
				lines.append(line)
				push_error(line)
		var failed := 0
		for id in outputs:
			if outputs[id].get("state") == "failed":
				failed += 1
		res.message = "\n".join(lines) if lines.size() else fr.text
		host.toast("TopoTopo: %s: %d of %d outputs did not cook; the last good result is kept" % [pkg, failed, outputs.size()], EditorToaster.SEVERITY_ERROR)
		return ERR_TIMEOUT if res.message.contains("timed out") else FAILED
	res.status = "ok"
	if not host.runner.found():
		res.message = "cooked elsewhere, current (TopoTopo is not set up here)"
		return OK
	res.message = fr.text if fr.note != "update_topotopo" else "%s (cooked by TopoTopo %s, newer than the one here: update TopoTopo)" % [fr.text, host.packages[topo].record.get("topotopo", "")]
	return OK
