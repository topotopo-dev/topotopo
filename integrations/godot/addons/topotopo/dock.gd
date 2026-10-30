@tool
extends EditorDock
## The "TopoTopo" panel (bottom panel by default; dock.tscn): which TopoTopo cooks and where it was found, one row per
## package (its state, last cook, outputs with thumbnails, errors, skipped outputs, orphans) and the actions on a
## package. Drag an output from here into a scene or the 3D view like a file from the FileSystem dock.

const Record := preload("record.gd")

## plugin.gd
var host: Object

@onready var _status: Label = $Box/Top/Status
@onready var _locate: Button = $Box/Top/Locate
@onready var _unfocused: CheckButton = $Box/Top/Unfocused
@onready var _tree: Tree = $Box/Tree
@onready var _open: Button = $Box/Actions/Open
@onready var _recook: Button = $Box/Actions/Recook
@onready var _show: Button = $Box/Actions/ShowOutputs
@onready var _report: Button = $Box/Actions/ShowReport
@onready var _orphans: Button = $Box/Actions/RemoveOrphans
var _dialog: EditorFileDialog
var _dirty := true


func _init() -> void:
	title = "TopoTopo"
	default_slot = DOCK_SLOT_BOTTOM
	available_layouts = DOCK_LAYOUT_HORIZONTAL | DOCK_LAYOUT_FLOATING


func _ready() -> void:
	var svg := FileAccess.get_file_as_string(get_script().resource_path.get_base_dir().path_join("icons/topotopo.svg"))
	if svg != "":
		var img := Image.new()
		if img.load_svg_from_string(svg, EditorInterface.get_editor_scale()) == OK:
			dock_icon = ImageTexture.create_from_image(img)
	_locate.pressed.connect(_on_locate)
	_unfocused.toggled.connect(func(on: bool): if host: host.set_import_when_unfocused(on))
	$Box/Top/CookStale.pressed.connect(_on_cook_stale)
	_tree.set_column_title(0, "Package / output")
	_tree.set_column_title(1, "State")
	_tree.set_column_title(2, "")
	_tree.set_column_expand(0, true)
	_tree.set_column_expand_ratio(0, 2)
	_tree.set_column_expand(1, false)
	_tree.set_column_custom_minimum_width(1, 140)
	_tree.set_column_expand(2, true)
	_tree.set_column_expand_ratio(2, 3)
	_tree.item_selected.connect(_update_buttons)
	_tree.item_activated.connect(_on_activated)
	_tree.set_drag_forwarding(_drag, Callable(), Callable())
	_action(_open, func(t): host.open_in_topotopo(t))
	_action(_recook, func(t): host.cook_now([t], true))
	_action(_show, _show_outputs)
	_action(_report, func(t): host.show_report(t))
	_action(_orphans, func(t): host.remove_orphans(t))

	_dialog = EditorFileDialog.new()
	_dialog.access = EditorFileDialog.ACCESS_FILESYSTEM
	_dialog.file_mode = EditorFileDialog.FILE_MODE_OPEN_ANY
	_dialog.title = "Locate TopoTopo (src/cli.ts, dist/cli.js or its folder)"
	_dialog.add_filter("*.ts, *.js", "TopoTopo CLI")
	_dialog.file_selected.connect(func(p: String): if host: host.locate(p))
	_dialog.dir_selected.connect(func(p: String): if host: host.locate(p))
	add_child(_dialog)

	if host:
		host.packages_changed.connect(func(): _dirty = true)
	_update_buttons()


func _action(b: Button, fn: Callable) -> void:
	b.pressed.connect(func():
		var t := _selected_topo()
		if host and t != "":
			fn.call(t))


func _process(_delta: float) -> void:
	if _dirty and is_visible_in_tree() and host:
		_dirty = false
		refresh()


func _selected_topo() -> String:
	var it := _tree.get_selected() if _tree else null
	if it == null:
		return ""
	var m = it.get_metadata(0)
	return String(m.topo) if typeof(m) == TYPE_DICTIONARY else ""


func _update_buttons() -> void:
	var t := _selected_topo()
	for b in [_open, _recook, _show, _report]:
		if b:
			b.disabled = t == ""
	if _orphans:
		var st = host.packages.get(t) if host and t != "" else null
		_orphans.disabled = st == null or st.record == null or st.record.get("orphans", {}).is_empty()


func _on_cook_stale() -> void:
	if host:
		host.check_all()
		host.cook_now(host.packages.keys(), false)


func _on_locate() -> void:
	_dialog.popup_file_dialog()


func _on_activated() -> void:
	var it := _tree.get_selected()
	if it == null:
		return
	var m = it.get_metadata(0)
	if typeof(m) == TYPE_DICTIONARY and String(m.get("file", "")) != "":
		EditorInterface.get_file_system_dock().navigate_to_path(m.file)
	elif typeof(m) == TYPE_DICTIONARY:
		EditorInterface.get_file_system_dock().navigate_to_path(m.topo)


func _show_outputs(topo: String) -> void:
	var st = host.packages.get(topo)
	if st == null:
		return
	var files := Record.output_files(st.record)
	EditorInterface.get_file_system_dock().navigate_to_path(files[0] if files.size() else topo)


func _drag(at: Vector2) -> Variant:
	var it := _tree.get_item_at_position(at)
	if it == null:
		return null
	var m = it.get_metadata(0)
	if typeof(m) != TYPE_DICTIONARY or String(m.get("file", "")) == "" or not FileAccess.file_exists(m.file):
		return null
	var l := Label.new()
	l.text = m.file.get_file()
	set_drag_preview(l)
	return {"type": "files", "files": PackedStringArray([m.file]), "from": self}


