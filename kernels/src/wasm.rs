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

fn option_number(options: &JsValue, name: &str, default: f64) -> Result<f64, JsValue> {
    let value = Reflect::get(options, &JsValue::from_str(name))?;
    if value.is_undefined() {
        return Ok(default);
    }
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| JsValue::from_str(&format!("remesh_quad {name} must be a finite number")))
}
fn option_integer(options: &JsValue, name: &str, default: u32) -> Result<u32, JsValue> {
    let value = option_number(options, name, f64::from(default))?;
    if value < 0.0 || value > f64::from(u32::MAX) || value.fract() != 0.0 {
        return Err(JsValue::from_str(&format!(
            "remesh_quad {name} must be a nonnegative u32 integer"
        )));
    }
    Ok(value as u32)
}
fn option_bool(options: &JsValue, name: &str, default: bool) -> Result<bool, JsValue> {
    let value = Reflect::get(options, &JsValue::from_str(name))?;
    if value.is_undefined() {
        return Ok(default);
    }
    value
        .as_bool()
        .ok_or_else(|| JsValue::from_str(&format!("remesh_quad {name} must be a boolean")))
}
fn option_edges(options: &JsValue, name: &str) -> Result<Vec<u32>, JsValue> {
    let value = Reflect::get(options, &JsValue::from_str(name))?;
    if value.is_undefined() {
        return Ok(Vec::new());
    }
    if !value.is_instance_of::<Uint32Array>() {
        return Err(JsValue::from_str(&format!(
            "remesh_quad {name} must be a Uint32Array of point pairs"
        )));
    }
    let array: Uint32Array = value.unchecked_into();
    if array.length() > 12_000_000 {
        return Err(JsValue::from_str(
            "remesh_quad constraint array is too large",
        ));
    }
    Ok(array.to_vec())
}

#[wasm_bindgen]
pub fn remesh_quad(positions: &[f64], tris: &[u32], options: JsValue) -> Result<Object, JsValue> {
    let options = if options.is_undefined() {
        Object::new().into()
    } else {
        options
    };
    if !options.is_object() || options.is_null() {
        return Err(JsValue::from_str("remesh_quad options must be an object"));
    }
    let opts = crate::remesh_quad::RemeshOptions {
        target_edge_length: option_number(&options, "target_length", 0.0)?,
        target_face_count: option_integer(&options, "target_faces", 0)?,
        quad_only: option_bool(&options, "quad_only", false)?,
        cleanup: option_bool(&options, "cleanup", true)?,
        feature_angle: option_number(&options, "feature_angle", std::f64::consts::FRAC_PI_4)?,
        align_boundaries: option_bool(&options, "align_boundaries", true)?,
        smooth_iterations: option_integer(&options, "smooth_iterations", 8)?,
        preserve_sharp: option_bool(&options, "preserve_sharp", true)?,
        crease_edges: option_edges(&options, "crease_edges")?,
        direction_edges: option_edges(&options, "direction_edges")?,
        locked_edges: option_edges(&options, "locked_edges")?,
        max_faces: option_integer(&options, "max_faces", 1_000_000)?,
    };
    let m = crate::remesh_quad::remesh_quad(positions, tris, &opts).map_err(error)?;
    let o = Object::new();
    put(&o, "positions", Float64Array::from(m.positions.as_slice()))?;
    put(&o, "prim_start", Uint32Array::from(m.prim_start.as_slice()))?;
    put(
        &o,
        "vertex_point",
        Uint32Array::from(m.vertex_point.as_slice()),
    )?;
    put(
        &o,
        "source_triangle",
        Uint32Array::from(m.source_triangle.as_slice()),
    )?;
    put(
        &o,
        "barycentric",
        Float64Array::from(m.barycentric.as_slice()),
    )?;
    put(&o, "src_prim", Int32Array::from(m.src_prim.as_slice()))?;
    let count = m.source_triangle.len();
    let mut src_point = vec![-1; count];
    let mut blend_offset = Vec::with_capacity(count + 1);
    let mut blend_index = Vec::with_capacity(count * 3);
    let mut blend_weight = Vec::with_capacity(count * 3);
    blend_offset.push(0);
    for (i, source) in m.source_triangle.iter().enumerate() {
        let triangle = &tris[*source as usize * 3..*source as usize * 3 + 3];
        let weights = &m.barycentric[i * 3..i * 3 + 3];
        for k in 0..3 {
            let p = triangle[k] as usize;
            if weights[k] == 1.0 && m.positions[i * 3..i * 3 + 3] == positions[p * 3..p * 3 + 3] {
                src_point[i] = p as i32;
                break;
            }
        }
        if src_point[i] < 0 {
            blend_index.extend_from_slice(triangle);
            blend_weight.extend(weights.iter().map(|v| *v as f32));
        }
        blend_offset.push(blend_index.len() as u32);
    }
    put(&o, "src_point", Int32Array::from(src_point.as_slice()))?;
    put(
        &o,
        "blend_offset",
        Uint32Array::from(blend_offset.as_slice()),
    )?;
    put(&o, "blend_index", Uint32Array::from(blend_index.as_slice()))?;
    put(
        &o,
        "blend_weight",
        Float32Array::from(blend_weight.as_slice()),
    )?;
    put(
        &o,
        "src_vertex",
        Int32Array::from(vec![-1; m.vertex_point.len()].as_slice()),
    )?;
    let q = Object::new();
    put(&q, "quad_fraction", m.quality.quad_fraction)?;
    put(&q, "singularities", m.quality.singularities)?;
    put(&q, "irregular_fraction", m.quality.irregular_fraction)?;
    put(&q, "edge_length_min", m.quality.edge_length_min)?;
    put(&q, "edge_length_mean", m.quality.edge_length_mean)?;
    put(&q, "edge_length_max", m.quality.edge_length_max)?;
    put(&q, "planarity_mean", m.quality.planarity_mean)?;
    put(&q, "planarity_max", m.quality.planarity_max)?;
    put(&q, "target_edge_length", m.quality.target_edge_length)?;
    put(&o, "quality", q)?;
    Ok(o)
}

