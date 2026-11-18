import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { api, errorMessage } from "../../api";
import { useGuardedMutation } from "../../hooks";
import { useProjectsActivity } from "../../hooks/useProjectsActivity";
import EmptyState from "../../components/EmptyState";
import ErrorBar from "../../components/ErrorBar";
import HubOrbit, { type HubHandle, type HubState, type OrbitSession } from "../../components/HubOrbit";
import IdentityField from "../../components/IdentityField";
import InfoTip from "../../components/InfoTip";
import PathLabel from "../../components/PathLabel";
import TermCard, { retractErrorThen } from "../../components/TermCard";
import TimeAgo from "../../components/TimeAgo";
import {
  IconArrowRight,
  IconPlay,
  IconPlus,
  IconPopout,
  IconSidebar,
  IconTrash,
  IconX,
} from "../../components/icons";
import { centreOf, motionOff } from "../../lib/fx";
import { normRoot } from "../../lib/exchange";
import { workspaceName } from "../../lib/format";
import {
  consoleWide,
  lastConsoleSession,
  recentIdentities,
  rememberConsoleSession,
  rememberIdentity,
  setConsoleWide,
} from "../../lib/prefs";
import { sessionLabel, shortName, waitKey, waitingKeys } from "../../lib/sessions";
import type { AgentInfo, TerminalSessionMeta, WorkspaceOverview } from "../../types";
import { TerminalPane, dockBackSession, popOutSession, reviveSession } from "../Terminal";
import { fadeOutPicture, launchLight, layoutOf, settleLayout, type Layout } from "./motion";

/** How long the two-step close stays armed — the same window, and for the same
 *  reason, as the workspace terminal's `CLOSE_ARM_MS`: the protection in a
 *  two-step confirm is that the clicks are *close together*, so an indefinitely
 *  armed × is a single-click kill for whoever comes back ten minutes later. */
const CLOSE_ARM_MS = 4000;

/** The page's entrance (spec 40: head, hub, bar 600 ms; groups and stage 640
 *  ms after 140) runs once per visit, then the class comes off so a later
 *  re-render never replays it. */
const ENTER_MS = 900;

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

/**
 * The project the launch bar starts sessions in. It must always be one the
 * project picker lists — the picker can only *show* its own options, so a
 * target outside them is displayed as some other project while the buttons
 * launch into the hidden one (2026-11-12: a stale session in a project the
 * registry no longer finds seeded it, and three shells opened in the wrong
 * folder under a picker naming a different one).
 *
 * Keeps `current` while it is listed; otherwise the first project that already
 * has a session (the common case is a second agent beside a running one),
 * otherwise the first listed. Roots compare normalised — the session list and
 * the registry do not spell paths the same way.
 */
export function launchTarget(sessionRoots: string[], listed: string[], current: string): string {
  const key = new Map(listed.map((r) => [normRoot(r), r]));
  if (current !== "" && key.has(normRoot(current))) return key.get(normRoot(current))!;
  for (const r of sessionRoots) {
    const hit = key.get(normRoot(r));
    if (hit !== undefined) return hit;
  }
  return listed[0] ?? "";
}

interface Props {
  /** App-owned session list (same source as the sidebar markers); `null`
   *  until the first read resolves. */
  sessions: TerminalSessionMeta[] | null;
  /** Registry catalog — resolves a session root to its project name, and is
   *  the list of projects the launcher can start a session in. */
  overview: WorkspaceOverview[] | null;
  /** Open (or switch to) the workspace and land on its terminal view. `from`
   *  is what the page change grows out of (C27 / C291). */
  onOpen: (root: string, from?: Element | null) => void;
  /** A launch or close here changed the app-level session set. */
  onSessionsChanged: () => void;
}

/** A launch whose new session has not reached the list yet. */
interface PendingLaunch {
  id: number;
  before: Layout;
  /** The in-group launch row it was started from, if one was open. */
  row: HTMLElement | null;
  /** The list was empty, so the whole split is new (C224 rather than C293). */
  first: boolean;
}

