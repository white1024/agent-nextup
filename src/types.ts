// DTO mirrors of the Rust core types (serde camelCase).

/** `cancelled` (D169): closed without being done — superseded or dropped. */
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";

export interface Task {
  schemaVersion: number;
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  tags: string[];
  blockedReason?: string | null;
  /** When blockedReason was written. Nothing recomputes a reason, so its age
   * is the only cue that it may no longer hold. Cleared with the reason. */
  blockedAt?: string | null;
  /** Why the task was cancelled (D169); required on the way in, cleared on the way out. */
  cancelReason?: string | null;
  /** Collaboration fields (D31): always in the schema; the collab module only gates exposure. */
  assignee?: string;
  dependsOn?: string[];
  /** The task's own checklist (D170): describes the work, never moves status. */
  steps?: TaskStep[];
  /** Set only when the done claim was checked against reality (evidence in verifiedNote). */
  verifiedAt?: string | null;
  verifiedNote?: string | null;
  /** Archived = closed and hidden from default listings (D40). */
  archived: boolean;
  /** When this task's delta specs were folded into specs/ on archive (D79);
   * cleared by the engine when the task leaves done. */
  specFoldedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  title: string;
  description: string;
  priority: number;
  tags: string[];
  assignee?: string;
  dependsOn?: string[];
}

/**
 * The editable attribute set of a task. Status, verification, archive and
 * assignee each keep their own operation (own rules, own ledger kind) — an
 * edit can never move them.
 */
export interface TaskStep {
  title: string;
  done: boolean;
}

export interface TaskEdit {
  title: string;
  description: string;
  priority: number;
  tags: string[];
  /** The whole step list by title (D170); a title already there keeps its checkmark. */
  steps?: string[] | null;
}

export interface TaskCounts {
  total: number;
  todo: number;
  inProgress: number;
  blocked: number;
  done: number;
  /** Closed without being done (D169): in `total`, never in a progress denominator. */
  cancelled: number;
  doneUnverified: number;
}

export interface WorkspaceInfo {
  root: string;
  name: string;
  domain: string;
  description: string;
}

export interface SystemStatus {
  appVersion: string;
  /**
   * Still sent by the backend, no longer read by any view: D88 removed the
   * dashboard keystore row and the About line along with the API-keys panel.
   * Kept so this type matches the actual payload — delete only if
   * `SystemStatus` in `state.rs` drops the fields too.
   */
  keystoreOk: boolean;
  keystoreDescription: string;
  workspace: WorkspaceInfo | null;
  taskCounts: TaskCounts | null;
}

export type LedgerKind =
  | "project_initialized"
  | "workspace_opened"
  | "task_created"
  | "task_status_changed"
  | "task_verification_changed"
  | "decision"
  | "alternative_rejected"
  | "note"
  | "progress"
  | "handoff_generated"
  | "backup_exported"
  | "backup_imported"
  | "secret_updated"
  | "phase_advanced"
  | "gate_confirmed"
  | "workflow_adopted"
  | "mcp_tool_called"
  | "index_built"
  | "milestone_updated"
  | "task_assignee_changed"
  | "lesson_updated"
  | "agent_tool_called"
  | "assets_upgraded"
  | "task_archived"
  | "spec_folded"
  | "task_edited"
  | "task_deleted"
  | "workspace_id_assigned"
  | "delivery_published"
  | "delivery_routed"
  | "delivery_received"
  | "context_edited";

/** The three free-form ledger channels a session may write directly (D78) —
 * every other kind is engine-stamped by its own operation. */
export type LedgerChannel = "decision" | "note" | "progress";

/** Workspace behavior settings (.nextup/settings.json, D78). */
export interface WorkspaceSettings {
  schemaVersion: number;
  autoArchive: {
    /** Sweep verified-done tasks into the archive on workspace open. */
    enabled: boolean;
    /** Only tasks verified at least this many days ago are swept. */
    days: number;
  };
}

