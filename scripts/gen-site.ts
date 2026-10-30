// Generate the documentation site for https://topotopo.dev from the repository into site/ (gitignored).
//   npm run site          node scripts/gen-site.ts
//   npm run site:check    broken internal links, missing images, unused files, size budget (scripts/check-site.ts)
// Every page is built from files in the repository at build time, so the site cannot drift from them:
//   index.html           README.md (positioning paragraph, capability list, install, graph and MCP snippets, the MCP
//                        tool names), counts from the node registry, TopoTopo's own packages and examples/, renders
//                        from examples/renders
//   nodes/               one page per category from the registered NodeDefs and the outputs of TopoTopo's own packages
//                        (the data of docs/nodes.md)
//   packages/            TopoTopo's own packages: the built-in packages of library/, their outputs with the thumbnails in
//                        library/<name>/thumbs
//   examples/            every examples/*.json with its render, its description and the graph JSON itself
//   releases/            docs/release/v*-release-notes.md converted from Markdown
//   404.html, subscribed.html, CNAME, .nojekyll, robots.txt, sitemap.xml, style.css (scripts/site/style.css), favicon.svg (docs/brand/mark.svg)
// Links are relative, so the site works at the domain root, under a sub-path and from the file system; only 404.html,
// which GitHub Pages serves for a missing path at any depth, uses root-absolute links. Only files a page uses are
// copied. .github/workflows/pages.yml builds, checks and deploys the site on every push to main.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Marked, Renderer } from 'marked';
import type { Token, Tokens } from 'marked';
import '../src/nodes/index.ts';
import { CATEGORY_ORDER, allNodeDefs, getNodeDef } from '../src/graph/registry.ts';
import type { NodeDef, ParamDef } from '../src/graph/types.ts';
import { anchorOf, builtinDefs, thumbOf } from './gen-docs.ts';
import { builtinText, readBuiltin, typesUsed } from './gen-builtin.ts';
import { ROOT, SITE_DIR, SIZE_LIMIT, listFiles } from './check-site.ts';

/** The renders on the home page, in order (the first is also the social preview image). */
const HERO: { name: string; caption: string }[] = [
  { name: 'street_block', caption: 'A street block assembled only from TopoTopo\'s own packages: houses, road, lamp posts, trees, fences.' },
  { name: 'unreal_demo', caption: 'The Unreal 5.8 demo scene: an eroded heightfield that fits a Landscape exactly, a road, packed trees and rocks.' },
  { name: 'terrain_erosion', caption: 'Hydraulic and thermal erosion on a ridged massif, a road cut along a curve, rocks on the steep slopes.' },
  { name: 'rbd_settle', caption: 'Rigid bodies: rocks of the nature package dropped onto a terrain until they rest, crates piled one at a time.' },
  { name: 'particles', caption: 'Particles running down an eroded massif with curl noise and sliding contacts, next to a fountain.' },
  { name: 'textures', caption: 'A brick material from texture nodes, and a crate whose baked AO and curvature become worn paint.' },
  { name: 'quad_remesh', caption: 'Field-aligned quad remeshing (Rust/WASM): each input on the left, its quads on the right.' },
  { name: 'house_city', caption: 'Nested generators: the architecture package\'s house spawned on a grid of lots, varied per lot.' },
];

// ---------------------------------------------------------------------------------------------------------------------
// repository data

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
const pkg = JSON.parse(read('package.json'));
const SITE_URL = String(pkg.homepage || 'https://topotopo.dev').replace(/\/+$/, '');
const DOMAIN = new URL(SITE_URL).host;
const REPO = String(pkg.repository?.url || 'https://github.com/topotopo-dev/topotopo').replace(/^git\+/, '').replace(/\.git$/, '');
const BRANCH = 'main';
const CONTACT = /<([^<>\s]+@[^<>\s]+)>/.exec(String(pkg.author ?? ''))?.[1] ?? null;
// Cloudflare Web Analytics (cookieless page views): the site token from the Cloudflare dashboard (the account
// that holds the topotopo.dev zone), Observability → Analytics → Web analytics → topotopo.dev → Manage site. It is public (it ships in every page); empty leaves the beacon out.
const CF_BEACON_TOKEN = 'e166f98611114840beed8a8e61ea96bd';
// The mailing list (Kit, double opt-in): a plain form posting to the list's subscribe endpoint, no third-party script.
const NEWS_FORM = 'https://app.kit.com/forms/10119525/subscriptions';
const YOUTUBE = 'https://www.youtube.com/@topotopodev';
// TopoTopo's own accounts, in the footer's Follow line (personal accounts stay off the site)
const SOCIAL = [
  { label: 'GitHub', href: REPO },
  { label: 'YouTube', href: YOUTUBE },
  { label: 'Bluesky', href: 'https://bsky.app/profile/topotopo.dev' },
];
const COMMIT = (() => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; }
})();

const nodeDefs = allNodeDefs();
const packageOutputs = await builtinDefs();
const defs = [...nodeDefs, ...packageOutputs];
const categories = [...CATEGORY_ORDER, ...[...new Set(defs.map((d) => d.category))].filter((c) => !CATEGORY_ORDER.includes(c)).sort()]
  .filter((c) => defs.some((d) => d.category === c));
// a fixed collation: localeCompare without a locale follows the machine's LANG
const byCat = new Map(categories.map((c) => [c, defs.filter((d) => d.category === c).sort((a, b) => a.type.localeCompare(b.type, 'en'))]));
const catOf = new Map(defs.map((d) => [d.type, d.category]));
const nodeCategories = categories.filter((c) => c !== 'package');
/** Canonical node type of a name or alias used in a graph (null for saved assets and unknown names). */
const resolveType = (t: string) => (catOf.has(t) ? t : getNodeDef(t)?.type ?? null);

const builtin = readBuiltin();
/** The outputs of TopoTopo's own packages, each package's default output aside (it lines the others up). */
const builtinOutputs = builtin.flatMap((k) => k.outputs);
/** docs/nodes.md anchors of the node types (a full name loses its slashes there) */
const byAnchor = new Map(defs.map((d) => [anchorOf(d.type), d.type]));

