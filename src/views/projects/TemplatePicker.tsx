import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../../api";
import EmptyState from "../../components/EmptyState";
import { IconCheck } from "../../components/icons";
import type { TemplateSummary } from "../../types";

export default function TemplatePicker({
  templateId,
  onSelect,
}: {
  templateId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  // `null` until the first read resolves (D65, invariant 10) — see the empty
  // branch below for why this one matters more than it looks.
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    api
      .listTemplates()
      .then((list) => {
        setTemplates(list);
        setLoadFailed(false);
      })
      .catch((e) => {
        console.warn("template list failed:", e);
        setTemplates([]);
        setLoadFailed(true);
      });
  }, []);

  if (loadFailed) {
    return <p className="muted template-hint">{t("wizard.templatesUnavailable")}</p>;
  }
  // Render nothing until the read lands. An empty catalog used to remove the
  // whole field, label and all — silently offering no template choice — so
  // this branch now explains itself instead. But that makes the loading gap
  // *visible*: without the `null` check the wizard would open by announcing
  // "no templates to choose from", which is a lie in the common case.
  if (templates === null) return null;
  if (templates.length === 0) {
    return (
      <div className="field">
        <span>{t("wizard.template")}</span>
        <EmptyState title={t("wizard.noTemplates")} hint={t("wizard.noTemplatesHint")} />
      </div>
    );
  }
  return (
    <div className="field">
      <span>{t("wizard.template")}</span>
      <p className="muted template-hint">{t("wizard.templateHint")}</p>
      <div className="template-grid" role="radiogroup" aria-label={t("wizard.template")}>
        {templates.map((tpl) => (
          <button
            type="button"
            key={tpl.id}
            role="radio"
            aria-checked={templateId === tpl.id}
            className={`template-card ${templateId === tpl.id ? "selected" : ""}`}
            onClick={() => onSelect(tpl.id)}
          >
            <div className="template-name">
              {tpl.name}
              {tpl.source === "custom" && (
                <span className="chip template-badge">{t("wizard.customBadge")}</span>
              )}
              <IconCheck size={14} className="tc-check" />
            </div>
            <div className="template-desc">{tpl.description}</div>
            <div className="template-meta">
              {t("wizard.phaseCount", { n: tpl.phaseCount })} · {tpl.id}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
