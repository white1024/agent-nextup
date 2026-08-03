use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::workspace::atomic::atomic_write_json;
use crate::workspace::context::{load_context, now_rfc3339};
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::tasks::{counts_for_dir, TaskCounts};
use crate::workspace::workflow::load_workflow;

pub const REGISTRY_SCHEMA_VERSION: u32 = 1;

/// App-level (not workspace-level) list of known workspaces at
/// `~/.nextup/registry.json`, most recently opened first. Entries are
/// pointers only — everything display-worthy is re-read from each
/// workspace's own files at overview time (files-as-truth).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRegistry {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub workspaces: Vec<RegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub root: String,
    pub name: String,
    pub domain: String,
    pub last_opened: String,
}

/// One row of the cross-workspace overview: registry pointer + fresh
/// state read from the workspace itself (None/false when unreadable).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOverview {
    pub root: String,
    pub name: String,
    pub domain: String,
    pub last_opened: String,
    pub exists: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_counts: Option<TaskCounts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_phase: Option<String>,
    /// Display title of the current phase (D42 pure-Chinese titles); None
    /// when the state points at an unknown phase — consumers fall back to
    /// the raw id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_phase_title: Option<String>,
    #[serde(default)]
    pub workflow_completed: bool,
    /// Instantiated harness identity (D45 — the project catalog groups by
    /// template). None when the workspace has no workflow.json yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_name: Option<String>,
}

pub fn default_registry_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".nextup").join("registry.json"))
}

pub fn load_registry(path: &Path) -> Result<WorkspaceRegistry> {
    if !path.is_file() {
        return Ok(WorkspaceRegistry {
            schema_version: REGISTRY_SCHEMA_VERSION,
            workspaces: Vec::new(),
        });
    }
    super::atomic::read_json_file(path)
}

/// Upsert `root` at the front (dedupe by case-insensitive path — Windows).
/// The registry is the project catalog (D45): once opened, a workspace stays
/// listed until explicitly removed — no size cap, no silent eviction.
pub fn record_workspace(path: &Path, root: &str, name: &str, domain: &str) -> Result<()> {
    let mut registry = load_registry(path)?;
    let key = normalize(root);
    registry.workspaces.retain(|w| normalize(&w.root) != key);
    registry.workspaces.insert(
        0,
        RegistryEntry {
            root: root.to_string(),
            name: name.to_string(),
            domain: domain.to_string(),
            last_opened: now_rfc3339(),
        },
    );
    registry.schema_version = REGISTRY_SCHEMA_VERSION;
    atomic_write_json(path, &registry)
}

/// Drop `root` from the registry (case-insensitive match, same rule as
/// `record_workspace`). Pointer removal only — the workspace's files are
/// never touched. Removing an absent root is a quiet no-op.
pub fn remove_workspace(path: &Path, root: &str) -> Result<()> {
    let mut registry = load_registry(path)?;
    let key = normalize(root);
    let before = registry.workspaces.len();
    registry.workspaces.retain(|w| normalize(&w.root) != key);
    if registry.workspaces.len() == before {
        return Ok(());
    }
    registry.schema_version = REGISTRY_SCHEMA_VERSION;
    atomic_write_json(path, &registry)
}

/// Fresh state for every registry entry. Missing/unreadable workspaces are
/// reported (exists=false), never silently dropped — the folder may live on
/// a detached drive.
pub fn overview(path: &Path) -> Result<Vec<WorkspaceOverview>> {
    let registry = load_registry(path)?;
    Ok(registry
        .workspaces
        .into_iter()
        .map(|entry| {
            let paths = WorkspacePaths::new(&entry.root);
            let ctx = load_context(&paths.context_file()).ok();
            let exists = ctx.is_some();
            let (name, domain) = match &ctx {
                Some(c) => (c.name.clone(), c.domain.clone()),
                None => (entry.name.clone(), entry.domain.clone()),
            };
            let workflow = load_workflow(&paths.workflow_file()).ok();
            WorkspaceOverview {
                root: entry.root,
                name,
                domain,
                last_opened: entry.last_opened,
                exists,
                task_counts: if exists { counts_for_dir(&paths.tasks_dir()).ok() } else { None },
                current_phase: workflow.as_ref().map(|w| w.state.current_phase.clone()),
                current_phase_title: workflow.as_ref().and_then(|w| {
                    w.phases
                        .iter()
                        .find(|p| p.id == w.state.current_phase)
                        .map(|p| p.title.clone())
                }),
                template_id: workflow.as_ref().map(|w| w.template_id.clone()),
                template_name: workflow.as_ref().map(|w| w.template_name.clone()),
                workflow_completed: workflow.map(|w| w.state.completed).unwrap_or(false),
            }
        })
        .collect())
}

