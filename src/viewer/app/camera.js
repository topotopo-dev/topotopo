// Cameras and views: our own controller, no OrbitControls. Tumble around a pivot,
// track, dolly towards a point, no inertia: the camera moves only while the person drags, scrolls or frames. Seven
// named cameras (persp and the axis views); one view, or four in a 2×2 quad, each showing one of them with its own
// shading. Orthographic cameras cannot tumble. Near and far planes follow the scene size (the renderer keeps a
// logarithmic depth buffer), so a 1 km terrain and a 2 cm bolt both draw.
import * as THREE from 'three';

export const CAMERA_NAMES = ['persp', 'top', 'front', 'right', 'bottom', 'back', 'left'];
/** Axis views as the render tool's (src/render/raster.ts ORTHO): view direction f and up u. */
export const AXIS_VIEWS = {
  top: { f: [0, -1, 0], u: [0, 0, -1] }, bottom: { f: [0, 1, 0], u: [0, 0, 1] },
  front: { f: [0, 0, -1], u: [0, 1, 0] }, back: { f: [0, 0, 1], u: [0, 1, 0] },
  right: { f: [-1, 0, 0], u: [0, 1, 0] }, left: { f: [1, 0, 0], u: [0, 1, 0] },
};
/** The axis view that looks from the + or − side of an axis (the axis gizmo's ends). */
export const VIEW_OF_AXIS = { '+x': 'right', '-x': 'left', '+y': 'top', '-y': 'bottom', '+z': 'front', '-z': 'back' };
export const SHADINGS = [['wire', 'wire'], ['shaded', 'shaded'], ['shadedWire', 'shaded + wire']];
/** The render tool's persp: 32° across the narrower side, from azimuth 35°, elevation 25°. */
const FOV = 32, AZ = 35, EL = 25;
const TUMBLE = 0.3 * Math.PI / 180; // radians per pixel
const MIN_D = 1e-4, MAX_D = 1e7;

const quatOf = (f, u) => {
  const z = new THREE.Vector3(...f).negate(), y = new THREE.Vector3(...u), x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
};
const perspQuat = () => {
  const az = AZ * Math.PI / 180, el = EL * Math.PI / 180;
  const back = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  const m = new THREE.Matrix4().lookAt(back, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  return new THREE.Quaternion().setFromRotationMatrix(m);
};

/** One named camera: where it looks (target), how (orientation), how far (persp distance / ortho half height). */
class Cam {
  constructor(name) {
    this.name = name;
    this.ortho = name !== 'persp';
    this.target = new THREE.Vector3();
    this.pivot = new THREE.Vector3();
    this.quat = name === 'persp' ? perspQuat() : quatOf(AXIS_VIEWS[name].f, AXIS_VIEWS[name].u);
    this.dist = 12;
    this.halfH = 6;
  }
  get back() { return new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat); }
  get right() { return new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat); }
  get up() { return new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat); }
  get eye() { return this.target.clone().addScaledVector(this.back, this.dist); }
  toJSON() { return { ortho: this.ortho, target: this.target.toArray(), pivot: this.pivot.toArray(), quat: this.quat.toArray(), dist: this.dist, halfH: this.halfH }; }
  load(j) {
    if (!j) return;
    const ok = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);
    if (typeof j.ortho === 'boolean') this.ortho = j.ortho;
    if (ok(j.target, 3)) this.target.fromArray(j.target);
    this.pivot.copy(this.target);
    if (ok(j.pivot, 3)) this.pivot.fromArray(j.pivot);
    if (ok(j.quat, 4)) this.quat.fromArray(j.quat).normalize();
    if (j.dist > 0) this.dist = Math.min(MAX_D, Math.max(MIN_D, j.dist));
    if (j.halfH > 0) this.halfH = Math.min(MAX_D, Math.max(MIN_D, j.halfH));
  }
}

/** Vertical field of view (degrees) giving FOV across the narrower side. */
const vfov = (aspect) => (aspect >= 1 ? FOV : 2 * Math.atan(Math.tan((FOV * Math.PI) / 360) / aspect) * 180 / Math.PI);

/**
 * The views: four slots (quad: top, persp / front, right as in Maya and Houdini), one shown alone in single mode.
 * `scene()` gives {center: Vector3, radius} of everything drawn, for the near and far planes.
 */
