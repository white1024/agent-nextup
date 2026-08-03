import { useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";

import { api, errorMessage } from "../api";
import { useFlash, useGuardedMutation } from "../hooks";
import { Check, Switch } from "../components/controls";
import { MODULE_CATALOG } from "../lib/modules";
import type { SystemStatus, WorkspaceModules } from "../types";

interface Props {
  status: SystemStatus;
  onStatusChange: (status: SystemStatus) => void;
  /** Current workspace modules (loaded by App via modules_get; null while unknown). */
  modules: WorkspaceModules | null;
  /** Propagate a toggle up so the sidebar nav reflects it immediately. */
  onModulesChange: (modules: WorkspaceModules) => void;
  /** Jump to the machine-wide settings page (product review §5-10). */
  onGoToAppSettings: () => void;
}

/**
 * Workspace-scoped settings (D55): modules, the AI takeover layer, backup and
 * closing the workspace. Split out of the app-level Settings page so project
 * settings live in the workspace nav rather than buried below the machine-wide
 * ones (D49's single page put them at the bottom of a long scroll). Only
 * mounted with a workspace open, so it always has one.
 *
 * The API-keys panel that used to sit between modules and bootstrap was removed
 * (D88): its only consumer is the dormant orchestrator, so the panel invited
 * users to store a credential nothing would ever read. The IPC commands and the
 * encrypted store stay — see `api.ts` — and the panel comes back with B14.
 */
export default function ProjectSettings({
  status,
  onStatusChange,
  modules,
  onModulesChange,
  onGoToAppSettings,
}: Props) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [includeArtifacts, setIncludeArtifacts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy: exporting, run } = useGuardedMutation(setError);
  const { flash, showFlash } = useFlash(3000);

  // The save dialog is awaited outside the guard on purpose: it is modal, and
  // cancelling it must leave the form untouched rather than flash a busy state.
  async function exportBackup() {
    setError(null);
    const suggested = `${status.workspace?.name ?? "agent-nextup"}-backup.zip`;
    let dest: string | null;
    try {
      dest = await save({
        defaultPath: suggested,
        filters: [{ name: "Agent NextUp backup", extensions: ["zip"] }],
      });
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    if (typeof dest !== "string") return;
    const target = dest;
    await run(async () => {
      const written = await api.exportBackup(target, passphrase, includeArtifacts);
      showFlash(`${t("settings.exportedTo")} ${written}`);
      setPassphrase("");
    });
  }

  async function closeWorkspace() {
    setError(null);
    try {
      onStatusChange(await api.closeWorkspace());
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /**
   * How many deliveries are still sitting in the outbox unsent. Read before a
   * team-module switch-off, never after: the engine's `require_module` guard
   * refuses `exchange_list` once the module is off, so asking afterwards would
   * always answer zero (D103).
   */
  async function countUnsentDeliveries(): Promise<number> {
    const root = status.workspace?.root;
    if (!root) return 0;
    try {
      const outbox = await api.exchangeList(root, "outbox");
      return outbox.filter((d) => !d.deliveredAt).length;
    } catch {
      // Not worth an error banner — the toggle itself still works, and the
      // fallback message says the same thing without a number.
      return 0;
    }
  }

  /**
   * Module switches stay reversible and unconfirmed (D61, D102 ③-tier): turning
   * the team module off hides the inbox and the hub tools but deletes nothing —
   * envelopes, guides and your own edits all come back on re-enable. What it
   * does *not* do is say so, which is why switching off announces what went
   * quiet rather than gating it behind a confirmation (D103).
   */
  async function setModuleEnabled(id: string, enabled: boolean) {
    setError(null);
    const unsent = id === "team" && !enabled ? await countUnsentDeliveries() : null;
    try {
      onModulesChange(await api.moduleSetEnabled(id, enabled));
      if (unsent !== null) {
        showFlash(
          unsent > 0 ? t("settings.teamOffUnsent", { n: unsent }) : t("settings.teamOff"),
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function scaffoldBootstrap() {
    setError(null);
    try {
      const created = await api.scaffoldBootstrap();
      showFlash(
        created.length === 0
          ? t("settings.bootstrapNone")
          : `${t("settings.bootstrapCreated")} ${created.join(", ")}`,
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("settings.projectHeading")}</h1>
          <p className="view-sub">
            {t("settings.projectSubtitle")}
            {status.workspace && <span className="sz-name">{status.workspace.name}</span>}
          </p>
        </div>
      </header>

      <p className="scope-hint">
        {t("settings.lookingForApp")}{" "}
        <button className="btn-link" onClick={onGoToAppSettings}>
          {t("settings.heading")}
        </button>
      </p>

      {error && <div className="alert alert-error">{error}</div>}
      {flash && <div className="alert alert-ok">{flash}</div>}

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{t("settings.modules")}</h2>
        </div>
        <p className="section-hint" style={{ marginBottom: "var(--s-3)" }}>
          {t("settings.modulesHint")}
        </p>
        {MODULE_CATALOG.map(({ id }) => {
          const on = modules?.enabled.includes(id) ?? false;
          return (
            <div className="settings-row" key={id}>
              <div className="sr-body">
                <div className="sr-title">{t(`settings.module_${id}`)}</div>
                <div className="sr-desc">
                  {on ? t(`settings.moduleOn_${id}`) : t(`settings.moduleOff_${id}`)}
                </div>
              </div>
              <Switch
                checked={on}
                onChange={(v) => void setModuleEnabled(id, v)}
                disabled={modules === null}
                ariaLabel={t(`settings.module_${id}`)}
              />
            </div>
          );
        })}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{t("settings.bootstrap")}</h2>
        </div>
        <div className="settings-row">
          <div className="sr-body">
            <div className="sr-desc">{t("settings.bootstrapHint")}</div>
          </div>
          <button className="btn" onClick={() => void scaffoldBootstrap()}>
            {t("settings.bootstrapButton")}
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{t("settings.backup")}</h2>
        </div>
        <p className="section-hint" style={{ marginBottom: "var(--s-3)" }}>
          {t("settings.backupHint")}
        </p>
        <div className="backup-form">
          <label className="field grow">
            <span>{t("settings.passphrase")}</span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          <Check checked={includeArtifacts} onChange={setIncludeArtifacts}>
            {t("settings.includeArtifacts")}
          </Check>
          <button
            className="btn btn-primary"
            onClick={() => void exportBackup()}
            disabled={exporting || passphrase.length < 8}
          >
            {exporting ? t("settings.exporting") : t("settings.exportButton")}
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="settings-row">
          <div className="sr-body">
            <div className="sr-title">{t("settings.workspace")}</div>
          </div>
          <button className="btn" onClick={() => void closeWorkspace()}>
            {t("settings.closeWorkspace")}
          </button>
        </div>
      </section>
    </div>
  );
}
