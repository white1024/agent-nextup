import type { Team, TeamEdge } from "../../types";

/**
 * Canvas geometry (D153 step 7, spec 50 §4). The node is a fixed box so the
 * edge endpoints can be computed rather than measured: 196 × 80, one layer per
 * 244px column, one row per 112px. The design tightened these from D53's
 * 320 / 150 so a four-layer team still shows every name at 12px or more when
 * the whole team is fitted into a 1440-wide canvas.
 *
 * ⚠️ The same two numbers live in styles.css (`.canvas-node` width / height):
 * change them together, or the lines stop meeting the stars.
 */
export const NODE_W = 196;
export const NODE_H = 80;
/** Auto-layout grid step, in canvas pixels. */
export const COL = 244;
export const ROW = 112;
/** How far below the handles a flow back upstream bends (see `edgeGeo`). */
export const RETURN_DROP = 88;

export interface Pos {
  x: number;
  y: number;
}

export type Positions = Record<string, Pos>;

/** Stable key of one edge — also the xyflow edge id. */
export const edgeKey = (e: { from: string; to: string }) => `${e.from}->${e.to}`;

/**
 * The flows that run back upstream (D161): taken in the order they were
 * drawn, an edge whose receiver can already reach its sender closes a loop,
 * and that one is the way back. Every team drawn before D161 has none — the
 * graph refused them — and in a review loop it is exactly the edge the user
 * drew last, the findings going home.
 *
 * Dropping these leaves an acyclic graph, which is what the layering needs:
 * on a loop "the longest path upstream" never stops growing.
 */
export function returnEdges(edges: TeamEdge[]): Set<string> {
  const kept: TeamEdge[] = [];
  const back = new Set<string>();
  for (const e of edges) {
    if (reaches(e.to, e.from, kept)) back.add(edgeKey(e));
    else kept.push(e);
  }
  return back;
}

