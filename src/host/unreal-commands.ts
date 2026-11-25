// The commands of the Unreal plugin's cook, setup and status, as every list of them says them: src/cli.ts (its header and
// --help), the help topic "unreal" (src/mcp/docs.ts), README.md and integrations/unreal/PROTOCOL.md, each of which holds
// every usage as it is here (test/unreal.ts checks). The commands themselves are src/host/unreal.ts and cook-command.ts.
export const UNREAL_COMMANDS: { usage: string; what: string }[] = [
  {
    usage: 'cook <.topo | package folder | folder>... --for unreal [--into </Game/folder>] [--flat] [--skip a,b] [--instancing packed|expand] [--force] [--no-cache] [--timeout <s>] [--report <file>] [--progress json] [--quiet]',
    what: 'cook the published outputs of packages inside an Unreal project\'s Content/ into Saved/TopoTopo/, only what changed, with the record <package>/.topotopo/unreal.json; what the plugin imports them from; options come from <id>.topo.import and flags override them',
  },
  {
    usage: 'unreal setup <unreal project folder or .uproject> [--no-enable]',
    what: 'install and enable the TopoTopo plugin in Plugins/TopoTopo/. Setup removes earlier TopoTopo plugin installs, records the CLI location, configures Auto Reimport exclusions and updates .gitignore',
  },
  {
    usage: 'unreal status <unreal project folder or .uproject> [--strict] [--json]',
    what: 'report whether the TopoTopo plugin is installed and show the state of every package and output under Content/. Use --strict to check package freshness and Auto Reimport exclusions in CI',
  },
];
