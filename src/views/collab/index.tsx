import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../../api";
import { useGuardedMutation, useWorkspaceData } from "../../hooks";
import { useFreshKeys, usePulse } from "../../hooks/anim";
import EmptyState from "../../components/EmptyState";
import ErrorBar from "../../components/ErrorBar";
import EventMessage from "../../components/EventMessage";
import Scramble from "../../components/Scramble";
import TimeAgo from "../../components/TimeAgo";
import { IconCaretDown, IconCheck, IconLock } from "../../components/icons";
import { centreOf, fx, motionOff, type Point } from "../../lib/fx";
import { eventKey, isDeniedCall } from "../../lib/ledger";
import type { LedgerEvent, Task, TaskStatus } from "../../types";
import { boardDiff, diffSignature, isQuiet, unresolvedDeps, type BoardDiff } from "./model";
import * as mo from "./motion";

interface Props {
  refreshKey: number;
  onMutated: () => void;
}

/** Select sentinel for "type a new assignee name" (cannot collide with real names in practice). */
const CUSTOM = "__custom__";
const UNASSIGNED = "__unassigned__";

/**
 * Kind of a feed row. Denial recognition delegates to the single recognizer
 * in ledger.ts (D75); the "everything else is an assignment" floor is
 * feed-local policy — this list only ever shows agent calls and assignments.
 * Violet is the agent's call, amber a call that was turned away (it waits on
 * your grant), ink a reassignment (D153 R7).
 */
function feedCat(event: LedgerEvent): "tool" | "deny" | "assign" {
  if (event.kind === "agent_tool_called") {
    return isDeniedCall(event) ? "deny" : "tool";
  }
  return "assign";
}

/** The status on a card: a mark and the word (9(a)), as spec 60 draws it. */
const MARK: Record<TaskStatus, string> = {
  todo: "mk-o",
  in_progress: "dot-run",
  blocked: "mk-y",
  done: "mk-e",
  cancelled: "mk-x",
};

function CardStatus({ status }: { status: TaskStatus }) {
  const { t } = useTranslation();
  // C163: the mark springs in when the status actually changes.
  const pop = usePulse(status, 520);
  return (
    <span className={`kb-st is-${status}${pop ? " pop" : ""}`}>
      <i className={MARK[status]} aria-hidden="true" />
      {t(`status.${status}`)}
    </span>
  );
}

/** Where a write of ours started, so C162's light can leave from it. */
interface Own {
  id: string;
  at: number;
  from: Point | null;
}

