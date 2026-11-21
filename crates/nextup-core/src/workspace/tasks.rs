//! Task store: one atomic task = one JSON file under `tasks/`.
//!
//! Files are the source of truth — the store is stateless and every operation
//! re-reads the directory. Status (`todo/in_progress/blocked/done/cancelled`)
//! is the *claim* dimension; verification (`verified_at`/`verified_note`) is the
//! separate *checked* dimension (D17). This module also owns the takeover
//! selectors ([`next_steps`], [`blocked`]) every handoff surface renders from,
//! so "what should the next session do first" is decided in exactly one place.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result, UnmetDependency};
use crate::workspace::atomic::atomic_write_json;
use crate::workspace::context::now_rfc3339;

pub const TASK_SCHEMA_VERSION: u32 = 1;

/// Most steps one task may carry (D170). A checklist past this is a phase
/// plan, not one task's steps, and every takeover surface renders the count.
pub const MAX_TASK_STEPS: usize = 50;

/// One step of a task's own checklist (D170). Steps describe how the task's
/// work breaks down — an external PM ran "five sections × the same eight
/// steps", which had nowhere to live but a hand-kept table — and they never
/// move the task's status, its verification or any gate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    pub title: String,
    #[serde(default)]
    pub done: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    Blocked,
    Done,
    /// Closed without being done (D169): superseded, dropped, or overtaken by
    /// events. Before it existed the only way to close such a task was `done`,
    /// which counted it as progress and let it unlock its dependents — an
    /// external PM's workspace read 54% while nothing was finished. A
    /// cancelled task needs a reason, never satisfies a dependency, cannot be
    /// verified and never folds its delta specs.
    Cancelled,
}

impl TaskStatus {
    pub const ALL: [TaskStatus; 5] = [
        TaskStatus::Todo,
        TaskStatus::InProgress,
        TaskStatus::Blocked,
        TaskStatus::Done,
        TaskStatus::Cancelled,
    ];

    pub fn label(&self) -> &'static str {
        match self {
            TaskStatus::Todo => "todo",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Blocked => "blocked",
            TaskStatus::Done => "done",
            TaskStatus::Cancelled => "cancelled",
        }
    }

    /// Closed = no work left on it: done or cancelled. Archiving accepts only
    /// closed tasks and the `all_tasks_done` gate counts only the rest as open.
    pub fn is_closed(&self) -> bool {
        matches!(self, TaskStatus::Done | TaskStatus::Cancelled)
    }
}

/// Parse the wire name (`label()` / serde snake_case) back into a status —
/// the single string↔enum mapping every delivery layer must use.
impl std::str::FromStr for TaskStatus {
    type Err = NextUpError;

    fn from_str(s: &str) -> Result<Self> {
        TaskStatus::ALL.into_iter().find(|st| st.label() == s).ok_or_else(|| {
            NextUpError::InvalidInput(format!(
                "unknown task status '{s}' (expected one of: todo, in_progress, blocked, done, cancelled)"
            ))
        })
    }
}

