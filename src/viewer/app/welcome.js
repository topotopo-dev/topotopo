// What the viewer says about the package it shows (GET /api/package): the page's title, the graph shown first, and the
// welcome in the viewport while there is no graph: how graphs get built, the line that connects Claude Code to this
// folder and TopoTopo's built-in packages. A folder that is no package also says how to make it one. The plain
// functions are tested in Node (test/viewer-logic.ts).

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const baseName = (p) => String(p ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p ?? '');

/** The browser tab's title: "<package> · TopoTopo", the graph file's or the folder's name before it. */
export function pageTitle(info) {
  const name = info?.package ? info.package.title || info.package.id : info?.file ?? (info?.folder ? baseName(info.folder) : '');
  return name ? `${name} · TopoTopo` : 'TopoTopo';
}

/** The graph shown first: the package's default graph when it has it, else the first. */
export const defaultGraph = (info, names) => (info?.package && names.includes(info.package.graph) ? info.package.graph : names[0] ?? null);

/**
 * The message that stays in view while a graph file cannot be read. names: the graphs the editor shows; a file read
 * before stays as its last version, one that was never read shows once it is fixed.
 */
export function unreadMessage(unread = [], names = []) {
  if (!unread.length) return '';
  const [{ file, error, graph }] = unread;
  const shown = names.includes(graph ?? file.slice(file.lastIndexOf('/') + 1).replace(/\.json$/, ''));
  const then = shown ? 'the editor shows the last version it could read' : 'it shows here when the file is fixed';
  return `${file} cannot be read (${error}): ${then}${unread.length > 1 ? ` · and ${unread.length - 1} more` : ''}`;
}

/**
 * The welcome while there is no graph: {kind, title, sub, lead, steps, builtin}. kind "package" (a package without graphs)
 * or "folder" (a folder that is no package), or "file" (a single graph file).
 */
export function welcomeOf(info) {
  const builtin = info?.builtin ?? [];
  const connect = typeof info?.connect === 'string' && info.connect
    ? ['No agent connected yet? For Claude Code, run: ' + info.connect] : [];
  const unread = info?.unread?.length ? {
    lead: info.file ? 'This graph file cannot be read.' : `A graph file of this ${info.package ? 'package' : 'folder'} cannot be read.`,
    steps: [...info.unread.map(({ file, error }) => `${file}: ${error}`), 'Fix the file (or put back an earlier copy of it) and it shows here at once.'],
  } : null;
  if (info?.file) return { kind: 'file', title: info.file, sub: '', builtin, lead: 'Waiting for the graph file.', steps: [], ...unread };
  if (info?.package) {
    const p = info.package;
    return {
      kind: 'package', title: p.title || p.id, sub: `package ${p.id}${p.name ? ` · publishes as ${p.name}` : ''}`, builtin,
      lead: 'This package has no graphs yet.',
      steps: [
        'A graph is built by an AI agent connected to TopoTopo, such as Claude Code. Ask it, for example: "Build a street with two houses, lamp posts and trees from TopoTopo\'s built-in packages."',
        'It shows here as soon as it is built, and so does every change after that.',
        ...connect,
      ],
      ...unread,
    };
  }
  const folder = info?.folder ?? '';
  return {
    kind: 'folder', title: baseName(folder) || 'This folder', sub: folder, builtin,
    lead: 'This folder is not a TopoTopo package.',
    steps: [
      'A package keeps its graphs, the packages they use and their exports together, and shows in the web app.',
      `To make this folder a package, run: topotopo init "${folder}"`,
      'An AI agent connected to TopoTopo, such as Claude Code, can also build a graph here as it is: it shows here at once.',
      ...connect,
    ],
    ...unread,
  };
}

/** The welcome panel in the viewport: shown while `show`, built from `info` (GET /api/package). */
export function renderWelcome(host, info, show) {
  host.hidden = !show;
  if (!show) { host.replaceChildren(); return; }
  const w = welcomeOf(info), box = el('div', 'welcome-box');
  box.append(el('h1', '', w.title), el('div', 'welcome-sub', w.sub), el('p', 'welcome-lead', w.lead));
  for (const s of w.steps) {
    // show a command as code and give it a Copy button
    const p = el('p'), at = s.indexOf('run: ');
    if (at < 0) p.textContent = s;
    else {
      const command = s.slice(at + 5), code = el('code', '', command), copy = el('button', '', 'Copy');
      copy.type = 'button';
      let copied;
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(command); } catch {
          const selection = window.getSelection(), range = document.createRange();
          if (!selection) return;
          range.selectNodeContents(code);
          selection.removeAllRanges();
          selection.addRange(range);
          if (!document.execCommand('copy')) return;
          selection.removeAllRanges();
        }
        copy.textContent = 'Copied';
        clearTimeout(copied);
        copied = setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      };
      p.append(s.slice(0, at + 5), code, ' ', copy);
    }
    box.append(p);
  }
  if (w.builtin.length) {
    box.append(el('h2', '', 'TopoTopo\'s built-in packages: ready-made parts for your graphs'));
    const list = el('ul', 'welcome-builtin');
    for (const k of w.builtin) {
      const li = el('li');
      li.append(el('strong', '', k.title), el('span', 'dim', ` · ${k.name}${k.version ? ` ${k.version}` : ''}`), el('div', 'dim', k.outputs));
      li.title = k.description;
      list.append(li);
    }
    box.append(list);
  }
  box.append(el('p', 'dim', 'Reference files (meshes, curves, images) dropped anywhere on this page go to inputs/, where the graphs read them.'));
  host.replaceChildren(box);
}
