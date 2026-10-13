# Public flip and v0.2 checklist

The order matters: rename first (redirects follow), then public, then Pages and npm.

## 1. Repository rename (orchestrator, one command, after your go)

```bash
gh repo rename topotopo --repo topotopo-dev/polyforge --yes
```

GitHub redirects the old URL and `git` remotes keep working; the local remote is updated by the same command.
package.json, README and the site already say `topotopo-dev/topotopo`.

## 2. Public visibility (you, or the orchestrator on your word)

```bash
gh repo edit topotopo-dev/topotopo --visibility public --accept-visibility-change-consequences
```

What becomes true at that moment: the DCO check and `ci.yml` run on standard (free) runners; forks and stars are
possible; the licence (Apache-2.0) and NOTICE are what people see. Before flipping, confirm `git log origin/main` is
the state you want public (there is no history rewrite; every commit stays).

Settings to set in the GitHub UI right after (one minute):
- Discussions: enable (the issue template config links to them).
- Pages: Source = **GitHub Actions**; custom domain `topotopo.dev`; Enforce HTTPS once the certificate is issued.
- Branch protection for `main` (optional for a one-maintainer repo): require the DCO check.

## 3. DNS for the site (you, Cloudflare)

See `site-dns.md`: four A records and four AAAA records on the apex, `www` CNAME to `topotopo-dev.github.io`,
all **DNS only** (grey cloud); keep the MX/SPF/DKIM mail records. The `pages.yml` workflow deploys on the next push
to `main` (or run it manually from the Actions tab).

## 4. npm (you present for the security key)

```bash
npm whoami                      # faxcorp
npm run build && npm run pack:test
npm publish --access public      # from C:\WORK\polyforge, package topotopo, version from package.json
```

For the placeholder, publish the current `0.1.0` as is (the README says pre-release); for the real release bump
`package.json` to `0.2.0` first, commit, then publish and tag:

```bash
git tag -a v0.2.0 -m "TopoTopo v0.2.0" && git push origin v0.2.0
gh release create v0.2.0 --title "TopoTopo v0.2.0" --notes-file docs/release/v0.2-release-notes.md
```

## 5. After the release
- Watch the first CI run on `main` (ubuntu + windows) and the Pages deploy.
- Pin the issue templates' assumptions: reports need the graph JSON.
- Trademark reminder (R-6): once there is revenue or a grant.
