//! topotopo-open: the no-window Windows launcher behind a double-clicked package (.topo) or workspace (.topows).
//!
//!   topotopo-open.exe [--node <node.exe>] [<file or folder>...]
//!
//! runs, with no console window,
//!
//!   "<node.exe>" "<TopoTopo>\dist\cli.js" open ["<absolute path>"...]
//!
//! in the TopoTopo folder, where <TopoTopo> is the npm package this exe ships in (it lives in
//! <TopoTopo>\launcher\win32-x64\). A source checkout (src\cli.ts is there; the npm package has no src\) runs
//! src\cli.ts, even beside a dist\ left from an earlier build, so it never runs older code than its source. Node.js is,
//! in this order:
//! the --node path (`topotopo setup` writes the node it runs with into the file links), the node.exe beside the npm
//! prefix the package is installed in (where npm's own command shims look first), the Node.js installer's InstallPath
//! in the registry, then the first node.exe on PATH. When TopoTopo cannot be started, or `open` fails, a message box
//! says why (TOPOTOPO_LAUNCHER_QUIET set: the message goes to stderr only, for tests). The exit code is open's.
#![windows_subsystem = "windows"]

use std::ffi::{OsStr, OsString, c_void};
use std::io::Read;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use std::{env, process, ptr};

/// The process gets a console without a window: node.exe is a console program, and without this flag Windows would
/// open a console window for it.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MB_ICONERROR: u32 = 0x0000_0010;
const MB_SETFOREGROUND: u32 = 0x0001_0000;
const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
const HKEY_LOCAL_MACHINE: isize = 0x8000_0002_u32 as i32 as isize;
const RRF_RT_REG_SZ: u32 = 0x0000_0002;
const SOURCE: &str = env!("LAUNCHER_SOURCE");

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(hwnd: *mut c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn RegGetValueW(key: isize, subkey: *const u16, value: *const u16, flags: u32, kind: *mut u32, data: *mut c_void, size: *mut u32) -> i32;
}

struct Failure {
    message: String,
    code: i32,
}

fn fail(message: String) -> Failure {
    Failure { message, code: 1 }
}

fn main() {
    let code = match run() {
        Ok(()) => 0,
        Err(f) => {
            report(&f.message);
            f.code
        }
    };
    process::exit(code);
}

fn run() -> Result<(), Failure> {
    let mut args = env::args_os().skip(1);
    let mut node: Option<PathBuf> = None;
    let mut paths: Vec<OsString> = Vec::new();
    while let Some(a) = args.next() {
        if paths.is_empty() && a == "--version" {
            println!("topotopo-open {} source {SOURCE}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        if paths.is_empty() && a == "--node" {
            node = Some(args.next().ok_or_else(|| fail("--node needs the path of node.exe".into()))?.into());
            continue;
        }
        paths.push(a);
    }
    // Explorer passes absolute paths; a relative one (typed in a terminal) is made absolute here, because open runs in
    // the TopoTopo folder
    let paths: Vec<PathBuf> = paths
        .iter()
        .map(|p| std::path::absolute(p).unwrap_or_else(|_| PathBuf::from(p)))
        .collect();

    let exe = env::current_exe().map_err(|e| fail(format!("TopoTopo could not find where its launcher is: {e}")))?;
    let root = exe
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| fail(format!("The TopoTopo launcher is not inside a TopoTopo install: {}", exe.display())))?
        .to_path_buf();
    let cli = [root.join("src").join("cli.ts"), root.join("dist").join("cli.js")]
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            fail(format!(
                "TopoTopo's command line was not found beside this launcher (expected {}).\n\n\
                 Reinstall TopoTopo (npm install -g topotopo), then run  topotopo setup  again.",
                root.join("dist").join("cli.js").display()
            ))
        })?;
    let node = find_node(node, &root)?;

    let mut child = Command::new(&node)
        .arg(&cli)
        .arg("open")
        .args(&paths)
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| fail(format!("TopoTopo could not start Node.js ({}): {e}", node.display())))?;
    let (stdout, out_reader) = drain(child.stdout.take());
    let (stderr, err_reader) = drain(child.stderr.take());
    let status = child.wait().map_err(|e| fail(format!("TopoTopo stopped unexpectedly: {e}")))?;
    if status.success() {
        return Ok(());
    }

    // a server that open started keeps a copy of the pipes, so their ends are not waited for: whatever arrived
    // within a moment of open's exit is what it said
    let deadline = Instant::now() + Duration::from_millis(1000);
    for reader in [out_reader, err_reader].into_iter().flatten() {
        while !reader.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }
    let said = |buf: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&buf.lock().unwrap_or_else(|e| e.into_inner())).trim().to_string();
    let (err, out) = (said(&stderr), said(&stdout));
    let what = match paths.as_slice() {
        [] => "TopoTopo could not start.".to_string(),
        [one] => format!("TopoTopo could not open {}.", one.file_name().map_or_else(|| one.display().to_string(), |n| n.to_string_lossy().into_owned())),
        _ => "TopoTopo could not open these files.".to_string(),
    };
    let code = status.code().unwrap_or(1);
    let detail = if !err.is_empty() { err } else if !out.is_empty() { out } else { format!("topotopo open stopped with exit code {code} and said nothing.") };
    Err(Failure { message: format!("{what}\n\n{}", tail(&detail, 24, 1800)), code: if code == 0 { 1 } else { code } })
}

