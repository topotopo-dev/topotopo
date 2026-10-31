@tool
extends EditorInspectorPlugin
## A status header on an imported TopoTopo package (package.gd) in the Inspector, with the panel's actions.

const Package := preload("package.gd")

## plugin.gd
var host: Object


func _can_handle(object: Object) -> bool:
	return object is Resource and object.get_script() == Package


func _parse_begin(object: Object) -> void:
	var res: Resource = object
	var box := VBoxContainer.new()
	var head := Label.new()
	var status := String(res.get("status"))
	head.text = "TopoTopo package %s: %s" % [res.get("package_id"), status.replace("_", " ") if status != "" else "not imported"]
	box.add_child(head)
	var msg := String(res.get("message"))
	if msg != "":
		var l := Label.new()
		l.text = msg
		l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		box.add_child(l)
	var topo := res.resource_path
	if topo.ends_with(".topo") and host:
		var row := HBoxContainer.new()
		for a in [["Open in TopoTopo", func(): host.open_in_topotopo(topo)], ["Recook", func(): host.cook_now([topo], true)],
				["Show Report", func(): host.show_report(topo)]]:
			var b := Button.new()
			b.text = a[0]
			b.pressed.connect(a[1])
			row.add_child(b)
		box.add_child(row)
	add_custom_control(box)