export default function Collab({ refreshKey, onMutated }: Props) {
  const { t } = useTranslation();
  // Board and feed share one load path so a refresh is all-or-nothing
  // (assignments write ledger events, so both must move together).
  const { data, error, setError, reload, loading } = useWorkspaceData<{
    tasks: Task[];
    events: LedgerEvent[];
  }>(
    async () => ({
      tasks: await api.listTasks(),
      events: await api.recentEvents(40),
    }),
    refreshKey,
  );

  // What the board draws. It trails `data` on purpose: a change is measured
  // on the board as it was, then applied, so the cards can fly from where
  // they were (C162–C164). Without motion it follows `data` at once.
  const [board, setBoard] = useState<Task[] | null>(null);
  const boardRef = useRef<Task[] | null>(null);
  boardRef.current = board;
  // C163: a card whose last dependency just finished keeps showing the lock
  // until the light from that dependency reaches it.
  const [held, setHeld] = useState<ReadonlyMap<string, string[]>>(() => new Map());
  const [depIn, setDepIn] = useState<ReadonlySet<string>>(() => new Set());
  // C161: the waiting card under the pointer (or the keyboard).
  const [hover, setHover] = useState<string | null>(null);

  // Inline "custom assignee" prompt for one card at a time.
  const [customTarget, setCustomTarget] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  // Columns folded away by the reader. Held per view visit, not persisted: the
  // board is read at a glance, and which people are beside the point today is
  // a fact about this glance rather than a setting (2026-08-01 UI review, P3).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const { busy, run } = useGuardedMutation(setError);

  const colsRef = useRef<HTMLDivElement>(null);
  const wiresRef = useRef<SVGSVGElement>(null);
  const feedRef = useRef<HTMLUListElement>(null);

  // ── Motion plumbing ─────────────────────────────────────────────────────
  // Work to do once the next commit is on screen (the "after" half of a FLIP).
  const afterCommit = useRef<(() => void)[]>([]);
  useLayoutEffect(() => {
    const queue = afterCommit.current;
    if (queue.length === 0) return;
    afterCommit.current = [];
    for (const fn of queue) fn();
  });
  const timers = useRef<number[]>([]);
  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };
  const cancelTimers = () => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  };
  const foldTimer = useRef(0);
  const own = useRef<Own | null>(null);
  // The change being played right now, and the newest read for it to land.
  const playing = useRef<string | null>(null);
  const latest = useRef<Task[] | null>(null);
  useEffect(
    () => () => {
      cancelTimers();
      window.clearTimeout(foldTimer.current);
      mo.settle();
      fx.clear();
    },
    [],
  );

  // Entering from the sidebar: the columns rise one after another. Not when a
  // page frame is the arrival, and only on the mount — a reload is not one.
  const [entering, setEntering] = useState(false);
  useEffect(() => {
    if (motionOff() || document.querySelector(".pt-veil") !== null) return;
    setEntering(true);
    const timer = window.setTimeout(() => setEntering(false), 1400);
    return () => window.clearTimeout(timer);
  }, []);

  /**
   * Puts `next` on the board. Everything is measured first, on the board as
   * it still is; the motion runs once React has committed the new one.
   */
  function applyBoard(next: Task[], diff: BoardDiff, mine: Own | null) {
    const root = colsRef.current;
    const cards = mo.boxes(root, "data-kb-task");
    const cols = mo.boxes(root, "data-kb-col");
    afterCommit.current.push(() => {
      playing.current = null;
      const r = colsRef.current;
      if (r === null) return;
      const moved = new Set(diff.moved);
      const targets = mo.boxes(r, "data-kb-task");
      const fresh = cols.size === 0 ? [] : [...mo.boxes(r, "data-kb-col").keys()].filter((k) => !cols.has(k));
      mo.flip(r, "data-kb-task", cards, { skip: moved, delay: 80 });
      mo.flip(r, "data-kb-col", cols, { skip: new Set(fresh) });
      // C164: a new person gets an empty column first; the card flies in after.
      let wait = 0;
      for (const k of fresh) wait = Math.max(wait, mo.openCol(mo.colEl(r, k)));
      for (const id of diff.moved.slice(0, 6)) {
        const card = mo.cardEl(r, id);
        const end = mo.fly(card, cards.get(id), wait, targets.get(id));
        if (end === 0) mo.sweep(card);
        else if (mine?.id === id && mine.from !== null) {
          fx.beam(mine.from, centreOf(card), {
            dur: Math.max(480, end - wait - 60),
            delay: wait,
            bend: -0.16,
            width: 2.4,
          });
        }
      }
      for (const id of diff.arrived) mo.sweep(mo.cardEl(r, id));

      // C163: light runs from the finished card to each lock it opened; the
      // lock shrinks away and "ready" slides up in its place.
      if (diff.unlocks.length === 0) return;
      later(380, () => {
        const r2 = colsRef.current;
        for (const u of diff.unlocks) {
          const lock = mo.cardEl(r2, u.waiter)?.querySelector("[data-kb-lock]") ?? null;
          for (const by of u.was) mo.wire(wiresRef.current, mo.cardEl(r2, by), lock, { run: true, dur: 760 });
        }
      });
      later(1140, () => {
        for (const u of diff.unlocks) mo.dropLock(mo.cardEl(colsRef.current, u.waiter));
      });
      later(1330, () => {
        setHeld(new Map());
        setDepIn(new Set(diff.unlocks.map((u) => u.waiter)));
        later(700, () => setDepIn(new Set()));
      });
    });
    setBoard(next);
    setHeld(new Map(diff.unlocks.map((u) => [u.waiter, u.was])));
    setDepIn(new Set());
  }

  // A fresh read reaches the board here, never directly.
  useEffect(() => {
    if (data === null) return;
    const next = data.tasks;
    latest.current = next;
    const prev = boardRef.current;
    if (prev === null || motionOff()) {
      cancelTimers();
      playing.current = null;
      own.current = null;
      setBoard(next);
      setHeld(new Map());
      return;
    }
    const diff = boardDiff(prev, next);
    if (isQuiet(diff)) {
      // Nothing to play (a watcher re-read, or a card that left): swap in
      // place — the rest slide up over a card that was archived — and leave
      // whatever is in flight alone.
      if (playing.current === null) {
        const cards = mo.boxes(colsRef.current, "data-kb-task");
        afterCommit.current.push(() => mo.flip(colsRef.current, "data-kb-task", cards, { dur: 320 }));
        setBoard(next);
      }
      return;
    }
    const sig = diffSignature(diff, next);
    // The same change read a second time (our write, then the watcher):
    // the one already playing will land the newest read.
    if (sig === playing.current) return;
    cancelTimers();
    mo.settle();
    playing.current = sig;

    const o = own.current;
    const mine = o !== null && performance.now() - o.at < 5000 && diff.moved.includes(o.id) ? o : null;
    if (mine !== null) own.current = null;
    const apply = () => applyBoard(latest.current ?? next, diff, mine);

    if (mine !== null) {
      // Our own pick: the light leaves the control and leads the card.
      later(120, apply);
      return;
    }
    // Claimed through the hub: the light leaves the actor on the feed row
    // that reported it, and the card takes off when it arrives.
    const rows = diff.moved
      .slice(0, 6)
      .map((id) => ({ id, row: claimRow(feedRef.current, id) }))
      .filter((x) => x.row !== null);
    if (rows.length === 0) {
      apply();
      return;
    }
    later(260, () => {
      for (const { id, row } of rows) {
        fx.beam(centreOf(row), centreOf(mo.cardEl(colsRef.current, id)), { dur: 520, bend: 0.18, width: 2.4 });
      }
    });
    later(760, apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const shown = board ?? [];
  const byId = new Map(shown.map((task) => [task.id, task]));
  const unresolvedOf = (task: Task) => held.get(task.id) ?? unresolvedDeps(task, byId);

  // Column set = "unassigned" first, then the deduped union of assignees.
  const assignees = [
    ...new Set(shown.map((task) => task.assignee).filter((a): a is string => !!a)),
  ].sort((a, b) => a.localeCompare(b));
  const columns: { label: string; assignee: string | null }[] = [
    { label: t("collab.unassigned"), assignee: null },
    ...assignees.map((a) => ({ label: a, assignee: a })),
  ];

  // C161: what the hovered card waits on lights up, and a wire runs from
  // each of those to its lock.
  const hovered = hover === null ? undefined : byId.get(hover);
  const lit = hovered === undefined ? [] : unresolvedOf(hovered);
  const litKey = lit.join(" ");
  useLayoutEffect(() => {
    if (hover === null || litKey === "") return;
    const root = colsRef.current;
    const lock = mo.cardEl(root, hover)?.querySelector("[data-kb-lock]") ?? null;
    if (lock === null) return;
    const made = litKey
      .split(" ")
      .map((id) => mo.wire(wiresRef.current, mo.cardEl(root, id), lock))
      .filter((g): g is SVGGElement => g !== null);
    return () => {
      for (const g of made) g.remove();
    };
  }, [hover, litKey, board, collapsed]);

  // Agent activity: hub tool calls (skipping ones without a self-declared
  // actor) plus every assignment change; newest first like the Dashboard.
  const feed = [...(data?.events ?? [])]
    .filter(
      (ev) =>
        (ev.kind === "agent_tool_called" && ev.actor != null) ||
        ev.kind === "task_assignee_changed",
    )
    .reverse();
  const freshFeed = useFreshKeys(feed.map(eventKey));

  function assign(id: string, assignee: string | null, from: Element | null) {
    return run(async () => {
      setError(null);
      own.current = { id, at: performance.now(), from: centreOf(from) };
      await api.assignTask(id, assignee);
      setCustomTarget(null);
      setCustomName("");
      await reload();
      onMutated();
    });
  }

  function onAssigneeSelect(task: Task, value: string, el: HTMLSelectElement) {
    if (value === CUSTOM) {
      setCustomTarget(task.id);
      setCustomName("");
      return;
    }
    const next = value === "" ? null : value;
    if (next === (task.assignee ?? null)) return;
    if (customTarget === task.id) setCustomTarget(null);
    void assign(task.id, next, el);
  }

  // C165: folding tucks the cards up into the head first, then the column
  // narrows and the ones to its right slide over; unfolding is the reverse.
  function toggleFold(key: string) {
    if (foldTimer.current !== 0) return;
    const folding = !collapsed.has(key);
    const commit = () => {
      foldTimer.current = 0;
      const before = mo.boxes(colsRef.current, "data-kb-col");
      afterCommit.current.push(() => {
        mo.flip(colsRef.current, "data-kb-col", before, { skip: new Set([key]), dur: 380 });
        if (!folding) mo.dropCards(mo.colEl(colsRef.current, key));
      });
      setCollapsed((cur) => {
        const next = new Set(cur);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    };
    const wait = folding ? mo.tuckCards(mo.colEl(colsRef.current, key)) : 0;
    if (wait === 0) commit();
    else foldTimer.current = window.setTimeout(commit, wait);
  }

  // C161 follows the pointer, and the keyboard: tabbing onto a waiting
  // card's select lights it the same way. Typing a name does not count.
  function lockedCardAt(target: EventTarget | null): string | null {
    if (!(target instanceof Element) || target.matches(".kb-cp input")) return null;
    return target.closest<HTMLElement>(".kb-card.is-locked")?.dataset.kbTask ?? null;
  }

  const hl = new Set(lit);
  const loaded = !loading && board !== null;

  return (
    <div className={`view kb${entering ? " kb-enter" : ""}`}>
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("collab.heading")}</h1>
          <p className="view-sub">{t("collab.subtitle")}</p>
        </div>
      </header>

      <ErrorBar error={error} />

      <div className="kb-body">
        <section className="panel kb-boardp" aria-label={t("collab.board")}>
          <div className="panel-head">
            <h2 className="panel-title">
              {t("collab.board")}
              <span className="sub">{t("collab.boardSub")}</span>
            </h2>
          </div>
          <p className="kb-hint">{t("collab.boardHint")}</p>
          {!loaded ? null : shown.length === 0 ? (
            <EmptyState title={t("collab.emptyBoard")} hint={t("collab.emptyBoardHint")} />
          ) : (
            <div className="kb-scroll">
              <div
                className="kb-cols"
                ref={colsRef}
                onPointerOver={(e) => {
                  const id = lockedCardAt(e.target);
                  if (id !== null && id !== hover) setHover(id);
                }}
                onPointerOut={(e) => {
                  if (hover === null) return;
                  const card = mo.cardEl(colsRef.current, hover);
                  if (card !== null && e.relatedTarget instanceof Node && card.contains(e.relatedTarget)) return;
                  setHover(null);
                }}
                onFocus={(e) => setHover(lockedCardAt(e.target))}
                onBlur={(e) => {
                  if (!(e.relatedTarget instanceof Node) || !colsRef.current?.contains(e.relatedTarget)) {
                    setHover(null);
                  }
                }}
              >
                {columns.map((col, k) => {
                  // Archived tasks stay out of the board (D40); byId keeps the
                  // full set so dependency lookups still resolve archived deps.
                  const colTasks = shown.filter(
                    (task) => !task.archived && (task.assignee ?? null) === col.assignee,
                  );
                  const colKey = col.assignee ?? UNASSIGNED;
                  const isCollapsed = collapsed.has(colKey);
                  const style: Record<string, number> = { "--k": k };
                  return (
                    <div
                      className={`kb-col${isCollapsed ? " is-fold" : ""}`}
                      key={colKey}
                      data-kb-col={colKey}
                      style={style}
                    >
                      {/* The head is the fold control (2026-08-01 UI review, P3-1):
                          one column per assignee at a fixed width means a team of a
                          dozen is a horizontal scroll with no way to put the people
                          you are not looking at aside. The count stays visible when
                          folded — that is the part worth keeping at a glance. */}
                      <button
                        type="button"
                        className="kb-ch"
                        aria-expanded={!isCollapsed}
                        aria-label={t(isCollapsed ? "collab.expandColumn" : "collab.collapseColumn", {
                          name: col.label,
                        })}
                        onClick={() => toggleFold(colKey)}
                      >
                        <IconCaretDown size={13} className="kb-caret" />
                        <span className="kb-cn">{col.label}</span>
                        <Scramble className="kb-cc" value={colTasks.length} />
                      </button>
                      {!isCollapsed &&
                        colTasks.map((task) => {
                          const deps = task.dependsOn ?? [];
                          const unresolved = unresolvedOf(task);
                          const locked = deps.length > 0 && unresolved.length > 0;
                          return (
                            <div
                              key={task.id}
                              data-kb-task={task.id}
                              className={`kb-card is-${task.status}${locked ? " is-locked" : ""}${
                                hl.has(task.id) ? " kb-hl" : ""
                              }`}
                            >
                              <div className="kb-t">{task.title}</div>
                              <div className="kb-meta">
                                <span className="kb-id mono">{task.id}</span>
                                <span className={`pr pr--p${Math.min(task.priority, 2)}`}>P{task.priority}</span>
                                <CardStatus status={task.status} />
                              </div>
                              {deps.length > 0 &&
                                (locked ? (
                                  <div className="kb-dep is-locked">
                                    <i className="kb-dep-i" data-kb-lock="" aria-hidden="true">
                                      <IconLock size={12} />
                                    </i>
                                    {t("collab.depsLocked")}
                                    <span className="mono">{unresolved.join(", ")}</span>
                                  </div>
                                ) : (
                                  <div className={`kb-dep is-ready${depIn.has(task.id) ? " in" : ""}`}>
                                    <i className="kb-dep-i" aria-hidden="true">
                                      <IconCheck size={12} />
                                    </i>
                                    {t("collab.depsReady")}
                                    <span className="mono">{deps.join(", ")}</span>
                                  </div>
                                ))}
                              <select
                                value={customTarget === task.id ? CUSTOM : (task.assignee ?? "")}
                                onChange={(e) => onAssigneeSelect(task, e.target.value, e.currentTarget)}
                                aria-label={`${task.id} assignee`}
                                disabled={busy}
                              >
                                <option value="">{t("collab.unassigned")}</option>
                                {assignees.map((a) => (
                                  <option key={a} value={a}>
                                    {a}
                                  </option>
                                ))}
                                <option value={CUSTOM}>{t("collab.custom")}</option>
                              </select>
                              {customTarget === task.id && (
                                <div className="kb-cp">
                                  <input
                                    autoFocus
                                    autoComplete="off"
                                    value={customName}
                                    onChange={(e) => setCustomName(e.target.value)}
                                    aria-label={t("collab.customPlaceholder")}
                                    placeholder={t("collab.customPlaceholder")}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-small"
                                    onClick={() => {
                                      setCustomTarget(null);
                                      setCustomName("");
                                    }}
                                  >
                                    {t("common.cancel")}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-small btn-primary"
                                    disabled={busy || customName.trim() === ""}
                                    onClick={(e) => void assign(task.id, customName.trim(), e.currentTarget)}
                                  >
                                    {t("collab.confirmAssign")}
                                  </button>
                                </div>
                              )}
                              {task.status === "in_progress" && <i className="kb-run" aria-hidden="true" />}
                            </div>
                          );
                        })}
                    </div>
                  );
                })}
                <svg className="kb-wires" ref={wiresRef} aria-hidden="true" />
              </div>
            </div>
          )}
        </section>

        <section className="panel kb-feedp" aria-label={t("collab.feed")}>
          <div className="panel-head">
            <h2 className="panel-title">
              {t("collab.feed")}
              <span className="sub">{t("collab.feedSub")}</span>
            </h2>
          </div>
          {!loaded ? null : feed.length === 0 ? (
            <EmptyState title={t("collab.feedEmpty")} hint={t("collab.feedEmptyHint")} />
          ) : (
            <ul className="kb-evs" ref={feedRef}>
              {feed.map((event, i) => {
                const key = eventKey(event);
                const cat = feedCat(event);
                return (
                  <li
                    key={`${key}-${i}`}
                    className={`kb-ev${freshFeed.has(key) ? " in" : ""}`}
                    data-cat={cat}
                    data-ev-kind={event.kind}
                    data-ev-task={event.taskId ?? undefined}
                  >
                    <TimeAgo className="kb-et" at={event.at} />
                    <span className={`kb-ek is-${cat}`}>{t(`ledger.${event.kind}`)}</span>
                    <span className="kb-em">
                      <EventMessage
                        actor={event.actor ?? t("collab.actorGui")}
                        taskId={event.taskId}
                        message={event.message}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** The actor on the newest feed row that reported `id` changing hands. */
function claimRow(feed: HTMLElement | null, id: string): Element | null {
  const row = feed?.querySelector(
    `li[data-ev-kind="task_assignee_changed"][data-ev-task="${CSS.escape(id)}"]`,
  );
  return row?.querySelector(".actor-chip") ?? row ?? null;
}
