// The adaptive metre grid, the world axes, the axis gizmo and each view's readouts (docs/design/viewer.md section 4).
// The grid lies on y = 0 under persp and the top / bottom views, and on each side view's own plane (front: XY,
// right: ZY), as Maya and Houdini draw them; minor lines every `step`, major every 10 steps, the axes in the
// standard colours. One plane is set up again before each view renders.
import * as THREE from 'three';
import { AXIS_VIEWS, viewLabel } from './camera.js';
import { gridStep, MAJOR_EVERY, fmtStep, fmtPoint } from './units.js';

export const AXIS_COLORS = { x: '#d9534f', y: '#6abf4b', z: '#4a86d9' };
const lin = (hex) => new THREE.Color(hex);

const vertex = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
    #include <logdepthbuf_vertex>
  }`;
const fragment = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uStep;
  uniform int uPlane;          // 0: xz, 1: xy, 2: zy
  uniform vec3 uMinor, uMajor, uAxisU, uAxisV;
  uniform vec3 uCenter;
  uniform float uFade;         // fade-out radius around uCenter (0: none)
  varying vec3 vWorld;
  float lineOf(vec2 c) {
    vec2 g = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), vec2(1e-6));
    return 1.0 - min(min(g.x, g.y), 1.0);
  }
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = uPlane == 0 ? vWorld.xz : (uPlane == 1 ? vWorld.xy : vWorld.zy);
    vec2 c = p / uStep;
    vec2 fw = fwidth(c);
    // minor cells fade out from 7 px down to 3 px, majors likewise
    float dens = max(fw.x, fw.y);
    float minor = lineOf(c) * (1.0 - smoothstep(0.15, 0.35, dens));
    float major = lineOf(c / ${MAJOR_EVERY.toFixed(1)}) * (1.0 - smoothstep(0.15, 0.35, dens / ${MAJOR_EVERY.toFixed(1)}));
    vec2 pw = max(fwidth(p), vec2(1e-9));
    float onU = 1.0 - min(abs(p.y) / pw.y / 1.2, 1.0); // the U axis runs where p.y = 0
    float onV = 1.0 - min(abs(p.x) / pw.x / 1.2, 1.0);
    vec3 col = uMinor; float a = minor * 0.55;
    if (major * 0.9 > a) { col = uMajor; a = major * 0.9; }
    if (onU > 0.0 && onU >= a) { col = uAxisU; a = max(a, onU); }
    if (onV > 0.0 && onV >= a) { col = uAxisV; a = max(a, onV); }
    if (uFade > 0.0) a *= 1.0 - smoothstep(uFade * 0.55, uFade, length(vWorld - uCenter));
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }`;

