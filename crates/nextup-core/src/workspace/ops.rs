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

use serde::{Deserialize, Serialize};

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
        let specs_hash = if verified { attested_specs_hash(paths, id)? } else { None };
        let task =
            TaskStore::new(paths.tasks_dir()).set_verification(id, verified, note, specs_hash)?;
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

/// The delta-bundle hash a verification attests (D149).
///
/// Stamped whenever the spec module is on — including over an empty bundle,
/// so a delta *added* after verification is caught as well as one edited. With
/// the module off it is stamped only when a bundle exists: such a workspace has
/// no use for deltas, and every verified task there would otherwise carry a
/// hash of nothing.
fn attested_specs_hash(paths: &WorkspacePaths, id: &str) -> Result<Option<String>> {
    // Before the id is joined into a path below (the store checks it too,
    // but only after this runs).
    crate::workspace::tasks::validate_task_id(id)?;
    let has_bundle = paths.task_delta_specs_dir(id).is_dir();
    let specs_on = crate::workspace::modules::get_modules(paths)?
        .is_enabled(crate::workspace::modules::MODULE_SPECS);
    if !specs_on && !has_bundle {
        return Ok(None);
    }
    specs::task_bundle_hash(paths, id).map(Some)
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
    edit_task_with(paths, app_version, id, |_| edit)
}

/// The fields an agent wants changed, and only those (the hub `edit_task`
/// tool, D149). The GUI sends a whole form; an agent names what it means to
/// change, and a missing field must mean "leave it", never "blank it".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub priority: Option<u8>,
    pub tags: Option<Vec<String>>,
}

/// [`edit_task`] for a partial change. The merge happens under the same lock
/// as the write, so a GUI edit landing between an agent's read and its write
/// is never overwritten with values read before it.
pub fn patch_task(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
    patch: TaskPatch,
) -> Result<TaskUpdate> {
    if patch.title.is_none()
        && patch.description.is_none()
        && patch.priority.is_none()
        && patch.tags.is_none()
    {
        return Err(NextUpError::InvalidInput(
            "nothing to change — pass at least one of title, description, priority, tags".into(),
        ));
    }
    edit_task_with(paths, app_version, id, |before| TaskEdit {
        title: patch.title.unwrap_or_else(|| before.title.clone()),
        description: patch.description.unwrap_or_else(|| before.description.clone()),
        priority: patch.priority.unwrap_or(before.priority),
        tags: patch.tags.unwrap_or_else(|| before.tags.clone()),
    })
}

