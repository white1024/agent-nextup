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

/**
 * A template's description as a card shows it (spec 60 / 20, my-design review
 * F30): the phase chain ("Spec → Implement → …") taken out, because the card's
 * own phase band already draws those phases, and with them gone the id after
 * the description has room again. What remains is the sentence's other half
 * ("with built-in quality gates"), capitalised when it was a clause; nothing
 * at all when the description was only the chain.
 *
 * Display only (invariant 17(b)): the template keeps its words, the editor and
 * the tooltip show them whole.
 */
export function shortTemplateDescription(desc: string): string {
  // Clause separators, ASCII and full-width (comma, full stop, colon,
  // semicolon, ideographic comma) — as escapes: CJK in source blocks the
  // public mirror's scan (D81).
  const sep = ",.:;\\uFF0C\\u3002\\uFF1A\\uFF1B\\u3001";
  const chain = new RegExp(`[:\\uFF1A]?\\s*[^${sep}\\u2192]+(?:\\u2192[^${sep}\\u2192]+)+`, "g");
  const rest = desc
    .replace(chain, "")
    .replace(new RegExp(`^[${sep}\\s]+|[${sep}\\s]+$`, "g"), "")
    .trim();
  return rest.replace(/^[a-z]/, (c) => c.toUpperCase());
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

/**
 * A count sentence ("{{n}} gates") split around its number, so the number can
 * scramble on its own (C146, C169) without the word flickering with it. `render`
 * is `t` with the key bound; the sentence comes back as [before, after].
 */
export function splitAroundCount(render: (n: string) => string): [string, string] {
  const MARK = "\u0001";
  const s = render(MARK);
  const i = s.indexOf(MARK);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + MARK.length)];
}
