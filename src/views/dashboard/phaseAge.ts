/**
 * How long the current phase has been open (D169) — pure, so the rule the
 * phase band shows can be checked without mounting it.
 */
import type { PhaseTransition } from "../../types";

/** Mirrors the doctor's `PHASE_READY_IDLE_DAYS` (doctor.rs): a phase whose
 *  gates all pass and that has sat this long is reported there and turns
 *  amber here. */
export const READY_IDLE_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Whole days since `phase` was last entered, or null when the history never
 * says (a hand-edited workflow.json). The last entry wins: a phase re-entered
 * after an override counts from its return, the same reading the engine's
 * `entered_at` takes.
 */
export function daysInPhase(
  history: PhaseTransition[],
  phase: string,
  now: number = Date.now(),
): number | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].phase !== phase) continue;
    const at = Date.parse(history[i].enteredAt);
    return Number.isNaN(at) ? null : Math.max(0, Math.floor((now - at) / DAY_MS));
  }
  return null;
}
