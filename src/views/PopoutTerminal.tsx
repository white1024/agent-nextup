import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api } from "../api";
import { workspaceName } from "../lib/format";
import type { TerminalSessionMeta, WorkspaceOverview } from "../types";
import { TerminalPane } from "./Terminal";

/** A single terminal session rendered in its own OS window (B16-C, "pop-out").
 *  The session lives in Rust and its output is broadcast to every window, so
 *  this window is just another renderer bound to one session id. Move
 *  semantics: the main window shows a placeholder while this window owns the
 *  pixels; closing this window (or the dock button) hands the session back by
 *  clearing its popped-out flag, which the main window reloads on.
 *
 *  Loaded by main.tsx when the URL carries `?popout=<id>`, in place of App. */
export default function PopoutTerminal({ sessionId }: { sessionId: number }) {
  const { t } = useTranslation();
  // undefined = not read yet, null = session gone, else the meta (D65 tri-state).
  const [meta, setMeta] = useState<TerminalSessionMeta | null | undefined>(undefined);
  // Registry catalog, for the same root → project name resolution the agent
  // overview does. `null` until it resolves; workspaceName falls back to the
  // folder name meanwhile, so the bar never renders nameless.
  const [overview, setOverview] = useState<WorkspaceOverview[] | null>(null);

  const reload = useCallback(async () => {
    try {
      const all = await api.terminalList();
      // Only a successful list that lacks the session means "gone" (→ close
      // this window). A transient IPC failure is *not* gone — keep the current
      // view rather than destroying the window over a hiccup.
      setMeta(all.find((s) => s.id === sessionId) ?? null);
    } catch {
      /* keep the last-known meta */
    }
  }, [sessionId]);

  useEffect(() => {
    void reload();
    // If the session is closed from the main window, the list/exit events fire;
    // reload so a vanished session closes this window (effect below).
    const unSessions = listen("terminal://sessions", () => void reload());
    const unExit = listen("terminal://exit", () => void reload());
    return () => {
      void unSessions.then((f) => f());
      void unExit.then((f) => f());
    };
  }, [reload]);

  // Which project this session belongs to. The main window never has to ask —
  // the workspace it has open *is* the answer, and its tabs are filtered to
  // that root. A detached window has only a session id, so it resolves the
  // root itself. Read once: a project renamed mid-session is not worth a
  // subscription, and the window title is a snapshot of the same moment.
  useEffect(() => {
    void api
      .recentWorkspaces()
      .then(setOverview)
      .catch(() => {
        /* leave it null — the folder-name fallback is a real answer */
      });
  }, []);

  // The session was dismissed from the main window — nothing left to render.
  useEffect(() => {
    if (meta === null) void getCurrentWindow().destroy();
  }, [meta]);

  // Closing this window (dock button or the OS close) hands the session back:
  // clear popped_out first so the main window re-renders its live pane, then
  // destroy. Same preventDefault-then-async-then-destroy shape as the quit
  // guard in App.
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      await api.terminalSetPoppedOut(sessionId, false).catch(() => {});
      await getCurrentWindow().destroy();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [sessionId]);

  return (
    <div className="popout">
      <header className="popout-bar">
        {/* The three things the main window's tab row carries and a detached
            window otherwise drops: which project, which agent, whose identity.
            Project first — with several pop-outs open that is the word being
            scanned for, and the other two are identical across them by
            construction (the same CLI, launched the same way). */}
        <span className="popout-ident">
          {meta && (
            <span className="popout-project" title={meta.root}>
              {workspaceName(overview, meta.root)}
            </span>
          )}
          <span className="popout-title">{meta?.title ?? t("term.heading")}</span>
          {meta && (
            <span
              className={`chip term-tab-identity${meta.identity === null ? " is-anon" : ""}`}
              title={t("term.identityLabel")}
            >
              {meta.identity ?? t("term.identityAnon")}
            </span>
          )}
        </span>
        <button className="btn btn-small" onClick={() => void getCurrentWindow().close()}>
          {t("term.dockBack")}
        </button>
      </header>
      <div className="popout-body">
        {meta ? (
          <TerminalPane meta={meta} active />
        ) : meta === null ? (
          <p className="muted popout-gone">{t("term.popoutGone")}</p>
        ) : null}
      </div>
    </div>
  );
}
