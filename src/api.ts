import { invoke } from "@tauri-apps/api/core";

import i18n from "./i18n";
import type {
  AdoptionDraft,
  AgentAccessView,
  AgentInfo,
  AgentMcpStatus,
  AssetStatus,
  CustomAgent,
  AssetsUpgradeOutcome,
  DeliveryEnvelope,
  DeliverySummary,
  DoctorReport,
  IndexInfo,
  IndexSummary,
  InitProjectParams,
  InitTargetProbe,
  LedgerChannel,
  LedgerEvent,
  LedgerKind,
  LedgerPage,
  LedgerTail,
  NewTask,
  ProjectContext,
  SearchHit,
  RouteOutcome,
  SpecOverview,
  SystemStatus,
  Task,
  TaskSpecsReport,
  TaskEdit,
  TaskStatus,
  TaskUpdate,
  Team,
  TemplateSummary,
  TerminalBuffer,
  TerminalSessionMeta,
  WorkflowStatus,
  WorkflowTemplate,
  WorkspaceModules,
  WorkspaceSettings,
  WorkspaceOverview,
} from "./types";

/**
 * Technical prefixes the Rust `#[error(...)]` attributes put in front of every
 * message ("invalid input: …", "workspace error: …"). They tell a user nothing
 * — the kind is carried structurally right next to the text — so they are
 * stripped before display.
 *
 * Not anchored to the start: the path-carrying variants the core prefers
 * (`IoAt` / `JsonAt`, error.rs) render as `{path}: I/O error: {source}`, so the
 * prefix sits mid-string and a `^` would sail right past the common case.
 */
const KIND_PREFIXES =
  /(^|(?<=: ))(invalid input|workspace error|workflow error|task error|backup error|encryption error|keystore error|terminal error|provider error|IPC error|not found|unauthorized|I\/O error|JSON error):\s*/;

/**
 * The raw message off the wire, minus the technical prefix. Use
 * [`errorMessage`] for anything a user reads; this is the escape hatch for
 * places that need the engine's own words.
 */
export function rawErrorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message).replace(KIND_PREFIXES, "");
  }
  return String(e);
}

/**
 * A failure phrased for the person in front of the screen (product review §5-6).
 *
 * Errors cross the IPC bridge as `{ kind, message }`. The kind is a stable
 * machine token, so it can carry an `errors.<kind>` sentence that says what to
 * do next — "go authorize it in the tools page" beats "unauthorized: tool 'x'
 * is not authorized". The engine's own text is still handed to that sentence
 * as `{{message}}`, so specifics (which tool, which path) are never lost, and
 * kinds without a mapping fall through to the raw text unchanged.
 *
 * Doing the lookup here upgrades every call site at once — there are dozens,
 * and a per-view translation would drift the moment someone adds a view.
 */
export function errorMessage(e: unknown): string {
  const message = rawErrorMessage(e);
  const kind = errorKind(e);
  if (kind === null) return message;
  const key = `errors.${kind}`;
  if (!i18n.exists(key)) return message;
  return i18n.t(key, { message, ...structuredFields(e) });
}

/** Extra fields carried by structured refusals, for the `errors.*` sentences. */
function structuredFields(e: unknown): Record<string, string> {
  if (typeof e !== "object" || e === null) return {};
  const record = e as Record<string, unknown>;
  const fields: Record<string, string> = {};
  // Spec-fold refusals (D79) carry the conflict list for the errors.* line.
  if (Array.isArray(record.conflicts)) {
    fields.conflicts = record.conflicts.map(String).join("; ");
  }
  if (Array.isArray(record.blockingTasks)) {
    fields.blocking = record.blockingTasks
      .map((task) =>
        typeof task === "object" && task !== null && "id" in task
          ? String((task as { id: unknown }).id)
          : String(task),
      )
      .join(", ");
  }
  if (typeof record.currentAssignee === "string") fields.assignee = record.currentAssignee;
  if (Array.isArray(record.dependentTasks)) fields.dependents = record.dependentTasks.join(", ");
  return fields;
}

