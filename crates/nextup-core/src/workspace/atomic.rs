use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{NextUpError, Result};

/// Bumped once per write so two concurrent writers never pick the same temp
/// name. Paired with the pid it is unique across processes too.
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` to `path` atomically: write a sibling temp file, then rename
/// over the target. On Windows `std::fs::rename` maps to `MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING`, so readers observe either the old or the new
/// content — never a torn file.
///
/// The temp name carries a pid + sequence suffix because it used to be a fixed
/// `.<name>.tmp`: two concurrent writers then shared one temp file, and the
/// loser's `rename` failed with ENOENT (os error 2)
/// after the winner consumed it — or worse, one renamed a file the other was
/// still mid-`write`, publishing a torn document under an "atomic" API. Keep
/// this unique per write; the D53 team canvas hit both.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| {
        NextUpError::InvalidInput(format!("path has no parent directory: {}", path.display()))
    })?;
    std::fs::create_dir_all(parent)?;

    let file_name = path
        .file_name()
        .ok_or_else(|| NextUpError::InvalidInput(format!("invalid file path: {}", path.display())))?
        .to_string_lossy()
        .into_owned();
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{file_name}.{}-{seq}.tmp", std::process::id()));

    std::fs::write(&tmp, bytes)?;

    // Windows fails this rename transiently even when nothing is wrong:
    // MoveFileExW returns ERROR_ACCESS_DENIED / ERROR_SHARING_VIOLATION while
    // another writer is replacing the same destination, and Defender opens a
    // freshly written file to scan it. Both clear on their own in milliseconds
    // (reproduced under load as `Os { code: 5, PermissionDenied }`).
    // Retry rather than surfacing a scary error the user can do nothing about.
    // ENOENT is deliberately NOT retried — with a per-write temp name it would
    // mean a real bug, and masking it would hide it.
    let mut attempt = 0u32;
    loop {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) if attempt + 1 < RENAME_ATTEMPTS && is_transient_rename_error(&e) => {
                std::thread::sleep(retry_backoff(attempt, seq));
                attempt += 1;
            }
            Err(e) => {
                // Leave no temp litter behind on failure.
                let _ = std::fs::remove_file(&tmp);
                return Err(e.into());
            }
        }
    }
}

/// Rename attempts before giving up.
const RENAME_ATTEMPTS: u32 = 12;

/// How long to wait before rename attempt `attempt + 1`.
///
/// **Exponential and jittered, and both halves are load-bearing** (G046). The
/// contention this backs off from is other writers doing exactly the same
/// thing, so a fixed schedule makes every loser sleep the same length and
/// collide again in lockstep — a thundering herd that gets worse with more
/// writers, not better. The old linear `2ms * attempt` failed that way: it
/// looked like ~130ms of patience, but eight threads renaming onto one path
/// spent it re-colliding, and the suite went red roughly five runs in eight
/// on a loaded machine while the same test alone never failed once.
///
/// Jitter comes from the write sequence rather than a RNG: it is already
/// unique per write and therefore differs between the very writers that need
/// decorrelating, with no dependency and no global state of its own.
fn retry_backoff(attempt: u32, seq: u64) -> std::time::Duration {
    let base = 1u64 << attempt.min(6); // 1, 2, 4, … 64ms, then flat
    std::time::Duration::from_millis(base + seq % base)
}

/// Windows sharing/scanner contention that resolves itself. `PermissionDenied`
/// covers ERROR_ACCESS_DENIED; the raw codes catch SHARING_VIOLATION (32) and
/// LOCK_VIOLATION (33), which map to `Uncategorized` on stable Rust.
fn is_transient_rename_error(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied
        || matches!(e.raw_os_error(), Some(32) | Some(33))
}

/// Serialize `value` as pretty JSON (with trailing newline) and write atomically.
pub fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let mut json = serde_json::to_vec_pretty(value)?;
    json.push(b'\n');
    atomic_write(path, &json)
}

/// Read a file, tagging any I/O error with the path so the message says
/// which file failed ("files are the source of truth" — errors must name them).
pub fn read_file(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|source| NextUpError::IoAt {
        path: path.display().to_string(),
        source,
    })
}

/// Read + parse a JSON file, tagging both I/O and parse errors with the path.
/// Use this instead of `fs::read` + `from_slice` for every JSON load.
pub fn read_json_file<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let raw = read_file(path)?;
    serde_json::from_slice(&raw).map_err(|source| NextUpError::JsonAt {
        path: path.display().to_string(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");

        atomic_write(&path, b"first").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first");

        atomic_write(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
    }

    #[test]
    fn creates_missing_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a/b/c.txt");
        atomic_write(&path, b"deep").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"deep");
    }

    /// Concurrent writers must not share a temp file. With the old fixed
    /// `.<name>.tmp` this failed two ways: the loser's `rename` returned
    /// ENOENT once the winner consumed the temp, and a rename landing on a
    /// half-finished `write` published a torn document.
    #[test]
    fn concurrent_writes_all_succeed_and_never_tear() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("teams.json");
        // Long payloads widen the write window a torn rename would land in.
        let payloads: Vec<Vec<u8>> =
            (0..8).map(|i| format!("[{}]", format!("{i},").repeat(4000)).into_bytes()).collect();

        std::thread::scope(|scope| {
            for payload in &payloads {
                scope.spawn(|| {
                    for _ in 0..20 {
                        atomic_write(&path, payload).expect("concurrent write must not fail");
                    }
                });
            }
        });

        let final_bytes = std::fs::read(&path).unwrap();
        assert!(
            payloads.contains(&final_bytes),
            "the file must equal exactly one writer's payload, never a splice of two"
        );
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp litter after concurrent writes");
    }

    #[test]
    fn leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        atomic_write(&path, b"{}").unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
