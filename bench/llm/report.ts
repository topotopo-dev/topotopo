// TopoTopo Bench: the comparison page. Reads saved result.json files recursively and writes a
// static site: a leaderboard, a gallery of every task × model, and per task the models' results side by side with
// their checks, numbers, transcripts and a 3D view whose cameras orbit together.
//
//   node bench/llm/report.ts [--results bench/llm/results] [--out bench/llm/report] [--version 0.4.0]
//
// One page per exact revision, task suite and settings. index.html aliases the most recent comparison.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparisonKey, participantKey } from './identity.ts';
import type { Task } from './score.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface Result {
  task: string; title: string; category: string; model: string; provider: string; label: string;
  topotopo: { version: string; commit: string | null }; suite: string; date: string;
  settings: { effort: string; images: boolean; limits: { toolCalls: number; minutes: number }; endpoint?: string };
  taskDefinition?: Task;
  metrics: { toolCalls: number; turns: number; toolErrors: number; wallMs: number; usage: { input: number; output: number; cacheRead: number; cacheWrite: number }; costUSD: number | null };
  stop: string; error: string | null; graph: string | null; finalText: string;
  ok: boolean; errors: string[]; warnings: string[]; score: number;
  checks: { label: string; kind: string; pass: boolean; detail: string; weight: number }[];
  stats: { triangles: number; pieces: number; materials: number; size: [number, number, number]; cookMs: number } | null;
  /** set by the report: where its files are on the page */
  dir?: string; files?: Record<string, string>;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
