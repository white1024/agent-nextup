import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { api, errorMessage } from "../api";
import { useGuardedMutation, useWorkspaceData } from "../hooks";
import { useFreshKeys } from "../hooks/anim";
import EmptyState from "../components/EmptyState";
import ErrorBar from "../components/ErrorBar";
import FlashBar from "../components/FlashBar";
import InfoTip from "../components/InfoTip";
import Modal from "../components/Modal";
import PathLabel from "../components/PathLabel";
import { IconPaperclip } from "../components/icons";
import { seenDeliveries, unreadFor } from "../lib/notify";
import type { DeliveryEnvelope, DeliverySummary } from "../types";
import TimeAgo from "../components/TimeAgo";
import { absoluteTime } from "../lib/time";
import { baseName, formatBytes } from "../lib/format";
import { centreOf, fx, motionOff, takeOrigin, tokenRgb } from "../lib/fx";
import { boxClose, boxOf, boxOpen, pictureOf, settleBox, type Box } from "../lib/listMotion";

/** Rows rendered per mailbox before "show more" (the ledger's page size, D60). */
const PAGE = 50;

/** C41's rhythm: the k-th unread envelope gets its beam at BEAM + k·STEP. */
const C41_BEAM_MS = 260;
const C41_STEP_MS = 170;
const C41_LAND_MS = 500;

/**
 * A one-phrase name for an envelope, for the places that need words rather
 * than layout: the per-row button labels a screen reader reads out of context.
 *
 * The first non-empty line, clipped — notes are unbounded prose, and an
 * accessible name that runs for a paragraph is as useless as N identical ones.
 */
function summarise(note: string | undefined, fallback: string): string {
  const first = (note ?? "").split("\n").find((line) => line.trim() !== "");
  if (first === undefined) return fallback;
  const trimmed = first.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}

