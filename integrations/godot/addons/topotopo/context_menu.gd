@tool
extends EditorContextMenuPlugin
## FileSystem dock context menu on a .topo, and on any file a package's record lists as an output: Open in TopoTopo,
## Recook, Show Cook Report.

## plugin.gd
var host: Object


func _popup_menu(paths: PackedStringArray) -> void:
	if host == null:
		return
	for p in paths:
		if host.package_of_file(p) != "":
			add_context_menu_item("Open in TopoTopo", _open)
			add_context_menu_item("Recook", _recook)
			add_context_menu_item("Show Cook Report", _report)
			return


func _packages(paths) -> Array:
	var out := []
	for p in paths:
		var t: String = host.package_of_file(String(p)) if host else ""
		if t != "" and not out.has(t):
			out.append(t)
	return out


func _open(paths) -> void:
	for t in _packages(paths):
		host.open_in_topotopo(t)


func _recook(paths) -> void:
	var list := _packages(paths)
	if list.size():
		host.cook_now(list, true)


func _report(paths) -> void:
	for t in _packages(paths):
		host.show_report(t)
