use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use nextup_core::error::{NextUpError, Result};
use nextup_core::workspace::layout::WorkspacePaths;
use nextup_core::workspace::tasks::{counts_for_dir, TaskCounts};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Emitted after a debounced batch of relevant filesystem changes. The
/// payload is a lightweight state delta — heavy processing stays in Rust and
/// the UI never receives raw file events (IPC constraint from the spec).
pub const WORKSPACE_CHANGED_EVENT: &str = "workspace://changed";

/// Emitted when the ledger grew (D62). Deliberately a *separate* event from
/// `workspace://changed`, because the two carry opposite instructions: the
/// latter means "re-read your state", this one means "read the new tail and
/// decide whether to notify" — and nothing more.
///
/// That distinction is what makes watching the ledger safe at all. The ledger
/// is excluded from the state signal because every mutation ends in a ledger
/// append, so re-reading state on it would loop. A notification listener only
/// *reads* the tail, so it writes nothing that could re-trigger the watcher.
pub const LEDGER_APPENDED_EVENT: &str = "ledger://appended";

const DEBOUNCE: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangedPayload {
    pub root: String,
    pub task_counts: Option<TaskCounts>,
}

/// Payload for [`LEDGER_APPENDED_EVENT`]. No events ride along: the listener
/// holds a line cursor and reads the tail itself, so the watcher never has to
/// know how much the listener has already seen.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerAppendedPayload {
    pub root: String,
}

/// What a touched path means to the UI. A single burst can produce both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Signal {
    /// Workspace state changed — views must re-read.
    State,
    /// The ledger grew — notification surfaces should read the new tail.
    Ledger,
}

/// Which signals a debounced burst produced.
#[derive(Debug, Clone, Copy, Default)]
struct Batch {
    state: bool,
    ledger: bool,
}

impl Batch {
    fn with(mut self, signal: Option<Signal>) -> Self {
        match signal {
            Some(Signal::State) => self.state = true,
            Some(Signal::Ledger) => self.ledger = true,
            None => {}
        }
        self
    }
}

/// Keeps the notify watcher alive. Dropping the guard disconnects the event
/// channel, which cleanly terminates the debounce thread.
pub struct WatcherGuard {
    _watcher: RecommendedWatcher,
}

/// Watch a workspace root recursively and emit debounced
/// `workspace://changed` events for changes to tasks, artifacts or the
/// `.nextup` configuration files.
pub fn start(app: AppHandle, root: PathBuf) -> Result<WatcherGuard> {
    let (tx, rx) = channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| NextUpError::Workspace(format!("cannot create file watcher: {e}")))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| NextUpError::Workspace(format!("cannot watch {}: {e}", root.display())))?;

    std::thread::spawn(move || debounce_loop(app, root, rx));
    Ok(WatcherGuard { _watcher: watcher })
}

