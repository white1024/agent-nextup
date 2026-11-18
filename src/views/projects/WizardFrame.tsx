import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../../api";
import ErrorBar from "../../components/ErrorBar";
import { useGateLabel } from "../../hooks/gateLabel";
import type { Gate, WorkflowPhase } from "../../types";

/**
 * The three wizards' shared frame (spec 20 section 6): a title, the error line
 * under it, a scrolling two-column body — the form, and on the right what the
 * project will look like — and the actions pinned to the foot.
 *
 * The Modal around it supplies the dialog itself (scrim, Esc, close button,
 * focus); this is only the inside.
 */
export default function WizardFrame({
  title,
  error,
  side,
  foot,
  short = false,
  children,
}: {
  title: string;
  error: string | null;
  side: ReactNode;
  foot: ReactNode;
  /** Little to fill in yet: the panel takes its content's height. */
  short?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`wz${short ? " wz--short" : ""}`}>
      <header className="wz-head">
        <h2>{title}</h2>
      </header>
      <ErrorBar error={error} className="wz-err" />
      <div className="wz-body">
        <div className="wz-form">{children}</div>
        <aside className="wz-side">{side}</aside>
      </div>
      <footer className="wz-foot">{foot}</footer>
    </div>
  );
}

/**
 * "The first phase once it is created": the chosen template's opening phase,
 * its description and exit gates, all still open. One `get_template` for the
 * one selected template — the cards themselves draw from the listing (D155 ②).
 *
 * `tasks` is how many tasks the project will start with, so a "create N
 * tasks" gate shows how far the draft already gets it.
 */
export function FirstPhase({ templateId, tasks = 0 }: { templateId: string | null; tasks?: number }) {
  const { t } = useTranslation();
  const gateLabel = useGateLabel();
  const [phase, setPhase] = useState<WorkflowPhase | null>(null);

  useEffect(() => {
    setPhase(null);
    if (templateId === null) return;
    let stale = false;
    api
      .getTemplate(templateId)
      .then((tpl) => {
        if (!stale) setPhase(tpl.phases[0] ?? null);
      })
      .catch(() => {
        // Nothing to show is better than a guess; the card above still says
        // which template it is.
      });
    return () => {
      stale = true;
    };
  }, [templateId]);

  // Invariant 10: not read yet draws nothing rather than an empty box.
  if (phase === null) return null;
  return (
    <div className="wz-first">
      <small>{t("wizard.firstPhase")}</small>
      <div className="wz-first-h">
        <span className="tn">01</span>
        <b>{phase.title}</b>
      </div>
      {phase.description !== "" && <p>{phase.description}</p>}
      {phase.exitGates.length > 0 && (
        <ul>
          {phase.exitGates.map((g, i) => (
            <li key={i}>
              <i className="mk-o" aria-hidden="true" />
              <span>{gateLabel(g)}</span>
              {observed(g, tasks) && <span className="wz-obs">{observed(g, tasks)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where a fresh project starts against a counting gate. */
function observed(g: Gate, tasks: number): string | null {
  if (g.kind === "min_tasks") return `${Math.min(tasks, g.count)} / ${g.count}`;
  if (g.kind === "min_decisions") return `0 / ${g.count}`;
  return null;
}
