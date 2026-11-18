import type { ReactNode } from "react";

import { IconWarn } from "./icons";
import { motionOff } from "../lib/fx";

/**
 * C29's second half: pressing Retry on a failed card first lifts the error
 * line away (200 ms), then runs `next` — so the "resuming…" state does not
 * replace the card while the old error is still on it.
 */
export function retractErrorThen(from: Element, next: () => void) {
  const err = from.closest(".term-card")?.querySelector<HTMLElement>(".term-card-err");
  if (!err || motionOff()) {
    next();
    return;
  }
  err.animate(
    [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: "translateY(-8px)" },
    ],
    { duration: 200, easing: "ease-in", fill: "forwards" },
  );
  window.setTimeout(next, 220);
}

/**
 * A card drawn on the terminal's own dark surface (spec 40: `.rs`), for every
 * slot where a terminal would be but cannot: a restored session, one in its
 * own window, one that is not running, nothing picked. The terminal and the
 * agent overview's stage both use it.
 *
 * The surface is dark in both app themes, so everything on it is a fixed
 * colour (`.term-card` in styles.css) — a theme token would be read against
 * the wrong background in the light theme.
 *
 * `error` is its own line under the copy (C29): it drops in when it appears,
 * and the caller clears it before retrying so it can lift away first.
 */
export default function TermCard({
  title,
  hint,
  error,
  children,
}: {
  title: string;
  hint?: string;
  error?: string | null;
  /** The card's buttons. */
  children?: ReactNode;
}) {
  return (
    <div className="term-card">
      <b className="term-card-title">{title}</b>
      {hint !== undefined && <p>{hint}</p>}
      {error && (
        <div className="term-card-err" role="alert">
          <IconWarn size={14} />
          <span>{error}</span>
        </div>
      )}
      {children && <div className="term-card-actions">{children}</div>}
    </div>
  );
}
