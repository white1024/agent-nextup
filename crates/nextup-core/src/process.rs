//! How this project spawns child processes.
//!
//! One rule, and it only bites on Windows: **a child we spawn must never get a
//! console window of its own.** The desktop app is built as a GUI-subsystem
//! process (`windows_subsystem = "windows"` in `src-tauri/src/main.rs`), so it
//! owns no console — and Windows hands every console-subsystem child of a
//! console-less parent a brand new console, which flashes on screen for as
//! long as the child runs. Debug builds keep their console and children
//! inherit it, so the flashing is invisible until the app is launched from
//! Explorer: it can only be seen in a packaged build (G057).
//!
//! Nothing is lost by suppressing it. Every child we spawn talks to us over
//! pipes; none of them needs a console to read from or draw on.
//!
//! Not covered here: the embedded terminal's PTY children. Those go through
//! ConPTY, which gives them a pseudoconsole instead of a real one, so no
//! window appears and no flag is needed.

/// `CREATE_NO_WINDOW` — start the child with no console at all.
///
/// Value from the Win32 process creation flags; we spell it out rather than
/// pull in a bindings crate for one number.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply the no-console-window flag to `cmd`. A no-op off Windows.
///
/// Use this instead of reaching for `creation_flags` at the call site — the
/// reasoning above lives in one place, and the guard tests that keep new spawn
/// sites honest have a single symbol to look for.
pub fn hide_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    /// Files that build a `Command` and are allowed not to suppress the
    /// window, with the reason. Keep this list short and justified.
    const EXEMPT: &[(&str, &str)] = &[(
        "src-tauri/src/terminal.rs",
        "the only Command there is a #[cfg(test)] tasklist probe; the real \
         terminal children go through ConPTY",
    )];

    /// A new spawn site is invisible until someone runs the packaged app on
    /// Windows and sees a console flash — the app has no console of its own,
    /// so Windows makes one for every console child. That is a bad feedback
    /// loop to rely on, so require every file that spawns to say, in its own
    /// text, that it dealt with the flag.
    #[test]
    fn every_spawning_file_suppresses_the_console_window() {
        let root = workspace_root();
        let mut sources = Vec::new();
        collect_rs(&root.join("crates"), &mut sources);
        collect_rs(&root.join("src-tauri").join("src"), &mut sources);
        assert!(sources.len() > 10, "source walk found almost nothing: {}", sources.len());

        let mut offenders = Vec::new();
        for path in sources {
            let text = std::fs::read_to_string(&path).expect("read source");
            if !text.contains("Command::new(") {
                continue;
            }
            let rel = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if EXEMPT.iter().any(|(f, _)| *f == rel) {
                continue;
            }
            if !text.contains("hide_console") && !text.contains("creation_flags") {
                offenders.push(rel);
            }
        }
        assert!(
            offenders.is_empty(),
            "these files spawn processes without suppressing the console window \
             — call process::hide_console (or creation_flags for a tokio Command), \
             or add a justified entry to EXEMPT: {offenders:?}"
        );
    }

    /// This crate's manifest dir is `crates/nextup-core`.
    fn workspace_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .expect("crates/nextup-core sits two levels below the workspace root")
            .to_path_buf()
    }

    fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_rs(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
}
