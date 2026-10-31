@tool
extends EditorExportPlugin
## Keeps TopoTopo's files out of exports, and lists in the export log every package whose outputs are failed, stale or
## never cooked (a plugin cannot fail an export; CI runs topotopo godot status --strict or tools/check.gd).
## The addon's .gd files never reach _export_file (Godot's GDScript exporter takes them first): topotopo godot setup
## adds addons/topotopo/* to every preset's exclude_filter.

## A package's TopoTopo folders, never shipped (a safety net for a missing .gdignore), and its concept art.
const PACKAGE_DIRS := ["graphs", "assets", "inputs", "exports", "versions", "packages", "attachments"]
## Files at a package's top level that are notes and manifests, never shipped.
const PACKAGE_TOP := ["json", "md", "txt"]

## plugin.gd: the package checks.
var host: Object
var _package_of := {}


func _get_name() -> String:
	return "TopoTopo"


func _export_begin(_features: PackedStringArray, _is_debug: bool, _path: String, _flags: int) -> void:
	_package_of.clear()
	if host == null:
		return
	for p in host.export_problems():
		get_export_platform().add_message(EditorExportPlatform.EXPORT_MESSAGE_ERROR, "TopoTopo", p)


func _export_end() -> void:
	_package_of.clear()


func _export_file(path: String, _type: String, _features: PackedStringArray) -> void:
	if skipped(path):
		skip()


## Whether an exported file is one of TopoTopo's: a .topo (its status resource), the addon, the workspace manifest and
## its shared copies, and inside a package folder (a folder holding a .topo) its top-level .json/.md/.txt files and
## everything under its TopoTopo folders.
func skipped(path: String) -> bool:
	if path.get_extension() == "topo":
		return true
	if path.begins_with("res://addons/topotopo/"):
		return true
	if path == "res://topotopo-workspace.json" or path.begins_with("res://topotopo-packages/") or path.contains("/topotopo-packages/"):
		return true
	var pkg := _package_dir_of(path.get_base_dir())
	if pkg == "":
		return false
	var rel := path.trim_prefix(pkg + "/")
	if not rel.contains("/"):
		return PACKAGE_TOP.has(rel.get_extension().to_lower())
	return PACKAGE_DIRS.has(rel.get_slice("/", 0))


## The nearest folder at or above `dir` that holds a .topo, or "".
func _package_dir_of(dir: String) -> String:
	var d := dir
	while d != "" and d != "res:" and d != "res://":
		if not _package_of.has(d):
			var found := false
			for f in DirAccess.get_files_at(d):
				if f.length() > 5 and f.ends_with(".topo"):
					found = true
					break
			_package_of[d] = found
		if _package_of[d]:
			return d
		d = d.get_base_dir()
	return ""
