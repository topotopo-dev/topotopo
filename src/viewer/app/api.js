// The viewer server's routes (src/viewer/server.ts), one function each. Every call resolves (never throws): failures
// come back as {ok: false, error} so the page can show them in the status bar.

const fail = (error) => ({ ok: false, error: String(error) });
const offline = 'the viewer server is not answering';
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v ?? '')}`).join('&');

async function json(url, init) {
  let res;
  try { res = await fetch(url, init); } catch { return { status: 0, j: { ok: false, error: offline } }; }
  const j = await res.json().catch(() => ({ ok: false, error: `${res.status} ${res.statusText}` }));
  return { status: res.status, j };
}
/** A GLB route: {ok, buf} or {ok: false, error, stopped?} (stopped: the node its cook was stopped at). */
async function glb(url) {
  let res;
  try { res = await fetch(url); } catch { return fail(offline); }
  if (!res.ok) { const j = await res.json().catch(() => ({})); return { ...fail(j.error ?? `${res.status} ${res.statusText}`), ...(j.stopped ? { stopped: j.stopped } : {}) }; }
  return { ok: true, buf: await res.arrayBuffer() };
}
const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  /**
   * [{name, output, version, vars, graphVars, overrides, params, mode, file, cook, nodes: [{name, type, in, error, ms}]}]
   * or null. vars: what the controls show; graphVars: the graph's own; mode "file": session values over a graph file.
   */
  async graphs() { const { status, j } = await json('/api/graphs'); return status === 200 && Array.isArray(j) ? j : null; },
  /** the last cook of a graph: {ok, ms, target, errors, warnings} */
  async report(graph) { const { status, j } = await json('/api/report?' + q({ graph })); return status === 200 ? j : null; },
  geo: (graph, node) => glb('/api/geo?' + q({ graph, node })),
  /** {target, summary, ms} or null */
  async info(graph, node) { const { status, j } = await json('/api/info?' + q({ graph, node })); return status === 200 ? j : null; },
  /** {ok, ms, errors, vars?, graphVars?, overrides?, stopped?}, once a cook has applied the values (or a stop ended it) */
  async vars(graph, vars) { const { status, j } = await json('/api/vars?' + q({ graph }), post({ vars })); return status ? j : { ok: false, ms: 0, errors: [offline] }; },
  /** Save values to the graph file: {ok, saved, file, vars, graphVars, overrides} or {ok: false, error} */
  async saveVars(graph, vars) { const { status, j } = await json('/api/vars/save?' + q({ graph }), post({ vars })); return status === 200 ? j : fail(j.error ?? `${status}`); },
  /** Stop the cooks of a graph: {ok, stopping} or {ok: false, error} */
  async stop(graph) { const { status, j } = await json('/api/cook/stop?' + q({ graph }), post({})); return status === 200 ? j : fail(j.error ?? `${status}`); },
  async inputs() { const { status, j } = await json('/api/inputs'); return status === 200 && Array.isArray(j) ? j : null; },
  /** {dir, where} or null */
  async inputsDir() { const { status, j } = await json('/api/inputs_dir'); return status === 200 ? j : null; },
  /** POST /api/inputs: {status, j} as the server answers (409 when the file exists and overwrite is false) */
  async upload(file, overwrite) {
    try {
      const res = await fetch('/api/inputs?' + q({ name: file.name, overwrite: overwrite ? 1 : 0 }), { method: 'POST', body: file });
      return { status: res.status, j: await res.json().catch(() => ({})) };
    } catch (e) { return { status: 0, j: { error: `upload failed: ${e?.message ?? e}` } }; }
  },
  input: (path) => glb('/api/input?' + q({ path })),
  /** {ok, summary} or {ok: false, error} */
  async inputInfo(path) {
    const { status, j } = await json('/api/input_info?' + q({ path }));
    return status === 200 ? { ok: true, summary: String(j.summary ?? '') } : fail(j.error ?? `${status}`);
  },
  /** {markers, error?} */
  async markers() { const { status, j } = await json('/api/markers'); return status === 200 && Array.isArray(j.markers) ? j : { markers: null, error: j.error ?? offline }; },
  /** {ok, count, points, prims} or {ok: false, error} */
  async saveMarkers(body) {
    const { status, j } = await json('/api/markers', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return status === 200 && j.ok ? j : fail(j.error ?? `${status}`);
  },
  /** The event stream: on({open, error, message}); returns the EventSource. */
  events(on) {
    const es = new EventSource('/api/events');
    es.onopen = () => on.open?.();
    es.onerror = () => on.error?.();
    es.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } on.message?.(ev); };
    return es;
  },
};
