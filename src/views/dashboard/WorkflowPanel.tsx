import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, errorKind, errorMessage } from "../../api";
import { useGuardedMutation } from "../../hooks";
import EmptyState from "../../components/EmptyState";
import { IconArrowRight, IconWarn, IconX } from "../../components/icons";
import type { Gate, TemplateSummary, WorkflowStatus } from "../../types";

interface Props {
  refreshKey: number;
  onMutated: () => void;
  /**
   * Hand the evaluated status up so the action bar can render from it (D66).
   * Reporting rather than lifting state: `evaluate` reads the whole ledger and
   * scans every task file on each call, and it already runs here on every
   * watcher tick — a second caller would double that per tick. `null` covers
   * both "not read yet" and "no harness adopted"; neither is a state the bar
   * has anything to say about.
   */
  onStatus?: (status: WorkflowStatus | null) => void;
}

/** Renders a gate label from its structured kind so it localizes cleanly. */
export function useGateLabel() {
  const { t } = useTranslation();
  return (gate: Gate): string => {
    switch (gate.kind) {
      case "min_tasks":
        return t("gate.min_tasks", { n: gate.count });
      case "all_tasks_done":
        return t("gate.all_tasks_done");
      case "no_blocked_tasks":
        return t("gate.no_blocked_tasks");
      case "artifact_exists":
        return t("gate.artifact_exists", { path: gate.path });
      case "min_decisions":
        return t("gate.min_decisions", { n: gate.count });
      case "manual_confirm":
        return t("gate.manual_confirm", { prompt: gate.prompt });
      case "doctor_clean":
        return t("gate.doctor_clean");
    }
  };
}

