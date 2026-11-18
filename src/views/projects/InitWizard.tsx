import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import { api } from "../../api";
import { Check } from "../../components/controls";
import InfoTip from "../../components/InfoTip";
import { useGuardedMutation } from "../../hooks";
import { DOMAIN_SUGGESTIONS, splitLines } from "../../lib/contextForm";
import { shownDomain } from "../../lib/domain";
import { MODULE_CATALOG } from "../../lib/modules";
import { grantAllToolsPreferred, rememberGrantAllTools } from "../../lib/prefs";
import type { InitTargetProbe, SystemStatus, TemplateSummary } from "../../types";
import TemplatePicker from "./TemplatePicker";
import ProjectCard from "./ProjectCard";
import WizardFrame, { FirstPhase } from "./WizardFrame";
import { chargeCard } from "./motion";

/** Windows-reserved device names can never be folder names. */
const RESERVED_FOLDER_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Project name → folder name (D44): strip characters Windows rejects and
 *  trailing dots/spaces (Win32 silently drops those, which would make the
 *  path preview lie). Returns "" when nothing usable survives. */
export function deriveFolderName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .trim()
    .replace(/[. ]+$/, "");
  return RESERVED_FOLDER_NAMES.test(cleaned) ? "" : cleaned;
}

/** A task-count block for a project that has none yet. */
export const NO_TASKS = { total: 0, todo: 0, inProgress: 0, blocked: 0, done: 0, doneUnverified: 0 };

/**
 * Initialize a new project (spec 20 section 6): the form on the left, what the
 * project will become on the right — its card as the overview will show it,
 * and the first phase it will start in.
 */
