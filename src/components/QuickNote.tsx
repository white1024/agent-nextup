import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api";
import { useGuardedMutation } from "../hooks";
import type { LedgerChannel } from "../types";
import Modal from "./Modal";

interface Props {
  /** Surface an IPC failure in the parent's error slot (null clears it). */
  onError: (message: string | null) => void;
  /** Called after a successful write — parent reloads and flashes. */
  onSaved: () => void;
}

/**
 * The fields alone, with no container of their own. Split out in D66 so the
 * command palette can offer Record decision without leaving the current page: the panel
 * below and the dialog at the bottom of this file are the same form in two
 * different shells, not two implementations that have to be kept in step.
 */
function QuickNoteFields({
  onError,
  onSaved,
  autoFocus = false,
  emphasis = false,
}: Props & { autoFocus?: boolean; emphasis?: boolean }) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  // One instance across the three channel buttons, matching the single `busy`
  // they already shared. The ref gate matters here: `addLedgerNote` appends,
  // so a same-tick double click used to write the note twice with no way to
  // take either back.
  const { busy, run } = useGuardedMutation(onError);

  function save(channel: LedgerChannel) {
    return run(async () => {
      onError(null);
      await api.addLedgerNote(channel, note);
      setNote("");
      onSaved();
    });
  }

  return (
    <>
      <textarea
        autoFocus={autoFocus}
        className="note-input"
        rows={4}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label={t("note.placeholder")}
        placeholder={t("note.placeholder")}
      />
      <div className="notes-actions">
        <button
          className="btn"
          onClick={() => void save("note")}
          disabled={busy || note.trim() === ""}
        >
          {t("note.addNote")}
        </button>
        {/* D78: progress joins the verb row — a session summary is neither a
            decision nor a plain note, and surfaces in its own Last progress block. */}
        <button
          className="btn"
          onClick={() => void save("progress")}
          disabled={busy || note.trim() === ""}
        >
          {t("note.addProgress")}
        </button>
        {/* Primary only in the dialog shell (r2 3-3). Summoned from the
            palette's "Record decision", it is that dialog's action and should
            look like it. Sitting in a panel on the Dashboard it is one verb
            of three — you pick the one that matches what you wrote, and
            dressing one of them up said "choose this" while adding a fourth
            purple button to the page. */}
        <button
          className={`btn${emphasis ? " btn-primary" : ""}`}
          onClick={() => void save("decision")}
          disabled={busy || note.trim() === ""}
        >
          {t("note.addDecision")}
        </button>
      </div>
    </>
  );
}

/**
 * Ledger write panel: one text, two verbs (decision vs note). Shared by the
 * Dashboard and the Ledger browser (D47) so the place you read is a place you
 * can write.
 */
export default function QuickNote({ onError, onSaved }: Props) {
  const { t } = useTranslation();
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">{t("note.heading")}</h2>
      </div>
      <QuickNoteFields onError={onError} onSaved={onSaved} />
    </section>
  );
}

/**
 * The same form as a dialog (D66) — what the command palette Record decision button opens.
 * Closes itself on a successful write: the panel version stays put because you
 * are already on the page it belongs to, but this one was summoned from
 * wherever you happened to be, and leaving it up after the write would strand
 * you in a dialog you did not navigate to.
 */
export function QuickNoteModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal label={t("note.heading")} onClose={onClose}>
      <div className="form">
        <h2 className="form-heading">{t("note.heading")}</h2>
        {error !== null && <div className="alert alert-error">{error}</div>}
        <QuickNoteFields
          autoFocus
          emphasis
          onError={setError}
          onSaved={() => {
            onSaved();
            onClose();
          }}
        />
      </div>
    </Modal>
  );
}
