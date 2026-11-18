import { useTranslation } from "react-i18next";

import { IconArrowRight } from "../../components/icons";
import { useGateLabel } from "../../hooks/gateLabel";
import type { Gate, WorkflowStatus } from "../../types";

interface Props {
  /** `null` = not read yet, or no harness adopted. The bar renders nothing. */
  status: WorkflowStatus | null;
  onGoToTasks: () => void;
  onGoToTools: () => void;
  onRecordDecision: () => void;
  /** Scroll down to the workflow panel on this same page. */
  onGoToWorkflow: () => void;
}

/**
 * "What is stopping this project from advancing" (D66, product review §4-1).
 *
 * The bar is built from the current phase's **failing exit gates** and nothing
 * else, because that is the only thing `can_advance` actually reads
 * (`workflow.rs`: `!completed && gates.all(passed)`). the product review proposed a fixed
 * four — "N tasks open, N gates unconfirmed | N blocked | N to send" — and the
 * the B6 audit retired half of it:
 *
 *  - **pending delivery is not a blocker at all.** No `Gate` variant reads the outbox;
 *    publishing a delivery has no bearing on `can_advance`.
 *  - **blocked is only a blocker in phases carrying `no_blocked_tasks`**, and the
 *    count is already on screen twice (sidebar badge + stat tile).
 *  - **"N tasks open" is backwards in the plan phase**, where the gate is
 *    `min_tasks` — what is missing there is *more* tasks, not fewer open ones.
 *  - The fixed four also omitted `min_decisions` (in all five built-in
 *    templates) and `artifact_exists` (in two), so a coding project sitting at
 *    release would have shown an all-green bar next to a button that refuses.
 *
 * Rendering from the gates themselves means every template — including custom
 * ones — is covered without this file knowing anything about them.
 *
 * Since D153 it is the "next step" column inside the phase band rather than a
 * strip of its own: one line per failing gate (its mark, its name, the
 * engine's observation — truncated, full text on hover and in the gate card —
 * and a plain button to where it gets fixed), or "every gate has passed" and
 * the way to advance.
 */
export default function ActionBar({
  status,
  onGoToTasks,
  onGoToTools,
  onRecordDecision,
  onGoToWorkflow,
}: Props) {
  const { t } = useTranslation();
  const gateLabel = useGateLabel();

  // Nothing read yet, no harness, or the whole flow is finished — in none of
  // those is there a "next step" this bar could honestly name.
  if (status === null || status.workflow.state.completed) return null;

  const failing = status.gates.filter((g) => !g.passed);

  if (failing.length === 0) {
    return (
      <section className="next next--ready" aria-label={t("actionBar.heading")}>
        <div className="next-k">{t("actionBar.next")}</div>
        <div className="next-ready">
          <span className="mk-e" aria-hidden="true" />
          <span>{t("actionBar.ready")}</span>
          <button className="btn btn-small btn-primary" onClick={onGoToWorkflow}>
            {t("actionBar.readyAction")} <IconArrowRight size={12} />
          </button>
        </div>
      </section>
    );
  }

  /** Where does fixing this gate happen? `null` = nowhere to send them. */
  function destinationOf(gate: Gate): { label: string; run: () => void } | null {
    switch (gate.kind) {
      case "min_tasks":
      case "all_tasks_done":
      case "no_blocked_tasks":
        return { label: t("actionBar.goTasks"), run: onGoToTasks };
      case "min_decisions":
        return { label: t("note.addDecision"), run: onRecordDecision };
      case "doctor_clean":
        return { label: t("actionBar.goTools"), run: onGoToTools };
      case "manual_confirm":
        return { label: t("actionBar.goConfirm"), run: onGoToWorkflow };
      case "artifact_exists":
        // The app has no file surface to land on, and the gate names the path
        // itself. A button that went "somewhere plausible" would be the dead
        // end D63 had to fix twice — better to say the requirement and stop.
        return null;
    }
  }

  return (
    <section className="next" aria-label={t("actionBar.heading")}>
      <div className="next-k">
        {t("actionBar.next")} · {t("actionBar.stillNeeds", { n: failing.length })}
      </div>
      <ul className="next-items">
        {failing.map((g, i) => {
          const dest = destinationOf(g.gate);
          // R7: the user's own gate (a confirmation) waits on them — amber;
          // the rest the engine will see by itself — hollow.
          const yours = g.gate.kind === "manual_confirm";
          return (
            <li className="next-item" key={`${g.gate.kind}-${i}`}>
              <span className={yours ? "mk-y" : "mk-o"} aria-hidden="true" />
              <span className="next-what">{gateLabel(g.gate)}</span>
              {/* The engine's own observation ("2 open", "pending (human only)")
                  — straight from the evaluator rather than recomputed here
                  where it could disagree with the gate. */}
              <span className="next-obs" title={g.observed}>
                {g.observed}
              </span>
              {dest !== null && (
                <button className="btn btn-small" onClick={dest.run}>
                  {dest.label}
                  <IconArrowRight size={12} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
