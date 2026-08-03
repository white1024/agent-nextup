import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import { api } from "../../api";
import { Check } from "../../components/controls";
import { useGuardedMutation } from "../../hooks";
import { MODULE_CATALOG } from "../../lib/modules";
import type { InitTargetProbe, SystemStatus } from "../../types";
import TemplatePicker from "./TemplatePicker";

/** Textarea → one trimmed entry per non-empty line. */
export function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

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

export default function InitWizard({
  onCancel,
  onLoaded,
  onError,
}: {
  onCancel: () => void;
  onLoaded: (status: SystemStatus) => void;
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
  const [gitAvailable, setGitAvailable] = useState(false);
  const [initGit, setInitGit] = useState(true);
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  const { busy, run } = useGuardedMutation(onError);

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
        },
        gitAvailable && initGit,
      );
      onLoaded(status);
    });
  }

  const ready = target !== "" && name.trim() !== "" && probe?.exists !== true && !busy;

  return (
    <div className="form">
      <h2 className="form-heading">{t("wizard.heading")}</h2>

      <label className="field">
        <span>{t("wizard.name")}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("wizard.namePlaceholder")}
        />
      </label>

      <label className="field">
        <span>{t("wizard.location")}</span>
        <div className="field-row">
          <input value={parent} readOnly placeholder="C:\projects" />
          <button className="btn" onClick={() => void chooseParent()}>
            {t("wizard.chooseFolder")}
          </button>
        </div>
      </label>

      <label className="field">
        <span>{t("wizard.folder")}</span>
        <input
          value={folderInput}
          onChange={(e) =>
            setFolderOverride(e.target.value === "" ? null : e.target.value)
          }
        />
        <span className="muted template-hint">{t("wizard.folderHint")}</span>
        {target !== "" && (
          <span className="muted template-hint">
            {t("wizard.pathPreview", { path: target })}
          </span>
        )}
      </label>

      {probe?.exists && (
        <div className="alert alert-error">
          {probe.isWorkspace ? t("wizard.targetExistsWorkspace") : t("wizard.targetExists")}
        </div>
      )}

      <label className="field">
        <span>
          {t("wizard.domain")} {t("common.optional")}
        </span>
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder={t("wizard.domainPlaceholder")}
          list="domain-suggestions"
        />
        <datalist id="domain-suggestions">
          <option value="coding" />
          <option value="research" />
          <option value="business" />
          <option value="life" />
          <option value="general" />
        </datalist>
      </label>

      <label className="field">
        <span>
          {t("wizard.description")} {t("common.optional")}
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("wizard.descriptionPlaceholder")}
          rows={2}
        />
      </label>

      <label className="field">
        <span>
          {t("wizard.goals")} {t("common.optional")}
        </span>
        <textarea
          value={goals}
          onChange={(e) => setGoals(e.target.value)}
          placeholder={t("wizard.goalsPlaceholder")}
          rows={3}
        />
      </label>

      <label className="field">
        <span>
          {t("wizard.boundaries")} {t("common.optional")}
        </span>
        <textarea
          value={boundaries}
          onChange={(e) => setBoundaries(e.target.value)}
          placeholder={t("wizard.boundariesPlaceholder")}
          rows={3}
        />
      </label>

      <TemplatePicker templateId={templateId} onSelect={setTemplateId} />

      {gitAvailable && (
        <Check checked={initGit} onChange={setInitGit}>
          <span>
            {t("wizard.initGit")}
            <span className="muted template-hint"> {t("wizard.initGitHint")}</span>
          </span>
        </Check>
      )}

      {MODULE_CATALOG.map(({ id }) => (
        <Check
          key={id}
          checked={selectedModules.includes(id)}
          onChange={(on) =>
            setSelectedModules((prev) =>
              on ? [...prev, id] : prev.filter((m) => m !== id),
            )
          }
        >
          <span>
            {t(`wizard.module_${id}`)}
            <span className="muted template-hint"> {t(`wizard.moduleHint_${id}`)}</span>
          </span>
        </Check>
      ))}

      <div className="form-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={!ready}>
          {busy ? t("wizard.creating") : t("wizard.create")}
        </button>
      </div>
    </div>
  );
}
