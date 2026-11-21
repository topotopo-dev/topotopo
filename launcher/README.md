# Windows launcher

`topotopo-open.exe` is what Windows runs when a package (`.topo`) or a workspace (`.topows`) is double-clicked. It is a
Windows-subsystem program, so it never has a console window, and it starts TopoTopo's command line without one:

```
topotopo-open.exe [--node <node.exe>] [<file or folder>...]
```

runs

```
"<node.exe>" "<TopoTopo>\dist\cli.js" open ["<absolute path>"...]
```

with the TopoTopo folder as the working directory and the console-less creation flag (`CREATE_NO_WINDOW`).
`<TopoTopo>` is the npm package the exe ships in (`<TopoTopo>\launcher\win32-x64\topotopo-open.exe`); a source checkout
(`src\cli.ts` is there, the npm package has no `src\`) runs `src\cli.ts`, even beside a `dist\` left from an earlier
build. With no path it runs `open` alone. A relative path is made absolute first.

Node.js, in this order:

1. `--node <path>`: `topotopo setup` writes the Node.js it runs with into the file links.
2. `node.exe` beside the npm prefix the package is installed in (`<prefix>\node.exe` for
   `<prefix>\node_modules\topotopo`), where npm's own command shims look first.
3. The Node.js installer's `InstallPath` (`HKCU`, then `HKLM\SOFTWARE\Node.js`).
4. The first `node.exe` on `PATH`.

When TopoTopo cannot be started (no Node.js, no command line beside the launcher) or `open` exits with an error, a
message box says why, with the last lines `open` wrote to stderr (or stdout). The launcher's exit code is `open`'s. It
waits for `open` to exit, not for the pipes: a server that `open` leaves running does not hold it. For tests,
`TOPOTOPO_LAUNCHER_QUIET` sends the message to stderr instead of a message box; `--version` prints the fingerprint of
the sources it was built from.

## Building

The built exe is committed (`win32-x64/topotopo-open.exe`), so installing TopoTopo and `npm test` need no Rust. After a
change here, on Windows with Rust and the Visual Studio C++ build tools:

```powershell
npm run launcher:build
node test/launcher.ts
```

and commit the exe with the change. `npm test` (`test/launcher.ts`) fails while the committed exe was built from other
sources, is not a GUI-subsystem x64 program, or imports anything but Windows system DLLs (the C runtime is linked in).
CI builds it from source on Windows and runs the same checks on that build. The build is reproducible: the same
sources and toolchain give the same bytes.
