import { useTranslation } from "react-i18next";

import type { Gate } from "../types";

/**
 * Renders a gate label from its structured kind so it localizes cleanly. The
 * dashboard's gate card and next-step bar, and the new-project wizards' first
 * phase (spec 20 section 6), all say a gate the same way.
 */
export function useGateLabel() {
  const { t } = useTranslation();
  return (gate: Gate): string => {
    switch (gate.kind) {
      case "min_tasks":
        return t("gate.min_tasks", { n: gate.count });
      case "all_tasks_done":
        return t("gate.all_tasks_done");
      case "no_blocked_tasks":
        return t("gate.no_blocked_tasks");
      case "artifact_exists":
        return t("gate.artifact_exists", { path: gate.path });
      case "min_decisions":
        return t("gate.min_decisions", { n: gate.count });
      case "manual_confirm":
        return t("gate.manual_confirm", { prompt: gate.prompt });
      case "doctor_clean":
        return t("gate.doctor_clean");
    }
  };
}
