import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { api, errorMessage } from "../api";
import { useGuardedMutation } from "../hooks";
import { baseName } from "../lib/format";
import EmptyState from "../components/EmptyState";
import TeachingHint from "../components/TeachingHint";
import { IconPopout, IconStopSquare, IconX } from "../components/icons";
import {
  lastActiveTerminal,
  recentIdentities,
  rememberActiveTerminal,
  rememberIdentity,
} from "../lib/prefs";
import { getThemeMode } from "../theme";
import type {
  AgentInfo,
  TerminalExitPayload,
  TerminalOutputPayload,
  TerminalSessionMeta,
} from "../types";

const OUTPUT_EVENT = "terminal://output";
const EXIT_EVENT = "terminal://exit";
const SESSIONS_EVENT = "terminal://sessions";

/**
 * How long the two-step close stays armed (2026-08-01 UI review, P2 2-1).
 *
 * The protection in a two-step confirm is that the two clicks must be *close
 * together*: the second one means "yes, that one" only while the first is still
 * in mind. Armed indefinitely, the × on a running session became a single-click
 * kill for anyone who came back to the tab ten minutes later — their first
 * click of the day was the system's second.
 */
const CLOSE_ARM_MS = 4000;

/** How long after the last window move/resize event to treat the drag as over
 *  (see the IME re-focus effect in TerminalPane). Long enough that a gesture's
 *  own stream of events never reaches it, short enough that the terminal is
 *  usable again before the user can finish reaching for the keyboard. */
const DRAG_SETTLE_MS = 150;

/** Fixed dark scheme: a terminal is a terminal in both app themes. Values
 *  mirror the app's dark surface/step tokens (design source claude-design). */
const TERM_THEME = {
  background: "#1a1815",
  foreground: "#e8e2d9",
  cursor: "#e07a3f",
  selectionBackground: "#e07a3f44",
};

/** Session ids we've already fired an on-view resume for this app session
 *  (D69 / G3). Module-level so it survives the terminal view unmounting when
 *  the user switches away and back — otherwise a failed resume would re-fire
 *  every time they return to the terminal page ("it blows up once every
 *  time I switch back"). Ids are
 *  globally unique and never reused, so this never needs pruning. */
const attemptedRevive = new Set<number>();

/** Workspace terminal view (D50): tabs of PTY sessions launched in this
 *  workspace root. The processes and their scrollback live in Rust at the
 *  app level — this view is just pixels. Unmounting (switching workspace or
 *  view) disposes only the renderers; remounting replays the buffer and
 *  resumes the stream, deduplicated by chunk seq.
 *
 *  Trust boundary (D14/D50): launching is the button below (human), and the
 *  only PTY input path is xterm's onData — real keystrokes in a focused
 *  terminal. Nothing here synthesizes input.
 */