/// One atomic task = one JSON file under `tasks/` (e.g. `tasks/T-0001.json`).
/// Priority: 0 = highest (P0) … 3 = lowest (P3).
///
/// Verification is a dimension separate from `status`: `done` records the
/// *claim* of completion, `verified_at`/`verified_note` record that the claim
/// was checked against reality (tests run, GUI walked through, output
/// inspected). Missing fields mean "not verified", so pre-existing task files
/// need no migration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub status: TaskStatus,
    pub priority: u8,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
    /// When `blocked_reason` was written. Nobody recomputes a reason, so a
    /// task can sit on "waiting for the API key" long after the key arrived;
    /// the timestamp is what lets a reader see the claim is old instead of
    /// taking it as current fact. Deliberately not `updated_at`, which any
    /// later edit refreshes — that would make a stale reason look verified.
    /// Absent on pre-existing files and cleared with the reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_at: Option<String>,
    /// Why the task was cancelled (D169) — required on the way in, cleared on
    /// the way out, like `blocked_reason`. Absent on pre-existing files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel_reason: Option<String>,
    /// Collaboration fields (D31). Always part of the schema — a workspace
    /// without the collab module simply never surfaces them (fields stay
    /// universal, modules only gate exposure), so old files need no migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    /// The task's own checklist (D170). Absent on pre-existing files.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<TaskStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_note: Option<String>,
    /// Archived = closed and hidden from default listings (D40). Only a closed
    /// task (done, or cancelled since D169) can be archived; the file stays in `tasks/` under its id, so
    /// dependency resolution and `get` are unaffected. Missing field means
    /// "not archived" — pre-existing task files need no migration.
    #[serde(default)]
    pub archived: bool,
    /// Spec-layer bookkeeping (D79): when this task's delta specs were
    /// folded into `specs/` (stamped by the archive path). Cleared whenever
    /// the task leaves done — reopened work may edit its deltas and must
    /// fold again on the next archive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec_folded_at: Option<String>,
    /// Content hash of the delta bundle at the moment the task was verified
    /// (D149). Folding turns a verified claim into the spec layer's truth, so
    /// a fold refuses a bundle that no longer matches what was verified —
    /// before this, a delta edited after verification folded unseen, and the
    /// workspace-open sweep did it without anyone pressing anything. Absent on
    /// tasks verified before it existed (and, with the spec module off, on
    /// tasks verified with no bundle): those fold as they always did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_specs_hash: Option<String>,
    /// Content hash of the bundle as it was folded (D149) — what the doctor
    /// compares to tell a real edit after the fold from a git checkout that
    /// only touched file times. Absent on folds made before it existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec_folded_hash: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Task {
    pub fn is_verified(&self) -> bool {
        self.verified_at.is_some()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTask {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub priority: u8,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Step titles, all starting unchecked (D170).
    #[serde(default)]
    pub steps: Vec<String>,
}

/// The editable *attribute* set of a task — everything that describes the work
/// without asserting anything about its progress. The status, verification,
/// archive and assignee dimensions each have their own operation with their own
/// rules (evidence required, dependency gate, claim CAS), so they are
/// deliberately absent here: one write path per dimension, never a form that
/// can silently move two at once.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEdit {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub priority: u8,
    #[serde(default)]
    pub tags: Vec<String>,
    /// The complete new step list by title (D170); `None` leaves it as it is.
    /// A title that was already there keeps its checkmark, so rewording one
    /// step does not reset the others.
    #[serde(default)]
    pub steps: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCounts {
    pub total: usize,
    pub todo: usize,
    pub in_progress: usize,
    pub blocked: usize,
    pub done: usize,
    /// Closed without being done (D169). Counted in `total` — the files exist
    /// — but every progress figure leaves them out of the denominator.
    #[serde(default)]
    pub cancelled: usize,
    /// Done tasks whose completion claim has not been verified yet — the gap
    /// a takeover session must treat as assumptions, not facts.
    #[serde(default)]
    pub done_unverified: usize,
}

/// File-backed task store. Stateless: every operation reads from / writes to
/// the `tasks/` directory, which stays the single source of truth.
pub struct TaskStore {
    dir: PathBuf,
}

impl TaskStore {
    pub fn new(tasks_dir: impl Into<PathBuf>) -> Self {
        Self { dir: tasks_dir.into() }
    }

    /// The one place an id becomes a path, so the one place it is checked.
    /// Ids arrive from agents (hub tool arguments, `dependsOn` lists) and are
    /// joined into `tasks/{id}.json` here and into `tasks/{id}/…` by the
    /// artifact bundle — unchecked, `../.` read a planted `<ws>/..json` while
    /// steering the bundle to `<ws>/specs/` (reported against D149's
    /// `write_task_file`, 2026-11-09).
    fn task_file(&self, id: &str) -> Result<PathBuf> {
        validate_task_id(id)?;
        Ok(self.dir.join(format!("{id}.json")))
    }

    /// All tasks sorted by id. Non-task files and unparsable JSON are skipped
    /// (reported upstream via the watcher, but they never poison listing), and
    /// so is a file whose id is malformed or disagrees with its own file name:
    /// callers turn listed ids into paths, and `get` would refuse it anyway.
    /// The doctor reports both (`task_file`).
    pub fn list(&self) -> Result<Vec<Task>> {
        let mut tasks = Vec::new();
        if !self.dir.exists() {
            return Ok(tasks);
        }
        for entry in std::fs::read_dir(&self.dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = std::fs::read(&path) else { continue };
            if let Ok(task) = serde_json::from_slice::<Task>(&raw) {
                let stem = path.file_stem().and_then(|s| s.to_str());
                if validate_task_id(&task.id).is_ok() && stem == Some(task.id.as_str()) {
                    tasks.push(task);
                }
            }
        }
        tasks.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(tasks)
    }

    pub fn get(&self, id: &str) -> Result<Task> {
        let path = self.task_file(id)?;
        if !path.exists() {
            return Err(NextUpError::NotFound(format!("task {id} does not exist")));
        }
        let task: Task = super::atomic::read_json_file(&path)?;
        // A copied file keeps the id it was copied from. Acting on it would
        // touch one task's bundle while ledgering another's title.
        if task.id != id {
            return Err(NextUpError::InvalidInput(format!(
                "tasks/{id}.json holds task {} — a task file's name and its id must agree",
                task.id
            )));
        }
        Ok(task)
    }

    pub fn create(&self, input: NewTask) -> Result<Task> {
        let title = validate_title(input.title)?;
        validate_priority(input.priority)?;
        // The new task's id is not allocated yet, so a self-dependency (and
        // therefore any cycle through this task) cannot pass the exists check.
        let depends_on = self.validate_depends_on(None, input.depends_on)?;
        std::fs::create_dir_all(&self.dir)?;

        let now = now_rfc3339();
        let task = Task {
            schema_version: TASK_SCHEMA_VERSION,
            id: self.next_id()?,
            title,
            description: input.description,
            status: TaskStatus::Todo,
            priority: input.priority,
            tags: normalize_tags(input.tags),
            blocked_reason: None,
            blocked_at: None,
            cancel_reason: None,
            assignee: normalize_assignee(input.assignee),
            depends_on,
            steps: normalize_steps(input.steps, &[])?,
            verified_at: None,
            verified_note: None,
            archived: false,
            spec_folded_at: None,
            verified_specs_hash: None,
            spec_folded_hash: None,
            created_at: now.clone(),
            updated_at: now,
        };
        atomic_write_json(&self.task_file(&task.id)?, &task)?;
        Ok(task)
    }

    /// Rewrite a task's attributes (title / description / priority / tags).
    ///
    /// Verification survives an edit on purpose: `verified_at` attests that the
    /// *work* was checked against reality, and fixing a typo or re-tagging does
    /// not un-check it. Only a status change invalidates verification (see
    /// [`Self::update_status`]) — if the substance of the work really changed,
    /// that is a new task, not an edit.
    pub fn edit(&self, id: &str, edit: TaskEdit) -> Result<Task> {
        self.edit_with_deps(id, edit, None)
    }

    /// [`Self::edit`] that may also replace the dependency list (D169, the
    /// hub's `edit_task { dependsOn }`). Everything is validated before the
    /// one write, so a refusal of either half leaves the file untouched.
    pub fn edit_with_deps(
        &self,
        id: &str,
        edit: TaskEdit,
        depends_on: Option<Vec<String>>,
    ) -> Result<Task> {
        let mut task = self.get(id)?;
        task.title = validate_title(edit.title)?;
        validate_priority(edit.priority)?;
        if let Some(deps) = depends_on {
            task.depends_on = self.validate_depends_on(Some(id), deps)?;
        }
        if let Some(titles) = edit.steps {
            task.steps = normalize_steps(titles, &task.steps)?;
        }
        task.description = edit.description;
        task.priority = edit.priority;
        task.tags = normalize_tags(edit.tags);
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id)?, &task)?;
        Ok(task)
    }

    /// Delete a task file, returning the task as it was (callers ledger its
    /// title — the audit trail must still answer "what was T-0007?").
    ///
    /// Refused while any other task lists this one in `depends_on`: silently
    /// rewriting someone else's dependency list would drop an edge the user
    /// never looked at, and a dangling edge would read as an unmet prerequisite
    /// forever. The caller is told exactly which tasks to fix first.
    pub fn delete(&self, id: &str) -> Result<Task> {
        let task = self.get(id)?;
        let dependents = self.dependents(id)?;
        if !dependents.is_empty() {
            return Err(NextUpError::HasDependents { id: id.to_string(), dependents });
        }
        std::fs::remove_file(self.task_file(id)?)?;
        Ok(task)
    }

    /// Tasks that declare `id` as a prerequisite, in id order.
    fn dependents(&self, id: &str) -> Result<Vec<String>> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|t| t.id != id && t.depends_on.iter().any(|dep| dep == id))
            .map(|t| t.id)
            .collect())
    }

    /// Transition a task's status. Entering `Blocked` or `Cancelled` requires
    /// a reason; leaving it clears the reason. Any actual status change
    /// invalidates a prior verification — it attested a specific completed
    /// state, and that claim just changed.
    ///
    /// Dependency unlock rule (D31): starting or completing a task requires
    /// every `depends_on` task to be done. Enforced here — beneath both
    /// delivery channels — so the GUI and the MCP hub can never disagree.
    /// (Done-standard, not verified: a human re-check must not become the
    /// bottleneck of a parallel pipeline.)
    pub fn update_status(
        &self,
        id: &str,
        status: TaskStatus,
        reason: Option<String>,
    ) -> Result<Task> {
        let mut task = self.get(id)?;
        if matches!(status, TaskStatus::InProgress | TaskStatus::Done) {
            let unmet = self.unmet_dependencies(&task)?;
            if !unmet.is_empty() {
                return Err(NextUpError::DependenciesUnmet {
                    id: id.to_string(),
                    to: status.label().to_string(),
                    blocking: unmet,
                });
            }
        }
        let reason = reason.map(|r| r.trim().to_string()).unwrap_or_default();
        if status == TaskStatus::Cancelled {
            if reason.is_empty() {
                return Err(NextUpError::InvalidInput(
                    "a reason is required when cancelling a task (what replaced it, or why it was dropped)"
                        .into(),
                ));
            }
            task.cancel_reason = Some(reason.clone());
        } else {
            task.cancel_reason = None;
        }
        if status == TaskStatus::Blocked {
            if reason.is_empty() {
                return Err(NextUpError::InvalidInput(
                    "a reason is required when blocking a task".into(),
                ));
            }
            // Re-blocking with a new reason restamps; a repeated block with
            // the same reason keeps the original age, which is the honest
            // reading — the claim has not been re-established.
            if task.blocked_reason.as_deref() != Some(reason.as_str()) {
                task.blocked_at = Some(now_rfc3339());
            }
            task.blocked_reason = Some(reason);
        } else {
            task.blocked_reason = None;
            task.blocked_at = None;
        }
        // Any real status change un-archives (D40, widened by D169): archived
        // is a sub-state of one closed state, not of "closed" in general —
        // a cancelled task moved to done must pass the verify-before-archive
        // rule like any other, and a filed-away done task that gets cancelled
        // should come back into view with its new status.
        if status != task.status {
            task.verified_at = None;
            task.verified_note = None;
            task.verified_specs_hash = None;
            task.archived = false;
        }
        // The spec-fold marker clears when the task reopens (D79): reopened
        // work may edit its delta specs, and a stale marker would silently
        // skip the re-fold on the next archive. Moving between done and
        // cancelled keeps it — the folded text is in specs/ either way, and
        // clearing it would invite a second fold of the same delta.
        if !status.is_closed() {
            task.spec_folded_at = None;
            task.spec_folded_hash = None;
        }
        task.status = status;
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id)?, &task)?;
        Ok(task)
    }

    /// Mark a done task as verified (with mandatory evidence: what was run /
    /// observed), or clear the mark. Verification only makes sense as a
    /// counter-check of a completion claim, so non-done tasks are rejected.
    ///
    /// `specs_hash` is the delta bundle's hash at this moment (D149), computed
    /// by the ops layer — the store knows where task files live, not how a
    /// bundle is read. Ignored when clearing.
    pub fn set_verification(
        &self,
        id: &str,
        verified: bool,
        note: Option<String>,
        specs_hash: Option<String>,
    ) -> Result<Task> {
        let mut task = self.get(id)?;
        if verified {
            if task.status != TaskStatus::Done {
                return Err(NextUpError::InvalidInput(
                    "only a done task can be marked verified".into(),
                ));
            }
            let note = note.map(|n| n.trim().to_string()).unwrap_or_default();
            if note.is_empty() {
                return Err(NextUpError::InvalidInput(
                    "verification requires evidence: what was run and what was observed".into(),
                ));
            }
            task.verified_at = Some(now_rfc3339());
            task.verified_note = Some(note);
            task.verified_specs_hash = specs_hash;
        } else {
            task.verified_at = None;
            task.verified_note = None;
            task.verified_specs_hash = None;
        }
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id)?, &task)?;
        Ok(task)
    }

    /// Archive or un-archive a task (D40). Archiving is a presentation-tier
    /// close: the file stays in place (id lookups and dependency edges keep
    /// working), default listings hide it. Only a closed task (done or
    /// cancelled) may be archived — open work must stay visible; un-archiving
    /// is always accepted.
    pub fn set_archived(&self, id: &str, archived: bool) -> Result<Task> {
        let mut task = self.get(id)?;
        if archived && !task.status.is_closed() {
            return Err(NextUpError::InvalidInput(
                "only a done or cancelled task can be archived".into(),
            ));
        }
        task.archived = archived;
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id)?, &task)?;
        Ok(task)
    }

    /// Tick or untick one step (1-based, as every surface numbers them —
    /// D170). Like an attribute edit it leaves status and verification alone:
    /// a checklist describes the work, it does not claim the work is done.
    pub fn set_step(&self, id: &str, step: usize, done: bool) -> Result<Task> {
        let mut task = self.get(id)?;
        let count = task.steps.len();
        let Some(slot) = step.checked_sub(1).and_then(|i| task.steps.get_mut(i)) else {
            return Err(NextUpError::InvalidInput(if count == 0 {
                format!("{id} has no steps — add them with edit_task first")
            } else {
                format!("step must be 1 to {count} for {id} — got {step}")
            }));
        };
        slot.done = done;
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id)?, &task)?;
        Ok(task)
    }

    /// Engine bookkeeping (D79): stamp or clear the spec-fold marker, together
    /// with the hash of the bundle as folded (D149). Not a user dimension —
    /// only the ops archive path calls this, right after a successful fold.
    pub fn set_spec_folded(&self, id: &str, at: Option<String>, hash: Option<String>) -> Result<Task> {
        let mut task = self.get(id)?;
        task.spec_folded_at = at;
        task.spec_folded_hash = hash;
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id)?, &task)?;
        Ok(task)
    }

    /// Set or clear the assignee. Plain write primitive — claim semantics
    /// (compare-and-set, "may not steal") live in `ops::claim_task`, which
    /// runs this under the cross-process mutation lock.
    pub fn set_assignee(&self, id: &str, assignee: Option<String>) -> Result<Task> {
        let mut task = self.get(id)?;
        task.assignee = normalize_assignee(assignee);
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id)?, &task)?;
        Ok(task)
    }

    /// Replace a task's dependency list (validated: ids exist, no self-dep,
    /// no cycle). Editing dependencies does not touch verification — it
    /// changes when the task may start, not what was claimed done.
    pub fn set_depends_on(&self, id: &str, depends_on: Vec<String>) -> Result<Task> {
        let mut task = self.get(id)?;
        task.depends_on = self.validate_depends_on(Some(id), depends_on)?;
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id)?, &task)?;
        Ok(task)
    }

    /// Trim, drop duplicates, and verify every referenced task exists (same
    /// evidence rule as flywheel lessons: a reference that cannot be opened is
    /// refused, not stored). With `of` set, also rejects self-dependencies and
    /// cycles by walking the existing dependency edges from each new dep.
    fn validate_depends_on(&self, of: Option<&str>, deps: Vec<String>) -> Result<Vec<String>> {
        let mut seen = Vec::new();
        for dep in deps {
            let dep = dep.trim().to_string();
            if dep.is_empty() {
                return Err(NextUpError::InvalidInput("dependency id cannot be empty".into()));
            }
            if seen.contains(&dep) {
                continue;
            }
            if of == Some(dep.as_str()) {
                return Err(NextUpError::InvalidInput(format!(
                    "{dep} cannot depend on itself"
                )));
            }
            if !self.task_file(&dep)?.exists() {
                return Err(NextUpError::InvalidInput(format!(
                    "cannot depend on {dep}: no such task"
                )));
            }
            if let Some(of) = of {
                if self.reaches(&dep, of)? {
                    return Err(NextUpError::InvalidInput(format!(
                        "adding {dep} would create a dependency cycle through {of}"
                    )));
                }
            }
            seen.push(dep);
        }
        Ok(seen)
    }

    /// Depth-first walk along `depends_on` edges: is `target` reachable from
    /// `from`? Unparsable or missing dep files simply end that branch — the
    /// doctor reports them, a broken edge must not brick dependency edits.
    fn reaches(&self, from: &str, target: &str) -> Result<bool> {
        let mut stack = vec![from.to_string()];
        let mut visited = Vec::new();
        while let Some(current) = stack.pop() {
            if current == target {
                return Ok(true);
            }
            if visited.contains(&current) {
                continue;
            }
            visited.push(current.clone());
            if let Ok(task) = self.get(&current) {
                stack.extend(task.depends_on.iter().cloned());
            }
        }
        Ok(false)
    }

    /// Dependencies that are not done yet, as structured `{id, status}` pairs
    /// (status `missing` when the dep file vanished — it certainly is not a
    /// completed prerequisite; `cancelled` never will be one, D169). Carried on `DependenciesUnmet` so callers can
    /// branch on data instead of parsing the message.
    fn unmet_dependencies(&self, task: &Task) -> Result<Vec<UnmetDependency>> {
        let mut unmet = Vec::new();
        for dep in &task.depends_on {
            let status = match self.get(dep) {
                Ok(t) if t.status == TaskStatus::Done => continue,
                Ok(t) => t.status.label().to_string(),
                Err(_) => "missing".to_string(),
            };
            unmet.push(UnmetDependency { id: dep.clone(), status });
        }
        Ok(unmet)
    }

    /// Next sequential id `T-0001`, `T-0002`, … derived from existing files so
    /// ids stay stable without any extra counter state.
    fn next_id(&self) -> Result<String> {
        let mut stems: Vec<String> = Vec::new();
        if self.dir.exists() {
            for entry in std::fs::read_dir(&self.dir)? {
                let name = entry?.file_name();
                if let Some(stem) = name.to_string_lossy().strip_suffix(".json") {
                    stems.push(stem.to_string());
                }
            }
        }
        Ok(super::ids::next_seq_id("T-", stems.iter().map(String::as_str)))
    }
}

