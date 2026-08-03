/**
 * App-level UI preferences, stored next to language (`nextup-lang`) and theme
 * (`nextup-theme`). These are facts about *this person* rather than about a
 * project, so they follow the user across every workspace.
 */

/**
 * JSON-valued preference storage. Started life private to notify.ts (D62) and
 * moved here in D63 when a second structured preference appeared: every one of
 * them needs the same tolerance for a corrupt value and a full quota, and two
 * private copies of that would drift.
 */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // A corrupt or hand-edited value must not brick the app: fall back to the
    // empty state, which degrades to "treat this as first seen".
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Quota or private-mode failures cost us de-duplication, not correctness.
    console.warn("prefs: cannot persist", key, e);
  }
}

/** A stored array that survives someone hand-editing it into another shape. */
function readStrings(key: string): string[] {
  const raw = readJson<unknown>(key, []);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

const VERIFY_NUDGE_KEY = "nextup-verify-nudge-off";

/**
 * Whether the done≠verified teaching moment still shows when a task is claimed
 * done (D60). Dismissible for good from the task itself, restorable from the
 * app settings page — a preference with no way back is a trap.
 */
export function verifyNudgeEnabled(): boolean {
  return localStorage.getItem(VERIFY_NUDGE_KEY) !== "1";
}

export function setVerifyNudgeEnabled(enabled: boolean): void {
  if (enabled) localStorage.removeItem(VERIFY_NUDGE_KEY);
  else localStorage.setItem(VERIFY_NUDGE_KEY, "1");
}

const CANVAS_HINT_KEY = "nextup-canvas-hint-off";

/**
 * The team canvas' first-use hint: dragging from a node's right edge is a
 * hidden gesture, so it needs saying once (product review §5-8). Dismissed for good on
 * the first "Got it" — the hand does not forget.
 */
export function canvasHintEnabled(): boolean {
  return localStorage.getItem(CANVAS_HINT_KEY) !== "1";
}

export function dismissCanvasHint(): void {
  localStorage.setItem(CANVAS_HINT_KEY, "1");
}

const TEACHING_HINTS_KEY = "nextup-teaching-hints-off";

/**
 * Teaching hints this person has put away for good (r2 2-3). Which hints are
 * allowed to be dismissible — and which have to stay on screen forever — is
 * the boundary documented in `TeachingHint.tsx`.
 *
 * One list rather than a key per hint: they are the same preference wearing
 * different labels, and the settings page brings them all back together.
 */
export function teachingHintDismissed(id: string): boolean {
  return readStrings(TEACHING_HINTS_KEY).includes(id);
}

export function dismissTeachingHint(id: string): void {
  const list = readStrings(TEACHING_HINTS_KEY);
  if (list.includes(id)) return;
  writeJson(TEACHING_HINTS_KEY, [...list, id]);
}

export function dismissedTeachingHints(): number {
  return readStrings(TEACHING_HINTS_KEY).length;
}

/** The way back, without which dismissal would be a trap (same reason the
 *  verify nudge is restorable). */
export function restoreTeachingHints(): void {
  localStorage.removeItem(TEACHING_HINTS_KEY);
}

const IDENTITIES_KEY = "nextup-agent-identities";
const IDENTITY_LIMIT = 8;

/**
 * Agent identities recently used to launch a terminal (D63), most recent
 * first.
 *
 * There is no identity registry anywhere in Agent NextUp, by design: an identity is
 * whatever an agent self-reports, and the ledger's `actor` column is a history
 * of who has spoken, not a roster of who may. So the picker offers what this
 * person has actually used at this desk and lets them type anything else.
 */
export function recentIdentities(): string[] {
  return readStrings(IDENTITIES_KEY);
}

export function rememberIdentity(name: string): void {
  const clean = name.trim();
  if (clean === "") return;
  const next = [clean, ...recentIdentities().filter((n) => n !== clean)].slice(0, IDENTITY_LIMIT);
  writeJson(IDENTITIES_KEY, next);
}

const CONNECTED_KEY = "nextup-connected-roots";

/**
 * Workspaces where an agent is known to have reached the hub (D63), so the
 * connect guide stops offering to help.
 *
 * Sticky on purpose. The live evidence — an `agent_tool_called` line — scrolls
 * out of any bounded tail, so re-deriving the answer on every open would make
 * the guide reappear on a project that has been running agents for months.
 * Recording it once is also what the guide's "already connected" dismissal
 * writes, which is why a false negative is cheap: one click ends it for good.
 */
export function isConnected(root: string): boolean {
  return readStrings(CONNECTED_KEY).includes(root);
}

export function markConnected(root: string): void {
  const list = readStrings(CONNECTED_KEY);
  if (list.includes(root)) return;
  writeJson(CONNECTED_KEY, [...list, root]);
}

const TERMINAL_ACTIVE_KEY = "nextup-terminal-active";

/**
 * The terminal tab the user last had active in each workspace root (D69, path
 * B). On reopening the terminal page that tab is made active, so the on-view
 * resume reattaches the conversation they were last in — instead of always
 * landing on the oldest tab. Per-root because each workspace has its own tabs.
 * A machine-local session id: if it no longer exists (fresh install, closed
 * tab), the caller falls back to the first tab, which is harmless. Lives here
 * (not in the persisted terminal metadata) because "which tab I was looking
 * at" is a fact about this person on this machine, not about the workspace.
 */
export function lastActiveTerminal(root: string): number | null {
  const map = readJson<Record<string, number>>(TERMINAL_ACTIVE_KEY, {});
  const id = map[root];
  return typeof id === "number" ? id : null;
}

export function rememberActiveTerminal(root: string, id: number): void {
  const map = readJson<Record<string, number>>(TERMINAL_ACTIVE_KEY, {});
  if (map[root] === id) return;
  writeJson(TERMINAL_ACTIVE_KEY, { ...map, [root]: id });
}