/** Can `goal` be reached from `start` along `edges`? */
function reaches(start: string, goal: string, edges: TeamEdge[]): boolean {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === goal) return true;
    for (const e of edges) {
      if (e.from === cur && !seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return false;
}

/**
 * Longest-path layer per wired member (upstream = 0). Unwired members are
 * absent. Shared by the auto-layout and the edge-span calculation so both
 * agree on what "skips a layer" means. Return flows (`returnEdges`) are left
 * out of the walk, so a flow back upstream always spans a negative number of
 * layers — that sign is how a line knows to run back underneath.
 */
export function layersOf(team: Team): Map<string, number> {
  const wired = new Set<string>();
  for (const edge of team.edges) {
    wired.add(edge.from);
    wired.add(edge.to);
  }
  const back = returnEdges(team.edges);
  const forward = team.edges.filter((e) => !back.has(edgeKey(e)));
  const layer = new Map<string, number>();
  for (const id of wired) layer.set(id, 0);
  const passes = Math.max(1, wired.size);
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (const edge of forward) {
      const from = layer.get(edge.from);
      const to = layer.get(edge.to);
      if (from === undefined || to === undefined) continue;
      if (from + 1 > to) {
        layer.set(edge.to, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}

/**
 * May a line from `from` to `to` be drawn? Since D176 a line connects both
 * ways, so it can be drawn while either direction is missing — over a one-way
 * line it adds the other way. Rejects self-lines and a pair already connected
 * both ways. Shared by the canvas drag path (`isValidConnection`, which
 * pre-blocks an invalid drop) and the inspector's keyboard-reachable form
 * (which only offers valid targets) so the two cannot drift — core stays the
 * enforcer either way.
 */
export function canConnect(from: string, to: string, edges: TeamEdge[]): boolean {
  if (from === "" || to === "" || from === to) return false;
  const has = (a: string, b: string) => edges.some((e) => e.from === a && e.to === b);
  return !(has(from, to) && has(to, from));
}

/**
 * One line on the canvas (D176): a pair of members drawn once. `ab` is the
 * direction the line is drawn along; `ba` is the way back when the pair sends
 * both ways, null on a one-way line.
 */
export interface Line {
  ab: TeamEdge;
  ba: TeamEdge | null;
}

/**
 * The team's edges as lines: two members that send to each other are one
 * line, drawn along the direction that is not the flow back upstream (so it
 * keeps the forward geometry it always had). Lines come in the order their
 * first edge was drawn.
 */
export function linesOf(edges: TeamEdge[]): Line[] {
  const back = returnEdges(edges);
  const done = new Set<string>();
  const out: Line[] = [];
  for (const e of edges) {
    if (done.has(edgeKey(e))) continue;
    const r = edges.find((x) => x.from === e.to && x.to === e.from) ?? null;
    const flip = r !== null && back.has(edgeKey(e)) && !back.has(edgeKey(r));
    const line: Line = flip ? { ab: r, ba: e } : { ab: e, ba: r };
    done.add(edgeKey(line.ab));
    if (line.ba) done.add(edgeKey(line.ba));
    out.push(line);
  }
  return out;
}

/**
 * The team as the canvas draws it: one edge per line. A two-way line counts
 * as automatic when either direction is, so its bolt is placed with the other
 * automatic ones.
 */
export function drawnTeam(team: Team): Team {
  return {
    ...team,
    edges: linesOf(team.edges).map(({ ab, ba }) =>
      ba === null ? ab : { ...ab, autoRoute: ab.autoRoute || ba.autoRoute },
    ),
  };
}

/** A star-map curve run the other way, for a light travelling back along a two-way line. */
export function reversedPath(n: EdgeGeo["n"]): string {
  return `M${n[6]},${n[7]} C${n[4]},${n[5]} ${n[2]},${n[3]} ${n[0]},${n[1]}`;
}

/**
 * Deterministic auto slots (D53 §4): wired members on a longest-path layered
 * grid (upstream left), unwired members in rows beneath. Pure — same team
 * shape always yields the same slots, so unsaved nodes never jump between
 * renders. Also the "Tidy up" source of truth.
 */
export function autoPositions(team: Team): Positions {
  const layer = layersOf(team);

  const positions: Positions = {};
  const rowsPerLayer = new Map<number, number>();
  for (const member of team.members) {
    const depth = layer.get(member.workspaceId);
    if (depth === undefined) continue;
    const row = rowsPerLayer.get(depth) ?? 0;
    rowsPerLayer.set(depth, row + 1);
    positions[member.workspaceId] = { x: 60 + depth * COL, y: 60 + row * ROW };
  }

  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    // Step bypassed nodes off skip-edge lines. A chain a→b→c that also has
    // a→c otherwise lands all three on one row, and the a→c edge disappears
    // behind b — exactly the "after Tidy up the lines overlap and you can't
    // tell the flows apart" report (the D53 walkthrough).
    for (const edge of team.edges) {
      const fromLayer = layer.get(edge.from);
      const toLayer = layer.get(edge.to);
      const from = positions[edge.from];
      const to = positions[edge.to];
      if (fromLayer === undefined || toLayer === undefined) continue;
      if (from === undefined || to === undefined || toLayer - fromLayer < 2) continue;
      for (const member of team.members) {
        const depth = layer.get(member.workspaceId);
        const at = positions[member.workspaceId];
        if (depth === undefined || at === undefined) continue;
        if (depth <= fromLayer || depth >= toLayer) continue;
        const ratio = (at.x - from.x) / (to.x - from.x);
        const lineY = from.y + (to.y - from.y) * ratio;
        if (Math.abs(at.y - lineY) < ROW * 0.75) {
          at.y = lineY + ROW;
          moved = true;
        }
      }
    }
    // A node stepped down can land on the next one in its own column (the
    // design's T-0063): walk each column top to bottom and push anything
    // closer than a row further down.
    const columns = new Map<number, string[]>();
    for (const member of team.members) {
      const depth = layer.get(member.workspaceId);
      if (depth === undefined || positions[member.workspaceId] === undefined) continue;
      const col = columns.get(depth) ?? [];
      col.push(member.workspaceId);
      columns.set(depth, col);
    }
    for (const ids of columns.values()) {
      ids.sort((a, b) => positions[a].y - positions[b].y);
      for (let k = 1; k < ids.length; k++) {
        const need = positions[ids[k - 1]].y + ROW;
        if (positions[ids[k]].y < need - 0.5) {
          positions[ids[k]].y = need;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  let unwiredIndex = 0;
  let lowest = 60;
  for (const at of Object.values(positions)) lowest = Math.max(lowest, at.y);
  const baseY = Object.keys(positions).length > 0 ? lowest + ROW : 60;
  for (const member of team.members) {
    if (positions[member.workspaceId] !== undefined) continue;
    positions[member.workspaceId] = {
      x: 60 + (unwiredIndex % 4) * COL,
      y: baseY + Math.floor(unwiredIndex / 4) * ROW,
    };
    unwiredIndex++;
  }
  return positions;
}

/** Saved position first, then the auto slot — the canvas's own precedence. */
export function positionsOf(team: Team, saved: Record<string, Pos> | undefined): Positions {
  const auto = autoPositions(team);
  const out: Positions = {};
  for (const m of team.members) out[m.workspaceId] = saved?.[m.workspaceId] ?? auto[m.workspaceId];
  return out;
}

// ── Edges ───────────────────────────────────────────────────────────────────

/** One flow line: a cubic Bézier from the sender's right edge to the
 *  receiver's star (its left edge), both at mid-height. */
export interface EdgeGeo {
  /** sx sy, c1x c1y, c2x c2y, tx ty — the curve's eight numbers. */
  n: [number, number, number, number, number, number, number, number];
  d: string;
  /** The curve at t = 0.5. */
  mid: Pos;
}

/**
 * The curve between two endpoints. A line that skips a layer runs straight
 * through whatever sits between its ends, and nodes paint over lines — so
 * those bow over the top instead (`autoPositions` also steps bypassed nodes
 * off the line; this covers hand-dragged layouts). Everything else is the
 * same horizontal S-curve xyflow draws by default, so a dragged connection
 * and the line it becomes have one shape.
 *
 * A flow back upstream (D161, `span < 0`) leaves its sender's right edge and
 * enters its receiver's star like any other, so drawn the default way it would
 * run straight back through both boxes. It swings out right, runs back
 * underneath — skip lines bow over the top, so the two never share a lane —
 * and comes up into the star from the left. 88px down puts the lowest point
 * 66px under the handle: clear of its own row's boxes (40px), above the next
 * row's (72px). The reach out right grows with the run so a long way back
 * does not clip the sender's lower corner.
 *
 * Both bends hang off the LOWER of the two ends. Hung off each end's own
 * height, a line back to a node a row higher is pulled up as it goes and
 * runs through the sender's own words (the first AI walkthrough of D161 saw
 * exactly that).
 */
export function edgeGeo(s: Pos, t: Pos, span: number): EdgeGeo {
  let c1: Pos;
  let c2: Pos;
  if (span < 0) {
    const reach = clamp(0.4 * (s.x - t.x), 160, 280);
    const low = Math.max(s.y, t.y) + RETURN_DROP;
    c1 = { x: s.x + reach, y: low };
    c2 = { x: t.x - reach, y: low };
  } else if (span >= 2 && Math.abs(t.y - s.y) < ROW * 0.75) {
    const dx = t.x - s.x;
    const lift = Math.min(110, Math.max(46, Math.abs(dx) * 0.22));
    c1 = { x: s.x + dx * 0.35, y: s.y - lift };
    c2 = { x: t.x - dx * 0.35, y: t.y - lift };
  } else {
    const d = t.x - s.x;
    const off = d >= 0 ? 0.5 * d : 0.25 * 25 * Math.sqrt(-d);
    c1 = { x: s.x + off, y: s.y };
    c2 = { x: t.x - off, y: t.y };
  }
  const n: EdgeGeo["n"] = [s.x, s.y, c1.x, c1.y, c2.x, c2.y, t.x, t.y];
  return {
    n,
    d: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${t.x},${t.y}`,
    mid: bezierAt(n, 0.5),
  };
}

/** A point on the curve and the curve's direction there (radians). */
export function bezierAt(n: EdgeGeo["n"], u: number): Pos & { a: number } {
  const v = 1 - u;
  const x = v * v * v * n[0] + 3 * v * v * u * n[2] + 3 * v * u * u * n[4] + u * u * u * n[6];
  const y = v * v * v * n[1] + 3 * v * v * u * n[3] + 3 * v * u * u * n[5] + u * u * u * n[7];
  const dx = 3 * v * v * (n[2] - n[0]) + 6 * v * u * (n[4] - n[2]) + 3 * u * u * (n[6] - n[4]);
  const dy = 3 * v * v * (n[3] - n[1]) + 6 * v * u * (n[5] - n[3]) + 3 * u * u * (n[7] - n[5]);
  return { x, y, a: Math.atan2(dy, dx) };
}

/** Where a node's lines attach, given its top-left corner. */
export const sourcePoint = (p: Pos): Pos => ({ x: p.x + NODE_W, y: p.y + NODE_H / 2 });
export const starPoint = (p: Pos): Pos => ({ x: p.x, y: p.y + NODE_H / 2 });

/** Every edge's curve, keyed by `edgeKey`, from node positions. */
export function edgeGeos(team: Team, pos: Positions): Record<string, EdgeGeo> {
  const layer = layersOf(team);
  const out: Record<string, EdgeGeo> = {};
  for (const e of team.edges) {
    const a = pos[e.from];
    const b = pos[e.to];
    if (a === undefined || b === undefined) continue;
    const span = (layer.get(e.to) ?? 1) - (layer.get(e.from) ?? 0);
    out[edgeKey(e)] = edgeGeo(sourcePoint(a), starPoint(b), span);
  }
  return out;
}

/**
 * Points along every flow back upstream (D161). Unlike every other line, it
 * leaves the boxes' extent — out right of its sender, under its row — so a
 * fit that only counts boxes cuts it off at the canvas edge (the first AI
 * walkthrough of D161 saw that). Empty for a team without a loop, so such a
 * team fits exactly as it always did.
 */
export function returnLinePoints(team: Team, pos: Positions): Pos[] {
  const back = returnEdges(team.edges);
  if (back.size === 0) return [];
  const geos = edgeGeos(team, pos);
  const out: Pos[] = [];
  for (const key of back) {
    const g = geos[key];
    if (g === undefined) continue;
    for (let k = 0; k <= 20; k++) {
      const p = bezierAt(g.n, k / 20);
      out.push({ x: p.x, y: p.y });
    }
  }
  return out;
}

const MARK_TRY = [0.5, 0.4, 0.6, 0.32, 0.68, 0.26, 0.74];

/**
 * Where each edge's direction mark sits (spec 50 §4, the design's tsmMarks).
 *
 * Mid-curve, because that is where lines leaving one sender (or entering one
 * receiver) are furthest apart. In a nine-member team the layers are 48px
 * apart and two crossing lines often share a midpoint, so marks are placed in
 * edge order and each one slides along its own line until it is clear of every
 * star (21px) and every mark already placed (19px). The angle is the curve's
 * own tangent there, so the arrow points along the line, not along the chord.
 *
 * The "remove flow" button uses the same spot: at t = 0.5 it covered a star in
 * the design's scene 68.
 */
export function markPoints(team: Team, pos: Positions): Record<string, Pos & { a: number }> {
  const geos = edgeGeos(team, pos);
  const stars = team.members.filter((m) => pos[m.workspaceId] !== undefined).map((m) => starPoint(pos[m.workspaceId]));
  const placed: Pos[] = [];
  const out: Record<string, Pos & { a: number }> = {};
  for (const e of team.edges) {
    const g = geos[edgeKey(e)];
    if (g === undefined) continue;
    const clear = (p: Pos) =>
      stars.every((s) => Math.hypot(p.x - s.x, p.y - s.y) >= 21) &&
      placed.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= 19);
    const p = MARK_TRY.map((u) => bezierAt(g.n, u)).find(clear) ?? bezierAt(g.n, 0.5);
    placed.push(p);
    out[edgeKey(e)] = p;
  }
  return out;
}

// ── Viewport ────────────────────────────────────────────────────────────────

export interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 1.75;
/** "Fit" never magnifies past this: a two-member team would otherwise fill the canvas. */
export const FIT_MAX = 1.2;
const MARGIN = 20;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Fit the whole team into the canvas (spec 50 §4, the design's tcFitCalc).
 *
 * Twenty pixels round the edge, not a ratio — a ratio of a small team is a lot
 * of empty canvas. If that puts a node under the zoom buttons or the minimap
 * (`obstacles`, canvas-local), it tries the band above them and the column
 * between them, and keeps whichever fits largest; if every try is covered it
 * falls back to the whole canvas.
 *
 * `extra` widens the box by points that must also be visible: the star's halo
 * reaches about 20px left of the node.
 *
 * `reachLeft` is how far a member is drawn left of its box (canvas units) —
 * the star and its halo on the star map. "Under the zoom buttons" is judged on
 * what is drawn, not on the box: judged on the box alone, a member could sit
 * flush right of the buttons with half its star under them (my-design review
 * F26).
 */
export function fitViewport(
  pos: Positions,
  ids: string[],
  extra: Pos[],
  box: { w: number; h: number },
  obstacles: Rect[],
  reachLeft = 0,
): Viewport {
  if (ids.length === 0) return { x: 0, y: 0, zoom: 1 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids) {
    const p = pos[id];
    if (p === undefined) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + NODE_W);
    y1 = Math.max(y1, p.y + NODE_H);
  }
  for (const p of extra) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, zoom: 1 };
  const bw = x1 - x0;
  const bh = y1 - y0;
  const M = MARGIN;
  const top = Math.min(box.h, ...obstacles.map((o) => o.t));
  const ctrlR = obstacles[0]?.r ?? 0;
  const miniL = obstacles[1]?.l ?? box.w;
  const areas = [
    { x: M, y: M, w: box.w - 2 * M, h: box.h - 2 * M },
    { x: M, y: M, w: box.w - 2 * M, h: top - 1.5 * M },
    { x: ctrlR + M / 2, y: M, w: miniL - ctrlR - M, h: box.h - 2 * M },
  ].filter((a) => a.w > 40 && a.h > 40);
  if (areas.length === 0) return { x: 0, y: 0, zoom: 1 };
  const fits = areas.map((a) => {
    const zoom = clamp(Math.min(a.w / bw, a.h / bh, FIT_MAX), ZOOM_MIN, ZOOM_MAX);
    const x = a.x + (a.w - bw * zoom) / 2 - x0 * zoom;
    const y = a.y + (a.h - bh * zoom) / 2 - y0 * zoom;
    const clear = ids.every((id) => {
      const p = pos[id];
      if (p === undefined) return true;
      const r = { l: x + (p.x - reachLeft) * zoom, t: y + p.y * zoom, r: x + (p.x + NODE_W) * zoom, b: y + (p.y + NODE_H) * zoom };
      return obstacles.every((o) => r.r <= o.l || o.r <= r.l || r.b <= o.t || o.b <= r.t);
    });
    return { x, y, zoom, clear };
  });
  const ok = fits.filter((f) => f.clear);
  const best = fits[0].clear ? fits[0] : ok.length > 0 ? ok.reduce((a, b) => (b.zoom > a.zoom ? b : a)) : fits[0];
  return { x: best.x, y: best.y, zoom: best.zoom };
}

/**
 * The whole team moved into the space left of an open inspector (spec 50 §5,
 * the design's tsmAfter) — but only if every name still reads at 12px there
 * (14px × 0.86 on the star map; the orbit's 15px names allow 0.8, §16).
 * Otherwise `null`: the inspector is opaque, so what it covers is hidden,
 * not garbled.
 *
 * `o.extra` widens the box (the orbit's ring), `o.halo` is how far the
 * star's glow reaches left of a node (none on the orbit).
 */
export function viewportLeftOf(
  pos: Positions,
  ids: string[],
  box: { w: number; h: number },
  inspectorW: number,
  miniTop: number | null,
  current: number,
  o: { extra?: Pos[]; halo?: number; min?: number } = {},
): Viewport | null {
  if (ids.length === 0) return null;
  const extra = o.extra ?? [];
  const xs = ids.map((id) => pos[id]?.x ?? 0);
  const ys = ids.map((id) => pos[id]?.y ?? 0);
  const x0 = Math.min(...xs, ...extra.map((p) => p.x)) - (o.halo ?? 18);
  const y0 = Math.min(...ys, ...extra.map((p) => p.y));
  const w = Math.max(...xs.map((x) => x + NODE_W), ...extra.map((p) => p.x)) - x0;
  const h = Math.max(...ys.map((y) => y + NODE_H), ...extra.map((p) => p.y)) - y0;
  const M = MARGIN;
  const aw = box.w - inspectorW - 24 - 2 * M;
  const ah = (miniTop !== null ? miniTop - M / 2 : box.h - M) - M;
  const zoom = Math.min(current, aw / w, ah / h);
  if (zoom < (o.min ?? 0.86)) return null;
  return { zoom, x: M + (aw - w * zoom) / 2 - x0 * zoom, y: M + (ah - h * zoom) / 2 - y0 * zoom };
}

// ── The card's little sky ───────────────────────────────────────────────────

const SKY_W = 340;
const SKY_H = 112;

/**
 * The team card's constellation (spec 50 §1, the design's tsmFit): the same
 * positions as the canvas, scaled uniformly (so the shape survives) into a
 * 340 × 112 box and centred, at most 0.56 — two stars must not stretch into a
 * line across the card. Percentages, because the card's width varies.
 */
export function skyPoints(team: Team, pos: Positions): Record<string, Pos> {
  const pts = team.members
    .filter((m) => pos[m.workspaceId] !== undefined)
    .map((m) => [m.workspaceId, starPoint(pos[m.workspaceId])] as const);
  if (pts.length === 0) return {};
  const xs = pts.map(([, p]) => p.x);
  const ys = pts.map(([, p]) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const s = Math.min(
    x1 > x0 ? (SKY_W - 90) / (x1 - x0) : Infinity,
    y1 > y0 ? (SKY_H - 44) / (y1 - y0) : Infinity,
    0.56,
  );
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const out: Record<string, Pos> = {};
  for (const [id, p] of pts) {
    out[id] = {
      x: +(50 + (((p.x - cx) * s) / SKY_W) * 100).toFixed(2),
      y: +(50 + (((p.y - cy) * s) / SKY_H) * 100).toFixed(2),
    };
  }
  return out;
}