/** The row an envelope opened from, in either list. */
function rowEl(scope: HTMLElement | null, id: string): HTMLElement | null {
  return scope?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`) ?? null;
}

interface Props {
  root: string;
  refreshKey: number;
  onMutated: () => void;
  /** Jump to the tasks page — the destination of "Turn into a task" (product review §5-9). */
  onGoToTasks: () => void;
}

/**
 * Workspace exchange view (team module, D48): deliveries routed in from team
 * upstreams, plus the publish surface. Inbox content is *data from another
 * project* — the view renders it read-only; "Accept" means turning it into a
 * task by hand. Routing (who gets my outbox) lives in the app-level team
 * view, not here.
 *
 * D153 (spec 40): received on the left, publishing and the pending outbox on
 * the right where they stay in view while the left scrolls; one column with
 * publishing first when the main area is narrow. An envelope opens out of its
 * row and folds back into it (C42).
 */
export default function Inbox({ root, refreshKey, onMutated, onGoToTasks }: Props) {
  const { t, i18n } = useTranslation();
  const { data, error, setError, reload } = useWorkspaceData<{
    inbox: DeliverySummary[];
    outbox: DeliverySummary[];
  }>(
    async () => ({
      inbox: await api.exchangeList(root, "inbox"),
      outbox: await api.exchangeList(root, "outbox"),
    }),
    refreshKey,
  );
  const pageRef = useRef<HTMLDivElement>(null);

  // Which envelopes were unread when this page opened.
  //
  // Read once and frozen for the visit — that is the load-bearing part. Being
  // on this page is *itself* what counts as reading it, so
  // `useWorkspaceNotifications` marks the whole mailbox seen while it is open;
  // every later render (a `refreshKey` bump, a watcher delta) would therefore
  // find an empty set and the marks would vanish under the reader's eyes.
  // Behaves like a mail client: the bold stays until you leave, and an envelope
  // that arrives while the page is open is absent from the snapshot and so
  // shows up marked.
  //
  // Taken during render rather than in an effect because that is the cheapest
  // way to freeze it, and it puts the marks in the first paint instead of
  // flipping them on a frame later.
  const unreadRef = useRef<{ root: string; ids: Set<string> | null } | null>(null);
  if (unreadRef.current === null || unreadRef.current.root !== root) {
    // `null` means this machine has never listed this inbox: the notify layer
    // adopts such a mailbox silently rather than declaring months of history
    // new, and this follows it — no snapshot, no marks.
    unreadRef.current = { root, ids: seenDeliveries(root) };
  }
  const seenAtOpen = unreadRef.current.ids;
  // The agent half of the rule reads live data, so an envelope the agent opens
  // while this page is up loses its bold on the spot — it has been picked up.
  const isUnread = (row: DeliverySummary) => unreadFor(seenAtOpen, row);

  /** How many rows each mailbox is showing; grows by PAGE on "show more". */
  const [inboxShown, setInboxShown] = useState(PAGE);
  const [outboxShown, setOutboxShown] = useState(PAGE);

  const [note, setNote] = useState("");
  /** Absolute paths chosen from the native picker to ride with the next publish. */
  const [files, setFiles] = useState<string[]>([]);
  // One instance for all three mutations, keeping the existing scope where any
  // one of them locks the whole panel. All three are non-idempotent — a
  // repeated call writes a second envelope, a second ledger line or a second
  // task — and none of them had the ref gate that makes `disabled` hold
  // against a same-tick double click.
  const { busy, run } = useGuardedMutation(setError);
  const [flash, setFlash] = useState<string | null>(null);
  const [open, setOpen] = useState<DeliveryEnvelope | null>(null);
  /** Id of the task just created from an envelope — drives the "Go to task" link. */
  const [createdTask, setCreatedTask] = useState<string | null>(null);

  /** Non-null while composing a Save-as-decision entry inside the envelope modal. */
  const [decisionDraft, setDecisionDraft] = useState<string | null>(null);
  /** The envelope's action strip was swapped by the user (it rises; the first one does not). */
  const [swapped, setSwapped] = useState(false);
  const decisionRef = useRef<HTMLTextAreaElement>(null);

  /** Outbox envelope the next publish declares it corrects (D87 ⑦); "" for none. */
  const [supersedes, setSupersedes] = useState("");
  // Only an unsent envelope can be superseded: routing moves it out of the
  // outbox, and claiming to recall a copy already downstream would be a lie the
  // sender acts on — core refuses it. Ones already marked are left out too, so
  // the chain points at the live envelope rather than overwriting the stamp that
  // is the publisher's own word that the older one is wrong.
  const supersedable = (data?.outbox ?? []).filter((row) => !row.supersededBy);
  // A refresh can route the chosen envelope away underneath the open form. Fall
  // back to "not a correction" rather than publishing a claim core will reject.
  const supersedesValue = supersedable.some((r) => r.id === supersedes) ? supersedes : "";

  // ── Motion (D153; each piece only on its own event) ─────────────────────

  // Entering from the sidebar: the rows rise one after another. Not when a
  // page frame is the arrival, and only on the mount — a reload is not one.
  const [entering, setEntering] = useState(false);
  useEffect(() => {
    if (motionOff() || document.querySelector(".pt-veil") !== null) return;
    setEntering(true);
    const timer = window.setTimeout(() => setEntering(false), 1400);
    return () => window.clearTimeout(timer);
  }, []);

  // C45: an envelope that has just been published slides in at the top of
  // the pending list. The first read is the baseline even when it is empty,
  // so the first envelope ever published arrives too.
  const freshOut = useFreshKeys(
    (data?.outbox ?? []).map((row) => row.id),
    1600,
    data !== null,
  );

  // C46: the batch "show more" revealed rises row by row.
  const [moreIn, setMoreIn] = useState<{ box: "in" | "out"; from: number } | null>(null);
  useEffect(() => {
    if (moreIn === null) return;
    const timer = window.setTimeout(() => setMoreIn(null), 1000);
    return () => window.clearTimeout(timer);
  }, [moreIn]);
  function showMore(box: "in" | "out") {
    const from = box === "in" ? inboxShown : outboxShown;
    if (!motionOff()) setMoreIn({ box, from });
    (box === "in" ? setInboxShown : setOutboxShown)((n) => n + PAGE);
  }

  // C41: arriving through the sidebar badge, an amber beam runs from the badge
  // to each unread envelope; the dot pops and the row is swept as it lands.
  // Once, on the first read — the badge's point is left by the click (App).
  const [lit, setLit] = useState<Map<string, number>>(() => new Map());
  const arrived = useRef(false);
  const c41Timers = useRef<number[]>([]);
  useEffect(() => () => c41Timers.current.forEach((id) => window.clearTimeout(id)), []);
  useEffect(() => {
    if (data === null || arrived.current) return;
    arrived.current = true;
    const from = takeOrigin("inbox");
    if (from === null || motionOff()) return;
    const targets = data.inbox.slice(0, Math.min(inboxShown, 12)).filter(isUnread);
    if (targets.length === 0) return;
    const rgb = tokenRgb("--orange");
    const marks = new Map<string, number>();
    targets.forEach((row, k) => {
      const at = C41_BEAM_MS + k * C41_STEP_MS;
      marks.set(row.id, at + C41_LAND_MS);
      // Measured when the beam leaves, not now: the rows are still rising.
      c41Timers.current.push(
        window.setTimeout(() => {
          const dot = rowEl(pageRef.current, row.id)?.querySelector(".mail-dot");
          const to = centreOf(dot);
          if (to === null || to.y < 0 || to.y > window.innerHeight) return;
          fx.beam(from, to, { width: 2.2, bend: 0.12, dur: 560, rgb });
        }, at),
      );
    });
    setLit(marks);
    const last = C41_BEAM_MS + targets.length * C41_STEP_MS + C41_LAND_MS + 800;
    c41Timers.current.push(window.setTimeout(() => setLit(new Map()), last));
    // Keyed on the first read only (the ref guards the rest).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ── The envelope (C42) ──────────────────────────────────────────────────

  /** The row an envelope opened from (its lit background), until it folds back in. */
  const [srcId, setSrcId] = useState<string | null>(null);
  /** Taken at the click, played when the dialog has rendered. */
  const growFrom = useRef<{ from: Box; picture: HTMLElement } | null>(null);

  useLayoutEffect(() => {
    if (open === null) return;
    const g = growFrom.current;
    growFrom.current = null;
    const panel = pageRef.current?.querySelector<HTMLElement>(".env-dlg") ?? null;
    const host = panel?.parentElement ?? null;
    if (panel === null || host === null) return;
    boxOpen({
      host,
      from: g?.from ?? { left: 0, top: 0, width: 0, height: 0 },
      picture: g?.picture ?? null,
      dst: panel,
      cls: "env-ghost",
    });
  }, [open]);

  // Record as decision: the text box takes focus with the caret after the
  // prefilled words, ready to add to them.
  useEffect(() => {
    const el = decisionRef.current;
    if (decisionDraft === null || el === null || document.activeElement === el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    // Only on the swap in, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionDraft !== null]);

  async function chooseFiles() {
    try {
      const picked = await openDialog({ multiple: true });
      if (Array.isArray(picked)) {
        // Merge and dedupe by path; the count/size caps are enforced by core.
        setFiles((prev) => Array.from(new Set([...prev, ...picked])));
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function publish() {
    return run(async () => {
      setError(null);
      const envelope = await api.exchangePublish(
        note.trim() === "" ? null : note.trim(),
        files.length > 0 ? files : undefined,
        supersedesValue === "" ? undefined : supersedesValue,
      );
      setNote("");
      setFiles([]);
      setSupersedes("");
      setCreatedTask(null);
      setFlash(`${t("inbox.published")} ${envelope.id.slice(0, 8)}`);
      await reload();
      onMutated();
    });
  }

  async function view(row: DeliverySummary, mailbox: "inbox" | "outbox") {
    setError(null);
    setDecisionDraft(null);
    setSwapped(false);
    try {
      const envelope = await api.exchangeGet(root, mailbox, row.id);
      settleBox();
      const el = rowEl(pageRef.current, row.id);
      growFrom.current = el === null ? null : { from: boxOf(el), picture: pictureOf(el) };
      setSrcId(row.id);
      setOpen(envelope);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /**
   * Closing, by any way out (✕, Close, Esc, the scrim, a write): the envelope
   * folds back into its row — unless the row is off screen, when the dialog
   * just sinks. `after` runs once the envelope is gone (the result line drops
   * in then, C43).
   */
  function closeEnvelope(after?: () => void) {
    const panel = pageRef.current?.querySelector<HTMLElement>(".env-dlg") ?? null;
    const backdrop = panel?.parentElement ?? null;
    const row = srcId === null ? null : rowEl(pageRef.current, srcId);
    settleBox();
    const to = row === null ? null : boxOf(row);
    const inView = to !== null && to.height > 0 && to.top + to.height > 0 && to.top < window.innerHeight;
    const finish = () => {
      setSrcId(null);
      after?.();
    };
    if (panel !== null && backdrop !== null && inView && !motionOff()) {
      // The scrim stays the Modal's to fade; the panel is ours to carry back.
      backdrop.dataset.exit = "scrim";
      const layer = document.createElement("div");
      layer.className = "env-layer";
      layer.setAttribute("aria-hidden", "true");
      document.body.appendChild(layer);
      boxClose({
        host: layer,
        from: boxOf(panel),
        to,
        out: pictureOf(panel),
        src: row,
        hide: row === null ? [] : [row],
        cls: "env-ghost",
        done: () => {
          layer.remove();
          finish();
        },
      });
    } else {
      finish();
    }
    setOpen(null);
    setDecisionDraft(null);
  }

  /** Save as decision (team module design §7, added later): a prefilled, editable ledger decision referencing the envelope. */
  function startDecision(envelope: DeliveryEnvelope) {
    const base = t("inbox.decisionPrefill", {
      name: envelope.from.name,
      team: envelope.deliveredVia?.teamName ?? "-",
      id: envelope.id.slice(0, 8),
    });
    setSwapped(true);
    setDecisionDraft(envelope.payload.note ? `${base}${envelope.payload.note}` : base);
  }

  function saveDecision() {
    if (decisionDraft === null || decisionDraft.trim() === "") return;
    return run(async () => {
      setError(null);
      await api.addLedgerNote("decision", decisionDraft.trim());
      onMutated();
      closeEnvelope(() => {
        setCreatedTask(null);
        setFlash(t("inbox.decisionSaved"));
      });
    });
  }

  function toTask(envelope: DeliveryEnvelope) {
    return run(async () => {
      setError(null);
      const created = await api.createTask({
        title: envelope.payload.note ?? t("inbox.taskTitle", { name: envelope.from.name }),
        description: t("inbox.taskDesc", {
          name: envelope.from.name,
          team: envelope.deliveredVia?.teamName ?? "-",
          id: envelope.id,
        }),
        priority: 2,
        tags: [],
      });
      onMutated();
      // Name the task that was created and offer the way to it; a bare
      // "Created" leaves the user guessing where it landed.
      closeEnvelope(() => {
        setCreatedTask(created.id);
        setFlash(t("inbox.taskCreated", { id: created.id }));
      });
    });
  }

  /** Per-row classes and stagger variables shared by both lists. */
  function rowMotion(box: "in" | "out", id: string, i: number): { cls: string; style: CSSProperties } {
    let cls = "";
    const style: Record<string, string | number> = { "--j": i };
    if (srcId === id) cls += " env-src";
    if (box === "out" && freshOut.has(id)) cls += " fresh";
    if (box === "in" && lit.has(id)) {
      cls += " lit";
      style["--d"] = `${lit.get(id)}ms`;
    }
    if (moreIn !== null && moreIn.box === box && i >= moreIn.from) {
      cls += " more-in";
      style["--m"] = Math.min(i - moreIn.from, 12);
    }
    return { cls, style: style as CSSProperties };
  }

  const inbox = data?.inbox ?? [];
  const outbox = data?.outbox ?? [];

  return (
    <div className={`view ibx${entering ? " ibx-enter" : ""}`} ref={pageRef}>
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("inbox.heading")}</h1>
          <p className="view-sub">{t("inbox.subtitle")}</p>
        </div>
      </header>

      <ErrorBar error={error} />
      <FlashBar message={flash}>
        {createdTask !== null && (
          <button className="btn btn-small" onClick={onGoToTasks}>
            {t("inbox.goToTask")}
          </button>
        )}
        <button
          className="btn btn-small btn-ghost"
          onClick={() => {
            setFlash(null);
            setCreatedTask(null);
          }}
        >
          {t("common.close")}
        </button>
      </FlashBar>

      <div className="ibx-cols">
        <section className="panel ibx-in">
          <div className="panel-head">
            <h2 className="panel-title">
              {t("inbox.received")}
              <span className="sub">{t("inbox.receivedSub")}</span>
            </h2>
          </div>
          {/* Nothing until the first read answers (invariant 10(c)). */}
          {data !== null && inbox.length === 0 && (
            <EmptyState title={t("inbox.empty")} hint={t("inbox.emptyHint")} />
          )}
          {/* One line per envelope, mail-client shape: sender, note clipped to the
              width available, meta and the action in fixed right-hand columns.
              The full note is one click away in the envelope — which is why the
              IPC still asks for whole notes (see the NoteDetail::Full note in
              commands.rs): the layout bounds them, the data does not. */}
          {inbox.length > 0 && (
            <ul className="mails">
              {inbox.slice(0, inboxShown).map((row, i) => {
                const unread = isUnread(row);
                const m = rowMotion("in", row.id, i);
                return (
                  <li
                    className={`mail${unread ? " unread" : ""}${m.cls}`}
                    style={m.style}
                    key={row.id}
                    data-row={row.id}
                  >
                    <span className="mail-dot" aria-hidden="true" />
                    <div className="mail-body">
                      <div className="mail-line">
                        {unread && <span className="sr-only">{t("inbox.unread")}</span>}
                        <span className="mail-from">{row.from.name}</span>
                        {row.note && <span className="mail-note">{row.note}</span>}
                        {row.attachmentCount > 0 && (
                          <span className="mail-att" title={t("inbox.attachments", { n: row.attachmentCount })}>
                            <IconPaperclip size={11} />
                            {row.attachmentCount}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="mail-meta">
                      {row.agentReadAt
                        ? `${row.agentReadBy ? t("inbox.agentReadBy", { name: row.agentReadBy }) : t("inbox.agentRead")} · `
                        : ""}
                      {row.deliveredVia ? `${t("teams.viaTeam")} ${row.deliveredVia.teamName} · ` : ""}
                      <TimeAgo at={row.deliveredAt ?? row.publishedAt} />
                    </div>
                    {/* Named per row: a screen reader listing the page's buttons gets
                        N identical "View"s otherwise, and which envelope each opens is
                        exactly the thing that is not on screen for that reader. */}
                    <button
                      className="btn btn-small"
                      aria-label={t("inbox.viewFrom", {
                        name: row.from.name,
                        summary: summarise(row.note, row.id.slice(0, 8)),
                      })}
                      onClick={() => void view(row, "inbox")}
                    >
                      {t("inbox.view")}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {inbox.length > inboxShown && (
            <div className="mail-foot">
              <button className="btn btn-small" onClick={() => showMore("in")}>
                {t("inbox.showMore", { n: inbox.length - inboxShown })}
              </button>
            </div>
          )}
          <p className="ibx-trust">{t("inbox.trustHint")}</p>
        </section>

        <section className="panel ibx-out">
          <div className="panel-head">
            <h2 className="panel-title">
              {t("inbox.publish")}
              <span className="sub">{t("inbox.publishSub")}</span>
            </h2>
          </div>
          <div className="ibx-pub">
            <input
              value={note}
              aria-label={t("inbox.notePlaceholder")}
              placeholder={t("inbox.notePlaceholder")}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="ibx-attach-row">
            <button className="btn btn-small" disabled={busy} onClick={() => void chooseFiles()}>
              <IconPaperclip size={14} />
              {t("inbox.attachFiles")}
            </button>
            <span>{t("inbox.attachHint")}</span>
          </div>
          {files.length > 0 && (
            <div className="ibx-chips">
              {files.map((f) => (
                <span className="ibx-chip" key={f}>
                  <IconPaperclip size={12} />
                  {baseName(f)}
                  <button
                    className="ibx-chip-x"
                    aria-label={t("inbox.attachRemove", { name: baseName(f) })}
                    onClick={() => setFiles(files.filter((x) => x !== f))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {supersedable.length > 0 && (
            <div className="ibx-sup">
              <label>
                <span>{t("inbox.supersedeLabel")}</span>
                <select
                  value={supersedesValue}
                  disabled={busy}
                  onChange={(e) => setSupersedes(e.target.value)}
                >
                  <option value="">{t("inbox.supersedeNone")}</option>
                  {supersedable.map((row) => (
                    // Note first, id second: the note is how the publisher
                    // recognises which envelope this is. Separated by a middot,
                    // not parentheses — the note is user text in either locale and
                    // the id is Latin, so a bracket pair would have to pick a width.
                    <option key={row.id} value={row.id}>
                      {row.note ? `${row.note} · ${row.id.slice(0, 8)}` : row.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              {/* Teaching, so one click deep (17(c)); the trust line above stays. */}
              <InfoTip label={t("inbox.supersedeLabel")}>{t("inbox.supersedeHint")}</InfoTip>
            </div>
          )}
          <div className="ibx-pub-go">
            <button
              className="btn btn-primary"
              disabled={busy || (note.trim() === "" && files.length === 0)}
              onClick={() => void publish()}
            >
              {t("inbox.publishNow")}
            </button>
          </div>
          {data !== null && outbox.length === 0 && (
            <EmptyState title={t("inbox.outboxEmpty")} hint={t("inbox.outboxEmptyHint")} />
          )}
          {outbox.length > 0 && (
            <>
              <p className="ibx-pending">{t("inbox.pendingHint")}</p>
              <ul className="mails">
                {outbox.slice(0, outboxShown).map((row, i) => {
                  const m = rowMotion("out", row.id, i);
                  return (
                    <li
                      className={`mail${row.supersededBy ? " superseded" : ""}${m.cls}`}
                      style={m.style}
                      key={row.id}
                      data-row={row.id}
                    >
                      <span className="mail-dot out" aria-hidden="true" />
                      <div className="mail-body">
                        <div className="mail-line">
                          <span className="mail-note lead">{row.note ?? row.id.slice(0, 8)}</span>
                          {row.attachmentCount > 0 && (
                            <span className="mail-att" title={t("inbox.attachments", { n: row.attachmentCount })}>
                              <IconPaperclip size={11} />
                              {row.attachmentCount}
                            </span>
                          )}
                          {/* Same wording as the Teams send surface, where the
                              choice of what to actually send is made — one fact,
                              one vocabulary. Marked, never hidden: which envelope
                              goes out stays the user's call. */}
                          {row.supersededBy && <span className="pill-sup">{t("teams.superseded")}</span>}
                        </div>
                        {/* Its own line: the supersede chain is a sentence about
                            two ids, which the meta column has no room for. */}
                        {(row.supersededBy || row.supersedes) && (
                          <div className="mail-desc">
                            {row.supersededBy &&
                              t("teams.supersededBy", { id: row.supersededBy.slice(0, 8) })}
                            {/* The forward link, shown only here: this is the publisher's
                                own outbox, so "what did I say this corrects" is the
                                confirmation that the declaration landed. */}
                            {row.supersededBy && row.supersedes && " · "}
                            {row.supersedes &&
                              t("inbox.supersedesMark", { id: row.supersedes.slice(0, 8) })}
                          </div>
                        )}
                      </div>
                      <div className="mail-meta">
                        <TimeAgo at={row.publishedAt} />
                      </div>
                      <button
                        className="btn btn-small btn-ghost"
                        aria-label={t("inbox.viewOutbox", {
                          summary: summarise(row.note, row.id.slice(0, 8)),
                        })}
                        onClick={() => void view(row, "outbox")}
                      >
                        {t("inbox.view")}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {outbox.length > outboxShown && (
                <div className="mail-foot">
                  <button className="btn btn-small" onClick={() => showMore("out")}>
                    {t("inbox.showMore", { n: outbox.length - outboxShown })}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {open && (
        <Modal reader grow className="env-dlg" label={t("inbox.envelope")} onClose={() => closeEnvelope()}>
          <h2 className="env-title">{open.from.name}</h2>
          <p className="env-meta">
            {open.deliveredVia ? `${t("teams.viaTeam")} ${open.deliveredVia.teamName} · ` : ""}
            {absoluteTime(open.deliveredAt ?? open.publishedAt, i18n.language)} ·{" "}
            <span className="mono">{open.id}</span>
          </p>
          <p className="env-trust">{t("inbox.trustHint")}</p>
          {open.payload.note && <p className="env-note">{open.payload.note}</p>}
          {open.payload.attachments && open.payload.attachments.length > 0 && (
            <div className="env-att">
              <h3>{t("inbox.attachments", { n: open.payload.attachments.length })}</h3>
              {open.attachmentDir && <PathLabel path={open.attachmentDir} />}
              <ul>
                {/* Show the path when there is one: it is where the file
                    actually sits under the directory above, and the name
                    alone is ambiguous now that two capabilities can both
                    deliver a spec.md. */}
                {open.payload.attachments.map((att) => (
                  <li key={att.path || att.name}>
                    <span className="env-an">{att.path || att.name}</span>
                    <span className="env-as">{formatBytes(att.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {decisionDraft !== null ? (
            <div className={`env-dec${swapped ? " env-swap" : ""}`}>
              <label>
                <span>{t("inbox.decisionLabel")}</span>
                <textarea
                  ref={decisionRef}
                  className="note-input"
                  rows={5}
                  value={decisionDraft}
                  onChange={(e) => setDecisionDraft(e.target.value)}
                />
              </label>
              <div className="env-acts">
                <button
                  className="btn"
                  onClick={() => {
                    setSwapped(true);
                    setDecisionDraft(null);
                  }}
                >
                  {t("common.cancel")}
                </button>
                <button
                  className="btn btn-primary"
                  disabled={busy || decisionDraft.trim() === ""}
                  onClick={() => void saveDecision()}
                >
                  {t("inbox.decisionSave")}
                </button>
              </div>
            </div>
          ) : (
            <div className={`env-acts${swapped ? " env-swap" : ""}`}>
              <button className="btn" onClick={() => closeEnvelope()}>
                {t("common.close")}
              </button>
              {open.deliveredAt != null && (
                <>
                  <button className="btn" disabled={busy} onClick={() => startDecision(open)}>
                    {t("inbox.toDecision")}
                  </button>
                  <button className="btn btn-primary" disabled={busy} onClick={() => void toTask(open)}>
                    {t("inbox.toTask")}
                  </button>
                </>
              )}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
