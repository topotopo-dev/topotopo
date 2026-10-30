@tool
extends RefCounted
## Finds node and the TopoTopo CLI, writes jobs files and runs cooks as child processes
## (<node> <cli> cook --jobs <file> --progress json), reading their progress lines from the pipe (ASCII) and their
## results from the report files (UTF-8). Never parses OS.execute output, which Windows decodes with the ANSI code page.
## It uses no editor class: tools and tests run it outside the editor.

const PROTOCOL := 1
## Node 22.18 runs TopoTopo's TypeScript.
const MIN_NODE := [22, 18]
## Seconds a cook may run past its own timeout before the runner kills it.
const BACKSTOP := 30

## {topotopo_path, node_path, cook_timeout}: the editor settings ("" = auto).
var settings := {"topotopo_path": "", "node_path": "", "cook_timeout": 600.0}
## The Godot project folder (absolute, no trailing slash).
var project := ""

var cli := ""
var cli_from := ""
var node := ""
var node_from := ""
## TopoTopo's version, "" until it is found.
var version := ""
var node_version := ""
## Why TopoTopo cannot run, "" when it can.
var problem := ""
var _looked := false
var _seq := 0
var runs: Array = []


func _init(project_folder := "", editor_settings := {}) -> void:
	project = project_folder.replace("\\", "/").trim_suffix("/")
	for k in editor_settings:
		settings[k] = editor_settings[k]


## True when node and the CLI were found and work.
func found() -> bool:
	if not _looked:
		find()
	return problem == ""


## Look for node and the CLI again (the settings changed).
func reset() -> void:
	_looked = false
	cli = ""
	cli_from = ""
	node = ""
	node_from = ""
	version = ""
	node_version = ""
	problem = ""


## What was found, in words: "TopoTopo 0.4.0 at <cli> (<from>)" or why it cannot run.
func describe() -> String:
	if not found():
		return "TopoTopo not found: " + problem
	return "TopoTopo %s at %s (%s), node %s" % [version, cli, cli_from, node_version]


# ----------------------------------------------------------------------------------------------------- finding

## Find the CLI and node in the protocol's order, then check node's version and TopoTopo's.
func find() -> void:
	_looked = true
	problem = ""
	var c := _find_cli()
	cli = c[0]
	cli_from = c[1]
	if cli == "":
		problem = c[2]
		return
	var n := _find_node()
	node = n[0]
	node_from = n[1]
	if node == "":
		problem = n[2]
		return
	var v := run_quiet(node, PackedStringArray(["--version"]), 15000)
	if v.code != 0 or not String(v.out).strip_edges().begins_with("v"):
		problem = "%s (%s) does not run: %s" % [node, node_from, _tail(v.err, 3) if v.err != "" else "exit code %d" % v.code]
		return
	node_version = String(v.out).strip_edges()
	var parts := node_version.trim_prefix("v").split(".")
	var major := parts[0].to_int()
	var minor := parts[1].to_int() if parts.size() > 1 else 0
	if major < MIN_NODE[0] or (major == MIN_NODE[0] and minor < MIN_NODE[1]):
		problem = "node %s at %s is too old: TopoTopo needs node %d.%d or newer" % [node_version, node, MIN_NODE[0], MIN_NODE[1]]
		return
	version = _package_version(cli)
	if version == "":
		var t := run_quiet(node, PackedStringArray([arg_path(cli), "--version"]), 60000)
		var line := String(t.out).strip_edges()
		if t.code != 0 or not line.begins_with("topotopo "):
			problem = "%s (%s) does not run: %s" % [cli, cli_from, _tail(t.err, 3) if t.err != "" else "exit code %d" % t.code]
			return
		version = line.trim_prefix("topotopo ").strip_edges()


## The version in the package.json of the TopoTopo a CLI belongs to (src/cli.ts and dist/cli.js sit two levels below it).
static func _package_version(cli_path: String) -> String:
	var pj := cli_path.get_base_dir().get_base_dir().path_join("package.json")
	if not FileAccess.file_exists(pj):
		return ""
	var raw = JSON.parse_string(FileAccess.get_file_as_string(pj))
	if typeof(raw) != TYPE_DICTIONARY or raw.get("name") != "topotopo":
		return ""
	return String(raw.get("version", ""))


## A CLI path, or a folder: its src/cli.ts (a checkout), else its dist/cli.js. "" when it names neither.
static func resolve_cli(p: String) -> String:
	var path := p.strip_edges().replace("\\", "/")
	if path == "":
		return ""
	if FileAccess.file_exists(path):
		return path
	if DirAccess.dir_exists_absolute(path):
		for rel in ["src/cli.ts", "dist/cli.js"]:
			if FileAccess.file_exists(path.path_join(rel)):
				return path.path_join(rel)
	return ""


