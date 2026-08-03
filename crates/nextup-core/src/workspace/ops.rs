//! High-level workspace operations that keep the task files, the ledger and
//! the handoff snapshot consistent with each other. The delivery layers (IPC
//! commands and the MCP hub) call these instead of stitching the lower-level
//! stores together themselves — any business rule that must hold for *both*
//! channels (validation, audit events, limits) belongs here, never up there.
//!
//! Every mutation runs under the cross-process lock (workspace::lock): the GUI
//! and an external nextup-mcp server may target the same workspace, and both
//! id allocation and load→change→save sequences need mutual exclusion.
//!
//! Continuity contract (D24): every state mutation regenerates the handoff
//! snapshot, so `latest_handoff.md` is never staler than the last operation —
//! a session that only recorded decisions still hands off fresh.
//! (generate_handoff refreshes the CLAUDE.md state block and manifest itself.)

use serde::Serialize;

use crate::error::{NextUpError, Result};
use crate::security::keystore::KeyProvider;
use crate::workspace::context::{
    load_context, now_rfc3339, save_context, Milestone, ProjectContext, RejectedAlternative,
};
use crate::workspace::handoff::generate_handoff;
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::ledger::{ledger_for, LedgerEvent, LedgerKind};
use crate::workspace::lock::with_mutation_lock;
use crate::workspace::specs;
use crate::workspace::tasks::{NewTask, Task, TaskEdit, TaskStatus, TaskStore};

/// The shape a ledgered mutation shares (the module contract above): take the
/// cross-process lock, run the change, append its one audit line, regenerate
/// the takeover surfaces. The fresh snapshot comes back beside the payload
/// because most callers hand it straight to the UI (`TaskUpdate.handoff`);
/// callers that do not need it drop it with `.map(|(x, _)| x)`.
///
/// Deliberately *not* used by the mutations whose outer shell differs, each
/// for a reason that would be lost if it were forced through here:
/// `delete_task` must ledger *before* a later fallible step; `set_task_archived`
/// writes an extra (fold) line ahead of the archive one and
/// `archive_verified_done_tasks_at` may write none at all;
/// `claim_task` / `assign_task` have a no-op path that must skip both the
/// line and the regeneration; `ensure_workspace_id` regenerates only when it
/// actually minted; `set_secret` / `remove_secret` deliberately leave the
/// snapshot alone (a secret name is not takeover state).
fn mutate<T>(
    paths: &WorkspacePaths,
    app_version: &str,
    change: impl FnOnce() -> Result<(T, LedgerEvent)>,
) -> Result<(T, String)> {
    with_mutation_lock(paths, || {
        let (payload, event) = change()?;
        ledger_for(paths).append(&event)?;
        Ok((payload, generate_handoff(paths, app_version)?))
    })
}

pub fn create_task(paths: &WorkspacePaths, app_version: &str, input: NewTask) -> Result<Task> {
    mutate(paths, app_version, || {
        let task = TaskStore::new(paths.tasks_dir()).create(input)?;
        let event = LedgerEvent::new(
            LedgerKind::TaskCreated,
            format!("created \"{}\" (P{})", task.title, task.priority),
            Some(task.id.clone()),
        );
        Ok((task, event))
    })
    .map(|(task, _)| task)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdate {
    pub task: Task,
    /// The freshly regenerated snapshot (every transition regenerates, D24),
    /// so the UI can show it without a second roundtrip.
    pub handoff: Option<String>,
    /// What archiving folded into specs/ (D79) — present only on an archive
    /// that actually folded, so the UI can show the `+ ~ - →` outcome.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec_fold: Option<SpecFoldSummary>,
}

/// Transition a task. Every transition changes handoff content (section 3
/// next-steps ordering, section 4 blockers), so every transition regenerates.
pub fn update_task_status(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
    status: TaskStatus,
    blocked_reason: Option<String>,
) -> Result<TaskUpdate> {
    mutate(paths, app_version, || {
        let previous = TaskStore::new(paths.tasks_dir()).get(id)?.status;
        let task = TaskStore::new(paths.tasks_dir()).update_status(id, status, blocked_reason)?;

        let event = LedgerEvent::new(
            LedgerKind::TaskStatusChanged,
            format!("\"{}\": {} → {}", task.title, previous.label(), task.status.label()),
            Some(task.id.clone()),
        )
        // Structured endpoints (D75): the flywheel's blocked-task signal
        // reads these, not the arrow prose.
        .with_transition(previous, task.status);

        Ok((task, event))
    })
    .map(|(task, handoff)| TaskUpdate { task, handoff: Some(handoff), spec_fold: None })
}

/// Mark a done task as verified (evidence note required) or clear the mark.
/// Verification changes what section 4 of the handoff lists as unverified
/// assumptions, so the snapshot is regenerated in both directions.
pub fn set_task_verification(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
    verified: bool,
    note: Option<String>,
) -> Result<TaskUpdate> {
    // The regeneration (inside `mutate`) refreshes the bootstrap surfaces itself.
    mutate(paths, app_version, || {
        let task = TaskStore::new(paths.tasks_dir()).set_verification(id, verified, note)?;
        let message = match task.verified_note.as_deref() {
            Some(evidence) => format!("\"{}\" verified: {evidence}", task.title),
            None => format!("\"{}\" verification cleared", task.title),
        };
        let event =
            LedgerEvent::new(LedgerKind::TaskVerificationChanged, message, Some(task.id.clone()));
        Ok((task, event))
    })
    .map(|(task, handoff)| TaskUpdate { task, handoff: Some(handoff), spec_fold: None })
}

/// Rewrite a task's attributes (title / description / priority / tags). The
/// ledger line spells out what actually changed — "edited T-0007" would tell a
/// takeover session nothing, and the old title is the part that stops being
/// recoverable from the file. A no-op edit is still ledgered as such rather
/// than swallowed: the user did press save, and silence would read as failure.
pub fn edit_task(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
    edit: TaskEdit,
) -> Result<TaskUpdate> {
    mutate(paths, app_version, || {
        let store = TaskStore::new(paths.tasks_dir());
        let before = store.get(id)?;
        let task = store.edit(id, edit)?;

        let mut changes = Vec::new();
        if before.title != task.title {
            changes.push(format!("title \"{}\" → \"{}\"", before.title, task.title));
        }
        if before.description != task.description {
            changes.push("description updated".to_string());
        }
        if before.priority != task.priority {
            changes.push(format!("P{} → P{}", before.priority, task.priority));
        }
        if before.tags != task.tags {
            let rendered =
                if task.tags.is_empty() { "none".to_string() } else { task.tags.join(", ") };
            changes.push(format!("tags: {rendered}"));
        }
        let detail = if changes.is_empty() { "no changes".to_string() } else { changes.join("; ") };
        let event = LedgerEvent::new(
            LedgerKind::TaskEdited,
            format!("\"{}\": {detail}", task.title),
            Some(task.id.clone()),
        );

        // The title shows up in handoff §3 next-steps, so an edit changes the
        // snapshot like any other mutation (D24).
        Ok((task, event))
    })
    .map(|(task, handoff)| TaskUpdate { task, handoff: Some(handoff), spec_fold: None })
}

/// Delete a task file. Refused while other tasks depend on it (structured
/// refusal from the store). The ledger keeps the title and priority, so the
/// append-only trail still answers "what was T-0007?" once the file is gone —
/// deletion removes the working item, never the history of it.
pub fn delete_task(paths: &WorkspacePaths, app_version: &str, id: &str) -> Result<()> {
    with_mutation_lock(paths, || {
        let task = TaskStore::new(paths.tasks_dir()).delete(id)?;
        ledger_for(paths).append(&LedgerEvent::new(
            LedgerKind::TaskDeleted,
            format!("deleted \"{}\" (P{}, {})", task.title, task.priority, task.status.label()),
            Some(task.id.clone()),
        ))?;
        // The artifact bundle is the task's own attachment (D79) — it goes
        // with the file. Refusals (HasDependents / NotFound) happen before
        // any removal; the ledger line lands *before* this so a failed
        // removal (Windows file lock) can never erase the deletion from the
        // audit trail — the leftover dir is the doctor's orphan finding.
        let bundle = paths.task_artifact_dir(id);
        if bundle.is_dir() {
            std::fs::remove_dir_all(&bundle)?;
        }
        generate_handoff(paths, app_version)?;
        Ok(())
    })
}

/// What one task's archive folded into `specs/` (D79) — for the ledger line
/// and the caller's UI feedback.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecFoldSummary {
    pub capabilities: Vec<String>,
    pub added: usize,
    pub modified: usize,
    pub removed: usize,
    pub renamed: usize,
}

