import { describe, expect, it } from "vitest";
import type { Team, TeamEdge } from "../../types";
import { NODE_H, NODE_W, edgeKey, fitViewport } from "./layout";
import {
  miniFlowPath,
  miniOrbit,
  nearCore,
  orbitAuto,
  orbitCorners,
  orbitDraws,
  orbitGeo,
  orbitHoles,
  orbitPlan,
  planetOf,
  sideOf,
} from "./orbit";

function edge(from: string, to: string, autoRoute = false): TeamEdge {
  return { from, to, autoRoute };
}

function team(memberIds: string[], edges: TeamEdge[], id = "t1"): Team {
  return {
    id,
    name: "Team",
    members: memberIds.map((m) => ({ workspaceId: m, root: `C:/proj/${m}`, name: m })),
    edges,
    createdAt: "2026-11-13T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
  };
}

// The design's five shapes (spec 50 §22, scenes 72–76), the same teams the
// star map's tests use.
const chain = (ids: string[]) => ids.slice(1).map((m, i) => edge(ids[i], m));
const SHAPES: Record<string, Team> = {
  chain3: team(["res", "ux", "docs"], chain(["res", "ux", "docs"]), "chain3"),
  chain4: team(["spec", "sdk", "sdkt", "notes"], [...chain(["spec", "sdk", "sdkt", "notes"]), edge("spec", "sdkt")], "chain4"),
  diamond: team(["tok", "web", "ios", "qa"], [edge("tok", "web"), edge("tok", "ios"), edge("web", "qa"), edge("ios", "qa")], "diamond"),
  loose: team(["etl", "dash", "ml", "infra"], [edge("etl", "dash")], "loose"),
  big: team(
    ["brand", "cms", "price", "store", "mob", "mail", "srch", "stats", "kb"],
    [
      edge("brand", "store", true),
      edge("brand", "mob"),
      edge("brand", "mail", true),
      edge("cms", "store"),
      edge("cms", "mail"),
      edge("cms", "srch", true),
      edge("price", "store"),
      edge("price", "mob"),
      edge("store", "stats", true),
      edge("mob", "stats"),
      edge("mail", "stats"),
      edge("srch", "kb"),
    ],
    "big",
  ),
};

/** 1440's canvas, and its zoom buttons and minimap (layout.test.ts uses the same). */
const BOX = { w: 896, h: 560 };
const OBSTACLES = [
  { l: 12, t: 456, r: 44, b: 548 },
  { l: 704, t: 428, r: 884, b: 548 },
];

const sidesOf = (t: Team) => orbitPlan(t).side;
const idsOn = (t: Team, s: string) => Object.entries(sidesOf(t)).filter(([, v]) => v === s).map(([k]) => k).sort();