/// A task id is `T-` and digits — the only shape `next_id` ever mints. Checked
/// before any id becomes a path (`TaskStore::task_file`, and the bundle readers
/// in `specs`), because every separator, dot and drive letter is a way out of
/// `tasks/`. The digit count is bounded only so a hostile string stays short
/// in the error message.
pub fn validate_task_id(id: &str) -> Result<()> {
    let digits = id.strip_prefix("T-").unwrap_or("");
    if !digits.is_empty() && digits.len() <= 9 && digits.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(());
    }
    let shown: String = id.chars().take(40).collect();
    Err(NextUpError::InvalidInput(format!("task id must look like T-0001 — got '{shown}'")))
}

/// Empty or whitespace-only assignee means "unassigned" — store None so the
/// wire shape and the kanban's unassigned column agree on one representation.
fn normalize_assignee(assignee: Option<String>) -> Option<String> {
    assignee.map(|a| a.trim().to_string()).filter(|a| !a.is_empty())
}

/// Trim, drop blanks and de-duplicate tags, keeping the caller's order. Both
/// create and edit run this, so `["ui", " ui ", ""]` can never become three
/// distinct filter entries on the tasks page.
fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim().to_string();
        if !tag.is_empty() && !out.contains(&tag) {
            out.push(tag);
        }
    }
    out
}

