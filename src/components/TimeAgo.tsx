import { useTranslation } from "react-i18next";

import { absoluteTime, relativeTime } from "../lib/time";

/**
 * A timestamp rendered the way people read it — "3 minutes ago" with the exact date
 * one hover away (product review §5-5).
 *
 * This is the *relative* surface, not the only one: `time.ts` is the single
 * source of formatting, and rows already grouped under a day heading (the
 * ledger) call `clockTime` directly rather than repeat what the heading says.
 */
export default function TimeAgo({ at, className }: { at: string; className?: string }) {
  const { i18n } = useTranslation();
  return (
    <span className={className} title={absoluteTime(at, i18n.language)}>
      {relativeTime(at, i18n.language)}
    </span>
  );
}
