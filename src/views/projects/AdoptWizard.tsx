import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import { api } from "../../api";
import { Check } from "../../components/controls";
import { useGuardedMutation } from "../../hooks";
import type { AdoptionDraft, NewTask, SystemStatus } from "../../types";
import TemplatePicker from "./TemplatePicker";

export default function AdoptWizard({
  onCancel,
  onLoaded,
  onError,
}: {
  onCancel: () => void;
  onLoaded: (status: SystemStatus) => void;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const [root, setRoot] = useState("");
  const { busy: analyzing, run: runAnalyze } = useGuardedMutation(onError);
  const [draft, setDraft] = useState<AdoptionDraft | null>(null);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [description, setDescription] = useState("");
  const [templateId, setTemplateId] = useState("coding-v1");
  const [taskSelected, setTaskSelected] = useState<boolean[]>([]);
  const { busy, run: runSubmit } = useGuardedMutation(onError);

  // The picker is awaited *outside* the guard on purpose: the native dialog is
  // modal, and cancelling it must leave the wizard exactly as it was rather
  // than flash a busy state.
  async function chooseAndAnalyze() {
    onError(null);
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    setRoot(dir);
    setDraft(null);
    await runAnalyze(async () => {
      const d = await api.draftLegacyAdoption(dir);
      setDraft(d);
      setName(d.name);
      setDomain(d.domain);
      setDescription(d.description);
      setTaskSelected(d.suggestedTasks.map(() => true));
      setTemplateId(d.domain === "coding" ? "coding-v1" : "generic-v1");
    });
  }

  function submit() {
    if (draft === null) return;
    return runSubmit(async () => {
      onError(null);
      const tasks: NewTask[] = draft.suggestedTasks.filter((_, i) => taskSelected[i]);
      const status = await api.adoptLegacyProject(
        {
          root,
          name,
          domain,
          description,
          goals: [],
          boundaries: [],
          templateId,
        },
        tasks,
      );
      onLoaded(status);
    });
  }

  const ready = draft !== null && root !== "" && name.trim() !== "" && !busy;

  return (
    <div className="form">
      <h2 className="form-heading">{t("adopt.heading")}</h2>
      <p className="section-hint">{t("adopt.hint")}</p>

      <label className="field">
        <span>{t("adopt.root")}</span>
        <div className="field-row">
          <input value={root} readOnly placeholder="C:\work\legacy-app" />
          <button className="btn" onClick={() => void chooseAndAnalyze()} disabled={analyzing}>
            {analyzing ? t("adopt.analyzing") : t("adopt.chooseFolder")}
          </button>
        </div>
      </label>

      {draft && (
        <>
          {draft.languages.length > 0 && (
            <p className="section-hint">
              {/* The colon lives in the i18n string: zh-TW wants a fullwidth
                  one, English an ASCII one. It used to be hard-coded here as
                  a fullwidth character, so the English UI rendered a CJK
                  colon after "Detected languages". */}
              {t("adopt.languages")}{" "}
              {draft.languages.map((l) => (
                <span className="chip" key={l} style={{ marginRight: 4 }}>
                  {l}
                </span>
              ))}
            </p>
          )}

          <label className="field">
            <span>{t("wizard.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label className="field">
            <span>{t("wizard.domain")}</span>
            <input value={domain} onChange={(e) => setDomain(e.target.value)} />
          </label>

          <label className="field">
            <span>{t("wizard.description")}</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </label>

          {draft.suggestedTasks.length > 0 && (
            <div className="field">
              <span>
                {t("adopt.suggestedTasks", { n: draft.suggestedTasks.length })}
              </span>
              <p className="muted template-hint">{t("adopt.taskHint")}</p>
              <ul className="adopt-task-list">
                {draft.suggestedTasks.map((task, i) => (
                  <li key={`${task.description}-${i}`}>
                    <Check
                      checked={taskSelected[i] ?? false}
                      onChange={(checked) =>
                        setTaskSelected((prev) => {
                          const next = [...prev];
                          next[i] = checked;
                          return next;
                        })
                      }
                    >
                      <span>
                        {task.title}
                        <span className="muted adopt-task-loc"> {task.description}</span>
                      </span>
                    </Check>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <TemplatePicker templateId={templateId} onSelect={setTemplateId} />
        </>
      )}

      <div className="form-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={!ready}>
          {busy ? t("adopt.creating") : t("adopt.create")}
        </button>
      </div>
    </div>
  );
}
