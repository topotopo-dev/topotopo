@tool
extends Resource
## The imported resource of a TopoTopo package (<id>.topo): its status and its outputs. Levels and code never use it;
## they use the output GLBs, so a failed .topo import never breaks a level.

## The package id (the .topo file's name).
@export var package_id := ""
## The name it publishes under, or "".
@export var package_name := ""
@export var title := ""
## ok, failed (an output did not cook, or the package does not open), stale_no_topotopo (sources changed and TopoTopo
## is not set up here: the committed outputs are used).
@export var status := ""
@export_multiline var message := ""
## The TopoTopo version that cooked the outputs.
@export var topotopo_version := ""
## One entry per output: {id, label, kind, graph, files (res://), state (ok, failed), errors [{node, message, hint}]}.
@export var outputs: Array = []
## Outputs not imported: id -> why.
@export var skipped: Dictionary = {}
## Files outputs had and have no more, kept on disk: res:// -> output id.
@export var orphans: Dictionary = {}
@export var notes: PackedStringArray = PackedStringArray()
