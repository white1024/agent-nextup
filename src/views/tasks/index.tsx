import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";

import { api, errorKind, errorMessage } from "../../api";
import { useFlash, useGuardedMutation, useWorkspaceData } from "../../hooks";
import { useFreshKeys } from "../../hooks/anim";
import { setVerifyNudgeEnabled, verifyNudgeEnabled } from "../../lib/prefs";
import { centreOf, fx, motionOff } from "../../lib/fx";
import {
  BOX_CLOSE_MS,
  BOX_OPEN_MS,
  EASE_IN,
  EASE_OUT,
  afterPaint,
  boxClose,
  boxOf,
  boxOpen,
  easeHeight,
  fadeRowsOut,
  pictureOf,
  rowTops,
  rowsMoved,
  settleBox,
  slideRows,
  viewSwap,
} from "../../lib/listMotion";
import EmptyState from "../../components/EmptyState";
import InfoTip from "../../components/InfoTip";
import Modal from "../../components/Modal";
import Scramble from "../../components/Scramble";
import Segmented from "../../components/Segmented";
import ConfirmDanger from "../../components/ConfirmDanger";
import { Check, Switch } from "../../components/controls";
import { IconArchive, IconCaretDown, IconPlus, IconSearch } from "../../components/icons";
import type { SpecOverlap, Task, TaskStatus, TaskUpdate, WorkspaceSettings } from "../../types";
import TaskRow, { STATUSES, type ReasonStatus, type RowActions } from "./TaskRow";

