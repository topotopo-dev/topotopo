# Contributing

Thanks for your interest. A few things to know before you start.

## How this project is run

- **One maintainer.** Reviews are slow, sometimes weeks. Small pull requests get reviewed first.
- **Open an issue before large changes.** New node families, engine changes, new dependencies or file formats
  need a short discussion first so the work is not wasted. Bug fixes and small nodes can go straight to a PR.
- **Every node needs tests and docs.** A node is one `defineNode()` whose params have a type, default and
  description (they generate the docs and drive validation), plus an `example`: a node spec or a small graph that
  cooks without errors (`npm test` cooks every example). Add a fixture in `test/fixtures.ts`, run
  `npm run test:update` for its golden, add behavioural checks to the matching `test/*.ts`, and run `npm run docs`.
- **Keep the core host-agnostic.** `src/core`, `src/graph` and `src/nodes` must not import Node APIs. Cooked geometry
  is immutable: `clone()` before writing. Y-up, metres, degrees, Houdini attribute names.
- **Licences.** Dependencies that ship must be MIT, Apache-2.0, BSD, ISC or MPL-2.0; build-time-only tooling may use other OSI-approved permissive licences (Unicode-3.0, Zlib, CC0). No GPL or AGPL anywhere in the tree.
  Run `npm run notice` after adding one so `NOTICE` carries its licence text; after a change to the Rust crates of
  `kernels/` (Cargo.lock) it needs `cargo`. `npm test` checks NOTICE without Rust.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run showcase     # then look at examples/renders/*.png
```

`npm test` runs smoke, golden, property, fuzz, docs, examples, io, interop, MCP and the per-feature suites. It fails on
missing goldens, stale `docs/nodes.md` or a stale `NOTICE`.

Development needs no build: Node runs `src/*.ts` directly. Only the npm package is compiled (`npm run build` writes
`dist/`, and `npm pack` / `npm publish` run it through `prepack`). Code that finds files relative to its own module
(the shelf, fonts, kernels, the worker entry, the viewer page) must work from `src/` and from `dist/`, which mirrors it.

## Before a release

```bash
npm run typecheck
npm test
npm run notice       # NOTICE for the current npm and Rust dependencies (Rust needs cargo), then commit it
npm run pack:test    # builds and packs the tarball, installs it in a temp project, runs the CLI, library and MCP server
npm pack --dry-run   # the file list that will be published
```

`npm run pack:test` is not part of `npm test` (it takes about a minute and needs the npm cache or network for the
install). It fails if the tarball misses a runtime file or carries sources, tests or examples, or if anything that
works from a clone breaks when installed from the tarball.

## Sign your commits (DCO)

Every commit needs a `Signed-off-by` line certifying the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "Add polyfill grid mode"
```

CI checks this on pull requests. Unsigned commits can be fixed with `git rebase --signoff`.

## Reporting bugs

Use the bug report template. A report must include the **graph JSON that reproduces it** (the smallest graph you can
make) and the output of `inspect` or the error text. Reports without a graph are closed.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