/// Trim and drop blank step titles, cap the count, and carry each surviving
/// title's checkmark over from `previous` (D170) — matched by title, first
/// unclaimed match wins, so two steps with the same title keep their own.
fn normalize_steps(titles: Vec<String>, previous: &[TaskStep]) -> Result<Vec<TaskStep>> {
    let titles: Vec<String> =
        titles.into_iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
    if titles.len() > MAX_TASK_STEPS {
        return Err(NextUpError::InvalidInput(format!(
            "a task may carry at most {MAX_TASK_STEPS} steps — got {}; split the work into tasks",
            titles.len()
        )));
    }
    let mut claimed = vec![false; previous.len()];
    Ok(titles
        .into_iter()
        .map(|title| {
            let done = previous
                .iter()
                .enumerate()
                .find(|(i, p)| !claimed[*i] && p.title == title)
                .map(|(i, p)| {
                    claimed[i] = true;
                    p.done
                })
                .unwrap_or(false);
            TaskStep { title, done }
        })
        .collect())
}

/// The title rule shared by create and edit: trimmed, and never blank — an
/// untitled task is invisible on every takeover surface.
fn validate_title(title: String) -> Result<String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(NextUpError::InvalidInput("task title cannot be empty".into()));
    }
    Ok(title)
}

fn validate_priority(priority: u8) -> Result<()> {
    if priority > 3 {
        return Err(NextUpError::InvalidInput(
            "priority must be 0 (P0, highest) to 3 (P3, lowest)".into(),
        ));
    }
    Ok(())
}

/// Aggregate counts used by the dashboard and the handoff snapshot.
pub fn compute_counts(tasks: &[Task]) -> TaskCounts {
    let mut counts = TaskCounts { total: tasks.len(), ..Default::default() };
    for task in tasks {
        match task.status {
            TaskStatus::Todo => counts.todo += 1,
            TaskStatus::InProgress => counts.in_progress += 1,
            TaskStatus::Blocked => counts.blocked += 1,
            TaskStatus::Done => {
                counts.done += 1;
                if !task.is_verified() {
                    counts.done_unverified += 1;
                }
            }
            TaskStatus::Cancelled => counts.cancelled += 1,
        }
    }
    counts
}

impl TaskCounts {
    /// Done as a share of the work that is still meant to happen: cancelled
    /// tasks leave the denominator (D169). 0 when nothing is left to count.
    pub fn progress_percent(&self) -> usize {
        let live = self.total.saturating_sub(self.cancelled);
        if live == 0 {
            0
        } else {
            (self.done * 100) / live
        }
    }
}

pub fn counts_for_dir(tasks_dir: &Path) -> Result<TaskCounts> {
    let tasks = TaskStore::new(tasks_dir).list()?;
    Ok(compute_counts(&tasks))
}

/// One open task as a takeover surface lists it, with what stands between it
/// and the next session (D147). Built only through [`NextStep::of`], so the
/// state block, handoff §3 and `list_tasks { ready }` all apply one rule.
pub struct NextStep<'a> {
    pub task: &'a Task,
    /// Dependencies not yet done, resolved against the same task list the
    /// caller holds. A missing id counts as unmet — the same reading
    /// [`TaskStore::update_status`] enforces, so a task listed as startable
    /// is one the engine will actually let start.
    pub waiting_on: Vec<String>,
    /// The subset of `waiting_on` that was cancelled (D169) — those will never
    /// land, so the note says to re-point the dependency instead of waiting.
    pub cancelled_deps: Vec<String>,
}

impl<'a> NextStep<'a> {
    /// `all` must be every task file, archived ones included: a dependency
    /// may point at a task that has since been archived — done or cancelled,
    /// and only done clears it.
    pub fn of(task: &'a Task, all: &[Task]) -> Self {
        let status_of = |dep: &String| all.iter().find(|t| &t.id == dep).map(|t| t.status);
        let waiting_on: Vec<String> = task
            .depends_on
            .iter()
            .filter(|dep| status_of(dep) != Some(TaskStatus::Done))
            .cloned()
            .collect();
        let cancelled_deps = waiting_on
            .iter()
            .filter(|dep| status_of(dep) == Some(TaskStatus::Cancelled))
            .cloned()
            .collect();
        Self { task, waiting_on, cancelled_deps }
    }

    /// Takeover grouping: in progress, then the frontier, then assigned but
    /// not started, then waiting on dependencies. Waiting outranks assigned —
    /// an assigned task whose dependencies are open cannot start for anyone.
    fn group(&self) -> u8 {
        if self.task.status == TaskStatus::InProgress {
            0
        } else if !self.waiting_on.is_empty() {
            3
        } else if self.task.assignee.is_some() {
            2
        } else {
            1
        }
    }

    /// The frontier: todo, every dependency done, nobody assigned.
    pub fn is_ready(&self) -> bool {
        self.task.status == TaskStatus::Todo && self.group() == 1
    }

    /// The annotation both takeover surfaces print after the title. It is
    /// the reason a listed task is not simply "take it" — open dependencies
    /// (which the engine will refuse) and, for unstarted work, whose it is:
    /// an assignee arrives by claiming or by dispatch (`assign_task`, or
    /// `create_task` with one), and the surface carries no identity, so it
    /// names the holder and the reader recognises their own name. An
    /// in-progress task with a reopened dependency gets the note too: it
    /// cannot be completed until that lands.
    pub fn note(&self) -> Option<String> {
        let mut parts = Vec::new();
        if !self.waiting_on.is_empty() {
            parts.push(format!("waits on {}", self.waiting_on.join(", ")));
        }
        // A task with a checklist says how far along it is (D170): the one
        // number a takeover needs from it without opening the file.
        if !self.task.steps.is_empty() {
            let done = self.task.steps.iter().filter(|s| s.done).count();
            parts.push(format!("steps {done}/{}", self.task.steps.len()));
        }
        if !self.cancelled_deps.is_empty() {
            parts.push(format!(
                "{} cancelled — re-point dependsOn",
                self.cancelled_deps.join(", ")
            ));
        }
        if self.task.status == TaskStatus::Todo {
            if let Some(who) = &self.task.assignee {
                parts.push(format!("assigned to {who}"));
            }
        }
        (!parts.is_empty()).then(|| parts.join("; "))
    }
}