export interface LedgerEvent {
  at: string;
  kind: LedgerKind;
  message: string;
  taskId?: string | null;
  /** Self-declared identity of the external agent behind this event (D31); absent for GUI/engine events. */
  actor?: string;
  /** ── Structured mirrors of message semantics (D75) — absent on pre-D75 lines ── */
  /** Hub tool behind an `agent_tool_called` line. */
  tool?: string;
  /** How an `agent_tool_called` attempt ended. */
  outcome?: "ok" | "failed" | "denied";
  /** How a `phase_advanced` transition happened (`advance`/`override`). */
  via?: string;
  /** Override force-reason, or the denial cause on `agent_tool_called`. */
  reason?: string;
  /** Transition endpoints for `task_status_changed`. */
  from?: TaskStatus;
  to?: TaskStatus;
  /** ── Decision identity and supersession — decisions only, absent on older lines ── */
  /** Workspace-local decision id (`D-0001`), so a later decision can point at this one. */
  id?: string;
  /**
   * The decision id this decision overturns. Set on the NEW line only — the ledger is
   * append-only, so the superseded line is never edited. Read the other direction with
   * `supersession()`.
   */
  supersedes?: string;
}

/** Ledger tail after a caller-held line cursor, for the notify layer (D62). */
export interface LedgerTail {
  /** Chronological, capped at the shared recent-window ceiling. */
  events: LedgerEvent[];
  /** Cursor to pass back next time (the file's line count as read). */
  nextLine: number;
  /**
   * The ledger is shorter than the cursor, so it was replaced rather than
   * appended to. `events` is empty by design — resync to `nextLine` instead of
   * announcing history that may already have been seen.
   */
  reset: boolean;
}

/** One page of ledger history for the Ledger view (D47). */
export interface LedgerPage {
  /** Newest-first. */
  events: LedgerEvent[];
  /** Matches under the active filter across the whole ledger, not just this page. */
  total: number;
  /**
   * For each decision on this page that a later decision overturned, the ids that
   * overturned it. The engine computes this over the whole ledger — do not re-derive it
   * from `events`: a superseding decision is newer, so on page 2 the reversal is back on
   * page 1 and a local projection would show a dead decision as live.
   */
  superseded: Record<string, string[]>;
}

/** One capability row of the spec layer (D79). */
export interface SpecOverview {
  capability: string;
  requirements: number;
  /** Why this row could not be read — present only for broken files (the row
   * still lists so one bad spec.md never hides the rest of the rail). */
  problem?: string;
}

/** What one archive folded into specs/ (D79) — for the outcome toast. */
export interface SpecFoldSummary {
  capabilities: string[];
  added: number;
  modified: number;
  removed: number;
  renamed: number;
  /** Requirements deliberately given up rather than folded (D129). */
  skipped?: string[];
}

/** One requirement two tasks' deltas both change (D129). */
export interface SpecOverlap {
  capability: string;
  requirement: string;
  otherTask: string;
  /** The other task already folded — its text is in `specs/` now. */
  otherFolded: boolean;
  /** The other task is newer, so by the project's rule its wording wins. */
  otherNewer: boolean;
}

/** Dry-run fold report for one task's delta bundle (D79). */
export interface TaskSpecsReport {
  taskId: string;
  capabilities: string[];
  ok: boolean;
  problems: string[];
  warnings: string[];
  alreadySynced: string[];
  /** Requirements another task's delta also changes (D129). */
  overlaps: SpecOverlap[];
  added: number;
  modified: number;
  removed: number;
  renamed: number;
}

export interface TaskUpdate {
  task: Task;
  handoff: string | null;
  /** Present only when the archive folded delta specs (D79). */
  specFold?: SpecFoldSummary;
}

export interface InitProjectParams {
  root: string;
  name: string;
  domain: string;
  description: string;
  goals: string[];
  boundaries: string[];
  templateId?: string;
  /** UI language tag ("zh-TW"/"en") — built-in template content follows it (D54).
   *  Injected centrally by api.initializeProject/adoptLegacyProject. */
  templateLang?: string;
  /** Capability modules to enable from day one (wizard checkboxes, D31); omit for none. */
  modules?: string[];
  /** New-workspace flow (D44): core creates the root itself and refuses a pre-existing folder. */
  createRoot?: boolean;
  /** Grant every exposed write tool at creation, guarded ones included (D150); omit for the D63 day-one grant. */
  grantAllTools?: boolean;
  /** The folder brings its own method (D170): lay down only the takeover layer. */
  ownMethod?: boolean;
  /** Staged or ongoing (D171); omitted = ongoing when the template can run that way. */
  mode?: WorkflowMode;
}

/** Live collision check for the init wizard's target folder (D44). */
export interface InitTargetProbe {
  exists: boolean;
  isWorkspace: boolean;
}

// ── Workflow harness ────────────────────────────────────────────────────────

/**
 * How a project runs its template (D171): staged = phases closed by exit
 * gates; ongoing = the same method with no phases, a stream of tasks.
 */
export type WorkflowMode = "staged" | "ongoing";

