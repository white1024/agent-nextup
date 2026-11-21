import type { ImportRow, RelinkReport, Team } from "../../types";

/**
 * Which side is newer for a team both machines have (D173 ②). `updatedAt`
 * only moves when the team's content changes — re-linking a folder does not
 * (D173 ③) — so the newer stamp is the machine where someone last changed it.
 * Unparseable or equal stamps are a tie: there is no evidence either way.
 */
export function newerSide(row: ImportRow): "file" | "local" | "tie" {
  if (row.localUpdatedAt === null) return "file";
  const file = Date.parse(row.fileUpdatedAt);
  const local = Date.parse(row.localUpdatedAt);
  if (!Number.isFinite(file) || !Number.isFinite(local) || file === local) return "tie";
  return file > local ? "file" : "local";
}

/**
 * The pre-picked answer per row: a team this machine lacks is added, one with
 * the same content is left alone, and where both sides differ the newer one
 * wins — on a tie this machine's stays, because taking the file is the change
 * that would have to be undone by hand.
 */
export function defaultTake(row: ImportRow): boolean {
  switch (row.status) {
    case "new":
      return true;
    case "same":
      return false;
    case "differs":
      return newerSide(row) === "file";
  }
}

/** Team ids to send as `take`: only rows still picked that have something to do. */
export function takeList(rows: ImportRow[], picked: ReadonlySet<string>): string[] {
  return rows.filter((r) => r.status !== "same" && picked.has(r.id)).map((r) => r.id);
}

/**
 * A re-link runs over every team (a folder's place is a workspace fact), but a
 * page speaks about the teams in front of it: an unrelated team's missing
 * member is not news on this team's page, nor in the result of importing
 * another one.
 */
export function scopeReport(report: RelinkReport, teams: Team[]): RelinkReport {
  const ids = new Set<string>();
  for (const team of teams) {
    for (const m of team.members) ids.add(m.workspaceId);
    if (team.prime) ids.add(team.prime.workspaceId);
  }
  return {
    relinked: report.relinked.filter((r) => ids.has(r.workspaceId)),
    missing: report.missing.filter((r) => ids.has(r.workspaceId)),
  };
}

/**
 * Fold a follow-up search ("look in a folder…") into the line already on
 * screen: everything found so far stays found, and what is still missing is
 * whatever the latest pass could not find.
 */
export function mergeRelink(before: RelinkReport, after: RelinkReport): RelinkReport {
  const seen = new Set(before.relinked.map((r) => r.workspaceId));
  return {
    relinked: [...before.relinked, ...after.relinked.filter((r) => !seen.has(r.workspaceId))],
    missing: after.missing,
  };
}
