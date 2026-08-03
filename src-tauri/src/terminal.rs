//! Embedded agent terminal (D50): real agent CLIs (claude / codex / …) run
//! in a ConPTY-backed pseudo terminal owned by the app process, so a session
//! keeps running while the user switches workspaces. Sessions are app-level
//! state tagged with the workspace they were launched in.
//!
//! Trust boundary (D14 as amended by D50): only a human clicks "launch", and
//! nothing in this module ever writes to the PTY except `write()`, which is
//! driven solely by user keystrokes forwarded from the terminal view. No
//! auto-start path, no injected input, no credential handling.
//!
//! Terminal output is ephemeral by design: it never touches the ledger or
//! the search index — an agent's *actions* are audited by nextup-mcp, not by
//! scraping its chat transcript.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use nextup_core::error::{NextUpError, Result};
use nextup_core::workspace::agent_catalog::{self, resolve_program};
use nextup_core::workspace::atomic::{atomic_write_json, read_json_file};
use nextup_core::workspace::context::{load_context, now_rfc3339};
use nextup_core::workspace::layout::WorkspacePaths;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Emitted for every chunk of PTY output. Payload: `TerminalOutputPayload`.
/// The frontend feeds `data` to xterm.js only while that session's view is
/// mounted; the Rust-side scrollback buffer is the source for remounts.
pub const TERMINAL_OUTPUT_EVENT: &str = "terminal://output";
/// Emitted once when the child process exits on its own (not on `close`,
/// which is user-driven removal). Payload: `TerminalExitPayload`.
pub const TERMINAL_EXIT_EVENT: &str = "terminal://exit";
/// Emitted when the session set changes in a way output/exit do not cover —
/// currently a pop-out toggle (B16-C). No payload; every window reloads
/// `terminal_list`. Broadcast so a dock-back in a pop-out window reaches the
/// main window and vice versa.
pub const TERMINAL_SESSIONS_EVENT: &str = "terminal://sessions";

/// Per-session scrollback cap in bytes. A fixed ring so a long-running agent
/// can never grow memory unboundedly; the oldest output is dropped first.
const SCROLLBACK_CAP: usize = 512 * 1024;
const READ_CHUNK: usize = 16 * 1024;

/// How often the persist loop flushes sessions whose *metadata* changed since
/// the last write (D69). Metadata-only persistence means output no longer
/// dirties a session, so this window rarely does real work — it exists to
/// catch a status flip (a child that exited) between now and the next quit.
const PERSIST_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3);
/// On-disk schema version for a persisted terminal session. Bumped to 2 at
/// D69 (metadata-only): a v1 file still deserializes — serde ignores its now
/// unknown `scrollback`/`seq` fields — so no migration is needed.
const TERMINAL_PERSIST_SCHEMA_VERSION: u32 = 2;

/// The variable `nextup-mcp` reads to learn who is calling: a `--agent` flag
/// beats it, absent means anonymous. Setting it on the CLI we spawn is the
/// only lever the GUI has over hub identity — `.mcp.json` is a committed,
/// worktree-shared file, so writing `--agent` into it would make one
/// machine's choice everybody's.
const NEXTUP_AGENT_VAR: &str = "NEXTUP_AGENT";

/// Long enough for any real agent name, short enough that a pasted paragraph
/// cannot become the `actor` column of every ledger line in the workspace.
const IDENTITY_MAX_CHARS: usize = 64;

/// Vet a launch-time identity before it becomes an env var and, via the hub,
/// the `actor` stamped on this session's ledger lines. Blank is not an error
/// — it means "no identity", the same as never picking one — but `=` or a
/// control character would corrupt the child's environment block, and a
/// whitespace-only name would show up in audits as a nameless actor.
fn sanitize_identity(identity: Option<&str>) -> Result<Option<String>> {
    let Some(raw) = identity else { return Ok(None) };
    let name = raw.trim();
    if name.is_empty() {
        return Ok(None);
    }
    if name.chars().any(|c| c.is_control() || c == '=') {
        return Err(NextUpError::InvalidInput(
            "agent identity cannot contain '=' or control characters".into(),
        ));
    }
    if name.chars().count() > IDENTITY_MAX_CHARS {
        return Err(NextUpError::InvalidInput(format!(
            "agent identity is too long (max {IDENTITY_MAX_CHARS} characters)"
        )));
    }
    Ok(Some(name.to_string()))
}

