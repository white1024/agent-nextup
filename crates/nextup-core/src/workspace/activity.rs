//! Cross-project agent activity for the overview surfaces (D155).
//!
//! The project overview and the agent overview show what agents are doing in
//! *every* registered workspace at once: a live call stream, per-card "just
//! now", a waveform, a count of calls today and the denials still waiting
//! for a person. Until this module only the open workspace's ledger was ever
//! read, so none of that was answerable.
//!
//! Two constraints shape it:
//!
//! - **The cost must not grow with history.** These surfaces read every
//!   project on a timer. Each read is [`Ledger::tail_window`] — a fixed byte
//!   budget from the end — so a project with years of ledger costs the same
//!   as a new one. Anything that needs the full history is not this module's
//!   question (invariant 16, same concern).
//! - **One unreadable project must not sink the read.** Same policy as the
//!   GUI's cross-workspace mailbox reads (`lib/exchange.ts`): a project that
//!   fails comes back with empty rows and its message, never an error for
//!   the whole call.
//!
//! Read-only: nothing here writes to any workspace.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use crate::agent;
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::ledger::{CallOutcome, Ledger, LedgerEvent, LedgerKind};
use crate::workspace::registry::load_registry;

/// Bytes read from the end of each project's ledger. A ledger line runs a few
/// hundred bytes, so this is several hundred lines — far more than a stream of
/// nine rows or a twelve-second waveform needs, and still a constant.
pub const ACTIVITY_WINDOW_BYTES: u64 = 128 * 1024;

/// Most recent hub calls returned per project. The stream shows nine rows in
/// total and the waveform twelve seconds; this leaves room for both without
/// shipping the whole window over IPC on every poll.
pub const ACTIVITY_CALLS_MAX: usize = 40;

/// How long a denial keeps counting as "waiting for you" while the tool stays
/// unauthorized. The toast is announced only within five minutes (D62); the
/// standing marker outlives the toast — the spec wants the amber to stay after
/// the toast is dismissed — but not forever: an agent that hit a wall an hour
/// ago and got no answer has long since moved on or ended.
pub const WAITING_FRESH_MINUTES: i64 = 30;

/// One hub call, as the overview draws it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCall {
    pub at: String,
    /// Self-declared identity (D31). Display only, never an authorization input.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    /// Absent only on pre-D75 lines, which never carried the field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<CallOutcome>,
    /// What the call did, in words: the last semantic event the same actor
    /// wrote since its previous call. The hub writes an op's own events
    /// *before* the audit line, so those are the ones between the two. Absent
    /// for reads, which write nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

/// A denied call nobody has answered yet. One per actor and tool — an agent
/// retrying the same call is still one thing waiting.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaitingCall {
    /// The latest denial of this actor and tool.
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    pub tool: String,
}

/// One project's recent agent activity.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActivity {
    pub root: String,
    /// Newest last, at most [`ACTIVITY_CALLS_MAX`].
    pub calls: Vec<AgentCall>,
    /// Hub calls at or after the caller's `since` inside the window.
    pub calls_since: usize,
    /// The window ran out before reaching `since`, so `calls_since` is a
    /// floor rather than a total.
    pub capped: bool,
    pub waiting: Vec<WaitingCall>,
    /// Why this project could not be read; rows are empty when set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ProjectActivity {
    fn empty(root: &str) -> Self {
        Self {
            root: root.to_string(),
            calls: Vec::new(),
            calls_since: 0,
            capped: false,
            waiting: Vec::new(),
            error: None,
        }
    }
}

/// Activity for every workspace in the registry, in registry order.
///
/// `since` is the caller's start of "today" — the caller owns the time zone,
/// so the engine counts against an instant and never guesses a calendar.
pub fn registry_activity(
    registry_path: &Path,
    since: Option<DateTime<Utc>>,
) -> crate::error::Result<Vec<ProjectActivity>> {
    let registry = load_registry(registry_path)?;
    let now = Utc::now();
    Ok(registry
        .workspaces
        .iter()
        .map(|entry| project_activity(&entry.root, since, now))
        .collect())
}

