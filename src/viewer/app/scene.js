// Geometry in the viewport: the cooked output and, through the same MeshObject,
// the reference layers. Display modes (as the view's shading, shaded, wire, shaded + wire, points, bounding box,
// ghost), backfaces tinted blue and the open / non-manifold / flipped edges drawn as the render tool draws them,
// connected pieces for picking and box selection, and the orange selection wireframe.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { weld, pieces, pieceBounds, edgeClasses, subsetIndex, edgePairs, EDGE_COLORS } from './mesh.js';

export const COLORS = { sel: '#f0a030', wire: '#a9aeb5', wireOver: '#101113', box: '#a9aeb5', points: '#c9cdd2', line: '#c9cdd2', guide: '#7fb4c1' };
export const DISPLAY_MODES = [
  ['view', 'as view'], ['shaded', 'shaded'], ['wire', 'wire'], ['shadedWire', 'shaded + wire'], ['points', 'points'], ['bbox', 'bounding box'],
];
export const LAYER_MODES = [...DISPLAY_MODES, ['ghost', 'ghost']];

// ---------------------------------------------------------------------------------------------- shader patches
/**
 * Pull lines drawn over a surface a little towards the camera so they win the depth test (polygon offset does not
 * reach a logarithmic depth buffer, which writes gl_FragDepth): 0.15 % of the distance in persp, a sliver of the
 * depth range in ortho. Works on the built-in materials and on LineMaterial.
 */
export function nudge(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (sh, r) => {
    prev?.call(material, sh, r);
    const pull = /* glsl */`
      if (isPerspectiveMatrix(projectionMatrix)) mvPosition.xyz *= 0.9985;
      else mvPosition.z += 4e-5 * (-2.0 / projectionMatrix[2][2]);`;
    if (sh.vertexShader.includes('#include <project_vertex>'))
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\n{${pull}\n gl_Position = projectionMatrix * mvPosition; }`);
    else sh.vertexShader = sh.vertexShader.replace('vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );',
      `vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );\n{ vec4 mvPosition = start; ${pull} start = mvPosition; mvPosition = end; ${pull} end = mvPosition; }`);
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${key ? key() : ''}|nudge`;
  return material;
}

