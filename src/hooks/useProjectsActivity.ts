/**
 * Cross-project agent activity for the overview (D155): one `projects_activity`
 * read every few seconds while the overview is on screen.
 *
 * Polled rather than watched. The file watcher follows the one open workspace
 * (D62); the overview shows every registered one, and a watcher per project
 * would be a lifecycle to manage for a page that is mostly glanced at. The
 * read is a fixed tail per project, so the poll costs the same however long
 * the projects' histories grow.
 *
 * `null` until the first read lands (invariant 10): the header must not say
 * "0 waiting" before it knows.
 */
import { useEffect, useState } from "react";

import { api } from "../api";
import type { ProjectActivity } from "../types";

const POLL_MS = 3000;

/** Local midnight, as the engine's `since` — the GUI owns the time zone. */
export function startOfToday(now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function useProjectsActivity(active: boolean): ProjectActivity[] | null {
  const [rows, setRows] = useState<ProjectActivity[] | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: number | undefined;
    const read = async () => {
      // A hidden window is not looking; skip the read but keep the beat, so
      // coming back is at most one interval stale.
      if (document.visibilityState === "visible") {
        try {
          const next = await api.projectsActivity(startOfToday());
          if (!cancelled) setRows(next);
        } catch (e) {
          // The command itself only fails on a broken registry, which the
          // overview's own read reports; the activity layer just stays as it was.
          console.warn("projects activity failed:", e);
          if (!cancelled) setRows((prev) => prev ?? []);
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void read(), POLL_MS);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active]);

  return rows;
}