const n = (x: number) => x.toLocaleString('en-US');
const kTok = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(0)}k` : String(x));
const secs = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);
const metres = (x: number) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
const verCmp = (a: string, b: string) => { const p = (v: string) => v.split(/[.-]/).map((x) => Number(x) || 0); const A = p(a), B = p(b); for (let i = 0; i < Math.max(A.length, B.length); i++) if ((A[i] ?? 0) !== (B[i] ?? 0)) return (A[i] ?? 0) - (B[i] ?? 0); return 0; };

/** Every result, grouped by exact revision, suite and settings; older layouts remain readable. */
export function collect(resultsDir: string): Map<string, Result[]> {
  const by = new Map<string, Result[]>();
  if (!fs.existsSync(resultsDir)) return by;
  const walk = (dir: string) => {
    const file = path.join(dir, 'result.json');
    if (fs.existsSync(file)) {
      const r: Result = JSON.parse(fs.readFileSync(file, 'utf8'));
      r.dir = dir;
      const key = comparisonKey(r);
      if (!by.has(key)) by.set(key, []);
      const rs = by.get(key)!, i = rs.findIndex((p) => p.task === r.task && participantKey(p) === participantKey(r));
      // A repeat replaces only that model's displayed attempt, never the saved history or another model.
      if (i < 0) rs.push(r);
      else if (r.date > rs[i].date || (r.date === rs[i].date && dir > rs[i].dir!)) rs[i] = r;
      return;
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) if (e.isDirectory()) walk(path.join(dir, e.name));
  };
  walk(resultsDir);
  return by;
}

interface Row { label: string; results: Result[]; mean: number; full: number; calls: number; wall: number; tokens: number; cost: number | null; failed: number; models: string }

function leaderboard(results: Result[], taskIds: string[]): Row[] {
  const by = new Map<string, Result[]>();
  for (const r of results) { if (!by.has(r.label)) by.set(r.label, []); by.get(r.label)!.push(r); }
  const rows: Row[] = [];
  for (const [label, rs] of by) {
    // a task the model has no result for counts as 0: a leaderboard over different task sets would mislead
    const scoreOf = (id: string) => rs.find((r) => r.task === id)?.score ?? 0;
    const costs = rs.map((r) => r.metrics.costUSD);
    rows.push({
      label, results: rs,
      mean: taskIds.reduce((s, id) => s + scoreOf(id), 0) / Math.max(1, taskIds.length),
      full: rs.filter((r) => r.score === 100).length,
      calls: rs.reduce((s, r) => s + r.metrics.toolCalls, 0) / rs.length,
      wall: rs.reduce((s, r) => s + r.metrics.wallMs, 0) / rs.length,
      tokens: rs.reduce((s, r) => s + r.metrics.usage.input + r.metrics.usage.cacheRead + r.metrics.usage.cacheWrite + r.metrics.usage.output, 0),
      cost: costs.every((c) => c !== null) ? costs.reduce((s, c) => s + (c ?? 0), 0) : null,
      failed: rs.filter((r) => !r.ok).length,
      models: [...new Set(rs.map((r) => `${r.provider}:${r.model}`))].join(', '),
    });
  }
  return rows.sort((a, b) => b.mean - a.mean || b.full - a.full || a.calls - b.calls);
}

const scoreClass = (s: number) => (s >= 90 ? 'hi' : s >= 60 ? 'mid' : 'lo');
const stopText: Record<string, string> = { done: 'finished', tool_call_limit: 'ran out of tool calls', time_limit: 'ran out of time', refusal: 'refused', error: 'error', max_tokens: 'hit max tokens' };

function card(r: Result, rank: number): string {
  const f = r.files ?? {};
  const toolSeq = (r as any).toolSeq as string[] | undefined;
  return `<article class="card" id="${esc(slug(r.task))}--${esc(slug(r.label))}">
  <figure class="shot">
    ${f.render ? `<img loading="lazy" src="${esc(f.render)}" alt="${esc(r.label)}: ${esc(r.title)}" data-alt="${esc(f.views ?? '')}" title="click for the four views">` : `<div class="noshot">${r.ok ? 'no render' : 'nothing cooked'}</div>`}
    <span class="badge ${scoreClass(r.score)}">${r.score}</span>
    ${rank === 0 && r.score > 0 ? '<span class="best">best</span>' : ''}
  </figure>
  <header><h4>${esc(r.label)}</h4><span class="stop ${r.stop === 'done' ? '' : 'warn'}">${esc(stopText[r.stop] ?? r.stop)}</span></header>
  <ul class="checks">${r.checks.map((c) => `<li class="${c.pass ? 'ok' : 'no'}" title="${esc(c.detail)}"><span aria-hidden="true">${c.pass ? '✓' : '✗'}</span>${esc(c.label)}<em>${esc(c.detail)}</em></li>`).join('')}</ul>
  <dl class="nums">
    <div><dt>tool calls</dt><dd>${r.metrics.toolCalls}${r.metrics.toolErrors ? ` <small>(${r.metrics.toolErrors} errors)</small>` : ''}</dd></div>
    <div><dt>time</dt><dd>${secs(r.metrics.wallMs)}</dd></div>
    <div><dt>tokens</dt><dd>${kTok(r.metrics.usage.input + r.metrics.usage.cacheRead + r.metrics.usage.cacheWrite)} in · ${kTok(r.metrics.usage.output)} out</dd></div>
    ${r.metrics.costUSD !== null ? `<div><dt>cost</dt><dd>~$${r.metrics.costUSD.toFixed(2)}</dd></div>` : ''}
    ${r.stats ? `<div><dt>result</dt><dd>${n(r.stats.triangles)} tris · ${r.stats.size.map(metres).join(' × ')} m</dd></div>` : ''}
  </dl>
  ${toolSeq?.length ? `<p class="seq" title="the tool calls in order">${toolSeq.map((t) => `<span>${esc(t)}</span>`).join('')}</p>` : ''}
  ${r.errors.length ? `<p class="err">${esc(r.errors[0])}</p>` : ''}
  ${r.error ? `<p class="err">${esc(r.error)}</p>` : ''}
  ${r.finalText ? `<details><summary>what it said</summary><p class="said">${esc(r.finalText)}</p></details>` : ''}
  <nav class="links">${f.glb ? `<button type="button" class="open3d" data-glb="${esc(f.glb)}" data-label="${esc(r.label)}">3D</button>` : ''}${f.graph ? `<a href="${esc(f.graph)}">graph.json</a>` : ''}${f.transcript ? `<a href="${esc(f.transcript)}">transcript</a>` : ''}</nav>
