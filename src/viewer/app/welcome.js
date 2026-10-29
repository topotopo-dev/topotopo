// What the viewer says about the project it shows (GET /api/project): the page's title, the graph shown first, and the
// welcome in the viewport while there is no graph: a project's name with a pointer to TopoTopo's kits and to the agent
// that builds the graphs, or, for a folder that is no project, that it is none and how to make it one. The plain
// functions are tested in Node (test/viewer-logic.ts).

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const baseName = (p) => String(p ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p ?? '');

/** The browser tab's title: "<project> · TopoTopo", the graph file's or the folder's name before it. */
export function pageTitle(info) {
  const name = info?.project ? info.project.title || info.project.id : info?.file ?? (info?.folder ? baseName(info.folder) : '');
  return name ? `${name} · TopoTopo` : 'TopoTopo';
}

/** The graph shown first: the project's default graph when it has it, else the first. */
export const defaultGraph = (info, names) => (info?.project && names.includes(info.project.graph) ? info.project.graph : names[0] ?? null);

/**
 * The welcome while there is no graph: {kind, title, sub, lead, steps, kits}. kind "project" (a project without graphs)
 * or "folder" (a folder that is no project).
 */
export function welcomeOf(info) {
  const kits = info?.kits ?? [];
  if (info?.project) {
    const p = info.project;
    return {
      kind: 'project', title: p.title || p.id, sub: `project ${p.id}${p.package ? ` · package ${p.package}` : ''}`, kits,
      lead: 'This project has no graphs yet.',
      steps: [
        'Ask your agent to build one here, for example: "Build a street with two houses, lamp posts and trees from TopoTopo\'s kits."',
        'It shows here as soon as your agent builds it, and so does every change after that.',
      ],
    };
  }
  const folder = info?.folder ?? '';
  return {
    kind: 'folder', title: baseName(folder) || 'This folder', sub: folder, kits,
    lead: 'This folder is not a TopoTopo project.',
    steps: [
      'A project keeps its graphs, the packages they use and their exports together, and shows in the Gallery.',
      `Ask your agent to make this folder a project, or run: topotopo init "${folder}"`,
      'Your agent can also build a graph here as it is: it shows here at once.',
    ],
  };
}

/** The welcome panel in the viewport: shown while `show`, built from `info` (GET /api/project). */
export function renderWelcome(host, info, show) {
  host.hidden = !show;
  if (!show) { host.replaceChildren(); return; }
  const w = welcomeOf(info), box = el('div', 'welcome-box');
  box.append(el('h1', '', w.title), el('div', 'welcome-sub', w.sub), el('p', 'welcome-lead', w.lead));
  for (const s of w.steps) {
    // a command to type shows as one
    const p = el('p'), at = s.indexOf('run: ');
    if (at < 0) p.textContent = s; else p.append(s.slice(0, at + 5), el('code', '', s.slice(at + 5)));
    box.append(p);
  }
  if (w.kits.length) {
    box.append(el('h2', '', 'TopoTopo\'s kits: ready-made parts your agent can use'));
    const list = el('ul', 'welcome-kits');
    for (const k of w.kits) {
      const li = el('li');
      li.append(el('strong', '', k.title), el('span', 'dim', ` · ${k.name}${k.version ? ` ${k.version}` : ''}`), el('div', 'dim', k.outputs));
      li.title = k.description;
      list.append(li);
    }
    box.append(list);
  }
  box.append(el('p', 'dim', 'Reference files (meshes, curves, images) dropped anywhere on this page go to inputs/, where your agent reads them.'));
  host.replaceChildren(box);
}
