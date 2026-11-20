// Test-only node for the disk cook cache tests (test/diskcache.ts): slow_wait waits `ms` milliseconds, then makes a
// triangle of size `value`. It lets a test have a node of a known duration, in this process and in a CLI run
// (test/diskcache-cli.ts registers it, then runs the CLI).
import '../src/nodes/index.ts';
import { Geometry } from '../src/core/geometry.ts';
import { defineNode } from '../src/graph/registry.ts';

export const SLOW_NODE = 'slow_wait';

defineNode({
  type: SLOW_NODE,
  category: 'test',
  summary: 'Test node: waits ms milliseconds, then makes a triangle of size value.',
  inputs: [],
  params: {
    ms: { type: 'int', default: 600, min: 0, desc: 'milliseconds to wait' },
    value: { type: 'float', default: 1, desc: 'size of the triangle' },
  },
  example: { type: SLOW_NODE, params: { ms: 0 } },
  async cook({ p, stat }) {
    await new Promise((r) => setTimeout(r, p.ms));
    stat('waited', p.ms);
    const g = new Geometry({ positions: [0, 0, 0, p.value, 0, 0, 0, p.value, 0], prims: [[0, 1, 2]] });
    g.detail.add('waited', 'float', 1).set(0, p.ms);
    return g;
  },
});
