use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::security::keystore::KeyProvider;
use crate::security::secrets::{save_secrets, SecretMap};
use crate::workspace::atomic::atomic_write;
use crate::workspace::context::{save_context, ProjectContext};
use crate::workspace::handoff::generate_handoff;
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::ledger::{ledger_for, LedgerEvent, LedgerKind};
use crate::workspace::rules::{save_rules, ProjectRules};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitProjectParams {
    pub root: String,
    pub name: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub goals: Vec<String>,
    #[serde(default)]
    pub boundaries: Vec<String>,
    /// Workflow harness template to instantiate (defaults to `generic-v1`).
    #[serde(default)]
    pub template_id: Option<String>,
    /// UI language tag ("zh-TW"/"en") selecting which language of the
    /// built-in template content gets instantiated (D54). Only an explicit
    /// zh tag selects zh-TW — absent and unknown fall back to English, the
    /// language of the shipped workspace material (D104); custom templates
    /// ignore this.
    #[serde(default)]
    pub template_lang: Option<String>,
    /// Capability modules to enable from day one (wizard checkboxes, D31).
    /// Unknown ids abort before anything touches the disk.
    #[serde(default)]
    pub modules: Vec<String>,
    /// New-workspace flow (D44): the root itself must not exist yet and is
    /// created here (atomically — `fs::create_dir` fails on collision, so
    /// there is no check-then-create race). Adoption and in-place callers
    /// leave this off and initialize inside an existing folder.
    #[serde(default)]
    pub create_root: bool,
}

