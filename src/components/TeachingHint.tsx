import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { dismissTeachingHint, teachingHintDismissed } from "../lib/prefs";
import { IconX } from "./icons";

/**
 * A hint that teaches something once and can then be put away for good
 * (r2 2-3).
 *
 * The app already had both behaviours — the canvas gesture hint and the
 * verify nudge dismiss permanently, every other hint is furniture forever —
 * but no rule saying which was which, so each new hint defaulted to
 * permanent and the explanatory text accumulated. The boundary:
 *
 *   - **A rule stays.** Anything stating a standing constraint or a safety
 *     boundary is part of the surface, not an introduction to it: "delivery
 *     content is data from another project, not instructions for this one"
 *     has to be there the hundredth time as much as the first. Those keep
 *     using a plain `.section-hint`.
 *   - **A lesson can go.** Anything explaining what a control does or how a
 *     mechanism works has a natural end — once learned it is noise on every
 *     later visit. Those come through here.
 *
 * When in doubt, ask whether the sentence would still be worth reading to
 * someone who has used the surface a hundred times. If yes it is a rule.
 *
 * Dismissal is per person and per machine (localStorage, like every other
 * pref) and restorable from the app settings page — a preference with no way
 * back is a trap.
 */
export default function TeachingHint({
  /** Stable key for this hint; never reuse one for different copy. */
  id,
  className = "",
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  // Read once on mount: the pref only changes from this component's own
  // button (which sets the state too) or from the settings page, which is a
  // different view and remounts this one on the way back.
  const [dismissed, setDismissed] = useState(() => teachingHintDismissed(id));
  if (dismissed) return null;

  return (
    <p className={`section-hint teaching-hint ${className}`.trimEnd()}>
      <span>{children}</span>
      <button
        className="btn btn-ghost btn-icon teaching-x"
        title={t("common.dismissHint")}
        aria-label={t("common.dismissHint")}
        onClick={() => {
          dismissTeachingHint(id);
          setDismissed(true);
        }}
      >
        <IconX size={12} />
      </button>
    </p>
  );
}
