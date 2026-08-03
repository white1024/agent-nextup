//! Workspace capability modules (D31): built-in capability packs a workspace
//! opts into. `.nextup/modules.json` records which are enabled; a missing file
//! means "none enabled", so pre-module workspaces need no migration.
//!
//! A module only gates *exposure* — GUI surfaces, wizard offers, module-bound
//! tools. Data schemas stay universal (e.g. `Task::assignee` always exists),
//! so enabling later is free and disabling never orphans data. There is no
//! plugin framework here on purpose: modules are compiled in, this file is
//! just the per-workspace switchboard.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::workspace::atomic::atomic_write_json;
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::lock::with_mutation_lock;

pub const MODULES_SCHEMA_VERSION: u32 = 1;

/// Collaboration module: assignee kanban, claim/assign hub tools, per-agent
/// activity feed (nextup_docs/07).
pub const MODULE_COLLAB: &str = "collab";

/// Team module (D48): cross-workspace delivery — publish/read exchange hub
/// tools and the workspace inbox surface. The team graph itself is app-level
/// (`~/.nextup/teams.json`) and needs no workspace switch; this module only
/// gates the workspace-side exposure (nextup_docs/09).
pub const MODULE_TEAM: &str = "team";

/// Spec layer module (D79): the curated `specs/` truth, per-task artifact
/// bundles and fold-on-archive. Fields and fold bookkeeping stay universal
/// (the D31 rule); this id gates the read tools, the GUI view and the
/// scaffolded `specs/` directory (nextup_docs/15).
pub const MODULE_SPECS: &str = "specs";

/// Every module this build knows about. Enabling an unknown id is refused so
/// a typo cannot pretend to enable a capability that does not exist.
pub const KNOWN_MODULES: [&str; 3] = [MODULE_COLLAB, MODULE_SPECS, MODULE_TEAM];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceModules {
    pub schema_version: u32,
    /// Enabled module ids, kept sorted for stable file diffs.
    #[serde(default)]
    pub enabled: Vec<String>,
}

impl Default for WorkspaceModules {
    /// A missing file means this default: nothing enabled. Existing
    /// workspaces therefore need no migration (same contract as
    /// `agent_access.json`).
    fn default() -> Self {
        Self { schema_version: MODULES_SCHEMA_VERSION, enabled: Vec::new() }
    }
}

impl WorkspaceModules {
    pub fn is_enabled(&self, module: &str) -> bool {
        self.enabled.iter().any(|m| m == module)
    }
}

pub fn load_modules(path: &Path) -> Result<WorkspaceModules> {
    if !path.is_file() {
        return Ok(WorkspaceModules::default());
    }
    crate::workspace::atomic::read_json_file(path)
}

pub fn get_modules(paths: &WorkspacePaths) -> Result<WorkspaceModules> {
    load_modules(&paths.modules_file())
}

/// Refuse unknown module ids (single validation point for init and toggles).
pub fn validate_module(module: &str) -> Result<()> {
    if KNOWN_MODULES.contains(&module) {
        return Ok(());
    }
    Err(NextUpError::NotFound(format!(
        "unknown module '{module}' (known: {})",
        KNOWN_MODULES.join(", ")
    )))
}

/// Convenience guard for module-bound operations: error out with a pointer to
/// the switch when the module is off. Callers that merely *store* universal
/// fields must not use this — only capabilities the module itself contributes.
pub fn require_module(paths: &WorkspacePaths, module: &str) -> Result<()> {
    if get_modules(paths)?.is_enabled(module) {
        return Ok(());
    }
    Err(NextUpError::InvalidInput(format!(
        "the '{module}' module is not enabled for this workspace — enable it in Agent NextUp first"
    )))
}

/// Toggle one module (wizard checkbox, settings switch). Disabling never
/// touches data — fields stay universal (D31), so a later re-enable loses
/// nothing.
pub fn set_module_enabled(
    paths: &WorkspacePaths,
    module: &str,
    enabled: bool,
) -> Result<WorkspaceModules> {
    validate_module(module)?;
    with_mutation_lock(paths, || set_module_enabled_locked(paths, module, enabled))
}

