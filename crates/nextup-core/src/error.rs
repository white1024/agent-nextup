use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// One unmet prerequisite behind a `DependenciesUnmet` refusal: the blocking
/// task's id plus its wire status label (`todo` / `in_progress` / `blocked`),
/// or `missing` when the dependency file vanished.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnmetDependency {
    pub id: String,
    pub status: String,
}

fn render_unmet(deps: &[UnmetDependency]) -> String {
    deps.iter().map(|d| format!("{} ({})", d.id, d.status)).collect::<Vec<_>>().join(", ")
}

/// Unified error type for the whole system.
///
/// Serializes to `{ "kind": "...", "message": "..." }` so it can cross the
/// Tauri IPC bridge and be pattern-matched by the frontend.
#[derive(Debug, thiserror::Error)]
pub enum NextUpError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// I/O error carrying the file path — prefer this (via
    /// `atomic::read_file` / `atomic::read_json_file`) over bare `Io` so the
    /// message says which file failed. Same `kind()` as `Io`.
    #[error("{path}: I/O error: {source}")]
    IoAt {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// JSON parse error carrying the file path — see `IoAt`. Same `kind()` as `Json`.
    #[error("{path}: JSON error: {source}")]
    JsonAt {
        path: String,
        #[source]
        source: serde_json::Error,
    },

    #[error("encryption error: {0}")]
    Crypto(String),

    #[error("keystore error: {0}")]
    Keystore(String),

    #[error("workspace error: {0}")]
    Workspace(String),

    #[error("workflow error: {0}")]
    Workflow(String),

    #[error("task error: {0}")]
    Task(String),

    #[error("backup error: {0}")]
    Backup(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// Dependency gate refusal (D31): a task may not start/finish while its
    /// prerequisites are open. Carries the blocking tasks (wire field
    /// `blockingTasks`) so an orchestrator can branch on data — wait for a
    /// specific task — instead of parsing this message.
    #[error("cannot move {id} to {to}: dependencies not done yet: {}", render_unmet(.blocking))]
    DependenciesUnmet {
        id: String,
        to: String,
        blocking: Vec<UnmetDependency>,
    },

    /// Deletion refusal: other tasks still declare this one as a prerequisite
    /// (wire field `dependentTasks`). Carries the dependents so the caller can
    /// offer "go edit these first" instead of parsing the message — the same
    /// structured-refusal contract as `DependenciesUnmet`, seen from the other
    /// end of the edge.
    #[error("cannot delete {id}: still a prerequisite of {}", .dependents.join(", "))]
    HasDependents {
        id: String,
        dependents: Vec<String>,
    },

    /// Spec-fold refusal (D79): the task's delta specs conflict with the
    /// current main specs (wire field `conflicts`). The archive is refused
    /// whole — the truth layer never absorbs a broken delta; fix the delta
    /// (or the hand-edited spec) and archive again.
    #[error("cannot fold {id}'s delta specs into specs/: {}", .conflicts.join("; "))]
    SpecFoldConflict {
        id: String,
        conflicts: Vec<String>,
    },

    /// Claim CAS refusal (D31): the task already belongs to someone else
    /// (wire field `currentAssignee`). Distinct from `InvalidInput` so
    /// "ask the dispatcher to reassign" is machine-readable.
    #[error(
        "{id} is already claimed by \"{current_assignee}\" — claiming may not steal; \
         ask a human/orchestrator to reassign"
    )]
    AlreadyClaimed {
        id: String,
        current_assignee: String,
    },

    #[error("not found: {0}")]
    NotFound(String),

    #[error("IPC error: {0}")]
    Ipc(String),

    /// Embedded terminal failures (D50): PTY allocation, agent CLI spawn,
    /// or I/O against a live session. Distinct from `Workspace` because the
    /// terminal is an app-level facility — a dead session is not a workspace
    /// integrity problem.
    #[error("terminal error: {0}")]
    Terminal(String),

    #[error("provider error: {0}")]
    Provider(String),

    /// Agent-access denial (tool not authorized / access disabled). Distinct
    /// from `Provider` so callers can programmatically tell "go grant access
    /// in the app" apart from "the LLM provider failed".
    #[error("unauthorized: {0}")]
    Unauthorized(String),
}

