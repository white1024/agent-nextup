import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { api, errorMessage } from "../api";
import { useGuardedMutation } from "../hooks";
import EmptyState from "../components/EmptyState";
import { IconArrowRight, IconPlus, IconPopout, IconSidebar, IconX } from "../components/icons";
import { workspaceName } from "../lib/format";
import {
  consoleWide,
  lastConsoleSession,
  recentIdentities,
  rememberConsoleSession,
  rememberIdentity,
  setConsoleWide,
} from "../lib/prefs";
import type { AgentInfo, TerminalSessionMeta, WorkspaceOverview } from "../types";
import TimeAgo from "../components/TimeAgo";
import PathLabel from "../components/PathLabel";
import { TerminalPane, dockBackSession, popOutSession, reviveSession } from "./Terminal";

/** How long the two-step close stays armed — the same window, and for the same
 *  reason, as the workspace terminal's `CLOSE_ARM_MS`: the protection in a
 *  two-step confirm is that the clicks are *close together*, so an indefinitely
 *  armed × is a single-click kill for whoever comes back ten minutes later. */
const CLOSE_ARM_MS = 4000;

/** What the stage may show for a selected session. */
export type StageKind = "none" | "in-window" | "not-running" | "live";

/**
 * Which of those a session gets — split out because one line of it is an
 * invariant rather than a style choice: **a popped-out session never gets a
 * pane.** Its own window already renders one, and two xterms on one PTY is not
 * a visual glitch — input splits between them, so half of what is typed goes
 * silently to the pane nobody is looking at.
 *
 * The *order* decides a narrower case: a session that exited while still
 * popped out. It is reported as being in its window rather than as stopped,
 * because that is the thing the user can act on — the window is still there.
 * Either order is safe (neither yields "live"); this one is chosen, so it is
 * pinned by a test rather than left to whoever edits next.
 */
export function stageKind(s: TerminalSessionMeta | null): StageKind {
  if (s === null) return "none";
  if (s.poppedOut) return "in-window";
  if (s.status !== "running") return "not-running";
  return "live";
}

/**
 * Which session the console lands on when it opens with nothing selected: the
 * one that was selected last time, if it can still take a pane, otherwise the
 * first that can.
 *
 * The usability check is the part that matters, and `stageKind` is asked
 * rather than reimplemented. A remembered id is only an id — by the time the
 * page reopens that session may have exited, or been popped into its own
 * window, and restoring it blind lands the user on an explanation card while
 * a perfectly good live session sits one row below.
 */
export function initialSelection(
  sessions: TerminalSessionMeta[],
  remembered: number | null,
): number | null {
  const usable = (s: TerminalSessionMeta) => stageKind(s) === "live";
  const back = sessions.find((s) => s.id === remembered && usable(s));
  return (back ?? sessions.find(usable))?.id ?? null;
}

interface Props {
  /** App-owned session list (same source as the sidebar markers); `null`
   *  until the first read resolves. */
  sessions: TerminalSessionMeta[] | null;
  /** Registry catalog — resolves a session root to its project name, and is
   *  the list of projects the launcher can start a session in. */
  overview: WorkspaceOverview[] | null;
  /** Open (or switch to) the workspace and land on its terminal view. */
  onOpen: (root: string) => void;
  /** A launch or close here changed the app-level session set. */
  onSessionsChanged: () => void;
}

/**
 * App-level agent console (D50 ③, reshaped by D132): every terminal session
 * across every project, **operable from here** — pick one and it runs in the
 * pane beside the list, pop it into its own window, close it, or start a new
 * one in any project without opening that project first.
 *
 * Three boundaries this page deliberately keeps:
 *
 * - **One live pane, not a grid.** D67 ② rejected a split view inside the app
 *   window and chose pop-out instead: a rich TUI (Claude Code is one) breaks
 *   below a certain width, and tiling would mean owning a layout engine. So
 *   "several at once" means several *windows* — and the button for that is
 *   here now, which it was not before.
 * - **Nothing is typed on anyone's behalf.** The only PTY input path is a real
 *   keystroke in a focused xterm (D50 ②, which is D14's refinement). This page
 *   adds surfaces that *reach* sessions; it adds no way to feed them.
 * - **Reviving is offered, never fired.** D69's automatic on-view resume stays
 *   in the workspace terminal, where "the tab is in view" is what the mount
 *   means. Here a restored session gets a button, and both paths go through
 *   the same `reviveSession` so they share one record of "already tried" —
 *   two records is how one dead session gets relaunched twice (D133).
 */
