//! Thin IPC delivery layer. Every handler validates/loads state, then
//! delegates to `nextup-core` — filesystem-heavy work runs on the blocking
//! thread pool so the UI thread is never stalled (spec IPC constraint).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use nextup_core::agent;
use nextup_core::error::NextUpError;
use nextup_core::workspace::agent_catalog::{self, AgentInfo, CustomAgent};
use nextup_core::index::ops as index_ops;
use nextup_core::index::{AdoptionDraft, IndexInfo, IndexProgress, IndexSummary, SearchHit};
use nextup_core::security::secrets;
use nextup_core::state::{AppState, SystemStatus};
use nextup_core::workspace::assets::{self, AssetDecisions, AssetStatus, AssetsUpgradeOutcome};
use nextup_core::workspace::backup;
use nextup_core::workspace::bootstrap;
use nextup_core::workspace::context::ProjectContext;
use nextup_core::workspace::doctor::{self, DoctorReport};
use nextup_core::workspace::exchange::{self, DeliveryEnvelope, DeliverySummary, RouteOutcome};
use nextup_core::workspace::handoff;
use nextup_core::workspace::init::{self, InitProjectParams};
use nextup_core::workspace::layout::WorkspacePaths;
use nextup_core::workspace::ledger::{Ledger, LedgerEvent, LedgerKind, LedgerPage, LedgerTail};
use nextup_core::workspace::modules::{self, WorkspaceModules};
use nextup_core::workspace::ops::{self, TaskUpdate};
use nextup_core::workspace::registry::{self, WorkspaceOverview};
use nextup_core::workspace::settings::{self, WorkspaceSettings};
use nextup_core::workspace::tasks::{NewTask, Task, TaskEdit, TaskStatus, TaskStore};
use nextup_core::workspace::teams::{self, Team, TeamMember};
use nextup_core::workspace::templates::{self, TemplateSummary, WorkflowTemplate};
use nextup_core::workspace::workflow::{self, WorkflowStatus};
use tauri::{AppHandle, Emitter};

use crate::terminal::{TerminalBuffer, TerminalManager, TerminalSessionMeta};
use crate::watcher::{self, WatcherGuard};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Holds the live filesystem watcher for the currently loaded workspace.
#[derive(Default)]
pub struct WatcherState(pub Mutex<Option<WatcherGuard>>);

/// App-level embedded terminal sessions (D50) — created in `lib.rs` setup
/// with a sink that forwards PTY output as Tauri events.
pub struct TerminalState(pub Arc<TerminalManager>);

type CmdResult<T> = Result<T, NextUpError>;

/// Run a filesystem/CPU-heavy closure on the blocking pool instead of the
/// async runtime driving the UI bridge. A panicked/cancelled task reports the
/// closure's type name, which embeds the enclosing command's path — so the
/// error says *which* command died without every call site passing a label.
async fn blocking<T, F>(f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CmdResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| {
        NextUpError::Ipc(format!(
            "background task failed in {}: {e}",
            std::any::type_name::<F>()
        ))
    })?
}

/// Make `root` the active workspace: update AppState and (re)start the
/// filesystem watcher on it. Replacing the guard drops the previous watcher.
fn engage_workspace(
    app: &AppHandle,
    state: &AppState,
    watchers: &WatcherState,
    root: PathBuf,
    context: ProjectContext,
) -> CmdResult<()> {
    state.set_workspace(root.clone(), context);
    let guard = watcher::start(app.clone(), root)?;
    let mut slot = watchers
        .0
        .lock()
        .map_err(|_| NextUpError::Ipc("watcher state lock poisoned".into()))?;
    *slot = Some(guard);
    Ok(())
}

fn release_watcher(watchers: &WatcherState) -> CmdResult<()> {
    let mut slot = watchers
        .0
        .lock()
        .map_err(|_| NextUpError::Ipc("watcher state lock poisoned".into()))?;
    *slot = None;
    Ok(())
}

// ── System ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn system_status(state: tauri::State<'_, AppState>) -> CmdResult<SystemStatus> {
    let st = state.inner().clone();
    blocking(move || Ok(st.status(APP_VERSION))).await
}

/// Whether a usable `git` is on PATH — the wizard only shows the "version
/// control" checkbox when this is true.
#[tauri::command]
pub async fn git_available() -> CmdResult<bool> {
    blocking(move || Ok(crate::git::git_available())).await
}

// ── Workspace lifecycle ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn initialize_project(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    watchers: tauri::State<'_, WatcherState>,
    params: InitProjectParams,
    init_git: bool,
) -> CmdResult<SystemStatus> {
    let st = state.inner().clone();
    let keys = st.key_provider();
    let root = PathBuf::from(params.root.trim());
    let context =
        blocking(move || init::initialize_project(&params, keys.as_ref(), APP_VERSION)).await?;
    let wire_root = root.clone();
    let _ = blocking(move || Ok(crate::mcp_deploy::wire_hub_discovery(&wire_root))).await;
    // Optionally place the workspace under git. Best-effort: never fails init,
    // and skips when the folder is already inside a work tree.
    if init_git {
        let git_root = root.clone();
        let _ = blocking(move || Ok(crate::git::init_repo(&git_root))).await;
    }
    record_recent(&context, &root);
    engage_workspace(&app, &st, &watchers, root, context)?;
    Ok(st.status(APP_VERSION))
}

/// What the init wizard's live collision check found at `parent\folder`
/// (D44). `is_workspace` upgrades the warning to "open it instead".
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitTargetProbe {
    pub exists: bool,
    pub is_workspace: bool,
}

/// Read-only probe for the new-workspace wizard: the UI disables "create"
/// before submit instead of failing after. The authoritative collision
/// guard stays in core (`create_root` creates atomically).
#[tauri::command]
pub async fn probe_init_target(parent: String, folder: String) -> CmdResult<InitTargetProbe> {
    blocking(move || {
        let target = Path::new(parent.trim()).join(folder.trim());
        let exists = target.exists();
        let is_workspace = exists && WorkspacePaths::new(&target).is_initialized();
        Ok(InitTargetProbe { exists, is_workspace })
    })
    .await
}

