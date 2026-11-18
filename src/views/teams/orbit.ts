import type { Team, TeamEdge } from "../../types";
import { NODE_H, NODE_W, edgeKey, layersOf, type Pos, type Positions } from "./layout";

/**
 * The orbit canvas (D157, spec 50 §12–§22, the design's teamorbit.js): a wire
 * cube in the middle, members on one elliptical orbit round it, flows as arcs
 * that bend towards the cube. The cube is only a way of drawing — the data is
 * still member-to-member flows, so `canConnect`, routing and the history are
 * the star map's, unchanged.
 *
 * Pure geometry, like layout.ts: the node is the same 196 × 80 box, and the
 * planet sits inside it on the side facing the cube, with the words on the
 * outside — so no line ever crosses a name.
 */

export type Side = "l" | "r" | "t" | "b";

/** The orbit: its centre (where the cube is) and its two radii. */
export interface OrbitGeo {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface OrbitPlan extends OrbitGeo {
  /** Auto slot per member (the node's top-left corner). */
  pos: Positions;
  side: Record<string, Side>;
}

/** Planet's distance from the box edge; left/right stack spacing; top/bottom row spacing; minimum gap between boxes. */
const PR = 12;
const SV = 96;
const SH = 214;
const GAP = 12;
/** The cube's place in canvas coordinates — the fit centres it, so the numbers themselves do not matter. */
const CX = 600;
const CY = 400;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where the planet sits inside the box for each side the words are on. */
export function planetOffset(side: Side): Pos {
  if (side === "l") return { x: NODE_W - PR, y: NODE_H / 2 };
  if (side === "r") return { x: PR, y: NODE_H / 2 };
  if (side === "t") return { x: NODE_W / 2, y: NODE_H - PR };
  return { x: NODE_W / 2, y: PR };
}

/**
 * Which side of its planet a box's words go: by the direction from the cube to
 * the box's centre, measured in the orbit's own proportions — a quarter turn
 * each. Asked again on every drag, so a planet dragged across the cube flips
 * its words to the outside.
 */
export function sideOf(g: OrbitGeo, p: Pos): Side {
  const vx = (p.x + NODE_W / 2 - g.cx) / g.rx;
  const vy = (g.cy - p.y - NODE_H / 2) / g.ry;
  const a = (Math.atan2(vy, vx) * 180) / Math.PI;
  if (Math.abs(a) <= 45) return "r";
  if (Math.abs(a) >= 135) return "l";
  return a > 0 ? "t" : "b";
}

/** The planet's centre in canvas coordinates, from its box's corner. */
export function planetOf(g: OrbitGeo, p: Pos): Pos {
  const d = planetOffset(sideOf(g, p));
  return { x: p.x + d.x, y: p.y + d.y };
}

/** Every ordering of `a`, or just `a` past six (720 orderings is already plenty). */
function perms<T>(a: T[]): T[][] {
  if (a.length > 6) return [a];
  if (a.length <= 1) return [a.slice()];
  const out: T[][] = [];
  a.forEach((x, i) => {
    for (const p of perms([...a.slice(0, i), ...a.slice(i + 1)])) out.push([x, ...p]);
  });
  return out;
}

interface Arrangement {
  left: string[];
  right: string[];
  top: string[];
  bot: string[];
}

const memo = new Map<string, OrbitPlan>();

/**
 * The orbit and every member's slot on it (the design's T-0079). Remembered
 * per team shape: every render asks for it several times over.
 */
export function orbitPlan(team: Team): OrbitPlan {
  const key = `${team.id}|${team.members.map((m) => m.workspaceId).join(",")}|${team.edges.map((e) => edgeKey(e)).join(",")}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const plan = makePlan(team);
  if (memo.size > 64) memo.clear();
  memo.set(key, plan);
  return plan;
}

/**
 * The most upstream layer stacks on the left, the most downstream on the
 * right, the layers between split over a top and a bottom row (left to right
 * by layer); members with no flow go in the bottom row. Within that, the
 * arrangement with the fewest crossing lines wins, then the most even top and
 * bottom. The orbit then grows until no two boxes touch and every box's words
 * fall on the side its position says they should — the same rule a drag uses.
 */
function makePlan(team: Team): OrbitPlan {
  const ids = team.members.map((m) => m.workspaceId);
  const layer = layersOf(team);
  const nL = layer.size > 0 ? Math.max(...layer.values()) + 1 : 0;
  const loose = ids.filter((id) => !layer.has(id));
  const by: string[][] = [];
  for (let L = 0; L < nL; L++) by.push(ids.filter((id) => layer.get(id) === L));
  const ord = new Map(ids.map((id, i) => [id, i]));

  // Round the orbit clockwise from bottom left: left up, top along, right
  // down, bottom back. Two lines cross when their ends interleave on it.
  const score = (c: Arrangement) => {
    const ring = [...c.left.slice().reverse(), ...c.top, ...c.right, ...c.bot.slice().reverse()];
    const at = new Map(ring.map((id, i) => [id, i]));
    const ends = team.edges.map((e) => [at.get(e.from) ?? -1, at.get(e.to) ?? -1].sort((x, y) => x - y));
    let cross = 0;
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const [a, b] = ends[i];
        const [p, q] = ends[j];
        if (a === p || a === q || b === p || b === q) continue;
        if ((a < p && p < b) !== (a < q && q < b)) cross++;
      }
    }
    const nt = c.top.length;
    const nb = c.bot.length + loose.length;
    let inv = 0;
    for (const g of [c.left, c.right, c.top, c.bot]) {
      g.forEach((x, i) => {
        for (const y of g.slice(i + 1)) if ((ord.get(x) ?? 0) > (ord.get(y) ?? 0)) inv++;
      });
    }
    return cross * 1000 + Math.abs(nt - nb) * 20 + (nb > nt ? 3 : 0) + inv * 0.01;
  };

  // A holder, not a `let`: it is written inside `walk`, where TypeScript's
  // narrowing cannot see the assignment.
  const found: { best: { s: number; c: Arrangement } | null } = { best: null };
  if (nL >= 2) {
    const mids = by.slice(1, -1);
    const midOpts = mids.map((g) => {
      const o: { top: string[]; bot: string[] }[] = [];
      for (const p of perms(g)) {
        const n = p.length;
        const all = n <= 5 ? 1 << n : 1;
        for (let m = 0; m < all; m++) {
          o.push({
            top: p.filter((_, i) => (all > 1 ? (m & (1 << i)) !== 0 : i % 2 === 0)),
            bot: p.filter((_, i) => (all > 1 ? (m & (1 << i)) === 0 : i % 2 === 1)),
          });
        }
      }
      return o;
    });
    const lefts = perms(by[0]);
    const rights = perms(by[nL - 1]);
    let count = lefts.length * rights.length;
    for (const o of midOpts) count *= o.length;
    const cap = count > 60000;
    const walk = (k: number, top: string[], bot: string[], left: string[], right: string[]) => {
      if (k === midOpts.length) {
        const c = { left, right, top, bot };
        const s = score(c);
        if (found.best === null || s < found.best.s) found.best = { s, c };
        return;
      }
      for (const o of cap ? midOpts[k].slice(0, 1) : midOpts[k]) walk(k + 1, [...top, ...o.top], [...bot, ...o.bot], left, right);
    };
    for (const l of cap ? lefts.slice(0, 1) : lefts) {
      for (const r of cap ? rights.slice(0, 1) : rights) walk(0, [], [], l, r);
    }
  }
  const c: Arrangement = found.best?.c ?? { left: [], right: [], top: [], bot: [] };
  let top = c.top;
  let bot = [...c.bot, ...loose];
  let left = c.left;
  let right = c.right;
  // No flows at all: round the orbit in order — left, top, right, bottom.
  if (nL === 0) {
    top = [];
    bot = [];
    left = [];
    right = [];
    ids.forEach((id, i) => [left, top, right, bot][i % 4].push(id));
  }

  // Where a middle layer wants to sit across the orbit: by its layer, left to right.
  const fx = (id: string) => {
    const L = layer.get(id);
    return L !== undefined && nL > 1 ? L / (nL - 1) : 0.5;
  };
  const n0 = Math.max(left.length, right.length);
  const nRow = Math.max(top.length, bot.length);
  let ry = Math.max(150, ((n0 - 1) * SV) / 2 / 0.75 + 10);
  let rx = Math.max(260, ry * 1.3, ((nRow - 1) * SH) / 2 / 0.66 + 40);
  let pos: Positions = {};
  let side: Record<string, Side> = {};
  for (let tries = 0; tries < 30; tries++) {
    pos = {};
    side = {};
    const put = (id: string, P: Pos, s: Side) => {
      const d = planetOffset(s);
      pos[id] = { x: Math.round(P.x - d.x), y: Math.round(P.y - d.y) };
      side[id] = s;
    };
    const stack = (list: string[], dir: number) =>
      list.forEach((id, i) => {
        const y = (i - (list.length - 1) / 2) * SV;
        const x = rx * Math.sqrt(Math.max(0, 1 - (y / ry) ** 2));
        put(id, { x: CX + dir * x, y: CY + y }, dir < 0 ? "l" : "r");
      });
    // A row follows the layers; anything closer than a slot is pushed on
    // (order kept), then the whole row re-centred on where it wanted to be.
    const row = (list: string[], dir: number) => {
      const want = list.map((id) => (2 * fx(id) - 1) * rx * 0.5);
      const xs = want.slice();
      for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i], xs[i - 1] + SH);
      const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
      const shift = xs.length > 0 ? mean(want) - mean(xs) : 0;
      list.forEach((id, i) => {
        const x = clamp(xs[i] + shift, -rx * 0.7, rx * 0.7);
        const y = ry * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2));
        put(id, { x: CX + x, y: CY + dir * y }, dir < 0 ? "t" : "b");
      });
    };
    stack(left, -1);
    stack(right, 1);
    row(top, -1);
    row(bot, 1);
    const g = { cx: CX, cy: CY, rx, ry };
    const all = Object.keys(pos);
    let bad = false;
    for (let i = 0; i < all.length && !bad; i++) {
      if (sideOf(g, pos[all[i]]) !== side[all[i]]) bad = true;
      for (let j = i + 1; j < all.length && !bad; j++) {
        const a = pos[all[i]];
        const b = pos[all[j]];
        if (a.x < b.x + NODE_W + GAP && b.x < a.x + NODE_W + GAP && a.y < b.y + NODE_H + GAP && b.y < a.y + NODE_H + GAP) bad = true;
      }
    }
    if (!bad) break;
    rx *= 1.06;
    ry *= 1.06;
  }
  return { cx: CX, cy: CY, rx: Math.round(rx), ry: Math.round(ry), pos, side };
}

export const orbitGeo = (team: Team): OrbitGeo => {
  const p = orbitPlan(team);
  return { cx: p.cx, cy: p.cy, rx: p.rx, ry: p.ry };
};

export function orbitAuto(team: Team): Positions {
  const p = orbitPlan(team).pos;
  const out: Positions = {};
  for (const m of team.members) {
    const at = p[m.workspaceId];
    if (at !== undefined) out[m.workspaceId] = { ...at };
  }
  return out;
}

// ── Arcs ────────────────────────────────────────────────────────────────────

/** A cubic Bézier's four points. */
export type Bez = [Pos, Pos, Pos, Pos];

export function bezAt(P: Bez, u: number): Pos {
  const v = 1 - u;
  return {
    x: v * v * v * P[0].x + 3 * v * v * u * P[1].x + 3 * v * u * u * P[2].x + u * u * u * P[3].x,
    y: v * v * v * P[0].y + 3 * v * v * u * P[1].y + 3 * v * u * u * P[2].y + u * u * u * P[3].y,
  };
}

const mix = (a: Pos, b: Pos, u: number): Pos => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
const rev = (P: Bez): Bez => [P[3], P[2], P[1], P[0]];

/** The u0…u1 piece of a curve, itself a cubic Bézier (de Casteljau). */
function cut(P: Bez, u0: number, u1: number): Bez {
  const split = (Q: Bez, u: number): [Bez, Bez] => {
    const ab = mix(Q[0], Q[1], u);
    const bc = mix(Q[1], Q[2], u);
    const cd = mix(Q[2], Q[3], u);
    const abc = mix(ab, bc, u);
    const bcd = mix(bc, cd, u);
    const m = mix(abc, bcd, u);
    return [
      [Q[0], ab, abc, m],
      [m, bcd, cd, Q[3]],
    ];
  };
  const right = split(P, u0)[1];
  return split(right, (u1 - u0) / (1 - u0))[0];
}

/** The parameter at which the curve is exactly `r` from `A`, searching from the `A` end. */
function reach(P: Bez, A: Pos, r: number, from: number, to: number): number {
  let lo = from;
  let hi = to;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    const q = bezAt(P, m);
    if (Math.hypot(q.x - A.x, q.y - A.y) < r) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** Leave the sender's planet this far out, stop this far before the receiver's (the arrowhead fills the gap). */
const R0 = 16;
const R1 = 18;
const ARROW = 9;
/** How far each of two opposite flows between one pair of planets bends off the shared arc. */
const PAIR_BEND = 30;

/**
 * One flow's arc. The further apart the two planets, the more it bends towards
 * the cube — two across from each other run through it. It sets off between
 * the cube and the receiver rather than straight at the cube, so several flows
 * out of one planet part at once; the more a planet sends (or receives), the
 * further its ends lean towards the other planet, so arrowheads do not bunch.
 *
 * Two planets that send to each other (a loop, D161) would get one arc drawn
 * twice — the recipe is symmetric — so each of the pair bends `PAIR_BEND`
 * towards its own right-hand side and the two run as a pair of lanes.
 */
export function orbitCurve(team: Team, g: OrbitGeo, e: TeamEdge, pos: Positions): Bez | null {
  const a = pos[e.from];
  const b = pos[e.to];
  if (a === undefined || b === undefined) return null;
  const C = { x: g.cx, y: g.cy };
  const ps = planetOf(g, a);
  const pt = planetOf(g, b);
  const k = 0.1 + 0.42 * clamp(Math.hypot(pt.x - ps.x, pt.y - ps.y) / (g.rx + g.ry), 0, 1);
  const outs = team.edges.filter((x) => x.from === e.from).length;
  const ins = team.edges.filter((x) => x.to === e.to).length;
  const ws = Math.min(0.7, 0.3 + 0.1 * outs);
  const wt = Math.min(0.7, 0.3 + 0.1 * ins);
  const P: Bez = [ps, mix(ps, mix(C, pt, ws), k), mix(pt, mix(C, ps, wt), k), pt];
  if (team.edges.some((x) => x.from === e.to && x.to === e.from)) {
    // Right of the direction of travel, in screen coordinates (y down).
    const len = Math.hypot(pt.x - ps.x, pt.y - ps.y) || 1;
    const off = { x: (-(pt.y - ps.y) / len) * PAIR_BEND, y: ((pt.x - ps.x) / len) * PAIR_BEND };
    P[1] = { x: P[1].x + off.x, y: P[1].y + off.y };
    P[2] = { x: P[2].x + off.x, y: P[2].y + off.y };
  }
  const u0 = reach(P, ps, R0, 0, 0.5);
  const u1 = 1 - reach(rev(P), pt, R1, 0, 0.5);
  return cut(P, u0, u1);
}

const f1 = (n: number) => +n.toFixed(1);
export const bezPath = (Q: Bez) =>
  `M${f1(Q[0].x)},${f1(Q[0].y)} C${f1(Q[1].x)},${f1(Q[1].y)} ${f1(Q[2].x)},${f1(Q[2].y)} ${f1(Q[3].x)},${f1(Q[3].y)}`;

const BOLT_TRY = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74];

/**
 * Where each flow's bolt (and its "remove" button) sits: one flow at a time,
 * the point of its middle half furthest from every planet, the cube and the
 * bolts already placed. Automatic flows go first — theirs always show.
 */
export function orbitMarks(team: Team, g: OrbitGeo, curves: Record<string, Bez>, pos: Positions): Record<string, Pos> {
  const keep: (Pos & { w: number })[] = [
    { x: g.cx, y: g.cy, w: 0.6 },
    ...team.members.filter((m) => pos[m.workspaceId] !== undefined).map((m) => ({ ...planetOf(g, pos[m.workspaceId]), w: 1 })),
  ];
  const out: Record<string, Pos> = {};
  const order = [...team.edges.filter((e) => e.autoRoute), ...team.edges.filter((e) => !e.autoRoute)];
  for (const e of order) {
    const Q = curves[edgeKey(e)];
    if (Q === undefined) continue;
    let best: { d: number; p: Pos } | null = null;
    for (const u of BOLT_TRY) {
      const p = bezAt(Q, u);
      const d = Math.min(...keep.map((q) => Math.hypot(p.x - q.x, p.y - q.y) * q.w));
      if (best === null || d > best.d + 4) best = { d, p };
    }
    if (best === null) continue;
    out[edgeKey(e)] = best.p;
    if (e.autoRoute) keep.push({ ...best.p, w: 1 });
  }
  return out;
}

/** One flow as drawn: the arc, where its bolt sits, and its arrowhead. */
export interface OrbitDraw {
  q: Bez;
  d: string;
  mark: Pos;
  /** The arrowhead's SVG transform: its tip on the arc's end. */
  arrow: string;
}

/** The arrowhead: a notched triangle drawn pointing +x, tip at the origin. */
export const ARROW_PATH = `M${-ARROW},-4.6 L0,0 L${-ARROW},4.6 L${-ARROW + 2.2},0 Z`;

/**
 * The arrowhead's direction comes from the point 9px back along the arc, not
 * the end tangent — on a tight bend the tangent points off the line (the
 * design's pitfall-arrow-along-curve).
 */
function arrowAt(Q: Bez): string {
  const E = Q[3];
  const R = rev(Q);
  const B = bezAt(R, reach(R, E, ARROW, 0, 1));
  const ang = (Math.atan2(E.y - B.y, E.x - B.x) * 180) / Math.PI;
  return `translate(${E.x.toFixed(1)} ${E.y.toFixed(1)}) rotate(${ang.toFixed(1)})`;
}

export function orbitDraws(team: Team, g: OrbitGeo, pos: Positions): Record<string, OrbitDraw> {
  const curves: Record<string, Bez> = {};
  for (const e of team.edges) {
    const Q = orbitCurve(team, g, e, pos);
    if (Q !== null) curves[edgeKey(e)] = Q;
  }
  const marks = orbitMarks(team, g, curves, pos);
  const out: Record<string, OrbitDraw> = {};
  for (const [k, Q] of Object.entries(curves)) {
    out[k] = { q: Q, d: bezPath(Q), mark: marks[k] ?? bezAt(Q, 0.5), arrow: arrowAt(Q) };
  }
  return out;
}

/**
 * When a light running along `Q` passes closest to the cube, as a fraction of
 * the run's time. The run eases on cubic-bezier(.45,0,.3,1), so the closest
 * point's share of the arc length is turned back into a share of time.
 */
export function nearCore(g: OrbitGeo, Q: Bez): number {
  const pts: Pos[] = [];
  for (let i = 0; i <= 80; i++) pts.push(bezAt(Q, i / 80));
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = acc[acc.length - 1] || 1;
  let best = { at: 0, r: Infinity };
  pts.forEach((q, i) => {
    const r = Math.hypot(q.x - g.cx, q.y - g.cy);
    if (r < best.r) best = { at: acc[i] / total, r };
  });
  const bz = (a: number, b: number, s: number) => 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;
  let s = 0;
  while (s < 1 && bz(0, 1, s) < best.at) s += 0.005;
  return bz(0.45, 0.3, Math.min(1, s));
}

// ── The orbit's breaks, the canvas extent ───────────────────────────────────

/**
 * Where the orbit line is cut so it never runs through words: per member, the
 * part of its box that holds the text (relative to the cube, for the ring's
 * mask). Moves with a drag.
 */
export function orbitHoles(team: Team, g: OrbitGeo, pos: Positions): { x: number; y: number; w: number; h: number }[] {
  const k = 2 * PR + 4;
  return team.members
    .filter((m) => pos[m.workspaceId] !== undefined)
    .map((m) => {
      const p = pos[m.workspaceId];
      const s = sideOf(g, p);
      const r =
        s === "l"
          ? [0, 6, NODE_W - k, NODE_H - 12]
          : s === "r"
            ? [k, 6, NODE_W - k, NODE_H - 12]
            : s === "t"
              ? [0, 0, NODE_W, NODE_H - k]
              : [0, k, NODE_W, NODE_H - k];
      return { x: p.x + r[0] - g.cx, y: p.y + r[1] - g.cy, w: r[2], h: r[3] };
    });
}

/** The orbit's own corners: a fit has to show the whole ring, not only the members on it. */
export const orbitCorners = (g: OrbitGeo): Pos[] => [
  { x: g.cx - g.rx, y: g.cy - g.ry },
  { x: g.cx + g.rx, y: g.cy + g.ry },
];

/** The wire cube at the logo's angle is a pointy-top hexagon on screen; its outline, for the flare. */
export function hexPoints(e: number): string {
  const r = e * Math.sqrt(2 / 3);
  return [-90, -30, 30, 90, 150, 210]
    .map((a) => `${(r * Math.cos((a * Math.PI) / 180)).toFixed(2)},${(r * Math.sin((a * Math.PI) / 180)).toFixed(2)}`)
    .join(" ");
}

// ── The card's little orbit (C61, C134) ────────────────────────────────────

/** The card's orbit: 94px radius, flattened to cos 66° so it reads as tilted. */
export const MINI_R = 94;
export const MINI_K = 0.4067;

/**
 * Each member's starting angle on the card (degrees, in the flattened plane)
 * — where it sits on the canvas, so upstream starts on the left — and each
 * flow as a pair of those angles.
 */
export function miniOrbit(team: Team, pos: Positions): { deg: Record<string, number>; flows: [number, number][] } {
  const g = orbitGeo(team);
  const deg: Record<string, number> = {};
  for (const m of team.members) {
    const p = pos[m.workspaceId];
    if (p === undefined) continue;
    const q = planetOf(g, p);
    deg[m.workspaceId] = Math.round((Math.atan2((q.y - g.cy) / g.ry, (q.x - g.cx) / g.rx) * 180) / Math.PI);
  }
  const flows = team.edges
    .filter((e) => deg[e.from] !== undefined && deg[e.to] !== undefined)
    .map((e) => [deg[e.from], deg[e.to]] as [number, number]);
  return { deg, flows };
}

/**
 * The card's flow light path (card pixels): planet at angle a1 to planet at
 * a2, bending through a point beside the cube (two across from each other run
 * through it), each end 8px off its planet.
 */
export function miniFlowPath(w: number, h: number, a1: number, a2: number): string {
  const rad = Math.PI / 180;
  const P = (a: number) => ({ x: w / 2 + MINI_R * Math.cos(a * rad), y: h / 2 + MINI_R * MINI_K * Math.sin(a * rad) });
  const A = P(a1);
  const B = P(a2);
  const C = { x: w / 2 + (A.x + B.x - w) * 0.06, y: h / 2 + (A.y + B.y - h) * 0.06 };
  const off = (p: Pos, r: number) => {
    const d = Math.hypot(C.x - p.x, C.y - p.y) || 1;
    return { x: p.x + ((C.x - p.x) / d) * r, y: p.y + ((C.y - p.y) / d) * r };
  };
  const s = off(A, 8);
  const e = off(B, 8);
  return `M${s.x.toFixed(1)},${s.y.toFixed(1)} Q${C.x.toFixed(1)},${C.y.toFixed(1)} ${e.x.toFixed(1)},${e.y.toFixed(1)}`;
}
