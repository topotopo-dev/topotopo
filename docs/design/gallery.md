# TopoTopo Gallery

A website of a person's TopoTopo projects, organised as libraries on their own PC. A board, wiki or tracker links to a
project and embeds its 3D preview, as with a YouTube video or a Sketchfab model. LLM agents reach every library
through the MCP `library` tool. Version 1 is local and for one person: no accounts, bound to 127.0.0.1.

Code: `src/gallery/` (`library.ts` format and scan, `bake.ts` previews, `server.ts` the website, `pages.ts` HTML
templates, `cli.ts` commands, `app/` the pages' CSS and script), `src/viewer/app/embed.js` (the embed's 3D view),
`src/mcp/library.ts` (the tool), and `Workspace.watch()` (two processes on one project).

## Format

```
<library root>/                      a folder listed in the config
  props/lantern/                     a project; its parent folders ("props") are its collection
    project.json                     {id, title, description, tags, graph: "main", bake: {graph?, node?, frame?},
                                      links: [{label, url}], created}
    graphs/ assets/ inputs/ exports/ a normal workspace: the MCP server, `topotopo edit` and the viewer work on it as is
    attachments/                     concept art, references, source files (images are shown on the page)
    .gallery/                        thumb.png (512 px), preview.glb (meshopt), bake.json: derived, git-ignored
```

- **Config:** `~/.topotopo/config.json`, or `$TOPOTOPO_CONFIG`:
  `{"libraries": [{"name", "path"}], "gallery": {"port": 7340, "cors": ["http://localhost:3000"]}}`.
  `$TOPOTOPO_LIBRARIES` adds `name=path` entries, separated by the path delimiter.
  `topotopo library add <name> <folder>` writes the file.
- **Ids:** a project's `id` is the slug of its folder name when it was created. It is stored in project.json, so
  renaming or moving the folder keeps every link working.
  - Two projects with one id (a folder copied in Explorer) are reported on the gallery page. The first path keeps the
    id, and no file is rewritten.
  - Library names and ids match `^[a-z0-9][a-z0-9_-]*$`.
- **Scanning:**
  - A scan reads `project.json` files only: it never creates folders and never cooks.
  - It does not enter dot-folders, `node_modules`, a project's own folders, or a project inside a project. It goes at
    most 8 levels deep.
  - `updated` is not stored: it is the newest modification time of project.json, `graphs/` and `assets/`.
- **Bake key:** a hash of the bake version, the package version, the manifest's `graph` and `bake`, every graph and
  asset file's content, and each input file's path, size and time. A project is stale when its `bake.json` holds
  another key. Attachments and exports are not part of it.

## URLs (the contract a board relies on)

Always `http://127.0.0.1:<port>`. The server binds IPv4 only, and `localhost` can resolve to `::1` first.

| path | what |
|---|---|
| `/` | every library: collections, cards, search (`/` focuses it), tag filters, problems |
| `/p/<lib>/<id>` | the project page: 3D view, description, tags, links, attachments, graphs and vars, exports, board snippets |
| `/p/<lib>/<id>/thumb.png` | the baked thumbnail (a grey placeholder before the first bake; ETag) |
| `/p/<lib>/<id>/preview.glb` | the baked GLB (404 before the first bake) |
| `/embed/<lib>/<id>` | the iframe page: the GLB under an orbit camera, the thumbnail until it loads |
| `/p/<lib>/<id>/files/attachments/…`, `…/files/exports/…` | the project's files |
| `/p/<lib>/<id>/edit` | starts (or reuses) `topotopo edit <project>` and redirects to that viewer |
| `/api/projects` | the list as JSON, with absolute URLs and no file paths; CORS for the origins in `gallery.cors` |
| `/api/health`, `/api/events` | liveness (`{gallery: true}`); server-sent events for the pages |

On a board:

```html
<a href="http://127.0.0.1:7340/p/game/lantern">Lantern</a>
<img src="http://127.0.0.1:7340/p/game/lantern/thumb.png" width="256" alt="Lantern">
<iframe src="http://127.0.0.1:7340/embed/game/lantern" width="640" height="480" style="border:0" allow="fullscreen"></iframe>
```

