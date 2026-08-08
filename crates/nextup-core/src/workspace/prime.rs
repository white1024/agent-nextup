//! Read side of the prime orchestrator role (D116, nextup_docs/21).
//!
//! A prime coordinates its team by *looking* at its members and by moving
//! envelopes between them. Since [D120] it looks at all of them: task text,
//! ledger, decisions and specs, not just counts — the user's call, so that the
//! role reads like the human one it replaces.
//!
//! # Two layers, and only one of them is a boundary
//!
//! [`MemberStatus`] is the **summary**: counts, phase, mailbox sizes, nothing
//! from inside. It stays that shape — `team_overview` fans out across every
//! member of every team and must not pull each one's prose into memory to
//! answer "who is busy". `serialized_summary_exposes_no_prose` enforces that,
//! and it is now a statement about *this type's job*, not about what a prime
//! is permitted to know.
//!
//! Detail goes through [`member_paths`], one member at a time, asked for by
//! name. That split is the whole design: cheap and blind by default, complete
//! when you say which member and what you want.
//!
//! # What survived the opening
//!
//! D116 rejected a prime that could read everything, and one of the four
//! reasons is still true: a prime reads its members and writes the graph, so
//! text sitting in any member can reach every other one with no human in the
//! loop. The isolation was never actually the defence there — a prime that
//! dispatches a sub-agent (21 §2.1) could always read everything. **The
//! defence was the trace**, and that is what [`note_prime_read`] keeps: a
//! detail read lands in the *member's own* ledger, the same way a routed
//! delivery lands in both. What is refused is silent omniscience; the reading
//! itself never was the point.
//!
//! [D120]: ../../../../nextup_docs/decisions/D120.md

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::workspace::exchange::{list_deliveries, DeliveryBox, NoteDetail};
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::modules::{get_modules, MODULE_TEAM};
use crate::workspace::tasks::{counts_for_dir, TaskCounts};
use crate::workspace::teams::{Team, TeamMember};
use crate::workspace::workflow::load_workflow;

/// One member of a team, as far as its prime is allowed to see.
///
/// Every field is either a number, a flag, or an identifier the team graph
/// already stores. See the module docs before adding one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemberStatus {
    pub workspace_id: String,
    pub name: String,
    pub root: String,
    /// False when the folder is missing or offline — reported, never silently
    /// dropped (same stance as the registry overview).
    pub exists: bool,
    /// Whether the member has the `team` module on. Off means it cannot see
    /// its own inbox — envelopes still arrive (`route_delivery` has no module
    /// gate), so a prime routing to it should know.
    pub team_module_on: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_counts: Option<TaskCounts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_phase_title: Option<String>,
    #[serde(default)]
    pub workflow_completed: bool,
    /// Envelopes sitting in the member's outbox — what a prime would route.
    pub pending_outbox: usize,
    /// Envelopes delivered to the member and not yet turned into anything.
    pub inbox_count: usize,
}

/// Summarize one team member. Unreadable parts degrade to `None`/zero rather
/// than failing the whole call — a detached drive must not blind the prime to
/// the rest of the team.
pub fn member_status(member: &TeamMember) -> MemberStatus {
    let paths = WorkspacePaths::new(&member.root);
    let exists = paths.is_initialized();
    let workflow = if exists { load_workflow(&paths.workflow_file()).ok() } else { None };

    MemberStatus {
        workspace_id: member.workspace_id.clone(),
        name: member.name.clone(),
        root: member.root.clone(),
        exists,
        team_module_on: exists
            && get_modules(&paths).map(|m| m.is_enabled(MODULE_TEAM)).unwrap_or(false),
        task_counts: if exists { counts_for_dir(&paths.tasks_dir()).ok() } else { None },
        current_phase: workflow.as_ref().map(|w| w.state.current_phase.clone()),
        current_phase_title: workflow.as_ref().and_then(|w| {
            w.phases.iter().find(|p| p.id == w.state.current_phase).map(|p| p.title.clone())
        }),
        workflow_completed: workflow.map(|w| w.state.completed).unwrap_or(false),
        pending_outbox: count_box(&paths, exists, DeliveryBox::Outbox),
        inbox_count: count_box(&paths, exists, DeliveryBox::Inbox),
    }
}

/// Every member of `team`, in membership order.
pub fn team_status(team: &Team) -> Vec<MemberStatus> {
    team.members.iter().map(member_status).collect()
}

/// The teams `workspace_id` is prime of. Authority is per team (21 §4.1), so
/// this is also the full extent of what its app-level tools may touch.
pub fn teams_primed_by(teams: &[Team], workspace_id: &str) -> Vec<Team> {
    teams.iter().filter(|t| is_prime_of(t, workspace_id)).cloned().collect()
}

