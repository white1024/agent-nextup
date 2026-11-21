/**
 * What the projects overview derives from the registry rows, the running
 * terminal sessions and the cross-project activity (D155) — pure, so the rules
 * that decide what the page says can be checked without mounting it.
 */
import { normRoot } from "../../lib/exchange";

// The hub's labels and the waiting keys moved to lib/sessions when the agent
// overview became their second caller; re-exported so this page's imports and
// tests read the way they did.
export { sessionLabel, shortName, waitKey, waitingKeys } from "../../lib/sessions";
import type {
  AgentCall,
  ProjectActivity,
  TaskCounts,
  TerminalSessionMeta,
  WorkspaceOverview,
} from "../../types";

export type CellKind = "ver" | "unv" | "ip" | "todo" | "blk";

/** Order the cells are laid out in: settled work first, what waits on you last. */
const CELL_ORDER: CellKind[] = ["ver", "unv", "ip", "todo", "blk"];

/**
 * Done over the work still meant to happen: cancelled tasks leave the
 * denominator (D169), the same rule the engine's `progress` uses. `live` is
 * what the card prints as the total.
 */
export function progressOf(c: TaskCounts): { done: number; live: number; pct: number } {
  const live = Math.max(0, c.total - (c.cancelled ?? 0));
  return { done: c.done, live, pct: live > 0 ? c.done / live : 0 };
}

/** One cell per task, grouped by kind. Cancelled tasks draw no cell: the cells
 *  are the work, and a cancelled task is not part of it any more (D169). */
export function cellsOf(c: TaskCounts): CellKind[] {
  const n: Record<CellKind, number> = {
    ver: c.done - c.doneUnverified,
    unv: c.doneUnverified,
    ip: c.inProgress,
    todo: c.todo,
    blk: c.blocked,
  };
  return CELL_ORDER.flatMap((k) => Array<CellKind>(Math.max(0, n[k])).fill(k));
}

/**
 * Most cells a card draws before folding the rest into "+N" (invariant 16): a
 * project with a few hundred tasks would otherwise grow its card without end.
 * Three rows at the narrowest card width.
 */
export const CELLS_MAX = 72;

/** Indexes whose kind changed between two cell lists (C9 flips those). */
export function changedCells(before: CellKind[], after: CellKind[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) out.add(i);
  return out;
}

/** The running session that answers to `actor` in `root`, if any. */
export function sessionFor(
  sessions: TerminalSessionMeta[],
  root: string,
  actor: string | undefined,
): TerminalSessionMeta | null {
  if (actor === undefined) return null;
  const key = normRoot(root);
  return sessions.find((s) => s.identity === actor && normRoot(s.root) === key) ?? null;
}

/** One stream row: a call, the project it happened in, and a stable key. */
export interface FeedRow extends AgentCall {
  key: string;
  root: string;
}

/**
 * Every call in `rows`, keyed. A key is the project, the second, the actor, the
 * tool and how many identical calls came before it in that project's window —
 * `at` has one-second resolution, so two identical calls in one second need
 * the count to stay apart.
 */
export function keyedCalls(rows: ProjectActivity[]): FeedRow[] {
  const out: FeedRow[] = [];
  for (const row of rows) {
    const seen = new Map<string, number>();
    const root = normRoot(row.root);
    for (const call of row.calls) {
      const base = `${root}#${call.at}#${call.actor ?? ""}#${call.tool ?? ""}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.push({ ...call, root: row.root, key: `${base}#${n}` });
    }
  }
  return out;
}

/** Newest first, at most `limit` — the stream (C12) shows nine. */
export function feedRows(calls: FeedRow[], limit = 9): FeedRow[] {
  return [...calls]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}

/** Activity rows keyed by normalized root. */
export function activityByRoot(rows: ProjectActivity[] | null): Map<string, ProjectActivity> {
  return new Map((rows ?? []).map((r) => [normRoot(r.root), r]));
}

/**
 * The header's "waiting on you": blocked and done-but-unverified tasks in
 * every project, plus denials still waiting. `null` until both halves are
 * known — a "0" before the activity read lands would be a claim, not a count.
 */
export function waitingTotal(
  overview: WorkspaceOverview[],
  activity: ProjectActivity[] | null,
): number | null {
  if (activity === null) return null;
  const tasks = overview.reduce(
    (n, w) =>
      n +
      (w.taskCounts ? w.taskCounts.blocked + w.taskCounts.doneUnverified : 0) +
      // D170: the To decide queue is on each card's amber line, so here too.
      (w.youCounts ? w.youCounts.questions + w.youCounts.decisions : 0),
    0,
  );
  return tasks + activity.reduce((n, a) => n + a.waiting.length, 0);
}

/** Calls today across projects, and whether any project's count is a floor. */
export function callsToday(activity: ProjectActivity[] | null): { n: number; floor: boolean } | null {
  if (activity === null) return null;
  return {
    n: activity.reduce((n, a) => n + a.callsSince, 0),
    floor: activity.some((a) => a.capped),
  };
}

/** The newer of two ISO timestamps (either may be missing). */
export function latestAt(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