describe("orbitPlan: the design's shapes (§22)", () => {
  it("72 chain of three: one left, one right, the middle one on top", () => {
    const t = SHAPES.chain3;
    expect(idsOn(t, "l")).toEqual(["res"]);
    expect(idsOn(t, "r")).toEqual(["docs"]);
    expect(idsOn(t, "t")).toEqual(["ux"]);
  });

  it("73 four layers: the ends left and right, the two middles split top and bottom", () => {
    const t = SHAPES.chain4;
    expect(idsOn(t, "l")).toEqual(["spec"]);
    expect(idsOn(t, "r")).toEqual(["notes"]);
    expect([...idsOn(t, "t"), ...idsOn(t, "b")].sort()).toEqual(["sdk", "sdkt"]);
    expect(idsOn(t, "t")).toHaveLength(1);
  });

  it("74 diamond: upstream left, downstream right, one above and one below", () => {
    const t = SHAPES.diamond;
    expect(idsOn(t, "l")).toEqual(["tok"]);
    expect(idsOn(t, "r")).toEqual(["qa"]);
    expect(idsOn(t, "t")).toHaveLength(1);
    expect(idsOn(t, "b")).toHaveLength(1);
  });

  it("75 two unwired members go in the bottom row", () => {
    const t = SHAPES.loose;
    expect(idsOn(t, "l")).toEqual(["etl"]);
    expect(idsOn(t, "r")).toEqual(["dash"]);
    expect(idsOn(t, "b")).toEqual(["infra", "ml"]);
  });

  it("76 nine members: three left, two right, four split over top and bottom", () => {
    const t = SHAPES.big;
    expect(idsOn(t, "l")).toEqual(["brand", "cms", "price"]);
    expect(idsOn(t, "r")).toEqual(["kb", "stats"]);
    expect(idsOn(t, "t").length + idsOn(t, "b").length).toBe(4);
  });

  for (const [name, t] of Object.entries(SHAPES)) {
    it(`${name}: boxes keep 12px apart and each box's words face the side its place says`, () => {
      const plan = orbitPlan(t);
      const ids = Object.keys(plan.pos);
      expect(ids).toHaveLength(t.members.length);
      for (const id of ids) expect(sideOf(plan, plan.pos[id])).toBe(plan.side[id]);
      for (const a of ids) {
        for (const b of ids) {
          if (a >= b) continue;
          const p = plan.pos[a];
          const q = plan.pos[b];
          const apart = Math.abs(p.x - q.x) >= NODE_W + 12 || Math.abs(p.y - q.y) >= NODE_H + 12;
          expect(apart, `${a} touches ${b}`).toBe(true);
        }
      }
    });

    // R-50-49: fitted into 1440's canvas with the whole ring, every name (15px
    // on the orbit) still reads at 12px.
    it(`${name}: fits 1440 with names at 12px or more`, () => {
      const pos = orbitAuto(t);
      const ids = t.members.map((m) => m.workspaceId);
      const view = fitViewport(pos, ids, orbitCorners(orbitGeo(t)), BOX, OBSTACLES);
      expect(view.zoom * 15).toBeGreaterThanOrEqual(12);
    });
  }

  it("is the same plan for the same shape, and a new one when the shape changes", () => {
    const a = orbitPlan(SHAPES.chain3);
    expect(orbitPlan(SHAPES.chain3)).toBe(a);
    const grown = { ...SHAPES.chain3, edges: [...SHAPES.chain3.edges, edge("res", "docs")] };
    expect(orbitPlan(grown)).not.toBe(a);
  });

  it("goes round the orbit in order when nobody is wired", () => {
    const t = team(["a", "b", "c", "d", "e"], [], "wireless");
    const s = sidesOf(t);
    expect([s.a, s.b, s.c, s.d]).toEqual(["l", "t", "r", "b"]);
  });
});

describe("sideOf", () => {
  const g = { cx: 0, cy: 0, rx: 300, ry: 150 };
  const at = (x: number, y: number) => ({ x: x - NODE_W / 2, y: y - NODE_H / 2 });
  it("turns the words outward, a quarter turn each", () => {
    expect(sideOf(g, at(-300, 0))).toBe("l");
    expect(sideOf(g, at(300, 0))).toBe("r");
    expect(sideOf(g, at(0, -150))).toBe("t");
    expect(sideOf(g, at(0, 150))).toBe("b");
  });
  it("flips a planet dragged across the cube (R-50-41)", () => {
    expect(sideOf(g, at(-200, 20))).toBe("l");
    expect(sideOf(g, at(200, 20))).toBe("r");
  });
  it("puts the planet on the side of the box facing the cube", () => {
    const left = planetOf(g, at(-300, 0));
    expect(left.x).toBeGreaterThan(-300);
    const top = planetOf(g, at(0, -150));
    expect(top.y).toBeGreaterThan(-150);
  });
});