interface Example { name: string; graph: any; description: string; types: string[]; nodes: number; render: string | null }
const examples: Example[] = fs.readdirSync(path.join(ROOT, 'examples')).filter((f) => f.endsWith('.json')).sort().map((f) => {
  const name = f.slice(0, -'.json'.length);
  const graph = JSON.parse(read(`examples/${f}`));
  const render = exists(`examples/renders/${name}.png`) ? `examples/renders/${name}.png` : null;
  if (!render) console.warn(`warning: examples/renders/${name}.png is missing (npm run showcase)`);
  const types = [...new Set([...typesUsed(graph)].map((t) => resolveType(t) ?? t))].sort();
  return { name, graph, description: String(graph.meta?.description ?? graph.description ?? ''), types, nodes: Object.keys(graph.nodes ?? {}).length, render };
});
const usedIn = new Map<string, string[]>();
for (const e of examples) for (const t of e.types) usedIn.set(t, [...(usedIn.get(t) ?? []), e.name]);

const versionKey = (v: string) => v.slice(1).split('.').map((n) => Number(n) || 0);
const releases = fs.readdirSync(path.join(ROOT, 'docs', 'release'))
  .map((f) => /^(v\d+(?:\.\d+)*)-release-notes\.md$/.exec(f))
  .filter((m): m is RegExpExecArray => !!m)
  .map((m) => ({ version: m[1], src: `docs/release/${m[0]}`, out: `releases/${m[1]}.html` }))
  .sort((a, b) => {
    const x = versionKey(a.version), y = versionKey(b.version);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });

// ---------------------------------------------------------------------------------------------------------------------
// pages, links and copied files

interface Page { out: string; title: string; description: string; nav: string; abs?: boolean; html?: string }
const pages: Page[] = [];
let cur: Page = { out: 'index.html', title: '', description: '', nav: '' };
/** site path → repository path of every copied file (only what pages use). */
const copies = new Map<string, string>();

const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decodeEntities = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The URL of a site path (with optional #fragment) as seen from the current page. */
function url(to: string): string {
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(to)) return to;
  const hash = to.indexOf('#');
  const p = hash < 0 ? to : to.slice(0, hash), frag = hash < 0 ? '' : to.slice(hash);
  if (cur.abs) return '/' + p + frag;
  if (p === cur.out) return frag || path.posix.basename(p);
  return path.posix.relative(path.posix.dirname(cur.out), p) + frag;
}
/** url() escaped for an attribute. */
const u = (to: string) => esc(url(to));

/** Copy a repository file into the site (at the same path unless given) and return its site path. */
function useFile(repoRel: string, siteRel = repoRel): string {
  if (!exists(repoRel)) throw new Error(`gen-site: ${repoRel} does not exist`);
  copies.set(siteRel, repoRel);
  return siteRel;
}

