// Keeps the disk cook cache (src/host/diskcache.ts) out of the tests: importing this points TOPOTOPO_NODE_CACHE_DIR at a
// folder of its own in the temp folder, deleted when the process ends. No test then writes to or reads from the user's
// real cache folder, so the suite behaves the same whether that folder is empty or full, and the processes a test starts
// (the CLI, the MCP server) inherit the folder through the environment.
//
// Every test that runs the CLI, the MCP server or a host with the cache on imports this first (test/fixtures.ts does,
// so every test that uses the fixtures is covered); test/diskcache.ts fails for a test file that starts one and does
// not. A process the MCP client starts with its own minimal environment must be handed TOPOTOPO_NODE_CACHE_DIR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-nodecache-'));
process.env.TOPOTOPO_NODE_CACHE_DIR = dir;
// an environment that switched the cache off would let a test that expects it on pass for the wrong reason
delete process.env.TOPOTOPO_NODE_CACHE;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folders are cleaned up anyway */ } });

/** The folder this process uses for the node cache. */
export const TEST_NODE_CACHE = dir;