#[tauri::command]
pub async fn open_workspace(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    watchers: tauri::State<'_, WatcherState>,
    root: String,
) -> CmdResult<SystemStatus> {
    let st = state.inner().clone();
    let root_path = PathBuf::from(root.trim());
    let opened_root = root_path.clone();
    // Opening is a pure read (D41) — no ledger line.
    let context = blocking(move || init::open_workspace(&opened_root)).await?;
    record_recent(&context, &root_path);
    engage_workspace(&app, &st, &watchers, root_path, context)?;
    Ok(st.status(APP_VERSION))
}

#[tauri::command]
pub async fn close_workspace(
    state: tauri::State<'_, AppState>,
    watchers: tauri::State<'_, WatcherState>,
) -> CmdResult<SystemStatus> {
    state.clear_workspace();
    release_watcher(&watchers)?;
    Ok(state.status(APP_VERSION))
}

// ── Tasks ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_tasks(state: tauri::State<'_, AppState>) -> CmdResult<Vec<Task>> {
    let ws = state.require_workspace()?;
    blocking(move || TaskStore::new(ws.paths().tasks_dir()).list()).await
}

#[tauri::command]
pub async fn create_task(
    state: tauri::State<'_, AppState>,
    input: NewTask,
) -> CmdResult<Task> {
    let ws = state.require_workspace()?;
    blocking(move || ops::create_task(&ws.paths(), APP_VERSION, input)).await
}

#[tauri::command]
pub async fn update_task_status(
    state: tauri::State<'_, AppState>,
    id: String,
    status: TaskStatus,
    blocked_reason: Option<String>,
) -> CmdResult<TaskUpdate> {
    let ws = state.require_workspace()?;
    blocking(move || {
        ops::update_task_status(&ws.paths(), APP_VERSION, &id, status, blocked_reason)
    })
    .await
}

/// Rewrite a task's attributes (title / description / priority / tags). The
/// status, verification, archive and assignee dimensions keep their own
/// commands — this one can never move them.
#[tauri::command]
pub async fn edit_task(
    state: tauri::State<'_, AppState>,
    id: String,
    edit: TaskEdit,
) -> CmdResult<TaskUpdate> {
    let ws = state.require_workspace()?;
    blocking(move || ops::edit_task(&ws.paths(), APP_VERSION, &id, edit)).await
}

/// Delete a task file. Refused (structured `has_dependents`) while another
/// task lists it as a prerequisite — a refusal writes nothing at all. On a
/// successful delete the ledger keeps the title, so the trail outlives the file.
#[tauri::command]
pub async fn delete_task(state: tauri::State<'_, AppState>, id: String) -> CmdResult<()> {
    let ws = state.require_workspace()?;
    blocking(move || ops::delete_task(&ws.paths(), APP_VERSION, &id)).await
}

/// Assign / reassign / unassign a task (collab module). The GUI is the human
/// dispatcher, so no actor identity is stamped — agent-side handovers come in
/// through the hub with their self-declared name.
#[tauri::command]
pub async fn assign_task(
    state: tauri::State<'_, AppState>,
    id: String,
    assignee: Option<String>,
) -> CmdResult<TaskUpdate> {
    let ws = state.require_workspace()?;
    blocking(move || {
        ops::assign_task(&ws.paths(), APP_VERSION, &id, assignee.as_deref(), None)
    })
    .await
}

#[tauri::command]
pub async fn set_task_verification(
    state: tauri::State<'_, AppState>,
    id: String,
    verified: bool,
    note: Option<String>,
) -> CmdResult<TaskUpdate> {
    let ws = state.require_workspace()?;
    blocking(move || ops::set_task_verification(&ws.paths(), APP_VERSION, &id, verified, note))
        .await
}

/// Archive / un-archive one done task (D40 — hides it from default listings;
/// the file never moves).
#[tauri::command]
pub async fn set_task_archived(
    state: tauri::State<'_, AppState>,
    id: String,
    archived: bool,
) -> CmdResult<TaskUpdate> {
    let ws = state.require_workspace()?;
    blocking(move || ops::set_task_archived(&ws.paths(), APP_VERSION, &id, archived)).await
}

/// Bulk-archive every done-and-verified task (the tasks page sweep button,
/// D40). Returns the archived ids; empty means there was nothing to sweep.
#[tauri::command]
pub async fn archive_verified_done_tasks(
    state: tauri::State<'_, AppState>,
) -> CmdResult<Vec<String>> {
    let ws = state.require_workspace()?;
    blocking(move || ops::archive_verified_done_tasks(&ws.paths(), APP_VERSION, None)).await
}

/// Workspace-open housekeeping (D78): sweep verified-done tasks older than
/// the configured auto-archive window. Honors the per-workspace switch —
/// disabled settings make this a guaranteed no-op, so the app layer calls it
/// unconditionally after every open.
#[tauri::command]
pub async fn auto_archive_sweep(state: tauri::State<'_, AppState>) -> CmdResult<Vec<String>> {
    let ws = state.require_workspace()?;
    blocking(move || ops::auto_archive_sweep(&ws.paths(), APP_VERSION)).await
}

/// Spec-layer overview (D79 batch ④): capability names + requirement counts
/// for the Specs view rail.
#[tauri::command]
pub async fn specs_overview(
    state: tauri::State<'_, AppState>,
) -> CmdResult<Vec<nextup_core::workspace::specs::SpecOverview>> {
    let ws = state.require_workspace()?;
    blocking(move || nextup_core::workspace::specs::specs_overview(&ws.paths())).await
}

/// One capability's main-spec markdown (read face; editing stays with files).
#[tauri::command]
pub async fn spec_content(
    state: tauri::State<'_, AppState>,
    capability: String,
) -> CmdResult<String> {
    let ws = state.require_workspace()?;
    blocking(move || {
        nextup_core::workspace::specs::read_current_spec(&ws.paths(), &capability)?.ok_or_else(
            || {
                nextup_core::NextUpError::NotFound(format!(
                    "no spec for capability '{capability}'"
                ))
            },
        )
    })
    .await
}

/// Dry-run reports for every unarchived task with an unfolded delta bundle
/// — the Specs view's pending panel.
#[tauri::command]
pub async fn pending_spec_folds(
    state: tauri::State<'_, AppState>,
) -> CmdResult<Vec<nextup_core::workspace::specs::TaskSpecsReport>> {
    let ws = state.require_workspace()?;
    blocking(move || ops::pending_spec_folds(&ws.paths())).await
}

