import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { shortenIds } from "../lib/ledger";

/**
 * One ledger message, rendered against the engine's lens contract (r2 2-2).
 *
 * The contract is real and enforced on the writing side: the first line is
 * the conclusion and the reasoning follows it — `hub.rs` warns an agent whose
 * first line runs past `SUMMARY_MAX_CHARS`, and every handoff-facing surface
 * is cut to that line. The ledger itself keeps the full text on purpose
 * (see the constant's comment in `ledger.rs`), so this is the one place the
 * tail is allowed to be on screen at all.
 *
 * Keeping it, though, is not the same as flattening it — which is what the
 * three event lists used to do: a dozen lines at one weight and one colour,
 * so a page of entries could only be read word by word. Here the lead reads
 * at full strength, the tail is demoted and clamped, and the full text stays
 * in the DOM either way: the clamp is CSS, so find-in-page and copying still
 * see everything.
 */
export default function EventMessage({
  actor,
  taskId,
  message,
}: {
  /** Contents of the actor chip; omit on lists that don't attribute. */
  actor?: ReactNode;
  taskId?: string | null;
  message: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const tailRef = useRef<HTMLSpanElement>(null);

  const nl = message.indexOf("\n");
  // Shortened for the row, never for the record (r2 3-4): the full line is one
  // hover away and unchanged in the ledger file.
  const lead = shortenIds(nl === -1 ? message : message.slice(0, nl));
  const tail = nl === -1 ? "" : shortenIds(message.slice(nl + 1).trim());

  // Offer the toggle only when the clamp actually cuts something off — a
  // two-line tail needs no disclosure. Deliberately keyed on `tail` alone:
  // once expanded the element is its own full height, so re-measuring would
  // report "not clamped" and take the collapse control away again.
  useEffect(() => {
    const el = tailRef.current;
    setClamped(el !== null && el.scrollHeight > el.clientHeight + 1);
  }, [tail]);

  return (
    <span className="event-msg" title={message === lead ? undefined : message}>
      {actor !== undefined && actor !== null && <span className="actor-chip">{actor}</span>}
      {taskId ? <span className="mono">[{taskId}] </span> : null}
      {lead}
      {tail !== "" && (
        <span ref={tailRef} className={`event-tail${expanded ? " is-open" : ""}`}>
          {tail}
        </span>
      )}
      {clamped && (
        <button className="btn-link event-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t("common.collapse") : t("common.showFull")}
        </button>
      )}
    </span>
  );
}
