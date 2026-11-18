import { describe, expect, it } from "vitest";
import type { Team, TeamEdge } from "../../types";
import {
  COL,
  NODE_H,
  NODE_W,
  RETURN_DROP,
  ROW,
  autoPositions,
  canConnect,
  edgeGeo,
  edgeGeos,
  fitViewport,
  layersOf,
  markPoints,
  returnEdges,
  returnLinePoints,
  sourcePoint,
  skyPoints,
  starPoint,
} from "./layout";

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

// D161: a team may loop. The layering still needs an acyclic graph, so the
// edges that close a loop are set aside as the ways back.
describe("returnEdges", () => {
  it("finds none in a team without a loop", () => {
    expect(returnEdges([edge("a", "b"), edge("b", "c"), edge("a", "c")]).size).toBe(0);
  });

  it("names the edge that closed the loop, in the order they were drawn", () => {
    expect([...returnEdges([edge("a", "b"), edge("b", "c"), edge("c", "a")])]).toEqual(["c->a"]);
    // Same three, drawn in another order: whichever arrives last closes it.
    expect([...returnEdges([edge("c", "a"), edge("a", "b"), edge("b", "c")])]).toEqual(["b->c"]);
  });

  it("takes the second of a pair that send to each other", () => {
    expect([...returnEdges([edge("a", "b"), edge("b", "a")])]).toEqual(["b->a"]);
  });

  it("leaves an acyclic graph behind, however many loops share a member", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("b", "a"), edge("c", "b")];
    const back = returnEdges(edges);
    const forward = edges.filter((e) => !back.has(`${e.from}->${e.to}`));
    expect(returnEdges(forward).size).toBe(0);
  });
});

