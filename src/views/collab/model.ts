/**
 * Pure helpers for the collab board: which of the drawn cards a fresh read
 * moved, brought in, or unlocked. The board trails the data on purpose — it
 * measures the old board, then applies the change — and these say what the
 * change was, so a watcher re-read that changed nothing animates nothing.
 */

import type { Task } from "../../types";

export interface Unlock {
  /** The card that was waiting. */
  waiter: string;
  /** What it was still waiting on before this read (kept on screen until the light lands). */
  was: string[];
}

export interface BoardDiff {
  /** Cards that changed column (same task, another assignee). */
  moved: string[];
  /** Cards that were not on the board before (created, or unarchived). */
  arrived: string[];
  /** Cards whose last unfinished dependency just finished (C163). */
  unlocks: Unlock[];
  /** Tasks that turned done in this read. */
  finished: string[];
}

const who = (task: Task) => task.assignee ?? null;

/** Dependencies of `task` that are not done, judged against `byId`. */
export function unresolvedDeps(task: Task, byId: ReadonlyMap<string, Task>): string[] {
  return (task.dependsOn ?? []).filter((id) => byId.get(id)?.status !== "done");
}

export function boardDiff(prev: readonly Task[], next: readonly Task[]): BoardDiff {
  const before = new Map(prev.map((task) => [task.id, task]));
  const after = new Map(next.map((task) => [task.id, task]));
  const moved: string[] = [];
  const arrived: string[] = [];
  const unlocks: Unlock[] = [];
  const finished: string[] = [];
  for (const task of next) {
    const was = before.get(task.id);
    if (task.archived) continue;
    if (was === undefined || was.archived) {
      arrived.push(task.id);
      continue;
    }
    if (who(was) !== who(task)) moved.push(task.id);
    if (was.status !== "done" && task.status === "done") finished.push(task.id);
    const waitedOn = unresolvedDeps(was, before);
    if (waitedOn.length > 0 && unresolvedDeps(task, after).length === 0) {
      unlocks.push({ waiter: task.id, was: waitedOn });
    }
  }
  return { moved, arrived, unlocks, finished };
}

/** True when the read changes nothing worth a motion (cards may still leave). */
export function isQuiet(d: BoardDiff): boolean {
  return d.moved.length === 0 && d.arrived.length === 0 && d.unlocks.length === 0 && d.finished.length === 0;
}

/**
 * A fingerprint of the motion a diff would play. A second read that lands
 * while the first is still being played (the watcher after our own write)
 * has the same one, and must not start it again.
 */
export function diffSignature(d: BoardDiff, next: readonly Task[]): string {
  const at = new Map(next.map((task) => [task.id, task]));
  return [
    d.moved.map((id) => `${id}>${who(at.get(id) as Task) ?? ""}`).join(","),
    d.arrived.join(","),
    d.unlocks.map((u) => u.waiter).join(","),
    d.finished.join(","),
  ].join("|");
}
