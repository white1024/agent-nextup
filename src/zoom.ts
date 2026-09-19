import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

const STORAGE_KEY = "nextup-zoom";

/**
 * Cross-window broadcast, mirroring THEME_EVENT: the zoom is machine-wide, so
 * changing it in Settings (which only exists in the main window) has to resize
 * every open pop-out too. Carries no payload — listeners re-read storage.
 */
export const ZOOM_EVENT = "zoom://changed";

/**
 * The offered steps, and the reason the largest one is 1.25 rather than
 * something rounder.
 *
 * This is webview zoom: the whole page scales, so the viewport measured in CSS
 * px *shrinks* as the factor grows. The window's own floor is `minWidth: 960`
 * (tauri.conf.json), which at 1.25 leaves 768 CSS px — and styles.css already
 * carries breakpoints at 1040 / 980 / 900 / 800 / 760, so that width is still
 * inside the range the layout was designed for. 1.5 would leave 640 px, below
 * the lowest breakpoint, where nothing is written to catch it.
 *
 * So the ceiling is not a guess about taste: it is the last step that stays on
 * the responsive ladder the app already has. Widen the window and there is more
 * room than this assumes — the cap is set for the worst case, which is the only
 * one that can break.
 *
 * ⚠️ Raising it means adding a breakpoint below 760 first, not just editing
 * this array.
 */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25] as const;

export const ZOOM_DEFAULT = 1;

/** Snap to an offered step. A stored value is one hand-edit from being a factor
 *  no button can undo — at 4x every control is off screen, including the one
 *  that would put it back. */
export function clampZoom(factor: number): number {
  if (!Number.isFinite(factor)) return ZOOM_DEFAULT;
  return ZOOM_STEPS.reduce((best, step) =>
    Math.abs(step - factor) < Math.abs(best - factor) ? step : best,
  );
}

export function getZoom(): number {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  return raw === null ? ZOOM_DEFAULT : clampZoom(Number(raw));
}

export function setZoom(factor: number): number {
  const next = clampZoom(factor);
  if (next === ZOOM_DEFAULT) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, String(next));
  applyZoom(next);
  void emit(ZOOM_EVENT).catch(() => {});
  return next;
}

/**
 * Push the factor into this webview.
 *
 * Re-applied on every window because WebView2 does not persist it: a pop-out
 * opens at 1.0 regardless of what the main window is showing, which is why
 * main.tsx calls this on boot rather than only Settings calling it on change.
 *
 * Guard first, then fire-and-forget — getCurrentWebview() throws *synchronously*
 * outside Tauri (vite opened in a plain browser) and a .catch would not cover
 * that, the same trap applyThemeMode() documents one layer over.
 */
export function applyZoom(factor: number = getZoom()): void {
  if (!isTauri()) return;
  void getCurrentWebview()
    .setZoom(factor)
    .catch(() => {});
}