/// Open tasks in takeover order (see [`NextStep::group`]), then priority,
/// then id. Every takeover surface (handoff §3, the AGENTS.md state block)
/// renders from this — the ordering rule lives here and nowhere else, so the
/// two surfaces can never disagree on what comes next.
pub fn next_steps(tasks: &[Task]) -> Vec<NextStep<'_>> {
    let mut next: Vec<NextStep> = tasks
        .iter()
        .filter(|t| matches!(t.status, TaskStatus::InProgress | TaskStatus::Todo))
        .map(|t| NextStep::of(t, tasks))
        .collect();
    next.sort_by_key(|s| (s.group(), s.task.priority, s.task.id.clone()));
    next
}

/// Blocked tasks in id order — the shared source for every blockers list.
pub fn blocked(tasks: &[Task]) -> Vec<&Task> {
    tasks.iter().filter(|t| t.status == TaskStatus::Blocked).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, TaskStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = TaskStore::new(dir.path().join("tasks"));
        (dir, store)
    }

    fn new_task(title: &str, priority: u8) -> NewTask {
        NewTask { title: title.into(), priority, ..Default::default() }
    }

    #[test]
    fn archive_needs_done_and_reopening_unarchives() {
        let (_g, store) = store();
        let t = store.create(new_task("closable", 0)).unwrap();

        // Open work refuses to hide; un-archiving is always fine.
        assert_eq!(store.set_archived(&t.id, true).unwrap_err().kind(), "invalid_input");
        assert!(!store.set_archived(&t.id, false).unwrap().archived);

        store.update_status(&t.id, TaskStatus::Done, None).unwrap();
        assert!(store.set_archived(&t.id, true).unwrap().archived);

        // Archived files stay resolvable: id lookup and dependency edges work.
        let dependent = store
            .create(NewTask {
                title: "builds on archived".into(),
                depends_on: vec![t.id.clone()],
                ..Default::default()
            })
            .unwrap();
        assert!(store.update_status(&dependent.id, TaskStatus::InProgress, None).is_ok());

        // Reopening pulls the task out of the archive (no "in progress but
        // archived" state), and pre-archive files need no migration.
        let reopened = store.update_status(&t.id, TaskStatus::Todo, None).unwrap();
        assert!(!reopened.archived);
        let raw: serde_json::Value =
            serde_json::from_str(r#"{"schemaVersion":1,"id":"T-9998","title":"old","status":"todo","priority":1,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}"#)
                .unwrap();
        let old: Task = serde_json::from_value(raw).unwrap();
        assert!(!old.archived);
    }

    #[test]
    fn create_assigns_sequential_ids() {
        let (_g, store) = store();
        assert_eq!(store.create(new_task("a", 0)).unwrap().id, "T-0001");
        assert_eq!(store.create(new_task("b", 1)).unwrap().id, "T-0002");
        assert_eq!(store.create(new_task("c", 2)).unwrap().id, "T-0003");
    }

    #[test]
    fn list_returns_sorted_tasks() {
        let (_g, store) = store();
        store.create(new_task("first", 0)).unwrap();
        store.create(new_task("second", 1)).unwrap();
        let tasks = store.list().unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].id, "T-0001");
        assert_eq!(tasks[0].status, TaskStatus::Todo);
    }

    #[test]
    fn blocking_requires_reason_and_unblocking_clears_it() {
        let (_g, store) = store();
        let t = store.create(new_task("x", 0)).unwrap();

        let err = store.update_status(&t.id, TaskStatus::Blocked, None).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");

        let blocked = store
            .update_status(&t.id, TaskStatus::Blocked, Some("waiting on API quota".into()))
            .unwrap();
        assert_eq!(blocked.blocked_reason.as_deref(), Some("waiting on API quota"));
        let stamped = blocked.blocked_at.clone().expect("a reason must carry its date");

        // Re-blocking on the same reason keeps the original date: the claim
        // was repeated, not re-established, and refreshing it would disguise
        // exactly the staleness the field exists to expose.
        let again = store
            .update_status(&t.id, TaskStatus::Blocked, Some("waiting on API quota".into()))
            .unwrap();
        assert_eq!(again.blocked_at.as_deref(), Some(stamped.as_str()));

        let resumed = store.update_status(&t.id, TaskStatus::InProgress, None).unwrap();
        assert_eq!(resumed.blocked_reason, None);
        assert_eq!(resumed.blocked_at, None, "the date goes with the reason");
        assert_eq!(resumed.status, TaskStatus::InProgress);
    }

    #[test]
    fn update_unknown_task_is_not_found() {
        let (_g, store) = store();
        let err = store.update_status("T-9999", TaskStatus::Done, None).unwrap_err();
        assert_eq!(err.kind(), "not_found");
    }

    #[test]
    fn invalid_inputs_rejected() {
        let (_g, store) = store();
        assert!(store.create(new_task("  ", 0)).is_err());
        assert!(store.create(new_task("ok", 9)).is_err());
    }

    #[test]
    fn counts_aggregate_by_status() {
        let (_g, store) = store();
        let a = store.create(new_task("a", 0)).unwrap();
        let b = store.create(new_task("b", 0)).unwrap();
        store.create(new_task("c", 0)).unwrap();
        store.update_status(&a.id, TaskStatus::Done, None).unwrap();
        store.update_status(&b.id, TaskStatus::InProgress, None).unwrap();

        let counts = compute_counts(&store.list().unwrap());
        assert_eq!(counts.total, 3);
        assert_eq!(counts.done, 1);
        assert_eq!(counts.in_progress, 1);
        assert_eq!(counts.todo, 1);
        assert_eq!(counts.blocked, 0);
    }

    #[test]
    fn verification_requires_done_and_evidence() {
        let (_g, store) = store();
        let t = store.create(new_task("v", 0)).unwrap();

        // Not done yet → cannot verify.
        let err = store.set_verification(&t.id, true, Some("ran tests".into()), None).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");

        store.update_status(&t.id, TaskStatus::Done, None).unwrap();
        // Done but no evidence → still rejected.
        let err = store.set_verification(&t.id, true, None, None).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        let err = store.set_verification(&t.id, true, Some("  ".into()), None).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");

        let v = store
            .set_verification(&t.id, true, Some("cargo test all green".into()), None)
            .unwrap();
        assert!(v.is_verified());
        assert_eq!(v.verified_note.as_deref(), Some("cargo test all green"));

        // Clearing needs no evidence and wipes both fields.
        let cleared = store.set_verification(&t.id, false, None, None).unwrap();
        assert!(!cleared.is_verified());
        assert_eq!(cleared.verified_note, None);
    }

    #[test]
    fn status_change_invalidates_verification() {
        let (_g, store) = store();
        let t = store.create(new_task("v", 0)).unwrap();
        store.update_status(&t.id, TaskStatus::Done, None).unwrap();
        store.set_verification(&t.id, true, Some("walked the GUI".into()), None).unwrap();

        // Reopening the task drops the stale verification.
        let reopened = store.update_status(&t.id, TaskStatus::InProgress, None).unwrap();
        assert!(!reopened.is_verified());
        assert_eq!(reopened.verified_note, None);
    }

    #[test]
    fn counts_track_done_unverified() {
        let (_g, store) = store();
        let a = store.create(new_task("a", 0)).unwrap();
        let b = store.create(new_task("b", 0)).unwrap();
        store.update_status(&a.id, TaskStatus::Done, None).unwrap();
        store.update_status(&b.id, TaskStatus::Done, None).unwrap();
        store.set_verification(&a.id, true, Some("verified live".into()), None).unwrap();

        let counts = compute_counts(&store.list().unwrap());
        assert_eq!(counts.done, 2);
        assert_eq!(counts.done_unverified, 1);
    }

    #[test]
    fn legacy_task_file_without_verification_fields_parses() {
        let (_g, store) = store();
        store.create(new_task("seed dir", 0)).unwrap();
        // A task written by a pre-verification version of the app.
        std::fs::write(
            store.dir.join("T-0099.json"),
            br#"{"schemaVersion":1,"id":"T-0099","title":"legacy","status":"done","priority":1,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        let legacy = store.get("T-0099").unwrap();
        assert!(!legacy.is_verified());
        assert_eq!(compute_counts(&store.list().unwrap()).done_unverified, 1);
    }

    #[test]
    fn corrupt_file_does_not_poison_listing() {
        let (_g, store) = store();
        store.create(new_task("good", 0)).unwrap();
        std::fs::write(store.dir.join("T-9999.json"), b"{not json").unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
    }

    /// D147: the takeover list is the frontier first. A todo whose
    /// dependencies are open is one the engine will refuse to start, so it
    /// must not sit among the startable ones looking like the next pick.
    #[test]
    fn next_steps_lead_with_the_frontier() {
        let (_g, store) = store();
        let task = |title: &str, priority: u8, deps: &[&str]| {
            store
                .create(NewTask {
                    title: title.into(),
                    priority,
                    depends_on: deps.iter().map(|s| s.to_string()).collect(),
                    ..Default::default()
                })
                .unwrap()
        };
        let base = task("base", 0, &[]);
        let shelved = task("shelved", 0, &[]);
        store.update_status(&shelved.id, TaskStatus::Done, None).unwrap();
        store.set_archived(&shelved.id, true).unwrap();
        let after_base = task("after base", 0, &[&base.id]);
        task("after shelved", 1, &[&shelved.id]);
        let held = task("held", 0, &[]);
        store.set_assignee(&held.id, Some("alice".into())).unwrap();
        let held_and_waiting = task("held and waiting", 1, &[&base.id]);
        store.set_assignee(&held_and_waiting.id, Some("bob".into())).unwrap();
        // create and delete both refuse a dangling edge, so only a hand edit
        // leaves one behind — and the engine still reads it as unmet.
        let dangling = task("dangling", 2, &[]);
        let mut edited = store.get(&dangling.id).unwrap();
        edited.depends_on = vec!["T-9999".into()];
        atomic_write_json(&store.task_file(&dangling.id).unwrap(), &edited).unwrap();
        let active = task("active", 3, &[]);
        store.update_status(&active.id, TaskStatus::InProgress, None).unwrap();

        let all = store.list().unwrap();
        let next = next_steps(&all);
        let order: Vec<&str> = next.iter().map(|s| s.task.title.as_str()).collect();
        assert_eq!(
            order,
            [
                "active",           // in progress, whatever its priority
                "base",             // frontier, by priority
                "after shelved",    // an archived dependency counts as done
                "held",             // assigned, not started
                "after base",       // waiting, by priority
                "held and waiting", // waiting outranks assigned
                "dangling",         // a missing dependency is unmet
            ]
        );

        let by_title = |t: &str| next.iter().find(|s| s.task.title == t).unwrap();
        assert!(by_title("base").is_ready());
        assert!(by_title("after shelved").is_ready());
        assert!(!by_title("held").is_ready());
        assert!(!by_title("after base").is_ready());
        assert!(!by_title("active").is_ready(), "in progress is not the frontier");
        assert_eq!(by_title("base").note(), None);
        assert_eq!(by_title("held").note().as_deref(), Some("assigned to alice"));
        assert_eq!(by_title("after base").note(), Some(format!("waits on {}", base.id)));
        assert_eq!(
            by_title("held and waiting").note(),
            Some(format!("waits on {}; assigned to bob", base.id))
        );
        assert_eq!(by_title("dangling").note().as_deref(), Some("waits on T-9999"));

        // The rule the list promises is the rule the engine enforces: every
        // task marked ready really can start, and a waiting one really cannot.
        for step in next.iter().filter(|s| s.is_ready()) {
            assert!(store.update_status(&step.task.id, TaskStatus::InProgress, None).is_ok());
        }
        let err =
            store.update_status(&after_base.id, TaskStatus::InProgress, None).unwrap_err();
        assert_eq!(err.kind(), "dependencies_unmet");
        let err = store.update_status(&dangling.id, TaskStatus::InProgress, None).unwrap_err();
        assert_eq!(err.kind(), "dependencies_unmet");
    }

    // ── Collaboration fields (D31) ──────────────────────────────────────────

    fn with_deps(title: &str, deps: &[&str]) -> NewTask {
        NewTask {
            title: title.into(),
            depends_on: deps.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn create_validates_dependencies_exist() {
        let (_g, store) = store();
        // Evidence rule: a reference that cannot be opened is refused.
        let err = store.create(with_deps("t", &["T-0042"])).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");

        let a = store.create(new_task("a", 0)).unwrap();
        let b = store.create(with_deps("b", &[&a.id, &a.id, &format!(" {} ", a.id)])).unwrap();
        // Trimmed and deduplicated.
        assert_eq!(b.depends_on, vec![a.id.clone()]);

        assert_eq!(store.create(with_deps("t", &[""])).unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn unmet_dependencies_block_start_and_completion() {
        let (_g, store) = store();
        let a = store.create(new_task("a", 0)).unwrap();
        let b = store.create(with_deps("b", &[&a.id])).unwrap();

        // Neither starting nor completing is allowed while the dep is open.
        // The refusal is structured (D32): kind + blockingTasks, not just prose.
        let err = store.update_status(&b.id, TaskStatus::InProgress, None).unwrap_err();
        assert_eq!(err.kind(), "dependencies_unmet");
        assert!(err.to_string().contains(&a.id), "error must name the unmet dep: {err}");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["blockingTasks"][0]["id"], a.id);
        assert_eq!(json["blockingTasks"][0]["status"], "todo");
        let err = store.update_status(&b.id, TaskStatus::Done, None).unwrap_err();
        assert_eq!(err.kind(), "dependencies_unmet");

        // Blocked (with reason) and back to todo stay free — only start/finish unlock.
        store.update_status(&b.id, TaskStatus::Blocked, Some("waiting on a".into())).unwrap();
        store.update_status(&b.id, TaskStatus::Todo, None).unwrap();

        store.update_status(&a.id, TaskStatus::Done, None).unwrap();
        let started = store.update_status(&b.id, TaskStatus::InProgress, None).unwrap();
        assert_eq!(started.status, TaskStatus::InProgress);
    }

    #[test]
    fn missing_dep_file_counts_as_unmet() {
        let (_g, store) = store();
        let a = store.create(new_task("a", 0)).unwrap();
        let b = store.create(with_deps("b", &[&a.id])).unwrap();
        std::fs::remove_file(store.dir.join(format!("{}.json", a.id))).unwrap();

        let err = store.update_status(&b.id, TaskStatus::InProgress, None).unwrap_err();
        assert!(err.to_string().contains("missing"), "vanished dep must read as unmet: {err}");
    }

    #[test]
    fn set_depends_on_rejects_self_and_cycles() {
        let (_g, store) = store();
        let a = store.create(new_task("a", 0)).unwrap();
        let b = store.create(with_deps("b", &[&a.id])).unwrap();
        let c = store.create(with_deps("c", &[&b.id])).unwrap();

        assert_eq!(
            store.set_depends_on(&a.id, vec![a.id.clone()]).unwrap_err().kind(),
            "invalid_input"
        );
        // a ← b ← c already holds; a → c would close the loop.
        let err = store.set_depends_on(&a.id, vec![c.id.clone()]).unwrap_err();
        assert!(err.to_string().contains("cycle"), "cycle must be named: {err}");

        // A legal edit replaces the list wholesale.
        let edited = store.set_depends_on(&c.id, vec![a.id.clone()]).unwrap();
        assert_eq!(edited.depends_on, vec![a.id.clone()]);
    }

    // ── Attribute edit / delete ─────────────────────────────────────────────

    fn edit_of(title: &str, priority: u8, tags: &[&str]) -> TaskEdit {
        TaskEdit {
            title: title.into(),
            description: String::new(),
            priority,
            tags: tags.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn edit_rewrites_attributes_and_validates_like_create() {
        let (_g, store) = store();
        let t = store.create(new_task("typpo", 2)).unwrap();

        let edited = store
            .edit(
                &t.id,
                TaskEdit {
                    title: "  fixed title  ".into(),
                    description: "now with context".into(),
                    priority: 0,
                    tags: vec!["ui".into(), " ui ".into(), "  ".into(), "core".into()],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(edited.title, "fixed title", "title is trimmed like create");
        assert_eq!(edited.description, "now with context");
        assert_eq!(edited.priority, 0);
        assert_eq!(edited.tags, vec!["ui".to_string(), "core".to_string()], "trimmed and deduped");

        // Same rules as create — a blank title or an out-of-range priority is
        // refused rather than written.
        assert_eq!(store.edit(&t.id, edit_of("   ", 0, &[])).unwrap_err().kind(), "invalid_input");
        assert_eq!(store.edit(&t.id, edit_of("ok", 9, &[])).unwrap_err().kind(), "invalid_input");
        assert_eq!(store.get(&t.id).unwrap().title, "fixed title", "refusals write nothing");

        assert_eq!(store.edit("T-9999", edit_of("ghost", 0, &[])).unwrap_err().kind(), "not_found");
    }

    #[test]
    fn edit_leaves_the_other_dimensions_alone() {
        let (_g, store) = store();
        let dep = store.create(new_task("dep", 0)).unwrap();
        let t = store.create(with_deps("verified work", &[&dep.id])).unwrap();
        store.update_status(&dep.id, TaskStatus::Done, None).unwrap();
        store.update_status(&t.id, TaskStatus::Done, None).unwrap();
        store.set_assignee(&t.id, Some("fe".into())).unwrap();
        store.set_verification(&t.id, true, Some("ran the suite".into()), None).unwrap();
        store.set_archived(&t.id, true).unwrap();

        let edited = store.edit(&t.id, edit_of("renamed", 3, &["docs"])).unwrap();

        // A typo fix is not a change of the completion claim: verification
        // survives (unlike a status change, which invalidates it).
        assert!(edited.is_verified(), "editing attributes must not un-verify");
        assert_eq!(edited.verified_note.as_deref(), Some("ran the suite"));
        assert_eq!(edited.status, TaskStatus::Done);
        assert!(edited.archived);
        assert_eq!(edited.assignee.as_deref(), Some("fe"));
        assert_eq!(edited.depends_on, vec![dep.id]);
    }

    #[test]
    fn delete_removes_the_file_and_returns_the_task() {
        let (_g, store) = store();
        let t = store.create(new_task("scrap this", 1)).unwrap();

        let deleted = store.delete(&t.id).unwrap();
        assert_eq!(deleted.title, "scrap this", "caller needs the title for the ledger line");
        assert!(!store.dir.join(format!("{}.json", t.id)).exists());
        assert_eq!(store.get(&t.id).unwrap_err().kind(), "not_found");
        assert_eq!(store.delete(&t.id).unwrap_err().kind(), "not_found");

        // Ids are derived from the files that exist, so a deleted id is handed
        // out again. Accepted deliberately: the store is stateless by design
        // (no counter to keep honest across backups, imports and hand edits),
        // and the ledger line for the deletion carries the old title, so the
        // audit trail still distinguishes the two occupants of the id.
        assert_eq!(store.create(new_task("next", 1)).unwrap().id, "T-0001");
    }

    /// Ids become paths, so only the shape `next_id` mints is accepted — every
    /// separator, dot or drive letter is a way out of `tasks/` (2026-11-09
    /// report against D149's write_task_file).
    #[test]
    fn task_ids_must_be_t_and_digits() {
        for ok in ["T-0001", "T-1", "T-123456789"] {
            assert!(validate_task_id(ok).is_ok(), "{ok}");
        }
        for bad in [
            "", "T-", "t-0001", "T-0001 ", " T-0001", "T-12a", "T-0001.json", "../.", "..\\.",
            "../T-0001", "T-0001/..", "T-0001\\..", "C:T-0001", "T-1234567890",
        ] {
            assert_eq!(validate_task_id(bad).unwrap_err().kind(), "invalid_input", "{bad:?}");
        }
    }

    /// Every store entry point checks the id before touching the disk, a copied
    /// task file (whose id names another task) is refused rather than acted on
    /// under the wrong title, and listings skip it instead of handing its id on.
    #[test]
    fn malformed_ids_and_copied_task_files_are_refused() {
        let (dir, store) = store();
        let t = store.create(new_task("real", 1)).unwrap();
        // A planted copy outside tasks/ — the shape of the reported attack.
        std::fs::copy(store.task_file(&t.id).unwrap(), dir.path().join("..json")).unwrap();
        for id in ["../.", "..\\."] {
            assert_eq!(store.get(id).unwrap_err().kind(), "invalid_input");
            let err = store.update_status(id, TaskStatus::Done, None).unwrap_err();
            assert_eq!(err.kind(), "invalid_input");
            assert_eq!(store.delete(id).unwrap_err().kind(), "invalid_input");
        }
        // A copy inside tasks/ under another valid name.
        std::fs::copy(store.task_file(&t.id).unwrap(), store.task_file("T-0042").unwrap()).unwrap();
        let err = store.get("T-0042").unwrap_err();
        assert!(err.to_string().contains("holds task T-0001"), "{err}");
        let ids: Vec<String> = store.list().unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![t.id.clone()], "the copy is not listed twice under one id");
        // dependsOn ids are paths too.
        let mut bad_dep = new_task("dep", 1);
        bad_dep.depends_on = vec!["../.".into()];
        assert_eq!(store.create(bad_dep).unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn delete_is_refused_while_another_task_depends_on_it() {
        let (_g, store) = store();
        let a = store.create(new_task("prerequisite", 0)).unwrap();
        let b = store.create(with_deps("b", &[&a.id])).unwrap();
        let c = store.create(with_deps("c", &[&a.id])).unwrap();

        // Structured refusal: every dependent is named, and nothing is deleted
        // or silently rewritten.
        let err = store.delete(&a.id).unwrap_err();
        assert_eq!(err.kind(), "has_dependents");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["dependentTasks"][0], b.id);
        assert_eq!(json["dependentTasks"][1], c.id);
        assert!(store.get(&a.id).is_ok(), "a refused delete leaves the file in place");
        assert_eq!(store.get(&b.id).unwrap().depends_on, vec![a.id.clone()]);

        // Clearing the edges (the user's own explicit act) unblocks deletion.
        store.set_depends_on(&b.id, vec![]).unwrap();
        store.set_depends_on(&c.id, vec![]).unwrap();
        assert!(store.delete(&a.id).is_ok());

        // A task's own dependencies never block its deletion — only inbound edges do.
        let d = store.create(new_task("upstream", 0)).unwrap();
        let e = store.create(with_deps("downstream", &[&d.id])).unwrap();
        assert!(store.delete(&e.id).is_ok());
    }

    #[test]
    fn assignee_normalizes_and_clears() {
        let (_g, store) = store();
        let t = store
            .create(NewTask { title: "t".into(), assignee: Some("  fe ".into()), ..Default::default() })
            .unwrap();
        assert_eq!(t.assignee.as_deref(), Some("fe"));

        let t = store.set_assignee(&t.id, Some("   ".into())).unwrap();
        assert_eq!(t.assignee, None, "whitespace assignee must normalize to unassigned");

        let t = store.set_assignee(&t.id, Some("integ".into())).unwrap();
        assert_eq!(t.assignee.as_deref(), Some("integ"));
        let t = store.set_assignee(&t.id, None).unwrap();
        assert_eq!(t.assignee, None);
    }

    // ── Cancelled (D169) ─────────────────────────────────────────────────────

    #[test]
    fn cancelling_needs_a_reason_and_reopening_clears_it() {
        let (_g, store) = store();
        let t = store.create(new_task("superseded", 1)).unwrap();

        let err = store.update_status(&t.id, TaskStatus::Cancelled, Some("  ".into())).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");

        let cancelled = store
            .update_status(&t.id, TaskStatus::Cancelled, Some("replaced by T-0009".into()))
            .unwrap();
        assert_eq!(cancelled.cancel_reason.as_deref(), Some("replaced by T-0009"));
        assert!(cancelled.blocked_reason.is_none());

        // Verification only attests a completion claim; a cancellation is not one.
        assert_eq!(
            store.set_verification(&t.id, true, Some("ran".into()), None).unwrap_err().kind(),
            "invalid_input"
        );
        // A closed task archives; reopening pulls it out and drops the reason.
        assert!(store.set_archived(&t.id, true).unwrap().archived);
        let reopened = store.update_status(&t.id, TaskStatus::Todo, None).unwrap();
        assert!(!reopened.archived);
        assert!(reopened.cancel_reason.is_none());

        // The wire name round-trips and pre-D169 files still parse.
        assert_eq!("cancelled".parse::<TaskStatus>().unwrap(), TaskStatus::Cancelled);
        let old: Task = serde_json::from_str(r#"{"schemaVersion":1,"id":"T-9997","title":"old","status":"done","priority":1,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}"#).unwrap();
        assert!(old.cancel_reason.is_none());
    }

    #[test]
    fn a_cancelled_prerequisite_never_unlocks_its_dependents() {
        let (_g, store) = store();
        let old = store.create(new_task("old plan", 1)).unwrap();
        let next = store
            .create(NewTask {
                title: "builds on the old plan".into(),
                depends_on: vec![old.id.clone()],
                ..Default::default()
            })
            .unwrap();
        store.update_status(&old.id, TaskStatus::Cancelled, Some("dropped".into())).unwrap();

        let err = store.update_status(&next.id, TaskStatus::InProgress, None).unwrap_err();
        assert_eq!(err.kind(), "dependencies_unmet");
        let message = err.to_string();
        assert!(message.contains("(cancelled)"), "{message}");
        assert!(message.contains("dependsOn"), "the refusal must say what to do: {message}");

        let all = store.list().unwrap();
        let steps = next_steps(&all);
        assert_eq!(steps.len(), 1, "a cancelled task is not a next step");
        let note = steps[0].note().unwrap();
        assert!(note.contains("cancelled — re-point dependsOn"), "{note}");
        assert!(!steps[0].is_ready());

        // Re-pointing frees it.
        let replacement = store.create(new_task("new plan", 1)).unwrap();
        store.set_depends_on(&next.id, vec![replacement.id.clone()]).unwrap();
        store.update_status(&replacement.id, TaskStatus::Done, None).unwrap();
        assert!(store.update_status(&next.id, TaskStatus::InProgress, None).is_ok());
    }

    #[test]
    fn cancelled_tasks_leave_the_progress_denominator() {
        let (_g, store) = store();
        let a = store.create(new_task("a", 1)).unwrap();
        let b = store.create(new_task("b", 1)).unwrap();
        let c = store.create(new_task("c", 1)).unwrap();
        store.update_status(&a.id, TaskStatus::Done, None).unwrap();
        store.update_status(&b.id, TaskStatus::Cancelled, Some("superseded".into())).unwrap();
        let counts = compute_counts(&store.list().unwrap());
        assert_eq!((counts.total, counts.done, counts.cancelled, counts.todo), (3, 1, 1, 1));
        assert_eq!(counts.progress_percent(), 50, "1 of the 2 live tasks");
        store.update_status(&c.id, TaskStatus::Cancelled, Some("dropped".into())).unwrap();
        assert_eq!(compute_counts(&store.list().unwrap()).progress_percent(), 100);
        assert_eq!(TaskCounts::default().progress_percent(), 0);
    }

    #[test]
    fn moving_between_done_and_cancelled_unarchives_but_keeps_the_fold_marker() {
        let (_g, store) = store();
        let t = store.create(new_task("filed", 1)).unwrap();
        store.update_status(&t.id, TaskStatus::Done, None).unwrap();
        store.set_spec_folded(&t.id, Some("2026-11-18T00:00:00Z".into()), Some("h".into())).unwrap();
        store.set_archived(&t.id, true).unwrap();

        // A filed-away done task that gets cancelled comes back into view;
        // its folded text is already in specs/, so the marker stays.
        let cancelled = store.update_status(&t.id, TaskStatus::Cancelled, Some("dropped".into())).unwrap();
        assert!(!cancelled.archived);
        assert!(cancelled.spec_folded_at.is_some());

        // An archived cancelled task moved to done must pass the archive rules
        // again, not ride in on the old flag.
        store.set_archived(&t.id, true).unwrap();
        let done = store.update_status(&t.id, TaskStatus::Done, None).unwrap();
        assert!(!done.archived);
        // Reopening is what clears the marker.
        assert!(store.update_status(&t.id, TaskStatus::Todo, None).unwrap().spec_folded_at.is_none());
    }

    #[test]
    fn an_edit_refused_on_either_half_writes_nothing() {
        let (_g, store) = store();
        let a = store.create(new_task("a", 1)).unwrap();
        let b = store.create(new_task("b", 1)).unwrap();
        let bad_priority = TaskEdit { title: "b".into(), priority: 9, ..Default::default() };
        assert!(store.edit_with_deps(&b.id, bad_priority, Some(vec![a.id.clone()])).is_err());
        assert!(store.get(&b.id).unwrap().depends_on.is_empty(), "valid deps must not land alone");
    }

    // ── Steps (D170) ─────────────────────────────────────────────────────────

    #[test]
    fn steps_tick_without_moving_status_and_survive_a_reword() {
        let (_g, store) = store();
        let t = store
            .create(NewTask {
                title: "section 2".into(),
                steps: vec!["inventory".into(), " ".into(), "walkthrough".into(), "decide".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(t.steps.len(), 3, "blank titles are dropped");

        let ticked = store.set_step(&t.id, 2, true).unwrap();
        assert!(ticked.steps[1].done);
        assert_eq!(ticked.status, TaskStatus::Todo, "a checklist never moves the status");
        assert_eq!(store.set_step(&t.id, 0, true).unwrap_err().kind(), "invalid_input");
        assert_eq!(store.set_step(&t.id, 4, true).unwrap_err().kind(), "invalid_input");

        // Rewording one step keeps the others' checkmarks.
        let edit = TaskEdit {
            title: "section 2".into(),
            priority: 0,
            steps: Some(vec!["inventory".into(), "walkthrough".into(), "decide with the PM".into()]),
            ..Default::default()
        };
        let edited = store.edit(&t.id, edit).unwrap();
        assert_eq!(edited.steps.iter().map(|s| s.done).collect::<Vec<_>>(), vec![false, true, false]);

        // The next-step note carries the count.
        let all = store.list().unwrap();
        assert!(next_steps(&all)[0].note().unwrap().contains("steps 1/3"));

        let too_many = (0..=MAX_TASK_STEPS).map(|i| format!("s{i}")).collect();
        let edit = TaskEdit { title: "x".into(), steps: Some(too_many), ..Default::default() };
        assert_eq!(store.edit(&t.id, edit).unwrap_err().kind(), "invalid_input");
    }
}
