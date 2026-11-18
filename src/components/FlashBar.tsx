import { useRef, type ReactNode } from "react";

import { IconCheck } from "./icons";

/**
 * A page's result line (spec 40, the shared pieces; C43): "it is written".
 *
 * An ink check, not the pass colour — teal means the engine checked something
 * and it passed, and "saved to the ledger" is not that (spec 00 §2). Sits as a
 * direct child of `.view`, so it sticks to the top on an opaque surface while
 * the page scrolls under it (invariant 16(c)).
 *
 * It drops in when the message changes and only then: the element is keyed on
 * a counter that moves with the message, so a re-render with the same words
 * (a watcher reload, the auto-dismiss timer of the same flash) never replays
 * it. The motion is CSS; the global reduced-motion rule turns it off.
 *
 * `children` are the line's own buttons (the inbox's "Go to task" and
 * "Close"); a page that dismisses the line on a timer passes none.
 */
export default function FlashBar({
  message,
  children,
  className,
}: {
  message: string | null;
  children?: ReactNode;
  /** Extra class on the line (`flash-bar--static`: does not stick to the top). */
  className?: string;
}) {
  const seq = useRef<{ message: string | null; n: number }>({ message, n: 0 });
  if (seq.current.message !== message) {
    seq.current = { message, n: seq.current.n + 1 };
  }
  if (message === null) return null;
  return (
    <div key={seq.current.n} className={`alert alert-ok flash-bar${className ? ` ${className}` : ""}`} role="status">
      <span className="flash-mk" aria-hidden="true">
        <IconCheck size={13} />
      </span>
      <span className="flash-t">{message}</span>
      {children}
    </div>
  );
}
