//! Task store: one atomic task = one JSON file under `tasks/`.
//!
//! Files are the source of truth — the store is stateless and every operation
//! re-reads the directory. Status (`todo/in_progress/blocked/done`) is the
//! *claim* dimension; verification (`verified_at`/`verified_note`) is the
//! separate *checked* dimension (D17). This module also owns the takeover
//! selectors ([`next_steps`], [`blocked`]) every handoff surface renders from,
//! so "what should the next session do first" is decided in exactly one place.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result, UnmetDependency};
use crate::workspace::atomic::atomic_write_json;
use crate::workspace::context::now_rfc3339;

pub const TASK_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    Blocked,
    Done,
}

impl TaskStatus {
    pub const ALL: [TaskStatus; 4] =
        [TaskStatus::Todo, TaskStatus::InProgress, TaskStatus::Blocked, TaskStatus::Done];

    pub fn label(&self) -> &'static str {
        match self {
            TaskStatus::Todo => "todo",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Blocked => "blocked",
            TaskStatus::Done => "done",
        }
    }
}

/// Parse the wire name (`label()` / serde snake_case) back into a status —
/// the single string↔enum mapping every delivery layer must use.
impl std::str::FromStr for TaskStatus {
    type Err = NextUpError;

    fn from_str(s: &str) -> Result<Self> {
        TaskStatus::ALL.into_iter().find(|st| st.label() == s).ok_or_else(|| {
            NextUpError::InvalidInput(format!(
                "unknown task status '{s}' (expected one of: todo, in_progress, blocked, done)"
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
    /// Collaboration fields (D31). Always part of the schema — a workspace
    /// without the collab module simply never surfaces them (fields stay
    /// universal, modules only gate exposure), so old files need no migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_note: Option<String>,
    /// Archived = closed and hidden from default listings (D40). Only a done
    /// task can be archived; the file stays in `tasks/` under its id, so
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
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCounts {
    pub total: usize,
    pub todo: usize,
    pub in_progress: usize,
    pub blocked: usize,
    pub done: usize,
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

    fn task_file(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// All tasks sorted by id. Non-task files and unparsable JSON are skipped
    /// (reported upstream via the watcher, but they never poison listing).
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
                tasks.push(task);
            }
        }
        tasks.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(tasks)
    }

    pub fn get(&self, id: &str) -> Result<Task> {
        let path = self.task_file(id);
        if !path.exists() {
            return Err(NextUpError::NotFound(format!("task {id} does not exist")));
        }
        super::atomic::read_json_file(&path)
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
            assignee: normalize_assignee(input.assignee),
            depends_on,
            verified_at: None,
            verified_note: None,
            archived: false,
            spec_folded_at: None,
            created_at: now.clone(),
            updated_at: now,
        };
        atomic_write_json(&self.task_file(&task.id), &task)?;
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
        let mut task = self.get(id)?;
        task.title = validate_title(edit.title)?;
        validate_priority(edit.priority)?;
        task.description = edit.description;
        task.priority = edit.priority;
        task.tags = normalize_tags(edit.tags);
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id), &task)?;
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
        std::fs::remove_file(self.task_file(id))?;
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

    /// Transition a task's status. Entering `Blocked` requires a reason;
    /// leaving it clears the reason. Any actual status change invalidates a
    /// prior verification — it attested a specific completed state, and that
    /// claim just changed.
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
        blocked_reason: Option<String>,
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
        if status == TaskStatus::Blocked {
            let reason = blocked_reason.map(|r| r.trim().to_string()).unwrap_or_default();
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
        if status != task.status {
            task.verified_at = None;
            task.verified_note = None;
        }
        // Reopening an archived task un-archives it (D40): archived is a
        // sub-state of done, so a task cannot be "in progress but archived".
        // The spec-fold marker clears with it (D79): reopened work may edit
        // its delta specs, and a stale marker would silently skip the
        // re-fold on the next archive.
        if status != TaskStatus::Done {
            task.archived = false;
            task.spec_folded_at = None;
        }
        task.status = status;
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id), &task)?;
        Ok(task)
    }

