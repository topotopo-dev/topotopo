@tool
extends RefCounted
## The cook record of a TopoTopo package and the one freshness rule, ported from TopoTopo byte for byte
## (PROTOCOL.md in the TopoTopo repository: contentSha, listings, the import options, freshness). It uses no editor
## class, so the CI check (tools/check.gd) and the tests run it outside the editor.

const SCHEMA := 1
const FOR := "godot"
## The record, relative to the package folder.
const RECORD := ".topotopo/godot.json"
## A file a cook is writing.
const PART := ".topotopo-part"
## The package's TopoTopo folders, which Godot should not import (each holds an empty .gdignore).
const HIDDEN := ["graphs", "assets", "inputs", "exports", "versions", "packages"]
## Files hashed as they are, by their name (contentSha rule 1).
const BINARY := ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "tga", "tif", "tiff", "exr", "hdr", "dds", "ktx",
	"ktx2", "glb", "bin", "bgeo", "sc", "usdc", "usdz", "fbx", "abc", "vdb", "r16", "r32", "raw", "wasm", "ttf", "otf",
	"woff", "woff2", "zip", "gz", "7z", "pdf", "mp4", "webm", "wav", "ogg", "mp3"]
## The files engines write beside ours, which listings leave out.
const ENGINE_FILES := ["import", "uid", "translation", "uasset"]
## The import options' defaults (package_importer.gd).
const DEFAULTS := {"outputs/folder": "outputs", "outputs/per_output_folders": true, "outputs/skip": "", "instances/mode": 0}

## Hashes kept while a file's time and size stay the same: abs path -> [mtime, size, sha, hashed_at].
var _memo := {}


# ------------------------------------------------------------------------------------------------------- hashing

