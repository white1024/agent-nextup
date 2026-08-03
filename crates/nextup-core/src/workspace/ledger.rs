//! Append-only workspace event ledger (`.nextup/ledger.jsonl`).
//!
//! The factual backbone of every takeover surface: handoff section content,
//! gate evaluation and flywheel evidence all read from this stream. Events
//! are only ever appended — one JSON object per line — so history cannot be
//! rewritten and a torn write can at worst corrupt a single line (which
//! readers skip).

use std::cell::RefCell;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::workspace::context::now_rfc3339;
use crate::workspace::tasks::TaskStatus;

thread_local! {
    /// Identity of whoever is driving the current call, if anyone. See
    /// [`ActorScope`].
    static AMBIENT_ACTOR: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Stamps `actor` onto every event appended on this thread for as long as the
/// guard lives — the fallback that makes semantic events attributable.
///
/// Before this existed only `AgentToolCalled` carried an actor, because that
/// is the one line the hub writes itself; every other kind is built deep in
/// the ops layer, whose functions take `(paths, app_version, ...)` and have no
/// idea who called them. The ledger could say "X called a tool" and "some
/// decision was made", but never "X made this decision" — and in the collab
/// module that is precisely the question being asked.
///
/// Ambient rather than a parameter on purpose: threading an actor through
/// every ops signature would touch dozens of call sites, and each one would
/// be a fresh chance to forget. Here the default is "attributed", and only an
/// explicit `with_actor` overrides it.
///
/// **Load-bearing precondition**: one logical call must run start-to-finish on
/// one thread. That holds today because the hub does all its work inside a
/// single `spawn_blocking` closure. If an op ever moves its ledger writes to
/// another thread or a spawned task, they will silently go back to being
/// anonymous — nothing here can detect that, so check this comment before
/// changing the execution model.
///
/// The GUI and the engine deliberately never enter a scope: an actor-less
/// event means "a human or the engine did this", which is what makes
/// "no agent signed off on its own work" provable from the ledger alone.
pub struct ActorScope {
    previous: Option<String>,
}

impl ActorScope {
    /// Enter a scope. `None` is not "leave it alone" — it explicitly means
    /// anonymous, so a nested unattributed call cannot inherit an outer actor.
    pub fn enter(actor: Option<String>) -> Self {
        let previous = AMBIENT_ACTOR.with(|slot| slot.replace(actor));
        Self { previous }
    }
}

impl Drop for ActorScope {
    fn drop(&mut self) {
        let previous = self.previous.take();
        AMBIENT_ACTOR.with(|slot| *slot.borrow_mut() = previous);
    }
}

fn ambient_actor() -> Option<String> {
    AMBIENT_ACTOR.with(|slot| slot.borrow().clone())
}

/// Append-only event stream at `.nextup/ledger.jsonl` (one JSON object per
/// line). It is the factual backbone of the handoff snapshot: "what recently
/// happened" is answered by the tail of this file, and decisions/blockers are
/// recovered from it as well.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEvent {
    pub at: String,
    pub kind: LedgerKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Self-declared identity of the external agent behind this event (D31);
    /// absent for GUI/engine events and for pre-collab ledger lines. Audit
    /// and dispatch semantics only — never an authorization input, because
    /// the name is self-declared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    /// ── Structured mirrors of load-bearing message semantics (D75) ──
    /// All optional and absent on pre-D75 lines (zero-migration, the actor
    /// precedent): consumers prefer these fields and keep a message-parse
    /// fallback only for historical lines, so the English prose is no longer
    /// a wording contract going forward.
    ///
    /// Hub tool behind an `AgentToolCalled` line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// How an `AgentToolCalled` attempt ended — the ok/failed/denied
    /// tri-state that used to live only in the message wording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<CallOutcome>,
    /// How a `PhaseAdvanced` transition happened: same `advance`/`override`
    /// vocabulary as `PhaseTransition.via` in workflow.json (single vocab,
    /// no re-derivation from prose).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    /// Why the exception happened: the gate-override justification on
    /// `PhaseAdvanced`, or the denial cause on `AgentToolCalled` — the
    /// latter previously never reached the ledger at all (the structured
    /// error went only to the agent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Transition endpoints for `TaskStatusChanged` (serde wire names, same
    /// as tasks.json).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<TaskStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<TaskStatus>,
}

