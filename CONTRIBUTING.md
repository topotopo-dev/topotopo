# Contributing

Thanks for your interest. A few things to know before you start.

## How this project is run

- **One maintainer.** Reviews are slow, sometimes weeks. Small pull requests get reviewed first.
- **Open an issue before large changes.** New node families, engine changes, new dependencies or file formats
  need a short discussion first so the work is not wasted. Bug fixes and small nodes can go straight to a PR.
- **Every node needs tests and docs.** A node is one `defineNode()` whose params have a type, default and
  description (they generate the docs and drive validation). Add a fixture in `test/fixtures.ts`, run
  `npm run test:update` for its golden, add behavioural checks to the matching `test/*.ts`, and run `npm run docs`.
- **Keep the core host-agnostic.** `src/core`, `src/graph` and `src/nodes` must not import Node APIs. Cooked geometry
  is immutable: `clone()` before writing. Y-up, metres, degrees, Houdini attribute names.
- **Licences.** Dependencies must be MIT, Apache-2.0, BSD, ISC or MPL-2.0. No GPL or AGPL anywhere in the tree.
  Run `npm run notice` after adding one so `NOTICE` carries its licence text.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run showcase     # then look at examples/renders/*.png
```

`npm test` runs smoke, golden, property, fuzz, docs, io, interop, MCP and the per-feature suites. It fails on
missing goldens, stale `docs/nodes.md` or a stale `NOTICE`.

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
