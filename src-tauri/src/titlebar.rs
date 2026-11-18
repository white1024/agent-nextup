//! The native title bar, made to read as part of the app (Windows 11).
//!
//! The stock caption is a neutral grey in either theme, over an app whose top
//! edge is a near-black violet in dark and a near-white in light — the seam
//! showed. And its icon and title only repeated what every window already
//! draws a few pixels below it: the sidebar's logo and name in the main
//! window, the project and session in a pop-out's own bar (user report,
//! 2026-11-14). So two things change, both through the platform's own APIs:
//!
//! - DWM paints the caption in the app's top-edge colour, per theme (Windows
//!   11 22000+; Windows 10 rejects the attribute and keeps its stock caption);
//! - uxtheme skips drawing the caption's icon and title. The title itself is
//!   still set — the taskbar, Alt+Tab and screen readers keep reading it —
//!   and so is the icon, which the taskbar keeps showing.
//!
//! Everything else stays native on purpose: the buttons, dragging,
//! double-click to maximise, Snap Layouts on the maximise button, and the
//! close path (G065). Drawing our own bar would have meant redoing all of
//! that, per platform.
//!
//! Best-effort throughout: a failed call leaves the stock caption, which is
//! where we started. Other platforms are untouched.

use tauri::{Runtime, Theme, Window};

/// Paint `window`'s caption for `theme`. Called when a window's page starts
/// loading and on every `ThemeChanged` — which tao sends whenever the
/// *effective* theme changes, so a pinned theme, a switch in Settings and an
/// OS switch under "system" all arrive the same way.
pub fn paint<R: Runtime>(window: &Window<R>, theme: Theme) {
    #[cfg(windows)]
    imp::paint(window, theme);
    #[cfg(not(windows))]
    let _ = (window, theme);
}

/// `paint` with the window's current effective theme, plus the caption's icon
/// and title turned off. Idempotent: page loads repeat it (reloads, HMR).
pub fn setup<R: Runtime>(window: &Window<R>) {
    #[cfg(windows)]
    imp::hide_caption(window);
    if let Ok(theme) = window.theme() {
        paint(window, theme);
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;

    use tauri::{Runtime, Theme, Window};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR};
    use windows_sys::Win32::UI::Controls::{
        SetWindowThemeAttribute, WTA_NONCLIENT, WTA_OPTIONS, WTNCA_NODRAWCAPTION, WTNCA_NODRAWICON,
        WTNCA_NOSYSMENU,
    };

    /// The app's top edge as rendered, sampled at the sidebar (y = 0) on
    /// 2026-11-14: `--sidebar-bg` composited over the page ground. A
    /// composite, not a token, so it is restated here — re-sample it (CDP
    /// screenshot of a 1×1 clip) if the sidebar or the page ground changes.
    const DARK: u32 = colorref(0x09, 0x09, 0x12);
    const LIGHT: u32 = colorref(0xf7, 0xf7, 0xfc);

    /// COLORREF is 0x00BBGGRR.
    const fn colorref(r: u8, g: u8, b: u8) -> u32 {
        (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
    }

    fn hwnd<R: Runtime>(window: &Window<R>) -> Option<HWND> {
        window.hwnd().ok().map(|h| h.0 as HWND)
    }

    pub fn paint<R: Runtime>(window: &Window<R>, theme: Theme) {
        let Some(hwnd) = hwnd(window) else { return };
        let color: u32 = if matches!(theme, Theme::Dark) { DARK } else { LIGHT };
        // SAFETY: a live HWND owned by this process, and a pointer to a u32
        // that outlives the call, with its exact size.
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_CAPTION_COLOR as u32,
                (&color as *const u32).cast::<c_void>(),
                std::mem::size_of::<u32>() as u32,
            );
        }
    }

    pub fn hide_caption<R: Runtime>(window: &Window<R>) {
        let Some(hwnd) = hwnd(window) else { return };
        // NODRAWICON alone leaves the icon on Windows 11 (tried 2026-11-14):
        // the icon is the system menu's handle there, and only goes once that
        // icon menu is off too. The system menu itself stays — right-click on
        // the caption and Alt+Space still open it.
        let flags = WTNCA_NODRAWCAPTION | WTNCA_NODRAWICON | WTNCA_NOSYSMENU;
        let opts = WTA_OPTIONS { dwFlags: flags, dwMask: flags };
        // SAFETY: as above; WTA_OPTIONS is the struct this attribute takes.
        unsafe {
            SetWindowThemeAttribute(
                hwnd,
                WTA_NONCLIENT,
                (&opts as *const WTA_OPTIONS).cast::<c_void>(),
                std::mem::size_of::<WTA_OPTIONS>() as u32,
            );
        }
    }
}
