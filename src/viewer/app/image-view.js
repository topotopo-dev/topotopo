// A 2D image inspector, independent of the 3D camera. View state is remembered per output.
export function channelPixels(source, mode) {
  const pixels = new Uint8ClampedArray(source);
  const c = ['R', 'G', 'B', 'A'].indexOf(mode);
  for (let i = 0; i < pixels.length; i += 4) {
    if (c >= 0) pixels[i] = pixels[i + 1] = pixels[i + 2] = source[i + c];
    if (mode !== 'RGBA') pixels[i + 3] = 255;
  }
  return pixels;
}
export function zoomImage(state, x, y, factor) {
  const scale = Math.max(0.01, Math.min(64, state.scale * factor)), ratio = scale / state.scale;
  return { scale, x: x - (x - state.x) * ratio, y: y - (y - state.y) * ratio };
}

export function createImageView(host, message) {
  const panel = document.createElement('section'); panel.id = 'image-view'; panel.hidden = true;
  panel.innerHTML = `<div class="image-tools"><button data-act="fit">Fit</button><button data-act="actual">100%</button>
    <select aria-label="Image channel">${['RGB', 'RGBA', 'R', 'G', 'B', 'A'].map((m) => `<option>${m}</option>`).join('')}</select>
    <select aria-label="Image layer"></select><label><input type="checkbox" data-act="checker" checked> Checkerboard</label>
    <label><input type="checkbox" data-act="uv"> UV</label><span class="image-dim"></span></div>
    <div class="image-stage checker"><canvas aria-label="Image preview"></canvas><div class="image-error" hidden></div></div>`;
  host.append(panel);
  const stage = panel.querySelector('.image-stage'), canvas = panel.querySelector('canvas'), context = canvas.getContext('2d');
  const mode = panel.querySelector('[aria-label="Image channel"]'), layers = panel.querySelector('[aria-label="Image layer"]');
  const uvToggle = panel.querySelector('[data-act="uv"]'), dim = panel.querySelector('.image-dim'), error = panel.querySelector('.image-error');
  const memory = new Map();
  let item = null, bitmap = null, data = null, raster = document.createElement('canvas'), segments = [], sequence = 0;
  let state = { scale: 1, x: 0, y: 0 }, drag = null, fitNew = true;
  function remember() { if (item) memory.set(item.id, { ...state, mode: mode.value, layer: layers.value }); }
  function draw() {
    if (panel.hidden) return;
    const dpr = Math.min(2, devicePixelRatio || 1), w = stage.clientWidth, h = stage.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, w, h);
    if (!bitmap) return;
    context.save(); context.translate(state.x, state.y); context.scale(state.scale, state.scale);
    context.imageSmoothingEnabled = state.scale < 1;
    context.drawImage(raster, 0, 0);
    if (uvToggle.checked && segments.length) {
      context.beginPath();
      for (const [u, v, s, t] of segments) { context.moveTo(u * raster.width, (1 - v) * raster.height); context.lineTo(s * raster.width, (1 - t) * raster.height); }
      context.strokeStyle = '#f0a030'; context.lineWidth = 1 / state.scale; context.stroke();
    }
    context.restore(); dim.textContent = `${raster.width} × ${raster.height} · ${Math.round(state.scale * 100)}%`;
  }
  function fit() {
    if (!bitmap) return;
    state.scale = Math.min((stage.clientWidth - 32) / raster.width, (stage.clientHeight - 32) / raster.height);
    state.scale = Math.max(0.01, state.scale);
    state.x = (stage.clientWidth - raster.width * state.scale) / 2; state.y = (stage.clientHeight - raster.height * state.scale) / 2;
    remember(); draw();
  }
  function applyChannels() {
    if (!data) return;
    raster.getContext('2d').putImageData(new ImageData(channelPixels(data.data, item.generated ? 'RGBA' : mode.value), data.width, data.height), 0, 0);
    draw();
  }
  async function load() {
    if (!item) return;
    const seq = ++sequence, current = item;
    error.hidden = true;
    const q = new URLSearchParams({ id: current.id, layer: layers.value, mode: mode.value, rev: current.revision });
    const url = current.generated ? '/api/output/image?' + q : '/api/output/file?' + q;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error((await response.json()).error);
      const next = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none' });
      if (seq !== sequence) { next.close(); return; }
      bitmap?.close(); bitmap = next;
      raster.width = next.width; raster.height = next.height;
      const c = raster.getContext('2d', { willReadFrequently: true }); c.drawImage(next, 0, 0);
      data = c.getImageData(0, 0, next.width, next.height); applyChannels();
      if (fitNew) { fitNew = false; fit(); }
      if (uvToggle.checked) await loadUV();
    } catch (e) { if (seq === sequence) { error.textContent = e.message; error.hidden = false; message(e.message, 'err'); } }
  }
  async function loadUV() {
    if (!item?.generated || !uvToggle.checked) { segments = []; draw(); return; }
    const id = item.id;
    try {
      const r = await fetch('/api/output/uv?' + new URLSearchParams({ id })), j = await r.json();
      if (item?.id !== id) return;
      if (!r.ok) throw new Error(j.error);
      segments = j.segments; draw();
    } catch (e) { message(e.message, 'err'); }
  }
  panel.querySelector('[data-act="fit"]').onclick = fit;
  panel.querySelector('[data-act="actual"]').onclick = () => { state = zoomImage(state, stage.clientWidth / 2, stage.clientHeight / 2, 1 / state.scale); remember(); draw(); };
  panel.querySelector('[data-act="checker"]').onchange = (e) => stage.classList.toggle('checker', e.target.checked);
  mode.onchange = () => { remember(); if (item?.generated) load(); else applyChannels(); };
  layers.onchange = () => { remember(); load(); };
  uvToggle.onchange = loadUV;
  canvas.onpointerdown = (e) => { if (![0, 1, 2].includes(e.button)) return; e.preventDefault(); canvas.setPointerCapture(e.pointerId); drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; };
  canvas.onpointermove = (e) => { if (!drag || e.pointerId !== drag.id) return; state.x += e.clientX - drag.x; state.y += e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; draw(); };
  const end = () => { drag = null; remember(); };
  canvas.onpointerup = end; canvas.onpointercancel = end; canvas.onlostpointercapture = end; addEventListener('blur', end);
  canvas.oncontextmenu = (e) => e.preventDefault();
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1); state = zoomImage(state, e.clientX - r.left, e.clientY - r.top, Math.exp(Math.max(-1, Math.min(1, -delta * 0.0015)))); remember(); draw(); }, { passive: false });
  new ResizeObserver(draw).observe(stage);
  return {
    show(next) {
      const same = item?.id === next.id; if (!same) remember(); item = next; panel.hidden = false; host.classList.add('image-mode');
      if (!same) { bitmap?.close(); bitmap = null; data = null; segments = []; uvToggle.checked = false; }
      const saved = memory.get(next.id); if (!same) { state = saved ? { scale: saved.scale, x: saved.x, y: saved.y } : { scale: 1, x: 0, y: 0 }; fitNew = !saved; }
      layers.replaceChildren(...(next.layers ?? ['Image']).map((l) => new Option(l, l)));
      layers.value = next.layers?.includes(saved?.layer) ? saved.layer : next.layer ?? 'Image'; layers.hidden = !next.layers?.length;
      mode.value = saved?.mode ?? (next.generated ? 'RGB' : 'RGBA'); uvToggle.disabled = !next.generated;
      load();
    },
    hide() { remember(); sequence++; item = null; bitmap?.close(); bitmap = null; data = null; panel.hidden = true; host.classList.remove('image-mode'); },
    get visible() { return !panel.hidden; },
  };
}
