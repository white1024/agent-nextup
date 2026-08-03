//! Post-mutation takeover-surface synchronization (the D24 continuity
//! contract, in one place).
//!
//! Every mutation (ops::, flywheel::, workflow transitions) ends in
//! [`sync_after_mutation`], which loads the workspace state **once** and
//! brings every takeover surface up to date from that single snapshot:
//! - `.nextup/snapshots/latest_handoff.md` (via `handoff::render_handoff`),
//! - the `HandoffGenerated` ledger line,
//! - the CLAUDE.md state block + `project.yaml` manifest
//!   (via `bootstrap::refresh_with`).
//!
//! The call graph is a straight line ending here: this module never calls
//! back into ops/workflow mutation paths, and bootstrap never calls back into
//! handoff. Gates are evaluated exactly once per sync.

use crate::error::Result;
use crate::workspace::atomic::atomic_write;
use crate::workspace::bootstrap;
use crate::workspace::context::{load_context, now_rfc3339};
use crate::workspace::handoff::{
    render_handoff, HandoffInput, RECENT_DECISIONS, RECENT_EVENTS, RECENT_PROGRESS,
};
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::ledger::{Ledger, LedgerEvent, LedgerKind};
use crate::workspace::tasks::TaskStore;
use crate::workspace::workflow::{try_evaluate, WorkflowStatus};

pub struct SyncOutcome {
    /// The freshly rendered handoff snapshot markdown.
    pub handoff: String,
    /// The freshly evaluated harness status (`None` for workspaces without
    /// workflow.json) — callers that just mutated the workflow use this
    /// instead of paying for a second evaluation.
    pub workflow: Option<WorkflowStatus>,
}

/// Bring every takeover surface up to date after a mutation: one state load,
/// one gate evaluation, every surface. Callers hold the mutation lock.
pub fn sync_after_mutation(paths: &WorkspacePaths, app_version: &str) -> Result<SyncOutcome> {
    let context = load_context(&paths.context_file())?;
    let tasks = TaskStore::new(paths.tasks_dir()).list()?;
    let workflow = try_evaluate(paths)?;
    let ledger = Ledger::new(paths.ledger_file());
    // Noise is filtered at the source so bursts can never starve the window
    // (the renderer keeps its own filter for callers that pass raw events).
    let recent = ledger.recent_visible(RECENT_EVENTS)?;
    let decisions = ledger.recent_of_kind(LedgerKind::Decision, RECENT_DECISIONS)?;
    let progress = ledger.recent_of_kind(LedgerKind::Progress, RECENT_PROGRESS)?;

    let handoff = render_handoff(&HandoffInput {
        context: &context,
        tasks: &tasks,
        recent_events: &recent,
        decisions: &decisions,
        progress: &progress,
        workflow: workflow.as_ref(),
        app_version,
        generated_at: now_rfc3339(),
    });
    atomic_write(&paths.handoff_file(), handoff.as_bytes())?;
    ledger.append(&LedgerEvent::new(
        LedgerKind::HandoffGenerated,
        "handoff snapshot refreshed",
        None,
    ))?;

    // The CLAUDE.md state block shows only the newest few decisions and
    // progress lines — the tails of the (chronological) lists gathered above.
    let tail = &decisions[decisions.len().saturating_sub(bootstrap::STATE_BLOCK_DECISIONS)..];
    let progress_tail =
        &progress[progress.len().saturating_sub(bootstrap::STATE_BLOCK_PROGRESS)..];
    bootstrap::refresh_with(paths, &context, &tasks, workflow.as_ref(), tail, progress_tail)?;

    Ok(SyncOutcome { handoff, workflow })
}
