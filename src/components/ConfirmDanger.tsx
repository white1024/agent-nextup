import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import Modal from "./Modal";

/**
 * The confirm dialog for irreversible actions — the D61 danger tier made
 * reusable (product review §5-4). It fixes the layout and the red button; the two-halves
 * rule below is a contract on the caller's copy, not something the type system
 * can enforce, so it is worth checking in review.
 *
 * The audit that produced this found the app had drifted into three unrelated
 * habits: some irreversible deletes had a modal + red button + a sentence about
 * consequences, others were a single ghost-button click, and `btn-danger` was
 * showing up on actions that needed no confirmation at all. Colour had stopped
 * being a signal.
 *
 * The rule this component carries:
 *
 * - **Tier 1 — irreversible data loss / overwrite** (delete a key, a milestone,
 *   a task; overwrite a customized file; kill a running agent): this dialog,
 *   with copy stating what is lost *and* what is left untouched — "will this
 *   delete my files?" is the question a user actually has.
 * - **Tier 2 — affects other people or external state** (routing a delivery,
 *   changing authorization): a confirm step, but a normal primary button — the
 *   action is legitimate, it just deserves a look before it lands.
 * - **Tier 3 — reversible** (archiving, clearing a verification, module
 *   toggles, assigning, importing a backup): no confirmation, no red. A prompt
 *   for something undoable is noise, and noise is what teaches people to click
 *   through tier 1.
 *
 * Those five were audited rather than assumed, since two of them look
 * destructive from the outside: clearing a verification does wipe
 * `verifiedNote` off the task, but the evidence text is already in the ledger
 * under the earlier verification event, so it is recoverable; and importing a
 * backup cannot land on an existing workspace at all — core refuses a
 * destination that already has `.nextup/`. Assigning, module toggles and the
 * archive flag are plain round trips.
 *
 * The one asymmetry worth knowing: archiving a done task is also what folds its
 * delta specs into `specs/` (D79), and un-archiving does not unfold them. The
 * flag is reversible, the fold is not. It stays tier 3 because the fold is the
 * point of archiving rather than a side effect, and the outcome is flashed
 * where it happens — but if that ever earns friction, this is the note that
 * says why it did not already have any.
 *
 * Red means "this has a consequence you cannot take back", and always comes
 * with friction: this dialog, or at least a mandatory reason field (workflow
 * force-advance takes the latter route — more friction, not less).
 */
export default function ConfirmDanger({
  heading,
  body,
  confirmLabel,
  cancelLabel,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  heading: string;
  /**
   * What is lost, and what is *not* touched. Both halves, always.
   *
   * A `ReactNode` rather than a string, so the callers that need to name a
   * specific thing can render it as itself — a `PathLabel` for the folder being
   * forgotten, a second line whose wording depends on what the target is
   * attached to. Those are the cases that kept dialogs hand-rolled, and a
   * hand-rolled dialog is one nobody has to obey the two-halves rule in. Plain
   * strings stay the common case; anything richer is still copy, and still
   * gets read in review.
   */
  body: ReactNode;
  confirmLabel: string;
  /**
   * Overrides "Cancel" for the case where backing out is itself a choice with
   * a name — "Keep editing" against "Discard", where the pair reads as two
   * directions rather than one action and an escape hatch.
   */
  cancelLabel?: string;
  busy?: boolean;
  /** Failure from the attempt, shown inside the dialog so it stays fixable. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal label={heading} onClose={onCancel}>
      <div className="form">
        <h2 className="form-heading">{heading}</h2>
        {typeof body === "string" ? <p className="muted">{body}</p> : body}
        {error != null && error !== "" && <div className="alert alert-error">{error}</div>}
        <div className="form-actions">
          <button className="btn" onClick={onCancel}>
            {cancelLabel ?? t("common.cancel")}
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
