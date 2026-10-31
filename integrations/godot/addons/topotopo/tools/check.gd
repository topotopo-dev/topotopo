extends SceneTree
## The CI check where TopoTopo is not installed:
##   godot --headless --path <project> --script res://addons/topotopo/tools/check.gd
## checks every package Godot sees with the one freshness rule and exits 1 when one is stale, failed, never cooked, a
## visible published copy or at the project's root, or shows Godot its TopoTopo folders (no .gdignore). Where
## TopoTopo is installed, topotopo godot status <project> --strict does the same and more.

const Record := preload("../record.gd")


func _init() -> void:
	var project := ProjectSettings.globalize_path("res://").replace("\\", "/").trim_suffix("/")
	var record := Record.new()
	var bad := 0
	var count := 0
	for topo in Record.find_topos(project):
		count += 1
		var res := Record.abs_to_res(project, topo)
		var dir := topo.get_base_dir()
		if Record.is_published_copy(topo):
			print("TopoTopo check: copy         %s: a published copy Godot sees: hide its folder with .gdignore" % res)
			bad += 1
			continue
		if dir == project:
			print("TopoTopo check: unsupported  %s: a package at the project's root: move it into a folder" % res)
			bad += 1
			continue
		var opts := Record.options_from_params(Record.import_params(topo), res, project)
		var fr: Dictionary
		if opts.has("error"):
			fr = {"state": "stale", "text": opts.error}
		else:
			var r := Record.read_record(dir)
			fr = {"state": "stale", "text": r.error} if r.error != "" else record.freshness(dir, r.record, opts, project, "")
		var exposed := Record.exposed(dir)
		print("TopoTopo check: %s %s%s" % [String(fr.state).replace("_", " ").rpad(12), res, "" if fr.state == "ok" else ": " + String(fr.text)])
		if exposed.size():
			print("TopoTopo check:              %s: Godot imports %s (no .gdignore)" % [res, ", ".join(exposed)])
		if fr.state != "ok" or exposed.size():
			bad += 1
	print("TopoTopo check: %d package%s, %s" % [count, "" if count == 1 else "s", "every package is current" if bad == 0 else "%d not current" % bad])
	quit(1 if bad else 0)