function pngSize(repoRel: string): [number, number] | null {
  const b = fs.readFileSync(path.join(ROOT, repoRel));
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function img(repoRel: string, alt: string, o: { lazy?: boolean; cls?: string } = {}): string {
  const size = pngSize(repoRel);
  return `<img src="${u(useFile(repoRel))}" alt="${esc(alt)}"${size ? ` width="${size[0]}" height="${size[1]}"` : ''}` +
    `${o.lazy === false ? '' : ' loading="lazy"'} decoding="async"${o.cls ? ` class="${o.cls}"` : ''}>`;
}

/** Site page of a docs/nodes.md anchor: a category ("generate-nodes") or a node type. */
function nodeTarget(frag: string): string {
  if (!frag) return 'nodes/index.html';
  if (frag.endsWith('-nodes') && byCat.has(frag.slice(0, -'-nodes'.length))) return `nodes/${frag.slice(0, -'-nodes'.length)}.html`;
  const t = byAnchor.get(frag) ?? frag, c = catOf.get(t);
  return c ? `nodes/${c}.html#${t}` : 'nodes/index.html';
}

/** The site path a repository path (+ fragment) maps to, or null when the site has no page for it. */
function siteTarget(repoPath: string, frag: string): string | null {
  const f = frag ? '#' + frag : '';
  if (repoPath === 'docs/nodes.md') return nodeTarget(frag);
  const rel = releases.find((r) => r.src === repoPath);
  if (rel) return rel.out + f;
  if (repoPath === 'examples' || repoPath === 'examples/renders') return 'examples/index.html';
  let m = /^examples\/([\w.-]+)\.json$/.exec(repoPath);
  if (m && examples.some((e) => e.name === m![1])) return `examples/index.html#${m[1]}`;
  if (repoPath === 'library') return 'packages/index.html';
  m = /^library\/([\w-]+)(?:\/graphs\/([\w-]+)\.json)?$/.exec(repoPath);
  if (m && builtin.some((k) => k.name === m![1])) return m[2] && m[2] !== 'lineup' ? `packages/index.html#topotopo/${m[1]}/${m[2]}` : `packages/index.html#${m[1]}`;
  if (/^(examples\/renders|library\/[\w-]+\/thumbs)\/[\w.-]+\.png$/.test(repoPath) && exists(repoPath)) return useFile(repoPath);
  return null;
}

/** GitHub URL of a repository path. */
function repoUrl(repoPath: string, frag = ''): string {
  const isDir = exists(repoPath) && fs.statSync(path.join(ROOT, repoPath)).isDirectory();
  return `${REPO}/${isDir ? 'tree' : 'blob'}/${BRANCH}/${repoPath.split('/').map(encodeURIComponent).join('/')}${frag ? '#' + frag : ''}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Markdown and code

interface MdCtx { src: string; whole: boolean; slugs: Map<string, number>; toc: { depth: number; id: string; html: string }[] }
let md: MdCtx = { src: 'README.md', whole: false, slugs: new Map(), toc: [] };
const newCtx = (src: string, whole: boolean): MdCtx => ({ src, whole, slugs: new Map(), toc: [] });

/** GitHub-style heading slug. */
const slugify = (text: string) => text.toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
function uniqueSlug(text: string, slugs: Map<string, number>): string {
  const base = slugify(text) || 'section';
  const n = slugs.get(base) ?? 0;
  slugs.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

/** A Markdown link or image target from the current source file, as the URL to use on the current page. */
function mapLink(href: string, image: boolean): string {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return href;
  if (href.startsWith('#')) return md.whole ? href : repoUrl(md.src, href.slice(1));
  const hash = href.indexOf('#');
  const p = hash < 0 ? href : href.slice(0, hash), frag = hash < 0 ? '' : href.slice(hash + 1);
  const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(md.src), decodeURI(p))).replace(/\/+$/, '');
  const target = siteTarget(repoPath, frag);
  if (target) return url(target);
  if (!exists(repoPath)) console.warn(`warning: ${md.src} links to ${href}, which is not in the repository`);
  else if (image) return url(useFile(repoPath));
  return repoUrl(repoPath, frag);
}

const WIDTH = 80;
/** JSON on one line with spaces after colons and commas. */
function flatJson(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(flatJson).join(', ') + ']';
  const entries = Object.entries(v).filter(([, x]) => x !== undefined);
  return entries.length ? '{ ' + entries.map(([k, x]) => `${JSON.stringify(k)}: ${flatJson(x)}`).join(', ') + ' }' : '{}';
}
/** JSON with short arrays and objects kept on one line (examples read better than JSON.stringify(v, null, 2)). */
function fmtJson(v: any, indent = '', used = indent.length): string {
  const flat = flatJson(v);
  if (v === null || typeof v !== 'object' || used + flat.length <= WIDTH) return flat;
  const inner = indent + '  ';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every((x) => x === null || typeof x !== 'object')) {
      const lines: string[] = [];
      let line = '';
      for (const s of v.map(flatJson)) {
        const next = line ? `${line}, ${s}` : s;
        if (line && inner.length + next.length + 1 > WIDTH) { lines.push(line); line = s; } else line = next;
      }
      lines.push(line);
      return '[\n' + lines.map((l) => inner + l).join(',\n') + '\n' + indent + ']';
    }
    return '[\n' + v.map((x) => inner + fmtJson(x, inner)).join(',\n') + '\n' + indent + ']';
  }
  const entries = Object.entries(v).filter(([, x]) => x !== undefined);
  if (!entries.length) return '{}';
  return '{\n' + entries.map(([k, x]) => {
    const key = JSON.stringify(k) + ': ';
    return inner + key + fmtJson(x, inner, inner.length + key.length);
  }).join(',\n') + '\n' + indent + '}';
}

function highlightJson(src: string): string {
  let out = '', last = 0;
  for (const m of src.matchAll(/("(?:[^"\\\n]|\\.)*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b/g)) {
    out += esc(src.slice(last, m.index));
    if (m[1]) out += m[2] ? `<span class="hl-k">${esc(m[1])}</span>${m[2]}` : `<span class="hl-s">${esc(m[1])}</span>`;
    else if (m[3]) out += `<span class="hl-n">${m[3]}</span>`;
    else out += `<span class="hl-l">${m[4]}</span>`;
    last = m.index! + m[0].length;
  }
  return out + esc(src.slice(last));
}

const highlightShell = (src: string) => src.split('\n').map((line) => {
  const m = /(^|\s)(#(?:\s.*)?)$/.exec(line);
  return m ? esc(line.slice(0, m.index + m[1].length)) + `<span class="hl-c">${esc(m[2])}</span>` : esc(line);
}).join('\n');

function codeBlock(text: string, lang = ''): string {
  const l = lang.split(/\s/)[0].toLowerCase();
  const body = l === 'json' ? highlightJson(text) : ['bash', 'sh', 'shell', 'console'].includes(l) ? highlightShell(text) : esc(text);
  return `<pre${l ? ` class="lang-${esc(l)}"` : ''}><code>${body}</code></pre>\n`;
}

const marked = new Marked({ gfm: true, async: false });
marked.use({
  renderer: {
    heading({ tokens, depth }: Tokens.Heading) {
      const inner = this.parser.parseInline(tokens);
      const id = uniqueSlug(decodeEntities(this.parser.parseInline(tokens, this.parser.textRenderer)), md.slugs);
      if (depth === 2 || depth === 3) md.toc.push({ depth, id, html: inner });
      return `<h${depth} id="${esc(id)}">${inner}<a class="anchor" href="#${esc(id)}" aria-label="Link to this section">#</a></h${depth}>\n`;
    },
    // raw HTML in Markdown is shown as text: NodeDef texts say "image:<name>", and no page needs inline HTML
    html({ text }: Tokens.HTML | Tokens.Tag) { return text.trim().startsWith('<!--') ? '' : esc(text); },
    code({ text, lang }: Tokens.Code) { return codeBlock(text, lang ?? ''); },
    table(token: Tokens.Table) { return `<div class="table-wrap">${Renderer.prototype.table.call(this, token)}</div>\n`; },
    image({ href, text }: Tokens.Image) { return `<img src="${esc(href)}" alt="${esc(text)}" loading="lazy" decoding="async">`; },
  },
});

/** Render Markdown tokens from a repository file on the current page (links and images mapped to the site). */
function renderTokens(tokens: Token[], ctx: MdCtx): string {
  const prev = md;
  md = ctx;
  try {
    marked.walkTokens(tokens, (t) => {
      if (t.type === 'link' || t.type === 'image') (t as Tokens.Link).href = mapLink((t as Tokens.Link).href, t.type === 'image');
    });
    return marked.parser(tokens);
  } finally { md = prev; }
}
const inline = (text: string) => marked.parseInline(text, { async: false });
const block = (text: string) => marked.parse(text, { async: false });
/** Plain text of a Markdown snippet (for meta descriptions). */
const plain = (text: string) => decodeEntities(inline(text).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const clip = (s: string, n = 160) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n - 1)).replace(/[,;:(]$/, '') + '…');

// ---------------------------------------------------------------------------------------------------------------------
// layout

const NAV = [
  { key: 'nodes', label: 'Nodes', to: 'nodes/index.html' },
  { key: 'packages', label: 'Packages', to: 'packages/index.html' },
  { key: 'examples', label: 'Examples', to: 'examples/index.html' },
  ...(releases.length ? [{ key: 'releases', label: 'Release notes', to: releases[0].out }] : []),
];