describe("orbitDraws", () => {
  it("draws every flow, stopping short of both planets", () => {
    const t = SHAPES.diamond;
    const g = orbitGeo(t);
    const pos = orbitAuto(t);
    const draws = orbitDraws(t, g, pos);
    expect(Object.keys(draws).sort()).toEqual(t.edges.map(edgeKey).sort());
    for (const e of t.edges) {
      const d = draws[edgeKey(e)];
      const ps = planetOf(g, pos[e.from]);
      const pt = planetOf(g, pos[e.to]);
      expect(Math.hypot(d.q[0].x - ps.x, d.q[0].y - ps.y)).toBeCloseTo(16, 0);
      expect(Math.hypot(d.q[3].x - pt.x, d.q[3].y - pt.y)).toBeCloseTo(18, 0);
      expect(d.d.startsWith("M")).toBe(true);
    }
  });

  it("big: no bolt lands on a planet or the cube, and the automatic ones keep apart", () => {
    const t = SHAPES.big;
    const g = orbitGeo(t);
    const pos = orbitAuto(t);
    const draws = orbitDraws(t, g, pos);
    const planets = t.members.map((m) => planetOf(g, pos[m.workspaceId]));
    for (const d of Object.values(draws)) {
      for (const p of planets) expect(Math.hypot(d.mark.x - p.x, d.mark.y - p.y)).toBeGreaterThan(18);
    }
    const autos = t.edges.filter((e) => e.autoRoute).map((e) => draws[edgeKey(e)].mark);
    for (let i = 0; i < autos.length; i++) {
      for (let j = i + 1; j < autos.length; j++) {
        expect(Math.hypot(autos[i].x - autos[j].x, autos[i].y - autos[j].y)).toBeGreaterThan(18);
      }
    }
  });

  // D161: two planets that send to each other. The recipe is symmetric, so
  // without the bend the two arcs are one curve drawn twice — and the bolts
  // and arrowheads of both land on the same line.
  it("a pair sending both ways gets two lanes, one each side of the shared arc", () => {
    const t = team(["build", "review", "docs"], [edge("build", "review", true), edge("review", "build", true), edge("build", "docs")]);
    const g = orbitGeo(t);
    const pos = orbitAuto(t);
    const draws = orbitDraws(t, g, pos);
    const there = draws["build->review"];
    const back = draws["review->build"];
    const mid = (q: typeof there.q) => ({
      x: (q[0].x + 3 * q[1].x + 3 * q[2].x + q[3].x) / 8,
      y: (q[0].y + 3 * q[1].y + 3 * q[2].y + q[3].y) / 8,
    });
    const a = mid(there.q);
    const b = mid(back.q);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(30);
    expect(Math.hypot(there.mark.x - back.mark.x, there.mark.y - back.mark.y)).toBeGreaterThan(18);
    // A flow with no partner coming back is the arc it always was.
    const oneWay = team(["build", "review", "docs"], [edge("build", "review", true), edge("build", "docs")]);
    expect(draws["build->docs"].d).toBe(orbitDraws(oneWay, g, pos)["build->docs"].d);
  });

  it("a flow across the orbit passes near the cube, and the light gets there mid-run", () => {
    const t = SHAPES.chain3;
    const g = orbitGeo(t);
    const pos = orbitAuto(t);
    const across = orbitDraws(t, g, { ...pos, docs: pos.docs });
    const q = across[edgeKey(edge("res", "ux"))].q;
    const u = nearCore(g, q);
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThan(1);
  });
});

describe("orbitHoles", () => {
  it("cuts one hole per member, on its words' side", () => {
    const t = SHAPES.loose;
    const g = orbitGeo(t);
    const holes = orbitHoles(t, g, orbitAuto(t));
    expect(holes).toHaveLength(4);
    for (const h of holes) {
      expect(h.w).toBeGreaterThan(0);
      expect(h.h).toBeGreaterThan(0);
    }
  });
});

describe("miniOrbit", () => {
  it("starts upstream on the left and downstream on the right", () => {
    const t = SHAPES.chain3;
    const { deg, flows } = miniOrbit(t, orbitAuto(t));
    expect(Math.abs(deg.res)).toBeGreaterThan(90);
    expect(Math.abs(deg.docs)).toBeLessThan(90);
    expect(flows).toHaveLength(2);
  });

  it("draws a card flow between two planets, through the middle", () => {
    const d = miniFlowPath(340, 112, 180, 0);
    expect(d).toMatch(/^M[\d.-]+,[\d.-]+ Q170\.0,56\.0 /);
  });
});
