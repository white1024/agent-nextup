import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, errorMessage } from "../api";
import { useFlash, useGuardedMutation, useWorkspaceData } from "../hooks";
import { setVerifyNudgeEnabled, verifyNudgeEnabled } from "../lib/prefs";
import { useFreshKeys } from "../hooks/anim";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";
import StatusPill from "../components/StatusPill";
import TimeAgo from "../components/TimeAgo";
import { Check, Switch } from "../components/controls";
import {
  IconArchive,
  IconCheck,
  IconPencil,
  IconPlus,
  IconTrash,
  IconWarn,
} from "../components/icons";
import type { Task, TaskStatus, WorkspaceSettings } from "../types";
import ConfirmDanger from "../components/ConfirmDanger";

interface Props {
  refreshKey: number;
  onMutated: () => void;
  /** Task the command palette asked to reveal (D66); consumed once. */
  focusTask?: string | null;
  onFocusHandled?: () => void;
  /**
   * New task was invoked from the palette/shortcut. Same one-shot parked-prop
   * shape as `focusTask` above — App clears it once consumed.
   *
   * A counter does **not** work here: this view is conditionally rendered, so
   * arriving from another page is a fresh mount, and at that moment there is
   * nothing to compare the counter against — every entry into the tasks page
   * would grab focus and scroll the create form into view.
   */
  focusCreate?: boolean;
  onCreateHandled?: () => void;
}

const STATUSES: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];

type SortKey = "id" | "priority" | "updated";

/** Priority tint shared with the collab board (same t-prio visual language). */
export function prioClass(priority: number): string {
  if (priority === 0) return "t-prio--p0";
  if (priority === 1) return "t-prio--p1";
  return "";
}

/**
 * Task descriptions are frequently agent-written acceptance criteria running to
 * a paragraph, which would let one row own the whole screen. Clamp to three
 * lines and offer a toggle — but only when the clamp actually hid something, so
 * short descriptions carry no useless control.
 */
function TaskDescription({ text }: { text: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setClipped(el.scrollHeight - el.clientHeight > 1);
  }, [text]);

  return (
    <div className="t-desc-wrap">
      <div ref={ref} className={`t-desc${expanded ? " t-desc--open" : ""}`}>
        {text}
      </div>
      {(clipped || expanded) && (
        <button className="t-desc-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? t("tasks.descLess") : t("tasks.descMore")}
        </button>
      )}
    </div>
  );
}

const parseTags = (raw: string): string[] =>
  raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");

