/** Startup timing marks.
 *
 * Opening the app showed a blank window for a noticeable stretch (D106). The
 * cause splits into segments that need different fixes, and guessing which one
 * dominates is how you spend a day on the wrong one — so each is marked and
 * the breakdown is logged on first paint.
 *
 *   serve → html      document navigation to the inline script: handing
 *                     index.html over the custom protocol
 *   html → bundle     fetch + parse + execute of the single app chunk — the
 *                     segment the boot splash covers
 *   bundle → paint    React mount
 *   paint → data      the first IPC round trip (App's own `.splash`)
 *
 * **What this cannot see**: everything before `performance.timeOrigin`, which
 * is when *this document's* navigation began — so process start, the WebView2
 * environment and controller, and the window appearing are all outside it. If
 * the segments below add up to far less than the blank stretch you actually
 * watched, the time is in there, and no amount of frontend instrumentation
 * will reach it: that measurement has to come from the Rust side. Do not read
 * a small `serve` number as "the webview started fast".
 *
 * `window.__boot.html` is set by the inline script in index.html, which runs
 * before this module exists — hence the loose shape and the fallbacks.
 */

export type BootMark = "html" | "bundle" | "paint" | "data";

declare global {
  interface Window {
    __boot?: Partial<Record<BootMark, number>>;
  }
}

/** The hold before the boot splash fades in, as index.html's `.boot` animation
 *  states it. Duplicated here rather than read back out of the stylesheet
 *  because the arithmetic below needs it before first paint; src/boot.test.ts
 *  holds the two copies to each other. */
export const BOOT_HOLD_MS = 260;

/** How long the splash is shown for, at minimum, measured from the same origin
 *  as every other mark here.
 *
 *  This one buys nothing technical — it *costs* startup time, on every launch,
 *  deliberately. The hold above suppresses the splash on a boot fast enough not
 *  to need it, and in a packaged build that is every boot (G066), so the brand
 *  moment existed only in `pnpm tauri dev`. Shown on request: the screen is
 *  wanted for its own sake, not as an apology for a wait.
 *
 *  It is one number. Drop it to 0 and the behaviour is exactly what it was
 *  before — splash only when the machine is actually slow.
 *
 *  ⚠️ Paired with the `boot-pulse` period in index.html, and the pairing is
 *  the whole point of the value. The mark's pulse is only legible if the
 *  screen stays up for at least one full cycle: at 800ms against a 1.8s pulse
 *  a packaged boot showed 38% of a cycle, entirely within the rising half, so
 *  the mark just brightened once and left — running, animated, and reading as
 *  a plain fade-in. **Shorten this and the pulse stops being a pulse.** */
export const BOOT_MIN_VISIBLE_MS: number = 1200;

/** When the boot stops looking merely slow and starts looking stuck.
 *
 *  `api.systemStatus()` settling is what ends the splash, and a rejection is
 *  already handled — the error card with its retry button. What is not handled
 *  is a call that neither resolves nor rejects: `status` stays null, no error
 *  is ever set, and the splash pulses on with nothing to click, forever.
 *
 *  ⚠️ This must never fire on a boot that is merely slow. A workspace with
 *  enough tasks makes `counts_for_dir` genuinely take its time, and the splash
 *  covering that is the design working — telling that user something is wrong
 *  would be a lie the app cannot support, and a worse one than silence. So the
 *  threshold sits far above any plausible healthy boot, and what it produces is
 *  a way out rather than a diagnosis. */
export const BOOT_SLOW_MS = 10_000;

/** Milliseconds since the document origin, or null when there is no mark to
 *  measure from (outside Tauri, or in a test that never ran the inline
 *  script). Callers pick their own fallback — the two below want opposite
 *  ones, so this deliberately does not choose for them. */
function sinceOrigin(): number | null {
  if (typeof window === "undefined") return null;
  const started = window.__boot?.html;
  return started === undefined ? null : Date.now() - started;
}

/** Milliseconds still owed to the splash, or 0 once it has had its showing.
 *
 *  Measured from the document origin rather than from App's mount so that the
 *  time the bundle already spent counts towards it: on a slow boot the splash
 *  has been up for a while and should not then be held for a further second.
 *
 *  Unmeasurable falls back to 0 — no mark means no basis for holding anything,
 *  and the safe direction is to get out of the way. */
