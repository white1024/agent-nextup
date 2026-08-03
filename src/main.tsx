import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";

import App from "./App";
import PopoutTerminal from "./views/PopoutTerminal";
import "./i18n";
import "./styles.css";
import { markBoot } from "./lib/boot";
import { applyThemeMode, THEME_EVENT } from "./theme";

// Everything above is the single ~1.2MB chunk, and this is the first line that
// runs after it — so the gap from window.__boot.html is exactly what the boot
// splash in index.html was added to cover. See boot.ts.
markBoot("bundle");

applyThemeMode();
// Another window switched the machine-wide theme — restyle this one too
// (window-lifetime listener, nothing to unsubscribe; outside Tauri the
// registration rejects and the catch swallows it).
void listen(THEME_EVENT, () => applyThemeMode()).catch(() => {});

// A pop-out window (B16-C) loads the same bundle with `?popout=<id>` and
// renders just that one terminal, not the whole app shell.
const popoutId = new URLSearchParams(window.location.search).get("popout");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {popoutId !== null ? <PopoutTerminal sessionId={Number(popoutId)} /> : <App />}
  </React.StrictMode>,
);