/** The grid plane and the vertical world axis; `prepare(...)` sets them up for one view before it renders. */
export function createGrid(scene) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: vertex, fragmentShader: fragment, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      uStep: { value: 1 }, uPlane: { value: 0 }, uMinor: { value: lin('#3d4046') }, uMajor: { value: lin('#575b62') },
      uAxisU: { value: lin(AXIS_COLORS.x) }, uAxisV: { value: lin(AXIS_COLORS.z) }, uCenter: { value: new THREE.Vector3() }, uFade: { value: 0 },
    },
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 8, 8), mat);
  plane.renderOrder = -10;
  plane.frustumCulled = false;
  plane.name = 'grid';
  scene.add(plane);
  // the axis that stands out of the grid plane (Y under persp), through the origin
  const yAxis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0)]),
    new THREE.LineBasicMaterial({ color: AXIS_COLORS.y, transparent: true, opacity: 0.8 }));
  yAxis.frustumCulled = false;
  yAxis.renderOrder = -9;
  yAxis.name = 'y axis';
  scene.add(yAxis);

  return {
    plane,
    /**
     * Set up for one view: cam (a Cam of camera.js) and its metres per pixel at the target. Returns the grid step.
     */
    prepare(cam, wpp) {
      const step = gridStep(wpp);
      const kind = cam.name === 'persp' ? 'persp' : cam.name;
      const f = kind === 'persp' ? null : AXIS_VIEWS[kind].f;
      // the plane: xz for persp / top / bottom, xy for front / back, zy for right / left
      const planeId = !f || f[1] !== 0 ? 0 : f[2] !== 0 ? 1 : 2;
      const u = mat.uniforms;
      u.uStep.value = step;
      u.uPlane.value = planeId;
      u.uAxisU.value.set(planeId === 2 ? AXIS_COLORS.z : AXIS_COLORS.x);
      u.uAxisV.value.set(planeId === 0 ? AXIS_COLORS.z : AXIS_COLORS.y);
      const t = cam.target.clone();
      // snapped to major cells, so the lines never swim
      const big = step * MAJOR_EVERY;
      const snap = (x) => Math.round(x / big) * big;
      let half;
      // ortho: the whole view (aspects up to 4); persp: far enough to fade out before the horizon
      if (cam.ortho) half = Math.max(cam.halfH * 4, big * 2);
      else half = Math.max(cam.dist * 40, big * 4);
      half = Math.ceil(half / big) * big;
      plane.scale.set(half, half, 1);
      plane.rotation.set(0, 0, 0);
      if (planeId === 0) { plane.rotation.x = -Math.PI / 2; plane.position.set(snap(t.x), 0, snap(t.z)); }
      else if (planeId === 1) plane.position.set(snap(t.x), snap(t.y), 0);
      else { plane.rotation.y = Math.PI / 2; plane.position.set(0, snap(t.y), snap(t.z)); }
      plane.updateMatrixWorld();
      u.uCenter.value.copy(cam.ortho ? plane.position : t.clone().projectOnPlane(new THREE.Vector3(...(planeId === 0 ? [0, 1, 0] : planeId === 1 ? [0, 0, 1] : [1, 0, 0]))));
      u.uFade.value = cam.ortho ? 0 : half;
      yAxis.visible = !cam.ortho && planeId === 0;
      if (yAxis.visible) {
        // a line whose end lies behind the camera draws nothing under a logarithmic depth buffer: cut it in front
        const eye = cam.eye, fwd = cam.back.negate(), ahead = Math.max(1e-4, cam.dist * 1e-3);
        const a = new THREE.Vector3(0, -half, 0), b = new THREE.Vector3(0, half, 0);
        const da = a.clone().sub(eye).dot(fwd), db = b.clone().sub(eye).dot(fwd);
        if (da < ahead && db < ahead) yAxis.visible = false;
        else {
          if (da < ahead) a.lerp(b, (ahead - da) / (db - da));
          else if (db < ahead) b.lerp(a, (ahead - db) / (da - db));
          const pos = yAxis.geometry.attributes.position;
          pos.setXYZ(0, a.x, a.y, a.z); pos.setXYZ(1, b.x, b.y, b.z); pos.needsUpdate = true;
        }
      }
      return step;
    },
  };
}

// ------------------------------------------------------------------------------------ view overlays (DOM)
const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

/**
 * Per view slot: its frame, the name, the readouts (grid step, cursor position in orthographic views, the
 * selection's size), the axis gizmo (clicking an end calls `onAxis(slot, '+x' …)`), and layers for marks and labels.
 */
