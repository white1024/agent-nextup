use std::path::Path;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::workspace::atomic::atomic_write_json;

pub const CONTEXT_SCHEMA_VERSION: u32 = 1;

/// `.nextup/context.json` — project metadata, goals and boundaries.
/// Domain-agnostic by design: `domain` is a free-form label, never a switch
/// the core logic branches on.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContext {
    pub schema_version: u32,
    /// Stable workspace identity (D48): survives folder moves and renames so
    /// app-level structures (teams) can reference this workspace by id, not
    /// path. Absent on pre-D48 workspaces — minted lazily by
    /// `ops::ensure_workspace_id` on the first explicit need (team join),
    /// never on open (opening is reading, D41).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub name: String,
    pub domain: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub goals: Vec<String>,
    #[serde(default)]
    pub boundaries: Vec<String>,
    #[serde(default)]
    pub milestones: Vec<Milestone>,
    /// Do-not-re-pitch list: approaches the user already rejected, with the
    /// why. An AI session must check this before proposing; re-raising one
    /// needs new facts and explicit user consent. Append-oriented — entries
    /// are history, removal is a deliberate human edit.
    #[serde(default)]
    pub rejected: Vec<RejectedAlternative>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RejectedAlternative {
    pub proposal: String,
    pub reason: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub done: bool,
    /// `done` records the completion claim; `verified` records that a human
    /// (or a fresh session) checked it against reality. Reopening clears it.
    #[serde(default)]
    pub verified: bool,
}

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

impl ProjectContext {
    pub fn new(
        name: impl Into<String>,
        domain: impl Into<String>,
        description: impl Into<String>,
        goals: Vec<String>,
        boundaries: Vec<String>,
    ) -> Self {
        let now = now_rfc3339();
        Self {
            schema_version: CONTEXT_SCHEMA_VERSION,
            workspace_id: Some(crate::workspace::ids::uuid_v4()),
            name: name.into(),
            domain: domain.into(),
            description: description.into(),
            goals,
            boundaries,
            milestones: Vec::new(),
            rejected: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

pub fn load_context(path: &Path) -> Result<ProjectContext> {
    if !path.exists() {
        return Err(NextUpError::NotFound(format!(
            "not an Agent NextUp workspace: {} is missing",
            path.display()
        )));
    }
    let ctx: ProjectContext = super::atomic::read_json_file(path)?;
    if ctx.schema_version > CONTEXT_SCHEMA_VERSION {
        return Err(NextUpError::Workspace(format!(
            "context schema v{} is newer than this app supports (v{})",
            ctx.schema_version, CONTEXT_SCHEMA_VERSION
        )));
    }
    Ok(ctx)
}

pub fn save_context(path: &Path, ctx: &ProjectContext) -> Result<()> {
    atomic_write_json(path, ctx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context.json");
        let ctx = ProjectContext::new(
            "demo",
            "coding",
            "a demo project",
            vec!["goal 1".into()],
            vec!["no scope creep".into()],
        );
        save_context(&path, &ctx).unwrap();
        let loaded = load_context(&path).unwrap();
        assert_eq!(loaded, ctx);
    }

    #[test]
    fn legacy_context_without_rejected_field_parses() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context.json");
        std::fs::write(
            &path,
            br#"{"schemaVersion":1,"name":"old","domain":"coding","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        let ctx = load_context(&path).unwrap();
        assert!(ctx.rejected.is_empty());
        assert!(ctx.milestones.is_empty());
        assert!(ctx.workspace_id.is_none(), "pre-D48 contexts load without an id");
    }

    #[test]
    fn new_contexts_are_minted_with_a_workspace_id() {
        let ctx = ProjectContext::new("x", "y", "", vec![], vec![]);
        let id = ctx.workspace_id.expect("fresh contexts carry a stable id");
        assert_eq!(id.len(), 36);
    }

    #[test]
    fn missing_file_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let err = load_context(&dir.path().join("context.json")).unwrap_err();
        assert_eq!(err.kind(), "not_found");
    }

    #[test]
    fn future_schema_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context.json");
        let mut ctx = ProjectContext::new("x", "y", "", vec![], vec![]);
        ctx.schema_version = 999;
        save_context(&path, &ctx).unwrap();
        let err = load_context(&path).unwrap_err();
        assert_eq!(err.kind(), "workspace");
    }
}