/// The refusal kinds an agent is expected to branch on, each paired with the
/// one move that resolves it. **Guide §9 renders this list** (`@ERROR_KINDS@`)
/// instead of restating it in prose — the hand-written version silently lost
/// `workflow`, the kind returned by the single most predictable refusal there
/// is (an exit gate that has not passed), so agents were told to branch on
/// `kind` and never given that case (D104).
///
/// Adding a variant to [`NextUpError`] that a hub tool can return? Add its
/// kind here. Everything not listed (`io`, `json`, `workspace`, `keystore`,
/// `backup`, `ipc`, `terminal`, `provider`, `crypto`) is an environment or
/// integrity failure: there is no agent-side move, it goes to the user.
///
/// Deliberately absent: `has_dependents` and `spec_fold_conflict`. Both are
/// real structured refusals, but only the IPC surface can provoke them —
/// deletion and archiving are app-side actions and the agent tool surface has
/// neither (D60). Documenting a refusal an agent cannot receive teaches it to
/// handle a case that never arrives.
pub const AGENT_ERROR_KINDS: [(&str, &str); 6] = [
    ("unauthorized", "the tool is not authorised in this workspace. Ask the user to enable it, and **do not** reach the same end by editing files (that succeeds and leaves no ledger trail)"),
    ("invalid_input", "fix the arguments and retry"),
    ("not_found", "that id or path does not exist. List first; do not retry the guess"),
    ("workflow", "the phase cannot advance — the message names every gate still unmet with its observed value (or says the workflow is already complete). Satisfy them for real; forcing is human-only"),
    ("dependencies_unmet", "prerequisites are not clear yet (carries `blockingTasks[]`, each `{id, status}`) — look at those or wait for them"),
    ("already_claimed", "someone else holds the task (carries `currentAssignee`) — go and coordinate with them; claiming may not steal"),
];

impl NextUpError {
    pub fn kind(&self) -> &'static str {
        match self {
            NextUpError::Io(_) => "io",
            NextUpError::IoAt { .. } => "io",
            NextUpError::Json(_) => "json",
            NextUpError::JsonAt { .. } => "json",
            NextUpError::Crypto(_) => "crypto",
            NextUpError::Keystore(_) => "keystore",
            NextUpError::Workspace(_) => "workspace",
            NextUpError::Workflow(_) => "workflow",
            NextUpError::Task(_) => "task",
            NextUpError::Backup(_) => "backup",
            NextUpError::InvalidInput(_) => "invalid_input",
            NextUpError::DependenciesUnmet { .. } => "dependencies_unmet",
            NextUpError::HasDependents { .. } => "has_dependents",
            NextUpError::SpecFoldConflict { .. } => "spec_fold_conflict",
            NextUpError::AlreadyClaimed { .. } => "already_claimed",
            NextUpError::NotFound(_) => "not_found",
            NextUpError::Ipc(_) => "ipc",
            NextUpError::Terminal(_) => "terminal",
            NextUpError::Provider(_) => "provider",
            NextUpError::Unauthorized(_) => "unauthorized",
        }
    }
}

