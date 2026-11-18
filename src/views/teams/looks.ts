import type { LayoutSkin, Team } from "../../types";
import { autoPositions, returnLinePoints, starPoint, type Pos, type Positions } from "./layout";
import { orbitAuto, orbitCorners, orbitGeo, planetOf } from "./orbit";

/**
 * What the two team canvas styles (D157) do differently, in one place — the
 * design's suggestion for a skin (its teamver.js hooks): where members go by
 * default, which saved positions are theirs, where a member's mark sits, and
 * what a "show everything" fit has to include. Everything else (who can
 * connect to whom, routing, history) is the team's and does not change.
 *
 * The drawing differences live in CSS under `:root[data-tv="orbit"]` and in
 * the orbit's own pieces (orbit.ts, OrbitCore, TeamOrbit).
 */
export interface Look {
  skin: LayoutSkin;
  /** This style's saved positions in teams.json (`layout` / `orbitLayout`). */
  saved(team: Team): Record<string, Pos> | undefined;
  /** Where members go when nothing is saved; also what "Tidy up" restores. */
  auto(team: Team): Positions;
  /** A member's mark (star or planet), canvas coordinates, from its box's corner. */
  anchor(team: Team, p: Pos): Pos;
  /** Points a fit must show besides the boxes. */
  fitExtra(team: Team, pos: Positions): Pos[];
  /** How far a member is drawn left of its box (the star and its halo) — what
   *  a fit must keep clear of the zoom buttons along with the box (F26). */
  reachLeft: number;
  /**
   * The smallest zoom at which a name still reads at 12px (14px names on the
   * star map, 15px on the orbit) — below it, moving the team beside an open
   * inspector would make it unreadable, so it stays where it is.
   */
  readable: number;
}

/** The star and its halo reach about this far left of a node (canvas units). */
const STAR_REACH = 18;

export const STAR_LOOK: Look = {
  skin: "star",
  saved: (team) => team.layout,
  auto: autoPositions,
  anchor: (_team, p) => starPoint(p),
  // The star's halo reaches about 20px left of the node.
  fitExtra: (team, pos) => [
    ...team.members.flatMap((m) => {
      const p = pos[m.workspaceId];
      return p === undefined ? [] : [{ x: p.x - STAR_REACH, y: p.y + 40 }];
    }),
    // A flow back upstream (D161) swings outside every box.
    ...returnLinePoints(team, pos),
  ],
  reachLeft: STAR_REACH,
  readable: 0.86,
};

export const ORBIT_LOOK: Look = {
  skin: "orbit",
  saved: (team) => team.orbitLayout,
  auto: orbitAuto,
  anchor: (team, p) => planetOf(orbitGeo(team), p),
  // The whole ring, not just the members on it.
  fitExtra: (team) => orbitCorners(orbitGeo(team)),
  // The planet sits inside the node's box, on the side away from the cube.
  reachLeft: 0,
  readable: 0.8,
};

export const lookOf = (skin: LayoutSkin): Look => (skin === "orbit" ? ORBIT_LOOK : STAR_LOOK);

/** Saved position first, then the auto slot — the canvas's own precedence. */
export function positionsFor(look: Look, team: Team): Positions {
  const auto = look.auto(team);
  const saved = look.saved(team);
  const out: Positions = {};
  for (const m of team.members) out[m.workspaceId] = saved?.[m.workspaceId] ?? auto[m.workspaceId];
  return out;
}
