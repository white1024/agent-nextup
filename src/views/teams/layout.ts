import type { Team, TeamEdge } from "../../types";

/** Auto-layout grid step, in canvas pixels. */
export const COL = 320;
export const ROW = 150;

/**
 * Longest-path layer per wired member (upstream = 0). Unwired members are
 * absent. Shared by the auto-layout and the edge-span calculation so both
 * agree on what "skips a layer" means.
 */
export function layersOf(team: Team): Map<string, number> {
  const wired = new Set<string>();
  for (const edge of team.edges) {
    wired.add(edge.from);
    wired.add(edge.to);
  }
  const layer = new Map<string, number>();
  for (const id of wired) layer.set(id, 0);
  const passes = Math.max(1, wired.size);
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (const edge of team.edges) {
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

/** Every node that can reach `id` (including `id`) — invalid as edge targets. */
export function ancestorsOf(id: string, edges: TeamEdge[]): Set<string> {
  const preds = new Map<string, string[]>();
  for (const edge of edges) {
    const arr = preds.get(edge.to) ?? [];
    arr.push(edge.from);
    preds.set(edge.to, arr);
  }
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const p of preds.get(cur) ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return seen;
}

/**
 * May `from → to` be added? Rejects self-edges, duplicates and anything that
 * would close a cycle. Shared by the canvas drag path (`isValidConnection`,
 * which pre-blocks an invalid drop) and the inspector's keyboard-reachable
 * form (which only offers valid targets) so the two cannot drift — core stays
 * the enforcer either way.
 */
export function canConnect(from: string, to: string, edges: TeamEdge[]): boolean {
  if (from === "" || to === "" || from === to) return false;
  if (edges.some((e) => e.from === from && e.to === to)) return false;
  // from→to closes a cycle iff `to` already reaches `from`.
  return !ancestorsOf(from, edges).has(to);
}

/**
 * Deterministic auto slots (D53 §4): wired members on a longest-path layered
 * grid (upstream left), unwired members in rows beneath. Pure — same team
 * shape always yields the same slots, so unsaved nodes never jump between
 * renders. Also the"Tidy up" source of truth.
 */
export function autoPositions(team: Team): Record<string, { x: number; y: number }> {
  const layer = layersOf(team);

  const positions: Record<string, { x: number; y: number }> = {};
  const rowsPerLayer = new Map<number, number>();
  for (const member of team.members) {
    const depth = layer.get(member.workspaceId);
    if (depth === undefined) continue;
    const row = rowsPerLayer.get(depth) ?? 0;
    rowsPerLayer.set(depth, row + 1);
    positions[member.workspaceId] = { x: 60 + depth * COL, y: 60 + row * ROW };
  }

  // Step bypassed nodes off skip-edge lines. A chain a→b→c that also has a→c
  // otherwise lands all three on one row, and the a→c edge disappears behind
  // b — exactly the "after Tidy up the lines overlap and you can't tell the
  // flows apart" report (the D53 walkthrough).
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
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
