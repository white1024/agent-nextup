import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { api, errorMessage } from "../api";
import { useGuardedMutation, useWorkspaceData } from "../hooks";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";
import PathLabel from "../components/PathLabel";
import TeachingHint from "../components/TeachingHint";
import { IconPaperclip } from "../components/icons";
import { seenDeliveries } from "../lib/notify";
import type { DeliveryEnvelope, DeliverySummary } from "../types";
import TimeAgo from "../components/TimeAgo";
import { absoluteTime } from "../lib/time";
import { baseName, formatBytes } from "../lib/format";

/** Rows rendered per mailbox before "show more" (the ledger's page size, D60). */
const PAGE = 50;

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
 */
export default function Inbox({ root, refreshKey, onMutated, onGoToTasks }: Props) {
  const { t, i18n } = useTranslation();
  const { data, error, setError, reload, loading } = useWorkspaceData<{
    inbox: DeliverySummary[];
    outbox: DeliverySummary[];
  }>(
    async () => ({
      inbox: await api.exchangeList(root, "inbox"),
      outbox: await api.exchangeList(root, "outbox"),
    }),
    refreshKey,
  );

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
  const isUnread = (row: DeliverySummary) => seenAtOpen !== null && !seenAtOpen.has(row.id);

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
      setFlash(`${t("inbox.published")} ${envelope.id.slice(0, 8)}`);
      await reload();
      onMutated();
    });
  }

  async function view(row: DeliverySummary, mailbox: "inbox" | "outbox") {
    setError(null);
    setDecisionDraft(null);
    try {
      setOpen(await api.exchangeGet(root, mailbox, row.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** Save as decision (team module design §7, added later): a prefilled, editable ledger decision referencing the envelope. */
  function startDecision(envelope: DeliveryEnvelope) {
    const base = t("inbox.decisionPrefill", {
      name: envelope.from.name,
      team: envelope.deliveredVia?.teamName ?? "-",
      id: envelope.id.slice(0, 8),
    });
    setDecisionDraft(envelope.payload.note ? `${base}${envelope.payload.note}` : base);
  }

  function saveDecision() {
    if (decisionDraft === null || decisionDraft.trim() === "") return;
    return run(async () => {
      setError(null);
      await api.addLedgerNote("decision", decisionDraft.trim());
      setDecisionDraft(null);
      setOpen(null);
      setFlash(t("inbox.decisionSaved"));
      onMutated();
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
      setOpen(null);
      // Name the task that was created and offer the way to it; a bare
      // "Created" leaves the user guessing where it landed.
      setCreatedTask(created.id);
      setFlash(t("inbox.taskCreated", { id: created.id }));
      onMutated();
    });
  }

  return (
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("inbox.heading")}</h1>
          <p className="view-sub">{t("inbox.subtitle")}</p>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}
      {flash && (
        <div className="alert alert-ok">
          {flash}
          {createdTask !== null && (
            <button
              className="btn-link"
              style={{ marginLeft: "var(--s-2)" }}
              onClick={onGoToTasks}
            >
              {t("inbox.goToTask")}
            </button>
          )}
          <button
            className="btn btn-ghost"
            style={{ marginLeft: "var(--s-2)" }}
            onClick={() => {
              setFlash(null);
              setCreatedTask(null);
            }}
          >
            {t("common.close")}
          </button>
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            {t("inbox.received")}
            <span className="sub">{t("inbox.receivedSub")}</span>
          </h2>
        </div>
        {!loading && (data?.inbox ?? []).length === 0 && (
          <EmptyState title={t("inbox.empty")} hint={t("inbox.emptyHint")} />
        )}
        {/* One line per envelope, mail-client shape: sender, note clipped to the
            width available, meta and the action in fixed right-hand columns.
            The full note is one click away in the modal — which is why the IPC
            still asks for whole notes (see the NoteDetail::Full note in
            commands.rs): the layout bounds them, the data does not. */}
        {(data?.inbox ?? []).slice(0, inboxShown).map((row) => {
          const unread = isUnread(row);
          return (
            <div className={`settings-row mail-row${unread ? " unread" : ""}`} key={row.id}>
              <span className="mail-dot" aria-hidden="true" />
              <div className="sr-body">
                <div className="sr-title mail-line">
                  {unread && <span className="sr-only">{t("inbox.unread")}</span>}
                  <span className="mail-from">{row.from.name}</span>
                  {row.note && <span className="mail-note">{row.note}</span>}
                  {row.attachmentCount > 0 && (
                    <span className="pill attach-count">
                      <IconPaperclip size={12} />
                      {row.attachmentCount}
                    </span>
                  )}
                </div>
              </div>
              <div className="mail-meta">
                {row.deliveredVia ? `${t("teams.viaTeam")} ${row.deliveredVia.teamName} · ` : ""}
                <TimeAgo at={row.deliveredAt ?? row.publishedAt} />
              </div>
              {/* Named per row: a screen reader listing the page's buttons gets
                  N identical "View"s otherwise, and which envelope each opens is
                  exactly the thing that is not on screen for that reader. */}
              <button
                className="btn"
                aria-label={t("inbox.viewFrom", {
                  name: row.from.name,
                  summary: summarise(row.note, row.id.slice(0, 8)),
                })}
                onClick={() => void view(row, "inbox")}
              >
                {t("inbox.view")}
              </button>
            </div>
          );
        })}
        {(data?.inbox ?? []).length > inboxShown && (
          <div className="mail-foot">
            <button className="btn" onClick={() => setInboxShown((n) => n + PAGE)}>
              {t("inbox.showMore", { n: (data?.inbox ?? []).length - inboxShown })}
            </button>
          </div>
        )}
        <p className="section-hint" style={{ marginTop: "var(--s-2)" }}>
          {t("inbox.trustHint")}
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            {t("inbox.publish")}
            <span className="sub">{t("inbox.publishSub")}</span>
          </h2>
        </div>
        <div className="field-row">
          <input
            value={note}
            aria-label={t("inbox.notePlaceholder")}
            placeholder={t("inbox.notePlaceholder")}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            className="btn btn-primary"
            disabled={busy || (note.trim() === "" && files.length === 0)}
            onClick={() => void publish()}
          >
            {t("inbox.publishNow")}
          </button>
        </div>
        <div className="attach-row">
          <button className="btn" disabled={busy} onClick={() => void chooseFiles()}>
            <IconPaperclip size={14} />
            {t("inbox.attachFiles")}
          </button>
          <span className="section-hint">{t("inbox.attachHint")}</span>
        </div>
        {files.length > 0 && (
          <div className="attach-chips">
            {files.map((f) => (
              <span className="pill" key={f}>
                <IconPaperclip size={12} />
                {baseName(f)}
                <button
                  className="attach-x"
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
          <div className="supersede-row">
            <label className="field">
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
            <TeachingHint id="inbox-supersede">{t("inbox.supersedeHint")}</TeachingHint>
          </div>
        )}
        {!loading && (data?.outbox ?? []).length === 0 && (
          <EmptyState title={t("inbox.outboxEmpty")} hint={t("inbox.outboxEmptyHint")} />
        )}
        {(data?.outbox ?? []).length > 0 && (
          <>
            <p className="section-hint" style={{ margin: "var(--s-3) 0 var(--s-2)" }}>
              {t("inbox.pendingHint")}
            </p>
            {(data?.outbox ?? []).slice(0, outboxShown).map((row) => (
              <div className="settings-row mail-row" key={row.id}>
                <div className="sr-body">
                  <div className="sr-title mail-line">
                    <span className="mail-note mail-note--lead">
                      {row.note ?? row.id.slice(0, 8)}
                    </span>
                    {row.attachmentCount > 0 && (
                      <span className="pill attach-count">
                        <IconPaperclip size={12} />
                        {row.attachmentCount}
                      </span>
                    )}
                    {/* Same mark and wording as the Teams send surface, where
                        the choice of what to actually send is made — one fact,
                        one vocabulary. Marked, never hidden: which envelope
                        goes out stays the user's call. */}
                    {row.supersededBy && (
                      <span className="pill superseded">{t("teams.superseded")}</span>
                    )}
                  </div>
                  {/* Kept on its own line: the supersede chain is a sentence
                      about two ids, which the right-hand meta column has no
                      room for without pushing the note out of the row. */}
                  {(row.supersededBy || row.supersedes) && (
                    <div className="sr-desc">
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
                  className="btn btn-ghost"
                  aria-label={t("inbox.viewOutbox", {
                    summary: summarise(row.note, row.id.slice(0, 8)),
                  })}
                  onClick={() => void view(row, "outbox")}
                >
                  {t("inbox.view")}
                </button>
              </div>
            ))}
            {(data?.outbox ?? []).length > outboxShown && (
              <div className="mail-foot">
                <button className="btn" onClick={() => setOutboxShown((n) => n + PAGE)}>
                  {t("inbox.showMore", { n: (data?.outbox ?? []).length - outboxShown })}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {open && (
        <Modal reader label={t("inbox.envelope")} onClose={() => setOpen(null)}>
          <div className="form">
            <h2 className="form-heading">{open.from.name}</h2>
            <p className="muted" style={{ margin: 0 }}>
              {open.deliveredVia ? `${t("teams.viaTeam")} ${open.deliveredVia.teamName} · ` : ""}
              {absoluteTime(open.deliveredAt ?? open.publishedAt, i18n.language)} · {open.id}
            </p>
            <p className="section-hint" style={{ margin: 0 }}>
              {t("inbox.trustHint")}
            </p>
            {open.payload.note && <p className="delivery-note">{open.payload.note}</p>}
            {open.payload.attachments && open.payload.attachments.length > 0 && (
              <div className="attach-list">
                <h3 className="attach-title">
                  {t("inbox.attachments", { n: open.payload.attachments.length })}
                </h3>
                {open.attachmentDir && <PathLabel path={open.attachmentDir} />}
                <ul className="attach-files">
                  {/* Show the path when there is one: it is where the file
                      actually sits under the directory above, and the name
                      alone is ambiguous now that two capabilities can both
                      deliver a spec.md. */}
                  {open.payload.attachments.map((att) => (
                    <li key={att.path || att.name}>
                      <span className="attach-name">{att.path || att.name}</span>
                      <span className="attach-size muted">{formatBytes(att.sizeBytes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {decisionDraft !== null ? (
              <>
                <label className="field">
                  <span>{t("inbox.decisionLabel")}</span>
                  <textarea
                    className="note-input"
                    rows={3}
                    autoFocus
                    value={decisionDraft}
                    onChange={(e) => setDecisionDraft(e.target.value)}
                  />
                </label>
                <div className="form-actions">
                  <button className="btn" onClick={() => setDecisionDraft(null)}>
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
              </>
            ) : (
              <div className="form-actions">
                <button className="btn" onClick={() => setOpen(null)}>
                  {t("common.close")}
                </button>
                {open.deliveredAt != null && (
                  <>
                    <button className="btn" disabled={busy} onClick={() => startDecision(open)}>
                      {t("inbox.toDecision")}
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void toTask(open)}
                    >
                      {t("inbox.toTask")}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
