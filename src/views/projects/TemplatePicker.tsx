import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../../api";
import EmptyState from "../../components/EmptyState";
import InfoTip from "../../components/InfoTip";
import { IconCheck } from "../../components/icons";
import { useNamesFit } from "../../hooks/useNamesFit";
import { motionOff } from "../../lib/fx";
import { shortTemplateDescription } from "../../lib/format";
import type { TemplateSummary } from "../../types";

/** Past this many phases the cells carry numbers only; names move to the tooltip. */
const NAMED_PHASES_MAX = 6;

/**
 * A template card's phase cells: the names when every one fits whole,
 * numbers otherwise (F17, D158 ③ — never a cut name such as "Implem"). The
 * names stay in the strip's label and each cell's tooltip either way.
 */
function PhaseStrip({ titles, on }: { titles: string[]; on: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLSpanElement>(null);
  const fits = useNamesFit(ref, titles, ".wz-ph", ".wz-ph");
  const named = titles.length <= NAMED_PHASES_MAX && fits;
  return (
    <span
      ref={ref}
      className={`wz-phs${named ? " wz-phs--named" : ""}`}
      role="img"
      aria-label={t("wizard.phasesAria", { n: titles.length, names: titles.join(", ") })}
    >
      {titles.map((title, k) => (
        <span
          key={k}
          className={`wz-ph${on && k === 0 ? " cur" : ""}`}
          style={{ ["--k" as string]: k }}
          title={title}
        >
          {named ? title : k + 1}
        </span>
      ))}
    </span>
  );
}

export default function TemplatePicker({
  templateId,
  onSelect,
  onResolved,
}: {
  templateId: string;
  onSelect: (id: string) => void;
  /** The selected template once the catalog has loaded — `null` while it has
   *  not, or when the id no longer matches anything. The wizard needs the
   *  template's own domain, and this component is the only one that holds the
   *  catalog; passing the id alone would make the wizard fetch it twice. */
  onResolved?: (tpl: TemplateSummary | null) => void;
}) {
  const { t } = useTranslation();
  // `null` until the first read resolves (D65, invariant 10) — see the empty
  // branch below for why this one matters more than it looks.
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Selecting a card lets its phase cells rise in one by one (spec 20 section 6);
  // the card first selected on open does not.
  const [just, setJust] = useState<string | null>(null);
  const firstPick = useRef(true);

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

  const selected = templates?.find((tpl) => tpl.id === templateId) ?? null;
  useEffect(() => {
    onResolved?.(selected);
  }, [selected, onResolved]);

  const label = (
    <span className="wz-l">
      {t("wizard.template")}
      <InfoTip label={t("wizard.template")}>{t("wizard.templateHint")}</InfoTip>
    </span>
  );

  if (loadFailed) {
    return (
      <div className="wz-f">
        {label}
        <p className="wz-muted">{t("wizard.templatesUnavailable")}</p>
      </div>
    );
  }
  // Render nothing until the read lands. An empty catalog used to remove the
  // whole field, label and all — silently offering no template choice — so
  // this branch now explains itself instead. But that makes the loading gap
  // *visible*: without the `null` check the wizard would open by announcing
  // "no templates to choose from", which is a lie in the common case.
  if (templates === null) return null;
  if (templates.length === 0) {
    return (
      <div className="wz-f">
        {label}
        <EmptyState
          className="wz-empty"
          title={t("wizard.noTemplates")}
          hint={t("wizard.noTemplatesHint")}
        />
      </div>
    );
  }
  return (
    <div className="wz-f">
      {label}
      <div className="wz-tpls" role="radiogroup" aria-label={t("wizard.template")}>
        {templates.map((tpl) => {
          const on = templateId === tpl.id;
          return (
            <button
              type="button"
              key={tpl.id}
              role="radio"
              aria-checked={on}
              className={`wz-tpl${on ? " on" : ""}${just === tpl.id ? " just" : ""}`}
              onClick={() => {
                if (!on && !motionOff() && !firstPick.current) setJust(tpl.id);
                firstPick.current = false;
                onSelect(tpl.id);
              }}
            >
              <span className="wz-tpl-h">
                <b>{tpl.name}</b>
                {tpl.source === "custom" && <span className="chip">{t("wizard.customBadge")}</span>}
                <span className="wz-tick" aria-hidden="true">
                  {on && <IconCheck size={12} />}
                </span>
              </span>
              <PhaseStrip titles={tpl.phases.map((p) => p.title)} on={on} />
              {/* The phase chain is the band above; what is left of the description
                  leaves the id room (F30). The tooltip keeps the whole sentence. */}
              <span className="wz-tpl-m" title={tpl.description || undefined}>
                {shortTemplateDescription(tpl.description)}
                {shortTemplateDescription(tpl.description) !== "" && " · "}
                <code>{tpl.id}</code>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