fn normalize(root: &str) -> String {
    root.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::workspace::init::{initialize_project, InitProjectParams};

    #[test]
    fn record_dedupes_and_moves_to_front() {
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("registry.json");
        record_workspace(&reg, r"C:\ws\alpha", "Alpha", "coding").unwrap();
        record_workspace(&reg, r"C:\ws\beta", "Beta", "research").unwrap();
        // Same root, different casing/separators → replaces, not duplicates.
        record_workspace(&reg, "c:/WS/Alpha", "Alpha v2", "coding").unwrap();

        let registry = load_registry(&reg).unwrap();
        assert_eq!(registry.workspaces.len(), 2);
        assert_eq!(registry.workspaces[0].name, "Alpha v2");
        assert_eq!(registry.workspaces[1].name, "Beta");
    }

    #[test]
    fn catalog_never_evicts_entries() {
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("registry.json");
        for i in 0..25 {
            record_workspace(&reg, &format!(r"C:\ws\p{i}"), &format!("p{i}"), "x").unwrap();
        }
        let registry = load_registry(&reg).unwrap();
        assert_eq!(registry.workspaces.len(), 25, "no size cap — removal is explicit only (D45)");
        assert_eq!(registry.workspaces[0].name, "p24", "most recently opened stays first");
    }

    #[test]
    fn overview_reads_fresh_state_and_flags_missing() {
        let reg_dir = tempfile::tempdir().unwrap();
        let reg = reg_dir.path().join("registry.json");

        // A real workspace with one task.
        let ws = tempfile::tempdir().unwrap();
        let params = InitProjectParams {
            root: ws.path().to_string_lossy().into_owned(),
            name: "real".into(),
            domain: "coding".into(),
            description: String::new(),
            goals: vec![],
            boundaries: vec![],
            ..Default::default()
        };
        initialize_project(&params, &StaticKeyProvider([7u8; 32]), "0.1.0").unwrap();
        record_workspace(&reg, &params.root, "stale-name", "stale").unwrap();
        record_workspace(&reg, r"C:\definitely\gone", "ghost", "x").unwrap();

        let rows = overview(&reg).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(!rows[0].exists);
        assert_eq!(rows[0].name, "ghost");

        let real = &rows[1];
        assert!(real.exists);
        assert_eq!(real.name, "real", "name is re-read from context, not the stale pointer");
        assert!(real.task_counts.is_some());
        assert!(real.current_phase.is_some());
        assert!(real.current_phase_title.is_some(), "phase title resolved for card display");
        assert_eq!(real.template_id.as_deref(), Some("generic-v1"));
        assert!(real.template_name.is_some());

        // The ghost has no readable workflow — template stays None and the
        // serialized row simply omits the fields.
        assert!(rows[0].template_id.is_none());
    }

    #[test]
    fn remove_drops_entry_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("registry.json");
        record_workspace(&reg, r"C:\ws\alpha", "Alpha", "coding").unwrap();
        record_workspace(&reg, r"C:\ws\beta", "Beta", "research").unwrap();

        // Different casing/separators still hit the same entry.
        remove_workspace(&reg, "c:/WS/Alpha").unwrap();
        let registry = load_registry(&reg).unwrap();
        assert_eq!(registry.workspaces.len(), 1);
        assert_eq!(registry.workspaces[0].name, "Beta");

        // Removing something absent is a quiet no-op.
        remove_workspace(&reg, r"C:\nope").unwrap();
        assert_eq!(load_registry(&reg).unwrap().workspaces.len(), 1);
    }

    #[test]
    fn missing_registry_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_registry(&dir.path().join("nope.json")).unwrap().workspaces.is_empty());
        assert!(overview(&dir.path().join("nope.json")).unwrap().is_empty());
    }
}
