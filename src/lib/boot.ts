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