/** Backfaces tinted blue as the render tool tints them (src/render/raster.ts): colour × 0.35 + (0.12, 0.22, 0.6). */
export function backTint(material) {
  // Authored two-sided surfaces (cards, cloth, etc.) have intentional backfaces.
  if (material.side === THREE.DoubleSide) return material;
  if (material.userData.backTint) return material;
  material.userData.backTint = true;
  material.side = THREE.DoubleSide;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (sh, r) => {
    prev?.call(material, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      if (!gl_FrontFacing) {
        vec3 s = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(1.0 / 2.2)) * 0.35 + vec3(0.12, 0.22, 0.6);
        diffuseColor.rgb = pow(s, vec3(2.2));
      }`);
  };
  material.customProgramCacheKey = () => 'backtint';
  material.needsUpdate = true;
  return material;
}

/** Every LineMaterial on screen: its resolution is the size of the view being drawn (main.js sets it per view). */
export const LINE_MATERIALS = new Set();
export function lineMaterial(opts) {
  const m = new LineMaterial({ linewidth: 1.5, transparent: true, ...opts });
  LINE_MATERIALS.add(m);
  const dispose = m.dispose.bind(m);
  m.dispose = () => { LINE_MATERIALS.delete(m); dispose(); };
  return m;
}
/** Fat line segments from a Float32Array of [x, y, z, x, y, z] pairs, one colour or per-vertex colours. */
export function fatSegments(pos, { color = '#ffffff', colors = null, width = 1.5, opacity = 1, depthTest = true, over = false } = {}) {
  const g = new LineSegmentsGeometry();
  g.setPositions(pos);
  if (colors) g.setColors(colors);
  const m = lineMaterial({ color: colors ? '#ffffff' : color, vertexColors: !!colors, linewidth: width, opacity, depthTest, depthWrite: false });
  if (over) nudge(m);
  const l = new LineSegments2(g, m);
  l.frustumCulled = false;
  return l;
}

/** Free an object's geometries and materials, except the shared ones in `keep`. */
export function disposeTree(obj, keep = SHARED) {
  obj.traverse((o) => {
    if (o.geometry && !keep.has(o.geometry)) o.geometry.dispose();
    for (const m of [o.material ?? []].flat()) {
      if (keep.has(m)) continue;
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

// --------------------------------------------------------------------------------------------- shared materials
const wireLight = new THREE.MeshBasicMaterial({ color: COLORS.wire, wireframe: true });
const wireDark = nudge(new THREE.MeshBasicMaterial({ color: COLORS.wireOver, wireframe: true, transparent: true, opacity: 0.32, depthWrite: false }));
const ghostMesh = new THREE.MeshStandardMaterial({ color: 0xaab0ba, roughness: 0.85, metalness: 0, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
const ghostLine = new THREE.LineBasicMaterial({ color: 0xc4cad4, transparent: true, opacity: 0.6, depthWrite: false });
const ghostPoint = new THREE.PointsMaterial({ color: 0xc4cad4, size: 3, sizeAttenuation: false, transparent: true, opacity: 0.75, depthWrite: false });
const pointMat = new THREE.PointsMaterial({ color: COLORS.points, size: 2, sizeAttenuation: false });
const boxMat = new THREE.LineBasicMaterial({ color: COLORS.box });
const hoverMat = nudge(new THREE.LineBasicMaterial({ color: COLORS.sel, transparent: true, opacity: 0.2, depthWrite: false }));
const SHARED = new Set([wireLight, wireDark, ghostMesh, ghostLine, ghostPoint, pointMat, boxMat, hoverMat]);
/** Above this many triangles a hovered piece shows its bounding box rather than its wireframe. */
const HOVER_WIRE_MAX = 20000;

// ------------------------------------------------------------------------------------------------ mesh objects
/** A compact Float32Array of a geometry's positions (an interleaved or offset attribute is copied). */
function positionsOf(g) {
  const a = g.attributes.position;
  if (!a.isInterleavedBufferAttribute && a.array instanceof Float32Array && a.itemSize === 3 && !a.normalized && a.array.length === a.count * 3) return a.array;
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) { out[i * 3] = a.getX(i); out[i * 3 + 1] = a.getY(i); out[i * 3 + 2] = a.getZ(i); }
  return out;
}
const indexOf = (g) => (g.index ? g.index.array : null);
const ray3 = { e1: new THREE.Vector3(), e2: new THREE.Vector3(), p: new THREE.Vector3(), t: new THREE.Vector3(), q: new THREE.Vector3() };
/** Möller–Trumbore, both sides: the distance along the ray, or Infinity. */
function hitTri(ray, P, a, b, c) {
  const { e1, e2, p, t, q } = ray3;
  e1.set(P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]);
  e2.set(P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]);
  p.crossVectors(ray.direction, e2);
  const det = e1.dot(p);
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  t.set(ray.origin.x - P[a * 3], ray.origin.y - P[a * 3 + 1], ray.origin.z - P[a * 3 + 2]);
  const u = t.dot(p) * inv;
  if (u < 0 || u > 1) return Infinity;
  q.crossVectors(t, e1);
  const v = ray.direction.dot(q) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const d = e2.dot(q) * inv;
  return d > 0 ? d : Infinity;
}
const boxCorners = (b) => Array.from({ length: 8 }, (_, k) => new THREE.Vector3(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z));

/**
 * A loaded GLB scene with display modes, pieces, picking and highlights. Pieces are numbered across the object's
 * drawables: each connected part of a mesh, each instance of an instanced mesh, each polyline, each point cloud.
 */
export class MeshObject {
  constructor(id, src, { picture = false } = {}) {
    this.id = id;
    this.picture = picture;
    this.root = new THREE.Group();
    this.root.name = id;
    this.src = src;
    this.root.add(src);
    this.parts = [];
    src.updateMatrixWorld(true);
    src.traverse((o) => {
      const type = o.isInstancedMesh ? 'inst' : o.isMesh ? 'mesh' : o.isLineSegments ? 'lines' : o.isLine ? 'strip' : o.isPoints ? 'points' : null;
      if (!type) return;
      const part = { obj: o, type, orig: o.material, offset: 0, count: 1, a: null };
      if (type === 'mesh' || type === 'inst') for (const m of [o.material].flat()) backTint(m);
      if (type === 'points') for (const m of [o.material].flat()) { m.size = 3; m.sizeAttenuation = false; }
      if ((type === 'lines' || type === 'strip') && !o.geometry.attributes.color) for (const m of [o.material].flat()) if (m.color?.getHex() === 0xffffff) m.color.set(COLORS.line);
      this.parts.push(part);
    });
    this.extras = new THREE.Group();
    this.root.add(this.extras);
    this.mode = null;
    /** drawn as its bounding box (set from the entry's display mode before each frame) */
    this.bboxMode = false;
    this.bboxObj = null;
    this.hl = { key: '', objs: [] };
    this.analysed = false;
  }

  /** Piece analysis, on first need. */
  analyse() {
    if (this.analysed) return;
    this.analysed = true;
    let offset = 0;
    for (const part of this.parts) {
      const g = part.obj.geometry;
      part.offset = offset;
      if (part.type === 'inst') { part.count = part.obj.count; g.computeBoundingBox(); }
      else if (part.type === 'points') part.count = 1;
      else {
        const P = positionsOf(g), I = indexOf(g), n = g.attributes.position.count, w = weld(P);
        let index = I;
        // a strip's segments as pairs
        if (part.type === 'strip') {
          const m = I ? I.length : n, s = new Uint32Array(Math.max(0, m - 1) * 2);
          for (let k = 0; k + 1 < m; k++) { s[k * 2] = I ? I[k] : k; s[k * 2 + 1] = I ? I[k + 1] : k + 1; }
          index = s;
        }
        const per = part.type === 'mesh' ? 3 : 2;
        const pc = pieces(index, n, w, per);
        part.a = { P, index, n, w, per, pc, bounds: pieceBounds(P, pc.vert, pc.count) };
        part.count = pc.count;
        if (part.type === 'mesh') {
          // triangles of each piece, for picking
          const start = new Uint32Array(pc.count + 1);
          for (const p of pc.elem) start[p + 1]++;
          for (let k = 0; k < pc.count; k++) start[k + 1] += start[k];
          const fill = start.slice(0, pc.count), tris = new Uint32Array(pc.elem.length);
          pc.elem.forEach((p, t) => { tris[fill[p]++] = t; });
          part.a.start = start; part.a.tris = tris;
        }
      }
      offset += part.count;
    }
    this.pieceTotal = offset;
  }
  pieceCount() { this.analyse(); return this.pieceTotal; }
  /** {part, local} of a piece number */
  partOf(k) { this.analyse(); for (const p of this.parts) if (k >= p.offset && k < p.offset + p.count) return { part: p, local: k - p.offset }; return null; }

  /** World bounds of the object, or of one piece. */
  bounds(piece = null) {
    this.root.updateMatrixWorld(true);
    if (piece === null) {
      const b = new THREE.Box3();
      for (const p of this.parts) {
        const o = p.obj, g = o.geometry;
        if (!g.attributes.position?.count) continue;
        if (o.isInstancedMesh) { o.computeBoundingBox(); if (o.boundingBox) b.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld)); continue; }
        if (!g.boundingBox) g.computeBoundingBox();
        b.union(g.boundingBox.clone().applyMatrix4(o.matrixWorld));
      }
      return b;
    }
    const at = this.partOf(piece);
    if (!at) return new THREE.Box3();
    const { part, local } = at;
    if (part.type === 'inst') {
      const m = new THREE.Matrix4();
      part.obj.getMatrixAt(local, m);
      return part.obj.geometry.boundingBox.clone().applyMatrix4(m.premultiply(part.obj.matrixWorld));
    }
    if (part.type === 'points') return new THREE.Box3().setFromObject(part.obj, true);
    const B = part.a.bounds, o = local * 6;
    return new THREE.Box3(new THREE.Vector3(B[o], B[o + 1], B[o + 2]), new THREE.Vector3(B[o + 3], B[o + 4], B[o + 5])).applyMatrix4(part.obj.matrixWorld);
  }

  /** The nearest piece the world ray `rc` (a Raycaster) hits: {piece, dist, point} or null. */
  pick(rc, linePx = 0) {
    if (!this.root.visible) return null;
    this.analyse();
    this.root.updateMatrixWorld(true);
    let best = null;
    const consider = (piece, dist, point) => { if (dist < (best?.dist ?? Infinity)) best = { piece, dist, point }; };
    if (this.bboxMode) {
      const b = this.bounds(), p = rc.ray.intersectBox(b, new THREE.Vector3());
      if (p) consider(0, p.distanceTo(rc.ray.origin), p);
      return best ? { ...best, piece: null } : null;
    }
    for (const part of this.parts) {
      const o = part.obj;
      if (part.type === 'mesh') {
        const inv = o.matrixWorld.clone().invert(), local = rc.ray.clone().applyMatrix4(inv);
        const { P, index, bounds, start, tris } = part.a, box = new THREE.Box3();
        for (let k = 0; k < part.count; k++) {
          box.min.set(bounds[k * 6], bounds[k * 6 + 1], bounds[k * 6 + 2]); box.max.set(bounds[k * 6 + 3], bounds[k * 6 + 4], bounds[k * 6 + 5]);
          if (!local.intersectsBox(box)) continue;
          let near = Infinity;
          for (let s = start[k]; s < start[k + 1]; s++) {
            const t = tris[s];
            const a = index ? index[t * 3] : t * 3, b = index ? index[t * 3 + 1] : t * 3 + 1, c = index ? index[t * 3 + 2] : t * 3 + 2;
            const d = hitTri(local, P, a, b, c);
            if (d < near) near = d;
          }
          if (near < Infinity) {
            const p = local.at(near, new THREE.Vector3()).applyMatrix4(o.matrixWorld);
            consider(part.offset + k, p.distanceTo(rc.ray.origin), p);
          }
        }
      } else if (part.type === 'inst') {
        const m = new THREE.Matrix4(), g = o.geometry, P = positionsOf(g), I = indexOf(g), nTri = (I ? I.length : P.length / 3) / 3;
        for (let k = 0; k < o.count; k++) {
          o.getMatrixAt(k, m);
          m.premultiply(o.matrixWorld);
          const local = rc.ray.clone().applyMatrix4(m.clone().invert());
          if (!local.intersectsBox(g.boundingBox)) continue;
          let near = Infinity;
          for (let t = 0; t < nTri; t++) {
            const d = hitTri(local, P, I ? I[t * 3] : t * 3, I ? I[t * 3 + 1] : t * 3 + 1, I ? I[t * 3 + 2] : t * 3 + 2);
            if (d < near) near = d;
          }
          if (near < Infinity) { const p = local.at(near, new THREE.Vector3()).applyMatrix4(m); consider(part.offset + k, p.distanceTo(rc.ray.origin), p); }
        }
      } else if (linePx > 0 && o.visible) {
        rc.params.Line.threshold = linePx; rc.params.Points.threshold = linePx;
        const hits = rc.intersectObject(o, false);
        if (!hits.length) continue;
        const h = hits[0], vi = h.index ?? 0;
        const local = part.type === 'points' ? 0 : Math.max(0, part.a.pc.vert[vi] ?? 0);
        consider(part.offset + local, h.distance, h.point.clone());
      }
    }
    return best;
  }

  /** Pieces whose whole bounds project inside a slot rect: `inside(corners)` tests world points. */
  boxPieces(inside) {
    if (!this.root.visible) return [];
    if (this.bboxMode) return inside(boxCorners(this.bounds())) ? [null] : [];
    this.analyse();
    const out = [];
    for (let k = 0; k < this.pieceTotal; k++) if (inside(boxCorners(this.bounds(k)))) out.push(k);
    return out;
  }

  /** Apply a display mode (resolved from 'view' by the caller) before a view renders. */
  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    const meshOn = mode === 'shaded' || mode === 'wire' || mode === 'shadedWire' || mode === 'ghost';
    for (const part of this.parts) {
      const o = part.obj;
      if (part.type === 'mesh' || part.type === 'inst') {
        o.visible = meshOn;
        o.material = mode === 'wire' ? wireLight : mode === 'ghost' ? ghostMesh : part.orig;
        if (mode === 'ghost' && o.isInstancedMesh) o.instanceColor = null;
        this.wireOver(part, mode === 'shadedWire');
        this.edges(part, mode === 'shaded' || mode === 'wire' || mode === 'shadedWire');
        this.pointsOf(part, mode === 'points');
      } else if (part.type === 'points') {
        o.visible = mode !== 'bbox';
        o.material = mode === 'ghost' ? ghostPoint : part.orig;
      } else {
        o.visible = mode !== 'bbox' && mode !== 'points';
        o.material = mode === 'ghost' ? ghostLine : part.orig;
        this.pointsOf(part, mode === 'points');
      }
    }
    if (mode === 'bbox' && !this.bboxObj) {
      this.bboxObj = new THREE.Box3Helper(this.bounds(), COLORS.box);
      this.bboxObj.material.dispose();
      this.bboxObj.material = boxMat;
      this.extras.add(this.bboxObj);
    }
    if (this.bboxObj) this.bboxObj.visible = mode === 'bbox';
  }
  wireOver(part, on) {
    if (!on && !part.wire) return;
    if (!part.wire) {
      const o = part.obj;
      part.wire = o.isInstancedMesh ? new THREE.InstancedMesh(o.geometry, wireDark, o.count) : new THREE.Mesh(o.geometry, wireDark);
      if (o.isInstancedMesh) { part.wire.instanceMatrix = o.instanceMatrix; part.wire.instanceColor = null; }
      part.wire.frustumCulled = false;
      part.wire.renderOrder = 2;
      o.add(part.wire);
    }
    part.wire.visible = on;
  }
  /** The render tool's open / non-manifold / flipped edges of a mesh (not of instances), found after the first frame. */
  edges(part, on) {
    // a picture is an image, not a surface: no edges to check
    if (part.type !== 'mesh' || this.picture || (!on && !part.edgeObj)) return;
    if (part.edgeObj === undefined) {
      part.edgeObj = null;
      setTimeout(() => { if (!this.disposed) { this.findEdges(part); this.mode = null; this.onReady?.(); } }, 0);
    }
    if (part.edgeObj) part.edgeObj.visible = on;
  }
  findEdges(part) {
    this.analyse();
    const { P, index, n, w } = part.a, e = edgeClasses(index, n, w);
    part.edgeCounts = { open: e.open.length / 2, nonManifold: e.nonManifold.length / 2, flipped: e.flipped.length / 2 };
    const total = e.open.length + e.nonManifold.length + e.flipped.length;
    if (!total) return;
    const pos = new Float32Array(total * 3), col = new Float32Array(total * 3);
    let o = 0;
    for (const [list, c] of [[e.open, EDGE_COLORS.open], [e.nonManifold, EDGE_COLORS.nonManifold], [e.flipped, EDGE_COLORS.flipped]]) {
      const lc = new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
      for (const v of list) { pos.set(P.subarray(v * 3, v * 3 + 3), o * 3); col.set([lc.r, lc.g, lc.b], o * 3); o++; }
    }
    part.edgeObj = fatSegments(pos, { colors: col, width: 2, over: true });
    part.edgeObj.renderOrder = 3;
    part.edgeObj.name = 'open edges';
    part.obj.add(part.edgeObj);
  }
  /** Edge counts once known: {open, nonManifold, flipped} or null. */
  edgeCounts() {
    const ps = this.parts.filter((p) => p.type === 'mesh');
    if (!ps.length || ps.some((p) => !p.edgeCounts)) return ps.length ? null : { open: 0, nonManifold: 0, flipped: 0 };
    return ps.reduce((s, p) => ({ open: s.open + p.edgeCounts.open, nonManifold: s.nonManifold + p.edgeCounts.nonManifold, flipped: s.flipped + p.edgeCounts.flipped }), { open: 0, nonManifold: 0, flipped: 0 });
  }
  pointsOf(part, on) {
    if (!on && !part.points) return;
    if (!part.points) {
      const o = part.obj;
      if (o.isInstancedMesh) {
        const P = new Float32Array(o.count * 3), m = new THREE.Matrix4(), v = new THREE.Vector3();
        for (let k = 0; k < o.count; k++) { o.getMatrixAt(k, m); v.setFromMatrixPosition(m); P.set([v.x, v.y, v.z], k * 3); }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(P, 3));
        part.points = new THREE.Points(g, pointMat);
      } else part.points = new THREE.Points(o.geometry, pointMat);
      part.points.frustumCulled = false;
      // a sibling with the same transform: the mesh itself is hidden in this mode
      o.parent.add(part.points);
      part.points.position.copy(o.position); part.points.quaternion.copy(o.quaternion); part.points.scale.copy(o.scale);
    }
    part.points.visible = on;
  }

  /**
   * Draw the highlight: `sel` = {whole, pieces: Set}, `hover` = {whole, piece}. Selection is an orange wireframe,
   * hover a dimmer thinner one; both are rebuilt only when they change.
   */
  highlight(sel, hover) {
    const key = JSON.stringify([sel.whole, [...sel.pieces].sort((a, b) => a - b), hover.whole, hover.piece, !!this.bboxMode]);
    if (key === this.hl.key) return;
    this.hl.key = key;
    for (const o of this.hl.objs) { o.parent?.remove(o); if (!SHARED.has(o.material)) o.material.dispose(); o.geometry.dispose(); }
    this.hl.objs = [];
    if (!sel.whole && !sel.pieces.size && !hover.whole && hover.piece === null) return;
    this.analyse();
    const box = (b, selected) => {
      const h = new THREE.Box3Helper(b, COLORS.sel);
      if (!selected) { h.material.dispose(); h.material = hoverMat; }
      this.extras.add(h); this.hl.objs.push(h);
    };
    const add = (selected, whole, set) => {
      if (this.bboxMode) return box(this.bounds(), selected);
      for (const part of this.parts) {
        const keep = new Set();
        for (let k = 0; k < part.count; k++) if (whole || set.has(part.offset + k)) keep.add(k);
        if (!keep.size) continue;
        // hovering a big piece (a terrain) outlines its box: its wireframe would wash the view orange
        if (!selected && this.triangles(part, keep) > HOVER_WIRE_MAX) { for (const k of keep) box(this.bounds(part.offset + k), false); continue; }
        const pos = this.wirePositions(part, keep);
        if (!pos?.length) continue;
        let obj;
        if (selected) obj = fatSegments(pos, { color: COLORS.sel, width: 1.5, over: true });
        else {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          obj = new THREE.LineSegments(g, hoverMat);
          obj.frustumCulled = false;
        }
        obj.renderOrder = selected ? 5 : 4;
        // wireframes are in the part's space, boxes in world space; either way they hang off the object, shown in every mode
        if (this.partSpace(part)) { obj.matrixAutoUpdate = false; obj.matrix.copy(part.obj.matrixWorld); }
        this.extras.add(obj);
        this.hl.objs.push(obj);
      }
    };
    if (sel.whole || sel.pieces.size) add(true, sel.whole, sel.pieces);
    if (hover.whole || (hover.piece !== null && !sel.whole && !sel.pieces.has(hover.piece))) add(false, hover.whole, new Set(hover.piece === null ? [] : [hover.piece]));
  }
  /** Triangles of the chosen local pieces of a part. */
  triangles(part, keep) {
    if (part.type !== 'mesh') return 0;
    let n = 0;
    for (const k of keep) n += part.a.start[k + 1] - part.a.start[k];
    return n;
  }
  /** Whether a part's highlight is drawn in its own space (wireframes) rather than in world space (boxes). */
  partSpace(part) { return (part.type === 'mesh' && !this.picture) || part.type === 'lines' || part.type === 'strip'; }
  /** Line pairs outlining the chosen local pieces of a part: a wireframe in part space, or boxes in world space. */
  wirePositions(part, keep) {
    if (part.type === 'mesh' && !this.picture) {
      const { P, index, n, w, pc } = part.a;
      const sub = subsetIndex(index, n, pc.elem, keep), pairs = edgePairs(sub, w);
      const out = new Float32Array(pairs.length * 3);
      pairs.forEach((v, i) => { out[i * 3] = P[v * 3]; out[i * 3 + 1] = P[v * 3 + 1]; out[i * 3 + 2] = P[v * 3 + 2]; });
      return out;
    }
    if (part.type === 'lines' || part.type === 'strip') {
      const { P, index, n, pc } = part.a, sub = subsetIndex(index, n, pc.elem, keep, 2);
      const out = new Float32Array(sub.length * 3);
      sub.forEach((v, i) => { out[i * 3] = P[v * 3]; out[i * 3 + 1] = P[v * 3 + 1]; out[i * 3 + 2] = P[v * 3 + 2]; });
      return out;
    }
    // instances, point clouds and pictures: their bounding boxes
    const out = [];
    for (const k of keep) {
      const b = this.bounds(part.offset + k), c = boxCorners(b);
      for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) out.push(c[i].x, c[i].y, c[i].z, c[j].x, c[j].y, c[j].z);
    }
    return new Float32Array(out);
  }

  /** Counts for the properties panel: {meshes, triangles, vertices, lines, points, instances}. */
  stats() {
    const s = { triangles: 0, vertices: 0, segments: 0, points: 0, instances: 0 };
    for (const p of this.parts) {
      const g = p.obj.geometry, n = g.attributes.position?.count ?? 0, idx = g.index?.count;
      if (p.type === 'mesh' || p.type === 'inst') { s.triangles += (idx ?? n) / 3 * (p.type === 'inst' ? p.obj.count : 1); s.vertices += n; if (p.type === 'inst') s.instances += p.obj.count; }
      else if (p.type === 'points') s.points += n;
      else s.segments += p.type === 'lines' ? (idx ?? n) / 2 : Math.max(0, (idx ?? n) - 1);
    }
    return s;
  }

  dispose() {
    this.disposed = true;
    this.root.parent?.remove(this.root);
    for (const o of this.hl.objs) { if (!SHARED.has(o.material)) o.material.dispose(); o.geometry.dispose(); }
    for (const p of this.parts) {
      for (const m of [p.orig].flat()) { for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose(); }
      p.edgeObj?.geometry.dispose(); p.edgeObj?.material.dispose();
      if (p.points && p.points.geometry !== p.obj.geometry) p.points.geometry.dispose();
    }
    disposeTree(this.root);
  }
}

// --------------------------------------------------------------------------------------------- loading GLBs
// meshopt for the gallery's baked preview.glb (the live routes send plain GLB)
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
/** Parse a GLB buffer into a three.js scene, or throw. */
export const parseGLB = (buf) => new Promise((resolve, reject) => loader.parse(buf, '', (g) => resolve(g.scene), reject));
/** A PNG arrives as flat quads with unlit materials named "image:<name>" (src/render/texview.ts): a picture. */
export function isPicture(root) {
  let meshes = 0, all = true;
  root.traverse((o) => { if (o.isMesh) { meshes++; all &&= [o.material].flat().every((m) => m.name?.startsWith('image:')); } });
  return meshes > 0 && all;
}

/** Lights for a matte look: a sky / ground fill and a key light that follows each view's camera. */
export function createLights(scene) {
  const hemi = new THREE.HemisphereLight(0xdfe6f0, 0x3b342c, 1.5);
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  scene.add(hemi, key, key.target);
  return {
    /** from above the camera's left shoulder, at the view's target */
    follow(camera, target) {
      const r = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion), b = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
      key.target.position.copy(target);
      key.position.copy(target).addScaledVector(b, 1).addScaledVector(u, 0.8).addScaledVector(r, -0.6);
      key.target.updateMatrixWorld(); key.updateMatrixWorld();
    },
  };
}