const heroExamples = HERO.filter((h) => {
  const ok = examples.some((e) => e.name === h.name && e.render);
  if (!ok) console.warn(`warning: hero example ${h.name} has no graph or render; left out of the home page`);
  return ok;
});
if (!heroExamples.length) throw new Error('gen-site: none of the hero examples exists');
const OG_IMAGE = `examples/renders/${heroExamples[0].name}.png`;

function layout(p: Page, body: string): string {
  const title = p.out === 'index.html' ? p.title : `${p.title} · TopoTopo`;
  const canonical = `${SITE_URL}/${p.out.replace(/(^|\/)index\.html$/, '$1')}`;
  const current = (n: { key: string; to: string }) => (n.to === p.out ? ' aria-current="page"' : p.nav === n.key ? ' aria-current="true"' : '');
  const nav = NAV.map((n) => `<li><a href="${u(n.to)}"${current(n)}>${n.label}</a></li>`).join('');
  const sha = COMMIT ? `<a href="${esc(`${REPO}/commit/${COMMIT}`)}">${esc(COMMIT.slice(0, 7))}</a>` : 'the repository';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<meta name="description" content="${esc(p.description)}">
${p.abs ? '' : `<link rel="canonical" href="${esc(canonical)}">
<meta property="og:url" content="${esc(canonical)}">
`}<meta property="og:type" content="website">
<meta property="og:site_name" content="TopoTopo">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:image" content="${esc(`${SITE_URL}/${useFile(OG_IMAGE)}`)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${u('favicon.svg')}" type="image/svg+xml">
<link rel="stylesheet" href="${u(useFile('scripts/site/style.css', 'style.css'))}">
${CF_BEACON_TOKEN ? `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='${esc(JSON.stringify({ token: CF_BEACON_TOKEN }))}'></script>
` : ''}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header"><div class="wrap">
<a class="brand" href="${u('index.html')}"><img src="${u('favicon.svg')}" alt="" width="26" height="26">TopoTopo</a>
<nav class="site-nav" aria-label="Main"><ul>${nav}<li class="ext"><a href="${esc(REPO)}">GitHub</a></li><li class="ext"><a href="${YOUTUBE}">YouTube</a></li></ul></nav>
</div></header>
<main id="main" class="wrap">
${body.trim()}
</main>
<footer class="site-footer"><div class="wrap">
<form class="news" action="${NEWS_FORM}" method="post">
<label for="news-email">TopoTopo news: releases and new packs, about once a month.</label>
<span><input id="news-email" name="email_address" type="email" required placeholder="you@example.com" autocomplete="email"><button class="button primary" type="submit">Subscribe</button></span>
</form>
<p class="follow">Follow TopoTopo: ${SOCIAL.map((s) => `<a href="${esc(s.href)}">${s.label}</a>`).join(' · ')}</p>
<p>TopoTopo is open source under the ${esc(pkg.license ?? 'Apache-2.0')} licence. <a href="${esc(REPO)}">Source on GitHub</a> · <a href="https://github.com/sponsors/faxlab">Sponsor</a>${CONTACT ? ` · <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>` : ''}</p>
<p>Generated from ${sha} by <code>scripts/gen-site.ts</code>: every page is built from the files in the repository.</p>
</div></footer>
</body>
</html>
`;
}

function page(p: Page, body: () => string): void {
  cur = p;
  p.html = layout(p, body());
  pages.push(p);
}

// ---------------------------------------------------------------------------------------------------------------------
// home

const readme = marked.lexer(read('README.md'));
const isHeading = (t: Token, text?: string | RegExp): t is Tokens.Heading =>
  t.type === 'heading' && (text === undefined || (typeof text === 'string' ? (t as Tokens.Heading).text.trim() === text : text.test((t as Tokens.Heading).text)));
/** The tokens under a README heading, up to the next heading of the same or a higher level. */
function section(tokens: Token[], title: string | RegExp): Token[] {
  const i = tokens.findIndex((t) => isHeading(t, title));
  if (i < 0) return [];
  const depth = (tokens[i] as Tokens.Heading).depth;
  let j = i + 1;
  while (j < tokens.length && !(isHeading(tokens[j]) && (tokens[j] as Tokens.Heading).depth <= depth)) j++;
  return tokens.slice(i + 1, j);
}
function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`gen-site: README.md has no ${what} (the home page is built from it)`);
  return v;
}
const findCode = (tokens: Token[], test: RegExp, lang?: string) =>
  tokens.find((t) => t.type === 'code' && (!lang || (t as Tokens.Code).lang === lang) && test.test((t as Tokens.Code).text)) as Tokens.Code | undefined;
const findPara = (tokens: Token[], test: RegExp) => tokens.find((t) => t.type === 'paragraph' && test.test((t as Tokens.Paragraph).text)) as Tokens.Paragraph | undefined;

const firstH2 = readme.findIndex((t) => isHeading(t) && (t as Tokens.Heading).depth === 2);
const intro = readme.slice(0, firstH2 < 0 ? readme.length : firstH2);
// the positioning paragraph starts with text (the rename note above it is all emphasis, the city render an image)
const positioning = need(intro.find((t) => t.type === 'paragraph' && (t as Tokens.Paragraph).tokens[0]?.type === 'text') as Tokens.Paragraph | undefined,
  'positioning paragraph before the first ## heading');
const capabilities = need(intro.find((t) => t.type === 'list') as Tokens.List | undefined, 'capability list before the first ## heading');
const setup = section(readme, 'Setup');
const nodeReq = findPara(setup, /^Requires Node/);
const npxBlock = need(findCode(setup, /npx /), 'npx code block under "## Setup"');
const notOnNpm = findPara(setup, /not on npm yet/i);
const graphFormat = section(readme, 'Graph format');
const graphJson = need(findCode(graphFormat, /"nodes"/, 'json'), 'json graph under "## Graph format"');
const conventions = findPara(graphFormat, /conventions/i);
const claudeCode = need(findCode(section(readme, 'Connect to Claude Code'), /claude mcp add/), '"claude mcp add" block under "### Connect to Claude Code"');
const mcpJson = need(findCode(section(readme, /^Other MCP clients/), /mcpServers/, 'json'), 'json config under "### Other MCP clients"');
const toolTable = section(readme, 'MCP tools').find((t) => t.type === 'table') as Tokens.Table | undefined;
const mcpTools = (toolTable?.rows ?? []).map((r) => r[0].text.replace(/`/g, '').trim()).filter(Boolean);
const builtinJson = findCode(section(readme, "TopoTopo's own packages"), /"type"/, 'json');

