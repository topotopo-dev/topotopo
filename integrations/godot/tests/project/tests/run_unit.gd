extends SceneTree
## The addon's GDScript unit tests (step 0 of npm run test:godot):
## - record.gd's contentSha and freshness against the golden values TopoTopo's own tests write
##   (test/data/cook/freshness.json): the same files give the same hashes and the same verdicts on both sides;
## - the import options as the record compares them, against what TopoTopo reads from the same import files;
## - the runner: the arguments a child process receives for paths with spaces, "&", "é" and backslashes, the cook's
##   arguments, and where it found TopoTopo.
##   godot --headless --path <project> --script res://tests/run_unit.gd -- <unit.json>
## unit.json (written by scripts/test-godot.mjs): {golden, scratch, options: [{name, topo, params, expect}],
## node, echo, args: [string], cli}. Prints PASS/FAIL lines and exits 1 on a failure.

const Record := preload("res://addons/topotopo/record.gd")
const Runner := preload("res://addons/topotopo/runner.gd")

var passes := 0
var failures := 0


func check(ok: bool, what: String) -> void:
	if ok:
		passes += 1
	else:
		failures += 1
	print("%s %s" % ["PASS" if ok else "FAIL", what])


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		print("FAIL run_unit.gd needs the unit.json file: -- <unit.json>")
		quit(1)
		return
	var unit = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	if typeof(unit) != TYPE_DICTIONARY:
		print("FAIL %s is not readable JSON" % args[0])
		quit(1)
		return
	_golden(unit)
	_options(unit)
	_runner(unit)
	print("unit: %d passed, %d failed" % [passes, failures])
	quit(1 if failures else 0)


func _golden(unit: Dictionary) -> void:
	var golden = JSON.parse_string(FileAccess.get_file_as_string(String(unit.golden)))
	check(typeof(golden) == TYPE_DICTIONARY and golden.has("cases"), "the golden values are readable (%s)" % unit.golden)
	if typeof(golden) != TYPE_DICTIONARY:
		return
	for c in golden.contentSha:
		var bytes := Marshalls.base64_to_raw(String(c.base64))
		var got := Record.content_sha(String(c.name), bytes)
		check(got == String(c.sha), "contentSha %s (%s): %s" % [c.name, c.what, got])
	var scratch := String(unit.scratch)
	var i := 0
	for c in golden.cases:
		i += 1
		var project := scratch.path_join("golden-%02d" % i)
		for rel in c.files:
			var file := project.path_join(rel)
			DirAccess.make_dir_recursive_absolute(file.get_base_dir())
			var f := FileAccess.open(file, FileAccess.WRITE)
			f.store_buffer(Marshalls.base64_to_raw(String(c.files[rel])))
			f.close()
		var dir := project.path_join(String(c.package))
		DirAccess.make_dir_recursive_absolute(dir)
		var installed := String(c.installed) if c.installed != null else ""
		var fr := Record.new().freshness(dir, c.record, c.options, project, installed)
		var got := {"state": fr.state, "why": fr.why, "path": fr.path, "note": fr.note}
		var want: Dictionary = c.expect
		var same: bool = got.state == want.state and got.why == want.why and got.path == want.path and got.note == want.note
		check(same, "freshness: %s: %s%s" % [c.name, JSON.stringify(got), "" if same else " (TopoTopo says %s)" % JSON.stringify(want)])
	# a hash taken again while a file's time and size are unchanged comes from the memo; a changed file is hashed again
	var memo_dir := scratch.path_join("memo")
	DirAccess.make_dir_recursive_absolute(memo_dir)
	var file := memo_dir.path_join("a.json")
	var w := FileAccess.open(file, FileAccess.WRITE)
	w.store_string("{\r\n}\r\n")
	w.close()
	var rec := Record.new()
	var first := rec.file_content_sha(file)
	check(first == Record.sha256("{\n}\n".to_utf8_buffer()), "a CRLF text file hashes as its LF text")
	w = FileAccess.open(file, FileAccess.WRITE)
	w.store_string("{\r\n }\r\n")
	w.close()
	check(rec.file_content_sha(file) == Record.sha256("{\n }\n".to_utf8_buffer()), "a file changed in the same second is hashed again")


func _options(unit: Dictionary) -> void:
	for c in unit.options:
		var params := Record.import_params(String(c.topo))
		var got := Record.options_from_params(params, String(c.res), String(c.project))
		var want: Dictionary = c.expect
		if want.has("error"):
			check(got.has("error"), "options %s: refused like TopoTopo refuses it (%s)" % [c.name, got.get("error", JSON.stringify(got))])
			continue
		var same: bool = not got.has("error") and got.folder == want.folder and got.instancing == want.instancing \
			and got.per_output_folders == want.per_output_folders and Array(got.skip) == Array(want.skip)
		check(same, "options %s: %s%s" % [c.name, JSON.stringify(got), "" if same else " (TopoTopo reads %s)" % JSON.stringify(want)])
		check(Record.same_options(want, got) if same else false, "options %s: the record's options compare equal" % c.name)


func _runner(unit: Dictionary) -> void:
	# what a child process receives: forward slashes, no trailing slash, spaces, "&" and "é" intact
	var node := String(unit.node)
	var sent := PackedStringArray([Runner.arg_path(String(unit.echo))])
	var want := []
	for a in unit.args:
		sent.append(Runner.arg_path(String(a)))
		want.append(Runner.arg_path(String(a)))
	var r := Runner.run_quiet(node, sent, 60000)
	var got = JSON.parse_string(String(r.out).strip_edges())
	check(r.code == 0 and typeof(got) == TYPE_ARRAY and got == want, "a child process receives %s as %s" % [JSON.stringify(want), String(r.out).strip_edges() if r.code == 0 else "exit %d: %s" % [r.code, r.err]])
	check(Runner.arg_path("C:\\a b\\c\\") == "C:/a b/c" and Runner.arg_path("C:/") == "C:/" and Runner.arg_path("/x/y/") == "/x/y", "arg_path: forward slashes, no trailing slash, a drive root kept")
	var args := Runner.cook_args("C:\\t t\\src\\cli.ts", "C:/p é/.godot/topotopo/jobs-1-1.json", false)
	check(args == PackedStringArray(["C:/t t/src/cli.ts", "cook", "--jobs", "C:/p é/.godot/topotopo/jobs-1-1.json", "--progress", "json"]), "the cook's arguments: %s" % ", ".join(args))
	check(Runner.cook_args("c", "j", true).slice(-2) == PackedStringArray(["--force", "--no-cache"]), "a recook adds --force --no-cache")
	# finding TopoTopo: TOPOTOPO_CLI and TOPOTOPO_NODE first; a folder means its src/cli.ts
	var runner := Runner.new(String(unit.project), {})
	check(runner.found() and runner.cli_from == "TOPOTOPO_CLI" and runner.node_from == "TOPOTOPO_NODE", "found TopoTopo: %s" % runner.describe())
	check(runner.version == String(unit.version), "its version from its package.json: %s" % runner.version)
	var cli := String(unit.cli)
	check(Runner.resolve_cli(cli.get_base_dir().get_base_dir()) == cli, "a TopoTopo folder means its src/cli.ts")
	check(Runner.resolve_cli(String(unit.scratch).path_join("nothing")) == "", "a folder without a CLI means none")