/// Fold a task's delta bundle into the main specs — the only fold entry
/// point (D79, nextup_docs/15 §4.2). Dry-runs every capability first and
/// writes only when the whole bundle validates (`fold_batch` is
/// prepare-all), then stamps `spec_folded_at`. `Ok(None)` = nothing to do
/// (no bundle, or already folded). Callers hold the mutation lock.
fn fold_task_specs(paths: &WorkspacePaths, task: &Task) -> Result<Option<SpecFoldSummary>> {
    if task.spec_folded_at.is_some() {
        return Ok(None);
    }
    // Non-done tasks never fold — and never archive either: stepping aside
    // here lets `set_archived` refuse with its own message instead of this
    // path preempting it with "verify first" (a dead end — verification
    // itself refuses non-done tasks; batch ② review).
    if task.status != TaskStatus::Done {
        return Ok(None);
    }
    let deltas = specs::read_task_deltas(paths, &task.id)?;
    if deltas.is_empty() {
        return Ok(None);
    }
    // Folding turns a claim into truth, so the claim must be verified first
    // (decision 5). Tasks without deltas keep the plain D40 semantics.
    if !task.is_verified() {
        return Err(NextUpError::InvalidInput(format!(
            "{} has delta specs — verify the task first: archiving folds them into specs/",
            task.id
        )));
    }
    let outcomes = specs::plan_task_fold(paths, &deltas)?
        .map_err(|conflicts| NextUpError::SpecFoldConflict { id: task.id.clone(), conflicts })?;
    let mut summary = SpecFoldSummary {
        capabilities: Vec::new(),
        added: 0,
        modified: 0,
        removed: 0,
        renamed: 0,
    };
    for (capability, out) in &outcomes {
        let file = paths.spec_file(capability);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        crate::workspace::atomic::atomic_write(&file, out.content.as_bytes())?;
        summary.capabilities.push(capability.clone());
        summary.added += out.added;
        summary.modified += out.modified;
        summary.removed += out.removed;
        summary.renamed += out.renamed;
    }
    TaskStore::new(paths.tasks_dir()).set_spec_folded_at(&task.id, Some(now_rfc3339()))?;
    Ok(Some(summary))
}

/// Read-only dry-run of a task's spec-delta fold (the hub tool's op, batch
/// ③): the task must exist; a task without a bundle gets a clean empty
/// report.
pub fn validate_task_specs(paths: &WorkspacePaths, id: &str) -> Result<specs::TaskSpecsReport> {
    TaskStore::new(paths.tasks_dir()).get(id)?;
    specs::dry_run_task_specs(paths, id)
}

/// Every unarchived task whose unfolded delta bundle is waiting — the specs
/// view's "pending folds" panel (batch ④). Per-task read problems become
/// that task's report (`ok: false`) instead of sinking the whole list.
pub fn pending_spec_folds(paths: &WorkspacePaths) -> Result<Vec<specs::TaskSpecsReport>> {
    let mut out = Vec::new();
    for task in TaskStore::new(paths.tasks_dir()).list()? {
        if task.archived || task.spec_folded_at.is_some() {
            continue;
        }
        match specs::dry_run_task_specs(paths, &task.id) {
            Ok(report) => {
                if !report.capabilities.is_empty() {
                    out.push(report);
                }
            }
            Err(e) => out.push(specs::TaskSpecsReport {
                task_id: task.id.clone(),
                capabilities: Vec::new(),
                ok: false,
                problems: vec![e.to_string()],
                warnings: Vec::new(),
                already_synced: Vec::new(),
                added: 0,
                modified: 0,
                removed: 0,
                renamed: 0,
            }),
        }
    }
    Ok(out)
}

fn spec_folded_event(task: &Task, s: &SpecFoldSummary) -> LedgerEvent {
    LedgerEvent::new(
        LedgerKind::SpecFolded,
        format!(
            "folded specs for \"{}\": {} (+{} ~{} -{} \u{2192}{})",
            task.title,
            s.capabilities.join(", "),
            s.added,
            s.modified,
            s.removed,
            s.renamed
        ),
        Some(task.id.clone()),
    )
}

/// Archive or un-archive one task (D40). Archiving hides a closed (done)
/// task from default listings; the file never moves. Archiving also folds
/// the task's delta specs into `specs/` (D79) — a conflicted or unverified
/// bundle refuses the archive before anything is written. The snapshot
/// lists open work only, but the counts line changes, so it regenerates
/// like any state mutation (D24).
pub fn set_task_archived(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
    archived: bool,
) -> Result<TaskUpdate> {
    with_mutation_lock(paths, || {
        let store = TaskStore::new(paths.tasks_dir());
        let mut folded = None;
        if archived {
            let task = store.get(id)?;
            folded = fold_task_specs(paths, &task)?.map(|summary| (task, summary));
        }
        let task = store.set_archived(id, archived)?;
        if let Some((pre_fold, summary)) = &folded {
            ledger_for(paths).append(&spec_folded_event(pre_fold, summary))?;
        }
        let verb = if archived { "archived" } else { "unarchived" };
        ledger_for(paths).append(&LedgerEvent::new(
            LedgerKind::TaskArchived,
            format!("\"{}\" {verb}", task.title),
            Some(task.id.clone()),
        ))?;
        let handoff = Some(generate_handoff(paths, app_version)?);
        Ok(TaskUpdate { task, handoff, spec_fold: folded.map(|(_, summary)| summary) })
    })
}

/// Archive every done-and-verified task in one sweep (the tasks page bulk
/// button, D40; `min_age_days` gate added for the D78 auto sweep). Unverified
/// done tasks are deliberately left visible — the verification debt must not
/// be buried by housekeeping. One lock, one ledger event, one snapshot
/// regeneration; a no-op sweep ledgers nothing.
///
/// `min_age_days: None` archives regardless of age (the explicit bulk
/// button); `Some(d)` only archives tasks whose `verified_at` is at least
/// `d` days before `now` — an unparsable timestamp is conservatively
/// skipped, never swept.
pub fn archive_verified_done_tasks(
    paths: &WorkspacePaths,
    app_version: &str,
    min_age_days: Option<u32>,
) -> Result<Vec<String>> {
    archive_verified_done_tasks_at(paths, app_version, min_age_days, chrono::Utc::now())
}

