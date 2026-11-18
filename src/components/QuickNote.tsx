import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api";
import { useGuardedMutation } from "../hooks";
import type { LedgerChannel } from "../types";
import Modal from "./Modal";
import { centreOf, fx, motionOff } from "../lib/fx";

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
      {/* Decision, note, progress (D153, spec 30 and 40): the same order on the
          dashboard and the ledger, the weightiest first. */}
      <div className="notes-actions">
        {/* Primary only in the dialog shell (r2 3-3). Summoned from the
            palette's "Record decision", it is that dialog's action and should
            look like it. Sitting in a panel on the Dashboard it is one verb
            of three — you pick the one that matches what you wrote, and
            dressing one of them up said "choose this" while adding a fourth
            primary button to the page. */}
        <button
          className={`btn${emphasis ? " btn-primary" : " btn-small"}`}
          onClick={() => void save("decision")}
          disabled={busy || note.trim() === ""}
        >
          {t("note.addDecision")}
        </button>
        <button
          className={`btn${emphasis ? "" : " btn-small"}`}
          onClick={() => void save("note")}
          disabled={busy || note.trim() === ""}
        >
          {t("note.addNote")}
        </button>
        {/* D78: progress joins the verb row — a session summary is neither a
            decision nor a plain note, and surfaces in its own Last progress block. */}
        <button
          className={`btn${emphasis ? "" : " btn-small"}`}
          onClick={() => void save("progress")}
          disabled={busy || note.trim() === ""}
        >
          {t("note.addProgress")}
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
export default function QuickNote({ onError, onSaved, className }: Props & { className?: string }) {
  const { t } = useTranslation();
  return (
    <section className={`panel${className ? ` ${className}` : ""}`}>
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
  const formRef = useRef<HTMLDivElement>(null);

  /**
   * C218 (D153): the entry goes where it landed. The words fade, the dialog
   * folds into a line and then a point, and a beam carries it to the recent
   * activity on the dashboard (where the new row slides in on its own), or to
   * the ledger's cell in the sidebar, which lights up. The landing itself is
   * the confirmation — no toast (invariant 16(c)).
   */
  async function land() {
    const form = formRef.current;
    const panel = form?.closest<HTMLElement>(".modal-panel") ?? null;
    const backdrop = panel?.closest<HTMLElement>(".modal-backdrop") ?? null;
    const recent = document.querySelector('[data-landing="recent"] .panel-head');
    const cell = document.querySelector<HTMLElement>('.sidebar [data-view="ledger"]');
    const target = recent ?? cell;
    const lightCell = (ms: number) => {
      if (recent !== null || cell === null) return;
      cell.classList.remove("shell-flash");
      void cell.offsetWidth;
      cell.classList.add("shell-flash");
      window.setTimeout(() => cell.classList.remove("shell-flash"), ms);
    };
    if (motionOff() || form === null || panel === null || backdrop === null) {
      onSaved();
      onClose();
      lightCell(260);
      return;
    }
    // The dialog plays its own way out; the Modal's sink must not follow it.
    backdrop.dataset.exit = "none";
    const from = centreOf(panel);
    form.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-out", fill: "forwards" });
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, delay: 260, fill: "forwards" });
    const fold = panel.animate(
      [
        { transform: "none", opacity: 1 },
        { transform: "scale(1, .02)", opacity: 1, offset: 0.55 },
        { transform: "scale(.04, .02)", opacity: 0 },
      ],
      { duration: 380, delay: 140, easing: "cubic-bezier(.5,0,.6,1)", fill: "forwards" },
    );
    window.setTimeout(() => fx.beam(from, centreOf(target), { width: 2.6, dur: 520 }), 470);
    await fold.finished.catch(() => undefined);
    onSaved();
    onClose();
    window.setTimeout(() => lightCell(620), 470);
  }

  return (
    <Modal label={t("note.heading")} onClose={onClose} narrow>
      <div className="form" ref={formRef}>
        <h2 className="form-heading">{t("note.heading")}</h2>
        {error !== null && <div className="alert alert-error">{error}</div>}
        <QuickNoteFields
          autoFocus
          emphasis
          onError={setError}
          onSaved={() => void land()}
        />
      </div>
    </Modal>
  );
}
