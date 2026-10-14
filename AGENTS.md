# Instructions for coding agents (Codex and others)

Read, in this order: `CLAUDE.md` (hard rules and verify steps), `CONTRIBUTING.md`, `docs/DESIGN.md`, `docs/WORKLOG.md`
(what is in flight; never duplicate a running item), and the brief you were given.

Rules that apply to every session:
- Work only on the branch and in the worktree you were given. Never commit to `main`, never push, never rebase.
- Commit with explicit `git add <paths>`; never add files you did not create or change for the task.
- Node >= 22.18 runs the TypeScript directly: only erasable TS syntax, `import type`, `.ts` import extensions, no build step.
  `src/core`, `src/graph`, `src/nodes` stay host-agnostic (no Node APIs).
- New node types: one `defineNode()`; params with type, default and desc; an `example` graph that cooks (`test/examples.ts` checks every node); a fixture in `test/fixtures.ts` and a golden via `npm run test:update`.
- Licences: permissive only for anything that ships (MIT, Apache-2.0, BSD, ISC, MPL-2.0, Unicode-3.0, Zlib, 0BSD, Unlicense, CC0); LGPL only for optional native modules our code never calls (sharp/libvips via gltf-transform). No GPL/AGPL anywhere in a dependency tree. Run `npm run notice`
  after adding an npm dependency; record Rust crate licences in the crate's README.
- Determinism: same inputs and seed give bit-identical outputs on every platform.
- Kernels: after your last source change under `kernels/src`, run `npm run kernels:build` and commit `kernels/pkg*/` so the binaries match the sources (the orchestrator rebuilds and compares; stale binaries fail the merge).
- Gates before you report: `npm run typecheck`, `npm test` (exit code 0; goldens unchanged unless the brief says
  otherwise), `npm run showcase` (renders byte-identical), plus the gates named in the brief.
- Report honestly: what passed, what did not, what you left out and why.