/// Create the full Agent NextUp structure inside `params.root`:
/// `.nextup/{context.json, rules.json, secrets.enc, ledger.jsonl, snapshots/latest_handoff.md}`,
/// `tasks/` and `artifacts/`. Fails if the directory is already initialized —
/// re-initialization would silently discard project history. With
/// `create_root` set, the root itself is created here and a pre-existing
/// folder of the same name is refused outright (D44).
pub fn initialize_project(
    params: &InitProjectParams,
    keys: &dyn KeyProvider,
    app_version: &str,
) -> Result<ProjectContext> {
    let name = params.name.trim();
    if name.is_empty() {
        return Err(NextUpError::InvalidInput("project name cannot be empty".into()));
    }
    let root = Path::new(params.root.trim());
    if params.root.trim().is_empty() {
        return Err(NextUpError::InvalidInput("project root path cannot be empty".into()));
    }

    // Resolve the harness template *before* touching the disk so an unknown
    // template id cannot leave a half-initialized workspace behind.
    let template = crate::workspace::templates::resolve_template(
        params.template_id.as_deref(),
        crate::workspace::templates::default_custom_dir().as_deref(),
        crate::workspace::templates::TemplateLang::from_tag(params.template_lang.as_deref()),
    )?;
    // Same fail-early contract for module ids.
    for module in &params.modules {
        crate::workspace::modules::validate_module(module)?;
    }

    let paths = WorkspacePaths::new(root);
    if paths.nextup_dir().exists() {
        return Err(NextUpError::Workspace(format!(
            "{} is already an Agent NextUp workspace (.nextup exists)",
            root.display()
        )));
    }
    if params.create_root {
        std::fs::create_dir(root).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                NextUpError::Workspace(format!(
                    "{} already exists — choose another name or location, or open/adopt it instead",
                    root.display()
                ))
            } else {
                NextUpError::from(e)
            }
        })?;
    }

    std::fs::create_dir_all(paths.snapshots_dir())?;
    std::fs::create_dir_all(paths.tasks_dir())?;
    std::fs::create_dir_all(paths.artifacts_dir())?;
    // Keep the (initially empty) directories versionable in git.
    atomic_write(&paths.tasks_dir().join(".gitkeep"), b"")?;
    atomic_write(&paths.artifacts_dir().join(".gitkeep"), b"")?;
    // Keep machine-local and rebuildable derivatives out of version control:
    // secrets.enc is sealed by this machine's master key (committing it only
    // spreads noise), index.sqlite is a rebuildable FTS5 derivative, and
    // .mutex is a transient advisory lock.
    atomic_write(
        &paths.nextup_dir().join(".gitignore"),
        b"secrets.enc\nindex.sqlite\n.mutex\n",
    )?;

    let domain = if params.domain.trim().is_empty() { "general" } else { params.domain.trim() };
    let context = ProjectContext::new(
        name,
        domain,
        params.description.trim(),
        clean_lines(&params.goals),
        clean_lines(&params.boundaries),
    );
    save_context(&paths.context_file(), &context)?;
    save_rules(&paths.rules_file(), &ProjectRules::default_rules())?;
    save_secrets(&paths.secrets_file(), keys, &SecretMap::new())?;

    let workflow = crate::workspace::workflow::instantiate(&template)?;
    crate::workspace::workflow::save_workflow(&paths.workflow_file(), &workflow)?;

    // Capability modules: only written when something is enabled — a missing
    // modules.json already means "none" (workspace::modules default). The
    // specs module scaffolds its `specs/` dir inside set_module_enabled, so
    // the wizard and the brownfield settings toggle share one path (D79).
    for module in &params.modules {
        crate::workspace::modules::set_module_enabled(&paths, module, true)?;
    }

    // Day-one agent grant (D63). Someone installing Agent NextUp wants an agent on
    // the project, so the recording and flow tools start allowed and the
    // first hub call succeeds instead of being denied. The guarded five stay
    // off — self-verification, phase advancement, cross-workspace publishing
    // and asset rewrites are the judgement calls the harness keeps human.
    // Must run *after* the module loop: the grant is filtered by what this
    // workspace exposes, and a module enabled above changes that set.
    let modules = crate::workspace::modules::get_modules(&paths)?;
    let granted: Vec<String> =
        crate::agent::default_granted_tools(&modules).iter().map(|t| t.to_string()).collect();
    if !granted.is_empty() {
        crate::agent::set_tools_allowed(&paths, &granted, true)?;
    }

    // AI-session bootstrap layer: CLAUDE.md / AGENTS.md entry points, the
    // operating guide, memory index, aggregation manifest and work-record
    // scaffold — so any coding agent opening this folder takes over directly.
    crate::workspace::bootstrap::scaffold(&paths, &context)?;

    ledger_for(&paths).append(&LedgerEvent::new(
        LedgerKind::ProjectInitialized,
        format!(
            "project \"{name}\" initialized (domain: {domain}, workflow: {})",
            template.name
        ),
        None,
    ))?;

    generate_handoff(&paths, app_version)?;
    Ok(context)
}

/// Open an existing workspace: validate the structure and return its context.
/// Pure read — every channel (GUI open, the hub's workspace_status) uses this
/// and it must never write: opening is reading, not a project change, so it
/// leaves no ledger line (D41 — the old WorkspaceOpened audit line only
/// crowded real activity out of the feeds).
pub fn open_workspace(root: &Path) -> Result<ProjectContext> {
    let paths = WorkspacePaths::new(root);
    if !paths.is_initialized() {
        return Err(NextUpError::NotFound(format!(
            "{} is not an Agent NextUp workspace (missing .nextup/context.json)",
            root.display()
        )));
    }
    crate::workspace::context::load_context(&paths.context_file())
}

