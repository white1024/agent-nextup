import { useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { usePulse } from "../../hooks/anim";
import TimeAgo from "../../components/TimeAgo";
import { IconArchive, IconDoc, IconPencil, IconTrash, IconX } from "../../components/icons";
import type { Task, TaskStatus } from "../../types";

export const STATUSES: TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];

/** The two statuses that ask for a reason first, in the same inline prompt. */
export type ReasonStatus = "blocked" | "cancelled";

/** Everything a row can ask its page to do. One object, so the row's props
 *  stay readable and the page owns every write (invariant 8: one path per
 *  dimension — the row only asks). */
export interface RowActions {
  open: (id: string) => void;
  close: (id: string) => void;
  tag: (tag: string) => void;
  status: (task: Task, status: TaskStatus) => void;
  markVerify: (id: string) => void;
  unverify: (id: string) => void;
  archive: (task: Task) => void;
  /** Tick or untick step `step` (1-based) of the task's checklist (D170). */
  step: (task: Task, step: number, done: boolean) => void;
  edit: (task: Task) => void;
  remove: (task: Task) => void;
  nudgeVerify: (id: string) => void;
  nudgeLater: () => void;
  nudgeNever: () => void;
  blockCancel: () => void;
  blockConfirm: (id: string) => void;
  verifyCancel: () => void;
  verifyConfirm: (id: string) => void;
}

interface Props {
  task: Task;
  /** Place in the list, for the page-entry stagger (`--j`). */
  index: number;
  open: boolean;
  fresh: boolean;
  /** Swept with light once (an edit just landed, C216). */
  lit: boolean;
  tagFilter: string;
  mutating: boolean;
  nudge: boolean;
  blocking: boolean;
  /** Which status the reason prompt is asking for. */
  blockAs: ReasonStatus;
  blockReason: string;
  setBlockReason: (v: string) => void;
  verifying: boolean;
  verifyNote: string;
  setVerifyNote: (v: string) => void;
  act: RowActions;
}

/**
 * The status mark beside the select (R7 as D153 took it): a hollow square for
 * not started, the agent's violet dot while in progress, the amber circle for
 * anything waiting on you — blocked, and done but not yet verified — and the
 * cyan square once verification says it is through, and a struck-through
 * square for work that will not happen (D169). The word is the select next to
 * it, so the mark itself is decoration to a screen reader.
 */
function Mark({ task, turn }: { task: Task; turn: boolean }) {
  const cls =
    task.status === "cancelled"
      ? "mk-x"
      : task.status === "blocked"
      ? "mk-y"
      : task.status === "done"
        ? task.verifiedAt
          ? "mk-e"
          : "mk-y"
        : task.status === "in_progress"
          ? "dot-run"
          : "mk-o";
  return <i className={`${cls} tr-mk${turn ? " mk-turn" : ""}`} aria-hidden="true" />;
}

/** P0 solid ink, P1 a firmer frame, the rest quiet — urgency without borrowing
 *  a status colour (spec 30's mark table). */
function Prio({ p }: { p: number }) {
  return <span className={`pr pr--p${Math.min(p, 2)}`}>P{p}</span>;
}

/**
 * One task: a four-column row, or — when `open` — the same task unfolded in
 * place as a card (C25). Both forms render the same controls; the card only
 * has room to give them words. They share one `<li>` so the list's keys and
 * the page's motion bookkeeping (`data-row`) never change identity.
 *
 * Everything that moves here moves on a diff (`usePulse`), not on render: the
 * mark turns when the status or the verification changes, from this window or
 * from an agent's write alike.
 */