export type Gate =
  | { kind: "min_tasks"; count: number }
  | { kind: "all_tasks_done" }
  | { kind: "no_blocked_tasks" }
  | { kind: "artifact_exists"; path: string }
  | { kind: "min_decisions"; count: number }
  | { kind: "manual_confirm"; prompt: string }
  | { kind: "doctor_clean" };

export interface GateEval {
  gate: Gate;
  passed: boolean;
  observed: string;
}

export interface WorkflowPhase {
  id: string;
  title: string;
  description: string;
  aiInstructions: string[];
  exitGates: Gate[];
}

export interface PhaseTransition {
  phase: string;
  enteredAt: string;
  via: string;
  reason?: string | null;
}

export interface GateConfirmation {
  phase: string;
  prompt: string;
  at: string;
}

export interface WorkflowState {
  currentPhase: string;
  completed: boolean;
  history: PhaseTransition[];
  confirmations: GateConfirmation[];
}

export interface Workflow {
  schemaVersion: number;
  templateId: string;
  templateName: string;
  /** Absent on a staged project — the engine writes it only when ongoing (D171). */
  mode?: WorkflowMode;
  phases: WorkflowPhase[];
  /** What an agent follows while the project runs ongoing (D171). */
  ongoingInstructions?: string[];
  state: WorkflowState;
}

export interface WorkflowStatus {
  workflow: Workflow;
  currentIndex: number;
  totalPhases: number;
  gates: GateEval[];
  canAdvance: boolean;
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  domainHint: string;
  phaseCount: number;
  /** Each phase's title and exit-gate kinds, in order (D155 ②) — enough to draw the band. */
  phases: PhaseOutline[];
  source: "built_in" | "custom";
  /** Carries its own ongoing instructions (D171); without them a project can only run staged. */
  supportsOngoing: boolean;
}

/** Just enough of a template phase to draw it. */
export interface PhaseOutline {
  title: string;
  gates: Gate["kind"][];
}

/** Full template body — same phase shape the workflow harness runs on. */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  domainHint: string;
  phases: WorkflowPhase[];
  /** What a project made from it follows while it runs ongoing; absent = staged only (D171 ⑧). */
  ongoingInstructions?: string[];
}

export interface WorkspaceChangedPayload {
  root: string;
  taskCounts: TaskCounts | null;
}

/**
 * The ledger grew (D62). Separate from `workspace://changed` on purpose: this
 * one means "read the new tail and decide whether to notify", never "re-read
 * state" — re-reading on every ledger append would loop, since every mutation
 * ends in one.
 */
export interface LedgerAppendedPayload {
  root: string;
}

// ── Agent hub access (nextup-mcp) ────────────────────────────────────────────
// (MCP client DTOs retired in D15 — agents bring their own MCP clients.)

/** .nextup/agent_access.json — hub-tool authorization for external agents. */
export interface AgentAccess {
  schemaVersion: number;
  enabled: boolean;
  allowedTools: string[];
  /** Every write tool this allowlist was settled against (D172); absent on files written before it. */
  knownTools?: string[];
}

/** One semantic write-tool group (D39) — presentation bundling only. */
export interface ToolGroupView {
  id: string;
  tools: string[];
}

export interface AgentAccessView {
  access: AgentAccess;
  readTools: string[];
  writeTools: string[];
  writeToolGroups: ToolGroupView[];
  /** Tool id → why it is off in a fresh workspace (D63). Absent = not guarded. */
  guardedReasons: Record<string, string>;
  /** Grants a restored backup parked for a person to accept or drop (D143); null when none. */
  restoredAccess: RestoredAccess | null;
  /** Day-one tools a newer version added, never offered here — what the asset upgrade will grant (D172). */
  pendingDefaultGrants: string[];
}

/** What the update dialog checks before it offers an install (D144). */
export interface UpdatePreflight {
  /** Running from the Windows portable zip: no in-app install. */
  portable: boolean;
  /** The bundled hub is held open by another process (Windows only). */
  hubBusy: boolean;
  /** Embedded terminal sessions an install would end. */
  runningTerminals: number;
}

export interface RestoredAccess {
  allowedTools: string[];
  exportedAt: string;
  /** The source's knownTools, applied with the grants (D172). */
  knownTools?: string[];
}

export interface AgentMcpStatus {
  resolvedPath: string | null;
  discoveryCommand: string | null;
  healthy: boolean;
}

// ── Capability modules (D31) ────────────────────────────────────────────────