/// Whether `workspace_id` coordinates `team`. The prime is not in `members`
/// (D117), so this is the only way to ask — membership answers a different
/// question and answering it here is what put the prime on the canvas.
pub fn is_prime_of(team: &Team, workspace_id: &str) -> bool {
    team.prime.as_ref().is_some_and(|p| p.workspace_id == workspace_id)
}

/// One member's workspace, opened for a detail read (D120).
///
/// Refuses a member whose folder is not there rather than reading an empty
/// workspace: the summary reports `exists: false` because it fans out over
/// everyone and one detached drive must not blind the whole overview, but a
/// call that named *this* member wants to hear that it is gone.
pub fn member_paths(member: &TeamMember) -> Result<WorkspacePaths> {
    let paths = WorkspacePaths::new(&member.root);
    if !paths.nextup_dir().is_dir() {
        return Err(crate::error::NextUpError::NotFound(format!(
            "member \"{}\" is not readable at {} — the folder may have moved or its disk is offline",
            member.name, member.root
        )));
    }
    Ok(paths)
}

/// Write a prime's detail read into *the member's own* ledger (D120).
///
/// Reading inside a member was never blocked by reach — this module has always
/// opened member workspaces. It was blocked so that a member could not be read
/// without knowing. Opening the read keeps that by leaving the line here,
/// exactly as a routed delivery leaves one on both sides.
///
/// Best-effort on purpose: a read-only member folder should still answer the
/// question. The prime's own hub ledgers the call regardless, so the attempt is
/// never invisible in both places at once.
pub fn note_prime_read(paths: &WorkspacePaths, tool: &str, actor: Option<&str>, what: &str) {
    let who = actor.unwrap_or("an unnamed agent");
    let _ = crate::workspace::ledger::ledger_for(paths).append(
        &crate::workspace::ledger::LedgerEvent::new(
            crate::workspace::ledger::LedgerKind::AgentToolCalled,
            format!("{what} read by the team coordinator (by prime {who})"),
            None,
        )
        .with_actor(actor.map(str::to_string))
        .with_call(tool, crate::workspace::ledger::CallOutcome::Ok),
    );
}

fn count_box(paths: &WorkspacePaths, exists: bool, mailbox: DeliveryBox) -> usize {
    if !exists {
        return 0;
    }
    // Brief notes are discarded here — only the count is used, and asking for
    // full ones would pull member prose into this call's memory for nothing.
    list_deliveries(paths, mailbox, NoteDetail::Brief).map(|rows| rows.len()).unwrap_or(0)
}

/// The authority gate for every app-level prime tool (21 §4.2).
///
/// Two keys, and this checks the second one: the `prime` module switch says
/// this workspace wants to coordinate, `Team.prime` says which teams it may.
/// Neither grants anything alone — a workspace with the module on and no
/// designation reaches exactly nothing, which is what makes "app-level" here
/// mean *these* teams rather than every team on the machine.
///
/// Returns the team so callers do not load it twice.
pub fn authorize_team(
    teams_path: &std::path::Path,
    team_id: &str,
    workspace_id: &str,
) -> Result<Team> {
    let team = crate::workspace::teams::load_teams(teams_path)?
        .teams
        .into_iter()
        .find(|t| t.id == team_id)
        .ok_or_else(|| {
            crate::error::NextUpError::NotFound(format!("no team with id {team_id}"))
        })?;
    if !is_prime_of(&team, workspace_id) {
        return Err(crate::error::NextUpError::InvalidInput(format!(
            "this workspace is not the prime of team \"{}\" — a human designates the prime in Agent NextUp",
            team.name
        )));
    }
    Ok(team)
}

/// The calling workspace's own stable id, which every gate above is keyed on.
/// Absent means the workspace never joined a team, so it cannot be anyone's
/// prime either.
pub fn own_workspace_id(paths: &WorkspacePaths) -> Result<String> {
    crate::workspace::context::load_context(&paths.context_file())?.workspace_id.ok_or_else(|| {
        crate::error::NextUpError::InvalidInput(
            "this workspace has no stable id yet — it has never joined a team".into(),
        )
    })
}