/// Deterministic core with an injected clock (the doctor precedent) so the
/// age gate is unit-testable without waiting real days.
pub fn archive_verified_done_tasks_at(
    paths: &WorkspacePaths,
    app_version: &str,
    min_age_days: Option<u32>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<String>> {
    let old_enough = |task: &Task| -> bool {
        let Some(days) = min_age_days else { return true };
        let Some(at) = task.verified_at.as_deref() else { return false };
        match chrono::DateTime::parse_from_rfc3339(at) {
            Ok(ts) => now.signed_duration_since(ts) >= chrono::Duration::days(i64::from(days)),
            Err(_) => false,
        }
    };
    with_mutation_lock(paths, || {
        let store = TaskStore::new(paths.tasks_dir());
        let mut archived = Vec::new();
        for task in store.list()? {
            if task.status == TaskStatus::Done
                && task.is_verified()
                && !task.archived
                && old_enough(&task)
            {
                match fold_task_specs(paths, &task) {
                    Ok(None) => {}
                    Ok(Some(summary)) => {
                        ledger_for(paths).append(&spec_folded_event(&task, &summary))?;
                    }
                    // Any fold failure — a conflict or an unreadable bundle
                    // — skips the whole task: archiving without folding
                    // would manufacture an orphan delta, and aborting
                    // mid-sweep would leave archived tasks without their
                    // ledger lines and a stale snapshot (batch ② review).
                    // The fold is prepare-all, so a skip wrote nothing — a
                    // sweep over only-broken tasks stays a zero-write
                    // circle (invariant 3); the doctor names each cause.
                    Err(_) => continue,
                }
                store.set_archived(&task.id, true)?;
                archived.push(task.id);
            }
        }
        if !archived.is_empty() {
            let detail = match min_age_days {
                Some(days) => format!(
                    "auto-archived {} verified done tasks (verified >= {days} days ago): {}",
                    archived.len(),
                    archived.join(", ")
                ),
                None => format!(
                    "archived {} verified done tasks: {}",
                    archived.len(),
                    archived.join(", ")
                ),
            };
            ledger_for(paths).append(&LedgerEvent::new(LedgerKind::TaskArchived, detail, None))?;
            generate_handoff(paths, app_version)?;
        }
        Ok(archived)
    })
}

/// The workspace-open housekeeping pass (D78): read the workspace settings
/// and, when auto-archive is enabled, sweep verified-done tasks older than
/// the configured window. Disabled settings return an empty sweep — the
/// caller (app layer, on open) never needs to branch. A second run is a
/// no-op that writes nothing, so the open→sweep→watcher→reload path cannot
/// loop.
pub fn auto_archive_sweep(paths: &WorkspacePaths, app_version: &str) -> Result<Vec<String>> {
    let settings = crate::workspace::settings::get_settings(paths)?;
    if !settings.auto_archive.enabled {
        return Ok(Vec::new());
    }
    archive_verified_done_tasks(paths, app_version, Some(settings.auto_archive.days))
}

/// Claim a task for `agent` — compare-and-set under the mutation lock, so two
/// agents racing for the same task cannot both win (D31). Not stealable: a
/// task already claimed by someone else is refused; reassignment is a human /
/// orchestrator act via [`assign_task`]. Claiming your own task is a no-op
/// success. Collab-module capability: refused while the module is off.
pub fn claim_task(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
    agent: &str,
) -> Result<TaskUpdate> {
    let agent = agent.trim();
    if agent.is_empty() {
        return Err(NextUpError::InvalidInput(
            "claiming needs an agent identity — start nextup-mcp with --agent or set NEXTUP_AGENT"
                .into(),
        ));
    }
    crate::workspace::modules::require_module(paths, crate::workspace::modules::MODULE_COLLAB)?;
    with_mutation_lock(paths, || {
        let store = TaskStore::new(paths.tasks_dir());
        let current = store.get(id)?;
        match current.assignee.as_deref() {
            Some(owner) if owner == agent => {
                // Already yours — nothing changed, nothing to ledger.
                return Ok(TaskUpdate { task: current, handoff: None, spec_fold: None });
            }
            Some(owner) => {
                // Structured refusal (D32): carries `currentAssignee` so the
                // caller knows who to coordinate with without parsing prose.
                return Err(NextUpError::AlreadyClaimed {
                    id: id.to_string(),
                    current_assignee: owner.to_string(),
                });
            }
            None => {}
        }
        let task = store.set_assignee(id, Some(agent.to_string()))?;
        ledger_for(paths).append(
            &LedgerEvent::new(
                LedgerKind::TaskAssigneeChanged,
                format!("\"{}\" claimed by {agent}", task.title),
                Some(task.id.clone()),
            )
            .with_actor(Some(agent.to_string())),
        )?;
        let handoff = Some(generate_handoff(paths, app_version)?);
        Ok(TaskUpdate { task, handoff, spec_fold: None })
    })
}

/// Assign (or unassign, with `None`) a task — the dispatcher's overwrite
/// counterpart to [`claim_task`], for humans and orchestrators. Every change
/// of hands is ledgered, so reassignment stays auditable. `actor` is the
/// self-declared identity of the caller when it is an external agent.
pub fn assign_task(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
    assignee: Option<&str>,
    actor: Option<String>,
) -> Result<TaskUpdate> {
    crate::workspace::modules::require_module(paths, crate::workspace::modules::MODULE_COLLAB)?;
    let assignee = assignee.map(str::trim).filter(|a| !a.is_empty());
    with_mutation_lock(paths, || {
        let store = TaskStore::new(paths.tasks_dir());
        let before = store.get(id)?.assignee;
        let task = store.set_assignee(id, assignee.map(String::from))?;
        if before == task.assignee {
            return Ok(TaskUpdate { task, handoff: None, spec_fold: None });
        }
        let message = match task.assignee.as_deref() {
            Some(to) => format!("\"{}\" assigned to {to}", task.title),
            None => format!("\"{}\" unassigned", task.title),
        };
        ledger_for(paths).append(
            &LedgerEvent::new(LedgerKind::TaskAssigneeChanged, message, Some(task.id.clone()))
                .with_actor(actor),
        )?;
        let handoff = Some(generate_handoff(paths, app_version)?);
        Ok(TaskUpdate { task, handoff, spec_fold: None })
    })
}

/// The three free-form ledger channels a session may write directly (D78).
/// Every other kind is engine-stamped by its own operation — a session can
/// never forge a `task_status_changed` line through this path.
/// - `Decision`: a directional choice + why (surfaces in handoff §4 and the
///   CLAUDE.md state block).
/// - `Progress`: a session/stage summary — where work stopped, where the
///   next session picks up (surfaces in the Last progress sections).
/// - `Note`: everything else (rides the recent-ledger window only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteChannel {
    Decision,
    Note,
    Progress,
}

impl NoteChannel {
    fn kind(self) -> LedgerKind {
        match self {
            NoteChannel::Decision => LedgerKind::Decision,
            NoteChannel::Note => LedgerKind::Note,
            NoteChannel::Progress => LedgerKind::Progress,
        }
    }

    /// Wire-name parse for delivery layers (IPC sends a string). Rejecting
    /// unknown names here keeps the forge-proof property in one place.
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "decision" => Ok(NoteChannel::Decision),
            "note" => Ok(NoteChannel::Note),
            "progress" => Ok(NoteChannel::Progress),
            other => Err(NextUpError::InvalidInput(format!(
                "unknown ledger channel '{other}' (expected decision / note / progress)"
            ))),
        }
    }
}

/// Record a decision / progress summary / free-form note into the ledger
/// (channel semantics on [`NoteChannel`]). Empty messages are rejected here —
/// all channels (GUI and agent) must agree that a blank ledger line is
/// worthless to the next session.
pub fn add_ledger_note(
    paths: &WorkspacePaths,
    app_version: &str,
    channel: NoteChannel,
    message: &str,
) -> Result<LedgerEvent> {
    let message = message.trim();
    if message.is_empty() {
        return Err(NextUpError::InvalidInput("message cannot be empty".into()));
    }
    mutate(paths, app_version, || {
        let event = LedgerEvent::new(channel.kind(), message, None);
        // The line the caller gets back is the one that was appended.
        Ok((event.clone(), event))
    })
    .map(|(event, _)| event)
}

/// Append to the do-not-re-pitch list (context.json `rejected`). Recorded
/// the moment the user turns an approach down, so no later session pitches
/// it again from scratch. Ledgered as a decision — a rejection *is* one.
pub fn add_rejected(
    paths: &WorkspacePaths,
    app_version: &str,
    proposal: &str,
    reason: &str,
) -> Result<ProjectContext> {
    let proposal = proposal.trim();
    let reason = reason.trim();
    if proposal.is_empty() || reason.is_empty() {
        return Err(NextUpError::InvalidInput(
            "a rejected alternative needs both the proposal and why it was rejected".into(),
        ));
    }
    mutate(paths, app_version, || {
        let mut ctx = load_context(&paths.context_file())?;
        if ctx.rejected.iter().any(|r| r.proposal == proposal) {
            return Err(NextUpError::InvalidInput(format!(
                "'{proposal}' is already on the rejected list"
            )));
        }
        ctx.rejected.push(RejectedAlternative {
            proposal: proposal.to_string(),
            reason: reason.to_string(),
            at: now_rfc3339(),
        });
        ctx.updated_at = now_rfc3339();
        save_context(&paths.context_file(), &ctx)?;
        let event = LedgerEvent::new(
            LedgerKind::AlternativeRejected,
            format!("rejected alternative: \"{proposal}\" — {reason}"),
            None,
        );
        Ok((ctx, event))
    })
    .map(|(ctx, _)| ctx)
}

// ── Milestones ──────────────────────────────────────────────────────────────

/// Milestones live inside context.json; every mutation goes through here so
/// the ledger and the takeover surfaces stay consistent (same contract as
/// task operations).
pub fn add_milestone(paths: &WorkspacePaths, app_version: &str, title: &str) -> Result<ProjectContext> {
    let title = title.trim();
    if title.is_empty() {
        return Err(NextUpError::InvalidInput("milestone title cannot be empty".into()));
    }
    mutate_milestones(paths, app_version, |ctx| {
        let id = next_milestone_id(ctx);
        ctx.milestones.push(Milestone { id, title: title.to_string(), done: false, verified: false });
        format!("milestone added: {title}")
    })
}

pub fn set_milestone_done(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
    done: bool,
) -> Result<ProjectContext> {
    let id = id.to_string();
    try_mutate_milestones(paths, app_version, |ctx| {
        let m = ctx
            .milestones
            .iter_mut()
            .find(|m| m.id == id)
            .ok_or_else(|| NextUpError::NotFound(format!("milestone '{id}' not found")))?;
        m.done = done;
        if !done {
            // The verification attested the completed state; reopening voids it.
            m.verified = false;
        }
        let verb = if done { "done" } else { "reopened" };
        Ok(format!("milestone {verb}: {}", m.title))
    })
}

/// Flag a completed milestone as human/fresh-session verified (or clear the
/// flag). Only a done milestone can be verified — the flag is a counter-check
/// of the completion claim, not an independent state.
pub fn set_milestone_verified(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
    verified: bool,
) -> Result<ProjectContext> {
    let id = id.to_string();
    try_mutate_milestones(paths, app_version, |ctx| {
        let m = ctx
            .milestones
            .iter_mut()
            .find(|m| m.id == id)
            .ok_or_else(|| NextUpError::NotFound(format!("milestone '{id}' not found")))?;
        if verified && !m.done {
            return Err(NextUpError::InvalidInput(
                "only a done milestone can be marked verified".into(),
            ));
        }
        m.verified = verified;
        let verb = if verified { "verified" } else { "verification cleared" };
        Ok(format!("milestone {verb}: {}", m.title))
    })
}

