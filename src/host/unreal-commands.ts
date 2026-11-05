// The commands of the Unreal plugin's cook, setup and status, as every list of them says them: src/cli.ts (its header and
// --help), the help topic "unreal" (src/mcp/docs.ts), README.md and integrations/unreal/PROTOCOL.md, each of which holds
// every usage as it is here (test/unreal.ts checks). The commands themselves are src/host/unreal.ts and cook-command.ts.
export const UNREAL_COMMANDS: { usage: string; what: string }[] = [
  {
    usage: 'cook <.topo | package folder | folder>... --for unreal [--into </Game/folder>] [--flat] [--skip a,b] [--instancing packed|expand] [--force] [--no-cache] [--timeout <s>] [--report <file>] [--progress json] [--quiet]',
    what: 'cook the published outputs of packages inside an Unreal project\'s Content/ into Saved/TopoTopo/, only what changed, with the record <package>/.topotopo/unreal.json; what the plugin imports them from; options come from <id>.topo.import and flags override them',
  },
  {
    usage: 'unreal setup <unreal project folder or .uproject> [--no-enable] [--with-pcg]',
    what: 'install the Unreal plugin into a project: Plugins/TopoTopoImport, where TopoTopo is (~/.topotopo/config.json "install"), the Auto Reimport exclusions of TopoTopo\'s folders, the plugin enabled in the .uproject, .gitignore lines; --with-pcg also installs TopoTopoPCG, which places terrain outputs',
  },
  {
    usage: 'unreal status <unreal project folder or .uproject> [--strict] [--json]',
    what: 'every package under Content/: ok, failed, stale (and why) or never cooked, each output, TopoTopo folders Auto Reimport still sees; --strict exits 1 on any of them (for CI)',
  },
];