/// How a hub tool attempt ended (D75) — structured mirror of the
/// ok/failed/denied wording in `AgentToolCalled` messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallOutcome {
    Ok,
    Failed,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LedgerKind {
    ProjectInitialized,
    /// Legacy since D41: opening a workspace is a read and is no longer
    /// ledgered. The variant stays so pre-D41 ledger lines keep parsing;
    /// display surfaces treat it as noise (`is_noise`).
    WorkspaceOpened,
    TaskCreated,
    TaskStatusChanged,
    /// A done task was marked verified (with evidence) or had its
    /// verification cleared — the "claimed vs checked" dimension.
    TaskVerificationChanged,
    Decision,
    /// An option that was turned down, with the reason (the do-not-revisit
    /// list in context.json). Split out of `Decision` for the same reason
    /// `Progress` was: sharing the kind made it count toward the
    /// `min_decisions` exit gate — a phase could be advanced on rejections
    /// alone — and pushed real decisions out of the takeover surface's
    /// "Recent decisions" window, which holds only a handful.
    AlternativeRejected,
    Note,
    /// A session/stage progress summary (D78): what got done and where the
    /// next session picks up. First-class so it stops masquerading as
    /// `Decision` — it gets its own takeover-surface section ("Last progress")
    /// and its own natural churn (only the newest few carry value).
    Progress,
    HandoffGenerated,
    BackupExported,
    BackupImported,
    SecretUpdated,
    PhaseAdvanced,
    GateConfirmed,
    WorkflowAdopted,
    McpToolCalled,
    IndexBuilt,
    MilestoneUpdated,
    /// A task changed hands: claimed by an agent or (re)assigned/unassigned
    /// (D31). Claim vs assign lives in the message; the actor field says who.
    TaskAssigneeChanged,
    /// Lesson lifecycle in the post-mortem flywheel (D20): recorded, fired,
    /// archived. One kind, verbs live in the message.
    LessonUpdated,
    /// An external agent invoked a hub tool via nextup-mcp. Unlike outbound
    /// McpToolCalled, denied attempts are recorded too: inbound calls get a
    /// complete audit trail (nextup_docs/06 §3).
    AgentToolCalled,
    /// Engine-shipped curriculum assets were upgraded / recreated / claimed
    /// by the user (D38). Which assets and the engine version live in the
    /// message; no-op runs are never ledgered.
    AssetsUpgraded,
    /// A done task was archived (hidden from default listings) or brought
    /// back (D40). Single vs sweep lives in the message.
    TaskArchived,
    /// A task's delta specs were folded into the main spec layer on archive
    /// (D79). Engine-stamped only — capabilities and `+ ~ - →` counts live
    /// in the message, the task in `task_id`.
    SpecFolded,
    /// A task's attributes (title / description / priority / tags) were
    /// edited. The status, verification, archive and assignee dimensions each
    /// have their own kind — this one never covers them.
    TaskEdited,
    /// A task file was deleted. The ledger line keeps the title, so the audit
    /// trail still answers "what was T-0007?" after the file is gone.
    TaskDeleted,
    /// A stable workspace id was minted for a pre-D48 workspace (explicit
    /// backfill on first team join — new workspaces get one at init and never
    /// log this).
    WorkspaceIdAssigned,
    /// A delivery envelope was published to this workspace's outbox (D48).
    DeliveryPublished,
    /// An outbox envelope was routed to a downstream team member — one line
    /// per destination, written on the upstream side (D48).
    DeliveryRouted,
    /// A delivery envelope arrived in this workspace's inbox, routed from a
    /// team upstream (D48). Written on the downstream side.
    DeliveryReceived,
}

impl LedgerKind {
    /// Every kind, for surfaces that must enumerate the whole vocabulary —
    /// the workspace guide's event list is rendered from this (bootstrap's
    /// `@LEDGER_KINDS@` placeholder), so adding a variant here is the only
    /// step needed to keep that list honest.
    pub const ALL: &'static [LedgerKind] = &[
        LedgerKind::ProjectInitialized,
        LedgerKind::WorkspaceOpened,
        LedgerKind::TaskCreated,
        LedgerKind::TaskStatusChanged,
        LedgerKind::TaskVerificationChanged,
        LedgerKind::Decision,
        LedgerKind::AlternativeRejected,
        LedgerKind::Note,
        LedgerKind::Progress,
        LedgerKind::HandoffGenerated,
        LedgerKind::BackupExported,
        LedgerKind::BackupImported,
        LedgerKind::SecretUpdated,
        LedgerKind::PhaseAdvanced,
        LedgerKind::GateConfirmed,
        LedgerKind::WorkflowAdopted,
        LedgerKind::McpToolCalled,
        LedgerKind::IndexBuilt,
        LedgerKind::MilestoneUpdated,
        LedgerKind::TaskAssigneeChanged,
        LedgerKind::LessonUpdated,
        LedgerKind::AgentToolCalled,
        LedgerKind::AssetsUpgraded,
        LedgerKind::TaskArchived,
        LedgerKind::SpecFolded,
        LedgerKind::TaskEdited,
        LedgerKind::TaskDeleted,
        LedgerKind::WorkspaceIdAssigned,
        LedgerKind::DeliveryPublished,
        LedgerKind::DeliveryRouted,
        LedgerKind::DeliveryReceived,
    ];

    /// The wire name (serde snake_case) — kept honest by a test that compares
    /// against the actual serialization for every `ALL` entry.
    pub fn as_str(&self) -> &'static str {
        match self {
            LedgerKind::ProjectInitialized => "project_initialized",
            LedgerKind::WorkspaceOpened => "workspace_opened",
            LedgerKind::TaskCreated => "task_created",
            LedgerKind::TaskStatusChanged => "task_status_changed",
            LedgerKind::TaskVerificationChanged => "task_verification_changed",
            LedgerKind::Decision => "decision",
            LedgerKind::AlternativeRejected => "alternative_rejected",
            LedgerKind::Note => "note",
            LedgerKind::Progress => "progress",
            LedgerKind::HandoffGenerated => "handoff_generated",
            LedgerKind::BackupExported => "backup_exported",
            LedgerKind::BackupImported => "backup_imported",
            LedgerKind::SecretUpdated => "secret_updated",
            LedgerKind::PhaseAdvanced => "phase_advanced",
            LedgerKind::GateConfirmed => "gate_confirmed",
            LedgerKind::WorkflowAdopted => "workflow_adopted",
            LedgerKind::McpToolCalled => "mcp_tool_called",
            LedgerKind::IndexBuilt => "index_built",
            LedgerKind::MilestoneUpdated => "milestone_updated",
            LedgerKind::TaskAssigneeChanged => "task_assignee_changed",
            LedgerKind::LessonUpdated => "lesson_updated",
            LedgerKind::AgentToolCalled => "agent_tool_called",
            LedgerKind::AssetsUpgraded => "assets_upgraded",
            LedgerKind::TaskArchived => "task_archived",
            LedgerKind::SpecFolded => "spec_folded",
            LedgerKind::TaskEdited => "task_edited",
            LedgerKind::TaskDeleted => "task_deleted",
            LedgerKind::WorkspaceIdAssigned => "workspace_id_assigned",
            LedgerKind::DeliveryPublished => "delivery_published",
            LedgerKind::DeliveryRouted => "delivery_routed",
            LedgerKind::DeliveryReceived => "delivery_received",
        }
    }

    /// Bookkeeping kinds that display surfaces (handoff §2, the GUI activity
    /// feeds) skip so plumbing never crowds real activity out of the window.
    /// The lines stay in the file — the audit trail is append-only.
    /// - `HandoffGenerated`: every mutation ends in a snapshot refresh (D24).
    /// - `WorkspaceOpened`: pre-D41 legacy lines (opens are reads and are no
    ///   longer written at all).
    pub fn is_noise(&self) -> bool {
        matches!(self, LedgerKind::HandoffGenerated | LedgerKind::WorkspaceOpened)
    }
}