interface Props {
  refreshKey: number;
  onMutated: () => void;
  /** Task the command palette asked to reveal (D66); consumed once. Since
   *  D153 the task opens in place as a card (C25) rather than being marked. */
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

type SortKey = "id" | "priority" | "updated";

const parseTags = (raw: string): string[] =>
  raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");

/** Splits a translated sentence around its `{{n}}`, so the number alone can
 *  scramble (C10) while the words around it stay put. */
const MARK = "⁣";
function around(text: string): [string, string] {
  const i = text.indexOf(MARK);
  return i < 0 ? [text, ""] : [text.slice(0, i), text.slice(i + MARK.length)];
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** Is `el` on screen (the target of a stream of light has to be visible)? */
function visible(el: Element | null | undefined): el is Element {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
}

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

  const listRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const rowEl = (id: string) =>
    listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`) ?? null;

  // ── Rows slide to where a write put them (C273 / C277 / C278) ─────────────
  //
  // A write's result arrives over several commits — the prompt closes, then
  // the reload lands — so "before" is taken when the write is about to show
  // and every commit inside a short window slides from the previous one. No
  // window, no measuring: renders that are not a write's result (typing, the
  // watcher) never touch layout here.
  const slideFrom = useRef<Map<string, number> | null>(null);
  const slideUntil = useRef(0);
  function planSlide(ms = 1600) {
    if (motionOff()) return;
    slideFrom.current = rowTops(listRef.current);
    slideUntil.current = performance.now() + ms;
  }
  useLayoutEffect(() => {
    const from = slideFrom.current;
    if (from === null) return;
    if (performance.now() > slideUntil.current) {
      slideFrom.current = null;
      return;
    }
    const list = listRef.current;
    const now = rowTops(list);
    if (rowsMoved(from, now)) slideRows(list, from, { duration: 320, easing: EASE_OUT });
    slideFrom.current = now;
  });

  /**
   * Runs one task mutation, then reloads and notifies — the tail every row
   * action shares.
   *
   * `body` may return a settle step: local state that should change *with*
   * the reloaded list (a prompt closing, the nudge opening). It runs right
   * after the reload, in the same batch, so the list moves once. Closing the
   * prompt before the reload instead meant two commits — the rows slid up for
   * the prompt and then back down for the new evidence line, passing over the
   * row in between. `after` runs once the reloaded list is on screen.
   */
  function guarded(body: () => Promise<(() => void) | void>, after?: () => void) {
    return runMutation(async () => {
      setError(null);
      const settle = await body();
      await load();
      settle?.();
      onMutated();
      if (after) void afterPaint().then(after);
    });
  }

  // New-task row
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(1);
  const [tagsRaw, setTagsRaw] = useState("");
  const { busy: creating, run: runCreate } = useGuardedMutation(setError);

  // Inline "blocked reason" prompt for one task at a time
  const [blockTarget, setBlockTarget] = useState<string | null>(null);
  const [blockReason, setBlockReason] = useState("");
  // Which reason the inline prompt is collecting: blocked or cancelled (D169).
  const [blockAs, setBlockAs] = useState<ReasonStatus>("blocked");

  // Inline "verification evidence" prompt for one done task at a time
  const [verifyTarget, setVerifyTarget] = useState<string | null>(null);
  const [verifyNote, setVerifyNote] = useState("");
  // The archive was refused because a newer task already folded the same
  // requirement (D129). Held here rather than shown as an error, because the
  // user has a real choice to make.
  const [foldConflict, setFoldConflict] = useState<{
    id: string;
    overlaps: SpecOverlap[];
  } | null>(null);

  // The done≠verified teaching moment: shown once per completion, inline on the
  // task that was just claimed done (§5-3).
  const [nudgeTarget, setNudgeTarget] = useState<string | null>(null);

  // The one task unfolded into a card (C25), and the one just swept with light
  // after an edit (C216).
  const [openId, setOpenId] = useState<string | null>(null);
  const [litId, setLitId] = useState<string | null>(null);
  useEffect(() => {
    if (litId === null) return;
    const timer = window.setTimeout(() => setLitId(null), 800);
    return () => window.clearTimeout(timer);
  }, [litId]);

  // Edit / delete dialogs (D46 modal convention), one task at a time.
  const [editTarget, setEditTarget] = useState<Task | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState(1);
  const [editTags, setEditTags] = useState("");
  // One step per line (D170); saving sends the whole list.
  const [editSteps, setEditSteps] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  // Errors stay inside their own dialog — the form is still open and fixable —
  // so these two get their own error sinks rather than the view-level one.
  const { busy: saving, run: runSave } = useGuardedMutation(setEditError);

  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { busy: deleting, run: runDelete } = useGuardedMutation(setDeleteError);

  // Filters (client-side: the list is already in memory, so narrowing it needs
  // no roundtrip and stays instant while typing). The search box and the
  // search the list applies are two states: the box updates on the keystroke,
  // the list inside the View Transition (C271) — otherwise the box itself
  // would be captured mid-change and cross-fade between two spellings.
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
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

  // Entering the page straight from the sidebar: header, add row and filters
  // rise one after another, then the rows (spec 30, after C23). Not when the
  // page grew out of the dashboard (C23's own frame is already the arrival),
  // and only on the mount — a reload is not an arrival.
  const [entering, setEntering] = useState(false);
  useEffect(() => {
    if (motionOff() || document.querySelector(".pt-veil") !== null) return;
    setEntering(true);
    const timer = window.setTimeout(() => setEntering(false), 1400);
    return () => window.clearTimeout(timer);
  }, []);

  const newTitleRef = useRef<HTMLInputElement>(null);

  // New task from the palette: the add row is always on this page, so the jump
  // is "put the cursor in it" rather than opening anything.
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
   * the dead-end D63 had to fix twice elsewhere. The task then opens where it
   * is (C25) once its row is on screen.
   */
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  useEffect(() => {
    if (focusTask == null) return;
    setStatusFilter("all");
    setTagFilter("all");
    setQuery("");
    setAppliedQuery("");
    setShowArchived(true);
    setPendingOpen(focusTask);
    onFocusHandled?.();
  }, [focusTask, onFocusHandled]);

  useEffect(() => {
    if (pendingOpen === null || loading) return;
    const row = rowEl(pendingOpen);
    if (row === null) {
      // Not in this project (or gone since the palette listed it).
      setPendingOpen(null);
      return;
    }
    const id = pendingOpen;
    setPendingOpen(null);
    const r = row.getBoundingClientRect();
    const inView = r.top >= 0 && r.bottom <= window.innerHeight;
    if (!inView) row.scrollIntoView({ block: "center", behavior: motionOff() ? "auto" : "smooth" });
    // Not cleared on the next run: a watcher reload landing mid-scroll must
    // not cancel the open (pendingOpen is already spent, nothing would retry).
    window.setTimeout(() => openTask(id), inView || motionOff() ? 0 : 360);
    // openTask reads refs only; re-running on its identity would re-open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpen, loading, data]);

  const archivedCount = tasks.filter((task) => task.archived).length;
  const sweepable = tasks.filter(
    (task) => task.status === "done" && task.verifiedAt && !task.archived,
  ).length;
  const shelved = useMemo(
    () => (showArchived ? tasks : tasks.filter((task) => !task.archived)),
    [tasks, showArchived],
  );

  const allTags = useMemo(
    () => [...new Set(shelved.flatMap((task) => task.tags))].sort((a, b) => a.localeCompare(b)),
    [shelved],
  );

  // The status cells count what is on the shelf — archived tasks only once
  // "show archived" is ticked — and ignore the other filters, so each number
  // says what clicking that cell would show before tags or search narrow it.
  const counts = useMemo(() => {
    const c: Record<TaskStatus | "all", number> = {
      all: shelved.length,
      todo: 0,
      in_progress: 0,
      blocked: 0,
      done: 0,
      cancelled: 0,
    };
    for (const task of shelved) c[task.status] += 1;
    return c;
  }, [shelved]);

  const visibleTasks = useMemo(() => {
    const needle = appliedQuery.trim().toLowerCase();
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
  }, [shelved, statusFilter, tagFilter, appliedQuery, sort]);

  const filtered = statusFilter !== "all" || tagFilter !== "all" || query.trim() !== "";

  /** A filter change, run through the View Transition (C24 / C270–C272). */
  function swapList(change: () => void) {
    settleBox();
    viewSwap("tk", pageRef.current, () => flushSync(change));
  }

  function clearFilters() {
    swapList(() => {
      setStatusFilter("all");
      setTagFilter("all");
      setQuery("");
      setAppliedQuery("");
      setOpenId(null);
    });
  }

  function pickTag(tag: string) {
    swapList(() => {
      setTagFilter((cur) => (cur === tag ? "all" : tag));
      setOpenId(null);
    });
  }

  // Slide-in only for rows that actually appeared (local create or agent).
  const freshIds = useFreshKeys(tasks.map((task) => task.id));

  // ── C25: a row unfolds into its card, and folds back ──────────────────────
  function openTask(id: string) {
    settleBox();
    const list = listRef.current;
    const old = rowEl(id);
    const focusCard = () =>
      list?.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    if (list === null || old === null || motionOff()) {
      flushSync(() => setOpenId(id));
      focusCard();
      return;
    }
    const before = rowTops(list);
    const h0 = list.getBoundingClientRect().height;
    const from = boxOf(old);
    const picture = pictureOf(old);
    flushSync(() => setOpenId(id));
    const card = list.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`);
    if (card === null) return;
    const timing: KeyframeAnimationOptions = { duration: BOX_OPEN_MS, easing: EASE_OUT };
    boxOpen({
      host: list,
      from,
      picture,
      dst: card,
      cls: "tk-ghost",
      also: [...slideRows(list, before, timing, id), ...easeHeight(list, h0, timing)],
    });
    focusCard();
  }

  function closeTask(id: string) {
    settleBox();
    const list = listRef.current;
    const cardEl = list?.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`) ?? null;
    const focusRow = () => rowEl(id)?.querySelector<HTMLElement>(".tr-open")?.focus({ preventScroll: true });
    if (list === null || cardEl === null || motionOff()) {
      flushSync(() => setOpenId(null));
      focusRow();
      return;
    }
    const before = rowTops(list);
    const h0 = list.getBoundingClientRect().height;
    const from = boxOf(cardEl);
    const out = pictureOf(cardEl);
    flushSync(() => setOpenId(null));
    const row = rowEl(id);
    // Same 60ms late start as the frame; `backwards` holds everything at its
    // starting point meanwhile, or the outline and the rows would jump to the
    // end and back.
    const timing: KeyframeAnimationOptions = { duration: BOX_CLOSE_MS, delay: 60, easing: EASE_IN, fill: "backwards" };
    boxClose({
      host: list,
      from,
      to: row === null ? null : boxOf(row),
      out,
      src: row,
      hide: row === null ? [] : [row],
      cls: "tk-ghost",
      also: [...slideRows(list, before, timing, id), ...easeHeight(list, h0, timing)],
      done: () => {
        if (row?.isConnected) {
          row.animate([{ backgroundColor: "var(--tint-2)", offset: 0 }], { duration: 450, easing: "ease-out" });
        }
      },
    });
    focusRow();
  }

  // ── C273: the prompts under a row ─────────────────────────────────────────
  /** A local change that adds or removes a block under a row: the rows below
   *  slide instead of jumping (new blocks rise in through CSS). */
  function withSlide(change: () => void) {
    const list = listRef.current;
    if (list === null || motionOff()) {
      change();
      return;
    }
    settleBox();
    const before = rowTops(list);
    flushSync(change);
    slideRows(list, before, { duration: 320, easing: EASE_OUT });
  }

  /** The block leaves first (140ms), then the state that removes it. */
  async function promptOut(id: string, kind: string) {
    const el = rowEl(id)?.querySelector<HTMLElement>(`[data-prompt="${kind}"]`);
    if (!el || motionOff()) return;
    await el
      .animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-4px)" }], {
        duration: 140,
        easing: "ease-in",
        fill: "forwards",
      })
      .finished.catch(() => undefined);
  }

  async function closePrompt(kind: "block" | "verify" | "nudge") {
    const id = kind === "block" ? blockTarget : kind === "verify" ? verifyTarget : nudgeTarget;
    if (id === null) return;
    await promptOut(id, kind);
    withSlide(() => {
      if (kind === "block") {
        setBlockTarget(null);
        setBlockReason("");
      } else if (kind === "verify") {
        setVerifyTarget(null);
        setVerifyNote("");
      } else {
        setNudgeTarget(null);
      }
    });
  }

  // Its own instance rather than sharing `mutating`: this one also drives the
  // new-task row's disabled state, so folding it in would grey the row out
  // whenever any row is mid-write.
  function createTask() {
    return runCreate(async () => {
      setError(null);
      await api.createTask({ title, description, priority, tags: parseTags(tagsRaw) });
      setTitle("");
      setDescription("");
      setPriority(1);
      setTagsRaw("");
      planSlide();
      await load();
      onMutated();
    });
  }

  const applyStatus = (id: string, status: TaskStatus, reason?: string) =>
    guarded(async () => {
      const update = await api.updateTaskStatus(id, status, reason);
      if (blockTarget === id) await promptOut(id, "block");
      planSlide();
      return () => {
        // Completing without evidence is the moment the product's core claim
        // is worth teaching; only fall back to the snapshot flash once it is
        // off.
        if (status === "done" && !update.task.verifiedAt && verifyNudgeEnabled()) {
          setNudgeTarget(id);
        } else {
          if (nudgeTarget === id) setNudgeTarget(null);
          if (update.handoff !== null && status === "done") showFlash(t("tasks.doneHandoffHint"));
        }
        setBlockTarget(null);
        setBlockReason("");
      };
    });

  /** C274's first beat: the evidence line goes before the row turns back. */
  async function fadeEvidence(id: string) {
    const row = rowEl(id);
    if (row === null || motionOff()) return;
    const els = [...row.querySelectorAll<HTMLElement>(".tkx-vrow, .tkx-note, .tkx-unver")];
    await Promise.all(
      els.map((e) =>
        e.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-in", fill: "forwards" })
          .finished.catch(() => undefined),
      ),
    );
  }

  const applyVerification = (id: string, verified: boolean, note?: string) =>
    guarded(
      async () => {
        if (!verified) await fadeEvidence(id);
        await api.setTaskVerification(id, verified, note);
        if (verifyTarget === id) await promptOut(id, "verify");
        planSlide();
        return () => {
          showFlash(t("tasks.verifiedHint"));
          setVerifyTarget(null);
          setVerifyNote("");
          setNudgeTarget(null);
        };
      },
      // C26: ten points of light from the row's mark into the sweep count —
      // the number they land in is the one that just went up.
      verified
        ? () => {
            const mk = rowEl(id)?.querySelector(".tr-mk");
            const n = document.querySelector("[data-sweep-n]");
            if (visible(mk) && visible(n)) fx.particles(centreOf(mk), centreOf(n), { n: 10, dur: 700 });
          }
        : undefined,
    );

  function announceFold(updated: TaskUpdate) {
    // Archiving may fold delta specs (D79) — surface the outcome so the
    // spec-layer write is never silent.
    if (!updated.specFold) return;
    const s = updated.specFold;
    showFlash(
      t("tasks.foldedHint", {
        caps: s.capabilities.join(", "),
        counts: `+${s.added} ~${s.modified} -${s.removed} →${s.renamed}`,
      }),
    );
    // What was given up is louder than what was applied: it is the one part
    // of the fold nobody asked the engine to do (D129).
    if (s.skipped?.length) {
      showFlash(t("tasks.foldSkippedHint", { names: s.skipped.join(", ") }));
    }
  }

  /**
   * C277: a task leaving for the archive. When it folded specs, a stream of
   * light runs from its mark into the sidebar's Specs entry, which lights up
   * as it arrives — the fold is a write somewhere else, and this is where.
   * Then the row fades and the rest close up. With "show archived" ticked the
   * row stays and dims instead (C279, on the row's own diff).
   */
  async function leaveForArchive(ids: string[], update: TaskUpdate | null, stagger = 0) {
    const rows = ids.map(rowEl);
    if (update?.specFold && rows[0] !== null) {
      const from = rows[0].querySelector(".tr-mk") ?? rows[0];
      const specs = document.querySelector<HTMLElement>('.nav-item[data-view="specs"]');
      if (!motionOff() && visible(from) && visible(specs)) {
        fx.beam(centreOf(from), centreOf(specs), { dur: 620, bend: 0.18, width: 2 });
        await wait(600);
        specs.classList.remove("shell-flash");
        void specs.offsetWidth;
        specs.classList.add("shell-flash");
        window.setTimeout(() => specs.classList.remove("shell-flash"), 640);
      }
    }
    if (showArchived) return;
    if (openId !== null && ids.includes(openId)) setOpenId(null);
    await fadeRowsOut(rows, stagger);
    planSlide();
  }

  const applyArchived = (task: Task) =>
    guarded(async () => {
      const id = task.id;
      if (task.archived) {
        // C279 backwards: the "archived" mark goes first, the row brightens
        // on its own diff once the write lands.
        const pill = rowEl(id)?.querySelector<HTMLElement>(".tkx-pill--arch");
        if (pill && !motionOff()) {
          await pill
            .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-in", fill: "forwards" })
            .finished.catch(() => undefined);
        }
        await api.setTaskArchived(id, false);
        return;
      }
      let update: TaskUpdate;
      try {
        update = await api.setTaskArchived(id, true);
      } catch (e) {
        if (errorKind(e) !== "spec_fold_conflict") throw e;
        // A fold conflict is the one archive failure with a real choice behind
        // it, so it gets a dialog instead of the error strip. The structured
        // overlaps come from the dry-run rather than being parsed back out of
        // the message — the message is for reading, not for machines.
        const report = (await api.pendingSpecFolds()).find((r) => r.taskId === id);
        const blocking = (report?.overlaps ?? []).filter((o) => o.otherFolded && o.otherNewer);
        if (blocking.length === 0) throw e;
        setFoldConflict({ id, overlaps: blocking });
        return;
      }
      await leaveForArchive([id], update);
      announceFold(update);
    });

  const archiveGivingUp = (id: string, overlaps: SpecOverlap[]) =>
    guarded(async () => {
      const skip: [string, string][] = overlaps.map((o) => [o.capability, o.requirement]);
      const update = await api.archiveTaskSkippingSpecs(id, skip);
      setFoldConflict(null);
      await leaveForArchive([id], update);
      announceFold(update);
    });

  // C278: the verified rows go top to bottom, 40ms apart.
  const sweepArchive = () =>
    guarded(async () => {
      const swept = await api.archiveVerifiedDoneTasks();
      await leaveForArchive(swept, null, 40);
      if (swept.length > 0) showFlash(t("tasks.sweepDone", { n: swept.length }));
    });

  function openEdit(task: Task) {
    setEditTarget(task);
    setEditTitle(task.title);
    setEditDescription(task.description);
    setEditPriority(task.priority);
    setEditTags(task.tags.join(", "));
    setEditSteps((task.steps ?? []).map((s) => s.title).join("\n"));
    setEditError(null);
  }

  function saveEdit() {
    if (!editTarget) return;
    const id = editTarget.id;
    return runSave(async () => {
      setEditError(null);
      await api.editTask(id, {
        title: editTitle,
        description: editDescription,
        priority: editPriority,
        tags: parseTags(editTags),
        steps: editSteps
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      });
      setEditTarget(null);
      showFlash(t("tasks.editedHint"));
      planSlide();
      await load();
      onMutated();
      // C216: the row it changed is swept with light once the dialog is gone.
      setLitId(id);
    });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    // has_dependents is phrased for humans centrally (errors.* in api.ts), so
    // the refusal already names who is holding the task.
    return runDelete(async () => {
      setDeleteError(null);
      await api.deleteTask(id);
      setDeleteTarget(null);
      showFlash(t("tasks.deletedHint"));
      // C217: the row fades where it stands, the rest close up.
      if (openId === id) setOpenId(null);
      await fadeRowsOut([rowEl(id)]);
      planSlide();
      await load();
      onMutated();
    });
  }

  function onStatusSelect(task: Task, status: TaskStatus) {
    if (status === task.status) return;
    if (status === "blocked" || status === "cancelled") {
      // Ask first; the select stays on the old status until the reason is in.
      withSlide(() => {
        setBlockTarget(task.id);
        setBlockAs(status);
        setBlockReason("");
      });
      return;
    }
    void applyStatus(task.id, status);
  }

  const act: RowActions = {
    open: openTask,
    close: closeTask,
    tag: pickTag,
    status: onStatusSelect,
    markVerify: (id) =>
      withSlide(() => {
        setVerifyTarget(id);
        setVerifyNote("");
      }),
    unverify: (id) => void applyVerification(id, false),
    archive: (task) => void applyArchived(task),
    step: (task, step, done) =>
      void guarded(async () => {
        await api.setTaskStep(task.id, step, done);
        await load();
        onMutated();
      }),
    edit: openEdit,
    remove: (task) => {
      setDeleteTarget(task);
      setDeleteError(null);
    },
    nudgeVerify: (id) =>
      withSlide(() => {
        setVerifyTarget(id);
        setVerifyNote("");
        setNudgeTarget(null);
      }),
    nudgeLater: () => void closePrompt("nudge"),
    nudgeNever: () => {
      setVerifyNudgeEnabled(false);
      void closePrompt("nudge");
    },
    blockCancel: () => void closePrompt("block"),
    blockConfirm: (id) => void applyStatus(id, blockAs, blockReason),
    verifyCancel: () => void closePrompt("verify"),
    verifyConfirm: (id) => void applyVerification(id, true, verifyNote),
  };

  const [sweepPre, sweepPost] = around(t("tasks.archiveSweep", { n: MARK }));
  const [shelfPre, shelfPost] = around(t("tasks.showArchived", { n: MARK }));
  const loaded = !loading;

  return (
    <div className={`view view--tasks${entering ? " tk-enter" : ""}`} ref={pageRef}>
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("tasks.heading")}</h1>
          <p className="view-sub">{t("tasks.subtitle")}</p>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}
      {flash && <div className="alert alert-ok">{flash}</div>}

      {/* One low row (D153): the title is the only thing a task needs, so the
          optional fields fold away beneath it. */}
      <section className="panel tk-add" aria-label={t("tasks.newTitle")}>
        <span className="tk-add-h">
          <IconPlus size={15} />
          {t("tasks.newTitle")}
        </span>
        {/* Spelled out in the picker, bare in the rows: the choice is where
            someone meets the scale for the first time and "P0" says nothing
            about which end is urgent (2026-08-01 UI review, P3-3). */}
        <select
          value={priority}
          aria-label={t("tasks.priority")}
          onChange={(e) => setPriority(Number(e.target.value))}
        >
          <option value={0}>{t("tasks.prio0")}</option>
          <option value={1}>{t("tasks.prio1")}</option>
          <option value={2}>{t("tasks.prio2")}</option>
          <option value={3}>{t("tasks.prio3")}</option>
        </select>
        <input
          ref={newTitleRef}
          className="tk-add-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && title.trim() !== "" && !creating) void createTask();
          }}
          aria-label={t("tasks.titleLabel")}
          placeholder={t("tasks.titlePlaceholder")}
        />
        <button
          className="btn btn-primary btn-small"
          onClick={() => void createTask()}
          disabled={creating || title.trim() === ""}
        >
          <IconPlus size={14} />
          {creating ? t("tasks.creating") : t("tasks.create")}
        </button>
        <details className="tk-more">
          <summary>
            <IconCaretDown size={13} className="tk-more-caret" />
            {t("tasks.moreFields")}
          </summary>
          <div className="tk-more-f">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-label={t("tasks.descLabel")}
              placeholder={t("tasks.descPlaceholder")}
            />
            <input
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              aria-label={t("tasks.tagsLabel")}
              placeholder={t("tasks.tagsPlaceholder")}
            />
          </div>
        </details>
      </section>

      {loaded && tasks.length > 0 && (
        <div className="tk-bar">
          <label className="tk-search">
            <IconSearch size={14} />
            <input
              value={query}
              onChange={(e) => {
                const v = e.target.value;
                setQuery(v);
                swapList(() => {
                  setAppliedQuery(v);
                  setOpenId(null);
                });
              }}
              aria-label={t("tasks.search")}
              placeholder={t("tasks.searchPlaceholder")}
            />
          </label>
          <Segmented
            label={t("tasks.filterStatus")}
            markName="segi"
            value={statusFilter}
            onChange={(v) =>
              swapList(() => {
                setStatusFilter(v);
                setOpenId(null);
              })
            }
            options={[
              { value: "all" as const, label: t("tasks.filterAll"), count: <Scramble value={counts.all} /> },
              ...STATUSES.map((s) => ({
                value: s,
                label: t(`status.${s}`),
                count: <Scramble value={counts[s]} />,
              })),
            ]}
          />
          {allTags.length > 0 && (
            <label className="tk-sel">
              <span>{t("tasks.filterTag")}</span>
              <select
                value={tagFilter}
                onChange={(e) => {
                  const v = e.target.value;
                  swapList(() => {
                    setTagFilter(v);
                    setOpenId(null);
                  });
                }}
              >
                <option value="all">{t("tasks.filterTagAll")}</option>
                {allTags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="tk-sel">
            <span>{t("tasks.sort")}</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="id">{t("tasks.sortId")}</option>
              <option value="priority">{t("tasks.sortPriority")}</option>
              <option value="updated">{t("tasks.sortUpdated")}</option>
            </select>
          </label>
          {filtered && (
            <button className="btn btn-small tk-clear" data-vt-name="tkx-clear" onClick={clearFilters}>
              {t("tasks.clearFilters")}
            </button>
          )}
        </div>
      )}

      <section className="panel tk-list" data-vt="tklist" ref={listRef}>
        {(archivedCount > 0 || sweepable > 0 || wsSettings !== null) && (
          <div className="archive-bar">
            {(archivedCount > 0 || sweepable > 0) && (
              <button
                className="btn btn-small"
                disabled={sweepable === 0 || mutating}
                onClick={() => void sweepArchive()}
              >
                <IconArchive size={14} />
                <span>
                  {sweepPre}
                  <span data-sweep-n>
                    <Scramble value={sweepable} />
                  </span>
                  {sweepPost}
                </span>
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
              <Check checked={showArchived} onChange={(v) => swapList(() => setShowArchived(v))}>
                {/* One span: the check lays its children out with a gap, and
                    the number is inside the sentence, not beside it. */}
                <span>
                  {shelfPre}
                  <Scramble value={archivedCount} />
                  {shelfPost}
                </span>
              </Check>
            )}
          </div>
        )}
        {loading ? null : visibleTasks.length === 0 ? (
          <div className="tk-none" data-vt-name="tkx-empty">
            {tasks.length === 0 ? (
              <EmptyState title={t("tasks.empty")} hint={t("tasks.emptyHint")} />
            ) : filtered ? (
              // No action here: the filter bar's own "Clear filters" button is
              // visible directly above whenever this state can occur, and two
              // identical buttons a row apart read as two different things.
              <EmptyState title={t("tasks.filterNone")} hint={t("tasks.filterNoneHint")} />
            ) : (
              <EmptyState title={t("tasks.allArchived")} hint={t("tasks.allArchivedHint")} />
            )}
          </div>
        ) : (
          <>
            {/* The done-vs-verified distinction used to be a line above the
                table (D89); it is teaching, so it moved behind the ⓘ on the
                column it explains (D153, invariant 17(c)). */}
            <div className="tk-th">
              <span>ID</span>
              <span>
                {t("tasks.priority")} · {t("tasks.titleLabel")}
              </span>
              <span>
                {t("tasks.colStatus")} · {t("tasks.colVerify")}
                <InfoTip label={t("common.moreInfo")}>{t("tasks.listHint")}</InfoTip>
              </span>
              <span className="sr-only">{t("tasks.edit")}</span>
            </div>
            <ul className="tk-rows">
              {visibleTasks.map((task, j) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  index={j}
                  open={openId === task.id}
                  fresh={freshIds.has(task.id)}
                  lit={litId === task.id}
                  tagFilter={tagFilter}
                  mutating={mutating}
                  nudge={nudgeTarget === task.id}
                  blocking={blockTarget === task.id}
                  blockAs={blockAs}
                  blockReason={blockReason}
                  setBlockReason={setBlockReason}
                  verifying={verifyTarget === task.id}
                  verifyNote={verifyNote}
                  setVerifyNote={setVerifyNote}
                  act={act}
                />
              ))}
            </ul>
          </>
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
                {/* Same spelled-out scale as the add row above. */}
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
            <label className="field">
              <span>
                {t("tasks.stepsLabel")} {t("common.optional")}
              </span>
              <textarea
                rows={4}
                value={editSteps}
                onChange={(e) => setEditSteps(e.target.value)}
                placeholder={t("tasks.stepsPlaceholder")}
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

      {foldConflict && (
        <Modal label={t("tasks.foldConflictTitle")} onClose={() => setFoldConflict(null)}>
          <div className="form">
            <h2 className="form-heading">{t("tasks.foldConflictTitle")}</h2>
            <p className="muted">{t("tasks.foldConflictHint")}</p>
            <ul className="fold-conflict-list">
              {foldConflict.overlaps.map((o) => (
                <li key={`${o.capability}/${o.requirement}`}>
                  <code>{o.requirement}</code>
                  <span className="muted">
                    {" "}
                    {t("tasks.foldConflictRow", {
                      capability: o.capability,
                      task: o.otherTask,
                    })}
                  </span>
                </li>
              ))}
            </ul>
            {/* Two real options, and the recommended one is first: the agent
                that wrote the delta is the one that can merge both needs. The
                second is here so deciding "this task's wording is obsolete"
                never requires hand-editing a delta file. */}
            <p>{t("tasks.foldConflictAsk")}</p>
            <div className="form-actions">
              <button className="btn" onClick={() => setFoldConflict(null)}>
                {t("tasks.foldConflictLeave")}
              </button>
              <button
                className="btn danger-trigger"
                disabled={mutating}
                onClick={() => void archiveGivingUp(foldConflict.id, foldConflict.overlaps)}
              >
                {t("tasks.foldConflictGiveUp")}
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