</article>`;
}

const CSS = `
:root{--bg:#f6f5f2;--panel:#ffffff;--ink:#1b1c1f;--dim:#666a72;--line:#e2e0da;--accent:#c4521e;--hi:#2f7d4f;--mid:#b07a12;--lo:#b3361f;--chip:#efede8;--shadow:0 1px 2px rgba(0,0,0,.06),0 4px 16px rgba(0,0,0,.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141518;--panel:#1c1e22;--ink:#e9e9ea;--dim:#9a9ea6;--line:#2c2f35;--accent:#f08a4b;--hi:#5cc48a;--mid:#e0b04a;--lo:#ef7a62;--chip:#25282d;--shadow:none}}
:root[data-theme=dark]{--bg:#141518;--panel:#1c1e22;--ink:#e9e9ea;--dim:#9a9ea6;--line:#2c2f35;--accent:#f08a4b;--hi:#5cc48a;--mid:#e0b04a;--lo:#ef7a62;--chip:#25282d;--shadow:none}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}main{max-width:1280px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:clamp(28px,5vw,44px);letter-spacing:-.02em;margin:0 0 6px}h2{font-size:22px;margin:48px 0 14px}h3{font-size:19px;margin:0}
.lede{color:var(--dim);max-width:72ch;margin:0 0 16px}.meta{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.meta li{background:var(--chip);border-radius:999px;padding:3px 10px;font-size:13px;color:var(--dim)}.meta b{color:var(--ink);font-weight:600}
.versions{margin-top:10px;font-size:13px;color:var(--dim)}
.board{width:100%;border-collapse:collapse;background:var(--panel);border-radius:10px;overflow:hidden;box-shadow:var(--shadow)}
.board th,.board td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;white-space:nowrap}
.board th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);font-weight:600}
.board td.model{white-space:normal;font-weight:600}.board td.model small{display:block;font-weight:400;color:var(--dim)}
.bar{display:flex;align-items:center;gap:8px}.bar i{display:block;height:8px;border-radius:4px;background:var(--accent);min-width:2px}
.tablewrap{overflow-x:auto}
.matrix{display:grid;gap:6px;overflow-x:auto;padding-bottom:6px}
.matrix .h{font-size:12px;color:var(--dim);align-self:end;padding:0 2px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.matrix .t{font-size:13px;font-weight:600;align-self:center;padding-right:8px}
.matrix a{position:relative;display:block;border-radius:6px;overflow:hidden;background:var(--panel);aspect-ratio:4/3;box-shadow:var(--shadow)}
.matrix img{width:100%;height:100%;object-fit:cover;display:block}.matrix .empty{display:grid;place-items:center;height:100%;color:var(--dim);font-size:12px}
.badge{position:absolute;top:6px;right:6px;font-size:12px;font-weight:700;padding:1px 7px;border-radius:999px;color:#fff;font-variant-numeric:tabular-nums}
.badge.hi{background:var(--hi)}.badge.mid{background:var(--mid)}.badge.lo{background:var(--lo)}
.task{margin-top:44px;padding-top:8px;border-top:1px solid var(--line)}.task>header{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;justify-content:space-between}
.cat{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
blockquote{margin:10px 0 16px;padding:10px 14px;border-left:3px solid var(--accent);background:var(--panel);border-radius:0 8px 8px 0;max-width:90ch;color:var(--ink)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:14px}
.card{background:var(--panel);border-radius:10px;box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column}
.shot{position:relative;margin:0;aspect-ratio:4/3;background:#2b2d33}.shot img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}
.noshot{display:grid;place-items:center;height:100%;color:#aaa;font-size:13px}
.best{position:absolute;top:6px;left:6px;font-size:11px;font-weight:700;background:var(--ink);color:var(--bg);padding:1px 7px;border-radius:999px;text-transform:uppercase;letter-spacing:.05em}
.card header{display:flex;justify-content:space-between;gap:8px;align-items:baseline;padding:10px 12px 2px}.card h4{margin:0;font-size:15px}
.stop{font-size:12px;color:var(--dim);white-space:nowrap}.stop.warn{color:var(--lo)}
.checks{list-style:none;margin:6px 0 0;padding:0 12px;font-size:13px}.checks li{display:flex;gap:6px;align-items:baseline;padding:1px 0}
.checks li span{font-weight:700;width:1em}.checks .ok span{color:var(--hi)}.checks .no span{color:var(--lo)}.checks em{margin-left:auto;color:var(--dim);font-style:normal;font-size:12px;text-align:right}
.nums{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin:10px 12px 0;font-size:12px}.nums dt{color:var(--dim)}.nums dd{margin:0;font-variant-numeric:tabular-nums}
.nums div:last-child:nth-child(odd){grid-column:span 2}
.seq{display:flex;flex-wrap:wrap;gap:3px;margin:10px 12px 0}.seq span{font-size:11px;background:var(--chip);border-radius:4px;padding:0 5px;color:var(--dim)}
.err{margin:8px 12px 0;font-size:12px;color:var(--lo);overflow-wrap:anywhere}
details{margin:8px 12px 0;font-size:13px}summary{cursor:pointer;color:var(--dim)}.said{white-space:pre-wrap;margin:6px 0 0}
.links{display:flex;gap:10px;align-items:center;margin-top:auto;padding:12px;font-size:13px}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--chip);color:var(--ink);border-radius:6px;padding:3px 10px}button:hover{border-color:var(--accent)}
.method{max-width:80ch;color:var(--dim)}.method code{background:var(--chip);padding:1px 5px;border-radius:4px;color:var(--ink)}
#viewer{position:fixed;inset:0;background:rgba(10,10,12,.92);display:none;flex-direction:column;z-index:10}#viewer.on{display:flex}
#viewer header{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;color:#eee;gap:12px}
#viewer header p{margin:0;font-size:13px;color:#aaa}
#views3d{flex:1;display:grid;gap:4px;padding:4px;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))}
.v3{position:relative;background:#22242a;border-radius:6px;overflow:hidden;min-height:240px}.v3 canvas{display:block;width:100%;height:100%}
.v3 span{position:absolute;left:8px;top:6px;color:#eee;font-size:13px;text-shadow:0 1px 2px #000}
`;

const VIEWER_JS = `
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
const box = document.getElementById('viewer'), grid = document.getElementById('views3d'), title = document.getElementById('v3title');
let views = [], frame = 0, syncing = false;
const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
function close() { box.classList.remove('on'); cancelAnimationFrame(frame); for (const v of views) { v.renderer.dispose(); v.controls.dispose(); } views = []; grid.textContent = ''; }
// the cameras orbit together: the same direction from each model, each at its own distance (models differ in size)
function sync(src) {
  if (syncing) return; syncing = true;
  const dir = src.camera.position.clone().sub(src.controls.target).normalize();
  for (const v of views) if (v !== src) { v.camera.position.copy(v.controls.target).addScaledVector(dir, v.dist * src.zoom()); v.camera.lookAt(v.controls.target); v.controls.update(); }
  syncing = false;
}
function open(items, label) {
  close(); title.textContent = label; box.classList.add('on');
  for (const it of items) {
    const cell = document.createElement('div'); cell.className = 'v3';
    const name = document.createElement('span'); name.textContent = it.label + ' · loading';
    cell.append(name); grid.append(cell);
    const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    cell.prepend(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x22242a);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6)); const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(3, 5, 4); scene.add(sun);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1e6), controls = new OrbitControls(camera, renderer.domElement);
    const v = { renderer, scene, camera, controls, cell, dist: 10, zoom: () => camera.position.distanceTo(controls.target) / v.dist };
    controls.addEventListener('change', () => sync(v));
    views.push(v);
    loader.load(it.glb, (g) => {
      scene.add(g.scene);
      const b = new THREE.Box3().setFromObject(g.scene), c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
      v.dist = Math.max(s.x, s.y, s.z) * 2 || 1; controls.target.copy(c);
      camera.position.copy(c).add(new THREE.Vector3(0.62, 0.42, 0.66).normalize().multiplyScalar(v.dist)); camera.near = v.dist / 1000; camera.far = v.dist * 100; camera.updateProjectionMatrix(); controls.update();
      name.textContent = it.label;
    }, undefined, (e) => { name.textContent = it.label + ' · could not load (' + (e.message || e) + ')'; });
  }
  const loop = () => { frame = requestAnimationFrame(loop); for (const v of views) { const w = v.cell.clientWidth, h = v.cell.clientHeight; if (v.renderer.domElement.width !== Math.floor(w * v.renderer.getPixelRatio())) { v.renderer.setSize(w, h, false); v.camera.aspect = w / Math.max(1, h); v.camera.updateProjectionMatrix(); } v.renderer.render(v.scene, v.camera); } };
  loop();
}
document.getElementById('v3close').onclick = close;
addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
for (const b of document.querySelectorAll('.open3d')) b.onclick = () => open([{ glb: b.dataset.glb, label: b.dataset.label }], b.dataset.label);
for (const b of document.querySelectorAll('.compare3d')) b.onclick = () => open(JSON.parse(b.dataset.items), b.dataset.title);
for (const img of document.querySelectorAll('.shot img')) img.onclick = () => { if (!img.dataset.alt) return; const a = img.src; img.src = new URL(img.dataset.alt, location.href).href; img.dataset.alt = a; };
`;

export function buildPage(results: Result[], version: string, others: string[]): string {
  if (new Set(results.map(comparisonKey)).size > 1) throw new Error('cannot compare different revisions, task suites or run settings on one page');
  const labels = new Map<string, Set<string>>();
  for (const r of results) { if (!labels.has(r.label)) labels.set(r.label, new Set()); labels.get(r.label)!.add(participantKey(r)); }
  results = results.map((r) => ({ ...r, label: labels.get(r.label)!.size > 1 ? `${r.label} (${r.provider}:${r.model}; ${participantKey(r).slice(0, 6)})` : r.label }));
  // Use recorded prompts, including tasks since removed from the working suite.
  const tasks = [...new Map(results.map((r) => [r.task, r.taskDefinition ?? { id: r.task, title: r.title, category: r.category, prompt: 'The task prompt was not recorded by this older run.' }])).values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const ids = tasks.map((t) => t.id).filter((id) => results.some((r) => r.task === id));
  const rows = leaderboard(results, ids);
  const order = rows.map((r) => r.label);
  const suites = [...new Set(results.map((r) => r.suite))], commits = [...new Set(results.map((r) => r.topotopo.commit).filter(Boolean))];
  const dates = results.map((r) => r.date).sort();
  const day = (d: string) => d.slice(0, 10);
  const get = (task: string, label: string) => results.find((r) => r.task === task && r.label === label);
  const maxMean = Math.max(1, ...rows.map((r) => r.mean));
  const head = `<header>
  <h1>TopoTopo Bench</h1>
  <p class="lede">Language models build 3D assets and scenes with <a href="https://topotopo.dev">TopoTopo</a>'s MCP tools. Every model gets the same tools, the same prompt and the same budget; what it leaves behind is cooked again, checked and rendered from one camera, so the differences you see are the models'.</p>
  <ul class="meta"><li>TopoTopo <b>${esc(version)}</b>${commits.length ? ` (${esc(commits.join(', '))})` : ''}</li><li>suite <b>${esc(suites.join(', '))}</b></li><li><b>${rows.length}</b> model${rows.length === 1 ? '' : 's'} × <b>${ids.length}</b> tasks</li><li>${esc(day(dates[0] ?? ''))}${dates.length && day(dates[0]) !== day(dates.at(-1)!) ? ` – ${esc(day(dates.at(-1)!))}` : ''}</li></ul>
  <p class="versions">${results[0]?.settings.limits.toolCalls ?? 0} tool calls · ${results[0]?.settings.limits.minutes ?? 0} minutes · effort ${esc(results[0]?.settings.effort)} · images ${results[0]?.settings.images ? 'on' : 'off'}.</p>
  ${others.length ? `<p class="versions">Other comparisons: ${others.map((v) => `<a href="${esc(v)}.html">${esc(v)}</a>`).join(', ')}. Each uses one revision, task suite and set of run settings.</p>` : ''}
  ${suites.length > 1 ? '<p class="versions">These results come from more than one version of the task suite: compare with care.</p>' : ''}
</header>`;
  const board = `<h2>Leaderboard</h2><div class="tablewrap"><table class="board">
<thead><tr><th>#</th><th>model</th><th>mean score</th><th>all checks</th><th>tool calls</th><th>time</th><th>tokens</th><th>cost</th></tr></thead><tbody>
${rows.map((r, i) => `<tr><td>${i + 1}</td><td class="model">${esc(r.label)}<small>${esc(r.models)}</small></td><td><div class="bar"><i style="width:${Math.round((r.mean / maxMean) * 120)}px"></i>${r.mean.toFixed(1)}</div></td><td>${r.full}/${ids.length}</td><td>${r.calls.toFixed(1)}</td><td>${secs(r.wall)}</td><td>${kTok(r.tokens)}</td><td>${r.cost !== null && r.tokens ? `$${r.cost.toFixed(2)}` : '–'}</td></tr>`).join('\n')}
</tbody></table></div>`;
  const matrix = `<h2>Every result</h2><div class="matrix" style="grid-template-columns:minmax(110px,160px) repeat(${order.length},minmax(130px,220px))">
<div></div>${order.map((l) => `<div class="h" title="${esc(l)}">${esc(l)}</div>`).join('')}
${ids.map((id) => {
    const t = tasks.find((x) => x.id === id)!;
    return `<div class="t">${esc(t.title)}</div>${order.map((l) => {
      const r = get(id, l);
      if (!r) return '<a><div class="empty">not run</div></a>';
      return `<a href="#${esc(slug(id))}--${esc(slug(l))}" title="${esc(l)}: ${r.score}">${r.files?.render ? `<img loading="lazy" src="${esc(r.files.render)}" alt="">` : '<div class="empty">nothing cooked</div>'}<span class="badge ${scoreClass(r.score)}">${r.score}</span></a>`;
    }).join('')}`;
  }).join('\n')}</div>`;
  const sections = ids.map((id) => {
    const t = tasks.find((x) => x.id === id)!;
    const rs = order.map((l) => get(id, l)).filter((r): r is Result => !!r).sort((a, b) => b.score - a.score || a.metrics.toolCalls - b.metrics.toolCalls);
    const glbs = rs.filter((r) => r.files?.glb).map((r) => ({ glb: r.files!.glb, label: `${r.label} · ${r.score}` }));
    return `<section class="task" id="${esc(slug(id))}"><header><div><span class="cat">${esc(t.category)}</span><h3>${esc(t.title)}</h3></div>${glbs.length > 1 ? `<button type="button" class="compare3d" data-title="${esc(t.title)}" data-items="${esc(JSON.stringify(glbs))}">compare all in 3D</button>` : ''}</header>
<blockquote>${esc(t.prompt)}</blockquote>
<div class="cards">${rs.map((r, i) => card(r, i)).join('\n')}</div></section>`;
  }).join('\n');
  const method = `<h2>How it is scored</h2><div class="method">
<p>Each task runs in a fresh TopoTopo package with a fresh MCP server (<code>src/mcp/server.ts</code>): the model gets the server's tools and instructions, the task, and a budget of tool calls and minutes. When it stops, the graph it left is cooked again by the bench, not taken from the conversation. The score is the share of the task's checks that pass (sizes in metres, triangle budgets, pieces, materials, watertightness, where the result sits against the guides); a graph that does not cook scores 0. Checks are deliberately loose: they catch failures and nonsense, and the pictures do the rest.</p>
<p>A page compares one engine revision, task suite, effort, image setting and budget. The latest attempt per model and task is shown; earlier attempts stay on disk. Scores are automatic geometry checks, not a visual quality ranking. Provider tests use local stand-ins; they do not verify live model compatibility. A timeout can leave unreported billed tokens, so its cost is unknown. To add a model: <code>node bench/llm/run.ts --model provider:model</code>, then <code>node bench/llm/report.ts</code>. See <code>bench/llm/README.md</code>.</p></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TopoTopo Bench</title><meta name="description" content="Language models building 3D scenes with TopoTopo's MCP tools, compared side by side.">
<style>${CSS}</style>
<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.170.0/build/three.module.js","three/addons/":"https://unpkg.com/three@0.170.0/examples/jsm/"}}</script>
</head><body><main>${head}${board}${matrix}${sections}${method}</main>
<div id="viewer" role="dialog" aria-modal="true" aria-label="3D view"><header><div><strong id="v3title"></strong><p>drag to orbit (the views turn together), wheel to zoom · Esc closes</p></div><button type="button" id="v3close">close</button></header><div id="views3d"></div></div>
<script type="module">${VIEWER_JS}</script></body></html>`;
}

/** Copy a version's result files into the site and point the results at them. */
function stage(results: Result[], outDir: string, version: string) {
  for (const r of results) {
    const rel = path.join('files', slug(version), participantKey(r), slug(r.task));
    fs.mkdirSync(path.join(outDir, rel), { recursive: true });
    r.files = {};
    for (const [key, name] of [['render', 'render.png'], ['views', 'views.png'], ['glb', 'model.glb'], ['graph', 'graph.json'], ['transcript', 'transcript.json']] as const) {
      const src = path.join(r.dir!, name);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(outDir, rel, name));
      r.files[key] = `${rel.split(path.sep).join('/')}/${name}`;
    }
    try {
      const tr = JSON.parse(fs.readFileSync(path.join(r.dir!, 'transcript.json'), 'utf8'));
      (r as any).toolSeq = tr.turns.flatMap((t: any) => t.calls.map((c: any) => c.name + (c.isError ? '!' : '')));
    } catch { /* no transcript */ }
  }
}

export function buildReport(resultsDir: string, outDir: string, only?: string): string[] {
  const by = collect(resultsDir);
  const groups = [...by.keys()].filter((k) => !only || by.get(k)![0].topotopo.version === only).sort((a, b) => verCmp(by.get(a)![0].topotopo.version, by.get(b)![0].topotopo.version) || by.get(a)!.map((r) => r.date).sort().at(-1)!.localeCompare(by.get(b)!.map((r) => r.date).sort().at(-1)!));
  if (!groups.length) throw new Error(`no results${only ? ` for TopoTopo ${only}` : ''} in ${resultsDir}: run node bench/llm/run.ts first`);
  const latest = groups.at(-1)!;
  fs.rmSync(path.join(outDir, 'files'), { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const v of groups) {
    const rs = by.get(v);
    if (!rs) continue;
    stage(rs, outDir, v);
    const file = path.join(outDir, `${v}.html`);
    const html = buildPage(rs, rs[0].topotopo.version, groups.filter((x) => x !== v));
    fs.writeFileSync(file, html);
    if (v === latest) fs.writeFileSync(path.join(outDir, 'index.html'), html);
    written.push(file);
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const resultsDir = path.resolve(arg('--results') ?? path.join(HERE, 'results'));
  const outDir = path.resolve(arg('--out') ?? path.join(HERE, 'report'));
  for (const f of buildReport(resultsDir, outDir, arg('--version'))) console.log(`wrote ${path.relative(process.cwd(), f)}`);
}
