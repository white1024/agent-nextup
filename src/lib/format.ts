/** Small formatting helpers shared across views. */

import type { WorkspaceOverview } from "../types";

/** Human-readable byte size (D71 Batch B attachments). Binary units to match
 * the exchange's byte-count caps (MAX_ATTACHMENT_TOTAL_BYTES is 50 MiB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Last path segment, tolerating either separator (native pickers hand back
 * OS-native paths — backslashes on Windows). */
export function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** What to call the project at `root` on screen: the name it declares, and its
 * folder name when the registry has no entry for it.
 *
 * The declared name is authoritative rather than cached — `registry::overview`
 * reads each root's live project.json and only falls back to the registry row
 * when that file is gone — so every caller resolving through here shows the
 * same word for the same root, whichever window it renders in.
 *
 * The fallback is not dead code: a session outlives its registry entry (the
 * user can drop a project from the recent list while its agent keeps running),
 * and a folder name is still an answer where a bare path is not.
 */
export function workspaceName(overview: WorkspaceOverview[] | null, root: string): string {
  const declared = overview?.find((ws) => ws.root === root)?.name;
  return declared ?? baseName(root.replace(/[\\/]+$/, ""));
}