pub fn remove_milestone(paths: &WorkspacePaths, app_version: &str, id: &str) -> Result<ProjectContext> {
    let id = id.to_string();
    try_mutate_milestones(paths, app_version, |ctx| {
        let before = ctx.milestones.len();
        let title = ctx
            .milestones
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.title.clone())
            .unwrap_or_default();
        ctx.milestones.retain(|m| m.id != id);
        if ctx.milestones.len() == before {
            return Err(NextUpError::NotFound(format!("milestone '{id}' not found")));
        }
        Ok(format!("milestone removed: {title}"))
    })
}

fn mutate_milestones(
    paths: &WorkspacePaths,
    app_version: &str,
    change: impl FnOnce(&mut ProjectContext) -> String,
) -> Result<ProjectContext> {
    try_mutate_milestones(paths, app_version, |ctx| Ok(change(ctx)))
}

fn try_mutate_milestones(
    paths: &WorkspacePaths,
    app_version: &str,
    change: impl FnOnce(&mut ProjectContext) -> Result<String>,
) -> Result<ProjectContext> {
    mutate(paths, app_version, || {
        let mut ctx = load_context(&paths.context_file())?;
        let message = change(&mut ctx)?;
        ctx.updated_at = now_rfc3339();
        save_context(&paths.context_file(), &ctx)?;
        Ok((ctx, LedgerEvent::new(LedgerKind::MilestoneUpdated, message, None)))
    })
    .map(|(ctx, _)| ctx)
}

// ── Read aggregates ─────────────────────────────────────────────────────────

/// Compact harness position for status surfaces (`phase` is 1-based).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSummary {
    pub current_phase: String,
    pub completed: bool,
    pub can_advance: bool,
    pub phase: usize,
    pub total_phases: usize,
}

/// One-call workspace overview (context + task counts + harness position).
/// The shape lives here so every status surface (MCP hub, future CLI/GUI
/// aggregate) renders the same summary instead of hand-shaping its own.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub context: ProjectContext,
    pub task_counts: crate::workspace::tasks::TaskCounts,
    pub workflow: Option<WorkflowSummary>,
    /// Enabled capability modules (D31) — how agents and status surfaces
    /// discover that e.g. the collab tools apply to this workspace.
    pub modules: Vec<String>,
}

pub fn workspace_summary(paths: &WorkspacePaths) -> Result<WorkspaceSummary> {
    let context = crate::workspace::init::open_workspace(paths.root())?;
    let task_counts = crate::workspace::tasks::counts_for_dir(&paths.tasks_dir())?;
    let workflow = crate::workspace::workflow::try_evaluate(paths)?.map(|s| WorkflowSummary {
        current_phase: s.workflow.state.current_phase.clone(),
        completed: s.workflow.state.completed,
        can_advance: s.can_advance,
        phase: s.current_index + 1,
        total_phases: s.total_phases,
    });
    let modules = crate::workspace::modules::get_modules(paths)?.enabled;
    Ok(WorkspaceSummary { context, task_counts, workflow, modules })
}

// ── Workspace identity (D48) ────────────────────────────────────────────────

/// Return this workspace's stable id, minting and persisting one when the
/// context predates D48. Minting is an explicit write path (first team
/// reference) — `open_workspace` stays read-only (D41). Idempotent: once an
/// id exists this is a pure lock-free read and never logs.
pub fn ensure_workspace_id(paths: &WorkspacePaths, app_version: &str) -> Result<String> {
    if let Some(id) = load_context(&paths.context_file())?.workspace_id {
        return Ok(id);
    }
    with_mutation_lock(paths, || {
        let had = load_context(&paths.context_file())?.workspace_id.is_some();
        let id = ensure_workspace_id_locked(paths)?;
        if !had {
            generate_handoff(paths, app_version)?;
        }
        Ok(id)
    })
}

/// Lock-held inner mint, shared with `exchange::publish_delivery` (which
/// already holds the mutation lock — locked entry points must never nest).
/// Returns the existing id untouched; a mint persists and leaves the audit
/// line, but never regenerates the snapshot (callers do).
pub(crate) fn ensure_workspace_id_locked(paths: &WorkspacePaths) -> Result<String> {
    let mut ctx = load_context(&paths.context_file())?;
    if let Some(id) = ctx.workspace_id {
        return Ok(id);
    }
    let id = crate::workspace::ids::uuid_v4();
    ctx.workspace_id = Some(id.clone());
    ctx.updated_at = now_rfc3339();
    save_context(&paths.context_file(), &ctx)?;
    ledger_for(paths).append(&LedgerEvent::new(
        LedgerKind::WorkspaceIdAssigned,
        format!("stable workspace id {id} minted (pre-D48 workspace, first team reference)"),
        None,
    ))?;
    Ok(id)
}

// ── Secrets ─────────────────────────────────────────────────────────────────

/// Set/update a secret and ledger the change (name only — the value never
/// touches the ledger). The audit line lives here so *every* channel that can
/// change a secret leaves the same trail. Returns the refreshed name list.
pub fn set_secret(
    paths: &WorkspacePaths,
    keys: &dyn KeyProvider,
    name: &str,
    value: &str,
) -> Result<Vec<String>> {
    with_mutation_lock(paths, || {
        crate::security::secrets::set_secret(&paths.secrets_file(), keys, name, value)?;
        ledger_for(paths).append(&LedgerEvent::new(
            LedgerKind::SecretUpdated,
            format!("secret \"{}\" set/updated (value not logged)", name.trim()),
            None,
        ))?;
        crate::security::secrets::secret_names(&paths.secrets_file(), keys)
    })
}

/// Remove a secret (no-op if absent — only actual removals are ledgered).
/// Returns the refreshed name list.
pub fn remove_secret(
    paths: &WorkspacePaths,
    keys: &dyn KeyProvider,
    name: &str,
) -> Result<Vec<String>> {
    with_mutation_lock(paths, || {
        if crate::security::secrets::remove_secret(&paths.secrets_file(), keys, name)? {
            ledger_for(paths).append(&LedgerEvent::new(
                LedgerKind::SecretUpdated,
                format!("secret \"{name}\" removed"),
                None,
            ))?;
        }
        crate::security::secrets::secret_names(&paths.secrets_file(), keys)
    })
}