/** Structured error kind (e.g. "not_found") or null when not an NextUpError. */
export function errorKind(e: unknown): string | null {
  if (typeof e === "object" && e !== null && "kind" in e) {
    return String((e as { kind: unknown }).kind);
  }
  return null;
}

export const api = {
  systemStatus: () => invoke<SystemStatus>("system_status"),

  gitAvailable: () => invoke<boolean>("git_available"),
  initializeProject: (params: InitProjectParams, initGit: boolean) =>
    invoke<SystemStatus>("initialize_project", {
      params: { templateLang: i18n.language, ...params },
      initGit,
    }),
  probeInitTarget: (parent: string, folder: string) =>
    invoke<InitTargetProbe>("probe_init_target", { parent, folder }),
  openWorkspace: (root: string) => invoke<SystemStatus>("open_workspace", { root }),
  closeWorkspace: () => invoke<SystemStatus>("close_workspace"),

  modulesGet: () => invoke<WorkspaceModules>("modules_get"),
  moduleSetEnabled: (module: string, enabled: boolean) =>
    invoke<WorkspaceModules>("module_set_enabled", { module, enabled }),

  listTasks: () => invoke<Task[]>("list_tasks"),
  createTask: (input: NewTask) => invoke<Task>("create_task", { input }),
  updateTaskStatus: (id: string, status: TaskStatus, blockedReason?: string) =>
    invoke<TaskUpdate>("update_task_status", {
      id,
      status,
      blockedReason: blockedReason ?? null,
    }),
  setTaskVerification: (id: string, verified: boolean, note?: string) =>
    invoke<TaskUpdate>("set_task_verification", { id, verified, note: note ?? null }),
  editTask: (id: string, edit: TaskEdit) => invoke<TaskUpdate>("edit_task", { id, edit }),
  deleteTask: (id: string) => invoke<void>("delete_task", { id }),
  setTaskArchived: (id: string, archived: boolean) =>
    invoke<TaskUpdate>("set_task_archived", { id, archived }),
  archiveVerifiedDoneTasks: () => invoke<string[]>("archive_verified_done_tasks"),
  autoArchiveSweep: () => invoke<string[]>("auto_archive_sweep"),
  specsOverview: () => invoke<SpecOverview[]>("specs_overview"),
  specContent: (capability: string) => invoke<string>("spec_content", { capability }),
  pendingSpecFolds: () => invoke<TaskSpecsReport[]>("pending_spec_folds"),
  getWorkspaceSettings: () => invoke<WorkspaceSettings>("get_workspace_settings"),
  setWorkspaceSettings: (settings: WorkspaceSettings) =>
    invoke<WorkspaceSettings>("set_workspace_settings", { settings }),
  assignTask: (id: string, assignee?: string | null) =>
    invoke<TaskUpdate>("assign_task", { id, assignee: assignee ?? null }),

  readHandoff: () => invoke<string>("read_handoff"),
  generateHandoff: () => invoke<string>("generate_handoff_now"),
  recentEvents: (limit: number) => invoke<LedgerEvent[]>("recent_events", { limit }),
  ledgerHistory: (kinds: LedgerKind[] | null, offset: number, limit: number) =>
    invoke<LedgerPage>("ledger_history", { kinds, offset, limit }),
  ledgerSince: (fromLine: number, limit: number) =>
    invoke<LedgerTail>("ledger_since", { fromLine, limit }),
  addLedgerNote: (channel: LedgerChannel, message: string) =>
    invoke<LedgerEvent>("add_ledger_note", { channel, message }),

  // Built-in template content follows the UI language (D54); the tag is
  // injected here so call sites cannot forget it. Customs are as-authored.
  listTemplates: () =>
    invoke<TemplateSummary[]>("list_templates", { lang: i18n.language }),
  getTemplate: (id: string) =>
    invoke<WorkflowTemplate>("get_template", { id, lang: i18n.language }),
  saveCustomTemplate: (template: WorkflowTemplate) =>
    invoke<TemplateSummary[]>("save_custom_template", { template, lang: i18n.language }),
  deleteCustomTemplate: (id: string) =>
    invoke<TemplateSummary[]>("delete_custom_template", { id, lang: i18n.language }),

  agentCatalogList: () => invoke<AgentInfo[]>("agent_catalog_list"),
  agentCatalogSave: (agent: CustomAgent) =>
    invoke<AgentInfo[]>("agent_catalog_save", { agent }),
  agentCatalogDelete: (id: string) => invoke<AgentInfo[]>("agent_catalog_delete", { id }),

  terminalLaunch: (root: string, agentId: string, identity?: string | null, resume = false) =>
    invoke<TerminalSessionMeta>("terminal_launch", {
      root,
      agentId,
      identity: identity ?? null,
      resume,
    }),
  // Revive a restored/exited tab in place — same id, same slot (D69).
  terminalRevive: (id: number) => invoke<TerminalSessionMeta>("terminal_revive", { id }),
  terminalWrite: (id: number, data: string) => invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: number, rows: number, cols: number) =>
    invoke<void>("terminal_resize", { id, rows, cols }),
  terminalClose: (id: number) => invoke<void>("terminal_close", { id }),
  terminalList: () => invoke<TerminalSessionMeta[]>("terminal_list"),
  terminalReadBuffer: (id: number) => invoke<TerminalBuffer>("terminal_read_buffer", { id }),
  terminalShutdown: () => invoke<void>("terminal_shutdown"),
  terminalSetPoppedOut: (id: number, poppedOut: boolean) =>
    invoke<void>("terminal_set_popped_out", { id, poppedOut }),
  workflowStatus: () => invoke<WorkflowStatus>("workflow_status"),
  advancePhase: (force: boolean, reason?: string) =>
    invoke<WorkflowStatus>("advance_phase", { force, reason: reason ?? null }),
  confirmGate: (phaseId: string, prompt: string) =>
    invoke<WorkflowStatus>("confirm_gate", { phaseId, prompt }),
  adoptWorkflow: (templateId: string) =>
    invoke<WorkflowStatus>("adopt_workflow", { templateId, lang: i18n.language }),
  scaffoldBootstrap: () => invoke<string[]>("scaffold_bootstrap"),
  workspaceAssetsStatus: () => invoke<AssetStatus[]>("workspace_assets_status"),
  workspaceAssetsUpgrade: (overwrite: string[], keepAsUser: string[]) =>
    invoke<AssetsUpgradeOutcome>("workspace_assets_upgrade", { overwrite, keepAsUser }),

  // No caller since D88 removed the API-keys panel: the encrypted store's only
  // consumer is the dormant orchestrator (`build_provider`), so the panel asked
  // for a credential nothing would read. Kept rather than deleted because the
  // store itself is live — backup re-encrypts it into every archive — and B14
  // ("ask this project") is the consumer that brings the panel back.
  listSecretNames: () => invoke<string[]>("list_secret_names"),
  setSecret: (name: string, value: string) =>
    invoke<string[]>("set_secret", { name, value }),
  deleteSecret: (name: string) => invoke<string[]>("delete_secret", { name }),

  exportBackup: (destPath: string, passphrase: string, includeArtifacts: boolean) =>
    invoke<string>("export_backup", { destPath, passphrase, includeArtifacts }),
  importBackup: (archivePath: string, destRoot: string, passphrase: string) =>
    invoke<SystemStatus>("import_backup", { archivePath, destRoot, passphrase }),

  agentAccessStatus: () => invoke<AgentAccessView>("agent_access_status"),
  agentAccessSetEnabled: (enabled: boolean) =>
    invoke<AgentAccessView>("agent_access_set_enabled", { enabled }),
  agentAccessSetTool: (tool: string, allowed: boolean) =>
    invoke<AgentAccessView>("agent_access_set_tool", { tool, allowed }),
  agentAccessSetTools: (tools: string[], allowed: boolean) =>
    invoke<AgentAccessView>("agent_access_set_tools", { tools, allowed }),
  agentAccessSetAllTools: (allowed: boolean) =>
    invoke<AgentAccessView>("agent_access_set_all_tools", { allowed }),
  agentMcpStatus: () => invoke<AgentMcpStatus>("agent_mcp_status"),
  agentMcpRepair: () => invoke<AgentMcpStatus>("agent_mcp_repair"),

  buildSearchIndex: () => invoke<IndexSummary>("build_search_index"),
  searchIndex: (query: string, limit: number) =>
    invoke<SearchHit[]>("search_index", { query, limit }),
  searchIndexStatus: () => invoke<IndexInfo | null>("search_index_status"),

  runDoctor: () => invoke<DoctorReport>("run_doctor"),

  getContext: () => invoke<ProjectContext>("get_context"),
  addMilestone: (title: string) => invoke<ProjectContext>("add_milestone", { title }),
  setMilestoneDone: (id: string, done: boolean) =>
    invoke<ProjectContext>("set_milestone_done", { id, done }),
  setMilestoneVerified: (id: string, verified: boolean) =>
    invoke<ProjectContext>("set_milestone_verified", { id, verified }),
  removeMilestone: (id: string) => invoke<ProjectContext>("remove_milestone", { id }),

  teamsList: () => invoke<Team[]>("teams_list"),
  teamCreate: (name: string) => invoke<Team[]>("team_create", { name }),
  teamRename: (teamId: string, name: string) =>
    invoke<Team[]>("team_rename", { teamId, name }),
  teamDelete: (teamId: string) => invoke<Team[]>("team_delete", { teamId }),
  teamAddMember: (teamId: string, root: string) =>
    invoke<Team[]>("team_add_member", { teamId, root }),
  teamRemoveMember: (teamId: string, workspaceId: string) =>
    invoke<Team[]>("team_remove_member", { teamId, workspaceId }),
  /**
   * Designate the team's prime, or clear it with null (D116/D117).
   *
   * Takes a root, not a workspaceId: the prime is not a member, so there is no
   * member row that already resolved one — the backend mints it, the same
   * explicit write moment joining a team is.
   */
  teamSetPrime: (teamId: string, root: string | null) =>
    invoke<Team[]>("team_set_prime", { teamId, root }),
  teamRebindWorkspace: (workspaceId: string, newRoot: string) =>
    invoke<Team[]>("team_rebind_workspace", { workspaceId, newRoot }),
  teamSetLayout: (teamId: string, positions: Record<string, { x: number; y: number }>) =>
    invoke<Team[]>("team_set_layout", { teamId, positions }),
  teamAddEdge: (teamId: string, from: string, to: string) =>
    invoke<Team[]>("team_add_edge", { teamId, from, to }),
  teamRemoveEdge: (teamId: string, from: string, to: string) =>
    invoke<Team[]>("team_remove_edge", { teamId, from, to }),
  teamSetEdgeAutoRoute: (teamId: string, from: string, to: string, autoRoute: boolean) =>
    invoke<Team[]>("team_set_edge_auto_route", { teamId, from, to, autoRoute }),
  teamRouteDelivery: (
    root: string,
    id: string,
    destinations: { root: string; teamId: string; teamName: string }[],
    opts?: { auto?: boolean; keepPending?: boolean },
  ) =>
    invoke<RouteOutcome>("team_route_delivery", {
      root,
      id,
      destinations,
      auto: opts?.auto ?? false,
      keepPending: opts?.keepPending ?? false,
    }),
  exchangeList: (root: string, mailbox: "inbox" | "outbox") =>
    invoke<DeliverySummary[]>("exchange_list", { root, mailbox }),
  exchangeGet: (root: string, mailbox: "inbox" | "outbox", id: string) =>
    invoke<DeliveryEnvelope>("exchange_get", { root, mailbox, id }),
  exchangePublish: (note: string | null, files?: string[], supersedes?: string) =>
    invoke<DeliveryEnvelope>("exchange_publish", { note, files, supersedes }),

  recentWorkspaces: () => invoke<WorkspaceOverview[]>("recent_workspaces"),
  removeRecentWorkspace: (root: string) =>
    invoke<WorkspaceOverview[]>("remove_recent_workspace", { root }),
  draftLegacyAdoption: (root: string) =>
    invoke<AdoptionDraft>("draft_legacy_adoption", { root }),
  adoptLegacyProject: (params: InitProjectParams, tasks: NewTask[]) =>
    invoke<SystemStatus>("adopt_legacy_project", {
      params: { templateLang: i18n.language, ...params },
      tasks,
    }),
};
