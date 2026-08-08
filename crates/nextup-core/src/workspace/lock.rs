//! Cross-process advisory mutex for workspace mutations.
//!
//! Files-as-truth means more than one process may mutate the same workspace:
//! the GUI app and an external `nextup-mcp` server spawned by a coding agent
//! (nextup_docs/06). Individual JSON writes are atomic (temp+rename), but
//! read-modify-write sequences are not: `next_id()` scans then writes, and
//! context/workflow updates are load→change→save. Every mutating entry point
//! in `ops.rs` / `workflow.rs` therefore runs inside [`with_mutation_lock`].
//!
//! Rules:
//! - The lock guards a single mutation (milliseconds); never hold it across
//!   user interaction or network calls.
//! - Locked entry points must not call each other — a second acquire from the
//!   same process blocks until the timeout and fails the operation.
//! - Read paths stay lock-free: they only ever observe old-or-new files.
//!
//! The lock file lives at `.nextup/.mutex`; the leading dot keeps it out of the
//! watcher whitelist and it is never deleted (advisory OS locks, no content).
//!
//! # App-level stores
//!
//! [`with_app_lock`] guards `~/.nextup/`'s own read-modify-write files
//! (`teams.json`, `registry.json`) with the same primitive at
//! `~/.nextup/.mutex`. Until D116 those had no cross-process protection at all
//! — `teams.rs` held a process-local `Mutex` and `registry.rs` held nothing —
//! because the single-writer contract said only the GUI ever wrote them. prime
//! (nextup_docs/21) gives the hub app-level write access and retires that
//! contract, and the failure it removes is silent: two processes load the same
//! snapshot and the second save drops the first's change, so the edge just
//! comes back on reload as if the UI had glitched.
//!
//! **One lock covers the whole directory**, not one per file: `create_member`
//! (21 §6) touches the registry and the team graph in a single logical step.
//!
//! ⚠️ **The two locks must never nest.** `team_add_member` mints a workspace id
//! and syncs a module (both take that workspace's lock) *before* reaching the
//! team-graph write, so the app lock is taken where the process-local one used
//! to be — inside each mutating fn, never wrapped around a caller that also
//! touches a workspace. Hoisting it outward is what would create the cycle.

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::error::{NextUpError, Result};
use crate::workspace::layout::WorkspacePaths;

const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_DELAY: Duration = Duration::from_millis(20);

/// Run `f` while holding the workspace's exclusive mutation lock. The OS
/// releases the lock even if the process crashes, so a stale lock file can
/// never wedge the workspace.
pub fn with_mutation_lock<T>(paths: &WorkspacePaths, f: impl FnOnce() -> Result<T>) -> Result<T> {
    hold(&paths.mutex_file(), "workspace mutation lock", f)
}

/// Run `f` while holding the exclusive lock for the app-level store directory
/// that `store_path` lives in (so `~/.nextup/teams.json` locks
/// `~/.nextup/.mutex`).
///
/// Keyed on the *directory* rather than a fixed home path so tests get their
/// own lock per tempdir — a fixed `~/.nextup/.mutex` would serialize the whole
/// test suite through the developer's real home directory.
pub fn with_app_lock<T>(store_path: &Path, f: impl FnOnce() -> Result<T>) -> Result<T> {
    hold(&app_mutex_for(store_path), "app-level store lock", f)
}

/// The lock file guarding the app-level store `store_path` belongs to.
fn app_mutex_for(store_path: &Path) -> PathBuf {
    store_path.parent().unwrap_or(Path::new(".")).join(".mutex")
}

fn hold<T>(lock_path: &Path, label: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new().create(true).read(true).write(true).open(lock_path)?;
    let mut lock = fd_lock::RwLock::new(file);

    let started = Instant::now();
    loop {
        match lock.try_write() {
            Ok(guard) => {
                let out = f();
                drop(guard);
                return out;
            }
            Err(_) if started.elapsed() < ACQUIRE_TIMEOUT => std::thread::sleep(RETRY_DELAY),
            Err(_) => {
                return Err(NextUpError::Workspace(format!(
                    "could not acquire the {label} within {}s — \
                     another process may be stuck mid-operation",
                    ACQUIRE_TIMEOUT.as_secs()
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// A second *handle* on the lock file is what a second *process* has, so
    /// this is the cross-process property under test — the process-local
    /// `Mutex` that guarded `teams.json` until D116 would let both through.
    #[test]
    fn a_separate_handle_is_excluded_while_the_app_lock_is_held() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("teams.json");
        let mutex = dir.path().join(".mutex");
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        std::thread::scope(|scope| {
            scope.spawn(move || {
                with_app_lock(&store, || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap(); // stay inside the critical section
                    Ok(())
                })
                .unwrap();
            });

            entered_rx.recv().unwrap();
            let probe = OpenOptions::new().read(true).write(true).open(&mutex).unwrap();
            let mut probe = fd_lock::RwLock::new(probe);
            assert!(probe.try_write().is_err(), "the other process must be locked out");
            release_tx.send(()).unwrap();
        });

        // Released on scope exit, even though nobody deleted the lock file.
        let probe = OpenOptions::new().read(true).write(true).open(&mutex).unwrap();
        let mut probe = fd_lock::RwLock::new(probe);
        assert!(probe.try_write().is_ok(), "the lock must not outlive its guard");
    }

    /// One lock per directory, not per file: `create_member` (21 §6) writes the
    /// registry and the team graph as one logical step.
    #[test]
    fn the_app_stores_in_one_directory_share_a_lock() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            app_mutex_for(&dir.path().join("teams.json")),
            app_mutex_for(&dir.path().join("registry.json"))
        );
    }

    #[test]
    fn the_workspace_lock_and_the_app_lock_are_different_files() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        assert_ne!(paths.mutex_file(), app_mutex_for(&dir.path().join("teams.json")));
    }
}
