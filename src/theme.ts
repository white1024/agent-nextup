import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "nextup-theme";

/** Cross-window broadcast: the theme is machine-wide, so switching it in one
 *  window (Settings lives in the main one) must restyle every open pop-out too
 *  — both its app-themed chrome and its native title bar. Carries no payload;
 *  listeners re-read localStorage themselves. */
export const THEME_EVENT = "theme://changed";

export function getThemeMode(): ThemeMode {
  const saved =
    typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function setThemeMode(mode: ThemeMode) {
  if (mode === "system") {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, mode);
  }
  applyThemeMode(mode);
  void emit(THEME_EVENT).catch(() => {});
}

export function applyThemeMode(mode: ThemeMode = getThemeMode()) {
  const root = document.documentElement;
  if (mode === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = mode;
  }
  // The native title bar follows the same choice (D74): explicit light/dark
  // pins it, "system" hands it back to the OS. Guard first — getCurrentWindow()
  // throws *synchronously* outside Tauri (vite opened in a plain browser), and
  // a .catch only covers the promise. Then fire-and-forget: the DOM theme above
  // is already applied, and a platform without native support (some Linux WMs)
  // just keeps its stock chrome.
  if (!isTauri()) return;
  void getCurrentWindow()
    .setTheme(mode === "system" ? null : mode)
    .catch(() => {});
}
