import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../../api";
import { useGuardedMutation, useWorkspaceData } from "../../hooks";
import { Check } from "../../components/controls";
import EmptyState from "../../components/EmptyState";
import { IconCheck, IconClock } from "../../components/icons";
import type { Milestone, ProjectContext } from "../../types";
import ConfirmDanger from "../../components/ConfirmDanger";

interface Props {
  refreshKey: number;
  onMutated: () => void;
}

export default function MilestonePanel({ refreshKey, onMutated }: Props) {
  const { t } = useTranslation();
  const {
    data: context,
    setData: setContext,
    error,
    setError,
  } = useWorkspaceData<ProjectContext>(() => api.getContext(), refreshKey);
  const [title, setTitle] = useState("");
  /** Milestone awaiting delete confirmation — its id is never reused, so
      the removal cannot be undone by re-adding it. */
  const [confirmRemove, setConfirmRemove] = useState<Milestone | null>(null);

  // One instance for the whole panel: ticking one milestone locks the others,
  // which is the existing scope and is deliberate (the mutations all rewrite
  // the same context document).
  const { busy, run } = useGuardedMutation(setError);

  /** Runs a milestone mutation; resolves true only when it actually landed —
   *  callers clear their input on that, so it must not resolve true on error. */
  function mutate(action: () => Promise<ProjectContext>): Promise<boolean> {
    return run(async () => {
      setError(null);
      setContext(await action());
      onMutated();
    });
  }

  const milestones = context?.milestones ?? [];
  const doneCount = milestones.filter((m) => m.done).length;
  // Completed milestones collapse by default (they only accumulate — M-ids
  // are never recycled), so the panel height tracks open work, not history.
  const [showDone, setShowDone] = useState(false);
  const shownMilestones = showDone ? milestones : milestones.filter((m) => !m.done);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">
          {t("milestones.heading")}
          {milestones.length > 0 && (
            <span className="sub num">
              {doneCount}/{milestones.length}
            </span>
          )}
        </h2>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {context === null ? null : milestones.length === 0 ? (
        <EmptyState title={t("milestones.empty")} hint={t("milestones.emptyHint")} />
      ) : (
        <div className="milestones">
          {shownMilestones.map((m) => (
            <div key={m.id} className={`milestone ${m.done ? "done" : ""}`}>
              <Check
                checked={m.done}
                disabled={busy}
                ariaLabel={m.title}
                onChange={(checked) => void mutate(() => api.setMilestoneDone(m.id, checked))}
              />
              <span className="m-text">{m.title}</span>
              <span className="m-id">{m.id}</span>
              {m.done && (
                // Marks from `icons.tsx`, not ✓/⏳: emoji pick up the platform's
                // colour font, so the weight of a status mark stops being the
                // design system's call (2026-08-01 UI review, P2 2-5).
                <button
                  className="btn btn-ghost btn-small"
                  disabled={busy}
                  title={m.verified ? t("milestones.clearVerified") : t("milestones.markVerified")}
                  aria-label={`${
                    m.verified ? t("milestones.clearVerified") : t("milestones.markVerified")
                  } — ${m.title}`}
                  onClick={() => void mutate(() => api.setMilestoneVerified(m.id, !m.verified))}
                >
                  {m.verified ? <IconCheck size={12} /> : <IconClock size={12} />}
                  {m.verified ? t("milestones.verified") : t("milestones.unverified")}
                </button>
              )}
              <button
                className="btn btn-ghost btn-small danger-trigger"
                disabled={busy}
                aria-label={`${t("common.delete")} — ${m.title}`}
                onClick={() => setConfirmRemove(m)}
              >
                {t("common.delete")}
              </button>
            </div>
          ))}
          {doneCount > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-small m-done-toggle"
              onClick={() => setShowDone((v) => !v)}
            >
              {showDone
                ? t("milestones.hideDone")
                : t("milestones.showDone", { n: doneCount })}
            </button>
          )}
        </div>
      )}

      <div className="milestone-add">
        <input
          value={title}
          aria-label={t("milestones.placeholder")}
          placeholder={t("milestones.placeholder")}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && title.trim() !== "") {
              void mutate(() => api.addMilestone(title)).then((ok) => {
                if (ok) setTitle("");
              });
            }
          }}
        />
        {/* Panel action, not the page's — see the note in WorkflowPanel. */}
        <button
          className="btn"
          disabled={busy || title.trim() === ""}
          onClick={() =>
            void mutate(() => api.addMilestone(title)).then((ok) => {
              if (ok) setTitle("");
            })
          }
        >
          {t("milestones.add")}
        </button>
      </div>
      {confirmRemove !== null && (
        <ConfirmDanger
          heading={t("milestones.deleteHeading")}
          body={t("milestones.deleteBody", { title: confirmRemove.title })}
          confirmLabel={t("common.delete")}
          busy={busy}
          onConfirm={() =>
            void mutate(() => api.removeMilestone(confirmRemove.id)).then(() =>
              setConfirmRemove(null),
            )
          }
          onCancel={() => setConfirmRemove(null)}
        />
      )}

    </section>
  );
}