#[tauri::command]
pub async fn get_workspace_settings(
    state: tauri::State<'_, AppState>,
) -> CmdResult<WorkspaceSettings> {
    let ws = state.require_workspace()?;
    blocking(move || settings::get_settings(&ws.paths())).await
}

#[tauri::command]
pub async fn set_workspace_settings(
    state: tauri::State<'_, AppState>,
    settings: WorkspaceSettings,
) -> CmdResult<WorkspaceSettings> {
    let ws = state.require_workspace()?;
    blocking(move || settings::save_settings(&ws.paths(), &settings)).await
}

// ── Handoff & ledger ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn read_handoff(state: tauri::State<'_, AppState>) -> CmdResult<String> {
    let ws = state.require_workspace()?;
    blocking(move || {
        let path = ws.paths().handoff_file();
        if !path.exists() {
            return Err(NextUpError::NotFound(
                "handoff snapshot has not been generated yet".into(),
            ));
        }
        Ok(std::fs::read_to_string(path)?)
    })
    .await
}

/// Manual UI trigger for the checkpoint serializer.
#[tauri::command]
pub async fn generate_handoff_now(state: tauri::State<'_, AppState>) -> CmdResult<String> {
    let ws = state.require_workspace()?;
    blocking(move || handoff::generate_handoff(&ws.paths(), APP_VERSION)).await
}

#[tauri::command]
pub async fn recent_events(
    state: tauri::State<'_, AppState>,
    limit: usize,
) -> CmdResult<Vec<LedgerEvent>> {
    let ws = state.require_workspace()?;
    // Ceiling and noise policy live in core (RECENT_LIMIT_MAX / is_noise).
    blocking(move || Ledger::new(ws.paths().ledger_file()).recent_visible(limit)).await
}

/// Ledger tail after a caller-held line cursor (D62), for the notification
/// layer. Pass `fromLine: 0` on first ask, then the returned `nextLine`.
/// Unlike `recent_events` this keeps noise kinds — the caller decides what is
/// worth announcing, and dropping lines here would desync the cursor.
#[tauri::command]
pub async fn ledger_since(
    state: tauri::State<'_, AppState>,
    from_line: usize,
    limit: usize,
) -> CmdResult<LedgerTail> {
    let ws = state.require_workspace()?;
    blocking(move || Ledger::new(ws.paths().ledger_file()).since(from_line, limit)).await
}

/// Paged ledger browsing for the Ledger view (D47). `kinds: None` means every
/// display-worthy kind; noise and the page ceiling live in core
/// (is_noise / HISTORY_LIMIT_MAX).
#[tauri::command]
pub async fn ledger_history(
    state: tauri::State<'_, AppState>,
    kinds: Option<Vec<LedgerKind>>,
    offset: usize,
    limit: usize,
) -> CmdResult<LedgerPage> {
    let ws = state.require_workspace()?;
    blocking(move || {
        Ledger::new(ws.paths().ledger_file()).history(kinds.as_deref(), offset, limit)
    })
    .await
}

#[tauri::command]
pub async fn add_ledger_note(
    state: tauri::State<'_, AppState>,
    channel: String,
    message: String,
) -> CmdResult<LedgerEvent> {
    // Blank-message and channel validation live in core so both channels
    // (GUI and hub) agree; unknown channel names are rejected, never coerced.
    let ws = state.require_workspace()?;
    blocking(move || {
        let channel = ops::NoteChannel::parse(&channel)?;
        ops::add_ledger_note(&ws.paths(), APP_VERSION, channel, &message)
    })
    .await
}

// ── Workflow harness ────────────────────────────────────────────────────────

/// Templates available for the initializer wizard (built-in + user-authored
/// files in ~/.nextup/templates). Needs no loaded workspace. `lang` is the UI
/// language tag — built-in content follows it (D54), customs are as-authored.
#[tauri::command]
pub async fn list_templates(lang: Option<String>) -> CmdResult<Vec<TemplateSummary>> {
    blocking(move || {
        templates::template_summaries(
            templates::default_custom_dir().as_deref(),
            templates::TemplateLang::from_tag(lang.as_deref()),
        )
    })
    .await
}

/// Full template body for the editor (built-in or custom). Needs no workspace.
#[tauri::command]
pub async fn get_template(id: String, lang: Option<String>) -> CmdResult<WorkflowTemplate> {
    blocking(move || {
        templates::resolve_template(
            Some(&id),
            templates::default_custom_dir().as_deref(),
            templates::TemplateLang::from_tag(lang.as_deref()),
        )
    })
    .await
}

/// Create or update a user-authored template (D43). Validation, the
/// built-in-id rejection and file placement live in core; returns the
/// refreshed list so the UI updates in one round-trip.
#[tauri::command]
pub async fn save_custom_template(
    template: WorkflowTemplate,
    lang: Option<String>,
) -> CmdResult<Vec<TemplateSummary>> {
    blocking(move || {
        let dir = custom_templates_dir()?;
        templates::save_custom_template(&dir, &template)?;
        templates::template_summaries(Some(&dir), templates::TemplateLang::from_tag(lang.as_deref()))
    })
    .await
}

#[tauri::command]
pub async fn delete_custom_template(
    id: String,
    lang: Option<String>,
) -> CmdResult<Vec<TemplateSummary>> {
    blocking(move || {
        let dir = custom_templates_dir()?;
        templates::delete_custom_template(&dir, &id)?;
        templates::template_summaries(Some(&dir), templates::TemplateLang::from_tag(lang.as_deref()))
    })
    .await
}

fn custom_templates_dir() -> Result<std::path::PathBuf, NextUpError> {
    templates::default_custom_dir().ok_or_else(|| {
        NextUpError::Workspace("cannot locate the home directory for ~/.nextup/templates".into())
    })
}

#[tauri::command]
pub async fn workflow_status(state: tauri::State<'_, AppState>) -> CmdResult<WorkflowStatus> {
    let ws = state.require_workspace()?;
    blocking(move || workflow::evaluate(&ws.paths())).await
}

/// Enforced phase transition; `force` requires a reason and is ledgered as an
/// override.
#[tauri::command]
pub async fn advance_phase(
    state: tauri::State<'_, AppState>,
    force: bool,
    reason: Option<String>,
) -> CmdResult<WorkflowStatus> {
    let ws = state.require_workspace()?;
    blocking(move || workflow::advance_phase(&ws.paths(), APP_VERSION, force, reason)).await
}