/// One project's activity. Never fails: an unreadable project is reported in
/// `error` with empty rows.
pub fn project_activity(
    root: &str,
    since: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> ProjectActivity {
    let paths = WorkspacePaths::new(root);
    let mut out = ProjectActivity::empty(root);
    if !paths.context_file().is_file() {
        // A folder that is gone (detached drive, deleted) is already shown as
        // missing by the overview; it has no activity, which is not an error.
        return out;
    }
    let window = match Ledger::new(paths.ledger_file()).tail_window(ACTIVITY_WINDOW_BYTES) {
        Ok(w) => w,
        Err(e) => {
            out.error = Some(e.to_string());
            return out;
        }
    };
    let access = agent::get_access(&paths);

    let calls = calls_with_detail(&window.events);
    if let Some(since) = since {
        out.calls_since = calls.iter().filter(|c| parse_at(&c.at).is_some_and(|t| t >= since)).count();
        // Only a window that both left lines behind *and* is entirely inside
        // "today" can have missed some of today's calls.
        out.capped = window.truncated
            && window.events.first().and_then(|e| parse_at(&e.at)).is_some_and(|t| t >= since);
    }
    out.waiting = match access {
        Ok(access) => waiting_calls(&calls, now, |tool| agent::authorize(&access, tool).is_err()),
        // Unreadable access: nothing can be said about what is still blocked,
        // and a spurious amber marker is worse than a missing one.
        Err(e) => {
            out.error = Some(e.to_string());
            Vec::new()
        }
    };
    let skip = calls.len().saturating_sub(ACTIVITY_CALLS_MAX);
    out.calls = calls.into_iter().skip(skip).collect();
    out
}

/// The caller's `since` instant. Strict, unlike the ledger's own timestamps:
/// a malformed argument is a caller bug worth reporting, not a line to skip.
pub fn parse_since(raw: &str) -> crate::error::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|e| crate::error::NextUpError::InvalidInput(format!("since is not RFC 3339: {e}")))
}

fn parse_at(at: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at).ok().map(|t| t.with_timezone(&Utc))
}

/// Every hub call in `events`, chronological, each paired with the semantic
/// event its actor wrote since that actor's previous call.
fn calls_with_detail(events: &[LedgerEvent]) -> Vec<AgentCall> {
    // Per actor: the latest semantic line seen since that actor's last call.
    let mut pending: HashMap<Option<&str>, &LedgerEvent> = HashMap::new();
    let mut calls = Vec::new();
    for event in events {
        if event.kind == LedgerKind::AgentToolCalled {
            let semantic = pending.remove(&event.actor.as_deref());
            calls.push(AgentCall {
                at: event.at.clone(),
                actor: event.actor.clone(),
                tool: event.tool.clone(),
                outcome: event.outcome,
                detail: semantic.map(|e| e.message.clone()),
                task_id: semantic.and_then(|e| e.task_id.clone()),
            });
        } else if !event.kind.is_noise() && event.actor.is_some() {
            // Actor-less lines are the GUI's or the engine's — never a call's.
            pending.insert(event.actor.as_deref(), event);
        }
    }
    calls
}