The project page has copy buttons for all three snippets. The links work only while the gallery runs. To start it with
Windows, put a shortcut to `topotopo gallery` (or `node <checkout>\src\cli.ts gallery`) in `shell:startup`. A second
start finds the running gallery through `/api/health`, prints its URL and exits.

If the board is ever served from a non-local origin, Chrome's Local Network Access asks before such a page may load
127.0.0.1 content. The iframe may then need `allow="local-network-access"`.

## Baking

- **Where it runs:** the gallery never cooks in its own process. Cooks block the event loop and cannot be cancelled,
  and an engine's cache can hold over a gigabyte. Instead, `BakeQueue` runs `topotopo library bake <dir>` children:
  - one at a time, each project queued once;
  - at below-normal priority;
  - with `TOPOTOPO_SIM_TIMEOUT_MS=120000`, and a hard stop after 300 s.
- **What a bake writes:** each bake cooks the manifest's graph, or `bake.graph` / `bake.node` / `bake.frame` (a
  simulation that settles after frame 1). It writes:
  - `thumb.png`, a 512 px matcap view from the shelf thumbnail options plus the graph's `meta.thumbnail_render`;
  - `preview.glb`, with meshopt compression and the live viewer's GLB options. It is skipped above 50 MB.
- **Writes and failures:** files are written to a temporary name and renamed. A failed or stopped bake records why
  under the new key, so the same state is not retried in a loop, and it keeps the previous thumbnail and GLB.
- **When it runs:**
  - at start, for projects that are stale;
  - after a change, through a recursive watch per library root: `project.json`, `graphs/`, `assets/` or `inputs/`
    changed;
  - on the page's Re-bake button;
  - every 5 minutes, which covers folders whose watch is unreliable (OneDrive, network drives);
  - when a thumbnail is asked for and is missing.
- **Commands:** `topotopo library bake <project> | --stale | --all` bakes in the foreground. The MCP `library` tool's
  `bake` bakes the open project in the server's process and shows the result.

## Editing and agents

- **`topotopo edit <project>`** runs the live viewer on a project folder with `Workspace.watch()`. Under the gallery
  (`--json`) it prints its URL and stops after 10 minutes with no page open.
- **The MCP `library` tool** lists and searches every library, reads a project (`get`, optionally with the
  thumbnail), creates, updates and bakes projects, and opens one.
  - `open` replaces the server's workspace: a new engine and workspace on that folder, the tools rebuilt, and the live
    viewer switched (`Viewer.setWorkspace`).
  - The viewer keeps its URL, and its pages reconnect and reload.
  - The tool set does not change, so no `tools/list_changed` is sent.
- **`Workspace.watch()`** lets two processes work on one project, for example the gallery's editor and an MCP server.
  - A graph file whose content differs from the stored graph replaces it and notifies the listeners. A removed file
    removes the graph.
  - A process's own writes read back equal, so they change nothing.
  - A changed asset file is registered again and every graph is notified.
  - When both processes edit one graph at once, the last write wins.

## Security (local)

- **Requests:** requests must name the server as their `Host` (DNS rebinding), and a POST must come from the gallery's
  own pages.
- **Framing:** every page except `/embed/…` sends `frame-ancestors 'self'`.
- **Files:**
  - Files are served from `attachments/` and `exports/` only. Every decoded path segment is checked, and the real path
    must stay inside.
  - Responses carry `nosniff` and `CSP: sandbox`.
  - Anything that is not an image, PDF or text (SVG and HTML among them) is a download.

## Later

- **A public gallery on topotopo.dev:** `scripts/gen-site.ts` builds it from project folders with the same
  `pages.ts` templates and `embed.js`, using relative URLs. It copies three.js and the meshopt decoder into `site/`.
  It must fit the 25 MB site budget, and `check-site.ts` must count `data-src` as a use.
- **Accounts and uploads** need a server for sign-in (Google) and storage. The project folder stays the unit that is
  uploaded and served.
