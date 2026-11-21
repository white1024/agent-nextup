import { describe, expect, it } from "vitest";

import type { ImportRow, Team } from "../../types";
import { defaultTake, mergeRelink, newerSide, scopeReport, takeList } from "./transfer";

function row(over: Partial<ImportRow>): ImportRow {
  return {
    id: "t",
    name: "team",
    status: "differs",
    members: 2,
    edges: 1,
    prime: null,
    fileUpdatedAt: "2026-11-20T10:00:00Z",
    localName: "team",
    localUpdatedAt: "2026-11-20T09:00:00Z",
    ...over,
  };
}

describe("import defaults (D173 ②)", () => {
  it("adds what this machine lacks and leaves identical teams alone", () => {
    expect(defaultTake(row({ status: "new", localUpdatedAt: null, localName: null }))).toBe(true);
    expect(defaultTake(row({ status: "same" }))).toBe(false);
  });

  it("picks the newer side when both differ", () => {
    expect(newerSide(row({}))).toBe("file");
    expect(defaultTake(row({}))).toBe(true);
    const localNewer = row({ localUpdatedAt: "2026-11-21T00:00:00Z" });
    expect(newerSide(localNewer)).toBe("local");
    expect(defaultTake(localNewer)).toBe(false);
  });

  it("compares instants, not strings", () => {
    // Same instant written two ways: lexically the offset form sorts later.
    const sameInstant = row({ fileUpdatedAt: "2026-11-20T18:00:00+08:00", localUpdatedAt: "2026-11-20T10:00:00Z" });
    expect(newerSide(sameInstant)).toBe("tie");
  });

  it("keeps this machine's on a tie or an unreadable stamp", () => {
    expect(defaultTake(row({ localUpdatedAt: "2026-11-20T10:00:00Z" }))).toBe(false);
    expect(newerSide(row({ fileUpdatedAt: "garbage" }))).toBe("tie");
    expect(defaultTake(row({ fileUpdatedAt: "garbage" }))).toBe(false);
  });

  it("never sends a team with nothing to do", () => {
    const rows = [row({ id: "a" }), row({ id: "b", status: "same" }), row({ id: "c", status: "new" })];
    expect(takeList(rows, new Set(["a", "b", "c"]))).toEqual(["a", "c"]);
    expect(takeList(rows, new Set(["c"]))).toEqual(["c"]);
  });
});

describe("re-link reports (D173 ①)", () => {
  const ws = (id: string) => ({ workspaceId: id, name: id, root: `/x/${id}` });
  const team = (members: string[], prime?: string) =>
    ({
      id: "t",
      name: "t",
      members: members.map(ws),
      edges: [],
      prime: prime === undefined ? undefined : ws(prime),
      createdAt: "",
      updatedAt: "",
    }) as Team;

  it("speaks only about the teams on the page, coordinator included", () => {
    const report = { relinked: [ws("a"), ws("z")], missing: [ws("boss"), ws("y")] };
    expect(scopeReport(report, [team(["a", "b"], "boss")])).toEqual({ relinked: [ws("a")], missing: [ws("boss")] });
  });

  it("keeps what was found and takes the latest missing list", () => {
    const first = { relinked: [ws("a")], missing: [ws("b"), ws("c")] };
    const second = { relinked: [ws("b"), ws("a")], missing: [ws("c")] };
    expect(mergeRelink(first, second)).toEqual({ relinked: [ws("a"), ws("b")], missing: [ws("c")] });
  });
});
