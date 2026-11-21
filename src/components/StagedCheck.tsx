import { useTranslation } from "react-i18next";

import { Check } from "./controls";
import { runsStaged } from "../lib/workflowMode";
import type { TemplateSummary } from "../types";

/**
 * The opt-in for phases (D171 ②): the two wizards and the dashboard's
 * adopt-a-template panel. A template that cannot run ongoing ticks it for you
 * and says why, rather than letting the call fail.
 */
export default function StagedCheck({
  staged,
  onChange,
  template,
}: {
  staged: boolean;
  onChange: (v: boolean) => void;
  template: TemplateSummary | null;
}) {
  const { t } = useTranslation();
  const forced = runsStaged(false, template);
  return (
    <div className="fh-grant">
      <Check checked={staged || forced} disabled={forced} onChange={onChange}>
        <span>{t("wizard.staged")}</span>
      </Check>
      <p className="fh-grant-h">{forced ? t("wizard.stagedOnly") : t("wizard.stagedHint")}</p>
    </div>
  );
}
