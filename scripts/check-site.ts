// Check the generated documentation site (site/, written by scripts/gen-site.ts).
//   npm run site:check      (node scripts/check-site.ts [dir])
// Fails when an internal link or image does not resolve: every href/src of every page (and og:image, canonical) must
// name a file under site/, and a #fragment must name an id on the target page. Relative links resolve against the page,
// root-absolute ones ("/x", used by 404.html only) and https://topotopo.dev/... against site/. It also fails when a
// copied file is not used by any page, when CNAME, .nojekyll or 404.html are missing, or when the site is over 25 MB.
// External links (https://github.com/..., mailto:) are not fetched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SITE_DIR = path.join(ROOT, 'site');
/** Total size budget of the deployed site. */
export const SIZE_LIMIT = 25 * 1024 * 1024;
/** Files every build writes that pages do not link to. */
export const SITE_META_FILES = ['CNAME', '.nojekyll', '404.html', 'robots.txt', 'sitemap.xml'];

/** Every file under dir, as site-relative POSIX paths. */
export function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

const decodeEntities = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

interface Ref { attr: string; url: string; line: number }

/** The URLs a page refers to: href, src and the content of og:image / og:url meta tags. */
function refsOf(html: string): Ref[] {
  const out: Ref[] = [];
  const lineAt = (i: number) => html.slice(0, i).split('\n').length;
  for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = m[0];
    for (const a of tag.matchAll(/\s(href|src)\s*=\s*"([^"]*)"/g)) out.push({ attr: a[1], url: decodeEntities(a[2]), line: lineAt(m.index!) });
    if (/^<meta\s/i.test(tag) && /property="og:(image|url)"/.test(tag)) {
      const c = /\scontent="([^"]*)"/.exec(tag);
      if (c) out.push({ attr: 'content', url: decodeEntities(c[1]), line: lineAt(m.index!) });
    }
  }
  return out;
}

const idsOf = (html: string) => new Set([...html.matchAll(/\s(?:id|name)="([^"]*)"/g)].map((m) => decodeEntities(m[1])));

export interface CheckResult { problems: string[]; pages: number; links: number; files: number; bytes: number }

/** Check a generated site directory; problems is empty when it is fine. */
export function checkSite(dir = SITE_DIR, siteUrl = 'https://topotopo.dev'): CheckResult {
  const problems: string[] = [];
  if (!fs.existsSync(dir)) return { problems: [`${dir} does not exist: run npm run site`], pages: 0, links: 0, files: 0, bytes: 0 };
  const files = listFiles(dir);
  const fileSet = new Set(files);
  const pages = files.filter((f) => f.endsWith('.html'));
  const ids = new Map<string, Set<string>>();
  const idsFor = (f: string) => {
    if (!ids.has(f)) ids.set(f, idsOf(fs.readFileSync(path.join(dir, f), 'utf8')));
    return ids.get(f)!;
  };
  const used = new Set<string>();
  let links = 0;
  for (const page of pages) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    if (!/<title>[^<]+<\/title>/.test(html)) problems.push(`${page}: no <title>`);
    for (const ref of refsOf(html)) {
      let url = ref.url.trim();
      if (!url) { problems.push(`${page}:${ref.line}: empty ${ref.attr}`); continue; }
      if (url.startsWith(siteUrl + '/') || url === siteUrl) url = '/' + url.slice(siteUrl.length + 1);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) continue; // external, mailto:, data:
      links++;
      const hash = url.indexOf('#');
      const frag = hash >= 0 ? decodeURIComponent(url.slice(hash + 1)) : '';
      let p = (hash >= 0 ? url.slice(0, hash) : url).replace(/\?.*$/, '');
      let target: string;
      if (!p) target = page; // "#frag" on the same page
      else {
        p = decodeURIComponent(p);
        target = p.startsWith('/') ? path.posix.normalize(p.slice(1)) : path.posix.normalize(path.posix.join(path.posix.dirname(page), p));
        if (target.startsWith('..')) { problems.push(`${page}:${ref.line}: ${ref.url} points outside the site`); continue; }
        if (target === '.') target = 'index.html';
        else if (p.endsWith('/') || (!fileSet.has(target) && fileSet.has(path.posix.join(target, 'index.html')))) target = path.posix.join(target, 'index.html');
      }
      if (!fileSet.has(target)) {
        const what = ref.attr === 'src' || /\.(png|jpe?g|svg|gif|webp)$/i.test(target) ? 'missing image' : 'broken link';
        problems.push(`${page}:${ref.line}: ${what} ${ref.url} (${target} not in site/)`);
        continue;
      }
      used.add(target);
      if (frag && target.endsWith('.html') && !idsFor(target).has(frag)) problems.push(`${page}:${ref.line}: broken anchor ${ref.url} (no id "${frag}" in ${target})`);
    }
  }
  for (const f of SITE_META_FILES) if (!fileSet.has(f)) problems.push(`${f} is missing`);
  if (fileSet.has('CNAME') && !fs.readFileSync(path.join(dir, 'CNAME'), 'utf8').trim()) problems.push('CNAME is empty');
  for (const f of files) if (!f.endsWith('.html') && !SITE_META_FILES.includes(f) && !used.has(f)) problems.push(`${f} is not used by any page (copy only what the pages use)`);
  const bytes = files.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
  if (bytes > SIZE_LIMIT) problems.push(`the site is ${(bytes / 1048576).toFixed(1)} MB, over the ${SIZE_LIMIT / 1048576} MB budget`);
  return { problems, pages: pages.length, links, files: files.length, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : SITE_DIR;
  const r = checkSite(dir);
  for (const p of r.problems) console.log('FAIL ' + p);
  console.log(`site: ${r.pages} pages, ${r.links} internal links and images, ${r.files} files, ${(r.bytes / 1048576).toFixed(2)} MB` +
    (r.problems.length ? `, ${r.problems.length} problem(s)` : ', all resolve'));
  process.exit(r.problems.length ? 1 : 0);
}