/**
 * App-level agent console (D50 ③, reshaped by D132; D153 design, spec 40):
 * every terminal session across every project, **operable from here** — pick
 * one and it runs in the pane beside the list, pop it into its own window,
 * close it, or start a new one in any project without opening that project
 * first. The hub above it circles the running ones.
 *
 * Three boundaries this page deliberately keeps:
 *
 * - **One live pane, not a grid.** D67 ② rejected a split view inside the app
 *   window and chose pop-out instead: a rich TUI (Claude Code is one) breaks
 *   below a certain width, and tiling would mean owning a layout engine. So
 *   "several at once" means several *windows* — and the button for that is
 *   here.
 * - **Nothing is typed on anyone's behalf.** The only PTY input path is a real
 *   keystroke in a focused xterm (D50 ②, which is D14's refinement). This page
 *   adds surfaces that *reach* sessions; it adds no way to feed them.
 * - **Reviving is offered, never fired.** D69's automatic on-view resume stays
 *   in the workspace terminal, where "the tab is in view" is what the mount
 *   means. Here a restored session gets a button, and both paths go through
 *   the same `reviveSession` so they share one record of "already tried" —
 *   two records is how one dead session gets relaunched twice (D133).
 *
 * "Hide list" folds the hub away too (D156 ①): the pane fills what is left of
 * the window's height, and at the 640 px minimum the hub's 200 px would leave
 * the terminal a quarter of the window. One button gives the whole page back.
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
  /** List (and hub) folded away so the pane has the whole page. */
  const [wide, setWide] = useState(() => consoleWide());
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useGuardedMutation(setError);
  const [enter, setEnter] = useState(true);
  /** Chips kept back until the launch light lands on them. */
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  /** The row that just arrived (slides in), and whether it made the list. */
  const [fresh, setFresh] = useState<{ id: number; first: boolean } | null>(null);

  const hubRef = useRef<HubHandle>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const stageBodyRef = useRef<HTMLDivElement>(null);
  const launchRows = useRef(new Map<string, HTMLDivElement>());
  const pending = useRef<PendingLaunch | null>(null);
  /** Set by a pick, so the stage swap plays for a choice and never for a
   *  watcher re-read. */
  const swapNext = useRef(false);

  const activity = useProjectsActivity(true);

  useEffect(() => {
    const id = window.setTimeout(() => setEnter(false), ENTER_MS);
    return () => window.clearTimeout(id);
  }, []);

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
  const anon = t("term.identityAnon");

  /** Projects a session can be started in: everything the registry still finds
   *  on disk. Deliberately *not* only the projects that already have one —
   *  "start one somewhere new" is half of what this page is for. */
  const launchable = useMemo(() => (overview ?? []).filter((w) => w.exists), [overview]);

  const running = (sessions ?? []).filter((s) => s.status === "running");
  const waitSet = waitingKeys(activity);
  const orbit: OrbitSession[] = running.map((s) => ({
    id: String(s.id),
    label: sessionLabel(s, anon),
    project: shortName(nameOf(s.root)),
    waiting: waitSet.has(waitKey(s.root, s.identity)),
  }));
  const hubState: HubState = sessions === null ? "loading" : running.length === 0 ? "empty" : "live";

  useEffect(() => {
    api
      .agentCatalogList()
      .then(setAgents)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  // Keep the launcher on a project the picker lists (see `launchTarget`),
  // seeded with one that already has a session.
  useEffect(() => {
    const next = launchTarget(
      groups.map(([root]) => root),
      launchable.map((w) => w.root),
      launchRoot,
    );
    if (next !== launchRoot) setLaunchRoot(next);
  }, [groups, launchable, launchRoot]);

  // Land on something live rather than an empty pane, preferring whatever was
  // selected last time — coming back to this page should be coming back, not
  // starting over. Only ever fills an *empty* selection: re-running on every
  // list refresh would yank the pane out from under someone mid-session.
  useEffect(() => {
    if (selected !== null || sessions === null || pending.current !== null) return;
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

  // C293 / C224, the list half: once the launched session is in the list, the
  // open launch row folds (its picture fades where it stood), the new row is
  // selected, and every group and the stage slide from where they were when
  // the button was pressed. State set in a layout effect renders again before
  // paint, so nothing is ever seen in between.
  useLayoutEffect(() => {
    const p = pending.current;
    if (p === null || !(sessions ?? []).some((s) => s.id === p.id)) return;
    if (launchOpen !== null || selected !== p.id) {
      if (launchOpen !== null) fadeOutPicture(p.row, 160);
      swapNext.current = true;
      setLaunchOpen(null);
      setSelected(p.id);
      setFresh({ id: p.id, first: p.first });
      return;
    }
    pending.current = null;
    if (!p.first) settleLayout(splitRef.current, p.before, 360);
  }, [sessions, launchOpen, selected]);

  useEffect(() => {
    if (fresh === null) return;
    const id = window.setTimeout(() => setFresh(null), 1500);
    return () => window.clearTimeout(id);
  }, [fresh]);

  // C28 on this page: picking another session re-plays the stage's content.
  // A class the DOM carries, not one React renders — React would otherwise
  // need a key change to restart it, and a key change remounts the xterm.
  useLayoutEffect(() => {
    if (!swapNext.current) return;
    swapNext.current = false;
    const el = stageBodyRef.current;
    if (el === null || motionOff()) return;
    el.classList.remove("swap");
    void el.offsetWidth;
    el.classList.add("swap");
    const id = window.setTimeout(() => el.classList.remove("swap"), 700);
    return () => window.clearTimeout(id);
  }, [selected]);

  const selectedSession = (sessions ?? []).find((s) => s.id === selected) ?? null;

  function pick(id: number) {
    if (id === selected) return;
    swapNext.current = true;
    setSelected(id);
  }

  function toggleWide() {
    const next = !wide;
    setWide(next);
    setConsoleWide(next);
  }

  /** C290: one group's launch row opens, closes, or moves to another group;
   *  the old one fades where it stood and everything below slides. */
  function toggleLaunch(root: string) {
    const before = layoutOf(splitRef.current);
    if (launchOpen !== null) fadeOutPicture(launchRows.current.get(launchOpen) ?? null);
    flushSync(() => setLaunchOpen((cur) => (cur === root ? null : root)));
    settleLayout(splitRef.current, before);
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

  function launch(root: string, agentId: string, button: HTMLElement) {
    if (root === "") return;
    const from = centreOf(button);
    const before = layoutOf(splitRef.current);
    const row = launchOpen !== null ? (launchRows.current.get(launchOpen) ?? null) : null;
    const first = groups.length === 0;
    return run(async () => {
      setError(null);
      const name = identity.trim();
      const meta = await api.terminalLaunch(root, agentId, name === "" ? null : name);
      // Only a launch the backend accepted is worth remembering — a name it
      // rejected must not come back as a suggestion next time.
      rememberIdentity(name);
      setKnownIdentities(recentIdentities());
      const chip = String(meta.id);
      if (!motionOff()) setHeld((h) => new Set(h).add(chip));
      pending.current = { id: meta.id, before, row, first };
      onSessionsChanged();
      launchLight(from, hubRef.current, chip, () =>
        setHeld((h) => {
          const next = new Set(h);
          next.delete(chip);
          return next;
        }),
      );
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

  /** The dark slot every card sits in — the terminal's own surface, in both
   *  themes (spec 40: all four stage cards are drawn on it). */
  const rest = (card: ReactNode) => <div className="term-pane-host term-rest">{card}</div>;

  /** What the stage beside the list shows for the current selection. */
  function stage(s: TerminalSessionMeta | null) {
    switch (stageKind(s)) {
      case "none":
        return rest(<TermCard title={t("agentsView.pickTitle")} hint={t("agentsView.pickHint")} />);
      case "in-window":
        return rest(
          <TermCard title={t("agentsView.inWindowTitle")} hint={t("agentsView.inWindowHint")}>
            <button className="btn btn-small" onClick={() => void togglePopOut(s!)}>
              <IconPopout size={13} />
              {t("term.dockBack")}
            </button>
          </TermCard>,
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
    if (state === "loading") return rest(<TermCard title={t("term.resuming")} />);
    const resumable =
      s.status === "restored" && agents.some((a) => a.id === s.agentId && a.resumable);
    if (resumable) {
      const failed = typeof state === "object";
      return rest(
        <TermCard
          title={t("term.restoredTitle", { agent: s.title })}
          hint={t("term.restoredHint")}
          error={failed ? `${t("term.resumeFailed")}: ${state.error}` : null}
        >
          <button
            className="btn btn-small btn-primary"
            onClick={(e) => retractErrorThen(e.currentTarget, () => void revive(s))}
          >
            {failed ? t("term.retry") : t("term.resume")}
          </button>
        </TermCard>,
      );
    }
    return rest(
      <TermCard title={t("agentsView.notRunningTitle")} hint={t("agentsView.notRunningHint")}>
        <button className="btn btn-small" onClick={() => onOpen(s.root, stageRef.current)}>
          {t("agentsView.goToTerminal")}
          <IconArrowRight size={13} />
        </button>
      </TermCard>,
    );
  }

  function statusChip(s: TerminalSessionMeta) {
    if (s.status === "running") {
      return (
        <span className="chip run">
          <span className="dot" aria-hidden="true" />
          {t("agentsView.running")}
        </span>
      );
    }
    if (s.status === "restored") return <span className="chip">{t("term.restored")}</span>;
    return (
      <span className="chip">
        {s.exitCode !== null && s.exitCode !== 0
          ? t("term.exitedWithCode", { n: s.exitCode })
          : t("term.exited")}
      </span>
    );
  }

  /** The CLI buttons, for the bar on top and for a group's own row. The bar's
   *  carry ▷; a group's carry names only (spec 40 keeps the two that way). */
  function agentButtons(root: string, withIcon: boolean) {
    return agents.map((agent) => (
      <button
        key={agent.id}
        className="btn btn-small"
        disabled={!agent.installed || busy || root === ""}
        title={agent.installed ? [agent.command, ...agent.args].join(" ") : t("term.notInstalledTip")}
        onClick={(e) => void launch(root, agent.id, e.currentTarget)}
      >
        {withIcon && <IconPlay size={11} />}
        {agent.title}
      </button>
    ));
  }

  const split = fresh?.first ? " is-first" : "";

  return (
    <div className={`view view--agents${enter ? " ag-enter" : ""}`}>
      <header className="view-header ag-head">
        <div className="vh-main">
          <h1>{t("agentsView.heading")}</h1>
          <p className="view-sub">{t("agentsView.subtitle")}</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-ghost btn-small" aria-pressed={wide} onClick={toggleWide}>
            <IconSidebar size={15} />
            {wide ? t("agentsView.showList") : t("agentsView.hideList")}
          </button>
        </div>
      </header>

      <ErrorBar error={error} />

      {!wide && (
        <HubOrbit ref={hubRef} sessions={orbit} state={hubState} className="ag-hub" hidden={held} />
      )}

      {/* Launcher. Identity applies to the *next* launch, exactly as in the
          workspace terminal — same control, same placement relative to the
          agent buttons, so the two surfaces do not teach different habits. */}
      <div className="panel lb">
        <span className="lb-l">
          <label htmlFor="agents-launch-root">{t("agentsView.launchIn")}</label>
          <InfoTip label={t("term.manageLabel")}>{t("term.manageAgents")}</InfoTip>
        </span>
        <select
          id="agents-launch-root"
          className="lb-root"
          value={launchRoot}
          disabled={busy || launchable.length === 0}
          onChange={(e) => setLaunchRoot(e.target.value)}
        >
          {launchable.map((w) => (
            <option key={w.root} value={w.root}>
              {shortName(w.name)}
            </option>
          ))}
        </select>
        {agentButtons(launchRoot, true)}
        <IdentityField
          id="agents-identity"
          value={identity}
          onChange={setIdentity}
          options={knownIdentities}
        />
      </div>

      {sessions === null ? null : groups.length === 0 ? (
        <EmptyState title={t("agentsView.empty")} hint={t("agentsView.emptyHint")} />
      ) : (
        <div ref={splitRef} className={`agents-split${wide ? " agents-split--wide" : ""}${split}`}>
          <div className="agents-list">
            {groups.map(([root, list]) => (
              <section className="panel ag-g" key={root} data-row={root}>
                <div className="ag-gh">
                  <h2 className="ag-gn" title={nameOf(root)}>
                    {nameOf(root)}
                  </h2>
                  {/* Two different things, which used to be one button labelled
                      as the one it wasn't: starting a session happens here,
                      and only *going to that project's page* navigates. */}
                  <span className="ag-acts">
                    <button
                      className="btn btn-ghost btn-small"
                      aria-expanded={launchOpen === root}
                      disabled={busy}
                      onClick={() => toggleLaunch(root)}
                    >
                      <IconPlus size={14} /> {t("agentsView.startHere")}
                    </button>
                    <button
                      className="btn btn-ghost btn-small"
                      onClick={(e) => onOpen(root, e.currentTarget.closest(".ag-g"))}
                    >
                      <IconArrowRight size={14} /> {t("agentsView.goToTerminal")}
                    </button>
                  </span>
                </div>
                <PathLabel className="ag-path" path={root} />
                {/* A disclosure, not a menu: the agent list is the same row of
                    buttons as the bar above, so it needs no menu semantics of
                    its own — and every entry stays reachable by Tab. */}
                {launchOpen === root && (
                  <div
                    className="ag-launch"
                    ref={(el) => {
                      if (el) launchRows.current.set(root, el);
                      else launchRows.current.delete(root);
                    }}
                  >
                    <span className="ag-launch-l">{t("term.launchLabel")}</span>
                    {agentButtons(root, false)}
                  </div>
                )}
                <ul className="ag-rows" data-list={root}>
                  {list.map((s) => {
                    const on = selected === s.id;
                    const arming = confirmingClose === s.id;
                    const isFresh = fresh?.id === s.id;
                    const label = sessionLabel(s, anon);
                    return (
                      <li
                        className={`ag-r${on ? " on" : ""}${isFresh ? " is-fresh" : ""}`}
                        key={s.id}
                      >
                        <button className="ag-pick" aria-pressed={on} onClick={() => pick(s.id)}>
                          <span className="ag-t">
                            {s.status === "running" ? (
                              <i className={`dot-run${motionOff() ? "" : " amb"}`} aria-hidden="true" />
                            ) : (
                              <i className="mk-o" aria-hidden="true" />
                            )}
                            {/* Who this session reports as (D63) is part of its
                                name: without it two rows in the same project
                                read identically. Anonymous is said, not left
                                blank — it is the one that cannot claim tasks. */}
                            <span className="ag-tn" title={label}>
                              {label}
                            </span>
                          </span>
                          <span className="ag-chips">
                            {statusChip(s)}
                            {s.poppedOut && (
                              <span className="chip">
                                <IconPopout size={11} />
                                {t("agentsView.inWindow")}
                              </span>
                            )}
                          </span>
                          <span className="ag-at">
                            {t("agentsView.startedAt")} <TimeAgo at={s.startedAt} />
                          </span>
                        </button>
                        <span className="ag-acts-row">
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
                            className={`btn btn-ghost btn-icon danger-trigger${arming ? " is-armed" : ""}`}
                            title={
                              arming
                                ? t("agentsView.closeConfirm")
                                : s.status === "running"
                                  ? t("agentsView.close")
                                  : t("agentsView.dismiss")
                            }
                            aria-label={
                              arming
                                ? t("agentsView.closeConfirm")
                                : s.status === "running"
                                  ? t("agentsView.close")
                                  : t("agentsView.dismiss")
                            }
                            onClick={() => void closeSession(s)}
                          >
                            {arming ? (
                              <span className="ag-arm">{t("agentsView.closeConfirmMark")}</span>
                            ) : s.status === "running" ? (
                              <IconX size={13} />
                            ) : (
                              <IconTrash size={13} />
                            )}
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>

          <section className="panel ag-stage" ref={stageRef} data-row="stage" data-stage>
            {selectedSession !== null && (
              <header className="ag-sh">
                <b className="st-t" title={sessionLabel(selectedSession, anon)}>
                  {sessionLabel(selectedSession, anon)}
                </b>
                <small title={selectedSession.root}>{nameOf(selectedSession.root)}</small>
                <button
                  className="btn btn-small"
                  onClick={() => onOpen(selectedSession.root, stageRef.current)}
                >
                  {t("agentsView.goToTerminal")}
                  <IconArrowRight size={13} />
                </button>
              </header>
            )}
            <div className="ag-stage-body" ref={stageBodyRef}>
              {stage(selectedSession)}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
