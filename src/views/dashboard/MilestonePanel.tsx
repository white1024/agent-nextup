import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";

import { api } from "../../api";
import { useGuardedMutation, useWorkspaceData } from "../../hooks";
import { Check } from "../../components/controls";
import EmptyState from "../../components/EmptyState";
import { IconX } from "../../components/icons";
import { usePulse } from "../../hooks/anim";
import { motionOff } from "../../lib/fx";
import { EASE_IN, EASE_OUT, fadeRowsOut, rowTops, slideRows } from "../../lib/listMotion";
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
  const panelRef = useRef<HTMLElement>(null);

  /**
   * C250 (my-design review F23): showing the completed ones lets the open
   * rows, the toggle, the add row and the cards below in the column slide to
   * their new places while the completed rows drop in one after another;
   * folding them fades those rows first, then everything slides back.
   */
  function toggleDone() {
    const sec = panelRef.current;
    if (sec === null || motionOff()) {
      setShowDone((v) => !v);
      return;
    }
    const before = rowTops(sec);
    const below = followingTops(sec);
    const done = milestones.filter((m) => m.done).map((m) => m.id);
    if (!showDone) {
      flushSync(() => setShowDone(true));
      slideRows(sec, before, { duration: 360, easing: EASE_OUT });
      slideFollowing(sec, below, { duration: 360, easing: EASE_OUT });
      done.forEach((id, i) =>
        sec.querySelector(`[data-row="${CSS.escape(id)}"]`)?.animate(
          [
            { opacity: 0, transform: "translateY(-8px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 340, delay: 70 + i * 60, easing: EASE_OUT, fill: "backwards" },
        ),
      );
      return;
    }
    const leaving = done.map((id) => sec.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`));
    const fades = leaving
      .filter((el): el is HTMLElement => el !== null)
      .map((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE_IN, fill: "forwards" }));
    void Promise.all(fades.map((a) => a.finished.catch(() => undefined))).then(() => {
      flushSync(() => setShowDone(false));
      slideRows(sec, before, { duration: 320, easing: EASE_OUT });
      slideFollowing(sec, below, { duration: 320, easing: EASE_OUT });
    });
  }

  /**
   * Deleting (C217, F23): once confirmed, the row fades where it stands, then
   * the rows after it and the cards below close the gap. The engine has
   * already removed it; only the showing waits.
   */
  function remove(m: Milestone) {
    return run(async () => {
      setError(null);
      const next = await api.removeMilestone(m.id);
      setConfirmRemove(null);
      const sec = panelRef.current;
      const before = rowTops(sec);
      const below = sec === null ? new Map<Element, number>() : followingTops(sec);
      await fadeRowsOut([sec?.querySelector<HTMLElement>(`[data-row="${CSS.escape(m.id)}"]`) ?? null]);
      flushSync(() => setContext(next));
      slideRows(sec, before, { duration: 340, easing: EASE_OUT });
      if (sec !== null) slideFollowing(sec, below, { duration: 340, easing: EASE_OUT });
      onMutated();
    });
  }

  return (
    <section className="panel" ref={panelRef}>
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
            <MilestoneRow
              key={m.id}
              m={m}
              busy={busy}
              onDone={(checked) => void mutate(() => api.setMilestoneDone(m.id, checked))}
              onVerify={() => void mutate(() => api.setMilestoneVerified(m.id, !m.verified))}
              onDelete={() => setConfirmRemove(m)}
            />
          ))}
          {doneCount > 0 && (
            <button
              type="button"
              data-row="__toggle"
              className="btn btn-ghost btn-small m-done-toggle"
              onClick={toggleDone}
            >
              {showDone
                ? t("milestones.hideDone")
                : t("milestones.showDone", { n: doneCount })}
            </button>
          )}
        </div>
      )}

      <div className="milestone-add" data-row="__add">
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
          onConfirm={() => void remove(confirmRemove)}
          onCancel={() => setConfirmRemove(null)}
        />
      )}

    </section>
  );
}

/**
 * One milestone (D153). The verification toggle is a quiet word — "unverified"
 * is neutral here, not amber: only a *task* done-but-unverified waits on the
 * user — and turning it pops the word and sweeps the row (C251), only when the
 * flag really changes. Delete is a ghost × that turns red on hover
 * (invariant 7's danger-trigger) and opens ConfirmDanger.
 */
function MilestoneRow({
  m,
  busy,
  onDone,
  onVerify,
  onDelete,
}: {
  m: Milestone;
  busy: boolean;
  onDone: (checked: boolean) => void;
  onVerify: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const flipped = usePulse(m.verified, 700);
  return (
    <div className={`milestone ${m.done ? "done" : ""}${flipped ? " milestone--flipped" : ""}`} data-row={m.id}>
      <Check checked={m.done} disabled={busy} ariaLabel={m.title} onChange={onDone} />
      <span className="m-text">{m.title}</span>
      <span className="m-id">{m.id}</span>
      {m.done && (
        <button
          className={`m-ver${m.verified ? " m-ver--ok" : ""}`}
          disabled={busy}
          title={m.verified ? t("milestones.clearVerified") : t("milestones.markVerified")}
          aria-label={`${m.verified ? t("milestones.clearVerified") : t("milestones.markVerified")} — ${m.title}`}
          onClick={onVerify}
        >
          {m.verified ? t("milestones.verified") : t("milestones.unverified")}
        </button>
      )}
      <button
        className="btn btn-ghost btn-icon danger-trigger"
        disabled={busy}
        title={t("common.delete")}
        aria-label={`${t("common.delete")} — ${m.title}`}
        onClick={onDelete}
      >
        <IconX size={13} />
      </button>
    </div>
  );
}

/** The cards after this one in its column, where they stand now. */
function followingTops(el: Element): Map<Element, number> {
  const out = new Map<Element, number>();
  for (let n = el.nextElementSibling; n !== null; n = n.nextElementSibling) out.set(n, n.getBoundingClientRect().top);
  return out;
}

/** Those cards play from where they stood. */
function slideFollowing(el: Element, before: Map<Element, number>, timing: KeyframeAnimationOptions) {
  for (const [n, top] of before) {
    if (!n.isConnected || n.parentElement !== el.parentElement) continue;
    const dy = top - n.getBoundingClientRect().top;
    if (Math.abs(dy) >= 1) n.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], timing);
  }
}
