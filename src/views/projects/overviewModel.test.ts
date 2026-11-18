import { describe, expect, it } from "vitest";

// The card's half of the unset-domain guard (D137; the dashboard's half is
// src/domainChip.test.ts). `?raw` because what is held is where a rule lives.
import cardSource from "./ProjectCard.tsx?raw";
import type { ProjectActivity, TerminalSessionMeta, WorkspaceOverview } from "../../types";
import {
  callsToday,
  cellsOf,
  changedCells,
  feedRows,
  keyedCalls,
  latestAt,
  sessionFor,
  shortName,
  waitKey,
  waitingKeys,
  waitingTotal,
} from "./overviewModel";

const counts = { total: 6, todo: 1, inProgress: 1, blocked: 1, done: 3, doneUnverified: 1 };

function act(root: string, over: Partial<ProjectActivity> = {}): ProjectActivity {
  return { root, calls: [], callsSince: 0, capped: false, waiting: [], ...over };
}

function session(over: Partial<TerminalSessionMeta>): TerminalSessionMeta {
  return {
    id: 1,
    root: "C:\\ws\\a",
    workspaceId: null,
    agentId: "claude",
    title: "Claude Code",
    identity: "design",
    startedAt: "2026-11-12T00:00:00Z",
    status: "running",
    exitCode: null,
    poppedOut: false,
    ...over,
  };
}

describe("the project card", () => {
  it("asks shownDomain instead of comparing the word itself", () => {
    expect(cardSource).toContain("shownDomain(");
    expect(cardSource).not.toMatch(/[=!]==\s*["']general["']/);
  });
});

describe("cells", () => {
  it("lays settled work first and what waits on you last", () => {
    expect(cellsOf(counts)).toEqual(["ver", "ver", "unv", "ip", "todo", "blk"]);
  });

  it("flips only the cells whose kind changed", () => {
    const before = cellsOf(counts);
    const after = cellsOf({ ...counts, inProgress: 0, done: 4, doneUnverified: 2 });
    expect([...changedCells(before, after)]).toEqual([3]);
  });
});

describe("names", () => {
  it("cuts at a colon and caps at 16 characters", () => {
    expect(shortName("\u5ba2\u6236\u5165\u53e3\u7db2\u7ad9\u91cd\u69cb\uff1a\u7b2c\u4e8c\u671f")).toBe(
      "\u5ba2\u6236\u5165\u53e3\u7db2\u7ad9\u91cd\u69cb",
    );
    expect(shortName("Billing: phase two")).toBe("Billing");
    expect(shortName("a".repeat(20))).toBe(`${"a".repeat(15)}\u2026`);
  });
});

describe("activity", () => {
  it("keys identical calls in one second apart", () => {
    const call = { at: "2026-11-12T10:00:00Z", actor: "x", tool: "list_tasks", outcome: "ok" as const };
    const keys = keyedCalls([act("C:\\ws\\a", { calls: [call, call] })]).map((c) => c.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("orders the stream newest first across projects", () => {
    const rows = keyedCalls([
      act("a", { calls: [{ at: "2026-11-12T10:00:01Z" }, { at: "2026-11-12T10:00:05Z" }] }),
      act("b", { calls: [{ at: "2026-11-12T10:00:03Z" }] }),
    ]);
    expect(feedRows(rows, 2).map((r) => r.at)).toEqual(["2026-11-12T10:00:05Z", "2026-11-12T10:00:03Z"]);
  });

  it("says nothing about waiting until the activity has been read", () => {
    const ws = [{ taskCounts: counts } as WorkspaceOverview];
    expect(waitingTotal(ws, null)).toBeNull();
    expect(callsToday(null)).toBeNull();
    const read = [act("a", { waiting: [{ at: "t", actor: "x", tool: "advance_phase" }] })];
    expect(waitingTotal(ws, read)).toBe(1 + 1 + 1);
  });

  it("flags today's count as a floor when any window ran out", () => {
    expect(callsToday([act("a", { callsSince: 4 }), act("b", { callsSince: 3, capped: true })])).toEqual({
      n: 7,
      floor: true,
    });
  });

  it("matches a session by identity and root, however the root is spelled", () => {
    const s = session({ root: "C:\\WS\\A\\" });
    expect(sessionFor([s], "c:/ws/a", "design")).toBe(s);
    expect(sessionFor([s], "c:/ws/a", "other")).toBeNull();
    expect(sessionFor([s], "c:/ws/a", undefined)).toBeNull();
    const keys = waitingKeys([act("C:\\ws\\a", { waiting: [{ at: "t", actor: "design", tool: "x" }] })]);
    expect(keys.has(waitKey(s.root, s.identity))).toBe(true);
  });

  it("shows the newer of last opened and last call", () => {
    expect(latestAt("2026-11-12T10:00:00Z", "2026-11-12T11:00:00Z")).toBe("2026-11-12T11:00:00Z");
    expect(latestAt("2026-11-12T10:00:00Z", undefined)).toBe("2026-11-12T10:00:00Z");
  });
});