## The user's TopoTopo config (~/.topotopo/config.json, or the file TOPOTOPO_CONFIG names).
static func config_path() -> String:
	var env := OS.get_environment("TOPOTOPO_CONFIG")
	if env != "":
		return env.replace("\\", "/")
	var home := OS.get_environment("USERPROFILE") if OS.get_name() == "Windows" else OS.get_environment("HOME")
	if home == "":
		home = OS.get_environment("HOME")
	return home.replace("\\", "/").path_join(".topotopo/config.json")


static func _install_record() -> Dictionary:
	var f := config_path()
	if not FileAccess.file_exists(f):
		return {}
	var raw = JSON.parse_string(FileAccess.get_file_as_string(f).trim_prefix("\ufeff"))
	if typeof(raw) == TYPE_DICTIONARY and typeof(raw.get("install")) == TYPE_DICTIONARY:
		return raw["install"]
	return {}


static func _path_dirs() -> PackedStringArray:
	var sep := ";" if OS.get_name() == "Windows" else ":"
	var out := PackedStringArray()
	for d in OS.get_environment("PATH").split(sep, false):
		out.append(d.strip_edges().trim_prefix("\"").trim_suffix("\"").replace("\\", "/"))
	return out


## [cli, where from, why not found]
func _find_cli() -> Array:
	var env := OS.get_environment("TOPOTOPO_CLI")
	if env != "":
		var c := resolve_cli(env)
		return [c, "TOPOTOPO_CLI", "" if c != "" else "TOPOTOPO_CLI names %s, which is no TopoTopo CLI (src/cli.ts, dist/cli.js) or folder holding one" % env]
	var setting := String(settings.get("topotopo_path", ""))
	if setting != "":
		var c := resolve_cli(setting)
		return [c, "Editor Settings", "" if c != "" else "Editor Settings > FileSystem > Import > TopoTopo > Topotopo Path names %s, which is no TopoTopo CLI or folder holding one" % setting]
	# a project pin: node_modules/topotopo in the project folder or a folder above it
	var d := project
	while d != "":
		var pin := d.path_join("node_modules/topotopo")
		if FileAccess.file_exists(pin.path_join("package.json")) and FileAccess.file_exists(pin.path_join("dist/cli.js")):
			return [pin.path_join("dist/cli.js"), "node_modules", ""]
		var up := d.get_base_dir()
		if up == d:
			break
		d = up
	var rec := _install_record()
	if typeof(rec.get("cli")) == TYPE_STRING and rec.cli != "":
		var c := resolve_cli(rec.cli)
		if c != "":
			return [c, "the install record in " + config_path(), ""]
	for dir in _path_dirs():
		for name in (["topotopo.cmd", "topotopo"] if OS.get_name() == "Windows" else ["topotopo"]):
			if FileAccess.file_exists(dir.path_join(name)):
				for rel in ["node_modules/topotopo/dist/cli.js", "../lib/node_modules/topotopo/dist/cli.js"]:
					var c := dir.path_join(rel).simplify_path()
					if FileAccess.file_exists(c):
						return [c, "PATH", ""]
	return ["", "", "no TopoTopo CLI: set Editor Settings > FileSystem > Import > TopoTopo > Topotopo Path, or run topotopo godot setup <project>"]


## [node, where from, why not found]
func _find_node() -> Array:
	var exe := "node.exe" if OS.get_name() == "Windows" else "node"
	var env := OS.get_environment("TOPOTOPO_NODE")
	if env != "":
		var p := env.replace("\\", "/")
		return [p, "TOPOTOPO_NODE", ""] if FileAccess.file_exists(p) else ["", "", "TOPOTOPO_NODE names %s, which does not exist" % env]
	var setting := String(settings.get("node_path", ""))
	if setting != "":
		var p := setting.replace("\\", "/")
		return [p, "Editor Settings", ""] if FileAccess.file_exists(p) else ["", "", "Editor Settings > FileSystem > Import > TopoTopo > Node Path names %s, which does not exist" % setting]
	var rec := _install_record()
	if typeof(rec.get("node")) == TYPE_STRING and FileAccess.file_exists(String(rec.node)):
		return [String(rec.node).replace("\\", "/"), "the install record in " + config_path(), ""]
	for dir in _path_dirs():
		if FileAccess.file_exists(dir.path_join(exe)):
			return [dir.path_join(exe), "PATH", ""]
	for p in ["C:/Program Files/nodejs/node.exe", "/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"]:
		if FileAccess.file_exists(p):
			return [p, p.get_base_dir(), ""]
	return ["", "", "node %d.%d or newer is not found: install it, or set Editor Settings > FileSystem > Import > TopoTopo > Node Path" % MIN_NODE]


# ----------------------------------------------------------------------------------------------- the processes