export function createOverlays(host, onAxis) {
  return [0, 1, 2, 3].map((slot) => {
    const box = document.createElement('div');
    box.className = 'vw';
    const name = document.createElement('div');
    name.className = 'vname';
    const info = document.createElement('div');
    info.className = 'vinfo';
    const marks = svgEl('svg', { class: 'marks' });
    const labels = document.createElement('div');
    labels.className = 'labels';
    const giz = svgEl('svg', { class: 'gizmo', viewBox: '-32 -32 64 64' });
    box.append(marks, labels, name, info, giz);
    host.append(box);
    const ends = {};
    for (const a of ['x', 'y', 'z']) {
      for (const sgn of ['+', '-']) {
        const g = svgEl('g', { class: 'end' });
        const line = sgn === '+' ? svgEl('line', { x1: 0, y1: 0, stroke: AXIS_COLORS[a], 'stroke-width': 2 }) : null;
        const dot = svgEl('circle', { r: sgn === '+' ? 7 : 4.5, fill: sgn === '+' ? AXIS_COLORS[a] : '#2b2d31', stroke: AXIS_COLORS[a], 'stroke-width': 1.5 });
        const txt = sgn === '+' ? svgEl('text') : null;
        if (txt) txt.textContent = a.toUpperCase();
        const t = svgEl('title');
        t.textContent = `look along ${sgn === '+' ? '-' : '+'}${a.toUpperCase()} (from ${sgn}${a.toUpperCase()})`;
        g.append(t, ...[line, dot, txt].filter(Boolean));
        g.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); onAxis(slot, `${sgn}${a}`); });
        ends[sgn + a] = { g, line, dot, txt };
      }
    }
    return {
      box, name, info, marks, labels, giz, ends,
      /** Place and fill for this frame. */
      update({ rect, visible, quad, active, cam, camera, step, cursor, selSize }) {
        box.hidden = !visible;
        if (!visible) return;
        Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
        box.classList.toggle('quad', quad);
        box.classList.toggle('active', active);
        const label = viewLabel(cam);
        if (name.dataset.t !== label) { name.dataset.t = label; name.textContent = label; }
        const lines = [`grid ${fmtStep(step)}`];
        if (cursor && cam.ortho) lines.push(cursor);
        const text = lines.join('\n') + (selSize ? '\n' : '');
        const sel = selSize ? `sel ${selSize}` : '';
        if (info.dataset.t !== text + sel) {
          info.dataset.t = text + sel;
          info.textContent = text;
          if (sel) { const s = document.createElement('span'); s.className = 'selsize'; s.textContent = sel; info.append(s); }
        }
        // the gizmo: world axes as the camera sees them, the far ends drawn first
        const m = new THREE.Matrix4().extractRotation(camera.matrixWorldInverse);
        const order = [];
        for (const a of ['x', 'y', 'z']) for (const sgn of [1, -1]) {
          const v = new THREE.Vector3(a === 'x' ? sgn : 0, a === 'y' ? sgn : 0, a === 'z' ? sgn : 0).applyMatrix4(m);
          order.push({ k: (sgn > 0 ? '+' : '-') + a, x: v.x * 22, y: -v.y * 22, z: v.z });
        }
        order.sort((p, q) => p.z - q.z);
        for (const o of order) {
          const e = ends[o.k];
          if (e.line) { e.line.setAttribute('x2', o.x.toFixed(1)); e.line.setAttribute('y2', o.y.toFixed(1)); }
          e.dot.setAttribute('cx', o.x.toFixed(1)); e.dot.setAttribute('cy', o.y.toFixed(1));
          if (e.txt) { e.txt.setAttribute('x', o.x.toFixed(1)); e.txt.setAttribute('y', o.y.toFixed(1)); }
          giz.append(e.g);
        }
      },
    };
  });
}

/** The cursor's world position on a view's construction plane, printed for orthographic views. */
export function cursorText(cam, p, step) {
  if (!p) return '';
  const kind = cam.name === 'persp' ? 'top' : cam.name;
  const f = AXIS_VIEWS[kind].f;
  // the coordinates in the view's plane, the one along the view as the plane's
  const axes = f[1] !== 0 ? ['x', 'z'] : f[2] !== 0 ? ['x', 'y'] : ['z', 'y'];
  const v = { x: p.x, y: p.y, z: p.z };
  return axes.map((a) => `${a} ${fmtPoint([v[a]], step).slice(1, -1)}`).join('  ');
}