#[tauri::command]
pub async fn confirm_gate(
    state: tauri::State<'_, AppState>,
    phase_id: String,
    prompt: String,
) -> CmdResult<WorkflowStatus> {
    let ws = state.require_workspace()?;
    blocking(move || workflow::confirm_gate(&ws.paths(), &phase_id, &prompt)).await
}

/// Attach a harness to a legacy workspace that predates workflow.json.
#[tauri::command]
pub async fn adopt_workflow(
    state: tauri::State<'_, AppState>,
    template_id: String,
    lang: Option<String>,
) -> CmdResult<WorkflowStatus> {
    let ws = state.require_workspace()?;
    blocking(move || {
        let template = templates::resolve_template(
            Some(&template_id),
            templates::default_custom_dir().as_deref(),
            templates::TemplateLang::from_tag(lang.as_deref()),
        )?;
        workflow::adopt(&ws.paths(), &template, APP_VERSION)
    })
    .await
}

// ── AI-session bootstrap layer ──────────────────────────────────────────────

/// (Re)create any missing bootstrap files (CLAUDE.md, AGENTS.md, guide,
/// memory index, manifest, work_record template) for the loaded workspace —
/// used by legacy workspaces or after accidental deletion. Never overwrites
/// existing files; returns the names it created.
#[tauri::command]
pub async fn scaffold_bootstrap(state: tauri::State<'_, AppState>) -> CmdResult<Vec<String>> {
    let ws = state.require_workspace()?;
    blocking(move || {
        let paths = ws.paths();
        let created = bootstrap::scaffold(&paths, &ws.context)?;
        bootstrap::refresh(&paths)?;
        Ok(created)
    })
    .await
}

// ── Shipped workspace assets (D38) ──────────────────────────────────────────

#[tauri::command]
pub async fn workspace_assets_status(
    state: tauri::State<'_, AppState>,
) -> CmdResult<Vec<AssetStatus>> {
    let ws = state.require_workspace()?;
    blocking(move || assets::assets_status(&ws.paths())).await
}

/// `overwrite` / `keep_as_user` carry the user's per-item decisions for
/// manual-review assets (empty for the plain "upgrade" button — safe items
/// only). The engine re-renders content itself; the UI never sends any.
#[tauri::command]
pub async fn workspace_assets_upgrade(
    state: tauri::State<'_, AppState>,
    overwrite: Vec<String>,
    keep_as_user: Vec<String>,
) -> CmdResult<AssetsUpgradeOutcome> {
    let ws = state.require_workspace()?;
    blocking(move || {
        assets::upgrade_assets(
            &ws.paths(),
            APP_VERSION,
            &AssetDecisions { overwrite, keep_as_user },
        )
    })
    .await
}

// ── Secrets ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_secret_names(state: tauri::State<'_, AppState>) -> CmdResult<Vec<String>> {
    let ws = state.require_workspace()?;
    let keys = state.key_provider();
    blocking(move || secrets::secret_names(&ws.paths().secrets_file(), keys.as_ref())).await
}

#[tauri::command]
pub async fn set_secret(
    state: tauri::State<'_, AppState>,
    name: String,
    value: String,
) -> CmdResult<Vec<String>> {
    let ws = state.require_workspace()?;
    let keys = state.key_provider();
    // Audit line + lock live in core ops — every channel gets the same trail.
    blocking(move || ops::set_secret(&ws.paths(), keys.as_ref(), &name, &value)).await
}

#[tauri::command]
pub async fn delete_secret(
    state: tauri::State<'_, AppState>,
    name: String,
) -> CmdResult<Vec<String>> {
    let ws = state.require_workspace()?;
    let keys = state.key_provider();
    blocking(move || ops::remove_secret(&ws.paths(), keys.as_ref(), &name)).await
}