/** .nextup/modules.json — which capability packs this workspace enables (e.g. "collab"). */
export interface WorkspaceModules {
  schemaVersion: number;
  enabled: string[];
}

// ── Teams & cross-workspace exchange (D48) ──────────────────────────────────

/** One member workspace: workspaceId is the key, root/name are display caches. */
export interface TeamMember {
  workspaceId: string;
  root: string;
  name: string;
}

/** Directed delivery edge: from delivers to to (workspace ids). */
export interface TeamEdge {
  from: string;
  to: string;
  /** When set, the app auto-sends outbox envelopes along this edge (D71). */
  autoRoute: boolean;
}

/** One node position on the team canvas (D53), canvas pixel coordinates. */
export interface NodePos {
  x: number;
  y: number;
}

/**
 * A team-canvas style (D157). Which one shows is a per-machine preference;
 * each keeps its own saved positions: `star` in `Team.layout`, `orbit` in
 * `Team.orbitLayout`.
 */
export type LayoutSkin = "star" | "orbit";

/** One app-level team (~/.nextup/teams.json). */
export interface Team {
  id: string;
  name: string;
  members: TeamMember[];
  /** In the order they were drawn — the canvas reads the edge that closed a loop as the flow back (D161). */
  edges: TeamEdge[];
  /** Saved star-map positions by workspaceId (D53); absent = auto-placed. */
  layout?: Record<string, NodePos>;
  /** The same for the orbit style (D157); a separate map, never shared. */
  orbitLayout?: Record<string, NodePos>;
  /**
   * The workspace whose agent may edit this team's graph and route its
   * deliveries (D116). Absent = no prime, humans drive it. Scoped per team:
   * the same workspace can be prime here and an ordinary member elsewhere.
   *
   * Never one of `members` (D117) — it coordinates from above the flow, so it
   * has no node on the canvas and no edges. It carries its own name and root
   * because there is no member row to read them from.
   */
  prime?: TeamMember;
  createdAt: string;
  /** When the team's content last changed. Re-linking a folder does not move it (D173 ③). */
  updatedAt: string;
}

/** One workspace a re-link pointed somewhere (D173 ①) — or, in `missing`, could not find. */
export interface RelinkedWorkspace {
  workspaceId: string;
  name: string;
  root: string;
}

export interface RelinkReport {
  relinked: RelinkedWorkspace[];
  missing: RelinkedWorkspace[];
}

export interface TeamsRelinked {
  teams: Team[];
  report: RelinkReport;
}

/** How one team in a team file relates to this machine's graph (D173 ②). */
export type ImportStatus = "new" | "same" | "differs";

export interface ImportRow {
  id: string;
  name: string;
  status: ImportStatus;
  members: number;
  edges: number;
  /** The coordinator's name — importing the team designates it here too. */
  prime: string | null;
  fileUpdatedAt: string;
  localName: string | null;
  localUpdatedAt: string | null;
}

export interface ImportPreview {
  exportedAt: string;
  appVersion: string;
  teams: ImportRow[];
}

export interface TeamsImported {
  teams: Team[];
  outcome: { added: number; replaced: number; relink: RelinkReport };
}

export interface DeliverySource {
  workspaceId: string;
  name: string;
}

export interface DeliveredVia {
  teamId: string;
  teamName: string;
}

/** One file delivered alongside the note (D71 Batch B; D73). Bytes live in the
 * envelope's `<box>/<id>/` sibling directory; the manifest keeps only name+size. */
export interface AttachmentRef {
  name: string;
  /** Where the file sat in the sender's workspace, and where it sits inside the
   * envelope directory. Absent when it came from outside that workspace (a file
   * picker) and on pre-D86 envelopes, which were stored flat under `name`. */
  path?: string | null;
  sizeBytes: number;
}

/** Envelope listing row (full attachment manifest omitted). */
export interface DeliverySummary {
  id: string;
  from: DeliverySource;
  payloadType: string;
  /** How many files ride with the envelope — drives the 📎 chip. */
  attachmentCount: number;
  /** The envelope this one corrects, and the one that replaced it — both from
   * the manifest. The back-reference is stored, not derived: routing moves the
   * replacement out of the outbox, so a derived mark would vanish the moment
   * the correction was sent. */
  supersedes?: string | null;
  supersededBy?: string | null;
  /** The downstream projects the publisher named (D176); absent = every one. */
  addressedTo?: DeliverySource[];
  note?: string;
  /** The note was clamped to its first line for a brief listing; the rest is
   * behind `exchange_get`. Only the hub asks for brief listings today. */
  noteTruncated?: boolean;
  publishedAt: string;
  deliveredAt?: string;
  deliveredVia?: DeliveredVia;
  /** When this project's own agent first opened the inbox copy through the
   * hub, and the name it gave (D160). A workspace fact, unlike this machine's
   * "seen" marks in localStorage — and it counts as read here too. */
  agentReadAt?: string;
  agentReadBy?: string;
}

