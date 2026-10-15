# Dogfood friction log

Companion to [dogfood-plan.md](dogfood-plan.md). One line per finding: what happened, how long it cost, what we did.
Status: **fixed** (commit), **filed** (issue), **deferred** (reason), **open**.

| # | Date | Step | Finding | Status |
|---|------|------|---------|--------|
| 1 | 2026-10-15 | fresh install | `npm install topotopo@0.1.0` in an empty folder: 143 packages, 14 s; `npx topotopo --help`, `--catalog` and cooking a box graph with `--inspect all` work from the published tarball. | ok |
| 2 | 2026-10-15 | fresh install | `topotopo --version` (and any unknown leading option, a missing graph file, or invalid JSON) printed a Node ENOENT stack trace. | fixed: `--version`/`-v`, plain one-line errors, tests in test/engine.ts |
| 3 | 2026-10-15 | site | https://www.topotopo.dev has no certificate yet (the apex has one and enforces HTTPS; http://www redirects to the apex, so only a typed `https://www` URL fails). | open: GitHub issues the www cert later; re-check |
