// The embed page (src/gallery/pages.ts embedPage): a baked preview.glb under an orbit camera, made to sit in an iframe
// on a board. Not the editor viewport (docs/design/viewer.md): no panels, no diagnostic overlays, and three's
// OrbitControls (left drag orbits, right drag pans, wheel zooms, as model viewers do), slowly turning until touched.
// The thumbnail behind the canvas stays visible until the model is in, and when it cannot load.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseGLB, createLights } from './scene.js';

const canvas = document.getElementById('gl');
const note = document.getElementById('note');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x2b2d31, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.6;
controls.addEventListener('start', () => { controls.autoRotate = false; });
const lights = createLights(scene);

let dirty = true;
controls.addEventListener('change', () => { dirty = true; });
const resize = () => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  dirty = true;
};
new ResizeObserver(resize).observe(canvas);

/** Frame the bounding sphere from the thumbnail's angle (35° around, 25° up). */
function frame(root) {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 1e-3);
  const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  const az = THREE.MathUtils.degToRad(35), el = THREE.MathUtils.degToRad(25);
  camera.position.copy(sphere.center).add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist));
  camera.near = dist / 1000;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(sphere.center);
  controls.minDistance = r * 0.05;
  controls.maxDistance = dist * 20;
  controls.update();
}

async function load() {
  try {
    const res = await fetch(canvas.dataset.src);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const root = await parseGLB(await res.arrayBuffer());
    root.traverse((o) => {
      // a point's size in pixels, as in the editor, not in metres
      if (o.isPoints) { o.material.size = 3; o.material.sizeAttenuation = false; }
      if (o.isMesh) for (const m of [o.material].flat()) m.side = THREE.DoubleSide;
    });
    scene.add(root);
    resize();
    frame(root);
    document.getElementById('poster').hidden = true;
  } catch (e) {
    canvas.hidden = true;
    note.textContent = `3D preview unavailable (${e.message})`;
  }
}

renderer.setAnimationLoop(() => {
  const moving = controls.update() || controls.autoRotate;
  if (!dirty && !moving) return;
  lights.follow(camera, controls.target);
  renderer.render(scene, camera);
  dirty = false;
});
load();
