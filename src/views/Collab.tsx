import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api";
import { useGuardedMutation, useWorkspaceData } from "../hooks";
import { useFreshKeys } from "../hooks/anim";
import EmptyState from "../components/EmptyState";
import EventMessage from "../components/EventMessage";
import StatusPill from "../components/StatusPill";
import { IconCaretDown, IconCheck, IconLock } from "../components/icons";
import { eventKey, isDeniedCall } from "../lib/ledger";
import type { LedgerEvent, Task } from "../types";
import { prioClass } from "./Tasks";
import TimeAgo from "../components/TimeAgo";

interface Props {
  refreshKey: number;
  onMutated: () => void;
}

/** Select sentinel for "type a new assignee name" (cannot collide with real names in practice). */
const CUSTOM = "__custom__";

/**
 * Chip color for the feed. Denial recognition delegates to the single
 * recognizer in ledger.ts (D75); the "everything else is task" floor is
 * feed-local policy — this list only ever shows agent calls and assignments.
 */
function feedCat(event: LedgerEvent): string {
  if (event.kind === "agent_tool_called") {
    return isDeniedCall(event) ? "deny" : "tool";
  }
  return "task";
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
  const tasks = data?.tasks ?? [];

  // Inline "custom assignee" prompt for one card at a time.
  const [customTarget, setCustomTarget] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  // Columns folded away by the reader. Held per view visit, not persisted: the
  // board is read at a glance, and which people are beside the point today is
  // a fact about this glance rather than a setting (2026-08-01 UI review, P3).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const { busy, run } = useGuardedMutation(setError);

  // Column set = "unassigned" first, then the deduped union of assignees.
  const assignees = [
    ...new Set(tasks.map((task) => task.assignee).filter((a): a is string => !!a)),
  ].sort((a, b) => a.localeCompare(b));
  const columns: { label: string; assignee: string | null }[] = [
    { label: t("collab.unassigned"), assignee: null },
    ...assignees.map((a) => ({ label: a, assignee: a })),
  ];

  const byId = new Map(tasks.map((task) => [task.id, task]));

  // Flash only cards that actually appeared in a column (created or moved) —
  // watcher-driven wholesale re-reads must not blink the whole board (D27).
  const cardKey = (task: Task) => `${task.assignee ?? ""}:${task.id}`;
  const freshCards = useFreshKeys(tasks.map(cardKey));

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

  function assign(id: string, assignee: string | null) {
    return run(async () => {
      setError(null);
      await api.assignTask(id, assignee);
      setCustomTarget(null);
      setCustomName("");
      await reload();
      onMutated();
    });
  }

  function onAssigneeSelect(task: Task, value: string) {
    if (value === CUSTOM) {
      setCustomTarget(task.id);
      setCustomName("");
      return;
    }
    const next = value === "" ? null : value;
    if (next === (task.assignee ?? null)) return;
    void assign(task.id, next);
  }


  return (
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("collab.heading")}</h1>
          <p className="view-sub">{t("collab.subtitle")}</p>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            {t("collab.board")}
            <span className="sub">{t("collab.boardSub")}</span>
          </h2>
        </div>
        <p className="section-hint">{t("collab.boardHint")}</p>
        {loading ? null : tasks.length === 0 ? (
          <EmptyState title={t("collab.emptyBoard")} hint={t("collab.emptyBoardHint")} />
        ) : (
          <div className="kanban">
            {columns.map((col) => {
              // Archived tasks stay out of the board (D40); byId keeps the
              // full set so dependency lookups still resolve archived deps.
              const colTasks = tasks.filter(
                (task) => !task.archived && (task.assignee ?? null) === col.assignee,
              );
              const colKey = col.assignee ?? "__unassigned__";
              const isCollapsed = collapsed.has(colKey);
              return (
                <div
                  className={`kanban-col${isCollapsed ? " kanban-col--collapsed" : ""}`}
                  key={colKey}
                >
                  {/* The head is the fold control (2026-08-01 UI review, P3-1):
                      one column per assignee at a fixed width means a team of a
                      dozen is a horizontal scroll with no way to put the people
                      you are not looking at aside. The count stays visible when
                      folded — that is the part worth keeping at a glance. */}
                  <button
                    type="button"
                    className="kc-head"
                    aria-expanded={!isCollapsed}
                    aria-label={t(isCollapsed ? "collab.expandColumn" : "collab.collapseColumn", {
                      name: col.label,
                    })}
                    onClick={() =>
                      setCollapsed((cur) => {
                        const next = new Set(cur);
                        if (!next.delete(colKey)) next.add(colKey);
                        return next;
                      })
                    }
                  >
                    <IconCaretDown size={13} className="kc-caret" />
                    <span className="kc-name">{col.label}</span>
                    <span className="kc-count num">{colTasks.length}</span>
                  </button>
                  {!isCollapsed &&
                    colTasks.map((task) => {
                      const deps = task.dependsOn ?? [];
                      const unresolved = deps.filter(
                        (id) => byId.get(id)?.status !== "done",
                      );
                      return (
                        <div
                          key={task.id}
                          className={`kanban-card ${
                            freshCards.has(cardKey(task)) ? "card-flash" : ""
                          }`}
                        >
                          <div className="kc-title">{task.title}</div>
                          <div className="kc-meta">
                            <span className="t-id">{task.id}</span>
                            <span className={`t-prio ${prioClass(task.priority)}`}>
                              <span className="bar" aria-hidden="true" />P{task.priority}
                            </span>
                            <StatusPill status={task.status} />
                          </div>
                          {deps.length > 0 &&
                            (unresolved.length === 0 ? (
                              <div className="dep-badge dep-badge--ready">
                                <IconCheck size={12} />
                                {t("collab.depsReady")}
                                <span className="mono">{deps.join(", ")}</span>
                              </div>
                            ) : (
                              <div className="dep-badge dep-badge--locked">
                                <IconLock size={12} />
                                {t("collab.depsLocked")}
                                <span className="mono">{unresolved.join(", ")}</span>
                              </div>
                            ))}
                          <select
                            value={task.assignee ?? ""}
                            onChange={(e) => onAssigneeSelect(task, e.target.value)}
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
                            <div className="block-prompt">
                              <input
                                autoFocus
                                value={customName}
                                onChange={(e) => setCustomName(e.target.value)}
                                aria-label={t("collab.customPlaceholder")}
                                placeholder={t("collab.customPlaceholder")}
                              />
                              <button
                                className="btn btn-small"
                                onClick={() => {
                                  setCustomTarget(null);
                                  setCustomName("");
                                }}
                              >
                                {t("common.cancel")}
                              </button>
                              <button
                                className="btn btn-small btn-primary"
                                disabled={busy || customName.trim() === ""}
                                onClick={() => void assign(task.id, customName.trim())}
                              >
                                {t("collab.confirmAssign")}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            {t("collab.feed")}
            <span className="sub">{t("collab.feedSub")}</span>
          </h2>
        </div>
        {loading ? null : feed.length === 0 ? (
          <EmptyState title={t("collab.feedEmpty")} hint={t("collab.feedEmptyHint")} />
        ) : (
          <ul className="event-list">
            {feed.map((event, i) => {
              const key = eventKey(event);
              const fresh = freshFeed.has(key);
              return (
                <li
                  key={`${key}-${i}`}
                  className={`event-item ${fresh ? "entering agent-flash" : ""}`}
                >
                  <TimeAgo className="event-time" at={event.at} />
                  <span className={`event-cat ${feedCat(event)}`}>
                    {t(`ledger.${event.kind}`)}
                  </span>
                  <EventMessage
                    actor={event.actor ?? t("collab.actorGui")}
                    taskId={event.taskId}
                    message={event.message}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