export function createViews(scene) {
  const cams = new Map(CAMERA_NAMES.map((n) => [n, new Cam(n)]));
  const slots = ['top', 'persp', 'front', 'right'].map((cam) => ({ cam, shading: 'shaded', rect: { x: 0, y: 0, w: 1, h: 1 }, p: null, o: null }));
  for (const s of slots) { s.p = new THREE.PerspectiveCamera(FOV, 1, 0.01, 1000); s.o = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1000); }
  const v = {
    cams, slots, quad: false, active: 1,
    /** true once a camera was placed (framed, restored or moved by the person) */
    placed: false,
    /** the slots on screen, with their rects (CSS px in the viewport) */
    visible() { return v.quad ? slots : [slots[v.active]]; },
    layout(W, H) {
      if (!v.quad) { slots[v.active].rect = { x: 0, y: 0, w: W, h: H }; return; }
      const w0 = Math.floor(W / 2), h0 = Math.floor(H / 2);
      slots[0].rect = { x: 0, y: 0, w: w0, h: h0 };
      slots[1].rect = { x: w0, y: 0, w: W - w0, h: h0 };
      slots[2].rect = { x: 0, y: h0, w: w0, h: H - h0 };
      slots[3].rect = { x: w0, y: h0, w: W - w0, h: H - h0 };
    },
    /** The slot index under a viewport point, or -1. */
    slotAt(x, y) {
      for (const s of v.visible()) { const r = s.rect; if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return slots.indexOf(s); }
      return -1;
    },
    cam: (i) => cams.get(slots[i].cam),
    /** The three.js camera of slot i, set up for its rect and the scene's size. */
    camera(i) {
      const s = slots[i], c = cams.get(s.cam), r = s.rect, aspect = Math.max(1e-3, r.w / Math.max(1, r.h));
      const { center, radius } = scene();
      const R = Math.max(radius, 1e-3);
      if (!c.ortho) {
        const p = s.p, eye = c.eye;
        p.fov = vfov(aspect); p.aspect = aspect;
        const away = eye.distanceTo(center);
        p.near = Math.max(1e-6, Math.min(c.dist, R) * 1e-4);
        p.far = Math.max(c.dist * 200, (away + R) * 4);
        p.position.copy(eye); p.quaternion.copy(c.quat);
        p.updateProjectionMatrix(); p.updateMatrixWorld();
        return p;
      }
      const o = s.o, D = c.target.distanceTo(center) + R * 2 + c.halfH * 4;
      o.left = -c.halfH * aspect; o.right = c.halfH * aspect; o.top = c.halfH; o.bottom = -c.halfH;
      o.near = 0; o.far = D * 2;
      o.position.copy(c.target).addScaledVector(c.back, D); o.quaternion.copy(c.quat);
      o.updateProjectionMatrix(); o.updateMatrixWorld();
      return o;
    },
    /** Metres per pixel at the slot's target (the grid step and constant-size marks use it). */
    worldPerPixel(i) {
      const s = slots[i], c = cams.get(s.cam), h = Math.max(1, s.rect.h);
      if (c.ortho) return (2 * c.halfH) / h;
      return (2 * c.dist * Math.tan((vfov(s.rect.w / h) * Math.PI) / 360)) / h;
    },
    /** Normalised device coordinates of a viewport point (px in the viewport, as every pointer position here) in slot i. */
    ndc(i, x, y) { const r = slots[i].rect; return new THREE.Vector2(((x - r.x) / r.w) * 2 - 1, -((y - r.y) / r.h) * 2 + 1); },
    ray(i, x, y) { const rc = new THREE.Raycaster(); rc.setFromCamera(v.ndc(i, x, y), v.camera(i)); return rc; },
    /** A world point in viewport pixels as slot i shows it, or null behind the camera. */
    project(i, p, cam = v.camera(i)) {
      const q = new THREE.Vector3(p.x, p.y, p.z).project(cam), r = slots[i].rect;
      if (q.z > 1 || q.z < -1) return null;
      return { x: r.x + ((q.x + 1) / 2) * r.w, y: r.y + ((1 - q.y) / 2) * r.h };
    },
    /** The point under a viewport point on the plane through the slot's target facing the camera. */
    targetPlanePoint(i, x, y, at) {
      const c = v.cam(i), rc = v.ray(i, x, y), n = c.back;
      const p = new THREE.Vector3();
      return rc.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, at ?? c.target), p) ? p : (at ?? c.target).clone();
    },

    // ---------------------------------------------------------------- navigation
    /** Tumble slot i's camera by a mouse move (px) around `pivot`; nothing in orthographic cameras. */
    tumble(i, dx, dy, pivot) {
      const c = v.cam(i);
      if (c.ortho) return false;
      const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * TUMBLE);
      const pitch = new THREE.Quaternion().setFromAxisAngle(c.right, -dy * TUMBLE);
      let q = yaw.clone().multiply(pitch);
      // stay upright: no rolling over the top
      if (new THREE.Vector3(0, 1, 0).applyQuaternion(q.clone().multiply(c.quat)).y < 0) q = yaw;
      const P = (pivot ?? c.target).clone();
      c.target.sub(P).applyQuaternion(q).add(P);
      c.quat.premultiply(q).normalize();
      v.placed = true;
      return true;
    },
    /** Track: the point at the target's depth follows the mouse. */
    track(i, dx, dy, at) {
      const c = v.cam(i);
      const depth = at && !c.ortho ? Math.max(MIN_D, c.eye.clone().sub(at).dot(c.back)) : c.dist;
      const k = v.worldPerPixel(i) * (c.ortho ? 1 : depth / c.dist);
      const delta = c.right.multiplyScalar(-dx * k).addScaledVector(c.up, dy * k);
      c.target.add(delta); c.pivot.add(delta);
      v.placed = true;
    },
    /** Pick a navigation pivot without changing the camera's eye, aim or distance. */
    anchor(i, hit) {
      const c = v.cam(i);
      if (hit && hit.toArray().every(Number.isFinite) && c.eye.clone().sub(hit).dot(c.back) > MIN_D) c.pivot.copy(hit);
      return c.pivot.clone();
    },
    zoomAt(i, factor, at) {
      const c = v.cam(i), before = c.ortho ? c.halfH : c.dist;
      v.dolly(i, factor, at);
      const scale = (c.ortho ? c.halfH : c.dist) / before;
      c.pivot.sub(at).multiplyScalar(scale).add(at);
    },
    /** Dolly by factor s (< 1 closer) towards `at` (a world point on the target plane; default the target). */
    dolly(i, s, at) {
      const c = v.cam(i);
      const cur = c.ortho ? c.halfH : c.dist;
      const next = Math.min(MAX_D, Math.max(MIN_D, cur * s));
      s = next / cur;
      if (at) c.target.sub(at).multiplyScalar(s).add(at);
      if (c.ortho) c.halfH = next; else c.dist = next;
      v.placed = true;
    },
    /** Frame a world box in slot i. */
    frame(i, box) {
      if (!box || box.isEmpty()) return;
      const s = slots[i], c = cams.get(s.cam), r = s.rect, aspect = Math.max(1e-3, r.w / Math.max(1, r.h));
      const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.length() / 2, 1e-3);
      c.target.copy(center);
      c.pivot.copy(center);
      const half = (vfov(aspect) * Math.PI) / 360, halfW = Math.atan(Math.tan(half) * aspect);
      c.dist = Math.min(MAX_D, Math.max(MIN_D, (radius / Math.sin(Math.min(half, halfW))) * 1.05));
      // ortho: the box's extent across the view
      const rt = c.right, up = c.up;
      let ex = 0, ey = 0;
      for (let k = 0; k < 8; k++) {
        const p = new THREE.Vector3(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z).sub(center);
        ex = Math.max(ex, Math.abs(p.dot(rt))); ey = Math.max(ey, Math.abs(p.dot(up)));
      }
      c.halfH = Math.min(MAX_D, Math.max(MIN_D, Math.max(ey, ex / aspect, 1e-3) * 1.1));
      v.placed = true;
    },
    /** Show camera `name` in slot i. */
    setCam(i, name) { if (cams.has(name)) slots[i].cam = name; },
    toggleOrtho(i) {
      const c = v.cam(i), aspect = slots[i].rect.w / Math.max(1, slots[i].rect.h), t = Math.tan((vfov(aspect) * Math.PI) / 360);
      if (c.ortho) c.dist = Math.min(MAX_D, c.halfH / t); else c.halfH = Math.max(MIN_D, c.dist * t);
      c.ortho = !c.ortho;
      v.placed = true;
    },
    /** The axis gizmo's click: persp turns to look along the axis; an axis view becomes that axis view. */
    lookAlong(i, axis) {
      const name = VIEW_OF_AXIS[axis];
      if (!name) return;
      const c = v.cam(i);
      if (c.name === 'persp') { c.quat.copy(quatOf(AXIS_VIEWS[name].f, AXIS_VIEWS[name].u)); v.placed = true; }
      else {
        // the new view looks at the same place at the same scale
        const n = cams.get(name);
        n.target.copy(c.target); n.halfH = c.ortho ? c.halfH : c.dist * 0.3;
        n.pivot.copy(c.pivot);
        slots[i].cam = name;
      }
    },
    toJSON() {
      return { cams: Object.fromEntries([...cams].map(([n, c]) => [n, c.toJSON()])), slots: slots.map((s) => ({ cam: s.cam, shading: s.shading })), quad: v.quad, active: v.active };
    },
    load(j) {
      if (!j || typeof j !== 'object') return false;
      for (const [n, c] of cams) c.load(j.cams?.[n]);
      (j.slots ?? []).slice(0, 4).forEach((s, k) => {
        if (cams.has(s?.cam)) slots[k].cam = s.cam;
        if (SHADINGS.some(([id]) => id === s?.shading)) slots[k].shading = s.shading;
      });
      v.quad = !!j.quad;
      if (Number.isInteger(j.active) && j.active >= 0 && j.active < 4) v.active = j.active;
      v.placed = true;
      return true;
    },
  };
  return v;
}

/** The view name a slot prints: the camera's name, "(ortho)" / "(persp)" when it is not its own projection. */
export function viewLabel(c) {
  if (c.name === 'persp') return c.ortho ? 'persp (ortho)' : 'persp';
  return c.ortho ? c.name : `${c.name} (persp)`;
}
