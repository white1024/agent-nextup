import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import { api } from "../../api";
import { Check } from "../../components/controls";
import InfoTip from "../../components/InfoTip";
import { IconClipboardCheck } from "../../components/icons";
import { useGuardedMutation } from "../../hooks";
import { motionOff } from "../../lib/fx";
import { grantAllToolsPreferred, rememberGrantAllTools } from "../../lib/prefs";
import type { AdoptionDraft, NewTask, SystemStatus, TemplateSummary } from "../../types";
import TemplatePicker from "./TemplatePicker";
import ProjectCard from "./ProjectCard";
import WizardFrame, { FirstPhase } from "./WizardFrame";
import { chargeCard } from "./motion";
import { NO_TASKS } from "./InitWizard";

/**
 * Adopt a legacy project (spec 20 section 7): pick a folder, let it be read
 * (nothing is written), then confirm the draft. The right column waits, then
 * shows the read in progress, then becomes the project's card.
 *
 * The read reports nothing until it is done (`draft_legacy_adoption` returns the
 * whole draft at once), so the in-progress box is a sweep of light over the
 * folder's path rather than a list of files being scanned — the design drew a
 * list, and inventing one would show files that were never looked at.
 */
export default function AdoptWizard({
  error,
  onCancel,
  onLoaded,
  onError,
}: {
  error: string | null;
  onCancel: () => void;
  onLoaded: (status: SystemStatus, card: HTMLElement | null) => void;
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
  const [template, setTemplate] = useState<TemplateSummary | null>(null);
  const onTemplateResolved = useCallback((tpl: TemplateSummary | null) => setTemplate(tpl), []);
  const [taskSelected, setTaskSelected] = useState<boolean[]>([]);
  const [grantAll, setGrantAll] = useState(grantAllToolsPreferred);
  const { busy, run: runSubmit } = useGuardedMutation(onError);
  const preview = useRef<HTMLUListElement>(null);
  const taskList = useRef<HTMLUListElement>(null);

  // C39, second half: once the draft lands its suggested tasks drop in one by one.
  const landed = useRef<AdoptionDraft | null>(null);
  useLayoutEffect(() => {
    if (draft === null || landed.current === draft) return;
    landed.current = draft;
    const list = taskList.current;
    if (list === null || motionOff()) return;
    [...list.children].slice(0, 12).forEach((li, k) =>
      (li as HTMLElement).animate(
        [
          { opacity: 0, transform: "translateY(-6px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 360, delay: 70 * k, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" },
      ),
    );
  }, [draft]);

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
          grantAllTools: grantAll,
        },
        tasks,
      );
      // Same preference as the create wizard: one person, one habit.
      rememberGrantAllTools(grantAll);
      const card = preview.current?.querySelector<HTMLElement>(".pcard") ?? null;
      await chargeCard(card);
      onLoaded(status, card);
    });
  }

  const ready = draft !== null && root !== "" && name.trim() !== "" && !busy;
  const taskCount = taskSelected.filter(Boolean).length;

  let side;
  if (draft !== null) {
    side = (
      <>
        <p className="wz-side-h">{t("wizard.willBecome")}</p>
        <ul className="wz-preview" ref={preview}>
          <ProjectCard
            preview
            namePlaceholder={t("wizard.name")}
            data={{
              root,
              name: name.trim(),
              domain: domain.trim() !== "" ? domain.trim() : (template?.domainHint ?? ""),
              templateName: template?.name ?? null,
              exists: true,
              taskCounts: { ...NO_TASKS, total: taskCount, todo: taskCount },
              phaseIndex: template ? 0 : null,
              phaseCount: template?.phases.length ?? null,
              phaseTitle: template?.phases[0]?.title ?? null,
              workflowCompleted: false,
              at: new Date().toISOString(),
            }}
          />
        </ul>
        <FirstPhase templateId={template?.id ?? null} tasks={taskCount} />
      </>
    );
  } else if (analyzing) {
    side = (
      <>
        <p className="wz-side-h">{t("adopt.analyzing")}</p>
        <div className={`wz-scan${motionOff() ? "" : " go"}`}>
          <p className="wz-scan-h">{root}</p>
        </div>
      </>
    );
  } else {
    side = (
      <div className="wz-wait">
        <IconClipboardCheck size={20} />
        <span>{t("adopt.waiting")}</span>
      </div>
    );
  }

  return (
    <WizardFrame
      title={t("adopt.heading")}
      error={error}
      short={draft === null}
      side={side}
      foot={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={!ready}>
            {busy ? t("adopt.creating") : t("adopt.create")}
          </button>
        </>
      }
    >
      <p className="wz-hint">{t("adopt.hint")}</p>

      <div className="wz-f">
        <span className="wz-l">{t("adopt.root")}</span>
        <div className="wz-row">
          <input
            className="inp wz-ro"
            value={root}
            readOnly
            placeholder="C:\work\legacy-app"
            aria-label={t("adopt.root")}
          />
          <button className="btn btn-small" onClick={() => void chooseAndAnalyze()} disabled={analyzing}>
            {analyzing ? t("adopt.analyzing") : t("adopt.chooseFolder")}
          </button>
        </div>
      </div>

      {draft && (
        <>
          {draft.languages.length > 0 && (
            <p className="wz-langs">
              {/* The colon lives in the i18n string: zh-TW wants a fullwidth
                  one, English an ASCII one. */}
              {t("adopt.languages")}{" "}
              {draft.languages.map((l) => (
                <span className="chip" key={l}>
                  {l}
                </span>
              ))}
            </p>
          )}

          <label className="wz-f">
            <span className="wz-l">{t("wizard.name")}</span>
            <input className="inp" value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="wz-two">
            <label className="wz-f">
              <span className="wz-l">{t("wizard.domain")}</span>
              <input className="inp" value={domain} onChange={(e) => setDomain(e.target.value)} />
            </label>
            <label className="wz-f">
              <span className="wz-l">{t("wizard.description")}</span>
              <input className="inp" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>

          {draft.suggestedTasks.length > 0 && (
            <div className="wz-f">
              <span className="wz-l">
                {t("adopt.suggestedTasks", { n: draft.suggestedTasks.length })}
                <InfoTip label={t("adopt.suggestedTasks", { n: draft.suggestedTasks.length })}>
                  {t("adopt.taskHint")}
                </InfoTip>
              </span>
              <ul className="adopt-task-list wz-tasks" ref={taskList}>
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
                        <small className="adopt-task-loc">{task.description}</small>
                      </span>
                    </Check>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <TemplatePicker templateId={templateId} onSelect={setTemplateId} onResolved={onTemplateResolved} />

          <div className="fh-grant">
            <Check checked={grantAll} onChange={setGrantAll}>
              <span>{t("wizard.grantAllTools")}</span>
            </Check>
            <p className="fh-grant-h">{t("wizard.grantAllToolsHint")}</p>
          </div>
        </>
      )}
    </WizardFrame>
  );
}
