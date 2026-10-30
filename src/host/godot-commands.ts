// The commands of the cook for an engine and of the Godot plugin's setup, as every list of them says them: src/cli.ts
// (its header and --help), the help topic "godot" (src/mcp/docs.ts), README.md and integrations/godot/PROTOCOL.md, each
// of which holds every usage as it is here (test/cook.ts checks). The commands themselves are src/host/godot.ts.
export const GODOT_COMMANDS: { usage: string; what: string }[] = [
  {
    usage: 'cook <.topo | package folder | folder>... --for godot [--into <folder>] [--flat] [--skip a,b] [--instancing packed|expand] [--adopt] [--force] [--no-cache] [--timeout <s>] [--report <file>] [--progress json] [--quiet]',
    what: 'cook the published outputs of packages inside a Godot project into it, one GLB (or PNG set) per output, only what changed, with the record <package>/.topotopo/godot.json; a folder means every package below it; options come from <id>.topo.import and flags override them',
  },
  {
    usage: 'cook --jobs <jobs.json> [--force] [--no-cache] [--progress json]',
    what: 'the Godot plugin\'s form: many packages in one process, each with its options and report (integrations/godot/PROTOCOL.md)',
  },
  {
    usage: 'godot setup <godot project folder> [--no-enable]',
    what: 'install the Godot plugin into a project: the addon, where TopoTopo is (~/.topotopo/config.json "install"), .gdignore in the TopoTopo folders of its packages, the plugin enabled, .gitignore lines, the addon kept out of every export preset, LFS warnings',
  },
  {
    usage: 'godot status <godot project folder> [--strict] [--json]',
    what: 'every package Godot sees: ok, failed, stale (and why) or never cooked, each output, exposed TopoTopo folders, output folders LFS does not cover; --strict exits 1 on any of them (for CI)',
  },
];
