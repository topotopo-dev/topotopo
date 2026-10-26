// Texture coordinate conventions, in one place.
//
// TopoTopo (like Houdini and OpenGL): v points up. uv (0, 0) is the bottom-left of an image and (0, 1) its top-left;
// image row 0 (the first row in memory and in a PNG) is the top, at v = 1.
// glTF TEXCOORD_n: v points down. (0, 0) is the top-left of the image, so glTF v = 1 - TopoTopo v.
//
// Tangent space follows from this. TopoTopo's tangent is dP/du and its bitangent dP/dv points towards image "up",
// which is the green-up (OpenGL) normal map convention glTF uses. MikkTSpace fed TopoTopo uvs therefore returns the
// handedness glTF expects (bitangent = w · cross(N, T)) without the sign flip a v-down caller (three.js reading glTF
// uvs) applies.

/** TopoTopo v ↔ glTF v (the mapping is its own inverse). */
export const gltfV = (v: number) => 1 - v;

/** Continuous image row coordinate (0 = top edge of row 0, h = bottom edge of the last row) of TopoTopo v. */
export const imageRowOfV = (v: number, h: number) => (1 - v) * h;
