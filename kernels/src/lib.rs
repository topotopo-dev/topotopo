//! Deterministic positive-weight straight skeletons by kinetic wavefront propagation.
//!
//! Supporting lines move at fixed speeds. At each earliest contact all simultaneous
//! incidences are resolved together, including overlapping antiparallel segments.
//! No external straight-skeleton implementation is used.

mod skeleton;
pub use skeleton::{Offset, Provenance, Roof, Skeleton, offset, roof_mesh, skeleton};

pub mod dual_contour;
pub mod erosion;
pub mod erosion_droplet;
pub mod erosion_flow;
pub mod remesh_quad;
pub mod sdf;

#[cfg(target_arch = "wasm32")]
mod erosion_wasm;
#[cfg(target_arch = "wasm32")]
mod wasm;
