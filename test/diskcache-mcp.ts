// The MCP server with the test node slow_wait registered (test/diskcache-nodes.ts): node test/diskcache-mcp.ts [--package dir]
// A server in a process of its own, for test/diskcache.ts.
import './diskcache-nodes.ts';
await import('../src/mcp/server.ts');
