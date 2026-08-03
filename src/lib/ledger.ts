// Shared presentation helpers for ledger event lists (Dashboard porthole and
// the Ledger browser render the same rows).

import type { LedgerEvent } from "../types";

/**
 * Whether an `agent_tool_called` line records a denial. The structured
 * `outcome` field decides (D75); the wording regex only judges pre-D75 lines,
 * which never carry the field — so on new lines a failure whose error text
 * happens to contain "denied" can no longer masquerade as a denial.
 *
 * This is the single recognizer: the Dashboard and Ledger chips, the Collab feed
 * and the notify layer all key off it. Do not grow a second copy.
 */
export function isDeniedCall(event: LedgerEvent): boolean {
  if (event.kind !== "agent_tool_called") return false;
  return event.outcome !== undefined
    ? event.outcome === "denied"
    : /denied/i.test(event.message);
}

/** Visual category for a ledger event kind (chip color in activity lists). */
export function eventCat(event: LedgerEvent): string {
  switch (event.kind) {
    case "agent_tool_called":
      return isDeniedCall(event) ? "deny" : "tool";
    case "mcp_tool_called":
      return "tool";
    case "task_created":
    case "task_status_changed":
    case "task_verification_changed":
    case "task_archived":
    case "spec_folded":
    case "task_edited":
    case "task_deleted":
    case "milestone_updated":
      return "task";
    case "phase_advanced":
    case "gate_confirmed":
    case "workflow_adopted":
      return "gate";
    case "decision":
      return "decision";
    // D78: a session summary gets the decision chip family — both are the
    // "read this on takeover" tier, distinct from the plain default.
    case "progress":
      return "decision";
    default:
      return "";
  }
}

/** Identity key for freshness diffing / React keys (not guaranteed unique). */
export function eventKey(event: LedgerEvent): string {
  return `${event.at} ${event.kind} ${event.message}`;
}

/** A UUID standing on its own — bounded so a hyphenated word or a hash inside
 *  a longer token is never touched. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Shorten machine ids for display (r2 3-4): `c414c1da-…` instead of all 36
 * characters, which on a 12.5px event row is most of a line spent on
 * something no one reads.
 *
 * Display side only, on purpose — the ledger line itself keeps the full id,
 * because that is the thing you grep the file for. It is the same split the
 * inbox already makes with `supersedes.slice(0, 8)`: the row abbreviates, the
 * data does not. Callers should keep the original within reach (a `title`, a
 * copy button), never replace it.
 *
 * Eight characters is the prefix length used everywhere else in the app and
 * is what the hub's own messages quote, so a shortened id here still matches
 * an id shown there.
 */
export function shortenIds(text: string): string {
  return text.replace(UUID, (id) => `${id.slice(0, 8)}…`);
}