/// Node.js: the --node path, the node.exe beside the npm prefix, the Node.js installer's InstallPath, then PATH.
fn find_node(explicit: Option<PathBuf>, root: &Path) -> Result<PathBuf, Failure> {
    if let Some(n) = explicit {
        return if n.is_file() {
            Ok(n)
        } else {
            Err(fail(format!(
                "Node.js was not found at {}.\n\nRun  topotopo setup  again so the file links use the Node.js you have now.",
                n.display()
            )))
        };
    }
    let prefix = root
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("node_modules")))
        .and_then(Path::parent);
    if let Some(n) = prefix.map(|p| p.join("node.exe")).filter(|n| n.is_file()) {
        return Ok(n);
    }
    for key in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        if let Some(n) = registry_string(key, r"SOFTWARE\Node.js", "InstallPath").map(|d| PathBuf::from(d).join("node.exe")).filter(|n| n.is_file()) {
            return Ok(n);
        }
    }
    if let Some(n) = env::var_os("PATH")
        .iter()
        .flat_map(env::split_paths)
        .filter(|d| d.is_absolute())
        .map(|d| d.join("node.exe"))
        .find(|n| n.is_file())
    {
        return Ok(n);
    }
    Err(fail(
        "Node.js was not found. TopoTopo runs on Node.js 22.18 or newer: install it from https://nodejs.org, \
         then run  topotopo setup  again."
            .into(),
    ))
}

/// Reads a pipe on its own thread into a buffer (the first MiB), so neither pipe can fill up and stall open.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> (Arc<Mutex<Vec<u8>>>, Option<JoinHandle<()>>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let reader = pipe.map(|mut p| {
        let buf = Arc::clone(&buf);
        thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = p.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut b = buf.lock().unwrap_or_else(|e| e.into_inner());
                if b.len() < 1 << 20 {
                    b.extend_from_slice(&chunk[..n]);
                }
            }
        })
    });
    (buf, reader)
}

/// The last lines of a text, at most `lines` lines and about `chars` characters, so a message box stays readable.
fn tail(text: &str, lines: usize, chars: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    let mut out = all[all.len().saturating_sub(lines)..].join("\n");
    if out.chars().count() > chars {
        out = format!("...{}", out.chars().skip(out.chars().count() - chars).collect::<String>());
    } else if all.len() > lines {
        out = format!("...\n{out}");
    }
    out
}

fn report(message: &str) {
    eprintln!("{message}");
    if env::var_os("TOPOTOPO_LAUNCHER_QUIET").is_some() {
        return;
    }
    let text = wide(&message.replace('\0', " "));
    let caption = wide("TopoTopo");
    unsafe {
        MessageBoxW(ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_ICONERROR | MB_SETFOREGROUND);
    }
}

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

fn registry_string(key: isize, subkey: &str, value: &str) -> Option<OsString> {
    let (subkey, value) = (wide(subkey), wide(value));
    let mut size: u32 = 0;
    unsafe {
        if RegGetValueW(key, subkey.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, ptr::null_mut(), ptr::null_mut(), &mut size) != 0 || size < 2 {
            return None;
        }
        let mut buf = vec![0u16; (size as usize).div_ceil(2)];
        if RegGetValueW(key, subkey.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size) != 0 {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(OsString::from_wide(&buf[..len]))
    }
}
