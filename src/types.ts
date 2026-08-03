// DTO mirrors of the Rust core types (serde camelCase).

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

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
  /** Collaboration fields (D31): always in the schema; the collab module only gates exposure. */
  assignee?: string;
  dependsOn?: string[];
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
export interface TaskEdit {
  title: string;
  description: string;
  priority: number;
  tags: string[];
}

export interface TaskCounts {
  total: number;
  todo: number;
  inProgress: number;
  blocked: number;
  done: number;
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
  | "delivery_received";

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
}

/** Dry-run fold report for one task's delta bundle (D79). */
export interface TaskSpecsReport {
  taskId: string;
  capabilities: string[];
  ok: boolean;
  problems: string[];
  warnings: string[];
  alreadySynced: string[];
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
}

/** Live collision check for the init wizard's target folder (D44). */
export interface InitTargetProbe {
  exists: boolean;
  isWorkspace: boolean;
}

// ── Workflow harness ────────────────────────────────────────────────────────

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
  phases: WorkflowPhase[];
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
  source: "built_in" | "custom";
}

/** Full template body — same phase shape the workflow harness runs on. */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  domainHint: string;
  phases: WorkflowPhase[];
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

/** One app-level team (~/.nextup/teams.json); edges always form a DAG. */
export interface Team {
  id: string;
  name: string;
  members: TeamMember[];
  edges: TeamEdge[];
  /** Saved canvas positions by workspaceId (D53); absent = auto-placed. */
  layout?: Record<string, NodePos>;
  createdAt: string;
  updatedAt: string;
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
  note?: string;
  /** The note was clamped to its first line for a brief listing; the rest is
   * behind `exchange_get`. Only the hub asks for brief listings today. */
  noteTruncated?: boolean;
  publishedAt: string;
  deliveredAt?: string;
  deliveredVia?: DeliveredVia;
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
  deliveredAt?: string;
  deliveredVia?: DeliveredVia;
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
  /** Instantiated harness identity (D45); absent when no workflow.json. */
  templateId?: string | null;
  templateName?: string | null;
}

export interface AdoptionDraft {
  name: string;
  domain: string;
  description: string;
  languages: string[];
  suggestedTasks: NewTask[];
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