    /// Mark a done task as verified (with mandatory evidence: what was run /
    /// observed), or clear the mark. Verification only makes sense as a
    /// counter-check of a completion claim, so non-done tasks are rejected.
    pub fn set_verification(&self, id: &str, verified: bool, note: Option<String>) -> Result<Task> {
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
        } else {
            task.verified_at = None;
            task.verified_note = None;
        }
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id), &task)?;
        Ok(task)
    }

    /// Archive or un-archive a task (D40). Archiving is a presentation-tier
    /// close: the file stays in place (id lookups and dependency edges keep
    /// working), default listings hide it. Only a done task may be archived —
    /// open work must stay visible; un-archiving is always accepted.
    pub fn set_archived(&self, id: &str, archived: bool) -> Result<Task> {
        let mut task = self.get(id)?;
        if archived && task.status != TaskStatus::Done {
            return Err(NextUpError::InvalidInput(
                "only a done task can be archived".into(),
            ));
        }
        task.archived = archived;
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id), &task)?;
        Ok(task)
    }

    /// Engine bookkeeping (D79): stamp or clear the spec-fold marker. Not a
    /// user dimension — only the ops archive path calls this, right after a
    /// successful fold.
    pub fn set_spec_folded_at(&self, id: &str, at: Option<String>) -> Result<Task> {
        let mut task = self.get(id)?;
        task.spec_folded_at = at;
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id), &task)?;
        Ok(task)
    }

    /// Set or clear the assignee. Plain write primitive — claim semantics
    /// (compare-and-set, "may not steal") live in `ops::claim_task`, which
    /// runs this under the cross-process mutation lock.
    pub fn set_assignee(&self, id: &str, assignee: Option<String>) -> Result<Task> {
        let mut task = self.get(id)?;
        task.assignee = normalize_assignee(assignee);
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id), &task)?;
        Ok(task)
    }

    /// Replace a task's dependency list (validated: ids exist, no self-dep,
    /// no cycle). Editing dependencies does not touch verification — it
    /// changes when the task may start, not what was claimed done.
    pub fn set_depends_on(&self, id: &str, depends_on: Vec<String>) -> Result<Task> {
        let mut task = self.get(id)?;
        task.depends_on = self.validate_depends_on(Some(id), depends_on)?;
        task.updated_at = now_rfc3339();
        atomic_write_json(&self.task_file(id), &task)?;
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
            if !self.task_file(&dep).exists() {
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
    /// completed prerequisite). Carried on `DependenciesUnmet` so callers can
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
        }
    }
    counts
}

pub fn counts_for_dir(tasks_dir: &Path) -> Result<TaskCounts> {
    let tasks = TaskStore::new(tasks_dir).list()?;
    Ok(compute_counts(&tasks))
}

/// Open tasks in takeover order: in-progress first (finish what's started),
/// then priority, then id. Every takeover surface (handoff §3, the CLAUDE.md
/// state block) renders from this — the ordering rule lives here and nowhere
/// else, so the two surfaces can never disagree on what comes next.
pub fn next_steps(tasks: &[Task]) -> Vec<&Task> {
    let mut next: Vec<&Task> = tasks
        .iter()
        .filter(|t| matches!(t.status, TaskStatus::InProgress | TaskStatus::Todo))
        .collect();
    next.sort_by_key(|t| (t.status != TaskStatus::InProgress, t.priority, t.id.clone()));
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
        let err = store.set_verification(&t.id, true, Some("ran tests".into())).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");

        store.update_status(&t.id, TaskStatus::Done, None).unwrap();
        // Done but no evidence → still rejected.
        let err = store.set_verification(&t.id, true, None).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        let err = store.set_verification(&t.id, true, Some("  ".into())).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");

        let v = store
            .set_verification(&t.id, true, Some("cargo test all green".into()))
            .unwrap();
        assert!(v.is_verified());
        assert_eq!(v.verified_note.as_deref(), Some("cargo test all green"));

        // Clearing needs no evidence and wipes both fields.
        let cleared = store.set_verification(&t.id, false, None).unwrap();
        assert!(!cleared.is_verified());
        assert_eq!(cleared.verified_note, None);
    }

    #[test]
    fn status_change_invalidates_verification() {
        let (_g, store) = store();
        let t = store.create(new_task("v", 0)).unwrap();
        store.update_status(&t.id, TaskStatus::Done, None).unwrap();
        store.set_verification(&t.id, true, Some("walked the GUI".into())).unwrap();

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
        store.set_verification(&a.id, true, Some("verified live".into())).unwrap();

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
        store.set_verification(&t.id, true, Some("ran the suite".into())).unwrap();
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
}
