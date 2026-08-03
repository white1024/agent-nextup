use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::workspace::atomic::atomic_write_json;
use crate::workspace::context::now_rfc3339;

pub const RULES_SCHEMA_VERSION: u32 = 1;

/// `.nextup/rules.json` — tailored execution guidelines for AI sessions.
///
/// This file is the target of the self-improvement flywheel: the post-mortem
/// phase appends `RuleRevision` entries and edits `execution_guidelines`, so
/// the revision history doubles as an audit trail of how the workflow evolved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRules {
    pub schema_version: u32,
    pub execution_guidelines: Vec<String>,
    pub flywheel: FlywheelConfig,
    /// Evidence-based learned lessons (D20). Unlike the baseline guidelines
    /// (plain prose), every lesson cites replayable ledger entries and
    /// carries usage metadata so stale ones rotate out instead of piling up.
    #[serde(default)]
    pub lessons: Vec<Lesson>,
    /// Rotated-out lessons. Never deleted by the engine: absence of firing
    /// is not proof of uselessness — deletion is a human call.
    #[serde(default)]
    pub archived_lessons: Vec<Lesson>,
    /// Free-form extension point for domain packs; the core never interprets it.
    #[serde(default)]
    pub custom: serde_json::Value,
}

/// One learned lesson. `evidence` holds `at` timestamps of the ledger events
/// the lesson was distilled from — a lesson that cannot cite what actually
/// happened is an opinion, and opinions don't enter rules.json.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lesson {
    pub id: String,
    pub text: String,
    pub evidence: Vec<String>,
    pub added_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fired: Option<String>,
    #[serde(default)]
    pub fired_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlywheelConfig {
    pub enabled: bool,
    pub post_mortem_prompts: Vec<String>,
    #[serde(default)]
    pub revision_history: Vec<RuleRevision>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuleRevision {
    pub at: String,
    pub summary: String,
}

impl ProjectRules {
    /// Baseline guidelines every new workspace starts with. Domain-agnostic:
    /// they describe *how to execute*, not *what the project is*.
    pub fn default_rules() -> Self {
        Self {
            schema_version: RULES_SCHEMA_VERSION,
            execution_guidelines: vec![
                "Session bootstrap: read .nextup/snapshots/latest_handoff.md before anything else."
                    .into(),
                "Work in atomic tasks: keep each task in tasks/ small enough to finish in one session."
                    .into(),
                "Update task status as you go; completing a task refreshes the handoff snapshot."
                    .into(),
                "Record every technical decision and blocker in the ledger so the next session inherits them."
                    .into(),
                "Deliver outputs into artifacts/, never scattered across the workspace.".into(),
                "Respect the boundaries declared in .nextup/context.json.".into(),
            ],
            flywheel: FlywheelConfig {
                enabled: true,
                post_mortem_prompts: vec![
                    "Which steps produced friction or rework this cycle?".into(),
                    "Which guideline, if added or changed, would have prevented it?".into(),
                    "What should the next session do differently first?".into(),
                ],
                revision_history: vec![RuleRevision {
                    at: now_rfc3339(),
                    summary: "Initial baseline rules generated at workspace initialization.".into(),
                }],
            },
            lessons: Vec::new(),
            archived_lessons: Vec::new(),
            custom: serde_json::Value::Null,
        }
    }
}

pub fn load_rules(path: &Path) -> Result<ProjectRules> {
    super::atomic::read_json_file(path)
}

pub fn save_rules(path: &Path, rules: &ProjectRules) -> Result<()> {
    atomic_write_json(path, rules)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_rules_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rules.json");
        let rules = ProjectRules::default_rules();
        save_rules(&path, &rules).unwrap();
        assert_eq!(load_rules(&path).unwrap(), rules);
    }

    #[test]
    fn default_rules_are_nonempty_and_flywheel_enabled() {
        let rules = ProjectRules::default_rules();
        assert!(!rules.execution_guidelines.is_empty());
        assert!(rules.flywheel.enabled);
        assert_eq!(rules.flywheel.revision_history.len(), 1);
        assert!(rules.lessons.is_empty());
    }

    #[test]
    fn legacy_rules_without_lessons_fields_parse() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rules.json");
        std::fs::write(
            &path,
            br#"{"schemaVersion":1,"executionGuidelines":["x"],"flywheel":{"enabled":true,"postMortemPrompts":[],"revisionHistory":[]}}"#,
        )
        .unwrap();
        let rules = load_rules(&path).unwrap();
        assert!(rules.lessons.is_empty());
        assert!(rules.archived_lessons.is_empty());
    }
}