describe("layersOf on a loop", () => {
  it("layers by the flows forward and stops", () => {
    const layers = layersOf(team(["a", "b", "c"], [edge("a", "b"), edge("b", "c"), edge("c", "a")]));
    expect([layers.get("a"), layers.get("b"), layers.get("c")]).toEqual([0, 1, 2]);
  });

  it("gives every return flow a negative span", () => {
    const t = team(["a", "b", "c"], [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("b", "a")]);
    const layers = layersOf(t);
    for (const key of returnEdges(t.edges)) {
      const [from, to] = key.split("->");
      expect(layers.get(to)! - layers.get(from)!).toBeLessThan(0);
    }
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

  // D161: findings go back upstream, so an edge that closes a loop is a
  // flow like any other. A delivery still crosses one edge per publish.
  it("allows a flow back upstream, however long the way round", () => {
    expect(canConnect("b", "a", chain)).toBe(true);
    expect(canConnect("c", "a", chain)).toBe(true);
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

  // The design's T-0063: a node stepped off a skip edge used to land on the
  // next node down its own column.
  it("never stacks two nodes of one column on top of each other", () => {
    const t = team(
      ["a", "b", "c", "d", "e"],
      [edge("a", "b"), edge("b", "c"), edge("a", "c"), edge("a", "d"), edge("d", "e"), edge("b", "e")],
    );
    const pos = autoPositions(t);
    const layer = layersOf(t);
    for (const p of ["a", "b", "c", "d", "e"]) {
      for (const q of ["a", "b", "c", "d", "e"]) {
        if (p >= q || layer.get(p) !== layer.get(q)) continue;
        expect(Math.abs(pos[p].y - pos[q].y), `${p} / ${q}`).toBeGreaterThanOrEqual(ROW - 0.5);
      }
    }
  });
});

// The design's five test shapes (spec 50 §11, scenes 72–76), checked the way
// the design checked them: at 1440 the canvas is 896 × 560, and fitted there
// every name must still read at 12px (the name is 14px, so zoom ≥ 12/14),
// nodes must not overlap and crossing lines' marks must not pile up.
const chain = (ids: string[]) => ids.slice(1).map((id, i) => edge(ids[i], id));
const SHAPES: Record<string, Team> = {
  chain3: team(["res", "ux", "docs"], chain(["res", "ux", "docs"])),
  chain4: team(["spec", "sdk", "sdkt", "notes"], [...chain(["spec", "sdk", "sdkt", "notes"]), edge("spec", "sdkt")]),
  diamond: team(["tok", "web", "ios", "qa"], [edge("tok", "web"), edge("tok", "ios"), edge("web", "qa"), edge("ios", "qa")]),
  loose: team(["etl", "dash", "ml", "infra"], [edge("etl", "dash")]),
  big: team(
    ["brand", "cms", "price", "store", "mob", "mail", "srch", "stats", "kb"],
    [
      edge("brand", "store"),
      edge("brand", "mob"),
      edge("brand", "mail"),
      edge("cms", "store"),
      edge("cms", "mail"),
      edge("cms", "srch"),
      edge("price", "store"),
      edge("price", "mob"),
      edge("store", "stats"),
      edge("mob", "stats"),
      edge("mail", "stats"),
      edge("srch", "kb"),
    ],
  ),
};
const BOX = { w: 896, h: 560 };
// Zoom buttons bottom-left (three 30px buttons), minimap bottom-right (180 × 120).
const OBSTACLES = [
  { l: 12, t: 456, r: 44, b: 548 },
  { l: 704, t: 428, r: 884, b: 548 },
];

describe("the design's team shapes", () => {
  for (const [name, t] of Object.entries(SHAPES)) {
    it(`${name}: fits 1440 with names at 12px or more, no overlap`, () => {
      const pos = autoPositions(t);
      const ids = t.members.map((m) => m.workspaceId);
      const extra = ids.map((id) => ({ x: pos[id].x - 18, y: pos[id].y + NODE_H / 2 }));
      const view = fitViewport(pos, ids, extra, BOX, OBSTACLES);
      expect(view.zoom * 14).toBeGreaterThanOrEqual(12);
      for (const a of ids) {
        for (const b of ids) {
          if (a >= b) continue;
          const apart =
            Math.abs(pos[a].x - pos[b].x) >= NODE_W || Math.abs(pos[a].y - pos[b].y) >= NODE_H;
          expect(apart, `${a} overlaps ${b}`).toBe(true);
        }
      }
    });
  }

  it("big: the twelve direction marks keep clear of each other", () => {
    const t = SHAPES.big;
    const marks = Object.values(markPoints(t, autoPositions(t)));
    expect(marks).toHaveLength(12);
    let close = 0;
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        if (Math.hypot(marks[i].x - marks[j].x, marks[i].y - marks[j].y) < 19) close++;
      }
    }
    expect(close).toBe(0);
  });

  it("big: no mark sits on a star", () => {
    const t = SHAPES.big;
    const pos = autoPositions(t);
    const stars = t.members.map((m) => starPoint(pos[m.workspaceId]));
    for (const m of Object.values(markPoints(t, pos))) {
      for (const s of stars) expect(Math.hypot(m.x - s.x, m.y - s.y)).toBeGreaterThanOrEqual(21);
    }
  });
});

describe("edgeGeo", () => {
  it("bows a skip edge over whatever sits between its ends", () => {
    const g = edgeGeo({ x: 0, y: 100 }, { x: 600, y: 100 }, 2);
    expect(g.mid.y).toBeLessThan(100);
  });

  it("draws the default S-curve between neighbouring layers", () => {
    const g = edgeGeo({ x: 0, y: 0 }, { x: 200, y: 100 }, 1);
    expect(g.n).toEqual([0, 0, 100, 0, 100, 100, 200, 100]);
  });

  // D161: drawn the default way, a flow back upstream runs straight back
  // through both boxes it joins.
  it("runs a flow back upstream underneath its row, between it and the next", () => {
    const t = team(["a", "b"], [edge("a", "b"), edge("b", "a")]);
    const pos = autoPositions(t);
    const g = edgeGeos(t, pos)["b->a"];
    const handleY = pos.a.y + NODE_H / 2;
    expect(g.mid.y).toBeGreaterThan(pos.a.y + NODE_H); // below the boxes
    expect(g.mid.y).toBeLessThan(pos.a.y + ROW); // above the next row's
    expect(g.mid.y - handleY).toBeCloseTo(RETURN_DROP * 0.75);
  });

  it("keeps a flow back upstream out of the boxes it leaves and enters", () => {
    // One layer back and three layers back: the reach out right grows with the run.
    for (const n of [2, 4]) {
      const ids = Array.from({ length: n }, (_, i) => `m${i}`);
      const chain = ids.slice(1).map((id, i) => edge(ids[i], id));
      const t = team(ids, [...chain, edge(ids[n - 1], ids[0])]);
      const pos = autoPositions(t);
      const g = edgeGeos(t, pos)[`${ids[n - 1]}->${ids[0]}`];
      const boxes = [pos[ids[0]], pos[ids[n - 1]]];
      for (let k = 1; k < 40; k++) {
        const u = k / 40;
        const v = 1 - u;
        const x = v * v * v * g.n[0] + 3 * v * v * u * g.n[2] + 3 * v * u * u * g.n[4] + u * u * u * g.n[6];
        const y = v * v * v * g.n[1] + 3 * v * v * u * g.n[3] + 3 * v * u * u * g.n[5] + u * u * u * g.n[7];
        for (const b of boxes) {
          const inside = x > b.x + 2 && x < b.x + NODE_W - 2 && y > b.y + 2 && y < b.y + NODE_H - 2;
          expect(inside, `n=${n} u=${u.toFixed(3)} at ${x.toFixed(0)},${y.toFixed(0)}`).toBe(false);
        }
      }
      expect(g.n[0]).toBe(sourcePoint(pos[ids[n - 1]]).x);
    }
  });

  it("hands a fit the flows back, and nothing at all for a team without a loop", () => {
    const plain = team(["a", "b", "c"], [edge("a", "b"), edge("b", "c")]);
    expect(returnLinePoints(plain, autoPositions(plain))).toEqual([]);
    const looped = team(["a", "b", "c"], [edge("a", "b"), edge("b", "c"), edge("c", "a")]);
    const pos = autoPositions(looped);
    const pts = returnLinePoints(looped, pos);
    // It reaches out right of the last box and down below the row: what a box-only fit cut off.
    expect(Math.max(...pts.map((p) => p.x))).toBeGreaterThan(pos.c.x + NODE_W);
    expect(Math.max(...pts.map((p) => p.y))).toBeGreaterThan(pos.c.y + NODE_H);
  });

  // The first AI walkthrough of D161: a→b, a→c, b→c steps b a row down off
  // the a→c skip line, so b→a runs back to a node a row HIGHER — and with the
  // bend hung off each end's own height it ran through b's own words.
  it("keeps every flow back clear of every box when the ends sit on different rows", () => {
    const t = team(["a", "b", "c"], [edge("a", "b"), edge("a", "c"), edge("b", "c"), edge("c", "a"), edge("b", "a")]);
    const pos = autoPositions(t);
    expect(pos.b.y).toBeGreaterThan(pos.a.y); // the shape this test is about
    const geos = edgeGeos(t, pos);
    for (const key of returnEdges(t.edges)) {
      const g = geos[key];
      for (let k = 2; k < 38; k++) {
        const u = k / 40;
        const v = 1 - u;
        const x = v * v * v * g.n[0] + 3 * v * v * u * g.n[2] + 3 * v * u * u * g.n[4] + u * u * u * g.n[6];
        const y = v * v * v * g.n[1] + 3 * v * v * u * g.n[3] + 3 * v * u * u * g.n[5] + u * u * u * g.n[7];
        for (const [id, b] of Object.entries(pos)) {
          const inside = x > b.x + 2 && x < b.x + NODE_W - 2 && y > b.y + 2 && y < b.y + NODE_H - 2;
          expect(inside, `${key} u=${u.toFixed(3)} inside ${id} at ${x.toFixed(0)},${y.toFixed(0)}`).toBe(false);
        }
      }
    }
  });
});

describe("fitViewport", () => {
  it("never magnifies a small team past 1.2", () => {
    const t = team(["a", "b"], [edge("a", "b")]);
    const pos = autoPositions(t);
    expect(fitViewport(pos, ["a", "b"], [], BOX, OBSTACLES).zoom).toBeLessThanOrEqual(1.2);
  });

  it("keeps nodes out from under the minimap when another area fits", () => {
    const t = SHAPES.big;
    const pos = autoPositions(t);
    const ids = t.members.map((m) => m.workspaceId);
    const v = fitViewport(pos, ids, [], BOX, OBSTACLES);
    const o = OBSTACLES[1];
    for (const id of ids) {
      const l = v.x + pos[id].x * v.zoom;
      const r = v.x + (pos[id].x + NODE_W) * v.zoom;
      const top = v.y + pos[id].y * v.zoom;
      const b = v.y + (pos[id].y + NODE_H) * v.zoom;
      expect(r <= o.l || o.r <= l || b <= o.t || o.b <= top, id).toBe(true);
    }
  });
});

describe("fitViewport: what is drawn, not just the box (F26)", () => {
  // A member low on the left, the rest up and to the right: fitted on the
  // boxes alone, the column right of the zoom buttons wins and the low
  // member's box sits flush against them — with its star, drawn 18px left of
  // the box, half under them.
  const pos = { a: { x: 0, y: 360 }, b: { x: 500, y: 0 }, c: { x: 250, y: 180 } };
  const ids = ["a", "b", "c"];
  const extra = ids.map((id) => ({ x: pos[id as "a"].x - 18, y: pos[id as "a"].y + 40 }));
  const starUnderButtons = (reach: number) => {
    const v = fitViewport(pos, ids, extra, BOX, OBSTACLES, reach);
    const ctrl = OBSTACLES[0];
    return ids.some((id) => {
      const p = pos[id as "a"];
      const l = v.x + (p.x - 18) * v.zoom;
      const r = v.x + (p.x + NODE_W) * v.zoom;
      const t = v.y + p.y * v.zoom;
      const b = v.y + (p.y + NODE_H) * v.zoom;
      return !(r <= ctrl.l || ctrl.r <= l || b <= ctrl.t || ctrl.b <= t);
    });
  };

  it("judged on the box alone, the star ends up under the zoom buttons", () => {
    expect(starUnderButtons(0)).toBe(true);
  });

  it("judged on the star too, it stays clear", () => {
    expect(starUnderButtons(18)).toBe(false);
  });
});

describe("skyPoints", () => {
  it("keeps the constellation centred and inside the card", () => {
    const t = SHAPES.big;
    const sky = skyPoints(t, autoPositions(t));
    const xs = Object.values(sky).map((p) => p.x);
    const ys = Object.values(sky).map((p) => p.y);
    expect(Math.min(...xs)).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(100);
    expect(Math.min(...ys)).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeLessThan(100);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(50, 0);
  });

  it("does not stretch two stars across the whole card", () => {
    const t = team(["a", "b"], [edge("a", "b")]);
    const sky = skyPoints(t, autoPositions(t));
    // The 0.56 cap, not the card width, sets the gap.
    expect(sky.b.x - sky.a.x).toBeCloseTo(((COL * 0.56) / 340) * 100, 1);
  });
});