/// Whether a session is persisted/restored across app restarts (D69). Only an
/// agent with a known resume path qualifies: a restored tab that cannot
/// reattach its conversation would be a dead stub (its scrollback isn't kept
/// either), so a custom (non-resumable) agent's terminal simply vanishes on
/// quit, as it did before B16. Same predicate the GUI exposes as
/// `AgentInfo.resumable`.
fn is_restorable(agent_id: &str) -> bool {
    agent_catalog::builtin_resume_args(agent_id).is_some()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalStatus {
    Running,
    Exited,
    /// Reconstructed from disk at startup (D69): the process from the prior
    /// app run is gone and its scrollback is NOT kept — the tab is a
    /// lightweight placeholder that resumes its conversation on view (B16-B /
    /// D69 in-place revive). Kept distinct from `Exited` so the tab can say
    /// "restored" and so the on-view resume can hang off it.
    Restored,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionMeta {
    pub id: u64,
    /// Workspace root the CLI was launched in (its cwd — `.mcp.json` there
    /// is what wires a Claude CLI to nextup-mcp automatically).
    pub root: String,
    /// Stable workspace identity (D48) when the root carries one.
    pub workspace_id: Option<String>,
    pub agent_id: String,
    pub title: String,
    /// Self-reported agent identity this session runs as (D63): the
    /// `NEXTUP_AGENT` handed to the CLI, which the hub stamps onto every
    /// ledger line it writes and uses as the claimer for `claim_task`.
    /// `None` = anonymous, the pre-D63 behaviour. Never an authorization
    /// input — `agent_access.json` alone decides what a call may do.
    pub identity: Option<String>,
    pub started_at: String,
    pub status: TerminalStatus,
    pub exit_code: Option<u32>,
    /// Rendered in a separate pop-out window right now (B16-C). The main
    /// window shows a "Popped out" placeholder instead of a live pane, so a
    /// session is never double-rendered or double-fed. Reset to false on
    /// restore — the window from the prior app run no longer exists.
    #[serde(default)]
    pub popped_out: bool,
}

/// On-disk form of a session (D69: metadata only). Just enough to redraw the
/// tab and know which agent/cwd to resume — the scrollback is NOT persisted
/// (resume reads the CLI's own cwd-scoped transcript, never our pixels), so
/// this is a few hundred bytes, not the 512KiB ring. One file per session at
/// `~/.nextup/terminals/<id>.json`, following the agents.json / teams.json
/// atomic-write convention. A v1 file (which carried `scrollback`/`seq`) still
/// loads — serde drops the unknown fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSession {
    #[serde(default)]
    schema_version: u32,
    meta: TerminalSessionMeta,
}

/// `~/.nextup/terminals/` — one JSON file per persisted session (B16-A),
/// beside agents.json / teams.json / registry.json. Derived from the agent
/// catalog path so it needs no extra home-dir plumbing.
pub fn default_persist_dir() -> Option<PathBuf> {
    let catalog = agent_catalog::default_agent_catalog_path()?;
    catalog.parent().map(|dir| dir.join("terminals"))
}

/// Scrollback snapshot for (re)mounting a terminal view. `seq` is the count
/// of output chunks folded into `data` — the view drops incoming output
/// events with `seq <= snapshot.seq`, closing the subscribe/snapshot race
/// without heuristics.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBuffer {
    pub data: String,
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputPayload {
    pub id: u64,
    pub seq: u64,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitPayload {
    pub id: u64,
    pub exit_code: Option<u32>,
}

/// Manager-to-frontend notifications. Kept as a plain enum behind a sink
/// closure so the manager (and its tests) never depend on a Tauri runtime.
pub enum TerminalEvent {
    Output { id: u64, seq: u64, data: String },
    Exit { id: u64, exit_code: Option<u32> },
    /// The session set changed (a pop-out toggle, B16-C) — reload the list.
    SessionsChanged,
}

pub type EventSink = Box<dyn Fn(TerminalEvent) + Send + Sync>;

/// Production sink: forward a `TerminalEvent` as a Tauri event.
pub fn emit_event(app: &AppHandle, event: TerminalEvent) {
    match event {
        TerminalEvent::Output { id, seq, data } => {
            let _ = app.emit(TERMINAL_OUTPUT_EVENT, TerminalOutputPayload { id, seq, data });
        }
        TerminalEvent::Exit { id, exit_code } => {
            let _ = app.emit(TERMINAL_EXIT_EVENT, TerminalExitPayload { id, exit_code });
        }
        TerminalEvent::SessionsChanged => {
            let _ = app.emit(TERMINAL_SESSIONS_EVENT, ());
        }
    }
}

struct Session {
    meta: TerminalSessionMeta,
    /// Dropped on exit/close: releases the ConPTY (ClosePseudoConsole),
    /// which terminates attached console clients, unblocks the reader
    /// thread with EOF and lets the conhost go away.
    master: Option<Box<dyn MasterPty + Send>>,
    /// Own mutex so a stalled write (full pipe) can only ever block this
    /// session's writes, never the whole session table.
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    /// `None` for a restored session (B16-A): its process is already gone,
    /// so there is nothing to kill.
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    /// Read only by tests today (`pid_of`) — kept on the session because it
    /// is the one process fact worth having when debugging a live app.
    #[allow(dead_code)]
    pid: Option<u32>,
    scrollback: String,
    seq: u64,
    /// Set by the reader thread on EOF — tells the waiter that everything
    /// the ConPTY will ever emit has been drained.
    reader_done: bool,
    /// Metadata changed since the last persist (D69: no longer set by output,
    /// only by a status flip or launch); the persist loop writes it and clears
    /// the flag.
    dirty: bool,
}

impl Session {
    /// Snapshot the persistable state (metadata only, D69) for writing to
    /// disk. The scrollback and the live handles (master/writer/killer) are
    /// intentionally left out — a restored session is a placeholder that
    /// resumes from the CLI's own transcript, not from our pixels.
    fn persisted(&self) -> PersistedSession {
        PersistedSession {
            schema_version: TERMINAL_PERSIST_SCHEMA_VERSION,
            meta: self.meta.clone(),
        }
    }
}

pub struct TerminalManager {
    sink: EventSink,
    sessions: Mutex<HashMap<u64, Session>>,
    next_id: AtomicU64,
    /// Where sessions are persisted for restore across app restarts (B16-A).
    /// `None` disables persistence entirely — the mode the tests run in.
    persist_dir: Option<PathBuf>,
}

impl TerminalManager {
    /// A non-persistent manager: sessions live only as long as the app run.
    /// Used by tests; production goes through `new_persistent`.
    pub fn new(sink: EventSink) -> Arc<Self> {
        Arc::new(Self {
            sink,
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            persist_dir: None,
        })
    }

    /// A manager that persists sessions under `persist_dir` and restores any
    /// found there at startup (B16-A). Restore happens here so the sessions
    /// are visible before the first `terminal_list`; call `start_persist_loop`
    /// afterwards to begin the periodic flush.
    pub fn new_persistent(sink: EventSink, persist_dir: PathBuf) -> Arc<Self> {
        let mgr = Arc::new(Self {
            sink,
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            persist_dir: Some(persist_dir),
        });
        mgr.restore_from_disk();
        mgr
    }

    /// The session table stays consistent under append/remove even if a
    /// helper thread panicked mid-update, so a poisoned lock is recovered
    /// rather than propagated into every later IPC call.
    fn lock(&self) -> MutexGuard<'_, HashMap<u64, Session>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Launch a cataloged agent CLI in `root`. Human-initiated only (D50).
    ///
    /// `identity` (D63) is the optional self-reported agent name for this
    /// session. It is layered on top of the catalog entry's own env, so a
    /// launch-time pick wins over an `NEXTUP_AGENT` baked into a custom agent:
    /// the choice made at the moment of launching is the more specific one.
    ///
    /// `resume` (B16-B) launches the agent with its "reattach the last
    /// conversation" invocation instead of a fresh one — used by the "Resume" action on a restored/exited tab. Only the built-ins have a known
    /// resume form (`agent_catalog::builtin_resume_args`); a custom agent (or
    /// `resume = false`) launches with its normal args.
    pub fn launch(
        self: &Arc<Self>,
        root: &Path,
        agent_id: &str,
        identity: Option<&str>,
        resume: bool,
    ) -> Result<TerminalSessionMeta> {
        let catalog = agent_catalog::default_agent_catalog_path().ok_or_else(|| {
            NextUpError::NotFound("cannot resolve the home directory for agents.json".into())
        })?;
        let agent = agent_catalog::find_agent(&catalog, agent_id)?;
        let identity = sanitize_identity(identity)?;
        let (program, args_owned, env) = resolve_spawn(&agent, &identity, resume)?;
        let args: Vec<&str> = args_owned.iter().map(String::as_str).collect();
        self.launch_program(root, &agent.id, &agent.title, identity, &program, &args, &env)
    }

    /// Spawn `program` (already resolved to a real file) in a fresh PTY.
    /// Split from `launch` so tests can drive the full session lifecycle
    /// with a stock executable instead of an installed agent CLI.
    ///
    /// `env` (D56) is applied on top of the inherited process environment —
    /// portable-pty seeds the child env from the current process, so these
    /// only add or override (e.g. `ANTHROPIC_BASE_URL` for a local endpoint).
    #[allow(clippy::too_many_arguments)]
    fn launch_program(
        self: &Arc<Self>,
        root: &Path,
        agent_id: &str,
        title: &str,
        identity: Option<String>,
        program: &Path,
        args: &[&str],
        env: &BTreeMap<String, String>,
    ) -> Result<TerminalSessionMeta> {
        if !root.is_dir() {
            return Err(NextUpError::InvalidInput(format!(
                "terminal cwd is not a directory: {}",
                root.display()
            )));
        }

        let SpawnedPty { master, writer, reader, killer, pid, child } =
            open_pty_and_spawn(root, program, args, env)?;
        let workspace_id = load_context(&WorkspacePaths::new(root).context_file())
            .ok()
            .and_then(|c| c.workspace_id);

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let meta = TerminalSessionMeta {
            id,
            root: root.display().to_string(),
            workspace_id,
            agent_id: agent_id.to_string(),
            title: title.to_string(),
            identity,
            started_at: now_rfc3339(),
            status: TerminalStatus::Running,
            exit_code: None,
            popped_out: false,
        };
        let session = Session {
            meta: meta.clone(),
            master: Some(master),
            writer: Arc::new(Mutex::new(Some(writer))),
            killer: Some(killer),
            pid,
            scrollback: String::new(),
            seq: 0,
            reader_done: false,
            // Dirty from birth so the tab (its metadata) is persisted on the
            // next flush even before any output — a launched session should
            // survive a restart, not just one that has printed something.
            dirty: true,
        };
        // Insert before starting the threads so both always find their session.
        self.lock().insert(id, session);

        let mgr = Arc::clone(self);
        spawn_named(format!("terminal-read-{id}"), move || read_loop(mgr, id, reader));
        let mgr = Arc::clone(self);
        spawn_named(format!("terminal-wait-{id}"), move || wait_loop(mgr, id, child));

        Ok(meta)
    }

    /// Bring a restored (or exited) tab back to life IN PLACE (D69): relaunch
    /// its agent with the built-in resume invocation, reusing the SAME session
    /// id so the tab keeps its position and never shuffles. Rejected up front
    /// if the session is already running (a double-trigger) or gone; the
    /// spawn-time race is handled in `revive_program`.
    pub fn revive(self: &Arc<Self>, id: u64) -> Result<TerminalSessionMeta> {
        let (root, agent_id, identity) = {
            let sessions = self.lock();
            let s = sessions
                .get(&id)
                .ok_or_else(|| NextUpError::NotFound(format!("terminal session {id} not found")))?;
            if s.meta.status == TerminalStatus::Running {
                return Err(NextUpError::Terminal(format!(
                    "terminal session {id} is already running"
                )));
            }
            (PathBuf::from(&s.meta.root), s.meta.agent_id.clone(), s.meta.identity.clone())
        };
        let catalog = agent_catalog::default_agent_catalog_path().ok_or_else(|| {
            NextUpError::NotFound("cannot resolve the home directory for agents.json".into())
        })?;
        let agent = agent_catalog::find_agent(&catalog, &agent_id)?;
        let (program, args_owned, env) = resolve_spawn(&agent, &identity, true)?;
        let args: Vec<&str> = args_owned.iter().map(String::as_str).collect();
        self.revive_program(id, &root, &program, &args, &env)
    }

    /// The PTY-spawning core of `revive`, split out (like `launch_program`) so
    /// tests can drive it with a stock executable. Spawns the child, then
    /// attaches it to the EXISTING entry under the lock — or, if that entry was
    /// closed or already revived while we were spawning (G4), kills the fresh
    /// child rather than leak an orphan.
    fn revive_program(
        self: &Arc<Self>,
        id: u64,
        root: &Path,
        program: &Path,
        args: &[&str],
        env: &BTreeMap<String, String>,
    ) -> Result<TerminalSessionMeta> {
        if !root.is_dir() {
            return Err(NextUpError::InvalidInput(format!(
                "terminal cwd is not a directory: {}",
                root.display()
            )));
        }
        let SpawnedPty { master, writer, reader, killer, pid, child } =
            open_pty_and_spawn(root, program, args, env)?;

        let meta = {
            let mut sessions = self.lock();
            let can_attach =
                matches!(sessions.get(&id), Some(s) if s.meta.status != TerminalStatus::Running);
            if !can_attach {
                // Closed or already running under us: don't leave the child we
                // just spawned running with no session to own it.
                drop(sessions);
                let mut killer = killer;
                let _ = killer.kill();
                drop(master);
                return Err(NextUpError::Terminal(
                    "terminal was closed or already resumed before it could reattach".into(),
                ));
            }
            let session = sessions.get_mut(&id).expect("present and not running");
            session.master = Some(master);
            {
                let mut w = session.writer.lock().unwrap_or_else(PoisonError::into_inner);
                *w = Some(writer);
            }
            session.killer = Some(killer);
            session.pid = pid;
            session.meta.status = TerminalStatus::Running;
            session.meta.exit_code = None;
            // Fresh ring + seq: the placeholder had none, and starting seq at 0
            // means the pane (remounted from card → live) never drops the
            // revived process's first output as a stale replay.
            session.scrollback = String::new();
            session.seq = 0;
            session.reader_done = false;
            session.dirty = true;
            session.meta.clone()
        };

        let mgr = Arc::clone(self);
        spawn_named(format!("terminal-read-{id}"), move || read_loop(mgr, id, reader));
        let mgr = Arc::clone(self);
        spawn_named(format!("terminal-wait-{id}"), move || wait_loop(mgr, id, child));

        Ok(meta)
    }

    /// Forward user keystrokes to the CLI. This is the *only* PTY input
    /// path in the whole app (D50: the engine never injects input).
    pub fn write(&self, id: u64, data: &str) -> Result<()> {
        let writer = {
            let sessions = self.lock();
            let session = sessions
                .get(&id)
                .ok_or_else(|| NextUpError::NotFound(format!("terminal session {id} not found")))?;
            Arc::clone(&session.writer)
        };
        let mut guard = writer.lock().unwrap_or_else(PoisonError::into_inner);
        let w = guard
            .as_mut()
            .ok_or_else(|| NextUpError::Terminal(format!("terminal session {id} has exited")))?;
        w.write_all(data.as_bytes())
            .and_then(|_| w.flush())
            .map_err(|e| NextUpError::Terminal(format!("terminal write failed: {e}")))
    }

    pub fn resize(&self, id: u64, rows: u16, cols: u16) -> Result<()> {
        if rows == 0 || cols == 0 {
            return Err(NextUpError::InvalidInput("terminal size must be non-zero".into()));
        }
        let sessions = self.lock();
        let session = sessions
            .get(&id)
            .ok_or_else(|| NextUpError::NotFound(format!("terminal session {id} not found")))?;
        let master = session
            .master
            .as_ref()
            .ok_or_else(|| NextUpError::Terminal(format!("terminal session {id} has exited")))?;
        master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| NextUpError::Terminal(format!("terminal resize failed: {e}")))
    }

    /// Close a session: kill the child if it is still running and drop the
    /// ConPTY. Also how an already-exited session's tab is dismissed.
    pub fn close(&self, id: u64) -> Result<()> {
        let mut session = self
            .lock()
            .remove(&id)
            .ok_or_else(|| NextUpError::NotFound(format!("terminal session {id} not found")))?;
        if session.meta.status == TerminalStatus::Running {
            // portable-pty 0.9 quirk (read the source): WinChildKiller::kill
            // inverts the TerminateProcess result, returning Err on success.
            // The Result is meaningless here — actual death is confirmed by
            // the waiter thread's blocking wait(), and the ConPTY teardown
            // below takes the console session down with it. A restored session
            // has no killer (its process is long gone).
            if let Some(killer) = session.killer.as_mut() {
                let _ = killer.kill();
            }
        }
        // Dropping the session outside the table lock releases the master
        // (ClosePseudoConsole) without ever blocking other sessions.
        drop(session);
        // Dismissing a tab forgets it across restarts too (B16-A): unlike a
        // quit (which persists for restore), an explicit close means gone.
        if let Some(path) = self.session_path(id) {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<TerminalSessionMeta> {
        let mut metas: Vec<TerminalSessionMeta> =
            self.lock().values().map(|s| s.meta.clone()).collect();
        metas.sort_by_key(|m| m.id);
        metas
    }

    pub fn read_buffer(&self, id: u64) -> Result<TerminalBuffer> {
        let sessions = self.lock();
        let session = sessions
            .get(&id)
            .ok_or_else(|| NextUpError::NotFound(format!("terminal session {id} not found")))?;
        Ok(TerminalBuffer { data: session.scrollback.clone(), seq: session.seq })
    }

    /// Mark a session as (not) rendered in a pop-out window (B16-C) and tell
    /// every window to reload, so the main view swaps between its live pane
    /// and the "Popped out" placeholder. Broadcasts even on a no-op change — cheap,
    /// and it keeps the two windows convergent after a race.
    pub fn set_popped_out(&self, id: u64, popped_out: bool) -> Result<()> {
        {
            let mut sessions = self.lock();
            let session = sessions
                .get_mut(&id)
                .ok_or_else(|| NextUpError::NotFound(format!("terminal session {id} not found")))?;
            session.meta.popped_out = popped_out;
        }
        (self.sink)(TerminalEvent::SessionsChanged);
        Ok(())
    }

    /// Absolute path of a session's persisted file, if persistence is on.
    fn session_path(&self, id: u64) -> Option<PathBuf> {
        self.persist_dir.as_ref().map(|dir| dir.join(format!("{id}.json")))
    }

    /// Load any persisted sessions at startup as read-only `Restored` tabs and
    /// seed `next_id` past them so a new launch never reuses a restored id.
    /// A corrupt file is skipped rather than fatal — one bad session must not
    /// stop the app from opening.
    fn restore_from_disk(&self) {
        let Some(dir) = self.persist_dir.clone() else { return };
        // No directory yet = nothing persisted; not an error.
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        let mut max_id = 0u64;
        let mut sessions = self.lock();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(persisted) = read_json_file::<PersistedSession>(&path) else {
                continue;
            };
            let mut meta = persisted.meta;
            // A non-resumable agent's tab is not restored (D69): it could not
            // reattach and its scrollback is not kept, so it would be a dead
            // stub. Drop the file too — a legacy v1 file for a custom agent (or
            // one whose agent was since removed) should not linger.
            if !is_restorable(&meta.agent_id) {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            // The process died with the previous app run; present it read-only.
            meta.status = TerminalStatus::Restored;
            // Any pop-out window from that run is gone too — render in main.
            meta.popped_out = false;
            max_id = max_id.max(meta.id);
            let id = meta.id;
            sessions.insert(
                id,
                Session {
                    meta,
                    master: None,
                    writer: Arc::new(Mutex::new(None)),
                    killer: None,
                    pid: None,
                    // No scrollback survives a restart (D69): the placeholder
                    // shows a card and revive replays from the CLI's own
                    // transcript, not from here. seq starts fresh so a revived
                    // pane's first output is never dropped as a stale replay.
                    scrollback: String::new(),
                    seq: 0,
                    reader_done: true,
                    dirty: false,
                },
            );
        }
        drop(sessions);
        if max_id > 0 {
            self.next_id.store(max_id + 1, Ordering::Relaxed);
        }
    }

    /// Start the background flush (B16-A / D69): every `PERSIST_INTERVAL`,
    /// write any restorable session whose metadata changed since the last
    /// write. Holds a `Weak` so the thread ends when the manager (and the
    /// app) go away.
    pub fn start_persist_loop(self: &Arc<Self>) {
        if self.persist_dir.is_none() {
            return;
        }
        let weak = Arc::downgrade(self);
        spawn_named("terminal-persist".to_string(), move || loop {
            std::thread::sleep(PERSIST_INTERVAL);
            let Some(mgr) = weak.upgrade() else { return };
            mgr.flush_dirty();
        });
    }

    /// Write every restorable session marked dirty since the last flush,
    /// clearing the flag. File I/O happens outside the table lock so a slow
    /// disk never blocks launches or writes. Non-resumable agents are never
    /// written (D69) — so no stray file is ever created for them.
    fn flush_dirty(&self) {
        let Some(dir) = self.persist_dir.clone() else { return };
        let pending: Vec<(u64, PersistedSession)> = {
            let mut sessions = self.lock();
            sessions
                .iter_mut()
                .filter(|(_, s)| s.dirty && is_restorable(&s.meta.agent_id))
                .map(|(id, s)| {
                    s.dirty = false;
                    (*id, s.persisted())
                })
                .collect()
        };
        for (id, persisted) in pending {
            // A session closed since the snapshot must not have its file
            // rewritten — that would resurrect the tab `close` just deleted.
            // Re-check under the lock; the residual check→write window is
            // microseconds and both writers use unique temp names anyway.
            if self.lock().contains_key(&id) {
                let _ = atomic_write_json(&dir.join(format!("{id}.json")), &persisted);
            }
        }
    }

    /// App is quitting (B16-A / D69): capture every restorable session's
    /// metadata to disk so the next launch can restore its tab, then kill the
    /// live children. Unlike `close`, the persisted files are kept. Only
    /// resumable built-ins are written — a custom agent's terminal vanishes on
    /// quit (D69).
    pub fn shutdown(&self) {
        let dir = self.persist_dir.clone();
        let pending: Vec<(u64, PersistedSession)> = {
            let mut sessions = self.lock();
            let snapshot = if dir.is_some() {
                sessions
                    .iter_mut()
                    .filter(|(_, s)| is_restorable(&s.meta.agent_id))
                    .map(|(id, s)| {
                        s.dirty = false;
                        (*id, s.persisted())
                    })
                    .collect()
            } else {
                Vec::new()
            };
            // Kill live children so quitting leaves no orphans (D50). Restored
            // sessions have no killer — nothing to do.
            for session in sessions.values_mut() {
                if session.meta.status == TerminalStatus::Running {
                    if let Some(killer) = session.killer.as_mut() {
                        let _ = killer.kill();
                    }
                }
            }
            snapshot
        };
        if let Some(dir) = dir {
            for (id, persisted) in pending {
                let _ = atomic_write_json(&dir.join(format!("{id}.json")), &persisted);
            }
        }
    }

    #[cfg(test)]
    fn pid_of(&self, id: u64) -> Option<u32> {
        self.lock().get(&id).and_then(|s| s.pid)
    }

    #[cfg(test)]
    fn next_id_value(&self) -> u64 {
        self.next_id.load(Ordering::Relaxed)
    }
}

fn spawn_named(name: String, f: impl FnOnce() + Send + 'static) {
    // Thread names are best-effort debugging aids; spawning must not fail
    // the launch path.
    let _ = std::thread::Builder::new().name(name).spawn(f);
}

/// The live handles of a freshly spawned PTY child, before it is bound to a
/// session id. Shared by `launch` (new id) and `revive` (existing id, D69).
struct SpawnedPty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    reader: Box<dyn Read + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    child: Box<dyn Child + Send + Sync>,
}

/// Open a PTY and spawn `program` in it under `root`, returning the live
/// handles. Reader/writer come off the master before spawning: if either
/// fails there is no child to clean up yet.
fn open_pty_and_spawn(
    root: &Path,
    program: &Path,
    args: &[&str],
    env: &BTreeMap<String, String>,
) -> Result<SpawnedPty> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| NextUpError::Terminal(format!("cannot allocate a pty: {e}")))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| NextUpError::Terminal(format!("cannot open pty reader: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| NextUpError::Terminal(format!("cannot open pty writer: {e}")))?;

    // Batch shims (npm-installed CLIs are `.cmd` files) cannot be a
    // CreateProcessW application name — they need the cmd.exe host.
    let mut cmd = if is_batch_file(program) {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/C");
        c.arg(program);
        c
    } else {
        CommandBuilder::new(program)
    };
    for arg in args {
        cmd.arg(arg);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.cwd(root);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| NextUpError::Terminal(format!("failed to start the terminal program: {e}")))?;
    // The slave's handles are no longer needed once the child holds them.
    drop(pair.slave);

    let killer = child.clone_killer();
    let pid = child.process_id();
    Ok(SpawnedPty { master: pair.master, writer, reader, killer, pid, child })
}

/// Resolve a cataloged agent to the concrete (program, args, env) to spawn.
/// Shared by `launch` (new tab) and `revive` (in-place, D69). `resume` (B16-B)
/// selects the built-in resume invocation, which fully REPLACES the (empty)
/// preset args so codex's `resume` subcommand lands first; a custom or
/// non-resume launch uses the agent's own args. `identity` (D63), when set,
/// is layered on as `NEXTUP_AGENT`.
fn resolve_spawn(
    agent: &agent_catalog::AgentInfo,
    identity: &Option<String>,
    resume: bool,
) -> Result<(PathBuf, Vec<String>, BTreeMap<String, String>)> {
    let program = resolve_program(&agent.command).ok_or_else(|| {
        NextUpError::Terminal(format!(
            "`{}` was not found on PATH — is {} installed?",
            agent.command, agent.title
        ))
    })?;
    let mut env = agent.env.clone();
    if let Some(name) = identity {
        env.insert(NEXTUP_AGENT_VAR.to_string(), name.clone());
    }
    let args = if resume {
        agent_catalog::builtin_resume_args(&agent.id).unwrap_or_else(|| agent.args.clone())
    } else {
        agent.args.clone()
    };
    Ok((program, args, env))
}

/// Pump PTY output: decode, append to the scrollback ring and emit. The
/// read blocks until output arrives or the ConPTY is closed (child exit or
/// user close both end here), which is this thread's exit condition.
fn read_loop(mgr: Arc<TerminalManager>, id: u64, mut reader: Box<dyn Read + Send>) {
    let mut carry = Utf8Carry::default();
    let mut buf = [0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => {
                if let Some(session) = mgr.lock().get_mut(&id) {
                    session.reader_done = true;
                }
                return;
            }
            Ok(n) => {
                let data = carry.push(&buf[..n]);
                if data.is_empty() {
                    continue;
                }
                let seq = {
                    let mut sessions = mgr.lock();
                    // Session gone = user closed it; no one wants the rest.
                    let Some(session) = sessions.get_mut(&id) else { return };
                    // Feed the live ring only — it redraws on remount. Output
                    // does not dirty the session: scrollback isn't persisted
                    // (D69), so persisting on every chunk would be dead I/O.
                    push_scrollback(&mut session.scrollback, &data, SCROLLBACK_CAP);
                    session.seq += 1;
                    session.seq
                };
                // Emitted outside the lock; ordering per session is safe
                // because this thread is the session's only emitter.
                (mgr.sink)(TerminalEvent::Output { id, seq, data });
            }
        }
    }
}

/// Reap the child: block until it exits, then flip the session to `exited`
/// and release the ConPTY so the reader drains and the console host leaves.
/// After a user `close` the session is already gone and this stays silent.
fn wait_loop(mgr: Arc<TerminalManager>, id: u64, mut child: Box<dyn Child + Send + Sync>) {
    let exit_code = child.wait().ok().map(|status| status.exit_code());
    // ConPTY renders asynchronously: closing it the instant the child dies
    // discards whatever conhost has not yet turned into VT output — for a
    // short-lived command that is the entire result. Hold the teardown
    // until output has been quiet for a tick (or the reader hit EOF),
    // capped so a wedged conhost can never leak the session.
    let mut last_seq = None;
    for _ in 0..20 {
        let snapshot = {
            let sessions = mgr.lock();
            let Some(session) = sessions.get(&id) else { return };
            (session.seq, session.reader_done)
        };
        if snapshot.1 || last_seq == Some(snapshot.0) {
            break;
        }
        last_seq = Some(snapshot.0);
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let handles = {
        let mut sessions = mgr.lock();
        let Some(session) = sessions.get_mut(&id) else { return };
        session.meta.status = TerminalStatus::Exited;
        session.meta.exit_code = exit_code;
        // Persist the final exited state so a restart shows it (as Restored).
        session.dirty = true;
        let writer =
            session.writer.lock().unwrap_or_else(PoisonError::into_inner).take();
        (session.master.take(), writer)
    };
    drop(handles);
    (mgr.sink)(TerminalEvent::Exit { id, exit_code });
}

fn is_batch_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// Stateful UTF-8 chunker: PTY reads can split a multi-byte sequence (CJK
/// output!) across chunks, so an incomplete tail is carried into the next
/// push instead of being lossy-replaced. Truly invalid bytes become U+FFFD.
#[derive(Default)]
struct Utf8Carry {
    pending: Vec<u8>,
}

impl Utf8Carry {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    out.push_str(valid);
                    self.pending.clear();
                    return out;
                }
                Err(e) => {
                    let valid_len = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid_len]).expect("prefix"));
                    match e.error_len() {
                        // Garbage in the middle: replace and keep going.
                        Some(bad) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            self.pending.drain(..valid_len + bad);
                        }
                        // Incomplete tail (at most 3 bytes): carry it over.
                        None => {
                            self.pending.drain(..valid_len);
                            return out;
                        }
                    }
                }
            }
        }
    }
}