export function bootSplashRemaining(): number {
  const elapsed = sinceOrigin();
  return elapsed === null ? 0 : Math.max(0, BOOT_MIN_VISIBLE_MS - elapsed);
}

/** Milliseconds until the way out should appear.
 *
 *  Unmeasurable falls back to the full delay counted from now — the opposite
 *  choice to the one above, and for the same reason. There, 0 means "stop
 *  holding", which is harmless; here it would mean "declare this boot slow
 *  immediately", which is the lie the threshold exists to avoid. */
export function bootSlowDelay(): number {
  return Math.max(0, BOOT_SLOW_MS - (sinceOrigin() ?? 0));
}

/** Animation offsets for a `.boot` element mounted *after* index.html's copy
 *  was cleared by React's first render.
 *
 *  The handoff renders the same markup under the same class, and the styles
 *  survive it — index.html's inline `<style>` is in `<head>`, so only the
 *  `#root` children were replaced. The *animations* do not survive it. A
 *  freshly mounted element restarts both of them from zero, and each breaks
 *  differently on a boot slow enough to have shown the splash already:
 *
 *    `hold`   the container's fade would run its 260ms hold a second time, so
 *             the mark blinks out and fades back in. A negative value instead
 *             drops it in at the opacity it had reached, and past the fade
 *             entirely once enough time has gone by. Clamped at 0, never
 *             positive: index.html's copy holds back because a fast boot may
 *             not want a splash at all, but by the time App is mounting that
 *             question is already settled — BOOT_MIN_VISIBLE_MS says it is
 *             being shown, so waiting again would only eat into the showing.
 *    `shift`  the mark's pulse would jump back to the start of its cycle —
 *             visible as a step in brightness, since 0% is its dimmest frame.
 *             Offsetting an infinite animation shifts its phase rather than
 *             its start, so the cycle simply continues.
 *
 *  Both undefined when there is no mark to measure from, which leaves the
 *  stylesheet's own values in place — the pre-handoff behaviour.
 *
 *  ⚠️ Call this **once per mounted element**, not once per render. The values
 *  position the animations against the document origin, so handing an element
 *  a freshly computed pair on a later render moves that origin out from under
 *  a running animation and steps the pulse forward. The splash outlives at
 *  least one re-render by design (BOOT_MIN_VISIBLE_MS keeps it up past the
 *  arrival of `status`), so this is reachable, not theoretical. */
export function bootSplashDelays(): { hold?: string; shift?: string } {
  if (typeof window === "undefined") return {};
  const started = window.__boot?.html;
  if (started === undefined) return {};
  const elapsed = Date.now() - started;
  return { hold: `${Math.min(0, BOOT_HOLD_MS - elapsed)}ms`, shift: `-${elapsed}ms` };
}

export function markBoot(mark: BootMark) {
  if (typeof window === "undefined") return;
  const boot = (window.__boot ??= {});
  // First write wins: `paint` and `data` fire from effects that React's strict
  // mode runs twice in development, and the second one is not the real thing.
  boot[mark] ??= Date.now();
}

let logged = false;

/** One-line breakdown, logged once. Release builds ship without devtools
 *  (`tauri = { features = [] }`), so this is for `pnpm tauri dev` and for
 *  anyone reading `window.__boot` directly — a packaged app needs the numbers
 *  surfaced some other way before they can be read, and dev-mode numbers say
 *  nothing about a packaged one (vite serves modules unbundled there). */
export function logBootBreakdown() {
  if (typeof window === "undefined" || typeof performance === "undefined") return;
  const boot = window.__boot;
  if (!boot?.html || !boot.bundle || !boot.paint) return;
  // The caller sits in an effect, which strict mode runs twice in development
  // — the very place this is read. markBoot's first-write-wins keeps the
  // numbers honest but would still print them twice.
  if (logged) return;
  logged = true;
  const nav = performance.timeOrigin;
  const seg = (from: number, to: number | undefined) =>
    to === undefined ? "—" : `${Math.round(to - from)}ms`;
  console.info(
    `[boot] serve ${seg(nav, boot.html)} · bundle ${seg(boot.html, boot.bundle)}` +
      ` · mount ${seg(boot.bundle, boot.paint)} · data ${seg(boot.paint, boot.data)}` +
      ` · since navigation ${seg(nav, boot.data ?? boot.paint)}` +
      ` (process start and webview creation are before this clock)`,
  );
}
