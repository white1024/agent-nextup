//! The human's hands, for unattended E2E runs — a stand-in for the GUI.
//!
//! Several steps of a real Agent NextUp workflow are deliberately **not** reachable
//! from the agent hub: routing a delivery to another workspace (09 §5),
//! archiving a task (which is what folds its delta specs, D79), confirming a
//! `manual_confirm` gate, and marking someone's work verified. Those are the
//! user's, done in the app. That is a product decision, not a gap.
//!
//! It also means a multi-workspace E2E cannot run without a human sitting
//! there — unless something plays the GUI's part. That is all this binary is.
//! **Every subcommand mirrors one thing a user does in the app**, calling the
//! same core function the Tauri command calls, so the run stays faithful and
//! the audit can still tell the two roles apart:
//!
//! - agents act over the real MCP stdio path, and their calls are ledgered as
//!   `agent_tool_called` with an actor;
//! - this binary acts as the human, and the four guarded tools therefore never
//!   need to be in any workspace's `agent_access.json` — so "no agent ever
//!   verified its own work or forced a gate" is provable from disk afterwards,
//!   which is stronger than the single-workspace e2e (which grants everything).
//!
//! Not a product surface, not shipped, not a migration path. Test scaffolding.
//! It never writes `~/.nextup/teams.json` unless you point it there: the teams
//! file is an explicit argument precisely so a test run leaves the user's own
//! app-level state untouched.
//!
//! Usage:
//!   gui_stand_in team-create <teams.json> <name>
//!   gui_stand_in team-add    <teams.json> <team-id> <workspace-root>
//!   gui_stand_in team-edge   <teams.json> <team-id> <from-ws-id> <to-ws-id> [auto]
//!   gui_stand_in set-prime   <teams.json> <team-id> [workspace-root]
//!   gui_stand_in module      <workspace-root> <module-id> <on|off>
//!   gui_stand_in register    <registry.json> <workspace-root>
//!   gui_stand_in route       <teams.json> <team-id> <upstream-root> <envelope-id> [--auto] [--keep-pending]
//!   gui_stand_in verify      <workspace-root> <task-id> <evidence-note>
//!   gui_stand_in archive     <workspace-root> <task-id>
//!   gui_stand_in confirm     <workspace-root> <phase-id> <prompt>
//!
//! Every subcommand prints one JSON object on stdout; exit 1 on failure.

use std::path::{Path, PathBuf};

use nextup_core::error::Result;
use nextup_core::workspace::layout::WorkspacePaths;
use nextup_core::workspace::{exchange, init, modules, ops, registry, teams, workflow};

