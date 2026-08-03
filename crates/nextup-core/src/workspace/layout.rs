use std::path::{Path, PathBuf};

/// Canonical on-disk layout of an Agent NextUp workspace. All path knowledge lives
/// here so no other module hardcodes file names.
///
/// ```text
/// <root>/
///   .nextup/
///     context.json               project metadata, goals, boundaries
///     rules.json                 tailored execution guidelines for AI
///     workflow.json              execution harness: phases, gates, state
///     orchestrator.json          LLM model registry + routing policy
///     mcp.json                   MCP tool-server registry + allowlists
///     index.sqlite               FTS5 full-text index (rebuildable derivative;
///                                never backed up — files are the truth)
///     secrets.enc                encrypted API keys / tokens
///     ledger.jsonl               append-only event stream
///     shipped_assets.json        fingerprints of engine-shipped curriculum
///     asset_backups/             pre-upgrade copies (machine-local, gitignored)
///     exchange/                  cross-workspace delivery envelopes (D48)
///       outbox/                  published here, awaiting app-layer routing
///       inbox/                   deliveries routed in from team upstreams
///     snapshots/
///       latest_handoff.md        bootstrapper for new AI sessions
///   tasks/                       one JSON file per atomic task
///     T-0001/                    optional per-task artifact bundle (D79):
///       proposal.md / design.md    freeform prose (engine never parses)
///       specs/<cap>/spec.md        delta specs folded on archive
///   specs/                       curated current-state spec layer (D79);
///     <capability>/spec.md         workspace content, not engine data
///   artifacts/                   output delivery directory
///   .claude/skills/              generic process skills shipped at init
/// ```
#[derive(Debug, Clone)]
pub struct WorkspacePaths {
    root: PathBuf,
}

pub const NEXTUP_DIR: &str = ".nextup";
pub const CONTEXT_FILE: &str = "context.json";
pub const RULES_FILE: &str = "rules.json";
pub const WORKFLOW_FILE: &str = "workflow.json";
pub const ORCHESTRATOR_FILE: &str = "orchestrator.json";
pub const MCP_FILE: &str = "mcp.json";
pub const INDEX_FILE: &str = "index.sqlite";
pub const SECRETS_FILE: &str = "secrets.enc";
pub const LEDGER_FILE: &str = "ledger.jsonl";
pub const MUTEX_FILE: &str = ".mutex";
pub const AGENT_ACCESS_FILE: &str = "agent_access.json";
pub const MODULES_FILE: &str = "modules.json";
pub const SETTINGS_FILE: &str = "settings.json";
pub const SHIPPED_ASSETS_FILE: &str = "shipped_assets.json";
pub const ASSET_BACKUPS_DIR: &str = "asset_backups";
pub const EXCHANGE_DIR: &str = "exchange";
pub const OUTBOX_DIR: &str = "outbox";
pub const INBOX_DIR: &str = "inbox";
pub const SNAPSHOTS_DIR: &str = "snapshots";
pub const HANDOFF_FILE: &str = "latest_handoff.md";
pub const TASKS_DIR: &str = "tasks";
pub const ARTIFACTS_DIR: &str = "artifacts";
pub const SPECS_DIR: &str = "specs";
pub const SPEC_FILE: &str = "spec.md";

// AI-session bootstrap layer (root-level, auto-loaded by coding agents).
/// Claude Code's entry point. Since D82 this is a **shell** that imports
/// [`AGENTS_MD`]; the body and the engine's state block live there.
pub const CLAUDE_MD: &str = "CLAUDE.md";
/// Agent-host config dir (Claude Code convention); Agent NextUp only owns the
/// `skills/` subtree it scaffolds — everything else in `.claude/` is the
/// host's (settings, local state) and must never be touched.
pub const CLAUDE_CONFIG_DIR: &str = ".claude";
/// Host-neutral agent config dir (D82). This is where the shipped skills are
/// **canonical**; `.claude/skills/` gets a byte-identical copy because Claude
/// Code only discovers skills under its own directory. Two real files, not a
/// symlink: symlinks need admin or developer mode on Windows, and field
/// testing found the mechanism had already broken two reference repos on this
/// machine. `doctor::check_skill_mirrors` guards the pair against drift.
pub const AGENT_CONFIG_DIR: &str = ".agents";
pub const SKILLS_SUBDIR: &str = "skills";
pub const SKILL_FILE: &str = "SKILL.md";
/// Project-level MCP discovery file: agent hosts (Claude Code etc.) read it
/// on entry and auto-spawn the nextup-mcp hub server (nextup_docs/06 §4).
pub const MCP_DISCOVERY_FILE: &str = ".mcp.json";
pub const AGENTS_MD: &str = "AGENTS.md";
pub const MANIFEST_FILE: &str = "project.yaml";
pub const NEXTUP_DOCS_DIR: &str = "nextup_docs";
pub const NEXTUP_GUIDE_FILE: &str = "01-nextup-guide.md";
/// The session operating protocol (D82): split out of the guide because it is
/// the one piece read on **every** takeover, while the rest of the guide is
/// reference material read on demand.
pub const PROTOCOL_FILE: &str = "00-protocol.md";
/// Per-module guides (D82): one file per **enabled** module, so a workspace
/// never carries the contract for a capability it does not have. The directory
/// listing is therefore the answer to "which modules apply here" — it agrees
/// with the hub's module-filtered tool list by construction.
pub const MODULE_GUIDES_SUBDIR: &str = "modules";
pub const MEMORY_DIR: &str = "memory";
pub const MEMORY_INDEX_FILE: &str = "MEMORY.md";
pub const WORK_RECORD_DIR: &str = "work_record";