export interface DeliveryPayload {
  /** The sender's cover note; a delivery carries a note, attachments, or both (D73). */
  note?: string;
  attachments?: AttachmentRef[];
}

/** Full delivery envelope (one file under .nextup/exchange/). */
export interface DeliveryEnvelope {
  schemaVersion: number;
  id: string;
  from: DeliverySource;
  payloadType: string;
  payload: DeliveryPayload;
  publishedAt: string;
  /** The outbox envelope this one corrects, and (on the predecessor) the one
   * that replaced it (D87). Nothing is deleted — the older envelope is marked. */
  supersedes?: string | null;
  supersededBy?: string | null;
  /** See `DeliverySummary.addressedTo` (D176). */
  addressedTo?: DeliverySource[];
  deliveredAt?: string;
  deliveredVia?: DeliveredVia;
  /** See `DeliverySummary.agentReadAt` (D160). */
  agentReadAt?: string;
  agentReadBy?: string;
  /** Absolute directory of this envelope's attachment bytes, present only when
   * it has attachments (computed by `exchange_get`, OS-correct separators). */
  attachmentDir?: string;
}

export interface RouteFailure {
  root: string;
  message: string;
}

/** Result of one Send action; a failed destination keeps the envelope pending. */
export interface RouteOutcome {
  delivered: string[];
  alreadyDelivered: string[];
  failed: RouteFailure[];
  outboxCleared: boolean;
}

/** One envelope the automatic-edge policy handled (D152). `outcome` is null
 *  when routing raised outright, and `error` then says why. */
export interface AutoRouted {
  envelopeId: string;
  outcome: RouteOutcome | null;
  error: string | null;
}

// ── Shipped workspace assets (D38) ──────────────────────────────────────────

/** Five-state verdict for one engine-shipped curriculum asset. */
export type AssetState =
  | "up_to_date"
  | "upgrade_safe"
  | "customized"
  | "manual_review"
  | "missing";

export interface AssetStatus {
  path: string;
  state: AssetState;
}

export interface AssetsUpgradeOutcome {
  upgraded: string[];
  added: string[];
  keptAsUser: string[];
  skippedCustomized: string[];
  needsReview: string[];
  /** Workspace-relative dir holding pre-overwrite copies (when any were taken). */
  backupDir?: string;
  /** Tools a newer version added that the same press granted (D172); plain upgrade only. */
  grantedTools?: string[];
}

// ── Workspace doctor (D18) ──────────────────────────────────────────────────

export type DoctorMode = "managed" | "docs_only";
export type DoctorSeverity = "warning" | "error";

export interface DoctorFinding {
  check: string;
  severity: DoctorSeverity;
  target: string;
  message: string;
}

export interface DoctorReport {
  mode: DoctorMode;
  checkedAt: string;
  errors: number;
  warnings: number;
  findings: DoctorFinding[];
}

// ── Full-text index (Module B) ──────────────────────────────────────────────

export interface IndexProgress {
  indexed: number;
  total: number;
}

export interface IndexSummary {
  files: number;
  chunks: number;
  skipped: number;
  skippedUnreadable: number;
  skippedBinary: number;
  /** First few skipped paths with reason, for "why is my file missing". */
  skippedSamples: string[];
  todos: number;
  durationMs: number;
}

export interface IndexInfo {
  builtAt: string;
  files: number;
  chunks: number;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  language?: string | null;
  snippet: string;
}

// ── Context / milestones / registry / adoption ─────────────────────────────

export interface Milestone {
  id: string;
  title: string;
  done: boolean;
  verified: boolean;
}

export interface RejectedAlternative {
  proposal: string;
  reason: string;
  at: string;
}

export interface ProjectContext {
  schemaVersion: number;
  /** Stable workspace identity (D48); absent on pre-D48 workspaces until the first team join mints one. */
  workspaceId?: string;
  name: string;
  domain: string;
  description: string;
  goals: string[];
  boundaries: string[];
  milestones: Milestone[];
  /** Do-not-re-pitch list; re-raising needs new facts + user consent. */
  rejected: RejectedAlternative[];
  createdAt: string;
  updatedAt: string;
}