const counts = `<strong>${nodeDefs.length}</strong> node types · <strong>${builtinOutputs.length}</strong> ready-made outputs in ${builtin.length} packages · ` +
  `<strong>${examples.length}</strong> example graphs · ${esc(pkg.license ?? 'Apache-2.0')}`;

page({
  out: 'index.html',
  title: 'TopoTopo · procedural geometry engine',
  nav: 'home',
  description: clip(plain(positioning.text), 200),
}, () => {
  const rmd = (t: Token) => renderTokens([t], newCtx('README.md', false));
  const hero = heroExamples.map((h, i) => `<figure class="card render">
<a href="${u(`examples/index.html#${h.name}`)}">${img(`examples/renders/${h.name}.png`, h.caption, { lazy: i > 1 })}</a>
<figcaption><strong>${esc(humanize(h.name))}</strong>${esc(h.caption)}</figcaption>
</figure>`).join('\n');
  const links = [
    ['nodes/index.html', 'Node reference', `${nodeDefs.length} node types in ${nodeCategories.length} categories: params, inputs, examples`],
    ['packages/index.html', 'TopoTopo\'s own packages', `${builtin.length} packages, ${builtinOutputs.length} ready-made outputs used like nodes`],
    ['examples/index.html', 'Examples', `${examples.length} example graphs with their renders`],
    ...(releases.length ? [[releases[0].out, 'Release notes', `what is in ${releases[0].version}, known limits`]] : []),
    [REPO, 'Source on GitHub', 'issues, contributing, licence'],
  ];
  return `<section class="hero">
<h1>TopoTopo</h1>
<div class="lede">${rmd(positioning)}</div>
<p class="stats">${counts}</p>
<p class="cta"><a class="button primary" href="#install">Install</a><a class="button" href="${u('nodes/index.html')}">Node reference</a><a class="button" href="${u('examples/index.html')}">Examples</a><a class="button" href="${esc(REPO)}">GitHub</a></p>
</section>
<div class="grid">
${hero}
</div>
<h2 id="features">What it does</h2>
<div class="features">${rmd(capabilities)}</div>
<div class="two-col">
<section>
<h2 id="install">Install</h2>
${nodeReq ? rmd(nodeReq) : `<p>Requires Node ${esc(pkg.engines?.node ?? '')}.</p>`}
${codeBlock(npxBlock.text, npxBlock.lang)}
${notOnNpm ? rmd(notOnNpm) : ''}
<p>From a clone (Node runs the TypeScript sources directly, there is no build step):</p>
${codeBlock(`git clone ${REPO}\ncd ${path.posix.basename(REPO)}\nnpm install\nnpm test`, 'bash')}
</section>
<section>
<h2 id="mcp">Connect an agent (MCP)</h2>
<p>TopoTopo ships an MCP server: an agent builds a graph in one call, looks at a render, edits it incrementally and checks its work. With Claude Code:</p>
${codeBlock(claudeCode.text, claudeCode.lang)}
<p>Other MCP clients (Claude Desktop, …):</p>
${codeBlock(mcpJson.text, mcpJson.lang)}
${mcpTools.length ? `<p>Tools:</p><ul class="chips">${mcpTools.map((t) => `<li><span>${esc(t)}</span></li>`).join('')}</ul>` : ''}
</section>
</div>
<h2 id="first-graph">A first graph</h2>
<p>A graph is JSON: named nodes, their inputs and params. Save this as <code>graph.json</code> and cook it with <code>npx topotopo graph.json --render out.png --export out.glb</code>.</p>
${codeBlock(graphJson.text, graphJson.lang)}
${conventions ? rmd(conventions) : ''}
<h2 id="docs">Documentation</h2>
<ul class="links">${links.map(([to, title, text]) => `<li><a href="${u(to)}"><strong>${esc(title)}</strong><span>${esc(text)}</span></a></li>`).join('')}</ul>`;
});

function humanize(name: string): string {
  const acronyms = new Set(['csg', 'pcg', 'sdf', 'uv', 'lod', 'rbd', 'mcp']);
  return name.split('_').map((w, i) => (acronyms.has(w) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

// ---------------------------------------------------------------------------------------------------------------------
// node reference

function nodesSidebar(current: string | null): string {
  return `<aside class="sidebar"><div>
<h2>Categories</h2>
<ul><li><a href="${u('nodes/index.html')}"${current === null ? ' aria-current="page"' : ''}>All nodes</a></li>
${categories.map((c) => `<li><a href="${u(`nodes/${c}.html`)}"${c === current ? ' aria-current="page"' : ''}>${esc(c)}<span class="count">${byCat.get(c)!.length}</span></a></li>`).join('\n')}</ul>
</div></aside>`;
}

const nodeLink = (t: string) => (catOf.has(t) ? `<a href="${u(`nodes/${catOf.get(t)}.html#${t}`)}">${esc(t)}</a>` : `<span>${esc(t)}</span>`);

function defaultText(pd: ParamDef): string {
  if (pd.type === 'graph') return '<code>{nodes, output}</code>';
  if (pd.default === undefined) return '—';
  const text = JSON.stringify(pd.default);
  return `<code${text.length > 24 ? ' class="wrap"' : ''}>${esc(text)}</code>`;
}

function nodeSection(d: NodeDef): string {
  const id = esc(d.type);
  const out: string[] = [`<section class="node" id="${id}">`,
    `<h2><code>${id}</code>${d.deprecated ? '<span class="badge">deprecated</span>' : ''}<a class="anchor" href="#${id}" aria-label="Link to ${id}">#</a></h2>`];
  if (d.aliases?.length) out.push(`<p class="aliases">aliases: ${d.aliases.map((a) => `<code>${esc(a)}</code>`).join(' ')}</p>`);
  // a package output: what it is and its tags, as its version records them
  const kt = [d.package?.kind ? `kind: <code>${esc(d.package.kind)}</code>` : '', d.package?.tags?.length ? `tags: ${d.package.tags.map((t) => `<code>${esc(t)}</code>`).join(' ')}` : ''].filter(Boolean);
  if (kt.length) out.push(`<p class="kind-tags">${kt.join(' · ')}</p>`);
  if (d.deprecated) out.push(`<p><strong>Deprecated:</strong> ${inline(d.deprecated)}</p>`);
  out.push(`<p class="summary">${inline(d.summary)}</p>`);
  const thumb = thumbOf(d.type);
  if (thumb && exists(thumb)) out.push(`<p>${img(thumb, `${d.type} thumbnail`, { cls: 'thumb' })}</p>`);
  if (d.description) out.push(`<div class="description">${block(d.description)}</div>`);

  out.push('<h3>Inputs</h3>');
  if (!d.inputs.length) out.push('<p>None (generator).</p>');
  else out.push(`<div class="table-wrap"><table><thead><tr><th>#</th><th>name</th><th>description</th></tr></thead><tbody>
${d.inputs.map((inp, i) => `<tr><td>${i}</td><td><code>${esc(inp.name)}</code></td><td class="desc">${inline(inp.desc)}${inp.optional ? ' <span class="tag">(optional)</span>' : ''}${inp.multi ? ' <span class="tag">(any number)</span>' : ''}</td></tr>`).join('\n')}
</tbody></table></div>`);

  out.push('<h3>Parameters</h3>');
  const params = Object.entries(d.params);
  if (!params.length) out.push('<p>None.</p>');
  else out.push(`<div class="table-wrap"><table><thead><tr><th>name</th><th>type</th><th>default</th><th>range</th><th>description</th></tr></thead><tbody>
${params.map(([name, pd]) => {
  const extra: string[] = [];
  if (pd.options?.length) extra.push(`<br><span class="tag">options:</span> ${pd.options.map((o) => `<code>${esc(o)}</code>`).join(' ')}`);
  if (pd.aliases?.length) extra.push(`<br><span class="tag">aliases:</span> ${pd.aliases.map((a) => `<code>${esc(a)}</code>`).join(' ')}`);
  const range = pd.min === undefined && pd.max === undefined ? '' : `${pd.min ?? ''}..${pd.max ?? ''}`;
  const type = pd.type === 'group' && pd.groupClass ? `${pd.type} (${pd.groupClass})` : pd.type;
  return `<tr><td><code>${esc(name)}</code></td><td>${esc(type)}</td><td class="default">${defaultText(pd)}</td><td>${esc(range)}</td>` +
    `<td class="desc">${inline(pd.desc)}${pd.advanced ? ' <span class="tag">(advanced)</span>' : ''}${extra.join('')}</td></tr>`;
}).join('\n')}
</tbody></table></div>`);

  if (d.outputs) out.push(`<p><strong>Writes:</strong> ${inline(d.outputs)}</p>`);
  if (d.example !== undefined) out.push('<h3>Example</h3>', codeBlock(fmtJson(d.example), 'json'));
  const ex = usedIn.get(d.type);
  if (ex?.length) out.push(`<p class="used-in">Used in the example${ex.length > 1 ? 's' : ''} ${ex.map((e) => `<a href="${u(`examples/index.html#${e}`)}">${esc(e)}</a>`).join(', ')}.</p>`);
  out.push('</section>');
  return out.join('\n');
}

page({
  out: 'nodes/index.html',
  title: 'Node reference',
  nav: 'nodes',
  description: `Every TopoTopo node type (${nodeDefs.length}) and output of TopoTopo's own packages (${packageOutputs.length}): summary, inputs, parameters with types, defaults and ranges, and an example graph.`,
}, () => `<div class="with-sidebar">
${nodesSidebar(null)}
<div class="content">
<h1>Node reference</h1>
<p class="intro">${nodeDefs.length} node types in ${nodeCategories.length} categories, plus the ${packageOutputs.length} outputs of TopoTopo's own packages (ready-made graphs used like nodes, by full name).
Node types and parameter names are case- and underscore-insensitive and accept the listed aliases, Houdini names included;
any parameter can also be an <code>"=expr"</code> string evaluated with the graph vars. The same definitions drive
validation, the MCP <code>catalog</code> and <code>help</code> tools, <a href="${esc(repoUrl('docs/nodes.md'))}">docs/nodes.md</a> and these pages.</p>
<p><input class="filter" type="search" id="node-filter" placeholder="Filter by name, alias or summary" aria-label="Filter nodes" autocomplete="off"></p>
${categories.map((c) => `<section class="cat" id="${esc(c)}">
<h2><a href="${u(`nodes/${c}.html`)}">${esc(c)}</a><span class="badge">${byCat.get(c)!.length}</span></h2>
<ul class="cat-list">
${byCat.get(c)!.map((d) => `<li data-k="${esc([d.type, ...(d.aliases ?? []), c, plain(d.summary), d.package?.kind ?? '', ...(d.package?.tags ?? [])].join(' ').toLowerCase())}"><a href="${u(`nodes/${c}.html#${d.type}`)}">${esc(d.type)}</a><span>${inline(d.summary)}</span></li>`).join('\n')}
</ul>
</section>`).join('\n')}
<p id="no-match" hidden>No node matches the filter.</p>
<script>
(() => {
  const input = document.getElementById('node-filter'), none = document.getElementById('no-match');
  const items = [...document.querySelectorAll('.cat-list li')], cats = [...document.querySelectorAll('section.cat')];
  input.addEventListener('input', () => {
    const words = input.value.toLowerCase().split(/\\s+/).filter(Boolean);
    for (const li of items) li.hidden = !words.every((w) => li.dataset.k.includes(w));
    let any = false;
    for (const s of cats) { const shown = !!s.querySelector('li:not([hidden])'); s.hidden = !shown; any ||= shown; }
    none.hidden = any;
  });
})();
</script>
</div>
</div>`);

for (const c of categories) {
  const list = byCat.get(c)!;
  const isPackage = c === 'package';
  page({
    out: `nodes/${c}.html`,
    title: `${c} nodes`,
    nav: 'nodes',
    description: clip(`${list.length} ${isPackage ? 'outputs of TopoTopo\'s own packages' : `TopoTopo ${c} node types`}: ${list.map((d) => d.type).join(', ')}.`, 300),
  }, () => `<div class="with-sidebar">
${nodesSidebar(c)}
<div class="content">
<h1 id="${esc(c)}-nodes">${esc(c)} nodes</h1>
<p class="intro">${isPackage
  ? `${list.length} outputs of TopoTopo's own packages, the packages of its built-in library (see <a href="${u('packages/index.html')}">TopoTopo's own packages</a>), by full name; a built-in package's name alone is its default output, which lines its outputs up. A package's graph names one like any node, and its first use copies the package's version into the package. Their parameters are the outputs' typed vars and their inputs the graphs' <code>input</code> nodes; <code>assets {action: "fork"}</code> copies one's graph into the package's assets to edit.`
  : `${list.length} node type${list.length > 1 ? 's' : ''} in the <code>${esc(c)}</code> category.`}</p>
<ul class="chips">${list.map((d) => `<li><a href="#${esc(d.type)}">${esc(d.type)}</a></li>`).join('')}</ul>
${list.map(nodeSection).join('\n')}
</div>
</div>`);
}

// ---------------------------------------------------------------------------------------------------------------------
// TopoTopo's own packages and the examples

page({
  out: 'packages/index.html',
  title: 'TopoTopo\'s own packages',
  nav: 'packages',
  description: `TopoTopo's own packages: ${builtin.length} packages of ${builtinOutputs.length} ready-made generators (walls, houses, roofs, stairs, rocks, trees, props, roads) used like nodes.`,
}, () => {
  const card = (type: string, name: string, pkg: string) => {
    const d = packageOutputs.find((x) => x.type === type);
    const params = d ? Object.keys(d.params).length : 0;
    const inputs = d?.inputs.map((i) => i.name) ?? [];
    const thumb = `library/${pkg}/thumbs/${name}.png`;
    return `<article class="card output-card" id="${esc(type)}">
<a href="${u(`nodes/package.html#${type}`)}">${exists(thumb) ? img(thumb, `${type} thumbnail`) : ''}</a>
<div class="body"><h3><a href="${u(`nodes/package.html#${type}`)}">${esc(type)}</a></h3>
${d ? `<p>${inline(d.summary)}</p>` : ''}
<p class="meta">${d?.package?.kind ? `${esc(d.package.kind)} · ` : ''}${params} param${params === 1 ? '' : 's'}${inputs.length ? ` · input: ${inputs.map(esc).join(', ')}` : ''}</p>
${d?.package?.tags?.length ? `<p class="meta">tags: ${d.package.tags.map(esc).join(', ')}</p>` : ''}</div>
</article>`;
  };
  return `<h1>TopoTopo's own packages</h1>
<p class="intro">${builtinOutputs.length} ready-made generators in ${builtin.length} packages, TopoTopo's own packages: walls, windows and doors, whole
houses, roofs, stairs, railings and floors, props, trees and rocks, roads and street furniture, and generators that dress
a road or a terrain. TopoTopo carries them built in (<a href="${esc(repoUrl('library'))}">library/</a>), so they work
offline and every package finds them without listing a library. A package's graph names an output by its full name; the
first use copies the package's version into the package and locks it, as for any package, and a newer version a TopoTopo
release brings shows as an update. Each output documents its typed parameters, puts its pivot at the base and tags every
piece with <code>name</code> and <code>material</code>; it says what it is (its kind) and carries tags a search finds it by
(<code>topotopo search --tag street-furniture</code>, or the MCP <code>library</code> tool's <code>search</code>, across
every library). Parameters, inputs and examples are in the
<a href="${u('nodes/package.html')}">node reference</a>.</p>
${builtinJson ? codeBlock(builtinJson.text, builtinJson.lang) : ''}
<ul class="chips">${builtin.map((k) => `<li><a href="#${esc(k.name)}">${esc(k.package)}</a></li>`).join('')}</ul>
${builtin.map((k) => `<h2 id="${esc(k.name)}">${esc(k.package)}${k.versions.length ? `<span class="badge">${esc(k.versions.at(-1)!.version)}</span>` : ''}</h2>
<p>${esc(builtinText(k))} Its default output, <a href="${u(`nodes/package.html#${k.package}`)}"><code>${esc(k.package)}</code></a> alone, lines them up.</p>
<div class="grid small">
${k.outputs.map((o) => card(o.type, o.name, k.name)).join('\n')}
</div>`).join('\n')}`;
});

page({
  out: 'examples/index.html',
  title: 'Examples',
  nav: 'examples',
  description: `${examples.length} TopoTopo example graphs, each cooked and rendered by the test suite: terrain, PCG, instancing, remeshing, textures, simulation.`,
}, () => `<h1>Examples</h1>
<p class="intro">${examples.length} example graphs from <a href="${esc(repoUrl('examples'))}">examples/</a>, each rendered by <code>npm run showcase</code>
and checked against a golden fingerprint by <code>npm test</code>. Download a graph and cook it yourself, for example
<code>npx topotopo ${esc(heroExamples[0].name)}.json --render out.png --export out.glb</code>. A graph's <code>meta.render</code> holds the render options used here.</p>
<ul class="chips">${examples.map((e) => `<li><a href="#${esc(e.name)}">${esc(e.name)}</a></li>`).join('')}</ul>
<div class="grid wide">
${examples.map((e) => `<article class="card render example" id="${esc(e.name)}">
${e.render ? `<a href="${u(useFile(e.render))}">${img(e.render, `${humanize(e.name)}: render of examples/${e.name}.json`)}</a>` : ''}
<div class="body">
<h2><a href="#${esc(e.name)}">${esc(humanize(e.name))}</a></h2>
${e.description ? `<p>${inline(e.description)}</p>` : ''}
<ul class="chips types">${e.types.map((t) => `<li>${nodeLink(t)}</li>`).join('')}</ul>
<p class="meta"><a href="${u(useFile(`examples/${e.name}.json`))}">${esc(e.name)}.json</a> · ${e.nodes} node${e.nodes === 1 ? '' : 's'} · ${e.types.length} node type${e.types.length === 1 ? '' : 's'}</p>
</div>
</article>`).join('\n')}
</div>`);

// ---------------------------------------------------------------------------------------------------------------------
// release notes, 404

function docPage(src: string, out: string, nav: string, extraSidebar = ''): void {
  const tokens = marked.lexer(read(src));
  const h1 = tokens.find((t) => isHeading(t) && (t as Tokens.Heading).depth === 1) as Tokens.Heading | undefined;
  const title = h1 ? plain(h1.text) : path.basename(src, '.md');
  const sections = tokens.filter((t) => isHeading(t) && (t as Tokens.Heading).depth === 2).map((t) => plain((t as Tokens.Heading).text));
  page({ out, title, nav, description: clip(`${title}: ${sections.join(', ')}.`, 200) }, () => {
    const ctx = newCtx(src, true);
    const html = renderTokens(tokens, ctx);
    const toc: string[] = [];
    for (let i = 0; i < ctx.toc.length; i++) {
      const h = ctx.toc[i];
      if (h.depth !== 2) continue;
      const subs: string[] = [];
      while (ctx.toc[i + 1]?.depth === 3) { const s = ctx.toc[++i]; subs.push(`<li><a href="#${esc(s.id)}">${s.html}</a></li>`); }
      toc.push(`<li><a href="#${esc(h.id)}">${h.html}</a>${subs.length ? `<ul>${subs.join('')}</ul>` : ''}</li>`);
    }
    return `<div class="with-sidebar">
<aside class="sidebar"><div>
<h2>On this page</h2>
<ul>${toc.join('\n')}</ul>
${extraSidebar}
<h2>Source</h2>
<ul><li><a href="${esc(repoUrl(src))}">${esc(src)}</a></li></ul>
</div></aside>
<div class="content">
${html}
</div>
</div>`;
  });
}

for (const r of releases) {
  cur = { out: r.out, title: '', description: '', nav: '' };
  const others = releases.length > 1 ? `<h2>Releases</h2>\n<ul>${releases.map((o) => `<li><a href="${u(o.out)}"${o === r ? ' aria-current="page"' : ''}>${esc(o.version)}</a></li>`).join('')}</ul>` : '';
  docPage(r.src, r.out, 'releases', others);
}

page({ out: '404.html', title: 'Page not found', nav: '', abs: true, description: 'There is no page at this address.' }, () => `<div class="notfound">
<h1>404</h1>
<p>There is no page at this address. The site is regenerated from the repository, so a page may have moved.</p>
<p class="cta"><a class="button primary" href="${u('index.html')}">Home</a><a class="button" href="${u('nodes/index.html')}">Node reference</a><a class="button" href="${u('examples/index.html')}">Examples</a></p>
</div>`);

// where the mailing list's confirmation link lands (Kit form settings → Confirmation email → redirect URL); not in the sitemap
page({ out: 'subscribed.html', title: 'Subscribed', nav: '', abs: true, description: 'You are on the TopoTopo mailing list.' }, () => `<div class="notfound">
<h1>You're subscribed! 😲😊🥰</h1>
<p>Thanks for confirming. TopoTopo news comes about once a month: releases, new packs and free stuff. Every email has an unsubscribe link.</p>
<p>While you're here: a star on GitHub helps others find TopoTopo, and the YouTube channel shows it in action.</p>
<p class="cta"><a class="button primary" href="${esc(REPO)}">Star on GitHub</a><a class="button" href="${YOUTUBE}?sub_confirmation=1">Subscribe on YouTube</a><a class="button" href="${u('index.html')}">Home</a></p>
</div>`);

// ---------------------------------------------------------------------------------------------------------------------
// write

if (path.resolve(SITE_DIR) !== path.join(ROOT, 'site')) throw new Error(`gen-site: unexpected output directory ${SITE_DIR}`);
fs.rmSync(SITE_DIR, { recursive: true, force: true });
const write = (rel: string, data: string | Uint8Array) => {
  const abs = path.join(SITE_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
};
for (const p of pages) write(p.out, p.html!);
for (const [site, repo] of copies) write(site, fs.readFileSync(path.join(ROOT, repo)));
// the favicon is the brand mark (docs/brand/mark.svg) cropped to its bounds so it fills a 16 px tab icon
write('favicon.svg', fs.readFileSync(path.join(ROOT, 'docs/brand/mark.svg'), 'utf8').replace(/viewBox="0 0 256 256" width="256" height="256"/, 'viewBox="16 17 224 224" width="224" height="224"'));
write('CNAME', DOMAIN + '\n');
write('.nojekyll', '');
write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
  .filter((p) => !p.abs).map((p) => `  <url><loc>${esc(`${SITE_URL}/${p.out.replace(/(^|\/)index\.html$/, '$1')}`)}</loc></url>`).join('\n')}\n</urlset>\n`);

const files = listFiles(SITE_DIR);
const size = (f: string) => fs.statSync(path.join(SITE_DIR, f)).size;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const total = files.reduce((s, f) => s + size(f), 0);
const pageBytes = pages.reduce((s, p) => s + size(p.out), 0);
for (const p of pages) console.log(`  ${p.out.padEnd(28)} ${kb(size(p.out)).padStart(10)}`);
const imgs = files.filter((f) => /\.(png|svg)$/.test(f));
console.log(`site/: ${pages.length} pages (${kb(pageBytes)}), ${imgs.length} images (${(imgs.reduce((s, f) => s + size(f), 0) / 1048576).toFixed(2)} MB), ` +
  `${files.length} files, ${(total / 1048576).toFixed(2)} MB total; ${nodeDefs.length} node types, ${builtinOutputs.length} outputs of TopoTopo's own packages, ${examples.length} examples`);
if (total > SIZE_LIMIT) { console.log(`FAIL the site is over the ${SIZE_LIMIT / 1048576} MB budget`); process.exit(1); }
