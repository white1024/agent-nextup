/**
 * Cross-workspace mailbox reads (D48/D71) — the one place that knows how to
 * fan a `exchangeList` out over several workspaces and what to do when one of
 * them cannot be read.
 *
 * The fan-out shape had been hand-rolled four times, in three different ways:
 * drop the rejected entries (`Promise.allSettled`), catch into an `error`
 * string, catch into `[]` (twice, with different return shapes). That is a
 * policy question — "an unreachable member workspace must not sink the whole
 * page" — so it belongs to one function that every surface shares, not to
 * whoever wrote the call site.
 *
 * The policy: every target is read concurrently, and a target that fails
 * resolves to *empty rows plus its message*. Callers that show the failure
 * (the team detail inspector) read `error`; callers that only count
 * (the team cards) get 0 the way they always did; nothing throws.
 */
import { api, errorMessage } from "../api";
import type { DeliverySummary } from "../types";

/**
 * Comparison/keying form for a workspace root: same folder written with
 * backslashes, a trailing separator or different casing is the same
 * workspace. Windows paths arrive from three sources (the registry, teams.json
 * and the native picker) and none of them agree on the shape.
 */
export function normRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function sameRoot(a: string, b: string): boolean {
  return normRoot(a) === normRoot(b);
}

/** One target's mailbox read: the rows, or empty rows and why. */
export interface BoxRead<T> {
  /** The caller's own row — whatever it fanned out over. */
  target: T;
  rows: DeliverySummary[];
  error: string | null;
}

/**
 * Read one mailbox per target, concurrently, one result per target in input
 * order. Never rejects: a target whose read fails comes back with `rows: []`
 * and its message in `error`.
 *
 * Deduplicate before calling when several targets can share a root — the
 * team cards key their counts by {@link normRoot} for exactly that reason.
 */
export async function readBoxes<T>(
  targets: readonly T[],
  rootOf: (target: T) => string,
  mailbox: "inbox" | "outbox",
): Promise<BoxRead<T>[]> {
  return Promise.all(
    targets.map(async (target) => {
      try {
        return { target, rows: await api.exchangeList(rootOf(target), mailbox), error: null };
      } catch (e) {
        return { target, rows: [], error: errorMessage(e) };
      }
    }),
  );
}
