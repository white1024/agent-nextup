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

use std::fs::OpenOptions;
use std::time::{Duration, Instant};

use crate::error::{NextUpError, Result};
use crate::workspace::layout::WorkspacePaths;

const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_DELAY: Duration = Duration::from_millis(20);

/// Run `f` while holding the workspace's exclusive mutation lock. The OS
/// releases the lock even if the process crashes, so a stale lock file can
/// never wedge the workspace.
pub fn with_mutation_lock<T>(paths: &WorkspacePaths, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let lock_path = paths.mutex_file();
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new().create(true).read(true).write(true).open(&lock_path)?;
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
                    "could not acquire the workspace mutation lock within {}s — \
                     another process may be stuck mid-operation",
                    ACQUIRE_TIMEOUT.as_secs()
                )))
            }
        }
    }
}
