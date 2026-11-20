// The CLI with the test node slow_wait registered (test/diskcache-nodes.ts): node test/diskcache-cli.ts <graph.json> [options]
// A CLI run in a process of its own, as a person runs it, for test/diskcache.ts.
import './diskcache-nodes.ts';
await import('../src/cli.ts');