export default function AgentSessions({ sessions, overview, onOpen, onSessionsChanged }: Props) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<number | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [launchRoot, setLaunchRoot] = useState<string>("");
  const [identity, setIdentity] = useState(() => recentIdentities()[0] ?? "");
  const [knownIdentities, setKnownIdentities] = useState<string[]>(() => recentIdentities());
  const [confirmingClose, setConfirmingClose] = useState<number | null>(null);
  /** Root whose in-group launch row is expanded, if any. */
  const [launchOpen, setLaunchOpen] = useState<string | null>(null);
  /** In-flight / failed revives, keyed by session id — per session, not one
   *  banner, so one failure never masks another's state. */
  const [reviving, setReviving] = useState<Record<number, "loading" | { error: string }>>({});
  /** List folded away so the pane has the whole width. */
  const [wide, setWide] = useState(() => consoleWide());
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useGuardedMutation(setError);

  const groups = useMemo(() => {
    const byRoot = new Map<string, TerminalSessionMeta[]>();
    for (const s of sessions ?? []) {
      const list = byRoot.get(s.root);
      if (list) list.push(s);
      else byRoot.set(s.root, [s]);
    }
    return [...byRoot.entries()];
  }, [sessions]);

  const nameOf = useCallback((root: string) => workspaceName(overview, root), [overview]);

  /** Projects a session can be started in: everything the registry still finds
   *  on disk. Deliberately *not* only the projects that already have one —
   *  "start one somewhere new" is half of what this page is for. */
  const launchable = useMemo(() => (overview ?? []).filter((w) => w.exists), [overview]);

  useEffect(() => {
    api
      .agentCatalogList()
      .then(setAgents)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  // Seed the launcher with a project that already has a session, so the common
  // case — a second agent alongside one already running — is one click.
  useEffect(() => {
    if (launchRoot !== "" || launchable.length === 0) return;
    // groups entries are [root, sessions] — element 0 is already the root.
    setLaunchRoot(groups[0]?.[0] ?? launchable[0].root);
  }, [groups, launchable, launchRoot]);

  // Land on something live rather than an empty pane, preferring whatever was
  // selected last time — coming back to this page should be coming back, not
  // starting over. Only ever fills an *empty* selection: re-running on every
  // list refresh would yank the pane out from under someone mid-session.
  useEffect(() => {
    if (selected !== null || sessions === null) return;
    const pick = initialSelection(sessions, lastConsoleSession());
    if (pick !== null) setSelected(pick);
  }, [sessions, selected]);

  useEffect(() => {
    if (selected !== null) rememberConsoleSession(selected);
  }, [selected]);

  // Disarm the two-step close on a timer rather than leaving it armed.
  useEffect(() => {
    if (confirmingClose === null) return;
    const timer = window.setTimeout(() => setConfirmingClose(null), CLOSE_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [confirmingClose]);

  // A pop-out toggled anywhere (this window, or the pop-out closing itself)
  // changes which sessions may render here. App reloads the list on the same
  // event, so all this has to do is drop a half-armed close.
  useEffect(() => {
    const unlisten = listen("terminal://sessions", () => setConfirmingClose(null));
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const selectedSession = (sessions ?? []).find((s) => s.id === selected) ?? null;

  function toggleWide() {
    const next = !wide;
    setWide(next);
    setConsoleWide(next);
  }

  /** Reattach a restored session's conversation (D69), on a button rather than
   *  on view: the workspace terminal owns the automatic firing, and two
   *  surfaces racing to relaunch one dead session is what that would be. */
  async function revive(s: TerminalSessionMeta) {
    setReviving((cur) => ({ ...cur, [s.id]: "loading" }));
    try {
      await reviveSession(s.id);
      setReviving((cur) => {
        const next = { ...cur };
        delete next[s.id];
        return next;
      });
      setSelected(s.id);
      onSessionsChanged();
    } catch (e) {
      // A failed resume stays failed until the human retries — no auto-retry,
      // so returning to this page does not re-spawn anything.
      setReviving((cur) => ({ ...cur, [s.id]: { error: errorMessage(e) } }));
    }
  }

  function launch(root: string, agentId: string) {
    if (root === "") return;
    return run(async () => {
      setError(null);
      const name = identity.trim();
      const meta = await api.terminalLaunch(root, agentId, name === "" ? null : name);
      // Only a launch the backend accepted is worth remembering — a name it
      // rejected must not come back as a suggestion next time.
      rememberIdentity(name);
      setKnownIdentities(recentIdentities());
      setSelected(meta.id);
      setLaunchOpen(null);
      onSessionsChanged();
    });
  }

  async function togglePopOut(s: TerminalSessionMeta) {
    setError(null);
    try {
      if (s.poppedOut) await dockBackSession(s.id);
      else await popOutSession(s, nameOf(s.root), setError);
      onSessionsChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function closeSession(s: TerminalSessionMeta) {
    // Killing a live CLI process is destructive, so it takes two clicks; an
    // already-exited row is only a dismissal and goes straight through.
    if (s.status === "running" && confirmingClose !== s.id) {
      setConfirmingClose(s.id);
      return;
    }
    setConfirmingClose(null);
    setError(null);
    try {
      await api.terminalClose(s.id);
      if (selected === s.id) setSelected(null);
      onSessionsChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** What the stage beside the list shows for the current selection. */
  function stage(s: TerminalSessionMeta | null) {
    switch (stageKind(s)) {
      case "none":
        return <EmptyState title={t("agentsView.pickTitle")} hint={t("agentsView.pickHint")} />;
      case "in-window":
        return (
          <EmptyState
            title={t("agentsView.inWindowTitle")}
            hint={t("agentsView.inWindowHint")}
            action={{ label: t("term.dockBack"), onClick: () => void togglePopOut(s!) }}
          />
        );
      case "not-running":
        return notRunningStage(s!);
    }
    // `.term-pane-host` is not decoration: `.term-pane` is `position:absolute`
    // with an `inset`, so it needs exactly this positioned, overflow-hidden,
    // real-height box around it — the one whose geometry contract
    // src/styles.test.ts guards (G060). Reusing the class rather than styling
    // a second host is what keeps that guard covering this page too.
    return (
      <div className="term-pane-host">
        <TerminalPane
          key={s!.id}
          meta={s!}
          active
          role="region"
          label={`${nameOf(s!.root)} · ${s!.title}`}
        />
      </div>
    );
  }

  /** A session with no process behind it. A *restored* one whose CLI supports
   *  resuming gets the reattach button (D69) — offered here rather than fired
   *  on view, because the workspace terminal owns the automatic firing and two
   *  surfaces racing to relaunch one dead session is what sharing it means. */
  function notRunningStage(s: TerminalSessionMeta) {
    const state = reviving[s.id];
    if (state === "loading") return <EmptyState title={t("term.resuming")} />;
    const resumable =
      s.status === "restored" && agents.some((a) => a.id === s.agentId && a.resumable);
    if (resumable) {
      return (
        <EmptyState
          title={t("term.restoredTitle", { agent: s.title })}
          hint={
            typeof state === "object"
              ? `${t("term.resumeFailed")}: ${state.error}`
              : t("term.restoredHint")
          }
          action={{
            label: typeof state === "object" ? t("term.retry") : t("term.resume"),
            onClick: () => void revive(s),
            primary: true,
          }}
        />
      );
    }
    return (
      <EmptyState
        title={t("agentsView.notRunningTitle")}
        hint={t("agentsView.notRunningHint")}
        action={{ label: t("agentsView.goToTerminal"), onClick: () => onOpen(s.root) }}
      />
    );
  }

  return (
    <div className="view view--agents">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("agentsView.heading")}</h1>
          <p className="view-sub">{t("agentsView.subtitle")}</p>
        </div>
        <div className="header-actions">
          <button className="btn" aria-pressed={wide} onClick={toggleWide}>
            <IconSidebar size={15} />
            {wide ? t("agentsView.showList") : t("agentsView.hideList")}
          </button>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Launcher. Identity applies to the *next* launch, exactly as in the
          workspace terminal — same control, same placement relative to the
          agent buttons, so the two surfaces do not teach different habits. */}
      <div className="term-toolbar agents-launcher">
        <label className="muted" htmlFor="agents-launch-root">
          {t("agentsView.launchIn")}
        </label>
        <select
          id="agents-launch-root"
          className="agents-launch-project"
          value={launchRoot}
          disabled={busy || launchable.length === 0}
          onChange={(e) => setLaunchRoot(e.target.value)}
        >
          {launchable.map((w) => (
            <option key={w.root} value={w.root}>
              {w.name}
            </option>
          ))}
        </select>
        {agents.map((agent) => (
          <button
            key={agent.id}
            className="btn btn-small"
            disabled={!agent.installed || busy || launchRoot === ""}
            title={
              agent.installed ? [agent.command, ...agent.args].join(" ") : t("term.notInstalledTip")
            }
            onClick={() => void launch(launchRoot, agent.id)}
          >
            {agent.title}
          </button>
        ))}
        <span className="term-identity">
          <label className="muted" htmlFor="agents-identity-input">
            {t("term.identityLabel")}
          </label>
          <input
            id="agents-identity-input"
            list="agents-identity-options"
            maxLength={64}
            value={identity}
            placeholder={t("term.identityPlaceholder")}
            onChange={(e) => setIdentity(e.target.value)}
          />
          <datalist id="agents-identity-options">
            {knownIdentities.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </span>
      </div>

      {sessions === null ? null : groups.length === 0 ? (
        <EmptyState title={t("agentsView.empty")} hint={t("agentsView.emptyHint")} />
      ) : (
        <div className={`agents-split ${wide ? "agents-split--wide" : ""}`}>
          <div className="agents-list">
            {groups.map(([root, list]) => (
              <section className="panel agents-group" key={root}>
                <div className="panel-head">
                  <h2 className="panel-title">{nameOf(root)}</h2>
                  {/* Two different things, which used to be one button labelled
                      as the one it wasn't: starting a session happens here,
                      and only *going to that project's page* navigates. */}
                  <span className="agents-group-actions">
                    <button
                      className="btn btn-small"
                      aria-expanded={launchOpen === root}
                      disabled={busy}
                      onClick={() => setLaunchOpen((cur) => (cur === root ? null : root))}
                    >
                      <IconPlus size={14} /> {t("agentsView.startHere")}
                    </button>
                    <button className="btn btn-small" onClick={() => onOpen(root)}>
                      <IconArrowRight size={14} /> {t("agentsView.goToTerminal")}
                    </button>
                  </span>
                </div>
                <PathLabel className="ws-card-path" path={root} />
                {/* A disclosure, not a menu: the agent list is the same row of
                    buttons as the toolbar above, so it needs no menu semantics
                    of its own — and every entry stays reachable by Tab. */}
                {launchOpen === root && (
                  <div className="term-toolbar agents-group-launch">
                    <span className="muted">{t("term.launchLabel")}</span>
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        className="btn btn-small"
                        disabled={!agent.installed || busy}
                        title={
                          agent.installed
                            ? [agent.command, ...agent.args].join(" ")
                            : t("term.notInstalledTip")
                        }
                        onClick={() => void launch(root, agent.id)}
                      >
                        {agent.title}
                      </button>
                    ))}
                  </div>
                )}
                <div className="key-list">
                  {list.map((s) => (
                    <div
                      className={`key-item agents-row ${selected === s.id ? "selected" : ""}`}
                      key={s.id}
                    >
                      <button
                        className="agents-row-pick"
                        aria-pressed={selected === s.id}
                        onClick={() => setSelected(s.id)}
                      >
                        <span className="agents-row-title">{s.title}</span>
                        <span className="agents-row-chips">
                          {/* Who this session reports as (D63). Without it two
                              rows in the same project read identically — same
                              CLI, same status, same "started last week" — and
                              the data was already on the wire (r2 3-2).
                              Anonymous is rendered rather than left blank: "no
                              identity" is an answer, and it is the one that
                              cannot claim tasks. */}
                          <span
                            className={`chip term-tab-identity${s.identity === null ? " is-anon" : ""}`}
                            title={t("term.identityLabel")}
                          >
                            {s.identity ?? t("term.identityAnon")}
                          </span>
                          {s.status === "running" ? (
                            <span className="chip chip-term-running">
                              <span className="dot" aria-hidden="true" />
                              {t("agentsView.running")}
                            </span>
                          ) : s.status === "restored" ? (
                            <span className="chip template-badge">{t("term.restored")}</span>
                          ) : (
                            <span className="chip template-badge">
                              {s.exitCode !== null && s.exitCode !== 0
                                ? t("term.exitedWithCode", { n: s.exitCode })
                                : t("term.exited")}
                            </span>
                          )}
                          {s.poppedOut && (
                            <span className="chip template-badge">{t("agentsView.inWindow")}</span>
                          )}
                        </span>
                        <span className="tpl-row-meta muted">
                          {t("agentsView.startedAt")} <TimeAgo at={s.startedAt} />
                        </span>
                      </button>
                      <span className="agents-row-actions">
                        {s.status === "running" && (
                          <button
                            className="btn btn-ghost btn-icon"
                            title={s.poppedOut ? t("term.dockBack") : t("term.popOut")}
                            aria-label={s.poppedOut ? t("term.dockBack") : t("term.popOut")}
                            onClick={() => void togglePopOut(s)}
                          >
                            <IconPopout size={13} />
                          </button>
                        )}
                        <button
                          className="btn btn-ghost btn-icon danger-trigger"
                          title={
                            confirmingClose === s.id
                              ? t("agentsView.closeConfirm")
                              : s.status === "running"
                                ? t("agentsView.close")
                                : t("agentsView.dismiss")
                          }
                          aria-label={
                            confirmingClose === s.id
                              ? t("agentsView.closeConfirm")
                              : t("agentsView.close")
                          }
                          onClick={() => void closeSession(s)}
                        >
                          {confirmingClose === s.id ? (
                            <span className="agents-confirm">{t("agentsView.closeConfirmMark")}</span>
                          ) : (
                            <IconX size={13} />
                          )}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div className="agents-stage">{stage(selectedSession)}</div>
        </div>
      )}
    </div>
  );
}