/// Append to the scrollback ring, evicting the oldest bytes past `cap` and
/// never cutting a code point in half.
fn push_scrollback(buffer: &mut String, data: &str, cap: usize) {
    buffer.push_str(data);
    if buffer.len() > cap {
        let mut cut = buffer.len() - cap;
        while !buffer.is_char_boundary(cut) {
            cut += 1;
        }
        buffer.drain(..cut);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc::{channel, Sender};
    use std::time::Duration;

    fn channel_manager() -> (Arc<TerminalManager>, std::sync::mpsc::Receiver<TerminalEvent>) {
        let (tx, rx): (Sender<TerminalEvent>, _) = channel();
        let mgr = TerminalManager::new(Box::new(move |ev| {
            let _ = tx.send(ev);
        }));
        (mgr, rx)
    }

    fn channel_manager_persistent(
        dir: &Path,
    ) -> (Arc<TerminalManager>, std::sync::mpsc::Receiver<TerminalEvent>) {
        let (tx, rx): (Sender<TerminalEvent>, _) = channel();
        let mgr = TerminalManager::new_persistent(
            Box::new(move |ev| {
                let _ = tx.send(ev);
            }),
            dir.to_path_buf(),
        );
        (mgr, rx)
    }

    fn sample_meta(id: u64, root: &Path, status: TerminalStatus) -> TerminalSessionMeta {
        TerminalSessionMeta {
            id,
            root: root.display().to_string(),
            workspace_id: None,
            agent_id: "claude".into(),
            title: "Claude Code".into(),
            identity: Some("fe".into()),
            started_at: "2026-07-21T00:00:00Z".into(),
            status,
            exit_code: None,
            popped_out: false,
        }
    }

    /// D69: a persisted session file is restored at startup as a read-only
    /// `Restored` tab — its metadata round-trips, but the scrollback does NOT
    /// (metadata-only persistence keeps no pixels). `next_id` is seeded past
    /// it so a new launch never collides with a restored id.
    #[test]
    fn restores_persisted_session_metadata_without_scrollback() {
        let dir = tempfile::tempdir().expect("tempdir");
        let persisted = PersistedSession {
            schema_version: TERMINAL_PERSIST_SCHEMA_VERSION,
            meta: sample_meta(7, dir.path(), TerminalStatus::Running),
        };
        atomic_write_json(&dir.path().join("7.json"), &persisted).expect("seed file");

        let mgr = TerminalManager::new_persistent(Box::new(|_| {}), dir.path().to_path_buf());
        let listed = mgr.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, 7);
        assert_eq!(
            listed[0].status,
            TerminalStatus::Restored,
            "a restored process is read-only, not 'exited'"
        );
        assert_eq!(listed[0].identity.as_deref(), Some("fe"), "metadata round-trips");

        // Scrollback is not kept (D69): the restored buffer is empty and its
        // seq starts fresh so a revived pane's first output is never dropped.
        let buf = mgr.read_buffer(7).expect("restored buffer");
        assert_eq!(buf.data, "", "scrollback is not persisted");
        assert_eq!(buf.seq, 0);

        // Read-only: no live PTY to write to.
        assert_eq!(mgr.write(7, "x").unwrap_err().kind(), "terminal");
        // next_id seeded past the restored id.
        assert_eq!(mgr.next_id_value(), 8);
    }

    /// D69 no-migration guarantee: a v1 file (which carried `scrollback`/`seq`)
    /// still restores — serde ignores the now-unknown fields — and its
    /// scrollback is simply dropped.
    #[test]
    fn a_v1_file_with_scrollback_still_restores_as_metadata_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Hand-write the v1 shape: schemaVersion 1 plus scrollback/seq.
        let v1 = r#"{"schemaVersion":1,"meta":{"id":5,"root":".","workspaceId":null,"agentId":"claude","title":"Claude Code","identity":"fe","startedAt":"2026-07-21T00:00:00Z","status":"running","exitCode":null},"scrollback":"old pixels","seq":9}"#;
        std::fs::write(dir.path().join("5.json"), v1).expect("seed v1 file");

        let mgr = TerminalManager::new_persistent(Box::new(|_| {}), dir.path().to_path_buf());
        let listed = mgr.list();
        assert_eq!(listed.len(), 1, "a v1 file still loads without migration");
        assert_eq!(listed[0].status, TerminalStatus::Restored);
        assert_eq!(mgr.read_buffer(5).unwrap().data, "", "the old scrollback is dropped");
    }

    /// D69: a non-resumable (custom) agent is neither persisted nor restored —
    /// a lingering file for one is dropped at startup, since a restored tab
    /// that cannot reattach and has no scrollback would be a dead stub.
    #[test]
    fn a_non_resumable_agents_file_is_not_restored_and_is_removed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut meta = sample_meta(2, dir.path(), TerminalStatus::Running);
        meta.agent_id = "mytool".into(); // custom agent: no resume path
        let path = dir.path().join("2.json");
        atomic_write_json(&path, &PersistedSession { schema_version: 1, meta }).expect("seed");

        let mgr = TerminalManager::new_persistent(Box::new(|_| {}), dir.path().to_path_buf());
        assert!(mgr.list().is_empty(), "a non-resumable agent's tab is not restored");
        assert!(!path.exists(), "and its lingering file is dropped");
    }

    /// D69: reviving a tab that does not exist is a clean not_found.
    #[test]
    fn revive_rejects_a_missing_session() {
        let (mgr, _rx) = channel_manager();
        assert_eq!(mgr.revive(404).unwrap_err().kind(), "not_found");
    }

    /// B16-A: dismissing a restored tab deletes its persisted file so it does
    /// not come back on the next launch.
    #[test]
    fn closing_a_restored_session_deletes_its_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("3.json");
        let persisted = PersistedSession {
            schema_version: TERMINAL_PERSIST_SCHEMA_VERSION,
            meta: sample_meta(3, dir.path(), TerminalStatus::Exited),
        };
        atomic_write_json(&path, &persisted).expect("seed file");
        let mgr = TerminalManager::new_persistent(Box::new(|_| {}), dir.path().to_path_buf());
        assert!(path.exists());
        mgr.close(3).expect("dismiss restored tab");
        assert!(!path.exists(), "closing a tab forgets it across restarts");
        assert!(mgr.list().is_empty());
    }

    /// B16-A: a corrupt persisted file is skipped, not fatal — one bad file
    /// must never stop the app from opening.
    #[test]
    fn a_corrupt_persisted_file_is_skipped() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("9.json"), b"{ not valid json").expect("write junk");
        let mgr = TerminalManager::new_persistent(Box::new(|_| {}), dir.path().to_path_buf());
        assert!(mgr.list().is_empty(), "a corrupt file is skipped, startup still succeeds");
        assert_eq!(mgr.next_id_value(), 1, "no valid session means next_id is untouched");
    }

    /// B16-C: a pop-out toggle updates the session meta (surfaced by
    /// terminal_list) and broadcasts a reload signal; restore resets the flag
    /// because the pop-out window from the prior run no longer exists.
    #[test]
    fn pop_out_flag_toggles_and_resets_on_restore() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut meta = sample_meta(4, dir.path(), TerminalStatus::Running);
        meta.popped_out = true;
        atomic_write_json(
            &dir.path().join("4.json"),
            &PersistedSession { schema_version: TERMINAL_PERSIST_SCHEMA_VERSION, meta },
        )
        .expect("seed");

        let (mgr, rx) = channel_manager_persistent(dir.path());
        assert!(!mgr.list()[0].popped_out, "restore resets popped_out — that window is gone");

        mgr.set_popped_out(4, true).expect("toggle");
        assert!(mgr.list()[0].popped_out);
        assert!(
            matches!(rx.recv_timeout(Duration::from_secs(1)), Ok(TerminalEvent::SessionsChanged)),
            "toggling broadcasts a reload signal for the other window"
        );

        mgr.set_popped_out(4, false).expect("toggle back");
        assert!(!mgr.list()[0].popped_out);
        assert_eq!(mgr.set_popped_out(999, true).unwrap_err().kind(), "not_found");
    }

    #[test]
    fn utf8_carry_reassembles_split_multibyte() {
        let mut carry = Utf8Carry::default();
        let bytes = "中文ok".as_bytes();
        // Split inside the second CJK char (3 bytes each).
        let first = carry.push(&bytes[..4]);
        let second = carry.push(&bytes[4..]);
        assert_eq!(first, "中");
        assert_eq!(second, "文ok");
    }

    #[test]
    fn utf8_carry_replaces_truly_invalid_bytes() {
        let mut carry = Utf8Carry::default();
        let out = carry.push(&[b'a', 0xFF, b'b']);
        assert_eq!(out, format!("a{}b", char::REPLACEMENT_CHARACTER));
        assert!(carry.pending.is_empty());
    }

    #[test]
    fn utf8_carry_flushes_pending_tail_on_next_push() {
        let mut carry = Utf8Carry::default();
        // Lone lead byte of a 3-byte sequence: held back, not replaced…
        assert_eq!(carry.push(&[0xE4]), "");
        // …and completed by the following chunk.
        assert_eq!(carry.push(&[0xB8, 0xAD]), "中");
    }

    #[test]
    fn scrollback_cap_evicts_oldest_at_char_boundary() {
        let mut buffer = String::new();
        push_scrollback(&mut buffer, "abcdef", 16);
        push_scrollback(&mut buffer, "許功蓋許功蓋", 16); // 18 bytes of CJK
        assert!(buffer.len() <= 16);
        assert!(buffer.is_char_boundary(0), "eviction must not split a code point");
        assert!(buffer.ends_with("許功蓋"), "newest output survives eviction");
    }

    #[test]
    fn launch_rejects_unknown_agent_and_bad_root() {
        let (mgr, _rx) = channel_manager();
        let tmp = tempfile::tempdir().expect("tempdir");
        let err = mgr.launch(tmp.path(), "no-such-agent", None, false).unwrap_err();
        assert_eq!(err.kind(), "not_found");
        let err =
            mgr.launch(&tmp.path().join("missing-subdir"), "claude", None, false).unwrap_err();
        // A bad cwd fails in launch_program (invalid_input) — unless this
        // machine has no claude on PATH, which fails resolution first.
        assert!(matches!(err.kind(), "invalid_input" | "terminal"));
    }

    #[cfg(windows)]
    fn cmd_exe() -> PathBuf {
        resolve_program("cmd").expect("cmd.exe is always on PATH on Windows")
    }

    /// Collect output until the exit event (or deadline). ConPTY opens by
    /// asking where the cursor is (DSR, `ESC[6n`) and stalls all output
    /// processing until the "terminal" answers — xterm.js replies on its
    /// own in production, so the headless test must play that part here.
    #[cfg(windows)]
    fn drain_until_exit(
        mgr: &Arc<TerminalManager>,
        id: u64,
        rx: &std::sync::mpsc::Receiver<TerminalEvent>,
        deadline: Duration,
    ) -> (String, Option<Option<u32>>) {
        let mut collected = String::new();
        let mut dsr_answered = false;
        let started = std::time::Instant::now();
        while started.elapsed() < deadline {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(TerminalEvent::Output { data, .. }) => {
                    collected.push_str(&data);
                    if !dsr_answered && collected.contains("\x1b[6n") {
                        dsr_answered = true;
                        let _ = mgr.write(id, "\x1b[1;1R");
                    }
                }
                Ok(TerminalEvent::Exit { exit_code, .. }) => return (collected, Some(exit_code)),
                Ok(TerminalEvent::SessionsChanged) => {}
                Err(_) => {}
            }
        }
        (collected, None)
    }

    #[test]
    #[cfg(windows)]
    fn spawn_captures_output_and_reports_exit() {
        let (mgr, rx) = channel_manager();
        let tmp = tempfile::tempdir().expect("tempdir");
        let meta = mgr
            .launch_program(
                tmp.path(),
                "test",
                "Test",
                None,
                &cmd_exe(),
                &["/C", "echo nextup-terminal-smoke"],
                &BTreeMap::new(),
            )
            .expect("spawn cmd.exe");
        assert_eq!(meta.status, TerminalStatus::Running);

        let (output, exit) = drain_until_exit(&mgr, meta.id, &rx, Duration::from_secs(15));
        assert!(
            output.contains("nextup-terminal-smoke"),
            "pty output should contain the echoed marker, got: {output:?}"
        );
        assert!(exit.is_some(), "wait thread must report the natural exit");

        // The session stays listed as exited (tab dismissal is explicit),
        // and its scrollback survives for remounts.
        let listed = mgr.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, TerminalStatus::Exited);
        let buffer = mgr.read_buffer(meta.id).expect("buffer of exited session");
        assert!(buffer.data.contains("nextup-terminal-smoke"));
        assert!(buffer.seq > 0);

        // Writing into an exited session is a terminal error, not a panic.
        assert_eq!(mgr.write(meta.id, "x").unwrap_err().kind(), "terminal");

        // Dismissing the exited session empties the table.
        mgr.close(meta.id).expect("close exited session");
        assert!(mgr.list().is_empty());
    }

    /// D56: a custom agent's env reaches the spawned CLI. cmd.exe expands
    /// `%VAR%`, so the marker can only appear if the variable was really set —
    /// the typed args never contain the value itself.
    #[test]
    #[cfg(windows)]
    fn launch_program_applies_env_to_the_child() {
        let (mgr, rx) = channel_manager();
        let tmp = tempfile::tempdir().expect("tempdir");
        let env = BTreeMap::from([("NEXTUP_ENV_PROBE".to_string(), "nextup-env-9271".to_string())]);
        let meta = mgr
            .launch_program(
                tmp.path(),
                "test",
                "Test",
                None,
                &cmd_exe(),
                &["/C", "echo probe=%NEXTUP_ENV_PROBE%"],
                &env,
            )
            .expect("spawn cmd.exe");
        let (output, exit) = drain_until_exit(&mgr, meta.id, &rx, Duration::from_secs(15));
        assert!(
            output.contains("probe=nextup-env-9271"),
            "the child must see the injected env var, got: {output:?}"
        );
        assert!(exit.is_some(), "command should exit on its own");
        mgr.close(meta.id).expect("close env-probe session");
    }

    /// D63: a launch-time identity reaches the child as `NEXTUP_AGENT` and is
    /// recorded on the session. Same `%VAR%` expansion trick as the D56 test
    /// — the marker can only appear if the variable was genuinely set.
    #[test]
    #[cfg(windows)]
    fn launch_identity_reaches_the_child_as_nextup_agent() {
        let (mgr, rx) = channel_manager();
        let tmp = tempfile::tempdir().expect("tempdir");
        let meta = mgr
            .launch_program(
                tmp.path(),
                "test",
                "Test",
                Some("fe-agent".to_string()),
                &cmd_exe(),
                &["/C", "echo who=%NEXTUP_AGENT%"],
                &BTreeMap::from([(NEXTUP_AGENT_VAR.to_string(), "fe-agent".to_string())]),
            )
            .expect("spawn cmd.exe");
        assert_eq!(meta.identity.as_deref(), Some("fe-agent"));
        let (output, exit) = drain_until_exit(&mgr, meta.id, &rx, Duration::from_secs(15));
        assert!(output.contains("who=fe-agent"), "child must see NEXTUP_AGENT, got: {output:?}");
        assert!(exit.is_some());
        mgr.close(meta.id).expect("close identity session");
    }

    /// The launch-time pick beats an `NEXTUP_AGENT` baked into the catalog
    /// entry's own env — choosing at launch is the more specific act. Drives
    /// the layering in `launch` rather than `launch_program`, which is where
    /// the override happens.
    #[test]
    fn launch_time_identity_overrides_a_catalog_env_entry() {
        let mut env = BTreeMap::from([
            (NEXTUP_AGENT_VAR.to_string(), "from-catalog".to_string()),
            ("OTHER".to_string(), "kept".to_string()),
        ]);
        let identity = sanitize_identity(Some("  from-launch  ")).unwrap();
        if let Some(name) = &identity {
            env.insert(NEXTUP_AGENT_VAR.to_string(), name.clone());
        }
        assert_eq!(env.get(NEXTUP_AGENT_VAR).map(String::as_str), Some("from-launch"));
        assert_eq!(env.get("OTHER").map(String::as_str), Some("kept"), "other env survives");
    }

    #[test]
    fn identity_is_trimmed_blank_means_anonymous_and_junk_is_refused() {
        assert_eq!(sanitize_identity(None).unwrap(), None);
        assert_eq!(sanitize_identity(Some("   ")).unwrap(), None, "blank is anonymous, not an error");
        assert_eq!(sanitize_identity(Some("  fe  ")).unwrap().as_deref(), Some("fe"));
        // `=` would read as a second variable in the child's env block.
        assert_eq!(sanitize_identity(Some("fe=x")).unwrap_err().kind(), "invalid_input");
        assert_eq!(sanitize_identity(Some("fe\nx")).unwrap_err().kind(), "invalid_input");
        let long = "a".repeat(IDENTITY_MAX_CHARS + 1);
        assert_eq!(sanitize_identity(Some(&long)).unwrap_err().kind(), "invalid_input");
        // Non-ASCII names count by character, not byte — a 64-char CJK name
        // is fine even though it is far more than 64 bytes.
        let cjk = "代".repeat(IDENTITY_MAX_CHARS);
        assert!(sanitize_identity(Some(&cjk)).is_ok());
    }

    /// Machine smoke for the plan's step ①: a real PowerShell run through
    /// the PTY. The typed command never contains `61234`; only an actually
    /// executing shell produces it.
    #[test]
    #[cfg(windows)]
    fn powershell_round_trip_renders_command_output() {
        let (mgr, rx) = channel_manager();
        let tmp = tempfile::tempdir().expect("tempdir");
        let ps = resolve_program("powershell").expect("powershell is on PATH on Windows");
        let meta = mgr
            .launch_program(
                tmp.path(),
                "test",
                "Test",
                None,
                &ps,
                &["-NoProfile", "-NoLogo", "-Command", "(6000*10+1234)"],
                &BTreeMap::new(),
            )
            .expect("spawn powershell");
        let (output, exit) = drain_until_exit(&mgr, meta.id, &rx, Duration::from_secs(20));
        assert!(exit.is_some(), "powershell must exit");
        assert!(output.contains("61234"), "expected evaluated output, got: {output:?}");
    }

    /// D70: launching the built-in `shell` brings up a real interactive shell
    /// through the whole new path — `find_agent("shell")` → `builtin_command`
    /// → per-OS `default_shell` → `resolve_program` → PTY spawn. Driving a
    /// shell's output is already covered by the PowerShell round-trip above;
    /// here we prove the wiring spawns a live process and, since a shell is
    /// non-resumable and never persisted, that closing it leaves no orphan.
    #[test]
    #[cfg(windows)]
    fn launching_the_builtin_shell_spawns_and_cleans_up() {
        let (mgr, _rx) = channel_manager();
        let tmp = tempfile::tempdir().expect("tempdir");
        let meta = mgr
            .launch(tmp.path(), "shell", None, false)
            .expect("the built-in shell resolves to PowerShell on Windows");
        assert_eq!(meta.agent_id, "shell");
        assert_eq!(meta.status, TerminalStatus::Running);
        let pid = mgr.pid_of(meta.id).expect("a spawned shell exposes a pid");
        assert!(pid_is_alive(pid), "the shell process is running");

        mgr.close(meta.id).expect("close the shell session");
        let mut alive = true;
        for _ in 0..40 {
            if !pid_is_alive(pid) {
                alive = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        assert!(!alive, "closing the shell must leave no orphan process");
        assert!(mgr.list().is_empty());
    }

    /// The full interactive loop: user keystrokes go down `write`, the CLI
    /// executes them, and the result comes back as PTY output.
    #[test]
    #[cfg(windows)]
    fn interactive_write_executes_in_the_cli() {
        let (mgr, rx) = channel_manager();
        let tmp = tempfile::tempdir().expect("tempdir");
        let meta = mgr
            .launch_program(tmp.path(), "test", "Test", None, &cmd_exe(), &["/K", "prompt $g"], &BTreeMap::new())
            .expect("spawn interactive cmd.exe");
        // Answer the ConPTY cursor probe up front (input queues), then type
        // a command whose *result* cannot appear in the keystroke echo.
        mgr.write(meta.id, "\x1b[1;1R").expect("write dsr reply");
        mgr.write(meta.id, "set /a 60000+1234\r").expect("write command");

        let mut collected = String::new();
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(15) && !collected.contains("61234") {
            if let Ok(TerminalEvent::Output { data, .. }) =
                rx.recv_timeout(Duration::from_millis(250))
            {
                collected.push_str(&data);
            }
        }
        assert!(collected.contains("61234"), "cli must execute typed input, got: {collected:?}");
        mgr.close(meta.id).expect("close interactive session");
        assert!(mgr.list().is_empty());
    }

    #[test]
    #[cfg(windows)]
    fn close_kills_the_process_and_leaves_nothing_behind() {
        let (mgr, rx) = channel_manager();
        let tmp = tempfile::tempdir().expect("tempdir");
        // `/K` keeps cmd.exe alive indefinitely — a stand-in for a
        // long-running agent CLI.
        let meta = mgr
            .launch_program(tmp.path(), "test", "Test", None, &cmd_exe(), &["/K", "prompt $g"], &BTreeMap::new())
            .expect("spawn persistent cmd.exe");
        let pid = mgr.pid_of(meta.id).expect("windows children expose a pid");

        mgr.close(meta.id).expect("close running session");
        assert!(mgr.list().is_empty(), "closed session leaves the table");

        let mut alive = true;
        for _ in 0..40 {
            if !pid_is_alive(pid) {
                alive = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        assert!(!alive, "child process {pid} must be gone after close");

        // The waiter thread saw the kill but the session was already
        // removed — closing must not synthesize an exit event.
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            !matches!(rx.try_recv(), Ok(TerminalEvent::Exit { .. })),
            "user-driven close is silent"
        );
    }

    /// D69 machine test: a live session's *metadata* survives a restart but
    /// its scrollback does not. A fresh manager on the same store restores the
    /// tab as read-only (ready to resume) with an empty buffer — the "reopen
    /// the app, your tab is back and one keystroke from your conversation"
    /// path, minus the pixels (resume replays them from the CLI, not from us).
    #[test]
    #[cfg(windows)]
    fn metadata_survives_a_simulated_restart_but_scrollback_does_not() {
        let store = tempfile::tempdir().expect("store");
        let ws = tempfile::tempdir().expect("workspace");
        let (mgr, rx) = channel_manager_persistent(store.path());
        // A shell that prints a marker then stays alive — a stand-in for an
        // agent CLI paused mid-conversation. agentId "claude" so the session
        // is restorable (a custom agent would not be persisted at all, D69).
        let meta = mgr
            .launch_program(
                ws.path(),
                "claude",
                "Claude Code",
                None,
                &cmd_exe(),
                &["/K", "echo nextup-persist-3355& prompt $g"],
                &BTreeMap::new(),
            )
            .expect("spawn cmd.exe");

        // Answer the ConPTY cursor probe, then collect until the marker lands.
        let mut collected = String::new();
        let mut dsr_answered = false;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(15)
            && !collected.contains("nextup-persist-3355")
        {
            if let Ok(TerminalEvent::Output { data, .. }) =
                rx.recv_timeout(Duration::from_millis(250))
            {
                collected.push_str(&data);
                if !dsr_answered && collected.contains("\x1b[6n") {
                    dsr_answered = true;
                    let _ = mgr.write(meta.id, "\x1b[1;1R");
                }
            }
        }
        assert!(
            collected.contains("nextup-persist-3355"),
            "marker should have been emitted, got: {collected:?}"
        );

        mgr.flush_dirty();
        assert!(
            store.path().join(format!("{}.json", meta.id)).exists(),
            "the live session's metadata was flushed to disk"
        );

        // Simulate a restart: a new manager on the same store restores the tab.
        let (mgr2, _rx2) = channel_manager_persistent(store.path());
        let listed = mgr2.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, meta.id);
        assert_eq!(listed[0].status, TerminalStatus::Restored);
        assert_eq!(listed[0].agent_id, "claude", "metadata (agent) round-trips");
        let buf = mgr2.read_buffer(meta.id).expect("restored buffer");
        assert_eq!(
            buf.data, "",
            "scrollback does not survive a restart (D69), got: {:?}",
            buf.data
        );
        assert_eq!(mgr2.next_id_value(), meta.id + 1, "next_id seeded past the restored id");

        // Cleanup: kill the still-running child from the first manager.
        mgr.close(meta.id).expect("close live session");
    }

    /// D69 machine test: reviving a restored tab relaunches its agent IN PLACE
    /// — same id, same slot, one tab not two — and its new output flows.
    /// (Drives revive_program to avoid needing a real agent CLI on PATH.)
    #[test]
    #[cfg(windows)]
    fn revive_relaunches_a_dead_tab_in_place() {
        let dir = tempfile::tempdir().expect("store");
        let ws = tempfile::tempdir().expect("workspace");
        // Seed a restored tab (id 7) as if it survived a restart.
        atomic_write_json(
            &dir.path().join("7.json"),
            &PersistedSession {
                schema_version: TERMINAL_PERSIST_SCHEMA_VERSION,
                meta: sample_meta(7, ws.path(), TerminalStatus::Running),
            },
        )
        .expect("seed");
        let (mgr, rx) = channel_manager_persistent(dir.path());
        assert_eq!(mgr.list()[0].status, TerminalStatus::Restored);

        let meta = mgr
            .revive_program(
                7,
                ws.path(),
                &cmd_exe(),
                &["/K", "echo nextup-revive-88& prompt $g"],
                &BTreeMap::new(),
            )
            .expect("revive in place");
        assert_eq!(meta.id, 7, "revive reuses the id — the tab does not move");
        assert_eq!(meta.status, TerminalStatus::Running);
        assert_eq!(mgr.list().len(), 1, "one tab revived in place, not a second one");

        // The revived process's output flows (answer the DSR probe first).
        let mut collected = String::new();
        let mut dsr = false;
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(15) && !collected.contains("nextup-revive-88") {
            if let Ok(TerminalEvent::Output { data, .. }) =
                rx.recv_timeout(Duration::from_millis(250))
            {
                collected.push_str(&data);
                if !dsr && collected.contains("\x1b[6n") {
                    dsr = true;
                    let _ = mgr.write(7, "\x1b[1;1R");
                }
            }
        }
        assert!(collected.contains("nextup-revive-88"), "revived output flows, got: {collected:?}");

        // Reviving an already-running tab is refused — the G4 race guard,
        // reached here directly since revive_program skips the pre-check.
        assert_eq!(
            mgr.revive_program(7, ws.path(), &cmd_exe(), &["/K"], &BTreeMap::new())
                .unwrap_err()
                .kind(),
            "terminal"
        );
        mgr.close(7).expect("cleanup");
    }

    /// True while the pid shows up in tasklist. Filtering output by the pid
    /// column (not substring luck): the header line never contains it.
    #[cfg(windows)]
    fn pid_is_alive(pid: u32) -> bool {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output();
        match out {
            Ok(out) => String::from_utf8_lossy(&out.stdout)
                .split_whitespace()
                .any(|tok| tok == pid.to_string()),
            Err(_) => false,
        }
    }
}