fn debounce_loop(app: AppHandle, root: PathBuf, rx: Receiver<notify::Result<Event>>) {
    loop {
        // Block until the first event of a burst; a closed channel means the
        // guard was dropped and this thread should end.
        let Ok(first) = rx.recv() else { return };
        let mut batch = batch_of(&root, &first);

        // Coalesce the rest of the burst within the debounce window.
        let deadline = Instant::now() + DEBOUNCE;
        loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            match rx.recv_timeout(remaining) {
                Ok(ev) => {
                    let next = batch_of(&root, &ev);
                    batch.state |= next.state;
                    batch.ledger |= next.ledger;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }

        if batch.state {
            let paths = WorkspacePaths::new(&root);
            let payload = WorkspaceChangedPayload {
                root: root.to_string_lossy().into_owned(),
                task_counts: counts_for_dir(&paths.tasks_dir()).ok(),
            };
            let _ = app.emit(WORKSPACE_CHANGED_EVENT, payload);
        }
        if batch.ledger {
            let payload = LedgerAppendedPayload { root: root.to_string_lossy().into_owned() };
            let _ = app.emit(LEDGER_APPENDED_EVENT, payload);
        }
    }
}

fn batch_of(root: &Path, res: &notify::Result<Event>) -> Batch {
    let Ok(event) = res else { return Batch::default() };
    event.paths.iter().fold(Batch::default(), |acc, p| acc.with(classify(root, p)))
}

/// Whitelist filter. Critically, our *own derived writes* (handoff snapshot,
/// secrets envelope, atomic temp files) produce no state signal so a
/// regeneration can never re-trigger the watcher in a feedback loop.
///
/// The ledger is the one exception with a signal of its own (D62): every
/// mutation appends to it, so it must never mean "re-read state" — but an
/// append is exactly the trigger a notification surface needs, and reading a
/// tail writes nothing, so [`Signal::Ledger`] closes no loop.
fn classify(root: &Path, path: &Path) -> Option<Signal> {
    let Ok(rel) = path.strip_prefix(root) else { return None };
    let rel = rel.to_string_lossy().replace('\\', "/");

    for ignored in [".git", "node_modules", "target", ".nextup/snapshots"] {
        if rel == ignored || rel.starts_with(&format!("{ignored}/")) {
            return None;
        }
    }
    if rel == ".nextup/ledger.jsonl" {
        return Some(Signal::Ledger);
    }
    if rel == ".nextup/secrets.enc" {
        return None;
    }
    if let Some(name) = rel.rsplit('/').next() {
        // Atomic-write temp files: ".{name}.{pid}-{seq}.tmp" (D57 made the
        // suffix unique per write; the leading dot + .tmp shape is the contract).
        if name.starts_with('.') && name.ends_with(".tmp") {
            return None;
        }
    }

    let is_state = rel == "tasks"
        || rel.starts_with("tasks/")
        || rel == "artifacts"
        || rel.starts_with("artifacts/")
        // Spec layer (D79): the truth is files and the blessed editing channel
        // is the editor/agent, so a hand edit under specs/ must refresh the
        // specs view. Folds write here too, but they also touch tasks/ — this
        // line is for the direct-edit path that would otherwise stay dark.
        || rel == "specs"
        || rel.starts_with("specs/")
        || rel == ".nextup/context.json"
        || rel == ".nextup/rules.json"
        || rel == ".nextup/workflow.json"
        || rel == ".nextup/mcp.json"
        || rel == ".nextup/agent_access.json"
        || rel == ".nextup/modules.json"
        // Workspace behavior settings (D78): written only on explicit GUI
        // save — the engine reads but never writes it, so no feedback loop.
        || rel == ".nextup/settings.json"
        // Written only on explicit upgrade/scaffold (no feedback loop, same
        // as modules.json) — lets an MCP-side asset upgrade refresh the GUI.
        || rel == ".nextup/shipped_assets.json"
        // Delivery envelopes (D48): written only on explicit publish (hub) or
        // routing (app layer) — an MCP-side publish must light up the GUI's
        // pending-send list, and an inbound routing the recipient's inbox.
        || rel == ".nextup/exchange"
        || rel.starts_with(".nextup/exchange/");

    is_state.then_some(Signal::State)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from(r"C:\ws\demo")
    }

    #[test]
    fn task_and_config_changes_are_relevant() {
        let r = root();
        let state = Some(Signal::State);
        assert_eq!(classify(&r, &r.join("tasks").join("T-0001.json")), state);
        assert_eq!(classify(&r, &r.join("artifacts").join("report.md")), state);
        assert_eq!(classify(&r, &r.join(".nextup").join("context.json")), state);
        assert_eq!(classify(&r, &r.join(".nextup").join("rules.json")), state);
        assert_eq!(classify(&r, &r.join(".nextup").join("workflow.json")), state);
        assert_eq!(classify(&r, &r.join(".nextup").join("mcp.json")), state);
        assert_eq!(classify(&r, &r.join(".nextup").join("shipped_assets.json")), state);
        // Exchange envelopes (D48): both boxes light up the GUI.
        assert_eq!(classify(&r, &r.join(".nextup/exchange/outbox/abc.json")), state);
        assert_eq!(classify(&r, &r.join(".nextup/exchange/inbox/abc.json")), state);
        // Spec layer (D79): hand edits under specs/ must refresh the view.
        assert_eq!(classify(&r, &r.join("specs").join("auth").join("spec.md")), state);
    }

    #[test]
    fn own_derived_writes_are_ignored() {
        let r = root();
        assert_eq!(classify(&r, &r.join(".nextup/snapshots/latest_handoff.md")), None);
        assert_eq!(classify(&r, &r.join(".nextup").join("secrets.enc")), None);
        assert_eq!(classify(&r, &r.join("tasks").join(".T-0001.json.tmp")), None);
        // The D57 per-write suffix must stay inside the exclusion.
        assert_eq!(classify(&r, &r.join("tasks").join(".T-0001.json.4812-7.tmp")), None);
        // Pre-upgrade asset backups are a machine-local safety net, not state.
        assert_eq!(
            classify(
                &r,
                &r.join(".nextup/asset_backups/20260714T000000Z/nextup_docs/01-nextup-guide.md")
            ),
            None
        );
    }

    /// The ledger carries its own signal (D62) and must never carry the state
    /// one: every mutation ends in an append, so treating it as state would
    /// make each write re-trigger a full re-read — the feedback loop the
    /// whitelist exists to prevent.
    #[test]
    fn ledger_signals_appends_but_never_state() {
        let r = root();
        assert_eq!(classify(&r, &r.join(".nextup").join("ledger.jsonl")), Some(Signal::Ledger));
    }

    /// One burst that touched both a task file and the ledger must raise both
    /// signals — a mutation is exactly this shape, and the notification
    /// surface would miss every agent-driven event if the ledger flag were
    /// lost to the state flag.
    #[test]
    fn a_burst_can_raise_both_signals() {
        let r = root();
        let batch = Batch::default()
            .with(classify(&r, &r.join("tasks").join("T-0001.json")))
            .with(classify(&r, &r.join(".nextup").join("ledger.jsonl")));
        assert!(batch.state);
        assert!(batch.ledger);

        // ...and an irrelevant path never clears an already-raised flag.
        let kept = batch.with(classify(&r, &r.join(".git").join("HEAD")));
        assert!(kept.state);
        assert!(kept.ledger);
    }

    #[test]
    fn noise_directories_are_ignored() {
        let r = root();
        assert_eq!(classify(&r, &r.join(".git").join("HEAD")), None);
        assert_eq!(classify(&r, &r.join("node_modules").join("x.js")), None);
        assert_eq!(classify(&r, &r.join("src").join("main.rs")), None);
        assert_eq!(classify(&r, Path::new(r"D:\outside\tasks\T-1.json")), None);
    }
}
