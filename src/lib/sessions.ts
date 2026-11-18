/**
 * Names and keys the hub uses for running sessions — shared by the projects
 * overview and the agent overview (both draw the same hub, spec 20 §1 / 40).
 */
import { normRoot } from "./exchange";
import type { ProjectActivity, TerminalSessionMeta } from "../types";

/** A full-width colon, the separator the prototype cuts long names at. */
const WIDE_COLON = "\uff1a";

/**
 * The name the hub and the stream use: the part before a colon, at most 16
 * characters (the card carries the whole name). Spec 20 §1.
 */
export function shortName(name: string): string {
  const head = name.split(WIDE_COLON)[0].split(": ")[0];
  const chars = [...head];
  return chars.length > 16 ? `${chars.slice(0, 15).join("")}…` : head;
}

/** "Claude Code · design" — the agent's title and the identity it runs as. */
export function sessionLabel(s: TerminalSessionMeta, anon: string): string {
  return `${s.title} · ${s.identity ?? anon}`;
}

/** Key for "this session is waiting" — root plus the identity it runs as. */
export function waitKey(root: string, actor: string | null | undefined): string {
  return `${normRoot(root)}#${actor ?? ""}`;
}

/** Every waiting (root, actor) pair. */
export function waitingKeys(activity: ProjectActivity[] | null): Set<string> {
  const out = new Set<string>();
  for (const row of activity ?? []) for (const w of row.waiting) out.add(waitKey(row.root, w.actor));
  return out;
}
