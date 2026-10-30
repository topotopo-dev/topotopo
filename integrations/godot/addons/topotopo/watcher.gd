@tool
extends Node
## Keeps packages current while their files change (graphs saved in TopoTopo's viewer, by an agent over MCP, by hand).
## Godot cannot see those files (they sit in .gdignore folders), so the watcher polls them: every watch_interval (1 s by
## default; 0 = only on focus-in) and at once when the editor gets focus, it stats the files the records name. A change
## waits 0.5 s for the next one, then every stale package cooks in one background process; a change to a package that
## is being cooked stops that cook and starts it again. What a cook wrote is imported when Godot's focus rule allows
## (plugin.gd flush). A cook that crashed or timed out is not tried again until its package's files change.

const Record := preload("record.gd")
const Runner := preload("runner.gd")
const DEBOUNCE_MS := 500

## plugin.gd
var host: Object
var _next := 0
## res:// .topo -> [sources stamp, outputs stamp]
var _stamps := {}
var _dirty := {}
var _last_change := 0
## The background cook, {} when none runs.
var _run := {}
## Packages waiting for the running cook to end: res:// .topo -> force.
var _queued := {}


func _process(_delta: float) -> void:
	if host == null:
		return
	host.poll_runs()
	host.poll_viewers()
	if host.headless:
		return
	host.flush()
	var now := Time.get_ticks_msec()
	var interval: float = float(host.runner.settings.get("watch_interval", 1.0))
	if _next == 0 or (interval > 0.0 and now >= _next):
		_next = now + int(maxf(interval, 0.1) * 1000.0) if interval > 0.0 else 0x7fffffffffffffff
		_poll(now)
	if _dirty.size() and now - _last_change >= DEBOUNCE_MS:
		_settle()


func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_IN and host != null:
		_next = 0
		host.queue_flush()


static func _stat(p: String) -> String:
	if not FileAccess.file_exists(p):
		return "-"
	return "%d:%d" % [FileAccess.get_modified_time(p), FileAccess.get_size(p)]


## The times and sizes of a package's sources: its .topo and import options, everything below graphs/, assets/ and
## inputs/ (and the folders its outputs listed), and the files outside them its record names.
func source_stamp(topo: String) -> String:
	var st = host.packages.get(topo)
	if st == null:
		return ""
	var parts := PackedStringArray([_stat(st.abs), _stat(st.abs + ".import")])
	var folders := ["graphs", "assets", "inputs"]
	var rec = st.record
	if typeof(rec) == TYPE_DICTIONARY:
		for f in Record._sorted_keys(rec.get("folders", {})):
			if not folders.has(f):
				folders.append(f)
	for folder in folders:
		var dir := Record.abs_of(st.dir, folder)
		for f in Record.listing(dir):
			parts.append("%s/%s=%s" % [folder, f, _stat(dir.path_join(f))])
	if typeof(rec) == TYPE_DICTIONARY:
		for rel in Record._sorted_keys(rec.get("sources", {})):
			if not (rel.begins_with("graphs/") or rel.begins_with("assets/") or rel.begins_with("inputs/")):
				parts.append("%s=%s" % [rel, _stat(Record.abs_of(st.dir, rel))])
	return "\n".join(parts).md5_text()


## The times and sizes of a package's record and output files.
func output_stamp(topo: String) -> String:
	var st = host.packages.get(topo)
	if st == null:
		return ""
	var parts := PackedStringArray([_stat(st.dir.path_join(Record.RECORD))])
	for f in Record.output_files(st.record):
		parts.append("%s=%s" % [f, _stat(Record.res_to_abs(host.project, f))])
	return "\n".join(parts).md5_text()


## Take the packages' files as they are now as seen (after the startup check, and after a package's cook).
func rebaseline(topo := "") -> void:
	for t in ([topo] if topo != "" else host.packages.keys()):
		if host.packages.has(t):
			_stamps[t] = [source_stamp(t), output_stamp(t)]


func _poll(now: int) -> void:
	for topo in host.packages:
		var st = host.packages[topo]
		if st.copy or st.root:
			continue
		var stamp := [source_stamp(topo), output_stamp(topo)]
		var old = _stamps.get(topo)
		_stamps[topo] = stamp
		# a package seen for the first time is new (the startup check took the first ones as seen)
		if old == null or old[0] != stamp[0] or (old[1] != stamp[1] and not st.cooking):
			_dirty[topo] = true
			_last_change = now


## After the changes settled: check the changed packages, cook the stale ones.
func _settle() -> void:
	var stale := []
	for topo in _dirty.keys():
		var st = host.packages.get(topo)
		if st == null:
			continue
		var fr: Dictionary = host.check(topo)
		if host.is_stale(fr) and st.crashed != source_stamp(topo):
			stale.append(topo)
	_dirty.clear()
	host.packages_changed.emit()
	if stale.is_empty() or not bool(host.runner.settings.get("live_cook", true)):
		return
	if not host.runner.found():
		host.say_missing_once()
		return
	cook_background(stale, false)


## Cook packages in the background (one process). A package the running cook has not finished stops that cook, which
## starts again with it; other packages wait for the running cook.
func cook_background(topos: Array, force: bool) -> void:
	if not _run.is_empty() and not _run.exited:
		var restart := false
		for t in topos:
			_queued[t] = bool(_queued.get(t, false)) or force
			var k := Runner._key(host._abs(t))
			if _run.packages.has(k) and not _run.packages[k].done:
				restart = true
		if restart:
			for k in _run.order:
				var pk = _run.packages[k]
				if not pk.done:
					var t: String = host._res(pk.topo)
					_queued[t] = bool(_queued.get(t, false)) or bool(_run.force)
			host.runner.kill(_run, "restart")
		return
	_start(topos, force)


func _start(topos: Array, force: bool) -> void:
	var list := []
	for t in topos:
		# a package another cook is on (an import's) is left to it
		if host.runner.run_with(host._abs(t)).is_empty():
			list.append(t)
	if list.is_empty():
		return
	_run = host.cook(list, force, false, true)


## A cook ended (plugin.gd collect): start what waited for it.
func run_ended(run: Dictionary) -> void:
	for k in run.order:
		var t: String = host._res(run.packages[k].topo)
		if host.packages.has(t):
			rebaseline(t)
			var st = host.packages[t]
			if host.is_stale(st.fresh) and st.crashed == "" and run.killed == "" and not _queued.has(t):
				# changed while it cooked: cook it again
				_dirty[t] = true
				_last_change = Time.get_ticks_msec()
	if not is_same(run, _run):
		return
	_run = {}
	if _queued.is_empty():
		return
	var forced := []
	var rest := []
	for t in _queued:
		(forced if _queued[t] else rest).append(t)
	_queued.clear()
	if forced.size():
		for t in rest:
			_queued[t] = false
		_start(forced, true)
	else:
		_start(rest, false)