fn next_milestone_id(ctx: &ProjectContext) -> String {
    crate::workspace::ids::next_seq_id("M-", ctx.milestones.iter().map(|m| m.id.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::workspace::init::{initialize_project, InitProjectParams};
    use crate::workspace::ledger::Ledger;

    fn workspace() -> (tempfile::TempDir, WorkspacePaths) {
        let dir = tempfile::tempdir().unwrap();
        let params = InitProjectParams {
            root: dir.path().to_string_lossy().into_owned(),
            name: "ops-test".into(),
            domain: "coding".into(),
            description: String::new(),
            goals: vec![],
            boundaries: vec![],
            ..Default::default()
        };
        initialize_project(&params, &StaticKeyProvider([3u8; 32]), "0.1.0").unwrap();
        let paths = WorkspacePaths::new(dir.path());
        (dir, paths)
    }

    #[test]
    fn create_task_logs_ledger_event() {
        let (_g, paths) = workspace();
        let task = create_task(&paths, "0.1.0", NewTask { title: "wire IPC".into(), priority: 1, ..Default::default() },
        )
        .unwrap();

        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::TaskCreated, 5)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].task_id.as_deref(), Some(task.id.as_str()));
    }

    #[test]
    fn edit_task_ledgers_what_changed() {
        let (_g, paths) = workspace();
        let task = create_task(
            &paths,
            "0.1.0",
            NewTask { title: "teh feature".into(), priority: 2, ..Default::default() },
        )
        .unwrap();

        let updated = edit_task(
            &paths,
            "0.1.0",
            &task.id,
            TaskEdit {
                title: "the feature".into(),
                description: "with context".into(),
                priority: 0,
                tags: vec!["ui".into()],
            },
        )
        .unwrap();
        assert_eq!(updated.task.title, "the feature");
        assert!(updated.handoff.is_some(), "an edit refreshes the snapshot like any mutation");

        // The line must name the old title — it is the part the file no longer
        // holds after the edit.
        let events =
            Ledger::new(paths.ledger_file()).recent_of_kind(LedgerKind::TaskEdited, 5).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].task_id.as_deref(), Some(task.id.as_str()));
        let message = &events[0].message;
        assert!(message.contains("teh feature"), "old title must survive in the ledger: {message}");
        assert!(message.contains("P2 → P0"), "priority move must be spelled out: {message}");
        assert!(message.contains("tags: ui"), "new tag set must be listed: {message}");
        assert!(message.contains("description updated"), "{message}");
    }

    #[test]
    fn delete_task_keeps_the_title_in_the_ledger_and_refuses_with_dependents() {
        let (_g, paths) = workspace();
        let upstream = create_task(
            &paths,
            "0.1.0",
            NewTask { title: "prerequisite".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        let downstream = create_task(
            &paths,
            "0.1.0",
            NewTask {
                title: "builds on it".into(),
                depends_on: vec![upstream.id.clone()],
                ..Default::default()
            },
        )
        .unwrap();

        // Refused while depended upon — and the refusal names who is holding it.
        let err = delete_task(&paths, "0.1.0", &upstream.id).unwrap_err();
        assert_eq!(err.kind(), "has_dependents");
        assert!(err.to_string().contains(&downstream.id), "{err}");
        assert!(
            Ledger::new(paths.ledger_file())
                .recent_of_kind(LedgerKind::TaskDeleted, 5)
                .unwrap()
                .is_empty(),
            "a refused delete must not leave a deletion line"
        );

        // The leaf deletes cleanly, and the trail still says what it was.
        delete_task(&paths, "0.1.0", &downstream.id).unwrap();
        let events =
            Ledger::new(paths.ledger_file()).recent_of_kind(LedgerKind::TaskDeleted, 5).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].task_id.as_deref(), Some(downstream.id.as_str()));
        assert!(
            events[0].message.contains("builds on it"),
            "the deleted title must stay recoverable: {}",
            events[0].message
        );
        assert!(!paths.tasks_dir().join(format!("{}.json", downstream.id)).exists());

        // With the edge gone, the prerequisite can go too.
        delete_task(&paths, "0.1.0", &upstream.id).unwrap();
        assert_eq!(TaskStore::new(paths.tasks_dir()).list().unwrap().len(), 0);
    }

    /// The status-change write path must stamp the structured endpoints
    /// (D75). Locked here because every field-first consumer falls back to
    /// prose when the field is missing — dropping the stamp would not fail
    /// any consumer test, just silently re-freeze the wording contract.
    #[test]
    fn status_change_ledger_line_carries_structured_endpoints() {
        let (_g, paths) = workspace();
        let task = create_task(&paths, "0.1.0", NewTask { title: "t".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        update_task_status(&paths, "0.1.0", &task.id, TaskStatus::Blocked, Some("waiting".into()))
            .unwrap();

        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::TaskStatusChanged, 5)
            .unwrap();
        assert_eq!(events[0].from, Some(TaskStatus::Todo));
        assert_eq!(events[0].to, Some(TaskStatus::Blocked));
    }

    #[test]
    fn ensure_workspace_id_reads_fresh_and_backfills_legacy() {
        let (_g, paths) = workspace();

        // Fresh workspaces already carry an id from init — pure read, no log.
        let minted_at_init = ensure_workspace_id(&paths, "0.1.0").unwrap();
        assert_eq!(minted_at_init.len(), 36);
        let log = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::WorkspaceIdAssigned, 5)
            .unwrap();
        assert!(log.is_empty(), "an existing id must not be re-minted or logged");

        // Simulate a pre-D48 context: strip the id.
        let mut ctx = load_context(&paths.context_file()).unwrap();
        ctx.workspace_id = None;
        save_context(&paths.context_file(), &ctx).unwrap();

        let backfilled = ensure_workspace_id(&paths, "0.1.0").unwrap();
        assert_ne!(backfilled, minted_at_init, "a stripped context gets a fresh mint");
        assert_eq!(
            load_context(&paths.context_file()).unwrap().workspace_id.as_deref(),
            Some(backfilled.as_str()),
            "the mint is persisted"
        );
        let log = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::WorkspaceIdAssigned, 5)
            .unwrap();
        assert_eq!(log.len(), 1, "backfill leaves exactly one audit line");

        // Second call is idempotent: same id, still one audit line.
        assert_eq!(ensure_workspace_id(&paths, "0.1.0").unwrap(), backfilled);
        let log = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::WorkspaceIdAssigned, 5)
            .unwrap();
        assert_eq!(log.len(), 1);
    }

    #[test]
    fn archive_sweep_takes_only_verified_done_and_noop_ledgers_nothing() {
        let (_g, paths) = workspace();
        let verified = create_task(&paths, "0.1.0", NewTask { title: "shipped".into(), ..Default::default() }).unwrap();
        let unverified = create_task(&paths, "0.1.0", NewTask { title: "claimed".into(), ..Default::default() }).unwrap();
        let open = create_task(&paths, "0.1.0", NewTask { title: "open".into(), ..Default::default() }).unwrap();
        update_task_status(&paths, "0.1.0", &verified.id, TaskStatus::Done, None).unwrap();
        update_task_status(&paths, "0.1.0", &unverified.id, TaskStatus::Done, None).unwrap();
        set_task_verification(&paths, "0.1.0", &verified.id, true, Some("ran demo, exit 0".into()))
            .unwrap();

        // The sweep hides the verified claim only — verification debt and
        // open work stay visible.
        let swept = archive_verified_done_tasks(&paths, "0.1.0", None).unwrap();
        assert_eq!(swept, vec![verified.id.clone()]);
        let store = TaskStore::new(paths.tasks_dir());
        assert!(store.get(&verified.id).unwrap().archived);
        assert!(!store.get(&unverified.id).unwrap().archived);
        assert!(!store.get(&open.id).unwrap().archived);
        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::TaskArchived, 5)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0].message.contains(&verified.id));

        // Idempotent: a second sweep archives nothing and ledgers nothing.
        assert!(archive_verified_done_tasks(&paths, "0.1.0", None).unwrap().is_empty());
        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::TaskArchived, 5)
            .unwrap();
        assert_eq!(events.len(), 1);

        // Single un-archive brings it back and is audited.
        let update = set_task_archived(&paths, "0.1.0", &verified.id, false).unwrap();
        assert!(!update.task.archived);
        assert!(update.handoff.is_some());
    }

    /// D78: the auto sweep only shelves tasks whose verification has aged
    /// past the gate — fresh completions stay in takeover view. Injected
    /// clock (the doctor precedent) keeps this deterministic.
    #[test]
    fn auto_archive_age_gate_spares_fresh_verifications() {
        let (_g, paths) = workspace();
        let t = create_task(&paths, "0.1.0", NewTask { title: "shipped".into(), ..Default::default() }).unwrap();
        update_task_status(&paths, "0.1.0", &t.id, TaskStatus::Done, None).unwrap();
        set_task_verification(&paths, "0.1.0", &t.id, true, Some("ran demo".into())).unwrap();

        // Verified moments ago: a 7-day gate leaves it alone...
        let now = chrono::Utc::now();
        assert!(archive_verified_done_tasks_at(&paths, "0.1.0", Some(7), now).unwrap().is_empty());
        // ...but a clock 8 days later sweeps it, with the auto wording.
        let later = now + chrono::Duration::days(8);
        let swept = archive_verified_done_tasks_at(&paths, "0.1.0", Some(7), later).unwrap();
        assert_eq!(swept, vec![t.id.clone()]);
        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::TaskArchived, 5)
            .unwrap();
        assert!(events[0].message.starts_with("auto-archived"), "got: {}", events[0].message);
    }

    /// D78: the settings switch is honored — disabled means the open-time
    /// sweep is a guaranteed no-op; the default (missing file) sweeps.
    #[test]
    fn auto_archive_sweep_honors_settings_switch() {
        use crate::workspace::settings::{save_settings, AutoArchive, WorkspaceSettings, SETTINGS_SCHEMA_VERSION};
        let (_g, paths) = workspace();
        let t = create_task(&paths, "0.1.0", NewTask { title: "old win".into(), ..Default::default() }).unwrap();
        update_task_status(&paths, "0.1.0", &t.id, TaskStatus::Done, None).unwrap();
        set_task_verification(&paths, "0.1.0", &t.id, true, Some("observed".into())).unwrap();

        // Default settings (missing file): enabled with a 7-day gate, so a
        // just-verified task is not swept yet.
        assert!(auto_archive_sweep(&paths, "0.1.0").unwrap().is_empty());

        // days = 0 sweeps immediately; disabled never sweeps.
        save_settings(&paths, &WorkspaceSettings {
            schema_version: SETTINGS_SCHEMA_VERSION,
            auto_archive: AutoArchive { enabled: false, days: 0 },
        }).unwrap();
        assert!(auto_archive_sweep(&paths, "0.1.0").unwrap().is_empty());
        save_settings(&paths, &WorkspaceSettings {
            schema_version: SETTINGS_SCHEMA_VERSION,
            auto_archive: AutoArchive { enabled: true, days: 0 },
        }).unwrap();
        assert_eq!(auto_archive_sweep(&paths, "0.1.0").unwrap(), vec![t.id.clone()]);
    }

    #[test]
    fn done_transition_regenerates_handoff() {
        let (_g, paths) = workspace();
        let task = create_task(&paths, "0.1.0", NewTask { title: "finish core".into(), priority: 0, ..Default::default() },
        )
        .unwrap();

        let before = std::fs::read_to_string(paths.handoff_file()).unwrap();
        let update =
            update_task_status(&paths, "0.1.0", &task.id, TaskStatus::Done, None).unwrap();

        assert!(update.handoff.is_some(), "Done transition must refresh the handoff");
        let after = std::fs::read_to_string(paths.handoff_file()).unwrap();
        assert_ne!(before, after);
        assert!(after.contains("1 done"));
    }

    /// D24 continuity contract: every transition regenerates, not just Done —
    /// in-progress reorders section 3 and blocked feeds section 4.
    #[test]
    fn non_done_transition_also_regenerates_handoff() {
        let (_g, paths) = workspace();
        let task = create_task(&paths, "0.1.0", NewTask { title: "t".into(), priority: 0, ..Default::default() },
        )
        .unwrap();
        let update =
            update_task_status(&paths, "0.1.0", &task.id, TaskStatus::InProgress, None).unwrap();
        let snapshot = update.handoff.expect("every transition must refresh the handoff");
        assert!(snapshot.contains("▶"), "in-progress task must show in next steps");
        assert_eq!(std::fs::read_to_string(paths.handoff_file()).unwrap(), snapshot);
    }

    /// D24: a session that only records a decision still hands off fresh —
    /// the decision is in the snapshot file without any further trigger.
    #[test]
    fn decision_alone_refreshes_snapshot_on_disk() {
        let (_g, paths) = workspace();
        add_ledger_note(&paths, "0.1.0", NoteChannel::Decision, "we will index with SQLite FTS5").unwrap();
        let on_disk = std::fs::read_to_string(paths.handoff_file()).unwrap();
        assert!(on_disk.contains("we will index with SQLite FTS5"));
    }

    /// The blank-message rule lives in ops so the GUI and the agent hub can
    /// never drift apart on it.
    #[test]
    fn blank_notes_are_rejected_in_core() {
        let (_g, paths) = workspace();
        assert_eq!(add_ledger_note(&paths, "0.1.0", NoteChannel::Note, "   ").unwrap_err().kind(), "invalid_input");
        assert_eq!(add_ledger_note(&paths, "0.1.0", NoteChannel::Decision, "").unwrap_err().kind(), "invalid_input");
    }

    /// Secret changes must leave an audit line no matter which channel made
    /// them — the rule lives here, not in the delivery layers.
    #[test]
    fn secret_changes_are_ledgered_names_only() {
        let (_g, paths) = workspace();
        let keys = StaticKeyProvider([3u8; 32]);

        let names = set_secret(&paths, &keys, "API_KEY", "s3cret").unwrap();
        assert_eq!(names, vec!["API_KEY".to_string()]);
        let names = remove_secret(&paths, &keys, "API_KEY").unwrap();
        assert!(names.is_empty());
        // Removing a non-existent secret is a no-op and adds no audit line.
        remove_secret(&paths, &keys, "API_KEY").unwrap();

        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::SecretUpdated, 10)
            .unwrap();
        assert_eq!(events.len(), 2);
        assert!(events[0].message.contains("set/updated"));
        assert!(events[1].message.contains("removed"));
        for e in &events {
            assert!(!e.message.contains("s3cret"), "value must never reach the ledger");
        }
    }

    #[test]
    fn milestone_lifecycle_updates_context_and_ledger() {
        let (_g, paths) = workspace();
        let ctx = add_milestone(&paths, "0.1.0", "MVP launch").unwrap();
        assert_eq!(ctx.milestones.len(), 1);
        assert_eq!(ctx.milestones[0].id, "M-0001");
        assert!(!ctx.milestones[0].done);

        let ctx = set_milestone_done(&paths, "0.1.0", "M-0001", true).unwrap();
        assert!(ctx.milestones[0].done);

        let ctx = add_milestone(&paths, "0.1.0", "Second phase").unwrap();
        assert_eq!(ctx.milestones[1].id, "M-0002");

        let ctx = remove_milestone(&paths, "0.1.0", "M-0001").unwrap();
        assert_eq!(ctx.milestones.len(), 1);
        // Ids never recycle after deletion.
        let ctx2 = add_milestone(&paths, "0.1.0", "third").unwrap();
        assert_eq!(ctx2.milestones.last().unwrap().id, "M-0003");
        let _ = ctx;

        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::MilestoneUpdated, 10)
            .unwrap();
        assert_eq!(events.len(), 5);
        assert!(events[0].message.contains("added"));
        assert!(events[1].message.contains("done"));
        assert!(events[3].message.contains("removed"));
    }

    #[test]
    fn task_verification_ledgers_and_regenerates_handoff() {
        let (_g, paths) = workspace();
        let task = create_task(&paths, "0.1.0", NewTask { title: "ship feature".into(), priority: 0, ..Default::default() },
        )
        .unwrap();
        update_task_status(&paths, "0.1.0", &task.id, TaskStatus::Done, None).unwrap();

        let update = set_task_verification(
            &paths,
            "0.1.0",
            &task.id,
            true,
            Some("ran the app, feature works end to end".into()),
        )
        .unwrap();
        assert!(update.task.is_verified());
        let handoff = update.handoff.expect("verification must refresh the handoff");
        assert!(!handoff.contains(&format!("{} — ship feature", task.id)),
            "verified task must leave the unverified list");

        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::TaskVerificationChanged, 5)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0].message.contains("ran the app"));
        assert_eq!(events[0].task_id.as_deref(), Some(task.id.as_str()));

        // Clearing also ledgers and puts the task back on the unverified list.
        let update = set_task_verification(&paths, "0.1.0", &task.id, false, None).unwrap();
        assert!(!update.task.is_verified());
        assert!(update.handoff.unwrap().contains("ship feature"));
    }

    #[test]
    fn rejected_list_appends_ledgers_and_blocks_duplicates() {
        let (_g, paths) = workspace();
        let ctx = add_rejected(&paths, "0.1.0", "switch the index to sled", "unmaintained; rusqlite+FTS5 is already enough").unwrap();
        assert_eq!(ctx.rejected.len(), 1);
        assert_eq!(ctx.rejected[0].proposal, "switch the index to sled");

        // Same proposal again is refused — the list is the anti-re-pitch wall.
        let err = add_rejected(&paths, "0.1.0", "switch the index to sled", "a different reason").unwrap_err();
        assert_eq!(err.kind(), "invalid_input");

        // Missing why is refused: a reason-less rejection stops nobody.
        assert_eq!(add_rejected(&paths, "0.1.0", "x", "  ").unwrap_err().kind(), "invalid_input");
        assert_eq!(add_rejected(&paths, "0.1.0", " ", "y").unwrap_err().kind(), "invalid_input");

        // Ledgered under its own kind — not as a decision, which would let it
        // count toward min_decisions — and surfaced in the handoff header
        // section, which reads context.json and is unaffected by the split.
        let ledger = Ledger::new(paths.ledger_file());
        let rejections = ledger.recent_of_kind(LedgerKind::AlternativeRejected, 5).unwrap();
        assert!(rejections[0].message.contains("rejected alternative"));
        assert!(ledger.recent_of_kind(LedgerKind::Decision, 5).unwrap().is_empty());
        let md = generate_handoff(&paths, "0.1.0").unwrap();
        assert!(md.contains("Rejected alternatives"));
        assert!(md.contains("switch the index to sled — unmaintained"));
    }

    #[test]
    fn milestone_verification_requires_done_and_reopen_clears_it() {
        let (_g, paths) = workspace();
        add_milestone(&paths, "0.1.0", "beta release").unwrap();

        // Not done yet → cannot verify.
        assert_eq!(
            set_milestone_verified(&paths, "0.1.0", "M-0001", true).unwrap_err().kind(),
            "invalid_input"
        );

        set_milestone_done(&paths, "0.1.0", "M-0001", true).unwrap();
        let ctx = set_milestone_verified(&paths, "0.1.0", "M-0001", true).unwrap();
        assert!(ctx.milestones[0].verified);

        // Reopening voids the verification.
        let ctx = set_milestone_done(&paths, "0.1.0", "M-0001", false).unwrap();
        assert!(!ctx.milestones[0].verified);
    }

    /// Two workspace handles racing on create_task simulate the GUI app and an
    /// external nextup-mcp process: without the mutation lock, next_id() scans
    /// race and a later rename silently overwrites the earlier task.
    #[test]
    fn concurrent_task_creation_never_duplicates_ids() {
        let (_g, paths) = workspace();
        let root = paths.root().to_path_buf();
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let root = root.clone();
                std::thread::spawn(move || {
                    let paths = WorkspacePaths::new(root);
                    create_task(&paths, "0.1.0", NewTask {
                            title: format!("racer {i}"),
                            priority: 2,
                            ..Default::default()
                        },
                    )
                    .unwrap()
                })
            })
            .collect();

        let mut ids: Vec<String> =
            handles.into_iter().map(|h| h.join().unwrap().id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 8, "every concurrent create must allocate a distinct id");
        assert_eq!(TaskStore::new(paths.tasks_dir()).list().unwrap().len(), 8);
    }

    // ── Collaboration ops (D31) ─────────────────────────────────────────────

    fn collab_workspace() -> (tempfile::TempDir, WorkspacePaths) {
        let (g, paths) = workspace();
        crate::workspace::modules::set_module_enabled(
            &paths,
            crate::workspace::modules::MODULE_COLLAB,
            true,
        )
        .unwrap();
        (g, paths)
    }

    #[test]
    fn claim_is_module_gated() {
        let (_g, paths) = workspace(); // collab NOT enabled
        let t = create_task(&paths, "0.1.0", NewTask { title: "t".into(), ..Default::default() })
            .unwrap();
        let err = claim_task(&paths, "0.1.0", &t.id, "fe").unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("collab"), "must point at the module switch: {err}");
    }

    #[test]
    fn claim_sets_owner_and_may_not_steal() {
        let (_g, paths) = collab_workspace();
        let t = create_task(&paths, "0.1.0", NewTask { title: "t".into(), ..Default::default() })
            .unwrap();

        let update = claim_task(&paths, "0.1.0", &t.id, "fe").unwrap();
        assert_eq!(update.task.assignee.as_deref(), Some("fe"));
        assert!(update.handoff.is_some());

        // Re-claiming your own task is a quiet no-op.
        let again = claim_task(&paths, "0.1.0", &t.id, "fe").unwrap();
        assert!(again.handoff.is_none());

        // Someone else may not steal it — refusal is structured (D32).
        let err = claim_task(&paths, "0.1.0", &t.id, "data").unwrap_err();
        assert_eq!(err.kind(), "already_claimed");
        assert!(err.to_string().contains("fe"), "refusal must name the owner: {err}");
        assert_eq!(serde_json::to_value(&err).unwrap()["currentAssignee"], "fe");

        // Anonymous claiming is meaningless.
        assert_eq!(claim_task(&paths, "0.1.0", &t.id, "  ").unwrap_err().kind(), "invalid_input");

        // Exactly one claim event, stamped with the actor.
        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::TaskAssigneeChanged, 10)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].actor.as_deref(), Some("fe"));
        assert!(events[0].message.contains("claimed by fe"));
    }

    #[test]
    fn assign_overwrites_and_ledgers_each_handover() {
        let (_g, paths) = collab_workspace();
        let t = create_task(&paths, "0.1.0", NewTask { title: "t".into(), ..Default::default() })
            .unwrap();
        claim_task(&paths, "0.1.0", &t.id, "fe").unwrap();

        // The dispatcher may reassign over an existing claim…
        let update = assign_task(&paths, "0.1.0", &t.id, Some("data"), None).unwrap();
        assert_eq!(update.task.assignee.as_deref(), Some("data"));
        // …and unassign entirely.
        let update = assign_task(&paths, "0.1.0", &t.id, None, None).unwrap();
        assert_eq!(update.task.assignee, None);
        // Same-value assignment changes nothing and is not ledgered.
        let update = assign_task(&paths, "0.1.0", &t.id, None, None).unwrap();
        assert!(update.handoff.is_none());

        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::TaskAssigneeChanged, 10)
            .unwrap();
        assert_eq!(events.len(), 3, "claim + reassign + unassign, no-op excluded");
        assert!(events[1].message.contains("assigned to data"));
        assert!(events[2].message.contains("unassigned"));
    }

    /// Two agents racing to claim the same task across two workspace handles:
    /// the CAS under the mutation lock must let exactly one win.
    #[test]
    fn concurrent_claims_have_exactly_one_winner() {
        let (_g, paths) = collab_workspace();
        let t = create_task(&paths, "0.1.0", NewTask { title: "hot".into(), ..Default::default() })
            .unwrap();
        let root = paths.root().to_path_buf();

        let handles: Vec<_> = ["fe", "data", "integ", "design"]
            .into_iter()
            .map(|agent| {
                let root = root.clone();
                let id = t.id.clone();
                std::thread::spawn(move || {
                    let paths = WorkspacePaths::new(root);
                    claim_task(&paths, "0.1.0", &id, agent).is_ok()
                })
            })
            .collect();

        let wins = handles.into_iter().map(|h| h.join().unwrap()).filter(|ok| *ok).count();
        assert_eq!(wins, 1, "exactly one racer may claim the task");
        let owner =
            TaskStore::new(paths.tasks_dir()).get(&t.id).unwrap().assignee;
        assert!(owner.is_some());
    }

    #[test]
    fn summary_reports_enabled_modules() {
        let (_g, paths) = collab_workspace();
        let summary = workspace_summary(&paths).unwrap();
        assert_eq!(summary.modules, vec!["collab".to_string()]);
    }

    #[test]
    fn milestone_errors_are_clean() {
        let (_g, paths) = workspace();
        assert_eq!(add_milestone(&paths, "0.1.0", "  ").unwrap_err().kind(), "invalid_input");
        assert_eq!(set_milestone_done(&paths, "0.1.0", "M-9999", true).unwrap_err().kind(), "not_found");
        assert_eq!(remove_milestone(&paths, "0.1.0", "M-9999").unwrap_err().kind(), "not_found");
    }

    // ── Spec layer: fold on archive (D79) ───────────────────────────────

    const DELTA_OK: &str = "## ADDED Requirements\n\n### Requirement: 匯出\n必須支援匯出。\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n";
    const DELTA_CONFLICT: &str = "## MODIFIED Requirements\n\n### Requirement: Ghost\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n";

    fn write_delta(paths: &WorkspacePaths, task_id: &str, capability: &str, content: &str) {
        let dir = paths.task_delta_specs_dir(task_id).join(capability);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("spec.md"), content).unwrap();
    }

    fn done_task(paths: &WorkspacePaths, title: &str, verified: bool) -> Task {
        let t = create_task(
            paths,
            "0.1.0",
            NewTask { title: title.into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        update_task_status(paths, "0.1.0", &t.id, TaskStatus::Done, None).unwrap();
        if verified {
            set_task_verification(paths, "0.1.0", &t.id, true, Some("ran it".into())).unwrap().task
        } else {
            TaskStore::new(paths.tasks_dir()).get(&t.id).unwrap()
        }
    }

    fn spec_folded_lines(paths: &WorkspacePaths) -> Vec<LedgerEvent> {
        Ledger::new(paths.ledger_file()).recent_of_kind(LedgerKind::SpecFolded, 20).unwrap()
    }

    #[test]
    fn archive_with_deltas_requires_verification() {
        let (_g, paths) = workspace();
        let t = done_task(&paths, "spec work", false);
        write_delta(&paths, &t.id, "export", DELTA_OK);
        let err = set_task_archived(&paths, "0.1.0", &t.id, true).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("verify"), "{err}");
        assert!(!paths.spec_file("export").exists(), "refusal writes nothing");
        assert!(!TaskStore::new(paths.tasks_dir()).get(&t.id).unwrap().archived);
        // A task without deltas keeps the plain D40 semantics: unverified
        // done archives fine.
        let plain = done_task(&paths, "plain", false);
        assert!(set_task_archived(&paths, "0.1.0", &plain.id, true).unwrap().task.archived);
        // Non-done + delta: the archive refusal keeps its own message — the
        // fold steps aside instead of pointing at verification, which is a
        // dead end for non-done tasks (batch ② review).
        let open = create_task(
            &paths,
            "0.1.0",
            NewTask { title: "open".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        write_delta(&paths, &open.id, "export", DELTA_OK);
        let err = set_task_archived(&paths, "0.1.0", &open.id, true).unwrap_err();
        assert!(err.to_string().contains("only a done task can be archived"), "{err}");
    }

    #[test]
    fn archive_folds_writes_spec_stamps_marker_and_ledgers() {
        let (_g, paths) = workspace();
        let t = done_task(&paths, "spec work", true);
        write_delta(&paths, &t.id, "export", DELTA_OK);
        let updated = set_task_archived(&paths, "0.1.0", &t.id, true).unwrap().task;
        assert!(updated.archived);
        assert!(updated.spec_folded_at.is_some(), "fold stamped before archive");
        let spec = std::fs::read_to_string(paths.spec_file("export")).unwrap();
        assert!(spec.contains("### Requirement: 匯出"), "{spec}");
        assert!(spec.contains("## Requirements"), "new capability gets the skeleton");
        let lines = spec_folded_lines(&paths);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].task_id.as_deref(), Some(t.id.as_str()));
        assert!(lines[0].message.contains("export"), "{}", lines[0].message);
        assert!(lines[0].message.contains("+1 ~0 -0"), "{}", lines[0].message);
    }

    #[test]
    fn archive_fold_conflict_is_structured_and_writes_nothing() {
        let (_g, paths) = workspace();
        std::fs::create_dir_all(paths.spec_file("export").parent().unwrap()).unwrap();
        let before = "# export Specification\n\n## Requirements\n\n### Requirement: A\n必須。\n\n#### Scenario: s\n- **WHEN** x\n";
        std::fs::write(paths.spec_file("export"), before).unwrap();
        let t = done_task(&paths, "broken delta", true);
        write_delta(&paths, &t.id, "export", DELTA_CONFLICT);
        let err = set_task_archived(&paths, "0.1.0", &t.id, true).unwrap_err();
        assert_eq!(err.kind(), "spec_fold_conflict");
        assert!(err.to_string().contains("Ghost"), "{err}");
        assert_eq!(std::fs::read_to_string(paths.spec_file("export")).unwrap(), before);
        let after = TaskStore::new(paths.tasks_dir()).get(&t.id).unwrap();
        assert!(!after.archived);
        assert!(after.spec_folded_at.is_none());
        assert!(spec_folded_lines(&paths).is_empty());
    }

    #[test]
    fn unarchive_then_rearchive_skips_the_refold() {
        let (_g, paths) = workspace();
        let t = done_task(&paths, "spec work", true);
        write_delta(&paths, &t.id, "export", DELTA_OK);
        set_task_archived(&paths, "0.1.0", &t.id, true).unwrap();
        set_task_archived(&paths, "0.1.0", &t.id, false).unwrap();
        let again = set_task_archived(&paths, "0.1.0", &t.id, true).unwrap().task;
        assert!(again.archived);
        assert_eq!(spec_folded_lines(&paths).len(), 1, "marker survives un-archive: no refold");
    }

    #[test]
    fn reopening_clears_the_marker_and_the_next_archive_folds_new_edits() {
        let (_g, paths) = workspace();
        let t = done_task(&paths, "spec work", true);
        write_delta(&paths, &t.id, "export", DELTA_OK);
        set_task_archived(&paths, "0.1.0", &t.id, true).unwrap();

        // Reopen: engine clears archived + verification + fold marker.
        update_task_status(&paths, "0.1.0", &t.id, TaskStatus::InProgress, None).unwrap();
        let reopened = TaskStore::new(paths.tasks_dir()).get(&t.id).unwrap();
        assert!(reopened.spec_folded_at.is_none(), "leaving done clears the fold marker");

        // The bundle grows a second requirement; the old one early-syncs.
        let two = format!("{DELTA_OK}\n### Requirement: 匯入\n必須支援匯入。\n\n#### Scenario: s2\n- **WHEN** x\n- **THEN** y\n");
        write_delta(&paths, &t.id, "export", &two);
        update_task_status(&paths, "0.1.0", &t.id, TaskStatus::Done, None).unwrap();
        set_task_verification(&paths, "0.1.0", &t.id, true, Some("re-ran".into())).unwrap();
        set_task_archived(&paths, "0.1.0", &t.id, true).unwrap();

        let spec = std::fs::read_to_string(paths.spec_file("export")).unwrap();
        assert!(spec.contains("### Requirement: 匯出") && spec.contains("### Requirement: 匯入"), "{spec}");
        assert_eq!(spec.matches("### Requirement: 匯出").count(), 1, "no duplicate from the refold");
        assert_eq!(spec_folded_lines(&paths).len(), 2, "one fold per archive cycle");
    }

    #[test]
    fn bulk_archive_skips_conflicted_tasks_and_stays_zero_write_when_only_conflicts_remain() {
        let (_g, paths) = workspace();
        let good = done_task(&paths, "clean", true);
        write_delta(&paths, &good.id, "export", DELTA_OK);
        let bad = done_task(&paths, "conflicted", true);
        write_delta(&paths, &bad.id, "billing", DELTA_CONFLICT);

        let swept = archive_verified_done_tasks(&paths, "0.1.0", None).unwrap();
        assert_eq!(swept, vec![good.id.clone()]);
        assert!(paths.spec_file("export").exists());
        assert!(!paths.spec_file("billing").exists(), "conflicted bundle wrote nothing");
        assert!(
            !paths.specs_dir().join("billing").exists(),
            "not even the capability directory — validation precedes any disk touch"
        );
        assert!(!TaskStore::new(paths.tasks_dir()).get(&bad.id).unwrap().archived);
        assert_eq!(spec_folded_lines(&paths).len(), 1);

        // Second sweep: only the conflicted task remains — the terminal
        // circle must be zero-write (invariant 3): no archive, no fold
        // line, no new ledger rows at all.
        let ledger_rows_before =
            Ledger::new(paths.ledger_file()).recent(100).unwrap().len();
        let swept = archive_verified_done_tasks(&paths, "0.1.0", None).unwrap();
        assert!(swept.is_empty());
        assert_eq!(
            Ledger::new(paths.ledger_file()).recent(100).unwrap().len(),
            ledger_rows_before,
            "a conflict-only sweep appends nothing"
        );
    }

    #[test]
    fn bulk_archive_skips_unreadable_bundles_without_aborting_the_sweep() {
        let (_g, paths) = workspace();
        let good = done_task(&paths, "clean", true);
        write_delta(&paths, &good.id, "export", DELTA_OK);
        let bad = done_task(&paths, "big5 delta", true);
        let dir = paths.task_delta_specs_dir(&bad.id).join("billing");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("spec.md"), [0xa4u8, 0xa4, 0xa4, 0xe5]).unwrap(); // Big5 bytes

        let swept = archive_verified_done_tasks(&paths, "0.1.0", None).unwrap();
        assert_eq!(swept, vec![good.id.clone()], "one bad bundle must not abort the sweep");
        // The mid-abort of the batch ② review left neither of these: the
        // aggregate archived line and the regenerated snapshot both land.
        let archived_lines =
            Ledger::new(paths.ledger_file()).recent_of_kind(LedgerKind::TaskArchived, 5).unwrap();
        assert_eq!(archived_lines.len(), 1);
        assert!(!TaskStore::new(paths.tasks_dir()).get(&bad.id).unwrap().archived);
    }

    #[test]
    fn delete_task_removes_the_artifact_bundle() {
        let (_g, paths) = workspace();
        let t = create_task(
            &paths,
            "0.1.0",
            NewTask { title: "bundled".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        write_delta(&paths, &t.id, "export", DELTA_OK);
        std::fs::write(paths.task_artifact_dir(&t.id).join("proposal.md"), "why").unwrap();
        delete_task(&paths, "0.1.0", &t.id).unwrap();
        assert!(!paths.task_artifact_dir(&t.id).exists(), "bundle goes with the task file");
    }

    #[test]
    fn state_block_carries_the_spec_layer_line_only_when_the_module_is_on() {
        let (_g, paths) = workspace();
        let t = done_task(&paths, "spec work", true);
        write_delta(&paths, &t.id, "export", DELTA_OK);
        set_task_archived(&paths, "0.1.0", &t.id, true).unwrap();
        // Module off: even with a folded capability on disk, no line.
        let claude = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(!claude.contains("Spec layer"), "module off ⇒ no spec line");

        crate::workspace::modules::set_module_enabled(
            &paths,
            crate::workspace::modules::MODULE_SPECS,
            true,
        )
        .unwrap();
        // Any mutation resyncs the surfaces (D24).
        add_ledger_note(&paths, "0.1.0", crate::workspace::ops::NoteChannel::Note, "n").unwrap();
        let claude = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(claude.contains("**Spec layer**: 1 capabilities"), "{claude}");
    }

    /// D79 batch 4 review, W5: the pending-folds panel op. A task with a bundle lists,
    /// one without stays out, a broken bundle degrades to its own `ok: false`
    /// report instead of sinking the list, and folded tasks drop off.
    #[test]
    fn pending_spec_folds_lists_contains_and_skips() {
        let (_g, paths) = workspace();
        let with = create_task(
            &paths,
            "0.1.0",
            NewTask { title: "has delta".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        write_delta(&paths, &with.id, "export", DELTA_OK);
        let _without = create_task(
            &paths,
            "0.1.0",
            NewTask { title: "no delta".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        let broken = create_task(
            &paths,
            "0.1.0",
            NewTask { title: "busted delta".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        let dir = paths.task_delta_specs_dir(&broken.id).join("busted");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("spec.md"), [0xffu8, 0xfe]).unwrap();

        let reports = pending_spec_folds(&paths).unwrap();
        let ids: Vec<&str> = reports.iter().map(|r| r.task_id.as_str()).collect();
        assert_eq!(ids, vec![with.id.as_str(), broken.id.as_str()], "bundle-less task stays out");
        assert!(reports[0].ok);
        assert!(!reports[1].ok, "broken bundle degrades to its own report");
        assert!(reports[1].problems[0].contains("UTF-8"), "{:?}", reports[1].problems);

        // Folded (here: via the real archive) → off the panel.
        update_task_status(&paths, "0.1.0", &with.id, TaskStatus::Done, None).unwrap();
        set_task_verification(&paths, "0.1.0", &with.id, true, Some("ran".into())).unwrap();
        set_task_archived(&paths, "0.1.0", &with.id, true).unwrap();
        let reports = pending_spec_folds(&paths).unwrap();
        let ids: Vec<&str> = reports.iter().map(|r| r.task_id.as_str()).collect();
        assert_eq!(ids, vec![broken.id.as_str()], "folded task drops off the panel");
    }
}