## An argument as the CLI gets it: forward slashes, no trailing slash (Godot quotes an argument with spaces but does not
## escape it, so a trailing backslash would swallow the closing quote).
static func arg_path(p: String) -> String:
	var s := p.replace("\\", "/")
	while s.length() > 1 and s.ends_with("/") and not s.ends_with(":/"):
		s = s.substr(0, s.length() - 1)
	return s


## The arguments of a cook of a jobs file.
static func cook_args(cli_path: String, jobs_file: String, force: bool) -> PackedStringArray:
	var a := PackedStringArray([arg_path(cli_path), "cook", "--jobs", arg_path(jobs_file), "--progress", "json"])
	if force:
		a.append_array(PackedStringArray(["--force", "--no-cache"]))
	return a


## Run a short command and wait for it: {code, out, err} (out and err read from the pipes as UTF-8).
static func run_quiet(exe: String, args: PackedStringArray, timeout_ms: int) -> Dictionary:
	var p := OS.execute_with_pipe(exe, args, false)
	if p.is_empty():
		return {"code": -1, "out": "", "err": "%s could not be started" % exe}
	var out := PackedByteArray()
	var err := PackedByteArray()
	var t0 := Time.get_ticks_msec()
	while true:
		var running := OS.is_process_running(p.pid)
		var a: PackedByteArray = p.stdio.get_buffer(65536)
		var b: PackedByteArray = p.stderr.get_buffer(65536)
		out.append_array(a)
		err.append_array(b)
		if not running and a.is_empty() and b.is_empty():
			break
		if Time.get_ticks_msec() - t0 > timeout_ms:
			OS.kill(p.pid)
			return {"code": -1, "out": out.get_string_from_utf8(), "err": "%s did not finish in %d s" % [exe, timeout_ms / 1000]}
		OS.delay_msec(10)
	return {"code": OS.get_process_exit_code(p.pid), "out": out.get_string_from_utf8(), "err": err.get_string_from_utf8()}


static func _tail(text: String, n: int) -> String:
	var lines := text.strip_edges().split("\n")
	return "\n".join(lines.slice(maxi(0, lines.size() - n))).strip_edges()


static func _key(p: String) -> String:
	var s := p.replace("\\", "/")
	return s.to_lower() if OS.get_name() == "Windows" else s


## Start a cook of `jobs` (each {package: abs .topo, into, per_output_folders, skip, instancing, report, timeout}) in one
## process. Returns the run: {pid, packages: {key: {topo, report, done, ok, total, finished, current, events}}, …}, or
## {"error": why} when it cannot start.
func start(jobs: Array, force := false) -> Dictionary:
	if not found():
		return {"error": problem}
	var dir := project.path_join(".godot/topotopo")
	DirAccess.make_dir_recursive_absolute(dir)
	_seq += 1
	var jobs_file := dir.path_join("jobs-%d-%d.json" % [OS.get_process_id(), _seq])
	var f := FileAccess.open(jobs_file, FileAccess.WRITE)
	if f == null:
		return {"error": "the jobs file %s cannot be written (error %d)" % [jobs_file, FileAccess.get_open_error()]}
	f.store_string(JSON.stringify({"for": "godot", "protocol": PROTOCOL, "jobs": jobs}, "  ") + "\n")
	f.close()
	var p := OS.execute_with_pipe(node, cook_args(cli, jobs_file, force), false)
	if p.is_empty():
		return {"error": "%s could not be started" % node}
	var run := {
		"pid": p.pid, "stdio": p.stdio, "stderr": p.stderr, "jobs_file": jobs_file, "force": force,
		"packages": {}, "order": [], "out": PackedByteArray(), "err": PackedByteArray(), "err_lines": PackedStringArray(),
		"exited": false, "code": -1, "started": Time.get_ticks_msec(), "current": "", "current_started": Time.get_ticks_msec(),
		"timeout_ms": 0, "killed": "", "handled": false,
	}
	for j in jobs:
		var k := _key(j.package)
		run.packages[k] = {"topo": j.package, "report": String(j.get("report", "")), "done": false, "ok": false, "total": 0, "finished": 0, "current": "", "outputs": {}, "result": null, "crash": ""}
		run.order.append(k)
		run.timeout_ms = maxi(run.timeout_ms, int(float(j.get("timeout", settings.cook_timeout)) * 1000.0))
	runs.append(run)
	return run


