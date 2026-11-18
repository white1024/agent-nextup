import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, errorKind, errorMessage } from "../../api";
import { useFlash, useGuardedMutation, useWorkspaceData } from "../../hooks";
import { useFreshKeys } from "../../hooks/anim";
import { shownDomain } from "../../lib/domain";
import { eventCat, eventKey } from "../../lib/ledger";
import EmptyState from "../../components/EmptyState";
import EventMessage from "../../components/EventMessage";
import Markdown from "../../components/Markdown";
import MilestonePanel from "./MilestonePanel";
import Modal from "../../components/Modal";
import QuickNote from "../../components/QuickNote";
import StatTile from "./StatTile";
import WorkflowPanel from "./WorkflowPanel";
import ActionBar from "./ActionBar";
import { IconArrowRight, IconDoc } from "../../components/icons";
import ConnectGuide from "./ConnectGuide";
import ErrorBar from "../../components/ErrorBar";
import { isConnected, markConnected } from "../../lib/prefs";
import { centreOf, fx, motionOff, tokenRgb } from "../../lib/fx";
import type {
  AgentAccessView,
  AgentMcpStatus,
  LedgerEvent,
  SystemStatus,
  WorkflowStatus,
} from "../../types";
import TimeAgo from "../../components/TimeAgo";
import PathLabel from "../../components/PathLabel";

interface Props {
  status: SystemStatus;
  /** Bumped by App whenever the backend reports a workspace change. */
  refreshKey: number;
  onMutated: () => void;
  /** Jump to the Ledger browser (D47) — the porthole's "view all". */
  onShowLedger: () => void;
  /** Connect guide targets (D63); absent in contexts without those views. */
  onGoToTools?: () => void;
  onGoToTerminal?: () => void;
  /** Whether a terminal is running in this workspace right now. */
  terminalRunning?: boolean;
  /** Action bar targets (D66). */
  onGoToTasks?: () => void;
  onRecordDecision?: () => void;
}