/// Resolve the app-level team store, then answer the whole read side for one
/// prime workspace: which teams it runs, and how each member is doing.
pub fn overview_for_prime(
    teams_path: &std::path::Path,
    workspace_id: &str,
) -> Result<Vec<(Team, Vec<MemberStatus>)>> {
    let teams = crate::workspace::teams::load_teams(teams_path)?.teams;
    Ok(teams_primed_by(&teams, workspace_id)
        .into_iter()
        .map(|team| {
            let statuses = team_status(&team);
            (team, statuses)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::workspace::init::{initialize_project, InitProjectParams};
    use crate::workspace::teams;

    fn workspace(root: &std::path::Path, name: &str) -> TeamMember {
        let params = InitProjectParams {
            root: root.to_string_lossy().into_owned(),
            name: name.into(),
            domain: "coding".into(),
            modules: vec![MODULE_TEAM.into()],
            create_root: true,
            ..Default::default()
        };
        let ctx = initialize_project(&params, &StaticKeyProvider([7u8; 32]), "0.1.0").unwrap();
        TeamMember {
            workspace_id: ctx.workspace_id.unwrap(),
            root: params.root,
            name: ctx.name,
        }
    }

    /// The isolation boundary, asserted on the wire shape rather than by
    /// reading the struct: adding a field that carries member prose has to
    /// change this list, which is the moment to re-read D116 ④.
    #[test]
    fn serialized_summary_exposes_no_prose() {
        let dir = tempfile::tempdir().unwrap();
        let member = workspace(&dir.path().join("alpha"), "alpha");

        let json = serde_json::to_value(member_status(&member)).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();

        assert_eq!(
            keys,
            [
                "currentPhase",
                "currentPhaseTitle",
                "exists",
                "inboxCount",
                "name",
                "pendingOutbox",
                "root",
                "taskCounts",
                "teamModuleOn",
                "workflowCompleted",
                "workspaceId",
            ],
            "a prime sees counts and phase — never task bodies, decisions or ledger lines"
        );

        // taskCounts is the one nested object; it must be numbers only.
        let counts = json.get("taskCounts").unwrap().as_object().unwrap();
        assert!(
            counts.values().all(|v| v.is_number()),
            "task detail must never ride in on the counts"
        );
    }

    #[test]
    fn a_missing_folder_is_reported_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let present = workspace(&dir.path().join("alpha"), "alpha");
        let gone = TeamMember {
            workspace_id: "ghost".into(),
            root: dir.path().join("not-here").to_string_lossy().into_owned(),
            name: "ghost".into(),
        };

        let rows = [member_status(&present), member_status(&gone)];
        assert!(rows[0].exists);
        assert!(!rows[1].exists, "an offline drive must not blind the prime to the rest");
        assert_eq!(rows[1].task_counts, None);
        assert_eq!(rows[1].pending_outbox, 0);
    }

    #[test]
    fn only_the_teams_this_workspace_is_prime_of_come_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("teams.json");
        let boss = workspace(&dir.path().join("boss"), "boss");
        let worker = workspace(&dir.path().join("worker"), "worker");
        let helper = workspace(&dir.path().join("helper"), "helper");

        // Coordinates `runs` from outside it; an ordinary member of `joins`.
        // Both seats at once, in different teams — authority is per team.
        let runs = teams::create_team(&path, "runs this").unwrap();
        teams::add_member(&path, &runs.id, worker.clone()).unwrap();
        teams::add_member(&path, &runs.id, helper.clone()).unwrap();
        teams::set_prime(&path, &runs.id, Some(boss.clone())).unwrap();

        let joins = teams::create_team(&path, "just a member").unwrap();
        teams::add_member(&path, &joins.id, boss.clone()).unwrap();
        teams::add_member(&path, &joins.id, worker.clone()).unwrap();

        let seen = overview_for_prime(&path, &boss.workspace_id).unwrap();
        assert_eq!(seen.len(), 1, "membership in another team grants nothing there");
        assert_eq!(seen[0].0.id, runs.id);
        assert_eq!(seen[0].1.len(), 2, "the members it coordinates");
        assert!(
            !seen[0].1.iter().any(|s| s.workspace_id == boss.workspace_id),
            "and never itself — a prime outside the flow has no row in its own roster (D117)"
        );
    }

    #[test]
    fn mailbox_counts_track_the_outbox() {
        let dir = tempfile::tempdir().unwrap();
        let member = workspace(&dir.path().join("alpha"), "alpha");
        let paths = WorkspacePaths::new(&member.root);
        assert_eq!(member_status(&member).pending_outbox, 0);

        crate::workspace::exchange::publish_delivery(
            &paths,
            "0.1.0",
            Some("ready for review".into()),
            &[],
            Default::default(),
        )
        .unwrap();
        assert_eq!(member_status(&member).pending_outbox, 1, "what a prime would route");
        assert_eq!(member_status(&member).inbox_count, 0);
    }
}