impl Serialize for NextUpError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        // Collaboration refusals carry their data as extra fields next to the
        // usual `{kind,message}` pair, so callers branch on structure, never
        // on message text.
        match self {
            NextUpError::DependenciesUnmet { blocking, .. } => {
                let mut s = serializer.serialize_struct("NextUpError", 3)?;
                s.serialize_field("kind", self.kind())?;
                s.serialize_field("message", &self.to_string())?;
                s.serialize_field("blockingTasks", blocking)?;
                s.end()
            }
            NextUpError::HasDependents { dependents, .. } => {
                let mut s = serializer.serialize_struct("NextUpError", 3)?;
                s.serialize_field("kind", self.kind())?;
                s.serialize_field("message", &self.to_string())?;
                s.serialize_field("dependentTasks", dependents)?;
                s.end()
            }
            NextUpError::AlreadyClaimed { current_assignee, .. } => {
                let mut s = serializer.serialize_struct("NextUpError", 3)?;
                s.serialize_field("kind", self.kind())?;
                s.serialize_field("message", &self.to_string())?;
                s.serialize_field("currentAssignee", current_assignee)?;
                s.end()
            }
            NextUpError::SpecFoldConflict { conflicts, .. } => {
                let mut s = serializer.serialize_struct("NextUpError", 3)?;
                s.serialize_field("kind", self.kind())?;
                s.serialize_field("message", &self.to_string())?;
                s.serialize_field("conflicts", conflicts)?;
                s.end()
            }
            _ => {
                let mut s = serializer.serialize_struct("NextUpError", 2)?;
                s.serialize_field("kind", self.kind())?;
                s.serialize_field("message", &self.to_string())?;
                s.end()
            }
        }
    }
}

pub type Result<T> = std::result::Result<T, NextUpError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_kind_and_message() {
        let err = NextUpError::Crypto("bad key".into());
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "crypto");
        assert_eq!(json["message"], "encryption error: bad key");
    }

    #[test]
    fn dependencies_unmet_carries_blocking_tasks() {
        let err = NextUpError::DependenciesUnmet {
            id: "T-0002".into(),
            to: "in_progress".into(),
            blocking: vec![
                UnmetDependency { id: "T-0001".into(), status: "todo".into() },
                UnmetDependency { id: "T-0003".into(), status: "missing".into() },
            ],
        };
        assert_eq!(err.kind(), "dependencies_unmet");
        // Message stays human-readable and names every blocker.
        assert_eq!(
            err.to_string(),
            "cannot move T-0002 to in_progress: dependencies not done yet: \
             T-0001 (todo), T-0003 (missing)"
        );
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "dependencies_unmet");
        assert_eq!(json["blockingTasks"][0]["id"], "T-0001");
        assert_eq!(json["blockingTasks"][0]["status"], "todo");
        assert_eq!(json["blockingTasks"][1]["status"], "missing");
    }

    #[test]
    fn has_dependents_carries_dependent_tasks() {
        let err = NextUpError::HasDependents {
            id: "T-0001".into(),
            dependents: vec!["T-0002".into(), "T-0003".into()],
        };
        assert_eq!(err.kind(), "has_dependents");
        // Message names every blocker so a plain-text channel stays useful.
        assert_eq!(err.to_string(), "cannot delete T-0001: still a prerequisite of T-0002, T-0003");
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["dependentTasks"][0], "T-0002");
        assert_eq!(json["dependentTasks"][1], "T-0003");
    }

    #[test]
    fn already_claimed_carries_current_assignee() {
        let err = NextUpError::AlreadyClaimed { id: "T-0001".into(), current_assignee: "fe".into() };
        assert_eq!(err.kind(), "already_claimed");
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "already_claimed");
        assert_eq!(json["currentAssignee"], "fe");
        assert!(json["message"].as_str().unwrap().contains("may not steal"));
    }

    #[test]
    fn spec_fold_conflict_carries_the_conflict_list() {
        let err = NextUpError::SpecFoldConflict {
            id: "T-0001".into(),
            conflicts: vec!["a".into(), "b".into()],
        };
        assert_eq!(err.kind(), "spec_fold_conflict");
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "spec_fold_conflict");
        assert_eq!(json["conflicts"], serde_json::json!(["a", "b"]));
        assert!(json["message"].as_str().unwrap().contains("T-0001"));
    }
}
