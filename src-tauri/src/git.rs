//! Optional git initialization for freshly created workspaces.
//!
//! The init wizard offers a "put this under version control" checkbox, shown
//! only when git is available. All operations here are best-effort: a failing
//! git step never fails workspace creation ??the workspace is fully usable
//! without git.

use std::path::Path;
use std::process::Command;

/// The only place a `git` process is constructed, so the no-console-window
/// flag is applied exactly once ??see [`nextup_core::process`] for why a raw
/// `Command` here flashes a window in the packaged app.
fn git_command() -> Command {
    let mut cmd = Command::new("git");
    nextup_core::process::hide_console(&mut cmd);
    cmd
}

/// True if a usable `git` is on PATH.
pub fn git_available() -> bool {
    git_command()
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// True if `root` already lives inside a git work tree ??initializing there
/// would create a confusing nested repo, so the caller should skip.
fn already_versioned(root: &Path) -> bool {
    git_command()
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success() && o.stdout.starts_with(b"true"))
        .unwrap_or(false)
}

fn run(root: &Path, args: &[&str]) -> bool {
    git_command()
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Initialize a git repo at `root` and make one initial commit. Best-effort
/// and idempotent-ish: skips silently if git is unavailable or the folder is
/// already inside a work tree. Returns whether a repo was initialized here.
pub fn init_repo(root: &Path) -> bool {
    if !git_available() || already_versioned(root) {
        return false;
    }
    if !run(root, &["init"]) {
        return false;
    }
    let _ = run(root, &["add", "-A"]);
    let msg = "chore: initialise Agent NextUp workspace";
    // A configured user commits under their own identity; only if that fails
    // (no user.name/email set) do we retry under a neutral fallback so the
    // initial commit still lands.
    if !run(root, &["commit", "-m", msg]) {
        let _ = run(
            root,
            &[
                "-c",
                "user.name=Agent NextUp",
                "-c",
                "user.email=nextup@localhost",
                "commit",
                "-m",
                msg,
            ],
        );
    }
    true
}

#[cfg(test)]
mod tests {
    /// Every git invocation must come from `git_command`, which is the one
    /// thing applying `CREATE_NO_WINDOW`. A raw constructor anywhere else in
    /// this file is a console window flashing on every wizard open ??and only
    /// a packaged Windows build shows it, so guard the source rather than wait
    /// to see it (G057).
    ///
    /// The needle is split across two literals so this assertion does not
    /// count itself.
    #[test]
    fn every_git_spawn_goes_through_the_windowless_constructor() {
        let source = include_str!("git.rs");
        let needle = concat!("Command::", "new(\"git\")");
        assert_eq!(
            source.matches(needle).count(),
            1,
            "build git commands with git_command(), not a bare Command"
        );
    }
}
