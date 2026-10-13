//! Opt-in pass timings. Disabled builds erase the clock, counters and output.
//! Profile builds use a monotonic clock on both native and WASM targets.

#[cfg(feature = "profile")]
mod enabled {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen::prelude::*;

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = performance, js_name = now)]
        fn performance_now() -> f64;
        #[wasm_bindgen(js_namespace = console, js_name = log)]
        fn log(value: &str);
    }

    pub struct Profile {
        name: &'static str,
        #[cfg(not(target_arch = "wasm32"))]
        origin: std::time::Instant,
        last: f64,
        entries: Vec<(&'static str, f64, u64)>,
    }

    impl Profile {
        pub fn new(name: &'static str) -> Self {
            let mut result = Self {
                name,
                #[cfg(not(target_arch = "wasm32"))]
                origin: std::time::Instant::now(),
                last: 0.0,
                entries: Vec::with_capacity(16),
            };
            result.reset();
            result
        }

        fn now(&self) -> f64 {
            #[cfg(target_arch = "wasm32")]
            {
                performance_now()
            }
            #[cfg(not(target_arch = "wasm32"))]
            {
                self.origin.elapsed().as_secs_f64() * 1000.0
            }
        }

        /// Restart a sampled interval without attributing the intervening work.
        pub fn reset(&mut self) {
            self.last = self.now();
        }

        pub fn mark(&mut self, label: &'static str) {
            let now = self.now();
            let elapsed = now - self.last;
            self.last = now;
            if let Some(entry) = self.entries.iter_mut().find(|v| v.0 == label) {
                entry.1 += elapsed;
                entry.2 += 1;
            } else {
                self.entries.push((label, elapsed, 1));
            }
        }

        pub fn finish(self) {
            let entries = self
                .entries
                .iter()
                .map(|(label, ms, count)| {
                    format!("\"{label}\":{{\"ms\":{ms:.6},\"count\":{count}}}")
                })
                .collect::<Vec<_>>()
                .join(",");
            let message = format!("{{\"profile\":\"{}\",\"passes\":{{{entries}}}}}", self.name);
            #[cfg(target_arch = "wasm32")]
            log(&message);
            #[cfg(not(target_arch = "wasm32"))]
            println!("{message}");
        }
    }
}

#[cfg(feature = "profile")]
pub use enabled::Profile;

#[cfg(not(feature = "profile"))]
pub struct Profile;

#[cfg(not(feature = "profile"))]
impl Profile {
    #[inline(always)]
    pub fn new(_: &'static str) -> Self {
        Self
    }
    #[inline(always)]
    pub fn mark(&mut self, _: &'static str) {}
    #[inline(always)]
    pub fn finish(self) {}
}
