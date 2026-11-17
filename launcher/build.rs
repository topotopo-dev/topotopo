// Records a fingerprint of the launcher's sources in the exe (`--version` prints it), so a test can tell whether the
// committed launcher/win32-x64/topotopo-open.exe was built from the sources beside it. test/launcher.ts computes the
// same fingerprint: FNV-1a 64 over each file's name, a NUL, its text with CRLF made LF, and a NUL, in this order.
use std::fs;

const SOURCES: [&str; 5] = ["Cargo.toml", "Cargo.lock", "build.rs", "src/main.rs", ".cargo/config.toml"];

fn main() {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for &b in bytes {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for name in SOURCES {
        println!("cargo:rerun-if-changed={name}");
        let text = fs::read_to_string(name).unwrap_or_else(|e| panic!("{name}: {e}")).replace("\r\n", "\n");
        feed(name.as_bytes());
        feed(&[0]);
        feed(text.as_bytes());
        feed(&[0]);
    }
    println!("cargo:rustc-env=LAUNCHER_SOURCE={hash:016x}");
}
