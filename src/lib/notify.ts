/**
 * Notification layer (D62): what is worth announcing, how loudly, and what has
 * already been announced.
 *
 * Two rules shape everything here.
 *
 * **Strength is a property of the event, not of the caller.** Toast interrupts;
 * a badge waits. Only events where someone is blocked on the user get a toast
 * (an agent stuck at a permission prompt, an inbound delivery). Ambient state —
 * gates turning green, the blocked-task count — stays silent, because those
 * flip back and forth as work proceeds and a popup per flip is noise.
 *
 * **Cursors are per machine, not per workspace.** "Have I seen this?" is a fact
 * about this person at this desk, not about the project, so it lives in
 * localStorage next to the other prefs — never in the workspace, which is
 * shared state and would make one person's reading mark another's.
 */

import { isDeniedCall } from "./ledger";
import { readJson, writeJson } from "./prefs";
import type { DeliverySummary, LedgerEvent } from "../types";

/** The events the notification layer knows about (product review §2-4; D71 adds auto-send). */
export type NotifyKind =
  | "deliveryArrived"
  | "agentDenied"
  | "gateGreen"
  | "taskBlocked"
  | "autoRouted"
  | "autoRouteFailed";

/**
 * How loud each event is. Kept as one table so upgrading an event from silent
 * to interrupting (B4 will want it for the denial→authorize flow) is a one-line
 * change here rather than a hunt through the views.
 */
export const NOTIFY_STRENGTH: Record<NotifyKind, "toast" | "badge"> = {
  // Someone is waiting on the user right now.
  deliveryArrived: "toast",
  agentDenied: "toast",
  // Policy acting on the user's behalf (D71): say what was done, and never
  // let a failure be silent — automation makes people assume it worked.
  autoRouted: "toast",
  autoRouteFailed: "toast",
  // Ambient state — visible where it matters (workflow panel, sidebar count),
  // never as an interruption.
  gateGreen: "badge",
  taskBlocked: "badge",
};

/** A queued toast. `count` folds repeats instead of stacking duplicates. */
export interface Toast {
  id: number;
  kind: NotifyKind;
  /** Renders as `.toast-info` / `.toast-error`. */
  tone: "info" | "error";
  message: string;
  /** Optional jump target (e.g. "open the inbox"). */
  action?: { label: string; run: () => void };
  /** Repeats folded into this toast; 1 means "seen once". */
  count: number;
  /** Repeats of the same key fold together rather than stacking. */
  dedupeKey: string;
}

// ── Ledger cursor ───────────────────────────────────────────────────────────

const LEDGER_CURSOR_KEY = "nextup-notify-ledger-cursor";

type CursorMap = Record<string, number>;

/**
 * The ledger line cursor for a workspace, or `null` when this machine has never
 * looked at it.
 *
 * `null` is load-bearing: it means "adopt the current position silently". A
 * first run — or a workspace opened for the first time — must not replay its
 * whole history as notifications, and a cursor of 0 would do exactly that.
 */
export function ledgerCursor(root: string): number | null {
  const map = readJson<CursorMap>(LEDGER_CURSOR_KEY, {});
  const at = map[root];
  return typeof at === "number" ? at : null;
}

export function setLedgerCursor(root: string, line: number): void {
  const map = readJson<CursorMap>(LEDGER_CURSOR_KEY, {});
  map[root] = line;
  writeJson(LEDGER_CURSOR_KEY, map);
}

// ── Seen deliveries ─────────────────────────────────────────────────────────

const SEEN_DELIVERIES_KEY = "nextup-notify-seen-deliveries";

type SeenMap = Record<string, string[]>;

/**
 * Envelope ids already seen in a workspace's inbox, or `null` if this machine
 * has never listed it (same silent-adoption rule as the ledger cursor).
 */
export function seenDeliveries(root: string): Set<string> | null {
  const map = readJson<SeenMap>(SEEN_DELIVERIES_KEY, {});
  const ids = map[root];
  return Array.isArray(ids) ? new Set(ids) : null;
}

/**
 * Record exactly the envelopes currently in the inbox as seen.
 *
 * Overwrite rather than union, deliberately: ids that left the inbox drop out
 * of the record on their own, so this cannot grow without bound the way an
 * ever-accumulating set would.
 */
export function markDeliveriesSeen(root: string, ids: string[]): void {
  const map = readJson<SeenMap>(SEEN_DELIVERIES_KEY, {});
  map[root] = ids;
  writeJson(SEEN_DELIVERIES_KEY, map);
}

/** Envelopes in `deliveries` this machine has not seen yet. */
export function unseenDeliveries(root: string, deliveries: DeliverySummary[]): DeliverySummary[] {
  const seen = seenDeliveries(root);
  if (seen === null) {
    // First sight of this inbox: adopt everything silently so opening the app
    // on an existing workspace does not announce months of history.
    markDeliveriesSeen(
      root,
      deliveries.map((d) => d.id),
    );
    return [];
  }
  return deliveries.filter((d) => !seen.has(d.id));
}

// ── Event recognition ───────────────────────────────────────────────────────

/**
 * Denied agent hub calls in a ledger tail.
 *
 * The hub records a denial as `agent_tool_called` with structured
 * `outcome`/`tool` fields (D75, superseding D63's string contract — the parse
 * cost had spread to three copies of the regex and the wording had become a
 * de-facto API). Recognition delegates to `isDeniedCall` in `ledger.ts` — the
 * single recognizer — and the tool name is read from the field; the
 * "{tool} denied" leading-token parse survives only for pre-D75 lines, which
 * never carry the fields.
 */
export function deniedCalls(
  events: LedgerEvent[],
): { tool: string; actor: string | null; at: string }[] {
  return events.filter(isDeniedCall).map((e) => ({
    // Pre-D75 fallback: take the leading token of "{tool} denied", and fall
    // back to the whole message so the toast still says something.
    tool: e.tool ?? (/^(\S+)\s+denied/i.exec(e.message)?.[1] ?? e.message),
    actor: e.actor ?? null,
    at: e.at,
  }));
}