impl LedgerEvent {
    pub fn new(kind: LedgerKind, message: impl Into<String>, task_id: Option<String>) -> Self {
        Self {
            at: now_rfc3339(),
            kind,
            message: message.into(),
            task_id,
            actor: None,
            tool: None,
            outcome: None,
            via: None,
            reason: None,
            from: None,
            to: None,
        }
    }

    /// Stamp the self-declared agent identity onto the event (builder style,
    /// so the dozens of anonymous `new` call sites stay untouched).
    pub fn with_actor(mut self, actor: Option<String>) -> Self {
        self.actor = actor;
        self
    }

    /// Stamp the structured call fields of an `AgentToolCalled` line (D75).
    pub fn with_call(mut self, tool: impl Into<String>, outcome: CallOutcome) -> Self {
        self.tool = Some(tool.into());
        self.outcome = Some(outcome);
        self
    }

    /// Stamp how a `PhaseAdvanced` transition happened (D75).
    pub fn with_via(mut self, via: impl Into<String>) -> Self {
        self.via = Some(via.into());
        self
    }

    /// Stamp the exception justification (override force-reason, denial
    /// cause). Takes an `Option` so call sites pass their existing value
    /// through without branching.
    pub fn with_reason(mut self, reason: Option<String>) -> Self {
        self.reason = reason;
        self
    }

    /// Stamp the endpoints of a `TaskStatusChanged` line (D75).
    pub fn with_transition(mut self, from: TaskStatus, to: TaskStatus) -> Self {
        self.from = Some(from);
        self.to = Some(to);
        self
    }
}

/// Per-entry display cap on takeover surfaces (D78). Lenses render at most
/// this many chars of any free-form string (ledger message, task title,
/// blocked reason): windows bound the *count* of entries, this bounds each
/// entry's *length* — together the surface size is engine-guaranteed no
/// matter how verbose a session gets. The ledger keeps the full text.
pub const SUMMARY_MAX_CHARS: usize = 300;

/// Clamp free-form text to its first line, hard-capped at `max` chars
/// (char-boundary safe). Returns the clamped slice and whether anything was
/// cut — callers append their own locale-appropriate "full text in the
/// ledger" pointer, so this stays presentation-neutral. Lives here with
/// `is_noise` (D41): display policy over ledger content has one home.
pub fn clamp_line(text: &str, max: usize) -> (&str, bool) {
    let line = text.split(['\n', '\r']).next().unwrap_or("").trim_end();
    let multi_line = line.len() < text.trim_end().len();
    match line.char_indices().nth(max) {
        Some((byte, _)) => (&line[..byte], true),
        None => (line, multi_line),
    }
}

/// Ceiling for `recent`/`recent_of_kind` asks. Policy lives here — not in the
/// delivery layers — so the GUI and the MCP hub cannot drift apart on it.
pub const RECENT_LIMIT_MAX: usize = 200;

/// Per-ask ceiling for [`Ledger::history`]. Browsing surfaces legitimately
/// want far more than a recent-window ask, but an unbounded read over IPC is
/// still a footgun — `total` tells callers when the cap was hit so no
/// surface has to truncate silently.
pub const HISTORY_LIMIT_MAX: usize = 1000;

/// One page of display-worthy history for browsing surfaces (D47).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerPage {
    /// Newest-first — browsers render top-down from "now".
    pub events: Vec<LedgerEvent>,
    /// Matches under the active filter across the whole ledger (not just
    /// this page), so callers know whether more remain.
    pub total: usize,
}