/// Toggle plus takeover-surface sync in one lock scope. The GUI settings
/// switch uses this so module-gated STATE lines (the specs count row) appear
/// or vanish immediately instead of waiting for the next unrelated mutation
/// (design doc 15, landing deviation 4). Init keeps the plain variant — it toggles before the
/// takeover layer exists and runs its own scaffold pass.
pub fn set_module_enabled_synced(
    paths: &WorkspacePaths,
    module: &str,
    enabled: bool,
    app_version: &str,
) -> Result<WorkspaceModules> {
    validate_module(module)?;
    with_mutation_lock(paths, || {
        let modules = set_module_enabled_locked(paths, module, enabled)?;
        crate::workspace::sync::sync_after_mutation(paths, app_version)?;
        Ok(modules)
    })
}

fn set_module_enabled_locked(
    paths: &WorkspacePaths,
    module: &str,
    enabled: bool,
) -> Result<WorkspaceModules> {
    let mut modules = load_modules(&paths.modules_file())?;
    modules.enabled.retain(|m| m != module);
    if enabled {
        modules.enabled.push(module.to_string());
        modules.enabled.sort();
    }
    atomic_write_json(&paths.modules_file(), &modules)?;
    // The specs module scaffolds its directory on enable (D79) — init
    // and the brownfield settings toggle both land here, so an empty
    // specs/ always marks where the curated truth will live. Disable
    // never touches data (the rule above).
    if enabled && module == MODULE_SPECS {
        std::fs::create_dir_all(paths.specs_dir())?;
    }
    // Same shape for the module's guide (D82): enabling ships it, disabling
    // leaves it on disk. Skipped before the workspace has a context (module
    // toggles during init run after save_context, but bare-paths callers and
    // tests do not) — `scaffold` ships whatever is enabled anyway, so the
    // file cannot go missing, it can only arrive a moment later.
    if enabled && paths.context_file().is_file() {
        let ctx = crate::workspace::context::load_context(&paths.context_file())?;
        if let Some(content) = crate::workspace::bootstrap::render_module_guide(module, &ctx) {
            let path = paths.module_guide_file(module);
            if !path.exists() {
                crate::workspace::atomic::atomic_write(&path, content.as_bytes())?;
            }
        }
    }
    Ok(modules)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> (tempfile::TempDir, WorkspacePaths) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".nextup")).unwrap();
        let paths = WorkspacePaths::new(dir.path());
        (dir, paths)
    }

    /// D79 batch 4 review, E1: the synced toggle must refresh the takeover surface in
    /// the same lock scope — the specs STATE line appears on enable and
    /// vanishes on disable without waiting for another mutation.
    #[test]
    fn synced_toggle_refreshes_state_line() {
        use crate::security::keystore::StaticKeyProvider;
        use crate::workspace::init::{initialize_project, InitProjectParams};
        let dir = tempfile::tempdir().unwrap();
        let params = InitProjectParams {
            root: dir.path().to_string_lossy().into_owned(),
            name: "modules-sync-test".into(),
            domain: "coding".into(),
            description: String::new(),
            goals: vec![],
            boundaries: vec![],
            ..Default::default()
        };
        initialize_project(&params, &StaticKeyProvider([7u8; 32]), "0.1.0").unwrap();
        let paths = WorkspacePaths::new(dir.path());

        set_module_enabled_synced(&paths, MODULE_SPECS, true, "0.1.0").unwrap();
        let md = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(md.contains("Spec layer"), "STATE must gain the specs line right after enable");

        set_module_enabled_synced(&paths, MODULE_SPECS, false, "0.1.0").unwrap();
        let md = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(!md.contains("Spec layer"), "STATE must drop the specs line right after disable");
    }

    /// D82: the guide follows the same "enable ships it, disable keeps it"
    /// shape as `specs/`, and the STATE line follows the switch both ways.
    /// The asymmetry is deliberate — deleting on disable would delete a file
    /// the user may have edited.
    #[test]
    fn enabling_a_module_ships_its_guide_and_disabling_keeps_the_file() {
        use crate::security::keystore::StaticKeyProvider;
        use crate::workspace::init::{initialize_project, InitProjectParams};
        let dir = tempfile::tempdir().unwrap();
        initialize_project(
            &InitProjectParams {
                root: dir.path().to_string_lossy().into_owned(),
                name: "module-guide-toggle".into(),
                domain: "coding".into(),
                description: String::new(),
                goals: vec![],
                boundaries: vec![],
                ..Default::default()
            },
            &StaticKeyProvider([7u8; 32]),
            "0.1.0",
        )
        .unwrap();
        let paths = WorkspacePaths::new(dir.path());
        let guide = paths.module_guide_file(MODULE_TEAM);
        assert!(!guide.exists(), "nothing enabled, nothing shipped");

        set_module_enabled_synced(&paths, MODULE_TEAM, true, "0.1.0").unwrap();
        assert!(guide.is_file(), "enable ships the module guide");
        let md = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(md.contains("modules/team.md"), "STATE names the guide right after enable");

        // A user edit must survive the round trip untouched.
        std::fs::write(&guide, "my own notes\n").unwrap();
        set_module_enabled_synced(&paths, MODULE_TEAM, false, "0.1.0").unwrap();
        assert!(guide.is_file(), "disable never deletes the file");
        let md = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(!md.contains("modules/team.md"), "STATE drops the guide right after disable");

        set_module_enabled_synced(&paths, MODULE_TEAM, true, "0.1.0").unwrap();
        assert_eq!(
            std::fs::read_to_string(&guide).unwrap(),
            "my own notes\n",
            "re-enable must not overwrite what the user wrote"
        );
    }

    /// A corrupt modules.json must fail loudly. Degrading to "nothing enabled"
    /// would silently drop live module guides out of the curriculum, so the
    /// engine would stop upgrading contracts the workspace is actually using.
    #[test]
    fn corrupt_modules_json_is_an_error_not_an_empty_default() {
        let (_g, paths) = paths();
        std::fs::write(paths.modules_file(), b"{ not json").unwrap();
        assert!(get_modules(&paths).is_err(), "corrupt modules.json must not read as 'none enabled'");
    }

    /// D79: enable scaffolds `specs/` (the wizard and the brownfield
    /// settings toggle share this path); disable never touches data.
    #[test]
    fn enabling_specs_scaffolds_the_directory_and_disable_keeps_it() {
        let (_g, paths) = paths();
        set_module_enabled(&paths, MODULE_SPECS, true).unwrap();
        assert!(paths.specs_dir().is_dir());
        set_module_enabled(&paths, MODULE_SPECS, false).unwrap();
        assert!(paths.specs_dir().is_dir(), "disable never touches data");
    }

    #[test]
    fn missing_file_means_nothing_enabled() {
        let (_g, paths) = paths();
        let modules = get_modules(&paths).unwrap();
        assert_eq!(modules, WorkspaceModules::default());
        assert!(!modules.is_enabled(MODULE_COLLAB));
    }

    #[test]
    fn toggle_roundtrip_and_idempotence() {
        let (_g, paths) = paths();
        let m = set_module_enabled(&paths, MODULE_COLLAB, true).unwrap();
        assert!(m.is_enabled(MODULE_COLLAB));
        // Enabling twice keeps a single entry.
        let m = set_module_enabled(&paths, MODULE_COLLAB, true).unwrap();
        assert_eq!(m.enabled, vec![MODULE_COLLAB.to_string()]);
        // Reload from disk agrees.
        assert!(get_modules(&paths).unwrap().is_enabled(MODULE_COLLAB));

        let m = set_module_enabled(&paths, MODULE_COLLAB, false).unwrap();
        assert!(m.enabled.is_empty());
    }

    #[test]
    fn unknown_module_is_refused() {
        let (_g, paths) = paths();
        assert_eq!(set_module_enabled(&paths, "warp-drive", true).unwrap_err().kind(), "not_found");
        assert!(!paths.modules_file().exists(), "a refused toggle must not create the file");
    }

    #[test]
    fn require_module_names_the_switch() {
        let (_g, paths) = paths();
        let err = require_module(&paths, MODULE_COLLAB).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("collab"));

        set_module_enabled(&paths, MODULE_COLLAB, true).unwrap();
        require_module(&paths, MODULE_COLLAB).unwrap();
    }
}