export default function Dashboard({
  status,
  refreshKey,
  onMutated,
  onShowLedger,
  onGoToTools,
  onGoToTerminal,
  terminalRunning = false,
  onGoToTasks,
  onRecordDecision,
}: Props) {
  const { t } = useTranslation();
  const { flash, showFlash } = useFlash(2500);
  // Workflow status reported up by the panel (D66) — the action bar renders
  // from it rather than evaluating a second time. `setState` is a stable
  // reference, so passing it straight down cannot loop the panel's load.
  const [workflow, setWorkflow] = useState<WorkflowStatus | null>(null);
  // Snapshot reader (D54): the standalone handoff view folded into a modal
  // here — the dashboard is where the generate button already lived.
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  // Invariant 10(a): until the read answers, the snapshot is unknown, not
  // missing — saying "not generated yet" before then is a guess.
  const [snapshotRead, setSnapshotRead] = useState(false);
  /** Scroll container of the snapshot modal — anchor jumps scroll inside it. */
  const snapshotBodyRef = useRef<HTMLDivElement>(null);

  // ── Connect guide (D63) ───────────────────────────────────────────────────
  // Only workspaces no agent has ever called into pay for this: `isConnected`
  // is checked before the probes run, so the common case costs zero IPC. It is
  // read into state (not called during render) so dismissing re-renders.
  const wsRoot = status.workspace?.root ?? null;
  const [connected, setConnected] = useState(() => wsRoot === null || isConnected(wsRoot));
  const [connectProbe, setConnectProbe] = useState<{
    mcp: AgentMcpStatus;
    access: AgentAccessView;
  } | null>(null);
  /** Own error slot: the guide is an overlay on a working dashboard, so its
   *  failures must not take over the page's own error line. */
  const [connectError, setConnectError] = useState<string | null>(null);
  const { busy: repairing, run: runRepair } = useGuardedMutation(setConnectError);

  useEffect(() => {
    setConnected(wsRoot === null || isConnected(wsRoot));
  }, [wsRoot, refreshKey]);

  useEffect(() => {
    if (connected || wsRoot === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const [mcp, access] = await Promise.all([api.agentMcpStatus(), api.agentAccessStatus()]);
        if (!cancelled) setConnectProbe({ mcp, access });
      } catch (e) {
        // A failed probe hides the guide rather than showing a broken one —
        // this is an onboarding aid, never a reason to break the dashboard.
        console.warn("connect probe failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, wsRoot, refreshKey]);

  const dismissConnectGuide = useCallback(() => {
    if (wsRoot !== null) markConnected(wsRoot);
    setConnected(true);
  }, [wsRoot]);

  const repairMcp = useCallback(
    () =>
      runRepair(async () => {
        setConnectError(null);
        const mcp = await api.agentMcpRepair();
        setConnectProbe((p) => (p === null ? p : { ...p, mcp }));
      }),
    [runRepair],
  );

  // Section anchors for the snapshot (product review §5-7). Headings are read off the raw
  // markdown, and the click resolves the Nth rendered <h2> in the same body —
  // both lists come from one document in one order, so the indexes line up
  // without teaching the shared renderer about ids.
  const snapshotSections = useMemo(
    () =>
      (snapshot ?? "")
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map((line) => line.slice(3).trim()),
    [snapshot],
  );

  /** Section currently under the top of the reading pane — highlights the TOC. */
  const [activeSection, setActiveSection] = useState(0);
  /** Target of an in-flight smooth scroll; see trackActiveSection. */
  const pendingJump = useRef<number | null>(null);

  /** Scroll offset of the Nth heading within the reading pane. */
  function headingTop(body: HTMLDivElement, heading: HTMLElement): number {
    return heading.offsetTop - body.offsetTop;
  }

  const atBottom = (body: HTMLDivElement) =>
    body.scrollHeight - body.scrollTop - body.clientHeight < 4;

  /**
   * Any hands-on scroll cancels the browser's smooth scroll, so the pending
   * target would never be reached and tracking would stay suppressed forever.
   * Releasing here keeps the highlight live the moment the user takes over.
   */
  function releaseJump() {
    pendingJump.current = null;
  }

  function jumpToSection(index: number) {
    const body = snapshotBodyRef.current;
    const heading = body?.querySelectorAll("h2")[index];
    if (!body || !heading) return;
    // scrollTo on the pane, not scrollIntoView on the heading: the latter also
    // scrolls the modal panel itself, which yanks the dialog around.
    pendingJump.current = index;
    setActiveSection(index);
    // C220: the contents' light gets there first; the text follows 200ms later.
    if (motionOff()) {
      body.scrollTo({ top: headingTop(body, heading) });
      return;
    }
    window.setTimeout(() => body.scrollTo({ top: headingTop(body, heading), behavior: "smooth" }), 200);
  }

  // C220: the light bar in the contents slides to the section that is current
  // (the bar is the selected ground; the rows keep only their words). Placed
  // without moving the first time, so opening the reader does not slide it in.
  const tocRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const toc = tocRef.current;
    const bar = toc?.querySelector<HTMLElement>(".snap-toc-bar");
    const item = toc?.querySelectorAll<HTMLElement>(".snap-toc-item")[activeSection];
    if (!bar || !item) return;
    bar.style.transform = `translateY(${item.offsetTop}px)`;
    bar.style.height = `${item.offsetHeight}px`;
    if (bar.dataset.ready === undefined) requestAnimationFrame(() => (bar.dataset.ready = "1"));
  });

  /**
   * The last heading that has passed the top edge wins — standard TOC feel,
   * with two corrections learnt from the walkthrough:
   *
   * - A smooth scroll fires a stream of intermediate positions. Adopting them
   *   strobes the highlight through every section on the way, so tracking is
   *   held off until the animation actually arrives.
   * - The final section is usually shorter than the pane, so it can never
   *   reach the top edge — scrolled to the end, the plain rule would light up
   *   the second-to-last section forever. Hitting the bottom means "last".
   */
  function trackActiveSection() {
    const body = snapshotBodyRef.current;
    if (!body) return;
    const headings = [...body.querySelectorAll("h2")] as HTMLElement[];
    if (headings.length === 0) return;

    const target = pendingJump.current;
    if (target !== null) {
      const wanted = headings[target];
      const arrived =
        wanted === undefined ||
        Math.abs(body.scrollTop - headingTop(body, wanted)) < 4 ||
        atBottom(body);
      if (!arrived) return;
      pendingJump.current = null;
      return;
    }

    if (atBottom(body)) {
      setActiveSection(headings.length - 1);
      return;
    }
    let current = 0;
    headings.forEach((heading, i) => {
      if (headingTop(body, heading) - 12 <= body.scrollTop) current = i;
    });
    setActiveSection(current);
  }
  const { flash: copied, showFlash: showCopied } = useFlash(2000);

  const workspace = status.workspace;
  const counts = status.taskCounts;

  const {
    data: events,
    error,
    setError,
    reload: loadEvents,
    loading: eventsLoading,
  } = useWorkspaceData<LedgerEvent[]>(() => api.recentEvents(12), refreshKey);
  const { busy, run } = useGuardedMutation(setError);

  // Newest-first for display; flash only rows that actually appeared.
  const shown = [...(events ?? [])].reverse();
  const freshEvents = useFreshKeys(shown.map(eventKey));

  // C32: a delivery that has just arrived — an amber beam runs from its row's
  // kind to the inbox in the sidebar (the badge pops there on its own count
  // change, NavBadge). Only on the arrival, never on a reload.
  useEffect(() => {
    if (motionOff() || freshEvents.size === 0) return;
    const arrived = shown.filter((e) => e.kind === "delivery_received" && freshEvents.has(eventKey(e)));
    if (arrived.length === 0) return;
    const to =
      document.querySelector('.sidebar [data-view="inbox"] .badge .mk-y') ??
      document.querySelector('.sidebar [data-view="inbox"]');
    const rgb = tokenRgb("--orange");
    arrived.slice(0, 3).forEach((e, k) => {
      const from = document.querySelector(`[data-ev="${CSS.escape(eventKey(e))}"] .event-cat`);
      fx.beam(centreOf(from), centreOf(to), { width: 2.2, bend: 0.22, dur: 520, delay: 260 + k * 120, rgb });
    });
    // Keyed on the fresh set; `shown` is read as it is at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshEvents]);

  const openSnapRef = useRef<HTMLButtonElement>(null);
  /** The reader's box before a first snapshot widens it (C220). */
  const growFrom = useRef<DOMRect | null>(null);

  /**
   * Generating (my-design review F24). From the page (C219): a thin light
   * draws along the top edge of the band, the exit gates, the task overview
   * and recent activity, one after another; the four lights then flow into
   * "View snapshot", which lights once as the result line drops in. From the
   * reader (C220): a scan line runs down the text, which dims and is swapped
   * for the new one halfway; a first snapshot (there was none) also widens
   * the reader into its two-column layout. Reduced motion: the result only.
   */
  function generateHandoff() {
    const inReader = snapshotOpen;
    return run(async () => {
      setError(null);
      setSnapshotError(null);
      const md = await api.generateHandoff();
      const settle = async () => {
        await loadEvents();
        onMutated();
      };
      if (motionOff()) {
        setSnapshot(md);
        showFlash(t("dashboard.handoffDone"));
        await settle();
        return;
      }
      if (inReader) {
        const body = snapshotBodyRef.current;
        if (body !== null) scanDown(body);
        if (snapshotSections.length <= 1) growFrom.current = document.querySelector(".snap-panel")?.getBoundingClientRect() ?? null;
        await new Promise((r) => window.setTimeout(r, 330));
        setSnapshot(md);
        showFlash(t("dashboard.handoffDone"));
        await settle();
        return;
      }
      setSnapshot(md);
      edgeLights(openSnapRef.current);
      window.setTimeout(() => {
        const btn = openSnapRef.current;
        if (btn !== null) {
          btn.classList.remove("shell-flash");
          void btn.offsetWidth;
          btn.classList.add("shell-flash");
          window.setTimeout(() => btn.classList.remove("shell-flash"), 620);
        }
        showFlash(t("dashboard.handoffDone"));
      }, 1920);
      await settle();
    });
  }

  // C220, a first snapshot: the reader grows from its plain width into the
  // wide two-column one; its contents show only in the last fifth.
  useLayoutEffect(() => {
    const from = growFrom.current;
    if (from === null || snapshotSections.length <= 1) return;
    growFrom.current = null;
    const panel = document.querySelector<HTMLElement>(".snap-panel");
    if (panel === null || motionOff()) return;
    const to = panel.getBoundingClientRect();
    panel.animate(
      [
        { width: `${from.width}px`, height: `${from.height}px` },
        { width: `${to.width}px`, height: `${to.height}px` },
      ],
      { duration: 440, easing: "cubic-bezier(.16,1,.3,1)" },
    );
    for (const child of panel.children) {
      child.animate([{ opacity: 0 }, { opacity: 0, offset: 0.8 }, { opacity: 1 }], { duration: 440 });
    }
  }, [snapshotSections.length]);

  async function openSnapshot() {
    setSnapshotError(null);
    setSnapshotRead(false);
    setSnapshotOpen(true);
    try {
      setSnapshot(await api.readHandoff());
    } catch (e) {
      // Missing file = normal empty state, not an error (same semantics as
      // useWorkspaceData's notFoundAsEmpty).
      if (errorKind(e) === "not_found") setSnapshot(null);
      else setSnapshotError(errorMessage(e));
    } finally {
      setSnapshotRead(true);
    }
  }

  async function copySnapshot() {
    if (snapshot === null) return;
    try {
      await navigator.clipboard.writeText(snapshot);
      showCopied(t("common.copied"));
    } catch {
      setSnapshotError(t("common.clipboardUnavailable"));
    }
  }


  // Nothing to say beats saying "general" on every dashboard (lib/domain.ts).
  const domainLabel = shownDomain(workspace?.domain);

  return (
    <div className="view db">
      <header className="view-header">
        <div className="vh-main">
          <div className="vh-meta">
            {domainLabel !== null && <span className="chip">{domainLabel}</span>}
            {workspace && <PathLabel className="vh-path" path={workspace.root} />}
          </div>
          <h1>{workspace?.name ?? t("dashboard.heading")}</h1>
        </div>
        <div className="header-actions">
          <button className="btn" ref={openSnapRef} onClick={() => void openSnapshot()}>
            <IconDoc size={15} />
            {t("handoff.open")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void generateHandoff()}
            disabled={busy}
          >
            {t("dashboard.generateHandoff")}
          </button>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}
      {flash && <div className="alert alert-ok">{flash}</div>}

      {/* First-day connect guide (D63). Above everything else because it is
          only ever present when the project cannot yet be worked by an agent
          at all — once one calls in, this never renders again. */}
      {!connected && connectProbe !== null && onGoToTools && onGoToTerminal && (
        <>
          {/* C236: drops in above the card; a retry clears it first. */}
          <ErrorBar error={connectError} className="cg-err" />
          <ConnectGuide
            mcp={connectProbe.mcp}
            granted={
              connectProbe.access.writeTools.filter((tool) =>
                connectProbe.access.access.allowedTools.includes(tool),
              ).length
            }
            total={connectProbe.access.writeTools.length}
            enabled={connectProbe.access.access.enabled}
            terminalRunning={terminalRunning}
            onGoToTools={onGoToTools}
            onGoToTerminal={onGoToTerminal}
            onRepairMcp={() => void repairMcp()}
            repairing={repairing}
            onDismiss={dismissConnectGuide}
          />
        </>
      )}

      {/* The workflow renders the phase band across the top and the two
          columns under it (D153): its exit-gate card heads the left column,
          the page's own panels fill the rest. "Next step" — what is stopping
          this project from advancing (product review §4-1) — sits in the band
          beside the phase tiles; it only says something while something is
          actually in the way. */}
      <WorkflowPanel
        refreshKey={refreshKey}
        onMutated={onMutated}
        onStatus={setWorkflow}
        next={
          onGoToTasks && onGoToTools && onRecordDecision ? (
            <ActionBar
              status={workflow}
              onGoToTasks={onGoToTasks}
              onGoToTools={onGoToTools}
              onRecordDecision={onRecordDecision}
              onGoToWorkflow={() =>
                document.getElementById("wf-gates")?.scrollIntoView({ block: "start", behavior: "smooth" })
              }
            />
          ) : null
        }
        left={
          <section className="panel" data-landing="recent">
            <div className="panel-head">
              <h2 className="panel-title">
                {t("dashboard.recent")}
                <span className="sub">{t("dashboard.recentSub")}</span>
              </h2>
              <span className="spacer" />
              <button className="btn btn-ghost btn-small" onClick={onShowLedger}>
                {t("dashboard.viewAll")}
                <IconArrowRight size={13} />
              </button>
            </div>
            {eventsLoading ? null : shown.length === 0 ? (
              <EmptyState title={t("dashboard.noActivity")} hint={t("dashboard.noActivityHint")} />
            ) : (
              <ul className="event-list">
                {shown.map((event, i) => {
                  const key = eventKey(event);
                  const cat = eventCat(event);
                  const fresh = freshEvents.has(key);
                  // A delivery is something waiting on you (amber, C32); every
                  // other arrival is the agent's activity (violet).
                  // A forced advance (the engine writes "(OVERRIDE: reason)")
                  // is a consequence the user chose — red (C213).
                  const flash =
                    event.kind === "delivery_received"
                      ? "you-in"
                      : event.message.includes("(OVERRIDE:")
                        ? "red-in"
                        : "agent-flash";
                  return (
                    <li
                      key={`${key}-${i}`}
                      data-ev={key}
                      className={`event-item ${fresh ? `entering ${flash}` : ""}`}
                    >
                      <TimeAgo className="event-time" at={event.at} />
                      <span className={`event-cat ${cat}`}>{t(`ledger.${event.kind}`)}</span>
                      <EventMessage taskId={event.taskId} message={event.message} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        }
        right={
          <>
          <section className="panel" data-vt="stats">
            <div className="panel-head">
              <h2 className="panel-title">{t("dashboard.taskOverview")}</h2>
            </div>
            <div className="stat-grid">
              <StatTile label={t("status.total")} value={counts?.total ?? 0} tone="neutral" />
              <StatTile label={t("status.todo")} value={counts?.todo ?? 0} tone="neutral" />
              <StatTile
                label={t("status.in_progress")}
                value={counts?.inProgress ?? 0}
                tone="neutral"
              />
              {/* Blocked is the one state on this row that someone has to act on,
                  and it was the only quiet one — red in the sidebar badge, red in
                  the task row's reason line, orange on the status pill, neutral
                  here, on the surface whose whole job is "glance at the project's
                  health" (r2 2-4). */}
              <StatTile
                label={t("status.blocked")}
                value={counts?.blocked ?? 0}
                tone={(counts?.blocked ?? 0) > 0 ? "serious" : "neutral"}
              />
              <StatTile label={t("status.done")} value={counts?.done ?? 0} tone="neutral" />
              <StatTile
                label={t("status.done_unverified")}
                value={counts?.doneUnverified ?? 0}
                tone={(counts?.doneUnverified ?? 0) > 0 ? "serious" : "neutral"}
              />
            </div>
          </section>
            <MilestonePanel refreshKey={refreshKey} onMutated={onMutated} />
            <QuickNote
              onError={setError}
              onSaved={() => {
                showFlash(t("note.saved"));
                void loadEvents();
                onMutated();
              }}
            />
          </>
        }
      />

      {snapshotOpen && (
        <Modal
          reader
          label={t("handoff.heading")}
          wide={snapshotSections.length > 1}
          className="snap-panel"
          onClose={() => setSnapshotOpen(false)}
        >
          <div className="form">
            <h2 className="form-heading">{t("handoff.heading")}</h2>
            <p className="muted" style={{ margin: 0 }}>
              {t("handoff.subtitle")}
            </p>
            {snapshotError && <div className="alert alert-error">{snapshotError}</div>}
            <div className={snapshotSections.length > 1 ? "snap-layout" : ""}>
              {snapshotSections.length > 1 && (
                <nav className="snap-toc snap-toc--bar" ref={tocRef} aria-label={t("handoff.sections")}>
                  <i className="snap-toc-bar" aria-hidden="true" />
                  {snapshotSections.map((title, i) => (
                    <button
                      key={`${title}-${i}`}
                      className={`snap-toc-item${activeSection === i ? " is-active" : ""}`}
                      aria-current={activeSection === i ? "true" : undefined}
                      onClick={() => jumpToSection(i)}
                    >
                      {title}
                    </button>
                  ))}
                </nav>
              )}
              <div
                className="md-scroll"
                ref={snapshotBodyRef}
                onScroll={trackActiveSection}
                onWheel={releaseJump}
                onTouchMove={releaseJump}
                onKeyDown={releaseJump}
              >
                {!snapshotRead ? null : snapshot === null ? (
                  <EmptyState title={t("handoff.empty")} hint={t("handoff.emptyHint")} />
                ) : (
                  <Markdown text={snapshot} />
                )}
              </div>
            </div>
            <div className="form-actions">
              <button
                className="btn"
                onClick={() => void copySnapshot()}
                disabled={!snapshotRead || snapshot === null}
              >
                {copied ?? t("common.copy")}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void generateHandoff()}
                disabled={busy}
              >
                {busy ? t("handoff.regenerating") : t("handoff.regenerate")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * C219's first half: a thin light drawn along the top edge of each of the four
 * blocks in turn, then each edge's light flows into `to` ("View snapshot").
 */
function edgeLights(to: Element | null) {
  const target = centreOf(to);
  const blocks = [".phase-band", "#wf-gates", '[data-vt="stats"]', '[data-landing="recent"]']
    .map((sel) => document.querySelector(sel))
    .filter((el): el is Element => el !== null);
  blocks.forEach((block, i) => {
    const r = block.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    const edge = document.createElement("div");
    edge.className = "snap-edge";
    edge.setAttribute("aria-hidden", "true");
    Object.assign(edge.style, { left: `${r.left + 18}px`, top: `${r.top - 1}px`, width: `${Math.max(0, r.width - 36)}px` });
    document.body.appendChild(edge);
    void edge
      .animate(
        [
          { transform: "scaleX(0)", opacity: 1 },
          { transform: "scaleX(1)", opacity: 1, offset: 0.6 },
          { transform: "scaleX(1)", opacity: 0 },
        ],
        { duration: 640, delay: 380 + i * 140, easing: "cubic-bezier(.3,.7,.3,1)", fill: "both" },
      )
      .finished.catch(() => undefined)
      .then(() => edge.remove());
    fx.beam({ x: r.left + r.width / 2, y: r.top }, target, { width: 1.8, dur: 520, delay: 1240 + i * 50 });
  });
}

/** C220's regenerate: a scan line down the text while it dims and comes back. */
function scanDown(body: HTMLElement) {
  const r = body.getBoundingClientRect();
  const line = document.createElement("div");
  line.className = "snap-scan";
  line.setAttribute("aria-hidden", "true");
  Object.assign(line.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
  document.body.appendChild(line);
  void line
    .animate(
      [
        { transform: "translateY(0)", opacity: 1 },
        { transform: `translateY(${r.height}px)`, opacity: 0.6 },
      ],
      { duration: 760, easing: "cubic-bezier(.5,0,.3,1)", fill: "both" },
    )
    .finished.catch(() => undefined)
    .then(() => line.remove());
  body.animate([{ opacity: 1 }, { opacity: 0.25, offset: 0.43 }, { opacity: 1 }], { duration: 760, easing: "ease-in-out" });
}
