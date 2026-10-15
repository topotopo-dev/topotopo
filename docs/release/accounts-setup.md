# Account setup briefs (GitHub org, npm, donations)

Briefs for a browser agent signed in as the owner. Common rule for every brief: do only what is listed; if a step
asks for a phone number, a verification code, bank or card details, a tax form, accepting new terms, or anything
not listed, stop and report. Report every field set and every step skipped.

## Brief A: GitHub organisation profile (topotopo-dev)

Open https://github.com/organizations/topotopo-dev/settings/profile.

1. Profile picture: upload `docs/brand/channel-1024.png` from the repository checkout.
2. Display name: `TopoTopo`.
3. Description: `Open-source procedural geometry engine: node graphs in JSON, headless, exported to Unreal, Blender and Houdini.`
4. URL: `https://topotopo.dev`. Email (public): `hello@topotopo.dev`. Location: leave empty. Twitter: leave empty.
5. Save ("Update profile").
6. Verified domain: open https://github.com/organizations/topotopo-dev/settings/domains → "Add a domain" → enter
   `topotopo.dev` → "Add domain". GitHub shows a DNS TXT record (name `_github-challenge-topotopo-dev` or similar,
   with a value). Copy the exact record name and value into your report and stop there; the orchestrator adds the
   record in Cloudflare, then the owner or the agent clicks "Verify" on the same page.
7. Open https://github.com/organizations/topotopo-dev/settings/member_privileges and confirm "Base permissions" is
   `Read` (do not change anything else).

## Brief B: npm

npm organisations have no avatar. The package page https://www.npmjs.com/package/topotopo shows the maintainers'
pictures, which come from Gravatar for the account email. Optional, owner only: create a Gravatar for the npm
account's email with `docs/brand/channel-1024.png`. Nothing for the agent to do beyond checking that
https://www.npmjs.com/package/topotopo shows the new description after the next publish.

## Brief C: donations

Recommendation: two channels, no more.

- **GitHub Sponsors** on the organisation (`topotopo-dev`): the Sponsor button appears on the repository, one-time
  and monthly tiers, zero fees for sponsors paying through GitHub. Setup is owner only (Stripe Connect, bank account,
  tax form): https://github.com/sponsors/accounts → "topotopo-dev" → Join the waitlist / Get started. If the
  organisation's country is not supported, enrol the personal account `faxcorp` instead; the sponsor page can still
  describe TopoTopo.
- **Ko-fi** (https://ko-fi.com) for people without a GitHub account: one-time tips, no platform fee on donations,
  PayPal or Stripe payout. Owner creates the account (email + payout), then the agent can fill the page.

Agent part, once the owner has created the accounts:

1. GitHub Sponsors profile (https://github.com/sponsors/topotopo-dev/dashboard/profile): short bio
   `TopoTopo is an open-source procedural geometry engine (Apache-2.0). Sponsorship pays for engine work, the Unreal plugin and the docs site.`;
   featured repository `topotopo-dev/topotopo`; tiers: one-time `€5` ("a coffee"), monthly `€5` ("supporter: name in
   the README"), monthly `€25` ("studio: name and logo in the README and on topotopo.dev"); goal: `€200 / month: covers
   CI minutes, the domain and one day a month of plugin maintenance`. Publish the profile.
2. Ko-fi page (https://ko-fi.com/manage): name `TopoTopo`, handle `topotopo`, picture `docs/brand/channel-1024.png`,
   cover `docs/brand/banner-2560x1440.png`, about text as above, link `https://topotopo.dev`. Keep memberships and
   shop off.
3. Report the final URLs. The orchestrator then adds `.github/FUNDING.yml` (shows the Sponsor button), a "Support"
   section in the README and a line on topotopo.dev.

Not recommended now: Open Collective (fiscal-host fee, worth it only with a community that spends the money),
Patreon (content subscriptions), crypto addresses (noise in the README).