fn edit_task_with(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
    make: impl FnOnce(&Task) -> TaskEdit,
) -> Result<TaskUpdate> {
    mutate(paths, app_version, || {
        let store = TaskStore::new(paths.tasks_dir());
        let before = store.get(id)?;
        let task = store.edit(id, make(&before))?;

        let mut changes = Vec::new();
        if before.title != task.title {
            changes.push(format!("title \"{}\" → \"{}\"", before.title, task.title));
        }
        if before.description != task.description {
            // The description is where acceptance criteria live, and once an
            // agent can rewrite it unattended (edit_task, D149) "updated" alone
            // leaves no way to tell which text a later verification was
            // checked against. The full text stays out of the ledger (it can
            // run long); the hashes tie the line to a copy in git history.
            changes.push(format!(
                "description updated (sha256 {} → {})",
                short_sha256(before.description.as_bytes()),
                short_sha256(task.description.as_bytes())
            ));
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

/// Largest task artifact the hub writes (D149): twice the doctor's warning
/// size for a main spec. A proposal may run longer than a spec, but a file
/// past this is not an artifact anyone will read through.
pub const TASK_FILE_MAX_BYTES: usize = 64 * 1024;

/// Which artifact a `write_task_file` path names. The whole accepted set:
/// anything else is refused before a path is ever joined, which is also what
/// keeps `../` out (the capability goes through the slug rule).
enum TaskFile {
    Prose(&'static str),
    Delta(String),
}

impl TaskFile {
    fn parse(path: &str) -> Result<Self> {
        let segments: Vec<&str> = path.split(['/', '\\']).collect();
        match segments.as_slice() {
            ["proposal.md"] => Ok(TaskFile::Prose("proposal.md")),
            ["design.md"] => Ok(TaskFile::Prose("design.md")),
            ["specs", capability, "spec.md"] => {
                specs::validate_capability_name(capability)?;
                Ok(TaskFile::Delta((*capability).to_string()))
            }
            _ => Err(NextUpError::InvalidInput(format!(
                "path must be proposal.md, design.md or specs/<capability>/spec.md, relative to \
                 the task's own folder — got '{path}'"
            ))),
        }
    }

    fn rel(&self) -> String {
        match self {
            TaskFile::Prose(name) => (*name).to_string(),
            TaskFile::Delta(capability) => format!("specs/{capability}/spec.md"),
        }
    }
}

/// What `write_task_file` did, plus what the agent should know about it now
/// rather than at archive time.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileWrite {
    pub task_id: String,
    /// Workspace-relative, forward slashes: `tasks/T-0003/specs/auth/spec.md`.
    pub path: String,
    pub deleted: bool,
    pub bytes: usize,
    /// For a delta: the dry-run `validate_task_specs` would return for the
    /// whole bundle as it stands after this write. A format problem does not
    /// stop the write — drafts are written in pieces — it is reported here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specs: Option<specs::TaskSpecsReport>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Write or delete one file in a task's artifact bundle (`tasks/<id>/`) — the
/// hub `write_task_file` tool (D149).
///
/// Exists so an agent running unattended needs no write access to `tasks/`
/// at all: a caller fencing files can make `.nextup/`, `tasks/` and `specs/`
/// read-only with plain folder rules, which every sandbox can express, instead
/// of a wildcard separating `T-0001.json` from `T-0001/` that some cannot
/// (Codex's Windows sandbox, 2026-11). Those three are not the whole fence —
/// `.mcp.json`, `.claude/` and `.git/hooks/` decide what runs next time,
/// outside any sandbox (2026-11-09 security review). Writing through here also
/// leaves the audit line that a file edit never does. Interactive sessions may
/// go on writing the files directly; nothing about the bundle's format changes.
///
/// Refused: an archived task (its bundle is closed); a delta for a task whose
/// bundle was already folded (the edit would never fold — it needs the task
/// reopened, which clears the marker, or a new task); a delta for a task that
/// is verified but carries no record of what was verified (the fold could not
/// tell the edit apart); and content with control characters other than tab
/// and line breaks.
pub fn write_task_file(
    paths: &WorkspacePaths,
    app_version: &str,
    task_id: &str,
    path: &str,
    content: Option<String>,
) -> Result<TaskFileWrite> {
    crate::workspace::modules::require_module(paths, crate::workspace::modules::MODULE_SPECS)?;
    // The id is joined into the bundle path as much as `path` is, and checking
    // only `path` is exactly what let `../.` through (2026-11-09 report). The
    // store's `get` below checks again and also refuses a copied task file.
    crate::workspace::tasks::validate_task_id(task_id)?;
    let file = TaskFile::parse(path)?;
    if let Some(text) = &content {
        if text.len() > TASK_FILE_MAX_BYTES {
            return Err(NextUpError::InvalidInput(format!(
                "{} is {} KB — the limit is {} KB; split the change or trim it",
                file.rel(),
                text.len() / 1024,
                TASK_FILE_MAX_BYTES / 1024
            )));
        }
        // Artifacts are plain text. A NUL once let one delta impersonate two in
        // the bundle hash (security review F1, fixed in the framing too), and
        // nothing a person reads shows control characters — so text that can
        // hide content from the reviewer is refused at the door.
        if let Some(at) = text.find(|c: char| c.is_control() && !matches!(c, '\t' | '\n' | '\r')) {
            let code = text[at..].chars().next().map(u32::from).unwrap_or_default();
            return Err(NextUpError::InvalidInput(format!(
                "{} contains the control character U+{code:04X} at byte {at} — task artifacts \
                 are plain text",
                file.rel()
            )));
        }
    }
    let is_delta = matches!(file, TaskFile::Delta(_));
    let (mut out, _) = mutate(paths, app_version, || {
        let task = TaskStore::new(paths.tasks_dir()).get(task_id)?;
        if task.archived {
            return Err(NextUpError::InvalidInput(format!(
                "{task_id} is archived — its artifact bundle is closed; open a new task for new work"
            )));
        }
        if is_delta && task.spec_folded_at.is_some() {
            return Err(NextUpError::InvalidInput(format!(
                "{task_id}'s delta specs were already folded into specs/, so an edit here would \
                 never fold — reopen the task (which clears the fold) or open a new task"
            )));
        }
        // Verified, but before the engine recorded what a verification covers
        // (or while the spec module was off): the fold has nothing to compare,
        // so a delta written now would be folded as if checked. A warning
        // could not stop that — the archive sweep runs unattended (security
        // review F2). The person clears the verification; then it can be
        // written and verified again, which records the hash.
        if is_delta && task.is_verified() && task.verified_specs_hash.is_none() {
            return Err(NextUpError::InvalidInput(format!(
                "{task_id} is verified, but its verification predates any record of which delta \
                 it covered, so archiving could not tell this change was never checked — ask the \
                 user to clear its verification first, then write the delta and have it verified \
                 again"
            )));
        }
        let rel = format!("tasks/{task_id}/{}", file.rel());
        let abs = match &file {
            TaskFile::Prose(name) => paths.task_artifact_dir(task_id).join(name),
            TaskFile::Delta(capability) => paths
                .task_delta_specs_dir(task_id)
                .join(capability)
                .join(crate::workspace::layout::SPEC_FILE),
        };
        let (deleted, bytes, what) = match &content {
            Some(text) => {
                if let Some(parent) = abs.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                crate::workspace::atomic::atomic_write(&abs, text.as_bytes())?;
                let what = format!(
                    "wrote {rel} ({} bytes, sha256 {})",
                    text.len(),
                    short_sha256(text.as_bytes())
                );
                (false, text.len(), what)
            }
            None => {
                if !abs.is_file() {
                    return Err(NextUpError::NotFound(format!("{rel} does not exist")));
                }
                std::fs::remove_file(&abs)?;
                // An empty capability folder is invisible to the fold (it
                // lists folders holding a spec.md) but not to a person
                // browsing the bundle; best effort, a leftover is harmless.
                if is_delta {
                    if let Some(parent) = abs.parent() {
                        let _ = std::fs::remove_dir(parent);
                    }
                }
                (true, 0, format!("deleted {rel}"))
            }
        };
        let event = LedgerEvent::new(
            LedgerKind::TaskEdited,
            format!("\"{}\": {what}", task.title),
            Some(task.id.clone()),
        );
        // Nothing after the write may fail: the file has already changed, and
        // an error here would skip the ledger line while the hub records the
        // call as failed — the audit trail saying the opposite of what
        // happened (security review F5). A re-hash that cannot read the
        // bundle becomes a warning instead.
        let warnings = match &task.verified_specs_hash {
            Some(attested) if is_delta && task.is_verified() => {
                match specs::task_bundle_hash(paths, task_id) {
                    Ok(now) if now == *attested => Vec::new(),
                    Ok(_) => vec![format!(
                        "{task_id} is verified, and its verification covers the bundle as it was: \
                         archiving will refuse these delta specs until the task is verified again"
                    )],
                    Err(e) => vec![format!(
                        "the write landed, but the bundle could not be re-read to compare it with \
                         the verification ({e}); archiving will make that comparison itself"
                    )],
                }
            }
            _ => Vec::new(),
        };
        let out = TaskFileWrite {
            task_id: task.id.clone(),
            path: rel,
            deleted,
            bytes,
            specs: None,
            warnings,
        };
        Ok((out, event))
    })?;
    if is_delta {
        // Read-only, after the lock: the write has landed either way, and a
        // problem reading the main specs is something to report, not a
        // reason to tell the agent its write failed.
        match specs::dry_run_task_specs(paths, task_id) {
            Ok(report) => out.specs = Some(report),
            Err(e) => out.warnings.push(format!("could not dry-run the fold: {e}")),
        }
    }
    Ok(out)
}

fn short_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().take(6).map(|b| format!("{b:02x}")).collect()
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
    /// Requirements the user chose to give up rather than fold (D129). Named
    /// rather than counted: "we decided not to apply this" is a fact someone
    /// may need to look up later, and a number cannot answer that.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<String>,
}

/// Fold a task's delta bundle into the main specs — the only fold entry
/// point (D79, nextup_docs/15 §4.2). Dry-runs every capability first and
/// writes only when the whole bundle validates (`fold_batch` is
/// prepare-all), then stamps `spec_folded_at`. `Ok(None)` = nothing to do
/// (no bundle, or already folded). Callers hold the mutation lock.
fn fold_task_specs(paths: &WorkspacePaths, task: &Task) -> Result<Option<SpecFoldSummary>> {
    fold_task_specs_skipping(paths, task, &[])
}

/// [`fold_task_specs`] with named requirements given up (D129 escape hatch).
fn fold_task_specs_skipping(
    paths: &WorkspacePaths,
    task: &Task,
    skip: &[(String, String)],
) -> Result<Option<SpecFoldSummary>> {
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
    // The verification attested one version of the bundle; folding another
    // would put text nobody checked into the source of truth — and the
    // workspace-open sweep would do it unattended (D149). A task verified
    // before the hash existed has nothing to compare and folds as it did.
    let folding_hash = specs::delta_bundle_hash(&deltas);
    if task.verified_specs_hash.as_deref().is_some_and(|attested| attested != folding_hash) {
        return Err(NextUpError::InvalidInput(format!(
            "{} delta specs changed after the task was verified — clear its verification and \
             verify it again before archiving: archiving folds them into specs/, and the \
             verification only covers the version that was checked",
            task.id
        )));
    }
    // A newer task may have folded its own rewrite of the same requirement
    // while this one sat unarchived. `fold` cannot see that — a MODIFIED that
    // still matches by name looks exactly like a legitimate edit — so this
    // delta would overwrite the newer text with no conflict, no warning and
    // no trace (D129). Checked here rather than inside `fold` because it is
    // the only layer that knows about other tasks at all.
    let others: Vec<(String, bool)> = TaskStore::new(paths.tasks_dir())
        .list()?
        .into_iter()
        .map(|t| (t.id, t.spec_folded_at.is_some()))
        .collect();
    let blocking: Vec<String> = specs::cross_task_overlaps(paths, &task.id, &others)?
        .iter()
        .filter(|o| o.blocks_fold() && !skip.iter().any(|(c, r)| *c == o.capability && *r == o.requirement))
        .map(specs::overlap_block_message)
        .collect();
    if !blocking.is_empty() {
        return Err(NextUpError::SpecFoldConflict { id: task.id.clone(), conflicts: blocking });
    }
    let outcomes = specs::plan_task_fold_skipping(paths, &deltas, skip)?
        .map_err(|conflicts| NextUpError::SpecFoldConflict { id: task.id.clone(), conflicts })?;
    let mut summary = SpecFoldSummary {
        capabilities: Vec::new(),
        added: 0,
        modified: 0,
        removed: 0,
        renamed: 0,
        skipped: Vec::new(),
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
        summary.skipped.extend(out.skipped.iter().cloned());
    }
    // `specs/` has changed from here on, so the ledger says so before anything
    // else can fail. It used to be written by the callers after the marker
    // below — a task file held open by another process (a read handle that
    // denies writes is enough) failed the marker and left the main spec
    // rewritten with no ledger line at all (2026-11-09 security review, F4).
    // If the marker does fail, the next archive re-folds as an already-synced
    // no-op and the task catches up.
    ledger_for(paths).append(&spec_folded_event(task, &summary))?;
    TaskStore::new(paths.tasks_dir()).set_spec_folded(
        &task.id,
        Some(now_rfc3339()),
        Some(folding_hash),
    )?;
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
                overlaps: Vec::new(),
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
    archive_inner(paths, app_version, id, archived, &[])
}

/// Archive, giving up the named requirements instead of folding them (D129).
///
/// The user-facing escape hatch for the one case the engine refuses: a newer
/// task already folded its own version of a requirement this task also
/// rewrites. Re-writing the delta is the better answer and the error says so —
/// but it needs the agent that wrote it, and a user who has decided this
/// task's wording is simply obsolete should not have to hand-edit a delta file
/// to say so. `skip` is `(capability, requirement)`; the rest of the bundle
/// folds as usual and the given-up names are reported back.
pub fn set_task_archived_skipping_specs(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
    skip: &[(String, String)],
) -> Result<TaskUpdate> {
    // Skipping only ever makes sense while archiving — un-archiving folds
    // nothing, so there is nothing to give up.
    archive_inner(paths, app_version, id, true, skip)
}

fn archive_inner(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
    archived: bool,
    skip: &[(String, String)],
) -> Result<TaskUpdate> {
    with_mutation_lock(paths, || {
        let store = TaskStore::new(paths.tasks_dir());
        let mut folded = None;
        if archived {
            let task = store.get(id)?;
            // The fold ledgers its own line, the moment specs/ changes.
            folded = fold_task_specs_skipping(paths, &task, skip)?;
        }
        let task = store.set_archived(id, archived)?;
        let verb = if archived { "archived" } else { "unarchived" };
        ledger_for(paths).append(&LedgerEvent::new(
            LedgerKind::TaskArchived,
            format!("\"{}\" {verb}", task.title),
            Some(task.id.clone()),
        ))?;
        let handoff = Some(generate_handoff(paths, app_version)?);
        Ok(TaskUpdate { task, handoff, spec_fold: folded })
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
                    // The fold ledgers its own line when it changes specs/.
                    Ok(_) => {}
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
                // Same rule for the archive write itself: one task file held
                // open by another process used to abort the whole sweep here,
                // after earlier tasks were already archived and before their
                // summary line and the snapshot — the exact state the comment
                // above exists to prevent (2026-11-09 security review, F4).
                // Skipped tasks are retried on the next sweep.
                if store.set_archived(&task.id, true).is_err() {
                    continue;
                }
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
    add_ledger_entry(paths, app_version, channel, message, None)
}

/// Record a decision, optionally naming an earlier decision it overturns.
///
/// Supersession is appended, not stamped backwards: the new line carries
/// `supersedes`, and readers project the superseded set. The delivery-envelope
/// shape (D87 — engine writes `superseded_by` onto the old envelope inside the
/// same lock) is right for a mutable JSON file and wrong here, because editing
/// a ledger line after the fact is exactly what the append-only contract
/// exists to prevent.
///
/// Naming a decision that something already overturned is allowed. The
/// projection is a set, so a second mention changes nothing, and refusing it
/// would mean the engine deciding which supersession chain is the real one —
/// a judgement it has no basis for.
pub fn add_decision(
    paths: &WorkspacePaths,
    app_version: &str,
    message: &str,
    supersedes: Option<&str>,
) -> Result<LedgerEvent> {
    add_ledger_entry(paths, app_version, NoteChannel::Decision, message, supersedes)
}

fn add_ledger_entry(
    paths: &WorkspacePaths,
    app_version: &str,
    channel: NoteChannel,
    message: &str,
    supersedes: Option<&str>,
) -> Result<LedgerEvent> {
    let message = message.trim();
    if message.is_empty() {
        return Err(NextUpError::InvalidInput("message cannot be empty".into()));
    }
    let supersedes = supersedes.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    mutate(paths, app_version, || {
        let mut event = LedgerEvent::new(channel.kind(), message, None);
        if channel.kind() == LedgerKind::Decision {
            // Inside the mutation lock and before the append, so two concurrent
            // writers cannot be handed the same number.
            let ledger = ledger_for(paths);
            if let Some(target) = supersedes.as_deref() {
                if ledger.decision(target)?.is_none() {
                    return Err(NextUpError::InvalidInput(format!(
                        "cannot supersede {target}: no decision in this workspace carries that id \
                         (decision ids look like D-0001 and appear next to each decision in the \
                         handoff snapshot; decisions recorded before this feature have none and \
                         cannot be superseded)"
                    )));
                }
            }
            event = event.with_id(ledger.next_decision_id()?).superseding(supersedes.clone());
        }
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

/// The part of context.json a person may change after creation (D142): the
/// four fields that *describe* the project. `None` leaves a field alone.
///
/// Deliberately not here: the name (four copies — team graph, sent envelopes,
/// rendered curriculum, registry — each needing its own answer), the workspace
/// id (teams resolve members by it), milestones and the rejected list (their
/// own ops own them; agents append to `rejected` at any time), and the
/// timestamps. A partial edit is the point: the editor never writes a whole
/// `ProjectContext` back, so a field it does not know about cannot be lost.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEdit {
    pub domain: Option<String>,
    pub description: Option<String>,
    pub goals: Option<Vec<String>>,
    pub boundaries: Option<Vec<String>>,
}

/// Apply a [`ContextEdit`]: read-modify-write under the workspace lock, one
/// `context_edited` ledger line naming what changed. Human-only — there is no
/// hub tool for this, because goals and boundaries are the rules an agent
/// works under, and an agent rewriting its own rules is the thing the ledger
/// line is there to make visible, not to enable.
///
/// Normalised the way init normalises them, so an edited project and a fresh
/// one cannot disagree about shape: trimmed text, one entry per non-empty
/// line, and a blank domain written as `general` — the one word for "nobody
/// said" (D137). An edit that changes nothing writes nothing.
pub fn edit_context(paths: &WorkspacePaths, app_version: &str, edit: ContextEdit) -> Result<ProjectContext> {
    let domain = edit.domain.map(|d| match d.trim() {
        "" => "general".to_string(),
        d => d.to_string(),
    });
    let description = edit.description.map(|d| d.trim().to_string());
    let goals = edit.goals.map(|g| crate::workspace::init::clean_lines(&g));
    let boundaries = edit.boundaries.map(|b| crate::workspace::init::clean_lines(&b));

    let apply = |ctx: &mut ProjectContext| -> Vec<String> {
        let mut changed = Vec::new();
        if let Some(d) = &domain {
            if *d != ctx.domain {
                changed.push(format!("domain ({} → {d})", ctx.domain));
                ctx.domain = d.clone();
            }
        }
        if let Some(d) = &description {
            if *d != ctx.description {
                ctx.description = d.clone();
                changed.push("description".into());
            }
        }
        if let Some(g) = &goals {
            if *g != ctx.goals {
                ctx.goals = g.clone();
                changed.push("goals".into());
            }
        }
        if let Some(b) = &boundaries {
            if *b != ctx.boundaries {
                ctx.boundaries = b.clone();
                changed.push("boundaries".into());
            }
        }
        changed
    };

    // A no-op save is not an event: answer from disk without taking the lock
    // or touching the ledger.
    let mut current = load_context(&paths.context_file())?;
    if apply(&mut current).is_empty() {
        return load_context(&paths.context_file());
    }
    mutate(paths, app_version, || {
        let mut ctx = load_context(&paths.context_file())?;
        let changed = apply(&mut ctx);
        if changed.is_empty() {
            // Someone else wrote the same values between the check and the lock.
            return Err(NextUpError::InvalidInput("nothing to change".into()));
        }
        ctx.updated_at = now_rfc3339();
        save_context(&paths.context_file(), &ctx)?;
        let event = LedgerEvent::new(
            LedgerKind::ContextEdited,
            format!("project context edited: {}", changed.join(", ")),
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

    /// Decisions get a workspace-local id so a later one can point at them.
    /// Notes and progress do not: they are not things anything needs to
    /// reverse, and handing every ledger line an id would make the file
    /// bigger for no reader.
    #[test]
    fn decisions_get_sequential_ids_and_other_channels_do_not() {
        let (_g, paths) = workspace();
        let first = add_decision(&paths, "0.1.0", "use sled", None).unwrap();
        let second = add_decision(&paths, "0.1.0", "index with FTS5", None).unwrap();
        assert_eq!(first.id.as_deref(), Some("D-0001"));
        assert_eq!(second.id.as_deref(), Some("D-0002"));
        let note = add_ledger_note(&paths, "0.1.0", NoteChannel::Note, "n").unwrap();
        let progress = add_ledger_note(&paths, "0.1.0", NoteChannel::Progress, "p").unwrap();
        assert_eq!(note.id, None);
        assert_eq!(progress.id, None);
    }

    /// The point of the whole feature: the superseded decision is still in the
    /// record — the ledger is append-only and a decision that was made stays
    /// made — but the snapshot the next session reads says it no longer holds.
    #[test]
    fn superseding_marks_the_old_decision_without_removing_it() {
        let (_g, paths) = workspace();
        let old = add_decision(&paths, "0.1.0", "store state in sled", None).unwrap();
        let new =
            add_decision(&paths, "0.1.0", "files are the source of truth", old.id.as_deref())
                .unwrap();
        assert_eq!(new.supersedes.as_deref(), Some("D-0001"));

        let snapshot = std::fs::read_to_string(paths.handoff_file()).unwrap();
        assert!(snapshot.contains("store state in sled"), "the old decision is kept, not dropped");
        assert!(
            snapshot.contains("SUPERSEDED by D-0002"),
            "the old decision must be marked, or the next session acts on it:\n{snapshot}"
        );
        // and the ledger line itself was never edited
        let old_line = ledger_for(&paths)
            .decision("D-0001")
            .unwrap()
            .expect("the superseded decision is still a ledger line");
        assert_eq!(old_line.message, old.message);
        assert_eq!(old_line.supersedes, None, "supersession is recorded forwards, never stamped back");
    }

    /// Naming an id that does not exist is the likely agent mistake here
    /// (guessing a number instead of reading one off the snapshot), so it
    /// fails loudly rather than recording a decision that claims to reverse
    /// something it does not.
    #[test]
    fn superseding_an_unknown_decision_is_rejected() {
        let (_g, paths) = workspace();
        add_decision(&paths, "0.1.0", "a real decision", None).unwrap();
        let err = add_decision(&paths, "0.1.0", "reverses nothing", Some("D-0099")).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        // and nothing was written
        assert_eq!(ledger_for(&paths).decisions().unwrap().len(), 1);
    }

    /// Two sessions may overturn the same decision for different reasons;
    /// both are real events and the snapshot names both.
    #[test]
    fn a_decision_can_be_superseded_more_than_once() {
        let (_g, paths) = workspace();
        add_decision(&paths, "0.1.0", "original call", None).unwrap();
        add_decision(&paths, "0.1.0", "first reversal", Some("D-0001")).unwrap();
        add_decision(&paths, "0.1.0", "second reversal", Some("D-0001")).unwrap();
        let snapshot = std::fs::read_to_string(paths.handoff_file()).unwrap();
        assert!(snapshot.contains("SUPERSEDED by D-0002, D-0003"), "{snapshot}");
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
    fn edit_context_changes_only_named_fields_and_ledgers_them() {
        let (_g, paths) = workspace();
        // Things the editor must never drop, because it never writes them.
        add_rejected(&paths, "0.1.0", "use sled", "unmaintained").unwrap();
        add_milestone(&paths, "0.1.0", "beta").unwrap();
        let before = load_context(&paths.context_file()).unwrap();

        let ctx = edit_context(
            &paths,
            "0.1.0",
            ContextEdit {
                domain: Some("  research ".into()),
                goals: Some(vec!["  read papers ".into(), "".into(), "write it up".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(ctx.domain, "research");
        assert_eq!(ctx.goals, vec!["read papers", "write it up"]);
        // Untouched fields, and everything outside the four, survive as they were.
        assert_eq!(ctx.description, before.description);
        assert_eq!(ctx.boundaries, before.boundaries);
        assert_eq!(ctx.name, before.name);
        assert_eq!(ctx.workspace_id, before.workspace_id);
        assert_eq!(ctx.rejected, before.rejected);
        assert_eq!(ctx.milestones, before.milestones);
        assert_eq!(ctx.created_at, before.created_at);
        assert_eq!(load_context(&paths.context_file()).unwrap(), ctx, "what came back is what is on disk");

        let ledger = Ledger::new(paths.ledger_file());
        let lines = ledger.recent_of_kind(LedgerKind::ContextEdited, 5).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].message, "project context edited: domain (coding → research), goals");

        // The takeover surface follows: the snapshot is regenerated by mutate.
        let md = generate_handoff(&paths, "0.1.0").unwrap();
        assert!(md.contains("read papers"));
    }

    #[test]
    fn edit_context_without_a_change_writes_nothing() {
        let (_g, paths) = workspace();
        let before = load_context(&paths.context_file()).unwrap();
        // Same values, differently padded, are the same values.
        let ctx = edit_context(
            &paths,
            "0.1.0",
            ContextEdit { domain: Some(" coding ".into()), goals: Some(vec![" ".into()]), ..Default::default() },
        )
        .unwrap();
        assert_eq!(ctx, before, "updatedAt untouched too");
        let ledger = Ledger::new(paths.ledger_file());
        assert!(ledger.recent_of_kind(LedgerKind::ContextEdited, 5).unwrap().is_empty());
    }

    #[test]
    fn edit_context_blank_domain_is_general() {
        let (_g, paths) = workspace();
        let ctx = edit_context(&paths, "0.1.0", ContextEdit { domain: Some("   ".into()), ..Default::default() }).unwrap();
        assert_eq!(ctx.domain, "general", "the word the UI hides, same as init (D137)");
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

    /// The scenario that exposed this (D129): A is done with a delta but not
    /// archived; B is created later for a new requirement, touches the same
    /// requirement, and archives first. A's delta was written against the text
    /// B has since replaced — folding it would overwrite B's wording with an
    /// older rewrite, and before this check that happened silently: `fold`
    /// reported no conflict, no warning, no no-op.
    #[test]
    fn older_task_cannot_silently_overwrite_a_newer_folded_requirement() {
        let (_g, paths) = workspace();
        let a = done_task(&paths, "A: earlier work", true);
        write_delta(&paths, &a.id, "export", DELTA_OK);
        // A folds nothing yet — it stays unarchived.

        let b = done_task(&paths, "B: the new requirement", true);
        write_delta(&paths, &b.id, "export", DELTA_OK);
        set_task_archived(&paths, "0.1.0", &b.id, true).unwrap();
        let after_b = std::fs::read_to_string(paths.spec_file("export")).unwrap();

        let err = set_task_archived(&paths, "0.1.0", &a.id, true).unwrap_err();
        assert_eq!(err.kind(), "spec_fold_conflict");
        assert!(err.to_string().contains(&b.id), "names the task that got there first: {err}");
        assert!(err.to_string().contains("匯出"), "names the requirement: {err}");
        assert_eq!(
            std::fs::read_to_string(paths.spec_file("export")).unwrap(),
            after_b,
            "a refused fold writes nothing"
        );
        assert!(!TaskStore::new(paths.tasks_dir()).get(&a.id).unwrap().archived);
    }

    /// The other direction is the project's rule, not a conflict: a NEWER task
    /// carrying the later requirement folds over an older one that already
    /// went in. That is the ordinary "we changed our minds later" path and
    /// must stay frictionless.
    #[test]
    fn newer_task_folds_over_an_older_folded_requirement() {
        let (_g, paths) = workspace();
        let a = done_task(&paths, "A: earlier", true);
        write_delta(&paths, &a.id, "export", DELTA_OK);
        set_task_archived(&paths, "0.1.0", &a.id, true).unwrap();

        let b = done_task(&paths, "B: later", true);
        write_delta(
            &paths,
            &b.id,
            "export",
            "## MODIFIED Requirements\n\n### Requirement: 匯出\n必須支援匯出與匯入。\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n",
        );
        let updated = set_task_archived(&paths, "0.1.0", &b.id, true).unwrap().task;
        assert!(updated.archived, "the newer task is not blocked by the older one");
        assert!(std::fs::read_to_string(paths.spec_file("export")).unwrap().contains("匯入"));
    }

    /// Both still unarchived: nothing is wrong yet, but whoever archives
    /// second will be stopped — so the dry-run says so while the agent that
    /// wrote the delta is still around to merge the two.
    #[test]
    fn dry_run_warns_about_an_unfolded_overlap_before_it_becomes_a_conflict() {
        let (_g, paths) = workspace();
        let a = done_task(&paths, "A", true);
        write_delta(&paths, &a.id, "export", DELTA_OK);
        let b = done_task(&paths, "B", true);
        write_delta(&paths, &b.id, "export", DELTA_OK);

        let report = specs::dry_run_task_specs(&paths, &a.id).unwrap();
        assert!(report.ok, "an unfolded overlap is a warning, not a blocker");
        assert_eq!(report.overlaps.len(), 1);
        assert_eq!(report.overlaps[0].other_task, b.id);
        assert!(!report.overlaps[0].other_folded);
        assert!(report.warnings.iter().any(|w| w.contains(&b.id)), "{:?}", report.warnings);
    }

    /// The escape hatch (layer ③): give up just the contested requirement and
    /// archive. Everything else in the bundle still folds, and what was given
    /// up is named rather than quietly missing.
    #[test]
    fn skipping_the_contested_requirement_archives_and_keeps_the_rest() {
        let (_g, paths) = workspace();
        let a = done_task(&paths, "A", true);
        write_delta(&paths, &a.id, "export", DELTA_OK);
        write_delta(&paths, &a.id, "report", DELTA_OK);
        let b = done_task(&paths, "B", true);
        write_delta(&paths, &b.id, "export", DELTA_OK);
        set_task_archived(&paths, "0.1.0", &b.id, true).unwrap();

        set_task_archived(&paths, "0.1.0", &a.id, true).unwrap_err();
        let update = set_task_archived_skipping_specs(
            &paths,
            "0.1.0",
            &a.id,
            &[("export".to_string(), "匯出".to_string())],
        )
        .unwrap();
        assert!(update.task.archived);
        // the other capability in the same bundle still folded
        assert!(paths.spec_file("report").exists(), "unrelated capability still folds");
        let summary = update.spec_fold.expect("a fold happened");
        assert_eq!(summary.skipped, vec!["匯出".to_string()], "what was given up is named");
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

    // ── D149: what a verification covers, and task contents after creation ──

    fn enable_specs(paths: &WorkspacePaths) {
        crate::workspace::modules::set_module_enabled(
            paths,
            crate::workspace::modules::MODULE_SPECS,
            true,
        )
        .unwrap();
    }

    fn todo_task(paths: &WorkspacePaths, title: &str) -> Task {
        create_task(paths, "0.1.0", NewTask { title: title.into(), priority: 1, ..Default::default() })
            .unwrap()
    }

    const DELTA_EDITED: &str = "## ADDED Requirements\n\n### Requirement: 匯出\n必須支援匯出，且不得超過一秒。\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n";

    /// The gap the loop-nextup proposal asked about: a delta edited after the
    /// user verified the task used to fold unseen — through the archive
    /// button and, worse, through the workspace-open sweep with nobody
    /// pressing anything.
    #[test]
    fn a_delta_changed_after_verification_refuses_the_fold_until_verified_again() {
        let (_g, paths) = workspace();
        let t = done_task(&paths, "spec work", false);
        write_delta(&paths, &t.id, "export", DELTA_OK);
        let verified =
            set_task_verification(&paths, "0.1.0", &t.id, true, Some("ran it".into())).unwrap().task;
        assert!(verified.verified_specs_hash.is_some(), "a bundle exists, so the hash is stamped");
        write_delta(&paths, &t.id, "export", DELTA_EDITED);

        let err = set_task_archived(&paths, "0.1.0", &t.id, true).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("changed after the task was verified"), "{err}");
        assert!(!paths.spec_file("export").exists(), "refusal writes nothing");

        // The sweep skips it instead of folding the unseen text.
        let swept = archive_verified_done_tasks(&paths, "0.1.0", None).unwrap();
        assert!(swept.is_empty(), "{swept:?}");
        assert!(!paths.spec_file("export").exists());

        // Verifying again covers the new version, and it folds.
        set_task_verification(&paths, "0.1.0", &t.id, true, Some("re-ran it".into())).unwrap();
        let update = set_task_archived(&paths, "0.1.0", &t.id, true).unwrap();
        assert!(update.spec_fold.is_some());
        let spec = std::fs::read_to_string(paths.spec_file("export")).unwrap();
        assert!(spec.contains("不得超過一秒"), "{spec}");
        let folded = TaskStore::new(paths.tasks_dir()).get(&t.id).unwrap();
        assert_eq!(
            folded.spec_folded_hash.as_deref(),
            Some(specs::task_bundle_hash(&paths, &t.id).unwrap().as_str()),
            "the fold records what it folded"
        );
    }

    /// With the spec module on, verifying a task with no bundle still records
    /// what was verified — nothing — so a delta added afterwards is caught.
    /// With it off nothing is stamped, and the fold behaves as it always did.
    #[test]
    fn a_delta_added_after_verifying_no_bundle_is_caught_only_where_specs_are_in_use() {
        let (_g, paths) = workspace();
        enable_specs(&paths);
        let t = done_task(&paths, "verified first", true);
        assert!(t.verified_specs_hash.is_some());
        write_delta(&paths, &t.id, "export", DELTA_OK);
        let err = set_task_archived(&paths, "0.1.0", &t.id, true).unwrap_err();
        assert!(err.to_string().contains("changed after the task was verified"), "{err}");

        let (_g2, plain) = workspace();
        let t = done_task(&plain, "verified first", true);
        assert_eq!(t.verified_specs_hash, None, "spec module off and no bundle: nothing stamped");
        write_delta(&plain, &t.id, "export", DELTA_OK);
        assert!(set_task_archived(&plain, "0.1.0", &t.id, true).unwrap().spec_fold.is_some());
    }

    /// The same text checked out with CRLF and a BOM (git on Windows, some
    /// editors) is the same bundle — a hash that differed between machines
    /// would refuse folds there for nothing. The parser drops the BOM as the
    /// hash does (security review F3), so this folds.
    #[test]
    fn a_crlf_checkout_of_the_verified_bundle_still_folds() {
        let (_g, paths) = workspace();
        let t = done_task(&paths, "spec work", false);
        write_delta(&paths, &t.id, "export", DELTA_OK);
        set_task_verification(&paths, "0.1.0", &t.id, true, Some("ran it".into())).unwrap();
        write_delta(&paths, &t.id, "export", &format!("\u{feff}{}", DELTA_OK.replace('\n', "\r\n")));
        assert!(set_task_archived(&paths, "0.1.0", &t.id, true).unwrap().spec_fold.is_some());
    }

    /// A status change clears both hashes along with the marks they belong to.
    #[test]
    fn reopening_clears_the_verification_and_fold_hashes() {
        let (_g, paths) = workspace();
        let t = done_task(&paths, "spec work", false);
        write_delta(&paths, &t.id, "export", DELTA_OK);
        set_task_verification(&paths, "0.1.0", &t.id, true, Some("ran it".into())).unwrap();
        set_task_archived(&paths, "0.1.0", &t.id, true).unwrap();
        let reopened =
            update_task_status(&paths, "0.1.0", &t.id, TaskStatus::InProgress, None).unwrap().task;
        assert_eq!(reopened.verified_specs_hash, None);
        assert_eq!(reopened.spec_folded_hash, None);
        assert_eq!(reopened.spec_folded_at, None);
    }

    #[test]
    fn write_task_file_writes_the_bundle_ledgers_it_and_reports_the_dry_run() {
        let (_g, paths) = workspace();
        enable_specs(&paths);
        let t = todo_task(&paths, "export");

        let out =
            write_task_file(&paths, "0.1.0", &t.id, "proposal.md", Some("why\n".into())).unwrap();
        assert_eq!(out.path, format!("tasks/{}/proposal.md", t.id));
        assert!(out.specs.is_none(), "prose is not dry-run");
        let proposal = paths.task_artifact_dir(&t.id).join("proposal.md");
        assert_eq!(std::fs::read_to_string(proposal).unwrap(), "why\n");

        // A delta that does not fold yet is still written; the problem comes back.
        let out = write_task_file(
            &paths,
            "0.1.0",
            &t.id,
            "specs/billing/spec.md",
            Some(DELTA_CONFLICT.into()),
        )
        .unwrap();
        let report = out.specs.expect("a delta is dry-run");
        assert!(!report.ok && !report.problems.is_empty(), "{report:?}");
        // Backslashes from a Windows agent name the same file.
        let out = write_task_file(
            &paths,
            "0.1.0",
            &t.id,
            "specs\\billing\\spec.md",
            Some(DELTA_OK.into()),
        )
        .unwrap();
        assert!(out.specs.unwrap().ok);

        let lines =
            Ledger::new(paths.ledger_file()).recent_of_kind(LedgerKind::TaskEdited, 10).unwrap();
        let wrote = format!("wrote tasks/{}/specs/billing/spec.md", t.id);
        assert!(
            lines.iter().any(|e| e.message.contains(&wrote)
                && e.message.contains("sha256 ")
                && e.task_id.as_deref() == Some(t.id.as_str())),
            "{lines:?}"
        );

        // Deleting removes the file and the now-empty capability folder.
        let out = write_task_file(&paths, "0.1.0", &t.id, "specs/billing/spec.md", None).unwrap();
        assert!(out.deleted);
        assert!(!paths.task_delta_specs_dir(&t.id).join("billing").exists());
        let err =
            write_task_file(&paths, "0.1.0", &t.id, "specs/billing/spec.md", None).unwrap_err();
        assert_eq!(err.kind(), "not_found");
    }

    #[test]
    fn write_task_file_accepts_only_the_three_artifact_shapes() {
        let (_g, paths) = workspace();
        enable_specs(&paths);
        let t = todo_task(&paths, "export");
        for path in [
            "../T-0001.json",
            "notes.md",
            "/proposal.md",
            "Proposal.md",
            "specs/../../../evil/spec.md",
            "specs/a/b/spec.md",
            "specs/Not A Slug/spec.md",
            "specs/export/notes.md",
            "",
        ] {
            let err = write_task_file(&paths, "0.1.0", &t.id, path, Some("x".into())).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{path}: {err}");
        }
        assert!(!paths.task_artifact_dir(&t.id).exists(), "no refusal created anything");
        let too_big = "x".repeat(TASK_FILE_MAX_BYTES + 1);
        let err = write_task_file(&paths, "0.1.0", &t.id, "design.md", Some(too_big)).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        let err =
            write_task_file(&paths, "0.1.0", "T-0404", "design.md", Some("x".into())).unwrap_err();
        assert_eq!(err.kind(), "not_found");

        let (_g2, plain) = workspace();
        let t = todo_task(&plain, "export");
        let err = write_task_file(&plain, "0.1.0", &t.id, "design.md", Some("x".into())).unwrap_err();
        assert!(err.to_string().contains("'specs' module"), "{err}");
    }

    #[test]
    fn write_task_file_refuses_closed_bundles_and_warns_on_verified_tasks() {
        let (_g, paths) = workspace();
        enable_specs(&paths);
        let t = done_task(&paths, "spec work", false);
        write_delta(&paths, &t.id, "export", DELTA_OK);
        set_task_verification(&paths, "0.1.0", &t.id, true, Some("ran it".into())).unwrap();

        // Verified: written, with the warning that archiving will now refuse.
        let out = write_task_file(
            &paths,
            "0.1.0",
            &t.id,
            "specs/export/spec.md",
            Some(DELTA_EDITED.into()),
        )
        .unwrap();
        assert!(out.warnings.iter().any(|w| w.contains("verified again")), "{:?}", out.warnings);
        // Prose is not folded, so it carries no such warning.
        let out = write_task_file(&paths, "0.1.0", &t.id, "design.md", Some("d\n".into())).unwrap();
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);

        // Folded, then un-archived: a delta edit would never fold again.
        set_task_verification(&paths, "0.1.0", &t.id, true, Some("re-ran".into())).unwrap();
        set_task_archived(&paths, "0.1.0", &t.id, true).unwrap();
        let err =
            write_task_file(&paths, "0.1.0", &t.id, "design.md", Some("x".into())).unwrap_err();
        assert!(err.to_string().contains("archived"), "{err}");
        set_task_archived(&paths, "0.1.0", &t.id, false).unwrap();
        let err = write_task_file(
            &paths,
            "0.1.0",
            &t.id,
            "specs/export/spec.md",
            Some(DELTA_OK.into()),
        )
        .unwrap_err();
        assert!(err.to_string().contains("already folded"), "{err}");
        assert!(write_task_file(&paths, "0.1.0", &t.id, "design.md", Some("x".into())).is_ok());
    }

    /// Reported 2026-11-09 against 3e9432c: the task id was joined into paths
    /// unchecked. `tasks/{id}.json` with id `../.` reads `<ws>/..json`, while
    /// `tasks/{id}/specs/…` resolves to `<ws>/specs/…` — the main spec. An
    /// agent fenced off `tasks/` and `specs/` but free to write the workspace
    /// root could plant a copied task file there and have the hub (which runs
    /// outside the agent's sandbox) overwrite or delete a main spec, ledgered
    /// under the copied task's title.
    #[test]
    fn a_task_id_cannot_steer_write_task_file_out_of_the_tasks_folder() {
        let (_g, paths) = workspace();
        enable_specs(&paths);
        let t = todo_task(&paths, "export");
        std::fs::create_dir_all(paths.spec_file("export").parent().unwrap()).unwrap();
        std::fs::write(paths.spec_file("export"), "ORIGINAL").unwrap();
        std::fs::copy(
            paths.tasks_dir().join(format!("{}.json", t.id)),
            paths.root().join("..json"),
        )
        .unwrap();

        for id in ["../.", "..\\.", "../T-0001", "T-0001/..", "", "t-0001", "T-", "T-12a"] {
            for content in [Some("PWNED".to_string()), None] {
                let err = write_task_file(&paths, "0.1.0", id, "specs/export/spec.md", content)
                    .unwrap_err();
                assert_eq!(err.kind(), "invalid_input", "{id:?}: {err}");
            }
        }
        assert_eq!(std::fs::read_to_string(paths.spec_file("export")).unwrap(), "ORIGINAL");
    }

    #[test]
    fn patch_task_changes_only_what_it_names_and_keeps_the_verification() {
        let (_g, paths) = workspace();
        let t = create_task(
            &paths,
            "0.1.0",
            NewTask {
                title: "export".into(),
                description: "csv".into(),
                priority: 1,
                tags: vec!["io".into()],
                ..Default::default()
            },
        )
        .unwrap();
        update_task_status(&paths, "0.1.0", &t.id, TaskStatus::Done, None).unwrap();
        set_task_verification(&paths, "0.1.0", &t.id, true, Some("ran".into())).unwrap();

        let task = patch_task(
            &paths,
            "0.1.0",
            &t.id,
            TaskPatch { title: Some("export to CSV".into()), ..Default::default() },
        )
        .unwrap()
        .task;
        assert_eq!(task.title, "export to CSV");
        assert_eq!((task.description.as_str(), task.priority), ("csv", 1));
        assert_eq!(task.tags, vec!["io".to_string()]);
        assert!(task.is_verified(), "wording fixes do not un-check the work");

        let task = patch_task(
            &paths,
            "0.1.0",
            &t.id,
            TaskPatch { tags: Some(vec![]), ..Default::default() },
        )
        .unwrap()
        .task;
        assert!(task.tags.is_empty(), "an explicit empty list clears the tags");
        assert_eq!(task.title, "export to CSV");

        let err = patch_task(&paths, "0.1.0", &t.id, TaskPatch::default()).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        let lines =
            Ledger::new(paths.ledger_file()).recent_of_kind(LedgerKind::TaskEdited, 10).unwrap();
        assert!(
            lines.iter().any(|e| e.message.contains("title \"export\" → \"export to CSV\"")),
            "{lines:?}"
        );

        // A rewritten description — where acceptance criteria live — is tied
        // to both versions by hash, so a later reader can tell which text a
        // verification was checked against.
        patch_task(
            &paths,
            "0.1.0",
            &t.id,
            TaskPatch { description: Some("csv, and done when it opens in Excel".into()), ..Default::default() },
        )
        .unwrap();
        let lines =
            Ledger::new(paths.ledger_file()).recent_of_kind(LedgerKind::TaskEdited, 1).unwrap();
        let expected = format!(
            "description updated (sha256 {} → {})",
            short_sha256(b"csv"),
            short_sha256("csv, and done when it opens in Excel".as_bytes())
        );
        assert!(lines[0].message.contains(&expected), "{}", lines[0].message);
    }

    // ── 2026-11-09 security review of the D149 write surface (F1–F5) ──
    // Each of these was first a passing exploit in the reviewer's worktree;
    // the asserts below are the safe outcomes. Findings in full:
    // nextup_docs/reviews/d149-write-surface-security-review-2026-11.md.

    /// F1: a NUL let one delta impersonate two in the bundle hash. The framing
    /// is fixed in `specs` (unit-tested there); text that can hide content
    /// from the person reviewing it is also refused at the door.
    #[test]
    fn write_task_file_refuses_control_characters_but_keeps_tabs_and_line_breaks() {
        let (_g, paths) = workspace();
        enable_specs(&paths);
        let t = todo_task(&paths, "export");
        for bad in ["a\0b", "a\u{7}b", "a\u{1b}[2Jb", "a\u{7f}b"] {
            let err = write_task_file(&paths, "0.1.0", &t.id, "specs/a/spec.md", Some(bad.into()))
                .unwrap_err();
            assert!(err.to_string().contains("control character"), "{bad:?}: {err}");
        }
        assert!(!paths.task_artifact_dir(&t.id).exists());
        let fine = "## ADDED Requirements\r\n\r\n### Requirement: x\r\n\tMUST.\r\n";
        assert!(write_task_file(&paths, "0.1.0", &t.id, "design.md", Some(fine.into())).is_ok());
    }

    /// F2: a task verified with no hash (before D149, or with the spec module
    /// off) gave the fold nothing to compare, and the hub only warned — the
    /// sweep then folded the new delta unattended.
    #[test]
    fn a_delta_cannot_be_added_through_the_hub_to_a_task_verified_without_a_hash() {
        let (_g, paths) = workspace(); // spec module off while verifying
        let t = done_task(&paths, "old, verified work", true);
        assert_eq!(t.verified_specs_hash, None);
        enable_specs(&paths);

        let err = write_task_file(&paths, "0.1.0", &t.id, "specs/auth/spec.md", Some(DELTA_OK.into()))
            .unwrap_err();
        assert!(err.to_string().contains("clear its verification"), "{err}");
        assert!(!paths.task_delta_specs_dir(&t.id).exists());
        // Prose never folds, so it stays writable.
        assert!(write_task_file(&paths, "0.1.0", &t.id, "design.md", Some("d\n".into())).is_ok());

        // The way through: clear, write, verify again — which records the hash.
        set_task_verification(&paths, "0.1.0", &t.id, false, None).unwrap();
        write_task_file(&paths, "0.1.0", &t.id, "specs/auth/spec.md", Some(DELTA_OK.into())).unwrap();
        let task = set_task_verification(&paths, "0.1.0", &t.id, true, Some("re-ran".into()))
            .unwrap()
            .task;
        assert!(task.verified_specs_hash.is_some());
    }

    /// F3: the hash ignored a leading BOM but the parser did not, so a BOM hid
    /// a `## REMOVED` section from the dry-run a reviewer saw while the hash
    /// already covered the version without it. Now both see the same text:
    /// the removal is visible before verification.
    #[test]
    fn a_leading_bom_hides_nothing_from_the_dry_run() {
        let (_g, paths) = workspace();
        enable_specs(&paths);
        std::fs::create_dir_all(paths.spec_file("auth").parent().unwrap()).unwrap();
        std::fs::write(
            paths.spec_file("auth"),
            "# auth Specification\n\n## Purpose\nLogin.\n\n## Requirements\n\n### Requirement: Lockout\nThe system SHALL lock an account after 5 failed logins.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n",
        )
        .unwrap();
        let t = done_task(&paths, "auth tweak", false);
        let body = "## REMOVED Requirements\n\n### Requirement: Lockout\n**Reason**: x\n\n## ADDED Requirements\n\n### Requirement: Remember me\nThe system SHALL offer remember-me.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n";
        let report = write_task_file(
            &paths,
            "0.1.0",
            &t.id,
            "specs/auth/spec.md",
            Some(format!("\u{feff}{body}")),
        )
        .unwrap()
        .specs
        .unwrap();
        assert_eq!((report.added, report.removed), (1, 1), "the reviewer sees the removal");
        set_task_verification(&paths, "0.1.0", &t.id, true, Some("reviewed".into())).unwrap();
        // Dropping the BOM afterwards changes nothing anyone has not seen.
        let out =
            write_task_file(&paths, "0.1.0", &t.id, "specs/auth/spec.md", Some(body.into())).unwrap();
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);
        assert_eq!((out.specs.as_ref().unwrap().added, out.specs.unwrap().removed), (1, 1));
    }

    /// F4 (a): the fold wrote specs/ before the task file's marker, and the
    /// callers ledgered it only after — a task file held open by another
    /// process left the main spec rewritten with no ledger line. Windows only:
    /// the share mode is how a plain reader denies writes there.
    #[cfg(windows)]
    #[test]
    fn a_fold_whose_marker_write_fails_still_ledgers_what_it_changed() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        let (_g, paths) = workspace();
        enable_specs(&paths);
        let t = done_task(&paths, "x", false);
        write_task_file(&paths, "0.1.0", &t.id, "specs/export/spec.md", Some(DELTA_OK.into())).unwrap();
        set_task_verification(&paths, "0.1.0", &t.id, true, Some("ran".into())).unwrap();

        let task_json = paths.tasks_dir().join(format!("{}.json", t.id));
        let hold =
            std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(&task_json).unwrap();
        let swept = archive_verified_done_tasks(&paths, "0.1.0", None).unwrap();
        drop(hold);

        assert!(swept.is_empty(), "the task could not be marked, so it is not archived yet");
        assert!(paths.spec_file("export").exists(), "specs/ was written…");
        assert_eq!(spec_folded_lines(&paths).len(), 1, "…and the ledger says so");
        // Once the file is free the next sweep catches up.
        let swept = archive_verified_done_tasks(&paths, "0.1.0", None).unwrap();
        assert_eq!(swept, vec![t.id.clone()]);
    }

    /// F4 (b): one task file held open aborted the whole sweep after earlier
    /// tasks were already archived — no summary line, no fresh snapshot.
    #[cfg(windows)]
    #[test]
    fn one_unwritable_task_file_does_not_abort_the_archive_sweep() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        let (_g, paths) = workspace();
        let first = done_task(&paths, "first", true);
        let second = done_task(&paths, "second", true);
        let third = done_task(&paths, "third", true);
        let archived_lines = |paths: &WorkspacePaths| {
            Ledger::new(paths.ledger_file()).recent_of_kind(LedgerKind::TaskArchived, 50).unwrap()
        };
        let before = archived_lines(&paths).len();

        let task_json = paths.tasks_dir().join(format!("{}.json", second.id));
        let hold =
            std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(&task_json).unwrap();
        let swept = archive_verified_done_tasks(&paths, "0.1.0", None);
        drop(hold);

        assert_eq!(swept.unwrap(), vec![first.id.clone(), third.id.clone()]);
        let lines = archived_lines(&paths);
        assert_eq!(lines.len(), before + 1, "the summary line is written");
        assert!(lines[0].message.contains(&first.id) && !lines[0].message.contains(&second.id));
    }

    /// F5: a post-write re-hash that failed skipped the ledger line of a
    /// write that had already landed, while the hub recorded the call as
    /// failed. Now the write reports success with a warning, and is ledgered.
    #[cfg(windows)]
    #[test]
    fn a_landed_write_is_ledgered_even_when_the_bundle_cannot_be_re_read() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_g, paths) = workspace();
        enable_specs(&paths);
        let t = done_task(&paths, "x", false);
        write_task_file(&paths, "0.1.0", &t.id, "specs/a/spec.md", Some(DELTA_OK.into())).unwrap();
        write_task_file(&paths, "0.1.0", &t.id, "specs/b/spec.md", Some(DELTA_OK.into())).unwrap();
        set_task_verification(&paths, "0.1.0", &t.id, true, Some("ran".into())).unwrap();

        let sibling = paths.task_delta_specs_dir(&t.id).join("b").join("spec.md");
        let hold = std::fs::OpenOptions::new().read(true).share_mode(0).open(&sibling).unwrap();
        let out =
            write_task_file(&paths, "0.1.0", &t.id, "specs/a/spec.md", Some(DELTA_EDITED.into()));
        drop(hold);

        let out = out.expect("the write landed, so the call succeeds");
        assert!(out.warnings.iter().any(|w| w.contains("could not be re-read")), "{:?}", out.warnings);
        let sha = short_sha256(DELTA_EDITED.as_bytes());
        let lines =
            Ledger::new(paths.ledger_file()).recent_of_kind(LedgerKind::TaskEdited, 50).unwrap();
        assert!(lines.iter().any(|e| e.message.contains(&sha)), "{lines:?}");
    }
}
