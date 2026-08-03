import { describe, expect, it } from "vitest";
import type { Team, TeamEdge } from "../../types";
import { COL, ROW, ancestorsOf, autoPositions, canConnect, layersOf } from "./layout";

function edge(from: string, to: string): TeamEdge {
  return { from, to, autoRoute: false };
}

function team(memberIds: string[], edges: TeamEdge[]): Team {
  return {
    id: "t1",
    name: "Team",
    members: memberIds.map((id) => ({ workspaceId: id, root: `C:/proj/${id}`, name: id })),
    edges,
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
  };
}

describe("layersOf", () => {
  it("puts the upstream member at layer 0 and walks downstream", () => {
    const layers = layersOf(team(["a", "b", "c"], [edge("a", "b"), edge("b", "c")]));
    expect(layers.get("a")).toBe(0);
    expect(layers.get("b")).toBe(1);
    expect(layers.get("c")).toBe(2);
  });

  // Longest path, not shortest: with a skip edge present, c is still two layers
  // downstream, otherwise the a→c edge would draw backwards through the grid.
  //
  // Both edge orders, deliberately. Fed the long way first, even a shortest-path
  // implementation lands on 2 by accident — only the skip-edge-first order tells
  // the two apart, because it forces the layer of an already-placed node up.
  it("takes the longest path whichever order the edges arrive in", () => {
    const long = [edge("a", "b"), edge("b", "c"), edge("a", "c")];
    const skipFirst = [edge("a", "c"), edge("a", "b"), edge("b", "c")];
    expect(layersOf(team(["a", "b", "c"], long)).get("c")).toBe(2);
    expect(layersOf(team(["a", "b", "c"], skipFirst)).get("c")).toBe(2);
  });

  it("leaves unwired members out of the map entirely", () => {
    const layers = layersOf(team(["a", "b", "loner"], [edge("a", "b")]));
    expect(layers.has("loner")).toBe(false);
  });

  it("layers a diamond by its longer arm", () => {
    const layers = layersOf(
      team(["a", "b", "c", "d"], [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")]),
    );
    expect(layers.get("d")).toBe(2);
  });
});

describe("ancestorsOf", () => {
  it("collects every node that can reach the target, including itself", () => {
    const ancestors = ancestorsOf("c", [edge("a", "b"), edge("b", "c")]);
    expect([...ancestors].sort()).toEqual(["a", "b", "c"]);
  });

  it("excludes nodes that only sit downstream", () => {
    expect(ancestorsOf("a", [edge("a", "b")]).has("b")).toBe(false);
  });
});

describe("canConnect", () => {
  const chain = [edge("a", "b"), edge("b", "c")];

  it("allows a skip edge that does not close a cycle", () => {
    expect(canConnect("a", "c", chain)).toBe(true);
  });

  it("rejects a self-edge and an unset endpoint", () => {
    expect(canConnect("a", "a", chain)).toBe(false);
    expect(canConnect("", "a", chain)).toBe(false);
    expect(canConnect("a", "", chain)).toBe(false);
  });

  it("rejects an edge that already exists", () => {
    expect(canConnect("a", "b", chain)).toBe(false);
  });

  // The invariant behind the whole team graph: edges always form a DAG, so a
  // delivery route can never feed back into its own source.
  it("rejects anything that would close a cycle, however long the way round", () => {
    expect(canConnect("b", "a", chain)).toBe(false);
    expect(canConnect("c", "a", chain)).toBe(false);
  });
});

describe("autoPositions", () => {
  it("is deterministic for the same team shape", () => {
    const t = team(["a", "b", "c"], [edge("a", "b"), edge("b", "c")]);
    expect(autoPositions(t)).toEqual(autoPositions(t));
  });

  it("places each layer one column further right", () => {
    const pos = autoPositions(team(["a", "b", "c"], [edge("a", "b"), edge("b", "c")]));
    expect(pos.b.x - pos.a.x).toBe(COL);
    expect(pos.c.x - pos.b.x).toBe(COL);
  });

  // The D53 walkthrough report: after "Tidy up", a→b→c plus a→c landed all
  // three on one row and the skip edge vanished behind b. A bypassed node has
  // to step off the line it would otherwise hide.
  it("steps a bypassed node off the skip edge it would hide", () => {
    const pos = autoPositions(
      team(["a", "b", "c"], [edge("a", "b"), edge("b", "c"), edge("a", "c")]),
    );
    const ratio = (pos.b.x - pos.a.x) / (pos.c.x - pos.a.x);
    const lineY = pos.a.y + (pos.c.y - pos.a.y) * ratio;
    expect(Math.abs(pos.b.y - lineY)).toBeGreaterThanOrEqual(ROW * 0.75);
  });

  it("parks unwired members below every wired one", () => {
    const pos = autoPositions(team(["a", "b", "loner"], [edge("a", "b")]));
    expect(pos.loner.y).toBeGreaterThan(Math.max(pos.a.y, pos.b.y));
  });

  it("wraps a wireless team into rows of four", () => {
    const pos = autoPositions(team(["a", "b", "c", "d", "e"], []));
    expect(pos.a.y).toBe(pos.d.y);
    expect(pos.e.y).toBe(pos.a.y + ROW);
    expect(pos.e.x).toBe(pos.a.x);
  });
});
