import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, errorKind, errorMessage } from "../../api";
import { useFlash, useGuardedMutation, useWorkspaceData } from "../../hooks";
import { useFreshKeys } from "../../hooks/anim";
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
import { isConnected, markConnected } from "../../lib/prefs";
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
  const workflowRef = useRef<HTMLDivElement>(null);
  // Snapshot reader (D54): the standalone handoff view folded into a modal
  // here — the dashboard is where the generate button already lived.
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
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
    body.scrollTo({ top: headingTop(body, heading), behavior: "smooth" });
  }

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

  function generateHandoff() {
    return run(async () => {
      setError(null);
      setSnapshotError(null);
      setSnapshot(await api.generateHandoff());
      showFlash(t("dashboard.handoffDone"));
      await loadEvents();
      onMutated();
    });
  }

  async function openSnapshot() {
    setSnapshotError(null);
    setSnapshotOpen(true);
    try {
      setSnapshot(await api.readHandoff());
    } catch (e) {
      // Missing file = normal empty state, not an error (same semantics as
      // useWorkspaceData's notFoundAsEmpty).
      if (errorKind(e) === "not_found") setSnapshot(null);
      else setSnapshotError(errorMessage(e));
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


  return (
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>{workspace?.name ?? t("dashboard.heading")}</h1>
          <div className="vh-meta">
            {workspace?.domain && (
              <span className="chip">
                <span className="dot" aria-hidden="true" />
                {workspace.domain}
              </span>
            )}
            {workspace && <PathLabel className="vh-path" path={workspace.root} />}
          </div>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => void openSnapshot()}>
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
          {connectError && <div className="alert alert-error">{connectError}</div>}
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

      {/* "What to do right now" goes at the very top (product review §4-1):
          the information was always there, but ranked equally with the
          stats and the activity feed. It only takes up space when something
          is actually blocking progress. */}
      {onGoToTasks && onGoToTools && onRecordDecision && (
        <ActionBar
          status={workflow}
          onGoToTasks={onGoToTasks}
          onGoToTools={onGoToTools}
          onRecordDecision={onRecordDecision}
          onGoToWorkflow={() =>
            workflowRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })
          }
        />
      )}

      <div ref={workflowRef}>
        <WorkflowPanel refreshKey={refreshKey} onMutated={onMutated} onStatus={setWorkflow} />
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{t("dashboard.taskOverview")}</h2>
        </div>
        <div className="stat-row">
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

      <div className="two-col">
        <section className="panel">
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
                return (
                  <li
                    key={`${key}-${i}`}
                    className={`event-item ${fresh ? "entering agent-flash" : ""}`}
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

        <QuickNote
          onError={setError}
          onSaved={() => {
            showFlash(t("note.saved"));
            void loadEvents();
            onMutated();
          }}
        />
      </div>

      {snapshotOpen && (
        <Modal
          reader
          label={t("handoff.heading")}
          wide={snapshotSections.length > 1}
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
                <nav className="snap-toc" aria-label={t("handoff.sections")}>
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
                {snapshot === null ? (
                  <EmptyState title={t("handoff.empty")} hint={t("handoff.emptyHint")} />
                ) : (
                  <Markdown text={snapshot} />
                )}
              </div>
            </div>
            <div className="form-actions">
              <button className="btn" onClick={() => void copySnapshot()} disabled={snapshot === null}>
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
