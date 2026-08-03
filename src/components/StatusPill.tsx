import { useTranslation } from "react-i18next";

import { usePulse } from "../hooks/anim";
import type { TaskStatus } from "../types";

/**
 * Status is never conveyed by color alone: pill = dot + translated label.
 * Pops (statusPop) when the status actually transitions.
 */
export default function StatusPill({ status }: { status: TaskStatus }) {
  const { t } = useTranslation();
  const changed = usePulse(status);
  return (
    <span className={`pill pill-${status} ${changed ? "status-changed" : ""}`}>
      <span className="dot" aria-hidden="true" />
      {t(`status.${status}`)}
    </span>
  );
}