impl WorkspacePaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn nextup_dir(&self) -> PathBuf {
        self.root.join(NEXTUP_DIR)
    }

    pub fn context_file(&self) -> PathBuf {
        self.nextup_dir().join(CONTEXT_FILE)
    }

    pub fn rules_file(&self) -> PathBuf {
        self.nextup_dir().join(RULES_FILE)
    }

    pub fn workflow_file(&self) -> PathBuf {
        self.nextup_dir().join(WORKFLOW_FILE)
    }

    pub fn orchestrator_file(&self) -> PathBuf {
        self.nextup_dir().join(ORCHESTRATOR_FILE)
    }

    pub fn mcp_file(&self) -> PathBuf {
        self.nextup_dir().join(MCP_FILE)
    }

    pub fn index_file(&self) -> PathBuf {
        self.nextup_dir().join(INDEX_FILE)
    }

    pub fn secrets_file(&self) -> PathBuf {
        self.nextup_dir().join(SECRETS_FILE)
    }

    pub fn ledger_file(&self) -> PathBuf {
        self.nextup_dir().join(LEDGER_FILE)
    }

    /// Cross-process mutation lock (advisory, empty; see workspace::lock).
    pub fn mutex_file(&self) -> PathBuf {
        self.nextup_dir().join(MUTEX_FILE)
    }

    /// Hub-tool authorization registry for external agents (see crate::agent).
    pub fn agent_access_file(&self) -> PathBuf {
        self.nextup_dir().join(AGENT_ACCESS_FILE)
    }

    /// Enabled capability modules (see workspace::modules, D31).
    pub fn modules_file(&self) -> PathBuf {
        self.nextup_dir().join(MODULES_FILE)
    }

    /// Workspace behavior settings (see workspace::settings, D78).
    pub fn settings_file(&self) -> PathBuf {
        self.nextup_dir().join(SETTINGS_FILE)
    }

    /// Fingerprints of engine-shipped curriculum assets (workspace::assets, D38).
    pub fn shipped_assets_file(&self) -> PathBuf {
        self.nextup_dir().join(SHIPPED_ASSETS_FILE)
    }

    /// Pre-overwrite backups taken by asset upgrades. Machine-local safety
    /// net: self-gitignored, not exported in backups, not watched.
    pub fn asset_backups_dir(&self) -> PathBuf {
        self.nextup_dir().join(ASSET_BACKUPS_DIR)
    }

    /// Cross-workspace delivery envelopes (workspace::exchange, D48).
    pub fn exchange_dir(&self) -> PathBuf {
        self.nextup_dir().join(EXCHANGE_DIR)
    }

    /// Envelopes published by this workspace, awaiting app-layer routing.
    pub fn outbox_dir(&self) -> PathBuf {
        self.exchange_dir().join(OUTBOX_DIR)
    }

    /// Envelopes routed in from team upstreams.
    pub fn inbox_dir(&self) -> PathBuf {
        self.exchange_dir().join(INBOX_DIR)
    }

    pub fn snapshots_dir(&self) -> PathBuf {
        self.nextup_dir().join(SNAPSHOTS_DIR)
    }

    pub fn handoff_file(&self) -> PathBuf {
        self.snapshots_dir().join(HANDOFF_FILE)
    }

    pub fn tasks_dir(&self) -> PathBuf {
        self.root.join(TASKS_DIR)
    }

    pub fn artifacts_dir(&self) -> PathBuf {
        self.root.join(ARTIFACTS_DIR)
    }

    /// `<root>/specs/` — the curated current-state spec layer (D79).
    /// Workspace content, not engine data: human-readable, git-friendly,
    /// and inside index scope (unlike `.nextup/`).
    pub fn specs_dir(&self) -> PathBuf {
        self.root.join(SPECS_DIR)
    }

    /// `specs/<capability>/spec.md` — one capability, one file.
    pub fn spec_file(&self, capability: &str) -> PathBuf {
        self.specs_dir().join(capability).join(SPEC_FILE)
    }

    /// `tasks/<task-id>/` — optional per-task artifact bundle (D79):
    /// proposal.md, design.md, delta specs. Sibling of the task's JSON file.
    pub fn task_artifact_dir(&self, task_id: &str) -> PathBuf {
        self.tasks_dir().join(task_id)
    }

    /// `tasks/<task-id>/specs/` — delta specs the engine folds on archive.
    pub fn task_delta_specs_dir(&self, task_id: &str) -> PathBuf {
        self.task_artifact_dir(task_id).join(SPECS_DIR)
    }

    pub fn claude_md_file(&self) -> PathBuf {
        self.root.join(CLAUDE_MD)
    }

    /// `.claude/skills/` — the Claude Code mirror of the shipped skills (D30,
    /// mirrored since D82). Canonical copies live in [`Self::agent_skills_dir`].
    pub fn skills_dir(&self) -> PathBuf {
        self.root.join(CLAUDE_CONFIG_DIR).join(SKILLS_SUBDIR)
    }

    /// `.claude/skills/<name>/SKILL.md` for one shipped skill.
    pub fn skill_file(&self, name: &str) -> PathBuf {
        self.skills_dir().join(name).join(SKILL_FILE)
    }

    /// `.agents/skills/` — the canonical, host-neutral home of the shipped
    /// skills (D82).
    pub fn agent_skills_dir(&self) -> PathBuf {
        self.root.join(AGENT_CONFIG_DIR).join(SKILLS_SUBDIR)
    }

    /// `.agents/skills/<name>/SKILL.md` for one shipped skill.
    pub fn agent_skill_file(&self, name: &str) -> PathBuf {
        self.agent_skills_dir().join(name).join(SKILL_FILE)
    }

    /// Both landing spots for one shipped skill, canonical first (D82). The
    /// engine writes the same bytes to each; callers that ship or fingerprint
    /// skills must walk this rather than pick one, or the pair silently forks.
    pub fn skill_files(&self, name: &str) -> [(String, PathBuf); 2] {
        [
            (
                format!("{AGENT_CONFIG_DIR}/{SKILLS_SUBDIR}/{name}/{SKILL_FILE}"),
                self.agent_skill_file(name),
            ),
            (
                format!("{CLAUDE_CONFIG_DIR}/{SKILLS_SUBDIR}/{name}/{SKILL_FILE}"),
                self.skill_file(name),
            ),
        ]
    }

    pub fn mcp_discovery_file(&self) -> PathBuf {
        self.root.join(MCP_DISCOVERY_FILE)
    }

    pub fn agents_md_file(&self) -> PathBuf {
        self.root.join(AGENTS_MD)
    }

    pub fn manifest_file(&self) -> PathBuf {
        self.root.join(MANIFEST_FILE)
    }

    pub fn nextup_docs_dir(&self) -> PathBuf {
        self.root.join(NEXTUP_DOCS_DIR)
    }

    pub fn nextup_guide_file(&self) -> PathBuf {
        self.nextup_docs_dir().join(NEXTUP_GUIDE_FILE)
    }

    pub fn protocol_file(&self) -> PathBuf {
        self.nextup_docs_dir().join(PROTOCOL_FILE)
    }

    pub fn module_guides_dir(&self) -> PathBuf {
        self.nextup_docs_dir().join(MODULE_GUIDES_SUBDIR)
    }

    /// Guide file for one module id (`collab` -> `nextup_docs/modules/collab.md`).
    pub fn module_guide_file(&self, module: &str) -> PathBuf {
        self.module_guides_dir().join(format!("{module}.md"))
    }

    /// Workspace-relative path of a module guide, forward-slashed — the shape
    /// `shipped_assets.json` keys by (workspace::assets).
    pub fn module_guide_rel(module: &str) -> String {
        format!("{NEXTUP_DOCS_DIR}/{MODULE_GUIDES_SUBDIR}/{module}.md")
    }

    pub fn memory_dir(&self) -> PathBuf {
        self.root.join(MEMORY_DIR)
    }

    pub fn memory_index_file(&self) -> PathBuf {
        self.memory_dir().join(MEMORY_INDEX_FILE)
    }

    pub fn work_record_dir(&self) -> PathBuf {
        self.root.join(WORK_RECORD_DIR)
    }

    /// True if this root contains an initialized Agent NextUp workspace.
    pub fn is_initialized(&self) -> bool {
        self.context_file().is_file()
    }
}