/// Matches `init_blank`, so a workspace built by one and driven by the other
/// carries a single app version through its fingerprints and handoff stamps.
const APP_VERSION: &str = "0.1.0";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().map(String::as_str) else {
        eprintln!("{}", USAGE);
        std::process::exit(2);
    };
    let rest = &args[1..];

    let outcome = match cmd {
        "team-create" => team_create(rest),
        "team-add" => team_add(rest),
        "team-edge" => team_edge(rest),
        "set-prime" => set_prime(rest),
        "module" => module(rest),
        "register" => register(rest),
        "route" => route(rest),
        "verify" => verify(rest),
        "archive" => archive(rest),
        "confirm" => confirm(rest),
        other => {
            eprintln!("unknown subcommand '{other}'\n{USAGE}");
            std::process::exit(2);
        }
    };

    match outcome {
        Ok(json) => println!("{json}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

const USAGE: &str = "usage: gui_stand_in <team-create|team-add|team-edge|set-prime|module|register|route|verify|archive|confirm> ...";

/// Bail with the same shape as a core error so callers see one error channel.
fn need(args: &[String], n: usize, what: &str) -> Vec<String> {
    if args.len() < n {
        eprintln!("expected {n} argument(s): {what}");
        std::process::exit(2);
    }
    args.to_vec()
}

fn json_escape(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

// ── Team graph (the team view) ──────────────────────────────────────────────

fn team_create(args: &[String]) -> Result<String> {
    let a = need(args, 2, "<teams.json> <name>");
    let team = teams::create_team(Path::new(&a[0]), &a[1])?;
    Ok(format!("{{\"id\":{},\"name\":{}}}", json_escape(&team.id), json_escape(&team.name)))
}

/// Mirrors the `team_add_member` command exactly, including its two side
/// effects — minting the workspace's stable id, and switching the team module
/// on with the *synced* variant so the STATE block and the module guide land
/// with it (D82). Doing less here would make the run diverge from the app on
/// the very surface the test is checking.
fn team_add(args: &[String]) -> Result<String> {
    let a = need(args, 3, "<teams.json> <team-id> <workspace-root>");
    let root = a[2].trim();
    let paths = WorkspacePaths::new(root);
    let context = init::open_workspace(paths.root())?;
    let workspace_id = ops::ensure_workspace_id(&paths, APP_VERSION)?;
    if !modules::get_modules(&paths)?.is_enabled(modules::MODULE_TEAM) {
        modules::set_module_enabled_synced(&paths, modules::MODULE_TEAM, true, APP_VERSION)?;
    }
    teams::add_member(
        Path::new(&a[0]),
        &a[1],
        teams::TeamMember {
            workspace_id: workspace_id.clone(),
            root: root.to_string(),
            name: context.name.clone(),
        },
    )?;
    Ok(format!(
        "{{\"workspaceId\":{},\"name\":{}}}",
        json_escape(&workspace_id),
        json_escape(&context.name)
    ))
}

fn team_edge(args: &[String]) -> Result<String> {
    let a = need(args, 4, "<teams.json> <team-id> <from-ws-id> <to-ws-id> [auto]");
    let path = Path::new(&a[0]);
    let auto = a.get(4).map(|s| s == "auto" || s == "true").unwrap_or(false);
    teams::add_edge(path, &a[1], &a[2], &a[3])?;
    if auto {
        teams::set_edge_auto_route(path, &a[1], &a[2], &a[3], true)?;
    }
    Ok(format!("{{\"from\":{},\"to\":{},\"autoRoute\":{auto}}}", json_escape(&a[2]), json_escape(&a[3])))
}

/// The user designating a team's prime from the team view header (D117).
/// This is the half of the two-key grant the prime cannot give itself
/// (21 §4.2), so a run that let an agent do it would be testing nothing.
/// Mirrors `team_set_prime` including its D119 side effect — the designation
/// switches the `prime` module on (synced variant, D82), because a prime whose
/// module is off is the same silent black hole a member without `team` is.
/// **Enabling grants nothing**: every prime tool stays `guarded`.
/// Omit the root to clear the designation.
fn set_prime(args: &[String]) -> Result<String> {
    let a = need(args, 2, "<teams.json> <team-id> [workspace-root]");
    match a.get(2).map(|r| r.trim()).filter(|r| !r.is_empty()) {
        Some(root) => {
            let p = teams::designate_prime(Path::new(&a[0]), &a[1], root, APP_VERSION)?;
            Ok(format!(
                "{{\"workspaceId\":{},\"name\":{}}}",
                json_escape(&p.workspace_id),
                json_escape(&p.name)
            ))
        }
        None => {
            teams::set_prime(Path::new(&a[0]), &a[1], None)?;
            Ok("{\"cleared\":true}".to_string())
        }
    }
}

/// The user flipping a switch on the workspace's Modules page. Synced variant
/// (D82) because that is what the app does: a module switch changes the
/// takeover surface — the module-guide line in the STATE block and the guide
/// file itself.
fn module(args: &[String]) -> Result<String> {
    let a = need(args, 3, "<workspace-root> <module-id> <on|off>");
    let on = matches!(a[2].as_str(), "on" | "true" | "1");
    let paths = WorkspacePaths::new(a[0].trim());
    modules::set_module_enabled_synced(&paths, &a[1], on, APP_VERSION)?;
    Ok(format!("{{\"module\":{},\"enabled\":{on}}}", json_escape(&a[1])))
}

/// The registry pointer the app writes every time it opens or initializes a
/// workspace (`record_recent` in commands.rs). A headless `init_blank` never
/// takes that path, so without this the fixture exists on disk but not in the
/// project list — and `team_add_member`, whose contract is "a workspace the
/// registry already knows", has nothing to find.
fn register(args: &[String]) -> Result<String> {
    let a = need(args, 2, "<registry.json> <workspace-root>");
    let root = a[1].trim();
    let context = init::open_workspace(WorkspacePaths::new(root).root())?;
    registry::record_workspace(Path::new(&a[0]), root, &context.name, &context.domain)?;
    Ok(format!(
        "{{\"root\":{},\"name\":{}}}",
        json_escape(root),
        json_escape(&context.name)
    ))
}

// ── Sending (the team view's send step) ─────────────────────────────────────

/// Route one outbox envelope along **the graph**, not along a hand-written
/// destination list: destinations are the downstream ends of the upstream's
/// edges in this team, which is what the send step offers the user. Passing
/// roots directly would let a test deliver along an edge that does not exist.
fn route(args: &[String]) -> Result<String> {
    let a = need(args, 4, "<teams.json> <team-id> <upstream-root> <envelope-id> [--auto] [--keep-pending]");
    let flags: Vec<&str> = a[4..].iter().map(String::as_str).collect();
    let opts = exchange::RouteOptions {
        auto: flags.contains(&"--auto"),
        keep_pending: flags.contains(&"--keep-pending"),
        // This binary stands in for the human pressing send (D86).
        actor: None,
    };

    let upstream_root = a[2].trim();
    let file = teams::load_teams(Path::new(&a[0]))?;
    let team = file
        .teams
        .iter()
        .find(|t| t.id == a[1])
        .ok_or_else(|| nextup_core::error::NextUpError::NotFound(format!("no team {}", a[1])))?;

    let upstream_id = team
        .members
        .iter()
        .find(|m| same_path(&m.root, upstream_root))
        .map(|m| m.workspace_id.clone())
        .ok_or_else(|| {
            nextup_core::error::NextUpError::NotFound(format!(
                "{upstream_root} is not a member of team {}",
                team.name
            ))
        })?;

    let destinations: Vec<exchange::RouteDestination> = team
        .edges
        .iter()
        .filter(|e| e.from == upstream_id)
        .filter_map(|e| team.members.iter().find(|m| m.workspace_id == e.to))
        .map(|m| exchange::RouteDestination {
            root: PathBuf::from(&m.root),
            team_id: team.id.clone(),
            team_name: team.name.clone(),
        })
        .collect();

    let outcome = exchange::route_delivery(
        &WorkspacePaths::new(upstream_root),
        APP_VERSION,
        &a[3],
        &destinations,
        opts,
    )?;
    Ok(serde_json::to_string(&outcome).unwrap_or_else(|_| "{}".into()))
}

/// Roots are display caches typed by a human in the app; compare them the way
/// the frontend's `sameRoot` does rather than byte-for-byte.
fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

// ── The three human-only workspace actions ──────────────────────────────────

/// The user ticking "verified" on a done task, with the evidence note the UI
/// requires. Guarded as `self_verify` on the hub for exactly this reason: the
/// worker does not get to declare its own work checked.
fn verify(args: &[String]) -> Result<String> {
    let a = need(args, 3, "<workspace-root> <task-id> <evidence-note>");
    let paths = WorkspacePaths::new(a[0].trim());
    let update = ops::set_task_verification(&paths, APP_VERSION, &a[1], true, Some(a[2].clone()))?;
    Ok(format!(
        "{{\"id\":{},\"verifiedAt\":{},\"note\":{}}}",
        json_escape(&update.task.id),
        json_escape(update.task.verified_at.as_deref().unwrap_or("")),
        json_escape(update.task.verified_note.as_deref().unwrap_or(""))
    ))
}

/// The user archiving a done task — which is also the only trigger that folds
/// the task's delta specs into `specs/` (D79). The fold summary is echoed
/// because it is the thing worth auditing, not the archive flag.
fn archive(args: &[String]) -> Result<String> {
    let a = need(args, 2, "<workspace-root> <task-id>");
    let paths = WorkspacePaths::new(a[0].trim());
    let update = ops::set_task_archived(&paths, APP_VERSION, &a[1], true)?;
    let fold = match &update.spec_fold {
        Some(s) => serde_json::to_string(s).unwrap_or_else(|_| "null".into()),
        None => "null".into(),
    };
    Ok(format!("{{\"id\":{},\"archived\":true,\"specFold\":{fold}}}", json_escape(&update.task.id)))
}

/// The user pressing confirm on a `manual_confirm` exit gate. Note what is
/// *not* here: forcing an advance past a failing gate. That override exists in
/// the app, but giving the harness a way to reach it would quietly turn the
/// one gate this test is meant to prove into a formality.
fn confirm(args: &[String]) -> Result<String> {
    let a = need(args, 3, "<workspace-root> <phase-id> <prompt>");
    let paths = WorkspacePaths::new(a[0].trim());
    let status = workflow::confirm_gate(&paths, &a[1], &a[2])?;
    Ok(format!(
        "{{\"phase\":{},\"confirmations\":{},\"canAdvance\":{}}}",
        json_escape(&status.workflow.state.current_phase),
        status.workflow.state.confirmations.len(),
        status.can_advance
    ))
}