// ── Backup ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn export_backup(
    state: tauri::State<'_, AppState>,
    dest_path: String,
    passphrase: String,
    include_artifacts: bool,
) -> CmdResult<String> {
    let ws = state.require_workspace()?;
    let keys = state.key_provider();
    blocking(move || {
        let written = backup::export_backup(
            &ws.paths(),
            keys.as_ref(),
            Path::new(&dest_path),
            &passphrase,
            include_artifacts,
            APP_VERSION,
        )?;
        Ok(written.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
pub async fn import_backup(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    watchers: tauri::State<'_, WatcherState>,
    archive_path: String,
    dest_root: String,
    passphrase: String,
) -> CmdResult<SystemStatus> {
    let st = state.inner().clone();
    let keys = st.key_provider();
    let root = PathBuf::from(dest_root.trim());
    let import_root = root.clone();
    let context = blocking(move || {
        backup::import_backup(Path::new(&archive_path), &import_root, keys.as_ref(), &passphrase)
    })
    .await?;
    // The archive may carry another machine's absolute hub path — rewire.
    let wire_root = root.clone();
    let _ = blocking(move || Ok(crate::mcp_deploy::wire_hub_discovery(&wire_root))).await;
    record_recent(&context, &root);
    engage_workspace(&app, &st, &watchers, root, context)?;
    Ok(st.status(APP_VERSION))
}

// ── Agent hub access (nextup-mcp server; nextup_docs/06) ────────────────────
// The MCP *client* IPC surface was retired in D15 (agents bring their own
// clients); core mcp/ stays dormant as gateway groundwork.

/// The access registry plus the tier lists so the catalog renders from the
/// same single source of truth the server authorizes against. `write_tools`
/// is the *exposed* set (D37): tools whose module is off are hidden here
/// exactly as they are hidden from the hub's tools/list.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessView {
    pub access: agent::AgentAccess,
    pub read_tools: Vec<String>,
    pub write_tools: Vec<String>,
    /// The exposed write tier bucketed into semantic groups (D39), in
    /// `TOOL_GROUPS` display order; groups left empty by module filtering
    /// are dropped so the catalog never shows a header with no switches.
    pub write_tool_groups: Vec<ToolGroupView>,
    /// Tool id → why it is withheld from the day-one grant (D63), for the
    /// exposed guarded tools only. The catalog renders the reason beside the
    /// switch so "why was my agent denied this?" is answered where the answer
    /// acts, and a denial jump lands on an explanation rather than a bare
    /// toggle. Empty string values never occur — absence means "not guarded".
    pub guarded_reasons: BTreeMap<String, String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolGroupView {
    pub id: String,
    pub tools: Vec<String>,
}

fn agent_view(paths: &WorkspacePaths, access: agent::AgentAccess) -> CmdResult<AgentAccessView> {
    let modules = modules::get_modules(paths)?;
    let exposed = agent::exposed_write_tools(&modules);
    let write_tool_groups = agent::TOOL_GROUPS
        .iter()
        .map(|g| ToolGroupView {
            id: g.to_string(),
            tools: exposed
                .iter()
                .filter(|t| agent::tool_group(t) == Some(g))
                .map(|t| t.to_string())
                .collect(),
        })
        .filter(|g| !g.tools.is_empty())
        .collect();
    let guarded_reasons = exposed
        .iter()
        .filter_map(|t| agent::guarded_reason(t).map(|r| (t.to_string(), r.to_string())))
        .collect();
    Ok(AgentAccessView {
        access,
        // Exposed, not the raw registry: the team module contributes read
        // tools (D48), and listing one the hub does not advertise would
        // promise the agent a capability it cannot call.
        read_tools: agent::exposed_read_tools(&modules).iter().map(|s| s.to_string()).collect(),
        write_tools: exposed.iter().map(|s| s.to_string()).collect(),
        write_tool_groups,
        guarded_reasons,
    })
}

#[tauri::command]
pub async fn agent_access_status(state: tauri::State<'_, AppState>) -> CmdResult<AgentAccessView> {
    let ws = state.require_workspace()?;
    blocking(move || {
        let paths = ws.paths();
        agent::get_access(&paths).and_then(|a| agent_view(&paths, a))
    })
    .await
}

#[tauri::command]
pub async fn agent_access_set_enabled(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> CmdResult<AgentAccessView> {
    let ws = state.require_workspace()?;
    blocking(move || {
        let paths = ws.paths();
        agent::set_enabled(&paths, enabled).and_then(|a| agent_view(&paths, a))
    })
    .await
}

#[tauri::command]
pub async fn agent_access_set_tool(
    state: tauri::State<'_, AppState>,
    tool: String,
    allowed: bool,
) -> CmdResult<AgentAccessView> {
    let ws = state.require_workspace()?;
    blocking(move || {
        let paths = ws.paths();
        agent::set_tool_allowed(&paths, &tool, allowed).and_then(|a| agent_view(&paths, a))
    })
    .await
}

/// Toggle a batch of write tools in one write (the catalog group switch,
/// D39). The GUI sends the group's exposed tools; core re-validates each.
#[tauri::command]
pub async fn agent_access_set_tools(
    state: tauri::State<'_, AppState>,
    tools: Vec<String>,
    allowed: bool,
) -> CmdResult<AgentAccessView> {
    let ws = state.require_workspace()?;
    blocking(move || {
        let paths = ws.paths();
        agent::set_tools_allowed(&paths, &tools, allowed).and_then(|a| agent_view(&paths, a))
    })
    .await
}

/// Allow or deny the entire exposed write tier in one write (the catalog
/// "select all" box), so the user need not tick each tool individually.
#[tauri::command]
pub async fn agent_access_set_all_tools(
    state: tauri::State<'_, AppState>,
    allowed: bool,
) -> CmdResult<AgentAccessView> {
    let ws = state.require_workspace()?;
    blocking(move || {
        let paths = ws.paths();
        agent::set_all_tools_allowed(&paths, allowed).and_then(|a| agent_view(&paths, a))
    })
    .await
}

// ── Capability modules (D31) ────────────────────────────────────────────────

#[tauri::command]
pub async fn modules_get(state: tauri::State<'_, AppState>) -> CmdResult<WorkspaceModules> {
    let ws = state.require_workspace()?;
    blocking(move || modules::get_modules(&ws.paths())).await
}

#[tauri::command]
pub async fn module_set_enabled(
    state: tauri::State<'_, AppState>,
    module: String,
    enabled: bool,
) -> CmdResult<WorkspaceModules> {
    let ws = state.require_workspace()?;
    // Synced variant: module-gated STATE lines (specs count row) must appear or
    // vanish with the switch itself, not on the next unrelated mutation (E1).
    blocking(move || modules::set_module_enabled_synced(&ws.paths(), &module, enabled, APP_VERSION))
        .await
}

/// Where the app resolved the `nextup-mcp` hub binary and whether the current
/// workspace `.mcp.json` will actually launch it — drives the Tools panel's
/// deployment health row.
#[tauri::command]
pub async fn agent_mcp_status(
    state: tauri::State<'_, AppState>,
) -> CmdResult<crate::mcp_deploy::AgentMcpStatus> {
    let ws = state.require_workspace()?;
    let root = ws.paths().root().to_path_buf();
    blocking(move || Ok(crate::mcp_deploy::status_for(&root))).await
}

/// One-click repair: rewrite this workspace's `.mcp.json` so the `nextup` server
/// points at the resolved absolute hub path — no PATH setup required. Fails if
/// the binary cannot be located (the user must build it first).
#[tauri::command]
pub async fn agent_mcp_repair(
    state: tauri::State<'_, AppState>,
) -> CmdResult<crate::mcp_deploy::AgentMcpStatus> {
    let ws = state.require_workspace()?;
    let root = ws.paths().root().to_path_buf();
    blocking(move || {
        let hub = crate::mcp_deploy::resolve_hub_binary().ok_or_else(|| {
            NextUpError::NotFound(
                "nextup-mcp executable not found — build it first with `cargo build --release -p nextup-mcp`"
                    .into(),
            )
        })?;
        let paths = nextup_core::workspace::layout::WorkspacePaths::new(&root);
        bootstrap::set_mcp_discovery_command(&paths, &hub.to_string_lossy())?;
        Ok(crate::mcp_deploy::status_for(&root))
    })
    .await
}

// ── Full-text index (Module B) ──────────────────────────────────────────────

const INDEX_PROGRESS_EVENT: &str = "index://progress";

/// Rebuild the workspace FTS5 index, streaming `index://progress` events
/// (throttled) so the UI can render a live counter.
#[tauri::command]
pub async fn build_search_index(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> CmdResult<IndexSummary> {
    let ws = state.require_workspace()?;
    blocking(move || {
        index_ops::build_index(&ws.paths(), &mut |p: IndexProgress| {
            if p.indexed % 10 == 0 || p.indexed == p.total {
                let _ = app.emit(INDEX_PROGRESS_EVENT, p);
            }
        })
    })
    .await
}

#[tauri::command]
pub async fn search_index(
    state: tauri::State<'_, AppState>,
    query: String,
    limit: u32,
) -> CmdResult<Vec<SearchHit>> {
    let ws = state.require_workspace()?;
    // The ceiling lives in core (search_index clamps to SEARCH_LIMIT_MAX).
    blocking(move || index_ops::search_index(&ws.paths(), &query, limit)).await
}

#[tauri::command]
pub async fn search_index_status(
    state: tauri::State<'_, AppState>,
) -> CmdResult<Option<IndexInfo>> {
    let ws = state.require_workspace()?;
    blocking(move || index_ops::index_status(&ws.paths())).await
}

// ── Context & milestones ────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_context(state: tauri::State<'_, AppState>) -> CmdResult<ProjectContext> {
    let ws = state.require_workspace()?;
    blocking(move || {
        nextup_core::workspace::context::load_context(&ws.paths().context_file())
    })
    .await
}

#[tauri::command]
pub async fn add_milestone(
    state: tauri::State<'_, AppState>,
    title: String,
) -> CmdResult<ProjectContext> {
    let ws = state.require_workspace()?;
    blocking(move || ops::add_milestone(&ws.paths(), APP_VERSION, &title)).await
}

#[tauri::command]
pub async fn set_milestone_done(
    state: tauri::State<'_, AppState>,
    id: String,
    done: bool,
) -> CmdResult<ProjectContext> {
    let ws = state.require_workspace()?;
    blocking(move || ops::set_milestone_done(&ws.paths(), APP_VERSION, &id, done)).await
}

#[tauri::command]
pub async fn set_milestone_verified(
    state: tauri::State<'_, AppState>,
    id: String,
    verified: bool,
) -> CmdResult<ProjectContext> {
    let ws = state.require_workspace()?;
    blocking(move || ops::set_milestone_verified(&ws.paths(), APP_VERSION, &id, verified)).await
}

#[tauri::command]
pub async fn remove_milestone(
    state: tauri::State<'_, AppState>,
    id: String,
) -> CmdResult<ProjectContext> {
    let ws = state.require_workspace()?;
    blocking(move || ops::remove_milestone(&ws.paths(), APP_VERSION, &id)).await
}

// ── Doctor ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn run_doctor(state: tauri::State<'_, AppState>) -> CmdResult<DoctorReport> {
    let ws = state.require_workspace()?;
    blocking(move || doctor::run_doctor(ws.paths().root())).await
}

// ── Workspace registry & legacy adoption ───────────────────────────────────

/// Cross-workspace overview for the Welcome screen; needs no loaded
/// workspace. State is re-read from each root at call time.
#[tauri::command]
pub async fn recent_workspaces() -> CmdResult<Vec<WorkspaceOverview>> {
    blocking(move || match registry::default_registry_path() {
        Some(path) => registry::overview(&path),
        None => Ok(Vec::new()),
    })
    .await
}

/// Drop one pointer from the recent-workspace registry. Files on disk are
/// never touched. Returns the refreshed overview so the UI updates in one
/// round trip.
#[tauri::command]
pub async fn remove_recent_workspace(root: String) -> CmdResult<Vec<WorkspaceOverview>> {
    blocking(move || match registry::default_registry_path() {
        Some(path) => {
            registry::remove_workspace(&path, &root)?;
            registry::overview(&path)
        }
        None => Ok(Vec::new()),
    })
    .await
}

/// Read-only analysis of a legacy (non-Agent NextUp) folder → adoption draft.
#[tauri::command]
pub async fn draft_legacy_adoption(root: String) -> CmdResult<AdoptionDraft> {
    blocking(move || index_ops::draft_legacy(Path::new(root.trim()))).await
}

/// Confirmed draft → initialized workspace + approved suggested tasks.
#[tauri::command]
pub async fn adopt_legacy_project(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    watchers: tauri::State<'_, WatcherState>,
    params: InitProjectParams,
    tasks: Vec<NewTask>,
) -> CmdResult<SystemStatus> {
    let st = state.inner().clone();
    let keys = st.key_provider();
    let root = PathBuf::from(params.root.trim());
    let context = blocking(move || {
        index_ops::adopt_legacy_project(&params, tasks, keys.as_ref(), APP_VERSION)
    })
    .await?;
    // Same post-entry wiring as initialize_project: adopted workspaces must
    // not come out with a bare PATH-dependent hub command.
    let wire_root = root.clone();
    let _ = blocking(move || Ok(crate::mcp_deploy::wire_hub_discovery(&wire_root))).await;
    record_recent(&context, &root);
    engage_workspace(&app, &st, &watchers, root, context)?;
    Ok(st.status(APP_VERSION))
}

/// Best-effort registry upsert — failing to record a pointer must never
/// fail the open/initialize itself.
fn record_recent(context: &ProjectContext, root: &Path) {
    if let Some(reg) = registry::default_registry_path() {
        let _ = registry::record_workspace(
            &reg,
            &root.to_string_lossy(),
            &context.name,
            &context.domain,
        );
    }
}

// ── Teams & cross-workspace exchange (D48) ──────────────────────────────────

/// App-level team graph — needs no loaded workspace (same tier as the
/// registry commands above). `teams::mutate` owns the shape every write here
/// shares: resolve `~/.nextup/teams.json`, apply the change, answer with the
/// reloaded graph.
#[tauri::command]
pub async fn teams_list() -> CmdResult<Vec<Team>> {
    blocking(move || teams::list_all()).await
}

#[tauri::command]
pub async fn team_create(name: String) -> CmdResult<Vec<Team>> {
    blocking(move || teams::mutate(|path| teams::create_team(path, &name))).await
}

#[tauri::command]
pub async fn team_rename(team_id: String, name: String) -> CmdResult<Vec<Team>> {
    blocking(move || teams::mutate(|path| teams::rename_team(path, &team_id, &name))).await
}

#[tauri::command]
pub async fn team_delete(team_id: String) -> CmdResult<Vec<Team>> {
    blocking(move || teams::mutate(|path| teams::delete_team(path, &team_id))).await
}

/// Join a registered workspace to a team. The join is the explicit write
/// moment (09 §12 Q1): mint the workspace's stable id if it predates D48 and
/// switch its team module on — membership without the inbox surface would be
/// a silent black hole. Both steps are idempotent.
#[tauri::command]
pub async fn team_add_member(team_id: String, root: String) -> CmdResult<Vec<Team>> {
    blocking(move || {
        teams::mutate(|path| {
            let paths = WorkspacePaths::new(root.trim());
            let context = init::open_workspace(paths.root())?;
            let workspace_id = ops::ensure_workspace_id(&paths, APP_VERSION)?;
            if !modules::get_modules(&paths)?.is_enabled(modules::MODULE_TEAM) {
                // Synced variant (D82): switching a module on changes the
                // takeover surface — the module-guide line in the STATE block,
                // and the guide file itself. The plain variant would leave both
                // stale until some unrelated mutation happened to sync, which on
                // this path could be never; joining a team is often the last
                // thing the user does.
                modules::set_module_enabled_synced(&paths, modules::MODULE_TEAM, true, APP_VERSION)?;
            }
            teams::add_member(
                path,
                &team_id,
                TeamMember { workspace_id, root: root.trim().to_string(), name: context.name },
            )
        })
    })
    .await
}

#[tauri::command]
pub async fn team_remove_member(team_id: String, workspace_id: String) -> CmdResult<Vec<Team>> {
    blocking(move || teams::mutate(|path| teams::remove_member(path, &team_id, &workspace_id)))
        .await
}

/// Re-link a moved member folder (D52, 09 §2): the picked folder is accepted
/// only when its context carries exactly the member's stable id — then the
/// root/name display caches refresh across every team (a folder move is a
/// workspace fact, not a per-team one). Read-only towards the workspace.
#[tauri::command]
pub async fn team_rebind_workspace(
    workspace_id: String,
    new_root: String,
) -> CmdResult<Vec<Team>> {
    blocking(move || {
        teams::mutate(|path| {
            let paths = WorkspacePaths::new(new_root.trim());
            let context = init::open_workspace(paths.root())?;
            teams::check_rebind_identity(&workspace_id, context.workspace_id.as_deref())?;
            teams::rebind_workspace(path, &workspace_id, new_root.trim(), &context.name)
        })
    })
    .await
}

/// Persist the team-canvas node positions (D53). Presentation state only —
/// the GUI sends the full map after a drag or auto-tidy; opening never writes.
#[tauri::command]
pub async fn team_set_layout(
    team_id: String,
    positions: std::collections::HashMap<String, teams::NodePos>,
) -> CmdResult<Vec<Team>> {
    blocking(move || teams::mutate(|path| teams::set_layout(path, &team_id, positions))).await
}

#[tauri::command]
pub async fn team_add_edge(team_id: String, from: String, to: String) -> CmdResult<Vec<Team>> {
    blocking(move || teams::mutate(|path| teams::add_edge(path, &team_id, &from, &to))).await
}

#[tauri::command]
pub async fn team_remove_edge(team_id: String, from: String, to: String) -> CmdResult<Vec<Team>> {
    blocking(move || teams::mutate(|path| teams::remove_edge(path, &team_id, &from, &to))).await
}

#[tauri::command]
pub async fn team_set_edge_auto_route(
    team_id: String,
    from: String,
    to: String,
    auto_route: bool,
) -> CmdResult<Vec<Team>> {
    blocking(move || {
        teams::mutate(|path| teams::set_edge_auto_route(path, &team_id, &from, &to, auto_route))
    })
    .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDestinationDto {
    pub root: String,
    pub team_id: String,
    pub team_name: String,
}

/// Send one outbox envelope to the user-selected destinations (the Send
/// button — the human is the fan-out point when a workspace sits in several
/// teams, 09 §5). App-level: the upstream root comes from the team view.
#[tauri::command]
pub async fn team_route_delivery(
    root: String,
    id: String,
    destinations: Vec<RouteDestinationDto>,
    auto: Option<bool>,
    keep_pending: Option<bool>,
) -> CmdResult<RouteOutcome> {
    blocking(move || {
        let upstream = WorkspacePaths::new(root.trim());
        let dests: Vec<exchange::RouteDestination> = destinations
            .into_iter()
            .map(|d| exchange::RouteDestination {
                root: PathBuf::from(d.root.trim()),
                team_id: d.team_id,
                team_name: d.team_name,
            })
            .collect();
        let opts = exchange::RouteOptions {
            auto: auto.unwrap_or(false),
            keep_pending: keep_pending.unwrap_or(false),
        };
        exchange::route_delivery(&upstream, APP_VERSION, &id, &dests, opts)
    })
    .await
}

/// List one exchange box of any workspace by root (the team view reads member
/// outboxes without opening them; the inbox view passes the open workspace).
#[tauri::command]
pub async fn exchange_list(root: String, mailbox: String) -> CmdResult<Vec<DeliverySummary>> {
    blocking(move || {
        exchange::list_deliveries(
            &WorkspacePaths::new(root.trim()),
            exchange::DeliveryBox::parse(&mailbox)?,
            // The GUI bounds long notes with layout, not with truncation —
            // clamping here would cost the reader text the screen can show.
            exchange::NoteDetail::Full,
        )
    })
    .await
}

/// An envelope plus, when it carries attachments, the absolute directory their
/// bytes live in — computed server-side (OS-correct separators) so the GUI can
/// show a copyable disk location via PathLabel without hardcoding the exchange
/// layout. `#[serde(flatten)]` keeps the envelope shape unchanged for callers.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryEnvelopeView {
    #[serde(flatten)]
    envelope: DeliveryEnvelope,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachment_dir: Option<String>,
}

#[tauri::command]
pub async fn exchange_get(
    root: String,
    mailbox: String,
    id: String,
) -> CmdResult<DeliveryEnvelopeView> {
    blocking(move || {
        let paths = WorkspacePaths::new(root.trim());
        let mailbox = exchange::DeliveryBox::parse(&mailbox)?;
        let envelope = exchange::get_delivery(&paths, mailbox, &id)?;
        let attachment_dir = (!envelope.payload.attachments.is_empty())
            .then(|| mailbox.dir(&paths).join(&envelope.id).to_string_lossy().into_owned());
        Ok(DeliveryEnvelopeView { envelope, attachment_dir })
    })
    .await
}

/// Publish a note-and-attachments delivery into the open workspace's outbox
/// (D73 — not the handoff snapshot). `files` are absolute paths from the native
/// picker (already legitimate — the escape-checking `resolve_workspace_relative`
/// is only for the hub's relatives).
#[tauri::command]
pub async fn exchange_publish(
    state: tauri::State<'_, AppState>,
    note: Option<String>,
    files: Option<Vec<std::path::PathBuf>>,
    supersedes: Option<String>,
) -> CmdResult<DeliveryEnvelope> {
    let ws = state.require_workspace()?;
    let files = files.unwrap_or_default();
    blocking(move || {
        exchange::publish_delivery(
            &ws.paths(),
            APP_VERSION,
            note,
            &files,
            exchange::PublishOptions { supersedes },
        )
    })
    .await
}

// ── Embedded terminal (D50) ─────────────────────────────────────────────────
// App-level like the teams tier: sessions outlive workspace switches, so no
// command here touches AppState. All go through `blocking` — spawn does real
// process creation, and a PTY write can stall on a full pipe.

/// Human-initiated launch of an agent CLI in a workspace root (the only
/// way a session ever starts, D50). `identity` (D63) optionally names who
/// this session reports as to the hub — omitted or blank stays anonymous.
#[tauri::command]
pub async fn terminal_launch(
    terminals: tauri::State<'_, TerminalState>,
    root: String,
    agent_id: String,
    identity: Option<String>,
    resume: Option<bool>,
) -> CmdResult<TerminalSessionMeta> {
    let mgr = terminals.0.clone();
    blocking(move || {
        mgr.launch(Path::new(root.trim()), &agent_id, identity.as_deref(), resume.unwrap_or(false))
    })
    .await
}

/// Bring a restored/exited tab back to life in place (D69): relaunch its agent
/// with the built-in resume invocation, reusing the same session id so the tab
/// keeps its position. Triggered on-view for a resumable tab (and by "retry"
/// on a failed one) — both human-initiated (D50: navigating a tab into view is
/// the human action).
#[tauri::command]
pub async fn terminal_revive(
    terminals: tauri::State<'_, TerminalState>,
    id: u64,
) -> CmdResult<TerminalSessionMeta> {
    let mgr = terminals.0.clone();
    blocking(move || mgr.revive(id)).await
}

/// Forward user keystrokes from the terminal view to the CLI.
#[tauri::command]
pub async fn terminal_write(
    terminals: tauri::State<'_, TerminalState>,
    id: u64,
    data: String,
) -> CmdResult<()> {
    let mgr = terminals.0.clone();
    blocking(move || mgr.write(id, &data)).await
}

#[tauri::command]
pub async fn terminal_resize(
    terminals: tauri::State<'_, TerminalState>,
    id: u64,
    rows: u16,
    cols: u16,
) -> CmdResult<()> {
    let mgr = terminals.0.clone();
    blocking(move || mgr.resize(id, rows, cols)).await
}

/// Kill (if still running) and drop a session — also dismisses an exited tab.
#[tauri::command]
pub async fn terminal_close(
    terminals: tauri::State<'_, TerminalState>,
    id: u64,
) -> CmdResult<()> {
    let mgr = terminals.0.clone();
    blocking(move || mgr.close(id)).await
}

/// All sessions across all workspaces (the app-level agent overview reads
/// this; the workspace terminal view filters by root).
#[tauri::command]
pub async fn terminal_list(
    terminals: tauri::State<'_, TerminalState>,
) -> CmdResult<Vec<TerminalSessionMeta>> {
    let mgr = terminals.0.clone();
    blocking(move || Ok(mgr.list())).await
}

/// Scrollback snapshot for remounting a session's view after a workspace
/// switch (the process kept running; the pixels are rebuilt from this).
#[tauri::command]
pub async fn terminal_read_buffer(
    terminals: tauri::State<'_, TerminalState>,
    id: u64,
) -> CmdResult<TerminalBuffer> {
    let mgr = terminals.0.clone();
    blocking(move || mgr.read_buffer(id)).await
}

/// Mark a session as (not) rendered in a pop-out window (B16-C). Broadcasts
/// `terminal://sessions` so both the main and pop-out windows reload — the
/// main view swaps between a live pane and a "Popped out" placeholder.
#[tauri::command]
pub async fn terminal_set_popped_out(
    terminals: tauri::State<'_, TerminalState>,
    id: u64,
    popped_out: bool,
) -> CmdResult<()> {
    let mgr = terminals.0.clone();
    blocking(move || mgr.set_popped_out(id, popped_out)).await
}

/// App is quitting (B16-A / D69): persist every restorable session's metadata
/// for restore, then kill the live children. Unlike `terminal_close`, the
/// persisted files are kept, so the next launch restores the tabs. The quit
/// guard calls this in place of closing each session one by one.
#[tauri::command]
pub async fn terminal_shutdown(
    terminals: tauri::State<'_, TerminalState>,
) -> CmdResult<()> {
    let mgr = terminals.0.clone();
    blocking(move || {
        mgr.shutdown();
        Ok(())
    })
    .await
}

fn agent_catalog_path() -> CmdResult<PathBuf> {
    agent_catalog::default_agent_catalog_path().ok_or_else(|| {
        NextUpError::NotFound("cannot resolve the home directory for agents.json".into())
    })
}

/// Launchable agent CLIs — presets plus custom entries, each with a live
/// PATH probe (`installed`) so launch menus grey out missing CLIs.
#[tauri::command]
pub async fn agent_catalog_list() -> CmdResult<Vec<AgentInfo>> {
    blocking(move || agent_catalog::list_agents(&agent_catalog_path()?)).await
}

/// Create or edit a custom agent CLI entry (app-level settings surface).
#[tauri::command]
pub async fn agent_catalog_save(agent: CustomAgent) -> CmdResult<Vec<AgentInfo>> {
    blocking(move || {
        let path = agent_catalog_path()?;
        agent_catalog::save_custom_agent(&path, agent)?;
        agent_catalog::list_agents(&path)
    })
    .await
}

#[tauri::command]
pub async fn agent_catalog_delete(id: String) -> CmdResult<Vec<AgentInfo>> {
    blocking(move || {
        let path = agent_catalog_path()?;
        agent_catalog::delete_custom_agent(&path, &id)?;
        agent_catalog::list_agents(&path)
    })
    .await
}