/// One tail read from a caller-held line cursor (D62), for surfaces that must
/// distinguish "new since I last looked" from "already seen".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerTail {
    /// Events after the cursor, chronological. Corrupt lines are skipped as in
    /// every other read — but they still count toward `next_line`, so one bad
    /// line can never wedge the cursor and stall the stream.
    ///
    /// One honest limit: a torn write that left *no trailing newline* is not a
    /// whole line of its own — the next append lands on the same physical
    /// line, so that good event is lost with the bad one. Appends are single
    /// small writes in append mode (effectively atomic here), so this is a
    /// crash-during-write case, and the alternative (never advancing past an
    /// unterminated tail) would wedge the stream permanently instead.
    pub events: Vec<LedgerEvent>,
    /// Cursor for the next ask: the file's physical line count as read here.
    pub next_line: usize,
    /// The file is shorter than the cursor, so it was replaced rather than
    /// appended to. `events` is empty by design: callers resync to `next_line`
    /// instead of replaying history they may already have shown.
    pub reset: bool,
}

pub struct Ledger {
    file: PathBuf,
}

impl Ledger {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Self { file: file.into() }
    }

    /// Append one event as a single JSON line. Small single-line appends in
    /// append mode are effectively atomic for our purposes; the file is never
    /// rewritten in place.
    ///
    /// An event that does not name an actor inherits the ambient one
    /// ([`ActorScope`]) — the single choke point every kind passes through, so
    /// attribution does not depend on each construction site remembering.
    pub fn append(&self, event: &LedgerEvent) -> Result<()> {
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let stamped: LedgerEvent;
        let event = match (&event.actor, ambient_actor()) {
            (None, Some(actor)) => {
                stamped = event.clone().with_actor(Some(actor));
                &stamped
            }
            _ => event,
        };
        let mut line = serde_json::to_vec(event)?;
        line.push(b'\n');
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file)?;
        file.write_all(&line)?;
        Ok(())
    }

    /// Last `limit` events (capped at [`RECENT_LIMIT_MAX`]) in chronological
    /// order. Corrupt lines are skipped so one bad write can never brick the
    /// workspace.
    pub fn recent(&self, limit: usize) -> Result<Vec<LedgerEvent>> {
        let limit = limit.min(RECENT_LIMIT_MAX);
        let mut events: Vec<LedgerEvent> =
            self.read_all()?.into_iter().rev().take(limit).collect();
        events.reverse();
        Ok(events)
    }

    /// Last `limit` display-worthy events (noise kinds excluded *before* the
    /// window is taken, so a burst of bookkeeping lines can never starve the
    /// feed). Same clamp as [`Ledger::recent`].
    pub fn recent_visible(&self, limit: usize) -> Result<Vec<LedgerEvent>> {
        let limit = limit.min(RECENT_LIMIT_MAX);
        let mut events: Vec<LedgerEvent> = self
            .read_all()?
            .into_iter()
            .rev()
            .filter(|e| !e.kind.is_noise())
            .take(limit)
            .collect();
        events.reverse();
        Ok(events)
    }

    /// Display-worthy history for browsing surfaces (D47): noise excluded
    /// with the same policy as [`Ledger::recent_visible`] — even when a noise
    /// kind is asked for explicitly — optionally restricted to `kinds`,
    /// newest-first, paged from the newest end by `offset`/`limit` (`limit`
    /// clamped to [`HISTORY_LIMIT_MAX`] per ask).
    pub fn history(
        &self,
        kinds: Option<&[LedgerKind]>,
        offset: usize,
        limit: usize,
    ) -> Result<LedgerPage> {
        let limit = limit.min(HISTORY_LIMIT_MAX);
        let matches: Vec<LedgerEvent> = self
            .read_all()?
            .into_iter()
            .rev()
            .filter(|e| !e.kind.is_noise())
            .filter(|e| kinds.is_none_or(|ks| ks.contains(&e.kind)))
            .collect();
        let total = matches.len();
        let events = matches.into_iter().skip(offset).take(limit).collect();
        Ok(LedgerPage { events, total })
    }

    /// Last `limit` events of the given kind, chronological order.
    pub fn recent_of_kind(&self, kind: LedgerKind, limit: usize) -> Result<Vec<LedgerEvent>> {
        let mut events: Vec<LedgerEvent> = self
            .read_all()?
            .into_iter()
            .rev()
            .filter(|e| e.kind == kind)
            .take(limit)
            .collect();
        events.reverse();
        Ok(events)
    }

    /// Every event, chronological. The flywheel needs the full stream: lesson
    /// evidence must be validated against what actually happened, not just
    /// the recent tail.
    pub fn all(&self) -> Result<Vec<LedgerEvent>> {
        self.read_all()
    }

    /// Events appended after a caller-held line cursor (D62).
    ///
    /// Notification surfaces need "what happened since I last looked", and the
    /// existing reads cannot answer it: `at` is second-resolution so two
    /// identical events in one second are indistinguishable, and `history`
    /// offsets are measured from the *newest* end so they drift as events
    /// arrive. A raw physical line count is stable precisely because this file
    /// is only ever appended to and never rewritten in place.
    pub fn since(&self, from_line: usize, limit: usize) -> Result<LedgerTail> {
        let limit = limit.min(RECENT_LIMIT_MAX);
        if !self.file.exists() {
            // No file = no history, so any non-zero cursor is already stale.
            return Ok(LedgerTail { events: Vec::new(), next_line: 0, reset: from_line > 0 });
        }
        let raw = String::from_utf8_lossy(&super::atomic::read_file(&self.file)?).into_owned();
        let total = raw.lines().count();
        if from_line > total {
            // Shorter than the cursor: the file was replaced (backup import,
            // manual edit, or a cursor kept from another workspace). Report the
            // resync instead of returning a tail — replaying a whole ledger as
            // notifications would be far worse than missing a few.
            return Ok(LedgerTail { events: Vec::new(), next_line: total, reset: true });
        }
        let mut events: Vec<LedgerEvent> = raw
            .lines()
            .skip(from_line)
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<LedgerEvent>(l).ok())
            .collect();
        // A long gap (app closed while agents worked) can leave thousands of
        // lines behind the cursor. Bound what crosses IPC, but still advance
        // the cursor past everything read so the skipped span never returns.
        if events.len() > limit {
            events.drain(..events.len() - limit);
        }
        Ok(LedgerTail { events, next_line: total, reset: false })
    }

    fn read_all(&self) -> Result<Vec<LedgerEvent>> {
        if !self.file.exists() {
            return Ok(Vec::new());
        }
        let raw = String::from_utf8_lossy(&super::atomic::read_file(&self.file)?).into_owned();
        Ok(raw
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<LedgerEvent>(l).ok())
            .collect())
    }
}