fn clean_lines(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::security::secrets::load_secrets;

    fn params(root: &Path) -> InitProjectParams {
        InitProjectParams {
            root: root.to_string_lossy().into_owned(),
            name: "demo".into(),
            domain: "research".into(),
            description: "a research workspace".into(),
            goals: vec!["publish survey".into(), "  ".into()],
            boundaries: vec!["no paid APIs".into()],
            template_id: None,
            template_lang: None,
            modules: vec![],
            create_root: false,
        }
    }

    #[test]
    fn init_enables_requested_modules() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = params(dir.path());
        p.modules = vec![crate::workspace::modules::MODULE_COLLAB.into()];
        initialize_project(&p, &StaticKeyProvider([1u8; 32]), "0.1.0").unwrap();

        let paths = WorkspacePaths::new(dir.path());
        let modules = crate::workspace::modules::get_modules(&paths).unwrap();
        assert!(modules.is_enabled(crate::workspace::modules::MODULE_COLLAB));
    }

    /// D79: choosing the specs module scaffolds `specs/` up front — without
    /// it, nothing on disk says where the curated truth will live.
    #[test]
    fn init_scaffolds_specs_dir_only_when_module_chosen() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = params(dir.path());
        p.modules = vec![crate::workspace::modules::MODULE_SPECS.into()];
        initialize_project(&p, &StaticKeyProvider([1u8; 32]), "0.1.0").unwrap();
        assert!(WorkspacePaths::new(dir.path()).specs_dir().is_dir());

        let plain = tempfile::tempdir().unwrap();
        initialize_project(&params(plain.path()), &StaticKeyProvider([1u8; 32]), "0.1.0").unwrap();
        assert!(!WorkspacePaths::new(plain.path()).specs_dir().exists());
    }

    /// D63: a new workspace is usable by an agent immediately — the recording
    /// and flow tools are granted — while the five judgement-call tools stay
    /// off until the user says otherwise.
    #[test]
    fn init_grants_the_day_one_tools_and_withholds_the_guarded_ones() {
        let dir = tempfile::tempdir().unwrap();
        initialize_project(&params(dir.path()), &StaticKeyProvider([1u8; 32]), "0.1.0").unwrap();

        let paths = WorkspacePaths::new(dir.path());
        let access = crate::agent::get_access(&paths).unwrap();
        assert!(access.enabled);
        assert!(crate::agent::authorize(&access, "create_task").is_ok());
        assert!(crate::agent::authorize(&access, "record_decision").is_ok());
        for guarded in crate::agent::GUARDED_TOOLS.iter() {
            assert_eq!(
                crate::agent::authorize(&access, guarded).unwrap_err().kind(),
                "unauthorized",
                "guarded tool '{guarded}' must not be granted at init"
            );
        }
        // collab is off in the default params, so its tools stay out of the
        // allowlist entirely rather than sitting there unreachable.
        assert!(!access.tool_allowed("claim_task"));
    }

    /// The grant is filtered by the modules this init enabled, not by the
    /// registry — ordering bug insurance: written before the module loop, the
    /// collab tools would be missing (or `set_tools_allowed` would refuse).
    #[test]
    fn day_one_grant_covers_tools_from_modules_enabled_at_init() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = params(dir.path());
        p.modules = vec![crate::workspace::modules::MODULE_COLLAB.into()];
        initialize_project(&p, &StaticKeyProvider([1u8; 32]), "0.1.0").unwrap();

        let paths = WorkspacePaths::new(dir.path());
        let access = crate::agent::get_access(&paths).unwrap();
        assert!(crate::agent::authorize(&access, "claim_task").is_ok());
        assert!(crate::agent::authorize(&access, "assign_task").is_ok());
    }

    #[test]
    fn init_refuses_unknown_module_before_touching_disk() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = params(dir.path());
        p.modules = vec!["warp-drive".into()];
        let err = initialize_project(&p, &StaticKeyProvider([1u8; 32]), "0.1.0").unwrap_err();
        assert_eq!(err.kind(), "not_found");
        assert!(
            !dir.path().join(".nextup").exists(),
            "a refused init must not leave a half-initialized workspace"
        );
    }

    #[test]
    fn creates_complete_structure() {
        let dir = tempfile::tempdir().unwrap();
        let kp = StaticKeyProvider([1u8; 32]);
        let ctx = initialize_project(&params(dir.path()), &kp, "0.1.0").unwrap();

        let paths = WorkspacePaths::new(dir.path());
        assert!(paths.context_file().is_file());
        assert!(paths.rules_file().is_file());
        assert!(paths.workflow_file().is_file());
        assert!(paths.secrets_file().is_file());
        assert!(paths.ledger_file().is_file());
        assert!(paths.handoff_file().is_file());
        assert!(paths.tasks_dir().is_dir());
        assert!(paths.artifacts_dir().is_dir());
        // No modules requested → no modules.json (missing file = none enabled).
        assert!(!paths.modules_file().exists());

        // The harness starts at the first phase of the default template.
        let workflow =
            crate::workspace::workflow::load_workflow(&paths.workflow_file()).unwrap();
        assert_eq!(workflow.template_id, "generic-v1");
        assert_eq!(workflow.state.current_phase, "plan");

        assert_eq!(ctx.name, "demo");
        assert_eq!(ctx.goals, vec!["publish survey".to_string()], "blank goal lines dropped");

        // Secrets store decrypts to an empty map with the same provider.
        assert!(load_secrets(&paths.secrets_file(), &kp).unwrap().is_empty());

        // Initial handoff carries the four mandatory sections.
        let handoff = std::fs::read_to_string(paths.handoff_file()).unwrap();
        assert!(handoff.contains("## 4. Current Blockers / Technical Decisions"));
    }

    #[test]
    fn create_root_builds_the_folder_and_initializes() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("brand-new");
        let mut p = params(&target);
        p.create_root = true;
        initialize_project(&p, &StaticKeyProvider([1u8; 32]), "0.1.0").unwrap();
        assert!(WorkspacePaths::new(&target).is_initialized());
    }

    #[test]
    fn create_root_refuses_existing_folder_even_when_empty() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("taken");
        std::fs::create_dir(&target).unwrap();
        let mut p = params(&target);
        p.create_root = true;
        let err = initialize_project(&p, &StaticKeyProvider([1u8; 32]), "0.1.0").unwrap_err();
        assert_eq!(err.kind(), "workspace");
        assert!(
            !target.join(".nextup").exists(),
            "a refused init must not touch the pre-existing folder"
        );
    }

    #[test]
    fn double_initialization_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let kp = StaticKeyProvider([1u8; 32]);
        initialize_project(&params(dir.path()), &kp, "0.1.0").unwrap();
        let err = initialize_project(&params(dir.path()), &kp, "0.1.0").unwrap_err();
        assert_eq!(err.kind(), "workspace");
    }

    #[test]
    fn open_requires_initialized_workspace() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(open_workspace(dir.path()).unwrap_err().kind(), "not_found");

        let kp = StaticKeyProvider([1u8; 32]);
        initialize_project(&params(dir.path()), &kp, "0.1.0").unwrap();
        assert_eq!(open_workspace(dir.path()).unwrap().name, "demo");
    }

    #[test]
    fn blank_name_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = params(dir.path());
        p.name = "   ".into();
        let err = initialize_project(&p, &StaticKeyProvider([1u8; 32]), "0.1.0").unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }

    #[test]
    fn unknown_template_fails_before_any_disk_writes() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = params(dir.path());
        p.template_id = Some("no-such-template".into());
        let err = initialize_project(&p, &StaticKeyProvider([1u8; 32]), "0.1.0").unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(
            !WorkspacePaths::new(dir.path()).nextup_dir().exists(),
            "a bad template id must not leave a half-initialized workspace"
        );
    }

    #[test]
    fn chosen_template_is_instantiated() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = params(dir.path());
        p.template_id = Some("research-v1".into());
        initialize_project(&p, &StaticKeyProvider([1u8; 32]), "0.1.0").unwrap();
        let paths = WorkspacePaths::new(dir.path());
        let workflow =
            crate::workspace::workflow::load_workflow(&paths.workflow_file()).unwrap();
        assert_eq!(workflow.template_id, "research-v1");
        assert_eq!(workflow.state.current_phase, "scope");
        // The initial handoff already carries the harness position.
        let handoff = std::fs::read_to_string(paths.handoff_file()).unwrap();
        assert!(handoff.contains("**Workflow phase:**"));
    }
}