export default function TerminalView({
  root,
  projectName,
  onSessionsChanged,
}: {
  root: string;
  /** Display name of the open workspace — goes into a pop-out's OS window
   *  title, which is the only label the taskbar and alt-tab ever show. */
  projectName: string;
  /** Launch/close changed the app-level session set — App refreshes the
   *  sidebar/card running markers from it. */
  onSessionsChanged?: () => void;
}) {
  const { t } = useTranslation();
  // `null` until the first `terminal_list` resolves (D65) — an empty list and
  // an unanswered read must not render the same "no sessions yet" copy.
  const [sessions, setSessions] = useState<TerminalSessionMeta[] | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [confirmingClose, setConfirmingClose] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy: launching, run } = useGuardedMutation(setError);
  // In-flight / failed revives, keyed by session id (D69): a restored tab is
  // either resuming ("loading") or shows a failure card ({ error }); absent =
  // idle. Per-tab, not a single view-level banner, so one tab's failure never
  // masks another's.
  const [reviving, setReviving] = useState<Record<number, "loading" | { error: string }>>({});
  // Hub identity for the next launch (D63). Seeded from the most recent name
  // so running the same agent again is one click, as it was before.
  const [knownIdentities, setKnownIdentities] = useState<string[]>(() => recentIdentities());
  const [identity, setIdentity] = useState(() => recentIdentities()[0] ?? "");
  const tablistRef = useRef<HTMLDivElement>(null);

  /** Tabs to render — `sessions` keeps `null` for the "not read yet" case. */
  const tabs = sessions ?? [];

  /** The active tab — drives the on-view lazy resume (D69) below. */
  const activeSession = tabs.find((s) => s.id === active) ?? null;

  /** Arrow-key navigation for the ARIA tabs (automatic activation: moving
   *  to a tab also selects it). */
  function onTabKey(e: KeyboardEvent, id: number) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const idx = tabs.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const last = tabs.length - 1;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? last
          : e.key === "ArrowRight"
            ? idx === last
              ? 0
              : idx + 1
            : idx === 0
              ? last
              : idx - 1;
    setActive(tabs[next].id);
    // tabIndex is recomputed from `active`, so focusing has to wait for
    // React to commit before the newly focusable tab exists.
    requestAnimationFrame(() => {
      tablistRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
    });
  }

  // Sessions of this workspace only; the app-level overview (step ⑤ of the
  // plan) is the cross-project surface.
  const reload = useCallback(async () => {
    try {
      const all = await api.terminalList();
      const mine = all.filter((s) => s.root === root);
      setSessions(mine);
      setActive((cur) => {
        if (cur !== null && mine.some((s) => s.id === cur)) return cur;
        // Prefer the tab the user last had active here (D69 path B) so it is the
        // one that resumes on view; fall back to the first tab if it is gone.
        const remembered = lastActiveTerminal(root);
        if (remembered !== null && mine.some((s) => s.id === remembered)) return remembered;
        return mine[0]?.id ?? null;
      });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [root]);

  // Remember the active tab per workspace (D69 path B): one effect captures
  // every way `active` changes (click, arrow-nav, launch, close-fallback), so
  // reopening the terminal page lands on — and resumes — the last-used tab.
  useEffect(() => {
    if (active !== null) rememberActiveTerminal(root, active);
  }, [active, root]);

  useEffect(() => {
    void reload();
    api
      .agentCatalogList()
      .then(setAgents)
      .catch((e) => setError(errorMessage(e)));
  }, [reload]);

  // Natural exits flip the tab chip; user closes go through closeSession.
  useEffect(() => {
    const unlisten = listen<TerminalExitPayload>(EXIT_EVENT, (ev) => {
      setSessions((cur) =>
        (cur ?? []).map((s) =>
          s.id === ev.payload.id ? { ...s, status: "exited", exitCode: ev.payload.exitCode } : s,
        ),
      );
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // A pop-out toggled (from this window or the pop-out itself, B16-C) — reload
  // so the session flips between its live pane and the "Popped out" placeholder.
  useEffect(() => {
    const unlisten = listen(SESSIONS_EVENT, () => void reload());
    return () => {
      void unlisten.then((f) => f());
    };
  }, [reload]);

  // Every accepted call spawns a real CLI process, so a double-click used to
  // leave two terminals behind (D65) — the reason this view grew its own ref
  // gate before the hook existed.
  function launch(agentId: string) {
    return run(async () => {
      setError(null);
      const name = identity.trim();
      const meta = await api.terminalLaunch(root, agentId, name === "" ? null : name);
      // Only a launch the backend accepted is worth remembering — a name it
      // rejected must not come back as a suggestion next time.
      rememberIdentity(name);
      setKnownIdentities(recentIdentities());
      setSessions((cur) => [...(cur ?? []), meta]);
      setActive(meta.id);
      onSessionsChanged?.();
    });
  }

  const doRevive = useCallback(
    async (s: TerminalSessionMeta) => {
      // In-place revive (D69): relaunch the agent into the SAME session id so
      // the tab keeps its slot (unlike the old B16-B path, which opened a new
      // id and dismissed the dead tab — the tab would jump). On success the tab
      // flips to running and the card → live-pane swap (a different element at
      // the same key) remounts a fresh xterm. `attemptedRevive` guards the
      // on-view auto-fire; a manual retry re-enters here directly.
      attemptedRevive.add(s.id);
      setReviving((cur) => ({ ...cur, [s.id]: "loading" }));
      try {
        const meta = await api.terminalRevive(s.id);
        setSessions((cur) => (cur ?? []).map((x) => (x.id === meta.id ? meta : x)));
        setReviving((cur) => {
          const next = { ...cur };
          delete next[s.id];
          return next;
        });
        onSessionsChanged?.();
      } catch (e) {
        // A failed resume stays failed until the human retries — no auto-retry
        // (the on-view guard already fired), so switching back does not re-spawn.
        setReviving((cur) => ({ ...cur, [s.id]: { error: errorMessage(e) } }));
      }
    },
    [onSessionsChanged],
  );

  // On-view lazy resume (D69): when a restored, resumable tab is the active
  // (visible) one, reattach its conversation automatically — once per app
  // session. NOT on boot: this view only exists while the terminal page is
  // open (it unmounts on navigation away), so "the tab is in view" is implied
  // by this component being mounted with that tab active. `agents` loads async,
  // so it is a dependency — the fire happens once it confirms resumability.
  useEffect(() => {
    if (activeSession === null || activeSession.status !== "restored") return;
    if (attemptedRevive.has(activeSession.id)) return;
    if (!agents.some((a) => a.id === activeSession.agentId && a.resumable)) return;
    void doRevive(activeSession);
  }, [activeSession, agents, doRevive]);

  async function popOut(s: TerminalSessionMeta) {
    // Render this session in its own OS window (B16-C). The session lives in
    // Rust and its output is broadcast to every window, so the pop-out is just
    // another renderer. Move semantics: mark it popped out so the main window
    // shows a placeholder rather than a second live pane (which would
    // double-feed the PTY).
    const label = `terminal-popout-${s.id}`;
    try {
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        await existing.setFocus();
        return;
      }
      await api.terminalSetPoppedOut(s.id, true);
      // Pin the native title bar from birth when the app theme is explicit —
      // boot-time applyThemeMode repaints it anyway, this only avoids a flash.
      const mode = getThemeMode();
      // Project first: the taskbar and alt-tab truncate from the *end*, and
      // every other part of this string is shared by every pop-out of the same
      // agent — a title that starts with "Claude Code" tells the user which
      // app the window belongs to and nothing they didn't already know.
      const project = projectName || baseName(root);
      const win = new WebviewWindow(label, {
        url: `index.html?popout=${s.id}`,
        title: `${project} · ${s.title} — Agent NextUp`,
        width: 900,
        height: 640,
        ...(mode === "system" ? {} : { theme: mode }),
      });
      void win.once("tauri://error", (e) => setError(String(e.payload)));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function dockBack(s: TerminalSessionMeta) {
    // Bring the session back into the main window by closing its pop-out
    // (whose close handler clears the flag); fall back to clearing it directly.
    const win = await WebviewWindow.getByLabel(`terminal-popout-${s.id}`);
    if (win) {
      await win.close();
    } else {
      await api.terminalSetPoppedOut(s.id, false).catch(() => {});
    }
  }

  // Disarm on a timer, and on moving to another tab. Both are the same rule:
  // the armed state is only meaningful while the intent behind it is still
  // present, and neither a four-second pause nor a trip to another session
  // leaves it there.
  useEffect(() => {
    if (confirmingClose === null) return;
    const timer = setTimeout(() => setConfirmingClose(null), CLOSE_ARM_MS);
    return () => clearTimeout(timer);
  }, [confirmingClose]);

  useEffect(() => {
    setConfirmingClose(null);
  }, [active]);

  async function closeSession(meta: TerminalSessionMeta) {
    // Closing a live process is destructive: two-step confirm, same pattern
    // as catalog deletes. Exited tabs dismiss immediately.
    if (meta.status === "running" && confirmingClose !== meta.id) {
      setConfirmingClose(meta.id);
      return;
    }
    setConfirmingClose(null);
    setError(null);
    try {
      await api.terminalClose(meta.id);
      setSessions((cur) => {
        const rest = (cur ?? []).filter((s) => s.id !== meta.id);
        setActive((a) => (a === meta.id ? (rest[0]?.id ?? null) : a));
        return rest;
      });
      onSessionsChanged?.();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="view view--term">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("term.heading")}</h1>
          <p className="view-sub">{t("term.subtitle")}</p>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="term-toolbar">
        <span className="muted">{t("term.launchLabel")}</span>
        {agents.map((agent) => (
          <button
            key={agent.id}
            className="btn btn-small"
            disabled={!agent.installed || launching}
            title={agent.installed ? [agent.command, ...agent.args].join(" ") : t("term.notInstalledTip")}
            onClick={() => void launch(agent.id)}
          >
            {agent.title}
          </button>
        ))}
        {/* Identity (D63) applies to the *next* launch, so it sits beside the
            buttons rather than inside a per-agent menu. Free text with a
            datalist of past names, because Agent NextUp has no identity registry to
            populate a real dropdown from — a name is whatever an agent
            reports, and inventing a roster here would imply otherwise. */}
        <span className="term-identity">
          <label className="muted" htmlFor="term-identity-input">
            {t("term.identityLabel")}
          </label>
          <input
            id="term-identity-input"
            list="term-identity-options"
            maxLength={64}
            value={identity}
            placeholder={t("term.identityPlaceholder")}
            onChange={(e) => setIdentity(e.target.value)}
          />
          <datalist id="term-identity-options">
            {knownIdentities.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </span>
      </div>
      <TeachingHint id="term-identity" className="term-identity-hint">
        {t("term.identityHint")}
      </TeachingHint>

      {sessions === null ? null : tabs.length === 0 ? (
        /* Wrapper, not a bare EmptyState: every direct child of `.view--term`
           is put on a centred, content-width track. The card wants its own
           460px, so as a direct child it either stretched to that track's full
           width or — once pinned to 460px — sat flush against the viewport
           edge while the header above it stayed centred. The wrapper takes the
           track; the card keeps its width and starts at the track's left edge,
           lining up with the toolbar. Removing this div reopens both bugs. */
        <div className="term-empty-slot">
          <EmptyState
            variant="guide"
            title={t("term.empty")}
            hint={t("term.manageAgents")}
            steps={[t("term.step1"), t("term.step2"), t("term.step3")]}
          />
        </div>
      ) : (
        <>
          <div className="term-tabs" role="tablist" aria-label={t("term.heading")} ref={tablistRef}>
            {tabs.map((s) => (
              /* role="tab" stays on the div rather than becoming a
                 <button>: the close button nests inside it, and a button
                 inside a button is invalid HTML. Instead this uses the
                 standard ARIA tabs pattern — roving tabindex (only the
                 selected tab is reachable by Tab) plus arrow keys to move
                 between tabs and switch immediately. This used to be the
                 only clickable thing in the whole app that wasn't a button,
                 so the keyboard could reach "close tab" but not "select
                 tab". */
              <div
                key={s.id}
                role="tab"
                tabIndex={active === s.id ? 0 : -1}
                aria-selected={active === s.id}
                className={`term-tab ${active === s.id ? "active" : ""} ${s.status !== "running" ? "exited" : ""}`}
                onClick={() => setActive(s.id)}
                onKeyDown={(e) => onTabKey(e, s.id)}
              >
                <span className="term-tab-title">{s.title}</span>
                {/* Which identity this session reports as — the tab is the
                    only place it stays visible once the CLI takes over. */}
                {s.identity !== null && (
                  <span className="chip term-tab-identity" title={t("term.identityLabel")}>
                    {s.identity}
                  </span>
                )}
                {s.status === "exited" && (
                  <span className="chip template-badge">
                    {s.exitCode !== null && s.exitCode !== 0
                      ? t("term.exitedWithCode", { n: s.exitCode })
                      : t("term.exited")}
                  </span>
                )}
                {s.status === "running" && !s.poppedOut && (
                  <button
                    className="term-tab-popout"
                    title={t("term.popOut")}
                    aria-label={t("term.popOutOf", { name: s.title })}
                    onClick={(e) => {
                      e.stopPropagation();
                      void popOut(s);
                    }}
                  >
                    <IconPopout size={12} />
                  </button>
                )}
                {/* Armed swaps the glyph, not just its colour: at 12px a red ×
                    and a grey × are one channel apart, and the row of tabs is
                    exactly where a colour-blind reader has no second cue. The
                    stop square also says what the next click does — it kills a
                    process, it does not dismiss a tab. */}
                <button
                  className={`term-tab-close${
                    s.status === "running" && confirmingClose === s.id
                      ? " term-tab-close--armed"
                      : ""
                  }`}
                  title={
                    s.status === "running" && confirmingClose === s.id
                      ? t("term.closeConfirm")
                      : t("term.closeTab")
                  }
                  aria-label={
                    s.status === "running" && confirmingClose === s.id
                      ? t("term.closeArmed", { name: s.title })
                      : t("term.closeTabOf", { name: s.title })
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeSession(s);
                  }}
                >
                  {s.status === "running" && confirmingClose === s.id ? (
                    <IconStopSquare size={12} />
                  ) : (
                    <IconX size={12} />
                  )}
                </button>
              </div>
            ))}
          </div>
          {confirmingClose !== null && (
            <p className="muted term-close-hint">{t("term.closeConfirm")}</p>
          )}
          <div className="term-pane-host">
            {tabs.map((s) => {
              if (s.poppedOut) {
                // Live pane lives in the pop-out window; here we only hold the
                // slot and offer to dock it back (B16-C move semantics).
                return (
                  <div
                    key={s.id}
                    className={`term-pane term-popped ${active === s.id ? "" : "term-pane-hidden"}`}
                    role="tabpanel"
                  >
                    <div className="term-popped-card">
                      <p className="muted">{t("term.poppedOut")}</p>
                      <button className="btn btn-small" onClick={() => void dockBack(s)}>
                        {t("term.dockBack")}
                      </button>
                    </div>
                  </div>
                );
              }
              if (s.status === "restored") {
                // D69: a restored tab keeps no scrollback — render a placeholder
                // card, never TerminalPane. When revive flips it to running the
                // element type changes at the same key, so React remounts a
                // fresh xterm (this is what avoids the stale-seq black screen,
                // G1). The card carries the on-view resume's loading/failure.
                const rv = reviving[s.id];
                return (
                  <div
                    key={s.id}
                    className={`term-pane term-restored-card ${active === s.id ? "" : "term-pane-hidden"}`}
                    role="tabpanel"
                  >
                    <div className="term-restored-inner">
                      {rv === "loading" ? (
                        <p className="muted">{t("term.resuming")}</p>
                      ) : rv ? (
                        <>
                          <p className="term-restored-title">{t("term.resumeFailed")}</p>
                          <p className="muted">{rv.error}</p>
                          <div className="term-restored-actions">
                            <button className="btn btn-small" onClick={() => void doRevive(s)}>
                              {t("term.retry")}
                            </button>
                            <button
                              className="btn btn-small btn-ghost"
                              onClick={() => void closeSession(s)}
                            >
                              {t("term.closeTab")}
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <p className="term-restored-title">
                            {t("term.restoredTitle", { agent: s.title })}
                          </p>
                          <p className="muted">{t("term.restoredHint")}</p>
                          <div className="term-restored-actions">
                            <button className="btn btn-small" onClick={() => void doRevive(s)}>
                              {t("term.resume")}
                            </button>
                            <button
                              className="btn btn-small btn-ghost"
                              onClick={() => void closeSession(s)}
                            >
                              {t("term.closeTab")}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              }
              // running or exited: the live/last pane, replayed from the
              // in-memory ring (which a restored tab does not have).
              return <TerminalPane key={s.id} meta={s} active={active === s.id} />;
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** One xterm instance bound to one session for this mount's lifetime.
 *  Inactive panes stay laid out (visibility:hidden) so xterm always has
 *  real dimensions and keeps rendering incoming output. Exported because the
 *  pop-out window (B16-C) reuses it — the session lives in Rust and its output
 *  is broadcast to every window, so this renderer is window-agnostic. */
export function TerminalPane({ meta, active }: { meta: TerminalSessionMeta; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      scrollback: 5000,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Whatever node this is, it must have no padding: FitAddon derives the row
    // count from its *border box* and only ever subtracts the terminal
    // element's own padding, so padding here silently becomes extra rows
    // (G060). `.term-pane` insets itself with `inset:` for that reason, and
    // src/styles.test.ts keeps it that way.
    term.open(node);
    termRef.current = term;
    fitRef.current = fit;

    // The one and only input path: focused-terminal keystrokes. Writes to an
    // exited session fail with kind "terminal" — expected, swallowed.
    const onData = term.onData((data) => {
      api.terminalWrite(meta.id, data).catch(() => {});
    });
    // Send size changes to the PTY only when cols/rows actually changed.
    const onResize = term.onResize(({ cols, rows }) => {
      api.terminalResize(meta.id, rows, cols).catch(() => {});
    });

    // Replay-then-stream without duplication: buffer events while the
    // snapshot is in flight, then drop everything at or below its seq.
    let lastSeq = 0;
    let ready = false;
    let disposed = false;
    const queue: TerminalOutputPayload[] = [];
    const apply = (p: TerminalOutputPayload) => {
      if (p.seq <= lastSeq) return;
      lastSeq = p.seq;
      term.write(p.data);
    };
    const unlisten = listen<TerminalOutputPayload>(OUTPUT_EVENT, (ev) => {
      if (ev.payload.id !== meta.id) return;
      if (!ready) {
        queue.push(ev.payload);
        return;
      }
      apply(ev.payload);
    });
    api
      .terminalReadBuffer(meta.id)
      .then((buf) => {
        if (disposed) return;
        lastSeq = buf.seq;
        if (buf.data) term.write(buf.data);
        ready = true;
        queue.forEach(apply);
        queue.length = 0;
      })
      .catch(() => {
        // Session vanished between list and mount (closed elsewhere) — the
        // tab is about to disappear with the next list refresh.
        ready = true;
      });

    return () => {
      disposed = true;
      void unlisten.then((f) => f());
      onData.dispose();
      onResize.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [meta.id]);

  // Fit on activation and on container resizes (only while visible: a
  // hidden pane keeps its last geometry, and fitting a 0-size box is what
  // breaks xterm layouts).
  useEffect(() => {
    const node = containerRef.current;
    if (!active || !node) return;
    let frame: number | undefined;
    const fitNow = () => {
      frame = undefined;
      // Laid out but collapsed (a window dragged to nothing, a pane mid-swap):
      // fitting that box pins the terminal to FitAddon's 2x1 minimum, and
      // growing back does not undo what the PTY was already told.
      if (node.clientHeight === 0 || node.clientWidth === 0) return;
      fitRef.current?.fit();
    };
    fitNow();
    // Focus belongs to *activation*, not to fitting. The observer below runs
    // on every frame of a window drag, and grabbing focus at that rate is its
    // own bug.
    termRef.current?.focus();
    const ro = new ResizeObserver(() => {
      // Refit on the next frame, NOT on a trailing debounce. The observer
      // fires continuously while the user drags a window edge, so a debounce
      // that waits for the resizing to *stop* pushes its own timer back every
      // tick and never runs for the whole gesture. Meanwhile xterm keeps
      // drawing the old `rows * cellHeight`, and .term-pane-host's
      // overflow:hidden slices the surplus row through the middle of the
      // glyphs (reported 2026-08-05: "the bottom line is cut in half").
      // rAF coalesces to at most one fit per painted frame, and FitAddon
      // itself no-ops unless the proposed cols/rows changed — so the PTY still
      // only hears from us when a whole row or column appears or disappears.
      if (frame !== undefined) return;
      frame = requestAnimationFrame(fitNow);
    });
    ro.observe(node);
    return () => {
      ro.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [active]);

  // Hand the IME its binding back after a window drag (reported 2026-08-05:
  // typing Chinese put the candidate window in the top-left corner of the
  // *screen*).
  //
  // Dragging the title bar or a window edge runs Windows' modal move/size
  // loop, and the webview comes out of it with its native input focus dropped:
  // not one `compositionstart` reaches the document afterwards, so this sits
  // upstream of anything xterm does with its helper textarea. Maximise/restore
  // is a click rather than a drag loop, and never breaks it.
  //
  // The repair has to be made at the same level the damage was. The DOM's own
  // idea of focus never changed — `document.activeElement` is still the
  // textarea throughout, and blurring and refocusing it was measured to do
  // nothing at all. `setFocus()` here is the *webview's*, not an element's:
  // on Windows it reaches ICoreWebView2Controller::MoveFocus, which is what a
  // real mouse click into the window does and a DOM focus() does not.
  //
  // Nothing about this is specific to the terminal — after a drag every input
  // in the window is in the same state. It only ever gets *reported* here
  // because every other input is reached by clicking it, and that click is the
  // repair; the terminal is the one surface whose focus is given
  // programmatically (see the fit effect above), so it is the one with nothing
  // left to click. For the same reason there is no `activeElement` guard: this
  // restores the window's focus, not any element's, so it cannot pull the caret
  // out of the identity field above.
  //
  // Trailing debounce, unlike the refit above: `tauri://move` fires for every
  // WM_MOVE of the gesture, and there is nothing to repair until it ends.
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        void getCurrentWebview()
          .setFocus()
          .catch(() => {});
      }, DRAG_SETTLE_MS);
    };
    // The current window, so the pop-out (which renders this same component)
    // listens to its own drags rather than the main window's.
    const win = getCurrentWindow();
    const unlisten = Promise.all([win.onMoved(settle), win.onResized(settle)]);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      void unlisten.then((fns) => fns.forEach((f) => f()));
    };
  }, [active]);

  return (
    <div
      ref={containerRef}
      className={`term-pane ${active ? "" : "term-pane-hidden"}`}
      role="tabpanel"
    />
  );
}
