import { describe, expect, it } from "vitest";

import { boardDiff, diffSignature, isQuiet, unresolvedDeps } from "./model";
import type { Task } from "../../types";

function task(id: string, o: Partial<Task> = {}): Task {
  return { id, title: id, status: "todo", priority: 1, ...o } as Task;
}

describe("boardDiff", () => {
  it("is quiet when a re-read changed nothing", () => {
    const a = [task("T-1", { assignee: "design" }), task("T-2")];
    const d = boardDiff(a, a.map((t) => ({ ...t })));
    expect(isQuiet(d)).toBe(true);
  });

  it("sees a claim as a card that changed column", () => {
    const d = boardDiff([task("T-1")], [task("T-1", { assignee: "design" })]);
    expect(d.moved).toEqual(["T-1"]);
    expect(isQuiet(d)).toBe(false);
  });

  it("treats a new task, and an unarchived one, as arrivals", () => {
    const d = boardDiff(
      [task("T-1", { archived: true })],
      [task("T-1"), task("T-2")],
    );
    expect(d.arrived).toEqual(["T-1", "T-2"]);
    expect(d.moved).toEqual([]);
  });

  it("ignores archived cards entirely", () => {
    const d = boardDiff([task("T-1")], [task("T-1", { archived: true, assignee: "x" })]);
    expect(isQuiet(d)).toBe(true);
  });

  it("unlocks a card whose last dependency finished, and remembers what it waited on", () => {
    const prev = [
      task("T-1", { status: "in_progress" }),
      task("T-2", { status: "done" }),
      task("T-3", { dependsOn: ["T-1", "T-2"] }),
    ];
    const next = prev.map((t) => (t.id === "T-1" ? { ...t, status: "done" as const } : t));
    const d = boardDiff(prev, next);
    expect(d.finished).toEqual(["T-1"]);
    expect(d.unlocks).toEqual([{ waiter: "T-3", was: ["T-1"] }]);
  });

  it("does not unlock a card that still waits on something", () => {
    const prev = [task("T-1"), task("T-2"), task("T-3", { dependsOn: ["T-1", "T-2"] })];
    const next = prev.map((t) => (t.id === "T-1" ? { ...t, status: "done" as const } : t));
    expect(boardDiff(prev, next).unlocks).toEqual([]);
  });
});

describe("unresolvedDeps", () => {
  it("counts a dependency the board cannot find as unresolved", () => {
    const byId = new Map([["T-1", task("T-1", { status: "done" })]]);
    expect(unresolvedDeps(task("T-2", { dependsOn: ["T-1", "T-9"] }), byId)).toEqual(["T-9"]);
  });
});

describe("diffSignature", () => {
  it("is the same for the same change read twice, and differs for another assignee", () => {
    const prev = [task("T-1")];
    const a = [task("T-1", { assignee: "design" })];
    const b = [task("T-1", { assignee: "qa" })];
    expect(diffSignature(boardDiff(prev, a), a)).toBe(diffSignature(boardDiff(prev, a), a));
    expect(diffSignature(boardDiff(prev, a), a)).not.toBe(diffSignature(boardDiff(prev, b), b));
  });
});