// Grid objects only contain scalar metadata and flat typed arrays. Copies detach
// Rust ownership from JS so input arrays are never mutated by an operation.
fn grid(value: &JsValue) -> Result<crate::sdf::Grid, JsValue> {
    let get = |key: &str| Reflect::get(value, &JsValue::from_str(key));
    let dims = get("dims")?;
    let origin = get("origin")?;
    let values = get("values")?;
    if !dims.is_instance_of::<Uint32Array>()
        || !origin.is_instance_of::<Float64Array>()
        || !values.is_instance_of::<Float32Array>()
    {
        return Err(JsValue::from_str(
            "grid requires Uint32Array dims, Float64Array origin and Float32Array values",
        ));
    }
    // The type checks above permit borrowing the JS views without constructing
    // duplicate typed arrays; validate metadata before the one Rust-owned copy.
    let dims: Uint32Array = dims.unchecked_into();
    let origin: Float64Array = origin.unchecked_into();
    let values: Float32Array = values.unchecked_into();
    if dims.length() != 3 || origin.length() != 3 || values.length() > 64 * 1024 * 1024 {
        return Err(JsValue::from_str(
            "grid requires three dimensions/origin coordinates and at most 64M samples",
        ));
    }
    let dims = [dims.get_index(0), dims.get_index(1), dims.get_index(2)];
    let origin = [
        origin.get_index(0),
        origin.get_index(1),
        origin.get_index(2),
    ];
    let voxel = get("voxel")?
        .as_f64()
        .ok_or_else(|| JsValue::from_str("grid voxel must be a number"))?;
    let count = crate::sdf::layout_len(dims, origin, voxel).map_err(error)?;
    if values.length() as usize != count {
        return Err(JsValue::from_str(
            "grid values length must equal dims[0] * dims[1] * dims[2]",
        ));
    }
    let g = crate::sdf::Grid {
        dims,
        origin,
        voxel,
        values: values.to_vec(),
    };
    g.validate().map_err(error)?;
    Ok(g)
}
fn grid_object(g: crate::sdf::Grid) -> Result<Object, JsValue> {
    let o = Object::new();
    put(&o, "dims", Uint32Array::from(g.dims.as_slice()))?;
    put(&o, "origin", Float64Array::from(g.origin.as_slice()))?;
    put(&o, "voxel", g.voxel)?;
    put(&o, "values", Float32Array::from(g.values.as_slice()))?;
    Ok(o)
}

#[wasm_bindgen]
pub fn sdf_from_mesh(
    positions: &[f64],
    tris: &[u32],
    voxel: f64,
    band: f64,
    padding: f64,
    fill: bool,
) -> Result<Object, JsValue> {
    grid_object(
        crate::sdf::sdf_from_mesh(positions, tris, voxel, band, padding, fill).map_err(error)?,
    )
}
#[wasm_bindgen]
pub fn grid_csg(a: JsValue, b: JsValue, op: &str, k: f64) -> Result<Object, JsValue> {
    grid_object(crate::sdf::grid_csg(&grid(&a)?, &grid(&b)?, op, k).map_err(error)?)
}
#[wasm_bindgen]
pub fn grid_offset(g: JsValue, d: f64) -> Result<Object, JsValue> {
    grid_object(crate::sdf::grid_offset(&grid(&g)?, d).map_err(error)?)
}
#[wasm_bindgen]
pub fn grid_blur(g: JsValue, radius: f64) -> Result<Object, JsValue> {
    if !radius.is_finite() || !(0.0..=1024.0).contains(&radius) || radius.fract() != 0.0 {
        return Err(JsValue::from_str(
            "grid_blur radius must be an integer in 0..1024",
        ));
    }
    grid_object(crate::sdf::grid_blur(&grid(&g)?, radius as u32).map_err(error)?)
}
#[wasm_bindgen]
pub fn grid_dilate(g: JsValue, d: f64) -> Result<Object, JsValue> {
    grid_object(crate::sdf::grid_dilate(&grid(&g)?, d).map_err(error)?)
}
#[wasm_bindgen]
pub fn grid_erode(g: JsValue, d: f64) -> Result<Object, JsValue> {
    grid_object(crate::sdf::grid_erode(&grid(&g)?, d).map_err(error)?)
}
#[wasm_bindgen]
pub fn grid_resample(g: JsValue, voxel: f64) -> Result<Object, JsValue> {
    grid_object(crate::sdf::grid_resample(&grid(&g)?, voxel).map_err(error)?)
}
#[wasm_bindgen]
pub fn dual_contour(
    g: JsValue,
    iso: f64,
    qef_tolerance: f64,
    sharp: bool,
    clamp_to_cell: bool,
) -> Result<Object, JsValue> {
    let m = crate::dual_contour::dual_contour(&grid(&g)?, iso, qef_tolerance, sharp, clamp_to_cell)
        .map_err(error)?;
    let o = Object::new();
    put(&o, "positions", Float64Array::from(m.positions.as_slice()))?;
    put(&o, "prim_start", Uint32Array::from(m.prim_start.as_slice()))?;
    put(
        &o,
        "vertex_point",
        Uint32Array::from(m.vertex_point.as_slice()),
    )?;
    put(&o, "cell_index", Uint32Array::from(m.cell_index.as_slice()))?;
    Ok(o)
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