/** The four context fields a person may edit after creation (D142); omit to leave one alone. */
export interface ContextEdit {
  name?: string;
  domain?: string;
  description?: string;
  goals?: string[];
  boundaries?: string[];
}

export interface WorkspaceOverview {
  root: string;
  name: string;
  domain: string;
  lastOpened: string;
  exists: boolean;
  taskCounts?: TaskCounts | null;
  currentPhase?: string | null;
  /** Phase display title (D42 pure-Chinese); fall back to currentPhase id. */
  currentPhaseTitle?: string | null;
  workflowCompleted: boolean;
  /** Runs ongoing (D171): no phase position to show. */
  ongoing?: boolean;
  /** 0-based position of the current phase, and how many phases there are ("phase 2 / 5"). */
  currentPhaseIndex?: number | null;
  phaseCount?: number | null;
  /** Instantiated harness identity (D45); absent when no workflow.json. */
  templateId?: string | null;
  templateName?: string | null;
}

/** One hub call as the overviews draw it (D155). */
export interface AgentCall {
  at: string;
  actor?: string;
  tool?: string;
  outcome?: "ok" | "failed" | "denied";
  /** The semantic event the same actor wrote since its previous call; absent for reads. */
  detail?: string;
  taskId?: string;
}

/** A denied call still waiting for a person: fresh, still refused, not retried successfully. */
export interface WaitingCall {
  at: string;
  actor?: string;
  tool: string;
}

/**
 * One project's recent agent activity, read from a fixed tail of its ledger
 * (D155) — cost does not grow with history.
 */
export interface ProjectActivity {
  root: string;
  /** Newest last, capped. */
  calls: AgentCall[];
  /** Calls at or after the `since` passed in. */
  callsSince: number;
  /** The tail ran out before `since`: `callsSince` is a floor, not a total. */
  capped: boolean;
  waiting: WaitingCall[];
  /** Set when the project could not be read; rows are empty then. */
  error?: string;
}

export interface AdoptionDraft {
  name: string;
  domain: string;
  description: string;
  languages: string[];
  suggestedTasks: NewTask[];
  /** The folder already has AGENTS.md, CLAUDE.md or docs/ (D170). */
  ownMethodDetected: boolean;
}

// ── Embedded terminal & agent catalog (D50) ─────────────────────────────────

/** One launchable agent CLI: preset or custom, with a live PATH probe. */
export interface AgentInfo {
  id: string;
  title: string;
  command: string;
  args: string[];
  /** Launch-time env overrides (D56); empty object for presets. */
  env: Record<string, string>;
  builtin: boolean;
  /** Whether the command resolves on PATH right now (launch menus grey out missing CLIs). */
  installed: boolean;
  /** Whether this agent has a known "resume the last conversation" launch (B16-B);
   *  built-ins do, custom agents do not. Gates the "Resume" action. */
  resumable: boolean;
}

/** Custom agent CLI entry as stored in ~/.nextup/agents.json. */
export interface CustomAgent {
  id: string;
  title: string;
  command: string;
  args: string[];
  /** Extra env vars passed to the CLI at launch (D56), e.g. ANTHROPIC_BASE_URL. */
  env: Record<string, string>;
}

/** One live (or exited-but-not-dismissed) terminal session. App-level:
 *  sessions keep running across workspace switches, tagged by root.
 *  `restored` (D69) = reconstructed from disk at startup: the process from the
 *  prior app run is gone and no scrollback is kept — a placeholder that resumes
 *  its conversation on view. */
export interface TerminalSessionMeta {
  id: number;
  root: string;
  workspaceId: string | null;
  agentId: string;
  title: string;
  /** Self-reported hub identity this session runs as (D63); null = anonymous. */
  identity: string | null;
  startedAt: string;
  status: "running" | "exited" | "restored";
  exitCode: number | null;
  /** Rendered in a separate pop-out window right now (B16-C); the main window
   *  shows a "Popped out" placeholder instead of a live pane. */
  poppedOut: boolean;
}

/** Scrollback snapshot for (re)mounting a terminal view. Output events with
 *  seq <= snapshot seq are already folded into data — drop them on replay. */
export interface TerminalBuffer {
  data: string;
  seq: number;
}

/** Payload of terminal://output. */
export interface TerminalOutputPayload {
  id: number;
  seq: number;
  data: string;
}

/** Payload of terminal://exit (natural child exit only, never user close). */
export interface TerminalExitPayload {
  id: number;
  exitCode: number | null;
}