static func sha256(bytes: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	if bytes.size():
		ctx.update(bytes)
	return ctx.finish().hex_encode()


## A file's content as contentSha reads it: a text file with every CR LF read as LF; a binary format by its name, or a
## file with a NUL byte in its first 8000 bytes, as it is.
static func text_content(name: String, bytes: PackedByteArray) -> PackedByteArray:
	if BINARY.has(name.get_extension().to_lower()):
		return bytes
	if bytes.slice(0, mini(bytes.size(), 8000)).find(0) >= 0:
		return bytes
	var i := bytes.find(13)
	if i < 0:
		return bytes
	var out := PackedByteArray()
	var start := 0
	while i >= 0:
		if i + 1 < bytes.size() and bytes[i + 1] == 10:
			out.append_array(bytes.slice(start, i))
			start = i + 1
		i = bytes.find(13, i + 1)
	out.append_array(bytes.slice(start))
	return out


## TopoTopo's contentSha: the SHA-256 (lowercase hex) of a file's content read the way version control reads text.
static func content_sha(name: String, bytes: PackedByteArray) -> String:
	return sha256(text_content(name, bytes))


## contentSha of a file on disk ("" when it is not there), from the memo while its time and size are the same.
func file_content_sha(abs_path: String) -> String:
	return _hashed(abs_path, false)


## SHA-256 of a file's bytes ("" when it is not there), from the memo while its time and size are the same.
func file_raw_sha(abs_path: String) -> String:
	return _hashed(abs_path, true)


func _hashed(abs_path: String, raw: bool) -> String:
	if not FileAccess.file_exists(abs_path):
		return ""
	var key := ("raw:" if raw else "txt:") + abs_path
	var mtime := FileAccess.get_modified_time(abs_path)
	var size := FileAccess.get_size(abs_path)
	var m = _memo.get(key)
	# a file changed in the second its hash was taken may change again unseen (times have whole seconds): hash it again
	if m != null and m[0] == mtime and m[1] == size and mtime + 1 < m[3]:
		return m[2]
	var now := Time.get_unix_time_from_system()
	var sha := ""
	if raw or BINARY.has(abs_path.get_extension().to_lower()):
		sha = FileAccess.get_sha256(abs_path)
	else:
		var bytes := FileAccess.get_file_as_bytes(abs_path)
		if bytes.is_empty() and FileAccess.get_open_error() != OK:
			return ""
		sha = content_sha(abs_path, bytes)
	_memo[key] = [mtime, size, sha, now]
	return sha


func forget() -> void:
	_memo.clear()


# ------------------------------------------------------------------------------------------------------- listings

## A folder's listing: every file below it, as a path relative to it with forward slashes, sorted; names starting with
## "." left out, the files engines write beside ours and *.topotopo-part too. A folder that is not there lists nothing.
static func listing(dir: String) -> PackedStringArray:
	var out := PackedStringArray()
	_walk_listing(dir, "", 0, out)
	out.sort()
	return out


static func _walk_listing(dir: String, rel: String, depth: int, out: PackedStringArray) -> void:
	var d := DirAccess.open(dir)
	if d == null:
		return
	d.include_hidden = true
	d.include_navigational = false
	for f in d.get_files():
		if f.begins_with(".") or ENGINE_FILES.has(f.get_extension().to_lower()) or f.ends_with(PART):
			continue
		out.append(f if rel == "" else rel + "/" + f)
	if depth >= 32:
		return
	for sub in d.get_directories():
		if sub.begins_with("."):
			continue
		_walk_listing(dir.path_join(sub), sub if rel == "" else rel + "/" + sub, depth + 1, out)


static func same_set(a, b: PackedStringArray) -> bool:
	if not (a is Array or a is PackedStringArray) or a.size() != b.size():
		return false
	var x := PackedStringArray(a)
	x.sort()
	for i in x.size():
		if x[i] != b[i]:
			return false
	return true


# --------------------------------------------------------------------------------------------------------- paths

## A record's path of a file (relative to the package folder, or absolute) as an absolute path.
static func abs_of(dir: String, rel: String) -> String:
	if rel.is_absolute_path():
		return rel.simplify_path()
	return dir.path_join(rel).simplify_path()


## A res:// path in the project at `project` (absolute) as an absolute path.
static func res_to_abs(project: String, res: String) -> String:
	var rest := res.trim_prefix("res://")
	return project if rest == "" else project.path_join(rest).simplify_path()


## An absolute path inside the project as res://… ("" when it is outside).
static func abs_to_res(project: String, abs_path: String) -> String:
	var p := abs_path.replace("\\", "/").simplify_path()
	var root := project.replace("\\", "/").simplify_path().trim_suffix("/")
	var same := p == root if OS.get_name() != "Windows" else p.to_lower() == root.to_lower()
	if same:
		return "res://"
	var head := p.substr(0, root.length() + 1)
	var inside := head == root + "/" if OS.get_name() != "Windows" else head.to_lower() == (root + "/").to_lower()
	return "res://" + p.substr(root.length() + 1) if inside else ""


## A res:// path normalised: "." and ".." resolved, no doubled or trailing slash ("" when it leaves the project).
static func normal_res(res: String) -> String:
	var parts := PackedStringArray()
	for p in res.trim_prefix("res://").replace("\\", "/").split("/"):
		if p == "" or p == ".":
			continue
		if p == "..":
			if parts.is_empty():
				return ""
			parts.remove_at(parts.size() - 1)
		else:
			parts.append(p)
	return "res://" + "/".join(parts)


# ---------------------------------------------------------------------------------------------- import options

## The options as the record holds and compares them, from a .topo's import options (`params`: the keys of
## <id>.topo.import [params]; a missing key takes its default): {folder, instancing, per_output_folders, skip}, or
## {"error": why} for a folder outside the project.
static func options_from_params(params: Dictionary, topo_res: String, project: String) -> Dictionary:
	var folder_text = params.get("outputs/folder", DEFAULTS["outputs/folder"])
	if typeof(folder_text) != TYPE_STRING:
		folder_text = DEFAULTS["outputs/folder"]
	var folder := ""
	if folder_text.begins_with("res://"):
		folder = normal_res(folder_text)
	elif folder_text.is_absolute_path():
		folder = abs_to_res(project, folder_text)
		if folder != "":
			folder = normal_res(folder)
	else:
		folder = normal_res(topo_res.get_base_dir() + "/" + folder_text)
	if folder == "":
		return {"error": "the output folder %s is outside the Godot project: Godot names files by res:// paths" % folder_text}
	var per = params.get("outputs/per_output_folders", DEFAULTS["outputs/per_output_folders"])
	var skip_text = params.get("outputs/skip", DEFAULTS["outputs/skip"])
	var skip := PackedStringArray()
	for s in String(skip_text).split(","):
		var id := s.strip_edges()
		if id != "" and not skip.has(id):
			skip.append(id)
	skip.sort()
	var mode = params.get("instances/mode", DEFAULTS["instances/mode"])
	var expand: bool = (typeof(mode) == TYPE_INT and mode == 1) or (typeof(mode) == TYPE_FLOAT and int(mode) == 1) or (typeof(mode) == TYPE_STRING and mode == "Expand")
	return {"folder": folder, "instancing": "expand" if expand else "packed", "per_output_folders": per if typeof(per) == TYPE_BOOL else true, "skip": skip}


## The [params] of a .topo's import file (<id>.topo.import); {} when it has none.
static func import_params(topo_abs: String) -> Dictionary:
	var cf := ConfigFile.new()
	if cf.load(topo_abs + ".import") != OK or not cf.has_section("params"):
		return {}
	var out := {}
	for k in cf.get_section_keys("params"):
		out[k] = cf.get_value("params", k)
	return out


static func same_options(a, b: Dictionary) -> bool:
	if typeof(a) != TYPE_DICTIONARY:
		return false
	if String(a.get("folder", "")) != b.folder or String(a.get("instancing", "")) != b.instancing:
		return false
	if typeof(a.get("per_output_folders")) != TYPE_BOOL or a.per_output_folders != b.per_output_folders:
		return false
	return _id_set(a.get("skip", [])) == _id_set(b.skip)


static func _id_set(list) -> PackedStringArray:
	var out := PackedStringArray()
	if list is Array or list is PackedStringArray:
		for s in list:
			if not out.has(String(s)):
				out.append(String(s))
	out.sort()
	return out


# ------------------------------------------------------------------------------------------------------- records

## A package's record: {"record": Dictionary or null (none), "error": why it cannot be read, or ""}.
static func read_record(dir: String) -> Dictionary:
	var file := dir.path_join(RECORD)
	if not FileAccess.file_exists(file):
		return {"record": null, "error": ""}
	var text := FileAccess.get_file_as_string(file).trim_prefix("﻿")
	var json := JSON.new()
	if json.parse(text) != OK:
		return {"record": null, "error": "%s: %s (line %d)" % [file, json.get_error_message(), json.get_error_line()]}
	var raw = json.data
	if typeof(raw) != TYPE_DICTIONARY or not (typeof(raw.get("schema")) == TYPE_FLOAT or typeof(raw.get("schema")) == TYPE_INT):
		return {"record": null, "error": "%s is not a cook record (it has no \"schema\")" % file}
	return {"record": raw, "error": ""}


## "0.4.0" against "0.10.1": the dot-separated numbers (the leading digits of each part), a missing part 0.
static func compare_versions(a: String, b: String) -> int:
	var x := _version_parts(a)
	var y := _version_parts(b)
	for i in maxi(x.size(), y.size()):
		var d: int = (x[i] if i < x.size() else 0) - (y[i] if i < y.size() else 0)
		if d != 0:
			return d
	return 0


static func _version_parts(v: String) -> Array:
	var out := []
	for p in v.split("."):
		var digits := ""
		for c in p:
			if c >= "0" and c <= "9":
				digits += c
			else:
				break
		out.append(digits.to_int() if digits != "" else 0)
	return out


static func _sorted_keys(d) -> Array:
	if typeof(d) != TYPE_DICTIONARY:
		return []
	var keys: Array = d.keys()
	keys.sort()
	return keys


static func _fresh(state: String, why: String, path: String, text: String, note := "") -> Dictionary:
	return {"state": state, "why": why, "path": path, "note": note, "text": text}


## The one definition of freshness (PROTOCOL.md "Freshness"), checked in this order; the first rule that applies decides:
##   1. no record: never cooked; 2. a newer schema: stale (update the addon); another schema or flavour: stale;
##   3. other options; 4. a source missing or changed; 5. a folder's listing changed; 6. an output file missing or
##   changed: stale; 7. the installed TopoTopo (`installed`, "" when none is found) newer than the record's: stale
##   (older: the note "update_topotopo"); 8. an output failed: failed; 9. ok.
## `dir`: the package folder, `project`: the Godot project folder (both absolute); `options` as options_from_params.
func freshness(dir: String, record, options: Dictionary, project: String, installed: String) -> Dictionary:
	if record == null:
		return _fresh("never_cooked", "record", "", "never cooked")
	var schema := int(record.get("schema", 0))
	if schema > SCHEMA:
		return _fresh("stale", "newer_schema", "", "the record has schema %d, newer than this addon reads (%d): update the addon (topotopo godot setup <project>)" % [schema, SCHEMA])
	if schema != SCHEMA or record.get("for") != FOR:
		return _fresh("stale", "schema", "", "the record is of another kind (schema %d, for %s)" % [schema, record.get("for")])
	if not same_options(record.get("options"), options):
		return _fresh("stale", "options", "", "the import options changed since the last cook")
	var sources = record.get("sources", {})
	for rel in _sorted_keys(sources):
		var now := file_content_sha(abs_of(dir, rel))
		if now == "":
			return _fresh("stale", "source", rel, "%s is missing" % rel)
		if now != String(sources[rel]):
			return _fresh("stale", "source", rel, "%s changed after the last cook" % rel)
	var folders = record.get("folders", {})
	for folder in _sorted_keys(folders):
		if not same_set(folders[folder], listing(abs_of(dir, folder))):
			return _fresh("stale", "folder", folder, "%s/ holds other files than at the last cook" % folder)
	var outputs = record.get("outputs", {})
	for id in _sorted_keys(outputs):
		var files = outputs[id].get("files", {}) if typeof(outputs[id]) == TYPE_DICTIONARY else {}
		for file in _sorted_keys(files):
			var now := file_raw_sha(res_to_abs(project, file))
			if now == "":
				return _fresh("stale", "output", file, "%s is missing" % file)
			if now != String(files[file]):
				return _fresh("stale", "output", file, "%s was changed after the last cook" % file)
	var note := ""
	if installed != "":
		var c := compare_versions(installed, String(record.get("topotopo", "")))
		if c > 0:
			return _fresh("stale", "version", "", "cooked with TopoTopo %s; %s is installed" % [record.get("topotopo"), installed])
		if c < 0:
			note = "update_topotopo"
	var failed := []
	for id in _sorted_keys(outputs):
		if typeof(outputs[id]) == TYPE_DICTIONARY and outputs[id].get("state") == "failed":
			failed.append(id)
	if failed.size():
		return _fresh("failed", "failed", failed[0], "%s %s did not cook" % ["output" if failed.size() == 1 else "outputs", ", ".join(failed)], note)
	return _fresh("ok", "", "", "cooked, current", note)


## The output files a record lists (res://), outputs in id order, files in key order.
static func output_files(record) -> PackedStringArray:
	var out := PackedStringArray()
	if typeof(record) != TYPE_DICTIONARY:
		return out
	var outputs = record.get("outputs", {})
	for id in _sorted_keys(outputs):
		if typeof(outputs[id]) == TYPE_DICTIONARY:
			for f in _sorted_keys(outputs[id].get("files", {})):
				out.append(f)
	return out


# ------------------------------------------------------------------------------------------------ Godot's scan

## Every .topo Godot's scan of a project sees (absolute paths, sorted): names starting with "." are not seen, a folder
## holding .gdignore and a folder below the root holding project.godot are not entered.
static func find_topos(project: String) -> PackedStringArray:
	var out := PackedStringArray()
	_walk_project(project, 0, out)
	return out


static func _walk_project(dir: String, depth: int, out: PackedStringArray) -> void:
	var d := DirAccess.open(dir)
	if d == null:
		return
	d.include_hidden = true
	d.include_navigational = false
	var files := d.get_files()
	if depth > 0 and (files.has(".gdignore") or files.has("project.godot")):
		return
	var names := Array(files)
	names.sort()
	for f in names:
		if not f.begins_with(".") and f.length() > 5 and f.ends_with(".topo"):
			out.append(dir.path_join(f))
	if depth >= 64:
		return
	var subs := Array(d.get_directories())
	subs.sort()
	for s in subs:
		if not s.begins_with("."):
			_walk_project(dir.path_join(s), depth + 1, out)


static func _holds_topo(dir: String) -> bool:
	var d := DirAccess.open(dir)
	if d == null:
		return false
	d.include_hidden = true
	for f in d.get_files():
		if f.length() > 5 and f.ends_with(".topo"):
			return true
	return false


## A .topo that is a published copy, not a package: beside a version.json, in a topotopo-packages/ folder, or in the
## versions/ or packages/ folder of a package (a folder holding a .topo).
static func is_published_copy(topo_abs: String) -> bool:
	var dir := topo_abs.get_base_dir()
	if FileAccess.file_exists(dir.path_join("version.json")):
		return true
	var d := dir
	while true:
		var up := d.get_base_dir()
		if up == d or up == "":
			return false
		var name := d.get_file().to_lower()
		if name == "topotopo-packages":
			return true
		if (name == "versions" or name == "packages") and _holds_topo(up):
			return true
		d = up
	return false


## The package's TopoTopo folders Godot imports (no .gdignore): "graphs/" …
static func exposed(dir: String) -> PackedStringArray:
	var out := PackedStringArray()
	for h in HIDDEN:
		if DirAccess.dir_exists_absolute(dir.path_join(h)) and not FileAccess.file_exists(dir.path_join(h).path_join(".gdignore")):
			out.append(h + "/")
	return out