export default function WorkflowPanel({ refreshKey, onMutated, onStatus }: Props) {
  const { t } = useTranslation();
  const gateLabel = useGateLabel();
  const [status, setStatus] = useState<WorkflowStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [adoptId, setAdoptId] = useState("generic-v1");
  const [error, setError] = useState<string | null>(null);
  // The ref gate matters for the `advancePhase` caller specifically: a
  // same-tick double click used to advance two phases at once, which no gate
  // would have stopped because each call passed its own check.
  const { busy, run: runMutation } = useGuardedMutation(setError);
  const [showOverride, setShowOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  // Hero/diff animations: stagger gates in after a phase advance, glow a gate
  // that just flipped to passed. Driven by state diffs, not by render — the
  // watcher re-reads views wholesale and must not flash unchanged rows.
  const [staggered, setStaggered] = useState(false);
  const [justPassed, setJustPassed] = useState<Set<number>>(() => new Set());
  const prevRef = useRef<{
    tpl: string;
    phaseId: string;
    index: number;
    completed: boolean;
    passed: boolean[];
  } | null>(null);

  // Custom load (not useWorkspaceData): a missing harness is a distinct
  // "adopt a template" state, not an empty one, and it pulls the template
  // list as a follow-up read.
  const load = useCallback(async () => {
    try {
      setStatus(await api.workflowStatus());
      setMissing(false);
      setError(null);
    } catch (e) {
      if (errorKind(e) === "not_found") {
        setMissing(true);
        setStatus(null);
        setError(null);
        try {
          setTemplates(await api.listTemplates());
        } catch {
          /* template list is only a convenience here */
        }
      } else {
        setError(errorMessage(e));
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    onStatus?.(status);
  }, [status, onStatus]);

  useEffect(() => {
    if (status === null) return;
    const phase = status.workflow.phases[status.currentIndex];
    const cur = {
      tpl: status.workflow.templateId,
      phaseId: phase?.id ?? "(completed)",
      index: status.currentIndex,
      completed: status.workflow.state.completed,
      passed: status.gates.map((g) => g.passed),
    };
    const prev = prevRef.current;
    prevRef.current = cur;
    if (prev === null || prev.tpl !== cur.tpl) return;

    if (cur.index > prev.index || (cur.completed && !prev.completed)) {
      setStaggered(true);
      const id = window.setTimeout(
        () => setStaggered(false),
        cur.passed.length * 110 + 460,
      );
      return () => window.clearTimeout(id);
    }

    if (prev.phaseId === cur.phaseId && prev.passed.length === cur.passed.length) {
      const newly = new Set<number>();
      cur.passed.forEach((p, i) => {
        if (p && !prev.passed[i]) newly.add(i);
      });
      if (newly.size > 0) {
        setJustPassed(newly);
        const id = window.setTimeout(() => setJustPassed(new Set()), 900);
        return () => window.clearTimeout(id);
      }
    }
  }, [status]);

  function run(action: () => Promise<WorkflowStatus>) {
    return runMutation(async () => {
      setError(null);
      setStatus(await action());
      setShowOverride(false);
      setOverrideReason("");
      onMutated();
    });
  }

  if (missing) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{t("workflow.heading")}</h2>
        </div>
        {/* The affordance here is a picker plus a button, which `action` (one
            button) cannot model — so the copy goes through EmptyState and the
            controls stay below it. */}
        <EmptyState title={t("workflow.missing")} hint={t("workflow.missingHint")} />
        <div className="wf-actions">
          <select
            aria-label={t("workflow.templateLabel")}
            value={adoptId}
            onChange={(e) => setAdoptId(e.target.value)}
          >
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name} ({tpl.id})
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void run(() => api.adoptWorkflow(adoptId))}
          >
            {t("workflow.adopt")}
          </button>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
      </section>
    );
  }

  if (status === null) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{t("workflow.heading")}</h2>
        </div>
        <p className="muted">{t("common.loading")}</p>
      </section>
    );
  }

  const { workflow, currentIndex, totalPhases, gates, canAdvance } = status;
  const completed = workflow.state.completed;
  const phase = workflow.phases[currentIndex];
  const isFinal = currentIndex + 1 >= totalPhases;
  const failCount = gates.filter((g) => !g.passed).length;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">
          {t("workflow.heading")}
          <span className="sub">{workflow.templateName}</span>
        </h2>
      </div>

      <div className="wf-strip">
        {workflow.phases.map((p, i) => {
          const done = completed || i < currentIndex;
          const current = !completed && i === currentIndex;
          return (
            <Fragment key={p.id}>
              {i > 0 && (
                <span
                  className={`wf-connector ${completed || i <= currentIndex ? "done" : ""}`}
                  aria-hidden="true"
                />
              )}
              <span
                className={`wf-step ${done ? "wf-step--done" : ""} ${current ? "wf-step--current" : ""}`}
              >
                <span className="wf-pill" title={p.title}>
                  <span className="wf-num" aria-hidden="true">
                    {done ? "✓" : i + 1}
                  </span>
                  {p.title}
                </span>
                <span className="wf-caption">
                  {done
                    ? t("workflow.stepDone")
                    : current
                      ? t("workflow.stepCurrent")
                      : t("workflow.stepFuture")}
                </span>
              </span>
            </Fragment>
          );
        })}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {completed ? (
        <div className="alert alert-ok">
          <strong>{t("workflow.completed")}</strong> — {t("workflow.completedHint")}
        </div>
      ) : (
        phase && (
          <div className="wf-current">
            {(phase.description !== "" || phase.aiInstructions.length > 0) && (
              <div className="wf-desc">
                <h4>{phase.title}</h4>
                {phase.description !== "" && (
                  <p className="wf-phase-desc">{phase.description}</p>
                )}
                {phase.aiInstructions.length > 0 && (
                  <ul className="instruction-list">
                    {phase.aiInstructions.map((line, i) => (
                      <li key={i}>
                        <span className="idx">{i + 1}.</span>
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="panel-title" style={{ marginBottom: "var(--s-3)" }}>
              {t("workflow.gates")}
              <span className="sub">{t("workflow.gatesSub")}</span>
            </div>
            {gates.length === 0 ? (
              <EmptyState title={t("workflow.noGates")} />
            ) : (
              <ul className="gate-list">
                {gates.map((g, i) => (
                  <li
                    key={i}
                    className={`gate-item ${g.passed ? "gate-item--pass" : "gate-item--fail"} ${
                      staggered ? "gate-enter" : ""
                    } ${justPassed.has(i) ? "just-passed" : ""}`}
                    style={
                      staggered ? { animationDelay: `${120 + i * 110}ms` } : undefined
                    }
                  >
                    <span className="gate-check" aria-hidden="true">
                      {g.passed ? (
                        <svg viewBox="0 0 24 24" fill="none">
                          <path className="checkmark" d="M20 6L9 17l-5-5" />
                        </svg>
                      ) : (
                        <IconX size={12} className="gate-x" />
                      )}
                    </span>
                    <span className="gate-body">
                      <span className="gate-name">{gateLabel(g.gate)}</span>
                      <span className="gate-obs">
                        {t("workflow.observed")}
                        <span className="mono">{g.observed}</span>
                      </span>
                    </span>
                    {!g.passed && g.gate.kind === "manual_confirm" && (
                      <button
                        className="btn btn-small"
                        disabled={busy}
                        onClick={() => {
                          const prompt = (g.gate as { prompt: string }).prompt;
                          void run(() => api.confirmGate(phase.id, prompt));
                        }}
                      >
                        {t("workflow.confirm")}
                      </button>
                    )}
                    <span className={`pill ${g.passed ? "pill-pass" : "pill-fail"}`}>
                      <span className="dot" aria-hidden="true" />
                      {g.passed ? t("workflow.gatePass") : t("workflow.gateFail")}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/* Plain, not primary. Four purple buttons shared the dashboard's
                first screen (this one, "Generate handoff now", "Add
                milestone", "Save as decision") and between them said nothing
                about which was the page's action — so the view header keeps
                the primary and the panels state their actions plainly
                (r2 3-3). This one is also the most often disabled of the
                four, which made the inflation worse rather than better. */}
            <div className="wf-actions">
              <button
                className="btn"
                disabled={busy || !canAdvance}
                onClick={() => void run(() => api.advancePhase(false))}
              >
                <IconArrowRight size={15} />
                {busy
                  ? t("workflow.working")
                  : isFinal
                    ? t("workflow.finish")
                    : t("workflow.advance")}
              </button>
              {!canAdvance && (
                <>
                  <span className="section-hint">
                    {t("workflow.blockedHint", { n: failCount })}
                  </span>
                  <button className="btn btn-link" onClick={() => setShowOverride((v) => !v)}>
                    {t("workflow.overrideToggle")}
                  </button>
                </>
              )}
            </div>

            {showOverride && !canAdvance && (
              <div className="force-box">
                <h4>
                  <IconWarn size={15} />
                  {t("workflow.overrideButton")}
                </h4>
                <p>{t("workflow.forceHint")}</p>
                <input
                  value={overrideReason}
                  aria-label={t("workflow.overrideReason")}
                  placeholder={t("workflow.overrideReason")}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  style={{ width: "100%" }}
                />
                <div className="force-actions">
                  <button
                    className="btn btn-danger"
                    disabled={busy || overrideReason.trim() === ""}
                    onClick={() => void run(() => api.advancePhase(true, overrideReason))}
                  >
                    {t("workflow.overrideButton")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      )}
    </section>
  );
}
