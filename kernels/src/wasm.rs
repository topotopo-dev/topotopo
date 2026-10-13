use js_sys::{
    Array, Float32Array, Float64Array, Int32Array, Object, Reflect, Uint8Array, Uint32Array,
};
use wasm_bindgen::prelude::*;

fn holes(value: Array) -> Result<Vec<Vec<f64>>, JsValue> {
    value
        .iter()
        .enumerate()
        .map(|(i, v)| {
            if !v.is_instance_of::<Float64Array>() {
                return Err(JsValue::from_str(&format!(
                    "hole {i} must be a Float64Array"
                )));
            }
            Ok(Float64Array::new(&v).to_vec())
        })
        .collect()
}
fn put(o: &Object, key: &str, value: impl Into<JsValue>) -> Result<(), JsValue> {
    Reflect::set(o, &JsValue::from_str(key), &value.into()).map(|_| ())
}
fn error(e: String) -> JsValue {
    JsValue::from_str(&e)
}
fn provenance(o: &Object, p: &crate::Provenance) -> Result<(), JsValue> {
    put(o, "src_point", Int32Array::from(p.src_point.as_slice()))?;
    put(
        o,
        "blend_offset",
        Uint32Array::from(p.blend_offset.as_slice()),
    )?;
    put(
        o,
        "blend_index",
        Uint32Array::from(p.blend_index.as_slice()),
    )?;
    put(
        o,
        "blend_weight",
        Float32Array::from(p.blend_weight.as_slice()),
    )?;
    put(o, "src_prim", Int32Array::from(p.src_prim.as_slice()))?;
    put(o, "src_vertex", Int32Array::from(p.src_vertex.as_slice()))?;
    Ok(())
}

#[wasm_bindgen]
pub fn straight_skeleton(
    outer: &[f64],
    hole_arrays: Array,
    weights: Option<Vec<f64>>,
) -> Result<Object, JsValue> {
    let s = crate::skeleton(
        outer,
        &holes(hole_arrays)?,
        weights.as_deref().unwrap_or(&[]),
    )
    .map_err(error)?;
    let o = Object::new();
    put(&o, "arcs", Float64Array::from(s.arcs.as_slice()))?;
    put(&o, "arc_kind", Uint8Array::from(s.arc_kind.as_slice()))?;
    put(&o, "vertices", Float64Array::from(s.vertices.as_slice()))?;
    put(&o, "face_start", Uint32Array::from(s.face_start.as_slice()))?;
    put(
        &o,
        "face_vertex_index",
        Uint32Array::from(s.face_vertex_index.as_slice()),
    )?;
    put(&o, "face_edge", Uint32Array::from(s.face_edge.as_slice()))?;
    put(&o, "node_time", Float64Array::from(s.node_time.as_slice()))?;
    provenance(&o, &s.provenance)?;
    Ok(o)
}
#[wasm_bindgen]
pub fn offset_polygon(outer: &[f64], hole_arrays: Array, distance: f64) -> Result<Object, JsValue> {
    let s = crate::offset(outer, &holes(hole_arrays)?, distance).map_err(error)?;
    let o = Object::new();
    put(&o, "vertices", Float64Array::from(s.vertices.as_slice()))?;
    put(
        &o,
        "polygon_start",
        Uint32Array::from(s.polygon_start.as_slice()),
    )?;
    put(
        &o,
        "polygon_vertex_index",
        Uint32Array::from(s.polygon_vertex_index.as_slice()),
    )?;
    put(
        &o,
        "polygon_hole",
        Uint8Array::from(s.polygon_hole.as_slice()),
    )?;
    provenance(&o, &s.provenance)?;
    Ok(o)
}
#[wasm_bindgen]
pub fn roof(
    outer: &[f64],
    hole_arrays: Array,
    pitch: &[f64],
    height_cap: Option<f64>,
) -> Result<Object, JsValue> {
    let s = crate::roof_mesh(outer, &holes(hole_arrays)?, pitch, height_cap).map_err(error)?;
    let o = Object::new();
    put(&o, "vertices", Float64Array::from(s.vertices.as_slice()))?;
    put(&o, "face_start", Uint32Array::from(s.face_start.as_slice()))?;
    put(
        &o,
        "face_vertex_index",
        Uint32Array::from(s.face_vertex_index.as_slice()),
    )?;
    put(&o, "face_edge", Uint32Array::from(s.face_edge.as_slice()))?;
    provenance(&o, &s.provenance)?;
    Ok(o)
}
