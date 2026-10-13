//! Flat, checked erosion ABI. Empty optional layers mean absent; angles are radians.
use js_sys::{Float32Array, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

fn error(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}
fn options(value: JsValue) -> Result<JsValue, JsValue> {
    if value.is_undefined() {
        return Ok(Object::new().into());
    }
    if value.is_null() || !value.is_object() {
        return Err(error("erosion options must be an object"));
    }
    Ok(value)
}
fn number(o: &JsValue, name: &str, default: f64) -> Result<f64, JsValue> {
    let value = Reflect::get(o, &JsValue::from_str(name))?;
    if value.is_undefined() {
        return Ok(default);
    }
    value
        .as_f64()
        .filter(|x| x.is_finite())
        .ok_or_else(|| error(format!("erosion {name} must be finite")))
}
fn integer(o: &JsValue, name: &str, default: u32) -> Result<u32, JsValue> {
    let value = number(o, name, f64::from(default))?;
    if value < 0.0 || value > f64::from(u32::MAX) || value.fract() != 0.0 {
        return Err(error(format!(
            "erosion {name} must be a nonnegative u32 integer"
        )));
    }
    Ok(value as u32)
}
fn boundary(o: &JsValue) -> Result<bool, JsValue> {
    let value = Reflect::get(o, &JsValue::from_str("boundary"))?;
    if value.is_undefined() {
        return Ok(false);
    }
    match value.as_string().as_deref() {
        Some("closed") => Ok(false),
        Some("open") => Ok(true),
        _ => Err(error("erosion boundary must be closed or open")),
    }
}
fn boolean(o: &JsValue, name: &str, default: bool) -> Result<bool, JsValue> {
    let value = Reflect::get(o, &JsValue::from_str(name))?;
    if value.is_undefined() {
        Ok(default)
    } else {
        value
            .as_bool()
            .ok_or_else(|| error(format!("erosion {name} must be a boolean")))
    }
}
fn optional(layer: &[f32]) -> Option<&[f32]> {
    if layer.is_empty() { None } else { Some(layer) }
}
fn result(r: crate::erosion::ErosionResult) -> Result<Object, JsValue> {
    let o = Object::new();
    for (name, values) in [
        ("height", r.height),
        ("sediment", r.sediment),
        ("debris", r.debris),
        ("flow", r.flow),
        ("water", r.water),
        ("wear", r.wear),
    ] {
        Reflect::set(
            &o,
            &JsValue::from_str(name),
            &Float32Array::from(values.as_slice()),
        )?;
    }
    Ok(o)
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn erode_droplet(
    height: &[f32],
    hardness: &[f32],
    freeze: &[f32],
    w: usize,
    h: usize,
    cell: f64,
    params: JsValue,
    seed: u64,
) -> Result<Object, JsValue> {
    use crate::erosion_droplet::{DropletParams, erode_droplet};
    let o = options(params)?;
    let mut p = DropletParams::default();
    macro_rules! value {
        ($field:ident) => {
            p.$field = number(&o, stringify!($field), p.$field)?;
        };
    }
    p.iterations = integer(&o, "iterations", p.iterations)?;
    p.max_lifetime = integer(&o, "max_lifetime", p.max_lifetime)?;
    value!(rain_density);
    value!(rain_amount);
    value!(erosion_rate);
    value!(deposition_rate);
    value!(sediment_capacity);
    value!(evaporation);
    value!(inertia);
    value!(gravity);
    value!(min_slope);
    value!(erosion_radius);
    value!(talus_angle);
    value!(thermal_rate);
    p.open_boundary = boundary(&o)?;
    if !Reflect::get(&o, &JsValue::from_str("rng_state"))?.is_undefined() {
        p.rng_state = Some(integer(&o, "rng_state", 0)?);
    }
    result(
        erode_droplet(
            height,
            optional(hardness),
            optional(freeze),
            w,
            h,
            cell,
            &p,
            seed,
        )
        .map_err(error)?,
    )
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn erode_pipe(
    height: &[f32],
    hardness: &[f32],
    freeze: &[f32],
    rain: &[f32],
    w: usize,
    h: usize,
    cell: f32,
    params: JsValue,
    seed: u64,
) -> Result<Object, JsValue> {
    use crate::erosion::{PipeParams, erode_pipe};
    let o = options(params)?;
    let mut p = PipeParams::default();
    macro_rules! value {
        ($field:ident) => {
            p.$field = number(&o, stringify!($field), f64::from(p.$field))? as f32;
        };
    }
    p.iterations = integer(&o, "iterations", p.iterations)?;
    value!(rain_amount);
    value!(evaporation);
    value!(sediment_capacity);
    value!(erosion_rate);
    value!(deposition_rate);
    value!(gravity);
    value!(talus_angle);
    value!(thermal_rate);
    value!(time_step);
    value!(stream_power_k);
    value!(stream_power_m);
    value!(stream_power_n);
    p.fill_sinks = boolean(&o, "fill_sinks", false)?;
    let initial_water = Reflect::get(&o, &JsValue::from_str("initial_water"))?;
    if !initial_water.is_undefined() {
        if !initial_water.is_instance_of::<Float32Array>() {
            return Err(error("erosion initial_water must be a Float32Array"));
        }
        p.initial_water = Float32Array::new(&initial_water).to_vec();
    }
    p.open_boundary = boundary(&o)?;
    result(
        erode_pipe(
            height,
            optional(hardness),
            optional(freeze),
            optional(rain),
            w,
            h,
            cell,
            &p,
            seed,
        )
        .map_err(error)?,
    )
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn thermal_erode(
    height: &[f32],
    hardness: &[f32],
    w: usize,
    h: usize,
    cell: f64,
    talus_angle: f64,
    rate: f64,
    iterations: u32,
) -> Result<Object, JsValue> {
    result(
        crate::erosion_droplet::thermal_erode(
            height,
            optional(hardness),
            None,
            w,
            h,
            cell,
            talus_angle,
            rate,
            iterations,
        )
        .map_err(error)?,
    )
}

#[wasm_bindgen]
pub fn flow_accumulation(
    height: &[f32],
    w: usize,
    h: usize,
    cell: f32,
    method: &str,
    fill_sinks: Option<bool>,
) -> Result<Object, JsValue> {
    use crate::erosion_flow::{FlowMethod, flow_accumulation};
    let method = match method {
        "d8" => FlowMethod::D8,
        "dinf" => FlowMethod::Dinf,
        _ => return Err(error("flow method must be d8 or dinf")),
    };
    let r = if fill_sinks.unwrap_or(false) {
        crate::erosion_flow::flow_accumulation_filled(height, w, h, cell, method)
    } else {
        flow_accumulation(height, w, h, cell, method)
    }
    .map_err(error)?;
    let o = Object::new();
    Reflect::set(
        &o,
        &JsValue::from_str("drainage"),
        &Float32Array::from(r.drainage.as_slice()),
    )?;
    Reflect::set(
        &o,
        &JsValue::from_str("direction"),
        &Uint8Array::from(r.direction.as_slice()),
    )?;
    Ok(o)
}

#[wasm_bindgen]
pub fn fill_sinks(
    height: &[f32],
    w: usize,
    h: usize,
    params: JsValue,
    mask: &[f32],
) -> Result<Object, JsValue> {
    let o = options(params)?;
    let epsilon = number(&o, "epsilon", 0.0)?;
    let max_depth = number(&o, "max_depth", 0.0)?;
    if (epsilon != 0.0 && epsilon as f32 == 0.0) || (max_depth != 0.0 && max_depth as f32 == 0.0) {
        return Err(error(
            "fill_sinks: nonzero epsilon and max_depth must be representable as f32",
        ));
    }
    let p = crate::fill_sinks::FillParams {
        epsilon: epsilon as f32,
        max_depth: max_depth as f32,
        write_direction: boolean(&o, "write_direction", false)?,
    };
    let r = crate::fill_sinks::fill_sinks(height, w, h, &p, optional(mask)).map_err(error)?;
    let o = Object::new();
    for (name, values) in [("height", r.height), ("fill", r.fill), ("lake", r.lake)] {
        Reflect::set(
            &o,
            &JsValue::from_str(name),
            &Float32Array::from(values.as_slice()),
        )?;
    }
    if p.write_direction {
        Reflect::set(
            &o,
            &JsValue::from_str("direction"),
            &Uint8Array::from(r.direction.as_slice()),
        )?;
    }
    Ok(o)
}