/// Denials still waiting: fresh, still refused by the current access file, and
/// not followed by a call of the same tool from the same actor that got
/// through. `still_denied` is the live authorization check — granting the tool
/// in the catalog is what "answering" a denial means, so the marker must go
/// the moment that happens, without waiting for the agent to retry.
fn waiting_calls(
    calls: &[AgentCall],
    now: DateTime<Utc>,
    still_denied: impl Fn(&str) -> bool,
) -> Vec<WaitingCall> {
    let fresh_after = now - Duration::minutes(WAITING_FRESH_MINUTES);
    // (actor, tool) → latest denial, or None once a later call got through.
    let mut latest: Vec<((Option<&str>, &str), Option<&str>)> = Vec::new();
    for call in calls {
        let Some(tool) = call.tool.as_deref() else { continue };
        let key = (call.actor.as_deref(), tool);
        let value = match call.outcome {
            Some(CallOutcome::Denied) => Some(call.at.as_str()),
            _ => None,
        };
        match latest.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => latest.push((key, value)),
        }
    }
    latest
        .into_iter()
        .filter_map(|((actor, tool), at)| {
            let at = at?;
            let fresh = parse_at(at).is_some_and(|t| t >= fresh_after);
            (fresh && still_denied(tool)).then(|| WaitingCall {
                at: at.to_string(),
                actor: actor.map(str::to_string),
                tool: tool.to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::set_tool_allowed;
    use crate::security::keystore::StaticKeyProvider;
    use crate::workspace::init::{initialize_project, InitProjectParams};
    use crate::workspace::registry::record_workspace;

    fn at(minutes_ago: i64, now: DateTime<Utc>) -> String {
        (now - Duration::minutes(minutes_ago)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    fn call(actor: &str, tool: &str, outcome: CallOutcome, when: String) -> LedgerEvent {
        let mut e = LedgerEvent::new(LedgerKind::AgentToolCalled, format!("{tool} x"), None)
            .with_actor(Some(actor.into()))
            .with_call(tool, outcome);
        e.at = when;
        e
    }

    fn workspace(dir: &Path) -> WorkspacePaths {
        let params = InitProjectParams {
            root: dir.to_string_lossy().into_owned(),
            name: "Alpha".into(),
            domain: "coding".into(),
            ..Default::default()
        };
        initialize_project(&params, &StaticKeyProvider([7u8; 32]), "test").unwrap();
        WorkspacePaths::new(dir)
    }

    /// A call's detail is what *its own actor* wrote before it — another
    /// agent's event landing in between belongs to that other agent.
    #[test]
    fn detail_pairs_each_call_with_its_own_actors_event() {
        let now = Utc::now();
        let mut a_event = LedgerEvent::new(LedgerKind::TaskStatusChanged, "T-0001 → done", Some("T-0001".into()))
            .with_actor(Some("alpha".into()));
        a_event.at = at(1, now);
        let mut b_event = LedgerEvent::new(LedgerKind::Decision, "use sqlite", None)
            .with_actor(Some("beta".into()));
        b_event.at = at(1, now);
        let events = vec![
            a_event,
            b_event,
            call("alpha", "update_task_status", CallOutcome::Ok, at(1, now)),
            call("alpha", "list_tasks", CallOutcome::Ok, at(0, now)),
            call("beta", "record_decision", CallOutcome::Ok, at(0, now)),
        ];
        let calls = calls_with_detail(&events);
        assert_eq!(calls[0].detail.as_deref(), Some("T-0001 → done"));
        assert_eq!(calls[0].task_id.as_deref(), Some("T-0001"));
        assert_eq!(calls[1].detail, None, "a read writes nothing, so it has no detail");
        assert_eq!(calls[2].detail.as_deref(), Some("use sqlite"));
    }

    #[test]
    fn waiting_needs_fresh_unanswered_and_still_refused() {
        let now = Utc::now();
        let calls = calls_with_detail(&[
            // Stale: an hour ago.
            call("alpha", "create_task", CallOutcome::Denied, at(60, now)),
            // Retried twice: one waiting item, the latest time.
            call("beta", "create_task", CallOutcome::Denied, at(5, now)),
            call("beta", "create_task", CallOutcome::Denied, at(2, now)),
            // Denied, then got through: answered.
            call("gamma", "create_task", CallOutcome::Denied, at(4, now)),
            call("gamma", "create_task", CallOutcome::Ok, at(3, now)),
            // Denied, and the tool has since been granted.
            call("delta", "record_decision", CallOutcome::Denied, at(1, now)),
        ]);
        let waiting = waiting_calls(&calls, now, |tool| tool != "record_decision");
        assert_eq!(
            waiting,
            vec![WaitingCall { at: at(2, now), actor: Some("beta".into()), tool: "create_task".into() }]
        );
    }

    /// End to end against real files: the access file decides, and a granted
    /// tool stops waiting without the agent having to call again.
    #[test]
    fn project_activity_reads_the_tail_and_the_live_access_file() {
        let dir = tempfile::tempdir().unwrap();
        let paths = workspace(dir.path());
        let now = Utc::now();
        let ledger = Ledger::new(paths.ledger_file());
        // A guarded tool: init grants the everyday ones (create_task…) already.
        ledger.append(&call("alpha", "advance_phase", CallOutcome::Denied, at(1, now))).unwrap();
        ledger.append(&call("alpha", "list_tasks", CallOutcome::Ok, at(0, now))).unwrap();

        let root = dir.path().to_string_lossy().into_owned();
        let before = project_activity(&root, Some(now - Duration::hours(1)), now);
        assert_eq!(before.error, None);
        assert_eq!(before.calls.len(), 2);
        assert_eq!(before.calls_since, 2);
        assert!(!before.capped);
        assert_eq!(before.waiting.len(), 1);

        set_tool_allowed(&paths, "advance_phase", true).unwrap();
        let after = project_activity(&root, None, now);
        assert!(after.waiting.is_empty());
        assert_eq!(after.calls_since, 0, "no `since`, no count");
    }

    /// Degradation policy: a missing folder is quiet, a broken access file is
    /// reported, and neither fails the registry-wide read.
    #[test]
    fn unreadable_projects_degrade_to_empty_rows() {
        let app = tempfile::tempdir().unwrap();
        let reg = app.path().join("registry.json");

        let good = tempfile::tempdir().unwrap();
        let paths = workspace(good.path());
        Ledger::new(paths.ledger_file())
            .append(&call("alpha", "list_tasks", CallOutcome::Ok, at(0, Utc::now())))
            .unwrap();

        let broken = tempfile::tempdir().unwrap();
        let broken_paths = workspace(broken.path());
        std::fs::write(broken_paths.agent_access_file(), "{ not json").unwrap();

        record_workspace(&reg, &good.path().to_string_lossy(), "Good", "coding").unwrap();
        record_workspace(&reg, &broken.path().to_string_lossy(), "Broken", "coding").unwrap();
        record_workspace(&reg, r"Z:\definitely\not\here", "Gone", "coding").unwrap();

        let all = registry_activity(&reg, None).unwrap();
        assert_eq!(all.len(), 3);
        let gone = &all[0];
        assert_eq!((gone.error.as_deref(), gone.calls.len()), (None, 0));
        let broken = &all[1];
        assert!(broken.error.is_some());
        assert!(broken.waiting.is_empty());
        let good = &all[2];
        assert_eq!((good.error.as_deref(), good.calls.len()), (None, 1));
    }

    /// The count is honest about the window: once older lines were left unread
    /// and the window is all "today", the number is only a floor.
    #[test]
    fn count_is_flagged_as_a_floor_when_the_window_is_all_today() {
        let dir = tempfile::tempdir().unwrap();
        let paths = workspace(dir.path());
        let now = Utc::now();
        let ledger = Ledger::new(paths.ledger_file());
        let line = call("alpha", "list_tasks", CallOutcome::Ok, at(0, now));
        let per_line = serde_json::to_vec(&line).unwrap().len() as u64 + 1;
        let lines = ACTIVITY_WINDOW_BYTES / per_line + 50;
        for _ in 0..lines {
            ledger.append(&line).unwrap();
        }
        let root = dir.path().to_string_lossy().into_owned();
        let act = project_activity(&root, Some(now - Duration::hours(1)), now);
        assert!(act.capped);
        assert!(act.calls_since > ACTIVITY_CALLS_MAX, "the count is not limited to the rows shipped");
        assert_eq!(act.calls.len(), ACTIVITY_CALLS_MAX);
    }
}
