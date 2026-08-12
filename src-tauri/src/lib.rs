mod commands;
mod git;
mod mcp_deploy;
mod terminal;
mod watcher;

use std::sync::Arc;

use nextup_core::security::keystore::OsKeyringProvider;
use nextup_core::state::AppState;
use tauri::Manager as _;

use commands::{TerminalState, WatcherState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::new(Arc::new(OsKeyringProvider::default()));

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(WatcherState::default())
        // The terminal manager needs an AppHandle for its event sink, so it
        // is managed in setup (runs before any IPC can arrive).
        .setup(|app| {
            let handle = tauri::AppHandle::clone(app.handle());
            let sink = Box::new(move |ev| terminal::emit_event(&handle, ev));
            // Persist terminal sessions across app restarts (B16-A) when the
            // home dir resolves; without it, sessions are in-memory only.
            let mgr = match terminal::default_persist_dir() {
                Some(dir) => {
                    let mgr = terminal::TerminalManager::new_persistent(sink, dir);
                    mgr.start_persist_loop();
                    mgr
                }
                None => terminal::TerminalManager::new(sink),
            };
            app.manage(TerminalState(mgr));
            Ok(())
        })
        // Sections and order mirror commands.rs exactly — keep them aligned
        // so a diff review can spot a forgotten registration at a glance.
        .invoke_handler(tauri::generate_handler![
            // ── System ──
            commands::system_status,
            commands::git_available,
            // ── Workspace lifecycle ──
            commands::initialize_project,
            commands::probe_init_target,
            commands::open_workspace,
            commands::close_workspace,
            // ── Tasks ──
            commands::list_tasks,
            commands::create_task,
            commands::update_task_status,
            commands::set_task_archived,
            commands::edit_task,
            commands::delete_task,
            commands::archive_verified_done_tasks,
            commands::auto_archive_sweep,
            commands::specs_overview,
            commands::spec_content,
            commands::pending_spec_folds,
            commands::get_workspace_settings,
            commands::set_workspace_settings,
            commands::set_task_verification,
            commands::assign_task,
            // ── Handoff & ledger ──
            commands::read_handoff,
            commands::generate_handoff_now,
            commands::recent_events,
            commands::ledger_history,
            commands::ledger_since,
            commands::add_ledger_note,
            // ── Workflow harness ──
            commands::list_templates,
            commands::get_template,
            commands::save_custom_template,
            commands::delete_custom_template,
            commands::workflow_status,
            commands::advance_phase,
            commands::confirm_gate,
            commands::adopt_workflow,
            // ── AI-session bootstrap layer ──
            commands::scaffold_bootstrap,
            commands::workspace_assets_status,
            commands::workspace_assets_upgrade,
            // ── Secrets ──
            commands::list_secret_names,
            commands::set_secret,
            commands::delete_secret,
            // ── Backup ──
            commands::export_backup,
            commands::import_backup,
            // ── Agent hub access ──
            commands::agent_access_status,
            commands::agent_access_set_enabled,
            commands::agent_access_set_tool,
            commands::agent_access_set_tools,
            commands::agent_access_set_all_tools,
            // ── Capability modules (D31) ──
            commands::modules_get,
            commands::module_set_enabled,
            commands::agent_mcp_status,
            commands::agent_mcp_repair,
            // ── Full-text index ──
            commands::build_search_index,
            commands::search_index,
            commands::search_index_status,
            // ── Context & milestones ──
            commands::get_context,
            commands::add_milestone,
            commands::set_milestone_done,
            commands::set_milestone_verified,
            commands::remove_milestone,
            // ── Doctor ──
            commands::run_doctor,
            // ── Workspace registry & legacy adoption ──
            commands::recent_workspaces,
            commands::remove_recent_workspace,
            commands::draft_legacy_adoption,
            commands::adopt_legacy_project,
            // ── Teams & cross-workspace exchange (D48) ──
            commands::teams_list,
            commands::team_create,
            commands::team_rename,
            commands::team_delete,
            commands::team_add_member,
            commands::team_remove_member,
            commands::team_set_prime,
            commands::team_rebind_workspace,
            commands::team_set_layout,
            commands::team_add_edge,
            commands::team_remove_edge,
            commands::team_set_edge_auto_route,
            commands::team_route_delivery,
            commands::exchange_list,
            commands::exchange_get,
            commands::exchange_publish,
            // ── Embedded terminal (D50) ──
            commands::terminal_launch,
            commands::terminal_revive,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
            commands::terminal_list,
            commands::terminal_read_buffer,
            commands::terminal_shutdown,
            commands::terminal_set_popped_out,
            commands::agent_catalog_list,
            commands::agent_catalog_save,
            commands::agent_catalog_delete,
            commands::quit_app,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        eprintln!("fatal: Agent NextUp failed to start: {e}");
        std::process::exit(1);
    }
}

/// Three hand-maintained mirrors of `LedgerKind` live in the frontend: the
/// `ledger.*` i18n families (zh-TW and en) and the `LedgerKind` union in
/// types.ts. None of them had a lock before D75 — the D48 delivery kinds made
/// it into i18n (after the D71 review caught them missing) but never into the
/// type union, and a missing i18n key renders as the raw "ledger.xxx" literal
/// in the Ledger view. This pins all three mirrors to the Rust enum, so adding
/// a ledger kind fails the app build until every surface knows about it.
#[cfg(test)]
mod ledger_kind_mirror_tests {
    use nextup_core::workspace::ledger::LedgerKind;

    const I18N: &str = include_str!("../../src/i18n.ts");
    const TYPES: &str = include_str!("../../src/types.ts");

    /// The `ledger: {` family bodies in i18n.ts — one per language.
    fn ledger_families(source: &str) -> Vec<&str> {
        source
            .match_indices("\n  ledger: {")
            .map(|(start, _)| {
                let body = &source[start..];
                let end = body[1..].find("\n  }").expect("ledger family must close") + 1;
                &body[..end]
            })
            .collect()
    }

    #[test]
    fn every_ledger_kind_has_an_i18n_label_in_both_languages() {
        let families = ledger_families(I18N);
        assert_eq!(families.len(), 2, "expected a zh-TW and an en `ledger.*` family");
        for family in families {
            for kind in LedgerKind::ALL {
                assert!(
                    family.contains(&format!("{}:", kind.as_str())),
                    "a `ledger.*` i18n family is missing `{}` — the Ledger chip would \
                     render the raw key for it",
                    kind.as_str()
                );
            }
        }
    }

    #[test]
    fn every_ledger_kind_is_in_the_frontend_type_union() {
        for kind in LedgerKind::ALL {
            assert!(
                TYPES.contains(&format!("\"{}\"", kind.as_str())),
                "types.ts LedgerKind union is missing \"{}\" (the D48 delivery kinds \
                 sat outside it for three decision generations before this lock)",
                kind.as_str()
            );
        }
    }
}

/// The app version is declared in two files and both have a real consumer, so
/// neither can be deleted in favour of the other:
///
/// - the workspace `Cargo.toml`, inherited by all three crates. That is what
///   `APP_VERSION` stamps into every managed workspace's handoff snapshot and
///   asset-upgrade ledger entry — from the app and from the hub alike.
/// - `tauri.conf.json`, which names the installers and, through tauri-build,
///   writes the Windows executable's FileVersion/ProductVersion resource.
///
/// The config schema says `version` falls back to Cargo.toml when removed, but
/// that fallback is only implemented for the runtime `PackageInfo`
/// (tauri-codegen). tauri-build's Windows resource block reads `config.version`
/// with no else branch, so dropping the field ships an executable whose version
/// properties are blank — and nothing reports it. Hence both files stay and
/// this pins them together instead: a half-finished bump fails `cargo test`
/// rather than surfacing later as an installer filename that disagrees with the
/// version the app writes to disk. That matters more once the updater lands,
/// since it decides whether to update by comparing exactly these numbers.
///
/// package.json is checked too. Nothing reads it (the package is `private` and
/// is never published), but it is the version pnpm prints on every script run,
/// so leaving it as the one copy free to rot would just relocate the problem.
#[cfg(test)]
mod version_mirror_tests {
    const TAURI_CONF: &str = include_str!("../tauri.conf.json");
    const PACKAGE_JSON: &str = include_str!("../../package.json");

    fn declared_version(source: &str, what: &str) -> String {
        let value: serde_json::Value = serde_json::from_str(source)
            .unwrap_or_else(|e| panic!("{what} is not valid JSON: {e}"));
        value
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("{what} has no top-level string `version` field"))
            .to_string()
    }

    #[test]
    fn every_declared_version_matches_the_workspace_one() {
        // src-tauri carries `version.workspace = true`, so this is the value in
        // the workspace Cargo.toml — the single Rust-side declaration.
        let cargo = env!("CARGO_PKG_VERSION");

        for (file, source) in [
            ("tauri.conf.json", TAURI_CONF),
            ("package.json", PACKAGE_JSON),
        ] {
            assert_eq!(
                declared_version(source, file),
                cargo,
                "{file} declares a different version from the workspace Cargo.toml \
                 ({cargo}) — bump every declaration together, or the installer, the \
                 executable's version resource and the version stamped into managed \
                 workspaces stop agreeing"
            );
        }
    }
}
