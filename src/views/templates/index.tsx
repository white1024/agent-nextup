import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, errorMessage } from "../../api";
import ConfirmDanger from "../../components/ConfirmDanger";
import EmptyState from "../../components/EmptyState";
import { IconPlus, IconX } from "../../components/icons";
import { useFlash } from "../../hooks";
import type { TemplateSummary, WorkflowTemplate } from "../../types";
import TemplateEditor, { type EditorMode } from "./Editor";

interface EditorSession {
  mode: EditorMode;
  template: WorkflowTemplate;
}

/**
 * Machine-level template catalog as an app view (D51 — promoted out of
 * Settings): every template as a card; opening one lands in the full-page
 * editor (read-only for built-ins). Writes still go through core
 * (`save_custom_template`), which owns validation and the built-in-id
 * rejection.
 */
export default function TemplatesHome() {
  const { t } = useTranslation();
  // `null` until the first read resolves (D65) — the built-ins make a truly
  // empty catalog near-impossible, so what this really prevents is the blank
  // card grid that flashed on every entry to the view.
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [session, setSession] = useState<EditorSession | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TemplateSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { flash, showFlash } = useFlash(3000);

  const reload = useCallback(async () => {
    try {
      setTemplates(await api.listTemplates());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function blankTemplate(): WorkflowTemplate {
    return {
      id: "",
      name: "",
      description: "",
      domainHint: "",
      phases: [{ id: "phase-1", title: "", description: "", aiInstructions: [], exitGates: [] }],
    };
  }

  async function openCard(tpl: TemplateSummary) {
    setError(null);
    try {
      const body = await api.getTemplate(tpl.id);
      setSession({ mode: tpl.source === "built_in" ? "view" : "edit", template: body });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function removeTemplate() {
    if (confirmDelete === null) return;
    setError(null);
    try {
      setTemplates(await api.deleteCustomTemplate(confirmDelete.id));
      setConfirmDelete(null);
      showFlash(t("tpl.deleted"));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (session !== null) {
    return (
      <TemplateEditor
        mode={session.mode}
        template={session.template}
        existingIds={(templates ?? []).map((tpl) => tpl.id)}
        onSaved={(list) => {
          setTemplates(list);
          setSession(null);
          showFlash(t("tpl.saved"));
        }}
        onClose={() => setSession(null)}
        onCopy={(base) =>
          setSession({
            mode: "create",
            template: { ...base, id: "", name: `${base.name}${t("tpl.copySuffix")}` },
          })
        }
      />
    );
  }

  return (
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("tpl.heading")}</h1>
          <p className="view-sub">{t("tpl.subtitle")}</p>
        </div>
        <div className="header-actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              setError(null);
              setSession({ mode: "create", template: blankTemplate() });
            }}
          >
            <IconPlus size={14} /> {t("tpl.newBlank")}
          </button>
        </div>
      </header>

      {error && confirmDelete === null && <div className="alert alert-error">{error}</div>}
      {flash && <div className="alert alert-ok">{flash}</div>}

      {/* Describes the list below, not the page (D89). */}
      {templates !== null && templates.length > 0 && (
        <p className="section-hint">{t("tpl.listHint")}</p>
      )}

      {templates !== null && templates.length === 0 && (
        <EmptyState title={t("tpl.empty")} hint={t("tpl.emptyHint")} />
      )}
      <ul className="ws-card-grid">
        {(templates ?? []).map((tpl) => (
          <li key={tpl.id} className="ws-card">
            <button className="ws-card-open" onClick={() => void openCard(tpl)}>
              <span className="ws-card-name">
                {tpl.name}
                <span className="chip template-badge">
                  {tpl.source === "custom" ? t("tpl.custom") : t("tpl.builtIn")}
                </span>
              </span>
              {tpl.description !== "" && <span className="tpl-card-desc">{tpl.description}</span>}
              <span className="ws-card-meta">
                {t("wizard.phaseCount", { n: tpl.phaseCount })} ·{" "}
                <span className="tpl-mono">{tpl.id}</span>
              </span>
            </button>
            {tpl.source === "custom" && (
              <button
                className="btn btn-ghost btn-icon ws-card-remove danger-trigger"
                title={t("tpl.deleteHeading")}
                aria-label={t("tpl.deleteHeading")}
                onClick={() => {
                  setError(null);
                  setConfirmDelete(tpl);
                }}
              >
                <IconX size={13} />
              </button>
            )}
          </li>
        ))}
      </ul>

      {confirmDelete !== null && (
        <ConfirmDanger
          heading={t("tpl.deleteHeading")}
          body={t("tpl.deleteBody", { name: confirmDelete.name })}
          confirmLabel={t("common.delete")}
          error={error}
          onConfirm={() => void removeTemplate()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
