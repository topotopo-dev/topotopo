// Topology of the triangle meshes the viewer receives (GLB): vertices welded by exact position, connected pieces
// (what a click or a box selects inside one object: a rock of a scatter), and the edges the render tool marks in
// wireframe "boundary" (help topic "render"): open (used by one triangle), non-manifold (three or more) and winding
// flips (two triangles running the edge the same way). A polygon's triangulation never changes these: its inner
// diagonals are shared by exactly two of its triangles, wound alike.
// Plain functions on typed arrays, tested in Node (test/viewer-logic.ts).

/** The colours the render tool draws them in (src/render/raster.ts, wireframe "boundary"). */
export const EDGE_COLORS = { open: [1, 0.3, 0.62], nonManifold: [1, 0.92, 0.2], flipped: [0.72, 0.45, 1] };

const pow2 = (n) => { let s = 16; while (s < n) s <<= 1; return s; };

/**
 * For each vertex, the first vertex at exactly the same position (bit for bit): GLB vertices split at seams of
 * normals or uvs weld back into the points they came from.
 */
export function weld(positions) {
  const n = (positions.length / 3) | 0;
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, n * 3);
  const size = pow2(n * 2), mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const a = bits[i * 3], b = bits[i * 3 + 1], c = bits[i * 3 + 2];
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) >>> 0;
    h = (h ^ (h >>> 15)) & mask;
    for (;;) {
      const j = table[h];
      if (j < 0) { table[h] = i; out[i] = i; break; }
      if (bits[j * 3] === a && bits[j * 3 + 1] === b && bits[j * 3 + 2] === c) { out[i] = j; break; }
      h = (h + 1) & mask;
    }
  }
  return out;
}

/** Union-find over welded vertex ids. */
function makeSets(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; } };
  return { find, union };
}

/**
 * Connected pieces of a mesh with `count` vertices drawn as `per`-vertex elements (3: triangles, 2: segments) by
 * `index` (null: 0, 1, 2, … in order). Pieces are numbered by their first element. Returns {count, elem, vert}:
 * the number of pieces, the piece of each element and of each vertex (-1 for vertices no element uses).
 */
export function pieces(index, count, welded, per = 3) {
  const nElem = Math.floor((index ? index.length : count) / per);
  const at = index ? (i) => index[i] : (i) => i;
  const sets = makeSets(count);
  for (let e = 0; e < nElem; e++) {
    const a = welded[at(e * per)];
    for (let k = 1; k < per; k++) sets.union(a, welded[at(e * per + k)]);
  }
  const id = new Int32Array(count).fill(-1);
  const elem = new Uint32Array(nElem), vert = new Int32Array(count).fill(-1);
  let n = 0;
  for (let e = 0; e < nElem; e++) {
    const r = sets.find(welded[at(e * per)]);
    if (id[r] < 0) id[r] = n++;
    elem[e] = id[r];
    for (let k = 0; k < per; k++) vert[at(e * per + k)] = id[r];
  }
  return { count: n, elem, vert };
}

/** Bounds of each piece: Float64Array of [minx, miny, minz, maxx, maxy, maxz] per piece. */
export function pieceBounds(positions, vertPiece, count) {
  const b = new Float64Array(count * 6);
  for (let p = 0; p < count; p++) { b.fill(Infinity, p * 6, p * 6 + 3); b.fill(-Infinity, p * 6 + 3, p * 6 + 6); }
  for (let i = 0; i < vertPiece.length; i++) {
    const p = vertPiece[i];
    if (p < 0) continue;
    for (let a = 0; a < 3; a++) {
      const x = positions[i * 3 + a];
      if (x < b[p * 6 + a]) b[p * 6 + a] = x;
      if (x > b[p * 6 + 3 + a]) b[p * 6 + 3 + a] = x;
    }
  }
  return b;
}

/** An open-addressing map from an edge (two welded ids, smaller first) to a slot number. */
function edgeTable(capacity) {
  const size = pow2(capacity * 2), mask = size - 1;
  const ka = new Int32Array(size).fill(-1), kb = new Int32Array(size);
  let used = 0;
  return {
    get used() { return used; },
    /** the slot of edge (a, b), made when new */
    slot(a, b) {
      let h = ((Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77)) >>> 0) & mask;
      for (;;) {
        if (ka[h] < 0) { ka[h] = a; kb[h] = b; used++; return h; }
        if (ka[h] === a && kb[h] === b) return h;
        h = (h + 1) & mask;
      }
    },
    size,
  };
}

/**
 * The edges of a triangle mesh the render tool marks: {open, nonManifold, flipped}, each a Uint32Array of vertex
 * index pairs (one pair per edge, original vertex indices for drawing).
 */
export function edgeClasses(index, count, welded) {
  const nTri = Math.floor((index ? index.length : count) / 3);
  const at = index ? (i) => index[i] : (i) => i;
  const t = edgeTable(nTri * 3);
  // per slot: triangles running the edge from the smaller id (fwd) and from the larger (bwd), counted up to 255
  const fwd = new Uint8Array(t.size), bwd = new Uint8Array(t.size);
  const each = (f) => {
    for (let f3 = 0; f3 < nTri * 3; f3 += 3) {
      for (let k = 0; k < 3; k++) {
        const i = at(f3 + k), j = at(f3 + ((k + 1) % 3)), a = welded[i], b = welded[j];
        if (a !== b) f(a < b ? t.slot(a, b) : t.slot(b, a), a < b, i, j);
      }
    }
  };
  each((s, up) => { if (up) { if (fwd[s] < 255) fwd[s]++; } else if (bwd[s] < 255) bwd[s]++; });
  // a second pass names each marked edge once, by the first triangle edge that runs it
  const open = [], nonManifold = [], flipped = [], done = new Uint8Array(t.size);
  each((s, _up, i, j) => {
    if (done[s]) return;
    done[s] = 1;
    const n = fwd[s] + bwd[s];
    if (n === 1) open.push(i, j);
    else if (n > 2) nonManifold.push(i, j);
    else if (fwd[s] === 2 || bwd[s] === 2) flipped.push(i, j);
  });
  return { open: Uint32Array.from(open), nonManifold: Uint32Array.from(nonManifold), flipped: Uint32Array.from(flipped) };
}

/** The elements (triangles) of the given pieces, as an index array into the same vertices. */
export function subsetIndex(index, count, elemPiece, keep, per = 3) {
  const nElem = elemPiece.length;
  const at = index ? (i) => index[i] : (i) => i;
  let n = 0;
  for (let e = 0; e < nElem; e++) if (keep.has(elemPiece[e])) n++;
  const out = new Uint32Array(n * per);
  let o = 0;
  for (let e = 0; e < nElem; e++) {
    if (!keep.has(elemPiece[e])) continue;
    for (let k = 0; k < per; k++) out[o++] = at(e * per + k);
  }
  return out;
}

/** The distinct edges of triangles `index` (welded), as vertex index pairs: a wireframe without doubled lines. */
export function edgePairs(index, welded) {
  const nTri = Math.floor(index.length / 3);
  const t = edgeTable(nTri * 3);
  const seen = new Uint8Array(t.size);
  const out = [];
  for (let f = 0; f < nTri; f++) {
    for (let k = 0; k < 3; k++) {
      const i = index[f * 3 + k], j = index[f * 3 + ((k + 1) % 3)];
      const a = welded[i], b = welded[j];
      if (a === b) continue;
      const s = a < b ? t.slot(a, b) : t.slot(b, a);
      if (seen[s]) continue;
      seen[s] = 1;
      out.push(i, j);
    }
  }
  return Uint32Array.from(out);
}