export default function InitWizard({
  error,
  onCancel,
  onLoaded,
  onError,
}: {
  error: string | null;
  onCancel: () => void;
  /** The project exists; `card` is the preview the page change grows from (C38). */
  onLoaded: (status: SystemStatus, card: HTMLElement | null) => void;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  /** null = folder name follows the project name; set once the user edits it. */
  const [folderOverride, setFolderOverride] = useState<string | null>(null);
  const [probe, setProbe] = useState<InitTargetProbe | null>(null);
  const [domain, setDomain] = useState("");
  const [description, setDescription] = useState("");
  const [goals, setGoals] = useState("");
  const [boundaries, setBoundaries] = useState("");
  const [templateId, setTemplateId] = useState("generic-v1");
  // The chosen template as the catalog describes it: its own domain, which
  // init uses when the field above is left blank (D137), and its phases for
  // the preview. Held here rather than looked up by id because custom
  // templates carry their own — a table would be a lie the moment someone
  // adds one.
  const [template, setTemplate] = useState<TemplateSummary | null>(null);
  // Stable identity: TemplatePicker reports through an effect, and a fresh
  // arrow each render would re-run it on every keystroke in this form.
  const onTemplateResolved = useCallback((tpl: TemplateSummary | null) => setTemplate(tpl), []);
  const templateDomain = template?.domainHint ?? "";
  const [gitAvailable, setGitAvailable] = useState(false);
  const [initGit, setInitGit] = useState(true);
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  const [grantAll, setGrantAll] = useState(grantAllToolsPreferred);
  const { busy, run } = useGuardedMutation(onError);
  const preview = useRef<HTMLUListElement>(null);

  // What the field shows vs. what we actually use: the preview, probe and
  // submit always go through deriveFolderName so they never disagree with
  // what ends up on disk.
  const folderInput = folderOverride ?? deriveFolderName(name);
  const folder = deriveFolderName(folderInput);
  const sep = parent.includes("/") && !parent.includes("\\") ? "/" : "\\";
  const target =
    parent !== "" && folder !== ""
      ? parent.endsWith(sep)
        ? `${parent}${folder}`
        : `${parent}${sep}${folder}`
      : "";

  useEffect(() => {
    api
      .gitAvailable()
      .then(setGitAvailable)
      .catch((e) => {
        console.warn("git availability check failed:", e);
        setGitAvailable(false);
      });
  }, []);

  // Live collision check (D44): warn and disable "create" before submit.
  // Advisory only — core refuses collisions atomically either way.
  useEffect(() => {
    setProbe(null);
    if (parent === "" || folder === "") return;
    let stale = false;
    const handle = window.setTimeout(() => {
      api
        .probeInitTarget(parent, folder)
        .then((p) => {
          if (!stale) setProbe(p);
        })
        .catch(() => {
          // Probe failure just means no early warning.
        });
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(handle);
    };
  }, [parent, folder]);

  async function chooseParent() {
    const dir = await open({ directory: true });
    if (typeof dir === "string") setParent(dir);
  }

  function submit() {
    return run(async () => {
      onError(null);
      const status = await api.initializeProject(
        {
          root: target,
          name,
          domain,
          description,
          goals: splitLines(goals),
          boundaries: splitLines(boundaries),
          templateId,
          // Omitted (undefined) when none checked — the backend default is "none".
          modules: selectedModules.length > 0 ? selectedModules : undefined,
          createRoot: true,
          grantAllTools: grantAll,
        },
        gitAvailable && initGit,
      );
      // Remembered only once a project was really created with it: ticking
      // and cancelling is not a choice anyone made.
      rememberGrantAllTools(grantAll);
      const card = preview.current?.querySelector<HTMLElement>(".pcard") ?? null;
      await chargeCard(card);
      onLoaded(status, card);
    });
  }

  const ready = target !== "" && name.trim() !== "" && probe?.exists !== true && !busy;

  return (
    <WizardFrame
      title={t("welcome.initTitle")}
      error={error}
      foot={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={!ready}>
            {busy ? t("wizard.creating") : t("wizard.create")}
          </button>
        </>
      }
      side={
        <>
          <p className="wz-side-h">{t("wizard.willBecome")}</p>
          <ul className="wz-preview" ref={preview}>
            <ProjectCard
              preview
              namePlaceholder={t("wizard.name")}
              data={{
                root: target === "" ? "\u2026" : target,
                name: name.trim(),
                domain: domain.trim() !== "" ? domain.trim() : templateDomain,
                templateName: template?.name ?? null,
                exists: true,
                taskCounts: NO_TASKS,
                phaseIndex: template ? 0 : null,
                phaseCount: template?.phases.length ?? null,
                phaseTitle: template?.phases[0]?.title ?? null,
                workflowCompleted: false,
                at: new Date().toISOString(),
              }}
            />
          </ul>
          <FirstPhase templateId={template?.id ?? null} />
        </>
      }
    >
      <label className="wz-f">
        <span className="wz-l">{t("wizard.name")}</span>
        <input
          className="inp"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("wizard.namePlaceholder")}
        />
      </label>

      <div className="wz-f">
        <span className="wz-l">{t("wizard.location")}</span>
        <div className="wz-row">
          <input
            className="inp wz-ro"
            value={parent}
            readOnly
            placeholder="C:\projects"
            aria-label={t("wizard.location")}
          />
          <button className="btn btn-small" onClick={() => void chooseParent()}>
            {t("wizard.chooseFolder")}
          </button>
        </div>
      </div>

      <label className="wz-f">
        <span className="wz-l">
          {t("wizard.folder")}
          <InfoTip label={t("wizard.folder")}>{t("wizard.folderHint")}</InfoTip>
        </span>
        <input
          className="inp"
          value={folderInput}
          onChange={(e) => setFolderOverride(e.target.value === "" ? null : e.target.value)}
        />
        {target !== "" && <span className="wz-path">{t("wizard.pathPreview", { path: target })}</span>}
      </label>

      {probe?.exists && (
        <div className="wz-alert" role="alert">
          {probe.isWorkspace ? t("wizard.targetExistsWorkspace") : t("wizard.targetExists")}
        </div>
      )}

      <div className="wz-two">
        <label className="wz-f">
          <span className="wz-l">
            {t("wizard.domain")} <small>{t("common.optional")}</small>
          </span>
          <input
            className="inp"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder={t("wizard.domainPlaceholder")}
            list="domain-suggestions"
          />
          {domain.trim() === "" && shownDomain(templateDomain) !== null && (
            <span className="wz-domain-hint">
              {t("wizard.domainFromTemplate", { domain: templateDomain })}
            </span>
          )}
          <datalist id="domain-suggestions">
            {DOMAIN_SUGGESTIONS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>

        <label className="wz-f">
          <span className="wz-l">
            {t("wizard.description")} <small>{t("common.optional")}</small>
          </span>
          <input
            className="inp"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("wizard.descriptionPlaceholder")}
          />
        </label>
      </div>

      <div className="wz-two">
        <label className="wz-f">
          <span className="wz-l">
            {t("wizard.goals")} <small>{t("common.optional")}</small>
          </span>
          <textarea
            className="ta"
            value={goals}
            onChange={(e) => setGoals(e.target.value)}
            placeholder={t("wizard.goalsPlaceholder")}
            rows={3}
          />
        </label>

        <label className="wz-f">
          <span className="wz-l">
            {t("wizard.boundaries")} <small>{t("common.optional")}</small>
          </span>
          <textarea
            className="ta"
            value={boundaries}
            onChange={(e) => setBoundaries(e.target.value)}
            placeholder={t("wizard.boundariesPlaceholder")}
            rows={3}
          />
        </label>
      </div>

      <TemplatePicker templateId={templateId} onSelect={setTemplateId} onResolved={onTemplateResolved} />

      <div className="wz-opts">
        {gitAvailable && (
          <Check checked={initGit} onChange={setInitGit}>
            <span>
              {t("wizard.initGit")}
              <InfoTip label={t("wizard.initGit")}>{t("wizard.initGitHint")}</InfoTip>
            </span>
          </Check>
        )}
        {MODULE_CATALOG.map(({ id }) => (
          <Check
            key={id}
            checked={selectedModules.includes(id)}
            onChange={(on) =>
              setSelectedModules((prev) => (on ? [...prev, id] : prev.filter((m) => m !== id)))
            }
          >
            <span>
              {t(`wizard.module_${id}`)}
              <InfoTip label={t(`wizard.module_${id}`)}>{t(`wizard.moduleHint_${id}`)}</InfoTip>
            </span>
          </Check>
        ))}
      </div>

      {/* A warning, not a lesson (invariant 17(c)): it says which powers are
          handed over, so it stays on screen rather than behind an info tip. */}
      <div className="fh-grant">
        <Check checked={grantAll} onChange={setGrantAll}>
          <span>{t("wizard.grantAllTools")}</span>
        </Check>
        <p className="fh-grant-h">{t("wizard.grantAllToolsHint")}</p>
      </div>
    </WizardFrame>
  );
}
