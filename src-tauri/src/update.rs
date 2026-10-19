//! The app side of in-app updates (D144). The updater plugin does the
//! checking, downloading, signature verification and installing; what lives
//! here is the part it cannot know about this app:
//!
//! - **The portable build must not take it.** The plugin picks the installer
//!   matching the bundle the app was installed from, and falls back to the
//!   platform's generic entry when it cannot tell — which for the Windows
//!   portable zip means running the NSIS installer and leaving a second,
//!   installed copy beside the portable one. `make-portable.mjs` drops a
//!   marker file next to the exe; finding it routes the user to the download
//!   page instead.
//! - **The hub has to be free on Windows.** The installer replaces
//!   `nextup-mcp.exe` beside the app, and an agent CLI connected to a
//!   workspace keeps that file mapped. Windows refuses to overwrite a running
//!   image, so an install over a busy hub fails halfway. Probed here, before
//!   the app exits, while the user can still do something about it.
//! - **Relaunch on macOS goes through `terminate:`.** Restarting means
//!   quitting, and quitting the packaged mac app any other way crashes it
//!   (G065).

use std::path::PathBuf;

use serde::Serialize;

/// Sits beside the portable exe (`agent-nextup.portable`, written by
/// `scripts/make-portable.mjs`). Its content is a note for whoever finds it;
/// only its presence matters.
const PORTABLE_MARKER_EXT: &str = "portable";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreflight {
    /// Running from the Windows portable zip: in-app install is off.
    pub portable: bool,
    /// The hub beside the app is held open by another process (Windows only;
    /// always false elsewhere, where replacing a running binary is fine).
    pub hub_busy: bool,
    /// Embedded terminal sessions still running — installing ends them.
    pub running_terminals: usize,
}

pub fn is_portable() -> bool {
    std::env::current_exe()
        .map(|exe| exe.with_extension(PORTABLE_MARKER_EXT).is_file())
        .unwrap_or(false)
}

/// The hub the installer will overwrite: the one beside the app, never a PATH
/// fallback (that copy is not ours to replace).
fn bundled_hub() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let hub = exe.parent()?.join(crate::mcp_deploy::hub_file_name());
    hub.is_file().then_some(hub)
}

/// Whether something holds the bundled hub open. A running executable on
/// Windows is mapped without write sharing, so asking for write access fails
/// with a sharing violation (os error 32) for exactly as long as any process
/// runs it. Opening for write does not truncate or create — nothing changes
/// on disk either way.
#[cfg(windows)]
pub fn hub_busy() -> bool {
    bundled_hub().is_some_and(|hub| image_in_use(&hub))
}

#[cfg(windows)]
fn image_in_use(path: &std::path::Path) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    match std::fs::OpenOptions::new().write(true).open(path) {
        Ok(_) => false,
        Err(e) => e.raw_os_error() == Some(ERROR_SHARING_VIOLATION),
    }
}

#[cfg(not(windows))]
pub fn hub_busy() -> bool {
    let _ = bundled_hub;
    false
}

/// Start the freshly installed app again once this one is gone, then quit the
/// way the platform tolerates. Windows never reaches here — its installer
/// exits this process and relaunches by itself.
pub fn relaunch(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // .../Agent NextUp.app/Contents/MacOS/agent-nextup → the bundle, which
        // is where the updater put the new version.
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let bundle = exe
            .ancestors()
            .nth(3)
            .filter(|p| p.extension().is_some_and(|e| e == "app"))
            .ok_or("not running from an .app bundle")?
            .to_path_buf();
        // `open` from a detached shell after a beat, so it lands after this
        // process has terminated rather than activating the old instance.
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", "sleep 1; open \"$1\"", "sh"]).arg(&bundle);
        nextup_core::process::hide_console(&mut cmd);
        cmd.spawn().map_err(|e| e.to_string())?;
        app.run_on_main_thread(|| {
            use objc2_app_kit::NSApplication;
            use objc2_foundation::MainThreadMarker;
            let Some(mtm) = MainThreadMarker::new() else { return };
            NSApplication::sharedApplication(mtm).terminate(None);
        })
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.restart();
    }
}

#[cfg(test)]
mod tests {
    /// The probe has to tell a running executable from an idle one — that is
    /// the whole difference between an install that works and one that fails
    /// halfway. Run a copy of a system tool and ask while it runs and after.
    #[cfg(windows)]
    #[test]
    fn a_running_executable_reads_as_in_use_and_a_stopped_one_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("probe-target.exe");
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        std::fs::copy(std::path::Path::new(&system).join(r"System32\ping.exe"), &exe).unwrap();
        assert!(!super::image_in_use(&exe), "not started yet");

        let mut cmd = std::process::Command::new(&exe);
        cmd.args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null());
        nextup_core::process::hide_console(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let busy = super::image_in_use(&exe);
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(busy, "a running image must read as in use");
        assert!(!super::image_in_use(&exe), "released once the process is gone");
    }

    #[test]
    fn the_portable_marker_is_what_make_portable_writes() {
        // The script names the marker after the exe; if either side renames
        // it, the portable build silently gains an install button that would
        // install a second copy.
        let script = include_str!("../../scripts/make-portable.mjs");
        assert!(
            // Quoted, so a renamed marker that merely starts the same way fails too.
            script.contains(&format!("\"agent-nextup.{}\"", super::PORTABLE_MARKER_EXT)),
            "make-portable.mjs must write agent-nextup.{} beside the exe",
            super::PORTABLE_MARKER_EXT
        );
    }
}