## Read what a run printed since the last poll. Returns the progress events it read.
func poll(run: Dictionary) -> Array:
	var events := []
	if run.exited:
		return events
	var running := OS.is_process_running(run.pid)
	var a: PackedByteArray = run.stdio.get_buffer(65536)
	var b: PackedByteArray = run.stderr.get_buffer(65536)
	if a.size():
		var out: PackedByteArray = run.out
		out.append_array(a)
		while true:
			var i: int = out.find(10)
			if i < 0:
				break
			var line: String = out.slice(0, i).get_string_from_ascii().strip_edges()
			out = out.slice(i + 1)
			if line.begins_with("{"):
				var ev = JSON.parse_string(line)
				if typeof(ev) == TYPE_DICTIONARY:
					_event(run, ev)
					events.append(ev)
		run.out = out
	if b.size():
		var err: PackedByteArray = run.err
		var lines: PackedStringArray = run.err_lines
		err.append_array(b)
		while true:
			var i: int = err.find(10)
			if i < 0:
				break
			lines.append(err.slice(0, i).get_string_from_utf8().strip_edges(false, true))
			err = err.slice(i + 1)
		if lines.size() > 200:
			lines = lines.slice(lines.size() - 200)
		run.err = err
		run.err_lines = lines
	if not running and a.is_empty() and b.is_empty():
		if run.err.size():
			var lines: PackedStringArray = run.err_lines
			lines.append(run.err.get_string_from_utf8().strip_edges())
			run.err_lines = lines
		run.exited = true
		run.code = OS.get_process_exit_code(run.pid)
		_finish(run)
		forget(run)
	elif running and run.killed == "" and run.timeout_ms > 0 and Time.get_ticks_msec() - run.current_started > run.timeout_ms + BACKSTOP * 1000:
		kill(run, "the cook ran %d s past its timeout and was stopped" % BACKSTOP)
	return events


func _event(run: Dictionary, ev: Dictionary) -> void:
	var k := _key(String(ev.get("package", "")))
	var pk = run.packages.get(k)
	if pk == null:
		return
	match String(ev.get("event", "")):
		"start":
			pk.total = int(ev.get("outputs", 0))
			run.current = k
			run.current_started = Time.get_ticks_msec()
		"output":
			pk.finished += 1
			pk.current = String(ev.get("output", ""))
			pk.outputs[pk.current] = String(ev.get("state", ""))
		"done":
			pk.done = true
			pk.ok = bool(ev.get("ok", false))
			if String(ev.get("report", "")) != "":
				pk.report = String(ev.report)
			pk.result = _read_report(pk.report)


static func _read_report(file: String) -> Variant:
	if file == "" or not FileAccess.file_exists(file):
		return null
	var raw = JSON.parse_string(FileAccess.get_file_as_string(file).trim_prefix("\ufeff"))
	return raw if typeof(raw) == TYPE_DICTIONARY else null


## After the process ended: every package without a done line failed; the reason is the exit code and stderr.
func _finish(run: Dictionary) -> void:
	for k in run.order:
		var pk = run.packages[k]
		if pk.done:
			if pk.result == null:
				pk.ok = false
				pk.crash = "the cook wrote no readable report (%s)" % pk.report
			continue
		pk.done = true
		pk.ok = false
		pk.crash = crash_text(run)


## Why a run did not finish its packages, in words, with the last stderr lines.
func crash_text(run: Dictionary) -> String:
	var tail := "\n".join(run.err_lines.slice(maxi(0, run.err_lines.size() - 20))).strip_edges()
	if run.killed != "":
		return run.killed
	if run.code == 2:
		return "the cook refused the job: " + (tail if tail != "" else "exit code 2")
	return "the cook stopped (exit code %d)%s" % [run.code, (":\n" + tail) if tail != "" else ""]


## Wait for a package of a run (blocking, draining the pipes every 20 ms).
func wait_package(run: Dictionary, topo: String) -> Dictionary:
	var k := _key(topo)
	while not run.exited and not run.packages.get(k, {"done": true}).done:
		poll(run)
		if not run.exited and not run.packages.get(k, {"done": true}).done:
			OS.delay_msec(20)
	return run.packages.get(k, {})


## Wait for a whole run (blocking).
func wait(run: Dictionary) -> void:
	while not run.exited:
		poll(run)
		if not run.exited:
			OS.delay_msec(20)


## The running cook that has `topo` and has not finished it, or {}.
func run_with(topo: String) -> Dictionary:
	var k := _key(topo)
	for run in runs:
		if not run.exited and run.packages.has(k) and not run.packages[k].done:
			return run
	return {}


func kill(run: Dictionary, why := "the cook was stopped") -> void:
	if run.exited:
		return
	run.killed = why
	OS.kill(run.pid)


func kill_all() -> void:
	for run in runs.duplicate():
		kill(run, "the editor closed")
		var t0 := Time.get_ticks_msec()
		while not run.exited and Time.get_ticks_msec() - t0 < 2000:
			poll(run)
			OS.delay_msec(10)
	runs.clear()


## Remove a run from the list without reading it further (its process has been killed).
func forget(run: Dictionary) -> void:
	for i in range(runs.size() - 1, -1, -1):
		if is_same(runs[i], run):
			runs.remove_at(i)