export default function Tasks({
  refreshKey,
  onMutated,
  focusTask,
  onFocusHandled,
  focusCreate,
  onCreateHandled,
}: Props) {
  const { t } = useTranslation();
  const {
    data,
    error,
    setError,
    reload: load,
    loading,
  } = useWorkspaceData<Task[]>(() => api.listTasks(), refreshKey);
  const tasks = data ?? [];
  const { flash, showFlash } = useFlash(3000);

  // One in-flight task mutation at a time (D65) — one instance, so every row's
  // controls lock together while any one of them is mid-write. The ref gate
  // that makes this hold against a same-tick double click lives in the hook.
  const { busy: mutating, run: runMutation } = useGuardedMutation(setError);

  /** Runs one task mutation, then reloads and notifies — the tail all four of
   *  this view's status/verification/archive/sweep actions share. */
  function guarded(body: () => Promise<void>) {
    return runMutation(async () => {
      setError(null);
      await body();
      await load();
      onMutated();
    });
  }

  // New-task form
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(1);
  const [tagsRaw, setTagsRaw] = useState("");
  const { busy: creating, run: runCreate } = useGuardedMutation(setError);

  // Inline "blocked reason" prompt for one task at a time
  const [blockTarget, setBlockTarget] = useState<string | null>(null);
  const [blockReason, setBlockReason] = useState("");

  // Inline "verification evidence" prompt for one done task at a time
  const [verifyTarget, setVerifyTarget] = useState<string | null>(null);
  const [verifyNote, setVerifyNote] = useState("");

  // The done≠verified teaching moment: shown once per completion, inline on the
  // task that was just claimed done (§5-3).
  const [nudgeTarget, setNudgeTarget] = useState<string | null>(null);

  // Edit / delete dialogs (D46 modal convention), one task at a time.
  const [editTarget, setEditTarget] = useState<Task | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState(1);
  const [editTags, setEditTags] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  // Errors stay inside their own dialog — the form is still open and fixable —
  // so these two get their own error sinks rather than the view-level one.
  const { busy: saving, run: runSave } = useGuardedMutation(setEditError);

  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { busy: deleting, run: runDelete } = useGuardedMutation(setDeleteError);

  // Filters (client-side: the list is already in memory, so narrowing it needs
  // no roundtrip and stays instant while typing).
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("id");

  // Archive shelf (D40): hidden by default so a long-lived project's page
  // stays the working set; the toggle brings the closed tasks back.
  const [showArchived, setShowArchived] = useState(false);

  // Auto-archive knobs (D78): per-workspace settings, loaded with the page.
  // `null` until read (invariant 10 — never render a guess); the days field
  // keeps its own draft so typing does not fire a write per keystroke.
  const [wsSettings, setWsSettings] = useState<WorkspaceSettings | null>(null);
  const [daysDraft, setDaysDraft] = useState("");
  useEffect(() => {
    let cancelled = false;
    api
      .getWorkspaceSettings()
      .then((s) => {
        if (cancelled) return;
        setWsSettings(s);
        setDaysDraft(String(s.autoArchive.days));
      })
      .catch((e) => console.warn("get_workspace_settings failed:", e));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function saveAutoArchive(next: WorkspaceSettings) {
    setWsSettings(next); // optimistic: a knob flip must feel instant
    try {
      setWsSettings(await api.setWorkspaceSettings(next));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function commitDays() {
    if (wsSettings === null) return;
    const parsed = Number.parseInt(daysDraft, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      setDaysDraft(String(wsSettings.autoArchive.days));
      return;
    }
    if (parsed === wsSettings.autoArchive.days) return;
    void saveAutoArchive({
      ...wsSettings,
      autoArchive: { ...wsSettings.autoArchive, days: parsed },
    });
  }

  // Palette jump (D66): the row to reveal, and the row element itself.
  const [marked, setMarked] = useState<string | null>(null);
  const markedRowRef = useRef<HTMLTableRowElement>(null);
  const newTitleRef = useRef<HTMLInputElement>(null);

  // New task from the palette: the form is always on this page, so the jump is
  // "put the cursor in it" rather than opening anything.
  useEffect(() => {
    if (focusCreate !== true) return;
    newTitleRef.current?.focus();
    newTitleRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    onCreateHandled?.();
  }, [focusCreate, onCreateHandled]);

  /**
   * Take the jump request. Filters are cleared first, deliberately: the target
   * may sit behind a status filter, a tag chip, a search string or the archive
   * shelf, and landing on a page that does not show the thing you asked for is
   * the dead-end D63 had to fix twice elsewhere.
   */
  useEffect(() => {
    if (focusTask == null) return;
    setStatusFilter("all");
    setTagFilter("all");
    setQuery("");
    setShowArchived(true);
    setMarked(focusTask);
    onFocusHandled?.();
  }, [focusTask, onFocusHandled]);

  // Scroll after the filter reset above has rendered — in the same pass the row
  // may still be filtered out and the ref would be null.
  useEffect(() => {
    if (marked === null) return;
    markedRowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [marked]);

  // Drop the marker on its own timer, keyed only on `marked`. Depending on the
  // task list here instead would re-arm the countdown on every watcher tick, so
  // in a workspace an agent is actively writing to, the highlight would never
  // fade (the same trap `anim.ts` records for mount animations).
  useEffect(() => {
    if (marked === null) return;
    const timer = window.setTimeout(() => setMarked(null), 2600);
    return () => window.clearTimeout(timer);
  }, [marked]);
  const archivedCount = tasks.filter((task) => task.archived).length;
  const sweepable = tasks.filter(
    (task) => task.status === "done" && task.verifiedAt && !task.archived,
  ).length;
  const shelved = showArchived ? tasks : tasks.filter((task) => !task.archived);

  const allTags = useMemo(
    () => [...new Set(shelved.flatMap((task) => task.tags))].sort((a, b) => a.localeCompare(b)),
    [shelved],
  );

  const visibleTasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = shelved.filter((task) => {
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      if (tagFilter !== "all" && !task.tags.includes(tagFilter)) return false;
      if (needle === "") return true;
      return (
        task.title.toLowerCase().includes(needle) ||
        task.description.toLowerCase().includes(needle) ||
        task.id.toLowerCase().includes(needle)
      );
    });
    const sorted = [...matched];
    if (sort === "priority") {
      sorted.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    } else if (sort === "updated") {
      sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } else {
      sorted.sort((a, b) => a.id.localeCompare(b.id));
    }
    return sorted;
  }, [shelved, statusFilter, tagFilter, query, sort]);

  const filtered = statusFilter !== "all" || tagFilter !== "all" || query.trim() !== "";

  function clearFilters() {
    setStatusFilter("all");
    setTagFilter("all");
    setQuery("");
  }

  // Slide-in only for rows that actually appeared (local create or agent).
  const freshIds = useFreshKeys(tasks.map((task) => task.id));

  // Its own instance rather than sharing `mutating`: this one also drives the
  // new-task form's disabled state, so folding it in would grey the form out
  // whenever any row is mid-write.
  function createTask() {
    return runCreate(async () => {
      setError(null);
      await api.createTask({ title, description, priority, tags: parseTags(tagsRaw) });
      setTitle("");
      setDescription("");
      setPriority(1);
      setTagsRaw("");
      await load();
      onMutated();
    });
  }

  const applyStatus = (id: string, status: TaskStatus, reason?: string) =>
    guarded(async () => {
      const update = await api.updateTaskStatus(id, status, reason);
      // Completing without evidence is the moment the product's core claim is
      // worth teaching; only fall back to the snapshot flash once it is off.
      if (status === "done" && !update.task.verifiedAt && verifyNudgeEnabled()) {
        setNudgeTarget(id);
      } else if (update.handoff !== null && status === "done") {
        showFlash(t("tasks.doneHandoffHint"));
      }
      setBlockTarget(null);
      setBlockReason("");
    });

  const applyVerification = (id: string, verified: boolean, note?: string) =>
    guarded(async () => {
      await api.setTaskVerification(id, verified, note);
      showFlash(t("tasks.verifiedHint"));
      setVerifyTarget(null);
      setVerifyNote("");
      setNudgeTarget(null);
    });

  const applyArchived = (id: string, archived: boolean) =>
    guarded(async () => {
      const updated = await api.setTaskArchived(id, archived);
      // Archiving may fold delta specs (D79) — surface the outcome so the
      // spec-layer write is never silent.
      if (updated.specFold) {
        const s = updated.specFold;
        showFlash(
          t("tasks.foldedHint", {
            caps: s.capabilities.join(", "),
            counts: `+${s.added} ~${s.modified} -${s.removed} →${s.renamed}`,
          }),
        );
      }
    });

  const sweepArchive = () =>
    guarded(async () => {
      const swept = await api.archiveVerifiedDoneTasks();
      if (swept.length > 0) showFlash(t("tasks.sweepDone", { n: swept.length }));
    });

  function openEdit(task: Task) {
    setEditTarget(task);
    setEditTitle(task.title);
    setEditDescription(task.description);
    setEditPriority(task.priority);
    setEditTags(task.tags.join(", "));
    setEditError(null);
  }

  function saveEdit() {
    if (!editTarget) return;
    return runSave(async () => {
      setEditError(null);
      await api.editTask(editTarget.id, {
        title: editTitle,
        description: editDescription,
        priority: editPriority,
        tags: parseTags(editTags),
      });
      setEditTarget(null);
      showFlash(t("tasks.editedHint"));
      await load();
      onMutated();
    });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    // has_dependents is phrased for humans centrally (errors.* in api.ts), so
    // the refusal already names who is holding the task.
    return runDelete(async () => {
      setDeleteError(null);
      await api.deleteTask(deleteTarget.id);
      setDeleteTarget(null);
      showFlash(t("tasks.deletedHint"));
      await load();
      onMutated();
    });
  }

  function onStatusSelect(task: Task, status: TaskStatus) {
    if (status === task.status) return;
    if (status === "blocked") {
      setBlockTarget(task.id);
      setBlockReason("");
      return;
    }
    void applyStatus(task.id, status);
  }

  return (
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("tasks.heading")}</h1>
          <p className="view-sub">{t("tasks.subtitle")}</p>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}
      {flash && <div className="alert alert-ok">{flash}</div>}

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{t("tasks.newTitle")}</h2>
        </div>
        <div className="task-form">
          <label className="field">
            <span>{t("tasks.priority")}</span>
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {/* Spelled out in the picker, bare in the table: the choice is
                  where someone meets the scale for the first time and "P0" says
                  nothing about which end is urgent (2026-08-01 UI review, P3-3).
                  The rows keep the short form — by then the reader knows, and
                  the column is 64px wide. */}
              <option value={0}>{t("tasks.prio0")}</option>
              <option value={1}>{t("tasks.prio1")}</option>
              <option value={2}>{t("tasks.prio2")}</option>
              <option value={3}>{t("tasks.prio3")}</option>
            </select>
          </label>
          <label className="field grow">
            <span>{t("tasks.titleLabel")}</span>
            <input
              ref={newTitleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("tasks.titlePlaceholder")}
            />
          </label>
          <label className="field grow">
            <span>
              {t("tasks.descLabel")} {t("common.optional")}
            </span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("tasks.descPlaceholder")}
            />
          </label>
          <label className="field grow">
            <span>
              {t("tasks.tagsLabel")} {t("common.optional")}
            </span>
            <input
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder={t("tasks.tagsPlaceholder")}
            />
          </label>
          <button
            className="btn btn-primary"
            onClick={() => void createTask()}
            disabled={creating || title.trim() === ""}
          >
            <IconPlus size={14} />
            {creating ? t("tasks.creating") : t("tasks.create")}
          </button>
        </div>
      </section>

      <section className="panel">
        {/* The done-vs-verified distinction used to be the page subtitle, which
            said nothing about what page you were on. It belongs with the list
            whose rows it describes (D89). */}
        {tasks.length > 0 && <p className="section-hint">{t("tasks.listHint")}</p>}
        {tasks.length > 0 && (
          <div className="task-filters">
            <label className="field grow">
              <span>{t("tasks.search")}</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("tasks.searchPlaceholder")}
              />
            </label>
            <label className="field">
              <span>{t("tasks.filterStatus")}</span>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as TaskStatus | "all")}
              >
                <option value="all">{t("tasks.filterAll")}</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`status.${s}`)}
                  </option>
                ))}
              </select>
            </label>
            {allTags.length > 0 && (
              <label className="field">
                <span>{t("tasks.filterTag")}</span>
                <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
                  <option value="all">{t("tasks.filterTagAll")}</option>
                  {allTags.map((tag) => (
                    <option key={tag} value={tag}>
                      {tag}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              <span>{t("tasks.sort")}</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                <option value="id">{t("tasks.sortId")}</option>
                <option value="priority">{t("tasks.sortPriority")}</option>
                <option value="updated">{t("tasks.sortUpdated")}</option>
              </select>
            </label>
            {filtered && (
              <button className="btn btn-small" onClick={clearFilters}>
                {t("tasks.clearFilters")}
              </button>
            )}
          </div>
        )}
        {(archivedCount > 0 || sweepable > 0 || wsSettings !== null) && (
          <div className="archive-bar">
            {(archivedCount > 0 || sweepable > 0) && (
              <button
                className="btn btn-small"
                disabled={sweepable === 0 || mutating}
                onClick={() => void sweepArchive()}
              >
                {t("tasks.archiveSweep", { n: sweepable })}
              </button>
            )}
            {/* D78: the engine sweeps on workspace open; these knobs are the
                per-workspace policy. Always visible once loaded — a switch
                you can only find while it is on is a switch you cannot
                re-enable. */}
            {wsSettings !== null && (
              <span className="archive-auto">
                <Switch
                  checked={wsSettings.autoArchive.enabled}
                  ariaLabel={t("tasks.autoArchiveAria")}
                  onChange={(enabled) =>
                    void saveAutoArchive({
                      ...wsSettings,
                      autoArchive: { ...wsSettings.autoArchive, enabled },
                    })
                  }
                />
                <span className={wsSettings.autoArchive.enabled ? "" : "muted"}>
                  {t("tasks.autoArchivePre")}
                </span>
                <input
                  className="archive-days"
                  type="number"
                  min={0}
                  value={daysDraft}
                  disabled={!wsSettings.autoArchive.enabled}
                  aria-label={t("tasks.autoArchiveDaysAria")}
                  onChange={(e) => setDaysDraft(e.target.value)}
                  onBlur={commitDays}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
                <span className={wsSettings.autoArchive.enabled ? "" : "muted"}>
                  {t("tasks.autoArchivePost")}
                </span>
              </span>
            )}
            {archivedCount > 0 && (
              <Check checked={showArchived} onChange={setShowArchived}>
                {t("tasks.showArchived", { n: archivedCount })}
              </Check>
            )}
          </div>
        )}
        {loading ? null : visibleTasks.length === 0 ? (
          tasks.length === 0 ? (
            <EmptyState title={t("tasks.empty")} hint={t("tasks.emptyHint")} />
          ) : filtered ? (
            // No action here: the filter bar's own "Clear filters" button is
            // visible directly above whenever this state can occur, and two
            // identical buttons a row apart read as two different things.
            <EmptyState title={t("tasks.filterNone")} hint={t("tasks.filterNoneHint")} />
          ) : (
            <EmptyState title={t("tasks.allArchived")} hint={t("tasks.allArchivedHint")} />
          )
        ) : (
          /* Six columns, five of them fixed-width — below roughly 720px the
             table has nowhere left to give, so it scrolls horizontally as a
             unit rather than letting the last columns be pushed off the view
             entirely (D65 walkthrough feedback). */
          <div className="table-scroll">
            <table className="task-table">
              <thead>
                <tr>
                  <th style={{ width: 74 }}>ID</th>
                  <th style={{ width: 64 }}>{t("tasks.priority")}</th>
                  <th>{t("tasks.titleLabel")}</th>
                  <th style={{ width: 104 }}>{t("tasks.colStatus")}</th>
                  <th style={{ width: 150 }}>{t("tasks.colVerify")}</th>
                  <th style={{ width: 96 }} />
                </tr>
              </thead>
              <tbody>
                {visibleTasks.map((task) => (
                  <tr
                    key={task.id}
                    ref={task.id === marked ? markedRowRef : undefined}
                    className={`${freshIds.has(task.id) ? "task-new" : ""}${
                      task.archived ? " task-archived" : ""
                    }${task.id === marked ? " task-marked" : ""}`}
                  >
                    <td className="t-id">{task.id}</td>
                    <td>
                      <span className={`t-prio ${prioClass(task.priority)}`}>
                        <span className="bar" aria-hidden="true" />P{task.priority}
                      </span>
                    </td>
                    <td>
                      <div className="t-title">{task.title}</div>
                      {task.description !== "" && <TaskDescription text={task.description} />}
                      {task.tags.length > 0 && (
                        <div className="t-tags">
                          {task.tags.map((tag) => (
                            <button
                              key={tag}
                              className={`t-tag${tagFilter === tag ? " t-tag--on" : ""}`}
                              onClick={() => setTagFilter(tagFilter === tag ? "all" : tag)}
                            >
                              {tag}
                            </button>
                          ))}
                        </div>
                      )}
                      {task.status === "blocked" && task.blockedReason && (
                        <div className="blocked-reason">
                          <IconWarn size={13} />
                          {task.blockedReason}
                          {/* Nothing re-checks a reason, so its age is the
                              only cue that the blocker may already be gone. */}
                          {task.blockedAt && (
                            <TimeAgo at={task.blockedAt} className="br-age" />
                          )}
                        </div>
                      )}
                      {nudgeTarget === task.id && (
                        <div className="verify-nudge">
                          <div className="vn-title">{t("tasks.nudgeTitle")}</div>
                          <p className="vn-body">{t("tasks.nudgeBody")}</p>
                          <div className="vn-actions">
                            <button
                              className="btn btn-small btn-primary"
                              onClick={() => {
                                setVerifyTarget(task.id);
                                setVerifyNote("");
                                setNudgeTarget(null);
                              }}
                            >
                              {t("tasks.nudgeVerify")}
                            </button>
                            <button className="btn btn-small" onClick={() => setNudgeTarget(null)}>
                              {t("tasks.nudgeLater")}
                            </button>
                            <button
                              className="btn btn-ghost btn-small"
                              onClick={() => {
                                setVerifyNudgeEnabled(false);
                                setNudgeTarget(null);
                              }}
                            >
                              {t("tasks.nudgeNever")}
                            </button>
                          </div>
                        </div>
                      )}
                      {blockTarget === task.id && (
                        <div className="block-prompt">
                          <input
                            autoFocus
                            value={blockReason}
                            onChange={(e) => setBlockReason(e.target.value)}
                            aria-label={t("tasks.blockReasonPlaceholder")}
                            placeholder={t("tasks.blockReasonPlaceholder")}
                          />
                          <button
                            className="btn btn-small"
                            onClick={() => {
                              setBlockTarget(null);
                              setBlockReason("");
                            }}
                          >
                            {t("common.cancel")}
                          </button>
                          <button
                            className="btn btn-small btn-primary"
                            disabled={blockReason.trim() === "" || mutating}
                            onClick={() => void applyStatus(task.id, "blocked", blockReason)}
                          >
                            {t("tasks.confirmBlock")}
                          </button>
                        </div>
                      )}
                      {verifyTarget === task.id && (
                        <div className="block-prompt">
                          <input
                            autoFocus
                            value={verifyNote}
                            onChange={(e) => setVerifyNote(e.target.value)}
                            aria-label={t("tasks.verifyNotePlaceholder")}
                            placeholder={t("tasks.verifyNotePlaceholder")}
                          />
                          <button
                            className="btn btn-small"
                            onClick={() => {
                              setVerifyTarget(null);
                              setVerifyNote("");
                            }}
                          >
                            {t("common.cancel")}
                          </button>
                          <button
                            className="btn btn-small btn-primary"
                            disabled={verifyNote.trim() === "" || mutating}
                            onClick={() => void applyVerification(task.id, true, verifyNote)}
                          >
                            {t("tasks.confirmVerify")}
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      <StatusPill status={task.status} />
                      {task.specFoldedAt && (
                        <span className="pill pill-info" title={task.specFoldedAt}>
                          <span className="dot" aria-hidden="true" />
                          {t("tasks.specFolded")}
                        </span>
                      )}
                      {task.archived && (
                        <span className="pill archived-pill">{t("tasks.archived")}</span>
                      )}
                    </td>
                    <td className="verify-cell">
                      {task.status !== "done" ? (
                        <span className="v-none">—</span>
                      ) : task.verifiedAt ? (
                        <>
                          <span className="v-yes">
                            <IconCheck size={13} />
                            {t("tasks.verified")}
                          </span>
                          {task.verifiedNote && (
                            // Evidence is agent-written and can run long; clamped
                            // so one verbose note cannot stretch the row into a
                            // tower, with the full text on hover (D65 walkthrough feedback).
                            <div className="v-note" title={task.verifiedNote}>
                              {task.verifiedNote}
                            </div>
                          )}
                          <button
                            className="btn btn-ghost btn-small"
                            disabled={mutating}
                            onClick={() => void applyVerification(task.id, false)}
                          >
                            {t("tasks.clearVerified")}
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="pill pill-warn">
                            <span className="dot" aria-hidden="true" />
                            {t("tasks.unverified")}
                          </span>
                          <div>
                            <button
                              className="btn btn-small"
                              onClick={() => {
                                setVerifyTarget(task.id);
                                setVerifyNote("");
                              }}
                            >
                              {t("tasks.markVerified")}
                            </button>
                          </div>
                        </>
                      )}
                    </td>
                    <td>
                      <div className="task-actions">
                        <select
                          value={task.status}
                          disabled={mutating}
                          onChange={(e) => onStatusSelect(task, e.target.value as TaskStatus)}
                          aria-label={`${task.id} status`}
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {t(`status.${s}`)}
                            </option>
                          ))}
                        </select>
                        {/* Icon row: three equal buttons stay on one line whatever
                            the locale, and the archive slot appearing only on done
                            tasks no longer pushes anything onto a second row. */}
                        <div className="ta-row">
                          <button
                            className="btn btn-ghost btn-icon"
                            title={t("tasks.edit")}
                            aria-label={`${task.id} ${t("tasks.edit")}`}
                            onClick={() => openEdit(task)}
                          >
                            <IconPencil size={15} />
                          </button>
                          {task.status === "done" && (
                            <button
                              className="btn btn-ghost btn-icon"
                              title={task.archived ? t("tasks.unarchive") : t("tasks.archive")}
                              aria-label={`${task.id} ${
                                task.archived ? t("tasks.unarchive") : t("tasks.archive")
                              }`}
                              disabled={mutating}
                              onClick={() => void applyArchived(task.id, !task.archived)}
                            >
                              <IconArchive size={15} />
                            </button>
                          )}
                          <button
                            className="btn btn-ghost btn-icon danger-trigger"
                            title={t("tasks.delete")}
                            aria-label={`${task.id} ${t("tasks.delete")}`}
                            onClick={() => {
                              setDeleteTarget(task);
                              setDeleteError(null);
                            }}
                          >
                            <IconTrash size={15} />
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editTarget && (
        <Modal
          label={t("tasks.editTitle", { id: editTarget.id })}
          onClose={() => setEditTarget(null)}
        >
          <div className="form">
            <h2 className="form-heading">{t("tasks.editTitle", { id: editTarget.id })}</h2>
            <p className="muted">{t("tasks.editHint")}</p>
            {editError && <div className="alert alert-error">{editError}</div>}
            <label className="field">
              <span>{t("tasks.titleLabel")}</span>
              <input autoFocus value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </label>
            <label className="field">
              <span>
                {t("tasks.descLabel")} {t("common.optional")}
              </span>
              {/* Textarea, not an input: agent-written descriptions carry whole
                  acceptance-criteria paragraphs, and a one-line box makes them
                  unreadable to edit. */}
              <textarea
                className="task-desc-input"
                rows={6}
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder={t("tasks.descPlaceholder")}
              />
            </label>
            <label className="field">
              <span>{t("tasks.priority")}</span>
              <select
                value={editPriority}
                onChange={(e) => setEditPriority(Number(e.target.value))}
              >
                {/* Same spelled-out scale as the create form above. */}
                <option value={0}>{t("tasks.prio0")}</option>
                <option value={1}>{t("tasks.prio1")}</option>
                <option value={2}>{t("tasks.prio2")}</option>
                <option value={3}>{t("tasks.prio3")}</option>
              </select>
            </label>
            <label className="field">
              <span>
                {t("tasks.tagsLabel")} {t("common.optional")}
              </span>
              <input
                value={editTags}
                onChange={(e) => setEditTags(e.target.value)}
                placeholder={t("tasks.tagsPlaceholder")}
              />
            </label>
            <div className="form-actions">
              <button className="btn" onClick={() => setEditTarget(null)}>
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-primary"
                disabled={saving || editTitle.trim() === ""}
                onClick={() => void saveEdit()}
              >
                {saving ? t("tasks.saving") : t("tasks.save")}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDanger
          heading={t("tasks.deleteTitle", { id: deleteTarget.id })}
          body={t("tasks.deleteBody", { title: deleteTarget.title, id: deleteTarget.id })}
          confirmLabel={t("tasks.deleteConfirm")}
          busy={deleting}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