func _state_text(st: Dictionary) -> String:
	if st.cooking:
		return st.progress if st.progress != "" else "cooking"
	if st.copy:
		return "published copy"
	if st.root:
		return "unsupported"
	match st.fresh.state:
		"ok":
			return "ok"
		"failed":
			return "failed"
		"never_cooked":
			return "never cooked" if host.runner.found() else "no TopoTopo"
	return "stale" if host.runner.found() else "stale, no TopoTopo"


func _state_color(st: Dictionary) -> Color:
	if st.cooking:
		return get_theme_color("accent_color", "Editor")
	match st.fresh.state:
		"ok":
			return get_theme_color("success_color", "Editor")
		"failed":
			return get_theme_color("error_color", "Editor")
	return get_theme_color("warning_color", "Editor")


func refresh() -> void:
	_status.text = host.runner.describe()
	_status.tooltip_text = _status.text
	_locate.visible = true
	_unfocused.set_pressed_no_signal(host.import_when_unfocused())
	var keep := _selected_topo()
	_tree.clear()
	var root := _tree.create_item()
	var topos: Array = host.packages.keys()
	topos.sort()
	if topos.is_empty():
		var it := _tree.create_item(root)
		it.set_text(0, "No TopoTopo package in this project (a folder holding an <id>.topo).")
	for topo in topos:
		var st: Dictionary = host.packages[topo]
		var it := _tree.create_item(root)
		it.set_metadata(0, {"topo": topo, "file": ""})
		it.set_text(0, "%s  (%s)" % [st.id, topo])
		it.set_text(1, _state_text(st))
		it.set_custom_color(1, _state_color(st))
		var info := PackedStringArray()
		if st.error != "":
			info.append(st.error.get_slice("\n", 0))
		elif st.fresh.state != "ok":
			info.append(st.fresh.text)
		if st.fresh.note == "update_topotopo":
			info.append("cooked by a newer TopoTopo: update TopoTopo")
		if st.last_ms >= 0:
			info.append("last cook %s, %.1f s" % [st.last_time, st.last_ms / 1000.0])
		var exposed := Record.exposed(st.dir) if not st.root else PackedStringArray()
		if exposed.size():
			info.append("Godot imports %s (no .gdignore): run topotopo godot setup" % ", ".join(exposed))
		it.set_text(2, " · ".join(info))
		it.set_tooltip_text(2, "\n".join(info))
		if topo == keep:
			it.select(0)
		var rec = st.record
		if typeof(rec) != TYPE_DICTIONARY:
			continue
		var outputs = rec.get("outputs", {})
		for id in Record._sorted_keys(outputs):
			var o: Dictionary = outputs[id]
			var files: Array = Record._sorted_keys(o.get("files", {}))
			var oi := _tree.create_item(it)
			var main := ""
			for f in files:
				if f.ends_with(".glb"):
					main = f
			if main == "" and files.size():
				main = files[0]
			oi.set_metadata(0, {"topo": topo, "file": main})
			oi.set_text(0, "%s  %s" % [o.get("label", id), ("(%s)" % main) if main != "" else ""])
			oi.set_tooltip_text(0, "\n".join(files) if files.size() else "never cooked")
			oi.set_text(1, "%s %s" % [o.get("state", ""), o.get("kind", "")])
			oi.set_custom_color(1, get_theme_color("error_color", "Editor") if o.get("state") == "failed" else get_theme_color("font_color", "Editor"))
			var inst = o.get("instances", {})
			var notes := PackedStringArray()
			for src in Record._sorted_keys(inst):
				notes.append("%s × %d" % [src, int(inst[src])])
			if files.size() > 1:
				notes.append("%d files" % files.size())
			oi.set_text(2, ", ".join(notes))
			if main != "" and FileAccess.file_exists(main):
				EditorInterface.get_resource_previewer().queue_resource_preview(main, self, "_on_preview", oi)
			for e in o.get("errors", []):
				var ei := _tree.create_item(oi)
				ei.set_metadata(0, {"topo": topo, "file": ""})
				ei.set_text(0, ("[%s] " % e.node) if String(e.get("node", "")) != "" else "error")
				ei.set_text(2, "%s%s" % [e.get("message", ""), (" (hint: %s)" % e.hint) if String(e.get("hint", "")) != "" else ""])
				ei.set_tooltip_text(2, ei.get_text(2))
				ei.set_custom_color(2, get_theme_color("error_color", "Editor"))
		var skipped = rec.get("skipped", {})
		for id in Record._sorted_keys(skipped):
			var si := _tree.create_item(it)
			si.set_metadata(0, {"topo": topo, "file": ""})
			si.set_text(0, String(skipped[id].get("label", id)) if typeof(skipped[id]) == TYPE_DICTIONARY else id)
			si.set_text(1, "skipped")
			si.set_custom_color(1, get_theme_color("font_disabled_color", "Editor"))
			si.set_text(2, String(skipped[id].get("why", "")) if typeof(skipped[id]) == TYPE_DICTIONARY else "")
		var orphans = rec.get("orphans", {})
		for f in Record._sorted_keys(orphans):
			var oi := _tree.create_item(it)
			oi.set_metadata(0, {"topo": topo, "file": f})
			oi.set_text(0, f)
			oi.set_text(1, "orphan")
			oi.set_custom_color(1, get_theme_color("warning_color", "Editor"))
			oi.set_text(2, "was output %s, no longer cooked; kept until you remove it" % orphans[f])
	_update_buttons()


func _on_preview(_path: String, _preview: Texture2D, thumbnail: Texture2D, item: Variant) -> void:
	if thumbnail and is_instance_valid(item):
		item.set_icon(0, thumbnail)
		item.set_icon_max_width(0, 24)