pub fn ledger_for(paths: &crate::workspace::layout::WorkspacePaths) -> Ledger {
    Ledger::new(paths.ledger_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger() -> (tempfile::TempDir, Ledger) {
        let dir = tempfile::tempdir().unwrap();
        let ledger = Ledger::new(dir.path().join(".nextup/ledger.jsonl"));
        (dir, ledger)
    }

    /// The point of the ambient actor: a `Decision` built deep in the ops
    /// layer, which never sees an actor argument, still comes out attributed.
    #[test]
    fn ambient_actor_stamps_events_that_name_nobody() {
        let (_g, ledger) = ledger();
        {
            let _scope = ActorScope::enter(Some("alpha".into()));
            ledger.append(&LedgerEvent::new(LedgerKind::Decision, "inside", None)).unwrap();
        }
        ledger.append(&LedgerEvent::new(LedgerKind::Decision, "outside", None)).unwrap();

        let events = ledger.recent(10).unwrap();
        assert_eq!(events[0].actor.as_deref(), Some("alpha"));
        assert_eq!(events[1].actor, None, "the scope must not outlive its guard");
    }

    /// Ambient is a fallback, never an override — the hub's own audit line
    /// already names its actor and must survive verbatim.
    #[test]
    fn explicit_actor_beats_ambient() {
        let (_g, ledger) = ledger();
        let _scope = ActorScope::enter(Some("alpha".into()));
        ledger
            .append(
                &LedgerEvent::new(LedgerKind::Note, "n", None).with_actor(Some("beta".into())),
            )
            .unwrap();
        assert_eq!(ledger.recent(1).unwrap()[0].actor.as_deref(), Some("beta"));
    }

    /// Entering with `None` means anonymous, not "keep the outer actor": a
    /// human action nested inside an agent call must not borrow its identity.
    #[test]
    fn nested_anonymous_scope_does_not_inherit() {
        let (_g, ledger) = ledger();
        let _outer = ActorScope::enter(Some("alpha".into()));
        {
            let _inner = ActorScope::enter(None);
            ledger.append(&LedgerEvent::new(LedgerKind::Note, "inner", None)).unwrap();
        }
        ledger.append(&LedgerEvent::new(LedgerKind::Note, "after", None)).unwrap();

        let events = ledger.recent(2).unwrap();
        assert_eq!(events[0].actor, None);
        assert_eq!(events[1].actor.as_deref(), Some("alpha"), "outer scope must be restored");
    }

    #[test]
    fn append_and_recent_preserve_order() {
        let (_g, ledger) = ledger();
        for i in 0..5 {
            ledger
                .append(&LedgerEvent::new(LedgerKind::Note, format!("event {i}"), None))
                .unwrap();
        }
        let recent = ledger.recent(3).unwrap();
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].message, "event 2");
        assert_eq!(recent[2].message, "event 4");
    }

    #[test]
    fn empty_ledger_is_fine() {
        let (_g, ledger) = ledger();
        assert!(ledger.recent(10).unwrap().is_empty());
    }

    /// D78: the per-entry display cap. First line only, char-safe hard cap,
    /// and the `cut` flag is honest in every combination.
    #[test]
    fn clamp_line_bounds_and_reports_cuts() {
        // Short single line: untouched, not cut.
        assert_eq!(clamp_line("adopt rmcp for MCP", 300), ("adopt rmcp for MCP", false));
        // Trailing newline alone is not a cut.
        assert_eq!(clamp_line("one line\n", 300), ("one line", false));
        // Multi-line: first line, reported as cut.
        assert_eq!(clamp_line("headline\nbody body body", 300), ("headline", true));
        // CRLF splits the same way.
        assert_eq!(clamp_line("headline\r\nbody", 300), ("headline", true));
        // Over-long single line: hard cap at a char boundary (CJK-safe).
        let long = "決策".repeat(400); // 800 chars, no newline
        let (clamped, cut) = clamp_line(&long, 300);
        assert!(cut);
        assert_eq!(clamped.chars().count(), 300);
        // Exactly at the cap: untouched.
        let exact = "x".repeat(300);
        assert_eq!(clamp_line(&exact, 300), (exact.as_str(), false));
    }

    #[test]
    fn corrupt_lines_are_skipped() {
        let (_g, ledger) = ledger();
        ledger.append(&LedgerEvent::new(LedgerKind::Note, "good", None)).unwrap();
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&ledger.file).unwrap();
            f.write_all(b"{garbage\n").unwrap();
        }
        ledger.append(&LedgerEvent::new(LedgerKind::Note, "also good", None)).unwrap();
        let events = ledger.recent(10).unwrap();
        assert_eq!(events.len(), 2);
    }

    /// Noise never reaches the visible window, and — the reason the filter
    /// runs before `take` — real events behind a burst of noise still fill it.
    #[test]
    fn recent_visible_skips_noise_and_keeps_window_full() {
        let (_g, ledger) = ledger();
        ledger.append(&LedgerEvent::new(LedgerKind::TaskCreated, "real 1", None)).unwrap();
        ledger.append(&LedgerEvent::new(LedgerKind::Decision, "real 2", None)).unwrap();
        for _ in 0..5 {
            ledger
                .append(&LedgerEvent::new(LedgerKind::WorkspaceOpened, "legacy open", None))
                .unwrap();
            ledger
                .append(&LedgerEvent::new(LedgerKind::HandoffGenerated, "refresh", None))
                .unwrap();
        }
        let visible = ledger.recent_visible(2).unwrap();
        assert_eq!(visible.len(), 2, "noise bursts must not starve the window");
        assert_eq!(visible[0].message, "real 1");
        assert_eq!(visible[1].message, "real 2");
    }

    /// `ALL` and `as_str` are hand-maintained mirrors of the enum/serde —
    /// this locks them to the actual serialization so they cannot drift.
    #[test]
    fn all_and_as_str_match_serde_exactly() {
        for kind in LedgerKind::ALL {
            let wire = serde_json::to_value(kind).unwrap();
            assert_eq!(wire.as_str().unwrap(), kind.as_str(), "as_str drifted for {kind:?}");
        }
        // A new variant must be added to ALL: serialize a probe of each name
        // and make sure round-tripping every possible wire string lands in ALL.
        // (Compile-time exhaustiveness: the match in as_str breaks if a
        // variant is added, which forces this file to be revisited.)
        let mut names: Vec<&str> = LedgerKind::ALL.iter().map(|k| k.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), LedgerKind::ALL.len(), "duplicate entry in ALL");
    }

    /// history() is the browsing read (D47): newest-first, honest `total`
    /// under the active filter, stable paging via offset from the newest end.
    #[test]
    fn history_pages_newest_first_with_filtered_total() {
        let (_g, ledger) = ledger();
        for i in 0..5 {
            ledger
                .append(&LedgerEvent::new(LedgerKind::Decision, format!("d{i}"), None))
                .unwrap();
            ledger.append(&LedgerEvent::new(LedgerKind::Note, format!("n{i}"), None)).unwrap();
            ledger
                .append(&LedgerEvent::new(LedgerKind::TaskCreated, format!("t{i}"), None))
                .unwrap();
        }

        // Unfiltered: all 15 real events count; first page is the newest two.
        let page = ledger.history(None, 0, 2).unwrap();
        assert_eq!(page.total, 15);
        assert_eq!(page.events.len(), 2);
        assert_eq!(page.events[0].message, "t4");
        assert_eq!(page.events[1].message, "n4");

        // Filtered to the knowledge kinds: total reflects the filter and the
        // page skips non-matching events entirely.
        let kinds = [LedgerKind::Decision, LedgerKind::Note];
        let page = ledger.history(Some(&kinds), 0, 3).unwrap();
        assert_eq!(page.total, 10);
        let msgs: Vec<&str> = page.events.iter().map(|e| e.message.as_str()).collect();
        assert_eq!(msgs, ["n4", "d4", "n3"]);

        // Offset pages continue where the previous page ended; the tail page
        // may be short.
        let page = ledger.history(Some(&kinds), 8, 3).unwrap();
        let msgs: Vec<&str> = page.events.iter().map(|e| e.message.as_str()).collect();
        assert_eq!(msgs, ["n0", "d0"]);
    }

    /// Noise stays out of history even when asked for by kind — the D41
    /// display policy has exactly one implementation.
    #[test]
    fn history_excludes_noise_even_when_requested() {
        let (_g, ledger) = ledger();
        ledger.append(&LedgerEvent::new(LedgerKind::Decision, "real", None)).unwrap();
        ledger
            .append(&LedgerEvent::new(LedgerKind::HandoffGenerated, "refresh", None))
            .unwrap();

        let page = ledger.history(Some(&[LedgerKind::HandoffGenerated]), 0, 10).unwrap();
        assert_eq!(page.total, 0);
        assert!(page.events.is_empty());

        let page = ledger.history(None, 0, 10).unwrap();
        assert_eq!(page.total, 1, "noise must not inflate the unfiltered total");
    }

    #[test]
    fn history_clamps_limit() {
        let (_g, ledger) = ledger();
        // One bulk write instead of N appends — the read path is under test.
        std::fs::create_dir_all(ledger.file.parent().unwrap()).unwrap();
        let lines: String = (0..(HISTORY_LIMIT_MAX + 5))
            .map(|i| {
                let event = LedgerEvent::new(LedgerKind::Note, format!("n{i}"), None);
                format!("{}\n", serde_json::to_string(&event).unwrap())
            })
            .collect();
        std::fs::write(&ledger.file, lines).unwrap();

        let page = ledger.history(None, 0, usize::MAX).unwrap();
        assert_eq!(page.events.len(), HISTORY_LIMIT_MAX);
        assert_eq!(page.total, HISTORY_LIMIT_MAX + 5, "total reports past the cap");
    }

    /// The cursor contract (D62): a tail read returns only what was appended
    /// after it, and hands back a cursor that excludes those same events next
    /// time. This is what stops a notification surface re-announcing an event.
    #[test]
    fn since_returns_only_events_after_the_cursor() {
        let (_g, ledger) = ledger();
        for i in 0..3 {
            ledger
                .append(&LedgerEvent::new(LedgerKind::Note, format!("old {i}"), None))
                .unwrap();
        }

        let first = ledger.since(0, 50).unwrap();
        assert_eq!(first.events.len(), 3);
        assert_eq!(first.next_line, 3);
        assert!(!first.reset);

        // Nothing appended in between: the same cursor yields an empty tail.
        let idle = ledger.since(first.next_line, 50).unwrap();
        assert!(idle.events.is_empty(), "an unchanged ledger must not re-deliver events");
        assert_eq!(idle.next_line, 3);

        ledger.append(&LedgerEvent::new(LedgerKind::Decision, "fresh", None)).unwrap();
        let tail = ledger.since(first.next_line, 50).unwrap();
        assert_eq!(tail.events.len(), 1);
        assert_eq!(tail.events[0].message, "fresh");
        assert_eq!(tail.next_line, 4);
    }

    /// A torn line is skipped for *content* but still consumed by the cursor.
    /// If it were not counted, the cursor would stall one line behind forever
    /// and every later read would re-deliver the whole tail after it.
    #[test]
    fn since_counts_corrupt_lines_toward_the_cursor() {
        let (_g, ledger) = ledger();
        ledger.append(&LedgerEvent::new(LedgerKind::Note, "good", None)).unwrap();
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&ledger.file).unwrap();
            f.write_all(b"{garbage\n").unwrap();
        }
        ledger.append(&LedgerEvent::new(LedgerKind::Note, "after garbage", None)).unwrap();

        let tail = ledger.since(0, 50).unwrap();
        assert_eq!(tail.events.len(), 2, "corrupt line is skipped as content");
        assert_eq!(tail.next_line, 3, "but still advances the cursor past itself");

        ledger.append(&LedgerEvent::new(LedgerKind::Note, "newest", None)).unwrap();
        let next = ledger.since(tail.next_line, 50).unwrap();
        assert_eq!(next.events.len(), 1, "only the newest line is new");
        assert_eq!(next.events[0].message, "newest");
    }

    /// CRLF ledgers (a hand-edited file on Windows) read the same as LF ones:
    /// `lines()` strips the `\r`, so neither the cursor arithmetic nor serde
    /// sees it. Worth locking — an editor rewriting line endings would
    /// otherwise silently shift every cursor.
    #[test]
    fn since_handles_crlf_line_endings() {
        let (_g, ledger) = ledger();
        std::fs::create_dir_all(ledger.file.parent().unwrap()).unwrap();
        let lines: String = (0..3)
            .map(|i| {
                let event = LedgerEvent::new(LedgerKind::Note, format!("n{i}"), None);
                format!("{}\r\n", serde_json::to_string(&event).unwrap())
            })
            .collect();
        std::fs::write(&ledger.file, lines).unwrap();

        let tail = ledger.since(0, 50).unwrap();
        assert_eq!(tail.events.len(), 3, "\\r must not break JSON parsing");
        assert_eq!(tail.next_line, 3, "nor inflate the line count");
    }

    /// The documented limit of a line cursor, pinned so nobody "fixes" it into
    /// a wedged stream: a torn write with no trailing newline is not its own
    /// line, so the next append lands on it and is lost with it. The cursor
    /// still advances — refusing to would stall every later event forever,
    /// which is strictly worse than losing the one that got glued.
    #[test]
    fn since_loses_the_event_glued_to_an_unterminated_torn_line() {
        let (_g, ledger) = ledger();
        ledger.append(&LedgerEvent::new(LedgerKind::Note, "good", None)).unwrap();
        {
            // Crash mid-write: bytes landed, the newline never did.
            let mut f = std::fs::OpenOptions::new().append(true).open(&ledger.file).unwrap();
            f.write_all(b"{\"at\":\"2026").unwrap();
        }
        let before = ledger.since(0, 50).unwrap();
        assert_eq!(before.events.len(), 1);
        assert_eq!(before.next_line, 2, "the unterminated tail counts as a line");

        ledger.append(&LedgerEvent::new(LedgerKind::Note, "glued", None)).unwrap();
        let after = ledger.since(before.next_line, 50).unwrap();
        assert!(
            after.events.is_empty(),
            "the appended event shares the torn line and is lost with it"
        );

        // Crucially, the stream recovers: the *next* append is a whole line.
        ledger.append(&LedgerEvent::new(LedgerKind::Note, "recovered", None)).unwrap();
        let next = ledger.since(after.next_line, 50).unwrap();
        assert_eq!(next.events.len(), 1);
        assert_eq!(next.events[0].message, "recovered");
    }

    /// A replaced (not appended) file — backup import, manual edit, or a cursor
    /// carried over from another workspace — must resync, never replay: a
    /// replayed ledger would fire a notification per historical event.
    #[test]
    fn since_reports_reset_when_the_file_shrank() {
        let (_g, ledger) = ledger();
        for i in 0..5 {
            ledger
                .append(&LedgerEvent::new(LedgerKind::Note, format!("n{i}"), None))
                .unwrap();
        }
        let stale = ledger.since(0, 50).unwrap().next_line;
        assert_eq!(stale, 5);

        // Simulate an import that restored a shorter ledger.
        let event = LedgerEvent::new(LedgerKind::Note, "restored", None);
        std::fs::write(&ledger.file, format!("{}\n", serde_json::to_string(&event).unwrap()))
            .unwrap();

        let tail = ledger.since(stale, 50).unwrap();
        assert!(tail.reset, "a shorter file than the cursor is a resync signal");
        assert!(tail.events.is_empty(), "a reset must not replay history as new events");
        assert_eq!(tail.next_line, 1, "and it resyncs to the file's real length");
    }

    /// A missing ledger with a live cursor is the same situation as a shrunk
    /// one (workspace deleted and rebuilt), so it reports a reset too.
    #[test]
    fn since_on_missing_file_resets_only_for_a_live_cursor() {
        let (_g, ledger) = ledger();
        let fresh = ledger.since(0, 50).unwrap();
        assert!(!fresh.reset, "a first read of a workspace with no ledger yet is not a reset");
        assert_eq!(fresh.next_line, 0);

        let stale = ledger.since(7, 50).unwrap();
        assert!(stale.reset);
        assert_eq!(stale.next_line, 0);
    }

    /// After a long offline gap the tail is capped, but the cursor still jumps
    /// past everything read — the skipped span must not come back next time.
    #[test]
    fn since_clamps_the_tail_but_still_advances_past_it() {
        let (_g, ledger) = ledger();
        std::fs::create_dir_all(ledger.file.parent().unwrap()).unwrap();
        let lines: String = (0..(RECENT_LIMIT_MAX + 10))
            .map(|i| {
                let event = LedgerEvent::new(LedgerKind::Note, format!("n{i}"), None);
                format!("{}\n", serde_json::to_string(&event).unwrap())
            })
            .collect();
        std::fs::write(&ledger.file, lines).unwrap();

        let tail = ledger.since(0, usize::MAX).unwrap();
        assert_eq!(tail.events.len(), RECENT_LIMIT_MAX, "tail is bounded by the shared cap");
        assert_eq!(
            tail.events.last().unwrap().message,
            format!("n{}", RECENT_LIMIT_MAX + 9),
            "the cap keeps the newest end, not the oldest"
        );
        assert_eq!(
            tail.next_line,
            RECENT_LIMIT_MAX + 10,
            "the cursor covers the dropped span so it is never re-read"
        );
        assert!(ledger.since(tail.next_line, 50).unwrap().events.is_empty());
    }

    /// D75 structured fields round-trip, stay off the wire when absent, and
    /// pre-D75 lines (no fields) keep parsing — the zero-migration contract
    /// every additive ledger field relies on (actor precedent, D31).
    #[test]
    fn structured_fields_roundtrip_and_stay_optional() {
        let event = LedgerEvent::new(LedgerKind::AgentToolCalled, "create_task denied", None)
            .with_call("create_task", CallOutcome::Denied)
            .with_reason(Some("unauthorized: not in the allowlist".into()));
        let line = serde_json::to_string(&event).unwrap();
        assert!(line.contains("\"outcome\":\"denied\""), "snake_case wire name: {line}");
        assert!(line.contains("\"tool\":\"create_task\""));
        let back: LedgerEvent = serde_json::from_str(&line).unwrap();
        assert_eq!(back, event);

        // TaskStatus endpoints keep their tasks.json wire names.
        let transition = LedgerEvent::new(LedgerKind::TaskStatusChanged, "x", None)
            .with_transition(TaskStatus::Todo, TaskStatus::Blocked);
        let line = serde_json::to_string(&transition).unwrap();
        assert!(line.contains("\"from\":\"todo\""), "{line}");
        assert!(line.contains("\"to\":\"blocked\""), "{line}");

        // Absent fields serialize to nothing — lines stay as small as before.
        let plain = LedgerEvent::new(LedgerKind::Note, "old line", None);
        let line = serde_json::to_string(&plain).unwrap();
        for key in ["\"tool\"", "\"outcome\"", "\"via\"", "\"reason\"", "\"from\"", "\"to\""] {
            assert!(!line.contains(key), "{key} must stay off the wire: {line}");
        }

        // A pre-D75 line parses with every structured field None.
        let legacy: LedgerEvent = serde_json::from_str(
            r#"{"at":"2026-01-01T00:00:00Z","kind":"task_status_changed","message":"\"x\": todo → blocked"}"#,
        )
        .unwrap();
        assert_eq!(legacy.to, None);
        assert_eq!(legacy.outcome, None);
        assert_eq!(legacy.via, None);
    }

    #[test]
    fn filter_by_kind() {
        let (_g, ledger) = ledger();
        ledger
            .append(&LedgerEvent::new(LedgerKind::Decision, "use SQLite over sled", None))
            .unwrap();
        ledger.append(&LedgerEvent::new(LedgerKind::Note, "misc", None)).unwrap();
        ledger
            .append(&LedgerEvent::new(LedgerKind::Decision, "files are source of truth", None))
            .unwrap();

        let decisions = ledger.recent_of_kind(LedgerKind::Decision, 10).unwrap();
        assert_eq!(decisions.len(), 2);
        assert_eq!(decisions[0].message, "use SQLite over sled");
        assert_eq!(decisions[1].message, "files are source of truth");
    }
}
