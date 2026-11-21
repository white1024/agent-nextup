import type { TemplateSummary, WorkflowMode, WorkflowState } from "../types";

/**
 * Whether a new project runs staged (D171 ②): when the person asks for it, or
 * when the template has no ongoing instructions to run on.
 */
export function runsStaged(staged: boolean, template: TemplateSummary | null): boolean {
  return staged || (template !== null && !template.supportsOngoing);
}

/**
 * The mode a create/adopt call sends. Until the template is known it sends
 * nothing and lets the engine default decide — an explicit "ongoing" on a
 * staged-only template is refused outright (review W4 of D171).
 */
export function modeToSend(staged: boolean, template: TemplateSummary | null): WorkflowMode | undefined {
  if (template === null) return undefined;
  return runsStaged(staged, template) ? "staged" : "ongoing";
}

/** The settings.* key announcing a mode switch, by where the workflow ended up. */
export type ModeSwitchKey =
  | "workflowToOngoing"
  | "workflowToOngoingDone"
  | "workflowToStaged"
  | "workflowToStagedFirst"
  | "workflowToStagedDone";

/**
 * What to say after a switch (D171 ③), read from the workflow the switch
 * returned. Switching to staged "returns" to a phase only when the project
 * was staged before: one that has run ongoing since creation has no
 * `via: "ongoing"` entry in its history, and starts at the first phase it
 * was never in.
 */
export function modeSwitchKey(toStaged: boolean, state: WorkflowState): ModeSwitchKey {
  if (state.completed) return toStaged ? "workflowToStagedDone" : "workflowToOngoingDone";
  if (!toStaged) return "workflowToOngoing";
  return state.history.some((h) => h.via === "ongoing") ? "workflowToStaged" : "workflowToStagedFirst";
}