export default function TaskRow({
  task,
  index,
  open,
  fresh,
  lit,
  tagFilter,
  mutating,
  nudge,
  blocking,
  blockAs,
  blockReason,
  setBlockReason,
  verifying,
  verifyNote,
  setVerifyNote,
  act,
}: Props) {
  const { t } = useTranslation();
  const [descOpen, setDescOpen] = useState(false);
  const verified = Boolean(task.verifiedAt);
  const done = task.status === "done";
  const closed = done || task.status === "cancelled";

  // C26 / C274 / C275 / C276: the mark turns on any change of what it shows.
  const turn = usePulse(`${task.status}/${verified ? 1 : 0}`, 620);
  const verifyFlip = usePulse(verified, 900);
  const statusFlip = usePulse(task.status, 900);
  const archFlip = usePulse(task.archived, 700);
  const verifiedIn = verifyFlip && verified;
  const unverifiedIn = verifyFlip && !verified && done;
  const blockedIn = statusFlip && task.status === "blocked";

  const cls = [
    "tr",
    `is-${task.status}`,
    done && !verified ? "is-unv" : "",
    task.archived ? "is-arch" : "",
    open ? "is-open" : "",
    fresh ? "tr--new" : "",
    lit || verifiedIn ? "tr--lit" : "",
    verifiedIn ? "tr--ver-in" : "",
    unverifiedIn ? "tr--unver-in" : "",
    blockedIn && !open ? "tr--block-in" : "",
    archFlip ? (task.archived ? "tr--dim-in" : "tr--dim-out") : "",
  ]
    .filter(Boolean)
    .join(" ");

  const select = (
    <select
      className="tr-sel"
      value={task.status}
      disabled={mutating}
      onChange={(e) => act.status(task, e.target.value as TaskStatus)}
      aria-label={`${task.id} ${t("tasks.colStatus")}`}
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {t(`status.${s}`)}
        </option>
      ))}
    </select>
  );

  const tags = (chip: boolean) =>
    task.tags.map((tag) => (
      <button
        key={tag}
        className={`tkx-tag${chip ? " tkx-tag--chip" : ""}${tagFilter === tag ? " is-on" : ""}`}
        aria-pressed={tagFilter === tag}
        onClick={() => act.tag(tag)}
      >
        {tag}
      </button>
    ));

  // Blocked: what it waits on, and since when — nothing re-checks a reason, so
  // its age is the only cue that the blocker may already be gone. Cancelled:
  // what replaced it (D169), the only record of where the work went.
  const reason =
    task.status === "cancelled" && task.cancelReason ? (
      <div className="tr-why tr-why--x" data-reason>
        <i className="mk-x" aria-hidden="true" />
        <span>
          <b>{t("status.cancelled")}</b>
          <span className="tr-why-text">{task.cancelReason}</span>
        </span>
      </div>
    ) : task.status === "blocked" && task.blockedReason ? (
      <div className="tr-why" data-reason>
        <i className="mk-y" aria-hidden="true" />
        <span>
          <b>{t("status.blocked")}</b>
          {task.blockedAt && (
            <>
              {" · "}
              <TimeAgo at={task.blockedAt} className="tr-why-age" />
            </>
          )}
          <span className="tr-why-text">{task.blockedReason}</span>
        </span>
      </div>
    ) : null;

  const verCell = verified ? (
    <span className="v v--ok">
      <i className="mk-e" aria-hidden="true" />
      {t("tasks.verified")}
    </span>
  ) : (
    <>
      <span className="v v--you">
        <i className="mk-y" aria-hidden="true" />
        {t("tasks.unverified")}
      </span>
      <button className="btn btn-small tr-verify" onClick={() => act.markVerify(task.id)}>
        {t("tasks.markVerified")}
      </button>
    </>
  );

  // Evidence is agent-written and can run long: one line in the row with the
  // full text on hover, up to three in the card (D65's clamp, kept there).
  const evidence = (wrap: boolean) =>
    verified ? (
      <>
        {task.verifiedNote && (
          <span className={`tkx-note${wrap ? " tkx-note--wrap" : ""}`} title={task.verifiedNote}>
            {task.verifiedNote}
          </span>
        )}
        <button
          className="btn btn-ghost btn-small tkx-unver"
          disabled={mutating}
          onClick={() => act.unverify(task.id)}
        >
          {t("tasks.clearVerified")}
        </button>
      </>
    ) : null;

  const pills =
    task.specFoldedAt || task.archived ? (
      <span className="tkx-pills">
        {task.specFoldedAt && (
          <span className="tkx-pill" title={task.specFoldedAt}>
            <IconDoc size={12} className="i" />
            {t("tasks.specFolded")}
          </span>
        )}
        {task.archived && (
          <span className="tkx-pill tkx-pill--arch">
            <IconArchive size={12} className="i" />
            {t("tasks.archived")}
          </span>
        )}
      </span>
    ) : null;

  // The inline prompts under the title (C273), in the order they always had.
  const below: ReactNode[] = [];
  if (nudge) {
    below.push(
      <div className="tkx-nudge" data-prompt="nudge" key="nudge">
        <div className="tkx-nudge-t">
          <i className="mk-y" aria-hidden="true" />
          <span>{t("tasks.nudgeTitle")}</span>
        </div>
        <p>{t("tasks.nudgeBody")}</p>
        <div className="tkx-nudge-a">
          <button className="btn btn-small btn-primary" onClick={() => act.nudgeVerify(task.id)}>
            {t("tasks.nudgeVerify")}
          </button>
          <button className="btn btn-small" onClick={act.nudgeLater}>
            {t("tasks.nudgeLater")}
          </button>
          <button className="btn btn-ghost btn-small" onClick={act.nudgeNever}>
            {t("tasks.nudgeNever")}
          </button>
        </div>
      </div>,
    );
  }
  if (blocking) {
    below.push(
      <div className="tkx-prompt" data-prompt="block" key="block">
        <input
          autoFocus
          value={blockReason}
          onChange={(e) => setBlockReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && blockReason.trim() !== "" && !mutating) act.blockConfirm(task.id);
          }}
          aria-label={t(blockAs === "cancelled" ? "tasks.cancelReasonPlaceholder" : "tasks.blockReasonPlaceholder")}
          placeholder={t(blockAs === "cancelled" ? "tasks.cancelReasonPlaceholder" : "tasks.blockReasonPlaceholder")}
        />
        <button className="btn btn-small" onClick={act.blockCancel}>
          {t("common.cancel")}
        </button>
        <button
          className="btn btn-small btn-primary"
          disabled={blockReason.trim() === "" || mutating}
          onClick={() => act.blockConfirm(task.id)}
        >
          {t(blockAs === "cancelled" ? "tasks.confirmCancelTask" : "tasks.confirmBlock")}
        </button>
      </div>,
    );
  }
  if (verifying) {
    below.push(
      <div className="tkx-prompt" data-prompt="verify" key="verify">
        <input
          autoFocus
          value={verifyNote}
          onChange={(e) => setVerifyNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && verifyNote.trim() !== "" && !mutating) act.verifyConfirm(task.id);
          }}
          aria-label={t("tasks.verifyNotePlaceholder")}
          placeholder={t("tasks.verifyNotePlaceholder")}
        />
        <button className="btn btn-small" onClick={act.verifyCancel}>
          {t("common.cancel")}
        </button>
        <button
          className="btn btn-small btn-primary"
          disabled={verifyNote.trim() === "" || mutating}
          onClick={() => act.verifyConfirm(task.id)}
        >
          {t("tasks.confirmVerify")}
        </button>
      </div>,
    );
  }

  const archiveLabel = task.archived ? t("tasks.unarchive") : t("tasks.archive");
  const actions = (words: boolean) => (
    <>
      <button
        className={`btn btn-ghost ${words ? "btn-small tc-btn" : "btn-icon"}`}
        title={words ? undefined : t("tasks.edit")}
        aria-label={`${task.id} ${t("tasks.edit")}`}
        onClick={() => act.edit(task)}
      >
        <IconPencil size={14} />
        {words && t("tasks.edit")}
      </button>
      {closed && (
        <button
          className={`btn btn-ghost ${words ? "btn-small tc-btn" : "btn-icon"}`}
          title={words ? undefined : archiveLabel}
          aria-label={`${task.id} ${archiveLabel}`}
          disabled={mutating}
          onClick={() => act.archive(task)}
        >
          <IconArchive size={14} />
          {words && archiveLabel}
        </button>
      )}
      <button
        className={`btn btn-ghost danger-trigger ${words ? "btn-small tc-btn" : "btn-icon"}`}
        title={words ? undefined : t("tasks.delete")}
        aria-label={`${task.id} ${t("tasks.delete")}`}
        onClick={() => act.remove(task)}
      >
        <IconTrash size={14} />
        {words && t("tasks.delete")}
      </button>
    </>
  );

  // The checklist (D170): a count on the row, the boxes in the card. Ticking
  // never touches the status select — the steps describe the work, they do
  // not claim it is done.
  const steps = task.steps ?? [];
  const stepsDone = steps.filter((s) => s.done).length;
  const stepCount =
    steps.length > 0 ? (
      <span className={`tkx-steps${stepsDone === steps.length ? " is-all" : ""}`}>
        {t("tasks.stepsCount", { done: stepsDone, total: steps.length })}
      </span>
    ) : null;
  const checklist =
    steps.length > 0 ? (
      <ol className="tc-steps" aria-label={t("tasks.stepsLabel")}>
        {steps.map((s, i) => (
          <li key={i} className={s.done ? "is-done" : ""}>
            <label>
              <input
                type="checkbox"
                checked={s.done}
                disabled={mutating}
                onChange={(e) => act.step(task, i + 1, e.target.checked)}
              />
              <span>{s.title}</span>
            </label>
          </li>
        ))}
      </ol>
    ) : null;

  const style = { "--j": index } as CSSProperties;

  if (open) {
    return (
      <li className={cls} data-row={task.id} data-vt-name={`r-${task.id}`} style={style}>
        <div
          className="tc"
          data-card={task.id}
          role="region"
          aria-label={`${task.id} ${task.title}`}
          tabIndex={-1}
        >
          <div className="tc-top">
            <span className="tr-id">{task.id}</span>
            <Prio p={task.priority} />
            {tags(true)}
            <button
              className="btn btn-ghost btn-icon tc-x"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={() => act.close(task.id)}
            >
              <IconX size={14} />
            </button>
          </div>
          <h3 className="tc-t">{task.title}</h3>
          {reason}
          <p className="tc-d">{task.description !== "" ? task.description : t("tasks.noDesc")}</p>
          {checklist}
          <div className="tc-row">
            <span className="tc-k">{t("tasks.colStatus")}</span>
            <span className="tc-v">
              <Mark task={task} turn={turn} />
              {select}
              {pills}
            </span>
            <span className="tc-k">{t("tasks.colVerify")}</span>
            <span className="tc-v">
              {done ? (
                <>
                  {verCell}
                  {evidence(true)}
                </>
              ) : (
                <span className="tc-none">—</span>
              )}
            </span>
          </div>
          {below.length > 0 && <div className="tkx-below">{below}</div>}
          <div className="tc-act">{actions(true)}</div>
        </div>
      </li>
    );
  }

  return (
    <li className={cls} data-row={task.id} data-vt-name={`r-${task.id}`} style={style}>
      <span className="tr-id">{task.id}</span>
      <div className="tr-body">
        <div className="tr-title">
          <Prio p={task.priority} />
          <button className="tr-open" aria-expanded={false} onClick={() => act.open(task.id)}>
            {task.title}
          </button>
          {stepCount}
        </div>
        {task.tags.length > 0 && <div className="tr-tags">{tags(false)}</div>}
        {reason}
        {task.description !== "" && (
          <details className="tr-desc" onToggle={(e) => setDescOpen(e.currentTarget.open)}>
            <summary>{descOpen ? t("tasks.descLess") : t("tasks.descMore")}</summary>
            <p>{task.description}</p>
          </details>
        )}
        {below.length > 0 && <div className="tkx-below">{below}</div>}
      </div>
      <div className="tr-st">
        <div className="tr-stl">
          <Mark task={task} turn={turn} />
          {select}
        </div>
        {done && <div className="tr-ver">{verCell}</div>}
        {verified && <div className="tkx-vrow tkx-line">{evidence(false)}</div>}
        {pills !== null && <div className="tkx-line">{pills}</div>}
      </div>
      <div className="tr-act">{actions(false)}</div>
    </li>
  );
}
