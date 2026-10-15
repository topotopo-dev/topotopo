# YouTube channel setup (TopoTopo)

Channel: https://www.youtube.com/channel/UCSbKiiImTnDJHtbZydjObWg (name **TopoTopo**, handle **@topotopodev**,
brand account managed by the owner's Google account). Created 2026-10-15. Below: the brief handed to a browser
agent for the one-time setup, and the items only the owner can do.

## Brief for the browser agent

You are setting up a new YouTube channel in YouTube Studio (https://studio.youtube.com). The channel is already
created and you are signed in as its owner. Do only what is listed; if a step asks for a phone number, a
verification code, a payment method, accepting new terms, or anything not listed here, stop and report instead.

### 1. Customization → Branding
- Picture: upload `docs/brand/channel-1024.png`.
- Banner image: upload `docs/brand/banner-2560x1440.png`.
- Video watermark: upload `docs/brand/watermark-150.png`, display time "Entire video".
- Publish.

### 2. Customization → Basic info
- Name: `TopoTopo` (capital T twice). Handle stays `@topotopodev`.
- Description (paste exactly):

```
TopoTopo is an open-source procedural geometry engine. You describe geometry as a node graph in JSON; the engine cooks it headless and deterministic, and exports it to Unreal, Blender and Houdini. Built for LLM agents through MCP, and for people through the CLI.

On this channel: terrain and environment builds, node-graph walkthroughs, Unreal PCG and Landscape imports, release notes.

Docs and install: https://topotopo.dev
Source (Apache-2.0): https://github.com/topotopo-dev/topotopo
npm: npm install topotopo
Contact: hello@topotopo.dev
```

- Links (in this order; the first one shows on the channel page):
  1. `Website` → https://topotopo.dev
  2. `GitHub` → https://github.com/topotopo-dev/topotopo
  3. `Discussions` → https://github.com/topotopo-dev/topotopo/discussions
  4. `npm` → https://www.npmjs.com/package/topotopo
- Contact info email: `hello@topotopo.dev`.
- Publish.

### 3. Settings (gear icon, bottom left)
- General → Currency: EUR.
- Channel → Basic info: Country of residence as the owner's country; Keywords (paste exactly):
  `procedural generation, procedural geometry, node graph, Houdini, Unreal Engine, Unreal PCG, Blender geometry nodes, terrain, erosion, MCP, LLM agents, open source, TypeScript, WebAssembly, TopoTopo`
- Channel → Advanced settings: Audience → "No, set this channel as Not made for kids". Leave "Automatic captions"
  and "Subscriber count visible" at their defaults (on).
- Channel → Feature eligibility: read only. Note which tier is enabled; do not start phone verification.
- Upload defaults → Basic info: Visibility `Private`; Title and Description empty; Tags
  `TopoTopo, procedural generation, Unreal Engine, Houdini, Blender`.
- Upload defaults → Advanced settings: Category `Science & Technology`; Video language `English`;
  License `Standard YouTube License`; Allow embedding on; Comments `Hold potentially inappropriate comments for review`;
  "Show how many viewers like this video" on.
- Community → Defaults: nothing to change.
- Save.

### 4. Report
List every field you set and anything you skipped, with the reason.

## Owner only
- **Phone verification** (Settings → Channel → Feature eligibility → Intermediate features): unlocks custom
  thumbnails, videos over 15 minutes and live streaming. Needed before the demo video upload (it will be longer
  than 15 min only if the walk-through is included; custom thumbnails are needed regardless).
- Channel trailer and featured sections (Customization → Layout): once the first video exists.
- FaxLab3D: add TopoTopo as a featured channel there, and this channel can feature FaxLab3D back.
