# TopoTopo

LLM-native procedural geometry engine (Houdini-SOP style node graphs), headless core + MCP server.

- Runs TypeScript directly on Node ≥ 22.18 (type stripping): only erasable TS syntax, `import type` for types, `.ts` extensions in imports. No build step.
- Core (`src/core`, `src/graph`, `src/nodes`) must stay host-agnostic: Node APIs only in `src/host`, `src/mcp`, `src/viewer`, `src/gallery`, `src/workspace.ts`, `src/cli.ts`.
- New nodes: one `defineNode()` in `src/nodes/*`; params need type, default and desc (they drive docs, validation and the future GUI), and every node needs an `example` graph that cooks (`test/examples.ts`). Use `GeoBuilder` provenance so attributes carry through.
- Cooked geometry is immutable: `clone()` before writing.
- Conventions: Y-up, metres, degrees; Houdini attribute names.
- Verify: `npm run typecheck`, `npm test` (smoke, golden fingerprints, property + fuzz, docs staleness, io, MCP e2e), `npm run showcase` then look at `examples/renders/*.png`. New or changed geometry output: `npm run test:update`, review `git diff test/golden`, `npm run docs`, commit both. Node fixtures live in `test/fixtures.ts`.
- Design and roadmap: `docs/DESIGN.md`.
